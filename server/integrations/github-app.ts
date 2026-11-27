// agentbook's GitHub App: how people connect GitHub without making a token. The hub's admin creates the app once,
// from a manifest (agentbook fills in GitHub's "Create GitHub App" page; GitHub asks them to confirm), and turns on
// its Device Flow there, which a manifest can't. Then anyone here signs in with GitHub: agentbook asks GitHub for
// a code, they enter it at github.com/login/device, and agentbook gets a user access token for them (8 hours,
// renewed with its refresh token for up to 6 months, with nothing but the app's client ID).
//
// A user access token reads only what both its person and the app can: the repos the app is installed on that they
// can see. agentbook keeps only the app's client ID, slug and owner, in github-app.json: never its private key or
// its secrets, so the app can't act on its own, only for whoever signed in with it.
//
// AGENTBOOK_GITHUB_APP_CLIENT_ID (and AGENTBOOK_GITHUB_APP, its slug) name an app made by hand instead. A page with
// neither uses the one the sign-in relay names (agentbook's own, agentbook-connector), so nobody has to make one.
// AGENTBOOK_GITHUB_URL and AGENTBOOK_GITHUB_API_URL point elsewhere than github.com (the tests' stand-in).

import fs from "node:fs";
import path from "node:path";
import { SERVER_HOME, SIGNIN_RELAY } from "../config.ts";
import type { AppTokens } from "./connectors.ts";
import { relayNames } from "./relay-apps.ts";

export const WEB = () => (process.env.AGENTBOOK_GITHUB_URL || "https://github.com").replace(/\/$/, "");
const API = () => (process.env.AGENTBOOK_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const FILE = () => path.join(SERVER_HOME, "github-app.json");
const RELAY_FILE = () => path.join(SERVER_HOME, "relay-github-app.json");

// The app as it's kept (github-app.json), or as the environment names it (`env`).
export interface App {
  client_id: string;
  slug: string | null;
  name?: string | null;
  id?: number | null;
  owner: string | null;
  owner_type: string | null;
  created_by?: string | null;
  created?: string;
  env?: boolean;
  // The sign-in relay's, which isn't this page's to change on GitHub.
  relay?: string;
}

const readApp = (file: string): App | null => {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as App | null;
    return typeof c?.client_id === "string" && c.client_id ? c : null;
  } catch {
    return null;
  }
};
// The app, or null: the one named in the environment, else the one made here, else the relay's.
export function appConfig(): App | null {
  if (process.env.AGENTBOOK_GITHUB_APP_CLIENT_ID) return { client_id: process.env.AGENTBOOK_GITHUB_APP_CLIENT_ID, slug: process.env.AGENTBOOK_GITHUB_APP || null, owner: null, owner_type: null, env: true };
  return readApp(FILE()) || readApp(RELAY_FILE());
}

// The relay's app, as its /.well-known/agentbook-relay names it (relay-apps.ts), asked for as the server starts and
// when someone wants to sign in with GitHub and there's none. Kept in relay-github-app.json, so a page that starts
// offline still has it, and dropped once the relay names none. A relay that can't be reached changes nothing.
// -> the app now (appConfig()).
export async function learnRelayApp(relay = SIGNIN_RELAY): Promise<App | null> {
  const doc = await relayNames(relay);
  if (!doc) return appConfig();
  const named = (doc.github_app ?? null) as { client_id?: unknown; slug?: unknown } | null;
  const client_id = typeof named?.client_id === "string" && /^[\w.-]{1,100}$/.test(named.client_id) ? named.client_id : null;
  if (!client_id) fs.rmSync(RELAY_FILE(), { force: true });
  else {
    const slug = typeof named.slug === "string" && /^[a-z0-9-]{1,100}$/.test(named.slug) ? named.slug : null;
    const was = readApp(RELAY_FILE());
    if (was?.client_id !== client_id || was?.slug !== slug || was?.relay !== relay) {
      const keep: App = { client_id, slug, owner: null, owner_type: null, relay };
      fs.mkdirSync(SERVER_HOME, { recursive: true });
      fs.writeFileSync(RELAY_FILE(), JSON.stringify(keep, null, 2) + "\n", { mode: 0o600 });
    }
  }
  return appConfig();
}
// Keep an app: what identifies it, nothing secret.
export function saveApp(app: Partial<App> & { client_id: string }): App {
  const keep: App = { client_id: String(app.client_id), slug: app.slug ? String(app.slug) : null, name: app.name ? String(app.name) : null, id: app.id ?? null, owner: app.owner || null, owner_type: app.owner_type || null, created_by: app.created_by || null, created: new Date().toISOString() };
  fs.mkdirSync(SERVER_HOME, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(keep, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(FILE(), 0o600);
  return keep;
}

// Where things are on GitHub: installing the app on more repos, its settings (Device Flow), its page.
export const linksOf = (app: App | null | undefined) =>
  app?.slug
    ? {
        install: `${WEB()}/apps/${app.slug}/installations/new`,
        settings: app.relay ? null : app.owner_type === "Organization" && app.owner ? `${WEB()}/organizations/${app.owner}/settings/apps/${app.slug}` : `${WEB()}/settings/apps/${app.slug}`,
        page: `${WEB()}/apps/${app.slug}`,
      }
    : { install: null, settings: null, page: null };

// What it may do: read pull requests, their checks, statuses and diffs, and answer their review threads and
// comment on them; read and close issues. No webhooks. An app made before it could answer asks for pull requests
// read only: its owner changes that on GitHub (pulls.ts's CANT_WRITE says so).
export const PERMISSIONS = { pull_requests: "write", contents: "read", checks: "read", statuses: "read", issues: "write", metadata: "read" };

// The manifest for this hub's app, made by `admin` (a username) from the page at `origin`, under an organization of
// theirs (`org`) or their own account; and the address to post it to, with `state` to know it when it comes back.
export function manifestFor({ origin, admin, org = null, state }: { origin: string; admin: string; org?: string | null; state: string }) {
  const name = `agentbook-${admin}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 34);
  return {
    action: `${WEB()}/${org ? `organizations/${encodeURIComponent(org)}/` : ""}settings/apps/new?state=${encodeURIComponent(state)}`,
    manifest: {
      name,
      url: origin,
      description: "agentbook reads your pull requests, their checks and reviews, and answers their review comments, as you, and brings the issues assigned to you and the reviews waiting for you into your Tasks.",
      redirect_url: `${origin}/api/github/app/created`,
      setup_url: `${origin}/api/github/app/installed`,
      setup_on_update: true,
      public: true,
      default_permissions: PERMISSIONS,
    },
  };
}

// What GitHub's OAuth endpoints answer: the HTTP status, and what was asked for, or why not.
interface OAuthReply {
  status: number;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval?: number;
}
async function post(url: string, params: Record<string, string>): Promise<OAuthReply> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`Can't reach GitHub (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`);
  }
  return { status: res.status, ...((await res.json().catch(() => ({}))) as Omit<OAuthReply, "status">) };
}
const WHY: Record<string, string> = {
  access_denied: "You turned it down on GitHub.",
  expired_token: "The code ran out before it was entered. Sign in again.",
  device_flow_disabled: "agentbook's GitHub App has Device Flow off: turn on Enable Device Flow in its settings on GitHub.",
  incorrect_client_credentials: "GitHub doesn't know agentbook's GitHub App any more.",
  bad_refresh_token: "GitHub signed agentbook out. Sign in with GitHub again.",
  bad_verification_code: "That code isn't GitHub's any more. Sign in again.",
  incorrect_device_code: "That code isn't GitHub's any more. Sign in again.",
};
const failed = (r: OAuthReply) => Object.assign(new Error(WHY[r.error] || r.error_description || (r.error ? `GitHub said ${r.error}.` : `GitHub answered HTTP ${r.status}.`)), { code: r.error || null });
const tokensOf = (r: OAuthReply): AppTokens => ({
  access_token: String(r.access_token),
  refresh_token: r.refresh_token ? String(r.refresh_token) : null,
  expires_at: r.expires_in ? new Date(Date.now() + Number(r.expires_in) * 1000).toISOString() : null,
});

// A code for a person to sign in with: { device_code (kept here), user_code (theirs to enter), verification_uri,
// expires_in, interval }.
export async function deviceCode(app: App) {
  const r = await post(`${WEB()}/login/device/code`, { client_id: app.client_id });
  if (r.error || !r.device_code || !r.user_code) throw failed(r);
  return { device_code: String(r.device_code), user_code: String(r.user_code), verification_uri: String(r.verification_uri || `${WEB()}/login/device`), expires_in: Number(r.expires_in) || 900, interval: Math.max(1, Number(r.interval) || 5) };
}
// One look at whether they've entered it: { tokens } once they have, { pending, interval? } while not, or it throws
// saying why it won't happen (turned down, ran out, Device Flow off).
export interface Poll {
  tokens?: AppTokens;
  pending?: true;
  interval?: number | null;
}
export async function devicePoll(app: App, device_code: string): Promise<Poll> {
  const r = await post(`${WEB()}/login/oauth/access_token`, { client_id: app.client_id, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  if (r.access_token) return { tokens: tokensOf(r) };
  if (r.error === "authorization_pending") return { pending: true };
  if (r.error === "slow_down") return { pending: true, interval: Number(r.interval) || null };
  throw failed(r);
}
// New tokens for old ones (a sign-in from the Device Flow needs nothing but the app's client ID for that).
export async function refresh(app: App, refresh_token: string): Promise<AppTokens> {
  const r = await post(`${WEB()}/login/oauth/access_token`, { client_id: app.client_id, grant_type: "refresh_token", refresh_token });
  if (r.access_token) return tokensOf(r);
  throw failed(r);
}

// The app GitHub made from the manifest, as kept: GitHub hands over its private key and secrets too, which nothing
// here keeps.
export async function convert(code: string) {
  let res: Response;
  try {
    res = await fetch(`${API()}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`Can't reach GitHub (${e.cause?.code || e.message}).`);
  }
  const out = (await res.json().catch(() => ({}))) as { id?: number; slug?: string; name?: string; client_id?: string; owner?: { login?: string; type?: string } | null; message?: string };
  if (!res.ok || !out.client_id) throw new Error(out.message ? `GitHub said: ${out.message}` : `GitHub answered HTTP ${res.status}.`);
  return { id: out.id ?? null, slug: out.slug || null, name: out.name || null, client_id: out.client_id, owner: out.owner?.login || null, owner_type: out.owner?.type || null };
}

// Where the app is installed for someone signed in with it: [{ account, type, all, url }], all: every repo of it;
// url: its settings on GitHub, where you pick which repos it reads.
export async function installations(token: string) {
  let res: Response;
  try {
    res = await fetch(`${API()}/user/installations?per_page=100`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`Can't reach GitHub (${e.cause?.code || e.message}).`);
  }
  const out = (await res.json().catch(() => ({}))) as { installations?: { account?: { login?: string; type?: string } | null; repository_selection?: string; html_url?: string }[]; message?: string };
  if (res.status === 401) throw Object.assign(new Error("GitHub signed agentbook out. Sign in with GitHub again."), { status: 401 });
  if (!res.ok) throw new Error(out.message ? `GitHub said: ${out.message}` : `GitHub answered HTTP ${res.status}.`);
  return (out.installations || []).map((i) => ({ account: i.account?.login || null, type: i.account?.type || null, all: i.repository_selection === "all", url: i.html_url || null }));
}
