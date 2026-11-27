// Rebuildable full-text search index in its own SQLite database (<SERVER_HOME>/search.db).
// Uses contentless FTS5 (no raw text duplicated on disk) with unicode61 accent folding and
// 2/3-char prefix indexes; snippets are computed on winning hits via a temporary FTS5 table.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, isCorrupt, transaction } from "../../plugin/shared/storage/sqlite.ts";

const SCHEMA = 1;
const CACHE_KB = 2000;
const TEXT_MAX = 64 * 1024;
const SNIPPET_TOKENS = 28;

export type SearchKind = "thread" | "msg" | "note" | "page" | "task" | "group";

export interface SearchEntry {
  scope: string;
  kind: SearchKind;
  parent: string;
  item: string;
  localPost?: string | null;
  localId?: string | null;
  at: number;
  role?: 0 | 1;
  text: string;
}

export interface SearchDocRow {
  id: number;
  scope: string;
  kind: SearchKind;
  parent: string;
  item: string;
  local_post: string | null;
  local_id: string | null;
  at: number;
  role: number;
  rank: number;
}

function removeFiles(file: string): void {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(file + s, { force: true });
    } catch {}
  }
}

export class SearchStorage {
  file: string;
  #db: DatabaseSync;

  constructor(file: string) {
    this.file = file;
    this.#db = this.#open();
  }

  #open(retried = false): DatabaseSync {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw e;
    }
    const fresh = !fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    try {
      db.exec(
        `pragma busy_timeout = 5000;
         pragma journal_mode = wal;
         pragma synchronous = normal;
         pragma cache_size = -${CACHE_KB};
         pragma temp_store = memory;`,
      );
      const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
      if (version !== SCHEMA) {
        transaction(db, () => {
          db.exec(`
            drop table if exists body;
            drop table if exists docs;
            drop table if exists cursors;
            create table cursors (
              scope text primary key,
              seq integer not null default 0,
              built integer not null default 0
            );
            create table docs (
              id integer primary key,
              scope text not null,
              kind text not null,
              parent text not null,
              item text not null,
              local_post text,
              local_id text,
              at integer not null,
              role integer not null default 0,
              unique(scope, kind, parent, item)
            );
            create index docs_scope_parent on docs (scope, parent);
            create index docs_parent on docs (parent);
            create virtual table body using fts5 (
              text,
              content = '',
              contentless_delete = 1,
              tokenize = 'unicode61 remove_diacritics 2',
              prefix = '2 3'
            );
            pragma user_version = ${SCHEMA};
          `);
        });
      }
      db.exec("create virtual table if not exists temp.snip using fts5 (text, tokenize = 'unicode61 remove_diacritics 2');");
      if (fresh) {
        try {
          fs.chmodSync(this.file, 0o600);
        } catch {}
      }
      return db;
    } catch (e) {
      try {
        db.close();
      } catch {}
      if (!retried && isCorrupt(e)) {
        removeFiles(this.file);
        return this.#open(true);
      }
      throw e;
    }
  }

  #q(sql: string) {
    return this.#db.prepare(sql);
  }

  cursor(scope: string): { seq: number; built: boolean } | null {
    const r = this.#q("select seq, built from cursors where scope = ?").get(scope) as { seq: number; built: number } | undefined;
    return r ? { seq: r.seq, built: r.built === 1 } : null;
  }

  setCursor(scope: string, seq: number, built: boolean): void {
    this.#q("insert into cursors (scope, seq, built) values (?, ?, ?) on conflict (scope) do update set seq = excluded.seq, built = excluded.built").run(scope, seq, built ? 1 : 0);
  }

  scopes(): string[] {
    return (this.#q("select scope from cursors").all() as { scope: string }[]).map((r) => r.scope);
  }

  upsertBatch(entries: SearchEntry[], deletes: { scope: string; kind: SearchKind; parent: string; item: string }[] = []): void {
    if (!entries.length && !deletes.length) return;
    transaction(this.#db, () => {
      const find = this.#q("select id from docs where scope = ? and kind = ? and parent = ? and item = ?");
      const delBody = this.#q("delete from body where rowid = ?");
      const delDoc = this.#q("delete from docs where id = ?");
      const insDoc = this.#q("insert into docs (scope, kind, parent, item, local_post, local_id, at, role) values (?, ?, ?, ?, ?, ?, ?, ?)");
      const updDoc = this.#q("update docs set local_post = ?, local_id = ?, at = ?, role = ? where id = ?");
      const insBody = this.#q("insert into body (rowid, text) values (?, ?)");

      for (const d of deletes) {
        const existing = find.get(d.scope, d.kind, d.parent, d.item) as { id: number } | undefined;
        if (!existing) continue;
        delBody.run(existing.id);
        delDoc.run(existing.id);
      }

      for (const e of entries) {
        const text = e.text.trim().slice(0, TEXT_MAX);
        const existing = find.get(e.scope, e.kind, e.parent, e.item) as { id: number } | undefined;
        if (!text) {
          if (existing) {
            delBody.run(existing.id);
            delDoc.run(existing.id);
          }
          continue;
        }
        if (existing) {
          delBody.run(existing.id);
          updDoc.run(e.localPost ?? null, e.localId ?? null, e.at, e.role ?? 0, existing.id);
          insBody.run(existing.id, text);
        } else {
          const res = insDoc.run(e.scope, e.kind, e.parent, e.item, e.localPost ?? null, e.localId ?? null, e.at, e.role ?? 0);
          insBody.run(Number(res.lastInsertRowid), text);
        }
      }
    });
  }

  deleteParent(parent: string): void {
    transaction(this.#db, () => {
      this.#q("delete from body where rowid in (select id from docs where parent = ?)").run(parent);
      this.#q("delete from docs where parent = ?").run(parent);
    });
  }

  deleteScope(scope: string): void {
    transaction(this.#db, () => {
      this.#q("delete from body where rowid in (select id from docs where scope = ?)").run(scope);
      this.#q("delete from docs where scope = ?").run(scope);
      this.#q("delete from cursors where scope = ?").run(scope);
    });
  }

  query(fts: string, { kinds, limit = 500 }: { kinds?: SearchKind[]; limit?: number } = {}): SearchDocRow[] {
    const kindSql = kinds?.length ? `and d.kind in (${kinds.map(() => "?").join(", ")})` : "";
    const params = kinds?.length ? [fts, limit, ...kinds] : [fts, limit];
    // Oversample from FTS5 before kind filtering when kinds are restricted so rare kinds aren't crowded out.
    const rawLimit = kinds?.length ? Math.min(limit * 4, 4000) : limit;
    params[1] = rawLimit;
    return this.#q(
      `select d.id, d.scope, d.kind, d.parent, d.item, d.local_post, d.local_id, d.at, d.role, b.rank
       from (select rowid, rank from body where body match ? order by rank limit ?) b
       join docs d on d.id = b.rowid
       where 1=1 ${kindSql}
       order by b.rank asc
       limit ?`,
    ).all(...params, limit) as unknown as SearchDocRow[];
  }

  // Distinct parent ids containing a single FTS term across the given kinds, for cross-message word intersection.
  parentsForTerm(ftsTerm: string, kinds: SearchKind[]): Set<string> {
    if (!kinds.length) return new Set();
    const rows = this.#q(
      `select distinct d.parent
       from body b
       join docs d on d.id = b.rowid
       where body match ? and d.kind in (${kinds.map(() => "?").join(", ")})`,
    ).all(ftsTerm, ...kinds) as { parent: string }[];
    return new Set(rows.map((r) => r.parent));
  }

  // Message rows matching a single FTS term, for feed search without loading cold threads into memory.
  docsForTerm(ftsTerm: string, kinds: SearchKind[], limit = 2000): SearchDocRow[] {
    if (!kinds.length) return [];
    return this.#q(
      `select d.id, d.scope, d.kind, d.parent, d.item, d.local_post, d.local_id, d.at, d.role, b.rank
       from (select rowid, rank from body where body match ? order by rank limit ?) b
       join docs d on d.id = b.rowid
       where d.kind in (${kinds.map(() => "?").join(", ")})`,
    ).all(ftsTerm, limit, ...kinds) as unknown as SearchDocRow[];
  }

  snippet(text: string, fts: string): string | null {
    if (!text || !fts) return null;
    try {
      this.#q("delete from temp.snip").run();
      this.#q("insert into temp.snip (rowid, text) values (1, ?)").run(text.slice(0, TEXT_MAX));
      const row = this.#q(`select snippet(snip, 0, '', '', ' … ', ${SNIPPET_TOKENS}) s from temp.snip where snip match ?`).get(fts) as { s: string | null } | undefined;
      const out = row?.s?.trim();
      return out || null;
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.#db.close();
    } catch {}
  }
}
