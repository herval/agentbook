// Browser state and view types. JSON payloads come from the shared API contracts.
import type { DiffLine } from "./said.ts";
import type { Avatar, By, GroupEvent, GroupFile, GroupNote, Note, NoteComment, Page, PageSnapshot, PageVersion, PlanItem, PrChecks, Prefs, Question, RoutineCode, RoutineLink, RoutineRun, RoutineSchedule, Visibility, Widget, WidgetData } from "../../plugin/shared/types.ts";
import type { BoatChoice, ImageView } from "./images.ts";
import type { Term } from "./search.ts";
import type { AgentFollowState, AgentRow, ContactState, ConnectorRow, FeedCounts, FeedMenus, GroupRow, Held, LiveLine, MachineRow, NameRef, Records, RoutineRow, RunSeen, SharedPart, Step, TaskRow, Thread, WorkspaceRow } from "../../plugin/shared/api.ts";
export type { Message } from "../../plugin/shared/api.ts";
import type { Message } from "../../plugin/shared/api.ts";
import type { FileView as FileRecord } from "../../plugin/shared/api.ts";
export type { Added, AgentFollowState, AgentModels, AgentRoutines, AgentRow, BoxRow, CloneRow, ConnectorRow, ContactState, ContactsList, FeedCounts, FeedMenus, FeedQ, FolderRow, FolderWip, GhPull, GithubInfo, Going, GroupRow, GuestOf, Held, LaunchRow, LiveLine, TheirCard, MachineRow, NameRef, NoteRow, PageData, PageRow, Records, Reply, RoutineRow, RunSeen, Said, SearchHit, SearchQ, SharedPart, SideQ, SideRecord, Step, TaskRow, Thread, ThreadQ, ThreadRecords, ThreadRuntime, Worker, WorkspacePulls, WorkspaceRow } from "../../plugin/shared/api.ts";
export type { FileView as FileRecord } from "../../plugin/shared/api.ts";
export type { Question, Task, Page, Widget, Routine, Group, Note, Workspace, Visibility, Launch } from "../../plugin/shared/types.ts";

// What a request still on its way, or one that failed, leaves where its answer goes.
export interface Asking {
  loading?: boolean;
  error?: string | null;
}
// The thread on its own page (threadDetailOf): it, its latest messages, and what the server says around it.
export type ThreadDetail = Omit<Thread, "messages" | "files" | "runs"> & {
  messages: Message[];
  files?: FileRecord[];
  runs?: RunSeen[] | null;
  questions?: (Question & { at?: string })[];
  older?: string | null;
  earlier: number;
  watching: boolean;
  v: number;
  names: Record<string, NameRef>;
  workspaces: string[];
  others: Thread[];
  from: Thread | null;
  // The threads it started (Claude Desktop's tasks), as rows.
  startedThreads: Thread[];
};
// A branch a machine has checked out, to clean up once it's landed (cleanBranch).
export interface CleanBranch {
  machine: string;
  root: string;
  branch: string;
}
// You, as /api/auth/me says (null user: signed out), with what the server says about signing in.
export interface AuthMe extends AuthInfo {
  user: Me | null;
}
// Your passkeys, and the machines of yours that keep them.
export interface Passkeys {
  passkeys: { id: string; name: string; created: string; fingerprint: string; removing?: boolean }[];
  machines?: { name: string; keys: string[]; online: boolean; source: string | null }[];
}
export interface RemoteInfo {
  handle: string;
  reach: { ok: boolean; at: number } | null;
  waiting: number;
}
// What someone elsewhere published to you (server/api/people-things.ts), each as their door signed it: its type, its
// id on their page, what it says (server/publish.ts's lists), whom it names that your page knows, when it came; who
// wrote it (`author`, their username here; `passed_on` when it isn't the sender's own; `yours` when you did).
export interface TheirThing {
  type: "person" | "agent" | "thread" | "page" | "task" | "group" | "note" | "comment" | "work";
  id: string;
  body: Record<string, any>;
  mentions: { username: string; you: boolean }[];
  got: string;
  author: string | null;
  passed_on: boolean;
  yours: boolean;
  space: string | null;
}
// Someone in a group, note or task of theirs: you, someone your page knows (`username`), or only the handle they go
// by, which is their own word.
export interface Shown {
  handle: string | null;
  username: string | null;
  you: boolean;
}
// Theirs, for their profile: `as_of`, when their door last said anything; their agents, each with whether it's in your
// feed (`ref`: its id on your page, r:<their user id>:<its id>).
export interface TheirThings {
  as_of: string;
  remote: RemoteInfo | null;
  person: TheirThing | null;
  agents: (TheirThing & { ref: string; follow: AgentFollowState | null })[];
  threads: TheirThing[];
  pages: TheirThing[];
  tasks: TheirThing[];
  groups: TheirThing[];
  notes: TheirThing[];
}
// A group, task, page or note of theirs you're asked into or in (server/api/people-spaces.ts), and your threads in it.
export interface TheirSpace {
  home: string;
  space: string;
  kind: "group" | "task" | "page" | "note";
  id: string;
  name: string | null;
  state: "asked" | "in";
  at: string;
  threads: string[];
}
// Your door (server/door.ts): up on this machine (`invite`: your invite link), elsewhere (another of yours runs it),
// starting, or off.
export interface DoorStatus {
  state: "up" | "starting" | "elsewhere" | "off";
  why?: string;
  handle?: string | null;
  machine?: string | null;
  key?: string | null;
  expires?: string | null;
  invite?: string | null;
}
// A machine waiting to be connected with a code (agentbook-cli login): its name, where it asked from, and the machine
// of yours it replaces.
export interface DeviceRequest {
  name: string;
  from?: string;
  created?: string;
  replaces?: { created: string }[];
}
// A sign-in with GitHub, as it goes: pending, done (as who), or why not.
export interface GhSigninPoll {
  status: string;
  connector?: { who?: string };
  error?: string;
}
// The view the address names (parseRoute): which screen, and what on it.
export interface Route {
  name: string;
  id?: string;
  tab?: string;
  sub?: string | null;
  open?: string | null;
  machine?: string | null;
  thread?: string | null;
  bar?: boolean;
  w?: string | null;
  filters?: Record<string, string>;
  v?: string | null;
  arg?: string;
  job?: string;
  skill?: string;
  workspace?: string | null;
  code?: string;
  cloud?: string;
  old?: boolean;
  form?: { thread: string; page: string };
  scope?: Scope;
  status?: string | null;
  changes?: string | null;
  at?: string | null;
  ask?: string | null;
  msg?: string | null;
  file?: string | null;
  convo?: boolean;
  // A thing someone elsewhere sent you, by its id on their page (#/people/<them>/things/<id>).
  thing?: string;
}
// What a filter bar narrows a list to, by kind: agents', workspaces', pages' and groups' ids.
export type Scope = Record<"agent" | "workspace" | "page" | "group", string[]>;
// The page's state: what it was sent and what you've opened, picked and typed. Drawn again from this on every change.
// The feed (q/feed): its cards' keys in order, their records, and what asking for more goes on from.
export interface FeedList {
  ask: string | null;
  v: number;
  watching: boolean;
  list: string[];
  records: Records;
  live: Record<string, LiveLine>;
  next: string | null;
  counts: FeedCounts;
  menus: FeedMenus;
  // Cards the stream brought since, not in `list` yet.
  fresh: string[];
  q: string;
  terms: Term[] | null;
}
// A card on the feed: a thread, a page's update, a thread still starting.
export type FeedRecord = Thread;
// A workspace you're not in, by its link: it and its threads, or why not.
export interface WorkspaceSeen extends Asking {
  // A workspace shared with you: what it has, as its owner's page has it (sharedWips reads them).
  parts?: SharedPart[];
  workspace?: WorkspaceRow;
  threads?: Thread[];
}
// A machine on its own page: its record, what it says it runs, and what it's waiting on you for.
export type MachineView = Partial<MachineRow> & {
  name: string;
  missing?: boolean;
  agents?: string[];
  audit?: AuditLine[];
  cli?: string | null;
  clone_dir?: string | null;
  gate?: MachineGate | null;
  // Its owner's connectors that run machines (boat, exe.dev), to say which one it runs in.
  boat?: BoatChoice[];
  os?: string;
  posts?: number;
  seen?: string;
  since?: string;
  waiting?: Held[];
};
// What a machine lets this server do (its gate.json, plugin/cli/gate.ts): who steers it, its folders, what's off,
// how many new threads an hour, what asks there first, and the passkeys what can run something is signed with.
export interface MachineGate {
  owner?: string | null;
  shared: string[];
  never?: string[];
  off?: string[];
  starts_per_hour: number;
  ask_here?: string[];
  waiting?: number;
  signed?: { keys: { fingerprint: string }[]; sites?: { origin: string; name?: string | null; keys: { fingerprint: string }[] }[] } | null;
  server_here?: boolean;
}
// A line of what a machine did with what it was asked: the command's kind, from whom, when, where, and how it went.
export interface AuditLine {
  kind: string;
  outcome: string;
  by?: string | null;
  at: string;
  root?: string | null;
  path?: string | null;
  reason?: string | null;
}
export interface MachineUsage {
  name: string;
  error?: string;
  // This month's machine time, its size and what it cost.
  usage?: { seconds: number; size?: string | null; dollars: number } | null;
  // Your boat plan (server/integrations/connectors/boat.ts's wallet): its hours left, until when, and your balance.
  wallet?: { can_start: boolean; plan_dollars: number | null; hours: number | null; hours_left: number | null; period_end: string | null; balance: number | null; hour_dollars: number | null; max_stop_seconds: number | null } | null;
}
export interface MachineBoxes {
  name: string;
  connector: string;
  list: { id: string; name?: string; off?: boolean; state?: string }[] | null;
  error: string | null;
}
// The images you made (/api/images), with the boat connectors they can go on.
export interface ImagesView {
  images: ImageView[];
  boat?: BoatChoice[];
  failed?: string;
  // The sizes a sandbox can be, the connectors boat didn't answer for, and whether your machines sign.
  sizes?: Record<string, string>;
  unreachable?: string | null;
  signs?: boolean;
}
// OpenClaw, as a machine has it set up: how it connects, and its admin.
export interface OpenClawSetup {
  state?: string;
  mode?: string;
  url?: string;
  from?: string;
  fromEnv?: boolean;
  auth?: string;
  connected?: boolean;
  server?: string;
  error?: string;
  // A pairing waiting for its owner's OK: until when, and its id (openclaw devices approve).
  expiresAt?: number;
  requestId?: string;
  admin?: { state?: string };
  // The agentbook plugin on its gateway: whether it's there, which version, and the tools it doesn't have yet.
  tools?: { installed?: boolean; version?: string | null; missing?: string[]; error?: string } | null;
}
export interface Runtimes {
  machine?: string;
  profiles?: boolean;
  runtimes?: RuntimeRow[];
}
// An agent runtime on a machine (read.runtimes, plugin/cli/daemon.ts): whether it's ready, in words, and why.
export interface RuntimeRow {
  kind: string;
  agent: string;
  name: string;
  ok: boolean;
  status: string;
  detail: string;
  config_dir?: string;
  remote?: boolean;
  online?: boolean;
  install?: import("../../plugin/shared/runtimes.ts").RuntimeInstall;
  provider?: import("../../plugin/shared/runtime-providers.ts").RuntimeProvider;
  update?: import("../../plugin/shared/runtimes.ts").RuntimeUpdate;
}
export interface RemoteAgentSetup {
  connected?: boolean;
  budget?: number;
  github?: boolean;
  org?: string;
}
// A group on its own page (/api/groups/:id): it, its folder, its files, members, threads and WIP.
export type GroupView = Omit<GroupRow, "notes" | "files"> & {
  dir?: string | null;
  link?: string;
  thread_ids?: string[];
  notes?: GroupNote[];
  file_list?: GroupFile[];
  events?: GroupEvent[];
  // What its threads are told: how they start, its news, and as whom.
  told?: { start?: string; news?: string; as?: string } | null;
  threads?: Thread[];
};
export interface GroupFileVersion {
  v: number;
}
// A page's live routines' answers, while it's open (loadLive): for the filters asked with (`key`).
export interface PageLive {
  busy?: boolean;
  asked?: number;
  want?: string;
  key?: string;
  routines?: LiveRoutine[];
}
// One live routine's last run, for a page's filters: the widgets it filled, and the ones it keeps.
export interface LiveRoutine {
  id?: string;
  at?: string;
  ok?: boolean;
  failed?: boolean;
  error?: string | null;
  every?: { everyMs: number };
  widgets?: { id: string; data?: WidgetData }[];
  keeps?: string[];
}
// A dashboard's panels' answers, for the view asked for (loadDash): by panel, and the panels still on their way.
export interface DashAnswers {
  panels: Record<string, PanelAnswer>;
  pending: Set<string>;
  want?: string;
  asked?: number;
  got?: number;
  key?: string;
  error?: string | null;
  view?: DashView;
}
// What a dashboard's panel answered: its data, when, and why not.
export interface PanelAnswer {
  id: string;
  key?: string;
  data?: WidgetData;
  at?: string;
  error?: string | null;
  // Its source, how long it took, and what it noted; kept from a moment ago, or being asked again; old, or a link to
  // it in its source.
  source?: { name?: string; kind?: string };
  ms?: number | null;
  notes?: string[];
  cached?: boolean;
  refreshing?: boolean;
  stale?: boolean;
  link?: string | null;
}
// The view a dashboard's panels were asked for: the range, and how often its answers are kept.
export interface DashView {
  past?: boolean;
  // How long a point of a chart is: "5m".
  interval?: string;
  interval_ms?: number;
  from?: number;
  to?: number;
}
export type Me = Person;
// What the server says about signing in: whether there's an account yet, whether people can sign up, and your
// settings once you're in.
export interface AuthInfo {
  prefs?: Prefs;
  // The page is its machine's account's (agentbook login): only that account signs in, with Google, through the
  // relay (its providers, and its page, where the account's machines are).
  account?: boolean;
  relay?: { providers: { id: string; name: string }[]; url: string } | null;
  // Nobody has signed in to it yet: the machine was just put on the account, its person signed in on the relay's
  // page a moment ago, and the page goes straight on to signing them in here (SignIn.tsx).
  first?: boolean;
}
// Someone with an account here (/api/people): their name and picture, and when an admin turned them off or deleted
// them.
export interface Person {
  id: string;
  username: string;
  display_name: string;
  bio?: string;
  avatar?: Avatar | null;
  role?: string;
  created?: string;
  disabled?: string;
  deleted?: string;
  // Your contact (only in the list of everyone here, /api/people).
  contact?: boolean;
}
// A person's page (/api/people/:username): them, their agents and the workspaces they show you, how you and they stand,
// and on your own page your machines and passkeys. `missing`: no one by that name.
export interface PersonView {
  id: string;
  missing?: boolean;
  user?: Person;
  me?: boolean;
  agents?: AgentRow[];
  workspaces?: { id: string; name: string; repo: string | null; visibility: Visibility }[];
  devices?: DeviceRow[];
  not_linked?: NotLinkedRow[];
  // Why this machine isn't on iroh, when it should be (not installed): it links to your others over HTTP.
  iroh_why?: string | null;
  // How you and they stand: contacts, or one asking the other (null on your own).
  contact?: ContactState | null;
  // Someone on another agentbook: their @handle and whether their door answers. Yours: your door.
  remote?: RemoteInfo | null;
  door?: DoorStatus;
  passkeys?: Passkeys | null;
}
// A machine of a person's, on their page: when it connected and was last seen, and whether it signs.
export interface DeviceRow {
  id: string;
  name: string;
  created: string;
  last_seen?: string | null;
  online?: boolean;
  signs?: boolean | null;
  server_here?: boolean;
  // Another machine of yours linked to this page's (server/mesh.ts): its page (null when this machine doesn't reach
  // it), whether this page's machine takes what you sign there, whether it takes what you sign here, and, for one
  // this machine sends nothing to, why.
  linked?: Linked;
}
export interface Linked {
  url: string | null;
  takes: boolean;
  signs: boolean;
  // They talk over iroh, not HTTP; and how that goes now: direct, or through the iroh relay
  // (null while they aren't connected).
  iroh?: boolean;
  path?: "direct" | "relay" | null;
  why?: string;
}
// A machine on your account this page isn't linked with yet, and why (server/mesh.ts).
export interface NotLinkedRow {
  id: string;
  name: string;
  platform: string;
  seen: string | null;
  why: string;
}
// A thread's steps as its machine read them (/steps): each tool call, message and note, and its plan.
export interface Steps {
  steps: Step[];
  plan?: PlanItem[] | null;
  turn?: number;
  error?: string;
}
// What a thread changed (read.changes), in a scope: a turn ("3") or all of it, with its files, their totals and its
// commits; and how many turns changed something.
export interface Changes {
  scope: string;
  latest: number;
  latest_has?: boolean;
  turns: number;
  files: ChangedFile[];
  totals: { files: number; add: number; del: number };
  commits: Commit[];
}
// A file a thread changed, as the page shows it: how, by what, and its lines added and taken out.
export interface ChangedFile {
  path: string;
  kind: string;
  add: number;
  del: number;
  edits?: number;
  exact?: boolean;
  outside?: boolean;
  by?: string;
  nodiff?: true;
  elsewhere?: true;
  binary?: boolean;
  untracked?: boolean;
  scope?: string;
  at?: string | null;
  on_main?: boolean;
}
// A commit: its short sha, what it says, and when.
export interface Commit {
  sha?: string;
  short: string;
  subject: string;
  at: string;
  landed?: boolean;
  files?: string[];
  overlap?: string[];
}
// What a command left running printed (gout), as its machine read it: the end of it, and whether that was cut.
export interface Printed extends Asking {
  text?: string;
  cut?: boolean;
  at?: string;
  stopping?: boolean;
}
// A worker's steps (wsteps), or a card's (lsteps), as its machine read them: `v`, what they were read as.
export interface StepsRead extends Asking {
  steps?: Step[];
  n?: number;
  gone?: boolean;
  v?: string;
}
// A diff fetched for a file, a step or a commit: its files, each with its hunks.
// A diff read from a thread's machine (S.diffs): a file's, with its hunks; a commit's, with its files'; or why not.
export type DiffRead = Asking & Partial<DiffFile> & { files?: DiffFile[] };
// A file's diff: its hunks, whether they were cut short (`more`, the lines left out), or that its lines stayed on
// the machine (`secret`).
export type DiffFile = ChangedFile & { hunks?: { lines: string[] }[]; cut?: boolean; more?: number; secret?: string };
// A file's diff on a branch or a pull request (S.wipDiffs), or why it couldn't be read.
export interface WipDiff extends Asking {
  diff?: DiffFile;
}
export interface DiffComment {
  thread: string;
  at: string;
  path: string;
  commit?: string;
  a: number;
  b: number;
  lines: DiffLine[];
}
// An agent's page (/api/agents/:id): its files, the skills its threads used, and whether it's in your feed (a contact's).
export interface AgentView {
  agent?: AgentRow;
  files?: FileRecord[];
  skills?: { name: string; description?: string; used: number; sessions: number }[];
  follow?: AgentFollowState | null;
}
// A skill on its own page: what it is, its SKILL.md and file (yours only), and the threads that used it.
export interface SkillView {
  missing?: boolean;
  name?: string;
  description?: string;
  body?: string | null;
  file?: string | null;
  listed?: boolean;
  used?: number;
  uses?: { id: string; title: string; label: string; started: string; count: number }[];
}
// An agent's own routines (OpenClaw's cron jobs, Claude's routines, Codex's automations, loops), as its machine
// lists them.
export interface CronJobs {
  routines?: AgentCron[];
  error?: string;
}
// One of them: its schedule, whether it's on, and how its last run went.
export interface AgentCron {
  id: string;
  agent?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  builtin?: boolean;
  kind?: string | null;
  what?: string;
  model?: string | null;
  // A cron (`expr`), as an RRULE (`rule`), in its own time zone (`tz`), or every so often.
  schedule?: (RoutineSchedule & { rule?: string; tz?: string | null }) | null;
  next?: string | null;
  running?: string | null;
  last?: string | null;
  status?: string | null;
  error?: string | null;
  took?: number | null;
  failing?: number;
  // A loop's: the thread it runs in. A claude.ai routine's: where it runs (the Claude app, or the web), on which
  // device, with which repos or folders.
  group?: string;
  post?: string | null;
  thread?: string | null;
  place?: { cowork?: boolean; device?: string; repos?: string[]; folders?: string[]; cwds?: string[]; worktree?: boolean };
  // An OpenClaw cron job's: the session it runs in, and where what it reports goes.
  target?: string;
  delivery?: { mode: string; channel: string | null; to: string | null } | null;
  effort?: string | null;
  url?: string | null;
  acts?: string[];
  created?: string | null;
}
// One routine of an agent's, open: it, its runs, and the threads started on it.
export interface CronJob {
  routine?: AgentCron & { when?: string };
  runs?: CronRun[];
  total?: number | null;
  more?: boolean;
  threads?: { at: string; post?: string | null; lid?: string }[];
  error?: string;
  missing?: boolean;
}
// A run of one: when, how long, how it went, what it said, and its session.
export interface CronRun {
  id: string;
  job?: string;
  at: string;
  took?: number | null;
  status?: string;
  error?: string | null;
  summary?: string;
  session?: string;
  post?: string | null;
}
// What a run did (S.runs): its steps and its reply, or that its session is gone.
export interface CronRunRead extends Asking {
  steps?: Step[];
  reply?: { text?: string } | null;
  gone?: boolean;
  url?: string;
}
// An agent's usage limits (cli/limits.ts): `none` for one that has none to show; `read`, when the page asked.
export interface Limits {
  none?: boolean;
  read?: number;
  limits?: { name: string; plan?: string; windows?: { label: string; used: number; resets?: string | null }[]; credits?: unknown; error?: string; blocked?: boolean }[];
  host?: string;
  at?: string;
  as_of?: string;
  offline?: boolean;
  error?: string;
}
// An OpenClaw agent's workspace (aw): its files and folders, or the core files OpenClaw keeps (`core`), with more
// than shows (`more`).
export interface AgentFolder {
  error?: string;
  root?: string;
  host?: string;
  core?: boolean;
  more?: boolean;
  files?: { path: string; modified?: string; size?: number }[];
  dirs?: { path: string; modified?: string; listed?: boolean }[];
}
// A branch's WIP as its machine read it (cli/wip.ts): where it is, its commits, the commits that landed on its base
// since it branched (`main`, each with the files they share with it), and its files, committed or not.
export interface WipBranch {
  root: string;
  branch: string;
  base: string;
  merge_base: string | null;
  worktree: string | null;
  place?: string;
  here: boolean;
  subject: string;
  at: string;
  ahead: number;
  behind: number;
  dirty: number;
  commits: Commit[];
  main: (Commit & { overlap: string[] })[];
  overlap: string[];
  committed: ChangedFile[];
  uncommitted: ChangedFile[];
}
// A pull request as GitHub has it (server/integrations/pulls.ts's pullDetail): its checks, reviews, comments and
// review threads, its commits and files, and what happened to it.
export interface WipPull {
  number: number;
  title: string;
  url: string;
  sha: string;
  body: string;
  merged_by: string | null;
  // How many commits it has.
  commits: number;
  labels: { name: string; color: string }[];
  assignees: string[];
  requested: string[];
  reviewers: { who: string; state: string; at: string }[];
  checks: PrChecks | null;
  checks_list: { name: string; workflow: string | null; state: string; conclusion: string; required: boolean; url: string | null }[];
  commits_list: { sha: string; short: string; subject: string; at: string; who: string | null }[];
  comments_list: { id: string; n: number | null; who: string; bot: boolean; body: string; at: string; url: string }[];
  reviews_list: { id: string; who: string; bot: boolean; state: string; body: string; at: string; url: string }[];
  threads_list: PullThread[];
  files_list: { path: string; add: number; del: number; kind: string }[];
  files_more: number;
  events: { kind: string; who: string | null; at: string }[];
}
// A review thread on a pull request: the file and line it's on, whether it's resolved, what's said in it, and what
// you may do in it.
export interface PullThread {
  id: string;
  path: string;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  hunk: string[] | null;
  can: { reply: boolean; resolve: boolean };
  comments?: { id: string; who: string; body: string; at: string; url?: string }[];
}
// The open WIP's page as it was read (loadWip, loadPull): a branch's or a pull request's, or why not; `loaded`, what it
// was read as, to read it again when that changes.
export type WipView = WipBranchView | WipPullView;
export type WipBranchView = Partial<WipBranch> & WipLoaded;
export type WipPullView = Partial<WipPull> & WipLoaded;
export interface WipLoaded {
  id: string;
  error?: boolean | string;
  loaded?: string;
}
export interface Told {
  at: string;
  text: string;
  to: string;
  post: string | null;
}
// A task you're not on, by its link: it and its threads, or why not.
export interface TaskSeen extends Asking {
  task?: TaskRow;
  threads?: Thread[];
}
// What a task's part changed (setChg): its files, with more than shows (`more`), and where GitHub shows them (`url`).
export interface SetChanges extends Asking {
  files?: ChangedFile[];
  more?: number;
  url?: string | null;
  key?: string;
}
// The repos you have on GitHub (for New machine and Add a workspace): with more than are listed (`more`).
export interface GhRepos {
  repos: GhRepo[];
  more?: number;
}
// One of your repos on GitHub (server/integrations/connectors/github.ts's repos): its owner/name (`slug`), its key
// here (`repo`), when it was last pushed to, and what it is.
export interface GhRepo {
  slug: string;
  repo: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  pushed?: string | null;
  about?: string | null;
}
// A checkout's branches, as its machine reads them for the composer.
export interface BranchList {
  branch?: string;
  branches?: { name: string; at?: string }[];
}
// A page on its own page (/api/pages/:id): its record, its versions, and the threads on it.
export type PageView = Page & {
  mine?: boolean;
  can_edit?: boolean;
  history?: PageVersionRow[];
  // The threads that worked on it: how many versions each made, its first and last.
  posts?: { post: string; agent: string; versions: number; first?: number; last?: number; at: string }[];
  threads?: Thread[];
};
// One of its versions, as History lists it.
export type PageVersionRow = Omit<PageVersion, "id" | "page" | "snapshot">;
// A note on its own page, with its words counted and the threads on it.
// A note on its own page; or, `missing`, one that isn't there or that you can't see, with only its id.
export type NoteView = Partial<Omit<Note, "comments">> & {
  id: string;
  comments?: NoteCommentView[];
  missing?: boolean;
  mine?: boolean;
  words?: number;
  thread_rows?: Thread[];
};
// A comment on a note, as the page has it: one you're still writing (`draft`), the agent it asked, its thread.
export type NoteCommentView = NoteComment & { draft?: boolean; asked?: string; thread?: string | null };
export interface NoteDraft {
  id: string;
  note: string;
  quote: string;
  nth: number;
  msgs: unknown[];
  draft: boolean;
}
// A page as it was at a version (?at=): the version, with a copy of the page as it then was.
export type PageAt = Partial<PageVersion> & { page: string; v: number; snapshot?: PageSnapshot; missing?: boolean };
// A page being changed by hand (Edit): its widgets as they'll be saved, as they were (`original`), the ones taken
// out, which one is open, and its title, icon and description.
export interface PageEdit {
  pid: string;
  base: number;
  // `fresh`: one added in this edit, not saved yet.
  widgets: (Widget & { fresh?: boolean })[];
  original: Widget[];
  removed: string[];
  open: string | null;
  title: string;
  emoji: string;
  about: string;
}
// New routine, or one being changed, as typed so far: when it runs (formSchedule's), what it is, and what it's linked
// to (`into`: the thread its runs go on in).
export interface RoutineForm {
  rid?: string;
  kind?: string;
  how: string;
  time: string;
  day: string;
  every: string;
  expr?: string;
  name: string;
  prompt: string;
  agent: string;
  writer?: string;
  root: string;
  links: RoutineLink[];
  into: string;
}
// A routine of yours, open (routineDetail): it, its versions and runs, and the threads started on it.
export type RoutineView = Partial<RoutineRow> & {
  missing?: boolean;
  cant_keep?: string;
  timeout?: number;
  memo_size?: number;
  versions?: RoutineVersionRow[];
  change?: { v: number; from: number | null; diff: unknown; also?: string[]; added: string[]; writes: string[] } | null;
  runs?: (RoutineRun & { post?: string | null })[];
  threads?: { at: string; post?: string | null; lid?: string }[];
};
export type RoutineVersionRow = Pick<RoutineCode, "v" | "at" | "by" | "summary" | "code" | "reach" | "prompt" | "agent" | "root" | "model" | "test" | "passed"> & {
  ok: { at: string; by: By | null; signed: boolean } | null;
  diff?: unknown;
  // The version that runs now, and the one it was made from.
  live?: boolean;
  from?: number | null;
};
// Connectors (/api/connectors): the ones set up, and each kind there is, with what it asks for.
export interface ConnectorsView {
  failed?: string;
  error?: string;
  connectors?: ConnectorRow[];
  kinds?: ConnectorKind[];
}
// A kind of connector: its name, what it's for, and what connecting one takes (a key, settings, secrets), and the
// states a task's issue can be in, for one that has tasks.
export interface ConnectorKind {
  kind: string;
  name: string;
  about?: string;
  key?: string;
  data?: boolean;
  machines?: boolean;
  tasks?: boolean;
  scopes?: string[];
  // Its secrets besides its key, by field, with what each is called (connectors.ts's SECRETS).
  secrets?: Record<string, string>;
  fields?: Record<string, { label?: string; hint?: string; of?: string[]; unit?: string; default?: string }>;
  optional?: boolean;
  // People sign in to it with agentbook's app for it, rather than pasting a key (Linear).
  signin?: boolean;
  states?: Record<string, string>;
  default_states?: string[];
}
// agentbook's GitHub App, as Connectors shows it: its links, and whether it signs in with a code.
export interface GhApp {
  app?: { slug?: string; links?: { install?: string; [link: string]: string | undefined }; device_flow?: boolean } | null;
  admin?: boolean;
  note?: string | null;
}
// A sign-in with GitHub on its way: the code to enter where, until when, and the form it's for (`body`, to try again).
export interface GhSignin {
  id: string;
  form?: string;
  body?: object;
  user_code?: string;
  verification_uri?: string;
  until?: number;
  error: string | null;
}
// Where agentbook's GitHub App is installed, and the workspaces whose repos it can't read.
export interface GhInstalls {
  install?: string;
  installations?: { account?: string; url?: string; all?: boolean }[];
  missing?: { workspace: string; text: string; url?: string; label?: string }[];
  error?: string;
}
// A machine's folder (Add a workspace's browser): its folders, the repo it's a clone of, and its parent.
export interface FolderListing {
  machine?: string;
  home?: string;
  path?: string;
  parent?: string | null;
  git?: boolean;
  remote?: string;
  url?: string;
  folders?: { name: string; path: string; git?: boolean; remote?: string; url?: string }[];
  more?: number;
}
// What the server's search found for what's typed (loadFeed): the words found as typed, and by post, which were found
// as typed or as a typo, and the message they're in that its card doesn't show.
export interface Found {
  q: string;
  exact: Set<string>;
  posts: Map<string, { exact: Set<string>; typo: Set<string>; hit: Pick<Message, "id" | "from" | "text"> | null }>;
}
// What agentOf has of an agent: its record, or for one the page has none of, its id and name.
export type AgentSeen = Partial<AgentRow> & Pick<AgentRow, "name" | "kind">;
