// A copy of agentbook-server's data (`agentbook-server backup <folder>`), taken while it runs: its storage's database
// (storage.db, plugin/shared/storage.ts) as it was at one moment (SQLite's VACUUM INTO, its log folded in), and
// every other file in its data folder as it is, but its server.log (agentbook up keeps it there) and the databases
// from before storage.db that were folded into it (nothing reads them). The copy is a data folder of its own, with
// storage.db in it: start a server with AGENTBOOK_SERVER_HOME set to it to restore it. Served by agentbook itself
// (`agentbook webui`), the storage is this machine's too, and the copy has this machine's store with the page's.
//
// One moment for everything in it, because what one part says depends on another: the relay's cursor for a machine
// says which of its ops are in its store. Those are one database now; a database from before storage.db not folded
// in yet (a server that hasn't started since) is copied too, holding every database's write lock, in one order,
// while it copies them all. The server waits up to 5 s for a lock (busy_timeout), and a batch it still couldn't
// write is sent again by its machine (POST /api/cli/ops answers 503), so nothing is lost meanwhile, only late.

import fs from "node:fs";
import path from "node:path";
import { STORAGE_FILE, Storage } from "../plugin/shared/storage.ts";

const SKIP = /\.db-(wal|shm|journal)$/;

// `storage`: its storage's database (STORAGE_ROOT/storage.db; in `from` when that's its own). `wait`: how long to
// wait for each database's lock (ms). `copied(file)`: called after each database's copy, while the locks are held
// (tests use it to write meanwhile). -> { databases, files, held } copied, and how long (ms) the locks were held.
export interface BackupArgs {
  from: string;
  to: string;
  storage?: string;
  wait?: number;
  copied?: ((name: string) => void) | null;
}
export function backupData({ from, to, storage = path.join(from, STORAGE_FILE), wait = 10e3, copied = null }: BackupArgs): { databases: number; files: number; held: number } {
  if (!fs.existsSync(storage) && !fs.existsSync(path.join(from, "agentbook.db"))) throw new Error(`There's no agentbook-server data in ${from}.`);
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error(`${to} isn't empty.`);
  const rel = path.relative(path.resolve(from), path.resolve(to));
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error(`${to} is in ${from}: put the copy somewhere else.`);
  // What was folded into the storage: left out.
  const folded = new Set(Storage.foldedInto(storage));
  const dbs: string[] = [];
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const a = path.join(dir, e.name);
      // A filesystem's lost+found (a Fly volume mounted as the data folder has one) is root's and nothing of ours.
      if (e.isDirectory()) dir === from && e.name === "lost+found" ? null : walk(a);
      else if (!e.isFile() || SKIP.test(e.name) || (dir === from && (e.name === "server.log" || e.name === "search.db")) || folded.has(path.resolve(a)) || path.resolve(a) === path.resolve(storage)) continue;
      else (e.name.endsWith(".db") ? dbs : files).push(path.relative(from, a));
    }
  })(from);
  dbs.sort();
  // Each database by where it is, and where its copy goes: the storage's first, to storage.db in the copy.
  const all = [...(fs.existsSync(storage) ? [[storage, STORAGE_FILE]] : []), ...dbs.map((f) => [path.join(from, f), f])];
  const out = (f: string) => {
    const b = path.join(to, f);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    return b;
  };
  fs.mkdirSync(to, { recursive: true });

  const held = Storage.copyTogether(all.map(([file, f]): [string, string, string] => [file, out(f), f]), { wait, copied });
  // The other files after: the bytes the databases name were written before them, and bytes are kept by their hash
  // and only taken away with an account, so what's here now has all the copy names (but a deleted account's).
  for (const f of files) {
    const a = path.join(from, f);
    const b = out(f);
    fs.copyFileSync(a, b);
    fs.chmodSync(b, fs.statSync(a).mode & 0o777);
  }
  return { databases: all.length, files: files.length, held };
}
