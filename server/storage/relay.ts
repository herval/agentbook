// The relay's bookkeeping (server/relay.ts): each machine's ids and how far the page has its ops, commands sent to
// machines, what they said of themselves, their audit lines, ops parked for later, and what lives elsewhere by its
// person. Before storage.db, relay.db's. storage.use(RelayTables).
//
// What lives elsewhere (homes) is kept by its person (owner). A relay.db from before that kept it for everyone's
// machines at once: folded in, those rows have no owner and aren't taken, and each machine's store says them again as
// it opens (the relay's learnHomes).

import { transaction } from "../../plugin/shared/storage/sqlite.ts";
import type { DatabaseSync } from "../../plugin/shared/storage/sqlite.ts";
import type { Iso } from "../../plugin/shared/types.ts";

// The tables with a machine's rows, by its id (`device`): what goes with it, or moves to its new id.
const OF_A_MACHINE = ["ids", "twins", "cursors", "info", "commands", "relay_cache", "audit"];

const parse = (json: string | null | undefined): unknown => {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
};

// One of a machine's ids, as the page knows it.
export type IdRow = {
  local: string;
  global: string;
};
// What lives elsewhere, by its person (`owner`: their id, "" for none) and the machine it lives on (`home`).
export type HomeRow = IdRow & {
  owner: string;
  home: string;
};
// What a command's owner's passkey signed of it, kept with it.
export interface CommandSigned {
  v?: number;
  machine?: string;
  sig?: unknown;
}
// A command as it's kept for its machine. `by`: the username of the person who sent it.
export interface KeptCommand {
  cid: string;
  kind: string;
  args: Record<string, unknown>;
  by: string | null;
  at: Iso;
  expires: Iso | null;
  signed: CommandSigned | null;
}
// What a machine answered a command or a read: its own fields, and an error when it couldn't.
export interface CommandAnswer {
  error?: string;
  [field: string]: unknown;
}
// What starting a thread asks of its machine (a post.start command): the launch's id, its agent, folder and prompt.
export interface StartArgs {
  lid: string;
  agent: string;
  root?: string;
  prompt?: string;
  [field: string]: unknown;
}
// A start (post.start) its machine answered.
export interface DoneStart {
  cid: string;
  args: StartArgs;
  by: string | null;
  at: Iso;
  result: CommandAnswer | null;
}
// What a machine said it takes at its last hello: { kind: [field] }.
export type Takes = Record<string, string[]>;

export class RelayTables {
  static id = "relay";
  static schema = [
    `create table ids (device text not null, local text not null, global text not null unique, primary key (device, local));
     create table cursors (device text primary key, seq integer not null, epoch text);
     create table commands (cid text primary key, device text not null, kind text not null, args text not null, by text, at text not null, expires text, state text not null, result text, signed text);
     create index commands_device on commands (device, state);
     create table relay_cache (key text primary key, device text not null, fetched text not null, data text not null);
     create table info (device text not null, key text not null, data text not null, at text not null, primary key (device, key));
     create table audit (device text not null, seq integer not null, data text not null, primary key (device, seq));
     create table twins (device text not null, local text not null, global text not null, primary key (device, local));
     create table machine_hellos (device text primary key, protocol integer, version text, takes text);
     create table parked_ops (device text not null, seq integer not null, op text not null, error text, at text not null, primary key (device, seq));
     create table homes (owner text not null, home text not null, local text not null, global text not null, primary key (owner, home, local));`,
  ];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  #q(sql: string) {
    return this.#db.prepare(sql);
  }

  /* ---------- machines: how far the page has their ops ---------- */

  // The machines that sent something before: their ids.
  devices(): string[] {
    return (this.#q("select device from cursors").all() as { device: string }[]).map((r) => r.device);
  }
  // How far the page has a machine's ops: { seq, epoch }, or null for one that never sent any.
  cursor(device: string): { seq: number; epoch: string | null } | null {
    const r = this.#q("select seq, epoch from cursors where device = ?").get(device) as { seq: number; epoch: string | null } | undefined;
    return r ? { seq: r.seq, epoch: r.epoch } : null;
  }
  // Its ops up to `seq` taken, of its log `epoch` (null keeps the one it had).
  saveCursor(device: string, seq: number, epoch: string | null = null): void {
    this.#q("insert into cursors (device, seq, epoch) values (?, ?, ?) on conflict (device) do update set seq = excluded.seq, epoch = coalesce(excluded.epoch, cursors.epoch)").run(device, seq, epoch);
  }
  // Its log's epoch, as it first says it: only that for one with a cursor, and `seq` too for one without.
  saveEpoch(device: string, epoch: string, seq = 0): void {
    this.#q("insert into cursors (device, seq, epoch) values (?, ?, ?) on conflict (device) do update set epoch = excluded.epoch").run(device, seq, epoch);
  }

  /* ---------- ids: a machine's, as the page knows them ---------- */

  // The ids a machine named: [{ local, global }].
  idsOf(device: string): IdRow[] {
    return (this.#q("select local, global from ids where device = ?").all(device) as IdRow[]).map((r) => ({ local: r.local, global: r.global }));
  }
  // The machine that named a page's id, or null.
  namerOf(global: string): string | null {
    return (this.#q("select device from ids where global = ?").get(global) as { device: string } | undefined)?.device ?? null;
  }
  addId(device: string, local: string, global: string): void {
    this.#q("insert or ignore into ids (device, local, global) values (?, ?, ?)").run(device, local, global);
  }
  dropId(device: string, local: string): void {
    this.#q("delete from ids where device = ? and local = ?").run(device, local);
  }
  // The ids a machine shares with the one that named them (twins): [{ local, global }].
  twinsOf(device: string): IdRow[] {
    return (this.#q("select local, global from twins where device = ?").all(device) as IdRow[]).map((r) => ({ local: r.local, global: r.global }));
  }
  saveTwin(device: string, local: string, global: string): void {
    this.#q("insert into twins (device, local, global) values (?, ?, ?) on conflict (device, local) do update set global = excluded.global").run(device, local, global);
  }
  dropTwin(device: string, local: string): void {
    this.#q("delete from twins where device = ? and local = ?").run(device, local);
  }

  /* ---------- what lives elsewhere, by its person ---------- */

  homes(): HomeRow[] {
    return (this.#q("select owner, home, local, global from homes").all() as HomeRow[]).map((r) => ({ owner: r.owner, home: r.home, local: r.local, global: r.global }));
  }
  addHome(owner: string, home: string, local: string, global: string): void {
    this.#q("insert or ignore into homes (owner, home, local, global) values (?, ?, ?, ?)").run(owner, home, local, global);
  }
  // A person's, once their machines are gone.
  forgetHomes(owner: string): void {
    this.#q("delete from homes where owner = ?").run(owner);
  }

  /* ---------- what a machine says of itself ---------- */

  // What it knows right now, as it last said: { key: value }.
  infoOf(device: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.#q("select key, data from info where device = ?").all(device) as { key: string; data: string }[]) out[r.key] = JSON.parse(r.data);
    return out;
  }
  saveInfo(device: string, key: string, value: unknown, at = new Date().toISOString()): void {
    this.#q("insert into info (device, key, data, at) values (?, ?, ?, ?) on conflict (device, key) do update set data = excluded.data, at = excluded.at").run(device, key, JSON.stringify(value), at);
  }
  dropInfo(device: string, key: string): void {
    this.#q("delete from info where device = ? and key = ?").run(device, key);
  }
  // What it said it takes at its last hello ({ kind: [field] }), or null when it hasn't said.
  takes(device: string): Takes | null {
    return parse((this.#q("select takes from machine_hellos where device = ?").get(device) as { takes: string | null } | undefined)?.takes) as Takes | null;
  }
  saveHello(device: string, { protocol = 0, version = null, takes }: { protocol?: number; version?: string | null; takes: Takes }): void {
    this.#q("insert into machine_hellos (device, protocol, version, takes) values (?, ?, ?, ?) on conflict (device) do update set protocol = excluded.protocol, version = excluded.version, takes = excluded.takes").run(device, protocol, version, JSON.stringify(takes));
  }

  /* ---------- its ops this server couldn't take, kept for when it can ---------- */

  // An op as it came (`op`), and why it was refused (its first 500 characters).
  park(device: string, seq: number, op: unknown, error: string, at = new Date().toISOString()): void {
    this.#q("insert or ignore into parked_ops (device, seq, op, error, at) values (?, ?, ?, ?, ?)").run(device, seq, JSON.stringify(op), String(error).slice(0, 500), at);
  }
  // Its parked ops, oldest first: [{ seq, op }].
  parked(device: string): { seq: number; op: unknown }[] {
    return (this.#q("select seq, op from parked_ops where device = ? order by seq").all(device) as { seq: number; op: string }[]).map((r) => ({ seq: r.seq, op: JSON.parse(r.op) }));
  }
  parkedCount(device: string): number {
    return (this.#q("select count(*) n from parked_ops where device = ?").get(device) as { n: number }).n;
  }
  unpark(device: string, seq: number): void {
    this.#q("delete from parked_ops where device = ? and seq = ?").run(device, seq);
  }

  /* ---------- its audit: what its gate did with the commands it got ---------- */

  // A line of it (op `seq` of its log; one kept already stays as it was), and only its latest `keep` lines kept.
  addAudit(device: string, seq: number, line: Record<string, unknown>, keep: number): void {
    this.#q("insert into audit (device, seq, data) values (?, ?, ?) on conflict (device, seq) do nothing").run(device, seq, JSON.stringify(line));
    this.#q("delete from audit where device = ? and seq <= (select seq from audit where device = ? order by seq desc limit 1 offset ?)").run(device, device, keep);
  }
  // Its latest `n` lines, newest first.
  audits(device: string, n = 100): Record<string, unknown>[] {
    return (this.#q("select data from audit where device = ? order by seq desc limit ?").all(device, n) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  /* ---------- commands, down ---------- */

  // Whether a command with this id was ever kept (a signed one is sent once).
  hasCommand(cid: string): boolean {
    return !!this.#q("select 1 from commands where cid = ?").get(cid);
  }
  // A command kept, queued for its machine. `signed`: what its owner's passkey signed of it ({ v, machine, sig }),
  // kept with it while it waits.
  queueCommand({ cid, device, kind, args, by = null, at, expires = null, signed = null }: Omit<KeptCommand, "by" | "expires" | "signed"> & { device: string; by?: string | null; expires?: Iso | null; signed?: CommandSigned | null }): void {
    this.#q("insert into commands (cid, device, kind, args, by, at, expires, state, signed) values (?, ?, ?, ?, ?, ?, ?, 'queued', ?)").run(cid, device, kind, JSON.stringify(args), by, at, expires, signed ? JSON.stringify(signed) : null);
  }
  // A machine's commands in these states (queued, sent), oldest first: [{ cid, kind, args, by, at, expires, signed }],
  // `signed` null for one its owner's passkey didn't sign (or whose signature can't be read).
  commandsOf(device: string, states: string[]): KeptCommand[] {
    return (this.#q(`select cid, kind, args, by, at, expires, signed from commands where device = ? and state in (${states.map(() => "?").join(", ")}) order by at`).all(device, ...states) as { cid: string; kind: string; args: string; by: string | null; at: string; expires: string | null; signed: string | null }[]).map((c) => ({
      cid: c.cid,
      kind: c.kind,
      args: JSON.parse(c.args),
      by: c.by,
      at: c.at,
      expires: c.expires,
      signed: parse(c.signed) as CommandSigned | null,
    }));
  }
  // Gone to its machine, waiting for its answer.
  markSent(cid: string): void {
    this.#q("update commands set state = 'sent' where cid = ?").run(cid);
  }
  // Ran out of time waiting for its machine.
  expireCommand(cid: string): void {
    this.#q("update commands set state = 'expired' where cid = ?").run(cid);
  }
  // Its machine answered (what's kept of the answer is its first 64 KB of JSON). -> the state it was in before
  // (queued, sent…), or undefined when this machine has no such command.
  finishCommand(device: string, cid: string, result: unknown): string | undefined {
    const was = (this.#q("select state from commands where cid = ? and device = ?").get(cid, device) as { state: string } | undefined)?.state;
    this.#q("update commands set state = 'done', result = ? where cid = ? and device = ?").run(JSON.stringify(result ?? null).slice(0, 64 * 1024), cid, device);
    return was;
  }
  // Taken back while it's queued. -> whether it was
  cancelCommand(device: string, cid: string): boolean {
    return this.#q("update commands set state = 'cancelled' where cid = ? and device = ? and state = 'queued'").run(cid, device).changes > 0;
  }
  // The starts (post.start) a machine answered since `since` (an ISO time): [{ cid, args, by, at, result }].
  doneStarts(device: string, since: Iso): DoneStart[] {
    return (this.#q("select cid, args, by, at, result from commands where device = ? and kind = 'post.start' and state = 'done' and at > ?").all(device, since) as { cid: string; args: string; by: string | null; at: string; result: string | null }[]).map((c) => ({
      cid: c.cid,
      args: JSON.parse(c.args),
      by: c.by,
      at: c.at,
      result: c.result ? JSON.parse(c.result) : null,
    }));
  }
  // A start its machine refused (its answer has an error), by its launch's id, set aside. -> whether one was
  archiveFailedStart(device: string, lid: string): boolean {
    return this.#q("update commands set state = 'archived' where device = ? and kind = 'post.start' and state = 'done' and json_extract(args, '$.lid') = ? and json_extract(result, '$.error') is not null").run(device, String(lid)).changes > 0;
  }

  /* ---------- reads: what a machine last answered ---------- */

  // The answer kept under `key`: { data, fetched }, or null.
  cachedRead(key: string): { data: unknown; fetched: Iso } | null {
    const r = this.#q("select data, fetched from relay_cache where key = ?").get(key) as { data: string; fetched: string } | undefined;
    return r ? { data: JSON.parse(r.data), fetched: r.fetched } : null;
  }
  cacheRead(key: string, device: string, data: unknown, fetched: Iso): void {
    this.#q("insert into relay_cache (key, device, fetched, data) values (?, ?, ?, ?) on conflict (key) do update set fetched = excluded.fetched, data = excluded.data").run(key, device, fetched, JSON.stringify(data));
  }
  // Every answer a machine gave (its device revoked).
  forgetReads(device: string): void {
    this.#q("delete from relay_cache where device = ?").run(device);
  }

  // Commands no longer waiting (done, expired, cancelled) from before `done`, and reads fetched before `reads` (ISO
  // times), forgotten.
  prune({ done, reads }: { done: Iso; reads: Iso }): void {
    this.#q("delete from commands where state not in ('queued', 'sent') and at < ?").run(done);
    this.#q("delete from relay_cache where fetched < ?").run(reads);
  }

  /* ---------- a machine, whole ---------- */

  // Whether this machine ever sent something (it has a cursor).
  known(device: string): boolean {
    return !!this.#q("select 1 from cursors where device = ?").get(device);
  }
  // Every row of a machine here gone (a machine deleted with its person's account), its parked ops and its hello too.
  forgetDevice(device: string): void {
    transaction(this.#db, () => {
      for (const t of [...OF_A_MACHINE, "parked_ops", "machine_hellos"]) this.#q(`delete from ${t} where device = ?`).run(device);
    });
  }
  // A machine's rows under its new id (it logged in again: the same machine with a new key).
  renameDevice(from: string, to: string): void {
    transaction(this.#db, () => {
      for (const t of OF_A_MACHINE) this.#q(`update ${t} set device = ? where device = ?`).run(to, from);
    });
  }
}
