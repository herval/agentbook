// SQLite, for the storage layer only (plugin/shared/storage.ts and the table modules beside it, plugin/shared/storage/
// and server/storage/). Nothing else in agentbook opens agentbook's database or writes SQL against it
// (test/storage-boundary.ts checks that). The one exception is reading another program's database (Hermes's, the
// Codex app's), whose schema is theirs: those drivers import DatabaseSync from here.

import fs from "node:fs";
import type { DatabaseSync as Db, SQLInputValue, SQLOutputValue } from "node:sqlite";

// node:sqlite works without a flag since Node 22.13 but still warns that it's experimental; say nothing. It's loaded
// as the module loads (getBuiltinModule), not with an await: one at the top of a module makes everything that imports
// it async in the one-file build (esbuild), where modules that import each other then wait on each other for ever.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => (/SQLite/i.test(String(warning?.message ?? warning)) ? undefined : emit.call(process, warning, ...rest));
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
process.emitWarning = emit;
type DatabaseSync = Db;
export { DatabaseSync };
export type { SQLInputValue, SQLOutputValue };

// A store's table: its scope first, in its key and its indexes. A table with a `scope` column is a store's: its rows
// are folded, copied, renamed and dropped by scope (Storage).
export const scoped = (name: string, cols: string, key = "id"): string => `create table ${name} (scope text not null, ${cols}, primary key (scope, ${key}));`;
export const index = (name: string, table: string, cols: string): string => `create index ${name} on ${table} (scope, ${cols});`;
export const tablesOf = (schema: string[]): string[] => [...schema.join("\n").matchAll(/create table (?:if not exists )?(\w+)/gi)].map((m) => m[1]);

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

// SQLite's own word for a file it can't read as a database: SQLITE_CORRUPT or SQLITE_NOTADB, extended codes included.
// Locked, busy, read-only or can't-open never are: those pass, or are about something else, and the data is fine.
export const isCorrupt = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ERR_SQLITE_ERROR" && [11, 26].includes(("errcode" in e && typeof e.errcode === "number" ? e.errcode : 0) & 0xff);

// A connection that failed, kept open and in reach until the process ends. Closed, it deletes the -wal beside a file
// SQLite can't read, and a connection nothing refers to is closed by the next garbage collection. One per file, as a
// server tries a machine's store again at each hello; the one it replaces isn't the last, so it deletes nothing.
const failed = new Map<string, DatabaseSync>();
export const leaveOpen = (file: string, db: DatabaseSync) => failed.set(file, db);

// Move a database out of the way whole: its -wal holds what was written last, and SQLite wants it beside the file,
// under the same name. `db`: its open connection. As the last one closes, SQLite folds the -wal into the file and
// deletes it, or only deletes it when it can't read the file, so what's kept is copied first; and what's left goes
// before the file does, or a new database would read an old -wal. Nothing already there is written over.
// -> where it went.
export const CORRUPT = ".corrupt-";
export function moveAside(file: string, db: { close(): void }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let to = `${file}${CORRUPT}${stamp}`;
  for (let n = 2; fs.existsSync(to); n++) to = `${file}${CORRUPT}${stamp}-${n}`;
  const sides = ["-wal", "-shm"].filter((s) => fs.existsSync(file + s));
  for (const s of sides) fs.copyFileSync(file + s, to + s);
  try {
    db.close();
  } catch {}
  for (const s of sides) fs.rmSync(file + s, { force: true });
  fs.renameSync(file, to);
  return to;
}

// A database copied whole, as one file (its -wal folded in), from a read-only connection: what it had when it began.
export function copyDatabase(from: string, to: string): void {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.exec(`vacuum into ${quote(to)}`);
  } finally {
    db.close();
  }
}

export const quote = (file: string): string => `'${String(file).replace(/'/g, "''")}'`;

// Databases copied, each whole, all as of one moment: every one's write lock taken first (waiting up to `wait` ms for
// each), then each copied as one file, then the locks let go. `pairs`: [[file, to, name]], `name` for what's said.
// `copied(name)`: called after each copy, while the locks are held. -> how long the locks were held (ms)
export function copyTogether(pairs: [file: string, to: string, name: string][], { wait = 10e3, copied = null }: { wait?: number; copied?: ((name: string) => void) | null } = {}): number {
  const locks: DatabaseSync[] = [];
  let held = 0;
  try {
    for (const [file, , name] of pairs) {
      const db = new DatabaseSync(file);
      locks.push(db);
      db.exec(`pragma busy_timeout = ${Math.max(0, Math.round(wait))}`);
      try {
        db.exec("begin immediate");
      } catch (e) {
        throw new Error(`${name} stayed busy for ${Math.round(wait / 1000)} s, so nothing was copied: try again (${e.message}).`);
      }
    }
    held = Date.now();
    for (const [file, to, name] of pairs) {
      copyDatabase(file, to);
      copied?.(name);
    }
    return Date.now() - held;
  } finally {
    for (const db of locks) {
      try {
        db.exec("rollback");
      } catch {} // the one whose lock it never got
      db.close();
    }
  }
}
