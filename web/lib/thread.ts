// The thread open on its own page, or in a page's or a group's threads bar: it and its latest messages (q/thread),
// watched on the page's stream from then on (heardLive); its steps; and what it changed. One at a time: opening
// another stops the stream bringing the first.
import { useEffect } from "react";
import { dropWatch, getJSON, loader, query } from "./api.ts";
import { isTalkId } from "./format.ts";
import { getApp, setApp, useApp } from "./store.ts";
import type { OpenThread } from "./store.ts";
import type { Changes, Message, RunSeen, Step, Steps, ThreadDetail, ThreadQ } from "./types.ts";

const enc = encodeURIComponent;
export const threadDetailOf = (q: ThreadQ): ThreadDetail => ({ ...q.records[q.thread], messages: q.messages.map((k) => q.records[k]), older: q.older, earlier: q.earlier || 0, live: q.live, runs: q.runs ?? null, watching: !!q.watching, v: q.watching || 0, names: q.names || {}, workspaces: q.workspaces || [], others: q.others || [], from: q.from || null, startedThreads: q.started || [] }) as ThreadDetail;
// What a thread's page keeps of its thread when its record changes.
const keptOf = (t: ThreadDetail) => ({ messages: t.messages, older: t.older, earlier: t.earlier, live: t.live, runs: t.runs, watching: t.watching, v: t.v, names: t.names, workspaces: t.workspaces, others: t.others, from: t.from, startedThreads: t.startedThreads });

// What the stream said while the thread was being asked for, for once it's in.
const held: [string, unknown][] = [];
let asking: string | null = null;
// Which part of what it changed you picked: "auto" lets the server pick, "all", or a turn ("3").
let chgScope = "auto";
export const changesUrl = (id: string, scope = chgScope) => `/api/sessions/${enc(id)}/changes?scope=${enc(scope || "auto")}`;

const setOpen = (o: Partial<OpenThread>) => setApp((s) => (s.open ? { open: { ...s.open, ...o } } : {}));

// Open a thread: ask for it, its steps and its changes, and hear what changes in it from then on.
export async function openThread(id: string, { bar = false, around }: { bar?: boolean; around?: string } = {}) {
  const s = getApp();
  if (s.open && s.open.id !== id) closeThread();
  if (!getApp().open) setApp({ open: { id, detail: null, steps: null, chg: null, gone: false, loading: true, bar } });
  asking = id;
  held.length = 0;
  // A thread of yours has no steps or changes of its own: its agents' threads have them.
  const talk = isTalkId(id);
  const [q, steps, chg] = await Promise.all([query("/api/q/thread/:id", { id, n: 100, ...(around ? { around } : {}), ...(s.liveId ? { live: s.liveId } : {}) }), talk ? null : getJSON<Steps>(`/api/sessions/${enc(id)}/steps`), talk || bar ? null : getJSON<Changes>(changesUrl(id))]).finally(() => asking === id && (asking = null));
  if (getApp().open?.id !== id) return void (held.length = 0);
  setOpen({ detail: q && threadDetailOf(q), gone: !q, steps, chg, loading: false });
  for (const [event, d] of held.splice(0)) heardLive(event, d);
}
// Stop showing it: the stream stops bringing what changes in it.
export function closeThread() {
  const { open, liveId } = getApp();
  if (open?.detail?.watching) dropWatch({ live: liveId, drop: "open", v: open.detail.v });
  chgScope = "auto";
  setApp({ open: null });
}
// The thread open on this screen, while the screen is up (a thread's page, a page's bar).
export function useOpenThread(id: string | null, { bar = false, around }: { bar?: boolean; around?: string } = {}): OpenThread | null {
  useEffect(() => {
    if (!id || id.startsWith("launch:")) return;
    openThread(id, { bar, around });
    return () => {
      if (getApp().open?.id === id) closeThread();
    };
  }, [id, bar, around]);
  return useApp((s) => (id && s.open?.id === id ? s.open : null));
}

// What it changed, read again (a turn or a step changed something), or in another scope.
export const loadChanges = loader(async () => {
  const o = getApp().open;
  if (!o || o.bar || isTalkId(o.id)) return;
  const chg = await getJSON<Changes>(changesUrl(o.id));
  if (getApp().open?.id === o.id) setOpen({ chg });
});
export function pickChanges(scope: string) {
  chgScope = scope;
  loadChanges();
}
// Its messages before the first it has.
export const loadOlder = loader(async () => {
  const t = getApp().open?.detail;
  if (!t?.older) return;
  const q = await query("/api/q/thread/:id", { id: t.id, n: 100, before: t.older });
  const now = getApp().open?.detail;
  if (!q || now?.id !== t.id) return;
  const have = new Set(now.messages.map((m) => m.id));
  setOpen({ detail: { ...now, messages: [...q.messages.map((k) => q.records[k] as Message).filter((m) => !have.has(m.id)), ...now.messages], older: q.older, earlier: q.earlier || 0 } });
});
// Read it again from the top (the stream started over, or something it doesn't say changed).
export function reloadThread() {
  const o = getApp().open;
  if (o) openThread(o.id, { bar: o.bar });
}

// What the stream says changed for a thread, by event: put/del (`records`, `keys`), messages and runs (`put`, `del`:
// messages or runs, by event), live, and steps (`from`, `total`, `steps`, `plan`, `turn`).
export interface LiveDelta {
  records?: Record<string, ThreadDetail>;
  keys?: string[];
  thread?: string;
  put?: unknown[];
  del?: string[];
  live?: ThreadDetail["live"];
  from?: number;
  total?: number;
  steps?: Step[];
  plan?: Steps["plan"];
  turn?: number;
}

// What changed in the open thread, as the page's stream says, applied to what the page has of it.
export function heardLive(event: string, d: LiveDelta) {
  if (asking) return void held.push([event, d]);
  const o = getApp().open;
  const t = o?.detail;
  if (!t?.watching) return;
  const key = `thread:${t.id}`;
  let detail: ThreadDetail | null = t;
  let steps = o.steps;
  if (event === "put") {
    if (!d.records[key]) return;
    detail = { ...d.records[key], ...keptOf(t) };
  } else if (event === "del") {
    if (!d.keys.includes(key)) return;
    detail = null;
  } else if (d.thread !== t.id) return;
  else if (event === "messages") {
    const gone = new Set(d.del);
    const sent = d.put as Message[];
    const put = new Map<string, Message>(sent.map((m) => [m.id, m]));
    const messages = t.messages.filter((m) => !gone.has(m.id)).map((m) => put.get(m.id) || m);
    for (const m of sent) if (!t.messages.some((x) => x.id === m.id)) messages.push(m);
    detail = { ...t, messages };
  } else if (event === "live") detail = { ...t, live: d.live };
  else if (event === "runs") {
    const sent = d.put as RunSeen[];
    const k = (r: RunSeen) => `${r.message}:${r.block}`;
    const drop = new Set([...d.del, ...sent.map(k)]);
    detail = { ...t, runs: [...(t.runs || []).filter((r) => !drop.has(k(r))), ...sent] };
  } else if (event === "steps") {
    const had = o.steps?.steps || [];
    steps = { ...o.steps, steps: [...had.slice(0, Math.min(d.from, d.total ?? Infinity)), ...d.steps], plan: d.plan, turn: d.turn };
  } else if (event === "changes") return void loadChanges();
  setOpen({ detail, steps, gone: !detail });
}
