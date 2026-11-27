#!/usr/bin/env node
// Slash commands from a thread: its agent's commands, as Claude Code lists them to its
// SDK, for the / list in its reply box; one sent to a background session goes alone as the prompt agentbook wakes it
// with, never into a turn that's running, and what it printed shows on the thread as its reply; a session in a
// terminal takes it as words; a panel one opens is closed, and remembered. A driver's command goes alone too.
// Run: node test/commands.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliverer } from "../plugin/cli/runtimes/delivery.ts";
import type { OutboxEntry } from "../plugin/shared/types.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-commands-"));
const PORT = testPort(4500);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_SLEEP_AFTER_MIN: "0",
  AGENTBOOK_MAX_AWAKE: "0",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];
const HOST = os.hostname().split(".")[0];
const project = path.join(HOME, "dev", "shop");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> => {
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
const calls = () => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resumes = (id: string, from = 0) => calls().slice(from).filter((c) => c.args.includes("--resume") && c.args.includes(id));
const hook = (event: string, input: object, pid: number) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
const messages = async (id) => (await get(`/api/sessions/${id}`)).messages || [];
// What its session would take next, as its hooks and ab_inbox would, without taking it.
const waiting = async (pid) => ((await get(`/api/procs/${HOST}-${pid}/events`)).events || []).map((e) => e.event.text || e.event.type);
const agents = () => JSON.parse(fs.readFileSync(path.join(FAKE, "agents.json"), "utf8"));
const setAgent = (id, change) => fs.writeFileSync(path.join(FAKE, "agents.json"), JSON.stringify(agents().map((a) => (a.id === id ? change(a) : a))));

// Claude Code's commands, as its SDK's `initialize` gives them.
fs.writeFileSync(
  path.join(FAKE, "commands.json"),
  JSON.stringify([
    { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
    { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
    { name: "effort", description: "Set effort level for model usage", argumentHint: "<low|medium|high|xhigh|max>", builtin: true },
    { name: "model", description: "Set the AI model for Claude Code", argumentHint: "<model>", builtin: true },
    { name: "rename", description: "Rename the current conversation", argumentHint: "[name]", builtin: true },
    { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]", builtin: true },
    { name: "usage", description: "Show session cost and plan usage", argumentHint: "", builtin: true },
    { name: "ship", description: "Build, tag and deploy the shop to staging (project)", argumentHint: "[--dry-run]" },
    { name: "graphify", description: "Any input to knowledge graph (user)", argumentHint: "" },
    { name: "frontend-design:frontend-design", description: "(frontend-design) Distinctive, intentional visual design", argumentHint: "", aliases: ["frontend-design"] },
  ]),
);
// Two sessions the way `claude agents` lists them: one in the background, one in a terminal.
fs.writeFileSync(
  path.join(FAKE, "agents.json"),
  JSON.stringify([
    { id: "bg-a", sessionId: "bg-a", kind: "background", state: "working", status: "idle", cwd: project, pid: 5000, name: "bg-a" },
    { id: "term-a", sessionId: "term-a", kind: "interactive", state: "working", status: "idle", cwd: project, pid: 5001, name: "term-a" },
  ]),
);
for (const id of ["bg-a", "term-a"]) {
  fs.mkdirSync(path.join(HOME, "claude", "jobs", id), { recursive: true });
  fs.writeFileSync(path.join(HOME, "claude", "jobs", id, "state.json"), JSON.stringify({ state: "working", tempo: "idle", respawnFlags: [], sessionId: id, inFlight: { tasks: 0, queued: 0, kinds: [] }, fan: [] }));
}
// Its transcript, which a command adds to as Claude Code does: what it ran, and what it printed.
const transcript = path.join(HOME, "transcripts", "bg-a.jsonl");
fs.mkdirSync(path.dirname(transcript), { recursive: true });
let uuid = 0;
const line = (e) => {
  const id = `u${++uuid}`;
  fs.appendFileSync(transcript, JSON.stringify({ uuid: id, timestamp: new Date().toISOString(), sessionId: "bg-a", cwd: project, ...e }) + "\n");
  return id;
};
line({ type: "user", message: { role: "user", content: "Work on the shop" } });
const printed = (name, args, out, md = null) => {
  const ran = line({ type: "system", subtype: "local_command", content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`, level: "info" });
  const said = line({ type: "system", subtype: "local_command", parentUuid: ran, content: `<local-command-stdout>${out}</local-command-stdout>`, level: "info" });
  if (md) line({ type: "user", isMeta: true, parentUuid: said, message: { role: "user", content: md } });
};

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  hook("SessionStart", { session_id: "bg-a", source: "startup", transcript_path: transcript }, 7000);
  hook("UserPromptSubmit", { prompt: "Work on the shop", transcript_path: transcript }, 7000);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." }, 7000);
  hook("SessionStart", { session_id: "term-a", source: "startup" }, 7100);
  // A session in a terminal has its thread from its first prompt.
  hook("UserPromptSubmit", { session_id: "term-a", prompt: "Look at the shop" }, 7100);
  hook("Stop", { session_id: "term-a", stop_hook_active: false, last_assistant_message: "Looked." }, 7100);
  check(await until(async () => (await get("/api/sessions/bg-a")).rt?.kind === "background"), "a session in the background, idle");

  // ---------- the / list ----------
  const listed = await get("/api/sessions/bg-a/commands");
  const by = Object.fromEntries((listed.list || []).map((c) => [c.name, c]));
  check(listed.runs === true && !!by.compact && !!by.context, "a background session's thread lists its agent's commands");
  check(by.compact?.takes === "opt" && by.context?.takes === "" && by.effort?.takes === "req" && by.rename?.takes === "opt", "each says whether it takes something, may, or needs it");
  check(by.compact?.from === "built-in" && by.ship?.from === "project" && by.graphify?.from === "skill" && by["frontend-design"]?.from === "plugin" && by["frontend-design"].plugin === "frontend-design", "and where it's from: built-in, the project's, yours, a plugin's (by its short name)");
  check(by.ship?.description === "Build, tag and deploy the shop to staging" && by["frontend-design"]?.description === "Distinctive, intentional visual design", "its description without where it's from");
  check(!by.clear && !by.usage && (listed.off || []).some((o) => o.name === "clear" && /new thread/.test(o.why)) && (listed.off || []).some((o) => o.name === "usage"), "what can't run from here is left out, saying why");
  const asked = calls().filter((c) => c.args.includes("-p") && c.args.includes("--input-format"));
  check(asked.length === 1 && asked[0].cwd === fs.realpathSync(project) && asked[0].args.includes("--strict-mcp-config") && asked[0].args.includes("--no-session-persistence"), "asked of Claude Code in the session's folder, with no MCP servers and no transcript");
  await get("/api/sessions/bg-a/commands");
  check(calls().filter((c) => c.args.includes("--input-format")).length === 1, "and kept: asking again doesn't start it again");
  const term = await get("/api/sessions/term-a/commands");
  check(term.runs === false && term.why === "terminal", "a session open in a terminal runs its commands there");

  // ---------- an idle session: woken with the command alone ----------
  let mark = calls().length;
  const sent = await post("/api/sessions/bg-a/messages", { text: "/context", command: "context" });
  check(sent.status === 200, "sending a command");
  const woke = await until(() => resumes("bg-a", mark)[0]);
  check(woke?.args[0] === "/context", "an idle session is woken with the command as its prompt, as typed, with nothing after it");
  const mine = (await messages("bg-a")).find((m) => m.text === "/context");
  check(mine?.command === "context" && mine.from === "human", "it's on the thread as yours, as the command it is");
  hook("SessionStart", { session_id: "bg-a", source: "resume", transcript_path: transcript }, 7001);
  printed("context", "", " \x1b[1mContext Usage\x1b[22m\n\x1b[38;2;136;136;136m⛁ ⛁ ⛶\x1b[39m  Opus 5.5", "## Context Usage\n\n**Tokens:** 35.4k / 1m (4%)");
  const out = await until(async () => (await messages("bg-a")).find((m) => m.from === "agent" && m.command === "context"));
  check(out?.text === "## Context Usage\n\n**Tokens:** 35.4k / 1m (4%)", "what it printed is on the thread as its reply: its Markdown copy, when it left one");
  const later = (await messages("bg-a")).map((m) => m.id);
  check(later.indexOf(out.id) > later.indexOf(mine.id), "after the command");

  mark = calls().length;
  await post("/api/sessions/bg-a/messages", { text: "/rename shop work", command: "rename" });
  check((await until(() => resumes("bg-a", mark)[0]))?.args[0] === "/rename shop work", "a command takes what you wrote after it");
  hook("SessionStart", { session_id: "bg-a", source: "resume", transcript_path: transcript }, 7002);
  printed("rename", "shop work", "Session renamed to: \x1b[1mshop work\x1b[22m");
  const renamed = await until(async () => (await messages("bg-a")).find((m) => m.from === "agent" && m.command === "rename"));
  check(renamed?.text === "```text\nSession renamed to: shop work\n```", "otherwise what it printed, as printed, without the terminal's colors");
  await sleep(1500);
  check((await messages("bg-a")).filter((m) => m.from === "agent" && m.command).length === 2, "each shows once");

  // ---------- a session that's working: it waits for the turn to end ----------
  hook("UserPromptSubmit", { prompt: "Add a test for an empty cart", transcript_path: transcript }, 7002);
  check((await get("/api/sessions/bg-a")).busy, "a turn starts");
  mark = calls().length;
  const held = await post("/api/sessions/bg-a/messages", { text: "/compact keep the cart API", command: "compact" });
  check(held.held === true, "a command sent while it works waits, even sent now");
  check(!(await waiting(7002)).some((t) => /compact/.test(t)), "its hooks don't hand it to Claude in the middle of the turn");
  const end = JSON.parse(hook("Stop", { stop_hook_active: false, last_assistant_message: "Test added." }, 7002).stdout || "{}");
  check(end.decision !== "block", "its turn ends as it would have");
  const compacted = await until(() => resumes("bg-a", mark)[0]);
  check(compacted?.args[0] === "/compact keep the cart API", "then agentbook wakes it with the command alone");
  hook("SessionStart", { session_id: "bg-a", source: "resume", transcript_path: transcript }, 7003);

  // ---------- in a terminal: words ----------
  await post("/api/sessions/term-a/messages", { text: "/compact", command: "compact" });
  const asText = (await messages("term-a")).find((m) => m.text === "/compact");
  check(asText && !asText.command, "to a session in a terminal, it goes as words");
  check((await waiting(7100)).includes("/compact"), "which it gets as any message");

  // ---------- a panel it opens: closed, said, and remembered ----------
  mark = calls().length;
  await post("/api/sessions/bg-a/messages", { text: "/rename", command: "rename" });
  check((await until(() => resumes("bg-a", mark)[0]))?.args[0] === "/rename", "a command sent bare");
  hook("SessionStart", { session_id: "bg-a", source: "resume", transcript_path: transcript }, 7004);
  setAgent("bg-a", (a) => ({ ...a, pid: 4244, status: "waiting", waitingFor: "dialog open" }));
  check(!!(await until(() => calls().slice(mark).find((c) => c.args[0] === "esc" && c.args[1] === "bg-a"), 8000)), "a panel it opens, which nobody can answer in the background, is closed");
  const told = await until(async () => (await messages("bg-a")).find((m) => /agentbook closed the panel \/rename opened/.test(m.text)));
  check(!!told && /claude attach bg-a/.test(told.text), "the thread says so, and how to open it in a terminal");
  const learned = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "commands.json"), "utf8"));
  check(learned.rename === "bare", "and this machine remembers it opens one bare");
  const relisted = Object.fromEntries(((await get("/api/sessions/bg-a/commands")).list || []).map((c) => [c.name, c]));
  check(relisted.rename?.takes === "req", "so the list asks for what it takes next time");
} finally {
  server.kill();
}

// ---------- a driver's command (OpenClaw's): alone, without its group's news ----------
{
  const at = new Date().toISOString();
  const outbox: OutboxEntry[] = [
    { oid: "1", post: "k", at, delivered: false, event: { type: "message", text: "first", files: [] } },
    { oid: "2", post: "k", at, delivered: false, event: { type: "message", text: "/status", files: [], command: "status" } },
    { oid: "3", post: "k", at, delivered: false, event: { type: "message", text: "after", files: [] } },
  ];
  const acked = new Set<string>();
  const sent: { text: string; command: string | null }[] = [];
  const deliver = deliverer({
    pending: () => outbox.filter((o) => !acked.has(o.oid)),
    ack: (oids) => oids.forEach((o) => acked.add(o)),
    attached: () => "",
    describe: (e) => e.type,
    news: () => "News from its group",
    undelivered: () => {},
    log: () => {},
    name: "OpenClaw",
    answer: async () => false,
    send: async (id, text, files, opts) => sent.push({ text, command: opts?.command || null }),
    sendsFiles: true,
  });
  await deliver("k");
  await until(() => acked.size === 3, 2000);
  check(sent.length === 3 && sent[0].text === "first\n\nNews from its group" && !sent[0].command, "what's before a command goes first, as it would have");
  check(sent[1]?.text === "/status" && sent[1].command === "status", "the command goes alone, as typed, said to be one");
  check(sent[2]?.text === "after\n\nNews from its group", "and what's after it next");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
