// Other people, as your page knows them through your door (server/door.ts): who each is on the
// relay, and what they sent you. storage.use(PeopleTables).
//
//   remote_people   a person on another agentbook: their row in users (user_id), their relay account (who they are),
//                   the handle they go by (their own word: not unique), door key, and their card as their door last
//                   gave it
//   remote_records  what they publish that you may see (server/publish.ts's lists, in their words), by its id on
//                   their page: kept to show, never given to your agents; `author` is who wrote it (their account),
//                   `mentions` whom it names (accounts), `seen` when their door last said it's still yours to see (a
//                   copy not heard of for 14 days goes)
//   remote_comments comments people made on your threads, in the thread's People lane: never sent to its agent
//   space_people    people elsewhere you asked into a group, task, page or note of yours (`space`: group:<id>, …),
//                   and whether they said yes (asked, in)
//   spaces_in       the ones of other people's you're asked into or in, by their home (its owner's user id)
//   space_threads   your threads you put in one of those, which go to its home as they change
// A record that came to be passed on (a thread someone put in a group of yours) keeps it as it came (`item`): its
// author's signature holds only over what they signed.

import type { DatabaseSync } from "../../plugin/shared/storage/sqlite.ts";

export type RemotePersonRow = {
  user_id: string;
  acct: string;
  handle: string;
  door_key: string;
  name: string | null;
  bio: string | null;
  picture: string | null;
  card_at: string | null;
  seen: string | null;
};
export type RemoteRecordRow = {
  owner: string;
  rid: string;
  type: string;
  v: string;
  body: string;
  space: string | null;
  author: string | null;
  mentions: string | null;
  seen: string;
  got: string;
  item?: string | null;
};
export type RemoteCommentRow = {
  id: string;
  thread: string;
  user_id: string;
  text: string;
  at: string;
  passed: string | null;
  answer: string | null;
  author: string | null;
  answer_at: string | null;
};
export type SpacePersonRow = { space: string; user_id: string; state: "asked" | "in"; at: string };
export type SpaceInRow = { home: string; space: string; name: string | null; state: "asked" | "in"; at: string };

export class PeopleTables {
  static id = "people";
  static schema = [
    `create table remote_people (user_id text primary key, acct text not null unique, handle text not null, door_key text not null, name text, bio text, picture text, card_at text, seen text);
     create table remote_records (owner text not null, rid text not null, type text not null, v text not null, body text not null, space text, author text, mentions text, seen text not null, got text not null, primary key (owner, rid));
     create index remote_records_type on remote_records (type, owner);
     create table remote_comments (id text primary key, thread text not null, user_id text not null, text text not null, at text not null, passed text, answer text);
     create index remote_comments_thread on remote_comments (thread);`,
    `create table remote_follows (owner text not null, agent text not null, level text, ask text, ask_at text, at text not null, primary key (owner, agent));`,
    `alter table remote_records add column item text;
     alter table remote_comments add column author text;
     alter table remote_comments add column answer_at text;
     create table space_people (space text not null, user_id text not null, state text not null, at text not null, primary key (space, user_id));
     create table spaces_in (home text not null, space text not null, name text, state text not null, at text not null, primary key (home, space));
     create table space_threads (home text not null, space text not null, thread text not null, at text not null, v text, primary key (home, space, thread));`,
    // Following is your feed alone now: an agent of theirs is in agent_follows, as r:<owner>:<id>.
    `drop table remote_follows;`,
  ];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // ---------- people ----------
  person(userId: string): RemotePersonRow | null {
    const r = this.#db.prepare("select * from remote_people where user_id = ?").get(userId) as RemotePersonRow | undefined;
    return r ? { ...r } : null;
  }
  byAcct(acct: string): RemotePersonRow | null {
    const r = this.#db.prepare("select * from remote_people where acct = ?").get(acct) as RemotePersonRow | undefined;
    return r ? { ...r } : null;
  }
  people(): RemotePersonRow[] {
    return (this.#db.prepare("select * from remote_people order by handle").all() as RemotePersonRow[]).map((r) => ({ ...r }));
  }
  putPerson(p: Pick<RemotePersonRow, "user_id" | "acct" | "handle" | "door_key">): void {
    this.#db.prepare("insert into remote_people (user_id, acct, handle, door_key) values (?, ?, ?, ?) on conflict (user_id) do update set handle = excluded.handle, door_key = excluded.door_key").run(p.user_id, p.acct, p.handle, p.door_key);
  }
  setCard(userId: string, c: { name: string | null; bio: string | null; picture: string | null }, at: string): void {
    this.#db.prepare("update remote_people set name = ?, bio = ?, picture = ?, card_at = ? where user_id = ?").run(c.name, c.bio, c.picture, at, userId);
  }
  seenNow(userId: string, at: string): void {
    this.#db.prepare("update remote_people set seen = ? where user_id = ?").run(at, userId);
  }

  // ---------- their things ----------
  record(owner: string, rid: string): RemoteRecordRow | null {
    const r = this.#db.prepare("select * from remote_records where owner = ? and rid = ?").get(owner, rid) as RemoteRecordRow | undefined;
    return r ? { ...r } : null;
  }
  // `owner` a person's (their user id), or anyone's (null); of a type, or every type.
  records(o: { owner?: string | null; type?: string | null; space?: string | null } = {}): RemoteRecordRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.owner) where.push("owner = ?"), args.push(o.owner);
    if (o.type) where.push("type = ?"), args.push(o.type);
    if (o.space) where.push("space = ?"), args.push(o.space);
    return (this.#db.prepare(`select * from remote_records${where.length ? ` where ${where.join(" and ")}` : ""} order by got desc`).all(...args) as RemoteRecordRow[]).map((r) => ({ ...r }));
  }
  putRecord(r: RemoteRecordRow): void {
    this.#db
      .prepare("insert into remote_records (owner, rid, type, v, body, space, author, mentions, seen, got, item) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (owner, rid) do update set type = excluded.type, v = excluded.v, body = excluded.body, space = excluded.space, author = excluded.author, mentions = excluded.mentions, seen = excluded.seen, got = excluded.got, item = excluded.item")
      .run(r.owner, r.rid, r.type, r.v, r.body, r.space, r.author, r.mentions, r.seen, r.got, r.item ?? null);
  }
  // What came for `space` from someone (their user id): a home's, when it was yours (`owner` its sender).
  dropSpaceRecords(owner: string, space: string): void {
    this.#db.prepare("delete from remote_records where owner = ? and space = ?").run(owner, space);
  }
  // Still theirs to show: their door said so (`all`) at `at`.
  stillSeen(owner: string, rids: string[], at: string): void {
    const q = this.#db.prepare("update remote_records set seen = ? where owner = ? and rid = ?");
    for (const rid of rids) q.run(at, owner, rid);
  }
  dropRecord(owner: string, rid: string): void {
    this.#db.prepare("delete from remote_records where owner = ? and rid = ?").run(owner, rid);
  }
  // Someone's own things: not what came for a group or task you're in with them (`space`), which goes when you leave.
  dropRecordsOf(owner: string): void {
    this.#db.prepare("delete from remote_records where owner = ? and space is null").run(owner);
  }
  // Copies not heard of since `before` go: a door that never said withdraw.
  dropStale(before: string): number {
    return Number(this.#db.prepare("delete from remote_records where seen < ?").run(before).changes);
  }
  // Changes whenever what came does (a record new, changed or gone; someone's card): what's made from it is the same
  // until it does.
  stamp(): string {
    const r = this.#db.prepare("select (select count(*) from remote_records) n, (select max(got) from remote_records) got, (select count(*) from remote_people) p, (select max(card_at) from remote_people) card").get() as Record<string, unknown>;
    return JSON.stringify(r);
  }

  // ---------- comments on your threads ----------
  // One thread's, or all.
  comments(thread: string | null = null): RemoteCommentRow[] {
    const rows = thread ? this.#db.prepare("select * from remote_comments where thread = ? order by at").all(thread) : this.#db.prepare("select * from remote_comments order by at").all();
    return (rows as RemoteCommentRow[]).map((r) => ({ ...r }));
  }
  comment(id: string): RemoteCommentRow | null {
    const r = this.#db.prepare("select * from remote_comments where id = ?").get(id) as RemoteCommentRow | undefined;
    return r ? { ...r } : null;
  }
  // Comments on any of your threads since `since` (an ISO time), newest first, for the bell.
  commentsSince(since: string): RemoteCommentRow[] {
    return (this.#db.prepare("select * from remote_comments where at > ? order by at desc limit 100").all(since) as RemoteCommentRow[]).map((r) => ({ ...r }));
  }
  putComment(c: Pick<RemoteCommentRow, "id" | "thread" | "user_id" | "text" | "at" | "author">): boolean {
    return Number(this.#db.prepare("insert or ignore into remote_comments (id, thread, user_id, text, at, author) values (?, ?, ?, ?, ?, ?)").run(c.id, c.thread, c.user_id, c.text, c.at, c.author).changes) === 1;
  }
  passed(id: string, at: string): void {
    this.#db.prepare("update remote_comments set passed = ? where id = ?").run(at, id);
  }
  answer(id: string, text: string | null, at: string): void {
    this.#db.prepare("update remote_comments set answer = ?, answer_at = ? where id = ?").run(text, text ? at : null, id);
  }
  dropComment(id: string): void {
    this.#db.prepare("delete from remote_comments where id = ?").run(id);
  }

  // ---------- people elsewhere in your groups, tasks, pages and notes ----------
  spacePerson(space: string, uid: string): SpacePersonRow | null {
    const r = this.#db.prepare("select * from space_people where space = ? and user_id = ?").get(space, uid) as SpacePersonRow | undefined;
    return r ? { ...r } : null;
  }
  // Everyone in one (`space`), or every one someone's in (`uid`), or all.
  spacePeople(o: { space?: string; uid?: string } = {}): SpacePersonRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.space) where.push("space = ?"), args.push(o.space);
    if (o.uid) where.push("user_id = ?"), args.push(o.uid);
    return (this.#db.prepare(`select * from space_people${where.length ? ` where ${where.join(" and ")}` : ""} order by at`).all(...args) as SpacePersonRow[]).map((r) => ({ ...r }));
  }
  setSpacePerson(space: string, uid: string, state: "asked" | "in" | null, at: string): void {
    if (!state) this.#db.prepare("delete from space_people where space = ? and user_id = ?").run(space, uid);
    else this.#db.prepare("insert into space_people (space, user_id, state, at) values (?, ?, ?, ?) on conflict (space, user_id) do update set state = excluded.state, at = excluded.at").run(space, uid, state, at);
  }
  spaceIn(home: string, space: string): SpaceInRow | null {
    const r = this.#db.prepare("select * from spaces_in where home = ? and space = ?").get(home, space) as SpaceInRow | undefined;
    return r ? { ...r } : null;
  }
  spacesIn(home: string | null = null): SpaceInRow[] {
    const rows = (home ? this.#db.prepare("select * from spaces_in where home = ? order by at").all(home) : this.#db.prepare("select * from spaces_in order by at").all()) as SpaceInRow[];
    return rows.map((r) => ({ ...r }));
  }
  setSpaceIn(home: string, space: string, name: string | null, state: "asked" | "in" | null, at: string): void {
    if (!state) {
      this.#db.prepare("delete from spaces_in where home = ? and space = ?").run(home, space);
      this.#db.prepare("delete from space_threads where home = ? and space = ?").run(home, space);
    } else this.#db.prepare("insert into spaces_in (home, space, name, state, at) values (?, ?, ?, ?, ?) on conflict (home, space) do update set name = coalesce(excluded.name, spaces_in.name), state = excluded.state, at = excluded.at").run(home, space, name, state, at);
  }
  spaceThreads(home: string | null = null, space: string | null = null): { home: string; space: string; thread: string; at: string; v: string | null }[] {
    const where: string[] = [];
    const args: string[] = [];
    if (home) where.push("home = ?"), args.push(home);
    if (space) where.push("space = ?"), args.push(space);
    return (this.#db.prepare(`select * from space_threads${where.length ? ` where ${where.join(" and ")}` : ""} order by at`).all(...args) as { home: string; space: string; thread: string; at: string; v: string | null }[]).map((r) => ({ ...r }));
  }
  setSpaceThread(home: string, space: string, thread: string, on: boolean, at: string): void {
    if (on) this.#db.prepare("insert or ignore into space_threads (home, space, thread, at) values (?, ?, ?, ?)").run(home, space, thread, at);
    else this.#db.prepare("delete from space_threads where home = ? and space = ? and thread = ?").run(home, space, thread);
  }
  // The version of it its home was sent last.
  setSpaceThreadV(home: string, space: string, thread: string, v: string | null): void {
    this.#db.prepare("update space_threads set v = ? where home = ? and space = ? and thread = ?").run(v, home, space, thread);
  }
}
