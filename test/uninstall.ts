#!/usr/bin/env node
// Going away: agentbook-cli uninstall undoes what it changed outside its folder, and a daemon stops by itself once
// Claude Code has removed its plugin, which is all that would have started it again.
// Run: node test/uninstall.ts

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTied, testPort } from "./harness.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST, "..");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-uninstall-")));
const PORT = testPort(4500) + 200;
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
};

const USER = path.join(BASE, "person");
const CONFIG = path.join(USER, ".claude");
const PLUGINS = path.join(CONFIG, "plugins");
const DATA = path.join(USER, ".agentbook");
const CALLS = path.join(BASE, "calls.log");
const ROOT = path.join(PLUGINS, "marketplaces", "agentbook", "plugin");
fs.mkdirSync(path.dirname(ROOT), { recursive: true });
fs.cpSync(path.join(REPO, "plugin"), ROOT, { recursive: true });
const installed = (plugins: Record<string, unknown>) => fs.writeFileSync(path.join(PLUGINS, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
const entry = [{ scope: "user", installPath: path.join(PLUGINS, "cache", "agentbook", "agentbook", "0.3.35"), version: "0.3.35" }];
const other = { "other@elsewhere": [{ scope: "user", installPath: "/x", version: "1" }] };

const bin = path.join(BASE, "bin");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${CALLS}"\n`, { mode: 0o755 });
const env = { ...process.env, HOME: USER, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: CONFIG, AGENTBOOK_HOME: DATA, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CLAUDE: path.join(bin, "claude"), AGENTBOOK_CODEX_HOME: path.join(USER, ".codex"), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_NOTIFY: "0" };
for (const k of ["AGENTBOOK_START_UNLINKED", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "CLAUDE_PLUGIN_ROOT", "CLAUDE_JOB_DIR"]) delete env[k];
const main = path.join(ROOT, "cli", "main.mjs");
const health = () => fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
const run = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { env, encoding: "utf8", timeout: 30000 });
const daemon = () => spawnTied(process.execPath, [main, "run"], { env, stdio: "ignore" });
const exited = (child: ChildProcess) => new Promise<boolean>((r) => child.once("exit", () => r(true)));
const within = (p: Promise<unknown>, ms: number) => Promise.race([p, sleep(ms).then(() => false)]);

let child: ChildProcess | null = null;
try {
  // ---------- its plugin goes ----------
  installed({ ...other, "agentbook@agentbook": entry });
  child = daemon();
  check(await until(health), "it runs from the plugin");
  installed({ ...other, "agentbook@agentbook": [{ ...entry[0], version: "0.3.36" }] });
  await sleep(1200);
  check(await health(), "an update leaves it running");
  const stopped = exited(child);
  installed(other);
  check(await within(stopped, 5000), "uninstalling the plugin stops it");
  child = daemon();
  check(await within(exited(child), 5000), "and it won't start again without the plugin");

  // ---------- agentbook-cli uninstall ----------
  installed({ ...other, "agentbook@agentbook": entry });
  fs.mkdirSync(path.join(USER, ".codex"), { recursive: true });
  const toml = path.join(USER, ".codex", "config.toml");
  const before = `model = "o4"\n\n[mcp_servers.linear]\nurl = "https://linear.example/mcp"\n\n[mcp_servers.agentbook]\nurl = "http://127.0.0.1:${PORT}/api/mcp?agent=codex"\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.agentbook.tools.ab_post]\napproval_mode = "approve"\n\n[projects."/x"]\ntrust_level = "trusted"\n`;
  fs.writeFileSync(toml, before);
  child = daemon();
  check(await until(health), "it's running again");
  const once = run("uninstall");
  check(once.status === 0, `uninstall works (${(once.stderr || "").slice(0, 160)})`);
  check(await until(async () => !(await health())), "it's stopped");
  const after = fs.readFileSync(toml, "utf8");
  check(!/agentbook/.test(after) && /\[mcp_servers\.linear\]/.test(after) && /trust_level = "trusted"/.test(after) && /model = "o4"/.test(after), `Codex's entry is gone, and only that (${JSON.stringify(after)})`);
  const calls = fs.readFileSync(CALLS, "utf8");
  check(/plugin uninstall agentbook@agentbook/.test(calls) && /plugin marketplace remove agentbook/.test(calls), "and so is the plugin, and its marketplace");
  check(fs.existsSync(DATA) && /--purge removes it/.test(once.stdout), "its folder stays unless it's told otherwise");

  const another = `[mcp_servers.agentbook]\nurl = "http://127.0.0.1:${PORT + 1}/api/mcp?agent=codex"\n`;
  fs.writeFileSync(toml, another);
  run("uninstall");
  check(fs.readFileSync(toml, "utf8") === another, "another agentbook's entry is left alone");

  fs.mkdirSync(path.join(DATA, "cli"), { recursive: true });
  fs.mkdirSync(path.join(DATA, "server"), { recursive: true });
  const kept = run("uninstall", "--purge");
  check(fs.existsSync(path.join(DATA, "server")) && /holds an agentbook-server's data/.test(kept.stdout), "--purge keeps a folder with a server's data in it");
  fs.rmSync(path.join(DATA, "server"), { recursive: true });
  const purged = run("uninstall", "--purge");
  check(!fs.existsSync(DATA) && /Removed /.test(purged.stdout), "and removes one without");
} finally {
  child?.kill("SIGKILL");
  await sleep(200);
  fs.rmSync(BASE, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
