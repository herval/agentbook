#!/usr/bin/env node
// The feed in the page's API: q/feed answers a page of the feed as records, narrowed
// and counted on the server, and a page that asked with its stream hears what changes in what it got: cards in place,
// what left, what's new above. Run: node test/feed-api.ts

import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-feed-api-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(5100);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const same = (a: unknown, b: unknown) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch (e) {
    console.log(e.message.split("\n").slice(0, 30).join("\n"));
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => unknown, ms = 5000) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await sleep(50);
};
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

type LiveEvent = { event: string; data: Json };
type Stream = { events: LiveEvent[]; raw: string; id: string | null; req?: http.ClientRequest; close?: () => void; of?: (name: string) => LiveEvent[] };
function stream(cookie: string, live: string) {
  const s: Stream = { events: [], raw: "", id: null };
  let buf = "";
  s.req = http.get({ host: "127.0.0.1", port: PORT, path: `/api/live?live=${live}`, headers: { cookie } }, (res) => {
    res.on("data", (d) => {
      s.raw += d;
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (!event) continue;
        const e: LiveEvent = { event, data: JSON.parse(data) };
        s.events.push(e);
        if (event === "hello") s.id = e.data.live;
      }
    });
  });
  s.close = () => s.req.destroy();
  s.of = (name: string) => s.events.filter((e) => e.event === name);
  return s;
}
// The feed as a page holds it: what it shows, in order, their records, what they're doing, and what's new.
type Holder = { v: unknown; list: string[]; records: Record<string, Json>; live: Record<string, Json>; counts: Json; fresh: string[]; next: Json; more?: (q2: Json) => void; apply?: (e: LiveEvent) => void };
function holder(q: Json) {
  const h: Holder = { v: q.watching, list: [...q.list], records: { ...q.records }, live: { ...q.live }, counts: q.counts, fresh: [], next: q.next };
  h.more = (q2: Json) => {
    h.list.push(...q2.list.filter((k) => !h.list.includes(k)));
    Object.assign(h.records, q2.records);
    Object.assign(h.live, q2.live);
    h.next = q2.next;
  };
  h.apply = (e: LiveEvent) => {
    if (e.event !== "feed") return;
    const d = e.data;
    if (d.v !== h.v) return;
    h.list = h.list.map((k) => d.swap?.[k] || k).filter((k) => !d.gone?.includes(k));
    h.list.unshift(...(d.top || []));
    Object.assign(h.records, d.records || {});
    for (const [id, l] of Object.entries(d.live || {})) if (l) h.live[id] = l;
    else delete h.live[id];
    if (d.new) h.fresh = d.new;
    if (d.counts) h.counts = d.counts;
  };
  return h;
}
const settled = () => sleep(1600);
const titles = (q: { list: string[]; records: Record<string, Json> }) => q.list.map((k) => q.records[k].title);

const server = spawnAgentbook({ env, stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);

  // Five threads, started one after another; the first has a transcript (its steps) and an old message.
  const transcript = path.join(HOME, "t-1.jsonl");
  const line = (id: string, cmd: string) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd, description: `Run ${cmd}` } }] } }) + "\n";
  fs.writeFileSync(transcript, line("t1", "ls"));
  const names = ["One importer", "Two keys", "Three docs", "Four tests", "Five deploy"];
  for (const [i, title] of names.entries()) {
    await req("POST", "/api/hello", { body: { proc: `box-${i + 1}`, label: `bird${i + 1}`, agent: "Claude", session_id: `sess-${i + 1}`, cwd: project, ...(i === 0 ? { transcript } : {}) } });
    await req("POST", `/api/procs/box-${i + 1}/post`, { body: { title } });
    await sleep(30);
  }
  for (const text of ["zebracorn was here", "two", "three", "four"]) await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text } });
  await settled();

  // ---------- asking ----------
  const all = await owner.get("/api/q/feed");
  check(all.status === 200 && same(titles(all), [...names].reverse()), "the feed comes newest first, as records");
  check(all.records["thread:sess-1"].last_messages.length === 3 && same(all.records["thread:sess-1"].questions, []), "each thread as its card: its latest messages, and what it asks");
  check(all.counts.states.all === 5 && all.counts.threads === 5 && all.next === null && all.watching === false, "with how many each status has, and nothing after it");
  const p1 = await owner.get("/api/q/feed?n=2");
  const p2 = await owner.get(`/api/q/feed?n=2&after=${p1.next}`);
  const p3 = await owner.get(`/api/q/feed?n=2&after=${p2.next}`);
  check(same([...p1.list, ...p2.list, ...p3.list], all.list) && p3.next === null, "a page at a time, from where the last one ended");
  const found = await owner.get("/api/q/feed?q=zebracorn");
  check(same(titles(found), ["One importer"]) && found.found.posts["sess-1"]?.exact.includes("zebracorn"), "a search finds a thread by a message its card doesn't show");
  check(same(titles(await owner.get("/api/q/feed?q=zebrakorn")), ["One importer"]), "even with a typo");
  check((await owner.get("/api/q/feed?agent=claude")).list.length === 5 && (await owner.get("/api/q/feed?agent=nobody")).list.length === 0, "narrowed to an agent");
  await owner.post("/api/sessions/sess-2/flag", { archived: true });
  await settled();
  const arch = await owner.get("/api/q/feed?filter=archived");
  check(same(titles(arch), ["Two keys"]) && !(await owner.get("/api/q/feed")).list.includes("thread:sess-2"), "archived threads only under Archived");
  check((await owner.get("/api/q/feed")).counts.states.archived === 1, "and counted there");
  check((await alice.get("/api/q/feed")).list.length === 0, "someone else sees none of your private threads");
  check((await owner.get("/api/state")).status === 404 && (await owner.get("/api/stream")).status === 404 && (await owner.get("/api/search?q=keys")).status === 404, "there's no whole view to ask for any more, nor a stream of it");
  const rows = await owner.get("/api/q/threads?ids=sess-2,sess-1,nope");
  check(same(Object.keys(rows.records).sort(), ["thread:sess-1", "thread:sess-2"]) && Array.isArray(rows.records["thread:sess-2"].updates), "whose card a screen asks for by id");
  check(same((await alice.get("/api/q/threads?ids=sess-2")).records, {}), "if it may see it");

  // ---------- a page watching the feed ----------
  const page = stream(owner.cookie, "feed-page-0001");
  await until(() => page.id);
  const q = await owner.get(`/api/q/feed?n=2&live=${page.id}`);
  check(q.watching && same(titles(q), ["Five deploy", "Four tests"]), "a page asks for the feed with its stream");
  const h = holder(q);
  const more = await owner.get(`/api/q/feed?n=2&after=${q.next}&live=${page.id}`);
  h.more(more);
  check(more.watching && same(h.list, ["thread:sess-5", "thread:sess-4", "thread:sess-3", "thread:sess-1"]), "and more of it, which it then watches too");
  let seen = page.events.length;

  await req("POST", "/api/procs/box-4/messages", { body: { from: "agent", text: "SHOWN-message" } });
  await settled();
  let now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  check(now.some((e) => e.event === "feed" && e.data.records?.["thread:sess-4"]?.last_messages.some((m) => m.text === "SHOWN-message")), "a message in a card it shows comes as that card");
  check(!now.some((e) => e.data.gone || e.data.swap || e.data.top), "which stays where it is");

  seen = page.events.length;
  await req("POST", "/api/hello", { body: { proc: "box-6", label: "bird6", agent: "Claude", session_id: "sess-6", cwd: project } });
  await req("POST", "/api/procs/box-6/post", { body: { title: "Six NEWTHREAD" } });
  await settled();
  now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  check(same(h.fresh, ["thread:sess-6"]) && !h.list.includes("thread:sess-6"), "a new thread is new at the top, not put in");
  check(!page.raw.includes("NEWTHREAD") && h.counts.states.all === 5, "without its card, until the page asks; the counts say it's there");

  seen = page.events.length;
  fs.appendFileSync(transcript, line("t2", "npm test"));
  await settled();
  await settled();
  now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  check(now.some((e) => e.event === "feed" && e.data.live?.["sess-1"]), "what a thread it shows is doing comes as that, on its own");

  seen = page.events.length;
  await owner.post("/api/sessions/sess-3/flag", { archived: true });
  await settled();
  now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  check(same(h.list, ["thread:sess-5", "thread:sess-4", "thread:sess-1"]), "a thread archived leaves it, and the rest stay as they were");

  // A thread started from the page goes on top while it starts, and its thread takes its place.
  seen = page.events.length;
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-7");
  const launched = await owner.post("/api/launch", { prompt: "Write the STARTED notes", agent: "claude", root: project });
  await until(() => page.events.slice(seen).some((e) => e.data.top));
  await req("POST", "/api/hello", { body: { proc: "box-7", label: "bird7", agent: "Claude", session_id: "sess-7", cwd: project, launch: launched.lid } });
  await until(() => page.events.slice(seen).some((e) => e.data.swap));
  await settled();
  now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  const lkey = `launch:${launched.lid}`;
  check(now.some((e) => e.data.top?.length === 1 && e.data.records?.[e.data.top[0]]?.prompt === "Write the STARTED notes"), `a start goes on top, with its card${launched.status === 200 ? "" : ` (${launched.status} ${launched.error})`}`);
  const swapped = now.find((e) => e.data.swap)?.data.swap || {};
  const tkey = Object.values(swapped)[0];
  check(!!tkey && h.list[0] === tkey && !h.list.some((k) => k.startsWith("launch:")) && !h.fresh.includes(tkey), `then its thread takes its place, not new (${JSON.stringify(swapped)}, ${lkey})`);

  // A page you make shows as new, as a new thread does.
  seen = page.events.length;
  const made = await owner.post("/api/pages", { title: "Reading list", emoji: "📚" });
  await settled();
  now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  check(!!made.id && h.fresh.includes(`page:${made.id}`), "a page you made is new at the top too");

  const fresh = await owner.get(`/api/q/feed?n=10`);
  check(same(Object.fromEntries(h.list.map((k) => [k, h.records[k]])), Object.fromEntries(h.list.map((k) => [k, fresh.records[k]]))), "after every event, each card the page shows is that card as asked for now");
  check(same(h.counts, fresh.counts), "and so are its counts");
  check(same(Object.keys(h.live).sort(), Object.keys(fresh.live).filter((id) => h.list.includes(`thread:${id}`)).sort()), "and what its threads are doing");

  // Asking again from the top shows what was new, and starts over from there.
  const again = await owner.get(`/api/q/feed?n=10&live=${page.id}`);
  const h2 = holder(again);
  check(again.list.indexOf("thread:sess-6") === again.list.indexOf("thread:sess-7") + 1, "asking again from the top puts the new one in");
  seen = page.events.length;
  await req("POST", "/api/procs/box-6/messages", { body: { from: "agent", text: "AFTER-asking" } });
  await settled();
  now = page.events.slice(seen);
  for (const e of now) h2.apply(e);
  check(h2.records["thread:sess-6"].last_messages.some((m) => m.text === "AFTER-asking") && !now.some((e) => e.data.new?.length), "and from then on it's one it shows");

  // ---------- someone else: his contact ----------
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  const hers = stream(alice.cookie, "feed-page-0002");
  await until(() => hers.id);
  await owner.post("/api/agents/claude/visibility", { visibility: "public" });
  await settled();
  const hq = await alice.get(`/api/q/feed?live=${hers.id}`);
  check(hq.watching && same(hq.list, ["thread:sess-7", "thread:sess-6", "thread:sess-5", "thread:sess-4", "thread:sess-1"]) && hq.list.every((k) => hq.records[k].mine === false), "once the agent is public, they see its threads as others do");
  // Whoever sees a thread sees its work, what it's doing too.
  check(Object.keys(hq.live).every((id) => hq.list.includes(`thread:${id}`)), "and what they're doing, only for threads they see");
  check(!JSON.stringify(hq).includes(project), "nor where they run");
  const hseen = hers.events.length;
  await owner.post("/api/agents/claude/visibility", { visibility: "private" });
  await settled();
  const hh = holder(hq);
  for (const e of hers.events.slice(hseen)) hh.apply(e);
  check(hh.list.length === 0, "and when it goes private again, they're gone from their page");
  check((await alice.post("/api/live/watch", { live: page.id, drop: "feed" })).status === 404, "nobody else can stop what a page of yours watches");

  // ---------- leaving the feed ----------
  check((await owner.post("/api/live/watch", { live: page.id, drop: "feed" })).status === 200, "a page that leaves the feed says so");
  seen = page.events.length;
  await req("POST", "/api/procs/box-5/messages", { body: { from: "agent", text: "AFTER-leaving" } });
  await settled();
  check(page.events.length === seen, "and hears nothing more of it");

  for (const s of [page, hers]) s.close();
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
