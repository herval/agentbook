#!/usr/bin/env node
// A stand-in for the `dsh` command in tests: `dsh --profile acp`, DeepSeek Harness's ACP server over stdio, keeping
// each session in a log the way dsh does ($DSH_HOME/sessions/--<folder>--/<id>/session.v4.jsonl.zstd: one Zstandard
// frame per batch). Each call is logged to FAKE_DSH_DIR/calls.jsonl.
//   initialize, session/new, session/resume, session/set_config_option, session/prompt, session/cancel.
// A prompt runs `ls` and replies "Done: <prompt>"; one that deletes something calls bash and asks permission first; a
// "slow" one waits to be cancelled; "Headline: <title>" calls agentbook's ab_post through the MCP server the session
// was given (logged as a "tool" call), and "Rename: <title>" does with rename: true; "fail" fails, the way dsh does without a key. Like dsh, it refuses a second
// prompt while one runs (logged as "busy").
// With `--patch <overlay>` that inserts agentbook's plugin (by path, with its config), it runs the real plugin on a
// stand-in for dsh's services: the permission preset and plan mode it sets are logged ("preset", "plan"), and in plan
// mode "Plan: <plan>" asks for its review as dsh's exit_plan_mode does, through the plugin (logged as "question").

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

// A session: its folder and log, its model ([provider, model]) and effort, the MCP servers it was given, its turn,
// whether a prompt runs (and how to cancel it), and whether it has a title yet.
interface DshSession {
  cwd: string;
  file: string;
  model: string[];
  effort: string;
  servers: { name: string; type: string; url?: string }[];
  turn: number;
  busy?: boolean;
  cancel?: () => void;
  titled?: boolean;
  plan?: boolean;
}
// A message from the client: a request, or its answer to one of ours.
interface AcpMessage {
  id?: number;
  method?: string;
  params?: { sessionId?: string; cwd?: string; mcpServers?: DshSession["servers"]; configId?: string; value?: string; prompt?: { type: string; text: string }[] };
  result?: unknown;
}
// The client's answer to a permission request.
interface PermissionAnswer {
  outcome?: { outcome?: string; optionId?: string };
}

const args = process.argv.slice(2);
const log = (entry: object) => fs.appendFileSync(path.join(process.env.FAKE_DSH_DIR, "calls.jsonl"), JSON.stringify(entry) + "\n");
if (args[0] !== "--profile" || args[1] !== "acp" || (args.length > 2 && (args[2] !== "--patch" || !args[3] || args.length > 4))) {
  console.error(`fake dsh: ${args.join(" ")}`);
  process.exit(1);
}
log({ cmd: "argv", args });

const HOME = process.env.DSH_HOME;
const folderOf = (cwd: string) => path.join(HOME, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\]/g, "-")}--`);
const logOf = (sid: string, cwd: string) => path.join(folderOf(cwd), sid, "session.v4.jsonl.zstd");
let seq = 0;
const append = (file: string, events: object[]) => fs.appendFileSync(file, zlib.zstdCompressSync(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
const event = (type: string, data: object) => ({ type, seq: ++seq, time: Date.now(), data });

// [provider, model, name]
const MODELS: [string, string, string][] = [
  ["deepseek-official", "deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek-official", "deepseek-v4-pro", "DeepSeek V4 Pro"],
];
const EFFORTS = ["off", "low", "high", "max"];
const options = (s: DshSession) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: JSON.stringify(s.model), options: [{ group: "deepseek-official", name: "DeepSeek", options: MODELS.map(([p, m, name]) => ({ value: JSON.stringify([p, m]), name })) }] },
  { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: s.effort, options: EFFORTS.map((e) => ({ value: e, name: e })) },
];

const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sid: string, u: object) => send({ method: "session/update", params: { sessionId: sid, update: u } });
const waiting = new Map<number, (result: unknown) => void>(); // our requests to the client
let nextId = 1000;
const ask = (method: string, params: object) => new Promise<PermissionAnswer>((resolve) => (waiting.set(nextId, resolve), send({ id: nextId++, method, params })));
const sessions = new Map<string, DshSession>(); // id -> { cwd, file, model, effort, servers, turn, busy, cancel, titled }

// dsh's Cordis ctx, as agentbook's plugin uses it: events (prepend: true puts one first), the user-questions
// waterfall, and its services: live agents by session, sessions, permission presets, plan mode.
type Listener = (...a: unknown[]) => unknown;
interface FakeAgent {
  id: string;
  session: { id: string; header: object };
  status: string;
}
const listeners = new Map<string, Listener[]>();
const live = new Map<string, FakeAgent>();
const presetOf = new Map<string, string>();
const services: Record<string, unknown> = {
  agents: { get: (id: string) => live.get(id) },
  sessions: { get: (id: string) => live.get(id)?.session },
  permissionPresets: {
    names: ["read-only", "workspace-write", "danger-full-access"],
    set(session: { id: string }, name: string) {
      presetOf.set(session.id, name);
      log({ cmd: "preset", sessionId: session.id, preset: name });
    },
    current: (session: { id: string }) => presetOf.get(session.id) || "workspace-write",
  },
  planMode: {
    set(agent: FakeAgent, active: boolean) {
      sessions.get(agent.id).plan = active;
      log({ cmd: "plan", sessionId: agent.id, active });
      return "committed";
    },
  },
};
const ctx = {
  on(name: string, fn: Listener, opts?: true | { prepend?: boolean }) {
    const list = listeners.get(name) || listeners.set(name, []).get(name);
    if (opts === true || opts?.prepend) list.unshift(fn);
    else list.push(fn);
  },
  effect() {},
  inject(names: string[], fn: (s: Record<string, unknown>) => void) {
    if (names.every((n) => services[n])) fn({ ...services, effect() {} });
  },
  logger: () => ({ debug() {} }),
};
const waterfall = (name: string, request: object, inner: () => unknown) => {
  const chain = [...(listeners.get(name) || [])];
  const next = (): unknown => (chain.length ? chain.shift()(request, next) : inner());
  return Promise.resolve().then(next);
};
const born = (sid: string, cwd: string) => live.set(sid, { id: sid, session: { id: sid, header: { cwd } }, status: "idle" });
if (args[3]) {
  const overlay = JSON.parse(fs.readFileSync(args[3], "utf8"));
  const entry = overlay.flatMap((x: { insert?: { id: string; name: string; config: object }[] }) => x.insert || []).find((x: { id: string }) => x.id === "agentbook");
  if (entry) (await import(entry.name)).apply(ctx, entry.config);
}

async function callTool(s: DshSession, name: string, args: object): Promise<{ isError?: boolean; content?: unknown[] } | null> {
  const srv = s.servers.find((x) => x.name === "agentbook" && x.type === "http");
  if (!srv) return null;
  const r = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return ((await r.json()) as { result?: { isError?: boolean; content?: unknown[] } }).result;
}

// A tool call and its result, over ACP and in its log.
function tool(sid: string, s: DshSession, name: string, input: object, out: string, error = false) {
  const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
  update(sid, { sessionUpdate: "tool_call", toolCallId: callId, title: name, kind: "other", status: "in_progress", rawInput: input });
  append(s.file, [event("tool/call", { turn: s.turn, step: 1, callId, name, arguments: JSON.stringify(input) })]);
  return {
    callId,
    done: () => {
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: error ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: out } }] });
      append(s.file, [event("tool/result", { turn: s.turn, step: 1, message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text: out }], isError: error, id: crypto.randomUUID() } })]);
    },
  };
}
function reply(sid: string, s: DshSession, text: string) {
  const id = crypto.randomUUID();
  update(sid, { sessionUpdate: "agent_thought_chunk", messageId: id, content: { type: "text", text: "Thinking it over." } });
  update(sid, { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } });
  update(sid, { sessionUpdate: "usage_update", used: 1234, size: 1000000 });
  append(s.file, [event("assistant/message", { turn: s.turn, step: 2, message: { role: "assistant", id, content: [{ type: "reasoning", text: "Thinking it over." }, { type: "text", text }], source: { kind: "assistant", provider: s.model[0], model: s.model[1] } }, usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 0, totalTokens: 1230 } })]);
}

async function prompt(sid: string, s: DshSession, text: string) {
  s.turn++;
  append(s.file, [event("turn/start", { turn: s.turn }), event("user/message", { role: "user", id: crypto.randomUUID(), content: [{ type: "text", text }], source: { kind: "user" } })]);
  let stopReason = "end_turn";
  if (/^fail/i.test(text)) {
    append(s.file, [event("turn/end", { turn: s.turn, reason: { kind: "failed" } })]);
    throw Object.assign(new Error("Internal error: no API key for deepseek-official"), { code: -32603 });
  }
  if (/delete|rm /i.test(text)) {
    const t = tool(sid, s, "bash", { command: "rm -rf build", description: "Delete the build folder" }, "");
    const r = await ask("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: t.callId },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    log({ cmd: "permission", sessionId: sid, outcome: r.outcome });
    const yes = r.outcome?.optionId === "allow-once";
    t.done();
    reply(sid, s, yes ? "Deleted the build folder." : "Left it alone.");
  } else if (/^(Headline|Rename): /.test(text)) {
    const args = /^Rename/.test(text) ? { title: text.slice(8), rename: true } : { title: text.slice(10) };
    const t = tool(sid, s, "mcp__agentbook__ab_post", args, "Thread updated.");
    const r = await callTool(s, "ab_post", args);
    t.done();
    log({ cmd: "tool", sessionId: sid, result: r });
    reply(sid, s, r && !r.isError ? "Set the headline." : "I have no agentbook tools.");
  } else if (s.plan && /^Plan: /.test(text)) {
    // ACP has no one to ask with: the plugin asks it on the thread.
    const questions = [{ id: "plan-review", header: "Plan review", question: "Approve this plan and leave plan mode?", detail: text.slice(6), options: [{ label: "Approve plan" }, { label: "Keep planning" }] }];
    const answer = (await waterfall("user-questions/request", { agent: live.get(sid), questions, wait: { callId: `call_${crypto.randomUUID().slice(0, 8)}` } }, () => Promise.reject(new Error("no user-questions answerer accepted the request")))) as { answers?: { selected?: string[] }[] };
    log({ cmd: "question", sessionId: sid, answer });
    const approved = answer?.answers?.[0]?.selected?.[0] === "Approve plan";
    if (approved) s.plan = false;
    reply(sid, s, approved ? "Plan approved: going ahead." : "Kept planning.");
  } else if (/slow/i.test(text)) {
    const t = tool(sid, s, "bash", { command: "sleep 600" }, "");
    await new Promise<void>((resolve) => (s.cancel = resolve));
    t.done();
    stopReason = "cancelled";
  } else {
    tool(sid, s, "bash", { command: "ls", description: "List the files" }, "README.md").done();
    reply(sid, s, `Done: ${text}`);
  }
  append(s.file, [event("turn/end", { turn: s.turn, reason: { kind: stopReason === "cancelled" ? "cancelled" : "completed" } })]);
  if (!s.titled) {
    s.titled = true;
    append(s.file, [event("session/title", { title: `About ${text.slice(0, 30)}`, messageSeqs: [], source: { kind: "first-prompt" } })]);
  }
  return { stopReason };
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m: AcpMessage = JSON.parse(line);
  if (m.id != null && !m.method) {
    waiting.get(m.id)?.(m.result);
    return waiting.delete(m.id);
  }
  log({ cmd: "acp", method: m.method, params: m.params });
  const p = m.params || {};
  const s = sessions.get(p.sessionId);
  const fail = (message: string, code = -32602) => send({ id: m.id, error: { code, message } });
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "deepseek-harness-acp" }, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] } });
    case "session/new": {
      const sid = crypto.randomUUID();
      const file = logOf(sid, p.cwd);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      append(file, [{ type: "session", version: 4, id: sid, createdAt: Date.now(), cwd: p.cwd, origin: "acp" }]);
      const n: DshSession = { cwd: p.cwd, file, model: MODELS[0].slice(0, 2), effort: "high", servers: p.mcpServers || [], turn: 0 };
      sessions.set(sid, n);
      born(sid, p.cwd);
      return send({ id: m.id, result: { sessionId: sid, configOptions: options(n) } });
    }
    case "session/resume": {
      if (sessions.has(p.sessionId)) return fail(`Invalid params: session is already active: ${p.sessionId}`);
      const file = logOf(p.sessionId, p.cwd);
      if (!fs.existsSync(file)) return fail(`Invalid params: session is not resumable: ${p.sessionId}`);
      const n: DshSession = { cwd: p.cwd, file, model: MODELS[0].slice(0, 2), effort: "high", servers: p.mcpServers || [], turn: 10, titled: true };
      sessions.set(p.sessionId, n);
      born(p.sessionId, p.cwd);
      return send({ id: m.id, result: { configOptions: options(n) } });
    }
    case "session/set_config_option": {
      if (!s) return fail(`Invalid params: unknown session: ${p.sessionId}`);
      if (p.configId === "model") {
        const pick = MODELS.find(([pr, mo]) => JSON.stringify([pr, mo]) === p.value);
        if (!pick) return fail(`Invalid params: unknown model: ${p.value}`);
        s.model = pick.slice(0, 2);
      } else if (p.configId === "reasoning_effort") {
        if (!EFFORTS.includes(p.value)) return fail(`Invalid params: unknown reasoning effort: ${p.value}`);
        s.effort = p.value;
      } else return fail(`Invalid params: unknown session config option: ${p.configId}`);
      return send({ id: m.id, result: { configOptions: options(s) } });
    }
    case "session/prompt": {
      if (!s) return fail(`Invalid params: unknown session: ${p.sessionId}`);
      if (s.busy) {
        log({ cmd: "busy", sessionId: p.sessionId });
        return fail("Invalid params: a prompt is already in flight for this session");
      }
      s.busy = true;
      try {
        send({ id: m.id, result: await prompt(p.sessionId, s, p.prompt[0].text) }); // what comes after it is context
      } catch (e) {
        send({ id: m.id, error: { code: (e as Error & { code?: number }).code || -32603, message: e.message } });
      } finally {
        s.busy = false;
      }
      return;
    }
    case "session/cancel":
      return s?.cancel?.();
    default:
      if (m.id != null) fail(`Method not found: ${m.method}`, -32601);
  }
});
