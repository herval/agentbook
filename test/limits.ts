#!/usr/bin/env node
// Agents' usage limits (plugin/cli/limits.ts), on their profiles: what each runtime says turned into one shape,
// then end to end, a real agentbook server in a temp folder reading Claude Code's from a stand-in for claude.ai's
// usage API (what /usage reads) and Codex's from a stand-in for its daemon (account/rateLimits/read).
// Run: node test/limits.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeLimitsOf, claudePlanOf, codexLimitsOf, limitsReader, openclawLimitsOf, spanLabel } from "../plugin/cli/limits.ts";
import { startClaudeApi } from "./fake-claude-api.ts";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-limits-"));
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const CODEX_SOCK = path.join(HOME, "codex.sock");
const CODEX_LIMITS = path.join(HOME, "codex-limits.json");
const project = path.join(HOME, "dev", "site");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const sec = (ms: number) => Math.floor(ms / 1000);
const T0 = Date.now();

/* ---------- what each runtime says, in one shape ---------- */

{
  check(spanLabel(300) === "5-hour" && spanLabel(10080) === "Week" && spanLabel(1440) === "Day" && spanLabel(4320) === "3-day" && spanLabel(null) === "Limit", "a window is named by its length");
  check(claudePlanOf({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }) === "Max 20x" && claudePlanOf({ subscriptionType: "pro" }) === "Pro" && claudePlanOf({}) === null, "Claude Code's plan, from its sign-in");

  // claude.ai's answer, as Claude Code's /usage gets it: utilization in percent, extra usage in cents.
  const c = claudeLimitsOf(
    {
      five_hour: { utilization: 34, resets_at: "2026-11-01T18:00:00Z" },
      seven_day: { utilization: 81.5, resets_at: "2026-11-04T09:00:00Z" },
      seven_day_opus: { utilization: 12, resets_at: null },
      seven_day_sonnet: null,
      seven_day_oauth_apps: { utilization: 3 },
      limits: [{ kind: "rate", group: "weekly", percent: 55, resets_at: "2026-11-04T09:00:00Z", is_active: true, scope: { model: { display_name: "Fable" } } }, { kind: "rate", group: "weekly", percent: 9, is_active: true, scope: { model: { display_name: "Opus" } } }, { kind: "spend", group: "monthly", percent: 54, is_active: true }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: "usd" },
    },
    "Max 20x",
  );
  check(c.name === "Claude" && c.plan === "Max 20x" && c.windows.map((w) => w.label).join() === "5-hour,Week,Opus, week,Fable, week", "Claude's 5-hour, weekly and per-model limits, in order, a model's from `limits` once (Opus already listed)");
  check(c.windows[0].used === 34 && c.windows[0].resets === "2026-11-01T18:00:00.000Z" && c.windows[0].span === 300 && c.windows[1].used === 81.5 && c.windows[2].resets === null, "each with how much is used and when it resets");
  check(c.credits?.used === 12.4 && c.credits.limit === 50 && c.credits.unit === "USD" && c.credits.period === "month" && !c.blocked, "extra usage in dollars, from cents");
  const out = claudeLimitsOf({ five_hour: { utilization: 100, resets_at: "2026-11-01T18:00:00Z" } });
  check(out.blocked && out.windows[0].used === 100, "a limit used up with no extra usage: it's out until it resets");
  check(claudeLimitsOf({ five_hour: { utilization: 140 } }).windows[0].used === 100 && claudeLimitsOf({}).windows.length === 0 && claudeLimitsOf(null).windows.length === 0, "past 100 shows as 100; an empty answer has none");

  // Codex's account/rateLimits/read, as its daemon answered on herval's machine (with a second bucket added).
  const snap = { limitId: "codex", limitName: null, primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1793791967 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "prolite", rateLimitReachedType: null };
  const x = codexLimitsOf({ ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: { codex: snap, astra: { ...snap, limitId: "astra", limitName: "GPT-6-Astra", primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: null }, planType: null } } });
  check(x.name === "ChatGPT" && x.plan === "Pro Lite" && x.windows.map((w) => w.label).join() === "Week,GPT-6-Astra, 5-hour" && x.windows[0].resets === new Date(1793791967e3).toISOString() && x.windows[0].span === 10080, "Codex's plan and limits, a model's own bucket by its name");
  check(x.credits === null && !x.blocked, "no credits to show when it has none");
  const y = codexLimitsOf({ ordinaryUsageAllowed: false, rateLimits: { ...snap, credits: { hasCredits: true, unlimited: false, balance: "25" }, rateLimitReachedType: "rate_limit_reached" }, rateLimitsByLimitId: null });
  check(y.blocked && y.credits?.balance === 25 && y.windows.length === 1, "out of usage, with credits left; one bucket when it lists none by id");

  // OpenClaw's usage.status: a row per provider its gateway signs in to.
  const o = openclawLimitsOf({ updatedAt: T0, providers: [{ provider: "anthropic", displayName: "Claude", windows: [{ label: "5h", usedPercent: 20, resetAt: T0 + 3600e3 }, { label: "Week", usedPercent: 64, resetAt: T0 + 86400e3 }], billing: [{ type: "budget", used: 3.5, limit: 20, unit: "usd", period: "month" }] }, { provider: "openai", displayName: "Codex", windows: [], plan: "Plus", error: "Token expired" }] });
  check(o.length === 2 && o[0].windows.map((w) => w.label).join() === "5-hour,Week" && o[0].windows[0].resets === new Date(T0 + 3600e3).toISOString() && o[0].credits?.limit === 20 && o[1].plan === "Plus" && o[1].error === "Token expired", "OpenClaw's providers, each with its limits, its budget, or why it couldn't read them");
  check(openclawLimitsOf({ providers: [] }).length === 0 && openclawLimitsOf(null).length === 0, "a gateway with no providers has none");

  // Read at most once in a while; a failed read keeps the last good one, saying why.
  let n = 0;
  let fail = false;
  const r = limitsReader(
    async () => {
      n++;
      if (fail) throw new Error("claude.ai said 500");
      return { limits: [{ name: "x", windows: [{ label: "Week", used: n }] }] };
    },
    { ms: 150 },
  );
  const [a1, a2] = await Promise.all([r(), r()]);
  check(n === 1 && a1 === a2 && a1.at && a1.limits[0].windows[0].used === 1, "two asks at once read once");
  check((await r()).limits[0].windows[0].used === 1 && n === 1, "and it's kept for a while");
  await sleep(170);
  fail = true;
  const failed = await r();
  check(n === 2 && failed.error === "claude.ai said 500" && failed.limits[0].windows[0].used === 1 && failed.at === a1.at, "a failed read keeps the last good one, with why");
  await sleep(170);
  check((await r()).limits[0].windows[0].used === 1, "and still does the next time it fails");
  fail = false;
  r.stale();
  const back = await r();
  check(back.limits[0].windows[0].used === 4 && !back.error, "stale() reads them again at once");
}

/* ---------- end to end ---------- */

const usage = { five_hour: { utilization: 42, resets_at: new Date(T0 + 2 * 3600e3).toISOString() }, seven_day: { utilization: 88, resets_at: new Date(T0 + 3 * 86400e3).toISOString() }, seven_day_sonnet: { utilization: 5, resets_at: null }, extra_usage: { is_enabled: false } };
const claudeApi = await startClaudeApi({ token: "test-token", usage });

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
  AGENTBOOK_CODEX_HOME: path.join(HOME, "codex"),
  AGENTBOOK_CLOUD_SYNC_MS: "60000",
  AGENTBOOK_CLAUDE_TOKEN: "test-token",
  AGENTBOOK_CLAUDE_API: claudeApi.url,
  AGENTBOOK_LIMITS_MS: "1500",
};
delete env.AGENTBOOK_PLUGIN_DIR;
delete env.AGENTBOOK_CHANNEL;
delete env.AGENTBOOK_LAUNCH_ID;
delete env.AGENTBOOK_LABEL;
delete env.CLAUDE_JOB_DIR;
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
let COOKIE = "";
const call = (u: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + u, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (u: string): Promise<Json> => (await call(u)).json();
const state = () => stateOf(get);

const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), CODEX_SOCK, path.join(HOME, "codex.jsonl"), project], { stdio: "ignore", env: { ...process.env, FAKE_CODEX_LIMITS: CODEX_LIMITS } });
check(await until(() => fs.existsSync(CODEX_SOCK), 3000), "Codex's daemon (a stand-in) is up");
const server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
server.stdout.on("data", (d) => process.env.DEBUG && process.stdout.write(d));

try {
  check(await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok), "server starts");
  check((await call("/api/agents/claude/limits")).status === 401, "signed out, nobody reads them");
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // A Claude Code session, so its agent is here.
  const T = path.join(HOME, "kite.jsonl");
  fs.writeFileSync(T, JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "user", message: { content: "how much of my week is left?" } }) + "\n");
  const hook = spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), "SessionStart"], { input: JSON.stringify({ session_id: "sess-kite", cwd: project, source: "startup", transcript_path: T }), env: { ...env, AGENTBOOK_PID: "930001", AGENTBOOK_LABEL: "kite", CLAUDE_PROJECT_DIR: project }, encoding: "utf8", timeout: 15000 });
  check(hook.status === 0, "a Claude Code session registers");
  check(await until(async () => (await state()).agents.some((a) => a.id === "claude") && (await state()).agents.some((a) => a.id === "codex")), "Claude Code and Codex are both here");

  // ---------- Claude Code's, from claude.ai ----------
  const cl = await get("/api/agents/claude/limits");
  const cw = cl.limits?.[0]?.windows || [];
  check(cl.limits?.length === 1 && cl.limits[0].name === "Claude" && cw.map((w) => w.label).join() === "5-hour,Week,Sonnet, week" && cw[0].used === 42 && cw[1].used === 88 && cw[1].resets === usage.seven_day.resets_at && cl.at, "Claude's limits on its profile: 5-hour 42%, the week 88%, Sonnet's, when each resets, and when they were read");
  const asked = claudeApi.calls.filter((c) => c.path === "/api/oauth/usage");
  check(asked.length === 1 && asked[0].auth === "Bearer test-token" && asked[0].beta === "oauth-2025-04-20", "read with its sign-in, as /usage asks");
  await get("/api/agents/claude/limits");
  check(claudeApi.calls.filter((c) => c.path === "/api/oauth/usage").length === 1, "asked again at once, it isn't read again");
  claudeApi.usage = { status: 500, error: "Internal error" };
  await sleep(1600);
  const kept = await get("/api/agents/claude/limits");
  check(kept.limits?.[0]?.windows?.[0]?.used === 42 && /claude\.ai said 500/.test(kept.error || "") && kept.at === cl.at, "claude.ai failing: the last read stays, saying why");
  claudeApi.usage = { ...usage, five_hour: { utilization: 61, resets_at: usage.five_hour.resets_at } };
  await sleep(1600);
  const again = await get("/api/agents/claude/limits");
  check(again.limits?.[0]?.windows?.[0]?.used === 61 && !again.error, "and once it answers, the new numbers");

  // ---------- Codex's, from its daemon ----------
  const cx = await get("/api/agents/codex/limits");
  const xw = cx.limits?.[0]?.windows || [];
  check(cx.limits?.[0]?.name === "ChatGPT" && cx.limits[0].plan === "Pro Lite" && xw.map((w) => `${w.label} ${w.used}`).join() === "5-hour 41,Week 12" && xw[0].resets && !cx.limits[0].blocked, "Codex's limits on its profile: its plan, 5 hours 41% and the week 12%, the shorter first");
  const snap = { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: sec(T0 + 1800e3) }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "plus", rateLimitReachedType: "rate_limit_reached" };
  fs.writeFileSync(CODEX_LIMITS, JSON.stringify({ ordinaryUsageAllowed: false, rateLimits: snap, rateLimitsByLimitId: { codex: snap } }));
  check((await get("/api/agents/codex/limits")).limits?.[0]?.plan === "Pro Lite", "read a moment ago, they're what it read then");
  fakeCodex.kill("SIGUSR2");
  const moved = await until(async () => {
    const r = await get("/api/agents/codex/limits");
    return r.limits?.[0]?.plan === "Plus" && r;
  }, 1200);
  check(moved && moved.limits[0].blocked && moved.limits[0].windows[0].used === 100 && moved.limits[0].windows[0].label === "5-hour", "once Codex says they moved, they're read again: out until its 5 hours reset");

  // ---------- the rest ----------
  check((await call("/api/agents/nobody/limits")).status === 404, "an agent that isn't here has none");
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
