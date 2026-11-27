#!/usr/bin/env node
// @task and @group in what you write to an agent: the composer's and a thread's box list your tasks and groups with
// the pages, and naming one puts the thread on that task, or in that group. A thread you start goes on each task
// its prompt names and starts in the first group it names (unless you picked one as where it goes); a reply that
// names them puts its thread on them, or moves it into the group. Its agent is told what each one is, and that its
// thread is on it or in it. A title taken from the prompt reads their names.
// Run: node test/mention-links.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUP_MENTION, groupsIn, MENTION, mentionNote, mentionsIn, TASK_MENTION, tasksIn } from "../plugin/shared/mentions.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";
import type { Page } from "../plugin/shared/types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-mention-links-"));
const PORT = testPort(4900);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_PROC", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });
const until = async (fn: () => unknown, ms = 5000): Promise<boolean> => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
// What a thread takes when a prompt starts (the hook asks with news=1), as text.
const prompted = async (a) => ((await a.get("/events?ack=1&news=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");
// All the arguments of each start of the fake claude, as one text.
const starts = () =>
  fs
    .readFileSync(path.join(FAKE, "calls.jsonl"), "utf8")
    .split("\n")
    .slice(0, -1)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args.includes("--bg"))
    .map((c) => JSON.stringify(c.args));
// The start that says `text`, once the machine has made it: not the last one, as a thread being resumed can come after.
const startSaying = async (text) => {
  await until(() => starts().some((c) => c.includes(text)));
  return starts().find((c) => c.includes(text)) || "";
};

// ---------- the parts that need no server ----------
const tasks = { k1abc: { id: "k1abc", text: "Fix the login loop", note: "It loops after a password reset.\nSee the logs.", done: false }, k2def: { id: "k2def", text: "Old one", done: true } };
const groups = { hive: { id: "hive", name: "Hive" }, "agentbook-0-4": { id: "agentbook-0-4", name: "agentbook 0.4" } };
const blankPage = (id: string): Page => ({ id, title: id, emoji: "", color: null, about: "", visibility: "private", by: { user: "herval" }, contributors: [], widgets: [], version: 1, created: "2026-11-01T00:00:00.000Z", updated: "2026-11-01T00:00:00.000Z", archived: null });
const said = "on @task:k1abc and @group:hive (@task:k1abc again), not @task:nope or @group:nope, @group:agentbook-0-4.";
check(tasksIn(said, tasks).map((x) => x.ref).join(" ") === "task:k1abc" && groupsIn(said, groups).map((x) => x.ref).join(" ") === "group:hive group:agentbook-0-4", "a message names each task and group once, in order, and nothing that isn't there");
check(mentionsIn("@task:k1abc @group:hive", { task: blankPage("task"), group: blankPage("group") }).length === 0 && ![..."@task:k1abc @group:hive".matchAll(MENTION)].length, "a task's or a group's token is never a page's");
check([..."a@task:k1abc, x@group:hive".matchAll(TASK_MENTION)].length === 0 && [..."a@task:k1abc, x@group:hive".matchAll(GROUP_MENTION)].length === 0, "inside a word it's text, as an email address is");
const note = mentionNote("look at @task:k1abc with @group:hive and @group:agentbook-0-4", {}, Date.now(), {}, { tasks: { ...tasks, k1abc: { ...tasks.k1abc, here: true } }, groups: { ...groups, hive: { ...groups.hive, here: true } } });
check(
  note === 'Named:\n- @task:k1abc: the task "Fix the login loop" on their Tasks (It loops after a password reset. See the logs.); this thread is on it now (ab_tasks lists it first; tick it off there once it\'s done)\n- @group:hive: the group "Hive"; this thread is in it now (ab_group_read has its brief, its threads and its files)\n- @group:agentbook-0-4: the group "agentbook 0.4"',
  "the agent's note says what each task and group is, and which its thread is on or in",
);
check(mentionNote("@task:k2def", {}, Date.now(), {}, { tasks }) === 'Named:\n- @task:k2def: the task "Old one" on their Tasks, done', "a done task says so, and one its thread isn't on says nothing of it");

await (async () => {
  const server = spawnAgentbook({ env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  try {
    const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
    const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
    await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
    const osprey = agent("box-1");
    await osprey.post("/post", { title: "Look into sign-in" });
    await prompted(osprey);
    const hive = (await owner.post("/api/groups", { name: "Hive" })).id;
    const ops = (await owner.post("/api/groups", { name: "Ops" })).id;
    const login = (await owner.post("/api/tasks", { text: "Fix the login loop", note: "It loops after a password reset." })).id;
    const docs = (await owner.post("/api/tasks", { text: "Write the sign-in docs" })).id;
    const theirs = (await alice.post("/api/tasks", { text: "Alice's own" })).id;
    check(hive === "hive" && /^[a-z0-9]+$/.test(login), "a group's id and a task's are what the tokens take");

    // ---------- starting a thread that names them ----------
    fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-new");
    const launched = await owner.post("/api/launch", { prompt: `@task:${login} keeps failing, look into it with @group:${hive} (not @task:${theirs})`, agent: "claude", root: project });
    check(launched.status === 200 && !!launched.lid, "it starts");
    const started = await startSaying("keeps failing");
    check(started.includes(`@task:${login}: the task \\"Fix the login loop\\" on their Tasks (It loops after a password reset.); this thread is on it now`) && started.includes(`@group:${hive}: the group \\"Hive\\"; this thread is in it now`), "its agent's first prompt says what the task and the group are, and that its thread is on and in them");
    check(!started.includes("Alice's own") && !started.includes(`@task:${theirs}:`), "someone else's task it names is just text");
    check(started.includes("Sent from herval's Tasks") || started.includes("Fix the login loop"), "and it's told the task it's for");
    await req("POST", "/api/hello", { body: { proc: "box-4", label: "wren", agent: "Claude", session_id: "sess-new", cwd: project, launch: launched.lid } });
    const onLogin = async () => (await stateOf(owner.get)).tasks.find((t) => t.id === login);
    check(await until(async () => (await onLogin())?.posts?.some((e) => e.post === "sess-new")), "the task it names follows the thread it starts");
    check(await until(async () => (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-new")?.group === hive), "and it starts in the group it names");
    check(/This thread is in the group "Hive"/.test((await agent("box-4").get("/context")).text || ""), "and is told so, as one started in it is");
    check((await onLogin()).sent.filter((e) => e.launch === launched.lid).length === 1 && (await owner.post(`/api/tasks/${login}/send`, { launch: launched.lid, agent: "claude" })).status === 200 && (await onLogin()).sent.filter((e) => e.launch === launched.lid).length === 1, "the page sending it from the task too doesn't put it on twice");
    // The fake claude has no transcript, so the thread takes its prompt from the first message it gets here.
    await owner.post("/api/sessions/sess-new/messages", { text: `@task:${login} keeps failing, look into it with @group:${hive}` });
    const title = (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-new")?.title || "";
    check(title.startsWith("Fix the login loop keeps failing, look into it with Hive") && !/@task:|@group:/.test(title), `a title taken from its prompt reads their names ("${title}")`);
    check(((await owner.get("/api/sessions/sess-new")).title || "").startsWith("Fix the login loop keeps failing"), "on the thread's own page too");
    check(!(await stateOf(alice.get)).tasks.some((t) => t.id === login), "alice doesn't see herval's task");

    // ---------- a group picked as where it goes wins ----------
    fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-ops");
    const picked = await owner.post("/api/launch", { prompt: `Tidy up, see @group:${hive}`, agent: "claude", root: project, group: ops });
    await req("POST", "/api/hello", { body: { proc: "box-5", label: "finch", agent: "Claude", session_id: "sess-ops", cwd: project, launch: picked.lid } });
    check(await until(async () => (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-ops")?.group === ops), "a thread started with a group picked starts in that one, whatever group it names");
    const tidy = await startSaying("Tidy up");
    check(tidy.includes("Tidy up") && !tidy.includes("this thread is in it now"), "and its agent isn't told it's in the one it names");

    // ---------- a reply that names them ----------
    const r = await owner.post("/api/sessions/sess-a/messages", { text: `this is for @task:${docs}, and @group:${hive} should know` });
    check(r.status === 200, "the reply goes");
    const st = await stateOf(owner.get);
    check(st.tasks.find((t) => t.id === docs)?.posts?.some((e) => e.post === "sess-a"), "a task a reply names gets its thread");
    check(st.sessions.find((s) => s.id === "sess-a")?.group === hive, "and the group it names gets the thread");
    const heard = await prompted(osprey);
    check(heard.includes(`@task:${docs}: the task "Write the sign-in docs" on their Tasks; this thread is on it now`) && heard.includes(`@group:${hive}: the group "Hive"; this thread is in it now`), "its agent hears what they are, and that its thread is on and in them now");
    await owner.post("/api/sessions/sess-a/messages", { text: `and @group:${ops} too` });
    check((await stateOf(owner.get)).sessions.find((s) => s.id === "sess-a")?.group === ops, "naming another group moves it there: a thread is in one group at most");
    await owner.post("/api/sessions/sess-a/messages", { text: `again @task:${docs}` });
    check((await stateOf(owner.get)).tasks.find((t) => t.id === docs).posts.filter((e) => e.post === "sess-a").length === 1, "naming a task it's on already leaves it as it is");
    check((await alice.post("/api/sessions/sess-a/messages", { text: `@task:${theirs} @group:${hive}` })).status !== 200 && !(await stateOf(alice.get)).tasks.find((t) => t.id === theirs)?.posts?.length, "someone else can't put herval's thread anywhere");
  } finally {
    const gone = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await gone;
  }
})();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
