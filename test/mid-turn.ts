#!/usr/bin/env node
// A background session stays on its turn through everything Claude Code and agentbook do in the middle of one: a
// tool step, a permission prompt and its answer, a compact (Claude Code runs SessionStart again), Send now reaching
// it, a Stop that hands it something and keeps it going, and agentbook-cli or agentbook-server restarting. After each,
// its page offers Enqueue, what you enqueued stays held, and nothing stops or resumes it. A compact once marked it
// not busy: the box lost Enqueue, and what you sent woke it, cutting the turn it was in off (8885ee1).
// Run: node test/mid-turn.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-mid-turn-"));
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown) => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const calls = (): { args: string[] }[] => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const woken = (id: string, mark: number) => calls().slice(mark).filter((c) => c.args.includes(id) && (c.args.includes("--resume") || c.args[0] === "stop"));
const hookEnv = (pid: number) => ({ ...env, AGENTBOOK_PID: String(pid) });
const hookInput = (input: object) => JSON.stringify({ cwd: project, session_id: ID, ...input });
const hook = (event: string, input = {}, pid = PID) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: hookInput(input), env: hookEnv(pid), encoding: "utf8", timeout: 15000 });
// One that waits on agentbook (a permission prompt), answered meanwhile.
const hookAsync = (event: string, input = {}, pid = PID) =>
  new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { env: hookEnv(pid) });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", () => resolve(stdout));
    child.stdin.end(hookInput(input));
  });
const agents = (pid: number, status: string) => fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: ID, sessionId: ID, kind: "background", state: "working", status, cwd: project, pid, name: ID }]));
const detail = () => get(`/api/sessions/${ID}`);
const queued = async () => (await detail()).messages.filter((m) => m.queued).map((m) => m.text);
// What the reply box shows Enqueue for (queues in web/components/thread/ReplyBox.tsx).
const offersEnqueue = (s: Json) => !!(s.busy || s.going?.length) && s.state !== "done" && !s.asleep && s.rt?.kind !== "cloud";

const ID = "bg-long-turn";
const PID = 5400;
const ENQUEUED = "then add a light mode";
agents(PID, "busy");

// Still on its turn: the box offers Enqueue, what you enqueued waits, and nothing has stopped or resumed it since the
// turn began. Says what's wrong otherwise.
let turnMark = 0;
async function onTurn(after: string) {
  await sleep(400); // what a wrong turn end sets off (the queue letting go, a wake) has its moment
  const s = await detail();
  const q = await queued();
  const w = woken(ID, turnMark);
  const wrong = [!offersEnqueue(s) && `busy ${s.busy}, state ${s.state}`, JSON.stringify(q) !== JSON.stringify([ENQUEUED]) && `queue ${JSON.stringify(q)}`, w.length && `woken: ${w.map((c) => c.args.join(" ")).join("; ")}`].filter(Boolean);
  check(!wrong.length, `after ${after}: still on its turn, Enqueue offered, the queue held, nothing woken${wrong.length ? ` (${wrong.join(", ")})` : ""}`);
}

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- a long turn, and something enqueued for after it ----------
  hook("SessionStart", { source: "startup" });
  turnMark = calls().length;
  hook("UserPromptSubmit", { prompt: "Build the files part, then run the UI tests" });
  check((await until(async () => (await detail()).busy)) === true, "a session on a turn is busy");
  const held = await post(`/api/sessions/${ID}/messages`, { text: ENQUEUED, queue: true });
  check(held.status === 200 && held.held, "what you enqueue is held for the end of the turn");
  await onTurn("you enqueue something");

  // ---------- what happens in the middle of a turn ----------
  check(hook("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: {} }).stdout === "", "a tool step with nothing for it says nothing");
  await onTurn("a tool step");

  hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  const asking = hookAsync("PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm run test:ui" }, tool_use_id: "toolu_ui" });
  const pq = await until(async () => (await stateOf(get)).questions.find((q) => q.kind === "permission" && q.post === ID && !q.answered), 8000);
  check(!!pq, "it asks to run the UI tests on its thread");
  await onTurn("a permission prompt");
  await post(`/api/questions/${pq.id}/answer`, { value: "allow" });
  check(JSON.parse((await asking) || "{}").hookSpecificOutput?.decision?.behavior === "allow", "allowing it there answers Claude Code's prompt");
  await onTurn("its answer");

  hook("SessionStart", { source: "compact" });
  await onTurn("a compact (SessionStart again, same process)");

  const now = await post(`/api/sessions/${ID}/messages`, { text: "and keep the dark one" });
  check(now.status === 200 && !now.held, "Send now isn't held");
  await onTurn("Send now");
  check(/and keep the dark one/.test(hook("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: {} }).stdout), "Send now reaches it at its next step");
  await onTurn("Send now reaching it");

  await post(`/api/sessions/${ID}/messages`, { text: "check the contrast too" });
  const handed = JSON.parse(hook("Stop", { stop_hook_active: false, last_assistant_message: "UI tests pass." }).stdout || "{}");
  check(handed.decision === "block" && /check the contrast too/.test(handed.reason), "a Stop with something new for it hands it over and keeps it going");
  await onTurn("a Stop that keeps it going");

  await server.restart("agentbook-cli");
  await onTurn("agentbook-cli restarting");
  hook("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: {} });
  await onTurn("a tool step after the restart");
  await server.restart("agentbook-server");
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  await onTurn("agentbook-server restarting");

  await sleep(2500); // past agentbook-cli's round of deliveries (every 2s), which wakes a session it takes as idle
  await onTurn("a while");

  // ---------- the turn ends: what you enqueued goes in ----------
  const mark = calls().length;
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Files done; UI tests pass, contrast checked." });
  agents(PID, "idle");
  const woke = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume") && c.args.includes(ID)), 8000);
  check(woke?.args[0] === ENQUEUED, "once the turn ends, what you enqueued goes in as its next prompt");
  check((await queued()).length === 0, "and leaves the queue");

  // ---------- the process it resumes in is new: it starts between turns, then compacts on its own turn ----------
  agents(PID + 1, "busy");
  hook("SessionStart", { source: "resume" }, PID + 1);
  check((await detail()).busy === false, "a new process saying hello isn't on a turn yet");
  hook("UserPromptSubmit", { prompt: ENQUEUED }, PID + 1);
  hook("SessionStart", { source: "compact" }, PID + 1);
  const resumed = await detail();
  check(resumed.busy === true && offersEnqueue(resumed), "its own turn survives its compact too");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
