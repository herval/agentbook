// Moving in: `agentbook-server import <folder>` takes in an
// agentbook data folder from before the split, where one process kept everything in one database. Run once, with
// the server stopped; running it again adds only what's new.
//
// 1. The server's part, as it was: accounts, sign-ins, invites, machines, pins and follows; workspaces, tasks,
//    pages and their versions, routines with their code and runs; groups, with their notes, what happened in them,
//    the threads in each, and every version of their files; connectors, the GitHub app, people's pictures.
// 2. The machine the folder is on becomes a device of its owner, named as before (the name it last ran under,
//    which its workspaces' folders were saved with), and its token goes where its agentbook-cli looks
//    (<folder>/cli/device.json): the CLI is then logged in without a code.
// 3. Its posts, messages, questions, files and agents come from the CLI itself: the first time it connects, the
//    server has nothing of it, so it sends all of it, under the same ids, and then its posts' work. The files
//    they name are copied here now, so they open while the machine is off.
//
// The old database is read from a copy, so the folder is never written but for cli/device.json. What's taken in goes
// into the server's storage (plugin/shared/storage.ts, storage.db).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccounts } from "./accounts.ts";
import { AccountTables } from "./storage/accounts.ts";
import { createBlobs } from "./blobs.ts";
import { machineName } from "../plugin/shared/ids.ts";
import { createStore } from "../plugin/shared/store.ts";
import { STORAGE_FILE, Storage } from "../plugin/shared/storage.ts";
import type { State } from "../plugin/shared/types.ts";

type ServerPart = "workspaces" | "tasks" | "pages" | "page_versions" | "routines" | "routine_code" | "routine_runs" | "groups" | "group_notes" | "group_files" | "group_events";
type Part = { id?: string }[] | Record<string, unknown>;
// What the server keeps that isn't a machine's (the rest of a store's state is its machine's).
const SERVER_PARTS: ServerPart[] = ["workspaces", "tasks", "pages", "page_versions", "routines", "routine_code", "routine_runs", "groups", "group_notes", "group_files", "group_events"];

// Copy a folder's files that aren't there yet. -> how many.
function copyNew(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyNew(a, b);
    else if (e.isFile() && !fs.existsSync(b)) {
      fs.copyFileSync(a, b);
      n++;
    }
  }
  return n;
}

// `from`: the old data folder. `serverHome`: this server's, and `storage` its storage. `server`: the address the
// machine's CLI reaches it at. `name`: the machine's name (else as before). `owner`: whose machine it is (else
// AGENTBOOK_OWNER, else the first admin). -> what it did, in words.
export interface ImportArgs {
  from: string;
  serverHome: string;
  storage?: Storage;
  server: string;
  name?: string | null;
  owner?: string | null;
  log?: (line: string) => void;
}
export function importData({ from, serverHome, storage = Storage.open(serverHome), server, name = null, owner = null, log = () => {} }: ImportArgs): string[] {
  // Its database and files: in its cli/ once an agentbook-cli has started there since (plugin/cli/cli-folder.ts);
  // its database in storage.db once one from since has (its agentbook-cli's rows, scope "cli"; cli/agentbook.db,
  // left there, is then as it was before that).
  // (The storage.db it's imported into may be that folder's too, a page's with no agentbook-cli's rows yet.)
  const shared = path.resolve(from, STORAGE_FILE);
  // (A page's own may have none.)
  const folded = shared !== path.resolve(storage.file) && Storage.hasScope(shared, "cli");
  const own = folded || fs.existsSync(path.join(from, "cli", "agentbook.db")) ? path.join(from, "cli") : from;
  const oldDb = folded ? shared : path.join(own, "agentbook.db");
  if (!fs.existsSync(oldDb)) throw new Error(`There's no agentbook.db in ${from}.`);
  fs.mkdirSync(serverHome, { recursive: true });
  const said: string[] = [];

  // A copy of its database, as one file (its log folded in), taken into a storage of its own as today's tables.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-import-"));
  const copy = path.join(work, oldDb === shared ? STORAGE_FILE : "agentbook.db");
  try {
    Storage.copyWhole(oldDb, copy);
    const before = Storage.at(path.join(work, STORAGE_FILE));
    if (oldDb !== shared) before.adopt(copy, { scope: "cli", globals: [AccountTables] });
    const old = createStore({ storage: before, filesDir: path.join(own, "files"), outbox: false, legacy: false });
    // The name it last ran as: the one its workspaces' folders were saved with (it kept them in step when it was renamed).
    const was = before.store("cli").meta("machine");

    // 1. The server's part of the state.
    const store = createStore({ storage, scope: "server", filesDir: path.join(serverHome, "files"), outbox: false, legacy: false });
    // An account here with a name the folder's has, under another id, would leave the folder half moved in (its
    // sign-ins and machines belong to the other id): said before anything is written.
    const accountRows = storage.use(AccountTables);
    {
      const clash = accountRows.takenHere(before.use(AccountTables).everyone());
      if (clash.length) {
        store.close?.();
        throw new Error(`This agentbook-server already has ${clash.map((u) => `@${u.username}`).join(", ")}, made here rather than moved in, so ${from} can't be imported into it. Import into a server with no accounts (a new AGENTBOOK_SERVER_HOME), before making any.`);
      }
    }
    for (const part of SERVER_PARTS) {
      const src: Part = old.state[part];
      const dst: Part = store.state[part];
      let n = 0;
      // (The same part of the same state: a list in both, or by id in both.)
      if (Array.isArray(src) && Array.isArray(dst)) {
        const have = new Set(dst.map((x) => x.id));
        for (const x of src) if (x?.id && !have.has(x.id)) (dst.push(x), n++);
      } else if (!Array.isArray(src) && !Array.isArray(dst)) {
        for (const [id, x] of Object.entries(src || {})) if (!(id in dst)) (dst[id] = x, n++);
      }
      if (n) said.push(`${n} ${part.replace(/_/g, " ")}`);
    }
    // The threads in each group: the server keeps that (a thread is its machine's), by the same ids.
    let joined = 0;
    for (const s of Object.values(old.state.sessions)) {
      if (!s.group || !old.state.groups[s.group] || store.state.group_posts[s.id]) continue;
      store.state.group_posts[s.id] = { group: s.group, seen: s.group_seen || 0, agent: s.agent || null, who: `${s.label} (${old.state.agents[s.agent]?.name || s.agent})`, at: s.updated || new Date().toISOString() };
      joined++;
    }
    if (joined) said.push(`${joined} threads in groups`);
    store.checkpoint(true);

    // Accounts and what each person keeps, row for row (the columns both have).
    for (const [t, n] of accountRows.copyFrom(before.file)) if (n) said.push(`${n} ${t.replace(/_/g, " ")}`);
    old.close?.();

    // Every version of the groups' files, by their sha256, where the server keeps bytes.
    const blobs = createBlobs({ storage, files: storage.files(path.join(serverHome, "blobs")) });
    let kept = 0;
    for (const v of store.state.group_files) {
      if (!v.sha || blobs.has(v.sha)) continue;
      try {
        blobs.put(fs.readFileSync(path.join(own, "files", "groups", v.group, v.sha)));
        kept++;
      } catch {}
    }
    if (kept) said.push(`${kept} versions of groups' files`);

    // 2. The machine the folder is on, logged in as its owner's.
    const accounts = createAccounts(storage);
    const who = (owner && accounts.byUsername(owner)) || accounts.machineOwner();
    if (!who) throw new Error("The folder has no account to give its machine to. Make one first: agentbook-server adduser <you>.");
    const deviceFile = path.join(from, "cli", "device.json");
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(deviceFile, "utf8"));
    } catch {}
    let device: { id: string; name: string; username?: string } | null = saved?.token ? accounts.deviceFor(saved.token) : null;
    if (!device) {
      const as = machineName(name || was || process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]);
      const req = accounts.requestDevice(as);
      const made = accounts.approveDevice(req.code, who.id);
      const got = accounts.pollDevice(req.poll);
      for (const old of made.replaced) accounts.replaces(made.id, old);
      fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
      // A server on this machine (agentbook up) is one its CLI keeps running.
      const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(String(server));
      fs.writeFileSync(deviceFile, JSON.stringify({ server, token: got.token, name: got.name, user: got.user, ...(local ? { local: true } : {}) }, null, 2) + "\n", { mode: 0o600 });
      device = { id: made.id, name: got.name, username: got.user };
      said.push(`this machine as ${got.name}, @${got.user}'s (its agentbook-cli is logged in: ${deviceFile})`);
    } else said.push(`this machine as ${device.name} already`);

    // 3. The files its posts name, so they open while it's off; and the server's own files.
    const files = copyNew(path.join(own, "files"), path.join(serverHome, "devices", `${String(device.id).replace(/[^\w.-]/g, "_")}-files`));
    if (files) said.push(`${files} files`);
    const pictures = copyNew(path.join(from, "avatars"), path.join(serverHome, "avatars"));
    if (pictures) said.push(`${pictures} pictures`);
    for (const f of ["connectors.json", "github-app.json"]) {
      const a = path.join(from, f);
      const b = path.join(serverHome, f);
      if (fs.existsSync(a) && !fs.existsSync(b)) {
        fs.copyFileSync(a, b);
        fs.chmodSync(b, 0o600);
        said.push(f);
      }
    }
    store.close?.();
    log(said.join(", "));
    return said;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
