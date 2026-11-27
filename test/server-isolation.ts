#!/usr/bin/env node
// The line between agentbook-server and agentbook-cli, as the code draws it:
// - nothing under server/ runs anything: it imports no child_process, worker_threads, cluster or vm, and nothing
//   from plugin/cli/ (the drivers, git, transcripts) or plugin/lib/ (which starts processes);
// - plugin/shared/ is what both sides import, so it imports only itself;
// - the plugin stands on its own, since installing it copies only plugin/: nothing in it imports server/.
// A crossing fails. (Until step 4, each one still there was listed with the step that removed it.)
// Run: node test/server-isolation.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = new Set(["child_process", "worker_threads", "cluster", "vm"]);

// "importer -> imported" (repo paths, or node:<module>), and the step that removes it. None since step 4, when
// agentbook-server and agentbook-cli became two programs.
const ALLOWED: Record<string, string> = {};

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

function filesIn(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p));
    else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

// What a module imports: static imports and exports-from, and import() of a literal.
function importsOf(file: string) {
  const src = fs.readFileSync(file, "utf8");
  const specs = new Set<string>();
  for (const re of [/^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of src.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

const rel = (p: string) => path.relative(REPO, p).split(path.sep).join("/");
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
const SERVER = path.join(REPO, "server");
const PLUGIN = path.join(REPO, "plugin");
const SHARED = path.join(PLUGIN, "shared");

// Every import that crosses the line, as "importer -> imported".
const crossings = new Set<string>();
const missing: string[] = [];
for (const file of [...filesIn(SERVER), ...filesIn(PLUGIN)]) {
  for (const spec of importsOf(file)) {
    const builtin = spec.startsWith("node:") ? spec.slice(5) : null;
    const isServer = inside(file, SERVER);
    const isShared = inside(file, SHARED);
    if (builtin) {
      if ((isServer || isShared) && RUNS.has(builtin)) crossings.add(`${rel(file)} -> node:${builtin}`);
      continue;
    }
    if (!spec.startsWith(".")) continue; // no packages: agentbook has no dependencies
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) missing.push(`${rel(file)} -> ${spec}`);
    const ok = isServer ? inside(target, SERVER) || inside(target, SHARED) : isShared ? inside(target, SHARED) : !inside(target, SERVER);
    if (!ok) crossings.add(`${rel(file)} -> ${rel(target)}`);
  }
}

check(!missing.length, `every relative import resolves${missing.length ? `: ${missing.join(", ")}` : ""}`);
const unlisted = [...crossings].filter((c) => !ALLOWED[c]).sort();
check(!unlisted.length, `nothing crosses the line that isn't listed with the step that removes it${unlisted.length ? `:\n${unlisted.map((c) => `      ${c}`).join("\n")}` : ""}`);
const gone = Object.keys(ALLOWED).filter((c) => !crossings.has(c)).sort();
check(!gone.length, `every listed crossing is still there (take the gone ones off the list)${gone.length ? `:\n${gone.map((c) => `      ${c}`).join("\n")}` : ""}`);
const byStep: Record<string, number> = {};
for (const step of Object.values(ALLOWED)) byStep[step] = (byStep[step] || 0) + 1;
console.log(`\n${Object.keys(ALLOWED).length} crossings left: ${Object.entries(byStep).map(([s, n]) => `${n} for ${s}`).join(", ") || "none"}`);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
