#!/usr/bin/env node
// Slash commands on a Codex thread: the / list is Codex's commands that have an
// app-server call, and its skills; each command makes its call (compact, review, goal, rename, fork, init, status,
// usage, mcp, model), what it says lands on the thread as its reply, a skill goes to Codex as a skill, and a command
// sent while it works waits for the turn to end. Against test/fake-codex.ts.
// Run: node test/codex-commands.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-codex-commands-"));
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const SOCK = path.join(HOME, "codex.sock");
const LOG = path.join(HOME, "codex.jsonl");
const project = path.join(HOME, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_SNAPSHOT_MS: "300",
  AGENTBOOK_CODEX_SOCK: SOCK,
  AGENTBOOK_CODEX_SYNC_MS: "1000",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  FAKE_CODEX_CLI_LOG: path.join(HOME, "codex-cli.jsonl"),
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string) => {
  const r = await call(p);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (p: string, body?: unknown) => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const codexLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = (method, from = 0) => codexLog().slice(from).filter((e) => e.method === method);
const thread = (id = "th-live") => get(`/api/sessions/${id}`);
const state = () => stateOf(get);
const messages = async (id = "th-live") => (await thread(id)).messages || [];
const idle = (id = "th-live") => until(async () => !(await thread(id)).busy);
// Send a slash command as the page does: the text as typed, and the name of the command it is.
const run = (text, id = "th-live") => post(`/api/sessions/${id}/messages`, { text, command: /^\/([\w:.-]+)/.exec(text)[1] });
// What a command said on the thread: its agent's reply that says which command it's from, after `seen` of them.
const said = async (name, seen = 0) => (await until(async () => (await messages()).filter((m) => m.from === "agent" && m.command === name)[seen]))?.text || "";
const repliesTo = async (name) => (await messages()).filter((m) => m.from === "agent" && m.command === name).length;

const fakeCodex = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), SOCK, LOG, project], { stdio: "ignore", env: { ...process.env, FAKE_CODEX_MODEL_FAILURES: "2", FAKE_CODEX_EARLY_ACCOUNT: "1" } });
await until(() => fs.existsSync(SOCK), 3000);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  check(await until(async () => (await thread()).rt?.name === "Codex" && (await state()).agents?.find((a) => a.id === "codex")?.models?.list?.length), "a Codex thread, loaded in its daemon");
  check(calls("model/list").length >= 3, "temporary startup catalog failures recover without a restart or a 30-minute wait");
  const bootCalls = codexLog();
  check(bootCalls.findIndex((e) => e.method === "model/list") > bootCalls.findIndex((e) => e.method === "initialized"), "an account event during the handshake waits for initialization before listing models");

  // ---------- the / list ----------
  const listed = await get("/api/sessions/th-live/commands");
  const by = Object.fromEntries((listed.list || []).map((c) => [c.name, c]));
  check(listed.runs === true && ["compact", "review", "goal", "init", "status", "usage", "mcp", "rename", "fork", "model"].every((n) => by[n]?.from === "built-in"), "a Codex thread lists the commands Codex has a call for");
  check(by.compact.takes === "" && by.review.takes === "opt" && by.rename.takes === "req" && by.model.takes === "req" && by.model.hint === "<gpt-6.1-sol|gpt-6-luna>", "each says what it takes; /model names its models");
  check(by.compact.description === "Summarize the conversation to prevent hitting the context limit", "in Codex's own words");
  check(by.deploy?.from === "skill" && by.deploy.description === "Ship it" && by["seed-db"]?.from === "project" && by.figma?.from === "plugin" && by.figma.plugin === "figma" && by.figma.description === "Designs from Figma", "its skills are commands too: yours, the project's, a plugin's");
  check((listed.list || []).filter((c) => c.name === "review").length === 1 && !by.old, "a skill named like a command, or turned off, isn't listed");
  const off = Object.fromEntries((listed.off || []).map((c) => [c.name, c.why]));
  check(/new thread on Codex's wall/.test(off.new) && /Changes/.test(off.diff) && !!off.permissions, "what only its terminal app does, or agentbook does itself, is left out, saying why");
  check(calls("skills/list").some((e) => isDeepStrictEqual(e.params.cwds, [project])), "skills as Codex lists them for the thread's folder");

  // ---------- /compact ----------
  let mark = codexLog().length;
  check((await run("/compact")).status === 200, "sending /compact");
  check(!!(await until(() => calls("thread/compact/start", mark).find((e) => e.params.threadId === "th-live"))), "it's Codex's compaction, not a turn with the words");
  check(/^Compacted the conversation/.test(await said("compact")), "and the thread says it's done");
  await idle();
  await sleep(600);
  check((await repliesTo("compact")) === 1, "once, though Codex says it twice");
  check(!calls("turn/start", mark).some((e) => e.params.input?.[0]?.text === "/compact"), "nothing went to the model as words");
  const mine = (await messages()).find((m) => m.from === "human" && m.text === "/compact");
  check(mine?.command === "compact", "it's on the thread as yours, as the command it is");
  check(!/^\//.test((await thread()).prompt || ""), "but it isn't what you asked the thread: a command never becomes its prompt");

  // ---------- /review ----------
  for (const [text, target] of [
    ["/review", { type: "uncommittedChanges" }],
    ["/review base main", { type: "baseBranch", branch: "main" }],
    ["/review a41c9e0", { type: "commit", sha: "a41c9e0" }],
    ["/review look at the cart totals", { type: "custom", instructions: "look at the cart totals" }],
  ] as const) {
    await idle();
    mark = codexLog().length;
    await run(text);
    const r = await until(() => calls("review/start", mark)[0]);
    check(isDeepStrictEqual(r?.params.target, target) && r.params.delivery === "inline", `${text} reviews ${target.type === "custom" ? "what you say" : target.type}, on the thread`);
  }
  const found = await until(async () => (await messages()).find((m) => m.from === "agent" && /^1 finding in current changes/.test(m.text)));
  check(found && !found.command, "a review's findings are its turn's reply");
  await idle();
  await run("/review break");
  check(/^Codex couldn't run \/review: review needs a git repository/.test(await said("review")), "one Codex refuses says why");

  // A turn can be over before the reply to the call that started it is read. It isn't running, whichever came first.
  await idle();
  await run("/review instant");
  await until(async () => (await messages()).find((m) => m.from === "agent" && /^1 finding in instant/.test(m.text)));
  mark = codexLog().length;
  await run("/review after it");
  check(await until(() => calls("review/start", mark)[0]), "a review over before its reply doesn't hold the next command");
  await until(async () => (await messages()).find((m) => m.from === "agent" && /^1 finding in after it/.test(m.text)));
  await idle();
  await post("/api/sessions/th-live/messages", { text: "instant answer" });
  await until(async () => (await messages()).find((m) => m.from === "agent" && m.text === "Done: instant answer"));
  mark = codexLog().length;
  await post("/api/sessions/th-live/messages", { text: "the next one" });
  check((await until(() => calls("turn/start", mark)[0])) && !calls("turn/steer", mark).length, "after a turn over before its reply, a message starts a turn: there's none to steer");
  await until(async () => (await messages()).find((m) => m.from === "agent" && m.text === "Done: the next one"));
  // And the other way round: its reply is all there is to go on until Codex announces the turn.
  await idle();
  mark = codexLog().length;
  await post("/api/sessions/th-live/messages", { text: "unannounced work" });
  const unannounced = await until(() => calls("turn/start", mark)[0]);
  await post("/api/sessions/th-live/messages", { text: "and one more thing" });
  const steered = await until(() => calls("turn/steer", mark)[0]);
  check(unannounced && steered?.params.expectedTurnId?.startsWith("turn-") && calls("turn/start", mark).length === 1, "a message steers a turn Codex hasn't announced yet, going by the reply");
  await until(async () => (await messages()).find((m) => m.from === "agent" && m.text === "Done: unannounced work"));

  // ---------- /goal ----------
  await idle();
  mark = codexLog().length;
  await run("/goal ship the cart redesign");
  const set = await until(() => calls("thread/goal/set", mark)[0]);
  check(set?.params.objective === "ship the cart redesign" && set.params.status === "active" && set.params.origin === "user", "/goal <objective> sets it, as yours");
  check((await said("goal")) === "Goal set: ship the cart redesign", "and says so");
  await run("/goal");
  check(/^\*\*Goal:\*\* ship the cart redesign\n\nWorking on it · 13 min · 41\.2k tokens$/.test(await said("goal", 1)), "/goal alone shows it, with what it has spent");
  await run("/goal pause");
  check((await until(() => calls("thread/goal/set", mark)[1]))?.params.status === "paused" && /^Paused the goal/.test(await said("goal", 2)), "/goal pause pauses it");
  await run("/goal clear");
  check(!!(await until(() => calls("thread/goal/clear", mark)[0])) && (await said("goal", 3)) === "Cleared the goal.", "/goal clear clears it");
  await run("/goal");
  check(/^No goal set/.test(await said("goal", 4)), "and then there's none");

  // ---------- /rename, /fork ----------
  mark = codexLog().length;
  await run("/rename Cart fixes");
  check((await until(() => calls("thread/name/set", mark)[0]))?.params.name === "Cart fixes" && (await said("rename")) === "Renamed it “Cart fixes”.", "/rename names the thread in Codex");
  check(await until(async () => (await state()).sessions?.find((s) => s.id === "th-live")?.title === "Cart fixes"), "and the thread takes the name");
  await run("/fork");
  const forked = await until(() => calls("thread/fork", mark)[0]);
  const copy = await until(async () => (await state()).sessions?.find((s) => s.id.startsWith("th-fork-")));
  check(forked?.params.threadId === "th-live" && !!copy, "/fork forks it: the copy is a thread of its own");
  check((await said("fork")) === `Forked it: the copy is ${copy?.label}, on Codex's wall.`, "and the thread says which");

  // ---------- /init ----------
  await idle();
  mark = codexLog().length;
  await run("/init");
  const init = await until(() => calls("turn/start", mark)[0]);
  check(/^Generate a file named AGENTS\.md that serves as a contributor guide/.test(init?.params.input?.[0]?.text || ""), "/init is a turn with the prompt Codex's own /init sends");
  await idle();
  check(!(await messages()).some((m) => m.from === "human" && /^Generate a file named/.test(m.text)), "the thread shows /init, not the prompt");

  // ---------- /status, /usage, /mcp ----------
  await run("/status");
  const status = await said("status");
  check(status.includes("- **Model:** gpt-6-astra, high reasoning") && status.includes("- **Approvals:** on-request") && status.includes("- **Sandbox:** Workspace write") && status.includes("- **Thread:** `th-live`"), "/status says what the thread runs with");
  check(status.includes("**ChatGPT Pro Lite limits**") && /\| 5-hour \| 41% \| \w{3} /.test(status) && /\| Week \| 12% \|/.test(status), "and its plan's limits");
  await run("/usage");
  const usage = await said("usage");
  check(/^\*\*ChatGPT Pro Lite limits\*\*\n\n\| Limit \| Used \| Resets \|/.test(usage) && !usage.includes("Model"), "/usage, just the limits");
  mark = codexLog().length;
  await run("/mcp");
  const mcp = await said("mcp");
  check(mcp.includes("| agentbook | Connected | 3 |") && mcp.includes("| linear | Needs you to sign in | 0 |"), "/mcp lists its MCP servers, how each is, and their tools");
  check(calls("mcpServerStatus/list", mark)[0]?.params.threadId === "th-live", "as the thread has them");

  // ---------- a skill ----------
  await idle();
  mark = codexLog().length;
  await run("/deploy staging");
  const skill = await until(() => calls("turn/start", mark)[0]);
  check(isDeepStrictEqual(skill?.params.input, [{ type: "text", text: "$deploy staging", text_elements: [] }, { type: "skill", name: "deploy", path: "/tmp/skills/deploy/SKILL.md" }]), "a skill goes to Codex as one, with what you wrote after it");
  check(!!(await until(async () => (await messages()).find((m) => m.from === "agent" && m.text === "Done: $deploy staging"))), "and its turn's reply lands as any does");

  // ---------- /model ----------
  await idle();
  await run("/model gpt-6-luna");
  check((await said("model")) === "Its next turn is on GPT-6-Luna." && (await thread()).model_pick === "gpt-6-luna", "/model picks the thread's model, as its picker does");
  await run("/model gpt-9");
  check(/^Pick one of its models: `\/model gpt-6\.1-sol`/.test(await said("model", 1)), "one it doesn't have says which it has");

  // ---------- while it works: it waits for the turn to end ----------
  await idle();
  await post("/api/sessions/th-live/messages", { text: "linger a bit" });
  check(await until(async () => (await thread()).busy), "a turn starts");
  mark = codexLog().length;
  const held = await run("/compact");
  check(held.held === true, "a command sent while it works waits, even sent now");
  await sleep(1500);
  check(!calls("thread/compact/start", mark).length && !calls("turn/steer", mark).length, "it doesn't go into the turn that's running");
  check(!!(await until(() => calls("thread/compact/start", mark)[0])), "once the turn ends, it runs");
  check(/^Compacted/.test(await said("compact", 1)), "and says so");

  // ---------- a name it doesn't have ----------
  await idle();
  mark = codexLog().length;
  await run("/frobnicate now");
  check((await until(() => calls("turn/start", mark)[0]))?.params.input?.[0]?.text === "/frobnicate now", "a name it doesn't have goes as words");
} finally {
  server.kill();
  fakeCodex.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
