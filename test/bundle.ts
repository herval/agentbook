#!/usr/bin/env node
// agentbook as one file (build.ts): plugin/agentbook.mjs, in a plugin folder with no server/ or web/ beside it, runs
// all of it. agentbook-cli's commands, `webui` (the page's server and the page itself, from inside the bundle), a
// session's hooks and its MCP server, each through the launcher that already starts it (cli/main.mjs, hooks/hook.mjs,
// mcp/server.mjs), which picks the bundle when it's there.
// Run: node test/bundle.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../build.ts";
import { freePort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-bundle-")));
const ROOT = path.join(BASE, "plugin");
const BUNDLE = path.join(ROOT, "agentbook.mjs");
const CLI_PORT = await freePort(6800, 40);
const PAGE_PORT = await freePort(6850, 40);
const PAGE = `http://127.0.0.1:${PAGE_PORT}`;
const USER = path.join(BASE, "person");
fs.mkdirSync(USER, { recursive: true });
fs.cpSync(path.join(REPO, "plugin"), ROOT, { recursive: true, filter: (p) => path.basename(p) !== "agentbook.mjs" });
// Its data folder isn't ~/.agentbook, which on a machine on nobody's account serves only the first run's page
// (test/first-run-account.ts): this one serves the whole page, for nobody to sign in to yet.
const env = { PATH: process.env.PATH, HOME: USER, LANG: "en_US.UTF-8", CLAUDE_CONFIG_DIR: path.join(USER, ".claude"), AGENTBOOK_HOME: path.join(USER, "agentbook-data"), AGENTBOOK_PORT: String(CLI_PORT), AGENTBOOK_SERVER_PORT: String(PAGE_PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_LINK_POLL_MS: "100", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_DESKTOP_DIRS: "" };

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const node = (args: string[], more: { input?: string; env?: Record<string, string> } = {}) => spawnSync(process.execPath, args, { env: { ...env, ...more.env }, input: more.input, encoding: "utf8", timeout: 60e3 });
const get = (port: number, route: string) => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
const health = () => get(CLI_PORT, "/api/health").then((r) => r?.json().catch(() => null));
async function until<T>(fn: () => Promise<T>, ms = 15e3) {
  let v: T;
  for (const end = Date.now() + ms; !(v = await fn()) && Date.now() < end; ) await sleep(100);
  return v;
}
const stop = async () => {
  const h = await health();
  if (h?.pid) process.kill(h.pid, "SIGTERM");
  await until(async () => !(await health()));
};

try {
  const bytes = await buildBundle({ out: BUNDLE });
  check(fs.existsSync(BUNDLE) && bytes > 1e6, `build.ts makes it (${(bytes / 1048576).toFixed(1)} MB)`);
  const text = fs.readFileSync(BUNDLE, "utf8");
  check(!/^import .* from "(?!node:)/m.test(text), "and it imports nothing but Node's own modules");

  const status = node([path.join(ROOT, "cli", "main.mjs"), "status"]);
  check(status.status === 0 && /isn't running/.test(status.stdout), `agentbook-cli's commands run from it (${status.stderr.trim().slice(0, 160)})`);
  const version = node([BUNDLE, "--version"]);
  const { version: v } = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  check(version.stdout.includes(v), `and it knows its version from the plugin folder it's in (${version.stdout.trim()})`);

  // The page: its server and its code are the bundle's; there's no server/ or web/ anywhere near.
  const up = node([BUNDLE, "webui", "--no-open"]);
  check(up.status === 0 && up.stdout.includes(PAGE), `webui serves the page from it (${(up.stdout + up.stderr).trim().split("\n")[0]})`);
  const index = await get(PAGE_PORT, "/");
  const html = index ? await index.text() : "";
  check(index?.ok && html.includes('src="/app.js"'), "its page loads");
  const app = await get(PAGE_PORT, "/app.js");
  check(app?.ok && /javascript/.test(app.headers.get("content-type") || "") && (await app.text()).length > 100e3, "with the page's code, built into the bundle");
  const css = await get(PAGE_PORT, "/agentbook.css");
  check(css?.ok && (await css.text()).includes(".card"), "and its stylesheet");
  const font = await get(PAGE_PORT, "/fonts/Geist-Variable.woff2");
  check(font?.ok && font.headers.get("content-type") === "font/woff2", "and its fonts");
  const me = await fetch(`${PAGE}/api/auth/me`).then((r) => (r.ok ? (r.json() as Promise<Json>) : null)).catch(() => null);
  check(me && me.user === null && me.account === false, "and its server answers: nobody's signed in, on a machine on no account yet");
  await stop();

  const hook = node([path.join(ROOT, "hooks", "hook.mjs"), "SessionStart"], { input: JSON.stringify({ session_id: "s-1", cwd: USER, source: "startup" }), env: { CLAUDE_PLUGIN_ROOT: ROOT, AGENTBOOK_PID: "930101" } });
  check(hook.status === 0 && !hook.stderr.trim(), `a session's hook runs from it (${hook.stderr.trim().slice(0, 160)})`);
  check(await until(health), "and starts agentbook-cli from it");
  await stop();
  // It ends when its input does, as a session's does: the question goes in, and the input stays open for the answer.
  const mcp = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], { env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT, AGENTBOOK_PID: "930101", AGENTBOOK_PROC: "codex:t1" }, stdio: ["pipe", "pipe", "pipe"] });
  let said = "";
  let err = "";
  mcp.stdout.on("data", (d) => (said += d));
  mcp.stderr.on("data", (d) => (err += d));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
  await until(async () => said.includes('"id":1'), 10e3);
  mcp.kill();
  check(/"serverInfo":\{"name":"agentbook"/.test(said), `its MCP server answers from it (${err.trim().slice(0, 160)})`);
} finally {
  await stop();
  fs.rmSync(BASE, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "All passed.");
process.exit(failures ? 1 : 0);
