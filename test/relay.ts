#!/usr/bin/env node
// What agentbook-server keeps of what it reads from a machine, checked on the
// relay itself, with a stand-in for the machine's CLI: a read is asked of the machine whenever it's on; while it's
// off, the last answer shows, with when it was read, or the machine is off; what never changes (a commit) is read
// once; what's read for a moment (a preview's file) isn't kept; and a machine logged out takes it all with it.
// Who may ask for a read is the page's to decide (privacy.ts and multiuser.ts check it).
// Run: node test/relay.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelay, type QueuedCommand } from "../server/relay.ts";
import type { CommandAnswer } from "../server/storage/relay.ts";
import type { Json } from "./harness-types.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-relay-"));
const accounts = { byId: (id: string) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
const relay = createRelay({ home: HOME, accounts });
const D = relay.device("dA", { name: "laptop", user_id: "u1" });

// The machine: on (it polls), or off (it stopped). While on, it answers what it's asked, counting each.
const asked: string[] = [];
// What the machine answers each command or read with.
let answer = (c: QueuedCommand): CommandAnswer => ({ when: Date.now(), kind: c.kind });
let on = false;
const turnOn = () => {
  on = true;
  D.seen = Date.now();
  D.polled = Date.now();
};
const turnOff = () => {
  on = false;
  D.seen = 0;
  D.polled = 0;
};
(async () => {
  for (;;) {
    if (!on) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    D.seen = D.polled = Date.now();
    const list = await relay.takeCommands(D, 200, { closed: false });
    for (const c of list) {
      asked.push(c.kind);
      relay.result(D, c.cid, answer(c));
    }
  }
})();

try {
  turnOn();
  const first: Json = await relay.read(D, "read.folders", { path: "/x" });
  check(!first.error && first.data?.kind === "read.folders" && !first.cached && asked.length === 1, "a read is asked of its machine while it's on");
  const second: Json = await relay.read(D, "read.folders", { path: "/x" });
  check(!second.cached && asked.length === 2 && second.data.when >= first.data.when, "every time: what a folder holds changes");

  turnOff();
  const off: Json = await relay.read(D, "read.folders", { path: "/x" });
  check(off.cached && off.offline && off.data.when === second.data.when && off.fetched && asked.length === 2, "while it's off, the last answer shows, with when it was read, and nothing is asked");
  const none = await relay.read(D, "read.folders", { path: "/elsewhere" });
  check(none.error === "laptop is off." && none.status === 503 && none.offline, "a read it never answered says the machine is off");

  turnOn();
  const c1 = await relay.read(D, "read.commit", { post: "p1", sha: "abc123" });
  const c2 = await relay.read(D, "read.commit", { post: "p1", sha: "abc123" });
  check(!c1.cached && c2.cached && asked.filter((k) => k === "read.commit").length === 1, "what never changes (a commit) is read once, and kept");

  const p1 = await relay.read(D, "read.peek", { root: "/x", path: "a.html" });
  turnOff();
  const p2 = await relay.read(D, "read.peek", { root: "/x", path: "a.html" });
  check(!p1.error && !p1.cached && p2.error && p2.offline, "what's read for a moment (a preview's file) isn't kept");

  // A failure isn't kept over the last good answer.
  turnOn();
  answer = () => ({ error: "git broke", status: 500 });
  const bad = await relay.read(D, "read.folders", { path: "/x" });
  turnOff();
  const after: Json = await relay.read(D, "read.folders", { path: "/x" });
  check(bad.error === "git broke" && after.cached && after.data.when === second.data.when, "a failed read doesn't replace the last good answer");

  // A signed command waiting for a machine that's off keeps its signature, through a restart too;
  // the same one sent again isn't queued twice.
  turnOff();
  await new Promise((r) => setTimeout(r, 400)); // the stand-in's last wait for commands ends
  const envelope = { v: 1, machine: "mLaptop", cid: "sTestSigned001", kind: "post.stop", args: { post: "p1" }, by: "herval", at: new Date().toISOString(), expires: new Date(Date.now() + 60e3).toISOString() };
  const signed = { envelope, sig: { key: "k1", authenticatorData: "a", clientDataJSON: "c", signature: "s" } };
  const queued = await relay.command(D, "post.stop", null, { by: "herval", wait: 0, signed });
  const waitingNow = D.queue.find((c) => c.cid === envelope.cid);
  // A queued command's signature is the page's, kept as it came: the machine checks it, not the server.
  const signatureOf = (c: QueuedCommand | undefined) => {
    const sig = c?.sig;
    return sig && typeof sig === "object" && "signature" in sig ? sig.signature : undefined;
  };
  const restarted = createRelay({ home: HOME, accounts });
  const back = restarted.device("dA", { name: "laptop", user_id: "u1" }).queue.find((c) => c.cid === envelope.cid);
  const twice = await relay.command(D, "post.stop", null, { by: "herval", wait: 0, signed });
  check(queued.queued === envelope.cid && signatureOf(waitingNow) === "s" && waitingNow.machine === "mLaptop" && waitingNow.expires === envelope.expires, "a signed command waits for its machine as it was signed: its id, times and signature");
  check(signatureOf(back) === "s" && back.v === 1 && back.machine === "mLaptop", "and still has its signature after a restart");
  check(twice.status === 409, "the same signed command sent again isn't queued twice");

  // Logged out: nothing of it stays.
  relay.forget(D);
  const gone = await relay.read(D, "read.folders", { path: "/x" });
  const goneCommit = await relay.read(D, "read.commit", { post: "p1", sha: "abc123" });
  check(gone.error && goneCommit.data === undefined && !goneCommit.cached, "a machine logged out takes what was read from it with it, commits too");
} catch (e) {
  check(false, `test crashed: ${e.stack}`);
} finally {
  D.store.close?.();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
