// The chrome: everything but the threads a screen lists (agents, pages, notes, groups,
// machines, workspaces, tasks, routines, connectors, questions, threads starting, folders), one copy of each by
// `type:id`, from q/side and then what the page's stream says changed (`side`). Each kind is a list in the server's
// order, made again when one of it changes. Its thread rows go to the store's `rows`.
import { loader, query } from "./api.ts";
import { restartLive } from "./live.ts";
import { getApp, setApp } from "./store.ts";
import type { PageData, SideRecord, TaskRow, Thread } from "./types.ts";

const SIDE_KINDS = { agent: "agents", page: "pages", note: "notes", group: "groups", machine: "machines", workspace: "workspaces", task: "tasks", routine: "routines", connector: "connectors", question: "questions", launch: "launches", folder: "folders" };
// What q/side sent, and the stream since: records by `type:id`, each kind's keys in order, what isn't a record, and
// what the stream said while it was being read (`held`).
const side: { v: number; records: Record<string, SideRecord>; order: Record<string, string[]>; data: Partial<PageData>; loading: boolean; held: SideDelta[] } = { v: 0, records: {}, order: {}, data: {}, loading: false, held: [] };
// What the stream says changed in the chrome.
export interface SideDelta {
  v: number;
  put?: Record<string, SideRecord>;
  del?: string[];
  order?: Record<string, string[]>;
  data?: Partial<PageData>;
}

function build(kinds: string[]) {
  const d = { ...(getApp().data || {}), ...side.data } as PageData;
  let rows: Record<string, Thread> | null = null;
  for (const kind of kinds) {
    const list = (side.order[kind] || []).map((k) => side.records[k]).filter(Boolean);
    if (SIDE_KINDS[kind]) d[SIDE_KINDS[kind]] = list;
    // The to-dos threads keep for you (`scope`, ab_todo) are theirs, on them: not on Tasks.
    if (kind === "task") Object.assign(d, { tasks: list.filter((t: TaskRow) => !t.scope), todos: list.filter((t: TaskRow) => t.scope) });
    if (kind === "thread") rows = Object.fromEntries((list as Thread[]).map((r) => [r.id, r]));
  }
  setApp((s) => ({ data: d, ui: s.ui ?? d.ui ?? null, ...(rows ? { rows } : {}) }));
}

// The chrome is asked for once per hello, and from then on only heard about. An ask that isn't answered (the server
// stalled or restarting, the network dropped it as the Mac woke) would leave the page with the chrome as it was, the
// threads that started since missing from ⌘K and the sidebar, until its stream next starts over, which a stream that
// only reconnects never does. So it's asked again, a little later each time (from 1 s to 30 s), until it's answered;
// an answer that says the server doesn't know this page's stream (lost, while the page's connection didn't say so)
// opens the stream again, whose hello asks again.
const SIDE_MS = 30e3; // longer than this, and it's taken as unanswered
let tries = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
function again(liveId: string | null, then: () => unknown) {
  // (Not once signed out, or once another hello has asked: that one goes on by itself.)
  if (!liveId || !getApp().me || getApp().liveId !== liveId) return;
  retry = setTimeout(then, Math.min(SIDE_MS, 1000 * 2 ** tries++));
}

export const loadSide = loader(async () => {
  clearTimeout(retry);
  side.loading = true;
  side.held.length = 0;
  const liveId = getApp().liveId;
  const q = await query("/api/q/side", { ...(liveId ? { live: liveId } : {}) }, { signal: AbortSignal.timeout(SIDE_MS) })
    .catch(() => null)
    .finally(() => (side.loading = false));
  if (!q) return again(liveId, loadSide);
  if (liveId && !q.watching) again(liveId, restartLive);
  else tries = 0;
  Object.assign(side, { v: q.watching || 0, records: q.records, order: q.order, data: q.data });
  build([...Object.keys(SIDE_KINDS), "thread"]);
  for (const d of side.held.splice(0)) heardSide(d);
});

// What changed in the chrome, applied to it. A thread whose row goes (archived, or no longer yours to see) goes from
// the other screens' rows too.
export function heardSide(d: SideDelta) {
  if (side.loading) return void side.held.push(d);
  if (d.v !== side.v) return;
  const kinds = new Set(Object.keys(d.order || {}));
  for (const [k, r] of Object.entries(d.put || {})) {
    side.records[k] = r;
    kinds.add(k.split(":")[0]);
  }
  const gone: string[] = [];
  for (const k of d.del || []) {
    delete side.records[k];
    kinds.add(k.split(":")[0]);
    if (k.startsWith("thread:")) gone.push(k.slice(7));
  }
  if (gone.length) setApp((s) => ({ more: Object.fromEntries(Object.entries(s.more).filter(([id]) => !gone.includes(id))) }));
  Object.assign(side.order, d.order || {});
  if (d.data) side.data = d.data;
  build([...kinds]);
}

// Forget the chrome (signed out).
export function clearSide() {
  clearTimeout(retry);
  tries = 0;
  Object.assign(side, { v: 0, records: {}, order: {}, data: {}, loading: false, held: [] });
}
