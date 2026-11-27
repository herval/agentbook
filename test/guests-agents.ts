#!/usr/bin/env node
// OpenClaw and Hermes agents as a thread's guests, with a stand-in `openclaw`
// (fake-openclaw.ts) and `hermes` (fake-hermes.ts). An OpenClaw agent has no folder: it joins with the conversation
// as what it has, its reply shows in the thread, and each hears the other with its next message. Hermes works in
// the thread's folder, as Claude Code and Codex do. A thread whose own agent has no folder (an OpenClaw thread) gives
// a guest that needs one a folder of the thread's own. The same in a thread you start yourself.
// Run: node test/guests-agents.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "./harness-sql.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-guests-agents-"));
const PORT = testPort(6100);
const URL = `http://127.0.0.1:${PORT}`;
const OC = path.join(HOME, "openclaw");
const HERMES_HOME = path.join(HOME, "hermes");
const HM = path.join(HOME, "fake-hermes");
const project = path.join(HOME, "dev", "app");
for (const d of [OC, HERMES_HOME, HM, project, path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
fs.writeFileSync(path.join(HM, "http"), "");
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: "/usr/bin/false",
  AGENTBOOK_OPENCLAW_BIN: path.join(TEST, "fake-openclaw.ts"),
  FAKE_OPENCLAW_DIR: OC,
  AGENTBOOK_OPENCLAW_SYNC_MS: "300",
  AGENTBOOK_HERMES_BIN: path.join(TEST, "fake-hermes.ts"),
  HERMES_HOME,
  FAKE_HERMES_DIR: HM,
  AGENTBOOK_HERMES_SYNC_MS: "200",
  AGENTBOOK_CLOUD_SYNC_MS: "600000",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_OPENCLAW", "AGENTBOOK_HERMES", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];

// OpenClaw has one agent, Clio, that never talked.
fs.writeFileSync(path.join(OC, "state.json"), JSON.stringify({ agents: [{ id: "main", name: "main", identity: { name: "Clio" }, workspace: "/Users/me/.openclaw/workspace" }], sessions: [] }));
// Hermes has been used once, so it's an agent.
const db = new DatabaseSync(path.join(HERMES_HOME, "state.db"));
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, created_source TEXT, title TEXT, title_source TEXT, parent_session_id TEXT, end_reason TEXT,
    started_at REAL, ended_at REAL, last_activity_at REAL, last_activity_description TEXT, cwd TEXT, git_branch TEXT, model TEXT, model_config TEXT,
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT,
    timestamp REAL, finish_reason TEXT, reasoning TEXT, active INTEGER DEFAULT 1, display_kind TEXT, message_uid TEXT);
  CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, expires_at REAL);`);
const t0 = Date.now() / 1000;
db.prepare("INSERT INTO sessions (id, source, title, started_at, last_activity_at, cwd, hidden) VALUES (?, ?, ?, ?, ?, ?, 0)").run("20261006_090000_aa", "cli", "An old one", t0 - 3600, t0 - 3500, project);
db.prepare("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)").run("20261006_090000_aa", "user", "hello", t0 - 3600);

// What a fake (OpenClaw's or Hermes's) logged of each request it was sent: its method, and what the test reads of its params.
type Call = { method?: string; params?: { message?: string; agentId?: string; cwd?: string; prompt?: { type: string; text: string }[] } };
const callsOf = (dir: string): Call[] => (fs.existsSync(path.join(dir, "calls.jsonl")) ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let failures = 0;
const check = (cond: unknown, label: string, more = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !more ? "" : `\n      ${more}`}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let COOKIE = "";
async function req(method: string, p: string, body?: unknown): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(COOKIE ? { cookie: COOKIE } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const get = (p: string) => req("GET", p);
const post = (p: string, body = {}) => req("POST", p, body);
const enc = encodeURIComponent;
const until = async <T>(fn: () => T | Promise<T>, ms = 10000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};
const host = { get: (p: string) => fetch(`${URL}/api/procs/box-1${p}`).then((r): Promise<Json> => r.json()), post: (p: string, body: unknown) => fetch(`${URL}/api/procs/box-1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) };
const taken = async () => ((await host.get("/events?ack=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");

let serverLog = "";
let server;
try {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok);
  COOKIE = (await post("/api/auth/test-person", { username: "herval" })).cookie;
  const agents = await until(async () => {
    const a = (await stateOf(get)).agents || [];
    return a.some((x) => x.id === "openclaw-main") && a.some((x) => x.id === "hermes") && a;
  });
  check(agents?.find((a) => a.id === "openclaw-main")?.folders === false && agents.find((a) => a.id === "hermes")?.folders !== false, "the page knows which of them has no folders", JSON.stringify(agents));

  // A Claude Code thread, working in a folder.
  await post("/api/hello", { proc: "box-1", label: "swallow", agent: "Claude", session_id: "sess-host", cwd: project });
  await post("/api/sessions/sess-host/messages", { text: "add reaction counts under each message on the feed card" });
  await taken();
  await host.post("/messages", { text: "Done: each message on a card shows its reactions' counts, in Inter 13." });

  // ---------- an OpenClaw agent joins: no folder, the conversation is what it has ----------
  const brought = await post("/api/sessions/sess-host/guests", { agent: "openclaw-main", text: "@Clio what did the brand thread decide about fonts?" });
  check(brought.status === 200 && brought.guest && brought.lid, "@-ing an OpenClaw agent brings it into a Claude thread", JSON.stringify(brought));
  const created = await until(() => callsOf(OC).find((c) => c.method === "sessions.create"));
  const told = created?.params.message || "";
  check(created?.params.agentId === "main" && told.startsWith("@Clio what did the brand thread decide"), "its session starts on its gateway, with what you wrote first");
  check(/brought you into their thread .* \(swallow, Claude\)/.test(told) && /You're a guest there/.test(told) && /Done: each message on a card/.test(told), "then the thread it's in and what was said there");
  check(/swallow works in .*dev\/app, on \S+\. You have no folder there, and can't read its files: what's said in the thread is what you have to go on\./.test(told) && !/and so do you/.test(told) && !/never commit/.test(told), "and that it has no folder there, not that it works in the thread's", told.slice(-400));
  check(/If you have agentbook's tools, ab_thread_read has the rest/.test(told), "ab_thread_read is offered as something it may have");
  const gid = brought.guest;
  const said = await until(async () => {
    const d = await get("/api/sessions/sess-host");
    return d.messages?.some((m) => m.from === "agent" && m.guest && /^Got it: @Clio what did/.test(m.text || "")) && d;
  });
  const reply = said?.messages.find((m) => m.guest && m.from === "agent");
  const asked = said?.messages.find((m) => m.guest && m.from === "human");
  check(reply?.agent === "openclaw-main" && said.guests?.[0]?.agent === "openclaw-main" && !said.guests[0].removed, "what it says shows in the thread's conversation, as its agent's", JSON.stringify(said?.guests));
  check(asked?.text === "@Clio what did the brand thread decide about fonts?", "with what you asked it, and not what it was told with it", asked?.text);
  const own = await get(`/api/sessions/${enc(reply?.guest || gid)}`);
  check(own.guest_of?.id === "sess-host" && own.messages?.[0]?.text === "@Clio what did the brand thread decide about fonts?", "its own thread says whose guest it is, and shows what you wrote");
  check(!(await taken()), "the thread's agent isn't given a turn for any of it");

  // ---------- each hears the other with its next message ----------
  await post("/api/sessions/sess-host/messages", { text: "ok, use what it said" });
  const hostGot = await taken();
  check(/^ok, use what it said\n\nFrom your thread since your last turn:/.test(hostGot) && /\(Clio\), a guest, said: "Got it: @Clio what did/.test(hostGot), "the thread's agent hears what the OpenClaw guest said with its next message", hostGot.slice(0, 500));
  await host.post("/messages", { text: "Switched the card to IBM Plex, as Clio said." });
  await post(`/api/sessions/${enc(reply.guest)}/messages`, { text: "and the sizes?" });
  const next = await until(() => callsOf(OC).find((c) => c.method === "chat.send" && /^and the sizes\?/.test(c.params.message || "")));
  check(/From your thread since your last turn:/.test(next?.params.message || "") && /swallow \(Claude\) said: "Switched the card to IBM Plex/.test(next.params.message) && /herval to swallow \(Claude\): "ok, use what it said"/.test(next.params.message), "and the guest hears the thread with the next message you send it", next?.params.message);

  // ---------- Hermes joins: it works in the thread's folder ----------
  const hermes = await post("/api/sessions/sess-host/guests", { agent: "hermes", text: "@Hermes does the migration look safe?" });
  const made = await until(() => callsOf(HM).find((c) => c.method === "session/new"));
  check(hermes.status === 200 && made && fs.realpathSync(made.params.cwd) === fs.realpathSync(project), `Hermes joins too, in the thread's folder (${made?.params.cwd})`, JSON.stringify(hermes));
  const prompted = await until(() => callsOf(HM).find((c) => c.method === "session/prompt"));
  const hermesTold = (prompted?.params.prompt || []).map((c) => c.text).join("\n");
  check(/You're a guest there/.test(hermesTold) && /and so do you: read anything, change files only when herval asks you to/.test(hermesTold) && /If you have agentbook's tools/.test(hermesTold), "told it works beside the thread's agent", hermesTold.slice(-300));
  const both = await until(async () => {
    const d = await get("/api/sessions/sess-host");
    return d.messages?.some((m) => m.agent === "hermes" && m.from === "agent") && d;
  });
  check(both?.guests?.filter((g) => !g.removed).length === 2 && both.guests.every((g) => g.label), "the thread lists both guests", JSON.stringify(both?.guests));

  // ---------- a thread whose agent has no folder: a guest that needs one gets a folder of the thread's own ----------
  const launched = await post("/api/launch", { prompt: "Draft the newsletter", agent: "openclaw-main" });
  const key = await until(async () => ((await stateOf(get)).sessions || []).find((s) => s.launch === launched.lid)?.id);
  check(key, "an OpenClaw thread of its own");
  const n = callsOf(HM).filter((c) => c.method === "session/new").length;
  const into = await post(`/api/sessions/${enc(key)}/guests`, { agent: "hermes", text: "@Hermes check the links in it" });
  const second = await until(() => callsOf(HM).filter((c) => c.method === "session/new")[n]);
  check(into.status === 200 && second && /\/cli\/threads\/guests-[0-9a-f]{16}$/.test(second.params.cwd) && fs.existsSync(second.params.cwd), `Hermes joins an OpenClaw thread, in a folder of the thread's own (${second?.params.cwd})`, JSON.stringify(into));
  const secondTold = (await until(() => callsOf(HM).filter((c) => c.method === "session/prompt").find((c) => /check the links/.test(JSON.stringify(c.params.prompt)))))?.params.prompt.map((c) => c.text).join("\n") || "";
  check(/You work in a folder of this thread's own on \S+, with nothing of herval's in it/.test(secondTold) && !/works in \/Users\/me\/\.openclaw/.test(secondTold), "told so, and not sent to the OpenClaw agent's workspace on its gateway", secondTold.slice(-300));

  // ---------- in a thread you start yourself ----------
  const talk = await post("/api/talks", { text: "@Clio which fonts are we on?" });
  const before = callsOf(OC).filter((c) => c.method === "sessions.create").length;
  const sent = await post(`/api/talks/${talk.id}/send`, { mid: talk.mid, agent: "openclaw-main" });
  const third = await until(() => callsOf(OC).filter((c) => c.method === "sessions.create")[before]);
  check(sent.status === 200 && third && /named you in their thread/.test(third.params.message) && /You have no folder for it: what's said there is what you have to go on\./.test(third.params.message) && !/folder of this thread's own/.test(third.params.message), "an OpenClaw agent joins a thread of yours, with no folder", third?.params.message?.slice(-300) || JSON.stringify(sent));
  check(!fs.existsSync(path.join(HOME, "cli", "threads", talk.id)), "and no folder is made for it here");
  const talked = await until(async () => {
    const q = await get(`/api/q/thread/${talk.id}?n=50`);
    return Object.values<Json>(q.records || {}).some((m) => m.from === "agent" && m.guest && /^Got it: @Clio which fonts/.test(m.text || "")) && q;
  });
  check(talked, "and answers there");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server?.kill();
  await sleep(300);
}
if (failures) console.log(`\nserver log:\n${serverLog.slice(-3000)}`);
else fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
