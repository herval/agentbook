// ⌘K's list: the places a name typed finds, best first. A place matches as search.ts finds words: every word typed
// is in its name or in what else it goes by, case and accents aside, and a word no place has as typed is taken as a
// typo. A name that's all of what's typed comes first; then what's still going (working, needs you or open), then
// what's landed, then what's put away; then what has every word in its name, before what has one only in what else
// it goes by (every thread in a workspace has its name there); then what kind of place it is (threads and routines,
// then pages, groups, WIP and the rest, then tasks, then worktrees); then what's working or needs you before what's
// open; then the start of a word counts more than its middle; then the newer first.

import { foldCase, haystack, hits, nearStart, searchWords, typoBudget } from "./search.ts";
import type { Haystack, Term } from "./search.ts";

const LETTER = /[\p{L}\p{N}]/u;
function startsWord(f: string, w: string): boolean {
  for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + 1)) if (i === 0 || !LETTER.test(f[i - 1])) return true;
  return false;
}
// How well a term is in a haystack: 3 starting a word, 2 inside one, 1 with a typo (one of the words `near` it);
// 0 not at all.
function fit(h: Haystack, t: Term, near: Set<string>): number {
  if (h.f.includes(t.w)) return startsWord(h.f, t.w) ? 3 : 2;
  return t.typos && h.words.some((x) => near.has(x)) ? 1 : 0;
}
// How a place is going, first to last: working or needs you, open (idle, a page, a person), landed (merged, closed),
// put away (archived, hidden, off, paused).
export const RANK: Record<"going" | "open" | "landed" | "away", number> = { going: 0, open: 1, landed: 2, away: 3 };
// What kind of place goes first, by its chip. A kind left out (a note, a person, an agent, a workspace, a machine, one
// of agentbook's screens) goes with pages.
export const KIND: Record<string, number> = { Thread: 0, Routine: 0, Page: 1, Group: 1, WIP: 1, Task: 2, Worktree: 3 };
const kindOf = (p: Place): number => KIND[p.kind] ?? KIND.Page;

// Texts folded, from one keystroke to the next.
const hays = new Map<string, Haystack>();
function hayOf(text: string): Haystack {
  let h = hays.get(text);
  if (!h) {
    if (hays.size > 20000) hays.clear();
    hays.set(text, (h = haystack(text)));
  }
  return h;
}

// places: [{ name, more, kind, rank, at }]: `name` what it's called, `more` what else it goes by (a thread's label,
// its agent, its workspace), `kind` what it is (KIND: Thread, Page, Task…), `rank` how it's going (RANK: working or
// needs you, open, landed, put away; open when it's left out), `at` when it last changed. Returns the ones that
// match, best first, and the terms they matched on ({ w, typos }), for hits() to mark.
export interface Place {
  name: string;
  more?: string;
  kind?: string;
  rank?: number;
  at?: string;
}
// A place that matched: how well (`score`), whether every word is in its name, and whether its name is all that's typed.
export type Ranked<P extends Place> = P & { score: number; named: boolean; exact: boolean };
export function rankPlaces<P extends Place>(places: P[], q: string): { list: Ranked<P>[]; terms: Term[] } {
  const words = searchWords(q);
  if (!words.length) return { list: [], terms: [] };
  const all = places.map((p) => ({ p, name: hayOf(p.name), more: hayOf(p.more || "") }));
  const terms: Term[] = words.map((w) => ({ w, typos: all.some((h) => h.name.f.includes(w) || h.more.f.includes(w)) ? 0 : typoBudget(w) }));
  // The words a typo could be, each looked at once for every place.
  const near = new Map(terms.filter((t) => t.typos).map((t) => [t.w, new Set<string>()]));
  if (near.size) {
    const seen = new Set<string>();
    for (const h of all) {
      for (const x of [...h.name.words, ...h.more.words]) {
        if (seen.has(x)) continue;
        seen.add(x);
        for (const t of terms) if (t.typos && nearStart(t.w, x, t.typos)) near.get(t.w).add(x);
      }
    }
  }
  const whole = foldCase(q.trim()).replace(/\s+/g, " ");
  const out: Ranked<P>[] = [];
  for (const { p, name, more } of all) {
    let score = 0;
    let named = true;
    for (const t of terms) {
      const n = fit(name, t, near.get(t.w));
      const m = n ? 0 : fit(more, t, near.get(t.w));
      if (!n && !m) {
        score = -1;
        break;
      }
      if (!n) named = false;
      score += n ? n * 2 : m;
    }
    if (score < 0) continue;
    out.push({ ...p, score, named, exact: name.f === whole });
  }
  const rank = (p: Place): number => p.rank ?? RANK.open;
  // Going and open are one, here: a thread that's open comes before a worktree that's working.
  const done = (p: Place): number => Math.max(rank(p), RANK.open);
  out.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      done(a) - done(b) ||
      Number(b.named) - Number(a.named) ||
      kindOf(a) - kindOf(b) ||
      rank(a) - rank(b) ||
      b.score - a.score ||
      (b.at || "").localeCompare(a.at || "") ||
      a.name.length - b.name.length,
  );
  return { list: out, terms };
}

// A text with what was typed marked, as HTML: esc for the rest of it.
export function marked(text: unknown, terms: Term[], esc: (s: string) => string): string {
  const s = String(text ?? "");
  if (!terms.length) return esc(s);
  let out = "";
  let last = 0;
  for (const [a, b] of hits(s, terms)) {
    out += `${esc(s.slice(last, a))}<mark>${esc(s.slice(a, b))}</mark>`;
    last = b;
  }
  return out + esc(s.slice(last));
}
