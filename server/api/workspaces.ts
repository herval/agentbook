// Workspaces: where you keep sessions together, their pull requests and WIPs, and who sees them.

import crypto from "node:crypto";
import path from "node:path";
import { seenAt } from "../policy.ts";
import { isLevel, levelOf, storedLevel } from "../../plugin/shared/visibility.ts";
import { repos as githubRepos } from "../integrations/connectors/github.ts";
import { NO_TOKEN as NO_GITHUB, commentOn, githubRepo, pullDetail, pullDiff, pullNode, replyThread, resolveThread } from "../integrations/pulls.ts";
import { GROUP_MENTION, groupsIn, NOTE_MENTION, TASK_MENTION, tasksIn, WS_MENTION } from "../../plugin/shared/mentions.ts";
import type { NamedGroup, NamedNote, NamedTask } from "../../plugin/shared/mentions.ts";
import { isTalkId } from "../../plugin/shared/talks.ts";
import { machineName } from "../../plugin/shared/ids.ts";
import { cloneUrl, repoKey } from "../../plugin/shared/repos.ts";
import type { User } from "../accounts.ts";
import type { Visibility, Workspace } from "../../plugin/shared/types.ts";
import { accounts, commit, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Req, Res, Viewer } from "../core/http.ts";
import type { Answer, PostRef } from "../core/types.ts";
import { allPosts, deviceFor, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { isContact, seesPost } from "../core/follows.ts";
import { readOf, signedOr428, steer } from "../core/commands.ts";
import { rowsFor } from "./views.ts";
import { ghFor, pullsCache, pullsKey, pullsOf, workspaceView } from "./prs.ts";
import { flagsTask, onTask, wipForOthers } from "./tasks.ts";
import { noteSeen } from "./notes.ts";
import { byYou, groupPost, groupSeen, inGroup } from "./groups.ts";
import { talkOf, talkSeen } from "./talks.ts";

// What a message names that its agent is told of (mentions.ts's mentionNote), by id: the tasks and groups it put the
// thread on or in (`here`), and the notes it names.
interface Linked {
  tasks: Record<string, NamedTask>;
  groups: Record<string, NamedGroup>;
  notes?: Record<string, NamedNote>;
}
// What's written to a pull request from its workspace's page (pullWrite): which one, and a reply on one of its review
// threads (`thread`, `body`, resolving it with `resolve`), resolving one (`resolved`), or a comment on it (`body`).
interface PullBody {
  workspace?: string;
  number?: number;
  thread?: string;
  body?: string;
  resolve?: boolean;
  resolved?: boolean;
}

// --- WIP: a project's branches with work that isn't on main yet (see wip.ts), as its machine reads git ---
route("GET", "/api/wip", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only its machine's owner can see its work in progress.");
  await readOf(res, D, "read.wip", { root: str(query.get("root"), 1000), branch: str(query.get("branch"), 250) });
});
route("GET", "/api/wip/diff", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only its machine's owner can see its work in progress.");
  await readOf(res, D, "read.wip_diff", { root: str(query.get("root"), 1000), branch: str(query.get("branch"), 250), path: str(query.get("path"), 1000), scope: query.get("scope") === "uncommitted" ? "uncommitted" : "committed" });
});
// Clean up: remove a WIP's worktree and delete its branch, once everything on it is on main and nobody's
// working there (its machine refuses the rest).
route("POST", "/api/wip/clean", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; root?: string; branch?: string }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only its machine's owner can clean up its work in progress.");
  await steer(req, res, D, "wip.clean", { root: str(b.root, 1000), branch: str(b.branch, 250) }, { wait: 60e3, done: (r) => { const { ok: _, ...rest } = r; return rest; } });
});
// Discard: remove its worktree and delete its branch with what isn't on main or committed, once nobody's working
// there. With `sha`, only while the branch is still on that commit.
route("POST", "/api/wip/discard", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; root?: string; branch?: string; sha?: string }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only its machine's owner can discard its work in progress.");
  await steer(req, res, D, "wip.discard", { root: str(b.root, 1000), branch: str(b.branch, 250), ...(b.sha ? { sha: str(b.sha, 64) } : {}) }, { wait: 60e3, done: (r) => { const { ok: _, ...rest } = r; return rest; } });
});

// --- workspaces: where you keep sessions together ---
// A workspace is a repo, found in its checkouts on every machine (the page matches each machine's folders by the
// repo they're a clone of), or a folder on one machine. Each belongs to the person who added it.
const workspaceId = () => `w${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
const mineToEdit = (req: Viewer, res: Res, id: string) => {
  const w = state.workspaces[id];
  if (w && w.owner === req.user?.id) return w;
  fail(res, 404, "No such workspace.");
};
const checkedOut = (repo: string, uid: string, machine?: string) => [...relay.devices.values()].some((D) => (!machine || D.name === machine) && ownerOf(D)?.id === uid && (relay.infoOf(D).folders?.folders || []).some((f) => f.remote === repo));
// A person's workspaces by id, each with its checkouts on their machines (as feed.ts's workspacesOf), for the note
// on a message that names one (mentions.ts). Only when `text` names one: reading every machine's folders isn't free.
export function workspacesNamed(user: User | null, text) {
  if (!user || !String(text || "").match(WS_MENTION)) return {};
  const folders = [...relay.devices.values()].filter((D) => ownerOf(D)?.id === user.id).flatMap((D) => (relay.infoOf(D).folders?.folders || []).map((f) => ({ machine: D.name, root: f.root, remote: f.remote })));
  const out = {};
  for (const w of Object.values(state.workspaces)) {
    if (w.owner !== user.id) continue;
    const checkouts = folders.filter((f) => (w.repo && f.remote === w.repo) || w.folders.some((x) => x.machine === f.machine && x.path === f.root)).map(({ machine, root }) => ({ machine, root }));
    for (const f of w.folders) if (!checkouts.some((c) => c.machine === f.machine && c.root === f.path)) checkouts.push({ machine: f.machine, root: f.path });
    out[w.id] = { id: w.id, name: w.name, repo: w.repo, checkouts };
  }
  return out;
}
// A person's tasks and groups by id, for a message that names one (mentions.ts): their tasks, and their groups that
// aren't archived. Empty when `text` names none.
export function tasksNamed(user: User | null, text) {
  if (!user || !String(text || "").match(TASK_MENTION)) return {};
  return Object.fromEntries(Object.values(state.tasks).filter((t) => onTask(t, user.id) && (t.owner === user.id || !t.scope) && !t.removed).map((t) => [t.id, t]));
}
export function groupsNamed(req: Viewer, text) {
  if (!String(text || "").match(GROUP_MENTION)) return {};
  return Object.fromEntries(Object.values(state.groups).filter((g) => inGroup(req, g) && !g.archived).map((g) => [g.id, g]));
}
// A thread you @ a task or a group in goes on that task, or in that group (the first one named: a thread is in one
// group at most), as a thread of yours started for it would. -> what it named, each with `here` once it's on or in it.
export async function mentionLinks(req: Viewer, p: PostRef, text: string): Promise<Linked> {
  const tasks = tasksIn(text, tasksNamed(req.user, text)).map((x) => x.task);
  const groups = groupsIn(text, groupsNamed(req, text)).map((x) => x.group);
  const g = groups[0];
  for (const t of tasks) if (!(t.posts || []).some((e) => e.post === p.id)) commit({ t: "task.link", tid: t.id, post: p.id, linked: true, user: req.user.id });
  // Everyone on it: a task shared with others shows them the thread now.
  for (const t of tasks) flagsTask(t);
  if (g && state.group_posts[p.id]?.group !== g.id) await groupPost(g.id, p, byYou(req), { wait: 0 });
  return { tasks: Object.fromEntries(tasks.map((t) => [t.id, { ...t, here: true }])), groups: Object.fromEntries(groups.map((x) => [x.id, { ...x, here: x === g }])) };
}
// A thread's title, from a prompt that names tasks, groups or notes: their names in words, for whoever sees them (their
// own tasks, the groups and notes they see), else "a task", "a group", "a note"; the machine that made it knows only the
// pages.
const NAMED_TITLE = /@(?:task|group|note):/;
export function namesFor(req: Viewer, threads: { title?: string | null }[]): [Map<string, string>, Map<string, string>, Map<string, string>] | null {
  if (!threads.some((s) => NAMED_TITLE.test(s.title || ""))) return null;
  const tasks = new Map(req.user ? Object.values(state.tasks).filter((t) => onTask(t, req.user.id) && !t.removed).map((t) => [t.id, t.text]) : []);
  const groups = new Map(Object.values(state.groups).filter((g) => groupSeen(req, g)).map((g) => [g.id, g.name]));
  const notes = new Map(Object.values(state.notes).filter((n) => noteSeen(req, n)).map((n) => [n.id, n.title]));
  return [tasks, groups, notes];
}
export function titleNamed(title: string | null, tasks: Map<string, string>, groups: Map<string, string>, notes: Map<string, string>) {
  if (!title || !title.includes("@")) return title;
  return title.replace(TASK_MENTION, (m, pre, id) => (tasks.has(id) ? pre + tasks.get(id) : `${pre}a task`)).replace(GROUP_MENTION, (m, pre, id) => (groups.has(id) ? pre + groups.get(id) : `${pre}a group`)).replace(NOTE_MENTION, (m, pre, id) => (notes.has(id) ? pre + notes.get(id) : `${pre}a note`));
}
route("POST", "/api/workspaces", async (req, res, { query }) => {
  const b = await readBody<{ folder?: { machine?: string; path?: string }; machine?: string; repo?: string; url?: string; name?: string }>(req);
  const machine = query.get("machine");
  const target = deviceFor(req, machine || b.folder?.machine || b.machine);
  if (machine && !target) return fail(res, 404, "No such machine.");
  if (machine && b.folder?.machine && b.folder.machine !== target.name) return fail(res, 400, "Pick a folder on the selected machine.");
  const folder = b.folder?.path ? { machine: machineName(b.folder.machine || target?.name || ""), path: path.normalize(str(b.folder.path, 1000)) } : null;
  if (folder && !folder.machine) return fail(res, 400, "Which machine is that folder on?");
  if (folder && !path.isAbsolute(folder.path)) return fail(res, 400, "A folder's path starts at /.");
  const repo = b.repo ? repoKey(str(b.repo, 1000)) : null;
  if (b.repo && !repo) return fail(res, 400, `"${str(b.repo, 200)}" isn't a repo. Write it as owner/repo, or paste its URL.`);
  if (!repo && !folder) return fail(res, 400, "Pick a repo or a folder.");
  const owner = req.user.id;
  const has = (w) => folder && w.folders.some((f) => f.machine === folder.machine && f.path === folder.path);
  // Adding a repo again, or a folder it has: the workspace you have for it, with the folder.
  const existing = () => Object.values(state.workspaces).find((w) => w.owner === owner && (repo ? w.repo === repo : !w.repo && has(w)));
  const url = repo ? existing()?.url || cloneUrl(b.url && repoKey(str(b.url, 1000)) === repo ? str(b.url, 1000) : str(b.repo, 1000)) : null;
  // A machine-specific add needs a checkout there even if another machine already has the repo.
  let into;
  let waiting: string | undefined;
  // A folder of yours is one you chose to work in, so its machine tells Claude Code you trust it (`folder.trust`):
  // a background session won't start in a folder Claude Code hasn't trusted. Either asks the machine, so one that
  // keeps your passkeys takes it signed (signedOr428), before anything here changes.
  const ask = repo && !folder && target && url && !checkedOut(repo, owner, machine ? target.name : undefined) ? { kind: "workspace.clone", args: { url } } : folder && target?.name === folder.machine ? { kind: "folder.trust", args: { path: folder.path } } : null;
  const signed = ask ? await signedOr428(req, res, target, ask.kind, ask.args) : null;
  if (signed === false) return;
  if (ask?.kind === "workspace.clone") {
    const r = (await relay.command(target, "workspace.clone", ask.args, { by: viewerName(req), wait: 10e3, signed })) as Answer;
    if (machine && r?.error) return fail(res, r.status || 409, r.error);
    if (machine && r?.queued) waiting = target.name;
    if (r?.cloning) into = r.dir;
  }
  if (ask?.kind === "folder.trust") relay.command(target, "folder.trust", ask.args, { by: viewerName(req), wait: 0, signed });
  // Another add can finish while the selected machine answers the clone request.
  const same = existing();
  if (same) {
    if (folder && !has(same)) commit({ t: "workspace.update", wid: same.id, folders: [...same.folders, folder] });
    return ok(res, { id: same.id, existing: true, cloning: into, waiting });
  }
  const name = str(b.name, 60).trim() || (repo ? repo.split("/").pop() : path.basename(folder.path) || folder.path);
  const op = commit({ t: "workspace.add", wid: workspaceId(), name, repo, url, folders: folder ? [folder] : [], owner });
  ok(res, { id: op.wid, cloning: into, waiting });
});
// Rename a workspace.
route("POST", "/api/workspaces/:id", async (req, res, { params }) => {
  const w = mineToEdit(req, res, params.id);
  if (!w) return;
  const b = await readBody<{ name?: string }>(req);
  const name = str(b.name, 60).trim();
  if (!name) return fail(res, 400, "Give it a name.");
  commit({ t: "workspace.update", wid: w.id, name });
  ok(res);
});
// Keep it out of agent search: its threads can search each other, and no thread elsewhere
// finds them. Its owner's.
route("POST", "/api/workspaces/:id/search", async (req, res, { params }) => {
  const w = mineToEdit(req, res, params.id);
  if (!w) return;
  const b = await readBody<{ off?: boolean }>(req);
  commit({ t: "workspace.update", wid: w.id, search_off: !!b.off });
  ok(res, { search_off: !!w.search_off });
});
// Your repos on GitHub, to pick one on Add a workspace: read as you (ghFor), and kept a minute once read, so
// opening the page again doesn't read them all again. A read that fails isn't kept.
const REPOS_MS = 60e3;
const reposRead = new Map(); // whose -> { at, read }
route("GET", "/api/github/repos", async (req, res, { query }) => {
  const gh = ghFor(req.user.id);
  if (!gh) return fail(res, 403, NO_GITHUB);
  let r = reposRead.get(gh.who);
  // ?again=1: the page is back from GitHub, where the app may have just been given more repos, so a kept list
  // counts for 5 seconds only.
  if (!r || (r.at && Date.now() - r.at > (query.get("again") ? 5e3 : REPOS_MS))) {
    r = { at: 0, read: githubRepos(gh.token) };
    reposRead.set(gh.who, r);
    r.read.then(
      () => (r.at = Date.now()),
      () => reposRead.get(gh.who) === r && reposRead.delete(gh.who),
    );
  }
  try {
    const d = await r.read;
    ok(res, { ...d, repos: d.repos.map((x) => ({ ...x, repo: repoKey(x.slug) })) });
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});

// --- a workspace's pull requests, from GitHub (see pulls.ts) ---
// Yours to see: a workspace of yours, on GitHub. Opening one reads its list again sooner, so the sidebar
// keeps up with the page.
function pullAsked(req: Viewer, res: Res, query: URLSearchParams) {
  const w = state.workspaces[query.get("workspace") || ""];
  if (!w || w.owner !== req.user?.id) return void fail(res, 404, "No such workspace.");
  if (!githubRepo(w.repo)) return void fail(res, 400, "That workspace isn't a repo on GitHub.");
  // Read as its person, like its list.
  const gh = ghFor(w.owner);
  if (!gh) return void fail(res, 403, NO_GITHUB);
  const number = Number(query.get("number"));
  if (!Number.isInteger(number) || number < 1) return void fail(res, 400, "That isn't a pull request's number.");
  return { w, number, gh };
}
route("GET", "/api/pulls", async (req, res, { query }) => {
  const a = pullAsked(req, res, query);
  if (!a) return;
  try {
    const d = await pullDetail(a.w.repo, a.number, { host: "agentbook-server", token: a.gh.token });
    const c = pullsCache.get(pullsKey(a.w.repo, a.gh));
    if (c) c.looked = Date.now();
    const known = c?.data?.pulls?.find((p) => p.number === a.number);
    if (!known || known.updated !== d.updated || known.sha !== d.sha) pullsOf(a.w.repo, a.w.owner, true);
    ok(res, d);
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
route("GET", "/api/pulls/diff", async (req, res, { query }) => {
  const a = pullAsked(req, res, query);
  if (!a) return;
  const file = query.get("path") || "";
  if (!file || file.length > 1000) return fail(res, 400, "Say which file.");
  try {
    ok(res, await pullDiff(a.w.repo, a.number, file, str(query.get("sha"), 64), { host: "agentbook-server", token: a.gh.token }));
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
// Answering it, as its person, the way they would on GitHub: a reply on one of its review threads (resolving it too,
// with `resolve`), resolving a thread or opening it again, and a comment on the pull request itself. Its list is read
// again right after, so the page has what changed.
async function pullWrite(req: Req, res: Res, write: (b: PullBody, gh: { host: string; token: string }, a: NonNullable<ReturnType<typeof pullAsked>>) => Promise<object>) {
  const b = await readBody<PullBody>(req);
  const a = pullAsked(req, res, new URLSearchParams({ workspace: str(b.workspace, 100), number: String(b.number ?? "") }));
  if (!a) return;
  try {
    const out = await write(b, { host: "agentbook-server", token: a.gh.token }, a);
    pullsOf(a.w.repo, a.w.owner, true);
    ok(res, out);
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
}
const reviewThreadOf = (b: PullBody) => {
  const t = str(b.thread, 200);
  if (!t) throw Object.assign(new Error("Say which review thread."), { status: 400 });
  return t;
};
route("POST", "/api/pulls/reply", (req, res) =>
  pullWrite(req, res, async (b, gh) => {
    const thread = reviewThreadOf(b);
    const reply = await replyThread(thread, b.body, gh);
    return { reply, ...(b.resolve ? await resolveThread(thread, true, gh) : {}) };
  }),
);
route("POST", "/api/pulls/resolve", (req, res) => pullWrite(req, res, (b, gh) => resolveThread(reviewThreadOf(b), b.resolved !== false, gh)));
route("POST", "/api/pulls/comment", (req, res) => pullWrite(req, res, async (b, gh, a) => ({ comment: await commentOn(await pullNode(a.w.repo, a.number, gh), b.body, gh) })));
route("POST", "/api/workspaces/:id/delete", (req, res, { params }) => {
  const w = mineToEdit(req, res, params.id);
  if (!w) return;
  commit({ t: "workspace.remove", wid: w.id });
  ok(res);
});

// --- who sees a workspace and its worktrees ---
// A workspace is private (its owner's, the default) or public (its owner's contacts see it too); each of its worktrees (a branch, with its pull request) is as its workspace
// unless its owner set its own (`worktrees`, by branch), so one can be public in a private workspace, as a thread can
// of a private agent. Others see its name and repo, the worktrees of it they may see, to read only, and the threads in
// it they'd see anyway; never its folders, nor where on its owner's machines anything is.
export const wsLevel = (w: Workspace) => levelOf(w?.visibility);
const treeLevel = (w: Workspace, branch) => storedLevel(w?.worktrees?.[branch]) ?? wsLevel(w);
const signedPerson = (req: Viewer) => !!req.user;
export const wsShownTo = (req: Viewer, w: Workspace) => !!w && signedPerson(req) && (w.owner === req.user.id || seenAt(wsLevel(w), isContact(req, w.owner)));
// A worktree (`part`, one of wsParts') with a level of its own shows by it; one without, to whoever sees its workspace.
function treeShownTo(req: Viewer, w: Workspace, part) {
  if (!w || !signedPerson(req)) return false;
  if (w.owner === req.user.id) return true;
  const own = storedLevel(w.worktrees?.[part.branch]);
  if (!own) return wsShownTo(req, w);
  return seenAt(own, isContact(req, w.owner));
}
// Its owner's checkouts of it, on their machines: { D, f } each (a folder that's a clone of its repo, or one given).
function wsFolders(w: Workspace) {
  const out = [];
  for (const D of relay.devices.values()) {
    if (ownerOf(D)?.id !== w.owner) continue;
    for (const f of relay.infoOf(D).folders?.folders || []) if ((w.repo && f.remote === w.repo) || (w.folders || []).some((x) => x.machine === D.name && x.path === f.root)) out.push({ D, f });
  }
  return out;
}
// Its owner's threads in it (run in one of its checkouts, or below), and their own threads (talks) that name it.
export function wsThreadIds(w: Workspace, folders = wsFolders(w)) {
  const ids = new Set<string>();
  for (const p of allPosts()) {
    const root = p.s.root;
    if (root && folders.some(({ D, f }) => D === p.D && (root === f.root || root.startsWith(`${f.root}/`)))) ids.add(p.id);
  }
  for (const t of Object.values(state.talks || {})) if (t.workspace === w.id && t.owner === w.owner) ids.add(t.id);
  return ids;
}
// Its worktrees as others read them, in the shape a shared task's parts have (taskParts): each pull request GitHub has
// of its owner's in it (workspaceView's), and each branch with work on it in a checkout that has none, by `id`
// ("pr<number>", "b:<branch>"), with where it stands (`where`) and its threads; `at`, where its branch is, stays here.
function wsParts(w: Workspace) {
  const folders = wsFolders(w);
  const o = accounts.byId(w.owner);
  const branches = new Map(); // branch -> { D, f, w }
  for (const { D, f } of folders) for (const y of f.wip || []) if (y.branch && !branches.has(y.branch)) branches.set(y.branch, { D, f, w: y });
  const where = (at) => at && { machine: at.D.name, owner: o?.username || null, base: at.w.base || "main", ahead: at.w.ahead || 0, behind: at.w.behind || 0, dirty: at.w.dirty || 0, commits: at.w.commits || 0, worked: !!at.w.worked, checked_out: !!at.w.worktree, sha: at.w.sha || null, subject: at.w.subject || "", at: at.w.at || null };
  const threads = [...wsThreadIds(w, folders)].map((id) => (isTalkId(id) ? null : postRef(id))).filter(Boolean);
  const on = (branch) => threads.filter((p) => p.s.branch === branch).map((p) => p.id);
  const pulls = workspaceView(w, []).pulls?.pulls || [];
  const newest = new Map();
  for (const p of pulls) if (!newest.has(p.head) || p.created > newest.get(p.head).created) newest.set(p.head, p);
  const out = [];
  for (const p of pulls) {
    const at = newest.get(p.head) === p ? branches.get(p.head) || null : null;
    out.push({ id: `pr${p.number}`, kind: "pr", ref: `#${p.number}`, title: p.title, url: p.url, repo: w.repo, branch: p.head, gh: p, landed: p.state === "merged", posts: on(p.head), at, where: where(at) });
  }
  for (const [branch, at] of branches) if (!newest.has(branch)) out.push({ id: `b:${branch}`, kind: "branch", ref: branch, title: at.w.subject || branch, url: null, repo: w.repo, branch, gh: null, landed: false, posts: on(branch), at, where: where(at) });
  return out;
}
// A workspace of someone else's as a request may reach it: the workspace, and its worktrees they may see (`parts`).
// A 404 when they see neither it nor any of them, as for one that doesn't exist.
function wsSeenOr404(req: Viewer, res: Res, id: string) {
  const w = state.workspaces[id];
  const whole = wsShownTo(req, w);
  const parts = w && signedPerson(req) ? wsParts(w).filter((x) => (storedLevel(w.worktrees?.[x.branch]) ? treeShownTo(req, w, x) : whole)) : [];
  if (!w || !(whole || parts.length)) return void fail(res, 404, "No such workspace.");
  return { w, parts, whole };
}
// Someone else's workspace, by its link: what it is (its name only when they see it, not just a worktree of it), the
// worktrees of it they see, each with the threads on it they see, and, when they see it, its threads they see.
route("GET", "/api/workspaces/:id", (req, res, { params }) => {
  const a = wsSeenOr404(req, res, params.id);
  if (!a) return;
  const { w, parts, whole } = a;
  const shown = (id) => (isTalkId(id) ? talkSeen(req, talkOf(id)) : seesPost(req, postRef(id)));
  const ids = whole ? new Set([...wsThreadIds(w)].filter(shown)) : new Set();
  const owner = accounts.byId(w.owner)?.username || null;
  ok(res, {
    workspace: { id: w.id, name: whole ? w.name : null, repo: w.repo, owner, mine: w.owner === req.user.id, visibility: wsLevel(w), created: whole ? w.created : null },
    parts: parts.map(({ at, posts, ...x }) => ({ ...x, visibility: treeLevel(w, x.branch), threads: posts.filter(shown) })),
    threads: whole ? rowsFor(req, (s) => ids.has(s.id)) : [],
  });
});
// Who sees it (`visibility`), or with `branch`, one of its worktrees: its own level, or null to be as its workspace.
// Its owner's.
route("POST", "/api/workspaces/:id/visibility", async (req, res, { params }) => {
  const w = mineToEdit(req, res, params.id);
  if (!w) return;
  const b = await readBody<{ branch?: string; visibility?: string | null }>(req);
  const branch = b.branch ? str(b.branch, 250) : null;
  if (branch ? b.visibility !== null && !isLevel(b.visibility) : !isLevel(b.visibility)) return fail(res, 400, "Private or public?");
  commit({ t: "workspace.visibility", wid: w.id, visibility: b.visibility as Visibility | null, ...(branch ? { branch } : {}) });
  ok(res, { visibility: wsLevel(w), worktrees: w.worktrees || {} });
});
// One of its worktrees, to read: its branch, as the machine of its owner's that has it reads git (never saying in which
// folder), and its pull request, as GitHub has it for its owner. Only one they may see (treeShownTo).
function wsPartOr404(req: Viewer, res: Res, id: string, query: URLSearchParams) {
  const w = state.workspaces[id];
  const x = w && signedPerson(req) ? wsParts(w).find((y) => y.id === query.get("part")) : null;
  if (!x || !treeShownTo(req, w, x)) return void fail(res, 404, "No such worktree.");
  return { w, x };
}
function wsBranch(req: Viewer, res: Res, id: string, query: URLSearchParams) {
  const a = wsPartOr404(req, res, id, query);
  if (a && !a.x.at) return void fail(res, 404, "No machine of its owner's has that branch now.");
  return a;
}
route("GET", "/api/workspaces/:id/worktree", async (req, res, { params, query }) => {
  const a = wsBranch(req, res, params.id, query);
  if (a) await readOf(res, a.x.at.D, "read.wip", { root: a.x.at.f.root, branch: a.x.branch }, { as: wipForOthers });
});
route("GET", "/api/workspaces/:id/worktree/diff", async (req, res, { params, query }) => {
  const a = wsBranch(req, res, params.id, query);
  if (a) await readOf(res, a.x.at.D, "read.wip_diff", { root: a.x.at.f.root, branch: a.x.branch, path: str(query.get("path"), 1000), scope: query.get("scope") === "uncommitted" ? "uncommitted" : "committed" });
});
function wsPull(req: Viewer, res: Res, id: string, query: URLSearchParams) {
  const a = wsPartOr404(req, res, id, query);
  if (!a) return null;
  if (a.x.kind !== "pr") return void fail(res, 400, "That isn't a pull request.");
  const gh = ghFor(a.w.owner);
  if (!gh) return void fail(res, 403, "Its owner doesn't have GitHub connected now.");
  return { ...a, number: a.x.gh.number, gh };
}
route("GET", "/api/workspaces/:id/pull", async (req, res, { params, query }) => {
  const a = wsPull(req, res, params.id, query);
  if (!a) return;
  try {
    ok(res, await pullDetail(a.w.repo, a.number, { host: "agentbook-server", token: a.gh.token }));
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
route("GET", "/api/workspaces/:id/pull/diff", async (req, res, { params, query }) => {
  const a = wsPull(req, res, params.id, query);
  if (!a) return;
  const file = query.get("path") || "";
  if (!file || file.length > 1000) return fail(res, 400, "Say which file.");
  try {
    ok(res, await pullDiff(a.w.repo, a.number, file, str(query.get("sha"), 64), { host: "agentbook-server", token: a.gh.token }));
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
