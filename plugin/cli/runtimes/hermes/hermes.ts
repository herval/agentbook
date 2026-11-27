// Hermes Agent (Nous Research). Hermes keeps every session in its SQLite database (~/.hermes/state.db, or
// $HERMES_HOME/state.db), which agentbook reads, read-only, for what to show; it steers sessions through `hermes acp`,
// Hermes's Agent Client Protocol server (kit/acp.ts), run as a child.
//
// - Hermes is a profile ("hermes"), and each session people have with it a thread: from its terminal app, its
//   desktop app, ACP clients and chat channels (Telegram, Discord…). Subagent, tool, cron and one-shot runs stay
//   off. A conversation Hermes compressed into a new session stays one thread.
// - New message rows are the thread's conversation and steps: tool calls are steps, the tool rows their results.
//   A session holding a turn lease is working.
// - Starting a thread on Hermes's wall starts an ACP session in the folder picked. Writing on a thread sends a
//   prompt: over ACP for sessions started that way (loading them first after a restart), or `hermes chat --resume`
//   for its terminal sessions, which can't ask for approvals (Hermes denies them). Chat-channel sessions are read-only
//   here: their channel delivers them. Stop cancels an ACP turn, or interrupts a `hermes chat` agentbook runs.
// - ACP's permission requests are Allow/Deny on the thread; Hermes denies one left unanswered for 5 minutes.
//   Hermes has no questions to ask over ACP.
// - The ACP sessions agentbook starts or loads have agentbook's tools (ab_post, ab_ask…).

import { agentDirectory, currentAgentConfig } from "../../agent-context.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../../../shared/storage/sqlite.ts";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import { addSay, addTool, blank, iso, liveOf, short, summaryOf, toolDone, toolTitle } from "../kit/steps.ts";
import type { DriverDigest } from "../kit/steps.ts";
import { createAcp } from "../kit/acp.ts";
import { poll } from "../kit/poll.ts";
import { runtimeProviders } from "../../runtime-providers.ts";
import { onPath, startFolder } from "../kit/spawn.ts";
import { shown as shownWorkers, stateOf } from "../../workers.ts";
import type { Worker } from "../../workers.ts";
import type { PastSession, Runtime, RuntimeContext } from "../runtime.ts";

const HOME_DIR = () => agentDirectory("hermes");
const DAYS = Number(process.env.AGENTBOOK_HERMES_DAYS || 14);
const HIDDEN_SOURCES = new Set(["subagent", "tool", "cron", "oneshot", "kanban", "batch"]);
const CHANNELS = new Set(["telegram", "discord", "slack", "whatsapp", "signal", "matrix", "email", "sms", "api_server", "homeassistant"]);
const BOOT = Date.now() / 1000; // sessions that started since are new; older ones' messages are history

const textOf = (content) => {
  if (content == null) return "";
  if (typeof content !== "string") return Array.isArray(content) ? content.map((c) => c?.text || "").join("\n") : String(content);
  const t = content.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      return JSON.parse(t)
        .map((c) => c?.text || "")
        .join("\n");
    } catch {}
  }
  return content;
};
const parse = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
};

// A conversation: the message rows read of each of its sessions, its steps, whether it works, where it's from, and
// its sessions (one, unless Hermes compressed it into more).
interface Conv {
  last: Map<string, number>;
  digest: DriverDigest;
  busy: boolean;
  source: string | null;
  sessions: Set<string>;
}

export function createHermes(): Runtime {
  const config = currentAgentConfig();
  const AGENT = config?.id || "hermes";
  const NAME = config?.name || "Hermes";
  let ctx: RuntimeContext = null;
  const log = (line: string) => ctx?.log(line);
  const bin = () => process.env.AGENTBOOK_HERMES_BIN || "hermes";
  const enabled = process.env.AGENTBOOK_HERMES !== "0";
  let db = null;
  let lastError = null;
  const posts = new Map<string, Conv>(); // thread id (a conversation's first session)
  const rootOf = new Map<string, string>(); // session id -> its thread id
  const running = new Map(); // thread id -> a `hermes chat` child agentbook runs
  let workers = new Map<string, Worker[]>(); // thread id -> its subagents, as workers (noteWorkers)

  /* ---------- the database ---------- */

  function open() {
    if (db) return db;
    const file = path.join(HOME_DIR(), "state.db");
    if (!fs.existsSync(file)) return null;
    db = new DatabaseSync(file, { readOnly: true });
    return db;
  }
  const all = (sql, ...args) => open()?.prepare(sql).all(...args) || [];

  const post = (id) => ctx.state.sessions[id];
  const conv = (id: string): Conv => {
    if (!posts.has(id)) posts.set(id, { last: new Map(), digest: blank(), busy: false, source: null, sessions: new Set([id]) });
    return posts.get(id);
  };

  // A session Hermes compressed continues in a child session: both are the one thread, keyed by the first.
  function rootId(row, byId) {
    let r = row;
    for (let i = 0; i < 50 && r?.parent_session_id; i++) {
      const parent = byId.get(r.parent_session_id) || all("SELECT id, parent_session_id, end_reason FROM sessions WHERE id = ?", r.parent_session_id)[0];
      if (!parent || parent.end_reason !== "compression") break;
      r = parent;
    }
    return r.id;
  }

  function ensurePost(id, row, { lid, prompt }: { lid?: string; prompt?: string } = {}) {
    const c = conv(id);
    c.source = row.source || c.source;
    if (row.title) c.digest.ai_title = short(row.title, 120);
    if (row.model) c.digest.model = row.model;
    if (post(id) && !lid) return post(id);
    const cwd = row.cwd || parse(row.model_config)?.cwd || "";
    const g = ctx.gitInfo(cwd);
    ctx.emit({
      e: "thread",
      thread: id,
      agent: AGENT,
      agent_name: NAME,
      cwd,
      root: g.root,
      repo: g.repo,
      branch: row.git_branch || g.branch,
      host: os.hostname().split(".")[0],
      launch: lid,
      started: iso(row.started_at) || undefined,
      updated: iso(row.last_activity_at || row.started_at) || undefined,
      prompt: prompt ? short(prompt, 2000) : undefined,
    });
    ctx.emit({ e: "changed", thread: id, save: true });
    return post(id);
  }

  // Fold new message rows into their thread. `live`: they happened now, so they join its conversation.
  function take(id, session, rows, live) {
    const c = conv(id);
    for (const m of rows) {
      c.last.set(session, Math.max(c.last.get(session) || 0, m.id));
      if (m.display_kind === "hidden") continue;
      const { text, calls } = fold(c.digest, m, post(id)?.cwd);
      if (m.role === "user") {
        if (live && text) ctx.emit({ e: "message", thread: id, from: "human", via: c.source && c.source !== "acp" ? c.source : "terminal", text });
      }
      // A reply with no tools to run ends the turn: it's what Hermes says on the thread.
      else if (m.role === "assistant" && live && text && !calls.length) ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text });
    }
  }
  // A message row on a digest: a turn begun, what it said and the tools it called, or how one of them went.
  function fold(d, m, cwd) {
    const at = iso(m.timestamp) || new Date().toISOString();
    const text = textOf(m.content).trim();
    const calls = m.role === "assistant" ? parse(m.tool_calls) || [] : [];
    if (m.role === "user") d.turn++;
    else if (m.role === "assistant") {
      if (text) addSay(d, { id: `m${m.id}`, at, text });
      for (const call of calls) addTool(d, { id: call.id, at, name: call.function?.name || call.name, args: call.function?.arguments ?? call.arguments, cwd });
    } else if (m.role === "tool") toolDone(d, m.tool_call_id, { at, error: /^(error|failed)\b/i.test(text) ? text : null, output: text });
    return { text, calls };
  }

  const MESSAGES = "SELECT id, role, content, tool_calls, tool_call_id, tool_name, timestamp, display_kind FROM messages WHERE session_id = ? AND active = 1 AND id > ? ORDER BY timestamp, id";

  /* ---------- keeping up ---------- */

  // Its sessions from before, for the welcome card (plugin/cli/history.ts): those a person started, not its
  // subagents' or its jobs'. Those picked come in with the next sync, as its recent ones do.
  async function pastList(): Promise<PastSession[]> {
    if (!enabled || !open()) return [];
    return all("SELECT id, source, started_at, last_activity_at, cwd FROM sessions WHERE hidden = 0 AND parent_session_id IS NULL")
      .filter((r) => !HIDDEN_SOURCES.has(r.source))
      .map((r) => ({ id: r.id, at: (r.last_activity_at || r.started_at) * 1000, cwd: r.cwd || null }));
  }

  function sync() {
    if (!enabled || !open()) return;
    try {
      const since = (ctx.pastSince ? ctx.pastSince("hermes", DAYS) : Math.max(Date.now() - DAYS * 86400e3, ctx.historyFrom?.() || 0)) / 1000;
      const rows = all("SELECT id, source, title, started_at, ended_at, last_activity_at, cwd, model, model_config, git_branch, parent_session_id, end_reason, hidden FROM sessions WHERE hidden = 0 AND (last_activity_at > ? OR started_at > ?) ORDER BY started_at", since, since);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const leased = new Set(all("SELECT conversation_id FROM session_turn_leases WHERE expires_at > ?", Date.now() / 1000).map((r) => r.conversation_id));
      const busy = new Map(); // thread -> working
      const subs = [];
      for (const row of rows) {
        if (row.source === "subagent") subs.push(row);
        if (HIDDEN_SOURCES.has(row.source)) continue;
        const id = rootId(row, byId);
        rootOf.set(row.id, id);
        const c = conv(id);
        c.sessions.add(row.id);
        // A session's first read is its history, unless it started since agentbook did.
        const read = c.last.has(row.id);
        const rowsNew = all(MESSAGES, row.id, c.last.get(row.id) || 0);
        if (!read) c.last.set(row.id, 0);
        if (!post(id)) {
          if (!rowsNew.length && !leased.has(row.id)) continue; // nothing in it yet
          if (ctx.pastOut?.("hermes", row.cwd, (row.last_activity_at || row.started_at) * 1000)) continue;
          const first = rowsNew.find((m) => m.role === "user");
          take(id, row.id, rowsNew, false);
          ensurePost(id, byId.get(id) || row, { prompt: first ? textOf(first.content) : undefined });
        } else {
          ensurePost(id, byId.get(id) || row);
          if (rowsNew.length) {
            take(id, row.id, rowsNew, read || row.started_at > BOOT);
            ctx.emit({ e: "changed", thread: id });
          }
        }
        busy.set(id, busy.get(id) || leased.has(row.id) || running.has(id) || acpTurns.has(id));
      }
      for (const [id, b] of busy) setBusy(id, b);
      noteWorkers(subs, leased);
      lastError = null;
    } catch (e) {
      if (lastError !== e.message) log(`hermes: ${(lastError = e.message)}`);
      try {
        db?.close();
      } catch {}
      db = null;
    }
  }

  // A session's agent can delegate to subagents, sessions of their own (source "subagent") that stay off agentbook:
  // each is a worker (workers.ts) of the thread its parent session is on. One holding a turn lease is running, and so
  // is one that hasn't ended while its thread's turn goes on (the turn waits for it); one that ended says how by why it
  // ended. The tool it last called is its step while it runs.
  function noteWorkers(rows, leased) {
    const next = new Map<string, Worker[]>();
    for (const row of rows) {
      const id = row.parent_session_id && rootOf.get(row.parent_session_id);
      if (!id || !post(id)) continue;
      const going = leased.has(row.id) || (!row.ended_at && conv(id).busy);
      const why = String(row.end_reason || "");
      const state = going ? "running" : stateOf(why) || (/error|fail/i.test(why) ? "failed" : /interrupt|cancel|abort|kill/i.test(why) ? "stopped" : "done");
      const w = { id: row.id, title: short(row.title || "A subagent", 120), state, started: iso(row.started_at), ended: going ? null : iso(row.ended_at || row.last_activity_at), error: state === "failed" && why ? short(why, 300) : null, step: going ? lastStep(row.id, id) : null } as Worker;
      (next.get(id) || next.set(id, []).get(id)).push(w);
    }
    // Those its thread shows, each with how many tools it called, which its thread's page reads its steps by.
    for (const [id, list] of next) next.set(id, shownWorkers(list));
    const ids = [...next.values()].flat().map((w) => w.id);
    const n = new Map<string, number>(ids.length ? all(`SELECT session_id, SUM(CASE WHEN json_valid(tool_calls) AND json_type(tool_calls) = 'array' THEN json_array_length(tool_calls) ELSE 0 END) AS n FROM messages WHERE active = 1 AND role = 'assistant' AND tool_calls IS NOT NULL AND session_id IN (${ids.map(() => "?").join()}) GROUP BY session_id`, ...ids).map((r) => [r.session_id, r.n]) : []);
    for (const w of [...next.values()].flat()) w.n = n.get(w.id) || 0;
    workers = next;
  }
  // A worker's steps, from its own session's messages: read when you open it on its thread's page. Its latest WORKER_STEPS.
  const WORKER_STEPS = 40;
  function workerSteps(id, worker) {
    if (!(workers.get(id) || []).some((w) => w.id === worker) || !open()) return null;
    const d = blank();
    for (const m of all(MESSAGES, worker, 0)) if (m.display_kind !== "hidden") fold(d, m, post(id)?.cwd);
    return { steps: d.steps.slice(-WORKER_STEPS).map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), n: d.tools };
  }
  function lastStep(session, id) {
    const m = all("SELECT tool_calls, timestamp FROM messages WHERE session_id = ? AND active = 1 AND role = 'assistant' AND tool_calls IS NOT NULL ORDER BY id DESC LIMIT 1", session)[0];
    const call = (parse(m?.tool_calls) || []).at(-1);
    return call ? { title: toolTitle(call.function?.name || call.name, call.function?.arguments ?? call.arguments, post(id)?.cwd), at: iso(m.timestamp) } : null;
  }

  function setBusy(id, busy) {
    if (!post(id)) return;
    ctx.emit(busy ? { e: "turn.start", thread: id } : { e: "turn.end", thread: id });
    conv(id).busy = busy;
  }

  /* ---------- ACP: Hermes's Agent Client Protocol server ---------- */

  const acpTurns = new Set<string>(); // threads with an ACP prompt running
  const acp = createAcp({
    name: NAME,
    prefix: "hm",
    command: bin,
    args: ["acp"],
    env: () => ({ ...runtimeProviders.env("hermes"), HERMES_ACP_SKIP_CONFIGURED_MCP: "1" }),
    missing: "Hermes isn't installed here.",
    onPermission: (p, key) => {
      const id = rootOf.get(p.sessionId) || p.sessionId;
      if (!post(id)) return null;
      const tc = p.toolCall || {};
      const input = (tc.rawInput || {}) as Record<string, string>;
      ctx.emit({ e: "ask", thread: id, kind: "permission", request_id: key, title: "Allow this?", tool_name: tc.kind === "execute" ? "Terminal" : String(tc.title || NAME), detail: String(tc.title || "Hermes wants to go ahead with this."), preview: input.command || input.path || "" });
      return id;
    },
    onExit: () => acpTurns.clear(),
  });

  // Send a prompt over ACP, and keep the thread working until its turn ends.
  async function acpPrompt(id, sessionId, text) {
    const a = await acp.start();
    if (!a.open.has(sessionId)) {
      const cwd = post(id)?.cwd || os.homedir();
      await a.rpc.call("session/load", { sessionId, cwd, mcpServers: acp.equip(ctx, a, `hermes:${id}`, cwd) });
      a.open.add(sessionId);
    }
    acpTurns.add(id);
    setBusy(id, true);
    a.rpc
      .call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 0)
      .catch((e) => ctx.emit({ e: "failed", thread: id, why: e.message }))
      .finally(() => {
        acpTurns.delete(id);
        sync();
        setBusy(id, false);
      });
  }

  // A terminal session continues with `hermes chat --resume`, without approvals (Hermes denies them).
  function chatResume(id, sessionId, text) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin(), ["chat", "--resume", sessionId, "--query-file", "-", "-Q", "--format", "stream-json", "--source", "cli"], { env: runtimeProviders.env("hermes"), cwd: post(id)?.cwd && fs.existsSync(post(id).cwd) ? post(id).cwd : os.homedir(), stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e: NodeJS.ErrnoException) => reject(new Error(e.code === "ENOENT" ? "Hermes isn't installed here." : e.message)));
      child.on("spawn", () => {
        running.set(id, child);
        setBusy(id, true);
        resolve();
      });
      child.on("exit", (code) => {
        running.delete(id);
        sync();
        setBusy(id, false);
        if (code && code !== 130) ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text: `Hermes couldn't continue it: ${short(err.trim().split("\n").at(-1) || `exit ${code}`, 300)}` });
      });
      child.stdin.end(text);
    });
  }

  const newest = (id) => [...conv(id).sessions].at(-1) || id;
  async function send(id: string, text: string) {
    const c = conv(id);
    if (c.source === "acp" || acp.current()?.open.has(newest(id))) return acpPrompt(id, newest(id), text);
    return chatResume(id, newest(id), text);
  }

  async function start({ cwd, prompt, shown = prompt, lid }) {
    startFolder(cwd);
    const a = await acp.start();
    // Its thread doesn't exist until Hermes names the session: the tools write to the launch's until then.
    const r = await a.rpc.call<{ sessionId: string }>("session/new", { cwd, mcpServers: acp.equip(ctx, a, `launch:${lid}`, cwd) });
    const id = r.sessionId;
    a.open.add(id);
    rootOf.set(id, id);
    conv(id).source = "acp";
    ensurePost(id, { source: "acp", cwd, started_at: Date.now() / 1000 }, { lid, prompt });
    ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
    ctx.echo(id, prompt);
    acpPrompt(id, id, prompt);
    return { id };
  }

  async function interrupt(id: string) {
    if (acpTurns.has(id)) return acp.cancel(newest(id));
    if (running.has(id)) return void running.get(id).kill("SIGINT");
    throw new Error("It's running in Hermes elsewhere. Stop it there.");
  }

  return {
    id: "hermes",
    info: RUNTIMES.hermes,
    echoes: "text",
    owns: (id) => id === AGENT && ctx?.state.agents[id]?.kind === "hermes",
    past: { list: pastList, bring: async () => sync(), agent: () => AGENT },
    connect(c) {
      ctx = c;
      if (!enabled) return;
      const hasHermes = () => fs.existsSync(path.join(HOME_DIR(), "state.db"));
      poll(
        () => {
          if (!hasHermes()) return;
          ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: "hermes" });
          sync();
          for (const s of Object.values(ctx.state.sessions)) if (s.agent === AGENT && ctx.pending(s.id).length) ctx.deliver(s.id);
        },
        Number(process.env.AGENTBOOK_HERMES_SYNC_MS || 2000),
      );
    },
    health: () => ({ enabled, connected: !!db, error: lastError }),
    providerChanged: () => acp.reset(),
    // Its row on Add agents: found once its database is here.
    row: () =>
      db
        ? { ok: true, status: "Ready", detail: "Its conversations come from its database as threads, and agentbook steers them through hermes acp." }
        : !enabled ? { ok: false, status: "Off", detail: "AGENTBOOK_HERMES=0 leaves it off." }
        : onPath(bin()) ? { ok: true, status: "Installed", detail: "Run hermes setup to choose your model provider. Its conversations show here once you've used it." }
        : { ok: false, status: "Not found", detail: "Install Hermes Agent here. Once you've used it, it shows up as an agent." },
    start,
    send: (id, text) => send(id, text),
    holds: () => runtimeProviders.changing("hermes"),
    answer: (id, e) => acp.answer(e),
    interrupt,
    read: async (id) => conv(id).digest,
    live: (s) => liveOf(posts.get(s.id)?.digest),
    summary: (s) => summaryOf(posts.get(s.id)?.digest, s),
    working: (id) => !!posts.get(id)?.busy,
    blocked: (s) => {
      const src = posts.get(s.id)?.source;
      return CHANNELS.has(src) ? `This conversation is on ${src[0].toUpperCase()}${src.slice(1)}: write to Hermes there.` : null;
    },
    resumeCommand: (s) => `hermes --resume ${s.session_id}`,
    workers: { list: (id) => workers.get(id) || [], steps: async (id, worker) => workerSteps(id, worker) },
  };
}
