// A client for OpenClaw's gateway (protocol 4), for agentbook to connect to one directly: a gateway on another
// machine, at an address you give, signed in with its token (or password), or with a setup code (which holds
// the address, and a bootstrap token good for one device, for 10 minutes).
//
// agentbook is a device of its own there. It makes an Ed25519 key once, and signs each connection's challenge
// with it; the gateway asks for the device to be approved once (`openclaw devices approve <request>` on the
// gateway, or in the OpenClaw app), then hands it a device token, which it uses from then on when no shared
// token is set. A setup code's bootstrap token only gets it that far: OpenClaw lets its own phone apps in
// without approving them, but not other clients. It connects as an operator ("gateway-client", backend mode) that can read, write, and answer
// approvals and questions, and says it answers approvals (CAPS).
//
// Frames are JSON over a WebSocket: {type:"req",id,method,params}, {type:"res",id,ok,payload|error},
// {type:"event",event,payload}: its calls and their answers are JSON-RPC's (kit/rpc.ts) in other frames. agentbook's
// own WebSocket (kit/ws.ts), not Node's: the gateway compresses what it sends, and Node 22's WebSocket drops the
// connection when a message unpacks to more than 4 MB (a history can be 6).

import crypto from "node:crypto";
import { createRpc } from "../kit/rpc.ts";
import { WebSocketClient } from "../kit/ws.ts";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // an Ed25519 public key's DER, before its 32 bytes
export const SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
// With admin too: once the gateway approved it (an upgrade, see openclaw.ts's askAdmin), agentbook keeps a second
// connection with these, for what its owner does, and nothing else. OpenClaw takes whatever a connection with admin
// sends as from its own owner (chat.send's senderIsOwner), with the owner-only tools that come with that (its config,
// cron jobs, a terminal), so the everyday connection, which everyone else's messages go over, stays without it. One
// device token does for both: asking for less than a token has gets the same token back (ensureDeviceToken).
export const ADMIN = "operator.admin";
export const ADMIN_SCOPES = [...SCOPES, ADMIN];
// That it answers approvals, commands' and its tools' (OpenClaw's Read, Skill… on a Claude CLI backend): OpenClaw counts
// a connection as somewhere to send an approval only with one of these (or as its own apps), and with nowhere to send
// one it refuses the command at once ("Headless runs cannot wait for interactive exec approval"). Not the plain
// "approvals", which takes every kind, those agentbook has no prompt for too.
export const CAPS = ["exec-approvals", "plugin-approvals"];
export const hasAdmin = (identity: Identity | null | undefined) => !!identity?.deviceToken && Array.isArray(identity.scopes) && identity.scopes.includes(ADMIN);
const CLIENT = { id: "gateway-client", mode: "backend", displayName: "agentbook", version: "2.0" };
const PLATFORM = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform] || process.platform;

// A device identity: its key, and its id (the SHA-256 of the raw public key, as OpenClaw derives it). Once the gateway
// approved it, the device token it handed agentbook, and the scopes that token has.
export interface Identity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  deviceToken?: string;
  scopes?: string[];
}
export function makeIdentity(): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(SPKI_PREFIX.length);
  return { deviceId: crypto.createHash("sha256").update(raw).digest("hex"), publicKey: raw.toString("base64url"), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

// A setup code, as `openclaw qr --setup-code-only` prints it (or its oc-pair:// link): base64url JSON with the
// gateway's address, a bootstrap token, and when the token expires. Throws when it isn't one.
export function decodeSetupCode(input) {
  const code = String(input || "").trim().replace(/^oc-pair:\/\//i, "");
  let p = null;
  try {
    if (/^[A-Za-z0-9_-]+$/.test(code)) p = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {}
  let url = null;
  try {
    url = new URL(p?.url);
  } catch {}
  if (!url || !["ws:", "wss:"].includes(url.protocol) || typeof p.bootstrapToken !== "string" || !p.bootstrapToken.trim()) throw new Error("That isn't an OpenClaw setup code.");
  if (Number.isFinite(p.expiresAtMs) && p.expiresAtMs <= Date.now()) throw new Error("That setup code has expired. Make a new one.");
  return { url: url.toString().replace(/\/$/, ""), bootstrapToken: p.bootstrapToken.trim(), expiresAt: Number.isFinite(p.expiresAtMs) ? p.expiresAtMs : null };
}

// The line a device signs to connect (OpenClaw's "v3" payload).
export const authPayload = ({ deviceId, scopes, signedAt, token, nonce }: { deviceId: string; scopes: string[]; signedAt: number; token?: string; nonce: string }) => ["v3", deviceId, CLIENT.id, CLIENT.mode, "operator", scopes.join(","), String(signedAt), token || "", nonce, PLATFORM, ""].join("|");

// Connect, and stay connected: `rpc(method, params)` waits for the connection. `identity` is saved through
// `save` when the gateway hands it a device token. `onState` hears { state: "connecting" | "pairing" |
// "connected" | "failed", error, requestId }; `onEvent` the gateway's events. `scopes`: what it asks for (SCOPES,
// or ADMIN_SCOPES for the owner's connection); `subscribe`: whether it hears sessions change (the everyday one
// does). `owners`: the owner's connection, which never forgets the device token (the everyday one uses it too) and
// gives up, rather than trying again, when the gateway won't take it with admin: it says so (`failed`, with the
// gateway's code), and the runtime goes on without admin.
// How a connection is doing: connecting, waiting for its device to be approved on the gateway (`requestId`),
// connected (`server`: the gateway's version; `scopes`: what it got), or failed, and why (`error`, and the gateway's
// `code` for it).
export interface GatewayState {
  state: "connecting" | "pairing" | "connected" | "failed";
  error?: string | null;
  code?: string;
  requestId?: string | null;
  deviceId?: string;
  server?: string | null;
  scopes?: string[];
}
interface GatewayOpts {
  url: string;
  token?: string;
  password?: string;
  bootstrapToken?: string;
  identity: Identity;
  scopes?: string[];
  subscribe?: boolean;
  owners?: boolean;
  save?: (identity: Identity) => void;
  onState?: (st: GatewayState) => void;
  onEvent?: (event: string, payload: unknown) => void;
  log?: (line: string) => void;
}
// What the gateway answers `connect` with: how often it ticks, the device token it handed this device (and its
// scopes), and its version.
interface HelloOk {
  policy?: { tickIntervalMs?: number };
  auth?: { deviceToken?: string; scopes?: string[] };
  server?: { version?: string };
}

export function connectGateway({ url, token, password, bootstrapToken, identity, scopes = SCOPES, subscribe = true, owners = false, save = () => {}, onState = () => {}, onEvent = () => {}, log = () => {} }: GatewayOpts) {
  let ws = null;
  let closed = false;
  let connected = false;
  let retry = 1000;
  let away = 60000; // turned away (rate limited): wait a minute, then longer each time, up to 15
  let timer = null;
  let watch = null; // looks every second for a connection that's gone quiet
  let heard = 0; // when the gateway last sent anything
  let tick = 30000; // how often the gateway says it's still there (its hello says; 30s is OpenClaw's own)
  let waiters: { resolve: () => void }[] = []; // rpc calls waiting for the connection
  let state: GatewayState = { state: "connecting" };
  const setState = (s: GatewayState) => {
    state = s;
    onState(s);
  };

  // Its calls, each waiting for its answer (or given up on after `timeout`), as a "req" frame with an id of agentbook's.
  // The gateway refuses one with a code and details (a file that's too big: its size), which the error carries as
  // its `code` and `data`.
  const calls = createRpc({
    name: "OpenClaw",
    send: (json) => ws?.send(json),
    frame: (m) => ({ type: "req", id: `ab${m.id}`, method: m.method, params: m.params ?? {} }),
  });
  const request = (method: string, params: unknown, timeout = 30000) => calls.call(method, params ?? {}, timeout);

  function open() {
    if (closed) return;
    timer = null;
    connected = false;
    let sock;
    try {
      sock = ws = new WebSocketClient(url);
    } catch (e) {
      return fail(e.message, 30000);
    }
    heard = Date.now();
    sock.onmessage = (m) => {
      if (sock !== ws) return;
      heard = Date.now();
      onFrame(String(m.data));
    };
    sock.onclose = () => lost(sock);
    // When it can't connect at all (refused, no network, a name that doesn't resolve), it fires `error` (Node's
    // WebSocket, which this was, never fired `close` then): that connection is lost too, or agentbook would never
    // try again.
    sock.onerror = () => lost(sock);
    // A connection that hears nothing is gone even when its socket doesn't say so (a laptop that slept, a gateway
    // that never answers): signed in, the gateway ticks every `tick` ms; before, it challenges at once.
    clearInterval(watch);
    watch = setInterval(() => Date.now() - heard > (connected ? 2 * tick : 20000) && lost(sock), 1000);
    watch.unref?.();
  }
  // The connection is gone, or never came: what waits on it fails, and agentbook tries again.
  function lost(sock) {
    if (sock !== ws) return; // given up on already
    ws = null;
    clearInterval(watch);
    try {
      sock.close();
    } catch {}
    const was = connected;
    connected = false;
    calls.fail(new Error("The connection to OpenClaw closed"));
    if (closed) return;
    if (was || state.state === "connecting") setState({ state: "connecting", error: was ? "The connection to its gateway dropped" : `Its gateway at ${where()} doesn't answer` });
    if (!timer) schedule(); // unless the handshake already said when to try again
  }
  const where = () => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  function schedule(ms = retry) {
    clearTimeout(timer);
    timer = setTimeout(open, ms);
    timer.unref?.();
    retry = Math.min(30000, retry * 2);
  }
  function fail(error, ms) {
    setState({ state: "failed", error });
    schedule(ms);
  }

  async function onFrame(text) {
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (f.type === "event" && f.event === "connect.challenge") return hello(f.payload || {});
    if (f.type === "res" && /^ab\d+$/.test(String(f.id))) {
      const id = Number(String(f.id).slice(2));
      return calls.take(f.ok ? { id, result: f.payload } : { id, error: { code: f.error?.code, message: f.error?.message || "", data: f.error?.details || {} } });
    }
    if (f.type === "event") onEvent(f.event, f.payload);
  }

  // Answer the gateway's challenge: sign it, and sign in.
  async function hello({ nonce, ts }) {
    const authToken = token || (password ? undefined : identity.deviceToken);
    // A setup code's bootstrap token, until the gateway hands agentbook a device token of its own.
    const bootstrap = authToken || password ? undefined : bootstrapToken;
    if (!authToken && !password && !bootstrap) {
      if (owners) {
        closed = true;
        clearInterval(watch);
        setState({ state: "failed", error: "No device token to sign in with", code: "NO_TOKEN" });
        return ws?.close();
      }
      fail("The gateway no longer knows agentbook. Connect again, with a new setup code or its token.", 60000);
      return ws?.close();
    }
    const signedAt = Number.isInteger(ts) ? ts : Date.now();
    const signature = crypto.sign(null, Buffer.from(authPayload({ deviceId: identity.deviceId, scopes, signedAt, token: authToken || bootstrap, nonce }), "utf8"), crypto.createPrivateKey(identity.privateKey)).toString("base64url");
    try {
      const ok = (await request("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client: { ...CLIENT, platform: PLATFORM },
        role: "operator",
        scopes,
        caps: CAPS,
        auth: { ...(authToken ? { token: authToken } : {}), ...(bootstrap ? { bootstrapToken: bootstrap } : {}), ...(password ? { password } : {}) },
        userAgent: "agentbook/2.0",
        device: { id: identity.deviceId, publicKey: identity.publicKey, signature, signedAt, nonce },
      })) as HelloOk;
      connected = true;
      retry = 1000;
      away = 60000;
      tick = Number(ok?.policy?.tickIntervalMs) || 30000;
      if (ok?.auth?.deviceToken && ok.auth.deviceToken !== identity.deviceToken) {
        identity.deviceToken = ok.auth.deviceToken;
        identity.scopes = ok.auth.scopes || scopes;
        save(identity);
      }
      setState({ state: "connected", server: ok?.server?.version || null, scopes: ok?.auth?.scopes || [] });
      for (const w of waiters) w.resolve();
      waiters = [];
      if (subscribe) request("sessions.subscribe", {}).catch(() => {}); // sessions.changed events, so posts update at once
    } catch (e) {
      const code = e.data?.code || e.code || "";
      // The owner's connection, turned down (its token doesn't have admin after all, or the gateway wants admin
      // approved again): never a retry, which would ask brick again and again and count as failed sign-ins.
      if (owners && !/RATE_LIMIT/i.test(code) && !/too many|retry later/i.test(e.message)) {
        log(`openclaw gateway (admin): ${e.message}`);
        closed = true;
        clearInterval(watch);
        setState({ state: "failed", error: e.message, code: /PAIRING_REQUIRED/i.test(code) || /pairing required|not paired/i.test(e.message) ? "PAIRING_REQUIRED" : code });
        return ws?.close();
      }
      if (/PAIRING_REQUIRED/i.test(code) || /pairing required|not paired/i.test(e.message)) {
        // Waiting for someone to approve this device on the gateway. The request lasts 5 minutes; asking again
        // keeps it fresh.
        setState({ state: "pairing", requestId: e.data?.requestId || null, deviceId: identity.deviceId, error: null });
        ws?.close();
        return schedule(5000);
      }
      // Turned away for a while (AUTH_RATE_LIMITED: too many failed sign-ins from this address, agentbook's or
      // anything else's): the device token is fine, so keep it, and try again later, less often each time.
      const limited = /RATE_LIMIT/i.test(code) || /too many|retry later/i.test(e.message);
      if (!limited && identity.deviceToken && !token && !password && /TOKEN|AUTH/i.test(code)) {
        // The device token stopped working (revoked, rotated): forget it, and pair again.
        delete identity.deviceToken;
        save(identity);
      }
      log(`openclaw gateway: ${e.message}`);
      const spent = bootstrap && /BOOTSTRAP/i.test(code);
      setState({ state: "failed", error: spent ? "The setup code has expired, or was already used. Make a new one." : limited ? "The gateway is turning this machine away for a while, after too many failed sign-ins from it. agentbook tries again in a while." : e.message, code });
      ws?.close();
      schedule(limited ? away : 30000);
      if (limited) away = Math.min(15 * 60e3, away * 2);
    }
  }

  async function rpc(method: string, params = {}, timeout = 30000) {
    if (!connected) {
      if (state.state === "pairing") throw new Error(`Approve agentbook on the OpenClaw gateway first${state.requestId ? `: openclaw devices approve ${state.requestId}` : ""}`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(state.error || "Not connected to OpenClaw")), 15000);
        waiters.push({ resolve: () => (clearTimeout(t), resolve()) });
      });
    }
    return request(method, params, timeout);
  }

  open();
  return {
    rpc,
    state: () => state,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(watch);
      ws?.close();
    },
  };
}
