// Datadog, as a connector with a Data side: a dashboard's panels ask it for metrics, APM
// spans, monitors and events, in Datadog's own query languages, with its owner's API key and application key, on
// their site. It fills no Tasks. Every call it makes reads: the timeseries and spans queries are POSTs that read.
//
// What Datadog's API reference says, as this uses it (checked 2026-11-03):
// - Keys go as DD-API-KEY and DD-APPLICATION-KEY. GET /api/v1/validate checks the API key alone; GET
//   /api/v2/current_user, who the application key is; GET /api/v2/current_user/application_keys (user_app_keys), each
//   of the person's keys' last 4 characters and scopes. An application key with no scopes can do all its user can.
// - metrics: POST /api/v2/query/timeseries (timeseries_query): from and to in ms, an interval in ms Datadog may make
//   larger, queries and formulas; it answers series (group_tags, query_index, unit), times, and values for each.
// - spans: POST /api/v2/spans/analytics/aggregate (apm_read), at most 300 requests an hour: buckets, each with its
//   `by` and its numbers, which the reference lists as both `compute` and `computes` and answers in `compute`
//   (spanValue). A span's @duration is in nanoseconds.
// - monitors: GET /api/v1/monitor/search (monitors_read), with Datadog's monitor search query.
// - events: POST /api/v2/events/search (events_read), with the events search query.
// - In a metric query's {…}, a comma is AND, and it can't be mixed with AND, OR or IN: several values of one tag
//   (`service IN (a, b)`) make the whole filter AND. A tag's value is letters, digits, _ - : . and /.
// - Links into Datadog's web app for a query and range aren't documented; the ones made here are best guesses.

import type { ConnectorConf, DataAnswer, DataQuery, DataSide, KindField } from "../connectors.ts";

// Each site's API host and web app host.
const SITES: Record<string, [string, string]> = {
  "datadoghq.com": ["api.datadoghq.com", "app.datadoghq.com"],
  "us3.datadoghq.com": ["api.us3.datadoghq.com", "us3.datadoghq.com"],
  "us5.datadoghq.com": ["api.us5.datadoghq.com", "us5.datadoghq.com"],
  "datadoghq.eu": ["api.datadoghq.eu", "app.datadoghq.eu"],
  "ap1.datadoghq.com": ["api.ap1.datadoghq.com", "ap1.datadoghq.com"],
  "ap2.datadoghq.com": ["api.ap2.datadoghq.com", "ap2.datadoghq.com"],
  "uk1.datadoghq.com": ["api.uk1.datadoghq.com", "uk1.datadoghq.com"],
  "ddog-gov.com": ["api.ddog-gov.com", "app.ddog-gov.com"],
};
// A stand-in Datadog, for tests (test/fake-datadog.ts).
const STAND_IN = process.env.AGENTBOOK_DATADOG_URL || null;

export const kind = "datadog";
export const name = "Datadog";
export const KEY = "API key";
export const SECRETS: { app_key: string } = { app_key: "application key" };
export const FIELDS: Record<string, KindField> = { site: { of: Object.keys(SITES), default: "datadoghq.com", label: "Site" } };
export const ABOUT = "Metrics, APM spans, monitors and events, for dashboards. An application key scoped to reading is best: timeseries_query, apm_read, monitors_read, events_read, metrics_read.";
// What a key scoped to reading has: anything that says write, manage or delete it doesn't.
const WRITES = /(_write|_manage|_delete|_create|_edit)$/;

type Keys = Pick<ConnectorConf, "key" | "app_key" | "settings">;
const siteOf = (c: Pick<Keys, "settings">) => (SITES[c.settings?.site] ? c.settings.site : "datadoghq.com");
const apiBase = (c: Pick<Keys, "settings">) => STAND_IN || `https://${SITES[siteOf(c)][0]}`;
const appBase = (c: Pick<Keys, "settings">) => `https://${SITES[siteOf(c)][1]}`;

// A call to Datadog's API, its answer (`T`: what that call answers with), or it throws saying what's wrong in words.
async function dd<T>(c: Keys, method: string, path: string, body: unknown = null, { appKey = true } = {}): Promise<T | null> {
  const headers: Record<string, string> = { accept: "application/json", "dd-api-key": c.key };
  if (appKey) headers["dd-application-key"] = c.app_key;
  if (body) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${apiBase(c)}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    throw new Error(`Can't reach Datadog at ${siteOf(c)} (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`);
  }
  const out = (await res.json().catch((): null => null)) as (T & { errors?: unknown }) | null;
  const said = (Array.isArray(out?.errors) ? out.errors.map((e: { detail?: string; title?: string } | string | null) => (typeof e === "string" ? e : e?.detail || e?.title || JSON.stringify(e))).join("; ") : typeof out?.errors === "string" ? out.errors : "") || "";
  if (res.status === 429) {
    const wait = Number(res.headers.get("x-ratelimit-reset"));
    throw Object.assign(new Error(`Datadog says agentbook asked too often${Number.isFinite(wait) && wait > 0 ? `: it can ask again in ${Math.ceil(wait)} s` : ""}.`), { status: 429, budget: true });
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Datadog turned this down${said ? `: ${said}` : ""}.`), { status: 403 });
  if (!res.ok) throw new Error(`Datadog answered HTTP ${res.status}${said ? `: ${said}` : ""}.`);
  return out;
}

// Who the keys sign in as, to show on the Connectors page, and what the application key can do. A key scoped to
// write is refused: dashboards only read. One with no scopes can do all its user can, and says so.
// What the calls below answer with, as much as is read of each.
interface Validated {
  valid?: boolean;
}
interface CurrentUser {
  data?: { attributes?: { name?: string; handle?: string; email?: string } };
  included?: { type?: string; attributes?: { name?: string } }[];
}
interface AppKeys {
  data?: { attributes?: { last4?: string; name?: string; scopes?: string[] | null } }[];
}
export async function check(key: string, c: Keys): Promise<string> {
  const conf = { ...c, key };
  if (!conf.app_key) throw new Error("Paste a Datadog application key too.");
  const v = await dd<Validated>(conf, "GET", "/api/v1/validate", null, { appKey: false }).catch((e) => {
    throw new Error(/turned this down/.test(e.message) ? `Datadog turned the API key down on ${siteOf(conf)}: check it, and the site.` : e.message);
  });
  if (!v?.valid) throw new Error(`Datadog turned the API key down on ${siteOf(conf)}: check it, and the site.`);
  const me = await dd<CurrentUser>(conf, "GET", "/api/v2/current_user").catch((e) => {
    throw new Error(/turned this down/.test(e.message) ? "Datadog turned the application key down: check it, and that it's from the same organization as the API key." : e.message);
  });
  const a = me?.data?.attributes || {};
  const org = (me?.included || []).find((x) => x.type === "orgs")?.attributes?.name;
  const who = `${a.name || a.handle || a.email || "Someone"}${org ? `, in ${org}` : ""}`;
  // Its scopes: from the person's keys, the one whose last 4 match.
  let keys: AppKeys | null;
  try {
    keys = await dd<AppKeys>(conf, "GET", "/api/v2/current_user/application_keys?page%5Bsize%5D=100");
  } catch {
    return `${who}. agentbook can't see the application key's scopes (it would need user_app_keys), so it can't tell whether it can write.`;
  }
  const mine = (keys?.data || []).filter((k) => k.attributes?.last4 === conf.app_key.slice(-4));
  if (mine.length !== 1) return `${who}. agentbook couldn't tell which of your application keys this is, so it can't tell whether it can write.`;
  const scopes = mine[0].attributes.scopes;
  if (!Array.isArray(scopes) || !scopes.length) return `${who}. The application key "${mine[0].attributes.name || "?"}" has no scopes, so it can do all you can in Datadog, writing too. agentbook only reads with it; a key scoped to reading is safer.`;
  const writes = scopes.filter((s) => WRITES.test(s));
  if (writes.length) throw new Error(`The application key "${mine[0].attributes.name || "?"}" can write (${writes.slice(0, 4).join(", ")}). Dashboards only read: make one scoped to reading (timeseries_query, apm_read, monitors_read, events_read, metrics_read).`);
  return `${who}. The application key "${mine[0].attributes.name || "?"}" is scoped to reading (${scopes.slice(0, 6).join(", ")}${scopes.length > 6 ? "…" : ""}).`;
}

/* ---------- variables, in Datadog's languages ---------- */

const VALUE = /^[\p{L}\p{N}_\-:./]+$/u;
const ok = (v: string) => {
  if (!VALUE.test(v)) throw new Error(`"${v}" can't be a Datadog tag's value: those are letters, digits, _ - : . and /.`);
  return v;
};
// A query with its variables filled in. In a metric query, each tag of a {…} filter: one value as it is, all of them
// ("*") left out (an empty filter is {*}), several as `tag IN (a, b)`, which makes the filter AND. In a search
// (spans, monitors, events): `tag:(a OR b)`, and all of them left out. $interval is in seconds, as rollup takes it.
// The variables' values (a value, several, or "*" for all), and the range a query is for (ms).
export type Vars = Record<string, string | string[]>;
export interface FillContext {
  from: number;
  to: number;
  interval: number;
}
export function fill(text: string, vars: Vars, ctx: FillContext, lang: string): string {
  const builtIn = (n: string) => String(n === "interval" ? Math.round(ctx.interval / 1000) : Math.round((n === "from" ? ctx.from : ctx.to) / 1000));
  const one = (name: string) => {
    if (!(name in vars)) throw new Error(`The query uses $${name}, which isn't one of the dashboard's variables (${Object.keys(vars).map((k) => `$${k}`).join(", ") || "it has none"}).`);
    return vars[name];
  };
  const VAR = /\$\{?([a-z][a-z0-9_]*)\}?/g;
  if (lang === "metrics") {
    // Each {…} with a variable, term by term.
    const filled = String(text).replace(/\{([^{}]*\$[^{}]*)\}/g, (_, inner: string) => {
      let multi = false;
      const terms = inner.split(/\s*,\s*/).flatMap((term) => {
        const m = term.match(/^(!?)([\w.\-/:@]+):\$\{?([a-z][a-z0-9_]*)\}?$/);
        if (m && !["from", "to", "interval"].includes(m[3])) {
          const v = one(m[3]);
          if (v === "*") return [];
          if (Array.isArray(v)) {
            multi = true;
            return [`${m[2]} ${m[1] ? "NOT IN" : "IN"} (${v.map(ok).join(", ")})`];
          }
          return [`${m[1]}${m[2]}:${ok(v)}`];
        }
        return [term.replace(VAR, (x, n) => (["from", "to", "interval"].includes(n) ? builtIn(n) : [one(n)].flat().map(ok).join(",")))];
      });
      if (multi && terms.some((t) => t.startsWith("!"))) throw new Error("A filter with several values of a tag can't also have a !tag: Datadog doesn't mix the two. Write NOT IN (…) instead.");
      return `{${terms.length ? terms.join(multi ? " AND " : ", ") : "*"}}`;
    });
    return filled.replace(VAR, (x, n) => (["from", "to", "interval"].includes(n) ? builtIn(n) : [one(n)].flat().map(ok).join(",")));
  }
  // A search: key:$var, a value or (a OR b), or gone for all of them.
  return String(text)
    .replace(/(-?)([\w.\-/@]+):\$\{?([a-z][a-z0-9_]*)\}?/g, (x, neg: string, key: string, n: string) => {
      if (["from", "to", "interval"].includes(n)) return `${neg}${key}:${builtIn(n)}`;
      const v = one(n);
      if (v === "*") return "";
      return Array.isArray(v) ? `${neg}${key}:(${v.map(ok).join(" OR ")})` : `${neg}${key}:${ok(v)}`;
    })
    .replace(VAR, (x, n) => (["from", "to", "interval"].includes(n) ? builtIn(n) : [one(n)].flat().map(ok).join(" OR ")))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ---------- the Data side ---------- */

const labelsOf = (tags: unknown[] | null | undefined): Record<string, string> => Object.fromEntries((tags || []).map((t) => String(t)).map((t) => (t.includes(":") ? [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] : [t, t])));
// A unit as Datadog says it: what over what.
interface DdUnit {
  name?: string;
  short_name?: string;
}
const unitOf = (u: (DdUnit | null)[] | null | undefined) => (Array.isArray(u) && u[0] ? `${u[0].short_name || u[0].name || ""}${u[1] ? `/${u[1].short_name || u[1].name}` : ""}` || null : null);
const ms = (t: number) => (t < 1e12 ? t * 1000 : t);
// The aggregations Datadog lists for spans.
const AGGREGATIONS = ["count", "cardinality", "pc75", "pc90", "pc95", "pc98", "pc99", "sum", "min", "max"];

// What the Data side's calls answer with, as much as is read of each.
interface Timeseries {
  data?: { attributes?: { errors?: string; times?: number[]; series?: { group_tags?: string[]; query_index?: number; unit?: (DdUnit | null)[] | null }[]; values?: (number | null)[][] } };
}
// A spans bucket's numbers, by compute: a total, its points, or either as `{ value }`.
type Computed = number | DdPoint[] | { value?: number | DdPoint[] } | null;
interface DdPoint {
  time: number | string;
  value: number | null;
}
interface BucketBody {
  by?: Record<string, string>;
  compute?: Record<string, Computed>;
  computes?: Record<string, Computed>;
}
export interface Bucket extends BucketBody {
  attributes?: BucketBody;
}
interface Aggregated {
  data?: Bucket[] | { buckets?: Bucket[] };
  meta?: { status?: string };
}
interface MonitorList {
  monitors?: { id: number; name: string; status?: string; type?: string; last_triggered_ts?: number | null }[];
  metadata?: { total_count?: number };
}
interface EventList {
  data?: { attributes?: { timestamp?: string; message?: string; tags?: string[]; attributes?: { timestamp?: number; title?: string; service?: string } } }[];
}
async function metrics(c: ConnectorConf, q: DataQuery): Promise<DataAnswer> {
  const put = (t: string) => fill(t, q.vars, q, "metrics");
  const named: [string, string][] = q.queries ? Object.entries(q.queries) : [[q.name && /^[a-z]\w*$/.test(q.name) ? q.name : "a", q.text]];
  const attributes: { from: number; to: number; interval: number; queries: { data_source: string; query: string; name: string }[]; formulas?: { formula: string }[] } = { from: q.from, to: q.to, interval: q.interval, queries: named.map(([n, t]) => ({ data_source: "metrics", query: put(t), name: n })) };
  if (q.formula) attributes.formulas = [{ formula: q.formula }];
  const r = await dd<Timeseries>(c, "POST", "/api/v2/query/timeseries", { data: { type: "timeseries_request", attributes } });
  const a = r?.data?.attributes || {};
  if (a.errors) throw new Error(`Datadog: ${a.errors}`);
  const times = (a.times || []).map(ms);
  const name = q.formula || (named.length === 1 ? named[0][1] : "");
  const frames = (a.series || []).map((s, i) => ({ name: q.name || (named.length > 1 && !q.formula ? named[s.query_index]?.[0] : "") || "", labels: labelsOf(s.group_tags), unit: unitOf(s.unit), time: times, values: (a.values?.[i] || []).map((v) => (v == null ? null : Number(v))) }));
  return { frames, notes: frames.length ? [] : [`Datadog had no series for ${name.slice(0, 120)} in this range.`] };
}

async function spans(c: ConnectorConf, q: DataQuery): Promise<DataAnswer> {
  const m = String(q.compute || "count").replace(/\s+/g, "").match(/^(\w+)(?:\((@?[\w.]+)\))?$/);
  if (!m || !AGGREGATIONS.includes(m[1])) throw new Error(`compute is like pc95(@duration), max(@duration) or count: one of ${AGGREGATIONS.join(", ")}.`);
  const [, aggregation, metric] = m;
  if (aggregation !== "count" && !metric) throw new Error(`${aggregation} needs a measure: ${aggregation}(@duration).`);
  const duration = metric === "@duration";
  const over = !q.by;
  const compute = { aggregation, ...(metric ? { metric } : {}), type: over ? "timeseries" : "total", ...(over ? { interval: `${Math.round(q.interval / 1000)}s` } : {}) };
  const filter = { from: String(q.from), to: String(q.to), query: fill(q.text || "*", q.vars, q, "spans") || "*" };
  const group_by = q.by ? String(q.by).split(/\s*,\s*/).slice(0, 2).map((facet) => ({ facet, limit: q.limit || 10, sort: { type: "measure", aggregation, ...(metric ? { metric } : {}), order: "desc" } })) : undefined;
  const r = await dd<Aggregated>(c, "POST", "/api/v2/spans/analytics/aggregate", { data: { type: "aggregate_request", attributes: { filter, compute: [compute], ...(group_by ? { group_by } : {}) } } });
  const buckets = Array.isArray(r?.data) ? r.data : r?.data?.buckets || [];
  // A span's @duration is in ns: shown in ms.
  const scale = (v: unknown) => (v == null ? null : duration ? Number(v) / 1e6 : Number(v));
  const unit = duration ? "ms" : null;
  const notes: string[] = r?.meta?.status === "timeout" ? ["Datadog stopped counting before it was done (a timeout): the numbers may be short."] : [];
  // Buckets came back, but with nothing in them this reads: say what they had, rather than draw nothing.
  if (buckets.length && buckets.every((b) => spanValue(b) === undefined)) notes.push(`Datadog's answer had no numbers where agentbook looks for them (a bucket had ${Object.keys(buckets[0]?.attributes || buckets[0] || {}).join(", ") || "nothing"}).`);
  if (over) {
    const pts = spanValue(buckets[0] || {}) || [];
    const list = (Array.isArray(pts) ? pts : []).map((p) => ({ t: typeof p.time === "number" ? ms(p.time) : Date.parse(p.time), v: p.value })).filter((p) => Number.isFinite(p.t));
    return { frames: [{ name: `${aggregation}${metric ? `(${metric})` : ""}`, labels: {}, unit, time: list.map((p) => p.t), values: list.map((p) => scale(p.v)) }], notes };
  }
  const facets = group_by.map((g) => g.facet);
  const col = `${aggregation}${metric && !duration ? `_${metric.replace(/^@/, "")}` : ""}`;
  return { frames: [{ columns: [...facets, col], rows: buckets.map((b) => [...facets.map((f) => (b.attributes?.by || b.by || {})[f] ?? ""), scale(spanValue(b))]), units: unit ? { [col]: unit } : {} }], notes };
}

// A spans bucket's number (a total), or its points (a timeseries: [{ time, value }]). Datadog's reference gives a
// bucket both `compute` and `computes`; its answers have them in `compute` (2026-11-03: tables by service came back
// with their names and no counts, series with no points), so either one, whichever has something in it.
export function spanValue(b: Bucket | null | undefined): Computed | undefined {
  const a = b?.attributes || b || {};
  const cs = [a.compute, a.computes].find((x) => x && typeof x === "object" && Object.keys(x).length) || {};
  const v = cs.c0 ?? Object.values(cs)[0];
  return v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
}

const STATES: Record<string, string> = { Alert: "bad", Warn: "warn", OK: "ok", "No Data": "idle" };
async function monitors(c: ConnectorConf, q: DataQuery): Promise<DataAnswer> {
  const query = fill(q.text || "", q.vars, q, "monitors");
  const r = await dd<MonitorList>(c, "GET", `/api/v1/monitor/search?query=${encodeURIComponent(query)}&per_page=${Math.min(q.limit || 50, 100)}`);
  const list = r?.monitors || [];
  // Alerting first, then warning, no data, ok.
  const rank: Record<string, number> = { bad: 0, warn: 1, idle: 2, ok: 3 };
  const rows = list.map((m) => [m.name, STATES[m.status] || "idle", m.status || "", m.type || "", `${appBase(c)}/monitors/${m.id}`, m.last_triggered_ts ? new Date(ms(m.last_triggered_ts)).toISOString() : ""]).sort((a, b) => rank[a[1]] - rank[b[1]]);
  return { frames: [{ columns: ["name", "status", "state", "type", "link", "last_triggered"], rows }], notes: r?.metadata?.total_count > list.length ? [`${list.length} of ${r.metadata.total_count} monitors.`] : [] };
}

async function events(c: ConnectorConf, q: DataQuery): Promise<DataAnswer> {
  const query = fill(q.text || "", q.vars, q, "events");
  const r = await dd<EventList>(c, "POST", "/api/v2/events/search", { filter: { from: String(q.from), to: String(q.to), query: query || "*" }, sort: "-timestamp", page: { limit: Math.min(q.limit || 50, 200) } });
  const rows = (r?.data || []).map((e) => {
    const a = e.attributes || {};
    const inner = a.attributes || {};
    const time = typeof inner.timestamp === "number" ? ms(inner.timestamp) : Date.parse(a.timestamp);
    return [new Date(time).toISOString(), String(inner.title || a.message || "").slice(0, 200), inner.service || "", (a.tags || []).slice(0, 8).join(" ")];
  });
  return { frames: [{ columns: ["time", "title", "service", "tags"], rows }] };
}

const LANGS: Record<string, (c: ConnectorConf, q: DataQuery) => Promise<DataAnswer>> = { metrics, spans, monitors, events };

// What it has, to look up: metric names that start with `metrics`, a metric's tags, APM services (in `env`).
type Lookup = { metrics?: string | null; tags?: string; services?: boolean; env?: string };
type Found = {
  metrics?: string[];
  metrics_more?: number;
  tags?: Record<string, string[]>;
  services?: string[];
};

export const data: DataSide = {
  // What an agent is told each language is, and what it takes besides text.
  langs: {
    metrics: "a metric query, as in a Datadog graph: avg:trace.http.request.duration{env:$env, service:$service} by {service}. Or queries: { a: '…', b: '…' } with a formula: '100 * a / b'. name: the series' name. $interval is seconds: .rollup(avg, $interval).",
    spans: "an APM span search (service:core-api env:$env @http.status_code:5*), with compute (pc95(@duration), pc99(@duration), count, sum, max; @duration is shown in ms), and by: a facet (resource_name) for a table of the top `limit` (10), or no by for a series over time. At most 300 an hour.",
    monitors: "a monitor search (tag:env:prod, status:alert, type:metric), for a list: each monitor's name, status (bad, warn, idle, ok) and link.",
    events: "an event search (source:github service:$service), for a chart's markers: each event's time and title.",
  },
  budget: { spans: 300 }, // an hour, Datadog's own limit
  at_once: 4,
  async query(c: ConnectorConf, q: DataQuery) {
    const run = LANGS[q.lang];
    if (!run) throw new Error(`Datadog's languages here are ${Object.keys(LANGS).join(", ")}, not "${q.lang}".`);
    const t0 = Date.now();
    const r = await run(c, q);
    return { ...r, ms: Date.now() - t0 };
  },
  // What it has: metric names (that start with `metrics`), a metric's tags and their values (`tags`), APM services.
  async discover(c: ConnectorConf, what: Lookup): Promise<Found> {
    const out: Found = {};
    if (what.metrics != null) {
      const r = await dd<{ metrics?: string[] }>(c, "GET", `/api/v1/metrics?from=${Math.floor(Date.now() / 1000) - 86400}`);
      const prefix = String(what.metrics || "");
      const all = (r?.metrics || []).filter((m) => m.startsWith(prefix));
      out.metrics = all.slice(0, 200);
      if (all.length > 200) out.metrics_more = all.length - 200;
    }
    if (what.tags) {
      const r = await dd<{ data?: { attributes?: { tags?: string[] } } }>(c, "GET", `/api/v2/metrics/${encodeURIComponent(String(what.tags))}/all-tags`);
      const tags = r?.data?.attributes?.tags || [];
      const by: Record<string, string[]> = {};
      for (const t of tags) {
        const i = t.indexOf(":");
        const k = i < 0 ? t : t.slice(0, i);
        (by[k] ||= []).length < 100 && i >= 0 && by[k].push(t.slice(i + 1));
      }
      out.tags = by;
    }
    if (what.services) {
      const r = await dd<{ data?: { attributes?: { services?: string[] } } }>(c, "GET", `/api/v2/apm/services?filter%5Benv%5D=${encodeURIComponent(what.env || "*")}`);
      out.services = (r?.data?.attributes?.services || []).slice(0, 300);
    }
    if (!Object.keys(out).length) throw new Error("Say what to look up: { metrics: 'trace.http' }, { tags: '<metric>' } or { services: true }.");
    return out;
  },
  // The same query and range in Datadog's web app. Its addresses for a query aren't documented: these are guesses
  // that open the right page, with the query if Datadog reads it.
  link(c: ConnectorConf, q: DataQuery) {
    const app = appBase(c);
    const from = q.from;
    const to = q.to;
    try {
      if (q.lang === "metrics") return `${app}/metric/explorer?from_ts=${from}&to_ts=${to}&live=false&exp_query=${encodeURIComponent(fill(q.text || Object.values(q.queries || {})[0] || "", q.vars, q, "metrics"))}`;
      if (q.lang === "spans") return `${app}/apm/traces?query=${encodeURIComponent(fill(q.text || "*", q.vars, q, "spans"))}&start=${from}&end=${to}&paused=true`;
      if (q.lang === "monitors") return `${app}/monitors/manage?q=${encodeURIComponent(fill(q.text || "", q.vars, q, "monitors"))}`;
      if (q.lang === "events") return `${app}/event/explorer?query=${encodeURIComponent(fill(q.text || "", q.vars, q, "events"))}&from_ts=${from}&to_ts=${to}&live=false`;
    } catch {}
    return app;
  },
};
