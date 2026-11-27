#!/usr/bin/env node
// A thread's card offers to delete its worktree once its WIP has nothing left: every commit on main, nothing
// uncommitted (the page reads that from its folder's WIP rows). The button is WIP's Clean up, which its machine
// checks again: it removes the worktree, deletes the branch and says the thread landed; it refuses a branch with a
// commit that isn't on main, a change not committed, or a thread still working there. Archiving a thread does the
// same by itself when nothing's left (archiveClean), and leaves the rest. Run: node test/wip-clean.ts

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-wip-clean-")));
const PORT = testPort(4800);
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

// A repo on main, and a worktree for each branch a thread works on.
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const project = path.join(HOME, "dev", "store");
fs.mkdirSync(project, { recursive: true });
git(project, "init", "-q", "-b", "main");
git(project, "commit", "-q", "--allow-empty", "-m", "init");
const wt = (name) => path.join(project, ".claude", "worktrees", name);
for (const b of ["ledger-batch", "erp-sync", "cart-css", "core-api", "auth-check"]) git(project, "worktree", "add", "-q", "-b", `worktree-${b}`, wt(b));
// ledger-batch landed on main; erp-sync has a commit that didn't; cart-css has a file not committed.
fs.writeFileSync(path.join(wt("ledger-batch"), "ledger.js"), "batch\n");
git(wt("ledger-batch"), "add", ".");
git(wt("ledger-batch"), "commit", "-qm", "Batch the ledger");
git(project, "merge", "-q", "--ff-only", "worktree-ledger-batch");
fs.writeFileSync(path.join(wt("erp-sync"), "erp.js"), "sync\n");
git(wt("erp-sync"), "add", ".");
git(wt("erp-sync"), "commit", "-qm", "Sync the ERP");
fs.writeFileSync(path.join(wt("cart-css"), "cart.css"), ".cart {}\n");
// auth-check: a thread looked and changed nothing, so its branch never had a commit of its own.

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
const sessionOf = {};
const hook = (event, input, pid) => {
  if (input.session_id) sessionOf[pid] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[pid], ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
};
// A thread that ran in a folder, in a terminal, and ended.
const ran = (id, cwd, pid) => {
  hook("SessionStart", { session_id: id, cwd, source: "startup" }, pid);
  hook("UserPromptSubmit", { prompt: `Work on ${id}`, cwd }, pid);
  hook("SessionEnd", { reason: "other", cwd }, pid);
};
const branches = () => git(project, "branch", "--format=%(refname:short)").split("\n");
const wipRows = async () => (await stateOf(get)).folders?.find((f) => f.root === project)?.wip || [];
const row = async (b) => (await wipRows()).find((w) => w.branch === `worktree-${b}`);

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

  ran("t-ledger", wt("ledger-batch"), 8001);
  ran("t-erp", wt("erp-sync"), 8002);
  ran("t-cart", wt("cart-css"), 8003);
  // core-api: one thread ended, another still working there (its process is this one, so it's alive).
  ran("t-api", wt("core-api"), 8005);
  hook("SessionStart", { session_id: "t-api-2", cwd: wt("core-api"), source: "startup" }, process.pid);
  hook("UserPromptSubmit", { prompt: "Work on core-api", cwd: wt("core-api") }, process.pid);
  const ready = await until(async () => {
    const ss = (await stateOf(get)).sessions;
    return ss.filter((s) => s.id.startsWith("t-") && s.effective === "done").length === 4 && ss.find((s) => s.id === "t-api-2")?.branch === "worktree-core-api";
  });
  check(ready, "four threads ran and ended, one is still working");

  // ---------- what the card reads ----------
  const ledger = await until(() => row("ledger-batch"));
  check(ledger && !ledger.ahead && !ledger.dirty && ledger.worked && !ledger.here && ledger.worktree === wt("ledger-batch") && ledger.base === "main" && ledger.posts.includes("t-ledger"), "a landed branch's WIP row has nothing left, with its worktree and its thread");
  const erp = await row("erp-sync");
  check(erp?.ahead === 1 && !erp.dirty, "one with a commit not on main says so");
  const cart = await until(async () => (await row("cart-css"))?.dirty === 1);
  check(cart, "one with a change not committed says so");
  const api = await row("core-api");
  check(api && !api.ahead && !api.dirty && api.posts.includes("t-api-2"), "a row lists the thread still working there");

  // ---------- the button: WIP's Clean up, checked again on the machine ----------
  const clean = (b) => post("/api/wip/clean", { root: project, branch: `worktree-${b}` });
  const ahead = await clean("erp-sync");
  check(ahead.status === 409 && /isn't on main yet/.test(ahead.error || "") && fs.existsSync(wt("erp-sync")) && branches().includes("worktree-erp-sync"), "it won't delete a branch with a commit that isn't on main");
  const dirty = await clean("cart-css");
  check(dirty.status === 409 && /isn't committed/.test(dirty.error || "") && fs.existsSync(path.join(wt("cart-css"), "cart.css")), "nor a worktree with a change not committed");
  const busy = await clean("core-api");
  check(busy.status === 409 && /is working on worktree-core-api/.test(busy.error || "") && fs.existsSync(wt("core-api")), "nor one a thread is still working in");
  const done = await clean("ledger-batch");
  check(done.status === 200 && done.removed === wt("ledger-batch") && !fs.existsSync(wt("ledger-batch")) && !branches().includes("worktree-ledger-batch"), "a landed one: its worktree removed and its branch deleted");
  check(git(project, "log", "-1", "--format=%s", "main") === "Batch the ledger", "main keeps its commit");
  const landed = await until(async () => (await stateOf(get)).sessions.find((s) => s.id === "t-ledger")?.landed === "worktree-ledger-batch");
  check(landed, "and its thread says it landed");
  check(await until(async () => !(await row("ledger-batch"))), "it leaves the WIP rows");

  // ---------- archiving does it by itself, when nothing's left ----------
  ran("t-auth", wt("auth-check"), 8006);
  check(await until(async () => (await row("auth-check"))?.posts.includes("t-auth") && (await stateOf(get)).sessions.find((s) => s.id === "t-auth")?.effective === "done"), "a thread that changed nothing ran on its own branch");
  const archive = (id) => post(`/api/sessions/${id}/flag`, { archived: true });
  const auth = await archive("t-auth");
  check(auth.status === 200 && auth.cleans === "worktree-auth-check" && !auth.clean, "archiving it says its worktree goes too");
  check(await until(() => !fs.existsSync(wt("auth-check")) && !branches().includes("worktree-auth-check")), "its worktree removed and its branch deleted");
  check(await until(async () => (await stateOf(get)).sessions.find((s) => s.id === "t-auth")?.landed === "worktree-auth-check"), "and it says it landed");
  for (const [id, b, why] of [["t-erp", "erp-sync", "a commit that isn't on main"], ["t-cart", "cart-css", "a change not committed"], ["t-api", "core-api", "another thread still working there"]]) {
    const r = await archive(id);
    await sleep(500);
    check(r.status === 200 && !r.cleans && !r.clean && fs.existsSync(wt(b)) && branches().includes(`worktree-${b}`), `archiving one with ${why} keeps its worktree`);
  }
  check(fs.existsSync(path.join(wt("cart-css"), "cart.css")), "with its change");
  // core-api's other thread ends and is archived: nothing's going there now, and it goes.
  hook("SessionEnd", { reason: "other", cwd: wt("core-api") }, process.pid);
  check(await until(async () => (await stateOf(get)).sessions.find((s) => s.id === "t-api-2")?.effective === "done"), "core-api's other thread ended");
  const api2 = await archive("t-api-2");
  check(api2.status === 200 && api2.cleans === "worktree-core-api", "archiving the last one there deletes it");
  check(await until(() => !fs.existsSync(wt("core-api")) && !branches().includes("worktree-core-api")), "core-api's worktree and branch are gone");
  // Brought back, it's as it was: archiving again finds nothing to delete.
  await post("/api/sessions/t-auth/flag", { archived: false });
  const again = await archive("t-auth");
  check(again.status === 200 && !again.cleans && !again.clean, "archiving one whose branch is gone already deletes nothing");
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
