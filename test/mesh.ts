#!/usr/bin/env node
// Machines of one person's, linked: alpha and beta, each one process
// (`agentbook webui`) with its own data folder and ports, each logged in to the same account (`agentbook login`,
// through a fake relay: test/fake-relay.ts). With no code, each links to the other as the relay lists it, checked by
// its certificate; beta, whose page has nobody yet, takes alpha's person (the same id). Then each page's feed has
// both machines' threads; a thread's work stays on its machine and is read from it when opened; what can run
// something from the other machine's page is refused unless it's signed (gate.ts) by a passkey on that page, which
// each machine takes from the other by itself, with no Sign once, and once only (page-keys.ts); and with alpha off, beta still
// shows alpha's thread and its conversation, and says its work can't be read. Then unlinking: from beta's page with
// alpha off (alpha drops beta as the relay tells it, once it's back); a third machine logging in, which links by
// itself; and `agentbook unlink` with both on.
// All over iroh, as your machines link: each page's endpoint on 127.0.0.1 with no relay
// (AGENTBOOK_IROH=local), dialed by the key the relay lists, with no token and no address; a key off the account gets
// nothing, a certificate has to be the calling key's, and a hello over HTTP is refused.
// AGENTBOOK_IROH=relay runs it through a real iroh relay (n0's, or AGENTBOOK_IROH_RELAY's, such as agentbook-relay's
// run locally with its iroh-relay): never in the suite.
// Run: node test/mesh.ts

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, halves, spawnAgentbook, spawnTied } from "./harness.ts";
import { fakeRelay } from "./fake-relay.ts";
import { linkInput } from "../plugin/shared/mesh-link.ts";
import { machineKey, type MachineLogin } from "../plugin/shared/machine-login.ts";
import { N0_IROH_RELAY, makeIroh, type IrohHow } from "../plugin/shared/iroh.ts";
import { stateOf } from "./harness-state.ts";
import { sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";
import { makePasskey, signPayload } from "./fake-passkey.ts";
import type { Passkey } from "./fake-passkey.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST, "..");
const ROOT = path.join(REPO, "plugin");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-mesh-")));
const A_PORT = await freePort(6510, 40);
const B_PORT = await freePort(6555, 40);
const C_PORT = await freePort(6600, 40);
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
const C = `http://127.0.0.1:${C_PORT}`;
// Over iroh, unless this is the HTTP run.
const IROH = process.env.AGENTBOOK_IROH === "relay" ? "relay" : "local";
const IROH_DIR = path.join(BASE, "iroh");
const irohHow: IrohHow = IROH === "relay" ? { mode: "relay", relay: process.env.AGENTBOOK_IROH_RELAY || N0_IROH_RELAY } : { mode: "local", dir: IROH_DIR };
const project = path.join(BASE, "dev", "app");
fs.mkdirSync(project, { recursive: true });

// The relay the machines log in through, and herval's account there.
const relay = await fakeRelay();
relay.person = { sub: "google:777", acct: crypto.randomUUID(), email: "herval@example.com", name: "Herval" };
const common: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_RELAY_URL: relay.url, AGENTBOOK_LINK_RETRY_MS: "1000", AGENTBOOK_PEER_REFUSED_MS: "1000", HOME: path.join(BASE, "person"), CLAUDE_CONFIG_DIR: path.join(BASE, "person", ".claude"), AGENTBOOK_HARNESS_ONE: "1", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_IROH: IROH, AGENTBOOK_IROH_DIR: IROH_DIR, ...(irohHow.mode === "relay" ? { AGENTBOOK_IROH_RELAY: irohHow.relay } : {}) };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_URL", "AGENTBOOK_SERVER_HOME", "CLAUDE_JOB_DIR"]) delete common[k];
const machineEnv = (name: string, port: number): NodeJS.ProcessEnv => {
  const home = path.join(BASE, name);
  // Each shares the test's folders with what asks of it (its gate).
  fs.mkdirSync(path.join(home, "cli"), { recursive: true });
  fs.writeFileSync(path.join(home, "cli", "gate.json"), JSON.stringify({ folders: [BASE], starts_per_hour: 1000 }));
  // Its page's address is at localhost, where passkeys sign (not at an IP address).
  return { ...common, AGENTBOOK_PORT: String(port), AGENTBOOK_HOME: home, AGENTBOOK_MACHINE: name, AGENTBOOK_CLONE_DIR: path.join(home, "clones"), AGENTBOOK_URL: `http://localhost:${port}` };
};
const envA = machineEnv("alpha", A_PORT);
const envB = machineEnv("beta", B_PORT);
const envC = machineEnv("gamma", C_PORT);
const loginOf = (name: string): MachineLogin => JSON.parse(fs.readFileSync(path.join(BASE, name, "machine.json"), "utf8"));
// `agentbook login` on a machine, said yes to on the relay's page (for `acct`, herval's unless another).
function logIn(env: NodeJS.ProcessEnv, acct = relay.person.acct): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "login", "--no-open", "--no-start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let answered = false;
    const take = (b: Buffer) => {
      out += b;
      const code = /\b([B-Z]{4}-[B-Z]{4})\b/.exec(out)?.[1];
      if (code && !answered) {
        answered = true;
        setTimeout(() => relay.approve(code, acct), 50);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("exit", (status) => resolve({ status, out }));
  });
}
// A machine linking to a page, as server/mesh.ts does, with `login`'s certificate, signed with `key`'s key. `via`: over
// what (iroh, as a machine with another key), else at the page's address.
async function linkAs(login: MachineLogin, base: string, to: string, { key = login, body = {}, via }: { key?: MachineLogin; body?: Json; via?: (path: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response> } = {}) {
  const text = JSON.stringify({ certificate: login.certificate, to, url: null, person: null, ...body });
  const at = Math.floor(Date.now() / 1000);
  const sig = crypto.sign(null, linkInput(at, to, text), machineKey(key)).toString("base64url");
  const init = { method: "POST", headers: { "content-type": "application/json", authorization: `Agentbook machine=${login.machine}, at=${at}, sig=${sig}` }, body: text };
  const r = await (via ? via("/api/cli/mesh/link", init) : fetch(base + "/api/cli/mesh/link", init));
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
}
// A call over iroh as the machine `as` (its key), to the page of `to`'s: -> its answer, or why it got none.
// On 127.0.0.1, where that machine's own endpoint answers (its file, if it's running) is put back after.
async function overIrohAs(as: MachineLogin, to: MachineLogin, call: (fetch: (path: string, init: object) => Promise<Response>) => Promise<Json>): Promise<Json> {
  const file = path.join(IROH_DIR, `${as.key.x}.json`);
  const was = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const node = await makeIroh({ key: as.key, admit: async () => true, log: () => {}, how: irohHow, serve: (s) => s.destroy() });
  try {
    return await call((p, init) => node.fetch(to.key.x, p, init)).catch((e) => ({ status: 0, error: e.cause?.code || e.message }));
  } finally {
    await node.close();
    if (was) fs.writeFileSync(file, was);
  }
}

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 10e3): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};
// Each page's sign-in cookie.
const jar: Record<string, string> = {};
const call = (base: string, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(jar[base] ? { cookie: jar[base] } : {}), ...(opts.headers || {}) }, signal: AbortSignal.timeout(40e3) });
const get = async (base: string, p: string): Promise<Json> => {
  const r = await call(base, p).catch(() => null);
  return r ? { status: r.status, ...((await r.json().catch(() => ({}))) as Json) } : { status: 0 };
};
const post = async (base: string, p: string, body: unknown): Promise<Json> => {
  const r = await call(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return r ? { status: r.status, ...((await r.json().catch(() => ({}))) as Json) } : { status: 0 };
};
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 20e3);
const signIn = async (base: string) => {
  const r = await fetch(base + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  jar[base] = (r.headers.get("set-cookie") || "").split(";")[0];
  return r.ok;
};
const page = (base: string) => stateOf((p) => get(base, p));
const threadOn = async (base: string, id: string) => (await page(base)).sessions?.find((s: Json) => s.id === id || s.session_id === id) || null;
// A Claude Code session on a machine: its hooks, as Claude Code runs them, talking to that machine's agentbook.
const hook = (env: NodeJS.ProcessEnv, event: string, input: Json, pid: string) =>
  spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", AGENTBOOK_URL: `http://127.0.0.1:${env.AGENTBOOK_PORT}`, AGENTBOOK_PID: pid, AGENTBOOK_LABEL: "wren" }, encoding: "utf8", timeout: 30e3 });
// A turn whose transcript has a step in it (a command it ran), so its machine has work to send its own page.
function turn(env: NodeJS.ProcessEnv, session: string, pid: string, prompt: string) {
  const T = path.join(BASE, `${session}.jsonl`);
  const at = new Date().toISOString();
  const lines = [
    { type: "user", timestamp: at, message: { role: "user", content: prompt } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "all passed" }] } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "The tests pass." }] } },
  ];
  fs.writeFileSync(T, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  hook(env, "SessionStart", { session_id: session, cwd: project, source: "startup", transcript_path: T }, pid);
  hook(env, "UserPromptSubmit", { session_id: session, prompt, cwd: project, transcript_path: T }, pid);
  hook(env, "Stop", { session_id: session, cwd: project, transcript_path: T, last_assistant_message: "The tests pass." }, pid);
}

for (const [name, env] of [["alpha", envA], ["beta", envB]] as const) {
  const r = await logIn(env);
  if (r.status !== 0) throw new Error(`agentbook login on ${name}: ${r.out}`);
}
let alpha = spawnAgentbook({ env: envA, stdio: ["ignore", fs.openSync(path.join(BASE, "alpha.log"), "a"), fs.openSync(path.join(BASE, "alpha.log"), "a")] });
let beta: ReturnType<typeof spawnAgentbook> | null = null;
let gamma: ReturnType<typeof spawnAgentbook> | null = null;
let alphaUp = true;
try {
  check(relay.machines(relay.person.acct).length === 2, "alpha and beta are both on herval's account, as the relay has it");
  check(await healthy(A), "alpha runs");
  const made = await fetch(A + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  jar[A] = (made.headers.get("set-cookie") || "").split(";")[0];
  check(made.ok, "alpha's page has its person");
  turn(envA, "alpha-1", "960001", "run the tests on alpha");
  check(await until(async () => (await get(A, "/api/sessions/alpha-1/steps")).steps?.length), "a thread on alpha, with its work on alpha's page");
  // beta hasn't run yet, so it said nowhere its page answers: alpha's Machines says it's on the account, not linked, and why.
  const notYet = await until(async () => ((await get(A, "/api/people/herval")).not_linked || []).find((m: Json) => m.name === "beta" && /can't reach beta over iroh/.test(m.why)));
  check(notYet, `alpha's Machines has beta, on the account but not linked, and why (${JSON.stringify(notYet)})`);

  // ---------- linking: no code, each machine's certificate ----------
  beta = spawnAgentbook({ env: envB, stdio: ["ignore", fs.openSync(path.join(BASE, "beta.log"), "a"), fs.openSync(path.join(BASE, "beta.log"), "a")] });
  check(await healthy(B), "beta runs, its page with nobody on it yet");
  const peerRows = (name: string) => sql(path.join(BASE, name, "storage.db")).prepare("select * from peers").all() as { name: string; machine: string; key: string | null; site: string | null }[];
  // By its key, over iroh: no token, no address (the connection is the machine).
  const sends = (from: string, to: string) => peerRows(from).some((r) => r.name === to && r.key);
  check(await until(() => sends("beta", "alpha") && sends("alpha", "beta"), 20e3), "beta links to alpha by itself, as the relay lists it, and alpha back to beta, each over iroh: each sends the other its threads");
  check(peerRows("alpha").find((r) => r.name === "beta")?.machine === loginOf("beta").machine, "alpha keeps beta by its id on the relay");
  check(peerRows("alpha").find((r) => r.name === "beta")?.key === loginOf("beta").key.x && peerRows("beta").find((r) => r.name === "alpha")?.key === loginOf("alpha").key.x, "each keeps the other's key, the one the relay lists");
  check(peerRows("beta").find((r) => r.name === "alpha")?.site === `http://localhost:${A_PORT}`, "and the other's page's address, as it says it");
  const logOf = (name: string) => fs.readFileSync(path.join(BASE, `${name}.log`), "utf8");
  check(await until(() => /sending this machine's threads to beta too, over iroh/.test(logOf("alpha")) && /sending this machine's threads to alpha too, over iroh/.test(logOf("beta"))), "each daemon sends the other its threads over iroh");
  check(await signIn(B), "beta's page is herval's now: he signs in there");
  const me = async (base: string) => (await get(base, "/api/auth/me")).user?.id || (await get(base, "/api/me")).id;
  check((await me(A)) && (await me(A)) === (await me(B)), "as the same person, by id");
  // Nobody else's machine gets in, nor a link made to look like it's from one of yours.
  const other = path.join(BASE, "stranger");
  fs.mkdirSync(other, { recursive: true });
  const strangerIn = await logIn({ ...machineEnv("stranger", C_PORT), AGENTBOOK_HOME: other }, crypto.randomUUID());
  const stranger = loginOf("stranger");
  const alphaId = loginOf("alpha").machine;
  const strangerOver = await overIrohAs(stranger, loginOf("alpha"), (f) => linkAs(stranger, A, alphaId, { via: f }));
  check(strangerIn.status === 0 && strangerOver.status === 0, `a machine on another account isn't taken: alpha closes its connection before it reads anything (${strangerOver.error})`);
  const overHttp = await linkAs(loginOf("beta"), A, alphaId);
  check(overHttp.status === 426 && /over iroh only/.test(String(overHttp.error)), `nor a hello over HTTP, as an agentbook from before iroh says it, even with a good certificate (${overHttp.status} ${overHttp.error})`);

  // ---------- each feed has both machines' threads ----------
  const there = await until(() => threadOn(B, "alpha-1"));
  check(there, "alpha's thread shows in beta's feed");
  const machinesOnB = (await page(B)).machines?.map((m: Json) => m.name) || [];
  check(machinesOnB.includes("alpha") && machinesOnB.includes("beta"), `beta's page has both machines (${machinesOnB})`);
  turn(envB, "beta-1", "960002", "run the tests on beta");
  check(await until(() => threadOn(A, "beta-1")), "and beta's thread shows in alpha's feed");
  const convo = await get(B, "/api/sessions/alpha-1");
  check(convo.status === 200, "beta opens alpha's thread");

  // ---------- work: read from the machine it's on ----------
  const steps = await get(B, "/api/sessions/alpha-1/steps");
  check(steps.status === 200 && steps.steps?.length, `its work, read from alpha as it's opened (${steps.status} ${steps.error || steps.steps?.length})`);

  // ---------- a file's bytes: read from its machine when opened, and kept ----------
  const REPORT = "# Report\nAll good.\n";
  const procs = [`${os.hostname().split(".")[0]}-960001`, "alpha-960001"];
  let file: Json = {};
  for (const proc of procs) if (!file.id) file = await post(A, `/api/procs/${proc}/files`, { name: "report.md", content_base64: Buffer.from(REPORT).toString("base64") });
  check(file.id, `alpha's agent hands over a file (${file.error || file.id})`);
  const bytesOn = async (base: string) => {
    const r = await call(base, `/api/files/${file.id}`).catch(() => null);
    return r?.ok ? r.text() : null;
  };
  check((await until(() => bytesOn(B))) === REPORT, "it opens on beta, its bytes read from alpha, by the same id");

  // ---------- steering from the other machine's page ----------
  const said = await post(B, "/api/sessions/alpha-1/messages", { text: "and the lint" });
  check(said.status === 409 && said.needs_passkey && /no passkey on beta's page/.test(String(said.error)), `a message from beta's page to alpha's thread waits for a passkey of yours on beta's page (${said.status} ${said.error})`);
  const unsigned = await post(B, "/api/sessions/alpha-1/messages", { text: "and the lint", signed: { envelope: { v: 1, kind: "post.deliver" }, sig: {} } });
  check(unsigned.status >= 400 && unsigned.status !== 200, "and nothing beta's page sends gets it there meanwhile");
  // (It runs in a terminal, which only a press of Esc there stops: what alpha answers says it got there.)
  const stopped = await post(B, "/api/sessions/alpha-1/stop", {});
  check(stopped.status === 200 || /Press Esc there/.test(String(stopped.error)), `a stop, which can't run anything, reaches alpha and is answered there (${stopped.status} ${stopped.error || ""})`);

  // ---------- a passkey on each page: each machine takes what you sign on the other's, with no Sign once ----------
  const onA = { origin: `http://localhost:${A_PORT}`, rpId: "localhost" };
  const onB = { origin: `http://localhost:${B_PORT}`, rpId: "localhost" };
  const vouch = (base: string, name: string, body: Json = {}) => post(base, `/api/mesh/${name}/vouch`, body);
  const madeOn = async (base: string, pk: Passkey, on: { origin: string }) => {
    const o = await post(base, "/api/passkeys/options", {});
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: on.origin })).toString("base64url");
    return post(base, "/api/passkeys", { id: pk.record.id, alg: pk.record.alg, spki: pk.record.spki, name: pk.record.name, clientDataJSON });
  };
  const phoneA = makePasskey(-7, "phone on alpha");
  const phoneB = makePasskey(-7, "phone on beta");
  check((await madeOn(A, phoneA, onA)).status === 200 && (await madeOn(B, phoneB, onB)).status === 200, "a passkey of herval's on each page");
  // beta keeps its own page's passkey, so what it takes from another page is signed by that passkey there.
  const betaSigns = await post(B, "/api/machines/beta/signing", { on: true, origin: onB.origin, rp_id: onB.rpId });
  check(betaSigns.status === 200 && betaSigns.signs, `beta takes what can run something from its own page only signed (${betaSigns.status} ${betaSigns.error || ""})`);
  // Signed on the page it comes from, by the passkey there.
  const signedSend = async (base: string, p: string, body: Json, pk: Passkey, on: { origin: string; rpId: string }) => {
    const ask = await until(async () => {
      const r = await post(base, p, body);
      return r.status !== 409 && r;
    });
    if (ask?.status !== 428) return { ask, final: ask };
    return { ask, final: await post(base, p, { ...body, signed: { envelope: ask.sign, sig: pk.sign(ask.sign, on) } }) };
  };
  const toAlpha = await signedSend(B, "/api/sessions/alpha-1/messages", { text: "and the lint" }, phoneB, onB);
  check(toAlpha.ask?.status === 428 && toAlpha.ask.sign?.kind === "post.deliver", `then a message from beta's page to alpha's thread asks your passkey there to sign it: alpha took beta's page's passkeys by itself (${toAlpha.ask?.status} ${toAlpha.ask?.error || ""})`);
  check(toAlpha.final?.status === 200, `and signed on beta's page, alpha takes it (${toAlpha.final?.status} ${toAlpha.final?.error || ""})`);
  const toBeta = await signedSend(A, "/api/sessions/beta-1/messages", { text: "and the build" }, phoneA, onA);
  check(toBeta.ask?.status === 428 && toBeta.final?.status === 200, `and the other way: signed on alpha's page, beta takes it, though it keeps its own page's passkey (${toBeta.final?.status} ${toBeta.final?.error || ""})`);
  check(/takes what's signed on http:\/\/localhost:\d+ \(1 key\), a page of this machine's person's/.test(logOf("alpha")) && /takes what's signed on http:\/\/localhost:\d+ \(1 key\), a page of this machine's person's/.test(logOf("beta")), "each machine's gate says it took the other's page's passkeys, with no Sign once");
  const rowOf = async (base: string, name: string) => (await get(base, "/api/devices")).devices?.find((d: Json) => d.name === name);
  const betaRow = await until(async () => {
    const r = await rowOf(A, "beta");
    return r?.linked?.signs && r;
  });
  check(betaRow?.linked?.takes && betaRow.linked.signs && betaRow.linked.url === onB.origin, `alpha's page shows beta linked, each taking what's signed on the other's page (${JSON.stringify(betaRow?.linked)})`);
  // On 127.0.0.1 with no relay, direct; through a relay, whichever it is.
  check(betaRow?.linked?.iroh && (IROH === "local" ? betaRow.linked.path === "direct" : !!betaRow.linked.path), `and over iroh, how it goes now: ${betaRow?.linked?.path}`);
  const wrongPage = await signedSend(A, "/api/sessions/beta-1/messages", { text: "and deploy" }, phoneA, onB);
  check(wrongPage.final?.status >= 400 && /signed on/.test(String(wrongPage.final?.error)), `but not that passkey's signature said to be from another page (${wrongPage.final?.status} ${wrongPage.final?.error})`);

  // ---------- a routine on alpha's page, for beta's thread: OK'd on alpha's page, it runs on beta ----------
  const routineAsk = await post(A, "/api/routines", { name: "Beta check", prompt: "Is beta's build green?", thread: "beta-1", schedule: "manual" });
  check(routineAsk.status === 428 && routineAsk.sign?.kind === "routine.ok", `a routine on alpha's page for beta's thread asks your passkey on alpha's page to OK it (${routineAsk.status} ${routineAsk.error || ""})`);
  const routine = await post(A, "/api/routines", { name: "Beta check", prompt: "Is beta's build green?", thread: "beta-1", schedule: "manual", signed: { envelope: routineAsk.sign, sig: signPayload(phoneA, routineAsk.sign, onA) } });
  check(routine.status === 200 && routine.live_v === 1, `signed there, it's on (${routine.status} ${routine.error || ""})`);
  const ranThere = await post(A, `/api/routines/${encodeURIComponent(routine.id)}/run`, {});
  check(ranThere.status === 200, `you run it from alpha's page (${ranThere.status} ${ranThere.error || ""})`);
  const runWords = await until(async () => ((await get(B, "/api/sessions/beta-1")).messages || []).find((m: Json) => String(m.text || "").startsWith('This is a run of the routine "Beta check"')));
  check(!!runWords && String(runWords.text).endsWith("Is beta's build green?"), "and beta takes its run, with the OK you signed on alpha's page");

  // ---------- a passkey added or taken off on one page: the other machine hears ----------
  const laptopA = makePasskey(-7, "laptop on alpha");
  const madeLaptop = await madeOn(A, laptopA, onA);
  check(madeLaptop.status === 200 && madeLaptop.spread?.includes("beta"), `a passkey made on alpha's page is one to spread to beta, which takes alpha's page (${JSON.stringify(madeLaptop.spread)})`);
  const spreadPath = `/api/passkeys/${encodeURIComponent(laptopA.record.id)}/spread`;
  const spreadAsk = await post(A, spreadPath, {});
  const spread = spreadAsk.status === 428 ? await post(A, spreadPath, { signed: { envelope: spreadAsk.sign, sig: signPayload(phoneA, spreadAsk.sign, onA) } }) : spreadAsk;
  check(spreadAsk.status === 428 && spreadAsk.sign?.kind === "keys.change" && spread.status === 200 && spread.sent?.includes("beta"), `signed by the passkey beta takes for alpha's page, the new one goes to beta (${spread.status} ${spread.error || JSON.stringify(spread.sent)})`);
  const byLaptop = await signedSend(A, "/api/sessions/beta-1/messages", { text: "from the laptop" }, laptopA, onA);
  check(byLaptop.final?.status === 200, `and what it signs on alpha's page steers beta (${byLaptop.final?.status} ${byLaptop.final?.error || ""})`);
  const gone = await post(A, `/api/passkeys/${encodeURIComponent(phoneA.record.id)}/remove`, {});
  check(gone.status === 200 && gone.sent?.includes("beta"), `a passkey taken off on alpha's page is taken off beta too, with no signature (a lost phone can't sign) (${gone.status} ${gone.error || JSON.stringify(gone.sent)})`);
  const lost = await until(async () => {
    const r = await signedSend(A, "/api/sessions/beta-1/messages", { text: "from the lost phone" }, phoneA, onA);
    return /doesn't keep/.test(String(r.final?.error)) && r;
  });
  check(lost && lost.final.status === 403, `then what it signs is refused on beta (${lost?.final?.status} ${lost?.final?.error})`);
  check((await signedSend(A, "/api/sessions/beta-1/messages", { text: "laptop still" }, laptopA, onA)).final?.status === 200, "while the passkey still on alpha's page steers it");
  const lastGone = await post(A, `/api/passkeys/${encodeURIComponent(laptopA.record.id)}/remove`, {});
  check(lastGone.status === 200 && lastGone.sent?.includes("beta"), `the last one taken off goes to beta too, as alpha's page heard beta keep it (${lastGone.status} ${JSON.stringify(lastGone.sent)})`);
  const noneLeft = await until(async () => {
    const r = await post(A, "/api/sessions/beta-1/messages", { text: "anyone?" });
    return r.status === 409 && r;
  });
  check(/no passkey on alpha's page/.test(String(noneLeft?.error)), `with the last one taken off, beta takes nothing signed on alpha's page (${noneLeft?.status} ${noneLeft?.error})`);
  // A sign-in stolen on alpha's page could take its passkeys off and make its own: beta doesn't take that one.
  const thief = makePasskey(-7, "a new one on alpha");
  check((await madeOn(A, thief, onA)).status === 200, "then a new passkey on alpha's page");
  const refused = await until(async () => {
    const r = await post(A, "/api/sessions/beta-1/messages", { text: "anyone now?" });
    return r.status === 409 && /took your passkeys on .* before/.test(String(r.error)) && r;
  });
  check(refused && /^beta took .* press Sign once on alpha's row in Machines on beta's page, or run agentbook login on beta\./.test(String(refused.error)), `beta doesn't take it unsigned: it took alpha's page's passkeys once, and says how to have it take them again (${refused?.status} ${refused?.error})`);
  // Sign once on beta's page, signed by beta's own passkey there, takes them again.
  const again = await vouch(B, "alpha");
  const forgedAgain = await vouch(B, "alpha", { signed: { envelope: again.sign, sig: signPayload(thief, again.sign, onA) } });
  check(forgedAgain.status >= 400 && /doesn't keep|signed on/.test(String(forgedAgain.error)), `not signed by a passkey beta keeps, beta refuses it (${forgedAgain.status} ${forgedAgain.error})`);
  const againSigned = again.status === 428 ? await vouch(B, "alpha", { signed: { envelope: again.sign, sig: signPayload(phoneB, again.sign, onB) } }) : again;
  check(again.status === 428 && again.sign?.kind === "keys.vouch" && againSigned.status === 200 && againSigned.takes === onA.origin, `Sign once on beta's page, signed by beta's own passkey, has beta take them again (${againSigned.status} ${againSigned.error || ""})`);
  check((await signedSend(A, "/api/sessions/beta-1/messages", { text: "back" }, thief, onA)).final?.status === 200, "and then what the new one signs on alpha's page steers beta");

  // A second thread on alpha, which beta never opens.
  turn(envA, "alpha-2", "960003", "and the build");
  check(await until(() => threadOn(B, "alpha-2")), "a second thread on alpha shows in beta's feed too");

  // ---------- alpha off ----------
  const linkedOn = async (base: string, name: string) => ((await get(base, "/api/devices")).devices || []).find((d: Json) => d.name === name) || null;
  const rows = (name: string) => (sql(path.join(BASE, name, "storage.db")).prepare("select name from peers").all() as { name: string }[]).map((r) => r.name);
  const sitesOf = async (base: string, name: string) => ((await get(base, `/api/machines/${name}`)).gate?.signed?.sites || []).map((x: Json) => x.origin);
  check((await sitesOf(A, "alpha")).includes(onB.origin), "alpha takes what's signed on beta's page, before it's unlinked");
  alpha.kill();
  alphaUp = false;
  await until(async () => !(await fetch(A + "/api/health").catch(() => null)), 10e3);
  check(await threadOn(B, "alpha-1"), "with alpha off, beta still shows alpha's thread");
  check((await get(B, "/api/sessions/alpha-1")).status === 200, "and its conversation");
  check((await bytesOn(B)) === REPORT, "and the file it opened");
  const asOf = await get(B, "/api/sessions/alpha-1/steps");
  check(asOf.status === 200 && asOf.steps?.length === steps.steps?.length, "and the work it read from alpha while it was on, as it was then");
  const off = await get(B, "/api/sessions/alpha-2/steps");
  check(off.status >= 400 && off.offline && !off.steps, `but not the work of the one it never opened, which never left alpha (${off.status} ${off.error})`);

  // ---------- unlinking ----------
  // With alpha off, from beta's page: the relay takes alpha off the account; alpha's page doesn't hear.
  const offUnlink = await post(B, "/api/mesh/alpha/unlink", {});
  check(offUnlink.status === 200 && offUnlink.unlinked === "alpha" && offUnlink.told === false, `beta's page unlinks alpha while alpha is off, and says alpha's page didn't hear (${offUnlink.status} ${offUnlink.error || JSON.stringify(offUnlink)})`);
  check(relay.machines(relay.person.acct).find((m) => m.name === "alpha")?.revoked, "the relay has alpha off the account");
  check(!(await linkedOn(B, "alpha")) && !rows("beta").includes("alpha"), "alpha's gone from beta's machines, and beta sends it nothing more");
  check(await until(async () => !(await sitesOf(B, "beta")).includes(onA.origin)), "and beta takes nothing signed on alpha's page now");
  check(await threadOn(B, "alpha-1"), "what alpha sent stays on beta's page, as it was");
  // alpha back: the relay tells it it's off the account, so it drops beta too.
  alpha = spawnAgentbook({ env: envA, stdio: ["ignore", fs.openSync(path.join(BASE, "alpha.log"), "a"), fs.openSync(path.join(BASE, "alpha.log"), "a")] });
  alphaUp = true;
  check(await healthy(A), "alpha is back");
  check(await until(() => !rows("alpha").includes("beta"), 20e3), "the relay says alpha is off the account, so alpha drops beta, by itself");
  check(!(await linkedOn(A, "beta")) && (await until(async () => !(await sitesOf(A, "alpha")).includes(onB.origin))), "beta's gone from alpha's machines, and alpha takes nothing signed on beta's page");
  const offAccount = await overIrohAs(loginOf("alpha"), loginOf("beta"), (f) => linkAs(loginOf("alpha"), B, loginOf("beta").machine, { via: f }));
  check(offAccount.status === 0, `and beta takes no connection from alpha, its certificate still good for days (${offAccount.error})`);
  turn(envA, "alpha-3", "960004", "after unlinking");
  await until(() => threadOn(A, "alpha-3"));
  await sleep(2000);
  check(!(await threadOn(B, "alpha-3")), "a thread alpha starts now stays off beta's feed");

  // A new machine on the account: logged in, it links to beta by itself, and takes herval from beta's page.
  check((await logIn(envC)).status === 0, "gamma logs in to herval's account");
  gamma = spawnAgentbook({ env: envC, stdio: ["ignore", fs.openSync(path.join(BASE, "gamma.log"), "a"), fs.openSync(path.join(BASE, "gamma.log"), "a")] });
  check(await healthy(C), "gamma runs");
  check(await until(() => sends("gamma", "beta") && sends("beta", "gamma"), 20e3), "gamma and beta link by themselves, with no code, over iroh");
  check(!rows("gamma").includes("alpha") && !rows("alpha").includes("gamma"), "but not gamma and alpha, which is off the account");
  check((await me(B)) === (await signIn(C).then(() => me(C))), "gamma's page is herval's, by the same id");
  turn(envC, "gamma-1", "960006", "on gamma");
  check(await until(() => threadOn(B, "gamma-1"), 15e3), "and gamma's threads reach beta's feed");
  // A machine on the account (delta, logged in, not running), calling with another one's certificate (alpha's, still
  // good for days), signed by it. Its key is one beta's list doesn't have yet, so beta asks the relay.
  check((await logIn(machineEnv("delta", C_PORT + 1))).status === 0, "delta logs in to herval's account too");
  const notItsOwn = await overIrohAs(loginOf("delta"), loginOf("beta"), (f) => linkAs(loginOf("alpha"), B, loginOf("beta").machine, { via: f }));
  check(notItsOwn.status === 401 && /isn't the machine calling/.test(String(notItsOwn.error)), `over iroh, a link's certificate has to be the calling machine's (${notItsOwn.status} ${notItsOwn.error})`);
  // The rest of what a hello is checked for, over iroh as delta (whose key is on the account): signed with another
  // machine's key, meant for another machine, or with no good certificate.
  const asDeltaLinks = await overIrohAs(loginOf("delta"), loginOf("beta"), async (f) => ({
    signedElsewhere: (await linkAs(loginOf("delta"), B, loginOf("beta").machine, { key: stranger, via: f })).status,
    forAnother: (await linkAs(loginOf("delta"), B, "some-other-machine", { via: f })).status,
    noCertificate: (await linkAs({ ...loginOf("delta"), certificate: "not.a.certificate" }, B, loginOf("beta").machine, { via: f })).status,
  }));
  check(asDeltaLinks.signedElsewhere === 401 && asDeltaLinks.forAnother === 403 && asDeltaLinks.noCertificate === 401, `nor a hello signed with another machine's key, meant for another machine, or with no good certificate (${JSON.stringify(asDeltaLinks)})`);
  // delta isn't linked to beta: over iroh its calls get nothing, even with the token beta's own machine sends with,
  // as the connection says which machine is calling, never a token.
  const own = JSON.parse(fs.readFileSync(path.join(BASE, "beta", "cli", "device.json"), "utf8")).token;
  const asDelta = await overIrohAs(loginOf("delta"), loginOf("beta"), async (f) => {
    const r = await f("/api/cli/hello", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${own}` }, body: JSON.stringify({ version: "test", protocol: 1 }) });
    return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
  });
  check(asDelta.status === 403, `over iroh, a machine on the account that isn't linked gets nothing, whatever token it sends (${asDelta.status} ${asDelta.error})`);
  // beta loses gamma (its row gone, as if it never linked): gamma's next thread is refused there, so gamma asks the
  // relay, links again, and sends it.
  sql(path.join(BASE, "beta", "storage.db")).prepare("delete from peers where name = ?").run("gamma");
  turn(envC, "gamma-2", "960007", "on gamma, after beta lost it");
  check(await until(() => threadOn(B, "gamma-2"), 30e3), "a page that lost a machine takes it back over iroh: the machine links again as it's refused, and its thread arrives");
  check(sends("beta", "gamma") && sends("gamma", "beta"), "and each sends to the other again");
  // Unlinked from the command line with both on: the other page hears, and drops it at once.
  // (Not spawnSync: the relay answers from this process.)
  const unlinkOn = (env: NodeJS.ProcessEnv, port: number, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "unlink", ...args], { env: { ...env, AGENTBOOK_PORT: String(halves(port).cli) }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("exit", (status) => resolve({ status, stdout, stderr }));
    });
  const byCli = await unlinkOn(envB, B_PORT, "gamma");
  check(byCli.status === 0 && /Unlinked gamma/.test(byCli.stdout) && !/didn't hear/.test(byCli.stdout), `agentbook unlink gamma, on beta, takes it off the account and gamma's page hears (${(byCli.stdout + byCli.stderr).trim()})`);
  check(await until(() => !rows("gamma").includes("beta") && !rows("beta").includes("gamma")), "neither keeps the other");
  check(!(await linkedOn(B, "gamma")), "and gamma's gone from beta's machines");
  check((await unlinkOn(envB, B_PORT, "gamma")).status !== 0, "and unlinking it again says it isn't linked");
} finally {
  if (alphaUp) alpha.kill();
  beta?.kill();
  gamma?.kill();
  await sleep(500);
  await relay.close();
}

if (failures) console.log(`\n${failures} failed (logs in ${BASE})`);
else {
  console.log("\nAll checks passed");
  fs.rmSync(BASE, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
