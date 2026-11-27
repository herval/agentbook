// Tasks: your own to-do list, what agents add to it, and sharing a task.

import crypto from "node:crypto";
import path from "node:path";
import { seenAt, taskForOthers } from "../policy.ts";
import { isLevel } from "../../plugin/shared/visibility.ts";
import { prOfUrl, pullDetail, pullDiff } from "../integrations/pulls.ts";
import { isTalkId } from "../../plugin/shared/talks.ts";
import { BODY_MAX, titled } from "../../plugin/shared/text.ts";
import type { Page, Task, TaskPost, Workspace } from "../../plugin/shared/types.ts";
import { accounts, commit, state, store } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import { elsewhere } from "../core/elsewhere.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { Asker } from "../core/types.ts";
import { isOwner, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { isContact, notContact, seesPost } from "../core/follows.ts";
import { readOf } from "../core/commands.ts";
import { connectors } from "../core/services.ts";
import { partPlace, rowsFor, shipView, taskParts, taskSeenBy, viewForReq } from "./views.ts";
import { ghFor } from "./prs.ts";
import { pageOwner, pageSeen, threadPages } from "./pages.ts";
import { commentThread, notePeopleIds } from "./notes.ts";
import { groupOwner, groupPeople, groupSeen, groupUids, myGroup, uidInGroup, whoOf } from "./groups.ts";
import { talkMine, talkOf, talkSeen } from "./talks.ts";
import { flagsSoon, putIn, shipPartsOf } from "./task-ship.ts";

// Each task belongs to the person who added it, and lives where the page is (the hub, or this machine), like
// workspaces. A task links to any number of posts, and a post to any number of tasks: sending one to an agent
// links it to the post that starts, so the task shows how that goes, and you link others from a post's page.
// An agent's to-do for you (ab_todo) is a task like these, from its post (`from`).
export const taskId = () => `k${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
// Who's on a task: its owner, and the people its owner put on it, who see all of it and every thread on it, and add and
// take off their own threads; the rest is its owner's, ticking it off too. Public: its owner's contacts see it by its
// link, with only the threads on it they'd see anyway.
export const peopleOn = (t: Task) => [t.owner, ...(t.people || []).map((x) => x.user)];
export const onTask = (t: Task, uid: string) => !!t && !!uid && (t.owner === uid || (t.people || []).some((x) => x.user === uid));
// Whether someone not on a task sees it by its link: a public one, to its owner's contacts; never one that's gone, or a
// to-do its thread keeps.
const taskShownTo = (req: Viewer, t: Task) => !!t && !t.removed && !t.scope && seenAt(t.visibility, isContact(req, t.owner));
export const taskSeen = (req: Viewer, t: Task) => !!t && !t.removed && (onTask(t, req.user?.id) || (!!req.user && taskShownTo(req, t)));
// A task as a request may reach it: "see" (on it, or a public one), "work" (on it: put it in their own order, their
// threads on it, Leave) or "own" (its owner: everything else, ticking it off too). 404 for one they may not see, 403 for one they see but
// may not do that to.
export function taskOr404(req: Viewer, res: Res, id: string, need = "work") {
  const t = state.tasks[id];
  const uid = req.user ? req.user.id : null;
  if (!t || !(onTask(t, uid) || (need === "see" && uid && taskShownTo(req, t)))) return void fail(res, 404, "No such task.");
  if (need === "own" && t.owner !== uid) return void fail(res, 403, "Only its owner can do that.");
  return t;
}
// A person's place for a task on their list: its owner's `rank`, or their own.
export const rankFor = (t: Task, uid: string) => (t.owner === uid ? t.rank : (t.ranks?.[uid] ?? t.rank));
// The open tasks on a person's list (theirs, and the ones shared with them), in their order.
export const openTasks = (uid: string) =>
  Object.values(state.tasks)
    .filter((t) => onTask(t, uid) && !t.done && !t.removed && (t.owner === uid || !t.scope))
    .sort((a, b) => rankFor(a, uid) - rankFor(b, uid));
// The threads each person sees through the tasks they're on with others, by the page's ids, each with its work (true).
// Made again once anything changes.
const sharesMemo = new Map();
store.onChange(() => sharesMemo.clear());
// Whose a thread is, by the page's id: a talk's owner, or its machine's.
export function threadOwnerId(id: string) {
  if (isTalkId(id)) return talkOf(id)?.owner || null;
  const p = postRef(id);
  return p ? ownerOf(p.D)?.id || null : null;
}
export function taskShares(uid: string) {
  let out = sharesMemo.get(uid);
  if (out) return out;
  out = new Map();
  for (const t of Object.values(state.tasks)) {
    if (!t.people?.length || t.removed || t.scope || !onTask(t, uid)) continue;
    // Only threads of someone on it: being on a task shares your threads on it with the others, never anyone else's
    // (a thread you see through one task, linked to another, shows through the first only).
    const on = new Set(peopleOn(t));
    for (const id of putIn(t)) if (on.has(threadOwnerId(id))) out.set(id, true);
  }
  sharesMemo.set(uid, out);
  return out;
}
// The threads each person sees through the groups they're in with others, by the
// page's ids, each with its work (true). Only threads
// of someone in it: a person in a group can put only their own threads in it. Made again once anything changes.
const groupSharesMemo = new Map();
store.onChange(() => groupSharesMemo.clear());
export function groupShares(uid: string) {
  let out = groupSharesMemo.get(uid);
  if (out) return out;
  out = new Map();
  const people = new Map(); // gid -> the account ids of everyone in it, for the groups with people that uid is in
  for (const g of Object.values(state.groups)) if (groupPeople(g).length && uidInGroup(g, uid)) people.set(g.id, new Set(groupUids(g)));
  if (people.size) {
    for (const [post, m] of Object.entries(state.group_posts || {})) {
      const on = people.get(m.group);
      if (on && on.has(threadOwnerId(post))) out.set(post, true);
    }
  }
  groupSharesMemo.set(uid, out);
  return out;
}
// The threads each person sees through the pages they keep with others: a page's people are its owner and the people
// it has as contributors, and
// each of them sees every thread on it (threadPages: put there, started from it, or that changed it) that's one of
// theirs, with its work (true). Made again once
// anything changes, or a machine's launches do (a thread started from a page is on it).
export const pageSharesMemo = new Map();
store.onChange(() => pageSharesMemo.clear());
export const pagePeopleIds = (p: Page) => [pageOwner(p), ...(p.contributors || []).filter((c) => c.user).map((c) => accounts.byUsername(c.user)).filter((u) => u && !u.deleted).map((u) => u.id)].filter(Boolean);
export function pageShares(uid: string) {
  let out = pageSharesMemo.get(uid);
  if (out) return out;
  out = new Map();
  const people = new Map(); // page id -> the account ids of everyone keeping it, for the pages with people that uid keeps
  for (const p of Object.values(state.pages)) {
    if (!(p.contributors || []).some((c) => c.user)) continue;
    const ids = pagePeopleIds(p);
    if (ids.length > 1 && ids.includes(uid)) people.set(p.id, new Set(ids));
  }
  if (people.size) {
    for (const [post, pid] of Object.entries(threadPages())) {
      const on = people.get(pid);
      if (on && on.has(threadOwnerId(post))) out.set(post, true);
    }
  }
  pageSharesMemo.set(uid, out);
  return out;
}
// The threads each person sees through the notes they're on with others: the threads its comments talk to that are
// one of theirs (a note's people: its owner and the people on it), each with its work (true). Made again once anything
// changes, or a machine's launches do (a comment's thread starts as a launch).
export const noteSharesMemo = new Map();
store.onChange(() => noteSharesMemo.clear());
export function noteShares(uid: string) {
  let out = noteSharesMemo.get(uid);
  if (out) return out;
  out = new Map();
  for (const n of Object.values(state.notes)) {
    if (!n.comments.length) continue;
    const ids = notePeopleIds(n);
    if (ids.length < 2 || !ids.includes(uid)) continue;
    const on = new Set(ids);
    for (const c of n.comments) {
      const t = commentThread(c);
      if (t && on.has(threadOwnerId(t))) out.set(t, true);
    }
  }
  noteSharesMemo.set(uid, out);
  return out;
}
// Everyone on a task: their threads may be on it now, or not, so their machines are told (flagsSoon).
export const flagsTask = (t: Task) => peopleOn(t).forEach(flagsSoon);
// Tasks from before they had a title and a body: a long one keeps its start as its title, the rest on top of
// its note.
for (const t of Object.values(state.tasks)) {
  const { text, note } = titled(t.text, t.note);
  if (text && text !== t.text) commit({ t: "task.edit", tid: t.id, text, note });
}
// Tasks from when a task was on one page: that page is the first of its pages.
for (const t of Object.values(state.tasks)) if (!Array.isArray(t.pages)) commit({ t: "task.page", tid: t.id });
const myWorkspace = (req: Viewer, id: string) => (id && state.workspaces[id]?.owner === req.user.id ? id : null);
// The agent a task is for, as the page names it (with its machine's prefix when it runs on another one).
const taskAgent = (id: string) => (typeof id === "string" && id ? str(id, 200) : null);
// A page a task can be on: one of the pages you see.
const myPage = (req: Viewer, id: string) => (id && typeof id === "string" && viewForReq(req).pages.some((p) => p.id === id) ? id : null);
// The pages a task is on (any number, as its threads), from before it had them too, when it had one `page`.
export const pagesOfTask = (t: Task) => (Array.isArray(t.pages) ? t.pages.map((e) => e.page) : t.page ? [t.page] : []);
export const onTaskPage = (t: Task, page) => pagesOfTask(t).includes(page);
// A group a task can be in: one of yours (its threads are told its tasks).
const myGroupId = (req: Viewer, id: string) => (id && typeof id === "string" && myGroup(req, state.groups[id]) ? id : null);
route("POST", "/api/tasks", async (req, res) => {
  if (!req.user) return fail(res, 403, "Tasks are kept where the page is.");
  const b = await readBody<{ text?: string; note?: string; rank?: number; sent?: { launch?: string; agent?: string; post?: string; at?: string }[]; posts?: { post?: string; at?: string; by?: string }[]; pages?: (string | { page?: string; at?: string; by?: string })[]; page?: string; group?: string; workspace?: string; agent?: string; done?: boolean }>(req);
  const { text, note } = titled(str(b.text, BODY_MAX), str(b.note, BODY_MAX));
  if (!text) return fail(res, 400, "Write the task.");
  // A new task goes on top. Undoing a delete puts one back where it was, with the sessions it was sent to.
  const open = openTasks(req.user.id);
  const rank = Number.isFinite(b.rank) ? b.rank : open.length ? rankFor(open[0], req.user.id) - 1 : 0;
  const sent = (Array.isArray(b.sent) ? b.sent.slice(0, 20) : []).filter((e) => typeof e?.launch === "string").map((e) => ({ launch: str(e.launch, 200), agent: e.agent ? str(e.agent, 200) : null, post: e.post ? str(e.post, 300) : null, at: str(e.at, 40) || new Date().toISOString() }));
  const posts = (Array.isArray(b.posts) ? b.posts.slice(0, 100) : []).filter((e) => typeof e?.post === "string").map((e) => ({ post: str(e.post, 300), at: str(e.at, 40) || new Date().toISOString(), by: ["sent", "you", "agent"].includes(e.by) ? (e.by as TaskPost["by"]) : "you" }));
  // The pages it's on: `pages` (ids, or { page, at, by } as Undo puts back), or the one `page`.
  const pages = [...(Array.isArray(b.pages) ? b.pages.slice(0, 50) : []), ...(b.page ? [b.page] : [])].map((e): { page?: string; at?: string; by?: string } => (typeof e === "string" ? { page: e } : e)).filter((e) => myPage(req, e?.page)).map((e) => ({ page: e.page, ...(e.at ? { at: str(e.at, 40) } : {}), ...(e.by === "agent" ? { by: "agent" as const } : {}) }));
  const op = commit({ t: "task.add", tid: taskId(), owner: req.user.id, text, note: note || undefined, pages, group: myGroupId(req, b.group), workspace: myWorkspace(req, b.workspace), agent: taskAgent(b.agent), rank, done: !!b.done, sent, posts, who: viewerName(req) });
  ok(res, { id: op.tid });
});
// Its owner's: someone it's shared with adds their threads and changes nothing else.
route("POST", "/api/tasks/:id", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const b = await readBody<{ note?: string; text?: string; workspace?: string | null; agent?: string | null; group?: string | null }>(req);
  // A title too long for one puts the rest on top of its body: the one sent with it, or the one it has.
  const note = b.note === undefined ? undefined : str(b.note, BODY_MAX).trim();
  const split = b.text === undefined ? null : titled(str(b.text, BODY_MAX), note ?? t.note);
  if (split && !split.text) return fail(res, 400, "Write the task.");
  const body = split ? split.note : note;
  commit({ t: "task.edit", tid: t.id, text: split?.text, ...(b.workspace !== undefined ? { workspace: myWorkspace(req, b.workspace) } : {}), ...(b.agent !== undefined ? { agent: taskAgent(b.agent) } : {}), ...(body !== undefined ? { note: body || null } : {}), ...(b.group !== undefined ? { group: myGroupId(req, b.group) } : {}), who: viewerName(req) });
  ok(res);
});
route("POST", "/api/tasks/:id/done", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  commit({ t: "task.done", tid: t.id, done: (await readBody<{ done?: boolean }>(req)).done !== false, who: viewerName(req), user: req.user.id });
  // From a connector that closes issues: its issue closes (or opens again) there, with its owner's connector.
  if (t.source) connectors.ticked(t.id);
  flagsTask(t);
  ok(res);
});
// Moving a task puts it just before another (`before`), or last.
// Each person orders their own list: a task shared with them moves on theirs, not on its owner's.
route("POST", "/api/tasks/:id/move", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id);
  if (!t) return;
  const b = await readBody<{ before?: string }>(req);
  const uid = req.user.id;
  const r = (x) => rankFor(x, uid);
  let others = openTasks(uid).filter((x) => x.id !== t.id);
  const at = b.before ? others.findIndex((x) => x.id === b.before) : others.length;
  if (at < 0) return fail(res, 404, "No such task.");
  // Halving the gap between two tasks runs out of room after many moves: number them again first.
  if (at > 0 && at < others.length && r(others[at]) - r(others[at - 1]) < 1e-6) {
    others.forEach((x, i) => commit({ t: "task.move", tid: x.id, rank: i, user: uid }));
    others = openTasks(uid).filter((x) => x.id !== t.id);
  }
  const rank = !others.length ? 0 : at === 0 ? r(others[0]) - 1 : at === others.length ? r(others.at(-1)) + 1 : (r(others[at - 1]) + r(others[at])) / 2;
  commit({ t: "task.move", tid: t.id, rank, user: uid });
  ok(res);
});
route("POST", "/api/tasks/:id/delete", (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const people = peopleOn(t);
  commit({ t: "task.remove", tid: t.id });
  people.forEach(flagsSoon);
  ok(res);
});
// Link a post you can see to the task (`linked: false` unlinks it). The post's id is the page's, with its
// machine's prefix when it runs on another one.
// On a task shared with others, its owner links any thread they see; anyone else on it adds and takes off their own
// threads only.
route("POST", "/api/tasks/:id/link", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id);
  if (!t) return;
  const b = await readBody<{ post?: string; linked?: boolean }>(req);
  const post = str(b.post, 300);
  if (!post) return fail(res, 400, "Say which thread.");
  const linked = b.linked !== false;
  // A thread you see: one on a machine, or one you started yourself (a talk).
  if (linked && !(isTalkId(post) ? talkSeen(req, talkOf(post)) : viewForReq(req).sessions.some((s) => s.id === post))) return fail(res, 404, "No such thread.");
  if (t.owner !== req.user.id) {
    const p = postRef(post);
    const theirs = p ? isOwner(req, p.D) : isTalkId(post) && talkMine(req, talkOf(post));
    if (!theirs) return fail(res, 403, linked ? "You add your own threads to it: only its owner adds others'." : "Only its thread's owner, or the task's, takes a thread off it.");
  }
  commit({ t: "task.link", tid: t.id, post, linked, user: req.user.id });
  flagsTask(t);
  ok(res);
});
// Link a page you can see to the task (`linked: false` unlinks it): it's on that page's checklist, and the page
// says it has it.
route("POST", "/api/tasks/:id/page", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const b = await readBody<{ page?: string; linked?: boolean }>(req);
  const page = str(b.page, 200);
  if (!page) return fail(res, 400, "Say which page.");
  const linked = b.linked !== false;
  if (linked && !myPage(req, page)) return fail(res, 404, "No such page.");
  commit({ t: "task.page", tid: t.id, page, linked, by: "you" });
  ok(res);
});
// The person's tasks for an agent (its ab_tasks): the open ones, those for it first (linked to its post, then for
// its agent, then in its workspace), then the rest in their order; and the ones ticked in the last day, so it can
// untick a slip. `me` is its post as the tasks know it: { post, launch, agent, root, remote, machine }, the page's ids.
export const AGENT_TASKS = 40;
export function tasksForAgent(owner, me: Asker) {
  // Another thread's to-dos are that thread's (scope "thread"): not on the person's list. The ones shared with them
  // are, saying whose.
  const mine = Object.values(state.tasks).filter((t) => onTask(t, owner) && !t.removed && (!t.scope || (t.owner === owner && t.from === me.post)));
  const name = (id) => accounts.byId(id)?.username || "someone";
  const whose = (t) => (t.owner !== owner || t.people?.length ? { owner: t.owner === owner ? null : name(t.owner), with: peopleOn(t).filter((u) => u !== owner).map(name) } : {});
  const wsOf = new Map(Object.values(state.workspaces).filter((w) => w.owner === owner).map((w) => [w.id, w]));
  const inWs = (w) => inWorkspace(w, me);
  // The connectors that close an issue when its task is ticked: the person's (one shared with them isn't theirs to tick).
  const closing = new Map(connectors.summary(owner).filter((c) => c.close && !c.off).map((c) => [c.id, c.name]));
  const linked = (t) => (!!me.post && t.posts.some((e) => e.post === me.post)) || (!!me.launch && t.sent.some((e) => e.launch === me.launch));
  const gid = me.post ? state.group_posts[me.post]?.group || null : null;
  const whyFor = (t) => (linked(t) ? "post" : gid && t.group === gid ? "group" : me.agent && t.agent === me.agent ? "agent" : inWs(wsOf.get(t.workspace)) ? "workspace" : null);
  const row = (t) => ({ id: t.id, text: t.text, ...(t.note ? { note: t.note } : {}), workspace: wsOf.get(t.workspace)?.name || null, page: pagesOfTask(t).map(pageTitle).filter(Boolean).join('", "') || null, group: t.group ? state.groups[t.group]?.name || null : null, for: whyFor(t), from: t.from ? postLabel(t.from) || "an agent" : null, mine: !!me.post && t.from === me.post, source: t.source?.key || null, closes: (t.owner === owner && t.source && closing.get(t.source.connector)) || null, done: t.done, done_at: t.done_at, done_by: t.done_by || null, by_me: !!me.post && t.done_post === me.post, ...(t.scope ? { thread: true } : {}), ...whose(t) });
  const first = { post: 0, group: 1, agent: 2, workspace: 3 };
  return {
    open: mine.filter((t) => !t.done).sort((a, b) => rankFor(a, owner) - rankFor(b, owner)).map(row).sort((a, b) => (first[a.for] ?? 4) - (first[b.for] ?? 4)),
    done: mine.filter((t) => t.done && Date.now() - Date.parse(t.done_at) < 86400e3).map(row),
  };
}
// An agent ticks (or unticks) one of the person's tasks from its post (`by`). Null when it isn't on their list. One
// shared with them is its owner's to tick: it hears so (`refused`; `error` says it to a plugin older than that).
export function tickForAgent(owner: string, id: string, done: boolean, by: string): { id: string; text: string; refused?: string; error?: string; ok?: boolean; closes?: string; source?: string | null } | null {
  const t = state.tasks[id];
  if (!t || !onTask(t, owner) || t.removed) return null;
  if (t.owner !== owner) {
    const why = `only its owner, @${accounts.byId(t.owner)?.username || "someone"}, ticks it off or puts it back`;
    return { id, text: t.text, refused: why, error: why };
  }
  if (t.done === done) return { id, text: t.text };
  commit({ t: "task.done", tid: t.id, done, by, who: whoOf(by) || undefined });
  flagsTask(t);
  // From a connector that closes issues: its issue closes (or opens again) there, as when the person ticks it.
  if (t.source) connectors.ticked(t.id);
  const c = t.source && connectors.summary(t.owner).find((x) => x.id === t.source.connector && x.close && !x.off);
  return { id, text: t.text, ok: true, ...(c ? { closes: c.name, source: t.source.key || null } : {}) };
}
// An agent links its post to one of the person's tasks, or unlinks it. Null when it isn't theirs here.
// On a task shared with others, it's told who: they see its thread now.
export function linkForAgent(owner, id: string, post: string, linked) {
  const t = state.tasks[id];
  if (!t || !onTask(t, owner) || t.removed) return null;
  const shared = peopleOn(t).filter((u) => u !== owner).map((u) => accounts.byId(u)?.username).filter(Boolean);
  const also = shared.length ? { shared_with: shared } : {};
  if (t.posts.some((e) => e.post === post) === linked) return { id, text: t.text, ...also };
  commit({ t: "task.link", tid: t.id, post, linked, by: post });
  flagsTask(t);
  return { id, text: t.text, ok: true, ...also };
}
// An agent's to-do for the person (ab_todo), from its post (`me.post`) and linked to it, its title and body as
// titled() makes them: one its thread keeps, on the thread and not on their Tasks (most of them: review my pull
// request, restart agentbook, sign in), or, `later`, a task of theirs on top of their list,
// in the workspace the post works in and the group it's in, for what outlives the thread. Unless it's `fresh`, an
// open one that looks the same stops it: { same } says which, for the agent to link its post to. `was`: one moved
// from before to-dos were tasks, as it was then.
// The answers an agent's to-do offers (ab_todo's answers): up to 4 buttons on its row, each what pressing it sends
// as your message ("Confirmed", "Mirror"), so a decision is a row you answer with a click.
export const answersOf = (v) =>
  (Array.isArray(v) ? v : [])
    .slice(0, 4)
    .map((a) => (typeof a === "string" ? { label: a } : a && typeof a === "object" ? a : null))
    .filter((a) => a && str(a.label, 40))
    .map((a) => ({ label: str(a.label, 40), says: str(a.says, 200) || str(a.label, 40) }));
export function todoForAgent(owner, me: Asker, { text, note, answers }, { fresh = false, was = null, later = true } = {}) {
  const open = openTasks(owner).filter((t) => !t.scope || t.from === me.post);
  const same = !fresh && open.find((t) => alike(text, t.text));
  if (same) return { same: { id: same.id, text: same.text, from: same.from ? postLabel(same.from) || "an agent" : null, thread: same.scope === "thread" } };
  const ws = Object.values(state.workspaces).find((w) => w.owner === owner && inWorkspace(w, me));
  const gid = later && me.post ? state.group_posts[me.post]?.group : null;
  const group = gid && groupOwner(state.groups[gid]) === owner ? gid : null;
  const at = was?.added || new Date().toISOString();
  // On top: above the done ones too, so ticking one back doesn't put two in one place.
  const ranks = Object.values(state.tasks).filter((t) => onTask(t, owner) && !t.removed).map((t) => rankFor(t, owner));
  const op = commit({ t: "task.add", tid: taskId(), owner, text, note: note || undefined, ...(answers?.length ? { answers } : {}), workspace: ws?.id || null, ...(group ? { group, who: whoOf(me.post) || undefined } : {}), rank: ranks.length ? Math.min(...ranks) - 1 : 0, from: me.post, posts: [{ post: me.post, at, by: "agent" }], ...(was ? { added: was.added, done: was.done, done_at: was.done_at } : {}), ...(later ? { later: true } : { scope: "thread" }) });
  return { id: op.tid, ...(later ? {} : { thread: true }) };
}
// Whether a post works in a workspace: in its repo, or in one of its folders on the post's machine.
export const inWorkspace = (w: Workspace, me: Asker) => !!w && ((w.repo && w.repo === me.remote) || (!!me.root && w.folders.some((f) => f.machine === me.machine && (me.root === f.path || me.root.startsWith(f.path + path.sep)))));
// Two tasks about the same thing, to notice an agent's to-do that's already on the list: they share most of
// the words of the shorter one, or many words.
const STOP = new Set("the and for with that this from into your you are was were has have its but not can run then them they when what which will".split(" "));
const gist = (text) => new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []).filter((w) => !STOP.has(w)));
export function alike(a, b) {
  const A = gist(a);
  const B = gist(b);
  const n = [...A].filter((w) => B.has(w)).length;
  return (n >= 3 && n >= 0.6 * Math.min(A.size, B.size)) || n >= 6;
}
// A post's name ("finch"), by the page's id.
export function postLabel(key) {
  return postRef(key)?.s.label || null;
}
// A page's title, or its id when it's gone.
const pageTitle = (id: string) => state.pages[id]?.title || id;
// A to-do a thread keeps for you (ab_todo) onto your Tasks, from its For you list: it outlives the thread.
route("POST", "/api/tasks/:id/later", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  if (t.scope) commit({ t: "task.scope", tid: t.id, scope: null });
  ok(res);
});
// Undoing the delete of a task from a connector: it was only put out of sight.
route("POST", "/api/tasks/:id/restore", (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  commit({ t: "task.restore", tid: t.id });
  ok(res);
});

// --- sharing a task ---
// Put someone with an account here on a task (on top of their list), or take them off (`remove`). Its owner's.
route("POST", "/api/tasks/:id/people", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  if (t.scope) return fail(res, 400, "It's a to-do its thread keeps: move it to your Tasks first.");
  const b = await readBody<{ user?: string; remove?: boolean }>(req);
  const u = accounts.byUsername(str(b.user, 80).trim().replace(/^@/, ""));
  if (!u || u.deleted || (u.disabled && !b.remove)) return fail(res, 404, "No one with that username here.");
  if (u.id === t.owner) return fail(res, 400, "That's its owner, who's always on it.");
  const stranger = b.remove ? null : notContact(t.owner, u);
  if (stranger) return fail(res, 409, stranger);
  const asked = elsewhere.ask(`task:${t.id}`, t.text, u.id, !!b.remove);
  if (asked) return asked.error ? fail(res, asked.status || 400, asked.error) : ok(res, asked);
  if (b.remove) commit({ t: "task.person", tid: t.id, user: u.id, remove: true, by: viewerName(req) });
  else if (!onTask(t, u.id)) {
    const open = openTasks(u.id);
    commit({ t: "task.person", tid: t.id, user: u.id, rank: open.length ? rankFor(open[0], u.id) - 1 : 0, by: viewerName(req) });
  }
  flagsSoon(u.id);
  ok(res, { user: u.username });
});
// Take yourself off a task shared with you.
route("POST", "/api/tasks/:id/leave", (req, res, { params }) => {
  const t = taskOr404(req, res, params.id);
  if (!t) return;
  if (t.owner === req.user.id) return fail(res, 400, "It's yours: take the others off it, or delete it.");
  commit({ t: "task.person", tid: t.id, user: req.user.id, remove: true, by: viewerName(req) });
  flagsSoon(req.user.id);
  ok(res);
});
// Who sees it besides its people (`visibility`: private, or public to its owner's contacts). Its owner's. Its people always see its
// threads' work: there's no switching that off any more (an old page's `show_work` is ignored).
route("POST", "/api/tasks/:id/visibility", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const b = await readBody<{ visibility?: string }>(req);
  if (!isLevel(b.visibility)) return fail(res, 400, "Private or public?");
  if (t.scope && b.visibility !== "private") return fail(res, 400, "It's a to-do its thread keeps: move it to your Tasks first.");
  commit({ t: "task.visibility", tid: t.id, visibility: b.visibility });
  ok(res);
});
// A task by its link: as someone on it sees it, or a public one as its owner's contacts do; with rows of the threads on
// it they may see.
route("GET", "/api/tasks/:id", (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "see");
  if (!t) return;
  const uid = req.user.id;
  const ids = putIn(t);
  const name = (id) => accounts.byId(id)?.username || null;
  const o = { user: req.user };
  const shown = (id) => (isTalkId(id) ? talkSeen(req, talkOf(id)) : seesPost(req, postRef(id)));
  const task: (ReturnType<typeof taskSeenBy> | ReturnType<typeof taskForOthers>) & { parts?: ReturnType<typeof taskParts> } = onTask(t, uid)
    ? taskSeenBy(t, uid)
    : taskForOthers(t, {
        ownerName: name(t.owner),
        people: (t.people || []).map((x) => ({ user: name(x.user), at: x.at })).filter((x) => x.user),
        postShown: shown,
        pageShown: (id) => pageSeen(o, id),
        groupShown: (id) => !!groupSeen(req, state.groups[id]),
      });
  // One they're not on (a public one): what it ships too, with the threads on each they see.
  if (!onTask(t, uid)) task.parts = taskParts(t, shown);
  ok(res, { task: shipView(task), threads: rowsFor(req, (s) => ids.has(s.id)) });
});
// A pull request's or a branch's worktree on a task you're on: its page as its owner's
// shows it, to read only. Its branch is read on the machine of whoever on the task has it
// (partPlace), never saying in which folder; a pull request from GitHub, with the connection of someone on it whose
// thread works on it, else its owner's.
function taskPartOr404(req: Viewer, res: Res, id: string, query: URLSearchParams) {
  const t = taskOr404(req, res, id, "work");
  if (!t) return null;
  const x = shipPartsOf(t).find((y) => y.id === query.get("part"));
  if (!x) return void fail(res, 404, "That isn't on it.");
  return { t, x };
}
export const wipForOthers = ({ root, worktree, ...d }) => ({ ...d, checked_out: !!worktree });
function partBranch(req: Viewer, res: Res, id: string, query: URLSearchParams) {
  const a = taskPartOr404(req, res, id, query);
  const at = a && partPlace(a.t, a.x);
  if (a && !at) fail(res, 404, "No machine of anyone on it has that branch now.");
  return at ? { ...a, at } : null;
}
route("GET", "/api/tasks/:id/worktree", async (req, res, { params, query }) => {
  const a = partBranch(req, res, params.id, query);
  if (a) await readOf(res, a.at.D, "read.wip", { root: a.at.f.root, branch: a.x.branch }, { as: wipForOthers });
});
route("GET", "/api/tasks/:id/worktree/diff", async (req, res, { params, query }) => {
  const a = partBranch(req, res, params.id, query);
  if (a) await readOf(res, a.at.D, "read.wip_diff", { root: a.at.f.root, branch: a.x.branch, path: str(query.get("path"), 1000), scope: query.get("scope") === "uncommitted" ? "uncommitted" : "committed" });
});
function partPull(req: Viewer, res: Res, id: string, query: URLSearchParams) {
  const a = taskPartOr404(req, res, id, query);
  if (!a) return null;
  const pr = a.x.kind === "pr" ? prOfUrl(a.x.url) : null;
  if (!pr) return void fail(res, 400, "That isn't a pull request.");
  const on = new Set(peopleOn(a.t));
  const who = [...(a.x.posts || []).map((id) => postRef(id)).filter(Boolean).map((p) => ownerOf(p.D)?.id), a.t.owner].filter((uid) => uid && on.has(uid));
  const gh = who.map(ghFor).find(Boolean);
  if (!gh) return void fail(res, 403, "Nobody on it has GitHub connected.");
  return { ...a, key: `github.com/${pr.repo}`, number: pr.number, gh };
}
route("GET", "/api/tasks/:id/pull", async (req, res, { params, query }) => {
  const a = partPull(req, res, params.id, query);
  if (!a) return;
  try {
    ok(res, await pullDetail(a.key, a.number, { host: "agentbook-server", token: a.gh.token }));
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
route("GET", "/api/tasks/:id/pull/diff", async (req, res, { params, query }) => {
  const a = partPull(req, res, params.id, query);
  if (!a) return;
  const file = query.get("path") || "";
  if (!file || file.length > 1000) return fail(res, 400, "Say which file.");
  try {
    ok(res, await pullDiff(a.key, a.number, file, str(query.get("sha"), 64), { host: "agentbook-server", token: a.gh.token }));
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});
