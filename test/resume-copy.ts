#!/usr/bin/env node
// A copy Claude Code starts when agentbook resumes a session (a new session id with the conversation in it, and
// what you sent) is the thread it's a copy of, not a thread of its own (session.fold): what the copy says shows
// on that thread, the thread goes on in it, and a link to the copy opens the thread. Copies made before agentbook
// folded them fold with agentbook-cli fold (the daemon's /local/fold), only into the thread they're a copy of.
// Run: node test/resume-copy.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { halves, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { createStore } from "../plugin/shared/store.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-resume-copy-"));
const PORT = testPort(5200);
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

// ---------- the store: a copy folded into the thread it's a copy of ----------
{
  const file = path.join(HOME, "store", "agentbook.db");
  let store = createStore({ file, filesDir: path.join(HOME, "store", "files"), legacy: false });
  const hello = (sid, pid, label = "gull") => store.ingest({ t: "session.hello", proc: `box-${pid}`, session_id: sid, agent: "claude", agent_name: "Claude", kind: "claude-code", label, cwd: project, transcript: `/t/${sid}.jsonl` });
  const ORIG = "0a1b2c3d-0000-4000-8000-000000000001";
  const COPY = "c0c0c0c0-1111-4000-8000-000000000002";
  hello(ORIG, 1);
  store.ingest({ t: "message.add", post: ORIG, mid: "m1", from: "human", via: "dash", text: "Fix the failing checks" });
  store.ingest({ t: "session.update", post: ORIG, text: "Found it: the guard tests" });
  store.ingest({ t: "session.sleep", post: ORIG, reason: "Claude Code stopped it" });
  // The resume started a copy: a thread of its own, under the same name, with what was sent and what it says.
  hello(COPY, 2, "gull");
  store.ingest({ t: "message.add", post: COPY, mid: "m2", from: "human", via: "dash", text: "Watch CI and tell me when it's green" });
  store.ingest({ t: "message.add", post: COPY, mid: "m3", from: "agent", text: "CI is green." });
  store.ingest({ t: "session.update", post: COPY, text: "Pushed the fix" });
  store.ingest({ t: "session.pr", post: COPY, url: "https://github.com/acme/shop/pull/7", number: 7, how: "opened" });
  store.ingest({ t: "question.ask", post: COPY, qid: "q1", title: "Merge it?" });
  store.ingest({ t: "session.fold", post: ORIG, copy: COPY.slice(0, 8), follow: true });
  const s = store.state.sessions[ORIG];
  check(!store.state.sessions[COPY] && Object.keys(store.state.sessions).length === 1, "folded: the copy is no thread of its own");
  check(s.session_id === COPY && s.transcript === `/t/${COPY}.jsonl` && !s.asleep, "the thread goes on in the copy's session (follow)");
  check(store.state.messages.filter((m) => m.post === ORIG).map((m) => m.id).join() === "m1,m2,m3", "what was said in the copy is on the thread, in order");
  check(s.updates.map((u) => u.text).join(" | ") === "Found it: the guard tests | Pushed the fix" && s.prs["https://github.com/acme/shop/pull/7"] && store.state.questions.find((q) => q.id === "q1")?.post === ORIG, "and its results, pull requests and questions");
  check(store.state.procs["box-2"] === ORIG && s.label === "gull", "its process is the thread's, under the thread's name");
  hello(COPY, 2, "gull 2");
  store.ingest({ t: "session.status", post: ORIG, state: "working", turn: "start" });
  check(Object.keys(store.state.sessions).length === 1 && store.state.sessions[ORIG].busy && store.state.sessions[ORIG].label === "gull", "the copy saying hello again lands on the thread");

  // Folded before the copy says hello (the resume answered first): its hello finds the thread.
  const ORIG2 = "0a1b2c3d-0000-4000-8000-000000000003";
  hello(ORIG2, 3, "tern");
  store.ingest({ t: "session.fold", post: ORIG2, copy: "f00dbabe", follow: true });
  hello("f00dbabe-2222-4000-8000-000000000004", 4, "wren");
  check(!store.state.sessions["f00dbabe-2222-4000-8000-000000000004"] && store.state.sessions[ORIG2].session_id === "f00dbabe-2222-4000-8000-000000000004" && store.state.sessions[ORIG2].label === "tern", "folded before its hello: the copy's hello is the thread's");

  // Put away (archived, hidden: what the server keeps) only if both were.
  const [A, B, C, D] = ["aaaa0000-0000-4000-8000-0000000000a1", "bbbb0000-0000-4000-8000-0000000000b1", "cccc0000-0000-4000-8000-0000000000c1", "dddd0000-0000-4000-8000-0000000000d1"];
  for (const [sid, pid] of [[A, 5], [B, 6], [C, 7], [D, 8]]) hello(sid, pid, "kite");
  store.ingest({ t: "session.flag", post: A, archived: true });
  store.ingest({ t: "session.flag", post: C, archived: true });
  store.ingest({ t: "session.flag", post: D, archived: true });
  store.ingest({ t: "session.fold", post: A, copy: B });
  store.ingest({ t: "session.fold", post: C, copy: D });
  check(!store.state.sessions[A].archived && store.state.sessions[C].archived, "archived only if both were");
  check(store.state.sessions[A].session_id === A, "without follow, the thread keeps its own session");

  // Kept: the database has it as it is now.
  store.close();
  store = createStore({ file, filesDir: path.join(HOME, "store", "files"), legacy: false });
  check(!store.state.sessions[COPY] && store.state.sessions[ORIG].session_id === COPY && store.state.messages.filter((m) => m.post === ORIG).length === 3, "after a restart, the same");
  store.close();
}

// ---------- the daemon: a resume that starts a copy, and copies made before ----------
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
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const agents = () => JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
const hook = (event, input, pid) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
// agentbook-cli's own routes, on its port (harness.ts), as agentbook-cli on this machine calls them.
// A transcript the way Claude Code writes one: a copy has the messages it copied, ids and all.
const transcript = (sid, uuids) => {
  const file = path.join(HOME, "claude", "projects", "app", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, uuids.map((u, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", uuid: u, sessionId: sid, timestamp: new Date(Date.now() - 60e3 + i * 1000).toISOString(), message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: "ok" }] : "go" } })).join("\n") + "\n");
  return file;
};
const localFold = (body: object, key = fs.readFileSync(path.join(HOME, "cli", "local.key"), "utf8").trim()) =>
  fetch(`http://127.0.0.1:${halves(PORT).cli}/api/local/fold`, { method: "POST", headers: { "content-type": "application/json", "x-agentbook-key": key }, body: JSON.stringify(body) }).then(async (r): Promise<Json> => ({ status: r.status, ...((await r.json().catch(() => ({}))) as Json) }));

const ID = "bg-orig";
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

  hook("SessionStart", { session_id: ID, source: "startup", transcript_path: transcript(ID, ["u1", "a1"]) }, 7000);
  hook("UserPromptSubmit", { prompt: "Fix the failing checks" }, 7000);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Fixed and pushed." }, 7000);
  check(!!(await until(async () => (await stateOf(get)).sessions.find((s) => s.id === ID && s.rt?.kind === "background" && !s.busy), 6000)), "a background session, idle between turns");

  // Claude Code copies it anyway (open in another Claude Code process, say: nothing agentbook can wait out).
  fs.writeFileSync(path.join(FAKE, "copy.txt"), "");
  const mark = calls().length;
  check((await post(`/api/sessions/${ID}/messages`, { text: "Watch CI and tell me when it's green" })).status < 300, "you write to it");
  const resumed = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume")), 10000);
  const copy = await until(() => agents().find((a) => a.sessionId !== ID));
  check(resumed && copy, "Claude Code started a copy instead of resuming it");
  // The copy says hello, takes what was sent, and answers.
  hook("SessionStart", { session_id: copy.sessionId, source: "resume", transcript_path: transcript(copy.sessionId, ["u1", "a1", "u2", "a2"]) }, 7100);
  hook("UserPromptSubmit", { prompt: "Watch CI and tell me when it's green" }, 7100);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "CI is green." }, 7100);
  const st = await until(async () => {
    const x = await stateOf(get);
    return x.sessions.some((s) => s.id === ID && s.session_id === copy.sessionId && !s.busy) ? x : null;
  }, 6000);
  check(!!st, "the thread goes on in the copy's session");
  check(st && !st.sessions.some((s) => s.id === copy.sessionId) && st.sessions.filter((s) => s.cwd === project).length === 1, "and the copy is no thread of its own");
  const thread = await get(`/api/q/thread/${encodeURIComponent(ID)}`);
  const said = (thread.messages || []).map((k) => thread.records[k]?.text);
  check(said.includes("Watch CI and tell me when it's green") && said.includes("CI is green."), "what you sent and what the copy answered are on the thread");
  const viaCopy = await get(`/api/sessions/${encodeURIComponent(copy.sessionId)}`);
  check(viaCopy.status === 200 && viaCopy.id === ID, "a link to the copy opens the thread");

  // Copies from before: folded by hand, only into the thread they're a copy of.
  hook("SessionStart", { session_id: "old-orig", source: "startup", transcript_path: transcript("old-orig", ["o1", "o2"]) }, 7200);
  hook("UserPromptSubmit", { prompt: "Land it" }, 7200);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Which branch?" }, 7200);
  hook("SessionEnd", { reason: "exit" }, 7200);
  hook("SessionStart", { session_id: "old-copy", source: "resume", transcript_path: transcript("old-copy", ["o1", "o2", "o3", "o4"]) }, 7300);
  hook("UserPromptSubmit", { prompt: "so?" }, 7300);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Landed." }, 7300);
  hook("SessionEnd", { reason: "exit" }, 7300);
  hook("SessionStart", { session_id: "other", source: "startup", transcript_path: transcript("other", ["x1", "x2"]) }, 7400);
  hook("UserPromptSubmit", { prompt: "Something else" }, 7400);
  hook("SessionEnd", { reason: "exit" }, 7400);
  await until(async () => (await stateOf(get)).sessions.filter((s) => ["old-orig", "old-copy", "other"].includes(s.id)).length === 3, 6000);
  check((await localFold({ copy: "old-copy", post: "old-orig" }, "nope")).status === 403, "only agentbook-cli on this machine folds one");
  check((await localFold({ copy: "other", post: "old-orig" })).status === 400, "a thread that isn't a copy of it doesn't fold");
  const r = await localFold({ copy: "old-copy", post: "old-orig" });
  check(r.status === 200 && r.follow === true, "a copy folds into the thread it's a copy of, which goes on in it (its last turn was later)");
  const after = await until(async () => {
    const x = await stateOf(get);
    return !x.sessions.some((s) => s.id === "old-copy") ? x : null;
  }, 6000);
  check(after && after.sessions.find((s) => s.id === "old-orig")?.session_id === "old-copy", "one thread, going on in the copy's session");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
