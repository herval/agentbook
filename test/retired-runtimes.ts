#!/usr/bin/env node
// An agent of a runtime agentbook dropped (shared/runtimes.ts's RETIRED: Gemini CLI's) goes when agentbook-cli starts,
// with its empty threads and their starts, on the machine and on its server alike, rows and all. One whose thread
// did something stays, as does an agent of a runtime agentbook runs. Run: node test/retired-runtimes.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnAgentbook, freePort } from "./harness.ts";
import { sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";
import { createStore } from "../plugin/shared/store.ts";

let failures = 0;
const check = (cond: unknown, what: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) failures++;
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-retired-"));

// agent.remove, in a store of its own: the agent, its threads, their processes and starts, and who follows it go;
// another agent's stay.
{
  const store = createStore({ file: path.join(dir, "unit", "storage.db"), filesDir: path.join(dir, "unit", "files"), legacy: false });
  const { state } = store;
  store.commit({ t: "agent.hello", agent: "gemini", agent_name: "Gemini", kind: "gemini" });
  store.commit({ t: "session.hello", proc: "gemini-1", agent: "gemini", agent_name: "Gemini", kind: "gemini", label: "wren", session_id: "g-1", cwd: dir });
  store.commit({ t: "session.hello", proc: "box-1", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "kite", session_id: "c-1", cwd: dir });
  store.commit({ t: "launch.add", lid: "l-gemini", agent: "gemini", prompt: "Hi" });
  store.commit({ t: "launch.fail", lid: "l-gemini", error: "Gemini API key is missing" });
  store.commit({ t: "launch.add", lid: "l-claude", agent: "claude", prompt: "Hi" });
  store.commit({ t: "agent.follow", agent: "gemini", user: "u1" });
  store.commit({ t: "agent.follow", agent: "claude", user: "u1" });
  check(state.agents.gemini && state.sessions["g-1"] && state.procs["gemini-1"] === "g-1" && state.launches["l-gemini"] && state.agent_follows["gemini|u1"], "a Gemini agent with a thread, a process, a failed start and a follower, before");
  store.commit({ t: "agent.remove", agent: "gemini" });
  check(!state.agents.gemini && !state.sessions["g-1"] && !state.procs["gemini-1"] && !state.launches["l-gemini"] && !state.agent_follows["gemini|u1"], "agent.remove takes the agent, its thread, its process, its start and who follows it");
  check(state.agents.claude && state.sessions["c-1"] && state.procs["box-1"] === "c-1" && state.launches["l-claude"] && state.agent_follows["claude|u1"], "and leaves another agent's as they were");
  store.commit({ t: "agent.remove", agent: "gemini" });
  check(state.agents.claude && Object.keys(state.agents).length === 1, "removing it again does nothing");
  store.close();
}

const port = await freePort(6260);
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTBOOK_HOME: dir, AGENTBOOK_PORT: String(port), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_SERVER", "AGENTBOOK_URL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_OWNER"]) delete env[k];
let cookie = "";
let next = 0;
let out = "";
const server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));
const request = (p: string, body?: unknown) => fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (p: string, body?: unknown): Promise<Json> => {
  const r = await request(p, body);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const status = async (p: string) => (await request(p)).status;
const until = async <T>(f: () => Promise<T> | T, ms = 15000): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await Promise.resolve(f()).catch(() => null);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};
const db = () => sql(path.join(dir, "storage.db"));
const rows = (q: string, ...args: string[]) => (db().prepare(q).get(...args) as { n: number }).n;
const said = () => out + [path.join(dir, "cli", "cli.log")].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("");

try {
  await until(() => fetch(url + "/api/health").then((r) => r.ok));
  const setup = await request("/api/auth/test-person", { username: "owner" });
  cookie = setup.headers.get("set-cookie").split(";")[0];
  // Gemini's agent as its hooks left it: a thread that never ran a turn. Another Gemini agent whose thread did
  // something (a headline), and Claude Code's agent with an empty thread of its own.
  for (const [proc, agent, kind, session_id] of [["gemini-1", "Gemini", "gemini", "g-1"], ["gemini-2", "Gemini Two", "gemini", "g-2"], ["box-1", "Claude", "claude-code", "c-1"]]) {
    await json("/api/hello", { proc, agent, kind, session_id, cwd: dir });
  }
  const posted = await json(`/api/mcp?proc=gemini-2&cwd=${encodeURIComponent(dir)}`, { jsonrpc: "2.0", id: ++next, method: "tools/call", params: { name: "ab_post", arguments: { title: "Looked around" } } });
  check(!posted.result?.isError, "a thread of the second Gemini agent sets its headline");
  const before = await until(async () => (await status("/api/agents/gemini")) === 200 && (await status("/api/sessions/g-1")) === 200 && (await status("/api/agents/gemini-two")) === 200 && rows("select count(*) n from info where key = ?", "agent:gemini") > 0);
  check(before, "before: the page has the Gemini agent, its thread and what its machine said of it");

  await server.restart("agentbook-cli");
  const gone = await until(async () => (await status("/api/agents/gemini")) === 404 && (await status("/api/sessions/g-1")) === 404);
  check(gone, "once agentbook-cli starts again, the Gemini agent and its empty thread are gone from the page");
  check(await until(() => rows("select count(*) n from info where key = ?", "agent:gemini") === 0), "and what its machine said of it (its info) is gone too");
  check((await status("/api/agents/gemini-two")) === 200 && (await status("/api/sessions/g-2")) === 200, "a Gemini agent whose thread did something stays, with its thread");
  check((await status("/api/agents/claude")) === 200 && (await status("/api/sessions/c-1")) === 200, "Claude Code's agent and its empty thread stay");
  check(/removed Gemini, as agentbook no longer runs gemini \(1 empty thread\)/.test(said()), "its log says it removed Gemini and why");
  check(/Gemini Two stays, though agentbook no longer runs gemini: thread g-2 has something in it/.test(said()), "and why Gemini Two stays");

  await server.restart("agentbook-server");
  await server.restart("agentbook-cli");
  await until(async () => (await status("/api/agents/claude")) === 200);
  check((await status("/api/agents/gemini")) === 404 && (await status("/api/sessions/g-1")) === 404, "after both restart, it's still gone");
  check(rows("select count(*) n from agents where id = ?", "gemini") === 0 && rows("select count(*) n from sessions where id = ?", "g-1") === 0, "and its rows are gone, on the machine and on the server");
  check(rows("select count(*) n from agents where id = ?", "gemini-two") > 0, "while the one that stays keeps its rows");
} catch (e) {
  check(false, `threw: ${e.stack || e}`);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) console.log(out.slice(-4000));
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
