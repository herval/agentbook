#!/usr/bin/env node
// Connectors: a Linear connector set up on a real agentbook server, against a stand-in Linear (fake-linear.ts).
// Its issues come in as tasks, follow what happens to them there, and ticking one closes it there. Each person's
// are their own, with their own key, kept in the server's database encrypted with its AGENTBOOK_SECRET_KEY: a
// server without it, or with another, says so and drops nothing, and connectors.json from before moves in.
// Run: node test/connectors.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSecrets, newKey } from "../server/secrets.ts";
import { ownSecretKey } from "../plugin/shared/secret-key.ts";
import { spawnSync } from "node:child_process";
import { issue, startLinear } from "./fake-linear.ts";
import { SECRET_KEY, spawnAgentbook, testPort } from "./harness.ts";
import { closeSql, sql } from "./harness-sql.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-connectors-"));
const PORT = testPort(4800);
const URL = `http://127.0.0.1:${PORT}`;
const KEY = "lin_api_test0123456789";
const ALICE_KEY = "lin_api_alice0123456789";
const FILE = path.join(HOME, "server", "connectors.json");
const DB = path.join(HOME, "storage.db"); // the page's connectors are in agentbook's one database

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};

// Acme's Linear, one to a page so pulls take more than one: two issues of mine to do (one urgent), one in my
// backlog, one of someone else's, one in another team, one done.
check(/isn't a key/.test(createSecrets("hunter2").problem) && !createSecrets("hunter2").ready && createSecrets(newKey()).ready && createSecrets("ab".repeat(32)).ready, "AGENTBOOK_SECRET_KEY is 32 bytes, as base64 or hex: anything else says it isn't a key");
// Given none, a machine makes its own the first time and keeps it, outside its data folder (secret-key.ts); and
// bin/agentbook-server, which can't read that file under the permission model, is handed it, unless one's set.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-secret-key-"));
  const file = path.join(dir, "agentbook", "secret-key");
  const own = ownSecretKey(file);
  fs.writeFileSync(path.join(dir, "empty"), "");
  check(createSecrets(own).ready && ownSecretKey(file) === own && (fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(file)).mode & 0o777) === 0o700 && createSecrets(ownSecretKey(path.join(dir, "empty"))).ready, "a machine with no secret key given makes its own once, readable only by its user, and keeps it");
  const printed = (extra: Record<string, string>) => spawnSync(process.execPath, [path.join(ROOT, "shared", "secret-key.ts")], { env: { PATH: process.env.PATH, AGENTBOOK_SECRET_KEY_FILE: file, ...extra }, encoding: "utf8" }).stdout;
  check(printed({}) === own && printed({ AGENTBOOK_SECRET_KEY: "" }) === "" && printed({ AGENTBOOK_SECRET_KEY: newKey() }) === "", "bin/agentbook-server is handed it, unless its environment or .env sets one (empty: none)");
  fs.rmSync(dir, { recursive: true, force: true });
}

const linear = await startLinear({ key: KEY, page: 1, others: { alice: ALICE_KEY } });
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
linear.issues.push(
  issue("ENG", 1, "Fix the login bug", { priority: 3, updatedAt: ago(50) }),
  issue("ENG", 2, "Ship the cart", { priority: 1, state: "doing", updatedAt: ago(40) }),
  issue("ENG", 3, "Someday: dark mode", { state: "backlog" }),
  issue("ENG", 4, "Their thing", { assignee: "maria" }),
  issue("OPS", 1, "Rotate the certificates", { priority: 2 }),
  issue("ENG", 5, "Already shipped", { state: "done" }),
);
const at = (n: string) => linear.issues.find((i) => i.identifier === n);
const touch = (n: string, change: object) => Object.assign(at(n), change, { updatedAt: new Date(Date.now() + 1000).toISOString() });

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_LINEAR_URL: linear.url, AGENTBOOK_CONNECTOR_TICK_MS: "200", AGENTBOOK_CONNECTOR_MIN_EVERY: "1", TEST_LINEAR_KEY: KEY };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "LINEAR_API_KEY"]) delete env[k];
for (const k of ["AGENTBOOK_SECRET_KEY"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
let server = spawnAgentbook({ env, stdio: ["ignore", "ignore", "inherit"] });
// The same agentbook again, with another environment (`key`: its AGENTBOOK_SECRET_KEY, "" for none).
const stop = () => new Promise((r) => (server.once("exit", r), server.kill()));
async function start(key = SECRET_KEY) {
  server = spawnAgentbook({ env: { ...env, AGENTBOOK_SECRET_KEY: key }, stdio: ["ignore", "ignore", "inherit"] });
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false), 20000);
}
const restart = async (key?: string) => (await stop(), start(key));
// The server's connectors, as its database keeps them, and what its key opens of them.
// A row of the connectors table, as it's kept.
type ConnectorRow = { id: string; ord: number; data: string; api_key: string | null; refresh_token: string | null; app_key: string | null };
const rows = () => (sql(DB).prepare("select * from connectors order by ord").all() as ConnectorRow[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
const row = (id: string) => rows().find((r) => r.id === id);
const opened = (r: ReturnType<typeof row>, field: "api_key" | "refresh_token" | "app_key" = "api_key", key = SECRET_KEY) => createSecrets(key).open(r[field], `connector ${r.id} ${field}`).value;
// Whether a secret is anywhere in the server's data folder, in plain.
const plainIn = (secret: string) => {
  const hits: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (fs.readFileSync(f).includes(secret)) hits.push(path.relative(HOME, f));
    }
  })(path.join(HOME, "server"));
  return hits;
};
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });

try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false));
  const me = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  fs.mkdirSync(path.join(HOME, "shop"));
  const ws = await me.post("/api/workspaces", { folder: { path: path.join(HOME, "shop") } });
  const dentist = await me.post("/api/tasks", { text: "Book the dentist" });
  const tasks = async (who = me) => (await stateOf(who.get)).tasks;
  const task = async (key: string) => (await tasks()).find((t) => t.source?.key === key);
  const sync = (id = "linear") => me.post(`/api/connectors/${id}/sync`);

  // ---------- setting one up ----------
  const hersFirst = await alice.get("/api/connectors");
  check(hersFirst.status === 200 && hersFirst.kinds.some((k) => k.kind === "linear") && !hersFirst.connectors.length && !("file" in hersFirst), "anyone can set up connectors, not only an admin");
  const empty = await me.get("/api/connectors");
  check(empty.status === 200 && empty.kinds.some((k) => k.kind === "linear" && k.states.started === "In Progress") && !empty.connectors.length && !empty.error && !("file" in empty), "the page learns which kinds there are");
  const bad = await me.post("/api/connectors", { kind: "linear", api_key: "lin_api_wrong" });
  check(bad.status === 400 && /turned the API key down/.test(bad.error) && !rows().length && !fs.existsSync(FILE), "a key Linear turns down isn't kept");
  check((await me.post("/api/connectors", { kind: "jira", api_key: "x" })).status === 400 && (await me.post("/api/connectors", { kind: "linear" })).status === 400, "nor a kind there isn't, or one with no key");
  const added = await me.post("/api/connectors", { kind: "linear", api_key: KEY, teams: "eng", workspace: ws.id, agent: "claude", close: true, every: 3600 });
  const saved = row("linear");
  check(added.status === 200 && added.connector.id === "linear" && added.connector.who === "Herval, in Acme" && added.connector.key_set && !JSON.stringify(added).includes(KEY), "a Linear key is tried, and says who it signs in as; the key never comes back");
  check(saved.data.owner === "herval" && JSON.stringify(saved.data.teams) === '["ENG"]' && saved.data.close === true && !("api_key" in saved.data) && !fs.existsSync(FILE), "it's kept in the server's database, as the admin's who added it, with no file");
  check(/^sealed:v1:/.test(saved.api_key) && opened(saved) === KEY && !opened(saved, "api_key", newKey()) && !plainIn(KEY).length, "its key is encrypted with the server's secret key, and isn't anywhere in its data folder in plain");
  check(!createSecrets(SECRET_KEY).open(saved.api_key, "connector linear-2 api_key").value, "and opens only as that connector's key, not moved into another's place");

  // ---------- issues come in as tasks ----------
  const synced = await until(async () => ((await tasks()).filter((t) => t.source).length === 2 ? tasks() : null));
  const open = (synced || []).filter((t) => !t.done).sort((a, b) => a.rank - b.rank);
  check(JSON.stringify(open.map((t) => t.text)) === JSON.stringify(["Ship the cart", "Fix the login bug", "Book the dentist"]), "my open issues in its team come in on top of my list, urgent first; not my backlog, others', other teams' or done ones");
  const cart = open[0];
  check(cart.source.key === "ENG-2" && cart.source.url.startsWith("https://linear.app/acme/issue/ENG-2") && cart.source.state === "In Progress" && cart.workspace === ws.id && cart.agent === "claude" && cart.source.connector === "linear", "each links to its issue and says its state, in the workspace and for the agent the connector names");
  check(linear.calls.filter((c) => c.op === "AgentbookIssues").length >= 2, "more issues than fit on a page come in a page at a time");
  const st = (await stateOf(me.get)).connectors;
  check(st.length === 1 && st[0].count === 2 && st[0].synced && !st[0].error && !(await stateOf(alice.get)).connectors.length && !(await tasks(alice)).some((t) => t.source), "the page's state says when it synced and how many; alice gets none of it");
  await sync();
  check((await tasks()).filter((t) => t.source).length === 2, "syncing again brings nothing in twice");

  // ---------- what happens there, happens here ----------
  touch("ENG-1", { title: "Fix the login bug on Safari" });
  await me.post(`/api/tasks/${cart.id}`, { text: "Ship the cart (and the totals)" });
  touch("ENG-2", { title: "Ship the cart page" });
  await sync();
  check((await task("ENG-1")).text === "Fix the login bug on Safari" && (await task("ENG-2")).text === "Ship the cart (and the totals)" && (await task("ENG-2")).source.title === "Ship the cart page", "renamed there, a task follows, unless you edited it here");
  touch("ENG-1", { title: "Fix the login bug on Safari, where the session cookie is dropped after the OAuth redirect from Google" });
  await sync();
  const longLogin = await task("ENG-1");
  check(longLogin.text === "Fix the login bug on Safari, where the session cookie is dropped after the…" && longLogin.note === "…OAuth redirect from Google", "a long title there is cut here, the rest in its body");
  touch("ENG-1", { title: "Fix the login bug on Safari, where the session cookie is dropped after the OAuth redirect" });
  await sync();
  check((await task("ENG-1")).note === "…OAuth redirect", "renamed there, its body follows too");
  touch("ENG-1", { title: "Fix the login bug on Safari" });
  await sync();
  check((await task("ENG-1")).text === "Fix the login bug on Safari" && !(await task("ENG-1")).note, "and a short title again leaves no body");
  touch("ENG-1", { state: "done" });
  await sync();
  const doneThere = await task("ENG-1");
  check(doneThere.done && doneThere.done_by === "sync" && doneThere.source.gone === "Done in Linear" && doneThere.source.state === "Done", "done there, it's ticked here, saying why");
  touch("ENG-1", { state: "doing" });
  await sync();
  check(!(await task("ENG-1")).done && !(await task("ENG-1")).source.gone && (await task("ENG-1")).source.state === "In Progress", "opened again there, it's open again here");
  touch("ENG-1", { state: "shipped" });
  await sync();
  await me.post(`/api/tasks/${(await task("ENG-1")).id}/done`, { done: false });
  await until(() => linear.stateOf((at("ENG-1")).id) === "todo");
  await sync();
  check(linear.stateOf(at("ENG-1").id) === "todo" && !(await task("ENG-1")).done, "unticking one that's done there opens its issue again, in its team's first to-do state");
  touch("ENG-1", { state: "doing" });
  touch("ENG-2", { assignee: "maria" });
  await sync();
  check((await task("ENG-2")).done && (await task("ENG-2")).source.gone === "Not assigned to you any more", "given to someone else, it's ticked, saying so");
  touch("ENG-2", { assignee: "me" });
  await sync();
  check(!(await task("ENG-2")).done, "and back when it's yours again");

  // ---------- ticking closes it there ----------
  const login = await task("ENG-1");
  await me.post(`/api/tasks/${login.id}/done`, { done: true });
  await until(() => linear.stateOf(login.source.id) === "done");
  const closed = await until(async () => ((await task("ENG-1")).source.closed ? task("ENG-1") : null));
  check(linear.stateOf(login.source.id) === "done" && closed?.done && closed.source.was === "eng-doing" && closed.source.state === "Done", "ticking it closes the issue in Linear, in its team's first done state");
  await sync();
  check((await task("ENG-1")).done && (await task("ENG-1")).done_by === "you", "and it stays ticked, as you ticked it");
  await me.post(`/api/tasks/${login.id}/done`, { done: false });
  await until(() => linear.stateOf(login.source.id) === "doing");
  const reopened = await until(async () => ((await task("ENG-1")).source.closed ? null : task("ENG-1")));
  check(linear.stateOf(login.source.id) === "doing" && reopened && !reopened.done && reopened.source.state === "In Progress", "unticking puts the issue back in the state it was in");
  await me.post(`/api/tasks/${login.id}/done`, { done: true });
  await me.post(`/api/tasks/${login.id}/done`, { done: false });
  await sleep(300);
  await until(async () => !(await task("ENG-1")).source.closed);
  check(linear.stateOf(login.source.id) === "doing" && !(await task("ENG-1")).done, "ticked and unticked quickly, the issue ends as it was");
  const moves = linear.calls.length;
  await me.post(`/api/tasks/${dentist.id}/done`, { done: true });
  await sleep(300);
  check(linear.calls.length === moves, "a task of your own touches nothing in Linear");

  // ---------- deleting one keeps it out ----------
  const ship = await task("ENG-2");
  check((await me.post(`/api/tasks/${ship.id}/delete`)).status === 200 && !(await task("ENG-2")), "deleting a task from Linear takes it off the list");
  await sync();
  check(!(await task("ENG-2")) && (await tasks()).filter((t) => t.source).length === 1, "and the next sync doesn't bring it back");
  await me.post(`/api/tasks/${ship.id}/restore`);
  check((await task("ENG-2"))?.id === ship.id, "Undo puts it back as it was");
  await me.post(`/api/tasks/${ship.id}/delete`);
  touch("ENG-2", { state: "done" });
  await sync();
  touch("ENG-2", { state: "todo" });
  await sync();
  const back = await task("ENG-2");
  check(back && back.id !== ship.id && !back.done, "once its issue left (done there), it's forgotten: opened again, it comes back as new");

  // ---------- changing it ----------
  const teams = async (t: string[]) => (await me.post("/api/connectors", { id: "linear", teams: t })).connector.teams.length;
  check((await me.post("/api/connectors", { id: "linear", teams: ["ENG", "OPS"], api_key: "$TEST_LINEAR_KEY" })).status === 200, "the admin changes it to another team, and a key from agentbook's environment");
  await sync();
  check(!!(await task("OPS-1")) && (await me.get("/api/connectors")).connectors[0].key_env === "$TEST_LINEAR_KEY" && row("linear").api_key === "$TEST_LINEAR_KEY", "it brings that team's in, and the key from the environment stays a name, nothing to encrypt");
  await teams(["ENG"]);
  await sync();
  check((await task("OPS-1")).done && /Todo in Linear/.test((await task("OPS-1")).source.gone), "a team taken off ticks its tasks");
  await teams(["ENG", "OPS"]);
  await sync();
  check(!(await task("OPS-1")).done, "and put back, opens them again, though their issues didn't change");

  // ---------- Linear out of reach ----------
  linear.down(true);
  await sync();
  const failing = (await stateOf(me.get)).connectors[0];
  check(/Linear/.test(failing.error || "") && (await tasks()).filter((t) => t.source && !t.done).length === 3, "when Linear can't be reached, it says why and the tasks stay");
  linear.down(false);
  await sync();
  check(!(await stateOf(me.get)).connectors[0].error, "and stops saying so once it's back");

  // ---------- everyone's own ----------
  linear.issues.push(issue("ENG", 7, "Review the cart copy", { assignee: "alice", priority: 2 }));
  const hers = await alice.post("/api/connectors", { kind: "linear", api_key: ALICE_KEY });
  check(hers.status === 200 && hers.connector.id === "linear-2" && hers.connector.who === "Alice, in Acme" && row("linear-2")?.data.owner === "alice" && opened(row("linear-2")) === ALICE_KEY && !plainIn(ALICE_KEY).length, "alice connects her own Linear, with her own key, encrypted too, and it's hers");
  const herTasks = await until(async () => ((await tasks(alice)).some((t) => t.source) ? tasks(alice) : null));
  check(JSON.stringify((herTasks || []).filter((t) => t.source).map((t) => t.source.key)) === '["ENG-7"]' && !(await task("ENG-7")) && (await tasks()).filter((t) => t.source && !t.done).length === 3, "the issues assigned to her come into her Tasks, and only hers; mine stay mine");
  const lists = [await me.get("/api/connectors"), await alice.get("/api/connectors")];
  const states = [await stateOf(me.get), await stateOf(alice.get)];
  check(JSON.stringify(lists.map((l) => l.connectors.map((c) => c.id))) === '[["linear"],["linear-2"]]' && JSON.stringify(states.map((v) => v.connectors.map((c) => c.id))) === '[["linear"],["linear-2"]]', "each sees only their own connectors, on the Connectors page and the Tasks page");
  const theirs = await Promise.all([alice.post("/api/connectors/linear/sync"), alice.post("/api/connectors", { id: "linear", close: false }), alice.post("/api/connectors/linear/delete"), me.post("/api/connectors/linear-2/sync"), me.post("/api/connectors", { id: "linear-2", teams: ["OPS"] }), me.post("/api/connectors/linear-2/delete")]);
  check(theirs.every((r) => r.status === 404) && rows().length === 2 && rows()[0].data.close === true && !rows()[1].data.teams, "nobody syncs, changes or removes someone else's, not even an admin");
  const review = herTasks.find((t) => t.source?.key === "ENG-7");
  await alice.post(`/api/tasks/${review.id}/done`, { done: true });
  await until(() => linear.stateOf(review.source.id) === "done");
  check(linear.stateOf(review.source.id) === "done" && linear.calls.filter((c) => c.op === "AgentbookMove").at(-1)?.who === "alice", "ticking her task closes her issue in Linear, as her");

  // ---------- editing and removing ----------
  const edited = await me.post("/api/connectors", { id: "linear", close: false, name: "Linear (Acme)" });
  check(edited.status === 200 && edited.connector.close === false && edited.connector.name === "Linear (Acme)" && row("linear").api_key === "$TEST_LINEAR_KEY", "editing one keeps its key unless you paste another");
  const rot = await task("OPS-1");
  await me.post(`/api/tasks/${rot.id}/done`, { done: true });
  await sleep(500);
  check(linear.stateOf(rot.source.id) === "todo", "with closing off, ticking leaves the issue be");
  const second = await me.post("/api/connectors", { kind: "linear", api_key: KEY, teams: ["OPS"] });
  check(second.connector?.id === "linear-3" && second.connector.close === true, "a second Linear connector gets an id of its own, and closes issues unless told not to");
  check((await me.post("/api/connectors/linear-3/delete")).status === 200 && (await me.post("/api/connectors/linear/delete")).status === 200 && JSON.stringify(rows().map((c) => c.id)) === '["linear-2"]', "connectors can be removed, and someone else's stay");
  check((await tasks()).filter((t) => t.source && !t.done).length === 2 && !(await stateOf(me.get)).connectors.length, "and their tasks stay on your list");
  // Her next one gets the id mine had: ticking a task of mine from it reaches nothing of hers.
  check((await alice.post("/api/connectors", { kind: "linear", api_key: ALICE_KEY, teams: ["OPS"] })).connector?.id === "linear", "a new one can get an id one removed had");
  const calls = linear.calls.length;
  const cart2 = await task("ENG-2");
  await me.post(`/api/tasks/${cart2.id}/done`, { done: true });
  await sleep(500);
  check(!linear.calls.slice(calls).some((c) => c.op === "AgentbookMove") && linear.stateOf(cart2.source.id) === "todo", "and a task from the one I removed never closes its issue with her key");

  // ---------- connectors.json, from before ----------
  // A server from before kept them in a file, in plain: on start, it moves into the database, encrypted, and goes.
  // Ones the database has already (the same id: moved in before, or imported again) stay as they are.
  const later = new Date(Date.now() + 8 * 3600e3).toISOString();
  await stop();
  const before = [
    { id: "linear", kind: "linear", owner: "alice", api_key: "lin_api_stale", teams: ["ENG"] },
    { id: "linear-9", kind: "linear", owner: "herval", api_key: KEY, teams: ["OPS"], every: 3600 },
    { id: "github-9", kind: "github", owner: "herval", api_key: "ghu_from_the_file", via: "app", refresh_token: "ghr_from_the_file", expires_at: later, off: true },
    { id: "linear-env", kind: "linear", owner: "herval", api_key: "$TEST_LINEAR_KEY", off: true },
  ];
  fs.writeFileSync(FILE, JSON.stringify({ connectors: before }), { mode: 0o600 });
  await start();
  const moved = await me.get("/api/connectors");
  check(!fs.existsSync(FILE) && JSON.stringify(moved.connectors.map((c) => c.id)) === '["linear-9","github-9","linear-env"]' && moved.connectors.every((c) => c.key_set && !c.locked) && !moved.error, "connectors.json from before moves into the database on start, and the file goes");
  const gh = row("github-9");
  check(opened(row("linear-9")) === KEY && opened(gh) === "ghu_from_the_file" && opened(gh, "refresh_token") === "ghr_from_the_file" && gh.data.via === "app" && gh.data.expires_at === later && row("linear-env").api_key === "$TEST_LINEAR_KEY", "each key in it is encrypted, a GitHub sign-in's refresh token too, and one from the environment stays its name");
  check(opened(row("linear")) === ALICE_KEY && JSON.stringify(row("linear").data.teams) === '["OPS"]', "one the database had already stays as it was");
  check(["ghu_from_the_file", "ghr_from_the_file", "lin_api_stale", KEY].every((k) => !plainIn(k).length), "and none of its keys is left anywhere in the data folder in plain");
  check(!(await me.post("/api/connectors/linear-9/sync")).connector.error, "and they work as before");

  // ---------- without its key ----------
  await restart("");
  const locked = await me.get("/api/connectors");
  const nine = locked.connectors.find((c) => c.id === "linear-9");
  check(locked.status === 200 && /no secret key \(AGENTBOOK_SECRET_KEY\)/.test(locked.error || "") && /agentbook-server secret-key/.test(locked.error) && locked.connectors.length === 3 && nine?.locked && !nine.key_set && /no secret key/.test(nine.error), "started without its secret key, it says so, and how to fix it; each connector it can't read the key of says why, and none is dropped");
  check(locked.connectors.find((c) => c.id === "linear-env")?.key_set && !locked.connectors.find((c) => c.id === "linear-env").locked, "one whose key comes from the environment still works");
  const herLocked = await alice.get("/api/connectors");
  check(/until its admin/.test(herLocked.error || "") && herLocked.connectors.length === 2 && herLocked.connectors.every((c) => c.locked && /no secret key/.test(c.error)), "alice's say so too, and she's told it's her admin's to fix");
  const sealedBefore = row("linear-9").api_key;
  const syncLocked = await me.post("/api/connectors/linear-9/sync");
  check(syncLocked.status === 200 && /no secret key/.test(syncLocked.connector.error || "") && /no secret key/.test((await stateOf(me.get)).connectors.find((c) => c.id === "linear-9")?.error || ""), "syncing one says why it can't, on the Tasks page too");
  const refused = await me.post("/api/connectors", { kind: "linear", api_key: KEY });
  check(refused.status === 503 && /AGENTBOOK_SECRET_KEY/.test(refused.error) && rows().length === 5, "a new key isn't taken: it couldn't be kept encrypted");
  const renamed = await me.post("/api/connectors", { id: "linear-9", name: "Linear (ops)" });
  check(renamed.status === 200 && renamed.connector.name === "Linear (ops)" && renamed.connector.locked && row("linear-9").api_key === sealedBefore, "changing one keeps its key as it was encrypted");
  // A connectors.json with keys, meanwhile: it can't be encrypted, so it stays.
  await stop();
  fs.writeFileSync(FILE, JSON.stringify({ connectors: [{ id: "linear-7", kind: "linear", owner: "herval", api_key: KEY, teams: ["ENG"], off: true }] }), { mode: 0o600 });
  await start("");
  const pending = await me.get("/api/connectors");
  check(fs.existsSync(FILE) && /keeps API keys in plain/.test(pending.error || "") && pending.connectors.some((c) => c.id === "linear-7" && c.key_set) && pending.connectors.some((c) => c.id === "linear-9" && c.locked), "a connectors.json with keys stays until there's a key to encrypt them with, its connectors working beside the database's");
  check((await me.post("/api/connectors", { id: "linear-env", name: "Linear (env)" })).status === 409 && (await me.post("/api/connectors/linear-env/delete")).status === 409 && /admin/.test((await alice.get("/api/connectors")).error || ""), "and nothing changes until it's moved in");

  // ---------- with another key ----------
  const OTHER = newKey();
  await restart(OTHER);
  const other = await me.get("/api/connectors");
  const nine2 = other.connectors.find((c) => c.id === "linear-9");
  check(!fs.existsSync(FILE) && other.connectors.find((c) => c.id === "linear-7")?.key_set && nine2?.locked && /another secret key/.test(nine2.error) && !other.error, "with another key, the file waiting moves in with it, and ones encrypted with the old one say so");
  const repasted = await me.post("/api/connectors", { id: "linear-9", api_key: KEY });
  check(repasted.status === 200 && !repasted.connector.locked && repasted.connector.key_set && opened(row("linear-9"), "api_key", OTHER) === KEY, "pasting its key again keeps it with the key the server has now");
  check(opened(row("linear-2")) === ALICE_KEY && (await alice.get("/api/connectors")).connectors.every((c) => c.locked), "and alice's stay as they were, for the key they were kept with");
  await restart();
  check((await alice.get("/api/connectors")).connectors.every((c) => c.key_set && !c.locked) && (await me.get("/api/connectors")).connectors.find((c) => c.id === "github-9")?.key_set, "started with that key again, they work again");

  // ---------- a connectors.json that isn't valid ----------
  await stop();
  fs.writeFileSync(FILE, "{ not json");
  await start();
  const broken = await me.get("/api/connectors");
  check(fs.existsSync(FILE) && /isn't valid/.test(broken.error || "") && broken.connectors.some((c) => c.id === "github-9") && (await me.post("/api/connectors", { kind: "linear", api_key: KEY })).status === 409 && (await me.post("/api/connectors/linear-env/delete")).status === 409, "a connectors.json that isn't valid stays and says so, the database's still there, and nothing changes until it's fixed");
  const hersBroken = await alice.get("/api/connectors");
  check(/admin/.test(hersBroken.error || "") && !hersBroken.error.includes(HOME), "someone else is told so too, without where it is or what's wrong in it");
} finally {
  server.kill();
  linear.close();
}
closeSql();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
