#!/usr/bin/env node
// OpenClaw's agents using agentbook's tools: agentbook's plugin for OpenClaw (plugin/openclaw/), loaded by a stand-in
// gateway (fake-openclaw-gateway.ts), hands each call an agent makes to agentbook over agentbook's connection to the
// gateway, and agentbook answers it as the session's post. The test plays the agent: it lists a session's tools,
// calls them, and reads what its prompt gets. Run: node test/openclaw-tools.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "./fake-openclaw-gateway.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, "..", "plugin", "openclaw");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-octools-"));
const PORT = testPort(6200);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "gateway");
// The agent's workspace, on the gateway's machine (here, a folder agentbook was never told about).
const WORKSPACE = path.join(HOME, "brick", "workspace");
fs.mkdirSync(FAKE);
fs.mkdirSync(WORKSPACE, { recursive: true });
const TOKEN = "the-gateway-token-1234";
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW_BIN: path.join(HOME, "no-openclaw-here"), AGENTBOOK_OPENCLAW_SYNC_MS: "60000", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OPENCLAW", "AGENTBOOK_OPENCLAW_URL", "AGENTBOOK_OPENCLAW_TOKEN", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID"]) delete env[k];

const now = Date.now();
const MAIN = "agent:main:main";
fs.writeFileSync(
  path.join(FAKE, "state.json"),
  JSON.stringify({
    agents: [{ id: "main", identity: { name: "jefepato" }, workspace: WORKSPACE }],
    sessions: [{ key: MAIN, sessionId: "s1", agentId: "main", derivedTitle: "Trip planning", createdAt: now - 3600e3, updatedAt: now - 60e3, messages: [{ role: "user", content: "Plan the Lisbon trip", timestamp: now - 3600e3 }, { role: "assistant", content: [{ type: "text", text: "Here's a plan." }], timestamp: now - 3500e3 }] }],
    approvals: [],
    questions: [],
  }),
);

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}): Promise<Json> => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const textOf = (r) => (r?.content || []).map((c) => c.text).join("\n");
const failed = (p) => p.then(() => null, (e) => e.message);

const gw = await startGateway({ dir: FAKE, token: TOKEN, tickMs: 500 });
await gw.install(PLUGIN);
let server: Agentbook;
let serverLog = "";
try {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false), 5000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  check(gw.tools(MAIN).length === 0, "before agentbook connects, the gateway's agents have none of its tools");

  // ---------- connected ----------
  await post("/api/openclaw", { url: gw.url, token: TOKEN });
  const requestId = await until(() => gw.requests()[0]);
  gw.approve(requestId);
  const conn = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "connected" && o.tools && o;
  }, 9000);
  check(conn?.tools?.installed === true && conn.tools.missing.length === 0 && conn.plugin === PLUGIN.replace(os.homedir(), "~"), "agentbook finds its plugin on the gateway, with every tool it has for agents named in the plugin's manifest");
  await until(async () => (await state()).sessions.some((x) => x.id === MAIN));
  const names = gw.tools(MAIN, { workspaceDir: WORKSPACE }).map((t) => t.name);
  const offered = gw.tools(MAIN).find((t) => t.name === "ab_ask");
  check(names.includes("ab_post") && names.includes("ab_page_write") && names.includes("ab_inbox") && /Ask the person/.test(offered?.description) && offered.parameters?.properties?.question, "then a session's agent has them, as agentbook describes them, every one (an inbox too, for what you sent mid-turn)");
  check(gw.tools("agent:main:cron:nightly").length === 0 && gw.tools("agent:main:subagent:abc").length === 0, "cron runs and subagents don't");
  const told = await gw.prompt(MAIN);
  check(/thread on agentbook/.test(told?.appendSystemContext || "") && !(await gw.prompt("agent:main:cron:nightly")), "and each session's agent is told it's a thread on agentbook");

  // ---------- calling them ----------
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(WORKSPACE, "face.png"), PNG);
  const originalProfile = JSON.parse(textOf(await gw.run(MAIN, "ab_profile", {})).split("\n").slice(1).join("\n"));
  const changedProfile = await gw.run(MAIN, "ab_profile", { path: "face.png", bio: "I plan your trips." }, { workspaceDir: WORKSPACE });
  const agent = (await get("/api/agents/openclaw-main")).agent;
  const face = await req(`/api/agents/openclaw-main/avatar?v=${agent.avatar?.image}`);
  check(names.includes("ab_profile") && /Profile updated/.test(textOf(changedProfile)) && agent.bio === "I plan your trips." && face.ok && Buffer.from(await face.arrayBuffer()).equals(PNG), "ab_profile reads an OpenClaw picture on its gateway's machine and updates its bio and avatar");
  await gw.run(MAIN, "ab_profile", { reset_picture: true });
  const resetProfile = (await get("/api/agents/openclaw-main")).agent;
  check(resetProfile.avatar === null && JSON.stringify(resetProfile.avatar_default || null) === JSON.stringify(originalProfile.avatar_default) && resetProfile.bio === "I plan your trips.", "resetting its picture restores the runtime default and preserves its bio");
  const posted = await gw.run(MAIN, "ab_post", { title: "Book the Lisbon hotel", text: "Comparing three near Alfama." });
  const titled = await until(async () => (await state()).sessions.find((x) => x.id === MAIN)?.title === "Book the Lisbon hotel");
  check(textOf(posted) === "Thread updated." && titled, "ab_post sets the session's thread's headline");
  await gw.run(MAIN, "ab_update", { text: "Found a hotel under budget" });
  const updated = await until(async () => (await state()).sessions.find((x) => x.id === MAIN)?.updates?.find((u) => u.text === "Found a hotel under budget"));
  check(!!updated, "ab_update adds a result to it");
  const asked = await gw.run(MAIN, "ab_ask", { question: "Which hotel?", options: ["Alfama|cheaper", "Chiado|closer"], wait_seconds: 0 });
  const question = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.title === "Which hotel?"));
  check(/Asked \(question .+\): it's in their Needs you\. Until it's answered, don't build what it decides.+the answer comes as your next message/.test(textOf(asked)) && question?.options?.length === 2, "ab_ask puts a question on it, which holds what it decides until its answer comes as the agent's next message");

  // A file the agent names is on the gateway's machine, in its workspace: agentbook reads it through the plugin.
  const ITINERARY = Buffer.concat([Buffer.from("# Lisbon\n"), Buffer.alloc(5 << 20, 97)]);
  fs.writeFileSync(path.join(WORKSPACE, "itinerary.md"), ITINERARY);
  const reads = gw.pluginCalls.length;
  const shared = await gw.run(MAIN, "ab_file", { path: "itinerary.md", title: "The itinerary" }, { workspaceDir: WORKSPACE });
  const file = await until(async () => (await state()).sessions.find((x) => x.id === MAIN)?.last_files?.find((f) => f.name === "itinerary.md"));
  const pieces = gw.pluginCalls.slice(reads).filter((c) => c.method === "agentbook.read");
  const bytes = file && Buffer.from(await (await req(file.url || `/api/files/${file.id}`)).arrayBuffer());
  check(textOf(shared) === "Shared itinerary.md on your thread." && bytes?.equals(ITINERARY) && pieces.length >= 3, `ab_file shares a file from the agent's workspace, read through the plugin a piece at a time (${pieces.length} reads)`);
  fs.writeFileSync(path.join(WORKSPACE, ".env"), "TOKEN=abc\n");
  const secret = await failed(gw.run(MAIN, "ab_file", { path: ".env" }, { workspaceDir: WORKSPACE }));
  check(/secret|stays on|keep/i.test(JSON.stringify(secret)), `ab_file won't share a secret's file (${JSON.stringify(secret).slice(0, 140)})`);
  const missing = await failed(gw.run(MAIN, "ab_file", { path: "nope.md" }, { workspaceDir: WORKSPACE }));
  check(missing === `No file at ${path.join(WORKSPACE, "nope.md")}`, "one that isn't there says so, as the agent's tool error");
  const outsider = await failed(gw.run("agent:main:telegram:999", "ab_post", { title: "Hi" }));
  check(/isn't a thread on agentbook/.test(outsider || ""), "a session agentbook doesn't show gets an error that says why");
  check(gw.pluginCalls.filter((c) => c.method === "agentbook.take").every((c) => typeof c.params.id === "string") && !gw.pluginCalls.some((c) => c.method === "agentbook.done" && c.params.result == null), "each call was taken, and answered, through the plugin's methods");

  // An agent routine it writes runs as a new session in its own workspace: with no folder, as its workspace is on
  // the gateway's machine, and this machine refuses a folder it doesn't share (one an OpenClaw agent wrote with its
  // workspace's path never ran: "… is outside the folders this machine shares").
  await gw.run(MAIN, "ab_routine_write", { kind: "agent", name: "Hotel prices", prompt: "Check hotel prices in Lisbon for next month.", schedule: "0 9 * * 1" }, { workspaceDir: WORKSPACE });
  const okq = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.routine?.rid && !q.answered));
  const rid = okq?.routine.rid;
  await post(`/api/questions/${okq?.id}/answer`, { value: "Turn it on" });
  const ranNow = await post(`/api/routines/${rid}/run`);
  const ran = await until(async () => {
    const x = await get(`/api/routines/${rid}`);
    return x.runs?.[0] && x;
  });
  const started = await until(async () => (await state()).sessions.find((x) => x.id.startsWith("agent:main:agentbook-") && x.routine?.id === rid));
  check(okq && !ran?.root && ranNow.status === 200 && ran?.runs[0].ok !== false && !ran?.runs[0].error && started, `a routine it writes has no folder, and Run now starts a session of it (${ran?.runs?.[0]?.error || ranNow.error || ""})`);

  // ---------- disconnected ----------
  await post("/api/openclaw", { disconnect: true });
  const gone = await until(() => gw.tools(MAIN).length === 0);
  check(gone && !(await gw.prompt(MAIN)), "once agentbook disconnects, the agents have none of its tools again, and aren't told about it");

  // ---------- a gateway without the plugin ----------
  await gw.uninstall();
  await post("/api/openclaw", { url: gw.url, token: TOKEN });
  const without = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "connected" && o.tools && o;
  }, 9000);
  check(without?.tools?.installed === false, "a gateway without the plugin is one whose agents don't have agentbook's tools, which the Add agents page says");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
  gw.close();
}
if (failures) console.log(`\nserver log:\n${serverLog.slice(-3000)}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
