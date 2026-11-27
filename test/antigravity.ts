#!/usr/bin/env node
// Antigravity through the whole server/CLI path, against test/fake-agy.ts: ACP, Auto mode, isolated Full access,
// Allow/Deny, agentbook's tools, models and thinking levels as config options, held messages, Stop, steps after a
// restart, loading a session again (its replay, when there's no transcript), a turn a restart cut off picked up
// again, and background tasks: going on between turns, the turn agy starts by itself when one ends, and one a restart
// cut off. The shapes are Antigravity CLI 1.5.13's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, freePort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { bookTool, CARRY_ON, createAntigravity, modelsOf, pickable, tasksCut, toolOf } from "../plugin/cli/runtimes/antigravity/antigravity.ts";
import { digestOf } from "../plugin/cli/runtimes/antigravity/log.ts";
import { effortsOf } from "../plugin/shared/api.ts";
import type { Json } from "./harness-types.ts";

let failures = 0;
function check(ok: unknown, label: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Longer than the quiet that ends a turn agy started by itself.
const QUIET_WAIT = 3500;
async function until<T>(fn: () => T | Promise<T>, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

// What it reads of ACP, on its own.
const grouped = modelsOf({ configOptions: [{ id: "m", category: "model", currentValue: "b", options: [{ group: "Gemini", options: [{ value: "a", name: "A" }] }, { group: "Claude", options: [{ value: "b" }] }] }] });
check(grouped?.list.map((m) => `${m.id}:${m.name}`).join() === "a:A,b:b" && grouped.default === "b" && grouped.option === "m" && !grouped.efforts, "grouped model options flatten, and the option's id is what a pick sets");
const state = modelsOf({ models: { currentModelId: "y", availableModels: [{ modelId: "x" }, { modelId: "y", name: "Why" }] } });
check(state?.list.length === 2 && state.default === "y" && state.option === null, "ACP's model state works too, picked with session/set_model");
check(modelsOf({}) === null && modelsOf(null) === null, "a session that says no models leaves the kept list as it was");
const kept = { list: [{ id: "gemini-4-neon", name: "Gemini 4 Neon" }, { id: "claude-opus-5-5", name: "Claude Opus 5.5" }], default: "gemini-4-neon", efforts: ["low", "medium", "high", "xhigh"], effort: "high" };
check(effortsOf(kept, "claude-opus-5-5").efforts.join() === "low,medium,high,xhigh" && effortsOf(kept, "gemini-4-neon").effort === "high", "the composer's effort menu has agy's thinking levels whatever the model: they're the session's, not a model's");
check(effortsOf({ list: [{ id: "a", name: "A", efforts: [] }], efforts: ["low", "high"], effort: "high" }, "a").efforts.length === 0, "a model that lists no levels of its own (one of Codex's) takes none");
check(bookTool({ title: "agentbook: ab_post" }) === "ab_post" && bookTool({ title: "mcp_agentbook_ab_ask" }) === "ab_ask" && bookTool({ title: "ab_post", _meta: { server: "agentbook" } }) === "ab_post", "agentbook's tools are known by their name and server");
check(!bookTool({ title: "ab_post" }) && !bookTool({ title: "other-server: ab_post" }) && !bookTool({ title: "Read agentbook/README.md" }), "a tool of the same name from another server, or a file of agentbook's, isn't");
check(toolOf({ title: "agentbook: ab_thread_read", kind: "other" }).quiet === false && toolOf({ title: "agentbook: ab_post", kind: "other" }).quiet === true, "agentbook's tools stay off the steps, but for those that read other threads");
check(bookTool({ name: "mcp_agentbook_ab_post", title: "Run mcp_agentbook_ab_post", kind: "other" }) === "ab_post" && !bookTool({ name: "mcp_other_ab_post", title: "Run mcp_other_ab_post" }), "as agy 1.5.13 names them: mcp_agentbook_ab_post");
const run = toolOf({ name: "run_command", kind: "execute", title: "ls -la", rawInput: { CommandLine: "ls -la", WaitMsBeforeAsync: 5000, toolSummary: "List folder files" } });
check(run.name === "Bash" && run.args.command === "ls -la", "agy's run_command is a command step, from its CommandLine");
const edit = toolOf({ kind: "edit", title: "Edit a.md", content: [{ type: "diff", path: "/x/a.md", oldText: "1", newText: "2" }] });
check(edit.name === "Edit" && edit.args.file_path === "/x/a.md" && edit.args.new_string === "2", "an edit with only a diff becomes an Edit step with its before and after");

// agy's transcript, as 1.5.13 writes it: a turn's request, the model's tool calls (arguments JSON-encoded), their
// outputs in order, then its reply. Its thinking, and agentbook's own tools, stay off the steps.
const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
const told = digestOf([
  { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nList the files\n</USER_REQUEST>" },
  { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-high", thinking: "Private reasoning.", tool_calls: [{ name: "run_command", args: enc({ CommandLine: "ls -la", toolSummary: "List folder files" }) }, { name: "mcp_agentbook_ab_post", args: enc({ title: "Dry run" }) }] },
  { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "README.md notes.txt" },
  { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", content: "Thread updated." },
  { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-high", content: "Two files." },
  { step_index: 5, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: "Not the person's." },
].map((r, i) => ({ ...r, created_at: `2026-11-20T15:09:${String(10 + i).padStart(2, "0")}Z` })), "/x");
check(told.turn === 1 && told.model === "gemini-4-neon-high" && told.steps.map((x) => x.kind === "tool" ? x.title : x.text).join("|") === "Run ls -la|Two files.", "agy's transcript is the thread's steps: its commands and replies, not its thinking or agentbook's tools");
check(told.steps[0].done && !told.steps[0].error, "a call's output, in order after it, finishes its step");

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-agy-")));
const vars = ["AGENTBOOK_HOME", "AGENTBOOK_AGY", "AGENTBOOK_AGY_BIN"];
const was = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
try {
  process.env.AGENTBOOK_HOME = tmp;
  process.env.AGENTBOOK_AGY_BIN = path.join(tmp, "not-installed");
  process.env.AGENTBOOK_AGY = "1";
  const missing = createAntigravity().row();
  check(pickable(kept.list, "claude-opus-5-5-high") === "claude-opus-5-5" && pickable(kept.list, "gemini-4-neon") === "gemini-4-neon" && pickable(kept.list, "gpt-9") === null, "a model agy's transcript names with its thinking level is the picker's model");
  check(missing.status === "Not found" && /brew install --cask antigravity-cli/.test(missing.detail), "without agy, its row says how to install it");
  process.env.AGENTBOOK_AGY = "0";
  check(createAntigravity().row().status === "Off", "AGENTBOOK_AGY=0 leaves it off");
} finally {
  for (const k of vars)
    if (was[k] === undefined) delete process.env[k];
    else process.env[k] = was[k];
}
const project = path.join(tmp, "dev", "app");
const bare = path.join(tmp, "dev", "no-transcript");
const fake = path.join(tmp, "fake");
for (const dir of [project, bare, fake, path.join(tmp, "cli")]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(bare, "README.md"), "before\n");
fs.writeFileSync(path.join(project, "README.md"), "before\n");
fs.writeFileSync(path.join(tmp, "cli", "gate.json"), JSON.stringify({ folders: [path.join(tmp, "dev")], starts_per_hour: 1000 }));
const port = await freePort(4660);
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTBOOK_HOME: tmp, AGENTBOOK_PORT: String(port), AGENTBOOK_AGY: "1", AGENTBOOK_AGY_BIN: path.join(here, "fake-agy.ts"), AGENTBOOK_AGY_DATA: path.join(tmp, "agy-data"), FAKE_AGY_DIR: fake, AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_DSH: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR"]) delete env[k];
const calls = () => (fs.existsSync(path.join(fake, "calls.jsonl")) ? fs.readFileSync(path.join(fake, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x)) : []);
const acp = (method: string) => calls().filter((c) => c.method === method);
let cookie = "";
const req = (p: string, opts: RequestInit = {}) => fetch(url + p, { ...opts, headers: { ...opts.headers, ...(cookie ? { cookie } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const post = async (p: string, body: unknown = {}) => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json()) as Json) };
};
const all = () => stateOf(get);
const detail = (id: string) => get(`/api/sessions/${id}`);
const steps = async (id: string) => (await get(`/api/sessions/${id}/steps`)).steps || [];
const said = (id: string, text: string) => until(async () => (await detail(id)).messages?.find((m) => m.from === "agent" && m.text === text));
const send = (id: string, text: string) => post(`/api/sessions/${id}/messages`, { text });
const idle = (id: string) => until(async () => (await all()).sessions.find((s) => s.id === id)?.effective !== "working");
const open = (id: string) => until(async () => (await all()).questions.find((q) => q.post === id && !q.answered));
let server;
let serverLog = "";
try {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (d) => (serverLog += d));
  await until(async () => fetch(url + "/api/health").then((r) => r.ok).catch(() => false));
  const setup = await req("/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  cookie = (setup.headers.get("set-cookie") || "").split(";")[0];
  const agent = await until(async () => (await all()).agents.find((a) => a.id === "antigravity"));
  const row = (await get("/api/runtimes")).runtimes.find((r) => r.kind === "antigravity");
  check(agent?.kind === "antigravity" && agent.name === "Antigravity" && row?.ok && row.status === "Ready", "with agy on the PATH, Antigravity is a profile and a Ready row on Settings → Agents");
  check(acp("initialize").length === 0, "agy acp starts only once a thread needs it");

  const launched = await post("/api/launch", { agent: "antigravity", root: project, prompt: "Read the files" });
  const id = await until(async () => (await all()).sessions.find((s) => s.launch === launched.lid)?.id);
  check(launched.status === 200 && (await said(id, "Done: Read the files")), "posting on Antigravity's wall starts a session, and its reply is what it said, whitespace chunks and all");
  const autoAt = calls().findIndex((c) => c.method === "session/set_config_option" && c.params.configId === "mode" && c.params.value === "auto");
  check(autoAt >= 0 && autoAt < calls().findIndex((c) => c.method === "session/prompt") && !(await all()).questions.some((q) => q.post === id), "its session goes into agy's Auto mode before the first prompt, so a safe command runs without asking");
  check(calls().filter((c) => c.cmd === "started").length === 1 && calls().some((c) => c.cmd === "started" && c.args.join() === "acp"), "Auto starts only the unflagged agy acp process");
  const made = acp("session/new")[0]?.params;
  const mcp = made?.mcpServers?.[0];
  check(made?.cwd === project && mcp?.type === "http" && new URL(mcp.url).searchParams.get("proc") === `launch:${launched.lid}`, "its session works in the folder picked, with agentbook's tools at its address");
  const first = acp("session/prompt")[0]?.params.prompt;
  check(first?.[0].text === "Read the files" && /agentbook/.test(first?.[1]?.text) && (await detail(id)).messages.filter((m) => m.text === "Read the files").length === 1, "the first prompt carries agentbook's context after it, and shows once on the thread");
  const shown = await steps(id);
  check(shown.some((s) => s.kind === "tool" && s.title === "Run ls" && s.done) && !shown.some((s) => /Private reasoning/.test(s.text || "")), "its tool calls are steps, done once they finish; its thoughts aren't");
  check((await detail(id)).ai_title === "Reading the files" || (await detail(id)).title === "Reading the files", "the title agy gives the session is the thread's");
  const listed = await until(async () => (await all()).agents.find((a) => a.id === "antigravity")?.models);
  check(listed?.list?.map((m) => m.id).join() === "gemini-4-neon-medium,gemini-4-neon-high,claude-sonnet-5-5" && listed.efforts?.join() === "low,medium,high" && fs.existsSync(path.join(tmp, "cli", "antigravity-models.json")), "its models and thinking levels are the picker's, kept for the next start");

  await send(id, "Headline: Antigravity is connected");
  check((await said(id, "Set the headline.")) && (await until(async () => (await detail(id)).title === "Antigravity is connected")), "a real ab_post call through agentbook's tools sets the headline");
  check(calls().some((c) => c.cmd === "permission" && c.tool === "ab_post" && c.outcome?.optionId === "allow") && !(await all()).questions.some((q) => q.post === id && /ab_post/.test(`${q.detail} ${q.preview}`)), "agy's ask before agentbook's own tool is allowed without asking the person");
  check(!(await steps(id)).some((s) => /ab_post/.test(`${s.tool || ""} ${s.title || ""}`)), "agentbook's own tools stay off the steps");

  await send(id, "delete the build folder");
  const ask = await open(id);
  check(ask?.tool_name === "Terminal" && ask.preview === "rm -rf build", "a command it asks to run is Allow/Deny on the thread, showing the command");
  await post(`/api/questions/${ask.id}/answer`, { value: "allow" });
  check((await said(id, "Done: delete the build folder")) && calls().some((c) => c.cmd === "permission" && c.outcome?.optionId === "allow"), "Allow picks agy's allow-once option, and the turn goes on");
  await send(id, "edit the README");
  check((await said(id, "Done: edit the README")) && !(await all()).questions.some((q) => q.post === id && !q.answered), "in Auto, an edit in the folder goes ahead without asking");
  await send(id, "edit a file outside the folder");
  const editAsk = await open(id);
  check(editAsk?.preview.includes("OUTSIDE.md") && editAsk.preview.includes("before") && editAsk.preview.includes("after"), "an edit it asks to make shows the file, before and after");
  await post(`/api/questions/${editAsk.id}/answer`, { value: "deny" });
  check((await said(id, "Left it alone.")) && calls().some((c) => c.cmd === "permission" && c.outcome?.optionId === "reject"), "Deny picks its reject-once option");

  await send(id, "slow investigation");
  await until(async () => (await all()).sessions.find((s) => s.id === id)?.effective === "working");
  await send(id, "Meanwhile, a note");
  await sleep(400);
  check(!acp("session/prompt").some((c) => c.params.prompt[0].text === "Meanwhile, a note") && !calls().some((c) => c.cmd === "busy"), "what you write while it works waits for its turn to end");
  await post(`/api/sessions/${id}/stop`);
  check((await said(id, "Done: Meanwhile, a note")) && acp("session/cancel").some((c) => c.params.sessionId === id), "Stop cancels the turn, and what waited goes then");

  await idle(id);
  await post(`/api/sessions/${id}/model`, { model: "claude-sonnet-5-5" });
  await send(id, "Use another model");
  await said(id, "Done: Use another model");
  const setAt = calls().findIndex((c) => c.method === "session/set_config_option" && c.params.configId === "model" && c.params.value === "claude-sonnet-5-5");
  const promptAt = calls().findIndex((c) => c.method === "session/prompt" && c.params.prompt[0].text === "Use another model");
  check(setAt >= 0 && setAt < promptAt && (await detail(id)).model === "claude-sonnet-5-5", "a model picked for the thread is set (as its config option) before the next prompt, and the thread says it");
  const toPlan = await post(`/api/sessions/${id}/mode`, { mode: "plan" });
  const planned = (await all()).sessions.find((s) => s.id === id);
  check(toPlan.status === 200 && acp("session/set_config_option").some((c) => c.params.sessionId === id && c.params.configId === "mode" && c.params.value === "plan") && planned?.mode === "plan" && !planned.mode_pick, "its mode switches at once, in the session agy has open");
  await post(`/api/sessions/${id}/mode`, { mode: "auto" });
  check((await all()).sessions.find((s) => s.id === id)?.mode === "auto", "and back");
  const fullLaunch = await post("/api/launch", { agent: "antigravity", root: project, prompt: "delete the build in Full access", mode: "full" });
  const fullId = await until(async () => (await all()).sessions.find((s) => s.launch === fullLaunch.lid)?.id);
  check(fullLaunch.status === 200 && (await said(fullId, "Done: delete the build in Full access")) && !(await all()).questions.some((q) => q.post === fullId), "Full access starts a thread that runs commands without a permission prompt");
  const fullPid = acp("session/prompt").find((c) => c.params.sessionId === fullId)?.pid;
  check(fullPid && fullPid !== acp("session/prompt")[0].pid && calls().some((c) => c.cmd === "started" && c.pid === fullPid && c.args.join() === "acp,--dangerously-skip-permissions"), "Full access gets its own agy process; Ask, Auto and Plan never inherit its skip-permissions flag");
  await send(fullId, "edit a file outside the folder in Full access");
  check((await said(fullId, "Done: edit a file outside the folder in Full access")) && !(await all()).questions.some((q) => q.post === fullId) && !acp("session/set_config_option").some((c) => c.params.sessionId === fullId && c.params.configId === "mode" && c.params.value === "auto"), "Full access also permits outside-folder edits and doesn't turn Auto's sandbox on");
  const picked = await post("/api/launch", { agent: "antigravity", root: bare, prompt: "Picked from the start", model: "gemini-4-neon-high", effort: "high", mode: "plan" });
  const second = await until(async () => (await all()).sessions.find((s) => s.launch === picked.lid)?.id);
  const set = acp("session/set_config_option").filter((c) => c.params.sessionId === second);
  check((await said(second, "Done: Picked from the start")) && set.some((c) => c.params.configId === "model" && c.params.value === "gemini-4-neon-high") && set.some((c) => c.params.configId === "thought_level" && c.params.value === "high"), "a model and thinking level picked as a thread starts are set before its first prompt");
  check(set.some((c) => c.params.configId === "mode" && c.params.value === "plan") && !set.some((c) => c.params.configId === "mode" && c.params.value === "auto") && (await all()).sessions.find((s) => s.id === second)?.mode === "plan", "so is the mode picked (Plan), and the thread keeps it");

  await idle(id);
  const before = (await detail(id)).messages.length;
  await server.restart("agentbook-cli");
  const after = await until(async () => {
    const d = await detail(id);
    return d.messages?.length === before && d;
  });
  check(after?.messages.length === before, "a restart leaves the thread's conversation as it was");
  const restored = await steps(id);
  check(restored.some((s) => s.title === "Run rm -rf build" && s.done) && restored.some((s) => s.title === "Run ls" && s.done) && !restored.some((s) => /ab_post/.test(`${s.tool || ""} ${s.title || ""}`)) && !acp("session/load").length, "after a restart, agy's transcript is the thread's steps, without starting agy");
  check(!(await steps(second)).length, "a session with no transcript has no steps after a restart, until it's loaded");
  await idle(second);
  const savedSecond = path.join(fake, `session-${second}.json`);
  fs.writeFileSync(savedSecond, JSON.stringify({ ...JSON.parse(fs.readFileSync(savedSecond, "utf8")), mode: "default", model: "gemini-4-neon-medium" }));
  await send(second, "Load me again");
  check((await said(second, "Done: Load me again")) && (await steps(second)).some((s) => s.title === "Run ls" && s.done), "loading it, what agy replays is its steps again");
  const secondLoadAt = calls().findIndex((c) => c.method === "session/load" && c.params.sessionId === second);
  check(calls().some((c, i) => i > secondLoadAt && c.method === "session/set_config_option" && c.params.sessionId === second && c.params.configId === "mode" && c.params.value === "plan"), "a thread started in Plan goes back into Plan when agy loads it in Default");
  check(calls().some((c, i) => i > secondLoadAt && c.method === "session/set_config_option" && c.params.sessionId === second && c.params.configId === "model" && c.params.value === "gemini-4-neon-high") && (await detail(second)).model === "gemini-4-neon-high", "and back on the model it had, when agy loads it on another");
  const savedSession = path.join(fake, `session-${id}.json`);
  fs.writeFileSync(savedSession, JSON.stringify({ ...JSON.parse(fs.readFileSync(savedSession, "utf8")), mode: "default" }));
  await send(id, "Go on after the restart");
  check(await said(id, "Done: Go on after the restart"), "writing after a restart loads the same session and goes on");
  const loadAt = calls().findIndex((c) => c.method === "session/load" && c.params.sessionId === id);
  check(calls().some((c, i) => i > loadAt && c.method === "session/set_config_option" && c.params.sessionId === id && c.params.configId === "mode" && c.params.value === "auto"), "a session that loads in Default (one from before agentbook set Auto) goes into Auto again");
  const loaded = acp("session/load").find((c) => c.params.sessionId === id)?.params;
  check(loaded?.cwd === project && new URL(loaded.mcpServers[0].url).searchParams.get("proc") === `agy:${id}`, "loading it gives it agentbook's tools again, for its thread");
  check((await steps(id)).filter((s) => s.title === "Run rm -rf build").length === 1, "loading a session whose steps came from its transcript doesn't add its replay to them");
  check((await detail(id)).messages.filter((m) => m.text === "Done: Read the files").length === 1, "and its replayed replies aren't said on the thread twice");
  check((await detail(id)).model === "claude-sonnet-5-5" && !acp("session/set_config_option").some((c, i, a) => i > a.findIndex((x) => x.params.value === "claude-sonnet-5-5") && c.params.sessionId === id && c.params.configId === "model"), "the session comes back on the model it had, without setting it again");

  await send(fullId, "delete the build in Full access after restart");
  const fullRestarted = await said(fullId, "Done: delete the build in Full access after restart");
  const fullLoaded = acp("session/load").find((c) => c.params.sessionId === fullId);
  check(fullRestarted && (await all()).sessions.find((s) => s.id === fullId)?.mode === "full" && calls().some((c) => c.cmd === "started" && c.pid === fullLoaded?.pid && c.args.includes("--dangerously-skip-permissions")) && !(await all()).questions.some((q) => q.post === fullId), "a Full access thread keeps its mode and loads into the flagged process after a restart");
  await send(fullId, "slow Full access investigation");
  await until(() => acp("session/prompt").some((c) => c.params.sessionId === fullId && c.params.prompt[0].text === "slow Full access investigation"));
  await post(`/api/sessions/${fullId}/stop`);
  check((await idle(fullId)) && acp("session/cancel").some((c) => c.params.sessionId === fullId && c.pid === fullLoaded?.pid), "Stop reaches the Full access process and ends its turn");

  // A model picked for a thread is what it says it runs on as soon as its turn starts on it, not once that turn ends.
  await post(`/api/sessions/${fullId}/model`, { model: "claude-sonnet-5-5" });
  await send(fullId, "slow investigation on another model");
  await until(() => acp("session/prompt").some((c) => c.params.sessionId === fullId && c.params.prompt[0].text === "slow investigation on another model"));
  const onIt = await until(async () => (await all()).sessions.find((s) => s.id === fullId && s.model === "claude-sonnet-5-5"), 3000).catch(() => null);
  check(onIt?.busy && !onIt.model_pick, "a model picked for a thread is the one it says it's on while the turn runs on it");
  await post(`/api/sessions/${fullId}/stop`);
  await idle(fullId);

  // Into Full access and out of it: the thread's session moves between the two agy processes, between its turns.
  const guardedPid = acp("session/prompt").filter((c) => c.params.sessionId === id).at(-1)?.pid;
  await send(id, "edit a file outside the folder, then move");
  const asked = await open(id);
  const toFull = await post(`/api/sessions/${id}/mode`, { mode: "full" });
  const moving = (await all()).sessions.find((s) => s.id === id);
  check(toFull.status === 200 && moving?.mode === "auto" && moving.mode_pick === "full", "Full access picked while its turn runs waits for that turn");
  check((await said(id, "Done: edit a file outside the folder, then move")) && (await all()).questions.find((q) => q.id === asked?.id)?.by === "mode", "and what it asked meanwhile is allowed, as Full access would");
  const moved = await until(async () => (await all()).sessions.find((s) => s.id === id && s.mode === "full" && !s.mode_pick), 5000).catch(() => null);
  check(moved && acp("session/close").some((c) => c.params.sessionId === id && c.pid === guardedPid), "it moves as the turn ends, not at its next prompt: no pick left waiting, and its session closed in the guarded agy");
  await send(id, "edit a file outside the folder in its new Full access");
  check(await said(id, "Done: edit a file outside the folder in its new Full access"), "its next prompt goes");
  const fullPrompt = acp("session/prompt").filter((c) => c.params.sessionId === id).at(-1);
  check(fullPrompt?.pid === fullLoaded?.pid && !(await all()).questions.some((q) => q.post === id && !q.answered), "in the flagged agy, where an edit outside the folder doesn't ask");
  const toAuto = await post(`/api/sessions/${id}/mode`, { mode: "auto" });
  check(toAuto.status === 200 && (await all()).sessions.find((s) => s.id === id)?.mode === "auto" && acp("session/close").some((c) => c.params.sessionId === id && c.pid === fullLoaded?.pid), "an idle thread moves out of Full access at once");
  await send(id, "edit a file outside the folder back in Auto");
  const backAsk = await open(id);
  const autoPrompt = acp("session/prompt").filter((c) => c.params.sessionId === id).at(-1);
  check(backAsk && autoPrompt?.pid === guardedPid && acp("session/set_config_option").some((c) => c.params.sessionId === id && c.pid === guardedPid && c.params.configId === "mode" && c.params.value === "auto"), "and its next prompt is back in the guarded agy, in Auto, which asks again");
  await post(`/api/questions/${backAsk.id}/answer`, { value: "deny" });
  await idle(id);

  await send(id, "fail this turn");
  check((await said(id, "Antigravity stopped: Upstream unavailable")) && (await idle(id)), "a turn that fails says why and leaves the thread idle");
  fs.writeFileSync(path.join(fake, "needs-auth"), "1");
  const noAuth = await post("/api/launch", { agent: "antigravity", root: project, prompt: "Needs sign-in" });
  check(noAuth.status === 500 && /Run agy in a terminal and sign in/.test(noAuth.error || ""), "without a sign-in, starting a thread says how to sign in");
  fs.unlinkSync(path.join(fake, "needs-auth"));

  await send(id, "crash this process");
  check((await said(id, "Antigravity stopped: Antigravity's ACP server stopped: Antigravity test process crashed")) && (await idle(id)), "when agy stops mid-turn, the turn ends saying why");
  await send(id, "Recover after the crash");
  check(await said(id, "Done: Recover after the crash"), "the next message starts agy again and loads the session");
  check((await steps(id)).filter((s) => s.title === "Run rm -rf build").length === 1, "loading it again then doesn't repeat the steps already shown");

  await send(id, "edit a file outside the folder while Full access runs");
  const guardedAsk = await open(id);
  await send(fullId, "crash the Full access process");
  check((await said(fullId, "Antigravity stopped: Antigravity's ACP server stopped: Antigravity test process crashed")) && (await idle(fullId)) && (await all()).questions.some((q) => q.id === guardedAsk?.id && !q.answered), "Auto still asks while Full access exists, and a Full access crash leaves Auto's pending permission intact");
  await post(`/api/questions/${guardedAsk.id}/answer`, { value: "allow" });
  check(await said(id, "Done: edit a file outside the folder while Full access runs"), "Allow still reaches the guarded process after the Full access process crashes");
  await send(fullId, "edit a file outside the folder after the crash");
  const fullRecovered = await said(fullId, "Done: edit a file outside the folder after the crash");
  const recoveredFull = acp("session/load").filter((c) => c.params.sessionId === fullId).at(-1);
  check(fullRecovered && recoveredFull?.pid !== fullLoaded?.pid && calls().some((c) => c.cmd === "started" && c.pid === recoveredFull?.pid && c.args.includes("--dangerously-skip-permissions")) && !(await all()).questions.some((q) => q.post === fullId), "recovering a crashed Full access process keeps the session unrestricted and separate");

  // agentbook restarting mid-turn (a commit's self-reload) stops agy with it, as its child.
  await send(id, "delete the build folder again");
  const cut = await open(id);
  const loadsBefore = acp("session/load").filter((c) => c.params.sessionId === id).length;
  await server.restart("agentbook-cli");
  check(await until(async () => (await all()).questions.find((q) => q.id === cut?.id)?.by === "gone"), "an Allow/Deny the restart cut off is closed, as the agy that asked it is gone");
  check((await said(id, `Done: ${CARRY_ON}`)) && acp("session/load").filter((c) => c.params.sessionId === id).length > loadsBefore, "a turn the restart cut off is picked up by itself: its session loads again and agy is told to carry on");
  check((await idle(id)) && !(await detail(id)).messages.some((m) => /stopped when agentbook restarted/.test(m.text || "")) && !(await all()).questions.some((q) => q.post === id && !q.answered), "then the thread ends its turn as any other, with nothing left asking");

  // A command agy leaves running as a background task, and the turn it starts by itself when that ends.
  const thread = async () => (await all()).sessions.find((s) => s.id === id);
  await send(id, "background build until built");
  await said(id, "Started the build in the background.");
  const between = await until(async () => {
    const s = await thread();
    return !s?.busy && s?.going?.length && s;
  });
  check(between?.effective === "working" && between.going[0].title === "npm run build" && between.going[0].kind === "shell", "a command agy left running in the background keeps its thread working once the turn ends, listed as going on");
  check(JSON.parse(fs.readFileSync(path.join(tmp, "cli", "antigravity-going.json"), "utf8"))[id]?.[0]?.title === "npm run build", "and it's kept on disk, for a restart to know agy lost it");
  const prompts = acp("session/prompt").length;
  fs.writeFileSync(path.join(fake, "built"), "");
  check(await until(async () => (await thread())?.busy), "when it ends, agy carrying on by itself makes a turn of its own on the thread");
  check((await said(id, "The build finished: dist/app.js.")) && acp("session/prompt").length === prompts, "what agy says then is its reply on the thread, with no prompt of agentbook's");
  const woke = await steps(id);
  check(woke.some((s) => s.title === "Run npm run build" && s.done && !s.error) && woke.some((s) => s.title === "Run ls dist" && s.done), "the background command's step is done, and what agy did after waking is steps too");
  const quiet = await until(async () => {
    const s = await thread();
    return !s?.busy && s?.effective === "idle" && s;
  });
  check(quiet && !quiet.going?.length && !JSON.parse(fs.readFileSync(path.join(tmp, "cli", "antigravity-going.json"), "utf8"))[id], "then the thread is idle, with nothing going on");

  await send(id, "background slow build until slow-built");
  await until(async () => !(await thread())?.busy && (await thread())?.going?.length);
  fs.writeFileSync(path.join(fake, "slow-built"), "");
  await until(async () => (await steps(id)).some((s) => s.title === "Run npm test"));
  const cancels = acp("session/cancel").length;
  await post(`/api/sessions/${id}/stop`);
  check((await idle(id)) && acp("session/cancel").length > cancels, "Stop cancels a turn agy started by itself, and the thread is idle");
  await sleep(QUIET_WAIT);
  const stopped = await thread();
  check(stopped?.effective === "idle" && !stopped.busy && !stopped.going?.length && (await steps(id)).find((s) => s.title === "Run npm test")?.error, "the command it cancelled fails, and nothing starts another turn or stays going");

  await send(id, "background build until never");
  await until(async () => !(await thread())?.busy && (await thread())?.going?.length);
  await server.restart("agentbook-cli");
  check(await said(id, `Done: ${tasksCut(["npm run build"])}`), "a restart, which stops agy and its background tasks, picks the thread up by itself, telling agy it won't hear from that task");
  check(await idle(id), "and then the thread ends that turn as any other");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
}
if (failures) console.log(`server log:\n${serverLog.slice(-4000)}`);
console.log(failures ? `${failures} checks failed (data: ${tmp})` : "All Antigravity checks passed");
process.exit(failures ? 1 : 0);
