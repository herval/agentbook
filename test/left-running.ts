#!/usr/bin/env node
// What a session that isn't a background one (a terminal's, Claude Desktop's, VS Code's) left running in the
// background shows on its thread: Claude Code keeps no list of it for those, so it's read from the transcript, from
// the command or monitor that started until the notice that it stopped, the call that stopped it, or the session's end.
// And one whose output this machine has (Claude Code's file for it) shows what it printed, and can be stopped from
// its row: its processes end, nothing else's, and its agent hears who stopped it.
// Run: node test/left-running.ts

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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-left-running-"));
const PORT = testPort(4500);
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
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  AGENTBOOK_RUNTIME_MS: "300",
  CLAUDE_CODE_TMPDIR: path.join(HOME, "tmp"),
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
const until = async <T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> => {
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
const session = async (id: string) => (await stateOf(get)).sessions.find((s) => s.id === id);

// One session in Claude Desktop: listed as interactive, with no saved state of its own.
const ID = "desk-deps";
const T = path.join(HOME, `${ID}.jsonl`);
const listed = (pid = 5400) => fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ sessionId: ID, kind: "interactive", status: "idle", cwd: project, pid, name: ID }]));
listed();
const hook = (event: string, input: object) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, session_id: ID, transcript_path: T, ...input }), env: { ...env, AGENTBOOK_PID: "7400" }, encoding: "utf8", timeout: 15000 });
const write = (...entries) => fs.appendFileSync(T, entries.map((e) => JSON.stringify({ sessionId: ID, cwd: project, timestamp: new Date().toISOString(), ...e }) + "\n").join(""));
const prompt = (text) => write({ type: "user", message: { role: "user", content: text } });
const use = (id, name, input) => write({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id, toolUseResult) => write({ type: "user", toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const notice = (task, id, status, more = "") => write({ type: "queue-operation", operation: "enqueue", content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n${status ? `<status>${status}</status>\n` : ""}<summary>Background command</summary>${more}\n</task-notification>` });
const turn = (text, steps, said) => {
  hook("UserPromptSubmit", { prompt: text });
  prompt(text);
  steps();
  write({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
  hook("Stop", { stop_hook_active: false, last_assistant_message: said });
};
const going = async () => (await session(ID))?.going || [];
const titles = async () => (await going()).map((x) => `${x.kind}:${x.title}`).join(" | ");

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  hook("SessionStart", { source: "startup" });
  turn(
    "Merge the safe ones",
    () => {
      use("tu1", "Bash", { command: "sleep 420; gh pr list", description: "Check which pull requests merged", run_in_background: true });
      result("tu1", { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bwait1" });
    },
    "I'll report once the check finishes.",
  );
  const s = await until(async () => {
    const x = await session(ID);
    return x?.going?.length && x;
  });
  check(s && !s.busy && s.effective === "working", "its turn ended with a command still running: the thread shows as working, though not on a turn");
  check(s?.going.length === 1 && s.going[0].kind === "shell" && s.going[0].title === "Check which pull requests merged" && !!s.going[0].started, "the command is named as its step was, with when it started");

  const held = await post(`/api/sessions/${ID}/messages`, { text: "then tell me which are left", queue: true });
  check(held.status === 200 && held.held, "what you queue meanwhile waits for it, as in a background session");

  // ---------- news of it isn't its end ----------
  notice("bwait1", "tu1", "", " is still running after 30m");
  await sleep(1200);
  check((await going()).length === 1, "a notice that it's still running leaves it going");

  // ---------- its end: Claude Code tells the session, in a turn of its own ----------
  notice("bwait1", "tu1", "completed");
  turn("<task-notification>\n<task-id>bwait1</task-id>\n<status>completed</status>\n</task-notification>", () => {}, "Six merged.");
  check((await until(async () => !(await going()).length)) === true, "once Claude Code says it stopped, nothing's going");

  // ---------- two at once, a monitor among them; one stopped by the session itself ----------
  turn(
    "Watch the rest",
    () => {
      use("tu2", "Bash", { command: "gh run watch 9", description: "Wait for the CI run", run_in_background: true });
      result("tu2", { stdout: "", stderr: "", backgroundTaskId: "bwatch2" });
      use("tu3", "Monitor", { command: "tail -f all.log", description: "failures in all.log", timeout_ms: 1800000 });
      result("tu3", { taskId: "bmon3", timeoutMs: 1800000, persistent: false });
      use("tu4", "Monitor", { command: "tail -f old.log", description: "an old log", timeout_ms: 1000 });
      result("tu4", { taskId: "bmon4", timeoutMs: 1000, persistent: false });
    },
    "Watching.",
  );
  await sleep(1100);
  check((await until(async () => (await titles()) === "shell:Wait for the CI run | monitor:Watch failures in all.log" && true)) === true, "a command and a monitor both show, and a monitor past its timeout doesn't");
  notice("bmon3", "tu3", "", "<event>FAIL one</event>");
  turn(
    "<task-notification>\n<task-id>bmon3</task-id>\n<event>FAIL one</event>\n</task-notification>",
    () => {
      use("tu5", "TaskStop", { task_id: "bwatch2" });
      result("tu5", { message: "Successfully stopped task: bwatch2", task_id: "bwatch2", task_type: "local_bash", command: "gh run watch 9" });
    },
    "Stopped the watch.",
  );
  check((await until(async () => (await titles()) === "monitor:Watch failures in all.log" && true)) === true, "a monitor's event leaves it going, and the command the session stopped itself is gone");

  // ---------- one whose output is on this machine: read, and stopped, from its row ----------
  // Claude Code's file for it, where it keeps them, held open by the command's own process group.
  const TASKS = path.join(HOME, "tmp", `claude-${process.getuid()}`, path.basename(HOME), ID, "tasks");
  fs.mkdirSync(TASKS, { recursive: true });
  const OUT = path.join(TASKS, "bserve9.output");
  const fd = fs.openSync(OUT, "w");
  const served = spawn("/bin/sh", ["-c", "printf 'booting\\n\\033[32mready\\033[0m on :3000\\n'; sleep 300 & wait"], { detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  served.unref();
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  turn(
    "Start the app",
    () => {
      use("tu6", "Bash", { command: "npm run dev", description: "Start the app locally", run_in_background: true });
      result("tu6", { stdout: "", stderr: "", backgroundTaskId: "bserve9" });
    },
    "It's up on :3000.",
  );
  const rows = await until(async () => {
    const g = await going();
    return g.some((x) => x.id === "bserve9") && g;
  });
  const row = (rows || []).find((x) => x.id === "bserve9");
  check(row?.out === true && (rows || []).find((x) => x.kind === "monitor")?.out !== true, "its row says its output can be read; the monitor's, with no file here, doesn't");
  const printed = await get(`/api/sessions/${ID}/going/bserve9/output`);
  check(printed.text === "booting\nready on :3000\n" && printed.cut === false && !!printed.at, "what it printed reads as a terminal would show it, colors gone");
  check((await call(`/api/sessions/${ID}/going/nope/output`)).status === 404 && (await call(`/api/sessions/${ID}/going/..%2Fx/output`)).status === 404, "one it doesn't have going reads nothing");
  const mon = (rows || []).find((x) => x.kind === "monitor");
  check((await post(`/api/sessions/${ID}/going/${mon?.id}/stop`, {})).status === 409, "one whose process this machine can't find isn't stopped from here");
  check(!gone(served.pid) && !gone(server.pid), "nothing has been stopped so far");
  const stopped = await post(`/api/sessions/${ID}/going/bserve9/stop`, {});
  check(stopped.status === 200 && (await until(() => gone(served.pid), 6000)) === true, "Stop ends its processes");
  check(!gone(server.pid), "and nothing else's");
  const inbox = hook("UserPromptSubmit", { prompt: "what happened?" });
  check(/@tester stopped the command you left running in the background \("Start the app locally"\) from agentbook\. It didn't crash/.test(`${inbox.stdout}`), "its agent hears who stopped it, and that it wasn't a crash");
  check((await post(`/api/sessions/${ID}/going/bserve9/stop`, {})).status === 409, "stopped again, there's nothing to stop");
  notice("bserve9", "tu6", "killed");
  turn("<task-notification>\n<task-id>bserve9</task-id>\n<status>killed</status>\n</task-notification>", () => {}, "Noted.");
  check((await until(async () => !(await going()).some((x) => x.id === "bserve9"))) === true, "and once Claude Code says it ended, its row is gone");

  // ---------- the session over: nothing would hear the rest finish ----------
  hook("SessionEnd", { reason: "other" });
  check((await until(async () => (await session(ID))?.state === "done" && !(await going()).length)) === true, "once the session has ended, nothing's going");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
