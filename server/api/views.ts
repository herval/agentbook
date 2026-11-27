// What the page shows each person: everything they may see, from every area, and telling their open pages when it
// changes (pushLive).

import path from "node:path";
import { agentPublic, detailFor, pageFor, viewFor } from "../policy.ts";
import { feedOf, feedParams } from "../feed.ts";
import { rowOf } from "../side.ts";
import { namesIn, namesNear } from "../names.ts";
import { workspacesOf } from "../feed.ts";
import { bellLine } from "../news.ts";
import { searchWords } from "../../plugin/shared/search.ts";
import { isTalkId, talkTitle } from "../../plugin/shared/talks.ts";
import { routinesOfPage } from "../../plugin/shared/routines.ts";
import { sessionDetail } from "../../plugin/shared/store.ts";
import { COMMANDS } from "../../plugin/shared/protocol.ts";
import { PREVIEW_URL } from "../config.ts";
import type { FeedQ, LiveLine, TheirCard, Thread, ThreadCard, ThreadSnapshot } from "../../plugin/shared/api.ts";
import type { User } from "../accounts.ts";
import type { Device, QueuedCommand } from "../relay.ts";
import type { StartArgs } from "../storage/relay.ts";
import type { PageSeen } from "../policy.ts";
import type { CodeRun, Iso, NewsItem, Page, Question, Task, VerdictKind } from "../../plugin/shared/types.ts";
import { accounts, commit, relay, state } from "../core/state.ts";
import type { Req, Viewer } from "../core/http.ts";
import { agentsById, firstMachine, isOwner, keptOff, ownerName, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { agentOnFeed, followsPerson, isContact, liveAccount, seesPost, seesWork, sharedOf, threadPeopleRows } from "../core/follows.ts";
import { signingOf } from "../core/commands.ts";
import { cloud, connectors, dashboards, images, imagesOf, live } from "../core/services.ts";
import { ghFor, workspaceView } from "./prs.ts";
import { titleOf } from "./cli.ts";
import { cookieToken } from "./people.ts";
import { boxOf, boxesFor } from "./machines.ts";
import { messagesSeen, searchMessages } from "./queries.ts";
import { feedMessageHits } from "./search.ts";
import { namesFor, titleNamed } from "./workspaces.ts";
import { onTask, peopleOn } from "./tasks.ts";
import { pageMine, pageOwner, pageOwnerName, pageSeen, threadPages } from "./pages.ts";
import { noteFor, noteKnown, noteSeen } from "./notes.ts";
import { routineState, routines, routinesOf } from "./routines.ts";
import { groupSeen, groupsOf } from "./groups.ts";
import { guestPost, guestsCard, hostHears, withGuests } from "./guests.ts";
import { talkConversation, talkOf, talkQuestions, talkRecord, talkSeen } from "./talks.ts";
import { shipPartsOf } from "./task-ship.ts";
import { UI_STAMP } from "./static.ts";
import { bellSources } from "../core/bell.ts";

// A line on a person's bell (addedFor): what someone put them on or in, who asks to be their contact or said yes, a
// thread Auto-archive archived, or a thread's news. `id`: what it's about; `by`: who, by username; `seen`: from before they
// last opened the bell.
interface BellLine {
  kind: string;
  id: string;
  title: string;
  emoji: string | null;
  by: string | null;
  at: Iso;
  level?: string;
  why?: string | null;
  agent?: string | null;
  label?: string | null;
  news?: NewsItem["kind"];
  text?: string;
  verdict?: VerdictKind;
  mins?: number;
  pr?: NewsItem["pr"];
  link?: string;
  seen?: boolean;
}
// One machine's part of the page as a person sees it (machineSeen's): policy.ts's viewFor, all of it for its owner
// and the public part for others, with the page's ids. The page's view gathers its rows from each machine's.
type MachineQ = ReturnType<typeof machineSeen>["q"];
type AgentRow = MachineQ["agents"][number] & { machine: string; offline: boolean; machine_gone?: boolean; machine_off?: boolean };
// A thread's row: with its machine's name, what waits for it, your pin, its group and whose guest it is.
type ThreadRow = MachineQ["sessions"][number] & {
  machine: string;
  offline: boolean;
  waiting?: ReturnType<typeof heldRow>[];
  group?: string | null;
  guest_of?: string;
  guest_joined?: boolean;
  pinned?: boolean;
  pinned_at?: Iso | null;
  // A thread's row is no talk (talkRecord's rows are), so it has none of a talk's agents.
  talk?: false;
};
// A start's row: one its machine has, or one it hasn't taken yet or refused; with whose guest it is.
type LaunchRow = ((MachineQ["launches"][number] & { machine?: string }) | HeldStart) & { guest_of?: string; guest_joined?: boolean };
// A start its machine hasn't taken yet (`waiting`: for that machine, while it's off; `cid`: its command), or one it
// refused once it took it (`error`, and never its agent's name).
interface HeldStart {
  id: string;
  agent: string;
  root: string | null;
  prompt?: string;
  files: string[];
  at: Iso;
  post: null;
  error: string | null;
  machine: string;
  waiting?: string | null;
  cid?: string;
  named?: boolean;
}
// A page's row (policy.ts's pageFor), with a dashboard's card, and whether it's on their feed.
interface PageRow extends PageSeen {
  face?: unknown;
  followed?: boolean;
}
// A machine, as the page lists it: whose, whether it's on and when it was seen; for its owner, what waits for it,
// whether it signs, its sandbox and how many share it.
interface MachineRow {
  name: string;
  here: boolean;
  mine: boolean;
  online: boolean;
  seen: Iso | null;
  home?: string | null;
  clone_dir?: string | null;
  cli?: string | null;
  os?: string | null;
  update?: unknown;
  waiting?: number;
  signs?: boolean;
  cloud?: ReturnType<typeof cloudView>;
  people?: number;
}
// The page as one person sees it (viewForReq): every machine's part they may see, with the page's ids, and theirs:
// "this machine" (`machine`), the bell, their groups, threads, notes, workspaces, tasks, connectors and the rest.
interface View {
  seq: number;
  agents: AgentRow[];
  sessions: ThreadRow[];
  questions: MachineQ["questions"];
  launches: LaunchRow[];
  folders: (MachineQ["folders"][number] & { machine: string })[];
  cloning: (MachineQ["cloning"][number] & { machine: string })[];
  live: Record<string, LiveLine | null>;
  pages: PageRow[];
  machines: MachineRow[];
  machine?: string | null;
  groups?: (ReturnType<typeof groupsOf>[number] & { posts?: number })[];
  talks?: ReturnType<typeof talkRecord>[];
  added?: BellLine[];
  ui?: string;
  dismissed?: Record<string, string>;
  notes?: ReturnType<typeof noteFor>[];
  workspaces?: ReturnType<typeof workspaceView>[];
  tasks?: ReturnType<typeof tasksFor>;
  connectors?: ReturnType<typeof connectors.summary>;
  images?: ReturnType<typeof images.summary>;
  boxes?: ReturnType<typeof boxesFor>;
  routines?: ReturnType<typeof routinesOf>;
  github?: "connector" | null;
  preview?: string;
}
// What one push makes once, however many pages ask (live.ts's ctx): who each sign-in is now, each person's view, and
// the messages each search found.
interface PushMemo {
  who?: Map<string, User | null>;
  views?: Map<string, View>;
  searches?: Map<string, ReturnType<typeof searchMessages>>;
}
const isStart = <C extends { kind: string; args: Record<string, unknown> }>(c: C): c is C & { args: StartArgs } => c.kind === "post.start";

/* ---------- what the page shows ---------- */

// A machine's sandbox, for its page (cloud.view). A member's seat on a shared machine says whose machine it's on, and
// nothing of what agentbook made there, which is its owner's to see and change.
export function cloudView(D: Device) {
  const v = cloud.view(D);
  if (!v || state.machine_cloud?.[D.id]) return v;
  const b = boxOf(D);
  return { kind: v.kind, sandbox: v.sandbox, connector: null, waking: v.waking, error: v.error, ...(v.sleep ? { sleep: v.sleep } : {}), shared: { machine: b?.host.name || null, owner: accounts.byId(b?.box.owner)?.username || null } };
}
// A machine's view as one person sees it, with the page's ids: all of it for its owner, the public part for others.
export function machineSeen(D: Device, req: Viewer) {
  const o = ownerOf(D);
  const mine = !!req.user && !!o && o.id === req.user.id;
  const seen = viewFor(withoutKeptOff(D, relay.view(D), o), mine, o?.username || D.name, viewerName(req), (local) => sharedOf(req, relay.idOf(D, local)), isContact(req, o?.id));
  return { mine, seen, q: relay.qualify(D, seen) };
}

// Private terminals: a thread of theirs that was on agentbook when they turned it on, and
// wasn't started in agentbook, is off every list while it's on, its questions too; by its link, it's still there.
function withoutKeptOff<V extends { sessions: { id: string }[]; questions?: { post: string }[] }>(D: Device, view: V, o: User | null): V {
  const off = state.private_off;
  if (!o || !off || !state.prefs?.[o.id]?.private_terminals) return view;
  const gone = (local: string) => off[relay.idOf(D, local)] === o.id;
  return { ...view, sessions: view.sessions.filter((s) => !gone(s.id)), questions: (view.questions || []).filter((q) => !gone(q.post)) };
}
// For the bell: what someone else put this person in (a task, a group, a page they keep, a thread), who asks to be
// their contact or said yes to their ask, and their threads' news, in the last week, newest first. `by`: who, by username. They stay until the person dismisses one (bell.dismiss) or
// clears them all (bell.clear); the
// ones from before they last opened the bell say `seen`, and are off its count.
const ADDED_DAYS = 7;
export function addedFor(req: Viewer): BellLine[] {
  const u = req?.user;
  if (!u) return [];
  const since = Math.max(Date.now() - ADDED_DAYS * 864e5, Date.parse(state.bell_cleared?.[u.id] || "") || 0);
  const seenAt = Date.parse(state.bell_seen?.[u.id] || "") || 0;
  const out: BellLine[] = [];
  const add = (kind: string, id: string, title: string, emoji: string | null, m: { by?: string | null; at?: Iso; level?: string } | undefined) => {
    if (m?.by && m.by !== u.username && Date.parse(m.at) > since) out.push({ kind, id, title, emoji, by: m.by, at: m.at, ...(m.level ? { level: m.level } : {}) });
  };
  for (const t of Object.values(state.tasks || {})) if (!t.removed && !t.done) add("task", t.id, t.text, null, (t.people || []).find((x) => x.user === u.id));
  for (const g of Object.values(state.groups || {})) if (!g.archived) add("group", g.id, g.name, g.emoji || "👥", (g.members || []).find((m) => m.user === u.username));
  for (const p of Object.values(state.pages || {})) if (!p.archived) add("page", p.id, p.title, p.emoji || "📄", (p.contributors || []).find((c) => c.user === u.username));
  for (const [id, x] of Object.entries(state.thread_people || {})) {
    const m = x.people.find((p) => p.user === u.id);
    if (!m) continue;
    const tk = isTalkId(id) ? talkOf(id) : null;
    const p = tk ? null : postRef(id);
    if (tk || p) add("thread", id, tk ? talkTitle(tk) : titleOf(p.s), null, m);
  }
  // Someone who asks to be their contact, with what they said; someone who said yes to theirs.
  for (const c of Object.values(state.contacts || {})) {
    if (c.a !== u.id && c.b !== u.id) continue;
    const who = accounts.byId(c.a === u.id ? c.b : c.a);
    if (!who || !liveAccount(who.id)) continue;
    const name = who.display_name || who.username;
    if (!c.at && c.ask === who.id && Date.parse(c.ask_at) > since) out.push({ kind: "contact-ask", id: who.username, title: name, emoji: null, by: who.username, at: c.ask_at, ...(c.note ? { text: c.note } : {}) });
    else if (c.at && c.by === u.id && Date.parse(c.at) > since) out.push({ kind: "contact", id: who.username, title: name, emoji: null, by: who.username, at: c.at });
  }
  // A thread of theirs Auto-archive archived: its agent (by its page id), its name and why ("#12 merged").
  for (const [id, x] of Object.entries(state.auto_archived || {})) {
    if (x.user !== u.id || x.skipped || !(Date.parse(x.at) > since)) continue;
    const p = postRef(id);
    out.push({ kind: "archived", id, title: (p && titleOf(p.s)) || x.title || "A thread", emoji: null, by: null, at: x.at, why: x.why, agent: p ? relay.idOf(p.D, p.s.agent) : null, label: p?.s.label || null });
  }
  // Their threads' news (news.ts): a long turn that ended, a pull request that merged or went bad, what an agent
  // flagged. Not of a thread that's gone or kept off their lists, and a merge Auto-archive already says isn't said twice.
  for (const x of state.news?.[u.id] || []) {
    if (!(Date.parse(x.at) > since)) continue;
    const p = postRef(x.post);
    if (!p || keptOff(u.id, p.id)) continue;
    const gone = state.auto_archived?.[p.id];
    if (x.kind === "pr" && x.pr?.kind === "merged" && gone && !gone.skipped && Date.parse(gone.at) > since) continue;
    out.push({ kind: "news", news: x.kind, id: p.id, title: titleOf(p.s), emoji: null, by: null, at: x.at, text: bellLine(x), agent: relay.idOf(p.D, p.s.agent), label: p.s.label || null, ...(x.verdict ? { verdict: x.verdict } : {}), ...(x.mins ? { mins: x.mins } : {}), ...(x.pr ? { pr: x.pr } : {}), ...(x.link ? { link: x.link } : {}) });
  }
  // And what other parts keep (../core/bell.ts): someone elsewhere naming you.
  for (const fn of bellSources) out.push(...fn(u, since));
  for (const x of out) if (!(Date.parse(x.at) > seenAt)) x.seen = true;
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// A command waiting for its machine, as a thread shows it: what it is, when it was sent, and a message's text. Only
// what its person sent it: the server's own bookkeeping (`kept`) isn't theirs to see go by, nor to take back.
const heldRow = (c: QueuedCommand) => ({ cid: c.cid, kind: c.kind, at: c.at, text: typeof c.args.text === "string" ? c.args.text || null : null });
const heldOf = (D: Device) => relay.waiting(D).filter((c) => !COMMANDS[c.kind]?.kept);

// The page as one person sees it: every machine's part they may see, and their own pins, workspaces and tasks.
export function viewForReq(req: Viewer): View {
  const v: View = { seq: 0, agents: [], sessions: [], questions: [], launches: [], folders: [], cloning: [], live: {}, pages: [], machines: [] };
  const yours: Device[] = [];
  for (const D of relay.devices.values()) {
    const { mine, seen, q } = machineSeen(D, req);
    const online = relay.online(D);
    v.seq += D.store.state.seq;
    // What you sent its threads that it hasn't taken yet (it's off, or hasn't answered): on each one's row, so its
    // card shows it by its reply box, where you sent it, rather than only once you open the thread.
    const held = mine ? heldOf(D) : [];
    const heldOn = new Map();
    for (const c of held) if (typeof c.args.post === "string" && c.args.post) heldOn.set(relay.idOf(D, c.args.post), [...(heldOn.get(relay.idOf(D, c.args.post)) || []), heldRow(c)]);
    for (const s of q.sessions) {
      const w = heldOn.get(s.id);
      v.sessions.push({ ...s, machine: D.name, offline: !online, ...(w ? { waiting: w } : {}) });
    }
    v.questions.push(...q.questions);
    v.launches.push(...q.launches.map((l) => ({ ...l, machine: D.name })));
    // Starts its machine hasn't taken yet: waiting for it while it's off, starting while it's on. One it took is its
    // launch there (above while it's new, then its thread), even while its answer hasn't come back.
    for (const c of held) if (isStart(c) && !D.store.state.launches[c.args.lid] && !q.launches.some((l) => l.id === c.args.lid)) v.launches.push({ id: c.args.lid, agent: relay.idOf(D, c.args.agent), root: c.args.root || null, prompt: c.args.prompt, files: [], at: c.at, post: null, error: null, machine: D.name, waiting: online ? null : D.name, cid: c.cid });
    // Starts it refused once it took them (its gate, a folder it couldn't use): said, until archived.
    if (mine) for (const c of relay.failedStarts(D)) if (!q.launches.some((l) => l.id === c.args.lid)) v.launches.push({ id: c.args.lid, agent: relay.idOf(D, c.args.agent), root: c.args.root || null, prompt: c.args.prompt, files: [], at: c.at, post: null, error: c.result.error, machine: D.name, named: false });
    for (const [k, l] of Object.entries(seen.live || {})) v.live[relay.idOf(D, k)] = l;
    for (const f of q.folders || []) v.folders.push({ ...f, machine: D.name });
    for (const c of q.cloning || []) v.cloning.push({ ...c, machine: D.name });
    // A machine logged out keeps its threads, but its agents take nothing more: nothing would ever deliver it.
    const gone = !online && !!accounts.deviceById(D.id)?.revoked;
    for (const a of q.agents) v.agents.push({ ...a, machine: D.name, offline: !online || !!a.offline, ...(online ? {} : gone ? { machine_gone: true } : { machine_off: true }) });
    const minfo = relay.infoOf(D).machine;
    v.machines.push({
      name: D.name,
      here: false,
      mine,
      online,
      seen: D.seen ? new Date(D.seen).toISOString() : null,
      home: "home" in seen ? seen.home : undefined,
      clone_dir: "clone_dir" in seen ? seen.clone_dir : undefined,
      ...(mine
        ? {
            ...(minfo?.cli ? { cli: minfo.cli } : {}),
            ...(minfo?.os ? { os: minfo.os } : {}),
            ...(minfo?.update ? { update: minfo.update } : {}),
            ...(minfo?.history ? { history: minfo.history } : {}),
            waiting: held.length,
            signs: !!signingOf(D),
            ...(cloudView(D) ? { cloud: cloudView(D) } : {}),
            ...(state.boxes?.[D.id] ? { people: Object.keys(state.boxes[D.id].members).length } : {}),
          }
        : {}),
    });
    if (mine) yours.push(D);
  }
  v.seq += state.seq;
  v.sessions.sort((a, b) => b.updated.localeCompare(a.updated));
  // The machines: yours, and the ones with something on them you may see.
  const seen = new Set([...v.sessions, ...v.agents].map((x) => x.machine));
  v.machines = v.machines.filter((m) => m.here || m.mine || seen.has(m.name));
  // "This machine": your first that's on, else the one seen last.
  v.machine = firstMachine(yours)?.name || null;
  for (const m of v.machines) m.here = m.name === v.machine;
  // Pages: every page they may see.
  const agents = agentsById();
  v.pages = Object.values(state.pages)
    .map((p) => pageFor(pageSummaryOf(p), agents, pageMine(req, p), pageOwnerName(p), viewerName(req), (id) => seesPost(req, postRef(id)), isContact(req, pageOwner(p))))
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
  // A dashboard's card and tile draw its own view's last answers, small, without asking its sources (dashboards.ts).
  for (const p of v.pages) if (p.kind === "dashboard") p.face = dashboards.face(state.pages[p.id]);
  const pins = req.user ? accounts.pins(req.user.id) : new Map();
  for (const s of v.sessions) Object.assign(s, { pinned: pins.has(s.id), pinned_at: pins.get(s.id) || null });
  // The groups they see (theirs, and others' public ones), and the group each thread they see is in. Others' count
  // only the threads in them they see.
  v.groups = groupsOf(req);
  const seenGroups = new Set(v.groups.map((g) => g.id));
  for (const s of v.sessions) if (seenGroups.has(state.group_posts[s.id]?.group)) s.group = state.group_posts[s.id].group;
  for (const g of v.groups) if (!g.mine) g.posts = v.sessions.filter((s) => s.group === g.id).length;
  // A thread that's a guest in another (guests.ts): its own card isn't in the feed, the other's shows it.
  for (const g of Object.values(state.thread_guests || {})) {
    if (g.removed) continue;
    const id = guestPost(g);
    const s = id ? v.sessions.find((x) => x.id === id) : v.launches.find((l) => l.id === g.launch);
    if (s) s.guest_of = g.host;
    // One that was a thread already when it was brought in keeps its card in the feed.
    if (s && !g.launch) s.guest_joined = true;
  }
  // Threads people started themselves: theirs, and others' public ones, shaped as threads.
  v.talks = req.user ? Object.values(state.talks || {}).filter((t) => talkSeen(req, t)).map((t) => ({ ...talkRecord(req, t), pinned: pins.has(t.id), pinned_at: pins.get(t.id) || null })) : [];
  // The page each thread is on, when it's one they see.
  const onPage = threadPages();
  const shown = new Set(v.pages.map((p) => p.id));
  for (const s of v.sessions) s.page = shown.has(onPage[s.id]) ? onPage[s.id] : null;
  // Followed pages show on your feed when they change; the rest only in Pages and the sidebar. The ones you're in
  // start followed: yours, the ones you contribute to (can_edit), and those of the contacts you follow,
  // until you unfollow one.
  const follows = req.user ? accounts.follows(req.user.id) : new Map();
  const byFollowed = (p) => !p.mine && !!req.user && !!state.pages[p.id] && followsPerson(req.user.id, pageOwner(state.pages[p.id]));
  // One whose latest update you archived is under
  // Archived on your feed until it changes again: `feed_archived`, yours alone. The page itself goes on as it was.
  const put = (req.user && state.feed_archived?.[req.user.id]) || {};
  v.pages = v.pages.map((p) => ({ ...p, followed: follows.get(p.id) ?? (!!p.mine || !!p.can_edit || byFollowed(p)), ...(put[p.id] != null && put[p.id] >= (p.moved || p.updated || "") ? { feed_archived: true } : {}) }));
  // Your feed: your own threads, and of anyone else's only what reaches you: a thread of a contact you follow, unless
  // you turned its agent off, or of an agent of theirs you follow on its own; one you're on, or in a group, task or
  // page you're in; a page you follow. The rest stays on its agent's and its person's profile, by its link and in
  // search (feed.ts, under `feed`).
  const followedPages = new Set(v.pages.filter((p) => p.followed).map((p) => p.id));
  const uid = req.user ? req.user.id : null;
  const onFeed = new Map<string, boolean>();
  const agentOn = (agent: string, owner: string) => {
    if (!agent || !uid) return false;
    if (!onFeed.has(agent)) onFeed.set(agent, agentOnFeed(uid, agent, accounts.byUsername(owner)?.id || null));
    return onFeed.get(agent);
  };
  // The ones that don't, by id (`offFeed`): not enumerable, so it never goes out with the view; only feed.ts reads it.
  const offFeed = new Set();
  for (const s of v.sessions) if (!(s.mine !== false || agentOn(s.agent, s.owner) || followedPages.has(s.page) || sharedOf(req, s.id) !== undefined)) offFeed.add(s.id);
  for (const t of v.talks) if (!(t.mine || (!!uid && followsPerson(uid, accounts.byUsername(t.owner)?.id)) || sharedOf(req, t.id) !== undefined)) offFeed.add(t.id);
  Object.defineProperty(v, "offFeed", { value: offFeed });
  // The bell's notifications (addedFor), and the lines they took off it.
  v.added = addedFor(req);
  v.ui = UI_STAMP;
  v.dismissed = (req.user && state.bell_dismissed?.[req.user.id]) || {};
  // Notes: theirs, the ones they're on, and others' they see by their level, newest first (notes.ts).
  const nk = req.user ? noteKnown(req) : null;
  v.notes = req.user ? Object.values(state.notes).filter((n) => noteSeen(req, n)).map((n) => noteFor(req, n, nk)).sort((a, b) => b.updated.localeCompare(a.updated)) : [];
  v.workspaces = req.user ? Object.values(state.workspaces).filter((w) => w.owner === req.user.id).map((w) => workspaceView(w, v.sessions)) : [];
  v.tasks = req.user ? tasksFor(req.user.id, v) : [];
  // Titles taken from a prompt that names a task or a group read their names (titleNamed).
  const names = namesFor(req, v.sessions);
  if (names) for (const s of v.sessions) s.title = titleNamed(s.title, ...names);
  v.connectors = req.user ? connectors.summary(req.user.id) : [];
  // Their images for cloud machines, briefly: a page that shows them asks for the rest when this changes.
  v.images = req.user && imagesOf ? imagesOf(req.user.id) : [];
  // The machines shared with them: invitations to join, and the ones they're on.
  v.boxes = req.user ? boxesFor(req.user.id) : [];
  // Everything agentbook runs on a schedule for them (routines.ts). A page's are on the page too.
  v.routines = req.user ? routinesOf(req.user.id, { archived: true }) : [];
  // Whether GitHub is read as you here (for your workspaces' pull requests): through your GitHub connector. Null:
  // connect GitHub first.
  v.github = req.user && ghFor(req.user.id) ? "connector" : null;
  if (PREVIEW_URL) v.preview = PREVIEW_URL;
  return v;
}
const pageSummaryOf = (p: Page) => ({ ...p, versions: state.page_versions.reduce((n, v) => n + (v.page === p.id ? 1 : 0), 0), routines: routinesOfPage(routineState(), p.id, routines?.running) });

// Your tasks, and the ones shared with you: the open ones, and the ones done in the last two
// weeks. A task sent to an agent on another machine learns its session here, from the view of every machine that only
// the hub's page puts together.
export const TASKS_DONE_MS = 14 * 86400e3;
const linking = new Set(); // launches whose task.linked is on its way
function tasksFor(uid: string, v) {
  const list = Object.values(state.tasks).filter((t) => onTask(t, uid) && !t.removed && (t.owner === uid || !t.scope) && (!t.done || Date.now() - Date.parse(t.done_at) < TASKS_DONE_MS));
  return linkSent(list, v).map((t) => shipView(taskSeenBy(t, uid)));
}
// A task as someone on it sees it: who's on it, by username, whose it is (`mine`, `owner_name`), who ticked it
// (`done_user`), and their own place for it on their list (`rank`). Someone it's shared with doesn't get its owner's
// workspace or agent (theirs alone), nor a page or group of theirs they may not see.
// What a task ships, for someone who isn't its owner: their page can't find it as its owner's does, from their
// workspaces and checkouts. Each pull request with how GitHub last had it, each branch,
// and the threads on each. For someone not on it (a public one), only the threads they see (`shown`), and a branch
// only when put in by hand or one of those is on it: its name is a private thread's title.
// `work`: someone on it, who opens each one's worktree (its branch on the machine of whoever
// is on it that has it, read through the task's routes): `where` says how it stands there, never in which folder.
export function taskParts(t: Task, shown = null, { work = false } = {}) {
  if (!t.posts.length && !t.ship?.items?.length) return [];
  const put = new Set((t.ship?.items || []).map((x) => x.id));
  return shipPartsOf(t)
    .filter((x) => !shown || x.kind === "pr" || put.has(x.id) || x.posts.some(shown))
    .map((x) => {
      const at = work ? partPlace(t, x) : null;
      const where = at && { machine: at.D.name, owner: ownerOf(at.D)?.username || null, base: at.w.base || "main", ahead: at.w.ahead || 0, behind: at.w.behind || 0, dirty: at.w.dirty || 0, commits: at.w.commits || 0, worked: !!at.w.worked, checked_out: !!at.w.worktree, sha: at.w.sha || null, subject: at.w.subject || "", at: at.w.at || null };
      return { id: x.id, kind: x.kind, ref: x.ref, title: x.title, url: x.url, repo: x.repo, branch: x.branch || null, gh: x.gh || null, landed: !!x.landed, threads: shown ? x.posts.filter(shown) : x.posts, ...(where ? { where } : {}) };
    });
}
// Where a pull request's or a branch's work on a task is (`x`, one of shipPartsOf's): its branch in a folder on a
// machine of someone on the task, as that machine reports its folders' WIP. A thread on it says which machine and
// folder; one put in by hand is looked for on everyone's. { D, f, w } or null.
export function partPlace(t: Task, x) {
  if (!x.branch) return null;
  const on = new Set(peopleOn(t));
  const repoOk = (f) => !x.repo || f.remote === x.repo || f.name === x.repo || String(f.remote || "").endsWith(`/${x.repo}`) || String(x.repo).endsWith(`/${f.name}`);
  const look = (D, s) => {
    for (const f of relay.infoOf(D).folders?.folders || []) {
      const w = (f.wip || []).find((y) => y.branch === x.branch);
      if (!w) continue;
      if (s ? !s.root || s.root === f.root || s.root === w.worktree || s.root.startsWith(f.root + path.sep) : repoOk(f)) return { D, f, w };
    }
    return null;
  };
  for (const id of x.posts || []) {
    const p = postRef(id);
    const hit = p && on.has(ownerOf(p.D)?.id) ? look(p.D, p.s) : null;
    if (hit) return hit;
  }
  for (const D of relay.devices.values()) {
    const hit = on.has(ownerOf(D)?.id) ? look(D, null) : null;
    if (hit) return hit;
  }
  return null;
}
export function taskSeenBy(t: Task, uid: string) {
  const name = (id) => accounts.byId(id)?.username || null;
  const { ranks, ...rest } = t;
  const by = (list) => (list || []).map((e) => (e.user ? { ...e, user: name(e.user) } : e));
  const out = { ...rest, posts: by(t.posts), sent: by(t.sent), mine: t.owner === uid, owner_name: name(t.owner), done_user: t.done_user ? name(t.done_user) : null, people: (t.people || []).map((x) => ({ user: name(x.user), at: x.at })).filter((x) => x.user) };
  if (t.owner === uid) return out;
  const o = { user: accounts.byId(uid) };
  return { ...out, parts: taskParts(t, null, { work: true }), rank: ranks?.[uid] ?? t.rank, workspace: null, agent: null, pages: (t.pages || []).filter((e) => pageSeen(o, e.page)), group: t.group && groupSeen(o, state.groups[t.group]) ? t.group : null };
}
// What the page has of what a task ships (task-ship.ts): what was put in it, how GitHub last had those pull requests
// (one no thread of yours links shows from it), its landing order, and what happened lately.
export const shipView = <T extends { ship?: Task["ship"] }>(t: T) =>
  !t.ship
    ? t
    : {
        ...t,
        ship: {
          items: t.ship.items,
          prs: Object.fromEntries(t.ship.items.filter((x) => x.kind === "pr" && x.url).map((x) => [x.url, Object.entries(t.ship.prs || {}).find(([k]) => k.toLowerCase() === x.url.toLowerCase())?.[1] || null])),
          events: t.ship.events.slice(-60).map(({ files, ...e }) => e),
          order: t.ship.order || null,
          landing: t.ship.landing ? { at: t.ship.landing.at, by: t.ship.landing.by, asked: Object.keys(t.ship.landing.asked || {}) } : null,
        },
      };
function linkSent(list, v) {
  for (const t of list) {
    for (const e of t.sent) {
      if (e.post || linking.has(e.launch)) continue;
      const post = v.sessions.find((s) => s.launch === e.launch)?.id || v.launches.find((l) => l.id === e.launch)?.post;
      if (!post) continue;
      linking.add(e.launch);
      setImmediate(() => {
        linking.delete(e.launch);
        commit({ t: "task.linked", tid: t.id, launch: e.launch, post });
      });
    }
  }
  return list;
}
// Who a page's sign-in is now (its cookie, asked again), once per push however many of its pages are open.
export function signedInNow(req: Req, ctx: PushMemo = {}) {
  const token = cookieToken(req);
  const seen = (ctx.who ||= new Map());
  if (!seen.has(token)) seen.set(token, accounts.sessionUser(token));
  return seen.get(token);
}
// A person's view, made once per push (`ctx`), however many of their pages ask.
export function viewOnce(req: Viewer, ctx: PushMemo = {}): View {
  const views = (ctx.views ||= new Map<string, View>());
  if (!views.has(req.user.id)) views.set(req.user.id, viewForReq(req));
  return views.get(req.user.id);
}
// Contacts' things from other agentbooks that reach a person's feed (./people-things.ts): kept out of the view, which
// agents read.
export const theirFeeds: ((req: Viewer) => TheirCard[])[] = [];
// The feed as a request's person sees it (feed.ts), and what each thing on it shows: a thread's card, with the
// questions it has open; a thread still starting; a page; a contact's from elsewhere. `live(id)`: what a thread is
// doing this moment.
export function feedSeen(req: Viewer, params: ReturnType<typeof feedParams>, ctx: PushMemo = {}) {
  const v = viewOnce(req, ctx);
  const words = searchWords(params.q).slice(0, 10);
  const searches = (ctx.searches ||= new Map());
  const asked = `${req.user.id}\n${words.join(" ")}`;
  if (words.length && !searches.has(asked)) searches.set(asked, feedMessageHits(req, words) ?? searchMessages(words, messagesSeen(req)));
  const f = feedOf(v, params, { messages: words.length ? searches.get(asked) : null, theirs: params.feed ? theirFeeds.flatMap((fn) => fn(req)) : [] });
  const byKey = new Map(f.list.map((it) => [it.key, it]));
  const ws = workspacesOf(v);
  const card = (s: Thread): ThreadCard => ({ ...guestsCard(req, s), workspaces: ws.of(s), names: namesIn(namesNear(v.sessions, s), [s.text, ...(s.updates || []).map((u) => u.text), ...(s.last_messages || []).map((m) => m.text)]), runs: cardRuns(req, s) });
  const open = new Map<string, Question[]>();
  for (const q of v.questions) if (!q.answered) open.set(q.post, [...(open.get(q.post) || []), q]);
  const record = (k: string): FeedQ["records"][string] | null => {
    const it = byKey.get(k);
    if (!it) return null;
    // A thread of a person's own is its card already; what it asks is its guests'.
    if (it.kind === "thread" && it.x.talk) return { ...it.x, questions: (it.x.guests || []).filter((g) => !g.removed).flatMap((g) => open.get(g.id) || []) };
    return it.kind === "thread" ? { ...card(it.x), questions: open.get(it.x.id) || [] } : it.x;
  };
  return { ...f, record, live: (id: string) => v.live[id] ?? null };
}
// What a machine's change was about, for the pages watching it: a thread (with its work, as its machine sent it), or,
// when it doesn't say, everything of the machine.
export function liveHeard(D: Device, op, info) {
  if (!live.size) return;
  if (info) {
    for (const k of info) live.mark(k.startsWith("post:") ? { thread: relay.idOf(D, k.slice(5)) } : { device: D.id });
    for (const k of info) if (k.startsWith("post:")) hostHears(relay.idOf(D, k.slice(5)));
    return;
  }
  if (!op?.post) return live.mark({ device: D.id });
  const thread = relay.idOf(D, op.post);
  hostHears(thread);
  if (op.t === "post.steps") live.mark({ thread, steps: op });
  else if (op.t === "post.changes") live.mark({ thread, changes: op.scope });
  else live.mark({ thread });
}
// A thread on its own page, as a request's person sees it: { p, mine, detail } with every message, or null when
// they may not see it.
export function threadDetail(req: Viewer, id: string) {
  const p = postRef(id);
  const mine = !!p && isOwner(req, p.D);
  if (!p || !seesPost(req, p)) return null;
  const info = relay.infoOf(p.D)[`post:${p.local}`] || {};
  // What it has going between its turns, and the workers its agent started, as its machine last said (relay.view's).
  const s = sessionDetail(p.D.store.state, p.local, { going: () => (relay.online(p.D) && info.going) || null });
  // `pickup`: when its machine next tries to pick up a turn an API error cut off, or "login" (relay.view's).
  const pickup = s.failed && relay.online(p.D) ? info.pickup || null : null;
  // Its loops as its machine says they stand (relay.view's), never the transcript's records the store keeps.
  const follow = mine ? {} : { named: agentPublic(p.agent) && isContact(req, ownerOf(p.D)?.id) };
  const d = detailFor({ ...s, rt: info.rt || null, loops: info.loops || undefined, workers: (relay.online(p.D) && info.workers) || undefined, live: s.state !== "done" ? info.live || null : null, runs: runsSeen(p.D, s.runs, relay.online(p.D) ? info.runs : null), ...(pickup ? { pickup } : {}) }, p.agent, mine, ownerName(p.D), seesWork(req, p), follow);
  const onPage = threadPages()[p.id];
  // Whether its person pinned it (pins are each person's own), as its row in the feed has it, so its Pin button says so.
  const pinnedAt = req.user ? accounts.pins(req.user.id).get(p.id) || null : null;
  const names = namesFor(req, [d]);
  if (names) d.title = titleNamed(d.title, ...names);
  const detail = { ...withGuests(req, p, relay.qualify(p.D, d)), page: onPage && pageSeen(req, onPage) ? onPage : null, machine: p.D.name, offline: !relay.online(p.D), pinned: !!pinnedAt, pinned_at: pinnedAt, waiting: mine ? heldOf(p.D).filter((c) => c.args.post === p.local).map(heldRow) : [], ...(mine ? { people: threadPeopleRows(p.id) } : {}) };
  return { p, mine, detail };
}
// The code blocks of a thread's messages that were run (post.run), each as its latest run went: as its machine kept
// it, or, while it runs, as its machine says now, with what it printed so far. By the page's ids for their messages.
function runsSeen(D: Device, kept: Record<string, CodeRun> | null | undefined, now: Record<string, CodeRun> | null | undefined) {
  const all = { ...(kept || {}), ...(now || {}) };
  return Object.values(all).map(({ mid, ...r }) => ({ ...r, message: relay.idOf(D, mid) }));
}
// Those of a thread's card in the feed: of the code blocks in the messages it shows, so ▶ is there as on its page, and
// what they printed under them. Left out (undefined) for someone who may not see its work, as on its page.
function cardRuns(req: Viewer, s: Pick<Thread, "id" | "last_messages">) {
  const p = postRef(s.id);
  if (!p || !seesWork(req, p)) return undefined;
  const shown = new Set((s.last_messages || []).map((m) => m.id));
  const info = relay.infoOf(p.D)[`post:${p.local}`] || {};
  return runsSeen(p.D, p.s.runs, relay.online(p.D) ? info.runs : null).filter((r) => shown.has(r.message));
}
// The same, as records for the page's API: the thread, its messages, what it's doing this moment, its code blocks'
// runs (null when they may not see them), and whether they may see its work (its steps and changes).
export function threadSeen(req: Viewer, id: string): ThreadSnapshot | null {
  // A thread of a person's own: its conversation, with its guests'.
  if (isTalkId(id)) {
    const tk = talkOf(id);
    if (!talkSeen(req, tk)) return null;
    const { last_messages, ...record } = talkRecord(req, tk);
    return { record: { ...record, questions: talkQuestions(req, tk) }, messages: talkConversation(req, tk), live: null, runs: null, work: false };
  }
  const t = threadDetail(req, id);
  if (!t) return null;
  const { messages, live: now, runs, ...record } = t.detail;
  // The group it's in, when they see that group, as its row in the feed has it (viewForReq): its page's group card.
  const g = state.groups?.[state.group_posts?.[t.p.id]?.group];
  if (g && groupSeen(req, g)) record.group = g.id;
  return { record, messages: messages || [], live: now ?? null, runs: runs || null, work: seesWork(req, t.p) };
}
// What a thread's page shows around it, from the threads its person may see: every thread named around it (names.ts),
// the workspaces it's in, its agent's other latest threads, the thread it was started from and the ones it started
// (a Claude Desktop session that started another), as rows.
export function aroundThread(req: Viewer, record) {
  const v = viewForReq(req);
  const ws = workspacesOf(v);
  const self = v.sessions.find((s) => s.id === record.id) || record;
  const others = record.agent == null ? [] : v.sessions.filter((s) => s.agent === record.agent && s.id !== record.id).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.pinned_at || "").localeCompare(a.pinned_at || "") || b.started.localeCompare(a.started)).slice(0, 5);
  const from = self.started_from ? v.sessions.find((s) => s.id === self.started_from) : null;
  const started = v.sessions.filter((s) => s.started_from === record.id).sort((a, b) => (a.started || "").localeCompare(b.started || ""));
  return { names: Object.fromEntries(namesNear(v.sessions, self)), workspaces: ws.of(self), others: others.map((s) => rowOf(s, ws)), from: from ? rowOf(from, ws) : null, started: started.map((s) => (s.side_at ? { ...rowOf(s, ws), reply: sideReply(s) } : rowOf(s, ws))) };
}
// A side thread's latest reply, for the thread it was sent from: what it shows under what you
// sent, and what Bring back sends that thread. Null until it has said something.
function sideReply(s) {
  const m = (s.last_messages || []).filter((x) => x.from === "agent" && !x.command && !x.file_id && x.text).at(-1);
  return m ? { text: m.text, at: m.at, ...(m.shape?.verdict ? { verdict: m.shape.verdict } : {}) } : null;
}
// Rows of the threads a request's person may see that `test` picks (side.ts's ROW): for a screen that lists threads
// the chrome has no row of (a page's or a group's archived ones).
export function rowsFor(req: Viewer, test, { talks = false } = {}) {
  const v = viewForReq(req);
  const ws = workspacesOf(v);
  return [...v.sessions, ...(talks ? v.talks || [] : [])].filter(test).map((s) => rowOf(s, ws));
}
