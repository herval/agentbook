#!/usr/bin/env node
// A turn an API error cuts off (the network dropped, the computer slept mid-reply) ends there: Claude Code runs
// the StopFailure hook instead of Stop. A background session cut off by an error that passes is picked up again
// once Claude's API answers, a few times at most; one in a terminal and an archived one wait for you. One stopped by
// an error that doesn't pass (a usage limit, a refused request) needs you, on the bell; Retry on its thread picks up
// a background one now, whatever the error. One whose login expired needs you too, and a background one is picked up
// once you've signed in again: another session's turn gets a reply, or Claude Code's login changes.
// Run: node test/cut-off.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-cut-"));
const PORT = testPort(4900);
const API_PORT = PORT + 100;
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
  // Claude's API, as agentbook-cli asks whether it answers: down until the test starts it.
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${API_PORT}`,
  AGENTBOOK_PICKUP_SEC: "1,1,1,1,1,1",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
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
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resumes = (id: string, from = 0) => calls().slice(from).filter((c) => c.args.includes("--resume") && c.args.includes(id));
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf: Record<string, string> = {};
const hook = (event: string, input: { session_id?: string; [field: string]: unknown }, pid: number) => {
  if (input.session_id) sessionOf[pid] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, session_id: sessionOf[pid], ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
};
const SLEPT = "API Error: Your computer went to sleep mid-response. The response above may be incomplete.";
const OFFLINE = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const REFUSED = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Opus 5.5.";
const fail = (pid, error = "server_error", said = OFFLINE) => hook("StopFailure", { error, last_assistant_message: said }, pid);

// Sessions the way `claude agents` lists them: six in the background, two in a terminal.
const ids = { "bg-cut": "background", "bg-limit": "background", "bg-arch": "background", "term-cut": "interactive", "bg-login": "background", "bg-login2": "background", "term-login": "interactive", "bg-refused": "background" };
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(Object.entries(ids).map(([id, kind], i) => ({ id, sessionId: id, kind, state: "working", status: "idle", cwd: project, pid: 5000 + i, name: id }))));
for (const id of Object.keys(ids)) {
  fs.mkdirSync(path.join(HOME, "claude", "jobs", id), { recursive: true });
  fs.writeFileSync(path.join(HOME, "claude", "jobs", id, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: id, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));
}

const api = http.createServer((req, res) => res.writeHead(404).end());
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

  // Each starts a turn.
  Object.keys(ids).forEach((id, i) => {
    hook("SessionStart", { session_id: id, source: "startup" }, 7000 + i);
    hook("UserPromptSubmit", { prompt: `Work on ${id}` }, 7000 + i);
  });
  check((await until(async () => (await stateOf(get)).sessions.filter((s) => s.rt).length === 8, 6000)) === true, "eight sessions run, six in the background and two in a terminal");

  // ---------- cut off: the turn is over, saying why ----------
  fail(7000, "server_error", SLEPT);
  let cut = await session("bg-cut");
  check(!cut.busy && cut.effective === "idle" && cut.failed?.error === "server_error" && cut.failed.text === "Your computer went to sleep mid-response. The response above may be incomplete.", "an API error ends its turn, and the thread keeps what cut it off");
  check(!(cut.last_messages || []).some((m) => /API Error/.test(m.text)), "the error isn't mirrored as its reply");
  cut = await until(async () => {
    const s = await session("bg-cut");
    return s?.pickup && s;
  });
  check(!!cut?.pickup && Date.parse(cut.pickup) > Date.now() - 5000, "it says when agentbook tries to pick it up");

  // ---------- while Claude's API doesn't answer, it waits ----------
  await sleep(2500);
  check(resumes("bg-cut").length === 0, "while Claude's API doesn't answer, it isn't resumed");
  check(!!(await session("bg-cut")).pickup, "and it still says when it tries next");
  const early = await post("/api/sessions/bg-cut/pickup");
  check(early.status === 503 && /Claude's API still doesn't answer/.test(early.error || "") && /keeps trying by itself/.test(early.error) && resumes("bg-cut").length === 0, "Retry says Claude's API still doesn't answer, and doesn't resume it");

  // ---------- it answers: picked up ----------
  await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
  const picked = await until(() => resumes("bg-cut")[0], 20000);
  check(/^agentbook: an API error cut your last turn off \(Your computer went to sleep mid-response/.test(picked?.args[0] || "") && /carry on where you left off/.test(picked.args[0]), "once Claude's API answers, it's resumed, told to carry on");
  check(calls().some((c) => c.args[0] === "stop" && c.args[1] === "bg-cut"), "its idle process stopped first, so it continues rather than being copied");
  // Its next turn starts with that prompt.
  hook("SessionStart", { session_id: "bg-cut", source: "resume" }, 7100);
  hook("UserPromptSubmit", { prompt: picked.args[0] }, 7100);
  cut = await session("bg-cut");
  check(cut.busy && !cut.failed && !cut.pickup, "its turn going again, nothing's cut off");
  const said = (await get("/api/sessions/bg-cut")).messages || [];
  check(!said.some((m) => /an API error cut your last turn off/.test(m.text)), "agentbook's prompt isn't shown as yours");

  // ---------- cut off again, and again: a few times at most ----------
  fail(7100);
  const second = await until(() => resumes("bg-cut")[1], 6000);
  check(/Can't reach the API server/.test(second?.args[0] || ""), "cut off again, it's picked up again");
  hook("SessionStart", { session_id: "bg-cut", source: "resume" }, 7101);
  hook("UserPromptSubmit", { prompt: second.args[0] }, 7101);
  fail(7101);
  const third = await until(() => resumes("bg-cut")[2], 6000);
  hook("SessionStart", { session_id: "bg-cut", source: "resume" }, 7102);
  hook("UserPromptSubmit", { prompt: third?.args[0] || "" }, 7102);
  fail(7102);
  await sleep(3000);
  cut = await session("bg-cut");
  check(!!third && resumes("bg-cut").length === 3 && cut.failed && !cut.pickup, "after three resumes that failed again, it's left for you");

  // ---------- a turn that ends on its own settles it ----------
  let mark = calls().length;
  await post("/api/sessions/bg-cut/messages", { text: "Try once more" });
  const mine = await until(() => resumes("bg-cut", mark)[0], 6000);
  check(mine?.args[0] === "Try once more", "writing to it picks it up with your message");
  hook("SessionStart", { session_id: "bg-cut", source: "resume" }, 7103);
  hook("UserPromptSubmit", { prompt: "Try once more" }, 7103);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." }, 7103);
  fail(7103);
  const again = await until(() => resumes("bg-cut", mark)[1], 6000);
  check(!!again, "a turn that ended on its own starts the count over: cut off later, it's picked up again");

  // ---------- errors that don't pass need you; terminals and archived threads wait for you ----------
  mark = calls().length;
  fail(7001, "rate_limit", "You've hit your weekly limit · resets 9am (America/Fortaleza)");
  fail(7007, "invalid_request", REFUSED);
  // A minute later, as Claude Code does: what it's doing now isn't what stopped it.
  hook("Notification", { notification_type: "idle_prompt" }, 7007);
  fail(7003, "server_error");
  fail(7002, "server_error");
  await post("/api/sessions/bg-arch/flag", { archived: true });
  await sleep(3000);
  const limit = await session("bg-limit");
  const refused = await session("bg-refused");
  const term = await session("term-cut");
  const arch = await session("bg-arch");
  check(limit.failed?.error === "rate_limit" && !limit.pickup && resumes("bg-limit", mark).length === 0, "a usage limit isn't picked up by itself");
  check(limit.effective === "needs" && limit.asking?.kind === "stopped" && limit.asking.line === "You've hit your weekly limit · resets 9am (America/Fortaleza)", "so it needs you, and the bell says why");
  check(refused.failed?.error === "invalid_request" && !refused.pickup && resumes("bg-refused", mark).length === 0, "nor is a refused request");
  check(refused.effective === "needs" && refused.asking?.kind === "stopped" && refused.asking.line === "Opus 5.5's safeguards flagged this message." && !!refused.asking.at, "it needs you too, past Claude Code's idle notice, the bell saying why in a line");
  check(term.failed?.error === "server_error" && !term.pickup && resumes("term-cut", mark).length === 0, "nor is a session in a terminal");
  check(arch.archived && !arch.failed && !arch.pickup && resumes("bg-arch", mark).length === 0, "nor an archived one");

  // ---------- Retry: picked up now, whatever cut it off ----------
  check(limit.rt?.kind === "background" && term.rt?.kind !== "background", "the page can tell which it can retry (background) from which it can't (a terminal)");
  const retry = await post("/api/sessions/bg-limit/pickup");
  const retried = await until(() => resumes("bg-limit", mark)[0], 6000);
  check(retry.status === 200 && /^agentbook: an API error cut your last turn off \(You've hit your weekly limit/.test(retried?.args[0] || "") && /Retry was pressed on agentbook, so carry on where you left off/.test(retried.args[0]), "Retry picks up one a usage limit cut off, told why");
  const picking = await session("bg-limit");
  check(!!picking.pickup && Date.parse(picking.pickup) <= Date.now(), "and its thread says it's picking it up");
  const twice = await post("/api/sessions/bg-limit/pickup");
  await sleep(500);
  check(twice.status === 200 && resumes("bg-limit", mark).length === 1, "Retry again while it's picked up does nothing more");
  const inTerm = await post("/api/sessions/term-cut/pickup");
  check(inTerm.status === 409 && /in a terminal/.test(inTerm.error || "") && resumes("term-cut", mark).length === 0, "Retry on one in a terminal says to write to it there");

  // ---------- one that stopped: writing to it or archiving it settles it ----------
  mark = calls().length;
  await post("/api/sessions/bg-refused/messages", { text: "Go on" });
  const wrote = await until(() => resumes("bg-refused", mark)[0], 6000);
  check(wrote?.args[0] === "Go on", "writing to a stopped thread picks it up with your message");
  hook("SessionStart", { session_id: "bg-refused", source: "resume" }, 7107);
  hook("UserPromptSubmit", { prompt: "Go on" }, 7107);
  const going = await session("bg-refused");
  check(going.effective === "working" && !going.asking && !going.failed, "and while it works it doesn't need you");
  fail(7107, "invalid_request", REFUSED);
  check((await session("bg-refused")).effective === "needs", "refused again, it does");
  await post("/api/sessions/bg-refused/flag", { archived: true });
  const shelved = await until(async () => {
    const s = await session("bg-refused");
    return s?.archived && s;
  });
  check(shelved?.effective !== "needs" && !shelved?.asking, "archived, it doesn't");

  // ---------- an expired login: it needs you, and is picked up once you've signed in again ----------
  mark = calls().length;
  const EXPIRED = "Login expired · Please run /login";
  fail(7004, "authentication_failed", EXPIRED);
  fail(7006, "authentication_failed", EXPIRED);
  let login = await until(async () => {
    const s = await session("bg-login");
    return s?.pickup && s;
  });
  check(login && !login.busy && login.effective === "needs" && login.failed?.error === "authentication_failed" && login.failed.text === EXPIRED && login.asking?.line === EXPIRED, "an expired login ends its turn and needs you, saying so, on the bell too");
  check(login?.pickup === "login", "it says it's picked up once you've signed in again");
  const termLogin = await session("term-login");
  check(termLogin.effective === "needs" && termLogin.failed?.error === "authentication_failed" && !termLogin.pickup, "one in a terminal needs you too, and waits for you to write to it");
  await sleep(2500);
  check(resumes("bg-login", mark).length === 0, "though Claude's API answers, it isn't resumed while the login may still be expired");

  // Another session's turn gets a reply: Claude Code is signed in again.
  hook("UserPromptSubmit", { prompt: "Try again" }, 7001);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." }, 7001);
  const back = await until(() => resumes("bg-login", mark)[0], 6000);
  check(/^agentbook: Claude Code's login expired and cut your last turn off \(Login expired · Please run \/login\)/.test(back?.args[0] || "") && /You're signed in again, so carry on where you left off/.test(back.args[0]), "another session's turn getting a reply picks it up, told it's signed in again");
  check(resumes("term-login", mark).length === 0, "not the one in a terminal");
  hook("SessionStart", { session_id: "bg-login", source: "resume" }, 7104);
  hook("UserPromptSubmit", { prompt: back?.args[0] || "" }, 7104);
  login = await session("bg-login");
  check(login.busy && !login.failed && login.effective === "working", "its turn going again, it no longer needs you");

  // Cut off again, with another: signing in (Claude Code writing its login) picks both up.
  mark = calls().length;
  fail(7104, "authentication_failed", EXPIRED);
  fail(7005, "authentication_failed", EXPIRED);
  await sleep(1500);
  check(resumes("bg-login", mark).length === 0 && resumes("bg-login2", mark).length === 0, "cut off again, they wait for you to sign in");
  fs.writeFileSync(path.join(HOME, "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
  const both = await until(() => resumes("bg-login", mark).length && resumes("bg-login2", mark).length, 8000);
  check(!!both && /You're signed in again/.test(resumes("bg-login2", mark)[0].args[0]), "signing in to Claude Code again picks up every thread an expired login cut off");

  // Archived, it no longer needs you.
  await post("/api/sessions/term-login/flag", { archived: true });
  const archLogin = await session("term-login");
  check(archLogin.archived && !archLogin.failed && archLogin.effective !== "needs", "an archived one no longer needs you");

  // ---------- no login at all: Claude Code stops a woken session before its turn, and runs no hook ----------
  // (boat-littleguys after two days stopped: the thread said nothing, and what you sent sat in a copy of it.)
  const list = JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
  list.push({ id: "bg-nologin", sessionId: "bg-nologin", kind: "background", state: "working", status: "idle", cwd: project, pid: 5100, name: "bg-nologin" });
  fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(list));
  hook("SessionStart", { session_id: "bg-nologin", source: "startup" }, 7200);
  hook("UserPromptSubmit", { prompt: "Work on bg-nologin" }, 7200);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." }, 7200);
  // Its process goes (the machine stopped), so it's asleep.
  const listed = JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
  Object.assign(listed.find((a) => a.id === "bg-nologin"), { state: "done" });
  delete listed.find((a) => a.id === "bg-nologin").pid;
  fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(listed));
  check(!!(await until(async () => (await session("bg-nologin"))?.asleep, 8000)), "a background thread whose process went is asleep");
  // Claude Code has no login now, and its resume starts a copy, as it did there.
  fs.writeFileSync(path.join(FAKE, "logged-out"), "");
  fs.writeFileSync(path.join(FAKE, "copy.txt"), "");
  mark = calls().length;
  await post("/api/sessions/bg-nologin/messages", { text: "Show it in dark mode" });
  const woke = await until(() => resumes("bg-nologin", mark)[0], 6000);
  check(woke?.args[0] === "Show it in dark mode", "writing to it wakes it with your message");
  const copyOf = () => JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8")).find((a) => a.state === "blocked");
  const copy = await until(copyOf, 4000);
  check(!!copy && copy.sessionId !== "bg-nologin", "Claude Code starts a copy, which stops before its turn, blocked on its login, running no hook");
  const nologin = await until(async () => {
    const s = await session("bg-nologin");
    return s?.failed && s;
  }, 8000);
  check(nologin?.failed?.error === "authentication_failed" && nologin.failed.text === "Login expired" && nologin.effective === "needs" && nologin.asking?.line === "Login expired", "with no hook, the thread still says its login expired, and needs you, on the bell too");
  check(nologin?.pickup === "login", "it says it's picked up once you've signed in again");
  await sleep(1500);
  check(resumes(copy?.sessionId || "-", mark).length === 0 && (await session("bg-nologin")).failed?.error === "authentication_failed", "it waits for you: not resumed, and not cut off twice");
  // Signing in picks it up, in the copy, where what you sent is.
  fs.rmSync(path.join(FAKE, "logged-out"));
  fs.writeFileSync(path.join(HOME, "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { at: Date.now() } }));
  const resumedCopy = await until(() => resumes(copy?.sessionId || "-", mark)[0], 8000);
  check(/^agentbook: Claude Code's login expired and cut your last turn off \(Login expired\)/.test(resumedCopy?.args[0] || ""), "signing in picks it up in the copy that has your message, told it's signed in again");
  check(resumes("bg-nologin", mark).length === 1, "not in the session from before your message");
} finally {
  server.kill();
  api.close();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
