#!/usr/bin/env node
// Two machines, one page: a hub (agentbook-server, with its own machine's CLI in the same process) and a laptop
// whose agentbook-cli logs in to it, each with its own data folder and port. Sessions register with the laptop's
// CLI, which sends what they do to the hub as ops; the hub shows them, and what you do there goes to the laptop
// as commands.
// Run: node test/hub.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-hub-"));
// Both machines share the test's folders with their server (their gates).
for (const m of ["hub", "laptop"]) {
  fs.mkdirSync(path.join(BASE, m, "cli"), { recursive: true });
  fs.writeFileSync(path.join(BASE, m, "cli", "gate.json"), JSON.stringify({ folders: [BASE], starts_per_hour: 1000 }));
}
const HUB_PORT = testPort(4500);
const NODE_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const NODE = `http://127.0.0.1:${NODE_PORT}`;
const project = path.join(BASE, "dev", "app");
fs.mkdirSync(project, { recursive: true });
// A checkout of herval/app, which both machines find by its remote.
spawnSync("git", ["-C", project, "init", "-q", "-b", "main"]);
spawnSync("git", ["-C", project, "remote", "add", "origin", "git@github.com:herval/app.git"]);
const FAKE = path.join(BASE, "fake-claude");
fs.mkdirSync(FAKE);

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_TOKEN", "AGENTBOOK_URL"]) delete common[k];
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_CLONE_DIR: path.join(BASE, "hub", "clones") };
// The laptop's device token comes from connecting it, below.
const nodeEnv = { ...common, AGENTBOOK_PORT: String(NODE_PORT), AGENTBOOK_HOME: path.join(BASE, "laptop"), AGENTBOOK_MACHINE: "laptop", AGENTBOOK_CLONE_DIR: path.join(BASE, "laptop", "clones"), AGENTBOOK_HUB: HUB, AGENTBOOK_URL: NODE };

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
};
// Each server's sign-in cookie, sent with every request to it.
const jar: Record<string, string> = {};
const call = (base: string, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(jar[base] ? { cookie: jar[base] } : {}), ...(opts.headers || {}) } });
const get = async (base: string, p: string, headers = {}) => {
  const r = await call(base, p, { headers });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (base: string, p: string, body: unknown, headers = {}) => {
  const r = await call(base, p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
// The first account on a server, made on its own machine, signed in.
async function firstAccount(base: string, username: string) {
  const r = await fetch(base + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
  jar[base] = (r.headers.get("set-cookie") || "").split(";")[0];
  return r.ok;
}
// A request that looks like it came from another computer, by the name it uses for the hub.
const remote = (method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}) =>
  new Promise<{ status: number; cookie: string; body: string }>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: HUB_PORT, path: p, method, headers: { host: `hub.example:${HUB_PORT}`, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) } }, (r) => {
      let data = "";
      r.on("data", (d) => (data += d));
      r.on("end", () => resolve({ status: r.statusCode, cookie: (r.headers["set-cookie"]?.[0] || ""), body: data }));
    });
    req.end(body ? JSON.stringify(body) : undefined);
  });
const serve = (env: NodeJS.ProcessEnv) => spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 5000);
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf: Record<string, string> = {};
const hook = (event: string, input: { session_id?: string; [field: string]: unknown }, env?: NodeJS.ProcessEnv) => {
  if (input.session_id) sessionOf[env?.AGENTBOOK_PID] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ session_id: sessionOf[env?.AGENTBOOK_PID], ...input }), env: { ...nodeEnv, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", ...env }, encoding: "utf8", timeout: 15000 });
};
const HOST = os.hostname().split(".")[0];

const hub = serve(hubEnv);
let node: { kill(): unknown } = { kill() {} };
try {
  check(await healthy(HUB), "a hub starts");
  check(await firstAccount(HUB, "herval"), "its first account is made on the hub's own machine");
  // The hub's own machine has a post first, so its Claude is "claude" and the laptop's, which comes second, is
  // known with its machine's name in front.
  const hubSession = { AGENTBOOK_PID: "920009", AGENTBOOK_LABEL: "wren", AGENTBOOK_URL: HUB, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: hubEnv.AGENTBOOK_HOME };
  hook("SessionStart", { session_id: "hub-1", cwd: project, source: "startup" }, hubSession);
  hook("UserPromptSubmit", { prompt: "look at the hub", cwd: project }, hubSession);
  for (const k of ["AGENTBOOK_HUB", "AGENTBOOK_URL"]) delete nodeEnv[k];

  // ---------- from another computer: sign in ----------
  const anon = await remote("GET", "/api/q/side");
  check(anon.status === 401, "from another computer, the page needs signing in");
  const signIn = await remote("POST", "/api/auth/test-person", { body: { username: "herval" } });
  const elsewhere = await remote("GET", "/api/q/side", { cookie: signIn.cookie.split(";")[0] });
  check(signIn.status === 200 && /HttpOnly/.test(signIn.cookie) && /SameSite=Lax/.test(signIn.cookie) && elsewhere.status === 200, "signing in there gives a cookie the page can't read, and the page works");

  // ---------- connecting the laptop ----------
  const noToken = await get(HUB, "/api/cli/commands");
  const wrong = await post(HUB, "/api/cli/ops", { ops: [] }, { authorization: "Bearer nope" });
  check(noToken.status === 403 && wrong.status === 403, "a machine that isn't logged in is refused");
  const asked: Json = await (await fetch(HUB + "/api/devices/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "laptop" }) })).json();
  const early: Json = await (await fetch(`${HUB}/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).json();
  const waiting = await get(HUB, `/api/devices/request/${asked.code}`);
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(asked.code) && early.pending && waiting.name === "laptop", "a machine asks to connect with a code its person approves on the page");
  const approved = await post(HUB, "/api/devices/approve", { code: asked.code });
  const got: Json = await (await fetch(`${HUB}/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).json();
  const again = await fetch(`${HUB}/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`);
  check(approved.device?.name === "laptop" && got.token && got.user === "herval" && again.status === 404, "once approved, the machine gets its own token, once");
  // What a machine sends lands on its own posts, whatever it names: here, the hub's.
  const at = new Date().toISOString();
  await post(HUB, "/api/cli/ops", { ops: [{ kind: "post.update", seq: 1, at, args: { post: "hub-1", text: "from the laptop" } }] }, { authorization: `Bearer ${got.token}` });
  check(!(await get(HUB, "/api/sessions/hub-1")).updates?.length, "a machine's ops reach only its own posts: naming another machine's changes nothing there");
  Object.assign(nodeEnv, { AGENTBOOK_HUB: HUB, AGENTBOOK_URL: NODE, AGENTBOOK_HUB_TOKEN: got.token });
  node = serve(nodeEnv);
  check(await healthy(NODE), "the laptop starts, logged in");
  const page = await fetch(NODE + "/", { redirect: "manual" });
  check(page.status === 302 && page.headers.get("location") === `${HUB}/` && (await fetch(NODE + "/api/q/side")).status === 404, "the laptop has no page of its own: / sends you to the hub");

  // ---------- a session on the laptop shows on the hub ----------
  const env = { AGENTBOOK_PID: "920001", AGENTBOOK_LABEL: "kite" };
  hook("SessionStart", { session_id: "lap-1", cwd: project, source: "startup" }, env);
  hook("UserPromptSubmit", { prompt: "tidy the readme", cwd: project }, env);
  const seen = await until(async () => (await stateOf((p) => get(HUB, p))).sessions?.find((s) => s.id === "lap-1" && s.effective === "working"), 8000);
  const st = await stateOf((p) => get(HUB, p));
  check(seen?.machine === "laptop" && seen.agent === "laptop~claude" && seen.effective === "working" && seen.label === "kite", "a session on the laptop is a post on the hub, by Claude on the laptop");
  const here = st.agents.find((a) => a.id === "claude");
  const there = st.agents.find((a) => a.id === "laptop~claude");
  check(here?.machine === "hub" && here.sessions === 1 && there?.machine === "laptop" && there.name === "Claude" && there.sessions === 1, "Claude on each machine is its own profile, named with its machine");
  check(st.machines?.some((m) => m.name === "laptop" && m.online) && st.machines.some((m) => m.name === "hub" && m.here), "the hub lists its machines");
  const detail = await get(HUB, "/api/sessions/lap-1");
  check(detail.status === 200 && detail.id === "lap-1" && detail.machine === "laptop" && detail.messages.some((m) => m.text === "tidy the readme" && m.post === "lap-1"), "the hub has the post, with what was said, as the laptop sent it");
  const searched = (await get(HUB, "/api/q/feed?q=readme")).found?.posts?.["lap-1"];
  check(searched?.exact.includes("readme") && searched.hit.from === "human", "searching on the hub looks through the laptop's messages too");

  // ---------- acting on it from the hub ----------
  const sent = await post(HUB, "/api/sessions/lap-1/messages", { text: "use short sentences" });
  const ev = await until(async () => {
    const r = await get(NODE, `/api/procs/${HOST}-920001/events`);
    return r.events?.length && r;
  }, 6000);
  check(sent.status === 200 && ev.events?.some((e) => e.event.text === "use short sentences"), "a comment on the hub reaches the session on the laptop");
  await post(NODE, `/api/procs/${HOST}-920001/questions`, { title: "Keep the badges?", options: ["Yes", "No"] });
  const q = await until(async () => (await stateOf((p) => get(HUB, p))).questions?.find((x) => x.title === "Keep the badges?"), 6000);
  check(q?.post === "lap-1" && q.kind === "choice", "its questions show on the hub");
  const answer = await post(HUB, `/api/questions/${encodeURIComponent(q.id)}/answer`, { value: "No" });
  const answered = await until(async () => (await get(NODE, `/api/procs/${HOST}-920001/events`)).events?.find((e) => e.event.type === "answer" && e.event.value === "No"), 6000);
  const settled = await until(async () => (await get(HUB, "/api/sessions/lap-1")).questions?.find((x) => x.id === q.id && x.value === "No"), 6000);
  check(answer.status === 200 && answered && settled, "answering on the hub answers it on the laptop, which says so back");
  const up = await call(HUB, `/api/upload?draft=1&name=notes.txt`, { method: "POST", body: "some notes" }).then((r): Promise<Json> => r.json());
  await post(HUB, "/api/sessions/lap-1/messages", { text: "here", files: [up.id] });
  const withFile = await until(async () => (await get(HUB, "/api/sessions/lap-1")).messages.find((m) => m.text === "here"), 6000);
  const delivered = await until(async () => (await get(NODE, `/api/procs/${HOST}-920001/events`)).events?.find((e) => e.event.text === "here"), 6000);
  check(withFile?.files?.[0]?.name === "notes.txt" && withFile.files[0].id === up.id && fs.readFileSync(delivered?.event.files[0].path, "utf8") === "some notes", "files you attach on the hub go to the laptop with your message, fetched there");
  const dl = await call(HUB, `/api/files/${encodeURIComponent(up.id)}`);
  check(dl.ok && (await dl.text()) === "some notes", "and download from the hub");
  const widgetPage = await post(NODE, `/api/procs/${HOST}-920001/pages`, { title: "Calc", widgets: [{ id: "calc", type: "html", data: { html: "<p>on the laptop</p>" } }] });
  const fr = await call(HUB, `/api/pages/${widgetPage.id}/frame/calc`);
  const frCsp = fr.headers.get("content-security-policy") || "";
  check(fr.ok && (await fr.text()).includes("<p>on the laptop</p>") && /default-src 'none'/.test(frCsp) && !/allow-popups/.test(frCsp), "a widget of its own an agent on the laptop puts on a page comes from the hub with its frame's rules: no network");

  // ---------- starting a session on the laptop from the hub ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "lap-2");
  const launched = await post(HUB, "/api/launch", { prompt: "write the changelog", root: project, agent: "laptop~claude" });
  const started = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.args[0] === "write the changelog");
  const placeholder = await until(async () => (await stateOf((p) => get(HUB, p))).launches?.find((l) => l.id === launched.lid), 6000);
  check(launched.status === 200 && launched.lid && started?.env.AGENTBOOK_LAUNCH_ID === launched.lid && placeholder?.agent === "laptop~claude" && placeholder.machine === "laptop", "posting to Claude on the laptop starts the session on the laptop");

  // ---------- a task on the hub, sent to Claude on the laptop ----------
  const task = await post(HUB, "/api/tasks", { text: "Write the changelog" });
  await post(HUB, `/api/tasks/${task.id}/send`, { launch: launched.lid, agent: "laptop~claude" });
  hook("SessionStart", { session_id: "lap-2", cwd: project, source: "startup" }, { AGENTBOOK_PID: "920002", AGENTBOOK_LABEL: "plover", AGENTBOOK_LAUNCH_ID: launched.lid });
  const linked = await until(async () => (await stateOf((p) => get(HUB, p))).tasks?.find((t) => t.id === task.id)?.sent[0]?.post === "lap-2", 8000);
  check(task.status === 200 && linked && (await stateOf((p) => get(HUB, p))).tasks.find((t) => t.id === task.id).posts[0]?.post === "lap-2", "a task is kept on the hub, and one sent to Claude on the laptop follows the session it started there");
  const lapTasks = await get(NODE, `/api/procs/${HOST}-920002/tasks`);
  check(lapTasks.open?.[0]?.id === task.id && lapTasks.open[0].for === "post" && !lapTasks.hub_error, "an agent on the laptop reads its person's tasks on the hub, the one sent to it first");
  const tickedThere = await post(NODE, `/api/procs/${HOST}-920002/tasks/done`, { ids: [task.id] });
  const onHub = (await stateOf((p) => get(HUB, p))).tasks?.find((t) => t.id === task.id);
  check(tickedThere.results?.[0]?.ok && onHub?.done && onHub.done_by === "agent" && onHub.done_post === "lap-2", "and ticks it off there, as its post on the laptop");
  await post(HUB, `/api/tasks/${task.id}/done`, { done: false });
  const lapTodo = await post(NODE, `/api/procs/${HOST}-920002/todos`, { text: "Approve the laptop's release build", new: false });
  const todoOnHub = (await stateOf((p) => get(HUB, p))).tasks?.find((t) => t.id === lapTodo.id);
  check(lapTodo.status === 200 && todoOnHub?.from === "lap-2" && todoOnHub.posts[0]?.post === "lap-2", "a to-do an agent on the laptop leaves is a task on the hub, from its post there");
  const sameAgain = await post(NODE, `/api/procs/${HOST}-920002/todos`, { text: "Approve the release build on the laptop", new: false });
  check(sameAgain.same?.id === lapTodo.id && sameAgain.same.from === "plover", "and one that looks the same isn't added again: it hears which task has it");
  const unlinked = await post(NODE, `/api/procs/${HOST}-920002/tasks/link`, { ids: [task.id], linked: false });
  check(unlinked.results?.[0]?.ok && !(await stateOf((p) => get(HUB, p))).tasks.find((t) => t.id === task.id).posts.length, "an agent on the laptop unlinks its post from a task on the hub");
  const fromPage = await post(HUB, `/api/tasks/${task.id}/link`, { post: "lap-2" });
  check(fromPage.status === 200 && (await stateOf((p) => get(HUB, p))).tasks.find((t) => t.id === task.id).posts[0]?.post === "lap-2" && (await post(HUB, `/api/tasks/${task.id}/link`, { post: "nope" })).status === 404, "and the hub's page links a post on the laptop to a task");

  // ---------- the agent's profile spans machines ----------
  const prof = await get(HUB, "/api/agents/laptop~claude");
  const local = await get(HUB, "/api/agents/claude");
  check(prof.status === 200 && prof.agent.id === "laptop~claude" && prof.agent.machine === "laptop" && prof.files.some((f) => f.name === "notes.txt") && prof.hosts.length === 1, "Claude on the laptop's profile comes from the laptop: its files and sessions");
  check(local.status === 200 && local.agent.machine === "hub" && !local.files.some((f) => f.name === "notes.txt"), "and Claude on the hub's is the hub's own");

  // ---------- workspaces span machines ----------
  const both = await until(async () => {
    const f = (await stateOf((p) => get(HUB, p))).folders || [];
    return f.some((x) => x.machine === "laptop" && x.remote === "github.com/herval/app") && f.some((x) => x.machine === "hub" && x.remote === "github.com/herval/app");
  }, 8000);
  check(both, "each machine reports its checkouts, with the repo they're clones of");
  const appWs = await post(HUB, "/api/workspaces", { repo: "herval/app" });
  check(appWs.status === 200 && (await stateOf((p) => get(HUB, p))).workspaces.some((w) => w.id === appWs.id && w.repo === "github.com/herval/app"), "a workspace is kept on the hub, where the page is");
  const repo = `file://${project}`;
  const shared = await post(HUB, "/api/workspaces", { repo });
  const hasCheckout = async (machine: string) => {
    const s = await stateOf((p) => get(HUB, p));
    const key = s.workspaces.find((w) => w.id === shared.id)?.repo;
    return !!key && s.folders.some((f) => f.machine === machine && f.remote === key);
  };
  check(await until(() => hasCheckout("hub"), 15000), "a repo added without a machine has its first checkout on the hub");
  const fromLaptop = await post(HUB, "/api/workspaces?machine=laptop", { repo });
  check(fromLaptop.id === shared.id && fromLaptop.existing && await until(() => hasCheckout("laptop"), 15000), "adding the same workspace on the laptop creates its checkout there and keeps the workspace ID");
  const repeated = await post(HUB, "/api/workspaces?machine=laptop", { repo });
  check(repeated.id === shared.id && !repeated.cloning, "adding it on the laptop again reuses its checkout");
  const lapFolders = await get(HUB, `/api/folders?machine=laptop&path=${encodeURIComponent(path.join(BASE, "dev"))}`);
  check(lapFolders.status === 200 && lapFolders.machine === "laptop" && lapFolders.folders.some((f) => f.name === "app" && f.remote === "github.com/herval/app"), "the hub looks through the laptop's folders by asking the laptop");
  const lap = (await stateOf((p) => get(HUB, p))).machines.find((m) => m.name === "laptop");
  check(lap?.home === os.homedir() && !!lap.clone_dir, "and knows each machine's home and where it clones repos");

  // ---------- someone else on the hub sees only what's public, once they're herval's contact ----------
  const aliceJar = (await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice" }) })).headers.get("set-cookie").split(";")[0];
  const asAlice = (p: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) => fetch(HUB + p, { ...opts, headers: { cookie: aliceJar, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } }).then(async (r) => ({ status: r.status, ...((await r.json().catch(() => ({}))) as Json) }));
  const hidden = await stateOf(asAlice);
  check(!hidden.sessions.some((s) => s.machine === "laptop") && !hidden.agents.some((a) => a.machine === "laptop"), "someone else on the hub doesn't see the laptop's private posts");
  check((await asAlice("/api/sessions/lap-1")).status === 404 && !(await asAlice("/api/q/feed?q=readme")).list?.length, "asking for one, or searching its messages, as them, finds nothing");
  check((await asAlice("/api/folders?machine=laptop")).status === 403 && !hidden.folders.length && !hidden.workspaces.length && !hidden.machines.some((m) => m.home), "nor the laptop's folders, or herval's workspaces");
  check((await asAlice("/api/sessions/lap-1/messages", { method: "POST", body: JSON.stringify({ text: "hi" }) })).status === 404 && (await asAlice("/api/agents/laptop~claude/visibility", { method: "POST", body: JSON.stringify({ visibility: "public" }) })).status === 404, "and the hub refuses their changes to the laptop's posts, as it would something that isn't there");
  // Public is for herval's contacts: alice becomes one.
  await asAlice("/api/people/herval/contact", { method: "POST", body: JSON.stringify({ act: "ask" }) });
  await post(HUB, "/api/people/alice/contact", { act: "yes" });
  await post(HUB, "/api/sessions/lap-1/visibility", { visibility: "public" });
  const lone = await until(async () => (await stateOf(asAlice)).sessions.find((s) => s.id === "lap-1"), 6000);
  check(lone?.agent === null && lone.owner === "herval" && (await asAlice("/api/sessions/lap-1")).agent === null && (await asAlice("/api/agents/laptop~claude")).status === 404, "a laptop post set public shows on the hub as herval's, without its private agent, whose profile stays a 404");
  await post(HUB, "/api/sessions/lap-1/visibility", { visibility: null });
  const made = await post(HUB, "/api/agents/laptop~claude/visibility", { visibility: "public" });
  const shown = await until(async () => (await stateOf(asAlice)).sessions.find((s) => s.id === "lap-1"), 6000);
  check(made.status === 200 && shown && !shown.cwd && shown.mine === false && (await asAlice("/api/agents/laptop~claude")).agent?.owner === "herval", "once its owner makes the laptop's Claude public on the hub, they see its posts, as herval's");
  // Whoever sees a thread sees its work.
  check((await asAlice("/api/sessions/lap-1")).status === 200 && (await asAlice("/api/sessions/lap-1/steps")).status === 200, "its page, and its steps");

  // ---------- the laptop goes away, and comes back ----------
  node.kill();
  await sleep(5500);
  const t0 = Date.now();
  const gone = await post(HUB, "/api/sessions/lap-1/messages", { text: "still there?" });
  const after = await stateOf((p) => get(HUB, p));
  check(gone.status === 200 && gone.queued && gone.waiting === "laptop" && (await get(HUB, "/api/sessions/lap-1")).waiting?.[0]?.text === "still there?", "what you send a machine that's off waits for it, and the post says so");
  check(after.machines.find((m) => m.name === "laptop")?.online === false && after.sessions.find((s) => s.id === "lap-1")?.offline && after.agents.find((a) => a.id === "laptop~claude")?.offline, "and its agents and posts stay, marked offline");
  check((await get(HUB, "/api/sessions/lap-1")).messages?.some((m) => m.text === "tidy the readme"), "a post on a machine that's off still opens, from the hub");
  node = serve(nodeEnv);
  await healthy(NODE);
  const back = await until(async () => (await get(NODE, `/api/procs/${HOST}-920001/events`)).events?.find((e) => e.event.text === "still there?"), 9000);
  check(back && (await until(async () => !(await get(HUB, "/api/sessions/lap-1")).waiting?.length)), "and reaches it when it's back");
  // What the laptop's gate did with it, on the hub: the machine's log, and what it lets the hub do.
  const gated = await until(async () => {
    const g = await get(HUB, "/api/machines/laptop/gate");
    return g.audit?.some((l) => l.outcome === "ran" && l.kind === "post.deliver" && l.by === "herval" && l.at) && g;
  }, 8000);
  check(!!gated && gated.gate?.owner === "herval" && Array.isArray(gated.gate.shared), `the laptop's gate log reaches the hub, with what its gate lets the hub do (${JSON.stringify(gated?.audit?.[0] || null).slice(0, 160)})`);

  // ---------- disconnecting a machine ----------
  const mine = await get(HUB, "/api/devices");
  await post(HUB, `/api/devices/${mine.devices.find((d) => d.name === "laptop").id}/revoke`, {});
  const revoked = await post(HUB, "/api/cli/ops", { ops: [] }, { authorization: `Bearer ${got.token}` });
  check(revoked.status === 403 && !(await get(HUB, "/api/devices")).devices.some((d) => d.name === "laptop"), "a disconnected machine's token stops working");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  hub.kill();
  node.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
