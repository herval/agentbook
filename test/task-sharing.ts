#!/usr/bin/env node
// Sharing a task: its owner (herval), someone on it (alice), someone who isn't (bob) and
// someone signed out, against the task's routes, the threads on it, their work, steering, agents' ab_tasks and what a
// thread is told, and a public task by its link. Run: node test/task-sharing.ts

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { type MachineView, postForOthers, viewFor } from "../server/policy.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-task-sharing-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
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
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });
const taskIn = async (who: ReturnType<typeof as>, id: string) => (await stateOf(who.get)).tasks.find((t) => t.id === id);
const sees = async (who: ReturnType<typeof as>, id: string) => (await who.get(`/api/sessions/${encodeURIComponent(id)}`)).status === 200;

// ---------- the rule, on its own (policy.ts) ----------
{
  const post = { id: "p1", agent: "claude", title: "Fix the importer", visibility: "private" as const, cwd: "/Users/SECRETX", prompt: "Fix the CSV dates", messages: [], questions: [{ title: "SECRETX-q" }] };
  const view: MachineView = { seq: 1, machine: "m", agents: [{ id: "claude", name: "Claude", kind: "claude-code", glyph: "C", created: "2026-10-30T10:00:00Z", visibility: "private" }], sessions: [post, { ...post, id: "p2", title: "Rotate the keys" }], live: { p1: { step: { id: "s1", kind: "tool", title: "a step" } }, p2: { step: { id: "s2", kind: "tool", title: "another" } } }, pages: [] };
  const none = viewFor(view, false, "herval", null);
  check(none.sessions.length === 0, "a private thread isn't in its machine's view for someone else");
  const shared = viewFor(view, false, "herval", null, (id) => (id === "p1" ? true : undefined));
  const p1 = shared.sessions[0];
  check(shared.sessions.length === 1 && p1.id === "p1" && "shared" in p1 && p1.shared === true && p1.mine === false && !shared.agents.length, "on a task shared with them, it is (marked shared), and only it: not its private agent");
  check(!JSON.stringify(shared).includes("SECRETX") && shared.live.p1 && !shared.live.p2, "without where it runs or its questions; its live step shows, as its work does");
  const quiet = viewFor(view, false, "herval", null, (id) => (id === "p1" ? false : undefined));
  check(quiet.sessions.length === 1 && !quiet.live.p1, "shared without its work (a followers-only thread that doesn't show it), the thread shows and its live step doesn't");
  const out = postForOthers(post, view.agents[0], "herval", false);
  check(out.public === false && out.shared === true && out.owner === "herval", "a private thread shown to someone through a task says it isn't public");
}

const server = spawnAgentbook({ env, stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const herval = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const join = async (username) => as((await req("POST", "/api/auth/test-person", { body: { username } })).cookie);
  const alice = await join("alice");
  const bob = await join("bob");
  const dave = await join("dave");
  const nobody = as(null);
  // Only a contact goes on a task, or sees a public one: herval, alice and bob are each
  // other's; dave is nobody's.
  const contacts = async (a: ReturnType<typeof as>, aName: string, b: ReturnType<typeof as>, bName: string) => {
    await a.post(`/api/people/${bName}/contact`, { act: "ask" });
    await b.post(`/api/people/${aName}/contact`, { act: "yes" });
  };
  await contacts(herval, "herval", alice, "alice");
  await contacts(herval, "herval", bob, "bob");
  await contacts(alice, "alice", bob, "bob");

  // herval's two threads on his machine: wren (a step, a picture, a file, a question) and kite.
  const transcript = path.join(HOME, "t-a.jsonl");
  const at = new Date().toISOString();
  fs.writeFileSync(transcript, [{ type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls ~/dev/app", description: "List the app" } }] } }].map((e) => JSON.stringify(e) + "\n").join(""));
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: project, transcript } });
  await req("POST", "/api/procs/box-1/post", { body: { title: "Fix the importer" } });
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "Working on the importer." } });
  await req("POST", "/api/procs/box-1/questions", { body: { title: "Deploy now?", options: ["Yes", "No"] } });
  const file = await req("POST", "/api/procs/box-1/files", { body: { name: "report.txt", content_base64: Buffer.from("the report").toString("base64") } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: project } });
  await req("POST", "/api/procs/box-2/post", { body: { title: "Rotate the keys" } });
  const wren = agent("box-1");
  const kite = agent("box-2");

  // herval's task, with wren on it; another of his; and one of alice's own.
  const T = (await herval.post("/api/tasks", { text: "Ship the importer", note: "Acme's ledger import, end to end." })).id;
  await herval.post(`/api/tasks/${T}/link`, { post: "sess-a" });
  const U = (await herval.post("/api/tasks", { text: "Renew the certificate" })).id;
  const V = (await alice.post("/api/tasks", { text: "Alice's own" })).id;

  // ---------- before it's shared ----------
  check((await alice.get(`/api/tasks/${T}`)).status === 404 && !(await taskIn(alice, T)) && !(await sees(alice, "sess-a")), "before it's shared, alice sees neither the task nor its thread");
  check((await alice.post(`/api/tasks/${T}/done`)).status === 404 && (await alice.post(`/api/tasks/${T}`, { text: "x" })).status === 404, "nor changes it");
  check((await herval.post(`/api/tasks/${T}/people`, { user: "nobody-here" })).status === 404 && (await herval.post(`/api/tasks/${T}/people`, { user: "herval" })).status === 400, "its owner can't add someone who isn't here, or themself");
  check((await herval.post(`/api/tasks/${T}/people`, { user: "dave" })).status === 409 && !(await taskIn(dave, T)), "nor someone who isn't his contact");
  const todo = (await req("POST", "/api/procs/box-1/todos", { body: { text: "Review the importer's pull request" } })).id;
  check((await herval.post(`/api/tasks/${todo}/people`, { user: "alice" })).status === 400 && (await herval.post(`/api/tasks/${todo}/visibility`, { visibility: "public" })).status === 400, "a to-do a thread keeps can't be shared or made public until it's on Tasks");

  // ---------- alice on it ----------
  const added = await herval.post(`/api/tasks/${T}/people`, { user: "@alice" });
  check(added.status === 200 && added.user === "alice", "its owner adds alice by @username");
  const hers = await taskIn(alice, T);
  check(hers && hers.mine === false && hers.owner_name === "herval" && hers.people?.map((x) => x.user).join() === "alice" && hers.workspace === null && hers.agent === null, "it's on her Tasks as herval's, with who's on it");
  const herList = (await stateOf(alice.get)).tasks.filter((t) => !t.done);
  check(herList.find((t) => t.id === T).rank < herList.find((t) => t.id === V).rank, "on top of her list");
  const his = await taskIn(herval, T);
  check(his.mine === true && his.people?.map((x) => x.user).join() === "alice" && !("ranks" in his), "his says who it's shared with, and nobody's order");
  check((await sees(alice, "sess-a")) && !(await sees(alice, "sess-b")), "she sees the thread on it, not his other one");
  const detail = await alice.get("/api/sessions/sess-a");
  check(detail.agent === null && !(await stateOf(alice.get)).agents.some((a) => a.owner === "herval"), "not which agent of his it is: its agent is left out (a private agent), and his agents aren't in hers");
  check(detail.messages?.some((m) => m.text === "Working on the importer.") && !detail.questions?.length && !detail.cwd && !detail.transcript, "its conversation, not his questions or where it runs");
  check((await alice.get("/api/sessions/sess-a/steps")).status === 200 && (await alice.get(`/api/files/${file.id}`)).status === 200, "and, with Show the work on, its steps and files");
  const card = (await stateOf(alice.get)).sessions.find((s) => s.id === "sess-a");
  check(card && card.mine === false && card.shared === true && !card.public, "its card is on her feed, as his and shared with her");
  check((await alice.get("/api/q/feed?q=importer")).list?.includes("thread:sess-a"), "searching finds it for her");
  const steer = await Promise.all([alice.post("/api/sessions/sess-a/messages", { text: "hi" }), alice.post("/api/sessions/sess-a/stop"), alice.post("/api/sessions/sess-a/visibility", { visibility: "public" })]);
  check(steer.every((r) => r.status === 403), "but only herval steers it: writing to it, Stop, who sees it answer 403");
  check((await bob.get(`/api/tasks/${T}`)).status === 404 && !(await sees(bob, "sess-a")) && (await nobody.get(`/api/tasks/${T}`)).status === 401, "bob, not on it, sees neither; signed out, nothing loads");

  // ---------- the people on it always see the work ----------
  check((await alice.post(`/api/tasks/${T}/visibility`, { visibility: "public" })).status === 403, "only its owner says who sees it");
  check((await herval.post(`/api/tasks/${T}/visibility`, { show_work: false })).status === 400, "and nobody switches the work off: there's no such switch");
  check((await alice.get("/api/sessions/sess-a/steps")).status === 200 && (await alice.get(`/api/files/${file.id}`)).status === 200, "she still sees its steps and files");

  // ---------- what she can change: she adds her own threads ----------
  const branch = { id: "app-fix-dates", kind: "branch", ref: "fix-dates", title: "fix-dates", repo: "app" };
  const theirs = await Promise.all([alice.post(`/api/tasks/${T}`, { text: "Ship the importer v2" }), alice.post(`/api/tasks/${T}/items`, { item: branch }), alice.post(`/api/tasks/${T}/order`, { order: [] }), alice.post(`/api/tasks/${T}/landing`, { on: true })]);
  check(theirs.every((r) => r.status === 403) && (await taskIn(herval, T)).text === "Ship the importer", "she doesn't edit it, put a pull request or branch in, set the landing order or land them: 403");
  check((await herval.post(`/api/tasks/${T}`, { text: "Ship the importer v2" })).status === 200 && (await taskIn(alice, T)).text === "Ship the importer v2", "herval does, and she sees it");
  check((await herval.post(`/api/tasks/${T}/items`, { item: branch })).status === 200, "he puts a branch in it");
  const herParts = (await taskIn(alice, T)).parts;
  check(herParts?.some((x) => x.id === "app-fix-dates" && x.kind === "branch") && !("parts" in (await taskIn(herval, T))) && (await taskIn(herval, T)).ship?.items?.some((x) => x.id === "app-fix-dates"), "what it ships comes to her from the server, as its owner's page finds it; his page finds it itself");
  check((await alice.post(`/api/tasks/${T}/done`)).status === 403 && !(await taskIn(herval, T)).done, "she doesn't tick it off: 403, and it stays open");
  await herval.post(`/api/tasks/${T}/done`);
  const ticked = await taskIn(alice, T);
  check(ticked?.done && ticked.done_user === "herval", "herval does, and she sees he did");
  check((await alice.post(`/api/tasks/${T}/done`, { done: false })).status === 403 && (await taskIn(herval, T)).done, "nor puts it back");
  await herval.post(`/api/tasks/${T}/done`, { done: false });
  const own = await Promise.all([alice.post(`/api/tasks/${T}/people`, { user: "bob" }), alice.post(`/api/tasks/${T}/visibility`, { visibility: "public" }), alice.post(`/api/tasks/${T}/delete`), alice.post(`/api/tasks/${T}/later`)]);
  check(own.every((r) => r.status === 403) && !(await taskIn(bob, T)), "but not who's on it, who sees it, Delete or Later");
  check((await alice.post(`/api/tasks/${T}/link`, { post: "sess-a", linked: false })).status === 403 && (await taskIn(herval, T)).posts.some((e) => e.post === "sess-a"), "nor takes his thread off it");
  await herval.post("/api/sessions/sess-b/visibility", { visibility: "public" });
  check((await sees(alice, "sess-b")) && (await alice.post(`/api/tasks/${T}/link`, { post: "sess-b" })).status === 403 && !(await taskIn(herval, T)).posts.some((e) => e.post === "sess-b"), "nor adds a thread of his, even one she sees: only her own");
  await herval.post("/api/sessions/sess-b/visibility", { visibility: "private" });
  check((await alice.post(`/api/tasks/${T}/send`, { launch: "l-not-hers" })).status === 403, "nor says it went out as a launch that isn't on a machine of hers");

  // Each one's own order: she moves it last on hers; his stays.
  const hisRank = (await taskIn(herval, T)).rank;
  await alice.post(`/api/tasks/${T}/move`, {});
  const herOrder = (await stateOf(alice.get)).tasks.filter((t) => !t.done);
  check(herOrder.find((t) => t.id === T).rank > herOrder.find((t) => t.id === V).rank && (await taskIn(herval, T)).rank === hisRank, "she moves it on her list, not on his");
  await herval.post(`/api/tasks/${T}/move`, { before: U });
  const hisOrder = (await stateOf(herval.get)).tasks.filter((t) => !t.done);
  check(hisOrder.find((t) => t.id === T).rank < hisOrder.find((t) => t.id === U).rank && (await taskIn(alice, T)).rank > (await taskIn(alice, V)).rank, "and he on his, not on hers");

  // ---------- its worktrees: she opens each, read only, while Show the work is on ----------
  const repo = path.join(HOME, "dev", "ledger");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const tree = path.join(repo, ".claude", "worktrees", "fix-totals");
  git(repo, "worktree", "add", "-q", "-b", "fix-totals", tree);
  fs.writeFileSync(path.join(tree, "totals.js"), "export const total = (xs) => xs.reduce((a, b) => a + b, 0); // fixed\n");
  git(tree, "add", ".");
  git(tree, "commit", "-qm", "Fix the totals");
  fs.writeFileSync(path.join(tree, "notes.md"), "not committed\n");
  // A thread that ran there, through Claude Code's hooks: its machine reads its folder's branches.
  const hook = (event, input) => spawnSync(process.execPath, [path.join(PLUGIN, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: "sess-d", cwd: tree, ...input }), env: { ...env, AGENTBOOK_URL: URL, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_CODE_ENTRYPOINT: "cli", AGENTBOOK_PID: "8104" }, encoding: "utf8", timeout: 15000 });
  hook("SessionStart", { source: "startup" });
  hook("UserPromptSubmit", { prompt: "Fix the totals" });
  hook("SessionEnd", { reason: "other" });
  await until(async () => (await stateOf(herval.get)).sessions.some((x) => x.id === "sess-d"));
  await herval.post(`/api/tasks/${T}/link`, { post: "sess-d" });
  const part = await until(async () => (await taskIn(alice, T))?.parts?.find((x) => x.branch === "fix-totals" && x.where));
  check(part && part.where.ahead === 1 && part.where.dirty === 1 && part.where.owner === "herval" && !JSON.stringify(part).includes(HOME), "her task says how its branch stands on his machine, never in which folder");
  const q = `part=${encodeURIComponent(part?.id || "")}`;
  const wt = await alice.get(`/api/tasks/${T}/worktree?${q}`);
  check(wt.status === 200 && wt.branch === "fix-totals" && wt.committed?.some((f) => f.path === "totals.js") && wt.uncommitted?.some((f) => f.path === "notes.md") && wt.commits?.length === 1, "she opens its worktree: its commit, the files it changes and the one not committed");
  check(!wt.raw.includes(HOME) && !("root" in wt) && !("worktree" in wt) && wt.checked_out === true, "not where it is on his machine");
  const diff = await alice.get(`/api/tasks/${T}/worktree/diff?${q}&path=totals.js&scope=committed`);
  check(diff.status === 200 && diff.raw.includes("// fixed"), "and a file's changes");
  check((await alice.get(`/api/tasks/${T}/worktree?part=nope`)).status === 404 && (await alice.get(`/api/tasks/${U}/worktree?${q}`)).status === 404, "not a branch that isn't on it, nor through a task she isn't on");
  check((await bob.get(`/api/tasks/${T}/worktree?${q}`)).status === 404 && (await nobody.get(`/api/tasks/${T}/worktree?${q}`)).status === 401 && (await alice.get(`/api/wip?root=${encodeURIComponent(repo)}&branch=fix-totals&machine=${encodeURIComponent(wt.machine || "")}`)).status === 403, "bob, not on it, can't; nor she around the task");
  check((await alice.get(`/api/tasks/${T}/pull?${q}`)).status === 400, "a branch isn't a pull request");
  check((await herval.get(`/api/tasks/${T}/worktree?${q}`)).status === 200, "its owner reads it the same way");
  await herval.post(`/api/tasks/${T}/link`, { post: "sess-d", linked: false });

  // ---------- her thread on it ----------
  const talk = (await alice.post("/api/talks", { text: "Notes on the importer\nThe ledger's CSV has two date formats." })).id;
  check((await alice.post(`/api/tasks/${T}/link`, { post: talk })).status === 200, "she links a thread of hers");
  check((await herval.get(`/api/q/thread/${talk}?n=5`)).status === 200 && (await bob.get(`/api/q/thread/${talk}?n=5`)).status === 404, "herval sees it; bob doesn't");
  check((await herval.post(`/api/talks/${talk}/messages`, { text: "hi" })).status === 403, "and only she writes in it");

  // A thread she sees through his task, linked to a task of hers shared with bob, doesn't show to bob.
  const W = (await alice.post("/api/tasks", { text: "Alice and Bob's" })).id;
  await alice.post(`/api/tasks/${W}/people`, { user: "bob" });
  const relink = await alice.post(`/api/tasks/${W}/link`, { post: "sess-a" });
  check(relink.status === 200 && !(await sees(bob, "sess-a")) && (await bob.get(`/api/q/thread/${talk}?n=5`)).status === 404, "linking his thread to her task shared with bob doesn't show it to bob: a task shares only its people's threads");
  await alice.post(`/api/tasks/${W}/link`, { post: talk });
  check((await bob.get(`/api/q/thread/${talk}?n=5`)).status === 200, "her own thread on it does");
  await alice.post(`/api/tasks/${W}/link`, { post: talk, linked: false });

  // ---------- agents ----------
  const listed = (await wren.get("/tasks")).open?.find((t) => t.id === T);
  check(listed && listed.owner === null && listed.with?.join() === "alice", "herval's agents' ab_tasks say it's shared with alice");
  const linkd = await kite.post("/tasks/link", { ids: [T] });
  check(linkd.results?.[0]?.ok && linkd.results[0].shared_with?.join() === "alice", "an agent linking its thread to it is told who sees it now");
  check(await sees(alice, "sess-b"), "and alice sees that thread too");
  // One of alice's, shared with herval: his agent sees it and doesn't tick it off; she does.
  const X = (await alice.post("/api/tasks", { text: "Alice's, with herval" })).id;
  await alice.post(`/api/tasks/${X}/people`, { user: "herval" });
  check((await wren.get("/tasks")).open?.find((t) => t.id === X)?.owner === "alice", "his agents' ab_tasks list hers, as hers");
  const refused = (await wren.post("/tasks/done", { ids: [X] })).results?.[0];
  check(refused && !refused.ok && /only its owner, @alice/.test(refused.refused || "") && !(await taskIn(alice, X)).done, "his agent ticking it off is refused, saying only @alice does");
  check((await alice.post(`/api/tasks/${X}/done`)).status === 200 && (await taskIn(herval, X)).done, "she ticks it off");
  const told = (await wren.get("/context")).text || "";
  check(told.includes("Ship the importer v2") && told.includes("shared with @alice") && told.includes("keep secrets out"), "a thread on it is told, when it starts, who sees it");

  // ---------- public ----------
  await herval.post(`/api/tasks/${T}/visibility`, { visibility: "public" });
  const open = await bob.get(`/api/tasks/${T}`);
  check(open.status === 200 && open.task?.on === false && open.task.text === "Ship the importer v2" && !open.threads?.length, "public, bob, his contact, opens it by its link: what it is, and none of its private threads");
  check((await dave.get(`/api/tasks/${T}`)).status === 404, "someone who isn't his contact doesn't");
  check(!/sess-a|sess-b|t-[0-9a-f]{12}/.test(open.raw), "nothing names them");
  check(open.task.parts?.some((x) => x.id === "app-fix-dates") && open.task.parts.every((x) => !x.threads.length), "what it ships, without the private threads on each");
  check(!(await taskIn(bob, T)) && (await bob.post(`/api/tasks/${T}/done`)).status === 404 && (await bob.post(`/api/tasks/${T}`, { text: "x" })).status === 404, "it isn't on his Tasks, and he can't change it");
  await herval.post("/api/sessions/sess-b/visibility", { visibility: "public" });
  check((await bob.get(`/api/tasks/${T}`)).threads?.some((s) => s.id === "sess-b"), "a public thread on it shows to him");
  await herval.post("/api/sessions/sess-b/visibility", { visibility: "private" });
  await herval.post(`/api/tasks/${T}/visibility`, { visibility: "private" });
  check((await bob.get(`/api/tasks/${T}`)).status === 404, "private again, it doesn't");

  // ---------- off it ----------
  check((await herval.post(`/api/tasks/${T}/leave`)).status === 400, "its owner can't leave it");
  check((await alice.post(`/api/tasks/${T}/leave`)).status === 200 && !(await taskIn(alice, T)) && !(await sees(alice, "sess-a")) && !(await sees(alice, "sess-b")), "alice leaves: it and its threads are gone for her");
  check(!(await taskIn(herval, T)).people?.length && (await herval.get(`/api/q/thread/${talk}?n=5`)).status === 404, "and her thread on it is gone for him");
  await herval.post(`/api/tasks/${T}/people`, { user: "alice" });
  check(await sees(alice, "sess-a"), "added again, she sees them again");
  await herval.post(`/api/tasks/${T}/people`, { user: "alice", remove: true });
  check(!(await taskIn(alice, T)) && !(await sees(alice, "sess-a")), "taken off, she doesn't");
  await herval.post(`/api/tasks/${T}/people`, { user: "alice" });
  await herval.post(`/api/tasks/${T}/delete`);
  check(!(await taskIn(alice, T)) && (await alice.get(`/api/tasks/${T}`)).status === 404 && !(await sees(alice, "sess-a")), "deleted, it's gone for her, and its threads with it");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
