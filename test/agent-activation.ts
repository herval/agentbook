#!/usr/bin/env node
// Deactivation blocks every way agentbook starts a thread, including starts waiting for an offline machine.
// Existing conversations still take messages. Run: node test/agent-activation.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "../server/relay.ts";
import { freePort, spawnAgentbook } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-activation-"));
const accounts = { byId: (id: string) => ({ id, username: id }), deviceById: () => null };
let relay = createRelay({ home: path.join(dir, "relay"), accounts });
const pass = (what: string) => console.log(`PASS  ${what}`);
const seed = (D: ReturnType<typeof relay.device>) => {
  D.store.commit({ t: "session.hello", proc: "box", session_id: "existing", agent: "claude", agent_name: "Claude", kind: "claude-code" });
  D.store.commit({ t: "agent.hello", agent: "codex", agent_name: "Codex", kind: "codex" });
};
const until = async <T>(fn: () => Promise<T>, ms = 10000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await fn().catch(() => null);
    if (got) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out");
};

try {
  let D = relay.device("d1", { name: "brick", user_id: "owner" });
  seed(D);
  const start = (lid: string, agent = "claude") => ({ lid, agent, prompt: "Do the work" });
  const queued = await relay.command(D, "post.start", start("before"));
  const side = await relay.command(D, "post.side", { post: "existing", text: "Fork it" });
  const message = await relay.command(D, "post.deliver", { post: "existing", text: "Continue" });
  assert(queued.queued && side.queued && message.queued);
  D.store.commit({ t: "agent.hidden", agent: "claude", hidden: true });
  assert.deepEqual(relay.waiting(D).map((c) => c.cid), [message.queued]);
  assert.equal(D.seen, 0);
  assert(relay.failedStarts(D).some((c) => c.args.lid === "before" && c.result.status === 409));
  assert.equal((await relay.command(D, "post.start", start("after"))).status, 409);
  assert.equal((await relay.command(D, "post.side", { post: "existing", text: "Fork it" })).status, 409);
  assert.equal((await relay.command(D, "cloud.pull", { ref: "https://claude.ai/code/session_abc" })).status, 409);
  for (const action of ["run", "resume"]) assert.equal((await relay.command(D, "routine.do", { agent: "claude", job: "job", action })).status, 409);
  for (const action of ["pause", "stop"]) assert((await relay.command(D, "routine.do", { agent: "claude", job: "job", action })).queued);
  assert((await relay.command(D, "post.stop", { post: "existing" })).queued);
  assert((await relay.command(D, "post.start", start("other-agent", "codex"))).queued);
  D.store.commit({ t: "agent.hidden", agent: "codex", hidden: true });
  assert.equal((await relay.command(D, "cloud.pull", { ref: "https://chatgpt.com/codex/tasks/task_e_abc" })).status, 409);
  const other = relay.device("d2", { name: "laptop", user_id: "owner" });
  seed(other);
  assert((await relay.command(other, "post.start", start("other-machine"))).queued);
  pass("deactivation cancels queued starts and blocks starts, forks, imports and routine starts without touching messages, stops or other agents and machines");

  const signed = { envelope: { v: 1, machine: "brick", cid: "sActivation001", kind: "post.start", args: start("signed"), by: "owner", at: new Date().toISOString(), expires: new Date(Date.now() + 60000).toISOString() }, sig: {} };
  assert.equal((await relay.command(D, "post.start", start("decoy", "other"), { signed })).status, 409);
  D.store.commit({ t: "agent.hidden", agent: "claude", hidden: false });
  D.seen = D.polled = Date.now();
  const pending = relay.command(D, "post.start", start("pending"), { wait: 5000 });
  D.store.commit({ t: "agent.hidden", agent: "claude", hidden: true });
  assert.equal((await pending).status, 409);
  D.store.commit({ t: "agent.hidden", agent: "claude", hidden: false });
  const active = await relay.command(D, "post.start", start("active"), { wait: 0 });
  assert(active.queued);
  D.store.state.agents.claude.hidden = true;
  assert(!(await relay.takeCommands(D, 0, { closed: false })).some((c) => c.cid === active.queued));
  pass("signed commands use their real target, waiting callers hear the refusal, activation permits starts, and dispatch rechecks deactivation");

  D.store.commit({ t: "agent.hidden", agent: "claude", hidden: false });
  D.seen = D.polled = 0;
  assert((await relay.command(D, "post.start", start("before-upgrade"))).queued);
  D.store.state.agents.claude.hidden = true;
  D.store.checkpoint(true);
  for (const d of relay.devices.values()) d.store.close();
  relay = createRelay({ home: path.join(dir, "relay"), accounts });
  D = relay.device("d1", { name: "brick", user_id: "owner" });
  assert(!relay.waiting(D).some((c) => c.kind === "post.start"));
  assert.equal((await relay.command(D, "post.start", start("restarted"))).status, 409);
  assert.equal(relay.view(D).agents.find((a) => a.id === "claude").inactive, true);
  pass("deactivation persists and old queued starts are refused when the server restarts");

  const home = path.join(dir, "app");
  const project = path.join(dir, "project");
  const fake = path.join(dir, "fake");
  const claude = path.join(dir, "claude");
  for (const p of [home, project, fake, claude]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(fake, "agents.json"), "[]");
  fs.writeFileSync(path.join(claude, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  const port = await freePort(6200);
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AGENTBOOK_HOME: home, AGENTBOOK_PORT: String(port), AGENTBOOK_MACHINE: "brick", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: fake, CLAUDE_CONFIG_DIR: claude, AGENTBOOK_ROUTINES_TICK_MS: "100", AGENTBOOK_CLAUDE_ROUTINES: "0" };
  for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_SERVER", "AGENTBOOK_URL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_OWNER"]) delete env[k];
  let cookie = "", log = "";
  const server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => log += d);
  server.stderr.on("data", (d) => log += d);
  const request = (p: string, body?: object, as = cookie) => fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { ...(as ? { cookie: as } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (p: string, body?: object, as = cookie): Promise<Json> => {
    const r = await request(p, body, as);
    return { status: r.status, ...await r.json() as Json };
  };
  try {
    await until(() => fetch(url + "/api/health").then((r) => r.ok));
    const setup = await request("/api/auth/test-person", { username: "owner" });
    cookie = setup.headers.get("set-cookie").split(";")[0];
    assert.equal((await json("/api/hello", { proc: "box", agent: "Claude", session_id: "existing", cwd: project })).status, 200);
    assert.equal((await json("/api/agents/claude/hidden", { hidden: true })).status, 200);
    for (const body of [{ prompt: "Start work", agent: "claude", root: project }, { prompt: "Start work", root: project }, { prompt: "Start work", agent: "claude", page: "new" }]) {
      const blocked = await json("/api/launch", body);
      assert.equal(blocked.status, 409);
      assert.match(blocked.error, /deactivated/);
    }
    assert.equal((await json("/api/sessions/existing/messages", { text: "Fork work", side: true })).status, 409);
    assert.equal((await json("/api/sessions/existing/guests", { agent: "claude", text: "Join work" })).status, 409);
    assert.equal((await json("/api/agents/claude/routines/job", { action: "run" })).status, 409);
    const talk = await json("/api/talks", { text: "Join the conversation" });
    assert.equal((await json(`/api/talks/${talk.id}/send`, { mid: talk.mid, agent: "claude" })).status, 409);
    assert.equal((await json("/api/sessions/existing/messages", { text: "Continue the existing work" })).status, 200);
    const events = await json("/api/procs/box/events");
    assert(JSON.stringify(events).includes("Continue the existing work"));
    const continuation = await json("/api/routines", { name: "Continue existing", prompt: "Routine continues existing work", thread: "existing", schedule: "manual" });
    assert.equal(continuation.status, 200);
    assert.equal((await json(`/api/routines/${continuation.id}/run`, {})).status, 200);
    await until(async () => (await json("/api/sessions/existing")).messages?.some((m) => m.text?.includes("Routine continues existing work")));
    assert.equal((await json("/api/agents/claude/visibility", { visibility: "public" })).status, 200);
    const viewer = await request("/api/auth/test-person", { username: "viewer" });
    // A public agent is for its owner's contacts.
    await json("/api/people/owner/contact", { act: "ask" }, viewer.headers.get("set-cookie").split(";")[0]);
    await json("/api/people/viewer/contact", { act: "yes" });
    const theirs = await json("/api/q/side", undefined, viewer.headers.get("set-cookie").split(";")[0]);
    assert.equal(theirs.records["agent:claude"].inactive, true);
    assert.equal(theirs.records["agent:claude"].hidden, undefined);
    pass("HTTP starts, default-agent starts, page starts, guests, talks and native routine starts return 409, while existing threads still receive messages and viewers see inactivity");

    const routine = await json("/api/routines", { name: "Inactive schedule", prompt: "Start scheduled work", agent: "claude", root: project, schedule: { at: new Date(Date.now() + 1000).toISOString() } });
    assert.equal(routine.status, 200);
    const run = await until(async () => (await json(`/api/routines/${routine.id}`)).runs?.[0]);
    assert.match(run.skipped, /deactivated/);
    assert.equal(run.ok, true);
    assert.equal((await json(`/api/routines/${routine.id}/run`, {})).status, 409);
    assert(!run.lid);
    assert.equal((await json("/api/agents/claude/hidden", { hidden: false })).status, 200);
    const launched = await json("/api/launch", { agent: "claude", prompt: "Start after activation", root: project });
    assert.equal(launched.status, 200, JSON.stringify(launched));
    assert(launched.lid);
    pass("scheduled starts are blocked and activation lets the real HTTP/CLI launch path start a fake runtime again");
  } catch (e) {
    console.error(log.slice(-5000));
    throw e;
  } finally {
    const gone = new Promise((r) => server.once("exit", r));
    server.kill();
    await gone;
  }
} finally {
  for (const D of relay.devices.values()) D.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
