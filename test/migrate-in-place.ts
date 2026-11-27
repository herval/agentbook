#!/usr/bin/env node
// A machine with agentbook's data from before accounts logs in (plugin/cli/relay-login.ts): nothing moves. The root becomes the account's folder, with machine.json at its top, and the page's
// person there the account's person, by their user id, so their threads stay theirs and they sign in as before, with
// Google. Hooks find it with no AGENTBOOK_HOME. Logging out deletes only what's agentbook's there: another app's
// folders (agentbook v2's node/ and dev/) stay.
// Run: node test/migrate-in-place.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeRelay } from "./fake-relay.ts";
import { poolPort, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { createAccounts } from "../server/accounts.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(REPO, "plugin", "cli", "main.mjs");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-in-place-")));
const PORT = testPort(7900);
const CLI = poolPort();
const PAGE = `http://127.0.0.1:${PORT}`;
const PEOPLE = "in-place-people";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => Promise<T>, ms = 30e3): Promise<T | null> => {
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
const bo = { sub: "google:2002", acct: "0193a000-0000-7000-8000-0000000000b0", email: "bo@example.com", name: "Bo" };
relay.person = ada;
const envOf = (more: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_ROOT: ROOT, AGENTBOOK_PORT: String(CLI), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_DSH: "0", AGENTBOOK_AGY: "0", AGENTBOOK_GROK: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_RELAY_URL: relay.url, AGENTBOOK_MACHINE: "oldbox", AGENTBOOK_RELOAD: "0", ...more };
  for (const k of ["AGENTBOOK_HOME", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "CLAUDE_JOB_DIR", ...(more.AGENTBOOK_TEST_PEOPLE ? [] : ["AGENTBOOK_TEST_PEOPLE"])]) delete env[k];
  return env;
};

// agentbook-cli's commands, as a person runs them. `answer`: what they do on the relay's page once it shows a code.
function cli(args: string[], answer: (code: string) => void = () => {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnTied(process.execPath, [MAIN, ...args], { env: envOf(), stdio: ["ignore", "pipe", "pipe"] });
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
    async signIn(): Promise<string> {
      const toRelay = (await get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: PAGE })}`)).headers.get("location") || "";
      if (!toRelay.startsWith(relay.url)) return toRelay;
      const back = (await get(toRelay)).headers.get("location") || "";
      return (await get(back)).headers.get("location") || "";
    },
  };
}
const pids = new Set<number>();
async function start(more: Record<string, string> = {}) {
  const p = spawnTied(process.execPath, [MAIN, "run", "--webui"], { env: envOf(more), stdio: "ignore", detached: true });
  pids.add(p.pid);
  await until(async () => (await fetch(PAGE + "/api/auth/me")).ok);
  return p.pid;
}
async function stop(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  await until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}
const at = (...p: string[]) => fs.existsSync(path.join(ROOT, ...p));

try {
  // ---------- the machine as it is today ----------
  const before = Storage.open(ROOT);
  const people = createAccounts(before);
  const herval = people.create({ username: "herval", display_name: "Herval", role: "admin" }).user;
  people.create({ username: "banana", role: "member" });
  before.close();
  // What else is in the folder: a note's folder and plugin copies (sessions work in them, by their paths), and
  // another app's folders.
  for (const [dir, file] of [["cli/notes/hello", "notes.md"], ["cli/plugin-copies/abc", "hooks.json"], ["node", "agentbook.db"], ["dev", "build.log"]]) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
    fs.writeFileSync(path.join(ROOT, dir, file), "x");
  }
  let pid = await start({ AGENTBOOK_TEST_PEOPLE: PEOPLE });
  const was = browser();
  check((await was.json("POST", "/api/auth/test-person", { username: "herval", test: PEOPLE })).status === 200, "a page from before accounts, with its person, herval, and a member, banana");
  const made = await was.json("POST", "/api/talks", { text: "Before accounts\nMade on the old page." });
  check(made.status === 200 && made.id, "herval has a thread there");
  await stop(pid);

  // ---------- agentbook login ----------
  const logged = await cli(["login", "--no-open", "--no-start"], (code) => relay.approve(code));
  const login = JSON.parse(fs.readFileSync(path.join(ROOT, "machine.json"), "utf8"));
  check(logged.status === 0 && /stays where it is/.test(logged.out) && /@herval/.test(logged.out), `agentbook login says the data stays, and who you are there (${logged.out.trim().split("\n").at(-1)})`);
  check(login.account === ada.acct && login.person === herval.id, "the root is the account's folder now: its login at the top, with herval's user id as the account's person");
  check(JSON.parse(fs.readFileSync(path.join(ROOT, "accounts", "accounts.json"), "utf8")).default === ada.acct && !at("accounts", ada.acct), "it's the machine's default account, with no folder of its own under accounts/");
  check(at("storage.db") && at("cli", "notes", "hello", "notes.md") && at("cli", "plugin-copies", "abc", "hooks.json") && at("node") && at("dev"), "nothing moved");
  const homeOf = (mod: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(pathToFileURL(path.join(REPO, mod)).href)})).HOME)`], { env: envOf(), encoding: "utf8" }).stdout.trim();
  check(homeOf("plugin/lib/common.ts") === ROOT && homeOf("plugin/shared/store.ts") === ROOT, "hooks and a session's tools with no AGENTBOOK_HOME use the root, as agentbook-cli does");

  // ---------- the page, the account's ----------
  pid = await start();
  const me = (await (await fetch(PAGE + "/api/auth/me")).json()) as Json;
  check(me.account === true && me.user === null, "agentbook starts on it as the account's page");
  const her = browser();
  const landed = await her.signIn();
  const who = (await her.json("GET", "/api/auth/me")).user;
  check(landed === "/" && who?.id === herval.id && who.username === "herval", "herval signs in with Google, as the same person");
  const thread = await her.json("GET", `/api/q/thread/${made.id}?n=10`);
  check(thread.records?.[`thread:${made.id}`]?.title === "Before accounts" && thread.records[`thread:${made.id}`].mine, "and his thread is still his");
  check((await her.json("GET", "/api/people")).people?.length === 2, "nobody was made; banana is still a person on the page");
  relay.person = bo;
  check((await browser().signIn()) === "/?signin=other-account", "another Google account doesn't sign in");
  relay.person = ada;
  await stop(pid);
  const again = await cli(["login", "--no-open", "--no-start"]);
  check(/Already signed in/.test(again.out), "logging in again renews its certificate");

  // ---------- logout ----------
  const out = await cli(["logout", "--yes"]);
  check(out.status === 0 && /deletes everything agentbook keeps for you on it: in /.test(out.out) && /stays \(.*dev.*node/.test(out.out), `logging out says what goes and what stays (${out.out.trim().split("\n")[0].slice(0, 200)})`);
  check(!at("machine.json") && !at("storage.db") && !at("cli") && at("node", "agentbook.db") && at("dev", "build.log"), "it deletes agentbook's data in the root, and leaves another app's folders");
  check(JSON.parse(fs.readFileSync(path.join(ROOT, "accounts", "accounts.json"), "utf8")).default === null && !!relay.machines(ada.acct)[0]?.revoked, "with no default account left, and the machine off the account on the relay");
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
