#!/usr/bin/env node
// Side threads on a Codex thread: sending on the side forks the thread through Codex's
// app-server (thread/fork) into a side thread of its own, named after what you sent, whose first turn is what you
// sent, while the thread works on, untouched. Against test/fake-codex.ts.
// Run: node test/side-threads-codex.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownTurns } from "../plugin/cli/runtimes/codex/items.ts";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-side-codex-"));
const PORT = testPort(4660);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const SOCK = path.join(HOME, "codex.sock");
const LOG = path.join(HOME, "codex.jsonl");
const project = path.join(HOME, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_SNAPSHOT_MS: "300",
  AGENTBOOK_CODEX_SOCK: SOCK,
  AGENTBOOK_CODEX_SYNC_MS: "1000",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  FAKE_CODEX_CLI_LOG: path.join(HOME, "codex-cli.jsonl"),
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

// ---------- a side thread's own turns: the fork's copies of the thread's are left out ----------
{
  const at = "2026-11-13T15:00:00.000Z";
  const t0 = Date.parse(at) / 1000;
  const turns = [{ id: "tu-1", startedAt: t0 - 3600 }, { id: "tu-2", startedAt: t0 - 5 }, { id: "tu-9", startedAt: t0 + 2 }];
  check(ownTurns(turns, at).map((t) => t.id).join() === "tu-9", "a side thread's turns are the ones that started once you sent it");
  check(ownTurns(turns, null).length === 3 && ownTurns(undefined, at).length === 0, "any other thread's are all its own");
  check(ownTurns([{ id: "tu-0", startedAt: Math.floor(t0) }], "2026-11-13T15:00:00.400Z").length === 1, "Codex's whole seconds don't drop the turn that started in the same second");
}

// ---------- the daemon and the server ----------
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => {
  const r = await call(p);
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const codexLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = (method, from = 0) => codexLog().slice(from).filter((e) => e.method === method);
const thread = (id) => get(`/api/sessions/${id}`);

const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), SOCK, LOG, project], { stdio: "ignore" });
await until(() => fs.existsSync(SOCK), 3000);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  check(!!(await until(async () => (await thread("th-live")).rt?.name === "Codex")), "a Codex thread, loaded in its daemon");

  // It's working on something when you send on the side.
  await post("/api/sessions/th-live/messages", { text: "slow: tidy the cart module" });
  check(!!(await until(async () => (await thread("th-live")).busy)), "the thread is working");
  check((await post("/api/sessions/th-live/messages", { text: "/review", side: true })).status === 400, "a slash command doesn't go on the side");

  const text = "Check whether the cart total skips the discount";
  const mark = codexLog().length;
  const sent = await post("/api/sessions/th-live/messages", { text, side: true });
  check(sent.status === 200 && !!sent.lid, "you send on the side, and get its launch");
  const fork = await until(() => calls("thread/fork", mark)[0]);
  check(fork?.params.threadId === "th-live" && fork.params.cwd === project, "Codex forks the thread, in its folder");
  check(!!fork?.params.config?.["mcp_servers.agentbook"], "the fork gets agentbook's tools, as itself");
  const SIDE = await until(async () => (await stateOf(get)).sessions.find((s) => s.id.startsWith("th-fork-"))?.id);
  check(!!SIDE, "the fork is a thread of its own");
  const named = await until(() => calls("thread/name/set", mark).find((e) => e.params.threadId === SIDE));
  check(named?.params.name === text, "named after what you sent, not the thread it came from");
  const turn = await until(() => calls("turn/start", mark).find((e) => e.params.threadId === SIDE));
  check(turn?.params.input?.[0]?.text === text, "its first turn is what you sent");
  check(!calls("turn/start", mark).some((e) => e.params.threadId === "th-live") && !calls("turn/steer", mark).some((e) => e.params.threadId === "th-live"), "the thread is told nothing");
  check(!calls("turn/interrupt", mark).length && (await thread("th-live")).busy, "and goes on working, not stopped for it");

  const st = await until(async () => {
    const x = await stateOf(get);
    return x.sessions.some((s) => s.id === SIDE && s.started_from === "th-live" && !s.busy) ? x : null;
  });
  check(!!st, "the side thread is started from the thread, and does its turn");
  const side = st?.sessions.find((s) => s.id === SIDE);
  check(!!side?.side_at && side.prompt === text, "its prompt is what you wrote");
  check(side?.title === text, "and its title too, not the thread's (\"Fix the login bug\")");
  const steps = await get(`/api/sessions/${SIDE}/steps`);
  check(!(steps.steps || []).some((x) => /npm test/.test(x.title || "")), "its steps are its own");

  const q = await get(`/api/q/thread/th-live`);
  const sideMsg = (q.messages || []).map((k) => q.records[k]).find((m) => m?.via === "side");
  check(sideMsg?.text === text && sideMsg.launch === sent.lid, "the thread shows what you sent on the side, with its launch");
  const row = (q.started || []).find((r) => r.id === SIDE);
  check(row?.launch === sent.lid && row.reply?.text === `Done: ${text}`, "and the side thread under it, with its reply");
  const mine = await thread(SIDE);
  check((mine.messages || []).filter((m) => m.from === "human").map((m) => m.text).join("|") === text, "on the side thread, what you sent is its first message, once");
} finally {
  server.kill();
  fakeCodex.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
