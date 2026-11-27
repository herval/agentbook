// Each dashboard panel's last answer, kept (server/dashboards.ts): one row per panel per view, for exactly what the
// panel asks (`def`), from the connector that answered (`conn`), marked when it's the dashboard's own view (`own`),
// with when it came (`at`) and when someone last looked (`used`, ms). storage.use(DashboardTables).

import type { DatabaseSync } from "../../plugin/shared/storage/sqlite.ts";

// A row of panel_kept: `own` is 1 for the dashboard's own view, and `answer` is as stored (dashboards.ts's pack).
interface KeptRow {
  page: string;
  panel: string;
  view: string;
  def: string;
  conn: string | null;
  own: number;
  at: string;
  used: number;
  answer: string;
}
// A panel's answer for a view, as it's kept (keep).
export interface PanelKept {
  page: string;
  panel: string;
  view: string;
  def: string;
  conn?: string | null;
  own?: boolean;
  at: string;
  used?: number;
  answer: string;
}

export class DashboardTables {
  static id = "dashboards";
  static schema = ["create table panel_kept (page text not null, panel text not null, view text not null, def text not null, conn text, own integer not null default 0, at text not null, used integer not null, answer text not null, primary key (page, panel, view))"];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // A panel's kept answer for a view, if it's for what the panel asks now: { at, answer } (as stored), or null.
  kept(page: string, panel: string, view: string, def: string): Pick<KeptRow, "at" | "answer"> | null {
    const r = this.#db.prepare("select at, answer from panel_kept where page = ? and panel = ? and view = ? and def = ?").get(page, panel, view, def) as Pick<KeptRow, "at" | "answer"> | undefined;
    return r ? { at: r.at, answer: r.answer } : null;
  }
  // Someone looked at a panel's view (`used`: when, in ms).
  touch(page: string, panel: string, view: string, used = Date.now()): void {
    this.#db.prepare("update panel_kept set used = ? where page = ? and panel = ? and view = ?").run(used, page, panel, view);
  }
  keep({ page, panel, view, def, conn = null, own = false, at, used = Date.now(), answer }: PanelKept): void {
    this.#db.prepare("insert into panel_kept (page, panel, view, def, conn, own, at, used, answer) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (page, panel, view) do update set def = excluded.def, conn = excluded.conn, own = excluded.own, at = excluded.at, used = excluded.used, answer = excluded.answer").run(page, panel, view, def, conn, own ? 1 : 0, at, used, answer);
  }
  // Of a panel's other views (not its dashboard's own) for what it asks now (`def`), only the `n` looked at last stay.
  // What it asked before isn't touched: that goes when its dashboard is written (tidy), as a test run of a query that
  // isn't saved yet mustn't take the dashboard's own answers away.
  keepLatest(page: string, panel: string, def: string, n: number): void {
    this.#db.prepare("delete from panel_kept where page = ? and panel = ? and def = ? and own = 0 and view not in (select view from panel_kept where page = ? and panel = ? and def = ? and own = 0 order by used desc limit ?)").run(page, panel, def, page, panel, def, n);
  }
  // A panel's view's answer, gone.
  drop(page: string, panel: string, view: string): void {
    this.#db.prepare("delete from panel_kept where page = ? and panel = ? and view = ?").run(page, panel, view);
  }
  // Whether a panel's view is its dashboard's own.
  setOwn(page: string, panel: string, view: string, own: boolean): void {
    this.#db.prepare("update panel_kept set own = ? where page = ? and panel = ? and view = ?").run(own ? 1 : 0, page, panel, view);
  }
  ownOf(page: string): Pick<KeptRow, "panel" | "view" | "def" | "at" | "answer">[] {
    return (this.#db.prepare("select panel, view, def, at, answer from panel_kept where page = ? and own = 1").all(page) as Pick<KeptRow, "panel" | "view" | "def" | "at" | "answer">[]).map((r) => ({ ...r }));
  }
  // What a dashboard has kept, without the answers: [{ panel, view, def, own (true or false) }].
  viewsOf(page: string): { panel: string; view: string; def: string; own: boolean }[] {
    return (this.#db.prepare("select panel, view, def, own from panel_kept where page = ?").all(page) as Pick<KeptRow, "panel" | "view" | "def" | "own">[]).map((r) => ({ panel: r.panel, view: r.view, def: r.def, own: !!r.own }));
  }
  // The dashboards that have answers kept, by id.
  pages(): string[] {
    return (this.#db.prepare("select distinct page from panel_kept").all() as Pick<KeptRow, "page">[]).map((r) => r.page);
  }
  // A dashboard's kept answers, every one, gone.
  dropPage(page: string): void {
    this.#db.prepare("delete from panel_kept where page = ?").run(page);
  }
  // Other views (not a dashboard's own) nobody's looked at since `before` (ms), gone.
  dropUnused(before: number): void {
    this.#db.prepare("delete from panel_kept where own = 0 and used < ?").run(before);
  }
  // What a connector answered, gone.
  dropConnector(conn: string): void {
    this.#db.prepare("delete from panel_kept where conn = ?").run(conn);
  }
  // How much is kept: { rows, bytes } (the answers' length, as stored).
  size(): { rows: number; bytes: number } {
    const r = this.#db.prepare("select count(*) as rows, coalesce(sum(length(answer)), 0) as bytes from panel_kept").get() as { rows: number; bytes: number };
    return { rows: r.rows, bytes: r.bytes };
  }
}
