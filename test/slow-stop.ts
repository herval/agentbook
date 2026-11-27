#!/usr/bin/env node
// Waking an idle background session with what you sent, when Claude Code takes a while to stop it: it lists the
// session as stopped while its process is still on its way out, and a resume meanwhile starts a copy (a conversation
// and a thread of its own, with your message, and both carrying on in the same folder). agentbook waits for the
// process to be gone, so the session continues as itself.
// Run: node test/slow-stop.ts

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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-slow-stop-"));
const PORT = testPort(5100);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_SLEEP_AFTER_MIN: "0",
  AGENTBOOK_MAX_AWAKE: "0",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 5000) => {
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
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const agents = () => JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
const hook = (event, input, pid) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });

// One background session, idle between turns, the way `claude agents` lists it.
const ID = "bg-slow";
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: ID, sessionId: ID, kind: "background", state: "working", status: "idle", cwd: project, pid: 5000, name: ID }]));
fs.mkdirSync(path.join(HOME, "claude", "jobs", ID), { recursive: true });
fs.writeFileSync(path.join(HOME, "claude", "jobs", ID, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: ID, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));

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

  hook("SessionStart", { session_id: ID, source: "startup" }, 7000);
  hook("UserPromptSubmit", { prompt: "Work on it" }, 7000);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done. Which one?" }, 7000);
  check(!!(await until(async () => (await stateOf(get)).sessions.find((s) => s.id === ID && s.rt?.kind === "background" && !s.busy), 6000)), "a background session, idle between turns");

  // Its process takes a second and a half to exit once it's stopped.
  fs.writeFileSync(path.join(FAKE, "slow-stop.txt"), "1500");
  const mark = calls().length;
  const sent = Date.now();
  check((await post(`/api/sessions/${ID}/messages`, { text: "The second one" })).status < 300, "you write to it");
  const resumed = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume")), 10000);
  check(resumed?.args[0] === "The second one" && resumed.args[resumed.args.indexOf("--resume") + 1] === ID, "it's resumed with what you wrote");
  check(calls().slice(mark).findIndex((c) => c.args[0] === "stop" && c.args[1] === ID) >= 0, "its idle process stopped first");
  check(Date.now() - sent >= 1500, "after its process is gone, not as soon as it's listed as stopped");
  await sleep(500);
  check(agents().length === 1 && agents()[0].sessionId === ID && agents()[0].pid, "so it continues as itself: Claude Code started no copy");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
