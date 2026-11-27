#!/usr/bin/env node
// A workspace's pull requests, for its WIP: what pulls.ts makes of GitHub's answers (from a stand-in for GitHub's
// API, fake-github.ts), and the server's side of it: the list in the page's state (a branch your machines have
// brings its pull request in), one pull request in full and its diffs, who may see them, and answering it on
// GitHub as you. Run: node test/pulls.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffOf, pull } from "./fake-gh-pulls.ts";
import { startGitHub } from "./fake-github.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-pulls-"));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const GH_FILE = path.join(HOME, "gh.json");
const ghCalls = () => (fs.existsSync(`${GH_FILE}.calls.jsonl`) ? fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const TOKEN = "ghu_herval_0123456789"; // herval's GitHub connection's

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};

// acme/shop on GitHub: two open pull requests of yours (one failing, one ready), a draft, one someone else
// opened that a post of yours linked, one of theirs nobody linked, one merged yesterday and one merged a
// month ago.
const R = "acme/shop";
const pulls = [
  pull({ repo: R, number: 41, title: "Add the cart page", head: "cart", mergeable: "CONFLICTING", mergeState: "DIRTY", review: "CHANGES_REQUESTED", body: "## What\n\nA cart page.\n\n<!-- a template comment -->\nCloses #12.", checks: [["lint", "pass"], ["unit", "fail", { required: true }], ["e2e", "pending"], ["deploy preview", "skip"]], comments: [["vercel[bot]", "<!-- bot -->Preview is **ready**: https://shop-41.vercel.app", 3000]], reviews: [["maria", "CHANGES_REQUESTED", "The totals round wrong.", 2400], ["joe", "COMMENTED", "", 2000]], threads: [{ path: "cart.js", line: 12, hunk: [" function total(items) {", "-  return sum(items.map(round));", "+  return round(sum(items));"], comments: [["maria", "Round after summing, not before.", 2400], ["herval", "On it.", 2300]] }, { path: "cart.css", line: 3, resolved: true, comments: [["joe", "Use the token.", 2000]] }], files: [["cart.js", 40, 2], ["cart.css", 12, 0, "ADDED"]], commits: [["Add the cart page", 7000], ["Totals", 3600]], requested: ["acme/frontend"], fork: ["Prices in cents", 8000, 12] }),
  pull({ repo: R, number: 44, title: "Faster search", head: "search", review: "APPROVED", checks: [["lint", "pass"], ["unit", "pass"], ["preview", "cancel"]], files: [["search.js", 5, 9]], commits: [["Index the names", 900]], updated: 300 }),
  pull({ repo: R, number: 45, title: "Try a new header", head: "header", draft: true, mergeState: "DRAFT", files: [["header.css", 3, 3]] }),
  pull({ repo: R, number: 38, title: "Their fix for the footer", head: "footer", author: "maria", checks: [["lint", "pass"]], files: [["footer.css", 1, 1]] }),
  pull({ repo: R, number: 39, title: "Someone else's work", head: "theirs", author: "joe" }),
  pull({ repo: R, number: 30, title: "Shipping rates", head: "rates", state: "MERGED", closed: 86400, updated: 86000, mergedBy: "maria", files: [["rates.js", 20, 4]] }),
  pull({ repo: R, number: 12, title: "An old one", head: "old", state: "MERGED", closed: 30 * 86400, updated: 30 * 86400 }),
];
fs.writeFileSync(GH_FILE, JSON.stringify({ tokens: { [TOKEN]: { login: "herval", name: "Herval" } }, repos: { [R]: { pulls, diffs: { 41: diffOf([["cart.js", ["const total = round(sum(items));"]], ["cart.css", [".cart { padding: 8px; }"]]]) } } } }));
const github = await startGitHub({ ghFile: GH_FILE });
process.env.AGENTBOOK_GITHUB_API_URL = github.url;
const { githubRepo, listPulls, pullDetail, pullDiff, pullNumbers } = await import("../server/integrations/pulls.ts");
const hers = { token: TOKEN };

// ---------- what pulls.ts makes of GitHub ----------
check(githubRepo("github.com/acme/shop")?.slug === "acme/shop" && !githubRepo("gitlab.com/acme/shop") && !githubRepo("github.com/acme"), "a repo on GitHub is told apart from one elsewhere");
check(JSON.stringify(pullNumbers("github.com/acme/shop", ["https://github.com/Acme/Shop/pull/38", "https://github.com/acme/shop/pull/38", "https://github.com/acme/other/pull/2", "https://example.com/acme/shop/pull/9"])) === "[38]", "a post's links to the repo's pull requests give their numbers, once each");
const list = await listPulls("github.com/acme/shop", { extra: [38, 999], ...hers });
const n = (k) => list.pulls.find((p) => p.number === k);
check(list.login === "herval" && JSON.stringify(list.pulls.map((p) => p.number).sort()) === "[30,38,41,44,45]" && !list.heads.length, "the list is yours, the ones your posts linked, and the ones closed this week; not others' or old ones, and a gone one is no trouble");
check(n(41).state === "open" && n(45).state === "draft" && n(30).state === "merged" && n(41).head === "cart" && n(41).base === "main", "each says if it's open, a draft or merged, and its branch");
check(JSON.stringify(n(41).checks) === JSON.stringify({ pass: 1, fail: 1, pending: 1, skip: 1, total: 4 }) && n(41).mergeable === "conflicts" && n(41).merge_state === "dirty" && n(41).review === "changes" && n(41).threads === 1 && n(41).comments === 1, "an open one counts its checks, says it conflicts and changes were asked for, and counts what's unresolved");
check(n(44).review === "approved" && n(44).merge_state === "clean" && n(44).checks.fail === 0 && n(44).checks.skip === 1 && n(44).add === 5 && n(44).del === 9 && n(44).files === 1, "a ready one says so, with what it changes");
check(n(41).fork?.subject === "Prices in cents" && n(41).fork.behind === 12 && n(41).base_head?.subject === "Latest on main" && n(44).fork?.sha === n(44).base_head.sha && n(44).fork.behind === 0 && n(30).fork === null, "an open one says where it left main and how far main moved since, from GitHub's compare; a merged one doesn't");
const compares = ghCalls().filter((c) => c.api === "compare").length;
await listPulls("github.com/acme/shop", { extra: [38, 999], ...hers });
check(compares === 4 && ghCalls().filter((c) => c.api === "compare").length === compares, "and GitHub is asked that once for its two commits, not on every read");
const withHeads = await listPulls("github.com/acme/shop", { heads: ["old", "theirs", "cart", "nowhere"], ...hers });
check(JSON.stringify(withHeads.pulls.map((p) => p.number).sort((a, b) => a - b)) === "[12,30,39,41,44,45]" && JSON.stringify(withHeads.heads.sort((a, b) => a - b)) === "[12,39,41]", "a branch your machines have brings its pull request in, whoever opened it and however long ago it merged");
const full = await pullDetail("github.com/acme/shop", 41, hers);
check(full.checks_list[0].name === "unit" && full.checks_list[0].state === "fail" && full.checks_list[0].required && full.checks_list.at(-1).state === "skip" && full.checks_list[1].state === "pending", "in full, its checks come failing first, then running, passed and skipped");
const ready = await pullDetail("github.com/acme/shop", 44, hers);
const cancelled = ready.checks_list.find((c) => c.name === "preview");
check(cancelled?.state === "skip" && cancelled.conclusion === "cancelled" && ready.checks.fail === 0, "a cancelled check (a newer run took its place, or someone stopped it) isn't a failing one");
check(full.reviews_list.length === 1 && full.reviews_list[0].state === "changes_requested" && full.reviewers[0].who === "maria" && full.requested[0] === "frontend", "its reviews that decide something, who asked for changes, and who it waits on");
check(full.threads_list.length === 2 && full.threads_list[0].path === "cart.js" && full.threads_list[0].comments.length === 2 && full.threads_list[1].resolved, "its review threads, with what was said on each");
check(full.comments_list[0].who === "vercel" && full.commits_list.length === 2 && full.files_list[1].kind === "create" && full.body.startsWith("## What"), "its comments, commits, files and description");
const fileDiff = await pullDiff("github.com/acme/shop", 41, "cart.js", full.sha, hers);
const again = await pullDiff("github.com/acme/shop", 41, "cart.css", full.sha, hers);
check(fileDiff.hunks?.[0]?.lines.includes("+const total = round(sum(items));") && again.hunks?.length === 1 && ghCalls().filter((c) => c.api === "diff").length === 1, "a file's diff comes from the pull request's diff, read once for the commit it's at");
check(ghCalls().every((c) => c.token && c.as === "herval"), "all of it read from GitHub's API as herval, with his token");
const missing = await pullDetail("github.com/acme/shop", 999, hers).catch((e) => e);
const other = await listPulls("gitlab.com/acme/shop", hers).catch((e) => e);
check(missing.status === 404 && /no pull request #999/.test(missing.message) && /isn't a repo on GitHub/.test(other.message), "one that isn't there, or a repo that isn't on GitHub, says so");
const nobody = await listPulls("github.com/acme/shop").catch((e) => e);
const refused = await listPulls("github.com/acme/shop", { token: "ghu_not_any_more" }).catch((e) => e);
check(/connect GitHub on Connectors/.test(nobody.message) && /turned the token down/.test(refused.message) && /sign in with GitHub again/.test(refused.message) && !ghCalls().some((c) => !c.token), "without a token GitHub isn't asked at all, and one GitHub turns down says to sign in again");
fs.writeFileSync(`${GH_FILE}.fail`, "");
const down = await listPulls("github.com/acme/shop", hers).catch((e) => e);
fs.rmSync(`${GH_FILE}.fail`);
check(/GitHub said: Server Error/.test(down.message), "GitHub failing says so");

// ---------- the server ----------
// A checkout of acme/shop, and a post on its cart branch that links #38.
const shop = path.join(HOME, "dev", "shop");
fs.mkdirSync(shop, { recursive: true });
const git = (...args) => spawnSync("git", ["-C", shop, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(shop, "README"), "shop\n");
git("add", ".");
git("commit", "-q", "-m", "shop");
git("remote", "add", "origin", "git@github.com:acme/shop.git");
git("branch", "cart");
// Two worktrees in its folder: one on a branch whose pull request merged a month ago, one on joe's.
for (const b of ["old", "theirs"]) {
  git("branch", b);
  git("worktree", "add", "-q", path.join(".claude", "worktrees", b), b);
}
const transcript = path.join(HOME, "t.jsonl");
fs.writeFileSync(transcript, JSON.stringify({ type: "pr-link", prNumber: 38, prUrl: "https://github.com/acme/shop/pull/38", prRepository: R, timestamp: new Date().toISOString() }) + "\n");

const env = { ...process.env, AGENTBOOK_GITHUB_API_URL: github.url, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
const server = spawnAgentbook({ env, stdio: "ignore" });
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...(Array.isArray(data) ? { list: data } : data) };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false));
  const me = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: shop, root: shop, branch: "cart", transcript } });
  await until(async () => (await stateOf(me.get)).sessions?.[0]?.prs?.["https://github.com/acme/shop/pull/38"]);

  const ws = await me.post("/api/workspaces", { repo: "acme/shop" });
  const mine = async () => (await stateOf(me.get)).workspaces.find((w) => w.id === ws.id);
  check(ws.status === 200 && !("pulls" in (await mine())) && !("wip" in (await mine())) && (await stateOf(me.get)).github === null && !ghCalls().some((c) => !c.token), "without GitHub connected, a repo on GitHub is its branches: not even the machine's owner gets pull requests");
  check((await me.post("/api/connectors", { kind: "github", api_key: TOKEN, states: [] })).status === 200 && (await stateOf(me.get)).github === "connector", "herval connects GitHub");
  // Its branches: cart (its post's, #41), and the two worktrees'.
  const shown = await until(async () => ((await mine())?.pulls?.heads?.length === 3 ? mine() : null), 30000);
  check(shown?.pulls.login === "herval" && JSON.stringify(shown.pulls.pulls.map((p) => p.number).sort((a, b) => a - b)) === "[12,30,38,39,41,44,45]" && !shown.pulls.error, "then it carries its pull requests in the page's state: yours, the one its post linked, and its branches', joe's and a month-old one too");
  const again2 = await me.post("/api/workspaces", { repo: "https://github.com/acme/shop", wip: "pulls" });
  check(again2.existing && again2.id === ws.id && !("wip" in (await mine())), "adding it again is the one you have, with nothing to pick: its WIP is its branches and their pull requests");
  const folderWs = await me.post("/api/workspaces", { folder: { path: path.join(HOME, "dev") } });
  check(!("pulls" in ((await stateOf(me.get)).workspaces.find((w) => w.id === folderWs.id) || {})) && (await me.post(`/api/workspaces/${ws.id}`, { wip: "pulls" })).status === 400, "a folder has no pull requests, and an edit has to rename it");

  const q = (number, extra = "") => `workspace=${encodeURIComponent(ws.id)}&number=${number}${extra}`;
  const d = await me.get(`/api/pulls?${q(41)}`);
  check(d.status === 200 && d.number === 41 && d.checks_list.length === 4 && d.threads_list.length === 2 && d.repo === "acme/shop", "one opens in full");
  const df = await me.get(`/api/pulls/diff?${q(41, `&path=cart.css&sha=${d.sha}`)}`);
  check(df.status === 200 && df.hunks?.[0]?.lines.includes("+.cart { padding: 8px; }"), "and a file of it opens to its diff");
  check((await alice.get(`/api/pulls?${q(41)}`)).status === 404 && !(await stateOf(alice.get)).workspaces.length && (await me.get(`/api/pulls?${q("x")}`)).status === 400 && (await me.get(`/api/pulls?workspace=${folderWs.id}&number=1`)).status === 400, "only its person can open its pull requests, by number, in a repo on GitHub");

  // Answering it on GitHub, as herval: a reply on a review thread (resolving it with that), Undo, a comment on it.
  const t41 = d.threads_list[0];
  check(t41.hunk?.at(-1) === "+  return round(sum(items));" && t41.hunk.length === 3 && t41.can.reply && t41.can.resolve && t41.comments[0].n != null && d.node && d.comments_list[0].bot && d.comments_list[0].who === "vercel", "its review threads carry the lines they're on, whether you may answer them, and what to answer them by; a bot's comment says it's a bot's");
  const reply = await me.post("/api/pulls/reply", { workspace: ws.id, number: 41, thread: t41.id, body: "Rounded after summing now.", resolve: true });
  const t1 = (await me.get(`/api/pulls?${q(41)}`)).threads_list.find((x) => x.id === t41.id);
  check(reply.status === 200 && reply.resolved === true && reply.reply?.url && t1.resolved && t1.comments.at(-1).body === "Rounded after summing now." && t1.comments.at(-1).who === "herval", "a reply goes on its thread on GitHub, as herval, and resolves it with that");
  const undo = await me.post("/api/pulls/resolve", { workspace: ws.id, number: 41, thread: t41.id, resolved: false });
  check(undo.status === 200 && undo.resolved === false && !(await me.get(`/api/pulls?${q(41)}`)).threads_list.find((x) => x.id === t41.id).resolved, "Undo opens it again");
  const said = await me.post("/api/pulls/comment", { workspace: ws.id, number: 41, body: "@maria have another look?" });
  const c1 = (await me.get(`/api/pulls?${q(41)}`)).comments_list.at(-1);
  check(said.status === 200 && said.comment?.url && c1.body === "@maria have another look?" && c1.who === "herval" && !c1.bot, "a comment goes on the pull request itself");
  check(ghCalls().filter((c) => /mutation/.test(c.query || "")).length === 4 && ghCalls().filter((c) => /mutation/.test(c.query || "")).every((c) => c.as === "herval"), "all of it written as herval, with his token");
  const empty = await me.post("/api/pulls/reply", { workspace: ws.id, number: 41, thread: t41.id, body: "  " });
  const which = await me.post("/api/pulls/reply", { workspace: ws.id, number: 41, body: "hi" });
  const gone = await me.post("/api/pulls/reply", { workspace: ws.id, number: 41, thread: "PRRT_gone", body: "hi" });
  const notHers = await alice.post("/api/pulls/comment", { workspace: ws.id, number: 41, body: "hi" });
  check(empty.status === 400 && which.status === 400 && gone.status === 404 && notHers.status === 404, "an empty reply, one that names no thread, one on a thread that's gone, or one in someone else's workspace, is refused");
  // A sign-in with GitHub whose app may only read pull requests: GitHub refuses, and it says what to change.
  const ghData = JSON.parse(fs.readFileSync(GH_FILE, "utf8"));
  ghData.tokens[TOKEN].write = false;
  fs.writeFileSync(GH_FILE, JSON.stringify(ghData));
  const ro = await me.post("/api/pulls/comment", { workspace: ws.id, number: 41, body: "hi" });
  ghData.tokens[TOKEN].write = true;
  fs.writeFileSync(GH_FILE, JSON.stringify({ ...JSON.parse(fs.readFileSync(GH_FILE, "utf8")), tokens: ghData.tokens }));
  check(ro.status === 403 && /Read and write/.test(ro.error) && /personal access token/.test(ro.error), "when GitHub won't let it write as him, it says what to change");

  // GitHub out of reach: the list stays, saying why. (A post linking one it didn't have reads it again.)
  fs.writeFileSync(`${GH_FILE}.fail`, "");
  const transcript2 = path.join(HOME, "t2.jsonl");
  fs.writeFileSync(transcript2, JSON.stringify({ type: "pr-link", prNumber: 45, prUrl: "https://github.com/acme/shop/pull/45", prRepository: R, timestamp: new Date().toISOString() }) + "\n");
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: shop, root: shop, branch: "header", transcript: transcript2 } });
  const failing = await until(async () => ((await mine())?.pulls?.error ? mine() : null));
  check(/GitHub said/.test(failing?.pulls.error || "") && failing.pulls.pulls.length === 7 && failing.pulls.heads.length === 3, "when GitHub fails, it says why and keeps what it had");
  fs.rmSync(`${GH_FILE}.fail`);
} finally {
  server.kill();
  github.close();
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
