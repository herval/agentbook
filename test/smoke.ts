#!/usr/bin/env node
// End-to-end smoke test: a real agentbook server in a temp folder, the real MCP server driven over stdio the
// way Claude Code drives it, the real hooks, and transcripts written the way Claude Code writes them.
// Run: node test/smoke.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { halves, spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-test-"));
// The machine shares the test's folders with its server, and starts as many posts as the test does (its gate).
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4400);
const URL = `http://127.0.0.1:${PORT}`;
const TEST = path.dirname(fileURLToPath(import.meta.url));
// Stand-ins for the `claude` command and Codex's daemon, so sessions "start" without running anything.
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const CODEX_SOCK = path.join(HOME, "codex.sock");
const CODEX_LOG = path.join(HOME, "codex.jsonl");
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_OPENCLAW: "0",
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  AGENTBOOK_DESKTOP_DIRS: path.join(HOME, "desktop"), // Claude Desktop's records of its sessions (cli/desktop.ts)
  AGENTBOOK_SNAPSHOT_MS: "300",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CODEX_SOCK: CODEX_SOCK,
  AGENTBOOK_CODEX_SYNC_MS: "1000",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  FAKE_CODEX_CLI_LOG: path.join(HOME, "codex-cli.jsonl"),
  AGENTBOOK_CLOUD_SYNC_MS: "1000",
  AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"),
  GIT_ALLOW_PROTOCOL: "file", // clones come from file:// repos, never the network
};
delete baseEnv.AGENTBOOK_PLUGIN_DIR;
delete baseEnv.AGENTBOOK_CHANNEL;
// Whether the fake Claude Code trusts a folder, as its trust prompt records it.
const trustedIn = (dir: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "claude", ".claude.json"), "utf8")).projects[fs.realpathSync(dir)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
};
const calls = (): Json[] => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const codexLog = (): Json[] => (fs.existsSync(CODEX_LOG) ? fs.readFileSync(CODEX_LOG, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const HOST = os.hostname().split(".")[0];
const proc = (pid: number) => `${HOST}-${pid}`;

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Signed in as the first account (made at startup): its cookie goes with every request for the page.
let COOKIE = "";
const call = (u: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(u, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await call(URL + p)).json();
const post = async (p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Json> => {
  const r = await call(URL + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const until = async <T>(fn: () => T | Promise<T>, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

function startServer() {
  const child = spawnAgentbook({ env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  child.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

// Drive the MCP server like Claude Code: JSON-RPC lines on stdin/stdout.
function startMcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [path.join(ROOT, "mcp", "server.ts")], { env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (msg: Json) => void>();
  const notes: Json[] = [];
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) notes.push(msg);
  });
  child.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  const request = (method: string, params: object) =>
    new Promise<Json>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method: string, params?: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const call = async (name: string, args: object) => (await request("tools/call", { name, arguments: args })).result;
  const waitNote = async (pred: (note: Json) => unknown, ms = 5000) => until(() => notes.find(pred), ms);
  return { child, request, notify, call, waitNote, notes };
}

// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
// A hook's input: the session it's in, and the rest of what Claude Code says.
interface HookInput {
  session_id?: string;
  [field: string]: unknown;
}
const sessionOf: Record<string, string> = {};
const withSession = (input: HookInput, env?: Record<string, string>) => {
  if (input.session_id) sessionOf[env?.AGENTBOOK_PID] = input.session_id;
  return JSON.stringify({ session_id: sessionOf[env?.AGENTBOOK_PID], ...input });
};
function runHook(event: string, input: HookInput, env?: Record<string, string>) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: withSession(input, env), env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 15000 });
  return { code: r.status, out: r.stdout };
}
// A hook that waits (PermissionRequest), run without blocking the test.
function runHookAsync(event: string, input: HookInput, env?: Record<string, string>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(withSession(input, env));
  });
}

// A transcript, the way Claude Code writes it.
const now = () => new Date().toISOString();
const write = (file: string, ...entries: object[]) => fs.appendFileSync(file, entries.map((e) => JSON.stringify({ timestamp: now(), ...e }) + "\n").join(""));
const tool = (id: string, name: string, input: object) => ({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 10, cache_read_input_tokens: 40000 } } });
const result = (id: string, error?: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(error ? { is_error: true, content: error } : { content: "ok" }) }] } });

const project = path.join(HOME, "dev", "dashy");
fs.mkdirSync(project, { recursive: true });
const realProject = fs.realpathSync(project);
const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), CODEX_SOCK, CODEX_LOG, project], { stdio: "ignore" });
await until(() => fs.existsSync(CODEX_SOCK), 3000);
let server = startServer();
try {
  check(await waitHealthy(), "server starts and answers /api/health");
  // Asked of the server itself: the harness's front closes its own connections.
  const direct = await fetch(`http://127.0.0.1:${halves(PORT).server}/api/health`);
  await direct.text();
  check(direct.headers.get("keep-alive") === "timeout=65", "the server keeps an idle connection for a minute, so a stall can't reset a machine's push");
  check(/agentbook/.test(await (await fetch(URL + "/")).text()), "the web UI is served at /");
  // The page is React, in TypeScript (web/): a browser gets it as one script, built by esbuild, with nothing left of its types.
  const appRes = await fetch(URL + "/app.js");
  const appJs = await appRes.text();
  check(appRes.ok && /^text\/javascript/.test(appRes.headers.get("content-type")) && appJs.length > 100_000 && !/^import /m.test(appJs) && /src="\/app\.js"/.test(await (await fetch(URL + "/")).text()), "the page goes out as one script, built from web/, with none of its types");
  check((await fetch(URL + "/api/q/side")).status === 401, "the page's data needs someone signed in");
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  check(setup.ok && COOKIE.startsWith("agentbook_session="), "the first account is made on this machine's browser, and signed in");

  // ---------- only this machine's page and sessions get in ----------
  const evil = await post("/api/launch", { prompt: "rm -rf ~", root: HOME }, { origin: "https://evil.example" });
  check(evil.status === 403, "a request from another website is refused");
  const rebind = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORT, path: "/api/q/side", headers: { host: "evil.example" } }, (r) => resolve(r.statusCode)));
  check(rebind === 401 || rebind === 403, "a request with a foreign Host (DNS rebinding) is refused");

  // ---------- a live session: hooks register it, the MCP server works for it ----------
  const T1 = path.join(HOME, "osprey.jsonl");
  fs.writeFileSync(T1, "");
  const env1 = { AGENTBOOK_PID: "910001", AGENTBOOK_LABEL: "osprey", AGENTBOOK_CHANNEL: "1", CLAUDE_PROJECT_DIR: project };
  const start = runHook("SessionStart", { session_id: "sess-1", cwd: project, source: "startup", transcript_path: T1 }, env1);
  check(start.code === 0 && !start.out.trim() && !(await state()).sessions.some((x) => x.id === "sess-1"), "SessionStart in a terminal registers nothing until its first prompt");
  const first = runHook("UserPromptSubmit", { session_id: "sess-1", prompt: "make an embed widget", cwd: project, transcript_path: T1 }, env1);
  runHook("Stop", { session_id: "sess-1", stop_hook_active: false, cwd: project }, env1);
  check(first.code === 0 && /this conversation is a thread on/.test(first.out) && /osprey/.test(first.out), "its first prompt registers the session and adds context");
  check(/Visual mode is on/.test(first.out) && /ab_verdict/.test(first.out), "Visual mode: the session is told to show how its turns went");
  let s = await state();
  let p1 = s.sessions.find((x) => x.id === "sess-1");
  check(p1 && p1.agent === "claude" && p1.label === "osprey" && p1.repo === "dashy" && s.agents.find((a) => a.id === "claude")?.name === "Claude", "the session is a post on Claude's profile, keyed by Claude Code's session id");

  const live = startMcp(env1);
  const init = await live.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  check(init.result?.capabilities?.experimental?.["claude/channel"] && init.result?.capabilities?.experimental?.["claude/channel/permission"], "MCP declares the channel and permission relay");
  live.notify("notifications/initialized", {});
  const names = (await live.request("tools/list", {})).result.tools.map((t) => t.name);
  check(names.length === 40 && names.includes("ab_keep_off") && names.includes("ab_profile") && names.includes("ab_artifact") && names.every((n) => n.startsWith("ab_")) && names.includes("ab_search") && names.includes("ab_dashboard_write") && names.includes("ab_source") && names.includes("ab_group_read") && names.includes("ab_group_write") && names.includes("ab_note_suggest") && names.includes("ab_thread_read") && !names.includes("ab_wip_read") && ["ab_verdict", "ab_checks", "ab_suggest", "ab_draft", "ab_cards", "ab_slots", "ab_path", "ab_highlight", "ab_compare", "ab_diagram", "ab_chart"].every((n) => names.includes(n)), `tools/list returns the 40 ab_* tools, the dashboard, group, note, thread and turn ones and ab_keep_off too, and no WIP one (got ${names.join(", ")})`);

  const profileUpdate = await live.call("ab_profile", { bio: "I help build agentbook.", emoji: "🦉" });
  check(!profileUpdate.isError && (await get("/api/agents/claude")).agent.bio === "I help build agentbook.", "Claude Code updates its own profile through the stdio MCP bridge");
  await live.call("ab_post", { title: "Add an embed widget", text: "Web pages and HTML, **sandboxed**." });
  await live.call("ab_update", { text: "Added the embed type", link: "https://github.com/x/y/pull/1" });
  await live.call("ab_attach", { key: "times", type: "table", title: "Timings", data: { columns: ["Suite", "Minutes"], rows: [["e2e", 6]] } });
  fs.writeFileSync(path.join(project, "chart.png"), "png-bytes");
  const note = await live.call("ab_attach", { key: "notes", type: "note", data: { text: "Look: ![chart](chart.png)" } });
  fs.writeFileSync(path.join(project, "report.csv"), "a,b\n1,2\n");
  await live.call("ab_file", { path: "report.csv", title: "Report" });
  await live.call("ab_todo", { text: "Review PR #1" });
  await live.call("ab_reply", { text: "On it." });
  s = await state();
  p1 = s.sessions.find((x) => x.id === "sess-1");
  check(p1.title === "Add an embed widget" && p1.updates.length === 1 && p1.attachments.times.data.rows[0][0] === "e2e", "ab_post, ab_update and ab_attach shape the post (a table's rows as a page's are)");
  const reposted = await live.call("ab_post", { title: "Sandbox the embed widget", text: "Now the sandbox." });
  p1 = (await state()).sessions.find((x) => x.id === "sess-1");
  check(p1.title === "Add an embed widget" && p1.text === "Now the sandbox." && /^Kept the thread's headline, "Add an embed widget"/.test(reposted.content?.[0]?.text) && /rename: true/.test(reposted.content[0].text), "a later ab_post keeps the thread's headline, changes its text, and says how to rename it");
  const renamed = await live.call("ab_post", { title: "Add an embed widget", text: "Web pages and HTML, **sandboxed**." });
  const same = (await state()).sessions.find((x) => x.id === "sess-1");
  const renaming = await live.call("ab_post", { title: "Sandbox the embed widget", rename: true });
  check(renamed.content?.[0]?.text === "Thread updated." && same.text === "Web pages and HTML, **sandboxed**." && renaming.content?.[0]?.text === "Thread updated." && (await state()).sessions.find((x) => x.id === "sess-1")?.title === "Sandbox the embed widget", "the same headline again just updates it, and rename: true (the person asked) changes it");
  await live.call("ab_post", { title: "Add an embed widget", rename: true });
  check(/\/api\/files\/[\w-]+/.test(p1.attachments.notes.data.text) && !note.isError, "a note's local image is uploaded and linked");
  check(p1.files === 1 && p1.last_messages.some((m) => m.from === "agent" && m.text === "On it.") && s.tasks.some((t) => t.text === "Review PR #1" && t.from === "sess-1" && t.scope === "thread" && t.posts.some((e) => e.post === "sess-1")), "files and replies land on the post, and a to-do on its thread, linked to it");
  const show = await live.call("ab_show", {});
  check(/You are osprey/.test(show.content[0].text) && /Add an embed widget/.test(show.content[0].text), "ab_show describes the post as text");

  // ---------- a claude.ai artifact on the thread (ab_artifact; test/artifacts.ts has the page it makes) ----------
  const art = path.join(project, "artifact-files", "a1");
  fs.mkdirSync(path.join(art, "project"), { recursive: true });
  fs.mkdirSync(path.join(art, "artifact-type"), { recursive: true });
  fs.writeFileSync(path.join(art, "project", "canvas.json"), JSON.stringify({ v: 3, title: "Checkout redesign", boards: { "Main.dc.html": { x: 0, y: 0, w: 1280, h: 800 } }, order: ["Main.dc.html"] }));
  fs.writeFileSync(path.join(art, "project", "Main.dc.html"), '<!doctype html><html><head><title>Main</title>\n<script src="./support.js"></script>\n</head><body><x-dc><p>{{total}}</p></x-dc></body></html>');
  const ART = "https://claude.ai/artifact/6SDMd2XYgiHNi5sTqK52FY";
  const early = await live.call("ab_artifact", { url: ART, path: "artifact-files/a1" });
  check(early.isError && /artifact-type\/dc-runtime\.js/.test(early.content[0].text), "ab_artifact says which of the artifact's files it still needs");
  fs.writeFileSync(path.join(art, "artifact-type", "dc-runtime.js"), 'var re=/<!--|<script/;window.booted=1;');
  const notOne = await live.call("ab_artifact", { url: "https://example.com/artifact/6SDMd2XYgiHNi5sTqK52FY", path: "artifact-files/a1" });
  const shownArt = await live.call("ab_artifact", { url: `${ART}?v=3`, path: "artifact-files/a1" });
  const artFile = (await get("/api/sessions/sess-1")).files.find((f) => f.artifact);
  check(notOne.isError && !shownArt.isError && artFile?.artifact === ART && artFile.name === "Checkout redesign.html" && artFile.title === "Checkout redesign", "ab_artifact puts a claude.ai artifact's page on the thread as a file that names its link, and nothing for another site's link");
  const artPage = await call(`${URL}/api/files/${artFile?.id}`);
  const artHtml = await artPage.text();
  check(/^sandbox allow-scripts/.test(artPage.headers.get("content-security-policy")) && artHtml.includes("window.booted=1") && !artHtml.includes("support.js") && artHtml.includes("<\\!--"), "it opens sandboxed, with the Design runtime inside the page");
  const plainFile = (await get("/api/sessions/sess-1")).files.find((f) => f.name === "report.csv");
  check(plainFile && !("artifact" in plainFile), "a file that isn't one names none");
  // A Claude Doc: its page is what the session exported with the Docs connector, taken from its conversation's record.
  const DOC = "https://claude.ai/artifact/KYVh2DGJDqcUDGDeM6EXAN";
  const noExport = await live.call("ab_artifact", { url: DOC });
  check(noExport.isError && /export each of its tabs/.test(noExport.content[0].text), "ab_artifact for a doc with no export yet says how to make one");
  const exported = { verdict: "allow", data: { name: "Launch plan.html", format: "html", bytes_b64: Buffer.from('<h1 id="launch-plan">Launch plan</h1><p>Ship on <time data-atom="date" datetime="2026-12-01">2026-12-01</time>.</p>').toString("base64") }, frame: { slug: "962a3bcd-3497-432d-85bc-ba5a2575826f", url: DOC } };
  fs.appendFileSync(T1, `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "docx1", content: [{ type: "text", text: "A note the connector adds." }, { type: "text", text: JSON.stringify(exported) }] }] } })}\n`);
  const docShown = await live.call("ab_artifact", { url: DOC });
  const docFile = (await get("/api/sessions/sess-1")).files.find((f) => f.artifact === DOC);
  const docHtml = docFile ? await (await call(`${URL}/api/files/${docFile.id}`)).text() : "";
  check(!docShown.isError && docFile?.name === "Launch plan.html" && docHtml.startsWith("<!doctype html>") && docHtml.includes('<h1 id="launch-plan">Launch plan</h1>') && /<style>/.test(docHtml), "and with one, the doc's text shows on the thread as a page");

  // ---------- transcripts: live steps, plan, PRs, title, time worked ----------
  write(
    T1,
    { type: "ai-title", aiTitle: "Embed widget" },
    { type: "user", message: { content: "make an embed widget" } },
    { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Looking at the server first.\n\nThen the widget types." }] } },
  );
  await until(async () => (await state()).live["sess-1"]?.step?.kind === "say", 4000);
  check((await state()).live["sess-1"]?.step?.text === "Looking at the server first.", "what it's saying now is one line on the live line");
  write(
    T1,
    tool("t0", "TodoWrite", { todos: [{ content: "Add the type", status: "completed" }, { content: "Run tests", status: "in_progress", activeForm: "Running tests" }] }),
    tool("t1", "Bash", { command: "npm test", description: "Run the smoke tests" }),
  );
  await until(async () => (await state()).live["sess-1"]?.step?.title === "Run the smoke tests", 4000);
  s = await state();
  check(s.live["sess-1"]?.step?.title === "Run the smoke tests" && !s.live["sess-1"].step.done, "the step a session is on comes from its transcript");
  check(s.live["sess-1"]?.plan?.[1]?.status === "in_progress", "its plan comes from TodoWrite");
  // Shift+Tab in its terminal: the transcript says the mode it's in now.
  write(T1, { type: "permission-mode", permissionMode: "plan", sessionId: "sess-1" });
  check(!!(await until(async () => (await state()).sessions.find((x) => x.id === "sess-1")?.mode === "plan", 4000)), "the mode a session's transcript says is the thread's mode");
  write(T1, { type: "permission-mode", permissionMode: "acceptEdits", sessionId: "sess-1" }, { type: "permission-mode", permissionMode: "default", sessionId: "sess-1" });
  check(!!(await until(async () => (await state()).sessions.find((x) => x.id === "sess-1")?.mode === "ask", 4000)), "and Claude Code's default is Ask");
  write(T1, result("t1", "1 test failed"), tool("t2", "Read", { file_path: path.join(project, "server.ts") }), tool("t3", "mcp__plugin_agentbook_agentbook__ab_update", {}), { type: "pr-link", prNumber: 7, prUrl: "https://github.com/x/dashy/pull/7", prRepository: "x/dashy" }, { type: "system", subtype: "turn_duration", durationMs: 65000 });
  write(T1, { type: "attachment", attachment: { type: "skill_listing", content: "- frontend-design:frontend-design: Guidance for distinctive visual design.\n- docs: Living docs you create and edit.\n  More about docs." } }, tool("t4", "Skill", { skill: "docs" }), tool("t5", "Skill", { skill: "docs" }));
  await until(async () => (await get("/api/sessions/sess-1/steps")).steps.some((x) => x.title === "Read server.ts"), 4000);
  const steps = await get("/api/sessions/sess-1/steps");
  check(steps.steps.find((x) => x.id === "t1")?.error === "1 test failed" && steps.steps.some((x) => x.title === "Read server.ts") && !steps.steps.some((x) => x.id === "t3"), "steps show failures and short paths, and agentbook's own tools stay quiet");
  check(steps.steps.find((x) => x.kind === "say")?.text === "Looking at the server first.\n\nThen the widget types.", "what it said keeps its lines, for its thread's conversation");
  s = await until(async () => {
    const v = await state();
    return v.sessions.find((x) => x.id === "sess-1")?.prs?.["https://github.com/x/dashy/pull/7"] ? v : null;
  }, 8000);
  p1 = s?.sessions.find((x) => x.id === "sess-1");
  check(p1?.ai_title === "Embed widget" && p1?.model === "claude-opus-5-5", "the transcript's title and model are kept with the post");
  const prof = await until(async () => {
    const v = await get("/api/agents/claude");
    return v.skills?.length >= 2 ? v : null;
  }, 6000);
  const docs = prof?.skills.find((k) => k.name === "docs");
  check(docs?.used === 2 && /More about docs/.test(docs.description) && prof.skills[0].name === "docs" && prof.skills.some((k) => k.name === "frontend-design:frontend-design"), "the profile lists the agent's skills, most used first");
  check(!("skills" in p1), "skills stay off the feed's state");

  // ---------- what it changed: each edit's size on its step, and its hunks when you open it ----------
  const edited = (id, r) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: r });
  const storeFile = path.join(project, "server", "store.mjs");
  const subFile = path.join(HOME, "osprey", "subagents", "agent-a1b2.jsonl");
  fs.mkdirSync(path.dirname(subFile), { recursive: true });
  // Claude Code names the Agent call that started a subagent next to its transcript.
  fs.writeFileSync(subFile.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose", toolUseId: "e4" }));
  write(subFile, { ...tool("s1", "Edit", { file_path: storeFile }), isSidechain: true }, { ...edited("s1", { filePath: storeFile, structuredPatch: [{ oldStart: 40, oldLines: 1, newStart: 41, newLines: 1, lines: ["-x", "+y"] }] }), isSidechain: true });
  write(
    T1,
    tool("e1", "Edit", { file_path: storeFile, old_string: "gone", new_string: "café ☕" }),
    edited("e1", { filePath: storeFile, oldString: "gone", newString: "café ☕", originalFile: null, structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" keep", "-gone", "+café ☕", "+more", " keep"] }] }),
    tool("e2", "Write", { file_path: path.join(project, "notes.md"), content: "one\ntwo\n" }),
    edited("e2", { type: "create", filePath: path.join(project, "notes.md"), content: "one\ntwo\n", structuredPatch: [], originalFile: null }),
    tool("e3", "Write", { file_path: "/tmp/scratch.js", content: "x\n" }),
    edited("e3", { type: "create", filePath: "/tmp/scratch.js", content: "x\n", structuredPatch: [] }),
    tool("e4", "Agent", { description: "Fix the store", prompt: "Fix it" }),
    edited("e4", { status: "completed", agentId: "a1b2", content: [{ type: "text", text: "Fixed." }] }),
    tool("e5", "Edit", { file_path: storeFile }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e5", is_error: true, content: "String not found" }] }, toolUseResult: "Error: String not found" },
  );
  const changed = await until(async () => {
    const v = await get("/api/sessions/sess-1/steps");
    return v.steps.find((x) => x.id === "e4")?.files ? v : null;
  }, 4000);
  const stepOf = (id) => changed?.steps.find((x) => x.id === id);
  check(JSON.stringify(stepOf("e1")?.files) === JSON.stringify([{ path: "server/store.mjs", kind: "edit", add: 2, del: 1 }]), "an edit step says which file it changed, and by how many lines");
  check(stepOf("e2")?.files?.[0].kind === "create" && stepOf("e2").files[0].add === 2 && stepOf("e3")?.files?.[0].path === "/tmp/scratch.js" && !stepOf("e5")?.files, "a new file counts all its lines; a failed edit changed nothing");
  check(stepOf("e4")?.files?.[0].path === "server/store.mjs" && stepOf("e4").files[0].add === 1, "a subagent's edits count on the step that started it");
  const stepFiles = async (id) => (await get(`/api/sessions/sess-1/steps/${id}/diff`)).files || [];
  const [d1, d2, d4] = [await stepFiles("e1"), await stepFiles("e2"), await stepFiles("e4")];
  check(d1[0]?.hunks.some((h) => h.lines.includes("+café ☕")), "opening an edit reads its hunks back from the transcript");
  check(d2[0]?.hunks.flatMap((h) => h.lines).join() === "+one,+two" && d4[0]?.hunks.flatMap((h) => h.lines).join() === "-x,+y" && !(await stepFiles("nope")).length, "a new file's diff is its content, and a subagent's edit is read from its own transcript");

  // ---------- what it saw: a step's screenshots and images, read back from the transcript when you look ----------
  const bytes = (s) => Buffer.from(s).toString("base64");
  const pic = (id, ...images) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Captured" }, ...images.map(([type, data]) => ({ type: "image", source: { type: "base64", media_type: type, data: bytes(data) } }))] }] }, toolUseResult: [{ type: "text", text: "Captured" }] });
  write(subFile, { ...tool("s2", "Read", { file_path: path.join(project, "ref.png") }), isSidechain: true }, { ...pic("s2", ["image/png", "sub-png"]), isSidechain: true });
  write(T1, tool("i1", "mcp__claude-in-chrome__computer", { action: "screenshot" }), pic("i1", ["image/png", "first-png"], ["image/jpeg", "second-jpg"]), tool("i2", "Read", { file_path: path.join(project, "shot.png") }), pic("i2", ["image/png", "read-png"]));
  const seen = await until(async () => {
    const v = await get("/api/sessions/sess-1/steps");
    return v.steps.find((x) => x.id === "i2")?.images && v.steps.find((x) => x.id === "e4")?.images ? v : null;
  }, 4000);
  const shots = (id) => seen?.steps.find((x) => x.id === id)?.images;
  check(shots("i1") === 2 && shots("i2") === 1 && !shots("t1"), "a step counts the images its result held: a screenshot, an image it read");
  check(seen?.steps.find((x) => x.id === "i1")?.title === "Take a screenshot", "a screenshot step says so, whichever tool took it");
  check(shots("e4") === 1, "a subagent's images count on the step that started it");
  const shot = await call(`${URL}/api/sessions/sess-1/images/i1/1`);
  check(shot.status === 200 && shot.headers.get("content-type") === "image/jpeg" && (await shot.text()) === "second-jpg" && /sandbox/.test(shot.headers.get("content-security-policy")), "an image is read back from the transcript, as itself, sandboxed");
  const subShot = await call(`${URL}/api/sessions/sess-1/images/e4/0?download=1`);
  check((await subShot.text()) === "sub-png" && /^attachment; filename="osprey 1\.png"$/.test(subShot.headers.get("content-disposition")), "a subagent's image is read from its own transcript, and downloads with a name");
  const missing = await Promise.all(["i1/2", "nope/0", "i1/x"].map(async (p) => (await call(`${URL}/api/sessions/sess-1/images/${p}`)).status));
  check(missing.every((x) => x === 404), "an image that isn't there is a 404");
  const counted = await until(async () => (await state()).sessions.find((x) => x.id === "sess-1")?.stats?.files === 2, 4000);
  check(counted, "the post counts the files it changed in its folder, leaving out ones elsewhere");
  // ---------- a file the agent names opens on the page ----------
  for (const [f, text] of [["docs/plan.md", "# The plan\n\nShip it.\n"], ["mockups/page.html", '<link rel="stylesheet" href="../ui/app.css"><p>hi</p>'], ["ui/app.css", "p { color: red }"], [".env", "SECRET=1"]]) {
    fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true });
    fs.writeFileSync(path.join(project, f), text);
  }
  const named = await get("/api/sessions/sess-1/file?path=docs/plan.md");
  check(named.kind === "text" && named.text.startsWith("# The plan") && named.path === path.join(realProject, "docs", "plan.md"), "a file named from the session's folder opens with its text");
  const page = await get("/api/sessions/sess-1/file?path=mockups/page.html");
  const css = await fetch(`${URL}/api/peek/${page.peek?.id}/ui/app.css`);
  check(page.kind === "html" && page.peek?.path === "mockups/page.html" && css.ok && /^sandbox allow-scripts/.test(css.headers.get("content-security-policy")) && (await css.text()).includes("color: red"), "a page opens by its peek link, sandboxed, and reaches what it links to without your cookie");
  // A worktree Claude Code makes sits in the project's hidden .claude/worktrees: a page there links to its own checkout.
  const tree = path.join(project, ".claude", "worktrees", "wip");
  for (const [f, text] of [[".git", `gitdir: ${path.join(project, ".wipgit")}\n`], ["mockups/wip.html", '<link rel="stylesheet" href="../ui/wip.css">'], ["ui/wip.css", "p { color: blue }"]]) {
    fs.mkdirSync(path.dirname(path.join(tree, f)), { recursive: true });
    fs.writeFileSync(path.join(tree, f), text);
  }
  fs.mkdirSync(path.join(project, ".wipgit"), { recursive: true });
  fs.writeFileSync(path.join(project, ".wipgit", "HEAD"), "ref: refs/heads/worktree-wip\n");
  const treePage = await get("/api/sessions/sess-1/file?path=.claude/worktrees/wip/mockups/wip.html");
  const treeCss = await fetch(`${URL}/api/peek/${treePage.peek?.id}/ui/wip.css`);
  check(treePage.kind === "html" && treePage.peek?.path === "mockups/wip.html" && treeCss.ok && (await treeCss.text()).includes("color: blue"), "a page in a worktree inside the project opens, and reaches what it links to in that worktree");
  const peekStatus = async (p) => (await fetch(`${URL}/api/peek/${p}`)).status;
  check((await peekStatus(`${page.peek?.id}/.env`)) === 404 && (await peekStatus(`${page.peek?.id}/..%2F..%2F..%2Fetc%2Fhosts`)) === 404 && (await peekStatus("nope/ui/app.css")) === 404, "a peek link doesn't reach hidden files or outside its folder, and works only with its key");
  // A video opens to play, from wherever it's skipped to.
  fs.writeFileSync(path.join(project, "docs", "demo.mp4"), "0123456789abcdef");
  const video = await get("/api/sessions/sess-1/file?path=docs/demo.mp4");
  const clip = await fetch(`${URL}/api/peek/${video.peek?.id}/${video.peek?.path}`, { headers: { range: "bytes=4-7" } });
  check(video.kind === "video" && clip.status === 206 && clip.headers.get("content-range") === "bytes 4-7/16" && clip.headers.get("content-type") === "video/mp4" && (await clip.text()) === "4567", "a video opens to play, a piece at a time");
  const folder = await get("/api/sessions/sess-1/file?path=docs/");
  check(folder.kind === "dir" && folder.entries.some((e) => e.name === "plan.md" && !e.dir), "a folder opens as a list of what's in it");
  check((await call(`${URL}/api/sessions/sess-1/file?path=nope.md`)).status === 404 && (await fetch(`${URL}/api/sessions/sess-1/file?path=docs/plan.md`)).status === 401, "a file that isn't there says so, and only someone signed in reads files");


  // ---------- what you do on agentbook reaches the session, between turns ----------
  const ask = await live.call("ab_ask", { question: "Which runner?", options: ["Namespace|cheaper", "Blacksmith"], wait_seconds: 0 });
  const qid = ask.content[0].text.match(/question ([\w-]+)/)[1];
  check(/in their Needs you\. Until it's answered, don't build what it decides, not even on your default\. Do only what doesn't depend on it, then end your turn: the answer starts your next turn\.$/.test(ask.content[0].text), "a question it doesn't wait for tells the agent to hold what it decides and end its turn");
  await post(`/api/questions/${qid}/answer`, { value: "Namespace" });
  const ans = await live.waitNote((n) => n.method === "notifications/claude/channel" && n.params.meta.kind === "answer");
  check(ans?.params.content === "Namespace" && ans.params.meta.question === "Which runner?", "an answer reaches the session as a channel event");

  const reminded = runHook("UserPromptSubmit", { prompt: "keep going", cwd: project, transcript_path: T1 }, env1);
  check(/agentbook, Visual mode/.test(reminded.out) && /ab_verdict/.test(reminded.out), "and each turn starts with a reminder");
  await post("/api/sessions/sess-1/messages", { text: "Use the EU region" });
  await sleep(800);
  check(!live.notes.some((n) => n.params?.content === "Use the EU region"), "mid-turn, a comment waits for the turn to end");
  live.notify("notifications/claude/channel/permission_request", { request_id: "abcde", tool_name: "Bash", description: "Apply the plan", input_preview: '{"command":"terraform apply"}' });
  const perm = await until(async () => (await state()).questions.find((q) => q.request_id === "abcde"));
  check(perm?.kind === "permission" && /terraform apply/.test(perm.preview), "a permission prompt shows on the post");
  await post(`/api/questions/${perm.id}/answer`, { value: "allow" });
  const verdict = await live.waitNote((n) => n.method === "notifications/claude/channel/permission");
  check(verdict?.params.request_id === "abcde" && verdict.params.behavior === "allow", "allowing it answers Claude Code's prompt at once, mid-turn");
  // How the turn went: it waits for the reply that ends the turn, and goes on that.
  const unknown = await live.call("ab_verdict", { verdict: "great", line: "It went well" });
  const noLine = await live.call("ab_checks", { checks: [{ status: "not_checked", label: " " }] });
  await live.call("ab_verdict", { verdict: "partly", line: "Half of it" });
  await live.call("ab_verdict", { verdict: "done", line: "Embeds work,   in a sandboxed frame" });
  await live.call("ab_checks", { checks: [{ status: "failed", label: "Lint", detail: "2 errors, both on main too" }, { status: "not_checked", label: "Safari" }] });
  await live.call("ab_suggest", { replies: ["Open the PR", "Open the PR", " ", "Not now"] });
  await live.call("ab_draft", { kind: "email", to: ["support@ledgerly.io"], subject: "Raise our limit", body: "Hi,\n\nCould you raise it?" });
  await live.call("ab_draft", { kind: "pull_request", title: "Embed widgets", body: "Web pages and HTML, sandboxed.", branch: "embeds", base: "main" });
  const noSubject = await live.call("ab_draft", { kind: "email", to: ["a@b.c"], body: "x" });
  await live.call("ab_path", { stages: [{ text: "Read the widget code", minutes: 3 }, { text: "Tried an iframe per widget", minutes: 6, dead: "too slow with 30 widgets" }, { text: "One sandboxed frame", minutes: 9 }] });
  check(!(await get("/api/sessions/sess-1")).messages.some((m) => m.shape), "how a turn went shows on no message until its reply");
  const ended = Date.now();
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done for now." }, env1);
  const comment = await live.waitNote((n) => n.params?.content === "Use the EU region", 6000);
  check(comment && Date.now() - ended >= 1400, "once the turn ends, the comment goes out as a turn of its own");
  s = await state();
  const msgs = (await get("/api/sessions/sess-1")).messages;
  check(msgs.some((m) => m.from === "human" && m.via === "terminal" && m.text === "keep going"), "prompts typed in the terminal show in the conversation");
  check(msgs.some((m) => m.from === "agent" && m.via === "terminal" && m.text === "Done for now."), "Claude's replies in the terminal show in the conversation");
  const shaped = msgs.find((m) => m.text === "Done for now.")?.shape;
  check(unknown.isError && /verdict must be one of done, found, needs_you/.test(unknown.content[0].text) && noLine.isError && /needs a label/.test(noLine.content[0].text), "a verdict agentbook doesn't know, or a check without a label, is turned away saying why");
  check(shaped?.verdict?.kind === "done" && shaped.verdict.line === "Embeds work, in a sandboxed frame" && shaped.checks.length === 2 && shaped.checks[0].detail === "2 errors, both on main too" && shaped.checks[1].status === "not_checked" && shaped.replies.join("|") === "Open the PR|Not now", "ab_verdict, ab_checks and ab_suggest go on the reply that ends the turn: the last verdict, a reply suggested twice once");
  check(msgs.filter((m) => m.shape).length === 1, "and on no other message");
  check(shaped?.drafts?.length === 2 && shaped.drafts[0].subject === "Raise our limit" && shaped.drafts[0].body === "Hi,\n\nCould you raise it?" && shaped.drafts[1].kind === "pull_request" && noSubject.isError && /subject/.test(noSubject.content[0].text), "ab_draft's drafts join each other on that reply, an email's lines kept; one without a subject is turned away");
  check(shaped?.path?.stages?.[1]?.dead === "too slow with 30 widgets", "and ab_path's stages, a dead end with why");
  const said = (await get(`/api/q/feed?q=${encodeURIComponent("done for now")}`)).found?.posts?.["sess-1"];
  const typo = (await get("/api/q/feed?q=regoin")).found?.posts?.["sess-1"];
  check(said?.exact.length === 3 && said.hit.from === "agent" && said.hit.text === "Done for now." && typo?.typo.includes("regoin") && !typo.exact.length, "search finds words anywhere in a post's conversation, its agent's replies too, and forgives a typo");

  // ---------- its workers: the subagents it started ----------
  // One in the background works on after its turn: it shows on its thread with the tool it last started, keeps the
  // thread working, and stops as Claude Code's notice says, with why.
  const subDir = path.dirname(subFile);
  fs.writeFileSync(path.join(subDir, "agent-c3d4.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Audit the store", toolUseId: "w1" }));
  write(T1, tool("w1", "Agent", { description: "Audit the store", prompt: "Audit it", run_in_background: true }), edited("w1", { isAsync: true, status: "async_launched", agentId: "c3d4", description: "Audit the store" }));
  write(path.join(subDir, "agent-c3d4.jsonl"), { ...tool("w1a", "Bash", { command: "npm test -- store", description: "Run the store tests" }), isSidechain: true });
  const auditing = await until(async () => {
    const d = await get("/api/sessions/sess-1");
    return d.workers?.find((w) => w.id === "w1")?.step && d;
  }, 6000);
  const w1 = auditing?.workers.find((w) => w.id === "w1");
  check(w1?.state === "running" && w1.title === "Audit the store" && w1.step.title === "Run the store tests", "a subagent in the background shows on its thread, with the tool it last started");
  check(auditing?.effective === "working" && auditing.going?.some((g) => g.title === "Audit the store") && auditing.workers.find((w) => w.id === "e4")?.state === "done", "and keeps its thread working after its turn; one that ran in the foreground is done");
  write(T1, { type: "user", message: { content: '<task-notification>\n<task-id>c3d4</task-id>\n<tool-use-id>w1</tool-use-id>\n<status>failed</status>\n<summary>Agent "Audit the store" failed: API Error: overloaded</summary>\n</task-notification>' } });
  const audited = await until(async () => {
    const d = await get("/api/sessions/sess-1");
    return d.workers?.find((w) => w.id === "w1")?.state === "failed" && d;
  }, 6000);
  check(audited?.workers.find((w) => w.id === "w1").error === "API Error: overloaded" && audited.effective !== "working" && !audited.going, "Claude Code's notice that it stopped says how it went, and why it failed");
  // Sent a message (SendMessage), it goes on and finishes: the notice that it did (by the SendMessage call) ends it,
  // though the message it woke to, in its own transcript, is read after the notice.
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  await sleep(2100); // so the message it wakes to comes after the notice that it failed
  const finished = ago(500);
  write(T1, { type: "user", timestamp: finished, message: { content: '<task-notification>\n<task-id>c3d4</task-id>\n<tool-use-id>w1-again</tool-use-id>\n<status>completed</status>\n<summary>Agent "Audit the store" finished</summary>\n</task-notification>' } });
  write(path.join(subDir, "agent-c3d4.jsonl"), { type: "user", timestamp: ago(1500), isSidechain: true, message: { content: "Your run stopped on an API error. Go on from where you were." } }, { ...tool("w1b", "Grep", { pattern: "N+1", path: "server" }), timestamp: ago(1000), isSidechain: true });
  const reAudited = await until(async () => {
    const d = await get("/api/sessions/sess-1");
    const w = d.workers?.find((x) => x.id === "w1");
    return w?.state === "done" && w.n === 2 && w;
  }, 6000);
  await sleep(1200); // a poll that would have read it going again
  const w1Now = (await get("/api/sessions/sess-1")).workers?.find((x) => x.id === "w1");
  check(reAudited && w1Now?.state === "done" && !w1Now.error && w1Now.ended === finished, "one that failed, was sent a message and finished is done, ended when it finished");
  const w1Steps = await get("/api/sessions/sess-1/workers/w1/steps");
  check(w1Steps.n === 2 && w1Steps.steps?.[0].title === "Run the store tests" && w1Steps.steps[1].title.startsWith("Search for “N+1”") && !("steps" in w1Now), "its own steps are read when you open it, not sent with the thread");

  // Pinning keeps a post on top of the feed, and leaves the session alone.
  const before = live.notes.length;
  await post("/api/pins", { post: "sess-1", pinned: true });
  await sleep(600);
  const pinned = (await state()).sessions.find((x) => x.id === "sess-1");
  check(pinned?.pinned === true && pinned.pinned_at && live.notes.length === before, "a post can be pinned, without disturbing its session");
  await post("/api/sessions/sess-1/flag", { archived: true });
  const archived = (await state()).sessions.find((x) => x.id === "sess-1");
  const pinArchived = await post("/api/pins", { post: "sess-1", pinned: true });
  await post("/api/sessions/sess-1/flag", { archived: false });
  const unarchived = (await state()).sessions.find((x) => x.id === "sess-1");
  check(archived?.archived === true && archived.archived_at && unarchived.archived === false && !unarchived.archived_at && live.notes.length === before, "a post can be archived out of the feed and brought back, without disturbing its session");
  check(archived?.pinned === false && !archived.pinned_at && pinArchived.status === 409 && unarchived.pinned === false, "archiving a thread unpins it, an archived one can't be pinned, and it comes back unpinned");
  await post("/api/sessions/sess-1/flag", { hidden: true });
  const hidden = (await state()).sessions.find((x) => x.id === "sess-1");
  await post("/api/sessions/sess-1/flag", { hidden: false });
  const unhidden = (await state()).sessions.find((x) => x.id === "sess-1");
  check(hidden?.hidden === true && hidden.hidden_at && !hidden.archived && unhidden.hidden === false && !unhidden.hidden_at && live.notes.length === before, "a post can be hidden from the feed and brought back, without disturbing its session");
  await post("/api/sessions/sess-1/flag", { archived: true });
  runHook("UserPromptSubmit", { prompt: "and now?", cwd: project }, env1);
  check(!(await state()).sessions.find((x) => x.id === "sess-1").archived, "a prompt typed in an archived thread's terminal brings it back to the feed");
  await live.call("ab_reply", { text: "Here's where we are." });
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "I replied on agentbook." }, env1);
  check(!(await get("/api/sessions/sess-1")).messages.some((m) => m.text === "I replied on agentbook."), "Claude's closing words are left out when it already answered on agentbook");
  // One that answered a comment mid-turn and worked on after it closes the turn with what it found.
  runHook("UserPromptSubmit", { prompt: "now the migration", cwd: project }, env1);
  await live.call("ab_reply", { text: "Got it, migrating the EU region too." });
  await sleep(50);
  write(T1, tool("mig1", "Bash", { command: "npm run migrate -- --region eu", description: "Migrate the EU region" }), result("mig1"));
  await until(async () => (await get("/api/sessions/sess-1/steps")).steps.some((x) => x.id === "mig1"), 4000);
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Migrated both regions; 12 tables moved." }, env1);
  check((await get("/api/sessions/sess-1")).messages.some((m) => m.from === "agent" && m.text === "Migrated both regions; 12 tables moved."), "but not when it answered a comment mid-turn and worked on after it");

  // ---------- /clear starts a new post; resuming a conversation brings its post back ----------
  runHook("SessionStart", { session_id: "sess-2", cwd: project, source: "clear", transcript_path: path.join(HOME, "sess-2.jsonl") }, env1);
  s = await state();
  check(s.sessions.find((x) => x.id === "sess-1")?.effective === "done" && !s.sessions.some((x) => x.id === "sess-2"), "/clear ends the old post; the new one waits for its first prompt");
  runHook("UserPromptSubmit", { prompt: "start over", cwd: project, transcript_path: path.join(HOME, "sess-2.jsonl") }, env1);
  runHook("Stop", { stop_hook_active: false, cwd: project }, env1);
  check((await state()).sessions.find((x) => x.id === "sess-2")?.effective === "idle", "which starts it");
  await live.call("ab_update", { text: "Fresh start" });
  s = await state();
  check(s.sessions.find((x) => x.id === "sess-2")?.updates.some((u) => u.text === "Fresh start"), "the MCP server follows the session to its new post");
  runHook("SessionStart", { session_id: "sess-1", cwd: project, source: "resume", transcript_path: T1 }, { AGENTBOOK_PID: "910005", AGENTBOOK_LABEL: "osprey" });
  s = await state();
  const back = s.sessions.find((x) => x.id === "sess-1");
  check(back?.effective === "idle" && back.updates.filter((u) => !u.changes).length === 1 && back.proc === proc(910005), "claude --resume brings the conversation's post back");

  // ---------- a session without live delivery: hooks hand things over ----------
  const env2 = { AGENTBOOK_PID: "910002", AGENTBOOK_LABEL: "wren", AGENTBOOK_CHANNEL: "0" };
  runHook("SessionStart", { session_id: "sess-3", cwd: project, source: "startup" }, env2);
  runHook("UserPromptSubmit", { prompt: "<channel source=\"plugin:agentbook:agentbook\" kind=\"message\">hi</channel>", cwd: project }, env2);
  check(!(await get("/api/sessions/sess-3")).messages.some((m) => /channel/.test(m.text)), "agentbook's own events aren't mirrored as if you typed them");
  check(runHook("Stop", { stop_hook_active: false, cwd: project }, env2).out === "", "with nothing new, the Stop hook lets Claude stop");
  runHook("UserPromptSubmit", { prompt: "go", cwd: project }, env2);
  await post("/api/sessions/sess-3/messages", { text: "Use the EU region" });
  const block = JSON.parse(runHook("Stop", { stop_hook_active: false, cwd: project }, env2).out || "{}");
  check(block.decision === "block" && /EU region/.test(block.reason), "the Stop hook hands over your comment and keeps Claude going");
  // Visual mode is every agent's: there's no switch to turn it off, and a session started again is told again.
  check((await post("/api/agents/claude/visual", { visual: false })).status >= 400, "there's no turning Visual mode off on an agent");
  const restarted = runHook("SessionStart", { session_id: "sess-3", cwd: project, source: "compact" }, env2);
  check(/wren/.test(restarted.out) && /Visual mode is on/.test(restarted.out), "a session started again is told to show how its turns went");
  runHook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, env2);
  check((await state()).sessions.find((x) => x.id === "sess-3")?.effective === "needs", "a permission prompt in the terminal shows as needing you");
  runHook("SessionEnd", { reason: "prompt_input_exit" }, env2);
  check((await state()).sessions.find((x) => x.id === "sess-3")?.effective === "done", "SessionEnd marks the post done");

  // ---------- one idle at its prompt in a terminal wakes when you write to it (the Wake hook) ----------
  // The hook gives up once its Claude Code process is gone, so this one is a real process.
  const kiteProc = spawn("sleep", ["600"], { stdio: "ignore" });
  const envW = { AGENTBOOK_PID: String(kiteProc.pid), AGENTBOOK_LABEL: "kite", AGENTBOOK_CHANNEL: "0" };
  const wakeHook = (extra: Record<string, string> = {}) =>
    new Promise<{ code: number; err: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), "Wake"], { env: { ...baseEnv, ...envW, ...extra }, stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
      child.stdin.end(JSON.stringify({ session_id: "sess-w", cwd: project, hook_event_name: "Stop" }));
    });
  runHook("SessionStart", { session_id: "sess-w", cwd: project, source: "startup" }, envW);
  runHook("UserPromptSubmit", { prompt: "go", cwd: project }, envW);
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done." }, envW);
  const kiteUnheard = await post("/api/sessions/sess-w/messages", { text: "Also the EU region" });
  check(kiteUnheard.ok && kiteUnheard.stuck === "terminal", "with nothing to wake it, writing to a session idle in a terminal says it waits for someone to type there");
  const kiteWoke = await wakeHook();
  check(kiteWoke.code === 2 && /EU region/.test(kiteWoke.err) && (await state()).sessions.find((x) => x.id === "sess-w")?.effective === "working", "the Wake hook wakes it with what was waiting, as a turn of its own");
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done." }, envW);
  const kiteWaits = wakeHook();
  await sleep(1500);
  const kiteHeard = await post("/api/sessions/sess-w/messages", { text: "And the US one" });
  const kiteWoke2 = await kiteWaits;
  check(!kiteHeard.stuck && kiteWoke2.code === 2 && /US one/.test(kiteWoke2.err), "while it waits, what you write wakes it at once");
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done." }, envW);
  const kiteTyped = wakeHook();
  await sleep(1500);
  runHook("UserPromptSubmit", { prompt: "typing here instead", cwd: project }, envW);
  const kiteGaveUp = await Promise.race([kiteTyped, sleep(5000).then(() => null)]);
  check(kiteGaveUp?.code === 0 && !kiteGaveUp.err, "it gives up once a turn starts in the terminal, for that turn's Stop hook to wait again");
  // A Stop hook that can't reach agentbook-cli in its seconds (busy, for the whole 5): the thread stayed on
  // working, holding what you sent, and the Wake hook gave up on it. Now the Wake hook says the turn's end instead.
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done." }, { ...envW, AGENTBOOK_URL: "http://127.0.0.1:1" });
  check((await state()).sessions.find((x) => x.id === "sess-w")?.effective === "working", "a turn whose Stop hook couldn't reach agentbook-cli is still working, to agentbook");
  const kiteOwed = wakeHook({ AGENTBOOK_WAKE_SETTLE_MS: "300" });
  const kiteEnded = await until(async () => (await state()).sessions.find((x) => x.id === "sess-w" && x.effective === "idle"), 8000);
  check(!!kiteEnded, "the Wake hook beside it says the turn's end in its place");
  const kiteHeardAfter = await post("/api/sessions/sess-w/messages", { text: "And the APAC one" });
  const kiteWoke3 = await Promise.race([kiteOwed, sleep(8000).then(() => null)]);
  check(!kiteHeardAfter.stuck && kiteWoke3?.code === 2 && /APAC one/.test(kiteWoke3.err), "and goes on waiting, so what you write next wakes it");
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done." }, envW);
  runHook("SessionEnd", { reason: "prompt_input_exit" }, envW);
  kiteProc.kill();

  // ---------- headless runs stay off until they use agentbook ----------
  runHook("SessionStart", { session_id: "sess-4", cwd: project, source: "startup" }, { AGENTBOOK_PID: "910003", AGENTBOOK_LABEL: "ghost", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  check(!(await state()).sessions.some((x) => x.label === "ghost"), "headless claude -p sessions stay off agentbook");
  const grokRan = [["SessionStart", "session_start", { source: "startup" }], ["UserPromptSubmit", "user_prompt_submit", { prompt: "List the files" }], ["Stop", "stop", { stop_hook_active: false, last_assistant_message: "Done." }]] as const;
  const grokCodes = grokRan.map(([event, grokEvent, extra]) => runHook(event, { session_id: "grok-sess", cwd: project, ...extra }, { AGENTBOOK_PID: "910004", AGENTBOOK_LABEL: "grokked", GROK_HOOK_EVENT: grokEvent }).code);
  check(grokCodes.every((c) => c === 0) && !(await state()).sessions.some((x) => x.label === "grokked" || x.id === "grok-sess"), "grok running agentbook's hooks (it runs Claude Code plugins' too) makes no Claude Code thread of its session");
  const ghost = startMcp({ AGENTBOOK_PID: "910003", AGENTBOOK_LABEL: "ghost", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  await ghost.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await ghost.call("ab_update", { text: "Ran the nightly export" });
  check((await state()).sessions.some((x) => x.label === "ghost" && x.updates.length === 1), "one that uses an ab_* tool registers then");
  ghost.child.kill();

  // ---------- Claude Desktop's Code tab and VS Code are typed into, as a terminal is ----------
  for (const [entry, sid, label] of [["claude-desktop", "sess-desk", "deskbird"], ["claude-vscode", "sess-vsc", "vscbird"]]) {
    const envE = { AGENTBOOK_PID: entry === "claude-desktop" ? "910004" : "910005", AGENTBOOK_LABEL: label, CLAUDE_CODE_ENTRYPOINT: entry };
    runHook("SessionStart", { session_id: sid, cwd: project, source: "startup" }, envE);
    const said = runHook("UserPromptSubmit", { session_id: sid, prompt: "tidy the readme", cwd: project }, envE);
    check(/this conversation is a thread on/.test(said.out) && (await state()).sessions.some((x) => x.label === label), `a ${entry} session is a thread from its first prompt`);
    const app = entry === "claude-desktop" ? "desktop" : "vscode";
    check((await state()).sessions.find((x) => x.label === label)?.app === app, `and says it runs in ${app}, for the page to say where it's typed`);
    // One that registered before agentbook kept it (no `app` in its hello) gets it at its next prompt.
    if (entry === "claude-desktop") {
      const envOld = { ...envE, AGENTBOOK_PID: "910006", AGENTBOOK_LABEL: "olddesk" };
      const mcpOld = startMcp({ ...envOld, CLAUDE_CODE_ENTRYPOINT: "cli" }); // hello from a process that doesn't say where
      await mcpOld.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      await mcpOld.call("ab_update", { text: "Registered before agentbook kept where" });
      const before = (await state()).sessions.find((x) => x.label === "olddesk");
      runHook("UserPromptSubmit", { session_id: "sess-olddesk", prompt: "and the changelog", cwd: project }, envOld);
      check(before && !before.app && (await state()).sessions.find((x) => x.label === "olddesk")?.app === "desktop", "a Desktop thread from before gets where it runs at its next prompt");
      mcpOld.child.kill();
    }
    runHook("SessionEnd", { session_id: sid, reason: "prompt_input_exit" }, envE);
  }

  // ---------- a call through a server Claude Desktop shares between its sessions reaches the session that made it ----------
  // Desktop starts the servers in its own config once, for the app, and hands them to every Code session: a session
  // calls mcp__agentbook__ab_post through a process that isn't its own. Its transcript says who called.
  {
    const TS = path.join(HOME, "sharebird.jsonl");
    fs.writeFileSync(TS, "");
    const envS = { AGENTBOOK_PID: "910020", AGENTBOOK_LABEL: "sharebird", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
    runHook("SessionStart", { session_id: "sess-share", cwd: project, source: "startup", transcript_path: TS }, envS);
    runHook("UserPromptSubmit", { session_id: "sess-share", prompt: "why does the tunnel drop", cwd: project, transcript_path: TS }, envS);
    write(TS, { type: "user", message: { content: "why does the tunnel drop" } });
    const app = startMcp({ AGENTBOOK_PID: "910021", AGENTBOOK_LABEL: "appserver", AGENTBOOK_AGENT: "Claude Desktop", CLAUDE_CODE_ENTRYPOINT: "cli" });
    await app.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    const share = async () => (await state()).sessions.find((x) => x.label === "sharebird");
    // The transcript gets the call a moment after it's made.
    const posting = app.call("ab_post", { title: "Tunnel drops under the VPN", text: "Looking at the split tunnel." });
    await sleep(300);
    write(TS, tool("sh1", "mcp__agentbook__ab_post", { text: "Looking at the split tunnel.", title: "Tunnel drops under the VPN" }));
    const posted = await posting;
    write(TS, result("sh1"));
    check(!posted.isError && (await share())?.title === "Tunnel drops under the VPN", "a call through a server Desktop shares between its sessions writes to the thread of the session that made it");
    check(!(await state()).sessions.some((x) => x.label === "appserver"), "and makes no thread for the shared server's process");
    write(TS, tool("sh2", "mcp__agentbook__ab_suggest", { replies: ["Write the fix", "Show the evidence"] }));
    await app.call("ab_suggest", { replies: ["Write the fix", "Show the evidence"] });
    write(TS, result("sh2"));
    check(JSON.stringify((await share())?.shape?.replies) === JSON.stringify(["Write the fix", "Show the evidence"]), "its suggested replies are kept for its own reply");
    // A call no session's transcript has (a chat in the app) is the server's process's own, as before.
    await app.call("ab_update", { text: "From a chat in the app" });
    const own = (await state()).sessions.find((x) => x.label === "appserver");
    check(own?.updates.length === 1 && !(await share()).updates.length, "a call no session made stays with the shared server's own thread");
    app.child.kill();
    // Desktop's next-step box: the turn ends on Desktop's own tool, and the closing words leave its question out.
    const shareId = (await share()).id;
    const lastSaid = async () => (await get(`/api/sessions/${encodeURIComponent(shareId)}`)).messages.filter((m) => m.from === "agent").at(-1);
    runHook("UserPromptSubmit", { session_id: "sess-share", prompt: "and the fix?", cwd: project, transcript_path: TS }, envS);
    write(TS, { type: "user", message: { content: "and the fix?" } });
    write(TS, tool("sh3", "mcp__ccd_turn__wrap_up", { recap: "Cause found, nothing changed.", ask: "Write the fix that excludes the relay addresses?", actions: [{ label: "Yes, write fix" }, { action: "fix_ci" }, { label: "Open PR", action: "create_pr" }] }), result("sh3"));
    runHook("Stop", { session_id: "sess-share", cwd: project, transcript_path: TS, last_assistant_message: "The split tunnel leaves the relays out." }, envS);
    const boxed = await lastSaid();
    check(JSON.stringify(boxed?.shape?.replies) === JSON.stringify(["Yes, write fix", "Open PR"]) && boxed.text === "The split tunnel leaves the relays out.\n\nWrite the fix that excludes the relay addresses?", "a Desktop session's next-step box shows on its reply: its question ends it, its buttons are the replies");
    // One that suggested replies itself keeps its own, and its closing words as they are.
    runHook("UserPromptSubmit", { session_id: "sess-share", prompt: "go on", cwd: project, transcript_path: TS }, envS);
    write(TS, { type: "user", message: { content: "go on" } });
    const own2 = startMcp(envS);
    await own2.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    await own2.call("ab_suggest", { replies: ["Ship it"] });
    own2.child.kill();
    write(TS, tool("sh4", "mcp__ccd_turn__wrap_up", { recap: "Done.", ask: "Open the PR?", actions: [{ label: "Open PR" }] }), result("sh4"));
    runHook("Stop", { session_id: "sess-share", cwd: project, transcript_path: TS, last_assistant_message: "The fix is written." }, envS);
    const kept = await lastSaid();
    check(JSON.stringify(kept?.shape?.replies) === JSON.stringify(["Ship it"]) && kept.text === "The fix is written.", "one that suggested replies itself keeps them, and its words");
    runHook("SessionEnd", { session_id: "sess-share", reason: "prompt_input_exit" }, envS);
  }

  // ---------- a Claude Desktop session another one started says so ----------
  // Desktop's records (as start_session leaves them): deskbird's session, and a task it started, which runs sess-desk-task.
  const deskOrg = path.join(HOME, "desktop", "claude-code-sessions", "acct", "org");
  fs.mkdirSync(deskOrg, { recursive: true });
  fs.writeFileSync(path.join(deskOrg, "local_aaaa.json"), JSON.stringify({ sessionId: "local_aaaa", cliSessionId: "sess-desk", title: "Tidy the readme" }));
  fs.writeFileSync(path.join(deskOrg, "local_bbbb.json"), JSON.stringify({ sessionId: "local_bbbb", cliSessionId: "sess-desk-task", spawnedFrom: { sessionId: "local_aaaa", taskId: "task_1", title: "Fix the readme's links", sideSession: true } }));
  fs.writeFileSync(path.join(deskOrg, "local_cccc.json"), "{ half written");
  const envT = { AGENTBOOK_PID: "910007", AGENTBOOK_LABEL: "taskbird", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
  runHook("SessionStart", { session_id: "sess-desk-task", cwd: project, source: "startup" }, envT);
  runHook("UserPromptSubmit", { session_id: "sess-desk-task", prompt: "Background (from the session that started this one):\nThe readme's links are broken.\n\nTask:\nFix them.", cwd: project }, envT);
  let fromThread = null;
  for (let i = 0; i < 30 && !fromThread; i++) {
    fromThread = (await state()).sessions.find((x) => x.label === "taskbird")?.started_from;
    if (!fromThread) await sleep(100);
  }
  check(fromThread === "sess-desk", "a Desktop session another one started keeps the thread it was started from (Desktop's spawnedFrom)");
  const [taskQ, parentQ] = await Promise.all([get("/api/q/thread/sess-desk-task"), get("/api/q/thread/sess-desk")]);
  check(taskQ.from?.id === "sess-desk" && taskQ.from.label === "deskbird" && parentQ.started?.map((r) => r.id).join() === "sess-desk-task", "its page has that thread, and that thread's page the threads it started");
  // ---------- and you pick it yourself, for one nothing says it of ----------
  const pickFrom = (id, from) => call(`${URL}/api/sessions/${id}/from`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from }) });
  const fromOf = async (id) => (await get(`/api/q/thread/${id}`)).from?.id || null;
  check((await pickFrom("sess-2", "sess-desk")).ok && (await fromOf("sess-2")) === "sess-desk", "you pick the thread one was started from, on its page");
  check((await get("/api/q/thread/sess-desk")).started?.map((r) => r.id).sort().join() === "sess-2,sess-desk-task", "and that thread lists it with the ones it started");
  const [self, loop, gone] = await Promise.all([pickFrom("sess-2", "sess-2"), pickFrom("sess-desk", "sess-2"), pickFrom("sess-2", "no-such-thread")]);
  check(self.status === 400 && loop.status === 400 && gone.status === 404 && (await fromOf("sess-2")) === "sess-desk", "not itself, not one it started, not a thread that isn't there");
  check((await pickFrom("sess-desk-task", "sess-2")).ok && (await fromOf("sess-desk-task")) === "sess-2" && (await pickFrom("sess-desk", "sess-desk-task")).status === 400, "what you pick replaces Desktop's, and a loop further down is refused");
  check((await pickFrom("sess-desk-task", null)).ok && (await fromOf("sess-desk-task")) === null && (await pickFrom("sess-2", null)).ok && (await fromOf("sess-2")) === null, "and None takes it off");
  runHook("SessionEnd", { session_id: "sess-desk-task", reason: "prompt_input_exit" }, envT);

  // ---------- files you send, and files you delete ----------
  const up = await call(`${URL}/api/upload?post=sess-2&name=seed.sql`, { method: "POST", body: "select 1;" });
  const fid = ((await up.json()) as { id: string }).id;
  const fileNote = await live.waitNote((n) => n.params?.meta?.kind === "file", 6000);
  check(fileNote && fs.readFileSync(fileNote.params.meta.path, "utf8") === "select 1;", "a file you send reaches the session with a readable path");
  const dl = await call(`${URL}/api/files/${fid}?download=1`);
  check(dl.ok && /attachment/.test(dl.headers.get("content-disposition")) && (await dl.text()) === "select 1;", "files download intact");
  await post(`/api/files/${fid}/delete`, {});
  check(!(await get("/api/sessions/sess-2")).files.some((f) => f.id === fid), "a file can be deleted");
  const pageUp = await call(`${URL}/api/upload?post=sess-2&name=mock.html`, { method: "POST", body: "<script>document.title = 'hi'</script>" });
  const pageId = ((await pageUp.json()) as { id: string }).id;
  const [shown, saved] = await Promise.all([call(`${URL}/api/files/${pageId}`), call(`${URL}/api/files/${pageId}?download=1`)]);
  check(/^text\/html/.test(shown.headers.get("content-type")) && /^sandbox allow-scripts/.test(shown.headers.get("content-security-policy")), "an attached page opens as itself, sandboxed like a peek link's");
  check(saved.headers.get("content-type") === "application/octet-stream" && /attachment/.test(saved.headers.get("content-disposition")), "and downloads as a file");
  await post(`/api/files/${pageId}/delete`, {});

  // ---------- writing on an agent's wall starts a session in the background ----------
  const brief: Json = await (await call(`${URL}/api/upload?draft=1&name=brief.txt`, { method: "POST", body: "the brief" })).json();
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-5");
  const launched = await post("/api/launch", { prompt: "Fix the flaky test", root: project, agent: "claude", files: [brief.id] });
  const started = calls().find((c) => c.args.includes("--bg") && c.args[0].startsWith("Fix the flaky test"));
  check(launched.status === 200 && started?.cwd === realProject && started.env.AGENTBOOK_LAUNCH_ID === launched.lid && !started.env.AGENTBOOK_CHANNEL && !started.args.some((a) => /channels/.test(a)), "posting starts a background session in the project, with your text as its prompt");
  check(/Attached files:/.test(started?.args[0]) && started.args[0].includes("brief.txt"), "files attached to the post are named, with their paths, in its first prompt");
  const settings = started?.args[started.args.indexOf("--settings") + 1];
  check(settings && JSON.parse(settings).worktree?.bgIsolation === "none", "it works in the folder it was started in, rather than moving into a worktree of its own");
  const env5 = { AGENTBOOK_PID: "910006", AGENTBOOK_LABEL: "lark", AGENTBOOK_LAUNCH_ID: launched.lid };
  runHook("SessionStart", { session_id: "sess-5", cwd: project, source: "startup" }, env5);
  s = await state();
  check(s.launches.find((l) => l.id === launched.lid)?.post === "sess-5" && s.sessions.find((x) => x.id === "sess-5")?.launch === launched.lid, "the new session takes over its placeholder");
  check((await get("/api/sessions/sess-5")).files.some((f) => f.id === brief.id), "and the post's files join it");
  // Claude Code starts a background session in a worker it made earlier, so the session can carry an
  // earlier launch's variables. It's matched by the id Claude Code gave it instead.
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-6");
  const second = await post("/api/launch", { prompt: "Explain pause", root: project, agent: "claude" });
  runHook("SessionStart", { session_id: "sess-6", cwd: project, source: "startup" }, { AGENTBOOK_PID: "910009", AGENTBOOK_LAUNCH_ID: launched.lid });
  let ls = await state();
  check(ls.launches.find((l) => l.id === second.lid)?.post === "sess-6" && ls.launches.find((l) => l.id === launched.lid)?.post === "sess-5" && ls.sessions.find((x) => x.id === "sess-6")?.launch === second.lid, "a session started with an earlier launch's variables still takes over its own placeholder");
  // A background one (CLAUDE_JOB_DIR) registers as it starts, before its first prompt.
  runHook("SessionStart", { session_id: "sess-7", cwd: project, source: "startup" }, { AGENTBOOK_PID: "910010", CLAUDE_JOB_DIR: path.join(HOME, "claude", "jobs", "sess-7") });
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-7");
  const third = await post("/api/launch", { prompt: "Explain stop", root: project, agent: "claude" });
  ls = await state();
  check(ls.launches.find((l) => l.id === third.lid)?.post === "sess-7", "and one that registered before Claude Code said its id is matched once it does");
  const bg = await until(async () => (await state()).sessions.find((x) => x.id === "sess-5" && x.rt?.kind === "background"), 6000);
  check(bg?.rt.kind === "background", "its post knows it runs in the background");
  const nowhere = await post("/api/launch", { prompt: "x", root: path.join(HOME, "nope") });
  check(nowhere.status === 500 && /No folder/.test(nowhere.error), "starting in a folder that doesn't exist says so");
  const failedStart = (await state()).launches.find((l) => l.root === path.join(HOME, "nope") && l.error);
  const archivedStart = await post(`/api/launches/${encodeURIComponent(failedStart?.id)}/archive`, {});
  check(archivedStart.status === 200 && (await state()).launches.find((l) => l.id === failedStart.id)?.archived, "a start that failed can be archived out of the feed");
  check((await post(`/api/launches/${encodeURIComponent(launched.lid)}/archive`, {})).status === 409, "but not one that started: it's a post");
  fs.mkdirSync(path.join(HOME, "untrusted"));
  const untrusted = await post("/api/launch", { prompt: "x", root: path.join(HOME, "untrusted") });
  check(untrusted.status === 500 && /not trusted/.test(untrusted.error), "a folder Claude Code doesn't trust yet says so");
  const untrustedStart = (await state()).launches.find((l) => l.root === path.join(HOME, "untrusted") && l.error);
  check((await post(`/api/launches/${encodeURIComponent(failedStart.id)}/trust`, {})).status === 409, "a start that failed for another reason isn't trusted and retried");
  const beforeTrust = calls().length;
  const retried = await post(`/api/launches/${encodeURIComponent(untrustedStart?.id)}/trust`, {});
  const retriedStart = (await state()).launches.find((l) => l.id === untrustedStart?.id);
  // (Its own call to claude, by its launch: others can come in meanwhile, its machine asking claude what runs.)
  const retryCall = calls().slice(beforeTrust).find((c) => c.env.AGENTBOOK_LAUNCH_ID === untrustedStart?.id);
  check(retried.status === 200 && trustedIn(path.join(HOME, "untrusted")) && !retriedStart?.error && retryCall?.cwd === fs.realpathSync(path.join(HOME, "untrusted")), "trusting its folder, as Claude Code's prompt would, starts the same session there again");
  check((await post(`/api/launches/${encodeURIComponent(untrustedStart.id)}/trust`, {})).status === 409, "and only once");

  // ---------- an idle background session is woken with what you send ----------
  runHook("UserPromptSubmit", { prompt: started.args[0], cwd: project }, env5);
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Fixed it." }, env5);
  let mark = calls().length;
  await post("/api/sessions/sess-5/messages", { text: "Also add a regression test" });
  const woke5 = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume")), 8000);
  const stop5 = calls().slice(mark).find((c) => c.args[0] === "stop");
  check(stop5?.args[1] === "sess-5" && woke5?.args[0] === "Also add a regression test" && woke5.args[woke5.args.indexOf("--resume") + 1] === "sess-5" && !woke5.args.includes("--plugin-dir"), "an idle background session is stopped and resumed, with your message as its next prompt");
  runHook("SessionEnd", { reason: "other" }, env5);
  check((await state()).sessions.find((x) => x.id === "sess-5")?.effective !== "done", "stopping it to wake it doesn't end its post");
  const env5b = { AGENTBOOK_PID: "910008", AGENTBOOK_LABEL: "lark" };
  runHook("SessionStart", { session_id: "sess-5", cwd: project, source: "resume" }, env5b);
  runHook("UserPromptSubmit", { prompt: "Also add a regression test", cwd: project }, env5b);
  const w5 = await get("/api/sessions/sess-5");
  check(w5.effective === "working" && w5.proc === proc(910008) && w5.messages.filter((m) => /regression test/.test(m.text)).length === 1, "it comes back on the same post, and your message shows once");
  mark = calls().length;
  await post("/api/sessions/sess-5/messages", { text: "Use vitest" });
  await sleep(2500);
  check(!calls().slice(mark).some((c) => c.args.includes("--resume")), "a busy background session isn't woken");
  const block5 = JSON.parse(runHook("Stop", { stop_hook_active: false, cwd: project }, env5b).out || "{}");
  check(block5.decision === "block" && /vitest/.test(block5.reason), "it gets your message when its turn ends");

  // ---------- a background session asks for permission on agentbook ----------
  const asking = runHookAsync("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Clean the build" }, tool_use_id: "toolu_1" }, env5b);
  const pq = await until(async () => (await state()).questions.find((q) => q.kind === "permission" && q.post === "sess-5" && !q.answered), 8000);
  check(pq && pq.preview === "rm -rf build" && pq.detail === "Clean the build", "a background session's permission prompt shows on its post");
  await post(`/api/questions/${pq.id}/answer`, { value: "allow" });
  const allowed = await asking;
  check(JSON.parse(allowed.out || "{}").hookSpecificOutput?.decision?.behavior === "allow", "allowing it there answers Claude Code's prompt");

  // ---------- Claude asks a background session's person something (AskUserQuestion) ----------
  runHook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use AskUserQuestion" }, env5b);
  const askInput = {
    questions: [
      { question: "Which test runner?", header: "Tests", multiSelect: false, options: [{ label: "vitest", description: "fast, ESM" }, { label: "jest" }] },
      { question: "Which reports?", header: "Reports", multiSelect: true, options: [{ label: "coverage" }, { label: "junit" }, { label: "html" }] },
    ],
  };
  const askingQs = runHookAsync("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: askInput, tool_use_id: "toolu_ask" }, env5b);
  const polls = await until(async () => {
    const qs = (await state()).questions.filter((q) => q.post === "sess-5" && !q.answered && q.hook);
    return qs.length === 2 && qs;
  }, 8000);
  check(polls?.[0].kind === "choice" && polls[0].title === "Which test runner?" && polls[0].options[0].detail === "fast, ESM" && polls[1].kind === "multi" && polls.every((q) => q.other), "its questions are polls (one picking several), each taking an answer of your own too");
  check((await state()).sessions.find((x) => x.id === "sess-5").effective === "needs", "while they wait, the post needs you");
  await post(`/api/questions/${polls[0].id}/answer`, { value: "vitest" });
  await post(`/api/questions/${polls[1].id}/answer`, { value: "coverage, junit" });
  const answeredQs = JSON.parse((await askingQs).out || "{}").hookSpecificOutput?.decision;
  check(answeredQs?.behavior === "allow" && answeredQs.updatedInput.answers["Which test runner?"] === "vitest" && answeredQs.updatedInput.answers["Which reports?"] === "coverage, junit" && answeredQs.updatedInput.questions.length === 2, "your answers go to Claude as AskUserQuestion's answers, keyed by question");
  const s5now = (await state()).sessions.find((x) => x.id === "sess-5");
  const nextPrompt = runHook("UserPromptSubmit", { prompt: "go on", cwd: project }, env5b).out || "";
  check(s5now.effective !== "needs" && !/vitest/.test(nextPrompt), "then the post stops needing you, and the answers aren't sent again as messages");

  // ---------- writing on the post instead of answering sets the prompt aside, as Esc does ----------
  const poll5 = await post(`/api/procs/${proc(910008)}/questions`, { title: "Ship it Friday?", kind: "approve" });
  const pushing = runHookAsync("PermissionRequest", { tool_name: "Bash", tool_input: { command: "git push --force" }, tool_use_id: "toolu_4" }, env5b);
  const pushQ = await until(async () => (await state()).questions.find((q) => q.post === "sess-5" && q.kind === "permission" && !q.answered), 8000);
  await post("/api/sessions/sess-5/messages", { text: "Don't force-push, open a PR instead" });
  const pushOut = JSON.parse((await pushing).out || "{}").hookSpecificOutput?.decision;
  check(pushOut?.behavior === "deny" && /instead of answering whether you may use Bash/.test(pushOut.message) && /open a PR instead/.test(pushOut.message), "a comment while a permission prompt waits denies it, with what you wrote as the reason");
  let qs5 = (await state()).questions;
  check(qs5.find((q) => q.id === pushQ.id)?.by === "comment" && !qs5.find((q) => q.id === poll5.id)?.answered && !/open a PR/.test(runHook("UserPromptSubmit", { prompt: "carry on", cwd: project }, env5b).out), "the prompt closes, an ab_ask poll (which doesn't stop the turn) stays open, and the comment isn't handed over twice");
  const asking2 = runHookAsync("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Squash or merge?", header: "Merge", options: [{ label: "Squash" }, { label: "Merge" }] }] }, tool_use_id: "toolu_ask2" }, env5b);
  await until(async () => (await state()).questions.find((q) => q.post === "sess-5" && q.hook && !q.answered), 8000);
  await post("/api/sessions/sess-5/messages", { text: "Rebase it onto main" });
  const ask2Out = JSON.parse((await asking2).out || "{}").hookSpecificOutput?.decision;
  qs5 = (await state()).questions.filter((q) => q.post === "sess-5" && !q.answered);
  check(ask2Out?.behavior === "deny" && /instead of answering your question/.test(ask2Out.message) && /Rebase it onto main/.test(ask2Out.message) && qs5.length === 1 && qs5[0].id === poll5.id, "and so does one while Claude's question waits");
  await post(`/api/questions/${poll5.id}/answer`, { skip: true });
  runHook("UserPromptSubmit", { prompt: "go on", cwd: project }, env5b);
  const expiring = runHookAsync("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make deploy" }, tool_use_id: "toolu_3" }, { ...env5b, AGENTBOOK_PERMISSION_WAIT_MS: "1500" });
  await expiring;
  const s5wait = (await state()).sessions.find((x) => x.id === "sess-5");
  check(!(await state()).questions.some((q) => q.post === "sess-5" && !q.answered) && s5wait.effective === "needs" && /open it in a terminal/.test(s5wait.doing), "a prompt nobody answered in time closes, and the post says it waits in Claude Code, for a terminal");
  const t0 = Date.now();
  const term = runHook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_2" }, env1);
  check(term.out === "" && Date.now() - t0 < 5000 && !(await state()).questions.some((q) => q.post === "sess-2" && q.kind === "permission" && !q.answered), "a session in a terminal gets Claude Code's own prompt instead");

  // ---------- stop its turn, archive it ----------
  mark = calls().length;
  const stopped = await post("/api/sessions/sess-5/stop", {});
  let s5 = (await state()).sessions.find((x) => x.id === "sess-5");
  check(stopped.status === 200 && calls().slice(mark).some((c) => c.args[0] === "esc" && c.args[1] === "sess-5") && !calls().slice(mark).some((c) => c.args[0] === "stop"), "Stop presses Esc in a background session (through claude attach), rather than ending it");
  check(s5.effective === "idle" && !s5.asleep && !s5.busy && s5.rt?.kind === "background" && /Stopped/.test(s5.doing), "it stays up, waiting for your next message");
  check((await post("/api/sessions/sess-5/stop", {})).status === 409, "an idle session has nothing to stop");
  const notBg = await post("/api/sessions/sess-2/stop", {});
  check(notBg.status === 409, "a session in a terminal can't be stopped from agentbook");
  mark = calls().length;
  const hidden5 = await post("/api/sessions/sess-5/flag", { hidden: true });
  check(hidden5.status === 200 && !hidden5.slept && !calls().slice(mark).some((c) => c.args[0] === "stop") && !(await state()).sessions.find((x) => x.id === "sess-5").asleep, "hiding a background session leaves it running, off the feed");
  await post("/api/sessions/sess-5/flag", { hidden: false });
  runHook("UserPromptSubmit", { prompt: "pick a merge style", cwd: project }, env5b);
  const asking3 = runHookAsync("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Squash or rebase?", header: "Merge", options: [{ label: "Squash" }, { label: "Rebase" }] }] }, tool_use_id: "toolu_ask3" }, env5b);
  const ask3 = await until(async () => (await state()).questions.find((q) => q.post === "sess-5" && q.hook && !q.answered), 8000);
  check((await state()).sessions.find((x) => x.id === "sess-5").effective === "needs", "a background session asking you something needs you");
  mark = calls().length;
  const archived5 = await post("/api/sessions/sess-5/flag", { archived: true });
  const ask3Out = JSON.parse((await asking3).out || "{}").hookSpecificOutput?.decision;
  runHook("SessionEnd", { reason: "other" }, env5b);
  s5 = (await state()).sessions.find((x) => x.id === "sess-5");
  check((await state()).questions.find((q) => q.id === ask3.id)?.by === "archived" && s5.effective !== "needs" && ask3Out?.behavior === "deny" && /archived this thread/.test(ask3Out.message), "archiving it closes Claude's question first, and Claude hears the thread was archived");
  check(archived5.status === 200 && archived5.slept && calls().slice(mark).some((c) => c.args[0] === "stop" && c.args[1] === "sess-5"), "archiving a background session stops its process (claude stop)");
  check(s5.archived && s5.asleep && s5.state !== "done" && s5.effective === "done" && s5.sleep_reason === "Archived", "its post is archived and asleep, which shows as done, but not ended");
  mark = calls().length;
  await post("/api/sessions/sess-5/messages", { text: "Actually, one more fix" });
  const woke5b = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume")), 8000);
  check(woke5b?.args[0] === "Actually, one more fix" && woke5b.args.includes("sess-5") && !calls().slice(mark).some((c) => c.args[0] === "stop"), "writing to a sleeping session wakes it with your message, without stopping anything");
  s5 = (await state()).sessions.find((x) => x.id === "sess-5");
  check(!s5.archived && !s5.archived_at, "and writing on an archived thread brings it back to the feed");
  runHook("SessionStart", { session_id: "sess-5", cwd: project, source: "resume" }, { AGENTBOOK_PID: "910011", AGENTBOOK_LABEL: "lark" });
  check(!(await get("/api/sessions/sess-5")).asleep, "and once it's back it isn't asleep");

  // ---------- writing on an ended post resumes it in the background ----------
  mark = calls().length;
  const wake = await post("/api/sessions/sess-3/messages", { text: "One more thing: bump the version" });
  const resumed3 = calls().slice(mark).find((c) => c.args.includes("--resume"));
  check(wake.status === 200 && wake.resumed && resumed3?.args[0] === "One more thing: bump the version" && resumed3.args.includes("sess-3") && resumed3.cwd === realProject && resumed3.env.AGENTBOOK_LABEL === "wren", "writing on an ended post resumes its conversation in the background, with your message");
  const queued = await post("/api/sessions/sess-3/messages", { text: "And the changelog" });
  check(queued.status === 200 && !queued.resumed && calls().slice(mark).filter((c) => c.args.includes("--resume")).length === 1, "while it starts, more messages wait for it instead of starting it twice");
  const env3 = { AGENTBOOK_PID: "910007", AGENTBOOK_LABEL: "wren", AGENTBOOK_LAUNCH_ID: wake.lid };
  runHook("SessionStart", { session_id: "sess-3", cwd: project, source: "resume" }, env3);
  const first3 = runHook("UserPromptSubmit", { prompt: "One more thing: bump the version", cwd: project }, env3);
  const woke = await get("/api/sessions/sess-3");
  check(woke.effective === "working" && woke.proc === proc(910007) && woke.messages.filter((m) => /bump the version/.test(m.text)).length === 1, "it comes back on the same post, and your message shows once");
  check(/And the changelog/.test(first3.out) && !/bump the version/.test(first3.out), "your message was its prompt; the one you sent while it started comes with it");

  // ---------- a thread nothing happened in goes when it ends; one that can't be resumed says why ----------
  const envE = { AGENTBOOK_PID: "910031", AGENTBOOK_LABEL: "plover", AGENTBOOK_CHANNEL: "0" };
  runHook("SessionStart", { session_id: "sess-e1", cwd: project, source: "startup", transcript_path: path.join(HOME, "sess-e1.jsonl") }, envE);
  check(!(await state()).sessions.some((x) => x.id === "sess-e1"), "a session in a terminal isn't a thread until its first prompt");
  runHook("SessionStart", { session_id: "sess-e2", cwd: project, source: "clear", transcript_path: path.join(HOME, "sess-e2.jsonl") }, envE);
  runHook("SessionEnd", { reason: "prompt_input_exit" }, envE);
  s = await state();
  check(!s.sessions.some((x) => x.id === "sess-e1" || x.id === "sess-e2"), "one that's cleared, or quit, before anything was said in it goes, instead of staying as an empty New thread");
  const envN = { AGENTBOOK_PID: "910032", AGENTBOOK_LABEL: "dunlin", AGENTBOOK_CHANNEL: "0" };
  runHook("SessionStart", { session_id: "sess-n", cwd: project, source: "startup", transcript_path: path.join(HOME, "sess-n.jsonl") }, envN);
  runHook("UserPromptSubmit", { prompt: "Look at the logs", cwd: project, transcript_path: path.join(HOME, "sess-n.jsonl") }, envN);
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Done." }, envN);
  runHook("SessionEnd", { reason: "prompt_input_exit" }, envN);
  check((await state()).sessions.find((x) => x.id === "sess-n")?.effective === "done", "one that had a prompt stays when it ends");
  mark = calls().length;
  const noTranscript = await post("/api/sessions/sess-n/messages", { text: "And the metrics" });
  check(noTranscript.status === 409 && /no conversation saved/.test(noTranscript.error) && !calls().slice(mark).some((c) => c.args.includes("--resume")), "writing on an ended thread whose conversation Claude Code didn't keep says it can't be resumed, rather than trying");
  fs.writeFileSync(path.join(HOME, "sess-n.jsonl"), "");
  const failing = await post("/api/sessions/sess-n/messages", { text: "And the metrics" });
  const jobs = JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
  const job = jobs.find((a) => a.sessionId === "sess-n");
  Object.assign(job, { state: "failed", startedAt: Date.now() });
  delete job.pid;
  fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(jobs));
  fs.mkdirSync(path.join(HOME, "claude", "jobs", job.id), { recursive: true });
  fs.writeFileSync(path.join(HOME, "claude", "jobs", job.id, "state.json"), JSON.stringify({ state: "failed", detail: "source session sess-n not found", sessionId: "sess-n" }));
  const gaveUp = await until(async () => (await state()).launches?.find((l) => l.id === failing.lid && l.error), 8000);
  check(failing.resumed && gaveUp?.error === "source session sess-n not found", "a resume Claude Code gives up on says why on the thread, instead of \"Resuming it\" and then nothing");

  // ---------- picking the model ----------
  check((await state()).agents.find((a) => a.id === "claude")?.models?.list.some((m) => m.id === "sonnet"), "Claude's profile lists the models you can pick");
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-m");
  const onSonnet = await post("/api/launch", { prompt: "Try sonnet", root: project, agent: "claude", model: "sonnet", effort: "high" });
  const startedM = calls().find((c) => c.args[0] === "Try sonnet");
  check(onSonnet.status === 200 && startedM?.args.join(" ").includes("--model sonnet --effort high"), "a post starts on the model and effort you pick");
  check(startedM?.args.join(" ").includes("--allowedTools mcp__plugin_agentbook_agentbook__*"), "with agentbook's own tools allowed, since nobody's there to approve them");
  const badModel = await post("/api/launch", { prompt: "x", root: project, agent: "claude", model: "--dangerously-skip-permissions" });
  check(badModel.status === 400 && !calls().some((c) => c.args[0] === "x" && c.args.includes("--dangerously-skip-permissions")), "a model that isn't a model's name is refused");
  const claudeEfforts = (await state()).agents.find((a) => a.id === "claude")?.models;
  check(claudeEfforts?.efforts?.includes("max") && claudeEfforts.list.every((m) => m.efforts?.includes("low")), "Claude's profile lists the effort levels you can pick");
  check((await post("/api/launch", { prompt: "x", root: project, agent: "claude", effort: "--max" })).status === 400, "an effort that isn't an effort level is refused");
  const inPlan = await post("/api/launch", { prompt: "Plan it first", root: project, agent: "claude", mode: "plan" });
  const startedP = calls().find((c) => c.args[0] === "Plan it first");
  check(inPlan.status === 200 && startedP?.args.join(" ").includes("--permission-mode plan") && (await state()).launches.find((l) => l.id === inPlan.lid)?.mode === "plan", "a post starts in the mode you pick, and its start keeps it");
  const inFull = await post("/api/launch", { prompt: "Go all in", root: project, agent: "claude", mode: "full" });
  check(inFull.status === 200 && calls().find((c) => c.args[0] === "Go all in")?.args.join(" ").includes("--permission-mode bypassPermissions"), "Full access is Claude Code's bypassPermissions");
  check((await post("/api/launch", { prompt: "x", root: project, agent: "claude", mode: "yolo" })).status === 400 && !calls().some((c) => c.args[0] === "x" && c.args.includes("--permission-mode")), "a mode that isn't one is refused");
  const envM = { AGENTBOOK_PID: "910020", AGENTBOOK_LABEL: "finch", AGENTBOOK_LAUNCH_ID: onSonnet.lid };
  runHook("SessionStart", { session_id: "sess-m", cwd: project, source: "startup" }, envM);
  runHook("UserPromptSubmit", { prompt: "Try sonnet", cwd: project }, envM);
  await until(async () => (await state()).sessions.find((x) => x.id === "sess-m" && x.rt?.kind === "background"), 6000);
  const pickM = await post("/api/sessions/sess-m/model", { model: "haiku" });
  check(pickM.status === 200 && (await state()).sessions.find((x) => x.id === "sess-m")?.model_pick === "haiku", "a running background session takes another model, for its next turn");
  await post("/api/sessions/sess-m/messages", { text: "Carry on with haiku" });
  mark = calls().length; // before the turn ends: agentbook may wake it right away
  const heldM = JSON.parse(runHook("Stop", { stop_hook_active: false, cwd: project }, envM).out || "{}");
  check(heldM.decision !== "block", "while it switches, its turn ends without your message");
  const wokeM = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume") && c.args.includes("sess-m")), 8000);
  const savedM = JSON.parse(fs.readFileSync(path.join(HOME, "claude", "jobs", "sess-m", "state.json"), "utf8")).respawnFlags;
  const pickCleared = await until(async () => !(await state()).sessions.find((x) => x.id === "sess-m")?.model_pick, 4000);
  check(wokeM?.args[0] === "Carry on with haiku" && !wokeM.args.includes("--model") && savedM.join(" ").endsWith("--effort high --allowedTools mcp__plugin_agentbook_agentbook__* --model haiku") && savedM.includes("--settings") && pickCleared, "then it wakes with your message on the new model, as the same session, still working where it was");
  check((await post("/api/sessions/sess-2/model", { model: "haiku" })).status === 409, "a session in a terminal switches its model there");
  check((await post("/api/sessions/sess-m/model", { model: "-x" })).status === 400, "and a model needs a model's name");
  // Its mode and effort switch the same way: saved with its options as it wakes. (Woken, it says so with its prompt.)
  const envMW = { ...envM, AGENTBOOK_LAUNCH_ID: wokeM?.env?.AGENTBOOK_LAUNCH_ID };
  runHook("SessionStart", { session_id: "sess-m", cwd: project, source: "resume" }, envMW);
  runHook("UserPromptSubmit", { prompt: "Carry on with haiku", cwd: project }, envMW);
  const pickMode = await post("/api/sessions/sess-m/mode", { mode: "auto" });
  const pickEffort = await post("/api/sessions/sess-m/effort", { effort: "low" });
  const pickedM = (await state()).sessions.find((x) => x.id === "sess-m");
  check(pickMode.status === 200 && pickEffort.status === 200 && pickedM?.mode_pick === "auto" && pickedM?.effort_pick === "low", "a background session takes another mode and effort, for its next turn");
  await post("/api/sessions/sess-m/messages", { text: "Carry on in Auto" });
  mark = calls().length;
  runHook("Stop", { stop_hook_active: false, cwd: project }, envMW);
  const wokeA = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume") && c.args.includes("sess-m")), 8000);
  const savedA = JSON.parse(fs.readFileSync(path.join(HOME, "claude", "jobs", "sess-m", "state.json"), "utf8")).respawnFlags.join(" ");
  const settled = await until(async () => {
    const x = (await state()).sessions.find((y) => y.id === "sess-m");
    return !x?.mode_pick && !x?.effort_pick && x?.mode === "auto" && x?.effort === "low" ? x : null;
  }, 4000);
  check(wokeA?.args[0] === "Carry on in Auto" && savedA.endsWith("--model haiku --effort low --permission-mode auto") && !/--effort high/.test(savedA) && !!settled, "then it wakes in them, as the same session, and the thread says it's in them");
  check((await post("/api/sessions/sess-2/mode", { mode: "auto" })).status === 409 && (await post("/api/sessions/sess-m/mode", { mode: "yolo" })).status === 400, "a session in a terminal switches its mode there, and a mode has to be one");
  const undone = await post("/api/sessions/sess-m/mode", { mode: "plan" }).then(() => post("/api/sessions/sess-m/mode", { mode: "" }));
  check(undone.status === 200 && !(await state()).sessions.find((x) => x.id === "sess-m")?.mode_pick, "and a pick can be undone before it takes over");

  // ---------- skipping a question ----------
  const skipAsk = await live.call("ab_ask", { question: "Rename the repo?", options: ["Yes", "No"], wait_seconds: 0 });
  const skipId = skipAsk.content[0].text.match(/question ([\w-]+)/)[1];
  await post(`/api/questions/${skipId}/answer`, { skip: true });
  const skipped = await live.waitNote((n) => n.params?.meta?.question_id === skipId, 6000);
  check(skipped?.params.meta.skipped === "true" && /skipped/.test(skipped.params.content), "a skipped question tells the session it was skipped");

  // ---------- files attached to a reply go out with it ----------
  const draft: Json = await (await call(`${URL}/api/upload?post=sess-2&draft=1&name=spec.md`, { method: "POST", body: "# Spec" })).json();
  check(!(await get("/api/sessions/sess-2")).files.some((f) => f.id === draft.id), "an attached file waits, unseen, until you send");
  await post("/api/sessions/sess-2/messages", { text: "Here's the spec", files: [draft.id] });
  const withFile = await live.waitNote((n) => n.params?.content?.startsWith("Here's the spec"), 6000);
  const specPath = withFile?.params.content.match(/spec\.md: (\S+)/)?.[1];
  check(specPath && fs.readFileSync(specPath, "utf8") === "# Spec", "your reply reaches the session with the file's path");
  const detail2 = await get("/api/sessions/sess-2");
  check(detail2.files.some((f) => f.id === draft.id) && detail2.messages.at(-1).files[0]?.name === "spec.md", "then the file is on the post, and on your message");

  // ---------- dash_ask that waits ----------
  const waiting = live.call("ab_ask", { question: "Ship it?", kind: "approve", wait_seconds: 10 });
  const shipQ = await until(async () => (await state()).questions.find((q) => q.title === "Ship it?"));
  await post(`/api/questions/${shipQ.id}/answer`, { value: "Approve" });
  check(/Answer: Approve/.test((await waiting).content[0].text), "ab_ask with wait_seconds returns the answer");
  await sleep(400);
  check(!live.notes.some((n) => n.params?.meta?.question === "Ship it?"), "a waited-for answer isn't delivered twice");
  const held = live.call("ab_ask", { question: "Which region?", options: ["EU", "US"] });
  const regionQ = await until(async () => (await state()).questions.find((q) => q.title === "Which region?"));
  await sleep(1500);
  await post(`/api/questions/${regionQ.id}/answer`, { value: "EU" });
  check(/^Answer: EU$/.test((await held).content[0].text), "ab_ask waits for the answer when it isn't told how long (Claude Code)");
  const bumpAsk = await live.call("ab_ask", { question: "Bump the minor?", kind: "approve", wait_seconds: 1 });
  check(/^No answer in 1 second, so question [\w-]+ stays open in their Needs you\. Until it's answered, don't build what it decides/.test(bumpAsk.content[0].text), "one nobody answers in time stays open, and holds what it decides");
  await post(`/api/questions/${bumpAsk.content[0].text.match(/question ([\w-]+)/)[1]}/answer`, { skip: true });

  // ---------- archiving a thread cancels what it asks you ----------
  const tagging = live.call("ab_ask", { question: "Tag a release?", kind: "approve", wait_seconds: 10 });
  const tagQ = await until(async () => (await state()).questions.find((q) => q.title === "Tag a release?" && !q.answered));
  const fmtAsk = (await live.call("ab_ask", { question: "Which changelog format?", options: ["Keep a Changelog", "Plain"], default: "Plain", until: new Date(Date.now() + 3600e3).toISOString(), wait_seconds: 0 })).content[0].text;
  const fmtId = fmtAsk.match(/question ([\w-]+)/)[1];
  check(/If nobody answers by .+, you'll hear that the default applies\.$/.test(fmtAsk), "one with a default and a deadline says the default waits for its deadline");
  const inbox = (await live.call("ab_inbox", {})).content[0].text;
  check(new RegExp(`Still open in their Needs you: .*${fmtId} "Which changelog format\\?".*Don't build what they decide`).test(inbox), "ab_inbox names the questions still open, so \"nothing new\" isn't leave to answer them itself");
  check((await state()).sessions.find((x) => x.id === "sess-2").effective === "needs", "a thread with questions open needs you");
  await post("/api/sessions/sess-2/flag", { archived: true });
  const st2 = await state();
  const s2 = st2.sessions.find((x) => x.id === "sess-2");
  check(s2.archived && !s2.open_questions && s2.effective !== "needs" && [tagQ.id, fmtId].every((id) => st2.questions.find((q) => q.id === id)?.by === "archived"), "archiving a thread closes its open questions first, so it no longer needs you");
  check(/archived this thread/.test((await tagging).content[0].text), "an ab_ask that waits hears the thread was archived");
  const fmtNote = await live.waitNote((n) => n.params?.meta?.question_id === fmtId, 6000);
  check(fmtNote?.params.meta.skipped === "true" && /archived this thread/.test(fmtNote.params.content), "and one that doesn't is told, as a skip");
  check((await post(`/api/questions/${fmtId}/answer`, { value: "Plain" })).status === 409, "a question closed by archiving can't be answered any more");
  const laterAsk = (await live.call("ab_ask", { question: "Push the tag?", kind: "approve", default: "Approve", wait_seconds: 0 })).content[0].text;
  const laterId = laterAsk.match(/question ([\w-]+)/)[1];
  check(/Its default has no deadline \(until\), so it never applies: it waits for their answer\.$/.test(laterAsk), "one with a default but no deadline says it waits for the answer");
  await post(`/api/questions/${laterId}/answer`, { value: "Approve" });
  check(!(await state()).sessions.find((x) => x.id === "sess-2").archived, "and answering a question asked on an archived thread brings it back to the feed");

  // ---------- Codex: threads in its daemon ----------
  const cx = await until(async () => {
    const v = await state();
    return v.sessions.find((x) => x.id === "th-live") && v.sessions.find((x) => x.id === "th-old") ? v : null;
  }, 8000);
  const thOld = cx?.sessions.find((x) => x.id === "th-old");
  const thLive = cx?.sessions.find((x) => x.id === "th-live");
  check(cx?.agents.some((a) => a.id === "codex" && a.kind === "codex") && thLive?.agent === "codex" && thLive.repo === "dashy", "Codex threads are posts on Codex's profile");
  check(thOld?.effective === "done" && thLive?.effective === "idle" && !cx.sessions.some((x) => x.id === "th-sub"), "a thread the daemon hasn't loaded is done, a loaded one is idle, subagents stay off");
  check(thLive.title === "Fix the login bug" && Date.parse(thOld.started) < Date.now() - 3600e3, "they keep Codex's titles and times");
  const quiet = await until(async () => (await state()).sessions.find((x) => x.id === "th-quiet" && x.effective === "done"), 8000);
  check(quiet?.end_reason === "Quiet", "a loaded thread nobody's touched in an hour is over, not idle");
  const cxIdle = (await state()).agents.find((a) => a.id === "codex").idle;
  await post("/api/sessions/th-live/flag", { archived: true });
  check((await state()).agents.find((a) => a.id === "codex").idle === cxIdle - 1, "an archived post doesn't count as live on its agent");
  await post("/api/sessions/th-live/flag", { archived: false });
  await post("/api/sessions/th-live/flag", { hidden: true });
  check((await state()).agents.find((a) => a.id === "codex").idle === cxIdle - 1, "nor does a hidden one");
  await post("/api/sessions/th-live/flag", { hidden: false });
  const oldSteps = await get("/api/sessions/th-old/steps");
  check(oldSteps.steps.some((x) => x.title === "Run npm test" && /2 failing/.test(x.error)) && oldSteps.steps.some((x) => x.title === "Edit importer.js"), "an old thread's steps are read from Codex");
  const webSteps = ["w1", "w2", "w3", "w4"].map((id) => oldSteps.steps.find((x) => x.id === id)?.title);
  check(JSON.stringify(webSteps) === JSON.stringify(["Search the web for “csv parser streaming node ...”", "Read csv.js.org/parse/", "Read csv.js.org/parse/options/ and 1 more", "Find “columns” in csv.js.org/parse/options/"]), `a Codex web search says what it did: searched, read a page, or searched in one, never “” (${JSON.stringify(webSteps)})`);
  const cxChanges = await get("/api/sessions/th-old/changes?scope=all");
  check(cxChanges.files?.some((f) => f.path === "importer.js" && f.add === 1 && f.del === 1) && oldSteps.steps.find((x) => x.title === "Edit importer.js")?.files?.[0]?.add === 1, "a Codex edit's diff is on its step and in the post's Changes");

  // The agents it spawned are its workers, as its calls left them: one done, one that failed and why.
  const cxWorkers = await until(async () => {
    const w = (await get("/api/sessions/th-old")).workers;
    return w?.length === 2 && w;
  }, 6000);
  const [profiled, benched] = ["th-agent-1", "th-agent-2"].map((id) => cxWorkers?.find((w) => w.id === id));
  check(profiled?.state === "done" && profiled.title === "Profile the CSV parser" && benched?.state === "failed" && benched.error === "The sandbox denied network access" && oldSteps.steps.some((x) => x.title === "Wait for its subagents"), "the agents a Codex thread spawned are its workers, as its calls left them");
  // Opened on its thread's page, one's steps are read from its own thread; one Codex has no thread of doesn't open.
  const agentSteps = await get("/api/sessions/th-old/workers/th-agent-1/steps");
  const [profiling, saidAgent] = agentSteps.steps || [];
  check(agentSteps.n === 1 && profiled.n === 0 && profiling?.title === "Run node --cpu-prof importer.js" && profiling.done && !profiling.error && saidAgent?.kind === "say" && /row inserts/.test(saidAgent.text), "a Codex worker's steps are read from its own thread when you open it");
  check((await call(URL + "/api/sessions/th-old/workers/th-agent-2/steps")).status === 502, "and one Codex can't read says so");

  const cxModels = (await state()).agents.find((a) => a.id === "codex")?.models;
  check(cxModels?.default === "gpt-6.1-sol" && cxModels.list.map((m) => m.id).join() === "gpt-6.1-sol,gpt-6-luna", "Codex's profile lists its models, the way its picker does");
  check(cxModels.effort === "medium" && cxModels.list[1].efforts.join() === "minimal,low,medium,high" && cxModels.list[1].effort === "low", "each with the efforts it takes and the one it starts on");
  const cxLaunch = await post("/api/launch", { prompt: "approve the deploy", root: project, agent: "codex", model: "gpt-6-luna", effort: "high", mode: "ask", task: { id: "t-deploy", text: "Ship the deploy" } });
  check(codexLog().some((e) => e.method === "thread/start" && e.params.approvalPolicy === "untrusted" && e.params.approvalsReviewer === "user" && e.params.sandbox === "workspace-write"), "in Ask, Codex asks you before anything it doesn't trust, in a sandbox on its folder");
  check(cxLaunch.status === 200 && codexLog().some((e) => e.method === "thread/start" && e.params.cwd === project && e.params.model === "gpt-6-luna") && codexLog().some((e) => e.method === "turn/start" && e.params.effort === "high"), "posting on Codex's wall starts a thread, on the model and effort you pick");
  const cxq = await until(async () => (await state()).questions.find((q) => q.post === "th-new-1" && q.kind === "permission" && !q.answered), 8000);
  check(cxq?.preview === "make deploy" && (await state()).sessions.find((x) => x.id === "th-new-1")?.effective === "needs", "Codex's approval request is Allow/Deny on the post");
  await post(`/api/questions/${cxq.id}/answer`, { value: "allow" });
  const cxDone = await until(async () => {
    const d = await get("/api/sessions/th-new-1");
    return d.messages.some((m) => m.from === "agent" && m.text === "Deployed.") && d.effective === "idle" ? d : null;
  }, 8000);
  check(codexLog().some((e) => e.answer === "approval" && e.result?.decision === "accept") && cxDone, "allowing it answers Codex, and its reply lands on the post");
  check(cxDone?.messages.filter((m) => m.from === "human" && m.text === "approve the deploy").length === 1 && cxDone.launch === cxLaunch.lid, "the post shows your prompt once, and takes over its placeholder");
  const cxSteps = await get("/api/sessions/th-new-1/steps");
  check(cxSteps.steps.some((x) => x.title === "Run make deploy" && x.done), "its steps come from Codex's items");
  const cxStart = codexLog().find((e) => e.method === "thread/start" && e.params.model === "gpt-6-luna");
  const cxMcp = cxStart?.params.config?.["mcp_servers.agentbook"];
  const cxUrl = cxMcp?.url ? new globalThis.URL(cxMcp.url) : null;
  check(cxUrl?.origin === URL && cxUrl.pathname === "/api/mcp" && cxUrl.searchParams.get("proc") === `launch:${cxLaunch.lid}` && cxUrl.searchParams.get("cwd") === project && !cxMcp.command && cxMcp.default_tools_approval_mode === "approve", "a Codex thread starts with agentbook's MCP server, at its URL, writing to its post, its tools needing no approval");
  const cxTold = cxStart?.params.developerInstructions || "";
  check(cxTold.startsWith("agentbook: this conversation is a thread on tester's agentbook") && cxTold.includes('Sent from tester\'s Tasks: "Ship the deploy"') && cxTold.includes("Working in dashy") && cxTold.includes("comments reach you as your next message") && cxTold.includes("Who sees this thread: only tester."), "and is told about agentbook as its developer instructions: the task, where, how comments reach it, who sees it");
  // Codex speaks MCP's Streamable HTTP: a JSON-RPC message per POST, answered as JSON.
  const rpc = async (u, msg, headers = {}) => {
    const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(msg) });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text().then((t) => (t ? JSON.parse(t) : null)) };
  };
  const cxInit = await rpc(cxMcp.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0" } } });
  const cxNote = await rpc(cxMcp.url, { jsonrpc: "2.0", method: "notifications/initialized" });
  check(cxInit.status === 200 && cxInit.type.startsWith("application/json") && cxInit.body.id === 1 && cxInit.body.result.serverInfo.name === "agentbook" && cxInit.body.result.instructions.includes("The answer arrives as your next message") && !cxInit.body.result.capabilities.experimental && cxNote.status === 202 && !cxNote.body, "agentbook answers Codex's MCP requests over HTTP as JSON, and takes its notifications with a 202");
  const cxTools = (await rpc(cxMcp.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools.map((t) => t.name);
  const cxPosted = await rpc(cxMcp.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ab_post", arguments: { title: "Deploy the release" } } });
  const cxTitled = await until(async () => (await state()).sessions.find((x) => x.id === "th-new-1")?.title === "Deploy the release", 4000);
  check(cxTools.includes("ab_post") && cxTools.includes("ab_inbox") && cxPosted.body.result.content[0].text === "Thread updated." && cxTitled, "with it Codex sets its post's headline (and nothing is made for its thread), and has every tool, an inbox too");
  const cxFile = path.join(project, "deploy-notes.md");
  fs.writeFileSync(cxFile, "# Deploy\nShipped.\n");
  const cxShared = await rpc(cxMcp.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ab_file", arguments: { path: "deploy-notes.md" } } });
  check(cxShared.body.result.content[0].text === "Shared deploy-notes.md on your thread." && (await state()).sessions.find((x) => x.id === "th-new-1")?.last_files?.some((f) => f.name === "deploy-notes.md"), "a path it gives is in the folder it works in");
  const cxBatch = await rpc(cxMcp.url, [{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "nope" }]);
  check(Array.isArray(cxBatch.body) && cxBatch.body[0].result && cxBatch.body[1].error.code === -32601, "a batch gets its answers in one, and a method it doesn't know is an error");
  const sse = await fetch(cxMcp.url, { headers: { accept: "text/event-stream" } });
  const crossSite = await rpc(cxMcp.url, { jsonrpc: "2.0", id: 7, method: "tools/list" }, { origin: "https://evil.example" });
  const noPost = await rpc(`${URL}/api/mcp`, { jsonrpc: "2.0", id: 8, method: "tools/list" });
  check(sse.status === 405 && crossSite.status === 403 && noPost.status === 400, "it has no event stream to open, takes nothing from another site, and needs to know which post");
  check((await state()).sessions.find((x) => x.id === "th-new-1")?.state !== "done", "and Codex leaving doesn't end the post");
  // Threads started in the Codex app or the codex CLI get the same tools, from an entry agentbook puts in Codex's
  // own config: one for all its threads, so each call says which thread made it (`_meta.threadId`, Codex 0.166).
  const cxWrote = codexLog().find((e) => e.method === "config/value/write" && e.params.keyPath === "mcp_servers.agentbook");
  const cxAll = cxWrote?.params.value;
  check(cxAll?.url === `${URL}/api/mcp?agent=codex` && cxAll.default_tools_approval_mode === "approve" && codexLog().some((e) => e.method === "config/mcpServer/reload"), "agentbook puts its tools in Codex's config, so Codex threads it didn't start get them too, the loaded ones at once");
  const allInit = await rpc(cxAll.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "0.166.0" } } });
  check(allInit.body.result.instructions.includes("Visual mode is on") && allInit.body.result.instructions.includes("call ab_verdict"), "and with them, what Visual mode is, since those threads get no context from agentbook");
  const meta = (thread) => ({ callId: "c1", threadId: thread, "x-codex-turn-metadata": { thread_id: thread, turn_id: "tu-x" } });
  const fromApp = await rpc(cxAll.url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ab_update", arguments: { text: "Fixed the login redirect" }, _meta: meta("th-live") } });
  const fromWorker = await rpc(cxAll.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ab_update", arguments: { text: "Profiled the parser" }, _meta: meta("th-agent-1") } });
  const unsaid = await rpc(cxAll.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ab_update", arguments: { text: "Lost" } } });
  const landed = await until(async () => {
    const s = await state();
    const live = s.sessions.find((x) => x.id === "th-live");
    const old = s.sessions.find((x) => x.id === "th-old");
    return live?.updates?.some((u) => u.text === "Fixed the login redirect") && old?.updates?.some((u) => u.text === "Profiled the parser") ? { live, old } : null;
  }, 4000);
  check(fromApp.body.result.content[0].text === "Added to your thread." && fromWorker.body.result.content[0].text === "Added to your thread." && landed, `a call says which Codex thread made it: its post gets it, and an agent a thread spawned writes to that thread's (${JSON.stringify([fromApp.body.result.content[0].text, fromWorker.body.result.content[0].text])})`);
  check(unsaid.body.result.isError && /which thread/.test(unsaid.body.result.content[0].text) && !landed?.live.updates.some((u) => u.text === "Lost"), "and one that doesn't say lands nowhere");

  await post("/api/sessions/th-live/messages", { text: "ask me something" });
  const poll = await until(async () => (await state()).questions.find((q) => q.post === "th-live" && q.title === "Which color?" && !q.answered), 8000);
  check(poll?.kind === "choice" && poll.options.map((o) => o.label).join() === "Blue,Red", "Codex's questions are polls");
  await post(`/api/questions/${poll.id}/answer`, { value: "Blue" });
  const picked = await until(async () => (await get("/api/sessions/th-live")).messages.find((m) => m.text === "You picked Blue"), 8000);
  check(picked && codexLog().some((e) => e.method === "turn/start" && e.params.threadId === "th-live" && e.params.input[0].text === "ask me something"), "your message is a turn, and your answer goes back to Codex");
  await post("/api/sessions/th-live/messages", { text: "ask me again" });
  const poll2 = await until(async () => (await state()).questions.find((q) => q.post === "th-live" && q.title === "Which color?" && !q.answered), 8000);
  await post("/api/sessions/th-live/messages", { text: "Make it green" });
  const greened = await until(() => codexLog().find((e) => ["turn/steer", "turn/start"].includes(e.method) && e.params.threadId === "th-live" && e.params.input[0].text === "Make it green"), 8000);
  const unanswered = codexLog().filter((e) => e.answer === "input").at(-1);
  check(greened && unanswered?.result.answers.color.answers.length === 0 && (await state()).questions.find((q) => q.id === poll2.id)?.by === "comment", "a comment while Codex's question waits leaves it unanswered, and goes to Codex right after");
  await until(async () => (await state()).sessions.find((x) => x.id === "th-live" && !x.busy), 6000);

  await post("/api/sessions/th-live/messages", { text: "slow job" });
  await until(async () => (await state()).sessions.find((x) => x.id === "th-live")?.busy, 6000);
  const cxStop = await post("/api/sessions/th-live/stop", {});
  const idleAgain = await until(async () => (await state()).sessions.find((x) => x.id === "th-live" && !x.busy), 6000);
  check(cxStop.status === 200 && codexLog().some((e) => e.method === "turn/interrupt") && idleAgain, "Stop interrupts Codex's turn");
  await post("/api/sessions/th-live/model", { model: "gpt-6-luna" });
  await post("/api/sessions/th-live/messages", { text: "on luna now" });
  const lunaTurn = await until(() => codexLog().find((e) => e.method === "turn/start" && e.params.input?.[0]?.text === "on luna now"), 6000);
  const thLuna = await until(async () => (await state()).sessions.find((x) => x.id === "th-live" && !x.model_pick && x.model === "gpt-6-luna"), 4000);
  check(lunaTurn?.params.model === "gpt-6-luna" && thLuna, "a Codex thread switches models with its next turn");
  await post("/api/sessions/th-live/mode", { mode: "plan" });
  await post("/api/sessions/th-live/effort", { effort: "low" });
  await post("/api/sessions/th-live/messages", { text: "just plan it" });
  const planTurn = await until(() => codexLog().find((e) => e.method === "turn/start" && e.params.input?.[0]?.text === "just plan it"), 6000);
  const thPlan = await until(async () => (await state()).sessions.find((x) => x.id === "th-live" && !x.mode_pick && !x.effort_pick && x.mode === "plan" && x.effort === "low"), 4000);
  check(planTurn?.params.approvalPolicy === "never" && planTurn.params.sandboxPolicy?.type === "readOnly" && planTurn.params.effort === "low" && thPlan, "and its mode and effort, which its next turn takes for the turns after it too");

  await post("/api/sessions/th-old/messages", { text: "and the exporter too" });
  const revived = await until(async () => (await get("/api/sessions/th-old")).messages.some((m) => m.text === "Done: and the exporter too"), 8000);
  check(revived && codexLog().some((e) => e.method === "thread/resume" && e.params.threadId === "th-old"), "writing on a closed thread resumes it in Codex");
  const resumedMcp = codexLog().find((e) => e.method === "thread/resume" && e.params.threadId === "th-old")?.params.config?.["mcp_servers.agentbook"];
  check(resumedMcp?.url && new globalThis.URL(resumedMcp.url).searchParams.get("proc") === "codex:th-old", "with agentbook's tools again, since Codex keeps them only while a thread is loaded");
  const cxProfile = await until(async () => {
    const v = await get("/api/agents/codex");
    return v.skills?.some((k) => k.name === "deploy") ? v : null;
  }, 9000);
  check(cxProfile, "Codex's profile lists its skills");

  // ---------- the cloud: Codex Cloud tasks, and Claude Code cloud sessions you link ----------
  const task = await until(async () => (await state()).sessions.find((x) => x.id === "task_e_1"), 8000);
  const cs = await state();
  check(task?.agent === "codex" && task.rt?.kind === "cloud" && task.effective === "done" && task.end_reason === "Ready" && task.title === "Add a health check" && task.attachments.task?.data.url.includes("task_e_1"), "Codex Cloud tasks are posts on Codex's profile, linked to Codex Cloud");
  check(cs.sessions.find((x) => x.id === "task_e_2")?.effective === "working" && !cs.sessions.some((x) => x.id === "task_e_old"), "a running task shows as working; old ones stay off");
  check(/hello/.test((await get("/api/sessions/task_e_1/steps")).diff), "a task's change shows as its diff");
  const taskChanges = await get("/api/sessions/task_e_1/changes");
  check(taskChanges.files?.[0]?.path === "health.js" && taskChanges.files[0].kind === "create" && taskChanges.totals.add === 1, "a task's diff is its Changes, file by file");
  const applied = await post("/api/sessions/task_e_1/apply", {});
  const applyCall = fs.readFileSync(path.join(HOME, "codex-cli.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.args[1] === "apply");
  check(applied.status === 200 && applyCall?.args[2] === "task_e_1" && applyCall.cwd === realProject, "applying a task runs codex cloud apply in a checkout of its repository");
  check((await post("/api/sessions/task_e_1/messages", { text: "and more" })).status === 409, "Codex Cloud takes replies on its own page");
  const pulledOld = await post("/api/cloud/pull", { ref: "https://chatgpt.com/codex/tasks/task_e_old" });
  const pulledUnlisted = await post("/api/cloud/pull", { ref: "task_e_0123456789abcdef" });
  const pcs = await state();
  const oldTask = pcs.sessions.find((x) => x.id === "task_e_old");
  const unlisted = pcs.sessions.find((x) => x.id === "task_e_0123456789abcdef");
  check(pulledOld.kind === "codex" && oldTask?.title === "Something from last month" && oldTask.rt?.kind === "cloud", "pulling a Codex Cloud task by its link brings it here, however old");
  check(pulledUnlisted.status === 200 && unlisted?.title === "Tune the retry backoff" && /3 files changed, \+12 −4/.test(unlisted.attachments.task?.data.text), "even one Codex Cloud no longer lists, with its title and change");
  check((await post("/api/cloud/pull", { ref: "https://example.com/nope", root: project })).status === 400, "a link that isn't a cloud session says so");
  check((await post("/api/cloud/pull", { ref: "https://claude.ai/code/session_01ABC" })).status === 400, "a Claude Code cloud session needs a project to teleport into");
  const pulled = await post("/api/cloud/pull", { ref: "https://claude.ai/code/session_01ABC?from=cli&m=0", root: project, visibility: "public" });
  const tl = (await state()).launches.find((l) => l.id === pulled.lid);
  check(pulled.status === 200 && pulled.kind === "claude" && !pulled.opened && pulled.cmd.startsWith(`cd ${project} && AGENTBOOK_LAUNCH_ID=${pulled.lid} `) && pulled.cmd.endsWith(" --teleport session_01ABC"), "pulling a claude.ai/code session teleports it into the project, as a launch of its own");
  check(tl?.teleport === "session_01ABC" && tl.agent === "claude" && !tl.post, "its post waits for it, saying it's teleporting");
  // Run in a terminal with nothing of agentbook's around it, the command still finds agentbook.
  const ran = spawnSync("/bin/sh", ["-c", pulled.cmd], { env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_DIR: FAKE }, encoding: "utf8", timeout: 20000 });
  const teleported = await until(async () => (await state()).sessions.find((x) => x.id === "local-session_01ABC"), 6000);
  const tlAfter = (await state()).launches.find((l) => l.id === pulled.lid);
  check(ran.status === 0 && teleported?.cwd === realProject && tlAfter?.post === "local-session_01ABC", "once it starts here, the session takes the launch's place");
  check(teleported?.attachments.cloud?.data.url === "https://claude.ai/code/session_01ABC" && teleported.attachments.cloud.title === "Teleported from claude.ai" && !teleported.cloud && teleported.visibility === "public", "a local post, linked to where it came from, as private or public as picked");

  // ---------- branches and worktrees ----------
  const shop = path.join(HOME, "dev", "shop");
  fs.mkdirSync(shop, { recursive: true });
  const sh = (...args) => spawnSync("git", ["-C", shop, ...args], { encoding: "utf8" });
  sh("init", "-q", "-b", "main");
  sh("remote", "add", "origin", "git@github.com:Acme/shop.git");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  fs.writeFileSync(path.join(shop, "cart.txt"), "v1\n");
  sh("add", ".");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "cart");
  sh("branch", "feature-x");
  sh("switch", "-q", "-c", "other");
  fs.writeFileSync(path.join(shop, "other.txt"), "only on other\n");
  sh("add", ".");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "other");
  sh("switch", "-q", "main");
  const realShop = fs.realpathSync(shop);
  const branchOf = (dir = shop) => spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const inTree = await post("/api/launch", { prompt: "Add the cart page", root: shop, agent: "claude", worktree: true });
  const treeDir = path.join(shop, ".claude", "worktrees", "add-the-cart-page");
  // A worktree is checked out after the start answers: its session starts once it's there.
  const startedIn = (prompt) => until(() => calls().find((c) => c.args[0] === prompt));
  const treeCall = await startedIn("Add the cart page");
  check(inTree.status === 200 && inTree.making && inTree.branch === "worktree-add-the-cart-page" && fs.realpathSync(treeCall?.cwd || "/") === fs.realpathSync(treeDir) && branchOf() === "main", "a worktree gets a new branch named after the post, where claude --worktree puts it, and the folder stays on its branch");
  const onX = await post("/api/launch", { prompt: "Carry on with x", root: shop, agent: "claude", worktree: true, branch: "feature-x" });
  const again = await post("/api/launch", { prompt: "More on x", root: shop, agent: "claude", worktree: true, branch: "feature-x" });
  const xCalls = [await startedIn("Carry on with x"), await startedIn("More on x")];
  check(xCalls.every((c) => c && fs.realpathSync(c.cwd) === fs.realpathSync(onX.cwd)), "a second start on a branch whose worktree is still being made waits for it, and starts there");
  check(onX.status === 200 && onX.branch === "feature-x" && branchOf(onX.cwd) === "feature-x" && fs.realpathSync(again.cwd) === fs.realpathSync(onX.cwd), "a worktree on a branch checks it out there once, and later posts on it run in that worktree");
  const offOther = await post("/api/launch", { prompt: "Build on other", root: shop, agent: "claude", worktree: true, base: "other" });
  await startedIn("Build on other");
  check(offOther.status === 200 && offOther.branch === "worktree-build-on-other" && fs.existsSync(path.join(offOther.cwd || "/", "other.txt")) && branchOf() === "main", "a worktree can start its new branch off any branch");
  const stuck = await post("/api/launch", { prompt: "x", root: shop, agent: "claude", branch: "feature-x" });
  check(stuck.status === 409 && /checked out in \.claude\/worktrees\/feature-x/.test(stuck.error), "the folder won't switch to a branch that has a worktree, and says where it is");

  runHook("SessionStart", { session_id: "sess-wt", cwd: treeDir, source: "startup" }, { AGENTBOOK_PID: "910050", AGENTBOOK_LABEL: "wren" });
  runHook("UserPromptSubmit", { prompt: "Add the cart page", cwd: treeDir }, { AGENTBOOK_PID: "910050", AGENTBOOK_LABEL: "wren" });
  const wt = (await state()).sessions.find((x) => x.id === "sess-wt");
  check(wt && fs.realpathSync(wt.root) === realShop && wt.repo === "shop" && wt.branch === "worktree-add-the-cart-page", "a session in a worktree belongs to its main checkout's project, on the worktree's branch");
  const listed = await until(async () => (await state()).folders.find((p) => p.name === "shop" && p.branches), 6000);
  check(listed?.branch === "main" && listed.branches.some((b) => b.name === "feature-x" && b.worktree) && listed.branches.some((b) => b.name === "other" && !b.worktree), "a folder sessions ran in lists its branch and its other branches, with their worktrees");
  const branchNames = listed?.branches.map((b) => b.name) || [];
  check(branchNames.length > 2 && branchNames.join() === [...branchNames].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join(), `its branches are in alphabetical order (${branchNames.join(", ")})`);

  fs.writeFileSync(path.join(shop, "cart.txt"), "v2\n");
  const dirty = await post("/api/launch", { prompt: "x", root: shop, agent: "claude", branch: "other" });
  check(dirty.status === 409 && /aren't committed/.test(dirty.error) && branchOf() === "main", "the folder won't switch branches over uncommitted changes");
  sh("checkout", "--", "cart.txt");
  const switched = await post("/api/launch", { prompt: "Work on other", root: shop, agent: "claude", branch: "other" });
  check(switched.status === 200 && branchOf() === "other" && fs.realpathSync(switched.cwd) === realShop, "picking another branch in the folder switches the folder to it");
  const fresh = await post("/api/launch", { prompt: "Try a new idea", root: shop, agent: "claude", fresh: true });
  check(fresh.status === 200 && fresh.branch === "try-a-new-idea" && branchOf() === "try-a-new-idea", "a new branch in the folder is made off its branch and named after the post");
  runHook("SessionStart", { session_id: "sess-shop", cwd: shop, source: "startup" }, { AGENTBOOK_PID: "910051", AGENTBOOK_LABEL: "heron" });
  runHook("UserPromptSubmit", { prompt: "Look at the shop", cwd: shop }, { AGENTBOOK_PID: "910051", AGENTBOOK_LABEL: "heron" });
  runHook("Stop", { stop_hook_active: false, cwd: shop }, { AGENTBOOK_PID: "910051", AGENTBOOK_LABEL: "heron" });
  const busy = await post("/api/launch", { prompt: "x", root: shop, agent: "claude", branch: "main" });
  check(busy.status === 409 && /heron is working in shop/.test(busy.error) && branchOf() === "try-a-new-idea", "nor while another session works in it");
  const beside = await post("/api/launch", { prompt: "Side quest", root: shop, agent: "claude", worktree: true });
  await startedIn("Side quest");
  // One whose checkout fails says git's own last word on its card (not its progress), and leaves nothing behind.
  const hook = path.join(shop, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf 'Updating files:  50%% (1/2)\\rUpdating files: 100%% (2/2)\\n' >&2\necho 'the checkout hook said no' >&2\nexit 1\n", { mode: 0o755 });
  const sour = await post("/api/launch", { prompt: "Sour grapes", root: shop, agent: "claude", worktree: true });
  const sourStart = await until(async () => (await state()).launches.find((l) => l.id === sour.lid && l.error));
  fs.rmSync(hook);
  check(sour.status === 200 && sourStart?.error === "the checkout hook said no" && !fs.existsSync(path.join(shop, ".claude", "worktrees", "sour-grapes")) && !sh("branch", "--list", "worktree-sour-grapes").stdout.trim(), "a worktree whose checkout fails says why on its card, and leaves no folder or branch behind");
  check(beside.status === 200 && beside.branch === "worktree-side-quest", "though a worktree beside it still starts");

  // A session that moves to a worktree (EnterWorktree), or switches branch where it is, says so on its post.
  const heron = { AGENTBOOK_PID: "910051", AGENTBOOK_LABEL: "heron" };
  const TS = path.join(HOME, "heron.jsonl");
  fs.mkdirSync(path.join(shop, "src"));
  write(TS, { type: "user", cwd: shop, message: { content: "carry on" } }, { ...tool("h1", "Bash", { command: "ls" }), cwd: path.join(shop, "src") });
  runHook("UserPromptSubmit", { prompt: "carry on", cwd: shop, transcript_path: TS }, heron);
  await until(async () => (await get("/api/sessions/sess-shop/steps")).steps?.some((x) => x.id === "h1"), 4000);
  await sleep(300);
  const heronOf = async () => (await state()).sessions.find((x) => x.id === "sess-shop");
  let hp = await heronOf();
  check(hp?.branch === "try-a-new-idea" && hp.cwd === shop, "a session moving between folders of its checkout stays where it was on its post");
  // Claude Code moves the transcript along, to the worktree's project folder.
  const TS2 = path.join(HOME, "claude", "projects", "-shop-worktree", "sess-shop.jsonl");
  fs.mkdirSync(path.dirname(TS2), { recursive: true });
  fs.renameSync(TS, TS2);
  write(TS2, { ...tool("h2", "EnterWorktree", { name: "add-the-cart-page" }), cwd: treeDir });
  hp = await until(async () => ((await heronOf())?.branch === "worktree-add-the-cart-page" ? heronOf() : null), 8000);
  check(hp && fs.realpathSync(hp.cwd) === fs.realpathSync(treeDir) && fs.realpathSync(hp.root) === realShop && hp.repo === "shop", "a session that moves into a worktree shows the worktree's branch, still in its project");
  check((await get("/api/sessions/sess-shop/steps")).steps?.some((x) => x.id === "h2"), "its steps carry on from the transcript Claude Code moved");
  spawnSync("git", ["-C", treeDir, "switch", "-q", "-c", "cart-v2"]);
  write(TS2, { ...result("h2"), cwd: treeDir });
  hp = await until(async () => ((await heronOf())?.branch === "cart-v2" ? heronOf() : null), 4000);
  check(hp?.branch === "cart-v2", "a session that switches branch shows the branch it switched to");
  check((await post("/api/launch", { prompt: "x", root: project, agent: "claude", worktree: true })).status === 409, "a folder that isn't a git checkout has no worktrees");

  // ---------- workspaces ----------
  const shopFolder = (await state()).folders.find((f) => f.name === "shop");
  check(shopFolder?.remote === "github.com/acme/shop" && shopFolder.url === "git@github.com:Acme/shop.git" && shopFolder.machine === (await state()).machine, "a folder says which repo it's a clone of, and on which machine");
  const shopWs = await post("/api/workspaces", { repo: shopFolder.remote, url: shopFolder.url });
  let ws = (await state()).workspaces.find((w) => w.id === shopWs.id);
  check(shopWs.status === 200 && ws?.name === "shop" && ws.repo === "github.com/acme/shop" && ws.url === "git@github.com:Acme/shop.git" && ws.folders.length === 0, "a repo becomes a workspace, named after it, cloned the way its checkout was");
  const typed = await post("/api/workspaces", { repo: "https://github.com/acme/shop" });
  check(typed.status === 200 && typed.existing && typed.id === shopWs.id, "adding the same repo, written another way, finds the one you have");
  check((await post("/api/workspaces", { repo: "not a repo" })).status === 400 && (await post("/api/workspaces", {})).status === 400 && (await post("/api/workspaces", { folder: { path: "relative/path" } })).status === 400, "something that isn't a repo or a folder is refused");
  const notesWs = await post("/api/workspaces", { folder: { machine: (await state()).machine, path: project } });
  ws = (await state()).workspaces.find((w) => w.id === notesWs.id);
  check(notesWs.status === 200 && ws?.repo === null && ws.name === path.basename(project) && ws.folders[0]?.path === project, "a folder becomes a workspace on its machine");
  check(await until(() => trustedIn(project)), "and Claude Code is told you trust it, so background sessions start there");
  check((await post(`/api/workspaces/${notesWs.id}`, { name: "Notes" })).status === 200 && (await state()).workspaces.find((w) => w.id === notesWs.id)?.name === "Notes" && (await post(`/api/workspaces/${notesWs.id}`, { name: " " })).status === 400, "a workspace can be renamed, not to nothing");
  const listing = await get(`/api/folders?path=${encodeURIComponent(path.join(HOME, "dev"))}`);
  check(listing.path === fs.realpathSync(path.join(HOME, "dev")) && listing.folders.some((f) => f.name === "shop" && f.git && f.remote === "github.com/acme/shop") && listing.parent === fs.realpathSync(HOME), "a machine lists its folders, marking checkouts and their repos");
  check((await call(`${URL}/api/folders?path=relative`)).status === 400 && (await call(`${URL}/api/folders?path=${encodeURIComponent(path.join(HOME, "nope"))}`)).status === 404, "and says when a folder isn't one");
  const someBranches = await get(`/api/branches?root=${encodeURIComponent(shop)}`);
  check(someBranches.branch && someBranches.branches.some((b) => b.name === "feature-x"), "it lists a checkout's branches when asked");

  // A repo this machine has no checkout of is cloned into the clone folder first, then the session starts there.
  const origin = path.join(HOME, "origin", "tool");
  fs.mkdirSync(origin, { recursive: true });
  spawnSync("git", ["-C", origin, "init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(origin, "README"), "tool\n");
  spawnSync("git", ["-C", origin, "add", "."]);
  spawnSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "tool"]);
  const toolUrl = `file://${origin}`;
  const cloning = await post("/api/launch", { prompt: "Read the tool", agent: "claude", clone: toolUrl });
  const cloned = path.join(HOME, "clones", "tool");
  const cloneCall = await until(() => calls().find((c) => c.args[0] === "Read the tool"), 15000);
  check(cloning.status === 200 && cloning.cloning && fs.existsSync(path.join(cloned, "README")) && fs.realpathSync(cloneCall?.cwd || "/") === fs.realpathSync(cloned), "posting to a repo the machine hasn't got clones it into the clone folder, then starts there");
  const reuse = await post("/api/launch", { prompt: "Read it again", agent: "claude", clone: toolUrl });
  check(reuse.status === 200 && !reuse.cloning && reuse.cwd === cloned && !fs.existsSync(path.join(HOME, "clones", "tool-2")), "and the next time uses that checkout");
  const noRepo = await post("/api/launch", { prompt: "Nothing there", agent: "claude", clone: `file://${path.join(HOME, "origin", "missing")}` });
  const failed = await until(async () => (await state()).launches.find((l) => l.id === noRepo.lid && l.error), 15000);
  check(noRepo.status === 200 && /^Couldn't clone/.test(failed?.error || ""), "a clone that fails says so on the post");
  check((await post("/api/launch", { prompt: "x", agent: "claude", clone: "--upload-pack=touch /tmp/x" })).status === 400, "and something that isn't a repo isn't cloned");

  // Adding a repo none of your machines has a checkout of clones it right away, and a post to it waits for that clone.
  const repoAt = (name) => {
    const dir = path.join(HOME, "origin", name);
    fs.mkdirSync(dir, { recursive: true });
    spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(dir, "README"), `${name}\n`);
    spawnSync("git", ["-C", dir, "add", "."]);
    spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name]);
    return `file://${dir}`;
  };
  const libUrl = repoAt("lib");
  const libDir = path.join(HOME, "clones", "lib");
  const libWs = await post("/api/workspaces", { repo: libUrl });
  check(libWs.status === 200 && libWs.cloning === libDir, "adding a repo no machine has checked out starts cloning it into the clone folder");
  const libFolder = await until(async () => {
    const s = await state();
    return !s.cloning.some((c) => c.dir === libDir) && s.folders.find((f) => f.root === libDir);
  }, 15000);
  const libRepo = (await state()).workspaces.find((w) => w.id === libWs.id)?.repo;
  check(fs.existsSync(path.join(libDir, "README")) && libFolder?.remote === libRepo, "and once it's there, it's a checkout of the workspace's repo");
  check(trustedIn(libDir), "that Claude Code trusts");
  const libAgain = await post("/api/workspaces", { repo: libUrl });
  check(libAgain.existing && !libAgain.cloning, "adding it again doesn't clone it again");
  const kitUrl = repoAt("kit");
  const kitDir = path.join(HOME, "clones", "kit");
  const kitWs = await post("/api/workspaces", { repo: kitUrl });
  const kitPost = await post("/api/launch", { prompt: "Read the kit", agent: "claude", clone: kitUrl });
  const kitCall = await until(() => calls().find((c) => c.args[0] === "Read the kit"), 15000);
  check(kitWs.cloning === kitDir && kitPost.cwd === kitDir && fs.realpathSync(kitCall?.cwd || "/") === fs.realpathSync(kitDir) && !fs.existsSync(path.join(HOME, "clones", "kit-2")), "a post to it while it clones starts in that clone once it's done");
  const goneWs = await post("/api/workspaces", { repo: `file://${path.join(HOME, "origin", "gone")}` });
  const goneErr = await until(async () => (await state()).cloning.find((c) => c.dir === goneWs.cloning && c.error), 15000);
  check(goneWs.status === 200 && /^Couldn't clone/.test(goneErr?.error || "") && !fs.existsSync(goneWs.cloning), "a clone that fails says why, and leaves nothing behind");
  for (const w of [libWs, kitWs, goneWs]) await post(`/api/workspaces/${w.id}/delete`, {});

  // ---------- tasks: your own to-do list ----------
  // Agents' to-dos are tasks too (osprey left one above); these are the person's own.
  const order = async () => (await state()).tasks.filter((t) => !t.done && !t.from).sort((a, b) => a.rank - b.rank).map((t) => t.text);
  const dentist = await post("/api/tasks", { text: "Book the dentist" });
  const notes = await post("/api/tasks", { text: "Write the release notes", workspace: shopWs.id });
  const flaky = await post("/api/tasks", { text: "  Fix the flaky smoke test  " });
  check(dentist.status === 200 && notes.status === 200 && flaky.status === 200 && JSON.stringify(await order()) === JSON.stringify(["Fix the flaky smoke test", "Write the release notes", "Book the dentist"]), "tasks are added on top of your list");
  check((await state()).tasks.find((t) => t.id === notes.id)?.workspace === shopWs.id && (await state()).tasks.find((t) => t.id === dentist.id)?.workspace === null, "a task can belong to one of your workspaces");
  const stray = await post("/api/tasks", { text: "Somewhere else", workspace: "w-nope" });
  check((await state()).tasks.find((t) => t.id === stray.id)?.workspace === null && (await post("/api/tasks", { text: "   " })).status === 400, "not to a workspace that isn't yours, and an empty task is refused");
  await post(`/api/tasks/${stray.id}/delete`, {});
  const forCodex = await post("/api/tasks", { text: "Bump the SDK", workspace: shopWs.id, agent: "codex" });
  check((await state()).tasks.find((t) => t.id === forCodex.id)?.agent === "codex" && (await state()).tasks.find((t) => t.id === dentist.id)?.agent === null, "a task can be for one agent, so sending it picks that agent");
  await post(`/api/tasks/${forCodex.id}`, { agent: "claude" });
  const movedOn = (await state()).tasks.find((t) => t.id === forCodex.id);
  await post(`/api/tasks/${forCodex.id}`, { agent: null, workspace: null });
  const anyone = (await state()).tasks.find((t) => t.id === forCodex.id);
  check(movedOn.agent === "claude" && movedOn.workspace === shopWs.id && movedOn.text === "Bump the SDK" && anyone.agent === null && anyone.workspace === null, "and given to another agent, or to none and no workspace, leaving the rest as it was");
  await post(`/api/tasks/${forCodex.id}/delete`, {});
  check((await post(`/api/tasks/${dentist.id}`, { text: "Book the dentist for Friday" })).status === 200 && (await state()).tasks.find((t) => t.id === dentist.id)?.text === "Book the dentist for Friday" && (await post(`/api/tasks/${dentist.id}`, { text: " " })).status === 400, "a task can be edited, not to nothing");
  await post(`/api/tasks/${flaky.id}/move`, {});
  check(JSON.stringify(await order()) === JSON.stringify(["Write the release notes", "Book the dentist for Friday", "Fix the flaky smoke test"]), "moving a task with nothing after it puts it last");
  await post(`/api/tasks/${flaky.id}/move`, { before: dentist.id });
  check(JSON.stringify(await order()) === JSON.stringify(["Write the release notes", "Fix the flaky smoke test", "Book the dentist for Friday"]), "and before another puts it just before that one");
  for (let i = 0; i < 60; i++) await post(`/api/tasks/${i % 2 ? flaky.id : dentist.id}/move`, { before: i % 2 ? dentist.id : flaky.id });
  check((await order()).length === 3 && new Set((await state()).tasks.map((t) => t.rank)).size === (await state()).tasks.length, "many moves in one place keep every task's place distinct");
  await post(`/api/tasks/${notes.id}/done`, { done: true });
  let tasks = (await state()).tasks;
  check(tasks.find((t) => t.id === notes.id)?.done && tasks.find((t) => t.id === notes.id).done_at && !(await order()).includes("Write the release notes"), "ticking a task marks it done, and it stays in the list as done");
  await post(`/api/tasks/${notes.id}/done`, { done: false });
  check(!(await state()).tasks.find((t) => t.id === notes.id)?.done, "and unticking brings it back");

  // Sending a task to an agent: the session it starts is linked to it.
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-task");
  const forTask = await post("/api/launch", { prompt: "Fix the flaky smoke test", root: project, agent: "claude" });
  check((await post(`/api/tasks/${flaky.id}/send`, { launch: forTask.lid, agent: "claude" })).status === 200 && (await state()).tasks.find((t) => t.id === flaky.id)?.sent[0]?.launch === forTask.lid, "a task remembers the launch it was sent as");
  const taskStart = runHook("SessionStart", { session_id: "sess-task", cwd: project, source: "startup" }, { AGENTBOOK_PID: "910061", AGENTBOOK_LABEL: "egret", AGENTBOOK_LAUNCH_ID: forTask.lid, CLAUDE_JOB_DIR: path.join(HOME, "job") });
  const linked = await until(async () => (await state()).tasks.find((t) => t.id === flaky.id)?.sent[0]?.post === "sess-task");
  const flakyPosts = (await state()).tasks.find((t) => t.id === flaky.id)?.posts || [];
  check(linked && flakyPosts.length === 1 && flakyPosts[0].post === "sess-task" && flakyPosts[0].by === "sent", "and is linked to its post once it starts");

  // Posts and tasks, linked from a post's page: a task has any number of posts, a post any number of tasks.
  {
    const postsOf = async (id) => (await state()).tasks.find((t) => t.id === id).posts.map((e) => `${e.post}:${e.by}`).join();
    const linking = [await post(`/api/tasks/${dentist.id}/link`, { post: "sess-1" }), await post(`/api/tasks/${dentist.id}/link`, { post: "sess-task" }), await post(`/api/tasks/${notes.id}/link`, { post: "sess-1" }), await post(`/api/tasks/${dentist.id}/link`, { post: "sess-1" })];
    check(linking.every((r) => r.status === 200) && (await postsOf(dentist.id)) === "sess-1:you,sess-task:you" && (await postsOf(notes.id)) === "sess-1:you", "a post can be linked to several tasks, and a task to several posts, each once");
    check((await post(`/api/tasks/${dentist.id}/link`, { post: "sess-nope" })).status === 404 && (await post("/api/tasks/k-nope/link", { post: "sess-1" })).status === 404, "but not to a post or a task that isn't there");
    await post(`/api/tasks/${dentist.id}/link`, { post: "sess-1", linked: false });
    await post(`/api/tasks/${notes.id}/link`, { post: "sess-1", linked: false });
    check((await postsOf(dentist.id)) === "sess-task:you" && (await postsOf(notes.id)) === "", "unlinking takes just that post off");
    await post(`/api/tasks/${dentist.id}/link`, { post: "sess-task", linked: false });
  }
  const told = JSON.parse(taskStart.out || "{}").hookSpecificOutput?.additionalContext || "";
  check(told.includes('You appear there as "egret" (Claude)') && told.includes(`${URL}/#/threads/sess-task`) && told.includes('Sent from tester\'s Tasks: "Fix the flaky smoke test"'), "its session is told about agentbook when it starts: its post, and the task it's for");
  check(told.includes("Nobody reads this session's terminal") && told.includes("Working in dashy") && told.includes("Who sees this thread: only tester.") && told.includes("ab_ask instead of stopping to ask"), "that nobody reads its terminal, where it works, who sees the post, and when to use which tool");
  check(told.includes("Tick it off with ab_tasks once it's done") && !told.includes("You can't tick"), "and that it can tick its task off");

  // An agent reads the person's tasks and ticks off what's done: its task, its own to-dos, anyone's. Its to-do for
  // later is a task on their list; another agent with the same one links its post to it rather than adding a copy.
  // (One about its own work stays on its thread: test/task-ship.ts.)
  {
    const egret = startMcp({ AGENTBOOK_PID: "910061", AGENTBOOK_LABEL: "egret", CLAUDE_PROJECT_DIR: project });
    await egret.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    const added = (await egret.call("ab_todo", { text: "Merge the flaky-test fix", later: true })).content[0].text;
    const egretTodo = (await state()).tasks.find((t) => t.text === "Merge the flaky-test fix");
    const ospreyTodo = (await state()).tasks.find((t) => t.text === "Review PR #1");
    check(added.startsWith(`Added to their tasks as ${egretTodo.id}`) && egretTodo.from === "sess-task" && egretTodo.posts[0]?.post === "sess-task" && egretTodo.posts[0].by === "agent" && egretTodo.workspace === notesWs.id && JSON.stringify((await state()).tasks.filter((t) => !t.done).sort((a, b) => a.rank - b.rank)[0]?.id) === JSON.stringify(egretTodo.id), "an agent's to-do is a task on top of the person's list, in its post's workspace, from its post and linked to it");
    const listed = (await egret.call("ab_tasks", {})).content[0].text;
    const at = (s) => listed.indexOf(s);
    check(/^Linked to your thread:\n  k\S+  "Merge the flaky-test fix".*\[your to-do for them\]\n  k\S+  "Fix the flaky smoke test"/.test(listed) && at("Tester's other tasks") < at("Book the dentist") && !listed.includes(ospreyTodo.id), "ab_tasks lists the person's open tasks by id, the ones linked to its post first, says who left a to-do, and leaves out another thread's own");
    const dupe = (await live.call("ab_todo", { text: "Merge the flaky-test fix (PR #12)", later: true })).content[0].text;
    check(dupe.startsWith(`Not added: their list already has ${egretTodo.id}`) && dupe.includes("from egret") && (await state()).tasks.filter((t) => t.text.includes("flaky-test fix")).length === 1, "another agent's to-do that looks the same isn't added: it hears which task has it");
    const linking = (await live.call("ab_tasks", { link: [egretTodo.id, "k-nope"] })).content[0].text;
    const both = (await state()).tasks.find((t) => t.id === egretTodo.id);
    check(linking.includes(`Linked your thread to ${egretTodo.id}`) && linking.includes("k-nope: there's no task") && both.posts.length === 2 && both.posts[0].post === "sess-task" && both.posts[1].post !== "sess-task" && both.posts[1].by === "agent", "so it links its post to that task instead");
    check((await live.call("ab_tasks", { unlink: [egretTodo.id] })).content[0].text.startsWith(`Unlinked your thread from ${egretTodo.id}`) && (await state()).tasks.find((t) => t.id === egretTodo.id).posts.length === 1, "and can unlink it");
    const fresh = (await live.call("ab_todo", { text: "Merge the flaky-test fix (PR #12)", new: true, later: true })).content[0].text;
    const copy = (await state()).tasks.find((t) => t.text === "Merge the flaky-test fix (PR #12)");
    check(fresh.startsWith(`Added to their tasks as ${copy?.id}`), "or adds its own, when it says it's something else");
    await post(`/api/tasks/${copy.id}/delete`, {});
    const ticking = (await egret.call("ab_tasks", { done: [flaky.id, egretTodo.id, "k-nope"] })).content[0].text;
    const byEgret = (await state()).tasks.find((t) => t.id === flaky.id);
    const todoNow = (await state()).tasks.find((t) => t.id === egretTodo.id);
    check(byEgret.done && byEgret.done_by === "agent" && byEgret.done_post === "sess-task" && todoNow.done && todoNow.done_post === "sess-task", "ticking off a task or a to-do says which post did it");
    check(ticking.includes(`Ticked off ${flaky.id} "Fix the flaky smoke test"`) && ticking.includes(`Ticked off ${egretTodo.id}`) && ticking.includes("k-nope: there's no task"), "and the agent hears what it ticked, and which ids aren't on the list");
    const again = (await egret.call("ab_tasks", {})).content[0].text;
    check(!again.includes("Linked to your post") && /Ticked in the last day:[\s\S]*Fix the flaky smoke test.*\(by you\)/.test(again), "what it ticked shows as ticked in the last day, by it");
    check(((await egret.call("ab_tasks", { undone: [flaky.id] })).content[0].text).startsWith(`Put back ${flaky.id}`) && !(await state()).tasks.find((t) => t.id === flaky.id).done, "undone puts a task back");
    await egret.call("ab_tasks", { done: [flaky.id] });
    await post(`/api/tasks/${flaky.id}/done`, { done: false });
    await post(`/api/tasks/${flaky.id}/done`, {});
    check((await state()).tasks.find((t) => t.id === flaky.id).done_by === "you", "and when the person ticks it, it's theirs");
    await post(`/api/tasks/${flaky.id}/done`, { done: false });
    egret.child.kill();
  }
  const flakyNow = (await state()).tasks.find((t) => t.id === flaky.id);
  await post(`/api/tasks/${flaky.id}/delete`, {});
  check(!(await state()).tasks.some((t) => t.id === flaky.id) && (await post(`/api/tasks/${flaky.id}/done`, {})).status === 404, "a task can be deleted");
  const restored = await post("/api/tasks", { text: flakyNow.text, rank: flakyNow.rank, sent: flakyNow.sent, posts: flakyNow.posts });
  tasks = (await state()).tasks;
  check(tasks.find((t) => t.id === restored.id)?.sent[0]?.post === "sess-task" && tasks.find((t) => t.id === restored.id).posts.map((e) => `${e.post}:${e.by}`).join() === "sess-task:sent" && tasks.find((t) => t.id === restored.id).rank === flakyNow.rank, "and put back where it was, with its posts (Undo)");

  check((await post(`/api/workspaces/${notesWs.id}/delete`, {})).status === 200 && !(await state()).workspaces.some((w) => w.id === notesWs.id) && fs.existsSync(project) && (await post(`/api/workspaces/${notesWs.id}/delete`, {})).status === 404, "removing a workspace takes it off the list, and leaves its folder alone");

  // ---------- WIP: a project's branches with work that isn't on main yet ----------
  {
    const shop = path.join(HOME, "dev", "wip-shop");
    fs.mkdirSync(shop, { recursive: true });
    const realShop = fs.realpathSync(shop);
    const gitIn = (cwd) => (...args) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    const g = gitIn(shop);
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(shop, "app.js"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(shop, "README"), "shop\n");
    g("add", "-A");
    g("commit", "-q", "-m", "shop");
    // A branch that landed by fast-forward: git cherry sees none of its commits anymore, but it moved since it was
    // made, so it did work.
    const fastTree = path.join(realShop, ".claude", "worktrees", "fast");
    g("worktree", "add", "-q", "-b", "fast", fastTree);
    fs.writeFileSync(path.join(fastTree, "LICENSE"), "mit\n");
    gitIn(fastTree)("add", "LICENSE");
    gitIn(fastTree)("commit", "-qm", "License");
    g("merge", "-q", "--ff-only", "fast");
    // A worktree with a commit, a change and a new file not committed, while main changes app.js too.
    const cart = path.join(realShop, ".claude", "worktrees", "cart");
    g("worktree", "add", "-q", "-b", "worktree-cart", cart);
    fs.writeFileSync(path.join(cart, "app.js"), "one\ntwo\nthree\ncart\n");
    gitIn(cart)("commit", "-qam", "Add the cart");
    fs.writeFileSync(path.join(cart, "README"), "shop, with a cart\n");
    fs.writeFileSync(path.join(cart, "cart.css"), ".cart {}\n");
    fs.writeFileSync(path.join(shop, "app.js"), "zero\none\ntwo\nthree\n");
    g("commit", "-qam", "Count from zero");
    // A fix cherry-picked onto main has nothing left to land. A branch nobody checked out isn't WIP until a post
    // works on it.
    const fixTree = path.join(realShop, ".claude", "worktrees", "fix");
    g("worktree", "add", "-q", "-b", "fix", fixTree, "HEAD~1");
    fs.writeFileSync(path.join(fixTree, "README"), "shop!\n");
    gitIn(fixTree)("commit", "-qam", "Shout");
    g("cherry-pick", "fix");
    g("branch", "idea");
    // A worktree another tool keeps outside the project (Conductor's) isn't its WIP until a post works there.
    const elsewhere = path.join(HOME, "conductor", "shop", "austin");
    g("worktree", "add", "-q", "-b", "austin", elsewhere);
    fs.writeFileSync(path.join(elsewhere, "README"), "shop, from elsewhere\n");
    gitIn(elsewhere)("commit", "-qam", "Elsewhere");
    await post("/api/hello", { proc: "wip-1", label: "kite", session_id: "wip-sess-1", cwd: cart, root: realShop, repo: "shop", branch: "worktree-cart", host: HOST, pid: 4242 });
    const wipOf = async (branch) => (await state()).folders.find((f) => f.root === realShop)?.wip?.find((w) => w.branch === branch);
    const cartWip = await until(() => wipOf("worktree-cart"), 8000);
    const fixWip = await wipOf("fix");
    check(cartWip?.ahead === 1 && cartWip.behind === 2 && cartWip.dirty === 2 && cartWip.place === ".claude/worktrees/cart" && fixWip?.ahead === 0 && fixWip.commits === 1 && !(await wipOf("main")) && !(await wipOf("idea")) && !(await wipOf("austin")), "a project's WIP is the branches of the worktrees in its folder: what isn't on main (a cherry-picked commit is), how far behind, and what isn't committed");
    check(cartWip?.fork?.subject === "License" && cartWip.fork.sha === g("rev-parse", "worktree-cart~1").stdout.trim() && cartWip.base_head?.subject === "Shout" && cartWip.base_head.sha === g("rev-parse", "main").stdout.trim(), "and the commit it left main at, and main's latest, for the timeline");
    await post("/api/hello", { proc: "wip-2", label: "wren", session_id: "wip-sess-2", cwd: realShop, root: realShop, repo: "shop", branch: "idea", host: HOST, pid: 4243 });
    const idea = await until(() => wipOf("idea"), 8000);
    check(idea && !idea.worktree && idea.ahead === 0, "and each branch a post worked on, checked out or not");
    const fastWip = await wipOf("fast");
    check(fastWip?.worked && fastWip.ahead === 0 && fastWip.commits === 0 && fixWip?.worked && cartWip.worked && !idea.worked, "a branch with nothing left to land worked if it had commits, cherry-picked or fast-forwarded onto main, and didn't if it never moved");
    await post("/api/hello", { proc: "wip-3", label: "lark", session_id: "wip-sess-3", cwd: fs.realpathSync(elsewhere), root: realShop, repo: "shop", branch: "austin", host: HOST, pid: 4244 });
    const austin = await until(() => wipOf("austin"), 8000);
    check(austin?.ahead === 1 && !austin.place, "a worktree outside its folder too, once a post works there");
    const q = (branch, more = "") => `root=${encodeURIComponent(realShop)}&branch=${encodeURIComponent(branch)}${more}`;
    const detail = await get(`/api/wip?${q("worktree-cart")}`);
    check(detail.commits?.length === 1 && detail.commits[0].subject === "Add the cart" && !detail.commits[0].landed && detail.main?.some((c) => c.subject === "Count from zero" && c.overlap.includes("app.js")) && detail.overlap?.sort().join() === "README,app.js", "its page lists its commits, and main's since it branched with the files they share");
    const unc = Object.fromEntries((detail.uncommitted || []).map((f) => [f.path, f]));
    check(unc.README?.add === 1 && unc.README.del === 1 && unc["cart.css"]?.untracked && unc["cart.css"].add === 1 && detail.committed?.[0]?.path === "app.js" && detail.committed[0].on_main, "and its changes: committed since it branched, and not committed in its worktree");
    const committedDiff = await get(`/api/wip/diff?${q("worktree-cart", "&path=app.js&scope=committed")}`);
    const newFile = await get(`/api/wip/diff?${q("worktree-cart", "&path=cart.css&scope=uncommitted")}`);
    check(committedDiff.hunks?.[0]?.lines.includes("+cart") && newFile.kind === "create" && newFile.hunks?.[0]?.lines.join() === "+.cart {}", "each file opens to its diff, a new one whole");
    const outside = await call(`${URL}/api/wip/diff?${q("worktree-cart", "&path=../../etc/hosts&scope=uncommitted")}`);
    const notProject = await call(`${URL}/api/wip?root=${encodeURIComponent(HOME)}&branch=main`);
    check(outside.status === 400 && notProject.status === 404, "it reads only the project's own files, and only projects sessions ran in");
    await post("/api/hello", { proc: "wip-4", label: "heron", session_id: "wip-sess-4", cwd: fixTree, root: realShop, repo: "shop", branch: "fix", host: HOST, pid: 4245 });
    const refused = await post("/api/wip/clean", { root: realShop, branch: "worktree-cart" });
    const cleaned = await post("/api/wip/clean", { root: realShop, branch: "fix" });
    const left = g("branch", "--list").stdout;
    check(refused.status === 409 && fs.existsSync(cart) && cleaned.status === 200 && !fs.existsSync(fixTree) && !/\bfix\b/.test(left) && /worktree-cart/.test(left), "Clean up removes a worktree and its branch once everything on it is on main, and refuses before");
    const posts = (await state()).sessions;
    check(posts.find((x) => x.id === "wip-sess-4")?.landed === "fix" && !posts.find((x) => x.id === "wip-sess-1")?.landed, "and its posts keep that their branch landed, once it's gone");
    const cartSha = g("rev-parse", "worktree-cart").stdout.trim();
    const moved = await post("/api/wip/discard", { root: realShop, branch: "worktree-cart", sha: "0".repeat(40) });
    const discarded = await post("/api/wip/discard", { root: realShop, branch: "worktree-cart", sha: cartSha });
    const after = g("branch", "--list").stdout;
    const offWip = await until(async () => !(await wipOf("worktree-cart")), 8000);
    check(moved.status === 409 && discarded.status === 200 && discarded.sha === cartSha && !fs.existsSync(cart) && !/worktree-cart/.test(after) && offWip, "Discard removes a worktree and its branch with a commit not on main and files not committed, once it's on the commit you saw");
    check(!(await state()).sessions.find((x) => x.id === "wip-sess-1")?.landed, "and its posts don't say it landed");
  }

  // ---------- names ----------
  {
    // A new thread's bird is one no other open thread has, so a name in a message means one thread. One given by
    // hand (AGENTBOOK_LABEL) stays as it is.
    const { bird } = await import(path.join(ROOT, "lib", "common.ts"));
    const procs = Array.from({ length: 200 }, (_, i) => `names-${i}`);
    const [p1, p2] = procs.filter((p) => bird(p) === bird(procs[0]));
    await post("/api/hello", { proc: p1, label: bird(p1), session_id: "names-sess-1", host: HOST, pid: 4301 });
    await post("/api/hello", { proc: p2, label: bird(p2), session_id: "names-sess-2", host: HOST, pid: 4302 });
    await post("/api/hello", { proc: "names-x", label: bird(p1), session_id: "names-sess-3", host: HOST, pid: 4303 });
    // Even the name its own process would get, which another open thread has: the name alone can't say it's by hand.
    const own = bird(`${HOST}-910077`);
    await post("/api/hello", { proc: ["names-a", "names-b"].find((p) => bird(p) !== own), label: own, session_id: "names-sess-4", host: HOST, pid: 4304 });
    runHook("SessionStart", { session_id: "names-sess-5", cwd: project, source: "resume" }, { AGENTBOOK_PID: "910077", AGENTBOOK_LABEL: own });
    const named = Object.fromEntries((await state()).sessions.filter((x) => x.id.startsWith("names-sess-")).map((x) => [x.id, x.label]));
    check(named["names-sess-1"] === bird(p1) && named["names-sess-2"] && named["names-sess-2"] !== bird(p1) && named["names-sess-3"] === bird(p1), "two open threads don't get the same bird, though one named by hand keeps its name");
    check(named["names-sess-5"] === own, "and so does one whose name is the bird its own process would get");
  }

  // ---------- persistence ----------
  live.child.kill();
  server.kill();
  await sleep(300);
  server = startServer();
  await waitHealthy();
  s = await state();
  const kept = s.sessions.find((x) => x.id === "sess-1");
  check(kept?.title === "Add an embed widget" && kept.stats?.worked_ms === 65000 && kept.prs?.["https://github.com/x/dashy/pull/7"] && s.agents.length >= 1, "posts, with their transcript summaries, survive a restart");
  check(s.workspaces.some((w) => w.id === shopWs.id && w.repo === "github.com/acme/shop"), "and so do workspaces");
  check(s.tasks.find((t) => t.id === dentist.id)?.text === "Book the dentist for Friday" && s.tasks.find((t) => t.id === restored.id)?.sent[0]?.post === "sess-task" && s.tasks.find((t) => t.id === restored.id).posts[0]?.post === "sess-task" && s.tasks.find((t) => t.text === "Review PR #1")?.from === "sess-1", "and tasks, with their posts");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill();
  fakeCodex.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
