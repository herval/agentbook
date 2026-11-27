// A thread's work (its steps, pictures, changes), under its store's scope: what agentbook-cli sent its server of each
// post's work (work_sent, plugin/cli/work.ts), and what the page keeps of a machine's posts' work (work_steps, work;
// server/work.ts). storage.use(WorkTables, scope).

import { scoped, transaction } from "./sqlite.ts";
import type { DatabaseSync } from "./sqlite.ts";

// What agentbook-cli sent its server of a post's work (plugin/cli/work.ts): its steps, its plan, its turn, its
// pictures and its changes, each as it was sent, so only what changed goes next time.
export interface WorkSent {
  steps: string[];
  plan: string | null;
  turn: number | null;
  images: Record<string, number>;
  changes: Record<string, string>;
  changesAt?: string;
}

export class WorkTables {
  static id = "work";
  static schema = [
    [
      scoped("work_sent", "post text not null, data text not null", "post"),
      scoped("work_steps", "post text not null, i integer not null, data text not null", "post, i"),
      scoped("work", "post text not null, key text not null, data text not null, at text not null", "post, key"),
    ].join("\n"),
  ];

  #db: DatabaseSync;
  #scope: string;
  constructor(db: DatabaseSync, scope = "cli") {
    this.#db = db;
    this.#scope = scope;
  }
  #q(sql: string) {
    return this.#db.prepare(sql);
  }

  /* ---------- what agentbook-cli sent of a post's work (work_sent) ---------- */

  // What was sent of a post's work, as it was kept, or null when nothing was.
  sent(post: string): WorkSent | null {
    const r = this.#q("select data from work_sent where scope = ? and post = ?").get(this.#scope, post) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  keepSent(post: string, sent: WorkSent): void {
    this.#q("insert into work_sent (scope, post, data) values (?, ?, ?) on conflict (scope, post) do update set data = excluded.data").run(this.#scope, post, JSON.stringify(sent));
  }
  sentPosts(): string[] {
    return (this.#q("select post from work_sent where scope = ?").all(this.#scope) as { post: string }[]).map((r) => r.post);
  }
  // What was sent of a post's work forgotten, or of every post's (no `post`): it's all sent again.
  forgetSent(post: string | null = null): void {
    if (post === null) this.#q("delete from work_sent where scope = ?").run(this.#scope);
    else this.#q("delete from work_sent where scope = ? and post = ?").run(this.#scope, post);
  }

  /* ---------- what the page keeps of a post's work (work_steps, work) ---------- */

  // A post's steps from `from` on, and its plan and turn: the steps it had past them, or past `total`, go. All or
  // none.
  saveSteps(post: string, { from = 0, total = 0, steps = [], plan = null, turn = 0 }: { from?: number; total?: number; steps?: unknown[]; plan?: unknown; turn?: number }, at = new Date().toISOString()): void {
    transaction(this.#db, () => {
      this.#q("delete from work_steps where scope = ? and post = ? and (i >= ? or i >= ?)").run(this.#scope, post, from, total);
      const add = this.#q("insert into work_steps (scope, post, i, data) values (?, ?, ?, ?) on conflict (scope, post, i) do update set data = excluded.data");
      steps.forEach((s, k) => add.run(this.#scope, post, from + k, JSON.stringify(s)));
      this.saveWork(post, "plan", { plan, turn }, at);
    });
  }
  steps(post: string): unknown[] {
    return (this.#q("select data from work_steps where scope = ? and post = ? order by i").all(this.#scope, post) as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  // The rest of a post's work, by key ("plan", "images:<step>", "picture:<url>", "changes:<scope>"): written over.
  saveWork(post: string, key: string, data: unknown, at = new Date().toISOString()): void {
    this.#q("insert into work (scope, post, key, data, at) values (?, ?, ?, ?, ?) on conflict (scope, post, key) do update set data = excluded.data, at = excluded.at").run(this.#scope, post, key, JSON.stringify(data), at);
  }
  // One of it: { data, at }, or null.
  work(post: string, key: string): { data: unknown; at: string } | null {
    const r = this.#q("select data, at from work where scope = ? and post = ? and key = ?").get(this.#scope, post, key) as { data: string; at: string } | undefined;
    return r ? { data: JSON.parse(r.data), at: r.at } : null;
  }
  // Every post's, whose key starts with `prefix` ("images:"): their data.
  workWith(prefix: string): unknown[] {
    return (this.#q("select data from work where scope = ? and substr(key, 1, ?) = ?").all(this.#scope, prefix.length, prefix) as { data: string }[]).map((r) => JSON.parse(r.data));
  }
}
