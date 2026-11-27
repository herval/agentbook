#!/usr/bin/env node
// Machines on exe.dev (server/integrations/connectors/exe.ts, server/exe-setup.ts): its owner
// connects their exe.dev account with a token, and Make a machine has exe.dev make a VM and starts a script there that
// installs agentbook and logs it in through the relay. The machine's page shows how that goes, with the code to say
// yes to; Try again starts it over; Wake resumes a paused VM; Delete deletes the VM. Against a stand-in exe.dev
// (test/fake-exe.ts): no script runs, and the machine never comes on (that's the relay's and iroh's, test/mesh.ts).
// Run: node test/exe-machines.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startExe } from "./fake-exe.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-exe-"));
const HUB_PORT = testPort(7050);
const HUB = `http://127.0.0.1:${HUB_PORT}`;

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 10000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), AGENTBOOK_DSH: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLONE_DIR: path.join(BASE, "dev") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete common[k];

const exe = await startExe({ vms: [{ vm_name: "by-hand", status: "running" }] });
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_EXE_API_URL: exe.url, AGENTBOOK_IMAGE_POLL_MS: "150", AGENTBOOK_CLOUD_CONNECT_MS: "4000" };

let COOKIE = "";
const raw = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(HUB + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string) => {
  const r = await raw(p);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (p: string, body: unknown = {}) => {
  const r = await raw(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const machine = async (name: string) => (await stateOf(get)).machines?.find((m) => m.name === name);
const asked = (re: RegExp) => exe.calls.filter((c) => re.test(c.command));

const hub = spawnAgentbook({ env: hubEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
try {
  check(await until(async () => (await fetch(HUB + "/api/health").catch(() => null))?.ok), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- the connector ----------
  const kind = ((await get("/api/connectors")).kinds || []).find((k) => k.kind === "exe");
  check(kind?.machines === true && kind.name === "exe.dev" && kind.scopes?.includes("ssh") && /generate-api-key/.test(kind.about || ""), "exe.dev is a connector that runs machines, and says how to make its token");
  const wrong = await post("/api/connectors", { kind: "exe", api_key: "exe1.not-it" });
  check(/doesn't take this token/.test(wrong.error || wrong.connector?.error || ""), `a token exe.dev refuses says so (${wrong.error || wrong.connector?.error})`);
  const conn = await post("/api/connectors", { ...(wrong.connector?.id ? { id: wrong.connector.id } : { kind: "exe" }), api_key: exe.token });
  const cid = conn.connector?.id;
  check(conn.status === 200 && cid, `a token it takes connects (${conn.error || cid})`);
  check(await until(async () => ((await get("/api/connectors")).connectors || []).find((c) => c.id === cid)?.who === "herval@example.com"), "and says whose account it is");

  // ---------- making a machine ----------
  const made = await post("/api/cloud/machines", { connector: cid, name: "ab-1", repo: "acme/platform", claude: "gateway" });
  check(made.status === 200 && made.machine === "ab-1" && made.setting === true && made.folder === null, `Make a machine on exe.dev answers at once, setting up (${made.error || made.machine})`);
  check(asked(/^new --name=ab-1 --tag=agentbook --json$/).length === 1 && exe.vms.get("ab-1")?.tags?.includes("agentbook"), "exe.dev makes a VM named as the machine, tagged as agentbook's");
  const run = exe.started.find((s) => s.vm === "ab-1");
  const script = run?.script || "";
  check(run?.path === ".agentbook-setup.sh", "and a setup script is written on it and started, in the background");
  check(/git clone -c agentbook\.install=clone 'https:\/\/github\.com\/herval\/agentbook'/.test(script) && /npm install/.test(script), "the script clones agentbook's release repo and installs its packages");
  check(/\.\/bin\/agentbook login --name 'ab-1' --no-open --no-start/.test(script), "it logs the machine in through the relay, as ab-1, with nothing opened and nothing started yet");
  check(script.indexOf("step 'Sign in to your agentbook'") < script.indexOf("step 'agentbook-cli, kept running'") && /Environment=AGENTBOOK_MACHINE=ab-1/.test(script) && /main\.mjs run/.test(script) && /systemctl enable agentbook\.service/.test(script), "then systemd runs agentbook-cli there, as ab-1, after every restart too");
  check(/apiKeyHelper = "printf exe-gateway"/.test(script) && /llm\.int\.exe\.xyz/.test(script), "Claude Code there goes through exe.dev's gateway, as asked");
  check(/git clone 'https:\/\/github\.com\/acme\/platform' "\$HOME\/dev\/\$name"/.test(script), "and the repo is cloned into ~/dev");
  const scriptFile = path.join(BASE, "setup.sh");
  fs.writeFileSync(scriptFile, script);
  const syntax = spawnSync("bash", ["-n", scriptFile], { encoding: "utf8" });
  check(syntax.status === 0, `the script is bash that parses (${syntax.stderr.trim() || "ok"})`);
  const m1 = await machine("ab-1");
  check(m1 && !m1.online && m1.cloud?.kind === "exe" && m1.cloud.made === true && m1.cloud.setting === true && m1.cloud.sandbox === "ab-1", "ab-1 is a machine of yours at once, off, setting up on exe.dev");

  // Its login prints the code to say yes to: the page shows it.
  const waiting = "::step Node\nv24.1.0\n::ok 2\n::step agentbook\n::ok 30\n::step Sign in to your agentbook\nTo add ab-1 to your agentbook, open this, sign in, and check it shows WDJB-MJHT:\n\n    https://relay.test/link?code=WDJB-MJHT\n\nWaiting for you…\n";
  exe.set({ log: { "ab-1": waiting } });
  const shown = await until(async () => (await machine("ab-1"))?.cloud?.login, 8000);
  check(shown?.code === "WDJB-MJHT" && shown.url === "https://relay.test/link?code=WDJB-MJHT", `its page shows the code its login waits on, with the relay's link (${JSON.stringify(shown)})`);

  // Nobody said yes in time: the page says so, and Try again starts it over.
  exe.set({ log: { "ab-1": `${waiting}The code ran out before anyone said yes. Run agentbook login again.\n::failed Sign in to your agentbook\n::end failed 640\n` } });
  const failed = await until(async () => {
    const c = (await machine("ab-1"))?.cloud;
    return c?.setup_error ? c : null;
  }, 8000);
  check(/stopped at Sign in to your agentbook: The code ran out/.test(failed?.setup_error || "") && !failed.login && !failed.setting, `when its code runs out, its page says where it stopped, and no code shows (${failed?.setup_error})`);
  exe.set({ log: { "ab-1": waiting.replace(/WDJB-MJHT/g, "ABCD-EFGH") } });
  const again = await post("/api/machines/ab-1/cloud/setup");
  check(again.status === 200 && exe.started.filter((s) => s.vm === "ab-1").length === 2, "Try again starts its setup over, on the same VM");
  check((await until(async () => (await machine("ab-1"))?.cloud?.login?.code === "ABCD-EFGH", 8000)) && !(await machine("ab-1"))?.cloud?.setup_error, "and the new code shows");

  const dup = await post("/api/cloud/machines", { connector: cid, name: "ab-1" });
  check(dup.status === 409 && /already/.test(dup.error || ""), "a second machine can't take its name");
  const odd = await post("/api/cloud/machines", { connector: cid, name: "x".repeat(70) });
  check(odd.status === 400 && /exe\.dev VM's name/.test(odd.error || ""), `a name exe.dev wouldn't take is turned down here (${odd.error})`);

  // What only boat has.
  const secret = await post("/api/machines/ab-1/cloud/secrets", { name: "OPENAI_API_KEY", value: "sk-1" });
  check(secret.status === 409 && /exe\.dev/.test(secret.error || ""), "secrets are boat's: on exe.dev they're set up on the machine itself");
  const usage = await get("/api/machines/ab-1/cloud/usage");
  check(usage.status === 200 && usage.usage === null, "and there's no usage to show: exe.dev bills a pool by the month");

  // ---------- waking a paused VM ----------
  exe.vms.get("ab-1").status = "paused";
  const woke = await post("/api/machines/ab-1/wake");
  check(woke.status === 200 && woke.waking === true && asked(/^resume ab-1$/).length === 1 && exe.vms.get("ab-1").status === "running", `Wake resumes its paused VM (${woke.error || "waking"})`);

  // ---------- a machine of yours that runs in a VM you made by hand ----------
  const sb = await get(`/api/machines/hub/cloud/sandboxes?connector=${cid}`);
  check(sb.status === 200 && sb.sandboxes?.some((s) => s.id === "by-hand" && s.state === "on"), "your exe.dev VMs are listed, to say which one a machine runs in");
  const linked = await post("/api/machines/hub/cloud", { connector: cid, sandbox: "by-hand" });
  check(linked.status === 200 && linked.cloud?.kind === "exe" && linked.cloud.sandbox === "by-hand", `a machine can be linked to one (${linked.error || "linked"})`);
  const nope = await post("/api/machines/hub/cloud", { connector: cid, sandbox: "Not A VM" });
  check(nope.status === 400 && /exe\.dev VM/.test(nope.error || ""), "a name that can't be a VM's is turned down");
  await post("/api/machines/hub/cloud", { sandbox: "" });

  // ---------- deleting it ----------
  const del = await post("/api/machines/ab-1/cloud/delete");
  check(del.status === 200 && asked(/^rm ab-1$/).length === 1 && !exe.vms.has("ab-1"), `Delete deletes its VM on exe.dev (${del.error || "deleted"})`);
  check(await until(async () => !(await machine("ab-1"))?.online && !(await machine("ab-1"))?.cloud, 8000), "and its login here: it's no machine of yours any more");

  // ---------- a connector with machines, removed ----------
  const two = await post("/api/cloud/machines", { connector: cid, name: "ab-2" });
  check(two.status === 200, "another machine is made");
  const ask = await post(`/api/connectors/${cid}/delete`);
  check(ask.status === 409 && ask.machines?.some((m) => m.name === "ab-2"), "removing the connector asks what becomes of its machine");
  const gone = await post(`/api/connectors/${cid}/delete`, { machines: "delete" });
  check(gone.status === 200 && asked(/^rm ab-2$/).length === 1, `and with delete, its VM is deleted on exe.dev (${gone.error || "removed"})`);
} catch (e) {
  console.log(`FAIL  ${e.stack || e.message}`);
  failures++;
} finally {
  hub.kill();
  await exe.close();
  fs.rmSync(BASE, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nAll passed.");
process.exit(failures ? 1 : 0);
