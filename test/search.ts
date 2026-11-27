#!/usr/bin/env node
// Unified full-text search: FTS5 query/snippet/ranking primitives, SearchStorage
// corruption recovery, /api/q/search across messages/threads/notes/pages/tasks/groups, viewer visibility,
// ?around= message deep-linking, FTS5-backed feed search, and backup exclusion of search.db.
// Run: node test/search.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ftsQuery, plainSnippet } from "../plugin/shared/search.ts";
import { SearchStorage } from "../server/storage/search.ts";
import { extractWidgetText, scoreHit } from "../server/search.ts";
import { backupData } from "../server/backup.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-search-"));
const HUB_PORT = testPort(5900, 80);
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const common = {
  ...process.env,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_HERMES: "0",
  HERMES_HOME: path.join(BASE, "hermes"),
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: path.join(BASE, "fake-claude"),
  CLAUDE_CONFIG_DIR: path.join(BASE, "claude"),
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_MACHINE", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete common[k];
fs.mkdirSync(common.FAKE_CLAUDE_DIR, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000) => {
  for (let t = 0; t < ms; t += 100) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
};
async function req(base: string, method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], raw: text, ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req(HUB, "GET", p, { cookie }), post: (p: string, body?: unknown) => req(HUB, "POST", p, { cookie, body: body || {} }) });
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok);

// ---------- unit tests: query formatting, snippet cleaning, ranking, storage ----------
{
  check(ftsQuery("book sao") === '("book" OR "book"*) AND ("sao" OR "sao"*)', "ftsQuery formats quoted exact + prefix terms");
  check(ftsQuery('a "x') === '"a" AND """x"', "1-char terms stay exact and quotes are escaped");
  check(ftsQuery("  -- ...") === null, "punctuation-only query returns null");
  check(plainSnippet("## **Heading** `code` snake_case __init__ *em*") === "Heading code snake_case __init__ em", "plainSnippet strips markdown while preserving snake_case and __init__");

  const now = 100 * 86_400_000;
  check(scoreHit(-5, -5, now, now) > scoreHit(-5, -5, 0, now), "recent hits outrank older hits with equal relevance");
  check(scoreHit(-5, -5, 0, now) > scoreHit(-1, -5, now, now), "high relevance beats recency");

  const wt = extractWidgetText([
    { id: "w1", type: "table", title: "Deployments", width: "full", stack: null, v: 1, at: "", by: { user: "h" }, data: { columns: ["Service", "Status"], rows: [["billing-api", { status: "ok", text: "Healthy" }]] } },
    { id: "w2", type: "doc", title: "Runbook", width: "half", stack: null, v: 1, at: "", by: { user: "h" }, data: { text: "Restart the **checkout** worker" } },
  ]);
  check(wt.includes("Deployments") && wt.includes("billing-api") && wt.includes("checkout"), "extractWidgetText collects widget titles, table cells, and doc text");

  const dbPath = path.join(BASE, "unit-search.db");
  const idx = new SearchStorage(dbPath);
  const longText = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")} needle ${Array.from({ length: 80 }, (_, i) => `tail${i}`).join(" ")}`;
  idx.upsertBatch([
    { scope: "device:d1", kind: "msg", parent: "thread:t1", item: "m1", at: now, role: 0, text: "Book the flight to São Paulo for ENG-123" },
    { scope: "device:d1", kind: "msg", parent: "thread:t1", item: "m2", at: now - 1000, role: 1, text: "Booked an ebook via deploy/fly-release.sh" },
    { scope: "device:d1", kind: "msg", parent: "thread:t2", item: "m3", at: now, role: 1, text: longText },
  ]);
  check(idx.query(ftsQuery("sao paulo")!).map((r) => r.item).join() === "m1", "unicode61 folds accents");
  const bookHits = idx.query(ftsQuery("book")!).map((r) => r.item);
  check(bookHits[0] === "m1" && bookHits.includes("m2"), "exact word ranks above prefix match");
  check(idx.query(ftsQuery("ENG-123")!).map((r) => r.item).join() === "m1", "quoted hyphenated ticket matches");
  check(idx.query(ftsQuery("deploy/fly-release.sh")!).map((r) => r.item).join() === "m2", "quoted file path matches");
  const snip = idx.snippet(longText, ftsQuery("needle")!);
  check(!!snip && snip.includes("needle") && snip.includes("…") && snip.split(/\s+/).length < 40, `snippet cuts long text around match (${snip})`);

  // Contentless delete + update + scope purge.
  idx.upsertBatch([{ scope: "device:d1", kind: "msg", parent: "thread:t1", item: "m1", at: now, role: 0, text: "Updated to Rio de Janeiro" }]);
  check(idx.query(ftsQuery("sao")!).length === 0 && idx.query(ftsQuery("rio")!).length === 1, "updating a doc removes old FTS tokens");
  idx.deleteParent("thread:t2");
  check(idx.query(ftsQuery("needle")!).length === 0, "deleteParent clears FTS tokens");
  idx.deleteScope("device:d1");
  check(idx.query(ftsQuery("rio")!).length === 0, "deleteScope clears every doc in scope");
  idx.close();

  // Corrupt search.db wipes and starts over cleanly.
  const badPath = path.join(BASE, "corrupt-search.db");
  fs.writeFileSync(badPath, "definitely not a sqlite database");
  const recovered = new SearchStorage(badPath);
  recovered.upsertBatch([{ scope: "server", kind: "note", parent: "note:n1", item: "", at: now, text: "walrus recovered" }]);
  check(recovered.query(ftsQuery("walrus")!).length === 1, "corrupt search.db is wiped and rebuilt cleanly");
  recovered.close();
}

// ---------- server end-to-end tests ----------
const running: Agentbook[] = [];
try {
  const hubHome = path.join(BASE, "hub");
  running.push(spawnAgentbook({ env: { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: hubHome, AGENTBOOK_MACHINE: "hub" }, stdio: ["ignore", "ignore", "inherit"] }));
  check(!!(await healthy(HUB)), "hub starts");

  const herval = as((await req(HUB, "POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req(HUB, "POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);

  const cwd = path.join(BASE, "dev", "app");
  fs.mkdirSync(cwd, { recursive: true });
  const mkThread = async (id: string, label: string, title: string) => {
    const proc = `box-${id}`;
    await req(HUB, "POST", "/api/hello", { body: { proc, label, agent: "Claude", session_id: id, cwd, root: cwd, repo: "app" } });
    await req(HUB, "POST", `/api/procs/${proc}/post`, { body: { title } });
    return {
      say: (text: string) => req(HUB, "POST", `/api/procs/${proc}/messages`, { body: { from: "agent", text } }),
      asked: (text: string) => req(HUB, "POST", `/api/procs/${proc}/messages`, { body: { from: "human", text } }),
      result: (text: string) => req(HUB, "POST", `/api/procs/${proc}/updates`, { body: { text } }),
    };
  };

  // Seed thread messages (including a long thread for ?around= testing), note, page, task, group, and talk.
  const t1 = await mkThread("t-search", "heron", "Billing architecture");
  await t1.asked("Can we fix the **quasar** retry timeout?");
  await t1.say("Fixed the quasar timeout in `billing_worker.ts` for São Paulo.");
  await t1.result("Shipped quasar backoff patch");

  const tLong = await mkThread("t-long", "kite", "Long conversation");
  let midTarget = "";
  for (let i = 0; i < 65; i++) {
    const r = await tLong.say(i === 10 ? "Found the rare albatross token right here." : `Padding message number ${i}`);
    if (i === 10) midTarget = r.mid || r.id || "";
  }

  const note = await herval.post("/api/notes", { title: "Launch checklist", text: "Verify **platypus** webhook signatures before release." });
  const aliceNote = await alice.post("/api/notes", { title: "Alice private diary", text: "Secret platypus recipe for alice only." });
  const publicAliceNote = await alice.post("/api/notes", { title: "Alice public guide", text: "Public narwhal handbook." });
  await alice.post(`/api/notes/${publicAliceNote.id}/visibility`, { visibility: "public" });
  // Public is for her contacts.
  await herval.post("/api/people/alice/contact", { act: "ask" });
  await alice.post("/api/people/herval/contact", { act: "yes" });

  const page = await herval.post("/api/pages", { title: "Ops Overview", about: "Production telemetry" });
  await herval.post(`/api/pages/${page.id}/write`, {
    widgets: [{ id: "w1", type: "doc", title: "Alerts", data: { text: "Monitor the **ocelot** queue depth daily." } }],
  });
  const task = await herval.post("/api/tasks", { text: "Rotate API keys", note: "Includes the **meerkat** staging cluster." });
  const group = await herval.post("/api/groups", { name: "Platform Crew", brief: "Coordinating **flamingo** rollout." });
  const talk = await herval.post("/api/talks", { text: "Discuss the **capybara** migration schedule." });

  // Search messages + deep-link href + markdown stripping.
  const qMsg = await herval.get("/api/q/search?q=quasar");
  const msgHit = (qMsg.hits || []).find((h: Json) => h.kind === "message" && h.id === "t-search");
  check(qMsg.status === 200 && !!msgHit, "GET /api/q/search finds message hits");
  check(!!msgHit?.itemId && msgHit?.href === `#/threads/t-search?msg=${encodeURIComponent(msgHit.itemId)}`, `message hit links to ?msg= (${msgHit?.href})`);
  check(msgHit?.snippet && !msgHit.snippet.includes("**") && !msgHit.snippet.includes("`"), `message snippet strips markdown (${msgHit?.snippet})`);

  // Accent-folded message search.
  const qAccent = await herval.get("/api/q/search?q=sao+paulo");
  check((qAccent.hits || []).some((h: Json) => h.id === "t-search"), "GET /api/q/search folds accents");

  // Notes, pages, tasks, groups, talks all searchable + visibility enforced.
  const qNote = await herval.get("/api/q/search?q=platypus");
  check((qNote.hits || []).some((h: Json) => h.kind === "note" && h.id === note.id), "finds note body content");
  check(!(qNote.hits || []).some((h: Json) => h.id === aliceNote.id), "never leaks another user's private note");

  const qPublic = await herval.get("/api/q/search?q=narwhal");
  check((qPublic.hits || []).some((h: Json) => h.kind === "note" && h.id === publicAliceNote.id), "finds another user's public note");

  const qPage = await herval.get("/api/q/search?q=ocelot");
  check((qPage.hits || []).some((h: Json) => h.kind === "page" && h.id === page.id), "finds page widget content");

  const qTask = await herval.get("/api/q/search?q=meerkat");
  check((qTask.hits || []).some((h: Json) => h.kind === "task" && h.id === task.id), "finds task note body");

  const qGroup = await herval.get("/api/q/search?q=flamingo");
  check((qGroup.hits || []).some((h: Json) => h.kind === "group" && h.id === group.id), "finds group brief content");

  const qTalk = await herval.get("/api/q/search?q=capybara");
  check((qTalk.hits || []).some((h: Json) => h.id === talk.id), "finds talk messages");

  // Alice cannot see herval's private threads, pages, tasks, or groups.
  const aliceSeesNothing = await Promise.all([
    alice.get("/api/q/search?q=quasar"),
    alice.get("/api/q/search?q=ocelot"),
    alice.get("/api/q/search?q=meerkat"),
    alice.get("/api/q/search?q=flamingo"),
  ]);
  check(aliceSeesNothing.every((r) => (r.hits || []).length === 0), "another user sees none of herval's private content");

  // Live edit updates index immediately.
  await herval.post(`/api/notes/${note.id}/write`, { text: "Replaced with **pangolin** verification." });
  const afterEditOld = await herval.get("/api/q/search?q=platypus");
  const afterEditNew = await herval.get("/api/q/search?q=pangolin");
  check((afterEditOld.hits || []).length === 0 && (afterEditNew.hits || []).some((h: Json) => h.id === note.id), "editing a note updates the FTS index immediately");

  // ?around= deep-link returns a window containing an older message.
  const qLong = await herval.get("/api/q/search?q=albatross");
  const longHit = (qLong.hits || []).find((h: Json) => h.id === "t-long");
  const targetId = longHit?.itemId || midTarget;
  check(!!targetId, "long thread hit returns its message id");
  const narrowLatest = await herval.get(`/api/q/thread/t-long?n=20`);
  check(!(narrowLatest.messages || []).includes(`message:${targetId}`), "without ?around=, latest 20 omits the older hit");
  const aroundRes = await herval.get(`/api/q/thread/t-long?n=20&around=${encodeURIComponent(targetId)}`);
  check((aroundRes.messages || []).includes(`message:${targetId}`), "with ?around=, thread query includes the matched message");

  // FTS5-backed /api/q/feed?q= finds matching thread with excerpt.
  const feedRes = await herval.get("/api/q/feed?q=quasar");
  check((feedRes.list || []).includes("thread:t-search") && !!feedRes.found?.posts?.["t-search"]?.hit?.text, "FTS5-backed /api/q/feed?q= finds thread and returns hit excerpt");

  // backupData skips search.db (rebuildable cache).
  const serverDir = path.join(hubHome, "server");
  check(fs.existsSync(path.join(serverDir, "search.db")), "search.db exists in SERVER_HOME");
  const backupDir = path.join(BASE, "backup");
  backupData({ from: serverDir, to: backupDir, storage: path.join(hubHome, "storage.db") });
  check(!fs.existsSync(path.join(backupDir, "search.db")), "backupData excludes rebuildable search.db");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  for (const p of running) p.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
