// What this machine's agents did before agentbook followed them, for the welcome card (shared/history.ts,
// web/components/welcome/): each runtime lists its past sessions (Runtime.past), this counts them by day and folder,
// and once its person picks how far back (history.pick) the runtimes bring those in, as ended threads. Until they
// pick, a machine logged in with nobody at its terminal keeps its past here (gate.json's history_pick "pending", its
// history_from the login's time).

import fs from "node:fs";
import path from "node:path";
import { HISTORY_MAX, daysAgo, pickFrom } from "../shared/history.ts";
import type { HistoryAgent, HistoryPick, HistoryRead, HistorySession } from "../shared/history.ts";
import type { State } from "../shared/types.ts";
import type { createGate } from "./gate.ts";
import type { PastSession, Runtime } from "./runtimes/runtime.ts";

// How long a listing is kept: the card asks again every few seconds while the past comes in.
const LIST_MS = 60e3;
// How long the card says the past came in, once it has.
const SAID_MS = 86400e3;

interface Saved {
  started: string;
  picked: Record<string, string[]>;
  finished?: string | null;
  error?: string | null;
}

export interface HistoryOpts {
  machine: string;
  dir: string;
  state: State;
  gate: ReturnType<typeof createGate>;
  runtimes: () => Runtime[];
  changed: () => void;
  log: (line: string) => void;
}

export function createHistory({ machine, dir, state, gate, runtimes, changed, log }: HistoryOpts) {
  const file = path.join(dir, "history.json");
  let listed: { at: number; by: Map<string, { agent: HistoryAgent; list: PastSession[] }> } | null = null;
  let listing: Promise<NonNullable<typeof listed>> | null = null;
  let bringing: Promise<void> | null = null;

  const pick = (): HistoryPick | null => {
    const p = gate.settings().history_pick;
    return p && p !== "pending" ? p : null;
  };
  const pending = () => gate.settings().history_pick === "pending";
  // Read again only once it changed: the machine's info, which says where the card stands, is asked for often.
  let kept: { mtime: number; s: Saved | null } | null = null;
  const saved = (): Saved | null => {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    if (kept?.mtime === mtime) return kept.s;
    let s: Saved | null = null;
    try {
      s = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    kept = { mtime, s };
    return s;
  };
  const save = (s: Saved) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.part`, JSON.stringify(s));
    fs.renameSync(`${file}.part`, file);
    kept = null;
  };
  // The sessions that are threads already, by their ids and their runtimes' ids for them.
  const threadIds = () => {
    const ids = new Set<string>();
    for (const s of Object.values(state.sessions)) {
      ids.add(s.id);
      if (s.session_id) ids.add(s.session_id);
    }
    return ids;
  };

  // Every runtime here that keeps a past, by its kind (an agent's own config folder joins its kind's).
  function list(fresh = false) {
    if (!fresh && listed && Date.now() - listed.at < LIST_MS) return Promise.resolve(listed);
    listing ||= (async () => {
      const by = new Map<string, { agent: HistoryAgent; list: PastSession[] }>();
      for (const r of runtimes()) {
        if (!r.past || r.health().enabled === false) continue;
        const got = await r.past.list().catch((e) => (log(`history: ${r.id}: ${e.message}`), [] as PastSession[]));
        const k = by.get(r.id) || { agent: { kind: r.id, agent: r.past.agent?.() || r.id, name: r.info.name, keeps: r.past.keeps?.() ?? null }, list: [] };
        k.list.push(...got);
        by.set(r.id, k);
      }
      return (listed = { at: Date.now(), by });
    })().finally(() => (listing = null));
    return listing;
  }

  // What the card shows: the sessions not yet threads, newest first, as [agent, day, folder].
  async function read(): Promise<HistoryRead> {
    const { by } = await list();
    const known = threadIds();
    const agents: HistoryAgent[] = [];
    const folders: string[] = [];
    const folderAt = new Map<string, number>();
    const all: [number, number, string | undefined][] = [];
    for (const { agent, list: l } of by.values()) {
      const a = agents.push(agent) - 1;
      for (const s of l) if (!known.has(s.id)) all.push([a, s.at, s.cwd]);
    }
    all.sort((x, y) => y[1] - x[1]);
    const now = new Date();
    const sessions: HistorySession[] = all.slice(0, HISTORY_MAX).map(([a, at, cwd]) => {
      let f = -1;
      if (cwd) {
        if (!folderAt.has(cwd)) folderAt.set(cwd, folders.push(cwd) - 1);
        f = folderAt.get(cwd);
      }
      return [a, daysAgo(at, now), f];
    });
    const d = now;
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { machine, pending: pending(), pick: pick(), today, agents, folders, sessions, ...(all.length > HISTORY_MAX ? { more: all.length - HISTORY_MAX } : {}), progress: progress() };
  }

  // How the bringing in goes: of the sessions picked, those that are threads now.
  function progress(): HistoryRead["progress"] {
    const s = saved();
    if (!s) return null;
    const by: Record<string, { total: number; done: number }> = {};
    let total = 0;
    let done = 0;
    const known = threadIds();
    for (const [kind, ids] of Object.entries(s.picked)) {
      const d = ids.filter((id) => known.has(id)).length;
      by[kind] = { total: ids.length, done: d };
      total += ids.length;
      done += d;
    }
    return { total, done, by, started: s.started, finished: s.finished || null, error: s.error || null };
  }

  // Where the welcome card stands for this machine's row on the page.
  function standing(): "pending" | "importing" | "imported" | "picked" | undefined {
    if (pending()) return "pending";
    const s = saved();
    if (s && !s.finished) return "importing";
    if (s?.finished && Date.now() - Date.parse(s.finished) < SAID_MS) return "imported";
    return pick() ? "picked" : undefined;
  }

  // The person picked: the last `days` days (0: none, null: all), less the agents and folders left out. What's in
  // the range comes in, newest first, each runtime its own way.
  async function choose({ days, out_agents = [], out_folders = [] }: { days: number | null; out_agents?: string[]; out_folders?: string[] }) {
    if (bringing) throw Object.assign(new Error("It's already bringing in what you picked."), { status: 409 });
    const now = new Date();
    const from = days === 0 ? now.toISOString() : pickFrom(days, now);
    const p: HistoryPick = { from, out_agents, out_folders, at: now.toISOString() };
    gate.agree({ history_pick: p, history_from: from ?? null });
    const { by } = await list(true);
    const picked: Record<string, string[]> = {};
    const since = from ? Date.parse(from) : 0;
    const known = threadIds();
    for (const [kind, { list: l }] of by) {
      if (out_agents.includes(kind) || days === 0) continue;
      const ids = l.filter((s) => s.at >= since && !known.has(s.id) && !outOf(out_folders, s.cwd)).sort((a, b) => b.at - a.at).map((s) => s.id);
      if (ids.length) picked[kind] = ids;
    }
    save({ started: now.toISOString(), picked, finished: Object.keys(picked).length ? null : now.toISOString() });
    log(`history: picked ${days == null ? "all" : `${days} days`}: ${Object.entries(picked).map(([k, ids]) => `${ids.length} ${k}`).join(", ") || "nothing"}`);
    changed();
    if (Object.keys(picked).length) bring(picked);
    return { picked: Object.fromEntries(Object.entries(picked).map(([k, ids]) => [k, ids.length])) };
  }

  function bring(picked: Record<string, string[]>) {
    bringing = (async () => {
      const errors: string[] = [];
      for (const r of runtimes()) {
        const ids = picked[r.id];
        if (!ids?.length || !r.past?.bring) continue;
        try {
          const known = threadIds();
          await r.past.bring(ids.filter((id) => !known.has(id)));
        } catch (e) {
          errors.push(`${r.info.name}: ${e.message}`);
          log(`history: ${r.id}: ${e.stack || e.message}`);
        }
        changed();
      }
      const s = saved();
      if (s) save({ ...s, finished: new Date().toISOString(), error: errors.length ? `Some didn't come in. ${errors.join(" ")}` : null });
      listed = null;
      changed();
    })().finally(() => (bringing = null));
  }

  // A machine that stopped while bringing its past in picks up where it was.
  function resume() {
    const s = saved();
    if (s && !s.finished && !bringing) bring(s.picked);
  }

  return { read, choose, standing, resume, progress };
}

// Whether a folder is one of those left out, or in one.
export const outOf = (out: string[], cwd: string | null | undefined) => !!cwd && out.some((f) => cwd === f || cwd.startsWith(f.endsWith("/") ? f : `${f}/`));
