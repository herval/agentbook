// Who sees what. Every route, the live stream, files and profiles ask here; nothing else decides.
//
// Public things are their owner's contacts' to see; private ones only their owner's; and either way, the people their
// owner put on them see them too. Following decides only what's in your feed, never what you
// see. `contact` below: whether a viewer is the owner's contact.
//
// - An agent is private (only its owner) or public (its owner's contacts). Agents start private. Each of its posts
//   is private or public. A post with no setting of its own follows its agent; one with its own setting keeps it, so a
//   private agent can have a public post. Others then see the post but not which agent wrote it, and the
//   agent's profile stays a 404.
// - A post's steps, its plan and its agent's files are its work. Whoever sees a post sees its work too (herval,
//   2026-11-02: "Drop it: whoever sees a thread sees its work"); there's no switch for it any more.
// - Steering is the owner's alone: questions and permission
//   prompts, to-dos, Stop, the model, posting. Others never see questions, to-dos or posts still starting.
// - An agent's routines (what it does on a schedule) are how it's set up: only its owner sees them.
// - Pages, groups, tasks, notes, workspaces and worktrees are a person's, and private or public, as visibility.ts says.
// - A page (pages.ts) is private (its owner and its contributors) or public (its owner's contacts too). Only its
//   contributors change it, and only its owner says who they are and who sees it. Others see which agent
//   and which post wrote what only for agents and posts they may see. The people who keep it (its owner and the people
//   among its contributors) see every thread on it that's one of theirs, a private one too, with its work, as for a
//   group or a shared task (main.ts, pageShares).
// - A group (groups.ts) is private (its owner and the people in it) or public (its owner's contacts too). The people
//   its owner put in it see all of it but its tasks, and every thread in it, a private
//   one too, with its work; they edit its brief, leave notes, change its files and add their own threads; the rest is
//   its owner's. A contact sees what a public one is: its name, brief, the members that are agents they see, and its
//   files (never who wrote one they may not see); and the threads in it they may see anyway, being in a public group
//   doesn't make a thread public. Never its notes, what its threads are told, or its tasks.
// - A task is its owner's and the people they put on it. Every thread on it shows to all
//   of them, a private one too, as a public one shows, with its work; they add their own threads, the rest is its
//   owner's, ticking it off too; steering stays with each thread's owner. A public task shows to its owner's contacts
//   by its link, with only the threads on it they'd see anyway. `shared` below: whether a viewer sees a post through a
//   task.
// - A thread's people see it and its work, a private one too, as a task's people do.
// - Something you may not see answers 404, like something that doesn't exist.
// - What others see is listed below, field by field, rather than what they don't: a field added to posts,
//   agents or the page later stays its owner's until it's added to a list here.

import { sizeText } from "../plugin/shared/diff.ts";
import { contributes } from "../plugin/shared/pages.ts";
import { levelOf, storedLevel } from "../plugin/shared/visibility.ts";
import type { FileView, LiveLine } from "../plugin/shared/api.ts";
import type { RuntimeId } from "../plugin/shared/runtimes.ts";
import type { Agent, By, CodeRun, FileRecord, Group, GroupFile, GroupMember, Iso, Launch, Message, Page, PageSnapshot, PageVersion, Question, Session, SessionUpdate, Task, TaskPage, TaskPost, TaskSent, TaskSource, ThreadLife, TurnChanges, Visibility } from "../plugin/shared/types.ts";

// What decides who sees a thing: its level (visibility.ts's, or an agent's "private" or "public").
interface Leveled {
  visibility?: string | null;
}
// Whether a viewer may see an agent, or a thread, by its id.
type Shown = (id: string) => boolean;

// A thread as the page has it (store.ts's publicState): its record, with its title and state in a word, its
// conversation and files (or how many there are), and what its machine says of it now.
export interface PostView extends Partial<Omit<Session, "runs">> {
  id: string;
  own_title?: string | null;
  effective?: string;
  open_questions?: number;
  messages?: Message[] | number;
  last_messages?: Message[];
  files?: FileRecord[] | number;
  last_files?: FileRecord[];
  pictures?: number;
  last_pictures?: FileRecord[];
  life?: ThreadLife | null;
  machine?: string;
  offline?: boolean;
  page?: string | null;
  live?: LiveLine | null;
  // Its code blocks' latest runs: as its store keeps them, or as its page shows them (main.ts's runsSeen).
  runs?: Record<string, CodeRun> | RunSeen[];
}
// A code block's run as a thread's page shows it: by the page's id for its message.
type RunSeen = Omit<CodeRun, "mid"> & { message: string };
// A thread in full, for its own page (store.ts's sessionDetail): its conversation, files and questions are lists.
export interface PostDetail extends PostView {
  messages?: Message[];
  files?: FileRecord[];
  questions?: Question[];
}
// A turn's line as others see it: what it changed in numbers, not which files.
interface UpdateSeen {
  at: Iso;
  text: string;
  link: string | null;
  changes: Partial<Pick<TurnChanges, "turn" | "files" | "add" | "del">>;
}
// A thread as someone other than its owner sees it (postForOthers): the fields of it they may see, and how they see
// it. `agent` is null when they may not know which agent wrote it.
export interface PostSeen extends Partial<Omit<PostView, "agent" | "messages" | "last_messages" | "files" | "last_files" | "last_pictures" | "updates">> {
  id: string;
  // Null when they don't see which agent it's of.
  agent: string | null;
  messages?: Message[] | number;
  last_messages?: Message[];
  files?: FileView[] | number;
  last_files?: FileView[];
  last_pictures?: FileView[];
  updates?: (SessionUpdate | UpdateSeen)[];
  mine: false;
  owner: string;
  public: boolean;
  open_questions: number;
  shared?: true;
}
// How a viewer knows a thread's agent (postForOthers): whether they see its name.
export interface Follow {
  named?: boolean;
}
// An agent as the page has it (store.ts's publicState, with what its machine says of it now: relay.ts's view).
export interface AgentView extends Agent {
  inactive?: boolean;
  machine?: string;
  // The runtime that runs it, as its machine says (shared/runtimes.ts).
  runtime?: RuntimeId;
  offline?: boolean;
  link?: { state: string; since?: Iso | null; error?: string };
}
// How an agent's threads a viewer sees are going (agentForOthers).
interface AgentCounts {
  sessions: number;
  working: number;
  needs: number;
  idle: number;
  done: number;
}

export const agentPublic = (a: Leveled | null | undefined): boolean => storedLevel(a?.visibility) === "public";
export const postLevel = (s: Leveled | null | undefined, agent: Leveled | null | undefined): Visibility => storedLevel(s?.visibility) ?? (agentPublic(agent) ? "public" : "private");
export const postPublic = (s: Leveled | null | undefined, agent: Leveled | null | undefined): boolean => postLevel(s, agent) === "public";
// Whether others see a thread's work (its steps, files and changes): whenever they see it at all. An old thread's
// `show_work` is ignored.
export const workShown = (s: Leveled | null | undefined, agent: Leveled | null | undefined): boolean => postPublic(s, agent);
// Whether a person's thing at `level` (a page, a group, a task, a note, a workspace, a worktree) shows to someone who
// isn't among its people: it's public and they're its owner's contact (`contact`).
export const seenAt = (level: string | null | undefined, contact: boolean): boolean => levelOf(level) === "public" && !!contact;

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K>;
function pick<T extends object, K extends keyof T>(o: T | null | undefined, keys: readonly K[]): Partial<Pick<T, K>>;
function pick<T extends object, K extends keyof T>(o: T | null | undefined, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o?.[k] !== undefined) out[k] = o[k];
  return out;
}

// Of a post: what it is, how it's going, its results and its conversation. Not where it runs on its owner's
// machine or how to reach it there (its folder, transcript, process, session id, launch, link, host), what
// it's doing this moment, or its questions.
const POST: (keyof PostView)[] = ["id", "agent", "label", "title", "own_title", "ai_title", "text", "prompt", "started", "updated", "rev", "state", "effective", "busy", "ended", "end_reason", "asleep", "slept", "sleep_reason", "turn_started", "turn_ended", "archived", "archived_at", "visibility", "show_work", "repo", "branch", "cloud", "model", "stats", "context", "updates", "attachments", "prs", "messages", "last_messages", "machine", "offline", "pinned", "pinned_at", "life"];
// And its work, for whoever sees it: with the code blocks of its messages its owner ran, and what they printed.
const WORK: (keyof PostView)[] = ["plan", "files", "last_files", "pictures", "last_pictures", "runs"];
const MESSAGE = ["id", "post", "from", "via", "text", "file_id", "files", "at", "shape", "user"] as const satisfies readonly (keyof Message)[];
const FILE = ["id", "post", "from", "name", "title", "size", "draft", "at"] as const satisfies readonly (keyof FileRecord)[];
// Of an agent: who it is, what runs it, and how its posts others may see are going. Not its folders, models,
// routines, or why agentbook can't reach it.
const AGENT: (keyof AgentView)[] = ["id", "name", "kind", "runtime", "glyph", "created", "bio", "avatar", "avatar_default", "visibility", "machine", "host", "offline", "inactive"];
// A post as someone other than its owner sees it: by its owner, and by its agent when they know it too. `work`:
// whether they see its work (whoever sees it does). `named`: whether they see its agent (a public one, and they're
// its owner's contact). A thread in full keeps its conversation a list.
export function postForOthers<T extends PostDetail>(s: T, agent: Leveled | null | undefined, ownerName: string, work?: boolean, follow?: Follow): PostSeen & { messages?: Message[]; runs?: T["runs"] };
export function postForOthers(s: PostView, agent: Leveled | null | undefined, ownerName: string, work?: boolean, follow?: Follow): PostSeen;
export function postForOthers(s: PostView, agent: Leveled | null | undefined, ownerName: string, work = workShown(s, agent), { named = agentPublic(agent) }: Follow = {}): PostSeen {
  const out: PostSeen = { ...pick(s, work ? [...POST, ...WORK] : POST), id: s.id, agent: s.agent, mine: false, owner: ownerName, public: postPublic(s, agent), open_questions: 0 };
  // Private, and theirs to see because they're on it, or on a task, group, page or note it's in: it says so.
  if (!out.public) out.shared = true;
  if (!named) out.agent = null;
  // Waiting on its owner (a question, a permission prompt) isn't something others can help with.
  if (out.effective === "needs") out.effective = "waiting";
  // What its owner queued for after its turn (queue-for-later-plan.md) isn't said yet: it's theirs until it goes.
  if (Array.isArray(s.messages)) out.messages = s.messages.filter((m) => !m.queued).map((m) => pick(m, MESSAGE));
  if (Array.isArray(s.last_messages)) out.last_messages = s.last_messages.filter((m) => !m.queued).map((m) => pick(m, MESSAGE));
  if (work) {
    if (Array.isArray(s.files)) out.files = s.files.map((f) => pick(f, FILE));
    if (Array.isArray(s.last_files)) out.last_files = s.last_files.map((f) => pick(f, FILE));
    if (Array.isArray(s.last_pictures)) out.last_pictures = s.last_pictures.map((f) => pick(f, FILE));
  } else {
    out.files = Array.isArray(s.files) ? [] : 0;
    out.last_files = [];
    out.last_pictures = [];
    out.pictures = 0;
    // Its strip, without its pictures: which files it made is work.
    if (out.life) out.life = { ...out.life, marks: (out.life.marks || []).filter((m) => m.k !== "pic") };
    // What a turn changed is a result; which files it changed is work.
    if (Array.isArray(s.updates)) out.updates = s.updates.map((u) => (u.changes ? { at: u.at, text: `Changed ${u.changes.files} file${u.changes.files === 1 ? "" : "s"}${sizeText(u.changes)}`, link: u.link ?? null, changes: pick(u.changes, ["turn", "files", "add", "del"]) } : u));
  }
  return out;
}

// An agent as someone other than its owner sees it (a public one, to its owner's contacts): `counts`, how its posts
// they see are going.
const agentForOthers = (a: AgentView, ownerName: string, counts: AgentCounts) => ({
  ...pick(a, AGENT),
  id: a.id,
  name: a.name,
  // Whether agentbook reaches it, without why not (an address, an error from its gateway).
  ...(a.link ? { link: { state: a.link.state, since: a.link.since || null } } : {}),
  owner: ownerName,
  mine: false,
  ...counts,
});

// Who did something, as a viewer may know it: an agent only when it's public, a post only when they may see it.
export function knownBy(by: By | null | undefined, agentShown: Shown, postShown: Shown): By {
  if (!by || typeof by !== "object") return by;
  const out = { ...by };
  if ("agent" in by) out.agent = by.agent && agentShown(by.agent) ? by.agent : null;
  if ("post" in by) out.post = by.post && postShown(by.post) ? by.post : null;
  return out;
}

// A group as the page has it (groups.ts's groupSummary, or one in full): the record, with its threads and files
// counted and its last file.
export interface GroupView extends Group {
  posts?: number;
  files?: number;
  last_file?: GroupFile | null;
}
// Who looks at a group (groupFor): its owner, a person in it, or someone else, who may be its owner's contact; and which
// agents and threads they may see.
export interface GroupWho {
  owner: boolean;
  ownerName: string;
  person?: boolean;
  contact?: boolean;
  agentShown?: Shown;
  postShown?: Shown;
}
// A group as someone not in it sees it (groupFor): a public one, to its owner's contacts.
export interface GroupPublic extends Partial<Pick<GroupView, "id" | "name" | "emoji" | "brief" | "brief_at" | "visibility" | "created" | "updated" | "files">> {
  id: string;
  owner: string;
  mine: false;
  archived: Iso | null;
  by: By | null;
  brief_by: By | null;
  members: Partial<Pick<GroupMember, "agent" | "user" | "at">>[];
  last_file: ReturnType<typeof groupFileFor> | null;
}
// Of a group, to others: what it is, not its notes or who's told what. Its threads they see, they count themselves.
const GROUP: (keyof GroupView)[] = ["id", "name", "emoji", "brief", "brief_at", "visibility", "created", "updated", "files"];
// Of a version of one of its files: which and when, not where its bytes are kept.
const GROUP_FILE: (keyof GroupFile)[] = ["id", "group", "path", "v", "at", "size", "deleted", "restored"];
export const groupFileFor = (v: GroupFile, agentShown: Shown, postShown: Shown) => ({ ...pick(v, GROUP_FILE), by: knownBy(v.by, agentShown, postShown) });
// A group (in brief, or with its files) as a viewer sees it, or null if they may not: all of it for its owner; for
// a person in it (`person`), all of it too, but who did what only as they may know it and its agents only when
// they see them; what it is for its owner's contacts (`contact`) when it's public and not archived.
export function groupFor<G extends GroupView>(g: G, { owner, ownerName, person = false, contact = false, agentShown = () => false, postShown = () => false }: GroupWho) {
  if (owner) return { ...g, owner: ownerName, mine: true, in: true };
  if (person) {
    return {
      ...g,
      owner: ownerName,
      mine: false,
      in: true,
      by: knownBy(g.by, agentShown, postShown),
      brief_by: knownBy(g.brief_by, agentShown, postShown),
      members: (g.members || []).filter((m) => (m.agent ? agentShown(m.agent) : !!m.user)).map((m) => pick(m, ["agent", "user", "at"])),
      last_file: g.last_file ? groupFileFor(g.last_file, agentShown, postShown) : null,
      wips: (g.wips || []).map((w) => ({ ...w, by: knownBy(w.by, agentShown, postShown) })),
    };
  }
  if (!seenAt(g.visibility, contact) || g.archived) return null;
  const seen: GroupPublic = {
    ...pick(g, GROUP),
    id: g.id,
    owner: ownerName,
    mine: false,
    archived: null,
    by: g.by?.user ? { user: g.by.user } : null,
    brief_by: g.brief_by?.user ? { user: g.brief_by.user } : null,
    members: (g.members || []).filter((m) => (m.agent ? agentShown(m.agent) : !!m.user)).map((m) => pick(m, ["agent", "user", "at"])),
    last_file: g.last_file ? groupFileFor(g.last_file, agentShown, postShown) : null,
  };
  return seen;
}

// Who looks at a task not on it (taskForOthers): its owner's name, the people on it, and what of it they may see.
export interface TaskWho {
  ownerName: string;
  people?: { user: string; at: Iso }[];
  postShown?: Shown;
  pageShown?: Shown;
  groupShown?: Shown;
}
// A task as someone not on it sees it (taskForOthers).
export interface TaskSeen extends Partial<Pick<Task, "id" | "text" | "note" | "done" | "done_at" | "done_by" | "at" | "visibility" | "ship">> {
  mine: false;
  on: false;
  owner_name: string;
  people: { user: string; at: Iso }[];
  rank: number;
  sent: TaskSent[];
  posts: Omit<TaskPost, "user">[];
  from: string | null;
  done_post: string | null;
  source: Partial<TaskSource> | null;
  workspace: string | null;
  agent: string | null;
  pages: TaskPage[];
  group: string | null;
}
// Of a task, to someone not on it (a public one, by its link): what it is, where it stands,
// who's on it and what it ships; not its owner's workspace or agent, the launches it went out as, nor a thread, page or
// group they may not see.
const TASK: (keyof Task)[] = ["id", "text", "note", "done", "done_at", "done_by", "at", "visibility", "ship"];
const SOURCE: (keyof Task["source"])[] = ["kind", "key", "url", "title", "state", "state_type", "team", "closed", "gone"];
export function taskForOthers(t: Task, { ownerName, people = [], postShown = () => false, pageShown = () => false, groupShown = () => false }: TaskWho): TaskSeen {
  return {
    ...pick(t, TASK),
    mine: false,
    on: false,
    owner_name: ownerName,
    people,
    rank: 0,
    sent: [],
    posts: (t.posts || []).filter((e) => postShown(e.post)).map(({ user, ...e }) => e),
    from: t.from && postShown(t.from) ? t.from : null,
    done_post: t.done_post && postShown(t.done_post) ? t.done_post : null,
    source: t.source ? pick(t.source, SOURCE) : null,
    workspace: null,
    agent: null,
    pages: (t.pages || []).filter((e) => pageShown(e.page)),
    group: t.group && groupShown(t.group) ? t.group : null,
    // Its History names a thread it asked to land one only when they see that thread.
    ...(t.ship ? { ship: { ...t.ship, events: (t.ship.events || []).map(({ post, ...e }) => (post && postShown(post) ? { ...e, post } : e)) } } : {}),
  };
}

// A page as the page has it (pages.ts's pageSummary, or pageDetail in full): the record, with its versions, the
// threads that wrote it and its routines (their prompt and root only for its owner).
export interface PageView extends Page {
  history?: Omit<PageVersion, "snapshot">[];
  posts?: { post: string; agent: string }[];
  snapshot?: PageSnapshot;
  routines?: { id?: string; name?: string; kind?: string; schedule?: string; prompt?: string; root?: string | null; runs_as?: string | null; model?: string | null }[];
}
// A page as a viewer sees it (pageFor): whose, and whether it's theirs and they may change it.
export interface PageSeen extends PageView {
  owner: string;
  mine: boolean;
  can_edit: boolean;
}
// A page as a viewer sees it (`viewer`: their username), or null if they may not. Its owner may do anything;
// a contributor may change it; its owner's contacts (`contact`) may look, if it's public. `postShown`: whether they
// may see a post, by its id, to say which post wrote what.
export function pageFor(p: PageView, agents: Map<string, Leveled>, owner: boolean, ownerName: string, viewer: string | null, postShown: Shown = () => false, contact = false): PageSeen | null {
  if (owner) return { ...p, owner: ownerName, mine: true, can_edit: true };
  const editor = contributes(p, { user: viewer });
  if (!editor && (!seenAt(p.visibility, contact) || p.archived)) return null;
  const agentShown = (id: string) => contact && agentPublic(agents.get(id));
  const known = (by: By) => {
    if (!by || typeof by !== "object") return by;
    const out = { ...by };
    if ("agent" in by) out.agent = by.agent && agentShown(by.agent) ? by.agent : null;
    if ("post" in by) out.post = by.post && postShown(by.post) ? by.post : null;
    return out;
  };
  const out: PageSeen = { ...p, owner: ownerName, mine: false, can_edit: editor, by: known(p.by), contributors: (p.contributors || []).map((c) => (c.agent && !agentShown(c.agent) ? { ...c, agent: null } : c)) };
  out.widgets = (p.widgets || []).map((w) => ({ ...w, by: known(w.by) }));
  if (p.last) out.last = { ...p.last, by: known(p.last.by) };
  if (p.recent) out.recent = p.recent.map((r) => ({ ...r, by: known(r.by) }));
  if (p.history) out.history = p.history.map((v) => ({ ...v, by: known(v.by) }));
  if (p.posts) out.posts = p.posts.filter((x) => postShown(x.post)).map((x) => ({ ...x, agent: agentShown(x.agent) ? x.agent : null }));
  if (p.snapshot) out.snapshot = { ...p.snapshot, widgets: p.snapshot.widgets.map((w) => ({ ...w, by: known(w.by) })) };
  // A routine's prompt is its owner's instructions and its root is a path on their machine; others see the page's
  // routines (it may be public) but not those. (The owner branch above returns them whole.)
  if (p.routines) out.routines = p.routines.map(({ prompt, root, runs_as, model, ...r }) => r);
  return out;
}

// One machine's view of the page (relay.ts's view): its store in summary (store.ts's publicState), with what the
// machine knows now.
export interface MachineView {
  seq: number;
  machine?: string;
  agents: AgentView[];
  sessions: PostView[];
  pages?: PageView[];
  questions?: Question[];
  launches?: Launch[];
  live?: Record<string, LiveLine | null>;
}
// One machine's view as someone other than its owner sees it (viewFor): never its folders or what it's cloning.
export interface MachineSeen {
  seq: number;
  machine?: string;
  agents: ReturnType<typeof agentForOthers>[];
  sessions: (PostSeen & { page: string | null })[];
  pages: PageSeen[];
  questions: Question[];
  launches: (Partial<Launch> & Pick<Launch, "id">)[];
  folders: never[];
  cloning: never[];
  live: Record<string, LiveLine | null>;
}
// One machine's view of the page, as a viewer sees it: all of it for its owner, for others what they may see, built
// from nothing but that. `viewer`: their username, for the pages they contribute to. `shared`: for a post's id (this
// machine's), whether the viewer sees it because they're on it, or on a task, group, page or note it's in
// (undefined: they don't; false: not its work; true: its work too). `contact`: whether they're its owner's contact,
// who sees what's public.
// One machine's view as its owner sees it: all of it, each agent and thread marked theirs.
export type MachineOwn<V extends MachineView> = Omit<V, "agents" | "sessions" | "pages"> & {
  agents: (V["agents"][number] & { owner: string; mine: true; visibility: Visibility })[];
  sessions: (V["sessions"][number] & { mine: true; public: boolean })[];
  pages: PageSeen[];
};
export function viewFor<V extends MachineView>(view: V, owner: boolean, ownerName: string, viewer: string | null = null, shared: (id: string) => boolean | undefined = () => undefined, contact = false): MachineOwn<V> | MachineSeen {
  const byId = new Map(view.agents.map((a) => [a.id, a]));
  const raw = new Map(view.sessions.map((s) => [s.id, s]));
  const seen = (s: PostView) => (contact && postPublic(s, byId.get(s.agent))) || shared(s.id) !== undefined;
  const postShown = (id: string) => raw.has(id) && seen(raw.get(id));
  const pages = (view.pages || []).map((p) => pageFor(p, byId, owner, ownerName, viewer, postShown, contact)).filter(Boolean);
  if (owner) {
    const own: MachineOwn<V> = {
      ...view,
      agents: view.agents.map((a) => ({ ...a, owner: ownerName, mine: true as const, visibility: a.visibility || "private" })),
      sessions: view.sessions.map((s) => ({ ...s, mine: true as const, public: postPublic(s, byId.get(s.agent)) })),
      pages,
    };
    return own;
  }
  // The page a post was started from, or made, when they may see that page too.
  const pageShown = new Set(pages.map((p) => p.id));
  const work = new Set(view.sessions.filter((s) => (contact && workShown(s, byId.get(s.agent))) || shared(s.id) === true).map((s) => s.id));
  const named = (id: string) => contact && agentPublic(byId.get(id));
  const sessions = view.sessions.filter(seen).map((s) => ({ ...postForOthers(s, byId.get(s.agent), ownerName, work.has(s.id), { named: named(s.agent) }), page: pageShown.has(s.page) ? s.page : null }));
  const count = (a: AgentView, e: string) => sessions.filter((s) => s.agent === a.id && s.effective === e && !s.archived).length;
  const agents = view.agents.filter((a) => named(a.id)).map((a) => agentForOthers(a, ownerName, { sessions: sessions.filter((s) => s.agent === a.id).length, working: count(a, "working"), needs: 0, idle: count(a, "idle") + count(a, "waiting"), done: count(a, "done") }));
  const others: MachineSeen = {
    seq: view.seq,
    machine: view.machine,
    agents,
    sessions,
    pages,
    questions: [],
    launches: [],
    folders: [],
    cloning: [],
    live: Object.fromEntries(Object.entries(view.live || {}).filter(([id]) => work.has(id))),
  };
  return others;
}

// A post in full (its page), as a viewer sees it. `work`: whether they see its work, and `follow`, whether they know
// its agent (postForOthers).
export function detailFor<T extends PostDetail>(detail: T, agent: Leveled | null | undefined, owner: boolean, ownerName: string, work = workShown(detail, agent), follow: Follow = {}) {
  if (owner) return { ...detail, mine: true, public: postPublic(detail, agent) };
  return { ...postForOthers(detail, agent, ownerName, work, follow), questions: [], files: work ? (detail.files || []).map((f) => pick(f, FILE)) : [], live: work ? detail.live : null };
}

// A file listed for someone other than its owner (on an agent's profile): what it is, not where it's kept.
export const fileForOthers = (f: FileRecord) => pick(f, FILE);
