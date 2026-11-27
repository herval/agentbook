// What the page's screens keep between their parts: the open page's detail (its versions and threads), a version of it
// you're looking at, the copy you're editing by hand, how you sorted its tables, which folds are open, and the threads
// bar's picks. Kept here, not in the components, because several parts read each, and some (a table's sort, the
// bar's picks, what Pages is narrowed to) last as you go from page to page, as they did on the old page.
import { create } from "zustand";
import { getJSON } from "../../lib/api.ts";
import { getApp, takeRows } from "../../lib/store.ts";
import type { DashAnswers, PageAt, PageEdit, PageLive, PageView } from "../../lib/types.ts";
import type { PageRec } from "./pages.ts";

export interface PageUi {
  // The open page in full (/api/pages/:id), and a version of it (/api/pages/:id/versions/:v).
  detail: PageView | null;
  at: PageAt | null;
  // The page being edited by hand.
  edit: PageEdit | null;
  // Versions shows all of them, not the newest 40; a routine's refreshes folded into one row, opened.
  allVersions: boolean;
  verOpen: Record<string, boolean>;
  // Adding someone who'd see your private threads on it asks first.
  ask: { page: string; user: string; text: string } | null;
  // A table's sort, by "<page>/<widget>": how you look at it, here, until you reload.
  tblSort: Record<string, { col: number; dir: string }>;
  // The threads bar: which of its threads it lists (all, yours, others'), by state per page, and its open thread's
  // steps unfolded.
  barFilter: string;
  barState: Record<string, string>;
  barSteps: boolean;
  // Pages: which ones it shows; New page's and New dashboard's composers open.
  pagesFilter: string;
  pageNew: boolean;
  dashNew: boolean;
  // A dashboard's panels' answers, for the view asked for (loadDash), by page; its range's menu open, and a panel's
  // menu and query open ("<page>/<panel>").
  dash: Record<string, DashAnswers>;
  dashPick: boolean;
  pnMenu: string | null;
  pnQuery: string | null;
  // A page's live routines' answers, while it's open (loadLive), by page.
  live: Record<string, PageLive>;
}
export const usePageUi = create<PageUi>(() => ({ detail: null, at: null, edit: null, allVersions: false, verOpen: {}, ask: null, tblSort: {}, barFilter: "all", barState: {}, barSteps: false, pagesFilter: "all", pageNew: false, dashNew: false, dash: {}, dashPick: false, pnMenu: null, pnQuery: null, live: {} }));
export const setPageUi = (s: Partial<PageUi> | ((s: PageUi) => Partial<PageUi>)) => usePageUi.setState(s);
export const getPageUi = usePageUi.getState;

// Another page, or none: what was the open page's goes.
export function leavePage() {
  setPageUi({ detail: null, at: null, edit: null, allVersions: false, ask: null, barSteps: false });
}

// The page in full: its versions and the threads on it, whose rows the page keeps for its bar and chips. One at a
// time: asking again while it's asking asks once more after.
let asking: Promise<void> | null = null;
let again = false;
let want: { id: string; tab: string; v: string | null } | null = null;
export function loadPage(id: string, tab: string, v: string | null) {
  want = { id, tab, v };
  if (asking) return void (again = true);
  asking = (async () => {
    const enc = encodeURIComponent;
    const [detail, at] = await Promise.all([
      getJSON<PageView>(`/api/pages/${enc(id)}`),
      tab === "at" && v ? fetch(`/api/pages/${enc(id)}/versions/${enc(v)}`).then((r) => (r.ok ? r.json() : r.status === 404 ? { missing: true, v: Number(v), page: id } : null)).catch(() => null) : null,
    ]);
    if (want?.id !== id) return;
    takeRows(detail?.threads);
    setPageUi({ ...(detail ? { detail } : {}), ...(at ? { at: { ...at, page: id, v: Number(v) } } : {}) });
  })().finally(() => {
    asking = null;
    if (again && want) {
      again = false;
      loadPage(want.id, want.tab, want.v);
    }
  });
}
// The open page in full again (a version, an answer to one of its items): if it's still the one open.
export function reloadPage() {
  const r = getApp().route;
  if (r.name === "page") loadPage(r.id, r.tab, r.v || null);
}
export const usePageDetail = (p: PageRec | undefined) => usePageUi((s) => (p && s.detail?.id === p.id ? s.detail : null));
export const useEdit = (p: PageRec | undefined) => usePageUi((s) => (p && s.edit?.pid === p.id ? s.edit : null));
export const editOf = (p: { id: string } | undefined) => {
  const e = getPageUi().edit;
  return p && e?.pid === p.id ? e : null;
};
// Change the copy being edited, as `fn` says.
export const changeEdit = (fn: (e: PageEdit) => Partial<PageEdit>) => setPageUi((s) => (s.edit ? { edit: { ...s.edit, ...fn(s.edit) } } : {}));
