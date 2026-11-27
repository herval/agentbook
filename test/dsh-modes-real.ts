#!/usr/bin/env node
// A thread's mode in a real DeepSeek Harness: agentbook runs dsh's ACP server as it does for you (with its plugin in
// it, by an overlay), in a home of the test's own (DSH_HOME) and on a stand-in model, a server here that answers as
// Anthropic's Messages API does, which dsh's DeepSeek provider speaks. Full access and Plan are read back from the
// session's own log, as dsh keeps them; a plan the model presents with exit_plan_mode is reviewed on the thread, and
// approving it there ends plan mode. It skips without dsh, or a Node 24.
// Run: node test/dsh-modes-real.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

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

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-dsh-modes-")));
const PORT = testPort(4850);
const URL = `http://127.0.0.1:${PORT}`;
const DSH_HOME = path.join(HOME, "dsh");
const project = path.join(HOME, "dev", "app");
for (const d of [DSH_HOME, project, path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, "README.md"), "# app\n");
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [path.join(HOME, "dev")], starts_per_hour: 1000 }));
process.env.DSH_HOME = DSH_HOME; // for log.ts's readLog, here
const { readLog } = await import("../plugin/cli/runtimes/dsh/log.ts");

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
    await sleep(150);
  }
};
const said = (id: string, text: string) => until(async () => (await detail(id)).messages?.find((m) => m.from === "agent" && m.text === text));
// What dsh logged of a session, by its type.
const logged = (id: string, type: string) => (readLog(id) || []).filter((e: { type?: string }) => e.type === type).map((e: { data?: Json }) => e.data);

// ---------- the stand-in model ----------
// In plan mode (its system prompt says so), it presents a plan with exit_plan_mode; with the review's result, or
// otherwise, it answers in a line.
const PLAN = "# Add docs\n\nWrite docs/README.md.";
type ModelRequest = { model?: string; system?: unknown; messages?: { role: string; content: string | { type: string; text?: string; content?: unknown }[] }[]; tools?: { name: string }[] };
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
    const result = Array.isArray(last?.content) ? last.content.find((c) => c.type === "tool_result") : null;
    const planning = JSON.stringify(b.system || "").includes("You are in plan mode") && b.tools?.some((t) => t.name === "exit_plan_mode");
    rs.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const sse = (e: { type: string; [field: string]: unknown }) => rs.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    sse({ type: "message_start", message: { id: `m${asked.length}`, type: "message", role: "assistant", model: b.model || "fixture-model", content: [], usage: { input_tokens: 120, output_tokens: 0 } } });
    if (planning && !result) {
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${asked.length}`, name: "exit_plan_mode", input: {} } });
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ plan: PLAN }) } });
      sse({ type: "content_block_stop", index: 0 });
      sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
    } else {
      const text = result ? (JSON.stringify(result).includes("Plan approved") ? "Plan approved: going ahead." : "Kept planning.") : "Done.";
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

// dsh's ACP profile, set up as dsh does on first use, then pointed at the stand-in model in its user layer.
const PATH = [found.node && path.dirname(found.node), process.env.PATH].filter(Boolean).join(path.delimiter);
const dshEnv: NodeJS.ProcessEnv = { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: "fixture-key", DEEPSEEK_BASE_URL: BASE, DSH_TELEMETRY_DISABLED: "1", PATH };
for (const k of Object.keys(dshEnv)) if (k.startsWith("AGENTBOOK_")) delete dshEnv[k];
spawnSync(found.bin, ["--profile", "acp", "--dump-default-config"], { env: dshEnv, stdio: "ignore", timeout: 60e3 });
fs.writeFileSync(
  path.join(DSH_HOME, "profiles", "acp", "cordis.patch.yml"),
  JSON.stringify([
    { id: "llm-deepseek", config: { baseURL: BASE, models: [{ id: "fixture-model" }] } },
    { id: "acp", config: { provider: "deepseek-official", model: "fixture-model" } },
  ]) + "\n",
);

const env = { ...dshEnv, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_AGY: "0", AGENTBOOK_GROK: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_DSH: "1", AGENTBOOK_DSH_BIN: found.bin, AGENTBOOK_DSH_APP: "0" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR"]) delete env[k];

let server: Agentbook | undefined;
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
  await until(async () => (await state()).agents?.some((a) => a.id === "dsh"));
  const start = async (prompt: string, mode: string) => {
    const r = await post("/api/launch", { prompt, agent: "dsh", root: project, mode });
    return until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === r.lid)?.id);
  };

  // ---------- Full access ----------
  const full = await start("Full speed", "full");
  check(await said(full, "Done."), `a thread started in Full access runs in a real dsh (${found.version}), on the stand-in model`);
  const preset = logged(full, "permission/preset").at(-1);
  const policy = logged(full, "approval/policy").at(-1);
  check(preset?.preset === "danger-full-access" && policy?.policy === "never", `dsh's own log has it on danger-full-access, never asking (${JSON.stringify(preset)}, ${JSON.stringify(policy)})`);

  // ---------- Plan ----------
  const planned = await start("Add docs", "plan");
  check(await until(() => logged(planned, "plan/mode").at(-1)?.active === true), "a thread started in Plan is in dsh's plan mode");
  const review = await until(async () => (await state()).questions.find((q) => q.post === planned && !q.answered && /Approve this plan/.test(q.title || "")));
  check(review?.options?.map((o) => o.label).join() === "Approve,Keep planning", `the plan it presents (exit_plan_mode) is reviewed on the thread (${JSON.stringify(review?.options)})`);
  await post(`/api/questions/${review?.id}/answer`, { value: "Approve" });
  check(await said(planned, "Plan approved: going ahead."), "approving it there, it goes ahead");
  check(await until(() => logged(planned, "plan/mode").at(-1)?.active === false), "and dsh's log has plan mode off");
  check(!/are threads too/.test((await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail || ""), "the plugin in agentbook's own ACP server isn't listed as one of dsh's apps");
} catch (e) {
  console.log(`FAIL  ${e.stack || e.message}`);
  failures++;
} finally {
  server?.kill();
  model.close();
  if (failures) console.log(`--- agentbook:\n${serverLog.split("\n").slice(-40).join("\n")}`);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
