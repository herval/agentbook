import path from "node:path";
import { agentPublic, groupFileFor, groupFor, knownBy } from "../policy.ts";
import { isLevel, levelOf } from "../../plugin/shared/visibility.ts";
import { byName, cleanPath, FILE_MAX, fileVersions, filesOf as groupFilesOf, groupBlock, groupId, groupOverview, groupSummary, newsFor, notesOf, postForGroup, postNews, postsIn } from "../../plugin/shared/groups.ts";
import { conversationOf } from "../../plugin/shared/store.ts";
import { capsOf } from "../../plugin/shared/runtimes.ts";
import { uuidv7 } from "../../plugin/shared/ids.ts";
import type { User } from "../accounts.ts";
import type { Device } from "../relay.ts";
import type { Group } from "../../plugin/shared/types.ts";
import { accounts, blobs, commit, firstAdmin, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import { noFullAccess } from "../core/guards.ts";
import { elsewhere } from "../core/elsewhere.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { Asker, PostRef, ReadAnswer, StepsAnswer, WipBody } from "../core/types.ts";
import { agentRef, isOwner, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { isContact, notContact, seesPost } from "../core/follows.ts";
import { rowsFor } from "./views.ts";
import { SELF_URL, titleOf } from "./cli.ts";
import { fileHeaders } from "./files.ts";
import { pageNewsFor } from "./pages.ts";
import { ownersAgent, threadOf } from "./routines.ts";
import { threadNewsFor } from "./guests.ts";
import { taskNewsFor } from "./task-ship.ts";


// A group is its owner's, like a page: private (they and the people in it see it) or public (their contacts see what
// policy.ts says of it). The people its owner puts in it by @username (`members`
// with a `user`) see all of it and every thread in it, and edit its brief, leave notes, change its files and add
// their own threads; the rest is its owner's. Its threads are on their machines, and each of them keeps its folder
// (plugin/cli/group-files.ts); every version of each file is kept here, by its sha256 (blobs.ts).
export const groupOwner = (g: Group) => g?.owner || firstAdmin()?.id || null;
export const myGroup = (req: Viewer, g: Group) => !!req.user && !!g && groupOwner(g) === req.user.id;
// The people in a group besides its owner, by username, and everyone in it (its owner first), by account id.
export const groupPeople = (g: Group) => (g?.members || []).filter((m) => m.user).map((m) => m.user);
export const groupUids = (g: Group) => [groupOwner(g), ...groupPeople(g).map((u) => accounts.byUsername(u)).filter((u) => u && !u.deleted).map((u) => u.id)].filter(Boolean);
export const uidInGroup = (g: Group, uid: string) => !!g && !!uid && groupUids(g).includes(uid);
// A request's person is in it: its owner, or one of its people.
export const inGroup = (req: Viewer, g: Group) => !!req.user && uidInGroup(g, req.user.id);
// What a viewer may know of who did something in a group: an agent of theirs, or a public one of a contact's; a thread
// they see.
const agentKnown = (req: Viewer, id: string) => {
  const r = agentRef(id);
  return !!r && (isOwner(req, r.D) || (agentPublic(r.a) && isContact(req, ownerOf(r.D)?.id)));
};
const groupShownFor = (req: Viewer) => ({ agentShown: (id) => agentKnown(req, id), postShown: (id) => seesPost(req, postRef(id)) });
// A group (`full`: it in brief, or more) as a request's person sees it, or null.
export const groupSeen = (req: Viewer, g: Group, full = g) => (req.user ? groupFor(full, { owner: myGroup(req, g), person: inGroup(req, g), contact: isContact(req, groupOwner(g)), ownerName: accounts.byId(groupOwner(g))?.username || null, ...groupShownFor(req) }) : null);
const groupFileSeen = (req: Viewer, g: Group, v) => (myGroup(req, g) ? v : groupFileFor(v, groupShownFor(req).agentShown, groupShownFor(req).postShown));
const groupLink = (id: string) => `${SELF_URL}/#/groups/${encodeURIComponent(id)}`;
const GROUP_DIR = (dir, gid: string) => `${dir || "~/.agentbook/groups"}/${gid}`;
const REPLACED_MS = 30 * 60e3;
// A thread's name in a group's lines: "heron (Codex)".
export function whoOf(id: string) {
  const p = postRef(id);
  return p ? `${p.s.label} (${p.agent?.name || p.s.agent})` : null;
}
// The same in a group's lines, with whose it is when it isn't the group's owner's: "@banana's heron (Codex)".
function whoIn(id: string, gid: string) {
  const w = whoOf(id);
  const o = w && state.groups[gid] ? ownerOf(postRef(id).D) : null;
  return o && o.id !== groupOwner(state.groups[gid]) ? `@${o.username}'s ${w}` : w;
}
// What a thread of `o`'s is told of who's in group `g` (groups.ts's `f`): its person's username, its owner's, and
// that the people in it see its threads' work (always).
const groupWho = (g: Group, o: User) => ({ username: o?.username || null, owner: accounts.byId(groupOwner(g))?.username || null, work: true });
// The state groups.ts reads: the server's groups, with the threads in them (and any other thread a line names),
// their agents and what they ask, from their machines, by the page's ids. `messagesOf`: one thread's messages too.
export function groupState({ messagesOf = null } = {}) {
  const posts = {};
  const questions = [];
  for (const [post, m] of Object.entries(state.group_posts || {})) {
    const p = postRef(post);
    if (!p) continue;
    posts[post] = { ...p.s, id: post, agent: relay.idOf(p.D, p.s.agent), group: m.group, group_seen: m.seen, owner: ownerOf(p.D)?.username || null };
    for (const q of p.D.store.state.questions) if (q.post === p.local && !q.answered) questions.push({ ...q, post });
  }
  const sessions = new Proxy(posts, { get: (t, id) => (typeof id === "string" ? t[id] || threadOf(id) : undefined) });
  const agents = new Proxy({}, { get: (_, id) => (typeof id === "string" ? agentRef(id)?.a : undefined) });
  const p = messagesOf && postRef(messagesOf);
  const messages = p ? conversationOf(p.D.store.state, p.local).map((x) => ({ ...x, post: messagesOf })) : [];
  return { ...state, sessions, agents, questions, messages };
}
// What a thread in a group is told about it (context.ts puts it after its own lines): for `post`, or for a launch
// in group `gid` before its session is there. `dir`: where groups' folders are on its machine.
// The agents that read and write a group's folder themselves are the ones agentbook starts in the background with it
// (its runtime's `groupFolders`).
export function groupFacts(post: string, gid: string, { kind = null as string | null, dir = null, o = null } = {}) {
  const gs = groupState();
  const s = post ? gs.sessions[post] : null;
  const g = state.groups[s ? s.group : gid];
  if (!g) return null;
  return groupBlock(gs, post, { gid: g.id, link: groupLink(g.id), dir: GROUP_DIR(dir, g.id), person: o?.display_name || o?.username || null, folder: capsOf(kind).groupFolders, tools: capsOf(kind).tools === "sure", ...groupWho(g, o) });
}
// What changed in a thread's group since it last heard, as one message to hand it with what it gets anyway; null
// when nothing did. Marks it told.
function groupNewsFor(post: string) {
  const n = newsFor(groupState(), post);
  if (!n) return null;
  commit({ t: "group.seen", post, upto: n.upto });
  return n.text;
}

// A group's files as they stand, for its owner's machines' folders: each path's latest version.
function groupFileList(gid: string) {
  const latest = new Map();
  for (const v of state.group_files) if (v.group === gid) latest.set(v.path, v);
  return [...latest.values()].map((v) => ({ path: v.path, v: v.v, sha: v.deleted ? null : v.sha, size: v.size || 0, ...(v.deleted ? { deleted: true } : {}) }));
}
// The machines of everyone in it that are on, told how its files stand: each makes its folder the same. `wait`: how
// long to wait for them (a person's change shows in the folder before they hear back). A machine that's off asks
// when it's back (group/list).
export async function syncGroup(gid: string, { wait = 0, except = null } = {}) {
  const g = state.groups[gid];
  if (!g) return;
  const files = groupFileList(gid);
  const uids = new Set(groupUids(g));
  const machines = [...relay.devices.values()].filter((D) => D !== except && uids.has(ownerOf(D)?.id) && relay.online(D));
  await Promise.all(machines.map((D) => relay.command(D, "group.sync", { gid, files, archived: !!g.archived }, { by: ownerOf(D)?.username || null, wait }).catch(() => null)));
}
// A version of one of a group's files: its bytes kept here by their sha256, or that it was deleted (`content`
// null). Nothing new when it's what the latest version says already. -> the latest version.
function groupRecord(gid: string, p, content, by, { restored = null } = {}) {
  const last = fileVersions(state, gid, p).at(-1) || null;
  if (!content) {
    if (last && !last.deleted) commit({ t: "group.file", gid, path: p, v: last.v + 1, by, deleted: true, who: by?.post ? whoIn(by.post, gid) : undefined });
  } else if (!last || last.deleted || last.sha !== content.sha) {
    const replaced = last && !last.deleted && last.by?.post && last.by.post !== by?.post && Date.now() - Date.parse(last.at) < REPLACED_MS ? last.by.post : null;
    commit({ t: "group.file", gid, path: p, v: (last?.v || 0) + 1, by, size: content.size, sha: content.sha, restored, replaced, replaced_label: replaced ? postRef(replaced)?.s.label : undefined, who: by?.post ? whoIn(by.post, gid) : undefined });
  }
  return fileVersions(state, gid, p).at(-1) || null;
}
// A person's write to a group's file (or a restore): its bytes kept, and a version. -> the version.
export function groupWrite(gid: string, p, buf, by, opts = {}) {
  const rel = cleanPath(p);
  if (!rel) throw new Error("That isn't a path inside the group's folder.");
  if (buf.length > FILE_MAX) throw new Error("A group's file can be up to 10 MB.");
  return groupRecord(gid, rel, { sha: blobs.put(buf, groupOwner(state.groups[gid])), size: buf.length }, by, opts);
}
// A file's content: its latest version, or version `v`. Null when there's no such file or version.
function groupRead(gid: string, p, v = null) {
  const rel = cleanPath(p);
  const versions = rel ? fileVersions(state, gid, rel) : [];
  const ver = v ? versions.find((x) => x.v === Number(v)) : versions.at(-1);
  const buf = ver && !ver.deleted ? blobs.read(ver.sha) : null;
  return buf ? { version: ver, buf } : null;
}
// Whether bytes by this sha256 are a version of a file in a group this person is in (a machine of theirs fetches them).
export const groupBlobOf = (sha, uid: string) => state.group_files.some((v) => v.sha === sha && uidInGroup(state.groups[v.group], uid));
// Whether a machine may name bytes by their sha256: its person sent them, from a machine of theirs or the page, or
// they're a version of a file in one of their groups. Knowing a sha256 isn't having the bytes.
export function blobOk(D: Device, sha) {
  const uid = D?.user_id;
  return !!uid && (blobs.theirs(sha, uid) || groupBlobOf(sha, uid));
}

// A thread joins a group, moves to another, or leaves it (`gid` null): kept here, and its machine told (its folder
// is one its session may write, and it hears the group's news).
export async function groupPost(gid: string, p: PostRef, by, { wait = 15e3, launch = null } = {}) {
  commit({ t: "group.post", gid, post: p.id, agent: relay.idOf(p.D, p.s.agent), who: whoIn(p.id, gid), title: titleOf(p.s), by, ...(launch ? { launch } : {}) });
  await relay.command(p.D, "post.group", { post: p.local, gid: state.group_posts[p.id]?.group || null }, { by: ownerOf(p.D)?.username || null, wait }).catch(() => null);
}
// What a thread in a group did that the others should hear, as its machine's ops arrive (a result, a question, its
// end); and a thread started in a group, which joins it once its session is there.
export function groupsHear(D: Device, op) {
  if (!op?.t || !state.group_posts) return;
  if (op.t === "session.hello" || op.t === "launch.started") {
    const st = D.store.state;
    const l = op.t === "launch.started" ? st.launches[op.lid] : st.launches[st.sessions[st.procs[op.proc]]?.launch];
    const g = l?.group && state.groups[l.group];
    if (!g || g.archived || !l.post || !uidInGroup(g, ownerOf(D)?.id)) return;
    const lid = relay.idOf(D, l.id);
    const p = postRef(relay.idOf(D, l.post));
    if (p && !state.group_launched?.[lid] && !state.group_posts[p.id]) setImmediate(() => groupPost(g.id, p, null, { wait: 0, launch: lid }).catch(() => {}));
    return;
  }
  if (!op.post || !["session.update", "question.ask", "session.gone"].includes(op.t)) return;
  const post = relay.idOf(D, op.post);
  const m = state.group_posts[post];
  const n = m && state.groups[m.group] && postNews(op, whoIn(post, m.group) || post);
  if (n) setImmediate(() => commit({ t: "group.news", gid: m.group, post, kind: n.kind, text: n.text }));
}

// A group as a request may reach it: "see" (a public one too), "in" (its owner or a person in it: its brief, notes,
// files, their own threads and agents) or "own" (its owner: who's in it, who sees it, its name, WIP, Archive). A 404
// for one they aren't in and may not see, as for one that doesn't exist (someone who only sees a public one too,
// for anything but looking); a 403 for a person in it asking for its owner's part.
function groupOr404(req: Viewer, res: Res, id: string, need = "own") {
  const g = state.groups[id];
  if (!(inGroup(req, g) || (need === "see" && g && groupSeen(req, g)))) return void fail(res, 404, "No such group");
  if (need === "own" && !myGroup(req, g)) return void fail(res, 403, "Only its owner can do that.");
  return g;
}
export const byYou = (req: Viewer) => ({ user: viewerName(req) });
function groupDetail(g: Group) {
  const gs = groupState();
  const posts = postsIn(gs, g.id);
  const live = posts.find((s) => s.state !== "done" && !s.archived);
  return {
    ...groupSummary(gs, g),
    link: groupLink(g.id),
    dir: GROUP_DIR(null, g.id),
    thread_ids: posts.map((s) => s.id),
    notes: notesOf(gs, g.id).slice().reverse(),
    file_list: groupFilesOf(gs, g.id),
    events: state.group_events.filter((e) => e.group === g.id).slice(-80).reverse(),
    // Word for word, what a thread in it is told when it starts, and with the next message it gets.
    told: { as: live?.label || null, start: groupFacts(live?.id || null, g.id, { o: accounts.byId(groupOwner(g)) }), news: state.group_events.filter((e) => e.group === g.id && e.post !== live?.id).slice(-4).map((e) => `  ${e.text}`).join("\n") },
  };
}
// A group in full as this request sees it: all of it for its owner; for a person in it, all of it but what its
// threads are told (its owner's Brief tab), and who did what as they may know it; for anyone else, what it is, its
// files, and the threads in it they may see; no notes, what happened in it, or what its threads are told.
function groupDetailFor(req: Viewer, g: Group) {
  if (myGroup(req, g)) return { ...groupSeen(req, g, groupDetail(g)) };
  if (inGroup(req, g)) {
    const d = groupDetail(g);
    const { agentShown, postShown: shown } = groupShownFor(req);
    const ids = d.thread_ids.filter((id) => shown(id));
    return { ...groupSeen(req, g, d), posts: ids.length, thread_ids: ids, notes: d.notes.map((n) => ({ ...n, by: knownBy(n.by, agentShown, shown), for: n.for && shown(n.for) ? n.for : null })), file_list: d.file_list.map((v) => groupFileSeen(req, g, v)), events: d.events.map(({ post, ...e }) => (post && shown(post) ? { ...e, post } : e)), told: null };
  }
  const gs = groupState();
  const shown = postsIn(gs, g.id).filter((s) => seesPost(req, postRef(s.id)));
  return { ...groupSeen(req, g, groupSummary(gs, g)), posts: shown.length, link: groupLink(g.id), dir: null, thread_ids: shown.map((s) => s.id), notes: [], file_list: groupFilesOf(gs, g.id).map((v) => groupFileSeen(req, g, v)), events: [], told: null };
}
// The groups a person sees on their page, in brief: theirs, and others' public ones.
export const groupsOf = (req: Viewer) => {
  if (!req.user) return [];
  const gs = groupState();
  return Object.values(state.groups)
    .map((g) => groupSeen(req, g, groupSummary(gs, g)))
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
};

// --- you, from the web UI ---
route("GET", "/api/groups/:id", (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "see");
  // With rows of its threads they may see (the archived ones too, which the chrome has none of).
  if (g) ok(res, { ...groupDetailFor(req, g), threads: rowsFor(req, (s) => s.group === g.id) });
});
route("POST", "/api/groups", async (req, res) => {
  if (!req.user) return fail(res, 401, "Sign in first.");
  // Its folder is on its owner's machines, so there's one to keep it.
  if (![...relay.devices.values()].some((D) => isOwner(req, D))) return fail(res, 403, "A group's files are a folder on your machines: log one in to this agentbook first (agentbook-cli login).");
  const b = await readBody<{ name?: string; post?: string; agents?: string[]; emoji?: string; brief?: string; visibility?: string }>(req);
  const name = str(b.name, 80).trim();
  if (!name) return fail(res, 400, "A group needs a name.");
  const gid = groupId(name, (id) => !!state.groups[id]);
  const p = b.post ? postRef(str(b.post, 300)) : null;
  const post = p && isOwner(req, p.D) ? p : null;
  const agents = [...new Set([...(Array.isArray(b.agents) ? b.agents : []).map((a) => ownersAgent(req, a)).filter(Boolean), ...(post ? [relay.idOf(post.D, post.s.agent)] : [])])];
  commit({ t: "group.create", gid, owner: req.user.id, name, emoji: b.emoji ? str(b.emoji, 16).trim() : undefined, brief: str(b.brief, 8000), visibility: levelOf(b.visibility), by: byYou(req), members: agents.map((agent) => ({ agent })) });
  if (post) await groupPost(gid, post, byYou(req));
  await syncGroup(gid, { wait: 15e3 });
  ok(res, { id: gid });
});
route("POST", "/api/groups/:id", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ name?: string; emoji?: string; brief?: string | null }>(req);
  // The people in it change its brief; its name and emoji are its owner's.
  if ((b.name || b.emoji) && !myGroup(req, g)) return fail(res, 403, "Only its owner renames it.");
  commit({ t: "group.edit", gid: g.id, name: b.name ? str(b.name, 80).trim() : undefined, emoji: b.emoji ? str(b.emoji, 16).trim() : undefined, brief: b.brief != null ? str(b.brief, 8000) : undefined, by: byYou(req) });
  ok(res);
});
// Who sees it besides the people in it (`visibility`: private or public). Its owner's. The people in it
// always see its threads' work.
route("POST", "/api/groups/:id/visibility", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id);
  if (!g) return;
  const { visibility } = await readBody<{ visibility?: string }>(req);
  if (!isLevel(visibility)) return fail(res, 400, "Private or public?");
  commit({ t: "group.visibility", gid: g.id, visibility });
  ok(res);
});
// Who's in it. An agent (`agent`): anyone in it adds theirs, or takes it out; its owner takes out anyone's. A person
// (`user`, by username): its owner puts them in or takes them out, and their threads and agents leave with them.
route("POST", "/api/groups/:id/members", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ user?: string | null; remove?: boolean; agent?: string }>(req);
  if (b.user != null) {
    if (!myGroup(req, g)) return fail(res, 403, "Only its owner says who's in it.");
    const u = accounts.byUsername(str(b.user, 80).trim().replace(/^@/, ""));
    if (!u || u.deleted || (u.disabled && !b.remove)) return fail(res, 404, "No one with that username here.");
    if (u.id === groupOwner(g)) return fail(res, 400, "That's its owner, who's always in it.");
    const stranger = b.remove ? null : notContact(groupOwner(g), u);
    if (stranger) return fail(res, 409, stranger);
    const asked = elsewhere.ask(`group:${g.id}`, g.name, u.id, !!b.remove);
    if (asked) return asked.error ? fail(res, asked.status || 400, asked.error) : ok(res, asked);
    if (b.remove) await personLeaves(g, u, viewerName(req));
    else if (!groupPeople(g).includes(u.username)) commit({ t: "group.member", gid: g.id, who: { user: u.username }, by: viewerName(req) });
    syncGroup(g.id).catch(() => {});
    return ok(res, { user: u.username });
  }
  const known = b.agent ? agentRef(String(b.agent)) : null;
  const agent = b.agent ? ownersAgent(req, b.agent) || (b.remove && myGroup(req, g) && known && g.members.some((m) => m.agent === known.id) ? known.id : null) : null;
  if (!agent) return fail(res, 404, "No such agent of yours.");
  await agentLeavesOrJoins(g, agent, !!b.remove, viewerName(req));
  ok(res);
});
// An agent joins a group, or leaves it with its threads in it (their machines hear so).
async function agentLeavesOrJoins(g: Group, agent, remove, by) {
  const leaving = remove ? Object.entries(state.group_posts).filter(([, m]) => m.group === g.id && m.agent === agent).map(([post]) => postRef(post)).filter(Boolean) : [];
  commit({ t: "group.member", gid: g.id, who: { agent }, remove, by });
  for (const p of leaving) await relay.command(p.D, "post.group", { post: p.local, gid: null }, { by: ownerOf(p.D)?.username || null, wait: 15e3 }).catch(() => null);
}
// A person leaves a group (or is taken out): their threads in it and their agents leave with them, and their
// machines stop keeping its folder in step (as for an archived group: what's in it stays where it is).
export async function personLeaves(g: Group, u: User, by) {
  const theirs = (m) => m.agent && agentRef(m.agent) && ownerOf(agentRef(m.agent).D)?.id === u.id;
  for (const m of g.members.filter(theirs)) await agentLeavesOrJoins(g, m.agent, true, by);
  for (const [post, m] of Object.entries(state.group_posts)) {
    const p = m.group === g.id ? postRef(post) : null;
    if (p && ownerOf(p.D)?.id === u.id) await groupPost(null, p, by ? { user: by } : null);
  }
  commit({ t: "group.member", gid: g.id, who: { user: u.username }, remove: true, by });
  await Promise.all([...relay.devices.values()].filter((D) => ownerOf(D)?.id === u.id && relay.online(D)).map((D) => relay.command(D, "group.sync", { gid: g.id, files: [], archived: true }, { by: u.username, wait: 0 }).catch(() => null)));
}
// Take yourself out of a group you're in (not your own).
route("POST", "/api/groups/:id/leave", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  if (myGroup(req, g)) return fail(res, 400, "It's yours: take the others out of it, or archive it.");
  await personLeaves(g, req.user, viewerName(req));
  ok(res);
});
// Put a thread in the group (moving it out of any other), or take it out (`remove`).
// Anyone in it puts in or takes out their own; its owner takes out anyone's.
route("POST", "/api/groups/:id/threads", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ post?: string; remove?: boolean }>(req);
  const p = b.post ? postRef(str(b.post, 300)) : null;
  const theirs = !!p && b.remove && myGroup(req, g) && state.group_posts[p.id]?.group === g.id;
  if (!p || !(isOwner(req, p.D) || theirs)) return fail(res, 404, "No such thread of yours.");
  const shared = !b.remove && p.s.mode === "full" ? noFullAccess({ group: g.id }) : null;
  if (shared) return fail(res, 403, `${shared} Take it out of Full access first.`);
  if (b.remove) {
    if (state.group_posts[p.id]?.group === g.id) await groupPost(null, p, byYou(req));
  } else await groupPost(g.id, p, byYou(req));
  ok(res);
});
// Put a WIP (a branch, or a pull request) in the group, moving it out of any other, or take it out (`remove`). It's
// worked out on the page, from its machines' folders and GitHub, so the page says what it is: `wip` is { id, kind,
// title, ref, repo, url }.
route("POST", "/api/groups/:id/wips", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id);
  if (!g) return;
  const { wip: w, remove } = await readBody<{ wip?: WipBody; remove?: boolean }>(req);
  const id = str(w?.id, 120);
  if (!/^[\w.:-]+$/.test(id)) return fail(res, 400, "Which branch or pull request?");
  const url = /^https:\/\/[^\s"<>]+$/.test(w.url || "") ? str(w.url, 300) : null;
  const wip = { id, kind: w.kind === "pr" ? "pr" : "branch", title: str(w.title, 200).trim(), ref: str(w.ref, 200).trim() || id, repo: str(w.repo, 120).trim(), url };
  commit({ t: "group.wip", gid: g.id, wip, remove: !!remove, by: byYou(req) });
  ok(res);
});
route("POST", "/api/groups/:id/notes", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ text?: string; for?: string }>(req);
  const text = str(b.text, 4000).trim();
  if (!text) return fail(res, 400, "Write the note.");
  const forPost = b.for && state.group_posts[b.for]?.group === g.id ? str(b.for, 300) : null;
  const op = commit({ t: "group.note", gid: g.id, nid: uuidv7(), text, for: forPost, for_label: forPost ? postRef(forPost)?.s.label : undefined, by: byYou(req) });
  ok(res, { id: op.nid, reaches: postsIn(groupState(), g.id).filter((s) => s.state !== "done").map((s) => s.label) });
});
// Its owner deletes any note; a person in it, their own.
route("POST", "/api/groups/:id/notes/:nid/delete", (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const n = state.group_notes.find((x) => x.id === params.nid && x.group === g.id);
  if (n && !myGroup(req, g) && n.by?.user !== viewerName(req)) return fail(res, 403, "Only its owner deletes someone else's note.");
  if (n) commit({ t: "group.note.remove", nid: params.nid });
  ok(res);
});
route("GET", "/api/groups/:id/file", (req, res, { params, query }) => {
  const g = groupOr404(req, res, params.id, "see");
  if (!g) return;
  const r = groupRead(g.id, query.get("path"), query.get("v"));
  if (!r) return fail(res, 404, "No such file, or that version isn't kept any more.");
  res.writeHead(200, { ...fileHeaders({ name: path.basename(r.version.path) }, query.get("download") !== "1"), "content-length": r.buf.length });
  res.end(r.buf);
});
route("GET", "/api/groups/:id/versions", (req, res, { params, query }) => {
  const g = groupOr404(req, res, params.id, "see");
  if (!g) return;
  const p = cleanPath(query.get("path"));
  if (!p) return fail(res, 400, "Say which file.");
  ok(res, { versions: fileVersions(state, g.id, p).slice().reverse().map((v) => groupFileSeen(req, g, v)) });
});
// A person's change to a group's files: kept as a version, and in the folder on their machines before they hear back.
async function groupChange(req: Viewer, res: Res, g: Group, change) {
  let version;
  try {
    version = change();
  } catch (e) {
    return fail(res, 400, e.message);
  }
  await syncGroup(g.id, { wait: 15e3 });
  ok(res, { version });
}
route("POST", "/api/groups/:id/files", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ path?: string; content_base64?: string; text?: string }>(req);
  await groupChange(req, res, g, () => groupWrite(g.id, b.path, typeof b.content_base64 === "string" ? Buffer.from(b.content_base64, "base64") : Buffer.from(str(b.text, FILE_MAX), "utf8"), byYou(req)));
});
route("POST", "/api/groups/:id/files/restore", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ path?: string; v?: number }>(req);
  await groupChange(req, res, g, () => {
    const r = groupRead(g.id, b.path, b.v);
    if (!r) throw new Error("That version isn't kept any more.");
    return groupWrite(g.id, b.path, r.buf, byYou(req), { restored: Number(b.v) });
  });
});
route("POST", "/api/groups/:id/files/delete", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id, "in");
  if (!g) return;
  const b = await readBody<{ path?: string }>(req);
  await groupChange(req, res, g, () => {
    const rel = cleanPath(b.path);
    if (!rel) throw new Error("That isn't a path inside the group's folder.");
    return groupRecord(g.id, rel, null, byYou(req));
  });
});
route("POST", "/api/groups/:id/archive", async (req, res, { params }) => {
  const g = groupOr404(req, res, params.id);
  if (!g) return;
  commit({ t: "group.archive", gid: g.id, archived: !!(await readBody<{ archived?: boolean }>(req)).archived });
  await syncGroup(g.id, { wait: 15e3 });
  ok(res);
});

// --- a machine's CLI, for its agents (ab_group_read, ab_group_write) and its folders ---
export async function groupAsk(D: Device, o: User, me: Asker, what, b) {
  if (what === "group/list") return { groups: Object.values(state.groups).filter((g) => uidInGroup(g, o.id)).map((g) => ({ id: g.id, archived: !!g.archived, files: groupFileList(g.id) })) };
  if (what === "group/news") return { text: me.post ? [groupNewsFor(me.post), await taskNewsFor(me.post).catch(() => null), pageNewsFor(me.post), threadNewsFor(me.post)].filter(Boolean).join("\n\n") || null : null };
  if (what === "group/file") {
    // A version from the machine's folder: what an agent wrote with ab_group_write, or with its own tools.
    const g = state.groups[str(b.gid, 80)];
    if (!g || !uidInGroup(g, o.id)) return { error: "No such group", status: 404 };
    const rel = cleanPath(b.path);
    if (!rel) return { error: "That isn't a path inside the group's folder.", status: 400 };
    if (!b.deleted && !(blobs.has(b.sha) && blobOk(D, b.sha))) return { error: "Its bytes haven't reached the server.", status: 409 };
    if (!b.deleted && Number(b.size) > FILE_MAX) return { error: "A group's file can be up to 10 MB.", status: 400 };
    const by = me.post && postRef(me.post) ? { agent: me.agent || relay.idOf(D, postRef(me.post).s.agent), post: me.post } : { machine: D.name };
    const v = groupRecord(g.id, rel, b.deleted ? null : { sha: str(b.sha, 64), size: Number(b.size) || 0 }, by);
    syncGroup(g.id, { except: D }).catch(() => {});
    return { v: v?.v || 0, url: groupLink(g.id) };
  }
  // group/read: the group (nothing asked), one thread in it, or a file in it, for one of its threads.
  const gid = me.post && state.group_posts[me.post]?.group;
  const g = gid && state.groups[gid];
  if (!g) return { error: "This thread isn't in a group. The person puts threads in groups on agentbook.", status: 404 };
  const person = o.display_name || o.username || null;
  if (b.thread) {
    const gs = groupState();
    const s = postsIn(gs, g.id).find((x) => x.id === b.thread || x.label === b.thread);
    if (!s) return { error: `No thread "${b.thread}" in ${g.name}. ab_group_read() lists them.`, status: 404 };
    const p = postRef(s.id);
    // Everyone in it sees every thread in it with its steps.
    const r = p ? ((await relay.read(p.D, "read.steps", { post: p.local })) as ReadAnswer<StepsAnswer>) : null;
    const steps = (r?.data?.steps || []).filter((st) => st.kind !== "say").map((st) => st.title).filter(Boolean);
    return { text: postForGroup(groupState({ messagesOf: s.id }), s, { person: s.owner && s.owner !== o.username ? s.owner : person, steps }) };
  }
  if (b.file) {
    const r = groupRead(g.id, b.file, b.v);
    if (!r) return { error: `No file "${b.file}" in ${g.name}${b.v ? `, or no v${b.v} of it` : ""}. ab_group_read() lists them.`, status: 404 };
    const v = r.version;
    const binary = r.buf.subarray(0, 8000).includes(0);
    const head = `${v.path}, v${v.v}, ${v.size} bytes, by ${byName(groupState(), v.by)}`;
    return { text: binary ? `${head}. It isn't text; its path on this machine: ${b.dir || GROUP_DIR(null, g.id)}/${v.path}` : `${head}:\n\n${r.buf.toString("utf8").slice(0, 200000)}` };
  }
  return { text: groupOverview(groupState(), me.post, { link: groupLink(g.id), dir: b.dir || GROUP_DIR(null, g.id), person, ...groupWho(g, o) }) };
}
