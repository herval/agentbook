// A stand-in OpenClaw gateway for tests: a WebSocket server speaking enough of protocol 4. It challenges each
// connection, checks the device's signature and id the way OpenClaw does, takes the shared token, a device
// token it issued, or a setup code's bootstrap token (as `openclaw qr` makes them: bound to the first device that
// uses it), and holds a new device until the test approves it (as `openclaw devices approve` would). Methods are
// answered by fake-openclaw-state.ts; the ones that change something broadcast sessions.changed. It ticks every
// `tickMs`, as OpenClaw does every 30s, and it can go away for a while (down, up) or go quiet (freeze). It can
// hold back its answers to one method (hold), as a busy gateway takes minutes to read a history, and say what
// was added to a session's history as session.message events (tell).
//
// Scopes, as OpenClaw has them: a device is approved for the scopes it first asked for, its token has those, and a
// connection asking for more than its token has is turned down (AUTH_SCOPE_MISMATCH), or for more than its device
// was approved for, held for approval (PAIRING_REQUIRED). cron.run and cron.update need operator.admin, and chat.send
// and sessions.create are kept in `sends` with whether they came as its owner's (a connection with admin, as
// OpenClaw's senderIsOwner). A connected device can ask for more live (device.scopes.requestUpgrade), and hears how
// that went on device.scopes.waitUpgrade: approving it (approveUpgrade) gives it a new token, on that connection,
// without closing it. takeAdmin is the device's token losing admin (rotated with less, on the gateway).
//
// It can load a plugin (install, as `openclaw plugins install` does, from the folder it's in): the plugin registers
// through a stand-in of OpenClaw's plugin API what agentbook's plugin (plugin/openclaw/) uses: a service, given the
// gateway's events (broadcast to operators as plugin.<id>.<event>); gateway methods, answered for operators like the
// gateway's own, each told its client's connection and when it ends; tools, which must be named in its manifest;
// and the before_prompt_build hook, each from the load OpenClaw takes it from (see install). A test plays an agent
// with them: the tools a session has (tools), calling one (run), and what its prompt gets (prompt).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { answer, type OcState, type Params } from "./fake-openclaw-state.ts";

// A device as the gateway keeps it: approved or waiting, what it asked for, what it was approved for (`scopes`), its
// token and what that has.
interface Device {
  approved: boolean;
  asked?: string[];
  scopes?: string[] | null;
  deviceToken?: string;
  tokenScopes?: string[];
}
type UpgradeResult = { status: "approved"; requestId: string; deviceToken: string; scopes: string[] } | { status: "rejected"; requestId: string };
interface Upgrade {
  deviceId: string;
  scopes: string[];
  result: UpgradeResult | null;
  waiters: ((result: UpgradeResult) => void)[];
}
interface Bootstrap {
  expiresAt: number;
  deviceId?: string;
  revoked?: boolean;
}
// A connection: hello once it's connected, as the device and scopes it connected with.
interface Conn {
  socket: Duplex;
  nonce: string;
  ts: number;
  hello: boolean;
  connId: string;
  ended: AbortController;
  send: (o: object) => unknown;
  scopes?: string[];
  caps?: string[];
  deviceId?: string;
}
// A request's params: a method's (fake-openclaw-state.ts), connect's, and a scope upgrade's.
interface FrameParams extends Params {
  scopes?: string[];
  caps?: string[];
  decision?: string;
  requestId?: string;
  role?: string;
  device?: { id?: string; publicKey?: string; signature?: string; signedAt?: number; nonce?: string };
  auth?: { token?: string; bootstrapToken?: string };
  client?: { id?: string; mode?: string; platform?: string; deviceFamily?: string; displayName?: string };
  result?: unknown;
}
interface Frame {
  type: string;
  id: string;
  method: string;
  params?: FrameParams;
}
type Respond = (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
type ErrorWithDetails = Error & { details?: object };

/* ---------- OpenClaw's plugin API, as far as agentbook's plugin uses it ---------- */

interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  debug(...a: unknown[]): void;
}
interface Service {
  start(ctx: { gatewayEvents: { emit(event: string, payload: unknown): void }; logger: Logger; stateDir: string }): unknown;
  stop?(ctx: object): unknown;
}
type MethodHandler = (call: { params: FrameParams; client: { connId: string; connectionSignal: AbortSignal }; respond: Respond }) => unknown;
type ToolContext = { sessionKey?: string; agentId?: string; workspaceDir?: string };
interface Tool {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, unknown> };
  execute(id: string, args: object, signal: AbortSignal | undefined, onUpdate: undefined): unknown;
}
type ToolFactory = (ctx: ToolContext) => Tool | Tool[] | null;
type Hook = (event: { prompt: string; messages: unknown[] }, ctx: ToolContext) => unknown;
interface PluginApi {
  id: string;
  registrationMode: string;
  logger: Logger;
  registerService(svc: Service): void;
  registerGatewayMethod(name: string, handler: MethodHandler): void;
  registerTool(factory: ToolFactory, opts?: { name?: string; names?: string[] }): void;
  on(name: string, fn: Hook): void;
}
// openclaw.plugin.json, the parts read here.
interface Manifest {
  id: string;
  contracts?: { tools?: string[] };
}
// What one load registers.
interface Registry {
  services: Service[];
  methods: Map<string, MethodHandler>;
  tools: ToolFactory[];
  hooks: Map<string, Hook>;
}
interface Plugin extends Registry {
  id: string;
  manifest: Manifest;
}
// <dir>/state.json's parts only the gateway reads: an agent's artifacts' media, and files it sent, by path.
export interface GatewayState extends Omit<OcState, "media"> {
  media?: Record<string, { base64: string; mimeType?: string; chunk?: number; every?: number; stall?: number }>;
  sent?: Record<string, { base64: string; mimeType?: string }>;
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CHANGES = new Set(["sessions.create", "chat.send", "sessions.abort", "exec.approval.resolve", "plugin.approval.resolve", "question.resolve"]);
// Approvals as OpenClaw shows them: one its own runtime asked for (`runtime: true` in the state) only to a connection
// with admin, which alone can answer it ("approval expired or not found" to the rest).
const APPROVAL_LISTS: Record<string, "approvals" | "toolApprovals"> = { "exec.approval.list": "approvals", "plugin.approval.list": "toolApprovals", "exec.approval.resolve": "approvals", "plugin.approval.resolve": "toolApprovals" };
const ADMIN = "operator.admin";
const ADMIN_ONLY = new Set(["cron.run", "cron.update", "cron.add", "cron.remove", "config.patch"]);
const within = (asked: string[] | undefined, has: string[] | null | undefined) => (asked || []).every((x) => (has || []).includes(x) || (has || []).includes(ADMIN));

export function startGateway({ dir, token, port = 0, tickMs = 30000 }: { dir: string; token?: string; port?: number; tickMs?: number }) {
  const devices = new Map<string, Device>(); // device id -> { approved, deviceToken, scopes (what it was approved for), tokenScopes }
  const upgrades = new Map<string, Upgrade>(); // request id -> { deviceId, scopes, result, waiters: [resolve] }
  const sends: { method: string; params: FrameParams; owner: boolean }[] = []; // chat.send and sessions.create: { method, params, owner }
  const resolves: { method: string; params: FrameParams; owner: boolean }[] = []; // exec.approval.resolve and plugin.approval.resolve
  let limited = false; // turning every sign-in away, as after too many failed ones from an address
  let frozen = false; // connected, but saying and answering nothing, like a gateway on a laptop that slept
  const held = new Map<string, [Conn, Frame][]>(); // method -> the requests for it not answered yet
  const requests = new Map<string, string>(); // request id -> device id
  const bootstraps = new Map<string, Bootstrap>(); // bootstrap token -> { expiresAt, deviceId, revoked }
  const conns = new Set<Conn>();
  const connects: FrameParams[] = [];
  // The plugin installed, if one is: { id, manifest, services, methods: Map(name -> handler), tools: [factory], hooks: Map(name -> fn) }.
  let plugin: Plugin | null = null;
  const pluginCalls: { method: string; params: FrameParams }[] = [];
  const state = (): GatewayState => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));

  function frame(text: string) {
    const data = Buffer.from(text);
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(data.length));
      return b;
    })()]);
    return Buffer.concat([head, data]);
  }

  // Over HTTP, the media its artifacts.download links to: <dir>/state.json's `media`, by artifact id
  // ({ base64, mimeType, and chunk, every, stall for one far away }), for a link with its ticket. Each request
  // is kept in `fetches`.
  // And as its Control UI gets a file an agent sent with a MEDIA: line (or one in its workspace): assistant-media,
  // by where it is on the gateway's machine (<dir>/state.json's `sent`, by path), or a piece of it for a Range,
  // for a request signed in with the gateway's token or a device token it issued (each one's Authorization kept
  // in `mediaAsks`). `turnAway` answers 401 instead, as a gateway does a token it doesn't know.
  const fetches: string[] = [];
  const mediaAsks: { auth: string; source: string | null; sessionKey: string | null }[] = [];
  const metaAsks: { auth: string; source: string | null; sessionKey: string | null }[] = [];
  let turnAway = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://gateway");
    fetches.push(u.pathname + u.search);
    if (u.pathname === "/__openclaw__/assistant-media") {
      const auth = req.headers.authorization || "";
      mediaAsks.push({ auth, source: u.searchParams.get("source"), sessionKey: u.searchParams.get("sessionKey") });
      const bearer = auth.replace(/^Bearer /, "");
      if (turnAway || !bearer || (bearer !== token && ![...devices.values()].some((d) => d.deviceToken === bearer))) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      const sent = state().sent?.[u.searchParams.get("source")];
      // What its Control UI asks before showing one (meta=1): whether it's there. Kept in `metaAsks`, not `mediaAsks`.
      if (u.searchParams.get("meta") === "1") {
        metaAsks.push(mediaAsks.pop());
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sent ? { available: true, sizeBytes: Buffer.from(sent.base64, "base64").length } : { available: false, code: "file-not-found", reason: "File not found" }));
      }
      if (!sent) return res.writeHead(404).end();
      // A piece of it, when that's what's asked (as a player does).
      const buf = Buffer.from(sent.base64, "base64");
      const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      if (!r) return res.writeHead(200, { "content-type": sent.mimeType, "content-length": buf.length, "accept-ranges": "bytes" }).end(buf);
      const [start, end] = [Number(r[1]), r[2] ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1];
      return res.writeHead(206, { "content-type": sent.mimeType, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${buf.length}`, "accept-ranges": "bytes" }).end(buf.subarray(start, end + 1));
    }
    const m = /^\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\/full$/.exec(u.pathname);
    const media = m && state().media?.[m[1]];
    if (!media || u.searchParams.get("mediaTicket") !== `t-${m[1]}`) return res.writeHead(404).end();
    // A piece of it, for a Range, as OpenClaw's gateway answers one; `ranges` keeps each piece asked for.
    const buf = Buffer.from(media.base64, "base64");
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (r) ranges.push({ artifact: m[1], range: req.headers.range });
    const [start, end] = r ? [Number(r[1]), r[2] ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1] : [0, buf.length - 1];
    res.writeHead(r ? 206 : 200, { "content-type": media.mimeType, "content-length": end - start + 1, "accept-ranges": "bytes", ...(r ? { "content-range": `bytes ${start}-${end}/${buf.length}` } : {}) });
    const body = buf.subarray(start, end + 1);
    // From far away, the whole of it comes slowly (`chunk` bytes every `every` ms), or stops coming after `stall`
    // bytes, its connection left open, saying nothing. A piece asked for comes at once.
    if (!media.every || r) return res.end(body);
    slow.add(res);
    res.on("close", () => slow.delete(res));
    let at = 0;
    const tick = () => {
      if (res.destroyed || (media.stall != null && at >= media.stall)) return;
      res.write(body.subarray(at, (at += media.chunk)));
      if (at >= body.length) return res.end();
      setTimeout(tick, media.every);
    };
    tick();
  });
  const ranges: { artifact: string; range: string }[] = [];
  const slow = new Set<http.ServerResponse>(); // responses still coming slowly, or stuck
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // OpenClaw compresses what it sends to a client that offers to take it so, and Node 22's WebSocket, which
    // always offers, drops the connection when a message unpacks to more than 4 MB: so does this, to such a client.
    const compressed = /permessage-deflate/i.test(req.headers["sec-websocket-extensions"] || "");
    const send = (o: object) => {
      const text = JSON.stringify(o);
      if (compressed && Buffer.byteLength(text) > 4 << 20) return socket.destroy();
      return socket.writable && socket.write(frame(text));
    };
    const c: Conn = { socket, nonce: crypto.randomBytes(16).toString("hex"), ts: Date.now(), hello: false, connId: crypto.randomUUID(), ended: new AbortController(), send };
    conns.add(c);
    socket.on("close", () => {
      conns.delete(c);
      c.ended.abort();
    });
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (frozen) return;
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let at = 2;
        if (len === 126) (len = buf.readUInt16BE(2)), (at = 4);
        else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (at = 10);
        const masked = buf[1] & 128;
        const need = at + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        const mask = masked ? buf.subarray(at, at + 4) : null;
        const data = Buffer.from(buf.subarray(at + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(need);
        if (op === 8) return socket.end(Buffer.from([0x88, 0]));
        if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
        if (op === 1) onRequest(c, JSON.parse(data.toString("utf8")));
      }
    });
    if (!frozen) c.send({ type: "event", event: "connect.challenge", payload: { nonce: c.nonce, ts: c.ts } });
  });

  const refuse = (c: Conn, id: string, message: string, details: object = {}) => c.send({ type: "res", id, ok: false, error: { code: "INVALID_REQUEST", message, details } });

  function onRequest(c: Conn, f: Frame) {
    if (f.type !== "req") return;
    if (f.method === "connect") return connect(c, f);
    if (!c.hello) return refuse(c, f.id, "unauthorized: connect first");
    if (held.has(f.method)) return held.get(f.method).push([c, f]);
    const admin = (c.scopes || []).includes(ADMIN);
    if (ADMIN_ONLY.has(f.method) && !admin) return c.send({ type: "res", id: f.id, ok: false, error: { code: "INVALID_REQUEST", message: "missing scope: operator.admin" } });
    if (f.method === "chat.send" || f.method === "sessions.create") sends.push({ method: f.method, params: f.params || {}, owner: admin });
    const list = APPROVAL_LISTS[f.method];
    if (list && !admin) {
      const hidden = new Set((state()[list] || []).filter((a) => a.runtime).map((a) => a.id));
      if (f.method.endsWith(".list")) return c.send({ type: "res", id: f.id, ok: true, payload: (state()[list] || []).filter((a) => !hidden.has(a.id)) });
      if (hidden.has(f.params?.id)) return refuse(c, f.id, "approval expired or not found");
    }
    if (f.method.endsWith(".approval.resolve")) resolves.push({ method: f.method, params: f.params || {}, owner: admin });
    if (f.method === "device.scopes.requestUpgrade") {
      const asked = f.params?.scopes || [];
      if (!c.deviceId) return refuse(c, f.id, "device identity required");
      if (!within(c.scopes, asked)) return refuse(c, f.id, "requested scopes must include the connection's current scopes");
      const requestId = `up-${crypto.randomBytes(3).toString("hex")}`;
      upgrades.set(requestId, { deviceId: c.deviceId, scopes: asked, result: null, waiters: [] });
      return c.send({ type: "res", id: f.id, ok: true, payload: { requestId } });
    }
    if (f.method === "device.scopes.waitUpgrade") {
      const u = upgrades.get(f.params?.requestId);
      if (!u || u.deviceId !== c.deviceId) return refuse(c, f.id, "scope upgrade expired or not found");
      const say = (result: UpgradeResult) => c.send({ type: "res", id: f.id, ok: true, payload: result });
      return u.result ? say(u.result) : u.waiters.push(say);
    }
    const handler = plugin?.methods.get(f.method);
    if (handler) {
      pluginCalls.push({ method: f.method, params: f.params || {} });
      const respond: Respond = (ok, payload, error) => c.send(ok ? { type: "res", id: f.id, ok: true, payload } : { type: "res", id: f.id, ok: false, error: error || { code: "UNAVAILABLE", message: "failed" } });
      return Promise.resolve(handler({ params: f.params || {}, client: { connId: c.connId, connectionSignal: c.ended.signal }, respond })).catch((e) => refuse(c, f.id, e.message));
    }
    try {
      c.send({ type: "res", id: f.id, ok: true, payload: answer(dir, f.method, f.params || {}) });
      if (CHANGES.has(f.method)) broadcast("sessions.changed", { reason: f.method });
    } catch (e) {
      refuse(c, f.id, e.message, (e as ErrorWithDetails).details);
    }
  }

  function connect(c: Conn, f: Frame) {
    const p: FrameParams = f.params || {};
    connects.push(p);
    if (limited) return refuse(c, f.id, "unauthorized: too many failed authentication attempts (retry later)", { code: "AUTH_RATE_LIMITED" });
    const d = p.device || {};
    const raw = Buffer.from(d.publicKey || "", "base64url");
    if (raw.length !== 32 || crypto.createHash("sha256").update(raw).digest("hex") !== d.id) return refuse(c, f.id, "device identity mismatch", { code: "DEVICE_AUTH_DEVICE_ID_MISMATCH" });
    if (d.nonce !== c.nonce || d.signedAt !== c.ts) return refuse(c, f.id, "device nonce mismatch", { code: "DEVICE_AUTH_NONCE_MISMATCH" });
    const known = devices.get(d.id);
    let sent = p.auth?.token || "";
    if (!sent && p.auth?.bootstrapToken) {
      const b = bootstraps.get(p.auth.bootstrapToken);
      if (!b || b.revoked || b.expiresAt <= Date.now() || (b.deviceId && b.deviceId !== d.id)) return refuse(c, f.id, "unauthorized: setup code invalid, expired, revoked, or already used (create a new code; review `openclaw devices list`)", { code: "AUTH_BOOTSTRAP_TOKEN_INVALID" });
      b.deviceId = d.id;
      sent = p.auth.bootstrapToken; // what the device signs
    } else if (sent !== token && !(known?.deviceToken && sent === known.deviceToken)) return refuse(c, f.id, "unauthorized: gateway token mismatch", { code: "AUTH_TOKEN_MISMATCH" });
    // OpenClaw's v3 line: version, device, client, mode, role, scopes, signed at, token, nonce, platform, device family.
    const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
    const line = ["v3", d.id, p.client?.id, p.client?.mode, p.role, (p.scopes || []).join(","), String(d.signedAt), sent, d.nonce, lower(p.client?.platform), lower(p.client?.deviceFamily)].join("|");
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    if (!crypto.verify(null, Buffer.from(line, "utf8"), key, Buffer.from(d.signature || "", "base64url"))) return refuse(c, f.id, "device signature invalid", { code: "DEVICE_AUTH_SIGNATURE_INVALID" });
    if (!known?.approved || (known.scopes && !within(p.scopes, known.scopes))) {
      const requestId = [...requests].find(([, id]) => id === d.id)?.[0] || `req-${crypto.randomBytes(3).toString("hex")}`;
      requests.set(requestId, d.id);
      if (!known) devices.set(d.id, { approved: false, asked: p.scopes });
      else known.asked = p.scopes;
      return refuse(c, f.id, "pairing required", { code: "PAIRING_REQUIRED", requestId });
    }
    if (known.deviceToken && sent === known.deviceToken && !within(p.scopes, known.tokenScopes)) return refuse(c, f.id, "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)", { code: "AUTH_SCOPE_MISMATCH" });
    known.scopes ||= p.scopes || [];
    if (!known.deviceToken) {
      known.deviceToken = `dt-${crypto.randomBytes(12).toString("hex")}`;
      known.tokenScopes = p.scopes || [];
    }
    c.hello = true;
    c.scopes = p.scopes || [];
    c.caps = p.caps || [];
    c.deviceId = d.id;
    c.send({ type: "res", id: f.id, ok: true, payload: { type: "hello-ok", protocol: 4, server: { version: "2026.9.6-fake", connId: crypto.randomUUID() }, features: { methods: [], events: [] }, snapshot: {}, policy: { tickIntervalMs: tickMs }, auth: { role: "operator", scopes: p.scopes, deviceToken: known.deviceToken } } });
  }

  function broadcast(event: string, payload: unknown) {
    if (frozen) return;
    for (const c of conns) if (c.hello) c.send({ type: "event", event, payload });
  }
  const ticker = setInterval(() => broadcast("tick", { ts: Date.now() }), tickMs);

  // A plugin, loaded from its folder as OpenClaw loads one: its manifest, and its entry's register(api), called once
  // for each way OpenClaw 2026.9.4 loads it, each into a registry of its own: "full" (its services start and its
  // gateway methods answer), "discovery" (whose hooks an agent's turn runs) and "tool-discovery" (whose tools an
  // agent's turn lists and runs).
  async function install(dir: string) {
    const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(dir, "openclaw.plugin.json"), "utf8"));
    const entry: string = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).openclaw.extensions[0];
    const mod: { register(api: PluginApi): void } = (await import(pathToFileURL(path.join(dir, entry)).href)).default;
    const quiet: Logger = { info() {}, warn() {}, error() {}, debug() {} };
    const load = (registrationMode: string) => {
      const r: Registry = { services: [], methods: new Map(), tools: [], hooks: new Map() };
      mod.register({
        id: manifest.id,
        registrationMode,
        logger: quiet,
        registerService: (svc) => r.services.push(svc),
        registerGatewayMethod: (name, handler) => r.methods.set(name, handler),
        registerTool: (factory, opts) => {
          const off = (opts?.names || [opts?.name]).filter((n) => !manifest.contracts?.tools?.includes(n));
          if (off.length) throw new Error(`tools not in the plugin's manifest: ${off.join(", ")}`);
          r.tools.push(factory);
        },
        on: (name, fn) => r.hooks.set(name, fn),
      });
      return r;
    };
    const full = load("full");
    const p: Plugin = { id: manifest.id, manifest, services: full.services, methods: full.methods, hooks: load("discovery").hooks, tools: load("tool-discovery").tools };
    const gatewayEvents = { emit: (event: string, payload: unknown) => broadcast(`plugin.${manifest.id}.${event}`, payload) };
    for (const svc of p.services) await svc.start({ gatewayEvents, logger: quiet, stateDir: dir });
    plugin = p;
  }
  // What a session's agent has, as OpenClaw builds a run's tools from each factory with the session's context.
  const toolsOf = (sessionKey: string, ctx: ToolContext = {}) => (plugin?.tools || []).flatMap((f) => ([] as Tool[]).concat(f({ sessionKey, agentId: sessionKey.split(":")[1], ...ctx }) || []));
  const portOf = () => (server.address() as AddressInfo).port;

  // The gateway, for the test (its url once it listens).
  const gateway = {
    url: "",
    requests: () => [...requests.keys()],
    approve(requestId: string) {
      const id = requests.get(requestId);
      if (id) devices.set(id, { approved: true, scopes: devices.get(id)?.asked || null });
      requests.delete(requestId);
      return !!id;
    },
    // A live scope upgrade, approved (`openclaw devices approve <id>`): a new token with those scopes, handed back
    // to whoever waits on it; its connections stay. Or turned down.
    upgrades: () => [...upgrades.keys()].filter((r) => !upgrades.get(r).result),
    approveUpgrade(requestId: string) {
      const u = upgrades.get(requestId);
      const dev = u && devices.get(u.deviceId);
      if (!dev) return false;
      dev.scopes = [...new Set([...(dev.scopes || []), ...u.scopes])];
      dev.deviceToken = `dt-${crypto.randomBytes(12).toString("hex")}`;
      dev.tokenScopes = u.scopes;
      u.result = { status: "approved", requestId, deviceToken: dev.deviceToken, scopes: u.scopes };
      for (const w of u.waiters.splice(0)) w(u.result);
      return true;
    },
    rejectUpgrade(requestId: string) {
      const u = upgrades.get(requestId);
      if (!u) return false;
      u.result = { status: "rejected", requestId };
      for (const w of u.waiters.splice(0)) w(u.result);
      return true;
    },
    // The device's token, without admin from now on (and its connections dropped, as a rotation drops them).
    takeAdmin(deviceId: string) {
      const dev = devices.get(deviceId);
      if (!dev) return false;
      dev.tokenScopes = (dev.tokenScopes || []).filter((x) => x !== ADMIN);
      for (const c of conns) if (c.deviceId === deviceId) c.socket.destroy();
      return true;
    },
    device: (deviceId: string) => devices.get(deviceId) || null,
    sends,
    // Its connections now, with what each asked for.
    open: () => [...conns].filter((c) => c.hello).map((c) => ({ deviceId: c.deviceId, scopes: c.scopes, caps: c.caps })),
    // Approvals answered, each with whether it came over a connection with admin.
    resolves,
    // An approval asked for (`kind`: "exec" or "plugin", its id in the state's approvals or toolApprovals), told as
    // OpenClaw tells one: to the connections that say they answer that kind (caps) and see it, a runtime's only with
    // admin. How many it told.
    announce(kind: "exec" | "plugin", id: string) {
      const a = (state()[kind === "exec" ? "approvals" : "toolApprovals"] || []).find((x) => x.id === id);
      if (!a) return 0;
      let told = 0;
      for (const c of conns) {
        if (!c.hello || !(c.caps || []).includes(`${kind}-approvals`) || (a.runtime && !(c.scopes || []).includes(ADMIN))) continue;
        c.send({ type: "event", event: `${kind}.approval.requested`, payload: { id: a.id, request: a.request, createdAtMs: a.createdAtMs, expiresAtMs: a.expiresAtMs } });
        told++;
      }
      return told;
    },
    // Too many failed sign-ins from this address: every one is turned away for a while.
    limit(on: boolean) {
      limited = on;
    },
    // `openclaw devices remove`: the device has to pair again.
    forget(deviceId: string) {
      devices.delete(deviceId);
      for (const [r, id] of requests) if (id === deviceId) requests.delete(r);
      for (const c of conns) c.socket.destroy();
    },
    // `openclaw qr --setup-code-only`: the gateway's address and a bootstrap token, for 10 minutes.
    setupCode({ expiresAt = Date.now() + 600e3 } = {}) {
      const bootstrapToken = crypto.randomBytes(24).toString("base64url");
      bootstraps.set(bootstrapToken, { expiresAt });
      const code = Buffer.from(JSON.stringify({ url: `ws://127.0.0.1:${portOf()}`, bootstrapToken, expiresAtMs: expiresAt })).toString("base64url");
      return { code, bootstrapToken };
    },
    revoke(bootstrapToken: string) {
      const b = bootstraps.get(bootstrapToken);
      if (b) b.revoked = true;
    },
    // Gone (the gateway stopped, the network's down): its connections drop, and nobody can connect.
    down() {
      for (const c of conns) c.socket.destroy();
      for (const res of slow) res.destroy();
      return new Promise((r) => server.close(r));
    },
    // Back, at the same address.
    up() {
      return new Promise<void>((r) => server.listen(Number(new URL(this.url).port), "127.0.0.1", r));
    },
    // Connected, but silent: no ticks, no answers.
    freeze(on: boolean) {
      frozen = on;
    },
    // Its answers to `method` wait until it's let go of, then come all at once.
    hold(method: string, on: boolean) {
      const waiting = held.get(method) || [];
      if (on) return held.set(method, waiting);
      held.delete(method);
      for (const [c, f] of waiting) onRequest(c, f);
    },
    // How many requests for `method` it's holding.
    holding: (method: string) => held.get(method)?.length || 0,
    // What was added to a session's history from its `from`th entry on, as session.message events: each with
    // its id and its place in the history (seq, from 1), as chat.history has them.
    tell(key: string, from: number) {
      const x = state().sessions.find((y) => y.key === key);
      x.messages.slice(from).forEach((m, n) => {
        const i = from + n;
        const id = m.__openclaw?.id || `${x.sessionId || key}#${i}`;
        broadcast("session.message", { sessionKey: key, agentId: x.agentId, message: { ...m, __openclaw: { ...m.__openclaw, id, seq: i + 1 } }, messageId: id, messageSeq: i + 1 });
      });
    },
    connects,
    fetches,
    ranges,
    mediaAsks,
    metaAsks,
    turnAway(on: boolean) {
      turnAway = on;
    },
    broadcast,
    install,
    uninstall: async () => {
      for (const svc of plugin?.services || []) await svc.stop?.({});
      plugin = null;
    },
    pluginCalls,
    // The tools a session's agent has (`ctx`: more of its context, its workspaceDir), and calling one as it would.
    tools: (sessionKey: string, ctx?: ToolContext) => toolsOf(sessionKey, ctx),
    run: async (sessionKey: string, name: string, args: object = {}, ctx?: ToolContext) => {
      const t = toolsOf(sessionKey, ctx).find((x) => x.name === name);
      if (!t) throw new Error(`no tool ${name} for ${sessionKey}`);
      return t.execute(`call-${crypto.randomUUID().slice(0, 8)}`, args, undefined, undefined);
    },
    prompt: async (sessionKey: string): Promise<{ appendSystemContext?: string } | null> => (await plugin?.hooks.get("before_prompt_build")?.({ prompt: "", messages: [] }, { sessionKey, agentId: sessionKey.split(":")[1] })) || null,
    close: () => {
      clearInterval(ticker);
      for (const c of conns) c.socket.destroy();
      for (const res of slow) res.destroy();
      server.close();
    },
  };
  return new Promise<typeof gateway>((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      gateway.url = `ws://127.0.0.1:${portOf()}`;
      resolve(gateway);
    }),
  );
}
export type Gateway = Awaited<ReturnType<typeof startGateway>>;
