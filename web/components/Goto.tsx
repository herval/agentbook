/* ---------- ⌘K: unified search across places and full-text content ---------- */
// Matches littleguys' SearchPalette: instant in-memory place matching (threads, pages, notes, groups,
// people, agents, workspaces, worktrees, tasks, routines, machines, screens) plus 180 ms debounced
// SQLite FTS5 content search (/api/q/search) with highlighted snippets and stale-while-revalidate.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { query } from "../lib/api.ts";
import { closeDrawer, setChrome, useChrome } from "../lib/chrome.ts";
import { ago, hueVars } from "../lib/format.ts";
import { go, scopeHref } from "../lib/route.ts";
import { hits, searchWords } from "../lib/search.ts";
import type { Term } from "../lib/search.ts";
import { getApp, useApp } from "../lib/store.ts";
import type { SearchHit } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { GoIco, goPlaces, goRows, rememberPlace } from "./bar/goto-rows.tsx";
import type { GoPlace } from "./bar/goto-rows.tsx";
import { openAddAgent } from "./agents/AddAgentDialog.tsx";
import { openAddWs } from "./workspaces/addws.ts";
import { Icon } from "./Icon.tsx";

export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const nowKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (MAC ? e.metaKey : e.ctrlKey);
export const GOTO_KEY = MAC ? "⌘K" : "Ctrl K";
export const openGoto = (initial = "") => setChrome({ gotoOpen: true, gotoInitial: initial });
export const closeGoto = () => setChrome({ gotoOpen: false, gotoInitial: "" });

const SEARCH_DELAY_MS = 180;
const PLACE_CAP_WITH_CONTENT = 10;

export function Goto() {
  const open = useChrome((c) => c.gotoOpen);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const { me, data } = getApp();
      if (e.key?.toLowerCase() !== "k" || !nowKey(e) || e.altKey || e.shiftKey || e.isComposing || !me || !data) return;
      e.preventDefault();
      if (useChrome.getState().gotoOpen) return closeGoto();
      if (!document.querySelector("dialog[open]")) openGoto();
    };
    document.addEventListener("keydown", key);
    addEventListener("hashchange", rememberPlace);
    return () => {
      document.removeEventListener("keydown", key);
      removeEventListener("hashchange", rememberPlace);
    };
  }, []);
  return open ? <GotoBox /> : null;
}

function openAddAction(place: GoPlace) {
  if (place.key !== "screen:connect" && place.key !== "screen:addws") return false;
  closeGoto();
  if (place.key === "screen:addws") openAddWs();
  else openAddAgent();
  return true;
}

interface ContentState {
  query: string;
  indexing: boolean;
  hits: SearchHit[];
}

function useContentSearch(q: string): { res: ContentState | null; searching: boolean } {
  const [res, setRes] = useState<ContentState | null>(null);
  useEffect(() => {
    if (q.length < 2) {
      setRes(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      query("/api/q/search", { q, limit: 24 })
        .then((got) => {
          if (stale) return;
          setRes(got ? { query: q, indexing: !!got.indexing, hits: got.hits || [] } : { query: q, indexing: false, hits: [] });
        })
        .catch(() => {
          if (!stale) setRes({ query: q, indexing: false, hits: [] });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);
  return { res, searching: q.length >= 2 && res?.query !== q };
}

type PaletteItem =
  | { group: "recent" | "screens" | "places"; id: string; kind: "place"; place: GoPlace; snippet?: string }
  | { group: "messages" | "content"; id: string; kind: "hit"; hit: SearchHit }
  | { group: "filter"; id: string; kind: "filter" };

const SECTION_LABEL: Record<PaletteItem["group"], string> = {
  recent: "Recent",
  screens: "Screens",
  places: "Places",
  messages: "Messages",
  content: "Notes, pages & tasks",
  filter: "",
};

function kindLabel(k: SearchHit["kind"]): string {
  return k === "thread" ? "Thread" : k === "note" ? "Note" : k === "page" ? "Page" : k === "task" ? "Task" : k === "group" ? "Group" : "Message";
}

function GotoBox() {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const initial = useChrome((c) => c.gotoInitial);
  const [text, setText] = useState(initial);
  const [at, setAt] = useState(0);
  const shown = useRef(false);
  const was = useRef(-1);
  const q = text.trim();
  const { res, searching } = useContentSearch(q);
  const data = useApp((s) => s.data);
  const rows = useApp((s) => s.rows);
  const more = useApp((s) => s.more);
  const people = useApp((s) => s.people);
  const me = useApp((s) => s.me);
  const route = useApp((s) => s.route);
  const all = useMemo(() => goPlaces([], getApp()), [data, rows, more, people, me]);
  const { list: placeList, terms } = useMemo(() => goRows(all, q, route), [all, q, route]);
  const queryTerms = useMemo<Term[]>(() => (terms.length ? terms : searchWords(q).map((w) => ({ w, typos: 0 }))), [terms, q]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!q) {
      return placeList.map((p): PaletteItem => ({
        group: p.key.startsWith("screen:") ? "screens" : "recent",
        id: p.key,
        kind: "place",
        place: p,
      }));
    }
    const contentHits = q.length >= 2 ? (res?.hits ?? []) : [];
    const hitByKey = new Map<string, SearchHit>();
    for (const h of contentHits) {
      if (h.kind !== "message") hitByKey.set(`${h.kind}:${h.id}`, h);
    }
    const hasContent = contentHits.length > 0;
    const shownPlaces = hasContent ? placeList.slice(0, PLACE_CAP_WITH_CONTENT) : placeList;
    const shownKeys = new Set(shownPlaces.map((p) => p.key));
    const out: PaletteItem[] = shownPlaces.map((p) => ({
      group: "places",
      id: p.key,
      kind: "place",
      place: p,
      snippet: hitByKey.get(p.key)?.snippet,
    }));

    const messageHits = contentHits.filter((h) => h.kind === "message");
    const otherHits = contentHits.filter((h) => h.kind !== "message" && !shownKeys.has(`${h.kind}:${h.id}`));

    for (const h of messageHits) {
      out.push({ group: "messages", id: `msg:${h.id}:${h.itemId || h.at}`, kind: "hit", hit: h });
    }
    for (const h of otherHits) {
      out.push({ group: "content", id: `hit:${h.kind}:${h.id}:${h.itemId || ""}`, kind: "hit", hit: h });
    }
    out.push({ group: "filter", id: "filter-feed", kind: "filter" });
    return out;
  }, [placeList, res, q]);

  const n = items.length;
  const cur = Math.max(0, Math.min(at, n - 1));

  useLayoutEffect(() => {
    const d = ref.current;
    closeDrawer();
    rememberPlace();
    if (!d.open) d.showModal();
    input.current?.focus();
    if (initial) input.current?.select();
    return () => {
      if (d.open) d.close();
    };
  }, []);
  useLayoutEffect(() => {
    if (cur !== was.current || !shown.current) document.getElementById(`goto-${cur}`)?.scrollIntoView({ block: "nearest" });
    was.current = cur;
    shown.current = true;
  });

  const filterFeed = () => {
    closeGoto();
    setChrome({ q });
    if (getApp().route.name !== "feed") go(scopeHref("feed"));
  };

  const openItem = (item: PaletteItem, inNewTab = false) => {
    if (item.kind === "filter") return filterFeed();
    if (item.kind === "place") {
      if (inNewTab) return void window.open(item.place.href, "_blank");
      if (openAddAction(item.place)) return;
      closeGoto();
      location.hash = item.place.href;
      return;
    }
    if (inNewTab) return void window.open(item.hit.href, "_blank");
    closeGoto();
    location.hash = item.hit.href;
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (e.nativeEvent.isComposing) return;
    const step = e.key === "ArrowDown" || (MAC && e.ctrlKey && e.key === "n") ? 1 : e.key === "ArrowUp" || (MAC && e.ctrlKey && e.key === "p") ? -1 : 0;
    if (step && n) {
      e.preventDefault();
      return setAt((cur + step + n) % n);
    }
    if (e.key !== "Enter" || !n) return;
    e.preventDefault();
    const item = items[cur];
    if (item) openItem(item, nowKey(e));
  };

  const hint = (k: string, what: string) => (
    <span>
      <kbd>{k}</kbd> {what}
    </span>
  );
  const onlyFilter = q && items.length === 1 && items[0].kind === "filter";

  return (
    <dialog
      ref={ref}
      className="viewer goto"
      aria-label="Search"
      onCancel={(e) => {
        e.preventDefault();
        closeGoto();
      }}
      onClose={() => !ref.current?.open && closeGoto()}
      onClick={(e) => e.target === ref.current && closeGoto()}
      onKeyDown={onKey}
    >
      <label className="goto-q">
        <Icon name="search" />
        <input
          ref={input}
          value={text}
          placeholder="Search threads, messages, notes, pages…"
          role="combobox"
          aria-expanded="true"
          aria-controls="goto-list"
          aria-autocomplete="list"
          aria-activedescendant={n ? `goto-${cur}` : ""}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
            shown.current = false;
          }}
        />
        {searching && <span className="goto-spin" aria-label="Searching" />}
        <kbd>esc</kbd>
      </label>
      <ul className="goto-list" id="goto-list" role="listbox">
        {items.map((item, i) => {
          const prev = i > 0 ? items[i - 1].group : null;
          const label = item.group !== prev ? SECTION_LABEL[item.group] : "";
          return (
            <Fragment key={item.id}>
              {label ? (
                <li className="goto-sec" role="presentation">
                  {label}
                </li>
              ) : null}
              {item.kind === "place" ? (
                <GotoPlaceRow p={item.place} snippet={item.snippet} i={i} on={i === cur} terms={queryTerms} pick={setAt} />
              ) : item.kind === "hit" ? (
                <GotoHitRow hit={item.hit} i={i} on={i === cur} stale={searching} terms={queryTerms} pick={setAt} />
              ) : (
                <>
                  {onlyFilter ? (
                    <li className="goto-none" role="presentation">
                      {searching ? "Searching…" : `Nothing matches “${q}”.`}
                    </li>
                  ) : null}
                  <li role="option" id={`goto-${i}`} aria-selected={i === cur}>
                    <button className={`goto-row goto-find${i === cur ? " is-on" : ""}`} type="button" tabIndex={-1} onClick={filterFeed} onMouseMove={() => i !== cur && setAt(i)}>
                      <GoIco name="search" />
                      <span className="goto-t">
                        <b>Filter feed for “{q}”</b>
                        <small>Narrow the feed cards to matching threads</small>
                      </span>
                    </button>
                  </li>
                </>
              )}
            </Fragment>
          );
        })}
      </ul>
      <footer className="goto-foot">
        {hint("↑↓", "to pick")}
        {hint("↵", "to open")}
        {hint(MAC ? "⌘↵" : "Ctrl ↵", "in a new tab")}
        {res?.query === q && res.indexing ? <span className="goto-idx">Still indexing older content…</span> : null}
      </footer>
    </dialog>
  );
}

function GotoPlaceRow({ p, snippet, i, on, terms, pick }: { p: GoPlace; snippet?: string; i: number; on: boolean; terms: Term[]; pick: (i: number) => void }) {
  return (
    <li role="option" id={`goto-${i}`} aria-selected={on}>
      <a
        className={`goto-row${on ? " is-on" : ""}`}
        href={p.href}
        style={p.style}
        tabIndex={-1}
        onClick={(e) => {
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && openAddAction(p)) e.preventDefault();
          else setTimeout(closeGoto);
        }}
        onMouseMove={() => !on && pick(i)}
      >
        {p.face}
        <span className="goto-t">
          <b>
            <Marked text={p.name} terms={terms} />
          </b>
          {p.sub ? (
            <small>
              <Marked text={p.sub} terms={terms} />
            </small>
          ) : null}
          {snippet ? (
            <p className="goto-snip">
              <Marked text={snippet} terms={terms} />
            </p>
          ) : null}
        </span>
        {p.note ? <span className="goto-note">{p.note}</span> : null}
        {p.kind ? <span className="chip goto-kind">{p.kind}</span> : null}
      </a>
    </li>
  );
}

function HitFace({ hit }: { hit: SearchHit }) {
  if (hit.agent) return <Avatar agent={hit.agent} size="av--sm" />;
  if (hit.emoji) return <span className="goto-ico">{hit.emoji}</span>;
  if (hit.kind === "task") return <GoIco name="tasks" />;
  return <GoIco name="steps" />;
}

function GotoHitRow({ hit, i, on, stale, terms, pick }: { hit: SearchHit; i: number; on: boolean; stale: boolean; terms: Term[]; pick: (i: number) => void }) {
  const showKind = hit.kind !== "message";
  return (
    <li role="option" id={`goto-${i}`} aria-selected={on}>
      <a
        className={`goto-row goto-hit${on ? " is-on" : ""}${stale ? " is-stale" : ""}`}
        href={hit.href}
        style={hit.agent ? hueVars(hit.agent) : undefined}
        tabIndex={-1}
        onClick={() => setTimeout(closeGoto)}
        onMouseMove={() => !on && pick(i)}
      >
        <HitFace hit={hit} />
        <span className="goto-t">
          <span className="goto-head">
            <b>
              <Marked text={hit.title} terms={terms} />
            </b>
            {hit.subtitle ? <span className="goto-sub">· {hit.subtitle}</span> : null}
            {hit.archived ? <span className="chip goto-arch">{hit.kind === "task" ? "done" : "archived"}</span> : null}
            {hit.at ? <time className="goto-when">{ago(hit.at)}</time> : null}
          </span>
          <p className="goto-snip">
            {hit.role === "user" ? <span className="goto-who">You: </span> : null}
            <Marked text={hit.snippet} terms={terms} />
          </p>
        </span>
        {showKind ? <span className="chip goto-kind">{kindLabel(hit.kind)}</span> : null}
      </a>
    </li>
  );
}

function Marked({ text, terms }: { text: unknown; terms: Term[] }) {
  const s = String(text ?? "");
  if (!terms.length) return <>{s}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const [a, b] of hits(s, terms)) {
    out.push(s.slice(last, a), <mark key={a}>{s.slice(a, b)}</mark>);
    last = b;
  }
  out.push(s.slice(last));
  return <>{out}</>;
}
