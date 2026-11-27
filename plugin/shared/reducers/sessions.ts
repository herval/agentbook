import { BIRDS } from "../ids.ts";
import { isRuntimeId, RUNTIMES } from "../runtimes.ts";
import { rekeyShip } from "../task-ship.ts";
import { storedLevel } from "../visibility.ts";
import type { SessionOp } from "../ops.ts";
import type { PostPr, PrHow, Session, State } from "../types.ts";
import { touch } from "./common.ts";
import type { ApplyContext } from "./common.ts";
import { adopt, helloLaunch } from "./launches.ts";

// Each post's own limits: its results, its "changed N files" and pull request lines, its code blocks' runs.
const SESSION_LIMITS = { updates: 40, changes: 8, prs: 12, runs: 40 };

// A post's pull requests, by link: { url, number, repo, at, how, off, gh }. Its transcript, its agent, you and
// GitHub each say part of it. How it came to be linked keeps the strongest (pulls.ts), and when the earliest;
// one you unlinked (off) stays unlinked whatever finds it again, and where it stands (gh) is GitHub's to say.
const PR_HOW: PrHow[] = ["opened", "worked", "you", "agent", "branch"];
function linkPr(prs: Record<string, PostPr>, url: string, add: Partial<PostPr>): Record<string, PostPr> {
  const key = Object.keys(prs).find((k) => k.toLowerCase() === String(url).toLowerCase()) || url;
  const was: Partial<PostPr> = prs[key] || {};
  const how = [was.how, add.how].filter(Boolean).sort((a, b) => PR_HOW.indexOf(a) - PR_HOW.indexOf(b))[0] || "opened";
  const at = [was.at, add.at].filter(Boolean).sort()[0] || null;
  return { ...prs, [key]: { ...was, url: key, number: add.number ?? was.number, repo: add.repo ?? was.repo, at, how, ...(add.off !== undefined ? { off: !!add.off } : {}), ...(add.gh !== undefined ? { gh: add.gh } : {}) } };
}

// A Claude Code session that ended before anything happened in it (`claude`, then quit; or /clear or /resume
// before a first prompt): no prompt, no turn, nothing said, asked, sent or linked. Claude Code saved no
// conversation for it, so there's nothing to come back to, and its post goes instead of staying as an empty
// "New thread". Its agent's runtime is one whose ended sessions are resumed (shared/runtimes.ts, `resumes`): an
// untouched one has nothing to resume.
function untouched(state: State, s: Session): boolean {
  const kind = state.agents[s.agent]?.kind;
  if (!(isRuntimeId(kind) && RUNTIMES[kind].caps.resumes) || s.launch || s.prompt || s.turn_started || s.title || s.text || s.ai_title) return false;
  return keepsNothing(state, s);
}

// Whether nothing is kept of a thread but the thread: no updates, attachments, pull requests or group, nothing in its
// history (messages, questions, to-dos, files, outbox) or out of memory, no start for it, and no task names it.
export function keepsNothing(state: State, s: Session): boolean {
  if (s.updates?.length || Object.keys(s.attachments || {}).length || Object.keys(s.prs || {}).length || state.group_posts?.[s.id]) return false;
  const on = (x: { post?: string | null }) => x.post === s.id;
  if (state.cold?.has(s.id) || [state.messages, state.questions, state.todos, state.files, state.outbox, Object.values(state.launches)].some((list) => list.some(on))) return false;
  return !Object.values(state.tasks).some((t) => t.posts.some(on) || t.sent.some(on));
}

// The post a session id is a copy of (session.fold), or null: a copy is known by its id or the start of it.
export const foldedInto = (state: Pick<State, "sessions">, id: string | null | undefined): string | null => (id ? Object.values(state.sessions).find((s) => s.id !== id && s.copies?.some((c) => String(id).startsWith(c)))?.id || null : null);

// A new thread's name, one no other open thread has, so that "petrel" in a message means one thread. Its bird
// comes from its process (bird() in lib/common.ts); when another open thread has it, the next bird no open
// thread has, and when all have one, a number after it ("heron 2"). A name given by hand (AGENTBOOK_LABEL, the
// hello's `named`) stays.
export function freeName(state: Pick<State, "sessions">, op: { label?: string; named?: unknown }, key: string): string {
  const label = op.label;
  const taken = new Set(Object.values(state.sessions).filter((s) => s.id !== key && s.state !== "done" && !s.archived).map((s) => s.label));
  if (op.named || !taken.has(label) || !BIRDS.includes(label)) return label;
  const at = BIRDS.indexOf(label);
  for (let i = 1; i < BIRDS.length; i++) if (!taken.has(BIRDS[(at + i) % BIRDS.length])) return BIRDS[(at + i) % BIRDS.length];
  for (let n = 2; ; n++) if (!taken.has(`${label} ${n}`)) return `${label} ${n}`;
}

export function applySession(state: State, op: SessionOp, ctx: ApplyContext): void {
  const { now, warm } = ctx;
  const post = "post" in op ? state.sessions[op.post] : undefined;

  switch (op.t) {
    case "session.hello": {
      if (!state.agents[op.agent]) state.agents[op.agent] = { id: op.agent, name: op.agent_name || op.agent, kind: op.kind || "claude-code", glyph: (op.agent_name || op.agent)[0].toUpperCase(), created: now };
      // A copy of a post's conversation (session.fold) is that post.
      const key = (op.session_id && foldedInto(state, op.session_id)) || op.session_id || op.proc;
      const was = state.procs[op.proc];
      if (was && was !== key && state.sessions[was]) {
        if (was === op.proc && !state.sessions[key]) {
          // A post made for this process before its session id was known: keep it, under the real id.
          warm(was);
          state.sessions[key] = { ...state.sessions[was], id: key };
          delete state.sessions[was];
          for (const list of [state.questions, state.todos, state.files, state.messages, state.outbox]) for (const x of list) if (x.post === was) x.post = key;
          for (const l of Object.values(state.launches)) if (l.post === was) l.post = key;
          for (const t of Object.values(state.tasks)) for (const e of [...t.sent, ...t.posts]) if (e.post === was) e.post = key;
          for (const t of [...state.todos, ...Object.values(state.tasks)]) if (t.done_post === was) t.done_post = key;
          for (const t of Object.values(state.tasks)) if (t.from === was) t.from = key;
        } else if (state.sessions[was].state !== "done") {
          // /clear: the process moved on to a new conversation, so the old one is over.
          Object.assign(state.sessions[was], { state: "done", busy: false, ended: now, end_reason: "Cleared" });
          touch(state.sessions[was], now);
          if (untouched(state, state.sessions[was])) delete state.sessions[was];
        }
      }
      const prev = state.sessions[key];
      const launch = helloLaunch(state, key, op);
      // The same process saying hello again is still in the turn it was in: Claude Code runs SessionStart again
      // after compacting, mid-turn too. A new process (a resume, a restart) starts between turns.
      const again = prev && prev.state !== "done" && prev.proc === op.proc;
      // Dated just below (touch).
      state.sessions[key] = {
        ...(prev || { id: key, started: op.started || now, title: null, text: null, prompt: op.prompt || null, updates: [], attachments: {}, prs: {}, rev: 0 }),
        agent: op.agent,
        label: prev?.label || op.label, // a resumed post keeps its name
        cwd: op.cwd ?? prev?.cwd,
        root: op.root ?? prev?.root,
        repo: op.repo ?? prev?.repo,
        branch: op.branch ?? prev?.branch,
        host: op.host ?? prev?.host,
        pid: op.pid ?? prev?.pid,
        proc: op.proc,
        session_id: op.session_id || prev?.session_id || null,
        transcript: op.transcript || prev?.transcript || null,
        channel: !!op.channel,
        // Claude Desktop or VS Code (appOf): the same process keeps it, a resume elsewhere (a terminal, the background) doesn't.
        app: op.app || (prev?.proc === op.proc ? prev?.app : null) || null,
        launch: launch?.id || prev?.launch || null,
        cloud: op.cloud || prev?.cloud || null, // "claude" or "codex": runs in their cloud, not on a machine
        url: op.url || prev?.url || null,
        state: prev && prev.state !== "done" ? prev.state : "idle",
        busy: again ? !!prev.busy : false,
        ended: null,
        end_reason: null,
        asleep: false,
        slept: null,
        sleep_reason: null,
      } as Session;
      touch(state.sessions[key], prev ? now : op.updated || now);
      state.procs[op.proc] = key;
      if (launch) adopt(state, launch, key);
      break;
    }
    case "session.status": {
      if (!post) break;
      if (op.state) post.state = op.state;
      // What the last turn ended on ("Waiting for your next message") isn't what this one is doing. Only Claude Code
      // says at the start of a turn; the drivers' turns start with no words.
      if (op.turn === "start" && !op.text) post.doing = null;
      if (op.text) post.doing = op.text;
      if (op.transcript) post.transcript = op.transcript;
      if (op.app) post.app = op.app;
      // Hooks mark where Claude's turns start and end, so events can wait for the gap between turns.
      if (op.turn === "start") Object.assign(post, { busy: true, turn_started: now });
      // What the last turn said of itself and no reply took (session.shape) isn't this turn's.
      if (op.turn === "start") delete post.shape;
      if (op.turn === "end") Object.assign(post, { busy: false, turn_ended: now });
      // `failed`: the API error that ended its turn (Claude Code's kind of it: "server_error", "rate_limit"…), with
      // what it said; null once nothing should pick it up (archived). The next turn's start clears it.
      if (op.turn === "start" || op.failed === null) post.failed = null;
      if (op.failed) post.failed = { error: op.failed, text: op.text || null, at: now };
      touch(post, now);
      break;
    }
    case "session.gone": {
      if (!post) break;
      // The first word on how it ended stands ("Stopped", then the session's own "Session ended").
      if (post.state !== "done") {
        Object.assign(post, { state: "done", busy: false, ended: op.ended || now, end_reason: op.reason || "Ended" });
        touch(post, op.ended || now);
      }
      for (const [proc, key] of Object.entries(state.procs)) if (key === op.post) delete state.procs[proc];
      // Nothing can answer its questions any more.
      for (const q of state.questions) if (q.post === op.post && !q.answered) Object.assign(q, { answered: now, value: null, by: "gone" });
      if (untouched(state, post)) delete state.sessions[op.post];
      break;
    }
    case "session.sleep": {
      // A background session whose process stopped (agentbook put it to sleep, Claude Code retired it, you
      // archived it) isn't over: its post stays, and writing to it wakes it. Only the prompts its process was
      // holding go; questions it asked get their answers when it wakes.
      if (!post || post.state === "done" || post.asleep) break;
      Object.assign(post, { asleep: true, slept: now, sleep_reason: op.reason || null, state: "idle", busy: false });
      for (const [proc, key] of Object.entries(state.procs)) if (key === op.post) delete state.procs[proc];
      for (const q of state.questions) if (q.post === op.post && !q.answered && (q.kind === "permission" || q.hook)) Object.assign(q, { answered: now, value: null, by: "gone" });
      touch(post, now);
      break;
    }
    case "session.post": {
      if (!post) break;
      // A thread keeps the title it was found by: an agent's later headline doesn't replace it, only one the
      // person asked for (`rename`).
      if (op.title && (!post.title || op.rename)) post.title = op.title;
      if (op.text != null) post.text = op.text;
      touch(post, now);
      break;
    }
    case "session.update": {
      if (!post) break;
      // `changes`: agentbook's own line for a turn that changed files. Only the newest few stay, so they
      // don't crowd out the session's results.
      // `pr`: agentbook's own line for a change in one of its pull requests ({ url, number, kind }), as few.
      for (const [k, n] of [["changes", SESSION_LIMITS.changes], ["pr", SESSION_LIMITS.prs]] as const) {
        if (!op[k]) continue;
        const lines = post.updates.filter((u) => u[k]);
        for (const u of lines.slice(0, Math.max(0, lines.length - n + 1))) post.updates.splice(post.updates.indexOf(u), 1);
      }
      // `notify`: its agent put this one on its person's bell too (ab_update's notify, once a turn; server/news.ts).
      post.updates.push({ at: now, text: op.text, link: op.link || null, ...(op.changes ? { changes: op.changes } : {}), ...(op.pr ? { pr: op.pr } : {}), ...(op.notify === true ? { notify: true } : {}) });
      if (post.updates.length > SESSION_LIMITS.updates) post.updates.splice(0, post.updates.length - SESSION_LIMITS.updates);
      touch(post, now);
      break;
    }
    case "session.pr": {
      // One of its pull requests linked (how), unlinked or linked again (off), or read from GitHub (gh). GitHub
      // telling where it stands isn't the post doing something: it isn't touched.
      if (!post || !op.url) break;
      post.prs = linkPr(post.prs || {}, op.url, op);
      if (op.how) touch(post, now);
      else post.rev = (post.rev || 0) + 1;
      break;
    }
    case "session.attach": {
      if (!post) break;
      if (op.remove) delete post.attachments[op.key];
      else {
        const prev = post.attachments[op.key];
        post.attachments[op.key] = { key: op.key, type: op.type || prev?.type, title: op.title || prev?.title || "", data: { ...(prev?.data || {}), ...(op.data || {}) }, created: prev?.created || now, updated: now };
      }
      touch(post, now);
      break;
    }
    case "session.shape": {
      // How its turn went (ab_verdict, ab_checks, ab_suggest): kept until the reply that ends the turn takes it. Each
      // part replaces what the turn had of it. Not shown until then, so the post isn't touched.
      if (!post || !op.shape || typeof op.shape !== "object") break;
      post.shape = { ...(post.shape || {}), ...op.shape };
      break;
    }
    case "session.run": {
      // A code block of one of its messages, run on its machine: its latest run, by the message and which of its
      // blocks it is. Only the newest few stay. Running one isn't its agent doing something: it isn't touched.
      if (!post) break;
      const runs = (post.runs ||= {});
      const key = `${op.mid}:${op.block}`;
      const was = runs[key];
      delete runs[key];
      runs[key] = { mid: op.mid, block: op.block, state: op.state, by: op.by ?? was?.by ?? null, started: op.started || was?.started || now, ended: op.ended ?? null, exit: op.exit ?? null, signal: op.signal ?? null, out: op.out || "", cut: !!op.cut, error: op.error ?? null };
      for (const k of Object.keys(runs).slice(0, Math.max(0, Object.keys(runs).length - SESSION_LIMITS.runs))) delete runs[k];
      post.rev = (post.rev || 0) + 1;
      break;
    }
    case "session.flag": {
      // Pinned keeps a post at the top of the feed, archived moves it out of the feed into Archived, and
      // hidden into Hidden, still going.
      if (!post) break;
      if (typeof op.pinned === "boolean") Object.assign(post, { pinned: op.pinned, pinned_at: op.pinned ? now : null });
      if (typeof op.archived === "boolean") Object.assign(post, { archived: op.archived, archived_at: op.archived ? now : null });
      if (typeof op.hidden === "boolean") Object.assign(post, { hidden: op.hidden, hidden_at: op.hidden ? now : null });
      touch(post, now);
      break;
    }
    case "session.off": {
      // Nothing of its session comes in while it's off, so what it was doing then is no longer known: it isn't
      // shown working, and what it still asked can't be answered from agentbook. Its session keeps going where it is.
      if (!post || !!post.off === op.off) break;
      if (op.off) {
        Object.assign(post, { off: now, busy: false, doing: null, ...(post.state === "done" ? {} : { state: "idle" }) });
        for (const q of state.questions) if (q.post === op.post && !q.answered) Object.assign(q, { answered: now, value: null, by: "gone" });
      } else post.off = null;
      post.rev = (post.rev || 0) + 1;
      break;
    }
    case "session.group": {
      // The group a post is in, as its server says (a machine's own note of it: its folder is one the session may
      // write, and it hears the group's news).
      if (post) post.group = op.gid || null;
      break;
    }
    case "session.wip": {
      // The task a post is on that ships more than it does, as its server says: it hears that task's news (task-ship.ts).
      if (post) post.wip = op.sid || null;
      break;
    }
    case "session.paged": {
      // The page its person put a post on by hand (or none: they took it off one), as its server says: it hears so.
      if (post) post.paged = { page: op.pid || null };
      break;
    }
    case "session.visibility": {
      // A post's own setting (null: as its agent; private or public, visibility.ts), and whether others see its work
      // (steps, files).
      if (!post) break;
      if (op.visibility === null || storedLevel(op.visibility)) post.visibility = op.visibility === null ? null : storedLevel(op.visibility);
      if (typeof op.show_work === "boolean") post.show_work = op.show_work;
      touch(post, now);
      break;
    }
    case "session.where": {
      // The session moved to another checkout, or switched branch (from its transcript).
      if (!post) break;
      for (const k of ["cwd", "root", "repo", "branch"]) if (op[k] !== undefined) post[k] = op[k];
      touch(post, now);
      break;
    }
    case "session.landed": {
      // Its branch was cleaned up with everything on it on main (WIP's Clean up), so once the branch is gone
      // the post still says its work landed.
      if (post && op.branch) post.landed = op.branch;
      break;
    }
    case "session.skills": {
      if (post) post.skills = op.skills || [];
      break;
    }
    case "session.paused": {
      // Its queue held (`paused`: "stopped", "ended" or "you"), or going again (null).
      if (!post) break;
      if (op.paused) post.queue_paused = op.paused;
      else delete post.queue_paused;
      post.rev = (post.rev || 0) + 1;
      break;
    }
    case "session.from": {
      // The thread it was started from: a Claude Desktop session another one started (cli/desktop.ts), or the one
      // its person picked on its page (`by: "you"`, on the server), which may be none. What they picked stays:
      // Desktop's doesn't replace it, nor bring back one they took off. Not news of its own: it keeps its place in
      // the lists.
      if (!post || op.started_from === post.id) break;
      // `by` is one literal: with null checks off (tsconfig.json), comparing it as it is would leave nothing of the
      // op where it isn't "you".
      const picked = (op.by as string) === "you";
      if (!picked && (!op.started_from || post.from_by === "you")) break;
      if ((post.started_from || null) === (op.started_from || null) && (!picked || post.from_by === "you")) break;
      if (op.started_from) post.started_from = op.started_from;
      else delete post.started_from;
      if (picked) post.from_by = "you";
      post.rev = (post.rev || 0) + 1;
      break;
    }
    case "session.model": {
      // The model you picked for the session's next turn; null once it's switched (or the pick is undone).
      if (!post) break;
      post.model_pick = op.model || null;
      touch(post, now);
      break;
    }
    case "session.mode":
    case "session.effort": {
      // A mode or effort picked for its next turn (`pick`, null to undo it), and the one it's in now, which settles
      // a pick of the same. A mode its transcript says leaves a pick for another waiting.
      if (!post) break;
      const [pickKey, nowKey, nowValue] = op.t === "session.mode" ? (["mode_pick", "mode", op.mode] as const) : (["effort_pick", "effort", op.effort] as const);
      const was = `${post[pickKey] || ""}|${post[nowKey] || ""}`;
      if ("pick" in op) post[pickKey] = (op.pick || null) as never;
      if (nowValue) {
        post[nowKey] = nowValue as never;
        if (post[pickKey] === nowValue) post[pickKey] = null;
      }
      if (`${post[pickKey] || ""}|${post[nowKey] || ""}` !== was) touch(post, now);
      break;
    }
    case "session.fold": {
      // A copy Claude Code started when asked to resume this post (`copy`: its session id, or the start of it, as
      // `claude --bg` printed it): a new session with this post's conversation in it, which went on there. It's
      // this post: what the copy's own post has (messages, results, questions, files, pull requests) moves here,
      // and its session too with `follow` (the thread goes on in the copy). Its hello finds this post (`copies`).
      const into = post;
      if (!into || !op.copy || op.copy === op.post) break;
      const key = Object.keys(state.sessions).find((k) => k !== op.post && (k === op.copy || k.startsWith(op.copy)));
      const from = key && state.sessions[key];
      into.copies = [...new Set([...(into.copies || []), key || op.copy, ...(from?.copies || [])])];
      if (from) {
        warm(key);
        warm(op.post);
        for (const list of [state.questions, state.todos, state.files, state.messages, state.outbox]) for (const x of list) if (x.post === key) x.post = op.post;
        for (const l of Object.values(state.launches)) if (l.post === key) l.post = op.post;
        for (const t of Object.values(state.tasks)) {
          for (const e of [...t.sent, ...t.posts]) if (e.post === key) e.post = op.post;
          t.posts = t.posts.filter((e, i) => t.posts.findIndex((x) => x.post === e.post) === i);
          if (t.from === key) t.from = op.post;
        }
        for (const t of [...state.todos, ...Object.values(state.tasks)]) if (t.done_post === key) t.done_post = op.post;
        for (const [proc, k] of Object.entries(state.procs)) if (k === key) state.procs[proc] = op.post;
        if (state.group_posts[key] && !state.group_posts[op.post]) state.group_posts[op.post] = state.group_posts[key];
        delete state.group_posts[key];
        if (state.page_posts?.[key] && !state.page_posts[op.post]) state.page_posts[op.post] = state.page_posts[key];
        if (state.page_posts) delete state.page_posts[key];
        rekeyShip(state, key, op.post);
        into.updates = [...into.updates, ...from.updates].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-SESSION_LIMITS.updates);
        for (const [url, p] of Object.entries(from.prs || {})) into.prs = linkPr(into.prs || {}, url, p);
        for (const [k, a] of Object.entries(from.attachments || {})) if (!into.attachments[k] || a.updated > into.attachments[k].updated) into.attachments[k] = a;
        if (!into.title && from.title) Object.assign(into, { title: from.title, text: from.text });
        // Put away only if both were: one of them going on is the thread going on.
        for (const f of ["archived", "hidden"]) if (into[f] && !from[f]) Object.assign(into, { [f]: false, [`${f}_at`]: null });
        if (op.follow) {
          for (const k of ["session_id", "transcript", "proc", "pid", "host", "channel", "app", "cloud", "url", "state", "busy", "doing", "turn_started", "turn_ended", "failed", "ended", "end_reason", "asleep", "slept", "sleep_reason", "ai_title", "model", "plan", "stats", "context", "skill_uses", "loops", "shape"]) {
            if (from[k] !== undefined && !(k === "ai_title" && into.ai_title)) into[k] = from[k];
          }
        }
        delete state.sessions[key];
      } else if (op.follow && op.session_id) {
        // A copy that never said hello (Claude Code stopped it before its turn: no login) has no post to move here,
        // but what you sent is in it: with its `session_id`, the thread goes on in it, and a resume resumes it.
        into.session_id = op.session_id;
        if (into.transcript) into.transcript = into.transcript.replace(/[^/\\]+\.jsonl$/, `${op.session_id}.jsonl`);
      }
      touch(into, now);
      break;
    }
    case "session.snapshot": {
      // What the transcript says about the session, kept so summaries survive a restart.
      if (!post) break;
      // Its runtime's title for it (Claude Code's ai-title, a Codex thread's name) is the first it gave: Claude Code
      // gives a new one as the conversation goes on, and a thread that changes names can't be found again.
      if (op.ai_title && !post.ai_title) post.ai_title = op.ai_title;
      for (const k of ["model", "plan", "stats", "context", "skill_uses"]) if (op[k] !== undefined) post[k] = op[k];
      // It began earlier than agentbook knew (OpenClaw's history goes further back): never later.
      if (op.started && op.started < post.started) post.started = op.started;
      if (op.prs) for (const [url, p] of Object.entries<Partial<PostPr>>(op.prs)) post.prs = linkPr(post.prs || {}, url, { url, number: p.number, repo: p.repo, at: p.at, how: p.how || "opened" });
      // Its loops (/loop), by id: a transcript read from its middle, after a restart, may know fewer of them,
      // or fewer of their runs.
      if (op.loops) {
        const was = Object.fromEntries((post.loops || []).map((l) => [l.id, l]));
        for (const l of op.loops) {
          const runs = [...(was[l.id]?.runs || []).filter((r) => r.at < (l.runs[0]?.at || "~") && l.at <= r.at), ...l.runs].slice(-100);
          // That someone started it (/loop) may be before what was read.
          const slash = l.slash || (was[l.id]?.slash && was[l.id].at === l.at);
          was[l.id] = { ...l, runs, ...(slash ? { slash } : {}) };
        }
        post.loops = Object.values(was);
      }
      touch(post, now);
      break;
    }
  }
}
