#!/usr/bin/env node
// Who sees what: private or public, on a thread (an agent's, and one of your own), a page, a group, a task, a workspace
// and a worktree. herval owns them all; alice is his contact, bob isn't until the end, and someone signed out. Public
// shows a thing to its owner's contacts; the people he puts on a thing see it while it's private too. Following is only
// what's in your feed. Run: node test/visibility.ts

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { groupFor, pageFor, postForOthers, postLevel, seenAt } from "../server/policy.ts";
import { isLevel, levelOf, storedLevel } from "../plugin/shared/visibility.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-visibility-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(5000, 50);
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
type Person = ReturnType<typeof as>;
const sees = async (who: Person, id: string) => (await who.get(`/api/sessions/${encodeURIComponent(id)}`)).status === 200;
const keys = (r: Json) => Object.keys(r.records || {});
// On their main feed: what reaches them (feed=1), not every thread they may see.
const inFeed = async (who: Person, id: string) => ((await who.get("/api/q/feed?feed=1&n=100")).list || []).includes(`thread:${id}`);
const shows = async (who: Person, p: string) => (await who.get(p)).status === 200;

// ---------- the rule, on its own ----------
{
  check(isLevel("public") && isLevel("private") && !isLevel("followers") && !isLevel("friends") && levelOf("nope") === "private" && levelOf("public") === "public", "two levels, private and public; anything else is private");
  check(levelOf("followers") === "public" && storedLevel("followers") === "public" && storedLevel(undefined) === null, "an old followers-only thing reads as public: its followers were the people he'd let in");
  check(seenAt("public", true) && !seenAt("public", false) && seenAt("followers", true) && !seenAt("private", true) && !seenAt(undefined, true), "public shows to its owner's contacts and nobody else; private to nobody else");
  const agent = { id: "claude", name: "Claude", visibility: "private" as const };
  check(postLevel({ visibility: "followers" }, agent) === "public" && postLevel({}, agent) === "private" && postLevel({}, { ...agent, visibility: "public" }) === "public", "a thread's level is its own, else its agent's");
  const out = postForOthers({ id: "p1", agent: "claude", title: "x", visibility: "public", messages: [] }, agent, "herval", false);
  check(out.public === true && !("followers" in out) && !out.shared, "a public thread shown to someone says so");
  check(postForOthers({ id: "p2", agent: "claude", title: "y", visibility: "private", messages: [] }, agent, "herval", false).shared === true, "a private one they see says they were let in");
  const at = "2026-10-30T10:00:00Z";
  const g = { id: "g1", name: "Platform", owner: "u1", visibility: "public" as const, emoji: "", brief: "", brief_by: null, brief_at: null, by: null, members: [], created: at, updated: at, archived: null, agents: [], posts: 0 };
  const someone = { owner: false, ownerName: "herval" };
  check(groupFor(g, { ...someone, contact: true }) && !groupFor(g, { ...someone, contact: false }) && !groupFor({ ...g, visibility: "private" }, { ...someone, contact: true }), "a public group shows to its owner's contacts, not to anyone else");
  const page = { id: "pg", title: "Costs", emoji: "", color: null, about: "", by: { user: "u1" }, contributors: [], version: 1, created: at, updated: at, archived: null, visibility: "public" as const, widgets: [] };
  check(pageFor(page, new Map(), false, "herval", null, () => false, true) && !pageFor(page, new Map(), false, "herval", null, () => false, false), "a public page too");
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
  const nobody = as(null);

  // herval's two threads of his agent Claude: wren (a step) and kite.
  const transcript = path.join(HOME, "t-a.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "List the app" } }] } }) + "\n");
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: project, transcript } });
  await req("POST", "/api/procs/box-1/post", { body: { title: "Fix the importer" } });
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "Working on the importer." } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: project } });
  await req("POST", "/api/procs/box-2/post", { body: { title: "Rotate the keys" } });
  await until(async () => (await stateOf(herval.get)).sessions.filter((s) => s.id === "sess-a" || s.id === "sess-b").length === 2);
  await herval.post("/api/agents/claude/visibility", { visibility: "public" });
  check((await herval.post("/api/agents/claude/visibility", { visibility: "followers" })).status === 400, "an agent is private or public");
  await herval.post("/api/sessions/sess-b/visibility", { visibility: "private" });
  check((await herval.post("/api/sessions/sess-a/visibility", { visibility: "followers" })).status === 400 && (await alice.post("/api/sessions/sess-a/visibility", { visibility: "public" })).status !== 200, "a thread's level is one of the two, and its owner's to set");
  check((await herval.post("/api/sessions/sess-a/visibility", { visibility: "public" })).status === 200, "herval makes wren's thread public");

  // ---------- contacts ----------
  check(!(await sees(alice, "sess-a")) && (await alice.get("/api/agents/claude")).status === 404, "before alice is his contact, his public thread and agent aren't there for her");
  check((await alice.post("/api/agents/claude/follow", { follow: true })).status === 404, "nor can she follow his agent");
  const asked = await alice.post("/api/people/herval/contact", { act: "ask", note: "We met at the meetup" });
  check(asked.status === 200 && asked.contact?.asked && !asked.contact.contact && !(await sees(alice, "sess-a")), "alice asks to be his contact: nothing yet");
  check((await alice.post("/api/people/herval/contact", { act: "yes" })).status === 409, "she can't say yes to her own ask");
  const his = await herval.get("/api/contacts");
  check(his.asks?.some((a) => a.user === "alice" && !a.yours && a.note === "We met at the meetup"), "herval's Contacts has her ask, with what she said");
  const yes = await herval.post("/api/people/alice/contact", { act: "yes" });
  check(yes.status === 200 && yes.contact?.contact && yes.contact.following, "he says yes: they're contacts, and he follows her from the start");
  check((await herval.get("/api/contacts")).contacts?.some((c) => c.user === "alice" && c.following) && !(await herval.get("/api/contacts")).asks?.length, "she's among his contacts, and the ask is gone");

  // ---------- a public thread ----------
  check((await sees(alice, "sess-a")) && (await inFeed(alice, "sess-a")), "now she sees his public thread, in her feed too");
  const detail = await alice.get("/api/sessions/sess-a");
  check(detail.public === true && detail.mine === false && detail.messages?.some((m) => m.text === "Working on the importer.") && !detail.cwd && !detail.transcript, "its conversation, not where it runs");
  check(!(await sees(bob, "sess-a")) && !(await inFeed(bob, "sess-a")) && !(await sees(nobody, "sess-a")), "bob, who isn't his contact, doesn't; nor someone signed out");
  check(!(await sees(alice, "sess-b")), "nor does she see his private thread");
  check(await shows(alice, "/api/sessions/sess-a/steps"), "and its steps: whoever sees a thread sees its work");
  check(!(await shows(bob, "/api/sessions/sess-a/steps")), "not bob");
  check((await alice.post("/api/sessions/sess-a/messages", { text: "hi" })).status !== 200, "seeing it isn't steering it");
  check((await alice.get("/api/agents/claude")).status === 200 && (await bob.get("/api/agents/claude")).status === 404, "his public agent's profile: hers to see, not bob's");
  const told = (await req("GET", "/api/procs/box-1/context")).text || "";
  check(told.includes("herval's contacts on agentbook see its title") && told.includes("and its steps and files"), "the thread is told his contacts see it, its work too");

  // ---------- following is the feed alone ----------
  check((await herval.post("/api/agents/claude/follow", { follow: true })).status === 400 && (await alice.post("/api/agents/claude/follow", { follow: "yes" })).status === 400, "nobody follows their own agent, and following is on, off or as you follow its owner");
  const off = await alice.post("/api/agents/claude/follow", { follow: false });
  check(off.status === 200 && off.follow?.on === false && off.follow.set === "off", "alice turns Claude off");
  check((await sees(alice, "sess-a")) && !(await inFeed(alice, "sess-a")), "she still sees its thread, out of her feed");
  const back = await alice.post("/api/agents/claude/follow", { follow: null });
  check(back.follow?.on === true && back.follow.set === null && (await inFeed(alice, "sess-a")), "as she follows herval again: back in her feed");
  check((await alice.post("/api/people/herval/follow", { follow: false })).contact?.following === false && !(await inFeed(alice, "sess-a")) && (await sees(alice, "sess-a")), "she stops following herval: out of her feed, still hers to see");
  check((await alice.post("/api/agents/claude/follow", { follow: true })).follow?.on === true && (await inFeed(alice, "sess-a")), "following Claude alone puts its threads back");
  check((await bob.post("/api/people/herval/follow", { follow: true })).status === 409, "bob can't follow someone who isn't his contact");
  await alice.post("/api/agents/claude/follow", { follow: null });
  await alice.post("/api/people/herval/follow", { follow: true });

  // ---------- a thread of your own (talk) ----------
  const talk = await herval.post("/api/talks", { text: "Why did signups drop Tuesday?", visibility: "public" });
  check(talk.status === 200 && (await until(async () => (await alice.get(`/api/q/thread/${talk.id}?n=5`)).records?.[`thread:${talk.id}`]))?.mine === false, "a public thread of his own, sent to no agent: alice reads it");
  check(await inFeed(alice, talk.id), "on her feed");
  check((await bob.get(`/api/q/thread/${talk.id}?n=5`)).status === 404 && !keys(await bob.get("/api/q/feed?filter=all&n=100")).includes(`thread:${talk.id}`), "bob doesn't");
  check((await alice.post(`/api/talks/${talk.id}/messages`, { text: "hi" })).status !== 200, "and only herval writes in it");

  // ---------- a page, a group, a task ----------
  const page = (await herval.post("/api/pages", { title: "Cloud costs", emoji: "💸" })).id;
  check(!(await shows(alice, `/api/pages/${page}`)), "a new page is private");
  check((await herval.post(`/api/pages/${page}/visibility`, { visibility: "followers" })).status === 400, "a page's level is one of the two");
  check((await herval.post(`/api/pages/${page}/visibility`, { visibility: "public" })).status === 200 && (await shows(alice, `/api/pages/${page}`)) && !(await shows(bob, `/api/pages/${page}`)) && !(await shows(nobody, `/api/pages/${page}`)), "public: alice sees it, bob doesn't, nor someone signed out");
  check((await stateOf(alice.get)).pages?.some((p) => p.id === page), "it's among the pages she sees");

  const group = (await herval.post("/api/groups", { name: "Platform", emoji: "🧱", agents: ["claude"] })).id;
  const empty = (await herval.post("/api/groups", { name: "Billing", emoji: "🧾", agents: [] })).id;
  check(!(await shows(alice, `/api/groups/${group}`)), "a new group is private");
  check((await herval.post(`/api/groups/${group}/visibility`, { visibility: "public" })).status === 200 && (await shows(alice, `/api/groups/${group}`)) && !(await shows(bob, `/api/groups/${group}`)), "public: alice sees the group, bob doesn't");
  check((await herval.post(`/api/groups/${empty}/visibility`, { visibility: "public" })).status === 200 && (await shows(alice, `/api/groups/${empty}`)), "a public group with no agent in it too: who sees it is whose contact you are");
  check((await alice.post(`/api/groups/${group}/visibility`, { visibility: "private" })).status !== 200, "and only herval changes who sees it");

  const task = (await herval.post("/api/tasks", { text: "Ship the importer" })).id;
  check(!(await shows(alice, `/api/tasks/${task}`)), "a new task is private");
  check((await herval.post(`/api/tasks/${task}/visibility`, { visibility: "public" })).status === 200 && (await shows(alice, `/api/tasks/${task}`)) && !(await shows(bob, `/api/tasks/${task}`)), "public: alice sees the task by its link, bob doesn't");
  check((await stateOf(herval.get)).tasks.find((t) => t.id === task)?.visibility === "public", "and herval's says so");
  check((await alice.post(`/api/tasks/${task}/done`)).status !== 200, "seeing it isn't ticking it off");

  // ---------- a workspace and its worktrees ----------
  const repo = path.join(HOME, "dev", "ledger");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const tree = path.join(repo, ".claude", "worktrees", "fix-totals");
  git(repo, "worktree", "add", "-q", "-b", "fix-totals", tree);
  fs.writeFileSync(path.join(tree, "totals.js"), "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  git(tree, "add", ".");
  git(tree, "commit", "-qm", "Fix the totals");
  const other = path.join(repo, ".claude", "worktrees", "rotate-keys");
  git(repo, "worktree", "add", "-q", "-b", "rotate-keys", other);
  fs.writeFileSync(path.join(other, "keys.js"), "export const keys = [];\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "Rotate the keys");
  // A thread that ran in the worktree, through Claude Code's hooks: its machine reads the folder's branches.
  const hook = (event, input) => spawnSync(process.execPath, [path.join(PLUGIN, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: "sess-d", cwd: tree, ...input }), env: { ...env, AGENTBOOK_URL: URL, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_CODE_ENTRYPOINT: "cli", AGENTBOOK_PID: "8104" }, encoding: "utf8", timeout: 15000 });
  hook("SessionStart", { source: "startup" });
  hook("UserPromptSubmit", { prompt: "Fix the totals" });
  hook("SessionEnd", { reason: "other" });
  await until(async () => (await stateOf(herval.get)).sessions.some((x) => x.id === "sess-d"));
  const made = await herval.post("/api/workspaces", { folder: { path: fs.realpathSync(repo) }, name: "ledger" }); // as the machine lists it
  const W = made.id;
  check(made.status === 200 && W, "herval adds the repo's folder as a workspace");
  const parts = async (who: Person) => (await who.get(`/api/workspaces/${W}`)).parts || [];
  await until(async () => (await parts(herval)).some((x) => x.branch === "fix-totals"), 10000);
  const mine = await herval.get(`/api/workspaces/${W}`);
  check(mine.status === 200 && mine.workspace?.mine && mine.workspace.visibility === "private" && mine.parts?.some((x) => x.id === "b:fix-totals") && mine.parts.some((x) => x.id === "b:rotate-keys"), "its owner reads it, private, with its two worktrees");
  check((await alice.get(`/api/workspaces/${W}`)).status === 404 && (await bob.get(`/api/workspaces/${W}`)).status === 404 && (await nobody.get(`/api/workspaces/${W}`)).status !== 200, "a private workspace is nobody else's to see");
  check((await herval.post(`/api/workspaces/${W}/visibility`, { visibility: "followers" })).status === 400 && (await alice.post(`/api/workspaces/${W}/visibility`, { visibility: "public" })).status !== 200, "its level is one of the two, and its owner's");

  check((await herval.post(`/api/workspaces/${W}/visibility`, { visibility: "public" })).status === 200, "herval makes it public");
  const hers = await alice.get(`/api/workspaces/${W}`);
  check(hers.status === 200 && hers.workspace?.name === "ledger" && hers.workspace.mine === false && hers.workspace.owner === "herval" && hers.parts?.length === 2, "alice sees it, its name, and its worktrees (as the workspace)");
  check(!hers.raw.includes(HOME) && !("folders" in (hers.workspace || {})), "never its folders");
  check((await bob.get(`/api/workspaces/${W}`)).status === 404, "bob doesn't");
  const q = `part=${encodeURIComponent("b:fix-totals")}`;
  const wt = await alice.get(`/api/workspaces/${W}/worktree?${q}`);
  check(wt.status === 200 && wt.branch === "fix-totals" && wt.committed?.some((f) => f.path === "totals.js") && !("root" in wt) && !("worktree" in wt) && !wt.raw.includes(HOME), "she opens a worktree of it, read only: its commit and files, not where it is");
  const diff = await alice.get(`/api/workspaces/${W}/worktree/diff?${q}&path=totals.js&scope=committed`);
  check(diff.status === 200 && JSON.stringify(diff).includes("reduce"), "and a file's diff");
  check((await bob.get(`/api/workspaces/${W}/worktree?${q}`)).status === 404, "bob can't");
  check(((await alice.get("/api/people/herval")).workspaces || []).some((w) => w.id === W) && !((await bob.get("/api/people/herval")).workspaces || []).some((w) => w.id === W), "it's on herval's profile for alice, not for bob");

  // One worktree public in a private workspace; another private in a public one.
  await herval.post(`/api/workspaces/${W}/visibility`, { visibility: "private" });
  check((await herval.post(`/api/workspaces/${W}/visibility`, { visibility: "public", branch: "fix-totals" })).status === 200, "herval makes one worktree public in his private workspace");
  const alices = await alice.get(`/api/workspaces/${W}`);
  check(alices.status === 200 && alices.workspace?.name === null && alices.parts?.map((x) => x.id).join() === "b:fix-totals" && alices.parts[0].visibility === "public" && !alices.threads?.length, "alice sees that worktree, not the workspace's name, its other worktree or its threads");
  check((await alice.get(`/api/workspaces/${W}/worktree?${q}`)).status === 200 && (await alice.get(`/api/workspaces/${W}/worktree?part=${encodeURIComponent("b:rotate-keys")}`)).status === 404, "she opens it, not the other one");
  check((await bob.get(`/api/workspaces/${W}/worktree?${q}`)).status === 404 && (await nobody.get(`/api/workspaces/${W}/worktree?${q}`)).status !== 200, "nor bob, nor someone signed out");
  await herval.post(`/api/workspaces/${W}/visibility`, { visibility: "public" });
  await herval.post(`/api/workspaces/${W}/visibility`, { visibility: "private", branch: "rotate-keys" });
  const pub = await alice.get(`/api/workspaces/${W}`);
  check(pub.workspace?.name === "ledger" && pub.parts?.some((x) => x.id === "b:fix-totals") && !pub.parts.some((x) => x.id === "b:rotate-keys"), "a private worktree in a public workspace: she sees the workspace, not that one");
  check((await herval.post(`/api/workspaces/${W}/visibility`, { visibility: null, branch: "fix-totals" })).status === 200 && (await herval.get(`/api/workspaces/${W}`)).parts?.find((x) => x.id === "b:fix-totals")?.visibility === "public", "a worktree set back follows its workspace again");

  // ---------- people on a private thread ----------
  check((await herval.post("/api/threads/sess-b/people", { user: "bob" })).status === 409, "herval can't put bob on a thread: only a contact goes on something");
  check((await alice.post("/api/threads/sess-b/people", { user: "alice" })).status === 404, "and nobody but its owner puts people on it");
  await bob.post("/api/people/herval/contact", { act: "ask" });
  check((await herval.post("/api/people/bob/contact", { act: "no" })).status === 200 && !(await herval.get("/api/contacts")).asks?.length && !(await sees(bob, "sess-a")), "herval says no to bob: no contact, the ask gone");
  await bob.post("/api/people/herval/contact", { act: "ask" });
  check((await bob.post("/api/people/herval/contact", { act: "take_back" })).status === 200 && !(await herval.get("/api/contacts")).asks?.length, "bob asks again, then takes it back");
  await herval.post("/api/people/bob/contact", { act: "ask" });
  await bob.post("/api/people/herval/contact", { act: "yes" });
  check((await sees(bob, "sess-a")) && !(await sees(bob, "sess-b")), "herval asks bob, bob says yes: he sees the public thread, not the private one");
  const put = await herval.post("/api/threads/sess-b/people", { user: "bob" });
  check(put.status === 200 && put.people?.map((p) => p.user).join() === "bob", "herval puts bob on his private thread");
  check((await sees(bob, "sess-b")) && (await shows(bob, "/api/sessions/sess-b/steps")) && (await bob.get("/api/sessions/sess-b")).shared === true, "bob sees it and its work, marked as let in");
  check(!(await sees(alice, "sess-b")), "alice, a contact he didn't put on it, doesn't");
  check((await herval.get("/api/sessions/sess-b")).people?.some((p) => p.user === "bob") && !("people" in (await bob.get("/api/sessions/sess-b"))), "herval's thread lists who's on it; bob's copy doesn't");
  check(((await stateOf(bob.get)).added || []).some((x) => x.kind === "thread" && x.id === "sess-b" && x.by === "herval"), "it's on bob's bell");
  const kiteTold = (await req("GET", "/api/procs/box-2/context")).text || "";
  check(kiteTold.includes("Who sees this thread: only herval; and @bob, whom herval put on it, sees it with its steps and files"), "the thread is told who's on it");
  check((await herval.post("/api/threads/sess-b/people", { user: "bob", remove: true })).people?.length === 0 && !(await sees(bob, "sess-b")), "herval takes bob off: he doesn't see it any more");

  // ---------- removing a contact ----------
  await herval.post(`/api/tasks/${task}/visibility`, { visibility: "private" });
  check((await herval.post(`/api/tasks/${task}/people`, { user: "alice" })).status === 200 && (await shows(alice, `/api/tasks/${task}`)), "herval puts alice on his task, private now");
  await herval.post("/api/threads/sess-b/people", { user: "alice" });
  check(await sees(alice, "sess-b"), "and on his private thread");
  const gone = await alice.post("/api/people/herval/contact", { act: "remove" });
  check(gone.status === 200 && !gone.contact?.contact, "alice removes herval");
  check(!(await sees(alice, "sess-a")) && (await alice.get(`/api/q/thread/${talk.id}?n=5`)).status === 404 && !(await shows(alice, `/api/pages/${page}`)) && !(await shows(alice, `/api/groups/${group}`)) && (await alice.get(`/api/workspaces/${W}`)).status === 404, "she no longer sees his public things");
  check(!(await sees(alice, "sess-b")) && !(await shows(alice, `/api/tasks/${task}`)), "and she's off everything he put her on");
  check(!(await herval.get(`/api/tasks/${task}`)).people?.some((p) => p.user === "alice") && !(await herval.get("/api/sessions/sess-b")).people?.length, "his task and thread say so");
  check(!(await herval.get("/api/contacts")).contacts?.some((c) => c.user === "alice") && (await herval.get("/api/contacts")).contacts?.some((c) => c.user === "bob"), "she's off his contacts; bob is still there");
  check((await alice.post("/api/agents/claude/follow", { follow: true })).status === 404, "and there's nothing of his for her to follow");
} finally {
  server.kill();
  await sleep(200);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
