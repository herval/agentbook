#!/usr/bin/env node
// agentbook's plugin for OpenClaw (plugin/openclaw/) on a real OpenClaw gateway: the openclaw installed on this
// machine, run as a throwaway gateway (its own home, config and state in a temp folder, on loopback, never the
// gateway agentbook is paired to), its agent's model a stand-in (fake-openai-model.ts) that calls the tools the
// message names. The plugin is installed as the Add agents page says to, a test agentbook connects to the gateway,
// and `openclaw agent` runs turns. What the stand-in gateway (fake-openclaw-gateway.ts) can't show: how OpenClaw
// really loads a plugin (2026.9.4 loads it three times, and takes its tools and its hook from different loads).
//
// OpenClaw needs Node 24.16+ (or 26.1+); agentbook runs on the Node running this. It skips when there's no openclaw
// or no such Node: AGENTBOOK_TEST_OPENCLAW (openclaw.ts) and AGENTBOOK_TEST_OPENCLAW_NODE (a node) say where.
// Run: node test/openclaw-real.ts

import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type ExecFileException, execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startModel } from "./fake-openai-model.ts";
import { type Agentbook, spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, "..", "plugin", "openclaw");
const skip = (why) => {
  console.log(`SKIP  ${why}`);
  process.exit(0);
};

// ---------- the openclaw here, and a Node it runs on ----------
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
  const given = process.env.AGENTBOOK_TEST_OPENCLAW_NODE;
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  const found = [given, process.execPath, ...(fs.existsSync(nvm) ? fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, "bin", "node")) : [])].filter(Boolean);
  for (const node of found) {
    try {
      if (fits(execFileSync(node, ["-v"], { encoding: "utf8" }).trim())) return node;
    } catch {}
  }
  return null;
}
const NODE = openclawNode();
if (!NODE) skip("OpenClaw needs Node 24.16+ or 26.1+, and there's none here (AGENTBOOK_TEST_OPENCLAW_NODE: one)");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-ocreal-"));
const OC_HOME = path.join(HOME, "openclaw-home");
const WORKSPACE = path.join(HOME, "workspace");
fs.mkdirSync(path.join(OC_HOME, ".openclaw"), { recursive: true });
fs.mkdirSync(WORKSPACE);
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolve(port));
  });
});
const GW_PORT = await freePort();
const TOKEN = `test-token-${Math.random().toString(36).slice(2)}`;
const PORT = testPort(6400);
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T>, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(250);
  }
};
let COOKIE = "";
const req = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}): Promise<Json> => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const enc = encodeURIComponent;

const model = await startModel();
// One turn on a session, run by the gateway: the message names the tools to call. The model's requests it made.
async function turn(key, message) {
  const before = model.requests.length;
  const r = await oc("agent", "--agent", "main", "--session-key", key, "-m", message, "--json", "--timeout", "120");
  if (r.err) console.log(`      openclaw agent: ${(r.stderr || r.err.message).trim().split("\n").slice(-3).join(" | ")}`);
  return model.requests.slice(before);
}
const lastResult = (reqs) => reqs.flatMap((r) => r.toolResults).at(-1) || "";

fs.writeFileSync(
  ocEnv.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    gateway: { mode: "local", port: GW_PORT, bind: "loopback", auth: { mode: "token", token: TOKEN } },
    discovery: { mdns: { mode: "off" } },
    agents: { defaults: { model: { primary: "fake/fake" }, workspace: WORKSPACE }, entries: { main: { identity: { name: "testclaw" } } } },
    models: { mode: "merge", providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: "fake", api: "openai-completions", models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } },
  }),
);

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW_BIN: path.join(HOME, "no-openclaw-here"), AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_SERVER", "AGENTBOOK_OPENCLAW", "AGENTBOOK_OPENCLAW_URL", "AGENTBOOK_OPENCLAW_TOKEN", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL"]) delete env[k];

let gateway;
let gatewayLog = "";
let server: Agentbook;
let serverLog = "";
const MAIN = "agent:main:main";
try {
  // ---------- install, as the Add agents page says ----------
  const copy = path.join(HOME, "agentbook-openclaw");
  fs.cpSync(PLUGIN, copy, { recursive: true });
  const installed = await oc("plugins", "install", copy, "--force", "--accept-capabilities");
  check(/Installed plugin: agentbook/.test(installed.stdout + installed.stderr), "openclaw plugins install takes agentbook's plugin", (installed.stdout + installed.stderr).trim().split("\n").slice(-3).join(" | "));
  await oc("config", "set", "plugins.entries.agentbook.hooks.allowConversationAccess", "true");

  // In a process group of its own: OpenClaw runs the gateway in a child process (openclaw-gateway), stopped with it.
  gateway = spawnTied(NODE, [ENTRY, "gateway", "run", "--port", String(GW_PORT)], { env: ocEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  gateway.stdout.on("data", (d) => (gatewayLog += d));
  gateway.stderr.on("data", (d) => (gatewayLog += d));
  const up = await until(() => new Promise((resolve) => net.connect(GW_PORT, "127.0.0.1").on("connect", function () { this.destroy(); resolve(true); }).on("error", () => resolve(false))), 60000);
  check(up, `the gateway runs (OpenClaw ${(await oc("--version")).stdout.trim().split("\n")[0]}, Node ${execFileSync(NODE, ["-v"], { encoding: "utf8" }).trim()})`);

  const before = await turn(MAIN, "hello");
  check(before.length > 0 && before[0].abTools.length === 0, "before agentbook connects, its agent's model has none of agentbook's tools", `${before[0]?.abTools?.length} of ${before[0]?.tools?.length}`);

  // ---------- agentbook, connected ----------
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false), 15000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  await post("/api/openclaw", { url: `ws://127.0.0.1:${GW_PORT}`, token: TOKEN });
  const pairing = await until(async () => {
    const o = await get("/api/openclaw");
    return (o.state === "pairing" || o.state === "connected") && o;
  }, 20000);
  if (pairing?.state === "pairing" && pairing.requestId) await oc("devices", "approve", pairing.requestId);
  const conn = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "connected" && o.tools && o;
  }, 30000);
  check(conn?.tools?.installed === true && conn.tools.missing.length === 0, "agentbook connects and finds its plugin there, with every tool it has", JSON.stringify(conn?.tools || conn));

  // ---------- turns that use the tools ----------
  const t1 = await turn(MAIN, `Set up your thread.\nCALL ab_post {"title":"Plan the Lisbon trip","text":"On a real gateway."}\nCALL ab_update {"text":"Found three hotels near Alfama"}`);
  const offered = t1[0]?.abTools || [];
  check(offered.length === JSON.parse(fs.readFileSync(path.join(PLUGIN, "openclaw.plugin.json"), "utf8")).contracts.tools.length && offered.find((t) => t.name === "ab_ask")?.parameters?.properties?.question, "then its model is offered agentbook's tools, with their parameters", `${offered.length}: ${offered.map((t) => t.name).join(",")}`);
  check(/thread on agentbook/.test(t1[0]?.system || ""), "and its system prompt says it's a thread on agentbook");
  const s1 = await until(async () => {
    const s = (await state()).sessions.find((x) => x.id === MAIN);
    return s?.title === "Plan the Lisbon trip" && s.updates?.some((u) => u.text === "Found three hotels near Alfama") && s;
  }, 15000);
  check(!!s1, "ab_post and ab_update, called by the model, land on the session's thread", lastResult(t1));

  const t2 = await turn(MAIN, `CALL ab_ask {"question":"Which hotel?","options":["Alfama|cheaper","Chiado|closer"],"wait_seconds":0}`);
  const q = await until(async () => (await state()).questions.find((x) => x.post === MAIN && x.title === "Which hotel?"), 15000);
  check(q?.options?.length === 2 && /Asked \(question .+ don't build what it decides/.test(lastResult(t2)), "ab_ask puts a question on it", lastResult(t2));

  // More than one piece, each under what Node 22's WebSocket takes from a gateway that compresses (4 MB).
  const BYTES = Buffer.concat([Buffer.from("# Itinerary\n"), Buffer.alloc(5 << 20, 98)]);
  fs.writeFileSync(path.join(WORKSPACE, "itinerary.md"), BYTES);
  const t3 = await turn(MAIN, `CALL ab_file {"path":"itinerary.md","title":"The itinerary"}`);
  const f = await until(async () => (await state()).sessions.find((x) => x.id === MAIN)?.last_files?.find((x) => x.name === "itinerary.md"), 20000);
  const got = f && Buffer.from(await (await req(f.url || `/api/files/${f.id}`)).arrayBuffer());
  check(!!got?.equals(BYTES) && (await get("/api/openclaw")).state === "connected", "ab_file shares a 5 MB file from the agent's workspace, and agentbook stays connected", lastResult(t3));

  const NEW = `agent:main:explicit:fresh-${Date.now().toString(36)}`;
  const t4 = await turn(NEW, `CALL ab_post {"title":"A fresh session"}`);
  const s4 = await until(async () => (await state()).sessions.find((x) => x.id === NEW && x.title === "A fresh session"), 10000);
  check(!!s4, "a session agentbook hadn't listed yet is a thread from its first call", lastResult(t4));

  const t5 = await turn("agent:main:cron:nightly", "hello");
  check(t5[0] && t5[0].abTools.length === 0 && !/thread on agentbook/.test(t5[0].system), "a cron run gets none of the tools, and isn't told about agentbook");

  // ---------- what a cron job does ----------
  const gatewayCall = async (method, params) => {
    const r = await oc("gateway", "call", method, "--params", JSON.stringify(params), "--json");
    if (r.err) console.log(`      ${method}: ${(r.stderr || r.err.message).trim().split("\n").slice(-2).join(" | ")}`);
    return JSON.parse(r.stdout || "{}");
  };
  const addJob = async (job) => (await gatewayCall("cron.add", { agentId: "main", schedule: { kind: "every", everyMs: 86400e3 }, wakeMode: "now", delivery: { mode: "none" }, ...job })).id;
  const NAMED = "agent:main:weekly-review";
  const named = await addJob({ name: "Weekly review", sessionTarget: "session:weekly-review", payload: { kind: "agentTurn", message: "Build on last week" } });
  await gatewayCall("cron.run", { id: named, mode: "force" });
  const namedTalk = await until(async () => {
    const m = (await get(`/api/sessions/${enc(NAMED)}`)).messages || [];
    return m.some((x) => x.from === "agent") && m;
  }, 30000);
  check(namedTalk?.[0]?.routine?.id === named && namedTalk[0].text === "Build on last week", "a cron job's prompt in a session it names is from its routine, in its own words", JSON.stringify(namedTalk?.[0]));
  check((await state()).sessions.find((x) => x.id === NAMED)?.title === "Weekly review", "and its thread takes the job's name");

  // A job with a session of its own: one thread, whichever run it's on.
  const job = await addJob({ name: "Daily digest", sessionTarget: "isolated", payload: { kind: "agentTurn", message: "SAY Reported" } });
  const JOB = `agent:main:cron:${job}`;
  const jobTalk = async (n) =>
    until(async () => {
      const m = (await get(`/api/sessions/${enc(JOB)}`)).messages || [];
      return m.filter((x) => x.from === "agent").length >= n && m;
    }, 40000);
  await gatewayCall("cron.run", { id: job, mode: "force" });
  const run1 = await jobTalk(1);
  check(run1?.[0]?.routine?.id === job && run1[0].text === "SAY Reported" && run1[1]?.text === "Reported", "a cron job is a thread, with what it told its agent and what came back", JSON.stringify(run1));
  const jobRow = (await state()).sessions.find((x) => x.id === JOB);
  check(jobRow?.title === "Daily digest" && !!jobRow.moved && /doesn't take messages/.test(jobRow.rt?.blocked || ""), "named after it, and with no box to write in", JSON.stringify(jobRow?.rt));
  await sleep(1000);
  await gatewayCall("cron.run", { id: job, mode: "force" });
  const run2 = await jobTalk(2);
  check(run2?.map((m) => `${m.from}:${m.text}`).join("|") === "human:SAY Reported|agent:Reported|human:SAY Reported|agent:Reported", "its next run takes over the session, and adds to the thread", JSON.stringify(run2));
  check((await state()).sessions.find((x) => x.id === JOB)?.moved > jobRow.moved, "and moves it up the feed");
  await post(`/api/sessions/${enc(JOB)}/flag`, { archived: true });
  await sleep(1000);
  await gatewayCall("cron.run", { id: job, mode: "force" });
  const run3 = await jobTalk(3);
  check(run3?.length === 6 && (await get(`/api/sessions/${enc(JOB)}`)).archived, "archived, it stays archived through a run that reports", JSON.stringify(run3?.length));
  const silent = await addJob({ name: "Quiet job", sessionTarget: "isolated", payload: { kind: "agentTurn", message: "SAY NO_REPLY" } });
  await gatewayCall("cron.run", { id: silent, mode: "force" });
  await sleep(12000);
  check(!(await state()).sessions.some((x) => x.id === `agent:main:cron:${silent}`), "a job with nothing to report has no thread");

  // A job for the main session tells its agent something that isn't in the session's history: only the reply is.
  const said = (await get(`/api/sessions/${enc(MAIN)}`)).messages.length;
  const event = await addJob({ name: "Calendar check", sessionTarget: "main", payload: { kind: "systemEvent", text: "Look at the calendar" } });
  await gatewayCall("cron.run", { id: event, mode: "force" });
  const after = await until(async () => {
    const m = (await get(`/api/sessions/${enc(MAIN)}`)).messages;
    return m.length > said && m.slice(said);
  }, 30000);
  check(after?.length && after.every((m) => m.from === "agent"), "a job for the main session shows as its agent's reply in that thread, with nothing from you", JSON.stringify(after));

  // ---------- disconnected ----------
  await post("/api/openclaw", { disconnect: true });
  await sleep(1500);
  const t6 = await turn(MAIN, "hello again");
  check(t6[0] && t6[0].abTools.length === 0 && !/thread on agentbook/.test(t6[0].system), "once agentbook disconnects, the model has none of its tools, and isn't told about it");
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
}
if (failures) console.log(`\ngateway log (tail):\n${gatewayLog.replace(/\x1b\[[0-9;]*m/g, "").slice(-3000)}\n\nagentbook log (tail):\n${serverLog.slice(-2000)}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
