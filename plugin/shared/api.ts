// JSON contracts and query URLs shared by agentbook-server and its browser. No server or DOM imports.
// Browser state belongs in web/lib/types.ts; stored records belong in shared/types.ts.
import type { Agent, By, CodeRun, FileRecord, Group, GroupFile, GroupMember, ImageBuild, Launch, MachineCloud, Message as StoredMessage, Note, Page, PlanItem, PrChecks, Question, Routine, RoutineLast, RoutineLink, RoutineReach, RoutineSchedule, Session, SessionUpdate, Task, ThreadLife, TurnChanges, Visibility, Workspace } from "./types.ts";
import type { RuntimeId } from "./runtimes.ts";
import type { Term } from "./search.ts";

// What the server answers a POST with (post), whatever the route: why not, what it made, and how something sent to a
// machine went (it went in; it waits for the machine, `waiting`, which is `offline`; it resumed or nudged the thread).
export interface Said {
  error?: string;
  id?: string;
  mid?: string;
  lid?: string;
  // A direct queue flag, or the command id while its machine is offline.
  queued?: boolean | string;
  waiting?: string;
  offline?: boolean;
  went?: boolean;
  resumed?: boolean;
  nudged?: boolean;
  stuck?: string;
  // No passkey signed it.
  passkey?: boolean;
  // What a machine of yours that keeps your passkeys takes only signed (428): what to sign, the passkeys it takes,
  // and for how many hours a browser's key may sign for it (signCommand).
  sign?: { machine?: string };
  keys?: string[];
  session?: number;
}

// A POST's answer; one that never went out (no agent to start it, say) has no data.
export interface Reply<T = Said> {
  ok: boolean;
  data?: T;
}

// A thread as the page reads it: its record, with what the server works out for the page (server/feed.ts,
// server/side.ts): how it's going (`effective`), whose it is, its workspaces, its latest messages and files. A row
// (sideRows, moreRows) has only some of these.
export type Thread = Partial<Omit<Session, "runs" | "loops" | "state" | "updates">> & {
  id: string;
  state?: Session["state"] | "running";
  updates?: (Omit<SessionUpdate, "changes"> & { changes?: Partial<TurnChanges> })[];
  names?: Record<string, NameRef>;
  questions?: (Question & { at?: string })[];
  effective?: string;
  own_title?: string | null;
  owner_name?: string | null;
  open_questions?: number;
  mine?: boolean;
  public?: boolean;
  shared?: true;
  machine?: string;
  offline?: boolean;
  page?: string | null;
  // A talk's (a thread of your own): its workspace, the agents in it, and its first message.
  workspace?: string | null;
  workspaces?: string[];
  guest_of?: GuestOf | string | null;
  guests?: Thread[];
  talk?: boolean;
  messages?: Message[] | number;
  last_messages?: Message[];
  files?: FileView[] | number;
  last_files?: FileView[];
  pictures?: number;
  last_pictures?: FileView[];
  life?: ThreadLife | null;
  live?: LiveLine | null;
  runs?: RunSeen[] | Record<string, CodeRun> | null;
  loops?: (Session["loops"][number] & { live?: boolean })[];
  // How it runs, as its machine says (relay.view's): a driver, in the background, in a vendor's cloud.
  rt?: ThreadRuntime | null;
  // Its subagents still going, the commands of yours that wait for its machine, and its messages queued for its turn.
  workers?: Worker[];
  waiting?: Held[];
  queue?: Message[];
  // When its machine next picks up a turn an API error cut off.
  pickup?: string | null;
  // A side thread's latest reply, for the thread it was sent from.
  reply?: { text: string; at: string; verdict?: { line?: string } | null } | null;
  // What it left running after its turn, and hears back from when that ends.
  going?: Going[];
  // The routine it's a run of (routines.ts), by its id and name.
  routine?: { id: string; name: string } | null;
  // The people its owner put on it, on its owner's page.
  people?: { user: string; display_name: string; at: string }[];
};

// Something a thread left running after its turn (a subagent, a shell watching CI, a monitor).
export interface Going {
  id: string;
  kind: string;
  title?: string;
  started?: string;
  worker?: string;
  // Its machine can read what it printed.
  out?: boolean;
}

// The thread one is a guest in: a talk's (`talk`) or a thread's, and when it left (`removed`).
export interface GuestOf {
  id: string;
  talk?: boolean;
  by?: string | null;
  label: string | null;
  agent: string | null;
  title: string | null;
  removed: string | null;
}

// A code block's run, as a thread's page shows it: by the page's id for its message.
export type RunSeen = Omit<CodeRun, "mid"> & { message: string };

// How a thread runs, as its machine says: a runtime's that drives it (`name`, its resume command; which one is its
// proc's, shared/runtimes.ts's drivenRuntime), Claude Code's in the background or a terminal (`kind`), or in a
// cloud (`kind` "cloud", with the commands that bring its work here; which cloud is where it runs, `cloud`).
export interface ThreadRuntime {
  state?: string;
  kind?: string;
  id?: string;
  name?: string;
  url?: string;
  resume?: string;
  apply?: string;
  teleport?: string;
  remote?: string;
  models?: unknown;
  syncing?: boolean;
  blocked?: boolean;
  why?: string;
}

// A subagent of a thread's, still going: what it's doing, and how many steps it's taken.
export interface Worker {
  id: string;
  title: string;
  kind?: string;
  started?: string;
  ended?: string | null;
  state?: string;
  step?: Step | null;
  n?: number;
  error?: string | null;
}

// A command of yours that waits for a thread's machine: what it is, and when it went.
export interface Held {
  cid: string;
  kind: string;
  at: string;
  text: string | null;
  post?: string | null;
}

// Records the server sends by `type:id` (q/feed, q/thread, q/threads): threads, pages' updates, threads still
// starting, messages.
export interface Records {
  [key: `thread:${string}`]: ThreadCard;
  [key: `page:${string}`]: PageRow;
  [key: `launch:${string}`]: LaunchRow;
  [key: `message:${string}`]: Message;
  [key: `their:${string}`]: TheirCard;
  [key: string]: ThreadCard | PageRow | LaunchRow | Message | TheirCard;
}
// A thread or page a contact on another agentbook published to you, on your feed (server/api/people-things.ts's
// theirFeed), as their door sent it: read only, opened on their profile (`rid`, its id on their page).
export interface TheirCard {
  id: string;
  rid: string;
  type: "thread" | "page";
  username: string;
  name: string | null;
  title: string | null;
  text: string | null;
  state?: string | null;
  busy?: boolean;
  agent?: { name: string | null; emoji: string | null } | null;
  last?: { from: string | null; text: string; at: string | null } | null;
  messages?: number;
  emoji?: string | null;
  version?: number | null;
  started?: string | null;
  updated?: string | null;
}

// What a thread is doing now, as its live line shows it: its latest step, how many, and its plan.
export interface LiveLine {
  step?: Step | null;
  steps?: number;
  plan?: PlanItem[] | null;
  // Its latest turn's: how many tools it used, and when it started.
  turn_steps?: number;
  turn_start?: string | null;
}

// A thread its words may name, by its label (server/names.ts): its id, agent, label and title.
export interface NameRef {
  id: string;
  agent: string | null;
  label: string;
  title: string;
}

// A thread on its own page, as q/thread sends it: its record and its latest messages (`older`, the first of those that
// has more before it), and what's around it: the names its words may use, its workspaces, its agent's other threads,
// and the thread it was started from and the ones it started.
export interface ThreadQ {
  records: ThreadRecords;
  thread: `thread:${string}`;
  messages: `message:${string}`[];
  older: string | null;
  earlier: number;
  live?: LiveLine | null;
  runs?: RunSeen[] | null;
  work?: boolean;
  watching: number | false;
  names?: Record<string, NameRef>;
  workspaces?: string[];
  others?: Thread[];
  from?: Thread | null;
  started?: Thread[];
}

// q/thread's records: the thread, with its files, and its messages.
export interface ThreadRecords {
  [key: `thread:${string}`]: Omit<Thread, "files" | "runs"> & { files?: FileView[] };
  [key: `message:${string}`]: Message;
}

// The chrome, as q/side sends it (server/side.ts): its records by `type:id`, each kind's keys in order, and what
// isn't a record; and the stream's version of it.
export interface SideQ {
  records: Record<string, SideRecord>;
  order: Record<string, string[]>;
  data: SideData;
  watching: number | false;
}

export type SideRecord = AgentRow | PageRow | NoteRow | GroupRow | MachineRow | WorkspaceRow | TaskRow | RoutineRow | ConnectorRow | Question | LaunchRow | FolderRow | Thread;

// The feed, as q/feed sends it: its cards' keys in order, their records, the live lines of its threads, and what its
// search found.
export interface FeedQ {
  records: Records;
  list: string[];
  next: string | null;
  live: Record<string, LiveLine>;
  counts: FeedCounts;
  menus: FeedMenus;
  found: { terms: Term[]; posts: Record<string, { exact: string[]; typo: string[]; hit: Pick<Message, "id" | "from" | "text"> | null }> } | null;
  watching: number | false;
}

// How many the feed has: in each status, and threads and pages in all.
export interface FeedCounts {
  states: Record<string, number>;
  threads: number;
  pages: number;
}

// One of a thread's steps (plugin/cli/drivers/steps.ts's): something it said ("say"), or a tool it used, in turn
// `turn`. A tool's `done`: when it ended; `error`: why it failed; `images`: how many pictures its result held.
export interface Step {
  id: string;
  kind: string;
  turn?: number;
  at?: string | null;
  tool?: string;
  title?: string;
  text?: string;
  done?: string | null;
  error?: string | null;
  images?: number;
  files?: { path: string; kind: string; add: number; del: number }[];
}

// A routine as the page lists it (plugin/shared/routines.ts's routineSummary): its record, how it runs in words, an
// agent routine's prompt and who runs it, the version waiting for your OK, and how its last run went.
export type RoutineRow = Pick<Routine, "id" | "kind" | "name" | "about" | "on" | "page" | "keeps" | "live_v" | "code_v" | "last_ok" | "fails" | "agent" | "by" | "created"> & {
  archived: { at: string; by: By | null } | null;
  every: RoutineSchedule;
  when: string;
  links: RoutineLink[];
  thread: string | null;
  reach: RoutineReach | null;
  runs_as?: string | null;
  root?: string | null;
  model?: string | null;
  prompt?: string;
  waiting: { v: number; at: string; summary: string; by: By | null } | null;
  last: (RoutineLast & { post: string | null }) | null;
  failing_since: string | null;
  stale: unknown;
  fix: { lid: string; agent: string | null; at: string; post: string | null } | null;
  next: string | null;
  running: boolean;
  threads?: [string, string][];
};

// S.data: the chrome (q/side, buildSide): each kind of record but threads, as a list in the server's order, and what
// isn't a record (server/side.ts's sideOf). Each kind is there once the chrome has it.
export interface PageData {
  agents?: AgentRow[];
  pages?: PageRow[];
  notes?: NoteRow[];
  groups?: GroupRow[];
  machines?: MachineRow[];
  workspaces?: WorkspaceRow[];
  // The tasks on Tasks, and the to-dos threads keep (`scope`), on them.
  tasks?: TaskRow[];
  todos?: TaskRow[];
  routines?: RoutineRow[];
  connectors?: ConnectorRow[];
  questions?: (Question & { at?: string })[];
  launches?: LaunchRow[];
  folders?: FolderRow[];
  // The machine agentbook-server runs on, by name, and its home folder.
  machine?: string;
  home?: string;
  github?: "connector" | null;
  preview?: string | null;
  ws_running?: number;
  cloning?: CloneRow[];
  // What's new on your bell.
  added?: Added[];
  // The page code the server hands out now.
  ui?: string | null;
  // The lines of Needs you you dismissed: key -> when what you dismissed happened.
  dismissed?: Record<string, string>;
  images?: ImageSummary[];
  boxes?: BoxRow[];
}

// An agent, with what the chrome counts of its threads (server/side.ts) and where it runs.
export type AgentRow = Agent & {
  // Deactivated agents remain visible on their profiles, but cannot start threads.
  inactive?: boolean;
  mine?: boolean;
  owner?: string | null;
  machine?: string;
  offline?: boolean;
  machine_off?: boolean;
  working?: number;
  ended?: number;
  used?: string;
  syncing?: boolean;
  latest?: string | null;
  thread_repos?: string[];
  thread_models?: string[];
  thread_files?: number;
  public_threads?: number;
  // What it does on a schedule, in brief (its machine's routinesOf): how many, the next, and the ones failing.
  routines?: AgentRoutines | null;
  // Its own folder, an OpenClaw agent's: when it last did something there.
  workspace?: { at: string | null } | null;
  // Which of its machine's runtimes runs it (shared/runtimes.ts), the machine it runs on (OpenClaw's gateway's), and
  // whether agentbook reaches it there.
  runtime?: RuntimeId;
  host?: string | null;
  link?: { state: string; since?: string } | null;
  // The models its machine says it can run, the one it runs by default, and the efforts they take.
  models?: AgentModels;
  // It works on a repo it clones where it runs (Claude Agent, Devin), not in a folder.
  repos?: boolean;
  folders?: boolean;
  sessions?: number;
};

export interface AgentRoutines {
  n: number;
  paused?: number;
  failing?: number;
  failed?: { id: string; name: string; at: string | null; error: string | null; times: number }[];
  running?: number;
  next?: string | null;
  last?: string | null;
}

export interface AgentModels {
  list?: { id: string; name: string; efforts?: string[]; effort?: string }[];
  default?: string;
  efforts?: string[];
  effort?: string;
}
// The effort levels a model takes, and its default: its own when it lists them (Codex's, none for one that takes
// none), else the agent's, for a runtime whose level is the session's whatever the model (Antigravity's).
export function effortsOf(m: AgentModels | null | undefined, id: string | null | undefined): { efforts: string[]; effort: string | null } {
  const mod = m?.list?.find((x) => x.id === id);
  const own = Array.isArray(mod?.efforts);
  return { efforts: (own ? mod.efforts : m?.efforts) || [], effort: (own ? mod.effort : m?.effort) || null };
}

// A page, with whether it's yours, you follow it or may change it, and its owner's machine (a dashboard's).
export type PageRow = Page & { mine?: boolean; owner?: string | null; followed?: boolean; can_edit?: boolean; machine?: string; face?: unknown; posts?: { post: string }[] };

// A note in brief (the server's noteSummary): how it starts, its words, its open comments and suggestions counted, the
// threads it's tied to, and who's on it.
export type NoteRow = Omit<Note, "text" | "comments" | "suggestions" | "people"> & {
  mine?: boolean;
  can_edit?: boolean;
  owner_name?: string;
  people?: { user: string; at: string; from?: string }[];
  start?: string;
  words?: number;
  comments?: number;
  suggestions?: number;
  threads?: string[];
  linked?: string[];
};

// A group, with its threads, files and notes counted (groupSummary).
export type GroupRow = Partial<Omit<Group, "members">> & { id: string; members?: Partial<GroupMember>[] } & { mine?: boolean; posts?: number; files?: number; last_file?: GroupFile | null; notes?: number };

// A task, with its owner's username, and the parts of it that are WIPs when it ships more than one.
export type TaskRow = Task & { mine?: boolean; on?: boolean; owner_name?: string; parts?: SharedPart[] };

// A pull request or a branch of a task or a workspace shared with you, as its owner's page has it (sharedWips): the
// threads on it, and how its branch stands on the machine that has it (`where`).
export interface SharedPart {
  id: string;
  kind: string;
  repo?: string;
  url?: string;
  ref?: string;
  title?: string;
  branch?: string;
  landed?: boolean;
  visibility?: Visibility | null;
  threads?: string[];
  where?: { owner?: string; machine: string; dirty?: number; sha?: string; ahead?: number; behind?: number; base?: string; at?: string; subject?: string; commits?: unknown[]; worked?: unknown } | null;
  gh?: { number?: number; title?: string; head?: string; base?: string; closed?: string | null; created?: string } | null;
}

// A thread still starting, with the command that waits for its machine.
export type LaunchRow = Partial<Launch> & Pick<Launch, "id"> & { post?: string | null; waiting?: string | null };

// A machine of the person's, or one shared with them.
// `here`: the machine agentbook-server runs on. Yours: what waits for it, and whether it signs.
export interface MachineRow {
  name: string;
  here?: boolean;
  mine?: boolean;
  online?: boolean;
  seen?: string | null;
  kind?: string;
  home?: string;
  clone_dir?: string;
  cli?: string | null;
  os?: string | null;
  update?: { mode?: string; state?: string; to?: string; at?: string; error?: string; why?: string; checked?: { at: string; error?: string } } | null;
  waiting?: number;
  signs?: boolean;
  cloud?: CloudView | null;
  people?: number;
  running?: number;
  // Its agents' past (shared/history.ts): waiting for its person to pick how much comes in, coming in, came in
  // within the last day (the welcome card says so until dismissed), or picked.
  history?: "pending" | "importing" | "imported" | "picked";
}

// A workspace, with its threads running and when it was last used.
export type WorkspaceRow = Workspace & { mine?: boolean; live?: number; used?: string; pulls?: WorkspacePulls | null };

// A workspace's pull requests on GitHub, as the server last read them: as whom, the open ones and lately closed, and
// why it couldn't, with where to fix that.
export interface WorkspacePulls {
  login: string | null;
  pulls: GhPull[];
  heads?: number[];
  error?: string | null;
  fix?: { text?: string; url: string; label: string } | null;
}

// A pull request as a workspace lists it (server/integrations/pulls.ts's, with the threads that linked it, and the
// ones on its branch).
export interface GhPull {
  number: number;
  title: string;
  url: string;
  state?: string;
  head: string;
  base: string;
  sha?: string;
  updated?: string;
  closed?: string | null;
  checks?: PrChecks | null;
  linked?: string[];
  on_branch?: string[];
}

// A connector set up (Connectors): its kind and name, how it signed in (`via`), and whether it's off.
export interface ConnectorRow {
  id: string;
  kind: string;
  name?: string;
  via?: string;
  off?: boolean;
  settings?: Record<string, string>;
  states?: string[];
  close?: boolean;
  teams?: unknown;
  // Its last sync: going now, when it ended, what went wrong, and how many it brought in.
  syncing?: boolean;
  synced?: string | null;
  error?: string | null;
  count?: number;
  // Whose it is, the environment variable its key is read from, and whether its settings are fixed.
  who?: string | null;
  key_env?: string | null;
  locked?: boolean;
  // A data source's: the calls it makes, what it lacks to work, and the workspace and agent it's for.
  calls?: number;
  lacks?: string[] | string | null;
  workspace?: string | null;
  agent?: string | null;
}

// A folder a machine has threads in, or a checkout beside them (the composer's Where): its repo, its branch, and its
// branches and WIP when threads ran there.
export interface FolderRow {
  machine: string;
  root: string;
  name?: string;
  sessions?: number;
  live?: number;
  last?: string;
  remote?: string;
  url?: string;
  branch?: string | null;
  branches?: { name: string; at?: string }[];
  wip?: FolderWip[] | null;
  tab?: string;
}

// A branch of a folder's, as its machine lists it (cli/wip.ts): its threads, and how far it is from its base.
export interface FolderWip {
  id?: string;
  branch: string;
  posts?: string[];
  at?: string;
  subject?: string;
  ahead?: number;
  dirty?: number;
}

// GitHub, connected: who as.
export interface GithubInfo {
  user?: string;
}

// A repo being cloned for a workspace, on a machine.
export interface CloneRow {
  repo: string;
  machine?: string;
}

// How you and someone stand: contacts since `since`, or one asking the other (`asked`: you
// asked them, when; `asks_you`: they asked you, with `note`), and whether their public things are in your feed.
export interface ContactState {
  contact: boolean;
  since: string | null;
  asked: string | null;
  asks_you: string | null;
  note: string | null;
  following: boolean;
}
// Whether an agent of a contact's is in your feed (`on`), and whether that's its own setting (`set`) or your follow of
// its owner's; `contact`: whether its owner is your contact at all.
export interface AgentFollowState {
  on: boolean;
  set: "on" | "off" | null;
  contact: boolean;
}
// Your contacts and the asks waiting (GET /api/contacts): theirs to you, with what they said, and yours.
export interface ContactPerson {
  user: string;
  display_name: string;
  disabled?: boolean;
  remote?: unknown;
}
export interface ContactsList {
  contacts: (ContactPerson & { since: string | null; following: boolean })[];
  asks: (ContactPerson & { at: string | null; yours: boolean; note: string | null })[];
}

// Something new on your bell: someone put you on something, asked to be your contact, or said yes.
export interface Added {
  kind: string;
  id?: string;
  by?: string;
  at?: string;
  seen?: boolean;
}

// A shared machine (Box), as its seat sees it.
export interface BoxRow {
  id: string;
  machine: string;
  owner?: string;
  seat: string;
  seated?: boolean;
  state: string;
}

// An image, as the page's state has it (server/images.ts's summary): `built` is its newest built version.
export interface ImageSummary {
  id: string;
  name: string;
  connector: string | null;
  v: number;
  updated: string;
  built: number | null;
  state: ImageBuild["state"] | null;
  step: string | null;
}

// A machine's cloud sandbox, as the server shows it (server/api/views.ts's cloudView): how waking it goes, what agentbook
// made it from, and on someone else's shared machine, whose it is.
export interface CloudView extends Pick<MachineCloud, "made" | "image" | "v" | "size" | "secrets" | "setting" | "setup_error" | "updating" | "gone" | "login"> {
  kind: string;
  sandbox: string;
  connector: string | null;
  waking: boolean;
  error: string | null;
  sleep?: { busy: boolean; until: string | null; error: string | null; capped?: number };
  shared?: { machine: string | null; owner: string | null };
}

// Menu counts are shared by the initial feed and subsequent feed events.
export interface FeedMenus {
  ctx: Record<string, number>;
  [menu: string]: Record<string, number>;
}

// A lookup of several threads uses the same records as the feed.
export interface ThreadsQ {
  records: Record<`thread:${string}`, Thread>;
}

// One full-text search hit returned by /api/q/search.
export interface SearchHit {
  kind: "message" | "thread" | "note" | "page" | "task" | "group";
  id: string;
  itemId?: string;
  title: string;
  subtitle?: string;
  agent?: string | null;
  emoji?: string | null;
  role?: "user" | "agent";
  archived?: boolean;
  at: string;
  snippet: string;
  score: number;
  href: string;
}

export interface SearchQ {
  query: string;
  indexing: boolean;
  hits: SearchHit[];
}

// Query parameters are as sent on the URL; the server still applies its bounds and defaults.
export interface QueryContracts {
  "/api/q/thread/:id": {
    params: { id: string };
    query: { live?: string; n?: number; before?: string; around?: string };
    response: ThreadQ;
  };
  "/api/q/side": {
    params: {};
    query: { live?: string };
    response: SideQ;
  };
  "/api/q/threads": {
    params: {};
    query: { ids: string };
    response: ThreadsQ;
  };
  "/api/q/feed": {
    params: {};
    query: { live?: string; filter?: string; agent?: string; workspace?: string; page?: string; group?: string; feed?: string; q?: string; n?: number; after?: string };
    response: FeedQ;
  };
  "/api/q/search": {
    params: {};
    query: { q: string; limit?: number; kind?: string };
    response: SearchQ;
  };
}
export type QueryPath = keyof QueryContracts;
export type QueryInput<P extends QueryPath> = QueryContracts[P]["params"] & QueryContracts[P]["query"];
export type QueryResponse<P extends QueryPath> = QueryContracts[P]["response"];

// A page leaving a screen drops only the watch it was showing (v), not a newer one.
export interface LiveWatchRequest {
  live?: string;
  drop?: "open" | "feed";
  v?: number;
}

// A file's public fields are present even when policy removes its local storage details.
export type FileView = Pick<FileRecord, "id" | "post" | "from" | "name" | "title" | "size" | "draft" | "at"> & Partial<FileRecord>;

// Feed cards carry runs qualified by message id; a raw thread listing can still contain the stored map.
export type ThreadCard = Omit<Thread, "runs"> & { runs?: RunSeen[] | null };

// Path values and query values are encoded separately, including scopes and pagination cursors.
export function queryUrl<P extends QueryPath>(path: P, input: QueryInput<P>): string {
  const params = new URLSearchParams();
  const pathKeys = new Set<string>();
  const url = path.replace(/:(\w+)/g, (_, key: string) => {
    pathKeys.add(key);
    return encodeURIComponent(input[key]);
  });
  for (const [key, value] of Object.entries(input)) if (value != null && !pathKeys.has(key)) params.set(key, String(value));
  return url + (params.size ? `?${params}` : "");
}

// Metadata beside the sidebar's ordered records; lists are assembled by the browser from those records.
export type SideData = Pick<PageData, "machine" | "github" | "preview" | "ws_running" | "cloning" | "added" | "ui" | "dismissed" | "images" | "boxes">;

// Talks omit file_id, and messages shown through a guest identify their source thread.
export type Message = Omit<StoredMessage, "file_id"> & { file_id?: string | null; guest?: string; agent?: string; to?: string[] };

// A thread's content before the query splits its record, messages, live line and runs.
export type ThreadPayload = Omit<Thread, "messages" | "files" | "runs"> & {
  messages?: Message[];
  files?: FileView[];
  questions?: (Question & { at?: string })[];
  runs?: RunSeen[] | null;
};

// The server's staged thread response, before q/thread indexes and paginates its messages.
export interface ThreadSnapshot {
  record: ThreadRecords[`thread:${string}`];
  messages: Message[];
  live: LiveLine | null;
  runs: RunSeen[] | null;
  work: boolean;
}

// Decode the filter bar's URL into the feed contract, rather than forwarding arbitrary string keys.
export function feedQuery(search: URLSearchParams): QueryInput<"/api/q/feed"> {
  const count = search.get("n");
  return {
    filter: search.get("filter") ?? undefined,
    agent: search.get("agent") ?? undefined,
    workspace: search.get("workspace") ?? undefined,
    page: search.get("page") ?? undefined,
    group: search.get("group") ?? undefined,
    feed: search.get("feed") ?? undefined,
    q: search.get("q") ?? undefined,
    live: search.get("live") ?? undefined,
    after: search.get("after") ?? undefined,
    n: count == null ? undefined : Number(count),
  };
}
