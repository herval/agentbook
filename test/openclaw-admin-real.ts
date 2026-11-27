#!/usr/bin/env node
// Admin for the owner alone (openclaw-admin.ts) on a real OpenClaw gateway: the openclaw installed here, run as a
// throwaway gateway (its own home, config and state in a temp folder, on loopback, never the gateway agentbook is
// paired to), its agent's model a stand-in (fake-openai-model.ts) that records the tools OpenClaw offers it each
// turn. What the stand-in gateway can't show: that `openclaw devices approve` takes the request agentbook shows, that
// the token it rotates to still signs in the connection without admin, that OpenClaw gives its owner-only tools to
// the turns herval sends, that carol, his contact, starts no turn at all, and that /new and /reset keep the thread going.
//
// OpenClaw needs Node 24.16+ (or 26.1+); it skips when there's no openclaw or no such Node, as openclaw-real.ts.
// Run: node test/openclaw-admin-real.ts

import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type ExecFileException, execFile, execFileSync } from "node:child_process";
import { startModel } from "./fake-openai-model.ts";
import { type Agentbook, spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const skip = (why) => {
  console.log(`SKIP  ${why}`);
  process.exit(0);
};
function openclawEntry() {
  if (process.env.AGENTBOOK_TEST_OPENCLAW) return process.env.AGENTBOOK_TEST_OPENCLAW;
  try {
    return fs.realpathSync(execFileSync("/usr/bin/which", ["openclaw"], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}
const ENTRY = openclawEntry();
if (!ENTRY || !fs.existsSync(ENTRY)) skip("no openclaw on this machine (AGENTBOOK_TEST_OPENCLAW: its openclaw.ts)");
const fits = (v) => {
  const [a, b] = String(v).replace(/^v/, "").split(".").map(Number);
  return (a === 24 && b >= 16) || (a === 26 && b >= 1) || a > 26;
};
function openclawNode() {
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  const found = [process.env.AGENTBOOK_TEST_OPENCLAW_NODE, process.execPath, ...(fs.existsSync(nvm) ? fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, "bin", "node")) : [])].filter(Boolean);
  for (const node of found) {
    try {
      if (fits(execFileSync(node, ["-v"], { encoding: "utf8" }).trim())) return node;
    } catch {}
  }
  return null;
}
const NODE = openclawNode();
if (!NODE) skip("OpenClaw needs Node 24.16+ or 26.1+, and there's none here (AGENTBOOK_TEST_OPENCLAW_NODE: one)");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-ocadminreal-"));
const OC_HOME = path.join(HOME, "openclaw-home");
const WORKSPACE = path.join(HOME, "workspace");
fs.mkdirSync(path.join(OC_HOME, ".openclaw"), { recursive: true });
fs.mkdirSync(WORKSPACE);
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
const GW_PORT = await freePort();
const TOKEN = `test-token-${Math.random().toString(36).slice(2)}`;
const PORT = testPort(6450);
const URL = `http://127.0.0.1:${PORT}`;

// openclaw, only ever with the throwaway home: none of this machine's OpenClaw settings or sign-ins.
const ocEnv = { PATH: `${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: OC_HOME, OPENCLAW_HOME: OC_HOME, OPENCLAW_STATE_DIR: path.join(OC_HOME, ".openclaw"), OPENCLAW_CONFIG_PATH: path.join(OC_HOME, ".openclaw", "openclaw.json"), TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8" };
// What an openclaw command did: how it failed, if it did, and what it printed.
interface Ran {
  err: ExecFileException | null;
  stdout: string;
  stderr: string;
}
const oc = (...args: string[]) => new Promise<Ran>((resolve) => execFile(NODE, [ENTRY, ...args], { env: ocEnv, maxBuffer: 32 << 20, timeout: 180e3 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

let failures = 0;
const check = (cond: unknown, label: string, extra = ""): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? `  [${extra}]` : ""}`);
  if (!cond) failures++;
};
const note = (s) => console.log(`      ${s}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T>, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(250);
  }
};
async function req(method: string, p: string, { cookie, body }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const saved = () => JSON.parse(fs.readFileSync(path.join(HOME, "cli", "openclaw.json"), "utf8"));
const ADMIN = "operator.admin";
const MAIN = "agent:main:main";
const T = `/api/sessions/${encodeURIComponent(MAIN)}`;

const model = await startModel();
// The tools OpenClaw offered the model on the first turn that started after `from`.
const toolsAfter = (from) => until(async () => model.requests[from]?.tools && new Set(model.requests[from].tools), 60000);
const gatewayCall = async (method, params) => {
  const r = await oc("gateway", "call", method, "--params", JSON.stringify(params), "--json");
  if (r.err) note(`${method}: ${(r.stderr || r.err.message).trim().split("\n").slice(-2).join(" | ")}`);
  return JSON.parse(r.stdout || "{}");
};

fs.writeFileSync(
  ocEnv.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    gateway: { mode: "local", port: GW_PORT, bind: "loopback", auth: { mode: "token", token: TOKEN } },
    discovery: { mdns: { mode: "off" } },
    agents: { defaults: { model: { primary: "fake/fake" }, workspace: WORKSPACE }, entries: { main: { identity: { name: "testclaw" } } } },
    models: { mode: "merge", providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: "fake", api: "openai-completions", models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } },
  }),
);

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW_BIN: path.join(HOME, "no-openclaw-here"), AGENTBOOK_OPENCLAW_CRON_MS: "2000", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_SERVER", "AGENTBOOK_OPENCLAW", "AGENTBOOK_OPENCLAW_URL", "AGENTBOOK_OPENCLAW_TOKEN", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL"]) delete env[k];

let gateway;
let gatewayLog = "";
let server: Agentbook;
let serverLog = "";
async function startServer() {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false), 15000);
}
try {
  gateway = spawnTied(NODE, [ENTRY, "gateway", "run", "--port", String(GW_PORT)], { env: ocEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  gateway.stdout.on("data", (d) => (gatewayLog += d));
  gateway.stderr.on("data", (d) => (gatewayLog += d));
  const up = await until(() => new Promise((resolve) => net.connect(GW_PORT, "127.0.0.1").on("connect", function () { this.destroy(); resolve(true); }).on("error", () => resolve(false))), 60000);
  check(up, `the gateway runs (OpenClaw ${(await oc("--version")).stdout.trim().split("\n")[0]}, Node ${execFileSync(NODE, ["-v"], { encoding: "utf8" }).trim()})`);
  // Its main session, there before agentbook connects.
  await oc("agent", "--agent", "main", "--session-key", MAIN, "-m", "hello", "--json", "--timeout", "120");

  // ---------- paired with a setup code, without admin ----------
  await startServer();
  const herval = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const carol = as((await req("POST", "/api/auth/test-person", { body: { username: "carol" } })).cookie);
  const qr = await oc("qr", "--setup-code-only", "--no-ascii", "--url", `ws://127.0.0.1:${GW_PORT}`);
  const code = qr.stdout.trim().split("\n").at(-1);
  if (qr.stderr.trim()) note(`openclaw qr: ${qr.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  const set = await herval.post("/api/openclaw", { setup_code: code });
  check(set.status === 200 && set.auth === "setup-code", "agentbook takes the gateway's setup code", JSON.stringify(set));
  const pairing = await until(async () => {
    const o = await herval.get("/api/openclaw");
    return (o.state === "pairing" || o.state === "connected") && o;
  }, 20000);
  if (pairing?.state === "pairing") note(`approving the pairing: ${(await oc("devices", "approve", pairing.requestId)).stdout.trim().split("\n").at(-1)}`);
  else note("paired with no approval (the setup code's bootstrap token)");
  const on = await until(async () => {
    const o = await herval.get("/api/openclaw");
    return o.state === "connected" && o;
  }, 30000);
  check(on?.auth === "device" && on.admin?.state === "off", "connected as a device, without admin", JSON.stringify(on));
  check(!saved().device.scopes.includes(ADMIN), "its device token has the scopes agentbook asked for, and not admin", JSON.stringify(saved().device.scopes));
  await until(async () => (await herval.get(T)).status === 200, 20000);
  await carol.post("/api/people/herval/contact", { act: "ask" });
  check(!!(await herval.post("/api/people/carol/contact", { act: "yes" })).contact?.contact, "carol is herval's contact, which lets her steer nothing of his");

  let mark = model.requests.length;
  await herval.post(`${T}/messages`, { text: "SAY before" });
  const plain = await toolsAfter(mark);
  check(plain?.size > 0, `without admin, herval's turn gets ${plain?.size} tools`);

  // ---------- admin, asked for and approved on the gateway ----------
  const oldToken = saved().device.deviceToken;
  const asked = await herval.post("/api/openclaw", { admin: true });
  check(asked.admin?.state === "asked" && !!asked.admin.requestId, "Give agentbook admin asks the gateway for it", JSON.stringify(asked.admin || asked));
  const listed = await oc("devices", "list", "--json");
  check(listed.stdout.includes(asked.admin?.requestId || "-"), "openclaw devices list shows agentbook's request", listed.stdout.slice(0, 400));
  const approved = await oc("devices", "approve", asked.admin?.requestId || "-");
  check(!approved.err, "openclaw devices approve <the id agentbook shows> approves it", (approved.stderr || approved.stdout).trim().split("\n").slice(-2).join(" | "));
  const adminOn = await until(async () => {
    const o = await herval.get("/api/openclaw");
    return o.admin?.state === "on" && o;
  }, 30000);
  check(!!adminOn, "agentbook's admin connection is on", JSON.stringify((await herval.get("/api/openclaw")).admin));
  check(saved().device.deviceToken !== oldToken && saved().device.scopes.includes(ADMIN), "with the rotated token, which has admin");
  check(adminOn?.state === "connected", "and the everyday connection signed in with it too");

  // ---------- whose turn gets the owner's tools ----------
  mark = model.requests.length;
  await herval.post(`${T}/messages`, { text: "SAY mine" });
  const owners = await toolsAfter(mark);
  const ownerOnly = [...(owners || [])].filter((t) => !plain.has(t));
  check(ownerOnly.length > 0, `herval's turn now gets OpenClaw's owner-only tools: ${ownerOnly.join(", ")}`);
  await sleep(3000);
  mark = model.requests.length;
  const cm = await carol.post(`${T}/messages`, { text: "SAY hers" });
  await sleep(3000);
  check([403, 404].includes(cm.status) && model.requests.length === mark, "carol can't write to it: no turn of hers reaches OpenClaw", `${cm.status} ${cm.error || ""}`);

  await sleep(3000);
  mark = model.requests.length;
  const mine = await herval.post("/api/launch", { prompt: "SAY started", agent: "openclaw-main" });
  const startedTools = await toolsAfter(mark);
  check(mine.status === 200 && startedTools && ownerOnly.every((t) => startedTools.has(t)), "a thread herval starts gets them", `${mine.status} ${mine.error || ""}`);
  await sleep(3000);
  mark = model.requests.length;
  const theirs = await carol.post("/api/launch", { prompt: "SAY carols", agent: "openclaw-main" });
  await sleep(3000);
  check([403, 404].includes(theirs.status) && model.requests.length === mark, "nor start a thread with it", `${theirs.status} ${theirs.error || ""}`);

  // ---------- Run now and Pause ----------
  const job = (await gatewayCall("cron.add", { agentId: "main", name: "Daily digest", schedule: { kind: "every", everyMs: 86400e3 }, wakeMode: "now", delivery: { mode: "none" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "SAY digest" } })).id;
  await until(async () => ((await herval.get("/api/agents/openclaw-main/routines")).routines || []).some((r) => r.id === job), 20000);
  const run = await herval.post(`/api/agents/openclaw-main/routines/${job}`, { action: "run" });
  check(run.status === 200, "Run now works", `${run.status} ${run.error || ""}`);
  const pause = await herval.post(`/api/agents/openclaw-main/routines/${job}`, { action: "pause" });
  const jobs = (await gatewayCall("cron.list", { includeDisabled: true })).jobs || [];
  check(pause.status === 200 && jobs.find((j) => j.id === job)?.enabled === false, "Pause too", `${pause.status} ${pause.error || ""}`);

  // ---------- /new and /reset ----------
  const cmds = await herval.get(`${T}/commands`);
  check((cmds.list || []).some((c) => c.name === "new") && (cmds.list || []).some((c) => c.name === "reset"), "/new and /reset are on its commands");
  // OpenClaw 2026.9.4 starts over in the same session (a "reset" entry in its transcript, the same id and key), so
  // the thread goes on, with what it said back.
  const said = (text) => until(async () => (await herval.get(T)).messages?.some((m) => m.from === "agent" && m.text.includes(text)), 40000);
  const sentNew = await herval.post(`${T}/messages`, { text: "/new", command: "new" });
  check(sentNew.status === 200 && !!(await said("New session started")), "herval's /new starts its agent over, and the thread shows what it said", `${sentNew.status} ${sentNew.error || ""}`);
  await herval.post(`${T}/messages`, { text: "SAY after-new" });
  check(!!(await said("after-new")), "and the thread goes on: the next message is answered on it");
  const sentReset = await herval.post(`${T}/messages`, { text: "/reset", command: "reset" });
  check(sentReset.status === 200 && !!(await said("Session reset")), "/reset too", `${sentReset.status} ${sentReset.error || ""}`);
  check([403, 404].includes((await carol.post(`${T}/messages`, { text: "/new" })).status), "carol can't send either");

  // ---------- restarted ----------
  server.kill();
  await new Promise((r) => server.once("exit", r));
  const token = saved().device.deviceToken;
  await startServer();
  check(!!(await until(async () => (await herval.get("/api/openclaw")).admin?.state === "on", 30000)), "restarted, both connect again");
  check(saved().device.deviceToken === token, "with the same token");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
  if (gateway?.pid) {
    try {
      process.kill(-gateway.pid, "SIGTERM");
    } catch {}
    await until(async () => !(await new Promise((resolve) => net.connect(GW_PORT, "127.0.0.1").on("connect", function () { this.destroy(); resolve(true); }).on("error", () => resolve(false)))), 10000);
    try {
      process.kill(-gateway.pid, "SIGKILL");
    } catch {}
  }
  model.close();
  if (failures && process.env.ADMIN_LOGS) console.log(`--- agentbook ---\n${serverLog.slice(-6000)}\n--- gateway ---\n${gatewayLog.slice(-6000)}`);
  if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed (kept ${HOME})` : "\nall passed");
process.exit(failures ? 1 : 0);
