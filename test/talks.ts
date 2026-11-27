#!/usr/bin/env node
// Threads you start yourself: a thread of a person's, kept on agentbook-server with no
// machine behind it. Writing in it sends nothing; naming an agent sends what you wrote to it, and it joins as a guest:
// a thread of its own, in the thread's workspace or a folder of the thread's own, told whose thread it's in. What it
// says shows in the thread's conversation; it hears the rest with its next message. Only its owner writes in it; a
// public one others read. It's on the feed, as a thread, and survives a restart. Run: node test/talks.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTalk, isTalkId, talkText, talkTitle } from "../plugin/shared/talks.ts";
import type { State } from "../plugin/shared/types.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-talks-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(6100);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "CLAUDE_JOB_DIR"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });
// What a session is handed when it next takes what waits for it, as the hooks do: every event's text, one per line.
const taken = async (a) => ((await a.get("/events?ack=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");
const keys = (feed) => (feed.list || []).map((it) => it.key || it);

let server: Agentbook;
async function start() {
  server = spawnAgentbook({ env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stop() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}
async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
}

// ---------- the parts that need no server ----------
{
  const s: Partial<State> = {};
  applyTalk(s, { t: "talk.create", tid: "t-000000000001", mid: "m1", owner: "u1", by: "herval", text: "Why did signups drop Tuesday?\nThe dashboard says -18%." }, "2026-10-21T10:00:00.000Z");
  const t = s.talks["t-000000000001"];
  check(t && talkTitle(t) === "Why did signups drop Tuesday?" && talkText(t) === "The dashboard says -18%." && t.visibility === "private", "its first line is its title, the rest its text, and it starts private");
  applyTalk(s, { t: "talk.create", tid: "nope", mid: "m1", owner: "u1", text: "x" }, "x");
  check(!s.talks.nope && isTalkId("t-0123456789ab") && !isTalkId("c9b1e4a2-1111-2222-3333-444455556666"), "its id never looks like a session's");
  applyTalk(s, { t: "talk.say", tid: t.id, mid: "m2", by: "herval", text: "does iOS look different?" }, "2026-10-21T10:05:00.000Z");
  applyTalk(s, { t: "talk.say", tid: t.id, mid: "m2", by: "herval", text: "twice" }, "2026-10-21T10:06:00.000Z");
  applyTalk(s, { t: "talk.sent", tid: t.id, mid: "m2", to: "g1" }, "x");
  applyTalk(s, { t: "talk.sent", tid: t.id, mid: "m2", to: "g1" }, "x");
  check(t.messages.length === 2 && t.messages[1].sent.join() === "g1" && t.updated === "2026-10-21T10:05:00.000Z", "a message is kept once, and says who it went to, once each");
  applyTalk(s, { t: "talk.title", tid: t.id, title: "Signups, Tuesday" }, "x");
  check(talkTitle(t) === "Signups, Tuesday" && talkText(t).startsWith("Why did signups drop"), "a title you give it keeps its whole first message as its text");
}

try {
  await start();
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  // A machine with Claude on it: a session says hello, as one does when it starts.
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "swallow", agent: "Claude", session_id: "sess-other", cwd: HOME } });

  // ---------- a thread of yours, with nobody in it ----------
  check((await owner.post("/api/talks", { text: "  " })).status === 400, "an empty one isn't started");
  const made = await owner.post("/api/talks", { text: "Why did signups drop Tuesday?\nThe dashboard says -18%. @Claude check what we deployed that day." });
  const tid = made.id;
  check(made.status === 200 && isTalkId(tid) && made.mid, "you start a thread of your own: no agent, no machine");
  let q = await owner.get(`/api/q/thread/${tid}?n=50`);
  let rec = q.records?.[`thread:${tid}`];
  check(rec?.talk && rec.title === "Why did signups drop Tuesday?" && /check what we deployed/.test(rec.text) && rec.mine && rec.owner === "herval" && rec.effective === "done" && !q.messages.length, "its page has it as a thread: its title, its text, whose it is, nobody in it yet");
  let feed = await owner.get("/api/q/feed?filter=all&n=100");
  check(keys(feed).includes(`thread:${tid}`) && feed.records[`thread:${tid}`]?.talk, "it's on your feed");
  // (agentbook-cli asks claude which sessions run in the background now and then; that starts nothing.)
  const started = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l)).filter((c) => c.args.some((x) => /signups/.test(x))) : []);
  check(!started().length, "and writing it started nothing");

  // ---------- who sees it ----------
  check((await alice.get(`/api/q/thread/${tid}?n=5`)).status === 404 && !keys(await alice.get("/api/q/feed?filter=all&n=100")).includes(`thread:${tid}`), "nobody else sees it while it's private");
  check((await alice.post(`/api/talks/${tid}/messages`, { text: "hi" })).status === 404, "nor writes in it");
  check((await owner.post(`/api/talks/${tid}`, { visibility: "public" })).status === 200, "you make it public");
  check((await alice.get(`/api/q/thread/${tid}?n=5`)).status === 404, "which isn't for someone who isn't your contact");
  // Public is for your contacts, who follow you from the start.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  check((await alice.get(`/api/q/thread/${tid}?n=5`)).records?.[`thread:${tid}`]?.mine === false && keys(await alice.get("/api/q/feed?filter=all&n=100")).includes(`thread:${tid}`), "and your contact reads it, on their feed too");
  check((await alice.post(`/api/talks/${tid}/messages`, { text: "hi" })).status === 403 && (await alice.post(`/api/talks/${tid}/send`, { mid: made.mid, agent: "claude" })).status === 403, "but only you write in it, or send from it");
  await owner.post(`/api/talks/${tid}`, { visibility: "private" });

  // ---------- naming an agent: it joins ----------
  check((await owner.post(`/api/talks/${tid}/send`, { mid: made.mid, agent: "nobody" })).status === 403, "an agent that isn't yours can't be sent to");
  fs.writeFileSync(path.join(FAKE, "next.txt"), "guest-wren-1");
  const sent = await owner.post(`/api/talks/${tid}/send`, { mid: made.mid, agent: "claude" });
  check(sent.status === 200 && sent.guest && sent.lid, "sending what you wrote to an agent starts a thread of its own for it");
  const calls = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l));
  const call = calls.findLast((c) => c.args.some((a) => /check what we deployed/.test(a)));
  const prompt = call?.args.find((a) => /check what we deployed/.test(a)) || "";
  check(call && fs.realpathSync(call.cwd) === fs.realpathSync(path.join(HOME, "cli", "threads", tid)), `with no workspace, it works in a folder of the thread's own (${call?.cwd})`);
  check(prompt.startsWith("Why did signups drop Tuesday?") && /herval named you in their thread "Why did signups drop Tuesday\?"/.test(prompt) && /not an agent's: what you say at the end of each turn shows there as your reply/.test(prompt) && /a folder of this thread's own/.test(prompt) && !/What's been said there/.test(prompt), "it's told what you wrote, then whose thread it's in and how its words get there, and not what you wrote twice");
  rec = (await owner.get(`/api/q/thread/${tid}?n=50`)).records[`thread:${tid}`];
  check(rec.guests?.length === 1 && rec.guests[0].effective === "starting" && rec.effective === "working", "the thread lists it while it starts, and is working");

  await req("POST", "/api/hello", { body: { proc: "box-2", label: "wren", agent: "Claude", session_id: "guest-wren-1", cwd: call?.cwd || HOME } });
  const guest = agent("box-2");
  // Its first prompt, as Claude Code's UserPromptSubmit hook mirrors it: what you wrote, with the note after it.
  await guest.post("/messages", { from: "human", via: "terminal", text: prompt });
  const own = await owner.get("/api/sessions/guest-wren-1");
  check(own.guest_of?.id === tid && own.guest_of.talk && own.guest_of.by === "herval" && own.guest_of.title === "Why did signups drop Tuesday?", "its own thread says whose thread it's in");
  await guest.post("/messages", { text: "The 14:02 deploy gave the email field a pattern iOS Safari rejects for addresses with a +." });
  q = await until(async () => {
    const x = await owner.get(`/api/q/thread/${tid}?n=50`);
    return x.messages?.some((k) => x.records[k]?.guest === "guest-wren-1" && x.records[k].from === "agent") ? x : null;
  });
  const said = (q?.messages || []).map((k) => q.records[k]);
  check(said.length === 1 && said[0].from === "agent" && said[0].agent === "claude" && /14:02 deploy/.test(said[0].text), "what it says shows in your thread, as its agent's, and what you sent it isn't there twice");
  rec = q.records[`thread:${tid}`];
  check(rec.guests[0].id === "guest-wren-1" && rec.guests[0].label === "wren" && rec.agents.join() === "claude", "the thread lists who's in it");
  feed = await owner.get("/api/q/feed?filter=all&n=100");
  check(!keys(feed).includes("thread:guest-wren-1") && keys(feed).includes(`thread:${tid}`), "its own thread isn't a card in the feed: it's folded into yours");
  check(feed.records[`thread:${tid}`]?.last_messages?.some((m) => m.guest === "guest-wren-1"), "your thread's card has what it said");
  check(keys(await owner.get("/api/q/feed?filter=all&agent=claude&n=100")).includes(`thread:${tid}`), "and narrowing the feed to Claude keeps your thread");

  // ---------- writing in it: only who it's to is woken ----------
  const aside = await owner.post(`/api/talks/${tid}/messages`, { text: "note to self: check the waitlist emails too" });
  check(aside.status === 200 && aside.mid && !(await taken(guest)), "a message to nobody stays in the thread, and nobody is woken");
  const ask = await owner.post(`/api/talks/${tid}/messages`, { text: "@Claude can you open a PR with the fix?" });
  check((await owner.post(`/api/talks/${tid}/send`, { mid: ask.mid, thread: "guest-wren-1" })).status === 200, "a message to a guest goes to its thread");
  const got = await taken(guest);
  check(/^@Claude can you open a PR with the fix\?\n\nFrom your thread since your last turn:/.test(got) && /herval said: "note to self: check the waitlist emails too"/.test(got), "with what was said in the thread since it last heard");
  check(!/14:02 deploy/.test(got) && !/check what we deployed/.test(got), "but not what it said, or was sent, itself");
  q = await owner.get(`/api/q/thread/${tid}?n=50`);
  const mine = (q.messages || []).map((k) => q.records[k]).filter((m) => m.from === "human");
  check(mine.length === 2 && mine[0].to.length === 0 && mine[1].to.join() === "guest-wren-1", "the thread shows what you wrote once, each with who it went to");

  // ---------- what the agent reads and is told ----------
  const read = await guest.get("/thread");
  check(/^herval's thread "Why did signups drop Tuesday\?"/.test(read.text || "") && /herval: "note to self/.test(read.text) && /wren \(Claude\): "The 14:02 deploy/.test(read.text), "ab_thread_read reads your thread, who said what");
  check(/You're in herval's own thread "Why did signups drop Tuesday\?"/.test((await guest.get("/context")).text || ""), "its context says whose thread it's in");

  // ---------- a thread that's running joins as it is ----------
  await req("POST", "/api/hello", { body: { proc: "box-7", label: "heron", agent: "Claude", session_id: "sess-api", cwd: HOME } });
  const heron = agent("box-7");
  await owner.post("/api/sessions/sess-api/messages", { text: "build the signups endpoint" });
  await taken(heron);
  await heron.post("/messages", { text: "Built it: GET /signups answers a count per day." });
  const two = await owner.post("/api/talks", { text: "Which endpoint has signups per day?" });
  check((await alice.post(`/api/talks/${two.id}/send`, { mid: two.mid, join: "sess-api" })).status === 404, "only its owner brings a thread into it");
  check((await owner.post(`/api/talks/${two.id}/send`, { mid: two.mid, join: "nowhere" })).status === 404, "a thread that isn't there doesn't join");
  const joined = await owner.post(`/api/talks/${two.id}/send`, { mid: two.mid, join: "sess-api" });
  check(joined.status === 200 && joined.guest === "sess-api" && !joined.lid, "naming a running thread brings it in as it is: nothing new starts");
  const heronGot = await taken(heron);
  check(/^Which endpoint has signups per day\?\n\n/.test(heronGot) && /brought this thread into their thread "Which endpoint has signups per day\?"/.test(heronGot) && /It's herval's own thread, not an agent's/.test(heronGot) && /You go on as you were, where you were/.test(heronGot), "it gets your message as its next, then whose thread it's in now");
  await heron.post("/messages", { text: "GET /signups, a count per day." });
  const there = await until(async () => {
    const x = await owner.get(`/api/q/thread/${two.id}?n=50`);
    return Object.values<Json>(x.records || {}).some((m) => m.guest === "sess-api" && m.from === "agent" && /^GET \/signups, a count/.test(m.text || "")) && x;
  });
  const said2 = Object.values<Json>(there?.records || {}).filter((m) => m.guest === "sess-api").map((m) => m.text);
  check(there && said2.length === 1 && there.records[`thread:${two.id}`].guests?.[0]?.id === "sess-api", "what it says from then on shows there, not what it said before");
  check(keys(await owner.get("/api/q/feed?filter=all&n=100")).includes("thread:sess-api"), "and it keeps its own card in the feed");
  const heronRead = (await heron.get("/thread")).text || "";
  check(/heron \(Claude\): "GET \/signups, a count per day\."/.test(heronRead) && !/Built it: GET/.test(heronRead), "ab_thread_read has the thread from when it joined");
  check((await owner.post(`/api/talks/${tid}/send`, { mid: made.mid, join: "sess-api" })).status === 409, "it doesn't join a second thread while it's in one");
  const more = await owner.post(`/api/talks/${two.id}/messages`, { text: "and per week?" });
  check((await owner.post(`/api/talks/${two.id}/send`, { mid: more.mid, thread: "sess-api" })).status === 200 && /^and per week\?/.test(await taken(heron)), "your next message there reaches it as any guest's does");
  check((await owner.post(`/api/talks/${two.id}/guests`, { remove: "sess-api" })).status === 200 && !/You're in herval's own thread/.test((await heron.get("/context")).text || ""), "taken out, it goes on as a thread of its own");

  // ---------- archived, taken out, and after a restart ----------
  await owner.post(`/api/talks/${tid}`, { archived: true });
  check(!keys(await owner.get("/api/q/feed?filter=all&n=100")).includes(`thread:${tid}`) && keys(await owner.get("/api/q/feed?filter=archived&n=100")).includes(`thread:${tid}`), "archived, it's on the Archived shelf");
  await owner.post(`/api/talks/${tid}`, { archived: false });
  check((await owner.post(`/api/talks/${tid}/guests`, { remove: "guest-wren-1" })).status === 200, "a guest can be taken out");
  check(keys(await owner.get("/api/q/feed?filter=all&n=100")).includes("thread:guest-wren-1"), "and its thread is a card of its own again");
  await stop();
  await start();
  q = await owner.get(`/api/q/thread/${tid}?n=50`);
  check(q.records?.[`thread:${tid}`]?.title === "Why did signups drop Tuesday?" && (q.messages || []).length === 3 && q.records[`thread:${tid}`].guests[0].removed, "it, what was said in it, and who was in it survive a restart");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  if (server) await stop().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
