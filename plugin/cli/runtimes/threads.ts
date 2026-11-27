// The threads core: the one place runtimes' events become ops. It owns what's the same for
// every runtime: naming a thread and filling in its hello, bringing back one that was done when its turn starts, a
// turn's end (its open prompts settled, what was held for it delivered), the echoes of what agentbook sent, the
// "<name> stopped" line, and handing each post's queue to its runtime (delivery.ts). Runtimes never commit: they
// emit, and this commits through the daemon's commit, which keeps Private terminals' threads off.

import type { Logged, Op, OpKind, OpOf } from "../../shared/ops.ts";
import type { OutboxEntry, State } from "../../shared/types.ts";
import { runtimeOfProc, runtimeOfThread } from "../../shared/runtimes.ts";
import { deliverer } from "./delivery.ts";
import type { FactOp, Runtime, RuntimeContext, RuntimeEvent } from "./runtime.ts";

// What the daemon hands the core: its store, and what of agentbook runtimes use (RuntimeContext, less what the core
// adds).
export interface CoreHost {
  state: State;
  commit<T extends OpKind>(op: OpOf<T>): Logged<OpOf<T>> | undefined;
  // A post's turn ended: permission prompts still open on it were settled in its own app, so they close here too.
  settle(post: string): void;
  // A post changed: the page is told, and with `save`, its snapshot is kept and its work sent.
  changed(id?: string, save?: boolean): void;
  undelivered(post: string, events: OutboxEntry[], why: string): void;
  ack(oids: string[]): void;
  base: Omit<RuntimeContext, "emit" | "echo" | "echoed" | "deliver">;
}

const ECHO_MS = 10 * 60e3;
const ECHOES = 20;

export function createThreads(host: CoreHost, runtimes: Runtime[]) {
  const { state } = host;
  const byId = new Map<Runtime["id"], Runtime>();
  for (const r of runtimes) if (!byId.has(r.id)) byId.set(r.id, r);

  /* ---------- which runtime ---------- */

  // A thread's runtime: a cloud's by where it runs, else its proc's, else Claude Code's.
  const runtimeOf = (s: { agent?: string; proc?: string | null; cloud?: string | null } | null | undefined): Runtime | null => s ? (!s.cloud && s.agent && runtimeOfAgent(s.agent)) || byId.get(runtimeOfThread(s)) || null : null;
  const runtimeOfAgent = (agent: string): Runtime | null => runtimes.find((r) => r.owns(agent)) || null;
  const post = (id: string) => state.sessions[id];

  /* ---------- echoes ---------- */

  // What was sent to each thread lately, in its words: one from you that its runtime shows back is that, not new.
  const sent = new Map<string, { text: string; at: number }[]>();
  function echo(thread: string, text: string) {
    const t = String(text || "").trim();
    if (!t) return;
    const list = (sent.get(thread) || []).filter((x) => Date.now() - x.at < ECHO_MS).slice(-(ECHOES - 1));
    list.push({ text: t, at: Date.now() });
    sent.set(thread, list);
  }
  function isEcho(thread: string, text: string | undefined) {
    const list = sent.get(thread);
    const t = String(text || "").trim();
    const i = list ? list.findIndex((x) => x.text === t && Date.now() - x.at < ECHO_MS) : -1;
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  /* ---------- delivery ---------- */

  const deliveries = new Map<Runtime, (id: string) => Promise<void> | unknown>();
  function deliveryOf(rt: Runtime) {
    if (!deliveries.has(rt))
      deliveries.set(
        rt,
        rt.deliver
          ? (id: string) => rt.deliver(id)
          : deliverer({
              pending: host.base.pending,
              ack: host.ack,
              attached: host.base.attached,
              describe: host.base.describe,
              news: host.base.news,
              undelivered: host.undelivered,
              log: host.base.log,
              name: rt.voice || rt.info.name,
              answer: (id, e) => rt.answer(id, e),
              send: (id, text, files, opts) => rt.send(id, text, files, opts),
              command: rt.commands?.run ? (id, text, command) => rt.commands.run(id, text, command) : undefined,
              sendsFiles: rt.info.caps.attach === "upload",
              waits: rt.info.caps.commands === "wait",
              working: (id) => rt.working(id) || !!post(id)?.busy,
              awaits: rt.awaits ? (id, e) => rt.awaits(id, e) : undefined,
              // Its own say, or its caps': one that takes one prompt at a time holds while its turn runs.
              holds: rt.holds ? (id) => rt.holds(id) : rt.info.caps.delivery.midTurn === "hold" ? (id) => rt.working(id) || !!post(id)?.busy : undefined,
              echo: rt.echoes === "text" ? echo : undefined,
            }),
      );
    return deliveries.get(rt);
  }
  // Hand what's queued for a post to its runtime.
  function deliver(id: string) {
    const rt = runtimeOf(post(id));
    if (rt) return deliveryOf(rt)(id);
  }

  /* ---------- events ---------- */

  // A thread that was done is back: the same hello it had, so it's open again.
  function revive(rt: Runtime, id: string) {
    const s = post(id);
    if (!s || s.state !== "done") return;
    host.commit({ t: "session.hello", proc: s.proc, agent: s.agent, kind: state.agents[s.agent]?.kind || rt.id, label: s.label, session_id: id, channel: true });
  }
  // Its turn ended: what's still open on it was settled in its own app, and what was held for it goes.
  function ended(id: string) {
    host.settle(id);
    if (host.base.pending(id).length) deliver(id);
  }
  function fact(rt: Runtime, op: FactOp) {
    if (op.t === "session.status" && op.turn === "start") revive(rt, op.post);
    const made = host.commit(op);
    if (op.t === "session.status" && op.turn === "end") ended(op.post);
    return made;
  }

  function emit(rt: Runtime, e: RuntimeEvent): Logged<Op> | undefined {
    const thread = "thread" in e ? e.thread : e.e === "fact" && "post" in e.op ? e.op.post : null;
    if (thread && state.sessions[thread] && !rt.owns(state.sessions[thread].agent)) return;
    switch (e.e) {
      case "agent": {
        const a = state.agents[e.agent];
        const kind = e.kind || rt.id;
        const name = a?.config_dir ? a.name : e.name;
        if (a && a.name === name && a.kind === kind && (e.host === undefined || (a.host ?? null) === e.host) && (e.version === undefined || a.version === e.version)) return;
        return host.commit({ t: "agent.hello", agent: e.agent, agent_name: name, kind, ...(e.host !== undefined ? { host: e.host } : {}), ...(e.version !== undefined ? { version: e.version } : {}) });
      }
      case "thread": {
        const { e: _, thread, ...rest } = e;
        const prev = post(thread);
        // A thread from before keeps its proc (a Claude Agent one's "managed:"), as long as it's this runtime's.
        const proc = rest.proc || (prev && runtimeOfProc(prev.proc) === rt.id ? prev.proc : `${rt.info.procs[0]}:${thread}`);
        const agent = rest.agent || prev?.agent;
        const g = rest.cwd && rest.root === undefined ? host.base.gitInfo(rest.cwd) : null;
        return host.commit({
          t: "session.hello",
          ...rest,
          ...(g ? { root: g.root, repo: g.repo, branch: rest.branch || g.branch } : {}),
          proc,
          agent,
          agent_name: state.agents[agent]?.config_dir ? state.agents[agent].name : rest.agent_name || (prev ? undefined : state.agents[agent]?.name || rt.info.name),
          kind: rest.kind || state.agents[agent]?.kind || rt.id,
          label: rest.label || prev?.label || host.base.label(thread),
          session_id: thread,
          channel: rest.channel ?? true,
        });
      }
      case "turn.start": {
        const s = post(e.thread);
        if (!s || (s.busy && s.state !== "done")) return;
        return fact(rt, { t: "session.status", post: e.thread, state: "working", turn: "start", ...(e.text ? { text: e.text } : {}) });
      }
      case "turn.end": {
        // Only a turn going ends, or one whose end now says something else (`text`, `failed`).
        const s = post(e.thread);
        const text = e.text || (e.state === "waiting" ? undefined : "Waiting for your next message");
        if (!s || s.state === "done" || (!s.busy && s.state === "idle" && (!e.text || s.doing === e.text) && e.failed === undefined)) return;
        return fact(rt, { t: "session.status", post: e.thread, state: e.state || "idle", turn: "end", ...(text ? { text } : {}), ...(e.failed !== undefined ? { failed: e.failed } : {}) });
      }
      case "message": {
        const { e: _, thread, ...rest } = e;
        // What agentbook itself writes on it (via "dash") is never an echo.
        if (rest.from === "human" && rest.via !== "dash" && rt.echoes === "text" && isEcho(thread, rest.text)) return;
        return host.commit({ t: "message.add", post: thread, ...rest });
      }
      case "failed":
        return host.commit({ t: "message.add", post: e.thread, ...(e.mid ? { mid: e.mid } : {}), from: "agent", via: "dash", text: `${rt.voice || rt.info.name} stopped: ${e.why}`, ...(e.when ? { when: e.when } : {}) });
      case "ask": {
        const { e: _, thread, ...rest } = e;
        return host.commit({ t: "question.ask", post: thread, ...rest });
      }
      case "changed":
        return void host.changed(e.thread, e.save);
      case "gone":
        if (!post(e.thread) || post(e.thread).state === "done") return;
        return host.commit({ t: "session.gone", post: e.thread, ...(e.reason !== undefined ? { reason: e.reason } : {}), ...(e.ended ? { ended: e.ended } : {}) });
      case "fact":
        return fact(rt, e.op);
    }
  }

  /* ---------- runtimes ---------- */

  const contextOf = (rt: Runtime): RuntimeContext => ({ ...host.base, emit: (e) => emit(rt, e), echo, echoed: isEcho, deliver: (id) => void deliver(id) });
  function connect() {
    for (const rt of runtimes) rt.connect(contextOf(rt));
  }
  function add(rt: Runtime) {
    runtimes.push(rt);
    if (!byId.has(rt.id)) byId.set(rt.id, rt);
    rt.connect(contextOf(rt));
  }

  return { runtimes, byId: (id: string) => byId.get(id as Runtime["id"]) || null, runtimeOf, runtimeOfAgent, deliver, connect, add, emit, echo };
}

export type Threads = ReturnType<typeof createThreads>;
