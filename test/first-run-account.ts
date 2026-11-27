#!/usr/bin/env node
// A machine on nobody's account (plugin/cli/first-run.ts): `agentbook webui` serves a page with one button, Sign in
// with Google, which runs agentbook login from the browser through the relay (a fake one, test/fake-relay.ts). Nothing
// of an account is written until the person says yes there; then the account's folder is made and agentbook runs in
// it, at the same address, where that account signs in. Without the page (`agentbook-cli run`, as a hook starts it),
// it runs logged in to nothing, which keeps nothing.
// Run: node test/first-run-account.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeRelay } from "./fake-relay.ts";
import { usersIn } from "../plugin/shared/storage/before.ts";
import { poolPort, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(REPO, "plugin", "cli", "main.mjs");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-first-run-")));
const PORT = testPort(7200);
const CLI = poolPort();
const PAGE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => Promise<T>, ms = 20e3): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return null;
};

const relay = await fakeRelay();
const ada = { sub: "google:1001", acct: "0193a000-0000-7000-8000-00000000ada0", email: "ada@example.com", name: "Ada Lovelace" };
relay.person = ada;
const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_ROOT: ROOT, AGENTBOOK_PORT: String(CLI), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_DSH: "0", AGENTBOOK_AGY: "0", AGENTBOOK_GROK: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_RELAY_URL: relay.url, AGENTBOOK_MACHINE: "freshbox", AGENTBOOK_RELOAD: "0" };
for (const k of ["AGENTBOOK_HOME", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "CLAUDE_JOB_DIR", "AGENTBOOK_TEST_PEOPLE"]) delete env[k];

const pids = new Set<number>();
const cliStatus = async () => (await (await fetch(`http://127.0.0.1:${CLI}/api/status`)).json()) as Json;
const gone = async (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  return until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
};
// Everything in the root but the accounts' folders, and what a machine logged in to nothing keeps (nothing: an empty
// database and its log).
const outside = () => fs.readdirSync(ROOT).filter((f) => !["accounts", "cli", "storage.db", "storage.db-wal", "storage.db-shm"].includes(f));
const nobody = () => usersIn(path.join(ROOT, "storage.db")) === 0 && !fs.existsSync(path.join(ROOT, "server"));

try {
  // ---------- without the page: logged in to nothing ----------
  const hooked = spawnTied(process.execPath, [MAIN, "run"], { env, stdio: "ignore", detached: true });
  pids.add(hooked.pid);
  const plain = await until(cliStatus);
  check(plain?.pid === hooked.pid && !plain.connected && !plain.page && !plain.server, "agentbook-cli run, as a hook starts it, runs logged in to nothing, with no page");
  check(!fs.existsSync(path.join(ROOT, "accounts")) && outside().length === 0 && nobody(), `and keeps nothing (${outside().join(", ")})`);
  check(await gone(hooked.pid), "(it stops)");

  // ---------- the first-run page ----------
  const daemon = spawnTied(process.execPath, [MAIN, "run", "--webui"], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  let err = "";
  daemon.stderr.on("data", (b) => (err += b));
  pids.add(daemon.pid);
  const html = await until(async () => {
    const r = await fetch(PAGE + "/");
    return r.ok ? r.text() : null;
  });
  check(html && /Sign in with Google/.test(html) && /isn't on your agentbook yet/.test(html), `agentbook webui on a machine on nobody's account serves one button: Sign in with Google${err ? ` (${err.trim().split("\n")[0]})` : ""}`);
  check((await fetch(PAGE + "/api/auth/me")).status === 503, "and no page behind it");
  const st = await cliStatus();
  check(st.page === PAGE && st.pid === daemon.pid && !st.connected, "agentbook's commands see it running, with its page");
  check(outside().length === 0 && !fs.existsSync(path.join(ROOT, "accounts")) && nobody(), `with nothing of an account written yet (${outside().join(", ")})`);

  check((await fetch(PAGE + "/api/first-run/start", { method: "POST", headers: { origin: "https://evil.example" } })).status === 403, "another site can't start it");
  const started = (await (await fetch(PAGE + "/api/first-run/start", { method: "POST", headers: { origin: PAGE } })).json()) as Json;
  check(/^[B-Z]{4}-[B-Z]{4}$/.test(started.code) && String(started.url).startsWith(`${relay.url}/link?code=`), "its button opens the relay's page, with the code to check");
  const again = (await (await fetch(PAGE + "/api/first-run/start", { method: "POST" })).json()) as Json;
  check(again.code === started.code && relay.machines(ada.acct).length === 0, "a second click is the same login, and nothing's linked before a yes");
  check(((await (await fetch(PAGE + "/api/first-run/status")).json()) as Json).state === "waiting", "the page waits for the yes");

  relay.approve(started.code);
  const home = path.join(ROOT, "accounts", ada.acct);
  const handed = await until(async () => {
    const s = await cliStatus();
    return s.pid && s.pid !== daemon.pid && s.page === PAGE ? s : null;
  }, 60e3);
  if (handed?.pid) pids.add(handed.pid);
  check(handed && fs.existsSync(path.join(home, "machine.json")), "once they say yes, the account's folder is made, and agentbook runs in it");
  check(JSON.parse(fs.readFileSync(path.join(ROOT, "accounts", "accounts.json"), "utf8")).default === ada.acct, "as the machine's default account");
  const me = await until(async () => {
    const r = await fetch(PAGE + "/api/auth/me");
    return r.ok ? ((await r.json()) as Json) : null;
  }, 30e3);
  check(me?.account === true && me.user === null, "at the same address, the page is the account's now");

  // Signing in there: the relay, and back.
  const jar = new Map<string, string>();
  const get = async (url: string) => {
    const r = await fetch(url, { redirect: "manual", headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      if (/Max-Age=0\b/.test(c)) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return r;
  };
  const toRelay = (await get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: PAGE })}`)).headers.get("location") || "";
  const back = (await get(toRelay)).headers.get("location") || "";
  const landed = (await get(back)).headers.get("location");
  const her = (await (await get(PAGE + "/api/auth/me")).json()) as Json;
  check(landed === "/" && her.user?.id === ada.acct, "and its person signs in, as the account");
  check(await until(async () => (await cliStatus()).connected), "and the machine logs in to its page");
  check(outside().length === 0 && nobody(), `outside the account's folder, the root keeps nothing (${outside().join(", ")})`);

  // What a session started outside agentbook runs (claude in a terminal: its hooks, its tools) has no AGENTBOOK_HOME.
  const homeOf = (mod: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(pathToFileURL(path.join(REPO, mod)).href)})).HOME)`], { env, encoding: "utf8" }).stdout.trim();
  const seen = ["plugin/lib/common.ts", "plugin/shared/store.ts"].map(homeOf);
  check(seen.every((h) => h === home), `a hook or a session's tools started with no AGENTBOOK_HOME use the account's folder too (${seen.join(", ")})`);
} finally {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await sleep(500);
  await relay.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
