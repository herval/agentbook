#!/usr/bin/env node
// Guest launches must carry the browser's mode all the way to Codex's sandbox and approval reviewer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-guest-modes-"));
const port = testPort(4660);
const url = `http://127.0.0.1:${port}`;
const sock = path.join(taskHome, "codex.sock");
const log = path.join(taskHome, "codex.jsonl");
const project = path.join(taskHome, "project");
fs.mkdirSync(project);
fs.mkdirSync(path.join(taskHome, "cli"));
fs.writeFileSync(path.join(taskHome, "cli", "gate.json"), JSON.stringify({ folders: [taskHome], starts_per_hour: 1000 }));
const env = {
  ...process.env,
  AGENTBOOK_HOME: taskHome,
  AGENTBOOK_PORT: String(port),
  AGENTBOOK_URL: url,
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: "/usr/bin/false",
  AGENTBOOK_CODEX_SOCK: sock,
  AGENTBOOK_CODEX_SYNC_MS: "300",
  AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"),
  FAKE_CODEX_CLI_LOG: path.join(taskHome, "codex-cli.jsonl"),
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_CODEX"]) delete env[k];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>): Promise<T> {
  for (const end = Date.now() + 8000;; await sleep(100)) {
    const result = await fn();
    if (result || Date.now() > end) return result;
  }
}
let cookie = "";
async function request(p: string, body?: object): Promise<Json> {
  const r = await fetch(url + p, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, ...await r.json() as Json };
}
const calls = (): Json[] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
const starts = () => calls().filter((c) => c.method === "thread/start");
const fake = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), sock, log, project], { stdio: "ignore" });
await until(() => fs.existsSync(sock));
const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
try {
  assert.ok(await until(async () => (await fetch(url + "/api/health").catch(() => null))?.ok));
  const login = await fetch(url + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(await until(async () => (await request("/api/sessions/th-live")).rt?.name === "Codex"));
  const modes = {
    auto: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" },
    ask: { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" },
    plan: { approvalPolicy: "never", sandbox: "read-only" },
    full: { approvalPolicy: "never", sandbox: "danger-full-access" },
  };
  for (const route of ["session", "talk"]) {
    const talk = route === "talk" ? await request("/api/talks", { text: "Review this checkout" }) : null;
    const endpoint = talk ? `/api/talks/${talk.id}/send` : "/api/sessions/th-live/guests";
    const body = talk ? { mid: talk.mid, agent: "codex" } : { text: "Review this checkout", agent: "codex" };
    const before = starts().length;
    const bad = await request(endpoint, { ...body, mode: "invalid" });
    assert.equal(bad.status, 400);
    assert.equal(starts().length, before);
    if (talk) assert.equal((await request(`/api/q/thread/${talk.id}`)).records[`thread:${talk.id}`].guests.length, 0);
    console.log(`PASS ${route} rejects an invalid mode before adding or launching a guest`);

    for (const [mode, settings] of Object.entries(modes)) {
      const mark = calls().length;
      const sent = await request(endpoint, { ...body, mode });
      assert.equal(sent.status, 200, JSON.stringify(sent));
      const start = await until(() => calls().slice(mark).find((c) => c.method === "thread/start"));
      assert.ok(start, `${route} ${mode} started Codex`);
      for (const [key, value] of Object.entries(settings)) assert.equal(start.params[key], value, `${route} ${mode} ${key}`);
      const turn = await until(() => calls().slice(mark).find((c) => c.method === "turn/start"));
      assert.ok(turn);
      const id = turn.params.threadId;
      assert.equal((await request(`/api/sessions/${id}`)).mode, mode);

      if (talk) {
        const count = starts().length;
        assert.equal((await request(endpoint, { ...body, mode: mode === "full" ? "plan" : "full" })).status, 200);
        assert.equal(starts().length, count);
        assert.equal((await request(`/api/sessions/${id}`)).mode, mode);
      }
      const remove = talk ? `/api/talks/${talk.id}/guests` : "/api/sessions/th-live/guests";
      assert.equal((await request(remove, { remove: id })).status, 200);
      console.log(`PASS ${route} guest preserves ${mode} through Codex launch${talk ? " and later messages" : ""}`);
    }
  }
} finally {
  server.kill();
  fake.kill();
}
