#!/usr/bin/env node
// Claude's and Codex's routines, end to end: a real agentbook server in a temp folder, a stand-in for claude.ai's
// routines API, a session's transcript with its loops (/loop) written the way Claude Code writes them, and the
// ChatGPT app's Codex automations as the app keeps them (a TOML file, its database, and threads in a stand-in
// for Codex's daemon).
// Run: node test/routines.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSignInSource } from "../plugin/cli/drivers/claude-routines.ts";
import { DatabaseSync } from "./harness-sql.ts";
import { loopName } from "../plugin/cli/transcript.ts";
import { ev, iso, startClaudeApi } from "./fake-claude-api.ts";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-routines-"));
const PORT = testPort(4500);
const URL = `http://127.0.0.1:${PORT}`;
const CODEX_HOME = path.join(HOME, "codex");
const CODEX_SOCK = path.join(HOME, "codex.sock");
const project = path.join(HOME, "dev", "site");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Whose sign-in agentbook may read (claude-routines.ts): Claude Code's only on a machine whose server is itself.
{
  const env = {};
  check(claudeSignInSource({ env }) === "claude" && claudeSignInSource({ env, hosted: true }) === null, "Claude Code's claude.ai sign-in is read on a machine whose server is itself, never on one logged in to a server elsewhere");
  check(claudeSignInSource({ env: { AGENTBOOK_CLAUDE_ROUTINES: "1" }, hosted: true }) === "claude" && claudeSignInSource({ env: { AGENTBOOK_CLAUDE_ROUTINES: "0" } }) === null, "AGENTBOOK_CLAUDE_ROUTINES=1 reads it anyway, =0 never");
  check(claudeSignInSource({ env: { AGENTBOOK_CLAUDE_TOKEN: "t" }, hosted: true }) === "token" && claudeSignInSource({ env: { AGENTBOOK_HOME: "/x" } }) === null, "a token of your own works anywhere; another data folder reads nothing");
  // agentbook-cli sets AGENTBOOK_HOME to the default folder since accounts (2026-11-20), which turned this off.
  const as = (home: string, more: NodeJS.ProcessEnv = {}) => claudeSignInSource({ env: { AGENTBOOK_HOME: home, ...more }, userHome: "/Users/me" });
  check(as("/Users/me/.agentbook") === "claude" && as("/Users/me/.agentbook/accounts/01a1fec9-78fd") === "claude", "the default data folder, or a login's in it, reads Claude Code's sign-in");
  check(as("/tmp/t/.agentbook") === null && as("/Users/me/.agentbook/accounts/a/b") === null && as("/Users/me/.agentbook-demo") === null && as("/Users/me/.agentbook", { CLAUDE_CONFIG_DIR: "/tmp/c" }) === null && claudeSignInSource({ env: { AGENTBOOK_HOME: "/Users/me/.agentbook" }, userHome: null }) === null, "a folder elsewhere, deeper in it, beside it, or another Claude Code folder reads nothing");
}
const until = async <T>(fn: () => T | Promise<T>, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const T0 = Date.now();

/* ---------- claude.ai's routines API, as /schedule finds it (test/fake-claude-api.ts) ---------- */

const triggers = [
  {
    id: "trig_digest",
    name: "PR digest",
    enabled: true,
    cron_expression: "CRON_TZ=America/Sao_Paulo 7 9 * * 1-5",
    next_run_at: iso(T0 + 3600e3),
    created_at: iso(T0 - 9 * 86400e3),
    last_fired_at: iso(T0 - 600e3),
    last_run: { fired_at: iso(T0 - 600e3), finished_at: iso(T0 - 540e3), session_id: "cse_run2", status: "ROUTINE_RUN_STATUS_SUCCEEDED", failure_reason: "ROUTINE_RUN_FAILURE_REASON_UNSPECIFIED" },
    derived_state: { prompt: "Summarize yesterday's merged PRs.", model: "claude-sonnet-5-5", folders: [] },
    job_config: { ccr: { session_context: { model: "claude-sonnet-5-5", sources: [{ git_repository: { url: "https://github.com/acme/site" } }] } } },
    session_request: { tags: [] },
  },
  {
    id: "trig_backup",
    name: "Back up my notes",
    enabled: false,
    cron_expression: "0 12 * * *",
    next_run_at: iso(T0 - 86400e3),
    created_at: iso(T0 - 30 * 86400e3),
    last_run: { fired_at: iso(T0 - 2 * 86400e3), finished_at: iso(T0 - 2 * 86400e3 + 60e3), session_id: "cse_old", status: "ROUTINE_RUN_STATUS_FAILED", failure_reason: "ROUTINE_RUN_FAILURE_REASON_REPO_ACCESS" },
    bound_device: { display_name: "Claude Desktop (macOS)" },
    derived_state: { prompt: "Copy my notes to the backup folder.", model: "", folders: ["/Users/me/Notes"] },
    session_request: { tags: ["cowork-remote", "cowork-scheduled"] },
  },
];
const runs = {
  trig_digest: [
    { id: "cse_run2", title: "PR digest", status: "active", worker_status: "idle", created_at: iso(T0 - 600e3), last_event_at: iso(T0 - 540e3), config: { origin: "scheduled_trigger", model: "claude-sonnet-5-5" } },
    { id: "cse_run1", title: "PR digest", status: "active", worker_status: "idle", created_at: iso(T0 - 86400e3), last_event_at: iso(T0 - 86400e3 + 30e3), config: { origin: "manual" } },
  ],
};
const events = {
  cse_run2: [
    ev(T0 - 600e3, { type: "user", message: { role: "user", content: "Summarize yesterday's merged PRs." } }),
    ev(T0 - 599e3, { type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
    ev(T0 - 598e3, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "gh pr list --state merged", description: "List merged pull requests" } }] } }),
    ev(T0 - 597e3, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "#12 Fix login" }] } }),
    ev(T0 - 596e3, { type: "assistant", message: { content: [{ type: "text", text: "One PR merged: #12 Fix login." }] } }),
    ev(T0 - 595e3, { type: "result", subtype: "success", is_error: false, result: "One PR merged: #12 Fix login.", duration_ms: 42000, num_turns: 2 }),
  ],
  cse_run1: [ev(T0 - 86400e3, { type: "result", subtype: "error_during_execution", is_error: true, result: "gh isn't signed in.", duration_ms: 9000 })],
};
const claudeApi = await startClaudeApi({ token: "test-token", triggers, runs, events });
const apiCalls = claudeApi.calls;
const API = claudeApi.url;

/* ---------- the ChatGPT app's Codex automations ---------- */

fs.mkdirSync(path.join(CODEX_HOME, "automations", "standup"), { recursive: true });
fs.writeFileSync(
  path.join(CODEX_HOME, "automations", "standup", "automation.toml"),
  `version = 1
id = "standup"
kind = "cron"
name = "Standup notes"
prompt = """
Write my standup notes
from yesterday's commits."""
status = "ACTIVE"
rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"
cwds = ["${project}"]
execution_environment = "worktree"
model = "gpt-6-astra"
created_at = ${T0 - 5 * 86400e3}
`,
);
fs.mkdirSync(path.join(CODEX_HOME, "sqlite"), { recursive: true });
{
  const db = new DatabaseSync(path.join(CODEX_HOME, "sqlite", "codex.db"));
  db.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT 'FREQ=HOURLY;INTERVAL=24;BYMINUTE=0', model TEXT, reasoning_effort TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, target_type TEXT, project_id TEXT, kind TEXT NOT NULL DEFAULT 'cron', target_thread_id TEXT, execution_environment TEXT);
    CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at INTEGER, thread_title TEXT, source_cwd TEXT, inbox_title TEXT, inbox_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  const add = db.prepare("INSERT INTO automations (id, name, prompt, status, next_run_at, last_run_at, cwds, rrule, created_at, updated_at, kind, target_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  add.run("standup", "Standup notes", "Write my standup notes", "ACTIVE", T0 + 7200e3, T0 - 86400e3, "[]", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", T0 - 5 * 86400e3, T0, "cron", null);
  add.run("watch-ci", "Watch CI", "Check CI and fix what broke", "ACTIVE", T0 + 1800e3, T0 - 1800e3, "[]", "FREQ=MINUTELY;INTERVAL=30", T0 - 86400e3, T0, "heartbeat", "th-watch");
  add.run("gone", "Old one", "x", "DELETED", null, null, "[]", "FREQ=DAILY", T0 - 86400e3, T0, "cron", null);
  const run = db.prepare("INSERT INTO automation_runs (thread_id, automation_id, status, read_at, thread_title, inbox_title, inbox_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  run.run("th-auto-1", "standup", "PENDING_REVIEW", null, "Standup notes", "Standup ready", "Three commits: the importer, the login fix, the docs.", T0 - 86400e3, T0 - 86400e3 + 50e3);
  run.run("pending:abc", "standup", "IN_PROGRESS", null, null, null, null, T0 - 10e3, T0 - 10e3);
  db.close();
}
const sec = (ms) => Math.floor(ms / 1000);
fs.writeFileSync(
  path.join(HOME, "codex-threads.json"),
  JSON.stringify([
    { id: "th-auto-1", name: "Standup notes", source: "appServer", threadSource: "automation", status: { type: "notLoaded" }, turns: [{ id: "a1", status: "completed", startedAt: sec(T0 - 86400e3), completedAt: sec(T0 - 86400e3 + 50e3), durationMs: 50000, items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "Automation: Standup notes" }] }, { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'git log --since=yesterday'", commandActions: [], status: "completed", exitCode: 0 }, { type: "agentMessage", id: "m1", text: "Three commits: the importer, the login fix, the docs." }] }] },
    { id: "th-watch", name: "Keep CI green", source: "cli", status: { type: "notLoaded" }, updatedAt: sec(T0 - 60e3), turns: [
      { id: "w1", status: "completed", startedAt: sec(T0 - 3600e3), completedAt: sec(T0 - 3590e3), durationMs: 10000, items: [{ type: "userMessage", id: "wu1", content: [{ type: "text", text: "Keep CI green" }] }, { type: "agentMessage", id: "wm1", text: "Watching it." }] },
      { id: "w2", status: "completed", startedAt: sec(T0 - 1800e3), completedAt: sec(T0 - 1790e3), durationMs: 10000, items: [{ type: "userMessage", id: "wu2", content: [{ type: "text", text: "<heartbeat><automation_id>watch-ci</automation_id><current_time_iso>now</current_time_iso><instructions>Check CI and fix what broke</instructions></heartbeat>" }] }, { type: "agentMessage", id: "wm2", text: "CI is green." }] },
    ] },
  ]),
);

/* ---------- agentbook ---------- */

const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_OPENCLAW: "0",
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  AGENTBOOK_SNAPSHOT_MS: "200",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"),
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CODEX_SOCK: CODEX_SOCK,
  AGENTBOOK_CODEX_SYNC_MS: "500",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  AGENTBOOK_CODEX_HOME: CODEX_HOME,
  AGENTBOOK_CLOUD_SYNC_MS: "60000",
  AGENTBOOK_CLAUDE_TOKEN: "test-token",
  AGENTBOOK_CLAUDE_API: API,
  CLAUDE_CODE_ORGANIZATION_UUID: "org-test",
};
delete env.AGENTBOOK_PLUGIN_DIR;
delete env.AGENTBOOK_CHANNEL;
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
let COOKIE = "";
const call = (u: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + u, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (u: string): Promise<Json> => (await call(u)).json();
const post = async (u, body) => {
  const r = await call(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf = {};
const runHook = (event, input, extra) => {
  if (input.session_id) sessionOf[extra?.AGENTBOOK_PID] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[extra?.AGENTBOOK_PID], ...input }), env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
};

const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), CODEX_SOCK, path.join(HOME, "codex.jsonl"), project], { stdio: "ignore", env: { ...process.env, FAKE_CODEX_THREADS: path.join(HOME, "codex-threads.json") } });
await until(() => fs.existsSync(CODEX_SOCK), 3000);
const server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
server.stdout.on("data", (d) => process.env.DEBUG && process.stdout.write(d));

try {
  check(await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok), "server starts");
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- a session's loops, from its transcript ----------
  const T = path.join(HOME, "kite.jsonl");
  const at = (ms) => iso(T0 + ms);
  const line = (ms, e) => JSON.stringify({ timestamp: at(ms), ...e }) + "\n";
  const use = (ms, id, name, input) => line(ms, { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
  const back = (ms, id, r, text = "ok") => line(ms, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] }, toolUseResult: r });
  // Claude Code notes each fire, then sends the prompt. A self-paced loop's wakeup says it's one.
  const fire = (ms, task, prompt, cron, wakeup = false) => line(ms, { type: "system", subtype: "scheduled_task_fire", content: wakeup ? "Claude resuming /loop wakeup (Oct 9 7:08pm)" : "Running scheduled task (Oct 9 7:43pm)", cron, cronKind: wakeup ? "loop" : null, prompt, taskId: task, taskKind: wakeup ? "loop" : null }) + line(ms + 10, { type: "user", isMeta: true, turnOrigin: "scheduled", scheduledTaskId: task, scheduledFireId: `f-${ms}`, promptSource: "system", message: { role: "user", content: prompt } });
  fs.writeFileSync(
    T,
    line(-60000, { type: "user", message: { content: "<command-name>/loop</command-name>\n<command-args>5m check the deploy</command-args>" } }) +
      use(-59000, "c1", "CronCreate", { cron: "*/5 * * * *", prompt: "check the deploy", recurring: true }) +
      back(-58900, "c1", { id: "aa11bb22", humanSchedule: "*/5 * * * *", recurring: true, durable: false }) +
      use(-58000, "c2", "CronCreate", { cron: "9 19 9 10 *", prompt: "remind me to push", recurring: false }) +
      back(-57900, "c2", { id: "cc33dd44", humanSchedule: "9 19 9 10 *", recurring: false, durable: false }) +
      use(-57000, "c3", "CronCreate", { cron: "0 * * * *", prompt: "tidy the branch", recurring: true }) +
      back(-56900, "c3", { id: "ee55ff66", humanSchedule: "0 * * * *", recurring: true, durable: false }) +
      fire(-30000, "aa11bb22", "check the deploy", "*/5 * * * *") +
      line(-29000, { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "The deploy is green." }] } }) +
      fire(-20000, "cc33dd44", "remind me to push", "9 19 9 10 *") +
      use(-15000, "c4", "CronDelete", { id: "ee55ff66" }) +
      back(-14900, "c4", { id: "ee55ff66" }, "Cancelled job ee55ff66.") +
      use(-10000, "w1", "ScheduleWakeup", { delaySeconds: 600, prompt: "/loop watch CI", reason: "CI is still running" }) +
      back(-9900, "w1", { scheduledFor: T0 + 590e3, clampedDelaySeconds: 600, wasClamped: false }) +
      fire(-5000, "zz99yy88", "check the old thing", "*/10 * * * *"),
  );
  const hook = runHook("SessionStart", { session_id: "sess-loop", cwd: project, source: "startup", transcript_path: T }, { AGENTBOOK_PID: "920001", AGENTBOOK_LABEL: "kite", CLAUDE_PROJECT_DIR: project });
  check(hook.status === 0, "a session with loops registers");
  const looped = await until(async () => {
    const s = (await state()).sessions.find((x) => x.id === "sess-loop");
    return s?.loops?.length >= 4 && s;
  });
  const byLoop = (id) => looped?.loops?.find((l) => l.loop === id);
  check(byLoop("aa11bb22")?.live && byLoop("aa11bb22").name === "check the deploy" && byLoop("aa11bb22").runs === 1 && byLoop("aa11bb22").next && byLoop("aa11bb22").expires && byLoop("aa11bb22").acts.join() === "run,stop", "a /loop on a cron is live on its post: its prompt, how often it ran, when next, when it expires");
  check(byLoop("cc33dd44") && !byLoop("cc33dd44").live && byLoop("ee55ff66")?.ended && !byLoop("ee55ff66").live, "a one-shot that fired is spent, and one CronDelete stopped has ended");
  check(byLoop("paced")?.live && byLoop("paced").name === "watch CI" && byLoop("paced").schedule.kind === "paced" && byLoop("paced").schedule.reason === "CI is still running" && byLoop("paced").next === iso(T0 + 590e3), "a self-paced /loop says when Claude will look again, and why");
  check(byLoop("paced")?.repeats === true && byLoop("aa11bb22")?.repeats === true && byLoop("cc33dd44")?.repeats === false, "a /loop and a recurring cron repeat; a one-shot doesn't");
  const detail = await get("/api/sessions/sess-loop");
  check(detail.loops?.length === looped?.loops?.length && detail.loops.find((l) => l.loop === "aa11bb22")?.runs === 1 && detail.loops.every((l) => typeof l.runs === "number"), "its own page has the same loops, not the transcript's records (it said \"Ran [object Object] times\")");
  // A wakeup Claude set itself, with no /loop: a check, once.
  const TC = path.join(HOME, "raven.jsonl");
  fs.writeFileSync(
    TC,
    line(-20000, { type: "user", message: { content: "does the landing page see the latest version?" } }) +
      use(-10000, "w2", "ScheduleWakeup", { delaySeconds: 1800, prompt: "Check that the landing page shows the new version. Report on the thread either way.", reason: "Its cached copy expires in about 20 minutes" }) +
      back(-9900, "w2", { scheduledFor: T0 + 1790e3, clampedDelaySeconds: 1800, wasClamped: false }),
  );
  check(runHook("SessionStart", { session_id: "sess-check", cwd: project, source: "startup", transcript_path: TC }, { AGENTBOOK_PID: "920002", AGENTBOOK_LABEL: "raven", CLAUDE_PROJECT_DIR: project }).status === 0, "a session that set itself a check registers");
  const checked = await until(async () => (await state()).sessions.find((x) => x.id === "sess-check")?.loops?.[0]);
  check(checked?.live && checked.repeats === false && checked.name === "Check that the landing page shows the new version" && checked.schedule.reason === "Its cached copy expires in about 20 minutes", "a wakeup Claude set itself, without /loop, is a check: it doesn't repeat");
  // It ends, so Claude's profile below counts kite's loops only.
  runHook("SessionEnd", { session_id: "sess-check", reason: "other" }, { AGENTBOOK_PID: "920002", AGENTBOOK_LABEL: "raven", CLAUDE_PROJECT_DIR: project });
  await until(async () => (await state()).sessions.find((x) => x.id === "sess-check")?.state === "done");
  const long = "Daily open-PR check for herval/littleguys (this agentbook post is the report). 1. Run: gh pr list --json number,title,author,updatedAt,isDraft,mergeable 2. Compare with yesterday's snapshot.";
  check(loopName(long) === "Daily open-PR check for herval/littleguys (this agentbook post is the report)" && loopName("1. Run the tests 2. Fix them") === "1. Run the tests 2. Fix them" && loopName(`Run ${"gh pr list ".repeat(12)}`).length <= 80, "a long loop is called by its prompt's first sentence, cut at a word past 80 characters");
  check(byLoop("zz99yy88")?.live && byLoop("zz99yy88").runs === 1 && byLoop("zz99yy88").schedule.expr === "*/10 * * * *", "a loop scheduled before what agentbook read is known from its fire");
  const steps = await get("/api/sessions/sess-loop/steps");
  check(steps.steps?.some((x) => x.title === "Loop: “check the deploy” (*/5 * * * *)") && steps.steps.some((x) => x.title === "Check back in 10m: CI is still running") && steps.steps.some((x) => /^Stop the loop/.test(x.title)), "its loop tools are steps, in words");
  const said = steps.steps?.find((x) => x.kind === "say" && x.text === "The deploy is green.");
  const scheduledLoop = steps.steps?.find((x) => x.title === "Loop: “check the deploy” (*/5 * * * *)");
  check(said && scheduledLoop && said.turn > scheduledLoop.turn, "a fired loop starts a turn of its own");

  // ---------- Claude's routines on claude.ai ----------
  const withRoutines = await until(async () => {
    const s = await state();
    return s.agents.find((a) => a.id === "claude")?.routines?.n === 5 && s;
  });
  const cr = withRoutines?.agents?.find((a) => a.id === "claude")?.routines;
  check(cr?.n === 5 && cr.loops === 3 && cr.paused === 1 && cr.error === null, "Claude's profile knows its routines: two on claude.ai (one paused) and the three loops its posts run");
  check(apiCalls.some((c) => c.path === "/v1/code/triggers" && c.auth === "Bearer test-token" && c.beta === "ccr-triggers-2026-01-30"), "they're read from claude.ai's routines API, signed in, with its beta header");
  const list = await get("/api/agents/claude/routines");
  const digest = list.routines?.find((r) => r.id === "trig_digest");
  const backup = list.routines?.find((r) => r.id === "trig_backup");
  check(digest?.group === "cloud" && digest.name === "PR digest" && digest.what === "Summarize yesterday's merged PRs." && digest.schedule?.expr === "7 9 * * 1-5" && digest.schedule.tz === "America/Sao_Paulo" && digest.status === "ok" && digest.took === 60000 && digest.place.repos[0] === "acme/site" && digest.url === "https://claude.ai/code/routines/trig_digest", "a routine: what it's told, when it runs, how its last run went, its repo, its page on claude.ai");
  check(backup && !backup.enabled && backup.next === null && backup.schedule.tz === "UTC" && backup.status === "error" && backup.error === "repo access" && backup.place.cowork && backup.place.device === "Claude Desktop (macOS)", "a paused Claude app routine, its UTC schedule, and why its last run failed");
  check(list.routines?.filter((r) => r.group === "loop").length === 3 && list.routines.every((r) => r.group !== "loop" || r.post === "sess-loop"), "and the live loops, each with its post");

  const one = await get("/api/agents/claude/routines/trig_digest");
  check(one.routine?.id === "trig_digest" && one.runs?.length === 1 && one.more && one.runs[0].session === "cse_run2" && one.runs[0].status === "ok" && one.runs[0].summary === "One PR merged: #12 Fix login." && one.runs[0].took === 42000 && one.runs[0].url === "https://claude.ai/code/session_run2", "a routine's runs, newest first: how each went and what it said, from its last event");
  const older = await get("/api/agents/claude/routines/trig_digest?offset=1");
  check(older.runs?.length === 1 && older.runs[0].id === "cse_run1" && older.runs[0].status === "error" && older.runs[0].error === "gh isn't signed in." && older.runs[0].manual && apiCalls.some((c) => c.query.cursor === "1"), "older runs come a page at a time, and a run by hand says so");
  const run = await get("/api/agents/claude/routines/trig_digest/run?session=cse_run2");
  check(run.steps?.some((x) => x.kind === "tool" && x.title === "List merged pull requests" && x.done) && run.reply?.text === "One PR merged: #12 Fix login." && run.model === "claude-sonnet-5-5" && run.url === "https://claude.ai/code/session_run2", "a run opens to the steps it took and its reply");
  const stranger = await call("/api/agents/claude/routines/trig_digest/run?session=../../v1/code/triggers");
  check(stranger.status === 404, "but only a run's own session");

  const ran = await post("/api/agents/claude/routines/trig_digest", { action: "run" });
  check(ran.status === 200 && apiCalls.some((c) => c.method === "POST" && c.path === "/v1/code/triggers/trig_digest/run"), "Run now runs it on claude.ai");
  const paused = await post("/api/agents/claude/routines/trig_digest", { action: "pause" });
  check(paused.status === 200 && apiCalls.some((c) => c.method === "POST" && c.path === "/v1/code/triggers/trig_digest" && c.body?.enabled === false), "Pause pauses it");
  check(await until(async () => (await state()).agents.find((a) => a.id === "claude")?.routines?.paused === 2), "and the profile says so");
  await post("/api/agents/claude/routines/trig_digest", { action: "resume" });
  check(apiCalls.some((c) => c.path === "/v1/code/triggers/trig_digest" && c.body?.enabled === true), "Resume resumes it");

  // A loop's Run now and Stop are messages to its post.
  const loopId = byLoop("aa11bb22")?.id;
  const loopRun = await post(`/api/agents/claude/routines/${encodeURIComponent(loopId)}`, { action: "run" });
  const loopStop = await post(`/api/agents/claude/routines/${encodeURIComponent(loopId)}`, { action: "stop" });
  const msgs = (await get("/api/sessions/sess-loop")).messages || [];
  check(loopRun.status === 200 && loopStop.status === 200 && msgs.some((m) => m.from === "human" && m.text === "check the deploy") && msgs.some((m) => m.from === "human" && m.text === "Stop the loop “check the deploy” (scheduled task aa11bb22)."), "a loop's Run now sends the post its prompt, and Stop asks it to stop the loop");
  const spent = await post(`/api/agents/claude/routines/${encodeURIComponent(byLoop("cc33dd44")?.id)}`, { action: "run" });
  check(spent.status === 409, "a loop that's over can't run");
  const loopPage = await get(`/api/agents/claude/routines/${encodeURIComponent(loopId)}`);
  check(loopPage.routine?.post === "sess-loop" && loopPage.runs?.length === 1 && loopPage.runs[0].post === "sess-loop", "a loop's page lists its runs, each in its post");

  // ---------- Codex's automations ----------
  const codexR = await until(async () => (await state()).agents.find((a) => a.id === "codex")?.routines);
  check(codexR?.n === 2 && codexR.loops === 1 && codexR.running === 1, "Codex's profile knows its automations: one on a schedule (running now), one heartbeat; deleted ones left out");
  const cl = await get("/api/agents/codex/routines");
  const standup = cl.routines?.find((r) => r.id === "standup");
  const watch = cl.routines?.find((r) => r.id === "watch-ci");
  check(standup?.what === "Write my standup notes\nfrom yesterday's commits." && standup.schedule?.rule === "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" && standup.next === iso(T0 + 7200e3) && standup.place.worktree && standup.place.cwds[0] === project && standup.url === "codex://automations/standup?automationSource=local", "an automation, from its file: its prompt, rule and folders, and when it runs next from the app's database");
  check(watch?.group === "loop" && watch.thread === "th-watch" && watch.url.endsWith("automationSource=cloud"), "a heartbeat is a loop, in its thread");
  const sr = await get("/api/agents/codex/routines/standup");
  check(sr.runs?.length === 2 && sr.runs[0].status === "running" && !sr.runs[0].session && sr.runs[1].session === "th-auto-1" && sr.runs[1].summary === "Three commits: the importer, the login fix, the docs." && sr.runs[1].unread && sr.total === 2, "an automation's runs: what each reported, and one still running");
  const srun = await get("/api/agents/codex/routines/standup/run?session=th-auto-1");
  check(srun.steps?.some((x) => x.kind === "tool" && /git log/.test(x.title)) && srun.reply?.text === "Three commits: the importer, the login fix, the docs.", "a run opens to its thread's steps and reply");
  const notRun = await call("/api/agents/codex/routines/standup/run?session=th-watch");
  check(notRun.status === 404, "but not a thread that isn't one of its runs");
  check(!(await state()).sessions.some((x) => x.id === "th-auto-1"), "an automation's threads stay off the feed");
  const watchPost = await until(async () => (await state()).sessions.find((x) => x.id === "th-watch"));
  check(watchPost?.loops?.[0]?.id === "watch-ci" && watchPost.loops[0].live, "a heartbeat shows on its thread's post");
  const wr = await get("/api/agents/codex/routines/watch-ci");
  check(wr.routine?.post === "th-watch" && wr.runs?.length === 1 && wr.runs[0].summary === "CI is green." && wr.runs[0].post === "th-watch", "a heartbeat's runs are its turns in that thread");
  const codexRun = await post("/api/agents/codex/routines/standup", { action: "run" });
  check(codexRun.status === 409 && /ChatGPT app/.test(codexRun.error), "Run now on a Codex automation says it's done in the app");
} finally {
  server.kill();
  fakeCodex.kill();
  claudeApi.close();
}
await sleep(200);
if (failures) {
  console.log(`\n${failures} failed (data in ${HOME})`);
  process.exit(1);
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log("\nAll passed");
