/* ---------- dashboards: pages whose panels hold queries, not numbers ---------- */

// A dashboard is a page (kind "dashboard") whose panels each hold a query and how to show its answer. The page asks
// agentbook-server for their answers (POST /api/pages/:id/panels), for the range and the variables picked here,
// which are in its address (?range=7d&service=core-api,ledger&compare=1, or from and to in ms), so a link or a
// reload keeps them. The ones that take a while come on the page's stream (`panel` events). Picking makes no version.
// dash[page]: { key (the view and version asked for), want (the one on its way), view (as the server said it),
// panels (id -> its answer, with the key it's for), pending (ids still coming), asked, got, error }.
import { useEffect } from "react";
import type { FormEvent } from "react";
import { ago, agoText, listText, webUrl } from "../../lib/format.ts";
import { onStream } from "../../lib/live.ts";
import { signedOut } from "../../lib/session.ts";
import { getApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { DashAnswers, DashView, PanelAnswer, Route } from "../../lib/types.ts";
import type { DashVar, Widget, WidgetData } from "../../../plugin/shared/types.ts";
import { Composer } from "../Composer.tsx";
import { Icon } from "../Icon.tsx";
import { WidgetCard, WidgetGrid } from "./grid.tsx";
import type { CardProps } from "./grid.tsx";
import { narrowHref, pageById, WIDTH_COLS } from "./pages.ts";
import type { PageRec } from "./pages.ts";
import { getPageUi, setPageUi, usePageUi } from "./state.ts";
import { chartNum, SERIES, WidgetBody } from "./widgets.tsx";
import type { ChartData, ChartLine } from "./widgets.tsx";

export const DASH_PANELS = ["metric", "chart", "table", "list"];
export const isPanelOf = (w: Pick<Widget, "type" | "query"> | null | undefined) => DASH_PANELS.includes(w?.type) && !!w.query;
const DASH_RANGES = [["15m", "Last 15 minutes"], ["1h", "Last hour"], ["4h", "Last 4 hours"], ["12h", "Last 12 hours"], ["24h", "Last 24 hours"], ["2d", "Last 2 days"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"]];
// A range's length in ms ("24h"), or null for one that isn't.
const rangeMs = (r: string | null | undefined) => {
  const m = String(r || "").match(/^(\d+)([mhd])$/);
  return m ? Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] : null;
};
const DASH_ALL = "*";
// A short key for a view, said back with each panel that comes on the stream.
const keyOf = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};
// What a dashboard's panels are asked for: a range ("24h"), or from and to (ms); its variables' values; and whether
// to compare with the period before.
interface DashAsk {
  range?: string;
  from?: number;
  to?: number;
  vars: Record<string, string | string[]>;
  compare: boolean;
}
// What the address asks for: a range (the dashboard's own when it says none) or from and to, the variables picked
// (a multi one's values joined by commas; one not in it is its default), and Compare.
function dashView(p: PageRec, r: Route = getApp().route): DashAsk {
  const f = r.filters || {};
  const from = Number(f.from);
  const to = Number(f.to);
  const abs = Number.isFinite(from) && Number.isFinite(to) && to - from >= 60e3;
  const range = abs ? null : DASH_RANGES.some(([k]) => k === f.range) ? f.range : p.dash?.range || "24h";
  const vars: Record<string, string | string[]> = {};
  for (const v of p.dash?.vars || []) if (f[v.id]) vars[v.id] = v.multi && f[v.id].includes(",") ? f[v.id].split(",") : f[v.id];
  return { ...(abs ? { from, to } : { range }), vars, compare: f.compare === "1" };
}
const dashKey = (p: PageRec, r: Route = getApp().route) => keyOf(`${p.version}|${JSON.stringify(dashView(p, r))}`);
// A variable's value now: what's picked, or its default. A multi one's is a list, or "*" for all of them.
function dashVar(p: PageRec, v: DashVar, r: Route = getApp().route): string | string[] {
  const got = dashView(p, r).vars[v.id];
  const ok = (x: string) => v.values.includes(x) || (v.all !== false && x === DASH_ALL);
  if (Array.isArray(got)) {
    const xs = got.filter(ok);
    return xs.length ? (xs.includes(DASH_ALL) ? DASH_ALL : xs) : (v.default ?? DASH_ALL);
  }
  return got != null && ok(got) ? (v.multi && got !== DASH_ALL ? [got] : got) : v.multi && v.default !== DASH_ALL && v.default != null ? ([] as string[]).concat(v.default) : (v.default ?? DASH_ALL);
}
// Change what's asked, in the address: null takes a key out (its default again).
function dashSet(p: PageRec, changes: Record<string, string | number | string[] | null>) {
  const r = getApp().route;
  const f: Record<string, string> = { ...(r.filters || {}) };
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === "") delete f[k];
    else f[k] = Array.isArray(v) ? v.join(",") : String(v);
  }
  setPageUi({ dashPick: false });
  location.hash = narrowHref(p, f, r);
}
const setDash = (id: string, fn: (L: DashAnswers) => Partial<DashAnswers>) =>
  setPageUi((s) => {
    const L = s.dash[id] || { panels: {}, pending: new Set<string>() };
    return { dash: { ...s.dash, [id]: { ...L, ...fn(L) } } };
  });

// Ask for a dashboard's panels' answers, for the view in the address. What comes after a newer ask is dropped.
export async function loadDash(p: PageRec) {
  const view = dashView(p);
  const key = dashKey(p);
  setDash(p.id, () => ({ want: key, asked: Date.now() }));
  let res: Response | null = null;
  let data: { error?: string; view?: DashView; panels?: PanelAnswer[]; pending?: string[] } = {};
  try {
    res = await fetch(`/api/pages/${encodeURIComponent(p.id)}/panels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...view, live: getApp().liveId || undefined, key }) });
    data = await res.json().catch(() => ({}));
  } catch {}
  if (getPageUi().dash[p.id]?.want !== key) return;
  if (res?.status === 401) return signedOut();
  if (!res?.ok) return setDash(p.id, () => ({ got: Date.now(), error: !res ? "agentbook can't be reached." : data.error || `agentbook couldn't ask for its panels (HTTP ${res.status}).` }));
  setDash(p.id, (L) => {
    const panels = { ...L.panels };
    for (const a of data.panels || []) panels[a.id] = { ...a, key };
    return { got: Date.now(), error: null, key, view: data.view, panels, pending: new Set(data.pending || []) };
  });
}
// A panel answered, on the page's stream: the view it was asked for is the one shown, or it's dropped.
onStream("panel", (raw) => {
  const d = raw as { page?: string; key?: string; panel?: PanelAnswer };
  const L = d.page ? getPageUi().dash[d.page] : null;
  if (!L || d.key !== L.key || !d.panel?.id) return;
  setDash(d.page, (x) => {
    const pending = new Set(x.pending);
    pending.delete(d.panel.id);
    return { panels: { ...x.panels, [d.panel.id]: { ...d.panel, key: d.key } }, pending };
  });
});
// A dashboard as its tile in Dashboards and its card on the feed draw it: its panels with the answers the page has
// for them, else the last ones of its own view that agentbook-server kept (`face`, small), without asking.
export const dashFace = (p: PageRec, L: DashAnswers | undefined = getPageUi().dash[p.id]): PageRec => ({ ...p, widgets: (p.widgets || []).map((w) => (isPanelOf(w) ? { ...w, data: L?.panels[w.id]?.data || p.face?.[w.id]?.data || {} } : w)) });

// It asks when the dashboard opens and when what's asked changes; again, while the tab shows, as often as its
// answers are kept (its interval, 30 s to 5 min), and never for a range wholly in the past.
function useDashPoll(id: string) {
  useEffect(() => {
    const tick = () => {
      const r = getApp().route;
      if (r.name !== "page" || r.tab !== "page" || r.id !== id) return;
      const p = pageById(id);
      if (p?.kind !== "dashboard") return;
      const L = getPageUi().dash[p.id];
      if (!L || L.want !== dashKey(p, r)) return void loadDash(p);
      if (document.visibilityState !== "visible" || L.got == null || L.got < L.asked) return;
      const every = L.view?.past ? Infinity : Math.min(Math.max(L.view?.interval_ms || 60e3, 30e3), 300e3);
      if (Date.now() - L.asked >= every || (L.pending.size && Date.now() - L.asked > 45e3)) loadDash(p);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [id]);
}

// The names of the sources its panels ask, as they answered (or as their queries name them, before they have).
const dashSources = (p: PageRec, L: DashAnswers | undefined) => [...new Set((p.widgets || []).filter(isPanelOf).map((w) => L?.panels[w.id]?.source?.name || w.query.source))];
const SrcLogo = ({ name }: { name: string }) => (
  <span className="pn-lg" style={{ "--lg": /datadog/i.test(name) ? "#632ca6" : /posthog/i.test(name) ? "#f54e00" : "var(--ink-3)" } as React.CSSProperties}>
    {String(name || "?")[0].toUpperCase()}
  </span>
);
// "Nov 3, 14:00", short, for a range's ends.
const dashWhen = (t: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};
// For a datetime-local input: the time here, to the minute.
const localInput = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);

// The bar that stays on top: the range (and every how long a point), ‹ › to move it by its length, Compare, how
// fresh it is and refresh, then its variables.
function DashBar({ p }: { p: PageRec }) {
  const r = useApp((s) => s.route);
  const L = usePageUi((s) => s.dash[p.id]);
  const pick = usePageUi((s) => s.dashPick);
  const v = dashView(p, r);
  const now = Date.now();
  const span = v.range ? rangeMs(v.range) : v.to - v.from;
  const [from, to] = v.range ? [now - span, now] : [v.from, Math.min(v.to, now)];
  const label = v.range ? DASH_RANGES.find(([k]) => k === v.range)?.[1] || v.range : `${dashWhen(from)} to ${dashWhen(to)}`;
  const going = !!L && L.want !== L.key;
  const coming = going || !!L?.pending?.size;
  const names = dashSources(p, L);
  const fresh = !L ? "Asking…" : L.error ? <span className="task-err">{L.error}</span> : coming ? `Asking ${listText(names)}…` : L.got ? `Updated ${agoText(new Date(L.got).toISOString())}` : "";
  const later = !v.range && to < now - 60e3;
  // ‹ and ›: the range moved back or on by its length. Moved back to now, it's the range it was again.
  const shift = (by: number) => {
    const at = Date.now();
    const start = (v.range ? at - span : v.from) + by * span;
    const end = start + span;
    const named = DASH_RANGES.find(([k]) => rangeMs(k) === span)?.[0] || null;
    if (end >= at - 60e3) return dashSet(p, { range: named, from: named ? null : at - span, to: named ? null : at });
    dashSet(p, { range: null, from: Math.round(start), to: Math.round(end) });
  };
  // From and To, typed.
  const abs = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const a = new Date(String(f.get("from"))).getTime();
    const b = new Date(String(f.get("to"))).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < 60e3) return toast("From comes at least a minute before To.");
    dashSet(p, { range: null, from: a, to: Math.min(b, Date.now()) });
  };
  // A variable's value picked: a multi one's adds or drops it; its default again takes it out of the address.
  const pickVar = (x: DashVar, val: string) => {
    const cur = dashVar(p, x, r);
    let next: string | string[] = val;
    if (x.multi && val !== DASH_ALL) {
      const list = cur === DASH_ALL ? [] : ([] as string[]).concat(cur);
      next = list.includes(val) ? list.filter((y) => y !== val) : [...list, val];
      if (!next.length) next = x.all !== false ? DASH_ALL : [val];
    }
    const same = JSON.stringify(next) === JSON.stringify(x.multi && x.default !== DASH_ALL && x.default != null ? ([] as string[]).concat(x.default) : (x.default ?? DASH_ALL));
    dashSet(p, { [x.id]: same ? null : next });
  };
  const vars = (p.dash?.vars || []).map((x) => {
    const cur = dashVar(p, x, r);
    const on = (val: string) => (val === DASH_ALL ? cur === DASH_ALL : Array.isArray(cur) ? cur.includes(val) : cur === val);
    const btn = (val: string, text: string) => (
      <button key={val} className="btn btn--line" type="button" aria-pressed={on(val)} onClick={() => pickVar(x, val)}>
        {text}
      </button>
    );
    // Many values: a menu, not a row of buttons.
    if (x.values.length > 10)
      return (
        <label key={x.id} className="db-var">
          <span>{x.label || x.id}</span>
          <select value={cur === DASH_ALL ? DASH_ALL : Array.isArray(cur) ? cur[0] : cur} onChange={(e) => dashSet(p, { [x.id]: e.target.value === String(x.default ?? DASH_ALL) ? null : e.target.value })}>
            {x.all !== false ? <option value={DASH_ALL}>All</option> : null}
            {x.values.map((val) => (
              <option key={val} value={val}>
                {val}
              </option>
            ))}
          </select>
        </label>
      );
    return (
      <span key={x.id} className="db-var">
        <span>{x.label || x.id}</span>
        {x.all !== false ? btn(DASH_ALL, "All") : null}
        {x.values.map((val) => btn(val, val))}
      </span>
    );
  });
  return (
    <div className="db-bar">
      <span className="db-range">
        <button className="btn btn--line" type="button" data-dash-pick aria-expanded={!!pick} onClick={() => setPageUi({ dashPick: !pick, pnMenu: null })}>
          <Icon name="clock" />
          {label}
          {L?.view?.interval ? <span className="db-span">every {L.view.interval}</span> : null}
          <Icon name="down" />
        </button>
        {pick ? (
          <div className="fb-menu db-pick" role="dialog" aria-label="Time range">
            {DASH_RANGES.map(([k, l]) => (
              <button key={k} className={`fb-row${v.range === k ? " is-on" : ""}`} type="button" onClick={() => dashSet(p, { range: k === (p.dash?.range || "24h") ? null : k, from: null, to: null })}>
                <span>{l}</span>
                <small>{k}</small>
              </button>
            ))}
            <hr />
            <form className="db-abs" onSubmit={abs}>
              <label>
                From
                <input type="datetime-local" name="from" defaultValue={localInput(from)} required />
              </label>
              <label>
                To
                <input type="datetime-local" name="to" defaultValue={localInput(to)} required />
              </label>
              <button className="btn btn--sm btn--dark" type="submit">
                Show it
              </button>
            </form>
            <p className="db-tip">Or drag across a chart to zoom in.</p>
          </div>
        ) : null}
      </span>
      <span className="db-shift">
        <button className="btn btn--line" type="button" aria-label="Earlier" title={`Earlier, by ${label.replace(/^Last /, "")}`} onClick={() => shift(-1)}>
          <Icon name="back" />
        </button>
        <button className="btn btn--line" type="button" aria-label="Later" title="Later" disabled={!later} onClick={() => shift(1)}>
          <Icon name="next" />
        </button>
      </span>
      <button className="btn btn--line db-cmp" type="button" aria-pressed={v.compare} title="Draw the period before too, dashed" onClick={() => dashSet(p, { compare: v.compare ? null : "1" })}>
        Compare
      </button>
      <span className="db-gap" />
      <span className={`db-fresh${coming ? " is-spin" : ""}`}>
        <span>{fresh}</span>
        <button className="btn btn--line" type="button" aria-label="Refresh now" title="Ask again now" onClick={() => void loadDash(p)}>
          <Icon name="sync" />
        </button>
      </span>
      {vars.length ? <div className="db-vars">{vars}</div> : null}
    </div>
  );
}

// A panel's answer as its widget draws it: each series in its variable's colour (a service keeps its colour whatever
// you pick), the period before dashed, thresholds named, its times on the axis as the range suits.
function dashData(p: PageRec, w: Widget, d: WidgetData): ChartData {
  if (w.type === "metric") {
    const t = w.thresholds || {};
    const lower = t.bad != null && t.warn != null && t.bad < t.warn;
    const at = d.status === "bad" ? t.bad : d.status === "warn" ? t.warn : null;
    // Past a threshold, which; within them, the one it's within.
    const unit = d.unit ? ` ${d.unit}` : "";
    if (d.status && d.status !== "ok" && at != null) return { ...d, status: { status: d.status as "warn" | "bad", text: `${lower ? "under" : "over"} ${chartNum(at)}${unit}` } } as ChartData;
    const near = t.warn ?? t.bad;
    return (d.status === "ok" && near != null ? { ...d, status: { status: "ok", text: `${lower ? "over" : "under"} ${chartNum(near)}${unit}` } } : d) as ChartData;
  }
  if (w.type !== "chart") return d as ChartData;
  const c = d as ChartData & { series?: { name?: string; before?: boolean; values?: (number | null)[] }[] };
  const base = (n: unknown) => String(n).replace(/ \(before\)$/, "");
  const firsts: string[] = [];
  const color = (n: unknown) => {
    const v = (p.dash?.vars || []).find((x) => x.values.includes(base(n)));
    if (v) return SERIES[v.values.indexOf(base(n)) % SERIES.length];
    if (!firsts.includes(base(n))) firsts.push(base(n));
    return (c.series || []).filter((s) => !s.before).length === 1 ? "var(--hue)" : SERIES[firsts.indexOf(base(n)) % SERIES.length];
  };
  // The period before is a dashed line; bars and stacks don't draw it.
  const lines = !c.kind || c.kind === "line";
  const series = (c.series || []).filter((s) => lines || !s.before).map((s) => ({ ...s, color: color(s.name), dash: !!s.before }));
  const t = w.thresholds || {};
  const unit = c.unit ? ` ${c.unit}` : "";
  const target: ChartLine | null = t.bad != null ? { value: t.bad, label: `bad ${chartNum(t.bad)}${unit}`, tone: "bad" } : t.warn != null ? { value: t.warn, label: `warn ${chartNum(t.warn)}${unit}`, tone: "warn" } : null;
  const target2: ChartLine | null = t.bad != null && t.warn != null ? { value: t.warn, label: `warn ${chartNum(t.warn)}${unit}`, tone: "warn" } : null;
  const times = c.times || [];
  const span = times.length > 1 ? times.at(-1) - times[0] : 0;
  const axis = times.map((ms) => {
    const at = new Date(ms);
    return span <= 2 * 86400e3 ? at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
  return { ...c, series: series as ChartData["series"], target, target2, axis, zoom: p.id };
}

// A panel: its title, where it's from and how old its answer is, a menu (open it there, its query, copy it), and
// its answer drawn as its widget, or why there's none. An old answer stays, dimmed, while the new view's comes; one
// its source failed to renew stays greyed, saying so.
export function DashCard(props: CardProps) {
  const { p, w, stacked = false } = props;
  const L = usePageUi((s) => s.dash[p.id]);
  const menuOpen = usePageUi((s) => s.pnMenu === `${p.id}/${w.id}`);
  const queryOpen = usePageUi((s) => s.pnQuery === `${p.id}/${w.id}`);
  if (!isPanelOf(w)) return <WidgetCard {...props} />;
  const a = L?.panels[w.id] || null;
  const old = !!a && a.key !== L.key;
  const coming = old || !a || !!L?.pending?.has(w.id);
  const src = a?.source?.name || w.query.source;
  const id = `${p.id}/${w.id}`;
  const data = a?.data ? dashData(p, w, a.data) : null;
  const note =
    a?.error && a.stale ? (
      <p className="pn-note pn-note--off">
        <Icon name="clock" />
        <span>
          {String(a.error).replace(/([^.])$/, "$1.")} Showing its answer from {agoText(a.at)}.
        </span>
      </p>
    ) : a?.error ? (
      <p className="pn-note pn-note--bad">
        <Icon name="alert" />
        <span>{a.error}</span>
      </p>
    ) : (a?.notes || []).length ? (
      <p className="pn-note">
        <Icon name="lines" />
        <span>{a.notes.join(" ")}</span>
      </p>
    ) : null;
  const body = data ? <WidgetBody w={{ ...w, data }} onZoom={(from, to) => dashSet(p, { range: null, from, to })} /> : a?.error ? null : <p className="muted pn-wait">Asking {src}…</p>;
  // Copy its answer as CSV.
  const csv = () => {
    setPageUi({ pnMenu: null });
    if (a?.data) navigator.clipboard?.writeText(panelCsv(w, a.data)).then(() => toast(`Copied ${w.title || "it"} as CSV.`), () => toast("This browser wouldn't copy it."));
  };
  const menu = menuOpen ? (
    <div className="fb-menu pn-menu" role="menu">
      {webUrl(a?.link) ? (
        <a className="fb-row" href={a.link} target="_blank" rel="noopener" role="menuitem">
          <Icon name="external" />
          <span>Open in {src}</span>
        </a>
      ) : null}
      <button className="fb-row" type="button" role="menuitem" onClick={() => setPageUi({ pnQuery: queryOpen ? null : id, pnMenu: null })}>
        <Icon name="code" />
        <span>{queryOpen ? "Hide its query" : "Its query"}</span>
      </button>
      {data ? (
        <button className="fb-row" type="button" role="menuitem" onClick={csv}>
          <Icon name="copy" />
          <span>Copy as CSV</span>
        </button>
      ) : null}
    </div>
  ) : null;
  const tip = `From ${src}${a?.at ? `, ${agoText(a.at)}` : ""}${a?.ms != null ? `, in ${a.ms} ms` : ""}${a?.refreshing ? `; asking ${src} again` : a?.cached ? ", kept from a moment ago" : ""}`;
  const bad = w.type === "metric" && a?.data?.status === "bad" && !a.stale;
  return (
    <section className={`card wg wg--${w.type} pn${coming && a ? " is-loading" : ""}${a?.stale ? " is-stale" : ""}${bad ? " is-alert" : ""}`} data-span={stacked ? undefined : WIDTH_COLS[w.width] || 6} data-wid={w.id}>
      <header className="wg-h">
        <h3>{w.title || ""}</h3>
        <span className="pn-src" title={tip}>
          <SrcLogo name={src} />
          <span className="pn-nm">{src}</span>
          {a?.at ? <span className={`pn-age${a.stale ? " is-old" : ""}`}>{ago(a.at) === "now" ? "now" : ago(a.at)}</span> : null}
        </span>
        <button className="icon-btn pn-more" type="button" data-pn-menu aria-expanded={menuOpen} aria-label="Its menu" title={`Open it in ${src}, see its query, copy it`} onClick={() => setPageUi({ pnMenu: menuOpen ? null : id, dashPick: false })}>
          <Icon name="dots" />
        </button>
        {menu}
      </header>
      {note}
      <div className="pn-in">{body}</div>
      {queryOpen ? <PanelQuery p={p} w={w} L={L} /> : null}
    </section>
  );
}
const queryText = (q: Widget["query"]) => (q.queries ? `${Object.entries(q.queries).map(([k, t]) => `${k} = ${t}`).join("\n")}${q.formula ? `\n${q.formula}` : ""}` : q.text || "");
// What a panel asks, in its source's language, and what's filled in for whoever's looking.
function PanelQuery({ p, w, L }: { p: PageRec; w: Widget; L: DashAnswers | undefined }) {
  const r = useApp((s) => s.route);
  const q = w.query || ({} as Widget["query"]);
  const text = queryText(q);
  const more = [q.compute && `compute ${q.compute}`, q.by && `by ${q.by}`, q.limit && `limit ${q.limit}`, q.sort && `sort ${q.sort}`].filter(Boolean).join(" · ");
  const vars = (p.dash?.vars || []).filter((v) => text.includes(`$${v.id}`) || text.includes(`\${${v.id}}`));
  const filled = vars.map((v) => {
    const cur = dashVar(p, v, r);
    return (
      <span key={v.id}>
        <code>${v.id}</code> {cur === DASH_ALL ? `every ${v.label || v.id}` : ([] as string[]).concat(cur).join(", ")}
      </span>
    );
  });
  if (L?.view?.interval)
    filled.unshift(
      <span key="$interval">
        <code>$interval</code> {L.view.interval}
      </span>,
    );
  return (
    <div className="pn-q">
      <p className="pn-q-h">
        {L?.panels[w.id]?.source?.name || q.source} · {q.lang || ""}
      </p>
      <pre>{text}</pre>
      {more ? <p className="pn-q-more">{more}</p> : null}
      {w.markers ? (
        <>
          <p className="pn-q-h">
            Markers, from {w.markers.source} · {w.markers.lang || ""}
          </p>
          <pre>{w.markers.text || ""}</pre>
        </>
      ) : null}
      {filled.length ? (
        <p className="pn-q-vars">
          Filled in now: {filled.flatMap((x, i) => (i ? [" · ", x] : [x]))}
        </p>
      ) : null}
      <p className="muted pn-q-why">It runs on agentbook-server through {p.mine ? "your" : `@${p.owner || "its owner"}'s`} connector, which only reads. An agent changes it, and each change is a version.</p>
    </div>
  );
}
// A panel's answer as CSV: a chart's times and series, a table's rows, a list's items, a number.
function panelCsv(w: Widget, d: WidgetData) {
  const cell = (v: unknown) => {
    const t = v && typeof v === "object" ? ((v as { text?: unknown; value?: unknown }).text ?? (v as { value?: unknown }).value ?? "") : (v ?? "");
    return /[",\n]/.test(String(t)) ? `"${String(t).replace(/"/g, '""')}"` : String(t);
  };
  const series = (d.series || []) as { name?: string; values?: (number | null)[] }[];
  const rows: unknown[][] =
    w.type === "chart"
      ? [["time", ...series.map((s) => s.name)], ...(d.x || []).map((x, i) => [x, ...series.map((s) => s.values?.[i])])]
      : w.type === "table"
        ? [d.columns || [], ...(d.rows || [])]
        : w.type === "list"
          ? [["text", "sub", "status"], ...(d.items || []).map((it) => [it.text, it.sub, it.label || it.status])]
          : [["value", "unit"], [d.value, d.unit]];
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}
// An older version's panel: what it asked then (an answer is only ever for now).
export function OldPanelCard(props: CardProps) {
  const { w, stacked = false } = props;
  if (!isPanelOf(w)) return <WidgetCard {...props} latest={false} />;
  const q = w.query || ({} as Widget["query"]);
  return (
    <section className={`card wg wg--${w.type} pn`} data-span={stacked ? undefined : WIDTH_COLS[w.width] || 6} data-wid={w.id}>
      <header className="wg-h">
        <h3>{w.title || ""}</h3>
        <span className="pn-src">
          <SrcLogo name={q.source} />
          {q.source}
        </span>
      </header>
      <div className="pn-q">
        <p className="pn-q-h">{q.lang || ""}</p>
        <pre>{queryText(q)}</pre>
      </div>
    </section>
  );
}

// In its head, how it stands, from the answers shown: its numbers past their thresholds, and the panels that didn't
// answer. (Alerts, with their threads, come later.)
export function DashChips({ p }: { p: PageRec }) {
  const L = usePageUi((s) => s.dash[p.id]);
  if (!L) return null;
  const panels = (p.widgets || []).filter(isPanelOf);
  const bad = panels.filter((w) => w.type === "metric" && L.panels[w.id]?.data?.status === "bad" && !L.panels[w.id].stale);
  const failed = panels.filter((w) => L.panels[w.id]?.error);
  return (
    <>
      {bad.length ? (
        <span className="chip chip--err">
          <Icon name="alert" />
          {bad.length === 1 ? `${bad[0].title || "A number"} is past its threshold` : `${bad.length} numbers past their thresholds`}
        </span>
      ) : null}
      {failed.length ? (
        <span className="chip">
          <Icon name="clock" />
          {failed.length === 1 ? `${failed[0].title || "A panel"} didn't answer` : `${failed.length} panels didn't answer`}
        </span>
      ) : null}
    </>
  );
}

// The dashboard, as it is: the bar, the box that asks its agents to change it, and its panels. A click anywhere but
// on them closes the range's menu and a panel's.
export function DashTab({ p, bar = false }: { p: PageRec; bar?: boolean }) {
  useDashPoll(p.id);
  const open = usePageUi((s) => s.dashPick || !!s.pnMenu);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!t.closest?.(".db-pick, .pn-menu, [data-dash-pick], [data-pn-menu]")) setPageUi({ dashPick: false, pnMenu: null });
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const inner = (
    <>
      <DashBar p={p} />
      {/* Its placeholder was "Ask about <title>, or to add or change a panel…" (the old composer's `box`). */}
      {!bar && p.can_edit && !p.archived ? <Composer page={p.id} box={`Ask about ${p.title}, or to add or change a panel…`} /> : null}
      {!p.widgets.length ? (
        <section className="card empty-card">
          <h2>No panels yet</h2>
          <p>{p.can_edit ? "Ask an agent above to add some: it finds what your connectors answer, writes a query for each panel and runs it before saving." : "Its contributors haven't added any yet."}</p>
        </section>
      ) : (
        <WidgetGrid p={p} widgets={p.widgets} card={DashCard} />
      )}
    </>
  );
  return bar ? <div className="pg-dash">{inner}</div> : <div className="pg-body pg-dash">{inner}</div>;
}
