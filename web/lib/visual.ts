// What makes threads and pages visual, worked out from what agentbook keeps: a plan as a bar,
// a thread's life as a strip, a turn's change as tiles, a pull request's checks as dots, numbers that moved, bars in
// a table, a diagram's boxes and arrows, where a thread's time went, a page as a thumbnail. Pure: what to draw and
// where, which web/components/visual/ draws, and test/visual.ts checks.

import type { ChartSeries, DiagramEdge, DiagramNode, PlanItem, PrChecks, Text, TurnChanges, WidgetData, WidgetType, WidgetWidth } from "../../plugin/shared/types.ts";

// A moment: an ISO time, or milliseconds.
export type When = string | number;
// A table's cell, as these read it: text, a number, or one with words (`text`), a status or a meter (TableCell's).
export type Cell = string | number | null | undefined | { meter?: number | string; text?: Cell; status?: string };

export const ms = (t: When | null | undefined): number => (t == null ? NaN : typeof t === "number" ? t : Date.parse(t));
export const pct = (x: number): string => `${Math.max(0, Math.min(100, x)).toFixed(2)}%`;
export const cut = (s: unknown, n: number): string => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};
// How long, in words: "45s", "12m", "1h 30m", "2d 3h".
export function span(d: number): string {
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""}`;
}
export const numText = (v: number): string => (Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 10 ? 2 : Math.abs(v) < 1000 ? 1 : 0 }) : "–");
// A number written in a cell ("1,234", "$12", "45%", "3.2k", "−8"), or null.
export function cellNumber(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object") return v.meter != null ? Number(v.meter) : v.text != null ? cellNumber(v.text) : null;
  const m = /^\s*([+\-−]?)\s*[$€£]?\s*([\d.,]+)\s*([kKmMbB%])?\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const k = ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 } as Record<string, number>)[m[3]] || 1;
  return (m[1] === "-" || m[1] === "−" ? -1 : 1) * n * k;
}

/* ---------- 4: a plan as a bar, a thread's life as a strip ---------- */

// "3 of 5 · Opening the pull request", its steps a bar each: done filled ("d"), the one it's on moving ("n"); `now`,
// the step it's on (in its own words while it's at it), else `next`, the one to come; `title`, every step a line.
export interface PlanParts {
  done: number;
  total: number;
  segs: ("d" | "n" | "")[];
  now: string | null;
  next: string | null;
  title: string;
}
export function planParts(plan: (Pick<PlanItem, "text" | "status"> & { now?: string })[]): PlanParts | null {
  if (!plan?.length) return null;
  const now = plan.find((t) => t.status === "in_progress");
  const next = plan.find((t) => t.status !== "completed");
  return {
    done: plan.filter((t) => t.status === "completed").length,
    total: plan.length,
    segs: plan.slice(0, 24).map((t) => (t.status === "completed" ? "d" : t.status === "in_progress" ? "n" : "")),
    now: now ? now.now || now.text : null,
    next: next ? next.text : null,
    title: plan.map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·"} ${t.text}`).join("\n"),
  };
}

// A mark on a thread's life: its class, its icon and what it's called.
export const MARK: Record<string, { cls: string; ico: string; word: string }> = {
  merge: { cls: "pr", ico: "merge", word: "Merged" },
  pr: { cls: "pr", ico: "pr", word: "Pull request" },
  result: { cls: "ok", ico: "check", word: "Result" },
  pic: { cls: "pic", ico: "image", word: "Pictures" },
  you: { cls: "you", ico: "comment", word: "You" },
};
const RANK = ["merge", "pr", "result", "pic", "you"];
// Marks closer than this (of the strip's width) are one, its most telling kind on top.
const NEAR = 2.2;

// Its life, start to now (or its end): when it worked (its color), waited on you (yellow), and a mark for each
// result, pull request, picture and message of yours. The mark you picked (`pick`) shows its words under it; the
// latest, until you pick.
// life: its stretches of work and of waiting on you ([start, end], end null while it goes on), and its marks.
export interface Life {
  work?: [When, When | null][];
  wait?: [When, When | null][];
  marks?: { at: When; k: string; t: string }[];
}
// A stretch on the strip: from `l` (% of its width), `w` wide; `live` while it goes on.
export interface Seg {
  l: number;
  w: number;
  live?: boolean;
}
// Marks that would sit on each other, as one: where, its most telling kind, and what each says.
export interface MarkGroup {
  at: number;
  k: string;
  words: string;
  marks: Life["marks"];
}
export interface LifeLayout {
  work: Seg[];
  wait: Seg[];
  groups: MarkGroup[];
  shown: number;
  worked: number;
  waited: number;
}
export function lifeLayout(life: Life, { start, end, live = false, pick = null, worked = null, now = Date.now() }: { start?: When; end?: When; live?: boolean; pick?: number | null; worked?: number | null; now?: number } = {}): LifeLayout | null {
  const t0 = ms(start);
  const t1 = Math.max(ms(end), t0 + 60e3);
  if (!life || !Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const x = (t: When): number => ((Math.min(Math.max(ms(t), t0), t1) - t0) / (t1 - t0)) * 100;
  const seg = (a: When, b: When | null, isLive = false): Seg => {
    const l = x(a);
    const r = b == null ? 100 : x(b);
    return { l, w: Math.max(r - l, 0.8), ...(isLive ? { live: true } : {}) };
  };
  const work = (life.work || []).map(([a, b]) => seg(a, b, b == null && live));
  const wait = (life.wait || []).map(([a, b]) => seg(a, b ?? (live ? null : end)));
  // Marks in groups, a group where they'd sit on each other.
  const groups: MarkGroup[] = [];
  for (const m of [...(life.marks || [])].sort((a, b) => ms(a.at) - ms(b.at))) {
    const at = x(m.at);
    const g = groups.at(-1);
    if (g && at - g.at < NEAR) g.marks.push(m);
    else groups.push({ at, k: "", words: "", marks: [m] });
  }
  for (const g of groups) {
    g.k = RANK.find((r) => g.marks.some((m) => m.k === r)) || "result";
    g.words = g.marks.map((m) => `${MARK[m.k]?.word || ""}: ${m.t}`).join("\n");
  }
  const shown = pick != null && groups[pick] ? pick : groups.length - 1;
  const total = (list: [When, When | null][], open: boolean): number => list.reduce((n, [a, b]) => n + ((b == null ? (open ? now : ms(a)) : ms(b)) - ms(a)), 0);
  return { work, wait, groups, shown, worked: worked ?? total(life.work || [], live), waited: total(life.wait || [], live) };
}

/* ---------- 5: a turn's change as tiles, a pull request's checks as dots ---------- */

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i;
// Its files, each a tile as wide as its change (`grow`), green for what it added (`a`, the green share) and red for
// what it took out, a test's outlined; and how many more files it changed than it has tiles for.
export interface Tile {
  path: string;
  add?: number;
  del?: number;
}
export interface TileView extends Tile {
  name: string;
  test: boolean;
  grow: string;
  a: string;
  title: string;
}
export function tilesOf(ch: (Partial<Pick<TurnChanges, "files" | "add" | "del">> & { tiles?: Tile[] }) | null): { tiles: TileView[]; more: number } | null {
  const tiles = (ch?.tiles || []).filter((t) => t?.path);
  if (!tiles.length) return null;
  const size = (t: Tile): number => (t.add || 0) + (t.del || 0);
  const files = Number(ch.files) || tiles.length;
  return {
    tiles: tiles.map((t) => {
      const n = size(t);
      const test = TEST_FILE.test(t.path);
      return { ...t, name: String(t.path).split("/").pop(), test, grow: Math.max(1, Math.sqrt(n)).toFixed(2), a: pct(n ? ((t.add || 0) / n) * 100 : 100), title: `${t.path}  +${t.add || 0} −${t.del || 0}${test ? " (a test)" : ""}` };
    }),
    more: Math.max(0, files - tiles.length),
  };
}

// Its checks, a dot each: failing red ("x"), running grey ("p"), passed green (""), a skipped one hollow ("s"). Past
// 24, in proportion.
export function checkDotsOf(c: Partial<PrChecks> | null): string[] {
  const total = Number(c?.total) || 0;
  if (!total) return [];
  const parts: [string, number][] = [
    ["x", Number(c.fail) || 0],
    ["p", Number(c.pending) || 0],
    ["", Number(c.pass) || 0],
    ["s", Number(c.skip) || 0],
  ];
  const scale = total > 24 ? 24 / total : 1;
  return parts.flatMap(([cls, n]) => Array<string>(n ? Math.max(1, Math.round(n * scale)) : 0).fill(cls));
}

/* ---------- 6: numbers drawn ---------- */

// Numbers that moved: the old one struck through, the new one large, the change colored by whether it's better.
export interface Moved {
  label: string;
  from: number;
  to: number;
  unit?: string;
  better?: "up" | "down";
}
// One, as it reads: from, to, and the change with its class ("d good", "d bad", "d").
export function movedOf(n: Moved): { from: string; to: string; cls: string; change: string } {
  const d = n.to - n.from;
  const rel = n.from ? (d / Math.abs(n.from)) * 100 : null;
  const good = !d || !n.better ? null : n.better === "up" ? d > 0 : d < 0;
  const unit = n.unit ? (/^[$€£]$/.test(n.unit) ? [n.unit, ""] : ["", n.unit === "%" ? "%" : ` ${n.unit}`]) : ["", ""];
  const v = (x: number): string => `${unit[0]}${numText(x)}${unit[1]}`;
  const change = rel != null && d ? { cls: `d${good == null ? "" : good ? " good" : " bad"}`, change: `${d > 0 ? "+" : "−"}${numText(Math.abs(rel))}%` } : d ? { cls: "d", change: `${d > 0 ? "+" : "−"}${v(Math.abs(d))}` } : { cls: "d", change: "Same" };
  return { from: v(n.from), to: v(n.to), ...change };
}

// A table's columns that are all numbers (but its first), and in each, how long each row's bar is against the
// largest: [[column index, [width % per row]]].
export function tableBars(rows: Cell[][] = [], cols = 0): Map<number, (number | null)[]> {
  const out = new Map<number, (number | null)[]>();
  if (rows.length < 2) return out;
  for (let i = 1; i < cols; i++) {
    const vals = rows.map((r) => (r[i] == null || r[i] === "" ? null : cellNumber(r[i])));
    if (vals.some((v, k) => v == null && rows[k][i] != null && rows[k][i] !== "")) continue;
    const nums = vals.filter((v) => v != null);
    if (nums.length < 2) continue;
    // A column of percents that are a meter already has its own bar.
    if (rows.some((r) => r[i] && typeof r[i] === "object" && "meter" in (r[i] as object))) continue;
    const top = Math.max(...nums.map(Math.abs));
    if (!top) continue;
    out.set(i, vals.map((v) => (v == null ? null : (Math.abs(v) / top) * 100)));
  }
  return out;
}

// What a cell sorts by: its number, its day, or its words. A number with words after it ("412 ms", "3.2 GB") counts
// as a number when the whole column has the same words after it (`unit`).
const cellWordsOf = (c: Cell): string => String(c && typeof c === "object" ? (c.text ?? c.status ?? (c.meter != null ? c.meter : "")) : (c ?? "")).trim();
const UNIT_NUM = /^([+\-−]?\s*[$€£]?\s*[\d.,]+)\s*(\D.*)$/;
const DAY = /^\d{4}-\d{2}-\d{2}/;
// The order to show a table's rows in, sorted by one column: [row index, …]. Numbers as numbers ("1,234", "$12",
// "45%", "3.2k", "412 ms"), days as days, anything else as words, with the numbers in them counted ("v9" before
// "v10"). `dir` is "asc" or "desc"; empty cells come last either way, and equal rows stay in the page's order.
export function tableOrder(rows: Cell[][] = [], col = 0, dir = "asc"): number[] {
  const cells = rows.map((r) => r?.[col]);
  const empty = cells.map((c) => !cellWordsOf(c) || /^[—–-]$/.test(cellWordsOf(c)));
  const full = cells.filter((_, i) => !empty[i]);
  let keys: number[] = null;
  if (full.length && full.every((c) => cellNumber(c) != null)) keys = cells.map(cellNumber);
  else if (full.length) {
    const m = full.map((c) => UNIT_NUM.exec(cellWordsOf(c)));
    if (m.every((x) => x && cellNumber(x[1]) != null && x[2].trim() === m[0][2].trim())) keys = cells.map((c) => cellNumber(UNIT_NUM.exec(cellWordsOf(c))?.[1]));
    else if (full.every((c) => DAY.test(cellWordsOf(c)) && !Number.isNaN(Date.parse(cellWordsOf(c))))) keys = cells.map((c) => Date.parse(cellWordsOf(c)));
  }
  const words = keys ? null : cells.map(cellWordsOf);
  const cmp = keys ? (a: number, b: number) => keys[a] - keys[b] : (a: number, b: number) => words[a].localeCompare(words[b], undefined, { numeric: true, sensitivity: "base" });
  const sign = dir === "desc" ? -1 : 1;
  return rows.map((_, i) => i).sort((a, b) => Number(empty[a]) - Number(empty[b]) || (empty[a] ? 0 : sign * cmp(a, b)) || a - b);
}
// The sort a table's agent gave it (`sort`: a column's name, "-" before it for largest first): { col, dir }, or null.
// d: a table's data, as these read it.
export interface TableData {
  sort?: unknown;
  columns?: unknown[];
  rows?: Cell[][];
}
export function tableSort(d: TableData | null): { col: number; dir: "asc" | "desc" } | null {
  const name = typeof d?.sort === "string" ? d.sort.replace(/^-/, "") : "";
  const col = name ? (d.columns || []).indexOf(name) : -1;
  return col < 0 ? null : { col, dir: (d.sort as string).startsWith("-") ? "desc" : "asc" };
}
// Its rows as it shows them first: in that sort, or as written.
export function sortedRows(d: TableData | null): Cell[][] {
  const by = tableSort(d);
  const rows = d?.rows || [];
  return by ? tableOrder(rows, by.col, by.dir).map((i) => rows[i]) : rows;
}
// Whether a column sorts as numbers (so its first click puts the largest first).
export const sortsAsNumber = (rows: Cell[][] = [], col = 0): boolean => rows.some((r) => cellNumber(r?.[col]) != null) && rows.every((r) => r?.[col] == null || r[col] === "" || cellNumber(r[col]) != null);

/* ---------- 8: a diagram ---------- */

const NODE_H = 36;
const NODE_H2 = 52;
const ROW_GAP = 16;
// Its boxes in columns, left to right along the arrows: a box's column is the longest way to it from a box nothing
// points at (an arrow back, closing a loop, doesn't count). In a column, boxes go in the order of the boxes that point
// at them, then as given. -> { width, height, nodes: [{ id, x, y, w, h, … }], edges: [{ from, to, label, back, d }] }
// dg: a diagram as an agent gave it, its boxes' ids anything that reads as one.
export interface DiagramIn {
  title?: Text;
  nodes?: (Omit<DiagramNode, "id"> & { id: unknown })[];
  edges?: (Omit<DiagramEdge, "from" | "to"> & { from: unknown; to: unknown })[];
}
export type Box = DiagramIn["nodes"][number] & { id: string; x: number; y: number; w: number; h: number };
type Edge = DiagramEdge;
export interface Line {
  from: string;
  to: string;
  label: string | null;
  back: boolean;
  d: string;
  lx: number;
  ly: number;
}
export interface Layout {
  width: number;
  height: number;
  nodes: Box[];
  edges: Line[];
  colGap: number;
  // Its columns as rows, top to bottom (layoutDown).
  down?: boolean;
}
export function layoutDiagram(dg: DiagramIn | null): Layout {
  const nodes = (dg?.nodes || []).filter((n) => n?.id != null);
  const ids = nodes.map((n) => String(n.id));
  const has = new Set(ids);
  const edges: Edge[] = (dg?.edges || []).filter((e) => has.has(String(e.from)) && has.has(String(e.to)) && e.from !== e.to).map((e) => ({ ...e, from: String(e.from), to: String(e.to) }));
  const out = new Map(ids.map((id): [string, string[]] => [id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  // Arrows back: the ones a walk along the arrows meets going round.
  const seen = new Map<string, number>();
  const back = new Set<string>();
  const visit = (u: string) => {
    seen.set(u, 1);
    for (const v of out.get(u)) {
      if (seen.get(v) === 1) back.add(`${u}\n${v}`);
      else if (!seen.get(v)) visit(v);
    }
    seen.set(u, 2);
  };
  for (const id of ids) if (!seen.get(id)) visit(id);
  const fwd = edges.filter((e) => !back.has(`${e.from}\n${e.to}`));
  const rank = new Map(ids.map((id) => [id, 0]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of fwd) indeg.set(e.to, indeg.get(e.to) + 1);
  const queue = ids.filter((id) => !indeg.get(id));
  while (queue.length) {
    const u = queue.shift();
    for (const e of fwd) {
      if (e.from !== u) continue;
      rank.set(e.to, Math.max(rank.get(e.to), rank.get(u) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (!indeg.get(e.to)) queue.push(e.to);
    }
  }
  const cols: string[][] = [];
  for (const id of ids) (cols[rank.get(id)] ||= []).push(id);
  const row = new Map<string, number>();
  cols.forEach((col, c) => {
    if (c > 0) {
      const at = (id: string): number => {
        const from = fwd.filter((e) => e.to === id && row.has(e.from)).map((e) => row.get(e.from));
        return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Infinity;
      };
      col.sort((a, b) => at(a) - at(b) || ids.indexOf(a) - ids.indexOf(b));
    }
    col.forEach((id, i) => row.set(id, i));
  });
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const labelled = edges.some((e) => e.label);
  // A long chain, a few boxes wide at most, reads top to bottom: it fits a narrow card without scrolling.
  if (cols.length > 3 && Math.max(...cols.map((c) => c.length)) <= 3) return layoutDown(cols, byId, edges, back, rank, labelled);
  const colGap = labelled ? 104 : 56;
  // A column as wide as its longest title wants, within reason.
  const widths = cols.map((col) => Math.max(132, Math.min(232, Math.max(...col.map((id) => Math.max(String(byId.get(id).title || "").length * 7.3, String(byId.get(id).text || "").length * 6.1) + 28)))));
  const hOf = (id: string): number => (byId.get(id).text ? NODE_H2 : NODE_H);
  const heights = cols.map((col) => col.reduce((n, id) => n + hOf(id), 0) + ROW_GAP * (col.length - 1));
  const tall = Math.max(...heights, NODE_H);
  const pad = 14;
  const placed = new Map<string, Box>();
  let x = pad;
  cols.forEach((col, c) => {
    let y = pad + (tall - heights[c]) / 2;
    for (const id of col) {
      placed.set(id, { ...byId.get(id), id, x, y, w: widths[c], h: hOf(id) });
      y += hOf(id) + ROW_GAP;
    }
    x += widths[c] + colGap;
  });
  const width = x - colGap + pad;
  let height = tall + pad * 2;
  const lines = edges.map((e): Line => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    const isBack = back.has(`${e.from}\n${e.to}`) || rank.get(e.to) <= rank.get(e.from);
    if (isBack) {
      // Under the boxes, from the bottom of one to the bottom of the other.
      const y0 = Math.max(a.y + a.h, b.y + b.h) + 26;
      height = Math.max(height, y0 + pad);
      const x1 = a.x + a.w / 2;
      const x2 = b.x + b.w / 2;
      return { from: e.from, to: e.to, label: e.label || null, back: true, d: `M${x1},${a.y + a.h} C${x1},${y0} ${x2},${y0} ${x2},${b.y + b.h + 6}`, lx: (x1 + x2) / 2, ly: y0 - 4 };
    }
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x - 6;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(24, (x2 - x1) / 2);
    return { from: e.from, to: e.to, label: e.label || null, back: false, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, lx: x1 + Math.min(colGap / 2, (x2 - x1) / 2), ly: (y1 + y2) / 2 };
  });
  return { width: Math.round(width), height: Math.round(height), nodes: [...placed.values()], edges: lines, colGap };
}

// layoutDiagram's columns as rows: each box as wide as its words want, a row's boxes side by side, arrows down from
// one row to the next, and one going back up round the right-hand side.
function layoutDown(rows: string[][], byId: Map<string, DiagramIn["nodes"][number]>, edges: Edge[], back: Set<string>, rank: Map<string, number>, labelled: boolean): Layout {
  const pad = 14;
  const gapX = 24;
  const gapY = labelled ? 50 : 36;
  const wOf = (id: string): number => Math.round(Math.max(120, Math.min(220, Math.max(String(byId.get(id).title || "").length * 7.3, String(byId.get(id).text || "").length * 6.1) + 28)));
  const hOf = (id: string): number => (byId.get(id).text ? NODE_H2 : NODE_H);
  const rowW = rows.map((r) => r.reduce((n, id) => n + wOf(id), 0) + gapX * (r.length - 1));
  const wide = Math.max(...rowW);
  const placed = new Map<string, Box>();
  let y = pad;
  rows.forEach((r, i) => {
    let x = pad + (wide - rowW[i]) / 2;
    const h = Math.max(...r.map(hOf));
    for (const id of r) {
      placed.set(id, { ...byId.get(id), id, x, y: y + (h - hOf(id)) / 2, w: wOf(id), h: hOf(id) });
      x += wOf(id) + gapX;
    }
    y += h + gapY;
  });
  let width = wide + pad * 2;
  const lines = edges.map((e): Line => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    const base = { from: e.from, to: e.to, label: e.label || null };
    if (back.has(`${e.from}\n${e.to}`) || rank.get(e.to) <= rank.get(e.from)) {
      const x0 = Math.max(a.x + a.w, b.x + b.w) + 30;
      width = Math.max(width, x0 + pad + (e.label ? 40 : 0));
      const y1 = a.y + a.h / 2;
      const y2 = b.y + b.h / 2;
      return { ...base, back: true, d: `M${a.x + a.w},${y1} C${x0},${y1} ${x0},${y2} ${b.x + b.w + 6},${y2}`, lx: x0, ly: (y1 + y2) / 2 };
    }
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y - 6;
    const dy = Math.max(12, (y2 - y1) / 2);
    return { ...base, back: false, d: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 + 3 };
  });
  return { width: Math.round(width), height: Math.round(y - gapY + pad), nodes: [...placed.values()], edges: lines, colGap: 140, down: true };
}

// A diagram as it's drawn: its layout, each box's title and line as they fit it (a done one ticked, a failed one
// crossed), each arrow's label as it fits between the columns with the width of its backing, and how narrow it may
// shrink before it scrolls sideways (three quarters).
export interface DiagramParts {
  L: Layout;
  boxes: { n: Box; title: string; line: string | null; tip: string }[];
  labels: { e: Line; text: string; w: number }[];
  min: number;
}
export function diagramParts(dg: DiagramIn | null): DiagramParts | null {
  const L = layoutDiagram(dg);
  if (!L.nodes.length) return null;
  const glyph: Record<string, string> = { done: "✓ ", failed: "✕ " };
  const boxes = L.nodes.map((n) => ({ n, title: cut(`${glyph[n.state] || ""}${n.title}`, Math.floor((n.w - 22) / 7.3)), line: n.text ? cut(n.text, Math.floor((n.w - 22) / 6.1)) : null, tip: `${n.title}${n.text ? `: ${n.text}` : ""}` }));
  const labels = L.edges
    .filter((e) => e.label)
    .map((e) => {
      const text = cut(e.label, Math.floor((L.colGap - 8) / 6));
      return { e, text, w: text.length * 6 + 8 };
    });
  return { L, boxes, labels, min: Math.min(L.width, Math.round(L.width * 0.75)) };
}

/* ---------- 10: where the time went ---------- */

export const KINDS: Record<string, string> = { read: "Reading", edit: "Editing", test: "Tests", web: "Browser and web", run: "Commands", think: "Thinking", wait: "Waiting on you" };
const TEST_CMD = /\b(npm (run )?test|pnpm (run )?test|yarn test|node (--test|test\/)|pytest|go test|cargo test|jest|vitest|mocha|rspec|make test|tests?|smoke)\b/i;
const READS = /^(Read|Grep|Glob|LS|NotebookRead|ToolSearch)$|__(ab_show|ab_inbox|ab_page_read|ab_page_list|ab_note_read|ab_note_list|ab_thread_read|ab_group_read|ab_routine_read)$/;
const WEB = /^(WebFetch|WebSearch)$|claude-in-chrome|Claude_Browser|playwright|puppeteer|browser/i;
// What a step was: reading, editing, tests, the browser and the web, other commands, or thinking (the rest: what
// it said, the tools it tells agentbook with, the workers it starts).
// A step, as these read it: its tool and the line about it, or what the agent said (`kind` "say").
export interface StepIn {
  at?: When;
  done?: When | null;
  tool?: string;
  kind?: string;
  title?: string;
  text?: string;
}
export function stepKind(st: StepIn | null): string {
  const t = st?.tool || "";
  if (st?.kind === "say") return "think";
  if (READS.test(t)) return "read";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) return "edit";
  if (WEB.test(t)) return "web";
  if (t === "Bash" || t === "BashOutput" || t === "Monitor") {
    const title = st.title || "";
    if (TEST_CMD.test(title)) return "test";
    if (/\b(curl|wget|headless|chrome|screenshot)\b/i.test(title)) return "web";
    return "run";
  }
  return "think";
}

// Stretches of one kind from a lane's steps: each tool from its start to when it finished (or the next step, when
// that's a few seconds on), a longer pause before the next step thinking. A gap of more than IDLE isn't drawn.
const IDLE = 10 * 60e3;
export interface Block {
  kind: string;
  a: number;
  b: number;
  steps: StepIn[];
}
export function blocksOf(steps: StepIn[], end = Date.now()): Block[] {
  const list = [...(steps || [])].filter((s) => Number.isFinite(ms(s.at))).sort((a, b) => ms(a.at) - ms(b.at));
  const out: Block[] = [];
  const push = (kind: string, a: number, b: number, st: StepIn | null) => {
    if (!(b > a)) return;
    const last = out.at(-1);
    if (last && last.kind === kind && a - last.b < 3000) {
      last.b = Math.max(last.b, b);
      if (st) last.steps.push(st);
    } else out.push({ kind, a, b, steps: st ? [st] : [] });
  };
  list.forEach((st, i) => {
    const a = ms(st.at);
    const next = i + 1 < list.length ? ms(list[i + 1].at) : Math.min(end, a + 60e3);
    const done = Number.isFinite(ms(st.done)) ? Math.min(ms(st.done), next) : next;
    // A few seconds to the next step are this one's: only a longer pause is thinking.
    const b = next - done < 20e3 ? next : Math.min(done, a + IDLE);
    if (st.kind === "say") push("think", a, Math.min(next, a + IDLE), st);
    else push(stepKind(st), a, Math.max(b, a + 1000), st);
    if (st.kind !== "say" && next - b >= 20e3 && next - b < IDLE) push("think", b, next, null);
  });
  return out;
}

// The thread's steps as a timeline: a lane for its agent and one for each worker, a block for each stretch, a mark
// where you wrote, and under it the share of each kind. Long quiet stretches fold to a narrow gap ("3h"). The block
// you pick ("lane:i") shows its steps below (pickedOf). `waits`: [[asked, answered]].
// workers: the ones it started, each with its own steps once read.
export interface WorkerIn {
  id?: string;
  title?: string;
  started?: When;
  ended?: When | null;
  steps?: StepIn[];
}
// A block as it's drawn: from `l`, `w` wide (% of the lane), its key ("lane:i") and its tip.
export interface BlockView extends Block {
  l: number;
  w: number;
  k: string;
  tip: string;
}
export interface TimelineParts {
  lanes: { name: string; worker?: boolean; blocks: BlockView[] }[];
  // Where you wrote, on the agent's lane.
  you: { l: number; title: string }[];
  // The quiet stretches, folded.
  folds: { l: number; w: number; text: string; title: string }[];
  axis: { l: number; text: string }[];
  // The share of each kind of the agent's own time, largest first.
  legend: { kind: string; name: string; pct: number }[];
  busy: string;
  gaps: number;
}
export function timelineOf({ steps = [], workers = [], you = [], waits = [], now = Date.now(), clock = (t) => new Date(t).toLocaleTimeString() }: { steps?: StepIn[]; workers?: WorkerIn[]; you?: When[]; waits?: [When, When | null][]; now?: number; clock?: (t: When) => string } = {}): TimelineParts | null {
  const lanes: { name: string; blocks: Block[]; worker?: boolean }[] = [{ name: "Agent", blocks: blocksOf(steps, now) }];
  for (const [a, b] of waits) {
    const t0 = ms(a);
    const t1 = b == null ? now : ms(b);
    if (t1 > t0) lanes[0].blocks.push({ kind: "wait", a: t0, b: t1, steps: [] });
  }
  for (const w of workers.slice(0, 6)) {
    const own = w.steps?.length ? blocksOf(w.steps, Number.isFinite(ms(w.ended)) ? ms(w.ended) : now) : [];
    const blocks = own.length ? own : Number.isFinite(ms(w.started)) ? [{ kind: "think", a: ms(w.started), b: Number.isFinite(ms(w.ended)) ? ms(w.ended) : now, steps: [] }] : [];
    if (blocks.length) lanes.push({ name: w.title || "A worker", blocks, worker: true });
  }
  const all = lanes.flatMap((l) => l.blocks).sort((a, b) => a.a - b.a);
  if (!all.length) return null;
  // Busy stretches, and the quiet between them folded.
  const runs: { a: number; b: number; x?: number; w?: number }[] = [];
  for (const b of all) {
    const r = runs.at(-1);
    if (r && b.a - r.b < IDLE) r.b = Math.max(r.b, b.b);
    else runs.push({ a: b.a, b: b.b });
  }
  const gaps = runs.length - 1;
  const gapW = gaps ? Math.min(3, 24 / gaps) : 0;
  const busy = runs.reduce((n, r) => n + (r.b - r.a), 0) || 1;
  const room = 100 - gapW * gaps;
  let at = 0;
  for (const r of runs) {
    r.x = at;
    r.w = ((r.b - r.a) / busy) * room;
    at += r.w + gapW;
  }
  const x = (t: number): number => {
    const r = runs.find((q) => t <= q.b) || runs.at(-1);
    return r.x + ((Math.max(Math.min(t, r.b), r.a) - r.a) / (r.b - r.a || 1)) * r.w;
  };
  const folds = runs.slice(1).map((r, i) => ({ l: runs[i].x + runs[i].w, w: gapW, text: gapW >= 2 ? span(r.a - runs[i].b) : "", title: `${span(r.a - runs[i].b)} quiet` }));
  const axis = runs.filter((r, i) => i === 0 || r.x - runs[i - 1].x > 14).map((r) => ({ l: r.x, text: clock(r.a) }));
  const views = lanes.map((l, li) => ({
    name: l.name,
    ...(l.worker ? { worker: true } : {}),
    blocks: l.blocks.map((b, i): BlockView => {
      const l0 = x(b.a);
      return { ...b, l: l0, w: Math.max(x(b.b) - l0, 0.35), k: `${li}:${i}`, tip: `${KINDS[b.kind]}, ${span(b.b - b.a)}${b.steps.length ? `: ${b.steps.slice(0, 3).map((s) => s.title || s.text || "").join("; ")}${b.steps.length > 3 ? "…" : ""}` : ""}` };
    }),
  }));
  // The share of each kind, of the agent's own time.
  const share: Record<string, number> = {};
  for (const b of lanes[0].blocks) share[b.kind] = (share[b.kind] || 0) + (b.b - b.a);
  const sum = Object.values(share).reduce((a, b) => a + b, 0) || 1;
  const legend = Object.entries(share)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, v]) => ({ kind, name: KINDS[kind], pct: Math.max(1, Math.round((v / sum) * 100)) }));
  return { lanes: views, you: you.map((t) => ({ l: x(ms(t)), title: `You wrote, ${clock(t)}` })), folds, axis, legend, busy: span(runs.reduce((n, r) => n + (r.b - r.a), 0)), gaps };
}
// The block picked ("lane:i"), if it's there.
export function pickedOf(tl: TimelineParts | null, pick: string | null): BlockView | null {
  const [pl, pi] = String(pick ?? "").split(":").map(Number);
  return (Number.isFinite(pl) && tl?.lanes[pl]?.blocks[pi]) || null;
}

/* ---------- 7: a page as a thumbnail ---------- */

// How many quarters of a page's width a widget takes.
const SPAN: Record<string, number> = { quarter: 1, third: 1, half: 2, "two-thirds": 3, full: 4 };
export const widgetSpan = (w: { width?: WidgetWidth; type?: WidgetType }): number => SPAN[w.width] || (["chart", "table", "doc", "options", "diagram"].includes(w.type) ? 2 : 1);
// A line of numbers, small: its points in a 100×30 box, or null with fewer than two.
export function miniLinePoints(values: unknown[]): string | null {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums) - lo || 1;
  return nums.map((n, i) => `${((i / (nums.length - 1)) * 100).toFixed(1)},${(28 - ((n - lo) / hi) * 25).toFixed(1)}`).join(" ");
}
// A chart, small: its first series as a line; a stacked one's totals; a scatter's first points as dots (a stroke of
// no length with round ends each, which stays round however the box stretches it).
export function miniChartOf(d: WidgetData): { line: string } | { dots: string } | null {
  if (d.kind === "stacked") {
    const pts = miniLinePoints((d.x || []).map((_, i) => ((d.series as ChartSeries[]) || []).reduce((t, s) => t + (Number(s.values?.[i]) || 0), 0)));
    return pts ? { line: pts } : null;
  }
  if (d.kind !== "scatter") {
    const pts = miniLinePoints((d.series as ChartSeries[])?.[0]?.values);
    return pts ? { line: pts } : null;
  }
  const ps = ((d.series as ChartSeries[])?.[0]?.points || []).filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))).slice(0, 80);
  if (ps.length < 2) return null;
  const [xs, ys] = [ps.map((p) => Number(p.x)), ps.map((p) => Number(p.y))];
  const at = (v: number, vs: number[], len: number): number => ((v - Math.min(...vs)) / (Math.max(...vs) - Math.min(...vs) || 1)) * len;
  return { dots: ps.map((p) => `M${(2 + at(Number(p.x), xs, 96)).toFixed(1)},${(28 - at(Number(p.y), ys, 25)).toFixed(1)}h0`).join("") };
}
// A table, small: its first rows as bars, as long as the numbers of its first column of numbers (else stepping down).
export function miniTableBars(d: WidgetData): string[] {
  const rows = sortedRows(d as TableData).slice(0, 4);
  const bars = tableBars(rows, (d.columns || []).length);
  const [col, widths] = [...bars.entries()][0] || [];
  return rows.map((_, i) => pct(col != null ? Math.max(widths[i] ?? 0, 6) : 100 - i * 14));
}
export interface WidgetIn {
  id?: string;
  type: WidgetType;
  title?: Text;
  width?: WidgetWidth;
  data?: WidgetData;
}
// The widgets a thumbnail can draw small.
export const MINI_TYPES = new Set<string>(["metric", "chart", "table", "list", "tasks", "options", "doc", "note", "diagram"]);
// A page's first widgets that fit its thumbnail: two rows of four quarters, filters and HTML left out.
export function thumbWidgets(p: { widgets?: WidgetIn[] }): WidgetIn[] {
  const out: WidgetIn[] = [];
  let room = 8;
  for (const w of (p.widgets || []).filter((w) => w.type !== "filter" && w.type !== "html")) {
    if (!MINI_TYPES.has(w?.type)) continue;
    out.push(w);
    room -= SPAN[w.width] || 1;
    if (room <= 0) break;
  }
  return out;
}
