#!/usr/bin/env node
// `agentbook login` and `logout` through agentbook-relay (plugin/cli/relay-login.ts), against a fake relay
// (test/fake-relay.ts): the machine's key and certificate in its account's folder, the page that only that account
// signs in to, as its person, and logging out, which takes the machine off the account and deletes the folder. And
// where an account's folder is: ~/.agentbook/accounts/<id>, the default one picked by plugin/cli/main.mjs.
// Run: node test/relay-login.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeRelay } from "./fake-relay.ts";
import { halves, spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";
import { createVerifier } from "../plugin/shared/relay-verify.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(REPO, "plugin", "cli", "main.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-relay-login-"));
const PORT = testPort(7700);
const PAGE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const relay = await fakeRelay();
const ada = { sub: "google:1001", acct: "0193a000-0000-7000-8000-00000000ada0", email: "ada@example.com", name: "Ada Lovelace" };
const bo = { sub: "google:2002", acct: "0193a000-0000-7000-8000-0000000000b0", email: "bo@example.com", name: "Bo" };

const envFor = (more: Record<string, string>) => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_RELAY_URL: relay.url, AGENTBOOK_MACHINE: "testbox", ...more };
  for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "CLAUDE_JOB_DIR", ...(more.AGENTBOOK_HOME ? [] : ["AGENTBOOK_HOME"])]) delete env[k];
  return env;
};
// agentbook-cli, as a person runs it. `answer`: what they do on the relay's page once it shows a code.
function cli(args: string[], env: NodeJS.ProcessEnv, answer: (code: string) => void = () => {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnTied(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let answered = false;
    const take = (b: Buffer) => {
      out += b;
      const code = /\b([B-Z]{4}-[B-Z]{4})\b/.exec(out)?.[1];
      if (code && !answered) {
        answered = true;
        setTimeout(() => answer(code), 50);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = setTimeout(() => child.kill("SIGKILL"), 60e3);
    child.on("exit", (status) => {
      clearTimeout(kill);
      resolve({ status, out });
    });
  });
}
// A browser: its cookies, and the page's Google button through the relay and back.
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
    async json(method: string, p: string, body?: unknown): Promise<Json> {
      const r = take(await fetch(PAGE + p, { method, headers: { cookie: header(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
      return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
    },
    async signIn(why = "login"): Promise<string> {
      const start = await get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ why, origin: PAGE })}`);
      const toRelay = start.headers.get("location") || "";
      if (!toRelay.startsWith(relay.url)) return toRelay;
      const back = (await get(toRelay)).headers.get("location") || "";
      return (await get(back)).headers.get("location") || "";
    },
  };
}
async function up() {
  for (let i = 0; i < 150; i++) {
    if ((await fetch(PAGE + "/api/health").catch(() => null))?.ok) return;
    await sleep(100);
  }
}
const running: ReturnType<typeof spawnAgentbook>[] = [];
const cliStatus = async () => (await (await fetch(`http://127.0.0.1:${halves(PORT).cli}/api/status`).catch(() => null))?.json().catch(() => null)) as Json | null;

try {
  // ---------- agentbook login ----------
  const home = path.join(BASE, "home");
  const env = envFor({ AGENTBOOK_HOME: home });
  relay.person = ada;
  const denied = await cli(["login", "--no-open", "--no-start"], env, (code) => relay.deny(code));
  check(denied.status !== 0 && /said no/.test(denied.out) && !fs.existsSync(path.join(home, "machine.json")), `saying no on the relay's page leaves nothing behind (${denied.out.trim().split("\n").at(-1)})`);

  const logged = await cli(["login", "--no-open", "--no-start"], env, (code) => relay.approve(code));
  check(logged.status === 0 && /open this, sign in, and check it shows [B-Z]{4}-[B-Z]{4}/.test(logged.out) && /link\?code=/.test(logged.out), "it shows the relay's address and the code to check there");
  check(/Signed in: testbox is on your agentbook/.test(logged.out), `once they say yes, it's signed in (${logged.out.trim().split("\n").at(-1)})`);
  const file = path.join(home, "machine.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  check((fs.statSync(file).mode & 0o777) === 0o600, "its login is a file only its owner can read");
  check(saved.account === ada.acct && saved.person === ada.acct && saved.relay === relay.url && saved.name === "testbox", "it's the account's, and the page's person is the account");
  const cert = await createVerifier({ relay: relay.url }).verifyMachine(saved.certificate);
  const onRelay = relay.machines(ada.acct);
  check(cert.acct === ada.acct && cert.key === saved.key.x && onRelay.length === 1 && onRelay[0].key === saved.key.x && onRelay[0].id === saved.machine, "the certificate is the relay's, for its key, and the relay has the machine on the account");
  check(!JSON.stringify(relay.seen).includes(saved.key.d) && !JSON.stringify(onRelay).includes(saved.key.d), "the key's private half never left the machine");

  // ---------- the page: only that account signs in ----------
  // As two processes first, the server under Node's permission model, reading the machine's login as it may.
  let agentbook = spawnAgentbook({ env });
  running.push(agentbook);
  await up();
  const anon = browser();
  const me = await anon.json("GET", "/api/auth/me");
  check(me.account === true && me.user === null && me.relay?.url === relay.url, "its page is the account's, which signs in with Google through the relay");
  check((await anon.json("POST", "/api/auth/login", { username: "x", password: "correct horse battery" })).status === 404, "there's no signing in with a password");
  check((await anon.json("POST", "/api/auth/setup", { username: "x", password: "correct horse battery" })).status === 404 && (await anon.json("POST", "/api/auth/signup", { username: "x", password: "correct horse battery" })).status === 404, "nor a setup link, nor signing up");
  relay.person = bo;
  const stranger = browser();
  check((await stranger.signIn()) === "/?signin=other-account", "someone else's Google account doesn't sign in: it's not this machine's");
  check((await stranger.json("GET", "/api/auth/me")).user === null, "…and they aren't signed in");
  agentbook.kill("SIGTERM");
  await new Promise((r) => agentbook.once("exit", r));

  // Then as it runs on a machine, one process (agentbook webui), which logs itself in to its page once there's a person.
  agentbook = spawnAgentbook({ env: { ...env, AGENTBOOK_HARNESS_ONE: "1" } });
  running.push(agentbook);
  await up();
  check(!(await cliStatus())?.connected, "until its person signs in, the machine isn't logged in to its page");

  relay.person = ada;
  const herself = browser();
  check((await herself.signIn()) === "/", "the account's own Google account signs in");
  const her = await herself.json("GET", "/api/auth/me");
  check(her.user?.id === ada.acct && her.user.username === "ada" && her.user.display_name === "Ada Lovelace", `as the page's person, with the account's id, made now (@${her.user?.username})`);
  let connected = false;
  for (let i = 0; i < 100 && !connected; i++) connected = !!(await cliStatus())?.connected || (await sleep(100), false);
  check(connected, "and with that the machine logs in to its page");
  const again = browser();
  check((await again.signIn()) === "/" && (await again.json("GET", "/api/auth/me")).user?.id === ada.acct, "signing in again is the same person");
  check((await herself.json("GET", "/api/people")).people?.length === 1, "nobody else was made");

  // ---------- login again: a fresh certificate ----------
  const before = relay.seen.length;
  const renewed = await cli(["login", "--no-open", "--no-start"], env);
  const now = JSON.parse(fs.readFileSync(file, "utf8"));
  check(renewed.status === 0 && /Already signed in/.test(renewed.out) && relay.seen.slice(before).includes("POST /machines/renew") && now.machine === saved.machine && now.key.x === saved.key.x, "logging in again renews its certificate, as the same machine");

  // ---------- logout ----------
  agentbook.kill("SIGTERM");
  await new Promise((r) => agentbook.once("exit", r));
  const asked = await cli(["logout"], env);
  check(asked.status !== 0 && /--yes/.test(asked.out) && fs.existsSync(file) && !relay.machines(ada.acct)[0].revoked, "with nobody to say yes, logging out deletes nothing");
  const out = await cli(["logout", "--yes"], env);
  check(out.status === 0 && /deletes everything agentbook keeps for you on it/.test(out.out) && /Logged out/.test(out.out), `logging out says what goes first (${out.out.trim().split("\n").at(-1)})`);
  check(!!relay.machines(ada.acct)[0].revoked, "the relay took the machine off the account");
  check(!fs.existsSync(home), "and the account's folder is gone");

  // ---------- accounts' folders, in the root ----------
  const root = path.join(BASE, "root");
  const renv = envFor({ AGENTBOOK_ROOT: root });
  const first = await cli(["login", "--no-open", "--no-start"], renv, (code) => relay.approve(code));
  const accountHome = path.join(root, "accounts", ada.acct);
  check(first.status === 0 && fs.existsSync(path.join(accountHome, "machine.json")), `with no AGENTBOOK_HOME, the account's folder is accounts/<its id> (${first.out.trim().split("\n").at(-1)})`);
  check(JSON.parse(fs.readFileSync(path.join(root, "accounts", "accounts.json"), "utf8")).default === ada.acct, "and it's the machine's default account");
  const next = await cli(["login", "--no-open", "--no-start"], renv);
  check(/Already signed in/.test(next.out), "agentbook runs in the default account's folder from then on");
  const gone = await cli(["logout", "--yes"], renv);
  check(gone.status === 0 && !fs.existsSync(accountHome) && JSON.parse(fs.readFileSync(path.join(root, "accounts", "accounts.json"), "utf8")).default === null, "logging out of it leaves no default");

  // A machine with data from before accounts: test/migrate-in-place.ts.
} finally {
  await relay.close();
  for (const p of running) if (p.exitCode === null) p.kill("SIGKILL");
  fs.rmSync(BASE, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
