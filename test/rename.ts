#!/usr/bin/env node
// Renaming the machine: its server knows it by the name it logged in with (its device's), so when its host name or
// AGENTBOOK_MACHINE changes later, it keeps that name, and its workspaces' folders, saved with it, stay on the
// composer's list and keep their threads. Another machine's folders stay where they are. (A data folder from before
// the split moves in under the name it last ran under: test/migrate.ts.)
// Run: node test/rename.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-rename-"));
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", CLAUDE_CONFIG_DIR: path.join(HOME, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => (await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
async function start(machine) {
  const child = spawnAgentbook({ env: { ...env, AGENTBOOK_MACHINE: machine }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return child;
    } catch {}
    await sleep(100);
  }
  throw new Error("agentbook didn't start");
}
async function stop(child) {
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
}
const folders = async () => Object.fromEntries((await stateOf(get)).workspaces.map((w) => [w.name, w.folders.map((f) => `${f.machine}:${path.basename(f.path)}`).sort().join(" ")]));

const dir = (name) => {
  const p = path.join(HOME, "dev", name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const shop = dir("shop");
const site = dir("site");
const theirs = dir("theirs");

let server = await start("oldbox");
try {
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  // A thread that ran on this machine (the hook reports the host it runs on).
  await post("/api/hello", { proc: "oldbox-1", label: "wren", agent: "Claude", session_id: "s-1", cwd: shop, root: shop, host: "oldbox" });
  await post("/api/workspaces", { folder: { path: shop } });
  // A repo checked out here and, at the same path, on another machine.
  await post("/api/workspaces", { repo: "acme/site", folder: { path: site } });
  await post("/api/workspaces", { repo: "acme/site", folder: { path: site, machine: "newbox" } });
  // A folder on a machine none of this one's threads ran on, though its path is here too.
  await post("/api/workspaces", { folder: { path: theirs, machine: "otherbox" } });
  const before = await folders();
  check(JSON.stringify(before) === JSON.stringify({ shop: "oldbox:shop", site: "newbox:site oldbox:site", theirs: "otherbox:theirs" }), "workspaces' folders are saved with their machine's name");
  check((await stateOf(get)).machine === "oldbox", "the machine is known by the name it logged in with");
  await stop(server);

  // Its host renamed: it's still the machine it logged in as, and its folders are still its own.
  server = await start("newbox");
  let st = await stateOf(get);
  check(st.machine === "oldbox" && st.machines.map((m) => m.name).join() === "oldbox", "renamed, it keeps the name it logged in with");
  check(JSON.stringify(await folders()) === JSON.stringify(before), "and its workspaces' folders stay as they were, another machine's too");
  const shopWs = st.workspaces.find((w) => w.name === "shop");
  check(!!shopWs && st.sessions.find((s) => s.id === "s-1")?.machine === "oldbox", "and its threads stay on it, in their workspace");
  await stop(server);

  // Started again under the same name, nothing moves.
  server = await start("newbox");
  const seq = (await stateOf(get)).seq;
  await stop(server);
  server = await start("newbox");
  check((await stateOf(get)).seq === seq, "started again, nothing changes");
} finally {
  await stop(server).catch(() => {});
  await sleep(200);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
