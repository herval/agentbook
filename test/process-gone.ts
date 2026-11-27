#!/usr/bin/env node
// A Claude Code session whose process went without saying so (killed, or its machine restarted under it: a cloud
// sandbox stopped), so no SessionEnd came. Idle in a terminal, it held what you sent for someone to type there, for
// good. Now it has ended: your message resumes it, and
// what it held goes with it. At agentbook-cli's start, one gone while it was off ends by itself. One whose process is
// still there, in a terminal, holds what you send as before, and so does one whose pid this machine never saw run
// (other tests give their sessions made-up pids). One whose turn's end never reached agentbook, which Claude Code lists
// idle, ends its turn by that, and what you sent it goes by a nudge.
// Run: node test/process-gone.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeAgentRow } from "../plugin/cli/drivers/claude.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-process-gone-"));
const PORT = testPort(4650);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "200",
  AGENTBOOK_API_MS: "10000",
  AGENTBOOK_TURN_LOST_MS: "1000",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

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
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};

// Real processes, as Claude Code's are: agentbook looks at whether they're there. Two sessions idle in terminals (one
// whose process gets killed under it, one that goes while agentbook-cli is off), one whose process stays, and a
// background one, which keeps agentbook-cli asking Claude Code what runs.
const GONE = "gone-session";
const LATER = "later-session";
const STAYS = "stays-session";
const BACKGROUND = "background-session";
const SOLO = "solo-session"; // the only one with its name: another session's message can reach it
const LOST = "lost-session"; // one whose turn's end never reached agentbook
let lostStatus = "busy";
const procs = Object.fromEntries([GONE, LATER, STAYS, BACKGROUND, SOLO, LOST].map((id) => [id, spawn("sleep", ["600"], { stdio: "ignore" })]));
const hook = (id: string, event: string, input: object = {}, extra: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, session_id: id, ...input }), env: { ...env, AGENTBOOK_PID: String(procs[id]?.pid ?? ""), ...extra }, encoding: "utf8", timeout: 30000 });

// As `claude agents --json --all` has them: a session in a terminal only while its process runs.
const listed = new Set([GONE, LATER, STAYS]);
function list() {
  const rows: (Omit<ClaudeAgentRow, "id"> & { id?: string; cwd: string })[] = [...listed].map((id) => ({ pid: procs[id].pid, cwd: project, kind: "interactive", status: "idle", startedAt: Date.now(), sessionId: id, name: "app" }));
  rows.push({ pid: procs[BACKGROUND].pid, id: BACKGROUND.slice(0, 8), cwd: project, kind: "background", state: "working", status: "busy", startedAt: Date.now(), sessionId: BACKGROUND, name: "app" });
  rows.push({ pid: procs[SOLO].pid, cwd: project, kind: "interactive", status: "idle", startedAt: Date.now(), sessionId: SOLO, name: "solo" });
  rows.push({ pid: procs[LOST].pid, cwd: project, kind: "interactive", status: lostStatus, startedAt: Date.now(), sessionId: LOST, name: "lost" });
  const tmp = path.join(FAKE, "agents.tmp");
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, path.join(FAKE, "agents.json"));
}
const resumes = (id) =>
  fs.existsSync(path.join(FAKE, "calls.jsonl"))
    ? fs
        .readFileSync(path.join(FAKE, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((c) => c.args.includes("--resume") && c.args.includes(id))
    : [];
const seen = (id) => get(`/api/sessions/${id}`);
list();

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 20000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  hook(BACKGROUND, "SessionStart", { source: "startup" });
  hook(BACKGROUND, "UserPromptSubmit", { prompt: "Keep agentbook asking" });
  for (const id of [GONE, LATER, STAYS]) {
    hook(id, "SessionStart", { source: "startup" });
    hook(id, "UserPromptSubmit", { prompt: `Tidy up (${id})` });
    hook(id, "Stop", { stop_hook_active: false, last_assistant_message: "Done." });
  }
  check(!!(await until(async () => (await Promise.all([GONE, LATER, STAYS].map(seen))).every((s) => s.state === "idle"))), "three sessions idle in their terminals");

  // ---------- one whose process is there ----------
  const held = await post(`/api/sessions/${STAYS}/messages`, { text: "Are you there?" });
  check(held.status === 200 && held.stuck === "terminal", "one whose process is there holds what you send for its terminal, as before");
  check((await seen(STAYS)).state === "idle" && !resumes(STAYS).length, "and isn't ended or resumed");

  // ---------- one another session's message can reach ----------
  const nudges = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []).filter((c) => c.args[0] === "-p" && c.args.includes("SendMessage"));
  check(!nudges().length, "one that shares its name with other sessions isn't nudged: a name is the address");
  hook(SOLO, "SessionStart", { source: "startup" });
  hook(SOLO, "UserPromptSubmit", { prompt: "Tidy up (solo)" });
  hook(SOLO, "Stop", { stop_hook_active: false, last_assistant_message: "Done." });
  await until(async () => (await seen(SOLO)).state === "idle");
  const nudged = await post(`/api/sessions/${SOLO}/messages`, { text: "Rebase it" });
  check(nudged.status === 200 && nudged.nudged === true && !nudged.stuck, `one idle with nothing to wake it, alone with its name, is nudged (${JSON.stringify(nudged)})`);
  const sentNudge = await until(async () => nudges()[0]);
  check(!!sentNudge && /to: "solo"/.test(sentNudge.args[1]) && /ab_inbox/.test(sentNudge.args[1]) && !/Rebase it/.test(sentNudge.args[1]), "by a headless run that sends it a message to read its inbox, without your words in it");
  await sleep(500);
  check(!/couldn't wake/.test((await seen(SOLO)).status_text || JSON.stringify(await seen(SOLO))), "and its thread says nothing more when the nudge got there");
  fs.writeFileSync(path.join(FAKE, "nudge-refused"), "");
  const refusedNudge = await post(`/api/sessions/${SOLO}/messages`, { text: "And push" });
  check(refusedNudge.nudged === true, "the next message nudges it again");
  check(!!(await until(async () => /couldn't wake it/.test(JSON.stringify(await seen(SOLO))))), "and when the nudge doesn't get there, its thread says it waits for someone to type there");
  fs.rmSync(path.join(FAKE, "nudge-refused"));

  // ---------- one whose turn's end never came ----------
  // Its Stop hook couldn't reach agentbook-cli in its seconds, and nothing else said the turn ended: the thread stayed
  // on working, Claude Code idle at its prompt, holding what you sent, for hours.
  hook(LOST, "SessionStart", { source: "startup" });
  hook(LOST, "UserPromptSubmit", { prompt: "Write the comedy guide" });
  await sleep(1500);
  check((await seen(LOST)).state === "working", "a turn Claude Code lists as busy stays working, however quiet it is");
  const meanwhile = await post(`/api/sessions/${LOST}/messages`, { text: "Is You Invented its own style?" });
  check(meanwhile.status === 200 && !meanwhile.nudged, "what you send meanwhile waits for its next step");
  const nudgedBefore = nudges().length;
  lostStatus = "idle";
  list();
  check((await until(async () => (await seen(LOST)).state === "idle")) === true, "once Claude Code lists it idle, a while after anything was heard of it, its turn is over");
  const lostNudge = await until(async () => nudges().slice(nudgedBefore).find((c) => /to: "lost"/.test(c.args[1])));
  check(!!lostNudge && /ab_inbox/.test(lostNudge.args[1]), "and what you sent reaches it by a nudge, since no Wake hook waits on it");

  // ---------- one whose pid never ran here ----------
  const MADE_UP = "made-up-session";
  hook(MADE_UP, "SessionStart", { source: "startup" }, { AGENTBOOK_PID: "999999" });
  hook(MADE_UP, "UserPromptSubmit", { prompt: "Tidy up (made up)" }, { AGENTBOOK_PID: "999999" });
  hook(MADE_UP, "Stop", { stop_hook_active: false, last_assistant_message: "Done." }, { AGENTBOOK_PID: "999999" });
  await until(async () => (await seen(MADE_UP)).state === "idle");
  const madeUp = await post(`/api/sessions/${MADE_UP}/messages`, { text: "Still there?" });
  check(madeUp.stuck === "terminal" && !resumes(MADE_UP).length, "one whose pid this machine never saw run isn't taken for gone");

  // ---------- one killed under it ----------
  const first = await post(`/api/sessions/${GONE}/messages`, { text: "First, while it's there" });
  check(first.stuck === "terminal", "a message to the other one is held for its terminal too");
  procs[GONE].kill("SIGKILL");
  listed.delete(GONE);
  list();
  await sleep(300);
  const second = await post(`/api/sessions/${GONE}/messages`, { text: "Second, once it's gone" });
  check(second.status === 200 && second.resumed === true && !!second.lid, `once its process is gone, your message resumes it (${JSON.stringify(second)})`);
  check(resumes(GONE).length === 1, "Claude Code is asked to resume it, once");
  const ended = await seen(GONE);
  check(ended.messages?.some((m) => m.text === "First, while it's there") && ended.messages?.some((m) => m.text === "Second, once it's gone"), "both messages are on its thread");
  // The resumed session, as Claude Code starts it: its first prompt's hook hands it what was held for the terminal.
  procs[GONE] = spawn("sleep", ["600"], { stdio: "ignore" });
  hook(GONE, "SessionStart", { source: "resume" }, { AGENTBOOK_LAUNCH_ID: second.lid });
  const prompt = hook(GONE, "UserPromptSubmit", { prompt: "Second, once it's gone" }, { AGENTBOOK_LAUNCH_ID: second.lid });
  check(prompt.stdout.includes("First, while it's there"), "and what it held reaches the resumed session with its first prompt");
  check((await until(async () => (await seen(GONE)).state === "working")) === true, "which is working");

  // ---------- one gone while agentbook-cli was off ----------
  procs[LATER].kill("SIGKILL");
  listed.delete(LATER);
  list();
  await server.restart("agentbook-cli");
  const later = await until(async () => {
    const s = await seen(LATER);
    return s.state === "done" && s;
  });
  check(later?.end_reason === "Ended", "at its start, agentbook-cli ends one whose process went while it was off");
  const stays = await seen(STAYS);
  check(stays.state === "idle", `and leaves the one whose process is there (${stays.state})`);
  const bg = await seen(BACKGROUND);
  check(bg.state !== "done", "and the background one");
  check((await seen(MADE_UP)).state === "idle", "and the one whose pid never ran here");
  const again = await post(`/api/sessions/${LATER}/messages`, { text: "Pick it up" });
  check(again.resumed === true && resumes(LATER).length === 1, "a message to it resumes it");
} finally {
  server.kill();
  for (const p of Object.values(procs)) p.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
