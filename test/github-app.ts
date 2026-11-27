#!/usr/bin/env node
// Signing in with GitHub through agentbook's GitHub App, instead of pasting a token: the admin makes the app once,
// from a manifest, and everyone signs in with a code (GitHub's Device Flow); agentbook renews their sign-in by
// itself, reads GitHub as them with it, and keeps nothing of the app's secrets. Against a stand-in GitHub
// (fake-github.ts). Run: node test/github-app.ts

import fs from "node:fs";
import http from "node:http";
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-github-app-"));
const PORT = testPort(5400);
const GH_FILE = path.join(HOME, "gh.json");

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 10000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

// GitHub: acme/shop, where alice has a pull request open and an issue assigned to her. The app is installed on acme.
fs.writeFileSync(
  GH_FILE,
  JSON.stringify({
    tokens: { github_pat_carol: { login: "carol", repos: ["acme/shop"] } },
    repos: {
      "acme/shop": {
        pulls: [pull({ repo: "acme/shop", number: 41, title: "Alice's cart page", head: "cart", author: "alice" })],
        diffs: {},
        issues: [{ id: "I_1", number: 1, title: "Fix the cart total", assignees: ["alice"], updatedAt: new Date().toISOString() }],
      },
    },
  }),
);
const github = await startGitHub({ ghFile: GH_FILE, people: { alice: { name: "Alice", repos: ["acme/shop"], installations: [{ account: "acme", all: true }, { account: "initech", all: false }] }, bob: { name: "Bob", repos: [] } } });
const calls = () => (fs.existsSync(`${GH_FILE}.calls.jsonl`) ? fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_MACHINE: "hub", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_GITHUB_URL: github.url, AGENTBOOK_GITHUB_API_URL: github.url, AGENTBOOK_CONNECTOR_TICK_MS: "200", AGENTBOOK_CONNECTOR_MIN_EVERY: "1", AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "GH_TOKEN", "GITHUB_TOKEN", "AGENTBOOK_GITHUB_APP_CLIENT_ID", "AGENTBOOK_GITHUB_APP"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR, { recursive: true });
let server = null;
// The sign-in relay's /.well-known/agentbook-relay (agentbook-relay's PROTOCOL.md), naming agentbook's GitHub App.
let named: { client_id: string; slug: string } | null = { client_id: "Iv1.relays-app", slug: "agentbook-connector" };
let relayPort = 0; // its own, the first time it listens; the same after
const relay = http.createServer((q, s) => {
  if (q.url !== "/.well-known/agentbook-relay") return s.writeHead(404).end();
  s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: `http://127.0.0.1:${relayPort}`, providers: [{ id: "google", name: "Google" }], ...(named ? { github_app: named } : {}) }));
});
const start = (extra = {}) => (server = spawnAgentbook({ env: { ...env, ...extra }, stdio: ["ignore", "ignore", "inherit"] }));
// Whether a secret is anywhere in the server's data folder, in plain.
const plainIn = (secret) =>
  (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name)).includes(secret)));
  })(path.join(HOME, "server"));
const healthy = () => until(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`).catch(() => null))?.ok, 6000);

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
        resolve({ status: res.statusCode, text, headers: res.headers, cookie: String(res.headers["set-cookie"]?.[0] || "").split(";")[0], ...json });
      });
    });
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body: unknown = {}) => req("POST", p, { cookie, body }) });

try {
  start();
  await healthy();
  const setup = await fetch(`http://127.0.0.1:${PORT}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  const herval = as((setup.headers.get("set-cookie") || "").split(";")[0]);
  const join = async (username: string) => as((await req("POST", "/api/auth/test-person", { body: { username } })).cookie);
  const alice = await join("alice");
  const bob = await join("bob");
  const carol = await join("carol");

  // ---------- no app yet ----------
  const none = await alice.get("/api/github/app");
  check(none.status === 200 && none.app === null && none.admin === false && (await herval.get("/api/github/app")).admin === true, "there's no GitHub App to sign in with yet, and herval is the one who can make it");
  const cantMake = [await alice.post("/api/github/app/manifest", {}), await alice.post("/api/github/app", { client_id: "Iv1.mine" }), await alice.post("/api/github/signin", {})];
  check(cantMake[0].status === 403 && cantMake[1].status === 403 && cantMake[2].status === 409 && /use a token/.test(cantMake[2].error), "only an admin makes it; until then, nobody can sign in with it (a token still works)");

  // ---------- herval makes it ----------
  const made = await herval.post("/api/github/app/manifest", {});
  const manifest = JSON.parse(made.manifest || "{}");
  const state = new URL(made.action || "http://x").searchParams.get("state");
  check(made.status === 200 && made.action.startsWith(`${github.url}/settings/apps/new?state=`) && state && manifest.redirect_url === `http://hub.example:${PORT}/api/github/app/created` && manifest.public === true && manifest.default_permissions.pull_requests === "write" && manifest.default_permissions.issues === "write" && !manifest.hook_attributes && manifest.name === "agentbook-herval", "herval gets the manifest to post to GitHub: the app reads pull requests and answers their reviews, writes issues, sends him back here, with no webhook");
  const forOrg = await herval.post("/api/github/app/manifest", { org: "acme" });
  check(forOrg.action.startsWith(`${github.url}/organizations/acme/settings/apps/new?`), "or makes it an organization's");
  const page = await req("GET", "/", {});
  check((page.headers["content-security-policy"] || "").includes(`form-action 'self' ${github.url}`), "the page may post it to GitHub, and nowhere else");
  // GitHub sends him back, with a code for the app it made.
  github.manifest("M1", { slug: "agentbook-herval", name: "agentbook-herval", owner: { login: "herval", type: "User" } });
  const forged = await herval.get("/api/github/app/created?code=M1&state=not-the-one");
  const hers = await alice.get(`/api/github/app/created?code=M1&state=${state}`);
  check(forged.status === 302 && hers.status === 302 && (await herval.get("/api/github/app")).app === null && /without the request/.test((await alice.get("/api/github/app")).note || ""), "coming back without the state agentbook gave, or as someone else, keeps nothing");
  const back = await herval.get(`/api/github/app/created?code=M1&state=${state}`);
  const app = await herval.get("/api/github/app");
  check(back.status === 302 && back.headers.location === "/#/connectors" && app.app?.slug === "agentbook-herval" && app.note === "created" && app.app.links.settings === `${github.url}/settings/apps/agentbook-herval` && app.app.links.install === `${github.url}/apps/agentbook-herval/installations/new`, "with it, agentbook keeps the app, and points him to its settings (to turn on Device Flow) and to installing it");
  const kept = fs.readFileSync(path.join(HOME, "server", "github-app.json"), "utf8");
  check(/Iv1\.agentbook-test/.test(kept) && !/SECRET/.test(kept) && (fs.statSync(path.join(HOME, "server", "github-app.json")).mode & 0o777) === 0o600, "keeping its client ID, and none of its private key or secrets");
  check((await herval.get(`/api/github/app/created?code=M1&state=${state}`)).status === 302 && /without the request/.test((await herval.get("/api/github/app")).note || ""), "and the state works once");

  // ---------- Device Flow off: GitHub can't turn it on from a manifest ----------
  github.deviceFlow = false;
  const off = await alice.post("/api/github/signin", {});
  check(off.status === 502 && /Enable Device Flow/.test(off.error) && (await herval.get("/api/github/app")).app.device_flow === false, "until herval turns on its Device Flow, signing in says so, and his page says it's off");
  github.deviceFlow = true;

  // ---------- alice signs in with GitHub ----------
  const n0 = calls().length;
  const started = await alice.post("/api/github/signin", { states: ["issues"], teams: "acme" });
  check(started.status === 200 && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(started.user_code) && started.verification_uri === `${github.url}/login/device` && !JSON.stringify(started).includes("device_code"), "alice signing in gets a code to enter on GitHub (the device code stays here)");
  check((await alice.get(`/api/github/signin/${started.id}`)).status === "pending" && (await bob.get(`/api/github/signin/${started.id}`)).status === 404, "it waits for her, and nobody else can watch it");
  github.approve(started.user_code, "alice");
  const done = await until(async () => {
    const r = await alice.get(`/api/github/signin/${started.id}`);
    return r.status === "done" ? r : null;
  });
  const token = github.current("alice");
  const listed = await alice.get("/api/connectors");
  const conn = listed.connectors?.find((c) => c.kind === "github");
  check(!!done && done.connector?.who === "Alice (@alice)" && conn?.via === "app" && conn.teams.join() === "acme" && !("refresh_token" in conn) && !listed.text.includes(token.access_token) && !listed.text.includes(token.refresh_token) && !done.text.includes(token.access_token), "once she's entered it on GitHub, her GitHub connector signs in as her, and neither of its tokens ever comes back out");
  check(!plainIn(token.access_token) && !plainIn(token.refresh_token), "and both are kept encrypted: neither is anywhere in the server's data folder in plain");
  const task = await until(async () => (await stateOf(alice.get)).tasks?.find((t) => t.source?.key === "acme/shop#1"));
  check(!!task, "what's hers there comes into her Tasks");
  const ws = await alice.post("/api/workspaces", { repo: "acme/shop" });
  const pulls = await until(async () => (await stateOf(alice.get)).workspaces?.find((w) => w.id === ws.id)?.pulls?.pulls?.length && (await stateOf(alice.get)).workspaces.find((w) => w.id === ws.id).pulls);
  check(ws.status === 200 && pulls?.login === "alice" && calls().slice(n0).filter((c) => c.token).every((c) => c.as === "alice"), "her workspace's pull requests are read as her, with that sign-in");
  const installs = await alice.get("/api/github/installations");
  check(installs.status === 200 && installs.installations?.[0]?.account === "acme" && installs.installations[0].all && installs.installations[0].url === `${github.url}/organizations/acme/settings/installations/1` && installs.install === `${github.url}/apps/agentbook-herval/installations/new` && (await bob.get("/api/github/installations")).status === 404, "and she sees where the app is installed (what it reads as her), each with its settings on GitHub, and where to install it on more");
  check((await herval.get("/api/github/app")).app.device_flow === true, "and herval's page knows Device Flow is on");
  // Repos GitHub won't show her: when the app is why, her page says how (it isn't installed on that owner, or that
  // repo wasn't picked for it) and links where to fix it on GitHub; when the app reads every repo there, it can't say.
  const unpicked = await alice.post("/api/workspaces", { repo: "initech/erp-sync" });
  const uninstalled = await alice.post("/api/workspaces", { repo: "globex/core-api" });
  const hidden = await alice.post("/api/workspaces", { repo: "acme/ledger" });
  const unseen = await until(async () => {
    const list = (await stateOf(alice.get)).workspaces || [];
    const got = [unpicked, uninstalled, hidden].map((x) => list.find((w) => w.id === x.id)?.pulls);
    return got.every((p) => p?.error) && got;
  });
  check(!!unseen && /reads only the initech repos picked for it, and erp-sync isn't one/.test(unseen[0].error) && unseen[0].fix?.url === `${github.url}/organizations/initech/settings/installations/2` && unseen[0].fix.label === "Add erp-sync on GitHub", "a repo not picked for the app's install on its organization says so, with a link to that install's settings");
  check(!!unseen && /isn't installed on globex/.test(unseen[1].error) && unseen[1].fix?.url === `${github.url}/apps/agentbook-herval/installations/new`, "one on an organization the app isn't installed on says so, with a link to install it");
  check(!!unseen && /GitHub has no repo acme\/ledger, or your GitHub account can't see it/.test(unseen[2].error) && !unseen[2].fix, "one the app could read (it reads every acme repo) keeps saying GitHub has no such repo, or her account can't see it");
  const missing = (await alice.get("/api/github/installations")).missing || [];
  check(missing.map((m) => `${m.repo}:${m.workspace}`).sort().join() === "globex/core-api:core-api,initech/erp-sync:erp-sync" && missing.every((m) => m.url && m.label), "and her GitHub connector lists the repos the app is missing, each with where to fix it");

  // ---------- renewing ----------
  server.kill();
  await sleep(300);
  github.ttl = 40;
  start({ AGENTBOOK_GITHUB_RENEW_SEC: "30", AGENTBOOK_GITHUB_RENEW_RETRY_SEC: "2" });
  await healthy();
  const second = await alice.post("/api/github/signin", { id: conn.id });
  github.approve(second.user_code, "alice");
  await until(async () => (await alice.get(`/api/github/signin/${second.id}`)).status === "done");
  const before = github.current("alice");
  const renewed = await until(() => github.current("alice")?.access_token !== before.access_token && github.current("alice"), 20000);
  const n1 = calls().length;
  const detail = await alice.get(`/api/pulls?workspace=${ws.id}&number=41`);
  check((await alice.get("/api/connectors")).connectors.filter((c) => c.kind === "github").length === 1, "signing in again keeps her one GitHub connector, with the new sign-in");
  check(!!renewed && github.seen.some((s) => s.grant === "refresh_token") && detail.status === 200 && detail.login === "alice" && calls().slice(n1).every((c) => !c.token || c.as === "alice"), "before her sign-in runs out, agentbook renews it by itself, and goes on reading GitHub as her with the new one");
  check(!plainIn(renewed.access_token) && !plainIn(renewed.refresh_token), "and keeps the new tokens encrypted too");

  // ---------- turned down; signed out ----------
  const bobs = await bob.post("/api/github/signin", {});
  github.deny(bobs.user_code);
  const denied = await until(async () => {
    const r = await bob.get(`/api/github/signin/${bobs.id}`);
    return r.status !== "pending" ? r : null;
  });
  check(denied?.status === "denied" && /turned it down/.test(denied.error) && !(await bob.get("/api/connectors")).connectors.length, "bob turning it down on GitHub leaves him without a GitHub connector");
  github.revoke("alice");
  const out = await until(async () => /Sign in with GitHub again/.test((await alice.get("/api/connectors")).connectors?.find((c) => c.kind === "github")?.error || ""), 15000);
  // It runs out within the 30 seconds it's renewed ahead.
  const ranOut = await until(async () => (await stateOf(alice.get)).github === null, 40000);
  const after = (await stateOf(alice.get)).workspaces.find((w) => w.id === ws.id);
  check(out && ranOut && after && !("pulls" in after) && (await alice.get(`/api/pulls?workspace=${ws.id}&number=41`)).status === 403, "when GitHub won't renew it (it signed agentbook out), her connector says to sign in again, and once it runs out, nothing reads GitHub as her");

  // ---------- a token still works ----------
  const pat = await carol.post("/api/connectors", { kind: "github", api_key: "github_pat_carol", states: [] });
  check(pat.status === 200 && pat.connector.via === null && pat.connector.who === "@carol" && (await stateOf(carol.get)).github === "connector", "and pasting a token instead still works, for anyone who'd rather");

  // ---------- no app of its own: the sign-in relay's ----------
  // A page nobody made an app on uses the one its sign-in relay names (agentbook's own), asked for as it starts.
  server.kill();
  await sleep(300);
  fs.rmSync(path.join(HOME, "server", "github-app.json"));
  github.clientId = "Iv1.relays-app";
  const relayStart = async () => {
    await new Promise((r) => relay.listen(relayPort, "127.0.0.1", () => r(null)));
    relayPort = (relay.address() as { port: number }).port;
    start({ AGENTBOOK_RELAY_URL: `http://127.0.0.1:${relayPort}` });
    await healthy();
  };
  const stop = async () => {
    server.kill();
    await new Promise((r) => relay.close(() => r(null)));
    relay.closeAllConnections();
    await sleep(300);
  };
  await relayStart();
  const relays = await until(async () => (await bob.get("/api/github/app")).app);
  check(relays?.slug === "agentbook-connector" && relays.links.install === `${github.url}/apps/agentbook-connector/installations/new` && relays.links.settings === null, "with no app of its own, the page has the one its sign-in relay names, to install, and no settings of it to change");
  const viaRelay = await bob.post("/api/github/signin", {});
  check(viaRelay.status === 200 && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(viaRelay.user_code), "and bob signs in to GitHub with it, with its client ID alone");
  const relayKept = fs.readFileSync(path.join(HOME, "server", "relay-github-app.json"), "utf8");
  check(JSON.parse(relayKept).client_id === "Iv1.relays-app" && (fs.statSync(path.join(HOME, "server", "relay-github-app.json")).mode & 0o777) === 0o600, "it's kept in the server's data folder, readable only by whoever runs it");
  await stop();
  start({ AGENTBOOK_RELAY_URL: `http://127.0.0.1:${relayPort}` });
  await healthy();
  check((await bob.get("/api/github/app")).app?.slug === "agentbook-connector", "a page that starts while the relay can't be reached still has it");
  server.kill();
  await sleep(300);
  named = null;
  await relayStart();
  const gone = await until(async () => !(await bob.get("/api/github/app")).app);
  check(gone && !fs.existsSync(path.join(HOME, "server", "relay-github-app.json")), "and once the relay names none, the page has none");
  await stop();
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
  github.close();
  relay.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
