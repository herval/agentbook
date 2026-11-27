// What Claude Code's adapter gets from agentbook-cli (daemon.ts): its state and store, Claude Code's supervisor and
// transcripts, and the helpers its machinery shares with the rest of the machine. Claude Code talks to agentbook
// through its hooks and the plugin's tools, and is started, woken and resumed under its own supervisor
// (`claude agents`, drivers/claude.ts), so its adapter does more of agentbook-cli's work than the others do, and
// reaches more of it.

import type { IncomingMessage, ServerResponse } from "node:http";
import { runtimeOfThread } from "../../../shared/runtimes.ts";
import type { createStore } from "../../../shared/store.ts";
import type { Logged, OpKind, OpOf } from "../../../shared/ops.ts";
import type { OutboxEntry, Session, State } from "../../../shared/types.ts";
import type { createClaude } from "../../drivers/claude.ts";
import type { createPidWatch } from "../../pid-watch.ts";
import type { createTranscripts } from "../../transcript.ts";

// One of Claude Code's own threads on this machine that agentbook follows: not another runtime's, nor one in a cloud,
// nor one its person stopped following (`off`), whose session it leaves alone (no transcript read, no pickup, no sleep).
export const mine = (s: { proc?: string | null; cloud?: string | null; off?: string | null } | null | undefined): boolean => !!s && !s.off && runtimeOfThread(s) === "claude-code";

export type Req = IncomingMessage & { signed?: unknown };
export type Res = ServerResponse;
export type Route = (method: string, pattern: string, handler: (req: Req, res: Res, m: { params: Record<string, string>; query: URLSearchParams }) => unknown) => void;

export interface ClaudeHost {
  machine: string;
  state: State;
  store: ReturnType<typeof createStore>;
  commit: <T extends OpKind>(op: OpOf<T>) => Logged<OpOf<T>> | undefined;
  log: (...a: unknown[]) => void;
  claude: ReturnType<typeof createClaude>;
  transcripts: ReturnType<typeof createTranscripts>;
  pids: ReturnType<typeof createPidWatch>;
  // Whether agentbook-cli is logged in to its server and running; its link to that server, once there is one.
  started: () => boolean;
  uplink: () => { status(): { signed_out?: boolean }; tryAgain(): Promise<unknown> } | null;
  // Something the page shows changed.
  pageChanged: () => void;
  // A thread's work (work.ts): its steps and what it changed go up.
  work: { touch(post: string, o?: { changes?: boolean; now?: boolean }): void };
  // What its transcript says, saved now and then (saveSnapshot), and the threads whose latest snapshot waits.
  saveSnapshot: (s: Session, now?: boolean) => void;
  unsaved: Set<string>;
  // When what each thread changed was last worked out while it worked.
  changesSent: Map<string, number>;
  // A thread's queue, its turn ending on Stop, and its prompts settled.
  queueOf: (post: string) => State["messages"];
  turnStopped: (post: string) => void;
  settlePermissions: (post: string, by: string) => void;
  // What couldn't reach a thread, and the prompt that carries what can.
  undelivered: (post: string, events: OutboxEntry[], why: string) => void;
  promptFor: (events: OutboxEntry[]) => string;
  // How long a thread's delivery waits for its turn's end.
  holdMs: (post: string) => number;
  // Where a thread resumes, its group's folder, and what changed in its group since it last heard.
  resumeDir: (s: Session) => string;
  extraDirs: (s: Session) => string[];
  groupNews: (post: string) => Promise<string | null>;
  // Starts: a new launch's id, whether a resume is on its way, and how long one may take.
  launchId: () => string;
  resuming: (s: Session) => boolean;
  RESUME_WAIT_MS: number;
  // Private terminals: what a session agentbook didn't start is told, and how it's kept off.
  KEPT_OFF: string;
  // What a session hears of a thread its person stopped following, and whether a hello is one.
  OFF: string;
  keptOff: Set<unknown>;
  keepOff: (op: OpOf<"session.hello">) => void;
  offHello: (op: OpOf<"session.hello">) => boolean;
  startedElsewhere: (op: OpOf<"session.hello">) => boolean;
  launchInFlight: () => boolean;
  // What its threads hear when the server stopped taking this machine's login, and who heard it.
  loginLost: () => string | null;
  toldLoginLost: Set<unknown>;
  // The routes' helpers (daemon.ts): its post by a hook's proc, a request's body and the answers.
  postOf: (res: Res, proc: string) => string | null;
  readBody: (req: Req) => Promise<Record<string, any>>;
  ok: (res: Res, body?: unknown) => void;
  fail: (res: Res, status: number, error: string, extra?: Record<string, unknown>) => void;
  str: (v: unknown, max?: number) => string;
  slug: (name: unknown) => string;
  heard: (proc: string, withKey: boolean) => void;
  localKeyOk: (req: Req) => boolean;
  updateNote: (o?: { session?: boolean }) => Record<string, unknown>;
}

