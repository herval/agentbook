#!/usr/bin/env node
// What made threads and messages show twice. A start agentbook-cli stopped during (`agentbook up` restarted it while
// `claude --bg` ran) comes again from the server: the session Claude Code started for it is its thread, not a second
// one. A background session Claude Code starts in a worker it made earlier has that worker's variables, from the
// launch that started its daemon: it doesn't take that launch's thread's name. And a resume whose prompt never came
// back (Claude Code restarted the session itself, with a prompt of its own) doesn't make every message after it show
// twice.
// Run: node test/started-twice.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { createStore } from "../plugin/shared/store.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-twice-"));
const PORT = testPort(5000);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
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
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(HOME, "cli"));
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = (prompt) => calls().filter((c) => c.args.includes("--bg") && !c.args.includes("--resume") && c.args[0] === prompt);
const hook = (event, input, pid, more = {}) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid), ...more }, encoding: "utf8", timeout: 15000 });

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

  // ---------- agentbook-cli restarts while `claude --bg` starts a thread ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-a");
  fs.writeFileSync(path.join(FAKE, "slow.txt"), "3000");
  const launching = post("/api/launch", { prompt: "Fix the flaky test", root: project, agent: "claude" });
  check(!!(await until(() => starts("Fix the flaky test").length)), "Claude Code is starting it");
  await server.restart("agentbook-cli");
  const launched = await launching;
  // As one process (AGENTBOOK_HARNESS_ONE, agentbook webui), the restart takes the page with it, and the request it
  // was answering: the launch is found by its prompt.
  const one = process.env.AGENTBOOK_HARNESS_ONE === "1";
  if (one && !launched.lid) launched.lid = (await until(async () => (await state()).launches?.find((l) => l.prompt === "Fix the flaky test")))?.id;
  const lA = await until(async () => (await state()).launches?.find((l) => l.id === launched.lid && l.session));
  check((launched.status === 200 || (one && launched.lid)) && starts("Fix the flaky test").length === 1, "agentbook-cli restarted meanwhile, and the start the server sent again doesn't start a second session");
  check(lA?.session?.startsWith("sess-a"), "it's paired with the session Claude Code started the first time");
  hook("SessionStart", { session_id: "sess-a", source: "startup" }, 920001, { AGENTBOOK_LAUNCH_ID: launched.lid, AGENTBOOK_LABEL: "lark" });
  let s = await state();
  check(s.launches.find((l) => l.id === launched.lid)?.post === "sess-a" && s.sessions.filter((x) => x.id === "sess-a" || x.prompt === "Fix the flaky test").length === 1, "and that session takes over its placeholder: one thread");

  // ---------- a worker's leftover variables ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-b");
  const second = await post("/api/launch", { prompt: "Explain pause", root: project, agent: "claude" });
  hook("SessionStart", { session_id: "sess-b", source: "startup" }, 920002, { AGENTBOOK_LAUNCH_ID: launched.lid, AGENTBOOK_LABEL: "lark" });
  s = await state();
  const b = s.sessions.find((x) => x.id === "sess-b");
  check(s.launches.find((l) => l.id === second.lid)?.post === "sess-b" && b?.launch === second.lid, "a session with an earlier launch's variables takes over its own placeholder");
  check(b && b.label !== "lark" && s.sessions.find((x) => x.id === "sess-a")?.label === "lark", "and gets a name of its own, not the name that launch's thread has");

} finally {
  server.kill("SIGTERM");
  await sleep(300);
}

// ---------- a resume whose prompt never comes back ----------
// The thread's store, as agentbook-cli keeps it: what the hooks and the resumes commit.
const store = createStore({ file: path.join(HOME, "store", "agentbook.db"), filesDir: path.join(HOME, "store", "files"), legacy: false });
const hello = (pid: number, launch?: string) => store.ingest({ t: "session.hello", proc: `box-${pid}`, session_id: "sess-c", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "wren", named: true, cwd: project, launch });
const resumeWith = (lid: string, text: string) => {
  store.ingest({ t: "launch.add", lid, agent: "claude", root: project, prompt: text, post: "sess-c", resume: true });
  store.ingest({ t: "message.add", post: "sess-c", from: "human", via: "dash", text, resume: lid });
};
const typed = (text: string) => store.ingest({ t: "message.add", post: "sess-c", from: "human", via: "terminal", text });
hello(1);
typed("Explain pause");
store.ingest({ t: "session.gone", post: "sess-c" });
resumeWith("l-first", "And stop?");
// Claude Code restarts it itself, with a prompt of its own, which no hook sees: agentbook's never comes back.
hello(2, "l-first");
store.ingest({ t: "session.gone", post: "sess-c" });
resumeWith("l-again", "ok");
hello(3, "l-first");
typed("ok");
const human = store.state.messages.filter((m) => m.post === "sess-c" && m.from === "human");
check(human.filter((m) => m.text === "ok").length === 1 && human.filter((m) => m.text === "And stop?").length === 1, "a resume whose prompt never came back doesn't make the next one show twice, as typed in a terminal");
typed("and the docs");
check(store.state.messages.filter((m) => m.post === "sess-c" && m.text === "and the docs" && m.via === "terminal").length === 1, "and what's typed in its terminal after that shows, as typed there");
store.close();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
