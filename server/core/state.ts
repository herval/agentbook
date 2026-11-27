// What the server keeps: one database (storage), the store of what isn't a machine's (tasks, workspaces, pages,
// routines), people's accounts, and each machine's posts, agents and work as its CLI sends them (relay).

import fs from "node:fs";
import path from "node:path";
import { createAccounts } from "../accounts.ts";
import { AVATARS_DIR, keepAvatarsIn, keepPeoplePictures } from "../avatars.ts";
import { createBlobs } from "../blobs.ts";
import { createRelay } from "../relay.ts";
import { createWork } from "../work.ts";
import { createStore } from "../../plugin/shared/store.ts";
import { Storage } from "../../plugin/shared/storage.ts";
import { PAGE_TABLES } from "../storage/page.ts";
import { SERVER_HOME, STORAGE_ROOT } from "../config.ts";

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Everything the server writes is its own and nobody else's business, so keep it to this user: new files 0600,
// new dirs 0700, and the data folder itself tightened in case it predates this (another OS user, or a backup
// holder, would otherwise read the database, blobs and password hashes). The secrets in it are sealed/hashed, but
// there's no reason to hand the rest over. Embedded in agentbook (`agentbook webui`, plugin/cli/webui.ts), the
// umask is left be: it's the whole process's, and the agents that process starts would make their files 0600 too.
// The data folder's 0700 keeps what's in it this user's there.
export const EMBEDDED = globalThis[Symbol.for("agentbook.server.embedded")] === true;
if (!EMBEDDED) process.umask(0o077);
try {
  fs.mkdirSync(SERVER_HOME, { recursive: true });
  fs.chmodSync(SERVER_HOME, 0o700);
} catch {}

// Everything it keeps: one database, and the folders of its files (plugin/shared/storage.ts). Served by agentbook
// itself (`agentbook webui`), it's the one agentbook-cli keeps this machine's store in. Its database from before
// storage.db (agentbook.db) is folded in once: its store, accounts and the rest.
export const storage = Storage.open(STORAGE_ROOT);
storage.adopt(path.join(SERVER_HOME, "agentbook.db"), { scope: "server", globals: PAGE_TABLES, log });
// What the server keeps that isn't a machine's: tasks, workspaces, pages and their routines.
export const store = createStore({ storage, scope: "server", filesDir: path.join(SERVER_HOME, "files"), outbox: false, legacy: false });
export const { state, commit } = store;
export const FILES_DIR = store.filesDir;
keepAvatarsIn(storage.files(AVATARS_DIR));
export const accounts = createAccounts(storage);
keepPeoplePictures(() => accounts.avatars());
// What the rest of the server does when a machine changes something, sends a picture, is asked for a blob, or has
// something waiting while it's off: main.ts hands these over (whenRelay) once every area that acts on them is loaded.
type RelayHooks = Required<Pick<Parameters<typeof createRelay>[0], "onChange" | "blobOk" | "onHeld">> & Required<Pick<Parameters<typeof createWork>[0], "onPicture">>;
const on = {} as RelayHooks;
export const whenRelay = (hooks: RelayHooks) => Object.assign(on, hooks);
// Each machine's posts, agents and the rest, as its CLI sends them, and each post's work (steps, pictures, changes).
export const work = createWork({ onPicture: (...args) => on.onPicture(...args) });
export const relay = createRelay({
  storage,
  home: SERVER_HOME,
  accounts,
  work,
  blobOk: (...args) => on.blobOk(...args),
  log,
  // Something waits for a machine that's off: one in a cloud sandbox is woken for it (cloud.ts, made in core/services.ts).
  onHeld: (...args) => on.onHeld(...args),
  onChange: (...args) => on.onChange(...args),
});
export const blobs = createBlobs({ storage, files: storage.files(path.join(SERVER_HOME, "blobs")) });
relay.load();
// Whose things are whose when nothing says: the first admin's (pages from before pages had owners).
export const firstAdmin = () => accounts.machineOwner();
