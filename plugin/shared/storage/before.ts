// agentbook's databases from before storage.db (cli/agentbook.db, the agentbook.db at the top of a data folder from
// before the split): what's still done to one as a file, besides folding it in (Storage.adopt). Each opened here, by
// itself, and closed again; never as storage.

import fs from "node:fs";
import { copyDatabase, DatabaseSync } from "./sqlite.ts";

// The page's accounts, in a database from before the split (one database kept everything, accounts too) or in a
// storage.db a page ran on: how many, or 0 when it has none or can't be read.
export function usersIn(file: string): number {
  if (!fs.existsSync(file)) return 0;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("select count(*) n from users").get() as { n: number }).n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

// The page's person in it: its first admin, as role "admin" marked them before accounts (the page's own person since),
// not disabled or deleted. Null when it has none or can't be read.
export function pagePersonIn(file: string): { id: string; username: string } | null {
  if (!fs.existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("select id, username from users where role = 'admin' and disabled is null and deleted is null order by created, id limit 1").get() as { id: string; username: string } | undefined) ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// A copy of it, as one file (its -wal folded in), to go back to.
export const copyWhole = copyDatabase;

// Its log (-wal) written into it, and closed: one file to move. -> whether that's so (false: another process has it
// open, and its -wal is still there).
export function closeLog(file: string): boolean {
  const db = new DatabaseSync(file);
  try {
    db.exec("pragma wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return !fs.existsSync(`${file}-wal`);
}

// The accounts' rows it kept from before the split (sign-ins, invites, machines, pins, follows, people), deleted and
// overwritten as they go (secure_delete), its log folded in after, so no password hash is left on disk.
// -> how many rows
const ACCOUNT_TABLES = ["auth_sessions", "invites", "device_requests", "devices", "pins", "follows", "users"];
export function scrubAccounts(file: string): number {
  const db = new DatabaseSync(file);
  let n = 0;
  try {
    db.exec("pragma busy_timeout = 5000; pragma secure_delete = on");
    const has = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name));
    db.exec("begin immediate");
    try {
      for (const t of ACCOUNT_TABLES) if (has.has(t)) n += Number(db.prepare(`delete from ${t}`).run().changes);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
    try {
      db.exec("pragma wal_checkpoint(TRUNCATE)");
    } catch {}
  } finally {
    db.close();
  }
  return n;
}
