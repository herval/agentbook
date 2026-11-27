#!/usr/bin/env node
// A prompt on Claude Code's own screen can end with no hook at all: answered in its terminal, or timed out in auto mode,
// where Claude Code denies the command and goes on. A thread needs you for as long as Claude Code lists its session as
// waiting, and no longer. A list that can't speak
// for the prompt doesn't count: one that failed, or one asked for before it. What's open on agentbook ends with its answer.
// Run: node test/terminal-prompt.ts

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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-terminal-prompt-"));
const PORT = testPort(4610);
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
  AGENTBOOK_RUNTIME_MS: "200",
  AGENTBOOK_API_MS: "10000",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};

// Real processes, as Claude Code's are: agentbook looks at whether they're there.
const TERMINAL = "terminal-session";
const BACKGROUND = "background-session";
const procs = { [TERMINAL]: spawn("sleep", ["600"], { stdio: "ignore" }), [BACKGROUND]: spawn("sleep", ["600"], { stdio: "ignore" }) };
const hookInput = (id: string, input: object) => JSON.stringify({ cwd: project, session_id: id, ...input });
const hookEnv = (id: string) => ({ ...env, AGENTBOOK_PID: String(procs[id].pid) });
const hook = (id: string, event: string, input: object = {}) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: hookInput(id, input), env: hookEnv(id), encoding: "utf8", timeout: 30000 });
const hookAsync = (id: string, event: string, input: object = {}) =>
  new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { env: hookEnv(id) });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", () => resolve(stdout));
    child.stdin.end(hookInput(id, input));
  });
const PROMPT = { notification_type: "permission_prompt", message: "Claude needs your permission" };

// As `claude agents --json --all` has them. A session in a terminal has no `id` or `state`, and `waitingFor` only while it
// waits. The background one is there because agentbook-cli asks often only with one running or the page open.
// The terminal session's row: its status, and what it waits for while it does.
let terminal: { status: string; waitingFor?: string } = { status: "busy" };
function list() {
  const rows = [
    { pid: procs[TERMINAL].pid, cwd: project, kind: "interactive", startedAt: Date.now(), sessionId: TERMINAL, name: "app", ...terminal },
    { pid: procs[BACKGROUND].pid, id: BACKGROUND.slice(0, 8), cwd: project, kind: "background", state: "working", status: "busy", startedAt: Date.now(), sessionId: BACKGROUND, name: "app" },
  ];
  const tmp = path.join(FAKE, "agents.tmp");
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, path.join(FAKE, "agents.json"));
}
const lists = (status: string, waitingFor?: string) => {
  terminal = { status, ...(waitingFor ? { waitingFor } : {}) };
  list();
};
const seen = () => get(`/api/sessions/${TERMINAL}`);
const settled = (want: string) => until(async () => (await seen()).effective === want);
const heardBy = async (status: string) => until(async () => (await seen()).rt?.status === status);
list();

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 20000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  hook(BACKGROUND, "SessionStart", { source: "startup" });
  hook(BACKGROUND, "UserPromptSubmit", { prompt: "Keep agentbook asking" });
  hook(TERMINAL, "SessionStart", { source: "startup" });
  hook(TERMINAL, "UserPromptSubmit", { prompt: "Clean up the scratch folder" });
  check((await settled("working")) === true, "a session in a terminal on a turn is working");
  check(!!(await heardBy("busy")), "agentbook-cli lists it");

  // ---------- a prompt, for as long as it's up ----------
  lists("waiting", "permission prompt");
  hook(TERMINAL, "Notification", PROMPT);
  check((await seen()).effective === "needs", "a prompt in its terminal needs you");
  check(!!(await heardBy("waiting")), "and Claude Code lists it as waiting");
  await sleep(1000);
  const up = await seen();
  check(up.effective === "needs" && up.doing === "Claude needs your permission", "it needs you for as long as that's so");

  // ---------- it ends with no hook: answered there, or timed out and denied ----------
  lists("busy");
  check((await settled("working")) === true, "once Claude Code says the prompt is over, with no hook, it's working again");
  const on = await seen();
  check(on.state === "working" && on.busy === true && on.doing === "Carrying on", "and still on its turn");

  // ---------- a list that can't speak for the prompt ----------
  fs.writeFileSync(path.join(FAKE, "agents-fails"), "");
  await sleep(600); // an ask that was on its way has landed
  lists("waiting", "permission prompt");
  hook(TERMINAL, "Notification", PROMPT);
  await sleep(1000);
  check((await seen()).effective === "needs", "while the list fails, the old one (busy) doesn't end a prompt that came after it");
  fs.rmSync(path.join(FAKE, "agents-fails"));
  await heardBy("waiting");
  await sleep(600);
  check((await seen()).effective === "needs", "and it needs you once the list is back and says waiting");
  lists("busy");
  check((await settled("working")) === true, "until it says the prompt is over");

  // A list asked for before the prompt, landing after it (agentbook-cli busy, `claude agents` slow).
  fs.writeFileSync(path.join(FAKE, "agents-slow"), "2000");
  await sleep(400); // one is on its way, having seen "busy"
  lists("waiting", "permission prompt");
  hook(TERMINAL, "Notification", PROMPT);
  check((await seen()).effective === "needs", "a prompt with a list on its way needs you");
  await sleep(2800);
  check((await seen()).effective === "needs", "and that list, asked for before it, doesn't end it");
  fs.rmSync(path.join(FAKE, "agents-slow"));
  await sleep(2200); // the last slow one is in
  check((await seen()).effective === "needs", "nor does the next one, which says waiting");
  lists("busy");
  check((await settled("working")) === true, "the first list to say it's over does");

  // ---------- at no turn ----------
  hook(TERMINAL, "Stop", { stop_hook_active: false, last_assistant_message: "Done." });
  check((await settled("idle")) === true, "its turn ends");
  await heardBy("busy");
  lists("waiting", "dialog open");
  hook(TERMINAL, "Notification", PROMPT);
  check((await seen()).effective === "needs", "a prompt between turns needs you");
  await heardBy("waiting");
  lists("idle");
  check((await settled("idle")) === true, "and when it's over the session is idle, not working");

  // ---------- what's asked on agentbook ends with its answer ----------
  // As Claude Code does it: the hook as the prompt opens, the notification 6 seconds into it.
  const asking = hookAsync(BACKGROUND, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_1" });
  const asked = await until(async () => (await stateOf(get)).questions.find((q) => q.post === BACKGROUND && !q.answered));
  check(!!asked, "a background session asks on its thread");
  hook(BACKGROUND, "Notification", PROMPT);
  await sleep(800);
  const open = await get(`/api/sessions/${BACKGROUND}`);
  check(open.state === "waiting" && open.effective === "needs", "listed as busy, it waits on that question all the same");
  await post(`/api/questions/${asked.id}/answer`, { value: "allow" });
  check(JSON.parse((await asking) || "{}").hookSpecificOutput?.decision?.behavior === "allow", "the answer reaches Claude Code");
  check((await get(`/api/sessions/${BACKGROUND}`)).state === "working", "and it's working again");

  // A worker's hook carries agent_id; its prompt is asked on the thread all the same.
  const workerAsking = hookAsync(BACKGROUND, "PermissionRequest", { agent_id: "a1b2c3", agent_type: "web-fetch", tool_name: "WebFetch", tool_input: { url: "https://example.com/list", prompt: "List it" }, tool_use_id: "toolu_w1" });
  const workerAsked = await until(async () => (await stateOf(get)).questions.find((q) => q.post === BACKGROUND && !q.answered));
  check(workerAsked?.title === "Allow WebFetch?", "a background session's worker asks on its thread");
  if (workerAsked) await post(`/api/questions/${workerAsked.id}/answer`, { value: "allow" });
  check(JSON.parse((await workerAsking) || "{}").hookSpecificOutput?.decision?.behavior === "allow", "and the answer reaches the worker");

  // Allow + Auto: allowed, and the session switched to Auto with the same answer (Claude Code takes a hook's setMode).
  const autoAsking = hookAsync(BACKGROUND, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_a1" });
  const autoAsked = await until(async () => (await stateOf(get)).questions.find((q) => q.post === BACKGROUND && !q.answered));
  if (autoAsked) await post(`/api/questions/${autoAsked.id}/answer`, { value: "allow", mode: "auto" });
  const autoOut = JSON.parse((await autoAsking) || "{}").hookSpecificOutput?.decision;
  check(autoOut?.behavior === "allow" && JSON.stringify(autoOut.updatedPermissions) === JSON.stringify([{ type: "setMode", mode: "auto", destination: "session" }]), "Allow + Auto allows it and switches the session to Auto");
  const inAuto = (await stateOf(get)).sessions.find((x) => x.id === BACKGROUND);
  check(inAuto?.mode === "auto" && !inAuto.mode_pick, "and its thread says it's in Auto, with nothing left to switch as it wakes");
  const fullAsking = hookAsync(BACKGROUND, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "toolu_a2" });
  const fullAsked = await until(async () => (await stateOf(get)).questions.find((q) => q.post === BACKGROUND && !q.answered));
  if (fullAsked) await post(`/api/questions/${fullAsked.id}/answer`, { value: "allow", mode: "full" });
  const fullOut = JSON.parse((await fullAsking) || "{}").hookSpecificOutput?.decision;
  check(fullOut?.behavior === "allow" && !fullOut.updatedPermissions, "an answer can't switch it to Full access");
} finally {
  server.kill();
  for (const p of Object.values(procs)) p.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
