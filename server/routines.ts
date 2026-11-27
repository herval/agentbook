// Routines, kept and scheduled on the server: when each runs, what it did, and the OK for each version. A code
// routine's code never runs here: a run is a command to a machine of its person's (page_routine.run), which runs it
// under Node's permission model and sends back what it returned. An agent routine's run is a session a machine
// starts, or a message to its thread. See plugin/shared/routines.ts.

import { createHash } from "node:crypto";
import { checkRun, nextAt, reachFrom, TIMEOUT_MS, versionOf } from "../plugin/shared/routines.ts";
import type { CheckedRun, RoutineOp } from "../plugin/shared/routines.ts";
import type { Iso, PageChange, Routine, RoutineCode, RoutineReach, RoutineRun, State, Widget } from "../plugin/shared/types.ts";

const AT_ONCE = 3; // routines running at the same time
const LIVE_AT_ONCE = 4; // live runs at the same time, across pages
const str = (v: unknown, max: number) => (v == null ? "" : String(v).slice(0, max));
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// A live run's inputs: the page's filters, ranges, and a widget's params.
export interface LiveInputs {
  filters?: Record<string, unknown>;
  ranges?: Record<string, unknown>;
  params?: Record<string, unknown>;
}
// What a code routine's code runs with on a machine (page_routine.run): its page's widgets as they are, and a live
// run's inputs.
export interface ExecArgs {
  rid: string;
  page: string | null;
  code: string;
  reach: RoutineReach;
  keeps: string[];
  memo: Record<string, unknown>;
  last: { at: Iso; ok: boolean } | null;
  timeout: number;
  widgets: Record<string, Pick<Widget, "id" | "type" | "title" | "data">>;
  filters?: Record<string, unknown>;
  ranges?: Record<string, unknown>;
  params?: Record<string, unknown>;
  live?: true;
}
// A run of a routine, as its routine keeps it (its id, routine and page are the store's).
export type RunRecord = Omit<RoutineRun, "id" | "routine" | "page">;
// A live run's answer, kept for its interval: what its widgets show, or why it failed (with the last that worked).
export interface LiveAnswer {
  at: Iso;
  ok: boolean;
  ms: number;
  error: string | null;
  widgets: { id: unknown; data: unknown }[] | null;
  failed?: true;
}
// A test run: what it would change, said, ask and show, or why it failed.
export interface TestRun {
  at: Iso;
  ok: boolean;
  ms: number;
  error: string | null;
  log: string;
  changes: PageChange[];
  summary: string | null;
  ask: string | null;
  widgets: unknown[] | null;
}
export interface RoutinesHost {
  state: State;
  threadOf?: (id: string) => unknown;
  commit: (op: RoutineOp) => unknown;
  exec: (args: ExecArgs) => Promise<unknown>;
  checkWrite: Parameters<typeof checkRun>[1]["checkWrite"];
  writePage: (r: Routine, out: CheckedRun) => number | null;
  postLine?: (r: Routine, out: CheckedRun) => void;
  launch: (r: Routine, c: RoutineCode, why: string) => Promise<{ lid?: string; post?: string } | null | undefined>;
  busy?: (r: Routine) => string | null;
  log?: (line: string) => void;
}

// The scheduler. server/api/routines.ts, which knows pages, threads and machines, gives it:
// - `exec(args)`: a code routine's code run once on a machine, and what it returned, unchecked;
// - `checkWrite(pid, out)` and `writePage(r, out)`: a code run's widgets checked against its page, and written as
//   a version; `postLine(r, out)`: a code run's line on its thread;
// - `launch(r, version, why)`: an agent run, started: { lid } for a new session, { post } for a message to its
//   thread. Throws when it can't start. `busy(r)`: why an agent routine can't run now (its last run is still
//   working), or null;
// - `threadOf(id)`: a thread, by the page's id, wherever it is.
export type Routines = ReturnType<typeof createRoutines>;
export function createRoutines({ state, threadOf = () => null, commit, exec, checkWrite, writePage, postLine = () => {}, launch, busy = () => null, log = () => {} }: RoutinesHost) {
  const running = new Map<string, { at: Iso; why: string }>(); // rid -> { at, why }
  const tested = new Map<string, TestRun>(); // hash of code, reach and keeps -> a test run, for the OK when it's saved unchanged

  // Run code once, as a routine with this reach and these widgets, on the machine that runs it (`run`, exec unless
  // said): what it returned, checked, and its log. The page isn't touched. A live run gets the page's filters too
  // (`filters`: { filters, ranges, params }).
  async function execute({ rid, page, code, reach, keeps, memo, last, timeout, run = exec, filters = null }: { rid: string; page: string | null; code: string; reach: RoutineReach; keeps: string[]; memo?: Record<string, unknown>; last?: { at: Iso; ok: boolean } | null; timeout?: number; run?: (args: ExecArgs) => Promise<unknown>; filters?: LiveInputs | null }): Promise<CheckedRun> {
    const p = page ? state.pages[page] : null;
    const widgets = Object.fromEntries((p?.widgets || []).map((w) => [w.id, { id: w.id, type: w.type, title: w.title, data: w.data }]));
    const raw = await run({ rid: rid || "new", page: page || null, code, reach, keeps: keeps || [], memo: memo || {}, last: last || null, timeout: timeout || TIMEOUT_MS, widgets, ...(filters ? { filters: filters.filters || {}, ranges: filters.ranges || {}, params: filters.params || {}, live: true } : {}) });
    return checkRun(raw, { page, keeps, checkWrite });
  }

  // An agent run: a session started with its prompt, or a message to its thread. One whose last run is still
  // working is skipped, and the skip is its run, so the next one comes at its next time.
  async function runAgent(r: Routine, c: RoutineCode, why: string): Promise<RunRecord> {
    const at = new Date().toISOString();
    const reason = busy(r);
    if (reason) {
      const runRec: RunRecord = { at, ms: 0, ok: true, why, v: c.v, skipped: reason };
      commit({ t: "routine.run", rid: r.id, run: runRec });
      return runRec;
    }
    running.set(r.id, { at, why });
    const started = Date.now();
    try {
      let x: { ok: boolean; error?: string; lid?: string; post?: string };
      try {
        x = { ok: true, ...(await launch(r, c, why)) };
      } catch (e) {
        x = { ok: false, error: e.message };
      }
      const runRec: RunRecord = { at, ms: Date.now() - started, ok: x.ok, why, v: c.v, error: x.error || null, lid: x.lid || null, post: x.post || null };
      if (state.routines[r.id]) commit({ t: "routine.run", rid: r.id, run: runRec });
      if (!x.ok) log(`routine ${r.id}: ${x.error}`);
      return runRec;
    } finally {
      running.delete(r.id);
    }
  }

  // A run on the schedule, or Run now: its live version. A code run's widgets are written to its page, its line to
  // its thread.
  async function run(rid: string, why = "schedule"): Promise<RunRecord | null> {
    const r = state.routines[rid];
    if (!r || running.has(rid)) return null;
    const c = versionOf(state, rid, r.live_v);
    if (!c) return null;
    if (r.kind === "agent") return runAgent(r, c, why);
    running.set(rid, { at: new Date().toISOString(), why });
    const at = new Date().toISOString();
    try {
      const x = await execute({ rid, page: r.page, code: c.code, reach: c.reach, keeps: r.keeps, memo: r.memo, last: r.last ? { at: r.last.at, ok: r.last.ok } : null, timeout: r.timeout });
      let version: number | null = null;
      if (x.ok && state.routines[rid] && r.page && state.pages[r.page]) {
        try {
          version = writePage(state.routines[rid], x);
        } catch (e) {
          Object.assign(x, { ok: false, error: e.message });
        }
      } else if (x.ok && !r.page && state.routines[rid]) {
        try {
          postLine(state.routines[rid], x);
        } catch (e) {
          log(`routine ${rid}: ${e.message}`);
        }
      }
      const runRec: RunRecord = { at, ms: x.ms, ok: x.ok, why, v: c.v, error: x.error || null, log: str(x.log, 8 * 1024), changed: x.ok ? x.changes.filter((ch) => ch.id).map((ch) => ch.id) : [], version, ask: x.ask || null, notable: x.notable || null };
      if (state.routines[rid]) commit({ t: "routine.run", rid, run: runRec, ...(x.ok ? { memo: x.memo || {} } : {}) });
      if (!x.ok) log(`routine ${rid}: ${x.error.split("\n")[0]}`);
      return runRec;
    } finally {
      running.delete(rid);
    }
  }

  // A live run: its page is open, so its live version runs with the page's filters (and a widget's params) as its
  // inputs, and what it returns goes to the screen, not into a version. The answer is kept for its interval, for
  // these inputs, so another tab or a reload gets it without asking again; one run at a time for the same inputs.
  // `fresh: false` (someone who can't change the page) only takes what's kept.
  const liveKept = new Map<string, LiveAnswer>(); // "<rid>@<v>|<inputs>" -> { at, ok, ms, error, widgets }
  const liveRuns = new Map<string, Promise<LiveAnswer>>(); // same key -> the promise of its run
  async function liveRun(rid: string, inputs: LiveInputs = {}, { fresh = true } = {}): Promise<LiveAnswer | null> {
    const r = state.routines[rid];
    if (!r || r.schedule?.kind !== "live" || !r.on || !r.live_v || !r.page) return null;
    // What was picked, not the dates it comes to now, which move every second.
    const key = `${rid}@${r.live_v}|${JSON.stringify([inputs.filters || {}, inputs.params || {}])}`;
    const kept = liveKept.get(key);
    if (kept && (Date.now() - Date.parse(kept.at) < r.schedule.everyMs - 1000 || !fresh)) return kept;
    if (!fresh) return null;
    if (liveRuns.has(key)) return liveRuns.get(key);
    if (liveRuns.size >= LIVE_AT_ONCE) return kept || null;
    const c = versionOf(state, rid, r.live_v);
    if (!c) return null;
    const p = (async () => {
      const at = new Date().toISOString();
      const x = await execute({ rid, page: r.page, code: c.code, reach: c.reach, keeps: r.keeps, memo: r.memo, last: r.last ? { at: r.last.at, ok: r.last.ok } : null, timeout: Math.min(r.timeout || TIMEOUT_MS, 30e3), filters: inputs });
      const out: LiveAnswer = { at, ok: x.ok, ms: x.ms, error: x.error ? x.error.split("\n")[0] : null, widgets: x.ok ? (x.widgets as { id: unknown; data: unknown }[]).map((w) => ({ id: w.id, data: w.data })) : null };
      if (!x.ok) log(`routine ${rid} (live): ${out.error}`);
      // A failed run keeps showing the last answer that worked, saying it failed.
      liveKept.set(key, x.ok || !kept ? out : { ...kept, at, error: out.error, failed: true });
      if (liveKept.size > 500) liveKept.delete(liveKept.keys().next().value);
      return liveKept.get(key);
    })().finally(() => liveRuns.delete(key));
    liveRuns.set(key, p);
    return p;
  }

  // A test: code that may not be saved yet, run once as its routine would (on `run`'s machine), without writing
  // anything.
  async function test({ rid, page, code, reach, keeps, timeout, run: on }: { rid?: string | null; page: string | null; code: string; reach: RoutineReach; keeps: string[]; timeout?: number; run?: (args: ExecArgs) => Promise<unknown> }): Promise<TestRun> {
    const r = rid ? state.routines[rid] : null;
    const x = await execute({ rid: rid || "new", page, code, reach, keeps, memo: r?.memo || {}, last: r?.last ? { at: r.last.at, ok: r.last.ok } : null, timeout: timeout || r?.timeout, run: on || exec });
    const t: TestRun = { at: new Date().toISOString(), ok: x.ok, ms: x.ms, error: x.error || null, log: str(x.log, 8 * 1024), changes: x.ok ? x.changes : [], summary: x.summary || null, ask: x.ask || null, widgets: x.ok ? x.widgets : null };
    tested.set(hash(JSON.stringify([code, reachFrom(reach), keeps])), t);
    setTimeout(() => tested.delete(hash(JSON.stringify([code, reachFrom(reach), keeps]))), 600e3).unref();
    return t;
  }
  const testedAlready = (code: string, reach: unknown, keeps: string[]): TestRun | null => tested.get(hash(JSON.stringify([code, reachFrom(reach), keeps]))) || null;

  // Every 15 seconds: the routines that are due, a few at a time. A server that was down runs an overdue routine
  // once, not once for every run it missed.
  function tick(): void {
    const due = Object.values(state.routines)
      .filter((r) => r.on && r.live_v && !running.has(r.id) && (!r.page || (state.pages[r.page] && !state.pages[r.page].archived)) && (!r.thread || threadOf(r.thread)))
      .filter((r) => nextAt(r) != null && nextAt(r) <= Date.now())
      .sort((a, b) => nextAt(a) - nextAt(b));
    for (const r of due.slice(0, Math.max(0, AT_ONCE - running.size))) run(r.id).catch((e) => log(`routine ${r.id}: ${e.message}`));
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    running,
    run,
    liveRun,
    busy,
    test,
    testedAlready,
    tick,
    start() {
      timer ||= setInterval(tick, Number(process.env.AGENTBOOK_ROUTINES_TICK_MS || 15e3));
      timer.unref?.();
      setTimeout(tick, 3e3).unref?.();
    },
    stop: () => clearInterval(timer),
  };
}
