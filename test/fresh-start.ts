#!/usr/bin/env node
// A session in a terminal gets its thread at its first prompt, not as Claude Code starts: `claude`, then quitting,
// leaves nothing on agentbook, and neither does an idle notification before anything was typed. Its first prompt
// makes the thread and hands Claude what SessionStart would have said. /clear closes the conversation it moved
// on from, and the cleared one waits for its own first prompt. A background session, and a resumed one, have
// their thread at once. A Codex thread opened elsewhere (the Codex app) is the same: no post until its first turn.
// Run: node test/fresh-start.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { connectWs } from "../plugin/cli/runtimes/kit/ws.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-fresh-"));
const PORT = testPort(6300);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const CODEX_SOCK = path.join(HOME, "codex.sock");
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX_SOCK: CODEX_SOCK,
  AGENTBOOK_CODEX_SYNC_MS: "1000",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const get = async (p: string): Promise<Json> => (await fetch(URL + p, { headers: { cookie: COOKIE } })).json();
const state = () => stateOf(get);
const thread = async (id: string) => (await state()).sessions.find((s) => s.id === id) || null;
const hook = (event, input, pid, more = {}) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid), ...more }, encoding: "utf8", timeout: 15000 });
// Whether agentbook-cli has the session of Claude Code process `pid` registered, whether or not the page shows it yet.
const registered = async (pid) => (await fetch(`${URL}/api/procs/${os.hostname().split(".")[0]}-${pid}/context`)).status !== 404;

const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), CODEX_SOCK, "", project], { stdio: "ignore" });
await until(() => fs.existsSync(CODEX_SOCK), 3000);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- a machine with no threads yet ----------
  // Claude Code and Codex are agents as soon as agentbook finds them, so there's one to start the first thread with.
  const found = await until(async () => {
    const st = await state();
    const claude = st.agents.find((a) => a.kind === "claude-code");
    return claude && st.agents.some((a) => a.kind === "codex") ? { claude } : null;
  }, 8000);
  check(found?.claude.id === "claude" && !found.claude.sessions && found.claude.mine !== false, "a machine with no threads yet has Claude and Codex as agents, to start the first one with");
  // Each says the version of its runtime here, for its page: `claude --version`'s, and the one Codex's daemon answers with.
  const versions = await until(async () => {
    const st = await state();
    const v = (k) => st.agents.find((a) => a.kind === k)?.version;
    return v("claude-code") && v("codex") ? { claude: v("claude-code"), codex: v("codex") } : null;
  }, 8000);
  check(versions?.claude === "2.1.316" && versions?.codex === "0.160.0", `Claude and Codex say their versions (${JSON.stringify(versions)})`);

  // ---------- `claude`, then quit ----------
  const started = hook("SessionStart", { session_id: "t-quit", source: "startup" }, 930001);
  check(started.status === 0 && !started.stdout.trim(), "a session that just started in a terminal tells Claude nothing yet");
  hook("Notification", { session_id: "t-quit", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, 930001);
  await sleep(500);
  check(!(await thread("t-quit")) && !(await registered(930001)), "and has no thread, even after an idle notification");
  hook("SessionEnd", { session_id: "t-quit", reason: "prompt_input_exit" }, 930001);
  await sleep(300);
  check(!(await thread("t-quit")), "quitting it leaves nothing behind");

  // ---------- its first prompt ----------
  hook("SessionStart", { session_id: "t-work", source: "startup" }, 930002);
  const first = hook("UserPromptSubmit", { session_id: "t-work", prompt: "Fix the login bug" }, 930002);
  const work = await until(() => thread("t-work"));
  check(work?.state !== "done" && work?.prompt === "Fix the login bug", "its first prompt makes its thread");
  check(first.stdout.includes("this conversation is a thread on") && first.stdout.includes(`You appear there as "${work?.label}"`), "and hands Claude what SessionStart would have said of it");
  const second = hook("UserPromptSubmit", { session_id: "t-work", prompt: "and the tests" }, 930002);
  check(!second.stdout.includes("this conversation is a thread on"), "once: the next prompt doesn't say it again");

  // ---------- /clear ----------
  hook("Stop", { session_id: "t-work", last_assistant_message: "Fixed." }, 930002);
  hook("SessionEnd", { session_id: "t-work", reason: "clear" }, 930002);
  hook("SessionStart", { session_id: "t-cleared", source: "clear" }, 930002);
  const cleared = await until(async () => ((await thread("t-work"))?.state === "done" ? thread("t-work") : null));
  check(cleared?.end_reason === "Cleared", "/clear closes the conversation it moved on from");
  check(!(await thread("t-cleared")), "and the cleared one has no thread until its first prompt");
  hook("UserPromptSubmit", { session_id: "t-cleared", prompt: "Now the signup page" }, 930002);
  check((await until(() => thread("t-cleared")))?.prompt === "Now the signup page", "which makes it");
  check((await thread("t-work"))?.state === "done", "leaving the one before it closed");

  // ---------- background and resumed sessions ----------
  const JOB = path.join(HOME, "claude", "jobs", "t-bg");
  fs.mkdirSync(JOB, { recursive: true });
  hook("SessionStart", { session_id: "t-bg", source: "startup" }, 930003, { CLAUDE_JOB_DIR: JOB });
  check(!!(await until(() => thread("t-bg"))), "a background session has its thread at once");
  hook("SessionEnd", { session_id: "t-cleared", reason: "prompt_input_exit" }, 930002);
  await until(async () => (await thread("t-cleared"))?.state === "done");
  const resumed = hook("SessionStart", { session_id: "t-cleared", source: "resume" }, 930004);
  check((await until(async () => ((await thread("t-cleared"))?.state !== "done" ? thread("t-cleared") : null)))?.state === "idle" && resumed.stdout.includes("this conversation is a thread on"), "and a resumed one is back on its thread as it starts");

  // ---------- a Codex thread opened elsewhere ----------
  // Another window on Codex's daemon (the Codex app) opens a new thread, and sends nothing in it yet.
  check(!!(await until(() => thread("th-live"), 10000)), "agentbook follows Codex's daemon");
  // What Codex's daemon answers, as far as the test reads it.
  type CodexResult = { thread?: { id: string } } | null;
  const answers = new Map<number, (r: CodexResult) => void>();
  let asked = 0;
  const app = await connectWs(CODEX_SOCK, { onMessage: (text) => { const m: { id?: number; method?: string; result?: CodexResult } = JSON.parse(text); if (m.id !== undefined && !m.method) answers.get(m.id)?.(m.result ?? null); } });
  const rpc = (method: string, params: object) => new Promise<CodexResult>((resolve) => { const id = ++asked; answers.set(id, resolve); app.send(JSON.stringify({ id, method, params })); });
  await rpc("initialize", { clientInfo: { name: "codex-app", version: "0" } });
  const opened = (await rpc("thread/start", { cwd: project }))?.thread;
  await sleep(2500); // Codex said it started, and agentbook's syncs listed it and followed it since
  check(opened?.id && !(await thread(opened.id)), "a Codex thread opened with nothing sent in it has no post");
  await rpc("turn/start", { threadId: opened?.id, input: [{ type: "text", text: "Tidy the README" }] });
  const cx = await until(async () => ((await thread(opened?.id))?.prompt ? thread(opened.id) : null));
  check(cx?.agent === "codex" && cx.prompt === "Tidy the README", "its first turn makes it, with what was sent in it");
  app.close();
} finally {
  server.kill("SIGTERM");
  fakeCodex.kill();
  await sleep(300);
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
