#!/usr/bin/env node
// A shared machine's people (server/api/machines.ts): its owner adds someone from its page, signed with
// their passkey, and the machine's root helper makes their seat; they join, and their seat's own agentbook-cli logs in
// as a machine of theirs; the seats are one box, which wakes for any of them on the owner's boat account and stays up
// while any of them is busy; the people on it see the threads that run there, unless one is made Private; and taking
// someone off removes their seat and their login.
//
// Here the machine is this Mac: the owner's agentbook-cli runs "in a seat" (a seats file of the test's), and the root
// helper is the test itself, with stand-ins for what touches the machine (test/seat-helper.ts has it for real, as
// root on Linux). boat is a stand-in too (test/fake-boat.ts).
// Run: node test/shared-machine.ts

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoat } from "./fake-boat.ts";
import type { HelperDeps } from "../plugin/cli/seat-helper.ts";
import type { Sandbox, BoatBody } from "./fake-boat.ts";
import { type Passkey, makePasskey, signPayload } from "./fake-passkey.ts";
import { type Agentbook, spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-shared-"));
const HUB_PORT = testPort(7800);
const HOST_PORT = HUB_PORT + 100;
const SEAT_PORT = HUB_PORT + 200;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const SANDBOX = "bx_23456789";
const SEATS = path.join(BASE, "etc", "seats.json");
const SPOOL = path.join(BASE, "spool");
process.env.AGENTBOOK_SEATS_FILE = SEATS;
process.env.AGENTBOOK_SEATS_SPOOL = SPOOL;
const { drain } = await import("../plugin/cli/seat-helper.ts");
const { MARK, readSeats, writeSeats } = await import("../plugin/cli/seats.ts");
const project = path.join(BASE, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
spawnSync("git", ["-C", project, "init", "-q", "-b", "main"]);

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 10000) => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

const created: { box: Sandbox; body: BoatBody | null }[] = []; // the sandboxes agentbook made on boat: { box, body }
const boat = await startBoat({ sandboxes: [{ id: SANDBOX, name: "shop", state: "ready" }], onCreate: (box, body) => created.push({ box, body }) });
const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", AGENTBOOK_CLONE_DIR: path.join(BASE, "dev"), CLAUDE_CONFIG_DIR: path.join(BASE, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR", "AGENTBOOK_SEATS_FILE", "AGENTBOOK_SEATS_SPOOL"]) delete common[k];
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_BOAT_API_URL: boat.url, AGENTBOOK_CLOUD_CONNECT_MS: "4000", AGENTBOOK_CLOUD_ANYWHERE: "1", AGENTBOOK_IMAGE_POLL_MS: "150" };
// The owner's agentbook-cli, in its seat on the shared machine.
const hostEnv = { ...common, AGENTBOOK_PORT: String(HOST_PORT), AGENTBOOK_HOME: path.join(BASE, "host"), AGENTBOOK_MACHINE: "boat-shop", AGENTBOOK_URL: `http://127.0.0.1:${HOST_PORT}`, AGENTBOOK_HUB: HUB, AGENTBOOK_SEATS_FILE: SEATS, AGENTBOOK_SEATS_SPOOL: SPOOL, AGENTBOOK_WORK_DIR: path.join(BASE, "dev") };
// A member's, in theirs: it knows nothing of the helper.
const seatEnv = { ...common, AGENTBOOK_PORT: String(SEAT_PORT), AGENTBOOK_HOME: path.join(BASE, "seat-banana"), AGENTBOOK_URL: `http://127.0.0.1:${SEAT_PORT}`, AGENTBOOK_ENROLL_FILE: path.join(BASE, "enroll-banana"), AGENTBOOK_ENROLL_EVERY_MS: "200", AGENTBOOK_LINK_POLL_MS: "300" };
for (const d of ["host", "seat-banana"]) {
  fs.mkdirSync(path.join(BASE, d, "cli"), { recursive: true });
  fs.writeFileSync(path.join(BASE, d, "cli", "gate.json"), JSON.stringify({ folders: [BASE] }));
}

const person = (cookie: string) => {
  const raw = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(HUB + p, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  return {
    get: async (p: string): Promise<Json> => {
      const r = await raw(p);
      const data: Json = await r.json().catch(() => ({}));
      return { status: r.status, ...data };
    },
    post: async (p: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Json> => {
      const r = await raw(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const data: Json = await r.json().catch(() => ({}));
      return { status: r.status, ...data };
    },
  };
};
const hook = (envOf: NodeJS.ProcessEnv, event: string, input: object, env: Record<string, string>) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...envOf, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", ...env } });
const turn = (envOf: NodeJS.ProcessEnv, id: string, pid: number, label: string, prompt: string, { end = true } = {}) => {
  const T = path.join(BASE, `${id}.jsonl`);
  fs.writeFileSync(T, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: prompt } }) + "\n");
  const env = { AGENTBOOK_PID: String(pid), AGENTBOOK_LABEL: label };
  hook(envOf, "SessionStart", { session_id: id, cwd: project, source: "startup", transcript_path: T }, env);
  hook(envOf, "UserPromptSubmit", { session_id: id, prompt, cwd: project, transcript_path: T }, env);
  if (end) hook(envOf, "Stop", { session_id: id, last_assistant_message: "Done." }, env);
};

// The machine's root helper, stood in: seats in the test's seats file, a member's login in a file of the test's.
const did: string[] = [];
let seat: ChildProcess | null = null;
let enrolled: string | null = null; // what the helper last put in a member's home
const deps: HelperDeps = {
  add(name) {
    const all = readSeats(SEATS);
    all.seats[name] = { uid: 99000 + Object.keys(all.seats).length, port: SEAT_PORT, added: new Date().toISOString() };
    writeSeats(all, SEATS);
    did.push(`add ${name}`);
    return `Made ${name}'s seat`;
  },
  remove(name) {
    const all = readSeats(SEATS);
    delete all.seats[name];
    writeSeats(all, SEATS);
    did.push(`remove ${name}`);
    seat?.kill();
  },
  passwd: (name) => ({ name, uid: 99001, gid: 99001, gecos: MARK, home: path.join(BASE, "home", name), shell: "/bin/bash" }),
  putEnroll(pw, text) {
    enrolled = text;
    fs.writeFileSync(path.join(BASE, `enroll-${pw.name}`), text);
    did.push(`enroll ${pw.name}`);
  },
  // systemd starting their agentbook-cli again: here, the test starts it.
  restart(name) {
    did.push(`restart ${name}`);
    seat = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: seatEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
  },
  // This machine was set up already (the second one's helper below has a setup of its own).
  setup() {
    throw new Error("no setup on this machine");
  },
};
fs.mkdirSync(path.dirname(SEATS), { recursive: true });
fs.mkdirSync(SPOOL, { recursive: true });
writeSeats({ machine: "boat-shop", seats: { herval: { uid: process.getuid(), port: HOST_PORT, added: new Date().toISOString() } } }, SEATS);
const helper = setInterval(() => drain({ file: SEATS, spool: SPOOL, deps, ownerUid: process.getuid() }), 200);

const key = makePasskey(-7, "phone");
const origin = `http://localhost:${HUB_PORT}`;
const sign = (e: object, by: Passkey = key) => ({ envelope: e, sig: signPayload(by, e, { origin, rpId: "localhost" }) });

const hub = spawnAgentbook({ env: hubEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
let host: Agentbook | null = null;
try {
  check(await until(async () => (await fetch(HUB + "/api/health").catch(() => null))?.ok), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  const herval = person((setup.headers.get("set-cookie") || "").split(";")[0]);
  const join = async (username: string) => {
    const r = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
    return person((r.headers.get("set-cookie") || "").split(";")[0]);
  };
  const banana = await join("banana");
  const carol = await join("carol");
  const o = await herval.post("/api/passkeys/options");
  await herval.post("/api/passkeys", { id: key.record.id, alg: key.record.alg, spki: key.record.spki, name: "phone", clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin })).toString("base64url") });

  // ---------- the owner's machine, before it's shared ----------
  const login = await herval.post("/api/devices/start", { name: "boat-shop" });
  await herval.post("/api/devices/approve", { code: login.code, origin, rp_id: "localhost" });
  Object.assign(hostEnv, { AGENTBOOK_HUB_TOKEN: (await herval.get(`/api/devices/poll?poll=${encodeURIComponent(login.poll)}`)).token });
  host = spawnAgentbook({ env: hostEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
  const page = () => herval.get("/api/machines/boat-shop");
  check(await until(async () => (await page()).online, 15000), "the owner's agentbook-cli is on, in its seat");
  await until(async () => (await page()).seat, 10000);
  check((await page()).seat === "herval" && (await page()).shares === false, "a machine that isn't shared says so: its page has how to share it, and no adding");
  const early = await herval.post("/api/machines/boat-shop/people", { user: "banana" });
  check(early.status === 409 && /seat share herval/.test(early.error || ""), `adding someone to it says what to run there first (${early.error})`);
  // root shares it: what proves an add is its owner's, written down where only root can change it.
  fs.writeFileSync(path.join(path.dirname(SEATS), "box.json"), JSON.stringify({ owner: "herval", machine: "boat-shop", server: HUB, keys: [{ id: key.record.id, alg: key.record.alg, spki: key.record.spki }], origin, rp_id: "localhost", seen: {} }));
  check(await until(async () => (await page()).shares === true, 10000), "shared by root on the machine, its page takes people");

  // ---------- adding someone ----------
  const asked = await herval.post("/api/machines/boat-shop/people", { user: "banana" });
  check(asked.status === 428 && asked.sign?.kind === "members.change" && asked.sign.machine === "boat-shop" && asked.sign.user === "banana" && asked.keys?.[0] === key.record.id, "adding someone answers with what the owner's passkey signs: who, on which machine");
  const forged = await herval.post("/api/machines/boat-shop/people", { user: "banana", signed: sign(asked.sign, makePasskey(-7, "not theirs")) });
  check(forged.status === 409 && /wasn't theirs/.test(forged.error || "") && !did.length && !(await page()).people.length, `signed by another key, the machine's helper refuses it, and nobody's added (${forged.error})`);
  const other = await herval.post("/api/machines/boat-shop/people", { user: "banana", signed: sign({ ...asked.sign, user: "carol" }) });
  check(other.status === 400 && !did.length, "what's signed for someone else isn't taken for this");
  const added = await herval.post("/api/machines/boat-shop/people", { user: "banana", signed: sign(asked.sign) });
  check(added.status === 200 && added.people?.[0]?.user === "banana" && added.people[0].state === "invited" && added.people[0].seated === true && did.join() === "add banana", `signed by the owner, their seat is made on the machine (${added.error || did.join()})`);
  check((await herval.post("/api/machines/boat-shop/people", { user: "banana" })).status === 409 && (await herval.post("/api/machines/boat-shop/people", { user: "herval" })).status === 400 && (await herval.post("/api/machines/boat-shop/people", { user: "nobody-here" })).status === 404, "not twice, not yourself, and only someone who's here");
  check((await banana.post("/api/machines/boat-shop/people", { user: "carol" })).status === 404, "only its owner adds people");

  // ---------- joining ----------
  const side = async (who) => (await who.get("/api/q/side")).data?.boxes || [];
  const inv = (await side(banana))[0];
  check(inv?.machine === "boat-shop" && inv.owner === "herval" && inv.state === "invited" && inv.seated === true && !(await side(carol)).length, "the one who was added sees it's shared with them; nobody else does");
  check((await carol.post(`/api/boxes/${inv.id}/join`)).status === 404, "someone who wasn't added can't join");
  const joined = await banana.post(`/api/boxes/${inv.id}/join`);
  check(joined.status === 200 && joined.machine === "boat-shop-banana" && did.includes("enroll banana") && did.includes("restart banana"), `joining makes their seat's login, which the helper puts in their home (${joined.error || joined.machine})`);
  check(JSON.parse(enrolled || "{}").server === HUB && JSON.parse(enrolled || "{}").name === "boat-shop-banana", "for the machine's own server");
  const theirs = () => banana.get("/api/machines/boat-shop-banana");
  check(await until(async () => (await theirs()).online, 20000), "their own agentbook-cli takes it and is On, as a machine of theirs");
  check((await herval.get("/api/machines/boat-shop-banana")).status === 404, "which is theirs, not the owner's");
  const people = (await page()).people;
  check(people[0]?.state === "joined" && people[0].machine === "boat-shop-banana" && people[0].online === true, "the owner's page says they joined, and that they're on");
  check((await banana.post(`/api/boxes/${inv.id}/join`)).status === 409, "joining twice does nothing");

  // ---------- one box: one sandbox, one bill ----------
  await herval.post("/api/connectors", { kind: "boat", api_key: boat.key });
  const linked = await herval.post("/api/machines/boat-shop/cloud", { connector: "boat", sandbox: SANDBOX });
  check(linked.status === 200, "the owner links the machine to its sandbox");
  const stops = () => boat.calls.filter((c) => c.method === "PATCH" && c.path === `/sandboxes/${SANDBOX}`).map((c) => c.body?.ttlSeconds);
  check(await until(() => stops().at(-1) === 900, 15000), `with everyone idle, its sandbox's auto-stop is the idle minutes (${stops()})`);
  const seen = await until(async () => {
    const m = await theirs();
    return m.cloud?.shared ? m : null;
  }, 10000);
  check(seen?.cloud?.shared?.machine === "boat-shop" && seen.cloud.shared.owner === "herval" && !seen.cloud.made && !seen.cloud.connector, "the member's seat says whose machine and sandbox it's on, and nothing of the owner's connector");
  check((await banana.get("/api/machines/boat-shop-banana/cloud/usage")).status === 409 && (await banana.post("/api/machines/boat-shop-banana/cloud", {})).status === 200 && (await herval.get("/api/machines/boat-shop")).cloud?.sandbox === SANDBOX, "and can't read its bill or unlink it");
  turn(seatEnv, "b1", 950001, "wren", "stock the shelves", { end: false });
  check(await until(() => stops().at(-1) === 8 * 3600, 15000), "a member's turn keeps the whole machine up: busy hours, while the owner is idle");
  hook(seatEnv, "Stop", { session_id: "b1", last_assistant_message: "Stocked." }, { AGENTBOOK_PID: "950001", AGENTBOOK_LABEL: "wren" });
  check(await until(() => stops().at(-1) === 900, 15000), "and once nobody's busy, it's back to the idle minutes");

  // ---------- each person's own secrets, in their own home ----------
  const sec = await herval.post("/api/machines/boat-shop/secrets", { name: "OPENAI_API_KEY", value: "sk-seat-secret-1" });
  check(sec.status === 200 && sec.secrets?.join() === "OPENAI_API_KEY", `a secret you set on your seat goes to your own agentbook-cli there (${sec.error || sec.secrets})`);
  const kept = path.join(BASE, "host", "cli", "secrets.json");
  check(JSON.parse(fs.readFileSync(kept, "utf8")).OPENAI_API_KEY === "sk-seat-secret-1" && (fs.statSync(kept).mode & 0o777) === 0o600, "which keeps it in your home there, yours alone to read");
  check(await until(async () => (await page()).secrets?.join() === "OPENAI_API_KEY", 8000), "its page has the secret's name");
  const serverData = fs.readdirSync(path.join(BASE, "hub", "server"), { recursive: true }).filter((f) => /\.(db|db-wal|json|log)$/.test(String(f))).some((f) => fs.readFileSync(path.join(BASE, "hub", "server", String(f))).includes("sk-seat-secret-1"));
  check(!JSON.stringify([await page(), await herval.get("/api/q/side")]).includes("sk-seat-secret-1") && !serverData, "and its value is nowhere on agentbook-server: not in an answer, not in its data");
  check((await herval.post("/api/machines/boat-shop/secrets", { name: "PATH", value: "/tmp" })).status === 400 && (await herval.post("/api/machines/boat-shop/secrets", { name: "LD_PRELOAD", value: "x" })).status === 400, "a name that would change what runs there is turned down");
  check((await banana.post("/api/machines/boat-shop/secrets", { name: "X", value: "y" })).status === 404 && (await herval.post("/api/machines/hub/secrets", { name: "X", value: "y" })).status === 409, "only on a seat, and only your own");
  const gone = await herval.post("/api/machines/boat-shop/secrets", { name: "OPENAI_API_KEY" });
  check(gone.status === 200 && !gone.secrets?.length && !("OPENAI_API_KEY" in JSON.parse(fs.readFileSync(kept, "utf8"))), "and it's taken away the same way");

  // ---------- who sees the threads on it ----------
  turn(hostEnv, "h1", 950002, "kite", "count the till");
  const sees = async (who, id) => (await who.get(`/api/sessions/${id}`)).status === 200;
  check(await until(() => sees(herval, "h1"), 10000), "the owner has a thread on it");
  check((await until(() => sees(banana, "h1"), 10000)) === true, "someone on the machine sees it");
  check((await until(() => sees(herval, "b1"), 10000)) === true, "and the owner sees theirs");
  check(!(await sees(carol, "h1")) && !(await sees(carol, "b1")), "someone who isn't on it sees neither");
  const priv = await herval.post("/api/sessions/h1/visibility", { visibility: "private" });
  check(priv.status === 200 && !(await sees(banana, "h1")) && (await sees(herval, "h1")), "a thread made Private stays its owner's");

  // ---------- the code is shared, so a thread gets a worktree of its own ----------
  spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "start"]);
  const agents = (await stateOf(herval.get)).agents || [];
  const claude = agents.find((a) => a.machine === "boat-shop" && (a.kind === "claude-code" || /claude/.test(a.id)))?.id;
  const started = await herval.post("/api/launch", { prompt: "Add the cart page", root: project, agent: claude });
  check(started.status === 200 && started.making === true && /^worktree-/.test(started.branch || ""), `a thread started in the shared code, with no branch picked, works in a new worktree (${started.error || started.branch})`);
  check(await until(() => fs.existsSync(path.join(project, ".claude", "worktrees", "add-the-cart-page")), 10000), "which is made beside everyone's checkout, and leaves it on its branch");

  // ---------- it wakes for any of them, on the owner's account ----------
  const resumes = () => boat.calls.filter((c) => c.method === "POST" && c.path === `/sandboxes/${SANDBOX}/resume`).length;
  host.kill();
  seat.kill();
  boat.sandboxes.get(SANDBOX).state = "archived";
  check(await until(async () => (await theirs()).online === false, 20000), "its sandbox stops: everyone's seat goes off");
  const msg = await banana.post("/api/sessions/b1/messages", { text: "and the back room" });
  check(msg.queued && (await until(() => resumes() === 1, 6000)), "a member's message wakes it, with the owner's boat key");
  host = spawnAgentbook({ env: hostEnv, stdio: ["ignore", "ignore", "ignore"] });
  seat = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: seatEnv, stdio: "ignore" });
  check(await until(async () => (await theirs()).online && (await page()).online, 20000), "and everyone's back");

  // ---------- taking someone off ----------
  const off = await herval.post("/api/machines/boat-shop/people", { user: "banana", remove: true });
  check(off.status === 200 && !off.people.length && did.includes("remove banana"), `taking them off needs no signature, and removes their seat on the machine (${off.error || "removed"})`);
  check(await until(async () => (await banana.get("/api/machines/boat-shop-banana")).online !== true, 15000), "their seat's login here is gone");
  check(!(await side(banana)).length && !(await sees(banana, "h1")), "and the machine isn't shared with them any more");
  await herval.post("/api/sessions/h1/visibility", { visibility: "" });
  check(!(await sees(banana, "h1")), "so they don't see its threads");

  // ---------- turning an invitation down ----------
  const again = await herval.post("/api/machines/boat-shop/people", { user: "carol" });
  await herval.post("/api/machines/boat-shop/people", { user: "carol", signed: sign(again.sign) });
  const inv2 = (await side(carol))[0];
  const left = await carol.post(`/api/boxes/${inv2?.id}/leave`);
  check(inv2?.state === "invited" && left.status === 200 && !(await side(carol)).length && (await until(() => did.includes("remove carol"), 8000)) && !(await page()).people.length, "someone invited turns it down: they're off, and their seat is removed");

  // ---------- added while the machine is off: their seat is made when it's back, and then they can join ----------
  host.kill();
  check(await until(async () => (await page()).online === false, 20000), "the machine goes off");
  const late = await herval.post("/api/machines/boat-shop/people", { user: "carol" });
  const queued = await herval.post("/api/machines/boat-shop/people", { user: "carol", signed: sign(late.sign) });
  check(queued.status === 200 && queued.queued === true && queued.people?.[0]?.seated === false && (await side(carol))[0]?.seated === false, "someone added while it's off is invited, with their seat still to make");
  const before = did.filter((x) => x === "add carol").length;
  host = spawnAgentbook({ env: hostEnv, stdio: ["ignore", "ignore", "ignore"] });
  check(await until(() => did.filter((x) => x === "add carol").length > before, 25000), "back on, the machine makes their seat from the add that waited");
  check(await until(async () => (await side(carol))[0]?.seated === true, 15000), "and the invitation says so, so they can join");
  check((await page()).people?.[0]?.seated === true, "as the owner's page does");

  // ---------- a machine agentbook makes: in a seat from its first start, so it's shared as it is ----------
  // What its setup would do there as root (agentbook-cli seat claim, in test/seat-helper.ts for real) is done by
  // the test: a seat for its owner, the passkeys that came with its login written down, and the helper.
  const SEATS2 = path.join(BASE, "etc2", "seats.json");
  const SPOOL2 = path.join(BASE, "var2", "spool");
  const TWO_PORT = HUB_PORT + 300;
  const ran: { admin: string; script: string; owner: string }[] = [];
  const helper2 = setInterval(() => drain({ file: SEATS2, spool: SPOOL2, deps: { ...deps, setup: (admin, script, owner) => ran.push({ admin, script, owner }) }, ownerUid: process.getuid() }), 200);
  let two: ChildProcess | null = null;
  try {
    // Confirmed with the passkey, on the page's own address, as the page does it.
    const confirm = async (p: string, body: Record<string, unknown> = {}) => {
      const first = await herval.post(p, body, { origin: HUB });
      return first.status === 428 && first.sign ? herval.post(p, { ...body, signed: { envelope: first.sign, sig: signPayload(key, first.sign, { origin: HUB, rpId: "127.0.0.1" }) } }, { origin: HUB }) : first;
    };
    boat.set({ setup: { status: "done", log: "::step agentbook 9.9\n::ok 1\n::end ok 2\n" } });
    const made = await confirm("/api/cloud/machines", { connector: "boat", name: "boat-two", origin, rp_id: "localhost" });
    check(made.status === 200 && made.machine === "boat-two", `the owner makes a cloud machine (${made.error || made.machine})`);
    await until(() => created.some((c) => c.body?.name === "boat-two"), 5000);
    const sent = created.find((c) => c.body?.name === "boat-two")?.body;
    check(/seat claim 'herval' --machine 'boat-two'/.test(sent?.setupScript || ""), "its setup makes their seat there");
    const login = JSON.parse(sent?.files?.[0]?.content || "{}");
    check(login.pin?.keys?.[0]?.id === key.record.id && login.pin.origin === origin && login.pin.rp_id === "localhost", "and its login carries their passkeys, for root there to write down before anything of theirs runs");
    const GATE2 = "mTESTTWO00000000";
    fs.mkdirSync(path.join(BASE, "two", "cli"), { recursive: true });
    fs.mkdirSync(SPOOL2, { recursive: true });
    fs.mkdirSync(path.dirname(SEATS2), { recursive: true });
    fs.writeFileSync(path.join(BASE, "two", "cli", "gate.json"), JSON.stringify({ machine: GATE2 }));
    fs.writeFileSync(path.join(BASE, "two", "enroll"), sent.files[0].content);
    writeSeats({ machine: "boat-two", seats: { herval: { uid: process.getuid(), port: TWO_PORT, added: new Date().toISOString() } } }, SEATS2);
    fs.writeFileSync(path.join(path.dirname(SEATS2), "box.json"), JSON.stringify({ owner: "herval", machine: "boat-two", server: HUB, keys: login.pin.keys.map(({ id, alg, spki }) => ({ id, alg, spki })), origin: login.pin.origin, rp_id: login.pin.rp_id, gate: GATE2, admin: "user", seen: {} }));
    const twoEnv = { ...common, AGENTBOOK_PORT: String(TWO_PORT), AGENTBOOK_HOME: path.join(BASE, "two"), AGENTBOOK_URL: `http://127.0.0.1:${TWO_PORT}`, AGENTBOOK_ENROLL_FILE: path.join(BASE, "two", "enroll"), AGENTBOOK_ENROLL_EVERY_MS: "200", AGENTBOOK_LINK_POLL_MS: "300", AGENTBOOK_SEATS_FILE: SEATS2, AGENTBOOK_SEATS_SPOOL: SPOOL2, AGENTBOOK_WORK_DIR: path.join(BASE, "dev") };
    two = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "run"], { env: twoEnv, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
    const page2 = () => herval.get("/api/machines/boat-two");
    check(await until(async () => (await page2()).online, 20000), "it starts, logged in from the file it was made with");
    check(await until(async () => (await page2()).shares === true, 10000) && (await page2()).seat === "herval", "in its owner's seat, and shared already: its page takes people, with nothing to run there first");
    const asked2 = await herval.post("/api/machines/boat-two/people", { user: "banana" });
    const added2 = await herval.post("/api/machines/boat-two/people", { user: "banana", signed: sign(asked2.sign) });
    check(added2.status === 200 && did.filter((x) => x === "add banana").length > 0 && added2.people?.[0]?.user === "banana", `someone added to it gets their seat there (${added2.error || "added"})`);
    // An Update: its seat has no sudo, so the script goes to the helper, with the command as its owner signed it.
    const build = await confirm("/api/images/basic/build");
    check(build.status === 200 && (await until(async () => (await herval.get("/api/images")).images?.find((i) => i.id === "basic")?.built?.v === 1, 15000)), `its image gets a built version (${build.error || "built"})`);
    await until(async () => (await page2()).cloud?.setting === false, 10000);
    const up0 = await herval.post("/api/machines/boat-two/cloud/update");
    check(up0.status === 428 && up0.sign?.kind === "cloud.setup" && up0.sign.machine === GATE2, `Update comes back as what to sign, for this machine (${up0.status} ${up0.error || ""})`);
    const up = await herval.post("/api/machines/boat-two/cloud/update", { signed: sign(up0.sign) });
    check(up.status === 200 && up.started === true && ran.length === 1 && ran[0].admin === "user" && ran[0].owner === "herval" && /step 'agentbook /.test(ran[0].script) && !/seat claim/.test(ran[0].script), `signed, the machine's helper takes it and runs the image's script as the sandbox's own user (${up.error || ran.length})`);
    fs.writeFileSync(path.join(path.dirname(SPOOL2), "setup.log"), "::step agentbook 9.9\n::ok 1\n::end ok 2\n");
    check(await until(async () => (await page2()).cloud?.v === 1, 15000), "and once the script ends well, the machine is on that version");
  } finally {
    clearInterval(helper2);
    two?.kill();
  }
} catch (e) {
  failures++;
  console.error(e);
} finally {
  clearInterval(helper);
  hub.kill();
  host?.kill();
  seat?.kill();
  await boat.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
