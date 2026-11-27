#!/usr/bin/env node
// agentbook-cli going on through what used to stop it. Nothing restarts it until the next session's hook, so an error
// in a timer or a promise nobody caught is logged whole and left there, and only what it can't work without ends it. A
// full disk fails on every tick, and is logged once.
// Run: node test/crashes.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync, sql } from "./harness-sql.ts";
import { createStore } from "../plugin/shared/store.ts";
import { type Command, type Uplink, createUplink } from "../plugin/cli/uplink.ts";
import type { opTo } from "../plugin/shared/protocol.ts";
import { freePort, spawnTied } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-crashes-")));
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => unknown, ms = 8000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
};
const refuse = (db: DatabaseSync, name: string, table: string, on = "insert") => db.exec(`create trigger ${name} before ${on} on ${table} begin select raise(abort, 'database or disk is full'); end;`);

// ---------- the uplink, on a disk that's full ----------
{
  const store = createStore({ file: path.join(BASE, "up", "agentbook.db"), filesDir: path.join(BASE, "up", "files"), legacy: false, acks: true });
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  const lines: string[] = [];
  // What the uplink pushes (here, ops), and what it answers to commands.
  const pushes: { ops: ReturnType<typeof opTo>[] }[] = [];
  const results: { cid: string; r: { done?: boolean } }[] = [];
  let list: Command[] = [];
  const transport = { name: "srv", hello: async () => ({ cursor: 0, empty: false }), push: async (b: { ops: ReturnType<typeof opTo>[] }) => (pushes.push(b), { acked: b.ops.at(-1)?.seq ?? 0 }), commands: async () => (await sleep(20), list.splice(0)), result: async (cid: string, r: { done?: boolean }) => void results.push({ cid, r }) };
  // Its table of commands done, made by the first uplink, then not to be pruned or written.
  createUplink({ store, transport, onCommand: async () => ({}), epoch: "e" });
  refuse(sql(store.file), "no_prune", "commands_done", "delete");
  let up: Uplink;
  try {
    up = createUplink({ store, transport, onCommand: async () => ({ done: true }), epoch: "e", log: (l) => lines.push(l), retryMs: 0 });
    check(true, "an uplink starts on a full disk, as tidying waits");
  } catch (e) {
    check(false, `an uplink starts on a full disk, as tidying waits (${e.message})`);
  }
  refuse(sql(store.file), "no_meta", "meta");
  store.commit({ t: "message.add", post: "s1", from: "agent", text: "written before it filled" });
  await up.push();
  await up.push();
  const sent = pushes.flatMap((p) => p.ops).filter((o) => o.args.text);
  check(sent.length === 1 && up.status().connected && up.status().waiting === 0, "what's already written still goes up when how far it got can't be saved");
  check(lines.filter((l) => /couldn't save how far/.test(l)).length === 1, "and that's said once");
  refuse(sql(store.file), "no_done", "commands_done");
  list = [{ cid: "c1", kind: "post.deliver", args: {} }];
  up.start();
  check(await until(() => results.length), "a command that can't be remembered is still answered");
  check(results[0]?.r?.done === true, "with its answer");
  sql(store.file).exec("drop trigger no_done; drop trigger no_meta; drop trigger no_prune;");
}

// ---------- the daemon ----------
const PORT = await freePort(6580, 20);
const taken = net.createServer().listen(0, "127.0.0.1");
await new Promise((r) => taken.once("listening", r));
const HOME = path.join(BASE, "person", ".agentbook");
const LOG = path.join(BASE, "cli.log");
const SIGNS = path.join(BASE, "signs");
fs.mkdirSync(SIGNS);
fs.mkdirSync(path.join(BASE, "claude"), { recursive: true });
const sign = (name: string) => fs.writeFileSync(path.join(SIGNS, name), "");
// What goes wrong in it: timers of its own, in the daemon's process, each started by a file this test writes.
const PRELOAD = path.join(BASE, "goes-wrong.mjs");
fs.writeFileSync(PRELOAD, `import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const signs = ${JSON.stringify(SIGNS)};
const has = (name) => fs.existsSync(path.join(signs, name));
const done = new Set();
const once = (name, fn) => {
  if (done.has(name) || !has(name)) return;
  done.add(name);
  fn();
};
setInterval(() => {
  once("throw", () => {
    throw new TypeError("a stray error in a timer");
  });
  once("reject", () => void Promise.reject(new RangeError("a rejection nobody caught")));
  once("reject-plain", () => void Promise.reject("not even an Error"));
  once("listen", () => net.createServer().listen(${(taken.address() as net.AddressInfo).port}, "127.0.0.1"));
}, 20).unref();
setInterval(() => {
  if (has("full") && !has("room")) throw Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR" });
}, 20).unref();
`);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(BASE, "person"), AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_START_UNLINKED: "1", AGENTBOOK_CHECKPOINT_MS: "60", AGENTBOOK_CODEX: "0", AGENTBOOK_CODEX_MCP: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE_ROUTINES: "0", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
const out = fs.openSync(LOG, "a");
const cli = spawnTied(process.execPath, ["--import", pathToFileURL(PRELOAD).href, path.join(ROOT, "cli", "main.mjs"), "run"], { env, stdio: ["ignore", out, out] });
let ended: { code: number | null; signal: NodeJS.Signals | null } | null = null;
cli.on("exit", (code, signal) => (ended = { code, signal }));
const URL_ = `http://127.0.0.1:${PORT}`;
const log = () => fs.readFileSync(LOG, "utf8");
const lines = (re: RegExp) => log().split("\n").filter((l) => re.test(l));
const status = () => fetch(`${URL_}/api/status`, { signal: AbortSignal.timeout(2000) }).then((r): Promise<Json> => r.json(), () => null);
const said = () => spawnSync(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "status"], { env, encoding: "utf8", timeout: 20000 }).stdout;
const hello = (proc: string, more = {}) => fetch(`${URL_}/api/hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proc, agent: "Claude", label: "wren", cwd: BASE, ...more }) });

try {
  check(await until(status, 15e3), "(it starts)");

  sign("throw");
  check(await until(() => lines(/a stray error in a timer/).length), "an error in a timer goes to its log");
  check(/goes-wrong\.mjs:\d+/.test(log()), "with its whole stack");
  check(!!(await status()) && !ended, "and it's still up");

  sign("reject");
  check(await until(() => lines(/a rejection nobody caught/).length) && /RangeError/.test(log()), "so does a rejection nobody caught");
  sign("reject-plain");
  check(await until(() => lines(/not even an Error/).length), "even one that isn't an Error");
  check(!!(await status()) && !ended, "and it's still up");
  const st = await status();
  check(st?.fault?.count >= 1 && st.fault.at, "status has the last of them");
  check(/It kept going after an error/.test(said()) && said().includes(path.join(HOME, "cli", "cli.log")), "and says where to read about it");

  // A timer that fails on every tick.
  sign("full");
  await sleep(700);
  const counted = (await status())?.fault?.count || 0;
  check(lines(/disk is full/).length === 1, `a full disk in a timer is logged once (${lines(/disk is full/).length} lines, ${counted} ticks)`);
  check(counted >= 5 && !ended, "through every tick, and it's still up");
  sign("room");

  // The store's own timer, with a real write refused.
  check((await hello("p1", { session_id: "s1" })).ok, "(a thread)");
  const db = new DatabaseSync(path.join(HOME, "storage.db"));
  db.exec("pragma busy_timeout = 5000"); // it writes every 60 ms here
  refuse(db, "no_meta", "meta");
  await hello("p2", { session_id: "s2" });
  check(await until(async () => (await status())?.save_failing), "a checkpoint that can't be written shows in status");
  await sleep(400);
  check(lines(/checkpoint failed/).length === 1, `and in the log once, at 60 ms a tick (${lines(/checkpoint failed/).length})`);
  check(/It can't save to its database: database or disk is full/.test(said()), "status says it can't save");
  db.exec("drop trigger no_meta");
  check(await until(async () => !(await status())?.save_failing), "room again, and that's over");
  check(lines(/checkpoints work again/).length === 1, "which the log says too");

  // A command in a route, with its write refused, fails as a route does.
  refuse(db, "no_events", "events");
  const refused = await hello("p3", { session_id: "s3" });
  check(refused.status >= 400 && !!(await status()), "a request the disk refuses fails alone");
  db.exec("drop trigger no_events");
  db.close();

  // What it can't work without.
  sign("listen");
  check(await until(() => ended, 8000), "a failed listen ends it");
  check(ended?.code === 1, `with an error (${JSON.stringify(ended)})`);
  check(lines(/stopping, as it can't go on without this/).length === 1 && /EADDRINUSE/.test(log()), "and says why in its log");
} catch (e) {
  check(false, `crashed: ${e.stack}`);
}
cli.kill("SIGKILL");
taken.close();
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
