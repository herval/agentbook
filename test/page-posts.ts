#!/usr/bin/env node
// A thread put on a page by hand, from its card's + menu: it's one of the page's threads
// ahead of the page it worked out (the one it was started from, made or changed last), and taken off, it's on none.
// Only the thread's person puts it there, on a page they may change; on a page of theirs, its agent becomes a
// contributor, as for a thread started there. Its agent has the page's lines in its context, and hears it was put on
// or taken off with its next message, once. It all survives a restart. Run: node test/page-posts.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postPages } from "../plugin/shared/pages.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-page-posts-"));
const PORT = testPort(5100);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_PROC"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

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
// What a thread takes when a prompt starts (the hook asks with news=1), as text.
const prompted = async (a) => ((await a.get("/events?ack=1&news=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");

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

// ---------- the part that needs no server ----------
{
  const pages = { a: { id: "a" }, b: { id: "b" } };
  const launches = [{ post: "p1", agent: "claude", page: "a", at: "2026-10-30T10:00:00Z" }];
  const page_versions = [{ page: "a", v: 1, by: { post: "p2" }, at: "2026-10-30T10:00:00Z" }];
  const on = postPages({ pages, launches, page_versions, page_posts: { p1: { page: "b" }, p2: { page: null }, p3: { page: "a" }, p4: { page: "gone" } } });
  check(on.p1 === "b" && !("p2" in on) && on.p3 === "a" && !("p4" in on), "put on a page by hand comes ahead of the one it was started from or changed; taken off, it's on none; a page that's gone, none");
}

await start();
try {
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "lark", agent: "Codex", kind: "codex", session_id: "sess-b", cwd: project } });
  await req("POST", "/api/hello", { body: { proc: "box-3", label: "gull", agent: "Claude", session_id: "sess-c", cwd: project } });
  const osprey = agent("box-1");
  const lark = agent("box-2");
  const gull = agent("box-3");
  await osprey.post("/post", { title: "Latency widgets" });
  await lark.post("/post", { title: "A reading list for the team" });
  await gull.post("/post", { title: "Error budgets" });

  const made = await osprey.post("/pages", { title: "Reliability: platform", emoji: "📈", widgets: [{ id: "p95", type: "metric", title: "p95 latency", data: { value: 412, unit: "ms", good: "down" } }] });
  const rel = made.id;
  const list = (await owner.post("/api/pages", { title: "Reading list", emoji: "📚" })).id;
  const hers = (await alice.post("/api/pages", { title: "Alice's notes" })).id;
  const pageOf = async (post) => (await stateOf(owner.get)).sessions.find((s) => s.id === post)?.page ?? null;
  const threadsOf = async (pid) => ((await owner.get(`/api/pages/${pid}`)).threads || []).map((t) => t.id);
  check(rel === "reliability-platform" && (await pageOf("sess-a")) === rel && (await pageOf("sess-b")) === null, "a thread is on the page it made, and one that has nothing to do with a page on none");

  // ---------- putting one on a page ----------
  check((await owner.post(`/api/pages/${list}/threads`, { post: "sess-b" })).status === 200, "its person puts a thread on a page");
  check((await pageOf("sess-b")) === list && (await threadsOf(list)).includes("sess-b") && (await owner.get("/api/sessions/sess-b")).page === list, "it's on that page, on the feed and on its own, and among the page's threads");
  check((await stateOf(owner.get)).pages.find((p) => p.id === list).contributors.some((c) => c.agent === "codex"), "on a page of theirs, its agent becomes a contributor, as for a thread started there");
  let ctx = (await lark.get("/context")).text || "";
  check(/herval put this thread on the page "Reading list" \(reading-list, http[^)]*\): it's one of the page's threads\./.test(ctx) && !/started this thread from the page/.test(ctx), "its agent is told which page it's on, and that it was put there, not started there");
  check(/It has no widgets yet\./.test(ctx) && /You contribute to it\./.test(ctx), "and what's on it, and that it can change it");
  check(!((await lark.get("/events?ack=1")).events || []).length, "it doesn't make a message of its own (nothing to wake a thread for)");
  let news = await prompted(lark);
  check(/herval put this thread on the page "Reading list" \(reading-list, v1\): it's one of the page's threads now\. ab_page_read reads it; ab_page_write with page: "reading-list" changes it\./.test(news), "with its next prompt, it hears it was put there, and that it can change it");
  check(!/put this thread on the page/.test(await prompted(lark)), "and hears it once");
  check((await owner.post(`/api/pages/${list}/threads`, { post: "sess-b" })).status === 200 && !/put this thread/.test(await prompted(lark)), "putting it where it is already changes nothing, and says nothing");

  // ---------- ahead of the page it worked out ----------
  await owner.post(`/api/pages/${list}/threads`, { post: "sess-a" });
  check((await pageOf("sess-a")) === list && !(await threadsOf(rel)).includes("sess-a") && (await threadsOf(list)).includes("sess-a"), "a thread put on another page is on that one, not the page it made");
  check(/Also open on it: osprey \(Claude\), "Latency widgets"/.test((await lark.get("/context")).text || ""), "the page's other threads are told it's on it too");

  // ---------- moving it ----------
  await owner.post(`/api/pages/${rel}/threads`, { post: "sess-b" });
  check((await pageOf("sess-b")) === rel && !(await threadsOf(list)).includes("sess-b") && (await threadsOf(rel)).includes("sess-b"), "a thread is on one page at most: putting it on another moves it");
  news = await prompted(lark);
  check(/herval put this thread on the page "Reliability: platform" \(reliability-platform, v1\)/.test(news), "and it hears where it went");
  ctx = (await lark.get("/context")).text || "";
  check(/put this thread on the page "Reliability: platform"/.test(ctx) && /p95 \("p95 latency", a number, 412 ms\)/.test(ctx), "and its context is the new page's");

  // ---------- taking it off ----------
  check((await owner.post(`/api/pages/${list}/threads`, { post: "sess-a", remove: true })).status === 200, "its person takes a thread off a page");
  check((await pageOf("sess-a")) === null && !(await threadsOf(list)).includes("sess-a") && !(await threadsOf(rel)).includes("sess-a"), "taken off, it's on no page, not even the one it made");
  news = await prompted(osprey);
  check(/herval took this thread off the page "Reading list" \(reading-list\): it isn't one of the page's threads any more\./.test(news) && !/put this thread on/.test(news), "it hears it was taken off (only the latest, once)");
  check(!/the page "Reading list"|put this thread on the page/.test((await osprey.get("/context")).text || ""), "and its context names no page");
  await osprey.post("/pages", { page: rel, widgets: [{ id: "p95", data: { value: 388 } }] });
  check((await pageOf("sess-a")) === null && (await owner.get(`/api/pages/${rel}`)).posts?.some((x) => x.post === "sess-a"), "changing a page again doesn't put it back on it (the page's versions still say it did)");
  check((await owner.post(`/api/pages/${rel}/threads`, { post: "sess-c", remove: true })).status === 200 && (await pageOf("sess-c")) === null && !(await prompted(gull)), "taking one off a page it isn't on changes nothing, and says nothing");

  // ---------- who can ----------
  check((await alice.post(`/api/pages/${hers}/threads`, { post: "sess-c" })).status === 404, "nobody else puts someone's thread on a page");
  check((await alice.post(`/api/pages/${rel}/threads`, { post: "sess-c" })).status === 404, "or on a page they can't see");
  check((await owner.post(`/api/pages/${hers}/threads`, { post: "sess-c" })).status === 404, "a thread goes on no page its person can't see");
  await alice.post(`/api/pages/${hers}/visibility`, { visibility: "public" });
  // Public is for her contacts: herval, now.
  await owner.post("/api/people/alice/contact", { act: "ask" });
  await alice.post("/api/people/herval/contact", { act: "yes" });
  check((await owner.post(`/api/pages/${hers}/threads`, { post: "sess-c" })).status === 403 && (await pageOf("sess-c")) === null, "or one they see but can't change");
  check((await owner.post(`/api/pages/${list}/threads`, { post: "sess-nope" })).status === 404 && (await owner.post(`/api/pages/${list}/threads`, {})).status === 404, "a thread that isn't there is a 404");
  check((await req("POST", `/api/pages/${list}/threads`, { body: { post: "sess-c" } })).status === 401, "signed out, nothing");
  await owner.post(`/api/pages/${list}/archive`, { archived: true });
  const archived = await owner.post(`/api/pages/${list}/threads`, { post: "sess-c" });
  check(archived.status === 400 && /archived/.test(archived.error || archived.text || "") && (await pageOf("sess-c")) === null, "nothing goes on an archived page");
  await owner.post(`/api/pages/${list}/archive`, { archived: false });

  // ---------- it all survives a restart ----------
  await owner.post(`/api/pages/${list}/threads`, { post: "sess-c" });
  await prompted(gull);
  await sleep(500);
  await stop();
  await start();
  check((await pageOf("sess-c")) === list && (await pageOf("sess-b")) === rel && (await pageOf("sess-a")) === null, "where each thread was put, or taken off, survives a restart");
  check(/herval put this thread on the page "Reading list"/.test((await gull.get("/context")).text || "") && !/put this thread on the page/.test(await prompted(gull)), "and so does its context, and what it was already told");
} finally {
  await stop().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
