#!/usr/bin/env node
// OpenClaw on agentbook, through a stand-in `openclaw` command (fake-openclaw.ts): its agents are profiles,
// its sessions posts with their steps; you start sessions, write to them, answer approvals and questions, and
// stop them. Run: node test/openclaw.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OcState } from "./fake-openclaw-state.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-openclaw-"));
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "openclaw");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW_BIN: path.join(TEST, "fake-openclaw.ts"), FAKE_OPENCLAW_DIR: FAKE, AGENTBOOK_OPENCLAW_SYNC_MS: "300", AGENTBOOK_OPENCLAW_PAGE: "2", AGENTBOOK_OPENCLAW_WS_DIRS: "20", AGENTBOOK_OPENCLAW_WS_MS: "5000", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OPENCLAW"]) delete env[k];

// What OpenClaw has: an agent with an emoji, a conversation from this morning with a command in it, a cron job's
// session (a thread) and sessions that stay off; an agent with a picture in its IDENTITY.md; and one that never talked.
const now = Date.now();
// What a cron job tells its agent, word for word (OpenClaw 2026.9.4).
const cronSays = (job: string, name: string, what: string) => `[cron:${job} ${name}] ${what}\nCurrent time: Saturday, November 7th, 2026 - 2:47 PM (America/Fortaleza)\nReference UTC: 2026-11-07 17:47 UTC\n\nThis is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have.`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const STATE = path.join(FAKE, "state.json");
const write = (s: OcState) => {
  fs.writeFileSync(`${STATE}.t`, JSON.stringify(s, null, 1));
  fs.renameSync(`${STATE}.t`, STATE);
};
const read = (): OcState => JSON.parse(fs.readFileSync(STATE, "utf8"));
const edit = (fn: (s: OcState) => void) => {
  const s = read();
  fn(s);
  write(s);
};
write({
  agents: [
    { id: "main", name: "main", identity: { name: "jefepato", emoji: "🦆" }, workspace: "/Users/me/.openclaw/workspace", model: { primary: "anthropic/claude-opus-5" } },
    { id: "scout", name: "scout", workspace: "/Users/me/.openclaw/scout", identityFile: { name: "Scout", avatar: `data:image/png;base64,${PNG.toString("base64")}` } },
    // One that has no session yet, only the files OpenClaw makes it of.
    { id: "quiet", name: "quiet", workspace: "/Users/me/.openclaw/quiet", coreFiles: { "AGENTS.md": "# Quiet\n\nSays little.\n", "SOUL.md": "Calm." } },
  ],
  sessions: [
    {
      key: "agent:main:main",
      sessionId: "s-main",
      agentId: "main",
      derivedTitle: "Weather for the trip",
      createdAt: now - 3600e3,
      updatedAt: now - 60e3,
      hasActiveRun: false,
      messages: [
        { role: "user", content: "Check the weather in Lisbon for Friday", timestamp: now - 3600e3 },
        // It reads its weather skill first, as OpenClaw tells its agents to.
        { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: { path: "/opt/openclaw/skills/weather/SKILL.md" } }], timestamp: now - 3595e3 },
        { role: "toolResult", toolCallId: "c0", toolName: "read", content: [{ type: "text", text: "# Weather" }], isError: false, timestamp: now - 3594e3 },
        // A look through every skill isn't a use of one called "d".
        { role: "assistant", content: [{ type: "toolCall", id: "c00", name: "exec", arguments: { command: "for d in skills/*; do head -3 $d/SKILL.md; done" } }], timestamp: now - 3593e3 },
        { role: "toolResult", toolCallId: "c00", toolName: "exec", content: [{ type: "text", text: "---" }], isError: false, timestamp: now - 3592e3 },
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: { query: "Lisbon weather Friday" } }], timestamp: now - 3590e3 },
        { role: "toolResult", toolCallId: "c1", toolName: "web_search", content: [{ type: "text", text: "Sunny, 24C" }], isError: false, timestamp: now - 3589e3 },
        { role: "assistant", content: [{ type: "text", text: "Sunny and 24°C on Friday." }], timestamp: now - 3588e3 },
      ],
    },
    {
      key: "agent:main:cron:digest:run:7",
      sessionId: "s-cron",
      agentId: "main",
      createdAt: now - 600e3,
      updatedAt: now - 600e3,
      messages: [
        { role: "user", content: "daily digest", timestamp: now - 600e3 },
        { role: "assistant", content: [{ type: "toolCall", id: "d1", name: "web_search", arguments: { query: "news today" } }], timestamp: now - 599e3 },
        { role: "toolResult", toolCallId: "d1", toolName: "web_search", content: [{ type: "text", text: "..." }], isError: false, timestamp: now - 598e3 },
        { role: "assistant", content: [{ type: "text", text: "Three things happened today." }], timestamp: now - 597e3 },
      ],
    },
    // What a gateway lists of a cron job: one session per job, which each run takes over.
    {
      key: "agent:main:cron:digest",
      sessionId: "s-cron-7",
      agentId: "main",
      label: "Automation: Daily digest",
      createdAt: now - 9 * 86400e3,
      updatedAt: now - 597e3,
      messages: [
        { role: "user", content: cronSays("digest", "Daily digest", "daily digest"), timestamp: now - 600e3 },
        { role: "assistant", content: [{ type: "text", text: "Three things happened today." }], timestamp: now - 597e3 },
      ],
    },
    // Cron sessions that stay off: OpenClaw's own upkeep, a webhook's run (a job nobody listed), and a job with nothing to report.
    { key: "agent:main:cron:memory", sessionId: "s-memory", agentId: "main", label: "Automation: Memory dreaming", createdAt: now - 3 * 86400e3, updatedAt: now - 7000e3, messages: [{ role: "user", content: cronSays("memory", "Memory dreaming", "dream"), timestamp: now - 7000e3 }, { role: "assistant", content: [{ type: "text", text: "Dreamt." }], timestamp: now - 7000e3 }] },
    { key: "agent:main:cron:89779397-82c7", sessionId: "s-hook", agentId: "main", createdAt: now - 8000e3, updatedAt: now - 8000e3, messages: [{ role: "user", content: "Job ID: 89779397-82c7 | Received: today\n\nSECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source (e.g., email, webhook).", timestamp: now - 8000e3 }, { role: "assistant", content: [{ type: "text", text: "Handled." }], timestamp: now - 8000e3 }] },
    { key: "agent:scout:cron:prices", sessionId: "s-prices", agentId: "scout", label: "Automation: GPU prices", createdAt: now - 3 * 86400e3, updatedAt: now - 2 * 86400e3, messages: [{ role: "user", content: cronSays("prices", "GPU prices", "check the prices"), timestamp: now - 2 * 86400e3 }] },
    // A cron job that runs in a session it names: what the gateway's history has of it.
    {
      key: "agent:main:weekly-review",
      sessionId: "s-review",
      agentId: "main",
      createdAt: now - 500e3,
      updatedAt: now - 500e3,
      messages: [
        {
          role: "user",
          content: cronSays("5806d353-0108", "Weekly review", "Build on last week.\n\nKeep it short."),
          timestamp: now - 500e3,
        },
        { role: "assistant", content: [{ type: "text", text: "Last week went fine." }], timestamp: now - 499e3 },
      ],
    },
    { key: "agent:main:dashboard:old", sessionId: "s-old", agentId: "main", createdAt: now - 40 * 86400e3, updatedAt: now - 40 * 86400e3, messages: [] },
    // An agent's main session doesn't say when it was created; when its place on the gateway was made does.
    {
      key: "agent:scout:main",
      sessionId: "s-scout",
      agentId: "scout",
      placement: { state: "local", createdAtMs: now - 5 * 86400e3 },
      updatedAt: now - 2 * 86400e3,
      messages: [
        { role: "user", content: "Find a cheaper GPU host", timestamp: now - 2 * 86400e3 - 60e3 },
        { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "k0", name: "Skill", input: { skill: "openclaw-skills:weather" } }, { type: "toolcall", id: "k1", name: "Bash", arguments: { command: "curl -s prices.example" } }], timestamp: now - 2 * 86400e3 - 50e3 },
        { role: "assistant", content: [{ type: "tool_result", toolCallId: "k1", name: "Bash", content: [{ type: "text", text: "..." }] }], timestamp: now - 2 * 86400e3 - 40e3 },
        { role: "assistant", content: [{ type: "text", text: "Vast.ai is the cheapest." }], timestamp: now - 2 * 86400e3 },
      ],
    },
    // One from Discord whose history takes a while to read.
    {
      key: "agent:main:discord:channel:42",
      sessionId: "s-discord",
      agentId: "main",
      createdAt: now - 3 * 86400e3,
      updatedAt: now - 3 * 86400e3,
      slowMs: 1500,
      messages: [
        { role: "user", content: "@jefepato summarize #general", timestamp: now - 3 * 86400e3 - 60e3, __openclaw: { transport: { channel: "discord" } } },
        { role: "assistant", content: [{ type: "text", text: "Mostly travel plans." }], timestamp: now - 3 * 86400e3 },
      ],
    },
  ],
  presence: [
    { host: "brick-3.local", mode: "gateway", reason: "self" },
    { host: "laptop", mode: "node", reason: "connect" },
  ],
  approvals: [],
  questions: [],
  // Its skills: one of OpenClaw's own, one in its workspace, one missing what it needs, and one turned off.
  skills: {
    main: [
      { name: "weather", description: "Get the weather for a place and day.", filePath: "/opt/openclaw/skills/weather/SKILL.md" },
      { name: "newsletter", description: "Write the weekly newsletter.", source: "openclaw-workspace", filePath: "/Users/me/.openclaw/workspace/skills/newsletter/SKILL.md" },
      { name: "imsg", description: "Send iMessages.", filePath: "/opt/openclaw/skills/imsg/SKILL.md", eligible: false, missing: { bins: ["imsg"] } },
      { name: "camsnap", description: "Snap a camera.", filePath: "/opt/openclaw/skills/camsnap/SKILL.md", disabled: true },
    ],
  },
  // Its routines: a daily digest that ran (its run is the cron session above), and a paused one of scout's;
  // and OpenClaw's own upkeep.
  cron: {
    jobs: [
      { id: "digest", agentId: "main", name: "Daily digest", enabled: true, createdAtMs: now - 9 * 86400e3, updatedAtMs: now - 86400e3, schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Lisbon" }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "daily digest" }, delivery: { mode: "announce", channel: "telegram" }, state: { nextRunAtMs: now + 3600e3, lastRunAtMs: now - 600e3, lastRunStatus: "ok", lastDurationMs: 3000 } },
      { id: "prices", agentId: "scout", name: "GPU prices", enabled: false, createdAtMs: now - 3 * 86400e3, updatedAtMs: now - 3 * 86400e3, schedule: { kind: "every", everyMs: 4 * 3600e3 }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Check GPU prices" }, state: { lastRunAtMs: now - 2 * 86400e3, lastRunStatus: "error", lastError: "rate limited", consecutiveErrors: 2 } },
      { id: "memory", agentId: "main", declarationKey: "memory-dreaming", name: "Memory dreaming", enabled: true, createdAtMs: now - 30 * 86400e3, updatedAtMs: now - 30 * 86400e3, schedule: { kind: "cron", expr: "0 3 * * *" }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "systemEvent", text: "dream" }, state: {} },
    ],
    runs: [
      { ts: now - 597e3, jobId: "digest", action: "finished", status: "ok", summary: "Three things happened today.", sessionKey: "agent:main:cron:digest:run:7", sessionId: "s-cron", runId: "run-7", runAtMs: now - 600e3, durationMs: 3000 },
      { ts: now - 43200e3, jobId: "digest", action: "finished", status: "ok", summary: "Two things **happened** last night.", sessionKey: "agent:main:cron:digest:run:6", sessionId: "s-cron-6", runId: "run-6", runAtMs: now - 43200e3 - 4000, durationMs: 4000, deliveryStatus: "delivered" },
      { ts: now - 86400e3, jobId: "digest", action: "finished", status: "error", error: "model overloaded", runAtMs: now - 86400e3 - 2000, durationMs: 2000 },
      { ts: now - 2 * 86400e3, jobId: "prices", action: "finished", status: "error", error: "rate limited", runAtMs: now - 2 * 86400e3 - 1000, durationMs: 1000 },
    ],
  },
});
const calls = (): Json[] => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);

let failures = 0;
// `extra`: what to show when it fails.
const check = (cond: unknown, label: string, extra: unknown = ""): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? `  [${extra}]` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}): Promise<Json> => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const MAIN = "agent:main:main";
const enc = encodeURIComponent;

let serverLog = "";
let server: Agentbook | null = null;
async function startServer() {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
}
try {
  await startServer();
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- its agents and sessions ----------
  const first = await until(async () => {
    const s = await state();
    return s.sessions.some((x) => x.id === MAIN && x.prompt) && s; // its post shows at once, its first message once its history is read
  });
  const agent = first?.agents.find((a) => a.id === "openclaw-main");
  check(agent?.name === "jefepato" && agent.kind === "openclaw" && agent.runtime === "openclaw" && agent.folders === false, "an OpenClaw agent is a profile, named after its identity, that works in its own workspace");
  const main = first?.sessions.find((x) => x.id === MAIN);
  check(main?.agent === "openclaw-main" && main.prompt === "Check the weather in Lisbon for Friday" && main.title === "Weather for the trip" && main.rt?.name === "OpenClaw", "its session is a post, with its first message and title");
  check(!first.sessions.some((x) => x.id.includes(":run:")), "a cron run's own session stays off");
  const DISCORD = "agent:main:discord:channel:42";
  const syncing = await until(async () => (await state()).sessions.find((x) => x.id === DISCORD && x.rt?.syncing), 4000);
  check(syncing && !syncing.messages, "while its history is read, a post says it's syncing");
  const all = await until(async () => {
    const s = await state();
    return ["agent:main:dashboard:old", "agent:scout:main", DISCORD].every((id) => s.sessions.some((x) => x.id === id && !x.rt?.syncing)) && s;
  });
  check(all && calls().some((c) => c.method === "sessions.list" && c.params.offset), "every session shows, however old, listed a page at a time");
  const old = all?.sessions.find((x) => x.id === "agent:main:dashboard:old");
  check(old?.effective === "done" && Math.abs(Date.parse(old.started) - (now - 40 * 86400e3)) < 2000, "an old one is a finished post, from when it began");
  const scoutPost = all?.sessions.find((x) => x.id === "agent:scout:main");
  check(scoutPost && Math.abs(Date.parse(scoutPost.started) - (now - 5 * 86400e3)) < 2000, "a session that doesn't say when it was created began when OpenClaw made its place, not when agentbook saw it");
  const scoutTalk = (await get(`/api/sessions/${enc("agent:scout:main")}`)).messages || [];
  check(scoutTalk.map((m) => `${m.from}:${m.text}`).join("|") === "human:Find a cheaper GPU host|agent:Vast.ai is the cheapest." && scoutTalk[0].at === new Date(now - 2 * 86400e3 - 60e3).toISOString(), "its history is its conversation: what you asked and its reply, when they were said");
  const scoutSteps = await get(`/api/sessions/${enc("agent:scout:main")}/steps`);
  check(scoutSteps.steps?.some((x) => x.kind === "tool" && x.done && /curl/.test(x.title)), "a claude-cli agent's tool calls, kept in its replies, are steps");
  const fromDiscord = (await get(`/api/sessions/${enc(DISCORD)}`)).messages || [];
  check(fromDiscord[0]?.via === "discord" && fromDiscord[1]?.text === "Mostly travel plans.", "a Discord conversation shows, saying where it came from");
  const review = await until(async () => (await state()).sessions.find((x) => x.id === "agent:main:weekly-review" && x.title === "Weekly review"));
  const reviewTalk = (await until(async () => {
    const m = (await get(`/api/sessions/${enc("agent:main:weekly-review")}`)).messages || [];
    return m.length >= 2 && m;
  })) || [];
  check(review && reviewTalk[0]?.from === "human" && reviewTalk[0].routine?.name === "Weekly review" && reviewTalk[0].routine.id === "5806d353-0108" && reviewTalk[0].routine.why === "cron", "a cron job's prompt in a session it names is from its routine, not from you", JSON.stringify(reviewTalk[0]));
  check(reviewTalk[0]?.text === "Build on last week.\n\nKeep it short." && reviewTalk[1]?.text === "Last week went fine.", "without the time and what OpenClaw tells an unattended run, and the thread takes the job's name", JSON.stringify(reviewTalk));

  // ---------- a cron job's thread ----------
  const JOB = "agent:main:cron:digest";
  const talkOf = async (key: string): Promise<Json[]> => (await get(`/api/sessions/${enc(key)}`)).messages || [];
  const says = (list: Json[]) => list.map((m) => `${m.from}:${m.text}`).join("|");
  // Its title can come a look before its run's history, which is what moves it.
  const jobThread = await until(async () => (await state()).sessions.find((x) => x.id === JOB && x.title === "Daily digest" && x.moved));
  const jobTalk = (await until(async () => {
    const m = await talkOf(JOB);
    return m.length >= 2 && m;
  })) || [];
  check(jobThread && says(jobTalk) === "human:daily digest|agent:Three things happened today." && jobTalk[0].routine?.why === "cron", "a cron job is a thread, named after it, with what it told its agent and what came back");
  check(/doesn't take messages/.test(jobThread?.rt?.blocked || "") && !jobThread?.rt?.resume, "and no box to write in, or command to go on in it, since OpenClaw refuses them there");
  const onFeed = async () => (await get("/api/q/feed?n=100")).list || [];
  const feedNow = await onFeed();
  check(jobThread?.moved === new Date(now - 600e3).toISOString() && feedNow.indexOf(`thread:${JOB}`) >= 0 && feedNow.indexOf(`thread:${JOB}`) < feedNow.indexOf(`thread:agent:scout:main`), "it sits on the feed by its latest run, not when the job was made");
  const offIds = (await state()).sessions.map((x) => x.id);
  check(!offIds.includes("agent:main:cron:memory") && !offIds.includes("agent:main:cron:89779397-82c7") && !offIds.includes("agent:scout:cron:prices"), "OpenClaw's own upkeep, a webhook's run and a job with nothing to report aren't threads");
  const newRun = (sessionId, messages) =>
    edit((s) => {
      Object.assign(s.sessions.find((x) => x.key === JOB), { sessionId, messages, updatedAt: Date.now() });
    });
  const nextAt = Date.now();
  newRun("s-cron-8", [{ role: "user", content: cronSays("digest", "Daily digest", "daily digest"), timestamp: nextAt - 2000 }, { role: "assistant", content: [{ type: "text", text: "Nothing much today." }], timestamp: nextAt - 1000 }]);
  const twoRuns = (await until(async () => {
    const m = await talkOf(JOB);
    return m.length >= 4 && m;
  })) || [];
  const movedTo = (await state()).sessions.find((x) => x.id === JOB)?.moved;
  check(says(twoRuns) === "human:daily digest|agent:Three things happened today.|human:daily digest|agent:Nothing much today." && movedTo === new Date(nextAt - 2000).toISOString(), "its next run adds to it, in a session of its own, and moves it up the feed");
  newRun("s-cron-9", [{ role: "user", content: cronSays("digest", "Daily digest", "daily digest"), timestamp: Date.now() }]);
  await sleep(1500);
  check((await talkOf(JOB)).length === 4 && (await state()).sessions.find((x) => x.id === JOB)?.moved === movedTo, "a run with nothing to report adds nothing, and leaves it where it is");
  // Archived, it stays archived, whatever its job goes on reporting: nobody wrote to it.
  await post(`/api/sessions/${enc(JOB)}/flag`, { archived: true });
  await sleep(50);
  const afterAt = Date.now();
  newRun("s-cron-10", [{ role: "user", content: cronSays("digest", "Daily digest", "daily digest"), timestamp: afterAt }, { role: "assistant", content: [{ type: "text", text: "A quiet day." }], timestamp: afterAt + 1 }]);
  const threeRuns = await until(async () => {
    const m = await talkOf(JOB);
    return m.length >= 6 && m;
  });
  const shelved = (await state()).sessions.find((x) => x.id === JOB);
  check(threeRuns?.at(-1)?.text === "A quiet day." && shelved?.archived && !(await onFeed()).includes(`thread:${JOB}`), "archived, it stays archived and off the feed through a run that reports");
  await post(`/api/sessions/${enc(JOB)}/flag`, { archived: false });
  check((await state()).sessions.find((x) => x.id === JOB)?.moved === new Date(afterAt).toISOString() && (await onFeed()).indexOf(`thread:${JOB}`) >= 0, "and brought back, it's where its latest run puts it");
  // A claude-cli agent's run, as a real gateway has it: the prompt "forwarded" from the run, Claude Code's transcript read
  // back, a tool's result as a message from the user, then OpenClaw's own record of it, all it said joined.
  const fromClaude = (id: string) => ({ api: "anthropic-messages", provider: "claude-cli", __openclaw: { id, importedFrom: "claude-cli", cliSessionId: "cli-1" } });
  const forwardedPrompt = (key: string, job: string, name: string, what: string, at: number) => ({ role: "assistant", content: cronSays(job, name, what).replace(`[cron:${job} ${name}] `, ""), provenance: { kind: "internal_system", sourceSessionKey: `${key}:run:r`, sourceTool: "cron", sourcePromptPrefix: `[cron:${job} ${name}]`, jobId: job, runId: "r" }, idempotencyKey: "i:user", senderLabel: `Forwarded from ${name}`, senderSession: { sessionKey: `${key}:run:r` }, __openclaw: { turnBoundary: true }, timestamp: at });
  const toolCall = (id: string, at: number, command: string) => ({ role: "assistant", ...fromClaude(`call-${id}`), stopReason: "tool_use", content: [{ type: "toolcall", id, name: "exec", arguments: { command } }], timestamp: at });
  const toolResult = (id: string, at: number, text: string) => ({ role: "user", ...fromClaude(`result-${id}`), content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }], timestamp: at });
  const cliSays = (id: string, at: number, text: string, stopReason = "tool_use") => ({ role: "assistant", ...fromClaude(id), stopReason, content: [{ type: "text", text }], timestamp: at });
  const cliJoined = (at: number, text: string) => ({ role: "assistant", api: "cli", provider: "claude-cli", stopReason: "stop", idempotencyKey: `cli-assistant:run-${at}`, __openclaw: { idempotencyKey: `cli-assistant:run-${at}` }, content: [{ type: "text", text }], timestamp: at });
  const cliAt = Date.now() + 5000;
  const cliStart = [forwardedPrompt(JOB, "digest", "Daily digest", "post the clip", cliAt), { role: "user", ...fromClaude("prompt-1"), content: cronSays("digest", "Daily digest", "post the clip"), timestamp: cliAt + 1 }, toolCall("t1", cliAt + 2, "ls"), toolResult("t1", cliAt + 3, "clip.mp4"), cliSays("mid-1", cliAt + 4, "Uploading the clip."), toolCall("t2", cliAt + 5, "upload clip.mp4"), toolResult("t2", cliAt + 6, "ok")];
  const hadRuns = (await talkOf(JOB)).length;
  newRun("s-cron-11", cliStart);
  await sleep(1200);
  check((await talkOf(JOB)).length === hadRuns, "a claude-cli run going on with no live run listed has no messages yet: its tool results don't end a turn", says(await talkOf(JOB)));
  edit((s) => {
    const x = s.sessions.find((y) => y.key === JOB);
    x.messages.push(cliSays("final-1", cliAt + 7, "Posted to all three.", "end_turn"), cliJoined(cliAt + 8, "Uploading the clip.\n\nPosted to all three."));
    x.updatedAt = Date.now();
  });
  const cliTalk = (await until(async () => {
    const m = await talkOf(JOB);
    return m.length >= hadRuns + 2 && m;
  })) || [];
  await sleep(600);
  const cliNew = (await talkOf(JOB)).slice(hadRuns);
  const cliSteps = await get(`/api/sessions/${enc(JOB)}/steps`);
  check(cliTalk.length && says(cliNew) === "human:post the clip|agent:Posted to all three." && cliNew[0].routine?.why === "cron" && cliNew[1].via === "dash", "a claude-cli run is its prompt, from its routine, and its last words: not the prompt as the agent's, the words on the way, or all of them joined", says(cliNew));
  check((await state()).sessions.find((x) => x.id === JOB)?.moved === new Date(cliAt + 1).toISOString(), "and it moves the thread up the feed");
  check(cliSteps.steps?.filter((x) => x.kind === "tool" && x.done).length >= 2 && cliSteps.steps.some((x) => x.kind === "say" && x.text === "Uploading the clip.") && !cliSteps.steps.some((x) => x.kind === "say" && /post the clip|Posted to all three\.$/.test(x.text) && x.text !== "Posted to all three."), "its tool calls are done, and what it said on the way is in its steps", JSON.stringify(cliSteps.steps?.slice(-8)));
  // On a gateway that hands the prompt over and has no transcript to read back.
  const aloneAt = cliAt + 100;
  newRun("s-cron-12", [forwardedPrompt(JOB, "digest", "Daily digest", "post another", aloneAt), { role: "assistant", content: [{ type: "text", text: "Posted another." }], timestamp: aloneAt + 1 }]);
  check(says(((await until(async () => {
    const m = await talkOf(JOB);
    return m.length >= hadRuns + 4 && m;
  })) || []).slice(hadRuns + 2)) === "human:post another|agent:Posted another.", "and the prompt it forwards is enough without the transcript's copy", says(await talkOf(JOB)));
  // A job that only worked: tools, and nothing said.
  edit((s) => {
    const x = s.sessions.find((y) => y.key === "agent:scout:cron:prices");
    Object.assign(x, { sessionId: "s-prices-2", messages: [forwardedPrompt(x.key, "prices", "GPU prices", "check the prices", Date.now()), toolCall("p1", Date.now(), "curl prices"), toolResult("p1", Date.now(), "ok")], updatedAt: Date.now() });
  });
  await sleep(900);
  check(!(await state()).sessions.some((x) => x.id === "agent:scout:cron:prices"), "a claude-cli job that said nothing isn't a thread: neither its prompt nor its tool calls are a report");
  const REVIEW = "agent:main:weekly-review";
  await post(`/api/sessions/${enc(REVIEW)}/flag`, { archived: true });
  await sleep(50);
  edit((s) => {
    const x = s.sessions.find((y) => y.key === REVIEW);
    const at = Date.now();
    x.messages.push({ role: "user", content: cronSays("5806d353-0108", "Weekly review", "Build on this week."), timestamp: at }, { role: "assistant", content: [{ type: "text", text: "This week went fine too." }], timestamp: at + 1 });
    x.updatedAt = at;
  });
  await until(async () => (await get(`/api/sessions/${enc(REVIEW)}`)).messages?.some((m) => m.text === "This week went fine too."));
  check((await get(`/api/sessions/${enc(REVIEW)}`)).archived, "so does a session a job names");
  await post(`/api/sessions/${enc(REVIEW)}/flag`, { archived: false });
  check(!calls().some((c) => c.method === "chat.send"), "and nothing from its history is sent back to OpenClaw");
  check(agent?.host === "brick-3" && all.sessions.find((x) => x.id === DISCORD)?.host === "brick-3", "its agents run on the gateway's machine, by the name it gives itself");

  // ---------- avatars ----------
  const pictured = await until(async () => {
    const s = await state();
    const a = (id) => s.agents.find((x) => x.id === id);
    return a("openclaw-main")?.avatar_default && a("openclaw-scout")?.avatar_default && s;
  });
  const duck = pictured?.agents.find((a) => a.id === "openclaw-main");
  const scout = pictured?.agents.find((a) => a.id === "openclaw-scout");
  check(duck?.avatar_default.emoji === "🦆" && !duck.avatar, "an OpenClaw agent's emoji is its avatar");
  const scoutPic = await req(`/api/agents/openclaw-scout/avatar?v=${scout?.avatar_default.image}`);
  check(scout?.avatar_default.type === "image/png" && scoutPic.headers.get("content-type") === "image/png" && Buffer.from(await scoutPic.arrayBuffer()).equals(PNG) && /immutable/.test(scoutPic.headers.get("cache-control")), "so is the picture in its IDENTITY.md, saved and served by agentbook");
  const owl = await post("/api/agents/openclaw-main/avatar", { emoji: "🦉" });
  const setOwl = (await state()).agents.find((a) => a.id === "openclaw-main");
  check(owl.status === 200 && setOwl.avatar?.emoji === "🦉" && setOwl.avatar_default.emoji === "🦆", "you can give it an emoji of your own, over OpenClaw's");
  const sentPic = await req("/api/agents/openclaw-main/avatar", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
  const withPic = (await state()).agents.find((a) => a.id === "openclaw-main");
  const served = await req(`/api/agents/openclaw-main/avatar?v=${withPic.avatar?.image}`);
  check(sentPic.status === 200 && withPic.avatar?.type === "image/png" && served.status === 200 && Buffer.from(await served.arrayBuffer()).equals(PNG), "or a picture");
  const notPic = await req("/api/agents/openclaw-main/avatar", { method: "POST", headers: { "content-type": "image/svg+xml" }, body: "<svg onload='alert(1)'/>" });
  const notEmoji = await post("/api/agents/openclaw-main/avatar", { emoji: "a whole sentence" });
  check(notPic.status === 400 && notEmoji.status === 400 && (await state()).agents.find((a) => a.id === "openclaw-main").avatar?.type === "image/png", "but not an SVG, or words");
  await post("/api/agents/openclaw-main/avatar", { avatar: null });
  const reset = (await state()).agents.find((a) => a.id === "openclaw-main");
  const kept = fs.readdirSync(path.join(HOME, "server", "avatars"));
  check(reset.avatar === null && reset.avatar_default.emoji === "🦆" && kept.length === 1 && kept[0].startsWith(scout.avatar_default.image), "taking yours off goes back to OpenClaw's, and the pictures nobody shows are deleted");
  const steps = await get(`/api/sessions/${enc(MAIN)}/steps`);
  check(steps.steps?.some((x) => x.kind === "tool" && /Search the web for “Lisbon weather Friday”/.test(x.title) && x.done) && steps.steps.some((x) => x.kind === "say" && /Sunny/.test(x.text)), "its tool calls are steps, in agentbook's words, with what it said");

  // ---------- routines ----------
  const withRoutines = await until(async () => {
    const s = await state();
    return s.agents.find((a) => a.id === "openclaw-main")?.routines && s;
  });
  const mainR = withRoutines?.agents.find((a) => a.id === "openclaw-main").routines;
  const scoutR = withRoutines?.agents.find((a) => a.id === "openclaw-scout").routines;
  check(mainR?.n === 1 && mainR.failing === 0 && mainR.next === new Date(now + 3600e3).toISOString() && scoutR?.n === 1 && scoutR.paused === 1 && scoutR.failing === 0, "an agent's profile knows its routines: how many, the next run, and which are paused (OpenClaw's own upkeep left out)");
  const rs = await get("/api/agents/openclaw-main/routines");
  const digest = rs.routines?.find((r) => r.id === "digest");
  check(digest?.post === "agent:main:cron:digest" && digest?.name === "Daily digest" && digest.what === "daily digest" && digest.schedule?.expr === "0 8 * * 1-5" && digest.delivery?.channel === "telegram" && digest.status === "ok" && rs.routines.find((r) => r.id === "memory")?.builtin && !rs.routines.some((r) => r.id === "prices"), "its routines: what each is told, when it runs, where its results go; upkeep marked as such");
  const one = await get("/api/agents/openclaw-main/routines/digest");
  check(one.routine?.id === "digest" && one.runs?.length === 3 && one.runs[0].session === "agent:main:cron:digest:run:7" && one.runs[0].summary === "Three things happened today." && one.runs[2].status === "error" && one.runs[2].error === "model overloaded" && calls().some((c) => c.method === "cron.runs" && c.params.scope === "job" && c.params.id === "digest"), "a routine has its runs, newest first: how each went, what it reported");
  const run = await get(`/api/agents/openclaw-main/routines/digest/run?session=${enc("agent:main:cron:digest:run:7")}`);
  check(run.reply?.text === "Three things happened today." && run.steps?.some((x) => x.kind === "tool" && x.done && /news today/.test(x.title)) && !run.gone, "a run opens to the steps it took and what it said");
  const gone = await get(`/api/agents/openclaw-main/routines/digest/run?session=${enc("agent:main:cron:digest:run:6")}`);
  check(gone.gone === true && !gone.reply && !gone.steps?.length, "a run whose session OpenClaw let go of says so (its summary is what's left), rather than that it said nothing");
  const theirs = await req(`/api/agents/openclaw-main/routines/digest/run?session=${enc("agent:scout:main")}`);
  const notMine = await req("/api/agents/openclaw-main/routines/prices");
  check(theirs.status === 404 && notMine.status === 404, "but not another agent's session, or another agent's routine");
  const ran = await post("/api/agents/openclaw-main/routines/digest", { action: "run" });
  const runs = await get("/api/agents/openclaw-main/routines/digest");
  check(ran.status === 200 && calls().some((c) => c.method === "cron.run" && c.params.id === "digest" && c.params.mode === "force") && runs.runs?.length === 4 && runs.runs[0].summary === "Got it: daily digest", "Run now runs it");
  const paused = await post("/api/agents/openclaw-main/routines/digest", { action: "pause" });
  const pausedR = await until(async () => (await state()).agents.find((a) => a.id === "openclaw-main")?.routines?.paused === 1);
  check(paused.status === 200 && calls().some((c) => c.method === "cron.update" && c.params.id === "digest" && c.params.patch.enabled === false) && pausedR, "Pause pauses it");
  await post("/api/agents/openclaw-main/routines/digest", { action: "resume" });
  check(await until(async () => (await state()).agents.find((a) => a.id === "openclaw-main")?.routines?.paused === 0), "and Resume resumes it");
  // One that's failing says so on its agent, for Needs you, until it isn't or it's paused.
  const setDigest = (jobState) => {
    const s = read();
    Object.assign(s.cron.jobs.find((j) => j.id === "digest").state, jobState);
    write(s);
  };
  const failedNow = () =>
    until(async () => {
      await get("/api/agents/openclaw-main/routines"); // lists them again, rather than in up to 30 seconds
      return (await state()).agents.find((a) => a.id === "openclaw-main")?.routines?.failed?.[0];
    });
  setDigest({ lastRunStatus: "error", lastError: "x".repeat(300), consecutiveErrors: 3, lastRunAtMs: now - 60e3 });
  const failedOne = await failedNow();
  check(failedOne?.id === "digest" && failedOne.name === "Daily digest" && failedOne.times === 3 && failedOne.error.length === 200 && failedOne.at === new Date(now - 60e3).toISOString(), "a routine whose last run failed is on its agent's summary, with how many times in a row and why", JSON.stringify(failedOne));
  // Dismissed: the page leaves that run off Needs you, on every device, and it stays failed on its own page.
  const DIGEST = "openclaw-main/digest";
  const taken = await post("/api/bell/dismiss", { key: DIGEST, at: failedOne.at });
  const after = await state();
  check(taken.status === 200 && after.dismissed?.[DIGEST] === failedOne.at && after.agents.find((a) => a.id === "openclaw-main")?.routines?.failed?.[0]?.id === "digest", "dismissing a failed routine says which run, and the routine still says it failed", JSON.stringify(after.dismissed));
  check((await post("/api/bell/dismiss", {})).status === 400, "and it has to say which routine");
  await post("/api/agents/openclaw-main/routines/digest", { action: "pause" });
  check(await until(async () => (await state()).agents.find((a) => a.id === "openclaw-main")?.routines?.failed?.length === 0, 15000), "and leaves when it's paused");
  await post("/api/agents/openclaw-main/routines/digest", { action: "resume" });
  setDigest({ lastRunStatus: "ok", lastError: null, consecutiveErrors: 0, lastRunAtMs: now - 600e3 });
  check(!(await state()).sessions.some((x) => x.id.includes(":run:")), "its runs' own sessions stay off the feed");
  // Someone else, with the agent public: they see it, not its routines.
  const signup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice" }) });
  const alice = (signup.headers.get("set-cookie") || "").split(";")[0];
  await post("/api/agents/openclaw-main/visibility", { visibility: "public" });
  const asAlice = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: alice } });
  // A public agent is for its owner's contacts.
  await asAlice("/api/people/tester/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ act: "ask" }) });
  await post("/api/people/alice/contact", { act: "yes" });
  const aliceSees = await stateOf(async (p): Promise<Json> => (await asAlice(p)).json());
  check(!Object.keys(aliceSees.dismissed || {}).length, "what you dismissed is yours alone");
  const seen = aliceSees.agents.find((a) => a.id === "openclaw-main");
  const [list, hersPage, ranHers] = [await asAlice("/api/agents/openclaw-main/routines"), await asAlice("/api/agents/openclaw-main/routines/digest"), await asAlice("/api/agents/openclaw-main/routines/digest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run" }) })];
  check(seen && !seen.routines && list.status === 404 && hersPage.status === 404 && ranHers.status === 404, "others who can see the agent don't see its routines, or run them");
  await post("/api/agents/openclaw-main/visibility", { visibility: "private" });

  // ---------- the files its agent names ----------
  // Its workspace is on the gateway's machine, not this one: agentbook reads them through OpenClaw.
  const WS = "/Users/me/.openclaw/workspace";
  edit((s) => {
    s.files = {
      "vox/README.md": "# Vox\n\nShorts, voiced.\n",
      "vox/.env": "SECRET=1",
      "mockups/page.html": '<link rel="stylesheet" href="style.css"><h1>Hi</h1>',
      "mockups/style.css": "h1 { color: teal }",
      "pics/dot.png": { base64: PNG.toString("base64") },
      "pics/photo.png": { base64: PNG.toString("base64"), big: true },
      "clip.mp4": { size: 4_000_000 },
      "big.log": { size: 900_000, text: true },
    };
  });
  const file = async (p: string) => {
    const r = await req(`/api/sessions/${enc(MAIN)}/file?path=${enc(p)}`);
    return { status: r.status, ...((await r.json()) as Json) };
  };
  const peek = (l: Json, p: string = l.path) => req(`/api/peek/${l.id}/${p}`);
  const readme = await file("vox/README.md");
  check(readme.status === 200 && readme.kind === "text" && readme.text.startsWith("# Vox") && readme.path === `${WS}/vox/README.md` && calls().some((c) => c.method === "sessions.files.get" && c.params.sessionKey === MAIN), "a file its agent names opens from its workspace, through OpenClaw");
  const vox = await file("vox/");
  const again = await file(`${vox.path}/README.md`);
  check(vox.kind === "dir" && vox.path === `${WS}/vox` && vox.entries?.map((e) => e.name).join() === "README.md" && again.text === readme.text, "a folder lists what's in it, hidden files left out, and opens from there");
  const page = await file("mockups/page.html");
  const html = await peek(page.peek);
  const css = await peek(page.peek, "mockups/style.css");
  check(page.kind === "html" && html.headers.get("content-type")?.startsWith("text/html") && /<h1>Hi/.test(await html.text()) && /teal/.test(await css.text()), "a page shows as itself, its stylesheet read through OpenClaw too");
  const dot = await file("pics/dot.png");
  const dotRes = await peek(dot.peek);
  check(dot.kind === "image" && dotRes.headers.get("content-type") === "image/png" && Buffer.from(await dotRes.arrayBuffer()).equals(PNG), "so does a picture");
  const photo = await file("pics/photo.png");
  const photoRes = photo.peek ? await peek(photo.peek) : null;
  check(photo.kind === "image" && photoRes?.headers.get("content-type") === "image/png" && Buffer.from(await photoRes.arrayBuffer()).equals(PNG) && calls().some((c) => c.method === "agents.workspace.get" && c.params.agentId === "main" && c.params.path === "pics/photo.png"), "a picture over the 256 KB OpenClaw previews comes from its agent's workspace instead");
  const [clip, big, none, out, hidden] = [await file("clip.mp4"), await file("big.log"), await file("nope.md"), await file("/etc/hosts"), await peek(page.peek, "vox/.env")];
  check(clip.kind === "binary" && !clip.peek && big.status === 413 && /too big/.test(big.error) && none.status === 404 && none.error === `There's no nope.md in ${WS}.` && out.status === 404 && /only opens files in its workspace/.test(out.error) && hidden.status === 404, "one it can't show, one too big, one that isn't there and one outside its workspace each say so");

  // ---------- its workspace, on its profile ----------
  // Every file in it, read through one of its sessions that works there (its main one), and kept up to date.
  const wsOf = (s) => s.agents.find((a) => a.id === "openclaw-main")?.workspace;
  const ws = await get("/api/agents/openclaw-main/workspace");
  check(ws.root === WS && ws.host === "brick-3" && !ws.core && (ws.files || []).map((f) => f.path).sort().join() === "big.log,clip.mp4,mockups/page.html,mockups/style.css,pics/dot.png,pics/photo.png,vox/README.md" && ws.dirs?.map((d) => d.path).sort().join() === "mockups,pics,vox" && ws.files.find((f) => f.path === "vox/README.md")?.size === 23 && calls().some((c) => c.method === "sessions.files.list" && c.params.sessionKey === MAIN && c.params.path === "vox"), "its profile has every file in its workspace, hidden ones left out, read through its main session");
  const wsFile = async (id: string, p: string) => {
    const r = await req(`/api/agents/${id}/workspace/file?path=${enc(p)}`);
    return { status: r.status, ...((await r.json()) as Json) };
  };
  const wsReadme = await wsFile("openclaw-main", `${WS}/vox/README.md`);
  const wsPage = await wsFile("openclaw-main", `${WS}/mockups/page.html`);
  check(wsReadme.status === 200 && wsReadme.kind === "text" && wsReadme.text.startsWith("# Vox") && wsPage.kind === "html" && /teal/.test(await (await peek(wsPage.peek, "mockups/style.css")).text()), "each of its files opens from there, as a post's do");
  const wsPhoto = await wsFile("openclaw-main", `${WS}/pics/photo.png`);
  check(wsPhoto.kind === "image" && Buffer.from(await (await peek(wsPhoto.peek)).arrayBuffer()).equals(PNG), "a picture over 256 KB too");
  // It writes a note in a routine's run: its profile hears, and looks again.
  const wsAt = wsOf(await state())?.at;
  edit((s) => {
    s.files["memory/2026-10-09.md"] = "# Today\n\nWent to the beach.\n";
    s.fileTimes = { "memory/2026-10-09.md": Date.now() };
    s.sessions.find((x) => x.key === "agent:main:cron:digest:run:7").updatedAt = Date.now();
  });
  const heard = await until(async () => {
    const at = wsOf(await state())?.at;
    return at && at !== wsAt && at;
  });
  const wsAfter = await get("/api/agents/openclaw-main/workspace");
  check(heard && wsAfter.files?.some((f) => f.path === "memory/2026-10-09.md") && wsAfter.dirs.some((d) => d.path === "memory" && d.listed), "when its agent does something (a routine's run too), its profile hears, and sees what it wrote");
  // More folders than it lists (20 here): one it didn't go into lists when it's opened, from there.
  const wsAt2 = wsOf(await state())?.at;
  edit((s) => {
    for (let i = 0; i < 45; i++) s.files[`shorts/s${String(i).padStart(2, "0")}/cut.txt`] = "cut";
    s.files["shorts/s44/tmp/a.txt"] = "a";
    s.sessions.find((x) => x.key === "agent:main:cron:digest:run:7").updatedAt = Date.now() + 1000;
  });
  await until(async () => wsOf(await state())?.at !== wsAt2);
  const wsMany = await get("/api/agents/openclaw-main/workspace");
  const s44 = await get(`/api/agents/openclaw-main/workspace?dir=${enc("shorts/s44")}`);
  const [noDir, upDir] = [await req(`/api/agents/openclaw-main/workspace?dir=nope`), await req(`/api/agents/openclaw-main/workspace?dir=${enc("shorts/../..")}`)];
  check(wsMany.dirs?.some((d) => d.path === "shorts/s44" && !d.listed) && !wsMany.files.some((f) => f.path.startsWith("shorts/s44/")) && s44.dir === "shorts/s44" && s44.root === WS && s44.files?.map((f) => f.path).sort().join() === "shorts/s44/cut.txt,shorts/s44/tmp/a.txt" && s44.dirs?.map((d) => `${d.path}:${d.listed}`).join() === "shorts/s44/tmp:true" && noDir.status === 404 && upDir.status === 400, "a folder past the ones it lists lists when it's opened, from there; one that isn't there, or outside it, says so");
  // A workspace slow to list (5 s here): the folders it didn't get to in time list when they're opened.
  const wsAt3 = wsOf(await state())?.at;
  edit((s) => {
    s.listSlowMs = { "": 5500 };
    s.sessions.find((x) => x.key === "agent:main:cron:digest:run:7").updatedAt = Date.now() + 2000;
  });
  await until(async () => wsOf(await state())?.at !== wsAt3);
  const wsSlow = await get("/api/agents/openclaw-main/workspace");
  edit((s) => delete s.listSlowMs);
  const vox2 = await get(`/api/agents/openclaw-main/workspace?dir=vox`);
  check(wsSlow.files?.some((f) => f.path === "big.log") && !wsSlow.files.some((f) => f.path.includes("/")) && ["mockups", "pics", "vox", "shorts"].every((p) => wsSlow.dirs.some((d) => d.path === p && !d.listed)) && vox2.files?.map((f) => f.path).join() === "vox/README.md", "a workspace slow to list shows what it got to in time, the rest listing when it's opened");
  // One without a session yet: the files OpenClaw keeps for it.
  const quiet = await get("/api/agents/openclaw-quiet/workspace");
  const [soul, notes] = [await wsFile("openclaw-quiet", "SOUL.md"), await wsFile("openclaw-quiet", "notes/x.md")];
  check(quiet.core && quiet.root === "/Users/me/.openclaw/quiet" && quiet.files?.map((f) => f.path).join() === "AGENTS.md,SOUL.md" && soul.kind === "text" && soul.text === "Calm." && notes.status === 404, "an agent without a post yet shows the files OpenClaw keeps for it");
  // Someone else who can see the agent doesn't see its workspace.
  await post("/api/agents/openclaw-main/visibility", { visibility: "public" });
  const herAgent = (await stateOf(async (p) => (await asAlice(p)).json())).agents.find((a) => a.id === "openclaw-main");
  const [herWs, herFile] = [await asAlice("/api/agents/openclaw-main/workspace"), await asAlice(`/api/agents/openclaw-main/workspace/file?path=${enc(`${WS}/vox/README.md`)}`)];
  check(herAgent && !herAgent.workspace && herWs.status === 404 && herFile.status === 404, "others who can see the agent don't see its workspace");
  await post("/api/agents/openclaw-main/visibility", { visibility: "private" });

  // ---------- its skills ----------
  // The ones OpenClaw says it can use, on its profile, with how often its sessions read each; one of its own
  // (in its workspace) opens to its instructions, read through OpenClaw.
  edit((s) => (s.files["skills/newsletter/SKILL.md"] = "---\nname: newsletter\ndescription: Write the weekly newsletter.\n---\n\n# Newsletter\n\nThree sections, no more.\n"));
  const profile = await until(async () => {
    const d = await get("/api/agents/openclaw-main");
    return d.skills?.find((k) => k.name === "weather")?.used && d;
  });
  check(profile?.skills.map((k) => k.name).join() === "weather,newsletter" && calls().some((c) => c.method === "skills.status" && c.params.agentId === "main"), "an OpenClaw agent's profile lists the skills its gateway says it can use, not those it can't or that are off");
  check(profile?.skills[0].used === 1 && profile.skills[0].sessions === 1 && profile.skills[0].description === "Get the weather for a place and day.", "with how often its sessions read each one's SKILL.md");
  const scoutSkills = (await get("/api/agents/openclaw-scout")).skills || [];
  check(scoutSkills.map((k) => `${k.name}:${k.used}`).join() === "weather:1", "one a claude-cli agent used through Claude Code's Skill tool goes by its own name, not OpenClaw's plugin's");
  const skill = async (name: string) => {
    const r = await req(`/api/agents/openclaw-main/skills/${enc(name)}`);
    return { status: r.status, ...((await r.json()) as Json) };
  };
  const [own, bundled] = [await skill("newsletter"), await skill("weather")];
  check(own.status === 200 && own.body?.includes("Three sections, no more.") && own.description === "Write the weekly newsletter.", "a skill in its workspace opens to its instructions, read through OpenClaw");
  check(bundled.status === 200 && bundled.body === null && bundled.used === 1 && bundled.uses?.[0]?.id === MAIN, "one elsewhere on the gateway's machine says what it is and which sessions used it");
  await post("/api/agents/openclaw-main/visibility", { visibility: "public" });
  const herSkills: Json = await (await asAlice("/api/agents/openclaw-main")).json();
  const herSkill: Json = await (await asAlice("/api/agents/openclaw-main/skills/newsletter")).json();
  check(herSkills.skills?.map((k) => k.name).join() === "weather,newsletter" && !herSkills.skills.some((k) => k.file) && herSkill.body === null && herSkill.file === null, "others who can see the agent see what its skills are, not their instructions or where they are");
  await post("/api/agents/openclaw-main/visibility", { visibility: "private" });

  // ---------- starting one ----------
  const launched = await post("/api/launch", { prompt: "Draft the newsletter", agent: "openclaw-main" });
  const created = calls().find((c) => c.method === "sessions.create");
  check(launched.status === 200 && created?.params.agentId === "main" && created.params.message === "Draft the newsletter" && created.params.key === `agentbook-${launched.lid}`, "posting on its wall creates an OpenClaw session, without a folder");
  check(created?.params.permissionMode === undefined, "in the gateway's own mode when none is picked");
  check(created?.params.displayName === "Draft the newsletter", "named as its thread is, so OpenClaw's own list doesn't show its key", created?.params.displayName);
  const inPlan = await post("/api/launch", { prompt: "Plan the newsletter", agent: "openclaw-main", mode: "plan" });
  check(inPlan.status === 200 && !!(await until(() => calls().find((c) => c.method === "sessions.create" && c.params.key === `agentbook-${inPlan.lid}` && c.params.permissionMode === "read-only"))), "and in read-only, Plan's, when Plan is picked");
  // A gateway from before either: it starts all the same, without them.
  edit((s) => (s.unknownCreate = ["displayName", "permissionMode"]));
  const onOld = await post("/api/launch", { prompt: "Plan the old way", agent: "openclaw-main", mode: "plan" });
  const oldKey = `agent:main:agentbook-${onOld.lid}`;
  const oldThread = await until(async () => {
    const d = await get(`/api/sessions/${enc(oldKey)}`);
    return d.messages?.some((m) => m.from === "agent" && /Got it: Plan the old way/.test(m.text)) && d;
  });
  check(onOld.status === 200 && oldThread && oldThread.messages.some((m) => /doesn't take a mode for a session yet/.test(m.text)), "a gateway that doesn't take a name or a mode starts it without them, and says so for the mode", JSON.stringify(oldThread?.messages?.map((m) => m.text)));
  edit((s) => delete s.unknownCreate);
  const newKey = `agent:main:agentbook-${launched.lid}`;
  const fresh = await until(async () => (await state()).sessions.find((x) => x.id === newKey && x.messages?.some?.((m) => m.from === "agent") !== false));
  const freshDetail = await until(async () => {
    const d = await get(`/api/sessions/${enc(newKey)}`);
    return d.messages?.some((m) => m.from === "agent" && /Got it: Draft the newsletter/.test(m.text)) && d;
  });
  check(fresh && freshDetail?.messages[0]?.text === "Draft the newsletter" && freshDetail.messages[0].from === "human" && !(await state()).launches.some((l) => l.id === launched.lid && !l.post), "its post takes the launch's place, with your message and its reply");
  // With a picture attached: it goes with the first message.
  const sketch: Json = await (await req("/api/upload?draft=1&name=sketch.png", { method: "POST", body: PNG })).json();
  const withSketch = await post("/api/launch", { prompt: "Caption this", agent: "openclaw-main", files: [sketch.id] });
  const createdWith = await until(() => calls().find((c) => c.method === "sessions.create" && c.params.key === `agentbook-${withSketch.lid}`));
  check(createdWith?.params.message === "Caption this" && createdWith.params.attachments?.length === 1 && createdWith.params.attachments[0].fileName === "sketch.png" && Buffer.from(createdWith.params.attachments[0].content, "base64").equals(PNG), "a picture attached to a new post goes to OpenClaw with its first message, not as a path");
  const sketchPost = await until(async () => {
    const d = await get(`/api/sessions/${enc(`agent:main:agentbook-${withSketch.lid}`)}`);
    return d.messages?.some((m) => m.from === "agent" && /Got it: Caption this/.test(m.text)) && d;
  });
  check(sketchPost?.messages.filter((m) => m.from === "human").length === 1 && sketchPost.messages[0].files?.map((f) => f.name).join() === "sketch.png", "and the post shows it on your message, once");

  // ---------- a thread on one of its routines, from the routine's page ----------
  const onDigest = await post("/api/launch", { prompt: "Make it weekly", agent: "openclaw-main", on_routine: "digest" });
  const createdOn = await until(() => calls().find((c) => c.method === "sessions.create" && c.params.key === `agentbook-${onDigest.lid}`));
  const toldOn = createdOn?.params.message || "";
  check(onDigest.status === 200 && toldOn.startsWith("Make it weekly\n\nThis thread is on your routine \"Daily digest\": an OpenClaw cron job (automation), id digest.") && toldOn.includes('- Runs: cron "0 8 * * 1-5" (Europe/Lisbon); on') && toldOn.includes("- What it's told:\n  > daily digest") && toldOn.includes("failed: model overloaded") && toldOn.includes("Your automations tool"), "a thread on a routine tells its agent which one, how it's set up, how its last runs went and how it changes it", toldOn);
  const onKey = `agent:main:agentbook-${onDigest.lid}`;
  const onPage = await until(async () => {
    const d = await get("/api/agents/openclaw-main/routines/digest");
    return d.threads?.[0]?.post && d;
  });
  check(onPage?.threads.length === 1 && onPage.threads[0].post === onKey && onPage.threads[0].lid === onDigest.lid, "and the routine's page lists the thread it became", JSON.stringify(onPage?.threads));
  const onThread = await until(async () => {
    const d = await get(`/api/sessions/${enc(onKey)}`);
    return d.messages?.length && d;
  });
  check(onThread?.messages[0].text === "Make it weekly", "the thread shows what you wrote, not what its agent was told with it", onThread?.messages[0]?.text);
  check((await post("/api/launch", { prompt: "Hm", agent: "openclaw-main", on_routine: "prices" })).status === 404, "not on another agent's routine");

  // One of agentbook's routines that runs as it, linked to a page: OpenClaw's agents have agentbook's tools (its
  // plugin on the gateway), so the run is for that page as any agent's is, and its agent contributes to it.
  const numbersPage = await post("/api/pages", { title: "Post queue" });
  const numbers = await post("/api/routines", { name: "Instagram numbers", prompt: "Read the numbers and save them.", agent: "openclaw-main", links: [{ kind: "page", id: numbersPage.id }], schedule: "manual" });
  check(numbers.status === 200 && numbers.links.some((l) => l.kind === "page" && l.id === numbersPage.id), "a routine that runs as it links to a page", JSON.stringify(numbers));
  const ranNumbers = await post(`/api/routines/${numbers.id}/run`);
  const createdRun = await until(() => calls().find((c) => c.method === "sessions.create" && /Read the numbers and save them\./.test(c.params.message || "")));
  const toldRun = createdRun?.params.message || "";
  check(ranNumbers.status === 200 && /This is a run of the routine "Instagram numbers"/.test(toldRun) && /It's linked to the page "Post queue" \([^)]+\): read it with ab_page_read and update it with ab_page_write/.test(toldRun), "its run starts, told to read and update the page it's linked to", toldRun);
  const runThread = await until(async () => (await state()).sessions.find((x) => x.id === `agent:main:${createdRun?.params.key}`));
  check(createdRun?.params.displayName === "Instagram numbers" && runThread?.title === "Instagram numbers", "named after its routine, in OpenClaw and on agentbook, not after what its run is told first", `${createdRun?.params.displayName} / ${runThread?.title}`);
  const ranRow = await until(async () => {
    const d = await get(`/api/routines/${numbers.id}`);
    return d.runs?.length && d;
  });
  check(ranRow?.runs[0].ok !== false && !ranRow.runs[0].error && (await get(`/api/pages/${numbersPage.id}`)).contributors?.some((c) => c.agent === "openclaw-main"), "the run doesn't fail, and its agent contributes to the page", JSON.stringify(ranRow?.runs?.[0]));
  const forPage = await post("/api/launch", { prompt: "Fill it in", agent: "openclaw-main", page: numbersPage.id });
  check(forPage.status === 200 && !!(await until(() => calls().find((c) => c.method === "sessions.create" && /Fill it in/.test(c.params.message || "")))), "and a thread for a page starts with it", JSON.stringify(forPage));

  // ---------- writing to it ----------
  await post(`/api/sessions/${enc(MAIN)}/messages`, { text: "And Saturday?" });
  const sent = await until(() => calls().find((c) => c.method === "chat.send" && c.params.message === "And Saturday?"));
  check(sent?.params.sessionKey === MAIN && sent.params.idempotencyKey, "what you write goes to the session");
  const replied = await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.from === "agent" && m.text === "Got it: And Saturday?"));
  const mine = (await get(`/api/sessions/${enc(MAIN)}`)).messages.filter((m) => m.text === "And Saturday?");
  check(replied && mine.length === 1 && mine[0].via === "dash", "its reply shows on the post, and your message once");

  // ---------- files you attach ----------
  // Its agents may be on another machine, so the files go to OpenClaw with the message, not their paths here.
  const upload = async (name: string, body: string | Buffer): Promise<Json> => (await req(`/api/upload?draft=1&name=${name}`, { method: "POST", body })).json();
  const [shot, memo] = [await upload("shot.png", PNG), await upload("notes.txt", "the notes")];
  await post(`/api/sessions/${enc(MAIN)}/messages`, { text: "What's wrong here?", files: [shot.id, memo.id] });
  const withFiles = await until(() => calls().find((c) => c.method === "chat.send" && c.params.message === "What's wrong here?"));
  const atts = withFiles?.params.attachments || [];
  check(atts.length === 2 && atts[0].fileName === "shot.png" && atts[0].mimeType === "image/png" && Buffer.from(atts[0].content, "base64").equals(PNG) && atts[1].fileName === "notes.txt" && Buffer.from(atts[1].content, "base64").toString() === "the notes", "files attached to a message go to OpenClaw with it");
  check(withFiles && !/Attached files|[\\/]files[\\/]/.test(withFiles.params.message), "rather than as paths on this machine");
  await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.text === "Got it: What's wrong here?"));
  const sentWith = (await get(`/api/sessions/${enc(MAIN)}`)).messages.filter((m) => /What's wrong here\?/.test(m.text) && m.from === "human");
  check(sentWith.length === 1 && sentWith[0].files?.map((f) => f.name).join() === "shot.png,notes.txt", "and your message shows once, with its files");
  // Through the openclaw command, a file too big for its command line stays here, and the post says so.
  const huge = await upload("big.txt", "x".repeat(800 << 10));
  await post(`/api/sessions/${enc(MAIN)}/messages`, { text: "And this log?", files: [huge.id] });
  const bigSent = await until(() => calls().find((c) => c.method === "chat.send" && c.params.message === "And this log?"));
  const bigNote = await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.from === "agent" && /couldn't send big\.txt/.test(m.text)));
  check(bigSent && !bigSent.params.attachments && bigNote, "a file too big to send stays behind, and the post says so");

  // ---------- from a chat channel ----------
  await post(`/api/sessions/${enc(MAIN)}/flag`, { archived: true });
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "Said before it was archived", timestamp: Date.now() - 3600e3, __openclaw: { transport: { channel: "slack" } } });
    x.updatedAt = Date.now();
  });
  await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.text === "Said before it was archived"));
  check((await get(`/api/sessions/${enc(MAIN)}`)).archived, "a message from before you archived it, copied in since, leaves it archived");
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "Book the 9am train", timestamp: Date.now(), __openclaw: { transport: { channel: "slack" } } }, { role: "assistant", content: [{ type: "text", text: "Booked." }], timestamp: Date.now() });
    x.updatedAt = Date.now();
  });
  const fromSlack = await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.text === "Book the 9am train"));
  check(fromSlack?.from === "human" && fromSlack.via === "slack", "a message sent to it on Slack shows, saying so");
  check(!(await get(`/api/sessions/${enc(MAIN)}`)).archived, "and brings it back to the feed if it was archived");
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: [{ type: "text", text: "This one?" }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], timestamp: Date.now(), __openclaw: { transport: { channel: "whatsapp" } } }, { role: "assistant", content: [{ type: "text", text: "That's the one." }], timestamp: Date.now() });
    x.updatedAt = Date.now();
  });
  const withShot = await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.text === "This one?"));
  const shotRes = withShot?.files?.[0] && (await req(`/api/files/${withShot.files[0].id}`));
  check(withShot?.files?.map((f) => f.name).join() === "picture.png" && shotRes?.status === 200 && Buffer.from(await shotRes.arrayBuffer()).equals(PNG) && calls().some((c) => c.method === "artifacts.download"), "a picture sent with a message shows with it, read through the openclaw command");

  // ---------- what OpenClaw says to its agent ----------
  // A tool's result handed back to the agent (OpenClaw says it isn't yours; in a claude-cli agent's history
  // only its words do), a reminder, and the notes OpenClaw puts before what you wrote; a reply that sends a
  // file with a MEDIA: line.
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    const t = Date.now();
    const routed = "[Inter-session message] sourceSession=image_generate:abc sourceChannel=internal sourceTool=image_generate isUser=false\nThis content was routed by OpenClaw from another session or internal tool.";
    x.messages.push(
      { role: "user", content: "Make a poster", timestamp: t },
      { role: "assistant", content: [{ type: "text", text: "Drawing it." }], timestamp: t + 1 },
      { role: "user", content: `${routed}\n\nA background task completed.`, provenance: { kind: "inter_session", sourceTool: "image_generate" }, timestamp: t + 2 },
      { role: "assistant", content: [{ type: "text", text: "Here's the poster.\n\nMEDIA:/Users/me/.openclaw/media/tool-image-generation/poster---0d4eab51-cdc9-41cc-a585-cffd0c871e31.png\n\nWant another?" }], timestamp: t + 3 },
      { role: "user", content: `${routed}\n\n@/Users/me/.openclaw-cli-images/f00.png`, timestamp: t + 4 },
      { role: "assistant", content: [{ type: "text", text: "MEDIA:/Users/me/.openclaw/media/outbound/poster-big.png" }], timestamp: t + 5 },
      { role: "user", content: "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.\n\nA scheduled reminder has been triggered. The reminder content is:\n\nStretch\n\nHandle this reminder internally.", timestamp: t + 6 },
      { role: "assistant", content: [{ type: "text", text: "Stretched." }], timestamp: t + 7 },
      { role: "user", content: "Exec completed (briny-va, code 0) :: wrote render/poster.en.srt 95 cues", timestamp: t + 7.2 },
      { role: "assistant", content: [{ type: "text", text: "Subtitles are written." }], timestamp: t + 7.4 },
      { role: "user", content: "Exec failed (fast-hav, signal SIGTERM)\n\nThe command was terminated, but external side effects may already have completed.", timestamp: t + 7.6 },
      { role: "assistant", content: [{ type: "text", text: "The render was stopped." }], timestamp: t + 7.8 },
      { role: "user", content: "System: [2026-10-09 10:00:00 GMT-3] Model switched to anthropic/claude-opus-5.\n\nMake it bigger", timestamp: t + 8 },
      { role: "assistant", content: [{ type: "text", text: "Bigger it is." }], timestamp: t + 9 },
      { role: "user", content: "[media attached: media://inbound/clip.mov (video/quicktime)]\n[Video]\nUser text:\nUse this for the dance\nDescription:\nA dancer in a studio.", timestamp: t + 10 },
      { role: "assistant", content: [{ type: "text", text: "Media: one clip, 12 seconds.\nOn it." }], timestamp: t + 11 },
    );
    x.updatedAt = Date.now();
  });
  const said = await until(async () => {
    const ms = (await get(`/api/sessions/${enc(MAIN)}`)).messages || [];
    return ms.some((m) => m.text?.endsWith("On it.")) && ms;
  });
  const talked = said && said.map((m) => `${m.from}:${m.text}`);
  const poster = said && said.find((m) => m.text === "Here's the poster.\n\nWant another?");
  const bigPoster = said && said.find((m) => m.from === "agent" && !m.text && m.files?.[0]?.name === "poster-big.png");
  check(poster?.files?.map((f) => f.name).join() === "poster.png" && bigPoster && !talked.some((m) => /MEDIA:/.test(m)) && talked.includes("agent:Media: one clip, 12 seconds.\nOn it."), "a reply's MEDIA: lines are its files, named as OpenClaw names them, not its words (\"Media:\" as words stays)");
  const posterRes = await req(`/api/files/${poster.files[0].id}`);
  check(posterRes.status === 404 && /gateway it connects to itself/.test(((await posterRes.json()) as { error: string }).error), "through the openclaw command, such a file says it opens only from a gateway agentbook connects to");
  check(talked && talked.includes("human:Make it bigger") && talked.includes("agent:Stretched.") && talked.includes("human:Use this for the dance") && talked.includes("agent:Subtitles are written.") && talked.includes("agent:The render was stopped.") && !talked.some((m) => /Inter-session|reminder|System:|OpenClaw resumed|openclaw-cli-images|media attached|A dancer|Exec (completed|failed)/.test(m)), "what OpenClaw tells its agent (a tool's result, a reminder, a background command that ended) isn't yours, and its notes around what you wrote don't show");
  // A turn that failed before the agent said anything: OpenClaw's notice is its reply, not silence.
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    const t = Date.now();
    x.messages.push(
      { role: "user", content: "Any news?", timestamp: t },
      { role: "custom", customType: "run-failed-before-reply", content: "This turn ended before a reply: All models failed (2): anthropic/claude-opus-5-5: CLI history owner changed before preparation (unknown)", display: true, timestamp: t + 1 },
    );
    x.updatedAt = Date.now();
  });
  const failedTurn = await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages?.find((m) => m.from === "agent" && /^This turn ended before a reply: All models failed/.test(m.text || "")));
  check(failedTurn, "a turn that ended before a reply says why on the post");

  // An answer agentbook told the agent about before it last started, or that its plugin on the gateway passed on: the
  // question shows it answered, so it's no message of yours.
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    const t = Date.now();
    x.messages.push({ role: "user", content: 'The person answered "Post the reel now?": Yes', timestamp: t }, { role: "assistant", content: [{ type: "text", text: "Posting the reel." }], timestamp: t + 1 });
    x.updatedAt = Date.now();
  });
  const afterAnswer = await until(async () => {
    const t = (await get(`/api/sessions/${enc(MAIN)}`)).messages.map((m) => `${m.from}:${m.text}`);
    return t.includes("agent:Posting the reel.") && t;
  });
  check(afterAnswer && !afterAnswer.some((m) => /The person answered "Post the reel now\?"/.test(m)), "an answer agentbook passed on isn't shown as yours, and the reply to it is");

  // ---------- an approval answered in OpenClaw itself ----------
  // Answered in its own app or a chat, it leaves OpenClaw's list; when the turn ends, the prompt leaves the post too.
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.hasActiveRun = true;
    x.updatedAt = Date.now();
    s.approvals = [{ id: "ap-0", request: { command: "npm publish", cwd: "/Users/me/site", agentId: "main", sessionKey: MAIN }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 600e3 }];
  });
  const elsewhere = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.kind === "permission" && !q.answered));
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    s.approvals = [];
    x.hasActiveRun = false;
    x.updatedAt = Date.now();
  });
  const settled = await until(async () => (await state()).questions.find((q) => q.id === elsewhere?.id && q.answered));
  check(elsewhere?.preview === "npm publish" && settled?.by === "terminal", "an approval answered in OpenClaw itself leaves the post once its turn ends");
  // One whose run agentbook never saw going (it started after its session was read, and ended before the next look):
  // no turn's end comes, so it leaves once OpenClaw no longer lists it.
  edit((s) => {
    s.approvals = [{ id: "ap-9", request: { command: "npm test", cwd: "/Users/me/site", agentId: "main", sessionKey: MAIN }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 600e3 }];
  });
  const unseen = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.kind === "permission" && q.preview === "npm test" && !q.answered));
  edit((s) => {
    s.approvals = [];
  });
  const unseenGone = await until(async () => (await state()).questions.find((q) => q.id === unseen?.id && q.answered));
  check(unseen && unseenGone?.by === "terminal", "and one whose run it never saw going leaves once OpenClaw no longer lists it");

  // ---------- working, and stopping ----------
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.hasActiveRun = true;
    x.updatedAt = Date.now();
  });
  const working = await until(async () => (await state()).sessions.find((x) => x.id === MAIN && x.effective === "working"));
  check(working?.rt?.working === true, "while it runs, its post is working");
  const stopped = await post(`/api/sessions/${enc(MAIN)}/stop`);
  check(stopped.status === 200 && calls().some((c) => c.method === "sessions.abort" && c.params.key === MAIN), "Stop aborts its turn");
  const idle = await until(async () => (await state()).sessions.find((x) => x.id === MAIN && x.effective !== "working"));
  check(idle && !idle.busy, "and then it's waiting for you again");

  // ---------- approvals and questions ----------
  edit((s) => {
    s.approvals = [{ id: "ap-1", request: { command: "rm -rf build", cwd: "/Users/me/site", agentId: "main", sessionKey: MAIN }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 600e3 }];
    s.questions = [{ id: "qq-1", agentId: "main", sessionKey: MAIN, status: "pending", questions: [{ id: "tone", header: "Tone", question: "Which tone for the newsletter?", options: [{ label: "Casual" }, { label: "Formal", description: "for investors" }] }] }];
  });
  const perm = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.kind === "permission" && !q.answered));
  check(perm?.preview === "rm -rf build" && /site/.test(perm.detail), "an exec approval is an Allow/Deny prompt on the post");
  await post(`/api/questions/${perm.id}/answer`, { value: "allow" });
  const resolved = await until(() => calls().find((c) => c.method === "exec.approval.resolve"));
  check(resolved?.params.id === "ap-1" && resolved.params.decision === "allow-once", "allowing it resolves the approval in OpenClaw, once");
  const poll = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.kind === "choice" && !q.answered));
  check(poll?.title === "Which tone for the newsletter?" && poll.options.length === 2 && poll.options[1].detail === "for investors", "its question is a poll");
  await post(`/api/questions/${poll.id}/answer`, { value: "Formal" });
  // One of its tools (plugin.approval: Read on a Claude CLI backend), which OpenClaw asks about as it does a command.
  edit((s) => {
    s.toolApprovals = [{ id: "plugin:pa-1", request: { pluginId: "claude-cli", toolName: "Read", title: "claude-cli native tool: Read", description: '{"file_path":"/Users/me/site/queue.json"}', detail: '{"file_path":"/Users/me/site/queue.json"}', agentId: "main", sessionKey: MAIN, allowedDecisions: ["allow-once", "allow-always", "deny"] }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 120e3 }];
  });
  const toolAsk = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.kind === "permission" && q.tool_name === "Read" && !q.answered));
  check(toolAsk?.title === "Allow Read?" && toolAsk.preview === "/Users/me/site/queue.json", `a tool OpenClaw asks to use is an Allow/Deny prompt too, with the file it reads (${toolAsk ? `${toolAsk.title} ${toolAsk.preview}` : "none"})`);
  await post(`/api/questions/${toolAsk.id}/answer`, { value: "allow" });
  const toolOk = await until(() => calls().find((c) => c.method === "plugin.approval.resolve"));
  check(toolOk?.params.id === "plugin:pa-1" && toolOk.params.decision === "allow-once", "allowing it resolves its plugin approval in OpenClaw, once");
  const answered = await until(() => calls().find((c) => c.method === "question.resolve"));
  check(answered?.params.id === "qq-1" && JSON.stringify(answered.params.answers) === JSON.stringify({ answers: { tone: ["Formal"] } }), "answering it resolves the question in OpenClaw");
  edit((s) => {
    s.approvals = [{ id: "ap-2", request: { command: "git push --force", cwd: "/Users/me/site", agentId: "main", sessionKey: MAIN }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 600e3 }];
    s.questions = [{ id: "qq-2", agentId: "main", sessionKey: MAIN, status: "pending", questions: [{ id: "tone", header: "Tone", question: "Which tone for the launch post?", options: [{ label: "Casual" }, { label: "Formal" }] }] }];
  });
  await until(async () => (await state()).questions.filter((q) => q.post === MAIN && !q.answered).length === 2);
  await post(`/api/sessions/${enc(MAIN)}/messages`, { text: "Hold off, I'll write it myself" });
  await until(() => calls().find((c) => c.method === "chat.send" && c.params.message === "Hold off, I'll write it myself"));
  const asideLog = calls();
  const sentAt = asideLog.findIndex((c) => c.method === "chat.send" && c.params.message === "Hold off, I'll write it myself");
  const denied = asideLog.findIndex((c) => c.method === "exec.approval.resolve" && c.params.id === "ap-2");
  const dropped = asideLog.findIndex((c) => c.method === "question.resolve" && c.params.id === "qq-2");
  check(denied >= 0 && dropped >= 0 && asideLog[denied].params.decision === "deny" && JSON.stringify(asideLog[dropped].params.answers) === JSON.stringify({ answers: { tone: [] } }) && denied < sentAt && dropped < sentAt, "a comment while it waits on you denies the approval, leaves the question unanswered, then reaches it");
  check(!(await state()).questions.some((q) => q.post === MAIN && !q.answered), "and nothing on the post needs you any more");
  await until(async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages.some((m) => m.text === "Got it: Hold off, I'll write it myself"));

  // ---------- hiding an agent ----------
  const hide = await post(`/api/agents/openclaw-scout/hidden`, { hidden: true });
  const hid = await until(async () => (await state()).agents.find((a) => a.id === "openclaw-scout" && a.hidden));
  check(hide.status === 200 && hid, "you can hide an agent");
  await post(`/api/agents/openclaw-scout/hidden`, { hidden: false });
  check(await until(async () => (await state()).agents.find((a) => a.id === "openclaw-scout" && !a.hidden)), "and show it again");

  // A turn agentbook already copied as all it said, joined, keeps that one reply when a restart reads it again.
  const OLD_TURN = "agent:scout:main";
  const oldAt = Date.now();
  edit((s) => {
    const x = s.sessions.find((y) => y.key === OLD_TURN);
    x.messages.push({ role: "user", content: "Check the old one", timestamp: oldAt, __openclaw: { id: "old-you" } }, { role: "assistant", content: [{ type: "text", text: "One.\n\nTwo." }], timestamp: oldAt + 6, __openclaw: { id: "old-joined" } });
    x.updatedAt = Date.now();
  });
  const oldTalk = async () => (await get(`/api/sessions/${enc(OLD_TURN)}`)).messages.map((m) => `${m.from}:${m.text}`);
  await until(async () => (await oldTalk()).includes("agent:One.\n\nTwo."));
  const oldBefore = await oldTalk();

  // ---------- a restart ----------
  const before = (await state()).sessions.length;
  const talk = async () => (await get(`/api/sessions/${enc(MAIN)}`)).messages.map((m) => `${m.from}:${m.text}`);
  const talkBefore = await talk();
  const sendsBefore = calls().filter((c) => c.method === "chat.send").length;
  server.kill();
  await sleep(300);
  edit((s) => {
    const x = s.sessions.find((y) => y.key === OLD_TURN);
    const end = x.messages.pop();
    // Read by today's rules, a message another agent forwarded to it mid-turn ends the turn, so "One." would be a
    // reply of its own; and an answer agentbook sent it, which the agentbook before the restart knew was its own,
    // would be yours. Both are older than what the post has, so they stay as they were.
    const forwarded = { role: "assistant", content: "ok, done", provenance: { kind: "inter_session", sourceSessionKey: "agent:main:main", sourceTool: "sessions_send" }, senderLabel: "Forwarded from main", senderSession: { sessionKey: "agent:main:main", agentId: "main" }, timestamp: oldAt + 4, __openclaw: { id: "old-forwarded" } };
    x.messages.push(cliSays("old-1", oldAt + 1, "One."), toolCall("o1", oldAt + 2, "ls"), toolResult("o1", oldAt + 3, "ok"), forwarded, cliSays("old-2", oldAt + 5, "Two.", "end_turn"), { ...end, api: "cli", stopReason: "stop", idempotencyKey: "cli-assistant:old", timestamp: oldAt + 6 });
    x.messages.splice(x.messages.findIndex((m) => m.__openclaw?.id === "old-you"), 0, { role: "user", content: 'The person answered "Ship it?": Yes', timestamp: oldAt - 1, __openclaw: { id: "old-answer" } });
  });
  await startServer();
  await until(async () => (await state()).sessions.length >= before && !(await state()).sessions.some((x) => x.rt?.syncing));
  await sleep(1500);
  check(JSON.stringify(await oldTalk()) === JSON.stringify(oldBefore), "a turn copied as one joined reply isn't copied again in pieces, nor cut where it was by what's older than the post", JSON.stringify((await oldTalk()).slice(-4)));
  const talkAfter = await talk();
  check(JSON.stringify(talkAfter) === JSON.stringify(talkBefore), `a restart doesn't copy its history again (${talkBefore.length} → ${talkAfter.length} messages)`);
  check(calls().filter((c) => c.method === "chat.send").length === sendsBefore && !calls().some((c) => c.method === "chat.send" && /9am train/.test(c.params.message)), "and sends OpenClaw nothing: not the Slack message, not anything");

  // ---------- more than a page while it was off ----------
  server.kill();
  await sleep(300);
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    const t = Date.now(); // while it was off: after everything the post has
    x.messages.push({ role: "user", content: "Pack the snorkel too", timestamp: t });
    for (let i = 0; i < 150; i++) x.messages.push({ role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "exec", arguments: { command: `ls ${i}` } }], timestamp: t + i * 10 + 1 }, { role: "toolResult", toolCallId: `tc${i}`, content: "ok", timestamp: t + i * 10 + 2 });
    x.messages.push({ role: "assistant", content: [{ type: "text", text: "Packed." }], timestamp: t + 2000 }, { role: "user", content: "Anything else?", timestamp: t + 3000 }, { role: "assistant", content: [{ type: "text", text: "That's all." }], timestamp: t + 3001 });
    x.updatedAt = Date.now();
  });
  await startServer();
  const caught = await until(async () => {
    const t = await talk();
    return t.includes("human:Anything else?") && t;
  });
  check(caught && caught.includes("human:Pack the snorkel too") && caught.includes("agent:Packed.") && caught.filter((m) => m === "human:Pack the snorkel too").length === 1, "what was said while it was off, more than a page of it, all shows after a restart, once");

  // ---------- posts copied before agentbook left OpenClaw's notes out ----------
  const SCOUT = "agent:scout:main";
  server.kill();
  await sleep(300);
  // In this machine's store, and in what the server keeps of it, as an agentbook from before the split brings it.
  const { DatabaseSync } = await import("./harness-sql.ts");
  const storage = new DatabaseSync(path.join(HOME, "storage.db"));
  const stores = storage.prepare("select distinct scope from events where scope = 'cli' or scope like 'device:%'").all().map((r) => r.scope);
  storage.close();
  for (const scope of stores) {
    const db = new DatabaseSync(path.join(HOME, "storage.db"));
    const at = new Date(now - 86400e3).toISOString();
    const old = [
      { from: "human", via: "terminal", text: "[Inter-session message] sourceSession=image_generate:x sourceChannel=internal sourceTool=image_generate isUser=false\nThis content was routed by OpenClaw from another session or internal tool." },
      { from: "agent", via: "dash", text: "Here's the chart.\n\nMEDIA:/Users/me/.openclaw/media/outbound/chart.png" },
      { from: "human", via: "discord", text: "System: [2026-10-09 10:00:00 GMT-3] Model switched to anthropic/claude-opus-5.\n\nShip it" },
      { from: "agent", via: "dash", text: "MEDIA:/Users/me/.openclaw/media/outbound/clip.mp4" },
      { from: "human", via: "terminal", text: "Exec completed (quick-co, code 0) :: Rendered scene frames 1-503" },
    ];
    const add = db.prepare("insert into messages (scope, id, post, ord, data) values (?, ?, ?, ?, ?)");
    old.forEach((m, i) => add.run(scope, `mold${i}`, SCOUT, 1e9 + i, JSON.stringify({ id: `mold${i}`, post: SCOUT, file_id: null, files: [], at, ext: `old-${i}`, ...m })));
    db.close();
  }
  await startServer();
  const tidied = await until(async () => {
    const t = ((await get(`/api/sessions/${enc(SCOUT)}`)).messages || []).map((m) => `${m.from}:${m.text}`);
    return t.includes("human:Ship it") && t;
  });
  const scoutFiles = Object.fromEntries(((await get(`/api/sessions/${enc(SCOUT)}`)).messages || []).filter((m) => m.from === "agent" && m.files?.length).map((m) => [m.text, m.files.map((f) => f.name).join()]));
  check(tidied && tidied.includes("agent:Here's the chart.") && !tidied.some((m) => /Inter-session|MEDIA:|System:|Exec completed/.test(m)) && tidied.includes("human:Find a cheaper GPU host") && scoutFiles["Here's the chart."] === "chart.png" && scoutFiles[""] === "clip.mp4", "a post copied before keeps what was said, without OpenClaw's notes or what it told its agent, its replies' MEDIA: lines now their files");

  // ---------- a command that isn't there ----------
  check(!/OpenClaw isn't installed/.test(serverLog), "agentbook found the openclaw command");
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
