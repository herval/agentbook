#!/usr/bin/env node
// Only the storage layer touches agentbook's database: plugin/shared/storage.ts (the door), plugin/shared/storage/
// and server/storage/ (the table modules, each with its tables and every query on them). Everything else asks them
// by name. This reads the code for SQL and for ways into SQLite outside them.
// Run: node test/storage-boundary.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYER = ["plugin/shared/storage.ts", "plugin/shared/storage/", "server/storage/"];
// SQL that isn't against agentbook's database.
const OTHERS = {
  "plugin/cli/runtimes/hermes/hermes.ts": "Hermes's own state.db, read-only, in its schema",
  "plugin/cli/runtimes/codex/automations.ts": "the Codex app's codex.db, read-only, in its schema",
  "server/integrations/connectors/boat-catalog.ts": "a cloud sandbox's Postgres, in the shell script that sets it up",
  "plugin/shared/door/db.ts": "door.db, your door's own, which the door and the page share: never storage.db",
};

const SQL = /["'`]\s*(select\s[\w*(]|insert (or \w+ )?into\s|update \w+ set\s|delete from\s|create (unique )?(table|index)\s|drop (table|index)\s|alter table\s|pragma \w|attach database\s|vacuum into\s|begin immediate)/i;
const DOOR = /from\s+["']node:sqlite["']|import\(\s*["']node:sqlite["']\)|storage\/sqlite\.ts|DatabaseSync|\.prepare\(\s*["'`]|\.exec\(\s*["'`](commit|rollback)/;

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "ui", "vendor"].includes(e.name)) walk(rel);
    } else if (/\.(m?js|ts)$/.test(e.name)) files.push(rel);
  }
})("server");
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "ui", "vendor"].includes(e.name)) walk(rel);
    } else if (/\.(m?js|ts)$/.test(e.name)) files.push(rel);
  }
})("plugin");
for (const f of ["bin/agentbook", "bin/agentbook-cli", "bin/agentbook-server"]) if (fs.existsSync(path.join(ROOT, f))) files.push(f);

const inLayer = (f) => LAYER.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
const found = [];
for (const f of files) {
  if (inLayer(f) || OTHERS[f]) continue;
  const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "");
    if (SQL.test(code) || DOOR.test(code)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
}
check(found.length === 0, `no SQL and no SQLite outside the storage layer (${files.length} files read)${found.length ? `:\n  ${found.join("\n  ")}` : ""}`);

// The table modules keep their connection to themselves: none hands it out.
const leaks = [];
for (const f of files.filter(inLayer)) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (/\bthis\.db\b|\bget db\(\)/.test(text)) leaks.push(f);
}
check(leaks.length === 0, `no table module hands out its connection (this.db, get db())${leaks.length ? `: ${leaks.join(", ")}` : ""}`);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
