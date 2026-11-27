// WIPs of many on the page: what's in each one, from what you put in it (its `items` and
// `posts`, kept on agentbook-server, plugin/shared/wip-sets.mjs) and the page's own WIPs (each branch's and pull
// request's, from git and GitHub). app.ts hands it those; it hands back each WIP of many with what's in it and its
// threads, and which WIP of many each of the page's WIPs went in.
//
// What's in one: what you put in it, then every branch and pull request a thread in it works on that nobody put
// anywhere else. A branch you put in it that has a pull request now is that pull request. Something is in one at
// most: put in one, it's in that one even when a thread in another works on it too. An archived one has nothing in
// it: what was is a WIP of its own again.

import type { ShipOrderItem } from "../../plugin/shared/types.ts";

// Where each thing in it stands, from app.ts's word for it (WIP_WORDS): landed, merged and closed are done, and so
// is one gone (a pull request merged or closed long ago that GitHub no longer lists, a branch cleaned up); closed and
// gone ones don't count in "1 of 5".
export const DONE = new Set(["landed", "merged", "closed", "gone"]);

// sets: the server's records, { id, title, items: [{ id, kind, title, ref, repo, url }], posts: [thread ids],
// created, archived }. wips: every WIP the page has, each { id, kind, posts: [threads], local?: [branches] }, a
// pull request's before its branch's. byId(id): the page's WIP for an item's id (a branch's finds its pull
// request). thread(id): a thread the page has, by id. guests(thread): the threads working for one of your own (a
// talk's guests), whose work is that thread's: what they work on goes in its WIP too.
// -> { list: [{ ...set, parts: [{ id, item, w, via }], threads }], of: Map(WIP id -> set id) }. `via`: null for one
// you put in, else the thread it came with. `w` is null for one the page can't see now (its machine is off, GitHub
// hasn't said yet).
export interface SetIn {
  id: string;
  title?: string;
  items?: ShipOrderItem[];
  posts?: string[];
  created?: string;
  archived?: string | null;
  order?: ShipOrderItem[] | null;
}
// One of the page's WIPs, as setsOf reads it: T is what the page has of a thread.
export interface SetWip<T> {
  id: string;
  kind: string;
  posts: T[];
}
export interface Part<T, W> {
  id: string;
  item: ShipOrderItem | null;
  w: W | null;
  via: T | null;
}
export type SetOf<S, T, W> = S & { parts: Part<T, W>[]; threads: T[] };
export function setsOf<S extends SetIn, T, W extends SetWip<T>>(sets: S[], { wips, byId, thread, guests = () => [] }: { wips: W[]; byId: (id: string) => W | null; thread: (id: string) => T | null; guests?: (t: T) => T[] }): { list: SetOf<S, T, W>[]; of: Map<string, string> } {
  const of = new Map<string, string>();
  const live = (sets || []).filter((s) => !s.archived).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const parts = new Map(live.map((s): [string, Part<T, W>[]] => [s.id, []]));
  // What you put in it, first: it's that one's, whatever thread works on it.
  for (const s of live) {
    for (const item of s.items || []) {
      const w = byId(item.id);
      const id = w?.id || item.id;
      if (of.has(id)) continue;
      of.set(id, s.id);
      parts.get(s.id).push({ id, item, w: w || null, via: null });
    }
  }
  // Then what its threads work on that's in no other.
  const threadsOf = new Map(live.map((s) => [s.id, (s.posts || []).map(thread).filter(Boolean)]));
  for (const s of live) {
    for (const t of threadsOf.get(s.id)) {
      const on = [t, ...guests(t)];
      for (const w of wips) {
        if (of.has(w.id) || !on.some((x) => w.posts.includes(x))) continue;
        of.set(w.id, s.id);
        parts.get(s.id).push({ id: w.id, item: null, w, via: t });
      }
    }
  }
  const list = live.map((s) => {
    const mine = parts.get(s.id);
    // Its threads: the ones put in it, then the ones on what's in it, newest first after those.
    const put = threadsOf.get(s.id);
    const on = mine.flatMap((p) => p.w?.posts || []).filter((t, i, all) => !put.includes(t) && all.indexOf(t) === i);
    return { ...s, parts: mine, threads: [...put, ...on] };
  });
  return { list, of };
}

// Where one stands as a whole, from where each thing in it does (`statusOf(part)` -> { k, why }) and its threads'
// `effective`: a thread in it waiting for you first, then the most urgent of what's in it (`rank`, app.ts's
// WIP_RANK), and landed once all of it is and none of its threads is still going. -> { k, why, part, counts }.
// `counts`: { landed, closed, total } (total leaves the closed and gone ones out), and how many of each word (`by`).
export interface Standing<P, T> {
  k: string;
  why: string | null;
  thread?: T;
  part: P | null;
  counts: { landed: number; closed: number; total: number; by: Record<string, number> };
}
export function setStatus<P, T extends { effective?: string }>(set: { parts: P[]; threads: T[] }, { statusOf, rank }: { statusOf: (p: P) => { k: string; why: string | null }; rank: Record<string, number> }): Standing<P, T> {
  const st = set.parts.map((p) => ({ p, s: statusOf(p) }));
  const by: Record<string, number> = {};
  for (const x of st) by[x.s.k] = (by[x.s.k] || 0) + 1;
  const closed = (by.closed || 0) + (by.gone || 0);
  const counts = { landed: (by.landed || 0) + (by.merged || 0), closed, total: set.parts.length - closed, by };
  const needs = set.threads.find((t) => t.effective === "needs");
  if (needs) return { k: "needs", why: null, thread: needs, part: null, counts };
  const open = st.filter((x) => !DONE.has(x.s.k)).sort((a, b) => (rank[a.s.k] ?? 9) - (rank[b.s.k] ?? 9));
  if (!set.parts.length) return { k: "empty", why: "nothing in it yet", part: null, counts };
  if (open.length) return { k: open[0].s.k, why: open[0].s.why, part: open[0].p, counts };
  const going = set.threads.find((t) => t.effective === "working");
  if (going) return { k: "working", why: null, thread: going, part: null, counts };
  return { k: counts.landed ? "landed" : "closed", why: null, part: null, counts };
}

// What's in it in a few words: "4 pull requests and a branch", "2 branches", "nothing in it yet".
export function partsText(set: { parts: Part<unknown, { kind: string }>[] }): string {
  const prs = set.parts.filter((p) => (p.w?.kind || p.item?.kind) === "pr").length;
  const branches = set.parts.length - prs;
  const n = (k: number, one: string, many: string): string => (k === 1 ? `a ${one}` : `${k} ${many}`);
  const words = [prs ? n(prs, "pull request", "pull requests") : "", branches ? n(branches, "branch", "branches") : ""].filter(Boolean);
  return words.join(" and ") || "nothing in it yet";
}

// Its landing order on the page (phase 3): the parts its `order` names, in that order. An entry names one by the id
// the page gave it, its pull request's link or its branch (the server's names for the ones its threads brought, so
// both find the same). urlOf(part), branchOf(part): its pull request's link, its branch, or null.
export function orderOf<P extends { id: string; item?: { id: string } | null }>(set: { order?: ShipOrderItem[] | null }, parts: P[], { urlOf, branchOf }: { urlOf: (p: P) => string | null; branchOf: (p: P) => string | null }): P[] {
  const out: P[] = [];
  for (const o of set.order || []) {
    const url = o.url ? o.url.toLowerCase() : null;
    const p = parts.find((x) => x.id === o.id || x.item?.id === o.id || (url && urlOf(x)?.toLowerCase() === url) || (o.kind === "branch" && branchOf(x) === o.ref));
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
