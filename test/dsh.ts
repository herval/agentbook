#!/usr/bin/env node
// DeepSeek Harness on agentbook: a stand-in `dsh` (fake-dsh.ts) answers ACP and keeps its sessions' logs the way dsh
// does. You start sessions from agentbook, write to them, allow what they ask, pick their model and mode, and stop
// them; their steps come from ACP while a turn runs and from their logs after a restart; they have agentbook's tools.
// agentbook's plugin for dsh runs in the stand-in as it would in dsh's ACP server: it sets a thread's mode, and asks a
// plan's review on the thread.
// Run: node test/dsh.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";
import { RUNTIMES } from "../plugin/shared/runtimes.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-dsh-")));
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const DSH_HOME = path.join(HOME, "dsh");
const FAKE = path.join(HOME, "fake");
const project = path.join(HOME, "dev", "app");
for (const d of [DSH_HOME, FAKE, project, path.join(HOME, "cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [path.join(HOME, "dev")], starts_per_hour: 1000 })); // the folders it shares
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_DSH_BIN: path.join(TEST, "fake-dsh.ts"), DSH_HOME, FAKE_DSH_DIR: FAKE, AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_DSH", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR"]) delete env[k];

const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const acp = (method) => calls().filter((c) => c.method === method);
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}) => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const state = () => stateOf(get);
const detail = (id: string) => get(`/api/sessions/${encodeURIComponent(id)}`);
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const said = (id: string, text: string | RegExp) => until(async () => (await detail(id)).messages?.find((m) => m.from === "agent" && (text instanceof RegExp ? text.test(m.text) : m.text === text)));
const working = async (id) => (await state()).sessions.find((x) => x.id === id)?.effective === "working";

let serverLog = "";
let server;
async function startServer() {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
try {
  await startServer();
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- the agent ----------
  const first = await until(async () => {
    const s = await state();
    return s.agents?.some((a) => a.id === "dsh") && s;
  });
  const agent = first?.agents.find((a) => a.id === "dsh");
  check(agent?.kind === "dsh" && agent.runtime === "dsh" && agent.name === "DeepSeek", "with dsh installed, DeepSeek is a profile");
  const kinds = await get("/api/runtimes");
  const row = kinds.runtimes?.find((x) => x.kind === "dsh");
  check(row?.ok && row.status === "Ready" && row.name === "DeepSeek Harness", "Add agents lists it, ready");
  check(!acp("initialize").length, "dsh's ACP server starts only when a thread needs it");

  // ---------- starting one ----------
  const launched = await post("/api/launch", { prompt: "Add a README", agent: "dsh", root: project });
  const made = await until(() => acp("session/new")[0]);
  check(launched.status === 200 && made?.params.cwd === project, "posting on DeepSeek's wall starts an ACP session in the folder picked");
  const given = made?.params.mcpServers?.[0];
  check(given?.type === "http" && given.name === "agentbook" && new globalThis.URL(given.url).searchParams.get("proc") === `launch:${launched.lid}`, "it has agentbook's tools, at their address, writing to the launch until its post exists");
  const sid = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === launched.lid)?.id);
  const reply = await said(sid, "Done: Add a README");
  const asked = (await detail(sid)).messages.filter((m) => m.text === "Add a README");
  check(reply && asked.length === 1 && asked[0].from === "human" && !(await state()).launches.some((l) => l.id === launched.lid && !l.post), "its post takes the launch's place, with your message once and its reply");
  const argv = calls().find((c) => c.cmd === "argv")?.args || [];
  const overlay = argv[2] === "--patch" ? JSON.parse(fs.readFileSync(argv[3], "utf8")) : [];
  const inserted = overlay[0]?.insert?.[0];
  check(inserted?.id === "agentbook" && inserted.name === path.join(TEST, "..", "plugin", "dsh", "index.js") && inserted.config?.own, `dsh's ACP server starts with agentbook's plugin in it, by path in an overlay (${argv.join(" ")})`);
  const auto = calls().findIndex((c) => c.cmd === "preset" && c.sessionId === sid);
  check(auto >= 0 && calls()[auto].preset === "workspace-write" && auto < calls().findIndex((c) => c.method === "session/prompt" && c.params.sessionId === sid), "a thread started without a mode is in Auto (dsh's workspace-write), set before its first prompt");
  check(!/are threads too/.test((await get("/api/runtimes")).runtimes?.find((x) => x.kind === "dsh")?.detail || ""), "the plugin in agentbook's own ACP server isn't one of dsh's apps on Add agents");
  const firstPrompt = acp("session/prompt")[0]?.params.prompt || [];
  check(firstPrompt.length === 2 && firstPrompt[0].text === "Add a README" && /agentbook/.test(firstPrompt[1].text), "its first prompt is followed by what agentbook tells a session it starts (dsh names a session after how it starts)");
  const steps = await get(`/api/sessions/${sid}/steps`);
  check(steps.steps?.some((x) => x.kind === "tool" && x.title === "Run ls" && x.done) && steps.steps.some((x) => x.kind === "say" && x.text === "Done: Add a README") && !steps.steps.some((x) => /Thinking it over/.test(x.text || "")), "its tool calls are steps, with what it said (not its reasoning)");
  const named = await until(async () => (await detail(sid)).ai_title === "About Add a README" && (await detail(sid)));
  check(named?.model === "deepseek-v4-flash", "once the turn ends, its log gives the thread its title and model");
  const models = (await until(async () => (await state()).agents.find((a) => a.id === "dsh")?.models?.list?.length && (await state()).agents.find((a) => a.id === "dsh")))?.models;
  check(models?.list.map((m) => m.id).join() === "deepseek-official/deepseek-v4-flash,deepseek-official/deepseek-v4-pro" && models.default === "deepseek-official/deepseek-v4-flash" && models.efforts.join() === "off,low,high,max", "its profile lists dsh's models and reasoning efforts");
  check(JSON.parse(fs.readFileSync(path.join(HOME, "cli", "dsh-models.json"), "utf8")).list.length === 2, "and keeps them for the next start");

  await post(`/api/sessions/${sid}/messages`, { text: "Headline: Write the README" });
  const titled = await until(async () => (await state()).sessions.find((x) => x.id === sid)?.title === "Write the README");
  check(titled && (await until(() => calls().find((c) => c.cmd === "tool")?.result?.content?.[0]?.text === "Thread updated.")), "an ab_post it calls sets its thread's headline");
  await said(sid, "Set the headline.");
  check(!(await get(`/api/sessions/${sid}/steps`)).steps?.some((x) => /ab_post/.test(x.tool || x.title || "")), "agentbook's own tools aren't steps: what they did shows anyway");

  // ---------- allowing what it asks ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Now delete the build folder" });
  const perm = await until(async () => (await state()).questions.find((q) => q.post === sid && q.kind === "permission" && !q.answered));
  check(perm?.preview === "rm -rf build" && perm.tool_name === "Terminal", "what it asks to do is an Allow/Deny prompt on the post, with the command");
  await post(`/api/questions/${perm.id}/answer`, { value: "allow" });
  const allowed = await until(() => calls().find((c) => c.cmd === "permission"));
  check(allowed?.outcome?.optionId === "allow-once" && (await said(sid, "Deleted the build folder.")), "allowing it lets it go ahead, once");

  // ---------- writing while it works, and stopping ----------
  await post(`/api/sessions/${sid}/messages`, { text: "Take a slow look at the logs" });
  check(await until(() => working(sid)), "while a turn runs, the post is working");
  await post(`/api/sessions/${sid}/messages`, { text: "Meanwhile, a note" });
  await sleep(600);
  check(!calls().some((c) => c.cmd === "busy") && !acp("session/prompt").some((c) => c.params.prompt.some((x) => x.text === "Meanwhile, a note")), "what you write while it works waits: dsh takes one prompt at a time");
  const stop = await post(`/api/sessions/${sid}/stop`);
  const cancelled = await until(() => acp("session/cancel")[0]);
  check(stop.status === 200 && cancelled?.params.sessionId === sid, "Stop cancels its turn");
  check(await said(sid, "Done: Meanwhile, a note"), "then what you wrote goes, as its next prompt");
  check(await until(async () => !(await working(sid))), "and the post rests once it's answered");

  // ---------- its model ----------
  const picked = await post(`/api/sessions/${sid}/model`, { model: "deepseek-official/deepseek-v4-pro" });
  await post(`/api/sessions/${sid}/messages`, { text: "On the bigger model" });
  await said(sid, "Done: On the bigger model");
  const set = acp("session/set_config_option").find((c) => c.params.sessionId === sid && c.params.configId === "model");
  const order = calls().findIndex((c) => c === set || (c.method === "session/set_config_option" && c.params.sessionId === sid)) < calls().findIndex((c) => c.method === "session/prompt" && c.params.prompt.some((x) => x.text === "On the bigger model"));
  check(picked.status === 200 && set?.params.value === JSON.stringify(["deepseek-official", "deepseek-v4-pro"]) && order, "a model you pick for it is set before its next prompt");
  check(await until(async () => !(await state()).sessions.find((x) => x.id === sid)?.model_pick && (await detail(sid)).model === "deepseek-v4-pro"), "then the pick is done, and the thread says its model");

  // ---------- a model and effort from the start; a failed turn ----------
  const second = await post("/api/launch", { prompt: "fail please", agent: "dsh", root: project, model: "deepseek-official/deepseek-v4-pro", effort: "max" });
  const sid2 = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === second.lid)?.id);
  const opts = acp("session/set_config_option").filter((c) => c.params.sessionId === sid2).map((c) => `${c.params.configId}=${c.params.value}`);
  check(opts.join() === `model=${JSON.stringify(["deepseek-official", "deepseek-v4-pro"])},reasoning_effort=max`, "one you start on a model and effort starts on them");
  check(await said(sid2, "DeepSeek stopped: no API key for deepseek-official"), "a turn dsh fails says why on the thread");
  check(await until(async () => !(await working(sid2))), "and the post rests");

  // ---------- its mode ----------
  check(RUNTIMES.dsh.caps.modes.join() === "ask,auto,plan,full", "DeepSeek's threads start in any of the four modes");
  const inMode = async (mode: string, prompt: string) => {
    const r = await post("/api/launch", { prompt, agent: "dsh", root: project, mode });
    const id = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === r.lid)?.id);
    if (!prompt.startsWith("Plan: ")) await said(id, `Done: ${prompt}`);
    return id;
  };
  const presetFor = (id: string) => calls().filter((c) => c.cmd === "preset" && c.sessionId === id).map((c) => c.preset).join();
  const full = await inMode("full", "Full speed");
  check(presetFor(full) === "danger-full-access", `Full access is dsh's danger-full-access: it never asks (${presetFor(full)})`);
  const careful = await inMode("ask", "Carefully");
  check(presetFor(careful) === "read-only", `Ask is dsh's read-only: each change asks (${presetFor(careful)})`);
  const planned = await inMode("plan", "Plan: Add a docs folder");
  check(presetFor(planned) === "workspace-write" && calls().some((c) => c.cmd === "plan" && c.sessionId === planned && c.active), "Plan is dsh's plan mode, on its default preset");
  const review = await until(async () => (await state()).questions.find((q) => q.post === planned && !q.answered && /Approve this plan/.test(q.title || "")));
  check(review?.options?.map((o) => o.label).join() === "Approve plan,Keep planning", `its plan's review is asked on the thread, as ACP has no one to ask with (${JSON.stringify(review?.options)})`);
  await post(`/api/questions/${review?.id}/answer`, { value: "Approve plan" });
  const reviewed = await until(() => calls().find((c) => c.cmd === "question" && c.sessionId === planned));
  check(reviewed?.answer?.answers?.[0]?.selected?.[0] === "Approve plan" && (await said(planned, "Plan approved: going ahead.")), "approving it there ends plan mode, and it goes ahead");

  // ---------- the model you picked in dsh's own apps ----------
  const patch = (profile, provider, model, effort) => {
    fs.mkdirSync(path.join(DSH_HOME, "profiles", profile), { recursive: true });
    fs.writeFileSync(path.join(DSH_HOME, "profiles", profile, "cordis.patch.yml"), `# Your patch layer\n- id: ui-settings-general\n  name: "x"\n  config:\n    welcomeNoticeVersion: 1\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${provider}\n    model: ${model}\n    reasoningEffort: ${effort}\n`);
  };
  patch("web", "deepseek-official", "deepseek-v4-pro", "low");
  check(await until(async () => (await state()).agents.find((a) => a.id === "dsh")?.models?.default === "deepseek-official/deepseek-v4-pro"), "the model you picked in dsh's web app is DeepSeek's default here too");
  const third = await post("/api/launch", { prompt: "On my default", agent: "dsh", root: project });
  const sid3 = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === third.lid)?.id);
  await said(sid3, "Done: On my default");
  const opts3 = acp("session/set_config_option").filter((c) => c.params.sessionId === sid3).map((c) => `${c.params.configId}=${c.params.value}`);
  check(opts3.join() === `model=${JSON.stringify(["deepseek-official", "deepseek-v4-pro"])},reasoning_effort=low`, "and a thread you start without picking one starts on it, with its effort");
  fs.writeFileSync(path.join(DSH_HOME, "profiles", "acp.yml"), ""); // not a profile
  patch("acp", "deepseek-official", "deepseek-v4-flash", "high");
  const fourth = await post("/api/launch", { prompt: "On the ACP default", agent: "dsh", root: project });
  const sid4 = await until(async () => (await state()).sessions.find((x) => x.agent === "dsh" && x.launch === fourth.lid)?.id);
  await said(sid4, "Done: On the ACP default");
  check(!acp("session/set_config_option").some((c) => c.params.sessionId === sid4), "unless dsh's ACP profile has a default of its own");

  // ---------- after a restart ----------
  const before = (await detail(sid)).messages.length;
  server.kill();
  await sleep(500);
  await startServer();
  await sleep(1000);
  const after = await detail(sid);
  check(after.messages?.length === before && after.effective !== "working", `a restart doesn't post its messages again (${before} → ${after.messages?.length})`);
  const restored = await get(`/api/sessions/${sid}/steps`);
  check(restored.steps?.some((x) => x.kind === "tool" && x.title === "Run rm -rf build" && x.done) && restored.steps.some((x) => x.kind === "say" && x.text === "Done: Add a README"), "its steps come back from its session's log");
  await post(`/api/sessions/${sid}/messages`, { text: "Rename: Ship the README" });
  const resumed = await until(() => acp("session/resume").find((c) => c.params.sessionId === sid));
  const retitled = await until(async () => (await state()).sessions.find((x) => x.id === sid)?.title === "Ship the README");
  check(resumed?.params.cwd === project && new globalThis.URL(resumed.params.mcpServers[0].url).searchParams.get("proc") === `dsh:${sid}` && retitled, "writing to it resumes its session, with agentbook's tools writing to its post");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
}
if (failures) console.log(`\nserver log:\n${serverLog.slice(-3000)}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
