// A thread's guests: agents brought into it by @-ing them in its box.

import crypto from "node:crypto";
import { levelOf } from "../../plugin/shared/visibility.ts";
import { workspacesOf } from "../feed.ts";
import { expandMentions, mentionNote } from "../../plugin/shared/mentions.ts";
import { guestsOf, NEWS_LINES, newsQuote, newsText, READ_FILES, saidWith } from "../../plugin/shared/guests.ts";
import { talkTitle } from "../../plugin/shared/talks.ts";
import { postForGroup } from "../../plugin/shared/groups.ts";
import { conversationOf, fileOf, sessionDetail } from "../../plugin/shared/store.ts";
import { capsOf, RUNTIMES } from "../../plugin/shared/runtimes.ts";
import type { User } from "../accounts.ts";
import type { Message, Thread, ThreadPayload } from "../../plugin/shared/api.ts";
import type { Device } from "../relay.ts";
import type { Agent, Iso, Message as StoredMessage, Question, ThreadGuest } from "../../plugin/shared/types.ts";
import { accounts, commit, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Viewer } from "../core/http.ts";
import type { Asker, PostRef, ReadAnswer, StepsAnswer } from "../core/types.ts";
import { agentRef, isOwner, ownerOf, postRef, takesFolders, viewerName } from "../core/refs.ts";
import { postOr404, seesPost, sharedOf, threadPeople } from "../core/follows.ts";
import { canStart, steer } from "../core/commands.ts";
import { live } from "../core/services.ts";
import { viewForReq } from "./views.ts";
import { postLink, titleOf } from "./cli.ts";
import { uploadsOf } from "./threads.ts";
import { workspacesNamed } from "./workspaces.ts";
import { pagesSeenBy } from "./pages.ts";
import { noteRefs, notesNamed } from "./notes.ts";
import { groupState, whoOf } from "./groups.ts";
import { foundThreadRead, threadFileFor } from "./thread-search.ts";
import { sentTexts, sentTo, talkOf, talkReadText } from "./talks.ts";
import { launchId, modeFor } from "./launch.ts";

// A guest is a thread of its own. What it says shows in the thread it's a guest in, and each thread there hears what
// the others said with the next message it gets. The server keeps who's a guest where (guests.ts), by the page's ids.

// The kinds of agent a thread can bring in, as their runtimes say (shared/runtimes.ts, `guests`): the ones that work
// in a folder (Claude Code, Codex, Hermes), and OpenClaw's, which have none and go by the conversation (steps 1 and 3
// of the plan).
export const guestKind = (a: { kind?: string }) => capsOf(a.kind).guests;
// Those runtimes by name, for saying which can: "Claude Code, Codex, Hermes and OpenClaw".
const GUEST_NAMES = (() => {
  const names = [...new Set(Object.values(RUNTIMES).filter((r) => r.caps.guests && !r.place).map((r) => r.name))].sort();
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
})();
export const NOT_A_GUEST = (a: Agent) => `${a.name} can't join a thread yet: for now, only ${GUEST_NAMES} agents can.`;
// Where an agent brought into thread `p` works. One with no folders (OpenClaw's): nowhere, the conversation is what it
// has. On the thread's machine: the thread's folder, beside its agent. On another machine: that machine's checkout of
// the thread's workspace, as it stands there; with none (or a thread that has no folder itself), a folder of the
// thread's own there. -> { how: "none" | "same" | "checkout" | "own", args: what its start takes, root }
function guestPlace(req: Viewer, p: PostRef, known) {
  if (!takesFolders(known.D, known.local)) return { how: "none", args: {} };
  // The thread's own folder, when its agent works in one (an OpenClaw thread's is its agent's workspace, elsewhere).
  const root = takesFolders(p.D, p.s.agent) && !p.s.cloud ? p.s.cwd || p.s.root || null : null;
  if (root && known.D === p.D) return { how: "same", args: { root }, root };
  if (root) {
    const ws = workspacesOf(viewForReq(req));
    const there = ws.under({ root: p.s.root || root, machine: p.D.name }).map((id) => ws.list.find((w) => w.id === id)?.checkouts.find((c) => c.machine === known.D.name)?.root).find(Boolean);
    if (there) return { how: "checkout", args: { root: there }, root: there };
  }
  return { how: "own", args: { for_talk: `guests-${crypto.createHash("sha256").update(p.id).digest("hex").slice(0, 16)}` } };
}
// The thread a guest is: its post, or, while it starts, the post its launch became.
export function guestPost(g: ThreadGuest) {
  if (g.post) return g.post;
  const r = g.launch && relay.resolve(g.launch);
  const l = r && r.D.store.state.launches[r.local];
  return l?.post ? relay.idOf(r.D, l.post) : null;
}
// Thread `post` as a guest: the record of the thread it's a guest in, when it hasn't left; else null.
export const guestRecord = (post: string) => (post && Object.values(state.thread_guests || {}).find((g) => !g.removed && guestPost(g) === post)) || null;
// Who's in thread `post`'s conversation: the thread itself first, then its guests that haven't left, by the page's ids.
// For a guest, the thread it's a guest in.
export function together(post: string) {
  const g = guestRecord(post);
  const host = g ? g.host : post;
  return [host, ...guestsOf(state, host).filter((x) => !x.removed).map(guestPost).filter((x) => x && x !== host)];
}
// A thread that was running when it was brought in (no launch of its own) is in the conversation from then on: what
// it said before isn't part of it. Of its messages `ms`, those since it joined (again, if it had left): the ones after
// the last it had then, or, if that one is gone, by the time.
export function sinceJoined<T extends { id: string; at: Iso }>(g: ThreadGuest, ms: T[]): T[] {
  if (!g || g.launch || !g.post || g.after === "none") return ms;
  const i = g.after ? ms.findIndex((m) => m.id === g.after) : -1;
  return i >= 0 ? ms.slice(i + 1) : ms.filter((m) => String(m.at) >= (g.back || g.at));
}
// The guests of `host` that joined that way, by their thread's id.
function joinedIn(host) {
  const out = {};
  for (const g of guestsOf(state, host)) if (!g.launch && g.post) out[g.post] = g;
  return out;
}
// The files message `m` of machine `D` hands over (an agent's ab_file, what the person attached), each with the page's
// id, which ab_thread_read({ file }) takes: a guest on another machine has no other way to them. `m` has the
// machine's ids (its store) or the page's (a thread's page).
export function filesIn(D: Device, m: { file_id?: string | null; files?: unknown }) {
  const ids = [m.file_id, ...(Array.isArray(m.files) ? m.files : []).map((x) => (typeof x === "string" ? x : x?.id))].filter(Boolean);
  return ids
    .map((id) => {
      const r = relay.resolve(id);
      return fileOf(D.store.state, r && r.D === D ? r.local : id);
    })
    .filter(Boolean)
    .map((f) => ({ id: relay.idOf(D, f.id), name: f.name }));
}
// What thread `post` hasn't heard of the others in its conversation: what each of them said, what the person said to
// them, and who joined, since it last heard, as one message to hand it with what it gets anyway. null when there's
// nothing; marks it told (thread.seen).
export function threadNewsFor(post: string) {
  const all = together(post);
  if (all.length < 2) return null;
  const mine = guestRecord(post);
  const since = state.thread_seen?.[post] || (mine ? mine.back || mine.at : "");
  // A thread a person started themselves is theirs, with no agent of its own.
  const talk = talkOf(all[0]);
  const hostRef = !talk && postRef(all[0]);
  const o = talk ? accounts.byId(talk.owner) : hostRef && ownerOf(hostRef.D);
  const person = o?.display_name || o?.username || "The person";
  const lines = [];
  const joined = joinedIn(all[0]);
  // There, what they said to the others, or to nobody. What they said to this one, it got as it is.
  if (talk)
    for (const m of talk.messages) {
      if (!(m.at > since) || (mine && m.sent.includes(mine.id))) continue;
      const to = m.sent.map((gid) => whoOf(sentTo(gid))).filter(Boolean);
      lines.push({ at: m.at, text: `${person}${to.length ? ` to ${to.join(", ")}` : " said"}: ${newsQuote(m.text)}` });
    }
  for (const id of all) {
    const p = id !== post && postRef(id);
    if (!p) continue;
    const who = `${p.s.label} (${p.agent?.name || "an agent"})`;
    const guest = id !== all[0] && !talk;
    const got = talk ? sentTexts(talk, null) : null;
    for (const m of sinceJoined(joined[id], conversationOf(p.D.store.state, p.local))) {
      // A slash command, and what it printed, are that thread's own business.
      if (!(m.at > since) || m.queued || m.command || (m.from === "agent" && /^agentbook /.test(m.text))) continue;
      const files = filesIn(p.D, m);
      if (!m.text && !files.length) continue;
      // What it got from a person's own thread is said above.
      if (got && m.from === "human" && m.text && got.has(m.text.trim())) continue;
      const quoted = saidWith(m.text ? newsQuote(m.text) : "", files);
      lines.push({ at: m.at, text: m.from === "human" ? `${person} to ${who}: ${quoted}` : m.text ? `${who}${guest ? ", a guest," : ""} said: ${quoted}` : `${who}${guest ? ", a guest," : ""} ${quoted}`, files: files.length });
    }
  }
  for (const g of guestsOf(state, all[0])) {
    const gp = guestPost(g);
    const at = g.back || g.at;
    if (!g.removed && gp && gp !== post && at > since) lines.push({ at, text: `${whoOf(gp) || "An agent"} joined${talk ? "" : ", as a guest"}` });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.at.localeCompare(b.at));
  commit({ t: "thread.seen", post, upto: lines.at(-1).at });
  const news = newsText(lines);
  return lines.slice(-NEWS_LINES).some((l) => l.files) ? `${news}\n  ${READ_FILES}` : news;
}
// What a guest is told when it joins, after what you wrote: the thread it's in (as a thread is described to its group,
// postForGroup), where it works, and how its words reach the thread.
function guestBrief(p: PostRef, known, user, place) {
  const person = user?.display_name || user?.username || "The person";
  const name = `${p.s.label}, ${p.agent?.name || "an agent"}`;
  const where = takesFolders(p.D, p.s.agent) && !p.s.cloud ? p.s.cwd || p.s.root : null;
  const its = where ? `${p.s.label} works in ${where}${p.s.branch ? `, on branch ${p.s.branch}` : ""}${place.how === "same" ? "" : `, on ${p.D.name}`}` : null;
  const works =
    place.how === "same"
      ? `${its}, and so do you: read anything, change files only when ${person} asks you to, and never commit, stash or reset there.`
      : place.how === "checkout"
        ? `${its}. You work on ${known.D.name}, in ${place.root}: that machine's checkout of the same workspace, as it stands there. It can be on another branch, and has nothing ${p.s.label} hasn't pushed. Read anything, change files only when ${person} asks you to, and never commit, stash or reset there.`
        : place.how === "own"
          ? `${its ? `${its}. ` : ""}You work in a folder of this thread's own on ${known.D.name}, with nothing of ${person}'s in it: what's said in the thread is what you have to go on.`
          : `${its ? `${its}. ` : ""}You have no folder there, and can't read its files: what's said in the thread is what you have to go on.`;
  // Agents with agentbook's tools read the rest themselves; the others may have them (its plugin for OpenClaw, Hermes's).
  const rest = capsOf(known.a.kind).tools === "sure" ? "ab_thread_read has the rest of the thread, and the files handed over in it." : "If you have agentbook's tools, ab_thread_read has the rest of the thread, and the files handed over in it.";
  return [
    `[${person} brought you into their thread "${titleOf(p.s)}" on agentbook (${name}), ${postLink(p.id)}. You're a guest there: what you say shows in that thread. ${person}'s messages that @ you come to you; the rest go to ${p.s.label}, and you'll hear them with your next message.`,
    postForGroup(groupState({ messagesOf: p.id }), { ...p.s, id: p.id }, { person, filesOf: (m) => filesIn(p.D, m) }),
    `${works} ${rest}]`,
  ].join("\n");
}
// A thread of the person's own that can be brought into thread `host` as it is: its ref, or { error, status }. Not the
// thread itself, one that's a guest somewhere already, one with guests of its own, or one that takes no messages here.
export function joinable(req: Viewer, host, id: string) {
  const gp = postRef(id);
  if (!gp || !isOwner(req, gp.D)) return { status: 404, error: "No such thread of yours." };
  if (gp.id === host) return { status: 400, error: "A thread can't be its own guest." };
  const there = guestRecord(gp.id);
  const hostName = (h) => (talkOf(h) ? `"${talkTitle(talkOf(h))}"` : postRef(h)?.s.label || "another thread");
  if (there) return { status: 409, error: `${gp.s.label} is a guest in ${there.host === host ? "this thread" : hostName(there.host)} already${there.host === host ? "." : ": take it out of that one first."}` };
  if (guestsOf(state, gp.id).some((x) => !x.removed)) return { status: 409, error: `${gp.s.label} has guests of its own: bring this thread into it instead, or take them out first.` };
  if (!guestKind(gp.agent || {}) || gp.s.cloud) return { status: 400, error: `${gp.s.label} can't join a thread: only threads of ${GUEST_NAMES} agents can.` };
  return { gp };
}
// Its record as a guest of `host` from now on (the guest it was, if it was in it before), with the last message it has,
// so that what it said before stays out of the conversation. -> the record's id.
export function joinAs(req: Viewer, host, gp) {
  const was = guestsOf(state, host).find((x) => guestPost(x) === gp.id);
  const gid = was?.id || `j-${crypto.randomBytes(8).toString("hex")}`;
  const after = conversationOf(gp.D.store.state, gp.local).at(-1)?.id || "none";
  commit({ t: "thread.guest", gid, host, agent: relay.idOf(gp.D, gp.s.agent), post: gp.id, after, by: { user: viewerName(req) } });
  return gid;
}
// What a thread that's running is told when it's brought into thread `p`, after what you wrote: the thread it's in now,
// and that it goes on as it was, where it was.
function joinBrief(p: PostRef, gp, user) {
  const person = user?.display_name || user?.username || "The person";
  const where = takesFolders(p.D, p.s.agent) && !p.s.cloud ? p.s.cwd || p.s.root : null;
  const rest = capsOf(gp.agent?.kind).tools === "sure" ? "ab_thread_read has the rest of that thread, and the files handed over in it." : "If you have agentbook's tools, ab_thread_read has the rest of that thread, and the files handed over in it.";
  return [
    `[${person} brought this thread into their thread "${titleOf(p.s)}" on agentbook (${p.s.label}, ${p.agent?.name || "an agent"}), ${postLink(p.id)}, as a guest: from now on, what you say shows in that thread too. ${person}'s messages there that @ you come to you; the rest go to ${p.s.label}, and you'll hear them with your next message.`,
    postForGroup(groupState({ messagesOf: p.id }), { ...p.s, id: p.id }, { person, filesOf: (m) => filesIn(p.D, m) }),
    `${where ? `${p.s.label} works in ${where}${p.s.branch ? `, on branch ${p.s.branch}` : ""}${gp.D === p.D ? "" : `, on ${p.D.name}`}. ` : ""}You go on as you were, where you were, with what you know: change nothing of ${p.s.label}'s unless ${person} asks you to. ${rest}]`,
  ].join("\n");
}
// A thread's guests as its page shows them: each one's thread, agent, label, how it's doing and what it's doing this
// moment, and whether it left.
export function guestsSeen(host) {
  return guestsOf(state, host).map((g) => {
    const id = guestPost(g);
    const p = id && postRef(id);
    const d = p && sessionDetail(p.D.store.state, p.local);
    // One still starting: how its start went, when its machine said it couldn't.
    const r = !p && g.launch && relay.resolve(g.launch);
    const failed = (r && r.D.store.state.launches[r.local]?.error) || null;
    const now = p && d.state !== "done" && relay.online(p.D) ? relay.infoOf(p.D)[`post:${p.local}`]?.live ?? null : null;
    return { id: id || g.launch, agent: g.agent, label: p?.s.label || null, title: p ? titleOf(p.s) : null, effective: d ? d.effective : failed ? "failed" : "starting", ...(failed ? { error: failed } : {}), live: g.removed ? null : now, at: g.at, removed: g.removed || null };
  });
}
// A change on a guest's thread is one on the thread it's a guest in, which shows what it says and does.
export function hostHears(id: string) {
  const g = Object.keys(state.thread_guests || {}).length ? guestRecord(id) : null;
  if (g) live.mark({ thread: g.host });
}
// Two lists of messages as one, in time: `b`'s go in among `a`'s, whose order stays as it is.
export function byTime<A extends { at: Iso }, B extends { at: Iso }>(a: A[], b: B[]): (A | B)[] {
  b.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const out: (A | B)[] = [];
  let j = 0;
  for (const m of a) {
    while (j < b.length && String(b[j].at) < String(m.at)) out.push(b[j++]);
    out.push(m);
  }
  return out.concat(b.slice(j));
}
// A thread's guests whose threads this request may see, each with its thread's ref.
export function guestsShown(req: Viewer, host) {
  return guestsOf(state, host)
    .map((g) => ({ g, gp: guestPost(g) && postRef(guestPost(g)) }))
    .filter(({ gp }) => gp && (seesPost(req, gp) || sharedOf(req, host) !== undefined));
}
// What a guest said while it was in the thread, and what you said to it, as the thread shows it (by the page's ids,
// each saying whose it is).
// (One that was running when it was brought in: from then on.)
export const guestSaid = (g: ThreadGuest, gp: PostRef, ms: StoredMessage[]) => relay.qualify(gp.D, sinceJoined(g, ms).filter((m) => !m.queued && (!g.removed || m.at < g.removed)).map((m) => ({ id: m.id, post: m.post, from: m.from, via: m.via, text: m.text, file_id: m.file_id, files: m.files, at: m.at }))).map((m) => ({ ...m, guest: gp.id, agent: g.agent }));
// The guests to show on a thread's roster for this request: its owner sees all (they're the owner's own agents);
// anyone else (a public host thread) sees only guests whose own thread they may see, so a private guest thread's
// title and agent don't leak — the same rule talkRecord uses.
function guestRoster(req: Viewer, host) {
  const hp = postRef(host);
  const mine = hp ? isOwner(req, hp.D) : false;
  const shown = new Set(guestsShown(req, host).map(({ gp }) => gp.id));
  return guestsSeen(host).filter((g) => mine || shown.has(g.id)).map((g) => {
    if (!mine) return g;
    // The owner's composer can address each guest directly: its queue, resume and command controls need that
    // recipient's state and runtime, rather than inheriting the host's. Keep these details on the owner's view.
    const p = postRef(g.id);
    if (!p) return g;
    const info = relay.infoOf(p.D)[`post:${p.local}`] || {};
    const d = sessionDetail(p.D.store.state, p.local, { going: () => (relay.online(p.D) && info.going) || null });
    return { ...g, state: d.state, busy: d.busy, asleep: d.asleep, session_id: d.session_id, rt: info.rt || null, going: d.going };
  });
}
// Thread `p`'s detail (`d`, as its page gets it) with its guests: who they are and how they're doing, what each said
// in its conversation (with your messages to it) in time with its own, and what they ask you. And, for a thread that
// is a guest, the thread it's in.
export function withGuests(req: Viewer, p: PostRef, d: ThreadPayload): ThreadPayload {
  const out = { ...d };
  const was = Object.values(state.thread_guests || {}).filter((g) => guestPost(g) === p.id).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (was) {
    const tk = talkOf(was.host);
    const h = !tk && postRef(was.host);
    // In a person's own thread: whose it is.
    out.guest_of = tk ? { id: was.host, talk: true, by: accounts.byId(tk.owner)?.username || tk.by, label: null, agent: null, title: talkTitle(tk), removed: was.removed || null } : { id: was.host, label: h?.s.label || null, agent: h ? relay.idOf(h.D, h.s.agent) : null, title: h ? titleOf(h.s) : null, removed: was.removed || null };
  }
  const shown = guestsShown(req, p.id);
  if (!guestsOf(state, p.id).length) return out;
  out.guests = guestRoster(req, p.id);
  const theirs: Message[] = [];
  const asks: Question[] = [];
  for (const { g, gp } of shown) {
    const st = gp.D.store.state;
    theirs.push(...guestSaid(g, gp, conversationOf(st, gp.local)));
    if (isOwner(req, gp.D) && !g.removed) asks.push(...relay.qualify(gp.D, st.questions.filter((q) => q.post === gp.local)).map((q) => ({ ...q, guest: gp.id, agent: g.agent })));
  }
  out.messages = byTime([...(d.messages || [])], theirs);
  out.questions = [...(d.questions || []), ...asks];
  return out;
}
// A thread's card in the feed, with its guests (their faces, by its agent's) and their last messages among its own.
export function guestsCard(req: Viewer, s: Thread): Thread {
  if (!guestsOf(state, s.id).length) return s;
  const theirs: Message[] = [];
  for (const { g, gp } of guestsShown(req, s.id)) theirs.push(...guestSaid({ ...g, after: "none" }, gp, sinceJoined(g, conversationOf(gp.D.store.state, gp.local)).slice(-3)));
  return { ...s, guests: guestRoster(req, s.id), last_messages: byTime([...(s.last_messages || [])], theirs).slice(-3) };
}
// What a session is told about the conversation it's in (context.ts puts it after its own lines): that it's a guest
// in a thread, or that its thread has guests. null when neither.
// Who sees a thread of someone's own besides them, as its agents are told: their contacts once it's public, and the
// people they put on it.
function talkReadersFacts(tk) {
  if (!tk) return "";
  const names = threadPeople(tk.id).map((id) => accounts.byId(id)?.username).filter(Boolean).map((n) => `@${n}`);
  const on = names.length ? `${names.join(", ")}, whom its person put on it` : "";
  if (levelOf(tk.visibility) === "public") return ` It's public: its person's contacts${on ? `, and ${on},` : ""} see it, with what you do in it: keep secrets out of it.`;
  return on ? ` ${on}, ${names.length === 1 ? "sees" : "see"} it, with what you do in it: keep secrets out of it.` : "";
}
export function guestFacts(post: string, o: User) {
  const person = o?.display_name || o?.username || "The person";
  const g = guestRecord(post);
  const tk = g && talkOf(g.host);
  if (tk) return `You're in ${person}'s own thread "${talkTitle(tk)}", ${postLink(g.host)}: it's theirs, not an agent's, and what you say at the end of each turn shows there as your reply. ${person}'s messages there that name you come to you, and you hear what the others there say with your next message. ab_thread_read reads it.${talkReadersFacts(tk)}`;
  const h = g && postRef(g.host);
  if (h) return `You're a guest in ${person}'s thread "${titleOf(h.s)}" (${whoOf(g.host)}), ${postLink(g.host)}: what you say shows there too. ${person}'s messages there that @ you come to you, and you hear what the others there say with your next message. ab_thread_read reads that thread.`;
  const names = together(post).slice(1).map(whoOf).filter(Boolean);
  if (!names.length) return null;
  return `${person} brought ${names.join(", ")} into this thread as ${names.length === 1 ? "a guest" : "guests"}: what ${names.length === 1 ? "it says" : "they say"} shows in it, and you hear it with your next message. ab_thread_read({ thread }) reads ${names.length === 1 ? "its" : "one's"} thread.`;
}
// ab_thread_read: the thread a session's conversation is in (the one it's a guest in, or its own, with its guests'
// messages among its own), or one of the threads in it (`thread`, a guest's, by its name or id): what it's for, its
// plan, results, pull requests and last messages, and its recent steps.
export async function threadReadFor(D: Device, o: User, me: Asker, b) {
  if (b.file) return threadFileFor(D, o, me, b.post, str(b.file, 300));
  const all = me.post ? together(me.post) : [];
  const want = b.thread ? str(b.thread, 300) : null;
  const here = want ? all.find((x) => x === want || postRef(x)?.s.label === want) : all[0];
  // A thread outside this conversation: one ab_search found.
  if (want && (!here || all.length < 2)) return foundThreadRead(D, o, me, b.post, want, b.at ? str(b.at, 300) : null);
  if (all.length < 2) return { error: "This thread isn't a guest in another and has no guests: ab_thread_read reads the conversation of a thread with guests, or a thread ab_search found.", status: 404 };
  const id = here;
  // A person's own thread: it, and what's been said.
  if (id && talkOf(id)) return { text: talkReadText(talkOf(id)) };
  const p = postRef(id);
  if (!p) return { error: "That thread isn't here any more.", status: 404 };
  const person = o.display_name || o.username || null;
  const r = (await relay.read(p.D, "read.steps", { post: p.local })) as ReadAnswer<StepsAnswer>;
  const steps = (r?.data?.steps || []).filter((st) => st.kind !== "say").map((st) => st.title).filter(Boolean);
  const out = [postForGroup(groupState({ messagesOf: id }), { ...p.s, id }, { person, steps, filesOf: (m) => filesIn(p.D, m) })];
  if (p.s.cwd || p.s.root) out.push(`It works in ${p.s.cwd || p.s.root}${p.s.branch ? `, on ${p.s.branch}` : ""}: git there has what it changed.`);
  if (id === all[0]) {
    // The conversation, with what its guests said among its own: the latest 30.
    const lines = [];
    const joined = joinedIn(all[0]);
    for (const x of all) {
      const q = postRef(x);
      if (!q) continue;
      const guest = x !== all[0];
      for (const m of sinceJoined(joined[x], conversationOf(q.D.store.state, q.local))) {
        const files = filesIn(q.D, m);
        if (m.queued || (!m.text && !files.length)) continue;
        const said = m.from === "human" ? `${person || "the person"}${guest ? ` to ${q.s.label}` : ""}` : `${q.s.label}${guest ? ` (${q.agent?.name || "an agent"}, a guest)` : ""}`;
        lines.push({ at: m.at, text: `  ${said}: ${saidWith(m.text ? newsQuote(m.text) : "", files)}`, files: files.length });
      }
    }
    lines.sort((a, c) => a.at.localeCompare(c.at));
    const shown = lines.slice(-30);
    out.push(`The conversation, with its guests${lines.length > 30 ? " (the latest 30)" : ""}:\n${shown.map((l) => l.text).join("\n")}`);
    if (shown.some((l) => l.files)) out.push(READ_FILES);
  }
  return { text: out.join("\n") };
}

// Bring an agent into thread `:id` (`agent`, with what you wrote, `text`, and `files`): a thread of its own, started
// where the thread works, as its guest, with a note on the thread it's in. Or take one out (`remove`, its thread).
route("POST", "/api/sessions/:id/guests", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const b = await readBody<{ remove?: string; thread?: string; text?: string; files?: unknown[]; agent?: string; mode?: string }>(req);
  if (b.remove) {
    const gid = str(b.remove, 300);
    const g = guestsOf(state, p.id).find((x) => !x.removed && (guestPost(x) === gid || x.launch === gid));
    if (!g) return fail(res, 404, "That agent isn't in this thread.");
    commit({ t: "thread.guest", gid: g.id, remove: true, by: { user: viewerName(req) } });
    return ok(res);
  }
  const host = guestRecord(p.id);
  if (host) return fail(res, 409, `${p.s.label} is a guest in ${postRef(host.host)?.s.label || "another thread"}: bring agents into that one.`);
  // A thread of yours that's there already (`thread`): it joins as it is, with its session, its folder and what it
  // knows, and gets what you wrote as its next message (when its turn ends, while it works).
  if (b.thread) {
    const { gp, error, status } = joinable(req, p.id, str(b.thread, 300));
    if (!gp) return fail(res, status, error);
    const text = expandMentions(str(b.text, 12000), null).trim();
    if (!text) return fail(res, 400, `Say what ${gp.s.label} should do.`);
    const files = uploadsOf(req, b.files);
    const gid = joinAs(req, p.id, gp);
    const notes = notesNamed(req.user, text);
    noteRefs(notes, { post: gp.id });
    const note = [mentionNote(text, pagesSeenBy(req.user), Date.now(), workspacesNamed(req.user, text), { notes }), joinBrief(p, gp, req.user)].filter(Boolean).join("\n\n");
    const busy = sessionDetail(gp.D.store.state, gp.local)?.effective === "working";
    await steer(req, res, gp.D, "post.deliver", { post: gp.local, text, files, note, ...(busy ? { queue: true } : {}) }, { done: (r) => ({ ...r, guest: gp.id, ...(r.lid ? { lid: relay.idOf(gp.D, r.lid) } : {}) }) });
    // Its machine wouldn't take it (or wants it signed first, and the page asks again): it isn't in it.
    if (res.statusCode >= 400) commit({ t: "thread.guest", gid, remove: true });
    return;
  }
  const known = agentRef(str(b.agent, 200));
  if (!known || !isOwner(req, known.D)) return fail(res, 403, "Only an agent's owner can give it work.");
  if (!canStart(res, known.D, known.local)) return;
  if (!guestKind(known.a)) return fail(res, 400, NOT_A_GUEST(known.a));
  const mode = modeFor(b, known.a);
  if (mode === false) return fail(res, 400, `${known.a.name} can't start in that mode.`);
  const place = guestPlace(req, p, known);
  const seen = pagesSeenBy(req.user);
  const text = expandMentions(str(b.text, 12000), null).trim();
  const files = uploadsOf(req, b.files);
  if (!text) return fail(res, 400, `Say what ${known.a.name} should do.`);
  const lid = launchId();
  const notes = notesNamed(req.user, text);
  const note = [mentionNote(text, seen, Date.now(), workspacesNamed(req.user, text), { notes }), guestBrief(p, known, req.user, place)].filter(Boolean).join("\n\n");
  // A guest by the launch its machine starts: a start the page signs after a 428 is that request's, with its launch id.
  let gid = null as string | null;
  const sending = (a: Record<string, unknown>) => {
    gid = relay.idOf(known.D, String(a.lid || lid));
    commit({ t: "thread.guest", gid, host: p.id, agent: known.id, launch: gid, by: { user: viewerName(req) } });
    noteRefs(notes, { launch: gid });
  };
  await steer(req, res, known.D, "post.start", { lid, agent: known.local, prompt: text, files, ...place.args, note, ...(mode ? { mode } : {}) }, { wait: 60e3, sending, done: (r) => ({ ...r, guest: gid, lid: r.lid ? relay.idOf(known.D, r.lid) : gid }) });
  // Its machine wouldn't start it: it isn't one.
  if (gid && res.statusCode >= 400) commit({ t: "thread.guest", gid, remove: true });
});
