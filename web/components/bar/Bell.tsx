// The bell in the top bar: what waits on you and what's new, counted on its badge, in its menu (NeedsYou).
import { useEffect, useRef } from "react";
import { post } from "../../lib/api.ts";
import { setChrome, useChrome } from "../../lib/chrome.ts";
import { useRoute } from "../../lib/route.ts";
import { getApp } from "../../lib/store.ts";
import { Icon } from "../Icon.tsx";
import { freshKey, useBell, useBellLists } from "./bell.ts";
import type { BellLine } from "./bell.ts";
import { NeedsYou } from "./NeedsYou.tsx";

// The bell opens what waits on you under it. It stays open as you Allow or Deny, and closes on a click outside it,
// a link in it (Answer, a thread), Escape, or going to another page.
export function Bell() {
  const open = useChrome((c) => c.bellOpen);
  const route = useRoute();
  const { told } = useBellLists();
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Another page: it closes.
  useEffect(() => {
    setChrome({ bellOpen: false });
  }, [route]);
  useEffect(() => {
    if (!open) return;
    // By the click's path, not where its target is now: Dismiss draws the menu again, and its button is out of the page
    // by the time this runs.
    const click = (e: MouseEvent) => {
      const path = e.composedPath();
      if (path.includes(btn.current)) return;
      if (path.includes(menu.current) && !(e.target as Element)?.closest?.("a[href]")) return;
      setChrome({ bellOpen: false });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setChrome({ bellOpen: false });
      btn.current?.focus();
    };
    document.addEventListener("click", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const toggle = () => {
    const opening = !open;
    // Its notifications that are new are seen: off its count from now, with a dot while it's open.
    const fresh = opening ? new Set(((getApp().data?.added || []) as BellLine[]).filter((x) => !x.seen).map(freshKey)) : null;
    useBell.setState({ fresh });
    setChrome({ bellOpen: opening });
    if (fresh?.size) post("/api/bell/seen", {});
  };
  return (
    <span className="bell-wrap">
      <button className="round" type="button" data-bell aria-label="Needs you" title="Needs you" aria-haspopup="true" aria-expanded={open} ref={btn} onClick={toggle}>
        <Icon name="bell" />
        {told ? <span className="badge">{told}</span> : null}
      </button>
      <div className="fb-menu bell-menu" data-bell-menu role="dialog" aria-label="Needs you" hidden={!open} ref={menu}>
        {open ? <NeedsYou /> : null}
      </div>
    </span>
  );
}
