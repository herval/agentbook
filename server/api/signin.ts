// Signing in to the page: with Google, through agentbook-relay (the relay the machine logged in through, or
// AGENTBOOK_RELAY_URL). Only on a page that's an account's (agentbook login, config.ts ACCOUNT), and only that account
// (the token's `acct`): its person, made at their first sign-in. Anyone else is someone else, and doesn't sign in here.
// The page sends the browser to the relay with a state and a nonce of its own; the relay signs the person in and sends
// the browser back to /api/auth/relay/done with a token saying who that is, for this page's origin and that nonce
// (plugin/shared/relay-verify.ts checks it). What a sign-in in progress needs stays here, in memory, for 10 minutes;
// the browser holds only its state, in a cookie only these two routes get. Either way it goes back to the page, with
// ?signin=<what happened> when it didn't work (web/views/auth/SignIn.tsx says it).

import crypto from "node:crypto";
import { ACCOUNT, SIGNIN_RELAY } from "../config.ts";
import { createVerifier, RelayTokenError } from "../../plugin/shared/relay-verify.ts";
import { accounts, log } from "../core/state.ts";
import { fail, route } from "../core/http.ts";
import type { Res } from "../core/http.ts";
import { firstAccountMade, sessionCookie } from "./people.ts";

interface Pending {
  origin: string;
  nonce: string;
  at: number;
}
const PENDING_MS = 10 * 60e3;
const PENDING_MAX = 1000;
const COOKIE = "agentbook_relay";
const pending = new Map<string, Pending>();
const verifier = ACCOUNT && SIGNIN_RELAY ? createVerifier({ relay: SIGNIN_RELAY }) : null;

const random = () => crypto.randomBytes(24).toString("base64url");
const same = (a: string | null, b: string | null) => !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const stateCookie = (state: string, seconds: number, https: boolean) => `${COOKIE}=${state}; Path=/api/auth/relay; HttpOnly; SameSite=Lax; Max-Age=${seconds}${https ? "; Secure" : ""}`;
// A page's origin, when `raw` is only that (as the browser's location.origin says it).
function originOf(raw: string | null): string | null {
  try {
    const u = new URL(String(raw));
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === raw ? u.origin : null;
  } catch {
    return null;
  }
}
function go(res: Res, to: string, cookies: string[]) {
  res.writeHead(302, { location: to, "set-cookie": cookies, "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end();
}
// The page's sign-in button: off to the relay. `origin`: the page's, as the browser has it.
route("GET", "/api/auth/relay/start", (req, res, { query }) => {
  if (!verifier) return fail(res, 404, "This machine isn't on an agentbook account yet, so nobody signs in to its page: run agentbook login on it.");
  const origin = originOf(query.get("origin"));
  if (!origin) return fail(res, 400, "Start signing in from the page.");
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.at > PENDING_MS || pending.size >= PENDING_MAX) pending.delete(k);
  const state = random();
  const nonce = random();
  pending.set(state, { origin, nonce, at: now });
  const to = new URL(`${SIGNIN_RELAY}/login`);
  to.search = new URLSearchParams({ provider: query.get("provider") || "google", origin, state, nonce }).toString();
  go(res, to.toString(), [stateCookie(state, PENDING_MS / 1000, origin.startsWith("https:"))]);
});

// The relay's answer.
route("GET", "/api/auth/relay/done", async (req, res, { query }) => {
  const state = query.get("state") || "";
  const mine = /(?:^|;\s*)agentbook_relay=([^;]+)/.exec(req.headers.cookie || "")?.[1] || null;
  const p = same(mine, state) ? pending.get(state) : null;
  if (p) pending.delete(state);
  const clear = [stateCookie("", 0, false)];
  const back = (what: string) => go(res, `/?signin=${what}`, clear);
  if (!p || !verifier || Date.now() - p.at > PENDING_MS) return back("expired");
  const error = query.get("error");
  if (error) return back(error === "access_denied" ? "cancelled" : "failed");
  let who: Awaited<ReturnType<typeof verifier.verify>>;
  try {
    who = await verifier.verify(query.get("token") || "", { audience: p.origin, nonce: p.nonce });
  } catch (e) {
    log(`sign-in: the relay's token refused (${e instanceof RelayTokenError ? e.reason : e.message})`);
    return back(e instanceof RelayTokenError && e.reason === "expired" ? "expired" : "failed");
  }
  if (who.acct !== ACCOUNT.account) {
    log(`sign-in: refused a ${who.provider} account that isn't this machine's account`);
    return back("other-account");
  }
  const had = accounts.byId(ACCOUNT.person);
  const r = had ? { user: had } : accounts.createWith({ sub: who.sub, email: who.email, name: who.name }, "admin", ACCOUNT.person);
  if (r.error) return back("failed");
  if (r.user.disabled || r.user.deleted) return back("off");
  log(`sign-in: @${r.user.username} with ${who.provider}${had ? "" : ", this machine's account's person, made now"}`);
  go(res, "/", [...clear, sessionCookie(req, r.user)]);
  if (!had) firstAccountMade();
});
