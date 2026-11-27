#!/usr/bin/env node
// Self-service profiles through the real MCP/CLI/server path: scoped to the caller, validated together,
// visible with the agent, and kept across a server restart. Run: node test/agent-profile.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, halves, spawnAgentbook } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-profile-"));
const port = await freePort(6200);
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTBOOK_HOME: dir, AGENTBOOK_PORT: String(port), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_SERVER", "AGENTBOOK_URL", "AGENTBOOK_PROC", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_OWNER"]) delete env[k];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=", "base64");
fs.writeFileSync(path.join(dir, "face.png"), png);
fs.writeFileSync(path.join(dir, "bad.svg"), "<svg onload='alert(1)'/>");
fs.writeFileSync(path.join(dir, "large.png"), Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
fs.writeFileSync(path.join(dir, ".env"), "TOKEN=not-a-picture");
let cookie = "", log = "", next = 0;
const server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const request = (p: string, body?: unknown, as = cookie) => fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { ...(as ? { cookie: as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (p: string, body?: unknown, as?: string): Promise<Json> => {
  const r = await request(p, body, as);
  return { status: r.status, ...((await r.json()) as Json) };
};
const until = async <T>(f: () => Promise<T>, ms = 10000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await f().catch(() => null);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out");
};
const rpc = async (proc: string, method: string, params: object): Promise<Json> => (await json(`/api/mcp?proc=${encodeURIComponent(proc)}&cwd=${encodeURIComponent(dir)}`, { jsonrpc: "2.0", id: ++next, method, params })).result;
const call = (proc: string, args = {}) => rpc(proc, "tools/call", { name: "ab_profile", arguments: args });
const resultProfile = (r: Json) => {
  assert(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text.split("\n").slice(1).join("\n"));
};
const profile = (proc = "box-1") => call(proc).then(resultProfile);
const pass = (s: string) => console.log(`PASS  ${s}`);

try {
  await until(() => fetch(url + "/api/health").then((r) => r.ok));
  const setup = await request("/api/auth/test-person", { username: "owner" });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie").split(";")[0];
  for (const [proc, agent, session_id] of [["box-1", "Claude", "thread-1"], ["box-2", "Claude", "thread-2"], ["codex:thread-3", "Codex", "thread-3"]]) {
    assert.equal((await json("/api/hello", { proc, agent, session_id, cwd: dir })).status, 200);
  }
  const listed = await rpc("codex:thread-3", "tools/list", {});
  const schema = listed.tools.find((t) => t.name === "ab_profile")?.inputSchema;
  assert(schema && !schema.properties.agent && schema.additionalProperties === false);
  const first = await profile();
  assert.equal(first.agent, "claude");
  assert.equal(first.bio, "");
  assert.equal(first.avatar, null);
  pass("MCP offers a self-scoped tool and reads the current profile without changing it");

  let p = resultProfile(await call("box-1", { bio: "I build things.\n<script>plain text</script>", emoji: "🦉" }));
  assert.equal(p.avatar.emoji, "🦉");
  assert.equal((await profile("box-2")).bio, p.bio);
  assert.equal((await json("/api/q/side")).records["agent:claude"].bio, p.bio);
  assert.equal((await profile("codex:thread-3")).bio, "");
  const codex = resultProfile(await call("codex:thread-3", { bio: "Codex's own profile." }));
  assert.equal(codex.agent, "codex");
  assert.equal((await profile()).bio, p.bio);
  pass("threads of one agent share a profile; Codex updates only its own");

  const signup = await request("/api/auth/test-person", { username: "viewer" });
  const viewer = signup.headers.get("set-cookie").split(";")[0];
  assert.equal((await json("/api/agents/claude", undefined, viewer)).status, 404);
  await json("/api/agents/claude/visibility", { visibility: "public" });
  assert.equal((await json("/api/agents/claude", undefined, viewer)).status, 404);
  // A public agent is for its owner's contacts.
  await json("/api/people/owner/contact", { act: "ask" }, viewer);
  await json("/api/people/viewer/contact", { act: "yes" });
  assert.equal((await json("/api/agents/claude", undefined, viewer)).agent.bio, p.bio);
  assert.equal((await json("/api/q/side", undefined, viewer)).records["agent:claude"].bio, p.bio);
  assert.equal((await json("/api/cli/ask/profile", { post: "thread-1", bio: "Not yours" }, viewer)).status, 403);
  pass("the bio follows profile visibility, to the owner's contacts, and a viewer cannot use the machine endpoint");

  const named = await json("/api/agents/claude/name", { name: "  Nightjar " });
  assert.equal(named.status, 200);
  assert.equal(named.name, "Nightjar");
  for (const name of ["", "   ", "x".repeat(81), "two\nlines", null]) assert.equal((await json("/api/agents/claude/name", { name })).status, 400, JSON.stringify(name));
  assert.equal((await json("/api/agents/claude/name", { name: "Mine now" }, viewer)).status, 403);
  assert.equal((await json("/api/agents/codex/name", { name: "Hidden" }, viewer)).status, 404);
  assert.equal((await json("/api/agents/nobody/name", { name: "Nobody" })).status, 404);
  assert.equal((await json("/api/hello", { proc: "box-1", agent: "Claude", session_id: "thread-1", cwd: dir })).status, 200);
  assert.equal((await json("/api/agents/claude")).agent.name, "Nightjar");
  assert.equal((await json("/api/q/side", undefined, viewer)).records["agent:claude"].name, "Nightjar");
  assert.equal((await json("/api/agents/codex")).agent.name, "Codex");
  pass("its owner renames an agent, others can't, bad names are refused, and its thread saying hello again keeps the name");

  p = resultProfile(await call("box-1", { path: "face.png" }));
  assert.equal(p.bio, "I build things.\n<script>plain text</script>");
  assert.equal(p.avatar.type, "image/png");
  const photo = await request(`/api/agents/claude/avatar?v=${p.avatar.image}`, undefined, viewer);
  assert.equal(photo.status, 200);
  assert(Buffer.from(await photo.arrayBuffer()).equals(png));
  const withPicture = resultProfile(await call("box-1", { bio: "New bio" }));
  assert.deepEqual(withPicture.avatar, p.avatar);
  pass("local images reach the profile and changing only one field preserves the other");

  const invalid = [
    { bio: "x".repeat(501) }, { bio: null }, { emoji: "a sentence" }, { reset_picture: "yes" },
    { path: "face.png", emoji: "🦉" }, { path: "face.png", reset_picture: true },
    { bio: "must not stick", path: "bad.svg" }, { path: "large.png" }, { path: "missing.png" }, { path: ".env" },
    { bio: "Hijack", agent: "codex" }, { post: "thread-3", bio: "Hijack" }, { avatar: null },
  ];
  for (const args of invalid) assert((await call("box-1", args)).isError, JSON.stringify(args));
  assert.deepEqual(await profile(), withPicture);
  assert.equal((await json("/api/procs/box-1/profile", { bio: "Hijack", agent: "codex" })).status, 400);
  assert.equal((await json("/api/procs/box-1/profile", { bio: "Bad bytes", content_base64: Buffer.from("not a picture").toString("base64") })).status, 400);
  assert.equal((await json("/api/procs/unknown/profile", { bio: "No thread" })).status, 404);
  assert.deepEqual(await profile(), withPicture);
  pass("bad input, oversized images and targeting another agent fail without partial changes");

  // The server also validates the caller and picture when a machine calls it directly.
  const device = JSON.parse(fs.readFileSync(path.join(dir, "cli", "device.json"), "utf8"));
  const machine = async (body: object) => {
    const r = await fetch(`http://127.0.0.1:${halves(port).server}/api/cli/ask/profile`, { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, ...((await r.json()) as Json) };
  };
  assert.equal((await machine({ post: "thread-1", agent: "codex", bio: "Hijack" })).status, 400);
  assert.equal((await machine({ post: "missing", bio: "Nobody" })).status, 404);
  assert.equal((await machine({ post: "thread-1", bio: "No partial update", blob: "a".repeat(64) })).status, 400);
  assert.deepEqual(await profile(), withPicture);
  pass("the server resolves the agent from the authenticated machine's thread and validates the image");

  await server.restart("agentbook-server");
  await until(() => json("/api/agents/claude").then((r) => r.agent?.bio === "New bio"));
  assert.deepEqual(await profile(), withPicture);
  const restored = await request(`/api/agents/claude/avatar?v=${withPicture.avatar.image}`);
  assert(Buffer.from(await restored.arrayBuffer()).equals(png));
  assert.equal((await json("/api/agents/claude")).agent.name, "Nightjar");
  pass("bio, image and name survive restarting agentbook-server");

  const cleared = resultProfile(await call("box-1", { bio: "", reset_picture: true }));
  assert.equal(cleared.bio, "");
  assert.equal(cleared.avatar, null);
  assert.equal((await profile("codex:thread-3")).bio, "Codex's own profile.");
  pass("clearing the bio and resetting the picture leave other agents untouched");
} catch (e) {
  console.error(e);
  console.error(log.slice(-10000));
  process.exitCode = 1;
} finally {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited;
  fs.rmSync(dir, { recursive: true, force: true });
}
