import path from "node:path";
import { COLORS } from "../../plugin/shared/pages.ts";
import { PREVIEW_URL, PUBLIC_URL } from "../config.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "../accounts.ts";
import type { PageColor } from "../../plugin/shared/types.ts";
import type { QueryContracts, QueryPath, QueryResponse } from "../../plugin/shared/api.ts";
import { store } from "./state.ts";

// Whom something is for: a request's signed-in person (admit() sets it), or the person the server acts for (a
// machine's owner, when its CLI asks).
export interface Viewer {
  user?: User | null;
}
// A request, with who's signed in and its body once it was read (readBody).
export interface Req extends IncomingMessage, Viewer {
  rawBody?: Buffer;
}
export type Res = ServerResponse;
// What a route gets besides its request and response: the parts its pattern names, and the query string.
interface RouteArgs {
  params: Record<string, string>;
  query: URLSearchParams;
}
type Handler = (req: Req, res: Res, args: RouteArgs) => unknown;

const MAX_BODY = 80 * 1024 * 1024;

/* ---------- helpers ---------- */

// `body`: what's sent as JSON, or with another `type`, its text or bytes.
export function send(res: Res, status: number, body: unknown, type = "application/json") {
  const data = type !== "application/json" && (typeof body === "string" || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(data);
}
export const ok = (res: Res, body: unknown = { ok: true }) => send(res, 200, body);
export const fail = (res: Res, status: number, error: string, extra: object = {}) => send(res, status, { error, ...extra });

// A request's body: its JSON, as what its route takes (`T`, what the page sends), or its bytes (`raw`).
export function readBody(req: Req, raw: true): Promise<Buffer>;
export function readBody<T>(req: Req, raw?: false): Promise<T>;
export function readBody(req: Req, raw = false): Promise<unknown> {
  // A body already read (to see where a request goes) is kept on the request.
  if (req.rawBody) {
    if (raw) return Promise.resolve(req.rawBody);
    try {
      return Promise.resolve(req.rawBody.length ? JSON.parse(req.rawBody.toString("utf8")) : {});
    } catch {
      return Promise.reject(new Error("Invalid JSON"));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      // Kept, so what reads it again (a signed command's second look) gets the same.
      req.rawBody = buf;
      if (raw) return resolve(buf);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export const str = (v: unknown, max = 2000) => (v == null ? "" : String(v).slice(0, max));
export const isColor = (v: unknown): v is PageColor => (COLORS as readonly unknown[]).includes(v);
export const slug = (name) => String(name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
// A model's name or alias ("sonnet", "claude-opus-5-5", "opus[1m]", "gpt-6.1-sol"); it goes on a command line.
export const modelName = (v) => {
  const m = str(v, 80).trim();
  return /^[a-zA-Z0-9][\w.:@\[\]\/-]*$/.test(m) ? m : "";
};
export const safeName = (name) => path.basename(String(name || "file")).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";

function storeFile(buf, name) {
  const stored = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${safeName(name)}`;
  store.files.write(stored, buf);
  return stored;
}

// "17:00" → today (or tomorrow) at 17:00 local; ISO strings pass through.
function parseUntil(v) {
  if (!v) return null;
  const s = String(v).trim();
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d < new Date()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// A poll's options: "Label|what it means", or { label, detail } (or description).
function options(list) {
  return (Array.isArray(list) ? list : []).slice(0, 6).map((o) => {
    if (o && typeof o === "object") return { label: str(String(o.label ?? "").trim(), 80), detail: str(String(o.detail ?? o.description ?? "").trim(), 140) || null };
    const [label, ...rest] = String(o).split("|");
    return { label: str(label.trim(), 80), detail: str(rest.join("|").trim(), 140) || null };
  });
}

/* ---------- routes ---------- */

export const routes: { method: string; re: RegExp; handler: Handler }[] = [];
export const route = (method: string, pattern: string, handler: Handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

// Query handlers return their contract's payload; this is the single place that sends it.
type QueryArgs<P extends QueryPath> = {
  params: QueryContracts[P]["params"];
  query: Omit<URLSearchParams, "get"> & { get(key: keyof QueryContracts[P]["query"]): string | null };
};
export function queryRoute<P extends QueryPath>(pattern: P, handler: (req: Req, res: Res, args: QueryArgs<P>) => QueryResponse<P> | void | Promise<QueryResponse<P> | void>) {
  route("GET", pattern, async (req, res, args) => {
    const body = await handler(req, res, args as QueryArgs<P>);
    if (body !== undefined) ok(res, body);
  });
}

export const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;

export const rawBody = (req: Req) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// Previews' own name serves previews and nothing else (peek links, an agent's HTML file by its link, and the health
// check, which a proxy may ask under either name), and the page's name serves none.
export const PREVIEW_HOST = PREVIEW_URL ? new URL(PREVIEW_URL).host : null;
