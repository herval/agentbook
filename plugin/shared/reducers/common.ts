import type { Iso, OutboxEvent, Session, State, Task } from "../types.ts";

// What a reducer needs from createStore besides the state and op: the op's timestamp and sequence number, whether
// this store keeps an outbox, how to page a thread's history back into memory, and where stored files live on disk.
export interface ApplyContext {
  now: Iso;
  seq: number;
  outbox: boolean;
  warm: (post: string | null | undefined, at?: number) => void;
  filePath: (stored: string) => string;
}

export const opId = (ctx: Pick<ApplyContext, "seq">, prefix: string): string => `${prefix}${ctx.seq}`;

export const touch = (s: Session, now: Iso): void => {
  s.updated = s.updated && s.updated > now ? s.updated : now;
  s.rev = (s.rev || 0) + 1;
};

// An archived thread you write on (a comment, a prompt in its terminal, a message from Discord or Telegram, an
// answer) is going again, so it comes back to the feed, or to Hidden if you hid it. Not for what was said
// before you archived it and copied in since, nor for a cron job's run, which nobody wrote: you archived a job's
// thread to stop seeing it.
export const unarchive = (post: Session | null | undefined, at: Iso): void => {
  if (post?.archived && !(at < post.archived_at)) Object.assign(post, { archived: false, archived_at: null });
};

// Ticking a task or a to-do, or unticking it. `done_by` says who: "you", or "agent" when an agent ticked it
// from its post (`by`, its key, which is `done_post`). A connector's sync says "sync" (task.sync).
// Ticked, by an agent from its post (`by`) or by a person (`user`: their account's id, on a task shared with them, so
// its page says who did).
export const tick = (op: { done?: boolean; by?: string | null; user?: string | null }, now: Iso): Pick<Task, "done" | "done_at" | "done_by" | "done_post" | "done_user"> =>
  op.done !== false ? { done: true, done_at: now, done_by: op.by ? "agent" : "you", done_post: op.by || null, done_user: op.user || null } : { done: false, done_at: null, done_by: null, done_post: null, done_user: null };

// `mid`: the message it is, for one of yours that may not get there (message.fail). `held`: one that waits in
// its post's queue for its turn to end (message.release).
export const deliver = (state: State, ctx: ApplyContext, post: string, event: OutboxEvent, mid: string | null = null, held = false): void => {
  if (ctx.outbox) state.outbox.push({ oid: opId(ctx, "o"), post, event, at: ctx.now, delivered: false, ...(mid ? { mid } : {}), ...(held ? { held: true } : {}) });
};

// A post whose queue is empty again isn't paused: what you queue next goes when its turn ends.
export const unpause = (state: State, pid: string | null | undefined): void => {
  const post = pid && state.sessions[pid];
  if (post?.queue_paused && !state.messages.some((m) => m.post === pid && m.queued)) delete post.queue_paused;
};
