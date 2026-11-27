#!/usr/bin/env node
// A session woken into a new process whose hooks never registered it (its SessionStart hook ran out of time on a
// loaded machine) is registered by its first ab_* call, and that lands on its own thread: the MCP server has no hook
// input, so it looks the session id up where Claude Code keeps it (sessions/<pid>.json). Before, the process got a
// thread of its own, under another name, which nothing sent could reach. A file an
// earlier process with the same pid left behind isn't taken for the new one's.
// Run: node test/late-hello.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-late-hello-"));
const PORT = testPort(5200);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
const CLAUDE = path.join(HOME, "claude");
fs.mkdirSync(FAKE);
fs.mkdirSync(path.join(CLAUDE, "sessions"), { recursive: true });
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: CLAUDE,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_SLEEP_AFTER_MIN: "0",
  AGENTBOOK_MAX_AWAKE: "0",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
const HOST = os.hostname().split(".")[0];

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
const get = async (p: string) => {
  const r = await fetch(URL + p, { headers: { cookie: COOKIE } });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const state = () => stateOf(get);
const hook = (event: string, input: object, pid: number) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
// What agentbook-cli tells the session of Claude Code process `pid` about its thread, or null if it has none.
const contextOf = async (pid) => {
  const r = await fetch(`${URL}/api/procs/${HOST}-${pid}/context?background=1`);
  return r.ok ? r.text() : null;
};
// A Claude Code process: something alive under its pid, and the file Claude Code keeps for it, dated `at`.
const procs = [];
const claudeProcess = async (sessionId, at = null) => {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120e3)"], { stdio: "ignore" });
  procs.push(p);
  await sleep(1100); // ps gives a process's start to the second
  fs.writeFileSync(path.join(CLAUDE, "sessions", `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId, cwd: project, startedAt: at ?? Date.now(), kind: "bg", status: "busy" }));
  return p.pid;
};
// One tool call from the plugin's MCP server in that process, as Claude Code makes it. It's killed rather than
// closed after: a closed one says its session ended.
const toolCall = async (pid, name, args) => {
  const bridge = spawn(process.execPath, [path.join(ROOT, "mcp", "server.ts")], { env: { ...env, AGENTBOOK_PID: String(pid), CLAUDE_PROJECT_DIR: project }, stdio: ["pipe", "pipe", "ignore"] });
  const seen = [];
  readline.createInterface({ input: bridge.stdout }).on("line", (line) => {
    try {
      seen.push(JSON.parse(line));
    } catch {}
  });
  const send = (msg) => bridge.stdin.write(JSON.stringify(msg) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    await until(() => seen.find((m) => m.id === 1), 8000);
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    return await until(() => seen.find((m) => m.id === 2), 15000);
  } finally {
    bridge.kill("SIGKILL");
  }
};

const ID = "bb4e8d42-0000-4000-8000-000000000001";
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: ID, sessionId: ID, kind: "background", state: "working", status: "idle", cwd: project, pid: 7000, name: ID }]));
fs.mkdirSync(path.join(CLAUDE, "jobs", ID), { recursive: true });
fs.writeFileSync(path.join(CLAUDE, "jobs", ID, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: ID, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));

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

  // A background session with its thread, between turns.
  hook("SessionStart", { session_id: ID, source: "startup" }, 7000);
  hook("UserPromptSubmit", { session_id: ID, prompt: "Move Hive to EKS" }, 7000);
  hook("Stop", { session_id: ID, stop_hook_active: false, last_assistant_message: "The plans are ready." }, 7000);
  check(!!(await until(async () => (await state()).sessions.find((s) => s.id === ID && !s.busy), 6000)), "a background session has its thread");

  // Woken into a new process, whose hooks never got through: its first ab_* call registers it.
  const woken = await claudeProcess(ID);
  check(!(await contextOf(woken)), "the new process isn't registered");
  const r = await toolCall(woken, "ab_post", { title: "Route Hive through the tunnel" });
  check(r && !r.result?.isError, `its ab_post goes through (${JSON.stringify(r?.result?.content?.[0]?.text || r?.error || null).slice(0, 160)})`);
  const st = await until(async () => {
    const x = await state();
    return x.sessions.some((s) => s.title === "Route Hive through the tunnel") ? x : null;
  }, 6000);
  check(st?.sessions.find((s) => s.title === "Route Hive through the tunnel")?.id === ID, "it lands on the session's own thread");
  check(st && st.sessions.length === 1 && !st.sessions.some((s) => s.id === `${HOST}-${woken}`), "with no thread of the process's own");
  check((await contextOf(woken))?.includes(`#/threads/${ID}`), "and from then on the process is that thread's");

  // A file left by an earlier process under the same pid (older than the process now running) isn't believed.
  const reused = await claudeProcess(ID, Date.now() - 3600e3);
  await toolCall(reused, "ab_post", { title: "From a file an earlier process left" });
  const st2 = await until(async () => {
    const x = await state();
    return x.sessions.some((s) => s.title === "From a file an earlier process left") ? x : null;
  }, 6000);
  check(st2?.sessions.find((s) => s.id === ID)?.title === "Route Hive through the tunnel" && st2.sessions.find((s) => s.title === "From a file an earlier process left")?.id === `${HOST}-${reused}`, "a stale file from an earlier process with the pid isn't taken for this one's");
} finally {
  for (const p of procs) p.kill();
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
