// A list of threads as the server makes it (q/feed): the Feed, and an agent's, a workspace's
// or a group's threads, narrowed as their filter bar says (`ask`, q/feed's query). 20 cards at a time: the keys it
// shows in order and their records; what its threads are doing; where it goes on (`next`); the bar's counts; and what
// came in above that it doesn't show yet (`fresh`, "N new" at the top). The page's stream says what changes in it:
// cards change in place, what leaves goes, a start's thread takes its place, and nothing new goes in until you ask
// for it or are at its top, so the list doesn't move under you.
import { feedQuery } from "../../plugin/shared/api.ts";
import { useEffect } from "react";
import { dropWatch, query } from "./api.ts";
import { getApp, setApp, useApp } from "./store.ts";
import type { FeedList, FeedQ, LiveLine } from "./types.ts";

export const FEED_N = 20;
// What a list showed, kept for the way back to it, by its ask: shown while it's asked for again.
const back = new Map<string, FeedList>();
let asking: { ask: string; ctl: AbortController } | null = null;
let moreBusy = false;
const held: FeedDelta[] = [];
// What the stream says changed in the list.
export interface FeedDelta {
  v: number;
  swap?: Record<string, string>;
  gone?: string[];
  top?: string[];
  records?: FeedList["records"];
  live?: Record<string, LiveLine | null>;
  new?: string[];
  counts?: FeedList["counts"];
  menus?: FeedList["menus"];
}
// What the server's search found in messages the cards don't show, for the bit of each card that says why it's there.
export interface Found {
  q: string;
  exact: Set<string>;
  posts: Map<string, { exact: Set<string>; typo: Set<string>; hit: FeedQ["found"]["posts"][string]["hit"] }>;
}
let found: Found | null = null;
export const serverFound = (q: string) => (found && found.q === q ? found : null);

// The list from the top (`n` of it), or more of it after what it has.
export async function loadFeed(ask: string, { more = false, n = FEED_N } = {}) {
  const F = getApp().feed;
  if (more && (!F || F.ask !== ask || !F.next || moreBusy || asking)) return;
  const liveId = getApp().liveId;
  const ctl = new AbortController();
  if (more) moreBusy = true;
  else {
    asking?.ctl.abort();
    asking = { ask, ctl };
    held.length = 0;
  }
  try {
    const q = await query("/api/q/feed", { ...feedQuery(new URLSearchParams(ask)), n, ...(more ? { after: F.next } : {}), ...(liveId ? { live: liveId } : {}) }, { signal: ctl.signal });
    if (!q) return;
    const search = new URLSearchParams(ask).get("q") || "";
    if (more) {
      const now = getApp().feed;
      if (now !== F) return;
      setApp({ feed: { ...F, list: [...F.list, ...q.list.filter((k) => !F.list.includes(k))], records: { ...F.records, ...q.records }, live: { ...F.live, ...q.live }, next: q.next, fresh: F.fresh.filter((k) => !q.list.includes(k)) } });
    } else {
      if (asking?.ctl !== ctl) return;
      setApp({ feed: { ask, v: q.watching || 0, watching: !!q.watching, list: q.list, records: q.records, live: q.live, next: q.next, counts: q.counts, menus: q.menus, fresh: [], q: search, terms: q.found?.terms || null } });
      asking = null;
      for (const d of held.splice(0)) heardFeed(d);
    }
    if (q.found && search) {
      const had = serverFound(search);
      const posts = new Map(had?.posts || []);
      for (const [id, p] of Object.entries(q.found.posts)) posts.set(id, { exact: new Set(p.exact), typo: new Set(p.typo), hit: p.hit });
      found = { q: search, exact: new Set([...(had?.exact || []), ...q.found.terms.filter((t) => !t.typos).map((t) => t.w)]), posts };
    }
  } catch {
  } finally {
    if (more) moreBusy = false;
    else if (asking?.ctl === ctl) asking = null;
  }
}

// What changed in the list, applied to it. At the top of the page, what's new goes straight in.
export function heardFeed(d: FeedDelta) {
  if (asking) return void held.push(d);
  const F = getApp().feed;
  if (!F || d.v !== F.v) return;
  let list = F.list;
  if (d.swap || d.gone) list = list.map((k) => d.swap?.[k] || k).filter((k) => !d.gone?.includes(k));
  if (d.top) list = [...d.top.filter((k) => !list.includes(k)), ...list];
  const live = { ...F.live };
  for (const [id, l] of Object.entries(d.live || {})) if (l) live[id] = l;
  else delete live[id];
  const next: FeedList = { ...F, list, records: { ...F.records, ...(d.records || {}) }, live, fresh: d.new ? d.new.filter((k) => !list.includes(k)) : F.fresh, counts: d.counts || F.counts, menus: d.menus || F.menus };
  setApp({ feed: next });
  if (next.fresh.length && window.scrollY <= 0) showFresh();
}
// "N new": the list from the top again, with them, and as much as it showed.
export function showFresh(n = FEED_N) {
  const F = getApp().feed;
  if (!F?.fresh.length || !F.ask) return;
  loadFeed(F.ask, { n: Math.min(100, Math.max(n, F.list.length + F.fresh.length)) });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
export const feedMore = () => {
  const F = getApp().feed;
  if (F?.ask) loadFeed(F.ask, { more: true });
};
export const feedMoreBusy = () => moreBusy;
// What a thread on a card is doing this moment, as the stream says.
export const nowOf = (id: string): LiveLine | null => {
  const s = getApp();
  return s.feed?.records[`thread:${id}`] ? s.feed.live[id] || null : s.open?.id === id ? s.open.detail?.live || null : null;
};

// A list on screen: asked for when its ask changes (the search a moment after you stop typing, the rest now), what it
// showed before kept for the way back, and the stream told to stop bringing it once the screen goes. Scrolling near
// its end brings more; scrolling to its top brings what's new.
export function useFeedList(ask: string | null, n = FEED_N): FeedList | null {
  useEffect(() => {
    if (ask == null) return;
    const had = getApp().feed;
    setApp({ feed: back.get(ask) || (had?.ask === ask ? had : null) });
    const typing = !!had && new URLSearchParams(had.ask || "").get("q") !== new URLSearchParams(ask).get("q");
    const t = setTimeout(() => loadFeed(ask, { n }), typing ? 150 : 0);
    let scrolled = window.scrollY;
    const onScroll = () => {
      const F = getApp().feed;
      if (!F || F.ask !== ask) return;
      const y = window.scrollY;
      if (y <= 0 && scrolled > 0 && F.fresh.length && !asking) showFresh(n);
      else if (F.next && window.innerHeight + y > document.documentElement.scrollHeight - 1200) loadFeed(ask, { more: true });
      scrolled = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("scroll", onScroll);
      const F = getApp().feed;
      if (F?.ask !== ask) return;
      if (F.watching) dropWatch({ live: getApp().liveId, drop: "feed", v: F.v });
      back.set(ask, { ...F, ask, watching: false, fresh: [] });
    };
  }, [ask, n]);
  return useApp((s) => (s.feed && s.feed.ask === ask ? s.feed : back.get(ask) || null));
}
// Every list asks again with the stream's new id (a hello).
export function reloadFeed() {
  const F = getApp().feed;
  if (F?.ask) loadFeed(F.ask, { n: Math.max(FEED_N, F.list.length) });
}
