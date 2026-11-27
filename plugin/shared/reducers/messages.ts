import { mentionNote } from "../mentions.ts";
import { typedPart } from "../text.ts";
import type { MessageOp } from "../ops.ts";
import type { State } from "../types.ts";
import { deliver, opId, touch, unarchive, unpause } from "./common.ts";
import type { ApplyContext } from "./common.ts";

export function applyMessage(state: State, op: MessageOp, ctx: ApplyContext): void {
  const { now } = ctx;
  const pid = "post" in op ? op.post : null;
  const post = pid ? state.sessions[pid] : undefined;

  switch (op.t) {
    case "message.add": {
      if (!post) break;
      // A mirrored prompt keeps only what the person typed. Channel events and subagent reports are
      // Claude Code's own; agentbook already shows them.
      let text = op.via === "terminal" && op.from === "human" ? typedPart(op.text) : op.text || "";
      if (op.via === "terminal" && !text) break;
      // A resumed session's first prompt is what you wrote on its post, already in the conversation. It answers the
      // newest resume waiting for it; one before that whose prompt never came back (Claude Code restarted the
      // session itself, with a prompt of its own, before agentbook's reached it) waits no more, or each prompt after
      // it would be held to the one before and shown twice.
      const resumed = op.via === "terminal" && op.from === "human" ? Object.values(state.launches).filter((l) => l.resume && l.post === op.post && !l.mirrored && !l.error) : [];
      if (resumed.length) {
        for (const l of resumed) l.mirrored = true;
        if (resumed.some((l) => text.startsWith(l.prompt.trim()))) break;
      }
      // A session started from agentbook: its first prompt is what you posted there, not something typed in a terminal.
      // What agentbook told it with your words (`noted`: a note's comment, a thread it's a guest in) isn't yours.
      let via = op.via || "dash";
      const launched = via === "terminal" && op.from === "human" && state.launches[post.launch];
      if (launched && !launched.resume && !launched.mirrored) {
        launched.mirrored = true;
        if (text.startsWith(launched.prompt.trim())) {
          via = "dash";
          if (launched.noted) text = launched.prompt.trim();
        }
      }
      // Files attached to the message stop being drafts and join the post.
      const files = (op.files || []).map((fid) => state.files.find((f) => f.id === fid)).filter(Boolean);
      for (const f of files) Object.assign(f, { post: op.post, pending: false });
      // A message copied from the agent's own record of the session (OpenClaw's history) keeps its id there
      // (`ext`), so it's copied once, and when it was said (`when`).
      // `routine`: a routine's run, sent to its thread ({ id, name }, routines.ts).
      const mid = op.mid || opId(ctx, "m");
      // `queue`: one of yours that waits for its post's turn to end, under the live line, until message.release.
      const queue = !!op.queue && op.from === "human";
      // `command`: a slash command you ran (its name), or, on the agent's message, the one whose output it is.
      // `shape`: how its turn went, as its agent said with ab_verdict, ab_checks and ab_suggest, on the reply that
      // ends the turn: its first message after them (its closing words, or what it said with ab_reply).
      const shape = op.from === "agent" && post.shape && !op.command && !op.file_id ? post.shape : null;
      if (shape) delete post.shape;
      // `via: "side"`: what you sent on the side, which started a side thread (`launch`, its launch) and never reached
      // this thread's session.
      // `user`: who sent it, when it wasn't the machine's owner (back when an owner could let others operate an
      // agent), or the one who started it from the page (a launch's `user`). Kept for what's from then.
      const user = op.from === "human" ? op.user || (launched && !launched.resume ? launched.user : null) || null : null;
      // `intro`: who it's from, as its machine told its agent before their words (an operator's, from then): kept
      // here, so a message sent again says it again; never sent to the server.
      const intro = user && op.from === "human" && typeof op.intro === "string" && !op.command ? op.intro : null;
      state.messages.push({ id: mid, post: op.post, from: op.from, via, text, file_id: op.file_id || null, files: files.map((f) => ({ id: f.id, name: f.name, size: f.size })), at: op.when || now, ...(user ? { user } : {}), ...(intro ? { intro } : {}), ...(op.ext ? { ext: op.ext } : {}), ...(op.routine ? { routine: op.routine } : {}), ...(queue ? { queued: true } : {}), ...(op.command ? { command: op.command } : {}), ...(shape ? { shape } : {}), ...(op.via === "side" && op.launch ? { launch: op.launch } : {}) });
      // A slash command isn't what the thread is about, so it never becomes its prompt ("You asked: /status").
      if (op.from === "human" && !post.prompt && text && !op.routine && !op.command) post.prompt = text;
      // A cron job's run with something to report moves its thread on the feed, as a change moves a page (feed.ts).
      const cron = op.routine?.why === "cron";
      if (cron) post.moved = op.when || now;
      if (op.from === "human" && !cron && (text || files.length || op.file_id)) unarchive(post, op.when || now);
      // Only what you write on agentbook goes to the session. What reached it another way (typed in its
      // terminal, sent from Discord or Telegram) it already has, and a message that resumes a session is its
      // first prompt. Pages and widgets it names come with a note on what they showed then (mentions.ts).
      // A slash command goes as it was typed, with nothing after it: its agent reads it as a command, not a message.
      if (op.from === "human" && (text || files.length) && (op.via || "dash") === "dash" && !op.ext && !op.resume) {
        const note = op.routine || op.command ? "" : (op.note ?? mentionNote(text, state.pages, Date.parse(now)));
        // `user`: someone else's words, so a driver never sends them as the owner's (OpenClaw's admin).
        deliver(state, ctx, op.post, { type: "message", text: [intro, text, note].filter(Boolean).join("\n\n"), files: files.map((f) => ({ name: f.name, size: f.size, path: ctx.filePath(f.stored) })), ...(op.command ? { command: op.command } : {}), ...(user ? { user } : {}) }, mid, queue);
      }
      touch(post, op.when || now);
      break;
    }
    case "message.release": {
      // A queued message going in: out of the queue, and moved to now, after the reply it waited for, saying it
      // waited (`waited`). Its outbox entry goes out like any message's.
      const i = state.messages.findIndex((m) => m.post === op.post && m.id === op.mid && m.queued);
      if (i < 0) break;
      const { queued: _, ...m } = state.messages[i];
      state.messages.splice(i, 1);
      state.messages.push({ ...m, at: now, waited: true });
      for (const o of state.outbox) if (o.post === op.post && o.mid === op.mid && o.held) Object.assign(o, { held: false, at: now });
      unpause(state, op.post);
      if (post) touch(post, now);
      break;
    }
    case "message.files": {
      // Files for a message copied before agentbook kept them: an OpenClaw message's media, by its id there.
      const m = post && state.messages.find((x) => x.post === op.post && x.ext === op.ext);
      if (!m) break;
      const files = (op.files || []).map((fid) => state.files.find((f) => f.id === fid)).filter(Boolean);
      for (const f of files) Object.assign(f, { post: op.post, pending: false });
      m.files = [...(m.files || []), ...files.map((f) => ({ id: f.id, name: f.name, size: f.size }))];
      post.rev = (post.rev || 0) + 1;
      break;
    }
    case "message.text": {
      // A message copied from OpenClaw's history, as it reads now: without what OpenClaw added to it.
      const m = post && state.messages.find((x) => x.post === op.post && x.ext === op.ext);
      if (!m) break;
      m.text = op.text;
      post.rev = (post.rev || 0) + 1;
      break;
    }
    case "message.drop": {
      // Messages that shouldn't be on the post: OpenClaw's, copied again on each restart before their ids were
      // kept, what OpenClaw wrote to its agent, or one of yours that couldn't be delivered, which you deleted.
      const drop = new Set(op.mids || []);
      state.messages = state.messages.filter((m) => m.post !== op.post || !drop.has(m.id));
      state.outbox = state.outbox.filter((o) => o.post !== op.post || !drop.has(o.mid));
      unpause(state, op.post);
      if (post) post.rev = (post.rev || 0) + 1;
      break;
    }
    case "message.fail": {
      // Messages of yours its agent couldn't be reached with (`error`: why, in words): they stay on the post, saying
      // so, and wait aside in the outbox, as they were to be sent, until you send them again or delete them.
      const mids = new Set(op.mids || []);
      for (const m of state.messages) if (m.post === op.post && mids.has(m.id)) m.failed = { error: op.error || "", at: now };
      for (const o of state.outbox) if (o.post === op.post && mids.has(o.mid) && !o.delivered) o.failed = true;
      if (post) post.rev = (post.rev || 0) + 1;
      break;
    }
    case "message.retry": {
      // One that couldn't be delivered, sent again: it goes now, so it moves to now, after whatever came since.
      const i = state.messages.findIndex((m) => m.post === op.post && m.id === op.mid && m.failed);
      if (i < 0) break;
      const { failed: _, ...m } = state.messages[i];
      state.messages.splice(i, 1);
      state.messages.push({ ...m, at: now });
      const waiting = state.outbox.find((o) => o.post === op.post && o.mid === op.mid && !o.delivered);
      if (waiting) Object.assign(waiting, { failed: false, at: now });
      else if (m.from === "human") {
        // Its outbox no longer has it: sent again as it reads.
        const files = (m.files || []).map((x) => state.files.find((f) => f.id === x.id)).filter(Boolean);
        deliver(state, ctx, op.post, { type: "message", text: [m.intro, m.text].filter(Boolean).join("\n\n"), files: files.map((f) => ({ name: f.name, size: f.size, path: ctx.filePath(f.stored) })), ...(m.user ? { user: m.user } : {}) }, m.id);
      }
      if (post) touch(post, now);
      break;
    }
    case "event.deliver": {
      // Something for a post that isn't a message or an answer to its own question (the answer to one the server
      // asked on it), delivered like one.
      if (post && op.event && typeof op.event === "object") deliver(state, ctx, op.post, op.event);
      break;
    }
    case "outbox.ack": {
      const set = new Set(op.oids);
      for (const o of state.outbox) if (set.has(o.oid)) o.delivered = true;
      state.outbox = state.outbox.filter((o) => !o.delivered || Date.parse(now) - Date.parse(o.at) < 3600e3);
      break;
    }
  }
}
