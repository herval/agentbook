// The machines of yours this one is linked to (server/mesh.ts): each one's id on the relay (`machine`), its key, by
// which this machine dials it over iroh and takes its calls (plugin/shared/iroh.ts), and its page's address as
// browsers open it (`site`, for Machines and Sign once), if anywhere. A machine on your account links to each other one
// the relay lists, by its certificate. The page writes them (on a machine with no page, its daemon: plugin/cli/mesh.ts);
// the daemon reads them, and sends its threads to each one with a page over iroh (plugin/cli/main.ts).
// storage.use(PeerTables).
//
// `meshChanged`: said within the process when a machine is linked or unlinked, so the daemon serving this page starts
// or stops sending to it at once. One for the whole process, whichever copy of this file the page was loaded from.

import { EventEmitter } from "node:events";
import { transaction, type DatabaseSync } from "./sqlite.ts";
import type { Iso } from "../types.ts";

// (A type, not an interface: a row node:sqlite reads is cast to it.)
export type PeerRow = {
  name: string;
  // Its id on the relay; null for one linked with a code, before machines were the relay's (dropped as the page starts).
  machine: string | null;
  // Null for one linked before your machines met over iroh: linked again over iroh as the page starts.
  key: string | null;
  site: string | null;
  added: Iso;
};

export const meshChanged: EventEmitter = ((globalThis as { [k: symbol]: EventEmitter })[Symbol.for("agentbook.mesh")] ??= new EventEmitter());

export class PeerTables {
  static id = "peers";
  // peers: by the machine's name. (Version 1 also had peer_codes, the codes `agentbook link` made, gone with them.)
  static schema = [
    "create table peers (name text primary key, url text not null, token text not null, added text not null); create table peer_codes (hash text primary key, user_id text not null, made text not null, expires text not null, used text, device text, peered text)",
    "create table peers_new (name text primary key, machine text unique, url text, token text, added text not null); insert into peers_new (name, url, token, added) select name, url, token, added from peers; drop table peers; alter table peers_new rename to peers; drop table peer_codes",
    "alter table peers add column key text; alter table peers add column site text",
    // Over iroh only: no address to reach it at, no token. A page's address as it said it
    // is kept as its site where there's none.
    "create table peers_new (name text primary key, machine text unique, key text, site text, added text not null); insert into peers_new (name, machine, key, site, added) select name, machine, key, coalesce(site, url), added from peers; drop table peers; alter table peers_new rename to peers",
  ];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // Every machine this one is linked to, the first linked first.
  list(): PeerRow[] {
    return (this.#db.prepare("select * from peers order by added, name").all() as PeerRow[]).map((r) => ({ ...r }));
  }
  get(name: string): PeerRow | null {
    const r = this.#db.prepare("select * from peers where name = ?").get(name) as PeerRow | undefined;
    return r ? { ...r } : null;
  }
  // The one linked over iroh with `key`: a call over iroh from that key is that machine's (server/api/cli.ts).
  byKey(key: string): PeerRow | null {
    const r = this.#db.prepare("select * from peers where key = ?").get(key) as PeerRow | undefined;
    return r ? { ...r } : null;
  }
  byMachine(machine: string): PeerRow | null {
    const r = this.#db.prepare("select * from peers where machine = ?").get(machine) as PeerRow | undefined;
    return r ? { ...r } : null;
  }
  // A machine linked, or linked again (a new name, key or site): it keeps when it was first linked. One with the same
  // relay id under another name (renamed) is that machine, and so is one by that name linked before machines were the
  // relay's. `site` left out stays as it was.
  put({ name, machine = null, key, site, added = new Date().toISOString() }: { name: string; machine?: string | null; key: string; site?: string | null; added?: Iso }): void {
    transaction(this.#db, () => {
      const was = (machine ? this.byMachine(machine) : null) ?? this.get(name);
      if (was && was.name !== name) this.#db.prepare("delete from peers where name = ?").run(was.name);
      this.#db
        .prepare("insert into peers (name, machine, key, site, added) values (?, ?, ?, ?, ?) on conflict (name) do update set machine = coalesce(excluded.machine, machine), key = excluded.key, site = excluded.site")
        .run(name, machine, key, site === undefined ? (was?.site ?? null) : site, was?.added ?? added);
    });
  }
  remove(name: string): boolean {
    return Number(this.#db.prepare("delete from peers where name = ?").run(name).changes) > 0;
  }
}
