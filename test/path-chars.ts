#!/usr/bin/env node
// agentbook-cli from a folder whose path has a space, an accent, a # and a %: a home folder like "José da Silva" is all
// it takes, and a file URL's pathname keeps them encoded, so the daemon didn't start and no command ran there.
// Run: node test/path-chars.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnTied } from "./harness.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-paths-")));
const PORT = await freePort(6500, 40);
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true;
  return false;
};

const USER = path.join(BASE, "José da Silva");
const AT = path.join(USER, "código #1 100%");
const ROOT = path.join(AT, "plugin");
const DATA = path.join(USER, ".agentbook");
fs.mkdirSync(path.join(AT, "bin"), { recursive: true });
fs.cpSync(path.join(REPO, "plugin"), ROOT, { recursive: true });
fs.copyFileSync(path.join(REPO, "bin", "agentbook-cli"), path.join(AT, "bin", "agentbook-cli"));

const env = { ...process.env, HOME: USER, AGENTBOOK_HOME: DATA, AGENTBOOK_PORT: String(PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_CODEX: "0", AGENTBOOK_CODEX_MCP: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE_ROUTINES: "0", CLAUDE_CONFIG_DIR: path.join(USER, ".claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });

const cli = (...args) => spawnSync(path.join(AT, "bin", "agentbook-cli"), args, { env, encoding: "utf8", timeout: 20000 });
const health = () => fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json(), () => null);
const stop = async () => {
  const h = await health();
  if (h?.pid) process.kill(h.pid, "SIGTERM");
  await until(async () => !(await health()));
};

try {
  const asleep = cli("status");
  check(asleep.status === 0 && /isn't running/.test(asleep.stdout), `a command runs from there (${asleep.stderr.trim().slice(0, 160)})`);

  check(cli("up").status === 0 && (await until(health)), "and the daemon starts from there, in the background");
  check((await health())?.home === DATA, "with its data under a home folder like that too");
  check(/is running on laptop/.test(cli("status").stdout), "status finds it");
  await stop();

  const hook = spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), "SessionStart"], { input: JSON.stringify({ session_id: "s-1", cwd: USER, source: "startup" }), env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT, AGENTBOOK_PID: "930101", CLAUDE_CODE_ENTRYPOINT: "cli" }, encoding: "utf8", timeout: 20000 });
  const context = JSON.parse(hook.stdout || "{}").hookSpecificOutput?.additionalContext || "";
  check(await until(health), "a session's hook starts it from there");
  check(context.includes(`node "${path.join(ROOT, "cli", "main.mjs")}" login`), "and what the session's told to run has the folder as it is, quoted");
  await stop();

  const mcp = spawnSync(process.execPath, [path.join(ROOT, "mcp", "server.ts")], { input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`, env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT, AGENTBOOK_PID: "930101", AGENTBOOK_PROC: "codex:t1" }, encoding: "utf8", timeout: 20000 });
  check(!/Cannot find|ENOENT|ERR_/.test(mcp.stderr), `the MCP server loads from there (${mcp.stderr.trim().slice(0, 160)})`);

  const copy = spawnSync(process.execPath, [path.join(ROOT, "cli", "plugin-copy.ts"), ROOT], { env, encoding: "utf8", timeout: 20000 });
  check(copy.status === 0 && fs.existsSync(path.join(copy.stdout.trim(), "cli", "main.mjs")), "a session's copy of the plugin is made from there");

  // What the Finder writes and what a terminal types can differ: é as one character or as e and its accent.
  if (process.platform === "darwin") {
    const decomposed = spawnSync(process.execPath, [path.join(ROOT, "cli", "main.mjs").normalize("NFD"), "status"], { env, encoding: "utf8", timeout: 20000 });
    check(/isn't running/.test(decomposed.stdout), `the same folder spelled with decomposed accents works too (${decomposed.stderr.trim().slice(0, 160)})`);
  }

  // The daemon itself, in the foreground, as a supervisor would run it.
  const run = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env, stdio: "ignore" });
  check(await until(health), "`run` starts it too");
  run.kill("SIGTERM");
  await until(async () => !(await health()));
} catch (e) {
  check(false, `crashed: ${e.stack}`);
}
await stop().catch(() => {});
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
