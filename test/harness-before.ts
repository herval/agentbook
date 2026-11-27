// A database as agentbook kept them before storage.db (plugin/shared/storage.ts), for tests of what folds them in:
// one store's tables with no scope column, a schema_version table, and the page's tables (`globals`) it had. Made
// from what a test wrote with today's code into a storage of its own (`storage`), under `scope`.
// `globals`: the names of tables with no scope to copy, or "all" (each such table but `folded`).

import fs from "node:fs";
import path from "node:path";
import type { Storage } from "../plugin/shared/storage.ts";
import { DatabaseSync, sql } from "./harness-sql.ts";

export function writeBefore(storage: Storage, scope: string | null, file: string, { globals = [] }: { globals?: string[] | "all" } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new DatabaseSync(file);
  old.exec("create table schema_version (version integer not null); insert into schema_version values (1)");
  old.close();
  const db = sql(storage.file);
  const cols = (t: string) => db.prepare("select name, type from pragma_table_info(?)").all(t) as { name: string; type: string }[];
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('folded', 'schema')").all() as { name: string }[]).map((r) => r.name);
  const scoped = tables.filter((t) => cols(t).some((c) => c.name === "scope"));
  const plain = tables.filter((t) => !scoped.includes(t));
  db.exec(`attach database '${file.replace(/'/g, "''")}' as old`);
  try {
    for (const t of scope ? scoped : []) {
      const own = cols(t).filter((c) => c.name !== "scope");
      db.exec(`create table old."${t}" (${own.map((c) => `"${c.name}" ${c.type}`).join(", ")})`);
      db.prepare(`insert into old."${t}" select ${own.map((c) => `"${c.name}"`).join(", ")} from main."${t}" where scope = ? order by rowid`).run(scope);
    }
    for (const t of globals === "all" ? plain : globals) db.exec(`create table old."${t}" as select * from main."${t}"`);
  } finally {
    db.exec("detach database old");
  }
}
