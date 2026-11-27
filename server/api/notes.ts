// Notes (notes.ts): people write them, agents comment and suggest.

import crypto from "node:crypto";
import { agentPublic, knownBy, seenAt } from "../policy.ts";
import { isLevel } from "../../plugin/shared/visibility.ts";
import { mentionNote, NOTE_MENTION } from "../../plugin/shared/mentions.ts";
import type { NamedNote } from "../../plugin/shared/mentions.ts";
import { acceptIn, COMMENT_MAX, NOTE_MAX, noteId, noteSummary, openComments, openSuggestions } from "../../plugin/shared/notes.ts";
import { cleanText, critic, findIn, plainText } from "../../plugin/shared/notes-md.ts";
import { isTalkId } from "../../plugin/shared/talks.ts";
import type { User } from "../accounts.ts";
import type { By, Iso, Note, NoteComment, NoteRef, NoteSuggestion, NoteVersion } from "../../plugin/shared/types.ts";
import { accounts, commit, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import { elsewhere } from "../core/elsewhere.ts";
import type { Req, Res, Viewer } from "../core/http.ts";
import type { Asker } from "../core/types.ts";
import { agentRef, agentsById, isOwner, postRef, viewerName } from "../core/refs.ts";
import { contactOf, isContact, notContact, postOr404, seesPost } from "../core/follows.ts";
import { canStart, steer } from "../core/commands.ts";
import { rowsFor } from "./views.ts";
import { SELF_URL } from "./cli.ts";
import { workspacesNamed } from "./workspaces.ts";
import { pageSeen, pagesSeenBy } from "./pages.ts";
import { talkOf, talkSeen } from "./talks.ts";
import { launchId, writesPages } from "./launch.ts";

// A note as someone sees it (noteFor): its summary, its owner's username, whether it's theirs and they may edit it,
// and who's on it; with `full`, its text, its conversations and versions, and the threads tied to it.
type NoteSeen = Omit<ReturnType<typeof noteSummaryOf>, "people" | "comments" | "suggestions"> & {
  owner_name: string;
  mine: boolean;
  can_edit: boolean;
  people: ReturnType<typeof notePeople>;
  text?: string;
  // In brief, how many are open; in full, all of them.
  comments: number | (NoteComment & { thread: string | null })[];
  suggestions: number | NoteSuggestion[];
  versions?: Omit<NoteVersion, "text" | "title">[];
  ties?: ReturnType<typeof noteTies>;
};
// Whom a comment on a note is for: one of your agents, or a thread.
interface CommentTo {
  agent?: string;
  thread?: string;
}

/* ---------- notes (notes.ts): people write them, agents comment and suggest ---------- */

// A note is its owner's. Its people (on it, or on a note it's inside of) see it and work in it: write it, comment,
// accept or reject what agents suggest. Its owner alone moves it, archives it, and says who's on it and who else sees
// it: their contacts, once it's public, who read it.
const noteChain = (n: Note) => {
  const out = [];
  for (let p = n, i = 0; p && i < 100; p = p.parent ? state.notes[p.parent] : null, i++) out.push(p);
  return out;
};
// Everyone on it, by account id: its owner, and the people on it or on a note it's inside of (all its owner's).
export const notePeopleIds = (n: Note) => [...new Set([n.owner, ...noteChain(n).flatMap((x) => (x.owner === n.owner ? (x.people || []).map((p) => p.user) : []))])].filter((id) => id && (id === n.owner || !accounts.byId(id)?.deleted));
export const onNote = (n: Note, uid: string) => !!n && !!uid && notePeopleIds(n).includes(uid);
const noteMine = (req: Viewer, n: Note) => !!req.user && n.owner === req.user.id;
// A note this request may see: theirs or one they're on, or a public one of a contact's (not archived).
export const noteSeen = (req: Viewer, n: Note) => !!n && !!req.user && (onNote(n, req.user.id) || (!n.archived && seenAt(n.visibility, isContact(req, n.owner))));
// A note this request may see ("see"), work in ("edit": its people), or move, archive and share ("own"): the note, or
// a 404 (not visible) or 403 (visible, not theirs) sent.
const noteOr404 = (req: Viewer, res: Res, id: string, need = "see") => {
  const n = state.notes[id];
  if (!n || !noteSeen(req, n)) return void fail(res, 404, "No such note");
  if (need === "edit" && !onNote(n, req.user.id)) return void fail(res, 403, "Only the people on it can change it.");
  if (need === "own" && !noteMine(req, n)) return void fail(res, 403, "Only its owner can do that.");
  return n;
};
export const noteLink = (id: string) => `${SELF_URL}/#/notes/${encodeURIComponent(id)}`;
// An id for a comment, a message or a suggestion: the one the page made (so sending again, signed with a passkey,
// doesn't say it twice), or a new one.
const noteThingId = (given, prefix) => (typeof given === "string" && new RegExp(`^${prefix}[a-z0-9]{6,32}$`).test(given) ? given : `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`);
// The post a launch became, once it has.
function launchPost(id: string | null | undefined) {
  const r = id && relay.resolve(id);
  const l = r && r.D.store.state.launches[r.local];
  return l?.post ? relay.idOf(r.D, l.post) : null;
}
// The thread a comment talks to, or a thread that named the note: its post, or, while it starts, its launch's.
export const commentThread = (c: { post?: string | null; launch?: string | null }) => c.post || launchPost(c.launch);
// Every thread tied to a note, once each, with how: it's in a comment, it wrote the note, it names the note, or it read
// it (the strongest of those), and when that last was. What the note's Threads box lists, of those its reader sees.
export function noteTies(n: Note) {
  const out = new Map<string, { id: string; how: string; at: Iso }>();
  const tie = (id: string | null | undefined, how: string, at: Iso) => {
    if (!id) return;
    const was = out.get(id);
    if (!was) out.set(id, { id, how, at });
    else if (at > was.at) was.at = at;
  };
  for (const c of n.comments) {
    tie(commentThread(c), "comment", c.at);
    for (const m of c.msgs) tie(m.by?.post, "comment", m.at);
  }
  tie(n.by?.post, "wrote", n.created);
  for (const v of state.note_versions) if (v.note === n.id) tie(v.by?.post, "wrote", v.at);
  const refs = (n.refs || []).map((r): [string | null, NoteRef] => [commentThread(r), r]);
  for (const [id, r] of refs) if (r.how === "named") tie(id, "named", r.at);
  for (const [id, r] of refs) tie(id, r.how, r.at);
  return [...out.values()];
}
// `threads`: the ones its open comments talk to (what's working or waits on you); `linked`: every thread it's tied to,
// resolved comments' too, the threads that answered or suggested in it, the one that made it and the ones that name it
// (@note:<id>), so a thread names its note as it names its page or its group. A thread that only read it isn't about it.
const noteSummaryOf = (n: Note) => ({
  ...noteSummary(n, plainText),
  threads: [...new Set(openComments(n).map(commentThread).filter(Boolean))],
  linked: [...new Set([n.by?.post, ...n.comments.flatMap((c) => [commentThread(c), ...c.msgs.map((m) => m.by?.post)]), ...(n.refs || []).filter((r) => r.how === "named").map(commentThread)].filter(Boolean))],
});
// Who's on it, as its share panel lists them: by username, and the note they're on it through when it's one it's
// inside of (`from`), which only that note's panel takes them off.
const notePeople = (n: Note) => {
  const out = new Map();
  for (const x of noteChain(n)) {
    if (x.owner !== n.owner) continue;
    for (const p of x.people || []) {
      const u = accounts.byId(p.user);
      if (u && !u.deleted && !out.has(u.id)) out.set(u.id, { user: u.username, at: p.at, ...(x.id !== n.id ? { from: x.id } : {}) });
    }
  }
  return [...out.values()];
};
// What a request's person may know of who did what in a note: an agent when it's public or theirs, a thread when they
// see it. Made once for a list.
export function noteKnown(req: Viewer) {
  let agents = null;
  const agent = (id) => !!id && (isOwner(req, agentRef(id)?.D) || agentPublic((agents ??= agentsById()).get(id)));
  const post = (id) => !!id && (isTalkId(id) ? talkSeen(req, talkOf(id)) : seesPost(req, postRef(id)));
  return { agent, post, by: (by) => knownBy(by, agent, post) };
}
// A note as a request's person sees it (its summary, or with `full` its text and conversations): all of it for its
// owner; for the others, who did what only as they may know it, and what it's in or about only when they see that.
// `mine`, `can_edit` (its people), its owner's username, and who's on it.
export function noteFor(req: Viewer, n: Note, known: ReturnType<typeof noteKnown>, full: true): NoteSeen;
export function noteFor(req: Viewer, n: Note, known?: ReturnType<typeof noteKnown>, full?: false): Omit<NoteSeen, "comments" | "suggestions"> & { comments: number; suggestions: number };
export function noteFor(req: Viewer, n: Note, known = noteKnown(req), full = false) {
  const mine = noteMine(req, n);
  const out: NoteSeen = { ...noteSummaryOf(n), owner_name: accounts.byId(n.owner)?.username || "", mine, can_edit: onNote(n, req.user?.id), people: notePeople(n) };
  if (full) {
    out.text = n.text;
    out.comments = n.comments.map((c) => ({ ...c, thread: commentThread(c) }));
    out.suggestions = n.suggestions;
    out.versions = state.note_versions.filter((v) => v.note === n.id).slice(-30).reverse().map(({ text: _, title: __, ...v }) => v);
    out.ties = noteTies(n).filter((t) => known.post(t.id));
  }
  if (mine) return out;
  const by = known.by;
  const last = (l) => l && { ...l, by: by(l.by), ...(l.accepted ? { accepted: { ...l.accepted, by: by(l.accepted.by) } } : {}) };
  Object.assign(out, {
    by: by(out.by), made: known.agent(out.made) ? out.made : null, last: last(out.last),
    parent: out.parent && noteSeen(req, state.notes[out.parent]) ? out.parent : null,
    workspace: null, page: out.page && pageSeen(req, out.page) ? out.page : null,
    threads: out.threads.filter(known.post), linked: out.linked.filter(known.post),
  });
  if (full) {
    if (Array.isArray(out.comments)) out.comments = out.comments.map((c) => ({ ...c, by: by(c.by), post: known.post(c.post) ? c.post : null, thread: known.post(c.thread) ? c.thread : null, launch: null, msgs: c.msgs.map((m) => ({ ...m, by: by(m.by) })), resolved: c.resolved && { ...c.resolved, by: by(c.resolved.by) } }));
    if (Array.isArray(out.suggestions)) out.suggestions = out.suggestions.map((x) => ({ ...x, by: by(x.by), settled: x.settled && { ...x.settled, by: by(x.settled.by) } }));
    out.versions = out.versions.map((v) => ({ ...v, by: by(v.by), ...(v.accepted ? { accepted: { ...v.accepted, by: by(v.accepted.by) } } : {}) }));
  }
  return out;
}
// A note's markdown as it's kept: without what marks a suggestion on the page (notes-md.js).
const noteText = (v) => cleanText(str(v, NOTE_MAX + 1));
const TOO_LONG = "A note holds up to 200 KB of markdown.";
// A note it may go inside of: another of the same person's, not itself or one inside it.
function parentOk(n: Note, pid: string, owner) {
  if (!pid) return true;
  for (let p = state.notes[pid], i = 0; p && i < 100; p = state.notes[p.parent], i++) if (n && p.id === n.id) return false;
  return state.notes[pid]?.owner === owner;
}

// The notes a message's sender may name, by id, for what its agent is told of them (mentions.ts): the ones it names
// that they see. Empty when it names none.
export function notesNamed(user: User | null, text: string): Record<string, NamedNote> {
  if (!user || !String(text || "").match(NOTE_MENTION)) return {};
  const out: Record<string, NamedNote> = {};
  for (const m of String(text).matchAll(NOTE_MENTION)) {
    const n = state.notes[m[2]];
    if (n && noteSeen({ user }, n)) out[n.id] = { id: n.id, title: n.title, ...(n.owner !== user.id ? { whose: `@${accounts.byId(n.owner)?.username || "someone"}` } : {}) };
  }
  return out;
}
// The notes a thread named (`notes`, from notesNamed) show it: by its `post`, or its `launch` while it starts.
export function noteRefs(notes, where) {
  for (const id of Object.keys(notes || {})) commit({ t: "note.ref", nid: id, how: "named", ...where });
}
// A thread that reads a note, once: it's tied to it, unless it is already.
function noteRead(n: Note, post: string) {
  if (!post || n.refs?.some((r) => commentThread(r) === post) || n.comments.some((c) => commentThread(c) === post)) return;
  commit({ t: "note.ref", nid: n.id, how: "read", post });
}

// --- you, from the web UI ---
// A note, and a row of each thread its Threads box lists that the screen's chrome may not have (an archived one).
route("GET", "/api/notes/:id", (req, res, { params }) => {
  const n = noteOr404(req, res, params.id);
  if (!n) return;
  const out = noteFor(req, n, noteKnown(req), true);
  const ids = new Set(out.ties.map((t) => t.id));
  ok(res, { ...out, thread_rows: ids.size ? rowsFor(req, (s) => ids.has(s.id), { talks: true }) : [] });
});
route("POST", "/api/notes", async (req, res) => {
  const b = await readBody<{ title?: string; parent?: string; text?: string; emoji?: string }>(req);
  const title = str(b.title, 120).trim() || "Untitled";
  const parent = b.parent ? str(b.parent, 120) : null;
  // One inside a note you're on is that note's owner's, as everything in it is: you're on it through that note.
  const owner = parent && onNote(state.notes[parent], req.user.id) ? state.notes[parent].owner : req.user.id;
  if (parent && !parentOk(null, parent, owner)) return fail(res, 404, "No such note to put it in.");
  const text = noteText(b.text);
  if (text.length > NOTE_MAX) return fail(res, 413, TOO_LONG);
  const nid = noteId(title, (id) => !!state.notes[id]);
  commit({ t: "note.create", nid, title, emoji: b.emoji ? str(b.emoji, 16).trim() : undefined, parent, text, by: { user: viewerName(req) }, owner, hand: true });
  ok(res, { id: nid });
});
// What you typed: its text, title and emoji, and where it is. Written over a version you hadn't seen that you
// didn't make (an accepted suggestion, another person), it would undo that: the page reads the note again instead.
route("POST", "/api/notes/:id/write", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "edit");
  if (!n) return;
  const b = await readBody<{ base?: number; text?: string; title?: string; emoji?: string; parent?: string | null }>(req);
  const theirs = n.last && (n.last.accepted || n.last.by?.agent || n.last.by?.user !== viewerName(req));
  if (b.base != null && Number(b.base) !== n.version && theirs) return fail(res, 409, "The note changed since you opened it.", { version: n.version });
  const w: { text?: string; title?: string; emoji?: string; parent?: string | null } = {};
  if (b.text !== undefined) {
    w.text = noteText(b.text);
    if (w.text.length > NOTE_MAX) return fail(res, 413, TOO_LONG);
  }
  if (b.title !== undefined) w.title = str(b.title, 120).trim() || "Untitled";
  if (b.emoji !== undefined) w.emoji = str(b.emoji, 16).trim() || "📄";
  if (b.parent !== undefined && (b.parent || null) !== (n.parent || null)) {
    const pid = b.parent ? str(b.parent, 120) : null;
    if (!noteMine(req, n)) return fail(res, 403, "Only its owner can move it.");
    if (!parentOk(n, pid, req.user.id)) return fail(res, 400, "It can't go inside that note.");
    w.parent = pid;
  }
  commit({ t: "note.write", nid: n.id, by: { user: viewerName(req) }, hand: true, ...w });
  ok(res, { version: state.notes[n.id].version });
});
route("POST", "/api/notes/:id/archive", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "own");
  if (!n) return;
  const b = await readBody<{ archived?: boolean }>(req);
  commit({ t: "note.archive", nid: n.id, archived: b.archived !== false, by: { user: viewerName(req) } });
  ok(res);
});
// --- sharing a note: who else sees it (`visibility`), and who's on it (`people`). Its owner's. ---
route("POST", "/api/notes/:id/visibility", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "own");
  if (!n) return;
  const b = await readBody<{ visibility?: string }>(req);
  if (!isLevel(b.visibility)) return fail(res, 400, "Private or public?");
  commit({ t: "note.visibility", nid: n.id, visibility: b.visibility });
  ok(res);
});
// Put someone with an account on it, or take them off (`remove`). They see it, the notes inside it, and the threads
// its comments talk to that are one of theirs, and work in it as its owner does.
route("POST", "/api/notes/:id/people", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "own");
  if (!n) return;
  const b = await readBody<{ user?: string; remove?: boolean }>(req);
  const u = accounts.byUsername(str(b.user, 80).trim().replace(/^@/, ""));
  if (!u || u.deleted || (u.disabled && !b.remove)) return fail(res, 404, "No one with that username here.");
  if (u.id === n.owner) return fail(res, 400, "That's its owner, who's always on it.");
  const stranger = b.remove ? null : notContact(n.owner, u);
  if (stranger) return fail(res, 409, stranger);
  const asked = elsewhere.ask(`note:${n.id}`, n.title, u.id, !!b.remove);
  if (asked) return asked.error ? fail(res, asked.status || 400, asked.error) : ok(res, asked);
  if (b.remove && !(n.people || []).some((p) => p.user === u.id)) {
    const from = notePeople(n).find((p) => p.user === u.username)?.from;
    if (from) return fail(res, 400, `They're on "${state.notes[from]?.title || from}", which it's inside of: take them off that one.`);
  }
  commit({ t: "note.person", nid: n.id, user: u.id, remove: !!b.remove, by: viewerName(req) });
  ok(res, { user: u.username });
});
// Take yourself off a note shared with you.
route("POST", "/api/notes/:id/leave", (req, res, { params }) => {
  const n = noteOr404(req, res, params.id);
  if (!n) return;
  if (noteMine(req, n)) return fail(res, 400, "It's yours: take the others off it, or archive it.");
  const direct = (n.people || []).some((p) => p.user === req.user.id);
  const from = notePeople(n).find((p) => p.user === req.user.username)?.from;
  if (!direct && from) return fail(res, 400, `You're on "${state.notes[from]?.title || from}", which it's inside of: leave that one.`);
  if (direct) commit({ t: "note.person", nid: n.id, user: req.user.id, remove: true, by: viewerName(req) });
  ok(res);
});

// What a comment says to an agent, after its words: what it's on, and how to answer. A reply in a comment that's
// already its thread's needs less.
function noteBrief(n: Note, c: NoteComment, o: User, { reply = false } = {}) {
  const who = o?.display_name || o?.username || "The person";
  const owner = n.owner === o?.id ? null : accounts.byId(n.owner);
  const whose = owner ? `@${owner.username}'s` : `${who}'s`;
  const on = c.spot ? `at this line: ${c.spot}` : c.quote ? `on these words: "${c.quote}"` : "on the whole note";
  // Pinged in the text: what it does goes there.
  if (c.spot && !reply)
    return [
      `[${who} @-mentioned you in the text of ${owner ? `${whose} note` : "their note"} "${n.title}" on agentbook (note "${n.id}", comment "${c.id}"). ${noteLink(n.id)}`,
      `Read the note with ab_note_read, then do what they asked at that spot, in this line of its markdown: ${c.spot}`,
      `Put what you write there with ab_note_suggest (note "${n.id}", comment "${c.id}", find: that line exactly, replace: what goes in its place, which can be several lines). That takes their line out, so keep any of its words that should stay. If it says little or nothing but your name, work out from the words around it what belongs there.`,
      `Say what you did, or answer what they asked, in the comment with ab_note_comment (note "${n.id}", comment "${c.id}"), briefly. It's ${whose} note, so you can't write it: ${owner ? "the people on it" : "they"} accept or reject what you suggest.]`,
    ].join("\n");
  if (reply) return `[A reply in comment ${c.id} on ${whose} note "${n.title}" (note "${n.id}"), ${on}. Answer with ab_note_comment (note "${n.id}", comment "${c.id}"); suggest edits with ab_note_suggest.]`;
  return [
    `[${who} asked you this in a comment on ${owner ? `${whose} note` : "their note"} "${n.title}" on agentbook (note "${n.id}", comment "${c.id}"), ${on}. ${noteLink(n.id)}`,
    `Read the note with ab_note_read. Answer in the comment with ab_note_comment (note "${n.id}", comment "${c.id}"), briefly: it shows beside the text.`,
    `To change the note, suggest the edit with ab_note_suggest (note "${n.id}", comment "${c.id}", find: its words exactly as written, replace: what goes there). It's ${whose} note, so you can't write it: ${owner ? "the people on it" : "they"} accept or reject what you suggest.]`,
  ].join("\n");
}
const commentTarget = (to: CommentTo | null | undefined) => (to?.agent ? { agent: str(to.agent, 200) } : to?.thread ? { thread: str(to.thread, 200) } : null);
// A comment naming an agent (`to.agent`) starts a thread for it about the note, in a folder of the note's own on
// its machine. One naming a thread (`to.thread`), or a reply in a comment that has one, goes to that thread as a
// message. Either answers the page as starting a thread or sending a message does. The pages, widgets and
// workspaces it names come with it, as in a message (mentions.ts).
async function commentTo(req: Req, res: Res, n: Note, c: NoteComment, text: string, to: CommentTo | null, reply: boolean) {
  const was = commentThread(c);
  const notes = notesNamed(req.user, text);
  const named = mentionNote(text, pagesSeenBy(req.user), Date.now(), workspacesNamed(req.user, text), { notes });
  const brief = (opts?: { reply?: boolean }) => [named, noteBrief(n, c, req.user, opts)].filter(Boolean).join("\n\n");
  if (to?.thread || (!to && was)) {
    const p = postOr404(req, res, to?.thread || was, "own");
    if (!p) return;
    if (c.post !== p.id) commit({ t: "note.thread", nid: n.id, cid: c.id, post: p.id });
    noteRefs(notes, { post: p.id });
    const note = brief({ reply: reply && was === p.id });
    return steer(req, res, p.D, "post.deliver", { post: p.local, text, note }, { done: (r) => ({ ...r, comment: c.id, ...(r.lid ? { lid: relay.idOf(p.D, r.lid) } : {}) }) });
  }
  const known = agentRef(to.agent);
  if (!known || !isOwner(req, known.D)) return fail(res, 403, "Only an agent's owner can give it work.");
  if (!canStart(res, known.D, known.local)) return;
  if (!writesPages(known.a.kind)) return fail(res, 400, `${known.a.name} can't work on notes: it doesn't have agentbook's tools.`);
  const lid = launchId();
  const args = { lid, agent: known.local, prompt: text, files: [], for_note: n.id, note: brief() };
  // By the launch its machine starts: a start the page signs after a 428 is that request's, with its launch id.
  let launch = null as string | null;
  const sending = (a: Record<string, unknown>) => {
    launch = relay.idOf(known.D, String(a.lid || lid));
    commit({ t: "note.thread", nid: n.id, cid: c.id, launch, post: null });
    noteRefs(notes, { launch });
  };
  await steer(req, res, known.D, "post.start", args, { wait: 60e3, sending, done: (r) => ({ ...r, comment: c.id, lid: r.lid ? relay.idOf(known.D, r.lid) : launch }) });
}
// A comment of yours: on some of the note's words (`quote`, the `nth` place they are) or on all of it; or an agent you
// @'d in the text, on the line it's in (`spot`, as the markdown has it).
route("POST", "/api/notes/:id/comments", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "edit");
  if (!n) return;
  const b = await readBody<{ text?: string; cid?: string; mid?: string; quote?: string; nth?: number; spot?: string; to?: CommentTo }>(req);
  const text = str(b.text, COMMENT_MAX).trim();
  if (!text) return fail(res, 400, "Write something.");
  const cid = noteThingId(b.cid, "c");
  if (!n.comments.some((c) => c.id === cid)) commit({ t: "note.comment", nid: n.id, cid, mid: noteThingId(b.mid, "m"), quote: str(b.quote, 2000), nth: Math.max(0, Math.min(1000, Math.floor(Number(b.nth) || 0))), spot: noteText(str(b.spot, 2000)).trim() || undefined, text, by: { user: viewerName(req) } });
  const c = state.notes[n.id].comments.find((x) => x.id === cid);
  const to = commentTarget(b.to);
  if (!to) return ok(res, { comment: cid });
  await commentTo(req, res, n, c, text, to, false);
});
// A reply in one: it goes to its thread, or to the agent or thread it names.
route("POST", "/api/notes/:id/comments/:cid", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "edit");
  if (!n) return;
  const c = n.comments.find((x) => x.id === params.cid);
  if (!c) return fail(res, 404, "No such comment");
  const b = await readBody<{ text?: string; mid?: string; to?: CommentTo }>(req);
  const text = str(b.text, COMMENT_MAX).trim();
  if (!text) return fail(res, 400, "Write something.");
  const mid = noteThingId(b.mid, "m");
  if (!c.msgs.some((m) => m.id === mid)) commit({ t: "note.reply", nid: n.id, cid: c.id, mid, text, by: { user: viewerName(req) } });
  const to = commentTarget(b.to);
  // Without an agent it names, it goes to the comment's thread only when that's one of theirs: someone else's agent
  // reads it in the note, but nobody but its owner gives it work.
  const was = commentThread(c);
  if (!to && (!was || !isOwner(req, postRef(was)?.D))) return ok(res, { comment: c.id });
  await commentTo(req, res, n, c, text, to, true);
});
route("POST", "/api/notes/:id/comments/:cid/resolve", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "edit");
  if (!n) return;
  if (!n.comments.some((x) => x.id === params.cid)) return fail(res, 404, "No such comment");
  const b = await readBody<{ resolved?: boolean }>(req);
  commit({ t: "note.resolve", nid: n.id, cid: params.cid, resolved: b.resolved !== false, by: { user: viewerName(req) } });
  ok(res);
});
// Accepting a suggestion (keep) puts it in the note, as a version of yours; rejecting it drops it.
route("POST", "/api/notes/:id/suggestions/:sid", async (req, res, { params }) => {
  const n = noteOr404(req, res, params.id, "edit");
  if (!n) return;
  const s = n.suggestions.find((x) => x.id === params.sid);
  if (!s) return fail(res, 404, "No such suggestion");
  if (s.state !== "open") return fail(res, 409, s.state === "kept" ? "It's in the note already." : "It was rejected.");
  const b = await readBody<{ keep?: boolean }>(req);
  if (b.keep && acceptIn(n.text, s) == null) return fail(res, 409, "Its words aren't in the note any more, so it can't go in.");
  // A comment made in the text moves onto the first words its suggestion put in that line, as they read on the page.
  const spot = n.comments.find((c) => c.id === s.comment)?.spot;
  const onSpot = b.keep && spot && (s.find.includes(spot) || spot.includes(s.find));
  const quote = onSpot ? plainText(s.find.includes(spot) ? s.replace : spot.replace(s.find, s.replace)).split("\n").map((l) => l.trim()).find(Boolean) || "" : undefined;
  commit({ t: "note.settle", nid: n.id, sid: s.id, keep: !!b.keep, ...(quote !== undefined ? { quote } : {}), by: { user: viewerName(req) } });
  ok(res, { version: state.notes[n.id].version });
});

// --- agents, through their machine (ab_note_list, ab_note_read, ab_note_write, ab_note_suggest, ab_note_comment) ---
// An agent reads the notes its person sees, writes the ones it made, and comments and suggests edits in the ones its
// person is on (theirs, and ones shared with them).
export const noteSeenBy = (o: User, n: Note) => !!n && (onNote(n, o.id) || (!n.archived && seenAt(n.visibility, contactOf(o.id, n.owner))));
const agentNote = (o: User, id: string, need = "edit") => {
  const n = state.notes[id];
  return n && (need === "see" ? noteSeenBy(o, n) : onNote(n, o.id)) ? n : null;
};
const noNote = (id: string) => ({ error: `No note "${id}". ab_note_list lists them.`, status: 404 });
// Who said something in a comment, as an agent reads it: "herval", "you", "ibis 7 (Claude)".
function saidBy(by, me: Asker, o: User) {
  if (by?.user) return by.user === o.username ? o.display_name || o.username : `@${by.user}`;
  if (by?.post && by.post === me.post) return "you";
  const name = agentRef(by?.agent)?.a.name || "an agent";
  const p = by?.post && postRef(by.post);
  return p ? `${p.s.label} (${name})` : name;
}
export function noteReadForAgent(o: User, me: Asker, id: string) {
  const n = agentNote(o, id, "see");
  if (!n) return noNote(id);
  noteRead(n, me.post);
  const owner = n.owner === o.id ? o : accounts.byId(n.owner);
  return {
    id: n.id, title: n.title, emoji: n.emoji, parent: n.parent, version: n.version, updated: n.updated, url: noteLink(n.id), yours: !!me.agent && n.made === me.agent, person: owner?.display_name || owner?.username || "",
    ...(n.owner !== o.id ? { owner: `@${owner?.username || "?"}`, can_comment: onNote(n, o.id) } : {}),
    text: critic(n.text, openSuggestions(n)).md,
    comments: openComments(n).map((c) => ({
      id: c.id,
      quote: c.quote,
      ...(c.spot ? { spot: c.spot } : {}),
      messages: c.msgs.map((m) => ({ who: saidBy(m.by, me, o), text: m.text || (m.sugg ? "(suggested an edit)" : ""), at: m.at })),
      suggestions: n.suggestions.filter((s) => s.comment === c.id).map((s) => ({ id: s.id, find: s.find, replace: s.replace, state: s.state })),
    })),
  };
}
export function noteWriteForAgent(o: User, me: Asker, b) {
  const id = b.note ? str(b.note, 120) : null;
  const n = id ? agentNote(o, id) : null;
  if (id && !n && state.notes[id]) return notOnNote(o, id);
  const text = b.text == null ? undefined : noteText(b.text);
  if (text != null && text.length > NOTE_MAX) return { error: TOO_LONG, status: 413 };
  const parent = b.parent !== undefined && b.parent !== null ? str(b.parent, 120) || null : undefined;
  const by = { agent: me.agent, post: me.post };
  if (!n) {
    const title = str(b.title, 120).trim();
    if (!title) return { error: id ? `No note "${id}". Give a title to make one, or see ab_note_list.` : "A new note needs a title.", status: 400 };
    if (parent && !parentOk(null, parent, o.id)) return noNote(parent);
    const nid = noteId(title, (x) => !!state.notes[x]);
    commit({ t: "note.create", nid, title, emoji: b.emoji ? str(b.emoji, 16).trim() : undefined, parent: parent || null, text: text || "", by, owner: o.id, made: me.agent });
    return { id: nid, created: true, version: 1, url: noteLink(nid) };
  }
  const whose = n.owner === o.id ? o.display_name || o.username : `@${accounts.byId(n.owner)?.username || "someone"}`;
  if (!me.agent || n.made !== me.agent) return { error: `"${n.title}" is ${whose}'s note, so you can't write it: suggest edits with ab_note_suggest, or say something with ab_note_comment.`, status: 403 };
  if (parent !== undefined && (parent || null) !== (n.parent || null) && n.owner !== o.id) return { error: `Only ${whose} moves "${n.title}".`, status: 403 };
  if (parent !== undefined && !parentOk(n, parent, o.id)) return { error: "It can't go inside that note.", status: 400 };
  const was = n.version;
  commit({ t: "note.write", nid: n.id, by, ...(text != null ? { text } : {}), ...(b.title ? { title: str(b.title, 120).trim() } : {}), ...(b.emoji ? { emoji: str(b.emoji, 16).trim() } : {}), ...(parent !== undefined ? { parent } : {}) });
  return { id: n.id, version: state.notes[n.id].version, changed: state.notes[n.id].version !== was, url: noteLink(n.id) };
}
// A note its person sees but isn't on: it reads it, nothing more.
const notOnNote = (o: User, id: string) => (agentNote(o, id, "see") ? { error: `${o.display_name || o.username} isn't on "${state.notes[id].title}": you can read it, not comment or suggest in it. Its owner puts people on it.`, status: 403 } : noNote(id));
// `by`: someone on another agentbook, whose suggestion came through your door (./people-spaces.ts).
export function noteSuggestForAgent(o: User, me: Asker, b, by: By = { agent: me.agent, post: me.post }) {
  const id = str(b.note, 120);
  const n = agentNote(o, id);
  if (!n) return notOnNote(o, id);
  const find = cleanText(str(b.find, 20000));
  const replace = cleanText(str(b.replace, 40000));
  if (!find) return { error: "find is the words to replace, exactly as the note has them.", status: 400 };
  if (find.includes("\n")) return { error: "find is words on one line. For words on several lines, suggest each line apart.", status: 400 };
  if (find === replace) return { error: "replace is the same as find: there's nothing to suggest.", status: 400 };
  if (findIn(n.text, find) < 0) return { error: `The note doesn't have "${find.slice(0, 80)}" as written. ab_note_read gives its markdown.`, status: 400 };
  const why = str(b.why, 600).trim();
  const sid = noteThingId(null, "s");
  const mid = noteThingId(null, "m");
  let cid = b.comment ? str(b.comment, 60) : null;
  if (cid && !n.comments.some((c) => c.id === cid)) return { error: `The note has no comment "${cid}". ab_note_read lists them.`, status: 404 };
  const answered = cid && n.comments.find((c) => c.id === cid);
  if (answered && !commentThread(answered) && me.post) commit({ t: "note.thread", nid: n.id, cid, post: me.post });
  // Without a comment it answers, it starts one of its own on those words.
  if (!cid) {
    cid = noteThingId(null, "c");
    commit({ t: "note.comment", nid: n.id, cid, mid, quote: plainText(find).trim(), text: why, sid, by, post: me.post });
  }
  commit({ t: "note.suggest", nid: n.id, sid, cid, mid, find, replace, text: why, by });
  return { suggestion: sid, comment: cid, url: noteLink(n.id) };
}
export function noteCommentForAgent(o: User, me: Asker, b, by: By = { agent: me.agent, post: me.post }) {
  const id = str(b.note, 120);
  const n = agentNote(o, id);
  if (!n) return notOnNote(o, id);
  const text = str(b.text, COMMENT_MAX).trim();
  if (!text) return { error: "text is what you say.", status: 400 };
  const mid = noteThingId(null, "m");
  if (b.comment) {
    const c = n.comments.find((x) => x.id === str(b.comment, 60));
    if (!c) return { error: `The note has no comment "${b.comment}". ab_note_read lists them.`, status: 404 };
    commit({ t: "note.reply", nid: n.id, cid: c.id, mid, text, by });
    // A comment it answers that talks to no thread yet talks to this one from now on: your replies come here.
    if (!commentThread(c) && me.post) commit({ t: "note.thread", nid: n.id, cid: c.id, post: me.post });
    return { comment: c.id, url: noteLink(n.id) };
  }
  const cid = noteThingId(null, "c");
  commit({ t: "note.comment", nid: n.id, cid, mid, quote: b.quote ? plainText(str(b.quote, 2000)).trim() : "", text, by, post: me.post });
  return { comment: cid, url: noteLink(n.id) };
}
