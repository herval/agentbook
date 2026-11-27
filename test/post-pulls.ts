#!/usr/bin/env node
// A post's pull requests: which ones it links (opened, worked on, its branch's, its agent's, yours), where each
// stands on GitHub (read as the machine's owner, from a stand-in for GitHub's API), the line a change makes on the
// post, and unlinking one.
// Run: node test/post-pulls.ts

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
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-post-pulls-"));
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

const TOKEN = "ghu_herval_0123456789"; // herval's GitHub connection's
const R = "acme/shop";
// acme/shop's pull requests, at some moment: #41 on "cart" goes from failing to merged as the test goes.
const cart = (o = {}) => pull({ repo: R, number: 41, title: "Add the cart page", head: "cart", checks: [["lint", "pass"], ["unit", "fail"], ["e2e", "fail"]], review: "REVIEW_REQUIRED", requested: ["maria"], files: [["cart.js", 40, 2]], ...o });
const others = [
  pull({ repo: R, number: 38, title: "Their fix for the footer", head: "footer", author: "maria", checks: [["lint", "pass"]], files: [["footer.css", 1, 1]] }),
  pull({ repo: R, number: 39, title: "Someone else's work", head: "theirs", author: "joe" }),
  pull({ repo: R, number: 45, title: "Try a new header", head: "header", draft: true, mergeState: "DRAFT", files: [["header.css", 3, 3]] }),
];
const search = (o = {}) => pull({ repo: R, number: 44, title: "Faster search", head: "search", review: "APPROVED", reviews: [["joe", "APPROVED", "", 200]], checks: [["lint", "pass"]], files: [["search.js", 5, 9]], updated: 0, ...o });
const OTHER = "acme/ledger"; // read only for the machine that comes last, after a row that isn't a repo
const rounding = pull({ repo: OTHER, number: 7, title: "Fix rounding", head: "rounding" });
const github = (pulls) => fs.writeFileSync(GH_FILE, JSON.stringify({ tokens: { [TOKEN]: { login: "herval" } }, repos: { [R]: { pulls }, [OTHER]: { pulls: [rounding] } } }));
github([cart(), search(), ...others]);
const site = await startGitHub({ ghFile: GH_FILE });
process.env.AGENTBOOK_GITHUB_API_URL = site.url;

const { carry, prChanges, prsInShell, readLinked } = await import("../server/integrations/pulls.ts");

// ---------- which commands link one ----------
const shell = (cmd, out = "") => JSON.stringify(prsInShell(cmd, out));
check(shell("git push -u origin cart && gh pr create --fill", "https://github.com/acme/shop/pull/41\n") === '[{"how":"opened","repo":"acme/shop","number":41}]', "gh pr create opens the one it prints");
check(shell("gh pr create --fill", 'a pull request for branch "cart" into branch "main" already exists:\nhttps://github.com/acme/shop/pull/41') === '[{"how":"worked","repo":"acme/shop","number":41}]', "one that already existed is worked on, not opened");
check(shell("gh pr merge --squash", "✓ Squashed and merged pull request acme/shop#44 (Search)") === '[{"how":"worked","repo":"acme/shop","number":44}]' && shell("gh pr checkout 12") === '[{"how":"worked","repo":null,"number":12}]' && shell("gh pr comment 7 -R acme/other -b hi") === '[{"how":"worked","repo":"acme/other","number":7}]', "merging the branch's, checking one out by number, commenting on another repo's");
check(shell("gh pr view 41 && gh pr checks 41 && gh pr diff 41") === "[]", "looking at one isn't working on it");
check(shell("gh pr create --title t --body \"$(cat <<'EOF'\nTo try it:\n  gh pr checkout 41\nEOF\n)\"", "https://github.com/acme/shop/pull/50") === '[{"how":"opened","repo":"acme/shop","number":50}]', "a command in a PR's body doesn't count");
const worked = (repo, number) => JSON.stringify([{ how: "worked", repo, number }]);
check(shell("R=acme/shop; gh pr merge 12 --repo $R") === worked("acme/shop", 12), "a repo in a variable the line sets is that repo");
check(shell('export R="acme/shop" && gh pr comment 12 -R "${R}" -b hi') === worked("acme/shop", 12) && shell("R=https://github.com/acme/shop.git; gh pr review 12 --repo=$R") === worked("acme/shop", 12), "quoted, exported, in braces, as a link");
check(shell("R=acme/shop; gh pr merge 1 -R $R; R=acme/ledger; gh pr merge 2 -R $R") === JSON.stringify([...JSON.parse(worked("acme/shop", 1)), ...JSON.parse(worked("acme/ledger", 2))]), "a variable set again is what it was set to last");
check(shell('gh pr merge -R "acme/shop" 12') === worked("acme/shop", 12), "a repo in quotes loses its quotes");
check(shell("gh pr merge 12 --repo $R") === "[]" && shell("gh pr merge 12 -R $OWNER/$NAME") === "[]" && shell("gh pr merge 12 -R $(gh repo view --json nameWithOwner -q .nameWithOwner)") === "[]", "a repo the line doesn't say is no repo, and not the folder's either");
check(shell("gh pr merge 12 -R ghe.example.com/acme/shop") === "[]", "nor is one on another GitHub");
check(shell("gh pr merge --repo $R", "✓ Squashed and merged pull request #12 (Search)") === "[]", "nor when it only prints a number");
check(shell("gh pr merge 12 --repo $R", "https://github.com/acme/shop/pull/12") === worked("acme/shop", 12), "what it printed can still say which");

// ---------- what a change says ----------
const read = await readLinked(`github.com/${R}`, { numbers: [41, 999], heads: ["search"] }, { token: TOKEN });
const c41 = read.pulls[41];
check(read.login === "herval" && read.base === "main" && read.pulls[999] === null && read.heads.search?.[0]?.number === 44, "one read gets them by number and by branch, and says which GitHub doesn't have");
check(c41.state === "open" && c41.checks.fail === 2 && c41.failing.join() === "unit,e2e" && c41.mine && c41.waiting.join() === "maria", "a card says its checks, which fail, that it's yours and who it waits on");
const step = (o) => carry(c41, { ...c41, ...o });
const red = carry(null, c41);
check(red.red && prChanges(red, red).length === 0, "nothing changed, nothing to say");
const running = carry(red, { ...c41, checks: { pass: 1, fail: 0, pending: 2, skip: 0, total: 3 }, failing: [] });
check(running.red && prChanges(red, running).length === 0, "a new commit's checks starting don't make a line, and it's still failing until they pass");
const passed = carry(running, { ...c41, checks: { pass: 3, fail: 0, pending: 0, skip: 0, total: 3 }, failing: [] });
check(prChanges(running, passed).map((l) => l.text).join() === "Checks pass on #41 again" && !passed.red, "they pass again");
const failedAgain = carry(passed, { ...c41 });
check(prChanges(passed, failedAgain)[0]?.text === "2 checks failed on #41: `unit`, `e2e`" && prChanges(passed, failedAgain)[0].kind === "fail", "they fail, by name");
check(prChanges(passed, step({ ...passed, review: "changes", reviewer: "maria", threads: 2, said: [{ who: "maria", at: new Date().toISOString() }] })).map((l) => l.text).join("|") === "@maria asked for changes on #41: 2 threads", "changes asked, by whom, without also saying she commented");
check(prChanges(passed, step({ ...passed, review: "approved", reviewer: "maria" }))[0]?.text === "@maria approved #41", "approved");
check(prChanges(passed, step({ ...passed, mergeable: "conflicts" }))[0]?.text === "#41 conflicts with `main` now", "a conflict");
check(prChanges(passed, step({ ...passed, said: [{ who: "joe", at: new Date().toISOString() }] }))[0]?.text === "@joe commented on #41", "someone else commenting");
check(JSON.stringify(prChanges(passed, step({ ...passed, state: "merged", merged_by: "maria" }))) === '[{"kind":"merged","text":"@maria merged #41 into `main`"}]' && prChanges(passed, step({ ...passed, state: "closed" }))[0].text === "#41 was closed without merging", "merged by someone, or closed: one line, nothing else");

// ---------- the server ----------
const shop = path.join(HOME, "dev", "shop");
fs.mkdirSync(shop, { recursive: true });
const git = (...args) => spawnSync("git", ["-C", shop, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(shop, "README"), "shop\n");
git("add", ".");
git("commit", "-q", "-m", "shop");
git("remote", "add", "origin", "git@github.com:acme/shop.git");
git("checkout", "-q", "-b", "cart");

// wren: on cart. It opened #41 (Claude Code's pr-link), merged #38 and checked out #45 by number.
const at = () => new Date().toISOString();
const line = (o) => JSON.stringify({ timestamp: at(), cwd: shop, ...o }) + "\n";
const bash = (id, command, stdout = "") => line({ type: "assistant", message: { model: "claude-x", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }) + line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: stdout || "ok" }] }, toolUseResult: { stdout, stderr: "" } });
const tA = path.join(HOME, "a.jsonl");
fs.writeFileSync(tA, line({ type: "user", message: { content: "make the cart page" } }) + line({ type: "pr-link", prNumber: 41, prUrl: `https://github.com/${R}/pull/41`, prRepository: R }) + bash("tu1", "gh pr merge 38 --squash", "✓ Squashed and merged pull request acme/shop#38 (Their fix)") + bash("tu2", "gh pr checkout 45"));
// finch: on search, with nothing in its transcript about pull requests.
const tB = path.join(HOME, "b.jsonl");
fs.writeFileSync(tB, "");

const env = { ...process.env, AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_PR_MS: "300", AGENTBOOK_PR_TICK_MS: "150", AGENTBOOK_PR_HEAD_MS: "300" };
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
  const a = (await req("POST", "/api/hello", { body: { proc: "box-a", label: "wren", agent: "Claude", session_id: "sess-a", cwd: shop, root: shop, branch: "cart", transcript: tA } })).post;
  const b = (await req("POST", "/api/hello", { body: { proc: "box-b", label: "finch", agent: "Claude", session_id: "sess-b", cwd: shop, root: shop, branch: "search", transcript: tB } })).post;
  const postOf = async (id: string): Promise<Json> => (await stateOf(me.get)).sessions.find((s: Json) => s.id === id);
  const pr = (s: Json, n: number) => Object.values<Json>(s?.prs || {}).find((p) => p.number === n);
  // Without GitHub connected, they're links and nothing more, and GitHub isn't asked.
  const asked = () => fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").filter(Boolean).length;
  const was = asked();
  await until(async () => pr(await postOf(a), 41));
  await sleep(500);
  check(pr(await postOf(a), 41) && !pr(await postOf(a), 41).gh && asked() === was, "without GitHub connected, a post's pull requests are links, and GitHub isn't asked");
  check((await me.post("/api/connectors", { kind: "github", api_key: TOKEN, states: [] })).status === 200, "herval connects GitHub");
  // #44 last moved before finch started: an old one with its branch's name, maybe. Once it moves, it's finch's.
  await sleep(900);
  check(!pr(await postOf(b), 44), "a post on a branch doesn't link a pull request on it that was done before it started");
  github([cart(), search(), ...others]);

  const A = await until(async () => {
    const s = await postOf(a);
    return [41, 38, 45].every((n) => pr(s, n)?.gh) ? s : null;
  });
  check(!!A, "the post links what it opened, merged and checked out, and each gets its state from GitHub");
  check(pr(A, 41)?.how === "opened" && pr(A, 38)?.how === "worked" && pr(A, 45)?.how === "worked" && pr(A, 45)?.url === `https://github.com/${R}/pull/45`, "how each came to be linked; one named by number is in the folder's repo");
  check(pr(A, 41)?.gh.checks.fail === 2 && pr(A, 41)?.gh.red && pr(A, 38)?.gh.author === "maria" && !pr(A, 38)?.gh.mine && pr(A, 45)?.gh.state === "draft", "where each stands: failing, someone else's, a draft");
  check(!(A.updates || []).some((u) => u.pr), "the first read of one makes no line: nothing changed yet");
  const B = await until(async () => {
    const s = await postOf(b);
    return pr(s, 44)?.gh ? s : null;
  });
  check(pr(B, 44)?.how === "branch" && pr(B, 44)?.gh.review === "approved", "a post on a branch links the pull request on it");

  // #41's checks are fixed, then maria approves, then it's merged.
  github([cart({ checks: [["lint", "pass"], ["unit", "pass"], ["e2e", "pass"]] }), search(), ...others]);
  const fixed = await until(async () => ((await postOf(a)).updates || []).find((u) => u.pr?.number === 41));
  check(fixed?.text === "Checks pass on #41 again" && fixed.pr.kind === "good" && fixed.pr.url === `https://github.com/${R}/pull/41`, "checks passing again makes a line on the post");
  github([cart({ checks: [["lint", "pass"], ["unit", "pass"], ["e2e", "pass"]], review: "APPROVED", reviews: [["maria", "APPROVED", "Nice", 10]], mergeState: "CLEAN" }), search(), ...others]);
  const approved = await until(async () => ((await postOf(a)).updates || []).find((u) => u.pr && /approved/.test(u.text)));
  check(approved?.text === "@maria approved #41", "so does an approval, without a second line for her review");
  github([cart({ state: "MERGED", closed: 5, mergedBy: "herval", review: "APPROVED", reviews: [["maria", "APPROVED", "Nice", 10]] }), search(), ...others]);
  const merged = await until(async () => ((await postOf(a)).updates || []).find((u) => u.pr?.kind === "merged"));
  check(merged?.text === "Merged #41 into `main`" && pr(await postOf(a), 41).gh.state === "merged", "and merging it: the card says merged");
  const calls = () => fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").filter((l) => /p41: pullRequest/.test(l)).length;
  const before = calls();
  await sleep(1200);
  check(calls() === before, "a merged one isn't read again");
  check(((await postOf(a)).updates || []).filter((u) => u.pr).length === 3, "three changes, three lines: nothing repeats");

  // By hand: link #39, and unlink #38. The transcript finding #38 again doesn't bring it back.
  check((await me.post(`/api/sessions/${a}/prs`, { url: "https://example.com/acme/shop/pull/39" })).status === 400 && (await alice.post(`/api/sessions/${a}/prs`, { url: `https://github.com/${R}/pull/39` })).status === 404, "only a link to a pull request on GitHub, and only on your own post");
  check((await me.post(`/api/sessions/${a}/prs`, { url: `https://github.com/${R}/pull/39/files` })).status === 200, "you link one by its link");
  const linked = await until(async () => (pr(await postOf(a), 39)?.gh ? postOf(a) : null));
  check(pr(linked, 39)?.how === "you" && pr(linked, 39)?.gh.author === "joe", "linked by you, with its state");
  check((await me.post(`/api/sessions/${a}/prs`, { url: `https://github.com/${R}/pull/38`, off: true })).status === 200 && pr(await postOf(a), 38)?.off, "unlinking keeps it, off");
  fs.appendFileSync(tA, bash("tu3", "gh pr comment 38 --body thanks", `https://github.com/${R}/pull/38#issuecomment-1`));
  await until(async () => ((await me.get(`/api/sessions/${a}/steps`)).steps || []).some((s) => s.id === "tu3"));
  await sleep(400);
  check(pr(await postOf(a), 38)?.off === true, "working on it again doesn't link it again");

  // One GitHub doesn't have stays a plain link, and isn't asked for again soon.
  const asked999 = () => fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").filter((l) => /p999: pullRequest/.test(l)).length;
  const was999 = asked999();
  await me.post(`/api/sessions/${a}/prs`, { url: `https://github.com/${R}/pull/999` });
  await sleep(1500);
  check(asked999() - was999 === 1 && pr(await postOf(a), 999) && !pr(await postOf(a), 999).gh, "one GitHub doesn't have is asked for once, then left for a while");

  await req("POST", "/api/procs/box-b/updates", { body: { text: "Reviewed #45", link: `https://github.com/${R}/pull/45` } });
  const viaAgent = await until(async () => (pr(await postOf(b), 45)?.gh ? postOf(b) : null));
  check(pr(viaAgent, 45)?.how === "agent", "a result's link to a pull request links it, by its agent");

  // An older CLI read `gh pr merge 12 -R $R` as a repo called "$R". On the way to GitHub that stopped the watcher at
  // that row, on every pass: nothing after it was read. This machine is the last, so its repo comes after the row.
  const asked7 = await req("POST", "/api/devices/start", { body: { name: "old-mac" } });
  await me.post("/api/devices/approve", { code: asked7.code });
  const { token } = await req("GET", `/api/devices/poll?poll=${encodeURIComponent(asked7.poll)}`);
  const asOld = (p, body) => fetch(URL + p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await asOld("/api/cli/hello", {});
  const t0 = at();
  const hello = { proc: "old-proc", session_id: "old-1", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "heron" };
  const row = (url, number, repo) => ({ post: "old-1", url, number, repo, how: "worked", at: t0 });
  await asOld("/api/cli/ops", {
    ops: [
      { kind: "post.hello", seq: 1, at: t0, args: hello },
      { kind: "post.pr", seq: 2, at: t0, args: row("https://github.com/$R/pull/12", 12, "$R") },
      { kind: "post.pr", seq: 3, at: t0, args: row("https://github.com/$OWNER/$NAME/pull/13", 13, "$OWNER/$NAME") },
      // A real link with a repo that isn't one gets as far as the read, so that has to hold too.
      { kind: "post.pr", seq: 4, at: t0, args: row(`https://github.com/${OTHER}/pull/8`, 8, "$R") },
      { kind: "post.pr", seq: 5, at: t0, args: row(`https://github.com/${OTHER}/pull/7`, 7, OTHER) },
    ],
  });
  const heron = async () => (await stateOf(me.get)).sessions.find((s) => s.label === "heron");
  const after = await until(async () => {
    const s = await heron();
    return pr(s, 7)?.gh ? s : null;
  }, 4000);
  check(after && pr(after, 7).gh.title === "Fix rounding", "a row that isn't a repo doesn't stop what comes after it being read");
  const gone = await until(async () => {
    const s = await heron();
    return pr(s, 12)?.off && pr(s, 13)?.off ? s : null;
  }, 2000);
  check(!!gone, "and it's unlinked, as the page couldn't do by hand, even when it looks like owner/name");
  // The card's button reads the thread's pull requests, which a row doesn't have (ROW in server/side.ts): it's handed
  // the thread its card draws, and never looks one up by id (sessionById and threadRow find a row first; going by one,
  // a click found none and did nothing, without a word).
  const fix = fs.readFileSync(path.join(TEST, "..", "web", "components", "thread", "Results.tsx"), "utf8").split("async function prFix(")[1].split("\n}\n")[0];
  check(/^e: [^,]+, s: Thread, p: PostPr,/.test(fix) && !/sessionById\(|threadRow\(/.test(fix), "a card's button finds its thread with its pull requests, not a row of it");
  check((await me.post(`/api/sessions/${(await heron()).id}/prs`, { url: "https://github.com/$R/pull/12", off: true })).status === 400, "the page's unlink still refuses such a link, which is why the watcher does it");
} finally {
  server.kill();
  site.close();
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
