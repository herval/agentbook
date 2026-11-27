// People: who's signed in (only the page's person, its account's: ./signin.ts), profiles, and the machines they log
// in. Everyone else is someone this page knows of, who doesn't sign in here.

import { clientAddress } from "../accounts.ts";
import { prunePictures } from "../avatars.ts";
import { ACCOUNT, PUBLIC_URL, RELAY_PROVIDERS, SIGNIN_RELAY, TRUST_PROXY } from "../config.ts";
import { purgeUser } from "../purge.ts";
import { machineName } from "../../plugin/shared/ids.ts";
import type { IncomingMessage } from "node:http";
import type { User } from "../accounts.ts";
import type { Prefs } from "../../plugin/shared/types.ts";
import { accounts, blobs, commit, log, relay, state, store } from "../core/state.ts";
import { fail, ok, readBody, route } from "../core/http.ts";
import type { Req, Res, Viewer } from "../core/http.ts";
import type { PinBody } from "../core/types.ts";
import { allPosts, ownerOf } from "../core/refs.ts";
import { connectors, dashboards, images, live, pushLive, search } from "../core/services.ts";
import { viewForReq } from "./views.ts";
import { logRefused, said } from "./cli.ts";
import { PAGE_OK, pinFor } from "./passkeys.ts";
import { devicesOf } from "./machines.ts";
import { terminals } from "./terminals.ts";
import { allAgents, avatarFrom, sendPicture } from "./agents.ts";
import { archiveSoon, archiveStartsNow, prefsOf } from "./archive.ts";
import { wsLevel, wsShownTo } from "./workspaces.ts";
import { contactFor } from "./contacts.ts";
import { contactOf } from "../core/follows.ts";
import { irohWhyHere, notLinked } from "./mesh.ts";
import { door, remoteInfo } from "./door.ts";
import { meshChanged } from "../../plugin/shared/storage/peers.ts";

// --- people: who's signed in, profiles, and the machines they connect ---
const COOKIE = "agentbook_session";
export const cookieToken = (req: IncomingMessage) => /(?:^|;\s*)agentbook_session=([^;]+)/.exec(req.headers.cookie || "")?.[1] || null;
// Whether the page came over https: the server's own address says so (AGENTBOOK_SERVER_URL), or the socket, or the
// proxy in front. A cookie set then is Secure: a browser sends it over https only.
export const secure = (req: Req) => PUBLIC_URL.startsWith("https:") || ("encrypted" in req.socket && !!req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
// A new sign-in for `user` in this browser: its cookie.
export function sessionCookie(req: Req, user: User): string {
  const { token, expires } = accounts.startSession(user.id, req.headers["user-agent"]);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}${secure(req) ? "; Secure" : ""}`;
}
// Where a request came from, for the sign-in limits: through a proxy only when told to trust one (config.ts).
export const address = (req: IncomingMessage) => clientAddress(req, TRUST_PROXY);
// The page's person: the one who signs in here (users.role "admin" marks them; everyone else is "member").
export const isPagePerson = (req: Viewer) => req.user?.role === "admin";
const pagePersonOnly = (req: Viewer, res: Res) => (isPagePerson(req) ? true : void fail(res, 403, "Only this page's person can do that."));

// Who's signed in. `account`: the page is its machine's account's (agentbook login), which signs in with Google
// through the relay (`relay`: its providers, and its own page, where the account's machines are), and is the only one
// who does. A page whose machine isn't logged in has nobody to sign in.
route("GET", "/api/auth/me", (req, res) => {
  const user = accounts.sessionUser(cookieToken(req));
  ok(res, { user, ...(user ? { prefs: prefsOf(user.id) } : {}), account: !!ACCOUNT, relay: ACCOUNT && SIGNIN_RELAY ? { providers: RELAY_PROVIDERS, url: SIGNIN_RELAY } : null, ...(!user && ACCOUNT && !accounts.byId(ACCOUNT.person) ? { first: true } : {}) });
});

route("POST", "/api/auth/logout", (req, res) => {
  accounts.endSession(cookieToken(req));
  live.check(); // its pages' streams end with it
  terminals.check();
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  ok(res);
});

route("POST", "/api/me", async (req, res) => {
  const b = await readBody<{ display_name?: string; bio?: string }>(req);
  const user = accounts.updateProfile(req.user.id, { display_name: b.display_name, bio: b.bio });
  // What a hello to your door gets says it too.
  door.writeCard();
  ok(res, { user });
});
// Your avatar: a picture (the request's body, an image/* type), an emoji ({ emoji }), or your letter
// ({ avatar: null }).
route("POST", "/api/me/avatar", async (req, res) => {
  const avatar = await avatarFrom(req, res);
  if (avatar === undefined) return;
  const user = accounts.setAvatar(req.user.id, avatar);
  prunePictures(allAgents());
  ok(res, { user });
});
// Your settings for your threads (Settings, on your profile): Auto-archive and Private terminals, both off until
// you turn them on. Turning Auto-archive on leaves the threads whose work is in already as they are; Private
// terminals goes to your machines now, which keep the sessions agentbook didn't start off it from then on.
route("POST", "/api/me/prefs", async (req, res) => {
  if (!req.user) return fail(res, 403, "A person sets their settings, not a machine.");
  const b = await readBody<{ auto_archive?: unknown; private_terminals?: unknown }>(req);
  const was = prefsOf(req.user.id);
  const set: Prefs = {};
  for (const k of ["auto_archive", "private_terminals"]) if (typeof b[k] === "boolean") set[k] = b[k];
  if (!Object.keys(set).length) return fail(res, 400, "Say which setting: auto_archive or private_terminals, true or false.");
  if (set.auto_archive && !was.auto_archive) archiveStartsNow(req.user.id);
  // Private terminals: what's on agentbook already and wasn't started in it goes off every list, until it's off.
  if (set.private_terminals && !was.private_terminals) commit({ t: "private.off", user: req.user.id, posts: [...allPosts()].filter((p) => ownerOf(p.D)?.id === req.user.id && !p.s.launch).map((p) => p.id) });
  if (set.private_terminals === false && was.private_terminals) commit({ t: "private.off", user: req.user.id, clear: true });
  commit({ t: "prefs.set", user: req.user.id, ...set });
  if ("private_terminals" in set && set.private_terminals !== was.private_terminals) for (const D of relay.devices.values()) if (ownerOf(D)?.id === req.user.id) relay.nudge(D);
  if (set.auto_archive) archiveSoon(null, req.user.id);
  ok(res, { prefs: prefsOf(req.user.id) });
});
route("POST", "/api/me/signout-everywhere", (req, res) => {
  accounts.endAllSessions(req.user.id, cookieToken(req));
  live.check();
  terminals.check();
  ok(res);
});

// Everyone here, each saying whether they're the request's person's contact (who can be put on something of theirs).
route("GET", "/api/people", (req, res) => ok(res, { people: accounts.list().map((u) => (req.user && u.id !== req.user.id && contactOf(req.user.id, u.id) ? { ...u, contact: true } : u)) }));
route("GET", "/api/people/:username", (req, res, { params }) => {
  const user = accounts.byUsername(params.username);
  if (!user) return fail(res, 404, "No one by that name here.");
  const mine = user.id === req.user.id;
  const agents = viewForReq(req).agents.filter((a) => a.owner === user.username);
  // Their workspaces others may see: public ones, to their contacts.
  const workspaces = mine ? undefined : Object.values(state.workspaces).filter((w) => w.owner === user.id && wsShownTo(req, w)).map((w) => ({ id: w.id, name: w.name, repo: w.repo, visibility: wsLevel(w) }));
  // Whether you're contacts, or asking (./contacts.ts). Someone elsewhere: their @handle and whether their door
  // answers (./door.ts). Yours: your door.
  ok(res, { user, me: mine, agents, workspaces, devices: mine ? devicesOf(user.id) : undefined, not_linked: mine ? notLinked() : undefined, iroh_why: mine ? irohWhyHere() : undefined, contact: mine ? null : contactFor(req, user), remote: remoteInfo(user.id), door: mine && user.id === ACCOUNT?.person ? door.status() : undefined });
});

// Someone the page's person takes off their page, for good (server/purge.ts): their sign-ins end, and with them their
// pages' streams, here and now; their machines are logged out, and a poll one has open ends.
function offboard(req: Viewer, res: Res, username: string) {
  if (!pagePersonOnly(req, res)) return;
  const u = accounts.byUsername(username);
  if (!u) return fail(res, 404, "No one by that name here.");
  if (u.id === req.user.id) return fail(res, 400, "That's you: agentbook logout takes this machine off your account.");
  const r = deleteAccount(u);
  if (!r) return fail(res, 409, "They're gone already.");
  log(`@${req.user.username} took @${u.username} off this page`);
  for (const id of r.devices || []) {
    const D = relay.devices.get(id);
    if (D) relay.forget(D);
    terminals.forget(id);
  }
  live.check();
  terminals.check();
  pushLive();
  ok(res, { user: accounts.byId(u.id) });
}
// Their connectors (and the keys they keep), and everything they had here: their machines with their threads and
// files, their pages, groups, routines, notes, tasks, WIPs and the bytes they sent (server/purge.ts). Their username
// stays taken.
function deleteAccount(u: User) {
  const r = accounts.remove(u.id);
  if (!r) return null;
  for (const c of connectors.list(u.id).connectors) {
    try {
      connectors.remove(c.id, u.id);
      dashboards.dropSource(c.id);
    } catch (e) {
      log(`deleting @${u.username}: kept connector ${c.id}: ${e.message}`);
    }
  }
  const deviceIds = accounts.deviceIdsOf(u.id);
  images.forget(u.id);
  purgeUser({ uid: u.id, accounts, relay, store, blobs, terminals, log });
  for (const id of deviceIds) search.dropDevice(id);
  search.rebuildServerScope();
  dashboards.tidyAll(state.pages);
  prunePictures(allAgents());
  return r;
}
route("POST", "/api/people/:username/delete", (req, res, { params }) => offboard(req, res, params.username));

// A person's picture, for anyone signed in. Its address changes with the picture (?v=), so the browser keeps it.
route("GET", "/api/people/:username/avatar", (req, res, { params, query }) => {
  const pic = accounts.byUsername(params.username)?.avatar;
  sendPicture(res, pic, query.get("v"));
});

// A machine asks to log in (`agentbook-cli login`): it shows its person a code, and polls for its token while they
// approve the code here, signed in.
route("POST", "/api/devices/start", async (req, res) => {
  const b = await readBody<{ name?: string }>(req);
  const name = machineName(b.name);
  if (!name) return fail(res, 400, "Name the machine.");
  const r = accounts.requestDevice(name, address(req));
  if (r?.limited || !r) logRefused(`machine: login turned away, ${r?.limited ? "too many from this address" : "too many waiting in all"}`, req);
  if (r?.limited) return fail(res, 429, "Too many machines asked to connect from here. Try again in a few minutes.");
  if (!r) return fail(res, 429, "Too many machines are waiting to connect. Try again in a few minutes.");
  log(`machine: ${said(name)} asks to log in, from ${address(req)}`);
  ok(res, r);
});
route("GET", "/api/devices/poll", (req, res, { query }) => {
  const r = accounts.pollDevice(query.get("poll"));
  if (!r) return fail(res, 404, "That request expired. Run `agentbook-cli login` again.");
  ok(res, r);
});
// What a machine waiting with a code would be connected as, for you: the name it asked for, unless that's
// someone else's machine's here (see accounts.nameFor), and which machine of yours it would replace.
// A code nobody's waiting with is a miss, and so many of them from one person or one address and they wait
// (accounts.ts): nobody guesses a stranger's code and takes their machine as their own.
const CODE_WAIT = "Too many codes that weren't waiting. Wait a few minutes and try again.";
route("GET", "/api/devices/request/:code", (req, res, { params }) => {
  if (accounts.codeLimited(req.user.id, address(req))) return fail(res, 429, CODE_WAIT);
  const r = accounts.deviceRequest(params.code);
  if (!r || r.approved_by) {
    accounts.codeMiss(req.user.id, address(req));
    return fail(res, 404, "No machine is waiting with that code. Codes last 10 minutes.");
  }
  const named = accounts.nameFor(r.name, req.user.id);
  ok(res, { name: named.name, asked: r.name, replaces: named.replaces.map((d) => ({ name: d.name, created: d.created })), created: r.created, from: r.address || null });
});
route("POST", "/api/devices/approve", async (req, res) => {
  const b = await readBody<PinBody & { code?: string; sign?: boolean }>(req);
  // A machine takes only what you sign: it gets your passkeys with its token, and
  // keeps them as it logs in. The page makes you one first when you have none; it
  // must be a page passkeys sign on, as the machine refuses keys for any other (and wouldn't log in).
  const pin = pinFor(req, b);
  if (!pin && b.sign) return fail(res, 409, "Make a passkey first: the machine keeps your passkeys, and takes what can run something only when one of them signs it.");
  if (pin && !PAGE_OK.test(pin.origin)) return fail(res, 400, `Approve it on agentbook's page at https, or at localhost: the machine keeps the page your passkeys sign on, and they don't sign on ${pin.origin || "this one"}.`);
  if (accounts.codeLimited(req.user.id, address(req))) return fail(res, 429, CODE_WAIT);
  const device = accounts.approveDevice(b.code, req.user.id, [], pin);
  if (!device) {
    accounts.codeMiss(req.user.id, address(req));
    return fail(res, 404, "No machine is waiting with that code. Codes last 10 minutes.");
  }
  // The same machine logging in again keeps what it had: its posts, agents and ids.
  for (const old of device.replaced || []) relay.adopt(device.id, old, { name: device.name, user_id: req.user.id });
  log(`machine: ${said(device.name)} (${device.id}) approved by @${req.user.username}${pin ? ", keeping their passkeys" : ", unsigned"}${device.replaced?.length ? `, in place of ${device.replaced.length} of theirs` : ""}, from ${address(req)}`);
  ok(res, { device });
});
// A login for a machine this server is about to start for you: made and
// approved in one go, as your Approve would, with your passkeys for it to keep. -> { device, enroll }: `enroll` is
// what goes on the machine as ~/.agentbook-enroll, where its agentbook-cli picks its token up once (enroll.ts).
// Or { status, error }.
export function enrollMachine(req: Req, b: PinBody, name: string) {
  const pin = pinFor(req, b);
  if (pin && !PAGE_OK.test(pin.origin)) return { status: 400, error: `Make it from agentbook's page at https, or at localhost: the machine keeps the page your passkeys sign on, and they don't sign on ${pin.origin || "this one"}.` };
  const made = accounts.enrollDevice(name, req.user.id, pin);
  if (!made) return { status: 429, error: "Too many machines are waiting to connect. Try again in a few minutes." };
  for (const old of made.device.replaced || []) relay.adopt(made.device.id, old, { name: made.device.name, user_id: req.user.id });
  // Known here at once, off until it starts: its page is there, and what's sent to it waits.
  relay.device(made.device.id, { name: made.device.name, user_id: req.user.id });
  pushLive();
  log(`machine: ${said(made.device.name)} (${made.device.id}) made for @${req.user.username}${pin ? ", keeping their passkeys" : ", unsigned"}, from ${address(req)}`);
  return { device: made.device, enroll: { server: PUBLIC_URL, name: made.device.name, poll: made.poll }, expires_in: made.expires_in };
}
// The same, for a machine you start yourself: what to put in its ~/.agentbook-enroll before agentbook-cli first
// starts there. It works once, for ten minutes.
route("POST", "/api/devices/enroll", async (req, res) => {
  const b = await readBody<PinBody & { name?: string }>(req);
  const name = machineName(b.name);
  if (!name) return fail(res, 400, "Name the machine.");
  const r = enrollMachine(req, b, name);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, { device: r.device, enroll: r.enroll, expires_in: r.expires_in });
});

// Embedded, the machine it runs on logs in to it as the page's person's, without a code: whoever runs it owns this
// data anyway. Now, when they're here, else once they are (`fn`, called then: their first sign-in, ./signin.ts, or
// joining another machine of theirs, mesh.ts). -> { token, name, user }, or null when there's nobody to be yet.
let firstAccount = () => {};
export function firstAccountMade() {
  setImmediate(() => {
    firstAccount();
    // And it links to your machines that wouldn't link to a page with nobody on it (../mesh.ts).
    meshChanged.emit("person");
    // And your door takes your username for your @handle (../door.ts).
    door.recheck();
  });
}
export function logInMachine(name, fn = null) {
  const user = accounts.admins()[0];
  if (!user) {
    if (fn) firstAccount = () => fn(logInMachine(name));
    return null;
  }
  const r = accounts.requestDevice(name, "where it runs");
  if (!r || r.limited === true) return null;
  const device = accounts.approveDevice(r.code, user.id);
  if (!device) return null;
  const got = accounts.pollDevice(r.poll);
  // The same machine logging in again keeps what it had: its posts, agents and ids.
  for (const old of device.replaced || []) relay.adopt(device.id, old, { name: device.name, user_id: user.id });
  log(`machine: ${said(device.name)} (${device.id}) logged in where it runs, as @${user.username}'s${device.replaced?.length ? `, in place of ${device.replaced.length} of theirs` : ""}`);
  return { token: got.token, name: got.name, user: got.user };
}
