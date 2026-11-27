// A stand-in for claude.ai's routines API (what `/schedule` and agentbook's Claude routines use), for tests and
// the demo: GET /v1/code/triggers, a routine's runs (GET /v1/code/sessions?trigger_id=…, a page at a time), a
// run's events (GET /v1/code/sessions/:id/events, newest first), Run now (POST /v1/code/triggers/:id/run) and
// changes (POST /v1/code/triggers/:id). Every request is kept in `calls`. Runs come one to a page, so paging shows.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "./harness-types.ts";

export const iso = (ms: number): string => new Date(ms).toISOString();
// An event of a run, at `ms`: { created_at, payload } with payload as Claude Code's stream-json.
export const ev = (ms: number, payload: object): RunEvent => ({ created_at: iso(ms), event_id: `e${ms}`, payload });

export interface RunEvent {
  created_at: string;
  event_id: string;
  payload: object;
}
// A routine, as claude.ai has it: its id and name, and the rest as the test gives it.
export interface Trigger {
  id: string;
  name: string;
  [field: string]: unknown;
}
// A routine's run (a session in claude.ai's API).
export interface Run {
  id: string;
  title: string;
  status: string;
  worker_status: string;
  created_at: string;
  last_event_at: string;
  config: { origin: string; model?: string };
}
// What GET /api/oauth/usage answers (five_hour, seven_day, ...), or { status, error } to fail.
export interface Usage {
  status?: number;
  error?: string;
  [limit: string]: unknown;
}
export interface ClaudeApiOptions {
  token?: string;
  triggers?: Trigger[];
  // By trigger id, newest first.
  runs?: Record<string, Run[]>;
  // By run (session) id, oldest first.
  events?: Record<string, RunEvent[]>;
  perPage?: number;
  usage?: Usage | (() => Usage) | null;
}
// A request it was sent; `body` is what agentbook sent.
export interface ClaudeApiCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Json;
  auth: string | undefined;
  beta: string | string[] | undefined;
}

// { token, triggers: [...], runs: { trigger id: [sessions, newest first] }, events: { session id: [events, oldest first] }, perPage,
//   usage: what GET /api/oauth/usage answers (what Claude Code's /usage reads), or a function giving it, or
//   { status, error } to fail }
export async function startClaudeApi({ token, triggers = [], runs = {}, events = {}, perPage = 1, usage = null }: ClaudeApiOptions = {}) {
  const calls: ClaudeApiCall[] = [];
  const api = { usage };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const u = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null, auth: req.headers.authorization, beta: req.headers["anthropic-beta"] });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { message: "bad token" } });
    let m: RegExpMatchArray | null;
    if (req.method === "GET" && u.pathname === "/api/oauth/usage") {
      const d = typeof api.usage === "function" ? api.usage() : api.usage;
      if (!d) return send(404, { error: { message: "not found" } });
      return d.status ? send(d.status, { error: { message: d.error } }) : send(200, d);
    }
    if (req.method === "GET" && u.pathname === "/v1/code/triggers") return send(200, { data: triggers, has_more: false });
    if (req.method === "GET" && u.pathname === "/v1/code/sessions") {
      const list = runs[u.searchParams.get("trigger_id")] || [];
      const from = Number(u.searchParams.get("cursor")) || 0;
      const to = from + perPage;
      return send(200, { data: list.slice(from, to), next_cursor: list.length > to ? String(to) : null });
    }
    if (req.method === "GET" && (m = u.pathname.match(/^\/v1\/code\/sessions\/([^/]+)\/events$/))) return send(200, { data: [...(events[m[1]] || [])].reverse().slice(0, Number(u.searchParams.get("limit")) || 200) });
    if (req.method === "POST" && (m = u.pathname.match(/^\/v1\/code\/triggers\/([^/]+)\/run$/))) {
      const t = triggers.find((x) => x.id === m[1]);
      if (!t) return send(404, { error: { message: "no such routine" } });
      const id = `cse_now${Date.now()}`;
      (runs[m[1]] ||= []).unshift({ id, title: t.name, status: "active", worker_status: "running", created_at: iso(Date.now()), last_event_at: iso(Date.now()), config: { origin: "manual" } });
      return send(200, { ok: true, session_id: id });
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/v1\/code\/triggers\/([^/]+)$/))) {
      const t = triggers.find((x) => x.id === m[1]);
      if (!t) return send(404, { error: { message: "no such routine" } });
      Object.assign(t, JSON.parse(body || "{}"));
      return send(200, t);
    }
    send(404, { error: { message: "not found" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(api, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, triggers, runs, events, close: () => server.close() });
}
