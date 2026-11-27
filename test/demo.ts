#!/usr/bin/env node
// A demo agentbook with made-up sessions, on its own port and data folder, so you can see the UI without
// running any agents. Run: node test/demo.ts   then open http://127.0.0.1:4321

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffTexts } from "../plugin/cli/changes.ts";
import { type PullSpec, diffOf, pull } from "./fake-gh-pulls.ts";
import { issue, startLinear } from "./fake-linear.ts";
import { startGitHub } from "./fake-github.ts";
import { ev, iso, startClaudeApi } from "./fake-claude-api.ts";
import { DatabaseSync } from "./harness-sql.ts";
import { startFakeMcp } from "./fake-mcp.ts";
import { poolPort, spawnAgentbook, spawnTied } from "./harness.ts";
import { banner, board, phone } from "./demo-shots.ts";
import { stateOf } from "./harness-state.ts";
import type { CronRun, OcSession } from "./fake-openclaw-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const PORT = process.env.DEMO_PORT || 4321;
const URL = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-demo-"));
const DEV = path.join(HOME, "dev");
const TEST = path.dirname(fileURLToPath(import.meta.url));

// Stand-ins for Claude Code's supervisor and Codex's daemon: which demo sessions run in the background,
// and two Codex threads.
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE, { recursive: true });
const sid = (label: string, proc: string) => `${label}-0000-4000-8000-${proc}`;
const bg = (label: string, proc: string, extra?: object) => ({ id: sid(label, proc).slice(0, 8), sessionId: sid(label, proc), kind: "background", state: "working", status: "busy", pid: 5000 + label.length, cwd: DEV, ...extra });
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([bg("quail", "demo-quail"), bg("osprey", "demo-osprey", { state: "blocked", status: "waiting", waitingFor: "permission prompt" }), bg("heron", "demo-heron", { state: "done", status: "idle" }), { ...bg("finch", "demo-finch"), kind: "interactive" }]));
fs.mkdirSync(path.join(DEV, "platform"), { recursive: true });
// Your Claude Code settings: the model and effort a new post starts on.
fs.mkdirSync(path.join(HOME, "claude"), { recursive: true });
fs.writeFileSync(path.join(HOME, "claude", "settings.json"), JSON.stringify({ model: "opus", effortLevel: "high", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } } }));
const CODEX_SOCK = path.join(HOME, "codex.sock");
// Codex's routines: two automations the ChatGPT app keeps (test/fake-codex.ts has their threads), a standup on a
// schedule and a heartbeat that keeps the login fix green, in a Codex folder of the demo's own.
const CODEX_HOME = path.join(HOME, "codex");
{
  const NOW = Date.now();
  const S = (ms) => Math.floor(ms / 1000);
  fs.mkdirSync(path.join(CODEX_HOME, "automations", "standup"), { recursive: true });
  fs.writeFileSync(path.join(CODEX_HOME, "automations", "standup", "automation.toml"), `version = 1\nid = "standup"\nkind = "cron"\nname = "Standup notes"\nprompt = """\nWrite my standup notes from yesterday's commits in platform: what landed, what's in review, what's stuck.\nThree bullets, no more."""\nstatus = "ACTIVE"\nrrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"\ncwds = ["${path.join(DEV, "platform")}"]\nexecution_environment = "worktree"\nmodel = "gpt-6-astra"\ncreated_at = ${NOW - 12 * 86400e3}\n`);
  fs.mkdirSync(path.join(CODEX_HOME, "sqlite"), { recursive: true });
  const db = new DatabaseSync(path.join(CODEX_HOME, "sqlite", "codex.db"));
  db.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL, model TEXT, reasoning_effort TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'cron', target_thread_id TEXT, execution_environment TEXT);
    CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at INTEGER, thread_title TEXT, source_cwd TEXT, inbox_title TEXT, inbox_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  const tomorrow9 = new Date(NOW + 86400e3);
  tomorrow9.setHours(9, 0, 0, 0);
  db.prepare("INSERT INTO automations (id, name, prompt, status, next_run_at, last_run_at, rrule, model, created_at, updated_at, kind, target_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("standup", "Standup notes", "Write my standup notes", "ACTIVE", tomorrow9.getTime(), NOW - 5 * 3600e3, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", "gpt-6-astra", NOW - 12 * 86400e3, NOW, "cron", null);
  db.prepare("INSERT INTO automations (id, name, prompt, status, next_run_at, last_run_at, rrule, model, reasoning_effort, created_at, updated_at, kind, target_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("login-green", "Keep the login fix green", "Run the auth tests. If one fails, fix it and say what broke.", "ACTIVE", NOW + 1100e3, NOW - 700e3, "FREQ=MINUTELY;INTERVAL=30", "gpt-6-astra", "medium", NOW - 2 * 86400e3, NOW, "heartbeat", "th-live");
  const run = db.prepare("INSERT INTO automation_runs (thread_id, automation_id, status, read_at, thread_title, inbox_title, inbox_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  run.run("th-standup-2", "standup", "PENDING_REVIEW", null, "Standup notes", "Standup ready", "Landed: the runner packing (#16702). In review: dead tests out of core-api (#16613). Stuck: the PSC endpoint, waiting on infra.", NOW - 5 * 3600e3, NOW - 5 * 3600e3 + 48e3);
  run.run("th-standup-1", "standup", "ACCEPTED", NOW - 26 * 3600e3, "Standup notes", "Standup ready", "Landed: BigQuery cleanup (#16588). In review: runner packing (#16702). Nothing stuck.", NOW - 29 * 3600e3, NOW - 29 * 3600e3 + 52e3);
  db.close();
  const turn = (id, ago, items, took = 40) => ({ id, status: "completed", startedAt: S(NOW - ago * 1000), completedAt: S(NOW - (ago - took) * 1000), durationMs: took * 1000, items });
  const user = (id, text) => ({ type: "userMessage", id, content: [{ type: "text", text }] });
  const said = (id, text) => ({ type: "agentMessage", id, text });
  const ran = (id, cmd) => ({ type: "commandExecution", id, command: `/bin/zsh -lc '${cmd}'`, commandActions: [], status: "completed", exitCode: 0 });
  const beat = (id) => user(id, "<heartbeat><automation_id>login-green</automation_id><current_time_iso>now</current_time_iso><instructions>Run the auth tests. If one fails, fix it and say what broke.</instructions></heartbeat>");
  fs.writeFileSync(path.join(HOME, "codex-threads.json"), JSON.stringify([
    { id: "th-standup-2", name: "Standup notes", source: "appServer", threadSource: "automation", status: { type: "notLoaded" }, turns: [turn("s2", 5 * 3600, [user("s2u", "Automation: Standup notes"), ran("s2c", "git log --since=yesterday --oneline"), ran("s2p", "gh pr list --author @me"), said("s2m", "- **Landed:** the runner packing (#16702).\n- **In review:** dead tests out of core-api (#16613), changes asked.\n- **Stuck:** the PSC endpoint (#16690), waiting on infra's review.")], 48)] },
    { id: "th-standup-1", name: "Standup notes", source: "appServer", threadSource: "automation", status: { type: "notLoaded" }, turns: [turn("s1", 29 * 3600, [user("s1u", "Automation: Standup notes"), ran("s1c", "git log --since=yesterday --oneline"), said("s1m", "- **Landed:** BigQuery cleanup (#16588).\n- **In review:** runner packing (#16702).\n- Nothing stuck.")], 52)] },
    { id: "th-live", name: "Fix the login bug", source: "vscode", status: { type: "idle" }, createdAt: S(NOW - 3 * 86400e3), updatedAt: S(NOW - 30e3), turns: [
      turn("l1", 2 * 86400, [user("l1u", "The login form loses the redirect after a failed attempt. Fix it."), said("l1m", "Fixed: the redirect now survives a failed attempt. Added a test.")], 600),
      turn("l2", 2500, [beat("l2u"), ran("l2c", "npm test -- auth"), said("l2m", "All 41 auth tests pass.")]),
      turn("l3", 700, [beat("l3u"), ran("l3c", "npm test -- auth"), said("l3m", "One failed: the session cookie test expected the old SameSite value. Updated the test to Lax, which the fix sets on purpose. 41 of 41 pass.")], 90),
    ] },
  ]));
}
const codexDaemon = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), CODEX_SOCK, "", path.join(DEV, "platform")], { stdio: "ignore", env: { ...process.env, FAKE_CODEX_THREADS: path.join(HOME, "codex-threads.json") } });
for (let i = 0; i < 30 && !fs.existsSync(CODEX_SOCK); i++) await new Promise((r) => setTimeout(r, 100));

// platform shows its pull requests as its WIP: made up, from a stand-in GitHub (test/fake-github.ts), not GitHub.
const MONO = "Acme-AI/platform";
// prod's latest commit, and the ones its pull requests left it at, for the WIP timeline
const TIP: PullSpec["tip"] = ["fix(billing): round tax per line, not per invoice", 900];
const DEPS: PullSpec["fork"] = ["chore(deps): bump fastapi to 0.118", 5 * 3600, 4];
const GH_FILE = path.join(HOME, "gh.json");
fs.writeFileSync(
  GH_FILE,
  JSON.stringify({
    // The token the demo's GitHub connector signs in with (Connectors), as herval.
    tokens: { github_pat_demo: { login: "herval", name: "Herval" } },
    repos: {
      [MONO]: {
        // What's herval's to do there, which the GitHub connector brings into Tasks.
        issues: [{ id: "I_demo812", number: 812, title: "Flaky e2e on the checkout flow", assignees: ["herval"], updatedAt: new Date(Date.now() - 5400e3).toISOString() }],
        pulls: [
          pull({ repo: MONO, number: 16720, title: "fix(erp): retry the session sync on 502s", head: "erp-retry", base: "prod", tip: TIP, author: "maria", requested: ["herval"], opened: 5400, updated: 900, files: [["erp/sync.py", 18, 4]] }),
          pull({ repo: MONO, number: 16613, title: "chore(core-api): remove code with no caller and tests no job runs", head: "daring-swan", base: "prod", tip: TIP, fork: ["feat(orders): split shipments by warehouse", 30 * 3600, 17], opened: 3600, updated: 420, review: "CHANGES_REQUESTED", mergeState: "BLOCKED", body: "## What\n\nRemoves 4,213 lines: code nothing calls, and the tests that only covered it.\n\n- `core-api/legacy/` goes\n- the scenario files no job runs go\n\n<!-- herald:tracking -->\n## How to check\n\nThe suite still runs the same 1,904 tests.", checks: [["Secret Scan", "pass", { required: true }], ["unit (core-api)", "fail", { required: true, workflow: "Core API CI" }], ["lint", "pass"], ["Detect changed stacks", "pass", { workflow: "IaC PR" }], ["e2e (audio)", "skip"], ["e2e (llm)", "skip"], ["Typecheck", "pass"]], comments: [["acme-bot", "🦆 Herald is tracking this pull request in Slack.", 3500], ["github-actions", "<!-- coverage -->**Coverage**: 81.2% (−0.1%)", 3300], ["joe", "Does erp-sync still install `core-api[legacy]`? If so this breaks its image build.", 1200]], reviews: [["maria", "CHANGES_REQUESTED", "Two of these are still imported by the eval scripts. Keep those, or move them.", 1500]], threads: [{ path: "core-api/legacy/scoring.py", line: 88, hunk: ["-def score(session):", "-    weights = load_weights()", "-    return legacy.score_v1(session, weights)"], comments: [["maria", "`eval/run_scoring.py` still imports this.", 1500]] }, { path: "core-api/tests/test_pricing.py", line: 12, hunk: [" ", "-def test_fallback_path():", "-    assert pricing.fallback() is not None"], comments: [["maria", "This one covers the fallback path. Keep it?", 1480]] }, { path: "core-api/legacy/__init__.py", line: 1, resolved: true, comments: [["joe", "Nit: drop the empty file too.", 2600], ["herval", "Done.", 2500]] }], files: [["core-api/legacy/scoring.py", 0, 812, "DELETED"], ["core-api/legacy/__init__.py", 0, 2, "DELETED"], ["core-api/tests/test_pricing.py", 3, 1120], ["core-api/pyproject.toml", 1, 4]], commits: [["Remove legacy scoring and its tests", 3700], ["Keep the pricing fixtures the eval uses", 2400]], labels: ["core-api", "cleanup"], requested: ["Acme-AI/eng-ai"] }),
          pull({ repo: MONO, number: 16702, title: "feat(iac/global): pack CI runners onto fewer nodes", head: "pack-runners", base: "prod", tip: TIP, fork: DEPS, opened: 20000, updated: 1800, review: "APPROVED", body: "Bin-packs the ARC runners: 6 nodes instead of 11 at peak.", checks: [["Secret Scan", "pass", { required: true }], ["Plan", "pass", { workflow: "IaC PR" }], ["Detect changed stacks", "pass", { workflow: "IaC PR" }]], reviews: [["joe", "APPROVED", "Ship it.", 2000]], files: [["iac/global/runners.ts", 34, 12]], commits: [["Pack runners onto fewer nodes", 19000]] }),
          pull({ repo: MONO, number: 16690, title: "feat(iac/network): reach Google APIs through a PSC endpoint on prod-eu", head: "psc-prod-eu", base: "prod", tip: TIP, fork: DEPS, opened: 9000, updated: 700, review: "REVIEW_REQUIRED", mergeState: "BLOCKED", checks: [["Secret Scan", "pass", { required: true }], ["Plan", "pending", { workflow: "IaC PR" }]], files: [["iac/network/psc.ts", 58, 0, "ADDED"], ["iac/network/index.ts", 2, 0]], commits: [["PSC endpoint for Google APIs on prod-eu", 8800]], requested: ["Acme-AI/eng-infrastructure"] }),
          pull({ repo: MONO, number: 16655, title: "Move the SIEM log sinks to Datadog", head: "siem-datadog", base: "prod", tip: TIP, fork: ["refactor(cart): one cart per session, not per tab", 5 * 86400, 63], draft: true, mergeState: "DRAFT", opened: 1400, updated: 300, files: [["iac/siem/sinks.ts", 22, 31]], commits: [["Point the SIEM sinks at Datadog", 1300]] }),
          pull({ repo: MONO, number: 16588, title: "chore(gcp): delete unused BigQuery datasets", head: "gcp-billing", base: "prod", tip: TIP, state: "MERGED", opened: 90000, updated: 30000, closed: 30000, mergedBy: "herval", files: [["iac/bigquery/datasets.ts", 0, 140]] }),
        ],
        diffs: { 16613: diffOf([["core-api/pyproject.toml", ['packages = ["core_api"]']], ["core-api/tests/test_pricing.py", ["def test_fallback_path():", "    assert pricing.fallback() is not None"]]]), 16702: diffOf([["iac/global/runners.ts", ["const packing = { maxPerNode: 4 };"]]]) },
      },
      // herval's other repos, which Add a workspace lists once GitHub is connected.
      "herval/dashy": { description: "A grid of widgets that agents post to", pushedAt: new Date(Date.now() - 2 * 86400e3).toISOString() },
      "herval/littleguy": { private: true, description: "littleguys.dev", pushedAt: new Date(Date.now() - 3 * 3600e3).toISOString() },
      "herval/dotfiles": { description: "zsh, git and editor settings", pushedAt: new Date(Date.now() - 40 * 86400e3).toISOString() },
      "Acme-AI/infra": { private: true, description: "Terraform for every environment", pushedAt: new Date(Date.now() - 5 * 3600e3).toISOString() },
      "Acme-AI/evals": { private: true, description: "Eval suites for the assistant", pushedAt: new Date(Date.now() - 9 * 86400e3).toISOString() },
      "Acme-AI/design-system": { private: true, archived: true, description: "The old component library", pushedAt: new Date(Date.now() - 400 * 86400e3).toISOString() },
      "herval/node-fetch": { fork: true, description: "A light-weight module that brings Fetch API to Node.js", pushedAt: new Date(Date.now() - 200 * 86400e3).toISOString() },
    },
  }),
);

// A stand-in github.com (test/fake-github.ts) for signing in with GitHub: Create agentbook's GitHub App on Connectors
// is confirmed at once, and a sign-in's code is entered as herval a moment later.
const githubSite = await startGitHub({ ghFile: GH_FILE, people: { herval: { name: "Herval", repos: [MONO], installations: [{ account: "Acme-AI", all: true }] } }, confirm: "herval", approveAs: "herval" });

// A stand-in claude.ai (test/fake-claude-api.ts), not claude.ai: Claude's routines there, with their runs.
const claudeApi = await (async () => {
  const NOW = Date.now();
  const H = 3600e3;
  const night = (n: number) => {
    const d = new Date(NOW - n * 86400e3);
    d.setHours(2, 17, 0, 0);
    return d.getTime() > NOW ? d.getTime() - 86400e3 : d.getTime();
  };
  const morning = (n: number) => {
    const d = new Date(NOW - n * 86400e3);
    d.setHours(8, 3, 0, 0);
    return d.getTime() > NOW ? d.getTime() - 86400e3 : d.getTime();
  };
  const nextAt = (h: number, m: number) => {
    const d = new Date(NOW);
    d.setHours(h, m, 0, 0);
    return d.getTime() > NOW ? d.getTime() : d.getTime() + 86400e3;
  };
  const session = (id: string, at: number, took: number, origin = "scheduled_trigger") => ({ id, title: "", status: "active", worker_status: "idle", created_at: iso(at), last_event_at: iso(at + took), config: { origin, model: "claude-sonnet-5-5" } });
  const tool = (at: number, id: string, name: string, input: object) => ev(at, { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const back = (at: number, id: string, error?: string) => ev(at, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: error || "ok", ...(error ? { is_error: true } : {}) }] } });
  const reply = (at: number, text: string, took: number, error = false) => [ev(at, { type: "assistant", message: { content: [{ type: "text", text }] } }), ev(at + 500, { type: "result", subtype: error ? "error_during_execution" : "success", is_error: error, result: text, duration_ms: took })];
  return startClaudeApi({
    token: "demo-claude-token",
    perPage: 10,
    // What Claude Code's /usage shows: its plan's 5-hour and weekly limits, and Sonnet's.
    usage: { five_hour: { utilization: 63, resets_at: iso(NOW + 2.4 * 3600e3) }, seven_day: { utilization: 84, resets_at: iso(NOW + 2.6 * 86400e3) }, seven_day_sonnet: { utilization: 21, resets_at: iso(NOW + 2.6 * 86400e3) }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, currency: "USD" } },
    triggers: [
      { id: "trig_deps", name: "Nightly dependency check", enabled: true, cron_expression: "CRON_TZ=America/Sao_Paulo 17 2 * * *", next_run_at: iso(nextAt(2, 17)), created_at: iso(NOW - 20 * 86400e3), last_run: { fired_at: iso(night(0)), finished_at: iso(night(0) + 184e3), session_id: "cse_deps3", status: "ROUTINE_RUN_STATUS_SUCCEEDED" }, derived_state: { prompt: "Check platform's Python and Node dependencies for updates and security advisories. Open one pull request with the patch and minor updates that pass the tests; list the major ones for me instead of updating them.", model: "claude-sonnet-5-5" }, job_config: { ccr: { session_context: { model: "claude-sonnet-5-5", sources: [{ git_repository: { url: "https://github.com/Acme-AI/platform" } }] } } }, session_request: { tags: [] } },
      { id: "trig_brief", name: "Morning brief", enabled: true, cron_expression: "CRON_TZ=America/Sao_Paulo 3 8 * * 1-5", next_run_at: iso(nextAt(8, 3)), created_at: iso(NOW - 40 * 86400e3), last_run: { fired_at: iso(morning(0)), finished_at: iso(morning(0) + 71e3), session_id: "cse_brief2", status: "ROUTINE_RUN_STATUS_SUCCEEDED" }, bound_device: { display_name: "Claude Desktop (macOS)" }, derived_state: { prompt: "Write my morning brief: today's meetings with what I need for each, what my agents finished overnight, and anything on Slack or Linear that's waiting on me. Short.", model: "claude-opus-5-5" }, session_request: { tags: ["cowork-remote", "cowork-scheduled"] } },
      { id: "trig_changelog", name: "Weekly changelog", enabled: false, cron_expression: "0 21 * * 5", next_run_at: iso(NOW - 2 * 86400e3), created_at: iso(NOW - 60 * 86400e3), last_run: { fired_at: iso(NOW - 9 * 86400e3), finished_at: iso(NOW - 9 * 86400e3 + 22e3), session_id: "cse_log1", status: "ROUTINE_RUN_STATUS_FAILED", failure_reason: "ROUTINE_RUN_FAILURE_REASON_REPO_ACCESS" }, derived_state: { prompt: "Write the week's changelog from merged pull requests in littleguy and post it to #releases.", model: "claude-sonnet-5-5" }, job_config: { ccr: { session_context: { sources: [{ git_repository: { url: "https://github.com/herval/littleguy" } }] } } }, session_request: { tags: [] } },
    ],
    runs: {
      trig_deps: [session("cse_deps3", night(0), 184e3), session("cse_deps2", night(1), 151e3), session("cse_deps1", night(2), 96e3)],
      trig_brief: [session("cse_brief2", morning(0), 71e3), session("cse_brief1", morning(1), 64e3, "manual")],
      trig_changelog: [session("cse_log1", NOW - 9 * 86400e3, 22e3)],
    },
    events: {
      cse_deps3: [tool(night(0) + 5e3, "d1", "Bash", { command: "uv pip list --outdated", description: "List outdated Python packages" }), back(night(0) + 9e3, "d1"), tool(night(0) + 12e3, "d2", "Bash", { command: "npm outdated", description: "List outdated Node packages" }), back(night(0) + 15e3, "d2"), tool(night(0) + 60e3, "d3", "Bash", { command: "uv run pytest -q", description: "Run the tests" }), back(night(0) + 150e3, "d3"), tool(night(0) + 160e3, "d4", "Bash", { command: "gh pr create", description: "Open the pull request" }), back(night(0) + 175e3, "d4"), ...reply(night(0) + 180e3, "Opened PR #16720: fastapi 0.118.2 → 0.119.0 and pydantic 2.12.3 → 2.13.0, tests pass. One major update to look at yourself: **openai 2.x → 3.0** (the streaming API changed).", 184e3)],
      cse_deps2: reply(night(1) + 150e3, "Nothing to update tonight. No new advisories.", 151e3),
      cse_deps1: reply(night(2) + 95e3, "Nothing to update tonight. No new advisories.", 96e3),
      cse_brief2: [tool(morning(0) + 4e3, "b1", "mcp__claude_ai_Google_Calendar__list_events", {}), back(morning(0) + 6e3, "b1"), tool(morning(0) + 8e3, "b2", "mcp__claude_ai_Slack__slack_search_public_and_private", { query: "to:me is:unread" }), back(morning(0) + 12e3, "b2"), ...reply(morning(0) + 70e3, "**Meetings:** 10:00 eng sync (bring the runner numbers), 15:30 hiring debrief.\n**Overnight:** finch opened #16613; the dependency check opened #16720.\n**Waiting on you:** Maria's review question on #16613, and ENG-482 in Linear.", 71e3)],
      cse_brief1: reply(morning(1) + 63e3, "**Meetings:** none before noon. **Waiting on you:** nothing new.", 64e3),
      cse_log1: reply(NOW - 9 * 86400e3 + 21e3, "Couldn't clone herval/littleguy: the GitHub connection has no access to it.", 22e3, true),
    },
  });
})();

// A stand-in Linear (test/fake-linear.ts), not Linear: the issues assigned to you there come into your Tasks.
const LINEAR_KEY = "lin_api_demo";
// Signing in with Linear goes to its stand-in consent page too, which says yes as you and sends you back to the demo.
const linear = await startLinear({ key: LINEAR_KEY, redirects: (uri) => new globalThis.URL(uri).pathname === "/api/linear/callback" && new globalThis.URL(uri).port === String(PORT) });
const minutes = (n) => new Date(Date.now() - n * 60e3).toISOString();
linear.issues.push(
  issue("ENG", 431, "Spanish transcripts lose their accents in the PDF export", { priority: 1, updatedAt: minutes(20) }),
  issue("ENG", 412, "Retry the EHR sync when its token expires", { priority: 2, state: "doing", updatedAt: minutes(90) }),
  issue("ENG", 398, "Cache the pricing rules for an hour", { priority: 3, updatedAt: minutes(300) }),
  issue("ENG", 377, "order_search times out on CI now and then", { state: "backlog" }),
);

// Not this machine's own OpenClaw: its `openclaw` command reaches a real gateway. A stand-in one
// (test/fake-openclaw.ts) has an agent with a conversation and its routines, each with its runs; another
// (AGENTBOOK_OPENCLAW_BIN, FAKE_OPENCLAW_DIR) is used when given.
const OPENCLAW = process.env.AGENTBOOK_OPENCLAW || "1";
const OPENCLAW_BIN = process.env.AGENTBOOK_OPENCLAW_BIN || path.join(TEST, "fake-openclaw.ts");
const OPENCLAW_DIR = process.env.FAKE_OPENCLAW_DIR || path.join(HOME, "openclaw");
if (!process.env.FAKE_OPENCLAW_DIR) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  const now = Date.now();
  const H = 3600e3;
  const D = 24 * H;
  const say = (text: string, t: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: t });
  const used = (id: string, name: string, args: Record<string, unknown>, t: number, error?: string): OcSession["messages"] => [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: t },
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: error || "ok" }], isError: !!error, timestamp: t + 4000 },
  ];
  // The weekday mornings it ran at 08:00, newest first.
  const mornings: number[] = [];
  for (let d = new Date(now); mornings.length < 6; d.setDate(d.getDate() - 1)) {
    const m = new Date(d);
    m.setHours(8, 0, 0, 0);
    if (m.getTime() < now && m.getDay() % 6) mornings.push(m.getTime());
  }
  const briefings = ["Sunny, 24°C in Lisbon. Two calls today: design review at 11:00, 1:1 with Maria at 16:00. The TAP fare you're watching is €812, down €40.", "Rain until noon, 17°C. Your calendar is clear until the 14:00 board prep. The Stripe invoice you flagged was paid.", "Clear and 21°C. Standup at 09:30, then nothing until 15:00. Nothing new on the things you asked me to watch.", "Cloudy, 19°C. Three meetings back to back from 10:00. The visa appointment confirmation arrived; I put it in Travel.", "Sunny, 23°C. Dentist at 12:30. The flight price watch failed twice overnight (rate limited); it recovered at 06:00.", "Windy, 18°C. Quiet day: one call at 17:00. Package from Fnac arrives tomorrow."];
  const sessions: OcSession[] = [
    { key: "agent:main:telegram:direct:herval", sessionId: "s-tg", agentId: "main", derivedTitle: "Dinner on Friday", createdAt: now - 3 * H, updatedAt: now - 2 * H, messages: [{ role: "user", content: "Find somewhere for dinner on Friday, 4 people, near Príncipe Real", timestamp: now - 3 * H, __openclaw: { transport: { channel: "telegram" } } }, ...used("w1", "web_search", { query: "dinner Príncipe Real group of 4" }, now - 3 * H + 5000), say("Two good options: Tasca do Chico (fado, book ahead) or Pharmacia (terrace, takes groups). Want me to book one for 20:30?", now - 3 * H + 30000)] },
    // A long job it handed to workers (subagents), which show on its thread: one renders on, one finished.
    { key: "agent:main:discord:channel:trip-video", sessionId: "s-dc", agentId: "main", derivedTitle: "Tokyo trip video", createdAt: now - 70 * 60e3, updatedAt: now - 38 * 60e3, messages: [{ role: "user", content: "Make the Tokyo trip video from the clips in Photos, 90 seconds, with the Shibuya crossing at the end", timestamp: now - 70 * 60e3, __openclaw: { transport: { channel: "discord" } } }, say("The clips are picked and the cut is locked: 88 s. Rendering the full 1080p takes a while, so a separate worker is doing it. I'll post it here when it's done.", now - 38 * 60e3)] },
    // Each worker's own history, its steps when you open it on the thread.
    { key: "agent:main:subagent:pick-clips", sessionId: "s-w1", agentId: "main", spawnedBy: "agent:main:discord:channel:trip-video", subagentRole: "leaf", label: "Pick the clips and lock the cut", status: "done", startedAt: now - 66 * 60e3, endedAt: now - 41 * 60e3, createdAt: now - 66 * 60e3, updatedAt: now - 41 * 60e3, messages: [{ role: "user", content: "Pick the Tokyo clips for a 90 s cut, Shibuya crossing last", timestamp: now - 66 * 60e3 }, ...used("p1", "photos_search", { query: "Tokyo, Nov 2025, videos" }, now - 65 * 60e3), ...used("p2", "read", { path: "trip/shotlist.md" }, now - 62 * 60e3), say("41 clips; keeping 14, the crossing at 1:18.", now - 55 * 60e3), ...used("p3", "exec", { command: "ffmpeg -f concat -i cut.txt -c copy rough.mp4" }, now - 48 * 60e3), say("Cut locked at 88 s.", now - 41 * 60e3)] },
    { key: "agent:main:subagent:render", sessionId: "s-w2", agentId: "main", spawnedBy: "agent:main:discord:channel:trip-video", subagentRole: "leaf", label: "Render the trip video (1080p)", status: "running", hasActiveRun: true, startedAt: now - 37 * 60e3, createdAt: now - 37 * 60e3, updatedAt: now - 2 * 60e3, lastActivityAt: now - 2 * 60e3, messages: [{ role: "user", content: "Render rough.mp4's cut at 1080p with the color grade", timestamp: now - 37 * 60e3 }, ...used("r1", "read", { path: "trip/grade.cube" }, now - 36 * 60e3), ...used("r2", "exec", { command: "ffmpeg -i rough.mp4 -vf lut3d=grade.cube -s 1920x1080 trip-1080p.mp4" }, now - 35 * 60e3, "ffmpeg: Unknown filter 'lut3d'"), say("This ffmpeg has no lut3d; grading in Resolve instead.", now - 34 * 60e3), { role: "assistant", content: [{ type: "toolCall", id: "r3", name: "exec", arguments: { command: "resolve -render trip.drp --preset 1080p" } }], timestamp: now - 33 * 60e3 }] },
  ];
  const runs: CronRun[] = [];
  mornings.forEach((t, i) => {
    const key = `agent:main:cron:morning:run:m${i}`;
    // OpenClaw lets go of a run's session once it's over: the older ones keep only what they reported.
    if (i < 2) sessions.push({ key, sessionId: `m${i}`, agentId: "main", createdAt: t, updatedAt: t + 41000, messages: [{ role: "user", content: "Give me a short morning briefing.", timestamp: t }, ...used(`m${i}a`, "web_search", { query: "Lisbon weather today" }, t + 3000), ...used(`m${i}b`, "calendar_list", { description: "Today's calendar" }, t + 12000), ...used(`m${i}c`, "read", { path: "notes/watching.md" }, t + 20000), say(briefings[i], t + 40000)] });
    runs.push({ ts: t + 41000, jobId: "morning", action: "finished", status: "ok", summary: briefings[i], sessionKey: key, sessionId: `m${i}`, runId: `m${i}`, runAtMs: t, durationMs: 41000, deliveryStatus: "delivered", model: "anthropic/claude-sonnet-5-5" });
  });
  // The session a gateway lists for that job, which each run takes over: its thread, with the latest run.
  sessions.push({ key: "agent:main:cron:morning", sessionId: "m0", agentId: "main", label: "Automation: Morning briefing", createdAt: mornings.at(-1), updatedAt: mornings[0] + 41000, messages: [{ role: "user", content: "[cron:morning Morning briefing] Give me a short morning briefing.\nCurrent time: today\n\nThis is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have.", timestamp: mornings[0] }, { role: "assistant", content: [{ type: "text", text: briefings[0] }], timestamp: mornings[0] + 41000 }] });
  for (let i = 0; i < 8; i++) {
    const t = now - (i + 1) * 4 * H + 15 * 60e3;
    const failed = i < 2;
    const key = `agent:main:cron:fares:run:f${i}`;
    sessions.push({ key, sessionId: `f${i}`, agentId: "main", createdAt: t, updatedAt: t + 9000, messages: [{ role: "user", content: "Check the TAP fare.", timestamp: t }, ...used(`f${i}a`, "web_fetch", { url: "https://www.flytap.com/en-pt/flights/lisbon-tokyo" }, t + 2000, failed ? "429 Too Many Requests" : null), say(failed ? "I couldn't reach TAP's site: it's rate limiting me. I'll try again next time." : `Still €${812 + i * 6}: not under €800, so nothing to tell you.`, t + 9000)] });
    runs.push({ ts: t + 9000, jobId: "fares", action: "finished", status: failed ? "error" : "ok", ...(failed ? { error: "web_fetch: 429 Too Many Requests" } : { summary: `Still €${812 + i * 6}: not under €800, so nothing to tell you.` }), sessionKey: key, sessionId: `f${i}`, runId: `f${i}`, runAtMs: t, durationMs: 9000 });
  }
  const friday = new Date(now);
  friday.setDate(friday.getDate() - ((friday.getDay() + 2) % 7 || 7));
  friday.setHours(17, 0, 0, 0);
  runs.push({ ts: friday.getTime() + 95000, jobId: "inbox", action: "finished", status: "ok", summary: "Archived 46 newsletters, flagged 3 that need you: the lease renewal, Maria's offer letter, and the AWS bill (up 30%).", runAtMs: friday.getTime(), durationMs: 95000 });
  const nextMorning = new Date(now);
  do nextMorning.setDate(nextMorning.getDate() + 1);
  while (!(nextMorning.getDay() % 6));
  nextMorning.setHours(8, 0, 0, 0);
  // Its workspace: what makes it who it is, its daily notes, what it keeps an eye on, a skill it wrote.
  const day = (n: number) => new Date(now - n * D).toISOString().slice(0, 10);
  const workspace = {
    "AGENTS.md": "# AGENTS.md\n\nThis folder is home. Treat it that way.\n\n## Every session\n\n1. Read `SOUL.md`: who you are.\n2. Read `USER.md`: who you're helping.\n3. Read today's and yesterday's notes in `memory/`.\n\n## Memory\n\n- Daily notes go in `memory/YYYY-MM-DD.md`: what happened, raw.\n- `MEMORY.md` is the curated version. Keep it short.\n\n## Safety\n\n- Ask before anything that leaves the machine: emails, posts, bookings.\n- `trash` over `rm`.\n",
    "SOUL.md": "# SOUL.md\n\nBe genuinely helpful, not performatively helpful. Skip the filler.\n\nHave opinions. Say which restaurant you'd pick and why.\n\nBe resourceful before asking: read the file, check the calendar, then ask.\n",
    "USER.md": "# USER.md\n\n- **Name:** Herval\n- **Lives in:** Lisbon\n- **Timezone:** Europe/Lisbon\n- Likes short answers. Hates being asked the same thing twice.\n",
    "IDENTITY.md": "# IDENTITY.md\n\n- **Name:** Pato\n- **Emoji:** 🦆\n- **Vibe:** calm, a bit dry\n",
    "TOOLS.md": "# TOOLS.md\n\n- Calendar: `calendar_list`, read-only.\n- TAP fares: flytap.com rate-limits after ~20 requests an hour.\n",
    "HEARTBEAT.md": "# HEARTBEAT.md\n\n- Check `notes/watching.md` for anything due today.\n",
    "MEMORY.md": `# MEMORY.md\n\n## Herval\n\n- Flying Lisbon to Tokyo, Nov 3 to 17. Watching TAP under €800.\n- Dinner on Fridays is usually 4 people, near Príncipe Real.\n- Visa appointment confirmed (${day(4)}).\n\n## Lessons\n\n- flytap.com blocks after a burst: space the checks out.\n`,
    [`memory/${day(0)}.md`]: `# ${day(0)}\n\n- 08:00 briefing sent on Telegram.\n- TAP fare still €812. Two checks failed (429) overnight.\n- Asked about dinner on Friday: suggested Tasca do Chico or Pharmacia. Waiting on which.\n`,
    [`memory/${day(1)}.md`]: `# ${day(1)}\n\n- Briefing sent. Rain until noon.\n- The Stripe invoice he flagged was paid.\n`,
    [`memory/${day(2)}.md`]: `# ${day(2)}\n\n- Quiet day. Nothing new on the watch list.\n`,
    [`memory/${day(4)}.md`]: `# ${day(4)}\n\n- Visa appointment confirmation arrived; filed it under Travel.\n`,
    "notes/watching.md": "# Watching\n\n- [ ] TAP LIS → NRT, Nov 3–17, under €800\n- [ ] Fnac package (arrives Thursday)\n- [x] Visa appointment\n",
    "notes/restaurants.md": "# Restaurants\n\n| Place | Good for | Book? |\n| --- | --- | --- |\n| Tasca do Chico | fado, small groups | yes, a day ahead |\n| Pharmacia | terrace, groups | for 6+ |\n| Taberna da Rua das Flores | lunch | no bookings |\n",
    "skills/fare-watch/SKILL.md": "---\nname: fare-watch\ndescription: Check a flight fare on flytap.com and say only when it drops under a threshold.\n---\n\n# Fare watch\n\n1. Fetch the route's page.\n2. Read the lowest fare for the dates.\n3. Under the threshold: tell Herval on Telegram. Otherwise, stay quiet.\n",
    "canvas/index.html": "<!doctype html><title>Trip</title><h1>Tokyo, Nov 3–17</h1><p>Fare: €812</p>",
    // A name with nowhere to break, the way receipts get named: it truncates on the profile.
    "memory/fare-receipts/293f77013857bb3befd6b62d24714ca284bf335f.json": '{ "route": "LIS-NRT", "fare": 812, "currency": "EUR" }\n',
  };
  const fileTimes = { "AGENTS.md": now - 40 * D, "SOUL.md": now - 40 * D, "USER.md": now - 12 * D, "IDENTITY.md": now - 40 * D, "TOOLS.md": now - 6 * D, "HEARTBEAT.md": now - 9 * D, "MEMORY.md": now - 3 * H, [`memory/${day(0)}.md`]: now - 4 * 60e3, [`memory/${day(1)}.md`]: now - 1 * D, [`memory/${day(2)}.md`]: now - 2 * D, [`memory/${day(4)}.md`]: now - 4 * D, "notes/watching.md": now - 2 * H, "notes/restaurants.md": now - 2 * H - 600e3, "skills/fare-watch/SKILL.md": now - 5 * D, "canvas/index.html": now - 3 * D, "memory/fare-receipts/293f77013857bb3befd6b62d24714ca284bf335f.json": now - 30 * 60e3 };
  const job = (id: string, name: string, schedule: object, message: string, state: object, more = {}) => ({ id, agentId: "main", name, enabled: true, createdAtMs: now - 40 * D, updatedAtMs: now - 3 * D, schedule, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message }, state, ...more });
  fs.writeFileSync(
    path.join(OPENCLAW_DIR, "state.json"),
    JSON.stringify({
      agents: [{ id: "main", name: "main", identity: { name: "Pato", emoji: "🦆" }, workspace: "/Users/demo/.openclaw/workspace", model: { primary: "anthropic/claude-sonnet-5-5" } }],
      sessions,
      files: workspace,
      fileTimes,
      presence: [{ host: "brick", mode: "gateway", reason: "self" }],
      approvals: [],
      questions: [],
      // What its gateway's sign-ins have used of their limits (usage.status), on its agents' profiles.
      usage: [
        { provider: "anthropic", displayName: "Claude", windows: [{ label: "5h", usedPercent: 18, resetAt: now + 3 * H }, { label: "Week", usedPercent: 47, resetAt: now + 4 * D }] },
        { provider: "openai", displayName: "Codex", plan: "Plus", windows: [{ label: "5h", usedPercent: 6, resetAt: now + 4 * H }, { label: "Week", usedPercent: 22, resetAt: now + 5 * D }] },
      ],
      cron: {
        jobs: [
          job("morning", "Morning briefing", { kind: "cron", expr: "0 8 * * 1-5" }, "Give me a short morning briefing: the weather in Lisbon, my calendar for today, and anything I asked you to keep an eye on (notes/watching.md). Three lines at most.", { nextRunAtMs: nextMorning.getTime(), lastRunAtMs: mornings[0], lastRunStatus: "ok", lastDurationMs: 41000 }, { delivery: { mode: "announce", channel: "telegram" } }),
          job("fares", "Flight price watch", { kind: "every", everyMs: 4 * H }, "Check TAP's fare from Lisbon to Tokyo, Nov 3 to 17. Tell me only if it drops under €800.", { nextRunAtMs: now + 4 * H - (now % (4 * H)), lastRunAtMs: now - 4 * H + 15 * 60e3, lastRunStatus: "error", lastError: "web_fetch: 429 Too Many Requests", lastDurationMs: 9000, consecutiveErrors: 2 }, { delivery: { mode: "announce", channel: "telegram" } }),
          job("inbox", "Weekly inbox sweep", { kind: "cron", expr: "0 17 * * 5" }, "Go through my inbox: archive newsletters and receipts, and list what needs me.", { lastRunAtMs: friday.getTime(), lastRunStatus: "ok", lastDurationMs: 95000 }, { enabled: false }),
          { id: "dreaming", agentId: "main", declarationKey: "memory-dreaming", name: "Memory dreaming", enabled: true, createdAtMs: now - 60 * D, updatedAtMs: now - 60 * D, schedule: { kind: "cron", expr: "0 3 * * *" }, sessionTarget: "isolated", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "Consolidate today's memories." }, state: { lastRunAtMs: now - (now % D) + 3 * H - D, lastRunStatus: "ok" } },
        ],
        runs,
      },
    }),
  );
}
// An MCP server in Claude Code's config, for the reliability page's routine to call.
const mcp = await startFakeMcp();
fs.writeFileSync(path.join(HOME, "claude", ".claude.json"), JSON.stringify({ mcpServers: { datadog: { type: "http", url: mcp.url, headers: { "x-api-key": mcp.key } } } }));
// A stand-in for two pages on the web, at docs.acme.localhost on this machine, for the link cards on plover's
// replies: agentbook reads a linked page's title, words and picture (agentbook is told to trust it, with
// AGENTBOOK_PICTURE_HOSTS, as it would a picture server on your network).
const DOCS_PAGES = {
  "/blog/framing": { title: "Why some sites stay blank in a frame", text: "X-Frame-Options and frame-ancestors: what they block, and what to show instead.", site: "Acme Engineering", image: "/og/framing.png" },
  "/handbook/embeds": { title: "Embeds in the handbook", text: "When to embed a page, when to link to it, and how big an embed should be on a phone.", site: "Acme Handbook", image: "/og/embeds.png" },
};
const docsSite = http.createServer((req, res) => {
  const pic = { "/og/framing.png": "#4f7cf7", "/og/embeds.png": "#2f9e6b" }[req.url];
  if (pic) return res.writeHead(200, { "content-type": "image/png" }).end(banner({ accent: pic }));
  const pg = DOCS_PAGES[req.url];
  if (!pg) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>${pg.title}</title><meta property="og:title" content="${pg.title}"><meta property="og:description" content="${pg.text}"><meta property="og:site_name" content="${pg.site}"><meta property="og:image" content="${pg.image}"></head><body><h1>${pg.title}</h1></body></html>`);
});
await new Promise<void>((r) => docsSite.listen(0, "::", r));
const DOCS_HOST = `docs.acme.localhost:${(docsSite.address() as AddressInfo).port}`;
const DOCS = `http://${DOCS_HOST}`;
// Claude Desktop's records of its sessions (cli/desktop.ts): dunlin's, and starling's, a task dunlin started.
const DESKTOP = path.join(HOME, "desktop");
const DESKTOP_ORG = path.join(DESKTOP, "claude-code-sessions", "acct-demo", "org-demo");
fs.mkdirSync(DESKTOP_ORG, { recursive: true });
fs.writeFileSync(path.join(DESKTOP_ORG, "local_d0000000-0000-4000-8000-000000000001.json"), JSON.stringify({ sessionId: "local_d0000000-0000-4000-8000-000000000001", cliSessionId: "dunlin-0000-4000-8000-demo-dunlin", title: "What's in the Ledgerly renewal" }));
fs.writeFileSync(path.join(DESKTOP_ORG, "local_d0000000-0000-4000-8000-000000000002.json"), JSON.stringify({ sessionId: "local_d0000000-0000-4000-8000-000000000002", cliSessionId: "starling-0000-4000-8000-demo-starling", title: "Ask Ledgerly to keep 12-month terms", spawnedFrom: { sessionId: "local_d0000000-0000-4000-8000-000000000001", taskId: "task_demo", title: "Ask Ledgerly to keep 12-month terms", sideSession: true } }));
const server = spawnAgentbook({
  env: { ...process.env, AGENTBOOK_PORT: String(PORT), AGENTBOOK_HOME: HOME, AGENTBOOK_DESKTOP_DIRS: DESKTOP, AGENTBOOK_OPENCLAW: OPENCLAW, AGENTBOOK_OPENCLAW_BIN: OPENCLAW_BIN, FAKE_OPENCLAW_DIR: OPENCLAW_DIR, AGENTBOOK_OPENCLAW_URL: "", CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, AGENTBOOK_CODEX_SOCK: CODEX_SOCK, AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"), AGENTBOOK_CLOUD_SYNC_MS: "60000", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "1000", AGENTBOOK_GITHUB_URL: githubSite.url, AGENTBOOK_GITHUB_API_URL: githubSite.url, AGENTBOOK_LINEAR_URL: linear.url, AGENTBOOK_LINEAR_WEB_URL: linear.web, AGENTBOOK_LINEAR_CLIENT_ID: "test-client", AGENTBOOK_CLONE_DIR: DEV, GIT_ALLOW_PROTOCOL: "file", AGENTBOOK_CODEX_HOME: CODEX_HOME, AGENTBOOK_CLAUDE_TOKEN: "demo-claude-token", AGENTBOOK_CLAUDE_API: claudeApi.url, AGENTBOOK_PICTURE_HOSTS: DOCS_HOST },
  stdio: "inherit",
});
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    server.kill();
    codexDaemon.kill();
    claudeApi.close();
    process.exit(0);
  });
// A server that can't start (its port taken by another agentbook) mustn't leave the demo's sessions to that one.
server.on("exit", () => {
  codexDaemon.kill();
  process.exit(1);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The demo's person: sign in as them to look around, at /test-sign-in?as=demo (test/harness-front.ts).
const DEMO_USER = "demo";
let COOKIE = "";
const call = (method: string, p: string, body?: unknown): Promise<Json> => fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(COOKIE ? { cookie: COOKIE } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const post = (p: string, body?: unknown) => call("POST", p, body);
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(URL + "/api/health")).ok) break;
  } catch {}
  await sleep(100);
}
{
  const r = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: DEMO_USER, display_name: "Demo" }) });
  COOKIE = (r.headers.get("set-cookie") || "").split(";")[0];
}

// A transcript, the way Claude Code writes it.
const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const T = {
  prompt: (text: string, ago: number) => ({ type: "user", timestamp: at(ago), message: { content: text } }),
  say: (text: string, ago: number) => ({ type: "assistant", timestamp: at(ago), message: { model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 4, cache_read_input_tokens: 61000, cache_creation_input_tokens: 2100 } } }),
  tool: (id: string, name: string, input: unknown, ago: number) => ({ type: "assistant", timestamp: at(ago), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } }),
  ok: (id: string, ago: number) => ({ type: "user", timestamp: at(ago), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
  fail: (id: string, text: string, ago: number) => ({ type: "user", timestamp: at(ago), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } }),
  title: (text: string) => ({ type: "ai-title", aiTitle: text }),
  pr: (repo: string, n: number, ago: number) => ({ type: "pr-link", prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp: at(ago) }),
  took: (ms: number) => ({ type: "system", subtype: "turn_duration", durationMs: ms }),
  // A loop's fire: Claude Code notes it, then sends its prompt as a turn of its own.
  fire: (task: string, prompt: string, cron: string, ago: number) => [{ type: "system", subtype: "scheduled_task_fire", timestamp: at(ago), content: "Running scheduled task", cron, prompt, taskId: task, taskKind: null }, { type: "user", isMeta: true, turnOrigin: "scheduled", scheduledTaskId: task, timestamp: at(ago - 1), message: { role: "user", content: prompt } }],
  plan: (id: string, todos: { content: string; status: string; activeForm: string }[], ago: number) => ({ type: "assistant", timestamp: at(ago), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }] } }),
  // What Claude Code records about edits: an Edit's hunks (and the file before it, for small files), a new
  // file's text, and what a command changed.
  edit: (id: string, file: string, before: string, after: string, ago: number, small = true) => ({ type: "user", timestamp: at(ago), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: { filePath: file, oldString: "", newString: "", originalFile: small ? before : null, structuredPatch: diffTexts(before, after), userModified: false, replaceAll: false } }),
  created: (id: string, file: string, content: string, ago: number) => ({ type: "user", timestamp: at(ago), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: { type: "create", filePath: file, content, structuredPatch: [], originalFile: null } }),
  // `files`: each one changed, with its text before and after.
  ran: (id: string, files: [file: string, before: string, after: string][], ago: number, stdout = "") => ({ type: "user", timestamp: at(ago), message: { content: [{ type: "tool_result", tool_use_id: id, content: stdout || "ok" }] }, toolUseResult: { stdout, stderr: "", interrupted: false, bashEditDiff: { files: files.map(([file, before, after]) => ({ filePath: file, hunks: diffTexts(before, after) })), moreFiles: 0, changedFiles: files.map(([file]) => file) } } }),
};
const transcript = (name: string, entries: object[]) => {
  const file = path.join(HOME, `${name}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
};
function project(name: string) {
  const dir = path.join(DEV, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// The files quail changes in dashy: as they were, after its first turn, and after its second.
const SRC = {
  server: [
    "// dashy server: widgets agents post to.",
    'import http from "node:http";',
    'import { store } from "./store.ts";',
    "",
    'const TYPES = new Set(["table", "metric", "note", "list"]);',
    "",
    "// A widget as the board shows it.",
    "function widget(w) {",
    "  if (!TYPES.has(w.type)) throw new Error(`Unknown widget type: ${w.type}`);",
    "  return { id: w.id, type: w.type, title: w.title || \"\", data: w.data || {} };",
    "}",
    "",
    "export function addWidget(board, w) {",
    "  board.widgets.push(widget(w));",
    "  store.save(board);",
    "}",
    "",
    "export function removeWidget(board, id) {",
    "  board.widgets = board.widgets.filter((w) => w.id !== id);",
    "  store.save(board);",
    "}",
  ].join("\n") + "\n",
  app: Array.from({ length: 70 }, (_, i) => (i === 30 ? "function renderWidget(w) {" : i === 31 ? "  if (w.type === \"table\") return table(w);" : i === 32 ? "  if (w.type === \"metric\") return metric(w);" : i === 33 ? "  return note(w);" : i === 34 ? "}" : `// ui line ${i + 1}`)).join("\n") + "\n",
  pkg: '{\n  "name": "dashy",\n  "private": true,\n  "dependencies": {\n    "ws": "^8.18.0"\n  }\n}\n',
};
const NEXT: Record<string, string> = {
  server1: SRC.server.replace('"note", "list"]);', '"note", "list", "embed"]);\n// Embeds run in a sandboxed frame: a page by URL, or HTML the agent wrote.\nconst SANDBOX = "allow-scripts";').replace('data: w.data || {} };', 'data: w.data || {} };\n}\n\nfunction embed(w) {\n  const { url, html } = w.data || {};\n  if (!url && !html) throw new Error("An embed needs a url or some html");\n  return { ...widget(w), sandbox: SANDBOX };'),
};
NEXT.server2 = NEXT.server1.replace("  board.widgets.push(widget(w));", '  board.widgets.push(w.type === "embed" ? embed(w) : widget(w));');
NEXT.app1 = SRC.app.replace('  if (w.type === "metric") return metric(w);', '  if (w.type === "metric") return metric(w);\n  if (w.type === "embed") return frame(w);');
NEXT.app2 = NEXT.app1.replace("// ui line 60\n", "// ui line 60\nfunction frame(w) {\n  return `<iframe sandbox=\"${w.sandbox}\" srcdoc=\"${esc(w.data.html || \"\")}\" src=\"${esc(w.data.url || \"\")}\"></iframe>`;\n}\n");
NEXT.css = ".embed iframe {\n  width: 100%;\n  min-height: 240px;\n  border: 0;\n  border-radius: 10px;\n}\n";
NEXT.pkg = SRC.pkg.replace('"ws": "^8.18.0"', '"marked": "^15.0.0",\n    "ws": "^8.18.0"');
const DASHY = (rel: string) => path.join(DEV, "dashy", rel);

const COMPOSER_TREE = path.join(DEV, "dashy", ".claude", "worktrees", "composer-options");

// dashy is a git checkout, so the composer has branches to pick from, and its work in progress shows: a
// worktree with a commit and changes not committed yet while main moved under it, and a branch whose commit
// landed on main. quail's first turn ends in a commit (backdated, so it lands while its commit command ran), and
// its second turn's changes aren't committed.
{
  const dir = project("dashy");
  const gitIn = (cwd: string) => (args: string[], date?: string) => spawnSync("git", ["-C", cwd, "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { stdio: "ignore", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
  const git = gitIn(dir);
  const write = (root: string, f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  };
  const put = (rel: string, text: string) => write(dir, rel, text);
  git(["init", "-q", "-b", "main"]);
  put("plugin/server/server.mjs", SRC.server);
  put("plugin/ui/app.js", SRC.app);
  put("plugin/ui/agentbook.css", ".post { padding: 14px; }\n");
  put("package.json", SRC.pkg);
  put("README.md", "# dashy\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "dashy"], at(3000));
  git(["branch", "embed-widget"]);
  git(["remote", "add", "origin", "git@github.com:herval/dashy.git"]);
  // The composer options, in a worktree: one commit, more not committed, and main moving under it.
  git(["worktree", "add", "-q", "-b", "worktree-composer-options", COMPOSER_TREE]);
  write(COMPOSER_TREE, "plugin/ui/app.js", SRC.app.replace("// ui line 5\n", "// ui line 5: model and effort, in one menu\n"));
  write(COMPOSER_TREE, "plugin/ui/agentbook.css", ".post { padding: 14px; }\n.opt { height: 32px; }\n");
  gitIn(COMPOSER_TREE)(["commit", "-qam", "Quieter composer options: model and effort in one menu"]);
  write(COMPOSER_TREE, "plugin/ui/agentbook.css", ".post { padding: 14px; }\n.opt { height: 32px; }\n.opt:hover { background: var(--well); }\n");
  write(COMPOSER_TREE, "plugin/ui/options.css", ".opt-v { max-width: 220px; }\n");
  // A fix made on its own branch, then cherry-picked onto main: nothing left on it to land.
  const fix = path.join(dir, ".claude", "worktrees", "fix-flaky-smoke");
  git(["worktree", "add", "-q", "-b", "fix-flaky-smoke", fix]);
  write(fix, "test/smoke.ts", "// Wait for the server before the checks start.\nawait ready();\n");
  gitIn(fix)(["add", "-A"]);
  gitIn(fix)(["commit", "-qm", "Wait for the server before the smoke tests start"]);
  put("plugin/ui/agentbook.css", ".post { padding: 14px; }\n.viewer { inset: 0; }\n");
  git(["commit", "-qam", "Clicking a file opens it in a viewer over the page"]);
  git(["cherry-pick", "fix-flaky-smoke"]);
  put("README.md", "# dashy\n\nYour agents, on one page.\n");
  git(["commit", "-qam", "README: what dashy is"]);
  // quail's turns: the first one's commit, the second one's changes.
  put("plugin/server/server.mjs", NEXT.server2);
  put("plugin/ui/embed.css", NEXT.css);
  git(["add", "plugin/server/server.mjs", "plugin/ui/embed.css"]);
  git(["commit", "-q", "-m", "Embed widgets: a page by URL or HTML, in a sandboxed frame"], at(399));
  put("plugin/ui/app.js", NEXT.app2);
  put("package.json", NEXT.pkg);
}

// platform is a clone of Acme-AI/platform, so the workspace for that repo finds it. Its branches are its pull
// requests' (gcp-billing's merged since), and a worktree on latency-alerts, which has no pull request yet.
{
  const dir = project("platform");
  const days = (n: number) => new Date(Date.now() - n * 86400e3).toISOString();
  const git = (args: string[], when = days(3)) => spawnSync("git", ["-C", dir, "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  git(["init", "-q", "-b", "prod"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# platform\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "platform"]);
  for (const b of ["daring-swan", "siem-datadog", "gcp-billing"]) git(["branch", b]);
  git(["remote", "add", "origin", `git@github.com:${MONO}.git`]);
  const tree = path.join(dir, ".claude", "worktrees", "latency-alerts");
  git(["worktree", "add", "-q", "-b", "latency-alerts", tree]);
  const wt = (args: string[], when: string) => spawnSync("git", ["-C", tree, "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  fs.mkdirSync(path.join(tree, "iac", "alerts"), { recursive: true });
  fs.writeFileSync(path.join(tree, "iac", "alerts", "latency.ts"), "export const p95 = { threshold: 800, window: \"5m\" };\n");
  wt(["add", "-A"], days(0.1));
  wt(["commit", "-q", "-m", "Alert on p95 latency over 800ms"], days(0.1));
  fs.writeFileSync(path.join(tree, "iac", "alerts", "index.ts"), "export * from \"./latency\";\n");
  // gcp-billing's pull request merged, and its worktree still has a file nobody committed (a scanner's output): it
  // says Merged, with the file as a note.
  const billing = path.join(dir, ".claude", "worktrees", "gcp-billing");
  git(["worktree", "add", "-q", billing, "gcp-billing"]);
  fs.writeFileSync(path.join(billing, "gitleaks-results.sarif"), "{}\n");
}

async function session({ proc, label, agent = "Claude", kind = "claude-code", repo, branch, entries, channel = true, cwd, app }: { proc: string; label: string; agent?: string; kind?: string; repo: string; branch?: string; entries?: object[]; channel?: boolean; cwd?: string; app?: string }) {
  const dir = project(repo);
  const file = entries ? transcript(label, entries) : undefined;
  await post("/api/hello", { proc, label, agent, kind, session_id: `${label}-0000-4000-8000-${proc}`, transcript: file, cwd: cwd || dir, root: dir, repo, branch, host: "hervalm5", pid: 1000 + proc.length, channel, app });
  return `/api/procs/${proc}`;
}
const todo = (content: string, status: string, activeForm?: string) => ({ content, status, activeForm: activeForm || content });

// quail: working, live steps, a plan, a comment thread
const quail = await session({
  proc: "demo-quail", label: "quail", repo: "dashy", branch: "main",
  entries: [
    T.title("Add an embed widget to dashy"),
    { type: "attachment", attachment: { type: "skill_listing", content: "- dashy: How to keep the person's dashy dashboard up to date.\n- frontend-design:frontend-design: Guidance for distinctive, intentional visual design when building new UI.\n- docs: Living docs you create and edit together.\n- open-pull-request: Open a pull request with a clear description and checks.\n- spec-writer: Write a short spec before a large change." } },
    T.prompt("make a widget w/ an embedded iframe / html", 1100),
    T.tool("sk1", "Skill", { skill: "frontend-design:frontend-design" }, 1095), T.ok("sk1", 1094),
    T.say("Looking at how the server checks widget types, then the board's renderer.", 1090),
    T.plan("p1", [todo("Accept an embed type on the server", "in_progress", "Accepting an embed type on the server"), todo("Render it in a sandboxed frame", "pending"), todo("Run the smoke tests", "pending"), todo("Document it in the skill", "pending")], 1085),
    T.tool("q1", "Read", { file_path: path.join(DEV, "dashy", "plugin/server/server.mjs") }, 1080), T.ok("q1", 1079),
    T.tool("q2", "Edit", { file_path: DASHY("plugin/server/server.mjs") }, 1000), T.edit("q2", DASHY("plugin/server/server.mjs"), SRC.server, NEXT.server1, 999),
    T.tool("q2b", "Edit", { file_path: DASHY("plugin/server/server.mjs") }, 980), T.edit("q2b", DASHY("plugin/server/server.mjs"), NEXT.server1, NEXT.server2, 979, false),
    T.tool("q3", "Edit", { file_path: DASHY("plugin/ui/app.js") }, 900), T.edit("q3", DASHY("plugin/ui/app.js"), SRC.app, NEXT.app1, 899, false),
    T.tool("q3b", "Write", { file_path: DASHY("plugin/ui/embed.css") }, 880), T.created("q3b", DASHY("plugin/ui/embed.css"), NEXT.css, 879),
    T.tool("q4", "WebFetch", { url: "https://x.com" }, 700), T.fail("q4", "x.com refuses to be framed (X-Frame-Options: DENY)", 698),
    T.say("x.com can't be shown in a frame. Asking what to do instead.", 690),
    T.tool("qc", "Bash", { command: 'git add plugin/server/server.mjs plugin/ui/embed.css && git commit -q -m "Embed widgets: a page by URL or HTML, in a sandboxed frame"', description: "Commit the server side of embeds" }, 400), T.ok("qc", 398),
    T.plan("p2", [todo("Accept an embed type on the server", "completed"), todo("Render it in a sandboxed frame", "completed"), todo("Run the smoke tests", "in_progress", "Running the smoke tests"), todo("Document it in the skill", "pending")], 300),
    T.tool("q5", "Bash", { command: "node --check plugin/ui/app.js", description: "Syntax-check app.js" }, 120), T.ok("q5", 118),
    T.took(41000),
    T.prompt("<channel source=\"plugin:agentbook:agentbook\" kind=\"message\">skip it</channel>", 100),
    T.tool("q7", "Edit", { file_path: DASHY("plugin/ui/app.js") }, 60), T.edit("q7", DASHY("plugin/ui/app.js"), NEXT.app1, NEXT.app2, 59, false),
    T.tool("q8", "Bash", { command: "npm install marked", description: "Add marked, for the HTML embeds' markdown" }, 40), T.ran("q8", [[DASHY("package.json"), SRC.pkg, NEXT.pkg]], 38, "added 1 package"),
    T.tool("q6", "Bash", { command: "npm test", description: "Run the smoke tests and show failures" }, 16),
  ],
});
await post(`${quail}/post`, { title: "Add an embed widget to dashy", text: "Widgets that show a web page or a bit of HTML, so agents can put dashboards and previews on the dash." });
// Said when its transcript says, so what it said while it worked falls between them.
await post(`${quail}/messages`, { from: "human", via: "terminal", text: "make a widget w/ an embedded iframe / html", at: at(1100) });
await post(`${quail}/messages`, { from: "agent", text: "On it. Two kinds: a web page by URL, and HTML I write myself. Both run in a **sandbox**, so a page can't touch the dash.", at: at(1088) });
const q = await post(`${quail}/questions`, { title: "x.com refuses to be shown inside other pages, so an iframe stays blank. What should I do?", options: ["Put a screenshot of it in instead", "Skip it"] });
await post(`/api/questions/${q.id}/answer`, { value: "Skip it" });
await post(`${quail}/messages`, { from: "agent", text: "Skipped. Moving on to the HTML embed." });
await post(`${quail}/updates`, { text: "Added the embed type to the server and the UI" });
// A turn that changed files ends with a line saying so ("Changed 2 files, +4"), then quail carries on.
await post(`${quail}/status`, { state: "idle", turn: "end" });
await sleep(2500);
await post(`${quail}/status`, { state: "working", turn: "start", text: "Running the smoke tests" });

// osprey: needs you, a permission prompt
const osprey = await session({
  proc: "demo-osprey", label: "osprey", repo: "platform", branch: "siem-datadog",
  entries: [T.title("Move the SIEM log sinks to Datadog"), { type: "permission-mode", permissionMode: "default" }, T.prompt("move the siem sinks to datadog", 1500), T.tool("o1", "Bash", { command: "terraform plan", description: "Plan the SIEM sink changes" }, 300), T.ok("o1", 260), T.took(240000)],
});
await post(`${osprey}/post`, { title: "Move the SIEM log sinks to Datadog", text: "Three log sinks point at the old SIEM. The plan moves them and creates nothing new." });
await post(`${osprey}/status`, { state: "waiting", turn: "start", text: "Waiting for permission in the terminal" });
await post(`${osprey}/questions`, { kind: "permission", title: "Allow Bash?", tool_name: "Bash", detail: "Apply the SIEM sinks plan", preview: "terraform apply -target=module.siem_sinks", request_id: "abcde" });

// finch: working, with a pull request and a to-do for you
const finch = await session({
  proc: "demo-finch", label: "finch", repo: "platform", branch: "daring-swan",
  entries: [
    T.title("Cut dead tests from core-api"), T.prompt("find tests we can cut from core-api", 9000),
    T.tool("f1", "Agent", { description: "Review the pricing tests" }, 8800), T.ok("f1", 8000),
    T.pr("Acme-AI/platform", 16613, 3600), T.took(5_400_000),
    // A loop it runs (/loop 30m): CronCreate, then each fire is a turn of its own.
    T.prompt("<command-name>/loop</command-name>\n<command-args>30m check CI on #16613 and fix what broke</command-args>", 3520),
    T.tool("fl1", "CronCreate", { cron: "7,37 * * * *", prompt: "check CI on #16613 and fix what broke", recurring: true }, 3510),
    { type: "user", timestamp: at(3509), message: { content: [{ type: "tool_result", tool_use_id: "fl1", content: "Scheduled recurring job 5e1f0c2a (7,37 * * * *)." }] }, toolUseResult: { id: "5e1f0c2a", humanSchedule: "7,37 * * * *", recurring: true, durable: false } },
    // And a daily one with a long prompt, the way they usually are: it's called by its first sentence.
    T.tool("fl2", "CronCreate", { cron: "53 8 * * *", prompt: "Daily open-PR check for Acme-AI/platform (this post is the report). 1. Run: gh pr list --repo Acme-AI/platform --state open --limit 100 --json number,title,author,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid 2. Compare with yesterday's snapshot: new PRs, merged ones, new commits, new reviews, conflicts. 3. Update the open-PRs table and post one update with what changed, or \"No changes to open PRs\".", recurring: true }, 3505),
    { type: "user", timestamp: at(3504), message: { content: [{ type: "tool_result", tool_use_id: "fl2", content: "Scheduled recurring job 9c3d7e1b (53 8 * * *)." }] }, toolUseResult: { id: "9c3d7e1b", humanSchedule: "53 8 * * *", recurring: true, durable: false } },
    ...T.fire("5e1f0c2a", "check CI on #16613 and fix what broke", "7,37 * * * *", 2700), T.say("CI is red on #16613: unit (core-api) fails on a fixture the eval still imports. Kept it; pushed.", 2600),
    ...T.fire("5e1f0c2a", "check CI on #16613 and fix what broke", "7,37 * * * *", 900), T.say("CI is green on #16613. Nothing to fix.", 860),
    T.prompt("open the next PR", 200), T.tool("f2", "Bash", { command: "gh pr create", description: "Open pull request 2 of 3" }, 64),
  ],
});
await post(`${finch}/post`, { title: "Cut dead tests from core-api", text: "About 20k of the suite's 253k lines can go now, and 8k more can collapse into parametrized tests. Three pull requests." });
await post(`${finch}/updates`, { text: "Opened PR #16613: removes 4,213 lines of dead code and its tests", link: "https://github.com/Acme-AI/platform/pull/16613" });
await post(`${finch}/attachments`, { key: "cuts", type: "table", title: "What can go", data: { columns: ["Area", "Lines", "Status"], rows: [{ Area: "Dead code and its tests", Lines: "4,213", Status: "PR open" }, { Area: "Duplicate scenario files", Lines: "7,900", Status: "Next" }, { Area: "Parametrizable cases", Lines: "8,100", Status: "Needs you" }] } });
await post(`${finch}/todos`, { text: "Review PR #16613" });
await post(`${finch}/status`, { state: "working", turn: "start" });
await post("/api/pins", { post: "finch-0000-4000-8000-demo-finch", pinned: true });

// wren: done yesterday-ish, with a summary
const wren = await session({
  proc: "demo-wren", label: "wren", repo: "platform", branch: "gcp-billing",
  entries: [T.title("Delete unused BigQuery datasets"), T.prompt("delete unused bq datasets", 9000), ...Array.from({ length: 12 }, (_, i) => [T.tool(`w${i}`, "Bash", { command: `bq rm ${i}`, description: `Delete dataset ${i + 1} of 9` }, 8000 - i * 300), T.ok(`w${i}`, 7990 - i * 300)]).flat(), T.took(4_320_000)],
});
await post(`${wren}/post`, { title: "Deleted 9 unused BigQuery datasets", text: "None had a read in 90 days. The billing export shows storage down about $410 a month." });
await post(`${wren}/attachments`, { key: "savings", type: "metric", title: "BigQuery storage", data: { value: "$1,240", unit: "a month", change: "−$410", good: "down", vs: "since the cleanup", series: [1650, 1660, 1655, 1640, 1240, 1238] } });
await post(`${wren}/updates`, { text: "Deleted all 9 datasets, with your approval for each" });
await post(`${wren}/gone`, { reason: "Ended" });

// kite: idle in the composer-options worktree, its work not on main yet
const kite = await session({
  proc: "demo-kite", label: "kite", repo: "dashy", branch: "worktree-composer-options", cwd: COMPOSER_TREE,
  entries: [
    T.title("Quieter composer options"), T.prompt("make the composer options quieter", 5400), T.took(1_800_000),
    // A check it set itself (no /loop): it looks again once, when it said.
    T.tool("kw1", "ScheduleWakeup", { delaySeconds: 1500, prompt: "Check that main's smoke test passes with quail's change in, then commit the option styles. Report on the thread either way.", reason: "quail's smoke tests take about 20 minutes" }, 300),
    { type: "user", timestamp: at(299), message: { content: [{ type: "tool_result", tool_use_id: "kw1", content: "ok" }] }, toolUseResult: { scheduledFor: Date.now() + 1200e3, clampedDelaySeconds: 1500, wasClamped: false } },
  ],
});
await post(`${kite}/post`, { title: "Quieter composer options", text: "Each option shows what it's set to, and stays quiet on its default." });
await post(`${kite}/updates`, { text: "Committed model and effort in one menu. The option styles aren't committed yet." });
await post(`${kite}/files`, { name: "composer-phone.png", title: "The composer on a phone", content_base64: phone({ accent: "#8a5cf6" }).toString("base64") });
await post(`${kite}/status`, { state: "idle", turn: "end" });
// egret: its turn is over, and three subagents it started in the background: one still auditing, one done, one that
// failed. Each one's steps are in its own transcript, a step's result when it has one ([name, input, ago, took, error]).
const EGRET_SUBS = path.join(HOME, "egret", "subagents");
fs.mkdirSync(EGRET_SUBS, { recursive: true });
const launched = (id: string, agentId: string, description: string, ago: number) => ({ type: "user", timestamp: at(ago), message: { content: [{ type: "tool_result", tool_use_id: id, content: `Async agent launched successfully.\nagentId: ${agentId}` }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId, description } });
const core = (f: string) => path.join(DEV, "platform", "core-api", "src", f);
// A subagent's step: a tool it called ([name, input, seconds ago, seconds it took, its error]), or what it said (["say", text]).
type Step = [name: string, input: string | object, ago?: number, took?: number, error?: string];
const workers: [agentId: string, toolUseId: string, description: string, steps: Step[]][] = [
  ["a7c1", "ea1", "Find N+1 queries in core-api", [
    ["Grep", { pattern: "findMany\\(", path: "core-api/src" }, 1540, 2],
    ["Read", { file_path: core("orders/list.ts") }, 1500, 1],
    ["Read", { file_path: core("customers/repo.ts") }, 1460, 1],
    ["say", "The orders list loads each order's customer in a query of its own: 50 orders, 51 queries."],
    ["Grep", { pattern: "include: \\{ customer", path: "core-api/src" }, 1380, 2],
    ["Bash", { command: "npm run test -- orders", description: "Run the orders tests" }, 1200, 64],
    ["Edit", { file_path: core("orders/list.ts") }, 900, 1],
    ["Bash", { command: "npm run bench -- orders", description: "Benchmark the orders endpoint" }, 40],
  ]],
  ["a7c2", "ea2", "Check the ledger's indexes", [
    ["Read", { file_path: path.join(DEV, "platform", "ledger", "schema.sql") }, 1540, 1],
    ["Bash", { command: "psql ledger -c 'EXPLAIN ANALYZE …'", description: "Explain the orders page's ledger queries" }, 1300, 9],
    ["say", "Every query the orders page makes uses an index."],
  ]],
  ["a7c3", "ea3", "Profile the orders page in a browser", [
    ["Bash", { command: "npx playwright test orders.perf", description: "Profile the orders page" }, 1520, 30, "Error: browserType.launch: Executable doesn't exist"],
    ["Bash", { command: "npx playwright install chromium", description: "Install Chromium for Playwright" }, 1480],
  ]],
];
for (const [agentId, toolUseId, description, steps] of workers) {
  fs.writeFileSync(path.join(EGRET_SUBS, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description, toolUseId }));
  const lines = steps.flatMap<object>(([name, input, ago, took, error], i) => {
    if (name === "say") return [T.say(String(input), steps[i - 1][2] - (steps[i - 1][3] || 0) - 5)];
    const id = `${agentId}-${i}`;
    return [T.tool(id, name, input, ago), ...(took == null ? [] : [error ? T.fail(id, error, ago - took) : T.ok(id, ago - took)])];
  });
  fs.writeFileSync(path.join(EGRET_SUBS, `agent-${agentId}.jsonl`), lines.map((e) => JSON.stringify({ ...e, isSidechain: true })).join("\n") + "\n");
}
const egret = await session({
  proc: "demo-egret", label: "egret", repo: "platform", branch: "main",
  entries: [
    T.title("Why is the orders page slow?"), T.prompt("why is the orders page slow? check core-api and the ledger", 1600),
    T.tool("ea1", "Agent", { description: "Find N+1 queries in core-api", prompt: "Find N+1 queries on the orders path", run_in_background: true }, 1560), launched("ea1", "a7c1", "Find N+1 queries in core-api", 1559),
    T.tool("ea2", "Agent", { description: "Check the ledger's indexes", prompt: "Check the ledger tables the orders page reads for missing indexes", run_in_background: true }, 1555), launched("ea2", "a7c2", "Check the ledger's indexes", 1554),
    T.tool("ea3", "Agent", { description: "Profile the orders page in a browser", prompt: "Profile the orders page with Playwright and say where the time goes", run_in_background: true }, 1553), launched("ea3", "a7c3", "Profile the orders page in a browser", 1552),
    T.say("Three subagents are on it: one looking for N+1 queries in core-api, one checking the ledger's indexes, one profiling the page in a browser. I'll put what they find together here.", 1550),
    { type: "user", timestamp: at(1100), message: { content: '<task-notification>\n<task-id>a7c3</task-id>\n<tool-use-id>ea3</tool-use-id>\n<status>failed</status>\n<summary>Agent "Profile the orders page in a browser" failed: API Error: overloaded</summary>\n</task-notification>' } },
    { type: "user", timestamp: at(900), message: { content: '<task-notification>\n<task-id>a7c2</task-id>\n<tool-use-id>ea2</tool-use-id>\n<status>completed</status>\n<summary>Agent "Check the ledger\'s indexes" finished</summary>\n</task-notification>' } },
    T.say("The ledger's indexes are fine: every query the orders page makes uses one. The browser profile failed on an API error; I'll skip it unless the core-api audit comes up empty. Still waiting on that one.", 880),
  ],
});
// Its headline comes below, once its task is there.
await post(`${egret}/status`, { state: "idle", turn: "end" });

const swift = await session({
  proc: "demo-swift", label: "swift", repo: "dashy", branch: "fix-flaky-smoke", cwd: path.join(DEV, "dashy", ".claude", "worktrees", "fix-flaky-smoke"),
  entries: [T.title("Fix the flaky smoke test"), T.prompt("the smoke test fails now and then on a slow start, fix it", 7200), T.took(600_000)],
});
await post(`${swift}/post`, { title: "The smoke test waits for the server", text: "It failed now and then when the server took over a second to start." });
await post(`${swift}/gone`, { reason: "Ended" });
// sandpiper: how its turns went, on their replies: each reply's verdict and what it didn't check,
// as it said them with ab_verdict and ab_checks, its text folded under them, and the latest's suggested replies.
const sandpiper = await session({
  proc: "demo-sandpiper", label: "sandpiper", repo: "platform", branch: "fix-cart-tax-batch",
  // Its second turn edits the totals code, so that turn ends with a Changes line: a chip on its reply (A).
  entries: [T.title("Why did checkout get slow on Tuesday?"), T.prompt("checkout p95 doubled since tuesday afternoon, mostly on big carts. find out why", 4200), T.tool("sp1", "Edit", { file_path: path.join(DEV, "platform/core-api/cart/totals.ts") }, 700), T.edit("sp1", path.join(DEV, "platform/core-api/cart/totals.ts"), "for (const line of lines) {\n  const rate = await ledger.taxRate(line.code);\n  line.tax = line.net * rate;\n}\n", "const rates = await ledger.taxRates(lines.map((l) => l.code));\nfor (const line of lines) {\n  line.tax = line.net * rates[line.code];\n}\n", 699), T.took(2_700_000)],
});
await post(`${sandpiper}/post`, { title: "Checkout p95 back to 310 ms", text: "a41c9e asked the ledger for a tax rate per cart line. Carts now look them all up in one call." });
await post(`${sandpiper}/messages`, { from: "human", via: "terminal", text: "checkout p95 doubled since tuesday afternoon, mostly on big carts. find out why", at: at(4200) });
await post(`${sandpiper}/shape`, { verdict: "found", line: "a41c9e asks the ledger once per cart line, so carts over 20 lines got 6× slower" });
await post(`${sandpiper}/shape`, {
  checks: [{ status: "not_checked", label: "Mobile checkout (/v2/cart/summary)", detail: "It totals carts its own way; I read only the web cart's code" }],
});
// Its chart (ab_chart): p95 every 2 hours, Monday to Wednesday, by cart size, a line where a41c9e went out.
{
  const hours = Array.from({ length: 30 }, (_, i) => i * 2);
  const x = hours.map((h) => `${["Mon", "Tue", "Wed"][Math.floor(h / 24)]} ${String(h % 24).padStart(2, "0")}:00`);
  const wobble = (i: number, k: number) => Math.round(Math.sin(i * 1.7 + k) * 18);
  const after = (h: number) => h >= 38; // Tue 14:00
  await post(`${sandpiper}/shape`, {
    chart: {
      title: "Checkout p95 by cart size, Monday to Wednesday",
      x,
      series: [
        { name: "Over 20 lines", values: hours.map((h, i) => (after(h) ? 2380 : 640) + wobble(i, 0) * 3) },
        { name: "Up to 20 lines", values: hours.map((h, i) => (after(h) ? 330 : 300) + wobble(i, 2)) },
      ],
      unit: "ms",
      target: { value: 800, label: "SLO 800 ms" },
      markers: [{ x: "Tue 14:00", label: "a41c9e deployed" }],
    },
  });
}
await post(`${sandpiper}/messages`, {
  from: "agent",
  at: at(3900),
  text: "The deploy at 14:02 Tuesday (a41c9e, “Show tax per line in the cart”) moved the tax lookup into the loop over cart lines: `core-api/cart/totals.ts:88` now calls `ledger.taxRate()` once per line, one after another. Small carts barely changed, which is why the median looks fine; wholesale customers are most of the carts over 20 lines, so they're the ones who noticed.\n\nThree ways to fix it: batch the lookup (one `ledger.taxRates()` call per cart, which invoicing already uses), cache rates for 5 minutes (rates go stale at month end), or revert a41c9e (takes away tax per line, which wholesale asked for). I'd batch it.",
});
await post(`${sandpiper}/messages`, { from: "human", text: "Batch it", at: at(3500) });
// A question it asked that turn, answered: a chip on the reply too (A).
{
  const sq = await post(`${sandpiper}/questions`, { title: "Batch size: 200 (the ledger's limit) or 100 to be safe?", options: ["200", "100"] });
  await post(`/api/questions/${sq.id}/answer`, { value: "200" });
}
await post(`${sandpiper}/shape`, { verdict: "done", line: "Carts look up their tax in one call. p95 is 310 ms, down from 820" });
// To-dos for the person, with their answers as buttons on the reply (ab_todo, C). Two of them, so a click picks and
// Send says both.
await post(`${sandpiper}/todos`, { text: "Batch mobile checkout too?", note: "/v2/cart/summary has the same loop; same fix, about an hour.", answers: [{ label: "Yes, batch it", says: "Batch mobile checkout too" }, { label: "Leave it", says: "Leave mobile checkout as it is" }] });
await post(`${sandpiper}/todos`, { text: "Tell wholesale it's fixed?", note: "Three of them wrote to support about slow checkout this week.", answers: [{ label: "Draft it", says: "Draft the note to wholesale" }, { label: "I'll tell them" }, { label: "Not yet" }] });
await post(`${sandpiper}/shape`, {
  stages: [
    { text: "Read the totals code and a41c9e's diff", minutes: 4 },
    { text: "Reproduced it: a 30-line cart takes 2.4 s", minutes: 5 },
    { text: "Cached the rates for 5 minutes", minutes: 8, dead: "Rates go stale at month end, when finance changes them" },
    { text: "Called the ledger in parallel", minutes: 5, dead: "The ledger allows 20 calls a second; big carts hit it" },
    { text: "Batched the lookup: one ledger.taxRates() call per cart", minutes: 14 },
    { text: "43 tests, and a load test: p95 310 ms", minutes: 9 },
  ],
});
await post(`${sandpiper}/shape`, { draft: { kind: "pull_request", title: "Batch the cart's tax lookup", branch: "fix-cart-tax-batch", base: "main", repo: "acme/platform", body: "Cart totals looked up a tax rate per line since a41c9e, so carts over 20 lines got 6× slower. They now look up all of a cart's tax codes in one `ledger.taxRates()` call, in batches of 200, and fall back to one call per line if the batch fails.\n\n- 43 checkout tests pass, 2 of them new\n- Load test, 200 rps for 5 min: p95 820 → 310 ms" } });
await post(`${sandpiper}/shape`, { items: [{ text: "If the batch call fails, totals falls back to one call per line", note: "So a ledger outage makes checkout slow, not broken" }, { text: "Carts over 200 lines go in batches of 200" }] });
await post(`${sandpiper}/shape`, {
  checks: [
    { status: "failed", label: "Lint", detail: "2 errors in cart/legacy.ts, the same on main" },
    { status: "not_checked", label: "Production data", detail: "Only the load-test fixtures", do: "Try it on a copy of production's carts" },
  ],
});
await post(`${sandpiper}/shape`, { replies: ["Open the PR", "Show me the load test", "Fix mobile too", "Not now"] });
await post(`${sandpiper}/messages`, {
  from: "agent",
  at: at(600),
  text: "`cart/totals.ts` now collects the cart's tax codes and asks the ledger for all of them in one `ledger.taxRates()` call, in batches of 200; the loop over lines only reads the answer. The load test at 200 rps has p95 at 310 ms, from 820, with errors unchanged at 0.02%. If the batch call fails, totals falls back to one call per line, so a ledger outage makes checkout slow, not broken. Mobile checkout (`/v2/cart/summary`) has the same loop and I left it alone.",
});
await post(`${sandpiper}/status`, { state: "idle", turn: "end" });

// tern: an email it drafted, and times for a call, each with its button (ab_draft, ab_slots).
const tern = await session({ proc: "demo-tern", label: "tern", repo: "platform", branch: "main", entries: [T.title("Ask Ledgerly to raise our batch limit"), T.prompt("ask ledgerly to raise our taxRates batch limit, and find a time for a call with them next week", 900), T.took(240_000)] });
await post(`${tern}/post`, { title: "Ask Ledgerly to raise our batch limit", text: "Wholesale carts go up to 600 lines; their batch limit is 200." });
await post(`${tern}/messages`, { from: "human", via: "terminal", text: "ask ledgerly to raise our taxRates batch limit, and find a time for a call with them next week", at: at(900) });
const nextWeek = (d: number, h: number) => {
  const t = new Date();
  t.setDate(t.getDate() + ((8 - t.getDay()) % 7 || 7) + d);
  t.setHours(h, 0, 0, 0);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`;
};
await post(`${tern}/shape`, { verdict: "needs_you", line: "The email's ready to send, and you're both free at 7 times next week" });
await post(`${tern}/shape`, { draft: { kind: "email", to: ["support@ledgerly.io"], cc: ["finance@acme.dev"], from: "herval@acme.dev", subject: "Raising our taxRates batch limit", body: "Hi Ledgerly team,\n\nAcme's checkout now looks up a cart's tax rates in one taxRates() call. Wholesale carts go up to 600 lines, and your batch limit is 200, so a big cart takes three calls. Could you raise our limit to 1,000 lines a call? We're at about 40 batch calls a minute at peak, well under our plan's 120.\n\nWould a 30-minute call next week help? I've suggested a few times below.\n\nThanks,\nHerval" } });
await post(`${tern}/shape`, { slots: { title: "Call with Ledgerly", minutes: 30, with: "support@ledgerly.io", times: [{ at: nextWeek(0, 10) }, { at: nextWeek(0, 15) }, { at: nextWeek(1, 11), best: true }, { at: nextWeek(1, 14) }, { at: nextWeek(2, 9) }, { at: nextWeek(3, 15), best: true }, { at: nextWeek(4, 10) }] } });
await post(`${tern}/messages`, { from: "agent", at: at(700), text: "I kept it to the one ask, with the numbers they'll want. Their docs say limit changes go through support, and the 120 calls a minute is from our contract." });
await post(`${tern}/status`, { state: "idle", turn: "end" });

const lark = await session({ proc: "demo-lark", label: "lark", repo: "platform", entries: [T.title("Dinner on Friday, and the Tokyo fare"), T.prompt("find somewhere for dinner friday, 4 of us near principe real. and how's the tap fare to tokyo?", 600), T.took(90_000)] });
await post(`${lark}/post`, { title: "Dinner on Friday, and the Tokyo fare", text: "Two places that take 4 at 20:30; the fare is close to your limit." });
await post(`${lark}/messages`, { from: "human", via: "terminal", text: "find somewhere for dinner friday, 4 of us near principe real. and how's the tap fare to tokyo?", at: at(600) });
const fare = Array.from({ length: 30 }, (_, i) => Math.round(842 - i * 0.9 + Math.sin(i * 0.9) * 14 - (i === 17 ? 40 : 0)));
fare[29] = 812;
await post(`${lark}/shape`, {
  cards: [
    { title: "Tasca do Chico", text: "Fado, small and loud, the real thing", facts: ["★ 4.6", "€€", "6 min walk"], badge: "Takes 4 at 20:30", actions: [{ label: "Book 20:30" }, { label: "Another time", says: "Find another time at Tasca do Chico on Friday." }] },
    { title: "Pharmacia", text: "Terrace over the river, good with groups", facts: ["★ 4.4", "€€", "9 min walk"], badge: "Takes 4 at 20:30, outside", actions: [{ label: "Book 20:30" }] },
    { title: "TAP, Lisbon → Tokyo", text: "Nov 14–28, economy, 1 stop", facts: ["checked 10 min ago"], price: { value: 812, unit: "€", limit: 800, series: fare, from: "30 days ago", to: "today" }, actions: [{ label: "Buy at €812" }, { label: "Keep watching", says: "Keep watching the Tokyo fare; tell me when it's under €800." }] },
  ],
  pick: "one",
});
await post(`${lark}/messages`, { from: "agent", at: at(560), text: "Both take a table of 4 at 20:30. The fare's been falling for a week; it was €802 three weeks ago, never under €800." });
await post(`${lark}/status`, { state: "idle", turn: "end" });

// curlew: setups that go together, as cards (ab_cards, pick "several"): pick some, then Continue sends them at once.
const curlew = await session({ proc: "demo-curlew", label: "curlew", repo: "platform", entries: [T.title("What to watch on checkout"), T.prompt("what should we be watching on checkout that we aren't?", 500), T.took(240_000)] });
await post(`${curlew}/post`, { title: "What to watch on checkout", text: "Four things nobody watches today; each can be set up on its own." });
await post(`${curlew}/messages`, { from: "human", via: "terminal", text: "what should we be watching on checkout that we aren't?", at: at(500) });
await post(`${curlew}/shape`, { verdict: "needs_you", line: "4 setups, none needs the others. Pick the ones you want" });
await post(`${curlew}/shape`, {
  cards: [
    { title: "1. Tax lookups per cart", text: "Count taxRates() calls per cart, and alert when a cart takes more than 3.", facts: ["core-api", "a Datadog monitor"], badge: "Biggest gap", actions: [{ label: "Set up the alert" }, { label: "Only a chart", says: "Only a chart for tax lookups per cart, no alert." }] },
    { title: "2. Failed payments by reason", text: "A weekly table of declines by reason and card brand, from the ledger.", facts: ["ledger", "weekly"], actions: [{ label: "Set this up" }] },
    { title: "3. Slow carts", text: "Carts over 2 s to price, with the step that took longest.", facts: ["core-api", "traces"], actions: [{ label: "Set this up" }] },
    { title: "4. ERP sync lag", text: "How long an order takes to reach the ERP, and a page when it's over an hour.", facts: ["erp-sync"], actions: [{ label: "Set this up" }] },
  ],
});
await post(`${curlew}/messages`, { from: "agent", at: at(460), text: "None of these exist today. 1 is where the money goes: big wholesale carts take three tax calls each." });
await post(`${curlew}/status`, { state: "idle", turn: "end" });

// dunlin: what matters in a contract it read, marked (ab_highlight with a source). Typed in Claude Desktop's Code
// tab, without agentbook's channel: its chip says "In Desktop", and what was typed there "in Desktop".
const dunlin = await session({ proc: "demo-dunlin", label: "dunlin", repo: "platform", branch: "main", app: "desktop", channel: false, entries: [T.title("What's in the Ledgerly renewal"), T.prompt("before i renew ledgerly: anything in the new contract i should care about?", 400), T.took(180_000)] });
await post(`${dunlin}/post`, { title: "What's in the Ledgerly renewal", text: "3 clauses of 41 matter." });
await post(`${dunlin}/messages`, { from: "human", via: "terminal", text: "before i renew ledgerly: anything in the new contract i should care about?", at: at(400) });
await post(`${dunlin}/shape`, { verdict: "needs_you", line: "3 clauses of 41 matter; one means deciding by Sep 1" });
await post(`${dunlin}/shape`, {
  source: "https://acme.example/contracts/ledgerly-renewal-2026.pdf",
  title: "Ledgerly renewal 2026.pdf, 14 pages",
  items: [
    { text: "This Agreement shall renew automatically for successive periods of twenty-four (24) months unless either party gives written notice of non-renewal no less than ninety (90) days before the end of the then-current term.", mark: "twenty-four (24) months", where: "p. 4, §7.2", label: "Changed", note: "It was 12 months and 30 days. To leave at the end of this term, cancel by Sep 1." },
    { text: "Fees for Batch API calls exceeding the Committed Volume shall be charged at USD 0.004 per line item, invoiced monthly in arrears.", mark: "USD 0.004 per line item", where: "p. 9, §12.1", label: "New", note: "Batch overage wasn't priced before. At our peak, 600-line carts, about $70 a month." },
    { text: "Provider may modify rate limits upon thirty (30) days' notice, provided such limits are no less favourable than those in Schedule B.", mark: "thirty (30) days' notice", where: "p. 11, §14.3", label: "Fine", note: "Schedule B keeps our 200 lines a call, which the batch fix needs." },
  ],
});
await post(`${dunlin}/shape`, { replies: ["Renew it", "Ask them to keep 12 months", "Not now"] });
await post(`${dunlin}/messages`, { from: "agent", at: at(300), text: "The rest is the same as last year's: support hours, the SLA (99.9%), data residency in the EU." });
await post(`${dunlin}/status`, { state: "idle", turn: "end" });
// starling: a task dunlin started in Claude Desktop (its start_session): its thread says "from dunlin", and dunlin's
// lists it under Threads it started.
const starling = await session({ proc: "demo-starling", label: "starling", repo: "platform", branch: "main", app: "desktop", channel: false, entries: [T.title("Ask Ledgerly to keep 12-month terms"), T.prompt("Background (from the session that started this one):\nThe Ledgerly renewal moves auto-renewal from 12 to 24 months, with 90 days' notice (§7.2).\n\nTask:\nDraft the email asking Ledgerly to keep 12-month terms and 30 days' notice.", 240), T.took(60_000)] });
await post(`${starling}/post`, { title: "Ask Ledgerly to keep 12-month terms", text: "A draft to Ledgerly's account manager." });
await post(`${starling}/messages`, { from: "human", via: "terminal", at: at(240), text: "Background (from the session that started this one):\nThe Ledgerly renewal moves auto-renewal from 12 to 24 months, with 90 days' notice (§7.2).\n\nTask:\nDraft the email asking Ledgerly to keep 12-month terms and 30 days' notice." });
await post(`${starling}/messages`, { from: "agent", at: at(200), text: "Drafted: it asks to keep 12-month terms and 30 days' notice, and offers the 24 months if the batch overage goes." });
await post(`${starling}/status`, { state: "idle", turn: "end" });

// petrel: changes dashy's app.js, and its turn's "Changed" line opens to how far its change reaches.
const PETREL_APP = SRC.app.replace('  if (w.type === "metric") return metric(w);', '  if (w.type === "metric") return metric(w);\n  if (w.type === "list") return bullets(w);');
const petrel = await session({ proc: "demo-petrel", label: "petrel", repo: "dashy", branch: "main", entries: [T.title("List widgets as bullet lists"), T.prompt("render list widgets as bullet lists", 300), T.tool("p1", "Edit", { file_path: DASHY("plugin/ui/app.js") }, 200), T.edit("p1", DASHY("plugin/ui/app.js"), SRC.app, PETREL_APP, 199), T.took(120_000)] });
await post(`${petrel}/post`, { title: "List widgets as bullet lists", text: "A list widget showed as a table with one column." });
await post(`${petrel}/status`, { state: "working", turn: "start" });
await post(`${petrel}/messages`, { from: "agent", at: at(150), text: "Lists render as bullets now, in the board's renderWidget." });
await post(`${petrel}/status`, { state: "idle", turn: "end" });

// avocet: makes dashy's embeds look right on phones, with what it saw as pictures: its
// screenshots lead its card and the Pictures view, its replies compare before and after, three layouts, both
// sizes and the numbers that moved, it draws how an embed reaches the board, and links read as cards. Its long turn
// has enough steps for "Where the time went", a plan for the plan bar, and a question that kept it waiting.
const SHOTS = path.join(HOME, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (name: string, png: Buffer) => {
  fs.writeFileSync(path.join(SHOTS, name), png);
  return path.join(SHOTS, name);
};
const AVOCET = {
  before: shot("phone-before.png", phone({ embed: "broken" })),
  after: shot("phone-after.png", phone({ embed: "ok" })),
  desk: shot("board-desktop.png", board({ embed: "ok", layout: "wide" })),
  wide: shot("layout-wide.png", board({ layout: "wide" })),
  grid: shot("layout-grid.png", board({ layout: "grid" })),
  tab: shot("layout-tab.png", board({ layout: "tab" })),
  blank: shot("board-blank.png", board({ embed: "broken", layout: "grid" })),
};
const EMBED_CSS = { before: NEXT.css, after: NEXT.css.replace("  min-height: 240px;\n", "  min-height: 240px;\n  aspect-ratio: 16 / 10;\n}\n\n@media (max-width: 600px) {\n  .embed { grid-column: 1 / -1; }\n  .embed iframe { aspect-ratio: 3 / 4; min-height: 0; }\n") };
const EMBED_TEST = 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { addWidget } from "../plugin/server/server.mjs";\n\ntest("an embed that refuses frames gets a link card", () => {\n  const board = { widgets: [] };\n  addWidget(board, { id: "x", type: "embed", data: { url: "https://x.com" } });\n  assert.equal(board.widgets[0].fallback, "link");\n});\n';
const WIDGETS = ["metric", "chart", "table", "list", "note", "embed", "image", "link", "status", "progress", "kanban", "calendar", "map", "feed", "code", "diff", "timeline", "gauge", "sparkline", "heatmap"];
const AVOCET_DOC ="# Embeds\n\nAn embed shows a web page, or HTML its agent wrote, in a sandboxed frame.\n\n## On a phone\nFull width, 3:4 under 600px.\n\n## Sites that refuse frames\nx.com, github.com and Google's sign-in send X-Frame-Options or frame-ancestors,\nso they show as a link card instead.\n\n## How it reaches the board\nThe server checks the widget; the board's frame loads the page, never the server.\n";
const AVOCET_SERVER = NEXT.server2.replace("  return { ...widget(w), sandbox: SANDBOX };", "  // Sites that refuse frames show as a link card instead of a blank box.\n  return { ...widget(w), sandbox: SANDBOX, fallback: url && NO_FRAME.test(url) ? \"link\" : null };").replace('const SANDBOX = "allow-scripts";', 'const SANDBOX = "allow-scripts";\nconst NO_FRAME = /^https:\\/\\/(x\\.com|twitter\\.com|github\\.com|accounts\\.google\\.com)\\//;');
const avocet = await session({
  proc: "demo-avocet", label: "avocet", repo: "dashy", branch: "embed-phones",
  entries: [
    T.title("Embeds that look right on phones"),
    T.prompt("embeds look off on phones and some sites are just a blank box. make them look right, and tell me which sites we can't embed", 3700),
    T.say("Taking screenshots of the board at both sizes first.", 3690),
    T.plan("pp1", [todo("Screenshot the board on desktop and phone", "in_progress", "Taking screenshots"), todo("Find which sites refuse frames", "pending"), todo("Size embeds for phones", "pending"), todo("A link card for sites that refuse", "pending"), todo("Tests and new screenshots", "pending")], 3688),
    T.tool("pr1", "Read", { file_path: DASHY("plugin/ui/embed.css") }, 3684), T.ok("pr1", 3683),
    T.tool("pr2", "Read", { file_path: DASHY("plugin/ui/app.js") }, 3678), T.ok("pr2", 3676),
    T.tool("pb1", "Bash", { command: "node scripts/shoot.mjs --sizes 1200,390", description: "Take screenshots of the board with headless Chrome" }, 3660), T.ok("pb1", 3610),
    T.tool("pw1", "WebFetch", { url: "https://x.com" }, 3560), T.fail("pw1", "x.com refuses to be framed (X-Frame-Options: DENY)", 3556),
    T.tool("pw2", "WebFetch", { url: "https://github.com" }, 3540), T.fail("pw2", "github.com refuses to be framed (frame-ancestors 'none')", 3537),
    T.tool("pw3", "WebFetch", { url: "https://grafana.acme.dev" }, 3520), T.ok("pw3", 3515),
    T.tool("pg1", "Grep", { pattern: "iframe", path: DASHY("plugin") }, 3480), T.ok("pg1", 3479),
    T.plan("pp2", [todo("Screenshot the board on desktop and phone", "completed"), todo("Find which sites refuse frames", "completed"), todo("Size embeds for phones", "in_progress", "Sizing embeds for phones"), todo("A link card for sites that refuse", "pending"), todo("Tests and new screenshots", "pending")], 3470),
    T.tool("pe1", "Edit", { file_path: DASHY("plugin/ui/embed.css") }, 3400), T.edit("pe1", DASHY("plugin/ui/embed.css"), EMBED_CSS.before, EMBED_CSS.after, 3399),
    T.tool("pe2", "Edit", { file_path: DASHY("plugin/server/server.mjs") }, 3370), T.edit("pe2", DASHY("plugin/server/server.mjs"), NEXT.server2, AVOCET_SERVER, 3369),
    T.tool("pe3", "Write", { file_path: DASHY("test/embed.test.mjs") }, 3340), T.created("pe3", DASHY("test/embed.test.mjs"), EMBED_TEST, 3339),
    T.tool("pt1", "Bash", { command: "npm test", description: "Run the tests" }, 3320), T.fail("pt1", "2 failing: embed fallback is undefined", 3270),
    T.tool("pe4", "Edit", { file_path: DASHY("plugin/server/server.mjs") }, 3250), T.ok("pe4", 3249),
    T.tool("pt2", "Bash", { command: "npm test", description: "Run the tests" }, 3230), T.ok("pt2", 3180),
    T.tool("pb2", "Bash", { command: "node scripts/shoot.mjs --layouts wide,grid,tab", description: "Take screenshots of three layouts with headless Chrome" }, 3160), T.ok("pb2", 3120),
    T.tool("pq1", "mcp__plugin_agentbook_agentbook__ab_ask", { title: "Show a screenshot of sites that refuse frames?" }, 3100), T.ok("pq1", 2500),
    T.plan("pp3", [todo("Screenshot the board on desktop and phone", "completed"), todo("Find which sites refuse frames", "completed"), todo("Size embeds for phones", "completed"), todo("A link card for sites that refuse", "in_progress", "Adding a link card"), todo("Tests and new screenshots", "pending")], 2490),
    T.tool("pe5", "Edit", { file_path: DASHY("plugin/ui/app.js") }, 2460), T.ok("pe5", 2459),
    T.tool("pt3", "Bash", { command: "npm test", description: "Run the tests" }, 2440), T.ok("pt3", 2390),
    T.tool("pb3", "Bash", { command: "node scripts/shoot.mjs --sizes 1200,390", description: "Take new screenshots with headless Chrome" }, 2370), T.ok("pb3", 2330),
    T.tool("pl1", "Bash", { command: "npx lighthouse http://localhost:5173 --only-categories=performance --output=json", description: "Measure the board's load before and after" }, 2310), T.ok("pl1", 2240),
    T.plan("pp4", [todo("Screenshot the board on desktop and phone", "completed"), todo("Find which sites refuse frames", "completed"), todo("Size embeds for phones", "completed"), todo("A link card for sites that refuse", "completed"), todo("Tests and new screenshots", "in_progress", "Checking the new screenshots")], 2230),
    T.took(1_480_000),
    T.prompt("nice. also draw how an embed gets from the agent to the board", 1300),
    T.tool("pr3", "Read", { file_path: DASHY("plugin/server/server.mjs") }, 1290), T.ok("pr3", 1289),
    T.tool("pg2", "Grep", { pattern: "sandbox", path: DASHY("plugin") }, 1280), T.ok("pg2", 1279),
    T.tool("pd1", "mcp__plugin_agentbook_agentbook__ab_diagram", { title: "How an embed reaches the board" }, 1200), T.ok("pd1", 1199),
    // Written up, so its turn ends in a "Changed" line with its files as tiles.
    T.tool("pe7", "Write", { file_path: DASHY("docs/embeds.md") }, 1170), T.created("pe7", DASHY("docs/embeds.md"), AVOCET_DOC, 1169),
    T.tool("pe8", "Edit", { file_path: DASHY("README.md") }, 1160), T.edit("pe8", DASHY("README.md"), "# dashy\n\nYour agents, on one page.\n", "# dashy\n\nYour agents, on one page.\n\nEmbeds: see docs/embeds.md.\n", 1159),
    T.tool("pe9", "Edit", { file_path: DASHY("test/embed.test.mjs") }, 1150), T.edit("pe9", DASHY("test/embed.test.mjs"), EMBED_TEST, EMBED_TEST + '\ntest("an embed of a site that frames stays a frame", () => {\n  const board = { widgets: [] };\n  addWidget(board, { id: "g", type: "embed", data: { url: "https://grafana.acme.dev" } });\n  assert.equal(board.widgets[0].fallback, null);\n});\n', 1149),
    // And every widget told its phone size: a turn of 23 files, more than the tiles show, as a big refactor's is (on a
    // phone its line once ran past the screen's edge).
    ...WIDGETS.flatMap((w, i) => [T.tool(`pw${i}`, "Edit", { file_path: DASHY(`plugin/ui/widgets/${w}.mjs`) }, 1140 - i * 2), T.edit(`pw${i}`, DASHY(`plugin/ui/widgets/${w}.mjs`), `export const phone = null;\n`, `export const phone = { height: "auto" };\n`, 1139 - i * 2)]),
    T.took(110_000),
  ],
});
await post(`${avocet}/post`, { title: "Embeds that look right on phones", text: "Embeds were cut off on phones, and sites that refuse frames showed a blank box. Now they fit, and those sites get a link card." });
await post(`${avocet}/status`, { state: "working", turn: "start" });
await post(`${avocet}/messages`, { from: "human", via: "terminal", text: "embeds look off on phones and some sites are just a blank box. make them look right, and tell me which sites we can't embed", at: at(3700) });
// Its screenshots, as files on the thread: they lead its card in the feed.
for (const [file, title] of [[AVOCET.blank, "Board: embeds blank where sites refuse frames"], [AVOCET.before, "Phone: the embed cut off"], [AVOCET.desk, "Board after, desktop"], [AVOCET.after, "Phone after"]]) {
  await post(`${avocet}/files`, { name: path.basename(file), title, content_base64: fs.readFileSync(file).toString("base64") });
}
await post(`${avocet}/messages`, { from: "agent", at: at(3500), text: `Two things are wrong. On a phone the embed keeps its desktop height, so it's cut off; and x.com and github.com refuse to be framed at all (X-Frame-Options, frame-ancestors), so they're a blank box. Background: [Why some sites stay blank in a frame](${DOCS}/blog/framing).` });
await post(`${avocet}/shape`, { compare: { kind: "options", title: "Where an embed goes on the board", pictures: [{ picture: AVOCET.wide, label: "Full width", text: "Below the cards, the whole row", pick: true }, { picture: AVOCET.grid, label: "In the grid", text: "A card like the others" }, { picture: AVOCET.tab, label: "Its own tab", text: "Out of the way, one click to see" }], action: "Go with" } });
await post(`${avocet}/messages`, { from: "agent", at: at(3110), text: "Three ways to place an embed. I'd go with full width: an embed is the one card that needs room. In the grid it's a postage stamp on a phone." });
const pq = await post(`${avocet}/questions`, { title: "x.com and github.com refuse frames. Show a screenshot of them instead, or a link card?", options: ["A link card", "A screenshot"] });
await post(`/api/questions/${pq.id}/answer`, { value: "A link card" });
await post(`${avocet}/messages`, { from: "human", text: "Go with Full width", at: at(2495) });
await post(`${avocet}/updates`, { text: "Embeds go full width, and fit a phone (3:4 under 600px)", link: `${DOCS}/handbook/embeds` });
await post(`${avocet}/updates`, { text: "Sites that refuse frames get a link card: x.com, github.com, accounts.google.com" });
await post(`${avocet}/shape`, { verdict: "done", line: "Embeds fit phones, and sites that refuse frames get a link card", gist: ["Full width on the board; 3:4 under 600px, so nothing's cut off.", "x.com, github.com and Google's sign-in refuse frames: they show as a link card.", "4 tests pass, 1 new."] });
await post(`${avocet}/shape`, { compare: { kind: "before_after", title: "The board on a phone", pictures: [{ picture: AVOCET.before, label: "Before", text: "Cut off, and blank where the site refuses" }, { picture: AVOCET.after, label: "After", text: "Fits the screen" }] } });
await post(`${avocet}/shape`, { checks: [{ status: "not_checked", label: "Safari on iOS", detail: "Only Chrome's phone size" }] });
await post(`${avocet}/messages`, { from: "agent", at: at(2300), text: "Done: embeds fit a phone now, and the sites that won't be framed show as a link card. Drag the line on the picture to compare." });
await post(`${avocet}/shape`, { compare: { kind: "sizes", title: "Both sizes, after", pictures: [{ picture: AVOCET.desk, label: "Desktop, 1200" }, { picture: AVOCET.after, label: "Phone, 390" }] } });
await post(`${avocet}/messages`, { from: "agent", at: at(2280), text: "And both sizes side by side." });
await post(`${avocet}/shape`, { compare: { kind: "numbers", title: "The board's load, before and after", numbers: [{ label: "Largest paint", from: 2.8, to: 1.6, unit: "s", better: "down" }, { label: "Layout shift", from: 0.21, to: 0.02, better: "down" }, { label: "Page weight", from: 1.9, to: 1.2, unit: "MB", better: "down" }, { label: "Lighthouse", from: 71, to: 93, better: "up" }] } });
await post(`${avocet}/shape`, { replies: ["Draw how it works", "Open a PR", "Try Safari too"] });
await post(`${avocet}/messages`, { from: "agent", at: at(2240), text: "The board loads faster too, since a blank frame that never loaded held the paint back." });
await post(`${avocet}/attachments`, { key: "load", type: "chart", title: "Board load, p95 (s)", data: { kind: "line", x: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], series: [{ name: "Desktop", values: [2.1, 2.2, 2.9, 3.0, 2.9, 1.7, 1.6] }, { name: "Phone", values: [3.4, 3.5, 4.6, 4.8, 4.7, 2.4, 2.2] }], unit: "s", target: { value: 2.5, label: "goal" }, markers: [{ x: "Wed", label: "embeds shipped" }, { x: "Sat", label: "this fix" }] } });
await post(`${avocet}/attachments`, { key: "states", type: "diagram", title: "What an embed shows", data: { nodes: [{ id: "req", title: "Agent adds an embed" }, { id: "load", title: "Loading", text: "in a sandboxed frame" }, { id: "shown", title: "Shown", state: "done" }, { id: "refused", title: "Refused", text: "X-Frame-Options", state: "failed" }, { id: "card", title: "Link card", state: "done" }], edges: [{ from: "req", to: "load" }, { from: "load", to: "shown", label: "allowed" }, { from: "load", to: "refused" }, { from: "refused", to: "card" }] } });
await post(`${avocet}/status`, { state: "idle", turn: "end" });
await post(`${avocet}/messages`, { from: "human", via: "terminal", text: "nice. also draw how an embed gets from the agent to the board", at: at(1300) });
await post(`${avocet}/status`, { state: "working", turn: "start" });
await post(`${avocet}/shape`, { diagram: { title: "How an embed reaches the board", nodes: [{ id: "agent", title: "Agent", text: "ab_page_write" }, { id: "server", title: "dashy server", text: "checks the widget" }, { id: "store", title: "Board store" }, { id: "page", title: "Board page" }, { id: "frame", title: "Sandboxed frame", text: "allow-scripts", state: "on" }, { id: "card", title: "Link card", text: "for sites that refuse" }], edges: [{ from: "agent", to: "server", label: "widget" }, { from: "server", to: "store" }, { from: "store", to: "page", label: "live" }, { from: "page", to: "frame", label: "url or html" }, { from: "page", to: "card", label: "refused" }] } });
await post(`${avocet}/messages`, { from: "agent", at: at(1190), text: `Here's the path. The server never fetches the embedded page: the board's frame does, in a sandbox, so a page can't reach the board. Sites on the refuse list skip the frame and get the link card. The handbook has when to embed and when to link: ${DOCS}/handbook/embeds` });
await post(`${avocet}/status`, { state: "idle", turn: "end" });
// dashy is a workspace, so its work in progress sits under it in the sidebar. So is platform, a repo on GitHub:
// its branches with a pull request show as that.
const dashyWs = await post("/api/workspaces", { folder: { path: path.join(DEV, "dashy") } });
// GitHub, connected with a token: platform's pull requests are read as herval, and (below) the issue assigned to him
// and the pull request waiting for his review come in as tasks.
const githubConn = await post("/api/connectors", { kind: "github", api_key: "github_pat_demo", states: ["issues", "reviews"], teams: "Acme-AI" });
const monoWs = await post("/api/workspaces", { repo: MONO });
// Your tasks. Those for a workspace and an agent pick both in the composer when you send them.
const releaseNotes = await post("/api/tasks", { text: "Write the release notes for 0.4" });
// Linked from posts' pages: a task has any number of posts, and a post any number of tasks.
for (const p of ["quail-0000-4000-8000-demo-quail", "kite-0000-4000-8000-demo-kite"]) await post(`/api/tasks/${releaseNotes.id}/link`, { post: p });
// One that three threads work on: its page lists them, and their branches and pull requests, as what it ships.
const bill = await post("/api/tasks", { text: "Cut platform's cloud bill by $2k a month", note: "Storage nobody reads, logs we pay for twice, and CI time on tests that cover dead code.", workspace: monoWs.id });
for (const p of ["wren", "osprey", "finch"]) await post(`/api/tasks/${bill.id}/link`, { post: `${p}-0000-4000-8000-demo-${p}` });
await post("/api/tasks", { text: "Bump the Stripe SDK and fix what breaks", workspace: monoWs.id, agent: "codex" });
await post("/api/tasks", { text: "Make the widget grid denser on phones", workspace: dashyWs.id, agent: "claude" });
// A task is a title and a body: one written too long for a title keeps its start, and the rest goes to its body.
await post("/api/tasks", { text: "Renew the Apple developer account before it lapses on the 30th, and move its billing from my card to the company's", note: "Billing is under Membership details. The receipt goes to finance@acme.dev, see https://developer.apple.com/account" });
// Agents tick off what's done (ab_tasks), and the task says which one did.
const labels = await post("/api/tasks", { text: "Shorten the composer's option labels", workspace: dashyWs.id });
await post(`${kite}/tasks/done`, { ids: [labels.id] });
// Linear, connected: its issues come in as tasks for platform, and ticking one closes it there.
await post("/api/connectors", { kind: "linear", api_key: LINEAR_KEY, workspace: monoWs.id, agent: "claude" });
// GitHub's tasks are platform's.
await post("/api/connectors", { id: githubConn.connector.id, workspace: monoWs.id });

// heron: idle, waiting for a prompt; asks a question with a default, then ends its turn summing up what it's
// about (the question shows under that)
const heron = await session({ proc: "demo-heron", label: "heron", repo: "littleguy", branch: "menubar-ui", entries: [T.title("Build the menubar popover"), T.prompt("build the menubar popover", 3000), T.took(900000)] });
await post(`${heron}/questions`, { title: "Which menubar icon for littleguy?", options: ["Outline|matches the system icons", "Filled", "Status dot|shows when an agent needs you"], default: "Outline", until: "23:45" });
await post(`${heron}/messages`, { from: "agent", via: "terminal", text: "The popover is built: your agents, newest first, with a dot on the ones that need you. The one thing left is the menubar icon; I've asked which one you want, and it goes with the outline if you don't pick." });
await post(`${heron}/status`, { state: "idle", turn: "end", text: "Waiting for your answer" });

// Codex's threads come from its (stand-in) daemon on their own, and its Codex Cloud tasks from `codex cloud
// list`.

// An OpenClaw agent posts through the API.
const reel = await session({ proc: "demo-reel", label: "weekly", agent: "reel", kind: "openclaw", repo: "youtube-channel", branch: "" });
await post(`${reel}/post`, { title: "Weekly channel report", text: "182k views this week, up 12%. Kyoto keeps carrying the channel; the Lisbon Short underperformed." });
await post(`${reel}/attachments`, { key: "videos", type: "table", title: "This week's videos", data: { columns: ["Video", "Views", "Click rate", "vs last week"], rows: [{ Video: "Kyoto at dawn", Views: "61.2k", "Click rate": "3.1%", "vs last week": "+18%" }, { Video: "Tokyo by night", Views: "48.0k", "Click rate": "6.4%", "vs last week": "+9%" }, { Video: "Lisbon in 60 seconds", Views: "29.1k", "Click rate": "7.0%", "vs last week": "−21%" }] } });
await post(`${reel}/attachments`, { key: "views", type: "metric", title: "Views", data: { value: "182k", change: "+12%", good: "up", vs: "vs last week", series: [120, 131, 140, 152, 163, 182] } });
// Its links in <>, as Markdown has them: a link, without the brackets.
await post(`${reel}/messages`, { from: "agent", text: "Report's up. Kyoto at dawn is still the one to beat: <https://example.com/videos/kyoto-at-dawn>" });
await post(`${reel}/status`, { state: "idle", turn: "end" });

// Pages: a reliability dashboard Claude keeps up to date (where Codex broke something and you put it back), an
// exploration Codex made, and a blog post draft. A Codex thread writes once its daemon has listed it.
let codexProc = null;
for (let i = 0; i < 30 && !codexProc; i++) {
  codexProc = (await stateOf((p) => call("GET", p))).sessions.find((s) => s.agent === "codex" && s.proc?.startsWith("codex:") && s.state !== "done")?.proc || null;
  if (!codexProc) await sleep(200);
}
const codexAt = codexProc ? `/api/procs/${encodeURIComponent(codexProc)}` : heron;
// Dates as dates (2026-10-03), so the page's time filter can trim them: the six days before today.
const ymd = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAYS = [6, 5, 4, 3, 2, 1].map(ymd);
const lat = (extra = []) => ({ kind: "line", unit: "ms", x: [...DAYS, ...extra.map(() => ymd(0))], target: { value: 500, label: "500 ms SLO" }, series: [{ name: "core-api", values: [430, 418, 425, 409, 401, 396, ...extra.map((e) => e[0])] }, { name: "erp-sync", values: [455, 470, 560, 610, 500, 452, ...extra.map((e) => e[1])] }, { name: "event-ingest", values: [260, 262, 270, 281, 300, 322, ...extra.map((e) => e[2])] }] });
const rel = await post(`${finch}/pages`, {
  title: "Reliability: platform",
  emoji: "📈",
  about: "SLOs, latency and incidents for the platform services, from Datadog and PagerDuty.",
  summary: "Made the page: uptime, latency, errors, SLOs and incidents",
  widgets: [
    { id: "uptime", type: "metric", title: "Uptime, 30 days", data: { value: "99.94", unit: "%", change: "+0.02 pts", good: "up", vs: "target 99.9%", series: [99.9, 99.91, 99.93, 99.92, 99.94, 99.93, 99.94] } },
    { id: "p95", type: "metric", title: "p95 latency", data: { value: 430, unit: "ms", change: "−22 ms", good: "down", vs: "since yesterday", series: [455, 448, 470, 452, 452, 430] } },
    { id: "err", type: "metric", title: "Error rate", data: { value: "0.19", unit: "%", change: "+0.02 pts", good: "down", vs: "since yesterday", series: [0.18, 0.16, 0.19, 0.17, 0.15, 0.19] } },
    { id: "inc", type: "metric", title: "Open incidents", data: { value: 1, status: { status: "warn", text: "SEV-3, open since 09:12" } } },
    { id: "lat", type: "chart", title: "p95 latency by service, last 7 days", width: "two-thirds", data: lat() },
    { id: "note", type: "note", title: "What changed since yesterday", data: { text: "- **erp-sync** is back under its 500 ms SLO after Tuesday's timeouts (incident #212, resolved).\n- Error rate is up 0.02 pts." } },
    { id: "slo", type: "table", title: "SLOs", width: "half", data: { columns: ["Service", "Target", "30 days", "Error budget left", "Status"], rows: [["core-api", "99.9%", "99.97%", { meter: 78 }, { status: "ok", text: "Met" }], ["erp-sync", "99.9%", "99.91%", { meter: 12 }, { status: "warn", text: "At risk" }], ["event-ingest", "99.5%", "99.62%", { meter: 41 }, { status: "ok", text: "Met" }], ["shop-web", "99.9%", "99.99%", { meter: 93 }, { status: "ok", text: "Met" }], ["pricing", "99.5%", "99.80%", { meter: 66 }, { status: "ok", text: "Met" }]] } },
    { id: "incidents", type: "list", title: "Incidents this week", width: "half", data: { items: [{ status: "warn", label: "Open", text: "event-ingest queue backlog", sub: "SEV-3, since 09:12, PagerDuty #214" }, { status: "ok", label: "Resolved", text: "erp-sync timeouts to the ERP API", sub: "SEV-2, Tuesday, 42 minutes, #212" }, { status: "ok", label: "Resolved", text: "shop-web 502s after a deploy", sub: "SEV-3, Monday, 9 minutes, #209" }] } },
  ],
});
await post(`${quail}/pages`, { page: rel.id, summary: "Hourly refresh", widgets: [{ id: "p95", data: { value: 418, change: "−12 ms", series: [455, 448, 470, 452, 430, 418] } }] }).catch(() => {});
await post(`/api/pages/${rel.id}/contributors`, { agent: "claude" });
await post(`/api/pages/${rel.id}/contributors`, { agent: codexProc ? "codex" : "claude" });
await post(`${codexAt}/pages`, { page: rel.id, summary: "Swapped the SLO table for the Grafana panel", remove: ["slo"], widgets: [{ id: "grafana", type: "link", title: "Grafana: SLOs", width: "half", data: { url: "https://grafana.example.com/d/slos", title: "SLOs, in Grafana", text: "It asks for a Grafana sign-in, so this shows nothing here." } }] });
await post(`/api/pages/${rel.id}/restore`, { v: 2 });
await post(`${quail}/pages`, { page: rel.id, summary: "Hourly refresh", widgets: [{ id: "p95", data: { value: 412, change: "−6 ms", series: [455, 448, 470, 452, 430, 418, 412] } }, { id: "err", data: { value: "0.17", change: "−0.02 pts" } }] });
await post(`${quail}/pages`, {
  page: rel.id,
  summary: "Refreshed latency, error rate and the daily note",
  widgets: [
    { id: "p95", data: { value: 388, change: "−24 ms", series: [455, 448, 470, 452, 430, 412, 388] } },
    { id: "err", data: { value: "0.21", change: "+0.04 pts", series: [0.18, 0.16, 0.19, 0.17, 0.15, 0.17, 0.21] } },
    { id: "lat", data: lat([[384, 431, 341]]) },
    { id: "note", data: { text: "- **erp-sync** is back under its 500 ms SLO after Tuesday's timeouts (incident #212, resolved).\n- **event-ingest** p95 is creeping up: +31% this week, the same backlog as incident #214.\n- Error rate is up 0.04 pts, all of it event-ingest retries." } },
  ],
});
// A widget of its own: a what-if finch built for the error budget, which a routine could feed today's numbers.
const BUDGET_HTML = `<div class="wi">
  <label>SLO<select id="slo"><option>99.5</option><option selected>99.9</option><option>99.95</option><option>99.99</option></select></label>
  <label>Error rate, %<input id="rate" type="number" min="0" max="5" step="0.01"></label>
  <label>Requests, 30 days (M)<input id="req" type="number" min="0.1" max="10000" step="0.1"></label>
</div>
<p class="big" id="out" role="status">…</p>
<div class="bar" aria-hidden="true"><i id="fill"></i></div>
<p class="muted" id="sub"></p>
<div class="acts"><button type="button" id="reset">Today's numbers</button><button type="button" class="primary" id="ask">Ask about this</button></div>
<p class="muted note">Assumes errors spread evenly over the month. Starts from <span id="from">today's numbers</span>.</p>`;
const BUDGET_CSS = `.wi { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: 10px; margin-bottom: 14px; }
.wi label { display: grid; gap: 5px; }
.wi select, .wi input { width: 100%; }
.big { margin: 0 0 8px; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.big.bad { color: var(--red); }
.bar { height: 8px; border-radius: 99px; background: var(--well); overflow: hidden; }
.bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--green); transition: width 0.25s; }
.bar i.warn { background: #e0a100; } .bar i.bad { background: var(--red); }
#sub { margin: 8px 0 12px; font-size: 13.5px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
.note { margin: 12px 0 0; font-size: 12.5px; }`;
const BUDGET_JS = `const $ = (id) => document.getElementById(id);
const today = agentbook.data;
let base = today;
let svc = null;
const fmt = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
let last = null;
function reset() {
  $("slo").value = String(base.slo);
  $("rate").value = base.rate;
  $("req").value = base.requests;
  update();
}
function update() {
  const slo = Number($("slo").value), rate = $("rate").valueAsNumber, req = $("req").valueAsNumber;
  if (!Number.isFinite(rate) || rate < 0 || rate > 5 || !Number.isFinite(req) || req <= 0 || req > 10000) {
    $("out").textContent = "Enter an error rate from 0 to 5% and some requests.";
    $("out").className = "big"; $("sub").textContent = ""; $("fill").style.width = "0"; last = null;
    return;
  }
  const allowed = req * 1e6 * (1 - slo / 100), failing = req * 1e6 * rate / 100, used = failing / allowed;
  const days = used > 0 ? 30 / used : Infinity;
  last = { slo, rate, req, used, days };
  $("out").textContent = used <= 1 ? \`Within budget: uses \${Math.round(used * 100)}% of it\` : \`The budget runs out in \${Math.max(1, Math.floor(days))} days\`;
  $("out").className = used <= 1 ? "big" : "big bad";
  $("fill").style.width = Math.min(100, used * 100) + "%";
  $("fill").className = used > 1 ? "bad" : used > 0.75 ? "warn" : "";
  $("sub").textContent = \`\${fmt(allowed)} failed requests allowed in 30 days at \${slo}%; \${fmt(failing)} at \${rate}% errors.\`;
}
for (const id of ["slo", "rate", "req"]) $(id).addEventListener("input", update);
$("reset").addEventListener("click", reset);
// Narrowed to a service, it starts from that service's numbers.
agentbook.on((page) => {
  const next = page.filters.service && today.services && today.services[page.filters.service] ? page.filters.service : null;
  if (next === svc) return;
  svc = next;
  base = svc ? today.services[svc] : today;
  $("from").textContent = svc ? \`\${svc}'s numbers\` : "today's numbers";
  reset();
});
$("ask").addEventListener("click", () => {
  if (!last) return;
  agentbook.ask(\`On the error budget what-if\${svc ? \` for \${svc}\` : ""}: at \${last.rate}% errors on \${last.req}M requests, a \${last.slo}% SLO \${last.used <= 1 ? \`uses \${Math.round(last.used * 100)}% of its budget\` : \`runs out of budget in \${Math.floor(last.days)} days\`}. Which services would we have to fix to stay inside it?\`);
});
reset();`;
await post(`${finch}/pages`, { page: rel.id, summary: "Added an error budget what-if", widgets: [{ id: "budget", type: "html", title: "Error budget: what if?", width: "half", data: { html: BUDGET_HTML, css: BUDGET_CSS, js: BUDGET_JS, data: { slo: 99.9, rate: 0.21, requests: 42 }, height: 250 } }], order: ["uptime", "p95", "err", "inc", "lat", "note", "budget", "slo", "incidents"] });
// The demo's reliability page, narrowed by service: a Service filter; numbers, the chart, the SLO table and the
// incidents follow it; the what-if starts from the picked service's numbers; and a widget of finch's own reads the
// SLO table and narrows the page to the service you click.
const BURN_HTML = `<div class="bars" id="bars" role="group" aria-label="Error budget left, by service"></div>
<p class="muted note">From the SLO table on this page. Click a service to narrow the page to it.</p>`;
const BURN_CSS = `.bars { display: grid; gap: 6px; }
.row { display: grid; grid-template-columns: 7.5rem 1fr 4.5rem; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; background: none; text-align: left; font-weight: 500; }
.row:hover { background: var(--well); }
.row.on { background: var(--well); box-shadow: inset 0 0 0 1.5px var(--ink); }
.row i { height: 8px; border-radius: 99px; background: var(--well); overflow: hidden; }
.row.on i, .row:hover i { background: #fff; }
.row b { display: block; height: 100%; border-radius: inherit; background: var(--green); }
.row b.warn { background: #e0a100; } .row b.bad { background: var(--red); }
.row small { color: var(--ink-3); text-align: right; }
.note { margin: 10px 0 0; font-size: 12.5px; }`;
const BURN_JS = `const box = document.getElementById("bars");
let shown = "";
// Redrawn only when what it shows changed, so a refresh elsewhere on the page doesn't swap a button under a click.
function draw(page) {
  const slo = page.widgets.find((w) => w.id === "slo");
  const cols = (slo && slo.data.columns) || [];
  const at = cols.indexOf("Error budget left");
  const text = (c) => String(c && typeof c === "object" ? c.text ?? "" : c ?? "");
  const rows = ((slo && slo.data.rows) || []).map((r) => ({ name: text(r[0]), left: Number(r[at] && r[at].meter) })).filter((r) => r.name && Number.isFinite(r.left)).sort((a, b) => a.left - b.left);
  const picked = page.filters.service || null;
  if (!rows.length) return void (box.textContent = "There's no SLO table on this page to read.");
  const key = JSON.stringify([rows, picked]);
  if (key === shown) return;
  shown = key;
  box.replaceChildren(...rows.map((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row" + (picked === r.name ? " on" : "");
    b.setAttribute("aria-pressed", String(picked === r.name));
    const name = document.createElement("span");
    name.textContent = r.name;
    const bar = document.createElement("i");
    const fill = document.createElement("b");
    fill.style.width = r.left + "%";
    fill.className = r.left < 20 ? "bad" : r.left < 50 ? "warn" : "";
    bar.append(fill);
    const pct = document.createElement("small");
    pct.textContent = r.left + "% left";
    b.append(name, bar, pct);
    b.addEventListener("click", () => agentbook.filter("service", picked === r.name ? null : r.name));
    return b;
  }));
}
agentbook.on(draw);`;
await post(`${finch}/pages`, {
  page: rel.id,
  summary: "Narrowed by service: a Service filter, and the widgets that follow it",
  widgets: [
    { id: "service", type: "filter", title: "Service", width: "two-thirds", data: { values: ["core-api", "erp-sync", "event-ingest", "shop-web", "pricing"], all: "All services" } },
    { id: "when", type: "filter", title: "Period", width: "third", data: { kind: "time", values: ["24h", "7d", "30d"], all: "All time" } },
    { id: "uptime", title: "Uptime", data: { vs: "last 30 days", per: { when: { "24h": { value: "100.00", change: "", vs: "last 24 hours" }, "7d": { value: "99.97", change: "+0.01 pts", vs: "last 7 days" }, "30d": { value: "99.94", vs: "last 30 days" } } } } },
    { id: "p95", data: { per: { service: { "core-api": { value: 384, change: "−9 ms", series: [430, 418, 425, 409, 401, 396, 384] }, "erp-sync": { value: 431, change: "−21 ms", series: [455, 470, 560, 610, 500, 452, 431], good: "down" }, "event-ingest": { value: 341, change: "+19 ms", series: [260, 262, 270, 281, 300, 322, 341] }, "shop-web": { value: 212, change: "−2 ms", series: [220, 214, 216, 211, 215, 214, 212] }, pricing: { value: 298, change: "+4 ms", series: [290, 288, 295, 291, 300, 294, 298] } } } } },
    { id: "err", data: { per: { service: { "core-api": { value: "0.08", change: "−0.01 pts" }, "erp-sync": { value: "0.19", change: "−0.05 pts" }, "event-ingest": { value: "0.52", change: "+0.21 pts" }, "shop-web": { value: "0.02", change: "0 pts" }, pricing: { value: "0.11", change: "+0.01 pts" } } } } },
    { id: "inc", data: { per: { service: { "event-ingest": { value: 1 }, "core-api": { value: 0, status: { status: "ok", text: "None open" } }, "erp-sync": { value: 0, status: { status: "ok", text: "None open since Tuesday" } }, "shop-web": { value: 0, status: { status: "ok", text: "None open" } }, pricing: { value: 0, status: { status: "ok", text: "None open" } } } } } },
    { id: "lat", title: "p95 latency by service", data: { match: { service: "series", when: "x" } } },
    { id: "slo", data: { match: { service: "Service" } } },
    { id: "incidents", title: "Incidents", data: { match: { service: "service", when: "at" }, items: [{ status: "warn", label: "Open", text: "event-ingest queue backlog", sub: "SEV-3, since 09:12, PagerDuty #214", service: "event-ingest", at: `${ymd(0)}T09:12:00` }, { status: "ok", label: "Resolved", text: "erp-sync timeouts to the ERP API", sub: "SEV-2, 5 days ago, 42 minutes, #212", service: "erp-sync", at: `${ymd(5)}T14:30:00` }, { status: "ok", label: "Resolved", text: "shop-web 502s after a deploy", sub: "SEV-3, 12 days ago, 9 minutes, #209", service: "shop-web", at: `${ymd(12)}T11:05:00` }] } },
    { id: "budget", data: { data: { slo: 99.9, rate: 0.21, requests: 42, services: { "core-api": { slo: 99.9, rate: 0.08, requests: 18 }, "erp-sync": { slo: 99.9, rate: 0.19, requests: 9 }, "event-ingest": { slo: 99.5, rate: 0.52, requests: 11 }, "shop-web": { slo: 99.9, rate: 0.02, requests: 3 }, pricing: { slo: 99.5, rate: 0.11, requests: 1 } } } } },
    { id: "burn", type: "html", title: "Error budget left, by service", width: "half", data: { html: BURN_HTML, css: BURN_CSS, js: BURN_JS, height: 230 } },
  ],
  order: ["service", "when", "uptime", "p95", "err", "inc", "lat", "note", "burn", "budget", "slo", "incidents"],
});
await post(`/api/pages/${rel.id}/visibility`, { visibility: "public" });

// A routine keeps its numbers up to date: code quail wrote and you OK'd, which has run; and a change to it that
// waits for your OK, since it reaches one more tool.
const NUMBERS = `// Numbers: p95 latency and the error rate, from Datadog's span stats, every 30 minutes. The latency chart is live.
export default async function (ctx) {
  const r = await ctx.tool("datadog", "span_stats", { env: "prod", last: "7d", interval: "1d", group_by: "service" });
  const { days, services, overall } = r.data;
  const delta = (a) => a.at(-1) - a.at(-2);
  return {
    widgets: [
      { id: "p95", data: { value: overall.p95.at(-1), change: \`\${delta(overall.p95) < 0 ? "−" : "+"}\${Math.abs(delta(overall.p95))} ms\`, series: overall.p95 } },
      { id: "err", data: { value: overall.error_rate.at(-1).toFixed(2), series: overall.error_rate } },
    ],
    summary: \`p95 \${overall.p95.at(-1)} ms, errors \${overall.error_rate.at(-1).toFixed(2)}%\`,
  };
}`;
const nr = await post(`${quail}/pages/${rel.id}/routines`, { name: "Numbers", about: "p95 latency and the error rate, from Datadog's span stats.", schedule: "30m", keeps: ["p95", "err"], reach: { tools: ["datadog/span_stats"] }, cant_keep: "Open incidents and the daily note: no tool says what an incident is about.", code: NUMBERS, summary: "p95 and the error rate, from span stats" });
const okq = nr.id && (await stateOf((p) => call("GET", p))).questions.find((q) => q.routine?.rid === nr.id && !q.answered);
if (okq) await post(`/api/questions/${okq.id}/answer`, { value: okq.routine.yes });
for (let i = 0; i < 40 && !(await call("GET", `/api/pages/${rel.id}`)).last?.by?.routine; i++) await sleep(150);
if (nr.id) await post(`${quail}/pages/${rel.id}/routines`, { routine: nr.id, reach: { tools: ["datadog/span_stats", "datadog/list_monitors"] }, code: NUMBERS.replace("const delta", 'const m = await ctx.tool("datadog", "list_monitors", {});\n  ctx.log(m.data.monitors.filter((x) => x.state === "Alert").length, "monitors alerting");\n  const delta'), summary: "Also says how many monitors are alerting" });

// Live while the page is open: the latency chart asks Datadog for the service and period picked on the page, and a
// small explorer asks it for what you choose in it (agentbook.query). Neither makes versions.
const LIVE_LAT = `// Latency, live: p95 by service from Datadog, for the service and period picked on the page, while it's open.
export default async function (ctx) {
  const when = ctx.ranges.when;
  const days = when ? Math.max(1, Math.round((Date.parse(when.to) - Date.parse(when.from)) / 864e5)) : 30;
  const r = await ctx.tool("datadog", "span_stats", { env: "prod", last: \`\${days}d\`, interval: "1d", group_by: "service", ...(ctx.filters.service ? { service: ctx.filters.service } : {}) });
  return { widgets: [{ id: "lat", data: { x: r.data.days, series: r.data.services.map((s) => ({ name: s.name, values: s.p95 })) } }] };
}`;
const EXPLORE = `// Explore: p95 by day for a service, as the explorer asks (ctx.params), or the last 14 days of all of them.
export default async function (ctx) {
  const days = Math.min(30, Math.max(1, Number(ctx.params.days) || 14));
  const r = await ctx.tool("datadog", "span_stats", { env: "prod", last: \`\${days}d\`, interval: "1d", group_by: "service", ...(ctx.params.service ? { service: String(ctx.params.service) } : {}) });
  return { widgets: [{ id: "explore", data: { data: { days: r.data.days, services: r.data.services } } }] };
}`;
const EXPLORE_HTML = `<div class="q">
  <label>Service<select id="svc"><option value="">All</option><option>core-api</option><option>erp-sync</option><option>event-ingest</option></select></label>
  <label>Days<select id="days"><option>7</option><option selected>14</option><option>30</option></select></label>
  <button type="button" class="primary" id="go">Ask Datadog</button>
</div>
<p class="muted" id="st" role="status"></p>
<div class="scroll"><table><thead><tr><th>Day</th></tr></thead><tbody id="rows"></tbody></table></div>`;
const EXPLORE_CSS = `.q { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 8px; }
.q label { display: grid; gap: 5px; }
#st { margin: 0 0 8px; font-size: 12.5px; }
.scroll { max-height: 260px; overflow: auto; }
td.bad { color: var(--red); font-weight: 600; }`;
const EXPLORE_JS = `const $ = (id) => document.getElementById(id);
let mine = false;
function show(d, how) {
  if (!d || !d.days) return void ($("st").textContent = "Nothing yet.");
  const cell = (tag, text, bad) => Object.assign(document.createElement(tag), { textContent: text, className: bad ? "bad" : "" });
  document.querySelector("thead tr").replaceChildren(cell("th", "Day"), ...d.services.map((s) => cell("th", s.name)));
  const day = (iso) => new Date(iso + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  $("rows").replaceChildren(...d.days.map((_, i) => d.days.length - 1 - i).map((i) => {
    const tr = document.createElement("tr");
    tr.append(cell("td", day(d.days[i])), ...d.services.map((s) => cell("td", s.p95[i] + " ms", s.p95[i] > 500)));
    return tr;
  }));
  $("st").textContent = how;
}
$("go").addEventListener("click", async () => {
  mine = true;
  $("st").textContent = "Asking Datadog…";
  try {
    show(await agentbook.query({ service: $("svc").value, days: Number($("days").value) }), "From Datadog, just now. Over 500 ms in red.");
  } catch (err) {
    $("st").textContent = "It failed: " + err.message;
  }
});
show(agentbook.data, "The last 14 days, as the page last got them.");
agentbook.on(() => { if (!mine) show(agentbook.data, "The last 14 days, live. Over 500 ms in red."); });`;
await post(`${finch}/pages`, { page: rel.id, summary: "Added a Datadog explorer", widgets: [{ id: "explore", type: "html", title: "Explore p95 in Datadog", width: "half", data: { html: EXPLORE_HTML, css: EXPLORE_CSS, js: EXPLORE_JS, height: 340, data: null } }], order: ["service", "when", "uptime", "p95", "err", "inc", "lat", "note", "explore", "burn", "budget", "slo", "incidents", "okays"] });
// What finch waits for your OK on, which you answer on the page; your answer goes to finch's thread.
await post(`${finch}/pages`, { page: rel.id, summary: "Asked for an OK", widgets: [{ id: "okays", type: "list", title: "Waits for your OK", width: "half", data: { items: [{ text: "Add a p99 monitor for erp-sync", sub: "A change to .datadog/monitor.json, then the monitor audit", ask: "ok" }] } }] });
for (const [name, about, schedule, keeps, code] of [["Latency, live", "p95 by service from Datadog, for the service and period picked on the page.", "live 15s", ["lat"], LIVE_LAT], ["Explore", "p95 by day from Datadog, for what the explorer asks.", "live 60s", ["explore"], EXPLORE]]) {
  const lr = await post(`${quail}/pages/${rel.id}/routines`, { name, about, schedule, keeps, reach: { tools: ["datadog/span_stats"] }, code, summary: `${name}, while the page is open` });
  const okl = lr.id && (await stateOf((p) => call("GET", p))).questions.find((q) => q.routine?.rid === lr.id && !q.answered);
  if (okl) await post(`/api/questions/${okl.id}/answer`, { value: okl.routine.yes });
}

// Routines that aren't a page's code: a digest by itself every weekday, which has
// run once, in its own thread; a check on heron's thread every 4 hours, which picked it up again; one quail wrote
// for the reliability page, for what needs judgment, which waits for your OK; and one that runs when you run it.
{
  const digestSid = "plover00-0000-4000-8000-demo-plover";
  fs.writeFileSync(path.join(FAKE, "next.txt"), digestSid);
  const dg = await post("/api/routines", { name: "Morning digest", prompt: "Read what my agents did since yesterday morning and post a short digest in this thread: what shipped (with PR links), what's stuck and why, and what needs me today. Keep it under 15 lines.", agent: "claude", root: DEV, schedule: "0 9 * * 1-5" });
  if (dg.id) {
    await post(`/api/routines/${dg.id}/run`);
    let lid = null;
    for (let i = 0; i < 40 && !lid; i++) {
      await sleep(150);
      lid = (await call("GET", `/api/routines/${dg.id}`)).runs?.[0]?.lid;
    }
    const file = transcript("plover", [T.title("Morning digest: Saturday"), T.prompt((await stateOf((p) => call("GET", p))).launches.find((l) => l.id === lid)?.prompt || "Morning digest", 600), T.say("**Shipped**\n- dashy: the embed widget ([#41](https://github.com/herval/dashy/pull/41))\n- platform: daring-swan's retry fix\n\n**Stuck**\n- osprey waits on a permission prompt: `terraform apply` for the SIEM sinks\n\n**Needs you**\n- Review #41, and OK the change to the reliability page's Numbers routine.", 420), T.took(180000)]);
    await post("/api/hello", { proc: "demo-plover", label: "plover", agent: "Claude", kind: "claude-code", session_id: digestSid, transcript: file, cwd: DEV, root: DEV, host: "hervalm5", pid: 1009, launch: lid });
    const asked = (await stateOf((p) => call("GET", p))).launches.find((l) => l.id === lid)?.prompt;
    if (asked) await post("/api/procs/demo-plover/messages", { from: "human", via: "terminal", text: asked });
    await post("/api/procs/demo-plover/messages", { from: "agent", text: "**Shipped**\n- dashy: the embed widget ([#41](https://github.com/herval/dashy/pull/41))\n- platform: daring-swan's retry fix\n\n**Stuck**\n- osprey waits on a permission prompt: `terraform apply` for the SIEM sinks\n\n**Needs you**\n- Review #41, and OK the change to the reliability page's Numbers routine." });
    await post("/api/procs/demo-plover/status", { state: "idle", turn: "end" });
  }
  const heronPost = (await stateOf((p) => call("GET", p))).sessions.find((x) => x.label === "heron")?.id;
  if (heronPost) {
    const dc = await post("/api/routines", { name: "Menubar build check", prompt: "Does the menubar popover still build and open on a clean checkout? Say in one line what broke if it doesn't.", thread: heronPost, schedule: "0 */4 * * *" });
    if (dc.id) await post(`/api/routines/${dc.id}/run`);
  }
  await post(`${quail}/pages/${rel.id}/routines`, { kind: "agent", name: "What needs attention", about: "The note on what changed and what to look at, which code can't write.", prompt: "Read the page with ab_page_read. Rewrite the note widget: what changed since yesterday in latency and errors, which incident it's likely tied to, and what to look at first. Don't touch the widgets Numbers keeps.", schedule: "0 8 * * 1-5", summary: "The daily note, every weekday at 8" });
  const ospreyPost = (await stateOf((p) => call("GET", p))).sessions.find((x) => x.label === "osprey")?.id;
  await post("/api/routines", { name: "Weekly reliability review", prompt: "Go over the week on the reliability page: what got worse, which incidents are still open, and whether the SIEM sinks work landed. Write the review as the page's note, and say in one line what needs me.", agent: "claude", root: DEV, links: [{ kind: "page", id: rel.id }, ...(ospreyPost ? [{ kind: "thread", id: ospreyPost }] : [])], schedule: "0 10 * * 1" });
  await post("/api/routines", { name: "Triage GitHub notifications", prompt: "Go through my unread GitHub notifications. Mark the noise read, and list the ones that need me, one line each, with a link.", agent: "claude", root: DEV, schedule: "manual" });
}

const exp = await post(`${codexAt}/pages`, {
  title: "Explore: tasks on phones",
  emoji: "🧭",
  about: "Where Tasks goes on a phone, where the right column doesn't fit. Three layouts and a pick.",
  widgets: [
    { id: "q", type: "note", title: "The question", width: "full", data: { text: "On a laptop, Tasks is the column on the right. On a phone that column is gone, and Tasks is only reachable from its own page. Where should it live?" } },
    { id: "opts", type: "options", title: "Three layouts", width: "full", data: { items: [{ name: "A tab of its own", pros: ["Always one tap away", "Room for the whole list"], cons: ["A fourth tab in the bar"] }, { name: "Pinned in the feed", pros: ["Nothing new to learn", "Seen every time you open it"], cons: ["Pushes posts down", "Gets long fast"] }, { name: "A sheet from the bell", pick: true, pros: ["Puts what needs you in one place", "No new tab"], cons: ["Tasks hide behind a badge"] }] } },
    { id: "oq", type: "list", title: "Open questions", width: "third", data: { items: [{ text: "Does the bell already open something on phones?" }, { text: "Should the sheet hold the composer too?" }, { text: "Drag the sheet to full height, or a See all link?" }] } },
    { id: "rec", type: "note", title: "Codex's pick", width: "two-thirds", data: { text: "**The sheet from the bell.** The bell already means \"what needs you\", and agents' to-dos (review a PR) are tasks too, so they belong together. It needs no new tab, and the badge counts both." } },
  ],
});
await post(`/api/pages/${exp.id}/color`, { color: "teal" });
await post(`/api/pages/${exp.id}/contributors`, { agent: "claude" });
await post(`${heron}/pages`, { page: exp.id, summary: "Added the comparison table", widgets: [{ id: "cmp", type: "table", title: "How they compare", width: "two-thirds", data: { columns: ["", "A tab", "Pinned", "Sheet"], rows: [["One tap from anywhere", { status: "ok", text: "Yes" }, { status: "idle", text: "Feed only" }, { status: "ok", text: "Yes" }], ["Leaves room for posts", { status: "ok", text: "Yes" }, { status: "bad", text: "No" }, { status: "ok", text: "Yes" }], ["With what needs you", { status: "idle", text: "No" }, { status: "idle", text: "No" }, { status: "ok", text: "Yes" }], ["Work to build", "Medium", "Small", "Medium"]] } }], order: ["q", "opts", "cmp", "oq", "rec"] });
await post(`/api/pages/${exp.id}/write`, { widgets: [{ id: "oq", data: { items: [{ text: "Does the bell already open something on phones?", sub: "No, it scrolls to Needs you." }, { text: "Should the sheet hold the composer too?", sub: "No: what needs you, and Tasks." }, { text: "Drag the sheet to full height, or a See all link?" }] } }] });

const draft = await post(`${kite}/pages`, {
  title: "Draft: Why our agents keep their own dashboards",
  emoji: "✍️",
  about: "A post for the engineering blog. Claude writes it from your notes.",
  widgets: [
    { id: "post", type: "doc", width: "two-thirds", data: { text: "# Why our agents keep their own dashboards\n\nEvery team has the dashboard nobody trusts. It was right the week someone built it, then a service got renamed, a query timed out, and a panel quietly started showing last month. Dashboards don't rot because people are careless. They rot because keeping them right is nobody's job.\n\nSo we gave the job to the agents that already work in our repos. Each of our 31 services has a page an agent keeps up to date, every hour, in the open.\n\n## Agents as maintainers\n\nA page is a set of widgets: numbers, charts, tables, notes. An agent writes them the way it writes code, and every write is a version. When one gets it wrong, we see what changed and put it back in one click.\n\n> The dashboard stopped being a thing we built and became a thing someone looks after.\n\n## What broke\n\n_Still to write._" } },
    { id: "len", type: "metric", stack: "side", width: "third", title: "Length", data: { value: "1,240", unit: "words", vs: "of about 1,500" } },
    { id: "todo", type: "tasks", stack: "side", width: "third", title: "What needs doing", data: { items: [{ text: "Write \"What broke\"", note: "From the incident notes in #reliability", for: "me" }, { text: "Write \"What we'd do again\"", for: "me" }, { text: "Say whether I can name Acme and its repos", note: "Or keep it generic" }, { text: "Write \"Dashboards rot\"", for: "me", done: true }, { text: "Write \"Agents as maintainers\"", for: "me", done: true }] } },
    { id: "ask", type: "note", stack: "side", width: "third", title: "Questions for you", data: { text: "Use the reliability page as the example? It's public already." } },
  ],
});
await post(`/api/pages/${draft.id}/color`, { color: "amber" });

// A question asked from the reliability page: its thread shows the page it's about.
fs.writeFileSync(path.join(FAKE, "next.txt"), "plover-0000-4000-8000-demo-plover");
await post("/api/launch", { prompt: "Which service had the worst p95 this week?", agent: "claude", page: rel.id, root: project("platform") });
const plover = await session({ proc: "demo-plover", label: "plover", repo: "platform", branch: "prod", entries: [T.title("Which service had the worst p95 this week?"), T.prompt("Which service had the worst p95 this week?", 400), T.took(30000)] });
await post(`${plover}/post`, { title: "Which service had the worst p95 this week?", text: "erp-sync, at 610 ms on Oct 6. Answered from the page's latency chart; the page was not changed." });
// Its charts, kept in view: a scatter (each service's p95 against its traffic, by name) and stacked bars (the week's
// requests, each day's by service).
await post(`${plover}/attachments`, {
  key: "p95-vs-traffic",
  type: "chart",
  title: "p95 against traffic, by service",
  data: {
    kind: "scatter",
    series: [{ name: "Services", points: [[42, 180, "platform"], [128, 240, "core-api"], [64, 320, "ledger"], [9, 610, "erp-sync"], [96, 290, "checkout"], [22, 150, "search"], [15, 210, "notifications"]] }],
    unit: "ms",
    x_unit: "k req/day",
    target: { value: 500, label: "SLO 500 ms" },
  },
});
await post(`${plover}/attachments`, {
  key: "requests",
  type: "chart",
  title: "Requests by service, k per day",
  data: {
    kind: "stacked",
    x: ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
    series: [
      { name: "core-api", values: [122, 131, 128, 135, 140, 96, 88] },
      { name: "checkout", values: [90, 94, 99, 101, 112, 120, 104] },
      { name: "ledger", values: [61, 66, 63, 70, 72, 40, 35] },
      { name: "erp-sync", values: [9, 9, 10, 9, 11, 2, 2] },
    ],
    markers: [{ x: "2026-10-31", label: "Sale starts" }],
  },
});
// Its answer says they're attached to the thread: a chip each on the reply, under its text, opening the chart there.
await post(`${plover}/shape`, { verdict: "found", line: "erp-sync had the worst p95: 610 ms on Oct 6" });
await post(`${plover}/messages`, { from: "agent", text: "erp-sync, at 610 ms on Oct 6, on less traffic than any other service. Both charts are attached to the thread." });

// Groups: threads that see each other, a brief they're all told, a note, and files they share.
const threadId = (label: string, proc: string) => `${label}-0000-4000-8000-${proc}`;
const cleanup = await post("/api/groups", { name: "platform cleanup", emoji: "🧹", brief: "Cut what platform doesn't need: dead tests, unused datasets, old log sinks.\n- One pull request per area, each under 2k lines.\n- Write what you cut, and why, in `cuts.md`.\n- Nothing gets deleted in production without asking first.", agents: ["claude"] });
for (const [label, proc] of [["osprey", "demo-osprey"], ["finch", "demo-finch"], ["wren", "demo-wren"]]) await post(`/api/groups/${cleanup.id}/threads`, { post: threadId(label, proc) });
await post(`/api/groups/${cleanup.id}/notes`, { text: "The infra freeze starts Friday: anything touching Terraform lands before then." });
await post(`/api/groups/${cleanup.id}/files`, { path: "plan.md", text: "# Cleanup plan\n\n- [x] BigQuery datasets (wren)\n- [ ] Dead tests in core-api (finch)\n- [ ] SIEM sinks to Datadog (osprey)\n" });
await post(`${finch}/group/files`, { path: "cuts.md", text: "# What we cut\n\n| Area | Lines | Why |\n| --- | --- | --- |\n| Dead code and its tests | 4,213 | No caller since the v2 API |\n| Duplicate scenario files | 7,900 | Same fixtures, three copies |\n" });
await post(`${osprey}/group/files`, { path: "queries/unused-datasets.sql", text: "select table_schema, max(creation_time)\nfrom region-us.INFORMATION_SCHEMA.JOBS\ngroup by 1\nhaving max(creation_time) < timestamp_sub(current_timestamp(), interval 90 day);\n" });
await post(`${finch}/updates`, { text: "Cut 4,213 lines of dead code and its tests: PR #16613" });
// Its tasks: yours, in the group, told to its threads.
await post("/api/tasks", { text: "Ask security before the SIEM sinks go", note: "osprey's PR waits for their OK", group: cleanup.id });
await post("/api/tasks", { text: "Decide whether core-api keeps its contract tests", group: cleanup.id, agent: "claude" });
// A public one: anyone signed in sees it, and the threads in it that are public.
const release = await post("/api/groups", { name: "dashy 0.4", emoji: "🚀", visibility: "public", brief: "Ship dashy 0.4 by Tuesday: the composer's options on one line, and a green smoke test.\n- Land on main; rebase over each other, never force-push.", agents: ["claude"] });
for (const [label, proc] of [["quail", "demo-quail"], ["kite", "demo-kite"], ["swift", "demo-swift"]]) await post(`/api/groups/${release.id}/threads`, { post: threadId(label, proc) });
await post(`/api/groups/${release.id}/files`, { path: "release-notes.md", text: "# dashy 0.4\n\n## The composer\nIts options are one line that opens a panel to change them.\n\n## Also\n- The smoke test no longer flakes on a slow machine.\n" });
// Tasks that ship: the cloud bill's task above gets pull requests put in by hand and a
// landing order, with finch's own (#16613) coming in from its thread; one in the group; and one two threads work on.
const monoPr = (n: number, title: string) => ({ id: `${monoWs.id}-pr${n}`, kind: "pr", title, ref: `#${n}`, repo: "platform", url: `https://github.com/${MONO}/pull/${n}` });
for (const it of [monoPr(16702, "feat(iac/global): pack CI runners onto fewer nodes"), monoPr(16588, "chore(gcp): delete unused BigQuery datasets")]) await post(`/api/tasks/${bill.id}/items`, { item: it });
// The order they land in: the datasets first, then the runners, then finch's (its page numbers them, and each waits
// for the one before it).
await post(`/api/tasks/${bill.id}/order`, { order: [monoPr(16588, "chore(gcp): delete unused BigQuery datasets"), monoPr(16702, "feat(iac/global): pack CI runners onto fewer nodes"), monoPr(16613, "")] });
const siem = await post("/api/tasks", { text: "Move logging off the old SIEM", group: cleanup.id, posts: [{ post: threadId("osprey", "demo-osprey") }] });
await post(`/api/tasks/${siem.id}/items`, { item: monoPr(16655, "Move the SIEM log sinks to Datadog") });
await post("/api/tasks", { text: "Make the store fast again", note: "Checkout and the orders page under 300 ms p95.", posts: [{ post: threadId("sandpiper", "demo-sandpiper") }, { post: threadId("egret", "demo-egret") }] });
await post(`${egret}/post`, { title: "Why is the orders page slow?", text: "Three subagents audit core-api, the ledger and the page itself in the background." });
// ---------- a message that couldn't be delivered ----------
// OpenClaw's gateway didn't answer when you wrote on Pato's dinner thread: your message stays there, not delivered,
// with Try again (which works now) and Delete.
if (OPENCLAW === "1" && !process.env.FAKE_OPENCLAW_DIR) {
  const ocState = path.join(OPENCLAW_DIR, "state.json");
  const editOc = (fn: (s: { unreachable?: string }) => unknown) => {
    const s = JSON.parse(fs.readFileSync(ocState, "utf8"));
    fn(s);
    fs.writeFileSync(`${ocState}.demo`, JSON.stringify(s));
    fs.renameSync(`${ocState}.demo`, ocState);
  };
  const dinner = "/api/sessions/agent%3Amain%3Atelegram%3Adirect%3Aherval";
  editOc((s) => (s.unreachable = "Its gateway at brick.tail0137.ts.net doesn't answer"));
  await post(`${dinner}/messages`, { text: "Book Pharmacia for 20:30, the terrace if they can" });
  for (let i = 0; i < 80 && !(await call("GET", dinner)).messages?.some((m) => m.failed); i++) await sleep(250);
  editOc((s) => delete s.unreachable);
}
// ---------- a second machine, which goes off ----------
// A laptop logs in to the demo's server like any machine (approving its code on the page), posts its work, and
// is closed: its post reads whole, what you send it waits, and its page says so (#/machines/laptop).
const LAPTOP = path.join(HOME, "laptop");
const LAPTOP_PORT = poolPort();
const laptopProject = path.join(LAPTOP, "dev", "field-notes");
fs.mkdirSync(laptopProject, { recursive: true });
fs.mkdirSync(path.join(LAPTOP, "fake-claude"), { recursive: true });
const asking = await post("/api/devices/start", { name: "laptop" });
await post("/api/devices/approve", { code: asking.code });
const laptopToken = (await call("GET", `/api/devices/poll?poll=${encodeURIComponent(asking.poll)}`)).token;
const laptopEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTBOOK_HOME: LAPTOP, AGENTBOOK_PORT: String(LAPTOP_PORT), AGENTBOOK_URL: `http://127.0.0.1:${LAPTOP_PORT}`, AGENTBOOK_SERVER: URL, AGENTBOOK_SERVER_TOKEN: laptopToken, AGENTBOOK_MACHINE: "laptop", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(LAPTOP, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(LAPTOP, "claude"), AGENTBOOK_CLONE_DIR: path.join(LAPTOP, "dev") };
const laptop = spawnAgentbook({ env: laptopEnv, stdio: "ignore" });
const onLaptop = (method: string, p: string, body?: unknown): Promise<Json> => fetch(`http://127.0.0.1:${LAPTOP_PORT}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${LAPTOP_PORT}/api/health`).catch(() => null))?.ok; i++) await sleep(100);
const kestrel = sid("kestrel", "4401");
const kestrelT = transcript("kestrel", [
  T.prompt("Sort my field notes from the trip into one page per place", 5400),
  T.plan("p1", [{ content: "Read the notes", status: "completed", activeForm: "Reading the notes" }, { content: "Group them by place", status: "completed", activeForm: "Grouping them" }, { content: "Write a page per place", status: "in_progress", activeForm: "Writing the pages" }], 5300),
  T.tool("t1", "Bash", { command: "ls notes/", description: "List the notes" }, 5200),
  T.ok("t1", 5190),
  T.tool("t2", "Read", { file_path: path.join(laptopProject, "notes", "day-3.md") }, 5100),
  T.ok("t2", 5090),
  T.say("Grouped 41 notes under 6 places. Writing Lisbon first, since it has the most.", 5000),
]);
await onLaptop("POST", "/api/hello", { proc: "laptop-1", label: "kestrel", agent: "Claude", session_id: kestrel, cwd: laptopProject, transcript: kestrelT, host: "laptop" });
await onLaptop("POST", "/api/procs/laptop-1/post", { title: "Sort the trip's field notes into a page per place", text: "One page per place, with the photos that go with it." });
await onLaptop("POST", "/api/procs/laptop-1/updates", { text: "Grouped 41 notes under 6 places" });
await onLaptop("POST", "/api/procs/laptop-1/status", { state: "idle", text: "Waiting for you" });
for (let i = 0; i < 60 && !(await stateOf((p) => call("GET", p))).sessions?.some((x) => x.id === kestrel); i++) await sleep(150);
await sleep(1500); // its steps go up too
laptop.kill();
// Off: the server sees it go, then what you send it waits.
for (let i = 0; i < 80 && (await stateOf((p) => call("GET", p))).machines?.find((m) => m.name === "laptop")?.online; i++) await sleep(250);
await post(`/api/sessions/${encodeURIComponent(kestrel)}/messages`, { text: "Put Porto before Lisbon, it's where the trip started" });
// ibis: a side thread of quail's, sent on the side while quail works. Claude Code forked quail's
// conversation into it, it looked in the background and answered, and quail shows it under what was sent.
{
  const ask = "Check whether marked is safe for the HTML embeds as it is, or needs a sanitizer";
  fs.writeFileSync(path.join(FAKE, "next.txt"), sid("ibis", "demo-ibis"));
  await post(`/api/sessions/${encodeURIComponent(sid("quail", "demo-quail"))}/messages`, { text: ask, side: true });
  await sleep(300);
  const ibis = await session({ proc: "demo-ibis", label: "ibis", repo: "dashy", branch: "main", entries: [T.prompt(ask, 0), T.tool("ib1", "WebFetch", { url: "https://marked.js.org/#usage" }, 0), T.ok("ib1", 0), T.say("Reading marked's docs on raw HTML.", 0)] });
  await post(`${ibis}/messages`, { from: "human", via: "terminal", text: ask });
  await post(`${ibis}/messages`, { from: "agent", text: "It needs one: marked passes raw HTML through as it is, and hasn't sanitized since v0.7. Run its output through DOMPurify before it reaches the frame.\n\nThe frame's sandbox has no `allow-scripts`, so a script in it wouldn't run, but its links and forms would." });
  await post(`${ibis}/status`, { state: "idle", turn: "end" });
}
const kestrelAgent = (await stateOf((p) => call("GET", p))).agents.find((a) => a.machine === "laptop")?.id;
if (kestrelAgent) await post("/api/launch", { prompt: "Make a map of the places, with a pin for each page", agent: kestrelAgent, root: laptopProject, machine: "laptop" });

// Notes: one you write, with comments, a question quail answered, and edits it suggests; one
// inside it; one quail keeps.
{
  const launch = [
    "## Why now",
    "",
    "agentbook is where I follow every agent I run. Before it's public, 10–20 people who run agents every day should use it for two weeks and tell us where it breaks.",
    "",
    "## Who",
    "",
    "- Run Claude Code or Codex every day, ideally on more than one machine",
    "- Two or three who use OpenClaw, for the gateway path",
    "- No more than five from one company",
    "",
    "> 💡 Ask each of them which agents they run before sending the invite: the link sets up their machine for those.",
    "",
    "## What they get",
    "",
    "1. An invite link that signs them up and pairs their machine",
    "2. A 20-minute call to set it up together",
    "3. A group on agentbook where they post what broke",
    "",
    "## To do",
    "",
    "- [x] Offboarding: disable and delete accounts",
    "- [ ] Draft the invite email",
    "- [ ] List the 10–20 people, with which agents they run",
    "",
    "## The invite, short",
    "",
    "Hey! I've been building agentbook, a revolutionary new way to keep track of all of the AI agents that you are running: Claude Code, Codex and OpenClaw, on all your machines. I would really love it if you could try it for two weeks and tell me what breaks?",
    "",
    "## Open questions",
    "",
    "Do we charge anything during the soft launch? Probably not, but the hosted box is about $40 a month.",
    "",
  ].join("\n");
  const { id } = await post("/api/notes", { title: "Soft launch: the first 20", emoji: "🚀", text: launch });
  const invite = await post("/api/notes", { title: "Invite email", emoji: "📨", parent: id, text: "Hey! I've been building agentbook…\n" });
  await post(`/api/notes/${id}/write`, { text: `${launch}\n[📨 Invite email](#/notes/${invite.id})\n`, base: 1 });
  await post("/api/notes", { title: "Huddles: collabs in a sandbox", emoji: "🧪", text: "A room where two or three agents and you work on one branch, each in a sandbox of its own.\n\n- [ ] Sketch it\n- [ ] Ask Claude what breaks first\n" });
  await post(`${quail}/notes`, { title: "Eng sync, weekly", emoji: "🗒️", text: "## Oct 13\n\n- Retries on the EMR sync: down to 2 a day\n- The Datadog contract ends in March\n- On call next week: Lena\n" });
  const asked = await post(`/api/notes/${id}/comments`, { quote: "10–20 people who run agents every day", text: "@Claude is two weeks enough to learn anything?" });
  await post(`${quail}/notes/${id}/comment`, { comment: asked.comment, text: "Enough to see where setting up breaks, not whether they'd keep using it. I'd ask for two weeks, leave their accounts on after, and look at who's still there at four." });
  const plainer = await post(`/api/notes/${id}/comments`, { quote: "a revolutionary new way to keep track of all of the AI agents that you are running", text: "@Claude make this plainer, it reads like marketing" });
  await post(`${quail}/notes/${id}/suggest`, { comment: plainer.comment, find: "a revolutionary new way to keep track of all of the AI agents that you are running", replace: "one feed for every agent you run", why: "Cut it to what it is." });
  await post(`${quail}/notes/${id}/suggest`, { comment: plainer.comment, find: "I would really love it if you could try it", replace: "Would you try it", why: "And asked straight out." });
  await post(`/api/notes/${id}/comments`, { quote: "20-minute call", text: "maybe 30?" });
  await post(`${quail}/notes/${id}/suggest`, { find: "the hosted box is about $40 a month", replace: "the hosted box is about $48 a month, on 4 GB", why: "deploy/ sizes it at 2 GB; with 20 people connected I'd go to 4 GB." });
}

// Threads of yours: one where Claude joined, in a thread of its own, answered and asks
// you something; and one that's just yours.
{
  const made = await post("/api/talks", { text: "Why did signups drop Tuesday?\nThe dashboard says -18% since Tuesday afternoon. @Claude check what we deployed that day." });
  const wren = sid("wren", "demo-wren");
  fs.writeFileSync(path.join(FAKE, "next.txt"), wren);
  const sent = made.id && (await post(`/api/talks/${made.id}/send`, { mid: made.mid, agent: "claude" }));
  if (sent?.lid) {
    await post("/api/hello", { proc: "demo-wren", label: "wren", agent: "Claude", kind: "claude-code", session_id: wren, cwd: DEV, root: DEV, host: "hervalm5", pid: 1011, launch: sent.lid.split("~").pop() });
    await post("/api/procs/demo-wren/messages", { from: "human", via: "terminal", text: "Why did signups drop Tuesday?\nThe dashboard says -18% since Tuesday afternoon. @Claude check what we deployed that day." });
    await post("/api/procs/demo-wren/messages", { from: "agent", text: "The 14:02 deploy (a41c9e) gave the email field a `pattern` that iOS Safari checks before it submits, so an address with a `+` in it fails, and the form only says \u201cinvalid\u201d. Android Chrome lets it through. The fix is one line." });
    await post("/api/procs/demo-wren/questions", { title: "Open a pull request that drops the pattern and checks the address on the server?", options: ["Yes, open it", "Not yet"] });
    await post("/api/procs/demo-wren/status", { state: "idle", turn: "end" });
  }
  await post("/api/talks", { text: "Renew littleguys.dev before Nov 2\nNamecheap, not Cloudflare. The card on file expires in October." });
}

// A task shared with someone else: alice is on the cloud bill, with a thread of her own on
// it. Sign in as alice, with the demo's password, to see it as she does.
{
  const r = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", display_name: "Alice" }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const asAlice = (p: string, body: unknown): Promise<Json> => fetch(URL + p, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }).then((x) => x.json());
  await asAlice("/api/me/avatar", { emoji: "🦊" });
  // She's your contact: she asked, you said yes. Only a contact goes on something of yours.
  await asAlice(`/api/people/${DEMO_USER}/contact`, { act: "ask", note: "From the platform team" });
  await post("/api/people/alice/contact", { act: "yes" });
  await post(`/api/tasks/${bill.id}/people`, { user: "alice" });
  const talk = await asAlice("/api/talks", { text: "Which buckets can go?\nThe 14 nobody read in 90 days come to 3.1 TB: list in the thread." });
  if (talk.id) await asAlice(`/api/tasks/${bill.id}/link`, { post: talk.id });
  // And she's in the platform cleanup group: she sees every thread in it, and leaves a
  // note to them.
  await post(`/api/groups/${cleanup.id}/members`, { user: "alice" });
  await asAlice(`/api/groups/${cleanup.id}/notes`, { text: "The staging datasets are mine: leave them out of the cleanup for now." });
  // And she keeps the platform's reliability page with you: she sees its threads, and starts her own there. Her bell
  // says each of these once.
  if (rel?.id) await post(`/api/pages/${rel.id}/contributors`, { user: "alice" });
  // And she's on the soft launch note: she reads and writes it, and the invite inside it, and sees its comments' threads.
  await post("/api/notes/soft-launch-the-first-20/people", { user: "alice" });
  // More contacts: bob asks to be yours, with a word; you asked carol, who hasn't answered; dana is yours, and you
  // don't follow her (her things stay on her profile, out of your feed). Your profile's Contacts box has them all.
  const join = async (username: string, display_name: string, emoji: string) => {
    const res = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, display_name }) });
    const c = (res.headers.get("set-cookie") || "").split(";")[0];
    const as = (p: string, body: unknown): Promise<Json> => fetch(URL + p, { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }).then((x) => x.json());
    await as("/api/me/avatar", { emoji });
    return as;
  };
  const asBob = await join("bob", "Bob Okafor", "🐻");
  const asCarol = await join("carol", "Carol Diaz", "🌵");
  const asDana = await join("dana", "Dana Lin", "🐙");
  void asCarol;
  await asBob(`/api/people/${DEMO_USER}/contact`, { act: "ask", note: "We met at the infra meetup" });
  await post("/api/people/carol/contact", { act: "ask" });
  await asDana(`/api/people/${DEMO_USER}/contact`, { act: "ask" });
  await post("/api/people/dana/contact", { act: "yes" });
  await post("/api/people/dana/follow", { follow: false });
  // Your Codex is public: your contacts see its threads, with their work.
  const codex = (await stateOf((p) => call("GET", p))).agents?.find((a) => a.kind === "codex" && a.mine !== false);
  if (codex) await post(`/api/agents/${encodeURIComponent(codex.id)}/visibility`, { visibility: "public" });
}

console.log(`\nDemo agentbook ready at ${URL}: sign in as ${DEMO_USER} at ${URL}/test-sign-in?as=${DEMO_USER}  (Ctrl+C to stop; data in ${HOME})`);
console.log(`Two machines: this one, and "laptop", which is off now (${URL}/#/machines/laptop).`);
