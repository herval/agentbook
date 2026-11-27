#!/usr/bin/env node
// Cloud machines agentbook makes: a sandbox on your boat account
// from an image of yours, that logs itself in as a machine of yours; its secrets on a boat environment of its own,
// their values never kept here; Update to its image's newest version; and Delete. Against a stand-in boat
// (test/fake-boat.ts): when it "starts a sandbox", this test starts an agentbook-cli with the file the sandbox was
// made with, as systemd would there. No script is run for real: the machine's shell is a stand-in too.
// Run: node test/boat-machines.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoat } from "./fake-boat.ts";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-boatm-"));
const HUB_PORT = testPort(7600);
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

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude") , AGENTBOOK_DSH: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLONE_DIR: path.join(BASE, "dev") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete common[k];

// The machine's stand-in shell: it runs no script. It keeps the script it was handed, and writes the log a real
// run would have, as AGENTBOOK_FAKE_SETUP says ("ok" or "failed").
const fakeShell = path.join(BASE, "fake-shell.sh");
fs.writeFileSync(fakeShell, `#!/bin/sh\ncp "$1" "$AGENTBOOK_BUILD_LOG.script"\nsleep 0.4\nif [ "$(cat "$AGENTBOOK_FAKE_SETUP" 2>/dev/null)" = failed ]; then printf '::step agentbook 9.9\\n::ok 1\\n::step Redis\\nE: no redis here\\n::failed Redis\\n::end failed 2\\n' > "$AGENTBOOK_BUILD_LOG"; else printf '::step agentbook 9.9\\n::ok 1\\n::step Redis\\n::ok 1\\n::end ok 2\\n' > "$AGENTBOOK_BUILD_LOG"; fi\n`, { mode: 0o755 });
const setupMode = path.join(BASE, "setup-mode");

// A sandbox "starts": an agentbook-cli with the file it was made with (boat writes it before the machine is ready).
const machines = new Map(); // sandbox id -> { child, home, port }
let nextPort = HUB_PORT + 100;
function startMachine(box, files) {
  const enroll = files.get(`${box.id} /home/user/.agentbook-enroll`);
  const home = path.join(BASE, box.id);
  fs.mkdirSync(path.join(home, "cli"), { recursive: true });
  const m = machines.get(box.id) || { home, port: nextPort++, enrollFile: path.join(home, "enroll") };
  if (enroll && !machines.has(box.id)) fs.writeFileSync(m.enrollFile, enroll);
  m.child = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: { ...common, AGENTBOOK_PORT: String(m.port), AGENTBOOK_HOME: home, AGENTBOOK_ENROLL_FILE: m.enrollFile, AGENTBOOK_ENROLL_EVERY_MS: "200", AGENTBOOK_LINK_POLL_MS: "300", AGENTBOOK_CLOUD_SETUP_SHELL: fakeShell, AGENTBOOK_BUILD_LOG: path.join(home, "build.log"), AGENTBOOK_FAKE_SETUP: setupMode }, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
  machines.set(box.id, m);
  return m;
}
const boat = await startBoat({ onCreate: (box, body, files) => body?.labels?.["agentbook/machine"] && startMachine(box, files), onResume: (id) => startMachine(boat.sandboxes.get(id), boat.files) });
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_BOAT_API_URL: boat.url, AGENTBOOK_CLOUD_ANYWHERE: "1", AGENTBOOK_IMAGE_POLL_MS: "150", AGENTBOOK_CLOUD_CONNECT_MS: "4000" };

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
const machine = async (name) => (await stateOf(get)).machines?.find((m) => m.name === name);
const asked = (method: string, re: RegExp) => boat.calls.filter((c) => c.method === method && re.test(c.path));
const LOG = (parts, end = "ok") => `${parts.map(([l, s, out = ""]) => `::step ${l}\n${out}${out ? "\n" : ""}${s === "ok" ? "::ok 3" : `::failed ${l}`}`).join("\n")}\n::end ${end} 12\n`;
const built = (id, v) => until(async () => (await get("/api/images")).images?.find((i) => i.id === id)?.built?.v === v, 10000);

const hub = spawnAgentbook({ env: hubEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
try {
  check(await until(async () => (await fetch(HUB + "/api/health").catch(() => null))?.ok), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  await post("/api/connectors", { kind: "boat", api_key: boat.key });
  boat.set({ setup: { status: "done", log: LOG([["agentbook 9.9", "ok"]]) } });

  // ---------- a machine with no image of yours: Basic, set up as it starts ----------
  const first = await post("/api/cloud/machines", { connector: "boat", repo: "acme/platform" });
  check(first.status === 200 && first.machine === "boat-platform" && first.image === "basic" && first.v === null && first.setting === true && first.folder === "/work/platform", `In the cloud with a repo and no image makes a machine from Basic, named for the repo (${first.machine || first.error})`);
  const c1 = asked("POST", /^\/sandboxes$/).at(-1);
  check(c1?.body?.name === "boat-platform" && !c1.body.from && c1.body.monitoring === false && c1.body.environment === "agentbook-boat-platform" && c1.body.labels?.["agentbook/machine"] === "boat-platform" && !!c1.headers.idempotency, "its sandbox: monitoring off, an environment of its own, labelled, made once");
  const s1 = c1.body.setupScript || "";
  check(/step 'agentbook /.test(s1) && /step 'acme\/platform'/.test(s1) && /D='\/work\/platform'/.test(s1), "not built, so its setup script installs agentbook and clones the repo, into /work");
  // Your agentbook-cli runs in a seat of yours there from its first start, so the machine can be shared as it is.
  const seatAt = s1.indexOf("seat claim 'herval' --machine 'boat-platform' --enroll \"$HOME/.agentbook-enroll\"");
  check(seatAt > s1.indexOf("step 'agentbook ") && seatAt < s1.indexOf("step 'acme/platform'") && !/agentbook-cli\.service/.test(s1), "your seat on it is made right after agentbook is there (its login lasts ten minutes), and nothing runs agentbook-cli as the sandbox's own user");
  check(/seat refresh \|\| true\n[^\n]*daemon-reload[^\n]*\n\s*sudo systemctl try-restart 'agentbook-cli@\*' agentbook-seats[^\n]*\nfi\nexit 0/.test(s1), "and at its end every seat starts again, with where the tools are now");
  const enroll = JSON.parse(c1.body.files?.find((f) => f.path === ".agentbook-enroll")?.content || "{}");
  check(enroll.server === HUB && enroll.name === "boat-platform" && typeof enroll.poll === "string" && c1.body.files.length === 1, "and one file, its login");
  const env1 = [...boat.environments.values()].find((e) => e.name === "agentbook-boat-platform");
  check(env1 && env1.passGithub === false && env1.passSandboxCredentials === false && env1.passAgentsCredentials === false && env1.safeForThirdParties === false, "its environment passes it none of your account's GitHub, boat credentials or agent logins");
  const on1 = await until(async () => {
    const m = await machine("boat-platform");
    return m?.online ? m : null;
  }, 20000);
  check(!!on1, "it logs itself in and is a machine of yours, On");
  check(on1?.cloud?.made === true && on1.cloud.image === "basic" && on1.cloud.v === null, "made from Basic, unbuilt");
  check(await until(async () => (await machine("boat-platform"))?.cloud?.setting !== true, 10000), "once its setup is done, its page stops saying it's setting up");
  check((await get("/api/images")).images?.some((i) => i.id === "basic" && i.name === "Basic"), "Basic is an image of yours now, to look at or build");
  const dup = await post("/api/cloud/machines", { connector: "boat", repo: "acme/platform" });
  check(dup.status === 409 && /already/.test(dup.error || ""), "a second machine can't take its name");

  // ---------- a machine from a built image, with its secrets ----------
  await post("/api/images", { name: "Shop", connector: "boat", def: { picks: ["redis"], repos: [{ repo: "acme/platform" }], secrets: ["OPENAI_API_KEY", "DATABASE_URL"], env: { NODE_ENV: "development" }, agents: ["codex"] } });
  await post("/api/images/shop/build");
  check(await built("shop", 1), "an image is built");
  const second = await post("/api/cloud/machines", { connector: "boat", image: "shop", name: "Boat Shop", size: "large", secrets: { OPENAI_API_KEY: "sk-test-123", EXTRA: "nope" } });
  check(second.status === 200 && second.machine === "boat-shop" && second.v === 1 && second.setting === true && second.missing?.join() === "DATABASE_URL", `a machine from it starts from its newest built version, and says which secret has no value yet (${second.missing})`);
  const c2 = asked("POST", /^\/sandboxes$/).at(-1);
  const s2 = c2?.body?.setupScript || "";
  check(c2?.body?.from === "agentbook-shop-v1" && c2.body.type === "large" && /seat claim 'herval' --machine 'boat-shop'/.test(s2) && (s2.match(/^step /gm) || []).length === 1 && !/try-restart/.test(s2), "from the saved snapshot at the size picked, with a setup script that only makes your seat");
  check(JSON.parse(c2.body.files[0].content).codex_tools === true, "its login says Codex gets agentbook's tools, as the image picked Codex");
  const env2 = [...boat.environments.values()].find((e) => e.name === "agentbook-boat-shop");
  check(/OPENAI_API_KEY="sk-test-123"/.test(env2?.envContents || "") && /NODE_ENV="development"/.test(env2.envContents) && !/EXTRA/.test(env2.envContents), "boat's environment has the secret's value and the image's settings, and nothing the image didn't ask for");
  const on2 = await until(async () => {
    const m = await machine("boat-shop");
    return m?.online ? m : null;
  }, 20000);
  check(on2?.cloud?.v === 1 && on2.cloud.secrets?.join() === "OPENAI_API_KEY" && on2.cloud.size === "large", "it's On, on v1, and agentbook knows its secret by name");
  const everything = JSON.stringify([await get("/api/machines/boat-shop"), await stateOf(get), await get("/api/images")]);
  const kept = fs.readdirSync(path.join(BASE, "hub", "server"), { recursive: true }).filter((f) => /\.(db|db-wal|json)$/.test(String(f))).some((f) => fs.readFileSync(path.join(BASE, "hub", "server", String(f))).includes("sk-test-123"));
  check(!everything.includes("sk-test-123") && !kept, "its value is nowhere on agentbook: not in any answer, not in the server's data");

  // ---------- its secrets, later ----------
  const set = await post("/api/machines/boat-shop/cloud/secrets", { name: "DATABASE_URL", value: "postgres://shop" });
  check(set.status === 200 && set.secrets.join() === "OPENAI_API_KEY,DATABASE_URL" && /DATABASE_URL="postgres:\/\/shop"/.test(env2.envContents) && /OPENAI_API_KEY="sk-test-123"/.test(env2.envContents) && env2.upgraded > 0, "a secret set later goes to boat alone, the others untouched, and its sandbox is given it");
  const unset = await post("/api/machines/boat-shop/cloud/secrets", { name: "OPENAI_API_KEY" });
  check(unset.status === 200 && unset.secrets.join() === "DATABASE_URL" && !/OPENAI_API_KEY/.test(env2.envContents), "and one is taken away");
  check((await post("/api/machines/boat-shop/cloud/secrets", { name: "bad name", value: "x" })).status === 400 && (await post("/api/machines/boat-platform-nope/cloud/secrets", { name: "A", value: "x" })).status === 404, "a name that isn't one is turned down");

  // ---------- built, with a repo its image lacks ----------
  const third = await post("/api/cloud/machines", { connector: "boat", image: "shop", repo: "acme/ledger" });
  const c3 = asked("POST", /^\/sandboxes$/).at(-1);
  check(third.status === 200 && third.machine === "boat-ledger" && c3.body.from === "agentbook-shop-v1" && /step 'acme\/ledger'/.test(c3.body.setupScript || "") && !/step 'agentbook/.test(c3.body.setupScript) && !/step 'acme\/platform'/.test(c3.body.setupScript), "a repo its image doesn't have is cloned as it starts, and nothing else is run");

  // ---------- a draft ahead of what's built: the machine is what's on its disk ----------
  const cur = (await get("/api/images")).images.find((i) => i.id === "shop");
  await post("/api/images", { id: "shop", def: { ...cur.def, repos: [...cur.def.repos, { repo: "acme/core-api" }], secrets: [...cur.def.secrets, "NOT_BUILT_YET"], env: { ...cur.def.env, DRAFT_ONLY: "1" } } });
  const fourth = await post("/api/cloud/machines", { connector: "boat", image: "shop", repo: "acme/core-api" });
  const c4 = asked("POST", /^\/sandboxes$/).at(-1);
  check(fourth.status === 200 && c4.body.from === "agentbook-shop-v1" && /step 'acme\/core-api'/.test(c4.body.setupScript || ""), `a repo that's only in the image's draft isn't on the built disk, so it's cloned as the machine starts (${fourth.error || fourth.machine})`);
  const env4 = [...boat.environments.values()].find((e) => e.name === "agentbook-boat-core-api");
  check(!fourth.missing?.includes("NOT_BUILT_YET") && !/DRAFT_ONLY/.test(env4?.envContents || "") && /NODE_ENV/.test(env4?.envContents || ""), "and it gets the built version's settings and is asked the built version's secrets, not the draft's");
  await post("/api/images", { id: "shop", def: cur.def });

  // ---------- boat says no ----------
  boat.set({ refuse: { status: 402, code: "billing_required", message: "Billing required" } });
  const envs = boat.environments.size;
  const broke = await post("/api/cloud/machines", { connector: "boat", image: "shop", name: "boat-broke" });
  check(broke.status === 409 && /wallet is empty/.test(broke.error || ""), `when boat won't start it, making it says why (${broke.error})`);
  await sleep(300);
  check(!(await machine("boat-broke")) && boat.environments.size === envs, "and nothing half-made stays: no machine here, no environment on boat");
  boat.set({ refuse: null });

  // ---------- Update: a newer version of its image, on its own disk ----------
  check((await post("/api/machines/boat-shop/cloud/update")).status === 409, "with no newer version built, there's nothing to update to");
  await post("/api/images", { id: "shop", def: { picks: ["redis", "postgres@16"], repos: [{ repo: "acme/platform" }], secrets: ["OPENAI_API_KEY", "DATABASE_URL"], env: { NODE_ENV: "development" }, agents: ["codex"] } });
  await post("/api/images/shop/build");
  check(await built("shop", 2), "version 2 of its image is built");
  fs.writeFileSync(setupMode, "failed");
  const up1 = await post("/api/machines/boat-shop/cloud/update");
  check(up1.status === 200 && up1.started === true, `Update sends the machine version 2's script to run (${up1.error || "started"})`);
  const stopped = await until(async () => (await machine("boat-shop"))?.cloud?.setup_error, 15000);
  check(/stopped at Redis: E: no redis here/.test(stopped || "") && (await machine("boat-shop")).cloud.v === 1, `a script that fails there says where, and the machine stays on v1 (${stopped})`);
  fs.writeFileSync(setupMode, "ok");
  const up2 = await post("/api/machines/boat-shop/cloud/update");
  check(up2.status === 200, "Update again");
  const m2 = machines.get(c2 && [...boat.sandboxes.values()].find((s) => s.name === "boat-shop").id);
  const handed = await until(() => (fs.existsSync(path.join(m2.home, "build.log.script")) ? fs.readFileSync(path.join(m2.home, "build.log.script"), "utf8") : null), 5000);
  check(/step 'PostgreSQL 16'/.test(handed || "") && /step 'agentbook /.test(handed) && /unset AGENTBOOK_GIT/.test(handed) && /try-restart 'agentbook-cli@\*'/.test(handed) && !/seat claim/.test(handed), "the machine ran version 2's whole script, which starts every seat's agentbook-cli again at its end and makes no seat");
  check(await until(async () => (await machine("boat-shop"))?.cloud?.v === 2, 15000), "and once it's done, the machine is on v2");
  const after = (await machine("boat-shop")).cloud;
  check(!after.updating && !after.setup_error, "with nothing left saying it's updating");
  check((await post("/api/machines/boat-shop/cloud/update")).status === 409, "on the newest, there's nothing to update");
  check((await post("/api/machines/hub/cloud/update")).status === 409, "a machine agentbook didn't make has no Update");

  // ---------- Delete ----------
  const box2 = [...boat.sandboxes.values()].find((s) => s.name === "boat-shop").id;
  const del = await post("/api/machines/boat-shop/cloud/delete");
  check(del.status === 200 && !boat.sandboxes.has(box2) && asked("DELETE", /^\/sandboxes\//).at(-1)?.headers.confirm === box2, "Delete deletes its sandbox on boat");
  check(![...boat.environments.values()].some((e) => e.name === "agentbook-boat-shop"), "and its environment, with its secrets");
  check(await until(async () => !(await machine("boat-shop"))?.online && !(await machine("boat-shop"))?.cloud, 8000), "and its login here: it's no machine of yours any more");
  machines.get(box2)?.child.kill();

  // ---------- disconnected by hand: its sandbox stays, unmanaged ----------
  const devices = (await get("/api/devices")).devices || [];
  const led = devices.find((d) => d.name === "boat-ledger");
  const boxL = [...boat.sandboxes.values()].find((s) => s.name === "boat-ledger")?.id;
  const rev = led ? await post(`/api/devices/${led.id}/revoke`) : { status: 0 };
  check(rev.status === 200 && boat.sandboxes.has(boxL) && !(await machine("boat-ledger"))?.cloud, "a machine disconnected by hand keeps its sandbox on boat, and agentbook stops managing it");

  // ---------- removing the connector: what becomes of its machines is yours to say ----------
  const boxP = [...boat.sandboxes.values()].find((x) => x.name === "boat-platform")?.id;
  const ask = await post("/api/connectors/boat/delete");
  check(ask.status === 409 && ask.machines?.length === 2 && ask.machines.some((m) => m.name === "boat-platform" && m.made === true) && (await get("/api/connectors")).connectors?.length === 1, "removing a boat connector with machines asks what becomes of them, and removes nothing yet");
  const gone = await post("/api/connectors/boat/delete", { machines: "delete" });
  check(gone.status === 200 && !boat.sandboxes.has(boxP) && ![...boat.environments.values()].some((e) => e.name === "agentbook-boat-platform"), "delete them: its sandbox and environment go from boat");
  check((await get("/api/connectors")).connectors?.length === 0 && !(await machine("boat-platform"))?.cloud, "and the connector is removed, with nothing left linked to it");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  hub.kill();
  for (const m of machines.values()) m.child?.kill();
  await boat.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
