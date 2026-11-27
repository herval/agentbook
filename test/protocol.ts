#!/usr/bin/env node
// The protocol between agentbook-cli and agentbook-server, checked
// without either running: every kind has a schema, and a bad op or command is refused; ops sent again after a
// dropped connection don't double; and a machine's ops reach only its own things, never another machine's.
// Run: node test/protocol.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand, COMMANDS, OPS, opFrom, READS, stateFrom } from "../plugin/shared/protocol.ts";
import { createRelay } from "../server/relay.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// ---------- every kind has a schema ----------
check(Object.entries(OPS).every(([k, o]) => o.t && o.fields && typeof o.fields === "object"), `every op kind says what it is and what it takes (${Object.keys(OPS).length} kinds)`);
check(Object.entries(COMMANDS).every(([, c]) => c.fields && c.steer && c.expires > 0), `every command takes only its fields, steers its machine, and runs out of time waiting for one that's off (${Object.keys(COMMANDS).length} kinds)`);
check(Object.values(READS).every((r) => r.fields && typeof r.owner === "boolean"), `every read takes only its fields and says whether only the machine's owner may ask (${Object.keys(READS).length} kinds)`);

// ---------- a bad op is refused ----------
const at = new Date().toISOString();
const op = (kind, args, seq = 1) => ({ kind, seq, at, args });
check(opFrom(op("shell.run", { cmd: "rm -rf /" })).error?.includes("isn't an op"), "an op of a kind the server doesn't take is refused");
check(opFrom({ kind: "post.post", at, args: { post: "p1", title: "x" } }).error?.includes("no number"), "and one without its number");
check(opFrom({ kind: "post.post", seq: 1, at: "yesterday", args: { post: "p1", title: "x" } }).error?.includes("when"), "and one that doesn't say when");
check(opFrom(op("post.post", { post: "p1", title: 42 })).error?.includes("title"), "and one with a field of the wrong kind");
check(opFrom(op("post.post", { post: "p1", title: "x".repeat(5000) })).error?.includes("too long"), "and one with a field too big");
const extra = opFrom(op("post.post", { post: "p1", title: "Fine", from_the_future: true }));
check(!extra.error && extra.op.title === "Fine" && !("from_the_future" in extra.op), "a field it doesn't know is dropped, so a newer CLI still talks to an older server");

// ---------- a bad command is refused ----------
check(checkCommand({ cid: "c1", kind: "shell.run", args: {} })?.includes("isn't a command"), "a command of a kind the CLI doesn't take is refused");
check(checkCommand({ cid: "c1", kind: "post.stop", args: { post: "p1", also: "this" } })?.includes("isn't something it takes"), "and one with a field its kind doesn't take");
check(checkCommand({ cid: "c1", kind: "post.stop", args: {} })?.includes("missing"), "and one missing a field");
check(checkCommand({ cid: "c1", kind: "post.stop", args: { post: "p1" } }) === null, "a good one goes through");

// ---------- the server's side: ops once each, each machine its own ----------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-protocol-"));
const users = { u1: { id: "u1", username: "herval" }, u2: { id: "u2", username: "alice" } };
const accounts = { byId: (id) => users[id] || null, deviceById: () => null };
const relay = createRelay({ home: HOME, accounts });
try {
  const A = relay.device("dA", { name: "laptop", user_id: "u1" });
  const B = relay.device("dB", { name: "desk", user_id: "u2" });
  const batch = [
    op("post.hello", { proc: "box-1", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "wren", session_id: "p1" }, 1),
    op("post.post", { post: "p1", title: "Fix the importer" }, 2),
    op("message.add", { post: "p1", mid: "m3", from: "human", via: "dash", text: "go" }, 3),
  ];
  relay.ingest(A, { ops: batch });
  // The connection dropped before the answer: the CLI sends them again, with the next one.
  const again = relay.ingest(A, { ops: [...batch, op("message.add", { post: "p1", mid: "m4", from: "agent", via: "dash", text: "done" }, 4)] });
  const msgs = A.store.state.messages.filter((m) => m.post === "p1");
  check(again.acked === 4 && msgs.length === 2 && msgs.map((m) => m.text).join(",") === "go,done", "ops sent again after a dropped connection are applied once: nothing doubles");
  check(A.store.state.sessions.p1?.title === "Fix the importer", "and what they say is there");

  // Another machine, another person's: its ops about p1 change only its own things.
  relay.ingest(B, { ops: [op("post.post", { post: "p1", title: "Hijacked" }, 1), op("message.add", { post: "p1", mid: "m9", from: "agent", via: "dash", text: "not yours" }, 2)] });
  check(A.store.state.sessions.p1.title === "Fix the importer" && !A.store.state.messages.some((m) => m.text === "not yours"), "a machine's ops about another's post never reach it");
  check(!B.store.state.sessions.p1 && relay.resolve("p1")?.D === A, "and don't make one of their own: the post is still the first machine's");

  // One machine's id another already has: the page's id for it says whose it is.
  relay.ingest(B, { ops: [op("post.hello", { proc: "box-9", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "kite", session_id: "p1" }, 3)] });
  check(B.store.state.sessions.p1 && relay.idOf(B, "p1") === "desk~p1" && relay.resolve("desk~p1")?.D === B && relay.resolve("p1")?.D === A, "the same id on two machines is two posts, the second with its machine's name in front");

  const mixed = relay.ingest(A, { ops: [op("nope.nope", {}, 5), op("post.post", { post: "p1", title: "Fixed the importer", rename: true }, 6)] });
  check(mixed.acked === 6 && /isn't an op/.test(mixed.error || "") && A.store.state.sessions.p1.title === "Fixed the importer", "a bad op in a batch is refused, and the rest goes on");

  // A machine's whole state, as it sends it to a page it links to first (relay takeState): a thread that stopped on an
  // error keeps how, as an object, and the page takes it.
  relay.ingest(A, { ops: [op("post.status", { post: "p1", state: "idle", failed: "rate_limit", text: "You've hit your limit" }, 7)] });
  const stopped = A.store.state.sessions.p1;
  const whole = stateFrom({ seq: 7, sessions: { p1: stopped } });
  check(stopped.failed?.error === "rate_limit" && !whole.error, `a machine's whole state with a thread that stopped on an error is taken (${whole.error || "taken"})`);
  check(/failed/.test(stateFrom({ seq: 7, sessions: { p1: { ...stopped, failed: 42 } } }).error || ""), "and one whose failed is neither that nor nothing is refused");
} catch (e) {
  check(false, `test crashed: ${e.stack}`);
} finally {
  for (const D of relay.devices.values()) D.store.close?.();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
