// Your door, from your page's side. On the home machine it
// starts agentbook-door (plugin/door/), has the relay certify the door's key for your account, and keeps door.db, the
// only bridge between the two: the page writes what to send and who's who, and reads what came in. Every row that
// came in is checked again here, and nothing in one runs, steers or answers anything: each kind's handler (on())
// turns it into what the page shows, for you to act on.
//
// Other people are rows in users, as people on one page were (so follows, levels and policy.ts work as they are),
// each with a row in remote_people (./storage/people.ts) saying who they are: their account, which the relay
// certifies their door's key for, and the handle they go by, their own word (nobody keeps handles unique, so a second
// @bob is bob-2 here). Only the page's person has a door; a row for someone else on the page has none. Nobody can be
// looked up: you find someone by the invite link they gave you (fromInvite), and give yours (inviteLink).
//
// The home: the machine whose page runs your door, as the relay has it (GET /doors's door.machine). A page whose
// machine isn't it starts none, and says where following is.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PageSide, type InboxRow, type Person } from "../plugin/shared/door/db.ts";
import { doorSpawner, type DoorProcess } from "../plugin/shared/door/process.ts";
import { SHAPES, type Kind } from "../plugin/shared/door/wire.ts";
import { irohHow } from "../plugin/shared/iroh.ts";
import { machineLogin, relayCall, type MachineLogin } from "../plugin/shared/machine-login.ts";
import { createVerifier } from "../plugin/shared/relay-verify.ts";
import type { Storage } from "../plugin/shared/storage.ts";
import type { createAccounts, User } from "./accounts.ts";
import { PeopleTables, type RemotePersonRow } from "./storage/people.ts";

type Accounts = ReturnType<typeof createAccounts>;
export interface DoorDeps {
  storage: Storage;
  accounts: Accounts;
  // The account's folder (AGENTBOOK_HOME): the door's is door/ in it.
  home: string;
  // The account the page is, from its machine's login; null: nobody's, so no door.
  account: { account: string; person: string; relay: string } | null;
  log: (...a: unknown[]) => void;
  // Off for the tests that don't want one.
  enabled?: boolean;
}
// How your door is, for the page: `state` up (certified and running here: `invite` is your link), starting,
// elsewhere (another machine of yours runs it: `machine`), or off (none: `why`). `handle`: the one you go by.
export interface DoorStatus {
  state: "up" | "starting" | "elsewhere" | "off";
  why?: string;
  handle?: string | null;
  machine?: string | null;
  key?: string | null;
  expires?: string | null;
  invite?: string | null;
}
// What an invite link says, after `<relay>/invite#v1.`: whose door it is (`a`, their account), its key (`k`), and the
// handle they go by (`h`), base64url JSON. The relay never sees it: browsers don't send what's after #.
type Invite = { acct: string; key: string; handle: string };
const INVITE = /^v1\.([A-Za-z0-9_-]{20,600})$/;
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,29}$/;
export function inviteLink(relay: string, i: Invite): string {
  return `${relay.replace(/\/+$/, "")}/invite#v1.${Buffer.from(JSON.stringify({ a: i.acct, k: i.key, h: i.handle })).toString("base64url")}`;
}
// An invite link as someone pasted it (the whole link, or what's after its #), for a page on `relay`: what it says,
// or why it isn't one.
export function readInvite(raw: string, relay: string): Invite | { error: string } {
  const text = String(raw || "").trim();
  const hash = text.indexOf("#");
  let at: URL | null = null;
  try {
    at = hash > 0 ? new URL(text) : null;
  } catch {}
  if (hash > 0 && (!at || at.pathname !== "/invite")) return { error: "That isn't an agentbook invite link." };
  if (at && at.origin !== new URL(relay).origin) return { error: `That link is for agentbook on another relay (${at.host}): yours is ${new URL(relay).host}, and doors on different relays can't reach each other.` };
  const m = INVITE.exec(hash >= 0 ? text.slice(hash + 1) : text);
  if (!m) return { error: "That isn't an agentbook invite link, or it's cut short: paste the whole link." };
  let v: { a?: unknown; k?: unknown; h?: unknown };
  try {
    v = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    return { error: "That invite link is broken: ask them for it again." };
  }
  if (typeof v.a !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.a) || typeof v.k !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v.k) || typeof v.h !== "string" || !HANDLE.test(v.h)) return { error: "That invite link is broken: ask them for it again." };
  return { acct: v.a, key: v.k, handle: v.h };
}
// Who a row in the inbox is from: their row here, made for an ask from someone new.
export type Handler = (row: InboxRow, who: RemotePersonRow & { user: User }) => void | Promise<void>;

// Renewed this long before its certificate runs out (7 days), and checked this often.
const RENEW_MS = 3 * 86400e3;
const CHECK_MS = Number(process.env.AGENTBOOK_DOOR_CHECK_MS || 6 * 3600e3);

export function createDoor(d: DoorDeps) {
  const people = d.storage.use(PeopleTables);
  const DIR = path.join(d.home, "door");
  const FILE = path.join(DIR, "door.db");
  const verifier = d.account ? createVerifier({ relay: d.account.relay }) : null;
  const handlers = new Map<string, Handler[]>();
  // What runs once the door is up (feeding the people who see your things: ./api/people-things.ts).
  const ups: (() => void)[] = [];
  let db: PageSide | null = null;
  let proc: DoorProcess | null = null;
  let sock: net.Socket | null = null;
  let status: DoorStatus = { state: "off", why: d.account ? "Starting." : "This page is nobody's yet: log this machine in (agentbook login)." };
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let started = false;
  let draining = false;

  const login = (): MachineLogin | null => (d.account ? machineLogin(d.home) : null);
  const owner = (): User | null => (d.account ? d.accounts.byId(d.account.person) : null);
  const say = (s: DoorStatus) => {
    if (s.state !== status.state || s.why !== status.why) d.log(`door: ${s.state}${s.why ? ` (${s.why})` : ""}`);
    status = s;
  };

  // ---------- the relay ----------
  async function relay<T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T & { error?: string; error_description?: string } }> {
    const l = login();
    if (!l) throw new Error("This machine isn't logged in.");
    return relayCall<T>(l.relay, method, p, { body, login: l });
  }
  type Mine = { door: { key: string; machine: string; certified: string } | null };
  // The account's door as the relay has it.
  const mine = () => relay<Mine>("GET", "/doors");
  // The handle you go by: your username here.
  const myHandle = (): string | null => owner()?.username ?? null;

  // ---------- starting it ----------
  async function start(): Promise<void> {
    if (d.enabled === false || !d.account) return;
    if ((process as { permission?: unknown }).permission) {
      say({ state: "off", why: "The page runs under Node's permission model here, which can't start the door." });
      return;
    }
    const how = irohHow(d.account.relay);
    if (how.mode === "off") return say({ state: "off", why: "iroh is off here (AGENTBOOK_IROH=0)." });
    stopping = false;
    started = true;
    await check().catch((e) => say({ ...status, state: fs.existsSync(FILE) ? status.state : "off", why: e.message }));
    timer = setInterval(() => void check().catch((e) => d.log(`door: ${e.message}`)), CHECK_MS);
    timer.unref?.();
  }
  // Whether this machine is home, and the door running and certified if so: at start, and every few hours, as the
  // relay's word on which machine runs it can change (another machine of yours took it).
  async function check(): Promise<void> {
    const l = login();
    if (!l || stopping) return;
    const r = await mine();
    if (r.status !== 200) throw new Error(`The relay said ${r.status} ${r.body.error || ""} for this account's door.`);
    const { door } = r.body;
    if (door && door.machine !== l.machine) {
      const other = (l.machines || []).find((m) => m.id === door.machine && !m.revoked);
      if (other) {
        await stopProcess();
        return say({ state: "elsewhere", machine: other.name, handle: myHandle(), key: door.key, why: `Your door runs on ${other.name}.` });
      }
      // The machine that ran it is gone from the account: this one takes it.
    }
    if (!proc) await spawn();
    const key = await keyOf();
    if (!key) return say({ state: "off", why: "The door didn't start: see the log." });
    const left = Date.parse(db?.config("expires") || "") - Date.now();
    if (!(left > RENEW_MS) || door?.key !== key || door?.machine !== l.machine) await certify();
    writeCard();
    const was = status.state;
    const handle = db!.config("handle");
    say({ state: "up", handle, key, machine: l.name, expires: db!.config("expires"), invite: handle ? inviteLink(d.account!.relay, { acct: d.account!.account, key, handle }) : null });
    if (was !== "up") for (const fn of ups) fn();
  }
  async function spawn() {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const how = irohHow(d.account!.relay);
    const spawnDoor = doorSpawner();
    if (!spawnDoor) throw new Error("This page runs without agentbook-cli, which starts doors, so there's no door here.");
    proc = spawnDoor({ dir: DIR, account: d.account!.account, relay: d.account!.relay, iroh: how.mode === "local" ? { mode: "local", dir: how.dir } : { mode: "relay", relay: (how as { relay: string }).relay }, log: (l) => d.log(l), extra: process.env.AGENTBOOK_DOOR_RETRY_MS ? ["--retry-ms", process.env.AGENTBOOK_DOOR_RETRY_MS] : [] });
    if (!proc) throw new Error("iroh isn't installed here (npm install), so there's no door.");
    say({ state: "starting" });
    const p = proc;
    p.exited.then((code) => {
      if (proc !== p) return;
      proc = null;
      sock?.destroy();
      sock = null;
      if (!stopping) {
        d.log(`door: stopped (${code}); starting it again in a minute`);
        say({ ...status, state: "starting", why: "It stopped: starting it again." });
        setTimeout(() => void check().catch((e) => d.log(`door: ${e.message}`)), 60e3).unref?.();
      }
    });
  }
  // The door's key, once it's up (its self row names this process's pid): null if it didn't come up in 20 s.
  async function keyOf(): Promise<string | null> {
    const end = Date.now() + 20e3;
    while (Date.now() < end && proc) {
      if (fs.existsSync(FILE)) {
        db ||= new PageSide(FILE);
        if (db.self("why") === "" && Number(db.self("pid")) === proc.pid && db.self("key") && db.self("proof")) {
          connect();
          return db.self("key");
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  async function certify() {
    const key = db!.self("key");
    const proof = db!.self("proof");
    const r = await relay<{ key: string; certificate: string; expires_at: string }>("POST", "/doors", { key, proof });
    if (r.status !== 200) throw new Error(`The relay didn't certify the door: ${r.status} ${r.body.error || ""}`);
    db!.setConfig("certificate", r.body.certificate);
    db!.setConfig("expires", r.body.expires_at);
    nudge();
  }
  // What a hello gets, and the handle every message says: yours, your name and bio, as your profile has them now.
  function writeCard() {
    const u = owner();
    if (!db || !u) return;
    const card = { handle: u.username, name: (u.display_name || u.username).slice(0, 80), ...(u.bio ? { bio: u.bio.slice(0, 500) } : {}) };
    if (db.config("handle") !== u.username) {
      db.setConfig("handle", u.username);
      nudge();
    }
    if (db.config("card") !== JSON.stringify(card)) db.setConfig("card", JSON.stringify(card));
  }

  async function stopProcess() {
    const p = proc;
    proc = null;
    sock?.destroy();
    sock = null;
    await p?.stop();
  }
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    await stopProcess();
    db?.close();
    db = null;
  }

  // ---------- nudges ----------
  function connect() {
    if (sock || !db || !proc) return;
    const p = db.self("socket");
    if (!p) return;
    const s = net.connect(p);
    sock = s;
    let buf = "";
    const drained = () => drain().catch((e) => d.log(`door: reading the inbox: ${e.message}`));
    s.on("connect", () => {
      s.write("outbox\n");
      drained();
    });
    s.on("data", (b) => {
      buf += b.toString();
      if (buf.includes("\n")) {
        buf = "";
        drained();
      }
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (sock === s) sock = null;
      if (proc && !stopping) setTimeout(connect, 1000).unref?.();
    });
  }
  const nudge = () => {
    if (sock && !sock.destroyed && sock.writable) sock.write("outbox\n");
    else connect();
  };

  // ---------- who's who ----------
  const isRemote = (uid: string) => !!people.person(uid);
  const remote = (uid: string) => people.person(uid);
  // A username for someone new: the handle they go by, unless a row here has it (yours, or another @bob's), then with a
  // number.
  function usernameFor(handle: string): string {
    if (!d.accounts.byUsername(handle)) return handle;
    for (let n = 2; n < 100; n++) {
      const u = `${handle.slice(0, 26)}-${n}`;
      if (!d.accounts.byUsername(u)) return u;
    }
    throw new Error(`There's no username left here for @${handle}.`);
  }
  // Someone's row here, by their account, made when it's new (`make`), named by the handle they go by; their door key
  // kept up with what their door's certificate says now (the handle they go by changes with their card).
  function personFor(acct: string, handle: string, key: string, make: boolean): (RemotePersonRow & { user: User }) | null {
    let r = people.byAcct(acct);
    if (!r) {
      if (!make || acct === d.account?.account) return null;
      const made = d.accounts.create({ username: usernameFor(handle), display_name: handle, role: "member" });
      if (made.error) throw new Error(made.error);
      people.putPerson({ user_id: made.user.id, acct, handle, door_key: key });
      r = people.byAcct(acct)!;
      d.log(`door: @${handle} is someone here now (${made.user.username})`);
    } else if (r.door_key !== key) {
      people.putPerson({ user_id: r.user_id, acct, handle: r.handle, door_key: key });
      r = people.byAcct(acct)!;
    }
    const user = d.accounts.byId(r.user_id);
    if (!user || user.deleted) return null;
    db?.putPerson({ acct, handle: r.handle, key: r.door_key });
    return { ...r, user };
  }

  // Someone by the invite link they gave you: their row here, made the first time with the link's door key and handle,
  // and a hello to their door for their card. A link only finds someone: whose door it is, their door's certificate
  // says as it answers, and a door that isn't the link's account gets nothing past a hello (`proven` in
  // plugin/door/main.ts). A row you have already keeps its key: a link can't point someone you know at another door.
  function fromInvite(raw: string): { user: User; remote: RemotePersonRow | null } | { status: number; error: string } {
    if (!d.account) return { status: 409, error: "This page is nobody's yet, so it has no door." };
    if (status.state !== "up") return { status: 409, error: status.state === "elsewhere" ? `Following is on ${status.machine}'s page, where your door is.` : "Your door isn't up yet." };
    const i = readInvite(raw, d.account.relay);
    if ("error" in i) return { status: 400, error: i.error };
    if (i.acct === d.account.account) return { status: 400, error: "That's your own invite link." };
    const had = people.byAcct(i.acct);
    const p = personFor(i.acct, i.handle, had ? had.door_key : i.key, true);
    if (!p) return { status: 409, error: "Whoever that link is for was taken off this page." };
    hello(p.user_id);
    return { user: p.user, remote: people.person(p.user_id) };
  }
  // A hello to someone's door: its answer, their card, comes back into the inbox.
  function hello(uid: string) {
    send(uid, "hello", {}, "hello");
  }

  // ---------- sending ----------
  // A message to someone (their user id), as `kind` (plugin/shared/door/wire.ts); `dedupe` names what it's about, so a newer
  // one replaces one that hasn't gone yet. -> its outbox row, or 0 when they're not someone elsewhere, or there's no
  // door here.
  function send(uid: string, kind: Kind, body: Record<string, unknown>, dedupe?: string): number {
    const r = people.person(uid);
    if (!r || !db) return 0;
    const bad = SHAPES[kind]?.(body, kind);
    if (bad) {
      d.log(`door: not sending a ${kind}: ${bad}`);
      return 0;
    }
    db.putPerson({ acct: r.acct, handle: r.handle, key: r.door_key });
    const n = db.send(r.acct, kind, body, dedupe);
    nudge();
    return n;
  }
  // How they stand with you, for their door's checks (wire.ts's WHO).
  function setRel(uid: string, rel: string[]) {
    const r = people.person(uid);
    if (!r || !db) return;
    const had = db.person(r.acct);
    if (had && had.rel.slice().sort().join() === [...new Set(rel)].sort().join()) return;
    db.putPerson({ acct: r.acct, handle: r.handle, key: r.door_key, rel });
  }

  // ---------- what came in ----------
  function on(kind: Kind, fn: Handler) {
    handlers.set(kind, [...(handlers.get(kind) || []), fn]);
  }
  // Kinds a stranger may send, from whom a row here is made.
  const FROM_ANYONE = new Set(["ask"]);
  // In order, one at a time: a handler that checks a signature finishes before the next message (a withdraw after its
  // records) is taken. A nudge meanwhile goes round again.
  let drainAgain = false;
  async function drain() {
    if (!db) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        let seen = Number(db.config("inbox_seen") || 0);
        for (;;) {
          const rows = db.inboxAfter(seen, 200);
          if (!rows.length) break;
          for (const row of rows) {
            seen = row.n;
            try {
              await take(row);
            } catch (e) {
              d.log(`door: a ${row.kind} from @${row.from_handle} wasn't taken: ${e.message}`);
            }
          }
          db.setConfig("inbox_seen", String(seen));
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
  }
  async function take(row: InboxRow) {
    // The door checked it; it's checked again, as door.db is only as safe as the door.
    const bad = SHAPES[row.kind as Kind]?.(row.body, row.kind);
    if (bad || !SHAPES[row.kind as Kind]) return d.log(`door: dropped a ${row.kind} from @${row.from_handle}: ${bad || "not a kind"}`);
    const known = !!people.byAcct(row.from_acct);
    const who = personFor(row.from_acct, row.from_handle, row.from_key, FROM_ANYONE.has(row.kind));
    if (!who) return;
    // Someone new: their card, from their own door.
    if (!known) hello(who.user_id);
    people.seenNow(who.user_id, new Date(row.at).toISOString());
    if (row.kind === "card") {
      const b = row.body as { handle: string; name?: string; bio?: string };
      // The handle they go by now: your page keeps the username it gave them.
      if (b.handle !== who.handle) {
        people.putPerson({ user_id: who.user_id, acct: who.acct, handle: b.handle, door_key: who.door_key });
        db?.putPerson({ acct: who.acct, handle: b.handle, key: who.door_key });
      }
      people.setCard(who.user_id, { name: b.name ?? null, bio: b.bio ?? null, picture: null }, new Date(row.at).toISOString());
      d.accounts.updateProfile(who.user_id, { display_name: b.name || b.handle, bio: b.bio || "" });
      return;
    }
    for (const fn of handlers.get(row.kind) || []) await fn(row, who);
  }
  // Whose a record is, by its author's door certificate, which the relay signed (one that ran out holds: it was theirs
  // when they signed), and the handle they signed it as: their row here, made the first time (someone in a group or
  // task you're in), named by that handle, with a hello for their card. Null when it doesn't hold.
  // The key is the certificate's, which may be one their door had before: their row keeps the one it has.
  // Yours, passed back to you (your comment on their thread): you.
  async function authorOf(certificate: string, handle: string): Promise<{ user_id: string; acct: string; handle: string; key: string } | null> {
    if (!verifier) return null;
    const c = await verifier.verifyDoor(certificate, { anyTime: true }).catch(() => null);
    if (!c) return null;
    if (c.acct === d.account?.account) return d.account ? { user_id: d.account.person, acct: c.acct, handle, key: c.key } : null;
    let uid = people.byAcct(c.acct)?.user_id;
    if (!uid) {
      const p = personFor(c.acct, handle, c.key, true);
      if (!p) return null;
      hello(p.user_id);
      uid = p.user_id;
    }
    return { user_id: uid, acct: c.acct, handle, key: c.key };
  }

  // Whether their door answered last time yours tried: { ok, at, why }, or null when it never tried.
  const reachOf = (uid: string) => {
    const r = people.person(uid);
    return r && db ? db.reach(r.acct) : null;
  };
  const waitingFor = (uid: string) => {
    const r = people.person(uid);
    return r && db ? db.waitingFor(r.acct) : 0;
  };

  return {
    start,
    stop,
    // Again now: the page's person was just made, so there's a username for your handle.
    recheck: () => void (started && status.state !== "elsewhere" ? check().catch((e) => d.log(`door: ${e.message}`)) : null),
    status: () => ({ ...status }),
    onUp: (fn: () => void) => ups.push(fn),
    fromInvite,
    authorOf,
    hello,
    send,
    setRel,
    on,
    drain,
    isRemote,
    remote,
    reachOf,
    waitingFor,
    writeCard,
    people,
    // door.db, for what the page publishes (server/publish.ts): null without a door here.
    db: () => db,
    // Who's who as the door has it.
    doorPerson: (uid: string): Person | null => {
      const r = people.person(uid);
      return r && db ? db.person(r.acct) : null;
    },
  };
}
export type Door = ReturnType<typeof createDoor>;
