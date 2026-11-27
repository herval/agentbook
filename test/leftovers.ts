#!/usr/bin/env node
// agentbook-cli's database stops keeping what it kept from before the split (plugin/cli/leftovers.ts): accounts and
// sign-ins go, overwritten, and the state's parts that are agentbook-server's (tasks, pages…) go to a file of its
// person's only. Not before a server has this machine: until then `agentbook-server import` may read them. Since
// storage.db, the accounts left are in agentbook-cli's database from before it (cli/agentbook.db), which nothing
// reads now; the state's parts are in its store, in storage.db.
// Run: node test/leftovers.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../plugin/shared/store.ts";
import { forgetLeftovers } from "../plugin/cli/leftovers.ts";
import type { Page, PageVersion, Task } from "../plugin/shared/types.ts";
import { DatabaseSync } from "./harness-sql.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-leftovers-"));
const CLI = path.join(HOME, "cli");
const FILE = path.join(CLI, "agentbook.db"); // agentbook-cli's database from before storage.db
const STORAGE = path.join(HOME, "storage.db");
const HASH = "scrypt$16384$8$1$leftover-password-hash-marker";
const open = () => createStore({ file: STORAGE, filesDir: path.join(CLI, "files"), legacy: false, acks: true });
const count = (file: string, t: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`select count(*) n from ${t}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const rows = (s: ReturnType<typeof open>, t: string) => count(STORAGE, t);
const accounts = (t: string) => count(FILE, t);
const onDisk = (text: string) => [FILE, `${FILE}-wal`].some((f) => fs.existsSync(f) && fs.readFileSync(f).includes(text));

let store = open();
try {
  // As a database from before the split has it: an account with its sign-in and a pin (in cli/agentbook.db), a task
  // and a page with a version; and this machine's own threads.
  const now = new Date().toISOString();
  {
    const old = new DatabaseSync(FILE);
    old.exec(`pragma journal_mode = wal;
      create table users (id text primary key, username text not null unique, password text not null, role text not null, created text not null);
      create table auth_sessions (token_hash text primary key, user_id text not null, created text not null, expires text not null);
      create table pins (user_id text not null, post text not null, at text not null, primary key (user_id, post));`);
    old.prepare("insert into users (id, username, password, role, created) values (?, ?, ?, ?, ?)").run("u1", "herval", HASH, "admin", now);
    old.prepare("insert into auth_sessions (token_hash, user_id, created, expires) values (?, ?, ?, ?)").run("th1", "u1", now, now);
    old.prepare("insert into pins (user_id, post, at) values (?, ?, ?)").run("u1", "s1", now);
    old.close();
  }
  const task: Task = { id: "t1", owner: "u1", text: "ship it", workspace: null, rank: 0, at: now, done: false, done_at: null, posts: [], sent: [], pages: [] };
  const page: Page = { id: "p1", title: "Plan", emoji: "", color: null, about: "", visibility: "private", by: { user: "u1" }, contributors: [], widgets: [], version: 1, created: now, updated: now, archived: null };
  const version: PageVersion = { id: "v1", page: "p1", v: 1, at: now, by: { user: "u1" }, summary: "", changes: [], restored: null, hand: true, snapshot: { title: "Plan", emoji: "", about: "", widgets: [] } };
  store.state.tasks.t1 = task;
  store.state.pages.p1 = page;
  store.state.page_versions.push(version);
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  store.commit({ t: "message.add", post: "s1", from: "agent", text: "mine" });
  store.checkpoint(true);
  check(onDisk(HASH), "(the password hash is on disk to begin with)");

  check(forgetLeftovers({ store, home: CLI }) === null && accounts("users") === 1 && rows(store, "tasks") === 1, "before a server has this machine, nothing goes: agentbook-server import may still read it");

  store.setAcked(store.state.seq);
  const r = forgetLeftovers({ store, home: CLI });
  check(r?.accounts === 3 && ["users", "auth_sessions", "pins"].every((t) => accounts(t) === 0), "once one has, accounts, sign-ins and pins go");
  check(["tasks", "pages", "page_versions"].every((t) => rows(store, t) === 0) && !Object.keys(store.state.tasks).length && !Object.keys(store.state.pages).length, "and the server's parts of the state, from the database and from memory");
  check(!!store.state.sessions.s1 && rows(store, "messages") === 1, "its own threads stay");
  check(!onDisk(HASH), "the password hash isn't left in the database or its log");
  const kept = path.join(CLI, "before-the-split.json");
  const saved = fs.existsSync(kept) ? JSON.parse(fs.readFileSync(kept, "utf8")) : null;
  check(saved?.parts?.tasks?.t1?.text === "ship it" && saved.parts.pages?.p1?.title === "Plan" && saved.parts.page_versions?.length === 1, "what went of the state is in before-the-split.json");
  check(saved && (fs.statSync(kept).mode & 0o777) === 0o600 && !fs.readFileSync(kept, "utf8").includes(HASH) && !fs.readFileSync(kept, "utf8").includes("herval"), "its person's only (0600), with nothing of the accounts in it");
  check(forgetLeftovers({ store, home: CLI }) === null, "it's done once");

  store.close();
  store = open();
  check(!Object.keys(store.state.tasks).length && !Object.keys(store.state.pages).length && !!store.state.sessions.s1, "started again, its store has no tasks or pages, and its threads");
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  store.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
