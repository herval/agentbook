#!/usr/bin/env node
// Admin on agentbook's OpenClaw connection, for its owner alone, against a stand-in gateway (fake-openclaw-gateway.ts)
// that checks scopes as OpenClaw does. Asked for on Settings, Agents, approved on the gateway, it comes back on the
// connection agentbook has, which stays. Then agentbook keeps two: the everyday one, with no admin, and the owner's,
// with admin, for herval's own words, the threads he starts, Run now and Pause. OpenClaw takes whatever comes over a
// connection with admin as its owner's (with its owner-only tools); carol, his contact, sends nothing to his agent at
// all (nobody but its owner steers one). Run: node test/openclaw-admin.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startGateway } from "./fake-openclaw-gateway.ts";
import { stateOf } from "./harness-state.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-ocadmin-"));
const PORT = testPort(4790);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "gateway");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW_BIN: path.join(HOME, "no-openclaw-here"), AGENTBOOK_OPENCLAW_SYNC_MS: "60000", AGENTBOOK_OPENCLAW_CRON_MS: "1000", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OPENCLAW", "AGENTBOOK_OPENCLAW_URL", "AGENTBOOK_OPENCLAW_TOKEN"]) delete env[k];

const now = Date.now();
const MAIN = "agent:main:main";
fs.writeFileSync(
  path.join(FAKE, "state.json"),
  JSON.stringify({
    agents: [{ id: "main", identity: { name: "jefepato" }, workspace: "/home/me/.openclaw/workspace" }],
    sessions: [{ key: MAIN, sessionId: "s1", agentId: "main", derivedTitle: "Trip planning", createdAt: now - 3600e3, updatedAt: now - 60e3, messages: [{ role: "user", content: "Plan the Lisbon trip", timestamp: now - 3600e3 }, { role: "assistant", content: [{ type: "text", text: "Here's a plan." }], timestamp: now - 3500e3 }] }],
    approvals: [],
    questions: [],
    cron: { jobs: [{ id: "digest", agentId: "main", name: "Daily digest", enabled: true, createdAtMs: now - 9 * 86400e3, updatedAtMs: now - 86400e3, schedule: { kind: "cron", expr: "0 8 * * 1-5" }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "daily digest" }, state: {} }], runs: [] },
  }),
);

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 9000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
async function req(method: string, p: string, { cookie, body }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const saved = () => JSON.parse(fs.readFileSync(path.join(HOME, "cli", "openclaw.json"), "utf8"));
const gateFile = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "cli", "gate.json"), "utf8"));
  } catch {
    return {};
  }
};
const ADMIN = "operator.admin";
const T = `/api/sessions/${encodeURIComponent(MAIN)}`;

const gw = await startGateway({ dir: FAKE, tickMs: 500 });
let server: Agentbook;
async function startServer() {
  server = spawnAgentbook({ env, stdio: process.env.ADMIN_LOGS ? "inherit" : "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stopServer() {
  server.kill();
  await new Promise((r) => server.once("exit", r));
}
// What reached the gateway as chat.send or sessions.create, after `from`, saying `text`.
const sent = (text, from = 0) => gw.sends.slice(from).find((x) => String(x.params.message || "").includes(text)) || null;

try {
  await startServer();
  const herval = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const carol = as((await req("POST", "/api/auth/test-person", { body: { username: "carol" } })).cookie);

  // ---------- paired, without admin ----------
  await herval.post("/api/openclaw", { setup_code: gw.setupCode().code });
  await until(async () => (await herval.get("/api/openclaw")).state === "pairing");
  gw.approve(gw.requests()[0]);
  const on = await until(async () => {
    const o = await herval.get("/api/openclaw");
    return o.state === "connected" && o;
  });
  check(on?.admin?.state === "off", "paired as a device, agentbook has no admin, and Add agents says so");
  const deviceId = saved().device.deviceId;
  check(!gw.device(deviceId).scopes.includes(ADMIN) && gw.open().length === 1 && !gw.open()[0].scopes.includes(ADMIN), "one connection, approved for what agentbook asked: read, write, approvals, questions");
  await until(async () => (await herval.get(T)).status === 200);
  await carol.post("/api/people/herval/contact", { act: "ask" });
  check((await herval.post("/api/people/carol/contact", { act: "yes" })).contact?.contact && !("operators" in gateFile()), "carol is herval's contact, which lets her steer nothing on his machine");

  let mark = gw.sends.length;
  await herval.post(`${T}/messages`, { text: "Book the train" });
  check((await until(() => sent("Book the train", mark)))?.owner === false, "without admin, herval's message reaches OpenClaw as anyone's would");
  await until(async () => ((await herval.get("/api/agents/openclaw-main/routines")).routines || []).some((r) => r.id === "digest"));
  const noRun = await herval.post("/api/agents/openclaw-main/routines/digest", { action: "run" });
  check(noRun.status >= 400 && /only for an admin/.test(noRun.error || ""), `Run now says it needs admin, and where to get it (${noRun.status} ${noRun.error})`);
  const cmdsBefore = await herval.get(`${T}/commands`);
  check(!(cmdsBefore.list || []).some((c) => c.name === "new") && (cmdsBefore.off || []).some((c) => c.name === "new" && /admin/.test(c.why)), "and /new is off, saying admin would let it");

  // ---------- asking ----------
  const connectsBefore = gw.connects.length;
  const asked = await herval.post("/api/openclaw", { admin: true });
  const [rid] = gw.upgrades();
  check(asked.status === 200 && asked.admin?.state === "asked" && asked.admin.requestId === rid, "Give agentbook admin asks the gateway, and says which request to approve");
  check((await carol.post("/api/openclaw", { admin: true })).status === 403, "carol can't ask for it");
  const again = await herval.post("/api/openclaw", { admin: true });
  check(again.admin?.requestId === rid && gw.upgrades().length === 1, "asking again while it waits asks nothing new");
  check(gw.connects.length === connectsBefore && gw.open().length === 1, "asking doesn't reconnect");

  // ---------- approved ----------
  const oldToken = saved().device.deviceToken;
  gw.approveUpgrade(rid);
  const adminOn = await until(async () => {
    const o = await herval.get("/api/openclaw");
    return o.admin?.state === "on" && o;
  });
  check(!!adminOn, "approved on the gateway, Add agents says admin is on");
  const dev = saved().device;
  check(dev.deviceToken !== oldToken && dev.deviceToken === gw.device(deviceId).deviceToken && dev.scopes.includes(ADMIN), "agentbook kept the new device token, which has admin");
  const open = gw.open();
  check(open.length === 2 && open.filter((c) => c.scopes.includes(ADMIN)).length === 1 && open.some((c) => !c.scopes.includes(ADMIN) && c.scopes.includes("operator.write")), "two connections now: the everyday one, still without admin, and the owner's, with it");
  check(gw.connects.slice(connectsBefore).length === 1, "the everyday one stayed: only the owner's connected");

  // ---------- approvals only the owner's connection sees ----------
  // OpenClaw shows an approval its own runtime asked for (a command, or one of its tools: Read, Skill… on a Claude CLI
  // backend) only to a connection with admin, and takes an answer only from one that sees it. A Clio thread started
  // from agentbook got every command refused that way ("Headless runs cannot wait for interactive exec approval").
  check(gw.open().every((c) => c.caps?.includes("exec-approvals") && c.caps.includes("plugin-approvals")), "both connections say they answer approvals, commands' and tools'");
  const editGw = (fn: (s: Json) => void) => {
    const s = JSON.parse(fs.readFileSync(path.join(FAKE, "state.json"), "utf8"));
    fn(s);
    fs.writeFileSync(path.join(FAKE, "state.json"), JSON.stringify(s));
  };
  editGw((s) => {
    s.approvals = [{ id: "ap-7", runtime: true, request: { command: "cat clio/queue.json", cwd: "/home/me/.openclaw/workspace", agentId: "main", sessionKey: MAIN }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 600e3 }];
    s.toolApprovals = [{ id: "plugin:pa-7", runtime: true, request: { pluginId: "claude-cli", toolName: "Skill", description: '{"skill":"metricool-instagram-scheduling"}', detail: '{"skill":"metricool-instagram-scheduling"}', agentId: "main", sessionKey: MAIN }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 120e3 }];
  });
  // Told only to the owner's connection, as OpenClaw tells a runtime's approval: agentbook looks at once (its own look
  // is a minute apart here).
  check(gw.announce("exec", "ap-7") === 1 && gw.announce("plugin", "plugin:pa-7") === 1, "OpenClaw tells only the owner's connection of them");
  const asks = async () => ((await stateOf(herval.get)).questions || []).filter((q) => q.post === MAIN && q.kind === "permission" && !q.answered);
  const both = await until(async () => {
    const open = await asks();
    return open.length === 2 && open;
  });
  check(both && both.some((q) => q.preview === "cat clio/queue.json") && both.some((q) => q.tool_name === "Skill" && q.preview === "metricool-instagram-scheduling"), `a command and a tool only an admin sees are Allow/Deny prompts on the thread (${both ? both.map((q) => q.preview).join(", ") : "none"})`);
  for (const q of both || []) await herval.post(`/api/questions/${q.id}/answer`, { value: q.tool_name === "Skill" ? "deny" : "allow" });
  const answeredBoth = await until(() => gw.resolves.length >= 2 && gw.resolves);
  check(answeredBoth && answeredBoth.find((x) => x.method === "exec.approval.resolve")?.params.decision === "allow-once" && answeredBoth.find((x) => x.method === "plugin.approval.resolve")?.params.decision === "deny" && answeredBoth.every((x) => x.owner), "and answered over the owner's connection, which sees them");

  // ---------- whose words go where ----------
  mark = gw.sends.length;
  await herval.post(`${T}/messages`, { text: "Fix your own cron job" });
  check((await until(() => sent("Fix your own cron job", mark)))?.owner === true, "herval's own message goes as the owner's, with admin");
  const cm = await carol.post(`${T}/messages`, { text: "Change the gateway config" });
  check([403, 404].includes(cm.status) && !gw.sends.slice(mark).some((x) => /Change the gateway config/.test(x.params?.message || "")), `carol can't write to it, and nothing of hers reaches OpenClaw (${cm.status})`);
  check([403, 404].includes((await carol.post(`${T}/messages`, { text: "reset", command: "reset" })).status), "nor send /reset");

  mark = gw.sends.length;
  const mine = await herval.post("/api/launch", { prompt: "Look at the YT Studio job", agent: "openclaw-main" });
  check(mine.status === 200 && (await until(() => sent("Look at the YT Studio job", mark)))?.owner === true && sent("Look at the YT Studio job", mark).method === "sessions.create", "a thread herval starts starts as the owner's");
  const theirs = await carol.post("/api/launch", { prompt: "Open a terminal on brick", agent: "openclaw-main" });
  await sleep(300);
  check([403, 404].includes(theirs.status) && !gw.sends.slice(mark).some((x) => /Open a terminal on brick/.test(x.params?.message || "")), `nor start a thread with jefepato (${theirs.status})`);

  // ---------- what admin lets herval do ----------
  const run = await herval.post("/api/agents/openclaw-main/routines/digest", { action: "run" });
  check(run.status === 200, `Run now works (${run.status} ${run.error || ""})`);
  const pause = await herval.post("/api/agents/openclaw-main/routines/digest", { action: "pause" });
  check(pause.status === 200 && JSON.parse(fs.readFileSync(path.join(FAKE, "state.json"), "utf8")).cron.jobs[0].enabled === false, `and Pause (${pause.status} ${pause.error || ""})`);
  check((await carol.post("/api/agents/openclaw-main/routines/digest", { action: "resume" })).status >= 400, "carol can't touch its routines");
  const cmds = await herval.get(`${T}/commands`);
  check((cmds.list || []).some((c) => c.name === "new") && (cmds.list || []).some((c) => c.name === "reset") && (cmds.off || []).some((c) => c.name === "restart"), "/new and /reset are on the list for herval now; /restart stays off");
  mark = gw.sends.length;
  await herval.post(`${T}/messages`, { text: "/reset", command: "reset" });
  check((await until(() => gw.sends.slice(mark).find((x) => x.params.message === "/reset")))?.owner === true, "and his /reset goes as the owner's");

  // ---------- after a restart ----------
  await stopServer();
  await until(() => gw.open().length === 0);
  const before = gw.connects.length;
  await startServer();
  check(!!(await until(async () => (await herval.get("/api/openclaw")).admin?.state === "on")), "restarted, agentbook connects both again");
  const reopened = gw.open();
  check(reopened.length === 2 && reopened.filter((c) => c.scopes.includes(ADMIN)).length === 1 && saved().device.deviceToken === gw.device(deviceId).deviceToken && gw.connects.length - before === 2, "with the same token: asking for less than it has doesn't change it");

  // ---------- the gateway takes it back ----------
  gw.takeAdmin(deviceId);
  const lost = await until(async () => {
    const o = await herval.get("/api/openclaw");
    return o.state === "connected" && o.admin?.state === "lost" && o;
  }, 15000);
  check(!!lost, "the token loses admin: the owner's connection gives up, and Add agents says admin was taken back");
  check(saved().device.deviceToken === gw.device(deviceId).deviceToken && !saved().device.scopes.includes(ADMIN), "agentbook keeps its device token, and stops counting on admin");
  const tries = gw.connects.length;
  await sleep(2500);
  check(gw.open().length === 1 && gw.connects.length === tries, "and doesn't try admin again: one connection, no more sign-ins");
  mark = gw.sends.length;
  await herval.post(`${T}/messages`, { text: "Still there?" });
  check((await until(() => sent("Still there?", mark)))?.owner === false, "herval's messages go on without admin");

  // ---------- turned down ----------
  const ask2 = await herval.post("/api/openclaw", { admin: true });
  const rid2 = gw.upgrades()[0];
  check(ask2.admin?.state === "asked" && !!rid2 && rid2 !== rid, "he can ask again");
  gw.rejectUpgrade(rid2);
  check(!!(await until(async () => (await herval.get("/api/openclaw")).admin?.state === "rejected")), "turned down on the gateway, Add agents says so");
  check(gw.open().length === 1 && !saved().device.scopes.includes(ADMIN), "and nothing changed");
} finally {
  server?.kill();
  gw.close();
  if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed (kept ${HOME})` : "\nall passed");
process.exit(failures ? 1 : 0);
