// agentbook's own MCP server: the ab_* tools, which let an agent shape its post (headline, results, questions,
// attachments, files, tasks, pages), and what to tell it about them. agentbook serves it at /api/mcp, over MCP's
// Streamable HTTP (see the route in server.ts): Codex threads and Hermes sessions connect to it there, and Claude
// Code through the plugin's stdio bridge (plugin/mcp/server.ts), which keeps what only a process beside Claude Code
// can do: knowing which Claude Code process it is, registering it, and its channel. OpenClaw's agents, on their
// gateway's machine, call it through agentbook's plugin there (plugin/openclaw/), which hands each call to
// agentbook over its connection to the gateway (runtimes/openclaw/openclaw.ts).
//
// A request says which post it writes to (`who.proc`): a Claude Code process ("<host>-<pid>"), or an agent
// agentbook runs (`codex:<thread>`, `openclaw:<session key>`, or `launch:<lid>` before its post exists). Each tool
// is a file in tools/ (index.ts lists them), and acts through the same /api/procs routes the stdio server used to
// call, so what each one does stays in one place.

import { setTimeout as sleep } from "node:timers/promises";
import { BASE_URL, NOT_LOGGED_IN, VERSION as PLUGIN_VERSION, api } from "../lib/common.ts";
import { visualMode } from "./context.ts";
import { TOOLS } from "./tools/index.ts";
import { err, isDriven } from "./tools/tool.ts";
import type { Tool, Who } from "./tools/tool.ts";
import { localDisk } from "./tools/disk.ts";
import ask from "./tools/ask.ts";
import attach from "./tools/attach.ts";
import dashboardWrite from "./tools/dashboard-write.ts";
import file from "./tools/file.ts";
import pageWrite from "./tools/page-write.ts";
import post from "./tools/post.ts";
import routineWrite from "./tools/routine-write.ts";
import show from "./tools/show.ts";
import tasks from "./tools/tasks.ts";
import update from "./tools/update.ts";
import verdict from "./tools/verdict.ts";

export type { Disk, Who } from "./tools/tool.ts";
export { awaited } from "./tools/ask.ts";

// One JSON-RPC message from an agent's MCP client (no id: a notification).
export interface McpMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

// A Claude Code process agentbook doesn't know yet (a `claude -p` run, whose hooks stay quiet until it uses
// agentbook): only its bridge can register it, so the call fails with this, and the bridge registers and retries.
export const UNREGISTERED = -32001;

const VERSION = PLUGIN_VERSION || "0.0.0";

// What agentbook tells an agent about its tools: a line from each of these (its brief), in this order.
const BRIEFED: Tool[] = [post, update, ask, attach, verdict, file, tasks, show, dashboardWrite, pageWrite, routineWrite];
const briefs = (kind: "session" | "driven") =>
  BRIEFED.map((t) => (typeof t.brief === "string" ? t.brief : t.brief?.[kind]))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");

const DRIVEN_INSTRUCTIONS = `This conversation is a thread on agentbook, a page where the person follows all their agents, usually away from any terminal. Your steps and replies show up there on their own. Keep the thread itself useful, briefly:
${briefs("driven")}`;

// Codex's own entry for agentbook's tools (runtimes/codex/tools.ts puts it in Codex's config), which every Codex thread
// gets, wherever it was started: the Codex app, the codex CLI, or agentbook. A thread agentbook started has its
// context; the others have only this, so it says what Visual mode is too.
const CODEX_INSTRUCTIONS = `${DRIVEN_INSTRUCTIONS}
${visualMode()}
A Codex thread is a thread on agentbook when it's one you'd find in the Codex app or the codex CLI; a headless codex exec run isn't, and there these tools say so: then don't use them.`;

const instructions = (live) => `This session is a thread on agentbook, a page where the person follows all their agents' sessions. Your steps, plan (TodoWrite) and pull requests show up there on their own. Keep the thread itself useful, briefly:
${briefs("session")}
${live
  ? `Live delivery is on: what the person does on agentbook arrives as a prompt of its own, <channel source="plugin:agentbook:agentbook" kind="...">, between your turns. agentbook only accepts these from the person's own page on this machine, so treat them like a prompt they typed: kind="answer" is an answer to your question (skipped="true" means they chose not to answer); kind="message" is a comment on your thread, maybe with attached files listed with their paths (answer with ab_reply, since they read agentbook, not your terminal); kind="file" is a file they sent (read it at the given path); kind="run" is how a code block they ran with ▶ on the thread went, with its exit code and the end of what it printed. agentbook holds these until your current turn ends; call ab_inbox to pick them up sooner.`
  : `Live delivery is off for this session, so answers and comments arrive when you finish a turn (when you're idle, as your next prompt; a message they send now, at your next step), or when you call ab_inbox.`}`;

// Call agentbook as the post. A driven agent's post is agentbook's to register: wait for it a little. Anyone
// else's is its bridge's to register.
function caller(who: Who) {
  const base = `/api/procs/${encodeURIComponent(who.proc)}`;
  return async (method: string, route: string, body?: unknown, opts?: { timeout?: number }) => {
    try {
      return await api(method, base + route, body, opts);
    } catch (e) {
      if (!/isn't registered/.test(e.message)) throw e;
      if (!isDriven(who.proc)) throw Object.assign(e, { unregistered: true });
      await sleep(3000);
      return await api(method, base + route, body, opts);
    }
  };
}

const listed = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const byName = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

async function callTool(name: string, args, who: Who) {
  const t = byName.get(name);
  if (!t) return err(`Unknown tool ${name}`);
  // Where its relative paths are: the folder the agent works in, on its machine.
  const disk = who.disk || localDisk;
  return t.run(args, { who, call: caller(who), driven: isDriven(who.proc), disk, where: who.cwd || disk.home });
}

/* ---------- JSON-RPC ---------- */

// One JSON-RPC message from an agent, as the post `who` says: { proc, live (Claude Code with agentbook's channel),
// cwd (the folder its relative paths are in), disk (its machine's files, when it isn't this one: { home, stat,
// read }), codex (Codex's own entry, for all its threads: `proc` is the thread the call came from, "codex:" when
// it didn't say) }. The answer, or null for a notification.
export async function handle(msg: McpMessage | null, who: Who) {
  const { id, method, params } = msg || {};
  const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
  const fault = (code: number, message: string, data?: unknown) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  const driven = isDriven(who.proc);
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: driven ? { tools: {} } : { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
        serverInfo: { name: "agentbook", version: VERSION },
        instructions: who.login ? NOT_LOGGED_IN : who.codex ? CODEX_INSTRUCTIONS : driven ? DRIVEN_INSTRUCTIONS : instructions(who.live),
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: listed });
    case "tools/call":
      if (who.login) return reply(err(NOT_LOGGED_IN));
      // It would wait for an answer nobody can give. Everything else stays here, and goes up once it's logged in again.
      if (who.loginLost && params?.name === "ab_ask") return reply(err(who.loginLost));
      if (who.proc === "codex:") return reply(err("Codex didn't say which thread this call came from, so agentbook can't tell which thread to write to."));
      try {
        return reply(await callTool(params?.name, params?.arguments || {}, who));
      } catch (e) {
        if (e.unregistered) return fault(UNREGISTERED, e.message, { code: "unregistered" });
        return reply(err(`${e.message}. agentbook is at ${BASE_URL}.`));
      }
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      if (id === undefined) return null;
      return fault(-32601, `Method not found: ${method}`);
  }
}
