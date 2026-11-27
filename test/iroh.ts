#!/usr/bin/env node
// Two machines' iroh endpoints (plugin/shared/iroh.ts), in one process, on 127.0.0.1 with no relay
// (AGENTBOOK_IROH=local): HTTP over a stream of its own for each call, into a page's own HTTP server, which knows which
// machine is calling from the connection; a machine off the account is closed before its first stream; a call that
// goes unanswered leaves the connection usable, and a few of them make it again.
// Run: node test/iroh.ts

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeIroh, type IrohHow, type IrohNode } from "../plugin/shared/iroh.ts";
import type { Json } from "./harness-types.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-iroh-"));
const how: IrohHow = { mode: "local", dir };
const newKey = () => {
  const jwk = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { x: jwk.x as string, d: jwk.d as string };
};
const lines: string[] = [];
const log = (line: string) => lines.push(line);

// beta's page: an HTTP server that answers over iroh, as server/main.ts does.
const seen: { path: string; from: string; length: number }[] = [];
let hang = false;
const page = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seen.push({ path: req.url, from: (req.socket as { irohKey?: string }).irohKey, length: body.length });
    if (req.url === "/hang" && hang) return; // never answers
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(300 * 1024, 7));
    }
    res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
    res.end(JSON.stringify({ path: req.url, method: req.method, from: (req.socket as { irohKey?: string }).irohKey, length: body.length, sha: crypto.createHash("sha256").update(body).digest("hex") }));
  });
});

const ka = newKey();
const kb = newKey();
const kc = newKey(); // a machine on no account of theirs
let onAccount = new Set([ka.x]);
const nodes: IrohNode[] = [];
try {
  const a = await makeIroh({ key: ka, admit: async () => true, log, how, serve: (s) => s.destroy() });
  const b = await makeIroh({ key: kb, admit: async (k) => onAccount.has(k), log, how, serve: (s) => page.emit("connection", s) });
  const c = await makeIroh({ key: kc, admit: async () => true, log, how, serve: (s) => s.destroy() });
  nodes.push(a, b, c);
  check(a.key === ka.x && b.key === kb.x, "each endpoint is its machine's login key");

  const t0 = Date.now();
  const r1 = await a.fetch(b.key, "/api/cli/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hi: 1 }) });
  const j1 = (await r1.json()) as Json;
  check(r1.status === 200 && j1.path === "/api/cli/hello" && j1.method === "POST", `alpha's call reaches beta's page, over iroh (${Date.now() - t0} ms)`);
  check(j1.from === a.key, "and beta's page knows it's alpha calling, by the connection");
  check(r1.headers.get("set-cookie")?.includes("a=1") && r1.headers.get("content-type") === "application/json", "with the headers beta's page answered");

  const big = crypto.randomBytes(1024 * 1024);
  const t1 = Date.now();
  const r2 = (await (await a.fetch(b.key, "/api/cli/blobs/x", { method: "PUT", body: big })).json()) as Json;
  check(r2.length === big.length && r2.sha === crypto.createHash("sha256").update(big).digest("hex"), `a 1 MB body goes over whole (${Date.now() - t1} ms)`);
  const r3 = await a.fetch(b.key, "/big");
  check((await r3.arrayBuffer()).byteLength === 300 * 1024, "and a 300 KB answer comes back whole");
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => a.fetch(b.key, `/n/${i}`).then((r) => r.json() as Promise<Json>)));
  check(many.every((j, i) => j.path === `/n/${i}`), "20 calls at once, each on a stream of its own");
  check(a.connected(b.key), "over the one connection alpha keeps to beta");
  check(a.path(b.key) === "direct" && b.path(a.key) === "direct" && a.path("x".repeat(43)) === null, `which goes direct, as both say (${a.path(b.key)}, ${b.path(a.key)})`);
  // Answered well before its time ran out (a commands poll is answered at 25 s of 35): that time running out later
  // doesn't count it as left waiting, or every third poll would make the connection again.
  for (let i = 0; i < 3; i++) await a.fetch(b.key, `/answered/${i}`, { signal: AbortSignal.timeout(200) });
  await sleep(400);
  check(a.connected(b.key) && !lines.some((l) => /went unanswered/.test(l)), "calls answered before their time ran out aren't counted as unanswered when it does");

  // A machine off the account: closed before its first stream.
  const before = seen.length;
  const refused = await c.fetch(b.key, "/api/cli/hello").then(
    (r) => `answered ${r.status}`,
    (e) => e.cause?.code || e.message,
  );
  await sleep(300);
  check(refused !== "answered 200" && seen.length === before, `a machine that isn't on the account gets nothing from beta's page (${refused})`);
  check(lines.some((l) => /refused a connection from/.test(l)), "and beta says it refused it");

  // A call nobody answers.
  hang = true;
  const t2 = Date.now();
  const timedOut = await a.fetch(b.key, "/hang", { signal: AbortSignal.timeout(500) }).then(
    () => "answered",
    (e) => e.name,
  );
  check(timedOut === "TimeoutError" && Date.now() - t2 < 3000, `a call that goes unanswered times out (${timedOut})`);
  const after = await a.fetch(b.key, "/after").then((r) => r.json() as Promise<Json>, () => null);
  check(after?.path === "/after" && a.connected(b.key), "and the connection still takes the next one");
  for (let i = 0; i < 3; i++) await a.fetch(b.key, "/hang", { signal: AbortSignal.timeout(300) }).catch(() => null);
  check(lines.some((l) => /went unanswered \(GET \/hang, GET \/hang, GET \/hang\), so its connection is made again/.test(l)), "three unanswered on one connection, and it's closed, saying which they were");
  hang = false;
  const redialed = await a.fetch(b.key, "/again").then((r) => r.json() as Promise<Json>, (e) => ({ error: e.cause?.message || e.message }) as Json);
  check(redialed?.path === "/again", `then the next call dials beta again (${JSON.stringify(redialed)})`);

  // A machine that isn't up.
  const t3 = Date.now();
  const nobody = await a.fetch(newKey().x, "/api/cli/hello").then(
    () => null,
    (e) => e.cause,
  );
  check(nobody?.code === "IROH_UNREACHABLE" && Date.now() - t3 < 2000, `a machine with no endpoint up can't be reached, and says so (${nobody?.message})`);

  // Unlinked: its connection goes at once.
  a.drop(b.key);
  check(!a.connected(b.key), "dropping beta closes alpha's connection to it");
  onAccount = new Set();
  await sleep(100);
  const dropped = await a.fetch(b.key, "/api/cli/hello").then(
    (r) => r.status,
    (e) => e.cause?.code,
  );
  check(dropped !== 200, `and with alpha off beta's account, alpha gets nothing from it any more (${dropped})`);
} finally {
  for (const n of nodes) await n.close().catch(() => {});
  page.close();
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
