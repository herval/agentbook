#!/usr/bin/env node
// agentbook's tools (plugin/cli/tools/), one file each: every file is on the list, what else names them agrees with
// it (OpenClaw's manifest), and what mcp.ts serves from it: every tool to every agent, and instructions that name
// only tools it has.
// Run: node test/tools.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../plugin/cli/tools/index.ts";
import { handle } from "../plugin/cli/mcp.ts";
import type { Who } from "../plugin/cli/mcp.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const names: string[] = TOOLS.map((t) => t.name);

// ---------- the list ----------
check(new Set(names).size === names.length && names.every((n) => /^ab_[a-z_]+$/.test(n)), `${names.length} tools, each named ab_<something>, none twice`);
check(TOOLS.every((t) => t.description.trim() && t.inputSchema?.type === "object"), "each says what it does and takes an object");
const dir = path.join(root, "plugin/cli/tools");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !["tool.ts", "disk.ts", "shape.ts", "index.ts"].includes(f));
const fileOf = (n: string) => `${n.slice(3).replace(/_/g, "-")}.ts`;
check(files.length === TOOLS.length && names.every((n) => files.includes(fileOf(n))), "every tool is a file of its name in plugin/cli/tools, and every file there is on the list");
check(TOOLS.filter((t) => t.brief).every((t) => [t.brief].flatMap((b) => (typeof b === "string" ? [b] : [b.session, b.driven])).every((line) => line === null || line.startsWith(t.name))), "a tool's line in the instructions starts with its name");

// ---------- what else names them ----------
const manifest: string[] = JSON.parse(fs.readFileSync(path.join(root, "plugin/openclaw/openclaw.plugin.json"), "utf8")).contracts.tools;
const missing = names.filter((n) => !manifest.includes(n));
const extra = manifest.filter((n) => !names.includes(n));
check(!missing.length && !extra.length && new Set(manifest).size === manifest.length, `OpenClaw's manifest names every tool${missing.length ? `; add ${missing.join(", ")}` : ""}${extra.length ? `; take out ${extra.join(", ")}` : ""}`);

// ---------- what mcp.ts serves ----------
const ask = async (method: string, who: Who, params = {}) => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method, params }, who);
  return r && "result" in r ? r.result : null;
};
const callers: [string, Who][] = [
  ["a Claude Code session", { proc: "host-1" }],
  ["one with live delivery", { proc: "host-1", live: true }],
  ["an OpenClaw agent", { proc: "openclaw:agent:main:main" }],
  ["a Codex thread", { proc: "codex:t1", codex: true }],
  ["a Claude Agent", { proc: "managed:s1" }],
];
for (const [label, who] of callers) {
  const listed = (await ask("tools/list", who)).tools;
  check(JSON.stringify(listed.map((t) => t.name)) === JSON.stringify(names), `${label}'s tools/list: every tool, in the list's order`);
  check(listed.every((t) => JSON.stringify(Object.keys(t)) === '["name","description","inputSchema"]'), `${label}'s tools/list has each one's name, description and inputSchema, and nothing else of it`);
  const said = new Set((await ask("initialize", who)).instructions.match(/\bab_[a-z_]+/g));
  const unknown = [...said].filter((n) => !listed.some((t) => t.name === n));
  check(said.size > 5 && !unknown.length, `what ${label} is told names only tools it has${unknown.length ? `, not ${unknown.join(", ")}` : ""}`);
}
const told = (await ask("initialize", { proc: "host-1" })).instructions;
const toldDriven = (await ask("initialize", { proc: "openclaw:agent:main:main" })).instructions;
check(/^- ab_post: a headline for what this session is doing/m.test(told) && /^- ab_post: a headline for what you're doing/m.test(toldDriven), "a Claude Code session and an agent agentbook runs each get their own line for a tool");
check(!/^- ab_show:/m.test(told) && /^- ab_show:/m.test(toldDriven), "a line for only one of them (ab_show's) goes to only that one");
const unknownCall = await ask("tools/call", { proc: "host-1" }, { name: "ab_nope", arguments: {} });
check(unknownCall.isError && /Unknown tool ab_nope/.test(unknownCall.content[0].text), "a tool there isn't is an error that says so");

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
