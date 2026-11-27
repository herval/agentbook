#!/usr/bin/env node
// News on the bell (server/news.ts): what a thread of yours did that's worth hearing about, under the bell until you
// open it. A long turn that ended (its verdict's line, or its reply's first), a pull request of its that merged or
// went bad, and what its agent flagged with ab_update's notify, once a turn. Not a short turn, one that ended needing
// you, one you'd just opened, nor a result like any other. GitHub is a stand-in; a turn is "long" from 1.5 seconds.
// Run: node test/news.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pull } from "./fake-gh-pulls.ts";
import { startGitHub } from "./fake-github.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { bellLine, brief, firstLine, turnNews } from "../server/news.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-news-"));
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

// ---------- the pure parts ----------
check(firstLine("## Done\n\nThe rest.") === "Done" && firstLine("```js\nx\n```\n- **Shipped** the [cart](https://acme.test/cart)") === "Shipped the cart" && firstLine("") === "", "a reply's first line, in plain words");
// A bell line is short and whole.
check(brief("Checkout p95 is 310 ms, down from 820") === "Checkout p95 is 310 ms, down from 820", "a short line is said as written");
check(brief("You can ignore that one. It's a late log from the cart v2 render, showing both lanes finishing at the same time as before.") === "You can ignore that one.", "a long one: its first sentences that fit");
check(brief("Scheduled all 16 liked tracks on the shop's channel for Nov 15 to 18, 4 per day, one per style, with all 4 playlists set.") === "Scheduled all 16 liked tracks on the shop's channel for Nov 15 to 18, 4 per day", "one long sentence: up to its last clause that fits, no ellipsis");
check(brief("x".repeat(120)) === "" && bellLine({ kind: "turn", text: "x".repeat(120) }) === "" && bellLine({ kind: "flag", text: `${"word ".repeat(30)}` }).endsWith("…") && bellLine({ kind: "flag", text: "word ".repeat(30) }).length <= 80, "nothing that fits: a turn only says it finished, a flag is cut at a word");
{
  const at = (s) => new Date(Date.parse("2026-11-14T10:00:00Z") + s * 1000).toISOString();
  const turn = { started: at(0), ended: at(900), min: 600e3 };
  const reply = (shape, text = "All green.\n\nMore.") => [{ from: "human", at: at(0), text: "go" }, { from: "agent", at: at(901), text, ...(shape ? { shape } : {}) }];
  const done = turnNews({}, reply({ verdict: { kind: "done", line: "Checkout p95 is 310 ms" } }), turn);
  check(done?.kind === "turn" && done.verdict === "done" && done.text === "Checkout p95 is 310 ms" && done.mins === 15, "a 15-minute turn that ended Done is news: its verdict's line");
  check(turnNews({}, reply(null), turn)?.text === "All green." && turnNews({}, reply(null), turn).verdict === null, "without a verdict, its reply's first line");
  check(turnNews({}, reply({ verdict: { kind: "needs_you", line: "Pick one" } }), turn) === null && turnNews({}, reply({ verdict: { kind: "blocked", line: "No access" } }), turn) === null, "one that ended needing you or blocked is Needs you's");
  check(turnNews({}, reply(null), { ...turn, ended: at(300) }) === null, "a 5-minute turn isn't");
  check(turnNews({ archived: true }, reply(null), turn) === null && turnNews({ failed: { error: "rate_limit" } }, reply(null), turn) === null && turnNews({}, reply(null), { ...turn, open: true }) === null, "nor an archived thread's, one an error stopped, or one with a question open");
  check(turnNews({}, [{ from: "agent", at: at(-5), text: "Earlier." }], turn)?.text === "", "what it said before the turn isn't its reply");
}

const TOKEN = "ghu_herval_0123456789";
const R = "acme/shop";
const pr = (number, head, o = {}) => pull({ repo: R, number, title: `Work on ${head}`, head, checks: [["lint", "pass"]], files: [[`${head}.js`, 1, 1]], ...o });
const merged = { state: "MERGED", closed: 0, mergedBy: "herval" };
let pulls = { 41: pr(41, "cart"), 44: pr(44, "search") };
const github = () => fs.writeFileSync(GH_FILE, JSON.stringify({ tokens: { [TOKEN]: { login: "herval" } }, repos: { [R]: { pulls: Object.values(pulls) } } }));
const setPull = (n, o) => {
  pulls[n] = pr(n, pulls[n].headRefName, o);
  github();
};
github();
const site = await startGitHub({ ghFile: GH_FILE });

const shop = path.join(HOME, "dev", "shop");
fs.mkdirSync(shop, { recursive: true });

const env = { ...process.env, AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLOUD_SYNC_MS: "600000", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_PR_MS: "300", AGENTBOOK_PR_TICK_MS: "150", AGENTBOOK_PR_HEAD_MS: "300", AGENTBOOK_ARCHIVE_MS: "200", AGENTBOOK_NEWS_TURN_MS: "1500", AGENTBOOK_NEWS_MS: "300" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...(Array.isArray(data) ? { list: data } : data) };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const hello = (proc, session_id, o = {}) => req("POST", "/api/hello", { body: { proc, label: proc, agent: "Claude", session_id, cwd: shop, root: shop, ...o } });
const proc = (name) => ({
  status: (body) => req("POST", `/api/procs/${name}/status`, { body }),
  start: () => req("POST", `/api/procs/${name}/status`, { body: { state: "working", text: "Working", turn: "start" } }),
  end: () => req("POST", `/api/procs/${name}/status`, { body: { state: "idle", text: "Done", turn: "end" } }),
  verdict: (verdict, line) => req("POST", `/api/procs/${name}/shape`, { body: { verdict, line } }),
  say: (text) => req("POST", `/api/procs/${name}/messages`, { body: { text, from: "agent", via: "terminal" } }),
  update: (body) => req("POST", `/api/procs/${name}/updates`, { body }),
});
try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false));
  const me = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const added = async () => (await me.get("/api/q/side")).data?.added || [];
  const news = async (id = null) => (await added()).filter((x) => x.kind === "news" && (!id || x.id === id));
  const LONG = 1900;

  const a = (await hello("box-a", "sess-a", { branch: "main" })).post;
  const A = proc("box-a");
  check(!!a && !(await news()).length, "a thread, and nothing on the bell");

  // ---------- a long turn ends ----------
  await A.start();
  await A.verdict("done", "Quick fix is in");
  await A.say("Fixed the typo.");
  await A.end();
  await sleep(1200);
  check(!(await news()).length, "a short turn that ended isn't news");

  await A.start();
  await sleep(LONG);
  const v = await A.verdict("done", "Checkout p95 is 310 ms, down from 820");
  await A.say("Moved the tax lookup out of the loop.\n\nDetails follow.");
  await A.end();
  const n1 = await until(async () => (await news(a))[0]);
  check(v.status === 200 && n1?.news === "turn" && n1.verdict === "done" && n1.text === "Checkout p95 is 310 ms, down from 820", "a long turn that ended Done is on the bell, with its verdict's line");
  check(!!n1?.title && !!n1.agent && n1.label === "box-a" && !n1.by && !!n1.at, "it says which thread, and its agent");
  await sleep(600);
  check((await news(a)).length === 1, "once");

  check(!n1.seen && (await me.post("/api/bell/seen")).status === 200 && (await news(a)).length === 1 && (await news(a))[0].seen === true, "opening the bell sees it, and it stays");
  check((await me.post("/api/bell/dismiss", { key: `new:news:turn:${a}:`, at: n1.at })).status === 200 && (await me.get("/api/q/side")).data.dismissed[`new:news:turn:${a}:`] === n1.at, "dismissed, the page is told which line is off");
  check((await me.post("/api/bell/clear")).status === 200 && !(await news()).length, "Clear notifications takes them off");

  // Without a verdict: its reply's first line. The reply may come just after the turn's end.
  await A.start();
  await sleep(LONG);
  await A.end();
  await A.say("## Migration ran\n\n42 tables moved.");
  const n2 = await until(async () => (await news(a))[0]);
  check(n2?.news === "turn" && !n2.verdict && n2.text === "Migration ran", "a long turn without a verdict says its reply's first line");
  await me.post("/api/bell/clear");

  // One that ends needing you is on Needs you, not News.
  await A.start();
  await sleep(LONG);
  await A.verdict("needs_you", "Pick a region for the replica");
  await A.say("Two options.");
  await A.end();
  await sleep(1200);
  const asking = (await stateOf(me.get)).sessions.find((s) => s.id === a)?.asking;
  check(!(await news()).length && asking?.kind === "needs_you", "a long turn that ended needing you is on Needs you, not News");

  // One you'd just opened: you saw it end.
  await A.start();
  await sleep(LONG);
  check((await me.get(`/api/q/thread/${a}`)).status === 200, "herval opens the thread");
  await A.verdict("done", "Replica is up in us-east");
  await A.say("Done.");
  await A.end();
  await sleep(1200);
  check(!(await news()).length, "a turn that ends while you have its thread open isn't news");

  // ---------- its agent flags a result ----------
  const b = (await hello("box-b", "sess-b", { branch: "main" })).post;
  const B = proc("box-b");
  await B.start();
  check((await B.update({ text: "Read the logs" })).notified === undefined && (await sleep(500), !(await news(b)).length), "a result like any other stays on its thread");
  const f1 = await B.update({ text: "Found the race: `settle()` runs before the lock", link: "https://example.com/trace/9", notify: true });
  const n3 = await until(async () => (await news(b))[0]);
  check(f1.notified === true && n3?.news === "flag" && n3.text.startsWith("Found the race") && n3.link === "https://example.com/trace/9", "one with notify is on the bell, with its link");
  const f2 = await B.update({ text: "Also fixed a typo", notify: true });
  await sleep(600);
  check(f2.status === 200 && f2.notified === false && (await news(b)).length === 1, "a second in the same turn is told it isn't, and it isn't");
  check(((await stateOf(me.get)).sessions.find((s) => s.id === b)?.updates || []).length === 3, "all three are on the thread");
  await B.end();
  await B.start();
  const f3 = await B.update({ text: "Shipped the fix", notify: true });
  check(f3.notified === true && !!(await until(async () => (await news(b)).length === 2)), "the next turn has its own");
  await B.end();
  await me.post("/api/bell/clear");

  // ---------- a pull request ----------
  check((await me.post("/api/connectors", { kind: "github", api_key: TOKEN, states: [] })).status === 200, "herval connects GitHub");
  const c = (await hello("box-c", "sess-c", { branch: "cart" })).post;
  const d = (await hello("box-d", "sess-d", { branch: "cart" })).post;
  for (const id of [c, d]) await me.post(`/api/sessions/${id}/prs`, { url: `https://github.com/${R}/pull/41` });
  const gh = async (id: string, n: number) => Object.values<Json>((await stateOf(me.get)).sessions.find((x) => x.id === id)?.prs || {}).find((p) => p.number === n)?.gh;
  check(!!(await until(async () => (await gh(c, 41))?.state === "open" && (await gh(d, 41))?.state === "open")), "two threads link #41, open");
  await sleep(600);
  check(!(await news()).some((x) => x.news === "pr"), "a pull request that's open and green isn't news");
  setPull(41, { checks: [["lint", "fail"]] });
  const n4 = await until(async () => (await news()).find((x) => x.news === "pr"));
  await sleep(800);
  const prNews = (await news()).filter((x) => x.news === "pr");
  check(n4?.pr?.kind === "fail" && n4.pr.number === 41 && /check failed on #41/.test(n4.text) && prNews.length === 1, "its checks failing is on the bell, once for the two threads");
  setPull(41, { checks: [["lint", "pass"]] });
  await until(async () => (await gh(c, 41))?.red === false || !(await gh(c, 41))?.red);
  await sleep(800);
  check((await news()).filter((x) => x.news === "pr").length === 1, "checks passing again isn't");
  setPull(41, merged);
  const n5 = await until(async () => (await news()).find((x) => x.pr?.kind === "merged"));
  check(/Merged #41/.test(n5?.text || "") && n5.pr.url.endsWith("/pull/41"), "it merging is");

  // With Auto-archive on, the thread it archives says the merge: not twice.
  await me.post("/api/bell/clear");
  const e = (await hello("box-e", "sess-e", { branch: "search" })).post;
  await me.post(`/api/sessions/${e}/prs`, { url: `https://github.com/${R}/pull/44` });
  await until(async () => (await gh(e, 44))?.state === "open");
  check((await me.post("/api/me/prefs", { auto_archive: true })).status === 200, "herval turns Auto-archive on");
  await sleep(600);
  setPull(44, merged);
  const gone = await until(async () => (await added()).find((x) => x.kind === "archived" && x.id === e));
  await sleep(600);
  check(gone?.why === "#44 merged" && !(await news(e)).length, "a merge Auto-archive archived its thread for is said once, by that line");
} finally {
  server.kill();
  site.close?.();
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
