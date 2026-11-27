#!/usr/bin/env node
// Dashboards, phase 1: a Datadog connector set up on a real agentbook, against a stand-in
// Datadog (fake-datadog.ts). An agent finds what it can ask (ab_source), tries a query, and writes a dashboard whose
// panels hold queries, never numbers (ab_dashboard_write): each new panel is test-run, and a write whose panels fail
// isn't saved. Whoever looks picks the range and variables; agentbook runs the queries with the owner's keys, keeps
// each answer for everyone a while, sends slow ones on the page's stream, shows the last good answer when Datadog
// fails, and never makes a version of a refresh. A page tool, a routine or a hand edit can't put numbers on one.
// Run: node test/dashboards.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dashFrom, intervalFor, panelFrom, picked, rangeOf, roundRange, shapeAnswer, varsFrom } from "../plugin/shared/dashboards.ts";
import { fill, spanValue } from "../server/integrations/connectors/datadog.ts";
import { startDatadog } from "./fake-datadog.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import { closeSql, sql } from "./harness-sql.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-dashboards-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4800);
const URL = `http://127.0.0.1:${PORT}`;
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string, more = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && more ? `\n      ${more}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });

// ---------- the parts that need no server ----------
{
  const now = Date.parse("2026-11-03T14:03:10Z");
  const r = rangeOf({ range: "24h" }, now);
  const iv = intervalFor(r.from, r.to);
  const rr = roundRange(r, iv);
  check(iv === 900e3 && intervalFor(0, 7 * 864e5) === 7200e3 && intervalFor(0, 3600e3) === 60e3 && intervalFor(0, 90 * 864e5) === 864e5, "a range gets an interval of about 100 points: 15 min for 24 hours, 2 h for 7 days, 1 min for an hour, a day for 90 days");
  check(rr.to === Date.parse("2026-11-03T14:15:00Z") && rr.to - rr.from === 96 * 900e3, "a range runs rounded to its interval, so people looking seconds apart ask the same thing");
  let threw = null;
  try {
    rangeOf({ range: "forever" });
  } catch (e) {
    threw = e.message;
  }
  check(/A range is like/.test(threw || ""), "a range that isn't one says what one is");
  const vars = varsFrom([{ id: "env", values: ["prod", "staging"], default: "prod", all: false }, { id: "service", values: ["core-api", "ledger", "erp-sync"], multi: true }]);
  check(JSON.stringify(picked(vars, { env: "nope", service: "core-api,ledger" })) === '{"env":"prod","service":["core-api","ledger"]}' && picked(vars, {}).service === "*", "what's picked is a variable's values, or its default (all of them, \"*\", unless it says otherwise)");
  threw = null;
  try {
    varsFrom([{ id: "interval", values: ["a"] }]);
  } catch (e) {
    threw = e.message;
  }
  check(/built in/.test(threw || ""), "a dashboard can't have a variable called $interval: it's built in");
  threw = null;
  try {
    panelFrom({ id: "m", type: "metric", title: "p95", data: { value: 412 } });
  } catch (e) {
    threw = e.message;
  }
  check(/numbers come from its query/.test(threw || "") && /needs a query/.test(threw || ""), "a panel with numbers and no query is refused, and says why");
  const notes = [];
  const c = panelFrom({ id: "c", type: "chart", query: { source: "datadog", lang: "metrics", text: "x{*}" }, shape: { series: "labels.service", colour: "red" } }, null, notes);
  check(c.data && !Object.keys(c.data).length && c.shape.series === "labels.service" && /left out shape.colour/.test(notes[0] || ""), "a panel keeps its query and shape, no data, and says what it left out");
  const t = [0, 1, 2].map((i) => i * 60e3);
  const m = panelFrom({ id: "m", type: "metric", query: { source: "d", lang: "metrics", text: "x" }, shape: { compare: "previous", good: "down" }, thresholds: { warn: 400, bad: 800 } });
  const md = shapeAnswer(m, [{ name: "p95", unit: "ms", time: t, values: [300, 380, 500] }], { before: [{ time: t, values: [200, 250, 250] }] });
  check(md.value === "500" && md.unit === "ms" && md.change === "+100%" && md.status === "warn" && md.series.length === 3, "a number is its series' last value, with its change against the period before and where it stands against its thresholds", JSON.stringify(md));
  const tb = panelFrom({ id: "t", type: "table", query: { source: "d", lang: "spans", text: "*", by: "resource_name" }, shape: { columns: { resource_name: "Endpoint", pc95: "p95" }, sort: "-pc95", limit: 2 }, thresholds: { warn: 400, bad: 800 } });
  const td = shapeAnswer(tb, [{ columns: ["resource_name", "pc95"], rows: [["GET /a", 300], ["GET /b", 950], ["GET /c", 500]], units: { pc95: "ms" } }]);
  check(JSON.stringify(td) === '{"columns":["Endpoint","p95"],"rows":[["GET /b",{"status":"bad","text":"950 ms"}],["GET /c",{"status":"warn","text":"500 ms"}]]}', "a table is its columns as the shape names them, sorted, cut, in units, its numbers coloured by the thresholds", JSON.stringify(td));
  const ctx = { interval: 900e3, from: 0, to: 0 };
  check(fill("p95:x{env:$env, service:$service} by {service}.rollup(avg, $interval)", { env: "prod", service: ["core-api", "ledger"] }, ctx, "metrics") === "p95:x{env:prod AND service IN (core-api, ledger)} by {service}.rollup(avg, 900)", "in a Datadog metric query, several values of a tag are IN (…), which makes the filter AND; $interval is seconds");
  check(fill("avg:x{env:$env, service:$service}", { env: "prod", service: "*" }, ctx, "metrics") === "avg:x{env:prod}" && fill("avg:x{service:$service}", { service: "*" }, ctx, "metrics") === "avg:x{*}", "all of a tag's values leave it out of the filter ({*} when none are left)");
  check(fill("service:$service env:$env", { env: "prod", service: ["a", "b"] }, ctx, "spans") === "service:(a OR b) env:prod", "in a search, several values are (a OR b)");
  const pts = [{ time: "2026-11-03T02:30:00Z", value: 4 }];
  check(spanValue({ attributes: { by: { service: "a" }, compute: { c0: 12 } } }) === 12 && spanValue({ attributes: { by: {}, computes: { c0: 12 } } }) === 12 && spanValue({ attributes: { compute: { c0: 12 }, computes: {} } }) === 12 && spanValue({ attributes: { compute: { c0: pts } } }) === pts && spanValue({ attributes: { computes: { c0: { value: 7 } } } }) === 7 && spanValue({ attributes: { by: {} } }) === undefined, "a spans bucket's number or points are read from compute (as Datadog answers) or computes (as its reference also says), whichever has them");
  threw = null;
  try {
    fill("x{service:$service}", { service: "a}, env:*" }, ctx, "metrics");
  } catch (e) {
    threw = e.message;
  }
  check(/can't be a Datadog tag's value/.test(threw || ""), "a value that would change the query is refused");
  check(dashFrom({ range: "7d" }).range === "7d" && dashFrom({}).range === "24h", "a dashboard opens on 24 hours, or the range it says");
}

// ---------- the server ----------
const dd = await startDatadog();
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), AGENTBOOK_CLAUDE_ROUTINES: "0", AGENTBOOK_DATADOG_URL: dd.url, AGENTBOOK_PANEL_KEEP_MS: "1500", AGENTBOOK_CONNECTOR_TICK_MS: "60000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];
let server;
async function start() {
  server = spawnAgentbook({ env, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
// The answers agentbook-server keeps for a panel (or all of them), read from its database.
// A row of panel_kept, as it's kept.
type KeptRow = { page: string; panel: string; view: string; def: string; conn: string | null; own: number; at: string; used: number; answer: string };
function keptRows(panel: string | null = null) {
  const db = sql(path.join(HOME, "storage.db"));
  return (panel ? db.prepare("select * from panel_kept where page = 'checkout-health' and panel = ?").all(panel) : db.prepare("select * from panel_kept").all()) as KeptRow[];
}
async function stop() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}

await start();
try {
  const herval = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  const claude = agent("box-1");

  const none = await claude.get("/sources");
  check(none.status === 200 && Array.isArray(none.sources) && !none.sources.length, "with no connector, an agent hears there's no source to ask");

  // Setting Datadog up: its keys are checked, a key that can write is refused, and the site is kept.
  const kinds = (await herval.get("/api/connectors")).kinds || [];
  const kind = kinds.find((k) => k.kind === "datadog");
  check(kind?.data && !kind.tasks && kind.secrets?.app_key && kind.fields?.site?.of.includes("us5.datadoghq.com"), "Datadog is a kind of connector with a Data side, a second key and a site, and no Tasks");
  dd.set({ scopes: ["timeseries_query", "dashboards_write"] });
  const writes = await herval.post("/api/connectors", { kind: "datadog", api_key: dd.apiKey, app_key: dd.appKey, settings: { site: "us5.datadoghq.com" } });
  check(writes.status === 400 && /can write \(dashboards_write\)/.test(writes.error || ""), "an application key scoped to write is refused: dashboards only read", writes.error);
  dd.set({ scopes: ["timeseries_query", "apm_read", "monitors_read", "events_read", "metrics_read"] });
  const wrongKey = await herval.post("/api/connectors", { kind: "datadog", api_key: "nope", app_key: dd.appKey });
  check(wrongKey.status === 400 && /turned the API key down/.test(wrongKey.error || ""), "a wrong API key is turned down, and says to check it and the site", wrongKey.error);
  const saved = await herval.post("/api/connectors", { kind: "datadog", api_key: dd.apiKey, app_key: dd.appKey, settings: { site: "us5.datadoghq.com" } });
  check(saved.status === 200 && saved.connector?.id === "datadog" && /Herval, in Acme\. The application key "agentbook" is scoped to reading/.test(saved.connector.who || "") && saved.connector.settings?.site === "us5.datadoghq.com" && !("app_key" in saved.connector) && saved.connector.app_key_set, "a key scoped to reading is kept: who it is, its site, and never its keys back", JSON.stringify(saved));

  const listed = await claude.get("/sources");
  check(listed.sources?.length === 1 && listed.sources[0].id === "datadog" && listed.sources[0].langs.metrics && listed.sources[0].langs.spans && listed.sources[0].site === "us5.datadoghq.com", "an agent lists its person's sources and their languages");
  const found = await claude.post("/sources/discover", { source: "datadog", what: { metrics: "trace.http", tags: "trace.http.request.duration", services: true } });
  check(found.found?.metrics?.length === 3 && found.found.tags?.service?.includes("erp-sync") && found.found.services?.includes("checkout-web"), "it finds metric names, a metric's tags and their values, and services", JSON.stringify(found));
  const tried = await claude.post("/sources/query", { query: { source: "datadog", lang: "metrics", text: "p95:trace.http.request.duration{env:$env} by {service}" }, view: { range: "1h", vars: { env: "prod" } } });
  const sent = dd.calls.filter((c) => c.path === "/api/v2/query/timeseries").at(-1)?.body?.data?.attributes;
  check(tried.frames?.length === 4 && tried.frames[0].labels.service && tried.frames[0].unit === "ms" && tried.frames[0].time.length >= 55 && sent?.queries[0].query === "p95:trace.http.request.duration{env:prod} by {service}" && sent.interval === 60e3, "a query tried once comes back as frames, its variables filled in, for an hour at a minute a point", JSON.stringify(sent));
  const spanTable = await claude.post("/sources/query", { query: { source: "datadog", lang: "spans", text: "env:$env", compute: "count", by: "service", limit: 3 }, view: { range: "24h", vars: { env: "prod" } } });
  const spanSeries = await claude.post("/sources/query", { query: { source: "datadog", lang: "spans", text: "env:$env status:error", compute: "count" }, view: { range: "24h", vars: { env: "prod" } } });
  check(spanTable.frames?.[0]?.rows?.length === 3 && spanTable.frames[0].rows.every((r) => typeof r[1] === "number" && r[1] > 0) && spanSeries.frames?.[0]?.time?.length === 3 && spanSeries.frames[0].values.every((v) => v > 0) && !spanTable.notes?.length, "spans answered as Datadog does (numbers in compute) come back as a table of counts and a series with its points", JSON.stringify({ spanTable, spanSeries }).slice(0, 400));
  dd.set({ computes: true });
  const spanOld = await claude.post("/sources/query", { query: { source: "datadog", lang: "spans", text: "env:prod", compute: "count", by: "service", limit: 2 }, view: { range: "1h" } });
  dd.set({ computes: false });
  check(spanOld.frames?.[0]?.rows?.every((r) => r[1] > 0), "and in computes, as Datadog's reference also has it", JSON.stringify(spanOld).slice(0, 300));

  // Writing one: numbers are refused, a failing panel keeps it from being saved, and a test saves nothing.
  const VARS = [{ id: "env", label: "Env", values: ["prod", "staging"], default: "prod", all: false }, { id: "service", label: "Service", values: ["core-api", "ledger", "erp-sync", "checkout-web"], multi: true }];
  const PANELS = [
    { id: "m_p95", type: "metric", title: "Latency p95", query: { source: "datadog", lang: "metrics", text: "p95:trace.http.request.duration{env:$env, service:$service}" }, shape: { reduce: "avg", unit: "ms", compare: "previous", good: "down" }, thresholds: { warn: 400, bad: 800 } },
    { id: "m_err", type: "metric", title: "Error rate", query: { source: "datadog", lang: "metrics", queries: { a: "sum:trace.http.request.errors{env:$env, service:$service}.as_count()", b: "sum:trace.http.request.hits{env:$env, service:$service}.as_count()" }, formula: "100 * a / b" }, shape: { unit: "%", good: "down" } },
    { id: "c_p95", type: "chart", title: "Latency p95 by service", query: { source: "datadog", lang: "metrics", text: "p95:trace.http.request.duration{env:$env, service:$service} by {service}.rollup(avg, $interval)" }, shape: { series: "labels.service", unit: "ms" }, thresholds: { warn: 400, bad: 800 }, markers: { source: "datadog", lang: "events", text: "service:$service" } },
    { id: "t_slow", type: "table", title: "Slowest endpoints", width: "half", query: { source: "datadog", lang: "spans", text: "env:$env service:$service", compute: "pc95(@duration)", by: "resource_name", limit: 10 }, shape: { columns: { resource_name: "Endpoint", pc95: "p95" }, sort: "-pc95", limit: 3 }, thresholds: { warn: 400, bad: 800 } },
    { id: "l_mon", type: "list", title: "Monitors", query: { source: "datadog", lang: "monitors", text: "tag:env:$env" }, shape: { sub: "type" } },
    { id: "about", type: "note", title: "What this is", data: { text: "Checkout's health, from Datadog." } },
  ];
  const numbers = await claude.post("/dashboards", { title: "Checkout health", vars: VARS, panels: [{ id: "m", type: "metric", title: "p95", data: { value: 412, unit: "ms" } }] });
  check(numbers.status === 400 && /numbers come from its query/.test(numbers.error || ""), "an agent that writes numbers on a dashboard is told to write a query");
  const broken = await claude.post("/dashboards", { title: "Checkout health", vars: VARS, panels: [...PANELS, { id: "c_bad", type: "chart", title: "Typo", query: { source: "datadog", lang: "metrics", text: "avg:no.such.metric{env:$env}" } }] });
  check(broken.status === 400 && /Nothing was saved: a panel failed its test run/.test(broken.error || "") && /c_bad: failed: Datadog answered HTTP 400: Error parsing query/.test(broken.error) && /m_p95: \d/.test(broken.error), "a panel that fails its test run keeps the dashboard from being saved, and the answer says what each panel drew", broken.error);
  check(!(await herval.get("/api/state")).pages?.some?.((p) => p.title === "Checkout health"), "so there's no dashboard yet");
  const test = await claude.post("/dashboards", { title: "Checkout health", vars: VARS, panels: PANELS, test: true });
  check(test.test && test.tests.lines.length === 5 && !(await herval.get("/api/pages/checkout-health")).id, "test: true runs its panels and saves nothing");
  const made = await claude.post("/dashboards", { title: "Checkout health", vars: VARS, range: "24h", panels: PANELS, summary: "Latency, errors, slow endpoints and monitors" });
  const lines = made.tests?.lines || [];
  check(made.created && made.id === "checkout-health" && made.version === 1, "an agent makes a dashboard", JSON.stringify(made));
  check(lines.some((l) => /^m_p95: [\d,]+ ms \([+−][\d.]+%\)/.test(l)) && lines.some((l) => /^c_p95: 4 series of 9\d points: (?=.*core-api)(?=.*ledger)/.test(l)) && lines.some((l) => /^t_slow: 3 rows, the first \["POST \/checkout",\{"status":"bad","text":"1,820 ms"\}\]/.test(l)) && lines.some((l) => /^l_mon: 3 items, the first "core-api p95 over 800 ms"/.test(l)) && lines.some((l) => /^m_err: [\d.]+ %/.test(l)), "its test run says what each panel drew: a number with its change, a chart's series and points, a table's first row, a list's first item", lines.join("\n"));

  const page = await herval.get("/api/pages/checkout-health");
  check(page.kind === "dashboard" && page.dash?.vars?.length === 2 && page.dash.range === "24h" && page.widgets.find((w) => w.id === "c_p95")?.query?.lang === "metrics" && !Object.keys(page.widgets.find((w) => w.id === "m_p95").data).length, "it's a page of kind dashboard: its variables, its range, and panels with queries and no numbers");

  // Its card on the feed and its tile in Dashboards: its own view's last answers (its test run's), small, kept on the
  // server, so drawing them asks Datadog nothing.
  const callsBefore = dd.calls.length;
  const card = (await stateOf(herval.get)).pages?.find((p) => p.id === "checkout-health");
  const cf = card?.face || {};
  check(cf.m_p95?.data?.value && cf.m_p95.at && cf.c_p95?.data?.series?.length === 1 && cf.c_p95.data.series[0].values.length === 24 && cf.t_slow?.data?.rows?.length === 3 && cf.l_mon?.data?.items?.length === 3 && dd.calls.length === callsBefore, "its card carries its own view's last answers, small (a chart's line in 24 points), and drawing it asks Datadog nothing", JSON.stringify(cf).slice(0, 400));
  check(JSON.stringify(cf).length < 3000, "and it stays small: under 3 KB for five panels", `${JSON.stringify(cf).length} bytes`);

  // Looking at it: the owner's keys answer, for the range and variables picked.
  const before = dd.calls.length;
  const view = await herval.post("/api/pages/checkout-health/panels", { range: "24h", vars: { env: "prod", service: ["core-api", "ledger"] } });
  const ts = dd.calls.slice(before).filter((c) => c.path === "/api/v2/query/timeseries").map((c) => c.body.data.attributes);
  const chart = view.panels?.find((p) => p.id === "c_p95");
  check(view.status === 200 && view.panels.length === 5 && view.view.interval === "15m" && view.view.range === "24h", "the page asks for its panels for 24 hours, at 15 minutes a point");
  check(ts.some((a) => a.queries[0].query === "p95:trace.http.request.duration{env:prod AND service IN (core-api, ledger)} by {service}.rollup(avg, 900)" && a.interval === 900e3), "each query has the picked services in it, as Datadog takes them", JSON.stringify(ts.map((a) => a.queries[0].query)));
  check(chart.data.series.length === 2 && chart.data.series.map((s) => s.name).join() === "core-api,ledger" && chart.data.target?.value === 800 && chart.data.markers?.[0]?.label === "core-api a41c9e deployed" && chart.source?.name === "Datadog" && /^https:\/\/us5\.datadoghq\.com\/metric\/explorer\?/.test(chart.link || ""), "a chart draws a line per service picked, its threshold, a deploy marker, where it's from and a link into Datadog on its site", JSON.stringify({ ...chart, data: { ...chart.data, x: chart.data.x.length, times: undefined, series: chart.data.series.map((s) => s.name) } }));
  const asked = dd.calls.length;
  const again = await herval.post("/api/pages/checkout-health/panels", { range: "24h", vars: { env: "prod", service: ["core-api", "ledger"] } });
  check(dd.calls.length === asked && again.panels.every((p) => p.cached), "asked again at once, every answer is the one kept, and Datadog isn't asked");
  const cmp = await herval.post("/api/pages/checkout-health/panels", { range: "24h", vars: { env: "prod", service: "core-api" }, compare: true, panels: ["c_p95"] });
  check(cmp.panels[0].data.series.some((s) => s.before && s.name === "core-api (before)"), "Compare adds the period before to a chart");
  check((await herval.get("/api/pages/checkout-health")).version === 1, "looking at it makes no version");

  // Datadog failing: the last good answer, greyed, with why.
  await sleep(1600);
  dd.set({ fail: "timeseries" });
  const down = await herval.post("/api/pages/checkout-health/panels", { range: "24h", vars: { env: "prod", service: ["core-api", "ledger"] }, panels: ["c_p95"] });
  check(down.panels[0].stale && /HTTP 500/.test(down.panels[0].error || "") && down.panels[0].data.series.length === 2, "when Datadog fails, a panel shows its last good answer, saying it's old and why", JSON.stringify(down.panels[0]).slice(0, 300));
  const never = await herval.post("/api/pages/checkout-health/panels", { range: "7d", panels: ["c_p95"] });
  check(never.panels[0].error && !never.panels[0].stale && !never.panels[0].data, "one it never answered says it failed, with nothing made up");
  dd.set({ fail: null });

  // Slow ones come on the page's stream, as they're answered.
  const stream = await fetch(`${URL}/api/live?live=dashboard-test-1`, { headers: { cookie: herval.cookie } });
  const reader = stream.body.getReader();
  let heard = "";
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      heard += new TextDecoder().decode(value);
    }
  })();
  await sleep(200);
  dd.set({ delay: 400 });
  await sleep(1600);
  const quick = await herval.post("/api/pages/checkout-health/panels", { range: "12h", live: "dashboard-test-1", key: "view-12h", panels: ["m_p95", "l_mon"] });
  check(quick.status === 200 && quick.pending?.length === 2 && !quick.panels.length, "with the page's stream, panels that take a while are said to be coming", JSON.stringify(quick));
  const got = await (async () => {
    for (let i = 0; i < 40; i++) {
      if ((heard.match(/event: panel/g) || []).length >= 2) return true;
      await sleep(100);
    }
    return false;
  })();
  check(got && /"key":"view-12h"/.test(heard) && /"id":"l_mon"/.test(heard) && /"page":"checkout-health"/.test(heard), "and each comes on it as a panel event, with the view it was asked for");
  // Opened again once they're old: drawn at once from what's kept, dated, while Datadog is asked behind them.
  await sleep(1600);
  const reopened = await herval.post("/api/pages/checkout-health/panels", { range: "12h", live: "dashboard-test-1", key: "view-12h-again", panels: ["m_p95", "l_mon"] });
  check(reopened.pending?.length === 2 && reopened.panels?.length === 2 && reopened.panels.every((a) => a.refreshing && a.data && a.at), "opened again once its answers are old, every panel draws at once from the one kept, dated, while Datadog is asked again", JSON.stringify(reopened).slice(0, 300));
  const renewed = await (async () => {
    for (let i = 0; i < 40; i++) {
      if ((heard.match(/"key":"view-12h-again"/g) || []).length >= 2) return true;
      await sleep(100);
    }
    return false;
  })();
  check(renewed, "and the new answers come on the stream as they're answered");
  dd.set({ delay: 0 });
  reader.cancel().catch(() => {});
  await reading.catch(() => {});

  // What else could put numbers on it can't.
  const pageWrite = await claude.post("/pages", { page: "checkout-health", widgets: [{ id: "m_p95", type: "metric", data: { value: 1 } }] });
  check(pageWrite.status === 400 && /is a dashboard/.test(pageWrite.error || ""), "ab_page_write on a dashboard says ab_dashboard_write changes it");
  const routine = await claude.post("/pages/checkout-health/routines", { name: "Numbers", schedule: "30m", keeps: ["m_p95"], code: "export default async () => ({ widgets: [] })", test: true });
  check(routine.status === 400 && /needs no routine/.test(routine.error || ""), "a routine on a dashboard is refused: its panels run their own queries", routine.error);
  const hand = await herval.post("/api/pages/checkout-health/write", { widgets: [{ id: "m_p95", type: "metric", data: { value: 1 } }] });
  check(hand.status === 400, "a hand edit can't put numbers on a panel");

  // Changing a query is a version that says so; ab_page_read gives the queries and what they answered.
  const changed = await claude.post("/dashboards", { dashboard: "checkout-health", panels: [{ id: "c_p95", query: { source: "datadog", lang: "metrics", text: "p99:trace.http.request.duration{env:$env, service:$service} by {service}.rollup(max, $interval)" }, title: "Latency p99 by service" }], summary: "p99 instead of p95" });
  const hist = await herval.get("/api/pages/checkout-health");
  check(changed.version === 2 && changed.tests.lines.length === 1 && hist.history[0].changes.some((c) => c.id === "c_p95" && /new query/i.test(c.text || "")), "changing a panel's query is a version that says so, and only that panel runs", JSON.stringify(hist.history?.[0]?.changes));
  const read = await claude.get("/pages/checkout-health");
  const rp = read.panels?.find((p) => p.id === "c_p95");
  check(read.kind === "dashboard" && rp?.query?.text.startsWith("p99:") && rp.answer?.data?.series?.length === 4 && read.view?.range === "24h", "ab_page_read gives a dashboard's panels, their queries and what each answered", JSON.stringify(rp).slice(0, 300));
  check((await claude.get("/pages")).pages?.find((p) => p.id === "checkout-health")?.kind === "dashboard", "ab_page_list says it's a dashboard");
  check(keptRows("c_p95").length && new Set(keptRows("c_p95").map((r) => r.def)).size === 1, "a panel whose query changed keeps only answers to its new one", JSON.stringify(keptRows("c_p95")));

  // Kept small: a moving window overwrites its row, a panel keeps its own view and the 3 others looked at last, and
  // a chart's answer is stored compressed.
  for (const range of ["15m", "1h", "4h", "2d", "7d", "24h", "24h"]) await herval.post("/api/pages/checkout-health/panels", { range, panels: ["c_p95"] });
  const rows = keptRows("c_p95");
  check(rows.length === 4 && rows.filter((r) => r.own).length === 1 && rows.some((r) => r.answer.startsWith("z:")) && rows.every((r) => r.answer.length < 64 * 1024), "a panel keeps an answer for its own view and the 3 others looked at last, a chart's compressed", JSON.stringify(rows.map((r) => ({ own: r.own, bytes: r.answer.length }))));

  // Someone else sees it once it's public, and their looking uses its owner's connector, not theirs.
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  check((await alice.post("/api/pages/checkout-health/panels", {})).status === 404, "a private dashboard isn't someone else's to ask");
  // Public is for its owner's contacts.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await herval.post("/api/people/alice/contact", { act: "yes" });
  await herval.post("/api/pages/checkout-health/visibility", { visibility: "public" });
  const theirs = await alice.post("/api/pages/checkout-health/panels", { range: "4h" });
  check(theirs.status === 200 && theirs.panels.find((p) => p.id === "c_p95")?.data?.series?.length === 4 && !(await alice.get("/api/connectors")).connectors?.length, "once it's public, his contact's looking asks with its owner's connector");

  // A restart keeps the dashboard, and the connector's keys.
  await stop();
  await start();
  const after = await herval.post("/api/pages/checkout-health/panels", { range: "24h", panels: ["m_p95"] });
  check(after.status === 200 && after.panels[0].data?.value && (await herval.get("/api/connectors")).connectors?.[0]?.app_key_set, "after a restart it answers as before, with the keys it kept");
  check(Object.keys((await stateOf(herval.get)).pages?.find((p) => p.id === "checkout-health")?.face || {}).length >= 4, "and its card still draws its last answers");

  const removed = await herval.post("/api/connectors/datadog/delete");
  check(removed.status === 200 && !keptRows().length && !Object.keys((await stateOf(herval.get)).pages?.find((p) => p.id === "checkout-health")?.face || {}).length, "a connector removed takes the answers it gave with it", JSON.stringify(keptRows().length));
} finally {
  await stop().catch(() => {});
  await dd.close();
  closeSql();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
