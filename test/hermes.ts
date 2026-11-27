#!/usr/bin/env node
// Hermes on agentbook: its sessions come from its database (a state.db this test writes, with Hermes's
// tables), and a stand-in `hermes` (fake-hermes.ts) answers ACP and `hermes chat --resume`. Sessions are posts
// with their steps; you start them, write to them, allow what they ask, and stop them. The ones agentbook starts
// have its tools, over HTTP or through its bridge.
// Run: node test/hermes.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";
import type { McpServer, ToolResult } from "./fake-hermes.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-hermes-"));
const PORT = testPort(4500);
const URL = `http://127.0.0.1:${PORT}`;
const HERMES_HOME = path.join(HOME, "hermes");
const FAKE = path.join(HOME, "fake");
const project = path.join(HOME, "dev", "app");
for (const d of [HERMES_HOME, FAKE, project]) fs.mkdirSync(d, { recursive: true });
const realProject = fs.realpathSync(project);
fs.writeFileSync(path.join(FAKE, "http"), ""); // the fake takes MCP servers over HTTP, until the restart below
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_HERMES_BIN: path.join(TEST, "fake-hermes.ts"), HERMES_HOME, FAKE_HERMES_DIR: FAKE, AGENTBOOK_HERMES_SYNC_MS: "200", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_HERMES"]) delete env[k];

// Hermes's database: the tables and columns agentbook reads.
const db = new DatabaseSync(path.join(HERMES_HOME, "state.db"));
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, created_source TEXT, title TEXT, title_source TEXT, parent_session_id TEXT, end_reason TEXT,
    started_at REAL, ended_at REAL, last_activity_at REAL, last_activity_description TEXT, cwd TEXT, git_branch TEXT, model TEXT, model_config TEXT,
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT,
    timestamp REAL, finish_reason TEXT, reasoning TEXT, active INTEGER DEFAULT 1, display_kind TEXT, message_uid TEXT);
  CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, expires_at REAL);`);
const t0 = Date.now() / 1000;
// A session as Hermes keeps one, started `ago` seconds back.
const session = (id: string, source: string, title: string, ago: number, extra: { cwd?: string; parent?: string; end?: string; hidden?: number } = {}) => db.prepare("INSERT INTO sessions (id, source, title, started_at, last_activity_at, cwd, parent_session_id, end_reason, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, source, title, t0 - ago, t0 - ago + 60, extra.cwd ?? project, extra.parent ?? null, extra.end ?? null, extra.hidden ?? 0);
const msg = (sid: string, role: string, content: string, extra: { calls?: object[]; call?: string } = {}) => db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, timestamp, active) VALUES (?, ?, ?, ?, ?, ?, 1)").run(sid, role, content, extra.calls ? JSON.stringify(extra.calls) : null, extra.call ?? null, t0 - 100);
const CLI = "20261006_090000_aa";
session(CLI, "cli", "Fix the flaky login test", 3600);
msg(CLI, "user", "The login test flakes on CI");
msg(CLI, "assistant", "", { calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command":"npm test"}' } }] });
msg(CLI, "tool", "1 failing", { call: "call_1" });
msg(CLI, "assistant", "Fixed the race in login.spec.js.");
const TG = "20261006_080000_tg";
session(TG, "telegram", "Groceries", 7200, { cwd: "" });
msg(TG, "user", "Add milk to the list");
msg(TG, "assistant", "Added milk.");
session("20261006_070000_sub", "subagent", "a subagent's run", 3000);
msg("20261006_070000_sub", "user", "look into it");
// One the terminal session delegated to: its worker, with the tool it last called.
const SUB = "20261006_091000_dl";
session(SUB, "subagent", "Check the CI logs", 1800, { parent: CLI });
msg(SUB, "user", "Read the CI logs for the login test");
msg(SUB, "assistant", "", { calls: [{ id: "call_s1", type: "function", function: { name: "terminal", arguments: '{"command":"gh run view --log"}' } }] });
session("20261006_065000_hid", "cli", "hidden", 3000, { hidden: 1 });
msg("20261006_065000_hid", "user", "secret");
const LONG = "20261006_060000_p1";
session(LONG, "tui", "Long refactor", 5000, { end: "compression" });
msg(LONG, "user", "Refactor the auth module");
msg(LONG, "assistant", "Started on it.");
session("20261006_063000_p1c", "tui", "Long refactor", 4000, { parent: LONG });
msg("20261006_063000_p1c", "user", "keep going");
msg("20261006_063000_p1c", "assistant", "Refactored 12 files.");

// What the fake Hermes logged of each call: a command it ran (`cmd`), or an ACP request it was sent (`method`).
type Call = { cmd: string; method?: string; params?: { sessionId?: string; cwd?: string; mcpServers?: McpServer[] }; args?: string[]; cwd?: string; text?: string; sessionId?: string; outcome?: { outcome?: string; optionId?: string }; result?: ToolResult | null };
const calls = (): Call[] => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}) => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const state = () => stateOf(get);
const detail = (id: string) => get(`/api/sessions/${encodeURIComponent(id)}`);
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

let serverLog = "";
let server;
async function startServer() {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
try {
  await startServer();
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- its sessions ----------
  const first = await until(async () => {
    const s = await state();
    return s.sessions?.some((x) => x.id === CLI) && s.sessions.some((x) => x.id === LONG) && s;
  });
  const agent = first?.agents.find((a) => a.id === "hermes");
  check(agent?.kind === "hermes" && agent.runtime === "hermes" && agent.name === "Hermes", "Hermes is a profile");
  const cli = first?.sessions.find((x) => x.id === CLI);
  check(cli?.prompt === "The login test flakes on CI" && cli.title === "Fix the flaky login test" && cli.rt?.name === "Hermes" && cli.cwd === project, "a session from its terminal is a post, with its first message, title and folder");
  const steps = await get(`/api/sessions/${CLI}/steps`);
  check(steps.steps?.some((x) => x.kind === "tool" && x.title === "Run npm test" && x.done) && steps.steps.some((x) => x.kind === "say" && /Fixed the race/.test(x.text)), "its tool calls are steps, with what it said");
  check((await detail(CLI)).messages.length === 0, "what it said before agentbook saw it is history, not new messages");
  check(!first.sessions.some((x) => x.id.endsWith("_sub") || x.id.endsWith("_hid") || x.id.endsWith("_p1c")), "subagents' runs and hidden sessions stay off; a compressed conversation is one post");
  const longSteps = await get(`/api/sessions/${LONG}/steps`);
  check(longSteps.steps?.some((x) => x.kind === "say" && x.text === "Refactored 12 files."), "with what it did after it was compressed");
  const tg = first.sessions.find((x) => x.id === TG);
  check(tg && /Telegram/.test(tg.rt?.blocked || "") && (await post(`/api/sessions/${TG}/messages`, { text: "and eggs" })).status === 409, "a Telegram conversation shows, and takes replies on Telegram");

  // ---------- starting one ----------
  const launched = await post("/api/launch", { prompt: "Add a README", agent: "hermes", root: project });
  const made = await until(() => calls().find((c) => c.method === "session/new"));
  check(launched.status === 200 && made?.params.cwd === project, "posting on Hermes's wall starts an ACP session in the folder picked");
  const sid = await until(async () => (await state()).sessions.find((x) => x.agent === "hermes" && x.launch === launched.lid)?.id);
  const reply = await until(async () => (await detail(sid)).messages?.find((m) => m.from === "agent" && m.text === "Done: Add a README"));
  const asked = (await detail(sid)).messages.filter((m) => m.text === "Add a README");
  check(reply && asked.length === 1 && asked[0].from === "human" && !(await state()).launches.some((l) => l.id === launched.lid && !l.post), "its post takes the launch's place, with your message once and its reply");
  const given = made?.params.mcpServers?.[0];
  check(given?.type === "http" && given.name === "agentbook" && new globalThis.URL(given.url).searchParams.get("proc") === `launch:${launched.lid}`, "it has agentbook's tools, at their address, writing to the launch until its post exists");
  await post(`/api/sessions/${sid}/messages`, { text: "Headline: Write the README" });
  const titled = await until(async () => (await state()).sessions.find((x) => x.id === sid)?.title === "Write the README");
  check(titled && (await until(() => calls().find((c) => c.cmd === "tool")?.result?.content?.[0]?.text === "Thread updated.")), "and an ab_post it calls sets its thread's headline");

  // ---------- allowing what it asks ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Now delete the build folder" });
  const perm = await until(async () => (await state()).questions.find((q) => q.post === sid && q.kind === "permission" && !q.answered));
  check(perm?.preview === "rm -rf build", "what it asks to do is an Allow/Deny prompt on the post");
  await post(`/api/questions/${perm.id}/answer`, { value: "allow" });
  const allowed = await until(() => calls().find((c) => c.cmd === "permission"));
  const done = await until(async () => (await detail(sid)).messages?.find((m) => m.text === "Deleted the build folder."));
  check(allowed?.outcome?.optionId === "allow_once" && done, "allowing it lets it go ahead, once");

  // ---------- writing to a terminal session ----------
  await post(`/api/sessions/${CLI}/messages`, { text: "Run it again" });
  const resumed = await until(() => calls().find((c) => c.cmd === "chat"));
  check(resumed?.args.includes("--resume") && resumed.args.includes(CLI) && resumed.text === "Run it again" && resumed.cwd === realProject, "writing on a terminal session continues it with hermes chat --resume, in its folder");
  const again = await until(async () => (await detail(CLI)).messages?.find((m) => m.text === "Resumed: Run it again"));
  check(again?.from === "agent" && (await detail(CLI)).messages.filter((m) => m.text === "Run it again").length === 1, "its reply shows, and your message once");

  // ---------- working, and stopping ----------
  db.prepare("INSERT INTO session_turn_leases (conversation_id, holder, expires_at) VALUES (?, 'pid=1:tui', ?)").run(CLI, Date.now() / 1000 + 300);
  check(await until(async () => (await state()).sessions.find((x) => x.id === CLI)?.effective === "working"), "while Hermes holds its turn, the post is working");
  db.prepare("DELETE FROM session_turn_leases WHERE conversation_id = ?").run(CLI);
  check(await until(async () => (await state()).sessions.find((x) => x.id === CLI)?.effective !== "working"), "and then it isn't");
  // A subagent it delegated to that holds a turn lease of its own is a worker at work, which keeps its post working.
  db.prepare("INSERT INTO session_turn_leases (conversation_id, holder, expires_at) VALUES (?, 'pid=2:delegate', ?)").run(SUB, Date.now() / 1000 + 300);
  const delegated = await until(async () => {
    const d = await detail(CLI);
    return d.workers?.[0]?.state === "running" && d;
  });
  check(delegated?.workers.length === 1 && delegated.workers[0].title === "Check the CI logs" && /gh run view/.test(delegated.workers[0].step?.title) && delegated.effective === "working", "a subagent it delegated to shows on its post, with the tool it last called, and keeps the post working");
  const subSteps = await get(`/api/sessions/${encodeURIComponent(CLI)}/workers/${SUB}/steps`);
  check(delegated?.workers[0].n === 1 && subSteps.n === 1 && subSteps.steps?.length === 1 && /gh run view/.test(subSteps.steps[0].title) && !subSteps.steps[0].done, "opened on its post's page, its steps are read from its own messages");
  db.prepare("DELETE FROM session_turn_leases WHERE conversation_id = ?").run(SUB);
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'error' WHERE id = ?").run(Date.now() / 1000, SUB);
  const delegateFailed = await until(async () => {
    const d = await detail(CLI);
    return d.workers?.[0]?.state === "failed" && d;
  });
  check(delegateFailed && delegateFailed.effective !== "working" && !delegateFailed.workers[0].step && delegateFailed.workers[0].ended, "once it ends in an error, it failed, and the post isn't working on it");
  await post(`/api/sessions/${sid}/messages`, { text: "Take a slow look at the logs" });
  await until(async () => (await state()).sessions.find((x) => x.id === sid)?.effective === "working");
  const activeSetup = await post("/api/runtimes/configure", { kind: "hermes", provider: "openrouter", model: "vendor/model", key: "fixture-machine-provider-key" });
  check(activeSetup.status === 409 && /active threads/.test(activeSetup.error || ""), "provider setup waits for active Hermes threads instead of interrupting them");
  const stop = await post(`/api/sessions/${sid}/stop`);
  const cancelled = await until(() => calls().find((c) => c.method === "session/cancel"));
  check(stop.status === 200 && cancelled?.params.sessionId === sid && (await until(async () => (await state()).sessions.find((x) => x.id === sid)?.effective !== "working")), "Stop cancels its turn");

  fs.writeFileSync(path.join(FAKE, "config-hold"), "");
  const configured = post("/api/runtimes/configure", { kind: "hermes", provider: "openrouter", model: "vendor/model", key: "fixture-machine-provider-key" });
  await until(() => calls().some((c) => c.cmd === "config"));
  const duringSetup = await post("/api/launch", { prompt: "Start during setup", agent: "hermes", root: project });
  check(duringSetup.status === 409 && /provider setup/.test(duringSetup.error || ""), "a new thread waits until its provider setup has finished");
  await post(`/api/sessions/${sid}/messages`, { text: "Continue after provider setup" });
  check(!calls().some((c) => c.method === "session/prompt" && JSON.stringify(c.params).includes("Continue after provider setup")), "messages sent during provider setup stay queued");
  fs.rmSync(path.join(FAKE, "config-hold"));
  const savedProvider = await configured;
  check(savedProvider.status === 200 && savedProvider.provider.keySaved && !JSON.stringify(savedProvider).includes("fixture-machine-provider-key"), "provider setup saves its key on the machine and returns only its presence");
  check(await until(async () => (await detail(sid)).messages?.some((m) => m.text === "Done: Continue after provider setup")), "queued messages resume after the idle ACP server refreshes its provider");
  const initialized = calls().findLast((c) => c.method === "initialize") as Call & { providerKey?: boolean };
  check(initialized?.providerKey, "the refreshed Hermes process receives the configured provider key");
  const sanitized = await get("/api/runtimes");
  check(sanitized.runtimes.find((r) => r.kind === "hermes")?.provider?.model === "vendor/model" && !JSON.stringify(sanitized).includes("fixture-machine-provider-key"), "runtime setup reads include the selected provider and model without the key");
  const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []);
  const secretCopies = filesUnder(HOME).filter((f) => fs.readFileSync(f).includes(Buffer.from("fixture-machine-provider-key")));
  check(secretCopies.length === 1 && secretCopies[0] === path.join(HOME, "cli", "runtime-providers.json"), "the credential is absent from relay storage, audit logs, and runtime command logs");

  // ---------- after a restart ----------
  const before = (await detail(sid)).messages.length;
  server.kill();
  await sleep(500);
  fs.rmSync(path.join(FAKE, "http")); // a Hermes that takes MCP servers only as commands
  await startServer();
  await sleep(1500);
  const after = await detail(sid);
  check(after.messages?.length === before, `a restart doesn't post its messages again (${before} → ${after.messages?.length})`);
  const loadAt = calls().length;
  await post(`/api/sessions/${sid}/messages`, { text: "Rename: Ship the README" });
  const loaded = await until(() => calls().slice(loadAt).findLast((c) => c.method === "session/load" && c.params.sessionId === sid));
  const bridge = loaded?.params.mcpServers?.[0];
  const retitled = await until(async () => (await state()).sessions.find((x) => x.id === sid)?.title === "Ship the README");
  check(bridge?.name === "agentbook" && /http-bridge\.ts$/.test(bridge.args?.[0] || "") && new globalThis.URL(bridge.args[1]).searchParams.get("proc") === `hermes:${sid}` && retitled, "loaded again by a Hermes without HTTP ones, it gets them through agentbook's bridge, writing to its post");

  // ---------- with no folder picked ----------
  const noFolder = await post("/api/launch", { prompt: "Try this out", agent: "hermes" });
  const inTemp = await until(() => calls().find((c) => c.method === "session/new" && c.params.cwd !== project));
  check(noFolder.status === 200 && /\/agentbook-temp-[^/]+\/temp$/.test(inTemp?.params.cwd || ""), `with no folder picked, it starts in a temp folder (${inTemp?.params.cwd})`);
  if (inTemp) fs.rmSync(path.dirname(inTemp.params.cwd), { recursive: true, force: true });
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
}
if (failures) console.log(`\nserver log:\n${serverLog.slice(-3000)}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
