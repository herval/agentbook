// The page's people (server/accounts.ts): their accounts, the Google accounts they sign in with, the machines they've
// connected, their passkeys, pins and follows. storage.use(AccountTables). The users table's password column and the
// invites table are from before Google sign-in only; nothing reads them.

import path from "node:path";
import { quote, transaction } from "../../plugin/shared/storage/sqlite.ts";
import type { DatabaseSync, SQLInputValue } from "../../plugin/shared/storage/sqlite.ts";
import type { Iso } from "../../plugin/shared/types.ts";

// The tables copyFrom takes from another storage.db unless told others: people, then the rows that point at them.
const PEOPLE = ["users", "identities", "auth_sessions", "invites", "devices", "pins", "follows"];

// A person's row, every column. `password`: empty (a hash, from before); `avatar`: their picture, as JSON; `role`:
// "admin" for the page's person, "member" for anyone else.
export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  password: string;
  role: string;
  created: Iso;
  avatar: string | null;
  disabled: Iso | null;
  deleted: Iso | null;
}
// An account elsewhere someone signs in with (identities).
export interface IdentityRow {
  sub: string;
  email: string | null;
  added: Iso;
}
// A person as copyFrom finds them in another storage.db.
export interface UserName {
  id: string;
  username: string;
}
// A browser sign-in, with its person's row (sessionByTokenHash).
export interface SessionUserRow extends UserRow {
  expires: Iso;
  last_seen: Iso | null;
  session_created: Iso;
}
// A machine a person connected, every column, with its person's username (deviceByTokenHash).
export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created: Iso;
  last_seen: Iso | null;
  revoked: number;
  username: string;
}
export type DeviceById = Pick<DeviceRow, "id" | "name" | "user_id" | "revoked" | "created" | "last_seen" | "username">;
export type DeviceOf = Pick<DeviceRow, "id" | "name" | "created" | "last_seen">;
// A machine's request to log in, every column. `device`: the machine an approved one made; `token`: one kept in plain,
// from before.
export interface RequestRow {
  code: string;
  poll_hash: string;
  name: string;
  created: Iso;
  approved_by: string | null;
  token: string | null;
  device: string | null;
  address: string | null;
}
// A passkey's public half. `spki`: its public key, base64url.
export interface PasskeyRow {
  id: string;
  alg: number;
  spki: string;
  name: string | null;
  created: Iso;
  removing?: number;
}

export class AccountTables {
  static id = "accounts";
  // users.disabled: when an admin disabled the account (null: it's on), users.deleted: when they deleted it.
  // device_requests.device: the machine an approved request made, whose token is made when it picks it up (`token`
  // is a token kept in plain by requests from before that); .address: where it asked from, shown to whoever
  // approves it. device_pins: what a machine's login approval signed (keys.pin), until the machine polls for its
  // token. device_replaces: the machines one logged in again without the server takes the place of.
  static schema = [
    `create table users (id text primary key, username text not null unique, display_name text, bio text, password text not null, role text not null default 'member', created text not null, avatar text, disabled text, deleted text);
     create table auth_sessions (token_hash text primary key, user_id text not null references users (id) on delete cascade, created text not null, expires text not null, last_seen text, user_agent text);
     create table invites (code text primary key, created_by text not null references users (id) on delete cascade, created text not null, used_by text references users (id), used_at text, revoked integer not null default 0);
     create table devices (id text primary key, user_id text not null references users (id) on delete cascade, name text not null, token_hash text not null unique, created text not null, last_seen text, revoked integer not null default 0);
     create table device_requests (code text primary key, poll_hash text not null unique, name text not null, created text not null, approved_by text references users (id) on delete cascade, token text, device text, address text);
     create table device_pins (code text primary key, pin text not null, created text not null);
     create table device_replaces (device text not null, replaced text not null, primary key (device, replaced));
     create table passkeys (id text primary key, user_id text not null references users (id) on delete cascade, alg integer not null, spki text not null, name text, created text not null);
     create table pins (user_id text not null references users (id) on delete cascade, post text not null, at text not null, primary key (user_id, post));
     create table follows (user_id text not null references users (id) on delete cascade, page text not null, following integer not null, at text not null, primary key (user_id, page));
     create index auth_sessions_user on auth_sessions (user_id);
     create index devices_user on devices (user_id);`,
    // identities: the accounts elsewhere a person signs in with, through the sign-in relay (plugin/shared/relay-verify.ts):
    // `sub` is `<provider>:<its id there>` (google:1170…), `email` what the provider last said, for showing only.
    `create table identities (sub text primary key, user_id text not null references users (id) on delete cascade, email text, added text not null);
     create index identities_user on identities (user_id);`,
    `alter table passkeys add column removing integer not null default 0;`,
  ];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // A row as `T`, the columns its query selects, or null.
  #one<T = Record<string, never>>(sql: string, ...args: SQLInputValue[]): T | null {
    return (this.#db.prepare(sql).get(...args) as T | undefined) || null;
  }
  #all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.#db.prepare(sql).all(...args) as T[];
  }
  #run(sql: string, ...args: SQLInputValue[]) {
    return this.#db.prepare(sql).run(...args);
  }

  /* ---------- people ---------- */

  userCount(): number {
    return this.#one<{ n: number }>("select count(*) n from users").n;
  }
  // A person's row, every column (their password's hash too), or null.
  userById(uid: string): UserRow | null {
    return this.#one<UserRow>("select * from users where id = ?", uid);
  }
  userByUsername(username: string): UserRow | null {
    return this.#one<UserRow>("select * from users where username = ?", username);
  }
  usernameTaken(username: string): boolean {
    return !!this.#one("select 1 from users where username = ?", username);
  }
  // Everyone here, but not the deleted, oldest first.
  users(): UserRow[] {
    return this.#all<UserRow>("select * from users where deleted is null order by created");
  }
  // The admins whose accounts are on, oldest first.
  admins(): UserRow[] {
    return this.#all<UserRow>("select * from users where role = 'admin' and disabled is null order by created");
  }
  // The first admin, on or not.
  firstAdmin(): UserRow | null {
    return this.#one<UserRow>("select * from users where role = 'admin' order by created limit 1");
  }
  // Everyone, the deleted too: { id, username }.
  everyone(): UserName[] {
    return this.#all<UserName>("select id, username from users order by created").map((u) => ({ id: u.id, username: u.username }));
  }
  // Of `users` ({ id, username }, another storage's), those whose username is someone else's here.
  takenHere<U extends UserName>(users: U[]): U[] {
    return users.filter((u) => this.#one("select 1 from users where username = ? and id != ?", u.username, u.id));
  }
  insertUser({ id, username, display_name = null, bio = null, password, role = "member", created }: Pick<UserRow, "id" | "username" | "password" | "created"> & Partial<Pick<UserRow, "display_name" | "bio" | "role">>): void {
    this.#run("insert into users (id, username, display_name, bio, password, role, created) values (?, ?, ?, ?, ?, ?, ?)", id, username, display_name, bio, password, role, created);
  }
  setDisplayName(uid: string, name: string): void {
    this.#run("update users set display_name = ? where id = ?", name, uid);
  }
  setBio(uid: string, bio: string): void {
    this.#run("update users set bio = ? where id = ?", bio, uid);
  }
  // Their picture, as JSON, or null.
  setAvatar(uid: string, json: string | null): void {
    this.#run("update users set avatar = ? where id = ?", json, uid);
  }
  // Everyone's picture that has one, as JSON.
  avatars(): string[] {
    return this.#all<{ avatar: string }>("select avatar from users where avatar is not null").map((r) => r.avatar);
  }

  /* ---------- browser sign-ins ---------- */

  insertSession({ token_hash, user_id, created, expires, last_seen = created, user_agent = "" }: { token_hash: string; user_id: string; created: Iso; expires: Iso; last_seen?: Iso; user_agent?: string }): void {
    this.#run("insert into auth_sessions (token_hash, user_id, created, expires, last_seen, user_agent) values (?, ?, ?, ?, ?, ?)", token_hash, user_id, created, expires, last_seen, user_agent);
  }
  // A sign-in by its token's hash, with its person's row (`session_created`: when the sign-in began), only while
  // their account is on. Null otherwise.
  sessionByTokenHash(h: string): SessionUserRow | null {
    return this.#one<SessionUserRow>("select s.expires, s.last_seen, s.created as session_created, u.* from auth_sessions s join users u on u.id = s.user_id where s.token_hash = ? and u.disabled is null", h);
  }
  touchSession(h: string, at: Iso): void {
    this.#run("update auth_sessions set last_seen = ? where token_hash = ?", at, h);
  }
  deleteSession(h: string): void {
    this.#run("delete from auth_sessions where token_hash = ?", h);
  }
  // A person's sign-ins, but the one whose token hashes to `except`.
  deleteSessionsOf(uid: string, except = ""): void {
    this.#run("delete from auth_sessions where user_id = ? and token_hash != ?", uid, except);
  }
  // The sign-ins past their end (`expires` before `now`) or unused since `idleBefore`.
  deleteSessionsOver(now: Iso, idleBefore: Iso): void {
    this.#run("delete from auth_sessions where expires < ? or coalesce(last_seen, created) < ?", now, idleBefore);
  }

  /* ---------- someone who leaves ---------- */

  // An account turned off, all at once (as it's deleted): marked disabled (when it wasn't), its sign-ins gone, the
  // machines it approved that haven't picked up their token gone, and its machines revoked. -> the ids of the
  // machines that were connected.
  disableUser(uid: string, at: Iso): string[] {
    return transaction(this.#db, () => {
      this.#run("update users set disabled = coalesce(disabled, ?) where id = ?", at, uid);
      this.#run("delete from auth_sessions where user_id = ?", uid);
      this.#run("delete from device_requests where approved_by = ?", uid);
      const gone = this.#all<{ id: string }>("select id from devices where user_id = ? and revoked = 0", uid).map((d) => d.id);
      this.#run("update devices set revoked = 1 where user_id = ?", uid);
      return gone;
    });
  }
  // An account deleted (after it's disabled): marked so (when it wasn't), its password `password`, its line and
  // picture gone, and its passkeys, the accounts it signed in with, pins and follows. The row and its username stay.
  deleteUser(uid: string, at: Iso, password: string): void {
    transaction(this.#db, () => {
      this.#run("update users set deleted = coalesce(deleted, ?), password = ?, bio = '', avatar = null where id = ?", at, password, uid);
      for (const t of ["passkeys", "identities", "pins", "follows"]) this.#run(`delete from ${t} where user_id = ?`, uid);
    });
  }

  /* ---------- devices: machines a person connected ---------- */

  // The requests made before `at`, gone.
  deleteRequestsBefore(at: Iso): void {
    this.#run("delete from device_requests where created < ?", at);
  }
  requestCount(): number {
    return this.#one<{ n: number }>("select count(*) n from device_requests").n;
  }
  insertRequest({ code, poll_hash, name, created, address = null }: Pick<RequestRow, "code" | "poll_hash" | "name" | "created"> & { address?: string | null }): void {
    this.#run("insert into device_requests (code, poll_hash, name, created, address) values (?, ?, ?, ?, ?)", code, poll_hash, name, created, address);
  }
  // A request by its code, made after `since`: { code, name, created, approved_by, address }, or null.
  requestByCode(code: string, since: Iso): Pick<RequestRow, "code" | "name" | "created" | "approved_by" | "address"> | null {
    return this.#one<Pick<RequestRow, "code" | "name" | "created" | "approved_by" | "address">>("select code, name, created, approved_by, address from device_requests where code = ? and created > ?", code, since);
  }
  // A request by its poll secret's hash, every column, or null.
  requestByPoll(h: string): RequestRow | null {
    return this.#one<RequestRow>("select * from device_requests where poll_hash = ?", h);
  }
  // What a machine's login approval signed (keys.pin), as JSON, or null.
  pinFor(code: string): string | null {
    return this.#one<{ pin: string }>("select pin from device_pins where code = ?", code)?.pin ?? null;
  }
  // A request approved, all at once: its machine made, `user_id`'s, under the name `pick()` gives ({ name, replaces:
  // the ids of the machines it takes the place of }, read under the same lock, so two approvals can't both take one
  // name), the machines it replaces revoked, and what the approval signed (`pin`, JSON) kept for the machine to pick
  // up with its token. -> { name, replaced }
  approveRequest(code: string, { id, user_id, token_hash, created, pin = null }: { id: string; user_id: string; token_hash: string; created: Iso; pin?: string | null }, pick: () => { name: string; replaces: string[] }): { name: string; replaced: string[] } {
    return transaction(this.#db, () => {
      const { name, replaces } = pick();
      for (const did of replaces) this.#run("update devices set revoked = 1 where id = ?", did);
      this.#run("insert into devices (id, user_id, name, token_hash, created) values (?, ?, ?, ?, ?)", id, user_id, name, token_hash, created);
      this.#run("update device_requests set approved_by = ?, device = ?, name = ? where code = ?", user_id, id, name, code);
      if (pin) this.#run("insert into device_pins (code, pin, created) values (?, ?, ?) on conflict (code) do update set pin = excluded.pin", code, pin, created);
      return { name, replaced: replaces };
    });
  }
  // A request's token picked up: its device's token set to `token_hash` (none: it was kept in plain, from before),
  // and the request and its pin gone.
  pickedUp(code: string, device: string | null = null, token_hash: string | null = null): void {
    transaction(this.#db, () => {
      if (token_hash) this.#run("update devices set token_hash = ? where id = ?", token_hash, device);
      this.#run("delete from device_requests where code = ?", code);
      this.#run("delete from device_pins where code = ?", code);
    });
  }

  // A machine's name is its own among everyone's machines here: the hub tells machines apart by it, so the
  // database keeps one connected machine per name. Two from before that (two people's "laptop"s, or a storage.db
  // whose devices were folded in from an old database): the one seen last keeps the name, and each other is renamed
  // to `rename({ id, name, username })` (with -2, -3… after it until it's free), and connects again under its new
  // name. Then the index that keeps it so. Once it's there, there's nothing to do. -> how many were renamed.
  oneMachinePerName(rename: (d: { id: string; name: string; username: string }) => string): number {
    if (this.#one("select 1 from sqlite_master where type = 'index' and name = 'devices_one_per_name'")) return 0;
    return transaction(this.#db, () => {
      const twins = this.#all<{ id: string; name: string; username: string }>("select d.id, d.name, u.username from devices d join users u on u.id = d.user_id where d.revoked = 0 and exists (select 1 from devices o where o.name = d.name and o.revoked = 0 and o.id != d.id and (coalesce(o.last_seen, o.created) > coalesce(d.last_seen, d.created) or (coalesce(o.last_seen, o.created) = coalesce(d.last_seen, d.created) and o.id > d.id))) order by coalesce(d.last_seen, d.created) desc, d.id");
      for (const d of twins) {
        const base = rename(d);
        let n = base;
        for (let i = 2; this.#one("select 1 from devices where name = ? and revoked = 0 and id != ?", n, d.id); i++) n = `${base}-${i}`;
        this.#run("update devices set name = ? where id = ?", n, d.id);
      }
      this.#db.exec("create unique index if not exists devices_one_per_name on devices (name) where revoked = 0");
      return twins.length;
    });
  }

  // The connected machine with this name: { id, user_id, name, created }, or null.
  deviceNamed(name: string): Pick<DeviceRow, "id" | "user_id" | "name" | "created"> | null {
    return this.#one<Pick<DeviceRow, "id" | "user_id" | "name" | "created">>("select id, user_id, name, created from devices where name = ? and revoked = 0", name);
  }
  // A connected machine by its name, as deviceByTokenHash: for one of your machines linked over iroh, whose calls
  // carry no token.
  deviceByName(name: string): DeviceRow | null {
    return this.#one<DeviceRow>("select d.*, u.username from devices d join users u on u.id = d.user_id where d.name = ? and d.revoked = 0 and u.disabled is null", name);
  }
  // A connected machine by its token's hash, with its person's username, only while their account is on. Null
  // otherwise.
  deviceByTokenHash(h: string): DeviceRow | null {
    return this.#one<DeviceRow>("select d.*, u.username from devices d join users u on u.id = d.user_id where d.token_hash = ? and d.revoked = 0 and u.disabled is null", h);
  }
  // A machine by its id, revoked or not: { id, name, user_id, revoked, created, last_seen, username }, or null.
  deviceById(did: string): DeviceById | null {
    return this.#one<DeviceById>("select d.id, d.name, d.user_id, d.revoked, d.created, d.last_seen, u.username from devices d join users u on u.id = d.user_id where d.id = ?", did);
  }
  touchDevice(did: string, at: Iso): void {
    this.#run("update devices set last_seen = ? where id = ?", at, did);
  }
  // A person's connected machines, oldest first: { id, name, created, last_seen }.
  devicesOf(uid: string): DeviceOf[] {
    return this.#all<DeviceOf>("select id, name, created, last_seen from devices where user_id = ? and revoked = 0 order by created", uid);
  }
  // Every machine a person ever connected, revoked ones too.
  deviceIdsOf(uid: string): string[] {
    return this.#all<{ id: string }>("select id from devices where user_id = ?", uid).map((d) => d.id);
  }
  // A machine revoked; `uid`: only when it's theirs. -> whether it was there.
  revokeDevice(did: string, uid: string | null = null): boolean {
    return (uid ? this.#run("update devices set revoked = 1 where id = ? and user_id = ?", did, uid) : this.#run("update devices set revoked = 1 where id = ?", did)).changes > 0;
  }
  // The connected machines unused since `before` revoked (`uid`: only theirs).
  revokeIdleDevices(before: Iso, uid: string | null = null): void {
    if (uid) this.#run("update devices set revoked = 1 where revoked = 0 and coalesce(last_seen, created) < ? and user_id = ?", before, uid);
    else this.#run("update devices set revoked = 1 where revoked = 0 and coalesce(last_seen, created) < ?", before);
  }
  // Every machine a person ever connected gone, with the requests they approved or that name one of them.
  forgetDevices(uid: string): void {
    transaction(this.#db, () => {
      this.#run("delete from device_requests where approved_by = ? or device in (select id from devices where user_id = ?)", uid, uid);
      this.#run("delete from devices where user_id = ?", uid);
    });
  }
  // A machine logged in again without the server (agentbook-server machine): the machines it replaces, for the
  // server to hand their things to it when it first sees it.
  addReplaced(did: string, old: string): void {
    this.#run("insert into device_replaces (device, replaced) values (?, ?) on conflict do nothing", did, old);
  }
  // The machines `did` replaces, forgotten as they're read.
  takeReplaced(did: string): string[] {
    const olds = this.#all<{ replaced: string }>("select replaced from device_replaces where device = ?", did).map((r) => r.replaced);
    if (olds.length) this.#run("delete from device_replaces where device = ?", did);
    return olds;
  }

  /* ---------- passkeys: what each person signs commands with ---------- */

  // Only their public halves: each machine pins them, and checks every command that can run something against them.
  // A person's, oldest first: { id, alg, spki, name, created }.
  passkeysOf(uid: string, includingRemoving = false): PasskeyRow[] {
    return this.#all<PasskeyRow>("select id, alg, spki, name, created, removing from passkeys where user_id = ? and (removing = 0 or ?) order by created", uid, Number(includingRemoving));
  }
  // A passkey added, or its name changed when it's there. -> false when its id is someone else's.
  addPasskey({ id, user_id, alg, spki, name = null, created }: Omit<PasskeyRow, "name"> & { user_id: string; name?: string | null }): boolean {
    if (this.#one("select 1 from passkeys where id = ? and user_id != ?", id, user_id)) return false;
    this.#run("insert into passkeys (id, user_id, alg, spki, name, created) values (?, ?, ?, ?, ?, ?) on conflict (id) do update set name = excluded.name", id, user_id, alg, spki, name, created);
    return true;
  }
  renamePasskey(uid: string, id: string, name: string): boolean {
    return this.#run("update passkeys set name = ? where user_id = ? and id = ?", name, uid, id).changes > 0;
  }
  markRemoving(uid: string, id: string) {
    this.#run("update passkeys set removing = 1 where user_id = ? and id = ?", uid, id);
  }
  // -> whether it was theirs.
  removePasskey(uid: string, kid: string): boolean {
    return this.#run("delete from passkeys where id = ? and user_id = ?", kid, uid).changes > 0;
  }

  /* ---------- identities: signing in through the relay ---------- */

  // Whose `sub` is, while their account is on: their row, or null.
  userByIdentity(sub: string): UserRow | null {
    return this.#one<UserRow>("select u.* from identities i join users u on u.id = i.user_id where i.sub = ?", sub);
  }
  // The Google accounts a person signs in with (a machine linking to theirs takes them, server/mesh.ts).
  identitiesOf(uid: string): IdentityRow[] {
    return this.#all<IdentityRow>("select sub, email, added from identities where user_id = ? order by added", uid);
  }
  // `sub` as theirs (its email brought up to date when it is already). -> false when it's someone else's.
  addIdentity(uid: string, { sub, email = null, added }: IdentityRow): boolean {
    const r = this.#run("insert into identities (sub, user_id, email, added) values (?, ?, ?, ?) on conflict (sub) do update set email = excluded.email where identities.user_id = excluded.user_id", sub, uid, email, added);
    return r.changes > 0;
  }
  // A new account and the Google account it signs in with, together (the page's person, at their first sign-in).
  // -> false when either is taken.
  insertUserWith(user: UserRow, identity: IdentityRow): boolean {
    return transaction(this.#db, () => {
      if (this.#one("select 1 from identities where sub = ?", identity.sub) || this.usernameTaken(user.username)) return false;
      this.insertUser(user);
      this.addIdentity(user.id, identity);
      return true;
    });
  }
  /* ---------- pins: each person keeps their own ---------- */

  // A person's pins: { post, at }.
  pinsOf(uid: string): { post: string; at: Iso }[] {
    return this.#all<{ post: string; at: Iso }>("select post, at from pins where user_id = ?", uid);
  }
  pin(uid: string, post: string, at: Iso): void {
    this.#run("insert into pins (user_id, post, at) values (?, ?, ?) on conflict do nothing", uid, post, at);
  }
  unpin(uid: string, post: string): void {
    this.#run("delete from pins where user_id = ? and post = ?", uid, post);
  }
  // A post off everyone's pins. -> how many had it.
  unpinAll(post: string): number {
    return Number(this.#run("delete from pins where post = ?", post).changes);
  }

  /* ---------- follows: the pages each person has followed or stopped following ---------- */

  // A person's follows: { page, following } (1 or 0).
  followsOf(uid: string): { page: string; following: number }[] {
    return this.#all<{ page: string; following: number }>("select page, following from follows where user_id = ?", uid);
  }
  setFollow(uid: string, page: string, following: boolean, at: Iso): void {
    this.#run("insert into follows (user_id, page, following, at) values (?, ?, ?, ?) on conflict (user_id, page) do update set following = excluded.following, at = excluded.at", uid, page, following ? 1 : 0, at);
  }

  /* ---------- moving in ---------- */

  // The accounts of another storage.db (`file`) copied in, row for row: the columns both have, and none that's here
  // already. -> [[table, rows copied]], each of `tables` the other has.
  copyFrom(file: string, tables: string[] = PEOPLE): [string, number][] {
    const db = this.#db;
    db.exec(`attach database ${quote(path.resolve(file))} as other`);
    try {
      const columns = (schema: string, t: string) => this.#all<{ name: string }>("select name from pragma_table_info(?, ?)", t, schema).map((c) => c.name);
      return transaction(db, () => {
        const copied: [string, number][] = [];
        for (const t of tables) {
          const there = new Set(columns("other", t));
          const cols = columns("main", t).filter((c) => there.has(c));
          if (!cols.length) continue;
          const q = cols.map((c) => `"${c}"`).join(", ");
          copied.push([t, Number(this.#run(`insert or ignore into main."${t}" (${q}) select ${q} from other."${t}"`).changes)]);
        }
        return copied;
      });
    } finally {
      db.exec("detach database other");
    }
  }
}
