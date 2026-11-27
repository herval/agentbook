#!/usr/bin/env node
// Background sessions sleep when nothing needs them: after a while without a turn, or early while too many
// run, but never one that's working or has work of its own going. Archiving one puts it to sleep whatever it
// has going (when its machine next connects, if Claude Code couldn't stop it then), and writing to a sleeping
// one wakes it.
// Run: node test/sleep.ts

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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sleep-"));
const PORT = testPort(4900);
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
  // Three awake at most, a second's grace, and asleep after twelve seconds without a turn.
  AGENTBOOK_MAX_AWAKE: "3",
  AGENTBOOK_SLEEP_GRACE_SEC: "1",
  AGENTBOOK_SLEEP_AFTER_MIN: "0.2",
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
const session = async (id) => (await stateOf(get)).sessions.find((s) => s.id === id);
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const stopped = (id) => calls().some((c) => c.args[0] === "stop" && c.args[1] === id);
const hook = (event, input, pid) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });

// Background sessions, the way `claude agents` lists them, each with its saved state. They're busy until
// each has run a turn.
const ids = ["bg-work", "bg-old", "bg-mid", "bg-new", "bg-busy"];
const list = (busy) => fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(ids.map((id, i) => ({ id, sessionId: id, kind: "background", state: "working", status: busy || id === "bg-busy" ? "busy" : "idle", cwd: project, pid: 5000 + i, name: id }))));
list(true);
// bg-work left a shell watching a CI run when its turn ended: Claude Code lists it by the id its step's result gave.
const WATCH_AT = Date.now() - 60e3;
for (const id of ids) {
  fs.mkdirSync(path.join(HOME, "claude", "jobs", id), { recursive: true });
  const inFlight = id === "bg-work" ? { tasks: 1, queued: 0, kinds: ["local_bash"] } : { tasks: 0, queued: 0, kinds: [] };
  const fan = id === "bg-work" ? [{ id: "bwatch1", kind: "shell", label: "gh run watch 123 --exit-status", startedAt: WATCH_AT }, { id: "todo:1", kind: "todo", label: "Ship it", startedAt: 0 }] : [];
  fs.writeFileSync(path.join(HOME, "claude", "jobs", id, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: id, inFlight, fan }));
}
const transcript = path.join(HOME, "bg-work.jsonl");
const at = new Date(WATCH_AT).toISOString();
fs.writeFileSync(
  transcript,
  [
    { type: "user", timestamp: at, message: { role: "user", content: "Work on bg-work" } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "gh run watch 123 --exit-status", description: "Watch the release run until it finishes", run_in_background: true } }] } },
    { type: "user", timestamp: at, toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "bwatch1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Command running in background with ID: bwatch1." }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);

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

  // Each finishes a turn, oldest first; the busy one is still on its turn.
  ids.forEach((id, i) => hook("SessionStart", { session_id: id, source: "startup" }, 7000 + i));
  for (const [i, id] of ids.entries()) {
    hook("UserPromptSubmit", { prompt: `Work on ${id}`, ...(id === "bg-work" ? { transcript_path: transcript } : {}) }, 7000 + i);
    if (id !== "bg-busy") hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." }, 7000 + i);
    await sleep(150);
  }
  list(false);
  check((await until(async () => (await stateOf(get)).sessions.filter((s) => s.rt?.kind === "background").length === ids.length, 6000)) === true, "five background sessions run, two more than the three allowed");

  // ---------- work going between turns: it's working on that ----------
  const going = await until(async () => {
    const s = await session("bg-work");
    return s?.going?.length && s;
  }, 6000);
  check(going?.effective === "working" && going.state === "idle" && !going.busy, "a session whose turn ended with a shell still going shows as working");
  check(going?.going?.length === 1 && going.going[0].title === "Watch the release run until it finishes" && going.going[0].kind === "shell" && going.going[0].started === new Date(WATCH_AT).toISOString(), "it says what's going, by its step's name and since when, without its to-dos");
  const shown = (await (await fetch(URL + "/api/show")).text()).split("\n");
  const row = shown.findIndex((l) => l.trim().startsWith(`${going?.label} `));
  check(row > 0 && /\sworking\s/.test(shown[row]) && /now, in the background: Watch the release run/.test(shown[row + 1]), "other sessions read it as working, on what");
  // A subagent going on after the turn: Claude Code keeps its tempo "active" then.
  const job = path.join(HOME, "claude", "jobs", "bg-work", "state.json");
  const saved = JSON.parse(fs.readFileSync(job, "utf8"));
  const sub = { id: "a5ub1", kind: "agent", label: "ledger chatty logs PR", startedAt: WATCH_AT };
  fs.writeFileSync(job, JSON.stringify({ ...saved, tempo: "active", inFlight: { tasks: 2, queued: 0, kinds: ["local_agent", "local_bash"] }, fan: [sub, ...saved.fan] }));
  const subGoing = await until(async () => {
    const s = await session("bg-work");
    return s?.going?.length === 2 && s;
  }, 6000);
  check(subGoing?.effective === "working" && subGoing.going.some((w) => w.kind === "agent" && w.title === "ledger chatty logs PR"), "so does one whose turn ended with a subagent still working, though Claude Code calls its tempo active");

  // ---------- too many running: the longest idle sleep early ----------
  await until(async () => (await session("bg-old"))?.asleep && (await session("bg-mid"))?.asleep, 8000);
  const old = await session("bg-old");
  check(stopped("bg-old") && stopped("bg-mid") && !stopped("bg-new"), "with more running than allowed, the longest idle sleep first, until three are left");
  check(old.asleep && old.state !== "done" && old.effective === "done" && /More than 3 threads/.test(old.sleep_reason), "a sleeping session's post shows as done but stays open, saying why it sleeps");
  check(!stopped("bg-work"), "the one with a background shell going stays up, though it's been idle longest");

  // ---------- idle a while: it sleeps ----------
  await until(async () => (await session("bg-new"))?.asleep, 20000);
  check(stopped("bg-new") && /^Idle for/.test((await session("bg-new")).sleep_reason), "an idle session sleeps after a while without a turn");
  check(!stopped("bg-busy") && (await session("bg-busy")).effective === "working", "a session on its turn never sleeps");
  check(!stopped("bg-work"), "nor does one with work of its own going");

  // ---------- writing wakes it ----------
  let mark = calls().length;
  await post("/api/sessions/bg-old/messages", { text: "Back to it" });
  const woke = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume") && c.args.includes("bg-old")), 8000);
  check(woke?.args[0] === "Back to it" && !calls().slice(mark).some((c) => c.args[0] === "stop"), "writing to a sleeping session wakes it with your message");
  hook("SessionStart", { session_id: "bg-old", source: "resume" }, 7100);
  check((await session("bg-old"))?.asleep === false, "awake again, its post says so");

  // ---------- archiving stops it, whatever it has going ----------
  mark = calls().length;
  const archived = await post("/api/sessions/bg-work/flag", { archived: true });
  const work = await session("bg-work");
  check(archived.status === 200 && archived.slept && stopped("bg-work") && work.asleep && work.archived && work.sleep_reason === "Archived", "archiving a session puts it to sleep, background work and all");

  // ---------- one archiving couldn't stop goes to sleep later ----------
  fs.writeFileSync(path.join(FAKE, "stop-fails"), "");
  const unstopped = await post("/api/sessions/bg-busy/flag", { archived: true });
  check(unstopped.status === 200 && !unstopped.slept && (await session("bg-busy"))?.asleep === false, "a session Claude Code couldn't stop stays up when it's archived");
  fs.rmSync(path.join(FAKE, "stop-fails"));
  await sleep(1500);
  check((await session("bg-busy"))?.asleep === false && calls().filter((c) => c.args[0] === "stop" && c.args[1] === "bg-busy").length === 1, "nothing keeps trying in the meantime");
  // Its machine connects again (agentbook-cli restarted, or the server did).
  const device = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "device.json"), "utf8"));
  await fetch(`${device.server}/api/cli/hello`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${device.token}` }, body: "{}" });
  const later = await until(async () => {
    const s = await session("bg-busy");
    return s?.asleep && s;
  }, 8000);
  check(later?.archived && later.sleep_reason === "Archived" && later.effective === "done", "when its machine connects again, it goes to sleep, so an archived thread doesn't wait on you in its own prompt");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
