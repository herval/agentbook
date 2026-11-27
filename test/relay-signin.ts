#!/usr/bin/env node
// Signing in to a page through the sign-in relay (server/api/signin.ts). The page is one account's: the one its
// machine logged in with (machine.json, as agentbook login leaves it), and only that account gets in, with Google. Its
// person is made at the first sign-in. Then the answers that don't hold, and a page whose machine is on no account. The
// relay is faked (a key, its JWKS, and a /login that answers at once, as agentbook-relay does once someone has said
// yes); its protocol is ../agentbook-relay/PROTOCOL.md.
// Run: node test/relay-signin.ts

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-relay-signin-"));
const PORT = testPort(4760);
const PAGE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the relay, faked ----------
const key = crypto.generateKeyPairSync("ed25519");
const stranger = crypto.generateKeyPairSync("ed25519");
const kid = "k1";
const relay = {
  url: "",
  person: { sub: "google:1001", email: "ada@example.com", name: "Ada Lovelace" } as Record<string, unknown>,
  // What it does next: "deny" (Cancel), or changes to the token's claims, or signing with a key it doesn't publish.
  deny: false,
  tamper: {} as Record<string, unknown>,
  foreign: false,
  last: "" as string, // the last answer it sent back, for replaying
};
const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(claims: Record<string, unknown>): string {
  const signed = `${part({ alg: "EdDSA", typ: "JWT", kid })}.${part(claims)}`;
  return `${signed}.${crypto.sign(null, Buffer.from(signed), (relay.foreign ? stranger : key).privateKey).toString("base64url")}`;
}
const relayServer = http.createServer((req, res) => {
  const u = new URL(req.url || "/", relay.url);
  if (u.pathname === "/.well-known/jwks.json") {
    const { x } = key.publicKey.export({ format: "jwk" });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }] }));
  }
  if (u.pathname === "/login") {
    const origin = u.searchParams.get("origin");
    const back = new URL("/api/auth/relay/done", origin);
    back.searchParams.set("state", u.searchParams.get("state"));
    if (relay.deny) back.searchParams.set("error", "access_denied");
    else {
      const iat = Math.floor(Date.now() / 1000);
      back.searchParams.set("token", token({ iss: relay.url, aud: origin, nonce: u.searchParams.get("nonce"), iat, exp: iat + 300, jti: crypto.randomUUID(), provider: "google", email_verified: true, acct: `acct-${relay.person.sub}`, ...relay.person, ...relay.tamper }));
    }
    relay.last = back.toString();
    res.writeHead(302, { location: relay.last });
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
relayServer.listen(0, "127.0.0.1");
await new Promise((r) => relayServer.once("listening", r));
relay.url = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

// ---------- a browser ----------
function browser() {
  const jar = new Map<string, string>();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const take = (r: Response) => {
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      if (/Max-Age=0\b/.test(c)) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return r;
  };
  const get = async (url: string) => take(await fetch(url, { redirect: "manual", headers: { cookie: header() } }));
  return {
    jar,
    get,
    async json(method: string, p: string, body?: unknown): Promise<Json> {
      const r = take(await fetch(PAGE + p, { method, headers: { cookie: header(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
      return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
    },
    // The page's button, the relay, and back: where the page sends the browser at the end.
    async signIn(): Promise<string> {
      const start = await get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: PAGE })}`);
      const toRelay = start.headers.get("location") || "";
      if (!toRelay.startsWith(relay.url)) return toRelay;
      const back = (await get(toRelay)).headers.get("location") || "";
      return (await get(back)).headers.get("location") || "";
    },
  };
}

// The machine's login, as agentbook login leaves it: the account (the relay's id for Ada's Google account) and its person.
const ADA = { sub: "google:1001", email: "ada@example.com", name: "Ada Lovelace" };
const ACCT = `acct-${ADA.sub}`;
fs.writeFileSync(path.join(HOME, "machine.json"), JSON.stringify({ relay: relay.url, account: ACCT, person: ACCT, machine: "m1", name: "adamac", certificate: "x.y.z", expires_at: new Date(Date.now() + 7 * 86400e3).toISOString(), key: { x: "", d: "" }, machines: [] }), { mode: 0o600 });
relay.person = ADA;

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_RELAY_URL: relay.url };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "CLAUDE_JOB_DIR"]) delete env[k];
const up = async (page: string) => {
  for (let i = 0; i < 100; i++) {
    if ((await fetch(page + "/api/health").catch(() => null))?.ok) return true;
    await sleep(100);
  }
  return false;
};
const server = spawnAgentbook({ env: { ...env, AGENTBOOK_TEST_PEOPLE: "0" }, stdio: "ignore" });
try {
  await up(PAGE);
  const ada = browser();

  // ---------- the account's person ----------
  const before = await ada.json("GET", "/api/auth/me");
  check(before.account === true && before.user === null && before.relay?.providers?.[0]?.id === "google" && before.relay.url === relay.url, "the page is its machine's account's, and offers Google through the relay");
  check((await ada.json("POST", "/api/auth/test-person", { username: "mallory" })).status === 404, "(and makes nobody another way)");
  const made = await ada.signIn();
  const me = await ada.json("GET", "/api/auth/me");
  check(made === "/" && me.user?.id === ACCT && me.user.username === "ada" && me.user.display_name === "Ada Lovelace", "the account signs in, and its person is made, with the account's id, named from the email");
  check(!ada.jar.has("agentbook_relay") && ada.jar.has("agentbook_session"), "the sign-in's own cookie goes; a session's comes");
  const again = browser();
  check((await again.signIn()) === "/" && (await again.json("GET", "/api/auth/me")).user?.id === ACCT, "Google signs her in again, in another browser, as the same person");
  relay.person = { sub: "google:2002", email: "bo@example.com", name: "Bo" };
  const bo = browser();
  check((await bo.signIn()) === "/?signin=other-account" && !(await bo.json("GET", "/api/auth/me")).user, "another Google account doesn't get in: it isn't this machine's");
  check((await ada.json("GET", "/api/people")).people?.length === 1, "and nobody else is made");
  relay.person = ADA;

  // ---------- answers that don't hold ----------
  const eve = browser();
  relay.deny = true;
  check((await eve.signIn()) === "/?signin=cancelled", "Cancel at the relay comes back as cancelled");
  relay.deny = false;
  for (const [tamper, label] of [[{ aud: "http://evil.test" }, "a token for another page"], [{ nonce: "someone-elses-nonce" }, "a token for another sign-in"], [{ iss: "http://evil.test" }, "a token from another relay"], [{ exp: 1000, iat: 900 }, "an old token"]] as [Record<string, unknown>, string][]) {
    relay.tamper = tamper;
    const to = await eve.signIn();
    check(/^\/\?signin=(failed|expired)$/.test(to) && !(await eve.json("GET", "/api/auth/me")).user, `${label} is refused`);
  }
  relay.tamper = {};
  relay.foreign = true;
  check((await eve.signIn()) === "/?signin=failed", "a token signed with a key the relay doesn't publish is refused");
  relay.foreign = false;
  // One that held, used again: in the same browser, or in another one.
  const fine = browser();
  check((await fine.signIn()) === "/", "(a sign-in that holds)");
  const replayed = relay.last;
  check((await fine.get(replayed)).headers.get("location") === "/?signin=expired", "its answer can't be used again in the same browser");
  const thief = browser();
  check((await thief.get(replayed)).headers.get("location") === "/?signin=expired" && !(await thief.json("GET", "/api/auth/me")).user, "nor in another");
  // Another browser's sign-in, answered to this one: its state isn't this browser's.
  const victim = browser();
  const start = await thief.get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: PAGE })}`);
  const answer = (await fetch(start.headers.get("location"), { redirect: "manual" })).headers.get("location");
  check((await victim.get(answer)).headers.get("location") === "/?signin=expired" && !(await victim.json("GET", "/api/auth/me")).user, "a sign-in started in one browser can't finish in another");
  check((await fetch(`${PAGE}/api/auth/relay/start?origin=${encodeURIComponent(`${PAGE}/x`)}`, { redirect: "manual" })).status === 400, "the page's address must be only an origin");

  // ---------- a page whose machine is on no account ----------
  const NONE = testPort(4770);
  const nobodyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-relay-none-"));
  const none = spawnAgentbook({ env: { ...env, AGENTBOOK_HOME: nobodyHome, AGENTBOOK_PORT: String(NONE), AGENTBOOK_TEST_PEOPLE: "0" }, stdio: "ignore" });
  try {
    const NONE_PAGE = `http://127.0.0.1:${NONE}`;
    await up(NONE_PAGE);
    const meNone = (await (await fetch(NONE_PAGE + "/api/auth/me")).json()) as Json;
    const startNone = await fetch(`${NONE_PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: NONE_PAGE })}`, { redirect: "manual" });
    check(meNone.account === false && meNone.relay === null && startNone.status === 404, "a page whose machine is on no account signs nobody in");
  } finally {
    none.kill();
    await sleep(300);
    fs.rmSync(nobodyHome, { recursive: true, force: true });
  }
} finally {
  server.kill();
  relayServer.close();
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
