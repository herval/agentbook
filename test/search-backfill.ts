#!/usr/bin/env node
// The search index's rebuilds (server/search.ts). A machine's info, which changes every few seconds, doesn't rebuild
// its index: it did whenever the machine's seq had moved past the cursor, which every op search skips makes it do,
// and that kept the server busy for seconds at a time, all day. A rebuild goes a batch a step, not all its threads
// and messages in one tick. A clean stop leaves nothing to build over at the next start; an unclean one rebuilds.
// And an op during a rebuild isn't written over by what the rebuild read before it.
// Run: node test/search-backfill.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSearch } from "../server/search.ts";
import type { Message, Session, State } from "../plugin/shared/types.ts";

type Options = Parameters<typeof createSearch>[0];
type Device = Parameters<ReturnType<typeof createSearch>["hearDevice"]>[0];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-search-backfill-"));
const at = new Date().toISOString();
const N = 1200;
const sessions: Record<string, Partial<Session>> = {};
const messages: Partial<Message>[] = [];
for (let i = 0; i < N; i++) {
  sessions[`p${i}`] = { id: `p${i}`, title: `thread ${i}`, updated: at, started: at };
  messages.push({ id: `m${i}`, post: `p${i}`, from: "human", text: `hello word${i}`, at });
}
const D = { id: "d1", store: { state: { sessions, messages, seq: 10, cold: null } } } as unknown as Device;
const relay = { devices: new Map([["d1", D]]), idOf: (_D: Device, local: string) => local, shadowed: () => false } as unknown as Options["relay"];
const state = { seq: 5, notes: {}, pages: {}, tasks: {}, groups: {}, talks: {}, group_notes: [] } as unknown as State;
const machine = D.store.state;

const count = (file: string, kind: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("select count(*) as n from docs where kind = ?").get(kind) as { n: number }).n;
  } finally {
    db.close();
  }
};
const open = (file: string) => createSearch({ file, relay, state });

// A first index, a step at a time (catchUp runs steps here, before the pump's own ticks get to).
const file = path.join(dir, "search.db");
let search = open(file);
search.catchUp(2); // the server's entities, then the machine's first batch of threads
check(count(file, "thread") === 500 && count(file, "msg") === 0, `a rebuild goes 500 a step: ${count(file, "thread")} threads, ${count(file, "msg")} messages after one`);
search.catchUp(100);
check(!search.isIndexing(), "it's built after enough steps");
check(count(file, "thread") === N && count(file, "msg") === N, `every thread and message is in it (${count(file, "thread")}, ${count(file, "msg")})`);

// Ops search skips move the machine's seq on; the info push that comes after them doesn't rebuild.
machine.seq = 20;
search.hearDevice(D, { t: "agent.visibility", id: "a1" });
search.hearDevice(D, null);
check(!search.isIndexing(), "a machine's info after an op search skips doesn't rebuild its index");
machine.seq = 25; // ops whose flush hasn't come yet
search.hearDevice(D, null);
check(!search.isIndexing(), "nor does one that comes before the flush moves the cursor up");

// A clean stop: nothing to build over at the next start.
machine.seq = 30;
search.hearDevice(D, { t: "agent.visibility", id: "a1" });
state.seq = 7;
search.hearServer({ t: "seen.mark" });
search.close();
search = open(file);
search.catchUp(0);
check(!search.isIndexing(), "after a clean stop, starting again rebuilds nothing");
search.close();

// An unclean one (ops it never flushed): it rebuilds.
machine.seq = 40;
search = open(file);
search.catchUp(0);
check(search.isIndexing(), "after ops it never flushed, starting again rebuilds");
search.catchUp(100);
check(!search.isIndexing(), "and that rebuild ends");

// A machine whose store started over is indexed whole again.
machine.seq = 3;
search.hearDevice(D, null);
check(search.isIndexing(), "a machine whose store started over (seq behind the cursor) is indexed whole");
search.catchUp(100);
search.close();

// A message dropped while a rebuild holds it in its batch doesn't come back.
const file2 = path.join(dir, "search2.db");
search = open(file2);
search.catchUp(5); // the server's, three batches of threads, the first of the messages in memory: it holds them all now
check(search.isIndexing() && count(file2, "msg") === 500, `the rebuild is part way through the messages (${count(file2, "msg")})`);
const gone = machine.messages.findIndex((m) => m.id === "m900");
machine.messages.splice(gone, 1);
search.hearDevice(D, { t: "message.drop", post: "p900", mids: ["m900"] });
search.flush();
search.catchUp(100);
check(!search.isIndexing(), "the rebuild ends");
check(search.messageDocsForWord("word900")?.length === 0, "a message dropped during a rebuild isn't put back by it");
check(search.messageDocsForWord("word901")?.length === 1, "the ones around it are in");
search.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
