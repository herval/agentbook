#!/usr/bin/env node
// A new person's first minutes (A): a machine new to agentbook goes on their account from its
// first-run page (a fake relay, test/fake-relay.ts), and keeps what its agents did before until they pick on the
// welcome card; the page signs them in straight on (auth.first); the card's read lists Claude Code's past sessions by
// day and folder; and their pick brings in those in range, less a folder left out, as ended threads with their words.
// Run: node test/onboarding.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeRelay } from "./fake-relay.ts";
import { poolPort, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(REPO, "plugin", "cli", "main.mjs");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-onboarding-")));
const CLAUDE = path.join(ROOT, "claude-config");
const PORT = testPort(7210);
const CLI = poolPort();
const PAGE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => Promise<T>, ms = 20e3): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return null;
};

// Claude Code's past here: transcripts as it writes them, each last written `days` ago.
const DAY = 86400e3;
const alpha = path.join(ROOT, "work", "alpha");
const beta = path.join(ROOT, "work", "beta");
const at = (days: number, min = 0) => new Date(Date.now() - days * DAY + min * 60e3).toISOString();
function transcript(id: string, cwd: string, days: number, entries: Json[]) {
  const dir = path.join(CLAUDE, "projects", cwd.replace(/[/.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [{ type: "permission-mode", permissionMode: "default", sessionId: id }, ...entries.map((e, i) => ({ parentUuid: null, isSidechain: false, uuid: `${id}-${i}`, timestamp: at(days, i), cwd, sessionId: id, version: "2.1.0", gitBranch: "main", ...e }))];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(file, t, t);
}
const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const said = (text: string) => ({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const tool = (id: string) => [
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "make test" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "all passed" }] } },
];
const RECENT = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const BETA = "33333333-3333-4333-8333-333333333333";
const EMPTY = "44444444-4444-4444-8444-444444444444";
transcript(RECENT, alpha, 2, [user("Fix the login bug"), ...tool("t1"), said("Fixed: the cookie lost its path."), user("<command-name>/clear</command-name>"), user("Now add a test for it"), said("Added test/login.ts; it passes.")]);
transcript(OLD, alpha, 20, [user("Old work, outside the range"), said("Done long ago.")]);
transcript(BETA, beta, 1, [user("Something in a folder left out"), said("Kept out.")]);
transcript(EMPTY, alpha, 0, [user("<local-command-stdout>nothing typed</local-command-stdout>")]);
fs.writeFileSync(path.join(CLAUDE, "projects", alpha.replace(/[/.]/g, "-"), "agent-abc.jsonl"), JSON.stringify({ type: "user", cwd: alpha, message: { content: "a subagent's" } }) + "\n");

const relay = await fakeRelay();
const ada = { sub: "google:1001", acct: "0193a000-0000-7000-8000-00000000ada1", email: "ada@example.com", name: "Ada Lovelace" };
relay.person = ada;
const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_ROOT: ROOT, AGENTBOOK_PORT: String(CLI), AGENTBOOK_SERVER_PORT: String(PORT), CLAUDE_CONFIG_DIR: CLAUDE, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_DSH: "0", AGENTBOOK_AGY: "0", AGENTBOOK_GROK: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_RELAY_URL: relay.url, AGENTBOOK_MACHINE: "freshbox", AGENTBOOK_RELOAD: "0" };
for (const k of ["AGENTBOOK_HOME", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "CLAUDE_JOB_DIR", "AGENTBOOK_TEST_PEOPLE"]) delete env[k];

const pids = new Set<number>();
const cliStatus = async () => (await (await fetch(`http://127.0.0.1:${CLI}/api/status`)).json()) as Json;
const jar = new Map<string, string>();
const get = async (url: string, init: RequestInit = {}) => {
  const r = await fetch(url, { redirect: "manual", ...init, headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (/Max-Age=0\b/.test(c)) jar.delete(pair.slice(0, eq));
    else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return r;
};
const json = async (url: string, init: RequestInit = {}) => {
  const r = await get(url, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
};

try {
  const daemon = spawnTied(process.execPath, [MAIN, "run", "--webui"], { env, stdio: "ignore", detached: true });
  pids.add(daemon.pid);
  await until(async () => (await fetch(PAGE + "/")).ok);
  const started = (await (await fetch(PAGE + "/api/first-run/start", { method: "POST", headers: { origin: PAGE } })).json()) as Json;
  relay.approve(started.code);
  const home = path.join(ROOT, "accounts", ada.acct);
  const handed = await until(async () => {
    const s = await cliStatus();
    return s.pid && s.pid !== daemon.pid && s.page === PAGE ? s : null;
  }, 60e3);
  if (handed?.pid) pids.add(handed.pid);
  check(handed, "the machine goes on the account from its first-run page");

  // ---------- nothing from before goes up until its person picks ----------
  const gate = JSON.parse(fs.readFileSync(path.join(home, "cli", "gate.json"), "utf8"));
  check(gate.history_pick === "pending" && Math.abs(Date.parse(gate.history_from) - Date.now()) < 120e3, "a machine new to agentbook keeps its past until its person picks (history_pick pending, history_from the login's time)");
  check(gate.codex_tools === false, "and leaves Codex's settings as they are until then");

  // ---------- one sign-in ----------
  const me = await until(async () => {
    const r = await fetch(PAGE + "/api/auth/me");
    return r.ok ? ((await r.json()) as Json) : null;
  }, 30e3);
  check(me?.account === true && me.user === null && me.first === true, "the account's page says nobody signed in to it yet (first), so it signs its person in straight on");
  const toRelay = (await get(`${PAGE}/api/auth/relay/start?${new URLSearchParams({ origin: PAGE })}`)).headers.get("location") || "";
  const back = (await get(toRelay)).headers.get("location") || "";
  await get(back);
  const her = (await json(PAGE + "/api/auth/me")).body;
  check(her.user?.id === ada.acct && !her.first, "and once they're in, it's no longer their first");
  check(await until(async () => (await cliStatus()).connected, 30e3), "the machine logs in to its page");

  // ---------- the welcome card's read ----------
  const read = await until(async () => {
    const r = await json(`${PAGE}/api/history?machine=freshbox`);
    return r.status === 200 && r.body.agents ? r.body : null;
  }, 30e3);
  check(read?.pending === true && read.machine === "freshbox", "the card asks: the machine's past is waiting for a pick");
  const claude = read?.agents?.findIndex((a: Json) => a.kind === "claude-code");
  check(claude >= 0 && read.agents[claude].keeps === 30 && read.agents[claude].name === "Claude Code", "Claude Code is among its agents, keeping 30 days of sessions");
  const day = (cwd: string, d: number) => read?.sessions?.some(([a, dd, f]: number[]) => a === claude && dd === d && read.folders[f] === cwd);
  check(read?.sessions?.length === 4 && day(alpha, 2) && day(alpha, 20) && day(beta, 1) && day(alpha, 0), `its past sessions, by day and folder (${JSON.stringify(read?.sessions)})`);
  check(!JSON.stringify(read).includes("subagent"), "a subagent's transcript isn't one of them");
  const machine = await until(async () => {
    const r = await json(`${PAGE}/api/machines/freshbox`);
    return r.body.history ? r.body : null;
  }, 15e3);
  check(machine?.history === "pending", "the machine's row says the card waits for it");

  // ---------- the pick ----------
  const picked = await json(`${PAGE}/api/history`, { method: "POST", headers: { "content-type": "application/json", origin: PAGE }, body: JSON.stringify({ machine: "freshbox", days: 7, out_agents: [], out_folders: [beta], codex_tools: false, claude_plugin: false }) });
  check(picked.status === 200, `the page picks the last 7 days, less a folder (${picked.status} ${JSON.stringify(picked.body)})`);
  const thread = await until(async () => {
    const r = await json(`${PAGE}/api/sessions/${RECENT}`);
    return r.status === 200 && r.body.state === "done" && (r.body.messages || []).length >= 4 ? r.body : null;
  }, 30e3);
  check(thread, "the session from 2 days ago comes in, ended");
  check(thread?.prompt === "Fix the login bug" && Math.abs(Date.parse(thread.ended) - (Date.now() - 2 * DAY)) < 15 * 60e3, `with its first prompt, and when it ended (${JSON.stringify({ prompt: thread?.prompt, ended: thread?.ended })})`);
  const words = (thread?.messages || []).map((m: Json) => `${m.from}:${m.text}`);
  check(JSON.stringify(words) === JSON.stringify(["human:Fix the login bug", "agent:Fixed: the cookie lost its path.", "human:Now add a test for it", "agent:Added test/login.ts; it passes."]), `its prompts and closing words as its messages, none Claude Code wrote itself (${JSON.stringify(words)})`);
  const done = await until(async () => {
    const r = await json(`${PAGE}/api/history?machine=freshbox`);
    return r.body.progress?.finished ? r.body : null;
  }, 30e3);
  check(done?.pending === false && done.pick?.out_folders?.[0] === beta, "the pick is kept, and the card stops asking");
  check(done?.progress?.total === 2 && done.progress.done === 1, `the progress counts what was picked (${JSON.stringify(done?.progress)}): the session with nothing typed in it brings nothing`);
  for (const [id, why] of [
    [OLD, "older than the range"],
    [BETA, "in the folder left out"],
    [EMPTY, "with nothing typed in it"],
  ]) check((await json(`${PAGE}/api/sessions/${id}`)).status === 404, `a session ${why} stays out`);
  const after = JSON.parse(fs.readFileSync(path.join(home, "cli", "gate.json"), "utf8"));
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 6);
  check(after.history_pick?.from === from.toISOString() && after.history_from === from.toISOString(), "gate.json keeps the pick, its range starting at midnight 6 days back, here");
  check((await until(async () => ((await json(`${PAGE}/api/machines/freshbox`)).body.history === "imported" ? true : null), 15e3)) === true, "and the machine's row says it came in, for the card's last word");
  const twice = await json(`${PAGE}/api/history`, { method: "POST", headers: { "content-type": "application/json", origin: PAGE }, body: JSON.stringify({ machine: "freshbox", days: 1.5 }) });
  check(twice.status === 400, "a range that isn't whole days is refused");
} finally {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await sleep(500);
  await relay.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
