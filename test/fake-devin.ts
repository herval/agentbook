// A stand-in for Devin's v3 API in tests, in the test's own process: who a key is, an organization's sessions and
// their messages. What a session does is the test's: `update(id, fields)` and `said(id, text)`. A new session is
// working, and a message wakes it, `lag.ms` later. Every request is in `calls`.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "./harness-types.ts";

export const KEY = "cog_fake0key0for0the0tests0123456789";
export const ORG = "org-acme";

export interface DevinMessage {
  event_id: string;
  source: string;
  message: string;
  created_at: string;
  origin: string;
}
// A session, as Devin's API has it; `request` is what started it.
export interface DevinSession {
  session_id: string;
  url: string;
  status: string;
  status_detail: string;
  title: string;
  acus_consumed: number;
  pull_requests: { pr_url: string; pr_state?: string }[];
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  messages: DevinMessage[];
  request: Json;
}

export async function fakeDevin({ org = ORG }: { org?: string } = {}) {
  const lag = { ms: 0, status: 0 }; // how long a message takes to show in its status; how long a session's status takes to reach you
  // `body` is what agentbook sent.
  const calls: { method: string; path: string; query: Record<string, string>; body: Json; auth: string | undefined }[] = [];
  const sessions = new Map<string, DevinSession>();
  let seq = 0;
  const now = () => new Date().toISOString();
  const add = (s: DevinSession, source: string, message: string) => s.messages.push({ event_id: `evt-${++seq}`, source, message, created_at: now(), origin: "api" });
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      req.on("data", (d: Buffer) => parts.push(d));
      req.on("end", () => resolve(Buffer.concat(parts)));
    });
  const view = ({ messages: _, ...s }: DevinSession) => s;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const bytes = await readBody(req);
    const body: Json = bytes.length && !/multipart/.test(req.headers["content-type"] || "") ? JSON.parse(bytes.toString()) : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: "Invalid token" });
    if (url.pathname === "/v3/self") return send(200, { principal_type: "service_user", service_user_id: "su-1", service_user_name: "agentbook", org_id: org });
    const m = url.pathname.match(/^\/v3\/organizations\/([^/]+)\/(sessions|attachments)(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (!m) return send(404, { detail: "Not found" });
    const [, , kind, which, more] = m;
    if (kind === "attachments") return send(200, { url: `https://files.devin.test/${++seq}` });
    if (!which) {
      if (req.method !== "POST") return send(200, { items: [], has_next_page: false });
      const id = `devin-${(++seq).toString(16).padStart(8, "0")}`;
      const s: DevinSession = { session_id: id, url: `https://app.devin.test/sessions/${id}`, status: "running", status_detail: "working", title: body.title, acus_consumed: 0, pull_requests: [], created_at: now(), updated_at: now(), is_archived: false, messages: [], request: body };
      add(s, "user", body.prompt);
      sessions.set(id, s);
      return send(200, view(s));
    }
    const s = sessions.get(which);
    if (!s) return send(404, { detail: "No such session" });
    if (more === "messages" && req.method === "POST") {
      add(s, "user", body.message);
      const wake = () => Object.assign(s, { status: "running", status_detail: "working", updated_at: now() });
      if (lag.ms) setTimeout(wake, lag.ms);
      else wake();
      return send(200, view(s));
    }
    if (more === "messages") {
      const from = Number(url.searchParams.get("after") || 0);
      const first = Number(url.searchParams.get("first") || 100);
      const items = s.messages.slice(from, from + first);
      const end = from + items.length;
      return send(200, { items, end_cursor: String(end), has_next_page: end < s.messages.length, total: s.messages.length });
    }
    if (more === "sleep") {
      Object.assign(s, { status: "suspended", status_detail: "user_request", updated_at: now() });
      return send(200, view(s));
    }
    if (req.method === "DELETE") {
      s.status = "exit";
      return send(200, view(s));
    }
    const was = view(s);
    if (lag.status) setTimeout(() => send(200, was), lag.status);
    else send(200, was);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    sessions,
    lag,
    update: (id: string, fields: Partial<DevinSession>) => Object.assign(sessions.get(id), fields, { updated_at: now() }),
    said: (id: string, text: string) => add(sessions.get(id), "devin", text),
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
