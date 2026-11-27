// #/pages/:id (app.ts renderPage): a page, or a dashboard, with its head and tabs. On its Page tab its threads bar is
// beside it (folded to an anchor at the bottom, or on a phone a sheet over it); its other tabs are its versions, its
// routines and who changes it.
import { useEffect, useRef } from "react";
import { BAR_SHEET, useMedia } from "../../lib/chrome.ts";
import { usePref } from "../../lib/hooks.ts";
import { useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { BarDock, barLinks, flashWidgets, PageBar, useBarShown } from "../../components/pages/bar.tsx";
import { PageHead } from "../../components/pages/head.tsx";
import { pageById } from "../../components/pages/pages.ts";
import { leavePage, loadPage } from "../../components/pages/state.ts";
import { ContributorsTab, PageTab, RoutinesTab, VersionsTab } from "../../components/pages/tabs.tsx";
import { pageStyle } from "../../lib/format.ts";

// The page opened at one of its widgets (?w=): to it, once per address, as soon as it's drawn.
let wShown = "";

export function PageView() {
  const r = useRoute();
  const data = useApp((s) => s.data);
  const p = pageById(r.id, data);
  const shown = useBarShown(p);
  const sheet = useMedia(BAR_SHEET);
  const [folded] = usePref("barFolded", "0");
  // The open page changed (a new version, a contributor, a routine, a thread started from it): look again.
  const changed = JSON.stringify([
    p ? [p.version, p.contributors?.length, (p.routines || []).map((y) => [y.id, y.on, y.live_v, y.code_v, y.waiting?.v, y.last?.at, y.fails])] : null,
    (data?.launches || []).filter((l) => l.page === r.id).map((l) => (l as { post?: string | null }).post),
  ]);
  useEffect(() => loadPage(r.id, r.tab, r.v || null), [r.id, r.tab, r.v, changed]);
  useEffect(() => () => leavePage(), [r.id]);
  // Over the page, its bar is a sheet: the page stays as it was under it, and closing it, the page is where you
  // left it. The scrim or Escape (outside a form) closes it.
  const on = !!p && sheet && !!r.bar && shown;
  const y = useRef(0);
  useEffect(() => {
    if (!on) return;
    y.current = scrollY;
    document.body.classList.add("bar-sheet");
    const base = barLinks(p, r, true).base;
    const click = (e: MouseEvent) => (e.target as Element).closest?.(".scrim") && (location.hash = base);
    const key = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as Element).closest?.("form") && (location.hash = base);
    document.addEventListener("click", click);
    document.addEventListener("keydown", key);
    return () => {
      document.body.classList.remove("bar-sheet");
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", key);
      scrollTo(0, y.current);
    };
  }, [on]);
  useEffect(() => {
    if (!r.w || wShown === location.hash || !document.querySelector(`.pg-main [data-wid="${CSS.escape(r.w)}"]`)) return;
    wShown = location.hash;
    requestAnimationFrame(() => flashWidgets([r.w]));
  });
  if (!p)
    return (
      <div className="shell-msg">
        <p>{data?.pages ? "No page here, or it isn't yours to see." : "Loading…"}</p>
        <a className="btn" href="#/pages">
          Every page
        </a>
      </div>
    );
  const style = pageStyle(p);
  const fold = folded === "1";
  let body;
  if (shown && sheet)
    body = (
      <div className="pg-body pg-split">
        <div className="pg-main">
          <PageTab p={p} bar />
        </div>
        <div>
          <BarDock p={p} />
        </div>
        <PageBar p={p} />
      </div>
    );
  else if (shown && fold)
    body = (
      <div className="pg-body">
        <div className="pg-main">
          <PageTab p={p} bar />
        </div>
        <div>
          <BarDock p={p} />
        </div>
      </div>
    );
  else if (shown)
    body = (
      <div className="pg-body pg-split">
        <div className="pg-main">
          <PageTab p={p} bar />
        </div>
        <PageBar p={p} />
      </div>
    );
  else body = r.tab === "versions" ? <VersionsTab p={p} /> : r.tab === "routines" ? <RoutinesTab p={p} /> : r.tab === "contributors" ? <ContributorsTab p={p} /> : <PageTab p={p} />;
  return (
    <>
      <section className="profile-top" style={style}>
        <div className={`profile-in${shown && !fold ? " is-wide" : ""}`}>
          <PageHead p={p} tab={r.tab === "at" ? "page" : r.tab} />
        </div>
      </section>
      <div style={style}>{body}</div>
    </>
  );
}
