#!/usr/bin/env node
// The plugin's MCP server is a bridge to the one agentbook serves (/api/mcp). Against an agentbook from before
// /api/mcp (one still running from before an update), Claude Code gets no tools and is told why, and once
// agentbook answers /api/mcp (restarted), the bridge says the tools changed and lists them.
// Run: node test/mcp-bridge.ts

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { testPort } from "./harness.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const PORT = testPort(5200);

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

// An agentbook that's up but knows no /api/mcp, until it's "restarted".
let restarted = false;
const asked = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/health") return json(200, { ok: true, name: "agentbook", cli: true, version: "99.0.0" });
  if (url.pathname !== "/api/mcp" || !restarted) return json(404, { error: "No such endpoint" });
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body);
    asked.push({ msg, proc: url.searchParams.get("proc"), cwd: url.searchParams.get("cwd") });
    if (msg.method === "tools/list") return json(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ab_post", inputSchema: { type: "object" } }] } });
    json(200, { jsonrpc: "2.0", id: msg.id, result: {} });
  });
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

// A folder of its own: in the person's, an agentbook-cli that has proved itself makes this stand-in one to stop.
const HOME = (await import("node:fs")).mkdtempSync(path.join((await import("node:os")).tmpdir(), "agentbook-bridge-"));
const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_URL: `http://127.0.0.1:${PORT}`, AGENTBOOK_PID: "777001", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PROJECT_DIR: "/tmp/somewhere" };
delete env.AGENTBOOK_CHANNEL;
delete env.AGENTBOOK_PROC;
const bridge = spawn(process.execPath, [path.join(ROOT, "mcp", "server.ts")], { env, stdio: ["pipe", "pipe", "ignore"] });
const seen = [];
readline.createInterface({ input: bridge.stdout }).on("line", (line) => seen.push(JSON.parse(line)));
const send = (msg) => bridge.stdin.write(JSON.stringify(msg) + "\n");
const answer = (id) => until(() => seen.find((m) => m.id === id), 5000);

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const init = await answer(1);
  const before = await answer(2);
  check(/older agentbook/.test(init?.result?.instructions) && /agentbook-cli down/.test(init.result.instructions), "an agentbook without /api/mcp: Claude Code is told why its tools aren't there, and how to restart it");
  check(init?.result?.capabilities?.tools?.listChanged === true && before?.result?.tools?.length === 0, "it lists no tools, and says it will tell when they change");
  restarted = true;
  check(await until(() => seen.some((m) => m.method === "notifications/tools/list_changed"), 8000), "once agentbook answers /api/mcp, the bridge says the tools changed");
  send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const after = await answer(3);
  check(after?.result?.tools?.map((t) => t.name).join() === "ab_post", "and Claude Code asking again gets them");
  const host = (await import("node:os")).default.hostname().split(".")[0];
  check(asked.at(-1)?.proc === `${host}-777001` && asked.at(-1)?.cwd === "/tmp/somewhere", "the bridge says which Claude Code process it is, and the folder its paths are in");
} finally {
  bridge.kill();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
