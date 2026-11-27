// Files the server keeps: bytes by their sha256 (a screenshot sent twice is kept once), and uploads, the files
// people send from the page (to a post, with a message, as an answer), each its uploader's.
// A blob is a file named by its sha256 in the folder `files` (a Files of its storage, plugin/shared/storage.ts:
// <server data>/blobs), and served only through the routes that check who may see it. What's known of them (uploads,
// who sent which) is in its storage's blob tables (server/storage/blobs.ts).
// Who sent each blob is kept too (their machines, or the page): a machine names bytes by their sha256, and knowing a
// sha256 isn't having the bytes, so it may name only what its person sent (theirs).

import { sha256 } from "../plugin/shared/hash.ts";
import crypto from "node:crypto";
import type { Files, Storage } from "../plugin/shared/storage.ts";
import { BlobTables, type Upload } from "./storage/blobs.ts";

const SHA = /^[0-9a-f]{64}$/;

// storage: the page's (plugin/shared/storage.ts); files: the folder the bytes are kept in (storage.files(dir)).
export type Blobs = ReturnType<typeof createBlobs>;
// What a machine gets to fetch a file.
export interface FileRef {
  id: string;
  name: string;
  size: number;
  sha: string;
  type?: string;
}
export function createBlobs({ storage, files }: { storage: Storage; files: Files }) {
  const tables = storage.use(BlobTables);

  const file = (sha: string): string | null => (SHA.test(String(sha)) ? files.path(sha) : null);
  const has = (sha: string): boolean => SHA.test(String(sha)) && files.exists(sha);
  // Keep bytes, sent by `user` (a person's id): their sha256.
  function put(buf: Buffer, user: string | null = null): string {
    const sha = sha256(buf);
    if (!has(sha)) files.write(sha, buf);
    if (user) tables.addSender(sha, String(user));
    return sha;
  }
  // Keep bytes someone sent from the page: { id, name, size, sha, type }.
  function upload(buf: Buffer, { name, owner, type = null }: { name: string; owner: string | null; type?: string | null }): Upload {
    const sha = put(buf, owner);
    const u: Upload = { id: `u${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`, owner: owner || null, name, size: buf.length, sha, type, at: new Date().toISOString() };
    tables.addUpload(u);
    return u;
  }
  const uploadOf = (id: string): Upload | null => tables.upload(String(id || ""));
  const ref = (u: Pick<Upload, "id" | "name" | "size" | "sha" | "type">): FileRef => ({ id: u.id, name: u.name, size: u.size, sha: u.sha, ...(u.type ? { type: u.type } : {}) });
  const read = (sha: string): Buffer | null => (has(sha) ? files.read(sha) : null);
  const uploadsWith = (sha: string): boolean => tables.uploaded(String(sha || ""));
  // Whether `user` sent these bytes, from a machine of theirs or the page. Ones kept before senders were (nobody's on
  // record) are anyone's, as they were then.
  function theirs(sha: string, user: string | null | undefined): boolean {
    const s = String(sha || "");
    if (!user) return false;
    return tables.sentBy(s, String(user)) || !tables.known(s);
  }
  // A person deleted (server/purge.ts): their uploads go, and so do the bytes only they sent. Bytes someone else
  // sent too stay, theirs; bytes from before senders were kept (nobody's) were never theirs to take. -> how many went.
  function forget(user: string): number {
    let n = 0;
    for (const sha of tables.forgetUser(String(user))) {
      if (tables.known(sha)) continue;
      if (has(sha)) files.remove(sha);
      n++;
    }
    return n;
  }
  return { put, upload, uploadOf, uploadsWith, theirs, ref, read, has, file, forget, remove: (sha: string) => has(sha) && files.remove(sha) };
}
