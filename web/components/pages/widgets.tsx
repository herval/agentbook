// A page's widgets, drawn: a number, a chart, a table, a list, options, a link, text, a diagram, a filter, and a widget
// of its own in a sandboxed frame. The page, a dashboard's panels, a thread's attachments and its reply shapes all
// draw theirs with these (app.ts's "widgets").
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { webUrl } from "../../lib/format.ts";
import { picUrl } from "../../lib/markdown.ts";
import { getApp } from "../../lib/store.ts";
import type { ChartSeries, Status, TableCell, Text, Widget, WidgetData } from "../../../plugin/shared/types.ts";
import { sortsAsNumber, tableBars, tableOrder, tableSort } from "../../lib/visual.ts";
import type { DiagramIn } from "../../lib/visual.ts";
import { Diagram } from "../visual/Diagram.tsx";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { periodLabel, dateLabel } from "./pages.ts";
import { setPageUi, usePageUi } from "./state.ts";

// A chart's series as the page draws it: its color, and dashed (a dashboard's period before).
export type DrawnSeries = ChartSeries & { color?: string; dash?: boolean };
export type ChartLine = { value: number; label?: Text; tone?: string };
// What a chart draws, a dashboard's too: its x's times, what its axis says, and the dashboard it zooms.
export type ChartData = Omit<WidgetData, "series" | "target"> & { series?: DrawnSeries[] | (number | null)[]; target?: ChartLine | null; target2?: ChartLine | null; axis?: string[]; times?: number[]; zoom?: string };

const ST: Record<string, string> = { ok: "✓", warn: "!", bad: "×", idle: "–" };
export const StBadge = ({ st, text }: { st: Status | string; text?: Text | null }) => (
  <span className={`st st--${ST[st] ? st : "idle"}`}>
    <i>{ST[st] || "–"}</i>
    {text ?? ""}
  </span>
);
// A long link or path may break anywhere, so its table fits its widget; words stay whole.
export const CellText = ({ s }: { s: unknown }) => (
  <>
    {String(s ?? "")
      .split(/(\s+)/)
      .map((t, i) =>
        /[^-]{24}/.test(t) ? (
          <span className="cell-long" key={i}>
            {t}
          </span>
        ) : (
          t
        ),
      )}
  </>
);
export function Cell({ c }: { c: TableCell | unknown }) {
  if (c && typeof c === "object") {
    if ("meter" in c) {
      const n = Math.max(0, Math.min(100, Number((c as { meter: number }).meter) || 0));
      return (
        <span className="meter">
          <span>
            <b className={n < 25 ? "low" : ""} style={{ width: `${n}%` }} />
          </span>
          <em>{Math.round(n)}%</em>
        </span>
      );
    }
    const o = c as { status?: Status; text?: Text };
    if (o.status) return <StBadge st={o.status} text={o.text} />;
    return <CellText s={o.text} />;
  }
  return <CellText s={c} />;
}
const looksNumeric = (v: unknown) => /^[\s$€£+\-−]*[\d.,]+\s*[%kKmMbB]?$/.test(String(v ?? ""));

export function Spark({ series }: { series: unknown[] | null | undefined }) {
  const nums = (series || []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min || 1;
  const pts = nums.map((n, i) => `${(i / (nums.length - 1)) * 240},${28 - ((n - min) / span) * 26}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 240 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="var(--hue)" strokeWidth="2" vectorEffect="non-scaling-stroke" points={pts} />
    </svg>
  );
}

// A number: big, its unit, its change (green when it went the good way), what it's compared to, a badge, a sparkline.
export function WMetric({ d }: { d: WidgetData }) {
  const change = d.change != null ? String(d.change) : "";
  const up = /^\s*\+/.test(change) || /\bup\b|more|higher/i.test(change);
  const down = /^\s*[−-]/.test(change) || /\bdown\b|less|lower/i.test(change);
  const good = d.good && (up || down) ? (d.good === "up") === up : null;
  const st = d.status as { status?: Status; text?: string } | Status | undefined;
  const status = st ? <StBadge st={typeof st === "object" ? st.status : st} text={typeof st === "object" ? st.text || "" : ""} /> : null;
  return (
    <>
      <div className="big">
        {d.value ?? "–"}
        {d.unit ? <small>{d.unit}</small> : null}
      </div>
      {change || d.vs ? (
        <p className="sub">
          {change ? (
            <>
              <span className={good == null ? "" : good ? "good" : "bad"}>{change}</span>{" "}
            </>
          ) : null}
          {d.vs || ""}
        </p>
      ) : null}
      {status ? <p className="sub">{status}</p> : null}
      <Spark series={d.series as unknown[]} />
    </>
  );
}

// Charts: thin lines (or bars) on a quiet grid, a legend and end labels when there's more than one series, and a
// crosshair with every value on hover. Colors in a fixed order; one series wears the page's color.
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
function niceTicks(lo: number, hi: number, n = 4) {
  if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}
export const chartNum = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(+Number(v).toFixed(2)));
export const chartSeriesHas = (s: ChartSeries) => (s.values || []).some((v) => v != null) || (s.points || []).length > 0;
// Its legend, when it has more than one series.
function Legend({ series, color }: { series: DrawnSeries[]; color: (i: number) => string }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s, i) => (
        <span key={i}>
          <i className={s.dash ? "dash" : undefined} style={s.dash ? { borderColor: color(i) } : { background: color(i) }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}
function Target({ t, unit, x1, x2, py }: { t: ChartLine | null | undefined; unit: Text | undefined; x1: number; x2: number; py: (v: number) => number }) {
  const tv = Number(t?.value);
  if (t?.value == null || !Number.isFinite(tv)) return null;
  return (
    <g className={`slo${t.tone ? ` slo--${t.tone}` : ""}`}>
      <line x1={x1} x2={x2} y1={py(tv)} y2={py(tv)} />
      <text x={x1 + 6} y={py(tv) - 6}>
        {t.label || `Target ${chartNum(tv)}${unit ? ` ${unit}` : ""}`}
      </text>
    </g>
  );
}
function Marker({ label, cx, right, top, bottom }: { label?: Text; cx: number; right: boolean; top: number; bottom: number }) {
  return (
    <g className="mkr">
      <line x1={cx} x2={cx} y1={top} y2={bottom} />
      <circle cx={cx} cy={top + 3} r="3.5" />
      {label ? (
        <text x={cx + (right ? -7 : 7)} y={top + 7} textAnchor={right ? "end" : "start"}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

// What the crosshair needs of a chart (the old data-lc): its box, its x labels and series, and a scatter's points.
interface Geo {
  W: number;
  H: number;
  L?: number;
  R?: number;
  T?: number;
  B?: number;
  bar?: boolean;
  stacked?: boolean;
  unit: Text;
  x?: string[];
  series: { name: Text; color: string; values?: (number | null)[] }[];
  t?: number[];
  scatter?: boolean;
  pts?: [number, number, number, number, number, Text][];
  xunit?: Text;
}
// A chart's box: its svg, the crosshair (or a scatter's ring) and its tip on hover, and on a dashboard's chart,
// dragging across it zooms in (`onZoom`: from and to, in ms).
function Lc({ geo, title, zoom, onZoom, body, ends }: { geo: Geo; title?: Text; zoom?: string; onZoom?: (from: number, to: number) => void; body: ReactNode; ends: ReactNode }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hov, setHov] = useState<{ cx: number; cy?: number; color?: string; tip: ReactNode; left: number; width: number } | null>(null);
  const [band, setBand] = useState<{ x: number; w: number } | null>(null);
  // The tip sits beside the crosshair: to its left past 60% of the way across.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!hov || !tip) return;
    tip.style.left = `${hov.left > hov.width * 0.6 ? hov.left - tip.offsetWidth - 12 : hov.left + 12}px`;
  }, [hov]);
  // The values at the point under the pointer; on a scatter, the point nearest it.
  const move = (e: React.MouseEvent) => {
    const d = geo;
    const r = svgRef.current.getBoundingClientRect();
    const xv = ((e.clientX - r.left) / r.width) * d.W;
    const at = (cx: number) => ({ left: (cx / d.W) * r.width, width: r.width });
    if (d.scatter) {
      const yv = ((e.clientY - r.top) / r.height) * d.H;
      const near = d.pts.reduce((best, p) => {
        const dist = (p[0] - xv) ** 2 + (p[1] - yv) ** 2;
        return dist < best.dist ? { p, dist } : best;
      }, { p: null, dist: 24 ** 2 }).p;
      if (!near) return setHov(null);
      const [cx, cy, si, x, y, label] = near;
      const s = d.series[si];
      const tip = (
        <>
          <b>{label || s.name}</b>
          {label && d.series.length > 1 ? (
            <p>
              <i style={{ background: s.color }} />
              {s.name}
            </p>
          ) : null}
          <p>
            x<em>{`${chartNum(x)}${d.xunit ? ` ${d.xunit}` : ""}`}</em>
          </p>
          <p>
            y<em>{`${chartNum(y)}${d.unit ? ` ${d.unit}` : ""}`}</em>
          </p>
        </>
      );
      return setHov({ cx, cy, color: s.color, tip, ...at(cx) });
    }
    const n = d.x.length;
    const span = d.W - d.L - d.R;
    const i = Math.max(0, Math.min(n - 1, d.bar ? Math.floor(((xv - d.L) / span) * n) : Math.round(((xv - d.L) / span) * (n - 1))));
    const cx = d.bar ? d.L + ((i + 0.5) * span) / n : d.L + (n === 1 ? span / 2 : (i * span) / (n - 1));
    const unit = d.unit ? ` ${d.unit}` : "";
    const rows = d.series.map((s) => ({ ...s, v: s.values[i] })).filter((s) => s.v != null);
    // Stacked, its parts top to bottom as they're drawn, and their total.
    if (d.stacked) rows.reverse();
    else rows.sort((a, b) => b.v - a.v);
    const tip = (
      <>
        <b>{d.x[i]}</b>
        {rows.map((s, k) => (
          <p key={k}>
            <i style={{ background: s.color }} />
            {s.name}
            <em>{`${chartNum(s.v)}${unit}`}</em>
          </p>
        ))}
        {d.stacked ? (
          <p className="lc-tot">
            Total<em>{`${chartNum(rows.reduce((t, s) => t + s.v, 0))}${unit}`}</em>
          </p>
        ) : null}
      </>
    );
    setHov({ cx, tip, ...at(cx) });
  };
  // Dragging across a dashboard's chart zooms in: the range becomes the times dragged over.
  const down = (e: React.MouseEvent) => {
    const d = geo;
    if (!zoom || !onZoom || e.button !== 0 || !d.t?.length || d.t.length < 2) return;
    const r = svgRef.current.getBoundingClientRect();
    const toX = (cx: number) => Math.max(d.L, Math.min(d.W - d.R, ((cx - r.left) / r.width) * d.W));
    const x0 = toX(e.clientX);
    let x1 = x0;
    setBand({ x: x0, w: 0 });
    const mv = (ev: MouseEvent) => {
      x1 = toX(ev.clientX);
      setBand({ x: Math.min(x0, x1), w: Math.abs(x1 - x0) });
    };
    const up = () => {
      removeEventListener("mousemove", mv);
      removeEventListener("mouseup", up);
      setBand(null);
      if (Math.abs(x1 - x0) < 8) return;
      const n = d.t.length;
      const span = d.W - d.L - d.R;
      const at = (xv: number) => Math.max(0, Math.min(n - 1, d.bar ? Math.floor(((xv - d.L) / span) * n) : Math.round(((xv - d.L) / span) * (n - 1))));
      const [i, j] = [at(Math.min(x0, x1)), at(Math.max(x0, x1))];
      if (j > i && d.t[j] - d.t[i] >= 60e3) onZoom(d.t[i], d.t[j]);
    };
    addEventListener("mousemove", mv);
    addEventListener("mouseup", up);
    e.preventDefault();
  };
  return (
    <div className={`lc${hov ? " is-hover" : ""}`} data-zoom={zoom || undefined} title={zoom ? "Drag across it to zoom in" : undefined} onMouseMove={move} onMouseLeave={() => setHov(null)} onMouseDown={down}>
      <svg ref={svgRef} viewBox={`0 0 ${geo.W} ${geo.H}`} role="img" aria-label={String(title || "Chart")}>
        {body}
        {geo.scatter ? null : <line className="cross" x1={hov?.cx ?? 0} x2={hov?.cx ?? 0} y1={geo.T} y2={geo.H - geo.B} visibility={hov ? "visible" : "hidden"} />}
        <g className="end">{ends}</g>
        {geo.scatter ? <circle className="ring" r="8" cx={hov?.cx} cy={hov?.cy} stroke={hov?.color} visibility={hov ? "visible" : "hidden"} /> : null}
        {band ? <rect className="zoom" y={geo.T} height={geo.H - geo.T - geo.B} x={band.x} width={band.w} /> : null}
      </svg>
      <div className="lc-tip" ref={tipRef} hidden={!hov}>
        {hov?.tip}
      </div>
    </div>
  );
}

// A chart: lines over its x labels (the default), bars side by side ("bar") or stacked, each series a part of its x's
// total ("stacked"), or a dot for each point, numbers on both axes ("scatter").
export function WChart({ d, title, onZoom }: { d: ChartData; title?: Text; onZoom?: (from: number, to: number) => void }) {
  if (d.kind === "scatter") return <WScatter d={d} title={title} />;
  const x = d.x || [];
  const series = ((d.series || []) as DrawnSeries[]).filter((s) => (s.values || []).some((v) => v != null));
  if (!series.length || !x.length) return <p className="muted">No data yet.</p>;
  const stacked = d.kind === "stacked";
  const bar = d.kind === "bar" || stacked;
  const color = (i: number) => series[i].color || (series.length === 1 ? "var(--hue)" : SERIES[i % SERIES.length]);
  const [W, H, L, T, B] = [640, 220, 44, 10, 24];
  const R = stacked || (bar && series.length === 1) ? 14 : 118;
  const n = x.length;
  // Stacked, each x's parts above zero go up from it and those below go down, so its range is their sums.
  const sums = stacked ? x.map((_, i) => series.reduce(([up, down], s) => (s.values[i] > 0 ? [up + s.values[i], down] : s.values[i] < 0 ? [up, down + s.values[i]] : [up, down]), [0, 0])) : null;
  const vals = stacked ? sums.flat() : series.flatMap((s) => s.values.filter((v) => v != null));
  for (const t of [d.target, d.target2]) if (t?.value != null && Number.isFinite(Number(t.value))) vals.push(Number(t.value));
  const ticks = niceTicks(Math.min(...vals, ...(bar ? [0] : [])), Math.max(...vals, ...(bar ? [0] : [])));
  const lo = ticks[0];
  const hi = ticks.at(-1);
  const py = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo || 1);
  const px = (i: number) => (bar ? L + ((i + 0.5) * (W - L - R)) / n : L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1)));
  const every = Math.max(1, Math.ceil(n / 8));
  const labels = x.map(dateLabel);
  // Its axis may say less than its tooltip (a dashboard's: "14:00" there, "Nov 3, 14:00" here).
  const axis = d.axis?.length === n ? d.axis : labels;
  // A label the one before it already said (a day's, on a week) isn't said again.
  let said: string | null = null;
  const xl = axis.map((lab, i) => {
    if (!((i % every === 0 && n - 1 - i >= every / 2) || i === n - 1) || lab === said) return null;
    said = lab;
    return (
      <text key={i} x={px(i)} y={H - 5} textAnchor="middle">
        {lab}
      </text>
    );
  });
  // The moments that matter: a line at each one's x, with what happened.
  const markers = (d.markers || [])
    .map((mk) => ({ mk, i: x.findIndex((v, i) => String(v) === String(mk.x) || labels[i] === String(mk.x)) }))
    .filter((o) => o.i >= 0)
    .map(({ mk, i }, k) => <Marker key={k} label={mk.label} cx={px(i)} right={i > n / 2} top={T} bottom={H - B} />);
  let marks: ReactNode = null;
  let ends: ReactNode = null;
  if (stacked) {
    const bw = Math.max(2, Math.min(((W - L - R) / n) * 0.62, 44));
    marks = x.map((_, i) => {
      let up = 0;
      let down = 0;
      return series.map((s, si) => {
        const v = s.values[i];
        if (!v) return null;
        const from = v > 0 ? up : down;
        if (v > 0) up += v;
        else down += v;
        return <rect key={`${i}-${si}`} x={(px(i) - bw / 2).toFixed(1)} y={Math.min(py(from), py(from + v)).toFixed(1)} width={bw.toFixed(1)} height={Math.max(1, Math.abs(py(from + v) - py(from))).toFixed(1)} fill={color(si)} stroke="var(--card)" strokeWidth="1" />;
      });
    });
    // Each bar's total over it, while there's room to read them.
    if (n <= 16)
      ends = sums.map(([up, down], i) => (
        <text key={i} x={px(i)} y={py(up) - 5} textAnchor="middle">
          {chartNum(up + down)}
        </text>
      ));
  } else if (bar) {
    const band = (W - L - R) / n;
    const group = Math.min(band * 0.72, 56);
    const bw = Math.max(2, (group - 2 * (series.length - 1)) / series.length);
    const base = py(Math.max(lo, Math.min(0, hi)));
    marks = series.map((s, si) => s.values.map((v, i) => (v == null ? null : <rect key={`${si}-${i}`} x={(px(i) - group / 2 + si * (bw + 2)).toFixed(1)} y={Math.min(py(v), base).toFixed(1)} width={bw.toFixed(1)} height={Math.max(1, Math.abs(base - py(v))).toFixed(1)} rx={Math.min(4, bw / 2)} fill={color(si)} />)));
  } else {
    marks = series.map((s, si) => {
      let path = "";
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) return void (pen = false);
        path += `${pen ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
        pen = true;
      });
      // The period before (Compare) is dashed and lighter.
      return <path key={si} d={path} fill="none" stroke={color(si)} strokeWidth={s.dash ? 1.5 : 2} strokeDasharray={s.dash ? "4 4" : undefined} opacity={s.dash ? "0.55" : undefined} strokeLinejoin="round" strokeLinecap="round" />;
    });
    // Each line ends in a dot and its latest value, nudged apart so labels never sit on each other; a dashed one
    // doesn't.
    const last = series
      .filter((s) => !s.dash)
      .map((s) => {
        const si = series.indexOf(s);
        const i = s.values.findLastIndex((v) => v != null);
        return { s, si, i, v: s.values[i], y: py(s.values[i]), ly: undefined as number | undefined };
      })
      .filter((e) => e.i >= 0);
    const placed = [...last].sort((a, b) => a.y - b.y);
    for (let k = 1; k < placed.length; k++) placed[k].ly = Math.max(placed[k].y, (placed[k - 1].ly ?? placed[k - 1].y) + 14);
    ends = last.map((e, k) => (
      <g key={k}>
        <circle cx={px(e.i)} cy={e.y} r="4" fill={color(e.si)} stroke="var(--card)" strokeWidth="2" />
        <text x={px(n - 1) + 10} y={(e.ly ?? e.y) + 4}>
          {`${series.length > 1 ? `${e.s.name} ` : ""}${chartNum(e.v)}`}
        </text>
      </g>
    ));
  }
  const geo: Geo = { x: labels, series: series.map((s, i) => ({ name: s.name, color: color(i), values: s.values })), L, R, W, H, T, B, bar, stacked, unit: d.unit || "", ...(d.zoom && d.times?.length === n ? { t: d.times } : {}) };
  const body = (
    <>
      <g className="grid">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R + 6} y1={py(v)} y2={py(v)} />
            <text x={L - 8} y={py(v) + 4} textAnchor="end">
              {chartNum(v)}
            </text>
          </g>
        ))}
      </g>
      <g className="xl">{xl}</g>
      <Target t={d.target} unit={d.unit} x1={L} x2={W - R + 6} py={py} />
      {d.target2 ? <Target t={d.target2} unit={d.unit} x1={L} x2={W - R + 6} py={py} /> : null}
      {markers}
      {marks}
    </>
  );
  return (
    <>
      <Legend series={series} color={color} />
      <Lc geo={geo} title={title} zoom={d.zoom} onZoom={onZoom} body={body} ends={ends} />
    </>
  );
}
// A scatter: a dot for each of its series' points, x along the bottom and y up the side, both numbers. A few points
// with labels say them beside their dots, since a phone can't hover.
function WScatter({ d, title }: { d: ChartData; title?: Text }) {
  const series = ((d.series || []) as DrawnSeries[]).filter((s) => (s.points || []).length);
  if (!series.length) return <p className="muted">No data yet.</p>;
  const color = (i: number) => series[i].color || (series.length === 1 ? "var(--hue)" : SERIES[i % SERIES.length]);
  const [W, H, L, R, T, B] = [640, 220, 44, 14, 10, 24];
  const pts = series.flatMap((s, si) => s.points.map((p) => ({ ...p, si })));
  const tv = Number(d.target?.value);
  const marked = (d.markers || []).map((mk) => ({ mk, v: Number(mk.x) })).filter((o) => o.mk.x !== "" && Number.isFinite(o.v));
  const xs = [...pts.map((p) => p.x), ...marked.map((o) => o.v)];
  const ys = [...pts.map((p) => p.y), ...(d.target?.value != null && Number.isFinite(tv) ? [tv] : [])];
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), 5);
  const yt = niceTicks(Math.min(...ys), Math.max(...ys));
  const px = (v: number) => L + ((v - xt[0]) * (W - L - R)) / (xt.at(-1) - xt[0] || 1);
  const py = (v: number) => T + ((yt.at(-1) - v) * (H - T - B)) / (yt.at(-1) - yt[0] || 1);
  const named = pts.filter((p) => p.label);
  const names =
    named.length && named.length <= 15
      ? named.map((p, k) => (
          <text key={k} x={(px(p.x) + (px(p.x) > W * 0.75 ? -8 : 8)).toFixed(1)} y={(py(p.y) + 4).toFixed(1)} textAnchor={px(p.x) > W * 0.75 ? "end" : "start"}>
            {p.label}
          </text>
        ))
      : null;
  const geo: Geo = { scatter: true, W, H, T, B, series: series.map((s, i) => ({ name: s.name, color: color(i) })), pts: pts.map((p) => [+px(p.x).toFixed(1), +py(p.y).toFixed(1), p.si, p.x, p.y, p.label || ""]), unit: d.unit || "", xunit: d.x_unit || "" };
  const body = (
    <>
      <g className="grid">
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={W - R} y1={py(v)} y2={py(v)} />
            <text x={L - 8} y={py(v) + 4} textAnchor="end">
              {chartNum(v)}
            </text>
          </g>
        ))}
        {xt.map((v) => (
          <line key={`x${v}`} x1={px(v)} x2={px(v)} y1={T} y2={H - B} />
        ))}
      </g>
      <g className="xl">
        {xt.map((v, i) =>
          i === xt.length - 1 ? (
            <text key={i} x={W - R} y={H - 5} textAnchor="end">
              {`${chartNum(v)}${d.x_unit ? ` ${d.x_unit}` : ""}`}
            </text>
          ) : (
            <text key={i} x={px(v)} y={H - 5} textAnchor="middle">
              {chartNum(v)}
            </text>
          ),
        )}
      </g>
      <Target t={d.target} unit={d.unit} x1={L} x2={W - R} py={py} />
      {marked.map(({ mk, v }, k) => (
        <Marker key={k} label={mk.label} cx={px(v)} right={px(v) > W / 2} top={T} bottom={H - B} />
      ))}
      {pts.map((p, k) => (
        <circle key={k} cx={px(p.x).toFixed(1)} cy={py(p.y).toFixed(1)} r="4.5" fill={color(p.si)} fillOpacity="0.8" stroke="var(--card)" strokeWidth="1" />
      ))}
    </>
  );
  return (
    <>
      <Legend series={series} color={color} />
      <Lc geo={geo} title={title} body={body} ends={names} />
    </>
  );
}

// A column of numbers gets a bar in each row, as long as its number against the largest: the class and width for a cell
// of it.
const barStyle = (bars: Map<number, (number | null)[]>, i: number, ri: number) => (bars.has(i) && bars.get(i)[ri] != null ? ({ "--w": `${bars.get(i)[ri].toFixed(1)}%` } as CSSProperties) : undefined);
// `sortKey` ("<page>/<widget>") makes its headers sort it: a click on one sorts by that column (numbers largest
// first, words A to Z), a second turns it round, a third gives the page's order back: the sort its agent gave it
// (`sort`, "-Cost"), or its rows as written. It's how you look at it, here, until you reload: the page itself keeps
// its order.
export function WTable({ d, sortKey = "" }: { d: WidgetData; sortKey?: string }) {
  const mine = usePageUi((s) => (sortKey ? s.tblSort[sortKey] : null));
  const cols = d.columns || [];
  const rows = (d.rows || []) as TableCell[][];
  if (!rows.length) return <p className="muted">No rows yet.</p>;
  const numeric = cols.map((_, i) => i > 0 && rows.every((r) => r[i] == null || r[i] === "" || (typeof r[i] !== "object" && looksNumeric(r[i]))));
  const bars = tableBars(rows, cols.length);
  const def = tableSort(d);
  const by = (sortKey && rows.length > 1 && mine) || def;
  const sorted = by && by.col < cols.length ? by : null;
  const order = sorted ? tableOrder(rows, sorted.col, sorted.dir) : rows.map((_, i) => i);
  // The other way when it's sorted by this column already; back to the page's own once you've seen both.
  const sortBy = (col: number, dir: string, first: string) => {
    const next = !dir ? first : dir === "asc" ? "desc" : "asc";
    setPageUi((s) => {
      const tblSort = { ...s.tblSort };
      if ((dir && sortKey in tblSort && dir !== first) || (def && `${def.col}:${def.dir}` === `${col}:${next}`)) delete tblSort[sortKey];
      else tblSort[sortKey] = { col, dir: next };
      return { tblSort };
    });
  };
  const th = (c: Text, i: number) => {
    if (!sortKey || rows.length < 2)
      return (
        <th key={i} className={numeric[i] ? "num" : ""}>
          {c}
        </th>
      );
    const dir = sorted?.col === i ? sorted.dir : "";
    const first = sortsAsNumber(rows, i) ? "desc" : "asc";
    return (
      <th key={i} className={numeric[i] ? "num" : ""} aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}>
        <button className={`th-sort${dir ? " is-on" : ""}`} type="button" title={`Sort by ${c}`} onClick={() => sortBy(i, dir, first)}>
          {c}
          <i aria-hidden="true">{dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}</i>
        </button>
      </th>
    );
  };
  return (
    <div className="md-tbl">
      <table className="mini-tbl wg-tbl">
        <thead>
          <tr>{cols.map(th)}</tr>
        </thead>
        <tbody>
          {order.map((ri) => (
            <tr key={ri}>
              {rows[ri].map((c, i) => (
                <td key={i} className={`${numeric[i] ? "num" : ""}${barStyle(bars, i, ri) ? " has-bar" : ""}`} style={barStyle(bars, i, ri)}>
                  {i === 0 ? (
                    <b>
                      <Cell c={c} />
                    </b>
                  ) : (
                    <Cell c={c} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Deciding on a page, from one of its widgets: an OK, a not now, a pick. `act` says you can, and does it
// (pageAct): true once it's done.
export type WidgetAct = ((act: string, i: number, text: Text) => Promise<boolean>) | null;
// A button that decides, off while it's asking.
function ActBtn({ act, kind, i, text, className, children, ...rest }: { act: WidgetAct; kind: string; i: number; text: Text; className: string; children: ReactNode; title?: string; "aria-pressed"?: boolean }) {
  const [off, setOff] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={off}
      {...rest}
      onClick={async () => {
        setOff(true);
        if (!(await act(kind, i, text))) setOff(false);
      }}
    >
      {children}
    </button>
  );
}
// A list. An item that asks for your OK (`ask: "ok"`) has OK / Not now when `act` says you can decide here, and says
// what you answered once you have.
export function WList({ d, act = null }: { d: WidgetData; act?: WidgetAct }) {
  const items = d.items || [];
  if (!items.length) return <p className="muted">Nothing here yet.</p>;
  const me = getApp().me?.username;
  return (
    <ul className="wl">
      {items.map((it, i) => {
        const mark = d.check ? (
          <span className={`tick-box${it.done ? " on" : ""}`} aria-hidden="true">
            {it.done ? "✓" : ""}
          </span>
        ) : it.status ? (
          <StBadge st={it.status} text={it.label || ""} />
        ) : null;
        const said =
          it.ok != null ? (
            <span className={`chip ${it.ok ? "chip--ok" : ""}`}>
              {it.ok ? "OK'd" : "Not now"}
              {it.ok_by ? ` by ${it.ok_by === me ? "you" : `@${it.ok_by}`}` : ""}
            </span>
          ) : null;
        const acts =
          it.ask === "ok" ? (
            it.ok != null ? (
              said
            ) : act ? (
              <>
                <ActBtn act={act} kind="ok" i={i} text={it.text} className="btn btn--sm btn--dark">
                  OK
                </ActBtn>
                <ActBtn act={act} kind="no" i={i} text={it.text} className="btn btn--sm btn--line">
                  Not now
                </ActBtn>
              </>
            ) : (
              <span className="chip chip--sun">Waits for an OK</span>
            )
          ) : null;
        return (
          <li key={i} className={it.done ? "is-done" : ""}>
            {mark}
            <div>
              <span>
                {webUrl(it.link) ? (
                  <a href={it.link} target="_blank" rel="noopener">
                    {it.text}
                  </a>
                ) : (
                  it.text
                )}
              </span>
              {it.sub ? <small>{it.sub}</small> : null}
              {acts ? <div className="wl-acts">{acts}</div> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
// Options side by side: the agent's recommendation (`pick`), and yours (`chosen`), which `act` lets you make here.
export function WOptions({ d, pics, act = null }: { d: WidgetData; pics: string | null; act?: WidgetAct }) {
  const items = d.items || [];
  if (!items.length) return <p className="muted">No options yet.</p>;
  return (
    <div className="opts">
      {items.map((o, i) => (
        <div key={i} className={`opt-c${o.pick ? " is-pick" : ""}${o.chosen ? " is-chosen" : ""}`}>
          {webUrl(o.image) ? <img className="opt-img" src={picUrl(o.image, pics)} alt="" /> : null}
          <div>
            {o.pick ? <span className="opt-tag">Recommended</span> : null}
            <h4>
              {String.fromCharCode(65 + (i % 26))}. {o.name}
            </h4>
            {o.text ? <p>{o.text}</p> : null}
            <ul>
              {(o.pros || []).map((t, k) => (
                <li key={`p${k}`} className="pro">
                  <b>+</b>
                  {t}
                </li>
              ))}
              {(o.cons || []).map((t, k) => (
                <li key={`c${k}`} className="con">
                  <b>−</b>
                  {t}
                </li>
              ))}
            </ul>
            {act ? (
              <ActBtn act={act} kind={o.chosen ? "unpick" : "pick"} i={i} text={o.name} className={`btn btn--sm ${o.chosen ? "btn--dark" : "btn--line"} opt-choose`} aria-pressed={!!o.chosen} title={o.chosen ? "Take your pick back" : "Pick this one"}>
                {o.chosen ? (
                  <>
                    <Icon name="check" />
                    Your pick
                  </>
                ) : (
                  "Pick this"
                )}
              </ActBtn>
            ) : o.chosen ? (
              <span className="chip chip--ok">
                <Icon name="check" />
                Picked
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
export function WLink({ d }: { d: WidgetData }) {
  const url = webUrl(d.url);
  if (!url) return <p className="muted">No link yet.</p>;
  return (
    <a className="pr pr--link" href={url} target="_blank" rel="noopener">
      <div className="pr-in">
        <small>{url.replace(/^https?:\/\//, "").split("/")[0]}</small>
        <b>{d.title || url}</b>
        {d.text ? (
          <div className="pr-stats">
            <span>{d.text}</span>
          </div>
        ) : null}
      </div>
    </a>
  );
}
// A filter: its values to pick from, and all of them. `onPick`: narrow the page to one (null: all again).
export function WFilter({ w, filters, onPick }: { w: Widget; filters: Record<string, string>; onPick: (value: string | null) => void }) {
  const d = w.data || {};
  const on = filters[w.id] || "";
  const values = on && !(d.values || []).includes(on) ? [...(d.values || []), on] : d.values || [];
  const time = d.kind === "time";
  const chip = (v: string, label: Text) => (
    <button key={v || "*"} className={`btn btn--sm ${on === v ? "btn--dark" : "btn--line"}`} type="button" aria-pressed={on === v} onClick={() => onPick(v || null)}>
      {label}
    </button>
  );
  return (
    <div className="nf" role="group" aria-label={String(w.title || w.id)}>
      {chip("", d.all || (time ? "All time" : "All"))}
      {values.map((v) => chip(v, time ? periodLabel(v, true) : v))}
    </div>
  );
}

// A widget's body, by its type. `tasks`: what draws a page's checklist (its tasks, from your Tasks list).
// `sortKey`: a table's, so you can sort it here. `act`: deciding on a list's OKs and options' picks. `onZoom`: a
// dashboard's chart, dragged across.
export function WidgetBody({ w, pics = null, sortKey = "", act = null, tasks = null, onZoom }: { w: Pick<Widget, "type" | "title"> & { data?: WidgetData | ChartData }; pics?: string | null; sortKey?: string; act?: WidgetAct; tasks?: ReactNode; onZoom?: (from: number, to: number) => void }) {
  const d = (w.data || {}) as WidgetData;
  switch (w.type) {
    case "tasks":
      return <>{tasks}</>;
    case "metric":
      return <WMetric d={d} />;
    case "chart":
      return <WChart d={w.data as ChartData} title={w.title} onZoom={onZoom} />;
    case "table":
      return <WTable d={d} sortKey={sortKey} />;
    case "list":
      return <WList d={d} act={act} />;
    case "note":
      return d.text ? <Markdown className="wg-note md" text={String(d.text)} pics={pics} /> : <p className="muted">Empty.</p>;
    case "doc":
      return d.text ? <Markdown className="doc md" text={String(d.text)} pics={pics} /> : <p className="muted">Empty.</p>;
    case "link":
      return <WLink d={d} />;
    case "options":
      return <WOptions d={d} pics={pics} act={act} />;
    case "diagram":
      return <Diagram dg={d as DiagramIn} title={String(w.title || "")} />;
  }
  return null;
}
