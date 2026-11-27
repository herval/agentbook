#!/usr/bin/env node
// Your settings for your threads, on your profile: Auto-archive (a thread whose pull request merged, or whose branch
// landed on main, is archived once its turn ends, and the bell says so) and Private terminals (a session agentbook
// didn't start gets no thread: its machine keeps it off, a chat with an OpenClaw agent on Discord too). Both off
// until you turn them on. GitHub and OpenClaw are stand-ins.
// Run: node test/thread-prefs.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pull } from "./fake-gh-pulls.ts";
import { startGitHub } from "./fake-github.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-thread-prefs-"));
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

const TOKEN = "ghu_herval_0123456789";
const R = "acme/shop";
// acme/shop's pull requests: #38 merged a day ago, #50 (old), #41 (cart), #44 (search) and #46 (header) open until
// the test merges them.
const pr = (number, head, o = {}) => pull({ repo: R, number, title: `Work on ${head}`, head, checks: [["lint", "pass"]], files: [[`${head}.js`, 1, 1]], ...o });
const merged = { state: "MERGED", closed: 0, mergedBy: "herval" };
let pulls = { 38: pr(38, "footer", { ...merged, closed: 86400 }), 50: pr(50, "old"), 41: pr(41, "cart"), 44: pr(44, "search"), 46: pr(46, "header") };
const github = () => fs.writeFileSync(GH_FILE, JSON.stringify({ tokens: { [TOKEN]: { login: "herval" } }, repos: { [R]: { pulls: Object.values(pulls) } } }));
const mergeIt = (n) => {
  pulls[n] = pr(n, pulls[n].headRefName, merged);
  github();
};
github();
const site = await startGitHub({ ghFile: GH_FILE });

const shop = path.join(HOME, "dev", "shop");
fs.mkdirSync(shop, { recursive: true });
const git = (...args) => spawnSync("git", ["-C", shop, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(shop, "README"), "shop\n");
git("add", ".");
git("commit", "-q", "-m", "shop");
git("remote", "add", "origin", "git@github.com:acme/shop.git");
// "land": a branch with a commit, landed on main by the test (no pull request), in a worktree of its own.
const landDir = path.join(HOME, "dev", "shop-land");
git("worktree", "add", "-q", "-b", "land", landDir);
fs.writeFileSync(path.join(landDir, "land.js"), "land\n");
spawnSync("git", ["-C", landDir, "add", "land.js"], { stdio: "ignore" });
spawnSync("git", ["-C", landDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "land it"], { stdio: "ignore" });

// OpenClaw: an agent with no sessions yet; a chat on Discord comes once Private terminals is on.
const CLAW = path.join(HOME, "openclaw");
fs.mkdirSync(CLAW);
const CLAW_STATE = path.join(CLAW, "state.json");
const claw = (fn) => {
  const s = fs.existsSync(CLAW_STATE) ? JSON.parse(fs.readFileSync(CLAW_STATE, "utf8")) : { agents: [{ id: "main", name: "main", identity: { name: "jefepato", emoji: "🦆" }, workspace: path.join(HOME, "claw-ws") }], sessions: [], presence: [], approvals: [], questions: [], skills: {}, cron: { jobs: [], runs: [] } };
  fn(s);
  fs.writeFileSync(`${CLAW_STATE}.t`, JSON.stringify(s));
  fs.renameSync(`${CLAW_STATE}.t`, CLAW_STATE);
};
claw(() => {});

const env = { ...process.env, AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW_BIN: path.join(TEST, "fake-openclaw.ts"), FAKE_OPENCLAW_DIR: CLAW, AGENTBOOK_OPENCLAW_SYNC_MS: "300", AGENTBOOK_CLOUD_SYNC_MS: "600000", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_PR_MS: "300", AGENTBOOK_PR_TICK_MS: "150", AGENTBOOK_PR_HEAD_MS: "300", AGENTBOOK_ARCHIVE_MS: "200" };
for (const k of ["AGENTBOOK_OPENCLAW", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...(Array.isArray(data) ? { list: data } : data) };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const hello = (proc, session_id, o = {}) => req("POST", "/api/hello", { body: { proc, label: proc, agent: "Claude", session_id, cwd: shop, root: shop, ...o } });
try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false));
  const me = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const postOf = async (id) => (await stateOf(me.get)).sessions.find((s) => s.id === id);
  const added = async () => (await me.get("/api/q/side")).data?.added || [];

  // ---------- the settings ----------
  check(JSON.stringify((await me.get("/api/auth/me")).prefs) === '{"auto_archive":false,"private_terminals":false}', "both settings start off");
  check((await me.post("/api/me/prefs", {})).status === 400 && (await me.post("/api/me/prefs", { auto_archive: "yes" })).status === 400, "a change says which setting, true or false");

  // ---------- Auto-archive ----------
  check((await me.post("/api/connectors", { kind: "github", api_key: TOKEN, states: [] })).status === 200, "herval connects GitHub");
  const old = (await hello("box-o", "sess-o", { branch: "old" })).post;
  const a = (await hello("box-a", "sess-a", { branch: "cart" })).post;
  const b = (await hello("box-b", "sess-b", { branch: "search" })).post;
  const c = (await hello("box-c", "sess-c", { branch: "header" })).post;
  const d = (await hello("box-d", "sess-d", { branch: "land", cwd: landDir, root: shop })).post;
  const e = (await hello("box-e", "sess-e", { branch: "footer" })).post;
  for (const [id, n] of [[old, 50], [a, 41], [b, 44], [c, 46], [e, 38]]) await me.post(`/api/sessions/${id}/prs`, { url: `https://github.com/${R}/pull/${n}` });
  await sleep(1200);
  mergeIt(50);
  const read = await until(async () => {
    const s = await stateOf(me.get);
    const gh = (id: string, n: number) => Object.values<Json>(s.sessions.find((x) => x.id === id)?.prs || {}).find((p) => p.number === n)?.gh;
    return gh(old, 50)?.state === "merged" && gh(a, 41)?.state === "open" && gh(c, 46) ? s : null;
  });
  check(!!read, "GitHub says #50 merged and the rest open");
  await sleep(600);
  check(!(await postOf(old)).archived, "while it's off, a thread whose pull request merged stays");

  const on = await me.post("/api/me/prefs", { auto_archive: true });
  check(on.status === 200 && on.prefs.auto_archive && !on.prefs.private_terminals && (await me.get("/api/auth/me")).prefs.auto_archive, "herval turns Auto-archive on");
  await sleep(1200);
  check(!(await postOf(old)).archived && !(await added()).some((x) => x.kind === "archived"), "a thread whose work was in before it was on stays as it is");
  check(!(await postOf(c)).archived, "one whose pull request is open stays");
  check(!(await postOf(e)).archived, "one whose pull request merged before it started (it only looked at it) stays");

  // #41 merges while wren is between turns: archived, and the bell says so.
  mergeIt(41);
  const A = await until(async () => ((await postOf(a))?.archived ? postOf(a) : null));
  check(!!A, "a thread is archived once its pull request merges");
  const bell = (await added()).find((x) => x.kind === "archived" && x.id === a);
  check(bell?.why === "#41 merged" && bell.title && bell.agent && !bell.by, "the bell says which thread, and why: its pull request merged");

  // finch is mid-turn when #44 merges: archived once its turn ends.
  await req("POST", "/api/procs/box-b/status", { body: { state: "working", text: "Merging", turn: "start" } });
  mergeIt(44);
  await until(async () => Object.values<Json>((await postOf(b))?.prs || {}).some((p) => p.gh?.state === "merged"));
  await sleep(800);
  check(!(await postOf(b)).archived, "not while it's working");
  await req("POST", "/api/procs/box-b/status", { body: { state: "idle", text: "Done", turn: "end" } });
  check(!!(await until(async () => (await postOf(b))?.archived)), "once its turn ends, it is");

  // A thread asking you something waits for the answer.
  const q = await req("POST", "/api/procs/box-c/questions", { body: { title: "Merge it?", options: ["Yes", "No"] } });
  mergeIt(46);
  await until(async () => Object.values<Json>((await postOf(c))?.prs || {}).some((p) => p.gh?.state === "merged"));
  await sleep(800);
  check(!(await postOf(c)).archived, "not while it asks you something");
  const qid = (await stateOf(me.get)).questions.find((x) => x.title === "Merge it?")?.id;
  check(q.status === 200 && (await me.post(`/api/questions/${encodeURIComponent(qid)}/answer`, { value: "Yes" })).status === 200, "herval answers it");
  check(!!(await until(async () => (await postOf(c))?.archived)), "then it's archived");

  check((await me.post(`/api/sessions/${a}/flag`, { archived: false })).status === 200, "herval brings wren back");
  await req("POST", "/api/procs/box-a/status", { body: { state: "idle", text: "Done", turn: "end" } });
  await sleep(1000);
  check(!(await postOf(a)).archived, "and it stays: each thread once");

  // "land" lands on main without a pull request.
  git("merge", "-q", "--ff-only", "land");
  await req("POST", "/api/procs/box-d/status", { body: { state: "idle", text: "Landed", turn: "end" } });
  const D = await until(async () => ((await postOf(d))?.archived ? postOf(d) : null), 20000);
  check(!!D, "a thread whose branch landed on main is archived too");
  check((await added()).find((x) => x.id === d)?.why === "land landed on main", "the bell says its branch landed");

  await me.post("/api/bell/clear");
  check(!(await added()).some((x) => x.kind === "archived"), "clearing the bell takes them off");

  // ---------- Private terminals ----------
  const t1 = await hello("box-t1", "sess-t1", { branch: "main" });
  check(!!t1.post, "while it's off, a session started in a terminal is a thread");
  check((await me.post("/api/me/prefs", { private_terminals: true })).prefs.private_terminals, "herval turns Private terminals on");
  await sleep(500);
  const t2 = await hello("box-t2", "sess-t2", { branch: "main" });
  check(t2.post === null && t2.private === true, "a session started in a terminal gets no thread");
  const st = await req("POST", "/api/procs/box-t2/status", { body: { state: "working", text: "x", turn: "start" } });
  check(st.status === 404 && /Private terminals/.test(st.error), "its hooks hear it's kept off agentbook");
  await sleep(600);
  const S = await stateOf(me.get);
  check(!S.sessions.some((s) => s.id === "sess-t2") && !S.text.includes("sess-t2"), "nothing of it reaches the server");
  check((await req("POST", "/api/procs/box-t1/status", { body: { state: "idle", text: "still here", turn: "end" } })).status === 200, "a thread from before stays one");
  // On agentbook already, and not started in it: off every list while it's on, there by its link.
  await req("POST", "/api/procs/box-t1/questions", { body: { title: "Ship it?", options: ["Yes", "No"] } });
  await sleep(400);
  const S1 = await stateOf(me.get);
  check(!S1.sessions.some((s) => s.id === "sess-t1") && !S1.questions.some((q) => q.post === "sess-t1"), "a thread from a terminal that was on agentbook already is off the lists, its questions too");
  check((await me.get("/api/sessions/sess-t1")).id === "sess-t1", "it's still there by its link");
  // A chat with an OpenClaw agent on Discord wasn't started in agentbook either.
  const DISCORD = "agent:main:discord:channel:7";
  claw((s) => s.sessions.push({ key: DISCORD, sessionId: "s-d7", agentId: "main", createdAt: Date.now(), updatedAt: Date.now(), hasActiveRun: false, messages: [{ role: "user", content: "@jefepato what's the plan", timestamp: Date.now(), __openclaw: { transport: { channel: "discord" } } }, { role: "assistant", content: [{ type: "text", text: "Ship the cart first." }], timestamp: Date.now() }] }));
  await sleep(2000);
  const S2 = await stateOf(me.get);
  check(S2.agents.some((a) => a.id === "openclaw-main") && !S2.sessions.some((s) => s.id === DISCORD) && !S2.text.includes("Ship the cart first"), "a chat with an OpenClaw agent on Discord gets no thread, and nothing of it reaches the server");
  const clawLaunch = await me.post("/api/launch", { prompt: "Draft the newsletter", agent: "openclaw-main" });
  const clawKey = `agent:main:agentbook-${clawLaunch.lid}`;
  check(clawLaunch.status === 200 && !!(await until(async () => (await stateOf(me.get)).sessions.find((s) => s.id === clawKey))), "a thread started in agentbook with the OpenClaw agent is one");
  // Started in agentbook: its thread, as ever.
  fs.writeFileSync(path.join(env.FAKE_CLAUDE_DIR, "next.txt"), "sess-l1");
  const launched = await me.post("/api/launch", { prompt: "Fix the footer", root: shop, agent: "claude" });
  await until(async () => (await stateOf(me.get)).launches.find((l) => l.id === launched.lid));
  const l1 = await hello("box-l1", "sess-l1", { launch: launched.lid, branch: "main" });
  check(launched.status === 200 && l1.post === "sess-l1", "a session agentbook started is a thread");
  // One that says hello before Claude Code has said its id is waited for.
  fs.writeFileSync(path.join(env.FAKE_CLAUDE_DIR, "next.txt"), "sess-l2");
  fs.writeFileSync(path.join(env.FAKE_CLAUDE_DIR, "slow.txt"), "1200");
  const second = me.post("/api/launch", { prompt: "Fix the header", root: shop, agent: "claude" });
  await sleep(400);
  const l2 = await hello("box-l2", "sess-l2", { branch: "main" });
  check(l2.post === "sess-l2" || l2.deferred === true, "one whose start agentbook is still waiting on isn't kept off");
  await second;
  const l2b = l2.post ? l2 : await hello("box-l2", "sess-l2", { branch: "main" });
  check(l2b.post === "sess-l2", "and it gets its thread once Claude Code says its id");
  // Off again: the next hello of one kept off makes its thread.
  check((await me.post("/api/me/prefs", { private_terminals: false })).prefs.private_terminals === false, "herval turns Private terminals off");
  await sleep(500);
  check((await hello("box-t2", "sess-t2", { branch: "main" })).post === "sess-t2", "a session in a terminal is a thread again");
  const S3 = await stateOf(me.get);
  check(S3.sessions.some((s) => s.id === "sess-t1") && S3.questions.some((q) => q.post === "sess-t1"), "the one from before is back on the lists, with its question");
  claw((s) => (s.sessions.find((x) => x.key === DISCORD).updatedAt = Date.now()));
  check(!!(await until(async () => (await stateOf(me.get)).sessions.find((s) => s.id === DISCORD && s.title !== undefined))), "and the Discord chat gets its thread");
  const d7 = await until(async () => {
    const d = await me.get(`/api/sessions/${encodeURIComponent(DISCORD)}`);
    return d.messages?.some((m) => /Ship the cart first/.test(m.text)) && d;
  });
  check(!!d7, "with its conversation from while it was kept off");
} finally {
  server.kill();
  site.close();
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
