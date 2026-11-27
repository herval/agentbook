#!/usr/bin/env node
// Stop following a thread: from its page, or from its own session (ab_keep_off), it's
// archived with what it had and its machine keeps everything of its session off agentbook, a hello again too, until
// its person follows it again. A session started with AGENTBOOK_OFF=1 never is a thread: its hook only marks it off,
// and its MCP server has no tools. Only the thread's owner can do it.
// Run: node test/thread-off.ts

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-thread-off-"));
const PORT = testPort(7000);
const URL = `http://127.0.0.1:${PORT}`;
const shop = path.join(HOME, "dev", "shop");
fs.mkdirSync(shop, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_OPENCLAW_BIN: path.join(HOME, "no-openclaw-here"), AGENTBOOK_CLOUD_SYNC_MS: "600000", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude") };
for (const k of ["AGENTBOOK_OPENCLAW", "AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LABEL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_PROC", "AGENTBOOK_OFF", "CLAUDE_JOB_DIR", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });

async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...(Array.isArray(data) ? { list: data } : data) };
}
const as = (cookie: string) => ({ get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const hello = (proc: string, session_id: string) => req("POST", "/api/hello", { body: { proc, label: proc, agent: "Claude", session_id, cwd: shop, root: shop } });
const said = (proc: string, text: string) => req("POST", `/api/procs/${proc}/messages`, { body: { from: "human", via: "terminal", text } });
const status = (proc: string, state = "working") => req("POST", `/api/procs/${proc}/status`, { body: { state, text: "Working on the cart", turn: state === "working" ? "start" : "end" } });
const marker = (sid: string) => path.join(HOME, "cli", "off", crypto.createHash("sha256").update(sid).digest("hex").slice(0, 40));
const tool = (proc: string, name: string, args: Json = {}) => req("POST", `/api/mcp?proc=${proc}`, { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });

// A process of the plugin's (a hook, the MCP server) as a Claude Code session started with AGENTBOOK_OFF=1 runs it.
const offEnv = { ...env, AGENTBOOK_OFF: "1" };
try {
  await until(() => fetch(URL + "/api/health").then((r) => r.ok, () => false));
  const me = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const swift = as((await req("POST", "/api/auth/test-person", { body: { username: "swift" } })).cookie);
  const postOf = async (id: string) => (await stateOf(me.get)).sessions.find((s: Json) => s.id === id);

  // wren works on the cart, says something and asks herval something; finch is another thread.
  const a = (await hello("box-a", "sess-a")).post;
  const b = (await hello("box-b", "sess-b")).post;
  check(a === "sess-a" && b === "sess-b", "two sessions are threads");
  await status("box-a");
  await said("box-a", "Make the cart remember what's in it");
  const q = await req("POST", "/api/procs/box-a/questions", { body: { title: "Keep the old cart?", kind: "text" } });
  check(!!q.id, "wren asks herval something");
  const before = await until(async () => ((await postOf(a))?.open_questions === 1 ? postOf(a) : null));
  check(before?.busy && before.messages === 1, "its thread is working, with its message and its question");

  // ---------- from its page ----------
  check((await swift.post(`/api/sessions/${a}/off`, { off: true })).status >= 400, "someone else can't stop following herval's thread");
  check((await me.post(`/api/sessions/${a}/off`, {})).status === 400, "it says whether it's off");
  const off = await me.post(`/api/sessions/${a}/off`, { off: true });
  check(off.status === 200 && !off.queued, "herval stops following wren's thread");
  const A = await until(async () => {
    const s = await postOf(a);
    return s?.off && s.archived ? s : null;
  });
  check(!!A, "it's archived, and says since when it's off");
  check(A && !A.busy && A.open_questions === 0 && A.messages === 1, "with what it had, not working, and nothing left to answer");
  check(fs.existsSync(marker("sess-a")), "its machine keeps its session id off");

  const st = await status("box-a", "idle");
  check(st.status === 404 && st.code === "private" && /off agentbook/.test(st.error), "its session's hooks hear it's off agentbook");
  check(/Private terminals/.test(st.error), "in words the hooks of sessions from before this tell apart");
  check((await said("box-a", "Also the wishlist")).status === 404, "what's said in its terminal isn't kept");
  const again = await hello("box-a2", "sess-a");
  check(again.post === null && again.private === true && /off agentbook/.test(again.said), "the session saying hello again (resumed) stays off");
  check((await tool("box-a", "ab_update", { text: "Shipped the cart" })).result?.isError, "its tools say it's off");
  await sleep(500);
  const A2 = await postOf(a);
  check(A2.messages === 1 && !A2.busy && !(A2.updates || []).some((u: Json) => /Shipped/.test(u.text)), "nothing of it came in since");
  const reply = await me.post(`/api/sessions/${a}/messages`, { text: "Are you there?" });
  check(reply.status === 409 && /off agentbook/.test(reply.error), "writing to it from the page is refused by its machine");
  check((await me.post(`/api/sessions/${a}/flag`, { archived: false })).status === 409 && (await postOf(a)).archived, "Unarchive doesn't bring it back: following it again does");

  // Followed again: back in the feed, and its session's hooks are heard again.
  const on = await me.post(`/api/sessions/${a}/off`, { off: false });
  check(on.status === 200, "herval follows it again");
  const back = await until(async () => {
    const s = await postOf(a);
    return !s?.off && !s?.archived ? s : null;
  });
  check(!!back && !fs.existsSync(marker("sess-a")), "it's back in the feed, and its session id isn't kept off");
  check((await status("box-a")).status === 200 && (await until(async () => (await postOf(a))?.busy)), "its session's turns show again");

  // ---------- from its own session ----------
  const kept = await tool("box-b", "ab_keep_off");
  check(!kept.result?.isError && /off agentbook/.test(kept.result?.content?.[0]?.text), "finch's session takes itself off (ab_keep_off)");
  const B = await until(async () => {
    const s = await postOf(b);
    return s?.off && s.archived ? s : null;
  });
  check(!!B, "and its thread is archived, as off");
  check((await status("box-b")).status === 404 && (await hello("box-b", "sess-b")).private === true, "nothing of it is kept since");

  // ---------- started with AGENTBOOK_OFF=1 ----------
  const hook = spawnSync(process.execPath, [path.join(PLUGIN, "hooks", "hook.ts"), "SessionStart"], { input: JSON.stringify({ session_id: "sess-c", cwd: shop, source: "startup", transcript_path: path.join(HOME, "sess-c.jsonl") }), env: offEnv, encoding: "utf8", timeout: 10e3 });
  check(hook.status === 0 && hook.stdout === "", "its SessionStart hook says nothing");
  check(fs.existsSync(marker("sess-c")), "and only marks its session id off");
  const c = await hello("box-c", "sess-c");
  check(c.post === null && c.private === true, "found later (Claude Code's list, its history), the session stays off");
  check(!(await stateOf(me.get)).sessions.some((s: Json) => s.id === "sess-c"), "it never is a thread");

  const mcp = spawn(process.execPath, [path.join(PLUGIN, "mcp", "server.ts")], { env: offEnv, stdio: ["pipe", "pipe", "ignore"] });
  const lines = readline.createInterface({ input: mcp.stdout });
  const answers: Json[] = [];
  lines.on("line", (l) => answers.push(JSON.parse(l)));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await until(() => answers.length >= 2, 5000);
  const init = answers.find((x) => x.id === 1)?.result;
  check(/AGENTBOOK_OFF=1/.test(init?.instructions) && !init?.capabilities?.experimental, "its MCP server says why it has nothing, and isn't a channel");
  check(answers.find((x) => x.id === 2)?.result?.tools?.length === 0, "and lists no tools");
  mcp.stdin.end();
  check((await until(() => mcp.exitCode !== null, 3000)) && !(await stateOf(me.get)).sessions.some((s: Json) => s.id === "sess-c"), "it ends without a word to agentbook");
} finally {
  server.kill();
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
