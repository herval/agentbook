#!/usr/bin/env node
// boat as a connector, past waking (test/boat-wake.ts has waking): its settings, what
// its key can't do, what a machine's sandbox used, and the link surviving a restart. Against a stand-in boat
// (test/fake-boat.ts): the machine's agentbook-cli here is "its sandbox".
// Run: node test/boat-cloud.ts

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoat } from "./fake-boat.ts";
import { type Agentbook, spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-boatc-"));
const HUB_PORT = testPort(7100);
const BOX_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const BOX = `http://127.0.0.1:${BOX_PORT}`;
const SANDBOX = "bx_23456789";
const project = path.join(BASE, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
spawnSync("git", ["-C", project, "init", "-q", "-b", "main"]);

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

let box: Agentbook | null = null;
const boat = await startBoat({ sandboxes: [{ id: SANDBOX, name: "shop", state: "ready" }], onResume: () => (box = serve(boxEnv)) });

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude") , AGENTBOOK_DSH: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLONE_DIR: path.join(BASE, "dev") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete common[k];
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_BOAT_API_URL: boat.url, AGENTBOOK_CLOUD_CONNECT_MS: "2500", AGENTBOOK_CLOUD_AGAIN_MS: "60000", AGENTBOOK_CLOUD_BOOT_MS: "3000", AGENTBOOK_CLOUD_TEND_MS: "0", AGENTBOOK_CLOUD_KEEP_DAYS: String(25000 / 86400e3) };
const boxEnv = { ...common, AGENTBOOK_PORT: String(BOX_PORT), AGENTBOOK_HOME: path.join(BASE, "box"), AGENTBOOK_MACHINE: "boat-shop", AGENTBOOK_URL: BOX, AGENTBOOK_HUB: HUB };
fs.mkdirSync(path.join(BASE, "box", "cli"), { recursive: true });
fs.writeFileSync(path.join(BASE, "box", "cli", "gate.json"), JSON.stringify({ folders: [BASE] }));

let COOKIE = "";
const raw = (base: string, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(base === HUB && COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (base: string, p: string) => {
  const r = await raw(base, p);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (base: string, p: string, body: unknown = {}) => {
  const r = await raw(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
function serve(env: NodeJS.ProcessEnv) {
  return spawnAgentbook({ env, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
}
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 8000);
const hook = (event: string, input: object, env?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...boxEnv, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", ...env } });
const machine = async () => (await stateOf((p) => get(HUB, p))).machines?.find((m) => m.name === "boat-shop");
const asked = (method: string, re: RegExp) => boat.calls.filter((c) => c.method === method && re.test(c.path));
// `gone`: it was told to stop already.
const kill = (p: (ChildProcess & { gone?: boolean }) | null) => {
  if (!p || p.connected === false || p.gone) return;
  p.gone = true;
  p.kill();
};
const gone = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode != null || p.signalCode ? r() : p.once("exit", () => r())));

let hub = serve(hubEnv);
let till: ChildProcess | null = null;
try {
  check(await healthy(HUB), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  const login = await post(HUB, "/api/devices/start", { name: "boat-shop" });
  await post(HUB, "/api/devices/approve", { code: login.code });
  Object.assign(boxEnv, { AGENTBOOK_HUB_TOKEN: (await get(HUB, `/api/devices/poll?poll=${encodeURIComponent(login.poll)}`)).token });
  box = serve(boxEnv);
  check((await healthy(BOX)) && (await until(async () => (await machine())?.online, 10000)), "a machine in a sandbox logs in to it");

  // ---------- the connector: its settings, and what its key can't do ----------
  const kind = ((await get(HUB, "/api/connectors")).kinds || []).find((k) => k.kind === "boat");
  check(kind?.fields?.org && kind.fields.size?.of?.includes("large") && kind.fields.idle?.default === "15" && kind.fields.busy?.default === "8" && kind.scopes?.includes("sandbox.create"), "boat's connector has a wallet, a size, and how long an idle and a busy machine stay up");
  boat.set({ scopes: ["sandbox.read", "sandbox.resume", "account.read"] });
  const conn = await post(HUB, "/api/connectors", { kind: "boat", api_key: boat.key });
  check(conn.status === 200 && conn.connector?.settings?.org === "personal" && conn.connector.settings.size === "default", "a key that only wakes connects, with the settings a new one starts with");
  check(JSON.stringify(conn.connector?.lacks) === JSON.stringify(["snapshot.read", "environment.read"]), `and says what it can't do: read saved snapshots and environments (${conn.connector?.lacks})`);
  boat.set({ scopes: null });
  const full = await post(HUB, "/api/connectors/boat/sync");
  check(full.status === 200 && full.connector?.lacks?.length === 0, "Check its key, once the key has them: nothing's missing");
  const wrong = await post(HUB, "/api/connectors", { id: "boat", settings: { org: "initech" } });
  check(wrong.status === 400 && /no organization called initech/.test(wrong.error || ""), `a wallet boat doesn't know is turned down (${wrong.error})`);
  boat.set({ orgs: ["Acme"] });
  const set = await post(HUB, "/api/connectors", { id: "boat", settings: { org: "acme", size: "large", idle: "30", busy: "4" } });
  check(set.status === 200 && set.connector?.settings?.org === "acme" && set.connector.settings.size === "large" && set.connector.settings.idle === "30" && set.connector.settings.busy === "4", "an organization of yours, a size and the times are kept");
  const odd = await post(HUB, "/api/connectors", { id: "boat", settings: { size: "huge", idle: "7" } });
  check(odd.status === 200 && odd.connector?.settings?.size === "default" && odd.connector.settings.idle === "15" && odd.connector.settings.org === "acme", "a size or a time that isn't one of them goes back to the usual");
  await post(HUB, "/api/connectors", { id: "boat", settings: { org: "personal", size: "default", idle: "15", busy: "8" } });

  // ---------- what the machine's sandbox used ----------
  const none = await get(HUB, "/api/machines/boat-shop/cloud/usage");
  check(none.status === 409, "a machine linked to no sandbox has no usage");
  const linked = await post(HUB, "/api/machines/boat-shop/cloud", { connector: "boat", sandbox: SANDBOX });
  check(linked.status === 200 && linked.cloud?.sandbox === SANDBOX, "linked to its sandbox");
  boat.usage.set(SANDBOX, 9000);
  const used = await get(HUB, "/api/machines/boat-shop/cloud/usage");
  check(used.status === 200 && used.usage?.seconds === 9000 && used.usage.dollars === 0.09 && used.usage.running === true, `its page has this month's machine time and what it costs (${used.usage?.seconds} s, $${used.usage?.dollars})`);
  check(/^\d{4}-\d\d-01T00:00:00/.test(asked("GET", /\/usage$/).at(-1)?.query.match(/since=([^&]+)/)?.[1] ? decodeURIComponent(asked("GET", /\/usage$/).at(-1).query.match(/since=([^&]+)/)[1]) : ""), "asked of boat from the first of the month");
  check(used.wallet?.hours_left === 312.7 && used.wallet.balance === 52.4 && used.wallet.can_start === true, "and what's left of the plan and in the wallet");
  boat.set({ scopes: ["sandbox.read", "sandbox.resume"] });
  const bare = await get(HUB, "/api/machines/boat-shop/cloud/usage");
  check(bare.status === 200 && bare.usage?.seconds === 9000 && bare.wallet === null, "a key that can't read the account still shows the usage, without the wallet");
  boat.set({ scopes: null });

  // ---------- sleeping: boat stops an idle machine soon, and a busy one late ----------
  const stops = () => asked("PATCH", new RegExp(`^/sandboxes/${SANDBOX}$`)).map((c) => c.body?.ttlSeconds);
  check(await until(() => stops().at(-1) === 900, 10000), `linked and idle, its sandbox's auto-stop moves to the connector's 15 minutes (${stops()})`);
  const resting = await until(async () => {
    const s = (await machine())?.cloud?.sleep;
    return s?.until ? s : null;
  }, 5000);
  check(resting?.busy === false && Date.parse(resting.until) - Date.now() > 13 * 60e3 && Date.parse(resting.until) - Date.now() < 16 * 60e3, "its page says when boat stops it");
  const T = path.join(BASE, "t.jsonl");
  fs.writeFileSync(T, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "stock the shelves" } }) + "\n");
  const env = { AGENTBOOK_PID: "940001", AGENTBOOK_LABEL: "kite" };
  hook("SessionStart", { session_id: "boat-1", cwd: project, source: "startup", transcript_path: T }, env);
  hook("UserPromptSubmit", { session_id: "boat-1", prompt: "stock the shelves", cwd: project, transcript_path: T }, env);
  check(await until(() => stops().at(-1) === 8 * 3600, 10000), `a turn starts: it's busy, and its auto-stop moves out to the 8 hours (${stops()})`);
  check(await until(async () => (await machine())?.cloud?.sleep?.busy === true, 5000), "its page says it's busy");
  const n = stops().length;
  await sleep(2500);
  check(stops().length === n, "boat isn't asked again while nothing changes");
  hook("Stop", { session_id: "boat-1", last_assistant_message: "Stocked." }, env);
  check(await until(() => stops().length > n && stops().at(-1) === 900, 10000), "the turn ends: idle, and back to 15 minutes");
  await post(HUB, "/api/connectors", { id: "boat", settings: { idle: "30" } });
  check(await until(() => stops().at(-1) === 1800, 5000), "another idle time on the connector moves it at once");
  // boat's free trial: two hours at most.
  boat.set({ trial: true });
  hook("UserPromptSubmit", { session_id: "boat-1", prompt: "and the back room", cwd: project, transcript_path: T }, env);
  check(await until(() => stops().at(-1) === 7200, 10000), "on boat's trial, a busy machine gets the two hours it allows");
  check((await until(async () => (await machine())?.cloud?.sleep?.capped, 5000)) === 7200, "and its page says that's the most the trial allows");
  boat.set({ trial: false, scopes: ["sandbox.read", "sandbox.resume", "account.read"] });
  hook("Stop", { session_id: "boat-1", last_assistant_message: "Done." }, env);
  const cant = await until(async () => (await machine())?.cloud?.sleep?.error, 10000);
  check(/sandbox\.update/.test(cant || ""), `a key that can't update says which scope it needs, and boat's own auto-stop stands (${cant})`);
  boat.set({ scopes: null });
  // Its agentbook-cli starts again (a wake): boat gave the sandbox a deadline of its own, so it's paced afresh.
  const before = stops().length;
  kill(box);
  await gone(box);
  box = serve(boxEnv);
  check(await until(() => stops().length > before && stops().at(-1) === 1800, 20000), "when its agentbook-cli starts again, as after a wake, its auto-stop is set again");

  // ---------- the link survives a restart ----------
  const atRestart = stops().length;
  kill(hub);
  await gone(hub);
  hub = serve(hubEnv);
  check(await healthy(HUB), "the server restarts");
  check(await until(async () => (await machine())?.cloud?.sandbox === SANDBOX, 15000), "and the machine is still linked to its sandbox");
  check(await until(() => stops().length > atRestart, 15000), "and its sandbox's auto-stop is set once more, by what the machine says now");

  // ---------- a machine the server makes logs itself in ----------
  const made = await post(HUB, "/api/devices/enroll", { name: "Boat Till" });
  check(made.status === 200 && made.device?.name === "boat-till" && made.enroll?.server === HUB && made.enroll.name === "boat-till" && typeof made.enroll.poll === "string", "the server makes a machine's login, approved for you, with what goes on the machine");
  check((await stateOf((p) => get(HUB, p))).machines?.some((m) => m.name === "boat-till" && !m.online), "it's a machine of yours already, off until it starts");
  const tillHome = path.join(BASE, "till");
  const enrollFile = path.join(BASE, "till-enroll");
  fs.mkdirSync(path.join(tillHome, "cli"), { recursive: true });
  fs.writeFileSync(enrollFile, JSON.stringify(made.enroll));
  const tillEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT + 200), AGENTBOOK_HOME: tillHome, AGENTBOOK_ENROLL_FILE: enrollFile, AGENTBOOK_ENROLL_EVERY_MS: "200" };
  const startTill = () => spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: tillEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
  till = startTill();
  check(await until(async () => (await stateOf((p) => get(HUB, p))).machines?.find((m) => m.name === "boat-till")?.online, 15000), "its agentbook-cli starts with that file and connects, with no code typed");
  const device = JSON.parse(fs.readFileSync(path.join(tillHome, "cli", "device.json"), "utf8"));
  check(device.server === HUB && device.name === "boat-till" && device.user === "herval" && !!device.token, "logged in as that machine, yours");
  check(!fs.existsSync(enrollFile), "and the file is gone from its disk");
  const gate = JSON.parse(fs.readFileSync(path.join(tillHome, "cli", "gate.json"), "utf8"));
  check(typeof gate.history_from === "string" && gate.codex_tools === false, "it sends only what happens from now on, and leaves Codex's settings alone");
  check((await get(HUB, `/api/devices/poll?poll=${encodeURIComponent(made.enroll.poll)}`)).status === 404, "what was in the file works once: a second pick-up gets nothing");
  // A file left on a machine that's logged in already (a restart) is removed, unused.
  till.kill();
  await gone(till);
  fs.writeFileSync(enrollFile, JSON.stringify({ server: HUB, name: "other", poll: "stale" }));
  till = startTill();
  check((await until(() => !fs.existsSync(enrollFile), 8000)) && JSON.parse(fs.readFileSync(path.join(tillHome, "cli", "device.json"), "utf8")).name === "boat-till", "a file left on a machine that's logged in is removed, and its login stays");
  till.kill();
  await gone(till);
  // One that expired, or was used: removed, and the machine stays logged out.
  const lostHome = path.join(BASE, "lost");
  fs.mkdirSync(path.join(lostHome, "cli"), { recursive: true });
  fs.writeFileSync(enrollFile, JSON.stringify({ server: HUB, name: "lost", poll: made.enroll.poll }));
  till = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: { ...tillEnv, AGENTBOOK_HOME: lostHome }, stdio: "ignore" });
  check((await until(() => !fs.existsSync(enrollFile), 8000)) && !fs.existsSync(path.join(lostHome, "cli", "device.json")), "a login that was used already is removed from the disk, and logs nothing in");
  till.kill();
  await gone(till);
  // A server elsewhere over plain http gets no token.
  fs.writeFileSync(enrollFile, JSON.stringify({ server: "http://203.0.113.9:4310", name: "lost", poll: "p" }));
  till = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: { ...tillEnv, AGENTBOOK_HOME: lostHome }, stdio: "ignore" });
  check((await until(() => !fs.existsSync(enrollFile), 8000)) && !fs.existsSync(path.join(lostHome, "cli", "device.json")), "a server elsewhere that isn't HTTPS is never asked");

  // ---------- kept past 14 days, and a sandbox deleted on boat ----------
  // (The test's "12 days" is 25 seconds, and the connector looks after its machines at each Check its key.)
  const resumes = () => asked("POST", new RegExp(`^/sandboxes/${SANDBOX}/resume$`)).length;
  const asleepAt = Date.now();
  kill(box);
  boat.sandboxes.get(SANDBOX).state = "archived";
  check(await until(async () => (await machine())?.online === false, 15000), "its sandbox stops");
  await post(HUB, "/api/connectors/boat/sync");
  await sleep(500);
  check(resumes() === 0, "asleep a moment, it's left asleep");
  await sleep(Math.max(0, 27000 - (Date.now() - asleepAt)));
  await post(HUB, "/api/connectors/boat/sync");
  check(await until(() => resumes() === 1, 5000), "asleep for 12 days, it's woken, so boat's next stop is a new one and its disk is kept");
  check(await until(async () => (await machine())?.online, 15000), "it comes back");
  check(await until(() => stops().at(-1) === 1800 && asked("PATCH", new RegExp(`^/sandboxes/${SANDBOX}$`)).length > 0, 8000), "and, idle, it's set to stop again in its usual minutes");
  kill(box);
  await gone(box);
  boat.sandboxes.delete(SANDBOX);
  await until(async () => (await machine())?.online === false, 15000);
  await post(HUB, "/api/connectors/boat/sync");
  const lost = await until(async () => {
    const m = await machine();
    return m?.cloud?.gone ? m.cloud : null;
  }, 5000);
  check(lost?.gone === true && /no longer has its sandbox/.test(lost.error || ""), `a sandbox deleted on boat is noticed, and its machine's page says it can't come back (${lost?.error})`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  kill(hub);
  kill(box);
  till?.kill();
  await boat.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
