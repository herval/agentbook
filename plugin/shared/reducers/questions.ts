// Questions, legacy to-dos, and files reducers (store.ts).

import { applyRoutine } from "../routines.ts";
import type { FileOp, QuestionOp, TodoOp } from "../ops.ts";
import type { State } from "../types.ts";
import { deliver, opId, tick, touch, unarchive } from "./common.ts";
import type { ApplyContext } from "./common.ts";

export function applyQuestion(state: State, op: QuestionOp, ctx: ApplyContext): void {
  const { now } = ctx;
  switch (op.t) {
    case "question.ask": {
      const post = state.sessions[op.post];
      if (!post) break;
      // Asking again with the same key replaces the open question.
      if (op.key) for (const q of state.questions) if (q.post === op.post && q.key === op.key && !q.answered) Object.assign(q, { answered: now, value: null, by: "replaced" });
      state.questions.push({
        id: op.qid || opId(ctx, "q"),
        post: op.post,
        kind: op.kind || "choice",
        title: op.title,
        detail: op.detail || "",
        preview: op.preview || "",
        options: op.options || [],
        default: op.default ?? null,
        until: op.until || null,
        key: op.key || null,
        request_id: op.request_id || null,
        tool_name: op.tool_name || null,
        hook: !!op.hook, // a hook waits for the answer itself (Claude's AskUserQuestion in a background session)
        blocks: !!op.blocks, // its turn can't go on without the answer (Codex's and OpenClaw's questions)
        other: !!op.other, // takes an answer of your own besides its options
        routine: op.routine || null, // the OK for a page routine's version: { rid, v, yes } (routines.ts)
        asked: now,
        answered: null,
        value: null,
        by: null,
      });
      touch(post, now);
      break;
    }
    case "question.answer": {
      const q = state.questions.find((x) => x.id === op.qid);
      if (!q || q.answered) break;
      Object.assign(q, { answered: now, value: op.value, by: op.by || "human", file_id: op.file_id || null, file: op.file || null, ...(op.mode ? { mode: op.mode } : {}) });
      if (q.by === "human") unarchive(state.sessions[q.post], now);
      // The OK for a routine's version: its first option uses it, the other keeps the one that runs.
      if (q.routine && op.by === "human") applyRoutine(state, { t: "routine.ok", rid: q.routine.rid, v: q.routine.v, use: op.value === q.routine.yes, by: { user: op.user || null } }, now);
      if (q.hook || op.by === "expired") {
        // The hook that asked takes the answer from here; nothing to send.
      } else if (q.kind === "permission") {
        if (op.by !== "terminal" && op.value) deliver(state, ctx, q.post, { type: "permission", request_id: q.request_id, behavior: op.value === "allow" ? "allow" : "deny" });
      } else if (op.by !== "terminal" && op.by !== "gone") {
        deliver(state, ctx, q.post, { type: "answer", question_id: q.id, key: q.key, question: q.title, value: op.value, by: q.by, skipped: op.by === "skipped" || op.by === "archived", file: op.file || null });
      }
      const s = state.sessions[q.post];
      // Its last open question answered, a session that was waiting on you carries on.
      if (s?.state === "waiting" && op.by !== "expired" && !state.questions.some((x) => x.post === q.post && !x.answered)) Object.assign(s, { state: s.busy ? "working" : "idle", doing: s.busy ? "Carrying on" : s.doing });
      if (s) touch(s, now);
      break;
    }
  }
}

// Agents' to-dos from before they were tasks: replayed from the log, then moved (moveTodos in cli/daemon.ts).
export function applyTodo(state: State, op: TodoOp, ctx: ApplyContext): void {
  const { now } = ctx;
  switch (op.t) {
    case "todo.add": {
      const post = state.sessions[op.post];
      if (!post) break;
      state.todos.push({ id: opId(ctx, "t"), post: op.post, text: op.text, at: now, done: false, done_at: null });
      touch(post, now);
      break;
    }
    case "todo.done": {
      const t = state.todos.find((x) => x.id === op.tid);
      if (!t) break;
      Object.assign(t, tick(op, now));
      if (state.sessions[t.post]) touch(state.sessions[t.post], now);
      break;
    }
    case "todo.remove": {
      state.todos = state.todos.filter((t) => t.id !== op.tid);
      break;
    }
  }
}

export function applyFile(state: State, op: FileOp, ctx: ApplyContext): void {
  const { now } = ctx;
  switch (op.t) {
    case "file.add": {
      // `remote`: where a driver fetches it from when it's first opened (a picture in an OpenClaw message).
      // `blob`: its bytes on the server (sha256); `ref`: the upload it came from there, for one you sent.
      // `artifact`: the claude.ai artifact it's a copy of (ab_artifact), by its link.
      const post = op.post && state.sessions[op.post];
      const f = { id: op.fid || opId(ctx, "f"), post: op.post || null, from: op.from, name: op.name, title: op.title || op.name, size: op.size, stored: op.stored, draft: !!op.draft, embedded: !!op.embedded, pending: !!op.pending, at: now, ...(op.remote ? { remote: op.remote } : {}), ...(op.blob ? { blob: op.blob } : {}), ...(op.ref ? { ref: op.ref } : {}), ...(op.type ? { type: op.type } : {}), ...(op.artifact ? { artifact: op.artifact } : {}) };
      state.files.unshift(f);
      if (op.from === "human" && post && !op.silent && !op.pending) deliver(state, ctx, op.post, { type: "file", file_id: f.id, name: f.name, size: f.size, path: ctx.filePath(f.stored) });
      if (post) touch(post, now);
      break;
    }
    case "file.remove": {
      state.files = state.files.filter((f) => f.id !== op.fid);
      state.outbox = state.outbox.filter((o) => o.delivered || o.event.type !== "file" || o.event.file_id !== op.fid);
      break;
    }
    case "file.blob": {
      // A file whose bytes the server keeps now (fetched from its machine once): where, and how big.
      const f = state.files.find((x) => x.id === op.fid);
      if (!f) break;
      f.blob = op.blob;
      if (op.size != null) f.size = op.size;
      break;
    }
    case "file.size": {
      // A file a driver keeps elsewhere, once fetched: how big it is (one an OpenClaw agent sent with a MEDIA:
      // line doesn't say until then).
      const f = state.files.find((x) => x.id === op.fid);
      if (!f) break;
      f.size = op.size;
      for (const m of state.messages) if (m.post === f.post) for (const x of m.files || []) if (x.id === f.id) x.size = op.size;
      if (state.sessions[f.post]) state.sessions[f.post].rev = (state.sessions[f.post].rev || 0) + 1;
      break;
    }
  }
}
