// agentbook's Linear app: how people connect Linear without making an API key. It's an OAuth application in Linear,
// "agentbook", made in the hervalicious workspace and public, so anyone's workspace can authorize it. Signing in sends
// someone to Linear's consent page, where they pick a workspace, and Linear sends them back with a code that agentbook
// trades for their tokens. With PKCE: agentbook needs only the app's client ID, so no client secret is shipped or kept,
// and the app can't act on its own. An access token lasts 24 hours, and its refresh token (good for 30 days) renews it.
//
// Linear sends people back only to the addresses registered on the app, and a page can be at any address (a tailnet
// name, another port). So a page with a sign-in relay goes through it: the relay names the app in its
// /.well-known/agentbook-relay (relay-apps.ts), the app's redirect URI is the relay's, and the relay sends the browser
// on to the page that asked, asking the first time whether that page is theirs (agentbook-relay's PROTOCOL.md, 9).
// The relay never has the verifier, so the code is no use to it, and the page trades it with Linear itself. A page
// with no relay goes straight to Linear, which sends it back only to http://localhost:4310 or http://127.0.0.1:4310.
// AGENTBOOK_LINEAR_CLIENT_ID names an app of the page's own instead, straight too: one made under Linear's Settings ›
// API › OAuth applications, with <address>/api/linear/callback as its redirect URI.
//
// AGENTBOOK_LINEAR_URL (its GraphQL API, which the token endpoint sits beside) and AGENTBOOK_LINEAR_WEB_URL (where
// people sign in) point elsewhere than Linear (the tests' stand-in).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SERVER_HOME, SIGNIN_RELAY } from "../config.ts";
import type { AppTokens } from "./connectors.ts";
import { relayNames } from "./relay-apps.ts";

const CLIENT_ID = "f32eddfc9ea7754427f8ba2df0ea07b1";
const RELAY_FILE = () => path.join(SERVER_HOME, "relay-linear-app.json");

// The app as the relay names it: its client ID, where a sign-in starts on the relay, and the relay's address Linear
// sends people back to, which trading the code names again.
interface RelayApp {
  client_id: string;
  start: string;
  redirect_uri: string;
  relay: string;
}
function relayApp(): RelayApp | null {
  if (process.env.AGENTBOOK_LINEAR_CLIENT_ID) return null;
  try {
    const a = JSON.parse(fs.readFileSync(RELAY_FILE(), "utf8")) as RelayApp | null;
    return typeof a?.client_id === "string" && typeof a.start === "string" && typeof a.redirect_uri === "string" ? a : null;
  } catch {
    return null;
  }
}
export const clientId = () => process.env.AGENTBOOK_LINEAR_CLIENT_ID || relayApp()?.client_id || CLIENT_ID;

// The relay's, kept in relay-linear-app.json so renewing doesn't need the relay, and dropped once it names none. Only
// addresses on the relay itself: what it names is where people's browsers go. -> whether sign-ins go through it.
export async function learnRelayLinear(relay = SIGNIN_RELAY): Promise<boolean> {
  const doc = relay && (await relayNames(relay));
  if (!doc) return !!relayApp();
  const n = (doc.linear_app ?? null) as { client_id?: unknown; start?: unknown; redirect_uri?: unknown } | null;
  const onRelay = (u: unknown) => {
    try {
      return typeof u === "string" && new URL(u).origin === new URL(relay).origin ? u : null;
    } catch {
      return null;
    }
  };
  const client_id = typeof n?.client_id === "string" && /^[\w-]{1,100}$/.test(n.client_id) ? n.client_id : null;
  const start = onRelay(n?.start);
  const redirect_uri = onRelay(n?.redirect_uri);
  if (!client_id || !start || !redirect_uri) fs.rmSync(RELAY_FILE(), { force: true });
  else {
    const keep: RelayApp = { client_id, start, redirect_uri, relay };
    const text = JSON.stringify(keep, null, 2) + "\n";
    if (fs.existsSync(RELAY_FILE()) ? fs.readFileSync(RELAY_FILE(), "utf8") !== text : true) {
      fs.mkdirSync(SERVER_HOME, { recursive: true });
      fs.writeFileSync(RELAY_FILE(), text, { mode: 0o600 });
    }
  }
  return !!relayApp();
}
const WEB = () => (process.env.AGENTBOOK_LINEAR_WEB_URL || "https://linear.app").replace(/\/$/, "");
const TOKEN = () => new URL("/oauth/token", process.env.AGENTBOOK_LINEAR_URL || "https://api.linear.app/graphql").href;
// Reading issues, and closing and reopening them as the person who signed in.
const SCOPES = "read,write";
export const CALLBACK = "/api/linear/callback";

// Before a sign-in: the relay's app, asked for when none is kept (and the page has none of its own).
export async function signinReady() {
  if (!process.env.AGENTBOOK_LINEAR_CLIENT_ID && !relayApp()) await learnRelayLinear();
}

// A sign-in's start, for a page at `origin`: where to send the person, the state they come back with, the verifier
// only this server keeps (which proves the code is its own when it's traded), and what trading it names: the client
// ID and the address Linear sent them back to. `prompt=consent` shows Linear's page every time, so signing in again
// can pick another workspace (the relay asks for it too).
export function begin(origin: string) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const r = relayApp();
  if (r) return { state, verifier, client_id: r.client_id, redirect_uri: r.redirect_uri, url: `${r.start}?${new URLSearchParams({ origin, state, challenge, scope: SCOPES })}` };
  const client_id = clientId();
  const redirect_uri = `${origin}${CALLBACK}`;
  const q = new URLSearchParams({ client_id, redirect_uri, response_type: "code", scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", prompt: "consent" });
  return { state, verifier, client_id, redirect_uri, url: `${WEB()}/oauth/authorize?${q}` };
}

// What Linear's token endpoint answers: the tokens, or why not.
interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
async function post(params: Record<string, string>, client_id = clientId()): Promise<AppTokens> {
  let res: Response;
  try {
    res = await fetch(TOKEN(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id, ...params }), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Can't reach Linear (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`);
  }
  const r = (await res.json().catch(() => ({}))) as TokenReply;
  if (r.access_token) return { access_token: r.access_token, refresh_token: r.refresh_token || null, expires_at: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null };
  // A code or refresh token Linear won't take any more: used, run out, or the person took agentbook's access away.
  if (r.error === "invalid_grant") throw Object.assign(new Error("Linear signed agentbook out. Sign in with Linear again."), { code: r.error });
  if (r.error === "invalid_client") throw Object.assign(new Error("Linear doesn't know agentbook's app any more."), { code: r.error });
  throw Object.assign(new Error(r.error_description || (r.error ? `Linear said ${r.error}.` : `Linear answered HTTP ${res.status}.`)), { code: r.error || null });
}

// The code Linear sent the person back with, for their tokens.
export const exchange = (code: string, s: { verifier: string; redirect_uri: string; client_id: string }) => post({ grant_type: "authorization_code", code, redirect_uri: s.redirect_uri, code_verifier: s.verifier }, s.client_id);
// New tokens for old, before the access token runs out.
export const refresh = (refresh_token: string) => post({ grant_type: "refresh_token", refresh_token });
