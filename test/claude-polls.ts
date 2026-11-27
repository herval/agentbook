#!/usr/bin/env node
// `claude agents` is a whole Claude Code starting and ending, and thousands of those a day are the prime suspect for
// lost logins, so it runs often only while something depends on its answer: an awake background thread. A thread in a
// terminal reports through its hooks. Each run also stays off the network.
// Run: node test/claude-polls.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-polls-"));
const PORT = testPort(4980);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const RUNS = path.join(FAKE, "runs.txt");
const CLAUDE = path.join(FAKE, "claude");
fs.writeFileSync(CLAUDE, `#!/bin/sh\necho "$1 \${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-off}" >> "${RUNS}"\nexec "${process.execPath}" "${path.join(TEST, "fake-claude.ts")}" "$@"\n`, { mode: 0o755 });
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: CLAUDE,
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "200",
  AGENTBOOK_RUNTIME_IDLE_MS: "8000",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID"]) delete env[k];
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
const get = async (p: string): Promise<Json> => (await fetch(URL + p, { headers: { cookie: COOKIE } })).json();
const session = async (id: string) => (await stateOf(get)).sessions.find((s) => s.id === id);
const hook = (event: string, input: object, pid: number) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
const listed = (rows) => fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(rows));
const row = (id, kind, extra = {}) => ({ id, sessionId: id, kind, state: "working", status: "idle", pid: process.pid, cwd: project, startedAt: Date.now(), ...extra });
const listings = () => (fs.existsSync(RUNS) ? fs.readFileSync(RUNS, "utf8").split("\n").filter((l) => l.startsWith("agents ")) : []);
const runsIn = async (ms) => {
  const from = listings().length;
  await sleep(ms);
  return listings().length - from;
};

listed([]);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  await until(() => listings().length > 0);
  check(listings().length > 0, "it asks once as it starts, which is how Claude Code gets on the machine's agents");
  await sleep(1200);
  const quiet = await runsIn(1500);
  check(quiet === 0, `with no thread, it doesn't ask again (${quiet} runs in 1.5 s)`);

  // ---------- a terminal: hooks say what happens ----------
  listed([row("term", "interactive")]);
  hook("SessionStart", { session_id: "term", source: "startup" }, 8001);
  hook("UserPromptSubmit", { session_id: "term", prompt: "Work in a terminal" }, 8001);
  hook("Stop", { session_id: "term", stop_hook_active: false, last_assistant_message: "Done." }, 8001);
  check((await until(async () => (await session("term"))?.rt?.kind === "interactive")) === true, "a session it hadn't heard of is listed as soon as it says hello, so the page knows it's in a terminal");
  await sleep(1200);
  const terminal = await runsIn(1500);
  check(terminal === 0, `a thread in a terminal needs no asking, page or no page (${terminal} runs in 1.5 s)`);

  // ---------- in the background: nothing else says when it ends ----------
  listed([row("term", "interactive"), row("bg", "background")]);
  hook("SessionStart", { session_id: "bg", source: "startup" }, 8002);
  hook("UserPromptSubmit", { session_id: "bg", prompt: "Work in the background" }, 8002);
  hook("Stop", { session_id: "bg", stop_hook_active: false, last_assistant_message: "Done." }, 8002);
  check((await until(async () => (await session("bg"))?.rt?.kind === "background")) === true, "a background session is listed the same way");
  const background = await runsIn(1500);
  check(background >= 4, `an awake background thread is asked about every few seconds (${background} runs in 1.5 s)`);

  listed([row("term", "interactive"), row("bg", "background", { state: "stopped", pid: null })]);
  check((await until(async () => (await session("bg"))?.asleep)) === true, "which is how its end is seen");
  await sleep(600);
  const asleep = await runsIn(1500);
  check(asleep === 0, `and once it's asleep the asking stops (${asleep} runs in 1.5 s)`);

  // ---------- now and then ----------
  const later = await runsIn(8500);
  check(later >= 1 && later <= 2, `otherwise it asks now and then, to see Claude Code update itself (${later} runs in 8.5 s, at one every 8 s)`);
  check(listings().every((l) => l === "agents 1"), "every listing stays off the network, so it can't start a token's renewal");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
