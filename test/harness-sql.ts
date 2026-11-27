// SQL against a storage's database file, for tests only: rows a test sets up by hand, or checks one by one. A
// connection of the test's own, beside the one the storage has (WAL lets both read and write). The code under test
// never does this: only the storage layer touches the database (test/storage-boundary.ts).

import { DatabaseSync } from "../plugin/shared/storage/sqlite.ts";

// node:sqlite's, without its warning that it's experimental: for a test that opens a database file itself.
export { DatabaseSync };

const open = new Map<string, DatabaseSync>();
// The test's connection to this file (a Storage's `file`, a store's `file`), opened once.
export function sql(file: string): DatabaseSync {
  let db = open.get(file);
  if (!db?.isOpen) {
    db = new DatabaseSync(file);
    db.exec("pragma busy_timeout = 5000");
    open.set(file, db);
  }
  return db;
}
// Let go of it (before a test moves or deletes the file).
export function closeSql(file?: string): void {
  for (const [f, db] of open) {
    if (file && f !== file) continue;
    try {
      db.close();
    } catch {}
    open.delete(f);
  }
}
