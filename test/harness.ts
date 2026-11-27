// agentbook in a test, as it runs on a machine: agentbook-server and
// agentbook-cli, two processes, the server under Node's permission model. The test talks to one address, as it
// always has: the routes a machine's sessions use (the hooks, the MCP bridge) reach the CLI there, and the rest (the
// page) the server, as a browser and a session would reach them on their own ports. The first account the test
// makes there logs the CLI in to the server, approved on the page as its person would, before the test hears back.
// harness-front.ts runs that address, and the two halves under it, in a process of its own (a test blocks its
// own while it runs a hook).
//
// spawnAgentbook({ env, stdio }) takes what tests gave server/main.ts when it was one process (`root`: another copy
// of agentbook to run): AGENTBOOK_PORT is that address. The server, with its data in AGENTBOOK_HOME/server, and the
// CLI, with its data in AGENTBOOK_HOME, listen on ports of their own, halves(port) says which. With AGENTBOOK_HUB or
// AGENTBOOK_SERVER, it's a machine logged in to agentbook elsewhere: only its CLI runs, on AGENTBOOK_PORT itself. It
// returns the process, as spawn() did; kill() stops both halves with its signal, SIGKILL included, and restart(name)
// one of them. The server has SECRET_KEY as its AGENTBOOK_SECRET_KEY, unless env says otherwise.

import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poolPort } from "./harness-ports.ts";
import type { CliStatus } from "./harness-types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// What the server takes to make people for a test (server/api/test-people.ts): harness-front.ts adds it to a
// POST /api/auth/test-person through it. A test that calls the server's own port sends it itself.
export const TEST_PEOPLE = "harness-people";
// The key the server seals connectors' API keys with (AGENTBOOK_SECRET_KEY), unless a test gives its own ("" for none).
export const SECRET_KEY = "aGFybmVzcy1zZWNyZXQta2V5LTMyLWJ5dGVzLWxvbmc=";

// Ports: in harness-ports.ts, for the tests that need no server. Every test can keep importing them from here.
export { freePort, poolPort, testPort } from "./harness-ports.ts";
// Starting a process that stops with the test (spawnTied): in harness-tied.ts, which the tests that need no server can
// import on their own too.
export { spawnTied } from "./harness-tied.ts";

// Until the server has what the CLI had by now, AGENTBOOK_PORT being `port`, for a test that's made its first account:
// what a hook said, on a busy machine, can take longer to get there than the hook waits. The CLI can still be logging
// in then, too. `connection: close`, as this socket would sit idle while a hook runs.
export async function caughtUp(port: number, ms = 60e3): Promise<void> {
  const status = (): Promise<CliStatus | null> => fetch(`http://127.0.0.1:${halves(port).cli}/api/status`, { headers: { connection: "close" } }).then((r) => r.json() as Promise<CliStatus>).catch(() => null);
  const end = Date.now() + ms;
  let seq: number | null = null;
  while (Date.now() < end) {
    const st = await status();
    if (st?.server && st.connected) {
      seq ??= st.seq;
      if (st.scanned >= seq) return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export type Half = "agentbook-server" | "agentbook-cli";
// agentbook as a test runs it: the process (harness-front.ts), with restart().
export type Agentbook = ChildProcess & { restart(name: Half): Promise<void> };

// Whether an agentbook started with this env is a machine logged in to agentbook elsewhere (as agentbook-cli login
// leaves it), so that only its CLI runs, on AGENTBOOK_PORT.
export function machineOnly(env: NodeJS.ProcessEnv): boolean {
  if (env.AGENTBOOK_HUB || env.AGENTBOOK_SERVER) return true;
  const home = env.AGENTBOOK_HOME || path.join(os.homedir(), ".agentbook");
  return ["cli/device.json", "hub.json"].some((f) => {
    if (!fs.existsSync(path.join(home, f))) return false;
    const saved = JSON.parse(fs.readFileSync(path.join(home, f), "utf8"));
    return !saved.harness && !(env.AGENTBOOK_HARNESS_ONE === "1" && saved.local);
  });
}

// The ports of an agentbook's two halves, from the slot's pool (harness-ports.ts). One started again on the same data
// folder and address gets the same ones: its CLI logged in to its server by the server's address (cli/device.json).
export type Halves = { server: number | null; cli: number };
const kept = new Map<string, Halves>();
const byPort = new Map<number, Halves>();
export function halves(port: number): Halves {
  const h = byPort.get(port);
  if (!h) throw new Error(`no agentbook started on ${port} in this test`);
  return h;
}

export function spawnAgentbook({ env = process.env, stdio = "ignore" }: { env?: NodeJS.ProcessEnv; stdio?: StdioOptions } = {}, root = REPO): Agentbook {
  const io = Array.isArray(stdio) ? stdio.slice(0, 3) : [stdio, stdio, stdio];
  const port = Number(env.AGENTBOOK_PORT || 4320);
  const key = `${env.AGENTBOOK_HOME}\n${port}`;
  if (!kept.has(key)) kept.set(key, { server: poolPort(), cli: poolPort() });
  const own = kept.get(key);
  byPort.set(port, machineOnly(env) ? { server: null, cli: port } : own);
  // DeepSeek Harness, Antigravity and Grok stay off unless the test brings its own (one on this machine's PATH would be
  // an agent in every test).
  // Claude Desktop's session records (cli/desktop.ts) are the test's own, or none: never this Mac's.
  // No test's machine goes on iroh through the internet: one that links machines over iroh says local (test/mesh.ts).
  // Nor has a door (server/door.ts) unless it says so (test/people.ts).
  const dsh = env.AGENTBOOK_DSH ?? (env.AGENTBOOK_DSH_BIN ? null : "0");
  const agy = env.AGENTBOOK_AGY ?? (env.AGENTBOOK_AGY_BIN ? null : "0");
  const grok = env.AGENTBOOK_GROK ?? (env.AGENTBOOK_GROK_BIN ? null : "0");
  const child = spawn(process.execPath, ["--import", path.join(HERE, "harness-strip.ts"), path.join(HERE, "harness-front.ts"), JSON.stringify({ root, people: TEST_PEOPLE })], { env: { ...env, AGENTBOOK_HARNESS_SERVER_PORT: String(own.server), AGENTBOOK_HARNESS_CLI_PORT: String(own.cli), AGENTBOOK_SECRET_KEY: env.AGENTBOOK_SECRET_KEY ?? SECRET_KEY, AGENTBOOK_DESKTOP_DIRS: env.AGENTBOOK_DESKTOP_DIRS ?? "", AGENTBOOK_IROH: env.AGENTBOOK_IROH ?? "0", AGENTBOOK_DOOR: env.AGENTBOOK_DOOR ?? "0", ...(dsh ? { AGENTBOOK_DSH: dsh } : {}), ...(agy ? { AGENTBOOK_AGY: agy } : {}), ...(grok ? { AGENTBOOK_GROK: grok } : {}) }, stdio: [...io, "ipc"] });
  const kill = child.kill.bind(child);
  // Once harness-front.ts has stopped by itself (a half stopped), its channel is closed: send() would throw the test
  // down asynchronously, as an unhandled "error", instead of letting it say what failed.
  child.kill = (signal = "SIGTERM") => {
    if (child.connected) child.send({ kill: signal });
    else kill(signal);
    return true;
  };
  // restart("agentbook-server" or "agentbook-cli"): that half stops and starts again; it resolves once it answers.
  const restart = (name: Half) =>
    new Promise<void>((resolve) => {
      const heard = (m: unknown) => (m as { restarted?: Half } | null)?.restarted === name && (child.off("message", heard), resolve());
      child.on("message", heard);
      child.send({ restart: name });
    });
  // The channel doesn't keep a test running (the process does, until it exits).
  child.channel?.unref?.();
  return Object.assign(child, { restart });
}
