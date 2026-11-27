#!/usr/bin/env node
// Routines that aren't a page's: an agent routine you make yourself runs as you
// made it, each run a session started with its prompt, or a message to the thread it's for; a run doesn't start
// while the last one still works; one an agent writes waits for your OK, and runs at most hourly; a code routine
// for a thread posts its line there. Page routines (test/page-routines.ts) are the same routines, for a page.
// Run: node test/global-routines.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextAt, routineInput, runsPerDay, scheduleFrom, scheduleText } from "../plugin/cli/routines.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";
import type { Routine } from "../plugin/shared/types.ts";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-global-routines-")));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const CLAUDE_DIR = path.join(HOME, "claude");
fs.mkdirSync(CLAUDE_DIR);
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(CLAUDE_DIR, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: CLAUDE_DIR, AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200", AGENTBOOK_ROUTINES_TICK_MS: "250", AGENTBOOK_CLAUDE_ROUTINES: "0" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const calls = () => {
  try {
    return fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const starts = () => calls().filter((c) => c.args.includes("--bg") && !c.args.includes("--resume"));

let server;
async function start() {
  server = spawnAgentbook({ env, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stop() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}

// ---------- the parts that need no server ----------
{
  check(scheduleFrom("0 8 * * 1-5").kind === "cron" && scheduleText(scheduleFrom("0 8 * * 1-5")) === "weekdays at 08:00" && scheduleText(scheduleFrom({ cron: "30 9 * * 1" })) === "Mondays at 09:30", "a cron reads as a schedule, and in words");
  check(scheduleFrom("manual").kind === "manual" && scheduleText({ kind: "manual" }) === "when you run it" && scheduleFrom({ at: "2026-10-12T09:00" }).kind === "at", "a routine can run only when it's run, or once");
  check(Math.round(runsPerDay(scheduleFrom("0 8 * * 1-5")) * 7) === 5 && runsPerDay(scheduleFrom("30m")) === 48, "it knows about how many runs a day a schedule makes");
  let threw = null;
  try {
    routineInput({ kind: "agent", name: "Triage", prompt: "x", schedule: "15m" }, null);
  } catch (e) {
    threw = e.message;
  }
  check(/at most hourly/.test(threw || "") && routineInput({ kind: "agent", name: "Triage", prompt: "x", schedule: "15m" }, null, { user: true }).schedule.everyMs === 900e3, "an agent routine an agent writes runs at most hourly; you can set it more often");
  const now = Date.now();
  // An agent routine as agentbook keeps one: on, OK'd, every hour, never run.
  const agentR: Routine = { id: "r-hourly", kind: "agent", page: null, name: "Triage", about: "", cant_keep: "", on: true, keeps: [], timeout: 600e3, live_v: 1, code_v: 1, schedule: { kind: "every", everyMs: 3600e3 }, agent: null, by: null, ok_at: new Date(now).toISOString(), created: new Date(now).toISOString(), updated: new Date(now).toISOString(), fails: 0, last: null, last_ok: null, memo: {} };
  const codeR: Routine = { ...agentR, kind: "code" };
  check(nextAt(agentR) >= now + 3600e3 - 1000 && nextAt(codeR) <= Date.now(), "an agent routine waits for its time once it's on; a code routine runs right away to fill its widgets");
  check(nextAt({ ...agentR, schedule: { kind: "manual" } }) === null && nextAt({ ...agentR, schedule: { kind: "at", at: new Date(now + 5000).toISOString() }, last: { at: new Date(now + 6000).toISOString(), ok: true, ms: 1000, error: null, version: null, v: 1, changed: [], why: "", lid: null, post: null, skipped: null } }) === null, "one that runs when it's run has no next run, nor one that ran once already");
}

// ---------- the server ----------
await start();
try {
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  const claude = agent("box-1");

  // You make an agent routine: it runs as you made it, without an OK.
  let r = await owner.post("/api/routines", { name: "Morning digest", prompt: "Summarize what my agents did yesterday.", agent: "claude", root: project, schedule: "0 8 * * 1-5" });
  const digest = r.id;
  check(r.status === 200 && r.kind === "agent" && r.live_v === 1 && r.on && r.when === "weekdays at 08:00" && r.runs_as === "claude" && r.next && r.links.length === 1 && r.links[0].kind === "agent" && !r.thread, "you make an agent routine by itself, and it's on, with its next run, and no OK to wait for");
  let st = await stateOf(owner.get);
  check(st.routines.some((x) => x.id === digest) && !st.questions.some((q) => q.routine?.rid === digest), "it's in the state for its owner, and nobody's asked");
  check([401, 403].includes((await req("GET", "/api/routines")).status), "someone signed out can't see the routines");

  // Run now: a session, with the routine's header and its prompt, in its folder, marked with the routine.
  fs.writeFileSync(path.join(FAKE, "next.txt"), "dddddddd-0000-4000-8000-000000000001");
  r = await owner.post(`/api/routines/${digest}/run`);
  check(r.status === 200, "Run now starts it");
  const call = await until(() => starts().find((c) => c.args.some((a) => /Summarize what my agents did/.test(a))));
  const prompt = call?.args.find((a) => /Summarize/.test(a)) || "";
  check(call && call.cwd === project && /This is a run of the routine "Morning digest"/.test(prompt) && /pressed Run now/.test(prompt), "a run starts a session in its folder, told which routine it is and why it runs");
  check(/before giving up on something only they can fix/.test(prompt) && /wait_seconds: 300/.test(prompt) && /only once they skip it or the default applies/.test(prompt), "and to ask before giving up on what only its owner can fix (a sign-in), waiting for them, rather than writing the run off");
  let d = await until(async () => {
    const x = await owner.get(`/api/routines/${digest}`);
    return x.runs?.[0]?.lid && x;
  });
  const lid = d?.runs[0].lid;
  check(d && d.runs[0].ok && d.runs[0].why === "now" && (await stateOf(owner.get)).launches.find((l) => l.id === lid)?.routine?.id === digest, "the run is its launch, marked with the routine");
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "dddddddd-0000-4000-8000-000000000001", cwd: project, launch: lid } });
  await req("POST", "/api/procs/box-2/status", { body: { state: "working" } });
  d = await owner.get(`/api/routines/${digest}`);
  st = await stateOf(owner.get);
  const dPost = d.runs[0].post;
  check(dPost && st.sessions.find((s) => s.id === dPost)?.routine?.name === "Morning digest", "once its session registers, the run links to its thread, and the thread says which routine it's from");
  r = await owner.post(`/api/routines/${digest}/run`);
  check(r.status === 409 && /still working/.test(r.error), "it won't start again while its last run is still working");

  // A thread on it, from its page (routine-threads.ts): its agent is told which routine, how it stands and that
  // ab_routine_write changes it, and the routine's page lists the thread.
  r = await owner.post("/api/launch", { prompt: "Make it skip Mondays", agent: "claude", root: project, on_my_routine: digest });
  const onIt = await until(() => starts().find((c) => c.args.some((a) => /Make it skip Mondays/.test(a))));
  const told = onIt?.args.find((a) => /Make it skip Mondays/.test(a)) || "";
  check(r.status === 200 && told.includes(`This thread is on agentbook's routine "Morning digest" (id ${digest}): an agent routine run by claude, weekdays at 08:00; on.`) && told.includes("- What it asks:\n  > Summarize what my agents did yesterday.") && told.includes(`ab_routine_write with routine "${digest}" changes it`) && /- Its last runs:\n  - \S+: ok/.test(told), "a thread on one of agentbook's routines tells its agent which one, how it stands and its last runs, and that ab_routine_write changes it");
  d = await owner.get(`/api/routines/${digest}`);
  check(d.threads?.length === 1 && d.threads[0].lid === r.lid && d.threads[0].agent === "claude", "and the routine's page lists the thread");
  check((await owner.post("/api/launch", { prompt: "Hm", agent: "claude", root: project, on_my_routine: "no-such-routine" })).status === 404, "not on a routine that isn't there");

  // On its schedule, a run whose last one still works is skipped, and says why.
  r = await owner.post("/api/routines", { name: "Check once", prompt: "Look at the build.", agent: "claude", root: project, schedule: { at: new Date(Date.now() + 1500).toISOString() } });
  const once = r.id;
  fs.writeFileSync(path.join(FAKE, "next.txt"), "eeeeeeee-0000-4000-8000-000000000001");
  r = await owner.post(`/api/routines/${once}/run`);
  const onceLid = (await until(async () => (await owner.get(`/api/routines/${once}`)).runs?.[0]?.lid)) || null;
  await req("POST", "/api/hello", { body: { proc: "box-3", label: "wren", agent: "Claude", session_id: "eeeeeeee-0000-4000-8000-000000000001", cwd: project, launch: onceLid } });
  await req("POST", "/api/procs/box-3/status", { body: { state: "working" } });
  d = await until(async () => {
    const x = await owner.get(`/api/routines/${once}`);
    return x.runs?.length >= 2 && x;
  });
  check(d && d.runs[0].skipped === "its last run was still working" && d.runs[0].why === "schedule" && d.next === null, "a scheduled run is skipped while the last one works, and a routine that runs once has nothing next");

  // For a thread: a run is a message to it, from the routine.
  r = await owner.post("/api/routines", { name: "Deploy check", prompt: "Is the deploy done? Say so in the thread.", thread: "sess-a", schedule: "manual" });
  const deploy = r.id;
  check(r.status === 200 && r.thread === "sess-a" && r.links.some((l) => l.kind === "thread" && l.id === "sess-a") && r.next === null, "a routine's runs can continue a thread, which it's linked to");
  r = await owner.post(`/api/routines/${deploy}/run`);
  const msg = await until(async () => (await owner.get("/api/sessions/sess-a")).messages?.find((m) => m.routine?.id === deploy));
  check(msg && /Is the deploy done/.test(msg.text) && msg.from === "human", "a thread routine's run is a message to the thread, marked with it");
  const pending = await req("GET", "/api/procs/box-1/events");
  check(JSON.stringify(pending).includes("Is the deploy done"), "and it reaches the session, as what you write does");

  // You change it: the new prompt runs, again without an OK.
  r = await owner.post(`/api/routines/${deploy}`, { prompt: "Is the deploy done? Check CI too." });
  d = await owner.get(`/api/routines/${deploy}`);
  check(r.status === 200 && d.live_v === 2 && d.prompt === "Is the deploy done? Check CI too." && d.versions[0].diff.added >= 1, "you change its prompt, and v2 runs, with the diff kept");

  // An agent writes one: it waits for your OK, asked on its thread.
  r = await claude.post("/routines", { kind: "agent", name: "Nightly triage", prompt: "Triage new issues.", schedule: "30m" });
  check(r.status === 400 && /at most hourly/.test(r.error), "an agent can't make an agent routine that runs more than hourly");
  r = await claude.post("/routines", { kind: "agent", name: "Nightly triage", prompt: "Triage new issues.", schedule: "0 22 * * *", test: true });
  check(r.status === 200 && /This is a run of the routine "Nightly triage"/.test(r.test.prompt) && r.test.when === "daily at 22:00" && !(await stateOf(owner.get)).routines.some((x) => x.name === "Nightly triage"), "a test of an agent routine shows the prompt as it would be sent, and saves nothing");
  r = await claude.post("/routines", { kind: "agent", name: "Nightly triage", prompt: "Triage new issues.", schedule: "0 22 * * *", summary: "Triage every night" });
  const triage = r.id;
  st = await stateOf(owner.get);
  const q = st.questions.find((x) => x.routine?.rid === triage && !x.answered);
  check(r.status === 200 && r.waiting === 1 && r.live_v === 0 && r.runs_as === "Claude", "an agent's routine waits for your OK, and runs as that agent");
  check(q && q.post === "sess-a" && q.title === "Run “Nightly triage” daily at 22:00?" && q.preview === "Triage new issues." && /about 1 model run a day/.test(q.detail), "the OK is on its thread, with the prompt and how many model runs a day");
  await owner.post(`/api/questions/${q.id}/answer`, { value: "Turn it on" });
  d = await owner.get(`/api/routines/${triage}`);
  check(d.live_v === 1 && !d.runs.length && d.next && Date.parse(d.next) > Date.now(), "once OK'd, an agent routine waits for its time");
  const mine = await claude.get("/routines");
  check(mine.routines.some((x) => x.id === triage) && mine.routines.some((x) => x.id === deploy), "ab_routine_read lists the routines it wrote, and its thread's");

  // The same, as an agent calls it: ab_routine_write and ab_routine_read on agentbook's MCP server.
  const tool = async (name: string, args: object) => {
    const r = await fetch(`${URL}/api/mcp?proc=box-1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const j: Json = await r.json();
    return { text: j.result?.content?.[0]?.text || j.error?.message || "", error: !!j.result?.isError };
  };
  let t = await tool("ab_routine_write", { kind: "agent", name: "Weekly recap", prompt: "Recap the week's merged PRs.", schedule: "0 17 * * 5", test: true });
  check(/Test \(nothing saved\)/.test(t.text) && /Fridays at 17:00/.test(t.text) && /Recap the week's merged PRs/.test(t.text), "ab_routine_write tests an agent routine without a page, showing what each run gets");
  t = await tool("ab_routine_write", { kind: "agent", name: "Weekly recap", prompt: "Recap the week's merged PRs.", schedule: "0 17 * * 5", thread: "this" });
  check(!t.error && /Saved "Weekly recap" \(routine "weekly-recap"\) for its thread, Fridays at 17:00\. v1 waits for the person's OK/.test(t.text), "ab_routine_write saves one for its own thread, and says it waits for an OK");
  t = await tool("ab_routine_read", {});
  check(/weekly-recap/.test(t.text) && /nightly-triage/.test(t.text), "ab_routine_read without a page lists the agent's routines");
  t = await tool("ab_routine_read", { routine: "weekly-recap" });
  check(/"prompt": "Recap the week's merged PRs\."/.test(t.text) && /"waiting"/.test(t.text), "and one routine, with its prompt and the version waiting");

  // A code routine for the agent's own thread: its line goes there.
  r = await claude.post("/routines", { name: "Ping", thread: "this", schedule: "1m", code: 'export default async () => ({ widgets: [{ id: "x", data: {} }] })', test: true });
  check(r.status === 200 && !r.test.ok && /isn't for a page/.test(r.test.error), "a code routine that isn't for a page writes no widgets");
  r = await claude.post("/routines", { name: "Ping", thread: "this", schedule: "1m", code: 'export default async () => ({ summary: "pong" })' });
  const ping = r.id;
  check(r.status === 200 && r.waiting === 1 && r.thread === "sess-a", "an agent makes a code routine for its own thread, which waits for an OK");
  await owner.post(`/api/routines/${ping}/ok`, { v: 1, use: true });
  const line = await until(async () => (await owner.get("/api/sessions/sess-a")).updates?.find((u) => /↻ Ping: pong/.test(u.text)));
  check(!!line, "once OK'd it runs, and its line shows on the thread");
  t = await tool("ab_routine_write", { routine: ping, code: 'export default async () => ({ summary: "pong 2" })', summary: "Says pong 2" });
  check(!t.error && /^Saved "Ping"/.test(t.text) && /v2 waits for the person's OK, .*v1 keeps running until then\. Its test run worked: .* It said: pong 2/.test(t.text) && !/nothing saved/.test(t.text), "ab_routine_write saving new code says it saved it, with how its test went, not that nothing was saved");

  // For a page: a run starts from the page.
  const made = await claude.post("/pages", { title: "Inbox", widgets: [{ id: "n", type: "note", title: "Note", data: { text: "-" } }] });
  const other = await claude.post("/pages", { title: "Inbox archive", widgets: [{ id: "n", type: "note", title: "Note", data: { text: "-" } }] });
  r = await owner.post("/api/routines", { name: "Inbox notes", prompt: "Update the note with what's new.", links: [{ kind: "page", id: made.id }, { kind: "page", id: other.id }, { kind: "thread", id: "sess-a" }], schedule: "manual" });
  const inbox = r.id;
  check(r.status === 200 && r.links.filter((l) => l.kind === "page").length === 2 && r.links.some((l) => l.kind === "thread" && l.id === "sess-a") && !r.thread, "a routine links to several pages and threads at once, and still runs in a new thread");
  await owner.post(`/api/routines/${inbox}/run`);
  const pl = await until(async () => {
    const id = (await owner.get(`/api/routines/${inbox}`)).runs?.[0]?.lid;
    return id && (await stateOf(owner.get)).launches.find((l) => l.id === id);
  });
  check(pl && pl.page === made.id && /linked to the pages "Inbox" \(inbox\), "Inbox archive"/.test(pl.prompt) && /linked to the thread/.test(pl.prompt), "its run starts from its first page, told about every page and thread it's linked to");
  check((await owner.get(`/api/pages/${made.id}/routines`)).routines.some((x) => x.id === inbox) && (await owner.get(`/api/pages/${other.id}/routines`)).routines.some((x) => x.id === inbox), "and it's on each page's Routines tab");
  r = await owner.post(`/api/routines/${inbox}`, { links: [{ kind: "page", id: made.id }] });
  check(r.status === 200 && r.links.filter((l) => l.kind !== "agent").length === 1, "you change what it's linked to");

  // A prompt as long as a routine's can be still runs, its header and all; a longer one is refused, not cut.
  const long = `Refresh the numbers. ${"Read every source again. ".repeat(400)}`.slice(0, 7991) + " THE END.";
  r = await owner.post("/api/routines", { name: "Long refresh", prompt: long + "x", links: [{ kind: "page", id: made.id }], schedule: "manual" });
  check(r.status === 400 && /8,001 characters, over the 8,000/.test(r.error), "a routine's prompt over 8,000 characters is refused, saying how long it is");
  r = await owner.post("/api/routines", { name: "Long refresh", prompt: long, links: [{ kind: "page", id: made.id }], schedule: "manual" });
  const longId = r.id;
  check(r.status === 200 && (await owner.get(`/api/routines/${longId}`)).prompt === long, "one of 8,000 is kept whole");
  await owner.post(`/api/routines/${longId}/run`);
  const longCall = await until(() => starts().find((c) => c.args.some((a) => a.endsWith("THE END."))));
  // The machine has started it before the server has written the run down.
  d = await until(async () => {
    const x = await owner.get(`/api/routines/${longId}`);
    return x.runs?.length && x;
  });
  check(longCall && longCall.args.some((a) => /This is a run of the routine "Long refresh"/.test(a)) && d?.runs[0].ok, "and it runs, with the routine's header before it");
  await owner.post(`/api/routines/${longId}/remove`);

  // Off, on, removed; and they all survive a restart.
  await owner.post(`/api/routines/${digest}/on`, { on: false });
  check((await owner.get(`/api/routines/${digest}`)).next === null, "switched off, it has no next run");
  await sleep(400);
  await stop();
  await start();
  d = await owner.get(`/api/routines/${triage}`);
  st = await stateOf(owner.get);
  check(d.live_v === 1 && st.routines.filter((x) => !x.archived).length === 7 && st.routines.find((x) => x.id === longId)?.archived && st.routines.find((x) => x.id === digest)?.on === false, "routines and their runs survive a restart, an archived one too");
  await owner.post(`/api/routines/${deploy}/remove`);
  d = await owner.get(`/api/routines/${deploy}`);
  st = await stateOf(owner.get);
  check(d.status === 200 && d.archived?.by?.user === "herval" && d.next === null && !(await owner.get("/api/pages/" + made.id + "/routines")).routines.some((x) => x.id === deploy) && !(await claude.get("/routines")).routines.some((x) => x.id === deploy) && st.routines.find((x) => x.id === deploy)?.archived, "its owner removes one: it's archived, out of the lists but kept, with no next run");
  r = await owner.post(`/api/routines/${deploy}/run`);
  check(r.status === 409 && /archived\. Restore it first/.test(r.error), "an archived one doesn't run");
  const runsBefore = d.runs.length;
  r = await owner.post(`/api/routines/${deploy}/restore`);
  d = await owner.get(`/api/routines/${deploy}`);
  check(r.status === 200 && !d.archived && d.live_v === 2 && d.runs.length === runsBefore && d.prompt === "Is the deploy done? Check CI too.", "Restore puts it back as it was: its version and its runs");
  r = await owner.post(`/api/routines/${deploy}/restore`);
  check(r.status === 409 && /isn't archived/.test(r.error), "and one that isn't archived has nothing to restore");
  await owner.post(`/api/routines/${deploy}/remove`);

  // An agent removes a routine it wrote when you ask (ab_routine_write with remove), not one someone else wrote.
  t = await tool("ab_routine_write", { routine: digest, remove: true });
  check(t.error && /"Morning digest" isn't one you wrote \(@herval made it\), so you can't remove it\. herval does, on agentbook: .*#\/routines\/morning-digest, under "Remove it"/.test(t.text) && (await owner.get(`/api/routines/${digest}`)).status === 200, "an agent can't remove a routine you made, and says where you do");
  t = await tool("ab_routine_write", { remove: true });
  check(t.error && /Say which routine to remove/.test(t.text), "it has to say which routine");
  st = await stateOf(owner.get);
  const recapQ = st.questions.find((x) => x.routine?.rid === "weekly-recap" && !x.answered);
  t = await tool("ab_routine_write", { routine: "weekly-recap", remove: true });
  st = await stateOf(owner.get);
  d = await owner.get("/api/routines/weekly-recap");
  check(!t.error && /^Removed "Weekly recap" \(routine "weekly-recap"\): it's archived/.test(t.text) && /restore: true/.test(t.text) && d.status === 200 && d.archived?.by?.agent && !/weekly-recap/.test((await tool("ab_routine_read", {})).text), "it removes one it wrote: archived, and out of its list");
  check(recapQ && st.questions.find((x) => x.id === recapQ.id)?.answered, "and the OK it still asked for is answered");
  t = await tool("ab_routine_write", { routine: "weekly-recap", code: "x" });
  check(t.error && /is archived\. Put it back first/.test(t.text), "an archived one isn't changed");
  t = await tool("ab_routine_write", { routine: "weekly-recap", restore: true });
  d = await owner.get("/api/routines/weekly-recap");
  check(!t.error && /^Restored "Weekly recap" \(routine "weekly-recap"\), as it was: Fridays at 17:00/.test(t.text) && d.status === 200 && !d.archived && d.waiting?.v === 1, "it restores one it wrote when you ask, as it was, its version still waiting for an OK");
  r = await claude.post(`/pages/${made.id}/routines`, { name: "Inbox count", keeps: ["n"], schedule: "manual", code: 'export default async () => ({ widgets: [{ id: "n", data: { text: "3 new" } }] })' });
  const count = r.id;
  r = await claude.post(`/pages/${other.id}/routines`, { routine: count, remove: true });
  check(r.status === 404 && (await owner.get(`/api/routines/${count}`)).status === 200, "a page's routine isn't removed through another page");
  t = await tool("ab_routine_write", { page: made.id, routine: count, remove: true });
  check(!t.error && /^Removed "Inbox count" \(routine "inbox-count"\) from "inbox"/.test(t.text) && /The widgets it kept \(n\) stay as they are/.test(t.text) && (await owner.get(`/api/pages/${made.id}`)).widgets?.some((w) => w.id === "n"), "a page's code routine it wrote goes, and its widgets stay");
  r = await claude.post(`/pages/${made.id}/routines`, { name: "Inbox count 2", keeps: ["n"], schedule: "manual", code: 'export default async () => ({ widgets: [{ id: "n", data: { text: "4 new" } }] })' });
  check(r.status === 200, "another routine can keep its widget once it's archived");
  r = await owner.post(`/api/routines/${count}/restore`);
  check(r.status === 409 && /"Inbox count 2" keeps n now/.test(r.error), "and then it can't come back while that one keeps it");
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "heron", agent: "Codex", session_id: "sess-b", cwd: project } });
  r = await agent("box-2").post("/routines", { kind: "agent", name: "Codex digest", prompt: "Summarize the day.", schedule: "0 18 * * *" });
  const theirs = r.id;
  r = await claude.post("/routines", { routine: theirs, remove: true });
  check(r.status === 403 && /isn't one you wrote \(Codex made it\)/.test(r.error) && (await owner.get(`/api/routines/${theirs}`)).status === 200, "nor another agent's");

  // One deleted before removing archived (an old log's routine.remove) comes back archived on the next start,
  // rebuilt from the log with its versions, runs and memo.
  r = await owner.post("/api/routines", { name: "Old digest", prompt: "Digest.", schedule: "manual" });
  const old = r.id;
  await owner.post(`/api/routines/${old}/run`);
  await until(async () => (await owner.get(`/api/routines/${old}`)).runs?.length);
  await stop();
  {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(HOME, "storage.db"));
    const seq = (db.prepare("select max(seq) as n from events where scope = 'server'").get() as { n: number }).n + 1;
    const at = new Date().toISOString();
    db.prepare("insert into events (scope, seq, at, op) values ('server', ?, ?, ?)").run(seq, at, JSON.stringify({ t: "routine.remove", rid: old, seq, at }));
    db.close();
  }
  await start();
  await sleep(300);
  d = await owner.get(`/api/routines/${old}`);
  check(d.status === 200 && d.archived && !d.archived.by && d.live_v === 1 && d.runs.length === 1 && d.prompt === "Digest.", "a routine deleted before archiving existed comes back archived, rebuilt from the log");
  r = await owner.post(`/api/routines/${old}/restore`);
  check(r.status === 200 && !(await owner.get(`/api/routines/${old}`)).archived, "and it restores");
} finally {
  await stop().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
