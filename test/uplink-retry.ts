#!/usr/bin/env node
// A machine and a server it can't talk to. It tries again less and less often, at random intervals, and what waits goes
// up once it's back. A server that won't have its token is tried only once more as each new thread starts: the machine
// stops, its threads and `status` say what to do, and everything goes again once the server takes it. What it did before stays: a too-old machine, a refused state.
// Run: node test/uplink-retry.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, halves, spawnAgentbook } from "./harness.ts";
import { createStore, type Store } from "../plugin/shared/store.ts";
import { createUplink } from "../plugin/cli/uplink.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-retry-")));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
};
let stores = 0;
const storeWith = (n = 1) => {
  const name = `s${++stores}`;
  const store = createStore({ file: path.join(BASE, name, "agentbook.db"), filesDir: path.join(BASE, name, "files"), legacy: false, acks: true });
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  for (let i = 0; i < n; i++) store.commit({ t: "message.add", post: "s1", from: "agent", text: `m${i}` });
  return store;
};
const refuse = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
// A server: `down` says how it fails, else it takes what it's sent.
const serverFor = (store: Store, { hello }: { hello?: () => { cursor: number; empty: boolean } } = {}) => {
  const t = {
    name: "srv",
    down: null,
    once: null, // how the next hello fails, that one only
    hellos: [],
    pushes: [],
    polls: 0,
    hello: async () => {
      t.hellos.push(Date.now());
      if (t.once) {
        const e = t.once;
        t.once = null;
        throw e;
      }
      if (t.down) throw t.down;
      return hello ? hello() : { cursor: 0, empty: false };
    },
    push: async (b) => {
      if (t.down) throw t.down;
      t.pushes.push(b);
      return { acked: b.ops.at(-1)?.seq ?? store.state.seq };
    },
    commands: async () => {
      t.polls++;
      if (t.down) throw t.down;
      await sleep(30);
      return [];
    },
    result: async () => ({}),
  };
  return t;
};
const noCommand = async () => ({});

try {
  // ---------- a server that doesn't answer ----------
  {
    const store = storeWith();
    const t = serverFor(store);
    t.down = new Error("srv isn't running");
    const random = Math.random;
    Math.random = () => 0; // each wait as short as its jitter allows
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e" });
    up.start();
    await sleep(3000);
    Math.random = random;
    const gaps = t.hellos.slice(1).map((at, i) => at - t.hellos[i]);
    check(t.hellos.length >= 3 && t.hellos.length <= 9, `it says hello a handful of times in 3 s (${t.hellos.length}), not four times a second`);
    check(gaps.every((gap, i) => gap >= Math.min(250 * 2 ** i, 60e3) / 2 - 5), `and waits about twice as long each time (${gaps.join(", ")} ms)`);
    check(!up.status().connected && /isn't running/.test(up.status().error) && up.status().waiting > 0, "status says it can't reach it, with what waits");
    t.down = null;
    check(await until(() => up.status().connected && up.status().waiting === 0, 10e3), "once it's back it connects, and what waited goes up");
    const before = t.hellos.length;
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "after" });
    check(await until(() => t.pushes.at(-1)?.ops?.some((o) => o.args.text === "after")) && t.hellos.length === before, "and a new change goes at once, without another hello");
  }

  // ---------- jitter, and the longest wait ----------
  {
    const waits = [];
    for (const r of [0, 0.999]) {
      const store = storeWith();
      const t = serverFor(store);
      t.down = new Error("no");
      const random = Math.random;
      Math.random = () => r;
      const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 100 });
      await up.push();
      const from = Date.now();
      await until(async () => (await up.push(), t.hellos.length > 1), 3000);
      Math.random = random;
      waits.push(Date.now() - from);
    }
    check(waits[0] < waits[1], `a wait is cut at random (${waits.join(" and ")} ms)`);
    const store = storeWith();
    const t = serverFor(store);
    t.down = new Error("no");
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 10, retryMaxMs: 40 });
    up.start();
    await sleep(1000);
    check(t.hellos.length >= 12, `however long it's down it keeps trying, at the longest wait (${t.hellos.length} in 1 s, at 40 ms at most)`);
  }

  // ---------- a server that won't have its token ----------
  for (const status of [401, 403]) {
    const store = storeWith();
    const t = serverFor(store);
    const logged = [];
    t.down = refuse(status, "This machine isn't logged in to this agentbook-server.");
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 10, log: (l) => logged.push(l) });
    up.start();
    await sleep(600);
    check(t.hellos.length === 1 && t.polls === 0, `a ${status} on hello stops it: one hello, and no polling (${t.hellos.length}, ${t.polls})`);
    const st = up.status();
    check(/isn't logged in/.test(st.signed_out || "") && !st.connected && st.waiting > 0 && !st.blocked, "status says so, and that what it has still waits");
    check(logged.filter((l) => /refused this machine's token/.test(l)).length === 1, "and the log says so once");
    await up.push();
    check(t.hellos.length === 1, "nothing tries again, a push included");
  }
  {
    const store = storeWith();
    const t = serverFor(store);
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 10 });
    up.start();
    check(await until(() => up.status().connected && up.status().waiting === 0), "(a machine that's connected)");
    const { length: hellos } = t.hellos;
    t.down = refuse(403);
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "refused" });
    check(await until(() => up.status().signed_out), "a 403 when it's connected stops it too");
    const polls = t.polls;
    await sleep(300);
    check(t.hellos.length === hellos && t.polls === polls, "and nothing goes after it");
  }

  // ---------- once more as a thread starts ----------
  {
    const store = storeWith();
    const t = serverFor(store);
    const logged = [];
    t.down = refuse(401, "This machine isn't logged in to this agentbook-server.");
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 10, log: (l) => logged.push(l) });
    up.start();
    check(await until(() => up.status().signed_out), "(a 401 stops it)");
    const stopped = up.status().signed_out_tried;
    check(!Number.isNaN(Date.parse(stopped)), `status says when it last tried (${stopped})`);
    await sleep(20);
    await Promise.all([up.tryAgain(), up.tryAgain()]);
    check(t.hellos.length === 2 && up.status().signed_out && up.status().signed_out_tried > stopped, `two threads starting at once try once more, together (${t.hellos.length - 1}), and it stays stopped`);
    check(logged.filter((l) => /refused this machine's token/.test(l)).length === 1 && logged.filter((l) => /still refuses/.test(l)).length === 1, "the log says it's still refused, not that it stopped again");
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "while stopped" });
    await sleep(400);
    await up.push();
    check(t.hellos.length === 2 && t.polls === 0, "nothing tries in between, a change or a push included");
    t.down = null;
    await sleep(300);
    check(t.hellos.length === 2, "nor once the server would take it: nothing's on a timer");
    // A connection dropped as it's reused says nothing of the login.
    t.once = Object.assign(new Error("read ECONNRESET"), { reset: true });
    await up.tryAgain();
    check(t.hellos.length === 4, `a try whose connection drops is made again at once (${t.hellos.length - 2} hellos)`);
    check(!up.status().signed_out && up.status().connected && !("signed_out_tried" in up.status()), "the next thread to start finds it's over");
    check(await until(() => up.status().waiting === 0 && t.polls > 0), "and everything resumes: what waited goes up, and commands are asked for again");
    check(t.pushes.flatMap((p) => p.ops).some((o) => o.args?.text === "while stopped") && logged.some((l) => /takes this machine's token again/.test(l)), "what was written while stopped among it, and the log says so");
    const hellos = t.hellos.length;
    await up.tryAgain();
    check(t.hellos.length === hellos, "a thread starting while it's connected asks for nothing more");
    t.down = refuse(403);
    store.commit({ t: "message.add", post: "s1", from: "agent", text: "refused again" });
    check(await until(() => up.status().signed_out), "a later refusal stops it again");
    check(logged.filter((l) => /refused this machine's token/.test(l)).length === 2, "as a stop of its own");
    const polls = t.polls;
    await sleep(300);
    check(t.polls === polls, "with nothing polling");
  }

  // ---------- what it did before stays ----------
  {
    const store = storeWith();
    const t = serverFor(store);
    t.down = refuse(426, "This agentbook-cli is too old for this server: update it.");
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 1 });
    await up.push();
    await sleep(5);
    await up.push();
    check(/too old/.test(up.status().blocked || "") && !up.status().signed_out && t.hellos.length === 2, "a machine too old says so, and is tried again: an update can change that");
    t.down = null;
    await sleep(5);
    await up.push();
    check(up.status().connected && !up.status().blocked, "and it's over once its server takes it");
  }
  {
    const store = storeWith();
    const t = serverFor(store, { hello: () => ({ cursor: 0, empty: true }) });
    let refusing = true;
    const take = t.push;
    t.push = async (b) => (b.state && refusing ? (t.pushes.push(b), { acked: 0, error: "a thread's prompt isn't text" }) : take(b));
    const up = createUplink({ store, transport: t, onCommand: noCommand, epoch: "e", retryMs: 1 });
    const offers = () => t.pushes.filter((p) => p.state).length;
    await up.push();
    for (let i = 0; i < 5; i++) await sleep(3), await up.push();
    check(offers() === 1 && t.hellos.length > 1 && /didn't take/.test(up.status().blocked || ""), `a refused state isn't offered again at each try (${offers()} of ${t.hellos.length})`);
    const now = Date.now;
    Date.now = () => now() + 6 * 60e3;
    refusing = false;
    await sleep(3);
    await up.push();
    Date.now = now;
    check(offers() === 2 && up.status().connected && !up.status().blocked, "after 5 minutes it is, and that's the end of it");
  }

  // ---------- a real server revoking a real token ----------
  {
    const PORT = await freePort(6540, 40);
    const HOME = path.join(BASE, "machine");
    const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_CODEX: "0", AGENTBOOK_CODEX_MCP: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE_ROUTINES: "0", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: ROOT };
    for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR"]) delete env[k];
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    const ab = spawnAgentbook({ env, stdio: "ignore" });
    const URL_ = `http://127.0.0.1:${PORT}`;
    const CLI = `http://127.0.0.1:${halves(PORT).cli}`;
    // Straight to the CLI: the harness's front waits for what a signed-out machine can't send.
    const status = (): Promise<Json> => fetch(`${CLI}/api/status`).then((r) => r.json(), () => null);
    const hook = (event: string, input: Record<string, unknown>) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: "s-1", cwd: BASE, ...input }), env: { ...env, AGENTBOOK_URL: CLI, AGENTBOOK_PORT: String(halves(PORT).cli), AGENTBOOK_PID: "930201" }, encoding: "utf8", timeout: 20000 }).stdout;
    const contextOf = (out: string) => JSON.parse(out || "{}").hookSpecificOutput?.additionalContext || "";
    const ask = (name: string, args: Record<string, unknown>): Promise<Json> => fetch(`${CLI}/api/mcp?proc=${os.hostname().split(".")[0]}-930201`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.json());
    try {
      check(await until(async () => (await fetch(`${URL_}/api/health`).catch(() => null))?.ok, 20e3), "(a server and a machine start)");
      await fetch(`${URL_}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
      check(await until(async () => (await status())?.connected, 20e3), "(it logs in)");
      hook("SessionStart", { source: "resume" });
      hook("UserPromptSubmit", { prompt: "before" });
      const { server, token } = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "device.json"), "utf8"));
      const revoked = await fetch(`${server}/api/cli/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      check(revoked.ok, "its token is revoked on the server");
      const first = hook("UserPromptSubmit", { prompt: "the first one it can't send" });
      check(await until(async () => (await status())?.signed_out, 40e3), "the machine finds out the next time it sends something");
      const prompt = first + hook("UserPromptSubmit", { prompt: "after" });
      check(prompt.includes("stopped taking this machine's login") && prompt.includes(path.join(ROOT, "cli", "main.mjs")) && prompt.includes(" login "), `a thread hears it at its next prompt, with what to run (${prompt.slice(0, 200)})`);
      check(!hook("UserPromptSubmit", { prompt: "again" }).includes("stopped taking"), "once");
      const start = contextOf(hook("SessionStart", { source: "resume", session_id: "s-2" }));
      check(start.includes("stopped taking this machine's login"), "a thread starting hears it as it starts");
      const asked = await ask("ab_ask", { question: "May I?" });
      check(asked.result?.isError && /logs in again/.test(asked.result.content[0].text), `a question isn't left waiting for an answer nobody can give (${JSON.stringify(asked).slice(0, 160)})`);
      const posted = await ask("ab_update", { text: "a result" });
      check(!posted.result?.isError, `what's only written still is, for later (${JSON.stringify(posted).slice(0, 160)})`);
      const said = spawnSync(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "status"], { env: { ...env, AGENTBOOK_PORT: String(halves(PORT).cli) }, encoding: "utf8", timeout: 20000 }).stdout;
      check(/stopped taking this machine's login/.test(said) && /agentbook-cli login/.test(said) && !/Connected to/.test(said) && !/Can't reach/.test(said), `status says it, and how (${said.split("\n")[1]?.slice(0, 200)})`);
    } finally {
      ab.kill("SIGKILL");
    }
  }

  // ---------- a 403 that passes, through a real server ----------
  {
    const PORT = await freePort(6540, 40);
    const HOME = path.join(BASE, "machine-behind-a-proxy");
    const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_CODEX: "0", AGENTBOOK_CODEX_MCP: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE_ROUTINES: "0", CLAUDE_CONFIG_DIR: path.join(BASE, "claude-proxy"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: ROOT };
    for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR"]) delete env[k];
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    const ab = spawnAgentbook({ env, stdio: "ignore" });
    const URL_ = `http://127.0.0.1:${PORT}`;
    const CLI = `http://127.0.0.1:${halves(PORT).cli}`;
    // Asked again once on a failed connection: an idle one the CLI closes as it's reused fails (ECONNRESET), and this one
    // waits seconds on hooks between asks.
    const ask = (): Promise<Json> => fetch(`${CLI}/api/status`).then((r) => r.json(), () => null);
    const status = async () => (await ask()) ?? (await ask());
    // The proxy below runs in this process, so nothing here may block it: what's run is run without waiting on it.
    const run = (args: string[], { input = "", env: more = {} }: { input?: string; env?: Record<string, string> } = {}) =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, args, { env: { ...env, ...more }, stdio: ["pipe", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.on("close", () => (clearTimeout(timer), resolve(out)));
        child.stdin.end(input);
      });
    // Each thread its own Claude Code process. Straight to the CLI, as above.
    const hook = (event: string, input: Record<string, unknown>, pid = "930211") => run([path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: `s-${pid}`, cwd: BASE, ...input }), env: { AGENTBOOK_URL: CLI, AGENTBOOK_PORT: String(halves(PORT).cli), AGENTBOOK_PID: pid } });
    const contextOf = (out: string) => JSON.parse(out || "{}").hookSpecificOutput?.additionalContext || "";
    const statusLine = async () => (await run([path.join(ROOT, "cli", "main.mjs"), "status"], { env: { AGENTBOOK_PORT: String(halves(PORT).cli) } })).split("\n")[1] || "";
    // In front of the server, as a proxy that's wrong for a while: a 403 for every call of a machine's while `refusing`.
    let refusing = false;
    let hellos = 0;
    let target = null;
    const proxy = http.createServer((req, res) => {
      if (req.url.startsWith("/api/cli/hello")) hellos++;
      if (refusing && req.url.startsWith("/api/cli/")) {
        req.resume();
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Forbidden by the proxy." }));
      }
      const on = http.request(new URL(req.url, target), { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      on.on("error", () => res.destroy());
      req.pipe(on);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      check(await until(async () => (await fetch(`${URL_}/api/health`).catch(() => null))?.ok, 20e3), "(a server and a machine start)");
      await fetch(`${URL_}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
      check(await until(async () => (await status())?.connected, 20e3), "(it logs in)");
      const file = path.join(HOME, "cli", "device.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      target = saved.server;
      fs.writeFileSync(file, JSON.stringify({ ...saved, server: via }));
      await ab.restart("agentbook-cli");
      check(await until(async () => (await status())?.connected && hellos > 0, 20e3), "(it goes through the proxy now)");
      await hook("SessionStart", { source: "resume" });
      await hook("UserPromptSubmit", { prompt: "before" });
      // Started before the stop, with nothing to say during it.
      await hook("SessionStart", { source: "resume" }, "930214");
      refusing = true;
      const first = await hook("UserPromptSubmit", { prompt: "refused by the proxy" });
      check(await until(async () => (await status())?.signed_out, 40e3), "a proxy's 403 stops it");
      check((first + (await hook("UserPromptSubmit", { prompt: "told" }))).includes("stopped taking this machine's login"), "(its thread is told)");
      const stopped = (await status()).signed_out_tried;
      const before = hellos;
      await hook("UserPromptSubmit", { prompt: "a prompt while it's stopped" });
      await sleep(500);
      check(hellos === before, `a prompt doesn't try again (${hellos - before})`);
      await hook("SessionStart", { source: "compact" });
      check(hellos === before, "a thread that only compacted doesn't try");
      const start = contextOf(await hook("SessionStart", { source: "resume" }, "930212"));
      const st = await status();
      check(hellos === before + 1 && st?.signed_out && st.signed_out_tried > stopped, `a thread starting tries once more (${hellos - before}), and it's still refused`);
      check(start.includes("stopped taking this machine's login"), `so that thread is told as it starts (${start.slice(0, 160)})`);
      check(!(await hook("UserPromptSubmit", { prompt: "and again" })).includes("stopped taking"), "and the first isn't told twice");
      const line = await statusLine();
      check(/tries again once as each new thread starts, last at \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(line), `status says when it last tried (${line.slice(0, 220)})`);
      refusing = false;
      await hook("UserPromptSubmit", { prompt: "the proxy would let it through now" });
      await sleep(500);
      check(hellos === before + 1 && (await status())?.signed_out, "nothing tries until a thread starts, even once it would get through");
      const back = contextOf(await hook("SessionStart", { source: "resume" }, "930213"));
      const now = await status();
      check(now && !now.signed_out && now.connected, `the next thread to start finds it's over (${hellos - before} hellos, ${JSON.stringify(now && { signed_out: now.signed_out, connected: now.connected, error: now.error })})`);
      check(back && !back.includes("stopped taking"), "and isn't told it's stopped");
      check(await until(async () => (await status())?.waiting === 0, 20e3), "what waited goes up");
      check(!(await hook("UserPromptSubmit", { prompt: "after" }, "930214")).includes("stopped taking"), "and a thread that hadn't been told isn't now");
      check(!/stopped taking/.test(await statusLine()), "nor does status say so");
      refusing = true;
      const later = await hook("UserPromptSubmit", { prompt: "refused again" });
      check(await until(async () => (await status())?.signed_out, 40e3), "a later refusal stops it again");
      check((later + (await hook("UserPromptSubmit", { prompt: "told again" }))).includes("stopped taking this machine's login"), "and a thread told about the first stop is told about this one");
    } finally {
      ab.kill("SIGKILL");
      proxy.closeAllConnections?.();
      proxy.close();
    }
  }
} catch (e) {
  check(false, `crashed: ${e.stack}`);
}
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
