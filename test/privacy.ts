#!/usr/bin/env node
// Who sees what: an owner, someone else signed in, and someone signed out, against every route and the
// live stream, as agents and posts go private and public. Run: node test/privacy.ts

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-privacy-"));
// The machine shares the test's folders with its server, and starts as many posts as the test does (its gate).
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4800);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), GIT_ALLOW_PROTOCOL: "file" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie, raw }: { body?: unknown; cookie?: string; raw?: Buffer | string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body && !raw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({
  cookie,
  get: (p: string) => req("GET", p, { cookie }),
  post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }),
});

const server = spawnAgentbook({ env, stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  // The machine's owner, and someone else they invited.
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  const nobody = as(null);

  // Two posts by Claude on this machine, with a question, a to-do, a file and a transcript.
  const transcript = path.join(HOME, "t-a.jsonl");
  const at = new Date().toISOString();
  const shot = { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("the screen").toString("base64") } }] }] }, toolUseResult: [] };
  fs.writeFileSync(transcript, [{ type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat ~/.ssh/config", description: "Read the ssh config" } }] } }, { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "t2", name: "mcp__claude-in-chrome__computer", input: { action: "screenshot" } }] } }, shot].map((e) => JSON.stringify(e) + "\n").join(""));
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: project, transcript } });
  await req("POST", "/api/procs/box-1/post", { body: { title: "Fix the importer" } });
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "Working on it." } });
  const q = await req("POST", "/api/procs/box-1/questions", { body: { title: "Deploy now?", options: ["Yes", "No"] } });
  await req("POST", "/api/procs/box-1/todos", { body: { text: "Review the PR" } });
  const file = await req("POST", "/api/procs/box-1/files", { body: { name: "report.txt", content_base64: Buffer.from("the report").toString("base64") } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: project } });
  await req("POST", "/api/procs/box-2/post", { body: { title: "Rotate the keys" } });
  const todo = (await stateOf(owner.get)).tasks.find((t) => t.from === "sess-a");
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const setPic = await fetch(URL + "/api/agents/claude/avatar", { method: "POST", headers: { "content-type": "image/png", cookie: owner.cookie }, body: PNG });
  check(setPic.status === 200 && (await stateOf(owner.get)).agents[0].avatar?.type === "image/png" && (await owner.get("/api/agents/claude/avatar")).status === 200, "the owner sets an agent's avatar");
  // People's avatars: a picture of your own, an emoji, or your letter; anyone signed in sees them.
  const FACE = Buffer.concat([PNG, Buffer.from("a face")]);
  const sendPic = (cookie: string, body: Buffer | string, type = "image/png") => fetch(URL + "/api/me/avatar", { method: "POST", headers: { "content-type": type, cookie }, body }).then(async (r): Promise<Json> => ({ status: r.status, ...((await r.json()) as Json) }));
  const setFace = await sendPic(owner.cookie, FACE);
  const face = (await owner.get("/api/auth/me")).user.avatar;
  check(setFace.status === 200 && face?.type === "image/png" && setFace.user.avatar?.image === face.image, "you set a picture of yourself");
  const herFace = await fetch(URL + `/api/people/herval/avatar?v=${face.image}`, { headers: { cookie: alice.cookie } });
  check(herFace.status === 200 && Buffer.from(await herFace.arrayBuffer()).equals(FACE) && /immutable/.test(herFace.headers.get("cache-control")) && (await alice.get("/api/people")).people.find((u) => u.username === "herval")?.avatar?.image === face.image, "others signed in see it, on the people list and from its address");
  check((await nobody.get("/api/people/herval/avatar")).status === 401 && (await alice.get("/api/people/nobody/avatar")).status === 404, "signed out, it doesn't load, and someone who isn't here has none");
  await alice.post("/api/me/avatar", { emoji: "🦊" });
  const bad = [await sendPic(alice.cookie, "<svg onload='alert(1)'/>", "image/svg+xml"), await alice.post("/api/me/avatar", { emoji: "a whole sentence" }), await alice.post("/api/me/avatar", { avatar: "x" })];
  check((await alice.get("/api/auth/me")).user.avatar?.emoji === "🦊" && bad.every((r) => r.status === 400), "or an emoji, but not an SVG, words or anything else");
  check(fs.readdirSync(path.join(HOME, "server", "avatars")).length === 2, "changing an avatar keeps the pictures people show, not just agents'");
  await owner.post("/api/me/avatar", { avatar: null });
  check((await owner.get("/api/auth/me")).user.avatar === null && fs.readdirSync(path.join(HOME, "server", "avatars")).length === 1, "going back to your letter deletes the picture nobody shows");

  // ---------- everything starts private ----------
  const mine = await stateOf(owner.get);
  check(mine.sessions.length === 2 && mine.sessions.every((s) => s.mine && !s.public) && mine.agents[0].visibility === "private" && mine.agents[0].owner === "herval", "the owner sees everything, all private, as theirs");
  const hers = await stateOf(alice.get);
  check(hers.sessions.length === 0 && hers.agents.length === 0 && hers.questions.length === 0 && hers.tasks.length === 0 && hers.folders.length === 0 && !hers.home && hers.workspaces.length === 0, "someone else sees none of it");
  const hidden = await Promise.all(["/api/sessions/sess-a", "/api/sessions/sess-a/steps", "/api/sessions/sess-a/images/t2/0", `/api/files/${file.id}`, "/api/agents/claude", "/api/agents/claude/skills/docs", "/api/agents/claude/avatar"].map((p) => alice.get(p)));
  check(hidden.every((r) => r.status === 404), "a private post, its steps, its file and its agent (its avatar too) answer 404, as if they didn't exist");
  const acts = await Promise.all([alice.post("/api/sessions/sess-a/messages", { text: "hi" }), alice.post("/api/sessions/sess-a/stop"), alice.post("/api/sessions/sess-a/visibility", { visibility: "public" }), alice.post("/api/agents/claude/visibility", { visibility: "public" }), alice.post("/api/agents/claude/avatar", { emoji: "🦉" }), alice.post("/api/pins", { post: "sess-a" })]);
  check(acts.every((r) => r.status === 404), "and can't be acted on, or pinned");
  check(!(await alice.get("/api/q/feed?q=working")).list?.length && (await owner.get("/api/q/feed?q=working")).list?.[0] === "thread:sess-a", "searching finds a private post's messages for its owner, not for anyone else");
  check((await stateOf(nobody.get)).status === 401 && (await nobody.get("/api/sessions/sess-a")).status === 401, "signed out, nothing loads");

  // ---------- the agent goes public, and its posts with it, to its owner's contacts ----------
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  await owner.post("/api/agents/claude/visibility", { visibility: "public" });
  const pub = await stateOf(alice.get);
  const a = pub.sessions.find((s) => s.id === "sess-a");
  check(pub.sessions.length === 2 && pub.agents[0]?.id === "claude" && pub.agents[0].owner === "herval" && pub.agents[0].mine === false, "a public agent's posts are public too");
  check(a && !("cwd" in a) && !("root" in a) && !("transcript" in a) && !("proc" in a) && !("session_id" in a) && !("rt" in a) && a.title === "Fix the importer", "others see the post, not where it runs on the owner's machine");
  check(pub.questions.length === 0 && pub.tasks.length === 0, "nor its questions or to-dos");
  check(a.last_files.length === 1, "but its files, as its work: whoever sees a thread sees its work");
  check(a.effective === "waiting" && (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-a").effective === "needs", "a post waiting on its owner shows as waiting to others, not as needing them");
  const detail = await alice.get("/api/sessions/sess-a");
  check(detail.status === 200 && detail.messages.some((m) => m.text === "Working on it.") && detail.questions.length === 0 && detail.files.length === 1 && !detail.cwd, "its page shows the conversation and its files, without the owner's questions or where it runs");
  check((await alice.get("/api/q/feed?q=working")).list?.includes("thread:sess-a"), "and searching finds its messages");
  check((await alice.get("/api/sessions/sess-a/steps")).status === 200 && (await alice.get("/api/sessions/sess-a/images/t2/0")).status === 200 && (await alice.get(`/api/files/${file.id}`)).status === 200, "its steps, the images its agent saw, and its files: there's no switching its work off");
  const tried = {
    message: await alice.post("/api/sessions/sess-a/messages", { text: "hi" }),
    stop: await alice.post("/api/sessions/sess-a/stop"),
    archive: await alice.post("/api/sessions/sess-a/flag", { archived: true }),
    hide: await alice.post("/api/sessions/sess-a/flag", { hidden: true }),
    visibility: await alice.post("/api/sessions/sess-a/visibility", { visibility: "private" }),
    agent: await alice.post("/api/agents/claude/visibility", { visibility: "private" }),
    avatar: await alice.post("/api/agents/claude/avatar", { emoji: "🦉" }),
    model: await alice.post("/api/sessions/sess-a/model", { model: "x" }),
    launch: await alice.post("/api/launch", { prompt: "do it", root: project, agent: "claude" }),
    pull: await alice.post("/api/cloud/pull", { ref: "session_01X", root: project }),
    upload: await req("POST", "/api/upload?post=sess-a&name=x.txt", { cookie: alice.cookie, raw: "x" }),
  };
  check((await alice.get("/api/runtimes")).status === 403 && (await alice.get("/api/openclaw")).status === 403 && (await alice.post("/api/openclaw", { disconnect: true })).status === 403, "what the machine runs, and its OpenClaw connection, are its owner's to see and change");
  check(Object.values(tried).every((r) => r.status === 403), `but only its owner steers it (${Object.entries(tried).filter(([, r]) => r.status !== 403).map(([k, r]) => `${k}: ${r.status}`).join(", ") || "all refused"})`);
  const theirs = [await alice.post(`/api/questions/${q.id}/answer`, { value: "Yes" }), await alice.post(`/api/tasks/${todo.id}/done`), await alice.post(`/api/tasks/${todo.id}/link`, { post: "sess-a", linked: false }), await alice.post(`/api/files/${file.id}/delete`)];
  check(theirs.every((r) => r.status === 404) && !(await stateOf(owner.get)).questions.find((x) => x.id === q.id).answered && !(await stateOf(owner.get)).tasks.find((t) => t.id === todo.id).done, "nor answers its questions, ticks or unlinks its to-dos or deletes its files");
  const skill = await alice.get("/api/agents/claude");
  check(skill.status === 200 && skill.agent.mine === false && skill.files.length === 1, "the public agent's profile, with the files of its posts they see");
  check(skill.agent.avatar?.type === "image/png" && (await alice.get("/api/agents/claude/avatar")).status === 200, "with its avatar");

  // ---------- one post private again; an old page's Show the work changes nothing ----------
  await owner.post("/api/sessions/sess-b/visibility", { visibility: "private" });
  await owner.post("/api/sessions/sess-a/visibility", { show_work: false });
  const after = await stateOf(alice.get);
  check(!after.sessions.some((s) => s.id === "sess-b") && (await alice.get("/api/sessions/sess-b")).status === 404, "a post can be private on a public agent");
  const steps = await alice.get("/api/sessions/sess-a/steps");
  check(steps.status === 200 && steps.steps.some((x) => x.title === "Read the ssh config") && (await alice.get(`/api/files/${file.id}`)).text === "the report", "its steps and files show, show_work: false or not");
  check(steps.steps.find((x) => x.id === "t2")?.images === 1 && (await alice.get("/api/sessions/sess-a/images/t2/0")).text === "the screen", "and the images its agent saw");
  check((await alice.get("/api/sessions/sess-a")).files.length === 1 && (await alice.get("/api/agents/claude")).files.length === 1, "on its page and its agent's profile too");

  // ---------- a private agent's public post: the post, not the agent ----------
  await owner.post("/api/agents/claude/visibility", { visibility: "private" });
  check((await stateOf(alice.get)).sessions.length === 0 && (await alice.get("/api/sessions/sess-a")).status === 404 && (await alice.get(`/api/files/${file.id}`)).status === 404, "a private agent's posts are private, unless set themselves");
  await owner.post("/api/sessions/sess-a/visibility", { visibility: "public" });
  const lone = await stateOf(alice.get);
  const shown = lone.sessions.find((s) => s.id === "sess-a");
  check(lone.sessions.length === 1 && shown?.title === "Fix the importer" && shown.agent === null && shown.owner === "herval" && lone.agents.length === 0, "a post set public shows, by its owner but not by its private agent");
  const page = await alice.get("/api/sessions/sess-a");
  check(page.status === 200 && page.agent === null && page.owner === "herval" && !/"claude"|"Claude"/.test(JSON.stringify(page)), "its page doesn't say which agent either");
  check((await alice.get("/api/sessions/sess-a/steps")).status === 200 && (await alice.get(`/api/files/${file.id}`)).text === "the report", "and it shows its work, when set to");
  const profiles = await Promise.all(["/api/agents/claude", "/api/agents/claude/skills/docs", "/api/agents/claude/avatar", "/api/agents/~private"].map((p) => alice.get(p)));
  check(profiles.every((r) => r.status === 404) && (await alice.get("/api/people/herval")).agents.length === 0, "the agent's profile is still a 404, and its owner's profile doesn't list it");
  const own = (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-a");
  check(own.visibility === "public" && own.public === true && own.agent === "claude", "the owner sees it as public, by its agent");
  await owner.post("/api/sessions/sess-a/visibility", { visibility: null });
  check((await alice.get("/api/sessions/sess-a")).status === 404, "following its agent again, it's private again");

  // ---------- pins are each person's own ----------
  await owner.post("/api/agents/claude/visibility", { visibility: "public" });
  check((await alice.post("/api/pins", { post: "sess-a", pinned: true })).status === 200, "anyone who can see a post can pin it");
  check((await stateOf(alice.get)).sessions.find((s) => s.id === "sess-a").pinned === true && (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-a").pinned === false, "for themselves only");

  // ---------- tasks are each person's own ----------
  const task = await owner.post("/api/tasks", { text: "Renew the domain" });
  const alicesTask = await alice.post("/api/tasks", { text: "Water the plants" });
  check(task.status === 200 && alicesTask.status === 200 && (await stateOf(owner.get)).tasks.map((t) => t.text).sort().join() === "Renew the domain,Review the PR" && (await stateOf(alice.get)).tasks.map((t) => t.text).join() === "Water the plants", "everyone has a to-do list of their own (the owner's with what their agent left them)");
  const meddle = await Promise.all([alice.post(`/api/tasks/${task.id}`, { text: "x" }), alice.post(`/api/tasks/${task.id}/done`, {}), alice.post(`/api/tasks/${task.id}/move`, {}), alice.post(`/api/tasks/${task.id}/send`, { launch: "l1" }), alice.post(`/api/tasks/${task.id}/link`, { post: "sess-a" }), alice.post(`/api/tasks/${task.id}/delete`, {})]);
  const renew = (await stateOf(owner.get)).tasks.find((t) => t.id === task.id);
  check(meddle.every((r) => r.status === 404) && renew?.text === "Renew the domain" && !renew.done && !renew.posts.length, "and nobody else can see, edit, tick, move, send, link or delete yours");

  // ---------- profiles ----------
  const herval = await alice.get("/api/people/herval");
  check(herval.agents.length === 1 && herval.agents[0].id === "claude" && !herval.devices, "a profile lists its person's public agents, not their machines");
  await owner.post("/api/agents/claude/visibility", { visibility: "private" });
  check((await alice.get("/api/people/herval")).agents.length === 0 && (await owner.get("/api/people/herval")).agents.length === 1, "and not their private ones, except to them");

  // ---------- a new post can differ from its agent ----------
  await owner.post("/api/agents/claude/visibility", { visibility: "public" });
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-c");
  const quiet = await owner.post("/api/launch", { prompt: "Rotate the staging keys", root: project, agent: "claude", visibility: "private" });
  await req("POST", "/api/hello", { body: { proc: "box-3", label: "lark", agent: "Claude", session_id: "sess-c", cwd: project } });
  const c = (await stateOf(owner.get)).sessions.find((s) => s.id === "sess-c");
  check(quiet.status === 200 && c?.visibility === "private" && !c.public && !(await stateOf(alice.get)).sessions.some((s) => s.id === "sess-c"), "a post started as private under a public agent stays private");
  await owner.post("/api/agents/claude/visibility", { visibility: "private" });

  // ---------- the live stream: what a page of theirs watches (the chrome, the feed) ----------
  const seen = await new Promise<string>((resolve) => {
    let data = "";
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/live?live=privacy-alice-1", headers: { cookie: alice.cookie } }, (res) => res.on("data", (d) => (data += d)));
    setTimeout(async () => {
      await alice.get("/api/q/side?live=privacy-alice-1");
      await alice.get("/api/q/feed?live=privacy-alice-1");
      await req("POST", "/api/procs/box-2/updates", { body: { text: "the new key is hunter2" } });
      await req("POST", "/api/procs/box-1/post", { body: { title: "Fix the importer, quietly" } });
      setTimeout(() => {
        r.destroy();
        resolve(data);
      }, 1200);
    }, 500);
  });
  check(seen.includes("event: hello") && !seen.includes("hunter2") && !seen.includes("Fix the importer"), "the live stream carries only what its viewer may see");

  // Workspaces are each person's own; a machine's folders are its owner's to look through.
  const myWs = await owner.post("/api/workspaces", { repo: "herval/app" });
  const herWs = await alice.post("/api/workspaces", { repo: "herval/app" });
  check(myWs.status === 200 && herWs.status === 200 && herWs.id !== myWs.id && (await stateOf(alice.get)).workspaces.every((w) => w.id === herWs.id) && (await stateOf(owner.get)).workspaces.every((w) => w.id === myWs.id), "everyone has their own workspaces, and sees only theirs");
  check((await alice.post(`/api/workspaces/${myWs.id}`, { name: "mine now" })).status === 404 && (await alice.post(`/api/workspaces/${myWs.id}/delete`)).status === 404, "and can't rename or remove someone else's");
  check((await alice.get("/api/folders")).status === 403 && (await alice.get(`/api/branches?root=${encodeURIComponent(project)}`)).status === 403 && (await owner.get(`/api/folders?path=${encodeURIComponent(HOME)}`)).status === 200, "only the machine's owner can look through its folders and branches");
  check((await nobody.post("/api/workspaces", { repo: "herval/app" })).status === 401, "and no one signed out can add one");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
