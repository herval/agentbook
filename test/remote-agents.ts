#!/usr/bin/env node
// Agents that run on their vendor's computers: Claude Agent (Claude Managed Agents) and Devin, each against a stand-in
// for its API (fake-managed-agents.ts, fake-devin.ts). They connect with a key that stays on the machine, start from
// agentbook on a repo with nothing cloned here, show and take messages as threads, and a restart of agentbook-cli
// neither loses nor repeats anything. A sandbox's tool calls reach its own thread and nothing of this machine.
// Run: node test/remote-agents.ts

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { fakeManaged, KEY as CLAUDE_KEY } from "./fake-managed-agents.ts";
import { fakeDevin, KEY as DEVIN_KEY, ORG } from "./fake-devin.ts";
import { readEvents } from "../plugin/cli/runtimes/kit/remote.ts";
import { createClaudeAgent } from "../plugin/cli/runtimes/claude-agent/claude-agent.ts";
import { createDevin } from "../plugin/cli/runtimes/devin/devin.ts";
import { TOOLS } from "../plugin/cli/tools/index.ts";
import type { Json } from "./harness-types.ts";
import type { RuntimeContext } from "../plugin/cli/runtimes/runtime.ts";
import { RUNTIMES } from "../plugin/shared/runtimes.ts";
import { emptyState } from "../plugin/shared/store.ts";
import type { Session } from "../plugin/shared/types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-remote-"));
const MINE = fs.mkdtempSync(path.join(TEST, ".remote-"));
const PORT = testPort(4690);
const URL_ = `http://127.0.0.1:${PORT}`;
const claude = await fakeManaged();
const devin = await fakeDevin();
const GH_TOKEN = "github_pat_fakefakefakefakefakefake0123456789";
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_ANTHROPIC_URL: claude.url, AGENTBOOK_DEVIN_URL: devin.url, AGENTBOOK_DEVIN_POLL_MS: "60" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_CLAUDE_AGENT", "AGENTBOOK_MANAGED", "AGENTBOOK_DEVIN", "CLAUDE_JOB_DIR"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL_ + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => {
  const r = await req(p);
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const post = async (p: string, body: unknown = {}): Promise<Json> => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const detail = (id) => get(`/api/sessions/${encodeURIComponent(id)}`);
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(40);
  }
};
const thread = async (id) => (await state()).sessions.find((x) => x.id === id);
const said = (id, text) => until(async () => (await detail(id)).messages?.find((m) => m.from === "agent" && (text instanceof RegExp ? text.test(m.text) : m.text === text)));
const threadOf = (agent, lid) => until(async () => (await state()).sessions.find((x) => x.agent === agent && x.launch === lid)?.id);
const claudeSession = (id) => claude.sessions.get(id);
const sentTo = (id, type) => claudeSession(id).events.filter((e) => e.type === type);

let serverLog = "";
let server: Agentbook;
async function startServer() {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 400; i++) {
    try {
      if ((await fetch(URL_ + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stopServer() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}
// Everything agentbook wrote under its home, but the files that are meant to hold the key.
function leaked(secret, except) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!except.some((x) => p.endsWith(x)) && fs.readFileSync(p).includes(secret)) hits.push(p);
    }
  };
  walk(HOME);
  return hits;
}

try {
  await startServer();
  const setup = await fetch(URL_ + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- connecting ----------
  const before = await get("/api/runtimes");
  const rows = Object.fromEntries((before.runtimes || []).map((x) => [x.kind, x]));
  check(rows["claude-agent"]?.status === "Not connected" && rows.devin?.status === "Not connected" && rows.devin.remote, "Add agents lists both, not connected");
  check(!(await state()).agents.some((a) => a.id === "claude-agent" || a.id === "devin"), "neither is an agent of yours until it's connected");
  const wrong = await post("/api/remote-agents", { vendor: "claude-agent", key: "sk-ant-wrong-key-0123456789012345678901" });
  check(wrong.status >= 400 && /refused the key/.test(JSON.stringify(wrong)), `a wrong key is refused, in the vendor's words (${wrong.status})`);
  check(!fs.existsSync(path.join(HOME, "cli", "claude-agent.json")) || !fs.readFileSync(path.join(HOME, "cli", "claude-agent.json"), "utf8").includes("sk-ant-wrong"), "and isn't kept");
  const connected = await post("/api/remote-agents", { vendor: "claude-agent", key: CLAUDE_KEY, github_token: GH_TOKEN, budget: "12.50" });
  check(connected.status === 200 && connected.connection?.connected && connected.connection.github && !JSON.stringify(connected).includes(CLAUDE_KEY), "the right one connects, and the answer doesn't carry it");
  const made = [...claude.agents.values()][0];
  const environment = [...claude.environments.values()][0];
  check(claude.agents.size === 1 && claude.environments.size === 1 && made.tools[0].type === "agent_toolset_20260401" && environment.config.networking.type === "limited" && environment.config.networking.allow_package_managers, "connecting makes one agent, and one environment that reaches only what it needs");
  check(claude.calls.every((c) => !c.path.startsWith("/v1/agents") || c.version === "2026-10-21") && claude.calls.at(-1).beta === "managed-agents-2026-04-01", "it speaks the API's version and beta");
  check((await post("/api/remote-agents", { vendor: "devin", key: "cog_wrong0key0000000000000000000" })).status >= 400, "Devin refuses a wrong key too");
  check((await post("/api/remote-agents", { vendor: "devin", key: DEVIN_KEY, budget: "a lot" })).status >= 400, "what a Devin thread may use is a whole number of ACUs");
  const dv = await post("/api/remote-agents", { vendor: "devin", key: DEVIN_KEY, budget: "4" });
  check(dv.connection?.connected && dv.connection.org === ORG, "Devin's key says its organization");
  check(dv.connection?.budget === 4, "and it keeps what a thread may use");
  const file = path.join(HOME, "cli", "claude-agent.json");
  check((fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(path.join(HOME, "cli", "devin.json")).mode & 0o777) === 0o600, "each key is in a file only you can read");
  const seen = await get("/api/remote-agents");
  check(!JSON.stringify(seen).includes(CLAUDE_KEY) && !JSON.stringify(seen).includes(DEVIN_KEY) && !JSON.stringify(seen).includes(GH_TOKEN) && seen["claude-agent"]?.budget === "12.50", "reading the connection never gives a key back");
  // Settings → Agents draws each one's form from its fields (plugin/shared/runtimes.ts): whether one is saved, and
  // what it is now, are the connection's fields they name.
  const named = (id: "claude-agent" | "devin") => RUNTIMES[id].setup.fields.flatMap((f) => [f.saved, f.now]).filter(Boolean);
  check((["claude-agent", "devin"] as const).every((id) => named(id).every((k) => Object.hasOwn(seen[id] || {}, k))), "and it has every field its form names");
  const agents = await until(async () => {
    const list = (await state()).agents;
    return list.some((a) => a.id === "claude-agent") && list.some((a) => a.id === "devin") ? list : null;
  });
  const asAgent = agents?.find((a) => a.id === "claude-agent");
  check((await get("/api/q/side")).records?.["agent:claude-agent"]?.repos === true, "the page hears that it works on repos, which is what its row in the workspace picker says");
  // One picker for every agent: a second menu shares its id, so a tap opens both, and one cut down to repos hides your folders.
  check(fs.readFileSync(path.join(TEST, "..", "web", "components", "Composer.tsx"), "utf8").split("id={`${draft}:ws`}").length === 2, "the composer has one workspace picker");
  check(asAgent?.kind === "claude-agent" && asAgent.folders === false && asAgent.repos && asAgent.models?.list?.some((m) => m.id === "claude-opus-5-5"), "connected, each is an agent of yours that works on repos rather than folders, with its models");

  // ---------- starting a Claude Agent thread ----------
  const lid = (await post("/api/launch", { prompt: "Say Hello from the sandbox", agent: "claude-agent", repo: "github.com/acme/core-api", model: "claude-sonnet-5-5", effort: "high" })).lid;
  const sid = await threadOf("claude-agent", lid);
  check(!!sid && (await said(sid, "Hello from the sandbox")), "a thread starts on it from agentbook, with its reply");
  const sent = claudeSession(sid).request;
  check(sent.agent.type === "agent_with_overrides" && sent.agent.id === made.id && sent.agent.model.id === "claude-sonnet-5-5" && sent.agent.model.effort === "high", "with the model and effort picked");
  const resource = sent.resources.find((r) => r.type === "github_repository");
  check(resource?.url === "https://github.com/acme/core-api" && resource.authorization_token === GH_TOKEN, "on the repo picked, cloned there and not here");
  check(sent.budget?.max_list_cost?.amount === "1250" && sent.vault_ids?.length === 1, "with what it may spend, and its GitHub tools");
  const names = sent.agent.tools.filter((t) => t.type === "custom").map((t) => t.name);
  check(JSON.stringify(names) === JSON.stringify(TOOLS.map((t) => t.name)) && !/only those listed/.test(sent.agent.system), `its tools are all of agentbook's, as every agent's are (${names.length})`);
  check(/sandbox in the cloud/.test(sent.agent.system) && /acme\/core-api is checked out/.test(sent.agent.system), "it's told where it is");
  const shown = await thread(sid);
  check(shown?.rt?.name === "Claude Agent" && shown.rt.remote && shown.repo === "github.com/acme/core-api" && !shown.cwd && !shown.root, "its thread is on the repo, with no folder here");
  check(shown?.proc === `claude-agent:${sid}`, `and it's Claude Agent's by one name, its proc too (${shown?.proc})`);
  check((await detail(sid)).messages.filter((m) => m.from === "human").length === 1, "your message shows once");
  check(await until(async () => (await thread(sid))?.effective === "idle" || (await thread(sid))?.state === "idle"), "it's idle when its turn ends");
  check(await until(() => !claudeSession(sid).watchers.size), "and nothing stays open on it while it waits");
  check(await until(async () => /\$1\.37/.test(JSON.stringify((await detail(sid)).attachments || {}))), "its link says what it has cost");
  check((await post("/api/launch", { prompt: "x", agent: "claude-agent", repo: "gitlab.com/acme/ledger" })).status >= 200, "a repo that isn't on GitHub gets a start");
  check(await until(async () => (await state()).launches.some((l) => /only clone repos on GitHub/.test(l.error || ""))), "which fails saying why");

  // ---------- talking to it ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Shell npm test" });
  check(await said(sid, "Ran it"), "a message goes on its session");
  const steps = await get(`/api/sessions/${sid}/steps`);
  check(steps.steps?.some((x) => x.kind === "tool" && x.title === "Run npm test" && x.done), "its tools are steps, on its thread");
  await post(`/api/sessions/${sid}/messages`, { text: `Tool ab_post {"title":"Fix the checkout"}` });
  check(await until(async () => (await thread(sid))?.title === "Fix the checkout"), "agentbook's tools work on its thread, with no address of ours to reach");
  check(await said(sid, /^Tool said: /), "and the session goes on with what they answered");
  await post(`/api/sessions/${sid}/messages`, { text: `Tool ab_profile {"bio":"I build in the cloud.","emoji":"☁️"}` });
  check(names.includes("ab_profile") && await until(async () => (await get("/api/agents/claude-agent")).agent?.bio === "I build in the cloud."), "Claude Agent can update its own profile from its sandbox");
  const secret = path.join(HOME, "secret.txt");
  fs.writeFileSync(secret, "the owner's own secret");
  await post(`/api/sessions/${sid}/messages`, { text: `Tool ab_file {"path":"${secret}"}` });
  const refused = await said(sid, /^Tool said: .*(No file|It failed)/);
  check(refused && !(await detail(sid)).files?.length, "a sandbox can't take a file off this machine");
  await post(`/api/sessions/${sid}/messages`, { text: `Tool ab_routine_write {"kind":"code","name":"x","test":true,"file":"${secret}"}` });
  const noFile = async () => (await detail(sid)).messages.filter((m) => m.from === "agent" && /^Tool said: .*No file at/.test(m.text)).length;
  check(await until(async () => (await noFile()) === 2), "nor make a routine of one: a routine's file is read in its sandbox");
  claude.output(sid, "report.txt", "the report");
  await post(`/api/sessions/${sid}/messages`, { text: `Tool ab_file {"path":"/mnt/session/outputs/report.txt"}` });
  check(await until(async () => (await detail(sid)).files?.some((f) => f.name === "report.txt")), "a file from its sandbox's outputs comes to its thread");

  // A file of the same name on this machine, whose text Changes would fill in around the edit. Not in a temporary
  // folder: Changes drops those as scratch, and then this would pass without looking.
  const other = path.join(MINE, "other.txt");
  fs.writeFileSync(other, "line one\nthe owner's other secret\nline three\n");
  await post(`/api/sessions/${sid}/messages`, { text: `Edit ${other}` });
  await said(sid, "Edited it");
  let listed = null;
  await until(async () => (listed = (await get(`/api/sessions/${sid}/changes?scope=all`)).files?.find((f) => f.path.endsWith("other.txt"))));
  check(listed, "a file it says it edited is listed under Changes");
  const hunks = listed && JSON.stringify(await get(`/api/sessions/${sid}/changes/file?path=${encodeURIComponent(listed.path)}`));
  check(hunks?.includes("other"), "with the edit it reported");
  check(listed && !hunks.includes("line three"), "and what's on this machine under that path isn't read in");
  check(!JSON.stringify(await get(`/api/sessions/${sid}/file?path=${encodeURIComponent(secret)}`)).includes("own secret"), "nor can a thread of its open a file here");

  const upload = async (name: string, body: string): Promise<Json> => (await req(`/api/upload?draft=1&name=${name}`, { method: "POST", body })).json();
  const memo = await upload("notes.txt", "the notes");
  await post(`/api/sessions/${sid}/messages`, { text: "Say Got it", files: [memo.id] });
  await said(sid, "Got it");
  const mounted = claudeSession(sid).resources.find((r) => r.type === "file");
  check(/\/notes\.txt$/.test(mounted?.mount_path || "") && sentTo(sid, "user.message").some((e) => e.content[0].text.includes(mounted.mount_path)), "a file you send goes into its sandbox, and it's told where");

  // ---------- what it asks, and stopping it ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Risky rm -rf build" });
  const perm = await until(async () => (await state()).questions.find((q) => q.post === sid && q.kind === "permission" && !q.answered));
  check(/rm -rf build/.test(perm?.detail || ""), "a call that needs an OK is an Allow/Deny prompt");
  await post(`/api/questions/${perm.id}/answer`, { value: "allow" });
  check((await until(() => sentTo(sid, "user.tool_confirmation")[0]?.result === "allow")) && (await until(async () => (await detail(sid)).messages.filter((m) => m.text === "Ran it").length === 2)), "allowing it goes on");
  await post(`/api/sessions/${sid}/messages`, { text: "Risky rm -rf dist" });
  const perm2 = await until(async () => (await state()).questions.find((q) => q.post === sid && q.kind === "permission" && !q.answered));
  await post(`/api/questions/${perm2.id}/answer`, { value: "deny" });
  check((await said(sid, "Didn't run it")) && sentTo(sid, "user.tool_confirmation")[1]?.result === "deny", "denying it says no");
  await post(`/api/sessions/${sid}/messages`, { text: "Slow" });
  await until(() => claudeSession(sid).slow);
  check((await until(async () => (await thread(sid)).state === "working")) && !(await thread(sid)).doing, "working, it no longer says it's waiting for your next message");
  const heard = sentTo(sid, "user.message").length;
  await post(`/api/sessions/${sid}/messages`, { text: "Use the staging database" });
  check(await until(() => sentTo(sid, "user.message").length === heard + 1), "a message mid-turn reaches it right away");
  check(await said(sid, "Heard: Use the staging database"), "and it goes on with it");
  await until(() => !claudeSession(sid).watchers.size);
  await post(`/api/sessions/${sid}/messages`, { text: "Slow" });
  await until(() => claudeSession(sid).slow);
  const stop = await post(`/api/sessions/${sid}/stop`);
  check(stop.status === 200 && (await until(() => !claudeSession(sid).slow)), "Stop interrupts its turn");
  await until(async () => !claudeSession(sid).watchers.size);
  await post(`/api/sessions/${sid}/messages`, { text: "Fail The sandbox ran out of disk" });
  check(await said(sid, "Claude Agent stopped: The sandbox ran out of disk"), "an error that ends its turn says it stopped, and why");

  // ---------- coming back ----------
  await until(async () => !claudeSession(sid).watchers.size);
  await until(async () => (await thread(sid))?.state === "idle");
  const count = (await detail(sid)).messages.filter((m) => m.from === "agent").length;
  await post(`/api/sessions/${sid}/messages`, { text: "Slow" });
  await until(() => claudeSession(sid).slow);
  claude.drop();
  await sleep(50);
  claude.say(claudeSession(sid), "Said while the stream was cut");
  check(await said(sid, "Said while the stream was cut"), "a cut stream comes back without losing what it said");
  await stopServer();
  claude.say(claudeSession(sid), "Said while agentbook-cli was down");
  claudeSession(sid).slow = false;
  claude.finish(claudeSession(sid));
  await startServer();
  check(await said(sid, "Said while agentbook-cli was down"), "what it said while agentbook-cli was down shows when it's back");
  const after = (await detail(sid)).messages.filter((m) => m.from === "agent");
  check(after.length === count + 2 && new Set(after.map((m) => m.id)).size === after.length, `and nothing it said comes twice (${after.length})`);
  const again = await get(`/api/sessions/${sid}/steps`);
  check(again.steps?.some((x) => x.kind === "tool" && x.title === "Run npm test") && again.steps.some((x) => x.kind === "say" && x.text === "Ran it"), "its steps are all there after a restart");
  check(await until(async () => (await thread(sid))?.state === "idle"), "and it's idle, as it is there");

  // ---------- its limits ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Spend" });
  check(await until(async () => /budget/.test((await thread(sid))?.rt?.blocked || "")), "at its budget, it says why it takes no replies");
  check((await post(`/api/sessions/${sid}/messages`, { text: "more" })).status === 409, "and refuses them");
  const lid2 = (await post("/api/launch", { prompt: "Say One", agent: "claude-agent" })).lid;
  const sid2 = await threadOf("claude-agent", lid2);
  await said(sid2, "One");
  await post(`/api/sessions/${sid2}/messages`, { text: "End" });
  check(await until(async () => (await thread(sid2))?.state === "done"), "a session that ends is a thread that's over");
  check((await post(`/api/sessions/${sid2}/messages`, { text: "more" })).status === 409, "and takes no more");
  check(!claudeSession(sid2).request.resources?.length, "and one started with no repo has none");

  // ---------- Devin ----------
  check((await post("/api/launch", { prompt: "Upgrade the ledger", agent: "devin", repo: "github.com/acme/ledger", mode: "auto" })).status === 400, "Devin offers no mode to pick: it works in its own sandbox and never asks");
  const dlid = (await post("/api/launch", { prompt: "Upgrade the ledger", agent: "devin", repo: "github.com/acme/ledger", model: "fast" })).lid;
  const did = await threadOf("devin", dlid);
  const ds = devin.sessions.get(did);
  check(!!ds && ds.request.prompt === "Upgrade the ledger" && ds.request.repos?.[0] === "acme/ledger" && ds.request.devin_mode === "fast" && ds.request.tags?.includes("agentbook"), "a thread starts on Devin, on the repo and mode picked");
  check(ds?.request.max_acu_limit === 4, "and it can't use more ACUs than it was given");
  check(!devin.calls.some((c) => c.method === "GET" && /\/sessions$/.test(c.path)), "without ever listing its organization's other sessions");
  const dt = await thread(did);
  check(dt?.rt?.name === "Devin" && dt.rt.remote && dt.repo === "github.com/acme/ledger" && dt.state === "working", "its thread is on the repo, and working");
  devin.said(did, "Found the migration.");
  check(await said(did, "Found the migration."), "what it says shows on its thread");
  check((await detail(did)).messages.filter((m) => m.from === "human").length === 1, "and your prompt shows once");
  devin.update(did, { acus_consumed: 3.25, pull_requests: [{ pr_url: "https://github.com/acme/ledger/pull/12", pr_state: "open" }] });
  check(await until(async () => JSON.stringify((await detail(did)).attachments || {}).includes("3.3 ACUs") || JSON.stringify((await detail(did)).attachments || {}).includes("3.2 ACUs")), "what it has used shows on its link");
  check(await until(async () => JSON.stringify(await thread(did)).includes("acme/ledger/pull/12")), "and its pull request on its thread");
  devin.update(did, { status_detail: "waiting_for_user" });
  check(await until(async () => (await thread(did))?.state === "idle"), "waiting for you, it's idle");
  await sleep(150);
  const quiet = devin.calls.length;
  await sleep(300);
  check(devin.calls.length === quiet, "and nothing asks it anything while it waits for you");
  await post(`/api/sessions/${did}/messages`, { text: "Use the new schema" });
  check(await until(() => ds.messages.some((m) => m.source === "user" && m.message === "Use the new schema")) && (await until(async () => (await thread(did))?.state === "working")), "a message wakes it");
  check(!(await thread(did)).doing, "and working, it no longer says it's waiting for your next message, as the turn before ended on");
  check((await detail(did)).messages.filter((m) => m.text === "Use the new schema").length === 1, "and shows once");
  const brief = await upload("brief.txt", "the brief");
  await post(`/api/sessions/${did}/messages`, { text: "Here's the brief", files: [brief.id] });
  check(await until(() => devin.calls.some((c) => /\/attachments$/.test(c.path)) && ds.messages.some((m) => m.message === "Here's the brief")) && devin.calls.find((c) => c.body?.message === "Here's the brief")?.body.attachment_urls?.length === 1, "a file you send goes to Devin with your message");
  devin.update(did, { status_detail: "waiting_for_user" });
  await until(async () => (await thread(did))?.state === "idle");
  // The status read while it wakes comes back saying it's idle, and with it what it said once it woke.
  devin.lag.ms = 200;
  devin.lag.status = 300;
  await post(`/api/sessions/${did}/messages`, { text: "Take your time" });
  await until(() => ds.status_detail === "working");
  devin.lag.ms = 0;
  devin.said(did, "On it.");
  check(await said(did, "On it."), "a run that takes it a moment to start isn't lost");
  devin.lag.status = 0;
  devin.update(did, { status_detail: "waiting_for_approval" });
  check(await said(did, /waiting for an approval/), "an approval only Devin can take says so");
  const polls = devin.calls.length;
  check(await until(() => devin.calls.length > polls), "and it's still looked at, as only Devin's page can end that");
  devin.update(did, { status_detail: "working" });
  await until(async () => (await thread(did))?.state === "working");
  await stopServer();
  devin.said(did, "Said while agentbook-cli was down.");
  await startServer();
  check(await said(did, "Said while agentbook-cli was down."), "what it said while agentbook-cli was down shows when it's back");
  const again2 = (await detail(did)).messages;
  check(again2.filter((m) => m.text === "On it.").length === 1 && again2.filter((m) => m.text === "Use the new schema").length === 1 && again2.filter((m) => m.text === "Upgrade the ledger").length === 1, "and nothing comes twice");
  const stopped = await post(`/api/sessions/${did}/stop`);
  check(stopped.status === 200 && devin.calls.some((c) => c.path.endsWith("/sleep")) && !devin.calls.some((c) => c.method === "DELETE"), "Stop puts it to sleep, and never ends it");
  check(await until(async () => /Asleep/.test(JSON.stringify(await thread(did)))), "and says your next message wakes it");
  await post(`/api/sessions/${did}/messages`, { text: "One more" });
  await until(async () => (await thread(did))?.state === "working");
  devin.update(did, { status: "exit", status_detail: null });
  check(await until(async () => (await thread(did))?.state === "done"), "a session that ends is a thread that's over");
  check((await post(`/api/sessions/${did}/messages`, { text: "and another" })).status === 409, "and takes no more");

  // ---------- small things ----------
  const silent = await readEvents(new ReadableStream({ start() {} }), null, 30).next().then(() => null, (e) => e);
  check(silent?.quiet, "a stream that goes quiet is given up on, so a dead connection can't hold a thread");
  // A machine that has both sessions already (Claude Agent's from before it had one name, "managed:"): a context with
  // nothing but them, whose every other part would say so if used.
  const unused = (what: string) => () => {
    throw new Error(`a start sent again used the context's ${what}`);
  };
  const at = new Date().toISOString();
  const session = (id: string, launch: string, proc: string): Session => ({ id, agent: "a", label: id, proc, session_id: null, transcript: null, started: at, updated: at, rev: 0, title: null, text: null, prompt: "p", state: "working", busy: true, ended: null, end_reason: null, channel: false, launch, cloud: null, url: null, updates: [], attachments: {}, prs: {} });
  const already: RuntimeContext = {
    machine: "test",
    state: { ...emptyState(), sessions: { x: session("x", "l1", "managed:x"), y: session("y", "l2", "devin:y") } },
    emit: unused("emit"),
    echo: unused("echo"),
    echoed: unused("echoed"),
    keptOff: () => false,
    pending: unused("pending"),
    deliver: unused("deliver"),
    label: unused("label"),
    describe: unused("describe"),
    attached: unused("attached"),
    gitInfo: unused("gitInfo"),
    fetchFile: unused("fetchFile"),
    refetch: unused("refetch"),
    context: unused("context"),
    mcp: unused("mcp"),
    mcpForAll: unused("mcpForAll"),
    codexTools: () => false,
    historyFrom: () => 0,
    mcpCall: unused("mcpCall"),
    blobPut: unused("blobPut"),
    log() {},
  };
  // Both off, so connecting them here touches nothing of this machine's (their key files here are its own
  // agentbook's), and Claude Agent by AGENTBOOK_MANAGED=0, its name from before, which still leaves it off.
  delete process.env.AGENTBOOK_CLAUDE_AGENT;
  process.env.AGENTBOOK_MANAGED = "0";
  process.env.AGENTBOOK_DEVIN = "0";
  const claudeAgent = createClaudeAgent();
  const devinAgent = createDevin();
  claudeAgent.connect(already);
  devinAgent.connect(already);
  check(!claudeAgent.health().enabled && claudeAgent.row().detail === "AGENTBOOK_MANAGED=0 leaves it off.", "AGENTBOOK_MANAGED=0, from before Claude Agent had one name, still leaves it off");
  const startedAgain = async (rt: typeof claudeAgent, lid: string) => ((await rt.start({ prompt: "p", lid })) as { id: string }).id;
  check((await startedAgain(claudeAgent, "l1")) === "x" && (await startedAgain(devinAgent, "l2")) === "y", "a start sent again is the session it started, not another one to pay for");

  // ---------- keys ----------
  for (const [secret, keeper] of [[CLAUDE_KEY, ["cli/claude-agent.json"]], [DEVIN_KEY, ["cli/devin.json"]], [GH_TOKEN, ["cli/claude-agent.json"]]]) {
    const hits = leaked(secret, keeper);
    check(!hits.length, `a key is nowhere but its file${hits.length ? `: ${hits.join(", ")}` : ""}`);
  }
  const cli = (args: string[], input?: string) =>
    new Promise<{ status: number | string; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [path.join(TEST, "..", "plugin", "cli", "main.mjs"), "remote", ...args], { env, encoding: "utf8", timeout: 20000 }, (err, stdout, stderr) => resolve({ status: err ? err.code || 1 : 0, stdout, stderr }));
      child.stdin.end(input);
    });
  const told = await cli(["status"]);
  check(/claude-agent: connected, with a GitHub token, \$12\.50 a thread/.test(told.stdout), `agentbook-cli remote says what's connected (${told.stdout.trim() || told.stderr.trim()})`);
  await post("/api/remote-agents", { vendor: "devin", disconnect: true });
  const again3 = await cli(["connect", "devin"], `${DEVIN_KEY}\n`);
  check(again3.status === 0 && /devin is connected/.test(again3.stdout) && !again3.stdout.includes(DEVIN_KEY) && (await get("/api/remote-agents")).devin?.connected, `and connects one with its key on stdin, never as an argument (${again3.stdout.trim() || again3.stderr.trim()})`);
  check((await cli(["connect", "devin"], "cog_wrong0key0000000000000000000\n")).status !== 0, "and says so when it's wrong");
  check(claude.vaults.size === 1, "its GitHub token is in one vault");
  const goneClaude = await post("/api/remote-agents", { vendor: "claude-agent", disconnect: true });
  check(goneClaude.connection?.connected === false && !claude.vaults.size && !fs.readFileSync(file, "utf8").includes(GH_TOKEN), "and disconnecting takes it out of there and off this machine");
  const off = await post("/api/remote-agents", { vendor: "devin", disconnect: true });
  check(off.connection?.connected === false && !fs.readFileSync(path.join(HOME, "cli", "devin.json"), "utf8").includes(DEVIN_KEY), "disconnecting forgets the key");
  check(await until(async () => (await state()).agents.find((a) => a.id === "devin")?.offline), "and its agent is offline");
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.stack}`);
} finally {
  server?.kill("SIGTERM");
  claude.close();
  devin.close();
  await sleep(200);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(MINE, { recursive: true, force: true });
}
if (failures) console.log(serverLog.split("\n").slice(-25).join("\n"));
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
