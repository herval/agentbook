// A page's widgets on it (app.ts widgetCard, widgetGrid): each in its card, with who last changed it and the routine
// that keeps it; narrowed by the page's filters; a widget of its own in a sandboxed frame that hears the page; the
// live routines that run while it's open; and editing it by hand.
import { useEffect, useRef, useState } from "react";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { post } from "../../lib/api.ts";
import { agoText, clock, hue, hueVars, webUrl } from "../../lib/format.ts";
import { setDraft } from "../../lib/hooks.ts";
import { pagePics } from "../../lib/markdown.ts";
import { getApp, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { PageEdit, PageLive, PageRow, Route } from "../../lib/types.ts";
import type { By, Text, Widget, WidgetData, WidgetWidth } from "../../../plugin/shared/types.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { PageTasks } from "../tasks/Lists.tsx";
import { barHref, byName, dateOf, filterOf, keeperOf, narrowTo, onPageMachine, periodLabel, periodStart, routineEvery, routineName, WIDTH_COLS, WIDTH_NAMES } from "./pages.ts";
import type { PageRec } from "./pages.ts";
import { changeEdit, editOf, getPageUi, reloadPage, setPageUi, usePageDetail, usePageUi } from "./state.ts";
import { chartSeriesHas, SERIES, WFilter, WidgetBody } from "./widgets.tsx";
import type { ChartData, WidgetAct } from "./widgets.tsx";

type EditW = PageEdit["widgets"][number];

export function ByAvatar({ p, by, size = "av--xs" }: { p: PageRec; by: By | null | undefined; size?: string }) {
  if (by?.user) return <PersonAvatar who={by.user} size={size} letter={by.user[0].toUpperCase()} />;
  if (by?.routine)
    return (
      <span className={`av ${size} av--rt`} title={`${routineName(p, by.routine)}, a routine`}>
        <Icon name="repeat" />
      </span>
    );
  return <Avatar agent={by?.agent ? onPageMachine(p, by.agent) : null} size={size} />;
}

/* ---------- a page's filters ---------- */

// What a widget shows with the page's filters on it: its data narrowed (a value's own data, its rows, series, x's
// or items that match, or for a time filter, the dates in the period), one tag saying what it's narrowed to, and
// what to say when nothing's left.
function narrowed(p: PageRec, w: Widget, filters: Record<string, string>): { data: WidgetData; tags: ReactNode[]; empty?: string | null } {
  const d = (w.data || {}) as WidgetData & { per?: Record<string, Record<string, WidgetData>>; match?: Record<string, string> };
  const on = Object.entries(filters).filter(([id]) => id !== w.id);
  if (!on.length || w.type === "filter" || w.type === "html") return { data: d, tags: [] };
  let data = d as ChartData & WidgetData;
  const shows: string[] = [];
  const off: string[] = [];
  let none = false;
  const forValues: string[] = [];
  let inPeriod: string | null = null;
  for (const [id, value] of on) {
    const f = filterOf(p, id);
    const fd = (f?.data || {}) as WidgetData & { kind?: string; all?: string };
    const time = fd.kind === "time";
    const label = time ? periodLabel(value) : value;
    const per = d.per?.[id];
    const where = d.match?.[id];
    // A value matches: the picked one, or for a time filter, a date in the period.
    const since = time ? periodStart(value) : null;
    const is = (x: unknown) => (time ? dateOf(x) >= since : String(x && typeof x === "object" ? ((x as { text?: Text }).text ?? "") : (x ?? "")).trim() === value);
    const series = (data.series || []) as { name?: string; color?: string; values?: (number | null)[] }[];
    if (per && Object.hasOwn(per, value)) data = { ...data, ...per[value] } as typeof data;
    else if (where && w.type === "table") {
      const i = (data.columns || []).indexOf(where);
      if (i >= 0) data = { ...data, rows: (data.rows || []).filter((r) => is(r[i])) };
    } else if (where && w.type === "chart" && where === "series" && !time) {
      const all = series.filter((x) => chartSeriesHas(x as never));
      data = { ...data, series: all.map((x, i) => ({ ...x, color: x.color || (all.length > 1 ? SERIES[i % SERIES.length] : undefined) })).filter((x) => x.name === value) as ChartData["series"] };
    } else if (where && w.type === "chart" && where === "x" && data.kind !== "scatter") {
      const keep = (data.x || []).map((x, i) => (is(x) ? i : -1)).filter((i) => i >= 0);
      data = { ...data, x: keep.map((i) => data.x[i]), series: series.map((x) => ({ ...x, values: keep.map((i) => x.values?.[i] ?? null) })) as ChartData["series"] };
    } else if (where && (w.type === "list" || w.type === "options")) data = { ...data, items: (data.items || []).filter((it) => is((it as Record<string, unknown>)[where])) };
    else if (!per) {
      off.push(fd.all || (time ? "All time" : "All"));
      continue;
    }
    const left = (data.series || []) as { name?: string }[];
    none ||= (per && !Object.hasOwn(per, value) && !where) || (!!where && ((w.type === "table" && !data.rows?.length) || (w.type === "chart" && (!left.length || (data.kind !== "scatter" && !data.x?.length) || !left.some((x) => chartSeriesHas(x as never)))) || ((w.type === "list" || w.type === "options") && !data.items?.length)));
    if (time) inPeriod = label;
    else forValues.push(value);
    shows.push(label);
  }
  // Nothing left: "Nothing for erp-sync in the last 24 hours."
  const empty = none ? `Nothing${forValues.length ? ` for ${forValues.join(", ")}` : ""}${inPeriod ? (inPeriod === "Today" ? " today" : ` in the ${inPeriod.replace(/^Last /, "last ")}`) : ""}.` : null;
  // One tag says what it shows: what it's narrowed to (and, on hover, what it isn't narrowed by), or that it's all.
  const tags = shows.length
    ? [
        <span key="on" className="wg-tag wg-tag--on" title={`Narrowed to ${shows.join(", ")}${off.length ? `; ${off.join(", ").toLowerCase()}` : ""}`}>
          {shows.join(" · ")}
        </span>,
      ]
    : off.length
      ? [
          <span key="off" className="wg-tag" title="Doesn't follow these filters">
            {off.join(" · ")}
          </span>,
        ]
      : [];
  return { data: data as WidgetData, tags, empty };
}
// Filters on that no filter widget shows (one an html widget set): what they are, and taking them off.
export function NarrowBar({ p, filters }: { p: PageRec; filters: Record<string, string> }) {
  const loose = Object.entries(filters).filter(([id]) => !filterOf(p, id));
  if (!loose.length) return null;
  return (
    <div className="nf-bar">
      <Icon name="funnel" />
      <span>Narrowed to</span>
      {loose.map(([id, v]) => (
        <button key={id} className="btn btn--sm btn--line" type="button" title="Show all again" onClick={() => narrowTo(p, id, null)}>
          <b>{v}</b>
          <Icon name="x" />
        </button>
      ))}
    </div>
  );
}

/* ---------- live widgets: a page's live routines run while it's open ---------- */

// A live routine (schedule "live") runs while its page is open: when you open it, every so often while it stays
// open and the tab shows, and when its filters change, with them as its inputs. What it returns shows on its
// widgets here, and isn't a version. live[page]: { key (the filters asked for), asked, busy, routines }.
const liveRoutines = (p: PageRec | undefined) => (p?.routines || []).filter((r) => r.every?.kind === "live" && r.on && r.live_v);
const liveKey = (r: Route = getApp().route) => JSON.stringify(r.filters || {});
const setLive = (id: string, o: Partial<PageLive>) => setPageUi((s) => ({ live: { ...s.live, [id]: { ...s.live[id], ...o } } }));
async function loadLive(p: PageRec) {
  const key = liveKey();
  setLive(p.id, { busy: true, asked: Date.now(), want: key });
  const res = await post<{ routines?: PageLive["routines"] }>(`/api/pages/${encodeURIComponent(p.id)}/live`, { filters: getApp().route.filters || {} }).catch(() => null);
  setLive(p.id, { busy: false });
  if (!res?.ok || getPageUi().live[p.id]?.want !== key) return;
  setLive(p.id, { key, routines: res.data.routines || [] });
}
// It asks when the page opens and when its filters change, wherever the tab is; again every so often only while
// the tab shows.
export function useLivePoll(id: string) {
  useEffect(() => {
    const tick = () => {
      const r = getApp().route;
      if (r.name !== "page" || r.tab !== "page" || r.id !== id) return;
      const p = (getApp().data?.pages || []).find((x) => x.id === id) as unknown as PageRec | undefined;
      const rs = liveRoutines(p);
      if (!rs.length || editOf(p)) return;
      const L = getPageUi().live[p.id];
      const every = Math.min(...rs.map((x) => x.every.everyMs));
      if (!L || (!L.busy && (L.want !== liveKey(r) || (document.visibilityState === "visible" && Date.now() - L.asked >= every)))) loadLive(p);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [id]);
}
// What a live routine last returned for a widget, for the filters on the page now: { data, at, routine, failed }.
function liveOf(p: PageRec, w: Widget, L: PageLive | undefined = getPageUi().live[p.id], r: Route = getApp().route) {
  if (!L?.routines || L.key !== liveKey(r)) return null;
  for (const x of L.routines) {
    const got = (x.widgets || []).find((y) => y.id === w.id);
    if (got || (x.keeps || []).includes(w.id)) return { data: got?.data || null, at: x.at, routine: x, failed: !x.ok || !!x.failed, error: x.error };
  }
  return null;
}
// Its chip: live, and how fresh; updating, while the filters it was asked for changed; or failing.
function LiveChip({ p, w, got }: { p: PageRec; w: Widget; got: ReturnType<typeof liveOf> }) {
  const r = (p.routines || []).find((x) => x.every?.kind === "live" && x.on && x.live_v && x.keeps.includes(w.id));
  if (!r) return null;
  const every = Math.round(r.every.everyMs / 1000);
  if (!got)
    return (
      <span className="wg-live is-wait" title={`${r.name} runs while this page is open, every ${every} s`}>
        <i />
        Live · updating
      </span>
    );
  if (got.failed)
    return (
      <span className="wg-live is-bad" title={`${got.error || "It failed"}. It shows what it last got.`}>
        <i />
        Live · failed
      </span>
    );
  return (
    <span className="wg-live" title={`${r.name} got this ${agoText(got.at)}, and runs every ${every} s while this page is open`}>
      <i />
      Live
    </span>
  );
}

/* ---------- a widget of its own: an html widget, in a sandboxed frame ---------- */

// How tall each frame said it is, by "<page>/<widget>", so a redraw keeps it.
const frameHeights: Record<string, number> = {};
// The frames on the page now, and the key of what each was last told.
const frames = new Map<HTMLIFrameElement, () => void>();
const told = new WeakMap<HTMLIFrameElement, string>();
// The frame: it loads the widget's code from the page's own address, and only runs scripts.
function WFrame({ p, w }: { p: PageRec; w: Widget }) {
  const key = `${p.id}/${w.id}`;
  const [gone, setGone] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    frames.set(f, () => setGone(true));
    return () => void frames.delete(f);
  }, [gone]);
  // Its document went away while it's on the page: its code opened something else in its place.
  if (gone) return <p className="muted">This widget tried to open another page in its place, so it was stopped.</p>;
  const src = `/api/pages/${encodeURIComponent(p.id)}/frame/${encodeURIComponent(w.id)}${w.v ? `?v=${w.v}` : ""}`;
  return <iframe ref={ref} className="wg-frame" sandbox="allow-scripts" data-frame={`${key}@${w.v || 0}`} data-page={p.id} data-wid={w.id} src={src} title={w.title || "A widget of its own"} style={{ height: `${frameHeights[key] || (w.data as { height?: number })?.height || 160}px` }} />;
}
// What a widget of its own knows of its page: the filters on it, and its widgets (their data, not their code),
// as you see them, live ones as they were last got. It's told when it starts and when any of that changes.
function frameState(pid: string) {
  const r = getApp().route;
  const p = (getApp().data?.pages || []).find((x) => x.id === pid) as unknown as PageRec | undefined;
  if (!p || r.name !== "page" || r.id !== p.id) return null;
  const ui = getPageUi();
  const ed = editOf(p);
  const at = r.tab === "at" && ui.at?.page === p.id && ui.at.snapshot ? ui.at.snapshot.widgets : null;
  const now = (w: Widget) => (!at && !ed && liveOf(p, w)?.data) || w.data;
  const widgets = (ed?.widgets || at || p.widgets).map((w) => ({ id: w.id, type: w.type, title: w.title || "", data: w.type === "html" ? { data: (now(w) as { data?: unknown })?.data ?? null } : now(w) }));
  const filters = ed ? {} : r.filters || {};
  const ranges = Object.fromEntries(Object.entries(filters).filter(([id]) => (filterOf(p, id)?.data as { kind?: string })?.kind === "time").map(([id, v]) => [id, { from: new Date(periodStart(v)).toISOString(), to: new Date().toISOString() }]));
  const L = ui.live[p.id];
  return { key: `${p.version}|${at ? r.v : ""}|${ed ? "edit" : ""}|${JSON.stringify(filters)}|${L?.key === liveKey(r) && L.routines ? JSON.stringify(L.routines.map((x) => x.at)) : ""}`, filters, ranges, widgets };
}
// Tell the frames on the page what's new, or one frame (that just started) all of it.
export function tellFrames(to: MessageEventSource | null = null) {
  for (const f of frames.keys()) {
    if (to && f.contentWindow !== to) continue;
    const st = frameState(f.dataset.page);
    if (!st || (!to && told.get(f) === st.key)) continue;
    told.set(f, st.key);
    // Its own data, as a live routine last got it.
    const self = (st.widgets.find((w) => w.id === f.dataset.wid)?.data as { data?: unknown })?.data;
    f.contentWindow?.postMessage({ agentbook: 1, type: "page", filters: st.filters, ranges: st.ranges, widgets: st.widgets, self: self ?? null }, "*");
  }
}
// What a frame says: it's ready, a query, it's leaving, its size; and, from a click in it, open a link, ask the
// page's agents, or narrow the page.
addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.agentbook !== 1 || typeof m.type !== "string") return;
  const f = [...frames.keys()].find((x) => x.contentWindow === e.source);
  if (!f) return;
  if (m.type === "ready") return tellFrames(e.source);
  if (m.type === "query") return void frameQuery(f, m);
  if (m.type === "leaving") return frames.get(f)?.();
  if (m.type === "size") {
    const h = Math.min(Math.max(Math.round(Number(m.height)) || 0, 24), 1600);
    frameHeights[f.dataset.frame.replace(/@\d+$/, "")] = h;
    f.style.height = `${h}px`;
    return;
  }
  if (navigator.userActivation && !navigator.userActivation.isActive) return;
  if (m.type === "open") {
    const url = webUrl(m.url);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  if (m.type === "ask") askPage(f.dataset.page, String(m.text || "").trim().slice(0, 4000));
  const r = getApp().route;
  const p = (getApp().data?.pages || []).find((x) => x.id === f.dataset.page);
  if (m.type === "filter" && p && r.name === "page" && r.id === p.id && !editOf(p) && /^[\w-]{1,40}$/.test(String(m.id))) narrowTo(p, String(m.id), m.value == null || m.value === "" ? null : String(m.value).slice(0, 80));
});
// agentbook.query(params) in a widget of its own: the live routine that keeps it runs with those params (and the
// page's filters), and its answer is the widget's data as it returned it. Only on the page as it is.
async function frameQuery(f: HTMLIFrameElement, m: { id?: unknown; params?: unknown }) {
  const r = getApp().route;
  const reply = (x: object) => f.contentWindow?.postMessage({ agentbook: 1, type: "answer", id: m.id, ...x }, "*");
  if (r.name !== "page" || r.id !== f.dataset.page || r.tab !== "page") return reply({ error: "Nothing to ask here." });
  type Got = { routines?: { ok?: boolean; error?: string; at?: string; widgets?: { id: string; data?: { data?: unknown } }[] }[]; error?: string };
  const res: Got | null = await fetch(`/api/pages/${encodeURIComponent(r.id)}/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ widget: f.dataset.wid, params: m.params && typeof m.params === "object" ? m.params : {}, filters: r.filters || {} }) })
    .then((x) => x.json())
    .catch(() => null);
  const x = (res?.routines || [])[0];
  if (!x) return reply({ error: res?.error || "No live routine keeps this widget." });
  if (!x.ok && !x.widgets) return reply({ error: x.error || "It failed." });
  reply({ data: (x.widgets || []).find((y) => y.id === f.dataset.wid)?.data?.data ?? null, at: x.at });
}
// What a widget asks goes in the page's "Ask for a change" box, for you to send (or not).
function askPage(pid: string, text: string) {
  const p = (getApp().data?.pages || []).find((x) => x.id === pid);
  if (!p?.can_edit || p.archived) return void toast("Only the page's owner asks its agents for changes, from the box above it.");
  if (!text) return;
  setDraft(`page:${pid}`, text);
  // The page's composer's box (MsgBox), by its draft: it shows the text once it draws again.
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLElement>(`[data-draft="${CSS.escape(`page:${pid}`)}"]`);
    box?.focus();
    box?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

/* ---------- a widget on its page ---------- */

// Under a widget a routine keeps: which one, and when it last did; or that it's gone stale.
function KeptLine({ p, w, edit }: { p: PageRec; w: Widget; edit: PageEdit | null }) {
  const r = keeperOf(p, w.id);
  if (!r) return null;
  if (edit)
    return (
      <p className="wg-rt">
        <Icon name="repeat" />
        <b>{r.name}</b>rewrites this {routineEvery(r)}
      </p>
    );
  if (r.stale)
    return (
      <p className="wg-rt wg-rt--stale">
        <Icon name="alert" />
        <b>{r.name}</b>· stale since {clock(String(r.stale))}
      </p>
    );
  if (r.every?.kind === "live")
    return (
      <p className="wg-rt" title={`${r.name} runs while this page is open, every ${Math.round(r.every.everyMs / 1000)} s, with its filters`}>
        <Icon name="repeat" />
        <b>{r.name}</b>· live while it's open{r.on ? "" : " · off"}
      </p>
    );
  const at = w.by?.routine === r.id ? w.at : r.last_ok;
  return (
    <p className="wg-rt" title={`${r.name} keeps it, ${routineEvery(r)}`}>
      <Icon name="repeat" />
      <b>{r.name}</b>
      {at ? `· ${agoText(at)}` : r.on ? "" : "· off"}
    </p>
  );
}

// Deciding on a page: a version by you (see /api/pages/:id/act). An OK, a not now or a pick goes to the thread
// that asked, as your message.
const pageAct =
  (p: PageRec, wid: string): WidgetAct =>
  async (act: string, i: number, text: Text) => {
    const res = await post<{ tell?: { post: string; text: string } | null }>(`/api/pages/${encodeURIComponent(p.id)}/act`, { widget: wid, act, item: { i, text } });
    if (!res.ok) return false;
    const tell = res.data.tell;
    if (tell && (await post(`/api/sessions/${encodeURIComponent(tell.post)}/messages`, { text: tell.text })).ok) toast(`Told ${threadRow(tell.post)?.label || "the thread that asked"}.`);
    reloadPage();
    return true;
  };

// The widgets the thread open beside the page changed, in any of its versions.
function useLitWidgets(p: PageRec): Set<string> {
  const r = useApp((s) => s.route);
  const detail = usePageDetail(p);
  const editing = usePageUi((s) => s.edit?.pid === p.id);
  const id = r.name === "page" && r.tab === "page" && !editing && r.thread;
  if (!id || !detail) return new Set();
  return new Set((detail.history || []).filter((v) => v.by?.post && onPageMachine(p, v.by.post) === id).flatMap((v) => (v.changes || []).map((c) => c.id).filter(Boolean)));
}

// What draws a widget's card, and what it's told: the page, the widget, whether it's the page as it is (`latest`:
// not an older version, so what the latest version changed says so), the copy being edited by hand, whether it's
// in a stack, and the page's filters.
export interface CardProps {
  p: PageRec;
  w: EditW;
  latest?: boolean;
  edit?: PageEdit | null;
  stacked?: boolean;
  filters?: Record<string, string>;
}
export function WidgetCard({ p, w: given, latest = true, edit = null, stacked = false, filters = {} }: CardProps) {
  useApp((s) => s.rows);
  const L = usePageUi((s) => s.live[p.id]);
  const r = useApp((s) => s.route);
  const lits = useLitWidgets(p);
  let w = given;
  // A routine's refresh says so under the widget, not as news on it. A thread's change names the thread, and
  // opens it beside the page; so does the change of the thread open there.
  const lit = latest && !edit && lits.has(w.id) ? threadRow(r.thread) : null;
  const by = lit || (w.by?.post ? threadRow(onPageMachine(p, w.by.post)) : null);
  const news = latest && !edit && p.version > 1 && w.v === p.version && !w.by?.routine;
  const fresh =
    by && (lit || news) ? (
      <a className="wg-new wg-thr" href={barHref(p, by.id)} style={hueVars(by.agent)} title={`${lit && !news ? `Changed by ${by.label}` : `Changed in v${w.v} by ${by.label}`}: open its thread beside the page`}>
        <Avatar agent={by.agent} size="av--xs" />
        {by.label}
        {lit && !news ? "" : ` · v${w.v}`}
      </a>
    ) : news ? (
      <span className="wg-new" title={`Changed in v${w.v} by ${byName(p, w.by)}`}>
        <i />
        Updated {agoText(w.at)}
      </span>
    ) : null;
  const kept = latest && !p.archived && keeperOf(p, w.id) ? <KeptLine p={p} w={w} edit={edit} /> : null;
  const open = edit?.open === w.id;
  const live = latest && !edit ? liveOf(p, w, L, r) : null;
  if (live?.data && w.type !== "html") w = { ...w, data: live.data };
  const lc = latest && !edit ? <LiveChip p={p} w={w} got={live} /> : null;
  const hasLc = !!lc && (p.routines || []).some((x) => x.every?.kind === "live" && x.on && x.live_v && x.keeps.includes(w.id));
  const view = edit ? { data: w.data, tags: [] as ReactNode[], empty: null } : narrowed(p, w, filters);
  const corner = hasLc ? lc : fresh;
  const head =
    w.type === "doc" && !w.title && !open ? (
      fresh || view.tags.length ? (
        <div className="wg-h wg-h--doc">
          {view.tags}
          {corner}
        </div>
      ) : null
    ) : (
      <header className="wg-h">
        <h3>{w.title || ""}</h3>
        {view.tags}
        {corner}
      </header>
    );
  const body =
    w.type === "html" ? (
      <WFrame p={p} w={w} />
    ) : w.type === "filter" ? (
      <WFilter w={w} filters={edit ? {} : filters} onPick={(v) => narrowTo(p, w.id, v)} />
    ) : view.empty != null ? (
      <p className="muted">{view.empty}</p>
    ) : (
      <WidgetBody w={{ ...w, data: view.data }} pics={pagePics(p)} sortKey={`${p.id}/${w.id}`} act={latest && !edit && p.can_edit && !p.archived ? pageAct(p, w.id) : null} tasks={<PageTasks p={p as unknown as PageRow} />} />
    );
  const wrote =
    (w.type === "note" || w.type === "doc" || w.type === "html") && w.by && !open && !edit && !kept ? (
      <p className="wg-by">
        <ByAvatar p={p} by={w.by} />
        {w.type === "html" ? "Made" : "Last written"} by {byName(p, w.by)}
      </p>
    ) : null;
  const stale = kept && !edit && keeperOf(p, w.id)?.stale;
  return (
    <section className={`card wg wg--${w.type}${open ? " is-open" : ""}${stale ? " is-stale" : ""}${lit ? " is-lit" : ""}`} data-span={stacked ? undefined : WIDTH_COLS[w.width] || 6} data-wid={w.id} style={lit ? ({ "--lit": hue(lit.agent)[0] } as React.CSSProperties) : undefined}>
      {edit && !open ? <WidgetTools w={w} edit={edit} /> : null}
      {open ? null : head}
      {open ? <WidgetEditor w={w} /> : body}
      {wrote}
      {open ? null : kept}
    </section>
  );
}

// Widgets in order; the ones that share a stack sit in one column, where the first of them is. `card`: what draws
// each (a dashboard's panels draw their answers); the rest goes to it. The frames on it hear what changed.
export function WidgetGrid({ p, widgets, card: Card = WidgetCard, edit = null, latest = true, filters = {} }: { p: PageRec; widgets: EditW[]; card?: ComponentType<CardProps> } & Omit<CardProps, "p" | "w" | "stacked">) {
  const L = usePageUi((s) => s.live[p.id]);
  useEffect(() => tellFrames());
  void L;
  const stacked = new Set<string>();
  const cards: ReactNode[] = [];
  for (const w of widgets) {
    if (!w.stack) cards.push(<Card key={w.id} p={p} w={w} edit={edit} latest={latest} filters={filters} />);
    else if (!stacked.has(w.stack)) {
      stacked.add(w.stack);
      cards.push(
        <div key={`stack:${w.stack}`} className="wg-col" data-span={WIDTH_COLS[w.width] || 4}>
          {widgets
            .filter((x) => x.stack === w.stack)
            .map((x) => (
              <Card key={x.id} p={p} w={x} edit={edit} latest={latest} filters={filters} stacked />
            ))}
        </div>,
      );
    }
  }
  return (
    <div className="wg-grid">
      {cards}
      {edit ? <AddWidgetBar /> : null}
    </div>
  );
}

/* ---------- editing a page by hand ---------- */

// The page being edited: a copy of its widgets you change here, sent as one version when you save. What an agent
// writes meanwhile stays, except on the widgets you changed.
const NEW_WIDGET: Record<string, { title: string; width?: WidgetWidth; data: WidgetData }> = {
  note: { title: "Note", data: { text: "" } },
  metric: { title: "A number", data: { value: "", unit: "" } },
  list: { title: "List", data: { items: [] } },
  tasks: { title: "What needs doing", width: "half", data: {} },
  doc: { title: "", width: "two-thirds", data: { text: "" } },
  link: { title: "Link", data: { url: "", title: "" } },
  table: { title: "Table", data: { columns: ["Name", "Value"], rows: [] } },
};
export function startEdit(p: PageRec) {
  setPageUi({ edit: { pid: p.id, base: p.version, widgets: structuredClone(p.widgets), original: structuredClone(p.widgets), removed: [], open: null, title: p.title, emoji: p.emoji, about: p.about || "" } });
}
function WidgetTools({ w, edit }: { w: EditW; edit: PageEdit }) {
  const i = edit.widgets.findIndex((x) => x.id === w.id);
  // Swap it with the one before or after it.
  const move = (by: number) =>
    changeEdit((e) => {
      const ws = [...e.widgets];
      const a = ws.findIndex((x) => x.id === w.id);
      const b = a + by;
      if (a >= 0 && b >= 0 && b < ws.length) [ws[a], ws[b]] = [ws[b], ws[a]];
      return { widgets: ws };
    });
  return (
    <div className="wg-tools">
      <button className="icon-btn" type="button" aria-label="Move it earlier" title="Move it earlier" disabled={i === 0} onClick={() => move(-1)}>
        <Icon name="back" />
      </button>
      <button className="icon-btn" type="button" aria-label="Move it later" title="Move it later" disabled={i === edit.widgets.length - 1} onClick={() => move(1)}>
        <Icon name="next" />
      </button>
      <label className="wg-width" title="Its width">
        <select aria-label="Width" value={w.width || "half"} onChange={(e) => changeEdit((x) => ({ widgets: x.widgets.map((y) => (y.id === w.id ? { ...y, width: e.target.value as WidgetWidth } : y)) }))}>
          {WIDTH_NAMES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <button className="icon-btn" type="button" aria-label="Edit it" title="Edit it" onClick={() => changeEdit(() => ({ open: w.id }))}>
        <Icon name="pencil" />
      </button>
      <button className="icon-btn" type="button" aria-label="Remove it" title="Remove it" onClick={() => changeEdit((e) => ({ widgets: e.widgets.filter((x) => x.id !== w.id), removed: e.original.some((x) => x.id === w.id) ? [...e.removed, w.id] : e.removed }))}>
        <Icon name="x" />
      </button>
    </div>
  );
}
// A list's items as lines: "text | what's under it".
const listLines = (d: WidgetData) => (d.items || []).map((it) => `${it.text}${it.sub ? ` | ${it.sub}` : ""}`).join("\n");
// A widget's editor: its title, and what it holds as its kind has it (a note's text, a number's fields, a list's
// lines, a link's address), else its data as JSON.
function WidgetEditor({ w }: { w: EditW }) {
  const d = (w.data || {}) as WidgetData & { url?: string; title?: string };
  const field = (key: string, label: string, value: unknown, placeholder?: string, first = false) => (
    <label className="pe-field">
      <span>{label}</span>
      <input name={key} data-pe={key} defaultValue={String(value ?? "")} placeholder={placeholder} autoFocus={first} />
    </label>
  );
  let body: ReactNode;
  if (w.type === "note" || w.type === "doc") body = <textarea className={`pe-text${w.type === "doc" ? " pe-text--long" : ""}`} name="text" data-pe="text" autoFocus placeholder="Markdown: # headings, **bold**, - lists, [links](https://…)" defaultValue={String(d.text || "")} />;
  else if (w.type === "metric")
    body = (
      <>
        <div className="pe-row">
          {field("value", "Value", d.value, undefined, true)}
          {field("unit", "Unit", d.unit, "ms, %, $")}
          {field("change", "Change", d.change, "+8%")}
        </div>
        <div className="pe-row">
          {field("vs", "Compared to", d.vs, "since yesterday")}
          <label className="pe-field">
            <span>Good when it goes</span>
            <select name="good" data-pe="good" defaultValue={d.good || ""}>
              <option value="">Either way</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
            </select>
          </label>
        </div>
      </>
    );
  else if (w.type === "list")
    body = (
      <>
        <textarea className="pe-text" name="lines" data-pe="lines" autoFocus placeholder="One per line. | adds a note under it." defaultValue={listLines(d)} />
        <p className="muted pe-hint">For what needs doing, add Tasks instead: they're on your Tasks list too.</p>
      </>
    );
  else if (w.type === "tasks") body = <p className="muted pe-hint">Its tasks are yours, on your Tasks list: add, tick and edit them on the page.</p>;
  else if (w.type === "link")
    body = (
      <>
        <div className="pe-row">
          {field("url", "Address", d.url, "https://…", true)}
          {field("title", "Its name", d.title)}
        </div>
        {field("text", "A line about it", d.text)}
      </>
    );
  else
    body = (
      <>
        <textarea className="pe-text pe-text--code" name="json" data-pe="json" autoFocus spellCheck={false} defaultValue={JSON.stringify(d, null, 2)} />
        <p className="muted pe-hint">Its data, as the agent wrote it. Or ask an agent to change it.</p>
      </>
    );
  // Done: what's in it goes on the copy being edited.
  const done = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next = applyEditor(new FormData(e.currentTarget), w);
    if (next) changeEdit((x) => ({ widgets: x.widgets.map((y) => (y.id === w.id ? next : y)), open: null }));
  };
  // Cancel: a widget just added and never filled in goes again.
  const cancel = () => changeEdit((x) => ({ widgets: w.fresh ? x.widgets.filter((y) => y.id !== w.id) : x.widgets, open: null }));
  return (
    <form className="pe" onSubmit={done}>
      <label className="pe-field">
        <span>Title</span>
        <input name="title" data-pe="title" defaultValue={w.title || ""} />
      </label>
      {body}
      <div className="pe-acts">
        <button className="btn btn--dark btn--sm" type="submit">
          Done
        </button>
        <button className="btn btn--sm" type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
// Under the widgets while editing: add one of a kind.
function AddWidgetBar() {
  const kinds = [["note", "Note"], ["metric", "Number"], ["tasks", "Tasks"], ["list", "List"], ["doc", "Text"], ["link", "Link"], ["table", "Table"]];
  // A new one, open to fill in.
  const add = (kind: string) => {
    const id = `${kind}-${Date.now().toString(36)}`;
    const width = NEW_WIDGET[kind].width || ({ metric: "quarter", note: "third", list: "third", link: "third", table: "half" }[kind] as WidgetWidth) || "half";
    const w = { id, type: kind, width, stack: null, ...structuredClone(NEW_WIDGET[kind]), fresh: true } as unknown as EditW;
    changeEdit((e) => ({ widgets: [...e.widgets, w], open: id }));
  };
  return (
    <div className="wg-add">
      <b>Add a widget</b>
      {kinds.map(([k, l]) => (
        <button key={k} className="btn btn--sm btn--line" type="button" onClick={() => add(k)}>
          <Icon name="plus" />
          {l}
        </button>
      ))}
    </div>
  );
}
// What's in a widget's editor, on a copy of it. Null (with a toast) if it doesn't make sense.
function applyEditor(form: FormData, w: EditW): EditW | null {
  const val = (k: string) => String(form.get(k) ?? "");
  const data = { ...w.data } as WidgetData & Record<string, unknown>;
  const next: EditW = { ...w, title: val("title").trim(), data };
  if (w.type === "note" || w.type === "doc") data.text = val("text");
  else if (w.type === "metric") for (const k of ["value", "unit", "change", "vs", "good"]) data[k] = val(k).trim() || undefined;
  else if (w.type === "list") {
    // A list is things to read: what needs doing is Tasks. One that was a checklist before is a list now.
    if (data.check) data.check = false;
    data.items = val("lines")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [text, sub] = l.split(" | ");
        return { text: text.trim(), ...(sub ? { sub: sub.trim() } : {}) };
      });
  } else if (w.type === "tasks") {
    // Its tasks are on your list, not in it.
  } else if (w.type === "link") for (const k of ["url", "title", "text"]) data[k] = val(k).trim() || undefined;
  else {
    try {
      next.data = JSON.parse(val("json"));
    } catch {
      toast("That data isn't valid JSON.");
      return null;
    }
  }
  delete next.fresh;
  return next;
}
// Save: what changed, as one version (the widgets changed, the ones taken out, their order, and its title, emoji
// and what it's about), or nothing when nothing did.
export async function saveEdit(p: PageRec) {
  const e = editOf(p);
  if (!e) return;
  const before = new Map(e.original.map((w) => [w.id, JSON.stringify(w)]));
  const widgets = e.widgets.filter((w) => before.get(w.id) !== JSON.stringify(w)).map(({ id, type, title, width, stack, data }) => ({ id, type, title, width, stack: stack || null, data }));
  const order = e.widgets.map((w) => w.id);
  const reordered = order.join("\n") !== e.original.filter((w) => !e.removed.includes(w.id)).map((w) => w.id).join("\n");
  const meta = { title: e.title !== p.title ? e.title : undefined, emoji: e.emoji !== p.emoji ? e.emoji : undefined, about: e.about !== (p.about || "") ? e.about : undefined };
  if (!widgets.length && !e.removed.length && !reordered && !meta.title && !meta.emoji && meta.about === undefined) return setPageUi({ edit: null });
  const r = await post<{ changed?: boolean; version: number }>(`/api/pages/${encodeURIComponent(p.id)}/write`, { widgets, remove: e.removed, order: reordered ? order : undefined, ...meta });
  if (!r.ok) return;
  setPageUi({ edit: null });
  toast(r.data.changed ? `Saved as v${r.data.version}.` : "Nothing changed.");
}
