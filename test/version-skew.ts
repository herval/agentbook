#!/usr/bin/env node
// A machine and its server on different versions. What's shipped can't be fixed later, so the two say what they are:
// a machine too old is told to update, a command fits what the machine takes before anyone signs it, what the server
// can't take yet is kept for when it can, and a refused first state isn't marked as sent.
// Run: node test/version-skew.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelay } from "../server/relay.ts";
import { createWork } from "../server/work.ts";
import { createStore } from "../plugin/shared/store.ts";
import { createUplink } from "../plugin/cli/uplink.ts";
import { COMMANDS, OPS, takenFields } from "../plugin/shared/protocol.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-skew-")));
const accounts = { byId: (id) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
const server = (opts = {}) => createRelay({ home: path.join(HOME, "server"), accounts, work: createWork(), ...opts });
const storeAt = (name) => createStore({ file: path.join(HOME, name, "agentbook.db"), filesDir: path.join(HOME, name, "files"), legacy: false, acks: true });

try {
  // ---------- what a machine takes ----------
  let relay = server();
  let D = relay.device("d1", { name: "laptop", user_id: "u1" });
  check(!!relay.fit(D, "post.deliver", { post: "p", text: "hi", queue: true }).args?.queue, "a machine that hasn't said what it takes gets a command as it is");
  const takes = takenFields();
  check(takes["post.start"].includes("root") && !takes["post.start"].some((f) => f.endsWith("?")), "a machine says each command's fields by name");
  takes["post.deliver"] = takes["post.deliver"].filter((f) => f !== "queue");
  delete takes["term.lease"];
  const said = relay.hello(D, { epoch: "e1", protocol: 1, version: "0.3.40", takes });
  check(said.protocol === 1 && said.min === 1 && said.theirs === 1, "hello says the protocol and the oldest it talks to");
  const fitted = relay.fit(D, "post.deliver", { post: "p", text: "hi", queue: true });
  check(fitted.args && !("queue" in fitted.args) && fitted.args.text === "hi", "an optional field it doesn't know stays off");
  check(/too old/.test(relay.fit(D, "term.lease", { tid: "t1" }).error || ""), "a command it doesn't know won't do, and says why");
  takes["post.deliver"] = takes["post.deliver"].filter((f) => f !== "post");
  relay.hello(D, { epoch: "e1", protocol: 1, takes });
  check(/too old/.test(relay.fit(D, "post.deliver", { post: "p", text: "hi" }).error || ""), "nor a field it needs");
  const sent = await relay.command(D, "term.lease", { tid: "t1" }, { wait: 10 });
  check(sent.status === 426 && /too old/.test(sent.error), "a command for it is refused where it's sent, not lost on the way");
  takes["post.deliver"].push("post");
  relay.hello(D, { epoch: "e1", protocol: 1, takes });
  relay.command(D, "post.deliver", { post: "p", text: "hi", queue: true }, { wait: 10 }).catch(() => {});
  check(D.queue.at(-1)?.kind === "post.deliver" && !("queue" in D.queue.at(-1).args), "and what's queued for it fits it");
  check(COMMANDS["term.lease"], "(this server does know term.lease)");

  for (const D of relay.devices.values()) D.store.close(); // the server stops
  relay = server();
  D = relay.device("d1", { name: "laptop", user_id: "u1" });
  check(!("queue" in (relay.fit(D, "post.deliver", { post: "p", text: "hi", queue: true }).args || {})), "what it takes survives a restart of the server, which it doesn't say hello for");

  // ---------- too old ----------
  const strict = server({ minProtocol: 2 });
  const late = strict.device("d2", { name: "old", user_id: "u1" });
  const refused = strict.hello(late, { epoch: "e2", protocol: 1 });
  check(refused.outdated && refused.min === 2, "a machine older than the oldest it talks to is told so");
  const oldStore = storeAt("old");
  oldStore.commit({ t: "session.hello", proc: "p", session_id: "s", agent: "claude", label: "wren", kind: "claude-code" });
  const up426 = createUplink({ store: oldStore, epoch: "e", onCommand: async () => ({}), transport: { name: "srv", hello: async () => { throw Object.assign(new Error("This agentbook-cli is too old for this server: update it."), { status: 426 }); }, push: async () => ({}), commands: () => new Promise(() => {}), result: async () => ({}) } });
  await up426.push();
  check(/too old/.test(up426.status().blocked || ""), `and status says that, not that it can't reach it (${JSON.stringify(up426.status()).slice(0, 120)})`);

  // ---------- an op this server can't take yet ----------
  const newer = relay.device("d3", { name: "newer", user_id: "u1" });
  relay.hello(newer, { epoch: "e3", protocol: 1 });
  relay.ingest(newer, { epoch: "e3", ops: [
    { kind: "post.hello", seq: 1, at: new Date().toISOString(), args: { proc: "p1", agent: "claude", label: "wren", kind: "claude-code", session_id: "s1" } },
  ] });
  check(!!newer.store.state.sessions.s1, "(a thread to write to)");
  const future = { kind: "message.future", seq: 2, at: new Date().toISOString(), args: { post: "s1", mid: "m2", from: "agent", text: "from a newer machine" } };
  const r = relay.ingest(newer, { epoch: "e3", ops: [future] });
  check(/isn't an op/.test(r.error) && r.acked === 2 && r.parked === 1, `it's acknowledged and kept, not lost (${JSON.stringify(r).slice(0, 140)})`);
  check(!newer.store.state.messages.some((m) => m.text === "from a newer machine"), "and doesn't reach the thread yet");
  for (const D of relay.devices.values()) D.store.close(); // the server stops
  OPS["message.future"] = OPS["message.add"]; // the update
  relay = server();
  const back = relay.device("d3", { name: "newer", user_id: "u1" });
  const after = relay.hello(back, { epoch: "e3", protocol: 1 });
  check(after.parked === 0 && back.store.state.messages.some((m) => m.text === "from a newer machine"), "after an update of the server it's in the thread");
  delete OPS["message.future"];

  // ---------- a refused first state ----------
  const store = storeAt("first");
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  let refuse = true;
  const pushes = [];
  const transport = { name: "srv", hello: async () => ({ cursor: 0, empty: true }), push: async (b) => (pushes.push(b), b.state && refuse ? { acked: 0, error: "a thread's prompt isn't text" } : { acked: store.state.seq }), commands: () => new Promise(() => {}), result: async () => ({}) };
  const up = createUplink({ store, transport, epoch: "e4", onCommand: async () => ({}) });
  await up.push();
  check(up.status().cursor === null && !up.status().connected, "a refused state is a failure: nothing counts as sent");
  check(/didn't take this machine's threads/.test(up.status().blocked || ""), "and status says it");
  check(store.acked() === 0, "and the machine still holds it to send");
  await up.push();
  check(pushes.filter((p) => p.state).length === 1, "it isn't offered again at once: that's every thread it has");
} catch (e) {
  check(false, `crashed: ${e.stack}`);
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
