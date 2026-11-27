#!/usr/bin/env node
// The page's API: a page's own stream, a thread asked for with it, and only what changes in
// that thread coming down it, as its person may see it, on an event stream or a WebSocket. Run: node test/page-api.ts

import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-page-api-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(5000);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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

// One of a page's live events: what it is, its id, and what it says.
interface LiveEvent {
  event: string;
  seq: number;
  data: Json;
}
// A page's live events, on its stream or its socket: as they came, its id (once it's said hello), the ones of a
// name, and the id of the last.
interface Live {
  events: LiveEvent[];
  id: string | null;
  close: () => void;
  of: (name: string) => LiveEvent[];
  last: () => number;
}
// Where a page's stream or socket starts from: the page it is, and the last event it had.
interface From {
  live?: string | null;
  last?: number | null;
}
// A page's stream: its events as they came, and what it makes of the open thread from them.
function stream(cookie: string, { live = null, last = null }: From = {}) {
  let buf = "";
  const q = live ? `?live=${live}` : "";
  const s: Live & { raw: string; status?: number; req: http.ClientRequest } = {
    events: [],
    raw: "",
    id: null,
    close: () => s.req.destroy(),
    of: (name) => s.events.filter((e) => e.event === name),
    last: () => s.events.at(-1)?.seq ?? 0,
    req: http.get({ host: "127.0.0.1", port: PORT, path: `/api/live${q}`, headers: { cookie, ...(last != null ? { "last-event-id": String(last) } : {}) } }, (res) => {
      s.status = res.statusCode;
      res.on("data", (d) => {
        s.raw += d;
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          const seq = Number(block.match(/^id: (.*)$/m)?.[1]);
          if (!event) continue;
          const e: LiveEvent = { event, seq, data: JSON.parse(data) };
          s.events.push(e);
          if (event === "hello") s.id = e.data.live;
        }
      });
    }),
  };
  return s;
}
// The same on a WebSocket, as the page reads it: { id, event, data } each, and how it closed.
function socket(cookie: string, { live = null, last = null, origin = URL }: From & { origin?: string } = {}) {
  const q = new URLSearchParams({ ...(live ? { live } : {}), ...(last != null ? { last: String(last) } : {}) });
  const s: Live & { ws: WebSocket; closed: number | null } = {
    events: [],
    id: null,
    closed: null,
    ws: new WebSocket(`${URL.replace(/^http/, "ws")}/api/live/ws?${q}`, { headers: { ...(cookie ? { cookie } : {}), origin } }),
    close: () => s.ws.close(),
    of: (name) => s.events.filter((e) => e.event === name),
    last: () => s.events.at(-1)?.seq ?? 0,
  };
  s.ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    s.events.push({ event: m.event, seq: m.id, data: m.data });
    if (m.event === "hello") s.id = m.data.live;
  };
  // Node's WebSocket says only "error" when the server turns it down (a browser closes it, 1006).
  s.ws.onerror = () => s.ws.readyState !== WebSocket.OPEN && (s.closed ??= 1006);
  s.ws.onclose = (e) => (s.closed = e.code);
  return s;
}
// A thread as a page holds it: its record and its messages by id, from a query, then each event.
interface Holder {
  record: Json;
  messages: Map<string, Json>;
  live: Json;
  steps: Json;
  apply: (e: LiveEvent) => void;
}
function holder(q: Json): Holder {
  const h: Holder = {
    record: q.records[q.thread],
    messages: new Map(q.messages.map((k: string) => [q.records[k].id, q.records[k]])),
    live: q.live,
    steps: null,
    apply: (e) => {
      const d = e.data;
      if (e.event === "put" && d.records[`thread:${h.record.id}`]) h.record = d.records[`thread:${h.record.id}`];
      if (e.event === "messages") {
        for (const m of d.put) h.messages.set(m.id, m);
        for (const id of d.del) h.messages.delete(id);
      }
      if (e.event === "live") h.live = d.live;
    },
  };
  return h;
}
const settled = () => sleep(1600); // what a thread is doing goes at most once a second

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

  const transcript = path.join(HOME, "t-a.jsonl");
  const line = (id, cmd) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd, description: `Run ${cmd}` } }] } }) + "\n";
  fs.writeFileSync(transcript, line("t1", "ls"));
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: project, transcript } });
  await req("POST", "/api/procs/box-1/post", { body: { title: "Fix the importer" } });
  for (const text of ["one", "two", "three"]) await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: `PRIVATE-${text}` } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: project } });
  await req("POST", "/api/procs/box-2/post", { body: { title: "Rotate the keys" } });
  await settled();

  // ---------- a page opens its stream, then the thread ----------
  const page = stream(owner.cookie, { live: "first-page-0001" });
  await until(() => page.id);
  check(page.id === "first-page-0001" && page.of("hello")[0]?.data.reset === false, `a page's stream says its id first${page.id ? "" : ` (${page.status}: ${page.raw.slice(0, 200)})`}`);
  const q = await owner.get(`/api/q/thread/sess-a?live=${page.id}&n=2`);
  check(q.status === 200 && q.watching && q.thread === "thread:sess-a" && q.records["thread:sess-a"].title === "Fix the importer" && !("messages" in q.records["thread:sess-a"]), "the thread comes as records: the thread, without its messages");
  check(same(q.messages.map((k) => q.records[k].text), ["PRIVATE-two", "PRIVATE-three"]) && !!q.older && q.earlier === 1, "with its latest messages, where the older ones are, and how many");
  const older = await owner.get(`/api/q/thread/sess-a?before=${q.older}`);
  check(same(older.messages.map((k) => older.records[k].text), ["PRIVATE-one"]) && older.older === null && older.earlier === 0 && !older.watching, "older ones on asking, without watching anything more");
  const h = holder(q);
  const seen = page.events.length;

  // Things happen in it, and in another thread.
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "PRIVATE-four" } });
  await req("POST", "/api/procs/box-1/updates", { body: { text: "Fixed the date parser" } });
  await req("POST", "/api/procs/box-2/messages", { body: { from: "agent", text: "OTHER-thread" } });
  fs.appendFileSync(transcript, line("t2", "npm test"));
  await settled();
  await settled();
  const now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  check(now.some((e) => e.event === "messages" && same(e.data.put.map((m) => m.text), ["PRIVATE-four"])), "a new message comes as itself");
  check(now.some((e) => e.event === "put" && e.data.records["thread:sess-a"]?.updates?.some((u) => u.text === "Fixed the date parser")), "a new result, as the thread's record");
  check(!page.raw.includes("OTHER-thread") && !now.some((e) => JSON.stringify(e.data).includes("sess-b")), "and nothing of a thread the page doesn't show");
  check(now.some((e) => e.event === "steps" && e.data.thread === "sess-a" && e.data.steps.length >= 1), "its steps come as its machine sent them");
  check(now.some((e) => e.event === "live" && e.data.thread === "sess-a"), "and what it's doing this moment");
  const fresh = await owner.get("/api/q/thread/sess-a?n=200");
  check(same(h.record, fresh.records[fresh.thread]), "after every event, the page's thread is the thread as asked for now");
  check(same([...h.messages.values()].map((m) => m.id), fresh.messages.slice(-3).map((k) => fresh.records[k].id)) && same([...h.messages.values()], fresh.messages.slice(-3).map((k) => fresh.records[k])), "and so are its messages, from the first it got");
  check(same(h.live, fresh.live), "and what it's doing");
  // Its page's Pin button says whether it's pinned: pinning it there comes as the thread's record, and so does unpinning.
  const pseen = page.events.length;
  await owner.post("/api/pins", { post: "sess-a", pinned: true });
  await settled();
  for (const e of page.events.slice(pseen)) h.apply(e);
  check(h.record.pinned === true && !!h.record.pinned_at && (await owner.get("/api/q/thread/sess-a")).records["thread:sess-a"].pinned === true, "pinning it comes to its page as the thread's record, pinned");
  await owner.post("/api/pins", { post: "sess-a", pinned: false });
  await settled();
  for (const e of page.events.slice(pseen)) h.apply(e);
  check(h.record.pinned === false && h.record.pinned_at === null, "and unpinning it, unpinned");
  await owner.post("/api/pins", { post: "sess-a", pinned: true });
  await settled();
  const steps = await owner.get("/api/sessions/sess-a/steps");
  const last = page.of("steps").at(-1)?.data;
  check(last && same(steps.steps.slice(last.from), last.steps), "the last steps event holds the steps the thread has from where it says");

  // ---------- reconnecting ----------
  page.close();
  await sleep(200);
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "PRIVATE-while-away" } });
  await settled();
  const back = stream(owner.cookie, { live: page.id, last: page.last() });
  await until(() => back.events.length);
  await sleep(200);
  check(!back.of("hello").length && back.of("messages").some((e) => e.data.put.some((m) => m.text === "PRIVATE-while-away")), "a page that reconnects with its id gets what it missed, without starting over");
  const stranger = stream(owner.cookie, { live: "not-a-page", last: 3 });
  await until(() => stranger.id);
  check(stranger.of("hello")[0]?.data.reset === true && stranger.id === "not-a-page", "one the server doesn't know (it restarted) keeps its name, and is told to ask again");
  const hers = stream(alice.cookie, { live: page.id, last: page.last() });
  await until(() => hers.id);
  check(hers.of("hello")[0]?.data.reset === true && hers.id !== page.id && !hers.raw.includes("PRIVATE"), "someone else can't take over a page of yours by its id: theirs gets another");

  // ---------- the same on a WebSocket, as the page reads them ----------
  const ws = socket(owner.cookie, { live: "ws-page-00001" });
  await until(() => ws.id);
  check(ws.id === "ws-page-00001" && ws.of("hello")[0]?.data.reset === false, "a page's live events come on a WebSocket too, its id first");
  const wq = await owner.get(`/api/q/thread/sess-a?live=${ws.id}&n=2`);
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "PRIVATE-on-ws" } });
  await settled();
  check(wq.watching && ws.of("messages").some((e) => e.data.put.some((m) => m.text === "PRIVATE-on-ws")), "and what changes in the thread it shows");
  ws.close();
  await until(() => ws.closed);
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "PRIVATE-ws-away" } });
  await settled();
  const wsBack = socket(owner.cookie, { live: ws.id, last: ws.last() });
  await until(() => wsBack.events.length);
  await sleep(200);
  check(!wsBack.of("hello").length && wsBack.of("messages").some((e) => e.data.put.some((m) => m.text === "PRIVATE-ws-away")), "one that connects again with the last it had gets what it missed, without starting over");
  const evil = socket(owner.cookie, { live: "ws-page-00002", origin: "https://evil.example" });
  const nobody = socket("", { live: "ws-page-00003" });
  await until(() => evil.closed && nobody.closed);
  check(evil.closed && !evil.events.length, "another site can't open one with your sign-in");
  check(nobody.closed === 4401 && !nobody.events.length, "and one without a sign-in is told to sign in");
  const again = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const leaving = socket(again.cookie, { live: "ws-page-00004" });
  await until(() => leaving.id);
  await again.post("/api/auth/logout");
  await until(() => leaving.closed);
  check(leaving.closed === 4401 && !wsBack.closed, "signing out closes that sign-in's, saying so, and not the others'");
  wsBack.close();

  // ---------- leaving the thread ----------
  check((await owner.post("/api/live/watch", { live: back.id || page.id, drop: "open" })).status === 200, "a page that leaves the thread says so");
  const before = back.events.length;
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "PRIVATE-after" } });
  await settled();
  check(back.events.length === before, "and hears nothing more of it");
  check((await alice.post("/api/live/watch", { live: page.id, drop: "open" })).status === 404, "nor can someone else drop what a page of yours watches");

  // ---------- someone else ----------
  check((await alice.get(`/api/q/thread/sess-a?live=${hers.id}`)).status === 404, "someone else asking for a private thread gets a 404");
  // Public is for its owner's contacts.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  await owner.post("/api/agents/claude/visibility", { visibility: "public" });
  const hq = await alice.get(`/api/q/thread/sess-a?live=${hers.id}`);
  // Whoever sees a thread sees its work: what it's doing too.
  check(hq.status === 200 && hq.watching && hq.records["thread:sess-a"].mine === false, "once it's public they see it");
  check(hq.records["thread:sess-a"].pinned === false, "nor that its owner pinned it: pins are each person's own");
  const hseen = hers.events.length;
  fs.appendFileSync(transcript, line("t3", "npm run build"));
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "PUBLIC-five" } });
  await settled();
  await settled();
  const hnow = hers.events.slice(hseen);
  check(hnow.some((e) => e.event === "messages" && e.data.put.some((m) => m.text === "PUBLIC-five")), "their page gets its messages");
  await owner.post("/api/agents/claude/visibility", { visibility: "private" });
  await settled();
  check(hers.events.slice(hseen).some((e) => e.event === "del" && e.data.keys.includes("thread:sess-a")), "and when it goes private again, it's gone from their page");

  for (const s of [back, stranger, hers]) s.close();
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
