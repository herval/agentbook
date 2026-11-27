#!/usr/bin/env node
// What agentbook-server acks of a machine's sync is what it kept (the v1 review's P1s). A write that fails (a full
// disk, a locked database: here a trigger that aborts it) isn't acked, and nothing is skipped when it goes again.
//  A) A checkpoint that rolls back wrote nothing: the next one writes all of it, and does what it would have
//     deleted, before the checkpoint moves past it (plugin/shared/storage/store.ts).
//  B) An op the server couldn't log stops its batch there, unacked; its machine's CLI sends it and the ones after it
//     again, and each is taken once (server/relay.ts ingest, the CLI's uplink). A post's work the same.
//  C) A first sync of a machine's threads the server couldn't write leaves nothing taken, so it's sent again and
//     taken then.
//  D) A server restored from a backup gets what it lost from a CLI that kept running (the second review's P2 #3).
//  E) A machine's log keeps what its server hasn't acknowledged, however old (the second review's P2 #4).
// Run: node test/durability.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, State } from "../plugin/shared/types.ts";
import { createRelay } from "../server/relay.ts";
import { createWork } from "../server/work.ts";
import { type Store, createStore } from "../plugin/shared/store.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { type DatabaseSync, closeSql, sql } from "./harness-sql.ts";
import { createUplink } from "../plugin/cli/uplink.ts";
import { backupData } from "../server/backup.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-durability-"));
// A write the database refuses, as a full disk would.
const refuse = (db: DatabaseSync, name: string, table: string, when = "1") => db.exec(`create trigger ${name} before insert on ${table} when ${when} begin select raise(abort, 'database or disk is full'); end;`);
const allow = (db: DatabaseSync, name: string) => db.exec(`drop trigger ${name}`);
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ---------- A. a checkpoint that rolls back ----------
{
  const storage = Storage.at(path.join(HOME, "a", "storage.db"));
  const tables = storage.store("cli");
  const db = sql(storage.file);
  const ids = () => (db.prepare("select id from messages where scope = 'cli' order by ord").all() as { id: string }[]).map((r) => r.id);
  const at = () => Number(tables.meta("checkpoint") || 0);
  const m = (id: string): Message => ({ id, post: "p1", from: "agent", via: "terminal", text: id, file_id: null, files: [], at: "2026-11-01T00:00:00.000Z" });
  // A state with only messages in it, all a checkpoint writes here.
  const state: Pick<State, "seq" | "messages"> = { seq: 1, messages: [m("m1")] };
  tables.checkpoint(state);
  // m2 is written, then m3 isn't: it all rolls back.
  state.messages.push(m("m2"), m("m3"));
  state.seq = 3;
  refuse(db, "no_m3", "messages", "new.id = 'm3'");
  check(throws(() => tables.checkpoint(state)) && ids().join() === "m1" && at() === 1, "a checkpoint whose last write fails keeps nothing of it, and stays where it was");
  allow(db, "no_m3");
  tables.checkpoint(state);
  check(ids().join() === "m1,m2,m3" && at() === 3, "the next one writes what that one had written before it failed (m2), not only what it hadn't");
  // A delete that rolls back is done by the next one, rather than its row coming back at the next start.
  state.messages.shift();
  state.seq = 4;
  refuse(db, "no_meta", "meta");
  check(throws(() => tables.checkpoint(state)) && ids().join() === "m1,m2,m3" && at() === 3, "a checkpoint that fails after deleting a row keeps the row");
  allow(db, "no_meta");
  tables.checkpoint(state);
  check(ids().join() === "m2,m3" && at() === 4, "the next one deletes it");
  closeSql(storage.file);
  storage.close();
}

// ---------- B and C. a machine's sync, through its CLI's uplink ----------
const accounts = { byId: (id) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
const work = createWork();
const relay = createRelay({ home: path.join(HOME, "server"), accounts, work });
const D = relay.device("dA", { name: "laptop", user_id: "u1" });
const cli = createStore({ file: path.join(HOME, "cli", "agentbook.db"), filesDir: path.join(HOME, "cli", "files"), legacy: false });
// As POST /api/cli/ops answers (server/api/cli.ts): what the server couldn't keep is a failure, 503.
const pushes = [];
const transport = {
  name: "test",
  hello: async (b) => relay.hello(D, b),
  push: async (b) => {
    const r = relay.ingest(D, structuredClone(b));
    pushes.push({ ops: (b.ops || []).map((o) => o.seq), state: !!b.state, ...r });
    if (r.unsaved) throw Object.assign(new Error(r.error), { status: 503 });
    return r;
  },
  commands: () => new Promise(() => {}),
  result: async () => ({}),
};
const up = createUplink({ store: cli, transport, onCommand: async () => ({}), epoch: "e1", retryMs: 0 });
const texts = () => D.store.state.messages.filter((m) => m.post === "s1").map((m) => m.text);
try {
  // C: its threads, the first time, onto a disk that's full.
  cli.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  cli.commit({ t: "message.add", post: "s1", from: "agent", text: "zero" });
  refuse(sql(D.store.file), "no_sessions", "sessions");
  await up.push();
  const first = pushes.at(-1);
  check(first?.state && first.unsaved && !Object.keys(D.store.state.sessions).length && !D.store.state.messages.length && D.cursor === 0, "a first sync the server can't write is refused, and nothing of it is taken");
  check(relay.hello(D).empty, "so the server still says it has nothing of this machine");
  allow(sql(D.store.file), "no_sessions");
  await up.push();
  check(!!D.store.state.sessions.s1 && texts().join() === "zero" && D.cursor === cli.state.seq, "sent again, it's taken");

  // B: three replies; the server can't log the second.
  for (const text of ["one", "two", "three"]) cli.commit({ t: "message.add", post: "s1", from: "agent", text });
  const [one, two] = [cli.state.seq - 2, cli.state.seq - 1];
  refuse(sql(D.store.file), "no_two", "events", `json_extract(new.op, '$.cli') = ${two}`);
  await up.push();
  const failed = pushes.at(-1);
  check(failed?.unsaved && failed.acked === one && D.cursor === one && texts().join() === "zero,one", "an op the server couldn't log isn't acked, nor the ones after it");
  allow(sql(D.store.file), "no_two");
  await up.push();
  check(texts().join() === "zero,one,two,three", "its CLI sends them again: each is there once, in order");
  check(D.cursor === cli.state.seq && relay.hello(D).cursor === cli.state.seq, "and the server's cursor is the CLI's last op");

  // A post's work the same.
  const steps = (n: number) => ({ t: "post.steps" as const, post: "s1", from: 0, total: n, steps: Array.from({ length: n }, (_, i) => ({ i, text: `step ${i}` })), turn: 1 });
  cli.commit(steps(1));
  await up.push();
  check(work.steps(D, "s1")?.steps.length === 1, "a post's steps go up");
  refuse(sql(D.store.file), "no_steps", "work_steps");
  cli.commit(steps(2));
  await up.push();
  check(pushes.at(-1)?.unsaved && D.cursor === cli.state.seq - 1 && work.steps(D, "s1")?.steps.length === 1, "steps the server couldn't write aren't acked");
  allow(sql(D.store.file), "no_steps");
  await up.push();
  check(work.steps(D, "s1")?.steps.length === 2 && D.cursor === cli.state.seq, "and go again");
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  for (const X of relay.devices.values()) X.store.close?.();
  cli.close();
}

// ---------- D. a server restored from a backup, while its machine's CLI runs on ----------
// The backup has a machine's changes up to one; the CLI had sent the next since. Back from the backup, the server has
// less than it acknowledged: the CLI sends what it lost again from its log, and its posts' work (onFresh).
{
  const home = path.join(HOME, "d");
  const serverHome = path.join(home, "server");
  fs.mkdirSync(serverHome, { recursive: true });
  let server = createRelay({ home: serverHome, accounts, work: createWork() });
  let device = server.device("dD", { name: "laptop", user_id: "u1" });
  const store = createStore({ file: path.join(home, "cli", "agentbook.db"), filesDir: path.join(home, "cli", "files"), legacy: false, acks: true });
  let down = false;
  let fresh = 0;
  const t = {
    name: "test",
    hello: async (b) => server.hello(device, b),
    push: async (b) => {
      if (down) throw new Error("connection refused");
      const r = server.ingest(device, structuredClone(b));
      if (r.unsaved) throw Object.assign(new Error(r.error), { status: 503 });
      return r;
    },
    commands: () => new Promise(() => {}),
    result: async () => ({}),
  };
  const upD = createUplink({ store, transport: t, onCommand: async () => ({}), epoch: "e2", onFresh: () => fresh++, retryMs: 0 });
  const said = () => device.store.state.messages.filter((m) => m.post === "s2").map((m) => m.text);
  try {
    store.commit({ t: "session.hello", proc: "p2", session_id: "s2", agent: "claude", label: "wren", kind: "claude-code" });
    store.commit({ t: "message.add", post: "s2", from: "agent", text: "one" });
    await upD.push();
    check(said().join() === "one" && store.acked() === store.state.seq, "a machine's first sync is acked, and its store keeps what the server has");
    const backup = path.join(home, "backup");
    backupData({ from: serverHome, to: backup });
    store.commit({ t: "message.add", post: "s2", from: "agent", text: "two" });
    await upD.push();
    check(said().join() === "one,two" && store.acked() === store.state.seq, "a reply after the backup goes up");
    // The server goes down; a reply waits; the server comes back from the backup.
    down = true;
    store.commit({ t: "message.add", post: "s2", from: "agent", text: "three" });
    await upD.push();
    check(!upD.status().connected, "with the server down, it waits");
    for (const X of server.devices.values()) X.store.close?.();
    server = createRelay({ home: backup, accounts, work: createWork() });
    device = server.device("dD", { name: "laptop", user_id: "u1" });
    check(said().join() === "one", "the restored server has only what the backup had");
    const freshBefore = fresh;
    down = false;
    await upD.push();
    check(said().join() === "one,two,three", "back, the CLI sends it what it lost (two) with what waited (three), each once, in order");
    check(device.cursor === store.state.seq && store.acked() === store.state.seq, "and the server's cursor and the CLI's are its last op again");
    check(fresh === freshBefore + 1, "its posts' work goes again too");
    check(!upD.status().gap, "with nothing missing from its log");
  } catch (e) {
    check(false, `crashed: ${e.stack}`);
  } finally {
    for (const X of server.devices.values()) X.store.close?.();
    store.close();
  }
}

// ---------- E. a machine's log keeps what its server doesn't have, however old ----------
{
  const home = path.join(HOME, "e");
  const store = createStore({ file: path.join(home, "cli", "agentbook.db"), filesDir: path.join(home, "cli", "files"), legacy: false, acks: true });
  const old = new Date(Date.now() - 31 * 86400e3).toISOString();
  const age = (s: Store, seq: number, at = old) => sql(s.file).prepare("update events set at = ? where scope = ? and seq = ?").run(at, s.scope, seq);
  const kept = (s: Store, seq: number) => s.since(seq - 1).some((op) => op.seq === seq);
  try {
    store.commit({ t: "session.hello", proc: "p3", session_id: "s3", agent: "claude", label: "wren", kind: "claude-code" });
    store.commit({ t: "message.add", post: "s3", from: "agent", text: "sent" });
    const sent = store.state.seq;
    store.setAcked(sent);
    store.commit({ t: "message.add", post: "s3", from: "agent", text: "not sent yet" });
    const unsent = store.state.seq;
    age(store, sent);
    age(store, unsent);
    store.checkpoint(true);
    check(kept(store, unsent), "an op its server hasn't acknowledged stays in the log, 31 days old");
    check(!kept(store, sent), "one it has, as old, goes");
    check(store.pruned() === sent, "and the log says how far back it goes");
    store.setAcked(unsent);
    store.commit({ t: "message.add", post: "s3", from: "agent", text: "next" });
    store.checkpoint();
    check(!kept(store, unsent), "once the server has it, it goes at the next checkpoint");
    // What the server has goes after a week (AGENTBOOK_LOG_DAYS), not 30 days: a backup restored from up to a week ago
    // still gets it back.
    store.commit({ t: "message.add", post: "s3", from: "agent", text: "a week ago" });
    const week = store.state.seq;
    store.commit({ t: "message.add", post: "s3", from: "agent", text: "five days ago" });
    const five = store.state.seq;
    age(store, week, new Date(Date.now() - 8 * 86400e3).toISOString());
    age(store, five, new Date(Date.now() - 5 * 86400e3).toISOString());
    store.setAcked(five);
    store.checkpoint(true);
    check(!kept(store, week) && kept(store, five), "an op the server has goes from the log after a week, not 30 days");
    // A store with no server to send to (agentbook-server's own) prunes as before.
    const plain = createStore({ file: path.join(home, "server", "agentbook.db"), filesDir: path.join(home, "server", "files"), legacy: false });
    plain.commit({ t: "session.hello", proc: "p4", session_id: "s4", agent: "claude", label: "wren", kind: "claude-code" });
    plain.commit({ t: "message.add", post: "s4", from: "agent", text: "old" });
    age(plain, plain.state.seq);
    plain.checkpoint(true);
    check(!kept(plain, plain.state.seq), "a server's own store prunes what its checkpoint covers, as before");
    plain.close();
  } catch (e) {
    check(false, `crashed: ${e.stack}`);
  } finally {
    store.close();
  }
}

closeSql();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
