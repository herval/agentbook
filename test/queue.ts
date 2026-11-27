#!/usr/bin/env node
// Queue for later: what you queue while a thread works waits for its turn to end, one
// per turn and in order; what you send now reaches Claude Code at its next step (its PostToolUse hook, started only
// when a file says something waits for it). A real agentbook, a session played through the real hooks.
// Run: node test/queue.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caughtUp, freePort, spawnAgentbook } from "./harness.ts";
import { postForOthers } from "../server/policy.ts";
import type { Message } from "../plugin/shared/types.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-queue-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = await freePort(4400);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_OPENCLAW: "0",
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_API_MS: "30000", // this test's hooks finish, however busy the machine: it checks what they say
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID"]) delete env[k];
const HOST = os.hostname().split(".")[0];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
// What the test does next goes by what its hooks said, so the server has that first.
const call = async (u: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => {
  await caughtUp(PORT);
  return fetch(u, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
};
const get = async (p: string): Promise<Json> => (await call(URL + p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(URL + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);

// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do. One makes a few calls, each
// with AGENTBOOK_API_MS to answer.
const HOOK_MS = 240000;
const sessionOf = {};
function runHook(event, input, extra) {
  if (input.session_id) sessionOf[extra?.AGENTBOOK_PID] = input.session_id;
  const r = spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[extra?.AGENTBOOK_PID], ...input }), env: { ...env, ...extra }, encoding: "utf8", timeout: HOOK_MS });
  if (r.error) throw new Error(`its ${event} hook didn't finish: ${r.error.message}`); // not a check that fails later for no reason
  return { code: r.status, out: r.stdout };
}
// The PostToolUse hook as hooks.json runs it: a shell that starts it only when a file names its parent.
const gate = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks.PostToolUse[0].hooks[0].command;
function runGate(extra) {
  const t = Date.now();
  const r = spawnSync("/bin/sh", ["-c", gate], { input: JSON.stringify({ tool_name: "Bash" }), env: { ...env, ...extra }, encoding: "utf8", timeout: HOOK_MS });
  return { code: r.status, out: r.stdout, ms: Date.now() - t };
}

const project = path.join(HOME, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
const server = spawnAgentbook({ env, stdio: ["ignore", process.env.DEBUG ? "inherit" : "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 90000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  const PID = "920001";
  const me = { AGENTBOOK_PID: PID, AGENTBOOK_LABEL: "tern", CLAUDE_PROJECT_DIR: project };
  const S = "sess-q";
  const prompt = (text) => runHook("UserPromptSubmit", { prompt: text, cwd: project }, me);
  const stop = (said) => runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: said }, me);
  const detail = () => get(`/api/sessions/${S}`);
  const queued = async () => (await detail()).messages.filter((m) => m.queued).map((m) => m.text);
  // What its session would take next, without taking it (the Wake hook and the channel ask the same).
  const waiting = async () => (await get(`/api/procs/${HOST}-${PID}/events`)).events.map((e) => e.event.text || e.event.type);
  const steerFile = path.join(HOME, "cli", "steer", PID);

  runHook("SessionStart", { session_id: S, cwd: project, source: "startup" }, me);
  prompt("the uploader drops big files on a flaky connection");
  check((await detail()).busy, "a session in the middle of its turn is busy");

  // ---------- queued while it works: it waits, and sets nothing aside ----------
  const q1 = await post(`/api/sessions/${S}/messages`, { text: "then land it", queue: true });
  const q2 = await post(`/api/sessions/${S}/messages`, { text: "then add a test for an empty file", queue: true });
  check(q1.held && q2.held, "what you queue while it works is held");
  check(JSON.stringify(await queued()) === JSON.stringify(["then land it", "then add a test for an empty file"]), "it's on the thread as queued, in the order you wrote it");
  const apart = (c) => c?.queue?.length === 2 && !c.last_messages.some((m) => m.queued) && c.messages === 1;
  check(await until(async () => apart((await stateOf(get)).sessions.find((s) => s.id === S))), "the feed's card has the queue apart from its conversation");
  check((await waiting()).length === 0, "nothing of it waits to be taken mid-turn (no ab_inbox, no hook)");
  check(!fs.existsSync(steerFile), "and no file asks its PostToolUse hook to start");

  // ---------- its turn ends: the first goes in as its next prompt, the second waits ----------
  const end1 = JSON.parse(stop("Retries are in.").out || "{}");
  check(end1.decision !== "block", "its turn ends as it would have: the queue doesn't keep it going");
  check(await until(async () => (await waiting()).includes("then land it")), "the first one goes in once the turn is over, as its next prompt");
  const d1 = await detail();
  const m1 = d1.messages.find((m) => m.text === "then land it");
  const reply = d1.messages.find((m) => m.text === "Retries are in.");
  check(m1 && !m1.queued && m1.waited && reply && m1.at >= reply.at, "it leaves the queue and joins the conversation after the reply it waited for, saying it waited");
  check(JSON.stringify(await queued()) === JSON.stringify(["then add a test for an empty file"]) && !(await waiting()).includes("then add a test for an empty file"), "the second waits for the turn the first starts");
  prompt("then land it");
  stop("Landed.");
  check(await until(async () => (await waiting()).includes("then add a test for an empty file")), "and goes in when that turn ends");
  prompt("then add a test for an empty file");
  check((await queued()).length === 0, "the queue is empty once both went in");

  // ---------- send now: Claude gets it at its next step ----------
  await post(`/api/sessions/${S}/messages`, { text: "use the EU bucket" });
  check(await until(() => fs.existsSync(steerFile)), "something sent now to a busy session leaves a file for its PostToolUse hook");
  const quiet = runGate({ AGENTBOOK_PID: PID });
  check(quiet.code === 0 && quiet.out === "", "the hook's shell starts nothing for a process the file doesn't name");
  fs.writeFileSync(path.join(HOME, "cli", "steer", String(process.pid)), ""); // the shell's parent here is this test
  const step = runGate({ AGENTBOOK_PID: PID });
  const ctx = JSON.parse(step.out || "{}").hookSpecificOutput;
  check(step.code === 0 && ctx?.hookEventName === "PostToolUse" && /use the EU bucket/.test(ctx.additionalContext), "for its own process it starts the hook, which hands Claude the message at its next step");
  check(await until(() => !fs.existsSync(steerFile)), "and the file goes once it's taken");
  check(!(await waiting()).length, "nothing is left for the end of the turn");
  fs.rmSync(path.join(HOME, "cli", "steer", String(process.pid)), { force: true });
  stop("EU it is.");

  // ---------- queue one, then send it now ----------
  prompt("next thing");
  await post(`/api/sessions/${S}/messages`, { text: "wait, keep the CLI's retry count", queue: true });
  const qnow = (await detail()).messages.find((m) => m.queued);
  const sent = await post(`/api/sessions/${S}/queue`, { op: "now", mid: qnow.id });
  check(sent.ok && (await waiting()).includes("wait, keep the CLI's retry count") && !(await queued()).length, "Send now on a queued one takes it out of the queue and sends it at once");
  runHook("PostToolUse", { tool_name: "Bash" }, me);
  stop("Kept it.");

  // ---------- edit and remove: out of the queue ----------
  prompt("another");
  await post(`/api/sessions/${S}/messages`, { text: "draft one", queue: true });
  await post(`/api/sessions/${S}/messages`, { text: "draft two", queue: true });
  const drafts = (await detail()).messages.filter((m) => m.queued);
  await post(`/api/sessions/${S}/queue`, { op: "drop", mid: drafts[0].id });
  check(JSON.stringify(await queued()) === JSON.stringify(["draft two"]), "Edit or Remove takes one out of the queue");
  check((await post(`/api/sessions/${S}/queue`, { op: "drop", mid: drafts[0].id })).status === 404, "one that's gone can't be dropped again");
  await post(`/api/sessions/${S}/queue`, { op: "clear" });
  check(!(await queued()).length, "Clear empties it");

  // ---------- paused: it holds through the end of the turn, and goes once resumed ----------
  await post(`/api/sessions/${S}/messages`, { text: "after the pause", queue: true });
  await post(`/api/sessions/${S}/queue`, { op: "pause" });
  check((await detail()).queue_paused === "you", "Pause holds the queue");
  stop("Done with another.");
  await sleep(600);
  check(JSON.stringify(await queued()) === JSON.stringify(["after the pause"]), "a paused queue stays put when the turn ends");
  await post(`/api/sessions/${S}/queue`, { op: "resume" });
  check(await until(async () => (await waiting()).includes("after the pause")), "Resume lets the next one go, now that it's done");
  check(!(await detail()).queue_paused, "and the queue isn't paused any more");
  prompt("after the pause");

  // ---------- a question it asked you holds the queue ----------
  const mcp = async (name: string, args: Record<string, unknown>) => ((await (await fetch(`${URL}/api/mcp?proc=${HOST}-${PID}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as Json).result;
  await mcp("ab_ask", { question: "Squash it before it lands?", options: ["Squash", "Keep them"], wait_seconds: 0 });
  await post(`/api/sessions/${S}/messages`, { text: "then open the PR", queue: true });
  stop("Asked you about squashing.");
  await sleep(600);
  check(JSON.stringify(await queued()) === JSON.stringify(["then open the PR"]), "while its question waits for you, the queue waits too");
  const q = (await stateOf(get)).questions.find((x) => x.post === S && !x.answered);
  await post(`/api/questions/${q.id}/answer`, { value: "Squash" });
  await sleep(600);
  check((await queued()).length === 1, "your answer goes first");
  prompt("(answer)");
  stop("Squashed.");
  check(await until(async () => (await waiting()).includes("then open the PR")), "and the queue after that turn");
  prompt("then open the PR");

  // ---------- queued when it's done: it goes now ----------
  stop("PR open.");
  await sleep(300);
  const idle = await post(`/api/sessions/${S}/messages`, { text: "thanks", queue: true });
  check(idle.went && (await waiting()).includes("thanks") && !(await queued()).length, "queued once it's done, it goes now: there's nothing to wait for");
  prompt("thanks");

  // ---------- its session ends: the queue holds, and Send next resumes it ----------
  await post(`/api/sessions/${S}/messages`, { text: "one last thing", queue: true });
  runHook("SessionEnd", { reason: "other" }, me);
  check(await until(async () => (await detail()).queue_paused === "ended"), "a session that ends holds its queue");
  const last = (await detail()).messages.find((m) => m.queued);
  const mark = calls().length;
  const resumed = await post(`/api/sessions/${S}/queue`, { op: "now", mid: last.id });
  const r = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume")), 8000);
  check(resumed.ok && r?.args[0] === "one last thing" && r.args[r.args.indexOf("--resume") + 1] === S, "Send next resumes it with the next one as its prompt");
  check(await until(async () => !(await queued()).length && (await detail()).messages.filter((m) => m.text === "one last thing").length === 1), "which shows once, in the conversation");

  // ---------- a CLI too busy to say what waits: the turn still ends ----------
  const heard = [];
  const busyCli = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      heard.push({ route: req.url, body });
      if (!req.url.includes("/events")) res.end("{}"); // what waits: it never answers
    });
  });
  await new Promise<void>((r) => busyCli.listen(0, "127.0.0.1", r));
  const hook = spawn(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), "Stop"], { env: { ...env, ...me, AGENTBOOK_API_MS: "", AGENTBOOK_URL: `http://127.0.0.1:${(busyCli.address() as AddressInfo).port}` }, stdio: ["pipe", "ignore", "ignore"] });
  hook.stdin.end(JSON.stringify({ session_id: S, stop_hook_active: false, cwd: project, last_assistant_message: "Done." }));
  await new Promise((r) => hook.once("exit", r));
  busyCli.closeAllConnections();
  busyCli.close();
  check(heard.some((h) => h.route.includes("/events")) && heard.some((h) => h.route.endsWith("/status") && JSON.parse(h.body).turn === "end"), "a Stop hook that hears nothing about what waits still ends the turn");

  // ---------- others never see what you queued ----------
  // A message of the thread's, its owner's: queued, or said.
  const msg = (id: string, text: string, queued?: true): Message => ({ id, post: "x", from: "human", via: "dash", text, file_id: null, files: [], at: "2026-10-30T10:00:00Z", ...(queued ? { queued } : {}) });
  const withQueue = { id: "x", messages: [msg("a", "said"), msg("b", "queued", true)], last_messages: [msg("b", "queued", true)], queue: [{ id: "b" }], queue_paused: "you" };
  const others = postForOthers(withQueue, { visibility: "public" }, "tester");
  check(others.messages.length === 1 && !others.last_messages.length && !("queue" in others) && !("queue_paused" in others), "someone else sees a public thread without its queue");
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
