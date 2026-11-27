#!/usr/bin/env node
// Queue for later while a background session works between turns: its turn ended with a shell still going (a push,
// a CI watch), which its page shows as working, so what you queue waits for that shell, and for the turn Claude
// Code wakes it in to hear back, rather than waking it now as a new turn.
// Run: node test/queue-going.ts

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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-queue-going-"));
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
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
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
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const session = async (id) => (await stateOf(get)).sessions.find((s) => s.id === id);
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resumed = (id, mark) => calls().slice(mark).find((c) => c.args.includes("--resume") && c.args.includes(id));
const hook = (event, input) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: "7300" }, encoding: "utf8", timeout: 15000 });

// One background session, idle between turns, with a push still going in the background.
const ID = "bg-push";
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: ID, sessionId: ID, kind: "background", state: "working", status: "idle", cwd: project, pid: 5300, name: ID }]));
const job = path.join(HOME, "claude", "jobs", ID, "state.json");
fs.mkdirSync(path.dirname(job), { recursive: true });
const PUSH_AT = Date.now() - 60e3;
const saved = (inFlight, fan) => fs.writeFileSync(job, JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: ID, inFlight, fan }));
saved({ tasks: 1, queued: 0, kinds: ["local_bash"] }, [{ id: "bpush1", kind: "shell", label: "git push origin release", startedAt: PUSH_AT }]);

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  hook("SessionStart", { session_id: ID, source: "startup" });
  hook("UserPromptSubmit", { prompt: "Push the release" });
  hook("Stop", { stop_hook_active: false, last_assistant_message: "The push is running its checks; I'll watch CI once it lands." });
  const going = await until(async () => {
    const s = await session(ID);
    return s?.going?.length && s;
  }, 6000);
  check(going && !going.busy && going.effective === "working", "its turn ended with the push still going: it shows as working, though not on a turn");

  // ---------- queued now, it waits for the push ----------
  let mark = calls().length;
  const held = await post(`/api/sessions/${ID}/messages`, { text: "then cut the release notes", queue: true });
  check(held.status === 200 && held.held, "what you queue while it has work going between turns is held");
  const queued = async () => (await get(`/api/sessions/${ID}`)).messages.filter((m) => m.queued).map((m) => m.text);
  check(JSON.stringify(await queued()) === JSON.stringify(["then cut the release notes"]), "it's on the thread as queued");
  await sleep(1500);
  check(!resumed(ID, mark) && (await queued()).length === 1, "it doesn't wake the session while the push goes on");

  // ---------- the push ends: Claude Code wakes it to hear back, and the message goes in after that turn ----------
  saved({ tasks: 0, queued: 0, kinds: [] }, []);
  hook("UserPromptSubmit", { prompt: '<task-notification>\n<task-id>bpush1</task-id>\n<status>completed</status>\n</task-notification>' });
  await sleep(800);
  check(!resumed(ID, mark) && (await queued()).length === 1, "still held through the turn it hears back in");
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Pushed. CI is green." });
  const woke = await until(() => resumed(ID, mark), 8000);
  check(woke?.args[0] === "then cut the release notes", "it goes in once that turn ends, as its next prompt");
  check((await queued()).length === 0, "and leaves the queue");

  // ---------- sent now, it goes at once, as before ----------
  saved({ tasks: 1, queued: 0, kinds: ["local_bash"] }, [{ id: "bwatch2", kind: "shell", label: "gh run watch 9 --exit-status", startedAt: Date.now() }]);
  hook("SessionStart", { session_id: ID, source: "resume" });
  hook("UserPromptSubmit", { prompt: "then cut the release notes" });
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Watching CI." });
  fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: ID, sessionId: ID, kind: "background", state: "working", status: "idle", cwd: project, pid: 5301, name: ID }]));
  await until(async () => (await session(ID))?.going?.length, 6000);
  mark = calls().length;
  const now = await post(`/api/sessions/${ID}/messages`, { text: "and tag it v2" });
  check(now.status === 200 && !now.held, "Send now while it has work going isn't held");
  check((await until(() => resumed(ID, mark), 8000))?.args[0] === "and tag it v2", "it wakes the session with it at once");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
