#!/usr/bin/env node
// agentbook as one process (`agentbook webui`, plugin/cli/webui.ts): the page and this machine's sessions, served by
// agentbook-cli's daemon, on their own ports and data folders as before. A machine logged in to its account
// (agentbook login, through a fake relay, test/fake-relay.ts) serves the page its person signs in to with Google, and
// logs itself in to it once they have; `agentbook cli` does the rest from the command line; `agentbook stop` stops
// both; a hook's plain start serves the page too once the machine is logged in to it; and the two processes of before
// (agentbook-server on its own, agentbook-cli logged in to it) become one, with the same login. The server's secrets
// are gone from the daemon's environment, which every agent it starts gets, once it's loaded.
// Run: node test/webui.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeRelay } from "./fake-relay.ts";
import { freePort, spawnTied } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST, "..");
const KEY = "aGFybmVzcy1zZWNyZXQta2V5LTMyLWJ5dGVzLWxvbmc=";

// The server loaded into this process, as the daemon loads it: what the environment has after (one line of JSON).
if (process.argv[2] === "--in-process") {
  const { createPage } = await import(pathToFileURL(path.join(REPO, "plugin", "cli", "webui.ts")).href);
  const umask = process.umask();
  const page = createPage({ url: process.env.PAGE_URL });
  const served = await page.keep();
  const health = await fetch(`${process.env.PAGE_URL}/api/health`).then((r) => r.json()).catch(() => null);
  // Whether it has a secret key to keep people's API keys with: the same module the page loaded.
  const { connectors } = await import(pathToFileURL(path.join(REPO, "server", "core", "services.ts")).href);
  console.log(JSON.stringify({ served, health, keeps: !connectors.cantKeep(), key: process.env.AGENTBOOK_SECRET_KEY ?? null, port: process.env.AGENTBOOK_SERVER_PORT ?? null, umask: process.umask() === umask }));
  process.exit(0);
}

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-webui-")));
const CLI_PORT = await freePort(6700, 40);
const PAGE_PORT = await freePort(6750, 40);
const PAGE = `http://127.0.0.1:${PAGE_PORT}`;
const USER = path.join(BASE, "person");
fs.mkdirSync(USER, { recursive: true });
// The relay, and Pat's Google account. The data folder is the account's (AGENTBOOK_HOME), not ~/.agentbook's, whose
// first run on nobody's account test/first-run-account.ts has.
const relay = await fakeRelay();
const pat = { sub: "google:4242", acct: "0193a000-0000-7000-8000-000000000ba7", email: "pat@example.com", name: "Pat" };
relay.person = pat;
const env = { PATH: process.env.PATH, AGENTBOOK_RELAY_URL: relay.url, HOME: USER, LANG: "en_US.UTF-8", CLAUDE_CONFIG_DIR: path.join(USER, ".claude"), AGENTBOOK_HOME: path.join(USER, "agentbook-data"), AGENTBOOK_PORT: String(CLI_PORT), AGENTBOOK_SERVER_PORT: String(PAGE_PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_LINK_POLL_MS: "100", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_DESKTOP_DIRS: "" };

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const agentbook = (...args: string[]) => spawnSync(path.join(REPO, "bin", "agentbook"), args, { env, encoding: "utf8", timeout: 90e3 });
const get = (port: number, route: string): Promise<Json> => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
const pidOn = (port: number) => spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim();
async function until<T>(fn: () => Promise<T>, ms = 10e3) {
  let v: T;
  for (const end = Date.now() + ms; !(v = await fn()) && Date.now() < end; ) await sleep(100);
  return v;
}
const connected = () => until(async () => {
  const st = await get(CLI_PORT, "/api/status");
  return st?.connected ? st : null;
});
// agentbook login, saying yes on the relay's page once it shows the code.
function login(): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnTied(path.join(REPO, "bin", "agentbook"), ["login", "--no-open", "--no-start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let said = false;
    const take = (b: Buffer) => {
      out += b;
      const code = /\b([B-Z]{4}-[B-Z]{4})\b/.exec(out)?.[1];
      if (code && !said) {
        said = true;
        setTimeout(() => relay.approve(code), 50);
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
// A browser's Google button, through the relay and back: where the page sends it at the end, and its session cookie.
async function signIn(): Promise<{ to: string; cookie: string }> {
  const jar = new Map<string, string>();
  const get = async (url: string) => {
    const r = await fetch(url, { redirect: "manual", headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      if (/Max-Age=0\b/.test(c)) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return r.headers.get("location") || "";
  };
  const to = await get(await get(await get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: PAGE })}`)));
  return { to, cookie: `agentbook_session=${jar.get("agentbook_session") || ""}` };
}
const log = fs.openSync(path.join(BASE, "out.log"), "a");
const detached = (args: string[]) => spawnTied(args[0], args.slice(1), { env, stdio: ["ignore", log, log], detached: true }).unref();

try {
  // The first run: logged in to Pat's account, one process, and the machine logged in to its page once Pat signs in.
  const loggedIn = await login();
  check(loggedIn.status === 0 && fs.existsSync(path.join(env.AGENTBOOK_HOME, "machine.json")), `agentbook login puts the machine on Pat's account (${loggedIn.out.trim().split("\n").at(-1)})`);
  let r = agentbook("webui", "--no-open");
  check(r.status === 0 && r.stdout.includes(PAGE) && !/isn't on an agentbook account/.test(r.stdout), `agentbook webui starts it (${(r.stdout + r.stderr).trim().split("\n")[0]})`);
  check(pidOn(PAGE_PORT) && pidOn(PAGE_PORT) === pidOn(CLI_PORT), "the page and the sessions are one process");
  let st = await get(CLI_PORT, "/api/status");
  check(st?.page === PAGE && !st.server, "it serves the page, and isn't logged in to it before its person has signed in");
  const pats = await signIn();
  check(pats.to === "/" && (await fetch(`${PAGE}/api/auth/me`, { headers: { cookie: pats.cookie } }).then((x) => x.json() as Promise<Json>)).user?.username === "pat", "Pat signs in with Google, as the account");
  st = await connected();
  check(st?.server === PAGE, "the machine logs in to its page and connects");
  const device = JSON.parse(fs.readFileSync(path.join(env.AGENTBOOK_HOME, "cli", "device.json"), "utf8"));
  check(device.local === true && device.user === "pat" && device.server === PAGE, "its login is to this machine's own page, as @pat's");
  const home = await fetch(`http://127.0.0.1:${CLI_PORT}/`, { redirect: "manual" });
  check(home.status === 302 && home.headers.get("location") === `${PAGE}/`, "/ at the sessions' port sends you to the page");

  // agentbook cli: status by default, the page's commands, the gate's.
  r = agentbook("cli");
  check(r.status === 0 && r.stdout.includes(`serves agentbook's page too, at ${PAGE}`), "agentbook cli says its status, with the page");
  r = agentbook("cli", "backup", path.join(BASE, "backup"));
  check(r.status === 0 && fs.existsSync(path.join(BASE, "backup", "storage.db")), `agentbook cli backup is the page's (${(r.stdout + r.stderr).trim().split("\n")[0]})`);
  r = agentbook("cli", "gate");
  check(r.status === 0 && /@pat's/.test(r.stdout), "agentbook cli gate is the machine's");

  // Running again leaves it be; stop stops both.
  const pid = pidOn(CLI_PORT);
  r = agentbook("webui", "--no-open");
  check(r.status === 0 && pidOn(CLI_PORT) === pid, "agentbook webui again leaves it running");
  r = agentbook("stop");
  check(!pidOn(CLI_PORT) && !pidOn(PAGE_PORT) && /page/.test(r.stdout), `agentbook stop stops both (${r.stdout.trim()})`);

  // What a session's hook starts (run, nothing more) serves the page too, logged in to it.
  detached([process.execPath, path.join(REPO, "plugin", "cli", "main.mjs"), "run"]);
  st = await connected();
  check(st?.page === PAGE && pidOn(PAGE_PORT) === pidOn(CLI_PORT), "a hook's start serves the page and connects to it");
  agentbook("stop");

  // The two processes of before become one, with the same login.
  detached(["/bin/sh", path.join(REPO, "bin", "agentbook-server")]);
  await until(() => get(PAGE_PORT, "/api/health"));
  const server = pidOn(PAGE_PORT);
  detached([process.execPath, path.join(REPO, "plugin", "cli", "main.mjs"), "run"]);
  st = await connected();
  check(server && pidOn(CLI_PORT) !== server && st && !st.page, "agentbook-server on its own is used, not taken over, by a CLI that starts beside it");
  r = agentbook("webui", "--no-open");
  st = await connected();
  check(r.status === 0 && /Stopping the agentbook-server/.test(r.stdout) && pidOn(PAGE_PORT) === pidOn(CLI_PORT) && pidOn(PAGE_PORT) !== server && st?.page === PAGE, "agentbook webui makes the two of before one process");
  check(JSON.parse(fs.readFileSync(path.join(env.AGENTBOOK_HOME, "cli", "device.json"), "utf8")).token === device.token, "with the same login");
  agentbook("stop");

  // Loaded into a process, the server leaves no secret in its environment, and its umask as it was.
  const inner = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--in-process"], { env: { ...env, AGENTBOOK_HOME: path.join(BASE, "inner"), PAGE_URL: `http://127.0.0.1:${PAGE_PORT}`, AGENTBOOK_SECRET_KEY: KEY }, encoding: "utf8", timeout: 60e3 });
  const out = JSON.parse(inner.stdout.trim().split("\n").pop() || "{}");
  check(out.served && out.health?.server && out.keeps, "the server loads into a process and serves, with the secret key it was given");
  check(out.key === null, "and its secret key isn't left in that process's environment");
  check(out.port === String(PAGE_PORT) && out.umask, "what it was given otherwise is as it was, the umask too");
  // Given no key (here or in .env beside the checkout), it uses the machine's own, made the first time, outside its
  // data folder (plugin/shared/secret-key.ts).
  const keyFile = path.join(USER, "config", "agentbook", "secret-key");
  const dotenvKey = /^\s*AGENTBOOK_SECRET_KEY=/m.test(fs.existsSync(path.join(REPO, ".env")) ? fs.readFileSync(path.join(REPO, ".env"), "utf8") : "");
  const own = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--in-process"], { env: { ...env, AGENTBOOK_HOME: path.join(BASE, "own-key"), PAGE_URL: `http://127.0.0.1:${PAGE_PORT}`, AGENTBOOK_SECRET_KEY_FILE: keyFile }, encoding: "utf8", timeout: 60e3 });
  const ownOut = JSON.parse(own.stdout.trim().split("\n").pop() || "{}");
  check(ownOut.served && ownOut.keeps && ownOut.key === null && fs.existsSync(keyFile) === !dotenvKey && (dotenvKey || (fs.statSync(keyFile).mode & 0o777) === 0o600), `given no secret key, it keeps people's keys with ${dotenvKey ? "the one in .env" : "one it made for this machine, outside its data folder, readable only by its user"}, and leaves it out of the environment`);
} finally {
  agentbook("stop");
  if (failures) console.log(fs.readFileSync(path.join(BASE, "out.log"), "utf8").slice(-4000));
  fs.rmSync(BASE, { recursive: true, force: true });
  await relay.close();
}
console.log(failures ? `${failures} failed` : "All passed.");
process.exit(failures ? 1 : 0);
