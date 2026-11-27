#!/usr/bin/env node
// People in a group: its owner (herval, on the hub with his machine), someone he puts
// in it (alice, with her own laptop), someone who isn't (bob) and someone signed out, against the group's routes, the
// threads in it (each person's, on their own machines), their work, steering, what a thread in it is told, its
// folder on each machine, a public group, leaving, being taken out, and an account deleted. Then a page's contributors,
// who see the threads on it as a group's people do and start their own there; and the bell's line for each of these.
// Run: node test/group-people.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-group-people-"));
const HUB_PORT = testPort(5600, 80);
const A_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const A = `http://127.0.0.1:${A_PORT}`;
const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", HERMES_HOME: path.join(BASE, "hermes"), AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(BASE, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), AGENTBOOK_GROUP_SCAN_MS: "300" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_MACHINE", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC", "CLAUDE_JOB_DIR"]) delete common[k];
fs.mkdirSync(common.FAKE_CLAUDE_DIR, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> => {
  for (let t = 0; t < ms; t += 100) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
};
async function req(base: string, method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], raw: text, ...data };
}
// Someone signed in to the hub, and what they ask it.
type Person = { cookie: string; get: (p: string) => Promise<Json>; post: (p: string, body?: unknown) => Promise<Json> };
const as = (cookie: string): Person => ({ cookie, get: (p) => req(HUB, "GET", p, { cookie }), post: (p, body) => req(HUB, "POST", p, { cookie, body: body || {} }) });
// A thread's own calls (hooks, the MCP server), to its machine.
const agent = (base: string, proc: string) => ({ get: (p: string) => req(base, "GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req(base, "POST", `/api/procs/${proc}${p}`, { body }) });
const groupIn = async (who: Person, id: string) => ((await stateOf(who.get)).groups || []).find((g) => g.id === id);
const sees = async (who: Person, id: string) => (await who.get(`/api/sessions/${encodeURIComponent(id)}`)).status === 200;
const feedHas = async (who: Person, id: string) => !!(await who.get("/api/q/feed")).list?.includes(`thread:${id}`);
// What a thread takes when a prompt starts (the hook asks with news=1), as text.
const prompted = async (a: ReturnType<typeof agent>) => ((await a.get("/events?ack=1&news=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok);

const running = [];
try {
  running.push(spawnAgentbook({ env: { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub" }, stdio: ["ignore", "ignore", "inherit"] }));
  check(!!(await healthy(HUB)), "the hub starts");
  const herval = as((await req(HUB, "POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const join = async (username: string) => as((await req(HUB, "POST", "/api/auth/test-person", { body: { username } })).cookie);
  const alice = await join("alice");
  const bob = await join("bob");
  const carol = await join("carol");
  const dave = await join("dave");
  const nobody = as(null);
  // Only a contact goes in a group, or sees a public one: alice, bob and carol are herval's;
  // dave isn't.
  for (const [who, name] of [[alice, "alice"], [bob, "bob"], [carol, "carol"]] as const) {
    await herval.post(`/api/people/${name}/contact`, { act: "ask" });
    await who.post("/api/people/herval/contact", { act: "yes" });
  }
  // Each said yes, which herval's bell says: what's new below is what's put him or them in something.
  await herval.post("/api/bell/clear");

  // alice connects her laptop.
  const asked: Json = await (await fetch(HUB + "/api/devices/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "laptop" }) })).json();
  await alice.post("/api/devices/approve", { code: asked.code });
  const got: Json = await (await fetch(`${HUB}/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).json();
  running.push(spawnAgentbook({ env: { ...common, AGENTBOOK_PORT: String(A_PORT), AGENTBOOK_HOME: path.join(BASE, "alice"), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_HUB: HUB, AGENTBOOK_HUB_TOKEN: got.token, AGENTBOOK_URL: A }, stdio: ["ignore", "ignore", "inherit"] }));
  check(!!(await healthy(A)), "alice's laptop starts, connected");

  // herval's two threads on the hub: wren (with a step) and kite.
  const hubProject = path.join(BASE, "hub", "dev", "app");
  fs.mkdirSync(hubProject, { recursive: true });
  const transcript = path.join(BASE, "hub", "t-wren.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls ~/dev/app", description: "List the app" } }] } }) + "\n");
  await req(HUB, "POST", "/api/hello", { body: { proc: "hub-box-1", label: "wren", agent: "Claude", session_id: "h1", cwd: hubProject, transcript } });
  await req(HUB, "POST", "/api/hello", { body: { proc: "hub-box-2", label: "kite", agent: "Claude", session_id: "h2", cwd: hubProject } });
  const wren = agent(HUB, "hub-box-1");
  const kite = agent(HUB, "hub-box-2");
  await wren.post("/post", { title: "Import the ledger" });
  await wren.post("/messages", { from: "agent", text: "Reading the ledger's CSV." });
  await kite.post("/post", { title: "Rotate the keys" });

  // alice's thread on her laptop: finch.
  const aliceProject = path.join(BASE, "alice", "dev", "shop");
  fs.mkdirSync(aliceProject, { recursive: true });
  await req(A, "POST", "/api/hello", { body: { proc: "alice-box-1", label: "finch", agent: "Claude", session_id: "a1", cwd: aliceProject } });
  const finch = agent(A, "alice-box-1");
  await finch.post("/post", { title: "Ledger import: the UI" });
  check(!!(await until(async () => (await stateOf(alice.get)).sessions?.some((s) => s.id === "a1" && s.mine))), "alice's thread is on the hub for her");

  const G = (await herval.post("/api/groups", { name: "Ledger import", emoji: "📒", brief: "Import Acme's ledger, end to end.", agents: ["claude"] })).id;
  await herval.post(`/api/groups/${G}/threads`, { post: "h1" });

  // ---------- before she's in it ----------
  check((await alice.get(`/api/groups/${G}`)).status === 404 && !(await groupIn(alice, G)) && !(await sees(alice, "h1")), "before she's in it, alice sees neither the group nor its thread");
  check((await alice.post(`/api/groups/${G}/notes`, { text: "hi" })).status === 404 && (await alice.post(`/api/groups/${G}/members`, { user: "alice" })).status === 404, "nor writes in it, or puts herself in");
  check((await herval.post(`/api/groups/${G}/members`, { user: "nobody-here" })).status === 404 && (await herval.post(`/api/groups/${G}/members`, { user: "herval" })).status === 400, "its owner can't put in someone who isn't here, or himself");
  check((await herval.post(`/api/groups/${G}/members`, { user: "dave" })).status === 409 && !(await groupIn(dave, G)), "nor someone who isn't his contact");

  // ---------- alice in it ----------
  const added = await herval.post(`/api/groups/${G}/members`, { user: "@alice" });
  check(added.status === 200 && added.user === "alice", "its owner puts alice in it by @username");
  // The bell says so, once (main.ts, addedFor): what someone put her in since she last opened it.
  const addedOf = async (who: Person) => (await who.get("/api/q/side")).data?.added || [];
  check((await addedOf(alice)).some((x) => x.kind === "group" && x.id === G && x.by === "herval" && x.title === "Ledger import"), "the bell tells her herval put her in it");
  check(!(await addedOf(herval)).length && !(await addedOf(bob)).length, "and nobody else anything");
  const hers = await groupIn(alice, G);
  check(hers && hers.mine === false && hers.in === true && hers.owner === "herval" && hers.members.some((m) => m.user === "alice"), "it's on her Groups, as herval's, with her in it");
  check(!hers.members.some((m) => m.agent), "without herval's private agent among its members");
  const d = await alice.get(`/api/groups/${G}`);
  check(d.status === 200 && d.thread_ids?.includes("h1") && Array.isArray(d.notes) && d.told === null, "she opens it: its threads and notes, not what its threads are told");
  check((await sees(alice, "h1")) && !(await sees(alice, "h2")), "she sees the thread in it, not his other one");
  const detail = await alice.get("/api/sessions/h1");
  check(detail.messages?.some((m) => m.text === "Reading the ledger's CSV.") && !detail.cwd && !detail.transcript, "its conversation, not where it runs");
  check((await alice.get("/api/sessions/h1/steps")).status === 200, "and its steps");
  const card = (await stateOf(alice.get)).sessions.find((s) => s.id === "h1");
  check(card && card.mine === false && card.group === G, "its card is in her state, in the group");
  check(await feedHas(alice, "h1"), "and on her feed: its updates reach her");
  const steer = await Promise.all([alice.post("/api/sessions/h1/messages", { text: "hi" }), alice.post("/api/sessions/h1/stop"), alice.post("/api/sessions/h1/visibility", { visibility: "public" })]);
  check(steer.every((r) => r.status === 403), "but only herval steers it: writing to it, Stop, who sees it answer 403");
  check((await bob.get(`/api/groups/${G}`)).status === 404 && !(await sees(bob, "h1")) && !(await feedHas(bob, "h1")) && (await nobody.get(`/api/groups/${G}`)).status === 401, "bob, not in it, sees neither; signed out, nothing loads");

  // ---------- the people in it always see the work ----------
  check((await alice.post(`/api/groups/${G}/visibility`, { visibility: "public" })).status === 403, "only its owner says who sees it");
  check((await herval.post(`/api/groups/${G}/visibility`, { show_work: false })).status === 400, "and nobody switches the work off: there's no such switch");
  check((await alice.get("/api/sessions/h1/steps")).status === 200, "she still sees its steps");

  // ---------- what she changes: its brief, notes, files, her own threads and agents ----------
  check((await alice.post(`/api/groups/${G}`, { brief: "Import Acme's ledger, end to end. UI by alice." })).status === 200, "she edits its brief");
  const after = await herval.get(`/api/groups/${G}`);
  check(after.brief?.endsWith("UI by alice.") && after.brief_by?.user === "alice", "and herval sees it, by her");
  check((await alice.post(`/api/groups/${G}`, { name: "Mine now" })).status === 403 && (await groupIn(herval, G)).name === "Ledger import", "she doesn't rename it");
  const hisNote = (await herval.post(`/api/groups/${G}/notes`, { text: "The CSV has two date formats." })).id;
  const herNote = await alice.post(`/api/groups/${G}/notes`, { text: "The UI goes on the ledger page." });
  check(herNote.status === 200, "she leaves a note");
  check((await alice.post(`/api/groups/${G}/notes/${hisNote}/delete`)).status === 403 && (await alice.post(`/api/groups/${G}/notes/${herNote.id}/delete`)).status === 200, "she deletes her own note, not his");
  const wrote = await alice.post(`/api/groups/${G}/files`, { path: "ui/plan.md", text: "# UI\nA table, then a chart." });
  check(wrote.status === 200, "she adds a file");
  const read = await fetch(`${HUB}/api/groups/${G}/file?path=ui/plan.md`, { headers: { cookie: herval.cookie } }).then((r) => r.text());
  check(read === "# UI\nA table, then a chart.", "and herval reads it");
  check(!!(await until(() => fs.existsSync(path.join(BASE, "hub", "cli", "groups", G, "ui", "plan.md")))), "it's in the group's folder on herval's machine");
  const ownersOnly = await Promise.all([alice.post(`/api/groups/${G}/visibility`, { visibility: "public" }), alice.post(`/api/groups/${G}/archive`, { archived: true }), alice.post(`/api/groups/${G}/members`, { user: "bob" }), alice.post(`/api/groups/${G}/wips`, { wip: { id: "x-pr1", kind: "pr", title: "x", ref: "#1", repo: "app" } })]);
  check(ownersOnly.every((r) => r.status === 403) && !(await groupIn(bob, G)), "who sees it, Archive, who's in it and its WIP are his: 403");
  check((await alice.post(`/api/groups/${G}/members`, { agent: "claude", remove: true })).status !== 200 && (await groupIn(herval, G)).members.some((m) => m.agent === "claude"), "she doesn't take his agent out");
  check((await alice.post(`/api/groups/${G}/threads`, { post: "h1", remove: true })).status === 404 && (await groupIn(herval, G)).posts === 1, "nor his thread");
  await herval.post("/api/sessions/h2/visibility", { visibility: "public" });
  check((await sees(alice, "h2")) && (await alice.post(`/api/groups/${G}/threads`, { post: "h2" })).status === 404, "nor puts a thread of his in it, even one she sees: only her own");
  await herval.post("/api/sessions/h2/visibility", { visibility: "private" });

  // ---------- her thread in it ----------
  check((await alice.post(`/api/groups/${G}/threads`, { post: "a1" })).status === 200, "she puts her thread in it");
  const hisView = await groupIn(herval, G);
  const herAgent = (await stateOf(alice.get)).agents.find((a) => a.mine !== false)?.id;
  check(hisView.posts === 2 && !!herAgent && hisView.members.some((m) => m.agent === herAgent), "it's in the group, and her agent joins with it");
  check((await sees(herval, "a1")) && (await feedHas(herval, "a1")) && !(await sees(bob, "a1")), "herval sees her thread, on his feed too; bob doesn't");
  check((await herval.post("/api/sessions/a1/messages", { text: "hi" })).status === 403, "and only she writes to it");
  check(!(await sees(carol, "a1")) && !(await sees(carol, "h1")), "nobody else does either");

  // ---------- what each thread is told ----------
  const hisTold = (await wren.get("/context")).text || "";
  check(/People in it: herval \(its owner\), alice\. Each of them sees every thread in it, this one too, its steps and changes too: keep secrets out of it\./.test(hisTold), "herval's thread is told who sees it: the people in it");
  check(/@alice's finch \(Claude\) "Ledger import: the UI"/.test(hisTold), "and alice's thread in it, as hers");
  const herTold = (await finch.get("/context")).text || "";
  check(/This thread is in the group "Ledger import"/.test(herTold) && /herval \(its owner\)/.test(herTold) && /@herval's wren \(Claude\) "Import the ledger"/.test(herTold), "her thread is told the group, its owner and his thread in it, as his");
  check(/The group's brief, from alice:/.test(herTold) && /UI by alice\./.test(herTold), "and its brief");
  const task = await herval.post("/api/tasks", { text: "Write the import's release notes", group: G });
  check(task.status === 200 && /The group's tasks/.test((await wren.get("/context")).text || "") && !/The group's tasks|release notes/.test((await finch.get("/context")).text || ""), "its tasks are herval's: his thread is told them, hers isn't");
  await prompted(finch);
  await wren.post("/updates", { text: "Parsed both date formats." });
  // What changed in it is one line for every thread in it: the owner's threads by name, anyone else's with whose.
  check(/\n  wren \(Claude\): Parsed both date formats\./.test(await prompted(finch)), "her thread hears his thread's results with its next prompt");
  await prompted(wren);
  await finch.post("/updates", { text: "Drew the import table." });
  // Hers comes over from her laptop: it may take a moment.
  const heardHers = (await until(async () => {
    const t = await prompted(wren);
    return /Drew the import table/.test(t) ? t : null;
  })) || "";
  check(/@alice's finch \(Claude\): Drew the import table\./.test(heardHers), "and his hears hers, as hers");
  const overview = (await finch.get("/group")).text || "";
  check(/People in it: herval \(its owner\), alice/.test(overview) && /@herval's wren/.test(overview) && !/Tasks \(/.test(overview), "ab_group_read gives her thread the group, without his tasks");

  // ---------- its folder on her laptop ----------
  check(!!(await until(() => fs.existsSync(path.join(BASE, "alice", "cli", "groups", G, "ui", "plan.md")))), "its files are in the group's folder on her laptop too");
  await herval.post(`/api/groups/${G}/files`, { path: "notes/dates.md", text: "Two formats: ISO and US." });
  const synced = await until(() => fs.existsSync(path.join(BASE, "alice", "cli", "groups", G, "notes", "dates.md")) && fs.readFileSync(path.join(BASE, "alice", "cli", "groups", G, "notes", "dates.md"), "utf8"));
  check(synced === "Two formats: ISO and US.", "and a file herval adds reaches it");
  const byFinch = await finch.post("/group/files", { path: "ui/columns.md", text: "date, amount, account" });
  check(byFinch.status === 200 && (await herval.get(`/api/groups/${G}/versions?path=ui/columns.md`)).versions?.[0]?.by?.post === "a1", "her thread writes a file with ab_group_write, credited to it");

  // ---------- public, for someone not in it ----------
  await herval.post(`/api/groups/${G}/visibility`, { visibility: "public" });
  const pub = await bob.get(`/api/groups/${G}`);
  check(pub.status === 200 && !pub.thread_ids?.length && !pub.notes?.length && !(await sees(bob, "h1")) && !(await sees(bob, "a1")), "public, bob, his contact, sees what it is, not its private threads or notes");
  check((await dave.get(`/api/groups/${G}`)).status === 404, "someone who isn't his contact doesn't");
  check((await bob.post(`/api/groups/${G}/notes`, { text: "hi" })).status === 404 && (await bob.post(`/api/groups/${G}/files`, { path: "x.md", text: "x" })).status === 404 && (await bob.post(`/api/groups/${G}`, { brief: "x" })).status === 404, "and changes nothing in it");
  check((await groupIn(bob, G))?.in !== true, "it isn't one he's in");
  await herval.post(`/api/groups/${G}/visibility`, { visibility: "private" });

  // ---------- leaving ----------
  check((await herval.post(`/api/groups/${G}/leave`)).status === 400, "its owner can't leave it");
  check((await alice.post(`/api/groups/${G}/leave`)).status === 200, "alice leaves it");
  check(!(await groupIn(alice, G)) && (await alice.get(`/api/groups/${G}`)).status === 404 && !(await sees(alice, "h1")) && !(await feedHas(alice, "h1")), "it and its threads are gone for her");
  const left = await groupIn(herval, G);
  check(left.posts === 1 && !left.members.some((m) => m.user === "alice" || m.agent === herAgent) && !(await sees(herval, "a1")), "her thread and agent left with her, and herval doesn't see her thread any more");
  const toldAfter = (await wren.get("/context")).text || "";
  check(!/People in it|@alice's|finch/.test(toldAfter), "his thread isn't told about her or her thread any more");
  check(/alice left the group/.test(await prompted(wren)), "and hears she left");

  // ---------- taken out ----------
  await herval.post(`/api/groups/${G}/members`, { user: "alice" });
  check(await sees(alice, "h1"), "put in again, she sees its threads again");
  await alice.post(`/api/groups/${G}/threads`, { post: "a1" });
  await herval.post(`/api/groups/${G}/members`, { user: "alice", remove: true });
  check(!(await groupIn(alice, G)) && !(await sees(alice, "h1")) && (await groupIn(herval, G)).posts === 1, "taken out, she doesn't, and her thread is out with her");

  // ---------- a page's contributors ----------
  const P = (await wren.post("/pages", { title: "Ledger import: status", widgets: [{ id: "n", type: "note", data: { text: "Parsing both date formats." } }] })).id;
  check(!!P && !(await sees(alice, "h1")), "wren keeps a page of herval's; alice, in nothing of his now, doesn't see wren");
  await herval.post(`/api/pages/${P}/contributors`, { user: "alice" });
  check((await alice.get(`/api/pages/${P}`)).status === 200 && (await sees(alice, "h1")) && (await feedHas(alice, "h1")), "made a contributor, she sees the thread on it, on her feed too");
  const news = await addedOf(alice);
  check(news.length === 1 && news[0].kind === "page" && news[0].id === P && news[0].by === "herval", "the bell tells her (the group she's out of again isn't news any more)");
  check((await alice.post("/api/bell/seen")).status === 200 && (await addedOf(alice)).length === 1 && (await addedOf(alice))[0].seen === true, "she opens the bell: seen, and still there");
  check((await alice.post("/api/bell/clear")).status === 200 && !(await addedOf(alice)).length, "she clears her notifications: gone");
  const T = (await herval.post("/api/tasks", { text: "Check the import totals" })).id;
  await herval.post(`/api/tasks/${T}/people`, { user: "alice" });
  const later = await addedOf(alice);
  check(later.length === 1 && later[0].kind === "task" && later[0].id === T && later[0].title === "Check the import totals", "a task he shares with her after that is, alone");
  check(!later[0].seen && (await nobody.post("/api/bell/seen")).status === 401 && (await nobody.post("/api/bell/clear")).status === 401, "signed out, no bell");
  await alice.post("/api/bell/clear");
  check((await alice.get(`/api/pages/${P}`)).posts?.some((x) => x.post === "h1"), "and the page names it for her");
  check((await alice.get("/api/sessions/h1/steps")).status === 200 && !(await sees(alice, "h2")), "with its steps, and not his other thread");
  check((await herval.post(`/api/pages/${P}/visibility`, { show_work: false })).status === 400 && (await alice.get("/api/sessions/h1/steps")).status === 200 && (await herval.get(`/api/pages/${P}`)).visibility === "private", "nobody switches the work off (no such switch): she still sees its steps; the page stays private");
  check((await alice.post("/api/sessions/h1/messages", { text: "hi" })).status === 403, "and only herval writes to it");
  check(/This thread is on the page "Ledger import: status" \([^)]+\), which @alice keeps with herval\. They see this thread, its steps and changes too: keep secrets out of it\./.test((await wren.get("/context")).text || ""), "wren is told she sees it");
  // She starts threads on it, on her own agents, which can then
  // change it: each goes on it, put there by her.
  check((await bob.post("/api/launch", { prompt: "Add the totals.", agent: herAgent, page: P })).status === 403, "bob can't set her agent on it");
  const started = await alice.post("/api/launch", { prompt: "Add the UI's status to the page.", agent: herAgent, page: P });
  check(started.status === 200 && !!started.lid, "alice starts a thread on it with her own agent");
  check(((await herval.get(`/api/pages/${P}`)).contributors || []).some((c) => c.agent === herAgent && c.by === "alice"), "which is on it now, put there by her");
  check((await alice.post(`/api/pages/${P}/threads`, { post: "a1" })).status === 200 && (await sees(herval, "a1")) && !(await sees(bob, "a1")) && !(await sees(bob, "h1")), "she puts her own thread on it: herval sees it, bob sees neither");
  check(/It's @herval's page, which alice contributes to: who sees it and who contributes are @herval's to change\./.test((await until(async () => { const t = (await finch.get("/context")).text || ""; return /herval's page/.test(t) && t; })) || ""), "her thread on it is told it's herval's page, his to say who sees and changes it");
  check((await alice.post(`/api/pages/${P}/threads`, { post: "h2" })).status === 404, "but not one of his");
  await herval.post(`/api/pages/${P}/contributors`, { user: "alice", remove: true });
  check(!(await sees(alice, "h1")) && !(await sees(herval, "a1")), "taken off it, she doesn't see his thread, nor he hers");
  check(!((await herval.get(`/api/pages/${P}`)).contributors || []).some((c) => c.agent === herAgent), "and her agent is off it with her");
  const refused = await alice.post("/api/launch", { prompt: "One more.", agent: herAgent, page: P });
  check(refused.status === 403 && /Only the people who keep/.test(refused.error || ""), "so she can't start one there any more");

  // ---------- an account deleted ----------
  await herval.post(`/api/groups/${G}/members`, { user: "carol" });
  check((await groupIn(carol, G))?.in === true, "carol's in it");
  check((await herval.post("/api/people/carol/delete")).status === 200 && !(await groupIn(herval, G)).members.some((m) => m.user === "carol"), "her account deleted, she's out of it");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  for (const p of running) p.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
