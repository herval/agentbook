// What agentbook-cli keeps of its link to its server (plugin/cli/uplink.ts), under its store's scope: commands it
// did, with their answers, so one the server sends again (its answer was lost) isn't done twice; and ops too big for
// its server even alone, left out so what comes after them goes. storage.use(UplinkTables, scope).

import { scoped } from "./sqlite.ts";
import type { DatabaseSync } from "./sqlite.ts";

// An op left out for being too big: its number, kind, post, size and when.
export type TooBig = {
  seq: number;
  kind: string;
  post: string | null;
  bytes: number;
  at: string;
};

export class UplinkTables {
  static id = "uplink";
  static schema = [
    [
      scoped("commands_done", "cid text not null, result text, at text not null", "cid"),
      scoped("too_big", "seq integer not null, kind text not null, post text, bytes integer not null, at text not null", "seq"),
    ].join("\n"),
  ];

  #db: DatabaseSync;
  #scope: string;
  constructor(db: DatabaseSync, scope = "cli") {
    this.#db = db;
    this.#scope = scope;
  }

  // A command's answer as it was kept (JSON), or undefined when it wasn't done here.
  doneResult(cid: string): string | null | undefined {
    const r = this.#db.prepare("select result from commands_done where scope = ? and cid = ?").get(this.#scope, cid) as { result: string | null } | undefined;
    return r ? r.result : undefined;
  }
  markDone(cid: string, json: string | null, at = new Date().toISOString()): void {
    this.#db.prepare("insert into commands_done (scope, cid, result, at) values (?, ?, ?, ?) on conflict (scope, cid) do update set result = excluded.result").run(this.#scope, cid, json, at);
  }
  // Ops left out: { seq, kind, post, bytes, at }, oldest first.
  tooBig(): TooBig[] {
    return (this.#db.prepare("select seq, kind, post, bytes, at from too_big where scope = ? order by seq").all(this.#scope) as TooBig[]).map((r) => ({ ...r }));
  }
  keepTooBig({ seq, kind, post = null, bytes, at }: { seq: number; kind: string; post?: string | null; bytes: number; at: string }): void {
    this.#db.prepare("insert or replace into too_big (scope, seq, kind, post, bytes, at) values (?, ?, ?, ?, ?, ?)").run(this.#scope, seq, kind, post, bytes, at);
  }
  // Commands done before `done`, and ops left out before `tooBig` (ISO times), forgotten.
  forget({ done, tooBig }: { done: string; tooBig: string }): void {
    this.#db.prepare("delete from commands_done where scope = ? and at < ?").run(this.#scope, done);
    this.#db.prepare("delete from too_big where scope = ? and at < ?").run(this.#scope, tooBig);
  }
}
