#!/usr/bin/env node
// The tests' people (server/api/test-people.ts): the route the harness makes people with, and that no real
// agentbook has. The first person is the page's, and its machine logs in as them; a name it has signs them in again;
// any other name is another person. Only the harness's secret makes anyone, and a server not told to has no route.
// Run: node test/test-people.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { halves, spawnAgentbook, TEST_PEOPLE, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const PORT = testPort(7500);
const URL = `http://127.0.0.1:${PORT}`;
const homes: string[] = [];
const envFor = (more: NodeJS.ProcessEnv = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-test-people-"));
  homes.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_HOME: home, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", ...more };
  for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL"]) delete env[k];
  return env;
};

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie, base = URL }: { body?: unknown; cookie?: string; base?: string } = {}): Promise<Json> {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get("set-cookie") || "";
  return { status: r.status, cookie: setCookie.split(";")[0], ...((await r.json().catch(() => ({}))) as Json) };
}
async function up() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stop(server: ReturnType<typeof spawnAgentbook>) {
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
}

let server = spawnAgentbook({ env: envFor() });
try {
  await up();
  const herval = await req("POST", "/api/auth/test-person", { body: { username: "herval", display_name: "Herval" } });
  check(herval.status === 200 && herval.first === true && herval.user?.username === "herval", "the first person made is the page's");
  check(herval.user?.role === "admin", "…and its person, as the first account was");
  const me = await req("GET", "/api/auth/me", { cookie: herval.cookie });
  check(me.user?.id === herval.user?.id, "…signed in");
  const status = (await (await fetch(`http://127.0.0.1:${halves(PORT).cli}/api/status`)).json()) as Json;
  check(status.server && status.connected, "its machine logged in as them before the test heard back");

  const bo = await req("POST", "/api/auth/test-person", { body: { username: "bo" } });
  check(bo.status === 200 && bo.first === false && bo.user?.role === "member" && bo.user.id !== herval.user.id, "another name is another person");
  const again = await req("POST", "/api/auth/test-person", { body: { username: "herval" } });
  check(again.user?.id === herval.user.id && again.cookie && again.cookie !== herval.cookie, "a name it has signs that person in again, in a session of its own");

  const server2 = `http://127.0.0.1:${halves(PORT).server}`;
  check((await req("POST", "/api/auth/test-person", { base: server2, body: { username: "eve" } })).status === 403, "the server's own port makes nobody without the harness's secret");
  check((await req("POST", "/api/auth/test-person", { base: server2, body: { username: "eve", test: "guessed" } })).status === 403, "…or with another");
  check((await req("POST", "/api/auth/test-person", { base: server2, body: { username: "eve", test: TEST_PEOPLE } })).status === 200, "…and makes them with it");
} finally {
  await stop(server);
}

server = spawnAgentbook({ env: envFor({ AGENTBOOK_TEST_PEOPLE: "0" }) });
try {
  await up();
  const r = await req("POST", "/api/auth/test-person", { body: { username: "herval" } });
  check(r.status === 404, "an agentbook the harness didn't turn it on for has no such route");
  check((await req("GET", "/api/auth/me")).user === null, "…and nobody was made");
} finally {
  await stop(server);
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
