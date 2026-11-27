#!/usr/bin/env node
// Several people on one hub, and nothing of anyone's reaching anyone else. A hub (agentbook-server, herval's, with
// his own machine's posts, tasks, workspaces, pages and connectors) and two people's machines, both called
// "laptop": alice's, and bob's, logged in with `agentbook connect`, each running only agentbook-cli. Everything private is marked with a canary ("SECRETA-…" is alice's,
// "SECRETH-…" herval's, "SECRETB-…" bob's): posts, messages, questions, files, plans, steps, folders, what a post is
// doing, tasks, workspaces, pages, connectors, the messages waiting for a session. Then each person reads every
// route there is, the live stream, and what a machine's token reaches, and tries every change to the others'
// things; none of it reaches them or lands. Also: machines with the same name, the hub's gh and environment
// keys, search words, the page's Content-Security-Policy, and the policy's allowlists on their own.
// Run: node test/multiuser.ts

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pull } from "./fake-gh-pulls.ts";
import { startGitHub } from "./fake-github.ts";
import { startLinear } from "./fake-linear.ts";
import { createAccounts } from "../server/accounts.ts";
import { AccountTables } from "../server/storage/accounts.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { createRelay } from "../server/relay.ts";
import { detailFor, postForOthers, viewFor } from "../server/policy.ts";
import { checkCommand } from "../plugin/shared/protocol.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { closeSql, sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-multiuser-"));
const HUB_PORT = testPort(5100, 80);
const [A_PORT, B_PORT, C_PORT, FAKE_HUB_PORT] = [HUB_PORT + 100, HUB_PORT + 200, HUB_PORT + 300, HUB_PORT + 400];
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
const C = `http://127.0.0.1:${C_PORT}`;
const KEY = "lin_api_herval0123456789";
const ALICE_KEY = "lin_api_alice0123456789";
const HERVAL_GH = "ghu_herval0123456789";
const ALICE_GH = "ghu_alice0123456789";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

// ---------- the people's canaries ----------
const CANARY = /SECRET([AHB])-[\w.-]+/g;
// The canaries in a text that aren't `who`'s own ("A", "H" or "B").
const leaks = (text: unknown, who: string) => [...new Set((String(text).match(CANARY) || []).filter((c) => c[6] !== who))];

// ---------- the policy's allowlists, on their own ----------
{
  // Records as a machine might send them: with fields the policy doesn't know (one added later), and cut short to what
  // each check needs, so they're no type of agentbook's.
  const post: Json = {
    id: "p1", agent: "claude", label: "wren", title: "PUBLIC-title", text: "PUBLIC-text", prompt: "PUBLIC-prompt", started: "2026-10-09T00:00:00Z", updated: "2026-10-09T00:00:00Z", state: "working", effective: "needs", visibility: "public",
    cwd: "/Users/x/SECRETX-cwd", root: "/Users/x/SECRETX-root", transcript: "/x/SECRETX-transcript.jsonl", pid: 4242, proc: "SECRETX-proc", session_id: "SECRETX-session", launch: "SECRETX-launch", url: "https://SECRETX-url", doing: "SECRETX-doing", host: "SECRETX-host", model_pick: "SECRETX-model", channel: true, rt: { secret: "SECRETX-rt" },
    skills: [{ name: "SECRETX-skill" }], skill_uses: { "SECRETX-skill": 1 }, plan: [{ text: "SECRETX-plan" }], open_questions: 2, some_field_added_later: "SECRETX-new",
    updates: [{ at: "2026-10-09T00:00:00Z", text: "Changed SECRETX-file.js +1 −0", changes: { turn: 1, files: 1, add: 1, del: 0, last: "2026-10-09:SECRETX-path" } }, { at: "2026-10-09T00:00:00Z", text: "PUBLIC-result", link: "https://example.com" }],
    last_messages: [{ id: "m1", post: "p1", from: "agent", via: "dash", text: "PUBLIC-message", at: "2026-10-09T00:00:00Z", ext: "SECRETX-ext" }],
    last_files: [{ id: "f1", name: "SECRETX-name.txt", stored: "SECRETX-stored" }], files: 1,
    messages: 1,
  };
  const agent = { id: "claude", visibility: "private" };
  const seen = postForOthers(post, agent, "herval");
  check(!leaks(JSON.stringify(seen), "-").length && seen.title === "PUBLIC-title" && seen.updates[1].text === "PUBLIC-result" && seen.last_messages[0].text === "PUBLIC-message", "a post as others see it has its title, results and conversation, and none of its owner-only fields, a field added later included");
  check(seen.agent === null && seen.effective === "waiting" && seen.open_questions === 0 && !("cwd" in seen) && !("transcript" in seen), "nor its private agent, that it needs its owner, its questions, or where it runs");
  check(seen.plan?.[0]?.text === "SECRETX-plan" && seen.last_files[0].name === "SECRETX-name.txt" && !seen.last_files[0].stored && seen.updates[0].text.includes("SECRETX-file.js"), "whoever sees it sees its work: its plan, files and which files a turn changed, still not where files are kept");
  const detail = detailFor({ ...post, messages: post.last_messages, files: [{ id: "f1", name: "a.txt", stored: "SECRETX-stored", remote: "SECRETX-remote" }], questions: [{ title: "SECRETX-question" }], live: { doing: "SECRETX-live" } }, agent, false, "herval");
  check(!leaks(JSON.stringify(detail), "-").length && detail.messages[0].text === "PUBLIC-message", "a post's page as others see it: the same");
  const sent: Json = { seq: 1, machine: "m", home: "/Users/SECRETX-home", clone_dir: "/SECRETX-clones", drivers: { codex: { error: "SECRETX-driver" } }, folders: [{ root: "/SECRETX-folder" }], questions: [{ title: "SECRETX-q" }], launches: [{ prompt: "SECRETX-launch" }], cloning: [{ dir: "/SECRETX-clone" }], live: { p1: { doing: "SECRETX-live" } }, extra_added_later: "SECRETX-later", agents: [{ id: "claude", name: "Claude", visibility: "public", routines: [{ name: "SECRETX-routine" }], models: ["SECRETX-model"], link: { state: "failed", error: "SECRETX-gateway wss://brick", since: "2026-10-09" }, folders: false, driver: "openclaw" }], sessions: [post, { ...post, id: "p2", visibility: "private", title: "SECRETX-private" }], pages: [] };
  // As a contact of its owner sees it: public is for them.
  const view = viewFor(sent, false, "herval", "alice", () => undefined, true);
  check(!leaks(JSON.stringify(view), "-").length && view.sessions.length === 1 && view.agents[0].link.state === "failed" && view.agents[0].owner === "herval", "a machine's view as others see it: only what's listed, not its folders, drivers, questions, starts, routines or why its agents are offline");
  const stranger = viewFor(sent, false, "herval", "mallory");
  check(!stranger.sessions.length && !stranger.agents.length, "and someone who isn't its owner's contact sees none of its public things");
  const paged: Json = { seq: 1, agents: [{ id: "claude", visibility: "public" }], sessions: [{ ...post, page: "pg-open" }, { ...post, id: "p3", page: "SECRETX-page" }], pages: [{ id: "pg-open", title: "Open", visibility: "public", contributors: [], widgets: [] }, { id: "SECRETX-page", title: "SECRETX-title", visibility: "private", contributors: [], widgets: [] }] };
  const onPages = viewFor(paged, false, "herval", "alice", () => undefined, true);
  check(onPages.sessions[0].page === "pg-open" && onPages.sessions[1].page === null && !leaks(JSON.stringify(onPages), "-").length, "a public thread says which page it was started from to others only when they may see that page");
}

// ---------- a machine's ops and ids are its own ----------
{
  const relay = createRelay({ home: path.join(BASE, "relay-unit"), accounts: { byId: (id) => ({ id, username: id }), deviceById: () => null } });
  const lap = relay.device("da", { name: "laptop", user_id: "ua" });
  const desk = relay.device("db", { name: "desk", user_id: "ub" });
  const at = new Date().toISOString();
  const hello = (seq: number, id: string) => ({ kind: "post.hello", seq, at, args: { proc: `p${seq}`, agent: "claude", agent_name: "Claude", kind: "claude-code", label: "x", session_id: id } });
  relay.ingest(lap, { ops: [hello(1, "s-1")] });
  relay.ingest(desk, { ops: [hello(1, "s-1"), { kind: "post.post", seq: 2, at, args: { post: "s-1", title: "desk's" } }] });
  check(relay.idOf(lap, "s-1") === "s-1" && relay.idOf(desk, "s-1") === "desk~s-1" && relay.idOf(desk, "claude") === "desk~claude" && lap.store.state.sessions["s-1"].title === null && relay.resolve("desk~s-1")?.D === desk, "an id another machine has gets the machine's name in front, and what a machine sends lands only on its own posts");
  const bad = relay.ingest(lap, { ops: [{ kind: "shell.run", seq: 3, at, args: {} }, { kind: "post.post", seq: 4, at, args: { post: "s-1", title: "x".repeat(300) } }, hello(5, "s-2")] });
  check(/isn't an op/.test(bad.error || "") && !lap.store.state.sessions["s-1"].title && !!lap.store.state.sessions["s-2"] && bad.acked === 5, "an op the server doesn't take, or one too big, is refused, and the rest goes on");
  const again = relay.ingest(lap, { ops: [hello(5, "s-2"), { kind: "post.post", seq: 2, at, args: { post: "s-1", title: "replayed" } }] });
  check(again.acked === 5 && !lap.store.state.sessions["s-1"].title, "an op sent again is taken once, by its number");
  check(!!checkCommand({ kind: "shell.run", args: {} }) && !!checkCommand({ kind: "post.stop", args: { post: "x", extra: 1 } }) && !checkCommand({ kind: "post.stop", args: { post: "x" } }), "a command the CLI doesn't know, or one with a field its kind doesn't have, is refused");
}

// ---------- machines connected under one name before names were kept apart ----------
{
  const storage = Storage.at(path.join(BASE, "legacy", "storage.db"));
  const tables = storage.use(AccountTables);
  const db = sql(storage.file);
  const now = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  for (const [id, username] of [["u1", "alice"], ["u2", "bob"]]) tables.insertUser({ id, username, password: "x", created: now(100) });
  const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
  // Two people's laptops, both seen lately (bob's last), and an old token of alice's for her laptop from before.
  db.prepare("insert into devices (id, user_id, name, token_hash, created, last_seen) values (?, ?, ?, ?, ?, ?)").run("d1", "u1", "laptop", sha("t1"), now(90), now(5));
  db.prepare("insert into devices (id, user_id, name, token_hash, created, last_seen) values (?, ?, ?, ?, ?, ?)").run("d2", "u2", "laptop", sha("t2"), now(80), now(1));
  db.prepare("insert into devices (id, user_id, name, token_hash, created, last_seen) values (?, ?, ?, ?, ?, ?)").run("d3", "u1", "laptop", sha("t3"), now(95), now(60));
  const accounts = createAccounts(storage);
  const names = Object.fromEntries(["d1", "d2", "d3"].map((id) => [id, tables.deviceById(id).name]));
  check(names.d2 === "laptop" && names.d1 === "laptop-alice" && names.d3 === "laptop-alice-2" && accounts.deviceNamed("laptop").id === "d2", "machines connected under one name before names were kept apart: the one seen last keeps it, the others are renamed after their person");
  const asks = accounts.requestDevice("laptop");
  check(accounts.nameFor("laptop", "u1").name === "laptop-alice" && accounts.nameFor("laptop", "u1").replaces[0]?.id === "d1" && accounts.nameFor("laptop", "u2").replaces[0]?.id === "d2" && !!asks, "and a machine connecting again as laptop is bob's laptop again for him, alice's laptop-alice for her");
  closeSql(storage.file);
  storage.close();
}

// ---------- a machine's token is made when it picks it up, never kept in plain ----------
{
  const storage = Storage.at(path.join(BASE, "tokens", "storage.db"));
  const db = sql(storage.file);
  const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  storage.use(AccountTables).insertUser({ id: "u1", username: "alice", password: "x", created: at(100) });
  // Approved before that: each kept its token in plain until it was picked up. One is too old to pick up.
  const old = (code: string, poll: string, token: string, ago: number) => db.prepare("insert into device_requests (code, poll_hash, name, created, approved_by, token) values (?, ?, 'desk', ?, 'u1', ?)").run(code, sha(poll), at(ago), token);
  old("OLDA-AAAA", "old-poll", "old-token", 60);
  old("OLDB-BBBB", "stale-poll", "stale-token", 3600);
  const accounts = createAccounts(storage);
  const plain = () => (db.prepare("select count(*) n from device_requests where token is not null").get() as { n: number }).n;
  check(plain() === 1, "a request from before that's too old to pick up, its token in plain, goes when the server starts");
  check(accounts.pollDevice("old-poll")?.token === "old-token" && plain() === 0, "one from before that's still waiting hands over its token, once, and keeps it no more");
  const asks = accounts.requestDevice("laptop");
  const made = accounts.approveDevice(asks.code, "u1");
  const hashes = db.prepare("select token_hash from devices where id = ?").all(made.id);
  check(!plain() && hashes.length === 1 && db.prepare("select device from device_requests where code = ?").get(asks.code)?.device === made.id, "approving a machine keeps no token for it: only a hash nobody has the token of");
  const got = accounts.pollDevice(asks.poll);
  check(!!got?.token && accounts.deviceFor(got.token)?.id === made.id && db.prepare("select token_hash from devices where id = ?").get(made.id).token_hash === sha(got.token) && !accounts.pollDevice(asks.poll), "its token is made when the machine picks it up, works, and is handed over once");
  closeSql(storage.file);
  storage.close();
}

// ---------- the servers ----------
const linear = await startLinear({ key: KEY, others: { alice: ALICE_KEY } });
const GH_FILE = path.join(BASE, "gh.json");
// GitHub: herval's private acme/secret, and alice's alice/shop, each seen only by its person.
fs.writeFileSync(
  GH_FILE,
  JSON.stringify({
    tokens: { [HERVAL_GH]: { login: "herval", repos: ["acme/secret"] }, [ALICE_GH]: { login: "alice", repos: ["alice/shop"] } },
    repos: { "acme/secret": { pulls: [pull({ repo: "acme/secret", number: 7, title: "SECRETH-pr", head: "fix" })], diffs: {} }, "alice/shop": { pulls: [pull({ repo: "alice/shop", number: 3, title: "SECRETA-pr", head: "cart", author: "alice" })], diffs: {} } },
  }),
);
const site = await startGitHub({ ghFile: GH_FILE });
const ghCalls = () => (fs.existsSync(`${GH_FILE}.calls.jsonl`) ? fs.readFileSync(`${GH_FILE}.calls.jsonl`, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", HERMES_HOME: path.join(BASE, "hermes"), AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(BASE, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), AGENTBOOK_RUNTIME_MS: "300", GIT_ALLOW_PROTOCOL: "file", AGENTBOOK_LINEAR_URL: linear.url, AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_PR_TICK_MS: "300", AGENTBOOK_PR_MS: "500" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_MACHINE", "LINEAR_API_KEY"]) delete common[k];
fs.mkdirSync(common.FAKE_CLAUDE_DIR, { recursive: true });
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_CLONE_DIR: path.join(BASE, "hub", "clones"), LINEAR_API_KEY: KEY };
const serve = (env: NodeJS.ProcessEnv) => spawnAgentbook({ env, stdio: ["ignore", "ignore", "inherit"] });
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 6000);

// A request from another computer: the hub by the name people reach it at, so nothing counts as this machine's.
function remote(method: string, p: string, { cookie, body, raw, headers = {}, base = HUB_PORT, timeout = 15000 }: { cookie?: string; body?: unknown; raw?: string; headers?: Record<string, string>; base?: number; timeout?: number } = {}) {
  return new Promise<Json>((resolve) => {
    const payload = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
    const req = http.request({ host: "127.0.0.1", port: base, path: p, method, headers: { host: `hub.example:${base}`, ...(body !== undefined && raw === undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers } }, (r) => {
      let text = "";
      r.on("data", (d) => (text += d));
      r.on("end", () => {
        let json: Json = {};
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: r.statusCode, headers: r.headers, text, ...json });
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve({ status: 0, text: "", timedOut: true });
    });
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.end(payload);
  });
}
const person = (cookie: string) => ({ cookie, get: (p: string, o: { timeout?: number } = {}) => remote("GET", p, { cookie, ...o }), post: (p: string, body: unknown = {}, o: { headers?: Record<string, string> } = {}) => remote("POST", p, { cookie, body, ...o }) });
type Person = ReturnType<typeof person>;
// What a machine's own sessions send it (hooks, the MCP server).
const local = async (base: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};

const hubServer = serve(hubEnv);
const running = [hubServer];
let fakeHub: http.Server | null = null;
try {
  check(await healthy(HUB), "a hub starts");

  // ---------- people ----------
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  const herval = person((setup.headers.get("set-cookie") || "").split(";")[0]);
  const join = async (username: string) => {
    const r = await remote("POST", "/api/auth/test-person", { body: { username } });
    return person(String(r.headers["set-cookie"]?.[0] || "").split(";")[0]);
  };
  const alice = await join("alice");
  const bob = await join("bob");
  check(setup.ok && (await alice.get("/api/auth/me")).user?.username === "alice" && (await bob.get("/api/auth/me")).user?.username === "bob", "herval runs the hub; alice and bob are on it");
  // alice and bob are each other's contacts, so each sees what the other makes public; herval is neither's.
  await bob.post("/api/people/alice/contact", { act: "ask" });
  await alice.post("/api/people/bob/contact", { act: "yes" });

  // ---------- alice connects her laptop ----------
  const ask = async (name: string): Promise<Json> => (await fetch(HUB + "/api/devices/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
  const poll = async (r: { poll: string }): Promise<Json> => (await fetch(`${HUB}/api/devices/poll?poll=${encodeURIComponent(r.poll)}`)).json();
  const aliceAsk = await ask("laptop");
  const aliceSees = await alice.get(`/api/devices/request/${aliceAsk.code}`);
  const aliceDevice = await alice.post("/api/devices/approve", { code: aliceAsk.code });
  const aliceGot = await poll(aliceAsk);
  check(aliceSees.name === "laptop" && !aliceSees.replaces.length && aliceDevice.device?.name === "laptop" && aliceGot.name === "laptop" && aliceGot.user === "alice", "alice connects her laptop as laptop");
  const aliceEnv = { ...common, AGENTBOOK_PORT: String(A_PORT), AGENTBOOK_HOME: path.join(BASE, "alice"), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_CLONE_DIR: path.join(BASE, "alice", "clones"), AGENTBOOK_HUB: HUB, AGENTBOOK_HUB_TOKEN: aliceGot.token, AGENTBOOK_URL: A };
  running.push(serve(aliceEnv));
  check(await healthy(A), "alice's laptop starts, connected");

  // ---------- bob logs his in, also called laptop, with agentbook-cli login ----------
  const bobHome = path.join(BASE, "bob");
  const cli = spawn(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "login", HUB, "--no-start"], { env: { ...common, AGENTBOOK_HOME: bobHome, AGENTBOOK_MACHINE: "laptop", AGENTBOOK_PORT: String(B_PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  cli.stdout.on("data", (d) => (said += d));
  const code = await until(() => said.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)?.[1], 8000);
  const bobSees = await bob.get(`/api/devices/request/${code}`);
  check(bobSees.name === "laptop-bob" && bobSees.asked === "laptop" && !bobSees.replaces.length, "bob's machine asks to be laptop too, which is alice's: approving it, bob sees it'll be laptop-bob");
  const bobDevice = await bob.post("/api/devices/approve", { code });
  await new Promise((r) => cli.on("exit", r));
  const saved = JSON.parse(fs.readFileSync(path.join(bobHome, "cli", "device.json"), "utf8"));
  check(bobDevice.device?.name === "laptop-bob" && saved.name === "laptop-bob" && /as laptop-bob/.test(said), "and agentbook-cli login keeps the name the server gave it");
  running.push(serve({ ...common, AGENTBOOK_PORT: String(B_PORT), AGENTBOOK_HOME: bobHome, AGENTBOOK_CLONE_DIR: path.join(bobHome, "clones"), AGENTBOOK_URL: B }));
  check(await healthy(B), "bob's machine starts, connected by what agentbook-cli login saved");
  const bobOnline = await until(async () => (await stateOf(bob.get)).machines?.find((m) => m.name === "laptop-bob" && m.online));
  check(!!bobOnline && (await stateOf(bob.get)).machines.every((m) => m.name !== "laptop"), "it reports as laptop-bob, and bob's machine list doesn't have alice's laptop, which has nothing he may see");
  const bobToken = saved.token;
  const asBobsDevice = (p: string, body?: unknown) => fetch(HUB + p, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${bobToken}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, text: await r.text() }));

  // ---------- what's on the hub: herval's ----------
  const hubProject = path.join(BASE, "hub", "SECRETH-dir", "app");
  fs.mkdirSync(hubProject, { recursive: true });
  await local(HUB, "POST", "/api/hello", { proc: "herval-box-1", label: "wren", agent: "Claude", session_id: "h1", cwd: hubProject, host: "SECRETH-host" });
  await local(HUB, "POST", "/api/procs/herval-box-1/post", { title: "SECRETH-title", text: "SECRETH-text" });
  await local(HUB, "POST", "/api/procs/herval-box-1/messages", { from: "agent", text: "SECRETH-message" });
  const hq = await local(HUB, "POST", "/api/procs/herval-box-1/questions", { title: "SECRETH-question", options: ["Yes", "No"] });
  const hf = await local(HUB, "POST", "/api/procs/herval-box-1/files", { name: "SECRETH-file.txt", content_base64: Buffer.from("SECRETH-content").toString("base64") });
  await local(HUB, "POST", "/api/procs/herval-box-1/attachments", { key: "n", type: "note", data: { text: "SECRETH-note" } });
  await local(HUB, "POST", "/api/procs/herval-box-1/status", { state: "working", text: "SECRETH-doing" });
  const hpage = await local(HUB, "POST", "/api/procs/herval-box-1/pages", { title: "SECRETH-page", widgets: [{ id: "n", type: "note", data: { text: "SECRETH-widget" } }] });
  const htask = await herval.post("/api/tasks", { text: "SECRETH-task" });
  const hgh = await herval.post("/api/connectors", { kind: "github", api_key: HERVAL_GH, states: [] });
  const hws = await herval.post("/api/workspaces", { repo: "acme/secret", name: "SECRETH-ws" });
  const hconn = await herval.post("/api/connectors", { kind: "linear", name: "SECRETH-conn", api_key: "$LINEAR_API_KEY" });
  const hpulls = await until(async () => (await stateOf(herval.get)).workspaces?.find((w) => w.id === hws.id)?.pulls?.pulls?.length);
  check(hpage.id && htask.status === 200 && hgh.status === 200 && hws.status === 200 && hconn.status === 200 && hpulls, "herval has a post, a question, a file, a page, a task, his GitHub, a workspace showing a private repo's pull requests, and a connector using the hub's own Linear key");

  // ---------- alice's laptop ----------
  const aliceProject = path.join(BASE, "alice", "SECRETA-dir", "app");
  fs.mkdirSync(aliceProject, { recursive: true });
  const at = new Date().toISOString();
  const transcript = (file: string, plan: string, command: string) => {
    fs.writeFileSync(file, [
      { type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: plan, status: "in_progress", activeForm: plan }] } }] } },
      { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command, description: command } }] } },
    ].map((e) => JSON.stringify(e) + "\n").join(""));
    return file;
  };
  await local(A, "POST", "/api/hello", { proc: "alice-box-1", label: "kite", agent: "Claude", session_id: "a1", cwd: aliceProject, host: "SECRETA-host", transcript: transcript(path.join(BASE, "alice", "SECRETA-t1.jsonl"), "SECRETA-plan1", "cat SECRETA-step1") });
  await local(A, "POST", "/api/procs/alice-box-1/post", { title: "SECRETA-title1", text: "SECRETA-text1" });
  await local(A, "POST", "/api/procs/alice-box-1/messages", { from: "agent", text: "SECRETA-message1" });
  const aq = await local(A, "POST", "/api/procs/alice-box-1/questions", { title: "SECRETA-question", detail: "SECRETA-detail", options: ["Yes", "No"] });
  const af = await local(A, "POST", "/api/procs/alice-box-1/files", { name: "SECRETA-file.txt", content_base64: Buffer.from("SECRETA-content").toString("base64") });
  await local(A, "POST", "/api/procs/alice-box-1/attachments", { key: "n", type: "note", data: { text: "SECRETA-note" } });
  await local(A, "POST", "/api/procs/alice-box-1/updates", { text: "SECRETA-update" });
  await local(A, "POST", "/api/procs/alice-box-1/status", { state: "working", text: "SECRETA-doing1" });
  const atodo = await local(A, "POST", "/api/procs/alice-box-1/todos", { text: "SECRETA-todo for the release" });
  const apage = await local(A, "POST", "/api/procs/alice-box-1/pages", { title: "SECRETA-page", widgets: [{ id: "n", type: "note", data: { text: "SECRETA-widget" } }] });
  const apublicPage = await local(A, "POST", "/api/procs/alice-box-1/pages", { title: "PUBLICA-page", widgets: [{ id: "n", type: "note", data: { text: "PUBLICA-widget" } }] });
  // A post of hers she'll make public: whoever sees it sees its work too (its plan, steps and files), never where it runs.
  await local(A, "POST", "/api/hello", { proc: "alice-box-2", label: "lark", agent: "Claude", session_id: "a2", cwd: aliceProject, host: "SECRETA-host2", transcript: transcript(path.join(BASE, "alice", "SECRETA-t2.jsonl"), "PUBLICA-plan2", "cat PUBLICA-step2") });
  await local(A, "POST", "/api/procs/alice-box-2/post", { title: "PUBLICA-title2", text: "PUBLICA-text2" });
  await local(A, "POST", "/api/procs/alice-box-2/messages", { from: "agent", text: "the zebra crossing" });
  for (const t of ["one", "two", "three", "a quokka smiles"]) await local(A, "POST", "/api/procs/alice-box-2/messages", { from: "agent", text: t });
  await local(A, "POST", "/api/procs/alice-box-2/status", { state: "working", text: "SECRETA-doing2" });
  const af2 = await local(A, "POST", "/api/procs/alice-box-2/files", { name: "PUBLICA-file2.txt", content_base64: Buffer.from("PUBLICA-content2").toString("base64") });
  const aliceSeesHers = await until(async () => {
    const st = await stateOf(alice.get);
    const plan = st.sessions?.find((s) => s.id === "a2")?.plan;
    return st.sessions?.some((s) => s.id === "a1" && s.mine && s.machine === "laptop") && plan?.length && st.tasks?.some((t) => t.from === "a1") && st.pages?.some((p) => p.id === apage.id) ? st : null;
  });
  check(!!aliceSeesHers, "alice sees her laptop's posts, plans, pages, and the to-do its agent left her, on the hub");
  // What the hub calls her file and question: the laptop's own ids, unless the hub's machine has them already.
  const afId = (await alice.get("/api/sessions/a1")).files?.find((f) => f.name === "SECRETA-file.txt")?.id;
  const af2Id = (await alice.get("/api/sessions/a2")).files?.find((f) => f.name === "PUBLICA-file2.txt")?.id;
  const aqId = aliceSeesHers.questions.find((q) => q.title === "SECRETA-question")?.id;
  const a2public = await alice.post("/api/sessions/a2/visibility", { visibility: "public" });
  const pagePublic = await alice.post(`/api/pages/${encodeURIComponent(apublicPage.id)}/visibility`, { visibility: "public" });
  // A routine on her public page: whoever sees the page sees that it's there and how it went, never its prompt or
  // the folder it runs in.
  const aroutine = await local(A, "POST", `/api/procs/alice-box-1/pages/${encodeURIComponent(apublicPage.id)}/routines`, { name: "PUBLICA-routine", kind: "agent", prompt: "SECRETA-prompt", root: "/Users/alice/SECRETA-root", schedule: "manual" });
  const atask = await alice.post("/api/tasks", { text: "SECRETA-task" });
  const aws = await alice.post("/api/workspaces", { repo: "alice/SECRETA-repo", name: "SECRETA-ws" });
  const aconn = await alice.post("/api/connectors", { kind: "linear", name: "SECRETA-conn", api_key: ALICE_KEY });
  await alice.post("/api/pins", { post: "a2", pinned: true });
  // A message for her session, waiting in her laptop for its turn to end.
  const waitingMsg = await alice.post("/api/sessions/a1/messages", { text: "SECRETA-instruction" });
  check(a2public.status === 200 && pagePublic.status === 200 && atask.status === 200 && aws.status === 200 && aconn.status === 200 && waitingMsg.status === 200, "alice makes one post and one page public, and keeps a task, a workspace, a connector and a message for her session");
  await until(async () => (await stateOf(bob.get)).sessions?.some((s) => s.id === "a2"));

  // ---------- her laptop's posts' pull requests, read on the hub as her ----------
  await local(A, "POST", "/api/procs/alice-box-1/updates", { text: "SECRETA-opened", link: "https://github.com/alice/shop/pull/3" });
  const prOf = async () => Object.values<Json>((await stateOf(alice.get)).sessions?.find((s) => s.id === "a1")?.prs || {}).find((p) => p.number === 3);
  await until(prOf);
  await sleep(1000);
  check((await prOf()) && !(await prOf()).gh && !ghCalls().some((c) => c.as === "alice"), "a pull request her laptop's post links is a plain link while she hasn't connected GitHub: her laptop has no GitHub of its own");
  const agh = await alice.post("/api/connectors", { kind: "github", api_key: ALICE_GH, states: [] });
  const card = await until(async () => (await prOf())?.gh);
  check(agh.status === 200 && card?.state === "open" && card.mine && ghCalls().filter((c) => /alice\/shop|"alice"/.test(JSON.stringify(c.variables || c.repo))).every((c) => c.as === "alice"), "once she connects GitHub on the hub, the hub reads it for her laptop, as her, and the card shows where it stands");
  // Bob's machines, with their own tokens, naming alice's posts, pages and tasks: they reach only bob's own. (A
  // second machine of his sends the ops, so his laptop's own numbering stays its own.)
  const spareAsk = await ask("spare");
  await bob.post("/api/devices/approve", { code: spareAsk.code });
  const spareToken = (await poll(spareAsk)).token;
  const asSpare = (p: string, body: unknown) => fetch(HUB + p, { method: "POST", headers: { authorization: `Bearer ${spareToken}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const at2 = new Date().toISOString();
  const bobTries = [
    await asSpare("/api/cli/ops", { ops: [{ kind: "post.post", seq: 1, at: at2, args: { post: "a1", title: "SECRETB-took-it" } }, { kind: "question.answer", seq: 2, at: at2, args: { qid: aqId, value: "Yes" } }] }),
    await asSpare("/api/cli/results", { cid: "c1", result: { ok: true } }),
    await asBobsDevice("/api/cli/ask/tasks", { post: "a1" }),
    await asBobsDevice("/api/cli/ask/pages/read", { post: "a1", page: apage.id }),
    await asBobsDevice("/api/cli/ask/show", { post: "a1" }),
    await asBobsDevice("/api/cli/ask/context", { post: "a1", root: aliceProject }),
    await asBobsDevice("/api/cli/blobs/u1"),
    await fetch(HUB + "/api/cli/ask/tasks", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" }).then(async (r) => ({ status: r.status, text: await r.text() })),
  ];
  check(bobTries.every((r) => !/SECRETA|SECRETH/.test(r.text)) && bobTries.at(-1).status === 403 && bobTries[3].status === 404 && (await alice.get("/api/sessions/a1")).title === "SECRETA-title1", "bob's machine can't write to alice's posts, take her commands, answer for her, or read her tasks, pages or feed: its token reaches only bob's own");

  // ---------- bob's own machine ----------
  await local(B, "POST", "/api/hello", { proc: "bob-box-1", label: "tern", agent: "Claude", session_id: "b1", cwd: path.join(BASE, "bob") });
  await local(B, "POST", "/api/procs/bob-box-1/post", { title: "SECRETB-title" });
  await local(B, "POST", "/api/procs/bob-box-1/questions", { title: "SECRETB-question" });
  await until(async () => (await stateOf(bob.get)).sessions?.some((s) => s.id === "b1"));

  // ---------- everything there is to read, as each of them ----------
  const herState = await stateOf(alice.get);
  const hisState = await stateOf(herval.get);
  const ids = {
    posts: ["h1", "a1", "a2", "b1"],
    agents: ["claude", "laptop~claude", "laptop-bob~claude"],
    files: [hf.id, afId, af2Id],
    questions: [hq.id, aqId],
    pages: [hpage.id, apage.id, apublicPage.id],
    tasks: [htask.id, atask.id, atodo.id],
    workspaces: [hws.id, aws.id],
    connectors: [...new Set([...(await herval.get("/api/connectors")).connectors.map((c) => c.id), ...(await alice.get("/api/connectors")).connectors.map((c) => c.id)])],
    devices: [aliceDevice.device.id],
    routines: [aroutine.id || aroutine.routine?.id].filter(Boolean),
  };
  check(ids.routines.length === 1, `alice's agent put a routine on her public page (${JSON.stringify(aroutine).slice(0, 160)})`);
  const e = encodeURIComponent;
  const reads = [
    ...ids.routines.flatMap((r) => [`/api/routines/${e(r)}`, ...ids.pages.flatMap((p) => [`/api/pages/${e(p)}/routines`, `/api/pages/${e(p)}/routines/${e(r)}`])]),
    "/api/q/side", "/api/q/feed", "/api/q/feed?filter=archived", "/api/q/feed?filter=hidden", `/api/q/threads?ids=${ids.posts.map(e).join(",")}`, "/api/people", "/api/people/alice", "/api/people/herval", "/api/people/bob", "/api/devices", "/api/connectors",
    ...["SECRETA-title1", "SECRETH-title", "SECRETA-message1", "SECRETH-message", "zebra", "SECRETA-instruction"].map((q) => `/api/q/feed?q=${e(q)}`),
    ...ids.posts.flatMap((p) => [`/api/q/thread/${e(p)}`, `/api/sessions/${e(p)}`, `/api/sessions/${e(p)}/steps`, `/api/sessions/${e(p)}/changes`, `/api/sessions/${e(p)}/changes/file?path=x`, `/api/sessions/${e(p)}/images/t2/0`, `/api/sessions/${e(p)}/file?path=${e("~/.ssh/config")}`, `/api/sessions/${e(p)}/commits/abcdef1`, `/api/sessions/${e(p)}/steps/t2/diff`]),
    ...ids.agents.flatMap((a) => [`/api/agents/${e(a)}`, `/api/agents/${e(a)}/avatar`, `/api/agents/${e(a)}/routines`, `/api/agents/${e(a)}/skills/x`]),
    ...ids.files.map((f) => `/api/files/${e(f)}`),
    ...ids.pages.flatMap((p) => [`/api/pages/${e(p)}`, `/api/pages/${e(p)}/versions/1`]),
    ...ids.workspaces.flatMap((w) => [`/api/pulls?workspace=${w}&number=7`, `/api/pulls/diff?workspace=${w}&number=7&path=x`]),
    ...["laptop", "laptop-bob", "hub"].flatMap((m) => [`/api/folders?machine=${m}`, `/api/branches?machine=${m}&root=${e(aliceProject)}`, `/api/wip?machine=${m}&root=${e(aliceProject)}&branch=main`, `/api/runtimes?machine=${m}`, `/api/openclaw?machine=${m}`, `/api/invites?machine=${m}`, `/api/people?machine=${m}`, `/api/devices?machine=${m}`, `/api/connectors?machine=${m}`, `/api/q/side?machine=${m}`]),
    // What a machine's own sessions use, asked through the hub with a machine's prefix.
    "/api/show?proc=alice-box-1", "/api/show", `/api/questions/${e(aqId)}`, `/api/questions/${e(hq.id)}`, `/api/questions/${e(hq.id)}?wait=0`,
    ...["alice-box-1", "herval-box-1", "launch:l1"].flatMap((p) => [`/api/procs/${e(p)}/events?ack=1`, `/api/procs/${e(p)}/context`, `/api/procs/${e(p)}/tasks`, `/api/procs/${e(p)}/pages`, `/api/procs/${e(p)}/pages/${e(apage.id)}`]),
    "/api/health",
  ];
  async function readAll(who: string, viewer: Person, letter: string) {
    const found: string[] = [];
    for (const p of reads) {
      const r = await viewer.get(p, { timeout: 5000 });
      // What they asked for, said back to them (a folder that isn't a checkout), isn't anyone's to leak.
      for (const c of leaks(r.text, letter).filter((x) => !decodeURIComponent(p).includes(x))) found.push(`${p} → ${c}`);
    }
    // The live stream, watching the chrome and the feed, while alice's and herval's private posts change.
    const streamed = await new Promise<string>((resolve) => {
      let data = "";
      const live = `leaks-${who}-${Date.now()}`;
      const req = http.get({ host: "127.0.0.1", port: HUB_PORT, path: `/api/live?live=${live}`, headers: { host: `hub.example:${HUB_PORT}`, cookie: viewer.cookie } }, (res) => res.on("data", (d) => (data += d)));
      setTimeout(async () => {
        await viewer.get(`/api/q/side?live=${live}`);
        await viewer.get(`/api/q/feed?live=${live}`);
        await local(A, "POST", "/api/procs/alice-box-1/updates", { text: `SECRETA-live-${who}` });
        await local(A, "POST", "/api/procs/alice-box-2/updates", { text: `PUBLICA-live-${who}` });
        await local(HUB, "POST", "/api/procs/herval-box-1/updates", { text: `SECRETH-live-${who}` });
        await local(B, "POST", "/api/procs/bob-box-1/updates", { text: `SECRETB-live-${who}` });
        setTimeout(() => {
          req.destroy();
          resolve(data);
        }, 2500);
      }, 400);
    });
    for (const c of leaks(streamed, letter)) found.push(`/api/live → ${c}`);
    return { found, streamed };
  }
  const bobRead = await readAll("bob", bob, "B");
  check(!bobRead.found.length, `bob reads every route, and what the hub asks of the laptops for him, and finds nothing of alice's or herval's${bobRead.found.length ? `: ${bobRead.found.slice(0, 8).join("; ")}` : ""}`);
  check(bobRead.streamed.includes("PUBLICA-live-bob"), "while the live stream does bring him alice's public post");
  const bobRoutines = await bob.get(`/api/pages/${e(apublicPage.id)}/routines`);
  const shownR = bobRoutines.routines?.find((r) => r.name === "PUBLICA-routine");
  check(shownR && shownR.versions?.length === 1 && shownR.prompt === undefined && shownR.root === undefined && shownR.versions[0].prompt === undefined && shownR.versions[0].root === undefined && shownR.change === null, `bob sees that alice's public page has a routine, with its versions and runs, never its prompt or the folder it runs in (${JSON.stringify(shownR || bobRoutines).slice(0, 200)})`);
  const aliceRoutine = await alice.get(`/api/pages/${e(apublicPage.id)}/routines/${e(ids.routines[0])}`);
  check(aliceRoutine.prompt === "SECRETA-prompt" && aliceRoutine.versions?.[0]?.root === "/Users/alice/SECRETA-root", "alice, its owner, sees all of it");
  const aliceRead = await readAll("alice", alice, "A");
  check(!aliceRead.found.length, `alice finds nothing of herval's or bob's${aliceRead.found.length ? `: ${aliceRead.found.slice(0, 8).join("; ")}` : ""}`);
  const hervalRead = await readAll("herval", herval, "H");
  check(!hervalRead.found.length, `and herval, whose hub it is, nothing of alice's or bob's${hervalRead.found.length ? `: ${hervalRead.found.slice(0, 8).join("; ")}` : ""}`);

  // What he does see of alice's public post: the post, field by field.
  const bobState = await stateOf(bob.get);
  const hers = bobState.sessions.find((s) => s.id === "a2");
  const SHOWN = new Set(["id", "agent", "label", "title", "own_title", "ai_title", "text", "prompt", "started", "updated", "rev", "state", "effective", "busy", "ended", "end_reason", "asleep", "slept", "sleep_reason", "turn_started", "turn_ended", "archived", "archived_at", "visibility", "show_work", "repo", "branch", "cloud", "model", "stats", "context", "updates", "attachments", "prs", "messages", "last_messages", "machine", "offline", "pinned", "pinned_at", "mine", "owner", "public", "open_questions", "files", "last_files", "page", "questions", "names", "workspaces", "plan", "pictures", "last_pictures", "runs", "life"]);
  check(hers?.title === "PUBLICA-title2" && hers.owner === "alice" && hers.agent === null && Object.keys(hers).every((k) => SHOWN.has(k)) && hers.plan?.some((x) => /PUBLICA-plan2/.test(JSON.stringify(x))), "bob sees alice's public post as hers, with only the fields others see: its plan too, never where it runs");
  check(JSON.stringify(hers.questions) === "[]" && JSON.stringify(hers.workspaces) === "[]" && Object.values<Json>(hers.names || {}).every((n) => bobState.sessions.some((s) => s.id === n.id)), "its card's questions, workspaces and the threads its words name are only what he may see");
  // (His own groups, routines, notes and images for cloud machines are his, like his workspaces and tasks; `added`, what someone put him in, and
  // `dismissed`, what was taken off Needs you, `ui`, which code the page should be running, for
  // his bell.)
  const extra = Object.keys(bobState).filter((k) => !["status", "headers", "text", "seq", "machine", "added", "dismissed", "ui", "agents", "sessions", "pages", "notes", "questions", "launches", "folders", "cloning", "live", "machines", "workspaces", "tasks", "connectors", "images", "boxes", "github", "groups", "routines", "preview", "ws_running"].includes(k));
  check(!extra.length && bobState.questions.every((q) => q.post === "b1"), `and the page's state has nothing else: no drivers, no home folder, no questions but his own${extra.length ? ` (has ${extra.join(", ")})` : ""}`);
  check(!hers.pinned && herState.sessions.find((s) => s.id === "a2")?.pinned, "alice's pins are hers");
  check(bobState.machines.some((m) => m.name === "laptop") && !bobState.machines.find((m) => m.name === "laptop")?.home, "now alice has a public post, her laptop is in bob's list, without its home folder");
  check(bobState.pages.some((p) => p.id === apublicPage.id && p.by?.post === null && p.by?.agent === null && p.owner === "alice") && !bobState.pages.some((p) => p.id === apage.id), "alice's public page shows as hers, not which private post wrote it; her private page doesn't");
  const followedOn = (st: Json) => st.pages.find((p) => p.id === apublicPage.id)?.followed;
  check(followedOn(herState) === true && followedOn(bobState) === true, "on the hub, alice follows her laptop's pages from the start; bob, her contact, who follows her as a new contact does, her public one too");
  check((await bob.post("/api/follows", { page: apublicPage.id })).status === 200 && followedOn(await stateOf(bob.get)) === true && followedOn(await stateOf(alice.get)) === true && (await bob.post("/api/follows", { page: apage.id })).status === 404, "bob follows her public page for himself, on the hub, and can't follow her private one");

  // ---------- search words stay with the searcher ----------
  const herSearch = await alice.get("/api/q/feed?q=zebra");
  const hisSearch = await bob.get("/api/q/feed?q=zebra");
  const quokka = await bob.get("/api/q/feed?q=quokka");
  const herPrivate = await bob.get("/api/q/feed?q=SECRETA-message1");
  check(herSearch.list?.includes("thread:a2") && hisSearch.list?.includes("thread:a2") && quokka.list?.includes("thread:a2") && !herPrivate.list?.length, "searching looks through what the hub keeps, never a machine: alice and bob both find her public post's messages, and bob nothing of her private ones");

  // ---------- what bob tries to change ----------
  const raw = (p: string, text: string) => remote("POST", p, { cookie: bob.cookie, raw: text, headers: { "content-type": "text/plain" } });
  const tries: Record<string, Json> = {};
  for (const p of ids.posts.filter((x) => x !== "b1")) {
    for (const [what, body] of [["messages", { text: "SECRETB-hi" }], ["stop", {}], ["model", { model: "opus" }], ["visibility", { visibility: "public", show_work: true }], ["flag", { archived: true }], ["apply", {}]]) tries[`${what} ${p}`] = await bob.post(`/api/sessions/${e(p)}/${what}`, body);
    tries[`upload ${p}`] = await raw(`/api/upload?post=${e(p)}&name=x.txt`, "x");
    tries[`pin ${p}`] = p === "a2" ? { status: 404 } : await bob.post("/api/pins", { post: p, pinned: true });
  }
  for (const a of ["claude", "laptop~claude"]) {
    tries[`agent visibility ${a}`] = await bob.post(`/api/agents/${e(a)}/visibility`, { visibility: "public" });
    tries[`agent hidden ${a}`] = await bob.post(`/api/agents/${e(a)}/hidden`, { hidden: true });
    tries[`agent avatar ${a}`] = await bob.post(`/api/agents/${e(a)}/avatar`, { emoji: "🦉" });
    tries[`routine ${a}`] = await bob.post(`/api/agents/${e(a)}/routines/x`, { action: "run" });
  }
  for (const q of ids.questions) {
    tries[`answer ${q}`] = await bob.post(`/api/questions/${e(q)}/answer`, { value: "Yes" });
    tries[`answer file ${q}`] = await raw(`/api/upload?question=${e(q)}&name=x.txt`, "x");
  }
  for (const f of ids.files) tries[`delete ${f}`] = await bob.post(`/api/files/${e(f)}/delete`);
  for (const p of ids.pages) {
    tries[`page write ${p}`] = await bob.post(`/api/pages/${e(p)}/write`, { widgets: [{ id: "n", type: "note", data: { text: "SECRETB-defaced" } }] });
    tries[`page restore ${p}`] = await bob.post(`/api/pages/${e(p)}/restore`, { v: 1 });
    tries[`page visibility ${p}`] = await bob.post(`/api/pages/${e(p)}/visibility`, { visibility: "public" });
    tries[`page contributors ${p}`] = await bob.post(`/api/pages/${e(p)}/contributors`, { user: "bob" });
    tries[`page archive ${p}`] = await bob.post(`/api/pages/${e(p)}/archive`, { archived: true });
  }
  for (const t of ids.tasks) for (const [what, body] of [["", { text: "SECRETB-x" }], ["/done", {}], ["/move", {}], ["/delete", {}], ["/link", { post: "b1" }], ["/send", { launch: "l1" }], ["/restore", {}]]) tries[`task${what} ${t}`] = await bob.post(`/api/tasks/${t}${what}`, body);
  for (const w of ids.workspaces) for (const [what, body] of [["", { name: "SECRETB-mine" }], ["/delete", {}]]) tries[`workspace${what} ${w}`] = await bob.post(`/api/workspaces/${w}${what}`, body);
  for (const c of ids.connectors) {
    tries[`connector save ${c}`] = await bob.post("/api/connectors", { id: c, name: "SECRETB-mine" });
    tries[`connector sync ${c}`] = await bob.post(`/api/connectors/${e(c)}/sync`);
    tries[`connector delete ${c}`] = await bob.post(`/api/connectors/${e(c)}/delete`);
  }
  for (const d of ids.devices) tries[`revoke ${d}`] = await bob.post(`/api/devices/${d}/revoke`);
  Object.assign(tries, {
    "launch on alice's laptop": await bob.post("/api/launch", { prompt: "SECRETB-run", agent: "laptop~claude", machine: "laptop", root: aliceProject }),
    "launch on the hub": await bob.post("/api/launch", { prompt: "SECRETB-run", agent: "claude", root: hubProject }),
    "archive a start": await bob.post("/api/launches/l1/archive"),
    "cloud pull on the laptop": await bob.post("/api/cloud/pull", { ref: "session_01X", root: aliceProject, machine: "laptop" }),
    "wip clean": await bob.post("/api/wip/clean?machine=laptop", { root: aliceProject, branch: "main" }),
    "wip discard": await bob.post("/api/wip/discard?machine=laptop", { root: aliceProject, branch: "main" }),
    "openclaw": await bob.post("/api/openclaw?machine=laptop", { disconnect: true }),
    "session route": await bob.post("/api/procs/alice-box-1/messages", { text: "SECRETB-x" }),
    "hello": await bob.post("/api/hello", { proc: "x", label: "x" }),
    "env key connector": await bob.post("/api/connectors", { kind: "linear", name: "mine", api_key: "$LINEAR_API_KEY" }),
  });
  const landed = Object.entries(tries).filter(([, r]) => ![401, 403, 404, 409].includes(r.status));
  check(!landed.length, `bob's ${Object.keys(tries).length} tries at changing alice's and herval's things are all refused${landed.length ? `: ${landed.map(([k, r]) => `${k} → ${r.status}`).join("; ")}` : ""}`);
  const own = await bob.post("/api/workspaces", { repo: "acme/secret" });
  const pullsOff = await bob.get(`/api/pulls?workspace=${own.id}&number=7`);
  const bobWs = (await stateOf(bob.get)).workspaces.find((w) => w.id === own.id);
  check(own.status === 200 && bobWs && !("pulls" in bobWs) && pullsOff.status === 403 && /connect GitHub/.test(pullsOff.error) && (await stateOf(bob.get)).github === null && !leaks((await stateOf(bob.get)).text, "B").length, "bob's own workspace on the private repo shows no pull requests read with herval's GitHub: he'd connect his own");

  // Nothing of theirs changed.
  const after = await stateOf(alice.get);
  const a1 = after.sessions.find((s) => s.id === "a1");
  const theirs = await stateOf(herval.get);
  const h1 = theirs.sessions.find((s) => s.id === "h1");
  const unchanged = [
    a1?.title === "SECRETA-title1" && !a1.public && !a1.archived && !a1.model_pick,
    after.agents.find((x) => x.id === "laptop~claude")?.visibility === "private" && !after.agents.find((x) => x.id === "laptop~claude")?.hidden,
    after.questions.some((q) => q.id === aqId && !q.answered),
    (await alice.get(`/api/files/${e(afId)}`)).text === "SECRETA-content",
    after.tasks.find((t) => t.id === atask.id)?.text === "SECRETA-task" && !after.tasks.find((t) => t.id === atask.id).done && after.tasks.some((t) => t.id === atodo.id),
    after.workspaces.find((w) => w.id === aws.id)?.name === "SECRETA-ws",
    after.pages.find((p) => p.id === apage.id)?.version === 1 && !after.pages.find((p) => p.id === apage.id).archived,
    (await alice.get("/api/connectors")).connectors.some((c) => c.name === "SECRETA-conn"),
    (await alice.get("/api/devices")).devices.some((d) => d.id === aliceDevice.device.id),
    h1?.title === "SECRETH-title" && !h1.public && theirs.questions.some((q) => q.id === hq.id && !q.answered) && theirs.tasks.some((t) => t.id === htask.id && !t.done) && theirs.workspaces.some((w) => w.id === hws.id) && theirs.pages.some((p) => p.id === hpage.id && p.version === 1),
    !after.launches.some((l) => /SECRETB/.test(l.prompt)) && !theirs.launches.some((l) => /SECRETB/.test(l.prompt)) && !(fs.existsSync(path.join(common.FAKE_CLAUDE_DIR, "calls.jsonl")) && /SECRETB/.test(fs.readFileSync(path.join(common.FAKE_CLAUDE_DIR, "calls.jsonl"), "utf8"))),
  ];
  check(unchanged.every(Boolean), `and nothing of theirs changed (${unchanged.map((x, i) => (x ? null : i)).filter((x) => x !== null).join(", ") || "all as they were"})`);
  const stillWaiting = await local(A, "GET", "/api/procs/alice-box-1/events");
  check(stillWaiting.events?.some((x) => x.event?.text === "SECRETA-instruction"), "the message alice sent her session still waits for it, not taken by anyone else");

  // ---------- the hub's own Linear key, and other people's machines' names ----------
  check(tries["env key connector"].status === 403 && hconn.connector?.key_env === "$LINEAR_API_KEY", "a connector key from the hub's environment is herval's to use, not bob's");
  const db = sql(path.join(BASE, "hub", "storage.db"));
  const bobId = db.prepare("select id from users where username = 'bob'").get().id;
  let refusedTwice = false;
  try {
    db.prepare("insert into devices (id, user_id, name, token_hash, created) values (?, ?, ?, ?, ?)").run("d_twice", bobId, "laptop", crypto.randomBytes(16).toString("hex"), new Date().toISOString());
  } catch (err) {
    refusedTwice = /UNIQUE/i.test(err.message);
  }
  closeSql(path.join(BASE, "hub", "storage.db"));
  check(refusedTwice, "the hub's database keeps one connected machine per name");

  // ---------- a machine does only what its server may ask, checked ----------
  const answers = new Map();
  let served = false;
  fakeHub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/api/cli/hello")) return res.end(JSON.stringify({ cursor: 0, empty: false }));
      if (req.url.startsWith("/api/cli/ops")) return res.end(JSON.stringify({ acked: 0 }));
      if (req.url.startsWith("/api/cli/results")) {
        const r = JSON.parse(body);
        answers.set(r.cid, r.result);
        return res.end("{}");
      }
      if (req.url.startsWith("/api/cli/commands") && !served) {
        served = true;
        return res.end(JSON.stringify({
          commands: [
            { cid: "c-shell", kind: "shell.run", args: { command: "touch /tmp/agentbook-pwned" } },
            { cid: "c-extra", kind: "read.runtimes", args: { path: "/etc" } },
            { cid: "c-http", kind: "post.stop", method: "GET", path: "/api/procs/carol-box/events" },
            { cid: "c-runtimes", kind: "read.runtimes", args: {} },
          ],
        }));
      }
      setTimeout(() => res.end(JSON.stringify({ commands: [] })), 1000);
    });
  }).listen(FAKE_HUB_PORT, "127.0.0.1");
  running.push(serve({ ...common, AGENTBOOK_PORT: String(C_PORT), AGENTBOOK_HOME: path.join(BASE, "carol"), AGENTBOOK_MACHINE: "desk", AGENTBOOK_HUB: `http://127.0.0.1:${FAKE_HUB_PORT}`, AGENTBOOK_HUB_TOKEN: "t", AGENTBOOK_URL: C }));
  await healthy(C);
  await until(() => answers.size >= 4, 8000);
  const refusedAll = ["c-shell", "c-extra"].every((cid) => /refused it/.test(answers.get(cid)?.error || "")) && answers.get("c-http")?.status >= 400;
  check(refusedAll && answers.get("c-runtimes")?.runtimes?.some((r) => r.kind === "claude-code") && !fs.existsSync("/tmp/agentbook-pwned"), `a machine does what its server asks only when it's a kind it knows, with only the fields that kind takes (answers: ${[...answers].map(([k, v]) => `${k} ${v?.error ? "refused" : "ok"}`).join(", ")})`);
  check((await fetch(`${C}/api/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404 && (await fetch(`${C}/api/q/side`)).status === 404, "and it has no routes for the page: its server can't reach it but by commands");

  // ---------- the page ----------
  const page = await remote("GET", "/", {});
  const csp = page.headers["content-security-policy"] || "";
  check(/script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && page.headers["x-frame-options"] === "DENY", "the page runs only its own scripts, and no other site can frame it");

  // ---------- reconnecting a machine replaces it ----------
  const again = await ask("laptop");
  const preview = await alice.get(`/api/devices/request/${again.code}`);
  const replaced = await alice.post("/api/devices/approve", { code: again.code });
  const fresh = await poll(again);
  const oldToken = await fetch(`${HUB}/api/cli/ops`, { method: "POST", headers: { authorization: `Bearer ${aliceGot.token}`, "content-type": "application/json" }, body: JSON.stringify({ ops: [] }) });
  const newToken = await fetch(`${HUB}/api/cli/hello`, { method: "POST", headers: { authorization: `Bearer ${fresh.token}`, "content-type": "application/json" }, body: "{}" }).then((r): Promise<Json> => r.json());
  check(preview.name === "laptop" && preview.replaces.length === 1 && replaced.device?.replaced?.includes(aliceDevice.device.id) && oldToken.status === 403 && newToken.name === "laptop" && newToken.cursor > 0, "alice connecting her laptop again replaces it: the old token stops working, the new one is the same laptop, with what it had sent");
  check((await stateOf(alice.get)).sessions?.some((s) => s.id === "a1" && s.machine === "laptop" && s.mine), "and her posts stay hers, on the same laptop");
} catch (err) {
  failures++;
  console.error(err);
} finally {
  for (const p of running) p.kill();
  fakeHub?.close();
  linear.close?.();
  site.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
