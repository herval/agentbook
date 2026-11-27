#!/usr/bin/env node
// Groups: a space many agents share. Threads in a group are told about it (its brief, the other threads in it,
// its notes and files) when they start, and hear what changed in it with the next message they get anyway, never
// on their own. Its files are a folder every agent in it writes, each change a version, credited to whoever made
// it. Its owner's tasks and WIP (branches, pull requests) can be in it, and its threads are told them. It's private,
// or public like a page: others see
// what it is and its files, and only the threads in it they'd see anyway. It all survives a restart.
// Run: node test/groups.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPath, groupId } from "../plugin/shared/groups.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-groups-"));
const PORT = testPort(4800);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200", AGENTBOOK_GROUP_SCAN_MS: "300" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_PROC"]) delete env[k];
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
const until = async (fn: () => unknown, ms = 4000): Promise<boolean> => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
// What a thread takes when a prompt starts (the hook asks with news=1), as text.
const prompted = async (a) => ((await a.get("/events?ack=1&news=1")).events || []).map((e) => e.event.text || e.event.type).join("\n");

let server;
async function start() {
  server = spawnAgentbook({ env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stop() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}

// ---------- the parts that need no server ----------
check(groupId("agentbook 0.4", () => false) === "agentbook-0-4" && groupId("agentbook 0.4", (id) => id === "agentbook-0-4") === "agentbook-0-4-2", "a group's id comes from its name, and the next with that name gets a number");
check(cleanPath("notes/plan.md") === "notes/plan.md" && cleanPath("./a//b.md") === "a/b.md" && cleanPath("../x") === null && cleanPath("a/../../x") === null && cleanPath(".env") === null && cleanPath("") === null, "a file's path stays inside the group's folder, and nothing hidden");

await start();
try {
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "heron", agent: "Codex", kind: "codex", session_id: "sess-b", cwd: project } });
  await req("POST", "/api/hello", { body: { proc: "box-3", label: "gull", agent: "Claude", session_id: "sess-c", cwd: project } });
  const osprey = agent("box-1");
  const heron = agent("box-2");
  const gull = agent("box-3");
  await osprey.post("/post", { title: "Groups: the server side" });
  await heron.post("/post", { title: "Tasks in a sheet on phones" });

  // ---------- making one ----------
  const made = await owner.post("/api/groups", { name: "agentbook 0.4", emoji: "🚀", brief: "Ship 0.4 by Tuesday.\n- Land on main; never force-push.", agents: ["claude"] });
  const id = made.id;
  check(made.status === 200 && id === "agentbook-0-4", "its owner makes a group, with a name, an emoji, a brief and its agents");
  check((await alice.post("/api/groups", { name: "Mine" })).status === 403, "someone else can't make one on this machine");
  let g = (await stateOf(owner.get)).groups?.find((x) => x.id === id);
  check(g && g.emoji === "🚀" && g.posts === 0 && g.members.some((m) => m.agent === "claude"), "it's in its owner's state, with its members and no threads yet");
  check(!((await stateOf(alice.get)).groups || []).length && (await alice.get(`/api/groups/${id}`)).status === 404, "nobody else sees it");
  check(fs.existsSync(path.join(HOME, "cli", "groups", id)), "its folder is there, in agentbook's data folder");

  // ---------- threads join ----------
  check((await owner.post(`/api/groups/${id}/threads`, { post: "sess-a" })).status === 200, "its owner puts a thread in it");
  await owner.post(`/api/groups/${id}/threads`, { post: "sess-b" });
  g = (await stateOf(owner.get)).groups.find((x) => x.id === id);
  const sessions = (await stateOf(owner.get)).sessions;
  check(g.posts === 2 && sessions.find((s) => s.id === "sess-a")?.group === id && g.members.some((m) => m.agent === "codex"), "threads join it, and a thread's agent joins with it");
  check((await owner.get("/api/q/thread/sess-a")).records?.["thread:sess-a"]?.group === id, "a thread's page knows its group too (its group card)");

  // ---------- what a thread in it is told ----------
  const told = (await osprey.get("/context")).text || "";
  check(/This thread is in the group "agentbook 0\.4" \(http[^)]+#\/groups\/agentbook-0-4\), with herval, Claude/.test(told), "a thread in a group is told which group, with its link and who's in it");
  check(/The group's brief, from herval:\n  Ship 0\.4 by Tuesday\.\n  - Land on main; never force-push\./.test(told), "and the brief, word for word");
  check(/The other threads in it:\n  heron \(Codex\) "Tasks in a sheet on phones": idle\./.test(told) && !/osprey \(Claude\) "Groups/.test(told), "and the other threads in it and where each stands, not itself");
  check(told.includes(`are in ~`) || told.includes(`are in ${path.join(HOME, "cli", "groups", id)}`), "and where its files are");
  check(/ab_group_read/.test(told) && !/ab_group_note/.test(told), "and how to read the rest; agents leave no notes");
  check(!/in the group/.test((await gull.get("/context")).text || ""), "a thread in no group is told nothing about groups");

  // ---------- news rides along, never alone ----------
  await heron.post("/updates", { text: "Opened PR #52: Tasks in a sheet from the bell" });
  check(!((await osprey.get("/events?ack=1")).events || []).length, "what happens in the group doesn't make a message of its own (nothing to wake a thread for)");
  let news = await prompted(osprey);
  check(/From the group "agentbook 0\.4" since your last turn:\n  heron \(Codex\) joined the group: "Tasks in a sheet on phones"\.\n  heron \(Codex\): Opened PR #52/.test(news), "with the next prompt, a thread hears who joined and the others' results");
  check(!/From the group/.test(await prompted(osprey)), "and hears each thing once");
  check(!/Opened PR #52/.test(await prompted(heron)), "a thread doesn't hear its own news");
  await owner.post("/api/sessions/sess-a/messages", { text: "Keep going on the routes" });
  await owner.post(`/api/groups/${id}/notes`, { text: "Release is Tuesday, not Monday." });
  const msgs = ((await osprey.get("/events?ack=1")).events || []).map((e) => e.event);
  check(msgs.some((e) => e.type === "message") && msgs.some((e) => e.type === "group" && /herval left a note: Release is Tuesday/.test(e.text)), "a note the person leaves rides along with the next message a thread gets");

  // ---------- files ----------
  const w1 = await heron.post("/group/files", { path: "notes/plan.md", text: "# Plan\nv1" });
  check(w1.status === 200 && w1.v === 1 && fs.readFileSync(path.join(HOME, "cli", "groups", id, "notes", "plan.md"), "utf8") === "# Plan\nv1", "an agent writes a file with ab_group_write, into the folder, as v1");
  check((await heron.post("/group/files", { path: "../escape.md", text: "x" })).status === 400 && !fs.existsSync(path.join(HOME, "cli", "groups", "escape.md")), "and nothing outside the folder");
  const read = await osprey.get("/group?file=notes/plan.md");
  check(/notes\/plan\.md, v1, \d+ bytes, by heron \(Codex\):\n\n# Plan\nv1/.test(read.text || ""), "another thread reads it with ab_group_read, and who wrote it");
  check(/heron \(Codex\) added notes\/plan\.md \(v1\)/.test(await prompted(osprey)), "and hears it was added");
  fs.writeFileSync(path.join(HOME, "cli", "groups", id, "direct.md"), "written straight into the folder");
  const seen = await until(async () => (await owner.get(`/api/groups/${id}`)).file_list?.some((f) => f.path === "direct.md"));
  check(seen, "a file an agent writes straight into the folder becomes a version on its own");
  const direct = (await owner.get(`/api/groups/${id}`)).file_list.find((f) => f.path === "direct.md");
  check(direct?.by?.machine, "and with no thread's transcript that wrote it, it's credited to the machine");
  await owner.post(`/api/groups/${id}/files`, { path: "notes/plan.md", text: "# Plan\nv2 by hand" });
  const versions = (await owner.get(`/api/groups/${id}/versions?path=notes/plan.md`)).versions || [];
  check(versions.length === 2 && versions[0].v === 2 && versions[0].by?.user === "herval" && versions[1].by?.post === "sess-b", "every change is a version: who made it, a thread or a person");
  const restored = await owner.post(`/api/groups/${id}/files/restore`, { path: "notes/plan.md", v: 1 });
  const raw = await fetch(`${URL}/api/groups/${id}/file?path=notes/plan.md`, { headers: { cookie: owner.cookie } }).then((r) => r.text());
  check(restored.version?.v === 3 && restored.version?.restored === 1 && raw === "# Plan\nv1", "an older version is restored as a new one, and the folder has it again");
  check((await fetch(`${URL}/api/groups/${id}/file?path=notes/plan.md&v=2`, { headers: { cookie: owner.cookie } }).then((r) => r.text())) === "# Plan\nv2 by hand", "and every version stays readable");
  await owner.post(`/api/groups/${id}/files/delete`, { path: "direct.md" });
  check(!fs.existsSync(path.join(HOME, "cli", "groups", id, "direct.md")) && !(await owner.get(`/api/groups/${id}`)).file_list.some((f) => f.path === "direct.md"), "a file deleted leaves the folder and the list, its versions kept");
  check((await alice.get(`/api/groups/${id}/file?path=notes/plan.md`)).status === 404, "nobody else reads its files");

  // ---------- public or private ----------
  check((await alice.post(`/api/groups/${id}/visibility`, { visibility: "public" })).status === 404, "only its owner makes it public");
  check((await owner.post(`/api/groups/${id}/visibility`, { visibility: "public" })).status === 200, "its owner makes it public");
  check((await alice.get(`/api/groups/${id}`)).status === 404, "someone who isn't his contact doesn't see it");
  // Public is for its owner's contacts.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  const pub = (await stateOf(alice.get)).groups?.find((x) => x.id === id);
  const pubD = await alice.get(`/api/groups/${id}`);
  check(pub?.mine === false && pub.owner === "herval" && pub.visibility === "public" && pubD.status === 200 && pubD.brief?.startsWith("Ship 0.4"), "then his contact sees it: its name, its brief and whose it is");
  check(!pubD.notes?.length && !pubD.told && !pubD.events?.length && pubD.dir === null && !pub.notes, "but not its notes, what happened in it, what its threads are told, or where its folder is");
  check(pubD.thread_ids?.length === 0 && pub.posts === 0 && !(await stateOf(alice.get)).sessions.some((s) => s.group === id), "nor the threads in it, while they're private");
  await owner.post("/api/sessions/sess-a/visibility", { visibility: "public" });
  check((await stateOf(alice.get)).sessions.find((s) => s.id === "sess-a")?.group === id && (await alice.get(`/api/groups/${id}`)).thread_ids?.join() === "sess-a", "a thread in it that's public itself shows in it");
  const theirs = await alice.get(`/api/groups/${id}/file?path=notes/plan.md`);
  const theirVersions = (await alice.get(`/api/groups/${id}/versions?path=notes/plan.md`)).versions || [];
  check(theirs.status === 200 && theirs.text === "# Plan\nv1" && theirVersions.length === 3, "they read its files, and their versions");
  check(theirVersions.at(-1).by?.post === null && theirVersions.at(-1).by?.agent === null && !theirVersions.some((v) => v.sha), "without which private thread or agent wrote one");
  check((await alice.post(`/api/groups/${id}/files`, { path: "x.md", text: "x" })).status === 404 && (await alice.post(`/api/groups/${id}/notes`, { text: "hi" })).status === 404 && (await alice.post(`/api/groups/${id}`, { name: "Mine now" })).status === 404, "only its owner changes it");
  check(/The group is public: its owner's contacts see/.test((await osprey.get("/context")).text || ""), "its threads are told it's public, to whom");
  await owner.post(`/api/groups/${id}/visibility`, { visibility: "private" });
  check((await alice.get(`/api/groups/${id}`)).status === 404 && !((await stateOf(alice.get)).groups || []).length && !(await stateOf(alice.get)).sessions.find((s) => s.id === "sess-a")?.group, "made private again, his contact doesn't see it, or that a thread is in it");

  // ---------- ab_group_read ----------
  const overview = (await osprey.get("/group")).text || "";
  check(/Other threads \(1\):\n  heron \(Codex\) "Tasks in a sheet on phones": idle\. Latest: Opened PR #52/.test(overview) && /Files \(1\)/.test(overview) && /notes\/plan\.md  v3/.test(overview) && /Release is Tuesday/.test(overview), "ab_group_read gives the group: its threads, notes and files");
  const one = (await osprey.get("/group?thread=heron")).text || "";
  check(/^heron \(Codex\) "Tasks in a sheet on phones": idle\./.test(one) && /Results:\n  .*Opened PR #52/.test(one), "and one thread in it, as the others read it");
  check((await gull.get("/group")).status === 404, "a thread in no group is told it isn't in one");

  // ---------- its tasks ----------
  const tk = await owner.post("/api/tasks", { text: "Write the 0.4 release notes", group: id });
  check(tk.status === 200 && ((await stateOf(owner.get)).tasks || []).find((t) => t.id === tk.id)?.group === id, "a task goes in a group, as one goes on a page");
  check(new RegExp(`The group's tasks \\(1 open[^\\n]*\\n  \\[${tk.id}\\] Write the 0\\.4 release notes`).test((await osprey.get("/context")).text || ""), "a thread in the group is told its tasks, by id");
  check(/herval added a task: Write the 0\.4 release notes/.test(await prompted(osprey)), "and hears when one is added");
  check(((await osprey.get("/tasks")).open || []).find((t) => t.id === tk.id)?.for === "group" && /Tasks \(1 open\):\n  \[k/.test((await osprey.get("/group")).text || ""), "ab_tasks puts the group's tasks first after its own, and ab_group_read lists them");
  await osprey.post("/tasks/done", { ids: [tk.id] });
  check(/osprey \(Claude\) ticked off a task: Write the 0\.4/.test(await prompted(heron)) && !/ticked off/.test(await prompted(osprey)), "a thread ticks one off, and the others hear it");
  const todo = await heron.post("/todos", { text: "Approve the phone build", later: true });
  check(((await stateOf(owner.get)).tasks || []).find((t) => t.id === todo.id)?.group === id, "a to-do for later a thread in the group leaves goes in the group");
  const own = await heron.post("/todos", { text: "Restart the simulator on the build Mac" });
  const ownRow = ((await stateOf(owner.get)).tasks || []).find((t) => t.id === own.id);
  check(own.thread && ownRow?.scope === "thread" && !ownRow.group && !/Restart the simulator/.test(await prompted(osprey)), "one about its own work stays on its thread, out of the group: the others don't hear it");
  const sneaky = await alice.post("/api/tasks", { text: "In herval's group", group: id });
  check(sneaky.status === 200 && !((await stateOf(alice.get)).tasks || []).find((t) => t.id === sneaky.id)?.group, "nobody else puts a task in it");

  // ---------- its WIP ----------
  const pr = { id: "ws1-pr61", kind: "pr", title: "Tasks in a sheet on phones", ref: "#61", repo: "app", url: "https://github.com/acme/app/pull/61" };
  check((await owner.post(`/api/groups/${id}/wips`, { wip: pr })).status === 200 && (await owner.get(`/api/groups/${id}`)).wips?.[0]?.id === "ws1-pr61", "a pull request goes in a group");
  check(/The branches and pull requests herval put in the group:\n  pull request #61 "Tasks in a sheet on phones" \(https:\/\/github\.com\/acme\/app\/pull\/61\)/.test((await osprey.get("/context")).text || ""), "a thread in the group is told its WIP");
  check(/herval put pull request #61 "Tasks in a sheet on phones" \(https:/.test(await prompted(osprey)), "and hears when one is put in it");
  await owner.post(`/api/groups/${id}/wips`, { wip: { id: "0a1b2c3d4e5f", kind: "branch", title: "Retry the sync", ref: "fix-sync", repo: "erp-sync" } });
  check(/WIP herval put in it \(2\):\n  pull request #61[^\n]*\n  the branch fix-sync in erp-sync \("Retry the sync"\)/.test((await osprey.get("/group")).text || ""), "and a branch; ab_group_read lists them");
  check((await alice.post(`/api/groups/${id}/wips`, { wip: pr })).status === 404 && (await owner.post(`/api/groups/${id}/wips`, { wip: { id: "no spaces" } })).status === 400, "nobody else puts one in it, and it says which");
  await owner.post(`/api/groups/${id}/visibility`, { visibility: "public" });
  const peek = await alice.get(`/api/groups/${id}`);
  check(peek.status === 200 && !("wips" in peek) && !((await stateOf(alice.get)).groups || []).some((g) => "wips" in g), "someone who sees it public doesn't see its WIP");
  await owner.post(`/api/groups/${id}/visibility`, { visibility: "private" });
  await owner.post(`/api/groups/${id}/wips`, { wip: { id: "0a1b2c3d4e5f" }, remove: true });
  check((await owner.get(`/api/groups/${id}`)).wips?.length === 1 && /herval took the branch fix-sync in erp-sync \("Retry the sync"\) out of the group/.test(await prompted(osprey)), "one taken out is gone, and its threads hear so, by what it was");

  // ---------- starting a thread in it ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-new");
  const launched = await owner.post("/api/launch", { prompt: "Write the release notes", agent: "claude", group: id });
  const call = fs
    .readFileSync(path.join(FAKE, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((c) => c.args.includes("--bg"))
    .at(-1);
  const dir = path.join(HOME, "cli", "groups", id);
  check(launched.status === 200 && call.args.includes("--add-dir") && call.args[call.args.indexOf("--add-dir") + 1] === dir && fs.realpathSync(call.cwd) === fs.realpathSync(dir), "a thread started in a group can write its folder, and with no workspace it starts there");
  await req("POST", "/api/hello", { body: { proc: "box-4", label: "wren", agent: "Claude", session_id: "sess-new", cwd: dir, launch: launched.lid } });
  check((await stateOf(owner.get)).sessions.find((s) => s.id === "sess-new")?.group === id && /This thread is in the group "agentbook 0\.4"/.test((await agent("box-4").get("/context")).text || ""), "and it joins the group when it starts, and is told so");
  check(!/Opened PR #52|Release is Tuesday/.test(await prompted(agent("box-4"))), "what happened before it joined is context, not news");

  // ---------- leaving ----------
  await owner.post(`/api/groups/${id}/threads`, { post: "sess-b", remove: true });
  check(!(await stateOf(owner.get)).sessions.find((s) => s.id === "sess-b")?.group && !/in the group/.test((await heron.get("/context")).text || "") && /heron \(Codex\) left the group/.test(await prompted(osprey)), "a thread taken out of it stops hearing from it, and the others hear it left");
  await owner.post("/api/groups", { name: "Reliability" });
  await owner.post("/api/groups/reliability/threads", { post: "sess-c" });
  await owner.post("/api/groups/reliability/threads", { post: "sess-a" });
  check((await stateOf(owner.get)).sessions.find((s) => s.id === "sess-a")?.group === "reliability", "a thread is in one group at most: adding it to another moves it");
  await prompted(osprey);
  await owner.post("/api/groups/reliability/wips", { wip: pr });
  check(!(await owner.get(`/api/groups/${id}`)).wips?.length && (await owner.get("/api/groups/reliability")).wips?.[0]?.id === "ws1-pr61" && /herval put pull request #61/.test(await prompted(osprey)) && (await owner.get(`/api/groups/${id}`)).events?.some((e) => /moved pull request #61 "Tasks in a sheet on phones" \(https:[^)]*\) to the group "Reliability"/.test(e.text)), "and so is a WIP: put in another, it moves, and the one it left says where");

  // ---------- it all survives a restart ----------
  await sleep(500);
  await stop();
  await start();
  const back = await owner.get(`/api/groups/${id}`);
  check(back.name === "agentbook 0.4" && back.notes?.length === 1 && back.file_list?.some((f) => f.path === "notes/plan.md" && f.v === 3) && back.events?.length > 3, "groups, their notes, files and what happened survive a restart");
  check(((await owner.get(`/api/groups/${id}/versions?path=notes/plan.md`)).versions || []).length === 3, "and every version");
  check((await stateOf(owner.get)).sessions.find((s) => s.id === "sess-a")?.group === "reliability" && /This thread is in the group "Reliability"/.test((await osprey.get("/context")).text || ""), "and which group each thread is in");
  check((await owner.get("/api/groups/reliability")).wips?.map((w) => w.id).join() === "ws1-pr61", "and which WIP");
} finally {
  await stop().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
