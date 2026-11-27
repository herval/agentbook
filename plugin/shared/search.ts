// Search, the same on the page and on the server: what counts as a match, and where it is in a text.
// Every word searched for has to be found. Case and accents don't count. A word found nowhere as typed is
// taken as a typo: it matches the start of any word a letter or two off ("serch" finds "searching",
// "agentbok" finds "agentbook").

// Lower case and without accents, a character for a character, so a place in it is the same place in s.
export const foldCase = (s: unknown): string =>
  String(s ?? "").replace(/[^\x00-\x40\x5b-\x7f]/g, (c) => {
    const l = c.toLowerCase();
    const d = l.length === 1 ? l.normalize("NFD") : "";
    return /^.[̀-ͯ]+$/.test(d) ? d[0] : l.length === 1 ? l : c;
  });
export const WORD = /[\p{L}\p{N}]+/gu;

export const searchWords = (q: unknown): string[] => [...new Set(foldCase(q).split(/\s+/).filter(Boolean))];
// How many typos a word found nowhere as typed may have: none under 4 letters, one up to 7, two from 8.
export const typoBudget = (w: string): number => (!/^[\p{L}\p{N}]+$/u.test(w) ? 0 : w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0);

// How many typos (a letter wrong, missing, extra, or two swapped) w is from the closest start of t, and how
// long that start is; null when it's more than max.
export function nearStart(w: string, t: string, max: number): { typos: number; len: number } | null {
  if (t.length < w.length - max) return null;
  const n = Math.min(t.length, w.length + max);
  let before: number[] = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= w.length; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (w[i - 1] === t[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && w[i - 1] === t[j - 2] && w[i - 2] === t[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 1);
    }
    if (Math.min(...row) > max) return null;
    [before, prev] = [prev, row];
  }
  let best: number = null;
  for (let j = 1; j <= n; j++) if (prev[j] <= max && (best == null || prev[j] <= prev[best])) best = j;
  return best == null ? null : { typos: prev[best], len: best };
}

// What a search looks through, folded, with its words for typos (made when first needed).
export interface Haystack {
  src: string;
  f: string;
  readonly words: string[];
}
// A word searched for, and how many typos it may have (typoBudget).
export interface Term {
  w: string;
  typos: number;
}
export function haystack(src: string): Haystack {
  const f = foldCase(src);
  let words: string[];
  return {
    src,
    f,
    get words() {
      return (words ??= [...new Set(f.match(WORD))]);
    },
  };
}
export const found = (h: Haystack, t: Term): boolean => h.f.includes(t.w) || (t.typos > 0 && h.words.some((x) => nearStart(t.w, x, t.typos)));

// Where the terms are in a text: [start, end) pairs in order, overlaps merged.
export type Hit = [number, number];
export function hits(text: unknown, terms: Term[]): Hit[] {
  const f = foldCase(text);
  const at: Hit[] = [];
  for (const t of terms) {
    for (let i = f.indexOf(t.w); i >= 0; i = f.indexOf(t.w, i + t.w.length)) at.push([i, i + t.w.length]);
    if (t.typos) {
      for (const m of f.matchAll(WORD)) {
        const near = nearStart(t.w, m[0], t.typos);
        if (near) at.push([m.index, m.index + near.len]);
      }
    }
  }
  at.sort((a, b) => a[0] - b[0]);
  const out: Hit[] = [];
  for (const [a, b] of at) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// The bit of a text around a hit, on one line, cut at spaces, with … where it's cut.
export function excerpt(text: string, [a, b]: Hit, before = 60, after = 80): string {
  const start = a > before ? text.lastIndexOf(" ", a - before) + 1 : 0;
  const end = text.indexOf(" ", b + after);
  return `${start ? "…" : ""}${text.slice(start, end < 0 ? text.length : end).replace(/\s+/g, " ").trim()}${end < 0 ? "" : "…"}`;
}

// One search word formatted for SQLite FTS5: quoted as exact and prefix (>1 alphanumeric char)
// so exact matches rank above prefix matches and punctuation/quotes cannot break FTS5 syntax.
export function ftsTerm(word: string): string | null {
  const w = String(word ?? "").trim();
  if (!/[\p{L}\p{N}]/u.test(w)) return null;
  const quoted = `"${w.replace(/"/g, '""')}"`;
  const alnum = (w.match(/[\p{L}\p{N}]/gu) || []).length;
  return alnum > 1 ? `(${quoted} OR ${quoted}*)` : quoted;
}

export function ftsQuery(query: string): string | null {
  const terms = String(query ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .map(ftsTerm)
    .filter((t): t is string => t !== null);
  return terms.length ? terms.join(" AND ") : null;
}

// Strip markdown syntax from a search snippet while preserving identifiers like snake_case.
export function plainSnippet(text: string): string {
  return String(text ?? "")
    .replace(/```[\w-]*/g, " ")
    .replace(/`+/g, "")
    .replace(/(^|[\s(])(\*\*|~~|\*|_)(?=[^\s_*])/g, "$1")
    .replace(/(?<=[^\s_*])(\*\*|~~|\*|_)(?=$|[\s).,;:!?])/g, "")
    .replace(/^#+\s+|(\s)#+\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
