#!/usr/bin/env node
// The page's chrome in its API: q/side answers everything but threads as records,
// with what screens used to count from every thread, and rows of the threads that are open or that it names; a page
// that asked with its stream hears what changes in it, record by record, as its person may see it.
// Run: node test/side-api.ts

import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-side-api-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(5200);
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
const same = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch (e) {
    console.log(e.message.split("\n").slice(0, 30).join("\n"));
    return false;
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond, ms = 5000) => {
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

// One event a page heard: its name and what it said.
interface LiveEvent {
  event: string;
  data: Json;
}
// A page's stream: what it heard, all of it as it came (`raw`), and the id the server gave it.
interface Live {
  events: LiveEvent[];
  raw: string;
  id: string | null;
  req: http.ClientRequest;
  close: () => void;
  of: (name: string) => LiveEvent[];
}
function stream(cookie: string, live: string) {
  let buf = "";
  const s: Live = {
    events: [],
    raw: "",
    id: null,
    req: http.get({ host: "127.0.0.1", port: PORT, path: `/api/live?live=${live}`, headers: { cookie } }, (res) => {
      res.on("data", (d) => {
        s.raw += d;
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (!event) continue;
          const e = { event, data: JSON.parse(data) };
          s.events.push(e);
          if (event === "hello") s.id = e.data.live;
        }
      });
    }),
    close: () => s.req.destroy(),
    of: (name) => s.events.filter((e) => e.event === name),
  };
  return s;
}
// The chrome as a page holds it: its records, from q/side, then each `side` event.
interface Holder {
  v: unknown;
  records: Record<string, Json>;
  order: Record<string, unknown>;
  data: Json;
  apply: (e: LiveEvent) => void;
}
function holder(q: Json) {
  const h: Holder = {
    v: q.watching,
    records: { ...q.records },
    order: { ...q.order },
    data: q.data,
    apply: (e) => {
      if (e.event !== "side" || e.data.v !== h.v) return;
      Object.assign(h.records, e.data.put || {});
      for (const k of e.data.del || []) delete h.records[k];
      Object.assign(h.order, e.data.order || {});
      if (e.data.data) h.data = e.data.data;
    },
  };
  return h;
}
const settled = () => sleep(1600);
const keysOf = (q: Json, type: string) => Object.keys(q.records).filter((k) => k.startsWith(`${type}:`)).sort();

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

  for (const [i, title] of ["One importer", "Two keys", "Three docs"].entries()) {
    await req("POST", "/api/hello", { body: { proc: `box-${i + 1}`, label: `bird${i + 1}`, agent: "Claude", session_id: `sess-${i + 1}`, cwd: project } });
    await req("POST", `/api/procs/box-${i + 1}/post`, { body: { title } });
    await sleep(30);
  }
  await req("POST", "/api/procs/box-1/updates", { body: { text: "PRIVATE-result" } });
  await req("POST", "/api/procs/box-2/todos", { body: { text: "Rotate the staging keys", new: false } });
  await settled();

  // ---------- asking ----------
  const q = await owner.get("/api/q/side");
  const claude = q.records["agent:claude"];
  check(q.status === 200 && !!claude && claude.sessions === 3 && Array.isArray(claude.thread_models) && Array.isArray(claude.thread_repos) && claude.latest === "sess-3", "agents come with what they've done: their threads, the latest");
  check(!("repos" in claude), "and `repos` stays what the agent's record says, that it clones a repo where it runs: a list there gave every agent a Repo menu");
  check(same(keysOf(q, "thread"), ["thread:sess-1", "thread:sess-2", "thread:sess-3"]) && !("updates" in q.records["thread:sess-1"]) && !q.raw?.includes("PRIVATE-result"), "a row of each open thread, not its results");
  check(!JSON.stringify(q).includes("PRIVATE-result"), "nor anywhere else");
  const task = Object.values<Json>(q.records).find((r) => r.text === "Rotate the staging keys");
  check(!!task && task.from === "sess-2", "its tasks, each with the thread that left it");
  check(same(q.order.thread, ["thread:sess-3", "thread:sess-2", "thread:sess-1"]) && q.data && "machine" in q.data, "in the feed's order, with what isn't a record");
  check(!keysOf(q, "thread").length || !Object.keys(q.records).some((k) => k.startsWith("session")), "and no sessions list");

  await owner.post("/api/sessions/sess-1/flag", { archived: true });
  await owner.post("/api/sessions/sess-2/flag", { archived: true });
  await settled();
  const q2 = await owner.get("/api/q/side");
  check(same(keysOf(q2, "thread"), ["thread:sess-2", "thread:sess-3"]), "an archived thread has no row, unless something names it (sess-2 left a task)");
  check(q2.records["agent:claude"].sessions === 3, "and still counts as its agent's");
  check(same(keysOf(await alice.get("/api/q/side"), "thread"), []) && !keysOf(await alice.get("/api/q/side"), "agent").length && !keysOf(await alice.get("/api/q/side"), "task").length, "someone else sees none of it");

  // ---------- around a thread ----------
  await req("POST", "/api/procs/box-3/messages", { body: { from: "agent", text: "bird2 already rotated them; see bird2's notes" } });
  await settled();
  const card = (await owner.get("/api/q/feed")).records["thread:sess-3"];
  check(same(card.names, { bird2: { id: "sess-2", agent: "claude", label: "bird2", title: "Two keys" } }), "a card has the threads its words name, as links");
  const t3 = await owner.get("/api/q/thread/sess-3");
  check(t3.names?.bird2?.id === "sess-2" && t3.names?.bird1?.id === "sess-1", "a thread's page has every name around it");
  check(same(t3.others.map((r) => r.id), ["sess-2", "sess-1"]) && !("updates" in t3.others[0]), "and its agent's other threads, as rows");
  const made = await owner.post("/api/groups", { name: "Keys", post: "sess-2" });
  check(made.status === 200 && (await owner.get(`/api/groups/${made.id || "keys"}`)).threads?.some((r) => r.id === "sess-2" && r.archived), "a group's own answer has rows of its threads, archived ones too");

  // ---------- a page watching it ----------
  const page = stream(owner.cookie, "side-page-0001");
  await until(() => page.id);
  const w = await owner.get(`/api/q/side?live=${page.id}`);
  check(!!w.watching, "a page asks for it with its stream");
  const h = holder(w);
  let seen = page.events.length;
  await req("POST", "/api/hello", { body: { proc: "box-4", label: "bird4", agent: "Claude", session_id: "sess-4", cwd: project } });
  await req("POST", "/api/procs/box-4/post", { body: { title: "Four tests" } });
  await settled();
  let now = page.events.slice(seen);
  for (const e of now) h.apply(e);
  const ev = now.find((e) => e.event === "side")?.data;
  check(!!ev?.put?.["thread:sess-4"] && ev.put["agent:claude"]?.sessions === 4 && ev.order?.thread?.[0] === "thread:sess-4", "a new thread comes as its row, its agent's new counts, and where it goes");
  check(!ev?.put?.["thread:sess-3"] && !ev?.put?.["task:" + task.id], "and nothing that didn't change");
  seen = page.events.length;
  await req("POST", "/api/procs/box-3/messages", { body: { from: "agent", text: "PRIVATE-message" } });
  await settled();
  check(!page.raw.includes("PRIVATE-message"), "what a thread says doesn't come here");
  await owner.post("/api/sessions/sess-3/flag", { archived: true });
  await settled();
  for (const e of page.events.slice(seen)) h.apply(e);
  const fresh = await owner.get("/api/q/side");
  check(same(h.records, fresh.records) && same(h.order, fresh.order) && same(h.data, fresh.data), "after every event, the page's chrome is the chrome as asked for now");
  check(!("thread:sess-3" in h.records), "an archived thread's row goes");

  // ---------- someone else ----------
  const hers = stream(alice.cookie, "side-page-0002");
  await until(() => hers.id);
  const hw = await alice.get(`/api/q/side?live=${hers.id}`);
  const hh = holder(hw);
  // Public is for its owner's contacts.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  await owner.post("/api/agents/claude/visibility", { visibility: "public" });
  await settled();
  for (const e of hers.events) hh.apply(e);
  check(hh.records["agent:claude"]?.mine === false && hh.records["thread:sess-4"]?.mine === false && !keysOf({ records: hh.records }, "task").length, "once the agent is public, they get it and its open threads as others see them, not your tasks");
  check(same(hh.records, (await alice.get("/api/q/side")).records), "and theirs is what they'd ask for now");
  await owner.post("/api/agents/claude/visibility", { visibility: "private" });
  await settled();
  for (const e of hers.events) hh.apply(e);
  check(!hh.records["agent:claude"] && !hh.records["thread:sess-4"], "and when it goes private again, they're gone");

  for (const s of [page, hers]) s.close();
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
