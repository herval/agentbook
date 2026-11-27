// What a runtime is to agentbook-cli: an adapter for one agent framework (Claude Code, Codex,
// OpenClaw, Hermes, dsh, Antigravity, Claude Agent, Devin, and Claude Code's and Codex's clouds) that knows that framework and
// nothing of agentbook's store. It says what happened as events (RuntimeContext.emit), and the threads core
// (threads.ts) turns them into ops; it does what the core asks (start, send, answer, interrupt) and answers what the
// daemon reads (a thread's steps, its workers, its files). What only some runtimes do is a facet: an object when it
// can, absent when it can't. What every runtime's threads can do, for the server and the page too, is its entry in
// plugin/shared/runtimes.ts. Types only, which Node strips: nothing here runs.

import type { AnswerEvent, AnswerFile, FileEvent, FileRemote, Launch, OutboxEntry, RoutineRef, OutboxEvent, PermissionEvent, Session, State } from "../../shared/types.ts";
import type { Op, OpOf } from "../../shared/ops.ts";
import type { Mode, RuntimeId, RuntimeInfo } from "../../shared/runtimes.ts";
import type { Digest, Live, Summary } from "./kit/steps.ts";
import type { Worker } from "../workers.ts";

export type { RuntimeId, RuntimeInfo, RuntimeCaps } from "../../shared/runtimes.ts";

/* ---------- what the daemon hands a runtime ---------- */

// One JSON-RPC message to agentbook's MCP server (mcp.ts's handle), and who it's from: the post (`proc`), the folder
// its relative paths are in (`cwd`), and its machine's files when it isn't this one (`disk`).
export interface McpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}
export interface McpWho {
  proc: string;
  cwd?: string | null;
  disk?: {
    home: string;
    stat(p: string): Promise<{ size: number } | null>;
    read(p: string): Promise<Buffer>;
  };
}
// Its answer: a result (its instructions and tools, or what a tool said), or an error.
export interface McpReply {
  jsonrpc: string;
  id: unknown;
  result?: {
    instructions?: string;
    tools?: { name: string; description?: string; inputSchema?: unknown }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: unknown };
}

// What agentbook-cli hands each runtime as it connects: its state to read, the core to tell what happened (`emit`),
// and what of agentbook a runtime uses. It has no way to commit an op: what a thread gets goes through the core.
export interface RuntimeContext {
  // This machine's name, for what a runtime says can only be fixed here.
  machine: string;
  // Read only.
  state: State;
  // Something happened: the core makes it ops. What it made, when it made one: an ask's op names its question
  // (`qid`), a file's its file (`fid`).
  emit(e: RuntimeEvent): { seq: number; qid?: string; fid?: string } | undefined;
  // A message this runtime is about to be sent, so its echo (the same words, as its own app shows them) isn't shown
  // twice. The core says it for what it delivers; a runtime says it for what it starts a thread with.
  echo(thread: string, text: string): void;
  // Whether a message from you that it's about to say is the echo of one agentbook sent it, which is then forgotten:
  // for a runtime that does something with a message before it says it (OpenClaw makes its files first). The core
  // asks the same of each `message` it's told, so a runtime that has nothing to do first needn't ask.
  echoed(thread: string, text: string): boolean;
  // Whether a session of theirs is kept off agentbook (Private terminals): it has no post, and gets none for now.
  keptOff(id: string): boolean;
  // What's queued for a post, and the core's delivery of it (deliverer.ts): a runtime calls it when it can take
  // what was held (its connection back, its turn over).
  pending(post: string): OutboxEntry[];
  deliver(post: string): void;
  // A post's bird name, from its key.
  label(key: string): string;
  describe(event: OutboxEvent): string;
  attached(files: AnswerFile[] | undefined): string;
  gitInfo(cwd: string): { root: string; repo: string; branch: string };
  // Fetch a file it keeps elsewhere now, and again the ones that stopped coming, once it's connected again.
  fetchFile(fid: string): void;
  refetch(): void;
  // What a session it starts is told about agentbook.
  context(q: { post?: string; launch?: string; cwd?: string; background?: boolean }): Promise<string>;
  // What changed in a thread's group since it last heard, or null (or a promise of it: those who hear it wait for it).
  news?(id: string): Promise<string | null> | string | null;
  // agentbook's MCP server for a post (`proc`), with paths relative to `cwd`.
  mcp(proc: string, cwd: string, opts?: { bridged?: boolean }): { url: string };
  // The same tools for every thread of an agent, wherever it was started.
  mcpForAll(agent: string): { url: string };
  // Whether its person agreed to Codex's threads getting agentbook's tools.
  codexTools(): boolean;
  // From when its server keeps history (ms).
  historyFrom(): number;
  // Since when its sessions from before come in (ms, 0: all of them): as its person picked on the welcome card
  // (history.ts), with no window of its own then; else its own window of `days` (0: none), never before historyFrom.
  pastSince?(kind: string, days: number): number;
  // Whether a session from before the pick, last active at `at` (ms), stays out: in a folder its person left out.
  pastOut?(kind: string, cwd: string | null | undefined, at: number): boolean;
  // The same server, here: one JSON-RPC message, answered as the post `who` says (mcp.ts's handle).
  mcpCall(msg: McpRequest, who: McpWho): Promise<McpReply | null>;
  // Bytes kept on the server: their sha256, or null while it can't be reached.
  blobPut(buf: Buffer, type?: string): Promise<string | null>;
  // Whether its server is elsewhere than this machine.
  hosted?(): boolean;
  log(line: string): void;
}

/* ---------- what a runtime says ---------- */

type HelloOp = OpOf<"session.hello">;
type AskOp = OpOf<"question.ask">;

// The ops a runtime hands on as they are: facts about a thread the core has no rule for.
export type FactOp = OpOf<"session.snapshot" | "session.post" | "session.attach" | "session.skills" | "session.pr" | "session.model" | "session.mode" | "session.effort" | "session.status" | "message.text" | "message.files" | "message.drop" | "file.add" | "agent.avatar" | "question.answer">;

export type RuntimeEvent =
  // An agent it runs, as it is now: said again when its name, host or version changes (the core drops what's the same).
  | { e: "agent"; agent: string; name: string; kind?: string; host?: string | null; version?: string }
  // A thread, seen (one started elsewhere), started, or back (a revived one). The core names it, fills in its proc,
  // kind, host and git facts, and keeps a Private terminals' one off. `thread` is its id here (its post's).
  | ({ e: "thread"; thread: string } & Partial<Omit<HelloOp, "t" | "session_id">>)
  // Its turn began: a thread that was done is back first.
  | { e: "turn.start"; thread: string; text?: string }
  // Its turn ended: its state (idle, or waiting on you), what it's on, the error that ended it. Prompts still open on
  // it were settled in its own app, so they close; what was held for it goes.
  | { e: "turn.end"; thread: string; state?: "idle" | "waiting"; text?: string; failed?: string | null }
  // A message on it, from you (typed in its own app) or from it. One from you that's an echo of what agentbook
  // sent it is dropped (`echo`, unless the runtime said it dedupes them itself).
  | ({ e: "message"; thread: string } & Omit<OpOf<"message.add">, "t" | "post">)
  // It says it can't go on: "<name> stopped: <why>", on the thread (its voice's name, else its info's). `mid` and
  // `when`: the id it has in the runtime's own record of the thread and when it was said there, for one read from its
  // history, so reading it again doesn't say it twice.
  | { e: "failed"; thread: string; why: string; mid?: string; when?: string }
  // It asks: a permission prompt or a question.
  | ({ e: "ask"; thread: string } & Omit<AskOp, "t" | "post">)
  // Its steps, plan or workers moved: the page hears, and with `save`, its snapshot is kept and its work sent.
  | { e: "changed"; thread?: string; save?: boolean }
  // It's over: ended, deleted, or gone from where it ran.
  | { e: "gone"; thread: string; reason?: string; ended?: string }
  // A fact, handed on as its op.
  | { e: "fact"; op: FactOp };

/* ---------- what it's asked to do ---------- */

// A file you attached, handed to a runtime that's sent files rather than their paths here (caps.attach "upload").
export interface SentFile {
  id?: string;
  name: string;
  size: number;
  path: string;
}

// What starts a thread: its first prompt, and what its thread shows of it (`shown`) when that isn't all of it.
// `lid`: the launch it starts for. `dirs`: folders it can write besides its own (its group's). `mode`: how much it
// may do without asking, one of its caps' modes; none
// leaves it to its agent's own default. `title`: what its thread is called as it starts (its routine's name, for a
// run of one, else the first line of what you wrote), for a runtime whose own app lists sessions by a name it's given.
export interface StartRequest {
  agent?: string;
  cwd?: string;
  prompt: string;
  shown?: string;
  title?: string;
  files?: SentFile[];
  lid: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  dirs?: string[];
  repo?: string;
}

// A side thread off thread `id` (its session id): a copy of it that goes on with `prompt`, in the thread's mode.
export interface SideRequest {
  id: string;
  cwd?: string;
  prompt: string;
  shown?: string;
  lid: string;
  effort?: string;
  mode?: Mode;
  dirs?: string[];
}

// What the core's delivery hands `send`: the files to go with it (caps.attach "upload"), a slash command typed as
// one, and whether all of it is its owner's own words (no group news riding along), which a runtime may send with more
// than it sends anything else (OpenClaw's admin).
export interface SendOpts {
  command?: string;
  owner: boolean;
}

/* ---------- what it says back ---------- */

// The models a thread of it can run on, and the one it starts on.
export interface Models {
  list: { id: string; name?: string; efforts?: string[]; effort?: string | null }[];
  default?: string | null;
  efforts?: string[];
  effort?: string | null;
}

// How it's doing on this machine: on or off (AGENTBOOK_<NAME>=0), connected to what it drives, and why not.
export interface Health {
  enabled: boolean;
  connected?: boolean;
  error?: string | null;
  [more: string]: unknown;
}

// How an agent of it is reached, as its agent page shows it.
export interface Link {
  state: string;
  connected?: boolean;
  error?: string | null;
  since?: string | null;
}

// A file (or folder) it opened: where it is (`root`, the folder it's in or the workspace it's from, and `path`), and
// what's in it: its text, its bytes, or, a folder's, its entries.
export interface RuntimeFile {
  root: string;
  path: string;
  name: string;
  size?: number;
  modified?: string | null;
  text?: string;
  bytes?: Buffer;
  entries?: unknown[];
  truncated?: boolean;
}

// What a runtime that runs on someone's API is connected with: its key, and what goes with it (setup.form's fields).
export interface SetupValues {
  disconnect?: boolean;
  key?: string;
  org?: string;
  github_token?: string;
  budget?: number | null;
}
// A slash command a thread can run: its name (without the slash), what it takes (`hint`, and `takes`: "req" for an
// argument it needs, "opt" for one it may have), and where it's from (built in, a skill's, a plugin's).
export interface SlashCommand {
  name: string;
  hint: string;
  description: string;
  takes: "" | "opt" | "req";
  from?: "built-in" | "skill" | "plugin";
}
// The slash commands a thread can run here, and those it can't (`off`), each with why.
export interface SlashCommands {
  list: SlashCommand[];
  off: { name: string; why: string }[];
}

// A piece of a file it serves a piece at a time (`range`), or one it can stop sending (`signal`).
export interface MediaOpts {
  range?: string | null;
  signal?: AbortSignal;
}

/* ---------- the runtime ---------- */

// A session of its own from before agentbook followed it, for the welcome card (plugin/cli/history.ts): its id (the
// thread it becomes is keyed by it), when it was last active (ms), and its folder.
export interface PastSession {
  id: string;
  at: number;
  cwd?: string | null;
}

export interface Runtime {
  id: RuntimeId;
  // Its entry in plugin/shared/runtimes.ts: its name, its threads' procs, its caps.
  info: RuntimeInfo;
  // Whether an agent is one it runs.
  owns(agent: string): boolean;
  // Start: spawn, connect, poll. What it says goes to ctx.emit.
  connect(ctx: RuntimeContext): void;
  // agentbook's server is connected again.
  online?(): void;
  health(): Health;
  // Provider changes are made only between turns; cached ACP children must read the new environment.
  providerChanged?(): Promise<void>;
  // How it dedupes the echoes of what it's sent: by their words, in the core ("text"), or itself ("self").
  echoes: "text" | "self";
  // The name it says things on its threads as ("DeepSeek stopped: …", "couldn't reach DeepSeek"), when that isn't its
  // info's: dsh's agent is DeepSeek, its runtime DeepSeek Harness.
  voice?: string;

  /* Threads: the core decides when, the runtime does. */
  start(req: StartRequest): Promise<unknown>;
  // A message (and its files), as the core's delivery makes it of what's queued.
  send(thread: string, text: string, files: (AnswerFile | FileEvent)[], opts: SendOpts): Promise<unknown>;
  // Allow/Deny or an answer to what it asked: true when it took it (else it goes as words).
  answer(thread: string, e: PermissionEvent | AnswerEvent): Promise<boolean> | boolean;
  // Whether a queued event answers something it's waiting on, which goes even while a slash command waits.
  awaits?(thread: string, e: OutboxEvent): boolean;
  // Whether only answers go to a thread now, the rest of its queue waiting until the runtime delivers again
  // (ctx.deliver): while its turn runs, for one that takes one prompt at a time (caps.delivery.midTurn "hold"), or
  // while it can't be reached, or while it switches models as it's woken (Claude Code's in the background). The turn's
  // end delivers what was held.
  holds?(thread: string): boolean;
  // Its own delivery, instead of the core's (Claude Code's: channels, hooks, waking).
  deliver?(thread: string): unknown;
  interrupt(thread: string): Promise<unknown>;
  read(thread: string): Promise<Digest | null>;
  live(s: Session): Live | null;
  summary(s: Session): Summary | null;
  working(thread: string): boolean;
  syncing?(thread: string): boolean;
  // Why a message can't be sent to the thread, or null.
  blocked(s: Session): string | null;
  // The command that opens the thread in a terminal, or null.
  resumeCommand(s: Session): string | null;

  /* What only some do. */
  // Its sessions from before (the welcome card's), and bringing the ones its person picked in as ended threads,
  // newest first. `agent`: the agent they go to; `keeps`: how many days its app keeps them.
  // `picked`: its person picked, whatever they picked (Codex's tools go in then, when they said yes to them).
  past?: { list(): Promise<PastSession[]>; bring?(ids: string[]): Promise<void>; agent?(): string; keeps?(): number | null; picked?(): void };
  // A side thread (a fork of this one), and why a thread can't have one, or null.
  fork?: { side(req: SideRequest): Promise<{ id: string }>; refuse?(s: Session): string | null };
  // Its agents' models, and why a thread's model can't be switched from here, or null.
  models?: { list(agent?: string): Models | null; refuse?(s: Session): string | null };
  // Switching a thread's effort or mode once it runs (caps.efforts, caps.switchesMode): why it can't now, or null; for
  // one that switches a live session's mode at once ("now"), how, or "next" when this one waits for its next turn
  // (caps.fullApart), which it takes up then; and whether Allow + Auto switches it with the answer itself
  // (`withAllow`: Claude Code's hook answers its prompts, and can set its mode as it does).
  switches?: { refuse?(s: Session, what: "effort" | "mode"): string | null; mode?(s: Session, mode: Mode): Promise<void | "next">; withAllow?: boolean };
  // Its slash commands: whether a thread takes one from here now (or why not: it's open in a "terminal", or its
  // "agent" doesn't), the list, and a command run as a call of its own.
  commands?: { ready?(s: Session): Promise<true | "terminal" | "agent"> | true | "terminal" | "agent"; list(s: Session): Promise<SlashCommands>; run?(thread: string, text: string, command: string): Promise<unknown> };
  // Its workers, and one's steps when it keeps them apart from the list's.
  workers?: { list(thread: string): Worker[]; steps?(thread: string, worker: string): Promise<unknown> };
  files?: {
    // A file a thread names, when it's read through the runtime (its files aren't on this disk).
    read?(s: Session, p: string): Promise<RuntimeFile>;
    // The pictures on this disk its agent saw (a screenshot it took, a picture it read).
    pictures?(s: Session): string[];
    streams?(): boolean;
    stream?(s: Session, p: string, opts?: MediaOpts): Promise<Response>;
    media?(s: Session, ref: FileRemote, opts?: MediaOpts): Promise<Response>;
    streamMedia?(s: Session, ref: FileRemote, opts?: MediaOpts): Promise<Response>;
    // The pictures a step's result held: [{ type, data }], data in base64.
    images?(s: Session, step: string): Promise<{ type: string; data: string }[]>;
  };
  workspace?: {
    of(agent: string): unknown;
    list(agent: string, dir?: string): Promise<Record<string, unknown> | null>;
    read(agent: string, p: string): Promise<RuntimeFile>;
    stream?(agent: string, p: string, opts?: MediaOpts): Promise<Response>;
    skillFile?(agent: string, file: string): Promise<string | null>;
  };
  routines?: {
    // Where they are, when that isn't the runtime (Claude's, on claude.ai): its errors say so.
    where?: string;
    of(agent: string): unknown;
    list(agent: string): Promise<unknown>;
    get(agent: string, job: string, opts?: { offset?: number }): Promise<unknown>;
    run?(agent: string, job: string, session: string): Promise<unknown>;
    act?(agent: string, job: string, action: string): Promise<unknown>;
    loops?(s: Session): unknown;
  };
  limits?: { read(agent: string): Promise<unknown> | null };
  // Where its agents run, when that's not this machine ("cloud", the gateway's), and how they're reached.
  remote?: { machine(): string; link(): Link };
  // What connects it (Settings → Agents, whose form is its info's `setup`): saving what was typed there, and what it's
  // connected with now (never a secret); OpenClaw's pairing, whose screen is its own (`admin`: asking its gateway for
  // admin).
  setup?: { configure(values: unknown): unknown; connection(): unknown; admin?(): Promise<unknown> };
  // Its row on Add agents: whether agentbook found it here, and what it says of it.
  row?(): RuntimeRow;
  // Its app updated here (caps.updates, runtime-update.ts): the npm package whose dist-tag (`tag`, "latest" unless it
  // follows another channel) names the newest version, whichever way the app was installed, or, for an app that isn't
  // on npm, the newest version as the app itself says it (`newest`, Grok's `grok update --check`); the version its
  // threads run on now; why it can't update now (a running turn the update would cut off), or null; and the update, as
  // its own update command does it, which says what it prints and reads the version again once it's done.
  update?: {
    pkg?: string;
    tag?(): string;
    newest?(): Promise<string>;
    version(): string | null;
    wait?(): string | null;
    run(output: (text: string) => void, signal: AbortSignal): Promise<void>;
  };
  // The thread a session of it is on: a subagent's is its parent's.
  threadOf?(session: string): string;
  // A WebSocket from its own app (dsh's plugin, at /api/dsh/ws).
  socket?(ws: unknown): void;

  /* A thread's life between turns, for a runtime that has more of it than a turn (Claude Code's). */
  // An ended thread taken up again with what you sent, as its next prompt, instead of it being queued.
  resume?(s: Session, msg: ResumeRequest): Promise<Record<string, unknown>>;
  // A start the server sent again: the session it started the first time, once that's found, or null to start it now.
  startedAgain?(l: Launch, prompt: string): Promise<string | null>;
  // What it has going between its turns that it lists itself (a background shell, a monitor, a subagent), and
  // whether it has any this moment, as it says now (its list is a refresh old).
  going?(s: Session): Going[];
  goingNow?(s: Session): boolean;
  // How what you sent reaches a thread idle with nothing to take it ({ nudged: true }, or { stuck: where }), or {}
  // when it will by itself.
  reach?(s: Session): Promise<Record<string, unknown>>;
  // Stopped harder than interrupt (caps.forceStop): its process ended, its thread kept.
  forceStop?(s: Session): Promise<{ error?: string; status?: number; [k: string]: unknown }>;
  // Put to sleep (archived): whether it is now.
  sleep?(s: Session, why: string): Promise<boolean>;
  // The closing words a session's own reply left out (its suggested replies, in Claude Desktop), for its last message.
  wrapUp?(s: Session): { replies: string[]; ask?: string | null } | null;
}

// What resumes an ended thread: what you wrote, its files, and what goes with it.
export interface ResumeRequest {
  text: string;
  files: string[];
  // What the pages and widgets it names showed; the routine or the slash command it's for.
  note?: string | null;
  routine?: RoutineRef | null;
  command?: string | null;
}

// Something a thread has going between its turns, as its runtime lists it.
export interface Going {
  id: string;
  kind?: string;
  title?: string;
  started?: string | number | null;
  // The worker it is (workers.ts), or whether what it printed can be read here.
  worker?: string;
  out?: boolean;
}

// A runtime's row on Add agents.
export interface RuntimeRow {
  ok: boolean;
  status: string;
  detail: string;
  [more: string]: unknown;
}

// A logged op, as emit hands back what it made.
export type Made = { seq: number } & Op;
