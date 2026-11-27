#!/usr/bin/env node
// A stand-in for the `hermes` command in tests, writing to $HERMES_HOME/state.db the way Hermes does (the test
// makes the database). Each call is logged to FAKE_HERMES_DIR/calls.jsonl.
//   hermes acp                   ACP over stdio: initialize, session/new, session/load, session/prompt,
//                                session/cancel. A prompt runs a command and replies "Done: <prompt>"; one
//                                that deletes something asks permission first; a "slow" one waits to be cancelled;
//                                "Headline: <title>" calls agentbook's ab_post through the MCP server the session
//                                was given (logged as a "tool" call), "Rename: <title>" with rename: true. It takes MCP servers over HTTP while
//                                FAKE_HERMES_DIR/http exists when it starts, else only as commands.
//   hermes chat --resume <id> …  the prompt on stdin continues that session: it replies "Resumed: <prompt>".

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

// An MCP server ACP gives a session: at an address, or a command to run.
export interface McpServer {
  name: string;
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
}
// What a tool call answered.
export interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}
// A message from the client: a request, or its answer to one of ours.
interface AcpMessage {
  id?: number;
  method?: string;
  params?: { sessionId?: string; cwd?: string; mcpServers?: McpServer[]; prompt?: { type: string; text: string }[] };
  result?: unknown;
}
// More of a message in the database: the tool calls it made, or the call it answers.
interface Extra {
  tool_calls?: object[];
  tool_call_id?: string;
  tool_name?: string;
}

const args = process.argv.slice(2);
const log = (entry: object) => fs.appendFileSync(path.join(process.env.FAKE_HERMES_DIR, "calls.jsonl"), JSON.stringify(entry) + "\n");
const db = new DatabaseSync(path.join(process.env.HERMES_HOME, "state.db"));
db.exec("PRAGMA busy_timeout = 5000");
const now = () => Date.now() / 1000;
const say = (sid: string, role: string, content: string, extra: Extra = {}) =>
  db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").run(sid, role, content, extra.tool_calls ? JSON.stringify(extra.tool_calls) : null, extra.tool_call_id || null, extra.tool_name || null, now());
const lease = (sid: string, on: boolean) => (on ? db.prepare("INSERT INTO session_turn_leases (conversation_id, holder, expires_at) VALUES (?, ?, ?)").run(sid, `pid=${process.pid}:fake`, now() + 300) : db.prepare("DELETE FROM session_turn_leases WHERE conversation_id = ?").run(sid));
const ranCommand = (sid: string, cmd: string) => {
  const id = `call_${crypto.randomUUID().slice(0, 8)}`;
  say(sid, "assistant", "", { tool_calls: [{ id, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: cmd }) } }] });
  say(sid, "tool", "ok", { tool_call_id: id, tool_name: "terminal" });
};

if (args[0] === "config") {
  log({ cmd: "config", args });
  const wait = setInterval(() => {
    if (!fs.existsSync(path.join(process.env.FAKE_HERMES_DIR, "config-hold"))) { clearInterval(wait); process.exit(0); }
  }, 20);
} else if (args[0] === "chat") {
  const sid = args[args.indexOf("--resume") + 1];
  let text = "";
  process.stdin.on("data", (d) => (text += d));
  process.stdin.on("end", () => {
    log({ cmd: "chat", args, cwd: process.cwd(), text });
    say(sid, "user", text);
    say(sid, "assistant", `Resumed: ${text}`);
    process.stdout.write(JSON.stringify({ type: "result", session_id: sid, exit_code: 0, text: `Resumed: ${text}` }) + "\n");
    process.exit(0);
  });
} else if (args[0] === "acp") {
  const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const waiting = new Map<number, (result: unknown) => void>(); // our requests to the client
  const cancels = new Map<string, () => void>(); // session -> resolve
  let nextId = 1000;
  const ask = (method: string, params: object) => new Promise<{ outcome?: { outcome?: string; optionId?: string } }>((resolve) => (waiting.set(nextId, resolve), send({ id: nextId++, method, params })));
  const http = fs.existsSync(path.join(process.env.FAKE_HERMES_DIR, "http"));
  const servers = new Map<string, McpServer[]>(); // session -> the MCP servers ACP gave it

  // One of agentbook's tools, through the server the session has: at its address, or a command it runs.
  async function callTool(sid: string, name: string, args: object): Promise<ToolResult | null> {
    const s = (servers.get(sid) || []).find((x) => x.name === "agentbook");
    if (!s) return null;
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    if (s.type === "http") return ((await (await fetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) })).json()) as { result?: ToolResult }).result;
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(s.command, s.args, { stdio: ["pipe", "pipe", "ignore"] });
      readline.createInterface({ input: child.stdout }).once("line", (l) => {
        resolve(JSON.parse(l).result);
        child.kill();
      });
      child.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  async function prompt(sid: string, text: string) {
    lease(sid, true);
    say(sid, "user", text);
    let stopReason = "end_turn";
    if (/delete|rm /i.test(text)) {
      const r = await ask("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "tc-1", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      log({ cmd: "permission", sessionId: sid, outcome: r.outcome });
      if (r.outcome?.optionId === "allow_once") ranCommand(sid, "rm -rf build");
      say(sid, "assistant", r.outcome?.optionId === "allow_once" ? "Deleted the build folder." : "Left it alone.");
    } else if (/^(Headline|Rename): /.test(text)) {
      const r = await callTool(sid, "ab_post", /^Rename/.test(text) ? { title: text.slice(8), rename: true } : { title: text.slice(10) });
      log({ cmd: "tool", sessionId: sid, result: r });
      say(sid, "assistant", r && !r.isError ? "Set the headline." : "I have no agentbook tools.");
    } else if (/slow/i.test(text)) {
      await new Promise<void>((resolve) => cancels.set(sid, resolve));
      stopReason = "cancelled";
    } else {
      ranCommand(sid, "ls");
      say(sid, "assistant", `Done: ${text}`);
    }
    db.prepare("UPDATE sessions SET last_activity_at = ?, title = COALESCE(title, ?) WHERE id = ?").run(now(), text.slice(0, 40), sid);
    lease(sid, false);
    return { stopReason };
  }

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const m: AcpMessage = JSON.parse(line);
    if (m.id != null && !m.method) {
      waiting.get(m.id)?.(m.result);
      return waiting.delete(m.id);
    }
    log({ cmd: "acp", method: m.method, params: m.params, ...(m.method === "initialize" ? { providerKey: !!process.env.OPENROUTER_API_KEY } : {}) });
    const p = m.params || {};
    switch (m.method) {
      case "initialize":
        return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http, sse: false } } } });
      case "session/new": {
        const sid = crypto.randomUUID();
        db.prepare("INSERT INTO sessions (id, source, cwd, started_at, last_activity_at, hidden) VALUES (?, 'acp', ?, ?, ?, 0)").run(sid, p.cwd, now(), now());
        servers.set(sid, p.mcpServers || []);
        return send({ id: m.id, result: { sessionId: sid } });
      }
      case "session/load":
        servers.set(p.sessionId, p.mcpServers || []);
        return send({ id: m.id, result: null });
      case "session/prompt":
        return send({ id: m.id, result: await prompt(p.sessionId, p.prompt.map((c) => c.text).join("\n")) });
      case "session/cancel":
        return cancels.get(p.sessionId)?.();
      default:
        if (m.id != null) send({ id: m.id, error: { code: -32601, message: `fake hermes can't ${m.method}` } });
    }
  });
} else {
  console.error(`fake hermes: ${args.join(" ")}`);
  process.exit(1);
}
