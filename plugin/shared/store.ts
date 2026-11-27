// agentbook store: the state the server works on, in memory, kept in storage.db, through its tables there (storage/store.ts).
// Every change is an op, and apply() is the only place state changes, dispatching each op to its domain reducer
// (reducers/*, pages.ts, notes.ts, routines.ts, groups.ts, guests.ts, talks.ts, task-ship.ts). Each op is written
// to the database as it's committed; the state itself is written as a checkpoint every few seconds and at exit.
// Starting up loads the checkpoint and replays the ops after it, so the state comes back exactly, including which
// events were already delivered to sessions. The database keeps every thread's whole history; memory holds some
// threads' (warm), so what reads one thread's goes through warm(), conversationOf() or fileOf().
//
// The model: an agent (Claude) has sessions, and each session is a post. A post is keyed by Claude Code's
// session id, so resuming a conversation brings back its post and /clear starts a new one. `procs` maps
// each running Claude Code process to the post it's on; hooks and the MCP server address it by process.

import fs from "node:fs";
import path from "node:path";
import { isPicture, lifeKept, lifeOf } from "./life.ts";
import { isCorrupt, Storage, STORAGE_FILE } from "./storage.ts";
import { HOME } from "./home.ts";
import { applyRoutine } from "./routines.ts";
import { plainMentions } from "./mentions.ts";
import { applyPage, pageSummary, postPages } from "./pages.ts";
import { applyGroup, groupSummary } from "./groups.ts";
import { applyNote } from "./notes.ts";
import { applyGuest } from "./guests.ts";
import { applyTalk } from "./talks.ts";
import { applyTaskShip } from "./task-ship.ts";
import { uuidv7 } from "./ids.ts";
import { applyAgent } from "./reducers/agents.ts";
import { applyFollow } from "./reducers/follows.ts";
import { applyLaunch, helloLaunch } from "./reducers/launches.ts";
import { applyMessage } from "./reducers/messages.ts";
import { applyFile, applyQuestion, applyTodo } from "./reducers/questions.ts";
import { applyServer } from "./reducers/server.ts";
import { applySession, foldedInto, freeName, keepsNothing } from "./reducers/sessions.ts";
import { applyTask, applyWorkspace, linkPost } from "./reducers/tasks.ts";
import type { ApplyContext } from "./reducers/common.ts";
import type { Logged, Op, OpKind, OpOf } from "./ops.ts";
import type { FeedSummary, FileRecord, HistoryPart, Iso, Message, OutboxEntry, Page, Question, Session, SessionFailure, State } from "./types.ts";

// The data folder, and where files are kept in it (or elsewhere, e.g. on a bigger disk).
export { HOME, foldedInto, helloLaunch, keepsNothing };
// agentbook-cli's own folder in it (agentbook-server's is server/).
export const CLI_HOME = path.join(HOME, "cli");
export const FILES_DIR = process.env.AGENTBOOK_FILES || path.join(CLI_HOME, "files");
// The one database everything here is kept in (storage.ts), and agentbook-cli's own from before it, folded in once.
export const DB_FILE = path.join(HOME, STORAGE_FILE);
export const CLI_DB_BEFORE = path.join(CLI_HOME, "agentbook.db");
const CHECKPOINT_MS = Number(process.env.AGENTBOOK_CHECKPOINT_MS || 5000);
// How long a machine's log keeps an op its server has (AGENTBOOK_LOG_DAYS, a day at least): long enough that a server
// restored from a backup up to a week old gets back what it lost (uplink.ts). Its server keeps them for good.
const ACKED_DAYS = Math.max(1, Number(process.env.AGENTBOOK_LOG_DAYS) || 7);
// How many messages memory holds, of whole threads; the database keeps them all (warm, settle).
const MEMORY_MESSAGES = Number(process.env.AGENTBOOK_MEMORY_MESSAGES || 8000);
// A thread's history: what of it can be out of memory, its rows kept (storage/store.ts's `paged`).
const HISTORY: HistoryPart[] = ["questions", "files", "messages"];
// A part of threads' history, as paging it in and out of memory handles it: records of one thread or another each.
type Paged = { id?: string; post?: string | null }[];
// The ops that change a thread's history, which need all of it in memory.
const HISTORY_OPS = new Set(["message.add", "message.release", "message.files", "message.text", "message.drop", "message.fail", "message.retry", "question.ask", "file.add"]);
const FILE_OPS = new Set(["file.remove", "file.blob", "file.size"]);
// A thread used within this stays in memory.
const QUIET_MS = 3600e3;

// A store's state before its first op: every part there, empty.
export const emptyState = (): State => ({ seq: 0, agents: {}, sessions: {}, procs: {}, launches: {}, questions: [], todos: [], files: [], messages: [], outbox: [], workspaces: {}, tasks: {}, pages: {}, page_versions: [], routines: {}, routine_code: [], routine_runs: [], groups: {}, group_notes: [], group_files: [], group_events: [], group_posts: {}, notes: {}, note_versions: [], thread_guests: {}, thread_seen: {}, talks: {}, wip_sets: {}, page_posts: {}, agent_follows: {}, person_follows: {}, contacts: {}, thread_people: {}, feed_archived: {}, machine_cloud: {}, images: {}, image_builds: {}, boxes: {} });

export type Store = ReturnType<typeof createStore>;
// What createStore takes (below).
export interface StoreOptions {
  storage?: Storage | null;
  scope?: string;
  file?: string | null;
  was?: string | null;
  filesDir?: string;
  outbox?: boolean;
  legacy?: boolean;
  acks?: boolean;
  moveCorrupt?: boolean;
}

// A store: the state, its rows in a Storage (under `scope`), and the ops that change it. `filesDir` is where the
// files its ops name are kept. One the server keeps for a machine (`outbox: false`) has nothing to deliver to
// sessions: what reaches them goes to that machine as commands. `legacy`: an events.jsonl from before the database,
// in the folder of the database it had before (`was`), is imported once.
// `acks`: a machine's store (agentbook-cli's), whose ops go to a server: its log keeps every op the server hasn't
// acknowledged, however old (setAcked), and prunes what it has once it's a week old (ACKED_DAYS), not 30 days.
// Its storage: `storage`; else one of its own whose database is `file` (tests); else this machine's (DB_FILE), as
// agentbook-cli's store, with what its database from before storage.db had (`was`: CLI_DB_BEFORE) folded in once.
export function createStore({ storage = null, scope = "cli", file = null, was, filesDir = FILES_DIR, outbox = true, legacy = true, acks = false, moveCorrupt = false }: StoreOptions = {}) {
  const own = !storage && !file;
  storage = (storage || (file ? Storage.at(file, { moveCorrupt }) : Storage.open(HOME, { moveCorrupt }))).hold();
  if (was === undefined) was = own ? CLI_DB_BEFORE : null;
  const home = file ? path.dirname(file) : was ? path.dirname(was) : storage.root;
  const LOG = path.join(home, "events.jsonl"); // before the database: imported once, then kept as a backup
  if (own || file || legacy) fs.mkdirSync(home, { recursive: true });
  const kept = storage.files(filesDir); // its files' folder (a `files` here is a message's)
  filesDir = kept.dir;
  fs.mkdirSync(filesDir, { recursive: true });
  const state = emptyState();
  // What onChange hears: each op as it was applied.
  const listeners = new Set<(op: Logged) => void>();

  // Memory holds each thread's history (its questions, files and messages) whole or not at all. Past
  // MEMORY_MESSAGES, the threads used least lately go back to the database after a checkpoint (settle), and come
  // back whole when anything reads or changes them (warm); their rows stay either way. `cold`: what the feed shows
  // of each thread that's out (feedOf). `used`: when each thread's history was last read or changed (ms).
  const cold = new Map<string, FeedSummary>();
  const used = new Map<string, number>();
  const history: Record<HistoryPart, Paged> = state;
  function warm(post: string | null | undefined, at = Date.now()): void {
    if (!post) return;
    if (!(used.get(post) > at)) used.set(post, at);
    if (!cold.has(post)) return;
    cold.delete(post);
    for (const part of HISTORY) {
      const back = tables.pageIn(part, post);
      if (back.length) history[part] = tables.inOrder(part, [...history[part], ...back]);
    }
  }
  const warmFile = (fid: string | null | undefined): void => {
    if (fid && cold.size && !state.files.some((f) => f.id === fid)) warm(tables.postOf("files", fid));
  };
  // Right after a checkpoint, when the database has all of it: threads back to it until memory holds no more
  // messages than it should. Not one asking you something, holding messages of yours (queued, or to send again),
  // or used within the hour.
  function settle() {
    if (state.messages.length <= MEMORY_MESSAGES) return;
    const count = new Map<string, number>();
    for (const m of state.messages) count.set(m.post, (count.get(m.post) || 0) + 1);
    const stays = new Set<string>();
    for (const q of state.questions) if (!q.answered) stays.add(q.post);
    for (const m of state.messages) if (m.queued || m.failed) stays.add(m.post);
    const lately = (p: string): number => Math.max(used.get(p) || 0, Date.parse(state.sessions[p]?.updated) || 0);
    const now = Date.now();
    const going = new Set<string>();
    let left = state.messages.length;
    for (const p of [...count.keys()].filter((p) => !stays.has(p) && now - lately(p) > QUIET_MS).sort((a, b) => lately(a) - lately(b))) {
      if (left <= MEMORY_MESSAGES) break;
      going.add(p);
      left -= count.get(p);
    }
    if (!going.size) return;
    const gone: Record<string, Partial<Record<HistoryPart, Paged>>> = {};
    for (const part of HISTORY) {
      const out = history[part].filter((x) => going.has(x.post));
      history[part] = history[part].filter((x) => !going.has(x.post));
      tables.pageOut(part, out);
      for (const x of out) ((gone[x.post] ||= {})[part] ||= []).push(x);
    }
    for (const p of going) {
      // Each part's records, as they went.
      cold.set(p, feedOf(gone[p].messages as Message[], gone[p].files as FileRecord[], gone[p].questions as Question[], state.sessions[p]));
      used.delete(p);
    }
  }
  // For what reads a thread's history (warm, fileOf, outOfMemory below), not part of what's saved.
  Object.defineProperty(state, "cold", {
    value: {
      has: (post) => cold.has(post),
      summary: (post) => cold.get(post),
      warm: (post) => warm(post),
      file: warmFile,
      rows: (part, posts) => (cold.size ? tables.rows(part, (p) => cold.has(p) && (!posts || posts.has(p))) : []),
      row: (part, id) => tables.rowById(part, id),
      messagesChunk: (afterOrd, limit) => tables.messagesChunk(afterOrd, limit),
    },
  });

  const filePath = (stored: string) => kept.path(stored);

  function apply(op: Logged) {
    state.seq = Math.max(state.seq, op.seq);
    const now = op.at;
    const { post: pid, fid } = op as { post?: string | null; fid?: string };
    if (HISTORY_OPS.has(op.t)) warm(pid, Date.parse(now) || Date.now());
    else if (FILE_OPS.has(op.t)) warmFile(fid);
    const ctx: ApplyContext = { now, seq: op.seq, outbox, warm, filePath };

    switch (op.t) {
      case "session.hello":
      case "session.status":
      case "session.gone":
      case "session.sleep":
      case "session.post":
      case "session.update":
      case "session.pr":
      case "session.attach":
      case "session.shape":
      case "session.run":
      case "session.flag":
      case "session.off":
      case "session.group":
      case "session.wip":
      case "session.paged":
      case "session.visibility":
      case "session.where":
      case "session.landed":
      case "session.skills":
      case "session.paused":
      case "session.from":
      case "session.model":
      case "session.mode":
      case "session.effort":
      case "session.fold":
      case "session.snapshot":
        applySession(state, op, ctx);
        break;
      case "agent.hello":
      case "agent.profile":
      case "agent.avatar":
      case "agent.visibility":
      case "agent.rename":
      case "agent.hidden":
      case "agent.remove":
      case "agent.visual":
        applyAgent(state, op, now);
        break;
      case "launch.add":
      case "launch.cloned":
      case "launch.step":
      case "launch.started":
      case "launch.fail":
      case "launch.retry":
      case "launch.archive":
        applyLaunch(state, op, now);
        break;
      case "question.ask":
      case "question.answer":
        applyQuestion(state, op, ctx);
        break;
      case "todo.add":
      case "todo.done":
      case "todo.remove":
        applyTodo(state, op, ctx);
        break;
      case "file.add":
      case "file.remove":
      case "file.blob":
      case "file.size":
        applyFile(state, op, ctx);
        break;
      case "message.add":
      case "message.release":
      case "message.files":
      case "message.text":
      case "message.drop":
      case "message.fail":
      case "message.retry":
      case "event.deliver":
      case "outbox.ack":
        applyMessage(state, op, ctx);
        break;
      case "workspace.add":
      case "workspace.visibility":
      case "workspace.update":
      case "workspace.remove":
        applyWorkspace(state, op, now);
        break;
      case "task.add":
      case "task.scope":
      case "task.edit":
      case "task.done":
      case "task.sync":
      case "task.move":
      case "task.person":
      case "task.visibility":
      case "task.remove":
      case "task.restore":
      case "task.send":
      case "task.linked":
      case "task.page":
      case "task.link":
      case "wip.moved":
        applyTask(state, op, now);
        break;
      case "page.create":
      case "page.write":
      case "page.restore":
      case "page.visibility":
      case "page.color":
      case "page.contributor":
      case "page.archive":
      case "page.post":
      case "page.told":
        applyPage(state, op, now); // pages.ts
        break;
      case "note.create":
      case "note.write":
      case "note.archive":
      case "note.visibility":
      case "note.person":
      case "note.comment":
      case "note.reply":
      case "note.thread":
      case "note.resolve":
      case "note.suggest":
      case "note.settle":
      case "note.ref":
        applyNote(state, op, now); // notes.ts
        break;
      case "routine.write":
      case "routine.test":
      case "routine.ok":
      case "routine.signed":
      case "routine.on":
      case "routine.fix":
      case "routine.run":
      case "routine.archive":
      case "routine.restore":
      case "routine.remove":
        applyRoutine(state, op, now); // routines.ts
        break;
      case "group.create":
      case "group.edit":
      case "group.member":
      case "group.post":
      case "group.note":
      case "group.note.remove":
      case "group.file":
      case "group.wip":
      case "group.archive":
      case "group.visibility":
      case "group.seen":
      case "group.news":
        applyGroup(state, op, now); // groups.ts
        break;
      case "thread.guest":
      case "thread.seen":
        applyGuest(state, op, now); // guests.ts
        break;
      case "talk.create":
      case "talk.say":
      case "talk.sent":
      case "talk.title":
      case "talk.flag":
      case "talk.visibility":
        applyTalk(state, op, now); // talks.ts
        break;
      case "task.item":
      case "task.pr":
      case "task.seen":
      case "task.order":
      case "task.landing":
      case "task.asked":
      case "task.ship":
        applyTaskShip(state, op, now); // task-ship.ts
        break;
      case "agent.follow":
      case "person.follow":
      case "contact":
      case "thread.people":
        applyFollow(state, op, now);
        break;
      case "bell.seen":
      case "bell.clear":
      case "bell.dismiss":
      case "feed.archive":
      case "routine.thread":
      case "prefs.set":
      case "machine.cloud":
      case "box.member":
      case "box.remove":
      case "image.save":
      case "image.remove":
      case "image.build":
      case "image.built":
      case "auto.archived":
      case "news.add":
      case "private.off":
        applyServer(state, op, now);
        break;
      // Logged only to go up to the server (ops.ts's WorkOp, AuditOp); no state here.
      case "post.steps":
      case "post.images":
      case "post.picture":
      case "post.changes":
      case "machine.audit":
        break;
      default:
        // A kind a reducer handles but this list misses would otherwise do nothing, silently.
        op satisfies never;
    }
  }

  const replay = (op: Logged) => {
    try {
      apply(op);
    } catch (e) {
      console.error(`agentbook: skipped op ${op.seq} (${op.t}):`, e.message);
    }
  };

  // What's saved, read whole before `state` is touched, so a database that turns out corrupt leaves nothing to undo.
  // `moveCorrupt` is agentbook-cli's alone, as what's saved there also went to its server, and only when its storage
  // holds nothing else (Storage.startOver): the store of everything else gets the error, and stays where it is. A
  // database started over doesn't take in the one from before again: what that had is older than what was lost.
  const read = (moved = false) => {
    try {
      if (was) storage.adopt(was, { scope, skip: moved, moveCorrupt, log: (line) => console.log(line) });
      const tables = storage.store(scope);
      if (legacy && tables.empty() && fs.existsSync(LOG)) return { tables };
      const saved = tables.load();
      return { tables, saved, ops: tables.since(saved.checkpoint) };
    } catch (e) {
      if (!moveCorrupt || moved || !isCorrupt(e)) {
        letGo(true);
        throw e;
      }
      const to = storage.startOver();
      if (!to) {
        letGo(true);
        throw e;
      }
      console.error(`agentbook: can't read ${storage.file} (${e.message}): moved to ${to}, with its -wal and -shm if it had them, and starting a new one`);
      return read(true);
    }
  };
  let gone = false;
  const letGo = (broken = false) => {
    if (gone) return;
    gone = true;
    if (broken) storage.releaseBroken();
    else storage.release();
  };
  const { tables, saved, ops: logged } = read();
  if (!saved) {
    // Before the database, ops went to events.jsonl. Replay it once, keep its ops, and keep the file.
    const ops = [];
    for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        ops.push(JSON.parse(line));
      } catch (e) {
        console.error("agentbook: skipped a bad log line:", e.message);
      }
    }
    for (const op of ops) replay(op);
    tables.logAll(ops);
    tables.checkpoint(state);
    fs.renameSync(LOG, `${LOG}.imported`);
    console.log(`agentbook: moved ${ops.length} events from events.jsonl into ${file}`);
  } else {
    Object.assign(state, saved.state, { seq: saved.seq });
    // Tasks saved before they had posts: theirs are the posts they were sent to.
    for (const t of Object.values(state.tasks)) {
      if (t.posts) continue;
      t.posts = [];
      for (const e of t.sent) linkPost(t, e.post, e.at, "sent");
    }
    for (const op of logged) replay(op);
  }
  // Posts saved when sessions could be paused drop what that left on them.
  for (const s of Object.values(state.sessions)) delete s.paused, delete s.stopped;

  // Write the state now and then, and at exit; between checkpoints, the logged ops cover it. What's written can
  // go back to the database (settle).
  // The last op its server has (`acks`): what the log may prune goes no further. 0 until a server first says.
  let acked = Number(tables.meta("acked") || 0);
  // And what each other machine of its person's it's linked to has (uplink.ts's `peer`), by name: the log keeps what
  // any of them hasn't got either, however old, as for its server. A machine unlinked lets go of its hold (hold(name, null)).
  const held: Record<string, number> = (() => {
    try {
      return JSON.parse(tables.meta("held") || "{}");
    } catch {
      return {};
    }
  })();
  const keepFrom = () => Math.min(state.seq, acked, ...Object.values(held));
  let checkpointed = state.seq;
  const checkpoint = (force = false) => {
    if (state.seq === checkpointed && !force) return;
    tables.checkpoint(state);
    if (acks) tables.prune(keepFrom(), ACKED_DAYS);
    else tables.prune(state.seq);
    checkpointed = state.seq;
    settle();
  };
  // Starting up loads every thread's history; past the limit, what was used least lately goes back now.
  if (state.messages.length > MEMORY_MESSAGES) checkpoint(true);
  let failing = null; // what the last checkpoint failed with
  const checkpointTimer = setInterval(() => {
    try {
      checkpoint();
      if (failing) console.log("agentbook: checkpoints work again");
      failing = null;
    } catch (e) {
      // Said once: a full disk stays full, and this runs every few seconds.
      if (e.message !== failing) console.error("agentbook: checkpoint failed:", e.message);
      failing = e.message;
    }
  }, CHECKPOINT_MS).unref();
  process.on("exit", () => {
    if (gone) return;
    try {
      checkpoint();
    } catch {}
    letGo();
  });
  // `agentbook stop` and Ctrl+C end the process through "exit", so the last checkpoint gets written.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));

  // An op takes the next number, and the ids of what it makes are written on it (a message's, a question's, a file's:
  // a UUIDv7, ids.ts), so another store applying the same op makes the same things. Those from before are `m<seq>`,
  // `q<seq>` and `f<seq>`, which another machine's store numbered the same; a UUIDv7 never collides with another's.
  const stamp = (op: Op): Op => {
    if (op.t === "message.add" && !op.mid) return { ...op, mid: uuidv7() };
    if (op.t === "question.ask" && !op.qid) return { ...op, qid: uuidv7() };
    if (op.t === "file.add" && !op.fid) return { ...op, fid: uuidv7() };
    // A thread's name too: picked here (freeName), so agentbook-server's copy of this machine's threads, where
    // which ones are open can differ for a moment, names it the same.
    if (op.t === "session.hello" && op.label && !op.named) return { ...op, label: freeName(state, op, op.session_id || op.proc), named: true };
    return op;
  };
  // Logged before it's applied: one the log couldn't take (a full disk, a locked database) changes nothing, and its
  // error says so (`unsaved`), so what sent it can send it again. Past the log it's kept, whatever applying it does.
  function record<O extends Op>(op: O, at: Iso): Logged<O> {
    const seq = state.seq + 1;
    const full: Logged = { ...stamp(op), seq, at };
    try {
      tables.log(full);
    } catch (e) {
      throw Object.assign(e, { unsaved: true });
    }
    apply(full);
    for (const fn of listeners) fn(full);
    return full as Logged<O>;
  }

  return {
    state,
    storage,
    // Its tables (storage/store.ts): its log and settings, for what keeps more of them than the state (uplink.ts,
    // file-keep.ts, the relay).
    tables,
    scope,
    file: storage.file,
    files: kept,
    filesDir,
    checkpoint,
    saveFailing: () => failing,
    // Drop the logged ops the last checkpoint covers, older than `days` (0: all of them), ahead of the pruning each
    // checkpoint does: after a deletion, so nothing of what went stays in the log.
    pruneLog: (days = 0) => tables.prune(checkpointed, days),
    commit: <T extends OpKind>(op: OpOf<T>): Logged<OpOf<T>> => record(op, new Date().toISOString()),
    // An op from elsewhere (a machine's, on the server), as it happened there: when, and the ids it made.
    ingest: (op) => record(op, op.at || new Date().toISOString()),
    onChange: (fn) => listeners.add(fn),
    pending: (post) => state.outbox.filter((o) => o.post === post && queued(o)),
    // The ops after `seq`, oldest first (the CLI sends them to its server).
    since: (seq) => tables.since(seq),
    // What its server has of it (`acks`): the last op it acknowledged, which may go back (a server restored from a
    // backup has less than it said before). And the last op the log pruned: a server with less than that can't get
    // everything again from the log.
    acked: () => acked,
    setAcked(seq) {
      if (!Number.isFinite(seq) || seq === acked) return;
      tables.setMeta("acked", seq);
      acked = seq;
    },
    // What another machine of its person's has of it, by its name (null: unlinked, so the log keeps nothing for it).
    hold(name: string, seq: number | null) {
      if (seq === null ? !(name in held) : !Number.isFinite(seq) || held[name] === seq) return;
      if (seq === null) delete held[name];
      else held[name] = seq;
      tables.setMeta("held", JSON.stringify(held));
    },
    held: (): Record<string, number> => ({ ...held }),
    pruned: () => Number(tables.meta("pruned") || 0),
    // A part of every thread's history (HISTORY), with what's out of memory, in its order: for a server that has
    // nothing of this machine yet.
    whole: (part) => (cold.size ? tables.inOrder(part, [...state[part], ...tables.rows(part, (p) => cold.has(p))]) : state[part]),
    // Its last checkpoint written, and its hold on its storage let go (the storage closes with the last store's).
    close() {
      clearInterval(checkpointTimer);
      if (gone) return;
      try {
        checkpoint();
      } finally {
        letGo();
      }
    },
  };
}

// What waits in the outbox to be delivered: not yet, not set aside because it couldn't be (message.fail), and not
// held in its post's queue for its turn to end (message.release).
export const queued = (o: OutboxEntry): boolean => !o.delivered && !o.failed && !o.held;

// A thread's history (its questions, files and messages) in memory, back from the database if it was out. Before
// reading any of it for one thread: memory may hold none of it (createStore's warm).
export const warm = (state: Pick<State, "cold">, post: string): void => state.cold?.warm(post);
export const conversationOf = (state: Pick<State, "cold" | "messages">, post: string): Message[] => (warm(state, post), state.messages.filter((m) => m.post === post));
// A file by its id, with its thread's history back in memory; null when there's none.
export const fileOf = (state: Pick<State, "cold" | "files">, fid: string): FileRecord | null => state.files.find((f) => f.id === fid) || (state.cold?.file(fid), state.files.find((f) => f.id === fid)) || null;
// What memory doesn't hold of a part of threads' histories ("questions", "files", "messages"), from the database:
// copies, which nothing changes. `posts`: only those threads'.
export const outOfMemory = <P extends HistoryPart>(state: Pick<State, "cold">, part: P, posts: Set<string> | null = null): State[P] => state.cold?.rows(part, posts) || [];
// What the feed shows of a thread's history: how many messages (not those queued) and files (not those in a page
// or not sent yet), the latest few of each, its latest pictures (its card's cover) and its life (its strip). Kept for
// a thread whose history is out of memory.
const COVER = 7;
function feedOf(messages: Message[] = [], files: FileRecord[] = [], questions: Question[] = [], s: Session | null = null): FeedSummary {
  const said = messages.filter((m) => !m.queued);
  const shown = files.filter((f) => !f.embedded && !f.pending);
  const pics = shown.filter(isPicture);
  return { messages: said.length, last_messages: said.slice(-3), files: shown.length, last_files: shown.slice(0, 3), pictures: pics.length, last_pictures: pics.slice(0, COVER), life: s ? lifeOf(s, { messages, questions, files: shown }) : null };
}

// Its pictures, newest first: as kept when its history went out of memory, or from its files.
function picturesOf(out: FeedSummary | null | undefined, files: FileRecord[]): { pictures: number; last_pictures: FileRecord[] } {
  if (out?.last_pictures) return { pictures: out.pictures, last_pictures: out.last_pictures };
  const pics = out ? (out.last_files || []).filter(isPicture) : files.filter(isPicture);
  return { pictures: pics.length, last_pictures: pics.slice(0, COVER) };
}

// API errors that pass with time (Claude Code's kinds of them): the network dropped, the computer slept mid-reply, the
// API was overloaded. agentbook-cli picks a background session up again after one of these. Any other (its login
// expired, its account, a usage limit, a refused request) stops it until someone does something, so it needs you.
export const PASSING_ERRORS = new Set(["server_error", "overloaded"]);
// What of a thread says whether it stopped, and how far along it is: a whole one, or a view's row of one.
type Progress = Partial<Pick<Session, "state" | "busy" | "asleep" | "archived" | "failed">>;
const stopped = (s: Progress): boolean => !s.busy && !s.archived && !!s.failed && !PASSING_ERRORS.has(s.failed.error);
// What stopped it, in a line: the first thing Claude Code said, without the link it gives.
const stopLine = (f: SessionFailure): string => (f.text || "An API error ended its turn").split(/(?<=\.)\s/)[0].replace(/\s*\(https?:[^)]*\)/, "");

// The verdicts (ab_verdict) a turn ends on when it can't go on without you: it needs your decision or OK, or it's
// blocked on something only you can fix.
const ASKING = new Set(["needs_you", "blocked"]);
// What a thread's last turn ended asking of you, from its latest messages (`said`, none of them queued): its verdict
// ({ kind, line }) when the last thing said is the agent's reply that ended a turn on one of those, else null. You
// writing to it (a routine's run too) comes after it; answering what it asked wakes it, and then it's working. What you
// sent on the side (via "side") went to a side thread, not to it: it's still asking.
// `said`: its messages, oldest first.
export function endedAsking(said: Message[] | null | undefined): { kind: string; line: string; at: Iso } | null {
  const m = said?.filter((x) => x.via !== "side").at(-1);
  const v = m?.from === "agent" ? m.shape?.verdict : null;
  return v && ASKING.has(v.kind) ? { kind: v.kind, line: String(v.line || ""), at: m.at } : null;
}

// A session's state in a word: done, needs (you), working, or idle between turns. One that's asleep is done
// too, unless it asked you something: either way it isn't running, and writing to it picks it back up. One with
// work going on its own between turns (`going`: a shell watching a CI run, a monitor) is working on that. One an API
// error stopped needs you (`stopped`), and so does one whose turn ended saying it needs you or is blocked (`asking`,
// endedAsking), until you write to it or archive it.
// `open`: its open questions; `going`: what it has going between turns; `asking`: what its last turn ended asking.
export function effective(s: Progress, open: number, going = 0, asking: unknown = null): "done" | "needs" | "working" | "idle" {
  if (s.state === "done") return "done";
  if (open || s.state === "waiting") return "needs";
  // It can't go on until you do.
  if (stopped(s)) return "needs";
  if (s.busy || s.state === "working" || (going && !s.asleep)) return "working";
  if (asking && !s.archived) return "needs";
  return s.asleep ? "done" : "idle";
}
// Its state (`effective`), and, when it isn't a question or a prompt that makes it need you, what does (`asking`), for
// the bell to list with the questions: the error that stopped it, or its last turn's verdict.
function stateOf(s: Session, open: number, going: number, said: Message[]): { effective: ReturnType<typeof effective>; asking?: { kind: string; line: string; at: Iso } | null } {
  const asking = endedAsking(said);
  const e = effective(s, open, going, asking);
  if (e !== "needs" || open || s.state === "waiting") return { effective: e };
  return { effective: e, asking: stopped(s) ? { kind: "stopped", line: stopLine(s.failed), at: s.failed.at } : asking };
}

// Without a title of its own, its runtime's name for it or else its prompt's first line, with the pages and widgets
// either names in words (a name agentbook gave it at the start is that first line too: OpenClaw's).
const titleOf = (s: Session, pages: Record<string, Page> = {}): string => s.title || (s.ai_title ? plainMentions(s.ai_title, pages) : null) || (s.prompt ? plainMentions(s.prompt.split("\n")[0], pages).slice(0, 120) : null) || "New thread";

// The feed: every post in summary, plus what needs you. Full conversations load per session. `going(s)`: what a
// session has going between its turns, as its runtime knows it ([{ id, kind, title, started }]).
// What a thread has going between its turns, as its runtime knows it.
type Going = (s: Session) => { id: string; kind: string; title: string; started: Iso }[] | null;
export function publicState(state: State, { going = () => null }: { going?: Going } = {}) {
  const open: Record<string, number> = {};
  const asked: Record<string, Question[]> = {};
  for (const q of state.questions) {
    if (!q.answered) open[q.post] = (open[q.post] || 0) + 1;
    (asked[q.post] ||= []).push(q);
  }
  // Its conversation, and apart from it, what you queued for when its turn ends.
  const byPost: Record<string, Message[]> = {};
  const queueOf: Record<string, Message[]> = {};
  for (const m of state.messages) ((m.queued ? queueOf : byPost)[m.post] ||= []).push(m);
  const filesBy: Record<string, FileRecord[]> = {};
  for (const f of state.files) if (!f.embedded && !f.pending && f.post) (filesBy[f.post] ||= []).push(f);
  const pageOf = postPages(state);
  const sessions = Object.values(state.sessions).map((s) => {
    // One whose history is out of memory: as kept when it went (feedOf).
    const out = state.cold?.summary(s.id);
    const msgs = byPost[s.id] || [];
    // Its code blocks' runs are for its own page (sessionDetail), not every list it's in (a feed card gets those of
    // the messages it shows from the server, cardRuns).
    const { skills, skill_uses, runs, ...rest } = s;
    const work = s.state !== "done" && !s.asleep ? going(s) : null;
    const said = out ? out.last_messages : msgs.slice(-3);
    const how = stateOf(s, open[s.id], work?.length, said);
    return {
      ...rest,
      title: titleOf(s, state.pages),
      own_title: s.title,
      open_questions: open[s.id] || 0,
      ...how,
      ...(work?.length ? { going: work } : {}),
      messages: out ? out.messages : msgs.length,
      last_messages: said,
      ...(queueOf[s.id] ? { queue: queueOf[s.id] } : {}),
      files: out ? out.files : (filesBy[s.id] || []).length,
      last_files: out ? out.last_files : (filesBy[s.id] || []).slice(0, 3),
      ...picturesOf(out, filesBy[s.id] || []),
      life: out ? (out.life ?? null) : lifeKept(s, { messages: msgs, questions: asked[s.id] || [], files: filesBy[s.id] || [] }),
      updates: s.updates.slice(-5),
      page: pageOf[s.id] || null,
    };
  });
  sessions.sort((a, b) => b.updated.localeCompare(a.updated));
  const agents = Object.values(state.agents).map((a) => {
    const mine = sessions.filter((s) => s.agent === a.id);
    // What's live on it counts what's in the feed: an archived or hidden post isn't (unless it needs you).
    const count = (e) => mine.filter((s) => s.effective === e && ((!s.archived && !s.hidden) || e === "needs")).length;
    return { ...a, sessions: mine.length, working: count("working"), needs: count("needs"), idle: count("idle"), done: count("done") };
  });
  // The folders sessions ran in (a checkout's, for one in a worktree), each with how many and how lately.
  const folders: Record<string, { root: string; name: string; sessions: number; live: number; last: Iso }> = {};
  for (const s of sessions) {
    if (!s.root) continue;
    const f = (folders[s.root] ||= { root: s.root, name: s.repo || path.basename(s.root), sessions: 0, live: 0, last: s.updated });
    f.sessions++;
    if (s.effective !== "done" && !s.archived && !s.hidden) f.live++;
  }
  const recent = Date.now() - 3600e3;
  return {
    seq: state.seq,
    agents,
    sessions,
    folders: Object.values(folders).sort((a, b) => b.last.localeCompare(a.last)),
    questions: state.questions.filter((q) => !q.answered || Date.parse(q.answered) > recent),
    launches: Object.values(state.launches).filter((l) => Date.now() - Date.parse(l.at) < 600e3),
    pages: Object.values(state.pages).map((p) => pageSummary(p, state)).sort((a, b) => b.updated.localeCompare(a.updated)),
    groups: Object.values(state.groups).map((g) => groupSummary(state, g)).sort((a, b) => b.updated.localeCompare(a.updated)),
  };
}

// One post, in full.
// `going`: what it has going between its turns, as publicState's.
export function sessionDetail(state: State, key: string, { going = () => null }: { going?: Going } = {}) {
  const s = state.sessions[key];
  if (!s) return null;
  warm(state, key);
  const open = state.questions.filter((q) => q.post === key && !q.answered).length;
  const work = s.state !== "done" && !s.asleep ? going(s) : null;
  const messages = state.messages.filter((m) => m.post === key);
  return {
    ...s,
    title: titleOf(s, state.pages),
    own_title: s.title,
    open_questions: open,
    ...stateOf(s, open, work?.length, messages.filter((m) => !m.queued).slice(-1)),
    ...(work?.length ? { going: work } : {}),
    messages,
    files: state.files.filter((f) => f.post === key && !f.embedded && !f.pending),
    questions: state.questions.filter((q) => q.post === key),
    page: postPages(state)[key] || null,
    life: lifeOf(s, { messages: state.messages.filter((m) => m.post === key), questions: state.questions.filter((q) => q.post === key), files: state.files.filter((f) => f.post === key && !f.embedded && !f.pending) }),
  };
}
