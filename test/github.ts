#!/usr/bin/env node
// GitHub as a connector, on a hub with several people: each connects their own GitHub with their own token, and
// agentbook reads GitHub as them with it, and with nothing else: their workspaces' pull requests, a pull request's
// page and diffs. The hub's owner too. What's theirs to do there (issues assigned to them, pull requests waiting
// for their review) comes into their Tasks; ticking an issue closes it there. Against a stand-in for GitHub's API
// (fake-github.ts) that knows whose token is whose, and what each can see. Run: node test/github.ts

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffOf, pull } from "./fake-gh-pulls.ts";
import { startGitHub } from "./fake-github.ts";
import { repos as listRepos } from "../server/integrations/connectors/github.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-github-"));
const PORT = testPort(5300);
const ALICE = "github_pat_alice_0123456789";
const HERVAL = "github_pat_herval_0123456789";
const GH_FILE = path.join(HOME, "gh.json");
const MANY = "github_pat_many_0123456789"; // someone with 1,050 repos

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

// GitHub: acme/shop, where alice has a pull request open and one of herval's waits for her review, and an issue
// is assigned to her (another to bob); and herval's private herval/secret, which only he can see.
const gh = {
  tokens: { [ALICE]: { login: "alice", name: "Alice", repos: ["acme/shop"] }, [HERVAL]: { login: "herval", name: "Herval", repos: ["acme/shop", "herval/secret"] }, [MANY]: { login: "many", repos: Array.from({ length: 1050 }, (_, i) => `many/r${i}`) } },
  repos: {
    "acme/shop": {
      description: "The shop",
      pushedAt: new Date(Date.now() - 86400e3).toISOString(),
      pulls: [
        pull({ repo: "acme/shop", number: 41, title: "Alice's cart page", head: "cart", author: "alice", files: [["cart.js", 2, 1]] }),
        pull({ repo: "acme/shop", number: 42, title: "Herval's checkout", head: "checkout", author: "herval", requested: ["alice"] }),
        pull({ repo: "acme/shop", number: 43, title: "Bob's search", head: "search", author: "bob" }),
      ],
      diffs: { 41: diffOf([["cart.js", ["const total = sum(items);"]]]) },
      issues: [
        { id: "I_1", number: 1, title: "Fix the cart total", assignees: ["alice"], updatedAt: new Date().toISOString() },
        { id: "I_2", number: 2, title: "Bob's issue", assignees: ["bob"], updatedAt: new Date().toISOString() },
      ],
    },
    "herval/secret": { private: true, pushedAt: new Date().toISOString(), pulls: [pull({ repo: "herval/secret", number: 7, title: "The secret plan", head: "plan", author: "herval", files: [["plan.md", 1, 0]] })], diffs: { 7: diffOf([["plan.md", ["the secret plan"]]]) } },
  },
};
fs.writeFileSync(GH_FILE, JSON.stringify(gh));
const site = await startGitHub({ ghFile: GH_FILE });
const calls = () => (fs.existsSync(`${GH_FILE}.calls.jsonl`) ? fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const callsSince = (n) => calls().slice(n);
const issue = (id) => JSON.parse(fs.readFileSync(GH_FILE, "utf8")).repos["acme/shop"].issues.find((i) => i.id === id);

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_MACHINE: "hub", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_CONNECTOR_TICK_MS: "200", AGENTBOOK_CONNECTOR_MIN_EVERY: "1", AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file", AGENTBOOK_PR_TICK_MS: "400", AGENTBOOK_PR_MS: "500" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR, { recursive: true });
const server = spawnAgentbook({ env, stdio: ["ignore", "ignore", "inherit"] });

// A person's requests, from another computer.
function req(method: string, p: string, { cookie, body }: { cookie?: string; body?: unknown } = {}) {
  return new Promise<Json>((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { host: `hub.example:${PORT}`, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json: Json = {};
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, text, cookie: String(res.headers["set-cookie"]?.[0] || "").split(";")[0], ...json });
      });
    });
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body: unknown = {}) => req("POST", p, { cookie, body }) });

try {
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`).catch(() => null))?.ok, 6000);
  const setup = await fetch(`http://127.0.0.1:${PORT}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  const herval = as((setup.headers.get("set-cookie") || "").split(";")[0]);
  const join = async (username: string) => as((await req("POST", "/api/auth/test-person", { body: { username } })).cookie);
  const alice = await join("alice");
  const bob = await join("bob");

  // ---------- without GitHub connected, nobody's pull requests, not even the hub's owner's ----------
  const before = await stateOf(alice.get);
  const branches = await alice.post("/api/workspaces", { repo: "acme/shop" });
  const page = await alice.get(`/api/pulls?workspace=${branches.id}&number=41`);
  const hisFirst = await herval.post("/api/workspaces", { repo: "herval/secret" });
  const viewOf = async (who, id) => (await stateOf(who.get)).workspaces?.find((w) => w.id === id);
  check(before.github === null && (await stateOf(herval.get)).github === null && hisFirst.status === 200 && !("pulls" in (await viewOf(herval, hisFirst.id))), "nobody reads GitHub here yet, herval neither: no sign-in of the hub's own is used");
  const noRepos = await alice.get("/api/github/repos");
  check(branches.status === 200 && !("pulls" in (await viewOf(alice, branches.id))) && page.status === 403 && /connect GitHub/.test(page.error) && noRepos.status === 403 && /connect GitHub/.test(noRepos.error) && !calls().length, "so her workspace is its branches with no pull requests, Add a workspace hasn't her repos on GitHub, and GitHub isn't asked");

  // ---------- alice connects her own GitHub ----------
  const wrong = await alice.post("/api/connectors", { kind: "github", api_key: "github_pat_nope" });
  check(wrong.status === 400 && /turned the token down/.test(wrong.error) && !(await alice.get("/api/connectors")).connectors.length, "a token GitHub turns down isn't kept");
  const n0 = calls().length;
  const made = await alice.post("/api/connectors", { kind: "github", api_key: ALICE, states: ["issues", "reviews"], teams: "acme" });
  const listed = await alice.get("/api/connectors");
  check(made.status === 200 && made.connector.who === "Alice (@alice)" && made.connector.kind === "github" && made.connector.teams.join() === "acme" && !listed.text.includes(ALICE) && !made.text.includes(ALICE), "alice connects GitHub with her token: it signs in as her, and the token never comes back out");
  const used = callsSince(n0);
  check(used.length && used.every((c) => c.token && c.as === "alice"), "every read with it is as alice");
  const tasks = await until(async () => {
    const t = (await stateOf(alice.get)).tasks || [];
    return t.some((x) => x.source?.key === "acme/shop#1") && t.some((x) => x.source?.key === "acme/shop#42") ? t : null;
  });
  const review = tasks?.find((t) => t.source.key === "acme/shop#42");
  const own = tasks?.find((t) => t.source.key === "acme/shop#1");
  check(!!review && review.text === "Review: Herval's checkout" && own?.text === "Fix the cart total" && !tasks.some((t) => /Bob's/.test(t.text)), "what's hers to do there comes into her Tasks: the pull request waiting for her review, and the issue assigned to her, not bob's");
  check((await stateOf(alice.get)).github === "connector" && !(await stateOf(bob.get)).tasks.length, "her Tasks only; and GitHub is read as her now");

  // ---------- her repos, to add as workspaces ----------
  const n5 = calls().length;
  const herRepos = await alice.get("/api/github/repos");
  check(herRepos.status === 200 && herRepos.login === "alice" && herRepos.repos.length === 1 && herRepos.repos[0].repo === "github.com/acme/shop" && herRepos.repos[0].slug === "acme/shop" && herRepos.repos[0].about === "The shop" && !herRepos.repos[0].private, "Add a workspace lists her repos on GitHub, as GitHub shows them to her: acme/shop, not herval's");
  check(callsSince(n5).length && callsSince(n5).every((c) => c.as === "alice" && /repositories\(/.test(c.query)), "read as her");
  const n6 = calls().length;
  check((await alice.get("/api/github/repos")).repos?.length === 1 && callsSince(n6).length === 0, "and kept a minute: opening it again doesn't read them again");
  check((await alice.get("/api/github/repos?again=1")).repos?.length === 1 && callsSince(n6).length === 0, "nor right away for a page back from GitHub");
  await new Promise((r) => setTimeout(r, 5200));
  check((await alice.get("/api/github/repos?again=1")).repos?.length === 1 && callsSince(n6).length > 0, "but 5 seconds on, a page back from GitHub has them read again");
  check((await bob.get("/api/github/repos")).status === 403, "bob, without GitHub, gets none of hers");

  // ---------- her workspace's pull requests, read as her ----------
  const n1 = calls().length;
  const pulls = await until(async () => (await viewOf(alice, branches.id))?.pulls?.pulls?.length && (await viewOf(alice, branches.id)).pulls);
  check(pulls?.login === "alice" && pulls.pulls.map((p) => p.number).join() === "41", "now her workspace on acme/shop has her pull requests, as GitHub shows them to her");
  const detail = await alice.get(`/api/pulls?workspace=${branches.id}&number=41`);
  const diff = await alice.get(`/api/pulls/diff?workspace=${branches.id}&number=41&path=cart.js&sha=${detail.sha}`);
  check(detail.status === 200 && detail.login === "alice" && detail.title === "Alice's cart page" && diff.status === 200 && JSON.stringify(diff).includes("sum(items)"), "and one's page and diff, read as her");
  check(callsSince(n1).every((c) => c.token && c.as === "alice"), "all of it with her token");

  // ---------- what only herval can see stays his ----------
  const n4 = calls().length;
  const hisConn = await herval.post("/api/connectors", { kind: "github", api_key: HERVAL, states: [] });
  const hisWs = await herval.post("/api/workspaces", { repo: "herval/secret" });
  const his = await until(async () => (await stateOf(herval.get)).workspaces?.find((w) => w.id === hisWs.id)?.pulls?.pulls?.length);
  const hisDetail = await herval.get(`/api/pulls?workspace=${hisWs.id}&number=7`);
  const hisDiff = await herval.get(`/api/pulls/diff?workspace=${hisWs.id}&number=7&path=plan.md&sha=${hisDetail.sha}`);
  check(hisConn.status === 200 && (await stateOf(herval.get)).github === "connector" && callsSince(n4).length && callsSince(n4).every((c) => c.token && c.as === "herval"), "herval connects his own GitHub, and it's read as him");
  check(hisWs.status === 200 && his && hisDiff.status === 200 && JSON.stringify(hisDiff).includes("secret plan"), "his workspace on his private repo shows its pull requests");
  const hisRepos = await herval.get("/api/github/repos");
  check(hisRepos.login === "herval" && hisRepos.repos.map((r) => r.slug).join() === "herval/secret,acme/shop" && hisRepos.repos[0].private && !(await alice.get("/api/github/repos")).text.includes("secret"), "his repos are his: the private one too, the latest pushed first; alice's list still hasn't it");
  const hersToo = await alice.post("/api/workspaces", { repo: "herval/secret" });
  const tried = await until(async () => (await stateOf(alice.get)).workspaces?.find((w) => w.id === hersToo.id)?.pulls?.error);
  const peekDetail = await alice.get(`/api/pulls?workspace=${hersToo.id}&number=7`);
  const peekDiff = await alice.get(`/api/pulls/diff?workspace=${hersToo.id}&number=7&path=plan.md&sha=${hisDetail.sha}`);
  const aliceSees = (await stateOf(alice.get)).text + peekDetail.text + peekDiff.text;
  check(hersToo.status === 200 && /can't see it/.test(tried) && peekDetail.status >= 400 && peekDiff.status >= 400 && !/secret plan|The secret plan/.test(aliceSees), "alice adding his private repo sees nothing of it: GitHub doesn't show it to her, and his diff, read moments before, isn't handed to her");

  // ---------- ticking: an issue closes there, a review just ticks ----------
  const n2 = calls().length;
  await alice.post(`/api/tasks/${own.id}/done`, { done: true });
  await until(() => issue("I_1").state === "CLOSED");
  check(issue("I_1").state === "CLOSED" && callsSince(n2).some((c) => c.as === "alice" && /closeIssue/.test(c.query)), "ticking her issue's task closes it on GitHub, as her");
  await alice.post(`/api/tasks/${own.id}/done`, { done: false });
  await until(() => issue("I_1").state === "OPEN");
  check(issue("I_1").state === "OPEN", "and unticking opens it again");
  const n3 = calls().length;
  await alice.post(`/api/tasks/${review.id}/done`, { done: true });
  await sleep(600);
  check(!callsSince(n3).some((c) => /closeIssue|reopenIssue/.test(c.query || "")) && (await stateOf(alice.get)).tasks.find((t) => t.id === review.id)?.done, "ticking a review's task changes nothing on GitHub");
  await alice.post(`/api/tasks/${review.id}/done`, { done: false });
  // She reviews it: it isn't waiting for her any more.
  const now = JSON.parse(fs.readFileSync(GH_FILE, "utf8"));
  now.repos["acme/shop"].pulls.find((p) => p.number === 42).reviewRequests.nodes = [];
  fs.writeFileSync(GH_FILE, JSON.stringify(now));
  const conn = (await alice.get("/api/connectors")).connectors[0];
  await alice.post(`/api/connectors/${conn.id}/sync`);
  const gone = (await stateOf(alice.get)).tasks.find((t) => t.id === review.id);
  check(gone?.done && gone.source.gone === "Not waiting for your review any more", "once she's reviewed it, its task ticks itself, saying why");

  // ---------- nobody else's ----------
  const meddle = await Promise.all([bob.post(`/api/connectors/${conn.id}/sync`), bob.post(`/api/connectors/${conn.id}/delete`), bob.post("/api/connectors", { id: conn.id, name: "mine" })]);
  const bobState = await stateOf(bob.get);
  const bobWs = await bob.post("/api/workspaces", { repo: "acme/shop" });
  check(meddle.every((r) => r.status === 404) && bobState.github === null && !bobState.text.includes(ALICE) && bobWs.status === 200 && !("pulls" in (await viewOf(bob, bobWs.id))) && (await bob.get(`/api/pulls?workspace=${bobWs.id}&number=41`)).status === 403, "bob can't use, sync or remove alice's GitHub, nor read GitHub as her: his workspace on acme/shop has no pull requests until he connects his own");

  // ---------- only how agentbook reads GitHub as her ----------
  const quiet = await alice.post("/api/connectors", { id: conn.id, states: [] });
  await alice.post(`/api/connectors/${conn.id}/sync`);
  const quietState = await stateOf(alice.get);
  check(quiet.status === 200 && !quiet.connector.states.length && quietState.tasks.some((t) => t.id === own.id && !t.done) && quietState.workspaces.find((w) => w.id === branches.id)?.pulls?.login === "alice", "with nothing to bring into Tasks, it still reads her pull requests, and leaves her tasks be");

  // ---------- disconnecting ----------
  await alice.post(`/api/connectors/${conn.id}/delete`);
  const after = await until(async () => { const w = await viewOf(alice, branches.id); return w && !("pulls" in w); });
  check(after && (await stateOf(alice.get)).github === null && (await alice.get(`/api/pulls?workspace=${branches.id}&number=41`)).status === 403, "removing it, her pull requests go, until she connects GitHub again");
  // ---------- someone with a lot of repos ----------
  process.env.AGENTBOOK_GITHUB_API_URL = site.url;
  const n7 = calls().length;
  const lots = await listRepos(MANY);
  check(lots.login === "many" && lots.repos.length === 1000 && lots.more === 50 && lots.repos[999].slug === "many/r999" && callsSince(n7).length === 10, "a lot of repos are read 100 at a time, up to 1,000, saying how many more GitHub has");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill();
  site.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
