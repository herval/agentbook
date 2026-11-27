#!/usr/bin/env node
// Accounts: the page's person and the others the tests make (server/api/test-people.ts), signing in and out,
// profiles, what's gone (passwords, the setup link, invites, sign-ups, and the commands that made accounts), the
// privacy note, the page's own fonts, guessing at machine login codes, and whose address a request is from.
// Run: node test/accounts.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { clientAddress } from "../server/accounts.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-accounts-"));
const PORT = testPort(4700);
const URL = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie, headers = {} }: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get("set-cookie") || "";
  return { status: r.status, setCookie, cookie: setCookie.split(";")[0], ...((await r.json().catch(() => ({}))) as Json) };
}
const cli = (args, input = "") => spawnSync(process.execPath, [path.join(ROOT, "..", "server", "admin.ts"), ...args], { env, input, encoding: "utf8", timeout: 20000 });

const server = spawnAgentbook({ env, stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }

  // ---------- the page's person ----------
  const before = await req("GET", "/api/auth/me");
  check(before.user === null && before.account === false && !("setup" in before) && !("signups" in before), "a page whose machine is on no account has nobody signed in, and no setup link or sign-ups to offer");
  check((await stateOf((p) => req("GET", p))).status === 401 && (await req("GET", "/api/sessions/x")).status === 401, "nothing on the page loads signed out");
  const first = await req("POST", "/api/auth/test-person", { body: { username: "Herval", display_name: "Herval" } });
  const admin = first.cookie;
  check(first.status === 200 && first.user.username === "herval" && first.user.role === "admin" && first.first === true, "the first person is the page's, their username lowercased");
  check(/HttpOnly/.test(first.setCookie) && /SameSite=Lax/.test(first.setCookie) && /Expires=/.test(first.setCookie) && !/Secure/.test(first.setCookie), "their cookie can't be read by the page, isn't sent cross-site, lasts, and is plain over http");
  check((await stateOf((p) => req("GET", p, { cookie: admin }))).status === 200 && (await req("GET", "/api/auth/me", { cookie: admin })).user.username === "herval", "signed in, the page loads");

  // ---------- signing in and out ----------
  const second = await req("POST", "/api/auth/test-person", { body: { username: "herval" } });
  check(second.status === 200 && second.cookie !== admin && second.user.id === first.user.id, "signing in again is a sign-in of its own");
  await req("POST", "/api/auth/logout", { cookie: second.cookie });
  check((await stateOf((p) => req("GET", p, { cookie: second.cookie }))).status === 401 && (await stateOf((p) => req("GET", p, { cookie: admin }))).status === 200, "signing out ends that sign-in only");
  check((await req("POST", "/api/launch", { cookie: admin, body: { prompt: "x", root: HOME }, headers: { origin: "https://evil.example" } })).status === 403, "another site can't post as you, even with your cookie");
  check((await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", session_id: "s-1", cwd: HOME } })).status === 200, "this machine's sessions still register without signing in");

  // ---------- what's gone ----------
  const gone = [
    ["POST", "/api/auth/login", { username: "herval", password: "correct horse battery" }],
    ["POST", "/api/auth/setup", { username: "second", password: "correct horse battery" }],
    ["POST", "/api/auth/signup", { username: "eve", password: "correct horse battery" }],
    ["GET", "/api/auth/invite/abc"],
    ["POST", "/api/invites", {}],
    ["GET", "/api/invites"],
    ["POST", "/api/me/password", { current: "a", password: "b" }],
    ["POST", "/api/me/delete", { username: "herval" }],
  ] as const;
  const answers = await Promise.all(gone.map(([m, p, body]) => req(m, p, { cookie: admin, ...(body ? { body } : {}) })));
  check(answers.every((a) => a.status === 404), `passwords, the setup link, sign-ups and invites are gone (${gone.filter((_, i) => answers[i].status !== 404).map(([m, p]) => `${m} ${p}`).join(", ") || "none answer"})`);
  for (const cmd of ["adduser", "passwd", "invite", "disable", "accounts"]) {
    const r = cli([cmd, "bob"], "a long password here\n");
    check(r.status !== 0 && /usage|link \| import/i.test(r.stderr + r.stdout), `agentbook-server ${cmd} is gone`);
  }

  // ---------- others, and profiles ----------
  const alice = await req("POST", "/api/auth/test-person", { body: { username: "alice", display_name: "Alice" } });
  check(alice.status === 200 && alice.user.role === "member" && alice.first === false, "anyone else is a member");
  check((await req("POST", "/api/people/alice/disable", { cookie: admin })).status === 404 && (await req("POST", "/api/people/herval/delete", { cookie: admin })).status === 400 && (await req("POST", "/api/people/herval/delete", { cookie: alice.cookie })).status === 403, "nobody turns anyone off; the page's person can't take themself off it, and nobody else takes anyone off");
  await req("POST", "/api/me", { cookie: alice.cookie, body: { display_name: "Alice Liddell", bio: "Down the rabbit hole." } });
  const herProfile = await req("GET", "/api/people/alice", { cookie: admin });
  const ownProfile = await req("GET", "/api/people/alice", { cookie: alice.cookie });
  const hisProfile = await req("GET", "/api/people/herval", { cookie: alice.cookie });
  check(herProfile.user.display_name === "Alice Liddell" && herProfile.user.bio === "Down the rabbit hole." && !hisProfile.devices && !herProfile.devices && ownProfile.me && Array.isArray(ownProfile.devices), "a profile shows a name and bio; only its owner sees their machines");
  check((await req("GET", "/api/people", { cookie: alice.cookie })).people.length === 2 && !/password|scrypt/.test(JSON.stringify(herProfile)), "people are listed, with nothing of a password");
  const aliceElsewhere = (await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie;
  await req("POST", "/api/me/signout-everywhere", { cookie: alice.cookie });
  check((await stateOf((p) => req("GET", p, { cookie: aliceElsewhere }))).status === 401 && (await stateOf((p) => req("GET", p, { cookie: alice.cookie }))).status === 200, "sign out everywhere else keeps this sign-in");

  // ---------- the privacy note ----------
  const note = await fetch(`${URL}/privacy`);
  const noteText = await note.text();
  check(note.status === 200 && /text\/html/.test(note.headers.get("content-type")) && /What agentbook keeps of yours/.test(noteText) && noteText.includes(`<b>127.0.0.1:${PORT}</b>`) && !/\{\{/.test(noteText), "/privacy is open to anyone, and names this server");

  // ---------- the page loads nothing from anywhere else ----------
  const page = await fetch(`${URL}/`);
  const pageHtml = await page.text();
  const fontCss = await fetch(`${URL}/fonts/fonts.css`);
  const woff = await fetch(`${URL}/fonts/Geist-Variable.woff2`);
  check(!/googleapis|gstatic/.test(pageHtml) && !/googleapis|gstatic/.test(page.headers.get("content-security-policy") || "") && /\/fonts\/fonts\.css/.test(pageHtml), "the page links its fonts here, and its CSP names no other site for them");
  check(fontCss.status === 200 && /Geist Mono/.test(await fontCss.text()) && woff.status === 200 && woff.headers.get("content-type") === "font/woff2" && woff.headers.get("access-control-allow-origin") === "*" && (await woff.arrayBuffer()).byteLength > 50000, "the fonts are served from here, as woff2 a sandboxed frame may read");

  // ---------- guessing at machine login codes ----------
  const bobsCookie = (await req("POST", "/api/auth/test-person", { body: { username: "bob" } })).cookie;
  const asked = await req("POST", "/api/devices/start", { body: { name: "guessable" } });
  const seen = await req("GET", `/api/devices/request/${asked.code}`, { cookie: bobsCookie });
  check(seen.status === 200 && seen.from === "127.0.0.1" && !!seen.created, "whoever enters a code is told where the machine asked from, and when");
  let miss;
  for (let i = 0; i < 10; i++) miss = await req("GET", "/api/devices/request/ZZZZ-ZZZ" + i, { cookie: bobsCookie });
  const eleventh = await req("GET", `/api/devices/request/${asked.code}`, { cookie: bobsCookie });
  const approveToo = await req("POST", "/api/devices/approve", { cookie: bobsCookie, body: { code: asked.code } });
  check(miss.status === 404 && eleventh.status === 429 && approveToo.status === 429 && /weren't waiting/.test(approveToo.error), "10 codes nobody's waiting with, and that person can't look up or approve any for a while, the right one included");
  let starts;
  for (let i = 0; i < 22 && starts?.status !== 429; i++) starts = await req("POST", "/api/devices/start", { body: { name: `flood${i}` } });
  check(starts.status === 429 && /from here/.test(starts.error), "and 20 machines asking from one address in a few minutes is enough: the next waits");

  // ---------- whose address a request is from ----------
  check(clientAddress({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "fly-client-ip": "198.51.100.7" } }) === "127.0.0.1", "without AGENTBOOK_TRUST_PROXY the socket's address is the client's");
  check(clientAddress({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }, true) === "203.0.113.9" && clientAddress({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.9", "fly-client-ip": "198.51.100.7" } }, true) === "198.51.100.7", "with it, the first forwarded address is, and Fly-Client-IP first");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
