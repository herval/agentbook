// door.db, the only bridge between your page and your door.
// Two processes open it, and each writes only its own tables: the door (plugin/door/main.ts) writes what came in and
// its own bookkeeping; the page (server/door.ts) writes what to send and who's who. Each side gets a class that has
// only its own writers. Everything in it is what you published and what others sent: never storage.db's.
//
//   the door's: self      its key's public half, and the proof the relay certifies it with
//               inbox     what people sent, as it came: kept for the page to check again and show
//               sent      which outbox rows went to whom (or why not)
//               reach     whether each person's door answered, last time it tried
//   the page's: config    the door's certificate, the card it answers a hello with, how far the page read the inbox
//               people    who's who: each person's account, handle and door key, and how they stand with you
//               outbox    what to send, one row per person
//               published the records each person may see now, by version: what the door's `all` says

// Through SQLite's quiet loader, as the page's storage opens it: the page imports this too.
import { DatabaseSync } from "../storage/sqlite.ts";

const SCHEMA = [
  "create table if not exists self (k text primary key, v text not null)",
  "create table if not exists inbox (n integer primary key autoincrement, at integer not null, from_acct text not null, from_handle text not null, from_key text not null, kind text not null, mid text not null, body text not null, unique (from_acct, mid))",
  "create table if not exists sent (outbox integer not null, to_acct text not null, at integer not null, error text, primary key (outbox, to_acct))",
  "create table if not exists reach (acct text primary key, ok integer not null, at integer not null, why text)",
  "create table if not exists config (k text primary key, v text not null)",
  "create table if not exists people (acct text primary key, handle text not null, key text not null, rel text not null default '')",
  "create table if not exists outbox (n integer primary key autoincrement, at integer not null, to_acct text not null, kind text not null, body text not null, dedupe text)",
  "create index if not exists outbox_dedupe on outbox (dedupe)",
  "create table if not exists published (to_acct text not null, rid text not null, v text not null, primary key (to_acct, rid))",
];

type Row = Record<string, unknown>;
export interface Person {
  acct: string;
  handle: string;
  key: string;
  // How they stand with you, as wire.ts's WHO names it: contact, asked, member, home (comma separated).
  rel: string[];
}
export interface InboxRow {
  n: number;
  at: number;
  from_acct: string;
  from_handle: string;
  from_key: string;
  kind: string;
  mid: string;
  body: Record<string, unknown>;
}
export interface OutboxRow {
  n: number;
  at: number;
  to_acct: string;
  kind: string;
  body: Record<string, unknown>;
}
export interface Reach {
  ok: boolean;
  at: number;
  why: string | null;
}

const personFrom = (r: Row | undefined): Person | null => (r ? { acct: String(r.acct), handle: String(r.handle), key: String(r.key), rel: String(r.rel || "").split(",").filter(Boolean) } : null);

class DoorDb {
  protected db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal");
    this.db.exec("pragma busy_timeout = 5000");
    for (const s of SCHEMA) this.db.exec(s);
  }
  close() {
    this.db.close();
  }
  protected get(k: "self" | "config", key: string): string | null {
    const r = this.db.prepare(`select v from ${k} where k = ?`).get(key) as Row | undefined;
    return r ? String(r.v) : null;
  }
  self(k: string): string | null {
    return this.get("self", k);
  }
  config(k: string): string | null {
    return this.get("config", k);
  }
  person(acct: string): Person | null {
    return personFrom(this.db.prepare("select * from people where acct = ?").get(acct) as Row | undefined);
  }
  // Everyone with that door key: an invite link's key may be someone else's.
  peopleByKey(key: string): Person[] {
    return (this.db.prepare("select * from people where key = ?").all(key) as Row[]).map((r) => personFrom(r)!);
  }
  people(): Person[] {
    return (this.db.prepare("select * from people order by handle").all() as Row[]).map((r) => personFrom(r)!);
  }
  reach(acct: string): Reach | null {
    const r = this.db.prepare("select * from reach where acct = ?").get(acct) as Row | undefined;
    return r ? { ok: !!r.ok, at: Number(r.at), why: (r.why as string) ?? null } : null;
  }
  publishedTo(acct: string): [string, string][] {
    return (this.db.prepare("select rid, v from published where to_acct = ? order by rid").all(acct) as Row[]).map((r) => [String(r.rid), String(r.v)]);
  }
}

// The door's side.
export class DoorSide extends DoorDb {
  setSelf(k: string, v: string) {
    this.db.prepare("insert into self (k, v) values (?, ?) on conflict (k) do update set v = excluded.v").run(k, v);
  }
  // The rows waiting to go, oldest first: none already sent, nor for anyone the page has no door key for.
  waiting(limit = 200): OutboxRow[] {
    const rows = this.db.prepare("select o.* from outbox o join people p on p.acct = o.to_acct where not exists (select 1 from sent s where s.outbox = o.n and s.to_acct = o.to_acct) order by o.n limit ?").all(limit) as Row[];
    return rows.map((r) => ({ n: Number(r.n), at: Number(r.at), to_acct: String(r.to_acct), kind: String(r.kind), body: JSON.parse(String(r.body)) }));
  }
  markSent(n: number, acct: string, error: string | null = null) {
    this.db.prepare("insert or replace into sent (outbox, to_acct, at, error) values (?, ?, ?, ?)").run(n, acct, Date.now(), error);
  }
  // A message taken in; false when it came already (the same sender and id).
  take(r: Omit<InboxRow, "n" | "at">): boolean {
    const x = this.db.prepare("insert or ignore into inbox (at, from_acct, from_handle, from_key, kind, mid, body) values (?, ?, ?, ?, ?, ?, ?)").run(Date.now(), r.from_acct, r.from_handle, r.from_key, r.kind, r.mid, JSON.stringify(r.body));
    return Number(x.changes) === 1;
  }
  has(acct: string, mid: string): boolean {
    return !!this.db.prepare("select 1 from inbox where from_acct = ? and mid = ?").get(acct, mid);
  }
  setReach(acct: string, ok: boolean, why: string | null = null) {
    this.db.prepare("insert into reach (acct, ok, at, why) values (?, ?, ?, ?) on conflict (acct) do update set ok = excluded.ok, at = excluded.at, why = excluded.why").run(acct, ok ? 1 : 0, Date.now(), why);
  }
  // What the page read already and is a week old goes; so does what's sent of rows the page dropped.
  prune() {
    const seen = Number(this.config("inbox_seen") || 0);
    this.db.prepare("delete from inbox where n <= ? and at < ?").run(seen, Date.now() - 7 * 86400e3);
    this.db.prepare("delete from sent where not exists (select 1 from outbox o where o.n = sent.outbox)").run();
  }
}

// The page's side.
export class PageSide extends DoorDb {
  setConfig(k: string, v: string | null) {
    if (v === null) this.db.prepare("delete from config where k = ?").run(k);
    else this.db.prepare("insert into config (k, v) values (?, ?) on conflict (k) do update set v = excluded.v").run(k, v);
  }
  putPerson(p: { acct: string; handle: string; key: string; rel?: string[] }) {
    const had = this.person(p.acct);
    const rel = p.rel ?? had?.rel ?? [];
    this.db.prepare("insert into people (acct, handle, key, rel) values (?, ?, ?, ?) on conflict (acct) do update set handle = excluded.handle, key = excluded.key, rel = excluded.rel").run(p.acct, p.handle, p.key, [...new Set(rel)].sort().join(","));
  }
  setRel(acct: string, rel: string[]) {
    this.db.prepare("update people set rel = ? where acct = ?").run([...new Set(rel)].sort().join(","), acct);
  }
  // A message for `to` (an account): its row. `dedupe` names what it's about: an older row about the same thing that
  // hasn't gone yet is dropped, as this one says it all.
  send(to: string, kind: string, body: Record<string, unknown>, dedupe?: string): number {
    if (dedupe) this.db.prepare("delete from outbox where dedupe = ? and not exists (select 1 from sent s where s.outbox = outbox.n)").run(`${to}|${dedupe}`);
    const r = this.db.prepare("insert into outbox (at, to_acct, kind, body, dedupe) values (?, ?, ?, ?, ?)").run(Date.now(), to, kind, JSON.stringify(body), dedupe ? `${to}|${dedupe}` : null);
    return Number(r.lastInsertRowid);
  }
  // How a row went: null while it waits, else when, and the error the other door gave (null: taken).
  sentOf(n: number, to: string): { at: number; error: string | null } | null {
    const r = this.db.prepare("select at, error from sent where outbox = ? and to_acct = ?").get(n, to) as Row | undefined;
    return r ? { at: Number(r.at), error: (r.error as string) ?? null } : null;
  }
  // How many rows wait for `to`.
  waitingFor(to: string): number {
    return Number((this.db.prepare("select count(*) as n from outbox o where o.to_acct = ? and not exists (select 1 from sent s where s.outbox = o.n and s.to_acct = o.to_acct)").get(to) as Row).n);
  }
  // What came in after `n`, oldest first.
  inboxAfter(n: number, limit = 200): InboxRow[] {
    const rows = this.db.prepare("select * from inbox where n > ? order by n limit ?").all(n, limit) as Row[];
    return rows.map((r) => ({ n: Number(r.n), at: Number(r.at), from_acct: String(r.from_acct), from_handle: String(r.from_handle), from_key: String(r.from_key), kind: String(r.kind), mid: String(r.mid), body: JSON.parse(String(r.body)) }));
  }
  setPublished(to: string, rid: string, v: string | null) {
    if (v === null) this.db.prepare("delete from published where to_acct = ? and rid = ?").run(to, rid);
    else this.db.prepare("insert into published (to_acct, rid, v) values (?, ?, ?) on conflict (to_acct, rid) do update set v = excluded.v").run(to, rid, v);
  }
  dropPublished(to: string) {
    this.db.prepare("delete from published where to_acct = ?").run(to);
  }
  // Rows sent more than an hour ago go.
  prune() {
    this.db.prepare("delete from outbox where at < ? and exists (select 1 from sent s where s.outbox = outbox.n)").run(Date.now() - 3600e3);
  }
}
