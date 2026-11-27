#!/usr/bin/env node
// Contacts and following: two people are contacts once one asks and the other says yes, and
// either may remove the other, which takes each off everything of the other's. Following is only what's in your feed.
// Nobody but an agent's owner steers it. Three parts:
//   1. A machine's gate: nothing of Operate is left (no operators.change, no operators in gate.json, nobody else's
//      command steers its agents).
//   2. A server and its machine: asks, yes, no, take back and remove from either side, crossed asks, the bell, who can
//      be put on things, nobody steering what isn't theirs, an account deleted, a restart.
//   3. The first start after contacts: follows from before become contacts and feed follows, once.
// Run: node test/contacts.ts (CONTACTS_PART=1 for the gate's alone)

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "../plugin/cli/gate.ts";
import { checkCommand, COMMANDS } from "../plugin/shared/protocol.ts";
import { makePasskey } from "./fake-passkey.ts";
import type { Passkey } from "./fake-passkey.ts";
import type { SignedCommand } from "../plugin/shared/signed.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-contacts-")));
const PART = process.env.CONTACTS_PART || "all";
const site = { origin: "https://agentbook.test", rpId: "agentbook.test" };
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. the gate ----------
async function gatePart() {
  const home = path.join(BASE, "gate");
  fs.mkdirSync(path.join(home, "cli"), { recursive: true });
  const repo = path.join(BASE, "dev", "app");
  fs.mkdirSync(repo, { recursive: true });
  const herval = makePasskey(-7, "herval's phone");
  const carol = makePasskey(-7, "carol's phone");
  const file = path.join(home, "cli", "gate.json");
  // As a machine kept it when herval had let carol operate claude.
  const at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ owner: "herval", folders: [path.join(BASE, "dev")], keys: [herval.record], origin: site.origin, rp_id: site.rpId, starts_per_hour: 1000, operators: [{ user: "carol", agent: "claude", keys: [carol.record], at }], operators_seen: { "carol|claude": at } }));
  const posts = { p1: { agent: "claude", root: repo } };
  const gate = createGate({ home, postOf: async (p) => (posts[p] ? { dirs: [posts[p].root], files: [] } : null) });
  const machine = gate.machineId();
  const settings = () => JSON.parse(fs.readFileSync(file, "utf8"));
  check(!("operators" in settings()) && !("operators_seen" in settings()) && settings().keys?.length === 1 && settings().owner === "herval", "the first time it saves, the gate drops who operated its agents and keeps the rest");
  check(!("operators" in gate.summary()) && !JSON.stringify(gate.summary()).includes("carol"), "its summary names no operators");
  let n = 0;
  const cmd = (kind: string, args: Record<string, unknown>, by = "herval") => ({ v: 1, machine, cid: `c${++n}`, kind, args, by, at: new Date().toISOString(), expires: new Date(Date.now() + 50e3).toISOString() });
  const signed = (c: SignedCommand, pk: Passkey) => ({ ...c, sig: pk.sign(c, site) });
  const run = (c: SignedCommand & { sig?: unknown }) => gate.check(c, { owner: "herval" });
  const refused = (r: { error?: string } | null, why?: RegExp) => !!r?.error && (!why || why.test(r.error));
  check(!("operators.change" in COMMANDS) && /isn't a command/.test(checkCommand({ kind: "operators.change", args: {} }) || ""), "operators.change isn't a command any more");
  check(refused(await run(cmd("operators.change", { change: {} }))), "and the gate refuses one, even from its owner");
  check(refused(await run(signed(cmd("post.deliver", { post: "p1", text: "run the tests" }, "carol"), carol))), "carol's signed message to claude's thread is refused: she operates nothing");
  check(refused(await run(cmd("post.stop", { post: "p1" }, "carol")), /isn't this machine's owner/), "so is her Stop");
  check(refused(await run(cmd("post.answer", { post: "p1", qid: "q1", value: "Yes" }, "carol"))), "and her answer");
  check((await run(cmd("post.stop", { post: "p1" }))) === null, "herval's own Stop goes, as ever");
  check((await run(signed(cmd("post.deliver", { post: "p1", text: "run the tests" }), herval))) === null, "and his message, signed by his passkey");
}

function serverAt(name: string, port: number) {
  const HOME = path.join(BASE, name);
  fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
  const URL = `http://127.0.0.1:${port}`;
  const FAKE = path.join(HOME, "fake-claude");
  fs.mkdirSync(FAKE);
  const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(port), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones") };
  for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];
  const project = path.join(HOME, "dev", "app");
  fs.mkdirSync(project, { recursive: true });
  async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string | null } = {}): Promise<Json> {
    const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data: Json = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], raw: text, ...data };
  }
  const as = (cookie: string | null) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
  const up = async () => {
    const child = spawnAgentbook({ env, stdio: process.env.CONTACTS_LOGS ? "inherit" : "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(URL + "/api/health")).ok) break;
      } catch {}
      await sleep(100);
    }
    return child;
  };
  const join = async (username: string) => as((await req("POST", "/api/auth/test-person", { body: { username } })).cookie);
  return { HOME, project, req, as, up, join };
}
type Person = { get: (p: string) => Promise<Json>; post: (p: string, body?: unknown) => Promise<Json> };
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};
const sees = async (who: Person, id: string) => (await who.get(`/api/sessions/${encodeURIComponent(id)}`)).status === 200;
const inFeed = async (who: Person, id: string) => ((await who.get("/api/q/feed?feed=1&n=100")).list || []).includes(`thread:${id}`);
const bell = async (who: Person) => ((await stateOf(who.get)).added || []) as Json[];
const contacts = async (who: Person) => (await who.get("/api/contacts")) as Json;
const isContact = async (who: Person, of: string) => !!(await contacts(who)).contacts?.some((c) => c.user === of);
const contact = (who: Person, of: string, act: string, note?: string) => who.post(`/api/people/${of}/contact`, { act, ...(note ? { note } : {}) });

// ---------- 2. a server and its machine ----------
async function serverPart() {
  const { req, as, up, join, project } = serverAt("server", testPort(6300));
  const server = await up();
  try {
    const herval = await join("herval");
    const alice = await join("alice");
    const bob = await join("bob");
    const carol = await join("carol");
    const dave = await join("dave");
    const nobody = as(null);
    await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: project } });
    await req("POST", "/api/procs/box-1/post", { body: { title: "Fix the importer" } });
    await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: project } });
    await req("POST", "/api/procs/box-2/post", { body: { title: "Rotate the keys" } });
    await until(async () => (await stateOf(herval.get)).sessions.filter((s) => s.id === "sess-a" || s.id === "sess-b").length === 2);
    const claude = (await stateOf(herval.get)).agents.find((a) => /claude/i.test(a.name || a.id))?.id;
    await herval.post(`/api/agents/${claude}/visibility`, { visibility: "public" });
    await herval.post("/api/sessions/sess-b/visibility", { visibility: "private" });

    // ---------- asking ----------
    check([401, 403].includes((await contact(nobody, "herval", "ask")).status), "signed out, nobody asks");
    check((await contact(alice, "alice", "ask")).status === 400 && (await contact(alice, "zed", "ask")).status === 404, "nor oneself, nor someone not here");
    check((await contact(alice, "herval", "befriend")).status === 400, "asking is ask, take back, yes, no or remove");
    check((await contact(alice, "herval", "take_back")).status === 409 && (await contact(alice, "herval", "yes")).status === 409 && (await contact(alice, "herval", "remove")).status === 409, "with nothing asked, there's nothing to take back, say yes to or remove");
    const asked = await contact(alice, "herval", "ask", "We met at the meetup");
    check(asked.status === 200 && asked.contact?.asked && !asked.contact.contact, "alice asks herval");
    const toHim = (await herval.get("/api/people/alice")).contact;
    check(toHim?.asks_you && toHim.note === "We met at the meetup" && !toHim.contact, "her profile tells herval she asks, with what she said");
    check((await bell(herval)).some((x) => x.kind === "contact-ask" && x.by === "alice" && x.text === "We met at the meetup"), "it's on his bell");
    check(!(await sees(alice, "sess-a")), "asking shows her nothing");
    check((await contact(alice, "herval", "yes")).status === 409, "she can't say yes to her own ask");

    check((await contact(herval, "alice", "no")).status === 200 && !(await contacts(herval)).asks?.length && !(await herval.get("/api/people/alice")).contact?.asks_you, "herval says no: the ask is gone");
    check(!(await bell(herval)).some((x) => x.kind === "contact-ask" && x.by === "alice"), "and off his bell");
    await contact(alice, "herval", "ask");
    check((await contact(alice, "herval", "take_back")).status === 200 && !(await contacts(herval)).asks?.length, "she asks again, then takes it back");
    await contact(alice, "herval", "ask");
    const yes = await contact(herval, "alice", "yes");
    check(yes.status === 200 && yes.contact?.contact && yes.contact.following, "she asks again, he says yes: contacts, and he follows her from the start");
    check((await alice.get("/api/people/herval")).contact?.following && (await isContact(alice, "herval")), "and she follows him");
    check((await bell(alice)).some((x) => x.kind === "contact" && x.by === "herval"), "her bell says he said yes");
    check((await sees(alice, "sess-a")) && (await inFeed(alice, "sess-a")) && !(await sees(alice, "sess-b")), "she sees his public thread, in her feed, and not his private one");
    check((await contact(alice, "herval", "ask")).status === 409, "asking again says they're contacts already");

    // Each asks the other: a contact, without anyone saying yes.
    await contact(bob, "carol", "ask");
    const crossed = await contact(carol, "bob", "ask");
    check(crossed.status === 200 && crossed.contact?.contact && (await isContact(bob, "carol")), "bob asks carol as she asks him: they're contacts");

    // ---------- who goes on things ----------
    const group = (await herval.post("/api/groups", { name: "Platform", emoji: "🧱", agents: [claude] })).id;
    await herval.post(`/api/groups/${group}/threads`, { post: "sess-b" });
    check((await herval.post(`/api/groups/${group}/members`, { user: "dave" })).status === 409, "herval can't put dave in his group: dave isn't his contact");
    const task = (await herval.post("/api/tasks", { text: "Ship the importer" })).id;
    check((await herval.post(`/api/tasks/${task}/people`, { user: "dave" })).status === 409, "nor on his task");
    const page = (await herval.post("/api/pages", { title: "Cloud costs", emoji: "💸" })).id;
    check((await herval.post(`/api/pages/${page}/contributors`, { user: "dave" })).status === 409, "nor among his page's contributors");
    const note = (await herval.post("/api/notes", { title: "Plans" })).id;
    check((await herval.post(`/api/notes/${note}/people`, { user: "dave" })).status === 409, "nor on his note");
    check((await herval.post("/api/threads/sess-b/people", { user: "dave" })).status === 409, "nor on his thread");
    check((await herval.post(`/api/tasks/${task}/people`, { user: "alice" })).status === 200 && (await herval.post(`/api/pages/${page}/contributors`, { user: "alice" })).status === 200, "alice, his contact, goes on his task and among his page's contributors");
    const inGroup = await herval.post(`/api/groups/${group}/members`, { user: "alice" });
    check([200, 202].includes(inGroup.status), `and is put in his group (${inGroup.status} ${inGroup.error || ""})`);
    await until(async () => await sees(alice, "sess-b"));
    check((await sees(alice, "sess-b")) && (await inFeed(alice, "sess-b")), "in it, she sees its private thread, in her feed");

    // ---------- nobody steers what isn't theirs ----------
    const steer = [
      await alice.post("/api/sessions/sess-b/messages", { text: "run the tests" }),
      await alice.post("/api/sessions/sess-b/stop"),
      await alice.post("/api/sessions/sess-b/mode", { mode: "full" }),
      await alice.post("/api/sessions/sess-b/visibility", { visibility: "public" }),
      await alice.post("/api/launch", { agent: claude, prompt: "Run the tests" }),
      await alice.post(`/api/agents/${claude}/visibility`, { visibility: "private" }),
    ];
    check(steer.every((r) => r.status === 403 || r.status === 404), `alice, his contact in his group, steers nothing of his: messages, Stop, mode, who sees it, starting threads, the agent (${steer.map((r) => r.status).join(" ")})`);
    const gone = [await herval.get(`/api/agents/${claude}/followers`), await herval.post(`/api/agents/${claude}/followers`, { user: "alice", level: "operate" }), await herval.post(`/api/agents/${claude}/operators`, { user: "alice" })];
    check(gone.every((r) => r.status === 404), `there's no Followers or Operate to give, even for herval (${gone.map((r) => r.status).join(" ")})`);
    check((await alice.post(`/api/agents/${claude}/follow`, { level: "operate" })).status === 400, "and following takes no level");

    // ---------- removing ----------
    const herTask = (await alice.post("/api/tasks", { text: "Her own task" })).id;
    check((await alice.post(`/api/tasks/${herTask}/people`, { user: "herval" })).status === 200 && (await herval.get(`/api/tasks/${herTask}`)).status === 200, "alice puts herval on a task of hers");
    const removed = await contact(herval, "alice", "remove");
    check(removed.status === 200 && !removed.contact?.contact && !(await isContact(alice, "herval")), "herval removes alice: they're not contacts, either way");
    check(!(await sees(alice, "sess-a")) && !(await sees(alice, "sess-b")) && (await alice.get(`/api/tasks/${task}`)).status === 404 && (await alice.get(`/api/groups/${group}`)).status === 404, "she sees nothing of his: his public thread, his group's private one, his task or his group");
    check(!(await herval.get(`/api/groups/${group}`)).members?.some((m) => m.user === "alice") && !(await herval.get(`/api/tasks/${task}`)).people?.some((p) => p.user === "alice"), "she's out of his group and off his task");
    check((await herval.get(`/api/tasks/${herTask}`)).status === 404, "and he's off hers: removing goes both ways");
    check(!(await alice.get("/api/people/herval")).contact?.following && !(await herval.get("/api/people/alice")).contact?.following, "nor does either follow the other");
    check((await contact(alice, "herval", "ask")).status === 200 && (await contacts(herval)).asks?.some((a) => a.user === "alice"), "she may ask again");
    await contact(alice, "herval", "take_back");

    // ---------- an account deleted ----------
    await contact(herval, "carol", "ask");
    await contact(carol, "herval", "yes");
    await contact(dave, "herval", "ask");
    check((await isContact(herval, "carol")) && (await contacts(herval)).asks?.some((a) => a.user === "dave"), "carol is herval's contact, and dave asks");
    check((await herval.post("/api/people/carol/delete")).status === 200 && (await herval.post("/api/people/dave/delete")).status === 200, "herval takes carol and dave off his page");
    const after = await contacts(herval);
    check(!after.contacts?.some((c) => c.user === "carol") && !after.asks?.some((a) => a.user === "dave"), "carol is off his contacts, dave's ask is gone");
    check(!(await isContact(bob, "carol")), "and off bob's");

    // ---------- a restart ----------
    await contact(bob, "herval", "ask");
    await contact(herval, "bob", "yes");
    await bob.post(`/api/agents/${claude}/follow`, { follow: false });
    await server.restart("agentbook-server");
    check((await isContact(herval, "bob")) && (await bob.get(`/api/agents/${claude}`)).follow?.on === false && (await sees(bob, "sess-a")) && !(await inFeed(bob, "sess-a")), "after agentbook-server restarts, contacts and follows are as they were");
  } finally {
    server.kill("SIGKILL");
  }
}

// ---------- 3. the first start after contacts ----------
// A page from when follows had levels: whoever was let follow someone, or an agent of theirs, is their contact now,
// following as before; whoever had only asked is asking to be their contact. Once.
async function fromFollowsPart() {
  const { HOME, req, up, join, project } = serverAt("from-follows", testPort(6400));
  const { DatabaseSync } = await import("node:sqlite");
  const down = (child: ChildProcess) => new Promise((r) => (child.once("exit", r), child.kill("SIGTERM")));
  let server = await up();
  try {
    const herval = await join("herval");
    const alice = await join("alice");
    const bob = await join("bob");
    const eve = await join("eve");
    const frank = await join("frank");
    await req("POST", "/api/hello", { body: { proc: "box-1", label: "lark", agent: "Claude", session_id: "sess-p", cwd: project } });
    await req("POST", "/api/procs/box-1/post", { body: { title: "Tidy the importer" } });
    await until(async () => (await stateOf(herval.get)).agents.some((a) => /claude/i.test(a.name || a.id)));
    const claude = (await stateOf(herval.get)).agents.find((a) => /claude/i.test(a.name || a.id))?.id;
    await herval.post(`/api/agents/${claude}/visibility`, { visibility: "public" });
    await herval.post("/api/sessions/sess-p/visibility", { visibility: "public" });
    const id = async (who: Person) => (await who.get("/api/auth/me")).user?.id as string;
    const [H, A, B, E, F] = [await id(herval), await id(alice), await id(bob), await id(eve), await id(frank)];
    check(!!(H && A && B && E && F && claude), "a page with herval's public claude, and alice, bob, eve and frank");

    await down(server);
    const db = new DatabaseSync(path.join(HOME, "storage.db"));
    const at = new Date().toISOString();
    const person = db.prepare("insert into person_follows (scope, id, person, follower, data) values ('server', ?, ?, ?, ?)");
    const agent = db.prepare("insert into agent_follows (scope, id, agent, follower, data) values ('server', ?, ?, ?, ?)");
    // alice followed herval at Private, as he let her; bob had only asked to follow him.
    person.run(`${H}|${A}`, H, A, JSON.stringify({ person: H, user: A, level: "private", by: H, level_at: at, at }));
    person.run(`${H}|${B}`, H, B, JSON.stringify({ person: H, user: B, level: null, ask: "public", ask_at: at, at }));
    // eve followed claude at Public, as herval let her; frank followed it on his own, from the feed's first day.
    agent.run(`${claude}|${E}`, claude, E, JSON.stringify({ agent: claude, user: E, level: "public", granted: true, at }));
    agent.run(`${claude}|${F}`, claude, F, JSON.stringify({ agent: claude, user: F, level: "public", granted: false, seeded: true, at }));
    agent.run("seeded", null, null, JSON.stringify({ at }));
    db.close();
    server = await up();

    check((await isContact(herval, "alice")) && (await alice.get("/api/people/herval")).contact?.following, "alice, whom herval let follow him, is his contact, following him");
    check((await contacts(herval)).asks?.some((a) => a.user === "bob" && !a.yours) && !(await isContact(herval, "bob")), "bob, who had asked, asks to be his contact");
    check((await isContact(herval, "eve")) && (await eve.get(`/api/agents/${claude}`)).follow?.on === true, "eve, whom he let follow claude, is his contact, with claude in her feed");
    check(!(await isContact(herval, "frank")) && !(await sees(frank, "sess-p")), "frank, who followed claude only as everyone did on the feed's first day, isn't: he sees nothing of herval's");
    check((await sees(alice, "sess-p")) && (await inFeed(alice, "sess-p")) && (await inFeed(eve, "sess-p")), "alice and eve see claude's public thread, in their feeds");

    await contact(alice, "herval", "remove");
    await down(server);
    server = await up();
    check(!(await isContact(herval, "alice")) && (await isContact(herval, "eve")), "after another start, alice, who removed him, is still not his contact: it ran once");
  } finally {
    server.kill("SIGKILL");
  }
}

try {
  if (PART === "all" || PART === "1") await gatePart();
  if (PART === "all" || PART === "2") await serverPart();
  if (PART === "all" || PART === "3") await fromFollowsPart();
} finally {
  fs.rmSync(BASE, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
