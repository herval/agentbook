#!/usr/bin/env node
// A machine that's installed agentbook-cli and hasn't logged in: it follows nothing, runs none of its agents, changes
// none of their settings, and tells a session the truth about that. Once it logs in, all of that starts.
// Run: node test/first-run.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { createStore } from "../plugin/shared/store.ts";
import { createUplink } from "../plugin/cli/uplink.ts";
import type { opTo } from "../plugin/shared/protocol.ts";
import type { State } from "../plugin/shared/types.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-first-run-")));
const HUB_PORT = testPort(4500);
const CLI_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const CLI = `http://127.0.0.1:${CLI_PORT}`;
const USER = path.join(BASE, "person");
const DATA = path.join(USER, ".agentbook");
const CALLS = path.join(BASE, "calls.log");

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => unknown, ms = 8000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
};

// Agents that write down each time they're run.
const bin = path.join(BASE, "bin");
fs.mkdirSync(bin, { recursive: true });
for (const name of ["claude", "codex"]) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${CALLS}"\necho '[]'\n`, { mode: 0o755 });
}
fs.mkdirSync(path.join(USER, ".codex"), { recursive: true });
fs.mkdirSync(path.join(USER, ".claude"), { recursive: true });
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, "utf8") : "");

const env = { ...process.env, HOME: USER, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(USER, ".claude"), AGENTBOOK_HOME: DATA, AGENTBOOK_PORT: String(CLI_PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_LINK_POLL_MS: "100", AGENTBOOK_RUNTIME_MS: "100", AGENTBOOK_CLAUDE: path.join(bin, "claude"), AGENTBOOK_CODEX_BIN: path.join(bin, "codex"), AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_NOTIFY: "0" };
for (const k of ["AGENTBOOK_START_UNLINKED", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR"]) delete env[k];

const hook = (event: string, input: object) =>
  spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: "s-1", cwd: USER, ...input }), env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT, AGENTBOOK_PID: "930001" }, encoding: "utf8", timeout: 20000 }).stdout;
const mcp = async (msg: object): Promise<Json> => (await fetch(`${CLI}/api/mcp?proc=930001`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...msg }) })).json();
const command = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "cli", "main.mjs"), ...args], { env, encoding: "utf8", timeout: 20000 }).stdout;
const status = (): Promise<Json> => fetch(`${CLI}/api/status`).then((r) => r.json()).catch(() => null);

const cli = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env, stdio: "ignore" });
const hubEnv = { ...env, HOME: path.join(BASE, "hub-user"), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_MACHINE: "hub", AGENTBOOK_CODEX: "0", AGENTBOOK_CLAUDE_CODE: "0" };
let hub: { kill(signal?: NodeJS.Signals): unknown } = { kill() {} };

try {
  check(await until(status), "it starts");
  await sleep(1500); // its polls, at AGENTBOOK_RUNTIME_MS, would have run a dozen times by now

  // ---------- not logged in ----------
  check(calls() === "", `it runs none of its agents (${JSON.stringify(calls().slice(0, 120))})`);
  check(!fs.existsSync(path.join(USER, ".codex", "config.toml")), "and leaves Codex's settings alone");

  const said = hook("SessionStart", { source: "startup" });
  const context = JSON.parse(said || "{}").hookSpecificOutput?.additionalContext || "";
  check(/isn't logged in/.test(context) && context.includes("login <server address>") && context.includes(path.join(ROOT, "cli", "main.mjs")), "a session hears it isn't logged in, and how to");
  check(!/is a thread on|You appear as/.test(context) && !context.includes(CLI), "and not that it's a thread, or an address that's a 404");
  hook("UserPromptSubmit", { prompt: "hello" });
  check((await status())?.waiting === undefined || (await status())?.waiting === 0, "nothing of it waits to go up");
  const hi: Json = await (await fetch(`${CLI}/api/hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proc: "930002", cwd: USER }) })).json();
  check(hi.login === true && hi.post === null, "and hello keeps nothing");

  const init = await mcp({ method: "initialize", params: {} });
  check(/isn't logged in/.test(init.result?.instructions), "the MCP server's instructions say so too");
  const tool = await mcp({ method: "tools/call", params: { name: "ab_update", arguments: { text: "hi" } } });
  check(tool.result?.isError && /isn't logged in/.test(tool.result.content[0].text) && !tool.result.content[0].text.includes(CLI), "and so does a tool, without an address to go to");
  check((await mcp({ method: "tools/list" })).result?.tools?.length > 0, "its tools are listed all the same, for when it logs in");

  check(/follows nothing yet: agentbook-cli login/.test(command("status")), "status says what to do");

  // ---------- it logs in ----------
  fs.mkdirSync(path.join(BASE, "hub-user"), { recursive: true });
  hub = spawnAgentbook({ env: hubEnv, stdio: "ignore" });
  check(await until(async () => (await fetch(`${HUB}/api/health`).catch(() => null))?.ok), "a server starts");
  const made = await fetch(`${HUB}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  const cookie = (made.headers.get("set-cookie") || "").split(";")[0];
  const post = async (p: string, body: unknown, headers = {}): Promise<Json> => (await fetch(HUB + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json();
  const asked = await post("/api/devices/start", { name: "laptop" });
  await post("/api/devices/approve", { code: asked.code }, { cookie });
  const got: Json = await (await fetch(`${HUB}/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).json();
  check(!!got.token, "the machine gets a token");
  fs.mkdirSync(path.join(DATA, "cli"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "cli", "device.json"), JSON.stringify({ server: HUB, token: got.token, name: got.name, user: got.user }), { mode: 0o600 });

  check(await until(async () => (await status())?.connected), "it connects");
  check(await until(() => /^claude /m.test(calls()) && /^codex /m.test(calls())), "and starts following its agents");
  const after = JSON.parse(hook("SessionStart", { source: "resume", session_id: "s-2" }) || "{}").hookSpecificOutput?.additionalContext || "";
  check(/thread/.test(after) && !/isn't logged in/.test(after), "a session is a thread now");

  // ---------- what the person says at login ----------
  const login = async (home: string, ...args: string[]) => {
    const child = spawn(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "login", HUB, "--no-start", ...args], { env: { ...env, AGENTBOOK_HOME: home, AGENTBOOK_PORT: String(CLI_PORT + 1) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    await until(() => /code=/.test(out));
    await post("/api/devices/approve", { code: out.match(/code=([\w-]+)/)?.[1] }, { cookie });
    await new Promise((r) => child.once("exit", r));
    return { out, gate: JSON.parse(fs.readFileSync(path.join(home, "cli", "gate.json"), "utf8")) };
  };
  const quiet = await login(path.join(BASE, "quiet"), "--name", "quiet");
  check(/--history sends your past sessions/.test(quiet.out) && /--codex-tools adds/.test(quiet.out), `with nobody at the terminal it says what's left out (${JSON.stringify(quiet.out.slice(0, 160))})`);
  check(Math.abs(Date.now() - Date.parse(quiet.gate.history_from)) < 60e3 && quiet.gate.codex_tools === false, "and it's no to both, kept on the machine");
  const open = await login(path.join(BASE, "open"), "--name", "open", "--history", "--codex-tools", "--private");
  check(open.gate.history_from === null && open.gate.codex_tools === true && open.gate.private_terminals === true, "its flags say yes");
  const again = await login(path.join(BASE, "open"), "--name", "open");
  check(again.gate.history_from === null && again.gate.codex_tools === true, "and a later login keeps what was said");
  check(/Private terminals is on here/.test(command("private", "on")), "agentbook-cli private turns it on here");
  check(/isn't on here/.test(command("private", "off")), "and off");

  // ---------- from now on, and no change to Codex's settings ----------
  const home3 = path.join(BASE, "from-now");
  await login(home3, "--name", "from-now");
  const gateFile = path.join(home3, "cli", "gate.json");
  fs.writeFileSync(gateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(gateFile, "utf8")), history_from: new Date(Date.now() - 600e3).toISOString() }));
  const sock = path.join(BASE, "codex.sock");
  const codexLog = path.join(BASE, "codex.jsonl");
  const codex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), sock, codexLog, USER], { stdio: "ignore" });
  const follower = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: { ...env, AGENTBOOK_HOME: home3, AGENTBOOK_PORT: String(CLI_PORT + 2), AGENTBOOK_CODEX_SOCK: sock, AGENTBOOK_CODEX_SYNC_MS: "300", AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"), AGENTBOOK_CODEX_HOME: path.join(BASE, "codex-home") }, stdio: "ignore" });
  try {
    const get = async (p: string): Promise<Json> => (await fetch(HUB + p, { headers: { cookie } })).json();
    const threads = async () => ((await stateOf(get)).sessions || []).map((t) => t.id);
    check(await until(async () => (await threads()).includes("th-live"), 15000), "a Codex thread used since then shows up");
    check(!(await threads()).includes("th-quiet"), "and one last used two hours ago, before the login, doesn't");
    const asked = fs.readFileSync(codexLog, "utf8");
    check(/thread\/list/.test(asked) && !/config\/value\/write/.test(asked), "and Codex's settings aren't written");
  } finally {
    follower.kill("SIGKILL");
    codex.kill("SIGKILL");
  }

  // ---------- a machine with threads already, logging in to a new server ----------
  // Its folder said outright: createStore's default is the real agentbook's database.
  const dataDir = path.join(BASE, "store");
  fs.mkdirSync(dataDir, { recursive: true });
  const store = createStore({ file: path.join(dataDir, "agentbook.db"), filesDir: path.join(dataDir, "files"), legacy: false, acks: true });
  store.commit({ t: "session.hello", proc: "p1", session_id: "old", agent: "claude", label: "wren", kind: "claude-code" });
  store.commit({ t: "session.hello", proc: "p2", session_id: "new", agent: "claude", label: "lark", kind: "claude-code" });
  store.commit({ t: "message.add", post: "old", from: "agent", text: "from long ago" });
  store.commit({ t: "message.add", post: "new", from: "agent", text: "from today" });
  store.state.sessions.old.updated = "2020-01-01T00:00:00.000Z";
  // What the uplink pushes: the whole state, or ops.
  type Batch = { state?: State; ops: ReturnType<typeof opTo>[] };
  const pushed: Batch[] = [];
  const transport = { name: "test", hello: async () => ({ cursor: 0, empty: true }), push: async (b: Batch) => (pushed.push(b), { acked: b.state?.seq || 0 }), commands: () => new Promise(() => {}), result: async () => ({}) };
  const up = createUplink({ store, transport, onCommand: async () => ({}), epoch: "e1", historyFrom: () => Date.now() - 60e3 });
  await up.push();
  const whole = pushed.find((b) => b.state)?.state;
  check(whole && Object.keys(whole.sessions).join() === "new" && whole.messages.every((m) => m.post === "new") && Object.values(whole.procs).join() === "new", "the threads it was told to keep back stay on the machine");
} finally {
  cli.kill("SIGKILL");
  hub.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(BASE, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
