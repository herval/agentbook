// Thread (session) records, pull requests, attachments, code runs, and thread life. Types only, which Node strips.

import type { Mode } from "../runtimes.ts";
import type { Iso, Visibility } from "./common.ts";
import type { TurnShape } from "./shapes.ts";
import type { WidgetData } from "./widgets.ts";

// A thread's life, for the strip on its card (life.ts): spans it worked and waited, and marks along the way.
export interface ThreadLife {
  work: [Iso, Iso | null][];
  wait: [Iso, Iso | null][];
  marks: { at: Iso; k: "merge" | "pr" | "result" | "pic" | "you"; t: string }[];
}

export type SessionState = "idle" | "working" | "waiting" | "done";

// A thread (the code calls threads sessions, or posts): one conversation of an agent's, on a machine.
export interface Session {
  id: string;
  agent: string;
  label: string;
  proc: string;
  session_id: string | null;
  transcript: string | null;
  started: Iso;
  updated: Iso;
  // Counts every change, for what reads it again when it changes.
  rev: number;
  title: string | null;
  text: string | null;
  prompt: string | null;
  // Claude Code's own title for it.
  ai_title?: string | null;
  state: SessionState;
  busy: boolean;
  // What it's doing, in a line.
  doing?: string | null;
  turn_started?: Iso;
  turn_ended?: Iso;
  // The API error that ended its turn, until the next turn starts.
  failed?: SessionFailure | null;
  ended: Iso | null;
  end_reason: string | null;
  // A background session whose process stopped, which writing to wakes.
  asleep?: boolean;
  slept?: Iso | null;
  sleep_reason?: string | null;
  cwd?: string | null;
  root?: string | null;
  repo?: string | null;
  branch?: string | null;
  host?: string | null;
  pid?: number;
  channel: boolean;
  // Claude Desktop or VS Code, where what's typed into it is typed.
  app?: "desktop" | "vscode" | null;
  launch: string | null;
  // "claude" or "codex": it runs in their cloud, not on a machine.
  cloud: string | null;
  url: string | null;
  updates: SessionUpdate[];
  attachments: Record<string, Attachment>;
  // Its pull requests, by link.
  prs: Record<string, PostPr>;
  // How its current turn went, until the reply that ends it takes it.
  shape?: TurnShape;
  // Its code blocks' latest runs, by `${message id}:${block}`.
  runs?: Record<string, CodeRun>;
  pinned?: boolean;
  pinned_at?: Iso | null;
  archived?: boolean;
  archived_at?: Iso | null;
  hidden?: boolean;
  hidden_at?: Iso | null;
  // Since when nothing of its session comes in: its person stopped following it.
  off?: Iso | null;
  // Its own setting (null: as its agent's), and whether others see its work.
  visibility?: Visibility | null;
  show_work?: boolean;
  // The group it's in, and the last line of the group's feed it was told.
  group?: string | null;
  group_seen?: number | null;
  // Its person's username, on a server many people use (groups.ts).
  owner?: string | null;
  // The task it's on that ships more than it does.
  wip?: string | null;
  // The page its person put it on by hand, as its server says.
  paged?: { page: string | null };
  // Its branch, once it was cleaned up with all of its work on main.
  landed?: string;
  skills?: Skill[];
  skill_uses?: Record<string, number>;
  // Its queue held: "stopped", "ended" or "you".
  queue_paused?: string;
  // The thread it was started from, and whether its person picked that (`from_by`).
  started_from?: string;
  from_by?: "you";
  // A side thread's: when it was made.
  side_at?: Iso;
  // The model, effort and mode picked for its next turn (or, for a runtime that switches its mode at once, while it
  // does); null once it's switched.
  model_pick?: string | null;
  effort_pick?: string | null;
  mode_pick?: Mode | null;
  // The mode it's in (runtimes.ts's Mode): the one it started in, then the one it was switched to, or that its
  // transcript says (Claude Code's, which can be switched in its terminal).
  mode?: Mode | null;
  // The effort it runs at, when agentbook knows it: the one it started on or was switched to.
  effort?: string | null;
  // The session ids (or their starts) of the copies Claude Code made of it on a resume.
  copies?: string[];
  model?: string | null;
  plan?: PlanItem[] | null;
  stats?: SessionStats;
  // Tokens in its context.
  context?: number;
  loops?: Loop[];
  // When a cron job's run with something to report moved it on the feed.
  moved?: Iso;
  // From when sessions could be paused: dropped as the store loads.
  paused?: unknown;
  stopped?: unknown;
}
// The API error that ended a turn: Claude Code's kind of it ("server_error", "rate_limit"…) and what it said.
export interface SessionFailure {
  error: string;
  text: string | null;
  at: Iso;
}
// A thread's result line, or agentbook's own line for a turn that changed files (`changes`) or a pull request that
// changed (`pr`).
export interface SessionUpdate {
  at: Iso;
  text: string;
  link: string | null;
  changes?: TurnChanges;
  pr?: { url: string; number: number | null; kind: PrLineKind };
  // Its agent put it on its person's bell too.
  notify?: true;
}
// What a turn changed: its files' totals, the last edit (`last`, to say it once), its biggest files as tiles, and how
// far it reaches.
export interface TurnChanges {
  turn: number;
  files: number;
  add: number;
  del: number;
  last: string;
  tiles?: { path: string; add: number; del: number }[];
  reach?: ChangeReach;
}
// How far a turn's change reaches (cli/reach.ts): the repo by folder, with the files it changed and what imports them.
export interface ChangeReach {
  folders: { dir: string; size: number; files: ReachFile[]; rest: number }[];
  changed: number;
  importers: number;
  untested: number;
}
export interface ReachFile {
  path: string;
  size: number;
  add?: number;
  del?: number;
  changed?: true;
  untested?: true;
  imports?: true;
}
// Something an agent keeps in view on its thread (ab_attach): a widget of one of a few kinds.
export interface Attachment {
  key: string;
  type: AttachmentType;
  title: string;
  data: AttachmentData;
  created: Iso;
  updated: Iso;
}
export type AttachmentType = "table" | "metric" | "note" | "link" | "chart" | "diagram";
// An attachment's data: a widget's, where a field an agent sent that isn't kept is null, so merging it in drops what
// was there.
export type AttachmentData = { [K in keyof WidgetData]?: WidgetData[K] | null };
// How a post came to link a pull request, strongest first.
export type PrHow = "opened" | "worked" | "you" | "agent" | "branch";
// One of a thread's pull requests: how it came to be linked, whether it was unlinked (`off`), and where it stands on
// GitHub (`gh`).
export interface PostPr {
  url: string;
  number: number;
  repo: string;
  at: Iso | null;
  how: PrHow;
  off?: boolean;
  gh?: PrCard | null;
}
// A pull request as GitHub said it stood (server/integrations/pulls.ts's card).
export interface PrCard {
  number: number;
  title: string;
  url: string;
  state: PrState;
  head: string;
  base: string;
  // Its head commit, short.
  sha: string | null;
  author: string;
  // Whether the account it was read as opened it.
  mine: boolean;
  updated: Iso;
  closed: Iso | null;
  mergeable: "yes" | "conflicts" | null;
  merge_state: string | null;
  review: PrReview | null;
  checks: PrChecks | null;
  // Unresolved review threads.
  threads: number;
  comments: number;
  add: number;
  del: number;
  files: number;
  // Where its base branch is now: cards read before it was kept lack it.
  base_head?: { sha: string; at: Iso | null; subject: string } | null;
  merged_by: string | null;
  failing: string[];
  reviewer: string | null;
  // Who it waits on for a review.
  waiting: string[];
  // Who else said something, and when.
  said: PrSaid[];
  // Its checks failed, until they all pass again.
  red: boolean;
}
export type PrState = "open" | "draft" | "merged" | "closed";
export type PrReview = "approved" | "changes" | "required";
export interface PrChecks {
  pass: number;
  fail: number;
  pending: number;
  skip: number;
  total: number;
}
export interface PrSaid {
  who: string;
  at: Iso;
}
// What a line about a pull request says happened to it.
export type PrLineKind = "merged" | "closed" | "fail" | "good" | "note" | "opened";
// A code block of one of a thread's messages, run on its machine: its latest run.
export interface CodeRun {
  mid: string;
  block: number;
  state: RunState;
  by: string | null;
  started: Iso;
  ended: Iso | null;
  exit: number | null;
  signal: string | null;
  // The end of what it printed, and whether that was cut.
  out: string;
  cut: boolean;
  error: string | null;
}
export type RunState = "running" | "done" | "stopped" | "failed";
// A skill a session can use.
export interface Skill {
  name: string;
  description: string;
  file?: string;
}
// A step of a session's plan (TodoWrite, Codex's plan). `status`: as its agent says it ("pending", "in_progress",
// "completed").
export interface PlanItem {
  text: string;
  now: string;
  status: string;
}
export interface SessionStats {
  steps: number;
  errors: number;
  worked_ms: number;
  files?: number;
}
// What a session set itself to do again (/loop): a cron, or a self-paced loop.
export interface Loop {
  id: string;
  kind: "cron" | "paced";
  cron?: string;
  prompt: string;
  recurring?: boolean;
  reason?: string;
  at: Iso;
  next: Iso | null;
  ended: Iso | null;
  runs: { at: Iso; turn: number }[];
  // Someone started it (/loop), rather than its agent setting itself a check.
  slash?: boolean;
}
