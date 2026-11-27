#!/usr/bin/env node
// Signing in with Linear through agentbook's Linear app, instead of pasting an API key: Linear's consent page sends
// the browser back with a code, agentbook trades it (PKCE, no client secret) for tokens that its Linear connector
// keeps encrypted, renews them by itself, and says to sign in again once Linear signs it out. Against a stand-in
// Linear (fake-linear.ts). Run: node test/linear-signin.ts

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSecrets } from "../server/secrets.ts";
import { issue, startLinear } from "./fake-linear.ts";
import { SECRET_KEY, spawnAgentbook, testPort } from "./harness.ts";
import { closeSql, sql } from "./harness-sql.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-linear-signin-"));
const PORT = testPort(6600);
const URL = `http://127.0.0.1:${PORT}`;
const CALLBACK = `${URL}/api/linear/callback`;
const KEY = "lin_api_test0123456789";
const DB = path.join(HOME, "storage.db");

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};

// The sign-in relay (agentbook-relay's PROTOCOL.md, 9), naming agentbook's Linear app while `relayNames` is true: it
// sends the browser on to Linear with its own state, and back to the page that asked with the page's. The real one
// also asks, the first time, whether that page is the person's (tested in agentbook-relay).
let relayNamesIt = true;
const relayWent: string[] = [];
const fromRelay = new Map<string, { origin: string; state: string }>();
const relay = http.createServer((q, s) => {
  const u = new globalThis.URL(q.url, RELAY);
  relayWent.push(u.pathname);
  if (u.pathname === "/.well-known/agentbook-relay") {
    const app = { client_id: "test-client", start: `${RELAY}/linear`, redirect_uri: RELAY_CALLBACK, callback_path: "/api/linear/callback" };
    return s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: RELAY, ...(relayNamesIt ? { linear_app: app } : {}) }));
  }
  if (u.pathname === "/linear") {
    const mine = crypto.randomBytes(16).toString("hex");
    fromRelay.set(mine, { origin: u.searchParams.get("origin"), state: u.searchParams.get("state") });
    const to = new globalThis.URL(`${linear.web}/oauth/authorize`);
    to.search = new URLSearchParams({ client_id: "test-client", redirect_uri: RELAY_CALLBACK, response_type: "code", scope: u.searchParams.get("scope"), state: mine, code_challenge: u.searchParams.get("challenge"), code_challenge_method: "S256", prompt: "consent" }).toString();
    return s.writeHead(302, { location: to.href }).end();
  }
  const p = u.pathname === "/callback/linear" && fromRelay.get(u.searchParams.get("state"));
  if (!p) return s.writeHead(400).end();
  fromRelay.delete(u.searchParams.get("state"));
  const back = new globalThis.URL("/api/linear/callback", p.origin);
  back.search = new URLSearchParams({ state: p.state, ...(u.searchParams.get("code") ? { code: u.searchParams.get("code") } : { error: u.searchParams.get("error") }) }).toString();
  s.writeHead(302, { location: back.href }).end();
});
await new Promise((r) => relay.listen(0, "127.0.0.1", () => r(null)));
const RELAY = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
const RELAY_CALLBACK = `${RELAY}/callback/linear`;

// Acme's Linear: an issue for herval and one for alice, in ENG.
const linear = await startLinear({ key: KEY, redirects: [CALLBACK, RELAY_CALLBACK] });
linear.issues.push(issue("ENG", 1, "Fix the login bug"), issue("ENG", 2, "Alice's cart", { assignee: "alice" }));

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_LINEAR_URL: linear.url, AGENTBOOK_LINEAR_WEB_URL: linear.web, AGENTBOOK_LINEAR_CLIENT_ID: "test-client", AGENTBOOK_CONNECTOR_TICK_MS: "200", AGENTBOOK_CONNECTOR_MIN_EVERY: "1" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "LINEAR_API_KEY", "AGENTBOOK_GITHUB_RENEW_SEC", "AGENTBOOK_GITHUB_RENEW_RETRY_SEC"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
let server = spawnAgentbook({ env, stdio: ["ignore", "ignore", "inherit"] });
const stop = () => new Promise((r) => (server.once("exit", r), server.kill()));
async function start(extra: Record<string, string> = {}) {
  server = spawnAgentbook({ env: { ...env, ...extra }, stdio: ["ignore", "ignore", "inherit"] });
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false), 20000);
}

type ConnectorRow = { id: string; data: string; api_key: string | null; refresh_token: string | null };
// Read afresh each time: a connection opened before a restart can go on seeing the database as it was.
const row = (id: string) => (closeSql(DB), sql(DB).prepare("select * from connectors where id = ?").get(id) as ConnectorRow) || null;
const opened = (r: ConnectorRow, field: "api_key" | "refresh_token") => createSecrets(SECRET_KEY).open(r[field], `connector ${r.id} ${field}`).value;
// Whether a secret is anywhere in agentbook's data folder, in plain (its database's pages included).
const plainIn = (secret: string) => {
  const hits: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (fs.readFileSync(f).includes(secret)) hits.push(path.relative(HOME, f));
    }
  })(HOME);
  return hits;
};
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
type Person = ReturnType<typeof as>;
// The browser's part: to Linear's page, which says yes (or no) and sends it back, and back to agentbook with it.
async function browse(who: Person, url: string) {
  const atLinear = await fetch(url, { redirect: "manual" });
  const back = atLinear.headers.get("location");
  if (!back) return { linear: atLinear.status, back: null, location: null };
  const r = await fetch(back, { redirect: "manual", headers: { cookie: who.cookie } });
  return { linear: atLinear.status, back, location: r.headers.get("location") };
}
const note = async (who: Person) => (await who.get("/api/linear/note")).note;
// The browser's part by way of the relay: each hop it's sent, with agentbook's cookie only on agentbook's own.
async function hops(who: Person, url: string) {
  const went: string[] = [];
  for (let u = url; went.length < 8; ) {
    went.push(u);
    const r = await fetch(u, { redirect: "manual", headers: u.startsWith(URL) ? { cookie: who.cookie } : {} });
    const next = r.headers.get("location");
    if (!next || next.startsWith("/")) return { went, location: next };
    u = next;
  }
  return { went, location: null };
}

try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false), 20000);
  const herval = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  const bob = as((await req("POST", "/api/auth/test-person", { body: { username: "bob" } })).cookie);
  const tasks = async (who: Person) => (await stateOf(who.get)).tasks;

  const kinds = (await alice.get("/api/connectors")).kinds;
  check(kinds.find((k) => k.kind === "linear")?.signin === true && !kinds.find((k) => k.kind === "github")?.signin, "the page learns Linear is signed in to, not pasted");

  // ---------- alice signs in ----------
  linear.oauth.signinAs = "alice";
  const started = await alice.post("/api/linear/signin", { states: ["unstarted", "started"], teams: "eng", close: true });
  const asked = new globalThis.URL(started.url || "http://x");
  const q = Object.fromEntries(asked.searchParams);
  check(started.status === 200 && asked.origin + asked.pathname === `${linear.web}/oauth/authorize` && q.client_id === "test-client" && q.redirect_uri === CALLBACK && q.code_challenge_method === "S256" && q.code_challenge && q.state && q.scope === "read,write", "signing in sends her to Linear's page, for agentbook's app, back to the address the page is at, with a PKCE challenge");
  check(!/verifier|secret/.test(started.url), "the verifier stays here, and there's no client secret anywhere");
  const went = await browse(alice, started.url);
  check(went.linear === 302 && went.location === "/#/connectors", "Linear sends her back, and agentbook takes her to Connectors");
  check(/^Signed in with Linear as Alice, in Acme\. Its issues are on their way/.test(await note(alice)) && (await note(alice)) === null, "where it says once who she signed in as");
  const theirs = (await alice.get("/api/connectors")).connectors;
  const conn = theirs[0];
  check(theirs.length === 1 && conn.kind === "linear" && conn.via === "app" && conn.key_set && conn.who === "Alice, in Acme" && JSON.stringify(conn.teams) === '["ENG"]' && !JSON.stringify(theirs).includes("lin_oauth_") && !JSON.stringify(theirs).includes("lin_refresh_"), "her Linear connector signs in as her, with the settings she picked, and no token reaches the page");
  const traded = linear.oauth.seen.find((p) => p.grant_type === "authorization_code");
  check(traded && traded.client_id === "test-client" && !traded.client_secret && traded.code_verifier && traded.redirect_uri === CALLBACK, "the code is traded with the app's client ID and the verifier, no secret");
  const kept = row(conn.id);
  const access = opened(kept, "api_key");
  const refresh = opened(kept, "refresh_token");
  check(/^lin_oauth_/.test(access) && /^lin_refresh_/.test(refresh) && JSON.parse(kept.data).via === "app" && JSON.parse(kept.data).expires_at && !plainIn(access).length && !plainIn(refresh).length, "both tokens are kept encrypted, and aren't anywhere in agentbook's data folder in plain");
  check(!!(await until(async () => (await tasks(alice)).some((t) => t.source?.key === "ENG-2"))) && !(await tasks(alice)).some((t) => t.source?.key === "ENG-1"), "her issues come into her Tasks, read as her");
  const cart = (await tasks(alice)).find((t) => t.source?.key === "ENG-2");
  await alice.post(`/api/tasks/${cart.id}/done`, { done: true });
  check(!!(await until(() => linear.stateOf("issue-ENG-2") === "done")), "and ticking one closes it in Linear, as her");

  // ---------- what isn't a sign-in agentbook started ----------
  const forged = await fetch(`${CALLBACK}?code=x&state=nope`, { redirect: "manual", headers: { cookie: alice.cookie } });
  check(forged.status === 302 && /without a sign-in agentbook started/.test(await note(alice)), "a state agentbook didn't give out changes nothing");
  linear.oauth.signinAs = "alice";
  const hers = await alice.post("/api/linear/signin", {});
  const atLinear = await fetch(hers.url, { redirect: "manual" });
  const stolen = await fetch(atLinear.headers.get("location"), { redirect: "manual", headers: { cookie: bob.cookie } });
  check(stolen.status === 302 && /without a sign-in agentbook started/.test(await note(bob)) && !(await bob.get("/api/connectors")).connectors.length, "nor does her sign-in coming back to bob's page: he gets no connector of hers");
  const finished = await fetch(atLinear.headers.get("location"), { redirect: "manual", headers: { cookie: alice.cookie } });
  check(finished.status === 302 && /^Signed in with Linear as Alice/.test(await note(alice)) && (await alice.get("/api/connectors")).connectors.length === 1, "and it's still hers to finish, on her one connector for that workspace");
  const replay = await fetch(atLinear.headers.get("location"), { redirect: "manual", headers: { cookie: alice.cookie } });
  check(replay.status === 302 && /without a sign-in agentbook started/.test(await note(alice)), "once, not twice");
  linear.oauth.signinAs = "deny";
  await browse(alice, (await alice.post("/api/linear/signin", {})).url);
  check(/didn't let agentbook in/.test(await note(alice)) && (await alice.get("/api/connectors")).connectors.length === 1, "saying no on Linear's page changes nothing");
  check((await req("POST", "/api/linear/signin", { body: {} })).status === 401, "someone not signed in here can't start one");

  // ---------- a pasted key becomes a sign-in ----------
  const pasted = await herval.post("/api/connectors", { kind: "linear", api_key: KEY, teams: "ENG", agent: "claude" });
  check(pasted.status === 200 && pasted.connector.who === "Herval, in Acme" && !pasted.connector.via, "herval pastes an API key, as before");
  linear.oauth.signinAs = "me";
  await browse(herval, (await herval.post("/api/linear/signin", { states: ["triage"] })).url);
  const his = (await herval.get("/api/connectors")).connectors;
  check(his.length === 1 && his[0].id === pasted.connector.id && his[0].via === "app" && his[0].agent === "claude" && JSON.stringify(his[0].teams) === '["ENG"]' && /^lin_oauth_/.test(opened(row(his[0].id), "api_key")), "signing in with Linear to the same workspace replaces his key, keeping the connector and its settings");

  // ---------- renewing ----------
  await stop();
  const before = opened(row(conn.id), "api_key");
  const grants = () => linear.oauth.seen.filter((p) => p.grant_type === "refresh_token").length;
  // Renewed this long before it runs out, its 24 hours are all inside it: renewed as soon as it's started.
  await start({ AGENTBOOK_GITHUB_RENEW_SEC: String(2 * 86400), AGENTBOOK_GITHUB_RENEW_RETRY_SEC: "3600" });
  const renewed = await until(() => grants() >= 2 && opened(row(conn.id), "api_key") !== before && opened(row(conn.id), "api_key"), 10000);
  const p = linear.oauth.seen.find((x) => x.grant_type === "refresh_token");
  check(!!renewed && p.client_id === "test-client" && !p.client_secret && !plainIn(renewed).length && !plainIn(opened(row(conn.id), "refresh_token")).length, "before a sign-in runs out, agentbook renews it with its refresh token and the client ID alone, and keeps the new tokens encrypted");
  linear.issues.push(issue("ENG", 3, "Alice's next thing", { assignee: "alice" }));
  await alice.post(`/api/connectors/${conn.id}/sync`);
  check((await tasks(alice)).some((t) => t.source?.key === "ENG-3"), "and goes on reading Linear as her with the new one");

  // ---------- signed out ----------
  linear.signOut("alice");
  await stop();
  await start({ AGENTBOOK_GITHUB_RENEW_SEC: String(2 * 86400), AGENTBOOK_GITHUB_RENEW_RETRY_SEC: "3600" });
  const out = await until(async () => {
    const c = (await alice.get("/api/connectors")).connectors[0];
    return c?.error && /Linear signed agentbook out\. Sign in with Linear again\./.test(c.error) ? c : null;
  }, 10000);
  check(!!out, "when Linear won't renew it (she took agentbook's access away there), her connector says to sign in again");
  linear.oauth.signinAs = "alice";
  await browse(alice, (await alice.post("/api/linear/signin", { id: conn.id })).url);
  const again = (await alice.get("/api/connectors")).connectors;
  check(/^Signed in with Linear as Alice, in Acme\.$/.test(await note(alice)) && again.length === 1 && again[0].id === conn.id, "and signing in again gives that connector a new sign-in");
  await alice.post(`/api/connectors/${conn.id}/sync`);
  check(!(await alice.get("/api/connectors")).connectors[0].error, "which works");

  // ---------- by way of the sign-in relay ----------
  // A page with a sign-in relay and no app of its own goes through the relay's, from whatever address it's at.
  await stop();
  await start({ AGENTBOOK_RELAY_URL: RELAY, AGENTBOOK_LINEAR_CLIENT_ID: "" });
  const kept2 = await until(() => fs.existsSync(path.join(HOME, "server", "relay-linear-app.json")));
  check(kept2 && JSON.parse(fs.readFileSync(path.join(HOME, "server", "relay-linear-app.json"), "utf8")).redirect_uri === RELAY_CALLBACK && (fs.statSync(path.join(HOME, "server", "relay-linear-app.json")).mode & 0o777) === 0o600, "the page learns the relay's Linear app as it starts, and keeps it, readable only by whoever runs it");
  const viaRelay = await alice.post("/api/linear/signin", { id: conn.id });
  const toRelay = new globalThis.URL(viaRelay.url || "http://x");
  const rq = Object.fromEntries(toRelay.searchParams);
  check(toRelay.origin + toRelay.pathname === `${RELAY}/linear` && rq.origin === URL && /^[\w-]{43}$/.test(rq.challenge) && rq.state && rq.scope === "read,write" && !/verifier|secret|client_id/.test(viaRelay.url), "signing in sends her to the relay with the page's address, its state and a PKCE challenge, and nothing else");
  const trip = await hops(alice, viaRelay.url);
  check(trip.went.length === 4 && trip.went[1].startsWith(`${linear.web}/oauth/authorize`) && trip.went[2].startsWith(RELAY_CALLBACK) && trip.went[3].startsWith(CALLBACK) && trip.location === "/#/connectors", "from the relay to Linear, back to the relay, and on to the page");
  const viaTrade = linear.oauth.seen.filter((p) => p.grant_type === "authorization_code").at(-1);
  check(viaTrade.client_id === "test-client" && viaTrade.redirect_uri === RELAY_CALLBACK && viaTrade.code_verifier && !viaTrade.client_secret, "the page trades the code itself, naming the relay's address as Linear's redirect, with its own verifier");
  check(/^Signed in with Linear as Alice, in Acme\.$/.test(await note(alice)) && (await alice.get("/api/connectors")).connectors.length === 1, "and she's signed in, on the same connector");
  // Once the relay names none, the page goes straight to Linear again, with agentbook's app.
  relayNamesIt = false;
  await stop();
  await start({ AGENTBOOK_RELAY_URL: RELAY, AGENTBOOK_LINEAR_CLIENT_ID: "" });
  const gone = await until(() => !fs.existsSync(path.join(HOME, "server", "relay-linear-app.json")));
  const straight = new globalThis.URL((await alice.post("/api/linear/signin", {})).url || "http://x");
  check(gone && straight.origin + straight.pathname === `${linear.web}/oauth/authorize` && straight.searchParams.get("client_id") === "f32eddfc9ea7754427f8ba2df0ea07b1" && straight.searchParams.get("redirect_uri") === CALLBACK, "once the relay names none, the page goes straight to Linear, with agentbook's app");
} finally {
  server.kill();
  linear.close();
  relay.close();
  relay.closeAllConnections();
}
closeSql();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
