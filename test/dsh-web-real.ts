#!/usr/bin/env node
// agentbook's plugin for DeepSeek Harness (plugin/dsh) in a real dsh web app, without a key: its own home (DSH_HOME,
// made for the test), its web profile with the plugin added by path (a --patch overlay), a stand-in model (a server
// here that answers as Anthropic's Messages API does, which dsh's DeepSeek provider speaks), and a stand-in for dsh's
// web page (test/fake-dsh-page.ts, a plugin there that does what the page does). You start a session in "dsh web"
// and write to it, and it's a thread on a test agentbook; then you answer it from agentbook: what you write goes to
// it (through dsh web's own session controller), it calls agentbook's tools, what it asks before a tool runs and its
// questions are answered from agentbook (and dsh web's own prompt closes), and Stop stops it. Then a thread you start
// on agentbook starts in dsh web: on the model you picked there, with agentbook's tools and instructions from its
// first step. It skips without dsh, or a Node 24. Run: node test/dsh-web-real.ts

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLog } from "../plugin/cli/runtimes/dsh/log.ts";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(TEST, "..", "plugin", "dsh", "index.js");
const PAGE = path.join(TEST, "fake-dsh-page.ts");

// dsh, and the Node it runs on (24 and up).
function findDsh() {
  const candidates = [process.env.AGENTBOOK_DSH_REAL_BIN, ...(process.env.PATH || "").split(path.delimiter).map((d) => d && path.join(d, "dsh"))];
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, v, "bin", "dsh"));
  } catch {}
  for (const bin of candidates.filter(Boolean)) {
    if (!fs.existsSync(bin)) continue;
    const node = path.join(path.dirname(fs.realpathSync(bin)), "node");
    for (const n of [path.join(path.dirname(bin), "node"), node, "node"]) {
      const v = spawnSync(n, ["--version"], { encoding: "utf8" }).stdout?.trim();
      if (v && Number(v.slice(1).split(".")[0]) >= 24) return { bin, node: n === "node" ? null : n, version: v };
    }
  }
  return null;
}
const found = findDsh();
if (!found) {
  console.log("SKIP  no dsh on a Node 24 here");
  process.exit(0);
}

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-dsh-web-")));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const DSH_HOME = path.join(HOME, "dsh");
const project = path.join(HOME, "dev", "app");
for (const d of [DSH_HOME, project, path.join(project, "build"), path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, "README.md"), "# app\n");
fs.writeFileSync(path.join(project, "build", "out.js"), "1\n");
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [path.join(HOME, "dev")], starts_per_hour: 1000 }));
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_DSH: "1", AGENTBOOK_DSH_BIN: path.join(HOME, "no-dsh"), DSH_HOME };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR"]) delete env[k];

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
const until = async <T>(fn: () => T | Promise<T>, ms = 20000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(200);
  }
};
const said = (id: string, text: string | RegExp) => until(async () => (await detail(id)).messages?.find((m) => m.from === "agent" && (text instanceof RegExp ? text.test(m.text) : m.text === text)));
const question = (pred: (q: Json) => unknown) => until(async () => (await state()).questions.find((q) => !q.answered && pred(q)));
const resting = (id: string) => until(async () => (await state()).sessions.find((x) => x.id === id)?.effective !== "working");

// ---------- the stand-in model ----------
// For each prompt (the latest of the test's in what it's sent), what it does: a tool call, then with its result, a
// reply. "Take a slow look" takes a while to answer (for Stop).
// The part of what dsh sends the model (an Anthropic Messages request) the stand-in reads.
type Content = string | { type: string; text?: string; content?: Content }[];
type ModelRequest = { model?: string; system?: unknown; messages?: { role: string; content: Content }[]; tools?: { name: string }[] };
// A turn: the tool it calls (by name, with its input), its reply (or how to make one from the tool's result), how long it takes.
type Turn = [call: Record<string, object> | null, reply: string | ((result: string) => string), slow?: number];
const asked: ModelRequest[] = [];
const PROMPTS: Record<string, Turn> = {
  "Which docs are here?": [{ glob: { pattern: "*.md", path: "." } }, "There's a README."],
  "Set the headline": [{ "mcp__agentbook__ab_post": { title: "Look after the docs", text: "Answered from agentbook." } }, "Set the headline."],
  "Clean the build": [{ bash: { command: `rm -rf ${path.join(project, "build")}`, description: "Clean the build", sandbox_permissions: "danger-full-access", justification: "The build folder is outside what the sandbox may delete." } }, "Cleaned."],
  "Pick a database": [{ ask_user_question: { questions: [{ id: "db", question: "Which database?", options: [{ label: "Postgres", description: "The one in prod" }, { label: "SQLite" }] }] } }, (result) => `Going with ${/SQLite/.test(result) ? "SQLite" : /Postgres/.test(result) ? "Postgres" : "nothing"}.`],
  "Take a slow look": [null, "Looked.", 30000],
  "Start from agentbook": [{ "mcp__agentbook__ab_post": { title: "Started from agentbook", text: "It runs in dsh web." } }, "Started."],
};
const textOf = (content: Content | undefined): string => (typeof content === "string" ? content : (content || []).map((c) => (c.type === "text" ? c.text : c.type === "tool_result" ? textOf(c.content) : "")).join("\n"));
const model = http.createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => (body += d));
  rq.on("end", async () => {
    if (rq.method !== "POST" || !rq.url.endsWith("/v1/messages")) return rs.writeHead(404).end("{}");
    let b: ModelRequest = {};
    try {
      b = JSON.parse(body);
    } catch {}
    asked.push(b);
    const last = b.messages?.at(-1);
    const after = Array.isArray(last?.content) && last.content.some((c) => c.type === "tool_result");
    const texts = (b.messages || []).filter((m) => m.role === "user").map((m) => textOf(m.content));
    const prompt = [...texts].reverse().map((t) => Object.keys(PROMPTS).find((p) => t.includes(p))).find(Boolean) || "Which docs are here?";
    // A request with no tools is dsh's own (a session's title): a title.
    const [call, reply, slow]: Turn = b.tools?.length ? PROMPTS[prompt] : [null, "The app's docs"];
    const [tool, input] = call ? Object.entries(call)[0] : [];
    const has = (b.tools || []).some((t) => t.name === tool);
    rs.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const sse = (e: { type: string; [field: string]: unknown }) => rs.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    sse({ type: "message_start", message: { id: `m${asked.length}`, type: "message", role: "assistant", model: b.model || "fixture-model", content: [], usage: { input_tokens: 120, output_tokens: 0 } } });
    if (slow) await sleep(slow);
    if (tool && has && !after) {
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${asked.length}`, name: tool, input: {} } });
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      sse({ type: "content_block_stop", index: 0 });
      sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
    } else {
      const text = !tool || after ? (typeof reply === "function" ? reply(textOf(last?.content)) : reply) : `No ${tool} tool here.`;
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      sse({ type: "content_block_stop", index: 0 });
      sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
    }
    sse({ type: "message_stop" });
    rs.end();
  });
});
await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(model.address() as net.AddressInfo).port}/anthropic`;

let server: ChildProcess | undefined;
let child: ChildProcess | undefined;
let dshLog = "";
let serverLog = "";
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

  // ---------- dsh web, with the plugin and the stand-in page ----------
  const pagePort = await new Promise<number>((r) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
  // The stand-in page's own routes (fake-dsh-page), and what they answer.
  type PageAnswer = { error?: string; sessionId?: string; pending?: number | null; has?: boolean; cwd?: string | null; workspace?: boolean; id?: string };
  const page = async (p: string, body?: object): Promise<PageAnswer> => {
    const r = await fetch(`http://127.0.0.1:${pagePort}${p}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const out = (await r.json()) as PageAnswer;
    if (!r.ok) throw new Error(`the page's ${p}: ${out.error}`);
    return out;
  };
  const dshEnv: NodeJS.ProcessEnv = { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: "fixture-key", DEEPSEEK_BASE_URL: BASE, DSH_TELEMETRY_DISABLED: "1", PAGE_PORT: String(pagePort), PATH: [found.node && path.dirname(found.node), process.env.PATH].filter(Boolean).join(path.delimiter) };
  for (const k of Object.keys(dshEnv)) if (k.startsWith("AGENTBOOK_")) delete dshEnv[k];
  dshEnv.AGENTBOOK_URL = URL; // where the plugin finds agentbook: this test's, never this machine's own
  spawnSync(found.bin, ["--profile", "web", "--dump-default-config"], { env: dshEnv, stdio: "ignore", timeout: 60e3 });
  const patch = path.join(HOME, "agentbook.patch.yml");
  fs.writeFileSync(
    patch,
    JSON.stringify([
      { insert: [{ id: "agentbook", name: PLUGIN }, { id: "fake-dsh-page", name: PAGE }] },
      { id: "llm-deepseek", config: { baseURL: BASE, models: [{ id: "fixture-model" }, { id: "fixture-pro" }] } },
      { id: "agent-default-model", config: { provider: "deepseek-official", model: "fixture-model" } },
    ]) + "\n",
  );
  child = spawnTied(found.bin, ["--profile", "web", "--patch", patch, "--no-open", "--port", "0", "--host", "127.0.0.1"], { env: dshEnv, cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (dshLog += d));
  child.stderr.on("data", (d) => (dshLog += d));
  const agent = await until(async () => (await state()).agents?.find((a) => a.id === "dsh"), 60000);
  check(!!agent, `the plugin in a real dsh web (on Node ${found.version}) connects to agentbook`);
  await until(() => page("/pending").then(() => true, () => false), 30000);

  // ---------- you, in dsh web ----------
  const { sessionId: sid } = await page("/new", { cwd: project });
  check(!!sid, "dsh web starts a session");
  await page("/prompt", { id: sid, text: "Which docs are here?" });
  const reply = await said(sid, "There's a README.");
  check(reply && (await detail(sid)).messages.find((m) => m.from === "human")?.text === "Which docs are here?", "written to there, it's a thread, with what you wrote and its reply");
  await resting(sid);

  // ---------- you, on agentbook ----------
  const sent = await post(`/api/sessions/${sid}/messages`, { text: "Set the headline" });
  check(sent.status === 200, `writing to it from agentbook goes (${sent.status} ${sent.error || ""})`);
  const titled = await until(async () => (await state()).sessions.find((x) => x.id === sid)?.title === "Look after the docs");
  const toolsSeen = asked.at(-1)?.tools?.map((t) => t.name).filter((n) => /agentbook/.test(n)) || [];
  const posted = asked.map((b) => b.messages?.at(-1)?.content).find((c) => Array.isArray(c) && c.some((x) => x.type === "tool_result") && /Thread|headline|ab_post|error/i.test(textOf(c)));
  check(titled, `it has agentbook's tools, and an ab_post it calls sets the thread's headline (it was offered ${toolsSeen.length} of agentbook's tools; ab_post said ${JSON.stringify(textOf(posted)).slice(0, 300)}; the thread's title is ${JSON.stringify((await state()).sessions.find((x) => x.id === sid)?.title)})`);
  check(await said(sid, "Set the headline."), "it answers what you wrote from agentbook");
  check((await detail(sid)).messages.filter((m) => m.text === "Set the headline").length === 1, "what you wrote shows once");
  check(asked.some((b) => /agentbook/i.test(JSON.stringify(b.system || ""))), "dsh tells the model what agentbook's MCP server says about itself");
  await resting(sid);

  // ---------- what it asks before a tool runs ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Clean the build" });
  const perm = await question((q) => q.post === sid && q.kind === "permission");
  check(perm && /rm -rf/.test(perm.preview) && /danger-full-access/.test(perm.detail), `what it asks before a tool runs is Allow/Deny on the thread (${perm?.tool_name}: ${perm?.detail} / ${perm?.preview})`);
  check((await page("/pending")).pending === 1, "dsh web's own prompt for it waits for a page too");
  await post(`/api/questions/${perm?.id}/answer`, { value: "allow" });
  check(await said(sid, "Cleaned."), "allowed there, it goes ahead");
  check(!fs.existsSync(path.join(project, "build")), "and does what it asked to");
  check((await page("/pending")).pending === 0, "and dsh web's own prompt is closed");
  await resting(sid);

  // ---------- its questions ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Pick a database" });
  const q = await question((x) => x.post === sid && x.title === "Which database?");
  check(q?.options?.map((o) => o.label).join() === "Postgres,SQLite", "its ask_user_question is a question on the thread, with its options");
  await post(`/api/questions/${q?.id}/answer`, { value: "SQLite" });
  check(await said(sid, "Going with SQLite."), "answered there, it gets the answer");
  check((await page("/pending")).pending === 0, "and dsh web's own question is closed");
  await resting(sid);

  // ---------- Stop ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Take a slow look" });
  check(await until(async () => (await state()).sessions.find((x) => x.id === sid)?.effective === "working"), "while it works, the thread is working");
  const stopped = await post(`/api/sessions/${sid}/stop`);
  check(stopped.status < 300, `Stop goes (${stopped.status} ${stopped.error || ""})`);
  check(await resting(sid), "and it stops");

  // ---------- a thread you start on agentbook ----------
  const runtime = (await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh");
  check(/run in DeepSeek's web app/.test(runtime?.detail || ""), `Add agents says the threads you start run in dsh web (${runtime?.detail})`);
  const dshAgent = await until(async () => (await state()).agents.find((a) => a.id === "dsh" && a.models?.list?.some((m) => m.id === "deepseek-official/fixture-pro")));
  check(dshAgent?.models?.default === "deepseek-official/fixture-model", `DeepSeek's model picker lists dsh web's models, and its default (${dshAgent?.models?.list?.map((m) => m.id).join()}; ${dshAgent?.models?.default})`);
  await page("/workspace", { path: project });
  const before = asked.length;
  const launched = await post("/api/launch", { prompt: "Start from agentbook", agent: "dsh", root: project, model: "deepseek-official/fixture-pro" });
  check(launched.status === 200, `starting a thread on DeepSeek's wall goes (${launched.status} ${launched.error || ""})`);
  const sid2 = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === launched.lid)?.id);
  const there = sid2 ? await page(`/has?id=${encodeURIComponent(sid2)}`) : {};
  check(there.has && there.cwd === project && there.workspace, `its session is dsh web's, in the folder picked, in that folder's workspace (${JSON.stringify(there)})`);
  check(await said(sid2, "Started."), "it answers there");
  const first = asked.slice(before).find((b) => b.tools?.length);
  check(first?.tools?.some((t) => t.name === "mcp__agentbook__ab_post") && (await until(async () => (await state()).sessions.find((x) => x.id === sid2)?.title === "Started from agentbook")), "with agentbook's tools from its first step: its ab_post set the thread's headline");
  check(first?.model === "fixture-pro", `on the model you picked (${first?.model})`);
  const blocks = (first?.messages || []).filter((m) => m.role === "user").flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => textOf([c]))));
  const told = (b: string) => b.includes("this conversation is a thread on");
  check(blocks.some(told) && blocks.some((b) => b.includes("Start from agentbook")) && !blocks.some((b) => told(b) && b.includes("Start from agentbook")), "what agentbook tells the agents it starts reaches the model, apart from your message");
  process.env.DSH_HOME = DSH_HOME;
  const logged = (readLog(sid2) || []).filter((e) => e.type === "user/message");
  check(logged.some((e) => e.data?.source?.kind === "agentbook" && told(textOf(e.data.content))) && !logged.some((e) => e.data?.source?.kind === "user" && told(textOf(e.data.content))), `dsh keeps it as agentbook's, not yours (${logged.map((e) => e.data?.source?.kind).join()})`);
  const yours = (await detail(sid2)).messages.filter((m) => m.from === "human");
  check(yours.length === 1 && yours[0].text === "Start from agentbook", `the thread shows what you wrote, once, and not what agentbook told it (${yours.map((m) => m.text.slice(0, 60)).join(" | ")})`);
  await resting(sid2);
  await post(`/api/sessions/${sid2}/messages`, { text: "Which docs are here?" });
  check(await said(sid2, "There's a README."), "written to again from agentbook, it answers there");
  await resting(sid2);

  child.kill();
  check(await until(async () => !(await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail.includes("are threads too")), "once dsh web stops, its plugin's connection is gone");
  const down = await post(`/api/sessions/${sid}/messages`, { text: "Still there?" });
  check(down.status === 409 && /isn't running/.test(down.error || ""), "and writing to the thread says dsh web isn't running");
} catch (e) {
  console.log(`FAIL  ${e.stack || e.message}`);
  failures++;
} finally {
  child?.kill();
  server?.kill();
  model.close();
  if (failures) {
    console.log("--- agentbook ---\n" + serverLog.split("\n").slice(-30).join("\n"));
    console.log("--- dsh ---\n" + dshLog.split("\n").slice(-30).join("\n"));
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
