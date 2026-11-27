#!/usr/bin/env node
// An `agy acp` stand-in, shaped like Antigravity CLI 1.5.13's: tool calls with agy's own names and inputs
// (run_command's CommandLine, mcp_agentbook_ab_post), its model, thinking level and mode as config options, a
// permission asked before each MCP tool, and before each command and edit in Default mode (in Auto, only before an
// irreversible command or an edit outside the folder), sessions it loads and replays, and its transcript
// (AGENTBOOK_AGY_DATA/brain/<session>/.system_generated/logs/transcript.jsonl), but for sessions in a folder named
// no-transcript. Each session's history is kept in FAKE_AGY_DIR, so a new process can load it. A command it runs as a
// background task outlives its turn, and when it ends agy wakes by itself, with no prompt, as 1.5.13 does over ACP. No
// Google account or model call is involved.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv[2] !== "acp") process.exit(1);
const dir = process.env.FAKE_AGY_DIR;
const log = (v) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ ...v, pid: process.pid }) + "\n");
log({ cmd: "started", args: process.argv.slice(2) });
const skipPermissions = process.argv.includes("--dangerously-skip-permissions");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const MODELS = ["gemini-4-neon-medium", "gemini-4-neon-high", "claude-sonnet-5-5"];
const LEVELS = ["low", "medium", "high"];
const MODES = ["default", "accept-edits", "auto", "plan"];
const options = (s) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS.map((value) => ({ value, name: value.replace(/-/g, " ") })) },
  { id: "thought_level", name: "Thinking level", category: "thought_level", type: "select", currentValue: s.level, options: LEVELS.map((value) => ({ value, name: value })) },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES.map((value) => ({ value, name: value })) },
];
const saved = (id) => path.join(dir, `session-${id}.json`);
// Its transcript, as agy writes it: one record a step, a tool call's arguments JSON-encoded.
const record = (id, s, r) => {
  if (s.cwd.includes("no-transcript")) return;
  const file = path.join(process.env.AGENTBOOK_AGY_DATA, "brain", id, ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  s.step = (s.step ?? -1) + 1;
  fs.appendFileSync(file, JSON.stringify({ step_index: s.step, status: "DONE", created_at: new Date().toISOString(), ...r }) + "\n");
};
const called = (name, input) => ({ name, args: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, JSON.stringify(v)])) });
const keep = (id, s) => fs.writeFileSync(saved(id), JSON.stringify({ cwd: s.cwd, model: s.model, level: s.level, mode: s.mode, history: s.history, step: s.step }));
const sessions = new Map<string, any>();
const waiting = new Map<number, (v: any) => void>();
let seq = 1000;
const permission = (sessionId, toolCall) =>
  skipPermissions ? Promise.resolve({ outcome: { outcome: "selected", optionId: "allow" } }) : new Promise<any>((resolve) => {
    const id = seq++;
    waiting.set(id, resolve);
    send({ id, method: "session/request_permission", params: { sessionId, toolCall, options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "allow_always", optionId: "allow_always", name: "Always allow" }, { kind: "reject_once", optionId: "reject", name: "Deny" }] } });
  });
// What it says and does, as it says it live, and kept for a replay.
const emit = (id, s, u) => {
  update(id, u);
  s.history.push(u);
};
function reply(id, s, text) {
  update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private reasoning." } });
  for (const chunk of text.split(/(\s+)/)) update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  s.history.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  record(id, s, { source: "MODEL", type: "PLANNER_RESPONSE", model: `${s.model}-${s.level}`, thinking: "Private reasoning.", content: text });
  update(id, { sessionUpdate: "usage_update", used: 321, size: 1000000 });
}
// A command run as a background task (its WaitMsBeforeAsync passed): its call stays in_progress as the turn ends. Once
// it ends (here, once FAKE_AGY_DIR/<release> exists), agy wakes by itself and works on with no prompt running: the
// call's update, a thought, a command, its answer, each answer ending in a usage_update, and no result. A slow one's
// command waits until a session/cancel fails it, and then nothing more comes, as with real agy.
async function background(id, s, text) {
  const release = path.join(dir, /until (\S+)/.exec(text)?.[1] || "release");
  const input = { CommandLine: "npm run build", IsDaemon: false, WaitMsBeforeAsync: 1000, toolSummary: "Build it" };
  const call = { toolCallId: crypto.randomUUID(), name: "run_command", args: input, rawInput: input, title: input.CommandLine, kind: "execute", status: "in_progress" };
  emit(id, s, { sessionUpdate: "tool_call", ...call });
  record(id, s, { source: "MODEL", type: "PLANNER_RESPONSE", model: `${s.model}-${s.level}`, tool_calls: [called(call.name, input)] });
  record(id, s, { source: "MODEL", type: "GENERIC", status: "RUNNING", content: `Tool is running as a background task with task id: ${id}/task-${s.step}` });
  reply(id, s, "Started the build in the background.");
  (async () => {
    while (!fs.existsSync(release)) await new Promise((r) => setTimeout(r, 100));
    emit(id, s, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "Command exited with code 0." } }] });
    record(id, s, { source: "SYSTEM", type: "SYSTEM_MESSAGE", content: `Task id "${id}/task" finished with result: Command exited with code 0.` });
    update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private reasoning." } });
    update(id, { sessionUpdate: "usage_update", used: 400, size: 1000000 });
    const slow = /slow/.test(text);
    const check = { CommandLine: slow ? "npm test" : "ls dist", WaitMsBeforeAsync: 60000, toolSummary: "Check the build" };
    const next = { toolCallId: crypto.randomUUID(), name: "run_command", args: check, rawInput: check, title: check.CommandLine, kind: "execute", status: "in_progress" };
    emit(id, s, { sessionUpdate: "tool_call", ...next });
    record(id, s, { source: "MODEL", type: "PLANNER_RESPONSE", model: `${s.model}-${s.level}`, tool_calls: [called(next.name, check)] });
    if (slow) await new Promise<void>((resolve) => (s.cancel = resolve));
    emit(id, s, { sessionUpdate: "tool_call_update", toolCallId: next.toolCallId, status: slow ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: slow ? "Cancelled" : "dist/app.js" } }] });
    record(id, s, { source: "MODEL", type: "GENERIC", status: slow ? "ERROR" : "DONE", content: slow ? "Cancelled" : "dist/app.js" });
    if (!slow) reply(id, s, "The build finished: dist/app.js.");
    keep(id, s);
  })();
  return { stopReason: "end_turn" };
}
async function prompt(id, s, text) {
  s.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  record(id, s, { source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  if (/^fail/.test(text)) throw new Error("Upstream unavailable");
  if (/^background/.test(text)) return background(id, s, text);
  if (/^crash/.test(text)) {
    console.error("Antigravity test process crashed");
    process.exit(12);
  }
  emit(id, s, { sessionUpdate: "plan", entries: [{ content: "Read the files", status: "completed", priority: "medium" }] });
  if (s.history.filter((u) => u.sessionUpdate === "user_message_chunk").length === 1) update(id, { sessionUpdate: "session_info_update", title: "Reading the files" });
  if (/^Headline: /.test(text)) {
    const toolCallId = crypto.randomUUID();
    const input = { title: text.slice(10), toolSummary: "Set thread headline" };
    const call = { toolCallId, name: "mcp_agentbook_ab_post", args: input, title: "Run mcp_agentbook_ab_post", kind: "other", status: "pending", rawInput: input };
    emit(id, s, { sessionUpdate: "tool_call", ...call });
    record(id, s, { source: "MODEL", type: "PLANNER_RESPONSE", model: `${s.model}-${s.level}`, tool_calls: [called(call.name, input)] });
    const answer = await permission(id, call);
    log({ cmd: "permission", sessionId: id, tool: "ab_post", outcome: answer.outcome });
    const srv = s.servers.find((x) => x.name === "agentbook");
    const r = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ab_post", arguments: { title: text.slice(10) } } }) });
    log({ cmd: "tool", result: await r.json() });
    emit(id, s, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "Thread updated." } }] });
    record(id, s, { source: "MODEL", type: "GENERIC", content: "Thread updated." });
    reply(id, s, "Set the headline.");
    return { stopReason: "end_turn" };
  }
  const edit = /^edit/i.test(text);
  const outside = /outside/i.test(text);
  const slow = /^slow/i.test(text);
  const irreversible = /^delete/i.test(text);
  // Auto: edits in the folder and safe commands go ahead; Plan: only a safe command (reading) does; Default asks for all.
  const ask = !skipPermissions && (s.mode === "auto" ? (edit ? outside : irreversible) : s.mode === "plan" ? edit || irreversible : true);
  const file = outside ? path.join(path.dirname(s.cwd), "OUTSIDE.md") : path.join(s.cwd, "README.md");
  const command = irreversible ? "rm -rf build" : slow ? "sleep 600" : "ls";
  const name = edit ? "replace_file_content" : "run_command";
  const input = edit ? { TargetFile: file, toolSummary: "Edit the README" } : { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Run it" };
  const call = { toolCallId: crypto.randomUUID(), name, args: input, rawInput: input, title: edit ? `Edit ${path.basename(file)}` : command, kind: edit ? "edit" : "execute", status: ask ? "pending" : "in_progress", locations: [{ path: file }], ...(edit ? { content: [{ type: "diff", path: file, oldText: "before\n", newText: "after\n" }] } : {}) };
  emit(id, s, { sessionUpdate: "tool_call", ...call });
  record(id, s, { source: "MODEL", type: "PLANNER_RESPONSE", model: `${s.model}-${s.level}`, tool_calls: [called(name, input)] });
  let allowed = true;
  if (ask) {
    const answer = await permission(id, call);
    log({ cmd: "permission", sessionId: id, outcome: answer.outcome });
    allowed = answer.outcome?.optionId === "allow";
  }
  if (slow) await new Promise<void>((resolve) => (s.cancel = resolve));
  emit(id, s, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "README.md" : "Denied" } }] });
  record(id, s, { source: "MODEL", type: "GENERIC", status: allowed ? "DONE" : "ERROR", content: allowed ? "README.md" : "Denied" });
  if (!slow) reply(id, s, allowed ? `Done: ${text}` : "Left it alone.");
  return { stopReason: slow ? "cancelled" : "end_turn" };
}
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
        result = { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "test" }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {} } }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] };
        break;
      case "session/new": {
        if (fs.existsSync(path.join(dir, "needs-auth"))) throw Object.assign(new Error("Authentication required"), { code: -32000 });
        const id = crypto.randomUUID();
        s = { cwd: p.cwd, servers: p.mcpServers, model: MODELS[0], level: "medium", mode: "default", history: [] };
        sessions.set(id, s);
        keep(id, s);
        result = { sessionId: id, configOptions: options(s) };
        break;
      }
      case "session/load": {
        const was = JSON.parse(fs.readFileSync(saved(p.sessionId), "utf8"));
        s = { ...was, cwd: p.cwd, servers: p.mcpServers };
        sessions.set(p.sessionId, s);
        for (const u of s.history) update(p.sessionId, u);
        result = { configOptions: options(s) };
        break;
      }
      case "session/set_config_option":
        if (p.configId === "model" && MODELS.includes(p.value)) s.model = p.value;
        else if (p.configId === "thought_level" && LEVELS.includes(p.value)) s.level = p.value;
        else if (p.configId === "mode" && MODES.includes(p.value)) s.mode = p.value;
        else throw new Error(`Unknown value ${p.value} for ${p.configId}`);
        keep(p.sessionId, s);
        result = { configOptions: options(s) };
        break;
      case "session/prompt":
        if (s.busy) {
          log({ cmd: "busy" });
          throw new Error("A prompt is already running");
        }
        s.busy = true;
        try {
          result = await prompt(p.sessionId, s, p.prompt[0].text);
        } finally {
          s.busy = false;
          keep(p.sessionId, s);
        }
        break;
      case "session/cancel":
        s?.cancel?.();
        return;
      case "session/close":
        sessions.delete(p.sessionId);
        result = {};
        break;
      default:
        throw new Error(`Unknown method ${m.method}`);
    }
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, error: { code: e.code || -32603, message: e.message } });
  }
});
