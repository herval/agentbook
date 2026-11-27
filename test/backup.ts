#!/usr/bin/env node
// `agentbook-server backup` while a machine syncs. A second process runs a real
// relay and a machine's uplink on a data folder, as agentbook-server does, sending a message every few ms; this one
// backs that folder up meanwhile, waiting after each database it copies so batches would land between copies.
// The copy has to be one moment: a machine's cursor in relay.db never past the ops its devices/<id>.db has, so a
// server restored from it asks the machine for everything after what it really has. And the machine's sync only
// waits meanwhile: none of its batches is refused.
// Run: node test/backup.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "../server/relay.ts";
import { createWork } from "../server/work.ts";
import { backupData } from "../server/backup.ts";
import { createStore } from "../plugin/shared/store.ts";
import { DatabaseSync } from "./harness-sql.ts";
import { createUplink } from "../plugin/cli/uplink.ts";
import { spawnTied } from "./harness.ts";

const accounts = { byId: (id) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- the second process: a server's relay and a machine sending to it ----------
if (process.argv[2] === "--machine") {
  const home = process.argv[3];
  fs.mkdirSync(path.join(home, "server"), { recursive: true });
  const relay = createRelay({ home: path.join(home, "server"), accounts, work: createWork() });
  const D = relay.device("dA", { name: "laptop", user_id: "u1" });
  const cli = createStore({ file: path.join(home, "cli", "agentbook.db"), filesDir: path.join(home, "cli", "files"), legacy: false });
  let refused = 0;
  const transport = {
    name: "test",
    hello: async (b) => relay.hello(D, b),
    push: async (b) => {
      const r = relay.ingest(D, structuredClone(b));
      if (r.unsaved) {
        refused++;
        throw Object.assign(new Error(r.error), { status: 503 });
      }
      return r;
    },
    commands: () => new Promise(() => {}),
    result: async () => ({}),
  };
  const up = createUplink({ store: cli, transport, onCommand: async () => ({}), epoch: "e1", retryMs: 0 });
  cli.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  const stop = path.join(home, "stop");
  const end = Date.now() + 30e3;
  for (let i = 1; !fs.existsSync(stop) && Date.now() < end; i++) {
    cli.commit({ t: "message.add", post: "s1", from: "agent", text: `m${i}` });
    await up.push().catch(() => {});
    console.log(JSON.stringify({ cursor: D.cursor, refused }));
    await new Promise((r) => setTimeout(r, 3));
  }
  process.exit(0);
}

// ---------- this process: back it up while it runs ----------
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-backup-"));
const machine = spawnTied(process.execPath, [fileURLToPath(import.meta.url), "--machine", HOME], { stdio: ["ignore", "pipe", "inherit"] });
let last = { cursor: 0, refused: 0 };
let buf = "";
machine.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    try {
      last = JSON.parse(buf.slice(0, i));
    } catch {}
  }
});
const until = async (cond, ms = 15e3) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
const relayCursor = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("select seq from cursors where device = 'dA'").get() as { seq: number } | undefined)?.seq || 0;
  } finally {
    db.close();
  }
};
try {
  check(await until(() => last.cursor >= 30), `the machine syncs (${last.cursor} ops in)`);
  const from = path.join(HOME, "server");
  const to = path.join(HOME, "copy");
  const before = last.cursor;
  // 300 ms after each copy, inside the backup: a dozen batches would land between two copies.
  const n = backupData({ from, to, copied: () => sleep(300) });
  check(n.databases === 1 && n.held >= 300, `it copies its one database (storage.db: the relay's tables and every machine's store), holding its lock (${n.databases}, ${n.held} ms)`);
  check(await until(() => last.cursor > before + 20), `the machine's sync went on after (${before} → ${last.cursor})`);
  check(last.refused === 0, `none of its batches was refused while it waited (${last.refused})`);

  // The copy: its cursor for the machine is never past what its database has.
  const cursor = relayCursor(path.join(to, "storage.db"));
  const restored = createRelay({ home: to, accounts, work: createWork() });
  const R = restored.device("dA", { name: "laptop", user_id: "u1" });
  const has = R.store.tables.highest("cli");
  const texts = R.store.state.messages.filter((m) => m.post === "s1").map((m) => m.text);
  check(cursor > 0 && cursor <= has, `the copy's cursor (${cursor}) isn't past the ops it has (${has})`);
  check(R.cursor === has, `so a server restored from it asks the machine for everything after ${has} (it says ${R.cursor})`);
  check(texts.length === has - 1 && texts.every((t, i) => t === `m${i + 1}`), `and it has every message up to there, in order, none missing (${texts.length})`);
  for (const X of restored.devices.values()) X.store.close?.();

  // Guards.
  const throws = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e.message;
    }
  };
  check(/isn't empty/.test(throws(() => backupData({ from, to })) || ""), "a copy goes into an empty folder only");
  check(/put the copy somewhere else/.test(throws(() => backupData({ from, to: path.join(from, "backups", "x") })) || ""), "and never into the data folder it copies");
  fs.mkdirSync(path.join(from, "lost+found"), { mode: 0o000 });
  const third = path.join(HOME, "copy3");
  check(throws(() => backupData({ from, to: third })) === null && !fs.existsSync(path.join(third, "lost+found")), "a volume's lost+found (root's, unreadable) is left out");
  fs.rmSync(path.join(from, "lost+found"), { recursive: true, force: true });
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  fs.writeFileSync(path.join(HOME, "stop"), "");
  await until(() => machine.exitCode !== null, 5e3);
  machine.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
