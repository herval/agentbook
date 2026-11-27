#!/usr/bin/env node
// What's too big for a server, or for a proxy in front of it. A batch is halved until it goes, over real HTTP, whether
// it's refused with a 413 or by a cut connection. A long thread's steps go in parts. One op too big alone is left out,
// so what comes after it goes, and `status` says so. A cut connection on something small is just a cut connection.
// Run: node test/too-big.ts

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "../server/relay.ts";
import { createWork as createServerWork } from "../server/work.ts";
import { createStore } from "../plugin/shared/store.ts";
import { createUplink, httpTransport } from "../plugin/cli/uplink.ts";
import { createWork } from "../plugin/cli/work.ts";
import type { Step } from "../plugin/cli/runtimes/kit/steps.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-too-big-")));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LIMIT = 1024 * 1024;
const accounts = { byId: (id) => (id === "u1" ? { id: "u1", username: "herval" } : null), deviceById: () => null };
let n = 0;
const storeAt = () => {
  const name = `m${++n}`;
  return createStore({ file: path.join(BASE, name, "agentbook.db"), filesDir: path.join(BASE, name, "files"), legacy: false, acks: true });
};
const hello = (store) => store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });

// A server behind something with a limit: `over(req, res)` says what happens to a body past it.
async function serverBehind(over, limit = LIMIT) {
  const work = createServerWork();
  const relay = createRelay({ home: path.join(BASE, `server${++n}`), accounts, work });
  const D = relay.device("d1", { name: "laptop", user_id: "u1" });
  const seen = { bodies: [], over: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let cut = false;
    req.on("data", (c) => {
      size += c.length;
      chunks.push(c);
      if (size > limit && !cut) {
        cut = true;
        seen.over++;
        over(req, res);
      }
    });
    req.on("end", () => {
      if (cut) return;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const answer = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url.endsWith("/hello")) return answer(relay.hello(D, body));
      if (req.url.endsWith("/ops")) {
        seen.bodies.push(size);
        return answer(relay.ingest(D, body));
      }
      answer({ commands: [] });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, D, relay, work, seen, close: () => (srv.closeAllConnections(), srv.close()) };
}
const proxy413 = (req, res) => {
  res.writeHead(413, { "content-type": "text/html", connection: "close" });
  res.end("<html>Request Entity Too Large</html>");
};
const cutIt = (req) => req.destroy();
const uplinkTo = (s, store, more = {}) => createUplink({ store, transport: httpTransport({ url: s.url, token: "t" }), onCommand: async () => ({}), epoch: "e1", retryMs: 0, ...more });
const pushAll = async (up, store, tries = 30) => {
  for (let i = 0; i < tries && up.status().waiting; i++) await up.push();
};
const texts = (s) => s.D.store.state.messages.filter((m) => m.post === "s1").map((m) => m.text);
const big = (kb) => "x".repeat(kb * 1024);

for (const [how, over] of [["a 413", proxy413], ["a cut connection", cutIt]]) {
  // ---------- a batch ----------
  {
    const s = await serverBehind(over);
    const store = storeAt();
    const up = uplinkTo(s, store);
    hello(store);
    await up.push();
    const said = [];
    for (let i = 0; i < 120; i++) {
      said.push(`m${i}`);
      store.commit({ t: "message.add", post: "s1", from: "agent", text: `m${i} ${big(12).slice(0, 15000)}` });
    }
    await pushAll(up, store);
    check(s.seen.over >= 1, `(a batch of ${(120 * 15000 / LIMIT).toFixed(1)} MB meets the limit, ${s.seen.over} times, by ${how})`);
    check(s.seen.bodies.every((b) => b <= LIMIT), "nothing past the limit is read");
    const got = texts(s).map((t) => t.split(" ")[0]);
    check(got.length === 120 && got.join() === said.join(), `by ${how}, it's halved until all of it has gone, once each, in order (${got.length})`);
    check(up.status().connected && up.status().waiting === 0 && !up.status().too_big, "status has nothing to say about it");
    s.close();
    store.close();
  }

  // ---------- one op too big alone ----------
  {
    const s = await serverBehind(over);
    const store = storeAt();
    const lines = [];
    const up = uplinkTo(s, store, { log: (l) => lines.push(l) });
    hello(store);
    await up.push();
    const changes = { files: [{ path: "core-api/ledger.ts", patch: big(3 * 1024) }] };
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "before" });
    store.commit({ t: "post.changes", post: "s1", scope: "all", data: changes });
    const seq = store.state.seq;
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "after" });
    await pushAll(up, store);
    const st = up.status();
    check(texts(s).join() === "before,after", `by ${how}, what comes after an op too big alone still goes (${texts(s).join()})`);
    check(s.work.changes(s.D, "s1", "all") === null, "and that op doesn't reach the server");
    check(st.waiting === 0 && st.connected, "the queue isn't stuck on it");
    check(st.too_big?.count === 1 && st.too_big.last.seq === seq && st.too_big.last.kind === "post.changes" && st.too_big.last.post === "s1" && st.too_big.last.bytes > 3 * LIMIT, `and status keeps it (${JSON.stringify(st.too_big?.last)})`);
    check(lines.filter((l) => /too big for .* even alone/.test(l)).length === 1, "the log says it once");
    // A new uplink (the daemon restarted): nothing about it is tried again, and it's still said.
    s.seen.over = 0;
    const again = uplinkTo(s, store);
    await again.push();
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "later" });
    await pushAll(again, store);
    check(s.seen.over === 0 && texts(s).at(-1) === "later" && again.status().too_big?.count === 1, "after a restart it's still left out, and still said");
    s.close();
    store.close();
  }
}

// ---------- a cut connection that isn't about size ----------
{
  const s = await serverBehind(cutIt, 1);
  const store = storeAt();
  const up = uplinkTo(s, store);
  await up.push();
  check(/ECONNRESET|other side closed|socket|EPIPE/i.test(up.status().error || "") && !up.status().too_big, `a small hello cut by the server is a failure, not a size (${up.status().error})`);
  s.close();
  store.close();
}
{
  // Connects, then every op is cut, whatever its size: a small one stays in the queue, however often.
  const store = storeAt();
  hello(store);
  store.commit({ t: "message.add", post: "s1", from: "agent", text: "small" });
  let pushes = 0;
  const reset = Object.assign(new Error("other side closed"), { reset: true });
  const transport = { name: "srv", hello: async () => ({ cursor: 0, empty: false }), push: async () => (pushes++, Promise.reject(reset)), commands: () => new Promise(() => {}), result: async () => ({}) };
  const up = createUplink({ store, transport, onCommand: async () => ({}), epoch: "e", retryMs: 0 });
  for (let i = 0; i < 40; i++) await up.push();
  const st = up.status();
  check(!st.too_big && st.waiting > 0 && !st.connected && pushes >= 40, `a few small ops with cut connections stay queued, and nothing's left out (${pushes} tries)`);
  store.close();
}

// ---------- a long thread's steps ----------
{
  const s = await serverBehind(proxy413);
  const store = storeAt();
  const up = uplinkTo(s, store);
  hello(store);
  await up.push();
  const steps: Step[] = Array.from({ length: 4000 }, (_, i) => ({ id: `t${i}`, at: null, kind: "tool", tool: "Bash", text: `step ${i} ${big(1)}` }));
  const work = createWork({ store, stepsOf: async () => ({ steps, plan: [{ text: "ship", now: "Shipping", status: "pending" }], turn: 2 }), imagesOf: async () => [], changesOf: async () => null, blobPut: async () => "" });
  work.touch("s1", { now: true });
  for (let i = 0; i < 100 && !s.work.steps(s.D, "s1"); i++) await sleep(10), await up.push();
  await sleep(50);
  await pushAll(up, store);
  const got = s.work.steps(s.D, "s1");
  check(!up.status().too_big && Math.max(...s.seen.bodies) <= LIMIT, `no part of a long thread's steps is too big for a 1 MB limit (the largest batch ${(Math.max(...s.seen.bodies) / 1024).toFixed(0)} KB)`);
  check(got?.steps.length === 4000 && got.steps.every((x, i) => x.id === `t${i}`) && got.turn === 2 && got.plan?.[0]?.text === "ship", `they arrive whole and in order, in parts (${got?.steps.length})`);
  // Steps that shrink, or only a new plan: one op, as before.
  steps.length = 3000;
  work.touch("s1", { now: true });
  await sleep(100);
  await pushAll(up, store);
  check(s.work.steps(s.D, "s1")?.steps.length === 3000, "a thread with fewer steps than it had still loses the rest");
  s.close();
  store.close();
}

// ---------- what the machine knows ----------
{
  const s = await serverBehind(proxy413);
  const store = storeAt();
  let huge = { list: big(1536) };
  const info = () => ({ "post:a": { ok: 1 }, folders: huge, "post:b": { ok: 2 } });
  const lines = [];
  const up = uplinkTo(s, store, { info, log: (l) => lines.push(l) });
  hello(store);
  store.commit({ t: "message.add", post: "s1", from: "agent", text: "goes" });
  await up.push();
  for (let i = 0; i < 6; i++) await up.push();
  check(texts(s).join() === "goes" && up.status().connected, "what the machine knows, too big, doesn't stop its ops");
  const had: Json = s.relay.infoOf(s.D);
  check(had["post:a"]?.ok === 1 && had["post:b"]?.ok === 2 && !had.folders, `and the rest of it goes (${Object.keys(had).join()})`);
  check(lines.filter((l) => /of folders is too big/.test(l)).length === 1, "the log says which, once");
  huge = { list: "small now" };
  up.infoChanged();
  await up.push();
  const changed: Json = s.relay.infoOf(s.D);
  check(changed.folders?.list === "small now", "and it goes once it changes");
  s.close();
  store.close();
}

// ---------- everything it has, at once ----------
for (const [how, over] of [["a 413", proxy413], ["a cut connection", cutIt]]) {
  const s = await serverBehind(over);
  const store = storeAt();
  hello(store);
  for (let i = 0; i < 80; i++) store.commit({ t: "message.add", post: "s1", from: "agent", text: big(15) });
  const up = uplinkTo(s, store);
  for (let i = 0; i < 5; i++) await up.push();
  check(s.seen.over === 1 && /didn't take this machine's threads/.test(up.status().blocked || "") && /too much for it/.test(up.status().blocked), `its first state too big, by ${how}, is refused like any other, once, with why (${s.seen.over}: ${up.status().blocked?.slice(0, 120)})`);
  s.close();
  store.close();
}

// ---------- status ----------
{
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "agentbook", cli: true, machine: "laptop", pid: 1, server: "https://srv", connected: true, waiting: 0, too_big: { count: 2, last: { seq: 9, kind: "post.changes", post: "s1", bytes: 3 * LIMIT, at: "2026-11-07T10:00:00.000Z" } } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const env = { ...process.env, AGENTBOOK_HOME: path.join(BASE, "status"), AGENTBOOK_PORT: String((srv.address() as AddressInfo).port) };
  const out = await new Promise<string>((resolve) => {
    // Not spawnSync's: this process serves what it asks.
    import("node:child_process").then(({ execFile }) => execFile(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "status"], { env }, (e, stdout) => resolve(stdout)));
  });
  check(/Everything else is sent/.test(out) && !/Everything's sent/.test(out), `status doesn't say everything's sent (${out.split("\n")[2]})`);
  check(/2 changes were too big for its server even alone/.test(out) && /post\.changes on thread s1, 3\.0 MB, on 2026-11-07/.test(out), `and says what wasn't (${out.split("\n")[3]})`);
  srv.close();
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
