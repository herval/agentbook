#!/usr/bin/env node
// A code block in a thread's message, run (▶): its machine runs it in the thread's terminal, the one shell its Open
// terminal shows, as pasted at its prompt, if it really is a block of that message; what one block sets the next one
// has. What it prints comes up on the page's stream as it goes, and how it ended, with the end of what it printed,
// stays with the thread. Stop ends it. Once it ends, the thread's agent hears how it went, as it hears a message. A
// machine whose gate turned terminals off runs it in a shell of its own. A real agentbook, a session played through
// the real hooks.
// Run: node test/runs.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { postForOthers } from "../server/policy.ts";
import { codeBlocks, commandFences, sameCode } from "../plugin/shared/text.ts";
import { codeBlockCount, commandFences as pageCommandFences } from "../web/lib/commands.ts";
import { needsSignature } from "../plugin/shared/signed.ts";
import { checkCommand } from "../plugin/shared/protocol.ts";
import { plainOutput } from "../plugin/cli/runs.ts";
import { socketsDir } from "../plugin/cli/terminals.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-runs-"));
const GATE = path.join(HOME, "cli", "gate.json");
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(GATE, JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4400);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
// As systemd's profile leaves it on Ubuntu, for a bash here: PROMPT_COMMAND as a list, with something of its own to run.
fs.writeFileSync(path.join(HOME, ".profile"), 'PROMPT_COMMAND=("" ":;")\n');
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  HOME,
  // A shell that marks its commands, as macOS's and most Linux's do.
  SHELL: process.env.AGENTBOOK_TEST_SHELL || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash"),
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_HERMES: "0",
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: FAKE,
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_TERMINAL: "0",
  RUNS_TEST_SECRET: "from-the-cli",
  // A Claude Code session's own variable, as agentbook-cli has it when a session's hook started it.
  CLAUDE_CODE_SESSION_ID: "the-session-that-started-it",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_LAUNCH_ID", "CLAUDE_JOB_DIR", "CLAUDE_PID", "ZDOTDIR"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
let COOKIE = "";
const call = (u: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(u, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await call(URL + p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => {
  const r = await call(URL + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf = {};
function runHook(event, input, extra) {
  if (input.session_id) sessionOf[extra?.AGENTBOOK_PID] = input.session_id;
  const r = spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[extra?.AGENTBOOK_PID], ...input }), env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
  return { code: r.status, out: r.stdout };
}

// ---------- what both sides read the same way ----------
const said = [
  "Set it up, then start it:",
  "",
  "```bash",
  "make -C vibes setup",
  "make -C vibes dev        # LiteLLM key via doppler",
  "```",
  "",
  "1. In a list:",
  "   ```",
  "   echo nested",
  "   ```",
  "```js",
  "console.log(1)",
  "```",
  "```",
  "left open",
].join("\n");
const blocks = codeBlocks(said);
check(blocks.length === 4 && blocks[0].lang === "bash" && blocks[0].code === "make -C vibes setup\nmake -C vibes dev        # LiteLLM key via doppler", "a message's code blocks, in order, with their fence's language");
check(blocks[1].code === "echo nested" && blocks[2].lang === "js" && blocks[3].code === "left open", "one in a list loses the list's indent, and one left open runs to the end");
// An agent's `! command` (Claude Code's "type this at its prompt") is a block of its own, numbered where it is.
const bang = [
  "To unblock it, run `! gh run cancel 43095465480 && gh run rerun 43094814110`. I tried to run it myself.",
  "",
  "```",
  "echo fenced `! not this`",
  "```",
  "1. Sign in: `! gh auth login`, then `! gh auth status`",
  "- `! make dev`",
  "| a | `! not in a table` |",
  "> `! nor in a quote`",
  "`!important` stays, and so does `! ` alone.",
].join("\n");
const fenced = commandFences(bang);
check(
  fenced ===
    [
      "To unblock it, run:",
      "```sh",
      "gh run cancel 43095465480 && gh run rerun 43094814110",
      "```",
      "I tried to run it myself.",
      "",
      "```",
      "echo fenced `! not this`",
      "```",
      "1. Sign in:",
      "   ```sh",
      "   gh auth login",
      "   ```",
      "   then:",
      "   ```sh",
      "   gh auth status",
      "   ```",
      "- ",
      "  ```sh",
      "  make dev",
      "  ```",
      "| a | `! not in a table` |",
      "> `! nor in a quote`",
      "`!important` stays, and so does `! ` alone.",
    ].join("\n"),
  "each `! command` outside a code block, a table or a quote is a block of its own, the text around it kept",
);
check(pageCommandFences(bang) === fenced && pageCommandFences(said) === said && commandFences(said) === said, "the page makes the same blocks of them as the machine (web/lib/commands.ts)");
const bangBlocks = codeBlocks(bang);
check(bangBlocks.length === 5 && bangBlocks[0].code === "gh run cancel 43095465480 && gh run rerun 43094814110" && bangBlocks[0].lang === "sh" && bangBlocks[1].code === "echo fenced `! not this`" && bangBlocks[3].code === "gh auth status" && bangBlocks[4].code === "make dev", "the machine finds them as code blocks, in the order the page numbers them");
check(codeBlockCount(bang.split("\n")[0]) === 1 && codeBlockCount(said) === 4, "a part of a message counts its blocks as the machine does, for the part drawn after it");
check(sameCode("  echo nested\n\n", "echo nested") && !sameCode("echo nested", "echo nested; rm -rf ~"), "the same code whatever its indent, and not with anything added");
check(plainOutput("\x1b[32mok\x1b[0m\n10%\r50%\r100%\nbell\x07") === "ok\n100%\nbell", "what a run prints loses its colors, a progress bar's earlier states and control characters");
check(needsSignature({ kind: "post.run", args: {} }) && !needsSignature({ kind: "post.run_stop", args: {} }), "running a block needs its owner's passkey on a machine that keeps one; stopping it doesn't");
check(checkCommand({ kind: "post.run", args: { post: "p", mid: "m", block: 0, code: "x".repeat(30000) } }) !== null, "a machine refuses more code than a block may have");

const project = path.join(HOME, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
const server = spawnAgentbook({ env, stdio: ["ignore", process.env.DEBUG ? "inherit" : "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 8000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  const me = { AGENTBOOK_PID: "930001", AGENTBOOK_LABEL: "wren", CLAUDE_PROJECT_DIR: project };
  const S = "sess-runs";
  runHook("SessionStart", { session_id: S, cwd: project, source: "startup" }, me);
  runHook("UserPromptSubmit", { prompt: "how do I check it?", cwd: project }, me);
  const reply = ["Try:", "```bash", "echo hello from $(basename $PWD)", 'echo "secret: ${RUNS_TEST_SECRET:-none} session: ${CLAUDE_CODE_SESSION_ID:-none}"', "```", "A slow one:", "```sh", "echo started", "sleep 30", "echo never", "```", "One that fails:", "```", "echo about to fail >&2", "exit 3", "```", "And a picture of it:", "```", "┌──┐", "```", "Set one up:", "```sh", "export SHOP_COLOR=teal", "mkdir -p sub && cd sub", "```", "Then:", "```sh", "echo color=$SHOP_COLOR in $(basename $PWD)", "false", "```", "Or run `! echo bang in $(basename $PWD)`."].join("\n");
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: reply }, me);
  const detail = () => get(`/api/sessions/${S}`);
  const msg = await until(async () => (await detail()).messages?.find((m) => m.from !== "human" && m.text.includes("hello from")));
  check(!!msg, "the agent's reply with code blocks is on the thread");
  const first = await detail();
  check(Array.isArray(first.runs) && first.runs.length === 0, "its owner's thread has its runs, none yet");

  // The page's stream, as a thread's page watches it.
  const LIVE = "runs-test-page-1";
  const events = [];
  const stream = await call(`${URL}/api/live?live=${LIVE}`);
  (async () => {
    const reader = stream.body.getReader();
    const text = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buf += text.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.+)$/m)?.[1];
        const data = chunk.match(/^data: (.+)$/m)?.[1];
        if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
      }
    }
  })();
  await until(() => events.some((e) => e.ev === "hello"));
  const q = await get(`/api/q/thread/${S}?n=50&live=${LIVE}`);
  check(Array.isArray(q.runs) && q.watching, "q/thread gives the page the thread's runs, and watches them");
  const feed = await get(`/api/q/feed?n=20&live=${LIVE}`);
  check(Array.isArray(feed.records?.[`thread:${S}`]?.runs) && feed.watching, "q/feed's card has the runs of the messages it shows, none yet");

  // ---------- run one: in the thread's folder, as a terminal there would ----------
  const code = "echo hello from $(basename $PWD)\necho \"secret: ${RUNS_TEST_SECRET:-none} session: ${CLAUDE_CODE_SESSION_ID:-none}\"";
  const ran = await post(`/api/sessions/${S}/run`, { message: msg.id, block: 0, code });
  check(ran.status === 200 && ran.running && ran.terminal, `▶ starts it on the thread's machine, in its terminal (${ran.error || "running"})`);
  const done = await until(async () => (await detail()).runs.find((r) => r.message === msg.id && r.block === 0 && r.state === "done"));
  check(done?.exit === 0 && /hello from shop/.test(done.out), "it ran in the thread's folder and printed what it printed");
  check(!/[\x1b\r]/.test(done?.out || "") && done?.out.trim().split("\n").length === 2, `just what it printed, without the terminal's escapes or its prompt (${JSON.stringify(done?.out)})`);
  const term = (await get(`/api/sessions/${S}/terminal`)).terminal;
  check(term?.state === "open" && term.cwd === project, "it opened the thread's terminal, the one Open terminal shows");
  // The terminal shows it as typed there, and what it printed.
  const onScreen = { text: "" };
  const sock = new WebSocket(`${URL.replace(/^http/, "ws")}/api/terminals/${term?.id}/ws`, { headers: { cookie: COOKIE, origin: URL } });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "out") onScreen.text += Buffer.from(m.data, "base64").toString("utf8");
  };
  check(await until(() => onScreen.text.includes("echo hello from") && onScreen.text.includes("hello from shop"), 4000), "and the terminal shows the code as typed there, and what it printed");
  check(/secret: from-the-cli session: none/.test(done?.out || ""), "with the machine's environment, but not the session variables of whoever started agentbook-cli");
  check(done?.by === "tester" && done.started && done.ended, "it says who ran it, and when");
  check(await until(() => events.some((e) => e.ev === "runs" && e.data.thread === S && e.data.put.some((r) => r.message === msg.id && r.state === "done")), 3000), "the page's stream says so, run by run");
  check(!events.some((e) => e.ev === "put" && e.data.records?.[`thread:${S}`]?.runs), "and the thread's record doesn't carry them (each run goes on its own)");
  check(await until(() => events.some((e) => e.ev === "feed" && e.data.records?.[`thread:${S}`]?.runs?.some((r) => r.message === msg.id && r.block === 0 && r.state === "done")), 3000), "the feed's card says so too, on the feed's stream");

  // ---------- its agent hears how it went ----------
  // Idle, it has it with its next prompt (agentbook wakes one that's idle in the background, and the Wake hook one
  // idle in a terminal).
  const told = runHook("UserPromptSubmit", { prompt: "did it work?", cwd: project }, me).out;
  check(/@tester ran a code block from your message with ▶ on agentbook, in this thread's terminal: it ended with exit code 0 after \d+s\./.test(told), `once it's done, its agent hears who ran it, where, and how it ended (${JSON.stringify(told.split("\n").find((l) => l.includes("ran a code block")))})`);
  check(told.includes("```\necho hello from $(basename $PWD)\n") && /What it printed:\n```\nhello from shop\nsecret: from-the-cli/.test(told), "with the code, and what it printed");

  // ---------- only what's in the message runs ----------
  const forged = await post(`/api/sessions/${S}/run`, { message: msg.id, block: 0, code: "touch pwned" });
  check(forged.status === 409 && /isn't in the message/.test(forged.error) && !fs.existsSync(path.join(project, "pwned")), "code that isn't a block of that message doesn't run");
  check((await post(`/api/sessions/${S}/run`, { message: "nope", block: 0, code })).status === 404, "nor in a message that isn't there");

  // ---------- a slow one: what it prints shows as it goes, and Stop ends it ----------
  const slow = "echo started\nsleep 30\necho never";
  check((await post(`/api/sessions/${S}/run`, { message: msg.id, block: 1, code: slow })).running, "a slow one starts");
  const going = await until(async () => (await detail()).runs.find((r) => r.block === 1 && r.state === "running" && /started/.test(r.out)));
  check(!!going, "while it runs, what it printed so far is on the thread");
  check(await until(() => events.some((e) => e.ev === "runs" && e.data.put.some((r) => r.block === 1 && r.state === "running" && /started/.test(r.out))), 3000), "and comes on the page's stream as it goes");
  check((await post(`/api/sessions/${S}/run`, { message: msg.id, block: 1, code: slow })).status === 409, "the same block can't start twice at once");
  const meanwhile = await post(`/api/sessions/${S}/run`, { message: msg.id, block: 0, code });
  check(meanwhile.status === 409 && /running/.test(meanwhile.error), `nor another while it runs: its terminal is busy (${meanwhile.error})`);
  const t0 = Date.now();
  check((await post(`/api/sessions/${S}/run/stop`, { message: msg.id, block: 1 })).stopping, "Stop stops it");
  const stopped = await until(async () => (await detail()).runs.find((r) => r.block === 1 && r.state === "stopped"));
  check(stopped && Date.now() - t0 < 5000 && !/never/.test(stopped.out) && /started/.test(stopped.out), "it ends at once, with what it printed kept");
  check((await post(`/api/sessions/${S}/run/stop`, { message: msg.id, block: 1 })).status === 404, "one that isn't running can't be stopped");
  check(await until(() => fs.existsSync(path.join(HOME, "cli", "steer", "930001")), 3000), "a busy agent's next step is told something waits for it");
  const step = (() => {
    try {
      return JSON.parse(runHook("PostToolUse", { tool_name: "Bash", cwd: project }, me).out).hookSpecificOutput.additionalContext;
    } catch {
      return "";
    }
  })();
  check(/in this thread's terminal: they stopped it after \d+s\.[\s\S]*sleep 30[\s\S]*What it printed:\n```\nstarted\n(\^C\n)?```/.test(step), `and hears that it was stopped, with what it printed before (${JSON.stringify(step.slice(0, 300))})`);
  check(!runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "It works." }, me).out, "and once it has, its turn ends with nothing more waiting");

  // ---------- what one block sets, the next one has ----------
  await post(`/api/sessions/${S}/run`, { message: msg.id, block: 4, code: "export SHOP_COLOR=teal\nmkdir -p sub && cd sub" });
  check(!!(await until(async () => (await detail()).runs.find((r) => r.block === 4 && r.state === "done" && r.exit === 0))), "a block that sets something up runs");
  await post(`/api/sessions/${S}/run`, { message: msg.id, block: 5, code: "echo color=$SHOP_COLOR in $(basename $PWD)\nfalse" });
  const next = await until(async () => (await detail()).runs.find((r) => r.block === 5 && r.state === "done"));
  check(next?.exit === 1 && /color=teal in sub/.test(next.out), `and the next one has what it set, where it went, and says its exit code (${JSON.stringify(next?.out)})`);

  // ---------- one that fails ----------
  await post(`/api/sessions/${S}/run`, { message: msg.id, block: 2, code: "echo about to fail >&2\nexit 3" });
  const failed = await until(async () => (await detail()).runs.find((r) => r.block === 2 && r.state === "done"));
  check(failed?.exit === 3 && /about to fail/.test(failed.out), "one that fails says its exit code, with what it printed on stderr");
  check(/closed/.test(failed?.error || "") && (await until(async () => (await get(`/api/sessions/${S}/terminal`)).terminal === null)), "its `exit` ended the terminal's shell, as it would pasted in any terminal, and says so");
  const heard = runHook("UserPromptSubmit", { prompt: "and now?", cwd: project }, me).out;
  check(/it ended with exit code 0 after \d+s\.\n```\nexport SHOP_COLOR=teal/.test(heard) && /it ended with exit code 1 after/.test(heard), "each run that ended while it was idle comes with its next prompt");
  check(/it ended with exit code 3 after \d+s\. It ended the terminal's shell, so the terminal closed\.\n```\necho about to fail >&2\nexit 3\n```\nWhat it printed:\n```\nabout to fail\n(exit\n)?```/.test(heard), `and one that failed, with its exit code, what it printed, and that its terminal closed (${JSON.stringify(heard.slice(heard.indexOf("exit code 3") - 20, heard.indexOf("exit code 3") + 200))})`);
  runHook("Stop", { stop_hook_active: false, cwd: project, last_assistant_message: "Noted." }, me);

  // ---------- again: the latest run replaces the last ----------
  await post(`/api/sessions/${S}/run`, { message: msg.id, block: 0, code });
  await until(async () => (await detail()).runs.find((r) => r.block === 0 && r.state === "done" && r.started > done.started));
  check((await detail()).runs.filter((r) => r.message === msg.id && r.block === 0).length === 1, "running it again keeps only its latest run");

  const card = (await get("/api/q/feed?n=20")).records?.[`thread:${S}`];
  const showing = new Set(card?.last_messages.map((m) => m.id));
  check(!showing.has(msg.id) && card.runs.length === 0, "the feed's card has none of the runs of messages it no longer shows");

  check(!!(await get(`/api/sessions/${S}/terminal`)).terminal, "and the next run opened a new one");

  // ---------- a `! command`: a block of its own, after the fenced ones before it ----------
  check((await post(`/api/sessions/${S}/run`, { message: msg.id, block: 6, code: "! echo bang in $(basename $PWD)" })).status === 409, "a `! command` doesn't run with its !");
  await post(`/api/sessions/${S}/run`, { message: msg.id, block: 6, code: "echo bang in $(basename $PWD)" });
  const bangRun = await until(async () => (await detail()).runs.find((r) => r.block === 6 && r.state === "done"));
  check(bangRun?.exit === 0 && /bang in shop/.test(bangRun.out), `an agent's \`! command\` runs as its message's next block (${JSON.stringify(bangRun?.out)})`);

  // ---------- a machine whose gate turned terminals off: a shell of its own ----------
  fs.writeFileSync(GATE, JSON.stringify({ folders: [HOME], starts_per_hour: 1000, commands: { term: false } }));
  const own = await post(`/api/sessions/${S}/run`, { message: msg.id, block: 5, code: "echo color=$SHOP_COLOR in $(basename $PWD)\nfalse" });
  const alone = await until(async () => (await detail()).runs.find((r) => r.block === 5 && r.state === "done" && r.started > next.started));
  check(own.running && !own.terminal && alone?.exit === 1 && /color= in shop/.test(alone.out), `with terminals off, it runs in a shell of its own, which has none of the terminal's (${JSON.stringify(alone?.out)})`);
  fs.writeFileSync(GATE, JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));

  // ---------- its gate can turn running off ----------
  fs.writeFileSync(GATE, JSON.stringify({ folders: [HOME], starts_per_hour: 1000, commands: { "post.run": false } }));
  const off = await post(`/api/sessions/${S}/run`, { message: msg.id, block: 0, code });
  check(off.status === 403 && /turned off post\.run/.test(off.error), "a machine that turned post.run off in its gate.json refuses it");
  fs.writeFileSync(GATE, JSON.stringify({ folders: [HOME], starts_per_hour: 1000, never: [project] }));
  const out = await post(`/api/sessions/${S}/run`, { message: msg.id, block: 0, code });
  check(out.status === 403 && /keeps out/.test(out.error), "nor does it run anything in a folder it keeps out (agentbook-cli deny)");
  fs.writeFileSync(GATE, JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));

  // ---------- others who see it see them: they're its work ----------
  const r1 = (await detail()).runs;
  const shown = postForOthers({ id: S, runs: r1, messages: [], visibility: "public", show_work: false }, { visibility: "public" }, "tester");
  check(Array.isArray(shown.runs), "someone else who sees it sees what its runs printed: whoever sees a thread sees its work");
} finally {
  server.kill();
  await sleep(300);
  // The thread's terminal outlives agentbook-cli, by design: this test's go now.
  const dir = socketsDir(path.join(HOME, "cli"));
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
  for (const line of ps.split("\n")) if (line.includes(dir)) process.kill(Number(line.trim().split(/\s+/)[0]), "SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
