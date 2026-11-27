#!/usr/bin/env node
// Moving in: a data folder as agentbook left it when it was one process (one
// database with everything: accounts, posts, tasks, pages) is imported into an agentbook-server, and the machine's
// agentbook-cli, logged in by the import, brings its posts over the first time it connects: the same ids, its
// files, and the work of its recent posts from their transcripts. The folder itself isn't changed, and importing
// again adds nothing twice.
// Run: node test/migrate.ts

import { type ChildProcess, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccounts } from "../server/accounts.ts";
import { createStore } from "../plugin/shared/store.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { writeBefore } from "./harness-before.ts";
import { closeSql, sql } from "./harness-sql.ts";
import { stateOf } from "./harness-state.ts";
import { spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST, "..");
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-migrate-")));
const SERVER_PORT = testPort(5900);
const CLI_PORT = SERVER_PORT + 100;
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

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

// ---------- the folder, as one-process agentbook left it ----------
// The tests' way to sign someone in (server/api/test-people.ts): agentbook-server takes it from AGENTBOOK_TEST_PEOPLE.
const PEOPLE = "migrate-people";
const signIn = (base: string) => fetch(`${base}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval", test: PEOPLE }) });
const at = new Date(Date.now() - 3600e3).toISOString();
const transcript = path.join(HOME, "s1.jsonl");
fs.writeFileSync(
  transcript,
  [
    { type: "user", timestamp: at, message: { content: "Fix the importer" } },
    { type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run the tests" } }] } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "text", text: "The importer reads the old format now." }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
let ids;
{
  fs.mkdirSync(path.join(HOME, "files"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "files", "f1-report.txt"), "the report");
  fs.writeFileSync(path.join(HOME, "connectors.json"), JSON.stringify({ connectors: [] }), { mode: 0o600 });
  // Written with today's code into a storage of its own, then kept as that one database was (harness-before.ts).
  const making = Storage.at(path.join(HOME, "..", `${path.basename(HOME)}-making`, "storage.db"));
  const old = createStore({ storage: making, scope: "cli", filesDir: path.join(HOME, "files"), legacy: false });
  const accounts = createAccounts(making);
  const herval = accounts.create({ username: "herval", role: "admin" }).user;
  const alice = accounts.create({ username: "alice" }).user;
  old.commit({ t: "session.hello", proc: "box-1", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "wren", session_id: "s1", cwd: project, root: project, transcript });
  old.commit({ t: "session.post", post: "s1", title: "Fix the importer", text: "It chokes on old files." });
  old.commit({ t: "message.add", post: "s1", from: "human", via: "terminal", text: "Fix the importer" });
  old.commit({ t: "file.add", fid: "f1", post: "s1", from: "agent", name: "report.txt", size: 10, stored: "f1-report.txt" });
  old.commit({ t: "session.hello", proc: "box-2", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "kite", session_id: "s2", cwd: project, root: project });
  old.commit({ t: "session.post", post: "s2", title: "Write the release notes" });
  old.commit({ t: "workspace.add", wid: "w1", name: "app", owner: herval.id, folders: [{ machine: "laptop", path: project }] });
  old.commit({ t: "task.add", tid: "t1", owner: herval.id, text: "Review the importer", workspace: "w1", posts: [{ post: "s1", at, by: "agent" }] });
  old.commit({ t: "task.add", tid: "t2", owner: alice.id, text: "Alice's own" });
  old.commit({ t: "page.create", pid: "status", title: "Status", by: { user: "herval" }, owner: herval.id, contributors: [], widgets: [{ id: "n", type: "note", title: "Notes", width: "full", stack: null, data: { text: "All quiet." } }], hand: true });
  old.commit({ t: "page.write", pid: "status", by: { agent: "claude", post: "s1" }, widgets: [{ id: "n", type: "note", title: "Notes", width: "full", stack: null, data: { text: "The importer is fixed." } }], summary: "Said the importer is fixed" });
  // A group, with a thread in it and a file in its folder (kept by its sha256 in the files folder too).
  const plan = Buffer.from("# Plan\nShip it.\n");
  const planSha = crypto.createHash("sha256").update(plan).digest("hex");
  fs.mkdirSync(path.join(HOME, "files", "groups", "ship"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "files", "groups", "ship", planSha), plan);
  fs.mkdirSync(path.join(HOME, "groups", "ship"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "groups", "ship", "plan.md"), plan);
  old.commit({ t: "group.create", gid: "ship", name: "Ship it", brief: "Ship by Friday.", by: { user: "herval" }, members: [{ agent: "claude" }] });
  old.commit({ t: "group.post", gid: "ship", post: "s1", by: { user: "herval" } });
  old.commit({ t: "group.file", gid: "ship", path: "plan.md", v: 1, by: { agent: "claude", post: "s1" }, size: plan.length, sha: planSha });
  // It last ran as "laptop" (its host has another name now).
  sql(making.file).prepare("insert into meta (scope, key, value) values ('cli', 'machine', 'laptop') on conflict (scope, key) do update set value = excluded.value").run();
  accounts.pin(herval.id, "s1", true);
  old.checkpoint(true);
  // And one more after its last checkpoint: only in its log.
  old.commit({ t: "message.add", post: "s1", from: "agent", via: "dash", text: "Done: the importer reads old files." });
  ids = { herval: herval.id, alice: alice.id };
  writeBefore(making, "cli", path.join(HOME, "agentbook.db"), { globals: "all" });
  old.close();
  closeSql(making.file);
  fs.rmSync(path.dirname(making.file), { recursive: true, force: true });
}
const sums = () => Object.fromEntries(["agentbook.db", "files/f1-report.txt"].map((f) => [f, crypto.createHash("sha1").update(fs.readFileSync(path.join(HOME, f))).digest("hex")]));
const before = sums();

// ---------- the import ----------
// Its own address, as bin/agentbook-server reads .env at the top of this folder, and one set there is a real server's.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTBOOK_HOME: HOME, AGENTBOOK_SERVER_HOME: path.join(HOME, "server"), AGENTBOOK_SERVER_URL: SERVER, AGENTBOOK_SERVER_PORT: String(SERVER_PORT), AGENTBOOK_PORT: String(CLI_PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "dev") , AGENTBOOK_TEST_PEOPLE: PEOPLE };
const importOnce = () => spawnSync(path.join(REPO, "bin", "agentbook-server"), ["import", HOME, "--server", SERVER], { env: { ...env, AGENTBOOK_MACHINE: "renamed-mac" }, encoding: "utf8" });
// Into a server that made its own @herval first: refused, before anything is written.
{
  const clashEnv = { ...env, AGENTBOOK_SERVER_HOME: path.join(HOME, "clash") };
  const clashing = Storage.open(clashEnv.AGENTBOOK_SERVER_HOME);
  createAccounts(clashing).create({ username: "herval", role: "admin" });
  clashing.close();
  const clash = spawnSync(path.join(REPO, "bin", "agentbook-server"), ["import", HOME, "--server", SERVER], { env: clashEnv, encoding: "utf8" });
  const written = sql(path.join(HOME, "clash", "storage.db")).prepare("select count(*) n from users").get().n;
  closeSql(path.join(HOME, "clash", "storage.db"));
  check(clash.status !== 0 && /already has @herval/.test(clash.stderr + clash.stdout) && written === 1 && !fs.existsSync(path.join(HOME, "cli", "device.json")), `a server that made its own @herval refuses the folder's, before writing anything (${(clash.stderr || clash.stdout).trim().split("\n")[0].slice(0, 120)})`);
}
const first = importOnce();
check(first.status === 0 && /2 tasks/.test(first.stdout) && /1 pages/.test(first.stdout) && /users/.test(first.stdout) && /laptop, @herval's/.test(first.stdout), `agentbook-server import takes the folder in (${(first.stdout + first.stderr).trim().split("\n")[0]})`);
const device = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "device.json"), "utf8"));
check(device.server === SERVER && device.token && device.name === "laptop" && (fs.statSync(path.join(HOME, "cli", "device.json")).mode & 0o777) === 0o600, "and logs its machine in: the CLI's token is where it looks, readable only by you");
const after = sums();
check(JSON.stringify(after) === JSON.stringify(before), "the folder's database and files are as they were");
const connectors = path.join(HOME, "server", "connectors.json");
check(fs.existsSync(connectors) && (fs.statSync(connectors).mode & 0o777) === 0o600, "its connectors go with the server's data, readable only by you");

// ---------- the two halves ----------
// A half, and what it has printed (log()).
type Half = ChildProcess & { log: () => string };
const running: Half[] = [];
const start = (args: string[], extra = {}) => {
  const p = Object.assign(spawnTied(args[0], args.slice(1), { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] }), { log: () => out });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  running.push(p);
  return p;
};
const server = start([path.join(REPO, "bin", "agentbook-server")]);
let cli = start([process.execPath, path.join(REPO, "plugin", "cli", "main.mjs"), "run"]);
try {
  await until(async () => (await fetch(`${SERVER}/api/health`).catch(() => null))?.ok);
  const login = await signIn(SERVER);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check(login.ok && cookie, "herval signs in, as the account he had");
  check(!fs.existsSync(connectors), "and the server moves the connectors into its database when it starts, leaving no connectors.json");
  const get = async (p: string, c = cookie): Promise<Json> => (await fetch(SERVER + p, { headers: { cookie: c } })).json();
  const state = await until(async () => {
    const s = await stateOf(get);
    return s.sessions?.length >= 2 && s;
  });
  const s1 = state?.sessions?.find((s) => s.id === "s1");
  check(!!s1 && state.sessions.some((s) => s.id === "s2") && s1.machine === "laptop", "the machine's posts come over when its CLI connects, with the same ids");
  check(s1?.title === "Fix the importer" && s1.pinned, "as they were: titles, and his pins");
  const detail = await get("/api/sessions/s1");
  check(detail.messages?.some((m) => /reads old files/.test(m.text)), "with what came after the folder's last checkpoint");
  const t1 = state?.tasks?.find((t) => t.id === "t1");
  check(t1?.text === "Review the importer" && t1.posts?.some((p) => p.post === "s1") && state.workspaces?.some((w) => w.id === "w1") && !state.tasks.some((t) => t.id === "t2"), "his tasks and workspaces, linked to the same posts, and nobody else's");
  const page = await get("/api/pages/status");
  check(page.widgets?.find((w) => w.id === "n")?.data?.text === "The importer is fixed." && page.version === 2, "his pages and their versions");
  const steps = await until(async () => {
    const r = await get("/api/sessions/s1/steps");
    return r.steps?.some((x) => /Run the tests/.test(x.title)) && r;
  }, 15000);
  check(!!steps, "and the CLI sends its recent posts' work, from their transcripts");
  const ship = await until(async () => {
    const s = await stateOf(get);
    const g = s.groups?.find((x) => x.id === "ship");
    return g?.posts === 1 && s.sessions?.find((x) => x.id === "s1")?.group === "ship" && g;
  });
  check(ship?.name === "Ship it", "his groups, and the threads in them");
  const planFile = await fetch(`${SERVER}/api/groups/ship/file?path=plan.md`, { headers: { cookie } });
  check(planFile.ok && (await planFile.text()) === "# Plan\nShip it.\n", "and every version of their files");
  await sleep(1500);
  const versions = (await get("/api/groups/ship/versions?path=plan.md")).versions || [];
  check(versions.length === 1 && fs.readFileSync(path.join(HOME, "cli", "groups", "ship", "plan.md"), "utf8") === "# Plan\nShip it.\n", "the machine's folder for it is in step, with nothing sent up again");
  check(["agentbook.db", "files", "groups"].every((n) => fs.existsSync(path.join(HOME, "cli", n)) && !fs.existsSync(path.join(HOME, n))) && fs.readFileSync(path.join(HOME, "cli", "files", "f1-report.txt"), "utf8") === "the report", "its agentbook-cli moved what's its own into its cli/ when it started: its database, its files, the group's folder");

  // ---------- a backup, while it runs ----------
  const BACKUP = path.join(HOME, "backup");
  fs.writeFileSync(path.join(HOME, "server", "server.log"), "what it printed, as agentbook up keeps it\n");
  const backup = spawnSync(path.join(REPO, "bin", "agentbook-server"), ["backup", BACKUP], { env, encoding: "utf8" });
  check(backup.status === 0 && /Backed up \d+ databases and \d+ files/.test(backup.stdout) && fs.existsSync(path.join(BACKUP, "storage.db")) && !fs.existsSync(path.join(BACKUP, "server.log")), `agentbook-server backup copies its data while it runs, not its log (${backup.stdout.trim().split("\n")[0] || backup.stderr.trim()})`);
  const restored = start([path.join(REPO, "bin", "agentbook-server")], { AGENTBOOK_SERVER_HOME: BACKUP, AGENTBOOK_SERVER_PORT: String(SERVER_PORT + 1) });
  const R = `http://127.0.0.1:${SERVER_PORT + 1}`;
  await until(async () => (await fetch(`${R}/api/health`).catch(() => null))?.ok);
  const rlogin = await signIn(R);
  const rstate = rlogin.ok ? await stateOf(async (p) => (await fetch(`${R}${p}`, { headers: { cookie: (rlogin.headers.get("set-cookie") || "").split(";")[0] } })).json()) : {};
  check(rlogin.ok && rstate.sessions?.some((x) => x.id === "s1") && rstate.tasks?.some((t) => t.id === "t1") && (await fetch(`${R}/api/sessions/s1/steps`, { headers: { cookie: (rlogin.headers.get("set-cookie") || "").split(";")[0] } }).then((r): Promise<Json> => r.json())).steps?.length, "and a server started from the copy has it all: accounts, posts, tasks, work");
  restored.kill();

  // ---------- the machine off ----------
  cli.kill();
  await new Promise((r) => cli.once("exit", r));
  await until(async () => (await stateOf(get)).machines?.find((m) => m.name === "laptop" && !m.online), 12000);
  const file = await fetch(`${SERVER}/api/files/f1`, { headers: { cookie } });
  check(file.ok && (await file.text()) === "the report", "the post's files open with the machine off: the import brought them");
  const stepsOff = await get("/api/sessions/s1/steps");
  check(stepsOff.steps?.some((x) => /Run the tests/.test(x.title)), "and so does its work");

  // ---------- again ----------
  server.kill();
  await new Promise((r) => server.once("exit", r));
  const second = importOnce();
  check(second.status === 0 && /nothing new|already/.test(second.stdout) && !/tasks/.test(second.stdout), `importing again adds nothing twice, from the database in its cli/ now (${second.stdout.trim().split("\n")[0]})`);
} catch (e) {
  check(false, `test crashed: ${e.stack}`);
} finally {
  for (const p of running) p.kill();
  if (failures) for (const p of running) console.log(p.log().split("\n").slice(-15).join("\n"));
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
