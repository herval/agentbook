// People and how they sign in: the page's person (the one who signs in, with Google through the relay: api/signin.ts)
// and the people this page knows of; browser sign-ins (a cookie whose token is stored only as a hash); and devices:
// the machines a person connected, each with its own token, approved on the page with a short code.
//
// Someone the page's person takes off their page goes for good, with what was only theirs (passkeys, pins, follows,
// picture). Their row and username stay, so what they made still says whose it was, and nobody new takes the name.
//
// These live in their own tables, written directly, not through the op log: tokens never go into the log, and
// sign-ins come and go too often to replay.

import { sha256 } from "../plugin/shared/hash.ts";
import crypto from "node:crypto";
import { machineName } from "../plugin/shared/ids.ts";
import type { IncomingHttpHeaders } from "node:http";
import { AccountTables } from "./storage/accounts.ts";
import type { DeviceById, DeviceOf, RequestRow, UserRow } from "./storage/accounts.ts";
import type { Storage } from "../plugin/shared/storage.ts";
import type { Avatar, Iso } from "../plugin/shared/types.ts";

// A browser sign-in lasts this long at most, and ends sooner once it's gone unused for SESSION_IDLE_DAYS.
export const SESSION_DAYS = 30;
export const SESSION_IDLE_DAYS = 7;
// A machine's token stops working once the machine hasn't used it for this long: it logs in again.
export const MACHINE_IDLE_DAYS = 90;
const REQUEST_MINUTES = 10;
export const USERNAME = /^[a-z0-9][a-z0-9_-]{1,29}$/;

const now = () => new Date().toISOString();
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;

// A person's account, as it's given out (never its password). `disabled`, `deleted`: since when.
export interface User {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar: Avatar | null;
  role: string;
  created: Iso;
  disabled?: Iso;
  deleted?: Iso;
}
// What a change to someone's account answers: what it made, or why it couldn't (`status`: the HTTP status to say).
export interface Made {
  user?: User;
  error?: string;
  status?: number;
}
// A machine connected: its id, the name it's connected as, and the machines of its person's it replaces.
export interface Approved {
  id: string;
  name: string;
  replaced: string[];
}
// A machine asking to connect: the code its person approves, the secret it polls with, and how long it lasts (s);
// or `limited`: too many asked from its address lately.
export interface DeviceAsk {
  code?: string;
  poll?: string;
  expires_in?: number;
  limited?: boolean;
}
// What a machine's poll gets: its token once approved (with the username it's connected for, its name, and what
// the approval signed), or that it waits.
export interface DevicePoll {
  pending?: boolean;
  token?: string;
  user?: string;
  name?: string;
  pin?: unknown;
}
// Who someone is elsewhere, as the sign-in relay said it: `sub` is `<provider>:<its id there>`.
export interface Elsewhere {
  sub: string;
  email?: string;
  name?: string;
}
// A person to make: a username and a name to show.
interface Asked {
  username?: string;
  display_name?: string;
}

// Where a request came from, for the sign-in limits: the socket's address, or behind a proxy the server was told to
// trust (AGENTBOOK_TRUST_PROXY), the client's address as the proxy says it (Fly-Client-IP, else the first of
// X-Forwarded-For). Without that, every sign-in behind a proxy would count as one address, and ten bad tries would
// hold everyone up.
export function clientAddress(req: { socket?: { remoteAddress?: string } | null; headers?: IncomingHttpHeaders }, trust = false): string {
  const socket = req.socket?.remoteAddress || "";
  if (!trust) return socket;
  const fly = String(req.headers?.["fly-client-ip"] || "").trim();
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return fly || forwarded || socket;
}

// A code someone can read off one screen and type into another: XXXX-XXXX, no look-alike letters.
function shortCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from(crypto.randomBytes(4), (b) => letters[b % letters.length]).join("");
  return `${pick()}-${pick()}`;
}

const avatarOf = (json: string | null): Avatar | null => {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
};
const publicUser = (u: UserRow | null): User | null => (u ? { id: u.id, username: u.username, display_name: u.display_name || u.username, bio: u.bio || "", avatar: avatarOf(u.avatar), role: u.role, created: u.created, ...(u.disabled ? { disabled: u.disabled } : {}), ...(u.deleted ? { deleted: u.deleted } : {}) } : null);

// `storage`: the page's (plugin/shared/storage.ts), whose AccountTables (server/storage/accounts.ts) keep the rows.
export type Accounts = ReturnType<typeof createAccounts>;
export function createAccounts(storage: Storage) {
  const rows = storage.use(AccountTables);

  /* ---------- people ---------- */

  const count = () => rows.userCount();
  const byUsername = (username: string): User | null => publicUser(rows.userByUsername(String(username || "").toLowerCase()));
  const byId = (uid: string): User | null => publicUser(rows.userById(uid));
  // Everyone here, but not the deleted.
  const list = () => rows.users().map(publicUser);

  function validate(username: string): { error?: string; name?: string } {
    const name = String(username || "").trim().toLowerCase();
    if (!USERNAME.test(name)) return { error: "A username is 2 to 30 letters, digits, dashes or underscores, starting with a letter or digit." };
    if (rows.usernameTaken(name)) return { error: "That username is taken." };
    return { name };
  }

  // A new person's row, checked: { user } or { error }. Nobody has a password. `uid`: their id, when it's given.
  function newUser({ username, display_name, role = "member", uid = null }: Asked & { role?: string; uid?: string | null }): { user?: UserRow; error?: string } {
    const v = validate(username);
    if (v.error) return v;
    return { user: { id: uid || id("u"), username: v.name, display_name: String(display_name || "").trim().slice(0, 60) || v.name, bio: "", password: "", role, created: now(), avatar: null, disabled: null, deleted: null } };
  }
  function create(args: Asked & { role?: string; uid?: string | null }): Made {
    const r = newUser(args);
    if (r.error) return { error: r.error };
    rows.insertUser(r.user);
    return { user: publicUser(r.user) };
  }

  // Machine login codes, in a 15-minute window. Looking up or approving a code nobody's waiting with is a miss, counted
  // per person and per address: 10 and that one waits, since a guessed code would log a stranger's machine in as
  // the guesser's, and its threads would come up as theirs. And so many machines may ask from one address in the
  // window (an office is one address), so nobody fills the waiting list alone.
  const CODE_MISSES = 10;
  const STARTS_PER_ADDRESS = 20;
  const failures = new Map<string, number[]>();
  const WINDOW = 15 * 60e3;
  const recent = (key: string): number[] => (failures.get(key) || []).filter((t) => Date.now() - t < WINDOW);
  const codeKeys = (uid: string, address: string) => [`c:u:${uid}`, `c:a:${address}`];
  const codeLimited = (uid: string, address: string) => codeKeys(uid, address).some((k) => recent(k).length >= CODE_MISSES);
  const codeMiss = (uid: string, address: string) => fail(...codeKeys(uid, address));
  const fail = (...keys: string[]) => {
    keys.forEach((k) => failures.set(k, [...recent(k), Date.now()]));
    // Don't let the map grow with every distinct address an unauthenticated client tries from: once it's large, drop
    // the keys whose tries have all aged out of the window.
    if (failures.size > 2000) for (const [k, ts] of failures) if (!ts.some((t) => Date.now() - t < WINDOW)) failures.delete(k);
  };

  function updateProfile(uid: string, { display_name, bio }: { display_name?: string | null; bio?: string | null }): User | null {
    if (display_name != null) rows.setDisplayName(uid, String(display_name).trim().slice(0, 60) || null);
    if (bio != null) rows.setBio(uid, String(bio).trim().slice(0, 500));
    return byId(uid);
  }
  // Their picture ({ image, type }), an emoji ({ emoji }), or their letter (null).
  function setAvatar(uid: string, avatar: Avatar | null): User | null {
    rows.setAvatar(uid, avatar ? JSON.stringify(avatar) : null);
    return byId(uid);
  }
  const avatars = () => rows.avatars().map(avatarOf);

  /* ---------- browser sign-ins ---------- */

  function startSession(uid: string, userAgent = ""): { token: string; expires: Iso } {
    const token = random();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
    rows.insertSession({ token_hash: sha256(token), user_id: uid, created: now(), expires, last_seen: now(), user_agent: String(userAgent).slice(0, 200) });
    return { token, expires };
  }

  // A sign-in is over once it's past its end, or hasn't been used for SESSION_IDLE_DAYS.
  const idleBefore = () => new Date(Date.now() - SESSION_IDLE_DAYS * 86400e3).toISOString();
  const sessionOver = (s: { expires: Iso; last_seen: Iso | null; created: Iso }) => s.expires < now() || (s.last_seen || s.created) < idleBefore();
  // The ones over at start go now; the rest as they're used.
  rows.deleteSessionsOver(now(), idleBefore());

  const touched = new Map<string, number>(); // token hash -> when last_seen was last written
  function sessionUser(token: string | null | undefined): User | null {
    if (!token) return null;
    const h = sha256(token);
    const row = rows.sessionByTokenHash(h);
    if (!row) return null;
    if (sessionOver({ expires: row.expires, last_seen: row.last_seen, created: row.session_created })) {
      rows.deleteSession(h);
      return null;
    }
    if (Date.now() - (touched.get(h) || 0) > 60e3) {
      rows.touchSession(h, now());
      touched.set(h, Date.now());
    }
    return publicUser(row);
  }
  const endSession = (token: string | null | undefined) => token && rows.deleteSession(sha256(token));
  const endAllSessions = (uid: string, except?: string | null) => rows.deleteSessionsOf(uid, except ? sha256(except) : "");

  /* ---------- someone who leaves ---------- */

  // Someone off: they can't sign in, their sign-ins end, their machines' tokens stop working, and machines they
  // approved that haven't picked up their token go. What they made stays, theirs. The ids of the machines taken off,
  // for the relay to forget.
  function disable(uid: string): { user: User | null; devices: string[] } | null {
    if (!rows.userById(uid)) return null;
    const devices = rows.disableUser(uid, now());
    return { user: byId(uid), devices };
  }
  // For good: off, and without what was only theirs (passkeys, pins, follows, picture, line). The row and its
  // username stay: their threads and pages still say whose they were.
  function remove(uid: string): { user: User | null; devices: string[] } | null {
    const off = disable(uid);
    if (!off) return null;
    rows.deleteUser(uid, now(), "");
    return { user: byId(uid), devices: off.devices };
  }
  // The page's person (role "admin"), when they're here: a list, from when a page had several.
  const admins = () => rows.admins().map(publicUser);

  /* ---------- signing in through the relay (plugin/shared/relay-verify.ts): no password ---------- */

  // A username for someone who came from elsewhere: their email's name, or their name, made to fit, and free
  // (ada, ada-2…).
  function usernameFor(identity: Elsewhere): string {
    const from = String(identity.email || "").split("@")[0] || String(identity.name || "");
    let base = from.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 24);
    if (base.length < 2) base = "person";
    let name = base;
    for (let i = 2; rows.usernameTaken(name); i++) name = `${base}-${i}`;
    return name;
  }
  const identityRow = (identity: Elsewhere) => ({ sub: identity.sub, email: identity.email || null, added: now() });
  function userFrom(identity: Elsewhere, role: string, uid: string | null = null): UserRow {
    const username = usernameFor(identity);
    return { id: uid || id("u"), username, display_name: String(identity.name || "").trim().slice(0, 60) || username, bio: "", password: "", role, created: now(), avatar: null, disabled: null, deleted: null };
  }
  const elsewhereTaken = { error: "That account already signs in to someone here. Sign in instead.", status: 409 };
  // The page's person, made at their first sign-in with `identity` (role "admin"). `uid`: their id, the account the
  // machine logged in with (plugin/shared/machine-login.ts).
  function createWith(identity: Elsewhere, role = "member", uid: string | null = null): Made {
    if (rows.userByIdentity(identity.sub)) return elsewhereTaken;
    const user = userFrom(identity, role, uid);
    if (!rows.insertUserWith(user, identityRow(identity))) return elsewhereTaken;
    return { user: publicUser(user) };
  }
  /* ---------- devices: machines a person connected ---------- */

  // Asking needs no account, so only so many machines wait at once.
  const MAX_WAITING = 100;
  // An approved request names its device (`device`), whose token is made when the machine picks it up: it's never
  // kept anywhere but as its hash. Requests from before that kept the token itself, in plain (`token`), until
  // then: ones too old to pick up go now.
  const requestsSince = () => new Date(Date.now() - REQUEST_MINUTES * 60e3).toISOString();
  rows.deleteRequestsBefore(requestsSince());
  // Machines that haven't used their token for MACHINE_IDLE_DAYS: off, as when their person disconnects them.
  const idleSince = () => new Date(Date.now() - MACHINE_IDLE_DAYS * 86400e3).toISOString();
  const expireIdle = (uid: string | null = null) => rows.revokeIdleDevices(idleSince(), uid);
  expireIdle();

  // A machine asks to connect: it gets a code to show its person and a secret to poll with. Null when too many
  // are waiting; { limited: true } when too many asked from this address lately. Where it asked from is shown to
  // whoever approves it, so a code someone else sent them to approve looks wrong before they do.
  function requestDevice(name: string, address = ""): DeviceAsk | null {
    rows.deleteRequestsBefore(requestsSince());
    const key = `s:a:${address}`;
    if (recent(key).length >= STARTS_PER_ADDRESS) return { limited: true };
    if (rows.requestCount() >= MAX_WAITING) return null;
    fail(key);
    const code = shortCode();
    const poll = random();
    rows.insertRequest({ code, poll_hash: sha256(poll), name: String(name).slice(0, 60), created: now(), address: String(address || "").slice(0, 60) || null });
    return { code, poll, expires_in: REQUEST_MINUTES * 60 };
  }
  const deviceRequest = (code: string | null | undefined): Pick<RequestRow, "code" | "name" | "created" | "approved_by" | "address"> | null => rows.requestByCode(String(code || "").trim().toUpperCase(), requestsSince());

  // One connected machine per name (AccountTables.oneMachinePerName): two from before that, the one seen last keeps
  // the name, and the other is renamed after its person.
  const deviceNamed = (name: string) => rows.deviceNamed(String(name));
  rows.oneMachinePerName((d) => machineName(`${d.name}-${d.username}`));

  // The name a machine asking for `name` gets when `uid` approves it, and the machine of theirs it replaces.
  // Its own name, unless someone else's machine (or `reserved`, the hub's own name) has it: then their
  // username goes after it ("laptop-alice", "laptop-alice-2"). One of their own machines with the name is that
  // machine connecting again, so the new one takes its place, and the old token stops working.
  function nameFor(name: string, uid: string, reserved: string[] = []): { name: string; replaces: ReturnType<typeof deviceNamed>[] } {
    const base = machineName(`${name}-${byId(uid)?.username || "machine"}`);
    for (let i = 0; ; i++) {
      const n = i === 0 ? name : i === 1 ? base : `${base}-${i}`;
      const holder = deviceNamed(n);
      if (!reserved.includes(n) && (!holder || holder.user_id === uid)) return { name: n, replaces: holder ? [holder] : [] };
    }
  }

  // The person approves the code on the page: the machine becomes theirs, under the name nameFor gives it. Its
  // token is made when it picks it up (pollDevice): until then, no token works for it.
  function approveDevice(code: string, uid: string, reserved: string[] = [], pin: unknown = null): Approved | null {
    const r = deviceRequest(code);
    if (!r || r.approved_by) return null;
    const did = id("d");
    const { name, replaced } = rows.approveRequest(r.code, { id: did, user_id: uid, token_hash: sha256(random()), created: now(), pin: pin ? JSON.stringify(pin) : null }, () => {
      const got = nameFor(r.name, uid, reserved);
      return { name: got.name, replaces: got.replaces.map((d) => d.id) };
    });
    return { id: did, name, replaced };
  }

  // A login this server makes for a machine it's about to start, approved for its owner as their Approve does:
  // no code for anyone to type. -> { device, poll, expires_in }: `poll`
  // is what the machine picks its token up with, once, within the ten minutes a request lasts. Null: too many
  // waiting. Its owner's own count, not an address's: a person making machines doesn't lock others out.
  function enrollDevice(name: string, uid: string, pin: unknown = null, reserved: string[] = []): { device: Approved; poll: string; expires_in: number } | null {
    const r = requestDevice(name, `enroll:${uid}`);
    if (!r || r.limited) return null;
    const device = approveDevice(r.code, uid, reserved, pin);
    return device ? { device, poll: r.poll, expires_in: r.expires_in } : null;
  }

  // The machine polls: its token once approved (made now, and handed over once), with the name it's connected as;
  // "pending" before; null if gone.
  function pollDevice(poll: string | null | undefined): DevicePoll | null {
    const r = rows.requestByPoll(sha256(poll || ""));
    if (!r) return null;
    if (!r.approved_by) return { pending: true };
    const pin = rows.pinFor(r.code);
    let token = r.token;
    if (token) rows.pickedUp(r.code);
    else {
      token = random();
      rows.pickedUp(r.code, r.device, sha256(token));
    }
    return { token, user: byId(r.approved_by)?.username, name: r.name, ...(pin ? { pin: JSON.parse(pin) } : {}) };
  }

  // The machine a token is, while it's connected: { id, name, user_id, username }, or null. `{ name }`: the one by that
  // name, for another machine of yours linked over iroh, whose connection proved which it is (server/api/cli.ts).
  function deviceFor(token: string | { name: string } | null | undefined): { id: string; name: string; user_id: string; username: string } | null {
    if (!token) return null;
    const d = typeof token === "string" ? rows.deviceByTokenHash(sha256(token)) : rows.deviceByName(token.name);
    if (!d) return null;
    if ((d.last_seen || d.created) < idleSince()) {
      rows.revokeDevice(d.id);
      return null;
    }
    rows.touchDevice(d.id, now());
    return { id: d.id, name: d.name, user_id: d.user_id, username: d.username };
  }
  function devices(uid: string): DeviceOf[] {
    expireIdle(uid);
    return rows.devicesOf(uid);
  }
  // Every machine a person ever connected, revoked ones too (for deleting their data), and forgetting them all.
  const deviceIdsOf = (uid: string) => rows.deviceIdsOf(uid);
  const forgetDevices = (uid: string) => rows.forgetDevices(uid);
  // A machine by its device's id, revoked or not (its posts stay its person's).
  const deviceById = (did: string): DeviceById | null => rows.deviceById(String(did || ""));
  // `uid`: only one of theirs (null: anyone's, for an admin).
  const revokeDevice = (did: string, uid?: string | null) => rows.revokeDevice(did, uid || null);
  // A machine logged in again without the server (agentbook-server machine): the machines it replaces, for the
  // server to hand their things to it when it first sees it.
  const replaces = (did: string, old: string) => rows.addReplaced(did, old);
  const replacedBy = (did: string) => rows.takeReplaced(did);

  /* ---------- passkeys: what each person signs commands with ---------- */

  const passkeys = (uid: string, includingRemoving = false) => rows.passkeysOf(uid, includingRemoving);
  const addPasskey = (uid: string, { id: kid, alg, spki, name }: { id: string; alg: number; spki: string; name?: string | null }) => rows.addPasskey({ id: kid, user_id: uid, alg, spki, name: name ? String(name).slice(0, 80) : null, created: now() });
  const removePasskey = (uid: string, kid: string) => rows.removePasskey(uid, kid);

  /* ---------- pins: each person keeps their own ---------- */

  const pins = (uid: string) => new Map(rows.pinsOf(uid).map((r) => [r.post, r.at]));
  function pin(uid: string, post: string, on: boolean): void {
    if (on) rows.pin(uid, String(post), now());
    else rows.unpin(uid, String(post));
  }
  // Everyone's at once: an archived thread is pinned by nobody, so archiving it takes it off every pin.
  const unpinAll = (post: string) => rows.unpinAll(String(post));

  /* ---------- follows: the pages each person has followed or stopped following ---------- */

  const follows = (uid: string) => new Map(rows.followsOf(uid).map((r) => [r.page, !!r.following]));
  const follow = (uid: string, page: string, on: boolean) => rows.setFollow(uid, String(page), on, now());

  // Whose this machine's agents and sessions are: AGENTBOOK_OWNER, or the first admin.
  function machineOwner(): User | null {
    const named = process.env.AGENTBOOK_OWNER && byUsername(process.env.AGENTBOOK_OWNER);
    return named || publicUser(rows.firstAdmin());
  }

  return {
    pins,
    pin,
    unpinAll,
    follows,
    follow,
    machineOwner,
    count,
    byUsername,
    byId,
    list,
    create,
    updateProfile,
    setAvatar,
    avatars,
    startSession,
    sessionUser,
    endSession,
    endAllSessions,
    remove,
    admins,
    createWith,
    requestDevice,
    deviceRequest,
    codeLimited,
    codeMiss,
    deviceNamed,
    nameFor,
    approveDevice,
    enrollDevice,
    replaces,
    replacedBy,
    pollDevice,
    deviceFor,
    deviceById,
    deviceIdsOf,
    forgetDevices,
    devices,
    revokeDevice,
    passkeys,
    addPasskey,
    removePasskey,
    renamePasskey: (uid: string, kid: string, name: string) => rows.renamePasskey(uid, kid, name),
    markRemoving: (uid: string, kid: string) => rows.markRemoving(uid, kid),
    shortCode,
  };
}
