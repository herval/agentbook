// How a caller on this machine and agentbook-cli show each other they hold the key in agentbook-cli's folder
// (cli/local.key, this user's alone), without the key going over loopback. Whatever listens on agentbook-cli's port
// while it's down (another person's process, a routine's code) learns nothing it can use from a call, and can't pass
// itself off as agentbook-cli.
// - A call carries x-agentbook-auth: 1.<ms>.<nonce>.<mac>, an HMAC-SHA256 of the key over its time, a nonce, its method,
//   its path and query, and its body's sha256: good for that call alone, within a minute, once (agentbook-cli keeps
//   the nonces it took).
// - agentbook-cli's answer carries x-agentbook-proof, an HMAC of the key over that nonce, which only what holds the
//   key can make. A WebSocket can't carry it in a header, so there it's the first message: { t: "proof", proof }.
// plugin/dsh/index.js has its own copy, as dsh loads that folder alone.

import crypto from "node:crypto";

export const AUTH_HEADER = "x-agentbook-auth";
export const PROOF_HEADER = "x-agentbook-proof";
export const AUTH_WINDOW_MS = 60e3;

const mac = (key: string, text: string): string => crypto.createHmac("sha256", key).update(text).digest("base64url");
// A body as it goes on the wire: text, or bytes.
type Body = string | Buffer | null | undefined;
const bodyHash = (body: Body): string => crypto.createHash("sha256").update(body == null ? "" : body).digest("hex");
const requestText = (at: number, nonce: string, method: string, target: string, body: Body): string => ["agentbook request", at, nonce, String(method).toUpperCase(), target, bodyHash(body)].join("\n");
const same = (a: string | null | undefined, b: string): boolean => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// `target`: the path and query as they go on the wire (a URL's pathname + search). -> { auth, nonce }
export function signRequest(key: string, method: string, target: string, body: Body = "", now = Date.now()): { auth: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString("base64url");
  return { auth: `1.${now}.${nonce}.${mac(key, requestText(now, nonce, method, target, body))}`, nonce };
}

// -> { nonce, at } when `auth` is the key's, for this call, and recent; else null. Whether its nonce was taken
// already is for the caller to keep.
export function checkRequest(key: string, auth: string | null | undefined, method: string, target: string, body: Body = "", now = Date.now()): { nonce: string; at: number } | null {
  const m = /^1\.(\d{1,15})\.([\w-]{16,64})\.([\w-]{43})$/.exec(String(auth || ""));
  if (!m || !key) return null;
  const at = Number(m[1]);
  if (Math.abs(now - at) > AUTH_WINDOW_MS) return null;
  return same(m[3], mac(key, requestText(at, m[2], method, target, body))) ? { nonce: m[2], at } : null;
}

export const proofOf = (key: string, nonce: string): string => mac(key, `agentbook answer\n${nonce}`);
export const proofOk = (key: string, nonce: string | null | undefined, got: string | null | undefined): boolean => !!key && !!nonce && same(got, proofOf(key, nonce));
