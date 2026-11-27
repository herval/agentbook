#!/usr/bin/env node
// agentbook's database: importing an events.jsonl from before it, surviving a kill between checkpoints,
// and keeping files in their own folder. Run: node test/storage.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-storage-"));
const FILES = path.join(HOME, "elsewhere", "files");
const PORT = testPort(4600);
const URL = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_FILES: FILES, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CHECKPOINT_MS: "60000", AGENTBOOK_CLAUDE: "/usr/bin/false" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let COOKIE = "";
const call = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } });
const get = async (p: string): Promise<Json> => (await call(p)).json();
const post = async (p: string, body?: unknown): Promise<Json> => (await call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
async function start() {
  const child = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return Object.assign(child, { err: () => err });
    } catch {}
    await sleep(100);
  }
  throw new Error(`server didn't start: ${err}`);
}

// The log an agentbook kept before the database.
const at = new Date().toISOString();
const ops = [
  { t: "session.hello", seq: 1, at, proc: "box-1", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "wren", session_id: "old-1", cwd: HOME },
  { t: "session.post", seq: 2, at, post: "old-1", title: "From before the database" },
  { t: "message.add", seq: 3, at, post: "old-1", from: "human", via: "dash", text: "hello from the old log" },
  { t: "todo.add", seq: 4, at, post: "old-1", text: "Accept the Xcode license" },
  { t: "todo.add", seq: 5, at, post: "old-1", text: "Review the old PR" },
  { t: "todo.done", seq: 6, at, tid: "t5", done: true },
];
fs.writeFileSync(path.join(HOME, "events.jsonl"), ops.map((o) => JSON.stringify(o)).join("\n") + "\n");

let server = await start();
try {
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  const s = await stateOf(get);
  const old = s.sessions.find((x) => x.id === "old-1");
  const imported = ((await (await fetch(URL + "/api/health")).json()) as { seq: number }).seq;
  check(old?.title === "From before the database" && old.messages === 1 && imported >= 6, "an events.jsonl from before the database is imported");
  check(fs.existsSync(path.join(HOME, "storage.db")) && !fs.existsSync(path.join(HOME, "cli", "agentbook.db")) && !fs.existsSync(path.join(HOME, "cli", "events.jsonl")) && fs.existsSync(path.join(HOME, "cli", "events.jsonl.imported")) && !fs.existsSync(path.join(HOME, "events.jsonl")), "the database replaces it (agentbook's one, storage.db), and the old log is kept in agentbook-cli's folder as a backup");
  check(!/ExperimentalWarning|SQLite is an experimental/.test(server.err()), "the server says nothing about SQLite being experimental");

  // Changes made after the last checkpoint survive a kill: their ops are in the database already.
  await post("/api/hello", { proc: "box-2", label: "kite", agent: "Claude", session_id: "new-1", cwd: HOME });
  await post("/api/procs/box-2/post", { title: "Made after the checkpoint" });
  const up = (await (await call(`/api/upload?post=new-1&name=notes.txt`, { method: "POST", body: "some notes" })).json()) as { id: string };
  server.kill("SIGKILL");
  await sleep(300);
  server = await start();
  const after = await stateOf(get);
  check(after.sessions.find((x) => x.id === "new-1")?.title === "Made after the checkpoint" && after.sessions.find((x) => x.id === "old-1"), "after a kill, everything comes back: the checkpoint, then the ops after it");
  // Agents' to-dos from before they were tasks move onto the owner's Tasks, once there's an owner.
  const moved = after.tasks.filter((t) => t.from === "old-1");
  const xcode = moved.find((t) => t.text === "Accept the Xcode license");
  const oldPr = moved.find((t) => t.text === "Review the old PR");
  check(moved.length === 2 && xcode && !xcode.done && xcode.posts[0]?.post === "old-1" && xcode.at === at && oldPr?.done && oldPr.done_at === at, "agents' to-dos from before become the owner's tasks, as they were, linked to their posts");
  check(fs.readdirSync(FILES).some((f) => f.endsWith("notes.txt")) && !fs.existsSync(path.join(HOME, "cli", "files", fs.readdirSync(FILES)[0] || "x")), "files go to the folder AGENTBOOK_FILES names");
  check((await (await call(`/api/files/${up.id}`)).text()) === "some notes", "and download from there");

  // A clean stop writes a checkpoint, so the next start replays nothing.
  server.kill("SIGINT");
  await sleep(500);
  server = await start();
  check((await stateOf(get)).sessions.length === 2, "a clean stop and start keeps everything, sign-ins included");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
