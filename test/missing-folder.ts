#!/usr/bin/env node
// A thread whose folder is gone (another tool cleaned up its worktree) can't be resumed: Claude Code finds a
// conversation by the folder it started in. Its machine says so, and what can put the folder back: its branch checked
// out there again, a copy of it when another folder has the branch, its repo's default branch when the branch is
// gone, or an empty folder. Put back, the thread resumes, and its agent hears what happened.
// Run: node test/missing-folder.ts

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
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-gone-")));
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
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];

// A repo with three branches, each with a worktree a thread works in.
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
git(project, "init", "-q", "-b", "main");
git(project, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
const wt = (name) => path.join(HOME, "worktrees", name);
for (const b of ["ledger-batch", "erp-sync", "old-fix"]) {
  git(project, "branch", b);
  git(project, "worktree", "add", "-q", wt(b), b);
}

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
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resumes = (id: string) => calls().filter((c) => c.args.includes("--resume") && c.args.includes(id));
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf: Record<string, string> = {};
const hook = (event: string, input: { session_id?: string; [field: string]: unknown }, pid: number) => {
  if (input.session_id) sessionOf[pid] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[pid], ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
};
// A thread that ran in a worktree, in a terminal, and ended.
const ran = (id, cwd, pid) => {
  hook("SessionStart", { session_id: id, cwd, source: "startup" }, pid);
  hook("UserPromptSubmit", { prompt: `Work on ${id}`, cwd }, pid);
  hook("SessionEnd", { reason: "other", cwd }, pid);
};

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
  ran("t-old", wt("old-fix"), 8003);
  const ended = await until(async () => (await stateOf(get)).sessions.filter((s) => s.id.startsWith("t-") && s.effective === "done").length === 3);
  check(ended, "three threads ran in worktrees, and ended");
  const t = await session("t-ledger");
  check(t?.branch === "ledger-batch" && t.root === project, "a thread knows its branch and repo");

  // ---------- its folder there: nothing to put back ----------
  const there = await get("/api/sessions/t-ledger/folder");
  check(there.gone === null, "while its folder is there, it isn't gone");

  // ---------- another tool deletes the worktrees ----------
  for (const b of ["ledger-batch", "erp-sync", "old-fix"]) fs.rmSync(wt(b), { recursive: true, force: true });
  const gone = (await get("/api/sessions/t-ledger/folder")).gone;
  check(gone?.path === wt("ledger-batch") && gone.branch === "ledger-batch" && gone.ways?.[0] === "checkout" && !gone.remote && /^[0-9a-f]{7,}$/.test(gone.sha || ""), "its folder gone, its branch can be checked out there again");

  // Writing to it says why it can't be resumed, rather than that Claude Code isn't installed.
  const tried = await post("/api/sessions/t-ledger/messages", { text: "where were we?" });
  check(tried.status >= 400 && /Its folder is gone/.test(tried.error || "") && !/isn't installed/.test(tried.error), "writing to it says its folder is gone");

  // ---------- put back: its branch, there again ----------
  const put = await post("/api/sessions/t-ledger/folder", { way: "checkout" });
  check(put.status === 200 && fs.existsSync(wt("ledger-batch")) && git(wt("ledger-batch"), "rev-parse", "--abbrev-ref", "HEAD") === "ledger-batch", "the button checks its branch out where its folder was");
  check((await get("/api/sessions/t-ledger/folder")).gone === null, "and it's no longer gone");
  const said = (await get("/api/sessions/t-ledger")).messages || [];
  check(said.some((m) => m.from === "agent" && /^agentbook checked out ledger-batch \([0-9a-f]+\) at .*ledger-batch, where its folder was\.$/.test(m.text)), "its conversation says what agentbook did");
  const again = await post("/api/sessions/t-ledger/folder", { way: "checkout" });
  check(again.status === 200 && ((await get("/api/sessions/t-ledger")).messages || []).filter((m) => /^agentbook checked out/.test(m.text)).length === 1, "putting back a folder that's there does nothing");

  // Written to, it resumes there, and its agent hears what happened; once.
  const wrote = await post("/api/sessions/t-ledger/messages", { text: "where were we?" });
  const first = await until(() => resumes("t-ledger")[0]);
  check(wrote.status === 200 && first?.cwd === wt("ledger-batch") && first.args[0].startsWith("where were we?") && /agentbook: your folder was deleted after your last turn, and agentbook checked out ledger-batch/.test(first.args[0]) && /Anything you hadn't committed there is gone/.test(first.args[0]), "written to, it resumes there, told its folder was put back");
  // Its turn runs there, and ends.
  hook("SessionStart", { session_id: "t-ledger", cwd: wt("ledger-batch"), source: "resume" }, 8101);
  hook("UserPromptSubmit", { prompt: first?.args[0] || "", cwd: wt("ledger-batch") }, 8101);
  hook("SessionEnd", { reason: "other", cwd: wt("ledger-batch") }, 8101);
  await until(async () => (await session("t-ledger"))?.effective === "done");
  await post("/api/sessions/t-ledger/messages", { text: "and now?" });
  const second = await until(() => resumes("t-ledger")[1]);
  check(second?.args[0] === "and now?", "the next time, it isn't told again");

  // ---------- its branch in another folder: a copy ----------
  git(project, "worktree", "prune");
  git(project, "worktree", "add", "-q", path.join(HOME, "worktrees", "holder"), "erp-sync");
  ran("t-holder", path.join(HOME, "worktrees", "holder"), 8004);
  const taken = (await get("/api/sessions/t-erp/folder")).gone;
  check(taken?.ways?.[0] === "copy" && taken.taken === path.join(HOME, "worktrees", "holder"), "its branch checked out in another folder, it can have a copy, as git won't check a branch out twice");
  check(taken?.taken_by === "t-holder" && taken.taken_label === (await session("t-holder"))?.label, "and it names the thread working there, to go to instead");
  const no = await post("/api/sessions/t-erp/folder", { way: "checkout" });
  check(no.status >= 400 && /erp-sync is checked out in/.test(no.error || "") && !fs.existsSync(wt("erp-sync")), "it won't check out the branch a second time");
  const copied = await post("/api/sessions/t-erp/folder", { way: "copy" });
  check(copied.status === 200 && git(wt("erp-sync"), "rev-parse", "--abbrev-ref", "HEAD") === "HEAD", "a copy is its commit, not on the branch");

  // ---------- its branch gone too: its repo's default branch, or an empty folder ----------
  git(project, "worktree", "prune");
  git(project, "branch", "-D", "old-fix");
  const based = (await get("/api/sessions/t-old/folder")).gone;
  check(based?.ways?.join() === "base,empty" && based.base === "main", "its branch gone, its repo's default branch can go there, or an empty folder");
  const empty = await post("/api/sessions/t-old/folder", { way: "empty" });
  check(empty.status === 200 && fs.existsSync(wt("old-fix")) && fs.readdirSync(wt("old-fix")).length === 0 && ((await get("/api/sessions/t-old")).messages || []).some((m) => /^agentbook made an empty folder at .*old-fix/.test(m.text)), "an empty folder, where its folder was");
  const bad = await post("/api/sessions/t-old/folder", { way: "anywhere" });
  check(bad.status === 400, "only the ways it offers");
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
