#!/usr/bin/env node
// A thread whose session Claude Code won't wake or resume because it doesn't trust the session's folder: what you sent
// says so, with Trust and retry, which trusts the folder as Claude Code's trust prompt there would and sends it again.
// Writing to an ended one fails the same way, and its thread offers the same.
// Run: node test/untrusted-wake.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-untrusted-wake-"));
const PORT = testPort(5100);
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
  AGENTBOOK_SLEEP_AFTER_MIN: "0",
  AGENTBOOK_MAX_AWAKE: "0",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
// The fake Claude Code doesn't trust a folder named "untrusted…" until its .claude.json does.
const idle = path.join(HOME, "dev", "untrusted-app");
const ended = path.join(HOME, "dev", "untrusted-lib");
fs.mkdirSync(idle, { recursive: true });
fs.mkdirSync(ended, { recursive: true });
fs.mkdirSync(path.join(HOME, "claude"), { recursive: true });

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
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const hook = (event, input, pid, cwd) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
const trustedIn = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "claude", ".claude.json"), "utf8")).projects[fs.realpathSync(dir)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
};
const resumes = (id, mark) => calls().slice(mark).filter((c) => c.args.includes("--resume") && c.args[c.args.indexOf("--resume") + 1] === id);
const thread = (id) => get(`/api/sessions/${id}`);

// A background session, idle between turns, the way `claude agents` lists it; and one that ran in a terminal and ended.
const IDLE = "bg-idle";
const ENDED = "term-ended";
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: IDLE, sessionId: IDLE, kind: "background", state: "working", status: "idle", cwd: idle, pid: 5000, name: IDLE }]));
fs.mkdirSync(path.join(HOME, "claude", "jobs", IDLE), { recursive: true });
fs.writeFileSync(path.join(HOME, "claude", "jobs", IDLE, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: IDLE, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));
const transcript = path.join(HOME, `${ENDED}.jsonl`);
fs.writeFileSync(transcript, "");

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

  hook("SessionStart", { session_id: IDLE, source: "startup" }, 7000, idle);
  hook("UserPromptSubmit", { prompt: "Fix the build" }, 7000, idle);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Fixed. Commit it?" }, 7000, idle);
  check(!!(await until(async () => (await thread(IDLE)).rt?.kind === "background" && !(await thread(IDLE)).busy, 6000)), "a background session in a folder Claude Code doesn't trust, idle between turns");

  // ---------- a message that can't wake it ----------
  let mark = calls().length;
  check((await post(`/api/sessions/${IDLE}/messages`, { text: "Commit it" })).status < 300, "you write to it");
  const failed = await until(async () => (await thread(IDLE)).messages?.find((m) => m.text === "Commit it" && m.failed), 10000);
  check(/Workspace not trusted\. Run `claude` in /.test(failed?.failed.error || "") && resumes(IDLE, mark).length === 1, "Claude Code won't wake it there, and your message says it wasn't delivered, and why");
  const done = (await thread(IDLE)).messages.find((m) => m.from !== "human");
  check((await post(`/api/sessions/${IDLE}/messages/${encodeURIComponent(done.id)}/trust`)).status === 409, "Trust and retry is only for a message that failed for want of trust");
  check(!trustedIn(idle), "and agentbook doesn't trust the folder by itself");

  mark = calls().length;
  const trusted = await post(`/api/sessions/${IDLE}/messages/${encodeURIComponent(failed?.id)}/trust`);
  check(trusted.status === 200 && trustedIn(idle), "Trust and retry trusts its folder, as Claude Code's trust prompt would");
  const woke = await until(() => resumes(IDLE, mark)[0], 8000);
  check(woke?.args[0] === "Commit it" && fs.realpathSync(woke.cwd) === fs.realpathSync(idle), "and wakes it with what you sent, in its folder");
  check(await until(async () => !(await thread(IDLE)).messages.find((m) => m.id === failed?.id)?.failed, 4000), "so your message no longer says it wasn't delivered");
  await sleep(800);
  check(resumes(IDLE, mark).length === 1, "and it's sent once");
  const wakes = (await stateOf(get)).launches.filter((x) => x.resume && x.post === IDLE);
  check(wakes.length === 2 && wakes[0].error && wakes[0].archived && !wakes[1].error, "the wake that failed is put away, so its thread no longer says it");
  check((await post(`/api/sessions/${IDLE}/messages/${encodeURIComponent(failed?.id)}/trust`)).status === 409, "and only once");

  // ---------- writing to an ended one ----------
  const term = { session_id: ENDED, transcript_path: transcript };
  hook("SessionStart", { ...term, source: "startup" }, 7001, ended);
  hook("UserPromptSubmit", { ...term, prompt: "Bump the version" }, 7001, ended);
  hook("Stop", { ...term, stop_hook_active: false, last_assistant_message: "Bumped." }, 7001, ended);
  hook("SessionEnd", { ...term, reason: "prompt_input_exit" }, 7001, ended);
  const POST = ENDED;
  check(!!(await until(async () => (await thread(POST)).effective === "done", 6000)), "an ended thread in another folder it doesn't trust");
  mark = calls().length;
  const wrote = await post(`/api/sessions/${encodeURIComponent(POST)}/messages`, { text: "Tag the release" });
  const l = (await stateOf(get)).launches?.find((x) => x.resume && x.post === POST && x.error);
  check(wrote.status >= 400 && /Workspace not trusted/.test(l?.error || ""), "writing to it can't resume it there, and its thread says why");
  const again = await post(`/api/launches/${encodeURIComponent(l?.id)}/trust`);
  check(again.status === 200 && trustedIn(ended), "Trust and retry on it trusts its folder");
  const resumed = await until(() => resumes(ENDED, mark).find((c) => c.args[0] === "Tag the release" && fs.existsSync(c.cwd) && fs.realpathSync(c.cwd) === fs.realpathSync(ended)), 6000);
  check(!!resumed && resumes(ENDED, mark).length === 2, "and resumes it with what you wrote");
  check(await until(async () => (await thread(encodeURIComponent(POST))).messages?.some((m) => m.text === "Tag the release" && !m.failed), 4000), "which shows on its thread");
  check((await post(`/api/launches/${encodeURIComponent(l?.id)}/trust`)).status === 409, "and it's done once");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
