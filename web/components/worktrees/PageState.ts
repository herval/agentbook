// What a worktree's page (a branch's or a pull request's) keeps while you're on it: the tab open, its Changes' scope,
// the files open in it and their diffs, its whole story or not, Clean up asked once, the box open under one of its
// threads, comments or files, the review threads you resolved here, and what you told its agent (kept in this
// browser for a week). A new worktree's page starts from nothing, but for what's kept across them (the old page's
// S.wipTab, S.wipScope, S.wipOpen, S.wipDiffs, S.wipAll, S.wipCleaning, S.prBox, S.prDone, S.told, S.sending).
import { useEffect } from "react";
import { create } from "zustand";
import type { Told, WipDiff } from "../../lib/types.ts";
import { sharedApi, takeGoFile } from "./ship.ts";
import type { Wip } from "./wips.ts";

// The box open on a WIP's page, under one of its threads, comments or files: { id, key, mode: "reply" | "tell" }.
export interface PrBox {
  id: string;
  key: string;
  mode: string;
}
interface WipPageState {
  // The WIP this is for.
  id: string | null;
  // Its tab: "changes" (the first), "checks", "review", "activity", "description" or "results".
  tab: string | null;
  // Its Changes: "uncommitted" or "committed"; null: whichever has something.
  scope: string | null;
  // Its files open in Changes, as "scope|path" ("pr|path" on a pull request's).
  open: Set<string>;
  // Their diffs, fetched when you open them: "scope|path" -> { loading, diff, error }.
  diffs: Record<string, WipDiff>;
  // Its whole story, not just the latest.
  all: boolean;
  // The WIP whose Clean up was pressed once.
  cleaning: string | null;
  box: PrBox | null;
  // The review threads you resolved on this page, still shown, folded, with Undo.
  done: Set<string>;
  // What you told a WIP's agent about one of its threads, comments or files (in this browser).
  told: Record<string, Told>;
  // The boxes whose words are on their way (their draft keys).
  sending: Set<string>;
  // A file opened from a task's Changes: scrolled to, once, as soon as its page lists it ("scope|path").
  scrollTo: string | null;
}

// What you told, kept in this browser for a week.
function loadTold(): Record<string, Told> {
  try {
    const all: Record<string, Told> = JSON.parse(localStorage.getItem("agentbook.told")) || {};
    const week = new Date(Date.now() - 7 * 86400e3).toISOString();
    return Object.fromEntries(Object.entries(all).filter(([, t]) => t?.at > week));
  } catch {
    return {};
  }
}
export function saveTold() {
  try {
    localStorage.setItem("agentbook.told", JSON.stringify(usePage.getState().told));
  } catch {}
}

// The store, read with usePage(selector) in a component.
export const usePage = create<WipPageState>(() => ({ id: null, tab: null, scope: null, open: new Set(), diffs: {}, all: false, cleaning: null, box: null, done: new Set(), told: loadTold(), sending: new Set(), scrollTo: null }));
const P = usePage.getState;
const setP = usePage.setState;

// A WIP's page starts with nothing open, on its first tab: what was open was another one's. What you resolved and
// told stays.
export function pageFor(id: string) {
  if (P().id === id) return;
  setP({ id, tab: null, scope: null, open: new Set(), diffs: {}, all: false, cleaning: null, scrollTo: null });
}
// A tab picked, a scope picked, the whole story asked for, Clean up asked (or not), a box opened (or closed).
export const setTab = (tab: string) => setP({ tab });
export const setScope = (scope: string) => setP({ scope });
export const showAll = () => setP({ all: true });
export const setCleaning = (cleaning: string | null) => setP({ cleaning });
export const setBox = (box: PrBox | null) => setP({ box });
// The box's words are on their way (its submit button off), or back.
export function sendingNow(draft: string, on: boolean) {
  const sending = new Set(P().sending);
  if (on) sending.add(draft);
  else sending.delete(draft);
  setP({ sending });
}
// A review thread resolved here (or Undo).
export function markDone(thread: string, on: boolean) {
  const done = new Set(P().done);
  if (on) done.add(thread);
  else done.delete(thread);
  setP({ done });
}
export function keepTold(key: string, t: Told) {
  setP({ told: { ...P().told, [key]: t } });
  saveTold();
}

const setDiff = (key: string, d: WipDiff) => setP((s) => ({ diffs: { ...s.diffs, [key]: d } }));
// A branch's file's diff, in a scope ("uncommitted" or "committed"). One on a task shared with you: through the task.
export async function loadWipDiff(w: Wip, scope: string, file: string) {
  const key = `${scope}|${file}`;
  setDiff(key, { loading: true });
  const q = new URLSearchParams({ root: w.root, branch: w.branch, path: file, scope, ...(w.machine ? { machine: w.machine } : {}) });
  const res = await fetch(w.shared ? sharedApi(w, "worktree/diff", { path: file, scope }) : `/api/wip/diff?${q}`).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  setDiff(key, res?.ok ? { diff: body } : { error: body.error || "Couldn't read this change." });
}
// A pull request's file's diff, at the commit its page read (`sha`), as GitHub has it.
export async function loadPullDiff(x: Wip, file: string, sha: string) {
  const key = `pr|${file}`;
  setDiff(key, { loading: true });
  const res = await fetch(x.shared ? sharedApi(x, "pull/diff", { path: file, sha }) : `/api/pulls/diff?${new URLSearchParams({ workspace: x.ws.id, number: String(x.number), path: file, sha })}`).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  setDiff(key, res?.ok ? { diff: body } : { error: body.error || "Couldn't read this change." });
}
// A file in Changes opened or closed: opening one not read yet (or that failed) reads its diff (`load`).
export function toggleFile(key: string, load: () => void) {
  const s = P();
  const open = new Set(s.open);
  if (open.has(key)) open.delete(key);
  else {
    open.add(key);
    if (!s.diffs[key] || s.diffs[key].error) load();
  }
  setP({ open });
}


// A file picked in a WIP of many's Changes (the task's page) opens on its own page: the task's page says which before
// the page changes (ship.ts's setGoFile). On its page: open there, in its Changes tab, its diff read, and scrolled to
// once its page lists it.
export function fileOpened(w: Wip, sha = "") {
  const go = takeGoFile(w.id);
  if (!go) return;
  const open = new Set(P().open);
  open.add(go.key);
  setP({ tab: "changes", ...(go.scope !== "pr" ? { scope: go.scope } : {}), open, scrollTo: go.key });
  const file = go.key.slice(go.key.indexOf("|") + 1);
  if (w.kind === "pr") void loadPullDiff(w, file, sha || w.pr?.sha || "");
  else void loadWipDiff(w, go.scope, file);
}
// A file opened from a task's Changes: to it, once, as soon as its page lists it.
export function useScrollTo() {
  const key = usePage((s) => s.scrollTo);
  useEffect(() => {
    if (!key) return;
    const path = key.slice(key.indexOf("|") + 1);
    const el = document.querySelector(`.chg-files [data-pr-file="${CSS.escape(path)}"], .chg-files [data-wip-file="${CSS.escape(path)}"]`);
    if (!el) return;
    setP({ scrollTo: null });
    requestAnimationFrame(() => el.scrollIntoView({ block: "start", behavior: "smooth" }));
  });
}
