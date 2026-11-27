// The top bar: ☰ for the menu, the wordmark, unified search trigger (opens ⌘K, and shows an active feed
// filter chip when set), the connection when it's down, the bell (Needs you), ▥ for the side column, and you.
import { useEffect } from "react";
import { plural } from "../lib/format.ts";
import { closeDrawer, MENU, NARROW, openDrawer, setChrome, useChrome, useMedia } from "../lib/chrome.ts";
import { personHref } from "../lib/route.ts";
import { useApp } from "../lib/store.ts";
import { PersonAvatar } from "./Avatar.tsx";
import { Bell } from "./bar/Bell.tsx";
import { useBellLists, waitingRoutines } from "./bar/bell.ts";
import { GOTO_KEY, openGoto } from "./Goto.tsx";
import { Icon } from "./Icon.tsx";

let drawerFrom: Element | null = null;
function toggleDrawer(side: "left" | "right") {
  if (useChrome.getState().drawer === side) return closeDrawer();
  drawerFrom = document.activeElement;
  openDrawer(side);
  requestAnimationFrame(() => document.querySelector<HTMLElement>(side === "left" ? "[data-menu] .drawer-x" : ".drawer-bar .drawer-x")?.focus({ preventScroll: true }));
}

export function TopBar() {
  const drawer = useChrome((c) => c.drawer);
  const q = useChrome((c) => c.q);
  const panel = useChrome((c) => c.panel);
  const conn = useApp((s) => s.conn);
  const me = useApp((s) => s.me);
  const data = useApp((s) => s.data);
  const { needs } = useBellLists();
  const menu = useMedia(MENU);
  const narrow = useMedia(NARROW);

  useEffect(() => {
    closeDrawer();
  }, [menu, narrow]);
  useEffect(() => {
    if (drawer) return;
    const inside = document.activeElement?.closest("[data-menu], .drawer-bar, aside.rail");
    if (inside && drawerFrom?.isConnected) (drawerFrom as HTMLElement).focus({ preventScroll: true });
    drawerFrom = null;
  }, [drawer]);
  useEffect(() => {
    document.title = needs ? `(${needs}) agentbook` : "agentbook";
  }, [needs]);

  const waits = waitingRoutines(data).length;
  const head = panel?.title || "Side column";
  return (
    <header className="top">
      <div className="top-left">
        <button className="menu-btn" type="button" data-drawer="left" aria-expanded={drawer === "left"} aria-label="Menu" title="Menu" onClick={() => toggleDrawer("left")}>
          <Icon name="menu" />
        </button>
        <a className="wordmark" href="#/">
          agentbook
        </a>
        <div className={`search search--btn${q ? " has-q" : ""}`}>
          <button className="search-trigger" type="button" data-search aria-label="Search" title="Search threads, messages, notes and pages" onClick={() => openGoto(q)}>
            <Icon name="search" />
            <span className="search-label">{q || "Search"}</span>
            {!q && <kbd>{GOTO_KEY}</kbd>}
          </button>
          {q ? (
            <button className="search-clear" type="button" aria-label="Clear feed filter" title="Clear feed filter" onClick={() => setChrome({ q: "" })}>
              <Icon name="x" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="top-right">
        <span className="conn off" data-conn hidden={!conn}>
          {conn || "connecting"}
        </span>
        <button className={`round search-btn${q ? " is-on" : ""}`} type="button" aria-label="Search" title="Search" onClick={() => openGoto(q)}>
          <Icon name="search" />
        </button>
        <Bell />
        <button className="round panel-btn" type="button" data-drawer="right" aria-expanded={drawer === "right"} aria-label={head} title={head} onClick={() => toggleDrawer("right")}>
          <Icon name="panel" />
          {panel?.n != null ? <span className={`badge${panel.needs ? "" : " badge--quiet"}`}>{panel.n}</span> : null}
        </button>
        <span data-me>
          {me ? (
            <>
              <a className="me" href={personHref(me.username)} title={`${me.display_name} (@${me.username})`}>
                <PersonAvatar who={me} />
              </a>
              {waits ? (
                <a className="badge me-badge" href={personHref(me.username, "routines")} title={`${plural(waits, "routine")} waiting for your OK`}>
                  {waits}
                </a>
              ) : null}
            </>
          ) : null}
        </span>
      </div>
    </header>
  );
}
