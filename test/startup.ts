#!/usr/bin/env node
// What stands between a machine and agentbook-cli starting, each with a clear word rather than a stack or nothing: no
// Node, a Node too old, a database that can't be read, and a daemon that won't start. A corrupt database is moved aside
// whole, but only on SQLite's own word for it. Every database here is a temp file.
// Run: node test/startup.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCorrupt } from "../plugin/shared/storage.ts";
import { closeSql, DatabaseSync, sql } from "./harness-sql.ts";
import { createStore } from "../plugin/shared/store.ts";
import { createUplink, epochOf } from "../plugin/cli/uplink.ts";
import { nodeTooOld } from "../plugin/lib/common.ts";
import { createRelay } from "../server/relay.ts";
import { createWork } from "../server/work.ts";
import { freePort, spawnTied } from "./harness.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-startup-")));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 15e3) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
};
const place = (name) => {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  return { file: path.join(dir, "agentbook.db"), filesDir: path.join(dir, "files"), legacy: false, acks: true };
};
const asides = (o) => fs.readdirSync(path.dirname(o.file)).filter((n) => n.includes(".corrupt-")).sort();
const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
// What createStore throws on it, as another process: one that fails there stops, and a connection left open in this one
// could be closed at any time, which deletes the -wal beside a file SQLite can't read. -> { errcode, message, corrupt } or null.
const opening = (o) => {
  const code = `import { isCorrupt } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "shared", "storage.ts")).href)};
import { createStore } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "shared", "store.ts")).href)};
let out = null;
try {
  createStore(${JSON.stringify(o)}).close();
} catch (e) {
  out = { errcode: e.errcode, message: e.message, corrupt: isCorrupt(e) };
}
console.log(JSON.stringify(out));
process.exit(0);`;
  return JSON.parse(spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 }).stdout);
};
const quietly = (fn) => {
  const { error, log } = console;
  const said = [];
  console.error = console.log = (...a) => said.push(a.join(" "));
  try {
    return [fn(), said];
  } finally {
    Object.assign(console, { error, log });
  }
};

// ---------- which errors count ----------
{
  const sqlite = (errcode) => Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode });
  check(isCorrupt(sqlite(11)) && isCorrupt(sqlite(26)) && isCorrupt(sqlite(267)) && isCorrupt(sqlite(523)), "corrupt and not-a-database count, extended codes too");
  check(![5, 6, 8, 10, 13, 14, 261, 517].some((c) => isCorrupt(sqlite(c))), "busy, locked, read-only, I/O, full and can't-open don't");
  check(!isCorrupt(new Error("database disk image is malformed")) && !isCorrupt(Object.assign(new Error("x"), { errcode: 11 })) && !isCorrupt(null), "nor anything but SQLite's own error");
  check(fs.readFileSync(path.join(ROOT, "cli", "daemon.ts"), "utf8").includes("moveCorrupt: true") && !fs.readdirSync(path.join(REPO, "server")).filter((f) => f.endsWith(".ts")).some((f) => fs.readFileSync(path.join(REPO, "server", f), "utf8").includes("moveCorrupt")), "only the daemon asks for it, never the server");
}

// ---------- a file that isn't a database ----------
{
  const o = place("garbage");
  // SQLite remakes the -shm from the -wal whenever it opens one, so that one's only ever there, not the same bytes.
  const bytes = { "": "this isn't a database. ".repeat(4000), "-wal": "the end of a write-ahead log" };
  Object.entries(bytes).forEach(([s, b]) => fs.writeFileSync(o.file + s, b));
  fs.writeFileSync(`${o.file}-shm`, "shared memory");
  const e = opening(o);
  check(e?.corrupt, `without moveCorrupt, it gets SQLite's error (${e?.message})`);
  check(!asides(o).length && fs.existsSync(`${o.file}-shm`) && Object.entries(bytes).every(([s, b]) => fs.readFileSync(o.file + s, "utf8") === b), "and nothing moves, its -wal included");

  const [store, said] = quietly(() => createStore({ ...o, moveCorrupt: true }));
  const [kept] = asides(o);
  const copy = path.join(path.dirname(o.file), kept);
  check(fs.readFileSync(copy, "utf8") === bytes[""], "moved aside, every byte");
  check(fs.readFileSync(`${copy}-wal`, "utf8") === bytes["-wal"] && fs.existsSync(`${copy}-shm`), "its -wal and -shm with it, named so SQLite finds them");
  check(said.length === 1 && said[0].includes(copy) && /not a database/.test(said[0]), "and the log says where and why, once");
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  store.checkpoint(true);
  store.close();
  const again = createStore({ ...o, moveCorrupt: true });
  check(again.state.sessions.s1 && asides(o).length === 3, "a new one works, and stays");
  again.close();

  const short = place("short");
  fs.writeFileSync(short.file, "not a database, and under a page");
  const [s2] = quietly(() => createStore({ ...short, moveCorrupt: true }));
  check(asides(short).length >= 1 && fs.readFileSync(path.join(BASE, "short", asides(short)[0]), "utf8").startsWith("not a database"), "one too short to be a database too");
  s2.close();
}

// ---------- a real database with damaged pages, and a real -wal ----------
{
  const live = place("live");
  const store = createStore(live);
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  for (let i = 0; i < 400; i++) store.commit({ t: "message.add", post: "s1", from: "agent", text: `message ${i} `.repeat(40) });
  store.checkpoint(true);
  // A connection of the test's own, that never folds its -wal in: the row stays only there.
  sql(live.file).exec("pragma wal_checkpoint(truncate); pragma wal_autocheckpoint = 0");
  sql(live.file).exec("insert into meta (scope, key, value) values ('cli', 'only-in-wal', 'yes')");
  // As a crash leaves it: copied with the writer still open.
  const o = place("damaged");
  for (const s of ["", "-wal", "-shm"]) fs.copyFileSync(live.file + s, o.file + s);
  store.close();
  closeSql(live.file);
  const original = path.join(BASE, "damaged", "original-wal");
  fs.copyFileSync(`${o.file}-wal`, original);
  check(fs.statSync(`${o.file}-wal`).size > 0, "(it has a real -wal)");
  // The back half, where the messages are, and not the schema at the front.
  const size = fs.statSync(o.file).size;
  const fd = fs.openSync(o.file, "r+");
  fs.writeSync(fd, Buffer.alloc(Math.floor(size / 2), 0xab), 0, Math.floor(size / 2), size - Math.floor(size / 2));
  fs.closeSync(fd);

  const e = opening(o);
  check(e?.corrupt, `without moveCorrupt, damaged pages are SQLite's error at opening too (${e?.message})`);
  check(same(`${o.file}-wal`, original), "and its -wal stays");
  const [fresh, said] = quietly(() => createStore({ ...o, moveCorrupt: true }));
  check(said.length === 1 && Object.keys(fresh.state.sessions).length === 0 && !fresh.state.messages.length, "moved, and it starts with nothing of the old one in memory");
  const copy = path.join(path.dirname(o.file), asides(o).find((n) => !/-(wal|shm)$/.test(n)));
  check(same(`${copy}-wal`, original), "its -wal kept as it was, though closing SQLite would have folded it in");
  const old = new DatabaseSync(copy, { readOnly: true });
  check(old.prepare("select value from meta where key = 'only-in-wal'").get()?.value === "yes", "and the copy opens with it: what was written last can be read");
  old.close();
  fresh.commit({ t: "session.hello", proc: "p1", session_id: "s2", agent: "claude", label: "wren", kind: "claude-code" });
  fresh.close();
}

// ---------- tables that read fine, and a log after them that doesn't ----------
{
  const o = place("damaged-log");
  const store = createStore(o);
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  store.commit({ t: "message.add", post: "s1", from: "agent", text: "checkpointed" });
  store.checkpoint(true);
  const at = store.state.seq;
  store.close();
  // Ops past the checkpoint: the last thing written, so at the end of the file.
  const raw = new DatabaseSync(o.file);
  const add = raw.prepare("insert into events (scope, seq, at, op) values ('cli', ?, ?, ?)");
  for (let i = 1; i <= 300; i++) add.run(at + i, new Date().toISOString(), JSON.stringify({ seq: at + i, t: "message.add", post: "s1", from: "agent", text: `after ${i} `.repeat(60) }));
  raw.exec("pragma wal_checkpoint(truncate)");
  raw.close();
  const size = fs.statSync(o.file).size;
  const fd = fs.openSync(o.file, "r+");
  fs.writeSync(fd, Buffer.alloc(16384, 0xab), 0, 16384, size - 16384);
  fs.closeSync(fd);
  const [fresh] = quietly(() => createStore({ ...o, moveCorrupt: true }));
  check(asides(o).length >= 1, "damage in the log after the checkpoint counts too");
  check(!Object.keys(fresh.state.sessions).length && !fresh.state.messages.length && fresh.state.seq === 0, "and nothing read before it found that stays");
  fresh.close();
}

// ---------- never for what's only locked, out of reach, or fine ----------
{
  const o = place("locked");
  const holder = new DatabaseSync(o.file);
  holder.exec("pragma journal_mode = delete; create table t (x); insert into t values (1); begin exclusive; insert into t values (2)");
  const e = opening({ ...o, moveCorrupt: true });
  check(e && !e.corrupt && (e.errcode & 0xff) === 5, `a locked database stops the store (${e?.message})`);
  check(!asides(o).length && fs.existsSync(o.file), "and isn't moved");
  holder.exec("rollback");
  check(holder.prepare("select count(*) n from t").get().n === 1, "and is as it was");
  holder.close();

  const dir = place("a-folder");
  fs.mkdirSync(dir.file);
  const e2 = opening({ ...dir, moveCorrupt: true });
  check(e2 && !e2.corrupt && !asides(dir).length && fs.statSync(dir.file).isDirectory(), `nor one that can't be opened at all (${e2?.message})`);

  const fine = place("fine");
  const a = createStore({ ...fine, moveCorrupt: true });
  a.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  a.checkpoint(true);
  a.close();
  const b = createStore({ ...fine, moveCorrupt: true });
  check(b.state.sessions.s1 && !asides(fine).length, "and a healthy one is left alone");
  b.close();
}

// ---------- its server, after a new database ----------
{
  const accounts = { byId: (id) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
  const relay = createRelay({ home: path.join(BASE, "server"), accounts, work: createWork() });
  const D = relay.device("d1", { name: "laptop", user_id: "u1" });
  const transport = { name: "srv", hello: async (b) => relay.hello(D, b), push: async (b) => relay.ingest(D, structuredClone(b)), commands: () => new Promise(() => {}), result: async () => ({}) };
  const o = place("uplinked");
  const first = createStore(o);
  const up1 = createUplink({ store: first, transport, onCommand: async () => ({}), epoch: epochOf(first), retryMs: 0 });
  first.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  first.commit({ t: "message.add", post: "s1", from: "agent", text: "before" });
  await up1.push();
  await up1.push();
  const had = D.cursor;
  first.close();
  fs.writeFileSync(o.file, "not any more ".repeat(1000));
  fs.rmSync(`${o.file}-wal`, { force: true });
  fs.rmSync(`${o.file}-shm`, { force: true });
  const [second] = quietly(() => createStore({ ...o, moveCorrupt: true }));
  const up2 = createUplink({ store: second, transport, onCommand: async () => ({}), epoch: epochOf(second), retryMs: 0 });
  await up2.push();
  check(D.store.state.messages.some((m) => m.text === "before") && D.cursor === had, "a new database takes nothing back from its server");
  second.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  second.commit({ t: "message.add", post: "s1", from: "agent", text: "after" });
  await up2.push();
  await up2.push();
  const texts = D.store.state.messages.filter((m) => m.post === "s1").map((m) => m.text);
  check(texts.includes("before") && texts.includes("after") && !up2.status().waiting, `and what it does next goes up after it (${texts})`);
}

// ---------- Node ----------
check(["20.11.0", "22.12.0", "22.17.1", "22.5.1", "23.5.0", "18.20.4"].every((v) => nodeTooOld(v)) && !["22.18.0", "22.22.3", "23.6.0", "24.1.0", "25.0.0"].some((v) => nodeTooOld(v)), "which versions are too old");

const PORT = await freePort(6600, 20);
const person = path.join(BASE, "person");
const envFor = (home, port = PORT) => {
  const env = { ...process.env, HOME: person, AGENTBOOK_HOME: home, AGENTBOOK_PORT: String(port), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_START_UNLINKED: "1", AGENTBOOK_CODEX: "0", AGENTBOOK_CODEX_MCP: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE_ROUTINES: "0", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_PLUGIN_ROOT: ROOT, AGENTBOOK_PID: "930001" };
  for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_SERVER_HOME", "CLAUDE_JOB_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE"]) delete env[k];
  return env;
};
fs.mkdirSync(path.join(BASE, "claude"), { recursive: true });
fs.mkdirSync(person, { recursive: true });
const run = (args, env, opts = {}) => spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 25000, ...opts });
const main = path.join(ROOT, "cli", "main.mjs");
const hookFile = path.join(ROOT, "hooks", "hook.ts");
const input = JSON.stringify({ session_id: "s-1", cwd: BASE, source: "startup" });

// A Node too old, as far as the code can tell.
const OLD = path.join(BASE, "old-node.mjs");
fs.writeFileSync(OLD, `Object.defineProperty(process.versions, "node", { value: "20.11.0" });\n`);
const old = ["--import", pathToFileURL(OLD).href];
{
  const home = path.join(BASE, "old-home");
  const r = run([...old, main, "run"], envFor(home));
  check(r.status === 1 && /needs Node 22\.18 or newer, and this is v20\.11\.0/.test(r.stderr) && !/\n\s+at /.test(r.stderr), `the daemon says what it needs, with no stack (${r.status})`);
  check(!fs.existsSync(path.join(home, "cli")), "and touches no data");
  const c = run([...old, main, "status"], envFor(home));
  check(c.status === 1 && /needs Node 22\.18/.test(c.stderr), "so does a command");
  const h = run([...old, hookFile, "SessionStart"], envFor(home), { input });
  const said = (() => {
    try {
      return JSON.parse(h.stdout).hookSpecificOutput;
    } catch {
      return null;
    }
  })();
  check(h.status === 0 && said?.hookEventName === "SessionStart" && /needs Node 22\.18 or newer, and this is v20\.11\.0/.test(said.additionalContext), "a session is told, and goes on");
}

// bin/agentbook-cli, before any of its Node runs. `dirname` is all it needs from PATH.
{
  const fake = path.join(BASE, "no-node");
  fs.mkdirSync(fake);
  const dirname = ["/usr/bin/dirname", "/bin/dirname"].find((f) => fs.existsSync(f));
  fs.symlinkSync(dirname, path.join(fake, "dirname"));
  const bin = path.join(REPO, "bin", "agentbook-cli");
  const sh = (env?: Record<string, string>) => spawnSync("/bin/sh", [bin, "status"], { env: { ...envFor(path.join(BASE, "sh-home")), PATH: fake, ...env }, encoding: "utf8", timeout: 10000 });
  const none = sh();
  check(none.status === 1 && /needs Node 22\.18 or newer, and there's no node on this PATH/.test(none.stderr), "with no node at all, bin/agentbook-cli says so");
  const faked = path.join(BASE, "fake-node");
  fs.mkdirSync(faked);
  fs.symlinkSync(dirname, path.join(faked, "dirname"));
  fs.writeFileSync(path.join(faked, "node"), `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "$FAKE_NODE"; else echo ran; fi\n`, { mode: 0o755 });
  const on = (v) => sh({ PATH: faked, FAKE_NODE: v });
  for (const v of ["v8.17.0", "v18.20.4", "v20.11.0", "v21.7.3", "v22.5.1", "v22.12.0", "v22.17.1", "v23.3.0", "v23.5.0"]) {
    const r = on(v);
    check(r.status === 1 && r.stderr.includes(`and this is ${v}`) && r.stdout !== "ran\n", `${v} is refused there`);
  }
  for (const v of ["v22.18.0", "v22.22.3", "v23.6.0", "v24.1.0", "v30.0.0"]) check(on(v).stdout === "ran\n", `${v} runs`);
}

// hooks.json's command, as a shell runs it.
{
  const command = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command;
  const home = path.join(BASE, "bad-home");
  const shell = (PATH) => spawnSync("/bin/sh", ["-c", command], { env: { ...envFor(home), PATH }, input, encoding: "utf8", timeout: 25000 });
  const none = shell(path.join(BASE, "no-node"));
  const said = JSON.parse(none.stdout).hookSpecificOutput;
  check(none.status === 0 && said.hookEventName === "SessionStart" && /needs Node 22\.18 or newer/.test(said.additionalContext), "with no node, a session is told by its hook's own shell");

  // A daemon that can't start: its database is a folder.
  fs.mkdirSync(path.join(home, "cli", "agentbook.db"), { recursive: true });
  const log = path.join(home, "cli", "cli.log");
  const h = shell(`${path.dirname(process.execPath)}:${process.env.PATH}`);
  const down = JSON.parse(h.stdout || "{}").hookSpecificOutput;
  check(h.status === 0 && down?.additionalContext?.includes(log), `a daemon that can't start: its session hears where the log is (${down?.additionalContext?.slice(0, 80)})`);
  check(/isn't a thread/.test(down?.additionalContext || ""), "and that it isn't a thread");
  check(/ERR_SQLITE_ERROR|unable to open/.test(fs.readFileSync(log, "utf8")) && /\n\s+at /.test(fs.readFileSync(log, "utf8")), "the log has the whole stack");
  check(fs.statSync(path.join(home, "cli", "agentbook.db")).isDirectory(), "and nothing was moved");
}

// ---------- the daemon, on a corrupt database ----------
{
  const home = path.join(BASE, "corrupt-home");
  const cliHome = path.join(home, "cli");
  fs.mkdirSync(cliHome, { recursive: true });
  const db = path.join(cliHome, "agentbook.db");
  fs.writeFileSync(db, "this isn't a database. ".repeat(4000));
  fs.writeFileSync(`${db}-wal`, "a log");
  fs.writeFileSync(`${db}-shm`, "memory");
  const env = envFor(home);
  const log = path.join(BASE, "corrupt.log");
  const out = fs.openSync(log, "a");
  const start = () => spawnTied(process.execPath, [main, "run"], { env, stdio: ["ignore", out, out] });
  const health = () => fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  const copies = () => fs.readdirSync(cliHome).filter((n) => n.includes(".corrupt-"));
  const stop = async (cli) => {
    cli.kill("SIGTERM");
    await until(async () => !(await health()));
  };
  const status = () => run([main, "status"], env).stdout;
  const cli = start();
  try {
    check(await until(health), "it starts anyway");
    check(copies().length === 3, `with the old one aside, whole (${copies()})`);
    check(/can't read .*file is not a database.*moved to/.test(fs.readFileSync(log, "utf8")), "its log says so");
    const said = status();
    const copy = path.join(cliHome, copies().find((n) => !/-(wal|shm)$/.test(n)));
    check(said.includes("couldn't be read") && said.includes(copy) && /is running/.test(said), "status says so, and where it is");
    await stop(cli);
    const down = status();
    check(/isn't running/.test(down) && down.includes(copy), "and says so while it's stopped too");
    const next = start();
    check(await until(health), "it starts again");
    check(copies().length === 3 && (fs.readFileSync(log, "utf8").match(/can't read /g) || []).length === 1, "with no second move");
    await stop(next);
    for (const n of copies()) fs.rmSync(path.join(cliHome, n));
    check(!status().includes("couldn't be read"), "and status stops saying so once the copy's deleted");
  } finally {
    cli.kill("SIGKILL");
  }
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
