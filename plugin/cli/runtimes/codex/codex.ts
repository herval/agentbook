// Codex sessions, through Codex's own app-server daemon: the threads `codex agents` and the Codex apps show.
// agentbook connects to the daemon's control socket (WebSocket over a unix socket, kit/ws.ts) and speaks its
// JSON-RPC (kit/rpc.ts, without the "jsonrpc" field, as Codex does).
//
// - A thread is a post on the Codex profile, keyed by thread id. agentbook lists recent threads, and
//   follows the ones loaded in the daemon: their status, every item (commands, edits, messages), the plan.
// - Writing on a post sends a turn (or steers the running one); writing on a post whose thread isn't
//   loaded resumes it first. Posting on the Codex wall starts a thread.
// - Each message agentbook sends goes with an id of its own (clientUserMessageId), which Codex gives back on the
//   userMessage item it makes of it: that's how the adapter knows its own messages from what someone typed in Codex,
//   and shows each once (echoes "self").
// - Sending on the side forks the thread (`thread/fork`) into a side thread of its own, which
//   goes on with what you sent while the thread works on.
// - Codex's approval requests (run a command, edit files, more access) become Allow/Deny prompts on the
//   post, and its questions become polls. Stop interrupts the running turn.
// - A model picked for a thread goes with its next turn (`turn/start` takes one, for that turn and the
//   ones after). Its models come from its live account catalog, with `model/list` as a fallback.
// - Its slash commands are the calls its app-server has for them (commands.ts).
//
// Threads that run in a standalone `codex` (not through the daemon) are listed, but their progress only
// shows when they're loaded in the daemon.
//
// Its routines are the ChatGPT app's Codex automations (automations.ts). The threads their runs start
// stay off the feed: they're on their routine, and open there.
//
// Its usage limits (limits.ts) are its ChatGPT plan's, what `/status` shows: `account/rateLimits/read`, when its
// profile asks, at most once a minute, or again once Codex says they moved (`account/rateLimits/updated`).

import { agentDirectory, agentEnvironment, currentAgentConfig } from "../../agent-context.ts";
import { textOf } from "../../../shared/text.ts";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMITS, codexEdits, noteEdit, shaIn } from "../../changes.ts";
import { notePrs } from "../../../shared/prs.ts";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import { codexWhy } from "../../../shared/whynot.ts";
import { cleanEnv } from "../../../lib/common.ts";
import { isOlder, runCommand } from "../../runtime-update.ts";
import { said } from "../../transcript.ts";
import { codexLimitsOf, limitsReader } from "../../limits.ts";
import { going as workerGoing, settle, stateOf } from "../../workers.ts";
import { connectWs } from "../kit/ws.ts";
import type { WsConnection } from "../kit/ws.ts";
import { createRpc } from "../kit/rpc.ts";
import type { RpcMessage } from "../kit/rpc.ts";
import { poll } from "../kit/poll.ts";
import { startFolder } from "../kit/spawn.ts";
import { blank as blankDigest, KEEP, liveOf, short, summaryOf } from "../kit/steps.ts";
import type { Digest, Step } from "../kit/steps.ts";
import type { CodexFileChange } from "../../../shared/diff.ts";
import { codexRoutines } from "./automations.ts";
import { createModelReader } from "./models.ts";
import { createCommands } from "./commands.ts";
import { equip, modeSettings, offerTools, turnModeSettings } from "./tools.ts";
import { cwdOf, errorOf, failed, heartbeatOf, iso, ownTurns, PLAN, settingsOf, stepOf, unwrap } from "./items.ts";
import type { CodexConfigRead, CodexInput, CodexItem, CodexList, CodexModel, CodexSettings, CodexSkill, CodexThread, CodexThreadReply } from "./items.ts";
import type { AnswerEvent, OutboxEvent, PermissionEvent, Session } from "../../../shared/types.ts";
import type { Worker } from "../../workers.ts";
import type { PastSession, Runtime, RuntimeContext, SideRequest, StartRequest } from "../runtime.ts";

const DAYS = Number(process.env.AGENTBOOK_CODEX_DAYS || 14);
// How many pages of 100 threads the welcome card's list reads, at most.
const PAST_PAGES = 30;
const HOST = os.hostname().split(".")[0];
// Headless `codex exec` runs stay off agentbook, like `claude -p` (AGENTBOOK_CODEX_EXEC=1 shows them).
const SOURCES = new Set(["cli", "vscode", "appServer", ...(process.env.AGENTBOOK_CODEX_EXEC === "1" ? ["exec"] : [])]);
const QUIET_S = Number(process.env.AGENTBOOK_CODEX_QUIET_S || 3600); // an idle thread untouched this long is over
const CALL_MS = 30e3;

const userFacing = (t: CodexThread) => (typeof t.source === "string" ? SOURCES.has(t.source) : !!t.source?.custom) && !t.ephemeral && t.threadSource !== "automation";

// A thread's digest: its steps and stats (kit/steps.ts), and the items already counted in its edits and commits
// (`noted`).
interface CodexDigest extends Digest {
  byId: Map<string, Step>;
  noted: Set<string>;
}
const blank = (): CodexDigest => Object.assign(blankDigest(), { noted: new Set<string>() });

// What agentbook keeps of a thread it follows: its folder, whether it's subscribed to its events, the turn it's running
// (and how many turns it heard start or end, `turnsHeard`), the messages agentbook sent it (by their client ids), what
// it last said in this turn, its digest, when it was last read whole (ms), what it runs with, its subagents as workers,
// its fileChange items' changes by item, and whether a compaction it started is running.
interface ThreadState {
  cwd: string;
  subscribed: boolean;
  turn: string | null;
  turnsHeard: number;
  sent: Set<string>;
  lastSay: string | null;
  digest: CodexDigest;
  read: number;
  settings?: CodexSettings | null;
  workers?: Map<string, Worker>;
  changes?: Record<string, { path: string }[]>;
  compacting?: boolean;
}
// A request Codex is waiting on agentbook to answer (an approval, or its questions), by its key on the thread's
// prompt: the call to answer, the thread, and for questions, each prompt's question (`asks`: qid -> question id) and
// the answers so far.
interface Request {
  rpcId: RpcMessage["id"];
  method: string;
  post: string;
  params: Record<string, unknown> & { permissions?: unknown };
  asks?: Map<string, string>;
  answers?: Record<string, { answers: string[] }>;
}

export function createCodex(): Runtime {
  const config = currentAgentConfig();
  const AGENT = config?.id || "codex";
  const NAME = config?.name || "Codex";
  const SOCK = (!config && process.env.AGENTBOOK_CODEX_SOCK) || path.join(agentDirectory("codex"), "app-server-control", "app-server-control.sock");
  let ctx: RuntimeContext = null;
  const log = (line: string) => ctx?.log(line);
  const threads = new Map<string, ThreadState>();
  const requests = new Map<string, Request>(); // request key (on the question) -> what it answers
  let conn: WsConnection | null = null;
  let ready: Promise<WsConnection> | null = null;
  let enabled = process.env.AGENTBOOK_CODEX !== "0";
  let retry = 2000;
  let lastError = null;
  let version = null; // its daemon's, from initialize

  /* ---------- connection ---------- */

  const rpc = createRpc({
    name: NAME,
    lite: true,
    send: (json) => void conn?.send(json),
    errorText: (message) => message || "Codex error",
    onMessage: (m) => {
      if (m.id != null) return onRequest(m).catch((e) => log(`codex request ${m.method}: ${e.message}`));
      try {
        onNotification(m.method, m.params || {});
      } catch (e) {
        log(`codex ${m.method}: ${e.message}`);
      }
    },
  });
  const call = <T = unknown>(method: string, params?: unknown): Promise<T> => (conn ? rpc.call<T>(method, params, CALL_MS) : Promise.reject(new Error("Not connected to Codex")));
  const modelReader = createModelReader({
    call: () => call<CodexList<CodexModel>>("model/list", {}),
    version: () => version,
    usesOpenai: async () => {
      const r = await call<CodexConfigRead>("config/read", { includeLayers: false });
      return !r?.config?.model_provider || r.config.model_provider === "openai";
    },
  });

  function startDaemon() {
    return new Promise<void>((resolve) =>
      execFile(process.env.AGENTBOOK_CODEX_BIN || "codex", ["app-server", "daemon", "start"], { timeout: 30000, env: agentEnvironment() }, (err: NodeJS.ErrnoException) => {
        if (err?.code === "ENOENT") {
          enabled = false;
          log("codex: not installed");
        } else if (err) log(`codex: couldn't start its daemon: ${err.message}`);
        resolve();
      }),
    );
  }

  function connect(): Promise<WsConnection> {
    if (!enabled) return Promise.reject(new Error("Codex isn't installed here."));
    ready ||= (async () => {
      if (!fs.existsSync(SOCK)) await startDaemon();
      if (!enabled) throw new Error("Codex isn't installed here.");
      conn = await connectWs(SOCK, { onMessage: (text) => rpc.line(text), onClose });
      // Its daemon's version is in the user agent it answers with: "agentbook/0.160.0 (Mac OS …)".
      const hi = await call<{ userAgent?: string }>("initialize", { clientInfo: { name: "agentbook", title: "agentbook", version: "2.0" } });
      version = /^[^/\s]+\/(\d[\w.-]*)/.exec(hi?.userAgent || "")?.[1] || version;
      rpc.notify("initialized", {});
      retry = 2000;
      lastError = null;
      log("codex: connected");
      loadModels().catch(() => {});
      offerTools(ctx, call).catch((e) => log(`codex: couldn't give its threads agentbook's tools: ${e.message}`));
      return conn;
    })().catch((e) => {
      ready = null;
      conn = null;
      lastError = e.message;
      throw e;
    });
    return ready;
  }

  function onClose() {
    conn = null;
    ready = null;
    rpc.fail(new Error("Codex disconnected"));
    for (const th of threads.values()) Object.assign(th, { subscribed: false });
    log("codex: disconnected");
    setTimeout(() => sync().catch(() => {}), (retry = Math.min(retry * 2, 60000)));
  }

  /* ---------- threads and posts ---------- */

  const post = (id: string) => ctx.state.sessions[id];
  const changed = (id: string) => void ctx.emit({ e: "changed", thread: id });
  // Keep the post's summary (title, model, plan, stats) in the log, like Claude's.
  const snapshot = (id: string) => void (post(id) && ctx.emit({ e: "changed", thread: id, save: true }));
  const say = (id: string, text: string) => void ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text });

  const spawnedBy = new Map<string, string>(); // a spawned agent's thread id -> the thread that spawned it
  // The post a thread's calls to agentbook's tools write to: its own, or, for an agent a thread spawned (no post of
  // its own), the post of the thread that spawned it, as a Claude subagent's write to its session's. A call means
  // it's running, so a post agentbook took for over (a codex CLI thread that went quiet) is back.
  function postOf(id: string) {
    for (let at = id, hops = 0; at && hops < 10; at = spawnedBy.get(at), hops++)
      if (post(at)) {
        revive(at);
        return at;
      }
    return id;
  }
  const thread = (id: string) => {
    if (!threads.has(id)) threads.set(id, { cwd: "", subscribed: false, turn: null, turnsHeard: 0, sent: new Set(), lastSay: null, digest: blank(), read: 0 });
    return threads.get(id);
  };

  /* ---------- the agents a thread spawns ---------- */

  // A thread's agent can spawn agents (spawnAgent), which run as threads of their own and stay off agentbook: each is
  // a worker (workers.ts) of the thread that spawned it. The spawn, and its calls after it (wait, closeAgent…), say
  // how each is going (agentsStates); so do its activity items (subAgentActivity).
  const AGENT_STATES = { interacted: "running" };
  function worker(id: string, child: string, { title, at }: { title: unknown; at: string }) {
    const th = thread(id);
    th.workers ||= new Map();
    if (!th.workers.has(child)) {
      th.workers.set(child, { id: child, title: short(String(title || "A subagent").split("\n")[0], 120), state: "running", started: at, ended: null, error: null, step: null, n: 0 });
      spawnedBy.set(child, id);
      if (th.workers.size > 200) th.workers.delete(th.workers.keys().next().value);
    }
    return th.workers.get(child);
  }
  function noteAgents(id: string, item, at: string) {
    if (item.type === "subAgentActivity" && item.agentThreadId) {
      const w = item.kind === "started" ? worker(id, item.agentThreadId, { title: item.agentPath, at }) : thread(id).workers?.get(item.agentThreadId);
      if (w) settle(w, stateOf(item.kind) || AGENT_STATES[item.kind], at);
      return;
    }
    if (item.type !== "collabAgentToolCall") return;
    for (const child of item.receiverThreadIds || []) {
      const w = item.tool === "spawnAgent" ? worker(id, child, { title: item.prompt, at }) : thread(id).workers?.get(child);
      const st = item.agentsStates?.[child];
      if (!w || !st) continue;
      // Closed: one still going was stopped; one that had finished stays as it ended.
      if (st.status === "shutdown") {
        if (workerGoing(w)) settle(w, "stopped", at);
      } else settle(w, stateOf(st.status), at, st.status === "errored" && st.message ? short(st.message, 300) : null);
    }
  }
  // A spawned agent's own events, when Codex sends them: the step it's on.
  function agentEvent(id: string, child: string, method: string, p) {
    const w = thread(id).workers?.get(child);
    const title = method === "item/started" && w && stepOf(p.item, thread(id).cwd);
    if (!title) return;
    w.step = { title, at: p.startedAtMs ? new Date(p.startedAtMs).toISOString() : new Date().toISOString() };
    w.n = (w.n || 0) + 1;
    changed(id);
  }
  // Its workers, each with its last step while it's going.
  const workersOf = (id: string): Worker[] => [...(threads.get(id)?.workers?.values() || [])].map((w) => (workerGoing(w) ? { ...w } : { ...w, step: null }));
  // A worker's steps, from its own thread (thread/read): read when you open it on its thread's page. What it said, and
  // each item it ran, at its turn's times (Codex gives an item none of its own). Its latest WORKER_STEPS.
  const WORKER_STEPS = 40;
  async function workerStepsOf(id: string, child: string) {
    const w = threads.get(id)?.workers?.get(child);
    if (!w) return null;
    const t = (await call<CodexThreadReply>("thread/read", { threadId: child, includeTurns: true }))?.thread;
    const cwd = (t && cwdOf(t)) || thread(id).cwd;
    const steps = [];
    for (const turn of t?.turns || []) {
      const at = iso(turn.startedAt) || w.started;
      const end = iso(turn.completedAt);
      for (const item of turn.items || []) {
        if (item.type === "agentMessage") {
          if (item.text?.trim()) steps.push({ id: item.id, kind: "say", at: end || at, text: said(item.text) });
          continue;
        }
        const title = stepOf(item, cwd);
        if (!title) continue;
        const over = item.status ? item.status !== "inProgress" : !!end;
        steps.push({ id: item.id, kind: "tool", tool: item.type, at, title, ...(over ? { done: end || at } : {}), ...(over && failed(item) ? { error: errorOf(item) } : {}) });
      }
    }
    const n = steps.filter((x) => x.kind === "tool").length;
    if (n > (w.n || 0)) w.n = n;
    return { steps: steps.slice(-WORKER_STEPS), n };
  }

  // A thread nothing has happened in yet (a new one opened in Codex, nothing sent): no first message, no name,
  // no turns, not running. It gets its post at its first turn, as a Claude session in a terminal gets its thread
  // at its first prompt, so opening Codex and leaving leaves nothing behind. Until then it's held here.
  const untried = (t: CodexThread) => !String(t.preview || "").trim() && !t.name && !(t.turns || []).length && t.status?.type !== "active";
  const held = new Map<string, CodexThread>(); // thread id -> the thread, as Codex last said it
  const siding = new Map<string, number>(); // thread id -> side threads being forked from it (side)

  // Make sure a thread has a post, or hold it if nothing has happened in it yet (null), or nothing since where its
  // person said the past starts: a thread still loaded in Codex stays off until it's used again. `lid`: the launch it
  // answers, so the post takes over its placeholder; `active`: something is happening in it.
  function ensurePost(t: CodexThread, { lid, active = false }: { lid?: string; active?: boolean } = {}): Session | null {
    const th = thread(t.id);
    th.cwd = cwdOf(t) || th.cwd;
    if (t.model) th.digest.model = t.model;
    if (t.name) th.digest.ai_title = short(t.name, 120);
    const known = post(t.id);
    if (known && !lid) return known;
    if (!known && !lid && !active && (untried(t) || t.updatedAt < (ctx.historyFrom?.() || 0) / 1000 || ctx.pastOut?.("codex", th.cwd, t.updatedAt * 1000))) {
      held.set(t.id, t);
      return null;
    }
    held.delete(t.id);
    const g = ctx.gitInfo(th.cwd);
    ctx.emit({
      e: "thread",
      thread: t.id,
      agent: AGENT,
      agent_name: NAME,
      kind: "codex",
      cwd: th.cwd,
      root: g.root,
      repo: g.repo,
      branch: t.gitInfo?.branch || g.branch,
      host: HOST,
      launch: lid,
      started: iso(t.createdAt) || undefined,
      updated: iso(t.updatedAt) || undefined,
      prompt: t.preview ? short(t.preview, 2000) : undefined,
    });
    snapshot(t.id);
    return post(t.id) || null;
  }

  // A post that ended comes back when its thread does: the same hello it had (the core fills it in).
  function revive(id: string) {
    if (post(id)?.state === "done") ctx.emit({ e: "thread", thread: id, agent: AGENT, agent_name: NAME, kind: "codex" });
  }

  // How a thread is, as Codex says it: running (and waiting on you, for an approval or an answer), idle, or gone.
  function setStatus(id: string, status: CodexThread["status"]) {
    const s = post(id);
    if (!s || !status) return;
    if (status.type === "active") {
      const flags = status.activeFlags || [];
      const st = flags.length ? "waiting" : "working";
      const text = flags.includes("waitingOnApproval") ? "Waiting for your approval" : flags.includes("waitingOnUserInput") ? "Waiting for your answer" : undefined;
      ctx.emit({ e: "turn.start", thread: id });
      // Within its turn: waiting on you, or working again.
      if (post(id).state !== st) ctx.emit({ e: "fact", op: { t: "session.status", post: id, state: st, text } });
    } else if (status.type === "idle") {
      revive(id);
      ctx.emit({ e: "turn.end", thread: id });
    } else if (status.type === "notLoaded" || status.type === "systemError") {
      ctx.emit({ e: "gone", thread: id, reason: status.type === "systemError" ? "Codex hit an error" : "Closed" });
    }
  }

  // A Codex that won't take agentbook's tools still runs the thread, without them.
  // `method`: one that loads a thread (thread/start, thread/resume, thread/fork).
  async function loading(method: string, params: Record<string, unknown>, extra: Record<string, unknown>) {
    try {
      return await call<CodexThreadReply>(method, { ...params, ...extra });
    } catch (e) {
      if (/didn't answer|Not connected/.test(e.message)) throw e; // it may have done it: don't do it twice
      log(`codex ${method} with agentbook's tools: ${e.message}; trying without them`);
      return await call<CodexThreadReply>(method, params);
    }
  }

  // Subscribe to a thread's events (loading it in the daemon if it isn't).
  async function follow(id: string) {
    await connect();
    const th = thread(id);
    if (th.subscribed) return th;
    const r = await loading("thread/resume", { threadId: id, excludeTurns: true, ...modeSettings(post(id)?.mode) }, equip(ctx, `codex:${id}`, th.cwd || post(id)?.cwd));
    th.subscribed = true;
    th.settings = settingsOf(r) || th.settings;
    // Subagents' threads stay off agentbook; their parent's post shows their work.
    if (r?.thread && userFacing(r.thread)) {
      ensurePost(r.thread);
      setStatus(id, r.thread.status);
    }
    return th;
  }

  // Recent threads, and every thread the daemon has loaded. Runs at start and every 15 seconds.
  let syncing: Promise<void> | null = null;
  function sync() {
    syncing ||= (async () => {
      await connect();
      // Codex is an agent here once its daemon answers, before it has a thread, so there's one to start a thread with.
      const a = ctx.state.agents[AGENT];
      if (!a || (version && a.version !== version)) ctx.emit({ e: "agent", agent: AGENT, name: a?.name || NAME, kind: a?.kind || "codex", ...(version ? { version } : {}) });
      if (!modelReader.get().list.length) loadModels().catch(() => {});
      const since = (ctx.pastSince ? ctx.pastSince("codex", DAYS) : Math.max(Date.now() - DAYS * 86400e3, ctx.historyFrom?.() || 0)) / 1000;
      const list = await call<CodexList<CodexThread>>("thread/list", { limit: 50, sortKey: "updated_at", sourceKinds: [...SOURCES] });
      const loaded = new Set((await call<CodexList<string>>("thread/loaded/list", {}))?.data || []);
      for (const t of list?.data || []) {
        if (!userFacing(t)) continue;
        const isLoaded = loaded.has(t.id);
        if (!post(t.id) && !isLoaded && t.updatedAt < since) continue;
        const fresh = !post(t.id);
        if (!ensurePost(t)) continue;
        if (!isLoaded) {
          // Not in the daemon. A thread updated in the last few minutes is probably open in a standalone codex.
          const recent = Date.now() / 1000 - t.updatedAt < 180;
          if (!recent) ctx.emit({ e: "gone", thread: t.id, reason: "Closed", ended: iso(t.updatedAt) });
          else if (fresh) ctx.emit({ e: "fact", op: { t: "session.status", post: t.id, state: "idle", text: "Open in another Codex window" } });
        } else if (t.status?.type === "idle" && Date.now() / 1000 - t.updatedAt > QUIET_S) {
          // Loaded in the daemon, but untouched for an hour: it's over until you write to it, or it's used again.
          ctx.emit({ e: "gone", thread: t.id, reason: "Quiet", ended: iso(t.updatedAt) });
        } else setStatus(t.id, t.status);
        if (t.name && thread(t.id).digest.ai_title !== short(t.name, 120)) {
          thread(t.id).digest.ai_title = short(t.name, 120);
          snapshot(t.id);
        }
      }
      for (const id of loaded) if (!thread(id).subscribed) await follow(id).catch((e) => log(`codex follow ${id}: ${e.message}`));
      for (const s of Object.values(ctx.state.sessions)) if (s.agent === AGENT && ctx.pending(s.id).length) ctx.deliver(s.id);
    })().finally(() => (syncing = null));
    return syncing;
  }

  // Its threads from before, for the welcome card (plugin/cli/history.ts): every one Codex lists, newest first, a
  // page at a time. Those picked come in as the sync brings in its recent ones: a thread each, ended.
  const listed = new Map<string, CodexThread>();
  async function pastList(): Promise<PastSession[]> {
    if (!enabled) return [];
    await connect();
    const out: PastSession[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < PAST_PAGES; page++) {
      const got = await call<CodexList<CodexThread>>("thread/list", { limit: 100, sortKey: "updated_at", sourceKinds: [...SOURCES], ...(cursor ? { cursor } : {}) });
      for (const t of got?.data || []) {
        if (!userFacing(t) || untried(t)) continue;
        listed.set(t.id, t);
        out.push({ id: t.id, at: t.updatedAt * 1000, cwd: cwdOf(t) || null });
      }
      cursor = got?.nextCursor || null;
      if (!cursor) break;
    }
    return out;
  }
  async function pastBring(ids: string[]) {
    const loaded = new Set((await call<CodexList<string>>("thread/loaded/list", {}))?.data || []);
    for (const id of ids) {
      const t = listed.get(id);
      if (!t || post(id)) continue;
      if (!ensurePost(t, { active: true })) continue;
      if (!loaded.has(id)) ctx.emit({ e: "gone", thread: id, reason: "Closed", ended: iso(t.updatedAt) });
      await new Promise((r) => setImmediate(r));
    }
  }

  /* ---------- what Codex sends ---------- */

  function onNotification(method: string, p) {
    if (method === "account/rateLimits/updated") return void limits.stale();
    if (method === "account/updated") {
      return void loadModels().catch(() => {});
    }
    if (method === "skills/changed") return void commands.forget();
    const id = p.threadId || p.thread?.id;
    if (method === "thread/started") {
      // A side thread's post is side()'s to make, under its own name: the fork starts with the thread's, and a thread
      // keeps the first name it's given (the store's session.snapshot).
      if (userFacing(p.thread) && !siding.has(p.thread?.forkedFromId)) ensurePost(p.thread);
      // An agent a thread spawned: its worker, by the name it was given.
      const spawn = p.thread?.source?.subAgent?.thread_spawn;
      if (spawn?.parent_thread_id && post(spawn.parent_thread_id)) {
        worker(spawn.parent_thread_id, p.thread.id, { title: spawn.agent_nickname || spawn.agent_role, at: iso(p.thread.createdAt) || new Date().toISOString() });
        changed(spawn.parent_thread_id);
      }
      return;
    }
    if (id && spawnedBy.has(id) && !post(id)) return void agentEvent(spawnedBy.get(id), id, method, p);
    // A held thread's first turn makes its post; one closed before anything happened in it is let go.
    if (id && held.has(id) && !post(id)) {
      if (method === "turn/started" || method.startsWith("item/") || (method === "thread/status/changed" && p.status?.type === "active")) ensurePost(held.get(id), { active: true });
      else if (method === "thread/closed" || (method === "thread/status/changed" && p.status?.type === "notLoaded")) held.delete(id);
    }
    if (!id || !threads.has(id) || !post(id)) return;
    const th = thread(id);
    const d = th.digest;
    switch (method) {
      case "thread/status/changed":
        return setStatus(id, p.status);
      case "thread/name/updated":
        d.ai_title = p.threadName ? short(p.threadName, 120) : d.ai_title;
        return snapshot(id);
      case "thread/closed":
        th.subscribed = false;
        return setStatus(id, { type: "notLoaded" });
      case "turn/started":
        th.turn = p.turn?.id || null;
        th.turnsHeard++;
        th.lastSay = null;
        ctx.emit({ e: "turn.start", thread: id });
        return changed(id);
      case "turn/completed": {
        th.turn = null;
        th.turnsHeard++;
        d.worked += Number(p.turn?.durationMs) || 0;
        if (p.turn?.error?.message) say(id, `Stopped: ${codexWhy(p.turn.error.message, ctx.machine)}`);
        else if (th.lastSay) say(id, th.lastSay);
        th.lastSay = null;
        ctx.emit({ e: "turn.end", thread: id, text: p.turn?.status === "interrupted" ? "Stopped" : "Finished, waiting for your next message" });
        return snapshot(id);
      }
      case "turn/plan/updated":
        d.plan = (p.plan || []).map((x) => ({ text: short(x.step, 120), now: short(x.step, 120), status: PLAN[x.status] || "pending" }));
        return changed(id);
      case "thread/tokenUsage/updated":
        d.context = Number(p.tokenUsage?.last?.inputTokens) || d.context;
        return;
      case "thread/settings/updated":
        if (p.threadSettings) th.settings = settingsOf({ ...p.threadSettings, sandbox: p.threadSettings.sandboxPolicy, reasoningEffort: p.threadSettings.effort });
        if (!p.threadSettings?.model || p.threadSettings.model === d.model) return;
        d.model = p.threadSettings.model;
        return snapshot(id);
      // Deprecated for the contextCompaction item, which a Codex that sends both sends too: whichever comes first.
      case "thread/compacted":
        return commands.compacted(id, th);
      case "item/started":
        take(id, p.item, p.startedAtMs, false);
        return changed(id);
      case "item/completed":
        take(id, p.item, p.completedAtMs, true);
        return changed(id);
    }
  }

  // Fold an item into a thread's steps. `live`: it happened now (mirror what someone typed elsewhere).
  function take(id: string, item: CodexItem, ms: number, completed: boolean, live = true) {
    const th = thread(id);
    const d = th.digest;
    const at = ms ? new Date(ms).toISOString() : new Date().toISOString();
    if (item.type === "userMessage") {
      if (completed) return;
      d.turn++;
      // What agentbook sent comes back with the id it was sent with: it's on the thread already.
      if (live && !(item.clientId && th.sent.has(item.clientId as string))) {
        const text = textOf(item.content);
        // A heartbeat's prompt isn't you writing: its runs are on its routine.
        if (text && !heartbeatOf(text)) ctx.emit({ e: "message", thread: id, from: "human", via: "terminal", text });
      }
      return;
    }
    // What it says, and what a review it ran found (its findings, which end the review's turn as its reply).
    if (item.type === "agentMessage" || item.type === "exitedReviewMode") {
      const text = (item.type === "agentMessage" ? item.text : item.review) as string;
      if (!completed || !text?.trim()) return;
      d.steps.push({ id: item.id, turn: d.turn, at, kind: "say", text: said(text) });
      if (live) th.lastSay = text;
    } else {
      if (item.type === "contextCompaction" && completed && live) commands.compacted(id, th);
      noteAgents(id, item, at);
      const title = stepOf(item, th.cwd);
      if (!title) return;
      let step = d.byId.get(item.id);
      if (!step) {
        step = { id: item.id, turn: d.turn, at, kind: "tool", tool: item.type, title };
        d.steps.push(step);
        d.byId.set(item.id, step);
        d.tools++;
      } else step.title = title;
      if (item.type === "fileChange") th.changes = { ...(th.changes || {}), [item.id]: item.changes as { path: string }[] };
      if (completed) {
        step.done = at;
        if (failed(item)) {
          step.error = errorOf(item);
          d.errors++;
        } else if (!d.noted.has(item.id)) {
          // What it changed, once: from a file change's diffs, and the commits a command made.
          d.noted.add(item.id);
          if (item.type === "fileChange") for (const e of codexEdits(item as CodexFileChange, th.cwd)) noteEdit(d, step, { ...e, at }, th.cwd);
          if (item.type === "commandExecution" && COMMITS.test(unwrap(item.command))) d.commits.push({ step: step.id, turn: step.turn, from: step.at, to: at, sha: shaIn(item.aggregatedOutput) });
          if (item.type === "commandExecution") notePrs(d.prs, unwrap(item.command), item.aggregatedOutput as string, at);
        }
      }
    }
    if (d.steps.length > KEEP) for (const s of d.steps.splice(0, d.steps.length - KEEP)) d.byId.delete(s.id);
  }

  /* ---------- approvals and questions ---------- */

  async function onRequest(m: RpcMessage) {
    const p = m.params || {};
    const id = (p.threadId || p.conversationId) as string;
    if (id && !post(id)) {
      const r = await call<CodexThreadReply>("thread/read", { threadId: id }).catch(() => null);
      if (r?.thread) ensurePost(r.thread, { active: true }); // it's asking something of a turn it's running
    }
    if (!id || !post(id)) return rpc.refuse(m.id, "agentbook doesn't know this thread");
    const key = `x${m.id}`;
    const ask = (q: { title: string; tool_name: string; detail: string; preview: string }) => {
      requests.set(key, { rpcId: m.id, method: m.method, post: id, params: p });
      ctx.emit({ e: "ask", thread: id, kind: "permission", request_id: key, ...q });
    };
    const reason = p.reason as string;
    switch (m.method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
        return ask({ title: "Allow Shell?", tool_name: "Shell", detail: reason || "Codex wants to run a command.", preview: unwrap(p.command) });
      case "item/fileChange/requestApproval":
      case "applyPatchApproval": {
        const changes = p.fileChanges ? Object.keys(p.fileChanges as object) :(thread(id).changes?.[p.itemId as string] || []).map((c) => c.path);
        return ask({ title: "Allow edits?", tool_name: "Edit", detail: reason || "Codex wants to change files.", preview: changes.join("\n") });
      }
      case "item/permissions/requestApproval":
        return ask({ title: "Allow more access?", tool_name: "Permissions", detail: reason || "Codex wants more access for this turn.", preview: JSON.stringify(p.permissions, null, 2) });
      case "item/tool/requestUserInput": {
        const req: Request = { rpcId: m.id, method: m.method, post: id, params: p, asks: new Map(), answers: {} };
        requests.set(key, req);
        for (const q of (p.questions || []) as { id: string; question: string; header?: string; options?: { label: string; description?: string }[] }[]) {
          const op = ctx.emit({
            e: "ask",
            thread: id,
            kind: q.options?.length ? "choice" : "text",
            title: q.question,
            detail: q.header || "",
            options: (q.options || []).slice(0, 6).map((o) => ({ label: short(o.label, 80), detail: short(o.description, 140) || null })),
            key: `${key}:${q.id}`,
            blocks: true,
          });
          if (op) req.asks.set(op.qid, q.id);
        }
        if (!req.asks.size) rpc.reply(m.id, { answers: {} });
        return;
      }
      case "mcpServer/elicitation/request":
        return rpc.reply(m.id, { action: "decline" });
      default:
        return rpc.refuse(m.id, `agentbook can't handle ${m.method}`);
    }
  }

  // Allow/Deny on one of Codex's approvals, in the words its method answers with.
  function answerPermission(e: PermissionEvent) {
    const r = requests.get(e.request_id);
    if (!r) return false;
    requests.delete(e.request_id);
    const yes = e.behavior === "allow";
    if (r.method === "execCommandApproval" || r.method === "applyPatchApproval") rpc.reply(r.rpcId, { decision: yes ? "approved" : "abort" });
    else if (r.method === "item/permissions/requestApproval") rpc.reply(r.rpcId, yes ? { permissions: r.params.permissions || {}, scope: "turn" } : { permissions: {} });
    else rpc.reply(r.rpcId, { decision: yes ? "accept" : "decline" });
    return true;
  }

  // An answer to one of Codex's questions. Once every question in its request is answered, reply.
  function answerInput(e: AnswerEvent) {
    for (const [key, r] of requests) {
      if (!r.asks?.has(e.question_id)) continue;
      r.answers[r.asks.get(e.question_id)] = { answers: e.skipped || e.value == null ? [] : [String(e.value)] };
      if (Object.keys(r.answers).length === r.asks.size) {
        requests.delete(key);
        rpc.reply(r.rpcId, { answers: r.answers });
      }
      return true;
    }
    return false;
  }
  // What answers a request Codex waits on: it goes to Codex even while a slash command waits for the turn to end, since
  // a turn waiting on it wouldn't end.
  const answersCodex = (e: OutboxEvent) => (e.type === "permission" && requests.has(e.request_id)) || (e.type === "answer" && [...requests.values()].some((r) => r.asks?.has(e.question_id)));

  /* ---------- what you send ---------- */

  // A call that starts a turn. Its reply says which turn, so a message or Stop can reach one Codex hasn't announced yet.
  // But the turn can be over by the time the reply is read, and it would then count as running for good, holding back
  // every command: what turn/started and turn/completed said while the call was out stands.
  async function startTurn(th: ThreadState, method: string, params: unknown) {
    const heard = th.turnsHeard;
    const r = await call<{ turn?: { id: string } }>(method, params);
    if (th.turnsHeard === heard) th.turn = r?.turn?.id || th.turn;
    return r;
  }

  // Send a message as a turn, or steer the turn that's running. A model, effort or mode picked for the post goes with
  // the next turn it starts (steering keeps the running turn's), and stays with the thread's later turns, as `effort`
  // does.
  // `also`: more input beside the text (a skill it's to use).
  async function sendTurn(id: string, text: string, { effort, also = [] }: { effort?: string; also?: CodexInput[] } = {}) {
    const th = await follow(id);
    const clientUserMessageId = `ab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    th.sent.add(clientUserMessageId);
    const input = [{ type: "text", text, text_elements: [] }, ...also];
    if (th.turn) {
      try {
        return await call("turn/steer", { threadId: id, expectedTurnId: th.turn, input, clientUserMessageId });
      } catch {}
    }
    const s = post(id);
    const model = s?.model_pick || undefined;
    const effortPick = s?.effort_pick || undefined;
    const modePick = s?.mode_pick || undefined;
    const r = await startTurn(th, "turn/start", { threadId: id, input, clientUserMessageId, model, effort: effort || effortPick, ...(modePick ? turnModeSettings(modePick, th.settings?.roots) : {}) });
    if (model) {
      th.digest.model = model;
      ctx.emit({ e: "fact", op: { t: "session.model", post: id, model: null } });
      snapshot(id);
    }
    if (effortPick) ctx.emit({ e: "fact", op: { t: "session.effort", post: id, pick: null, effort: effortPick } });
    if (modePick) ctx.emit({ e: "fact", op: { t: "session.mode", post: id, pick: null, mode: modePick } });
    return r;
  }

  /* ---------- its slash commands (commands.ts) ---------- */

  const commands = createCommands({
    ctx: () => ctx,
    call,
    connect,
    follow,
    thread,
    startTurn,
    sendTurn,
    models: () => modelReader.get(),
    limits: () => limits(),
    adopt: (t) => ensurePost(t, { active: true }),
  });

  async function start({ cwd, prompt, shown = prompt, lid, model, effort, mode, dirs = [] }: StartRequest) {
    startFolder(cwd);
    await connect();
    // What it's told about agentbook stays with the thread, as its developer instructions.
    const context = await ctx.context({ launch: lid, cwd }).catch((e) => log(`codex context: ${e.message}`));
    // A thread in a group can write the group's folder too.
    const extra = equip(ctx, `launch:${lid}`, cwd);
    if (dirs.length) extra.config["sandbox_workspace_write.writable_roots"] = dirs;
    const r = await loading("thread/start", { cwd, model: model || undefined, ...modeSettings(mode) }, { ...extra, ...(context ? { developerInstructions: context } : {}) });
    const t = r.thread;
    const th = thread(t.id);
    th.subscribed = true;
    th.settings = settingsOf(r);
    ensurePost(t, { lid });
    ctx.emit({ e: "message", thread: t.id, from: "human", via: "dash", text: shown, resume: lid });
    await sendTurn(t.id, prompt, { effort });
    return { id: t.id };
  }

  // A side thread: the thread forked as it is, its copy going on with what you sent while the
  // thread works on, untouched. The copy works where the thread works, with agentbook's tools as itself (`launch:`
  // until its post is there, as a thread agentbook starts). Codex gives it the thread's name too: it's named after
  // what you sent, there and here.
  async function side({ id, cwd, prompt, shown = prompt, lid, effort, mode, dirs = [] }: SideRequest) {
    await connect();
    cwd = startFolder(cwd || thread(id).cwd || post(id)?.cwd || "");
    const extra = equip(ctx, `launch:${lid}`, cwd);
    if (dirs.length) extra.config["sandbox_workspace_write.writable_roots"] = dirs;
    siding.set(id, (siding.get(id) || 0) + 1);
    let t: CodexThread;
    try {
      const r = await loading("thread/fork", { threadId: id, cwd, excludeTurns: true, ...modeSettings(mode) }, extra);
      const name = short(String(shown).split("\n")[0], 80) || "Side thread";
      t = { ...r.thread, name, preview: shown };
      const th = thread(t.id);
      th.subscribed = true;
      th.settings = settingsOf(r);
      await call("thread/name/set", { threadId: t.id, name }).catch((e) => log(`codex: couldn't name side thread ${t.id}: ${e.message}`));
      ensurePost(t, { lid });
    } finally {
      if (siding.get(id) > 1) siding.set(id, siding.get(id) - 1);
      else siding.delete(id);
    }
    ctx.emit({ e: "message", thread: t.id, from: "human", via: "dash", text: shown, resume: lid });
    await sendTurn(t.id, prompt, { effort });
    return { id: t.id };
  }

  async function interrupt(id: string) {
    const th = threads.get(id);
    if (!th?.turn) throw new Error("It isn't working on anything right now.");
    await call("turn/interrupt", { threadId: id, turnId: th.turn });
  }

  // Every step of a thread. Followed threads have them already; others are read once from Codex.
  async function read(id: string) {
    const th = thread(id);
    const s = post(id);
    if (!th.subscribed && conn && Date.now() - th.read > 10000) {
      th.read = Date.now();
      const r = await call<CodexThreadReply>("thread/read", { threadId: id, includeTurns: true }).catch(() => null);
      if (r?.thread) {
        const d = (th.digest = Object.assign(blank(), { model: th.digest.model, ai_title: th.digest.ai_title }));
        th.cwd = cwdOf(r.thread) || th.cwd || s?.cwd || "";
        for (const turn of ownTurns(r.thread.turns, s?.side_at)) {
          for (const item of turn.items || []) {
            take(id, item, (turn.startedAt || 0) * 1000, false, false);
            take(id, item, (turn.completedAt || turn.startedAt || 0) * 1000, true, false);
          }
          d.worked += Number(turn.durationMs) || 0;
        }
      }
    }
    return th.digest;
  }

  // The skills Codex can use, for the newest thread's folder. Kept on the newest post when they change.
  async function skills() {
    const newest = Object.values(ctx.state.sessions).filter((s) => s.agent === AGENT && s.cwd).sort((a, b) => b.started.localeCompare(a.started))[0];
    if (!newest) return;
    const r = await call<CodexList<{ skills?: CodexSkill[] }>>("skills/list", { cwds: [newest.cwd] }).catch(() => null);
    const list = (r?.data || []).flatMap((e) => e.skills || []).filter((k) => k.enabled !== false);
    const out = list.map((k) => ({ name: k.name, description: short(k.shortDescription || k.description, 200), file: k.path || null }));
    if (out.length && JSON.stringify(newest.skills || null) !== JSON.stringify(out)) ctx.emit({ e: "fact", op: { t: "session.skills", post: newest.id, skills: out } });
  }

  let loadingModels: Promise<void> | null = null;
  function loadModels() {
    loadingModels ||= (async () => {
      try {
        // Account notifications can arrive before initialize has answered.
        await connect();
        await modelReader.read();
        if (!modelReader.get().list.length) throw new Error("Codex returned no models; retrying on the next sync");
        log(`codex: listed ${modelReader.get().list.length} models for daemon ${version || "unknown"}`);
      } catch (e) {
        log(`codex: couldn't refresh its models: ${e.message}`);
        throw e;
      }
    })().finally(() => (loadingModels = null));
    return loadingModels;
  }

  // How much of its ChatGPT plan's limits it has used (limits.ts).
  const limits = limitsReader(async () => {
    await connect();
    return { limits: [codexLimitsOf(await call("account/rateLimits/read", { excludeResetCreditDetails: true }))] };
  });

  // Its routines: the ChatGPT app's automations (automations.ts), a heartbeat's runs read from its thread.
  const routines = codexRoutines({
    read: async (threadId) => {
      await connect();
      return (await call<CodexThreadReply>("thread/read", { threadId, includeTurns: true }))?.thread || null;
    },
    post: (id) => post(id),
    log,
  });

  const digest = (s: Session) => threads.get(s.id)?.digest || null;

  // Its update (runtime-update.ts). `codex update` updates the codex command, however it was installed; the daemon
  // agentbook's threads run in keeps a copy of its own, which updates by itself only now and then, so
  // `codex app-server daemon update` catches it up, restarting it. agentbook reconnects as it does whenever the
  // daemon goes, and reads its version then.
  const bin = () => process.env.AGENTBOOK_CODEX_BIN || "codex";
  const daemonVersions = () =>
    new Promise<{ cliVersion?: string; appServerVersion?: string }>((resolve) =>
      execFile(bin(), ["app-server", "daemon", "version"], { timeout: 30000, env: agentEnvironment() }, (err, stdout) => {
        try {
          resolve(err ? {} : JSON.parse(String(stdout).slice(String(stdout).indexOf("{"))) || {});
        } catch {
          resolve({});
        }
      }),
    );
  async function update(output: (text: string) => void, signal: AbortSignal) {
    const env = agentEnvironment(cleanEnv({ CODEX_NON_INTERACTIVE: "1" }));
    await runCommand(bin(), ["update"], { output, signal, env });
    const v = await daemonVersions();
    if (isOlder(v.appServerVersion, v.cliVersion)) await runCommand(bin(), ["app-server", "daemon", "update"], { output, signal, env });
    version = (await daemonVersions()).appServerVersion || version;
    sync().catch(() => {});
  }

  return {
    id: "codex",
    info: RUNTIMES.codex,
    echoes: "self",
    owns: (agent) => agent === AGENT,
    past: { list: pastList, bring: pastBring, agent: () => AGENT, picked: () => void (conn && offerTools(ctx, call).catch((e) => log(`codex: couldn't give its threads agentbook's tools: ${e.message}`))) },
    connect(c) {
      ctx = c;
      if (!enabled) return;
      poll(() => sync().catch((e) => lastError !== e.message && log(`codex: ${(lastError = e.message)}`)), Number(process.env.AGENTBOOK_CODEX_SYNC_MS || 15000));
      setTimeout(() => skills().catch(() => {}), 5000).unref();
      setInterval(() => skills().catch(() => {}), 30 * 60e3).unref();
      setInterval(() => loadModels().catch(() => {}), 30 * 60e3).unref();
    },
    health: () => ({ enabled, connected: !!conn, error: lastError }),
    start,
    send: (id, text) => sendTurn(id, text),
    answer: (id, e) => (e.type === "permission" ? answerPermission(e) : answerInput(e)),
    awaits: (id, e) => answersCodex(e),
    interrupt,
    read,
    live: (s) => liveOf(digest(s)),
    summary: (s) => summaryOf(digest(s), s),
    working: (id) => !!threads.get(id)?.turn,
    blocked: () => null,
    resumeCommand: (s) => `cd ${s.cwd || s.root || "."} && codex resume ${s.session_id}`,
    fork: { side },
    models: { list: () => modelReader.get() },
    commands: { list: (s) => commands.list(s), run: (id, text, name) => commands.run(id, text, name) },
    workers: { list: workersOf, steps: workerStepsOf },
    routines,
    limits: { read: (agent) => (agent === AGENT && enabled ? limits() : null) },
    threadOf: postOf,
    update: {
      pkg: "@openai/codex",
      version: () => version,
      wait: () => ([...threads.values()].some((th) => th.turn) ? "A Codex turn is running here, and the update restarts Codex's app server, which would cut it off. Update once it ends." : null),
      run: update,
    },
    // Its row on Add agents.
    row() {
      const off = process.env.AGENTBOOK_CODEX === "0";
      return { ok: !!conn, status: conn ? "Connected" : off ? "Off" : !enabled ? "Not found" : "Can't reach it", detail: conn ? "Through Codex's own daemon, the one the Codex apps use." : !enabled ? "Install Codex here (the codex command), then restart agentbook." : lastError || "Starting Codex's daemon…" };
    },
  };
}
