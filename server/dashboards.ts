// Dashboards' queries, run on agentbook-server: each panel of a dashboard asks its owner's
// connector, for the range and variables whoever's looking picked. Its answer is shaped into its widget's data here
// (dashboards.ts shapeAnswer), so the page draws it as it draws any widget.
//
// - One answer per query, for everyone: kept in memory by the connector, the query, the variables it uses, the
//   interval and the range rounded to it, so two people on "the last 24 hours" share it. A range ending now keeps it
//   its interval (30 s to 5 min), one wholly in the past a day. A query already being asked isn't asked again: its
//   askers wait for the same answer. The memory it takes is capped by bytes.
// - Each panel's last answer for each view is kept in agentbook-server's database (`panel_kept`, never a version):
//   one row per panel per view (the range's name, "24h", not its times, so a moving window overwrites its row), for
//   exactly what the panel asks (its type, query, shape, thresholds and markers) and the variables its query uses.
//   Opening a dashboard draws it at once from them, dated: one still within its interval is the answer (a restart
//   asks nothing again), an older one shows dimmed while the source is asked behind it, and one whose source fails
//   shows greyed, with why. The dashboard's own view (its range, its variables' defaults) is also what its card on
//   the feed and its tile in Dashboards show (`face`), so they never ask a source.
// - Kept small: an answer stored compressed past 1 KB, none over 64 KB; the dashboard's own view and the 3 other
//   views looked at last per panel; another view nobody's looked at for 7 days goes. They go with what made them: a
//   panel removed or asking something else, its dashboard gone, its connector removed or its keys changed.
// - Kept answers only leave with their dashboard, to whoever may see it (who could ask for them anyway).
// - Numbers are never saved as a page's versions.

import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { intervalFor, intervalText, isPanel, keepFor, picked, previous, rangeOf, roundRange, shapeAnswer, varsIn } from "../plugin/shared/dashboards.ts";
import type { Answer, Frame, Range } from "../plugin/shared/dashboards.ts";
import type { Storage } from "../plugin/shared/storage.ts";
import type { ChartSeries, DashVar, Iso, PageDash, PanelQuery, TableCell, Widget, WidgetData, WidgetItem } from "../plugin/shared/types.ts";
import { DashboardTables } from "./storage/dashboards.ts";

const TIMEOUT_MS = Number(process.env.AGENTBOOK_PANEL_TIMEOUT_MS || 30000);
// The memory the shared answers take at most (about: their JSON's length).
const CACHE_BYTES = Number(process.env.AGENTBOOK_PANEL_CACHE_BYTES) || 32 * 1024 * 1024;
// How long an answer is kept at most (tests make it short).
const KEEP_MAX = Number(process.env.AGENTBOOK_PANEL_KEEP_MS) || Infinity;
const KEPT_VIEWS = 3; // views kept per panel besides its dashboard's own
const KEPT_DAYS = 7; // another view nobody's looked at for this long goes
const KEPT_BYTES = 64 * 1024; // an answer that takes more, stored, isn't kept
const ZIP_FROM = 1024; // an answer that takes more is stored compressed
const FACE_POINTS = 24; // a line on a card or a tile, at most

// A dashboard's panel, as its query is run: a widget of a page's, or of a draft's.
type Panel = Pick<Widget, "id" | "type" | "query"> & Partial<Pick<Widget, "shape" | "thresholds" | "markers">>;
// A dashboard as its panels are run: a page, or a draft of one (a test run of what an agent writes).
export interface Dash {
  id: string;
  widgets: Panel[];
  dash?: PageDash;
  owner?: string | null;
  version?: number;
  kind?: "dashboard";
}
// What a request asks a dashboard for: a range by name, or from and to; the variables picked, by id; Compare.
export interface Asked {
  range?: unknown;
  from?: unknown;
  to?: unknown;
  vars?: Record<string, unknown>;
  compare?: unknown;
}
// A view of a dashboard, as its queries get it (viewOf): the range, rounded, as it was asked, its interval, the
// variables' values, Compare, and now (ms).
export interface View extends Range {
  asked: Range;
  interval: number;
  vars: Record<string, string | string[]>;
  compare: boolean;
  now: number;
}
// A connector a query names, without asking it (connectors.ts's which).
interface Source {
  id: string;
  kind: string;
  name: string;
}
// A query as its connector is asked it: filled in for a view's range, interval and variables.
type Ask = PanelQuery & { from: number; to: number; interval: number; vars: Record<string, string | string[]> };
// What dashboards.ts asks of a person's connectors (integrations/connectors.ts): which one a query names, its answer,
// and the same query opened in the source's own app.
export interface Sources {
  which(uid: string, ref: string): Source | null;
  query(uid: string, ref: string, q: Ask): Promise<{ frames?: Frame[]; ms?: number; notes?: string[] }>;
  link(uid: string, ref: string, q: Ask): string | null;
}
// One query, ready to ask (prepare): its connector, what it's asked, the variables it uses, its key in memory, and
// how long its answer is the answer (ms).
interface Prepared {
  c: Source | null;
  ask: Ask;
  vars: Record<string, string | string[]>;
  key: string;
  keep: number;
}
// A query's answer, as it's shared in memory: when it came and until when it's the answer (ms), its frames, how long
// it took, its notes, and about how many bytes it takes. `cached`: it came from memory.
interface Got {
  at: Iso;
  exp: number;
  frames: Frame[];
  ms: number;
  notes: string[];
  bytes?: number;
  cached?: boolean;
}
// A chart's markers' answer, or why it didn't come.
type Marks = (Got & { failed?: undefined }) | { failed: string; frames?: undefined };
// A panel's last answer for a view, as it's kept (unpacked), with when it came.
interface Kept {
  at: Iso;
  ms: number;
  data: Answer;
  notes?: string[];
}
// A panel's answer for a view (runPanel).
export interface PanelAnswer {
  id: string;
  type?: Widget["type"];
  at?: Iso;
  ms?: number;
  data?: Answer;
  source?: Source;
  link?: string | null;
  notes?: string[];
  error?: string;
  stale?: boolean;
  cached?: boolean;
  refreshing?: boolean;
}
// What a dashboard's card and tile show of a panel: its own view's last answer, small, and when it came.
type Face = Record<string, { at: Iso; data: WidgetData }>;
// What a query tried once asks for (tryQuery): the range (or from and to), and the variables' values.
interface TryView {
  range?: unknown;
  from?: unknown;
  to?: unknown;
  vars?: Record<string, string | string[]>;
}
// host: { connectors, storage (agentbook-server's, plugin/shared/storage.ts), log, ownerOf(page) -> account id | null }
export interface DashboardsHost {
  connectors: Sources;
  storage: Storage;
  log?: (line: string) => void;
  ownerOf: (p: Dash) => string | null;
}

const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("base64url").slice(0, 16);
// What a panel asks, as far as its answer goes: not its name, place or who wrote it.
const defOf = (w: Panel) => hash([w.type, w.query, w.shape || null, w.thresholds || null, w.markers || null]);
const pack = (x: unknown) => {
  const json = JSON.stringify(x);
  return json.length > ZIP_FROM ? `z:${deflateRawSync(json).toString("base64")}` : json;
};
const unpack = (s: string): Kept => JSON.parse(s.startsWith("z:") ? inflateRawSync(Buffer.from(s.slice(2), "base64")).toString() : s);

export function createDashboards({ connectors, storage, log = () => {}, ownerOf }: DashboardsHost) {
  const tables = storage.use(DashboardTables);
  const cache = new Map<string, Got>(); // key -> { at, exp, frames, ms, notes, bytes }, oldest first
  let cacheBytes = 0;
  const flying = new Map<string, Promise<Got>>(); // key -> its promise
  const faces = new Map<string, { version: number; face: Face }>(); // page -> { version, face }, made when asked

  // The view a request asks for, as the queries get it: the range (rounded), the interval, what's picked.
  function viewOf(p: Pick<Dash, "dash">, asked: Asked = {}, now = Date.now()): View {
    const r = rangeOf({ range: asked.range ?? (asked.from == null ? p.dash?.range : undefined), from: asked.from, to: asked.to }, now);
    const interval = intervalFor(r.from, r.to);
    const rounded = roundRange(r, interval);
    return { ...r, ...rounded, asked: r, interval, vars: picked(p.dash?.vars || [], asked.vars || {}), compare: !!asked.compare, now };
  }

  // One query, as a panel asks it of its connector: filled in its connector's language, and its key.
  function prepare(uid: string, q: PanelQuery, view: View, range: { from: number; to: number } = view): Prepared {
    const c = connectors.which(uid, q.source);
    const used = [...new Set([...varsIn(q.text), ...Object.values(q.queries || {}).flatMap(varsIn), ...varsIn(q.formula)])];
    const vars = Object.fromEntries(used.filter((v) => v in view.vars).map((v) => [v, view.vars[v]]));
    const to = Math.min(range.to, view.now);
    const ask: Ask = { ...q, from: range.from, to, interval: view.interval, vars };
    const key = JSON.stringify([c?.id || q.source, q, vars, view.interval, range.from, range.to]);
    return { c, ask, vars, key, keep: Math.min(keepFor({ past: range.to < view.now - 60e3 }, view.interval), KEEP_MAX) };
  }
  // A panel's view, as its kept answer is found by: the range by its name ("24h") when it ends now, so a moving
  // window keeps one row, else its times; the variables its query uses; Compare, for a chart.
  const viewKey = (w: Panel, view: View, main: Prepared) => hash([main.c?.id || w.query.source, view.rel || [view.from, view.to], main.vars, w.type === "chart" && view.compare]);

  function remember(key: string, got: Got) {
    const had = cache.get(key);
    if (had) {
      cacheBytes -= had.bytes;
      cache.delete(key);
    }
    got.bytes = JSON.stringify(got.frames).length + 200;
    cache.set(key, got);
    cacheBytes += got.bytes;
    if (cacheBytes <= CACHE_BYTES) return;
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.exp >= now) continue;
      cacheBytes -= v.bytes;
      cache.delete(k);
    }
    for (const [k, v] of cache) {
      if (cacheBytes <= CACHE_BYTES || k === key) break;
      cacheBytes -= v.bytes;
      cache.delete(k);
    }
  }
  const fresh = (key: string) => {
    const hit = cache.get(key);
    return hit && hit.exp > Date.now() ? hit : null;
  };
  async function asked(uid: string, prep: Prepared): Promise<Got> {
    const hit = fresh(prep.key);
    if (hit) return { ...hit, cached: true };
    if (flying.has(prep.key)) return flying.get(prep.key);
    const run = (async () => {
      const t0 = Date.now();
      const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error(`It took over ${Math.round(TIMEOUT_MS / 1000)} s.`)), TIMEOUT_MS).unref?.());
      const r = await Promise.race([connectors.query(uid, prep.ask.source, prep.ask), timeout]);
      const got: Got = { at: new Date().toISOString(), exp: Date.now() + prep.keep, frames: r.frames || [], ms: r.ms ?? Date.now() - t0, notes: r.notes || [] };
      remember(prep.key, got);
      return got;
    })().finally(() => flying.delete(prep.key));
    flying.set(prep.key, run);
    return run;
  }

  // ---------- the kept answers ----------

  function keptOf(page: string, panel: string, view: string, def: string): Kept | null {
    const r = tables.kept(page, panel, view, def);
    if (!r) return null;
    try {
      return { at: r.at, ...unpack(r.answer) };
    } catch {
      return null;
    }
  }
  const touch = (page: string, panel: string, view: string) => tables.touch(page, panel, view);
  function keep(p: Dash, w: Panel, view: string, def: string, conn: string | null, own: boolean, answer: Kept): void {
    const packed = pack(answer);
    if (packed.length > KEPT_BYTES) return void tables.drop(p.id, w.id, view);
    tables.keep({ page: p.id, panel: w.id, view, def, conn, own, at: answer.at, used: Date.now(), answer: packed });
    // The views looked at least go, past the last few.
    tables.keepLatest(p.id, w.id, def, KEPT_VIEWS);
    if (own) faces.delete(p.id);
  }
  // The dashboard's own view for a panel: its range and its variables' defaults.
  function ownKey(p: Dash, w: Panel, uid: string) {
    try {
      const v = viewOf(p, {});
      return viewKey(w, v, prepare(uid, w.query, v));
    } catch {
      return null;
    }
  }

  // A panel's answer for a view: { id, at, ms, data, source, link, notes, error?, stale?, cached? }. With `onKept`,
  // a kept answer too old to be the answer goes to it at once (`refreshing`), before the source is asked.
  async function runPanel(p: Dash, w: Panel, view: View, { onKept = null }: { onKept?: ((a: PanelAnswer) => void) | null } = {}): Promise<PanelAnswer> {
    const uid = ownerOf(p);
    const out: PanelAnswer = { id: w.id, type: w.type };
    let main: Prepared;
    try {
      main = prepare(uid, w.query, view);
    } catch (e) {
      return { ...out, error: e.message };
    }
    out.source = main.c || { id: w.query.source, kind: w.query.source, name: w.query.source };
    out.link = main.c ? connectors.link(uid, w.query.source, main.ask) : null;
    const def = defOf(w);
    const vk = viewKey(w, view, main);
    const kept = keptOf(p.id, w.id, vk, def);
    if (kept) touch(p.id, w.id, vk);
    const keptOut: PanelAnswer | null = kept && { ...out, at: kept.at, ms: kept.ms, data: kept.data, notes: kept.notes || [] };
    // Answered within its interval: that's the answer (after a restart too).
    if (kept && !fresh(main.key) && Date.parse(kept.at) + main.keep > Date.now()) return { ...keptOut, cached: true };
    if (kept && onKept && !fresh(main.key)) onKept({ ...keptOut, refreshing: true });
    // A chart with Compare on, and a number that says its change, ask for the period before too; a chart's
    // markers are a query of their own. They don't hold the panel up if they fail.
    const before = (w.type === "chart" && view.compare) || (w.type === "metric" && w.shape?.compare === "previous") ? prepare(uid, w.query, view, previous(view)) : null;
    const marks = w.type === "chart" && w.markers ? prepare(uid, w.markers, view) : null;
    try {
      const [got, was, mk]: [Got, Got | null, Marks | null] = await Promise.all([asked(uid, main), before ? asked(uid, before).catch((): null => null) : null, marks ? asked(uid, marks).catch((e): Marks => ({ failed: e.message })) : null]);
      const notes = [...got.notes];
      const markList = mk?.frames ? markersOf(mk.frames) : null;
      if (mk?.failed) notes.push(`Its markers didn't come: ${mk.failed}`);
      const data = shapeAnswer(w, got.frames, { before: was?.frames || null, shift: view.to - view.from, marks: markList, notes });
      Object.assign(out, { at: got.at, ms: got.ms, data, notes: [...new Set(notes)], cached: !!got.cached });
      if (!got.cached || !kept || kept.at !== got.at) keep(p, w, vk, def, main.c?.id || null, vk === ownKey(p, w, uid), { at: got.at, ms: got.ms, data, notes: out.notes });
      return out;
    } catch (e) {
      const why = e.message || String(e);
      if (!e.budget) log(`dashboard ${p.id}/${w.id}: ${why}`);
      return keptOut ? { ...keptOut, stale: true, error: why } : { ...out, error: why };
    }
  }

  // A dashboard's panels for a view (`asked`: { range | from, to, vars, compare }), the ones named or all of them:
  // { view, panels }. With `onPanel`, the ones answered at once come back now, with the kept answers of the rest
  // (`refreshing`), and each of the rest goes to it when it comes (`pending` names them); without, it waits for all.
  async function run(p: Dash, asked: Asked = {}, { ids = null, onPanel = null }: { ids?: string[] | null; onPanel?: ((a: PanelAnswer) => void) | null } = {}) {
    const view = viewOf(p, asked);
    const panels = p.widgets.filter((w) => isPanel(w) && (!ids || ids.includes(w.id)));
    const said = { range: view.rel, from: new Date(view.asked.from).toISOString(), to: new Date(view.asked.to).toISOString(), interval: intervalText(view.interval), interval_ms: view.interval, past: !!view.past, vars: view.vars, compare: view.compare };
    if (!onPanel) return { view: said, panels: await Promise.all(panels.map((w) => runPanel(p, w, view))) };
    const now: PanelAnswer[] = [];
    const pending: string[] = [];
    await Promise.all(
      panels.map(async (w) => {
        let early: PanelAnswer | null = null;
        const r = runPanel(p, w, view, { onKept: (a) => (early = a) });
        const quick = await Promise.race([r, new Promise<null>((ok) => setTimeout(() => ok(null), 40))]);
        if (quick) return now.push(quick);
        pending.push(w.id);
        if (early) now.push(early);
        r.then(onPanel, (e) => onPanel({ id: w.id, error: e.message }));
      }),
    );
    return { view: said, panels: now, pending };
  }

  // What a dashboard's card on the feed and its tile in Dashboards show: each panel's last answer for its own view,
  // small (a number, a line of 24 points, a table's first rows, a list's first items), and when it came:
  // { [panel]: { at, data } }. Never asks a source.
  function face(p: Dash): Face {
    const had = faces.get(p.id);
    if (had && had.version === p.version) return had.face;
    const uid = ownerOf(p);
    const rows = tables.ownOf(p.id);
    const out: Face = {};
    for (const w of p.widgets || []) {
      if (!isPanel(w)) continue;
      const def = defOf(w);
      const own = ownKey(p, w, uid);
      const r = rows.find((x) => x.panel === w.id && x.def === def && x.view === own);
      if (!r) continue;
      try {
        out[w.id] = { at: r.at, data: small(w, unpack(r.answer).data) };
      } catch {}
    }
    faces.set(p.id, { version: p.version, face: out });
    return out;
  }

  // Tidying, at the events that change what's kept (never on a timer). A dashboard as it is now (written, or on
  // start): the answers of panels it no longer has or that ask something else go, and which view is its own is
  // said again (its range or a default may have changed).
  function tidy(p: Dash | null | undefined) {
    if (p?.kind !== "dashboard") return;
    const uid = ownerOf(p);
    const panels = new Map((p.widgets || []).filter(isPanel).map((w) => [w.id, w]));
    for (const r of tables.viewsOf(p.id)) {
      const w = panels.get(r.panel);
      if (!w || r.def !== defOf(w)) tables.drop(p.id, r.panel, r.view);
      else if (r.own !== (r.view === ownKey(p, w, uid))) tables.setOwn(p.id, r.panel, r.view, !r.own);
    }
    faces.delete(p.id);
  }
  // On start: every dashboard (`pages`, by id), the kept answers of pages gone, and other views nobody's looked at
  // for a week.
  function tidyAll(pages: Record<string, Dash> | null | undefined) {
    const ids = new Set(Object.values(pages || {}).filter((p) => p.kind === "dashboard").map((p) => p.id));
    for (const page of tables.pages()) if (!ids.has(page)) tables.dropPage(page);
    tables.dropUnused(Date.now() - KEPT_DAYS * 86400e3);
    for (const p of Object.values(pages || {})) tidy(p);
  }
  // A connector removed, or its keys changed: what it answered goes, kept and in memory.
  function dropSource(id: string) {
    tables.dropConnector(id);
    for (const [k, v] of cache) {
      if (!k.startsWith(`[${JSON.stringify(id)},`)) continue;
      cacheBytes -= v.bytes;
      cache.delete(k);
    }
    faces.clear();
  }

  // A query run once, as an agent writing one tries it (ab_source query): its frames as they came.
  // `opts`: the range (or from and to), and the variables' values, as a dashboard's view would give them.
  async function tryQuery(uid: string, q: PanelQuery, opts: TryView = {}) {
    const vars = Object.entries(opts.vars || {}).map(([id, v]): DashVar => ({ id, label: id, values: ([] as string[]).concat(v), default: v, multi: Array.isArray(v) }));
    const view = viewOf({ dash: { vars, range: "24h" } }, { range: opts.range, from: opts.from, to: opts.to, vars: opts.vars });
    const prep = prepare(uid, q, view);
    const got = await asked(uid, prep);
    return { frames: got.frames, ms: got.ms, notes: got.notes, link: connectors.link(uid, q.source, prep.ask), view: { from: new Date(view.from).toISOString(), to: new Date(view.to).toISOString(), interval: intervalText(view.interval), vars: view.vars } };
  }

  return { run, runPanel, viewOf, tryQuery, face, tidy, tidyAll, dropSource, forget: (pid: string) => (tables.dropPage(pid), faces.delete(pid)), size: () => ({ cache: cache.size, cacheBytes, ...tables.size() }) };
}

// A panel's answer, small, as a card or a tile draws it.
function small(w: Pick<Widget, "type">, d: Answer | null | undefined): WidgetData {
  if (!d || typeof d !== "object") return {};
  // A list thinned is the same kind of list.
  const thin = <A extends unknown[]>(xs: A): A => {
    if (!Array.isArray(xs) || xs.length <= FACE_POINTS) return xs;
    return Array.from({ length: FACE_POINTS }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (FACE_POINTS - 1))]) as A;
  };
  if (w.type === "metric") return { ...d, series: thin(d.series), vs: undefined };
  if (w.type === "chart") {
    // A chart's series are named lines (a metric's are its sparkline's numbers).
    const ss = (d.series || []) as ChartSeries[];
    if (d.kind === "scatter") return { kind: "scatter", series: ss.slice(0, 1).map((s) => ({ name: s.name, points: (s.points || []).slice(0, 40) })) };
    // A stacked chart's line is its total.
    if (d.kind === "stacked") return { kind: "line", series: [{ name: "total", values: thin((d.x || ss[0]?.values || []).map((_, i) => ss.reduce((t, s) => t + (Number(s.values?.[i]) || 0), 0))) }] };
    return { kind: d.kind, series: ss.slice(0, 1).map((s) => ({ name: s.name, values: thin(s.values) })) };
  }
  if (w.type === "table") return { columns: d.columns, rows: (d.rows || []).slice(0, 4) };
  if (w.type === "list") return { items: (d.items || []).slice(0, 3).map((it): WidgetItem => ({ text: it.text, name: it.name })) };
  return {};
}

// A source's events as a chart's markers: a table with time and title columns, or series' points named.
function markersOf(frames: Frame[]): { time: number; label: string }[] {
  const t = frames.find((f) => Array.isArray(f?.columns) && Array.isArray(f?.rows));
  if (!t) return [];
  const ti = t.columns.indexOf("time");
  const li = Math.max(t.columns.indexOf("title"), t.columns.indexOf("text"), t.columns.indexOf("name"));
  if (ti < 0) return [];
  return t.rows.map((r: Record<number, TableCell>) => ({ time: typeof r[ti] === "number" ? r[ti] : Date.parse(String(r[ti])), label: li >= 0 ? String(r[li] ?? "") : "" })).filter((m) => Number.isFinite(m.time));
}
