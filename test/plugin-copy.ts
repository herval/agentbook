#!/usr/bin/env node
// Dev mode: sessions run on a copy of the plugin folder, never on the folder itself, so a session can edit
// agentbook without editing its own hooks. A copy per version of the folder, made when a session starts or
// wakes; a session that started on the folder (or an older copy) wakes on the copy of it as it is now; and
// copies nobody used for a week go. Run: node test/plugin-copy.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-plugin-copy-"));
const PORT = testPort(5100);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
const COPIES = path.join(HOME, "cli", "plugin-copies");
// The plugin folder in dev mode: a copy of the real one, so the test can edit it, with the server beside it, as
// in the repo.
const DEV = path.join(HOME, "agentbook", "plugin");
fs.mkdirSync(FAKE);
fs.cpSync(ROOT, DEV, { recursive: true });
fs.cpSync(path.join(ROOT, "..", "server"), path.join(HOME, "agentbook", "server"), { recursive: true });
// And the page beside it, whose code the server shares (web/lib) and builds to serve.
fs.cpSync(path.join(ROOT, "..", "web"), path.join(HOME, "agentbook", "web"), { recursive: true });
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_PLUGIN_DIR: DEV,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
};
for (const k of ["AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
// The machine shares the test's folders with its server (its gate).
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const pluginOf = (args) => args[args.indexOf("--plugin-dir") + 1];
const launch = async (prompt) => {
  const r = await post("/api/launch", { prompt, root: project, agent: "claude" });
  return calls().find((c) => c.env.AGENTBOOK_LAUNCH_ID === r.lid);
};
const savedFlags = (id) => JSON.parse(fs.readFileSync(path.join(HOME, "claude", "jobs", id, "state.json"), "utf8")).respawnFlags;
const hook = (event, input, pid) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });

// A copy from long ago, that nobody uses any more.
const stale = path.join(COPIES, "000000000000");
fs.mkdirSync(stale, { recursive: true });
const longAgo = new Date(Date.now() - 8 * 86400e3);
fs.utimesSync(stale, longAgo, longAgo);
// And one made at the top of agentbook's folder, where they were made until 2026-10-17.
const staleOld = path.join(HOME, "plugin-copies", "111111111111");
fs.mkdirSync(staleOld, { recursive: true });
fs.utimesSync(staleOld, longAgo, longAgo);

// A background session from before copies: it started on the folder itself.
const old = "bg-before";
fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify([{ id: old, sessionId: old, kind: "background", state: "working", status: "idle", cwd: project, pid: 5001, name: old }]));
fs.mkdirSync(path.join(HOME, "claude", "jobs", old), { recursive: true });
fs.writeFileSync(path.join(HOME, "claude", "jobs", old, "state.json"), JSON.stringify({ state: "working", sessionId: old, respawnFlags: ["--plugin-dir", DEV, "--model", "opus"] }));

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" }, path.join(DEV, ".."));
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- a session starts on a copy ----------
  const first = await launch("Fix the server");
  const copy = first && pluginOf(first.args);
  check(copy && copy !== DEV && path.dirname(copy) === COPIES, "a session starts on a copy of the plugin folder, not on the folder");
  check(copy && fs.readFileSync(path.join(copy, "hooks", "hook.ts"), "utf8") === fs.readFileSync(path.join(DEV, "hooks", "hook.ts"), "utf8") && fs.existsSync(path.join(copy, ".claude-plugin", "plugin.json")) && fs.existsSync(path.join(copy, ".mcp.json")), "the copy has all of it: hooks, MCP server and manifest");
  check(!fs.existsSync(stale) && fs.existsSync(copy), "copies nobody used for a week go");
  check(!fs.existsSync(path.join(HOME, "plugin-copies")), "and so do the ones at the top of agentbook's folder, then their folder");

  const second = await launch("Fix the page");
  check(second && pluginOf(second.args) === copy && fs.readdirSync(COPIES).length === 1, "while the folder doesn't change, sessions share its copy");

  // ---------- an edit reaches the sessions after it, not the ones before ----------
  fs.appendFileSync(path.join(DEV, "hooks", "hook.ts"), "\n// an edit\n");
  const third = await launch("Fix the hooks");
  const edited = third && pluginOf(third.args);
  check(edited && edited !== copy && fs.readFileSync(path.join(edited, "hooks", "hook.ts"), "utf8").endsWith("// an edit\n"), "after an edit, the next session gets a copy with it");
  check(!fs.readFileSync(path.join(copy, "hooks", "hook.ts"), "utf8").includes("// an edit"), "and the sessions already running keep theirs as it was");

  // ---------- a session that started on the folder wakes on a copy ----------
  hook("SessionStart", { session_id: old, source: "startup" }, 7001);
  hook("UserPromptSubmit", { prompt: "Work on it" }, 7001);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." }, 7001);
  const mark = calls().length;
  await post(`/api/sessions/${old}/messages`, { text: "Back to it" });
  const woke = await until(() => calls().slice(mark).find((c) => c.args.includes("--resume") && c.args.includes(old)), 8000);
  const flags = savedFlags(old);
  check(woke && pluginOf(flags) === edited && flags.includes("--model") && !woke.args.includes("--plugin-dir"), "a session that started on the folder wakes on the copy of it as it is now, keeping its other options");

  // ---------- bin/agentbook dev ----------
  const printed = spawnSync(process.execPath, [path.join(DEV, "cli", "plugin-copy.ts"), DEV], { env, encoding: "utf8" }).stdout.trim();
  check(printed === edited, "agentbook dev gets the same copy for its terminal session");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
