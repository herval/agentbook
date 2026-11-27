#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentDirectory, agentEnvironment, bindAgentConfig, canonicalAgentDirectory, currentAgentConfig, withAgentConfig } from "../plugin/cli/agent-context.ts";
import { claudeConfigFile } from "../plugin/cli/claude-trust.ts";
import { cleanEnv as daemonEnv } from "../plugin/lib/common.ts";
import { cleanEnv } from "../plugin/cli/drivers/claude.ts";
import { createTranscripts } from "../plugin/cli/transcript.ts";
import { createGate } from "../plugin/cli/gate.ts";
import { freePort, spawnAgentbook } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { AGENT_CONFIGS } from "../plugin/shared/agent-config.ts";
import { codexHome } from "../plugin/cli/runtimes/codex/models.ts";
import type { AgentConfig } from "../plugin/shared/agent-config.ts";
import type { Json } from "./harness-types.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-profiles-"));
const testDir = path.dirname(fileURLToPath(import.meta.url));
const pass = (what: string) => console.log(`PASS  ${what}`);
const until = async <T>(read: () => Promise<T>, ms = 15000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(100); }
  throw new Error("Timed out waiting for profile state");
};
const dirs = ["default", "one", "two"].map(n => path.join(home, n));
for (const d of dirs) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, "agents.json"), "[]"); }
const configs: AgentConfig[] = dirs.slice(1).map((configDir, i) => ({ id: `claude-${i}`, name: `Claude ${i}`, kind: "claude-code", configDir }));
const before = { ...process.env };
await Promise.all(configs.map((config, i) => withAgentConfig(config, async () => {
  await sleep(20 - i * 10);
  assert.equal(agentDirectory("claude-code"), config.configDir);
  assert.equal(agentEnvironment().CLAUDE_CONFIG_DIR, config.configDir);
  assert.equal(cleanEnv().AGENTBOOK_AGENT_ID, config.id);
  assert.equal(claudeConfigFile(), path.join(config.configDir, ".claude.json"));
  assert.equal(bindAgentConfig(config, { nested: { async read() { await sleep(1); return currentAgentConfig()?.id; } } }).nested.read instanceof Function, true);
  assert.equal(await bindAgentConfig(config, { nested: { async read() { await sleep(1); return currentAgentConfig()?.id; } } }).nested.read(), config.id);
})));
assert(JSON.stringify({ ...process.env }) === JSON.stringify(before), "profile scopes leave the process environment unchanged");
assert.equal(currentAgentConfig(), undefined);
for (const kind of ["claude-code", "codex", "hermes", "dsh"] as const) {
  const config: AgentConfig = { ...configs[0], kind };
  withAgentConfig(config, () => {
    const env = agentEnvironment({ AGENTBOOK_CODEX_SOCK: "/default/socket" });
    assert.equal(env[AGENT_CONFIGS[kind].env], config.configDir);
    assert.equal(agentDirectory(kind), config.configDir);
    const restored = daemonEnv({}, env);
    assert.equal(restored[AGENT_CONFIGS[kind].env], undefined);
    assert.equal(restored.AGENTBOOK_AGENT_ID, undefined);
    assert.equal(restored.AGENTBOOK_PROFILE_BASE, undefined);
    assert.equal(restored.AGENTBOOK_CODEX_SOCK, "/default/socket");
    if (kind === "codex") { assert.equal(codexHome(), config.configDir); assert.equal(env.AGENTBOOK_CODEX_SOCK, undefined); }
  });
}

fs.symlinkSync(dirs[1], path.join(home, "alias"));
assert.equal(canonicalAgentDirectory(path.join(home, "alias", "new")), canonicalAgentDirectory(path.join(dirs[1], "new")));
assert.throws(() => canonicalAgentDirectory("relative/folder"), /absolute path/);
pass("concurrent agents keep their environment and trust files separate without changing process.env; symlink aliases identify the same configuration");

// A copied native transcript id must resolve within its agent's directory, never another profile's history.
for (const [i, dir] of dirs.slice(1).entries()) {
  const project = path.join(dir, "projects", "project"); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "same.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Profile ${i}` }] } }) + "\n");
}
const transcripts = createTranscripts({ configDir: s => configs.find(c => c.id === s.agent)?.configDir });
for (const config of configs) {
  const session = { id: config.id, agent: config.id, session_id: "same", transcript: null };
  transcripts.digest(session);
  assert.equal(session.transcript, path.join(config.configDir, "projects", "project", "same.jsonl"));
}
pass("transcript recovery searches only the owning agent's config directory");

const wrapper = path.join(home, "claude");
fs.writeFileSync(wrapper, `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR;\nawait import(${JSON.stringify(path.join(testDir, "fake-claude.ts"))});\n`, { mode: 0o755 });
const project = path.join(home, "project"); fs.mkdirSync(project);
createGate({ home: path.join(home, "app") }).allow(project);
const port = await freePort(6280);
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTBOOK_HOME: path.join(home, "app"), AGENTBOOK_MACHINE: "profiles", AGENTBOOK_PORT: String(port), AGENTBOOK_CLAUDE: wrapper, CLAUDE_CONFIG_DIR: dirs[0], AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_ANTIGRAVITY: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE_ROUTINES: "0", AGENTBOOK_RUNTIME_MS: "200" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_SERVER", "AGENTBOOK_URL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_OWNER", "AGENTBOOK_AGENT_ID"]) delete env[k];
const app = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
let log = "", cookie = "";
app.stdout.on("data", d => log += d); app.stderr.on("data", d => log += d);
const request = (p: string, body?: object, as = cookie) => fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { ...(as ? { cookie: as } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (p: string, body?: object, as = cookie): Promise<Json> => { const r = await request(p, body, as); return { status: r.status, ...await r.json() as Json }; };
const state = () => stateOf(json);
try {
  await until(() => fetch(url + "/api/health").then(r => r.ok).catch(() => false));
  const auth = await request("/api/auth/test-person", { username: "owner" }); cookie = auth.headers.get("set-cookie").split(";")[0];
  await until(async () => (await json("/api/runtimes?machine=profiles")).runtimes?.some(r => r.kind === "claude-code" && r.ok));
  const create = (config_dir: string, name = "Claude work") => json("/api/agents?machine=profiles", { kind: "claude-code", name, config_dir });
  assert.equal((await json("/api/agents?machine=profiles", { kind: "claude-code", name: "Denied", config_dir: dirs[1] }, "")).status, 401);
  assert.equal((await json("/api/agents?machine=profiles", { kind: "openclaw", name: "No", config_dir: dirs[1] })).status, 400);
  assert.equal((await create("relative")).status, 400);
  const one = await create(dirs[1]), two = await create(dirs[2]);
  assert.equal(one.status, 200, JSON.stringify(one)); assert.equal(two.status, 200, JSON.stringify(two)); assert.notEqual(one.id, two.id);
  assert.equal((await create(path.join(home, "alias"))).status, 409);
  const added = await until(async () => { const s = await state(); return s.agents?.find(a => a.id === two.id) && s; });
  for (const a of [one, two]) { assert.equal(added.agents.find(x => x.id === a.id).name, "Claude work"); assert.equal(added.agents.find(x => x.id === a.id).config_dir, a.config_dir); }
  pass("owner-only creation adds distinct same-type agents, persists their config directories and rejects duplicate aliases and unsupported types");
  const launches = await Promise.all([one, two].map(a => json("/api/launch", { agent: a.id, root: project, prompt: `Work as ${a.id}` })));
  for (const l of launches) assert.equal(l.status, 200, JSON.stringify(l));
  for (const a of [one, two]) await until(async () => {
    const calls = fs.existsSync(path.join(a.config_dir, "calls.jsonl")) ? fs.readFileSync(path.join(a.config_dir, "calls.jsonl"), "utf8") : "";
    return calls.includes(`Work as ${a.id}`);
  });
  const sessions = [one, two].map(a => JSON.parse(fs.readFileSync(path.join(a.config_dir, "agents.json"), "utf8"))[0]);
  for (const [i, a] of [one, two].entries()) {
    assert(sessions[i]?.sessionId);
    const hook = await json("/api/hello", { proc: `profile-${i}`, agent: "Claude", agent_id: a.id, config_dir: a.config_dir, session_id: sessions[i].sessionId, cwd: project });
    assert.equal(hook.status, 200, JSON.stringify(hook));
  }
  const running = await until(async () => { const s = await state(); return [one, two].every(a => s.sessions?.some(t => t.agent === a.id)) && s; });
  assert.equal(running.agents.filter(a => [one.id, two.id].includes(a.id)).length, 2);
  assert(!fs.readFileSync(path.join(dirs[0], "calls.jsonl"), "utf8").includes("Work as"));
  pass("simultaneous launches run in their own Claude directories, and hooks register under their configured identities");
  const terminal = await json("/api/hello", { proc: "profile-terminal", agent: "Claude", config_dir: path.join(home, "alias"), session_id: "profile-terminal", cwd: project });
  assert.equal(terminal.status, 200);
  const terminalState = await until(async () => (await state()).sessions.find(s => s.id === "profile-terminal"));
  assert.equal(terminalState.agent, one.id);
  pass("a terminal started through a symlink to the config directory joins the same agent");

  const untrusted = path.join(project, "untrusted-new"); fs.mkdirSync(untrusted);
  const blocked = await json("/api/launch", { agent: one.id, root: untrusted, prompt: "Work in the new folder" });
  assert.match(blocked.error, /Workspace not trusted/);
  const failedLaunch = await until(async () => (await state()).launches.find(l => l.agent === one.id && /Workspace not trusted/.test(l.error || "")));
  const trusted = await json(`/api/launches/${failedLaunch.id}/trust`, {});
  assert.equal(trusted.status, 200, JSON.stringify(trusted));
  const settings = JSON.parse(fs.readFileSync(path.join(one.config_dir, ".claude.json"), "utf8"));
  assert.equal(settings.projects[fs.realpathSync(untrusted)].hasTrustDialogAccepted, true);
  assert(!fs.existsSync(path.join(two.config_dir, ".claude.json")));
  assert(!fs.existsSync(path.join(dirs[0], ".claude.json")));
  pass("Trust and retry uses only the selected profile's settings and starts it again on that profile");
  for (const a of [one, two]) fs.writeFileSync(path.join(a.config_dir, "login-code.txt"), "profile-test-code");
  const signins = await Promise.all(sessions.map(s => json(`/api/sessions/${s.sessionId}/claude-login`, { step: "start" })));
  for (const sign of signins) assert.equal(sign.status, 200, JSON.stringify(sign));
  assert.notEqual(signins[0].url, signins[1].url);
  for (const s of sessions) assert.equal((await json(`/api/sessions/${s.sessionId}/claude-login`, { step: "code", code: "profile-test-code" })).status, 200);
  for (const a of [one, two]) assert(fs.existsSync(path.join(a.config_dir, ".credentials.json")));
  assert(!fs.existsSync(path.join(dirs[0], ".credentials.json")));
  pass("sign-in from either thread authenticates only that agent's config directory");
  await app.restart("agentbook-cli");
  await until(async () => (await json("/api/runtimes?machine=profiles")).runtimes?.some(r => r.kind === "claude-code" && r.ok));
  assert.equal((await create(dirs[1])).status, 409);
  const restarted = await state();
  for (const a of [one, two]) assert.equal(restarted.agents.find(x => x.id === a.id).config_dir, a.config_dir);
  const resumed = await json("/api/launch", { agent: two.id, root: project, prompt: "Work after restart" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed));
  await until(async () => fs.readFileSync(path.join(two.config_dir, "calls.jsonl"), "utf8").includes("Work after restart"));
  assert(!fs.readFileSync(path.join(one.config_dir, "calls.jsonl"), "utf8").includes("Work after restart"));
  pass("a daemon restart restores each profile and routes its next launch to the same directory");
  const other = await request("/api/auth/test-person", { username: "other" });
  assert.equal((await json("/api/agents?machine=profiles", { kind: "claude-code", name: "Not mine", config_dir: path.join(home, "denied") }, other.headers.get("set-cookie").split(";")[0])).status, 403);
  assert(!fs.existsSync(path.join(home, "denied")));
  pass("another signed-in person cannot add agents to the owner's machine");
} catch (e) { console.error(log); throw e; }
finally { app.kill(); fs.rmSync(home, { recursive: true, force: true }); }
