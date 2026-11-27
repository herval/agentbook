#!/usr/bin/env node
// A local agent needs no workspace. Started with none, it works in a temp folder of its own, made for it alone and
// trusted in Claude Code, which threads call `temp` and Add a workspace doesn't offer. A start the server sends again
// stays in the folder it had. It's still "pick a folder" for one that's to be on a branch, which a temp folder can't be.
// (That an operator can't start one in a temp folder is in test/agent-follows.ts, and Hermes in test/hermes.ts.)
// Run: node test/no-workspace.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-no-ws-"));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
const CONFIG = path.join(HOME, "claude");
const project = path.join(HOME, "dev", "app");
const CODEX_SOCK = path.join(HOME, "codex.sock");
const CODEX_LOG = path.join(HOME, "codex.jsonl");
for (const d of [FAKE, CONFIG, project, path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX_SOCK: CODEX_SOCK,
  AGENTBOOK_CODEX_SYNC_MS: "1000",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: CONFIG,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = () => jsonl(path.join(FAKE, "calls.jsonl"));
const started = (prompt) => calls().filter((c) => c.args.includes("--bg") && !c.args.includes("--resume") && c.args[0] === prompt);
const hook = (event, input, pid, more = {}) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...env, AGENTBOOK_PID: String(pid), ...more }, encoding: "utf8" });
const launch = async (lid) => (await state()).launches?.find((l) => l.id === lid);
const TEMP = path.join(fs.realpathSync(os.tmpdir()), "agentbook-temp-");
const inTemp = (dir) => !!dir && dir.startsWith(TEMP) && path.basename(dir) === "temp";
const made = [];
const trusted = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG, ".claude.json"), "utf8")).projects[dir]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
};

const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), CODEX_SOCK, CODEX_LOG, project], { stdio: "ignore" });
await until(() => fs.existsSync(CODEX_SOCK), 3000);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- Claude Code ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-a");
  const a = await post("/api/launch", { prompt: "Try something out", agent: "claude" });
  const [call1] = await until(() => (started("Try something out").length ? started("Try something out") : null));
  const dir = call1?.cwd;
  made.push(dir);
  check(a.status === 200 && inTemp(dir), `Claude Code starts in a temp folder (${dir})`);
  check(a.cwd === dir && (await launch(a.lid))?.root === dir, "which is the folder its start says, by its real path, as Claude Code goes by");
  check(fs.statSync(path.dirname(dir)).mode % 0o1000 === 0o700, "made for this user alone");
  check(fs.readdirSync(dir).length === 0, "and empty");
  check(trusted(dir), "Claude Code trusts it, or a background session wouldn't start");
  hook("SessionStart", { session_id: "sess-a", source: "startup", cwd: dir }, 930001, { AGENTBOOK_LAUNCH_ID: a.lid, AGENTBOOK_LABEL: "lark" });
  const thread = await until(async () => (await state()).sessions.find((s) => s.id === "sess-a"));
  check(thread?.repo === "temp" && thread?.root === dir, "its thread calls the folder temp");

  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-b");
  const b = await post("/api/launch", { prompt: "Try something else", agent: "claude" });
  const [call2] = await until(() => (started("Try something else").length ? started("Try something else") : null));
  made.push(call2?.cwd);
  check(b.status === 200 && inTemp(call2?.cwd) && call2.cwd !== dir, "another start gets a folder of its own");

  // One whose folder was picked starts there, as ever.
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-c");
  const c = await post("/api/launch", { prompt: "In the app", agent: "claude", root: project });
  check(c.status === 200 && (await until(() => started("In the app")[0]))?.cwd === fs.realpathSync(project), "a picked folder is still where it starts");
  hook("SessionStart", { session_id: "sess-c", source: "startup", cwd: project }, 930003, { AGENTBOOK_LAUNCH_ID: c.lid, AGENTBOOK_LABEL: "wren" });

  // Add a workspace offers the folders your agents worked in.
  const listed = await until(async () => {
    const s = await state();
    return s.sessions.some((x) => x.id === "sess-c") && (s.folders || []).some((f) => f.root === fs.realpathSync(project) || f.root === project) ? s : null;
  });
  check(!!listed, "the folder of a thread shows in this machine's folders");
  check(!(listed?.folders || []).some((f) => f.root.startsWith(TEMP)), "and temp folders don't");

  // ---------- on a branch ----------
  for (const [k, v] of [["worktree", true], ["branch", "fix/it"]] as const) {
    const r = await post("/api/launch", { prompt: `On a branch, ${k}`, agent: "claude", [k]: v });
    check(r.status === 400 && /Pick a folder/.test(r.error || ""), `a start with a ${k} still needs a folder (${r.status})`);
  }

  // ---------- a start the server sends again ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-d");
  fs.writeFileSync(path.join(FAKE, "slow.txt"), "3000");
  const going = post("/api/launch", { prompt: "Restarted meanwhile", agent: "claude" });
  check(!!(await until(() => started("Restarted meanwhile").length)), "Claude Code is starting one");
  await server.restart("agentbook-cli");
  const d = await going;
  fs.rmSync(path.join(FAKE, "slow.txt"), { force: true });
  const l = await until(async () => {
    const x = await launch(d.lid);
    return x?.session ? x : null;
  });
  made.push(l?.root);
  check(d.status === 200 && started("Restarted meanwhile").length === 1, "agentbook-cli restarted meanwhile, and the start sent again doesn't start a second session");
  check(inTemp(l?.root) && l.root === started("Restarted meanwhile")[0].cwd, "it's the same temp folder");

  // ---------- Codex ----------
  await until(async () => (await state()).agents.some((x) => x.id === "codex"), 8000);
  const x = await post("/api/launch", { prompt: "Try it in Codex", agent: "codex" });
  const opened = await until(() => jsonl(CODEX_LOG).find((e) => e.method === "thread/start"));
  const codexDir = opened?.params?.cwd;
  made.push(codexDir);
  check(x.status === 200 && inTemp(codexDir), `Codex starts in a temp folder (${codexDir}, ${x.status} ${x.error || ""})`);
  check(fs.existsSync(codexDir || ""), "that's there");
} finally {
  server.kill("SIGTERM");
  fakeCodex.kill();
  await sleep(300);
  for (const d of made) if (d?.startsWith(TEMP)) fs.rmSync(path.dirname(d), { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nAll passed.");
process.exit(failures ? 1 : 0);
