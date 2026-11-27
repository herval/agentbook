#!/usr/bin/env node
// Someone the page's person takes off their page (server/api/people.ts), and sign-ins that end: nothing of theirs
// keeps working. Their sign-ins end, and the pages they have open stop hearing from the server: the live stream asks
// who it's for again before each push, not only when it connected. So do signing out and signing out everywhere, for
// the other tabs. Their machines' tokens stop working, and a poll one has open ends; a machine's token also stops once
// it goes unused for MACHINE_IDLE_DAYS. Each person disconnects only their own machines. Taking someone off keeps
// their username, so nobody new takes it, or what it made.
// Run: node test/offboarding.ts

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createAccounts, MACHINE_IDLE_DAYS, SESSION_DAYS, SESSION_IDLE_DAYS } from "../server/accounts.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { spawnTied, testPort } from "./harness.ts";
import { closeSql, sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

// ---------- the accounts, on their own ----------
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-offboard-a-"));
  const storage = Storage.at(path.join(HOME, "storage.db"));
  const db = sql(storage.file);
  try {
    const a = createAccounts(storage);
    const alice = a.create({ username: "alice", role: "admin" }).user;
    const bob = a.create({ username: "bob" }).user;
    const session = a.startSession(bob.id).token;
    const machine = (name: string) => {
      const req = a.requestDevice(name);
      const d = a.approveDevice(req.code, bob.id);
      return { ...d, token: a.pollDevice(req.poll).token };
    };
    const laptop = machine("laptop");
    check(a.sessionUser(session)?.id === bob.id && a.deviceFor(laptop.token)?.user_id === bob.id, "bob signs in and connects a laptop");

    // A machine that hasn't used its token for MACHINE_IDLE_DAYS logs in again.
    const old = machine("old-desktop");
    const ago = (days: number) => new Date(Date.now() - days * 86400e3).toISOString();
    db.prepare("update devices set created = ?, last_seen = ? where id = ?").run(ago(400), ago(MACHINE_IDLE_DAYS + 1), old.id);
    db.prepare("update devices set created = ?, last_seen = ? where id = ?").run(ago(400), ago(1), laptop.id);
    check(a.deviceFor(old.token) === null && a.deviceById(old.id).revoked === 1, `a machine's token unused for ${MACHINE_IDLE_DAYS} days stops working, and the machine is disconnected`);
    check(a.deviceFor(laptop.token)?.id === laptop.id, "one connected long ago but used yesterday still works");
    const idle = machine("idle-mini");
    db.prepare("update devices set last_seen = ? where id = ?").run(ago(MACHINE_IDLE_DAYS + 5), idle.id);
    check(!a.devices(bob.id).some((d) => d.id === idle.id) && a.deviceById(idle.id).revoked === 1, "and listing someone's machines disconnects the ones that went idle, rather than showing them");

    // A browser sign-in ends after SESSION_DAYS, or sooner once it's gone SESSION_IDLE_DAYS unused.
    const stale = a.startSession(bob.id).token;
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    db.prepare("update auth_sessions set last_seen = ? where token_hash = ?").run(ago(SESSION_IDLE_DAYS + 1), sha(stale));
    check(a.sessionUser(stale) === null, `a sign-in unused for ${SESSION_IDLE_DAYS} days is over`);
    const past = a.startSession(bob.id).token;
    db.prepare("update auth_sessions set expires = ? where token_hash = ?").run(ago(1), sha(past));
    check(a.sessionUser(past) === null && a.sessionUser(session)?.id === bob.id, `one past its ${SESSION_DAYS} days is over too; one in use isn't`);
    check(Date.parse(a.startSession(bob.id).expires) - Date.now() < (SESSION_DAYS + 1) * 86400e3, `a new sign-in lasts ${SESSION_DAYS} days at most`);

    check(a.admins().map((u) => u.username).join() === "alice", "the page's person is alice");

    // Taken off the page: for good, without what was only theirs, its username kept.
    const back = a.startSession(bob.id).token;
    a.addPasskey(bob.id, { id: "k1", alg: -7, spki: "x", name: "bob's key" });
    a.pin(bob.id, "post-1", true);
    a.setAvatar(bob.id, { emoji: "🦊" });
    const gone = a.remove(bob.id);
    check(gone.user.deleted && gone.user.disabled && gone.devices.includes(laptop.id), "taking bob off marks his row, and says which machines it took off");
    check(a.sessionUser(back) === null && a.sessionUser(session) === null && a.deviceFor(laptop.token) === null, "his sign-ins and his machines' tokens stop working");
    check(!a.passkeys(bob.id).length && !a.pins(bob.id).size && a.byId(bob.id).avatar === null, "its passkeys, pins and picture are gone");
    check(!a.list().some((u) => u.username === "bob") && a.byId(bob.id)?.username === "bob", "it's off the list, but its row stays: what it made still says whose it was");
    check(!!a.create({ username: "bob" }).error, "nobody new takes its username");
    check(a.byUsername("alice")?.role === "admin" && !a.byUsername("alice").disabled, "alice is as she was");
  } catch (e) {
    check(false, `accounts crashed: ${e.stack}`);
  } finally {
    closeSql(storage.file);
    storage.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------- on a real agentbook-server ----------
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-offboard-b-"));
  const PORT = testPort(5600, 120);
  const PEOPLE = "offboarding-people";
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { PATH: process.env.PATH, HOME, AGENTBOOK_SERVER_HOME: path.join(HOME, "server"), AGENTBOOK_SERVER_PORT: String(PORT), AGENTBOOK_SERVER_HOST: "127.0.0.1", AGENTBOOK_TEST_PEOPLE: PEOPLE };
  const server = spawnTied(path.join(REPO, "bin", "agentbook-server"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverOut = "";
  server.stdout.on("data", (d) => (serverOut += d));
  server.stderr.on("data", (d) => (serverOut += d));
  async function call(method: string, p: string, { cookie, body, token }: { cookie?: string; body?: unknown; token?: string } = {}): Promise<Json> {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    if (!r) return { status: 0 };
    const set = r.headers.get("set-cookie");
    return { status: r.status, cookie: set ? set.split(";")[0] : null, ...((await r.json().catch(() => ({}))) as Json) };
  }
  // A sign-in, as the tests make them (server/api/test-people.ts): the first person is the page's.
  const signIn = async (username: string) => (await call("POST", "/api/auth/test-person", { body: { username, test: PEOPLE } })).cookie;
  const storageDb = path.join(HOME, "server", "storage.db");
  // A page's stream, as a browser holds it open: what it heard, and whether the server ended it. `status`: what the
  // server answered; `ready`: once it's said hello.
  interface Stream {
    data: string;
    ended: boolean;
    status?: number;
    req: http.ClientRequest;
    ready: () => Promise<boolean>;
  }
  let streams = 0;
  function stream(cookie: string) {
    const s: Stream = {
      data: "",
      ended: false,
      req: http.get({ host: "127.0.0.1", port: PORT, path: `/api/live?live=offboarding-${++streams}-page`, headers: { cookie } }, (res) => {
        s.status = res.statusCode;
        res.on("data", (d) => (s.data += d));
        res.on("end", () => (s.ended = true));
        res.on("close", () => (s.ended = true));
      }),
      ready: () => until(() => s.data.includes("event: hello")),
    };
    s.req.on("error", () => (s.ended = true));
    return s;
  }
  // A machine of `cookie`'s person, logged in with a code: its token.
  async function connect(cookie: string, name: string) {
    const start = await call("POST", "/api/devices/start", { body: { name } });
    await call("POST", "/api/devices/approve", { cookie, body: { code: start.code } });
    return (await call("GET", `/api/devices/poll?poll=${encodeURIComponent(start.poll)}`)).token;
  }
  const open: Stream[] = [];
  try {
    const up = await until(async () => (await fetch(BASE + "/api/health").catch(() => null))?.ok);
    check(!!up, `agentbook-server starts${up ? "" : ` (${serverOut.trim().split("\n").slice(-2).join(" ")})`}`);

    const alice = await signIn("alice");
    const b1 = await signIn("bob");
    const b2 = await signIn("bob");
    check(!!alice && !!b1 && !!b2 && b1 !== b2, "the page is alice's; bob is on it too, signed in on two browsers");

    // ---- signing out ends the other tabs' streams, now ----
    const s1 = stream(b1);
    const s2 = stream(b2);
    open.push(s1, s2);
    check((await s1.ready()) && (await s2.ready()), "both of bob's browsers have a page open, hearing what changes");
    await call("POST", "/api/me/signout-everywhere", { cookie: b2 });
    check(await until(() => s1.ended, 2000), "signing out everywhere else ends the other browser's stream at once");
    await sleep(200);
    check(!s2.ended, "and not this one's");
    const s1again = stream(b1);
    open.push(s1again);
    check((await until(() => s1again.status)) === 401 && (await call("GET", "/api/auth/me", { cookie: b1 })).user === null, "the other browser, asking again, is told to sign in");

    const b3 = await signIn("bob");
    const s3 = stream(b3);
    open.push(s3);
    await s3.ready();
    await call("POST", "/api/auth/logout", { cookie: b3 });
    check(await until(() => s3.ended, 2000), "signing out ends that browser's stream");
    await sleep(200);
    check(!s2.ended, "and not another's");

    // ---- each push asks again who a stream is for ----
    // A sign-in that ends outside the server (its time up, written by another process): nothing in the server hears of
    // it, until the next push, which asks again.
    const b4 = await signIn("bob");
    const s4 = stream(b4);
    open.push(s4);
    await s4.ready();
    await call("GET", "/api/q/side?live=offboarding-5-page", { cookie: b4 });
    const bobId = (await call("GET", "/api/people/bob", { cookie: alice })).user?.id;
    sql(storageDb).prepare("update auth_sessions set expires = ? where user_id = ?").run(new Date(Date.now() - 60e3).toISOString(), bobId);
    await sleep(300);
    check(!s4.ended, "a sign-in that ran out where the server didn't see: bob's page is still open");
    await call("POST", "/api/pages", { cookie: alice, body: { title: "Q4 plan" } });
    check(await until(() => s4.ended, 3000), "the next push asks who the stream is for again, and ends it");
    check((await call("GET", "/api/auth/me", { cookie: b4 })).user === null, "and that browser is signed out");

    // ---- each person disconnects only their own machines ----
    const b6 = await signIn("bob");
    const token = await connect(b6, "bobmac");
    check((await call("POST", "/api/cli/hello", { token, body: {} })).status === 200, "bob connects a machine");
    const mac = (await call("GET", "/api/people/bob", { cookie: b6 })).devices?.find((d) => d.name === "bobmac");
    check(!!mac && (await call("GET", "/api/people/bob", { cookie: alice })).devices === undefined && (await call("GET", "/api/people/alice", { cookie: b6 })).devices === undefined, "only its person sees a machine on their profile");
    check((await call("POST", `/api/devices/${mac?.id}/revoke`, { cookie: alice })).status === 404 && (await call("POST", "/api/cli/hello", { token, body: {} })).status === 200, "alice can't disconnect bob's machine, though the page is hers");
    check((await call("POST", `/api/devices/${mac?.id}/revoke`, { cookie: b6 })).status === 200 && (await call("POST", "/api/cli/hello", { token, body: {} })).status === 403, "bob disconnects his own");
    const token4 = await connect(alice, "alicemac");
    const amac = (await call("GET", "/api/people/alice", { cookie: alice })).devices?.find((d) => d.name === "alicemac");
    check((await call("POST", `/api/devices/${amac?.id}/revoke`, { cookie: b6 })).status === 404 && (await call("POST", "/api/cli/hello", { token: token4, body: {} })).status === 200, "but not alice's");
    check((await call("POST", "/api/people/alice/delete", { cookie: b6 })).status === 403, "bob can't take anyone off the page: it's alice's");
    check((await call("POST", "/api/people/alice/delete", { cookie: alice })).status === 400, "alice can't take herself off it (agentbook logout does that)");

    // ---- taken off the page ----
    const s6 = stream(b6);
    open.push(s6);
    await s6.ready();
    const token5 = await connect(b6, "bobmini");
    // What he has here before he goes: a machine with a public thread, a file sent from the page (bytes alice sent
    // too), a page, a group, a task and a thread of his own.
    const at = new Date().toISOString();
    await call("POST", "/api/cli/hello", { token: token5, body: {} });
    const took = await call("POST", "/api/cli/ops", { token: token5, body: { epoch: "e1", ops: [], state: { seq: 2, sessions: { z: { id: "z", agent: "claude", title: "Bob's Q4 thread", updated: at, updates: [], state: "idle", visibility: "public" } }, agents: { claude: { id: "claude", name: "Claude", kind: "claude-code", visibility: "public" } } } } });
    const mini = (await call("GET", "/api/people/bob", { cookie: b6 })).devices?.find((d) => d.name === "bobmini");
    const bytes = Buffer.from("bob's and alice's file\n");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const sendFile = (cookie: string): Promise<Json> => fetch(`${BASE}/api/upload?draft=1&name=notes.txt`, { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: bytes }).then((r) => r.json());
    const bobsFile = await sendFile(b6);
    const alicesFile = await sendFile(alice);
    const onlyBobs = Buffer.from("only bob sent this\n");
    const onlyBobsSha = crypto.createHash("sha256").update(onlyBobs).digest("hex");
    await fetch(`${BASE}/api/upload?draft=1&name=mine.txt`, { method: "POST", headers: { cookie: b6, "content-type": "application/octet-stream" }, body: onlyBobs });
    const pid = (await call("POST", "/api/pages", { cookie: b6, body: { title: "Bob's page" } })).id;
    const gid = (await call("POST", "/api/groups", { cookie: b6, body: { name: "Bob's group" } })).id;
    const tid = (await call("POST", "/api/tasks", { cookie: b6, body: { text: "Bob's task" } })).id;
    const talk = (await call("POST", "/api/talks", { cookie: b6, body: { text: "Bob's own thread" } })).id;
    const serverHome = path.join(HOME, "server");
    // What the server keeps, in its one database (storage.db, in its own data folder: no agentbook-cli shares it
    // here): its own store is scope "server", its copy of each machine "device:<id>".
    const rows = (query: string, ...args: SQLInputValue[]) => (sql(path.join(serverHome, "storage.db")).prepare(query).get(...args) as { n: number }).n;
    const machineRows = () => rows("select (select count(*) from events where scope = ?) + (select count(*) from meta where scope = ?) n", `device:${mini.id}`, `device:${mini.id}`);
    check(took.status === 200 && !!mini && machineRows() > 0 && fs.existsSync(path.join(serverHome, "blobs", sha)) && fs.existsSync(path.join(serverHome, "blobs", onlyBobsSha)) && !!pid && !!gid && !!tid && !!talk && !!bobsFile.id && !!alicesFile.id, "bob's machine sent a thread, and he sent two files, a page, a group, a task and a thread of his own");
    // He and alice are contacts, each following the other.
    await call("POST", "/api/people/alice/contact", { cookie: b6, body: { act: "ask" } });
    await call("POST", "/api/people/bob/contact", { cookie: alice, body: { act: "yes" } });
    const herBox = await call("GET", "/api/contacts", { cookie: alice });
    check(herBox.contacts?.some((c) => c.user === "bob" && c.following), "alice and bob are contacts, and she follows him");
    const feedHas = async (cookie, text) => JSON.stringify(await call("GET", "/api/q/feed", { cookie })).includes(text);
    check(await feedHas(alice, "Bob's Q4 thread"), "alice sees his public thread on her feed");
    // His machine takes what's waiting for it (its group), then waits for more.
    await call("GET", "/api/cli/commands", { token: token5 });
    let polled = null;
    const asked = Date.now();
    const poll = call("GET", "/api/cli/commands?wait=25", { token: token5 }).then((r) => (polled = { ...r, ms: Date.now() - asked }));
    await sleep(200);
    const del = await call("POST", "/api/people/bob/delete", { cookie: alice });
    check(del.status === 200 && !!del.user?.deleted, "alice takes bob off her page");
    check(await until(() => s6.ended, 2000), "his open page's stream ends at once");
    await until(() => polled, 3000);
    check(polled?.status === 200 && polled.commands?.length === 0 && polled.ms < 5000, `his machine's open poll ends at once, with nothing (${polled?.ms} ms)`);
    check((await call("POST", "/api/cli/hello", { token: token5, body: {} })).status === 403 && (await call("GET", "/api/q/side", { cookie: b6 })).status === 401, "his machines are logged out, and his browser signed out");
    await poll;
    // And everything he had here is gone: his machine's database and files, his things on the server and the ops
    // that made them, the bytes only he sent; what alice sent too stays, hers.
    check(machineRows() === 0 && rows("select count(*) n from devices where user_id = ?", bobId) === 0 && rows("select count(*) n from cursors where device = ?", mini.id) === 0, "what the server kept of his machine is gone, and the machine itself");
    check(!(await feedHas(alice, "Bob's Q4 thread")), "his thread is off alice's feed");
    check((await call("GET", `/api/pages/${pid}`, { cookie: alice })).status === 404 && ["pages", "groups", "tasks", "talks"].every((t) => rows(`select count(*) n from ${t} where scope = 'server' and id = ?`, { pages: pid, groups: gid, tasks: tid, talks: talk }[t]) === 0), "his page, group, task and own thread are gone from the server's database");
    check([pid, gid, tid, talk].every((id) => rows("select count(*) n from events where scope = 'server' and op like ?", `%${id}%`) === 0), "and so are the ops that made them");
    const after = await call("GET", "/api/contacts", { cookie: alice });
    check(!after.contacts?.some((c) => c.user === "bob") && rows("select count(*) n from contacts where scope = 'server' and (a = ? or b = ?)", bobId, bobId) === 0 && rows("select count(*) n from person_follows where scope = 'server' and (person = ? or follower = ?)", bobId, bobId) === 0, "he's off her contacts, and his follows are gone both ways, rows and all");
    check(!fs.existsSync(path.join(serverHome, "blobs", onlyBobsSha)) && rows("select count(*) n from uploads where owner = ?", bobId) === 0, "the bytes only he sent are gone, with his uploads");
    check(fs.existsSync(path.join(serverHome, "blobs", sha)) && rows("select count(*) n from uploads where id = ?", alicesFile.id) === 1, "the bytes alice sent too stay, hers");
    check(!(await call("GET", "/api/people", { cookie: alice })).people?.some((u) => u.username === "bob") && !!(await call("GET", "/api/people/bob", { cookie: alice })).user?.deleted, "he's off the list; his profile says the account was deleted");
    check(/@alice took @bob off this page/.test(serverOut), "the server logs who took whom off");
  } catch (e) {
    check(false, `server crashed: ${e.stack}`);
  } finally {
    for (const s of open) s.req.destroy();
    server.kill("SIGTERM");
    await sleep(200);
    closeSql();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
