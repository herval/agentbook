#!/usr/bin/env node
// A `grok` stand-in, shaped like grok 1.0.89's as seen for real on 2026-11-26. `grok agent --no-leader stdio` speaks
// ACP: its own tools' names and inputs (run_terminal_command, search_replace, use_tool for an MCP server's), each
// call's first update named by its tool and the next by what it does, a permission asked before an edit and a command
// that isn't safe in Ask, only before one outside the folder or one that deletes in Auto, never in always-approve
// (yoloMode), and ending its turn (`cancelled`) on a Deny; its modes as `_meta` on session/new, load and resume, where a
// resume or a load of a session it has open turns auto on but never off, and a closed session loads asking; its model and reasoning effort as config options
// set with plain strings, each model with its own efforts; its slash commands; its own notifications
// (_x.ai/session_notification: background_tasks, task_completed, turn_completed); and each session's updates kept in
// GROK_HOME/sessions/<folder>/<session>/updates.jsonl, but for sessions in a folder named no-log. A command it runs in
// the background outlives its turn, and when it ends grok wakes by itself, with no prompt. `grok --version`,
// `grok update [--check --json]` and `grok login --device-auth` answer too. No x.ai account or model call is involved.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const dir = process.env.FAKE_GROK_DIR;
const home = process.env.GROK_HOME;
const args = process.argv.slice(2);
const log = (v) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ ...v, pid: process.pid }) + "\n");
const read = (name: string) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8").trim() : null);
const version = () => read("version") || "1.0.89";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

if (args[0] === "--version") {
  console.log(`grok ${version()} (test) [stable]`);
  process.exit(0);
}
if (args[0] === "update") {
  const latest = read("latest") || version();
  if (args.includes("--check")) {
    console.log(JSON.stringify({ currentVersion: version(), latestVersion: latest, updateAvailable: latest !== version(), installer: "internal", channel: "stable", autoUpdate: null, error: null }));
    process.exit(0);
  }
  log({ cmd: "update" });
  fs.writeFileSync(path.join(dir, "version"), latest);
  console.log(`Updated grok to ${latest}`);
  process.exit(0);
}
if (args[0] === "login") {
  log({ cmd: "login", args });
  console.log("To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=TEST-CODE\n\nConfirm this code in your browser:\n\n  TEST-CODE\n\nWaiting for authorization...");
  while (!fs.existsSync(path.join(dir, "confirmed"))) await sleep(100);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), "{}");
  console.log("✓ Signed in as tester");
  process.exit(0);
}
if (args.join(" ") !== "agent --no-leader stdio") process.exit(1);

log({ cmd: "started", args, key: process.env.XAI_API_KEY || null, questions: process.env.GROK_ASK_USER_QUESTION ?? null });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const efforts = (list: string[], def: string) => list.map((v) => ({ id: v, value: v, label: v, default: v === def }));
const MODELS = [
  { modelId: "grok-4.7", name: "Grok 4.7", _meta: { supportsReasoningEffort: true, reasoningEfforts: efforts(["xhigh", "high", "medium", "low"], "high") } },
  { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast", _meta: { supportsReasoningEffort: false } },
  { modelId: "grok-4.5", name: "Grok 4.5", _meta: { supportsReasoningEffort: true, reasoningEfforts: efforts(["high", "medium", "low"], "medium") } },
];
const levelsOf = (model: string) => (MODELS.find((m) => m.modelId === model)?._meta.reasoningEfforts || []).map((e) => e.value);
const modelState = (s?) => ({ currentModelId: s?.model || "grok-4.7", availableModels: MODELS });
const options = (s) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS.map((m) => ({ value: m.modelId, name: m.name })) },
  ...(levelsOf(s.model).length ? [{ id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: s.effort, options: levelsOf(s.model).map((value) => ({ value, name: value })) }] : []),
];
const BUILT_IN = [
  { name: "compact", description: "Compress conversation history to save context window", input: null },
  { name: "always-approve", description: "Toggle always-approve mode (skip all permission prompts)", input: { hint: "on|off" } },
  { name: "deep-research", description: "Research with bounded parallel agents", input: { hint: "<query>" } },
];
const saved = (id: string) => path.join(dir, `session-${id}.json`);
const keep = (id: string, s) => fs.writeFileSync(saved(id), JSON.stringify({ cwd: s.cwd, model: s.model, effort: s.effort, yolo: s.yolo, auto: s.auto, history: s.history }));
// What it keeps of a session, one JSON line an update, as grok writes updates.jsonl.
const record = (id: string, s, method: string, u) => {
  if (s.cwd.includes("no-log")) return;
  const file = path.join(home, "sessions", encodeURIComponent(s.cwd), id, "updates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), method, params: { sessionId: id, update: u } }) + "\n");
};
// An update, live, kept for a replay and in its log.
const emit = (id: string, s, u) => {
  send({ method: "session/update", params: { sessionId: id, update: u } });
  s.history.push(u);
  record(id, s, "session/update", u);
};
// One of its own notifications, live and in its log.
const notice = (id: string, s, u) => {
  send({ method: "_x.ai/session_notification", params: { sessionId: id, update: u } });
  record(id, s, "_x.ai/session/update", u);
};
const sessions = new Map<string, any>();
const waiting = new Map<number, (v: any) => void>();
let seq = 0;
const permission = (sessionId: string, toolCall) =>
  new Promise<any>((resolve) => {
    const id = seq++;
    waiting.set(id, resolve);
    send({ id, method: "session/request_permission", params: { sessionId, toolCall, options: [{ optionId: "allow-edits-session", name: "Yes, for this session", kind: "allow_always" }, { optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "reject-once", name: "No", kind: "reject_once" }] } });
  });
const meta = (name: string, kind: string) => ({ "x.ai/tool": { version: 1, name, kind, namespace: "grok_build", label: name, read_only: false } });

// A tool call as grok sends it: named by its tool first, then by what it does, asked about when it must be, then done.
async function tool(id: string, s, name: string, kind: string, input, o: { ask?: boolean; title: string; output?: string; diff?: { path: string; oldText: string; newText: string }; wait?: () => Promise<void>; background?: boolean }) {
  const toolCallId = `call-${crypto.randomUUID()}-0`;
  emit(id, s, { sessionUpdate: "tool_call", toolCallId, title: name, rawInput: input, _meta: meta(name, kind) });
  const call = { toolCallId, kind: kind === "write" ? "edit" : kind, title: o.title, content: o.diff ? [{ type: "diff", ...o.diff }] : [{ type: "content", content: { type: "text", text: input.description || "" } }], locations: o.diff ? [{ path: o.diff.path }] : [], rawInput: input, _meta: meta(name, kind) };
  emit(id, s, { sessionUpdate: "tool_call_update", ...call });
  let allowed = true;
  if (o.ask) {
    const answer = await permission(id, call);
    log({ cmd: "permission", sessionId: id, tool: name, outcome: answer?.outcome });
    allowed = /^allow/.test(answer?.outcome?.optionId || "");
  }
  if (o.background) return toolCallId;
  if (o.wait) await o.wait();
  const failed = !allowed || s.cancelled;
  emit(id, s, { sessionUpdate: "tool_call_update", toolCallId, status: failed ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: failed ? (s.cancelled ? "Cancelled" : "Denied") : `\u001b[1m\u001b[36m${o.output ?? ""}\u001b[39;49m\u001b[0m\n` } }] });
  return allowed && !s.cancelled;
}
function say(id: string, s, text: string) {
  send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private reasoning." } } } });
  for (const chunk of text.split(/(\s+)/)) send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } } });
  const u = { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
  s.history.push(u);
  record(id, s, "session/update", u);
}
const turnDone = (id: string, s, promptId: string | null, stop = "end_turn") => notice(id, s, { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: stop, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
const cancelled = (s) => new Promise<void>((resolve) => (s.cancel = resolve));

// A command left running in the background (`is_background`): its call stays in progress as the turn ends, and grok
// lists it. Once it ends (FAKE_GROK_DIR/<release> exists), grok says so and wakes by itself, with no prompt running:
// a command, then its answer, and the turn's end. A slow one's command waits for a session/cancel.
async function background(id: string, s, text: string) {
  const release = path.join(dir, /until (\S+)/.exec(text)?.[1] || "release");
  const call = await tool(id, s, "run_terminal_command", "execute", { command: "npm run build", description: "Build it", is_background: true }, { title: "Execute `npm run build`", background: true });
  const task = { task_id: `bg-${s.history.length}`, kind: "bash", description: "npm run build", command: "npm run build", status: "running", started_at: new Date().toISOString() };
  notice(id, s, { sessionUpdate: "background_tasks", tasks: [task] });
  say(id, s, "Started the build in the background.");
  (async () => {
    while (!fs.existsSync(release)) await sleep(100);
    emit(id, s, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed", content: [{ type: "content", content: { type: "text", text: "exit: 0" } }] });
    notice(id, s, { sessionUpdate: "task_completed", task_id: task.task_id, will_wake: true });
    notice(id, s, { sessionUpdate: "background_tasks", tasks: [] });
    await sleep(50);
    const slow = /slow/.test(text);
    s.cancelled = false;
    // Slow enough for a page polling it to see the turn.
    await tool(id, s, "run_terminal_command", "execute", { command: slow ? "npm test" : "ls dist", description: "Check the build" }, { title: `Execute \`${slow ? "npm test" : "ls dist"}\``, output: "dist/app.js", wait: slow ? () => cancelled(s) : () => sleep(1500) });
    if (!slow) say(id, s, "The build finished: dist/app.js.");
    turnDone(id, s, null, slow ? "cancelled" : "end_turn");
    keep(id, s);
  })();
  return "end_turn";
}

async function prompt(id: string, s, text: string, promptId: string) {
  const u = { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
  s.history.push(u);
  record(id, s, "session/update", u);
  s.cancelled = false;
  if (/^fail/.test(text)) throw new Error("Upstream unavailable");
  if (/^crash/.test(text)) {
    console.error("Grok test process crashed");
    process.exit(12);
  }
  if (/^background/.test(text)) return background(id, s, text);
  if (/^\/compact/.test(text)) {
    say(id, s, "Compacted the conversation.");
    return "end_turn";
  }
  if (s.history.filter((x) => x.sessionUpdate === "user_message_chunk").length === 1) send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "session_info_update", title: "Reading the files" } } });
  emit(id, s, { sessionUpdate: "plan", entries: [{ content: "Read the files", status: "completed", priority: "medium" }] });
  if (/^Headline: /.test(text)) {
    const input = { tool_name: "agentbook__ab_post", tool_input: { title: text.slice(10) } };
    await tool(id, s, "use_tool", "other", input, { ask: !s.yolo, title: "agentbook__ab_post", output: "Thread updated." });
    const srv = s.servers.find((x) => x.name === "agentbook");
    const r = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ab_post", arguments: { title: text.slice(10) } } }) });
    log({ cmd: "tool", result: await r.json() });
    say(id, s, "Set the headline.");
    return "end_turn";
  }
  const edit = /^edit/i.test(text);
  const outside = /outside/i.test(text);
  const slow = /^slow/i.test(text);
  const deletes = /^delete/i.test(text);
  // Ask: edits and commands that change things ask; Auto: only an edit outside the folder or a delete; always-approve:
  // nothing.
  const ask = !s.yolo && (s.auto ? (edit ? outside : deletes) : edit || deletes || slow);
  let ok: boolean;
  if (edit) {
    const file = outside ? path.join(path.dirname(s.cwd), "OUTSIDE.md") : path.join(s.cwd, "README.md");
    ok = true === await tool(id, s, "search_replace", "edit", { file_path: file, old_string: "before", new_string: "after" }, { ask, title: `Edit \`${file}\``, diff: { path: file, oldText: "before\n", newText: "after\n" } });
  } else {
    const command = deletes ? "rm -rf build" : slow ? "sleep 600" : "ls";
    ok = true === await tool(id, s, "run_terminal_command", "execute", { command, description: "Run it" }, { ask, title: `Execute \`${command}\``, output: "README.md", wait: slow ? () => cancelled(s) : undefined });
  }
  if (slow || !ok) return "cancelled";
  say(id, s, `Done: ${text}`);
  return "end_turn";
}

const signedIn = () => fs.existsSync(path.join(home, "auth.json")) || !!process.env.XAI_API_KEY;
// As grok 1.0.89 takes them: always-approve on or off, auto only on (unless the same request turns always-approve on).
const modes = (s, m) => {
  if (m?.yoloMode === true) s.yolo = true;
  else if (m?.yoloMode === false) s.yolo = false;
  if (m?.autoMode === true && m?.yoloMode !== true) s.auto = true;
};
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.method) {
    waiting.get(m.id)?.(m.result);
    waiting.delete(m.id);
    return;
  }
  log({ method: m.method, params: m.params });
  const p = m.params || {};
  let s = sessions.get(p.sessionId);
  try {
    let result;
    switch (m.method) {
      case "initialize":
        result = {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
          authMethods: [{ id: "cached_token", name: "cached_token" }, { id: "grok.com", name: "Grok" }],
          _meta: { agentVersion: version(), modelState: modelState(), availableCommands: BUILT_IN },
        };
        break;
      case "session/new": {
        if (!signedIn()) throw Object.assign(new Error("Authentication required"), { code: -32000 });
        const id = `01a2${crypto.randomUUID().slice(4)}`;
        s = { cwd: p.cwd, servers: p.mcpServers, model: "grok-4.7", effort: "high", yolo: p._meta?.yoloMode === true, auto: p._meta?.autoMode === true && p._meta?.yoloMode !== true, history: [] };
        sessions.set(id, s);
        keep(id, s);
        send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "available_commands_update", availableCommands: [...BUILT_IN, { name: "review", description: "Review the changes (a skill)", input: { hint: "[focus]" } }] } } });
        result = { sessionId: id, models: modelState(s), configOptions: options(s) };
        break;
      }
      case "session/load": {
        // One it has open keeps its modes; one it doesn't starts asking.
        s = s ? { ...s, cwd: p.cwd, servers: p.mcpServers } : { ...JSON.parse(fs.readFileSync(saved(p.sessionId), "utf8")), cwd: p.cwd, servers: p.mcpServers, yolo: false, auto: false };
        modes(s, p._meta);
        sessions.set(p.sessionId, s);
        for (const u of s.history) send({ method: "session/update", params: { sessionId: p.sessionId, update: u } });
        result = { models: modelState(s), configOptions: options(s) };
        break;
      }
      case "session/resume":
        if (!s) throw new Error(`No session ${p.sessionId}`);
        s.servers = p.mcpServers;
        modes(s, p._meta);
        keep(p.sessionId, s);
        notice(p.sessionId, s, { sessionUpdate: "background_tasks", tasks: [] });
        result = { models: modelState(s), configOptions: options(s) };
        break;
      case "session/set_config_option":
        if (typeof p.value !== "string") throw Object.assign(new Error("Invalid params"), { code: -32602 });
        if (p.configId === "model" && MODELS.some((x) => x.modelId === p.value)) {
          s.model = p.value;
          const levels = levelsOf(s.model);
          if (!levels.includes(s.effort)) s.effort = levels.find((v) => MODELS.find((x) => x.modelId === s.model)._meta.reasoningEfforts.find((e) => e.value === v).default) || null;
        } else if (p.configId === "reasoning_effort" && levelsOf(s.model).includes(p.value)) s.effort = p.value;
        else throw new Error(`Unknown value ${p.value} for ${p.configId}`);
        keep(p.sessionId, s);
        send({ method: "session/update", params: { sessionId: p.sessionId, update: { sessionUpdate: "config_option_update", configOptions: options(s) } } });
        result = { configOptions: options(s) };
        break;
      case "session/prompt": {
        if (s.busy) {
          log({ cmd: "busy" });
          throw new Error("A prompt is already running");
        }
        s.busy = true;
        const promptId = crypto.randomUUID();
        try {
          const stopReason = await prompt(p.sessionId, s, p.prompt[0].text, promptId);
          turnDone(p.sessionId, s, promptId, stopReason);
          result = { stopReason };
        } finally {
          s.busy = false;
          keep(p.sessionId, s);
        }
        break;
      }
      case "session/cancel":
        if (s) s.cancelled = true;
        s?.cancel?.();
        return;
      case "session/close":
        sessions.delete(p.sessionId);
        result = {};
        break;
      default:
        throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 });
    }
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, error: { code: e.code || -32603, message: e.message } });
  }
});
