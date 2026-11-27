// The ops a store applies (store.ts apply): every change to its state is one, logged before it's applied and replayed
// from the log at start, and a machine's go up to its server (protocol.ts's OPS are the ones that do, and a check there
// keeps their fields to these). A machine's store also logs ops it only sends up: a thread's work and its gate's
// audit. Each kind's fields are here; groups', pages', notes', routines', talks', task-ship's and thread guests' are
// with the code that applies them, and Op is all of them. Types only, which Node strips: nothing here runs.
//
// An op names what it changes by id (`post`, `lid`, `tid`…) and says only what changes. A field the store fills in
// when it's left out (an id, a default) is optional here. `seq` and `at` are the store's own (Logged).

import type { AnswerFile, Avatar, AttachmentData, AttachmentType, BoxMember, FileRemote, ImageBuild, ImageDef, Iso, Loop, MachineCloud, NewsItem, OutboxEvent, PlanItem, PostPr, QuestionOption, QuestionRoutine, RoutineRef, RunState, SessionState, SessionStats, SessionUpdate, Skill, Task, TaskPage, TaskPost, TaskSent, TaskSource, TurnChanges, TurnShape, Visibility, Workspace } from "./types.ts";
import type { GroupOp } from "./groups.ts";
import type { Mode } from "./runtimes.ts";
import type { GuestOp } from "./guests.ts";
import type { NoteOp } from "./notes.ts";
import type { PageOp } from "./pages.ts";
import type { RoutineOp } from "./routines.ts";
import type { TalkOp } from "./talks.ts";
import type { TaskShipOp } from "./task-ship.ts";

/* ---------- threads (the code's sessions, or posts) ---------- */

// Where a thread is: its checkout and branch, as it said hello or moved since.
interface Where {
  cwd?: string | null;
  root?: string | null;
  repo?: string | null;
  branch?: string | null;
}
// Where what's typed into it is typed: Claude Desktop or VS Code.
type App = "desktop" | "vscode";

export type SessionOp =
  // A process said hello (a session started, resumed, or compacted): the thread it is, by its session id, or by the
  // process until it has one. `label`: its bird name (the store picks a free one, `named`); `launch`: the start from
  // agentbook it answers; `cloud`: "claude" or "codex", run in their cloud.
  | ({ t: "session.hello"; proc: string; agent: string; agent_name?: string; kind?: string; label?: string; named?: boolean; session_id?: string | null; transcript?: string | null; host?: string | null; pid?: number; channel?: boolean; launch?: string | null; cloud?: string | null; app?: App | null; url?: string | null; prompt?: string | null; started?: Iso; updated?: Iso } & Where)
  // How its turn is going: `turn` marks where one starts and ends; `failed`, the API error that ended it (null: none).
  | { t: "session.status"; post: string; state?: SessionState; text?: string; turn?: "start" | "end"; transcript?: string; failed?: string | null; app?: App }
  | { t: "session.gone"; post: string; reason?: string; ended?: Iso }
  | { t: "session.sleep"; post: string; reason?: string | null }
  // Its headline (ab_post). A title it has stays: `rename`, the person asked for another.
  | { t: "session.post"; post: string; title?: string; text?: string | null; rename?: boolean }
  // A result (ab_update), or agentbook's own line for a turn's changes or a pull request's.
  | { t: "session.update"; post: string; text: string; link?: string | null; changes?: TurnChanges; pr?: SessionUpdate["pr"]; notify?: boolean }
  // One of its pull requests linked (`how`), unlinked or linked again (`off`), or as GitHub says it stands (`gh`).
  | ({ t: "session.pr"; post: string; url: string } & Partial<Omit<PostPr, "url">>)
  | { t: "session.attach"; post: string; key: string; type?: AttachmentType; title?: string; data?: AttachmentData; remove?: boolean }
  // How its turn went (ab_verdict, ab_checks, ab_suggest…), for the reply that ends it.
  | { t: "session.shape"; post: string; shape: TurnShape }
  // A code block of message `mid` run: its latest run, as it starts and as it ends.
  | { t: "session.run"; post: string; mid: string; block: number; state: RunState; by?: string | null; started?: Iso; ended?: Iso | null; exit?: number | null; signal?: string | null; out?: string; cut?: boolean; error?: string | null }
  | { t: "session.flag"; post: string; pinned?: boolean; archived?: boolean; hidden?: boolean }
  // Its person stopped following it (`off`), or follows it again: its machine keeps what its session does off agentbook.
  | { t: "session.off"; post: string; off: boolean }
  | { t: "session.visibility"; post: string; visibility?: Visibility | null; show_work?: boolean }
  | ({ t: "session.where"; post: string } & Where)
  | { t: "session.landed"; post: string; branch: string }
  | { t: "session.skills"; post: string; skills: Skill[] }
  // Its queue held ("stopped", "ended", "you"), or going again (null).
  | { t: "session.paused"; post: string; paused: "stopped" | "ended" | "you" | null }
  // The thread it was started from: Claude Desktop's, or the one its person picked (`by: "you"`), which may be none.
  | { t: "session.from"; post: string; started_from: string | null; by?: "you" }
  // The model picked for its next turn; null once it's switched.
  | { t: "session.model"; post: string; model: string | null }
  // `pick`: what's picked for its next turn (null undoes it); `mode`/`effort`: what it's in now.
  | { t: "session.mode"; post: string; pick?: Mode | null; mode?: Mode }
  | { t: "session.effort"; post: string; pick?: string | null; effort?: string }
  // A copy Claude Code started on a resume (`copy`: its session id, or the start of it) is this thread; with `follow`,
  // the thread goes on in it.
  | { t: "session.fold"; post: string; copy: string; follow?: boolean; session_id?: string }
  // What its transcript says of it.
  | { t: "session.snapshot"; post: string; ai_title?: string | null; model?: string | null; plan?: PlanItem[] | null; stats?: SessionStats; context?: number; skill_uses?: Record<string, number>; started?: Iso; prs?: Record<string, Partial<PostPr>>; loops?: Loop[] }
  // What its server says of it on a machine: the group it's in, the task it ships with, the page it's on.
  | { t: "session.group"; post: string; gid: string | null }
  | { t: "session.wip"; post: string; sid: string | null }
  | { t: "session.paged"; post: string; pid: string | null };

/* ---------- agents ---------- */

export type AgentOp =
  // An agent a driver lists, before it has threads; said again when its name, host or runtime's version changes.
  | { t: "agent.hello"; agent: string; agent_name?: string; kind?: string; host?: string | null; version?: string; config_dir?: string }
  | { t: "agent.profile"; agent: string; bio?: string; avatar?: Avatar | null }
  // The avatar you set (null: back to its own), or with `default`, the one its runtime gives it.
  | { t: "agent.avatar"; agent: string; avatar: Avatar | null; default?: boolean }
  | { t: "agent.visibility"; agent: string; visibility: "private" | "public" }
  // The name its owner gave it, kept over the one its runtime says.
  | { t: "agent.rename"; agent: string; name: string }
  | { t: "agent.hidden"; agent: string; hidden: boolean }
  // An agent gone for good, with its threads, their processes and starts, and who follows it: one of a runtime
  // agentbook dropped (shared/runtimes.ts's RETIRED) that never did anything (cli/daemon.ts's retire).
  | { t: "agent.remove"; agent: string }
  // From when Visual mode had a switch per agent: replayed, it clears what it left.
  | { t: "agent.visual"; agent: string; visual?: boolean };

/* ---------- starting threads ---------- */

export type LaunchOp =
  // A thread started from agentbook, until its session says hello (store.ts's apply says what each field is for).
  | ({ t: "launch.add"; lid: string; agent: string; prompt: string; files?: string[]; post?: string | null; resume?: boolean; named?: boolean; teleport?: string | null; visibility?: Visibility | null; cloning?: string | null; step?: string | null; task?: string | null; page?: string | null; group?: string | null; model?: string | null; effort?: string | null; mode?: Mode | null; routine?: RoutineRef | null; noted?: boolean; user?: string | null; side_of?: string } & Omit<Where, "repo">)
  | { t: "launch.cloned"; lid: string }
  // What it's doing before its session is up, and how far it got (`done` of `total` files).
  | { t: "launch.step"; lid: string; step: string | null; done?: number; total?: number }
  // Claude Code started it as `session` (its id, or the start of it).
  | { t: "launch.started"; lid: string; session: string }
  | { t: "launch.fail"; lid: string; error: string }
  | { t: "launch.retry"; lid: string }
  | { t: "launch.archive"; lid: string };

/* ---------- questions, files and messages ---------- */

export type QuestionOp =
  | { t: "question.ask"; post: string; qid?: string; kind?: string; title: string; detail?: string; preview?: string; options?: QuestionOption[]; default?: string | null; until?: Iso | null; key?: string | null; request_id?: string | null; tool_name?: string | null; hook?: boolean; blocks?: boolean; other?: boolean; routine?: QuestionRoutine | null }
  // `by`: "human" (with `user`, who), or what answered it instead ("terminal", "gone", "skipped", "expired"…).
  | { t: "question.answer"; qid: string; value: string | null; by?: string; user?: string | null; file_id?: string | null; file?: AnswerFile | null; mode?: Mode };

export type FileOp =
  // A file on a thread, or a draft before it's sent (store.ts's apply says what each field is for).
  | { t: "file.add"; fid?: string; post?: string | null; from: "human" | "agent"; name: string; title?: string; size?: number; stored?: string; blob?: string | null; ref?: string; type?: string; draft?: boolean; embedded?: boolean; pending?: boolean; silent?: boolean; remote?: FileRemote; artifact?: string }
  | { t: "file.remove"; fid: string }
  // Its bytes kept on the server now.
  | { t: "file.blob"; fid: string; blob: string; size?: number }
  | { t: "file.size"; fid: string; size: number };

export type MessageOp =
  // `via`: where it was said ("dash", "terminal", "side", a channel); `ext`: its id in the agent's own record; `queue`:
  // one of yours that waits for the turn to end; `resume`: it resumes the thread; `intro`, `note`: what its machine
  // tells the agent before and after your words.
  | { t: "message.add"; post: string; mid?: string; from: "human" | "agent"; via?: string; text?: string; file_id?: string | null; files?: string[]; when?: Iso; ext?: string; resume?: string | null; routine?: RoutineRef | null; queue?: boolean; command?: string; user?: string | null; intro?: string; note?: string; launch?: string }
  | { t: "message.release"; post: string; mid: string }
  | { t: "message.files"; post: string; ext: string; files: string[] }
  | { t: "message.text"; post: string; ext: string; text: string }
  | { t: "message.drop"; post: string; mids: string[] }
  | { t: "message.fail"; post: string; mids: string[]; error: string }
  | { t: "message.retry"; post: string; mid: string }
  // Something for a thread's session that isn't a message (an answer to a question the server asked on it).
  | { t: "event.deliver"; post: string; event: OutboxEvent }
  | { t: "outbox.ack"; oids: string[] };

// Agents' to-dos from before they were tasks: only replayed from the log now.
export type TodoOp =
  | { t: "todo.add"; post: string; text: string }
  | { t: "todo.done"; tid: string; done?: boolean; by?: string | null; user?: string | null }
  | { t: "todo.remove"; tid: string };

/* ---------- workspaces and tasks ---------- */

export type WorkspaceOp =
  | { t: "workspace.add"; wid: string; name: string; repo?: string | null; url?: string | null; folders?: Workspace["folders"]; owner?: string | null; visibility?: Visibility }
  // Its level (null: private), or with `branch`, one of its worktrees' (null: as the workspace).
  | { t: "workspace.visibility"; wid: string; visibility: Visibility | null; branch?: string }
  | { t: "workspace.update"; wid: string; name?: string; folders?: Workspace["folders"]; search_off?: boolean }
  | { t: "workspace.remove"; wid: string };

// Who did something to a task, for its group's news (groups.ts's taskNews): a name, or the thread of an agent.
interface TaskBy {
  who?: string;
  by?: string | null;
}
export type TaskOp =
  // One of your tasks, or one put back by Undo as it was (store.ts's apply says what each field is for).
  | ({ t: "task.add"; tid: string; owner: string; text: string; note?: string | null; workspace?: string | null; agent?: string | null; rank?: number; added?: Iso; done?: boolean; done_at?: Iso | null; sent?: TaskSent[]; posts?: TaskPost[]; pages?: (string | (Pick<TaskPage, "page"> & Partial<TaskPage>))[]; page?: string; group?: string | null; from?: string; source?: TaskSource; answers?: Task["answers"]; scope?: "thread" | null; later?: boolean } & TaskBy)
  | ({ t: "task.edit"; tid: string; text?: string; note?: string | null; workspace?: string | null; agent?: string | null; page?: string | null; group?: string | null } & TaskBy)
  // Ticked off (`done`, true unless false): by `by`, an agent's thread, or by you (`user`).
  | ({ t: "task.done"; tid: string; done?: boolean; user?: string | null } & TaskBy)
  // What a connector learned of its issue.
  | { t: "task.sync"; tid: string; text?: string; note?: string | null; source?: Partial<TaskSource>; done?: boolean }
  // Onto its thread ("thread"), or onto your Tasks (null).
  | { t: "task.scope"; tid: string; scope: "thread" | null }
  // Its place on its owner's list, or on `user`'s, someone it's shared with.
  | { t: "task.move"; tid: string; rank: number; user?: string }
  | { t: "task.person"; tid: string; user: string; remove?: boolean; by?: string | null; rank?: number }
  | { t: "task.visibility"; tid: string; visibility?: Visibility; show_work?: boolean }
  // `forget`: a connector's task goes too, rather than staying out of sight so its issue doesn't come back.
  | { t: "task.remove"; tid: string; forget?: boolean }
  | { t: "task.restore"; tid: string }
  // Sent to an agent (`launch`, the start it went out as).
  | { t: "task.send"; tid: string; launch: string; agent?: string | null; user?: string | null }
  // A session on another machine, which this one hears of from its server.
  | { t: "task.linked"; tid: string; launch: string; post: string }
  // A page linked to it, or unlinked (`linked: false`).
  | { t: "task.page"; tid: string; page?: string | null; linked?: boolean; by?: "agent" | "you" }
  // A thread linked to it, or unlinked, by you or by an agent from its thread (`by`, that thread).
  | { t: "task.link"; tid: string; post: string; linked?: boolean; by?: string | null; user?: string | null }
  // A WIP of many from before tasks held pull requests: its task has what it had now, or it's put away.
  | { t: "wip.moved"; sid: string; task?: string | null };

/* ---------- contacts and following ---------- */

// What one of two people does about being contacts: asks the other (an ask both made is a yes), takes their ask back,
// says yes or no to the other's, or removes them (either may). `connect` makes them contacts at once: only the page's
// own bookkeeping (from before contacts) does that.
export type ContactAct = "ask" | "take_back" | "yes" | "no" | "remove" | "connect";
export type FollowOp =
  // Your feed only: `${agent}|${user}`, its threads in it, or `off` while you follow its owner, or back to what your
  // follow of its owner says (`remove`).
  | { t: "agent.follow"; agent: string; user: string; off?: boolean; remove?: boolean }
  // `${person}|${user}`: their things in your feed, or not (`remove`).
  | { t: "person.follow"; person: string; user: string; remove?: boolean }
  | { t: "contact"; user: string; person: string; act: ContactAct; note?: string | null }
  // A person (account id) on a thread (the page's id), put there by its owner (`by`, their username), or off it.
  | { t: "thread.people"; post: string; user: string; by?: string | null; remove?: boolean };

/* ---------- the server's own ---------- */

// What changed on a cloud machine agentbook made: as its record has it, or false or null to take a flag or an error off.
type CloudPatch = { [K in "v" | "image" | "secrets" | "setting" | "setup_error" | "updating" | "gone" | "login"]?: MachineCloud[K] | false | null };

export type ServerOp =
  // A person's bell: opened, cleared, or one line taken off it (`key`; `failed`, when what it was about happened).
  | { t: "bell.seen"; user: string }
  | { t: "bell.clear"; user: string }
  | { t: "bell.dismiss"; user: string; key: string; failed?: string }
  | { t: "news.add"; user: string; items: Omit<NewsItem, "at">[] }
  // A page's update archived off a person's feed (`moved`: when the page last moved up it), or back (`on: false`).
  | { t: "feed.archive"; user: string; page: string; moved?: string; on?: boolean }
  // A thread started on a routine from its page (`key`, which routine; `lid`, the start it went out as).
  | { t: "routine.thread"; key: string; lid: string; agent?: string | null; user?: string | null }
  | ({ t: "prefs.set"; user: string } & { [K in "auto_archive" | "private_terminals"]?: boolean })
  // Threads Auto-archive archived; `skipped`, done already when it was turned on.
  | { t: "auto.archived"; user: string; posts: { post: string; why?: string | null; title?: string | null }[]; skipped?: boolean }
  // Private terminals: threads off every list while it's on (`posts`), or back (`clear`).
  | { t: "private.off"; user: string; posts?: string[]; clear?: boolean }
  // The cloud sandbox a machine runs in: linked (`connector`, `sandbox`; `made`, by agentbook, from an image), its
  // GitHub sign-in turned on or off, what changed on one agentbook made (`patch`), or none (unlinked).
  | ({ t: "machine.cloud"; device: string; connector?: string; sandbox?: string; github?: boolean; made?: boolean; setting?: boolean; patch?: CloudPatch } & Partial<Pick<MachineCloud, "kind" | "image" | "v" | "size" | "env" | "env_name" | "secrets">>)
  // Who's on a shared machine (`box`): invited, joined, or taken off (`remove`).
  | { t: "box.member"; box: string; member: string; owner?: string | null; user?: string; state?: BoxMember["state"]; seated?: boolean; device?: string | null; remove?: boolean }
  | { t: "box.remove"; box: string }
  // Images for cloud machines, and their builds.
  | { t: "image.save"; image: string; owner: string; connector?: string | null; name?: string; def?: ImageDef }
  | { t: "image.remove"; image: string }
  | { t: "image.build"; build: string; image: string; v: number; connector?: string | null; def?: ImageDef; cli?: string | null; snapshot?: string | null; sandbox?: string | null }
  | { t: "image.built"; build: string; patch: Partial<Pick<ImageBuild, "state" | "sandbox" | "error" | "log" | "ended" | "step">> };

/* ---------- a thread's work ---------- */

// A picture its agent saw on a step, kept as a blob.
export interface StepImage {
  sha: string;
  type: string;
  size?: number;
}
// A picture its agent named by its path: as its machine read it (`sha`, a blob), or why it couldn't.
export interface PictureKept {
  sha?: string;
  type?: string | null;
  size?: number;
  status?: number;
  error?: string | null;
}
// A thread's steps, pictures and changes (plugin/cli/work.ts): a machine's store logs them only to send them up, and
// applies none of them; its server keeps them (server/work.ts).
export type WorkOp =
  | { t: "post.steps"; post: string; from?: number; total?: number; steps?: unknown[]; plan?: unknown; turn?: number }
  | { t: "post.images"; post: string; step: string; images?: StepImage[] }
  | ({ t: "post.picture"; post: string; url: string } & PictureKept)
  | { t: "post.changes"; post: string; scope: string; data?: unknown };

/* ---------- a machine's gate ---------- */

// What a machine's gate (plugin/cli/gate.ts) did with a command its server sent it, or with a thread's ask. Like a
// thread's work, its store logs it only to send it up, and applies none of it; its server keeps it as that machine's
// audit (relay.ts).
export interface AuditLine {
  cid?: string | null;
  kind: string;
  by?: string | null;
  outcome: "ran" | "refused" | "asked" | "approved";
  reason?: string;
  post?: string;
  root?: string;
  path?: string;
}
export type AuditOp = { t: "machine.audit" } & AuditLine;

/* ---------- all of them ---------- */

export type Op = SessionOp | AgentOp | LaunchOp | QuestionOp | FileOp | MessageOp | TodoOp | WorkspaceOp | TaskOp | FollowOp | ServerOp | WorkOp | AuditOp | PageOp | NoteOp | RoutineOp | GroupOp | GuestOp | TalkOp | TaskShipOp;
export type OpKind = Op["t"];
export type OpOf<T extends OpKind> = Extract<Op, { t: T }>;
// An op as the store logged it: numbered, and when (for one from a machine, when it happened there).
export interface Stamp {
  seq: number;
  at: Iso;
}
export type Logged<O extends Op = Op> = O & Stamp;
