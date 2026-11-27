// What the page knows of the bytes it keeps by their sha256 (server/blobs.ts; the bytes are files in its blobs
// folder): uploads, by whom, and who sent which bytes. storage.use(BlobTables).

import type { DatabaseSync } from "../../plugin/shared/storage/sqlite.ts";
import type { Iso } from "../../plugin/shared/types.ts";

// An upload: a file someone sent from the page, kept by its bytes' sha256. `owner`: its sender's id.
export type Upload = {
  id: string;
  owner: string | null;
  name: string;
  size: number;
  sha: string;
  type: string | null;
  at: Iso;
};

export class BlobTables {
  static id = "blobs";
  static schema = [
    `create table uploads (id text primary key, owner text, name text not null, size integer not null, sha text not null, type text, at text not null);
     create index uploads_sha on uploads (sha);
     create table blob_senders (sha text not null, user text not null, primary key (sha, user));`,
  ];

  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // `user` (a person's id) sent these bytes, from a machine of theirs or the page.
  addSender(sha: string, user: string): void {
    this.#db.prepare("insert or ignore into blob_senders (sha, user) values (?, ?)").run(sha, user);
  }
  addUpload(u: Upload): void {
    this.#db.prepare("insert into uploads (id, owner, name, size, sha, type, at) values (?, ?, ?, ?, ?, ?, ?)").run(u.id, u.owner, u.name, u.size, u.sha, u.type, u.at);
  }
  // An upload by its id: { id, owner, name, size, sha, type, at }, or null.
  upload(id: string): Upload | null {
    const r = this.#db.prepare("select * from uploads where id = ?").get(id) as Upload | undefined;
    return r ? { ...r } : null;
  }
  // Whether an upload has these bytes.
  uploaded(sha: string): boolean {
    return !!this.#db.prepare("select 1 from uploads where sha = ?").get(sha);
  }
  // Whether `user` is on record as having sent these bytes: as their sender, or in an upload of theirs.
  sentBy(sha: string, user: string): boolean {
    return !!(this.#db.prepare("select 1 from blob_senders where sha = ? and user = ?").get(sha, user) || this.#db.prepare("select 1 from uploads where sha = ? and owner = ?").get(sha, user));
  }
  // Whether anyone is on record as having sent these bytes (a sender, or an upload).
  known(sha: string): boolean {
    return !!this.#db.prepare("select 1 from blob_senders where sha = ?").get(sha) || this.uploaded(sha);
  }
  // A person's uploads and what they're on record as having sent, gone. -> the sha256s they had sent or uploaded.
  forgetUser(user: string): string[] {
    const shas = new Set([...(this.#db.prepare("select sha from blob_senders where user = ?").all(user) as { sha: string }[]), ...(this.#db.prepare("select sha from uploads where owner = ?").all(user) as { sha: string }[])].map((r) => r.sha));
    this.#db.prepare("delete from uploads where owner = ?").run(user);
    this.#db.prepare("delete from blob_senders where user = ?").run(user);
    return [...shas];
  }
}
