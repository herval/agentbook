#!/usr/bin/env node
// Stop, and a thread that looks frozen after it: Claude Code runs no hook for an interrupted turn and goes on listing
// a session with a shell running as busy, so the thread goes by the session's transcript, whoever pressed Esc. What
// you send then reaches it. One Esc doesn't reach gets Force stop, which ends its process and keeps the thread.
// Run: node test/stop.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTranscripts } from "../plugin/cli/transcript.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-stop-"));
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
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "shop");
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
const get = async (p: string): Promise<Json> => {
  const r = await call(p);
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const callsFile = path.join(FAKE, "calls.jsonl");
const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resumes = (id, from = 0) => calls().slice(from).filter((c) => c.args.includes("--resume") && c.args.includes(id));
const pressed = (id, from = 0) => calls().slice(from).some((c) => c.args[0] === "esc" && c.args[1] === id);
const stops = (id, from = 0) => calls().slice(from).filter((c) => c.args[0] === "stop" && c.args[1] === id);
const hook = (event, input, pid) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
const thread = async (id) => (await stateOf(get)).sessions.find((s) => s.id === id);
const agents = () => JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
const setAgent = (id, change) => fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(agents().map((a) => (a.id === id ? change(a) : a))));
const flag = (name, on) => (on ? fs.writeFileSync(path.join(FAKE, name), "") : fs.rmSync(path.join(FAKE, name), { force: true }));

// Sessions the way `claude agents` lists them: in the background, and in a terminal.
const row = (id, pid, kind = "background") => ({ id, sessionId: id, kind, state: "working", status: "busy", cwd: project, pid, name: id });
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([row("shell", 5000), row("esc", 5001), row("hung", 5002), row("term", 5003, "interactive")]));
for (const id of ["shell", "esc", "hung", "term"]) {
  fs.mkdirSync(path.join(HOME, "claude", "jobs", id), { recursive: true });
  fs.writeFileSync(path.join(HOME, "claude", "jobs", id, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: id, inFlight: { tasks: 1, kinds: ["local_bash"] } }));
}
const transcriptOf = (id) => path.join(HOME, "transcripts", `${id}.jsonl`);
fs.mkdirSync(path.join(HOME, "transcripts"));
const line = (id, e) => fs.appendFileSync(transcriptOf(id), JSON.stringify({ timestamp: new Date().toISOString(), sessionId: id, cwd: project, ...e }) + "\n");
const prompt = (id, text) => line(id, { type: "user", message: { role: "user", content: text } });
const interrupted = (id, tool = false) => line(id, { type: "user", message: { role: "user", content: [{ type: "text", text: `[Request interrupted by user${tool ? " for tool use" : ""}]` }] } });
// A turn, as Claude Code goes through one. `proc`: which of its processes.
function startTurn(id, proc, text = "Work on the shop") {
  prompt(id, text);
  hook("UserPromptSubmit", { session_id: id, prompt: text, transcript_path: transcriptOf(id) }, proc);
}

// ---------- what a transcript says, by itself ----------
{
  const file = path.join(HOME, "transcripts", "unit.jsonl");
  const s = { id: "unit", transcript: file, cwd: project };
  const entry = (e) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + "\n");
  const say = (text) => entry({ type: "user", message: { role: "user", content: text } });
  say("First");
  const t = createTranscripts();
  check(t.interrupted(s) === null, "a turn that wasn't cut off isn't");
  const turns = t.digest(s).turn;
  entry({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  check(!!t.interrupted(s), "Esc in a reply shows, read on the spot");
  check(t.digest(s).turn === turns, "and starts no turn, though it looks like a prompt");
  say("Next");
  check(t.interrupted(s) === null, "a new prompt ends that");
  entry({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
  check(!!t.interrupted(s), "Esc in a tool shows too");
  say("Next");
  say("Why does it say [Request interrupted by user] here?");
  check(t.interrupted(s) === null, "someone writing those words isn't Esc");
  entry({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  check(t.interrupted(s) === null, "nor is a subagent's");
}

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- Stop worked, the screen didn't show it, and a shell keeps it busy ----------
  hook("SessionStart", { session_id: "shell", source: "startup", transcript_path: transcriptOf("shell") }, 7000);
  startTurn("shell", 7000);
  setAgent("shell", (a) => ({ ...a, shell: true, transcript: transcriptOf("shell") }));
  await until(async () => (await thread("shell"))?.busy);
  flag("esc-silent", true);
  let mark = calls().length;
  const stopped = await post("/api/sessions/shell/stop", {});
  flag("esc-silent", false);
  let s = await thread("shell");
  check(stopped.status === 200 && pressed("shell", mark), "Stop presses Esc and says it stopped, though the screen didn't show it");
  check(!s.busy && s.effective === "idle" && /Stopped/.test(s.doing), "the thread goes by its transcript: idle, waiting for you");
  check(agents().find((a) => a.id === "shell").status === "busy" && !stops("shell", mark).length, "with Claude Code still saying busy, and its process left alone");
  mark = calls().length;
  await post("/api/sessions/shell/messages", { text: "merge this" });
  check(!!(await until(() => resumes("shell", mark)[0])), "what you send reaches it");
  check(resumes("shell", mark)[0]?.args[0] === "merge this", "as its next prompt");

  // A thread that's idle with a shell going has nothing to stop, whatever Claude Code calls it.
  hook("SessionStart", { session_id: "shell", source: "resume", transcript_path: transcriptOf("shell") }, 7001);
  startTurn("shell", 7001, "merge this");
  setAgent("shell", (a) => ({ ...a, pid: 5100, state: "working", status: "busy", shell: true, transcript: transcriptOf("shell") }));
  hook("Stop", { session_id: "shell", stop_hook_active: false, last_assistant_message: "Merged." }, 7001);
  await until(async () => !(await thread("shell"))?.busy);
  mark = calls().length;
  const nothing = await post("/api/sessions/shell/stop", {});
  check(nothing.status === 409 && !pressed("shell", mark), "an idle thread with a shell going has nothing to stop");

  // ---------- Esc in a terminal, which agentbook hears of from the transcript alone ----------
  hook("SessionStart", { session_id: "esc", source: "startup", transcript_path: transcriptOf("esc") }, 7002);
  startTurn("esc", 7002);
  await until(async () => (await thread("esc"))?.busy);
  await post("/api/sessions/esc/messages", { text: "after that, the docs", queue: true });
  mark = calls().length;
  interrupted("esc", true);
  s = await until(async () => {
    const t = await thread("esc");
    return !t.busy && t;
  });
  check(!!s && s.effective === "idle" && /Stopped/.test(s.doing), "Esc in a terminal ends the turn on the thread, by its transcript alone");
  check(s?.queue_paused === "stopped" && !resumes("esc", mark).length, "and its queue waits for you, as with Stop");
  await post("/api/sessions/esc/queue", { op: "resume" });

  // An interrupt from before a turn says nothing about it.
  await until(() => resumes("esc", mark)[0]);
  hook("SessionStart", { session_id: "esc", source: "resume", transcript_path: transcriptOf("esc") }, 7003);
  setAgent("esc", (a) => ({ ...a, pid: 5101, state: "working", status: "busy" }));
  hook("UserPromptSubmit", { session_id: "esc", prompt: "Go on", transcript_path: transcriptOf("esc") }, 7003);
  await until(async () => (await thread("esc"))?.busy);
  line("esc", { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Going on." }] } });
  await sleep(1500);
  check((await thread("esc")).busy, "an old interrupt doesn't end the turn after it");

  // ---------- one Esc doesn't reach: Force stop ----------
  hook("SessionStart", { session_id: "hung", source: "startup", transcript_path: transcriptOf("hung") }, 7004);
  startTurn("hung", 7004);
  setAgent("hung", (a) => ({ ...a, transcript: transcriptOf("hung") }));
  await until(async () => (await thread("hung"))?.busy);
  flag("esc-ignored", true);
  mark = calls().length;
  const hung = await post("/api/sessions/hung/stop", {});
  check(hung.status === 500 && hung.force === true && /Force stop/.test(hung.error) && !/terminal/.test(hung.error), "Stop that doesn't work offers Force stop, not a terminal");
  check(pressed("hung", mark) && !stops("hung", mark).length, "having pressed Esc, and left its process alone");
  check((await thread("hung")).busy, "the thread goes on saying it's working, as it is");
  await post("/api/sessions/hung/messages", { text: "are you there?" });
  await sleep(600);
  check(!resumes("hung", mark).length, "what you send waits, as it can't take it");

  // Force stop. Its process takes a moment to go, and resuming it before that would start a copy.
  fs.writeFileSync(path.join(FAKE, "slow-stop.txt"), "1500");
  const before = agents().length;
  const forced = await post("/api/sessions/hung/stop", { force: true });
  s = await thread("hung");
  check(forced.status === 200 && stops("hung", mark).length === 1, "Force stop ends its process");
  check(s.asleep && !s.busy && /Force-stopped/.test(s.sleep_reason), "the thread stays, asleep, and says why");
  check(!!(await until(() => resumes("hung", mark)[0])), "and what was waiting resumes it");
  check(resumes("hung", mark)[0]?.args[0] === "are you there?", "as its next prompt");
  check(agents().length === before, "once its old process is gone, so it isn't a copy");
  flag("esc-ignored", false);

  // ---------- what it isn't for ----------
  hook("SessionStart", { session_id: "term", source: "startup" }, 7005);
  hook("UserPromptSubmit", { session_id: "term", prompt: "Look at the shop" }, 7005);
  check((await post("/api/sessions/term/stop", { force: true })).status === 409 && !stops("term").length, "Force stop leaves a session in a terminal alone");
} finally {
  server.kill();
  await sleep(200);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
