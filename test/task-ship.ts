#!/usr/bin/env node
// What a task ships: a task holds the pull requests and branches its threads
// work on and the ones you put in it. Its threads are told about it when one starts (what's in it and where each
// stands), and with their next message what happened to it since (one merging, with the files it changed that the
// thread's branch changes too; checks passing), never what they did themselves or what their own pull request did.
// And the order they land in: each thread is told what its own waits for, and, asked to, agentbook asks each one's
// thread to land it once the one before it has merged. A thread's to-dos for you (ab_todo) stay on that thread unless
// they're for later. GitHub is a stand-in (fake-github.ts); the threads' branches are a real git repo's.
// Run: node test/task-ship.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "./harness-sql.ts";
import { fileURLToPath } from "node:url";
import { applyTaskShip, landingQueue, nextToLand, prStanding, type ShipPart, shipBlock, shipNews } from "../plugin/shared/task-ship.ts";
import type { ShipEvent, ShipPr, State } from "../plugin/shared/types.ts";
import { pull } from "./fake-gh-pulls.ts";
import { startGitHub } from "./fake-github.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-task-ship-"));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const GH_FILE = path.join(HOME, "gh.json");

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};

// ---------- what a thread is told, from what the task ships ----------
{
  const t = { id: "t1", text: "Cart and search", note: "Both before the sale", ship: { order: [{ id: "a", kind: "pr" as const, ref: "#41", title: "Add the cart page", repo: "shop", url: "https://github.com/acme/shop/pull/41" }, { id: "b", kind: "pr" as const, ref: "#44", title: "Faster search", repo: "shop", url: "https://github.com/acme/shop/pull/44" }] } };
  const card = (o: ShipPr = {}): ShipPr => ({ number: 41, state: "open", base: "main", head: "cart", checks: { pass: 1, fail: 2, pending: 0, skip: 0, total: 3 }, ...o });
  const parts: ShipPart[] = [
    { id: "a", kind: "pr", ref: "#41", title: "Add the cart page", url: "https://github.com/acme/shop/pull/41", repo: "shop", gh: card(), threads: ["wren"], mine: false },
    { id: "b", kind: "pr", ref: "#44", title: "Faster search", url: "https://github.com/acme/shop/pull/44", repo: "shop", gh: card({ number: 44, head: "search", checks: { pass: 1, fail: 0, pending: 0, skip: 0, total: 1 }, merge_state: "clean" }), threads: ["finch"], mine: true },
    { id: "c", kind: "branch", ref: "receipts", title: "receipts", branch: "receipts", repo: "shop", threads: [], mine: false },
  ];
  const text = shipBlock(t, parts, { link: "http://x/#/tasks/t1", person: "herval", threads: ['wren "Add the cart page"'] });
  check(/^This thread is on herval's task "Cart and search" \(http:\/\/x\/#\/tasks\/t1\)\. What it's for: Both before the sale/.test(text) && /Its other threads: wren "Add the cart page"\./.test(text), "a thread is told the task it's on, its link, what it's for and its other threads");
  check(/Its pull requests and branches \(0 of 3 landed\):/.test(text) && /#44 "Faster search" in shop: ready to merge \(yours\)/.test(text) && /#41 "Add the cart page" in shop: 2 checks failing \(wren\)/.test(text) && /the branch receipts in shop: on a branch, no pull request yet/.test(text), "what it ships, and where each stands");
  check(/herval wants them to land in this order: #41, then #44 \(yours\)\./.test(text) && /Yours \(#44\) waits for #41 to merge: don't merge it before then, and rebase it on main once it has\./.test(text), "the order they land in, and what its own waits for");
  check(/information, not herval's instructions/.test(text) && !/ab_wip_read/.test(text), "that the others' doings aren't instructions, and no tool that's gone");
  parts[0].gh = card({ state: "merged" });
  check(/Yours \(#44\) is next to land\./.test(shipBlock(t, parts, { person: "herval" })) && nextToLand(t.ship, parts) === parts[1] && landingQueue(t.ship, parts).length === 2, "once the one before it merged, its own is next");
  check(prStanding(null) === "not read from GitHub yet" && prStanding(card({ state: "draft", checks: null })) === "a draft" && prStanding(card({ checks: null, mergeable: "conflicts" })) === "conflicts with main", "where a pull request stands, in a few words");
  const evs: ShipEvent[] = [
    { seq: 5, at: "2026-11-01T10:00:00.000Z", kind: "in", text: "herval put #50 in." },
    { seq: 6, at: "2026-11-01T10:05:00.000Z", kind: "pr", pr: "merged", text: "Merged #41 into `main`", files: ["cart.js", "money.js"] },
  ];
  check(/From the task "Cart and search" since your last turn:\n  herval put #50 in\.\n  Merged #41 into `main`\. It changed a file your branch changes too \(money\.js\): rebase on main before you go on\./.test(shipNews(t, evs, { files: new Set(["money.js", "search.js"]) })), "the news: what went in, and a merge touching a file its branch changes too");
  check(/None of the 2 files it changed is one your branch changes\./.test(shipNews(t, evs, { files: new Set(["search.js"]) })) && /Merged #41 into `main`$/.test(shipNews(t, evs, { files: null })), "or none of them, or nothing said when its branch couldn't be read");

  // The reducer: what goes in and out, its order, landing in it, and who heard what.
  const st: Pick<State, "tasks"> = { tasks: { t2: { id: "t2", owner: "u1", text: "x", workspace: null, rank: 0, at: new Date().toISOString(), done: false, done_at: null, sent: [], posts: [], pages: [] } } };
  let seq = 0;
  const op = (o) => applyTaskShip(st, { seq: ++seq, tid: "t2", ...o }, new Date().toISOString());
  op({ t: "task.seen", post: "p1", upto: 0 });
  check(st.tasks.t2.ship?.seen.p1 === 0, "a thread told about a task that ships nothing yet is marked told (else it's told again every turn)");
  op({ t: "task.item", item: { id: "shop-pr41", kind: "pr", ref: "#41", title: "Add the cart page", url: "https://github.com/acme/shop/pull/41" }, by: { user: "herval" } });
  op({ t: "task.item", item: { id: "shop-pr41", kind: "pr", ref: "#41" }, by: { user: "herval" } });
  const s = st.tasks.t2.ship;
  check(s.items.length === 1 && /herval put #41 in\./.test(s.events.at(-1).text), "a pull request put in once, and the task's history says so");
  op({ t: "task.landing", on: true, by: { user: "herval" } });
  check(!s.landing, "landing in order needs an order");
  op({ t: "task.order", order: [{ id: "shop-pr41", kind: "pr", ref: "#41" }], by: { user: "herval" } });
  op({ t: "task.landing", on: true, by: { user: "herval" } });
  check(!!s.landing && /herval set the order they land in: #41\./.test(s.events.map((e) => e.text).join("\n")), "an order kept, and landing in it on");
  op({ t: "task.item", item: { id: "shop-pr41" }, remove: true, by: { user: "herval" } });
  check(!s.items.length && !s.order.length && /herval took #41 out\./.test(s.events.at(-1).text), "taken out, it's out of the order too");
}

// ---------- the server ----------
const TOKEN = "ghu_herval_0123456789";
const R = "acme/shop";
const cart = (o = {}) => pull({ repo: R, number: 41, title: "Add the cart page", head: "cart", checks: [["lint", "pass"], ["unit", "fail"]], review: "REVIEW_REQUIRED", files: [["cart.js", 40, 2], ["money.js", 3, 1]], ...o });
const search = (o = {}) => pull({ repo: R, number: 44, title: "Faster search", head: "search", review: "APPROVED", reviews: [["joe", "APPROVED", "", 200]], checks: [["lint", "pass"]], files: [["search.js", 5, 9], ["money.js", 1, 1]], updated: 0, ...o });
const github = (pulls) => fs.writeFileSync(GH_FILE, JSON.stringify({ tokens: { [TOKEN]: { login: "herval" } }, repos: { [R]: { pulls } } }));
github([cart(), search()]);
const site = await startGitHub({ ghFile: GH_FILE });

// The shop, with cart's and search's branches: both change money.js.
const shop = path.join(HOME, "dev", "shop");
fs.mkdirSync(shop, { recursive: true });
const git = (...args) => spawnSync("git", ["-C", shop, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
const put = (f, text) => fs.writeFileSync(path.join(shop, f), text);
git("init", "-q", "-b", "main");
put("README", "shop\n");
put("money.js", "export const cents = (n) => n * 100;\n");
git("add", ".");
git("commit", "-q", "-m", "shop");
git("remote", "add", "origin", "git@github.com:acme/shop.git");
git("checkout", "-q", "-b", "search");
put("search.js", "export const find = () => [];\n");
put("money.js", "export const cents = (n) => Math.round(n * 100);\n");
git("add", ".");
git("commit", "-q", "-m", "faster search");
git("checkout", "-q", "main");
git("checkout", "-q", "-b", "cart");
put("cart.js", "export const cart = [];\n");
git("add", ".");
git("commit", "-q", "-m", "cart");
const search_wt = path.join(HOME, "dev", "shop-search");
spawnSync("git", ["-C", shop, "worktree", "add", "-q", search_wt, "search"], { stdio: "ignore" });

const at = () => new Date().toISOString();
const line = (o) => JSON.stringify({ timestamp: at(), cwd: shop, ...o }) + "\n";
const tA = path.join(HOME, "a.jsonl");
fs.writeFileSync(tA, line({ type: "user", message: { content: "make the cart page" } }) + line({ type: "pr-link", prNumber: 41, prUrl: `https://github.com/${R}/pull/41`, prRepository: R }));
const tB = path.join(HOME, "b.jsonl");
fs.writeFileSync(tB, "");

const env = { ...process.env, AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_PR_MS: "300", AGENTBOOK_PR_TICK_MS: "150", AGENTBOOK_PR_HEAD_MS: "300" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_PROC", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
let server = spawnAgentbook({ env, stdio: "ignore" });
async function stop() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}
async function start() {
  server = spawnAgentbook({ env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...(Array.isArray(data) ? { list: data } : data) };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });
// What a thread takes when a prompt starts (the hook asks with news=1), as text.
const prompted = async (a) => ((await a.get("/events?ack=1&news=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");
try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false));
  const me = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const a = (await req("POST", "/api/hello", { body: { proc: "box-a", label: "wren", agent: "Claude", session_id: "sess-a", cwd: shop, root: shop, branch: "cart", transcript: tA } })).post;
  const b = (await req("POST", "/api/hello", { body: { proc: "box-b", label: "finch", agent: "Claude", session_id: "sess-b", cwd: search_wt, root: shop, branch: "search", transcript: tB } })).post;
  const wren = agent("box-a");
  const finch = agent("box-b");
  check((await me.post("/api/connectors", { kind: "github", api_key: TOKEN, states: [] })).status === 200, "herval connects GitHub");
  await sleep(500);
  github([cart(), search()]);
  const side = async () => (await me.get("/api/q/side")).records || {};
  const postOf = async (id) => (await stateOf(me.get)).sessions.find((s) => s.id === id);
  const linked = (s: Json, n: number) => Object.values<Json>(s?.prs || {}).find((p) => p.number === n)?.gh;
  check(!!(await until(async () => linked(await postOf(a), 41) && linked(await postOf(b), 44))), "wren's #41 and finch's #44 are read from GitHub");
  await prompted(finch);
  check(!(await prompted(finch)), "on no task, a thread hears nothing of one");
  check(!Object.keys(await side()).some((k) => k.startsWith("wipset:")) && !(await wren.get("/context")).text?.includes("WIP"), "no WIP is made for a new thread, and none is in what it's told");

  // ---------- a task with two threads ----------
  const id = (await me.post("/api/tasks", { text: "Cart and search", note: "Both before the sale" })).id;
  check(!!id, "herval adds a task");
  await me.post(`/api/tasks/${id}/link`, { post: a });
  await me.post(`/api/tasks/${id}/link`, { post: b });
  const told = await until(async () => {
    const t = await prompted(finch);
    return t.includes("This thread is on herval's task") ? t : null;
  });
  check(/This thread is on herval's task "Cart and search" \([^)]*#\/tasks\//.test(told || "") && /#41 "Add the cart page" in acme\/shop: 1 check failing \(wren\)/.test(told || "") && /#44 "Faster search"[^\n]*\(yours\)/.test(told || ""), "a thread linked to it since it started hears it with its next message: what it ships, and whose");
  check(!(await prompted(finch)), "and once only");
  const ctx = (await finch.get("/context")).text || "";
  check(/This thread is on herval's task "Cart and search"/.test(ctx), "a thread on it is told it when it starts, and after compacting");
  check((await finch.get("/wip")).status === 404, "ab_wip_read is gone");

  // ---------- the order they land in ----------
  const item = (n) => ({ id: `shop-pr${n}`, kind: "pr", ref: `#${n}`, title: "", repo: "shop", url: `https://github.com/${R}/pull/${n}` });
  check((await me.post(`/api/tasks/${id}/landing`, { on: true })).status === 400, "landing in order needs an order first");
  check((await me.post(`/api/tasks/${id}/order`, { order: [item(41), item(44)] })).status === 200, "herval puts #41 before #44");
  check(/herval set the order they land in: #41, then #44\./.test(await prompted(finch)), "finch hears it was set, with its next message");
  check(/Yours \(#44\) waits for #41 to merge/.test((await finch.get("/context")).text || "") && /Yours \(#41\) is next to land\./.test((await wren.get("/context")).text || ""), "and each is told the order when it starts, and what its own waits for");

  // ---------- what happens to what it ships ----------
  await prompted(wren);
  // It tells a change between two reads of its own, so it has to have read them failing first.
  await until(async () => Object.keys((await side())[`task:${id}`]?.ship?.prs || {}).length === 2);
  github([cart({ checks: [["lint", "pass"], ["unit", "pass"]] }), search()]);
  const passing = await until(async () => {
    const t = await prompted(finch);
    return /Checks pass on #41 again/.test(t) ? t : null;
  }, 20000);
  check(!!passing, "checks passing on #41 again: finch hears it with its next message");
  check(!/Checks pass on #41/.test(await prompted(wren)), "wren doesn't: #41 is its own, and it's told that itself");

  // Landing in order: wren is asked to land #41 now.
  check((await me.post(`/api/tasks/${id}/landing`, { on: true })).status === 200, "herval asks them to land in order");
  const asked = await until(async () => {
    const ev = ((await wren.get("/events?ack=1")).events || []).map((e) => e.event.text || "").join("\n");
    return /"Cart and search" lands in order, and #41/.test(ev) ? ev : null;
  });
  check(/Land it: rebase cart on main/.test(asked || "") && /gh pr merge 41/.test(asked || ""), "wren is asked to land #41, first in order");

  // #41 merges: finch hears it, with the file both change, and is asked to land #44.
  github([cart({ state: "MERGED", closed: 5, mergedBy: "herval", checks: [["lint", "pass"], ["unit", "pass"]] }), search()]);
  let took = "";
  await until(async () => {
    took += ((await finch.get("/events?ack=1")).events || []).map((e) => e.event.text || "").join("\n");
    return /lands in order, and #44/.test(took);
  });
  check(/#44 \(https:\/\/github.com\/acme\/shop\/pull\/44\) is next: #41 merged/.test(took), "once #41 merged, finch is asked to land #44");
  check(/Merged #41 into `main`\. It changed a file your branch changes too \(money\.js\): rebase on main before you go on\./.test(took + (await prompted(finch))), "and hears #41 merged with it, with the file it changed that its branch changes too");
  const events = async () => ((await side())[`task:${id}`]?.ship?.events || []).map((e) => e.text).join("\n");
  // Written once the ask has gone (landNext), so finch can have it first.
  check(await until(async () => /Asked wren to land #41, next in order\.[\s\S]*Asked finch to land #44, next in order\./.test(await events())), "its history says whom it asked, in turn");
  const rec = (await side())[`task:${id}`];
  check(rec?.ship?.order?.length === 2 && !rec.ship.events.some((e) => e.files) && !("seen" in rec.ship), "the page gets its order and history, not who heard what nor the files each merge changed");

  github([cart({ state: "MERGED", closed: 5, mergedBy: "herval" }), search({ state: "MERGED", closed: 2, mergedBy: "herval" })]);
  check(!!(await until(async () => /All of it landed, in order\./.test(await events()))), "once #44 merged too, all of it landed in order, and it stops");

  // ---------- put in by hand ----------
  check((await me.post(`/api/tasks/${id}/items`, { item: { id: "shop-receipts", kind: "branch", ref: "receipts", title: "receipts", repo: "shop" } })).status === 200, "herval puts a branch in it by hand");
  check(!!(await until(async () => (await side())[`task:${id}`]?.ship?.items?.some((x) => x.id === "shop-receipts"))) && /herval put the branch receipts in\./.test(await events()), "it's in what the task ships, and its history says so");
  check(/herval put the branch receipts in\./.test(await prompted(finch)), "and its threads hear it went in");

  // ---------- a thread's to-dos stay on the thread ----------
  const todo = await wren.post("/todos", { text: "Review #41 before the sale" });
  check(!!todo.id && todo.thread === true, "ab_todo: a to-do for herval stays on wren's thread");
  const tr = await until(async () => (await side())[`task:${todo.id}`]);
  check(tr?.scope === "thread" && tr.from === a, "on the page, it's a task of the thread's (scope), from wren");
  const later = await wren.post("/todos", { text: "Renew the shop's domain by the 30th", later: true });
  check(!!later.id && !later.thread && !(await until(async () => (await side())[`task:${later.id}`]?.scope, 1500)), "with later: true, it's on herval's Tasks");
  const listed = async (who) => [...((await who.get("/tasks")).open || [])].map((x) => x.id);
  check((await listed(wren)).includes(todo.id) && !(await listed(finch)).includes(todo.id) && (await listed(finch)).includes(later.id), "ab_tasks: wren sees its own to-do, finch doesn't (it's wren's thread's), and both see the one on Tasks");
  check((await wren.post("/todos", { text: "Review #41 before the sale", new: false })).same?.thread === true, "the same to-do twice on a thread isn't added again");
  check(/To-do for the person, on your thread \([^)]*\): Review #41 before the sale/.test((await req("GET", "/api/show?proc=box-a")).text || ""), "ab_show tells wren it's on its thread");
  check((await me.post(`/api/tasks/${todo.id}/later`)).status === 200 && !!(await until(async () => !(await side())[`task:${todo.id}`]?.scope)), "herval moves it to Tasks from the thread");
  check(!!(await until(async () => (await wren.post("/tasks/done", { ids: [later.id] })).results?.[0]?.ok)), "wren ticks off the one it left on Tasks");

  // ---------- agents' to-dos from before go on their threads ----------
  // One left before a thread kept its own is on Tasks with nothing saying it's there on purpose: the server, starting,
  // moves it onto its thread. One left for later, and the one herval moved to Tasks, stay there, restart after restart.
  const kept = await wren.post("/todos", { text: "Pay the shop's hosting invoice", later: true });
  const old = await wren.post("/todos", { text: "Sign the shop's lease renewal" });
  await until(async () => (await side())[`task:${old.id}`]);
  await sleep(500);
  await stop();
  // The page's storage: in agentbook's data folder when its own is server/ there, else in its own.
  const db = new DatabaseSync([path.join(HOME, "storage.db"), path.join(HOME, "server", "storage.db")].find((f) => fs.existsSync(f)));
  const row = JSON.parse((db.prepare("select data from tasks where scope = 'server' and id = ?").get(old.id) as { data: string }).data);
  delete row.scope;
  db.prepare("update tasks set data = ? where scope = 'server' and id = ?").run(JSON.stringify(row), old.id);
  db.close();
  await start();
  const back = await until(async () => {
    const x = await side();
    return x[`task:${old.id}`] && x;
  });
  check(back?.[`task:${old.id}`]?.scope === "thread", "an agent's to-do from before, on Tasks, goes on its thread when the server starts");
  check(back && !back[`task:${kept.id}`]?.scope && back[`task:${kept.id}`]?.later && !back[`task:${todo.id}`]?.scope, "the one left for later stays on Tasks, and so does the one herval moved there");
  await sleep(500);
  await stop();
  await start();
  const again = await until(async () => {
    const x = await side();
    return x[`task:${kept.id}`] && x;
  });
  check(again && !again[`task:${kept.id}`]?.scope && !again[`task:${todo.id}`]?.scope, "and after another restart too");
} finally {
  server.kill();
  site.close();
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
