#!/usr/bin/env node
// A page whose relay doesn't answer as it starts (agentbook-relay sleeps when nobody uses it, and one that woke as a
// page started once lost its call): the call ends at its deadline (plugin/shared/machine-login.ts relayCall), the
// page says so and renews again shortly (server/mesh.ts), clears the address it told the relay before your machines
// met over iroh, and says it's on the account.
// Run: node test/mesh-relay-asleep.ts

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnAgentbook, spawnTied } from "./harness.ts";
import { fakeRelay } from "./fake-relay.ts";

process.env.AGENTBOOK_RELAY_TIMEOUT_MS = "1000";
const { relayCall } = await import("../plugin/shared/machine-login.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-asleep-")));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, ms = 15e3): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

const relay = await fakeRelay();
relay.person = { sub: "google:2", acct: crypto.randomUUID(), email: "ada@example.com", name: "Ada" };

// The call itself: one the relay never answers ends at its deadline, said as such.
relay.stalls = 1;
const t0 = Date.now();
const lost = await relayCall(relay.url, "GET", "/machines").then(
  () => "answered",
  (e) => e.message,
);
check(/didn't answer in 1 s/.test(lost) && Date.now() - t0 < 3000, `a call the relay never answers ends at its deadline (${lost})`);

const port = await freePort(6650, 40);
const home = path.join(BASE, "solo");
fs.mkdirSync(path.join(home, "cli"), { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTBOOK_RELAY_URL: relay.url,
  AGENTBOOK_RELAY_TIMEOUT_MS: "1000",
  AGENTBOOK_LINK_RETRY_MS: "500",
  HOME: path.join(BASE, "person"),
  CLAUDE_CONFIG_DIR: path.join(BASE, "person", ".claude"),
  AGENTBOOK_HARNESS_ONE: "1",
  AGENTBOOK_CLAUDE: "/usr/bin/false",
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_DSH: "0",
  AGENTBOOK_NOTIFY: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_DESKTOP_DIRS: "",
  AGENTBOOK_PORT: String(port),
  AGENTBOOK_HOME: home,
  AGENTBOOK_MACHINE: "solo",
  AGENTBOOK_URL: `http://localhost:${port}`,
};
const login = await new Promise<number | null>((resolve) => {
  const child = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "login", "--no-open", "--no-start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let answered = false;
  const take = (b: Buffer) => {
    out += b;
    const code = /\b([B-Z]{4}-[B-Z]{4})\b/.exec(out)?.[1];
    if (code && !answered) {
      answered = true;
      setTimeout(() => relay.approve(code), 50);
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("exit", resolve);
});
check(login === 0, "solo logs in to the account");
const certificate = JSON.parse(fs.readFileSync(path.join(home, "machine.json"), "utf8")).certificate;

const log = path.join(BASE, "solo.log");
// What an agentbook from before iroh told the relay: where its page answered.
relay.machines(relay.person.acct)[0].addresses = ["https://solo.example-net.ts.net:8443"];
relay.stalls = 1;
const solo = spawnAgentbook({ env, stdio: ["ignore", fs.openSync(log, "a"), fs.openSync(log, "a")] });
try {
  const said = () => fs.readFileSync(log, "utf8");
  check(await until(() => /mesh: couldn't renew this machine's certificate with the relay: agentbook's relay at \S+ didn't answer in 1 s/.test(said())), "its first renewal, which the relay never answers, ends, and it says so");
  check(await until(() => relay.machines(relay.person.acct)[0]?.addresses?.length === 0), "it renews again shortly, and clears the address it told the relay before: nothing asks for it now");
  check(JSON.parse(fs.readFileSync(path.join(home, "machine.json"), "utf8")).certificate !== certificate, "with a fresh certificate kept");
  check(await until(() => /mesh: on your agentbook account as "solo", at http:\/\/localhost:\d+; 0 other machines on it/.test(said())), "and says it's on the account");
} finally {
  solo.kill();
  await sleep(500);
  await relay.close();
}
console.log(failures ? `\n${failures} check(s) failed (logs in ${BASE})` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
