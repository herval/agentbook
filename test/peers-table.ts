#!/usr/bin/env node
// The machines a page is linked to (plugin/shared/storage/peers.ts), from before your machines met only over iroh:
// a row linked over HTTP, with an address and a token, keeps its key (if it had one) and
// its page's address as its site, and loses the rest; the page links again over iroh as it starts (server/mesh.ts).
// Run: node test/peers-table.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "../plugin/shared/storage.ts";
import { PeerTables } from "../plugin/shared/storage/peers.ts";
import { sql } from "./harness-sql.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-peers-"));
// The table as it was before (its first three versions).
class Before {
  static id = PeerTables.id;
  static schema = PeerTables.schema.slice(0, 3);
  constructor(_db: unknown) {}
}
const before = Storage.open(dir);
before.use(Before);
const db = sql(before.file);
const add = db.prepare("insert into peers (name, machine, url, token, key, site, added) values (?, ?, ?, ?, ?, ?, ?)");
add.run("brick", "m-brick", "https://brick.example-net.ts.net:8443", "t1", null, null, "2026-11-01T00:00:00.000Z");
add.run("studio", "m-studio", "https://studio.example-net.ts.net:8443", "t2", "k-studio", "https://studio.example-net.ts.net", "2026-11-02T00:00:00.000Z");
add.run("old", null, "https://old.example-net.ts.net:8443", "t3", null, null, "2026-10-01T00:00:00.000Z");
before.close();

const after = Storage.open(dir);
const peers = after.use(PeerTables);
const cols = (sql(after.file).prepare("select name from pragma_table_info('peers')").all() as { name: string }[]).map((c) => c.name);
check(!cols.includes("url") && !cols.includes("token"), `no address or token kept (${cols.join(", ")})`);
const brick = peers.get("brick");
check(brick?.machine === "m-brick" && brick.key === null && brick.site === "https://brick.example-net.ts.net:8443", `one linked over HTTP keeps its id, and its address as its site, with no key until it links over iroh (${JSON.stringify(brick)})`);
const studio = peers.get("studio");
check(studio?.key === "k-studio" && studio.site === "https://studio.example-net.ts.net" && studio.added === "2026-11-02T00:00:00.000Z", `one linked over iroh keeps its key, site and when it was linked (${JSON.stringify(studio)})`);
check(peers.get("old")?.machine === null, "one linked with a code stays until the page drops it as it starts");
check(peers.byKey("k-studio")?.name === "studio", "and a call over iroh finds its machine by key");
peers.put({ name: "brick", machine: "m-brick", key: "k-brick", site: "https://brick.example-net.ts.net:8443" });
check(peers.byKey("k-brick")?.name === "brick" && peers.get("brick")?.added === "2026-11-01T00:00:00.000Z", "linked again over iroh: its key, and still when it was first linked");
after.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
