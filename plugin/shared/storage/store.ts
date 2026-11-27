// A store's tables (plugin/shared/store.ts): its log, its state, its settings, under its scope (this machine's "cli",
// its page's "server", the page's copy of a machine "device:<id>"). Storage hands one out per scope:
// storage.store(scope).
//
// Each store works on its state in memory, and every change is an op. The tables keep both halves:
// - `events`: every op, written as it's committed, so nothing is lost if the process dies.
// - one table per kind of thing (agents, sessions, messages, files…): the state, written as a checkpoint every few
//   seconds and when the process exits, along with the last op it includes (`meta.checkpoint`).
// Starting up loads the tables, then replays the ops after the checkpoint. Rows keep what queries need in columns
// (post, owner, visibility) and the whole thing as JSON in `data`. A row goes only when what it keeps does: a
// thread's history out of memory (store.ts) keeps its rows.

import { index, scoped, transaction } from "./sqlite.ts";
import type { DatabaseSync, SQLInputValue } from "./sqlite.ts";
import type { AgentFollow, State } from "../types.ts";

// The parts of a store's state its tables keep: all but `seq`, and those only agentbook-server's own store has.
export type StorePart = Exclude<{ [K in keyof State]-?: {} extends Pick<State, K> ? never : K }[keyof State], "seq">;
type Item<V> = V extends (infer X)[] ? X : V extends Record<string, infer X> ? X : never;
// How a part is kept: `keyed` (an object by id; else a list, in order), `plain` (procs, a column each), `ordered` (a
// keyed part kept in order too), `paged` (a thread's history, which can be out of memory), `newestFirst`,
// `immutable` (a record that never changes once made); a list item's id (`idOf`, else its `id`), and the columns
// queries need besides the record as JSON.
interface PartSpec<X> {
  keyed?: boolean;
  plain?: boolean;
  ordered?: boolean;
  paged?: boolean;
  newestFirst?: boolean;
  immutable?: boolean;
  idOf?(x: X): string;
  columns?(x: X): Record<string, SQLInputValue>;
}
// The owner column of a table whose records don't say one (agents, threads, files): null unless one does.
type Owned = { owner?: string | null };
// A row as a part's table has it.
type Row = {
  id: string;
  post?: string | null;
  proc?: string;
  ord: number | null;
  data: string;
};
// A part's items, as #rows reads them.
interface PagedRow {
  id: string;
  x: object;
  data: string;
}

// How each part of the state maps to a table. Keyed parts are objects by id; listed parts are arrays,
// kept in order with `ord` (files are newest first). A thread's history (`paged`: its questions, files and
// messages) can be out of memory while its rows stay (pageOut), and back (pageIn).
const PARTS: { [K in StorePart]: PartSpec<Item<State[K]>> } = {
  agents: { keyed: true, columns: (a: Item<State["agents"]> & Owned) => ({ owner: a.owner ?? null }) },
  sessions: { keyed: true, columns: (s: Item<State["sessions"]> & Owned) => ({ agent: s.agent ?? null, owner: s.owner ?? null, visibility: s.visibility ?? null, updated: s.updated ?? null }) },
  procs: { keyed: true, plain: true },
  launches: { keyed: true, ordered: true, columns: (l) => ({ post: l.post ?? null }) },
  questions: { paged: true, columns: (q) => ({ post: q.post ?? null }) },
  todos: { columns: (t) => ({ post: t.post ?? null }) },
  files: { paged: true, newestFirst: true, columns: (f: Item<State["files"]> & Owned) => ({ post: f.post ?? null, owner: f.owner ?? null }) },
  messages: { paged: true, columns: (m) => ({ post: m.post ?? null }) },
  outbox: { idOf: (o) => o.oid, columns: (o) => ({ post: o.post ?? null, delivered: o.delivered ? 1 : 0 }) },
  workspaces: { keyed: true, ordered: true, columns: (w) => ({ owner: w.owner ?? null }) },
  tasks: { keyed: true, columns: (t) => ({ owner: t.owner ?? null }) },
  pages: { keyed: true, columns: (p) => ({ visibility: p.visibility ?? null, updated: p.updated ?? null }) },
  // A version never changes once made, so a checkpoint skips the ones it wrote already.
  page_versions: { immutable: true, columns: (v) => ({ page: v.page }) },
  routines: { keyed: true, columns: (r) => ({ page: r.page ?? null }) },
  routine_code: { columns: (c) => ({ routine: c.routine }) },
  routine_runs: { immutable: true, columns: (x) => ({ routine: x.routine }) },
  groups: { keyed: true, columns: (g) => ({ updated: g.updated ?? null }) },
  group_notes: { columns: (n) => ({ grp: n.group }) },
  // A file's version and a line in a group's feed never change once made.
  group_files: { immutable: true, columns: (v) => ({ grp: v.group }) },
  group_events: { immutable: true, columns: (e) => ({ grp: e.group }) },
  group_posts: { keyed: true, columns: (m) => ({ grp: m.group ?? null }) },
  notes: { keyed: true, columns: (n) => ({ owner: n.owner ?? null, updated: n.updated ?? null }) },
  // A version never changes once made (a sitting's next edit makes a new one in its place).
  note_versions: { immutable: true, columns: (v) => ({ note: v.note }) },
  thread_guests: { keyed: true, columns: (g) => ({ host: g.host ?? null }) },
  thread_seen: { keyed: true },
  talks: { keyed: true, columns: (t) => ({ owner: t.owner ?? null, updated: t.updated ?? null }) },
  wip_sets: { keyed: true, columns: (w) => ({ owner: w.owner ?? null, updated: w.updated ?? null }) },
  page_posts: { keyed: true, columns: (m) => ({ page: m.page ?? null }) },
  // A follow, or the mark follows.seed left (under "seeded"), which has no agent.
  agent_follows: { keyed: true, columns: (f: Partial<AgentFollow>) => ({ agent: f.agent ?? null, follower: f.user ?? null }) },
  person_follows: { keyed: true, columns: (f) => ({ person: f.person ?? null, follower: f.user ?? null }) },
  contacts: { keyed: true, columns: (c) => ({ a: c.a ?? null, b: c.b ?? null }) },
  thread_people: { keyed: true },
  // By person: the pages whose latest update they archived, and when each had last moved up the feed.
  feed_archived: { keyed: true },
  // By machine: the cloud sandbox it runs in, and the connector of its owner's that wakes it.
  machine_cloud: { keyed: true },
  images: { keyed: true, columns: (i) => ({ owner: i.owner ?? null }) },
  image_builds: { keyed: true, columns: (b) => ({ image: b.image ?? null }) },
  // By the machine that's shared (its owner's): the people on it.
  boxes: { keyed: true, columns: (b) => ({ owner: b.owner ?? null }) },
};

export class StoreTables {
  static id = "store";
  // One entry per version. Before storage.db, each store had a database of its own (agentbook.db, devices/<id>.db)
  // with the same tables and no scope; Storage.adopt folds one in.
  static schema = [
    [
      scoped("meta", "key text not null, value text", "key"),
      scoped("events", "seq integer not null, at text not null, op text not null", "seq"),
      scoped("agents", "id text not null, owner text, data text not null"),
      scoped("sessions", "id text not null, agent text, owner text, visibility text, updated text, data text not null"),
      scoped("procs", "proc text not null, post text not null", "proc"),
      scoped("launches", "id text not null, post text, ord integer not null, data text not null"),
      scoped("questions", "id text not null, post text, ord integer not null, data text not null"),
      scoped("todos", "id text not null, post text, ord integer not null, data text not null"),
      scoped("files", "id text not null, post text, owner text, ord integer not null, data text not null"),
      scoped("messages", "id text not null, post text, ord integer not null, data text not null"),
      scoped("outbox", "id text not null, post text, delivered integer, ord integer not null, data text not null"),
      scoped("workspaces", "id text not null, owner text, ord integer not null, data text not null"),
      scoped("tasks", "id text not null, owner text, data text not null"),
      scoped("pages", "id text not null, visibility text, updated text, data text not null"),
      scoped("page_versions", "id text not null, page text not null, ord integer not null, data text not null"),
      scoped("routines", "id text not null, page text, data text not null"),
      scoped("routine_code", "id text not null, routine text not null, ord integer not null, data text not null"),
      scoped("routine_runs", "id text not null, routine text not null, ord integer not null, data text not null"),
      scoped("groups", "id text not null, updated text, data text not null"),
      scoped("group_notes", "id text not null, grp text not null, ord integer not null, data text not null"),
      scoped("group_files", "id text not null, grp text not null, ord integer not null, data text not null"),
      scoped("group_events", "id text not null, grp text not null, ord integer not null, data text not null"),
      scoped("group_posts", "id text not null, grp text, data text not null"),
      scoped("notes", "id text not null, owner text, updated text, data text not null"),
      scoped("note_versions", "id text not null, note text not null, ord integer not null, data text not null"),
      scoped("thread_guests", "id text not null, host text, data text not null"),
      scoped("thread_seen", "id text not null, data text not null"),
      scoped("talks", "id text not null, owner text, updated text, data text not null"),
      scoped("wip_sets", "id text not null, owner text, updated text, data text not null"),
      scoped("page_posts", "id text not null, page text, data text not null"),
      scoped("agent_follows", "id text not null, agent text, follower text, data text not null"),
      scoped("person_follows", "id text not null, person text, follower text, data text not null"),
      scoped("feed_archived", "id text not null, data text not null"),
      scoped("machine_cloud", "id text not null, data text not null"),
      scoped("images", "id text not null, owner text, data text not null"),
      scoped("image_builds", "id text not null, image text, data text not null"),
      scoped("boxes", "id text not null, owner text, data text not null"),
      index("sessions_agent", "sessions", "agent"),
      index("messages_post", "messages", "post, ord"),
      index("questions_post", "questions", "post"),
      index("files_post", "files", "post"),
      index("outbox_post", "outbox", "post, delivered"),
      index("workspaces_owner", "workspaces", "owner"),
      index("tasks_owner", "tasks", "owner"),
      index("page_versions_page", "page_versions", "page, ord"),
      index("routine_code_routine", "routine_code", "routine, ord"),
      index("routine_runs_routine", "routine_runs", "routine, ord"),
      index("group_notes_grp", "group_notes", "grp, ord"),
      index("group_files_grp", "group_files", "grp, ord"),
      index("group_events_grp", "group_events", "grp, ord"),
      index("notes_owner", "notes", "owner"),
      index("note_versions_note", "note_versions", "note, ord"),
      index("thread_guests_host", "thread_guests", "host"),
      index("talks_owner", "talks", "owner"),
      index("wip_sets_owner", "wip_sets", "owner"),
      index("agent_follows_agent", "agent_follows", "agent"),
      index("person_follows_person", "person_follows", "person"),
      index("image_builds_image", "image_builds", "image"),
    ].join("\n"),
    // Contacts and the people on a thread.
    [scoped("contacts", "id text not null, a text, b text, data text not null"), index("contacts_a", "contacts", "a"), index("contacts_b", "contacts", "b"), scoped("thread_people", "id text not null, data text not null")].join("\n"),
  ];

  #db: DatabaseSync;
  #scope: string;
  #written = new Map<string, string>(); // "part id" -> the JSON last written
  #ords = new WeakMap<object, number>(); // a list item -> its place
  #nextOrd = 1;

  constructor(db: DatabaseSync, scope = "cli") {
    this.#db = db;
    this.#scope = scope;
  }
  get scope(): string {
    return this.#scope;
  }

  #ordOf(x: object): number {
    if (!this.#ords.has(x)) this.#ords.set(x, this.#nextOrd++);
    return this.#ords.get(x);
  }
  #q(sql: string) {
    return this.#db.prepare(sql);
  }

  // A setting of its own (seq, checkpoint, acked, pruned, epoch, machine…), or null.
  meta(key: string): string | null {
    return (this.#q("select value from meta where scope = ? and key = ?").get(this.#scope, key) as { value: string | null } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string | number): void {
    this.#q("insert into meta (scope, key, value) values (?, ?, ?) on conflict (scope, key) do update set value = excluded.value").run(this.#scope, key, String(value));
  }

  load(): { state: Pick<State, StorePart>; seq: number; checkpoint: number } {
    const db = this.#db;
    const scope = this.#scope;
    const state: Pick<State, StorePart> = { agents: {}, sessions: {}, procs: {}, launches: {}, questions: [], todos: [], files: [], messages: [], outbox: [], workspaces: {}, tasks: {}, pages: {}, page_versions: [], routines: {}, routine_code: [], routine_runs: [], groups: {}, group_notes: [], group_files: [], group_events: [], group_posts: {}, notes: {}, note_versions: [], thread_guests: {}, thread_seen: {}, talks: {}, wip_sets: {}, page_posts: {}, agent_follows: {}, person_follows: {}, contacts: {}, thread_people: {}, feed_archived: {}, machine_cloud: {}, images: {}, image_builds: {}, boxes: {} };
    for (const [part, spec] of Object.entries(PARTS)) {
      const rows = db.prepare(spec.plain ? `select proc, post from ${part} where scope = ? order by rowid` : `select id, ${spec.keyed && !spec.ordered ? "null as ord" : "ord"}, data from ${part} where scope = ? ${spec.keyed && !spec.ordered ? "order by rowid" : `order by ord ${spec.newestFirst ? "desc" : "asc"}`}`).all(scope) as Row[];
      for (const r of rows) {
        if (spec.plain) {
          state.procs[r.proc] = r.post;
          this.#written.set(`procs ${r.proc}`, JSON.stringify(r.post));
          continue;
        }
        const x = JSON.parse(r.data);
        if (r.ord != null) {
          this.#ords.set(x, r.ord);
          this.#nextOrd = Math.max(this.#nextOrd, r.ord + 1);
        }
        if (spec.keyed) state[part][r.id] = x;
        else state[part].push(x);
        this.#written.set(`${part} ${r.id}`, r.data);
      }
    }
    return { state, seq: Number(this.meta("seq") || 0), checkpoint: Number(this.meta("checkpoint") || 0) };
  }

  // Whether it has nothing yet: no checkpoint, no op.
  empty(): boolean {
    return !this.meta("checkpoint") && !this.#q("select 1 from events where scope = ? limit 1").get(this.#scope);
  }

  log(op: { seq: number; at: string }): void {
    this.#q("insert or ignore into events (scope, seq, at, op) values (?, ?, ?, ?)").run(this.#scope, op.seq, op.at, JSON.stringify(op));
  }
  // Ops, in its log, all or none.
  logAll(ops: { seq: number; at: string }[]): void {
    transaction(this.#db, () => ops.forEach((op) => this.log(op)));
  }
  // The ops after `seq`, oldest first (to replay over what load() returned, or to send its server).
  since(seq: number) {
    return (this.#q("select op from events where scope = ? and seq > ? order by seq").all(this.#scope, seq) as { op: string }[]).map((r) => JSON.parse(r.op));
  }
  // Its ops whose JSON has `text` (a key and its value, as JSON writes them: '"t":"routine.remove"'), oldest first:
  // { seq, at, op } with `op` parsed.
  opsWith(text: string) {
    return (this.#q("select seq, at, op from events where scope = ? and instr(op, ?) > 0 order by seq").all(this.#scope, String(text)) as { seq: number; at: string; op: string }[]).map((r) => ({ seq: r.seq, at: r.at, op: JSON.parse(r.op) }));
  }
  // The highest of a field its ops have (a machine's own seq, `cli`, on the ops its page took in from it), or 0.
  highest(field: string): number {
    if (!/^\w+$/.test(field)) throw new Error(`${field} isn't an op's field`);
    return (this.#q(`select max(json_extract(op, '$.${field}')) n from events where scope = ?`).get(this.#scope) as { n: number | null } | undefined)?.n || 0;
  }
  // Ops up to `seq` of these kinds (`t`), gone from its log: what its server keeps from then on. -> how many
  dropOps(seq: number, kinds: string[]): number {
    if (!kinds.length) return 0;
    return Number(this.#q(`delete from events where scope = ? and seq <= ? and json_extract(op, '$.t') in (${kinds.map(() => "?").join(", ")})`).run(this.#scope, seq, ...kinds).changes);
  }
  // Whether an op about a file is in its log after `seq`: the one that made it (`f<seq>`, or one with its id) or
  // the one that said its server has its bytes.
  fileOpAfter(seq: number, fid: string): boolean {
    return !!this.#q(`select 1 from events where scope = ? and seq > ? and (
      (json_extract(op, '$.t') = 'file.blob' and json_extract(op, '$.fid') = ?)
      or (json_extract(op, '$.t') = 'file.add' and (json_extract(op, '$.fid') = ? or 'f' || seq = ?))) limit 1`).get(this.#scope, seq, fid, fid, fid);
  }

  // Its state written: only what changed since the last one. What it writes and deletes is kept apart (`wrote`,
  // `gone`) until it commits: one that rolls back (a full disk, a record that can't be written) wrote nothing, so the
  // next one writes all of it again rather than skip what this one only meant to write, and take the checkpoint past
  // it. -> how many rows changed
  // `state`: a store's; a part it lacks is empty.
  checkpoint(state: Pick<State, "seq"> & Partial<State>): number {
    const db = this.#db;
    const scope = this.#scope;
    const written = this.#written;
    let changes = 0;
    const wrote = new Map<string, string>();
    const gone = new Set<string>();
    const last = (key: string) => (wrote.has(key) ? wrote.get(key) : written.get(key));
    transaction(db, () => {
      const seen = new Set<string>();
      for (const [part, spec] of Object.entries(PARTS)) {
        const items = spec.keyed ? Object.entries(state[part] || {}) : (state[part] || []).map((x) => [spec.idOf ? spec.idOf(x) : x.id, x]);
        // Order list items oldest first, so new ones get later places (files are kept newest first).
        if (spec.newestFirst) items.reverse();
        for (const [id, x] of items) {
          const key = `${part} ${id}`;
          seen.add(key);
          if (spec.immutable && last(key) !== undefined) continue;
          const json = JSON.stringify(x);
          if (last(key) === json) continue;
          if (spec.plain) db.prepare("insert into procs (scope, proc, post) values (?, ?, ?) on conflict (scope, proc) do update set post = excluded.post").run(scope, id, x);
          else {
            const cols = { ...(spec.columns ? spec.columns(x) : {}), ...(spec.keyed && !spec.ordered ? {} : { ord: this.#ordOf(x) }) };
            const names = Object.keys(cols);
            db.prepare(`insert into ${part} (scope, id, ${names.join(", ")}${names.length ? ", " : ""}data) values (?, ?, ${names.map(() => "?").join(", ")}${names.length ? ", " : ""}?) on conflict (scope, id) do update set ${[...names, "data"].map((n) => `${n} = excluded.${n}`).join(", ")}`).run(scope, id, ...names.map((n) => cols[n]), json);
          }
          wrote.set(key, json);
          changes++;
        }
      }
      for (const key of written.keys()) {
        if (seen.has(key)) continue;
        const [part, ...rest] = key.split(" ");
        const id = rest.join(" ");
        db.prepare(`delete from ${part} where scope = ? and ${part === "procs" ? "proc" : "id"} = ?`).run(scope, id);
        gone.add(key);
        changes++;
      }
      this.setMeta("seq", state.seq);
      this.setMeta("checkpoint", state.seq);
    });
    for (const [key, json] of wrote) written.set(key, json);
    for (const key of gone) written.delete(key);
    return changes;
  }

  // Ops already in a checkpoint and older than `days` aren't needed to rebuild anything. The last one it took is kept
  // (`meta.pruned`), so a machine's store knows how far back its log still goes.
  prune(seq: number, days = 30): number {
    const before = new Date(Date.now() - days * 86400e3).toISOString();
    const upTo = (this.#q("select max(seq) n from events where scope = ? and seq <= ? and at < ?").get(this.#scope, seq, before) as { n: number | null } | undefined)?.n;
    const changes = Number(this.#q("delete from events where scope = ? and seq <= ? and at < ?").run(this.#scope, seq, before).changes);
    if (changes && upTo > Number(this.meta("pruned") || 0)) this.setMeta("pruned", upTo);
    return changes;
  }

  // A paged part's rows, as items in its order (each knows its place): those of `post`, or of every post `keep` takes.
  #rows(part: StorePart, { post, keep }: { post?: string; keep?: (post: string | null) => boolean } = {}): PagedRow[] {
    if (!PARTS[part]?.paged) throw new Error(`${part} isn't paged`);
    const order = `order by ord ${PARTS[part].newestFirst ? "desc" : "asc"}`;
    const found = (post !== undefined ? this.#q(`select id, post, ord, data from ${part} where scope = ? and post = ? ${order}`).all(this.#scope, post) : this.#q(`select id, post, ord, data from ${part} where scope = ? ${order}`).all(this.#scope)) as Row[];
    return found.filter((r) => post !== undefined || !keep || keep(r.post)).map((r) => {
      const x = JSON.parse(r.data);
      this.#ords.set(x, r.ord);
      return { id: r.id, x, data: r.data };
    });
  }
  // The items of a paged part on every post `keep` takes.
  rows(part: StorePart, keep?: (post: string | null) => boolean): object[] {
    return this.#rows(part, { keep }).map((r) => r.x);
  }
  // A thread's history back in memory: its rows in a paged part, as items checkpoints know (written as they read).
  pageIn(part: StorePart, post: string): object[] {
    return this.#rows(part, { post }).map(({ id, x, data }) => {
      this.#written.set(`${part} ${id}`, data);
      return x;
    });
  }
  // Items out of memory, their rows kept: checkpoints forget them rather than delete them. Only right after a
  // checkpoint, when their rows say what they do.
  pageOut(part: StorePart, items: { id?: string }[]): void {
    const spec: PartSpec<unknown> = PARTS[part];
    for (const x of items) this.#written.delete(`${part} ${spec.idOf ? spec.idOf(x) : x.id}`);
  }
  // Items of a paged part in its order, by their places: one no checkpoint wrote yet is newer than all that were.
  inOrder<T extends object>(part: StorePart, items: T[]): T[] {
    const at = (x: T) => this.#ords.get(x) ?? Infinity;
    return items.sort(PARTS[part].newestFirst ? (a, b) => at(b) - at(a) : (a, b) => at(a) - at(b));
  }
  // Which post a paged item's row is on (null: none, or no such row).
  postOf(part: StorePart, id: string): string | null {
    return PARTS[part]?.paged ? ((this.#q(`select post from ${part} where scope = ? and id = ?`).get(this.#scope, id) as { post: string | null } | undefined)?.post ?? null) : null;
  }
  // Single paged row by id without warming its thread into memory.
  rowById(part: StorePart, id: string): object | null {
    if (!PARTS[part]?.paged) return null;
    const r = this.#q(`select data from ${part} where scope = ? and id = ?`).get(this.#scope, id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  // Stream stored messages by ord without warming cold threads into memory.
  messagesChunk(afterOrd: number, limit: number): { ord: number; post: string | null; item: object }[] {
    const rows = this.#q("select ord, post, data from messages where scope = ? and ord > ? order by ord asc limit ?").all(this.#scope, afterOrd, limit) as { ord: number; post: string | null; data: string }[];
    return rows.map((r) => ({ ord: r.ord, post: r.post, item: JSON.parse(r.data) }));
  }
}
