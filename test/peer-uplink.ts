#!/usr/bin/env node
// A machine's threads going to another machine of yours (linked, server/mesh.ts) as well as to its own
// page: a second uplink, `peer` (plugin/cli/uplink.ts). The peer's page gets the threads, their conversations and
// questions, as the machine's own page does, but not their work (steps, pictures, changes), which it asks the machine
// for when it's opened. How far a peer has got never lets the machine's log forget anything: only its own page's
// acks do. Both pages here are relays in this process, as in test/durability.ts.
// Run: node test/peer-uplink.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelay } from "../server/relay.ts";
import { createWork } from "../server/work.ts";
import { createStore } from "../plugin/shared/store.ts";
import { createUplink } from "../plugin/cli/uplink.ts";
import type { Command, Transport } from "../plugin/cli/uplink.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-peer-uplink-"));
const accounts = { byId: (id: string) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };

// A page: its relay, and this machine as one of its machines.
function page(name: string) {
  const work = createWork();
  const relay = createRelay({ home: path.join(HOME, name), accounts, work });
  const D = relay.device(`d-${name}`, { name: "laptop", user_id: "u1" });
  const pushed: { ops: string[]; state: boolean }[] = [];
  const transport: Transport = {
    name,
    hello: async (b) => relay.hello(D, b),
    push: async (b: { ops?: { kind: string }[]; state?: unknown }) => {
      pushed.push({ ops: (b.ops || []).map((o) => o.kind), state: !!b.state });
      return relay.ingest(D, structuredClone(b));
    },
    commands: () => new Promise(() => {}),
    result: async () => ({}),
  };
  return { relay, D, work, transport, pushed };
}

const cli = createStore({ file: path.join(HOME, "cli", "agentbook.db"), filesDir: path.join(HOME, "cli", "files"), legacy: false, acks: true });
const own = page("own");
const peer = page("peer");
const mine = createUplink({ store: cli, transport: own.transport, onCommand: async () => ({}), epoch: "e1", retryMs: 0 });
const theirs = createUplink({ store: cli, transport: peer.transport, onCommand: async () => ({}), epoch: "e1", retryMs: 0, peer: "beta" });
const steps = (n: number) => ({ t: "post.steps" as const, post: "s1", from: 0, total: n, steps: Array.from({ length: n }, (_, i) => ({ i, text: `step ${i}` })), turn: 1 });
const workOps = () => cli.since(0).filter((o) => o.t === "post.steps").length;

try {
  cli.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  cli.commit({ t: "message.add", post: "s1", from: "human", text: "look at the tests" });

  // The peer first, before the machine's own page has anything.
  await theirs.push();
  check(!!peer.D.store.state.sessions.s1 && peer.D.store.state.messages.some((m) => m.text === "look at the tests"), "a peer's page gets the machine's threads and their conversations");
  check(peer.pushed[0]?.state, "the first time, all at once, as its own page would");
  check(cli.acked() === 0 && cli.held().beta === cli.state.seq, "what the peer has is kept apart from what its own page has: the log keeps what either hasn't got");
  await mine.push();
  check(cli.acked() === cli.state.seq, "what its own page has does");

  cli.commit(steps(2));
  cli.commit({ t: "message.add", post: "s1", from: "agent", text: "they pass" });
  await theirs.push();
  check(peer.D.store.state.messages.some((m) => m.text === "they pass"), "what comes next goes to it as ops");
  check(!peer.pushed.some((p) => p.ops.includes("post.steps")) && !peer.work.steps(peer.D, "s1"), "but not the thread's work: its page asks the machine for that");
  check(peer.D.cursor === cli.state.seq && cli.held().beta === cli.state.seq, "and it's still up to date: what was left out counts as gone");
  check(workOps() === 1, "the work stays in the machine's log, for its own page");

  await mine.push();
  check(own.work.steps(own.D, "s1")?.steps.length === 2 && own.D.store.state.messages.some((m) => m.text === "they pass"), "the machine's own page gets everything, its work too");
  check(cli.acked() === cli.state.seq && workOps() === 0, "and once it has it, the log forgets the work, as before");

  // A peer that has nothing of the machine yet (linked later) gets its threads whole, without any work.
  const late = page("late");
  const lateUp = createUplink({ store: cli, transport: late.transport, onCommand: async () => ({}), epoch: "e1", retryMs: 0, peer: "gamma" });
  cli.commit(steps(3));
  await lateUp.push();
  check(!!late.D.store.state.sessions.s1 && late.pushed[0]?.state && !late.work.steps(late.D, "s1"), "a peer linked later gets the threads whole, without their work");

  cli.hold("gamma", null);
  check(!("gamma" in cli.held()) && "beta" in cli.held(), "a machine unlinked: the log keeps nothing more for it");

  // Each page numbers its commands itself, so two pages can send the same id: the machine runs each, and answers
  // each with what its own did, never with what it did for the other page. A signed one's id is random and signed for
  // this machine, so it runs once, whichever page brings it.
  const fromTwoPages = async (cmd: { cid: string; sig?: unknown }) => {
    const answers: Record<string, unknown> = {};
    const ranFor: string[] = [];
    const commandFrom = (name: string, base: Transport): Transport => {
      let sent = false;
      return {
        ...base,
        commands: async () => (sent ? new Promise(() => {}) : ((sent = true), [{ kind: "post.stop", args: { post: "s1" }, by: "herval", at: new Date().toISOString(), expires: new Date(Date.now() + 60e3).toISOString(), ...cmd }] as Command[])),
        result: async (cid: string, r: unknown) => void (answers[name] = r),
      };
    };
    const ownCmd = createUplink({ store: cli, transport: commandFrom("own", own.transport), onCommand: async () => (ranFor.push("own"), { from: "own" }), epoch: "e1", retryMs: 0 });
    const peerCmd = createUplink({ store: cli, transport: commandFrom("peer", peer.transport), onCommand: async () => (ranFor.push("peer"), { from: "peer" }), epoch: "e1", retryMs: 0, peer: "beta" });
    ownCmd.start();
    await new Promise((r) => setTimeout(r, 300));
    peerCmd.start();
    for (let i = 0; i < 50 && Object.keys(answers).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    ownCmd.stop();
    peerCmd.stop();
    return { answers, ranFor };
  };
  const same = await fromTwoPages({ cid: "c-same" });
  check(same.ranFor.length === 2 && (same.answers.own as { from?: string })?.from === "own" && (same.answers.peer as { from?: string })?.from === "peer", `the same command id from two pages runs for each, each answered with its own (${JSON.stringify(same.answers)})`);
  const signedTwice = await fromTwoPages({ cid: "sQx7Rk2b9Lm4Np0Vw8Yz", sig: { key: "k1", sig: "x" } });
  check(signedTwice.ranFor.length === 1 && (signedTwice.answers.peer as { from?: string })?.from === "own", `a signed command brought by two pages runs once, the second answered with what it did (${JSON.stringify(signedTwice)})`);
  const claimed = await fromTwoPages({ cid: "c-claimed", sig: { key: "k1", sig: "x" } });
  check(claimed.ranFor.length === 2 && (claimed.answers.peer as { from?: string })?.from === "peer", `but a page that puts a signature on another kind of id doesn't get the other page's answer for it (${JSON.stringify(claimed.answers)})`);

  // A peer unlinked (or linked again with a new token) stops for good.
  theirs.stop();
  cli.commit({ t: "message.add", post: "s1", from: "agent", text: "after it stopped" });
  await theirs.push();
  check(!peer.D.store.state.messages.some((m) => m.text === "after it stopped"), "a peer's uplink, stopped, sends nothing more");
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
