#!/usr/bin/env node
// A machine on your account with no page of its own: alpha serves a page (`agentbook
// webui`); delta only ran `agentbook login`, which starts its agentbook-cli alone (plugin/cli/mesh.ts). Both log in
// through a fake relay (test/fake-relay.ts) and meet over iroh on 127.0.0.1 (AGENTBOOK_IROH=local).
// delta links to alpha by itself and says it has no page: alpha keeps it with no address and sends it nothing, and
// delta's threads reach alpha's feed, their work read from delta. delta takes what you sign on alpha's page with no
// Sign once: with no passkey on alpha's page yet, a message from there to delta's thread is refused and says so; with
// one, it asks that passkey to sign it, and delta takes it signed, never unsigned nor signed by a passkey elsewhere.
// It takes a page's passkeys unsigned once: with every one taken off there, a new one is taken only once delta is
// logged in again, on it.
// Its sessions' agentbook tools ask alpha's page, and agentbook cli status on delta lists alpha.
// Run: node test/no-page.ts

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnAgentbook } from "./harness.ts";
import { fakeRelay } from "./fake-relay.ts";
import { spawnTied } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";
import { makePasskey, signPayload } from "./fake-passkey.ts";
import type { Passkey } from "./fake-passkey.ts";
import type { MachineLogin } from "../plugin/shared/machine-login.ts";
import { AUTH_HEADER, signRequest } from "../plugin/shared/local-auth.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(TEST, "..", "plugin");
const MAIN = path.join(ROOT, "cli", "main.mjs");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-nopage-")));
const A_PORT = await freePort(6900, 40);
const D_PORT = await freePort(6950, 40);
const A = `http://127.0.0.1:${A_PORT}`;
const D = `http://127.0.0.1:${D_PORT}`;
const project = path.join(BASE, "dev", "app");
fs.mkdirSync(project, { recursive: true });

const relay = await fakeRelay();
relay.person = { sub: "google:778", acct: crypto.randomUUID(), email: "herval@example.com", name: "Herval" };
const common: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_RELAY_URL: relay.url, AGENTBOOK_LINK_RETRY_MS: "1000", AGENTBOOK_PEER_REFUSED_MS: "1000", HOME: path.join(BASE, "person"), CLAUDE_CONFIG_DIR: path.join(BASE, "person", ".claude"), AGENTBOOK_HARNESS_ONE: "1", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_AGY: "0", AGENTBOOK_GROK: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_IROH: "local", AGENTBOOK_IROH_DIR: path.join(BASE, "iroh") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_URL", "AGENTBOOK_SERVER_HOME", "AGENTBOOK_SERVER_PORT", "CLAUDE_JOB_DIR"]) delete common[k];
const machineEnv = (name: string, port: number): NodeJS.ProcessEnv => {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, "cli"), { recursive: true });
  fs.writeFileSync(path.join(home, "cli", "gate.json"), JSON.stringify({ folders: [BASE], starts_per_hour: 1000 }));
  return { ...common, AGENTBOOK_PORT: String(port), AGENTBOOK_HOME: home, AGENTBOOK_MACHINE: name, AGENTBOOK_CLONE_DIR: path.join(home, "clones"), AGENTBOOK_URL: `http://localhost:${port}` };
};
const envA = machineEnv("alpha", A_PORT);
// delta's agentbook-cli serves this machine's sessions on its port, and nothing else.
const envD = { ...machineEnv("delta", D_PORT), AGENTBOOK_URL: D };
const loginOf = (name: string): MachineLogin => JSON.parse(fs.readFileSync(path.join(BASE, name, "machine.json"), "utf8"));

// `agentbook login` on a machine, said yes to on the relay's page. `start`: as a person runs it, which starts agentbook.
function logIn(env: NodeJS.ProcessEnv, { start = false } = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnTied(process.execPath, [MAIN, "login", "--no-open", ...(start ? [] : ["--no-start"])], { env, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("exit", (status) => resolve({ status, out }));
  });
}

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 15e3): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};
let cookie = "";
const call = (base: string, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(base === A && cookie ? { cookie } : {}), ...(opts.headers || {}) }, signal: AbortSignal.timeout(40e3) });
const get = async (base: string, p: string): Promise<Json> => {
  const r = await call(base, p).catch(() => null);
  return r ? { status: r.status, ...((await r.json().catch(() => ({}))) as Json) } : { status: 0 };
};
const post = async (base: string, p: string, body: unknown): Promise<Json> => {
  const r = await call(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return r ? { status: r.status, ...((await r.json().catch(() => ({}))) as Json) } : { status: 0 };
};
const threadOn = async (id: string) => (await stateOf((p) => get(A, p))).sessions?.find((s: Json) => s.id === id || s.session_id === id) || null;
const peerRows = (name: string) => sql(path.join(BASE, name, "storage.db")).prepare("select * from peers").all() as { name: string; machine: string; key: string | null; site: string | null }[];
// What a machine logged: alpha's harness log, delta's agentbook-cli's own (cli.log, as agentbook login started it).
const logOf = (name: string) => [path.join(BASE, `${name}.log`), path.join(BASE, name, "cli", "cli.log")].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("");
const hook = (event: string, input: Json, pid: string) =>
  spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...envD, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", AGENTBOOK_URL: D, AGENTBOOK_PID: pid, AGENTBOOK_LABEL: "wren" }, encoding: "utf8", timeout: 30e3 });
// A turn on delta whose transcript has a step in it, so delta has work for a page to read.
function turn(session: string, pid: string, prompt: string) {
  const T = path.join(BASE, `${session}.jsonl`);
  const at = new Date().toISOString();
  const lines = [
    { type: "user", timestamp: at, message: { role: "user", content: prompt } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "all passed" }] } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "The tests pass." }] } },
  ];
  fs.writeFileSync(T, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  hook("SessionStart", { session_id: session, cwd: project, source: "startup", transcript_path: T }, pid);
  hook("UserPromptSubmit", { session_id: session, prompt, cwd: project, transcript_path: T }, pid);
  hook("Stop", { session_id: session, cwd: project, transcript_path: T, last_assistant_message: "The tests pass." }, pid);
}

const aLogin = await logIn(envA);
if (aLogin.status !== 0) throw new Error(`agentbook login on alpha: ${aLogin.out}`);
const alpha = spawnAgentbook({ env: envA, stdio: ["ignore", fs.openSync(path.join(BASE, "alpha.log"), "a"), fs.openSync(path.join(BASE, "alpha.log"), "a")] });
try {
  check(await until(async () => (await fetch(A + "/api/health").catch(() => null))?.ok, 30e3), "alpha runs, with its page");
  const made = await fetch(A + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  cookie = (made.headers.get("set-cookie") || "").split(";")[0];
  check(made.ok, "alpha's page has its person");

  // ---------- agentbook login alone: agentbook-cli, no page ----------
  const dLogin = await logIn(envD, { start: true });
  check(dLogin.status === 0 && /agentbook-cli is running here, with no page/.test(dLogin.out), `agentbook login on delta starts agentbook-cli with no page (${dLogin.out.trim().split("\n").pop()})`);
  check(await until(async () => (await get(D, "/api/status")).machine === "delta"), "delta's agentbook-cli answers for its sessions");
  const root = await get(D, "/");
  check(root.status === 404 && /no page of its own/.test(String(root.error)), `and serves no page (${root.status} ${root.error})`);

  // ---------- linking: delta to alpha, and back, over iroh ----------
  const dRow = async () => (await until(() => peerRows("alpha").find((r) => r.name === "delta" && r.key), 20e3)) || null;
  const onAlpha = await dRow();
  check(onAlpha && onAlpha.key === loginOf("delta").key.x && onAlpha.site === null, `alpha keeps delta by its key, with no page (${JSON.stringify(onAlpha)})`);
  const onDelta = await until(() => peerRows("delta").find((r) => r.name === "alpha" && r.key));
  check(onDelta?.site === `http://localhost:${A_PORT}` && onDelta.key === loginOf("alpha").key.x, `delta keeps alpha's page and key (${JSON.stringify(onDelta)})`);
  check(await until(() => /sending this machine's threads to alpha over iroh/.test(logOf("delta"))), "delta sends its threads to alpha's page over iroh");
  check(!/sending this machine's threads to delta/.test(logOf("alpha")), "and alpha sends delta nothing: it has no page");
  const machine = await until(async () => (await get(A, "/api/devices")).devices?.find((d: Json) => d.name === "delta" && d.linked));
  check(machine?.linked?.url === null && !machine.linked.signs, `alpha's Machines has delta linked, with no page, taking nothing signed there yet (${JSON.stringify(machine?.linked)})`);

  // ---------- its threads on alpha's feed, their work read from delta ----------
  turn("delta-1", "970001", "run the tests on delta");
  check(await until(() => threadOn("delta-1"), 20e3), "delta's thread shows in alpha's feed");
  const steps = await until(async () => {
    const r = await get(A, "/api/sessions/delta-1/steps");
    return r.steps?.length && r;
  });
  check(steps?.status === 200, `its work, read from delta as it's opened (${steps?.status} ${steps?.error || steps?.steps?.length})`);

  // Pictures its agent names by their path on delta (ab_cards' mockup, a reply's `![](…)`) are work too, so alpha's
  // page asks delta for each as it's opened, and keeps a copy.
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const mock = path.join(project, "mock.png");
  const shot = path.join(project, "shot.png");
  for (const f of [mock, shot, path.join(project, "unnamed.png")]) fs.writeFileSync(f, PNG);
  const dKey = fs.readFileSync(path.join(BASE, "delta", "cli", "local.key"), "utf8").trim();
  const toDelta = async (p: string, body: unknown) => {
    const b = JSON.stringify(body);
    const r = await fetch(D + p, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: signRequest(dKey, "POST", p, b).auth }, body: b }).catch(() => null);
    return r?.status || 0;
  };
  let dProc = "";
  for (const proc of [`${os.hostname().split(".")[0]}-970001`, "delta-970001"]) if (!dProc && (await toDelta(`/api/procs/${proc}/shape`, { cards: [{ title: "Recipes", image: mock }] })) === 200) dProc = proc;
  check(dProc, "delta's agent shows a card with a mockup on delta");
  await toDelta(`/api/procs/${dProc}/messages`, { from: "agent", text: `Five ways to go.\n\n![today](${shot})` });
  const picOnA = async (u: string) => {
    const r = await call(A, `/api/sessions/delta-1/picture?url=${encodeURIComponent(u)}`).catch(() => null);
    return { status: r?.status || 0, buf: r ? Buffer.from(await r.arrayBuffer()) : null };
  };
  const cardPic = await until(async () => {
    const r = await picOnA(mock);
    return r.status === 200 && r;
  });
  check(cardPic && cardPic.buf.equals(PNG), `a card's picture on delta shows on alpha's page (${cardPic?.status})`);
  check((await picOnA(shot)).status === 200, "and a reply's");
  fs.rmSync(mock);
  check((await picOnA(mock)).status === 200, "kept on alpha once it's shown, when delta's file is gone");
  check((await picOnA(path.join(project, "unnamed.png"))).status === 404, "but not one the thread doesn't name");

  // ---------- steering delta from alpha's page: what you sign there, with no Sign once ----------
  const none = await post(A, "/api/sessions/delta-1/messages", { text: "and the lint" });
  check(none.status === 409 && /no passkey on alpha's page/.test(String(none.error)) && none.needs_passkey, `with no passkey on alpha's page, a message to delta's thread says to make one (${none.status} ${none.error})`);
  const onA = { origin: `http://localhost:${A_PORT}`, rpId: "localhost" };
  const phone = makePasskey(-7, "phone on alpha");
  const options = await post(A, "/api/passkeys/options", {});
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: onA.origin })).toString("base64url");
  const madeKey = await post(A, "/api/passkeys", { id: phone.record.id, alg: phone.record.alg, spki: phone.record.spki, name: phone.record.name, clientDataJSON });
  check(madeKey.status === 200, "a passkey of herval's on alpha's page");
  const ask = await post(A, "/api/sessions/delta-1/messages", { text: "and the lint" });
  check(ask.status === 428 && ask.sign?.kind === "post.deliver", `then a message to delta's thread asks that passkey to sign it: delta took it from alpha's page by itself (${ask.status} ${ask.error || ""})`);
  check(/takes what's signed on http:\/\/localhost:\d+ \(1 key\), a page of this machine's person's/.test(logOf("delta")), "delta's gate says it takes what's signed on alpha's page");
  const signed = await post(A, "/api/sessions/delta-1/messages", { text: "and the lint", signed: { envelope: ask.sign, sig: signPayload(phone, ask.sign, onA) } });
  check(signed.status === 200, `signed there, delta takes it (${signed.status} ${signed.error || ""})`);
  const other: Passkey = makePasskey(-7, "a passkey elsewhere");
  const ask2 = await post(A, "/api/sessions/delta-1/messages", { text: "and deploy" });
  const forged = await post(A, "/api/sessions/delta-1/messages", { text: "and deploy", signed: { envelope: ask2.sign, sig: signPayload(other, ask2.sign, onA) } });
  check(forged.status >= 400 && /doesn't keep|signed/.test(String(forged.error)), `but not signed by a passkey that isn't on alpha's page (${forged.status} ${forged.error})`);
  const unsigned = await post(A, "/api/sessions/delta-1/messages", { text: "and deploy", signed: { envelope: { v: 1, kind: "post.deliver" }, sig: {} } });
  check(unsigned.status >= 400, `nor unsigned (${unsigned.status} ${unsigned.error})`);
  const row = await until(async () => {
    const d = (await get(A, "/api/devices")).devices?.find((x: Json) => x.name === "delta");
    return d?.linked?.signs && d;
  });
  check(row?.linked?.signs, "alpha's Machines has delta taking what you sign there now");

  // Recovery when the browser can register a replacement, but none of its credentials can approve it.
  const replacement = makePasskey(-7, "replacement phone");
  const opts = await post(A, "/api/passkeys/options", {});
  const data = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: onA.origin })).toString("base64url");
  const registered = await post(A, "/api/passkeys", { ...replacement.record, clientDataJSON: data });
  const fp = registered.passkey.fingerprint;
  check((await post(A, `/api/passkeys/${encodeURIComponent(replacement.record.id)}/rename`, { name: "Spare phone" })).name === "Spare phone", "the owner can name the new credential before approving it");
  const target = async () => (await get(A, "/api/passkeys")).machines.find((m: Json) => m.name === "delta");
  const waiting = await target();
  check(waiting.source === loginOf("alpha").machine && waiting.online && !waiting.keys.includes(fp), "Settings identifies the page for recovery and shows the new phone awaiting approval on delta");
  const before = await post(A, "/api/sessions/delta-1/messages", { text: "recovered phone" });
  check(before.status === 428 && before.keys.includes(phone.record.id) && !before.keys.includes(replacement.record.id), "thread signing offers only credentials delta trusts");
  const recover = (source: string, fingerprint: string) => spawnSync(process.execPath, [MAIN, "keys", "recover", source, fingerprint], { env: envD, encoding: "utf8", timeout: 30e3 });
  check(recover(waiting.source, "wrong_key_01").status !== 0, "an unknown recovery fingerprint is refused");
  const restored = recover(waiting.source, fp);
  check(restored.status === 0, `the machine owner approves the replacement on headless delta (${restored.stderr || restored.stdout})`);
  check(recover(waiting.source, fp).status === 0, "repeating the same recovery is safe");
  const after = await until(async () => (await target()).keys.includes(fp));
  check(after && (await target()).keys.length === 2, "Settings sees both the original and recovered keys on delta");
  const askRecovered = await post(A, "/api/sessions/delta-1/messages", { text: "recovered phone" });
  const sentRecovered = await post(A, "/api/sessions/delta-1/messages", { text: "recovered phone", signed: { envelope: askRecovered.sign, sig: signPayload(replacement, askRecovered.sign, onA) } });
  check(askRecovered.keys.includes(replacement.record.id) && sentRecovered.status === 200, "a normal thread command works with only the recovered credential");
  check((await post(A, `/api/passkeys/${encodeURIComponent(replacement.record.id)}/remove`, {})).removed, "removing the recovered key waits for confirmation from delta");

  // ---------- every passkey taken off alpha's page: a new one there isn't taken until delta is logged in again ----------
  const gone = await post(A, `/api/passkeys/${encodeURIComponent(phone.record.id)}/remove`, {});
  check(gone.status === 200 && gone.sent?.includes("delta"), `the passkey taken off alpha's page is taken off delta too (${gone.status} ${JSON.stringify(gone.sent)})`);
  const laptop = makePasskey(-7, "laptop on alpha");
  const options2 = await post(A, "/api/passkeys/options", {});
  const clientData2 = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options2.challenge, origin: onA.origin })).toString("base64url");
  check((await post(A, "/api/passkeys", { id: laptop.record.id, alg: laptop.record.alg, spki: laptop.record.spki, name: laptop.record.name, clientDataJSON: clientData2 })).status === 200, "then a new passkey on alpha's page (a stolen sign-in there could make one)");
  const notAgain = await until(async () => {
    const r = await post(A, "/api/sessions/delta-1/messages", { text: "and deploy" });
    return r.status === 409 && /took your passkeys on .* before/.test(String(r.error)) && r;
  });
  check(notAgain && /^delta took .* run agentbook login on delta\.$/.test(String(notAgain.error)) && !/Sign once/.test(String(notAgain.error)), `delta doesn't take it: it took that page's passkeys once, and says to log it in again (${notAgain?.status} ${notAgain?.error})`);
  const again = await logIn(envD);
  check(again.status === 0, "agentbook login on delta again, on the machine");
  const ask3 = await post(A, "/api/sessions/delta-1/messages", { text: "and deploy" });
  check(ask3.status === 428, `then delta takes alpha's passkeys once more (${ask3.status} ${ask3.error || ""})`);
  const byLaptop = await post(A, "/api/sessions/delta-1/messages", { text: "and deploy", signed: { envelope: ask3.sign, sig: signPayload(laptop, ask3.sign, onA) } });
  check(byLaptop.status === 200, `and takes what the new one signs (${byLaptop.status} ${byLaptop.error || ""})`);

  // ---------- its sessions' agentbook tools ask alpha's page ----------
  const show = await call(D, "/api/show").catch(() => null);
  check(show?.status === 200, `delta's sessions ask alpha's page what only a page knows (${show?.status})`);
  const status = spawnSync(process.execPath, [MAIN, "status"], { env: envD, encoding: "utf8", timeout: 30e3 });
  check(/no page of its own: it sends this machine's threads to alpha \(http:\/\/localhost:\d+/.test(status.stdout), `agentbook cli status on delta lists alpha (${status.stdout.split("\n").find((l) => /no page/.test(l))})`);
  const off = spawnSync(process.execPath, [MAIN, "webui", "off"], { env: envD, encoding: "utf8", timeout: 30e3 });
  check(/doesn't serve a page/.test(off.stdout), `agentbook webui off on delta says it has none to turn off (${off.stdout.trim()})`);
  const stopped = spawnSync(process.execPath, [MAIN, "down"], { env: envD, encoding: "utf8", timeout: 30e3 });
  check(stopped.status === 0 && await until(async () => !(await target()).online, 55e3), "the page sees delta go offline");
  const offlineRemoval = await post(A, `/api/passkeys/${encodeURIComponent(laptop.record.id)}/remove`, {});
  check(offlineRemoval.removed === false && !offlineRemoval.sent.includes("delta") && offlineRemoval.pending.some(p => p.machine === "delta"), "a queued revocation is pending until delta confirms");
  check((await get(A, "/api/passkeys")).passkeys.some(k => k.id === laptop.record.id && k.removing), "Settings retains the pending removal across reloads");
  const restarted = spawnSync(process.execPath, [MAIN, "up"], { env: envD, encoding: "utf8", timeout: 30e3 });
  check(restarted.status === 0 && await until(async () => !(await get(A, "/api/passkeys")).passkeys.some(k => k.id === laptop.record.id), 30e3), "reconnection applies the queued revocation and finishes removal");
} finally {
  spawnSync(process.execPath, [MAIN, "down"], { env: envD, encoding: "utf8", timeout: 30e3 });
  alpha.kill();
  await relay.close?.();
}
await sleep(500);
if (failures) {
  console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed. Logs: ${BASE}`);
  process.exit(1);
}
fs.rmSync(BASE, { recursive: true, force: true });
console.log("\nall passed");
process.exit(0);
