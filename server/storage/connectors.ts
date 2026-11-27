// The page's connectors (server/integrations/connectors.ts), in the order they were added, their keys sealed.
// storage.use(ConnectorTables).
//
// A row: { id, ord, data, api_key, refresh_token, app_key }. data: the connector but for its id and secrets, as JSON.

import type { DatabaseSync } from "../../plugin/shared/storage/sqlite.ts";

// (A type, not an interface: a row node:sqlite reads is cast to it.)
export type ConnectorRow = {
  id: string;
  ord: number;
  data: string;
  api_key: string | null;
  refresh_token: string | null;
  app_key: string | null;
};

export class ConnectorTables {
  static id = "connectors";
  // ord: the order they were added in. api_key, app_key: sealed, or a "$NAME" from agentbook's environment.
  static schema = ["create table connectors (id text primary key, ord integer not null, data text not null, api_key text, refresh_token text, app_key text)"];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // Every connector's row, in the order they were added.
  all(): ConnectorRow[] {
    return (this.#db.prepare("select * from connectors order by ord").all() as ConnectorRow[]).map((r) => ({ ...r }));
  }
  // One connector's row, or null.
  get(id: string): ConnectorRow | null {
    const r = this.#db.prepare("select * from connectors where id = ?").get(id) as ConnectorRow | undefined;
    return r ? { ...r } : null;
  }
  // The ids of those kept.
  ids(): string[] {
    return (this.#db.prepare("select id from connectors").all() as { id: string }[]).map((r) => r.id);
  }
  // A connector kept, with its keys as given (sealed already): a new one after the others, one already here in its
  // place, all but its place written over.
  put({ id, data, api_key = null, refresh_token = null, app_key = null }: Omit<ConnectorRow, "ord" | "api_key" | "refresh_token" | "app_key"> & Partial<Pick<ConnectorRow, "api_key" | "refresh_token" | "app_key">>): void {
    const ord = (this.#db.prepare("select coalesce(max(ord), 0) + 1 n from connectors").get() as { n: number }).n;
    this.#db.prepare("insert into connectors (id, ord, data, api_key, refresh_token, app_key) values (?, ?, ?, ?, ?, ?) on conflict (id) do update set data = excluded.data, api_key = excluded.api_key, refresh_token = excluded.refresh_token, app_key = excluded.app_key").run(id, ord, data, api_key, refresh_token, app_key);
  }
  remove(id: string): void {
    this.#db.prepare("delete from connectors where id = ?").run(id);
  }
}
