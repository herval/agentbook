#!/usr/bin/env node
// What agentbook keeps on a machine is one database, storage.db (plugin/shared/storage.ts). A machine from before it
// had four kinds: agentbook-cli's (cli/agentbook.db), its page's (server/agentbook.db, with the accounts), the
// relay's (server/relay.db), and the page's copy of each machine (server/devices/<id>.db). Each is folded in once, as
// it was, under its store's scope; the files are left as they were and not read again. Then: each store sees only its
// own rows, an update keeps and puts back only agentbook-cli's own, and files go through the folders it hands out.
// Run: node test/one-storage.ts

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-one-storage-")));
const HOME = path.join(BASE, "home");
process.env.AGENTBOOK_HOME = HOME;
for (const k of ["AGENTBOOK_FILES", "AGENTBOOK_SERVER_HOME"]) delete process.env[k];
const { createStore } = await import("../plugin/shared/store.ts");
const { Storage } = await import("../plugin/shared/storage.ts");
const { createRelay } = await import("../server/relay.ts");
const { AccountTables } = await import("../server/storage/accounts.ts");
const { StoreTables } = await import("../plugin/shared/storage/store.ts");
const { PAGE_TABLES } = await import("../server/storage/page.ts");
const { writeBefore } = await import("./harness-before.ts");
const { closeSql, DatabaseSync, sql } = await import("./harness-sql.ts");

const accounts = { byId: (id) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
const at = () => new Date().toISOString();
const hash = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scopedIn = (file) => sql(file).prepare("select m.name from sqlite_master m where m.type = 'table' and exists (select 1 from pragma_table_info(m.name) where name = 'scope') order by 1").all().map((r) => r.name);

try {
  // ---------- a machine from before, made by hand ----------
  const make = Storage.at(path.join(BASE, "make", "storage.db"));
  const cli = createStore({ storage: make, scope: "cli", filesDir: path.join(BASE, "make", "files"), legacy: false, acks: true });
  cli.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  for (let i = 0; i < 30; i++) cli.commit({ t: "message.add", post: "s1", from: i % 2 ? "agent" : "human", text: `message ${i}` });
  cli.checkpoint(true);
  const server = createStore({ storage: make, scope: "server", filesDir: path.join(BASE, "make", "server-files"), outbox: false, legacy: false });
  server.commit({ t: "page.create", pid: "notes", title: "Notes", by: { user: "herval" }, widgets: [] });
  server.checkpoint(true);
  make.use(AccountTables).insertUser({ id: "u1", username: "herval", display_name: "herval", bio: "", password: "x", role: "admin", created: at() });
  const relay0 = createRelay({ storage: make, home: path.join(BASE, "make", "server"), accounts });
  const D0 = relay0.device("d1", { name: "laptop", user_id: "u1" });
  relay0.ingest(D0, { ops: [
    { kind: "post.hello", seq: 1, at: at(), args: { proc: "p1", agent: "claude", label: "wren", kind: "claude-code", session_id: "s1" } },
    { kind: "message.add", seq: 2, at: at(), args: { post: "s1", mid: "m1", from: "agent", text: "on the page" } },
  ] });
  D0.store.checkpoint(true);
  const want = { cli: cli.state, server: server.state, device: D0.store.state };
  const ids = sql(make.file).prepare("select device, local, global from ids order by 1, 2").all();
  check(want.cli.messages.length === 30 && want.device.messages.length === 1 && ids.length > 0, `(a machine, its page, and the page's copy of it: ${ids.length} ids)`);

  writeBefore(make, "cli", path.join(HOME, "cli", "agentbook.db"));
  writeBefore(make, "server", path.join(HOME, "server", "agentbook.db"), { globals: ["users"] });
  // A table of the page's from long ago, that no table module has any more.
  const gone = new DatabaseSync(path.join(HOME, "server", "agentbook.db"));
  gone.exec("create table panel_answers (k text); insert into panel_answers values ('old')");
  gone.close();
  writeBefore(make, null, path.join(HOME, "server", "relay.db"), { globals: ["ids", "cursors"] });
  writeBefore(make, "device:d1", path.join(HOME, "server", "devices", "d1.db"));
  const olds = ["cli/agentbook.db", "server/agentbook.db", "server/relay.db", "server/devices/d1.db"].map((f) => path.join(HOME, f));
  const was = olds.map(hash);

  // ---------- folded in, as agentbook-cli and its page start ----------
  const mine = createStore({ legacy: false, acks: true, moveCorrupt: true });
  const storage = mine.storage;
  check(storage.file === path.join(HOME, "storage.db") && mine.scope === "cli", "agentbook-cli's store is in <data folder>/storage.db, as cli");
  check(same(mine.state, want.cli), "with what cli/agentbook.db had, every part of it");
  check(Storage.open(HOME) === storage, "and its page, in the same process, gets the same storage");
  storage.adopt(path.join(HOME, "server", "agentbook.db"), { scope: "server", globals: PAGE_TABLES });
  const page = createStore({ storage, scope: "server", filesDir: path.join(HOME, "server", "files"), outbox: false, legacy: false });
  check(same(page.state, want.server), "the page's own store, from server/agentbook.db, as server");
  check(storage.use(AccountTables).everyone().map((u) => u.username).join() === "herval", "and its accounts, in a table of the page's");
  check(!sql(storage.file).prepare("select 1 from sqlite_master where name = 'panel_answers'").get(), "and nothing of it no table module names");
  const relay = createRelay({ storage, home: path.join(HOME, "server"), accounts });
  const D = relay.device("d1", { name: "laptop", user_id: "u1" });
  check(same(D.store.state, want.device), "each machine's copy, from devices/<id>.db, as device:<id>");
  check(same(sql(storage.file).prepare("select device, local, global from ids order by 1, 2").all(), ids), "and the relay's ids, from relay.db");
  const modules = Object.fromEntries(sql(storage.file).prepare("select module, version from schema").all().map((r) => [r.module, r.version]));
  check(modules.store === StoreTables.schema.length && modules.uplink === 1 && modules.work === 1 && modules.accounts === AccountTables.schema.length && modules.relay === 1, `each table module's tables made once, at its version (${Object.keys(modules).sort()})`);
  const adopted = storage.adopted().map((a) => `${path.relative(HOME, a.file)} ${a.scope ?? "-"}`).sort();
  check(adopted.join() === "cli/agentbook.db cli,server/agentbook.db server,server/devices/d1.db device:d1,server/relay.db -", `each file is marked folded, once (${adopted})`);
  check(olds.every((f, i) => hash(f) === was[i]), "and every one is left as it was, byte for byte");

  // ---------- each store, its own rows ----------
  check(!mine.state.pages?.notes && page.state.pages?.notes, "a store sees only its own rows: the page's page isn't agentbook-cli's");
  mine.commit({ t: "message.add", post: "s1", from: "agent", text: "after the fold" });
  mine.checkpoint(true);
  check(!D.store.state.messages.some((m) => m.text === "after the fold"), "and what it writes is its own until it's sent (the page's copy is another scope)");
  const sameSeq = (scope) => sql(path.join(HOME, "storage.db")).prepare("select max(seq) n from events where scope = ?").get(scope).n;
  check(sameSeq("cli") === mine.state.seq && sameSeq("server") === page.state.seq, "each store's log is numbered on its own");

  // ---------- started again: nothing folded twice ----------
  const rows = (t) => sql(path.join(HOME, "storage.db")).prepare(`select count(*) n from ${t}`).get().n;
  const SCOPED = scopedIn(path.join(HOME, "storage.db"));
  const counts = SCOPED.map(rows);
  for (const d of relay.devices.values()) d.store.close?.();
  page.close();
  mine.close();
  check(storage.closed, "the storage closes when its last store lets go");
  const again = createStore({ legacy: false, acks: true, moveCorrupt: true });
  again.storage.adopt(path.join(HOME, "server", "agentbook.db"), { scope: "server", globals: PAGE_TABLES });
  createRelay({ storage: again.storage, home: path.join(HOME, "server"), accounts });
  check(again.state.messages.some((m) => m.text === "after the fold") && SCOPED.map(rows).every((n, i) => n === counts[i]), "started again, it has what was written since, and folds nothing twice");
  check(olds.every((f, i) => hash(f) === was[i]), "and the old files are still as they were");

  // ---------- an update's copy: agentbook-cli's own rows only ----------
  const s = again.storage;
  const copy = path.join(HOME, "storage.db.before-update");
  const copied = s.copyScope("cli", copy);
  const inCopy = new DatabaseSync(copy, { readOnly: true });
  const scopes = inCopy.prepare("select distinct scope from events").all().map((r) => r.scope);
  inCopy.close();
  check(copied > 0 && scopes.join() === "cli" && (fs.statSync(copy).mode & 0o777) === 0o600, `an update keeps a copy of agentbook-cli's own rows, only them, readable only by its owner (${copied} rows)`);
  again.commit({ t: "message.add", post: "s1", from: "agent", text: "written by a release that didn't start" });
  again.checkpoint(true);
  const pageSeq = sameSeq("server");
  const users = rows("users");
  again.close();
  const back = Storage.open(HOME);
  back.restoreScope("cli", copy);
  check(sameSeq("server") === pageSeq && rows("users") === users, "putting it back leaves the page's rows be");
  const restored = createStore({ storage: back, scope: "cli", legacy: false, acks: true });
  check(!restored.state.messages.some((m) => m.text === "written by a release that didn't start") && restored.state.messages.some((m) => m.text === "after the fold"), "and agentbook-cli's are as they were before the update");

  // ---------- scopes: renamed, dropped ----------
  back.store("device:d2").setMeta("epoch", "e2");
  let refused = null;
  try {
    back.renameScope("device:d1", "device:d2");
  } catch (e) {
    refused = e;
  }
  check(/has a store already/.test(refused?.message || "") && (sql(back.file).prepare("select count(*) n from events where scope = 'device:d1'").get() as { n: number }).n > 0, "a machine's rows aren't renamed over another's");
  back.dropScope("device:d2");
  back.renameScope("device:d1", "device:d3");
  check(!sql(back.file).prepare("select 1 from events where scope = 'device:d1'").get() && sql(back.file).prepare("select 1 from events where scope = 'device:d3'").get() && back.adopted().some((a) => a.scope === "device:d3"), "a machine that comes back under a new id takes its rows, and its folded file, with it");
  back.dropScope("device:d3");
  check(!back.scopes().includes("device:d3") && back.scopes().includes("cli") && back.scopes().includes("server"), "and a machine deleted takes only its own rows");
  const bytes = ["", "-wal"].filter((x) => fs.existsSync(back.file + x)).map((x) => fs.readFileSync(back.file + x));
  check(bytes.length && !bytes.some((b) => b.includes("on the page")), "and what they said isn't left in the file's free pages, nor its -wal");

  // ---------- files ----------
  const f = back.files("server/blobs");
  f.write("ab/cd", "hello");
  check(f.read("ab/cd", "utf8") === "hello" && (fs.statSync(path.join(HOME, "server", "blobs", "ab", "cd")).mode & 0o777) === 0o600, "a folder it hands out keeps files in its data folder, readable only by its owner");
  check(back.files("server/blobs") === f && f.read("missing") === null, "the same folder is the same one, and a missing file is null");
  let escaped = null;
  try {
    f.path("../../cli/device.json");
  } catch (e) {
    escaped = e;
  }
  check(escaped, "a name can't leave its folder");
  restored.close();
  back.close();
  closeSql();
} catch (e) {
  check(false, `crashed: ${e.stack}`);
}
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
