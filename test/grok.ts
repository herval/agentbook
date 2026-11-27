#!/usr/bin/env node
// Grok through the whole server/CLI path, against test/fake-grok.ts: ACP, its modes (Ask, Auto, Full access) switched
// at once in the session grok has open, Allow/Deny, agentbook's tools, models with their own effort levels, slash
// commands, held messages, Stop, steps after a restart (from grok's updates.jsonl), loading a session again (its
// replay, when there's no log), a turn a restart cut off picked up again, background tasks and the turn grok starts by
// itself when one ends, signing in to x.ai with a device code, and updating grok. The shapes are grok 1.0.89's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, freePort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { CARRY_ON, tasksCut } from "../plugin/cli/runtimes/kit/acp.ts";
import { commandsOf, createGrok, modelsOf } from "../plugin/cli/runtimes/grok/grok.ts";
import { bookTool, outputOf, toolOf } from "../plugin/cli/runtimes/grok/tools.ts";
import { effortsOf } from "../plugin/shared/api.ts";
import type { Json } from "./harness-types.ts";

let failures = 0;
function check(ok: unknown, label: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

// What it reads of ACP, on its own.
const levels = (list: string[], def: string) => list.map((value) => ({ id: value, value, default: value === def }));
const answered = modelsOf({
  models: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7", _meta: { supportsReasoningEffort: true, reasoningEfforts: levels(["xhigh", "high", "low"], "high") } }, { modelId: "fast", name: "Fast", _meta: { supportsReasoningEffort: false } }, { modelId: "grok-4.5", _meta: { reasoningEfforts: levels(["high", "low"], "low") } }] },
  configOptions: [{ id: "model", category: "model", currentValue: "grok-4.7", options: [{ value: "grok-4.7", name: "Grok 4.7" }, { value: "fast", name: "Fast" }, { value: "grok-4.5", name: "Grok 4.5" }] }, { id: "reasoning_effort", category: "thought_level", currentValue: "low", options: [{ value: "xhigh" }, { value: "high" }, { value: "low" }] }],
});
check(answered?.option === "model" && answered.effortOption === "reasoning_effort" && answered.default === "grok-4.7" && answered.effort === "low", "a session's model and effort are its config options, and their ids are what a pick sets");
const picker = answered as Parameters<typeof effortsOf>[0];
check(effortsOf(picker, "grok-4.7").efforts.join() === "xhigh,high,low" && effortsOf(picker, "grok-4.5").efforts.join() === "high,low" && effortsOf(picker, "fast").efforts.length === 0, "each model has its own effort levels: Grok 4.7 has xhigh, 4.5 doesn't, and one without reasoning has none");
check(modelsOf({}) === null && modelsOf(null) === null, "a session that says no models leaves the kept list as it was");
const cmds = commandsOf([{ name: "compact", description: "Compress", input: null }, { name: "deep-research", input: { hint: "<query>" } }, { name: "review", input: { hint: "[focus]" } }, { name: "always-approve", input: { hint: "on|off" } }, { name: "bad name" }]);
check(cmds.list.map((c) => `${c.name}:${c.takes}`).join() === "compact:,deep-research:req,review:opt" && cmds.off[0]?.name === "always-approve" && /Full access/.test(cmds.off[0].why), "its slash commands say what they take, and always-approve is left to agentbook's own mode");
const ls = toolOf({ title: "run_terminal_command", rawInput: { command: "ls -a", description: "List" }, _meta: { "x.ai/tool": { name: "run_terminal_command" } } });
check(ls.name === "Bash" && ls.args.command === "ls -a" && !ls.quiet, "grok's run_terminal_command is a command step");
const wrote = toolOf({ title: "write", rawInput: { file_path: "/x/a.md", content: "hi" }, _meta: { "x.ai/tool": { name: "write" } } });
const edited = toolOf({ title: "search_replace", rawInput: { file_path: "/x/a.md", old_string: "1", new_string: "2" } });
check(wrote.name === "Write" && wrote.args.file_path === "/x/a.md" && edited.name === "Edit" && edited.args.new_string === "2", "its write and search_replace are Write and Edit steps");
const post = { title: "use_tool", rawInput: { tool_name: "agentbook__ab_post", tool_input: { title: "Hi" } }, _meta: { "x.ai/tool": { name: "use_tool" } } };
check(bookTool(post) === "ab_post" && toolOf(post).quiet && !toolOf({ title: "use_tool", rawInput: { tool_name: "agentbook__ab_thread_read", tool_input: {} } }).quiet, "agentbook's tools, called through its use_tool, stay off the steps, but for those that read other threads");
const other = toolOf({ title: "use_tool", rawInput: { tool_name: "linear__save_issue", tool_input: { title: "Bug" } } });
check(other.name === "mcp__linear__save_issue" && other.args.title === "Bug" && !bookTool({ title: "use_tool", rawInput: { tool_name: "other__ab_post" } }), "another server's tool is that server's, by grok's server__tool name");
check(toolOf({ title: "search_tool", rawInput: { query: "x" } }).quiet, "finding a tool to call isn't a step");
check(outputOf({ content: [{ type: "content", content: { type: "text", text: "\u001b[1m\u001b[36m.\u001b[39;49m\u001b[0m\nhello.txt\n" } }] }) === ".\nhello.txt\n", "a command's output loses its colors");

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-grok-")));
const vars = ["AGENTBOOK_HOME", "AGENTBOOK_GROK", "AGENTBOOK_GROK_BIN"];
const was = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
try {
  process.env.AGENTBOOK_HOME = tmp;
  process.env.AGENTBOOK_GROK_BIN = path.join(tmp, "not-installed");
  process.env.AGENTBOOK_GROK = "1";
  const missing = createGrok().row();
  check(missing.status === "Not found" && /x\.ai\/cli\/install\.sh/.test(missing.detail), "without grok, its row says how to install it");
  process.env.AGENTBOOK_GROK = "0";
  check(createGrok().row().status === "Off", "AGENTBOOK_GROK=0 leaves it off");
} finally {
  for (const k of vars)
    if (was[k] === undefined) delete process.env[k];
    else process.env[k] = was[k];
}

const project = path.join(tmp, "dev", "app");
const bare = path.join(tmp, "dev", "no-log");
const fake = path.join(tmp, "fake");
const grokHome = path.join(tmp, "grok-home");
for (const dir of [project, bare, fake, grokHome, path.join(tmp, "cli")]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(grokHome, "auth.json"), "{}");
fs.writeFileSync(path.join(fake, "latest"), "1.0.95");
fs.writeFileSync(path.join(tmp, "cli", "gate.json"), JSON.stringify({ folders: [path.join(tmp, "dev")], starts_per_hour: 1000 }));
const port = await freePort(4680);
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTBOOK_HOME: tmp, AGENTBOOK_PORT: String(port), AGENTBOOK_GROK: "1", AGENTBOOK_GROK_BIN: path.join(here, "fake-grok.ts"), GROK_HOME: grokHome, FAKE_GROK_DIR: fake, AGENTBOOK_AGY: "0", AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_DSH: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR", "XAI_API_KEY"]) delete env[k];
const calls = () => (fs.existsSync(path.join(fake, "calls.jsonl")) ? fs.readFileSync(path.join(fake, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x)) : []);
const acp = (method: string) => calls().filter((c) => c.method === method);
let cookie = "";
const req = (p: string, opts: RequestInit = {}) => fetch(url + p, { ...opts, headers: { ...opts.headers, ...(cookie ? { cookie } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const send = async (p: string, body: unknown = {}) => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json()) as Json) };
};
const all = () => stateOf(get);
const detail = (id: string) => get(`/api/sessions/${id}`);
const steps = async (id: string) => (await get(`/api/sessions/${id}/steps`)).steps || [];
const said = (id: string, text: string) => until(async () => (await detail(id)).messages?.find((m) => m.from === "agent" && m.text === text));
const write = (id: string, text: string, extra = {}) => send(`/api/sessions/${id}/messages`, { text, ...extra });
const idle = (id: string) => until(async () => (await all()).sessions.find((s) => s.id === id)?.effective !== "working");
const open = (id: string) => until(async () => (await all()).questions.find((q) => q.post === id && !q.answered));
const row = async () => (await get("/api/runtimes")).runtimes.find((r) => r.kind === "grok");
let server;
let serverLog = "";
try {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (d) => (serverLog += d));
  await until(async () => fetch(url + "/api/health").then((r) => r.ok).catch(() => false));
  const setup = await req("/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  cookie = (setup.headers.get("set-cookie") || "").split(";")[0];
  const agent = await until(async () => (await all()).agents.find((a) => a.id === "grok"));
  const ready = await row();
  check(agent?.kind === "grok" && agent.name === "Grok" && ready?.ok && ready.status === "Ready", "with grok here, Grok is a profile and a Ready row on Settings → Agents");
  const listed = await until(async () => (await all()).agents.find((a) => a.id === "grok")?.models);
  check(listed?.list?.map((m) => m.id).join() === "grok-4.7,grok-4.7-build-fast,grok-4.5" && effortsOf(listed, "grok-4.7").efforts.join() === "xhigh,high,medium,low" && fs.existsSync(path.join(tmp, "cli", "grok-models.json")), "its models, each with its own effort levels, are the picker's before any thread starts, kept for the next start");
  check(!acp("session/new").length, "asking grok what it has starts no session");
  check(calls().filter((c) => c.cmd === "started").every((c) => c.questions === "false"), "the grok agentbook runs has no question card of its own, which agentbook couldn't show: it asks with ab_ask");
  const behind = await until(async () => (await row())?.update?.outdated && (await row()).update);
  check(behind?.version === "1.0.89" && behind.latest === "1.0.95", "its row says the version here and the newest, as grok update --check says it");

  const launched = await send("/api/launch", { agent: "grok", root: project, prompt: "Read the files" });
  const id = await until(async () => (await all()).sessions.find((s) => s.launch === launched.lid)?.id);
  check(launched.status === 200 && (await said(id, "Done: Read the files")), "posting on Grok's wall starts a session, and its reply is what it said, whitespace chunks and all");
  const made = acp("session/new")[0]?.params;
  const mcp = made?.mcpServers?.[0];
  check(made?.cwd === project && mcp?.type === "http" && mcp.name === "agentbook" && new URL(mcp.url).searchParams.get("proc") === `launch:${launched.lid}`, "its session works in the folder picked, with agentbook's tools at its address, by the name that replaces the plugin's own");
  check(made?._meta?.autoMode === true && made._meta.yoloMode === false && !(await all()).questions.some((q) => q.post === id), "a thread with no mode picked starts in grok's Auto mode");
  const first = acp("session/prompt")[0]?.params.prompt;
  check(first?.[0].text === "Read the files" && /agentbook/.test(first?.[1]?.text) && (await detail(id)).messages.filter((m) => m.text === "Read the files").length === 1, "the first prompt carries agentbook's context after it, and shows once on the thread");
  const shown = await steps(id);
  check(shown.some((s) => s.kind === "tool" && s.title === "Run ls" && s.done) && !shown.some((s) => /Private reasoning/.test(s.text || "")) && !JSON.stringify(shown).includes("\u001b"), "its tool calls are steps, done once they finish, without their colors; its thoughts aren't");
  check((await detail(id)).ai_title === "Reading the files" || (await detail(id)).title === "Reading the files", "the title grok gives the session is the thread's");
  check((await all()).sessions.find((s) => s.id === id)?.effort === "high", "the thread says the effort its model runs at");

  await write(id, "Headline: Grok is connected");
  check((await said(id, "Set the headline.")) && (await until(async () => (await detail(id)).title === "Grok is connected")), "a real ab_post call through agentbook's tools sets the headline");
  check(calls().some((c) => c.cmd === "permission" && c.tool === "use_tool" && c.outcome?.optionId === "allow-once") && !(await all()).questions.some((q) => q.post === id && /ab_post/.test(`${q.detail} ${q.preview}`)), "grok's ask before agentbook's own tool is allowed without asking the person");
  check(!(await steps(id)).some((s) => /ab_post|use_tool/.test(`${s.tool || ""} ${s.title || ""}`)), "agentbook's own tools stay off the steps");

  await write(id, "delete the build folder");
  const ask = await open(id);
  check(ask?.tool_name === "Terminal" && ask.preview === "rm -rf build", "a command it asks to run is Allow/Deny on the thread, showing the command");
  await send(`/api/questions/${ask.id}/answer`, { value: "allow" });
  check((await said(id, "Done: delete the build folder")) && calls().some((c) => c.cmd === "permission" && c.outcome?.optionId === "allow-once"), "Allow picks grok's allow-once option, and the turn goes on");
  await write(id, "edit the README");
  check((await said(id, "Done: edit the README")) && !(await all()).questions.some((q) => q.post === id && !q.answered), "in Auto, an edit in the folder goes ahead without asking");
  await write(id, "edit a file outside the folder");
  const editAsk = await open(id);
  check(editAsk?.preview.includes("OUTSIDE.md") && editAsk.preview.includes("before") && editAsk.preview.includes("after"), "an edit it asks to make shows the file, before and after");
  await send(`/api/questions/${editAsk.id}/answer`, { value: "deny" });
  check(await until(() => calls().some((c) => c.cmd === "permission" && c.outcome?.optionId === "reject-once")), "Deny picks its reject-once option");
  check((await said(id, "Grok stopped there, as what it asked to do was denied. Say what it should do instead.")) && (await idle(id)), "which ends grok's turn, and the thread says why");

  await write(id, "slow investigation");
  await until(async () => (await all()).sessions.find((s) => s.id === id)?.effective === "working");
  await write(id, "Meanwhile, a note");
  await sleep(400);
  check(!acp("session/prompt").some((c) => c.params.prompt[0].text === "Meanwhile, a note") && !calls().some((c) => c.cmd === "busy"), "what you write while it works waits for its turn to end");
  await send(`/api/sessions/${id}/stop`);
  check((await said(id, "Done: Meanwhile, a note")) && acp("session/cancel").some((c) => c.params.sessionId === id), "Stop cancels the turn, and what waited goes then");

  await idle(id);
  await send(`/api/sessions/${id}/model`, { model: "grok-4.5" });
  await send(`/api/sessions/${id}/effort`, { effort: "low" });
  await write(id, "Use another model");
  await said(id, "Done: Use another model");
  const opts = acp("session/set_config_option").filter((c) => c.params.sessionId === id);
  const promptAt = calls().findIndex((c) => c.method === "session/prompt" && c.params.prompt[0].text === "Use another model");
  check(opts.some((c) => c.params.configId === "model" && c.params.value === "grok-4.5") && calls().findIndex((c) => c.method === "session/set_config_option" && c.params.value === "grok-4.5") < promptAt && (await detail(id)).model === "grok-4.5", "a model picked for the thread is set before the next prompt, as a plain string, and the thread says it");
  const effortSet = calls().findIndex((c) => c.method === "session/set_config_option" && c.params.configId === "reasoning_effort" && c.params.value === "low");
  const after = (await all()).sessions.find((s) => s.id === id);
  check(effortSet >= 0 && effortSet < promptAt && after?.effort === "low" && !after.effort_pick, "and so is an effort picked for it, which the thread then says");

  const stepsBefore = (await steps(id)).length;
  const marks = calls().length;
  const toAsk = await send(`/api/sessions/${id}/mode`, { mode: "ask" });
  const since = calls().slice(marks);
  const closedAt = since.findIndex((c) => c.method === "session/close" && c.params.sessionId === id);
  const reloaded = since.findIndex((c) => c.method === "session/load" && c.params.sessionId === id && c.params._meta?.autoMode === false && c.params._meta.yoloMode === false);
  check(toAsk.status === 200 && toAsk.now && closedAt >= 0 && reloaded > closedAt && !since.some((c) => c.method === "session/resume") && (await all()).sessions.find((s) => s.id === id)?.mode === "ask", "its mode switches at once: to Ask, grok's session is closed and loaded again, as a resume never turns its auto off");
  check((await steps(id)).length === stepsBefore && (await detail(id)).model === "grok-4.5", "what that load replays adds no steps, and the session keeps its model");
  await write(id, "edit the README in Ask");
  const askAsk = await open(id);
  check(askAsk?.preview.includes("README.md"), "in Ask, an edit in the folder asks");
  await send(`/api/questions/${askAsk.id}/answer`, { value: "allow" });
  await said(id, "Done: edit the README in Ask");
  check((await send(`/api/sessions/${id}/mode`, { mode: "plan" })).status === 409, "Plan isn't one of its modes: grok has none over ACP");
  const toFull = await send(`/api/sessions/${id}/mode`, { mode: "full" });
  check(toFull.status === 200 && acp("session/resume").at(-1)?.params._meta?.yoloMode === true, "Full access is always-approve, a resume of the session grok has open");
  await write(id, "delete the build folder in Full access");
  check((await said(id, "Done: delete the build folder in Full access")) && !(await all()).questions.some((q) => q.post === id && !q.answered), "and a command that deletes goes ahead without asking");
  await send(`/api/sessions/${id}/mode`, { mode: "auto" });
  check((await all()).sessions.find((s) => s.id === id)?.mode === "auto" && acp("session/resume").at(-1)?.params._meta?.autoMode === true, "and back to Auto");

  const commands = await get(`/api/sessions/${id}/commands`);
  const by = Object.fromEntries((commands.list || []).map((c) => [c.name, c]));
  check(by.compact && by["deep-research"]?.takes === "req" && by.review && (commands.off || []).some((c) => c.name === "always-approve"), "a thread lists grok's slash commands, the folder's skills among them, and leaves always-approve to agentbook's own mode");
  await write(id, "/compact", { command: "compact" });
  check((await said(id, "Compacted the conversation.")) && acp("session/prompt").some((c) => c.params.sessionId === id && c.params.prompt[0].text === "/compact"), "a slash command goes to grok as a prompt starting with it");

  const fullLaunch = await send("/api/launch", { agent: "grok", root: bare, prompt: "delete the build, picked from the start", mode: "full", model: "grok-4.5", effort: "low" });
  const second = await until(async () => (await all()).sessions.find((s) => s.launch === fullLaunch.lid)?.id);
  const secondNew = acp("session/new").at(-1)?.params;
  const secondSet = acp("session/set_config_option").filter((c) => c.params.sessionId === second);
  const secondPrompt = calls().findIndex((c) => c.method === "session/prompt" && c.params.sessionId === second);
  check(fullLaunch.status === 200 && (await said(second, "Done: delete the build, picked from the start")) && secondNew?._meta?.yoloMode === true && !(await all()).questions.some((q) => q.post === second), "Full access picked as a thread starts is grok's always-approve from its session's start");
  check(secondSet.some((c) => c.params.configId === "model" && c.params.value === "grok-4.5") && secondSet.some((c) => c.params.configId === "reasoning_effort" && c.params.value === "low") && calls().findLastIndex((c) => c.method === "session/set_config_option" && c.params.sessionId === second) < secondPrompt, "a model and effort picked as a thread starts are set before its first prompt");

  await idle(id);
  await idle(second);
  const before = (await detail(id)).messages.length;
  const loadsBefore = acp("session/load").length;
  await server.restart("agentbook-cli");
  const kept = await until(async () => {
    const d = await detail(id);
    return d.messages?.length === before && d;
  });
  check(kept?.messages.length === before, "a restart leaves the thread's conversation as it was");
  const restored = await until(async () => {
    const s = await steps(id);
    return s.some((x) => x.title === "Run rm -rf build") && s;
  });
  check(restored && restored.some((s) => s.title === "Run ls" && s.done) && !restored.some((s) => /ab_post|use_tool/.test(`${s.tool || ""} ${s.title || ""}`)) && acp("session/load").length === loadsBefore, "after a restart, grok's updates.jsonl is the thread's steps, without loading its session");
  check(!(await steps(second)).length, "a session with no log has no steps after a restart, until it's loaded");
  await write(second, "Load me again");
  check((await said(second, "Done: Load me again")) && (await steps(second)).some((s) => s.title === "Run rm -rf build" && s.done), "loading it, what grok replays is its steps again");
  const secondLoad = acp("session/load").find((c) => c.params.sessionId === second)?.params;
  check(secondLoad?._meta?.yoloMode === true && new URL(secondLoad.mcpServers[0].url).searchParams.get("proc") === `grok:${second}` && !(await all()).questions.some((q) => q.post === second), "it loads in the mode the thread is in, with agentbook's tools for its thread");
  const deletes = (await steps(id)).filter((s) => s.title === "Run rm -rf build").length;
  await write(id, "Go on after the restart");
  check(await said(id, "Done: Go on after the restart"), "writing after a restart loads the same session and goes on");
  check(deletes === 2 && (await steps(id)).filter((s) => s.title === "Run rm -rf build").length === deletes && (await detail(id)).messages.filter((m) => m.text === "Done: Read the files").length === 1, "loading a session whose steps came from its log adds neither its replay to them nor its replies to the thread");
  check((await detail(id)).model === "grok-4.5", "the session comes back on the model it had");

  await write(id, "fail this turn");
  check((await said(id, "Grok stopped: Upstream unavailable")) && (await idle(id)), "a turn that fails says why and leaves the thread idle");
  await write(id, "crash this process");
  check((await said(id, "Grok stopped: Grok's ACP server stopped: Grok test process crashed")) && (await idle(id)), "when grok stops mid-turn, the turn ends saying why");
  await write(id, "Recover after the crash");
  check(await said(id, "Done: Recover after the crash"), "the next message starts grok again and loads the session");

  // agentbook restarting mid-turn (a commit's self-reload) stops grok with it, as its child.
  await write(id, "delete the build folder again");
  const cut = await open(id);
  const loadsCut = acp("session/load").filter((c) => c.params.sessionId === id).length;
  await server.restart("agentbook-cli");
  check(await until(async () => (await all()).questions.find((q) => q.id === cut?.id)?.by === "gone"), "an Allow/Deny the restart cut off is closed, as the grok that asked it is gone");
  check((await said(id, `Done: ${CARRY_ON}`)) && acp("session/load").filter((c) => c.params.sessionId === id).length > loadsCut, "a turn the restart cut off is picked up by itself: its session loads again and grok is told to carry on");
  check((await idle(id)) && !(await all()).questions.some((q) => q.post === id && !q.answered), "then the thread ends its turn as any other, with nothing left asking");

  // A command grok leaves running in the background, and the turn it starts by itself when that ends.
  const thread = async () => (await all()).sessions.find((s) => s.id === id);
  await write(id, "background build until built");
  await said(id, "Started the build in the background.");
  const between = await until(async () => {
    const s = await thread();
    return !s?.busy && s?.going?.length && s;
  });
  check(between?.effective === "working" && between.going[0].title === "npm run build" && between.going[0].kind === "shell", "a command grok left running in the background keeps its thread working once the turn ends, listed as going on");
  check(JSON.parse(fs.readFileSync(path.join(tmp, "cli", "grok-going.json"), "utf8"))[id]?.[0]?.title === "npm run build", "and it's kept on disk, for a restart to know grok lost it");
  const prompts = acp("session/prompt").length;
  fs.writeFileSync(path.join(fake, "built"), "");
  check(await until(async () => (await thread())?.busy), "when it ends, grok carrying on by itself makes a turn of its own on the thread");
  check((await said(id, "The build finished: dist/app.js.")) && acp("session/prompt").length === prompts, "what grok says then is its reply on the thread, with no prompt of agentbook's");
  const quiet = await until(async () => {
    const s = await thread();
    return !s?.busy && s?.effective === "idle" && s;
  });
  check(quiet && !quiet.going?.length && (await steps(id)).some((s) => s.title === "Run ls dist" && s.done), "its turn_completed ends that turn: the thread is idle, with nothing going on, and what it did is steps");

  await write(id, "background slow build until slow-built");
  await until(async () => !(await thread())?.busy && (await thread())?.going?.length);
  fs.writeFileSync(path.join(fake, "slow-built"), "");
  await until(async () => (await steps(id)).some((s) => s.title === "Run npm test"));
  const cancels = acp("session/cancel").length;
  await send(`/api/sessions/${id}/stop`);
  check((await idle(id)) && acp("session/cancel").length > cancels, "Stop cancels a turn grok started by itself, and the thread is idle");

  await write(id, "background build until never");
  await until(async () => !(await thread())?.busy && (await thread())?.going?.length);
  await server.restart("agentbook-cli");
  check(await said(id, `Done: ${tasksCut(["npm run build"])}`), "a restart, which stops grok and its background tasks, picks the thread up by itself, telling grok it won't hear from that task");
  await idle(id);

  // Signing in to x.ai, from Settings → Agents: a code confirmed there.
  fs.rmSync(path.join(grokHome, "auth.json"));
  const noAuth = await send("/api/launch", { agent: "grok", root: project, prompt: "Needs sign-in" });
  check(noAuth.status === 500 && /Sign in to Grok/.test(noAuth.error || ""), "without a sign-in, starting a thread says how to sign in");
  const signin = await send("/api/runtimes/login", { kind: "grok", step: "start" });
  check(signin.status === 200 && signin.url === "https://accounts.x.ai/oauth2/device?user_code=TEST-CODE" && signin.user_code === "TEST-CODE", "signing in shows x.ai's link and the code to confirm there");
  check((await send("/api/runtimes/login", { kind: "grok", step: "code", code: "x" })).status === 400, "it takes no code pasted back");
  fs.writeFileSync(path.join(fake, "confirmed"), "");
  const signedIn = await send("/api/runtimes/login", { kind: "grok", step: "check" });
  check(signedIn.status === 200 && signedIn.configured && (await row())?.provider?.provider === "grok", "once the code is confirmed, grok is signed in and the provider says so");
  const again = await send("/api/launch", { agent: "grok", root: project, prompt: "Signed in now" });
  const third = await until(async () => (await all()).sessions.find((s) => s.launch === again.lid)?.id);
  check(again.status === 200 && (await said(third, "Done: Signed in now")), "and threads start again");

  // Its update: grok's own `grok update`, once nothing of it runs.
  await idle(third);
  const updating = await send("/api/runtimes/update", { kind: "grok" });
  const updated = await until(async () => (await row())?.update?.state === "updated" && (await row()).update);
  check(updating.status === 200 && updated?.version === "1.0.95" && !updated.outdated && calls().some((c) => c.cmd === "update"), "Update runs grok update, and the row reads the new version after");
  await write(third, "Go on in the new grok");
  check(await said(third, "Done: Go on in the new grok"), "its threads go on in the new grok");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
}
if (failures) console.log(`server log:\n${serverLog.slice(-4000)}`);
console.log(failures ? `${failures} checks failed (data: ${tmp})` : "All Grok checks passed");
process.exit(failures ? 1 : 0);
