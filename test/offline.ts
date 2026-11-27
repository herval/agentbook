#!/usr/bin/env node
// A machine that's off: its posts open whole on the server, from what its
// agentbook-cli sent while it ran (steps, plan, what it changed, the pictures its agent saw, its files); what you
// send it waits, and reaches it when it's back; a stop runs out of time instead; and what only the machine knows
// (its folders) shows as it was last read, saying when.
// Run: node test/offline.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-offline-"));
const HUB_PORT = testPort(5500);
const LAP_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const LAP = `http://127.0.0.1:${LAP_PORT}`;
const HOST = os.hostname().split(".")[0];
const project = path.join(BASE, "dev", "app");
fs.mkdirSync(project, { recursive: true });
spawnSync("git", ["-C", project, "init", "-q", "-b", "main"]);

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), AGENTBOOK_EXPIRES_SCALE: "0.02" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID"]) delete common[k];
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub" };
const lapEnv = { ...common, AGENTBOOK_PORT: String(LAP_PORT), AGENTBOOK_HOME: path.join(BASE, "laptop"), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_URL: LAP, AGENTBOOK_HUB: HUB };

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};
let COOKIE = "";
const raw = (base: string, p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(base === HUB && COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (base: string, p: string): Promise<Json> => {
  const r = await raw(base, p);
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const post = async (base: string, p: string, body: unknown = {}): Promise<Json> => {
  const r = await raw(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const serve = (env: NodeJS.ProcessEnv) => spawnAgentbook({ env, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 8000);
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf: Record<string, string> = {};
const hook = (event: string, input: { session_id?: string; [field: string]: unknown }, env?: Record<string, string>) => {
  if (input.session_id) sessionOf[env?.AGENTBOOK_PID] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[env?.AGENTBOOK_PID], ...input }), env: { ...lapEnv, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", ...env }, encoding: "utf8", timeout: 15000 });
};

// A transcript, the way Claude Code writes it.
const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const T = path.join(BASE, "laptop-session.jsonl");
const write = (...entries) => fs.appendFileSync(T, entries.map((e) => JSON.stringify(e) + "\n").join(""));
const file = path.join(project, "server.js");
fs.writeFileSync(file, "const a = 1;\nconst b = 3;\n");
write(
  { type: "user", timestamp: at(60), message: { role: "user", content: "fix the server" } },
  { type: "assistant", timestamp: at(55), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "p1", name: "TodoWrite", input: { todos: [{ content: "Fix b", status: "in_progress", activeForm: "Fixing b" }] } }] } },
  { type: "user", timestamp: at(54), message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "ok" }] } },
  { type: "assistant", timestamp: at(50), message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: file, old_string: "const b = 2;", new_string: "const b = 3;" } }] } },
  { type: "user", timestamp: at(49), message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] }, toolUseResult: { filePath: file, structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-const b = 2;", "+const b = 3;"] }] } },
  { type: "assistant", timestamp: at(45), message: { content: [{ type: "tool_use", id: "s1", name: "mcp__chrome__screenshot", input: {} }] } },
  { type: "user", timestamp: at(44), message: { content: [{ type: "tool_result", tool_use_id: "s1", content: [{ type: "text", text: "Captured" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }] }] } },
  { type: "assistant", timestamp: at(40), message: { content: [{ type: "text", text: "Fixed b, and here's the page." }] } },
);

const hub = serve(hubEnv);
let lap = { kill() {} };
try {
  check(await healthy(HUB), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  const asked = await post(HUB, "/api/devices/start", { name: "laptop" });
  await post(HUB, "/api/devices/approve", { code: asked.code });
  const token = (await get(HUB, `/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).token;
  // ---------- a laptop that ran agentbook on its own before ----------
  // Its post from before, with a transcript: its steps go up once it logs in (the work of its last two weeks).
  const B = path.join(BASE, "before.jsonl");
  fs.writeFileSync(B, [
    { type: "user", timestamp: at(3600), message: { role: "user", content: "tidy the readme" } },
    { type: "assistant", timestamp: at(3590), message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls", description: "List files" } }] } },
    { type: "user", timestamp: at(3589), message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "README.md" }] } },
  ].map((e) => JSON.stringify(e) + "\n").join(""));
  const alone = serve({ ...lapEnv, AGENTBOOK_HUB: "" });
  await healthy(LAP);
  const was = { AGENTBOOK_PID: "930009", AGENTBOOK_LABEL: "wren", AGENTBOOK_HUB: "" };
  hook("SessionStart", { session_id: "before-1", cwd: project, source: "startup", transcript_path: B }, was);
  hook("UserPromptSubmit", { prompt: "tidy the readme", cwd: project, transcript_path: B }, was);
  hook("SessionEnd", { reason: "other" }, was);
  alone.kill();
  await sleep(500);
  Object.assign(lapEnv, { AGENTBOOK_HUB_TOKEN: token });
  lap = serve(lapEnv);
  check(await healthy(LAP), "the laptop's CLI logs in to it");
  const backfilled = await until(async () => (await get(HUB, "/api/sessions/before-1/steps")).steps?.some((x) => x.title === "List files"), 20000);
  check(backfilled && (await get(HUB, "/api/sessions/before-1")).messages?.some((m) => m.text === "tidy the readme"), "its posts from before come with it, their steps too");

  // ---------- a post on the laptop, with work to show ----------
  const env = { AGENTBOOK_PID: "930001", AGENTBOOK_LABEL: "kite" };
  hook("SessionStart", { session_id: "off-1", cwd: project, source: "startup", transcript_path: T }, env);
  const up = await post(LAP, `/api/procs/${HOST}-930001/files`, { name: "report.md", content_base64: Buffer.from("# Report\nAll good.\n").toString("base64") });
  hook("Stop", { last_assistant_message: "Fixed b, and here's the page." }, env);
  const sent = await until(async () => {
    const steps = await get(HUB, "/api/sessions/off-1/steps");
    const changes = await get(HUB, "/api/sessions/off-1/changes?turn=all");
    return steps.steps?.some((s) => s.tool === "Edit") && steps.plan && changes.files?.length ? { steps, changes } : null;
  }, 12000);
  check(!!sent, "its steps, plan and what it changed reach the server");

  // Everything a post's page asks for, while the laptop runs.
  const editStep = sent.steps.steps.find((s) => s.tool === "Edit");
  const shotStep = sent.steps.steps.find((s) => s.images);
  const reads = {
    post: "/api/sessions/off-1",
    steps: "/api/sessions/off-1/steps",
    changes: "/api/sessions/off-1/changes",
    all: "/api/sessions/off-1/changes?turn=all",
    file: `/api/sessions/off-1/changes/file?path=${encodeURIComponent("server.js")}&turn=all`,
    step: `/api/sessions/off-1/steps/${encodeURIComponent(editStep.id)}/diff`,
  };
  const bytes = { image: `/api/sessions/off-1/images/${encodeURIComponent(shotStep?.id || "x")}/0`, attached: `/api/files/${encodeURIComponent(up.id)}` };
  const pick = (r: Json, key: string) => (key === "post" ? { title: r.title, messages: r.messages?.map((m) => m.text), files: r.files?.map((f) => f.name), updates: r.updates?.map((u) => u.text) } : r);
  const before: Record<string, Json> = {};
  for (const [k, p] of Object.entries(reads)) before[k] = pick(await get(HUB, p), k);
  const beforeBytes: Record<string, Buffer> = {};
  for (const [k, p] of Object.entries(bytes)) beforeBytes[k] = Buffer.from(await (await raw(HUB, p)).arrayBuffer());
  check(before.file.hunks?.length && before.step.files?.[0]?.path === "server.js" && beforeBytes.image.equals(PNG) && beforeBytes.attached.toString() === "# Report\nAll good.\n", "its page has its steps, its change to server.js, the picture its agent saw, and the file it made");
  const folders = await get(HUB, `/api/folders?machine=laptop&path=${encodeURIComponent(path.join(BASE, "dev"))}`);
  check(folders.status === 200 && folders.folders?.some((f) => f.name === "app"), "and its folders, read from the laptop");

  // ---------- the laptop goes off ----------
  lap.kill();
  const off = await until(async () => (await stateOf((p) => get(HUB, p))).machines?.find((m) => m.name === "laptop" && m.online === false), 12000);
  check(!!off, "the server sees the laptop go off");
  const after: Record<string, Json> = {};
  for (const [k, p] of Object.entries(reads)) after[k] = pick(await get(HUB, p), k);
  const afterBytes: Record<string, Buffer> = {};
  for (const [k, p] of Object.entries(bytes)) afterBytes[k] = Buffer.from(await (await raw(HUB, p)).arrayBuffer());
  const differs = Object.keys(reads).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  check(!differs.length, `with the laptop off, every part of its post's page is what it was with it on${differs.length ? ` (differs: ${differs.join(", ")})` : ""}`);
  check(afterBytes.image.equals(beforeBytes.image) && afterBytes.attached.equals(beforeBytes.attached), "its pictures and files too");
  const oldFolders = await get(HUB, `/api/folders?machine=laptop&path=${encodeURIComponent(path.join(BASE, "dev"))}`);
  check(oldFolders.status === 200 && oldFolders.offline && oldFolders.as_of && oldFolders.folders?.some((f) => f.name === "app"), "what only it knows shows as it was last read, saying when");
  check(!(await stateOf((p) => get(HUB, p))).live?.["off-1"], "and nothing says what it's doing right now");

  // ---------- what you do while it's off ----------
  const msg = await post(HUB, "/api/sessions/off-1/messages", { text: "and the client too" });
  const stop = await post(HUB, "/api/sessions/off-1/stop");
  const waiting = (await get(HUB, "/api/sessions/off-1")).waiting || [];
  check(msg.queued && msg.waiting === "laptop" && stop.queued && waiting.some((w) => w.kind === "post.deliver" && w.text === "and the client too"), "a message and a stop wait for it, and the post says so");
  // Its card too, by its reply box, where it was sent.
  const card = (await stateOf((p) => get(HUB, p))).sessions.find((s) => s.id === "off-1");
  check(card?.waiting?.some((w) => w.kind === "post.deliver" && w.text === "and the client too" && w.cid), "and its card in the feed has what waits for it, to show by its reply box");
  // What the server tells it of where the thread is (here, the page you put it on) waits for it too, but you didn't
  // send the thread that: its reply box doesn't show it. Its machine's page does.
  const pg = await post(HUB, "/api/pages", { title: "Client work" });
  await post(HUB, `/api/pages/${pg.id}/threads`, { post: "off-1" });
  const told = (await get(HUB, "/api/machines/laptop")).waiting || [];
  const shown = (await get(HUB, "/api/sessions/off-1")).waiting || [];
  const cardNow = (await stateOf((p) => get(HUB, p))).sessions.find((s) => s.id === "off-1");
  check(told.some((c) => c.kind === "post.page") && shown.some((w) => w.kind === "post.deliver") && !shown.some((w) => w.kind === "post.page") && !cardNow?.waiting?.some((w) => w.kind === "post.page"), `the server's own word to it of the thread's page waits for the laptop, but not by the thread's reply box (${JSON.stringify(shown.map((w) => w.kind))})`);
  await sleep(2500); // a stop waits a minute (here, a moment), a message a week
  const left = (await get(HUB, "/api/sessions/off-1")).waiting || [];
  check(left.some((w) => w.kind === "post.deliver") && !left.some((w) => w.kind === "post.stop"), "a stop that waited too long goes: a late one would do harm");

  // ---------- it's back ----------
  lap = serve(lapEnv);
  await healthy(LAP);
  const delivered = await until(async () => (await get(LAP, `/api/procs/${HOST}-930001/events`)).events?.find((e) => e.event.text === "and the client too"), 9000);
  // The laptop can have it a moment before the server hears it's done.
  const cleared = await until(async () => !(await get(HUB, "/api/sessions/off-1")).waiting?.length, 9000);
  check(!!delivered && cleared, "back on, it gets the message, and nothing waits any more");
  const cardAfter = (await stateOf((p) => get(HUB, p))).sessions.find((s) => s.id === "off-1");
  check(cardAfter && !cardAfter.waiting, "nor on its card");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  hub.kill();
  lap.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
