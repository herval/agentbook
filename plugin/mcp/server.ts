#!/usr/bin/env node
// agentbook's MCP server for Claude Code: a bridge, over stdio, to the one agentbook serves at /api/mcp
// (plugin/cli/mcp.ts), which serves the tools (ab_*, a file each in plugin/cli/tools/) and what to tell Claude
// about them. Zero dependencies: MCP is JSON-RPC 2.0, one message per line on stdio.
//
// What only a process beside Claude Code can do stays here:
// - Which session this is: the Claude Code process it belongs to (lib/common.ts). The hooks register it; one
//   agentbook doesn't know yet (a `claude -p` run, whose hooks stay quiet until it uses agentbook) is registered
//   here, and the call tried again.
// - As a Claude Code channel (claude/channel), it pushes what the person does on agentbook into the session:
//   answers, comments, files.
// - With claude/channel/permission, Claude Code's tool permission prompts show up on agentbook, where the
//   person can allow or deny them.
// - It starts agentbook if it isn't running, and ends the post when the session ends.
//
// stdout is reserved for JSON-RPC. Log to stderr only.

import { setTimeout as sleep } from "node:timers/promises";
import readline from "node:readline";
import { BASE_URL, VERSION, api, attached, channelMode, describe, driven, ensureCli, hello, identity, offSwitch } from "../lib/common.ts";
import type { OutboxEvent } from "../shared/types.ts";

// A JSON-RPC message from Claude Code: a call (with an `id`) or a notification, and what its params can say: the
// protocol it speaks (initialize), or a tool permission it asks about (permission_request).
interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: RpcParams;
}
interface RpcParams {
  protocolVersion?: string;
  tool_name?: string;
  description?: string;
  input_preview?: string;
  request_id?: string;
}
// What the server can do, as initialize says it.
interface Capabilities {
  tools?: object;
  [kind: string]: unknown;
}

const me = identity();
const live = channelMode();
// Started for an agent agentbook runs, on a post agentbook registered (AGENTBOOK_PROC): what the person sends
// comes in through agentbook as the agent's next message, so there's no live delivery, and the post isn't this
// process's to end.
const isDriven = driven();
// Started with AGENTBOOK_OFF=1: this session isn't on agentbook, so this answers by itself and calls nothing.
const OFF = offSwitch();
const base = `/api/procs/${encodeURIComponent(me.proc)}`;
const UNREGISTERED = -32001; // see plugin/cli/mcp.ts
// agentbook, started if it isn't running (a driven agent's agentbook is running: it started the agent).
const ready = isDriven || OFF ? Promise.resolve(true) : ensureCli().catch(() => false);

const log = (...a: unknown[]) => process.stderr.write(`[agentbook] ${a.join(" ")}\n`);
const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params });
const err = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

/* ---------- agentbook's MCP server ---------- */

// Which post the tools write to, the folder Claude's relative paths are in, and whether it has the channel.
const route = `/api/mcp?${new URLSearchParams({ proc: me.proc, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), ...(live ? { live: "1" } : {}) })}`;
// A tool call can wait for the person (ab_ask's wait_seconds, up to 300 s).
const forward = (msg: RpcMessage) => api("POST", route, msg, { timeout: msg.method === "tools/call" ? 330e3 : 15e3 });

// Call agentbook as this session, registering first if it doesn't know us yet.
async function call(method: string, path: string, body?: unknown) {
  try {
    return await api(method, base + path, body);
  } catch (e) {
    if (!/isn't registered/.test(e.message) || isDriven) throw e;
    await ensureCli();
    await hello();
    return await api(method, base + path, body);
  }
}

// What this server can do: what agentbook's says, plus telling Claude Code when its tools change.
const capabilities = (c: Capabilities): Capabilities => ({ ...c, tools: { ...c.tools, listChanged: true } });

// Claude Code lists the tools once, when it starts. If agentbook couldn't answer then (it was restarting, or it's
// an older agentbook, without /api/mcp), the list was empty: once it answers, say the list changed, so Claude Code
// asks again. For ten minutes at most.
// What tells Claude Code its tools changed, once agentbook answers: whether it could.
let relist: Promise<boolean | undefined> | null = null;
function relistWhenBack(): void {
  relist ||= (async () => {
    for (let i = 0; i < 300; i++) {
      await sleep(2000);
      await ensureCli().catch(() => {});
      const back = await forward({ jsonrpc: "2.0", id: 0, method: "tools/list" }).then((a) => a?.result?.tools?.length > 0).catch(() => false);
      if (back) return notify("notifications/tools/list_changed", {});
    }
  })();
}

// What to answer when agentbook can't be reached.
function unreachable(msg: RpcMessage, e: Error) {
  switch (msg.method) {
    case "initialize": {
      relistWhenBack();
      // An agentbook from before /api/mcp keeps running until it's restarted.
      const why = /No such endpoint/.test(e.message) ? "it's an older agentbook, without its MCP server: `agentbook-cli down` restarts it with the next session" : e.message;
      return { protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: capabilities({ tools: {} }), serverInfo: { name: "agentbook", version: VERSION || "0.0.0" }, instructions: `agentbook's tools (ab_*) aren't here yet: agentbook at ${BASE_URL} couldn't answer (${why}). They show up once it does.` };
    }
    case "tools/list":
      relistWhenBack();
      return { tools: [] };
    case "tools/call":
      return err(`${e.message}. agentbook is at ${BASE_URL}.`);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      return {};
  }
}

// What it answers when the session is off agentbook (OFF): no tools, and why.
function offAnswer(msg: RpcMessage) {
  const why = "This session was started with AGENTBOOK_OFF=1, so it isn't a thread on agentbook and agentbook's tools (ab_*) aren't here.";
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agentbook", version: VERSION || "0.0.0" }, instructions: why };
    case "tools/list":
      return { tools: [] };
    case "tools/call":
      return err(why);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      return {};
  }
}

/* ---------- live delivery ---------- */

// An event, as a channel notification: what it says, and its kind and particulars (`meta`, as text).
function channelEvent(e: OutboxEvent): { content: string; meta: Record<string, string> } {
  const meta: Record<string, string> = { kind: e.type };
  if (e.type === "answer") {
    meta.question_id = e.question_id;
    if (e.key) meta.key = e.key;
    meta.question = e.question.slice(0, 200);
    if (e.by === "default") meta.by = "default";
    if (e.skipped) {
      meta.skipped = "true";
      if (e.by === "archived") meta.archived = "true";
      return { content: `The person ${e.by === "archived" ? "archived this thread, which closed this question unanswered" : "skipped this question"}. Decide yourself if it's safe to, or carry on without it.`, meta };
    }
    if (e.file) meta.path = e.file.path;
    return { content: e.file ? `${e.file.name} (sent as a file, saved at ${e.file.path})` : String(e.value), meta };
  }
  if (e.type === "message") {
    if (e.files?.length) meta.files = String(e.files.length);
    return { content: `${e.text || ""}${attached(e.files)}`.trim(), meta };
  }
  if (e.type === "file") {
    meta.path = e.path;
    meta.name = e.name;
    return { content: `${e.name} (${e.size} bytes) saved at ${e.path}`, meta };
  }
  if (e.type === "run") {
    meta.state = e.state;
    if (e.exit != null) meta.exit = String(e.exit);
  }
  return { content: describe(e), meta };
}

async function deliveryLoop() {
  for (;;) {
    try {
      // An answer an ab_ask call is waiting for stays out of these: that call returns it.
      const { events } = await api("GET", `${base}/events?wait=50&ack=1`, null, { timeout: 60000 });
      for (const { event } of events) {
        if (event.type === "permission") notify("notifications/claude/channel/permission", { request_id: event.request_id, behavior: event.behavior });
        else notify("notifications/claude/channel", channelEvent(event));
      }
    } catch (e) {
      // Kept off agentbook (Private terminals): nothing comes for it.
      if (/Private terminals/.test(e.message)) return;
      // Not registered yet (the SessionStart hook is still running), or agentbook-cli is down.
      if (!/isn't registered/.test(e.message)) log("delivery:", e.message);
      await sleep(2000);
      await ensureCli().catch(() => {});
    }
  }
}

async function relayPermission(p: RpcParams): Promise<void> {
  try {
    await call("POST", "/questions", { kind: "permission", title: `Allow ${p.tool_name}?`, detail: p.description, preview: p.input_preview, request_id: p.request_id, tool_name: p.tool_name });
  } catch (e) {
    log("permission relay:", e.message);
  }
}

/* ---------- JSON-RPC ---------- */

async function handle(msg: RpcMessage) {
  const { id, method, params } = msg;
  if (method === "notifications/claude/channel/permission_request") return OFF ? undefined : relayPermission(params || {});
  if (id === undefined) return; // agentbook needs no other notification
  if (OFF) return write({ jsonrpc: "2.0", id, result: offAnswer(msg) });
  await ready;
  let answer;
  try {
    answer = await forward(msg);
    // agentbook doesn't know this session yet: register it, and try again.
    if (answer?.error?.code === UNREGISTERED) {
      await ensureCli();
      await hello();
      answer = await forward(msg);
    }
  } catch (e) {
    log(`${method}:`, e.message);
    return write({ jsonrpc: "2.0", id, result: unreachable(msg, e) });
  }
  if (answer?.error?.code === UNREGISTERED) return write({ jsonrpc: "2.0", id, result: err(`${answer.error.message}. agentbook is at ${BASE_URL}.`) });
  if (method === "initialize" && answer?.result?.capabilities) answer.result.capabilities = capabilities(answer.result.capabilities);
  write({ ...answer, id });
}

if (live && !isDriven && !OFF) deliveryLoop();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((e) => log("handler:", e.message));
});
rl.on("close", async () => {
  // A driven agent's post ends when agentbook says so, not when its MCP server stops.
  if (isDriven || OFF) process.exit(0);
  try {
    await api("POST", `${base}/gone`, { reason: "Session ended" }, { timeout: 800 });
  } catch {}
  process.exit(0);
});
