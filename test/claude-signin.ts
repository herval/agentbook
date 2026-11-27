#!/usr/bin/env node
// Claude Code signed in again from a thread's Login expired card (cli/claude-signin.ts): Sign in has its machine
// run `claude auth login`, the card gets its link, and the code claude.ai shows after you sign in comes back to it.
// Once it's taken, every background thread the expired login cut off is picked up. A code it doesn't take uses that
// link up; the code is never written anywhere by agentbook.
// Run: node test/claude-signin.ts

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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-signin-"));
const PORT = testPort(5060);
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
  AGENTBOOK_SIGNIN_LINK_MS: "1500",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR", "BROWSER"]) delete env[k];
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
const call = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown) => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const session = async (id: string) => (await stateOf(get)).sessions.find((s) => s.id === id);
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const logins = () => calls().filter((c) => c.args[0] === "auth" && c.args[1] === "login");
const resumes = (id: string, from = 0) => calls().slice(from).filter((c) => c.args.includes("--resume") && c.args.includes(id));
const sessionOf: Record<string, string> = {};
const hook = (event: string, input: { session_id?: string; [field: string]: unknown }, pid: number) => {
  if (input.session_id) sessionOf[pid] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, session_id: sessionOf[pid], ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
};
const EXPIRED = "Login expired · Please run /login";
const signin = (id, body) => post(`/api/sessions/${id}/claude-login`, body);
// Every file under a folder, as text, for what agentbook may have written.
const filesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  });

// Two sessions in the background and one in a terminal, as `claude agents` lists them.
const ids = { "bg-a": "background", "bg-b": "background", "term-c": "interactive" };
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(Object.entries(ids).map(([id, kind], i) => ({ id, sessionId: id, kind, state: "working", status: "idle", cwd: project, pid: 6000 + i, name: id }))));
for (const id of Object.keys(ids)) {
  fs.mkdirSync(path.join(HOME, "claude", "jobs", id), { recursive: true });
  fs.writeFileSync(path.join(HOME, "claude", "jobs", id, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: id, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));
}

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

  Object.keys(ids).forEach((id, i) => {
    hook("SessionStart", { session_id: id, source: "startup" }, 8000 + i);
    hook("UserPromptSubmit", { prompt: `Work on ${id}` }, 8000 + i);
  });
  check((await until(async () => (await stateOf(get)).sessions.filter((s) => s.rt).length === 3, 6000)) === true, "three sessions run, two in the background and one in a terminal");
  Object.keys(ids).forEach((id, i) => hook("StopFailure", { error: "authentication_failed", last_assistant_message: EXPIRED }, 8000 + i));
  const cut = await until(async () => {
    const s = await session("bg-a");
    return s?.pickup === "login" && s;
  });
  check(cut?.effective === "needs" && cut.failed?.error === "authentication_failed", "an expired login cuts them off, and they need you");

  // ---------- Sign in: its machine starts signing in, and the card gets the link ----------
  const started = await signin("bg-a", { step: "start" });
  check(started.status === 200 && /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/.test(started.url || "") && !/[\x00-\x1f]/.test(started.url) && started.machine, "Sign in answers with the link to claude.ai, without the terminal's escapes around it");
  check(logins().length === 1 && fs.readFileSync(path.join(FAKE, "login-browser.txt"), "utf8") === "true", "its machine ran `claude auth login`, with no browser opening there");
  const again = await signin("bg-b", { step: "start" });
  check(again.status === 200 && again.url === started.url && logins().length === 1, "Sign in on another thread it cut off, meanwhile, gets the same link");

  // ---------- a code it doesn't take uses the link up ----------
  const spaced = await signin("bg-a", { step: "code", code: "two words" });
  check(spaced.status === 400 && /as it is/.test(spaced.error || "") && !spaced.ended, "something that can't be a code isn't sent to it, and the link still works");
  const empty = await signin("bg-a", { step: "code", code: "  " });
  check(empty.status === 400 && /Paste the code/.test(empty.error || ""), "nor is nothing");
  let mark = calls().length;
  const wrong = await signin("bg-a", { step: "code", code: "wrong#state" });
  check(wrong.status === 400 && /^Claude Code didn't take it: That code wasn't accepted/.test(wrong.error || "") && wrong.ended === true, "a code it doesn't take says so in Claude Code's words, and that the link is used up");
  check(fs.readFileSync(path.join(FAKE, "login-got.txt"), "utf8") === "wrong#state", "the code went to it as pasted");
  const late = await signin("bg-a", { step: "code", code: "another#state" });
  check(late.status === 409 && /Press Sign in again/.test(late.error || "") && late.ended === true, "another code after that is told to start over");
  await sleep(1500);
  check(resumes("bg-a", mark).length === 0 && resumes("bg-b", mark).length === 0, "no thread is picked up while it isn't signed in");

  // ---------- a Claude Code that never gives a link ----------
  fs.writeFileSync(path.join(FAKE, "login-silent"), "");
  const silent = await signin("bg-a", { step: "start" });
  check(silent.status === 504 && /didn't give a link/.test(silent.error || ""), "a Claude Code that never gives a link is given up on, saying so");
  fs.rmSync(path.join(FAKE, "login-silent"));

  // ---------- the right code: signed in, and what the login cut off is picked up ----------
  const GOOD = `good-${Date.now()}#state-${process.pid}`;
  fs.writeFileSync(path.join(FAKE, "login-code.txt"), GOOD);
  const fresh = await signin("bg-b", { step: "start" });
  check(fresh.status === 200 && !!fresh.url && fresh.url !== started.url && logins().length === 3, "Sign in again starts over with a new link");
  mark = calls().length;
  const done = await signin("bg-b", { step: "code", code: `  ${GOOD}\n` });
  check(done.status === 200 && done.signed_in === true, "the code claude.ai showed signs Claude Code in");
  const both = await until(() => resumes("bg-a", mark).length && resumes("bg-b", mark).length, 8000);
  check(!!both && /You're signed in again, so carry on where you left off/.test(resumes("bg-a", mark)[0]?.args[0] || ""), "every background thread the expired login cut off is picked up, told it's signed in again");
  check(resumes("term-c", mark).length === 0, "not the one in a terminal: that one waits for you to write to it there");
  const after = await signin("bg-a", { step: "code", code: GOOD });
  check(after.status === 409 && after.ended === true, "the link is spent once it's signed in");

  // ---------- who may, and what's kept ----------
  const nobody = await fetch(`${URL}/api/sessions/bg-a/claude-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "start" }) });
  check(nobody.status === 401, "someone not signed in to agentbook can't");
  const kept = filesUnder(HOME).filter((f) => !f.startsWith(FAKE + path.sep) && !f.startsWith(path.join(HOME, "claude") + path.sep) && fs.readFileSync(f).includes(GOOD));
  check(kept.length === 0, `the code isn't written anywhere by agentbook: not in the server's database, the machine's, or a log${kept.length ? ` (${kept.map((f) => path.relative(HOME, f)).join(", ")})` : ""}`);
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
