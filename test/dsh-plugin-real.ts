#!/usr/bin/env node
// agentbook's plugin for DeepSeek Harness (plugin/dsh) in a real dsh, the way dsh's own tests run it without a key:
// its own home (DSH_HOME, made for the test), its ACP profile with the plugin added (`dsh plugin add`, which needs
// pnpm, else by path in a --patch overlay), and a stand-in model: a server here that answers as Anthropic's Messages API does,
// which dsh's DeepSeek provider speaks. The test drives a session over ACP as a client of dsh's would, not as
// agentbook (agentbook's dsh is off here), so the session is one of dsh's own: the plugin says it to a test
// agentbook, where it's a thread, with what you wrote, its steps and its reply. It skips without dsh, or a Node 24.
// Run: node test/dsh-plugin-real.ts

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(TEST, "..", "plugin", "dsh", "index.js");

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

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-dsh-real-")));
const PORT = testPort(4800);
const URL = `http://127.0.0.1:${PORT}`;
const DSH_HOME = path.join(HOME, "dsh");
const project = path.join(HOME, "dev", "app");
for (const d of [DSH_HOME, project, path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, "README.md"), "# app\n");
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
const state = () => stateOf(get);
const detail = (id: string) => get(`/api/sessions/${encodeURIComponent(id)}`);
const until = async <T>(fn: () => T | Promise<T>, ms = 15000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};

// ---------- the stand-in model ----------
// For each prompt, a tool call, then, with its result, a reply: "Which docs are here?" globs (it needs no OK); "Get a
// second opinion" hands "List the docs here" to a subagent, which globs; once dsh says the subagent finished, a reply.
const PROMPTS = ["Which docs are here?", "Get a second opinion", "List the docs here", "Thanks from agentbook"];
// The part of what dsh sends the model (an Anthropic Messages request) the stand-in reads.
type Content = string | { type: string; text?: string }[];
type ModelRequest = { model?: string; messages?: { role: string; content: Content }[]; tools?: { name: string }[] };
const asked: ModelRequest[] = [];
const model = http.createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => (body += d));
  rq.on("end", () => {
    if (rq.method !== "POST" || !rq.url.endsWith("/v1/messages")) return rs.writeHead(404).end("{}");
    let b: ModelRequest = {};
    try {
      b = JSON.parse(body);
    } catch {}
    asked.push(b);
    const last = b.messages?.at(-1);
    const after = Array.isArray(last?.content) && last.content.some((c) => c.type === "tool_result");
    const tools = Array.isArray(b.tools) && b.tools.some((t) => t.name === "glob");
    // Which prompt this turn answers: the latest of the test's in what it was sent.
    const texts = (b.messages || []).filter((m) => m.role === "user").flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content || []).filter((c) => c.type === "text").map((c) => c.text)));
    const prompt = [...texts].reverse().find((t) => PROMPTS.some((p) => t.includes(p))) || "";
    const [tool, input, reply] = prompt.includes("Thanks from agentbook") ? [null, null, "You're welcome."] : prompt.includes("List the docs here") ? ["glob", { pattern: "*.md", path: "." }, "Only README.md."] : prompt.includes("Get a second opinion") ? ["subagent", { description: "Check the docs", prompt: "List the docs here, then stop." }, "Asked a subagent."] : ["glob", { pattern: "*.md", path: "." }, "Done: there's a README."];
    // dsh tells the parent once its subagent is done: that turn just answers.
    const lastText = typeof last?.content === "string" ? last.content : (last?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const settled = /Background subagent .* finished/.test(lastText);
    rs.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const sse = (e: { type: string; [field: string]: unknown }) => rs.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    sse({ type: "message_start", message: { id: `m${asked.length}`, type: "message", role: "assistant", model: b.model || "fixture-model", content: [], usage: { input_tokens: 120, output_tokens: 0 } } });
    if (tool && tools && !after && !settled) {
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${asked.length}`, name: tool, input: {} } });
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      sse({ type: "content_block_stop", index: 0 });
      sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
    } else {
      const text = settled ? "Done: the subagent agrees." : after || !tool ? reply : "Files";
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

  // ---------- dsh, with the plugin ----------
  const dshEnv: NodeJS.ProcessEnv = { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: "fixture-key", DEEPSEEK_BASE_URL: BASE, DSH_TELEMETRY_DISABLED: "1", PATH: [found.node && path.dirname(found.node), process.env.PATH].filter(Boolean).join(path.delimiter) };
  for (const k of Object.keys(dshEnv)) if (k.startsWith("AGENTBOOK_")) delete dshEnv[k];
  dshEnv.AGENTBOOK_URL = URL; // where the plugin finds agentbook: this test's, never this machine's own
  spawnSync(found.bin, ["--profile", "acp", "--dump-default-config"], { env: dshEnv, stdio: "ignore", timeout: 60e3 });
  // Added as you'd add it (`dsh plugin add`, which runs pnpm in the profile's folder), else by path in the overlay.
  const added = spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status === 0 && spawnSync(found.bin, ["plugin", "--profile", "acp", "add", `file:${path.dirname(PLUGIN)}`], { env: dshEnv, encoding: "utf8", timeout: 120e3 }).status === 0;
  const manifest = JSON.parse(fs.readFileSync(path.join(DSH_HOME, "profiles", "acp", "package.json"), "utf8"));
  if (added) check(manifest.dsh?.profile?.bundles?.includes("agentbook-dsh"), "dsh plugin add makes it one of the profile's bundles");
  const patch = path.join(HOME, "agentbook.patch.yml");
  fs.writeFileSync(
    patch,
    JSON.stringify([
      ...(added ? [] : [{ insert: [{ id: "agentbook", name: PLUGIN }] }]),
      { id: "llm-deepseek", config: { baseURL: BASE, models: [{ id: "fixture-model" }] } },
      { id: "acp", config: { provider: "deepseek-official", model: "fixture-model" } },
    ]) + "\n",
  );
  child = spawn(found.bin, ["--profile", "acp", "--patch", patch], { env: dshEnv, cwd: project, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => (dshLog += d));
  // What dsh answers over ACP, and what the test reads of it.
  type AcpResult = { sessionId?: string; stopReason?: string };
  type AcpMessage = { id?: number; method?: string; params?: { update?: unknown }; result?: AcpResult; error?: { message: string } };
  const waiting = new Map<number, { resolve: (r: AcpResult) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const write = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const rpc = (method: string, params: object) =>
    new Promise<AcpResult>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    });
  const updates: unknown[] = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m: AcpMessage;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && !m.method && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      return m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    }
    if (m.method === "session/update") updates.push(m.params?.update);
    if (m.method === "session/request_permission") write({ id: m.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  });
  child.on("exit", (code) => {
    for (const w of waiting.values()) w.reject(new Error(`dsh exited (${code}): ${dshLog.trim().split("\n").slice(-3).join(" | ")}`));
    waiting.clear();
  });

  await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const agent = await until(async () => (await state()).agents?.find((a) => a.id === "dsh"));
  check(!!agent, `the plugin in a real dsh (on Node ${found.version}, ${added ? "added with dsh plugin add" : "added by path"}) connects to agentbook`);
  const row = (await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh");
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(PLUGIN), "package.json"), "utf8")).version;
  check(row?.detail?.includes(`sessions in acp are threads too (agentbook's plugin ${version})`), "it says which profile it's in");

  const { sessionId: sid } = await rpc("session/new", { cwd: project, mcpServers: [] });
  await sleep(800);
  check(!(await state()).sessions.some((x) => x.id === sid), "a new session isn't a thread until it's written to");
  const result = await rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Which docs are here?" }] });
  check(result?.stopReason === "end_turn", `dsh answers the prompt (the stand-in model was asked ${asked.length} times)`);

  const t = await until(async () => (await state()).sessions.find((x) => x.id === sid));
  check(t?.agent === "dsh", "the session is a thread on agentbook");
  const mine = await until(async () => (await detail(sid)).messages?.find((m) => m.from === "human"));
  check(mine?.text === "Which docs are here?", `what was written shows as yours, and only that (${JSON.stringify(mine?.text)})`);
  const reply = await until(async () => (await detail(sid)).messages?.find((m) => m.from === "agent"));
  check(reply?.text === "Done: there's a README.", `its reply shows (${JSON.stringify(reply?.text)})`);
  const st = (await get(`/api/sessions/${encodeURIComponent(sid)}/steps`)).steps || [];
  const globbed = st.find((x) => x.kind === "tool" && /\*\.md/.test(x.title || ""));
  check(globbed?.done, `its tool call is a step, done (${st.filter((x) => x.kind === "tool").map((x) => x.title).join(", ")})`);
  check(await until(async () => (await state()).sessions.find((x) => x.id === sid)?.effective !== "working"), "and it rests once the turn ends");
  // Written to from agentbook: in a dsh with no web app of its own, it goes to the session's agent.
  const sent = await req(`/api/sessions/${sid}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Thanks from agentbook" }) });
  check(sent.status === 200 && (await until(async () => (await detail(sid)).messages?.find((m) => m.from === "agent" && m.text === "You're welcome."))), "written to from agentbook, it answers");
  check((await detail(sid)).messages.filter((m) => m.text === "Thanks from agentbook").length === 1, "and what you wrote shows once");
  await until(async () => (await state()).sessions.find((x) => x.id === sid)?.effective !== "working");

  // ---------- a subagent ----------
  const second = await rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Get a second opinion" }] });
  check(second?.stopReason === "end_turn", "dsh answers a prompt that hands work to a subagent");
  const agrees = await until(async () => (await detail(sid)).messages?.find((m) => m.from === "agent" && m.text === "Done: the subagent agrees."));
  const w = await until(async () => (await detail(sid)).workers?.find((x) => x.state === "done"));
  check(agrees && w, `the subagent is a worker on its thread, done (${JSON.stringify((await detail(sid)).workers)})`);
  check(w?.n === 1 && w.title === "Check the docs" && (await detail(sid)).workers.length === 1, `named as its parent named it, with its one step (${w?.title}, ${w?.n})`);
  const ws = w && (await get(`/api/sessions/${encodeURIComponent(sid)}/workers/${encodeURIComponent(w.id)}/steps`));
  check(ws?.steps?.some((x) => /\*\.md/.test(x.title || "") && x.done), "opened, its steps show");
  check(!(await state()).sessions.some((x) => x.id === w?.id), "and it isn't a thread of its own");

  child.kill();
  check(await until(async () => !(await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail.includes("are threads too")), "once dsh stops, its plugin's connection is gone");
} catch (e) {
  console.log(`FAIL  ${e.stack || e.message}`);
  failures++;
} finally {
  child?.kill();
  server?.kill();
  model.close();
  if (failures) console.log(`--- dsh:\n${dshLog.split("\n").slice(-30).join("\n")}\n--- agentbook:\n${serverLog.split("\n").slice(-20).join("\n")}`);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
