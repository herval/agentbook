#!/usr/bin/env node
// Security regressions, from the audit:
//  A) A machine's first-state sync (the one thing it sends that no op schema covers) can't crash the server. A
//     malformed bulk state is refused whole, nothing is taken, and the page's view of that machine doesn't throw.
//  B) Only a page's owner may point an agent at it. A second person can't make their agent a contributor of
//     someone else's page through POST /api/launch (which would then let the agent rewrite it). The same guard
//     is on the routine-link path (server/api/routines.ts routineLaunch): a run only grants its agent write to pages the
//     routine's owner owns.
//  C) One person's things don't reach another's through what names them:
//     naming a page in a message or a start (@mentions), linking a thread to a routine, a start that says which page
//     it's for, a task for an agent by its name, a page's contributors, /api/health, and bytes named by their sha256.
// Run: node test/security.ts

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "../server/relay.ts";
import { publicState } from "../plugin/shared/store.ts";
import { STATE, type Spec } from "../plugin/shared/protocol.ts";
import { stateOf } from "./harness-state.ts";
import { spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

// ---------- A. a malformed first-state sync is rejected whole ----------
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sec-a-"));
  const users: Record<string, { id: string; username: string }> = { u1: { id: "u1", username: "alice" } };
  const accounts = { byId: (id: string) => users[id] || null, deviceById: () => null };
  const relay = createRelay({ home: HOME, accounts });
  try {
    const at = new Date().toISOString();
    // A thread with no `updated` and no `updates`: reading it would throw in every viewer's page, taking the whole
    // server down and keeping it down after a restart (the bad state is persisted). It must be refused.
    const bad = relay.device("dbad", { name: "mac", user_id: "u1" });
    const r = relay.ingest(bad, { state: { seq: 1, sessions: { x: { id: "x", state: "idle" } } } });
    check(!!r.error && Object.keys(bad.store.state.sessions).length === 0, "a thread with no `updated` in a first-state sync is refused, and nothing is taken");
    let threw = false;
    try {
      publicState(bad.store.state);
    } catch {
      threw = true;
    }
    check(!threw, "and the page's view of that machine doesn't throw");
    // A list part that isn't a list would throw the moment the view iterates it.
    const badList = relay.device("dbad2", { name: "mac2", user_id: "u1" });
    check(!!relay.ingest(badList, { state: { seq: 1, messages: {} } }).error, "a first-state sync whose messages isn't a list is refused");
    // One machine for the refused ones, as one refused takes nothing (a new one after one that's taken).
    let machines = 0;
    let M = relay.device("drefused-0", { name: "refused", user_id: "u1" });
    // `s`: the parts of a first-state sync, as a machine might send them: anything at all, which is what's checked.
    const refused = (s: Json) => {
      const r = relay.ingest(M, { state: { seq: 2, ...s } });
      const reads = !(() => { try { publicState(M.store.state); return false; } catch { return true; } })();
      if (!r.error || Object.keys(M.store.state.sessions).length || M.cursor) return !(M = relay.device(`drefused-${++machines}`, { name: "refused", user_id: "u1" }));
      return reads;
    };
    // A list that is one, with a record in it that isn't: `messages: [null]` was taken, and every feed threw after.
    const thread = { id: "z", agent: "claude", updated: at, updates: [], state: "idle" };
    const records: [string, unknown][] = [["messages", [null]], ["questions", [{ post: "z" }]], ["files", [{ id: "f1", post: 7 }]], ["agents", { claude: null }], ["launches", { l1: "x" }], ["procs", { p1: null }]];
    for (const [part, value] of records) check(refused({ sessions: { z: thread }, [part]: value }), `a first-state sync with ${part}: ${JSON.stringify(value)} is refused whole, and the view reads`);
    // A record that is one, with a field that isn't what its store writes there: a thread with `prompt: {}` was taken,
    // and every feed threw on its title after, a restart too. Each field of each kind of record, sent as something it
    // can't be, is refused whole.
    const base = (): Json => ({
      sessions: { z: { ...thread } },
      agents: { claude: { id: "claude", name: "Claude", kind: "claude-code" } },
      launches: { l1: { id: "l1", agent: "claude", prompt: "hi", at, files: [] } },
      questions: [{ id: "q1", post: "z", title: "Ok?", options: [] }],
      files: [{ id: "f1", post: "z", from: "agent", name: "a.txt", size: 1 }],
      messages: [{ id: "m1", post: "z", from: "agent", text: "hi", at, files: [] }],
    });
    const wrong = (spec: Spec) => (Array.isArray(spec.type) ? 5 : { string: {}, boolean: "yes", number: "1", object: "x", array: {} }[spec.type]);
    const taken: string[] = [];
    let n = 0;
    for (const [part, fields] of Object.entries(STATE)) {
      for (const [name, spec] of Object.entries(fields)) {
        if (spec.type === "any") continue;
        const key = name.replace(/\?$/, "");
        const s = base();
        const rec = Array.isArray(s[part]) ? s[part][0] : Object.values(s[part])[0];
        rec[key] = wrong(spec);
        n++;
        if (!refused(s)) taken.push(`${part}.${key}`);
      }
    }
    check(n > 80 && !taken.length, `every field of every record, sent as the wrong type, is refused whole (${n} fields${taken.length ? `; taken: ${taken.join(", ")}` : ""})`);
    const nested: [string, (s: Json) => unknown][] = [["a thread's prompt: {}", (s) => (s.sessions.z.prompt = {})], ["one of its updates' text: {}", (s) => (s.sessions.z.updates = [{ at, text: {} }])], ["an update that's null", (s) => (s.sessions.z.updates = [null])], ["a PR that's text", (s) => (s.sessions.z.prs = { "https://x/pull/1": "open" })], ["an attachment that's null", (s) => (s.sessions.z.attachments = { k: null })], ["a run whose output isn't text", (s) => (s.sessions.z.runs = { "m1:0": { state: "done", out: [] } })], ["a message's file that's null", (s) => (s.messages[0].files = [null])], ["a thread kept under an id that isn't its own", (s) => (s.sessions = { other: s.sessions.z })]];
    for (const [what, edit] of nested) {
      const s = base();
      edit(s);
      check(refused(s), `a first-state sync with ${what} is refused whole`);
    }
    // What a record has that its store never writes isn't taken, and what this server says of a thread (its group, its
    // WIP) is the server's to say: the rest of it is.
    const extra = base();
    Object.assign(extra.sessions.z, { owner: "mallory", group: "g-someone-elses", wip: "w-1", prompt: "fix the build" });
    const X = relay.device("dextra", { name: "extra", user_id: "u1" });
    const rx = relay.ingest(X, { state: { seq: 2, ...extra } });
    const z = X.store.state.sessions.z;
    check(!rx.error && z?.prompt === "fix the build" && !("owner" in z) && !("group" in z) && !("wip" in z), "fields a thread's store never writes, and its group and WIP, aren't taken; the rest of it is");
    // A well-formed one is still taken, as migration needs, its agent's version too (agent.hello sends it again only
    // when it changes).
    const good = relay.device("dok", { name: "ok", user_id: "u1" });
    relay.ingest(good, { state: { seq: 3, sessions: { y: { id: "y", agent: "claude", updated: at, updates: [], state: "idle" } }, agents: { claude: { id: "claude", name: "Claude", kind: "claude-code", version: "2.1.316" } } } });
    check(good.store.state.sessions.y?.id === "y" && !(() => { try { publicState(good.store.state); return false; } catch { return true; } })(), "a well-formed first-state sync is still taken, and its view reads");
    check(good.store.state.agents.claude?.version === "2.1.316", "and its agent's version is kept");
  } catch (e) {
    check(false, `A crashed: ${e.stack}`);
  } finally {
    for (const D of relay.devices.values()) D.store.close?.();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------- B. only a page's owner may point an agent at it ----------
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sec-b-"));
  const PORT = testPort(5300, 120);
  const SETUP = "security-setup-token";
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { PATH: process.env.PATH, HOME, AGENTBOOK_SERVER_HOME: path.join(HOME, "server"), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_SERVER_HOST: "127.0.0.1", AGENTBOOK_TEST_PEOPLE: SETUP };
  const server = spawnTied(path.join(REPO, "bin", "agentbook-server"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  server.stderr.on("data", (d) => (serverErr += d));
  const jar: Record<string, string> = {};
  const call = async (who: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> => {
    const h = { ...headers };
    if (jar[who]) h.cookie = jar[who];
    if (body !== undefined) h["content-type"] = "application/json";
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    if (!r) return { status: 0, json: null };
    const sc = r.headers.get("set-cookie");
    if (sc) jar[who] = sc.split(";")[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const anon = async (method: string, p: string, body?: unknown): Promise<Json> => {
    const r = await fetch(BASE + p, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    return r ? r.json().catch(() => null) : null;
  };
  try {
    const up = await until(async () => (await fetch(BASE + "/api/health").catch(() => null))?.ok);
    check(!!up, `agentbook-server starts${up ? "" : ` (${serverErr.trim().split("\n").slice(-2).join(" ")})`}`);
    // Its data folder is this user's alone, so another OS user or a backup holder can't read the database.
    check(up && (fs.statSync(path.join(HOME, "server")).mode & 0o077) === 0, "the server's data folder is 0700");

    // alice is the page's person; bob is someone it knows of (the tests' own route, server/api/test-people.ts).
    await call("alice", "POST", "/api/auth/test-person", { test: SETUP, username: "alice" });
    const bob = await call("bob", "POST", "/api/auth/test-person", { test: SETUP, username: "bob" });
    check(bob.json?.user?.username === "bob", "alice runs the server; bob is someone on it");

    const page = (await call("alice", "POST", "/api/pages", { title: "Hiring plan" })).json?.id;
    await call("alice", "POST", `/api/pages/${page}/visibility`, { visibility: "private" });
    const before = (await call("alice", "GET", `/api/pages/${page}`)).json;
    check(!!page && before?.visibility === "private" && (before.contributors || []).length === 0, "alice has a private page with no contributors");

    // bob connects a machine and its agent says hello. It never long-polls for commands, so it counts as off: a
    // start just queues, and the test needn't run a CLI to answer it.
    const start = await anon("POST", "/api/devices/start", { name: "bobmac" });
    await call("bob", "POST", "/api/devices/approve", { code: start.code });
    const token = (await anon("GET", `/api/devices/poll?poll=${encodeURIComponent(start.poll)}`))?.token;
    await fetch(BASE + "/api/cli/ops", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ops: [{ kind: "agent.hello", seq: 1, at: new Date().toISOString(), args: { agent: "claude", agent_name: "Claude", kind: "claude-code" } }] }) });
    const bobAgent = (await stateOf(async (p) => (await call("bob", "GET", p)).json))?.agents?.find((a) => a.kind === "claude-code")?.id;
    check(!!token && !!bobAgent, "bob connects a machine with a Claude agent");

    // The attack: bob points his agent at alice's page.
    const deny = await call("bob", "POST", "/api/launch", { agent: bobAgent, page, prompt: "replace the page with my own" });
    const after = (await call("alice", "GET", `/api/pages/${page}`)).json;
    check(deny.status === 403, "bob can't point his agent at alice's page: /api/launch is refused");
    check(after?.version === before?.version && (after?.contributors || []).length === 0, "and alice's page gets no new contributor and no new version");

    // The allowed case: bob points his agent at his own page, and it becomes a contributor (the start just queues,
    // since his machine is off).
    const mine = (await call("bob", "POST", "/api/pages", { title: "Bob's notes" })).json?.id;
    const allow = await call("bob", "POST", "/api/launch", { agent: bobAgent, page: mine, prompt: "keep my notes" });
    const minePage = (await call("bob", "GET", `/api/pages/${mine}`)).json;
    check(allow.status === 200 && (minePage?.contributors || []).some((c) => c.agent), "but bob may point it at his own page, and his agent becomes a contributor of it");
  } catch (e) {
    check(false, `B crashed: ${e.stack}`);
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------- C. what names someone else's things reaches nothing of theirs ----------
// alice has a private page with a number on it, a public page her agent wrote from a private thread, and bytes her
// machine sent. bob, on the same server, reaches for each from things of his own.
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sec-c-"));
  const PORT = testPort(5440, 120);
  const SETUP = "security-setup-token-c";
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { PATH: process.env.PATH, HOME, AGENTBOOK_SERVER_HOME: path.join(HOME, "server"), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_SERVER_HOST: "127.0.0.1", AGENTBOOK_TEST_PEOPLE: SETUP };
  const server = spawnTied(path.join(REPO, "bin", "agentbook-server"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  server.stderr.on("data", (d) => (serverErr += d));
  const jar: Record<string, string> = {};
  const call = async (who: string, method: string, p: string, body?: unknown) => {
    const h: Record<string, string> = {};
    if (jar[who]) h.cookie = jar[who];
    if (body !== undefined) h["content-type"] = "application/json";
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    if (!r) return { status: 0, json: null, text: "" };
    const sc = r.headers.get("set-cookie");
    if (sc) jar[who] = sc.split(";")[0];
    const text = await r.text();
    let json: Json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };
  const anon = async (method: string, p: string, body?: unknown): Promise<Json> => {
    const r = await fetch(BASE + p, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    return r ? r.json().catch(() => null) : null;
  };
  // A machine of `who`'s, logged in with a code they approve: what it sends, asks, uploads and takes, with its token.
  // It never waits for commands, so it counts as off: what's sent to it waits, and nothing waits on it.
  async function machine(who, name) {
    const start = await anon("POST", "/api/devices/start", { name });
    await call(who, "POST", "/api/devices/approve", { code: start.code });
    const token = (await anon("GET", `/api/devices/poll?poll=${encodeURIComponent(start.poll)}`))?.token;
    const auth = { authorization: `Bearer ${token}` };
    let seq = 0;
    const json = (r) => r.json().catch(() => ({}));
    return {
      token,
      ops: (list) => fetch(BASE + "/api/cli/ops", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ops: list.map(([kind, args]) => ({ kind, seq: ++seq, at: new Date().toISOString(), args })) }) }).then(json),
      ask: (what, body) => fetch(`${BASE}/api/cli/ask/${what}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then(json),
      put: async (buf) => {
        const sha = crypto.createHash("sha256").update(buf).digest("hex");
        await fetch(`${BASE}/api/cli/blobs/${sha}`, { method: "PUT", headers: auth, body: buf });
        return sha;
      },
      commands: () => fetch(`${BASE}/api/cli/commands?wait=0`, { headers: auth }).then(json).then((d) => d.commands || []),
    };
  }
  const hello = (session, label, prompt) => ["post.hello", { proc: `${session}-proc`, session_id: session, agent: "claude", agent_name: "Claude", kind: "claude-code", label, prompt }];
  try {
    const up = await until(async () => (await fetch(BASE + "/api/health").catch(() => null))?.ok);
    check(!!up, `agentbook-server starts${up ? "" : ` (${serverErr.trim().split("\n").slice(-2).join(" ")})`}`);
    await call("alice", "POST", "/api/auth/test-person", { test: SETUP, username: "alice" });
    await call("bob", "POST", "/api/auth/test-person", { test: SETUP, username: "bob" });
    // Contacts, so what alice makes public is bob's to see, and he can be put on her page.
    await call("bob", "POST", "/api/people/alice/contact", { act: "ask" });
    await call("alice", "POST", "/api/people/bob/contact", { act: "yes" });

    // alice: a machine with a private thread, a private page with a number on it, a public page her agent wrote from
    // that thread, and bytes her machine sent.
    const am = await machine("alice", "alicemac");
    await am.ops([["agent.hello", { agent: "claude", agent_name: "Claude", kind: "claude-code" }], hello("a-thread", "wren", "SECRETA thread title")]);
    const hiring = (await call("alice", "POST", "/api/pages", { title: "Hiring plan" })).json?.id;
    await call("alice", "POST", `/api/pages/${hiring}/visibility`, { visibility: "private" });
    await call("alice", "POST", `/api/pages/${hiring}/write`, { widgets: [{ id: "m", type: "metric", title: "SECRETA offers", data: { value: 4242 } }] });
    const roadmap = (await am.ask("pages/write", { post: "a-thread", agent: "claude", write: { title: "Roadmap", widgets: [{ id: "n", type: "note", title: "Plan", data: { text: "Ship it" } }] } }))?.id;
    await call("alice", "POST", `/api/pages/${roadmap}/visibility`, { visibility: "public" });
    const aliceSha = await am.put(Buffer.from("SECRETA-bytes: the offer letter"));
    check(!!hiring && !!roadmap && (await call("alice", "GET", `/api/pages/${roadmap}`)).json?.visibility === "public", "alice has a private page, a public one her agent wrote from a private thread, and bytes her machine sent");

    const bm = await machine("bob", "bobmac");
    await bm.ops([["agent.hello", { agent: "claude", agent_name: "Claude", kind: "claude-code" }], hello("b-thread", "kite", "bob's own thread")]);
    const bobAgent = (await stateOf(async (p) => (await call("bob", "GET", p)).json))?.agents?.find((a) => a.mine)?.id;
    const notes = (await call("bob", "POST", "/api/pages", { title: "Bob notes" })).json?.id;
    check(!!bobAgent && !!notes, "bob has a machine with an agent and a thread, and a page");

    // His bytes, and hers, named on his thread by their sha256: a step's picture each, his agent's avatar, his group's file.
    const bobSha = await bm.put(Buffer.from("bob's own screenshot"));
    await bm.ops([
      ["post.images", { post: "b-thread", step: "s1", images: [{ sha: aliceSha, type: "image/png", size: 31 }] }],
      ["post.images", { post: "b-thread", step: "s2", images: [{ sha: bobSha, type: "image/png", size: 20 }] }],
      ["agent.avatar", { agent: "claude", avatar: { image: "x", type: "image/png", blob: aliceSha } }],
    ]);
    const hers = await call("bob", "GET", "/api/sessions/b-thread/images/s1/0");
    const his = await call("bob", "GET", "/api/sessions/b-thread/images/s2/0");
    check(hers.status !== 200 && !hers.text.includes("SECRETA") && his.status === 200 && his.text.includes("bob's own"), "a step's picture naming alice's bytes by their sha256 shows nothing of hers; his own shows");
    const avatar = await call("bob", "GET", `/api/agents/${encodeURIComponent(bobAgent)}/avatar`);
    check(!avatar.text.includes("SECRETA"), "nor does his agent's avatar naming them");
    const group = (await call("bob", "POST", "/api/groups", { name: "Bob group" })).json?.id;
    const filed = await bm.ask("group/file", { gid: group, path: "letter.txt", sha: aliceSha, size: 31 });
    const groupFile = await call("bob", "GET", `/api/groups/${group}/file?path=letter.txt`);
    check(!!group && !!filed.error && !groupFile.text.includes("SECRETA"), "nor does his group's file naming them");

    // A start of his "for" her pages: told nothing of the private one, nor of her private thread on the public one.
    await bm.ops([["launch.add", { lid: "lb1", agent: "claude", page: hiring, prompt: "look" }], ["launch.add", { lid: "lb2", agent: "claude", page: roadmap, prompt: "look" }]]);
    const onPrivate = await bm.ask("context", { launch: "lb1", agent: "claude" });
    const onPublic = await bm.ask("context", { launch: "lb2", agent: "claude" });
    check(onPrivate && !onPrivate.page && !JSON.stringify(onPrivate).includes("SECRETA"), "a start of bob's that says it's for alice's private page is told nothing of it");
    check(onPublic?.page?.title === "Roadmap" && !JSON.stringify(onPublic).includes("SECRETA"), "one for her public page is told of it, but not of her private thread that wrote it");

    // A task for "Claude" from his agent's page is for his Claude, not hers (her machine said hello first).
    await bm.ask("pages/write", { post: "b-thread", agent: "claude", write: { title: "Bob tasks", widgets: [{ id: "t", type: "tasks", title: "To do", data: { items: [{ text: "Ship the thing", for: "Claude" }] } }] } });
    const task = (await stateOf(async (p) => (await call("bob", "GET", p)).json))?.tasks?.find((t) => t.text === "Ship the thing");
    check(task?.agent === bobAgent, "a task for an agent by its name is for his own agent of that name");

    // A routine linked to her private thread, which would put its title in each run's prompt.
    const peek = await call("bob", "POST", "/api/routines", { name: "Peek", prompt: "Say what it's doing.", links: [{ kind: "thread", id: "a-thread" }] });
    const own = await call("bob", "POST", "/api/routines", { name: "Mine", prompt: "Say what it's doing.", links: [{ kind: "thread", id: "b-thread" }] });
    check(peek.status === 404 && own.status === 200, "bob can't link alice's private thread to a routine, only his own");

    // Her page's contributors: her agents and people here, not his agent.
    const addAgent = await call("alice", "POST", `/api/pages/${roadmap}/contributors`, { agent: bobAgent });
    const addBob = await call("alice", "POST", `/api/pages/${roadmap}/contributors`, { user: "bob" });
    const contributors = (await call("alice", "GET", `/api/pages/${roadmap}`)).json?.contributors || [];
    check(addAgent.status === 404 && addBob.status === 200 && !contributors.some((c) => c.agent === bobAgent), "alice's page takes bob as a contributor, not his agent");

    // /api/health: up, and nothing of how busy anyone's machines are.
    const health = await anon("GET", "/api/health");
    check(health?.ok === true && health.seq === undefined, "/api/health says it's up, and not how many ops everyone's machines sent");

    // @mentions: his message on his thread, and a start of his, naming her private page and his own.
    await call("bob", "POST", "/api/sessions/b-thread/messages", { text: `see @${hiring}/m and @${notes}` });
    await call("bob", "POST", "/api/launch", { agent: bobAgent, prompt: `look at @${hiring}` });
    const cmds = await bm.commands();
    const deliver = cmds.find((c) => c.kind === "post.deliver");
    const start = cmds.find((c) => c.kind === "post.start");
    check(!!deliver && deliver.args.note?.includes(notes) && !JSON.stringify(deliver.args.note || "").includes("SECRETA") && !(deliver.args.note || "").includes(`@${hiring}`), "a message naming alice's private page tells his agent nothing of it, and of his own page what it is");
    check(!!start && !JSON.stringify(start.args).includes("SECRETA") && !start.args.note, "nor does a start naming it");
  } catch (e) {
    check(false, `C crashed: ${e.stack}`);
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------- D. picture fetch blocks NAT64/6to4; a page's routines hide prompt/root from non-owners ----------
{
  const { isPublic } = await import("../server/integrations/web-pictures.ts");
  check(!isPublic("64:ff9b::7f00:1") && !isPublic("64:ff9b::a9fe:a9fe") && !isPublic("2002:7f00:1::") && !isPublic("2002:c0a8:101::"), "NAT64 and 6to4 addresses embedding loopback/metadata/private IPv4 aren't treated as public");
  check(isPublic("8.8.8.8") && isPublic("2606:4700:4700::1111"), "a real public v4/v6 address still is");

  const { pageFor } = await import("../server/policy.ts");
  const at = new Date().toISOString();
  // A page as the server keeps it, and the routine on it (pageFor reads only its routines here).
  const page = { id: "p", title: "Status", emoji: "", color: null, about: "", by: { user: "alice" }, version: 1, created: at, updated: at, archived: null, visibility: "public" as const, contributors: [], widgets: [], routines: [{ id: "r1", kind: "agent", name: "refresh", runs_as: "claude", prompt: "SECRET instructions", root: "/Users/alice/secret", model: "opus", schedule: "1h" }] };
  const asOwner = pageFor(page, new Map(), true, "alice", "alice");
  const asOther = pageFor(page, new Map(), false, "alice", "bob", () => false, true);
  check(asOwner.routines[0].prompt === "SECRET instructions" && asOwner.routines[0].root === "/Users/alice/secret", "a page's owner sees its routine's prompt and root");
  check(!!asOther?.routines?.[0] && asOther.routines[0].prompt === undefined && asOther.routines[0].root === undefined && asOther.routines[0].runs_as === undefined && asOther.routines[0].model === undefined && asOther.routines[0].name === "refresh", "a non-owner sees the routine exists (name, schedule) but not its prompt, root, runs_as or model");
}

// ---------- E. a routine's ctx.sh runs without the daemon's environment ----------
{
  const { createRoutineRunner } = await import("../plugin/cli/routines.ts");
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sec-e-"));
  const SENTINEL = "SENTINEL-" + crypto.randomBytes(4).toString("hex");
  const had = process.env.AGENTBOOK_SECRET_KEY;
  process.env.AGENTBOOK_SECRET_KEY = SENTINEL; // a secret in the daemon's environment
  try {
    const runner = createRoutineRunner({ home: HOME });
    const code = `export default async (ctx) => { const r = await ctx.sh("printenv", []); return { env: r.stdout }; };`;
    const r = await runner.execute({ rid: "r-env", code, reach: { commands: ["printenv"] }, timeout: 15000, root: HOME });
    check(!!r.ok, `the routine ran${r.ok ? "" : ` (${r.error})`}`);
    check(!!r.ok && !String((r.out as { env?: string } | undefined)?.env || "").includes(SENTINEL), "a command a routine runs doesn't inherit the daemon's AGENTBOOK_SECRET_KEY");
  } catch (e) {
    check(false, `E crashed: ${e.stack}`);
  } finally {
    if (had === undefined) delete process.env.AGENTBOOK_SECRET_KEY;
    else process.env.AGENTBOOK_SECRET_KEY = had;
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------- F. a public thread's guest roster doesn't leak a private guest to a non-owner ----------
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sec-f-"));
  const PORT = testPort(5560, 120);
  const SETUP = "security-setup-token-f";
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { PATH: process.env.PATH, HOME, AGENTBOOK_SERVER_HOME: path.join(HOME, "server"), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_SERVER_HOST: "127.0.0.1", AGENTBOOK_TEST_PEOPLE: SETUP };
  const server = spawnTied(path.join(REPO, "bin", "agentbook-server"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const jar: Record<string, string> = {};
  const call = async (who: string, method: string, p: string, body?: unknown) => {
    const h: Record<string, string> = {};
    if (jar[who]) h.cookie = jar[who];
    if (body !== undefined) h["content-type"] = "application/json";
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    if (!r) return { status: 0, text: "" };
    const sc = r.headers.get("set-cookie");
    if (sc) jar[who] = sc.split(";")[0];
    return { status: r.status, text: await r.text() };
  };
  const anon = async (method: string, p: string, body?: unknown): Promise<Json> => {
    const r = await fetch(BASE + p, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    return r ? r.json().catch(() => null) : null;
  };
  try {
    await until(async () => (await fetch(BASE + "/api/health").catch(() => null))?.ok);
    await call("alice", "POST", "/api/auth/test-person", { test: SETUP, username: "alice" });
    await call("bob", "POST", "/api/auth/test-person", { test: SETUP, username: "bob" });

    // alice's machine: an agent "claude" and a private helper agent "helper", a thread "a-host" in a folder, and its
    // machine never polls for commands so it counts as off (a guest start just queues; the guest stays pending).
    const start = await anon("POST", "/api/devices/start", { name: "alicemac" });
    await call("alice", "POST", "/api/devices/approve", { code: start.code });
    const token = (await anon("GET", `/api/devices/poll?poll=${encodeURIComponent(start.poll)}`))?.token;
    let seq = 0;
    const ops = (list: [string, object][]) => fetch(BASE + "/api/cli/ops", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ops: list.map(([kind, args]) => ({ kind, seq: ++seq, at: new Date().toISOString(), args })) }) });
    await ops([
      ["agent.hello", { agent: "claude", agent_name: "Claude", kind: "claude-code" }],
      ["agent.hello", { agent: "helper", agent_name: "Helper", kind: "claude-code" }],
      ["post.hello", { proc: "a-host-proc", session_id: "a-host", agent: "claude", kind: "claude-code", label: "wren", prompt: "the host thread" }],
      ["post.where", { post: "a-host", root: path.join(HOME, "work") }],
    ]);
    await call("alice", "POST", "/api/sessions/a-host/visibility", { visibility: "public" });
    const added = await call("alice", "POST", "/api/sessions/a-host/guests", { agent: "helper", text: "help out here" });
    check(added.status === 200, `alice adds her helper agent as a guest of the public thread (${added.status})`);

    const aliceSees = (await call("alice", "GET", "/api/q/thread/a-host")).text;
    const bobSees = (await call("bob", "GET", "/api/q/thread/a-host")).text;
    check(aliceSees.includes("helper"), "the host's owner sees the guest on the roster (precondition)");
    check(!bobSees.includes("helper"), "a non-owner viewing the public host thread doesn't see the private guest's agent on the roster");
  } catch (e) {
    check(false, `F crashed: ${e.stack}`);
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------- G. one person can't pile up live connections past the cap ----------
{
  const { createLive } = await import("../server/live.ts");
  const live = createLive({ threadOf: () => null });
  const mk = () => ({ ended: false, writeHead() {}, write() {}, end() { this.ended = true; }, on() {} });
  const req = (uid: string) => ({ user: { id: uid }, on() {} });
  const res: ReturnType<typeof mk>[] = [];
  for (let i = 0; i < 52; i++) {
    const r = mk();
    res.push(r);
    live.connect(req("u1"), r, {});
  }
  const other = mk();
  live.connect(req("u2"), other, {});
  check(res[0].ended && res[1].ended && !res[2].ended, "opening past the per-user live cap (50) drops that user's oldest connections, not the rest");
  check(!other.ended, "and another user's connection isn't evicted");
}

// ---------- H. a first sync whose thread has `prompt: {}` doesn't break the feed, then or after a restart ----------
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-sec-h-"));
  const PORT = testPort(5680, 120);
  const SETUP = "security-setup-token-h";
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { PATH: process.env.PATH, HOME, AGENTBOOK_SERVER_HOME: path.join(HOME, "server"), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_SERVER_HOST: "127.0.0.1", AGENTBOOK_TEST_PEOPLE: SETUP };
  const up = () => spawnTied(path.join(REPO, "bin", "agentbook-server"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const healthy = () => until(async () => (await fetch(BASE + "/api/health").catch(() => null))?.ok);
  let server = up();
  let cookie = "";
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(BASE + p, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    if (!r) return { status: 0, text: "" };
    cookie = r.headers.get("set-cookie")?.split(";")[0] || cookie;
    return { status: r.status, text: await r.text() };
  };
  const anon = async (method: string, p: string, body?: unknown): Promise<Json> => (await fetch(BASE + p, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null))?.json().catch(() => null);
  try {
    await healthy();
    await call("POST", "/api/auth/test-person", { test: SETUP, username: "alice" });
    const start = await anon("POST", "/api/devices/start", { name: "alicemac" });
    await call("POST", "/api/devices/approve", { code: start.code });
    const token = (await anon("GET", `/api/devices/poll?poll=${encodeURIComponent(start.poll)}`))?.token;
    const sync = async (prompt: unknown): Promise<Json> => {
      const at = new Date().toISOString();
      const state = { seq: 3, agents: { claude: { id: "claude", name: "Claude", kind: "claude-code" } }, sessions: { s1: { id: "s1", agent: "claude", label: "wren", updated: at, started: at, state: "idle", prompt, updates: [], prs: {}, attachments: {} } }, messages: [] };
      const r = await fetch(BASE + "/api/cli/ops", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ state, ops: [] }) });
      return r.json().catch(() => ({}));
    };
    const feed = () => call("GET", "/api/q/feed?filter=all&n=100");
    const bad = await sync({});
    const after = await feed();
    check(!!bad.error && after.status === 200, `a first sync whose thread's prompt is {} is refused, and the feed still loads (${after.status})`);
    await sync("fix the build");
    const taken = await feed();
    check(taken.status === 200 && taken.text.includes("fix the build"), "the same machine's well-formed one is taken, and its thread is in the feed");
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    server = up();
    await healthy();
    const again = await feed();
    check(again.status === 200 && again.text.includes("fix the build"), `after a restart the feed loads, with that thread (${again.status})`);
  } catch (e) {
    check(false, `H crashed: ${e.stack}`);
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
