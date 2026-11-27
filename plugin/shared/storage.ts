// What agentbook keeps on a machine, behind one door: one SQLite database (<data folder>/storage.db) and the folders
// its files are kept in. Nothing outside the storage layer (this file, plugin/shared/storage/, server/storage/) opens
// the database or writes SQL; test/storage-boundary.ts checks that. Everything else asks a table module for what it
// needs, by name:
// - storage.store(scope): a store's log, state and settings (storage/store.ts), under its scope: this machine's
//   own ("cli"), its page's ("server"), the page's copy of each machine ("device:<id>");
// - storage.use(Tables, scope): any other module's tables: a store's bookkeeping (storage/uplink.ts, work.ts), and
//   what's the page's alone, with no scope (server/storage/: accounts, the relay's, blobs, dashboards, connectors);
// - storage.files(dir): a folder of files (storage/files.ts).
// Each table module declares its tables (`static schema`, one entry per version), brought up the first time it's
// used, under the write lock, so agentbook-cli and a page of its own can open a new file at the same moment.
// One Storage per database file in a process (`Storage.open`): agentbook-cli's daemon and the page it serves share it.
//
// Before storage.db, each store had a database of its own (cli/agentbook.db, server/agentbook.db, server/relay.db,
// server/devices/<id>.db). `adopt` folds one in, once, under the scope it was; the file is left where it was, as it
// was, and nothing reads it again.

import fs from "node:fs";
import path from "node:path";
import { copyDatabase, copyTogether, DatabaseSync, isCorrupt, leaveOpen, moveAside, quote, tablesOf, transaction } from "./storage/sqlite.ts";
import type { SQLInputValue } from "./storage/sqlite.ts";
import { Files } from "./storage/files.ts";
import { StoreTables } from "./storage/store.ts";
import { UplinkTables } from "./storage/uplink.ts";
import { WorkTables } from "./storage/work.ts";

export { Files };
// What a database it couldn't read was renamed to, after its name: <file>.corrupt-<when> (agentbook-cli status says so).
export { CORRUPT } from "./storage/sqlite.ts";
// Whether an error is SQLite saying a file isn't a database it can read (a store moves such a one aside).
export { isCorrupt } from "./storage/sqlite.ts";
export const STORAGE_FILE = "storage.db";

// A store's tables, every one, made as a storage opens: a database from before is folded in under a scope, and every
// table with a scope must be there to take its rows.
const STORE_TABLES = [StoreTables, UplinkTables, WorkTables];

// A table module: its name, its schema (one entry per version), and one of it on a database, under a scope for a
// store's.
export interface TableModule<T> {
  id: string;
  schema: string[];
  new (db: DatabaseSync, scope?: string): T;
}
// A database from before storage.db that was folded in (Storage.adopted).
export type Folded = {
  file: string;
  scope: string | null;
  at: string;
  rows: number;
};
export interface AdoptOptions {
  scope?: string | null;
  globals?: TableModule<unknown>[];
  skip?: boolean;
  moveCorrupt?: boolean;
  log?: (line: string) => void;
}

const opened = new Map<string, Storage>(); // a database file -> its Storage, in this process

export class Storage {
  // The one for `root` (its database is <root>/storage.db, or `file`), opened the first time. `moveCorrupt`: a
  // database SQLite can't read is moved aside and a new one started, when nothing but this machine's own store
  // can be in it (see startOver).
  static open(root: string, { file = path.join(root, STORAGE_FILE), moveCorrupt = false }: { file?: string; moveCorrupt?: boolean } = {}): Storage {
    const key = path.resolve(file);
    let s = opened.get(key);
    if (!s || s.closed) opened.set(key, (s = new Storage(key, { root, moveCorrupt })));
    return s;
  }
  // One whose database is this file (tests, and stores kept elsewhere by hand).
  static at(file: string, opts: { moveCorrupt?: boolean } = {}): Storage {
    return Storage.open(path.dirname(file), { ...opts, file });
  }
  // Whether the storage in this file has rows under `scope`, read without opening it as storage (another data
  // folder's, to import). False for a file that isn't there or isn't a storage.
  static hasScope(file: string, scope: string): boolean {
    if (!fs.existsSync(file)) return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return !!db.prepare("select 1 from meta where scope = ? union all select 1 from events where scope = ? limit 1").get(scope, scope);
    } catch {
      return false;
    } finally {
      db.close();
    }
  }
  // The databases from before storage.db folded into the storage in this file, read without opening it (a backup
  // leaves them out). [] for one that never folded anything.
  static foldedInto(file: string): string[] {
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("select file from folded").all() as { file: string }[]).map((r) => path.resolve(r.file));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  // Databases copied, each whole, all as of one moment (a backup of a data folder): [[file, to, name]], every one's
  // write lock held while they're copied (waiting up to `wait` ms for each); `copied(name)` after each.
  // -> how long the locks were held (ms)
  static copyTogether(pairs: Parameters<typeof copyTogether>[0], opts?: Parameters<typeof copyTogether>[1]): number {
    return copyTogether(pairs, opts);
  }
  // A database copied whole, as one file (its -wal folded in), read-only: what it had when the copy began.
  static copyWhole(file: string, to: string): void {
    copyDatabase(file, to);
  }

  file: string;
  root: string;
  moveCorrupt: boolean;
  closed: boolean;
  // The stores that hold it (hold, release).
  holds: number;
  folders: Map<string, Files>;
  #db: DatabaseSync;
  #ready = new Set<string>(); // the table modules whose tables are made, in this connection

  constructor(file: string, { root = path.dirname(file), moveCorrupt = false }: { root?: string; moveCorrupt?: boolean } = {}) {
    this.file = file;
    this.root = root;
    this.moveCorrupt = moveCorrupt;
    this.closed = false;
    this.holds = 0;
    this.folders = new Map();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch (e) {
      // A server under Node's permission model may use this file and not its folder (bin/agentbook-server).
      if (e.code !== "ERR_ACCESS_DENIED") throw e;
    }
    this.#db = this.#connect();
  }

  #connect(moved = false): DatabaseSync {
    const fresh = !fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    this.#ready = new Set();
    try {
      // secure_delete fast: what a row leaves behind as it's rewritten or deleted is zeroed where that costs no more
      // writes, so a store's rows, once gone (dropScope), leave no old copies in the pages beside others'.
      // busy_timeout first: agentbook-cli and a page of its own may open a new file at the same moment, and turning on
      // WAL takes the lock too.
      db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on; pragma secure_delete = fast;");
      const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
      if (!version && db.prepare("select 1 from sqlite_master where type = 'table' and name in ('schema_version', 'cursors')").get()) throw Object.assign(new Error("this is a database from before storage.db: Storage.adopt takes it in"), { before: true });
      // Its own two tables: each table module's version (#make), and the databases from before it folded in (adopt).
      if (!version || !db.prepare("select 1 from sqlite_master where name = 'schema'").get()) {
        transaction(db, () => {
          db.exec(`create table if not exists schema (module text primary key, version integer not null);
            create table if not exists folded (file text primary key, scope text, at text not null, rows integer not null);
            pragma user_version = 1;`);
        });
      }
      for (const T of STORE_TABLES) this.#make(T, db);
      if (fresh) fs.chmodSync(this.file, 0o600);
      return db;
    } catch (e) {
      if (moved || !isCorrupt(e) || !this.mayStartOver()) {
        leaveOpen(this.file, db);
        throw e;
      }
      console.error(`agentbook: can't read ${this.file} (${e.message}): moved to ${moveAside(this.file, db)}, with its -wal and -shm if it had them, and starting a new one`);
      return this.#connect(true);
    }
  }

  // A table module's tables, brought up to its latest version: each step once, in order, under the write lock, its
  // version read again there.
  #make(T: TableModule<unknown>, db = this.#db): void {
    if (this.#ready.has(T.id)) return;
    const version = () => (db.prepare("select version from schema where module = ?").get(T.id) as { version: number } | undefined)?.version ?? 0;
    while (version() < T.schema.length) {
      transaction(db, () => {
        const v = version();
        if (v >= T.schema.length) return;
        db.exec(T.schema[v]);
        db.prepare("insert into schema (module, version) values (?, ?) on conflict (module) do update set version = excluded.version").run(T.id, v + 1);
      });
    }
    this.#ready.add(T.id);
  }

  // A table module's way into this storage: its tables made, if they aren't, and one of it on this database, under
  // `scope` for a store's.
  use<T>(T: TableModule<T>, scope?: string): T {
    this.#make(T);
    return new T(this.#db, scope);
  }
  // A store's tables (storage/store.ts), under its scope. One per store: it remembers what it last wrote.
  store(scope = "cli"): StoreTables {
    return this.use(StoreTables, scope);
  }

  // Whether a database SQLite can't read may be moved aside for a new one: only when it holds nothing but this
  // machine's own store, whose ops its server has too. The page's data (accounts, every machine's copy) is kept
  // nowhere else, so a storage that may hold it (its folder has the page's, server/) is left for a person to look at.
  mayStartOver(): boolean {
    return this.moveCorrupt && !fs.existsSync(path.join(this.root, "server")) && this.holds <= 1;
  }
  // The database moved aside and a new one started, for a store that found it can't be read (store.ts). What was
  // handed out before is of the old one: ask again. -> where the old one went, or null when it may not (mayStartOver).
  startOver(): string | null {
    if (!this.mayStartOver()) return null;
    const to = moveAside(this.file, this.#db);
    this.#db = this.#connect(true);
    return to;
  }

  // A store's hold on it: closed when the last one lets go (close).
  hold(): this {
    this.holds++;
    return this;
  }
  release(): void {
    if (--this.holds <= 0) this.close();
  }
  // A hold let go after the store found its database can't be read: the last one leaves the connection open, in
  // reach, rather than close it (closing a database SQLite can't read deletes the -wal beside it; leaveOpen).
  releaseBroken(): void {
    if (--this.holds > 0) return;
    leaveOpen(this.file, this.#db);
    this.closed = true;
    if (opened.get(this.file) === this) opened.delete(this.file);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#db.close();
    } catch {}
    if (opened.get(this.file) === this) opened.delete(this.file);
  }

  // What `fn` does through the table modules, all or none.
  transaction<T>(fn: () => T): T {
    return transaction(this.#db, fn);
  }

  // The tables that are a store's: those with a scope column.
  #scoped(schema = "main"): string[] {
    return (this.#db.prepare(`select m.name from ${schema}.sqlite_master m where m.type = 'table' and exists (select 1 from pragma_table_info(m.name, ?) where name = 'scope') order by m.name`).all(schema) as { name: string }[]).map((r) => r.name);
  }
  #columns(schema: string, table: string): string[] {
    return (this.#db.prepare("select name from pragma_table_info(?, ?)").all(table, schema) as { name: string }[]).map((r) => r.name);
  }

  // The scopes it has stores under, by their logs and settings.
  scopes(): string[] {
    return (this.#db.prepare("select distinct scope from meta union select distinct scope from events").all() as { scope: string }[]).map((r) => r.scope);
  }
  // A store's rows, every one, gone (a machine deleted with its person's account): their bytes overwritten too, in
  // the file and its -wal, as deleting the database a store had of its own did.
  dropScope(scope: string): void {
    const db = this.#db;
    db.exec("pragma secure_delete = on");
    try {
      transaction(db, () => {
        for (const t of this.#scoped()) db.prepare(`delete from "${t}" where scope = ?`).run(scope);
      });
    } finally {
      db.exec("pragma secure_delete = fast");
    }
    try {
      db.exec("pragma wal_checkpoint(truncate)");
    } catch {}
  }
  // A store's rows under another scope (a machine that logged in again under a new id). Not over one that has rows.
  renameScope(from: string, to: string): void {
    const db = this.#db;
    transaction(db, () => {
      if (db.prepare("select 1 from meta where scope = ? union select 1 from events where scope = ? limit 1").get(to, to)) throw new Error(`${to} has a store already`);
      for (const t of this.#scoped()) db.prepare(`update "${t}" set scope = ? where scope = ?`).run(to, from);
      db.prepare("update folded set scope = ? where scope = ?").run(to, from);
    });
  }
  // A store's rows copied out to a database of their own (`to`, made new, with a store's tables as this one has them),
  // and put back from one: what agentbook-cli keeps of its own before an update, and puts back if the new one doesn't
  // start. Only that scope's rows move, never the file, which a page running on its own may have open. -> the rows
  // copied, or null (no such copy)
  copyScope(scope: string, to: string): number {
    for (const x of ["", "-wal", "-shm"]) fs.rmSync(to + x, { force: true });
    const out = new DatabaseSync(to);
    try {
      for (const t of this.#scoped()) {
        out.exec((this.#db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(t) as { sql: string }).sql);
        for (const i of this.#db.prepare("select sql from sqlite_master where type = 'index' and tbl_name = ? and sql is not null").all(t) as { sql: string }[]) out.exec(i.sql);
      }
    } finally {
      out.close();
    }
    fs.chmodSync(to, 0o600);
    return this.#between(to, scope, false);
  }
  restoreScope(scope: string, from: string): number | null {
    return fs.existsSync(from) ? this.#between(from, scope, true) : null;
  }
  #between(file: string, scope: string, back: boolean): number {
    const db = this.#db;
    db.exec(`attach database ${quote(path.resolve(file))} as other`);
    let rows = 0;
    try {
      const [into, from] = back ? ["main", "other"] : ["other", "main"];
      const there = new Set(this.#scoped(from));
      transaction(db, () => {
        for (const t of this.#scoped(into)) {
          if (!there.has(t)) continue;
          const cols = this.#columns(from, t);
          const both = this.#columns(into, t).filter((c) => cols.includes(c));
          const q = both.map((c) => `"${c}"`).join(", ");
          if (back) db.prepare(`delete from main."${t}" where scope = ?`).run(scope);
          rows += Number(db.prepare(`insert into ${into}."${t}" (${q}) select ${q} from ${from}."${t}" where scope = ?`).run(scope).changes);
        }
      });
    } finally {
      db.exec("detach database other");
    }
    return rows;
  }

  // A folder of files, in its data folder (`dir` relative to it) or elsewhere (absolute). -> Files
  files(dir: string): Files {
    const at = path.resolve(this.root, dir);
    let f = this.folders.get(at);
    if (!f) this.folders.set(at, (f = new Files(at)));
    return f;
  }

  // A database from before storage.db, folded in once: its store's rows under `scope` (a store's: agentbook.db,
  // devices/<id>.db), and the rows of the tables of `globals` (table modules: the page's accounts, the relay's,
  // blobs'…) it has, the columns both have. Nothing else of it. The file stays as it was. Once per file, the fold in
  // one transaction; `skip`: marked as folded without taking anything in (a store that started over, whose file from
  // before is older than what it lost). `moveCorrupt`: one SQLite can't read is moved aside instead (with its -wal and
  // -shm), as agentbook-cli did with its own, and marked as folded; else its error is thrown. -> { rows } it took in,
  // or null (no such file, or folded before).
  adopt(file: string, { scope = null, globals = [], skip = false, moveCorrupt = false, log = () => {} }: AdoptOptions = {}): { rows: number; moved?: string } | null {
    const from = path.resolve(file);
    for (const T of globals) this.#make(T);
    // Its -wal and -shm as they are: SQLite deletes them as it lets go of a database it can't read.
    const sides: [string, Buffer][] = moveCorrupt ? ["-wal", "-shm"].filter((x) => fs.existsSync(from + x)).map((x) => [x, fs.readFileSync(from + x)]) : [];
    try {
      return this.#adopt(from, { scope, globals: new Set(globals.flatMap((T) => tablesOf(T.schema))), skip, log });
    } catch (e) {
      // Its error, not this database's: this one reads whole.
      if (!moveCorrupt || !isCorrupt(e) || this.#db.prepare("pragma quick_check").get()?.quick_check !== "ok") throw e;
      const to = moveAside(from, { close() {} });
      for (const [x, bytes] of sides) if (!fs.existsSync(to + x)) fs.writeFileSync(to + x, bytes, { mode: 0o600 });
      console.error(`agentbook: can't read ${from} (${e.message}): moved to ${to}, with its -wal and -shm if it had them, and starting a new one`);
      this.#db.prepare("insert or ignore into folded (file, scope, at, rows) values (?, ?, ?, 0)").run(from, scope, new Date().toISOString());
      return { rows: 0, moved: to };
    }
  }
  #adopt(from: string, { scope, globals, skip, log }: { scope: string | null; globals: Set<string>; skip: boolean; log: (line: string) => void }): { rows: number } | null {
    if (from === this.file || !fs.existsSync(from)) return null;
    const db = this.#db;
    if (db.prepare("select 1 from folded where file = ?").get(from)) return null;
    if (skip) {
      db.prepare("insert into folded (file, scope, at, rows) values (?, ?, ?, 0)").run(from, scope, new Date().toISOString());
      return { rows: 0 };
    }
    const started = Date.now();
    db.exec(`attach database ${quote(from)} as old`);
    let rows = 0;
    try {
      const scoped = new Set(this.#scoped());
      const tables = (db.prepare("select name from old.sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
      // Rows that point at others (a sign-in at its person) come over in any order.
      db.exec("pragma foreign_keys = off");
      try {
        transaction(db, () => {
          for (const t of tables) {
            const there = this.#columns("old", t);
            if (scoped.has(t) && scope) {
              const both = this.#columns("main", t).filter((c) => c !== "scope" && there.includes(c));
              const q = both.map((c) => `"${c}"`).join(", ");
              rows += Number(db.prepare(`insert or ignore into main."${t}" (scope, ${q}) select ?, ${q} from old."${t}"`).run(scope).changes);
            } else if (globals.has(t)) {
              const both = this.#columns("main", t).filter((c) => there.includes(c));
              const q = both.map((c) => `"${c}"`).join(", ");
              rows += Number(db.prepare(`insert or ignore into main."${t}" (${q}) select ${q} from old."${t}"`).run().changes);
            }
          }
          db.prepare("insert into folded (file, scope, at, rows) values (?, ?, ?, ?)").run(from, scope, new Date().toISOString(), rows);
        });
      } finally {
        db.exec("pragma foreign_keys = on");
      }
    } finally {
      db.exec("detach database old");
    }
    log(`agentbook: took ${rows} rows from ${from} into ${this.file}${scope ? ` (as ${scope})` : ""}, in ${((Date.now() - started) / 1000).toFixed(1)} s; that file isn't read again`);
    return { rows };
  }

  // Every database from before storage.db that was folded in: { file, scope, at, rows }.
  adopted(): Folded[] {
    return this.#db.prepare("select file, scope, at, rows from folded order by at").all() as Folded[];
  }
}
