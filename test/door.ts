#!/usr/bin/env node
// The door alone (plugin/door/): two doors, alice's and bob's, each its own process
// under Node's permission model, on 127.0.0.1 with no relay (AGENTBOOK_IROH=local's way), certified by a fake relay.
// Each page's side of door.db is played here (PageSide), as server/door.ts plays it. A hello gets the card and
// nothing else; what someone may send depends on how they stand with you; records arrive signed by their author; a
// message with an unknown kind, a field that isn't in its shape, a size over the limit, or a certificate for another
// door closes the connection; past a limit, slow_down; the same message twice is kept once; `all` goes to someone
// who sees your things as a connection starts; and the door can't read or write outside its folder, start a process
// or a worker, or make code from a string. It stops when the process that started it does.
// Run: node test/door.ts

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { BiStream, Connection, Endpoint } from "@number0/iroh";
import { fakeRelay } from "./fake-relay.ts";
import { PageSide } from "../plugin/shared/door/db.ts";
import { recordHolds } from "../plugin/shared/door/sign.ts";
import { spawnDoor, irohModule, type DoorProcess } from "../plugin/door/spawn.ts";
import { ALPN, frame, unframe, VERSION, type Message } from "../plugin/shared/door/wire.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 15e3): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

if (!irohModule()) {
  console.log("SKIP  iroh isn't installed here (npm install)");
  process.exit(0);
}
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ab-door-")));
const IROH_DIR = path.join(BASE, "iroh");
fs.mkdirSync(IROH_DIR);
const relay = await fakeRelay();
const lines: string[] = [];

interface Door {
  name: string;
  acct: string;
  dir: string;
  proc: DoorProcess;
  page: PageSide;
  key: string;
  nudge: () => void;
}
async function door(name: string): Promise<Door> {
  const dir = path.join(BASE, name, "door");
  const acct = crypto.randomUUID();
  const proc = spawnDoor({ dir, account: acct, relay: relay.url, iroh: { mode: "local", dir: IROH_DIR }, log: (l) => lines.push(`${name}: ${l}`), extra: ["--retry-ms", "500"] })!;
  const page = await until(() => (fs.existsSync(path.join(dir, "door.db")) ? new PageSide(path.join(dir, "door.db")) : null));
  const key = await until(() => page.self("key") && page.self("proof") && page.self("why") === "" && page.self("key"));
  if (!key) throw new Error(`${name}'s door didn't start: ${lines.join("\n")}`);
  const c = relay.certifyDoor(acct, key);
  page.setConfig("certificate", c.certificate);
  page.setConfig("handle", name);
  page.setConfig("card", JSON.stringify({ handle: name, name: name[0].toUpperCase() + name.slice(1), bio: `${name}'s bio` }));
  const sock = net.connect(page.self("socket")!);
  await new Promise((r) => sock.once("connect", r));
  const said: string[] = [];
  sock.on("data", (d) => said.push(d.toString()));
  return { name, acct, dir, proc, page, key, nudge: () => sock.write("outbox\n") };
}
const inbox = (d: Door, kind?: string) => d.page.inboxAfter(0, 1000).filter((r) => !kind || r.kind === kind);

const alice = await door("alice");
const bob = await door("bob");
try {
  check(alice.key !== bob.key && /^[A-Za-z0-9_-]{43}$/.test(alice.key), "each door made a key of its own");
  check(fs.statSync(path.join(alice.dir, "key.json")).mode % 0o1000 === 0o600, "kept in its folder, readable only by you");

  // ---------- a hello gets the card ----------
  bob.page.putPerson({ acct: alice.acct, handle: "alice", key: alice.key });
  const hi = bob.page.send(alice.acct, "hello", {});
  bob.nudge();
  const card = await until(() => inbox(bob, "card")[0]);
  check(card?.from_handle === "alice" && card.body.name === "Alice" && card.body.bio === "alice's bio", "bob's hello to alice's door brings her card, from her door");
  check(bob.page.sentOf(hi, alice.acct)?.error === null, "and the hello counts as sent");
  check(inbox(alice).length === 0, "alice keeps nothing of a hello");

  // ---------- what someone may send ----------
  const ask = bob.page.send(alice.acct, "ask", { note: "hi, it's bob" });
  bob.nudge();
  const asked = await until(() => inbox(alice, "ask")[0]);
  check(asked?.from_handle === "bob" && asked.from_acct === bob.acct && asked.body.note === "hi, it's bob", "bob's ask lands in alice's inbox, as bob's (his certificate says so)");
  check(await until(() => bob.page.sentOf(ask, alice.acct)?.error === null), "taken");
  const rec = { type: "thread", id: "t-1", v: "1", body: { title: "Ledger import" } };
  const early = bob.page.send(alice.acct, "records", { items: [rec] });
  bob.nudge();
  check((await until(() => bob.page.sentOf(early, alice.acct)))?.error === "not_allowed", "records from someone who isn't alice's contact are refused");
  check(inbox(alice, "records").length === 0, "and none kept");
  alice.page.putPerson({ acct: bob.acct, handle: "bob", key: bob.key, rel: ["contact"] });
  bob.page.send(alice.acct, "records", { items: [rec] });
  bob.nudge();
  const got = await until(() => inbox(alice, "records")[0]);
  const item = got?.body.items?.[0];
  check(item?.id === "t-1" && item.body.title === "Ledger import", "once they're contacts, his records arrive");
  check(item?.author?.handle === "bob" && recordHolds(item, "bob", item.author.sig, bob.key), "each signed by bob's door, as their author, with the handle he goes by");
  check(item?.author && !recordHolds(item, "alice", item.author.sig, bob.key), "which no other handle holds for");
  check(item?.author?.certificate && (await (await import("../plugin/shared/relay-verify.ts")).createVerifier({ relay: relay.url }).verifyDoor(item.author.certificate)).acct === bob.acct, "with bob's certificate: his account");

  // ---------- `all` as a connection starts ----------
  bob.page.putPerson({ acct: alice.acct, handle: "alice", key: alice.key, rel: ["contact"] });
  alice.page.setPublished(bob.acct, "t-9", "v9");
  alice.page.setPublished(bob.acct, "p-2", "v2");
  // A new connection: alice's door restarts.
  await alice.proc.stop();
  check(true, "alice's door stops when its page closes its stdin");
  const alice2 = spawnDoor({ dir: alice.dir, account: alice.acct, relay: relay.url, iroh: { mode: "local", dir: IROH_DIR }, log: (l) => lines.push(`alice: ${l}`), extra: ["--retry-ms", "500"] })!;
  alice.proc = alice2;
  check(await until(() => alice.page.self("why") === "" && Number(alice.page.self("pid")) === alice2.child.pid), "and starts again, with the same key and folder");
  check(alice.page.self("key") === alice.key, "the same key");
  const s2 = net.connect(alice.page.self("socket")!);
  await new Promise((r) => s2.once("connect", r));
  alice.nudge = () => s2.write("outbox\n");
  alice.page.send(bob.acct, "hello", {});
  alice.nudge();
  const all = await until(() => inbox(bob, "all")[0]);
  check(JSON.stringify(all?.body.ids) === JSON.stringify([["p-2", "v2"], ["t-9", "v9"]]), "bob, her contact, gets `all` as her door connects to his: what he may see now");

  // ---------- a door that isn't a page's: what's refused ----------
  const iroh = await import(irohModule()!);
  const malKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as { x: string; d: string };
  const malAcct = crypto.randomUUID();
  const malCert = relay.certifyDoor(malAcct, malKey.x).certificate;
  const b = iroh.Endpoint.builder();
  iroh.presetMinimal(b);
  b.secretKey(Array.from(Buffer.from(malKey.d, "base64url")));
  b.alpns([Array.from(Buffer.from(ALPN))]);
  b.relayMode(iroh.RelayMode.disabled());
  b.bindAddr("127.0.0.1:0");
  const ep: Endpoint = await b.bind();
  let conn: Connection | null = null;
  const dial = async () => {
    if (conn && conn.closeReason() == null) return conn;
    const addrs = JSON.parse(fs.readFileSync(path.join(IROH_DIR, `${bob.key}.json`), "utf8")).addrs;
    conn = await ep.connect(new iroh.EndpointAddr(iroh.EndpointId.fromBytes(Array.from(Buffer.from(bob.key, "base64url"))), null, addrs), Array.from(Buffer.from(ALPN)));
    return conn;
  };
  // Sends raw bytes on a stream of their own: the answer, or "closed" when the door closed the connection.
  const raw = async (bytes: Buffer): Promise<Message | "closed"> => {
    const c = await dial();
    try {
      const bi: BiStream = await c.openBi();
      await bi.send.writeAll(Array.from(bytes));
      await bi.send.finish();
      const back = await Promise.race([bi.recv.readToEnd(300 * 1024), sleep(8000).then(() => null)]);
      if (!back) return "closed";
      return unframe(back);
    } catch {
      return "closed";
    }
  };
  const msg = (kind: string, body: object, from = malCert, id = crypto.randomBytes(9).toString("base64url"), handle: unknown = "mallory") => frame({ v: VERSION, kind, id, at: Date.now(), from, handle, body } as Message);
  // A well-formed message, but over the limit: its length says so, and so does what follows.
  const big = () => {
    const json = Buffer.from(JSON.stringify({ v: VERSION, kind: "ask", id: crypto.randomBytes(9).toString("base64url"), at: Date.now(), from: malCert, handle: "mallory", body: { note: "x".repeat(300 * 1024) } }));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(json.length);
    return Buffer.concat([head, json]);
  };
  const hello = await raw(msg("hello", {}));
  check(hello !== "closed" && hello.kind === "card" && hello.body.handle === "bob", "a stranger's door saying hello gets bob's card");
  check(hello !== "closed" && Object.keys(hello.body).sort().join() === "bio,handle,name", "and nothing else");
  check((await raw(msg("records", { items: [] }))) !== "closed", "a kind they may not send gets an ack saying no, the connection kept");
  for (const [label, bytes] of [
    ["an unknown kind", msg("run", { command: "rm -rf ~" })],
    ["a field that isn't in its shape", msg("ask", { note: "hi", path: "/etc/passwd" })],
    ["a field of the wrong type", msg("ask", { note: 7 })],
    ["a message that isn't JSON", Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from("hello")])],
    ["a length that isn't its length", Buffer.concat([Buffer.from([0, 0, 0, 99]), Buffer.from("{}")])],
    ["a message over 256 KB", big()],
    ["an answer nobody asked for", msg("ack", { ok: true })],
    ["a certificate for another door", msg("ask", {}, bob.page.config("certificate")!)],
    ["no certificate that holds", msg("ask", {}, malCert.slice(0, -4) + "AAAA")],
    ["no handle", msg("ask", {}, malCert, undefined, null)],
    ["a handle that isn't one", msg("ask", {}, malCert, undefined, "Bob Smith")],
  ] as const) {
    conn = null;
    const r = await raw(bytes as Buffer);
    check(r === "closed", `${label} closes the connection`);
  }
  check(!inbox(bob).some((r) => r.from_acct === malAcct && r.kind !== "ask"), "and nothing of it is kept");
  conn = null;
  const id = "same-id-12345";
  await raw(msg("ask", { note: "one" }, malCert, id));
  await raw(msg("ask", { note: "one" }, malCert, id));
  check(inbox(bob, "ask").filter((r) => r.from_acct === malAcct).length === 1, "the same message twice is kept once");
  let last: Message | "closed" = "closed";
  for (let i = 0; i < 5; i++) last = await raw(msg("ask", { note: `ask ${i}` }));
  check(last !== "closed" && last.body.ok === false && last.body.error === "slow_down", "past 5 asks a day, slow_down");
  check(inbox(bob, "ask").filter((r) => r.from_acct === malAcct).length === 5, "and the one past the limit isn't kept");
  await ep.close();

  // ---------- an invite link whose key is another account's door ----------
  // dave's link, with alice's door key in it: bob's door says hello to that key, and alice's answer says she isn't
  // dave, so bob's ask for dave never goes.
  const dave = crypto.randomUUID();
  bob.page.putPerson({ acct: dave, handle: "dave", key: alice.key });
  const forDave = bob.page.send(dave, "ask", { note: "for dave only" });
  bob.nudge();
  check(/another account/.test((await until(() => bob.page.reach(dave)?.why)) || ""), "a door that answers as another account than the link's: bob's door says so");
  await sleep(1000);
  check(!inbox(alice, "ask").some((r) => r.body.note === "for dave only"), "and what was for dave never reached it");
  check(bob.page.sentOf(forDave, dave) === null && bob.page.waitingFor(dave) === 1, "it waits, unsent");

  // ---------- held to its folder ----------
  const secret = path.join(BASE, "storage.db");
  fs.writeFileSync(secret, "your threads");
  let probed = "";
  const p = spawnDoor({ dir: path.join(BASE, "probe", "door"), account: "x", relay: relay.url, iroh: { mode: "local", dir: IROH_DIR }, log: (l) => (probed += l), probe: secret })!;
  await p.exited;
  const out = JSON.parse(probed.slice(probed.indexOf("{")) || "{}");
  check(out.read === "denied", `a door can't read a file outside its folder, storage.db (${out.read})`);
  check(out.write === "denied", `nor write one (${out.write})`);
  check(out.spawn === "denied", `nor start a process (${out.spawn})`);
  check(out.worker === "denied", `nor a worker (${out.worker})`);
  check(out.eval === "denied", `nor make code from a string (${out.eval})`);
  check(out.own === "allowed", `and it writes its own folder (${out.own})`);
  check(!fs.existsSync(path.join(BASE, "door-was-here")), "nothing written beside storage.db");
} catch (e) {
  check(false, `no error: ${e.stack}`);
} finally {
  await Promise.all([alice.proc.stop(), bob.proc.stop()]);
  await relay.close();
  if (failures) console.log(lines.slice(-40).join("\n"));
  fs.rmSync(BASE, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
