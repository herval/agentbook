#!/usr/bin/env node
// Sending on the side: what you write on a Claude Code thread goes to a side thread, a new
// session Claude Code forks from the thread's conversation (`--resume <id> --fork-session --bg`), in its folder, on its
// model, while the thread works on, untouched: not stopped, not told, not folded into it. The side thread is a thread of
// its own, started from that one, its prompt yours, and its steps only its own (its transcript starts with a copy of the
// other's). The thread shows what you sent with the side thread under it, and its latest reply once it has one.
// Run: node test/side-threads.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { createTranscripts } from "../plugin/cli/transcript.ts";
import { createStore, publicState } from "../plugin/shared/store.ts";
import { needsSignature, SIGNED_KINDS } from "../plugin/shared/signed.ts";
import { checkCommand } from "../plugin/shared/protocol.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-side-"));
const PORT = testPort(5400);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
const CONFIG = path.join(HOME, "claude");
fs.mkdirSync(FAKE, { recursive: true });
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
  CLAUDE_CONFIG_DIR: CONFIG,
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
const until = async <T>(fn: () => T | Promise<T>, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

// Transcript entries the way Claude Code writes them: a prompt, a tool call and its result, what it said.
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const prompt = (uuid, text, at) => ({ type: "user", uuid, timestamp: at, message: { role: "user", content: text } });
const tool = (uuid, id, title, at) => ({ type: "assistant", uuid, timestamp: at, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: "true", description: title } }] } });
const result = (uuid, id, at) => ({ type: "user", uuid, timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const say = (uuid, text, at) => ({ type: "assistant", uuid, timestamp: at, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const fileOf = (sid) => path.join(CONFIG, "projects", "-app", `${sid}.jsonl`);
const write = (sid, ...entries) => {
  fs.mkdirSync(path.dirname(fileOf(sid)), { recursive: true });
  fs.appendFileSync(fileOf(sid), entries.map((e) => JSON.stringify({ sessionId: sid, ...e })).join("\n") + "\n");
  return fileOf(sid);
};

// ---------- the transcript: a side thread's steps are its own ----------
{
  const MAIN = "t-main";
  const SIDE = "t-side";
  write(MAIN, { type: "ai-title", aiTitle: "Fix the checks" }, prompt("u1", "Fix the failing checks", ago(60)), tool("a1", "toolu_m1", "Run the tests", ago(59)), result("r1", "toolu_m1", ago(58)), say("a2", "Two fail.", ago(57)));
  // Forked: the other's entries, ids and times kept, then its own.
  const since = ago(10);
  fs.writeFileSync(fileOf(SIDE), fs.readFileSync(fileOf(MAIN), "utf8").replaceAll(MAIN, SIDE));
  write(SIDE, prompt("u9", "Is it the clock?", ago(5)), tool("a9", "toolu_s1", "Read the clock fixture", ago(4)), result("r9", "toolu_s1", ago(3)), say("a10", "It's the fixture.", ago(2)));
  const t = createTranscripts();
  const titles = (d) => d.steps.filter((x) => x.kind === "tool").map((x) => x.title);
  const d = t.digest({ id: SIDE, transcript: fileOf(SIDE), side_at: since });
  check(titles(d).join() === "Read the clock fixture" && !d.ai_title, "a side thread's steps start at its own prompt: none of the thread it came from, nor its title");
  check(d.turn === 1, "and its turns count from there");
  const before = t.digest({ id: "t-side-2", transcript: fileOf(SIDE) });
  check(titles(before).join() === "Run the tests,Read the clock fixture", "read before it's known as a side thread, it has both");
  const after = t.digest({ id: "t-side-2", transcript: fileOf(SIDE), side_at: since });
  check(after !== before && titles(after).join() === "Read the clock fixture", "and once it is, it's read again from the start");
  check(titles(t.digest({ id: MAIN, transcript: fileOf(MAIN) })).join() === "Run the tests", "the thread it came from has its own");
}

// ---------- the store: a side launch links its thread when it arrives ----------
{
  const store = createStore({ file: path.join(HOME, "store", "agentbook.db"), filesDir: path.join(HOME, "store", "files"), legacy: false });
  const hello = (sid, pid) => store.ingest({ t: "session.hello", proc: `box-${pid}`, session_id: sid, agent: "claude", agent_name: "Claude", kind: "claude-code", label: "gull", cwd: project, transcript: `/t/${sid}.jsonl` });
  hello("main-1", 1);
  store.ingest({ t: "launch.add", lid: "l1", agent: "claude", root: project, prompt: "Is it the clock?", named: true, side_of: "main-1" });
  store.ingest({ t: "message.add", post: "main-1", mid: "m1", from: "human", via: "side", text: "Is it the clock?", launch: "l1" });
  check(!store.state.outbox.some((o) => o.post === "main-1"), "what you sent on the side never goes to the thread's session");
  check(store.state.messages.find((m) => m.id === "m1")?.launch === "l1", "it keeps the side thread's launch");
  hello("side-1", 2);
  store.ingest({ t: "launch.started", lid: "l1", session: "side-1" });
  const side = store.state.sessions["side-1"];
  check(side?.started_from === "main-1" && side.side_at === store.state.launches.l1.at && side.launch === "l1", "the side thread is started from it, its own from when it was sent");
  check(store.state.sessions["main-1"].session_id === "main-1" && !store.state.sessions["main-1"].copies, "and the thread keeps its own session: nothing folds");
  // A thread whose turn ended asking you something still asks it after you send on the side.
  store.ingest({ t: "session.shape", post: "main-1", shape: { verdict: { kind: "needs_you", line: "Merge it?" } } });
  store.ingest({ t: "message.add", post: "main-1", mid: "m2", from: "agent", text: "Merge it?" });
  store.ingest({ t: "session.status", post: "main-1", state: "idle", turn: "end" });
  const asked = () => publicState(store.state).sessions.find((x) => x.id === "main-1");
  const before = asked();
  store.ingest({ t: "message.add", post: "main-1", mid: "m3", from: "human", via: "side", text: "Meanwhile, check the logs", launch: "l2" });
  check(before.effective === "needs" && asked().effective === "needs" && asked().asking?.line === "Merge it?", "sending on the side doesn't answer what the thread asked");
  store.close();
}

// ---------- signed and checked like a message ----------
check(SIGNED_KINDS.includes("post.side") && needsSignature({ kind: "post.side", args: { post: "p", text: "x" } }), "a side thread needs its owner's signature, as a message does");
check(checkCommand({ kind: "post.side", args: { post: "p", text: "x", command: "status" } }) !== null, "and takes no slash command");

// ---------- the daemon and the server ----------
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
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const hook = (event, input, pid) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });

const ID = "bg-main-0000-4000-8000-000000000001";
const SIDE = "bg-side-0000-4000-8000-000000000002";
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: ID.slice(0, 8), sessionId: ID, kind: "background", state: "working", status: "busy", cwd: project, pid: 5000, name: "main" }]));
fs.mkdirSync(path.join(CONFIG, "jobs", ID.slice(0, 8)), { recursive: true });
fs.writeFileSync(path.join(CONFIG, "jobs", ID.slice(0, 8), "state.json"), JSON.stringify({ state: "working", tempo: "active", respawnFlags: ["--settings", "{}", "--model", "opus", "--effort", "high"], sessionId: ID, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));

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

  // A background thread, mid-turn.
  const T = write(ID, prompt("u1", "Fix the failing checks", ago(60)), tool("a1", "toolu_m1", "Run the tests", ago(59)), result("r1", "toolu_m1", ago(58)));
  hook("SessionStart", { session_id: ID, source: "startup", transcript_path: T }, 7000);
  hook("UserPromptSubmit", { prompt: "Fix the failing checks" }, 7000);
  check(!!(await until(async () => (await stateOf(get)).sessions.find((s) => s.id === ID && s.busy))), "a background thread, working");

  check((await post(`/api/sessions/${ID}/messages`, { text: "/status", side: true })).status === 400, "a slash command doesn't go on the side");
  fs.writeFileSync(path.join(FAKE, "next.txt"), SIDE);
  const mark = calls().length;
  const sent = await post(`/api/sessions/${ID}/messages`, { text: "Check whether the flaky one is the clock", side: true });
  check(sent.status === 200 && !!sent.lid, "you send on the side, and get its launch");
  const fork = await until(() => calls().slice(mark).find((c) => c.args.includes("--fork-session")));
  const a = fork?.args || [];
  check(a[0] === "Check whether the flaky one is the clock" && a[a.indexOf("--resume") + 1] === ID && a.includes("--bg"), "Claude Code forks the thread's session with what you wrote");
  check(fork?.cwd === fs.realpathSync(project) || fork?.cwd === project, "in the thread's folder");
  check(a[a.indexOf("--model") + 1] === "opus" && a[a.indexOf("--effort") + 1] === "high" && a.includes("--settings"), "on the model and effort it was saved with, working where it is");
  check(!calls().slice(mark).some((c) => c.args[0] === "stop"), "and the thread isn't stopped for it");

  // The fork says hello, takes its prompt, works and answers.
  const ST = await until(() => fs.existsSync(fileOf(SIDE)) && fileOf(SIDE));
  check(!!ST && fs.readFileSync(ST, "utf8").includes('"uuid":"a1"'), "its transcript starts with the thread's conversation");
  await sleep(20);
  write(SIDE, prompt("u9", "Check whether the flaky one is the clock", new Date().toISOString()), tool("a9", "toolu_s1", "Read the clock fixture", new Date().toISOString()), result("r9", "toolu_s1", new Date().toISOString()));
  hook("SessionStart", { session_id: SIDE, source: "resume", transcript_path: ST }, 7100);
  hook("UserPromptSubmit", { prompt: "Check whether the flaky one is the clock" }, 7100);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "It's the clock: the fixture pins it to UTC.\n\nThe rest is fine." }, 7100);

  const st = await until(async () => {
    const x = await stateOf(get);
    return x.sessions.some((s) => s.id === SIDE && s.started_from === ID && !s.busy) ? x : null;
  });
  check(!!st, "the side thread is a thread of its own, started from the thread");
  const main = st?.sessions.find((s) => s.id === ID);
  check(main?.session_id === ID && main.busy, "the thread goes on in its own session, still working");
  const side = st?.sessions.find((s) => s.id === SIDE);
  check(!!side?.side_at && side.prompt === "Check whether the flaky one is the clock", "its prompt is what you wrote");
  const steps = await until(async () => {
    const v = await get(`/api/sessions/${SIDE}/steps`);
    return v.steps?.some((x) => x.title === "Read the clock fixture") ? v : null;
  });
  check(!!steps && !steps.steps.some((x) => x.title === "Run the tests"), "its steps are its own, not the thread's");

  const thread = await get(`/api/q/thread/${encodeURIComponent(ID)}`);
  const sideMsg = (thread.messages || []).map((k) => thread.records[k]).find((m) => m?.via === "side");
  check(sideMsg?.text === "Check whether the flaky one is the clock" && sideMsg.launch === sent.lid, "the thread shows what you sent on the side, with its launch");
  const row = (thread.started || []).find((r) => r.id === SIDE);
  check(row?.launch === sent.lid && row.reply?.text.startsWith("It's the clock"), "and the side thread under it, with its latest reply");

  // The thread's own turn ends: what you sent on the side isn't waiting for it.
  const stop = hook("Stop", { stop_hook_active: false, last_assistant_message: "Fixed both." }, 7000);
  check(!String(stop.stdout).includes("flaky one is the clock"), "the thread's session never hears of it");

  // An ended thread can go on the side too; one with no conversation left can't.
  fs.rmSync(T);
  check((await post(`/api/sessions/${ID}/messages`, { text: "Try again", side: true })).status === 409, "a thread whose conversation is gone doesn't");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
