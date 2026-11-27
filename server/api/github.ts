import crypto from "node:crypto";
import { githubRepo } from "../integrations/pulls.ts";
import { appConfig, convert, deviceCode, devicePoll, installations, learnRelayApp, linksOf, manifestFor, saveApp } from "../integrations/github-app.ts";
import { state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Req, Viewer } from "../core/http.ts";
import { connectors, pushLive } from "../core/services.ts";
import { ghFor, pullsCache, pullsKey } from "./prs.ts";
import { isPagePerson, secure } from "./people.ts";
import { connectorInput, connectorsMine } from "./connectors.ts";

// agentbook's GitHub App, made once by an admin from a manifest: people sign in with it (GitHub's Device Flow)
// rather than pasting a token, and their sign-in is their GitHub connector's key, renewed by itself.
const appStates = new Map(); // state -> { uid, at }: an app an admin is making on GitHub, until GitHub sends them back
const appNotes = new Map(); // uid -> what happened when GitHub sent them back, said once on Connectors
let deviceFlow = null; // whether the app's Device Flow is on, as the latest sign-in found: true, false, or null (not known)
const signins = new Map(); // id -> { uid, by, settings, device_code, until, interval, status, error, connector }
// The address the page is at, for GitHub to send people back to (the request's own, checked by sameSite).
export const originOf = (req: Req) => (/^https?:\/\/[^/\s]+$/.test(req.headers.origin || "") ? req.headers.origin : `${secure(req) ? "https" : "http"}://${req.headers.host}`);
const appView = (app) => (app ? { slug: app.slug, owner: app.owner, env: !!app.env, links: linksOf(app), device_flow: deviceFlow } : null);

route("GET", "/api/github/app", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const app = appConfig() || (await learnRelayApp());
  const note = appNotes.get(req.user.id) || null;
  appNotes.delete(req.user.id);
  ok(res, { app: appView(app), admin: isPagePerson(req), note });
});
// The page's person makes the app: the manifest the page posts to GitHub, which asks them to confirm it there.
route("POST", "/api/github/app/manifest", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  if (!isPagePerson(req)) return fail(res, 403, "Only this page's person sets up its GitHub App.");
  const b = await readBody<{ org?: string }>(req);
  const org = b.org ? str(b.org, 100).trim() : null;
  if (org && !/^[\w.-]+$/.test(org)) return fail(res, 400, "That isn't an organization's name on GitHub.");
  for (const [k, v] of appStates) if (Date.now() - v.at > 3600e3) appStates.delete(k);
  const state = crypto.randomBytes(16).toString("hex");
  appStates.set(state, { uid: req.user.id, at: Date.now() });
  const m = manifestFor({ origin: originOf(req), admin: req.user.username, org, state });
  ok(res, { action: m.action, manifest: JSON.stringify(m.manifest) });
});
// GitHub sends the admin back with a code for the app it made, and the state agentbook gave it: agentbook keeps what
// identifies the app, never its private key or secrets.
route("GET", "/api/github/app/created", async (req, res, { query }) => {
  const back = () => {
    res.writeHead(302, { location: "/#/connectors" });
    res.end();
  };
  const state = String(query.get("state") || "");
  const st = appStates.get(state);
  if (!st || st.uid !== req.user.id || Date.now() - st.at > 3600e3 || !isPagePerson(req)) {
    appNotes.set(req.user.id, "GitHub sent you back without the request agentbook made for the app, so agentbook kept nothing. Create it again from here.");
    return back();
  }
  appStates.delete(state);
  try {
    saveApp({ ...(await convert(str(query.get("code"), 200))), created_by: req.user.username });
    deviceFlow = null;
    appNotes.set(req.user.id, "created");
  } catch (e) {
    appNotes.set(req.user.id, `GitHub didn't finish making the app: ${e.message}`);
  }
  back();
});
// Installing the app on GitHub (its setup URL) comes back to Connectors.
route("GET", "/api/github/app/installed", (req, res) => {
  res.writeHead(302, { location: "/#/connectors" });
  res.end();
});
// Or an app they made by hand: its client ID, and its slug for the links to it.
route("POST", "/api/github/app", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  if (!isPagePerson(req)) return fail(res, 403, "Only this page's person sets up its GitHub App.");
  if (process.env.AGENTBOOK_GITHUB_APP_CLIENT_ID) return fail(res, 409, "AGENTBOOK_GITHUB_APP_CLIENT_ID names the app here: change it there.");
  const b = await readBody<{ client_id?: string; slug?: string }>(req);
  const client_id = str(b.client_id, 100).trim();
  const slug = str(b.slug, 100).trim().toLowerCase() || null;
  if (!/^[\w.-]+$/.test(client_id)) return fail(res, 400, "Paste the app's client ID (not its app ID).");
  if (slug && !/^[a-z0-9-]+$/.test(slug)) return fail(res, 400, "Its slug is the end of its page's address: github.com/apps/<slug>.");
  saveApp({ client_id, slug, created_by: req.user.username });
  deviceFlow = null;
  ok(res, { app: appView(appConfig()) });
});

// Signing in with GitHub: a code for the person to enter on GitHub, and agentbook waiting for GitHub's yes. Its
// settings are their GitHub connector's (what comes into Tasks, and where), for one they don't have yet.
route("POST", "/api/github/signin", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const app = appConfig() || (await learnRelayApp());
  if (!app) return fail(res, 409, "agentbook has no GitHub App yet: an admin sets it up on Connectors. Meanwhile, use a token.");
  // A sign-in this server couldn't keep isn't started.
  const cant = connectors.cantKeep();
  if (cant) return fail(res, 503, cant);
  const b = await readBody<Record<string, unknown>>(req);
  const settings = connectorInput(b);
  delete settings.api_key;
  delete settings.kind;
  if (b.id) settings.id = str(b.id, 100);
  let code;
  try {
    code = await deviceCode(app);
  } catch (e) {
    if (e.code === "device_flow_disabled") deviceFlow = false;
    return fail(res, 502, e.message);
  }
  // One at a time each: a new one replaces theirs.
  for (const [k, v] of signins) if (v.uid === req.user.id || Date.now() > v.until + 600e3) signins.delete(k);
  const id = crypto.randomBytes(12).toString("hex");
  signins.set(id, { uid: req.user.id, by: req.user.username, settings, device_code: code.device_code, until: Date.now() + code.expires_in * 1000, interval: code.interval, status: "pending", error: null, connector: null });
  setTimeout(() => waitSignin(id, app), code.interval * 1000);
  ok(res, { id, user_code: code.user_code, verification_uri: code.verification_uri, expires_in: code.expires_in });
});
// Ask GitHub whether they've entered it, every `interval` seconds (more when it says so), until they have, turn it
// down, or it runs out.
async function waitSignin(id: string, app) {
  const s = signins.get(id);
  if (!s || s.status !== "pending") return;
  if (Date.now() > s.until) return Object.assign(s, { status: "expired", error: "The code ran out before it was entered. Sign in again.", device_code: null });
  try {
    const r = await devicePoll(app, s.device_code);
    if (r.tokens) {
      deviceFlow = true;
      s.connector = await connectors.signedIn(s.uid, s.by, s.settings, r.tokens);
      Object.assign(s, { status: "done", device_code: null });
      pushLive();
      return;
    }
    if (r.interval) s.interval = r.interval;
  } catch (e) {
    if (e.code === "device_flow_disabled") deviceFlow = false;
    return Object.assign(s, { status: e.code === "access_denied" ? "denied" : e.code === "expired_token" ? "expired" : "failed", error: e.message, device_code: null });
  }
  setTimeout(() => waitSignin(id, app), s.interval * 1000);
}
route("GET", "/api/github/signin/:id", (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const s = signins.get(params.id);
  if (!s || s.uid !== req.user.id) return fail(res, 404, "No such sign-in.");
  ok(res, { status: s.status, error: s.error, connector: s.connector });
});
// Where agentbook's GitHub App is installed, for someone signed in with it: what it reads as them.
route("GET", "/api/github/installations", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const token = connectors.keyFor(req.user.id, "github", "app");
  if (!token) return fail(res, 404, "You haven't signed in with GitHub here.");
  // Your workspaces' repos it can't read, as their last read found (seeWhy): one each, with where to fix it.
  const gh = ghFor(req.user.id);
  const missing = new Map();
  for (const w of Object.values(state.workspaces)) {
    const fix = w.owner === req.user.id && gh && githubRepo(w.repo) ? pullsCache.get(pullsKey(w.repo, gh))?.data?.fix : null;
    if (fix && !missing.has(w.repo)) missing.set(w.repo, { repo: githubRepo(w.repo).slug, workspace: w.name, ...fix });
  }
  try {
    ok(res, { installations: await installations(token), install: linksOf(appConfig()).install, missing: [...missing.values()] });
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
