#!/usr/bin/env node
// Contacts on other agentbooks: alice and bob, each a person with an
// account of their own on the relay (test/fake-relay.ts), each with one machine running their page (`agentbook
// webui`, one process), each page's door (plugin/door/, server/door.ts) on 127.0.0.1 with no relay
// (AGENTBOOK_IROH=local).
//   - Each page's door comes up on its own, its key certified for the person's account; they go by their username,
//     and their invite link says so, with their account and door key.
//   - Nobody can be looked up: alice adds bob by pasting the invite link he gave her, and his card comes from his
//     door. A second @bob (his own page, his own account) is bob-2 on hers: handles aren't unique, accounts are.
//   - Asks and answers both ways, as contacts work on one page: the Contacts box and the bell, yes or no, taken back,
//     removed by either. Following stays on each one's page. An ask sent while the other's page is off arrives once
//     it's on.
//   - A stranger's door gets nothing past the card; nothing anyone sends runs anything.
//   - What alice publishes to bob (server/publish.ts): her public things, and a private one she puts him on, field by
//     field as the lists say, never a folder, a branch or steps; taken back when she takes him off one or removes him;
//     kept from bob's agents.
//   - carol, whom alice names in a thread and bob doesn't know: the thread names her by her account, so bob's page
//     names nobody, and carol's bell rings once she sees alice's thread.
//   - Taking part: bob comments on alice's thread (its People lane, her bell, her agent only once she passes it on);
//     a group of alice's with bob and carol in it once each says yes (bob's thread reaches carol signed by bob, a copy
//     alice's door changed is refused, bob's note reaches alice's thread as his, a proposal from outside it or a file
//     named ../x is refused, leaving takes his thread back); a page bob's agent writes from his machine (a version
//     by "@bob's Claude", no html, alice restores the one before); a task and a note carol is on.
// Run: node test/people.ts

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnAgentbook, spawnTied } from "./harness.ts";
import { fakeRelay } from "./fake-relay.ts";
import { stateOf } from "./harness-state.ts";
import { sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";
import { irohModule } from "../plugin/door/spawn.ts";
import { makeIroh } from "../plugin/shared/iroh.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(path.resolve(TEST, ".."), "plugin");
if (!irohModule()) {
  console.log("SKIP  iroh isn't installed here (npm install)");
  process.exit(0);
}
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-people-")));
const IROH_DIR = path.join(BASE, "iroh");
fs.mkdirSync(IROH_DIR);
const relay = await fakeRelay();

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 20e3): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};

// ---------- the people and their pages ----------
interface Who {
  name: string;
  // Their username on their own page, and the handle they go by: their name, but for bob2, who's @bob too.
  username: string;
  acct: string;
  port: number;
  base: string;
  env: NodeJS.ProcessEnv;
  home: string;
  proc: ReturnType<typeof spawnAgentbook> | null;
  cookie: string;
}
// Every machine's home folder.
const HOME_DIR = path.join(BASE, "home");
const common: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_RELAY_URL: relay.url, HOME: HOME_DIR, CLAUDE_CONFIG_DIR: path.join(BASE, "home", ".claude"), AGENTBOOK_HARNESS_ONE: "1", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_DESKTOP_DIRS: "", AGENTBOOK_IROH: "local", AGENTBOOK_IROH_DIR: IROH_DIR, AGENTBOOK_DOOR: "1", AGENTBOOK_DOOR_RETRY_MS: "500", AGENTBOOK_FEED_MS: "300" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_URL", "AGENTBOOK_SERVER_HOME", "CLAUDE_JOB_DIR"]) delete common[k];
async function person(name: string, port: number): Promise<Who> {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, "cli"), { recursive: true });
  const env = { ...common, AGENTBOOK_PORT: String(port), AGENTBOOK_HOME: home, AGENTBOOK_MACHINE: `${name}-mbp`, AGENTBOOK_CLONE_DIR: path.join(home, "clones"), AGENTBOOK_URL: `http://localhost:${port}` };
  return { name, username: name, acct: crypto.randomUUID(), port, base: `http://127.0.0.1:${port}`, env, home, proc: null, cookie: "" };
}
// `agentbook login` on their machine, said yes to on the relay's page for their account.
function logIn(w: Who): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnTied(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "login", "--no-open", "--no-start"], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let answered = false;
    const take = (b: Buffer) => {
      out += b;
      const code = /\b([B-Z]{4}-[B-Z]{4})\b/.exec(out)?.[1];
      if (code && !answered) {
        answered = true;
        setTimeout(() => relay.approve(code, w.acct), 50);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("exit", (status) => resolve({ status, out }));
  });
}
const logFile = (w: Who) => path.join(BASE, `${w.name}.log`);
function run(w: Who) {
  const fd = fs.openSync(logFile(w), "a");
  w.proc = spawnAgentbook({ env: w.env, stdio: ["ignore", fd, fd] });
}
async function stopIt(w: Who) {
  const p = w.proc;
  w.proc = null;
  if (!p || p.exitCode !== null) return;
  const gone = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await Promise.race([gone, sleep(8000)]);
}
const call = (w: Who, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(w.base + p, { ...opts, headers: { ...(w.cookie ? { cookie: w.cookie } : {}), ...(opts.headers || {}) }, signal: AbortSignal.timeout(40e3) });
const get = async (w: Who, p: string): Promise<Json> => {
  const r = await call(w, p).catch(() => null);
  return r ? { status: r.status, ...((await r.json().catch(() => ({}))) as Json) } : { status: 0 };
};
const send = async (w: Who, method: string, p: string, body: unknown): Promise<Json> => {
  const r = await call(w, p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return r ? { status: r.status, ...((await r.json().catch(() => ({}))) as Json) } : { status: 0 };
};
const post = (w: Who, p: string, body: unknown) => send(w, "POST", p, body);
const healthy = (w: Who) => until(async () => (await fetch(w.base + "/api/health").catch(() => null))?.ok, 30e3);
async function signIn(w: Who, display: string) {
  const r = await fetch(w.base + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: w.username, display_name: display }) });
  w.cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return r.ok;
}
const side = async (w: Who) => (await get(w, "/api/q/side")) as Json;
const bell = async (w: Who): Promise<Json[]> => (await side(w)).data?.added || (await stateOf((p) => get(w, p))).added || [];
const contactsOf = (w: Who) => get(w, "/api/contacts");
const contactOf = async (w: Who, user: string) => ((await contactsOf(w)).contacts || []).find((c: Json) => c.user === user) || null;
// An ask waiting between w and user, either way (`yours`: w's own).
const askOf = async (w: Who, user: string) => ((await contactsOf(w)).asks || []).find((a: Json) => a.user === user) || null;
const doorOf = async (w: Who) => (await get(w, "/api/door")).door || {};
const doorDb = (w: Who) => sql(path.join(w.home, "door", "door.db"));
// The records `from`'s door sent `w`'s, as `w`'s door kept them.
const recordsCame = (w: Who, from: Who): Json[] => (doorDb(w).prepare("select body from inbox where kind = 'records' and from_acct = ?").all(from.acct) as { body: string }[]).flatMap((r) => JSON.parse(r.body).items as Json[]);

// A Claude Code session on someone's machine, its hooks as Claude Code runs them: one turn, with steps in it (a
// command it ran, a file it wrote, one in its home folder it couldn't read), in a folder on a branch. A step's
// title is cut at 70 characters, before this home folder's path ends; what it failed with says all of it.
const project = path.join(BASE, "alice-project");
fs.mkdirSync(project);
spawnSync("git", ["init", "-q", "-b", "secret-branch", project]);
const hook = (env: NodeJS.ProcessEnv, event: string, input: Json, pid: string) =>
  spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", AGENTBOOK_URL: `http://127.0.0.1:${env.AGENTBOOK_PORT}`, AGENTBOOK_PID: pid, AGENTBOOK_LABEL: "wren" }, encoding: "utf8", timeout: 30e3 });
function turn(w: Who, session: string, pid: string, prompt: string, said: string) {
  const T = path.join(BASE, `${session}.jsonl`);
  const at = new Date().toISOString();
  const notes = path.join(project, "notes.md");
  const secret = path.join(HOME_DIR, ".netrc-secret");
  fs.writeFileSync(notes, "NOTES-by-the-agent\n");
  const lines = [
    { type: "user", timestamp: at, message: { role: "user", content: prompt } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test --secret-step" } }] } },
    { type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "all passed" }] } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: notes, content: "NOTES-by-the-agent\n" } }] } },
    { type: "user", timestamp: at, toolUseResult: { type: "create", filePath: notes, content: "NOTES-by-the-agent\n", structuredPatch: [], originalFile: null }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: `File created successfully at: ${notes}` }] } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu3", name: "Bash", input: { command: `cat ${secret}` } }] } },
    { type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu3", is_error: true, content: `cat: ${secret}: No such file or directory` }] } },
    { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: said }] } },
  ];
  fs.writeFileSync(T, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  hook(w.env, "SessionStart", { session_id: session, cwd: project, source: "startup", transcript_path: T }, pid);
  hook(w.env, "UserPromptSubmit", { session_id: session, prompt, cwd: project, transcript_path: T }, pid);
  hook(w.env, "Stop", { session_id: session, cwd: project, transcript_path: T, last_assistant_message: said }, pid);
}

const alice = await person("alice", await freePort(6710, 40));
// What alice's agent's thread has been sent: its conversation on her page, which its agent reads at its next turn.
const agentGot = async (id: string): Promise<string> => JSON.stringify(await get(alice, `/api/q/thread/${encodeURIComponent(id)}?n=40`));
const bob = await person("bob", await freePort(6760, 40));
const carol = await person("carol", await freePort(6810, 40));
const bob2 = { ...(await person("bob2", await freePort(6860, 40))), username: "bob" };
for (const w of [alice, bob, carol, bob2]) {
  const r = await logIn(w);
  if (r.status !== 0) throw new Error(`agentbook login for ${w.name}: ${r.out}`);
}
run(alice);
run(bob);
run(carol);
run(bob2);
try {
  check((await healthy(alice)) && (await healthy(bob)) && (await healthy(carol)) && (await healthy(bob2)), "alice's, bob's, carol's and another bob's pages run, each on their own account");
  check((await signIn(alice, "Alice Liddell")) && (await signIn(bob, "Bob Builder")) && (await signIn(carol, "Carol Cook")) && (await signIn(bob2, "Bob Other")), "each signs in to their own page");

  // ---------- each one's door ----------
  const aDoor = await until(async () => ((await doorOf(alice)).state === "up" ? doorOf(alice) : null), 30e3);
  const bDoor = await until(async () => ((await doorOf(bob)).state === "up" ? doorOf(bob) : null), 30e3);
  check(aDoor?.handle === "alice" && bDoor?.handle === "bob", `each page's door is up; each goes by their username (${JSON.stringify(aDoor)})`);
  check(relay.doorOf(alice.acct)?.key === aDoor?.key, "the relay has alice's door's key, for her account, and no handle");
  const inviteOf = (link: string) => JSON.parse(Buffer.from(link.slice(link.indexOf("#v1.") + 4), "base64url").toString("utf8"));
  check(aDoor?.invite?.startsWith(`${relay.url}/invite#v1.`) && JSON.stringify(inviteOf(aDoor.invite)) === JSON.stringify({ a: alice.acct, k: aDoor.key, h: "alice" }), `her invite link: the relay's /invite, and after its # (which a browser never sends) her account, her door's key and her handle (${aDoor?.invite})`);
  check(aDoor?.machine === "alice-mbp" && relay.doorOf(alice.acct)?.machine === JSON.parse(fs.readFileSync(path.join(alice.home, "machine.json"), "utf8")).machine, "and which machine runs it: hers, the home");
  const loginA = JSON.parse(fs.readFileSync(path.join(alice.home, "machine.json"), "utf8"));
  check(aDoor?.key !== loginA.key.x, "the door's key is its own, never the machine's");
  check(fs.existsSync(path.join(alice.home, "door", "key.json")) && fs.statSync(path.join(alice.home, "door", "key.json")).mode % 0o1000 === 0o600, "kept in the door's own folder, only alice may read it");
  const bobsCard = JSON.parse(String(doorDb(bob).prepare("select v from config where k = 'card'").get()?.v || "{}"));
  check(bobsCard.handle === "bob" && bobsCard.name === "Bob Builder" && Object.keys(bobsCard).sort().join() === "handle,name", `what bob's door answers a hello with: his card, nothing else (${JSON.stringify(bobsCard)})`);

  // ---------- finding someone: by their invite link ----------
  const nobody = await post(alice, "/api/people/find", { handle: "bob" });
  check(nobody.status === 404 && /invite link/.test(nobody.error || ""), `a handle finds only someone her page knows: nobody can be looked up (${nobody.status} ${nobody.error})`);
  check(!relay.seen.some((x) => /\/(people|handle)\b/.test(x)), "and the relay is never asked");
  const otherRelay = await post(alice, "/api/people/find", { link: bDoor.invite.replace(relay.url, "https://elsewhere.example") });
  check(otherRelay.status === 400 && /another relay/.test(otherRelay.error || ""), `a link for another relay's agentbook: no (${otherRelay.error})`);
  const broken = await post(alice, "/api/people/find", { link: `${relay.url}/invite#v1.${Buffer.from('{"a":"x"}').toString("base64url")}xxxxxxxxxxxx` });
  check(broken.status === 400, `a link that's broken: no (${broken.error})`);
  check((await post(alice, "/api/people/find", { link: aDoor.invite })).status === 400, "her own: no");
  const found = await post(alice, "/api/people/find", { link: bDoor.invite });
  check(found.status === 200 && found.user?.username === "bob" && found.remote?.handle === "bob", `alice pastes the invite link bob gave her: he's someone on her page (${found.status} ${found.error || ""})`);
  check(await until(async () => (await get(alice, "/api/people/bob")).user?.display_name === "Bob Builder"), "with his name, from his card, which his door gave hers");
  const bobOnA = await get(alice, "/api/people/bob");
  check(bobOnA.remote?.handle === "bob" && !bobOnA.agents?.length && !bobOnA.devices, "his page on hers says he's elsewhere, with nothing of his machines");
  check(doorDb(bob).prepare("select count(*) n from inbox").get().n === 0, "and bob's door keeps nothing of alice's hello");
  // Another @bob, on his own page with his own account: bob-2 on alice's, never mistaken for bob.
  const b2Door = await until(async () => ((await doorOf(bob2)).state === "up" ? doorOf(bob2) : null), 30e3);
  const found2 = await post(alice, "/api/people/find", { link: b2Door?.invite });
  check(found2.status === 200 && found2.user?.username === "bob-2" && found2.remote?.handle === "bob", `another @bob's link: he's bob-2 on alice's page, going by @bob (${found2.status} ${found2.user?.username} ${found2.error || ""})`);
  check(await until(async () => (await get(alice, "/api/people/bob-2")).user?.display_name === "Bob Other"), "with his own name, from his own door");
  check((await get(alice, "/api/people/bob")).user?.display_name === "Bob Builder", "and bob's as it was");
  const again = await post(alice, "/api/people/find", { link: bDoor.invite });
  check(again.user?.username === "bob", "bob's link again: still bob");
  await post(bob2, "/api/people/find", { link: aDoor.invite });
  await post(bob2, "/api/people/alice/contact", { act: "ask" });
  check(await until(async () => (await askOf(alice, "bob-2"))?.yours === false) && !(await askOf(alice, "bob")), "the other @bob asks to be alice's contact: it's bob-2 asking on her page, not bob");
  await post(alice, "/api/people/bob-2/contact", { act: "no" });
  await stopIt(bob2);

  // ---------- asking, and saying yes ----------
  const asked = await post(alice, "/api/people/bob/contact", { act: "ask", note: "From the meetup" });
  check(asked.status === 200 && asked.contact?.asked, `alice asks bob to be her contact (${asked.status} ${asked.error || ""})`);
  const ask = await until(() => askOf(bob, "alice"));
  check(ask?.yours === false && ask.note === "From the meetup" && ask.remote?.handle === "alice", `bob's Contacts has alice asking, as someone elsewhere, with what she said (${JSON.stringify(ask)})`);
  const rung = await until(async () => (await bell(bob)).find((x) => x.kind === "contact-ask" && x.by === "alice"));
  check(rung, "and his bell: alice asks to be his contact");
  check(await until(async () => (await get(bob, "/api/people/alice")).user?.display_name === "Alice Liddell"), "alice is someone on bob's page now, with her name from her card");
  const yes = await post(bob, "/api/people/alice/contact", { act: "yes" });
  check(yes.status === 200 && yes.contact?.contact, `bob says yes (${yes.status} ${yes.error || ""})`);
  const mine = await until(() => contactOf(alice, "bob"));
  check(mine?.following, `bob is alice's contact now, and she follows him (${JSON.stringify(mine)})`);
  check(await until(async () => (await bell(alice)).find((x) => x.kind === "contact" && x.by === "bob")), "and her bell says bob said yes");
  const relOf = (w: Who, acct: string) => String(doorDb(w).prepare("select rel from people where acct = ?").get(acct)?.rel || "");
  check(await until(() => relOf(bob, alice.acct) === "contact" && relOf(alice, bob.acct) === "contact"), "each door knows they're contacts");

  // ---------- following is each one's own ----------
  check((await post(alice, "/api/people/bob/follow", { follow: false })).contact?.following === false, "alice stops following bob, on her page alone");
  await sleep(500);
  check((await contactOf(bob, "alice"))?.following && relOf(bob, alice.acct) === "contact", "bob's is as it was: they're contacts, and he follows her");
  await post(alice, "/api/people/bob/follow", { follow: true });

  // ---------- removing, no, taking back ----------
  await post(alice, "/api/people/bob/contact", { act: "remove" });
  check(await until(async () => !(await contactOf(bob, "alice"))), "alice removes bob: she's gone from his contacts too");
  check(await until(() => relOf(bob, alice.acct) === "" && relOf(alice, bob.acct) === ""), "and from how each door has them");
  await post(alice, "/api/people/bob/contact", { act: "ask" });
  check(await until(() => askOf(bob, "alice")), "alice asks again");
  await post(bob, "/api/people/alice/contact", { act: "no" });
  check(await until(async () => !(await askOf(alice, "bob"))), "bob says no: alice's ask is gone from her page");
  await post(alice, "/api/people/bob/contact", { act: "ask" });
  await until(() => askOf(bob, "alice"));
  await post(alice, "/api/people/bob/contact", { act: "take_back" });
  check(await until(async () => !(await askOf(bob, "alice"))), "alice takes an ask back: it's gone from bob's");

  // ---------- the other way ----------
  const back = await post(bob, "/api/people/find", { handle: "alice" });
  check(back.status === 200 && back.user?.username === "alice", "bob finds alice by her username: she's on his page already");
  await post(bob, "/api/people/alice/contact", { act: "ask" });
  check(await until(async () => (await askOf(alice, "bob"))?.yours === false), "bob asks alice");
  const op = await post(alice, "/api/people/bob/contact", { act: "yes" });
  check(op.status === 200 && (await until(() => contactOf(bob, "alice"))), "she says yes: contacts, on his page too");
  await post(bob, "/api/people/alice/contact", { act: "remove" });
  check(await until(async () => !(await contactOf(alice, "bob"))), "bob removes her: on her page too");

  // ---------- while one's off ----------
  await stopIt(bob);
  check(!(await fetch(bob.base + "/api/health").catch(() => null)), "bob's page is off, and his door with it");
  const while_ = await post(alice, "/api/people/bob/contact", { act: "ask" });
  check(while_.status === 200, "alice asks bob meanwhile");
  check(await until(async () => (await askOf(alice, "bob"))?.remote?.waiting > 0, 10e3), "her page says it waits for his door");
  run(bob);
  check(await healthy(bob), "bob's page is back");
  check(await until(async () => (await askOf(bob, "alice"))?.yours === false, 45e3), "and alice's ask arrives once his door is up");
  check((await until(async () => (await askOf(alice, "bob"))?.remote?.waiting === 0)) !== false, "nothing waits on alice's side then");

  // ---------- a door is no way into a machine ----------
  // bob's door's key, dialing alice's machine (its key, as the relay lists it to her own machines only): refused
  // before a byte reaches her page, as any key not on her account is.
  const bobsDoorKey = JSON.parse(fs.readFileSync(path.join(bob.home, "door", "key.json"), "utf8"));
  // Its own folder of addresses, so its address doesn't replace the door's.
  fs.mkdirSync(path.join(BASE, "iroh-probe"), { recursive: true });
  const node = await makeIroh({ key: bobsDoorKey, admit: async () => true, log: () => {}, how: { mode: "local", dir: path.join(BASE, "iroh-probe") }, serve: (s) => s.destroy() });
  fs.copyFileSync(path.join(IROH_DIR, `${loginA.key.x}.json`), path.join(BASE, "iroh-probe", `${loginA.key.x}.json`));
  const into = await node
    .fetch(loginA.key.x, "/api/cli/mesh/site", { method: "GET" })
    .then((r) => r.status)
    .catch((e) => `refused (${e.cause?.code || e.message})`);
  await node.close();
  check(typeof into === "string" && /refused/.test(into), `bob's door, dialing alice's machine, is refused (${into})`);
  check(await until(async () => (await get(alice, "/api/q/side")).status === 200), "and her page goes on as before");

  // ---------- what alice publishes ----------
  // Her own threads, pages and tasks, public and private; a page with an html widget; her agent's thread, in a folder
  // on a branch, with a step, its agent public.
  const T: Record<string, string> = {};
  const P: Record<string, string> = {};
  const K: Record<string, string> = {};
  for (const level of ["public", "private"]) {
    T[level] = (await post(alice, "/api/talks", { text: `TALK-${level} what alice asks`, visibility: level })).id;
    P[level] = (await post(alice, "/api/pages", { title: `PAGE-${level}` })).id;
    await post(alice, `/api/pages/${P[level]}/visibility`, { visibility: level });
    K[level] = (await post(alice, "/api/tasks", { text: `TASK-${level}` })).id;
    await post(alice, `/api/tasks/${K[level]}/visibility`, { visibility: level });
  }
  const wrote = await post(alice, `/api/pages/${P.public}/write`, { widgets: [{ id: "w_note", type: "note", title: "NOTE-widget", data: { text: "What the page says ![a picture](https://example.com/x.png)" } }, { id: "w_html", type: "html", title: "HTML-widget", data: { html: "<b>SECRET-HTML</b>" } }] });
  check(!!T.private && !!P.private && !!K.private && wrote.status === 200, `alice has a thread of her own, a page and a task, public and private (${wrote.status} ${wrote.error || ""})`);
  turn(alice, "alice-1", "970001", "run the tests on alice", "AGENT-SAID the tests pass.");
  const thread = await until(async () => ((await stateOf((p) => get(alice, p))).sessions || []).find((s: Json) => s.id === "alice-1" || s.session_id === "alice-1"));
  check(thread?.agent, `and a thread of her agent's, on her machine (${JSON.stringify(thread && { id: thread.id, agent: thread.agent })})`);
  const madePublic = await post(alice, `/api/agents/${encodeURIComponent(thread?.agent)}/visibility`, { visibility: "public" });
  check(madePublic.status === 200, `her agent is public (${madePublic.status} ${madePublic.error || ""})`);

  // bob says yes to alice's ask, which waited for his door.
  await post(bob, "/api/people/alice/contact", { act: "yes" });
  await until(() => contactOf(alice, "bob"));
  const things = () => get(bob, "/api/people/alice/things");
  const ids = async () => {
    const t = await things();
    return new Set([...(t.threads || []), ...(t.pages || []), ...(t.tasks || []), ...(t.agents || [])].map((x: Json) => x.id));
  };
  const has = (want: string[], not: string[] = []) => until(async () => {
    const got = await ids();
    return want.every((x) => got.has(x)) && not.every((x) => !got.has(x));
  }, 30e3);
  check(await has([T.public, P.public, K.public, thread?.id, thread?.agent], [T.private, P.private, K.private]), "bob, her contact: alice's public threads, pages and tasks, her public agent and its thread, never her private ones");
  const hers = await things();
  check(hers.person?.body?.name === "Alice Liddell" && hers.person?.body?.handle === "alice", "and her card");

  // Exactly the lists' fields, as alice's door sent them (bob's door keeps what came).
  const FIELDS: Record<string, string> = {
    person: "bio,handle,name",
    agent: "bio,emoji,glyph,kind,machine,name,working",
    thread: "agent,busy,earlier,headline,messages,plan,prs,started,state,talk,title,updated,updates",
    work: "commits,cut,files,steps,thread,totals,turn,updated",
    page: "about,emoji,title,updated,version,widgets",
    task: "done,done_at,threads,title,updated",
  };
  // Her agent's thread's work comes as the machine sends it to her page: a record of its own for its turn.
  const workOf = () => recordsCame(bob, alice).filter((r) => r.type === "work" && r.body?.thread === thread?.id);
  await until(() => workOf().some((r) => (r.body.files || []).some((f: Json) => f.path === "notes.md")), 30e3);
  const sent = recordsCame(bob, alice);
  const extra = sent.filter((r) => Object.keys(r.body).some((k) => !FIELDS[r.type]?.split(",").includes(k)) || Object.keys(r).some((k) => !["type", "id", "v", "body", "space", "mentions", "author"].includes(k)));
  check(sent.length > 0 && !extra.length, `every record alice's door sent has only its list's fields (${sent.length} sent; ${JSON.stringify(extra.map((r) => [r.type, Object.keys(r.body)]))})`);
  const agentThread = sent.filter((r) => r.id === thread?.id).at(-1);
  const all = JSON.stringify(sent);
  check(agentThread?.body?.messages?.some((m: Json) => m.text === "AGENT-SAID the tests pass.") && agentThread.body.messages.some((m: Json) => m.text === "run the tests on alice"), "her agent's thread came with its conversation");
  // Whoever sees a thread sees its work.
  const herWork = JSON.stringify(workOf());
  const herFile = workOf().flatMap((r) => r.body.files || []).find((f: Json) => f.path === "notes.md");
  check(/npm test --secret-step/.test(herWork) && JSON.stringify(herFile?.hunks || []).includes("+NOTES-by-the-agent"), `its work came too, a record for its turn: the command it ran, and the file it wrote, with its diff (${herWork.slice(0, 300)})`);
  check(herWork.includes("cat: ~/.netrc-secret: No such file") && herWork.includes('"Run cat ~…"'), `with ~ for the machine's home folder, in a title cut short partway through it too (${herWork.match(/"title":"Run cat[^"]*"/)?.[0]} ${herWork.match(/"error":"[^"]*"/)?.[0]})`);
  check(!all.includes(BASE) && !all.includes("secret-branch") && !all.includes("SECRET-HTML"), "and nothing of its folder, the machine's folders or its branch, nor the page's html widget");
  const agentRec = sent.filter((r) => r.type === "agent").at(-1);
  check(agentRec?.body?.machine === "alice-mbp" && agentRec.author?.sig, "her agent, with its machine's name and nothing else of it, signed by her door");
  const opened = await get(bob, `/api/people/alice/things/${encodeURIComponent(T.public)}`);
  check(/TALK-public/.test(`${opened.thing?.body?.title} ${opened.thing?.body?.headline}`), `bob opens her public thread, from his own page (${JSON.stringify(opened.thing?.body)?.slice(0, 200)})`);
  const agentOpened = await get(bob, `/api/people/alice/things/${encodeURIComponent(thread?.id)}`);
  check((agentOpened.work || []).some((w: Json) => w.body.turn >= 1 && (w.body.files || []).some((f: Json) => f.path === "notes.md")), `bob opens her agent's thread with its work, turn by turn (${JSON.stringify(agentOpened.work)?.slice(0, 200)})`);
  const pageRec = await get(bob, `/api/people/alice/things/${encodeURIComponent(P.public)}`);
  check(pageRec.thing?.body?.widgets?.length === 1 && pageRec.thing.body.widgets[0].title === "NOTE-widget", "her public page, without its html widget");

  // Kept from bob's agents: theirs is on his page only where he reads it, signed in.
  const unsigned = await fetch(bob.base + "/api/people/alice/things").then((r) => r.status);
  check(unsigned === 401 || unsigned === 403, `not without bob's sign-in (${unsigned})`);
  const bobsView = JSON.stringify(await stateOf((p) => get(bob, p)));
  check(!bobsView.includes("TALK-public") && !bobsView.includes("AGENT-SAID"), "nor in bob's page's own view, which his agents' ab_search and ab_thread_read draw from");
  check((await get(bob, `/api/q/thread/${encodeURIComponent(T.public)}?n=5`)).status === 404, "nor as a thread of his page's");

  // A private one she puts him on comes; taken off it, it goes.
  check((await post(alice, `/api/threads/${T.private}/people`, { user: "bob" })).status === 200 && (await has([T.private], [P.private, K.private])), "alice puts bob on her private thread: it comes to his page, nothing else private does");
  await post(alice, `/api/threads/${T.private}/people`, { user: "bob", remove: true });
  check(await has([T.public], [T.private]), "she takes him off it: it's taken back from his page");
  await post(alice, `/api/agents/${encodeURIComponent(thread?.agent)}/visibility`, { visibility: "private" });
  check(await has([T.public], [thread?.id, thread?.agent]), "her agent private: it and its thread go from bob's page");

  // Following her agent is bob's page's alone: in his feed or not, nothing asked of anyone.
  await post(alice, `/api/agents/${encodeURIComponent(thread?.agent)}/visibility`, { visibility: "public" });
  const agentThere = await until(async () => (await things()).agents?.find((a: Json) => a.id === thread?.agent));
  check(agentThere?.follow?.on === true && agentThere.follow.contact, `her agent public again: on his page, in his feed as he follows her (${JSON.stringify(agentThere?.follow)})`);
  // What reaches bob's feed of hers: cards of their own (their:), read only, from what her door sent.
  const feedKeys = async (q = ""): Promise<{ keys: string[]; f: Json }> => {
    const f = await get(bob, `/api/q/feed?feed=1&n=100${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    return { keys: f.list || [], f };
  };
  const theirKey = (keys: string[], id: string) => keys.find((k) => k.startsWith("their:") && k.endsWith(`:${id}`));
  const onFeed = await until(async () => {
    const { keys, f } = await feedKeys();
    const k = theirKey(keys, thread?.id);
    return k && theirKey(keys, T.public) ? { k, rec: f.records[k], keys } : null;
  }, 30e3);
  check(onFeed?.rec?.username === "alice" && onFeed.rec.agent?.name && onFeed.rec.last?.text === "AGENT-SAID the tests pass.", `her agent's thread is in bob's feed, read only, as her door sent it (${JSON.stringify(onFeed?.rec)?.slice(0, 300)})`);
  check(!!theirKey(onFeed?.keys || [], T.public) && !!theirKey(onFeed?.keys || [], P.public) && !theirKey(onFeed?.keys || [], T.private) && !theirKey(onFeed?.keys || [], P.private), "and her public thread and page, never her private ones");
  check(!!theirKey((await feedKeys("TALK-public")).keys, T.public) && !theirKey((await feedKeys("TALK-public")).keys, thread?.id), "searching his feed finds hers too");
  const offFeed = await post(bob, `/api/agents/${encodeURIComponent(agentThere?.ref)}/follow`, { follow: false });
  check(offFeed.status === 200 && offFeed.follow?.on === false, `bob takes it out of his feed (${offFeed.status} ${offFeed.error || ""})`);
  check((await has([thread?.id, thread?.agent])) && (await things()).agents?.find((a: Json) => a.id === thread?.agent)?.follow?.on === false, "it and its thread stay on his page, out of his feed");
  const keysOff = (await feedKeys()).keys;
  check(!theirKey(keysOff, thread?.id) && !!theirKey(keysOff, T.public), "its thread leaves his feed; hers of her own stay");
  await post(bob, `/api/agents/${encodeURIComponent(agentThere?.ref)}/follow`, { follow: null });
  const unfollowed = await post(bob, "/api/people/alice/follow", { follow: false });
  const keysUnfollowed = (await feedKeys()).keys;
  check(unfollowed.status === 200 && !keysUnfollowed.some((k) => k.startsWith("their:")) && (await has([T.public, thread?.id])), `bob unfollows alice: nothing of hers in his feed, all of it on her profile still (${unfollowed.status} ${unfollowed.error || ""})`);
  await post(bob, "/api/people/alice/follow", { follow: true });
  const keysBack = (await feedKeys()).keys;
  check(!!theirKey(keysBack, T.public) && !!theirKey(keysBack, thread?.id), "follows her again: it's all back");

  // ---------- someone alice names ----------
  // carol, whose link alice has: alice names her in a public thread; bob, alice's contact, doesn't know carol.
  const cDoor = await until(async () => ((await doorOf(carol)).state === "up" ? doorOf(carol) : null), 30e3);
  await post(alice, "/api/people/find", { link: cDoor?.invite });
  const named = (await post(alice, "/api/talks", { text: "MENTION @carol and @zed, can you look at this?", visibility: "public" })).id;
  const mention = await until(() => {
    const r = recordsCame(bob, alice).filter((x) => x.id === named).at(-1);
    return r?.mentions?.length ? r : null;
  }, 30e3);
  check(mention && JSON.stringify(mention.mentions) === JSON.stringify([carol.acct]), `alice's thread reaches bob naming carol by her account, and not @zed, whom alice's page doesn't know (${JSON.stringify(mention?.mentions)})`);
  const onBob = await until(async () => (await get(bob, `/api/people/alice/things/${encodeURIComponent(named)}`)).thing);
  check(onBob && JSON.stringify(onBob.mentions) === "[]", `bob's page names nobody: he doesn't know carol (${JSON.stringify(onBob?.mentions)})`);
  check((await get(bob, "/api/people/carol")).status === 404, "and nothing of carol's: she's nobody on bob's page");
  check(!(await bell(carol)).some((x) => x.kind === "mention"), "carol's bell doesn't ring: she doesn't see alice's thread");
  await post(carol, "/api/people/find", { link: aDoor.invite });
  await post(carol, "/api/people/alice/contact", { act: "ask" });
  await until(() => askOf(alice, "carol"));
  await post(alice, "/api/people/carol/contact", { act: "yes" });
  check(await until(async () => (await bell(carol)).find((x) => x.kind === "mention" && x.by === "alice"), 30e3), "once she's alice's contact and sees it, her bell says alice named her");

  // ---------- comments ----------
  await post(alice, `/api/agents/${encodeURIComponent(thread?.agent)}/visibility`, { visibility: "public" });
  check(await has([thread?.id]), "alice's agent public again: bob sees its thread");
  const commented = await post(bob, `/api/people/alice/things/${encodeURIComponent(thread?.id)}/comments`, { text: "COMMENT-bob did you try the other branch?" });
  check(commented.status === 200, `bob comments on her agent's thread, from his own page (${commented.status} ${commented.error || ""})`);
  const lane = await until(async () => (await get(alice, `/api/threads/${encodeURIComponent(thread?.id)}/people`)).comments?.find((c: Json) => c.handle === "bob" && /COMMENT-bob/.test(c.text)));
  check(lane, "it's in the thread's People lane on alice's page, as bob's");
  check(await until(async () => (await bell(alice)).find((x) => x.kind === "comment" && x.by === "bob")), "and on her bell");
  check(!(await agentGot(thread?.id)).includes("COMMENT-bob"), "her agent doesn't get it");
  const passed = await post(alice, `/api/threads/${encodeURIComponent(thread?.id)}/people/${lane?.id}/pass`, {});
  const gotIt = await until(async () => ((await agentGot(thread?.id)).includes("COMMENT-bob") ? agentGot(thread?.id) : null));
  check(passed.status === 200 && /@bob commented on this thread/.test(gotIt || "") && /Passed on by Alice/.test(gotIt || ""), `alice passes it on: her agent gets it as her message, wrapped as bob's (${passed.status} ${passed.error || ""})`);
  check(await until(async () => (await get(alice, `/api/threads/${encodeURIComponent(thread?.id)}/people`)).comments?.find((c: Json) => c.id === lane?.id)?.passed), "and its lane says she did");
  await post(alice, `/api/threads/${encodeURIComponent(thread?.id)}/people/${lane?.id}/answer`, { text: "ANSWER-alice not yet" });
  const onCarol = await until(async () => {
    const t = await get(carol, `/api/people/alice/things/${encodeURIComponent(lane?.id)}`);
    const a = await get(carol, `/api/people/alice/things/${encodeURIComponent(`${lane?.id}.a`)}`);
    return t.thing && a.thing ? { t: t.thing, a: a.thing } : null;
  }, 30e3);
  check(onCarol?.t.author === "bob" && /COMMENT-bob/.test(onCarol.t.body.text) && onCarol.a.author === "alice" && onCarol.a.body.to === lane?.id, `carol, who sees the thread, gets bob's comment signed by bob, and alice's answer (${JSON.stringify(onCarol)?.slice(0, 300)})`);

  // ---------- a group with people elsewhere in it ----------
  const gid = (await post(alice, "/api/groups", { name: "Ledger import" })).id;
  const otherGid = (await post(alice, "/api/groups", { name: "Other group" })).id;
  await post(alice, `/api/groups/${gid}/threads`, { post: thread?.id });
  const askB = await post(alice, `/api/groups/${gid}/members`, { user: "bob" });
  const askC = await post(alice, `/api/groups/${gid}/members`, { user: "carol" });
  check(!!gid && askB.asked === true && askC.asked === true, `alice puts bob and carol in her group: each is asked (${JSON.stringify([askB, askC])})`);
  const members = async () => ((await get(alice, `/api/groups/${gid}`)).members || []).map((m: Json) => m.user).filter(Boolean);
  check(!(await members()).length, "neither is in it before they say yes");
  const bobAsk = await until(async () => (await get(bob, "/api/people/alice/spaces")).spaces?.find((x: Json) => x.space === `group:${gid}` && x.state === "asked"));
  check(bobAsk?.name === "Ledger import" && (await until(async () => (await bell(bob)).find((x) => x.kind === "space" && x.by === "alice"))), "bob's page has her ask, by the group's name, on his bell");
  await until(async () => (await get(carol, "/api/people/alice/spaces")).spaces?.find((x: Json) => x.space === `group:${gid}`));
  await post(bob, `/api/people/alice/spaces/group/${gid}`, { yes: true });
  await post(carol, `/api/people/alice/spaces/group/${gid}`, { yes: true });
  check(await until(async () => ["bob", "carol"].every((u) => members().then((m) => m.includes(u)))), "each says yes: both are in it on alice's page");
  const theirGroup = (w: Who) => until(async () => (await get(w, "/api/people/alice/things")).groups?.find((g: Json) => g.id === gid));
  const bg = await theirGroup(bob);
  check(bg?.body?.name === "Ledger import" && bg.body.members.some((m: Json) => m.handle === "carol" && !m.username) && bg.body.members.some((m: Json) => m.you) && bg.body.threads.some((t: Json) => t.id === thread?.id && t.by === "alice" && t.username === "alice"), `bob's page has the group, who's in it (carol by her handle: he doesn't know her; and him) and alice's thread in it (${JSON.stringify(bg?.body)?.slice(0, 400)})`);
  const fullRefused = await post(alice, `/api/sessions/${encodeURIComponent(thread?.id)}/mode`, { mode: "full" });
  check(fullRefused.status === 403 && /another agentbook/.test(fullRefused.error || ""), `alice's thread in it can't go to Full access while they're in it (${fullRefused.status} ${fullRefused.error || ""})`);

  // bob's thread, put in it: to carol through alice's door, signed by bob.
  turn(bob, "bob-1", "970101", "check the ledger totals", "BOB-SAID the totals match.");
  const bobThread = await until(async () => ((await stateOf((p) => get(bob, p))).sessions || []).find((s: Json) => s.id === "bob-1" || s.session_id === "bob-1"));
  const putIn = await post(bob, `/api/people/alice/spaces/group/${gid}/threads`, { post: bobThread?.id });
  check(putIn.status === 200, `bob puts a thread of his in it (${putIn.status} ${putIn.error || ""})`);
  const key = encodeURIComponent(`group:${gid}/${bobThread?.id}`);
  const relayed = await until(async () => (await get(carol, `/api/people/alice/things/${key}`)).thing, 30e3);
  check(relayed?.author === "bob" && relayed.body.messages?.some((m: Json) => /BOB-SAID/.test(m.text)) && !JSON.stringify(relayed).includes("secret-step"), `it reaches carol through alice's door, signed by bob, with its conversation and not its steps (${JSON.stringify(relayed)?.slice(0, 200)})`);
  check(await until(async () => (await theirGroup(carol))?.body?.threads?.some((t: Json) => t.id === bobThread?.id && t.by === "bob" && t.title === "check the ledger totals")), "carol's copy of the group lists it, as bob's, by its title");
  const homeSees = (await get(alice, `/api/spaces/group/${gid}/elsewhere`)).threads || [];
  check(homeSees.some((t: Json) => t.id === bobThread?.id && t.handle === "bob" && t.username === "bob") && (await get(alice, `/api/people/bob/things/${key}`)).thing?.author === "bob", `alice, its home, sees it in her group too, as bob's copy (${JSON.stringify(homeSees)})`);
  // A copy alice's door changed: carol's page refuses it.
  const item = recordsCame(carol, alice).filter((r) => r.id === bobThread?.id && r.space === `group:${gid}`).at(-1);
  doorDb(alice).prepare("insert into outbox (at, to_acct, kind, body, dedupe) values (?, ?, ?, ?, ?)").run(Date.now(), carol.acct, "records", JSON.stringify({ items: [{ ...item, body: { ...item.body, title: "FORGED by alice's door" } }] }), null);
  check(await until(() => recordsCame(carol, alice).some((r) => r.body?.title === "FORGED by alice's door")), "a copy alice's door changed reaches carol's door");
  await sleep(1000);
  check((await get(carol, `/api/people/alice/things/${key}`)).thing?.body?.title !== "FORGED by alice's door", "and her page refuses it: bob's signature doesn't hold over it");

  // bob's note: in alice's group as his, told to her thread in it as information.
  await post(bob, `/api/people/alice/spaces/group/${gid}/propose`, { what: "note", body: { text: "NOTE-bob the March totals are off by 3" } });
  const noted = await until(async () => (await get(alice, `/api/groups/${gid}`)).notes?.find((n: Json) => /NOTE-bob/.test(n.text)));
  check(noted?.by?.user === "bob", `bob's note is in alice's group, by him (${JSON.stringify(noted?.by)})`);
  const told = await get(alice, `/api/groups/${gid}`);
  check(told.events?.some((e: Json) => /^bob left a note: NOTE-bob/.test(e.text)) && /what the people in it write/.test(told.told?.start || ""), `her thread in it hears it as bob's, information and not her instructions (${String(told.told?.start).slice(-200)})`);
  check(await until(async () => (await theirGroup(carol))?.body?.notes?.some((n: Json) => n.by === "@bob" && /NOTE-bob/.test(n.text))), "carol's copy has it, as @bob's");
  // A proposal for a group carol isn't in, sent by her door, and a file named ../x from bob: refused.
  doorDb(carol).prepare("insert into outbox (at, to_acct, kind, body, dedupe) values (?, ?, ?, ?, ?)").run(Date.now(), alice.acct, "propose", JSON.stringify({ space: `group:${otherGid}`, id: "proposal-from-outside", what: "note", body: { text: "NOTE-carol-outside" } }), null);
  await post(bob, `/api/people/alice/spaces/group/${gid}/propose`, { what: "file", body: { path: "../x", data: Buffer.from("escape").toString("base64") } });
  await post(bob, `/api/people/alice/spaces/group/${gid}/propose`, { what: "file", body: { path: "data/ok.csv", data: Buffer.from("a,b\n1,2\n").toString("base64") } });
  const files = await until(async () => {
    const g = await get(alice, `/api/groups/${gid}`);
    return g.file_list?.some((f: Json) => f.path === "data/ok.csv") ? g.file_list : null;
  });
  check(files && !files.some((f: Json) => /(^|\/)x$/.test(f.path)), `bob's file lands in the group's folder; one named ../x doesn't (${JSON.stringify(files?.map((f: Json) => f.path))})`);
  check((await until(() => fs.readFileSync(logFile(alice), "utf8").includes(`for group:${otherGid}, which they aren't in: refused`))) && !(await get(alice, `/api/groups/${otherGid}`)).notes?.some((n: Json) => /NOTE-carol-outside/.test(n.text)), "carol's proposal for a group she isn't in is refused");
  // bob leaves: his thread goes from carol's page.
  await post(bob, `/api/people/alice/spaces/group/${gid}/leave`, {});
  check(await until(async () => !(await members()).includes("bob")), "bob leaves: he's out of alice's group");
  check(await until(async () => (await get(carol, `/api/people/alice/things/${key}`)).status === 404, 30e3), "and his thread goes from carol's page");

  // ---------- a page bob's agent writes ----------
  const pid = (await post(alice, "/api/pages", { title: "PAGE-shared" })).id;
  await post(alice, `/api/pages/${pid}/write`, { widgets: [{ id: "w1", type: "note", title: "Plan", data: { text: "v1 by alice" } }, { id: "wh", type: "html", title: "HTML", data: { html: "<b>hers</b>" } }] });
  const v1 = (await get(alice, `/api/pages/${pid}`)).version;
  const askP = await post(alice, `/api/pages/${pid}/contributors`, { user: "bob" });
  await until(async () => (await get(bob, "/api/people/alice/spaces")).spaces?.find((x: Json) => x.space === `page:${pid}`));
  await post(bob, `/api/people/alice/spaces/page/${pid}`, { yes: true });
  check(askP.asked === true && (await until(async () => (await get(alice, `/api/pages/${pid}`)).contributors?.some((c: Json) => c.user === "bob"))), "alice adds bob to her page: he says yes, and contributes");
  await until(async () => (await get(bob, `/api/people/alice/things/${pid}`)).thing);
  check((await post(bob, "/api/hello", { proc: "bob-box", agent: "Claude", session_id: "bob-2", cwd: project })).status === 200, "a Claude Code session of bob's, on his machine");
  const tool = async (name: string, args: Json) => (await post(bob, `/api/mcp?proc=bob-box&cwd=${encodeURIComponent(project)}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;
  const listed = await tool("ab_page_list", {});
  check(JSON.stringify(listed).includes(`@alice/${pid}`), `bob's agent finds alice's page among its pages (${JSON.stringify(listed)?.slice(0, 300)})`);
  const read = await tool("ab_page_read", { page: `@alice/${pid}` });
  check(/v1 by alice/.test(JSON.stringify(read)) && !/hers/.test(JSON.stringify(read)) && /alice's page/.test(JSON.stringify(read)), "and reads its copy, labeled as hers, without her html widget");
  const html = await tool("ab_page_write", { page: `@alice/${pid}`, widgets: [{ id: "w9", type: "html", title: "Mine", data: { html: "<script>1</script>" } }] });
  check(html?.isError && /Nothing was sent/.test(JSON.stringify(html)), `an html widget from it is refused (${JSON.stringify(html)?.slice(0, 200)})`);
  const wrote2 = await tool("ab_page_write", { page: `@alice/${pid}`, widgets: [{ id: "w1", type: "note", title: "Plan", data: { text: "v2 by bob's agent" } }] });
  check(!wrote2?.isError, `it writes the page (${JSON.stringify(wrote2)?.slice(0, 200)})`);
  const v2 = await until(async () => {
    const pg = await get(alice, `/api/pages/${pid}`);
    return pg.widgets?.find((w: Json) => w.id === "w1")?.data?.text === "v2 by bob's agent" ? pg : null;
  });
  const last = (v2?.history || v2?.versions || []).find((v: Json) => v.v === v2?.version) || (v2?.history || v2?.versions || [])[0];
  check(v2 && last?.by?.user === "bob" && last.by.as === "Claude", `a new version on alice's page, by "@bob's Claude" (${JSON.stringify(last?.by)})`);
  check(v2?.widgets?.find((w: Json) => w.id === "wh")?.type === "html", "her html widget as it was");
  doorDb(bob).prepare("insert into outbox (at, to_acct, kind, body, dedupe) values (?, ?, ?, ?, ?)").run(Date.now(), alice.acct, "propose", JSON.stringify({ space: `page:${pid}`, id: "proposal-html", what: "page", body: { widgets: [{ id: "wh", type: "note", data: { text: "over her html" } }], agent: "Claude" } }), null);
  check(await until(() => fs.readFileSync(logFile(alice), "utf8").includes("only the page's owner changes")) && (await get(alice, `/api/pages/${pid}`)).widgets?.find((w: Json) => w.id === "wh")?.type === "html", "one sent past bob's page, over her html widget, is refused by hers");
  const restored = await post(alice, `/api/pages/${pid}/restore`, { v: v1 });
  check(restored.status === 200 && (await get(alice, `/api/pages/${pid}`)).widgets?.find((w: Json) => w.id === "w1")?.data?.text === "v1 by alice", "alice restores the one before");
  await post(alice, `/api/pages/${pid}/contributors`, { user: "bob", remove: true });
  check(await until(async () => !(await get(bob, "/api/people/alice/spaces")).spaces?.some((x: Json) => x.space === `page:${pid}`)), "alice takes bob off it: his page hears so");
  check(!JSON.stringify(await tool("ab_page_list", {})).includes(`@alice/${pid}`), "and his agent doesn't find it any more");

  // ---------- a task and a note carol is on ----------
  const tid = (await post(alice, "/api/tasks", { text: "TASK-shared ship the importer" })).id;
  const askT = await post(alice, `/api/tasks/${tid}/people`, { user: "carol" });
  const nid = (await post(alice, "/api/notes", { title: "NOTE-shared", text: "The importer reads CSV." })).id;
  const askN = await post(alice, `/api/notes/${nid}/people`, { user: "carol" });
  check(askT.asked === true && askN.asked === true, "alice puts carol on a task and a note: she's asked");
  await until(async () => ((await get(carol, "/api/people/alice/spaces")).spaces || []).filter((x: Json) => x.state === "asked").length >= 2);
  await post(carol, `/api/people/alice/spaces/task/${tid}`, { yes: true });
  await post(carol, `/api/people/alice/spaces/note/${nid}`, { yes: true });
  // A thread of alice's agent's that comments in the note reads what carol writes there: no Full access for it.
  turn(alice, "alice-2", "970002", "write up the importer", "AGENT-SAID wrote it up.");
  const alice2 = await until(async () => ((await stateOf((p) => get(alice, p))).sessions || []).find((s: Json) => s.id === "alice-2" || s.session_id === "alice-2"));
  await post(alice, "/api/hello", { proc: "alice-box", agent: "Claude", session_id: "alice-2", cwd: project });
  const tied = (await post(alice, `/api/mcp?proc=alice-box&cwd=${encodeURIComponent(project)}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ab_note_comment", arguments: { note: nid, text: "AGENT-alice it reads CSV only" } } })).result;
  const noteFull = await post(alice, `/api/sessions/${encodeURIComponent(alice2?.id)}/mode`, { mode: "full" });
  check(!tied?.isError && noteFull.status === 403 && /the note "NOTE-shared"/.test(noteFull.error || ""), `a thread that comments in her note can't go to Full access while carol's on it (${noteFull.status} ${noteFull.error || ""}; ${JSON.stringify(tied)?.slice(0, 160)})`);
  const task = await until(async () => (await get(carol, "/api/people/alice/things")).tasks?.find((t: Json) => t.id === tid && t.body.people?.some((p: Json) => p.you)));
  check(task?.body?.people?.some((p: Json) => p.username === "alice"), `carol's page has the task, with who's on it, though it isn't public (${JSON.stringify(task?.body)})`);
  await post(carol, `/api/people/alice/spaces/note/${nid}/propose`, { what: "comment", body: { text: "COMMENT-carol and TSV?" } });
  await post(carol, `/api/people/alice/spaces/note/${nid}/propose`, { what: "suggestion", body: { find: "reads CSV", replace: "reads CSV and TSV", why: "both come in" } });
  const note = await until(async () => {
    const n = await get(alice, `/api/notes/${nid}`);
    const x = n.note || n;
    return x.comments?.some((c: Json) => c.by?.user === "carol") && x.suggestions?.some((g: Json) => g.by?.user === "carol") ? x : null;
  });
  check(note, "her comment and her suggestion are on alice's note, as hers");
  check(await until(async () => (await get(carol, "/api/people/alice/things")).notes?.find((n: Json) => n.id === nid && n.body.comments?.some((c: Json) => c.by === "@carol"))), "and on carol's copy of it");
  await post(alice, `/api/notes/${nid}/people`, { user: "bob" });
  check(await until(async () => (await get(alice, `/api/spaces/note/${nid}/elsewhere`)).people?.some((x: Json) => x.username === "bob" && x.state === "asked")), "alice asks bob onto the note too: her page lists the ask");
  await until(async () => (await get(bob, "/api/people/alice/spaces")).spaces?.some((x: Json) => x.space === `note:${nid}`));
  const tookBack = await post(alice, `/api/spaces/note/${nid}/elsewhere/bob/take-back`, {});
  check(tookBack.taken_back === true && (await until(async () => !(await get(bob, "/api/people/alice/spaces")).spaces?.some((x: Json) => x.space === `note:${nid}`))), "she takes it back before he says yes: his page hears so");

  // carol's own "Ledger import", with alice in it, has the id of alice's, which carol is in: alice leaving carol's
  // takes alice out of carol's and leaves carol in alice's.
  const cgid = (await post(carol, "/api/groups", { name: "Ledger import" })).id;
  const askA = await post(carol, `/api/groups/${cgid}/members`, { user: "alice" });
  await until(async () => (await get(alice, "/api/people/carol/spaces")).spaces?.some((x: Json) => x.space === `group:${cgid}`));
  await post(alice, `/api/people/carol/spaces/group/${cgid}`, { yes: true });
  const carolsHas = async () => ((await get(carol, `/api/groups/${cgid}`)).members || []).some((m: Json) => m.user === "alice");
  check(cgid === gid && askA.asked === true && (await until(carolsHas)), `carol puts alice in a group of hers with the same id as alice's (${cgid}): alice says yes, and is in it`);
  await post(alice, `/api/people/carol/spaces/group/${cgid}/leave`, {});
  check(await until(async () => !(await carolsHas())), "alice leaves carol's: she's out of it");
  await sleep(1000);
  check((await get(carol, "/api/people/alice/spaces")).spaces?.some((x: Json) => x.space === `group:${gid}` && x.state === "in") && (await members()).includes("carol"), "and carol is still in alice's");

  // PEOPLE_PAUSE=<file>: the three pages stay up as they are here, with an ask of alice's to bob waiting, for a look,
  // until that file is gone.
  if (process.env.PEOPLE_PAUSE) {
    await post(alice, `/api/notes/${nid}/people`, { user: "bob" });
    const ids = { thread: thread?.id, gid, nid, tid, pid, bobThread: bobThread?.id };
    fs.writeFileSync(process.env.PEOPLE_PAUSE, JSON.stringify({ ids, pages: Object.fromEntries([alice, bob, carol].map((w) => [w.name, { base: w.base, cookie: w.cookie }])) }));
    while (fs.existsSync(process.env.PEOPLE_PAUSE)) await sleep(500);
    await post(alice, `/api/notes/${nid}/people`, { user: "bob", remove: true });
  }

  // Removed: bob's page drops all of hers.
  await post(alice, "/api/people/bob/contact", { act: "remove" });
  check(await until(async () => (await ids()).size === 0, 30e3), "alice removes bob: her things go from his page");
} catch (e) {
  check(false, `no error: ${e.stack}`);
} finally {
  await Promise.all([stopIt(alice), stopIt(bob), stopIt(carol), stopIt(bob2)]);
  await relay.close();
  if (failures) for (const w of [alice, bob, carol, bob2]) console.log(`--- ${w.name}.log (end)\n${fs.readFileSync(logFile(w), "utf8").split("\n").slice(-60).join("\n")}`);
  if (!failures || !process.env.KEEP) fs.rmSync(BASE, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
