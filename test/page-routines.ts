#!/usr/bin/env node
// Page routines: an agent writes code that keeps a page's widgets up to date, tests it, and saves it; it runs
// only once its owner OKs it, and every change waits for an OK while the version OK'd keeps running. It calls MCP
// tools (here a fake server, from Claude Code's config) and commands only within its reach, can't touch files,
// is stopped when it hangs, and writes only the widgets it keeps, quietly. It all survives a restart.
// Run: node test/page-routines.ts

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineDiff, scheduleFrom } from "../plugin/cli/routines.ts";
import { applyPage } from "../plugin/shared/pages.ts";
import type { State } from "../plugin/shared/types.ts";
import { parseToon, toolData } from "../plugin/cli/toon.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-routines-"));
// The machine shares the test's folders with its server, and starts as many posts as the test does (its gate).
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4800);
const MCP_PORT = PORT + 100;
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const CLAUDE_DIR = path.join(HOME, "claude");
fs.mkdirSync(CLAUDE_DIR);
// Claude Code's config, as a routine reads it: one HTTP MCP server, with a key in its headers.
fs.writeFileSync(path.join(CLAUDE_DIR, ".claude.json"), JSON.stringify({ mcpServers: { fake: { type: "http", url: `http://127.0.0.1:${MCP_PORT}/mcp`, headers: { "x-key": "${FAKE_MCP_KEY}" } }, local: { command: "some-stdio-server" } } }));
const env = { ...process.env, FAKE_MCP_KEY: "s3cret", AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: CLAUDE_DIR, AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200", AGENTBOOK_ROUTINES_TICK_MS: "250", AGENTBOOK_CLAUDE_ROUTINES: "0" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
// `extra`: what to show when it fails.
const check = (cond: unknown, label: string, extra: unknown = ""): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? `  [${extra}]` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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

// ---------- a fake MCP server: Streamable HTTP, answers in TOON, some of them over SSE ----------
const calls = [];
let p95 = 100;
const mcpServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.headers["x-key"] !== "s3cret") return res.writeHead(401).end("bad key");
  const msg = JSON.parse(body);
  if (msg.method === "initialize") {
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
  }
  if (!msg.id) return res.writeHead(202).end();
  if (req.headers["mcp-session-id"] !== "sess-1") return res.writeHead(400).end("no session");
  if (msg.method === "tools/list") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "stats", inputSchema: { type: "object" } }, { name: "broken", inputSchema: { type: "object" } }] } }));
  }
  calls.push({ name: msg.params.name, args: msg.params.arguments });
  const result =
    msg.params.name === "stats"
      ? { content: [{ type: "text", text: `service: ${msg.params.arguments.service}\ntimeseries[1]:\n  - buckets[2]{time,p95_ms,count}:\n      "2026-10-11T10:00:00Z",${p95 - 10},500\n      "2026-10-11T11:00:00Z",${p95},700` }] }
      : { content: [{ type: "text", text: "Datadog said 403" }], isError: true };
  // Answers as an SSE stream, as Streamable HTTP servers may.
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
});
await new Promise<void>((r) => mcpServer.listen(MCP_PORT, "127.0.0.1", r));

let server: Agentbook;
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
  const t = parseToon('window: 1h\nseries[2]: 1,2\nrows[2]{a,b}:\n  1,"x, y"\n  2,null\nnested:\n  ok: true');
  check(t.window === "1h" && t.series[1] === 2 && t.rows[0].b === "x, y" && t.rows[1].b === null && t.nested.ok === true, "TOON reads values, inline arrays, tables (quoted commas too) and nested objects");
  check(toolData('{"a":1}').a === 1 && toolData("just words") === null, "a tool's answer is read as JSON first, and plain words aren't data");
  check(scheduleFrom("30m").everyMs === 1800e3 && scheduleFrom({ every: "2h" }).everyMs === 7200e3 && scheduleFrom(90).everyMs === 90e3, "a schedule reads as minutes, hours or seconds");
  let threw = null;
  try {
    scheduleFrom("10s");
  } catch (e) {
    threw = e.message;
  }
  check(/once a minute/.test(threw || ""), "a routine runs at most once a minute");
  const d = lineDiff("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nD\ne\nf\ng\nh\ni");
  check(d.added === 2 && d.removed === 1 && d.lines.some((l) => l.t === "-" && l.text === "d") && d.lines.some((l) => l.t === "+" && l.text === "D"), "a line diff says what was taken out and added");
  // A routine's versions don't push out the page's own: its newest 48 stay, plus the last of each day.
  const state: Pick<State, "pages" | "page_versions"> = { pages: {}, page_versions: [] };
  applyPage(state, { t: "page.create", pid: "p", title: "P", by: { agent: "claude" }, widgets: [{ id: "m", type: "metric", title: "M", width: "quarter", stack: null, data: { value: 0 } }] }, "2026-10-01T00:00:00.000Z");
  const moved = state.pages.p.moved;
  for (let i = 1; i <= 80; i++) applyPage(state, { t: "page.write", pid: "p", by: { routine: "numbers", agent: "claude" }, quiet: true, widgets: [{ id: "m", type: "metric", title: "M", width: "quarter", stack: null, data: { value: i } }] }, new Date(Date.parse("2026-10-01T00:00:00Z") + i * 1800e3).toISOString());
  const kept = state.page_versions.filter((v) => v.by?.routine);
  check(kept.length >= 48 && kept.length < 55 && state.page_versions.some((v) => v.v === 1), "a routine keeps its newest 48 versions and the last of each day, and the page's own stay");
  check(state.pages.p.moved === moved && !(state.pages.p.recent || []).some((r) => r.by?.routine), "a routine's refresh doesn't move the page up the feed, or count as an update today");
}

// ---------- the server ----------
await start();
try {
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "lark", agent: "Codex", kind: "codex", session_id: "sess-b", cwd: project } });
  const claude = agent("box-1");
  const codex = agent("box-2");
  const made = await claude.post("/pages", { title: "Reliability: api", widgets: [{ id: "m_p95", type: "metric", title: "p95", data: { value: 1, unit: "ms" } }, { id: "c_hourly", type: "chart", title: "Hourly", data: { x: ["a"], series: [{ name: "p95", values: [1] }] } }, { id: "note", type: "note", title: "What needs attention", data: { text: "All fine." } }] });
  const pid = made.id;
  check(made.created, "an agent makes a page");

  const NUMBERS = `export default async function (ctx) {
  const r = await ctx.tool("fake", "stats", { service: "api" });
  const b = r.data.timeseries[0].buckets;
  ctx.memo.runs = (ctx.memo.runs || 0) + 1;
  console.log("buckets", b.length);
  return { widgets: [{ id: "m_p95", data: { value: b.at(-1).p95_ms } }, { id: "c_hourly", data: { x: b.map((x) => x.time.slice(11, 13) + "h"), series: [{ name: "p95", values: b.map((x) => x.p95_ms) }] } }], summary: "p95 " + b.at(-1).p95_ms + " ms, run " + ctx.memo.runs };
}`;
  const base = { name: "Numbers", schedule: "1m", keeps: ["m_p95", "c_hourly"], reach: { tools: ["fake/stats"] }, about: "Latency, from the fake server." };

  let r = await claude.post(`/pages/${pid}/routines`, { ...base, code: NUMBERS, test: true });
  check(r.status === 200 && r.test.ok && r.test.changes.some((c) => c.id === "m_p95" && c.to === "100 ms") && /buckets 2/.test(r.test.log), "a test run calls the tool, reads its TOON, and says what it would change, with its log");
  check(calls.length === 1 && calls[0].args.service === "api", "the tool got the arguments, with the key from Claude Code's config");
  check(!(await owner.get(`/api/pages/${pid}/routines`)).routines.length && (await owner.get(`/api/pages/${pid}`)).version === 1, "a test saves nothing and writes nothing");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, code: NUMBERS.replace('"fake", "stats"', '"fake", "broken"'), test: true });
  check(!r.test.ok && /not in its reach/.test(r.test.error), "a tool that isn't in its reach can't be called");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, reach: { tools: ["fake/broken"] }, code: NUMBERS.replace('"fake", "stats"', '"fake", "broken"'), test: true });
  check(!r.test.ok && /Datadog said 403/.test(r.test.error), "a tool that fails fails the run, saying what it said");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, reach: { tools: ["local/x"] }, code: 'export default async (ctx) => { await ctx.tool("local", "x"); return { widgets: [] }; }', test: true });
  check(!r.test.ok && /stdio MCP server/.test(r.test.error), "a stdio MCP server is out of reach, and it says why");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, code: 'import fs from "node:fs"; export default async () => { fs.readFileSync(process.env.HOME + "/.claude.json"); return { widgets: [] }; }', test: true });
  check(!r.test.ok && /ACCESS_DENIED|permission/i.test(r.test.error), "its code can't read files, like Claude Code's config");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, code: 'export default async () => { const { execSync } = await import("node:child_process"); execSync("echo hi"); return { widgets: [] }; }', test: true });
  check(!r.test.ok && /ACCESS_DENIED|permission/i.test(r.test.error), "its code can't run commands by itself");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, reach: { commands: ["echo"] }, code: 'export default async (ctx) => { const o = await ctx.sh("echo", ["hello"]); return { widgets: [{ id: "m_p95", data: { value: o.stdout.trim() } }] }; }', test: true });
  check(r.test.ok && r.test.changes.some((c) => c.id === "m_p95" && c.to === "hello ms"), "a command in its reach runs, through ctx.sh");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, code: 'export default async () => ({ widgets: [{ id: "note", data: { text: "x" } }] })', test: true });
  check(!r.test.ok && /doesn't keep/.test(r.test.error), "writing a widget it doesn't keep fails the run");
  r = await claude.post(`/pages/${pid}/routines`, { ...base, timeout: 5, code: "export default () => new Promise(() => {})", test: true });
  check(!r.test.ok && /longer than 5 s/.test(r.test.error), "a run that hangs is stopped at its timeout");

  // Saved: it waits for the owner's OK, asked on the agent's post.
  r = await claude.post(`/pages/${pid}/routines`, { ...base, code: NUMBERS, summary: "First version" });
  const rid = r.id;
  check(r.status === 200 && rid === "numbers" && r.waiting === 1 && r.live_v === 0 && /Its test run worked/.test(r.test_words), "saving a routine makes v1, which waits for an OK, with its test run");
  let q = (await stateOf(owner.get)).questions.find((x) => x.routine?.rid === rid && !x.answered);
  check(q && q.post === "sess-a" && q.kind === "approve" && q.options[0].label === "Turn it on" && /fake: stats/.test(q.detail) && /ctx\.tool/.test(q.preview), "the OK is a question on the agent's post, with what it reaches and its code");
  await sleep(800);
  check((await owner.get(`/api/pages/${pid}`)).version === 1, "nothing runs before the OK");
  check((await codex.post(`/pages/${pid}/routines`, { ...base, name: "Other", code: NUMBERS })).status === 403, "an agent that doesn't contribute to the page can't add a routine");
  check((await claude.post(`/pages/${pid}/routines`, { ...base, name: "Twin", code: NUMBERS })).status === 400, "two routines can't keep the same widget");

  await owner.post(`/api/questions/${q.id}/answer`, { value: "Turn it on" });
  let page = await until(async () => {
    const p = await owner.get(`/api/pages/${pid}`);
    return p.version > 1 && p;
  });
  check(page && page.widgets.find((w) => w.id === "m_p95").data.value === 100 && page.last.by.routine === rid && page.last.summary === "p95 100 ms, run 1", "once OK'd, it runs right away and writes its widgets as a version");
  let d = await owner.get(`/api/pages/${pid}/routines/${rid}`);
  check(d.live_v === 1 && d.versions[0].ok?.by?.user === "herval" && d.runs[0].ok && d.runs[0].v === 1 && d.runs[0].changed.includes("m_p95"), "the routine says who OK'd v1, and its run");
  const st = (await stateOf(owner.get)).pages.find((p) => p.id === pid);
  check(st.routines[0].id === rid && st.routines[0].on && st.routines[0].keeps.length === 2 && !st.recent?.some((x) => x.by?.routine), "the page carries its routines in brief, and the refresh is quiet");

  // Run now, with its memo carried over.
  p95 = 120;
  check((await owner.post(`/api/pages/${pid}/routines/${rid}/run`)).started, "Run now starts it");
  page = await until(async () => {
    const p = await owner.get(`/api/pages/${pid}`);
    return p.widgets.find((w) => w.id === "m_p95").data.value === 120 && p;
  });
  check(page && page.last.summary === "p95 120 ms, run 2", "its memo carries over from one run to the next");

  // A change waits for an OK, and the version OK'd keeps running.
  const V2 = NUMBERS.replace('"p95 "', '"p95 is "');
  r = await claude.post(`/pages/${pid}/routines`, { routine: rid, code: V2, summary: "Says 'is'" });
  check(r.waiting === 2 && r.live_v === 1, "a change to its code makes v2, waiting, while v1 runs");
  const nowhere = await claude.post("/routines", { routine: rid, code: V2 });
  check(nowhere.status === 404 && new RegExp(`is on the page ".*": send page: "${pid}"`).test(nowhere.error || ""), `changed without its page, it says which page it's on (${nowhere.error})`);
  q = (await stateOf(owner.get)).questions.find((x) => x.routine?.rid === rid && !x.answered);
  check(q && q.options[0].label === "Use v2" && q.options[1].label === "Keep v1" && /\+.*p95 is/.test(q.preview), "its OK shows the change as a diff, with Use v2 and Keep v1");
  p95 = 130;
  await owner.post(`/api/pages/${pid}/routines/${rid}/run`);
  page = await until(async () => {
    const p = await owner.get(`/api/pages/${pid}`);
    return p.widgets.find((w) => w.id === "m_p95").data.value === 130 && p;
  });
  check(page && /^p95 130/.test(page.last.summary), "until it's OK'd, the version OK'd before keeps running");
  r = await owner.post(`/api/pages/${pid}/routines/${rid}/ok`, { v: 2, use: false });
  d = await owner.get(`/api/pages/${pid}/routines/${rid}`);
  check(r.status === 200 && d.live_v === 1 && d.versions.find((c) => c.v === 2).passed === "kept" && !d.change, "Keep v1 passes v2 over");
  check((await stateOf(owner.get)).questions.find((x) => x.id === q.id)?.answered, "keeping it from the page answers its question too");

  // A change that writes a widget it doesn't keep: OK'd, its runs fail, and the page is left alone.
  await claude.post(`/pages/${pid}/routines`, { routine: rid, code: 'export default async () => ({ widgets: [{ id: "note", data: { text: "oops" } }] })' });
  await owner.post(`/api/pages/${pid}/routines/${rid}/ok`, { v: 3, use: true });
  d = await until(async () => {
    const x = await owner.get(`/api/pages/${pid}/routines/${rid}`);
    return x.runs[0]?.v === 3 && x;
  });
  check(d && !d.runs[0].ok && /doesn't keep/.test(d.runs[0].error) && d.fails === 1 && (await owner.get(`/api/pages/${pid}`)).widgets.find((w) => w.id === "note").data.text === "All fine.", "a run that fails leaves the page as it was");
  await owner.post(`/api/pages/${pid}/routines/${rid}/run`);
  d = await until(async () => {
    const x = await owner.get(`/api/pages/${pid}/routines/${rid}`);
    return x.fails === 2 && x;
  });
  check(d && d.stale, "two failures in a row make its widgets stale");

  // Asked to fix it from its page: the routine keeps which thread that is, so its page shows how it's going, and
  // what stopped it (an expired login).
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-fix");
  const fixing = await owner.post("/api/launch", { prompt: `Fix the routine "${rid}"`, agent: "claude", page: pid, root: project });
  check((await owner.post(`/api/routines/${rid}/fix`, {})).status === 400, "asking it to fix it names the launch it went out as");
  await owner.post(`/api/routines/${rid}/fix`, { launch: fixing.lid, agent: "claude" });
  await req("POST", "/api/hello", { body: { proc: "box-9", label: "wren", agent: "Claude", session_id: "sess-fix", cwd: project, launch: fixing.lid } });
  d = await until(async () => {
    const x = await owner.get(`/api/routines/${rid}`);
    return x.fix?.post && x;
  });
  const side = await owner.get("/api/q/side");
  check(d && d.fix.lid === fixing.lid && d.fix.agent === "claude" && !!side.records?.[`thread:${d.fix.post}`] && side.records[`routine:${rid}`]?.fix?.post === d.fix.post, `asked to fix it, it keeps the thread that is, and the page has its row (${fixing.status} ${fixing.error || ""})`);

  // A thread on it from its page's box (routine-threads.ts): it goes as a thread for its page, so its agent can change
  // it, told which routine and that page goes with ab_routine_write.
  const onIt = await owner.post("/api/launch", { prompt: "Make it run hourly", agent: "claude", on_my_routine: rid });
  const onItCall = await until(() => {
    try {
      return fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.args.some((a) => /Make it run hourly/.test(a)));
    } catch {
      return null;
    }
  });
  const onItSaid = onItCall?.args.find((a) => /Make it run hourly/.test(a)) || "";
  const onItL = (await stateOf(owner.get)).launches.find((l) => l.id === onIt.lid);
  check(onIt.status === 200 && onItSaid.includes(`ab_routine_write with routine "${rid}" and page "${pid}" changes it`) && (onItL?.page === pid || onItL?.post), "a thread on a page's routine goes as a thread for its page, its agent told to send page with ab_routine_write", onItSaid);
  check((await owner.get(`/api/routines/${rid}`)).threads?.some((x) => x.lid === onIt.lid), "and the routine's page lists it");

  const read = await claude.get(`/pages/${pid}`);
  check(/Numbers/.test(read.widgets.find((w) => w.id === "m_p95").kept_by || "") && !read.widgets.find((w) => w.id === "note").kept_by, "ab_page_read says which widgets a routine keeps");
  const one = await claude.get(`/pages/${pid}/routines?routine=${rid}`);
  check(one.code_v === 3 && /oops/.test(one.code) && one.runs.length && /doesn't keep/.test(one.runs[0].error), "ab_routine_read gives its code and its last runs, with their errors");

  // Live: it runs while the page is open, with what's picked on it, and its answer isn't a version.
  check(JSON.stringify(scheduleFrom("live 15s")) === '{"kind":"live","everyMs":15000}' && JSON.stringify(scheduleFrom({ live: true })) === '{"kind":"live","everyMs":30000}', "a live schedule says how often while its page is open");
  await claude.post("/pages", { page: pid, widgets: [{ id: "m_live", type: "metric", title: "Live", data: { value: 0 } }, { id: "when", type: "filter", title: "Period", data: { kind: "time" } }] });
  const LIVE = 'export default async (ctx) => { await ctx.tool("fake", "stats", { service: ctx.filters.service || "all" }); return { widgets: [{ id: "m_live", data: { value: ctx.filters.service || "all", unit: ctx.params.q || "", change: String(ctx.live), vs: ctx.ranges.when ? "ranged" : "" } }] }; }';
  check((await claude.post(`/pages/${pid}/routines`, { kind: "agent", name: "Live agent", schedule: "live", prompt: "x" })).status === 400, "only code for a page can be live");
  const lv = await claude.post(`/pages/${pid}/routines`, { name: "Live", schedule: "live 15s", keeps: ["m_live"], reach: { tools: ["fake/stats"] }, code: LIVE });
  const lq = (await stateOf(owner.get)).questions.find((x) => x.routine?.rid === lv.id && !x.answered);
  await owner.post(`/api/questions/${lq.id}/answer`, { value: "Turn it on" });
  const before = (await owner.get(`/api/pages/${pid}`)).version;
  await sleep(1200);
  check((await owner.get(`/api/pages/${pid}`)).version === before && !(await owner.get(`/api/pages/${pid}/routines/${lv.id}`)).runs?.length, "OK'd, a live routine doesn't run on the clock");
  const calls0 = calls.length;
  const l1 = await owner.post(`/api/pages/${pid}/live`, { filters: { service: "erp-sync", when: "7d", "no good!": "x" } });
  const r1 = l1.routines?.find((x) => x.id === lv.id);
  const d1 = r1?.widgets?.find((w) => w.id === "m_live")?.data;
  check(l1.routines?.length === 1 && r1.ok && d1?.value === "erp-sync" && d1.change === "true" && d1.vs === "ranged" && r1.every === 15000 && calls.length === calls0 + 1, "with the page open, it runs with the filters picked as its inputs, a time filter's period as dates, and only the live ones run");
  const l2 = await owner.post(`/api/pages/${pid}/live`, { filters: { service: "erp-sync", when: "7d" } });
  check(l2.routines?.[0]?.at === r1.at && calls.length === calls0 + 1, "asked again within its interval, the same answer comes back without asking again");
  const l3 = await owner.post(`/api/pages/${pid}/live`, { filters: { service: "api" } });
  check(l3.routines?.[0]?.widgets?.[0]?.data?.value === "api" && l3.routines[0].widgets[0].data.vs === "", "other filters are a run of their own");
  const l4 = await owner.post(`/api/pages/${pid}/live`, { widget: "m_live", params: { q: "ms" } });
  check(l4.routines?.[0]?.widgets?.[0]?.data?.unit === "ms", "a widget it keeps asks it with params of its own");
  check((await owner.post(`/api/pages/${pid}/live`, { widget: "m_live", params: { q: "x".repeat(5000) } })).status === 400, "and not too much of them");
  check((await owner.get(`/api/pages/${pid}`)).version === before, "none of that is a version of the page");
  check((await req("POST", `/api/pages/${pid}/live`, { body: {} })).status === 401, "signed out asks nothing");
  await owner.post(`/api/pages/${pid}/routines/${lv.id}/remove`);
  check(!(await owner.post(`/api/pages/${pid}/live`, {})).routines?.length, "removed, nothing runs live");

  // Off: it doesn't run on its schedule.
  await owner.post(`/api/pages/${pid}/routines/${rid}/on`, { on: false });
  check((await stateOf(owner.get)).pages.find((p) => p.id === pid).routines[0].on === false, "its owner switches it off");

  // It all comes back after a restart.
  await sleep(500);
  await stop();
  await start();
  d = await owner.get(`/api/pages/${pid}/routines/${rid}`);
  check(d.status === 200 && d.versions.length === 3 && d.runs.length >= 4 && d.on === false && d.live_v === 3 && d.fix?.lid === fixing.lid, "routines, their versions, runs and fix survive a restart");

  await owner.post(`/api/pages/${pid}/routines/${rid}/remove`);
  check(!(await owner.get(`/api/pages/${pid}/routines`)).routines.length, "its owner removes a routine");
} finally {
  await stop().catch(() => {});
  mcpServer.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
