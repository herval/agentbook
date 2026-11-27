// Launches, questions, to-dos, files, messages, outbox events, and paged history summaries. Types only, stripped by Node.

import type { Mode } from "../runtimes.ts";
import type { DoneBy, Iso, RoutineRef, Visibility } from "./common.ts";
import type { TurnShape } from "./shapes.ts";
import type { RunState, ThreadLife } from "./threads.ts";

// The parts that make a thread's history, which memory holds whole for a thread or not at all.
export type HistoryPart = "questions" | "files" | "messages";

// What the feed shows of a thread whose history is out of memory (store.ts's feedOf).
export interface FeedSummary {
  messages: number;
  last_messages: Message[];
  files: number;
  last_files: FileRecord[];
  pictures: number;
  last_pictures: FileRecord[];
  life: ThreadLife | null;
}

// A start: a thread on its way (a new session, a resume, a cloud session coming here), until its session says hello.
export interface Launch {
  id: string;
  agent: string;
  root: string | null;
  // Where it started, when that isn't `root` (a worktree).
  cwd?: string | null;
  branch: string | null;
  prompt: string;
  files: string[];
  at: Iso;
  // The thread it's for: a resume's, or the one its session became.
  post: string | null;
  resume: boolean;
  // The session will be known by the id Claude Code gives it (`session`).
  named: boolean;
  session?: string;
  // A Claude Code cloud session coming here: its id.
  teleport?: string | null;
  // Its first prompt reached the thread already.
  mirrored?: boolean;
  visibility?: Visibility | null;
  // The repo it's cloning first.
  cloning?: string | null;
  // What it's doing before its session is up, and how far it got.
  step?: string | null;
  progress?: { done: number; total: number } | null;
  // The text of the task it was sent for.
  task?: string | null;
  // The page it's for, "new" for one to make.
  page?: string | null;
  group?: string | null;
  model?: string | null;
  effort?: string | null;
  mode?: Mode | null;
  routine?: RoutineRef | null;
  // What it was told is agentbook's words for someone's (a note's comment, a thread it's a guest in).
  noted?: boolean;
  // Who started it, when that isn't the machine's owner.
  user?: string;
  // A side thread's: the thread it goes on from.
  side_of?: string;
  error: string | null;
  // Its session said hello.
  arrived?: boolean;
  // A start that failed, out of the feed.
  archived?: Iso;
}
// A question a thread asks its person: a choice, a permission, an OK.
export interface Question {
  id: string;
  post: string;
  kind: string;
  title: string;
  detail: string;
  preview: string;
  options: QuestionOption[];
  default: string | null;
  until: Iso | null;
  key: string | null;
  request_id: string | null;
  tool_name: string | null;
  // A hook waits for the answer itself.
  hook?: boolean;
  // Its turn can't go on without the answer.
  blocks?: boolean;
  // It takes an answer of your own besides its options.
  other?: boolean;
  // The OK for a page routine's version.
  routine?: QuestionRoutine | null;
  asked: Iso;
  answered: Iso | null;
  value: string | null;
  // Who answered: "human", "default", "skipped", "gone", "replaced", "expired"…
  by: string | null;
  // A file sent as the answer.
  file_id?: string | null;
  file?: AnswerFile | null;
  // Allow + Auto: the mode the answer switched its thread to (a hook's question switches it as it answers: hook.ts).
  mode?: Mode;
}
export interface QuestionOption {
  label: string;
  detail: string | null;
}
// The OK a question asks for a routine's version: its first option (`yes`) uses it.
export interface QuestionRoutine {
  rid: string;
  v: number;
  yes: string;
}
// A file sent as an answer, as its session reads it.
export interface AnswerFile {
  name: string;
  size: number;
  path: string;
}
// An agent's to-do, from before to-dos were tasks.
export interface Todo {
  id: string;
  post: string;
  text: string;
  at: Iso;
  done: boolean;
  done_at: Iso | null;
  done_by?: DoneBy | null;
  done_post?: string | null;
  done_user?: string | null;
}
// A file on a thread: one an agent handed over, one you sent, or one in a message.
export interface FileRecord {
  id: string;
  post: string | null;
  from: "human" | "agent";
  name: string;
  title: string;
  size: number;
  // Where it's kept in the store's files folder.
  stored: string;
  // A draft the person sees before it's sent; one shown in a page or a reply; one not sent yet.
  draft: boolean;
  embedded: boolean;
  pending: boolean;
  at: Iso;
  // Where a driver fetches it from when it's first opened (a picture in an OpenClaw message).
  remote?: FileRemote;
  // Its bytes on the server (sha256), and the upload it came from there.
  blob?: string | null;
  ref?: string;
  type?: string;
  // The claude.ai artifact it's a copy of, by its link.
  artifact?: string;
}
// Where in OpenClaw a file is.
export interface FileRemote {
  artifact?: string | null;
  source?: string;
  seq: number | null;
  n?: number;
  type: string;
  title: string;
}
// A message on a thread: yours, or its agent's.
export interface Message {
  id: string;
  post: string;
  from: "human" | "agent";
  // Where it was said: "dash" (agentbook), "terminal", "side" (it started a side thread), or a channel's name.
  via: string;
  text: string;
  file_id: string | null;
  files: MessageFile[];
  at: Iso;
  // Who sent it, when it isn't the machine's owner.
  user?: string;
  // Who it's from, as its machine tells its agent before their words.
  intro?: string;
  // Its id in the agent's own record of the session (OpenClaw's history).
  ext?: string;
  routine?: RoutineRef;
  // One of yours waiting for its thread's turn to end.
  queued?: true;
  // It waited in the queue.
  waited?: true;
  // A slash command it is, or whose output it is.
  command?: string;
  // How the turn it ends went.
  shape?: TurnShape;
  // A side thread's launch, for what you sent on the side.
  launch?: string;
  // One of yours its agent couldn't be reached with.
  failed?: { error: string; at: Iso };
}
export interface MessageFile {
  id: string;
  name: string;
  size: number;
}
// Something waiting to be delivered to a thread's session. `mid`: the message it is; `held`: it waits in the thread's
// queue; `failed`: it couldn't be delivered and waits aside.
export interface OutboxEntry {
  oid: string;
  post: string;
  event: OutboxEvent;
  at: Iso;
  delivered: boolean;
  mid?: string;
  held?: boolean;
  failed?: boolean;
}
// What goes to a session: a message of yours, a file, a permission's answer, a question's answer, a note from
// agentbook, or how a code block's run went.
export type OutboxEvent = MessageEvent | FileEvent | PermissionEvent | AnswerEvent | NoteEvent | RunEvent;
export interface MessageEvent {
  type: "message";
  text: string;
  files: AnswerFile[];
  command?: string;
  user?: string;
}
export interface FileEvent {
  type: "file";
  file_id: string;
  name: string;
  size: number;
  path: string;
}
export interface PermissionEvent {
  type: "permission";
  request_id: string | null;
  behavior: "allow" | "deny";
}
export interface AnswerEvent {
  type: "answer";
  question_id: string;
  key: string | null;
  question: string;
  value: string | null;
  by: string | null;
  skipped?: boolean;
  file?: AnswerFile | null;
}
export interface NoteEvent {
  type: "note";
  text: string;
}
export interface RunEvent {
  type: "run";
  state: RunState;
  by: string | null;
  started: Iso;
  ended: Iso | null;
  exit: number | null;
  signal: string | null;
  out: string;
  cut: boolean;
  error: string | null;
  // Who wrote the message it's in, and its code.
  from: "human" | "agent" | null;
  code: string;
  // It ran in the thread's terminal.
  terminal: boolean;
}
