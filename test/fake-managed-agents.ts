// A stand-in for Claude Managed Agents' API in tests, in the test's own process: agents, environments, vaults, files,
// sessions, and their events (a history, and a stream that carries only what comes after it opens), as the docs have
// them. A session's "agent" follows the first words of each message:
//   Say <text>     replies <text>
//   Tool <name> <json>   calls one of the custom tools, then says what it answered
//   Shell <cmd>    runs bash by itself (with a step), then replies Ran it
//   Edit <path>    edits that path, in its sandbox
//   Risky <cmd>    runs bash after a confirmation, then replies Ran it, or Didn't run it
//   Slow           runs until it's interrupted
//   Spend          stops at its budget
//   Fail <text>    hits an error that ends its turn, saying <text>
//   End            its session terminates
// Its history comes newest first unless it's asked for in order, as the API's lists do. Every request is in `calls`.
// `drop()` cuts the open streams.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "./harness-types.ts";

export const KEY = "sk-ant-api03-fake-key-for-the-tests-0123456789";

// A block of a message's content.
interface Block {
  type: string;
  text?: string;
}
// An event of a session, as the API has it: its id, type and when, and the rest by its type.
export interface ManagedEvent {
  id: string;
  type: string;
  processed_at: string;
  [field: string]: unknown;
}
// An event agentbook sends: a message, an interrupt, a custom tool's result, a confirmation.
interface UserEvent {
  type: string;
  content?: Block[];
  custom_tool_use_id?: string;
  tool_use_id?: string;
  result?: string;
}
// Why a session went idle.
interface StopReason {
  type: string;
  event_ids?: string[];
}
export interface ManagedSession {
  id: string;
  status: string;
  // What made it.
  request: Json;
  events: ManagedEvent[];
  // Its open streams.
  watchers: Set<http.ServerResponse>;
  resources: Json[];
  slow?: boolean;
  // What it waits on: a custom tool's result, or a confirmation.
  waiting?: { id: string; then: (answer: string | boolean) => void } | null;
}
interface ManagedFile {
  id: string;
  filename: string;
  size_bytes: number;
  scope?: string;
  bytes: Buffer;
}

export async function fakeManaged() {
  // `body` is what agentbook sent.
  const calls: { method: string; path: string; query: Record<string, string>; body: Json; key: string | string[] | undefined; version: string | string[] | undefined; beta: string | string[] | undefined }[] = [];
  const agents = new Map<string, Json>();
  const environments = new Map<string, Json>();
  const sessions = new Map<string, ManagedSession>();
  const files = new Map<string, ManagedFile>();
  const vaults = new Set<string>();
  let seq = 0;
  const id = (p: string) => `${p}_${String(++seq).padStart(6, "0")}`;

  const emit = (s: ManagedSession, type: string, fields: object = {}) => {
    const e: ManagedEvent = { id: id("sevt"), type, processed_at: new Date().toISOString(), ...fields };
    s.events.push(e);
    for (const w of s.watchers) w.write(`event: message\ndata: ${JSON.stringify(e)}\n\n`);
    return e;
  };
  const say = (s: ManagedSession, text: string) => emit(s, "agent.message", { content: [{ type: "text", text }] });
  const idle = (s: ManagedSession, stop: StopReason = { type: "end_turn" }) => emit(s, "session.status_idle", { stop_reason: stop });
  const finish = (s: ManagedSession) => idle(s);

  function run(s: ManagedSession, text: string) {
    s.slow = false;
    emit(s, "session.status_running");
    const [word, ...rest] = text.trim().split(" ");
    const arg = rest.join(" ");
    if (word === "Say") {
      say(s, arg);
      return finish(s);
    }
    if (word === "Tool") {
      const [name, ...json] = rest;
      const e = emit(s, "agent.custom_tool_use", { name, input: JSON.parse(json.join(" ") || "{}") });
      s.waiting = { id: e.id, then: (out) => (say(s, `Tool said: ${out}`), finish(s)) };
      return idle(s, { type: "requires_action", event_ids: [e.id] });
    }
    if (word === "Shell") {
      const e = emit(s, "agent.tool_use", { name: "bash", input: { command: arg }, evaluated_permission: "allow" });
      emit(s, "agent.tool_result", { tool_use_id: e.id, content: [{ type: "text", text: "ok" }] });
      say(s, "Ran it");
      return finish(s);
    }
    if (word === "Edit") {
      const e = emit(s, "agent.tool_use", { name: "edit", input: { file_path: arg, old_string: "own", new_string: "other" }, evaluated_permission: "allow" });
      emit(s, "agent.tool_result", { tool_use_id: e.id, content: [{ type: "text", text: "ok" }] });
      say(s, "Edited it");
      return finish(s);
    }
    if (word === "Risky") {
      const e = emit(s, "agent.tool_use", { name: "bash", input: { command: arg }, evaluated_permission: "ask" });
      s.waiting = {
        id: e.id,
        then: (yes) => {
          emit(s, "agent.tool_result", { tool_use_id: e.id, is_error: !yes, content: [{ type: "text", text: yes ? "ok" : "denied" }] });
          say(s, yes ? "Ran it" : "Didn't run it");
          finish(s);
        },
      };
      return idle(s, { type: "requires_action", event_ids: [e.id] });
    }
    if (word === "Slow") return void (s.slow = true);
    if (word === "Spend") return idle(s, { type: "budget_reached" });
    if (word === "Fail") {
      emit(s, "session.error", { error: { type: "unknown_error", message: arg, retry_status: { type: "exhausted" } } });
      return finish(s);
    }
    if (word === "End") {
      s.status = "terminated";
      return emit(s, "session.status_terminated");
    }
    say(s, `Heard: ${text}`);
    finish(s);
  }

  const take = (s: ManagedSession, e: UserEvent) => {
    if (e.type === "user.interrupt") {
      if (s.slow) {
        s.slow = false;
        idle(s);
      }
      return;
    }
    const echo = emit(s, e.type, e);
    if (e.type === "user.message") setTimeout(() => run(s, e.content.map((b) => b.text).join("\n")), 5);
    if (e.type === "user.custom_tool_result" && s.waiting?.id === e.custom_tool_use_id) {
      const w = s.waiting;
      s.waiting = null;
      emit(s, "session.status_running");
      setTimeout(() => w.then(e.content.map((b) => b.text).join("\n")), 5);
    }
    if (e.type === "user.tool_confirmation" && s.waiting?.id === e.tool_use_id) {
      const w = s.waiting;
      s.waiting = null;
      emit(s, "session.status_running");
      setTimeout(() => w.then(e.result === "allow"), 5);
    }
    return echo;
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      req.on("data", (d: Buffer) => parts.push(d));
      req.on("end", () => resolve(Buffer.concat(parts)));
    });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const bytes = await readBody(req);
    const multipart = /multipart/.test(req.headers["content-type"] || "");
    const body: Json = bytes.length && !multipart ? JSON.parse(bytes.toString()) : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, key: req.headers["x-api-key"], version: req.headers["anthropic-version"], beta: req.headers["anthropic-beta"] });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const no = (status: number, message: string) => send(status, { type: "error", error: { type: "error", message } });
    if (req.headers["x-api-key"] !== KEY) return no(401, "invalid x-api-key");
    const p = url.pathname.split("/").filter(Boolean).slice(1);
    const [what, which, more] = p;
    if (what === "agents") {
      if (req.method === "POST") {
        const a = { id: id("agent"), ...body };
        agents.set(a.id, a);
        return send(200, a);
      }
      if (which) return agents.has(which) ? send(200, agents.get(which)) : no(404, "no such agent");
      return send(200, { data: [...agents.values()].slice(0, 1) });
    }
    if (what === "environments") {
      if (req.method === "POST") {
        const e = { id: id("env"), ...body };
        environments.set(e.id, e);
        return send(200, e);
      }
      return environments.has(which) ? send(200, environments.get(which)) : no(404, "no such environment");
    }
    if (what === "vaults") {
      if (req.method === "DELETE") vaults.delete(which);
      else if (!which) {
        const v = id("vlt");
        vaults.add(v);
        return send(200, { id: v });
      }
      return send(200, {});
    }
    if (what === "files") {
      if (req.method === "POST") {
        const name = /filename="([^"]+)"/.exec(bytes.toString("latin1"))?.[1] || "file";
        const f = { id: id("file"), filename: name, size_bytes: bytes.length };
        files.set(f.id, { ...f, bytes });
        return send(200, f);
      }
      if (more === "content") {
        res.writeHead(200);
        return res.end(files.get(which).bytes);
      }
      return send(200, { data: [...files.values()].filter((f) => f.scope === url.searchParams.get("scope_id")).map(({ bytes: _, ...f }) => f) });
    }
    if (what === "sessions") {
      if (!which) {
        if (!environments.has(body.environment_id) || !agents.has(body.agent.id)) return no(400, "no such agent or environment");
        const s: ManagedSession = { id: id("sesn"), status: "idle", request: body, events: [], watchers: new Set(), resources: [...(body.resources || [])] };
        sessions.set(s.id, s);
        return send(200, { id: s.id, status: s.status });
      }
      const s = sessions.get(which);
      if (!s) return no(404, "no such session");
      if (!more) return send(200, { id: s.id, status: s.status, usage: { list_cost: { amount: "137", currency: "USD" }, active_seconds: 12 } });
      if (more === "resources") {
        s.resources.push(body);
        return send(200, { id: id("res") });
      }
      if (more === "events" && p[3] === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": hello\n\n");
        s.watchers.add(res);
        res.on("close", () => s.watchers.delete(res));
        return;
      }
      if (more === "events" && req.method === "POST") return send(200, { data: body.events.map((e: UserEvent) => take(s, e)).filter(Boolean) });
      if (more === "events") {
        const size = Number(url.searchParams.get("limit")) || 20;
        const from = Number(url.searchParams.get("page") || 0);
        const all = url.searchParams.get("order") === "asc" ? s.events : [...s.events].reverse();
        const data = all.slice(from, from + size);
        return send(200, { data, next_page: from + size < s.events.length ? String(from + size) : null });
      }
    }
    no(404, `no ${url.pathname}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    agents,
    environments,
    sessions,
    vaults,
    // A file a session saved in its outputs folder.
    output(session: string, filename: string, text: string) {
      const f = { id: id("file"), filename, size_bytes: Buffer.byteLength(text), scope: session, bytes: Buffer.from(text) };
      files.set(f.id, f);
    },
    drop() {
      for (const s of sessions.values()) {
        for (const w of s.watchers) w.destroy();
        s.watchers.clear();
      }
    },
    say,
    finish,
    close: () => {
      for (const s of sessions.values()) for (const w of s.watchers) w.destroy();
      server.closeAllConnections?.();
      server.close();
    },
  };
}
