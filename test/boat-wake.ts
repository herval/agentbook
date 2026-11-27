#!/usr/bin/env node
// Waking a machine that runs in a boat sandbox (server/cloud.ts): its owner
// connects their boat account and says which sandbox the machine runs in. Then what's sent to it while it's off
// wakes its sandbox, the page says Waking, the machine takes what waited once it's back, and when boat says no the
// page says why. Against a stand-in boat (test/fake-boat.ts): the machine's agentbook-cli here is "its sandbox",
// started again when boat is asked to resume it.
// Run: node test/boat-wake.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoat } from "./fake-boat.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-boat-"));
const HUB_PORT = testPort(6900);
const BOX_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const BOX = `http://127.0.0.1:${BOX_PORT}`;
const SANDBOX = "bx_23456789";
const project = path.join(BASE, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
spawnSync("git", ["-C", project, "init", "-q", "-b", "main"]);

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

// boat, with one stopped sandbox. A resume "starts the sandbox": the machine's agentbook-cli, unless `stuck`.
let box = { kill() {} };
let stuck = false;
const boat = await startBoat({ sandboxes: [{ id: SANDBOX, name: "shop", state: "archived" }, { id: "bx_abcdefgh", name: "other", state: "ready" }], onResume: () => !stuck && (box = serve(boxEnv)) });

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL"]) delete common[k];
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_BOAT_API_URL: boat.url, AGENTBOOK_CLOUD_CONNECT_MS: "2500", AGENTBOOK_CLOUD_AGAIN_MS: "60000" };
const boxEnv = { ...common, AGENTBOOK_PORT: String(BOX_PORT), AGENTBOOK_HOME: path.join(BASE, "box"), AGENTBOOK_MACHINE: "boat-shop", AGENTBOOK_URL: BOX, AGENTBOOK_HUB: HUB };
fs.mkdirSync(path.join(BASE, "box", "cli"), { recursive: true });
fs.writeFileSync(path.join(BASE, "box", "cli", "gate.json"), JSON.stringify({ folders: [BASE] }));

let COOKIE = "";
const raw = (base: string, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(base === HUB && COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (base: string, p: string) => {
  const r = await raw(base, p);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (base: string, p: string, body: unknown = {}) => {
  const r = await raw(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
function serve(env: NodeJS.ProcessEnv) {
  return spawnAgentbook({ env, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
}
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 8000);
const hook = (event: string, input: object, env?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...boxEnv, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", ...env } });
const machine = async () => (await stateOf((p) => get(HUB, p))).machines?.find((m) => m.name === "boat-shop");
const resumes = () => boat.calls.filter((c) => c.method === "POST" && c.path === `/sandboxes/${SANDBOX}/resume`).length;
// The sandbox stops: its agentbook-cli goes with it, and boat says it's stopped ("archived").
const kill = (p) => {
  if (p.connected === false || p.gone) return;
  p.gone = true;
  p.kill();
};
const off = async () => {
  kill(box);
  boat.sandboxes.get(SANDBOX).state = "archived";
  return until(async () => (await machine())?.online === false, 15000);
};

const hub = serve(hubEnv);
try {
  check(await healthy(HUB), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  const asked = await post(HUB, "/api/devices/start", { name: "boat-shop" });
  await post(HUB, "/api/devices/approve", { code: asked.code });
  Object.assign(boxEnv, { AGENTBOOK_HUB_TOKEN: (await get(HUB, `/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).token });
  box = serve(boxEnv);
  check((await healthy(BOX)) && (await until(async () => (await machine())?.online, 10000)), "a machine in a sandbox logs in to it");
  const T = path.join(BASE, "t.jsonl");
  fs.writeFileSync(T, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "stock the shelves" } }) + "\n");
  const env = { AGENTBOOK_PID: "940001", AGENTBOOK_LABEL: "kite" };
  hook("SessionStart", { session_id: "boat-1", cwd: project, source: "startup", transcript_path: T }, env);
  hook("UserPromptSubmit", { session_id: "boat-1", prompt: "stock the shelves", cwd: project, transcript_path: T }, env);
  hook("Stop", { session_id: "boat-1", last_assistant_message: "Stocked." }, env);
  check(await until(async () => (await get(HUB, "/api/sessions/boat-1")).status === 200, 10000), "with a thread on it");

  // ---------- connecting boat ----------
  const kinds = (await get(HUB, "/api/connectors")).kinds || [];
  check(kinds.some((k) => k.kind === "boat" && k.machines && !k.tasks && !k.data), "boat is a connector kind: it wakes machines, and fills no Tasks");
  const bad = await post(HUB, "/api/connectors", { kind: "boat", api_key: "boat_wrong" });
  check(bad.status === 400 && /doesn't take this API key/.test(bad.error || ""), `a key boat doesn't know is turned down (${bad.error})`);
  const conn = await post(HUB, "/api/connectors", { kind: "boat", api_key: boat.key });
  check(conn.status === 200 && conn.connector?.id === "boat" && conn.connector.who === "herval" && !JSON.stringify(conn).includes(boat.key), `yours connects, as your boat account (${conn.connector?.who}), and its key never comes back`);

  // ---------- saying which sandbox the machine runs in ----------
  const page = await get(HUB, "/api/machines/boat-shop");
  check(page.cloud === null && page.boat?.[0]?.id === "boat", "the machine's page has your boat connector to link it with");
  const list = await get(HUB, "/api/machines/boat-shop/cloud/sandboxes?connector=boat");
  check(list.sandboxes?.find((s) => s.id === SANDBOX)?.state === "stopped" && list.sandboxes?.find((s) => s.id === "bx_abcdefgh")?.state === "on", "and your sandboxes to pick from, stopped ones too");
  const nope = await post(HUB, "/api/machines/boat-shop/cloud", { connector: "boat", sandbox: "bx_zzzzzzzz" });
  check(nope.status === 400 && /no such sandbox/.test(nope.error || ""), "a sandbox boat doesn't have isn't linked");
  const linked = await post(HUB, "/api/machines/boat-shop/cloud", { connector: "boat", sandbox: SANDBOX });
  check(linked.status === 200 && linked.cloud?.sandbox === SANDBOX && (await machine())?.cloud?.sandbox === SANDBOX, "the one it runs in is");
  check(resumes() === 0, "nothing is woken while it's on");

  // ---------- off, and something is sent to it ----------
  check(await off(), "its sandbox stops: the server sees the machine go off");
  const msg = await post(HUB, "/api/sessions/boat-1/messages", { text: "and the back room" });
  check(msg.queued && msg.waiting === "boat-shop", "a message to its thread waits for it");
  check(await until(() => resumes() === 1, 4000), "and the server asks boat to resume its sandbox, with your key");
  const waking = await until(async () => {
    const m = await machine();
    return m?.cloud?.waking || m?.online ? m : null;
  }, 3000);
  check(waking?.cloud?.waking || waking?.online, "the page says it's waking");
  check(await until(async () => (await machine())?.online, 15000), "the machine comes back");
  check(await until(async () => !((await get(HUB, "/api/sessions/boat-1")).waiting || []).length, 10000), "and takes what waited for it");
  const awake = await machine();
  check(awake.cloud && !awake.cloud.waking && !awake.cloud.error, "nothing says waking any more");
  check(resumes() === 1, "boat was asked once");

  // ---------- boat says no ----------
  check(await off(), "off again");
  boat.set({ refuse: { status: 402, code: "billing_required", message: "Billing required" } });
  await post(HUB, "/api/sessions/boat-1/messages", { text: "and the till" });
  const refused = await until(async () => (await machine())?.cloud?.error, 5000);
  check(/wallet is empty/.test(refused || ""), `when boat won't start it, the page says why (${refused})`);
  const n = resumes();
  await post(HUB, "/api/sessions/boat-1/messages", { text: "and the sign" });
  await sleep(600);
  check(resumes() === n, "and a second message a moment later doesn't ask boat again");
  check((await get(HUB, "/api/machines/boat-shop")).cloud?.error === refused, "its page says so too");

  // ---------- its owner wakes it, and its agentbook-cli never connects ----------
  boat.set({ refuse: null });
  stuck = true;
  const byHand = await post(HUB, "/api/machines/boat-shop/wake");
  check(byHand.status === 200 && byHand.waking && resumes() === n + 1, "Wake it now asks boat again");
  const never = await until(async () => (await machine())?.cloud?.error, 6000);
  check(/boat started its sandbox, but its agentbook-cli didn't connect/.test(never || ""), `a sandbox that starts with no agentbook-cli coming back says so (${never})`);

  // ---------- boat is out of machines for a moment: asked again by itself ----------
  stuck = false;
  boat.sandboxes.get(SANDBOX).state = "archived";
  boat.set({ refuse: { status: 503, code: "out_of_capacity", message: "Out of capacity", retryAfter: 5 } });
  const before = resumes();
  await post(HUB, "/api/machines/boat-shop/wake");
  const later = await machine();
  check(later?.cloud?.waking && /out of machines/.test(later.cloud.error || ""), "boat out of machines: still waking, saying why not yet");
  boat.set({ refuse: null });
  check(await until(() => resumes() >= before + 2, 9000), "and it asks again by itself after boat's wait");
  check(await until(async () => (await machine())?.online, 15000), "then the machine is back");

  // ---------- a key that can't resume ----------
  check(await off(), "off once more");
  boat.set({ scopes: ["sandbox.read", "account.read"] });
  const scoped = await post(HUB, "/api/machines/boat-shop/wake");
  check(scoped.status === 409 && /sandbox\.resume/.test(scoped.error || ""), `a key that can't resume says which scope it needs (${scoped.error})`);
  boat.set({ scopes: null });

  // ---------- unlinked ----------
  const un = await post(HUB, "/api/machines/boat-shop/cloud", {});
  const m2 = resumes();
  await post(HUB, "/api/sessions/boat-1/messages", { text: "and the lights" });
  await sleep(600);
  check(un.status === 200 && un.cloud === null && resumes() === m2 && !(await machine())?.cloud, "unlinked, nothing wakes it: what's sent waits, as for any machine that's off");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  kill(hub);
  kill(box);
  await boat.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
