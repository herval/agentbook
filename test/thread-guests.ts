#!/usr/bin/env node
// A thread's guests: @-ing another agent in a thread brings it in as a guest, a thread of
// its own started in the thread's folder and told about it. What the guest says shows in the thread's conversation,
// and each thread there hears what the others said with the next message it gets, never on its own. A plain message
// stays the thread's. ab_thread_read reads the conversation; the context says who's a guest where. A guest can be
// taken out, and it all survives a restart. Run: node test/thread-guests.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGuest, guestsOf, newsText } from "../plugin/shared/guests.ts";
import type { State } from "../plugin/shared/types.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-guests-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(6000);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "CLAUDE_JOB_DIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
// `extra`: what to show when it fails.
const check = (cond: unknown, label: string, extra: unknown = ""): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? `  [${extra}]` : ""}`);
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
  applyGuest(s, { t: "thread.guest", gid: "g1", host: "h", agent: "codex", launch: "g1", by: { user: "herval" } }, "2026-10-20T10:00:00.000Z");
  applyGuest(s, { t: "thread.guest", gid: "g1", post: "p1" }, "2026-10-20T10:00:01.000Z");
  check(guestsOf(s, "h").length === 1 && s.thread_guests.g1.post === "p1" && s.thread_guests.g1.launch === "g1", "a guest is kept by its launch, then by the thread its launch became");
  applyGuest(s, { t: "thread.guest", gid: "g1", remove: true }, "2026-10-20T10:05:00.000Z");
  applyGuest(s, { t: "thread.guest", gid: "g1", host: "h", agent: "codex" }, "2026-10-20T10:09:00.000Z");
  check(!s.thread_guests.g1.removed && s.thread_guests.g1.back === "2026-10-20T10:09:00.000Z", "one that left can be brought back, and hears the thread from then on");
  applyGuest(s, { t: "thread.seen", post: "h", upto: "2026-10-20T10:02:00.000Z" }, "x");
  applyGuest(s, { t: "thread.seen", post: "h", upto: "2026-10-20T10:01:00.000Z" }, "x");
  check(s.thread_seen.h === "2026-10-20T10:02:00.000Z", "how far a thread heard only goes forward");
  const many = newsText(Array.from({ length: 8 }, (_, i) => ({ at: String(i), text: `line ${i}` })));
  check(/^From your thread since your last turn:\n {2}line 2\n/.test(many) && /and 2 earlier lines: ab_thread_read has them$/.test(many), "news keeps the latest lines, and says where the rest are");
}

try {
  await start();
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "swallow", agent: "Claude", session_id: "sess-host", cwd: project } });
  const host = agent("box-1");
  await owner.post("/api/sessions/sess-host/messages", { text: "add reaction counts under each message on the feed card" });
  await taken(host);
  await host.post("/messages", { text: "Done: each message on a card shows its reactions' counts, from a new reactions table." });

  // ---------- @ an agent: it joins as a guest ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "guest-ibis-1");
  check((await alice.post("/api/sessions/sess-host/guests", { agent: "claude", text: "hi" })).status === 404, "only the thread's owner brings agents into it");
  check((await owner.post("/api/sessions/sess-host/guests", { agent: "nobody", text: "hi" })).status === 403, "an agent that isn't theirs can't be brought in");
  const brought = await owner.post("/api/sessions/sess-host/guests", { agent: "claude", text: "@Claude does the migration look safe to run on a big table?" });
  check(brought.status === 200 && brought.guest && brought.lid, "@-ing an agent brings it in: a thread of its own starts");
  const calls = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l));
  const call = calls.findLast((c) => c.args.some((a) => /migration look safe/.test(a)));
  const prompt = call?.args.find((a) => /migration look safe/.test(a)) || "";
  check(call && fs.realpathSync(call.cwd) === fs.realpathSync(project), `it works in the thread's folder (${call?.cwd})`);
  check(prompt.startsWith("@Claude does the migration look safe") && /brought you into their thread .* \(swallow, Claude\)/.test(prompt) && /You're a guest there/.test(prompt) && /Done: each message on a card/.test(prompt) && /never commit, stash or reset there/.test(prompt), "it's told what you wrote, then the thread it's in, what was said there, and how to work beside its agent");
  let detail = await owner.get("/api/sessions/sess-host");
  check(detail.guests?.length === 1 && detail.guests[0].effective === "starting", "the thread lists it while it starts");

  await req("POST", "/api/hello", { body: { proc: "box-2", label: "ibis", agent: "Claude", session_id: "guest-ibis-1", cwd: project } });
  const guest = agent("box-2");
  // Its first prompt, as Claude Code's UserPromptSubmit hook mirrors it: what you wrote, with the note after it.
  await guest.post("/messages", { from: "human", via: "terminal", text: prompt });
  const mine = await owner.get("/api/sessions/guest-ibis-1");
  check(mine.messages?.[0]?.text === "@Claude does the migration look safe to run on a big table?", "its own thread shows what you wrote, not what it was told with it");
  check(mine.guest_of?.id === "sess-host" && mine.guest_of.label === "swallow", "and says whose thread it's a guest in");
  await guest.post("/messages", { text: "Mostly. Build the index CONCURRENTLY, in a migration of its own." });
  detail = await until(async () => {
    const d = await owner.get("/api/sessions/sess-host");
    return d.messages?.some((m) => m.guest === "guest-ibis-1" && m.from === "agent") ? d : null;
  });
  const said = detail?.messages || [];
  const reply = said.find((m) => m.guest === "guest-ibis-1" && m.from === "agent");
  const asked = said.find((m) => m.guest === "guest-ibis-1" && m.from === "human");
  check(reply && reply.agent === "claude" && /CONCURRENTLY/.test(reply.text), "what the guest says shows in the thread's conversation, as its agent's");
  check(asked && asked.text.startsWith("@Claude does the migration") && said.indexOf(asked) < said.indexOf(reply) && said.indexOf(asked) > said.findIndex((m) => /^Done: each message/.test(m.text || "")), "with what you said to it, in time with the thread's own");
  check(detail.guests[0].id === "guest-ibis-1" && detail.guests[0].label === "ibis" && !detail.guests[0].removed, "the thread lists who's in it");
  check(!(await taken(host)), "the thread's agent isn't given a turn for any of it");
  const q = await owner.get("/api/q/thread/sess-host?n=50");
  check(q.messages?.some((k) => q.records[k]?.guest === "guest-ibis-1"), "the thread's page gets the guest's messages too");
  const feed = await owner.get("/api/q/feed?filter=all&n=100");
  const card = feed.records?.["thread:sess-host"];
  check(!feed.list?.some((it) => (it.key || it) === "thread:guest-ibis-1") && feed.list?.some((it) => (it.key || it) === "thread:sess-host"), "a guest's own thread isn't a card in the feed");
  check(card?.guests?.[0]?.id === "guest-ibis-1" && card.last_messages?.some((m) => m.guest === "guest-ibis-1"), "the thread's card shows its guest, and what it said among its last messages");

  // ---------- each hears the other with its next message ----------
  await owner.post("/api/sessions/sess-host/messages", { text: "ok, fix what it found" });
  const hostGot = await taken(host);
  check(/^ok, fix what it found\n\nFrom your thread since your last turn:/.test(hostGot), "a plain message goes to the thread's agent, with what happened in its conversation since it last heard");
  check(/herval to ibis \(Claude\): "@Claude does the migration look safe/.test(hostGot) && /ibis \(Claude\), a guest, said: "Mostly\. Build the index CONCURRENTLY/.test(hostGot) && /ibis \(Claude\) joined, as a guest/.test(hostGot), "what you asked the guest, and what it said");
  check((await owner.get("/api/sessions/sess-host")).messages.findLast((m) => !m.guest && m.from === "human")?.text === "ok, fix what it found", "and the thread shows only what you wrote");
  await host.post("/messages", { text: "Did what ibis found: the index is built CONCURRENTLY now." });
  await owner.post("/api/sessions/guest-ibis-1/messages", { text: "anything else?" });
  const guestGot = await taken(guest);
  check(/^anything else\?\n\nFrom your thread since your last turn:/.test(guestGot) && /herval to swallow \(Claude\): "ok, fix what it found"/.test(guestGot) && /swallow \(Claude\) said: "Did what ibis found/.test(guestGot), "the guest hears what the thread's agent said, and what you said to it");
  check(!/Mostly\. Build the index/.test(guestGot) && !/does the migration look safe/.test(guestGot), "but not what it said or was asked itself");
  await owner.post("/api/sessions/sess-host/messages", { text: "thanks" });
  const since = await taken(host);
  check(/herval to ibis \(Claude\): "anything else\?"/.test(since) && !/Mostly/.test(since) && !/joined/.test(since), "the next time, only what's new since it last heard");
  await owner.post("/api/sessions/sess-host/messages", { text: "thanks again" });
  check(!/From your thread/.test(await taken(host)), "nothing new, no news");

  // ---------- what the agents read and are told ----------
  const read = await guest.get("/thread");
  check(/swallow "Reaction counts|swallow ".*": /.test(read.text || "") || /^swallow /.test(read.text || ""), "ab_thread_read reads the thread it's a guest in");
  check(/The conversation, with its guests:/.test(read.text || "") && /ibis \(Claude, a guest\): "Mostly/.test(read.text) && /herval to ibis: "anything else\?"/.test(read.text), "with the whole conversation, what each guest said among the thread's own");
  check(/^ibis /.test((await host.get("/thread?thread=ibis")).text || ""), "and the thread's agent reads a guest's thread by its name");
  check((await agent("box-9").get("/thread")).status >= 400, "a thread with no guests has nothing to read there");
  const toldGuest = (await guest.get("/context")).text || "";
  const toldHost = (await host.get("/context")).text || "";
  check(/You're a guest in herval's thread ".*" \(swallow \(Claude\)\)/.test(toldGuest) && /ab_thread_read/.test(toldGuest), "a guest's context says whose thread it's a guest in");
  check(/herval brought ibis \(Claude\) into this thread as a guest/.test(toldHost), "and the thread's says who's in it");
  check((await owner.post("/api/sessions/guest-ibis-1/guests", { agent: "claude", text: "and you?" })).status === 409, "a guest's thread doesn't bring in guests of its own");

  // ---------- files handed over in it: a guest may be on another machine, with no way to their paths ----------
  const md = "---\ntitle: Reaction counts\n---\n\nEach message shows its reactions.\n";
  await host.post("/files", { name: "draft.md", content_base64: Buffer.from(md).toString("base64") });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  await host.post("/files", { name: "shot.png", content_base64: png.toString("base64") });
  const listed = (await guest.get("/thread")).text || "";
  const fileId = (name: string) => new RegExp(`${name.replace(".", "\\.")} \\(file ([^)]+)\\)`).exec(listed)?.[1];
  check(/swallow: sent draft\.md \(file [^)]+\)/.test(listed) && fileId("shot.png") && /ab_thread_read\(\{ file \}\) reads a file by its id/.test(listed), "ab_thread_read lists the files handed over in the conversation, each with its id", listed.slice(-400));
  const mdRead = await guest.get(`/thread?file=${encodeURIComponent(fileId("draft.md"))}`);
  check(mdRead.status === 200 && mdRead.text?.includes(md) && /a file from swallow's thread/.test(mdRead.text), "a guest reads a text file the thread's agent handed over", JSON.stringify(mdRead).slice(0, 300));
  const pngRead = await guest.get(`/thread?file=${encodeURIComponent(fileId("shot.png"))}`);
  const saved = /saved on this machine at (.+)$/.exec(pngRead.text || "")?.[1];
  check(saved && fs.existsSync(saved) && fs.readFileSync(saved).equals(png), "and gets any other saved on its machine, at a path it's told", JSON.stringify(pngRead).slice(0, 300));
  check((await guest.get("/thread?file=nothing-here")).status === 404, "a file that isn't there isn't read");
  await owner.post("/api/sessions/guest-ibis-1/messages", { text: "use the draft" });
  const toldFiles = await taken(guest);
  check(/swallow \(Claude\) sent draft\.md \(file [^)]+\)/.test(toldFiles) && /ab_thread_read\(\{ file \}\)/.test(toldFiles), "and hears of a file handed over with its next message", toldFiles);

  // ---------- taken out ----------
  check((await owner.post("/api/sessions/sess-host/guests", { remove: "guest-ibis-1" })).status === 200, "a guest can be taken out of the thread");
  await guest.post("/messages", { text: "Also: the backfill could run in batches." });
  await sleep(300);
  detail = await owner.get("/api/sessions/sess-host");
  check(detail.guests[0].removed && detail.messages.some((m) => /CONCURRENTLY, in a migration/.test(m.text || "")) && !detail.messages.some((m) => /backfill could run/.test(m.text || "")), "what it said stays; what it says after it left doesn't show");
  await owner.post("/api/sessions/sess-host/messages", { text: "and now?" });
  check(!/backfill could run/.test(await taken(host)), "nor does the thread's agent hear it");
  check(!/You're a guest/.test((await guest.get("/context")).text || ""), "and it isn't told it's a guest any more");
  check(((await owner.get("/api/q/feed?filter=all&n=100")).list || []).some((it) => (it.key || it) === "thread:guest-ibis-1"), "its thread is a card of its own again");

  // ---------- a thread that's running joins as it is ----------
  await req("POST", "/api/hello", { body: { proc: "box-3", label: "heron", agent: "Claude", session_id: "sess-api", cwd: project } });
  const heron = agent("box-3");
  await owner.post("/api/sessions/sess-api/messages", { text: "build the reactions endpoint" });
  await taken(heron);
  await heron.post("/messages", { text: "Built it: GET /reactions answers { emoji: count }." });
  await sleep(50);
  check((await alice.post("/api/sessions/sess-host/guests", { thread: "sess-api", text: "hi" })).status === 404, "only the thread's owner brings a thread into it");
  check((await owner.post("/api/sessions/sess-host/guests", { thread: "sess-host", text: "hi" })).status === 400, "a thread can't be its own guest");
  check((await owner.post("/api/sessions/sess-host/guests", { thread: "nowhere", text: "hi" })).status === 404, "nor can one that isn't there join");
  const joined = await owner.post("/api/sessions/sess-host/guests", { thread: "sess-api", text: "@heron what does the counts endpoint answer?" });
  check(joined.status === 200 && joined.guest === "sess-api" && !joined.lid, "@-ing a running thread brings it in as it is: nothing new starts", JSON.stringify(joined));
  const heronGot = await taken(heron);
  check(/^@heron what does the counts endpoint answer\?\n\n/.test(heronGot) && /brought this thread into their thread .* \(swallow, Claude\)/.test(heronGot) && /as a guest: from now on, what you say shows in that thread too/.test(heronGot) && /You go on as you were, where you were/.test(heronGot), "it gets what you wrote as its next message, then the thread it's in now", heronGot.slice(0, 300));
  await heron.post("/messages", { text: "An object, emoji to count: { \"👍\": 3 }." });
  detail = await until(async () => {
    const d = await owner.get("/api/sessions/sess-host");
    return d.messages?.some((m) => m.guest === "sess-api" && m.from === "agent") ? d : null;
  });
  const theirs = (detail?.messages || []).filter((m) => m.guest === "sess-api").map((m) => `${m.from}:${m.text}`);
  if (theirs.length !== 2) console.log(JSON.stringify(theirs));
  check(theirs.length === 2 && /^human:@heron what does/.test(theirs[0]) && /^agent:An object, emoji to count/.test(theirs[1]), "the thread shows what it's asked and says from then on, not what it said before", JSON.stringify(theirs));
  check(detail.guests.find((g) => g.id === "sess-api")?.label === "heron" && (await owner.get("/api/sessions/sess-api")).guest_of?.id === "sess-host", "it's listed in the thread, and its own page says whose guest it is");
  check(((await owner.get("/api/q/feed?filter=all&n=100")).list || []).some((it) => (it.key || it) === "thread:sess-api"), "and it keeps its own card in the feed");
  await owner.post("/api/sessions/sess-host/messages", { text: "use that shape" });
  const heard = await taken(host);
  check(/heron \(Claude\), a guest, said: "An object, emoji to count/.test(heard) && /heron \(Claude\) joined, as a guest/.test(heard) && !/Built it: GET \/reactions/.test(heard) && !/build the reactions endpoint/.test(heard), "the thread's agent hears what it said since it joined, nothing from before", heard);
  const heronRead = (await heron.get("/thread")).text || "";
  check(/heron \(Claude, a guest\): "An object, emoji to count/.test(heronRead) && !/Built it: GET/.test(heronRead), "ab_thread_read has the conversation from when it joined");
  check((await owner.post("/api/sessions/sess-host/guests", { thread: "sess-api", text: "again" })).status === 409, "one that's in it already isn't brought in twice");
  await req("POST", "/api/hello", { body: { proc: "box-4", label: "wren", agent: "Claude", session_id: "sess-ui", cwd: project } });
  check((await owner.post("/api/sessions/sess-ui/guests", { thread: "sess-api", text: "and here?" })).status === 409, "nor into a second thread while it's a guest in one");
  check((await owner.post("/api/sessions/sess-ui/guests", { thread: "sess-host", text: "and you?" })).status === 409, "a thread that has guests of its own doesn't join another");
  check((await owner.post("/api/sessions/sess-host/guests", { remove: "sess-api" })).status === 200 && !/You're a guest/.test((await heron.get("/context")).text || ""), "it can be taken out, and goes on as a thread of its own");
  const back = await owner.post("/api/sessions/sess-host/guests", { thread: "sess-api", text: "@heron one more thing" });
  detail = await owner.get("/api/sessions/sess-host");
  check(back.status === 200 && detail.guests.filter((g) => g.id === "sess-api").length === 1 && !detail.guests.find((g) => g.id === "sess-api").removed, "and brought back, as the guest it was");
  await owner.post("/api/sessions/sess-host/guests", { remove: "sess-api" });

  // ---------- after a restart ----------
  await stop();
  await start();
  detail = await owner.get("/api/sessions/sess-host");
  check(detail.guests?.[0]?.id === "guest-ibis-1" && detail.guests[0].removed && detail.messages.some((m) => m.guest === "guest-ibis-1"), "who was a guest, and what it said, survive a restart");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  if (server) await stop().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
