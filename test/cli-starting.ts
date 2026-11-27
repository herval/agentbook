#!/usr/bin/env node
// Reconnecting clients can reach the local port while the page is still starting.
// Run: node test/cli-starting.ts
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTied } from "./harness-tied.ts";
import { freePort } from "./harness-ports.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-cli-starting-"));
const port = await freePort(6870, 30);
const preload = path.join(base, "pause.mjs");
// Hold initialization after binding the port, as awaiting the page does in production.
fs.writeFileSync(preload, `
import http from "node:http";
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const ready = args.pop();
  return listen.call(this, ...args, () => {
    process.once("message", () => ready());
    process.send("listening");
  });
};
`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENTBOOK_") && !key.startsWith("CLAUDE_")));
Object.assign(env, { AGENTBOOK_HOME: base, AGENTBOOK_ROOT: base, AGENTBOOK_PORT: String(port), AGENTBOOK_CODEX: "0", AGENTBOOK_DSH: "0", AGENTBOOK_AGY: "0", AGENTBOOK_GROK: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_IROH: "0", CLAUDE_CONFIG_DIR: path.join(base, "claude") });
const child = spawnTied(process.execPath, ["--import", preload, path.join(repo, "plugin/cli/main.mjs"), "run"], { env });
let log = "";
child.stdout.on("data", (data) => (log += data));
child.stderr.on("data", (data) => (log += data));
const request = (upgrade = false): Promise<number> => new Promise((resolve, reject) => {
  const req = http.get({ hostname: "127.0.0.1", port, path: upgrade ? "/api/dsh/plugin" : "/api/health", headers: upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {} }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.setTimeout(1500, () => req.destroy(new Error("startup request hung")));
  req.on("error", reject);
});
try {
  await once(child, "message", { signal: AbortSignal.timeout(10000) });
  const results = await Promise.allSettled([request(), request(true)]);
  child.send("continue");
  assert.equal(results[0].status, "rejected", "HTTP closes until signed replies are available");
  if (results[0].status === "rejected") assert.equal(results[0].reason.code, "ECONNRESET", "HTTP closes promptly rather than hanging");
  assert.equal(results[1].status, "fulfilled", "WebSocket upgrade receives a retryable refusal");
  if (results[1].status === "fulfilled") assert.equal(results[1].value, 503);
  let status = 0;
  for (const end = Date.now() + 10000; !status && Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await request().catch(() => 0);
  }
  assert.equal(status, 200, "the server accepts requests after initialization");
  assert.doesNotMatch(log, /uncaughtException|unhandledRejection/);
  console.log("PASS  HTTP and WebSocket requests are rejected during startup and work after initialization");
} finally {
  const stopped = once(child, "exit");
  child.kill("SIGTERM");
  await stopped;
  fs.rmSync(base, { recursive: true, force: true });
}
