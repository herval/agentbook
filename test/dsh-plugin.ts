#!/usr/bin/env node
// agentbook's plugin for DeepSeek Harness (plugin/dsh), in a stand-in for the dsh process it's added to: a Cordis-
// shaped ctx whose events the test sends as dsh would (session/event with what dsh writes to a session's log,
// agent/status, agent/error, subagent/start and /end, the approval and question waterfalls), with dsh's services
// (its agents, its web app's session controller, its questions, its loader), against a test agentbook. A session you
// write to in dsh's web app is a thread, with its turns from before (its log), what you wrote, its steps, its reply,
// its title, whether it's working, and agentbook's tools; its errors and subagents show. What you write on it goes to
// dsh as its web app sends it, Stop stops it, what it asks is Allow/Deny or a question on it too (the first answer
// wins); after the connection was down, what happened meanwhile is read from its log. A thread you start on
// agentbook starts in dsh's web app, on its models, with agentbook's tools and instructions, and a model you pick for
// it goes there. Run: node test/dsh-plugin.ts

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-dsh-plugin-")));
const PORT = testPort(4700);
const URL = `http://127.0.0.1:${PORT}`;
const DSH_HOME = path.join(HOME, "dsh");
const project = path.join(HOME, "dev", "app");
for (const d of [DSH_HOME, project, path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [path.join(HOME, "dev")], starts_per_hour: 1000 }));
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_DSH: "1", AGENTBOOK_DSH_BIN: path.join(HOME, "no-dsh"), DSH_HOME };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR"]) delete env[k];
process.env.DSH_HOME = DSH_HOME;
process.env.AGENTBOOK_HOME = HOME; // the key the plugin reads, here in this process

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}) => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const state = () => stateOf(get);
const detail = (id: string) => get(`/api/sessions/${encodeURIComponent(id)}`);
const steps = async (id: string) => (await get(`/api/sessions/${encodeURIComponent(id)}/steps`)).steps || [];
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const thread = async (id: string) => (await state()).sessions.find((x) => x.id === id);
const said = (id: string, from: string, text: string | RegExp) => until(async () => (await detail(id)).messages?.find((m) => m.from === from && (text instanceof RegExp ? text.test(m.text) : m.text === text)));

// ---------- a stand-in dsh ----------

// A session as dsh keeps it: its header, and its log ($DSH_HOME/sessions/--<folder>--/<id>/session.v4.jsonl.zstd).
// Its agent, as dsh has it live: what's sent to it, its cancels, and the plugins mounted on it.
// A message the plugin hands a live agent, and a request it makes of dsh web's session controller.
type AgentMessage = { id?: string; role?: string; content?: { type: string; text?: string }[]; source?: { kind?: string; rpcId?: string } };
type ControllerRequest = { sessionId?: string; requestId?: string; mode?: string; content?: { type: string; text?: string }[]; workspaceId?: string; cwd?: string; provider?: string; model?: string; reasoningEffort?: string };
type McpConfig = { transport?: string; serverName?: string; url?: string };
interface LiveAgent {
  id: string;
  status: string;
  session: { id: string; header: object };
  sent: { how: string; m: AgentMessage }[];
  cancels: { cause: unknown; opts: unknown }[];
  mounts: { mod: unknown; cfg: McpConfig }[];
  steer?(m: AgentMessage): void;
  followup?(m: AgentMessage): void;
  cancel?(cause: unknown, opts?: unknown): void;
  ctx?: { plugin(mod: unknown, cfg: McpConfig): Promise<void> };
  inject?(m: AgentMessage): void;
}
const live = new Map<string, LiveAgent>();
function session(cwd: string, { parent }: { parent?: string } = {}) {
  const id = crypto.randomUUID();
  const header = { version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, ...(parent ? { parentSession: parent, origin: "subagent" } : {}) };
  const file = path.join(DSH_HOME, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\]/g, "-")}--`, id, "session.v4.jsonl.zstd");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, zlib.zstdCompressSync(JSON.stringify({ type: "session", ...header }) + "\n"));
  const agent: LiveAgent = { id, status: "idle", session: { id, header }, sent: [], cancels: [], mounts: [] };
  agent.steer = (m) => agent.sent.push({ how: "steer", m });
  agent.followup = (m) => agent.sent.push({ how: "followup", m });
  agent.cancel = (cause, opts) => agent.cancels.push({ cause, opts });
  agent.ctx = { plugin: async (mod, cfg) => void (agent.mounts.push({ mod, cfg }), order.push(`mount ${id}`)) };
  agent.inject = (m) => agent.sent.push({ how: "inject", m });
  live.set(id, agent);
  return { id, header, file, seq: 0, agent };
}
// A record, as dsh writes it: to the log (unless `live` only), and to its plugin.
type DshSession = ReturnType<typeof session>;
function record(s: DshSession, type: string, data: object, { log = true, live = true } = {}) {
  const e = { type, seq: ++s.seq, time: Date.now(), data };
  if (log) fs.appendFileSync(s.file, zlib.zstdCompressSync(JSON.stringify(e) + "\n"));
  if (live) dsh.emit("session/event", { id: s.id, header: s.header }, e);
  return e;
}
const user = (text: string, kind = "user") => ({ role: "user", id: crypto.randomUUID(), content: [{ type: "text", text }], source: { kind } });
const assistant = (blocks: object[], model = "deepseek-flash") => ({ message: { role: "assistant", id: crypto.randomUUID(), content: blocks, source: { kind: "assistant", provider: "deepseek-account", model } }, usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 0, totalTokens: 3940 } });
const toolResult = (callId: string, text: string, isError = false) => ({ message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }], isError, id: crypto.randomUUID() } });
function tool(s: DshSession, turn: number, name: string, input: object, out: string, opts?: { log?: boolean; live?: boolean }) {
  const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
  record(s, "assistant/message", assistant([{ type: "tool-call", id: callId, name, arguments: JSON.stringify(input) }]), opts);
  record(s, "tool/call", { turn, step: 1, callId, name, arguments: JSON.stringify(input) }, opts);
  record(s, "tool/result", { turn, step: 1, ...toolResult(callId, out) }, opts);
}

// dsh's web app's session controller, as the plugin uses it: a prompt (dsh opens the session first) and Stop.
const prompts: { request: ControllerRequest; source: { kind?: string; rpcId?: string } }[] = [];
const stops: ControllerRequest[] = [];
const creates: (ControllerRequest & { sessionId: string })[] = [];
const picks: ControllerRequest[] = [];
const order: string[] = []; // what the plugin did to a session, in order
const CATALOG = {
  default: { provider: "deepseek-official", model: "deepseek-v4-flash" },
  routableProviders: ["deepseek-official"],
  groups: [
    { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "high", name: "High" }], defaultEffort: "off" } }] },
    { id: "nokey", name: "No key", models: [{ id: "big", name: "Big" }] },
  ],
  failures: [],
};
const lateAnswers: { agent: LiveAgent; callId: string; answer: { answers: { selected: string[] }[] } }[] = [];
const controller = {
  commands: {
    async prompt(request: ControllerRequest, source: { kind?: string; rpcId?: string }) {
      prompts.push({ request, source });
      order.push(`prompt ${request.sessionId}`);
      const agent = live.get(request.sessionId);
      if (!agent) throw new Error(`session "${request.sessionId}" not found`);
      (request.mode === "steer" ? agent.steer : agent.followup)({ content: request.content, source, role: "user" });
      return { accepted: true };
    },
    cancel(request: ControllerRequest) {
      stops.push(request);
      return { accepted: true };
    },
    // A new session, as dsh's New Session makes one: in a workspace, or a folder.
    async create(request: ControllerRequest) {
      const s = session(request.workspaceId === "ws-app" ? project : request.cwd);
      creates.push({ ...request, sessionId: s.id });
      sessions.set(s.id, s);
      dsh.emit("agent/created", { agent: s.agent });
      return { sessionId: s.id };
    },
    async selectModel(request: ControllerRequest) {
      picks.push(request);
      order.push(`model ${request.sessionId}`);
      const g = CATALOG.groups.find((x) => x.id === request.provider);
      if (!CATALOG.routableProviders.includes(request.provider) || !g?.models.some((m) => m.id === request.model)) throw new Error(`model "${request.provider}/${request.model}" is not available`);
      return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) } };
    },
  },
  modelCatalog: async () => CATALOG,
};
const sessions = new Map<string, DshSession>(); // the ones dsh web made
const workspaceRegistry = { resolveByPath: async (p: string) => (p === project ? { id: "ws-app", path: project } : undefined) };
const fakeMcp = { name: "mcp-client", inject: ["tools"], apply() {} };

// The Cordis-shaped ctx the plugin gets: on() for events (prepend: true puts one first), effect() for what it undoes
// when unloaded, inject() for dsh's services (its web app's session controller unless `app` is false), its loader.
type Listener = (...args: unknown[]) => unknown;
function standIn({ app = true } = {}) {
  const listeners = new Map<string, Listener[]>();
  const undo: ((() => void) | undefined)[] = [];
  const services: Record<string, unknown> = { agents: { get: (id: string) => live.get(id) }, userQuestions: { answer: (agent: LiveAgent, callId: string, answer: { answers: { selected: string[] }[] }) => lateAnswers.push({ agent, callId, answer }) }, ...(app ? { sessionController: controller, workspaceRegistry } : {}) };
  return {
    on(name: string, fn: Listener, opts?: true | { prepend?: boolean }) {
      const list = listeners.get(name) || listeners.set(name, []).get(name);
      if (opts === true || opts?.prepend) list.unshift(fn);
      else list.push(fn);
      return () => listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn));
    },
    effect(fn: () => (() => void) | undefined) {
      undo.push(fn());
    },
    inject(names: string[], fn: (services: Record<string, unknown>) => void) {
      if (names.every((n) => services[n])) fn({ ...services, effect() {} });
    },
    loader: { internal: { import: async (name: string) => (name === "@deepseek-ai/dsh-mcp-client" ? fakeMcp : null) } },
    baseUrl: "file:///profile/",
    logger: () => ({ debug() {} }),
    emit(name: string, ...args: unknown[]) {
      for (const fn of listeners.get(name) || []) fn(...args);
    },
    // A waterfall, as Cordis runs one: each listener gets the request and next(); `inner` is dsh's own last answer.
    waterfall<R>(name: string, request: R, inner: (request: R) => unknown) {
      const chain = [...(listeners.get(name) || [])];
      const next = (): unknown => (chain.length ? chain.shift()(request, next) : inner(request));
      return Promise.resolve().then(next);
    },
    dispose() {
      for (const fn of undo.splice(0)) fn?.();
      listeners.clear();
    },
  };
}
const plugin = await import(path.join(TEST, "..", "plugin", "dsh", "index.js"));
const VERSION = JSON.parse(fs.readFileSync(path.join(TEST, "..", "plugin", "dsh", "package.json"), "utf8")).version;
let dsh = standIn();
const status = (s: DshSession, st: string) => {
  s.agent.status = st;
  dsh.emit("agent/status", { agent: s.agent, status: st });
};
const question = (pred: (q: Json) => unknown) => until(async () => (await state()).questions.find((q) => !q.answered && pred(q)));

let serverLog = "";
let server: Agentbook | undefined;
try {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- connecting ----------
  check((await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.status === "Not found", "without dsh here or its plugin, DeepSeek Harness isn't found");
  plugin.apply(dsh, { url: URL, profile: "web" });
  const agent = await until(async () => (await state()).agents?.find((a) => a.id === "dsh"));
  check(agent?.kind === "dsh" && agent.name === "DeepSeek", "once its plugin connects, DeepSeek is a profile, without dsh on agentbook's PATH");
  const row = (await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh");
  check(row?.ok && row.status === "Ready" && row.detail.includes(`sessions in web are threads too (agentbook's plugin ${VERSION})`) && /Threads you start from agentbook run in DeepSeek's web app, on its models and keys\./.test(row.detail), `Add agents says its sessions in dsh web are threads, and that the threads you start run there (${row?.detail})`);

  // A page can't connect: a browser says which page it is.
  const fromPage = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/dsh/ws", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64"), origin: "https://evil.example" } });
    r.on("upgrade", () => resolve(101));
    r.on("response", (res) => resolve(res.statusCode));
    r.on("error", () => resolve(null));
    r.end();
  });
  check(fromPage === 403, "a page in a browser can't connect as dsh's plugin");

  // ---------- a session from before, opened in dsh web ----------
  const a = session(project);
  record(a, "turn/start", { turn: 1 }, { live: false });
  record(a, "user/message", user("Look around"), { live: false });
  tool(a, 1, "glob", { pattern: "**/*.md", path: "." }, "README.md", { live: false });
  record(a, "assistant/message", assistant([{ type: "text", text: "There's a README." }]), { live: false });
  record(a, "turn/end", { turn: 1, reason: { kind: "completed" } }, { live: false });
  record(a, "session/title", { title: "Look around the app", source: { kind: "first-prompt" } }, { live: false });
  status(a, "idle");
  await sleep(500);
  check(!(await thread(a.id)), "a session that's only open isn't a thread: nothing was written to it");

  // ---------- writing to it there ----------
  status(a, "running");
  record(a, "turn/start", { turn: 2 });
  record(a, "user/message", user("Today is Monday.", "time-context"));
  record(a, "user/message", user("Fix the failing test"));
  const t = await until(() => thread(a.id));
  check(t && t.agent === "dsh" && t.effective === "working", "writing to it in dsh web makes it a thread, working");
  check(await said(a.id, "human", "Fix the failing test"), "what you wrote there shows as yours, and what dsh tells the model doesn't");
  check((await detail(a.id)).messages.filter((m) => m.from === "human").length === 1, "only once");
  tool(a, 2, "bash", { command: "npm test", description: "Run the tests" }, "1 failing");
  record(a, "assistant/message", assistant([{ type: "reasoning", text: "Hmm." }, { type: "text", text: "Fixing the date parser." }, { type: "tool-call", id: "call_x", name: "edit", arguments: "{}" }]));
  record(a, "tool/call", { turn: 2, step: 2, callId: "call_x", name: "edit", arguments: JSON.stringify({ file_path: path.join(project, "src/date.js"), old_string: "a", new_string: "b" }) });
  record(a, "tool/result", { turn: 2, step: 2, ...toolResult("call_x", "ok") });
  record(a, "assistant/message", assistant([{ type: "text", text: "All green now." }]));
  const live = await until(async () => {
    const s = await steps(a.id);
    return s.some((x) => x.kind === "tool" && /npm test/.test(x.title) && x.done) && s;
  });
  check(live && live.some((x) => x.kind === "tool" && /\*\*\/\*\.md|README|Glob|Find/.test(`${x.tool} ${x.title}`)) && live.some((x) => x.kind === "say" && x.text === "Fixing the date parser."), "its steps show as it works, with its turn from before (its log)");
  record(a, "turn/end", { turn: 2, reason: { kind: "completed" } });
  status(a, "idle");
  check(await said(a.id, "agent", "All green now."), "its reply is what it said last, once the turn ends");
  check(!(await detail(a.id)).messages.some((m) => m.text === "Fixing the date parser."), "not what it said before a tool");
  check(await until(async () => (await thread(a.id))?.effective !== "working"), "and it rests");
  const t2 = await thread(a.id);
  check(t2?.title === "Look around the app", `its title is dsh's${t2?.title === "Look around the app" ? "" : ` (${t2?.title})`}`);

  // ---------- agentbook's tools on it ----------
  const mount = await until(() => a.agent.mounts[0]);
  check(mount?.mod === fakeMcp && mount.cfg.transport === "streamable-http" && mount.cfg.serverName === "agentbook" && mount.cfg.url.startsWith(`${URL}/api/mcp?`) && new globalThis.URL(mount.cfg.url).searchParams.get("proc") === `dsh:${a.id}`, "once it's a thread, its agent gets agentbook's tools, writing to the thread (dsh's MCP client, loaded by dsh's loader)");
  check(a.agent.mounts.length === 1, "once");

  // ---------- writing to it from agentbook ----------
  const sent = await post(`/api/sessions/${a.id}/messages`, { text: "Also update the docs" });
  const p1 = await until(() => prompts.find((p) => p.request.content?.[0]?.text === "Also update the docs"));
  check(sent.status === 200 && p1?.request.sessionId === a.id && p1.request.mode === "queue" && p1.source.kind === "user" && /^agentbook-/.test(p1.request.requestId) && p1.source.rpcId === p1.request.requestId, "what you write on it goes to dsh as its web app sends it: yours, starting a turn while it rests");
  // dsh writes it to the session as yours, with agentbook's id for it.
  status(a, "running");
  record(a, "turn/start", { turn: 21 });
  record(a, "user/message", { ...user("Also update the docs"), source: { kind: "user", rpcId: p1.request.requestId } });
  tool(a, 21, "edit", { file_path: path.join(project, "README.md"), old_string: "a", new_string: "b" }, "ok");
  await until(async () => (await thread(a.id))?.effective === "working");
  await sleep(300);
  check((await detail(a.id)).messages.filter((m) => m.text === "Also update the docs").length === 1, "it shows once, as you wrote it here");
  await post(`/api/sessions/${a.id}/messages`, { text: "Mention the new flag too" });
  const p2 = await until(() => prompts.find((p) => p.request.content?.[0]?.text === "Mention the new flag too"));
  check(p2?.request.mode === "steer" && a.agent.sent.at(-1)?.how === "steer", "while it works, what you write reaches it at its next step");

  // ---------- what it asks ----------
  // Before a tool runs: on agentbook, and in dsh web's own prompt (its page closes it once the request's signal aborts).
  record(a, "tool/call", { turn: 21, step: 3, callId: "call_rm", name: "bash", arguments: JSON.stringify({ command: "rm -rf build", description: "Clean" }) });
  let pageClosed = false;
  const asking = { agent: a.agent, toolName: "bash", callId: "call_rm", reason: "escalate sandbox to danger-full-access: delete the build folder", signal: new AbortController().signal };
  const allowed = dsh.waterfall("approval/request", asking, (r) => {
    r.signal.addEventListener("abort", () => (pageClosed = true));
    return new Promise(() => {}); // a page that has it open, and doesn't answer
  });
  const perm = await question((q) => q.post === a.id && q.kind === "permission");
  check(perm?.preview === "rm -rf build" && perm.tool_name === "Terminal" && /delete the build folder/.test(perm.detail), "what it asks before a tool runs is Allow/Deny on the thread, with the command");
  await post(`/api/questions/${perm.id}/answer`, { value: "allow" });
  check((await Promise.race([allowed, sleep(5000).then(() => "no answer")])) === "allowed-once" && pageClosed, "allowing it there lets it go ahead, and dsh web's own prompt closes");
  // Answered in dsh web first: agentbook's goes.
  const there = dsh.waterfall("approval/request", { agent: a.agent, toolName: "bash", callId: "call_rm2", signal: new AbortController().signal }, () => sleep(700).then(() => "rejected"));
  const perm2 = await question((q) => q.post === a.id && q.kind === "permission");
  check((await there) === "rejected", "answered in dsh web, dsh takes that answer");
  const closed = await until(async () => (await state()).questions.find((q) => q.id === perm2?.id && q.answered));
  check(closed && closed.value === "deny", `and the Allow/Deny on agentbook closes with it (${closed?.value}, by ${closed?.by})`);
  // Its ask_user_question, with nothing in dsh to answer it: agentbook's answer it is.
  const asked = dsh.waterfall("user-questions/request", { agent: a.agent, questions: [{ id: "db", question: "Which database?", header: "Storage", options: [{ label: "Postgres", description: "The one in prod" }, { label: "SQLite" }] }], signal: new AbortController().signal, wait: { callId: "call_q" } }, () =>
    Promise.reject(Object.assign(new Error("no user-questions answerer accepted the request"), { code: "NO_PROVIDER" })),
  );
  const q1 = await question((q) => q.post === a.id && q.title === "Which database?");
  check(q1?.kind === "choice" && q1.options.map((o) => o.label).join() === "Postgres,SQLite" && q1.options[0].detail === "The one in prod" && q1.detail === "Storage", "its questions show on the thread, with their options");
  await post(`/api/questions/${q1.id}/answer`, { value: "SQLite" });
  const a1 = await Promise.race([asked, sleep(5000).then(() => null)]);
  check(a1?.answers?.length === 1 && a1.answers[0].id === "db" && a1.answers[0].selected.join() === "SQLite", "answered there, dsh gets the answer");
  // One whose wait in dsh ran out (a timed question, continued): agentbook's answer still goes, through dsh's questions.
  const wait = new AbortController();
  const timed = dsh.waterfall("user-questions/request", { agent: a.agent, questions: [{ id: "ship", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }], signal: wait.signal, wait: { callId: "call_ship", timed: true } }, () => new Promise(() => {}));
  const q2 = await question((q) => q.post === a.id && q.title === "Ship it?");
  wait.abort(new Error("ask_user_question timed out before the user answered"));
  check((await timed.then(() => "answered", () => "continued")) === "continued" && q2, "a question whose wait in dsh runs out stays open on the thread");
  await post(`/api/questions/${q2.id}/answer`, { value: "Yes" });
  const late = await until(() => lateAnswers[0]);
  check(late?.callId === "call_ship" && late.agent === a.agent && late.answer.answers[0].selected.join() === "Yes", "and answered later, the answer reaches dsh");
  // A session that isn't a thread asks only in dsh.
  const other = session(project);
  status(other, "idle");
  const alone = await dsh.waterfall("approval/request", { agent: other.agent, toolName: "bash", callId: "x", signal: new AbortController().signal }, () => "unavailable");
  await sleep(300);
  check(alone === "unavailable" && !(await state()).questions.some((q) => q.post === other.id), "a session that isn't a thread asks only in dsh");

  // ---------- Stop ----------
  const stopped = await post(`/api/sessions/${a.id}/stop`);
  check(stopped.status < 300 && stops.some((s) => s.sessionId === a.id), "Stop stops it, as dsh web's Stop does");
  record(a, "turn/end", { turn: 21, reason: { kind: "cancelled" } });
  status(a, "idle");
  check(await until(async () => (await thread(a.id))?.effective !== "working"), "and it rests");

  // ---------- an error ----------
  record(a, "turn/start", { turn: 3 });
  record(a, "user/message", user("Try again"));
  dsh.emit("agent/error", { agent: { id: a.id, session: { id: a.id, header: a.header } }, turn: 3, step: 1, error: new Error("no API key for provider route deepseek-official") });
  record(a, "turn/end", { turn: 3, reason: { kind: "failed" } });
  status(a, "idle");
  check(await said(a.id, "agent", /DeepSeek stopped: no API key/), "an error shows as its reply");

  // ---------- a big tool output ----------
  status(a, "running");
  record(a, "turn/start", { turn: 4 });
  record(a, "user/message", user("Dump the log"));
  tool(a, 4, "bash", { command: "cat big.log" }, "x".repeat(5 << 20)); // more than a WebSocket message here takes
  record(a, "turn/end", { turn: 4, reason: { kind: "completed" } });
  status(a, "idle");
  const big = await until(async () => (await steps(a.id)).find((x) => /cat big\.log/.test(x.title) && x.done));
  check(big && (await thread(a.id)) && dsh && (await get("/api/runtimes")).runtimes.find((x) => x.kind === "dsh").detail.includes("are threads too"), "a tool's 5 MB output comes cut, and the connection stays");

  // ---------- its subagents ----------
  status(a, "running");
  record(a, "turn/start", { turn: 5 });
  record(a, "user/message", user("Get the diff reviewed"));
  // As dsh's subagent tool does it: the child's descriptor is written before it's live, and its parent's log names it.
  const sub = session(project, { parent: a.id });
  record(sub, "subagent/descriptor", { version: 3, mode: "continuable", provider: "spawn", label: "Review the diff" }, { live: false });
  record(a, "tool/call", { turn: 5, step: 1, callId: "call_sub", name: "subagent", arguments: JSON.stringify({ description: "Review the diff", prompt: "Review the diff in src/" }) });
  record(a, "subagent/catalog", { version: 0, childId: sub.id, childCreatedAt: Date.now(), mode: "continuable", label: "Review the diff" });
  record(a, "tool/result", { turn: 5, step: 1, ...toolResult("call_sub", `started subagent ${sub.id}`) });
  dsh.emit("subagent/start", { runId: "r1", provider: "spawn", parentSessionId: a.id, id: sub.id, local: true });
  status(sub, "running");
  record(sub, "turn/start", { turn: 1 });
  tool(sub, 1, "read", { file_path: path.join(project, "src/date.js") }, "export const parse = …");
  const w = await until(async () => {
    const d = await detail(a.id);
    return d.workers?.[0]?.state === "running" && d.workers[0];
  });
  check(w && w.title === "Review the diff" && w.n === 1 && /date\.js/.test(w.step?.title || ""), "a subagent is a worker on its thread, with its last step");
  check(!(await state()).sessions.some((x) => x.id === sub.id), "not a thread of its own");
  const wSteps = await get(`/api/sessions/${encodeURIComponent(a.id)}/workers/${sub.id}/steps`);
  check(wSteps.n === 1 && wSteps.steps?.length === 1 && /date\.js/.test(wSteps.steps[0].title), "opened, its steps show");
  // It finished what it had, and waits for more: done, until it works again.
  record(sub, "turn/end", { turn: 1, reason: { kind: "completed" } });
  status(sub, "idle");
  const wDone = await until(async () => {
    const d = await detail(a.id);
    return d.workers?.[0]?.state === "done" && d.workers[0];
  });
  check(wDone?.ended && !wDone.step, "once it's done with what it had, it's done");
  status(sub, "running");
  record(sub, "turn/start", { turn: 2 });
  check(await until(async () => (await detail(a.id)).workers?.[0]?.state === "running"), "given more, it works again");
  record(sub, "turn/end", { turn: 2, reason: { kind: "failed" } });
  check(await until(async () => (await detail(a.id)).workers?.[0]?.state === "failed"), "a turn of its that fails, it failed");
  dsh.emit("subagent/end", { runId: "r1", provider: "spawn", parentSessionId: a.id, id: sub.id, local: true, stopReason: "completed" });
  check(await until(async () => (await detail(a.id)).workers?.[0]?.state === "done"), "and once dsh lets it go, how it ended");
  record(a, "turn/end", { turn: 5, reason: { kind: "completed" } });
  status(a, "idle");

  // ---------- the connection goes down, and comes back ----------
  dsh.dispose();
  await sleep(300);
  // What dsh did meanwhile is only in its log.
  record(a, "turn/start", { turn: 6 }, { live: false });
  record(a, "user/message", user("Bump the version"), { live: false });
  tool(a, 6, "bash", { command: "npm version patch" }, "v1.0.1", { live: false });
  record(a, "turn/end", { turn: 6, reason: { kind: "completed" } }, { live: false });
  // Back in a dsh with no web app of its own (a terminal's): what you write goes to the session's agent.
  dsh = standIn({ app: false });
  plugin.apply(dsh, { url: URL, profile: "web" });
  await sleep(500);
  status(a, "idle");
  const caught = await until(async () => (await steps(a.id)).find((x) => /npm version patch/.test(x.title)));
  check(caught, "once it's back, what happened while it was down comes from its log");
  check(await until(() => a.agent.mounts.length === 2), "its agent gets agentbook's tools from the new connection");
  status(a, "running");
  record(a, "turn/start", { turn: 7 });
  record(a, "user/message", user("Tag it"));
  check(await said(a.id, "human", "Tag it"), "and what comes next shows as it happens");
  const tags = await steps(a.id);
  check(tags.filter((x) => /npm version patch/.test(x.title)).length === 1, "nothing twice");
  record(a, "turn/end", { turn: 7, reason: { kind: "completed" } });
  status(a, "idle");
  const before = a.agent.sent.length;
  await post(`/api/sessions/${a.id}/messages`, { text: "Push the tag" });
  const pushed = await until(() => a.agent.sent.length > before && a.agent.sent.at(-1));
  check(pushed?.how === "followup" && pushed.m.role === "user" && pushed.m.content[0].text === "Push the tag" && pushed.m.source.kind === "user" && /^agentbook-/.test(pushed.m.source.rpcId) && Object.isFrozen(pushed.m) && pushed.m.id, "without dsh's web app, what you write goes to the session's agent as a message of yours");

  // ---------- dsh stops ----------
  dsh.dispose();
  check(await until(async () => (await thread(a.id))?.effective !== "working"), "when dsh stops, its threads aren't working");
  const down = await post(`/api/sessions/${a.id}/messages`, { text: "Still there?" });
  check(down.status === 409 && /runs in DeepSeek's web app, which isn't running/.test(down.error || ""), "while dsh web isn't running, writing to the thread says so");

  // ---------- after a restart, agentbook still knows where it runs ----------
  await server.restart("agentbook-cli");
  const after = await post(`/api/sessions/${a.id}/messages`, { text: "Still there?" });
  check(after.status === 409 && /DeepSeek's web app/.test(after.error || ""), "after agentbook restarts, it still knows the thread runs in dsh web");
  dsh = standIn();
  plugin.apply(dsh, { url: URL, profile: "web" });
  status(a, "idle");
  await until(async () => (await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail.includes("are threads too"));
  const again = await post(`/api/sessions/${a.id}/messages`, { text: "Back again" });
  check(again.status === 200 && (await until(() => prompts.find((p) => p.request.content?.[0]?.text === "Back again"))), "once dsh web is back, you write to it again");

  // ---------- a thread you start on agentbook ----------
  const dshAgent = await until(async () => (await state()).agents.find((x) => x.id === "dsh" && x.models?.list?.length));
  const listed = dshAgent?.models;
  check(listed?.list.map((m) => m.id).join() === "deepseek-official/deepseek-v4-flash,deepseek-official/deepseek-v4-pro" && listed.default === "deepseek-official/deepseek-v4-flash" && listed.list[1].efforts.join() === "off,high" && listed.list[1].effort === "off", `DeepSeek's picker lists the models dsh web has keys for, with their efforts (${listed?.list?.map((m) => m.id).join()})`);
  check(/run in DeepSeek's web app/.test((await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail || ""), "Add agents says the threads you start run in dsh web");
  const launched = await post("/api/launch", { prompt: "Add a changelog", agent: "dsh", root: project, effort: "high" });
  check(launched.status === 200, `starting a thread on DeepSeek's wall goes (${launched.status} ${launched.error || ""})`);
  const made = await until(() => creates[0]);
  check(made?.workspaceId === "ws-app" && !made.cwd, `it starts in dsh web, in the folder's workspace (${JSON.stringify(made)})`);
  const nid = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === launched.lid)?.id);
  check(nid && nid === made?.sessionId, "and its thread is that session");
  check(picks[0]?.sessionId === nid && `${picks[0].provider}/${picks[0].model}` === "deepseek-official/deepseek-v4-flash" && picks[0].reasoningEffort === "high", "an effort you picked goes with dsh web's own model");
  const ns = sessions.get(nid);
  const n = ns?.agent;
  const firstPrompt = await until(() => prompts.find((p) => p.request.sessionId === nid));
  check(order.indexOf(`model ${nid}`) < order.indexOf(`mount ${nid}`) && order.indexOf(`mount ${nid}`) < order.indexOf(`prompt ${nid}`) && n.mounts.length === 1 && new globalThis.URL(n.mounts[0].cfg.url).searchParams.get("proc") === `dsh:${nid}`, `then agentbook's tools, then your message (${order.filter((x) => x.endsWith(nid)).map((x) => x.split(" ")[0]).join(", ")})`);
  const told = n.sent.find((x) => x.how === "inject");
  check(told && Object.isFrozen(told.m) && told.m.source.kind === "agentbook" && /this conversation is a thread on/.test(told.m.content[0].text) && n.sent.indexOf(told) < n.sent.findIndex((x) => x.how !== "inject"), "what agentbook tells the agents it starts goes ahead of your message, as agentbook's");
  check(firstPrompt?.request.content.length === 1 && firstPrompt.request.content[0].text === "Add a changelog" && firstPrompt.source.kind === "user" && /^agentbook-/.test(firstPrompt.source.rpcId), "and your message goes as yours, alone");
  const nm = await until(async () => (await detail(nid)).messages?.filter((m) => m.from === "human"));
  check(nm?.length === 1 && nm[0].text === "Add a changelog", "the thread shows what you wrote once");
  status(ns, "running");
  record(ns, "turn/start", { turn: 1 });
  record(ns, "user/message", { ...user("Add a changelog"), source: { kind: "user", rpcId: firstPrompt?.source.rpcId } });
  record(ns, "assistant/message", assistant([{ type: "text", text: "Added CHANGELOG.md." }]));
  record(ns, "turn/end", { turn: 1, reason: { kind: "completed" } });
  status(ns, "idle");
  check(await said(nid, "agent", "Added CHANGELOG.md."), "its reply shows");
  check((await detail(nid)).messages.filter((m) => m.from === "human").length === 1, "and what you wrote still shows once");

  // A model picked for it goes to dsh web with your next message; one dsh web has no key for says so.
  await post(`/api/sessions/${nid}/model`, { model: "deepseek-official/deepseek-v4-pro" });
  await post(`/api/sessions/${nid}/messages`, { text: "Now on pro" });
  const onPro = await until(() => prompts.find((p) => p.request.content?.[0]?.text === "Now on pro"));
  const proPick = picks.find((p) => p.model === "deepseek-v4-pro");
  check(onPro && proPick && picks.indexOf(proPick) > 0 && order.lastIndexOf(`model ${nid}`) < order.lastIndexOf(`prompt ${nid}`) && !(await thread(nid))?.model_pick, "a model you pick for it goes to dsh web before your next message");
  await post(`/api/sessions/${nid}/model`, { model: "nokey/big" });
  await post(`/api/sessions/${nid}/messages`, { text: "Now on big" });
  check(await said(nid, "agent", /couldn't switch this thread to nokey\/big, so it carries on as it was: model "nokey\/big" is not available/), "one dsh web has no key for says so on the thread");
  check(await until(() => prompts.find((p) => p.request.content?.[0]?.text === "Now on big")), "and your message still goes");

  // With dsh web closed, a thread you start goes to agentbook's own dsh (none here: it says so).
  dsh.dispose();
  await until(async () => !/run in DeepSeek's web app/.test((await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail || ""));
  const madeBefore = creates.length;
  const acp = await post("/api/launch", { prompt: "Another one", agent: "dsh", root: project });
  await sleep(500);
  check(creates.length === madeBefore, `with dsh web closed, a thread you start doesn't go there (${acp.status} ${acp.error || ""})`);
} catch (e) {
  console.log(`FAIL  ${e.stack || e.message}`);
  failures++;
} finally {
  try {
    dsh.dispose();
  } catch {}
  server?.kill();
  if (failures) console.log(serverLog.split("\n").slice(-40).join("\n"));
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
