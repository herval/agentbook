// A stand-in Datadog, for the dashboards' tests (test/dashboards.ts): the endpoints agentbook's Datadog connector
// asks (server/integrations/connectors/datadog.ts), answering as Datadog's API reference says they do, with numbers
// made up from Acme's store (core-api, ledger, erp-sync, checkout-web). It keeps what it was asked (`calls`).
//
// startDatadog({ apiKey, appKey, scopes }) -> { url, calls, set(opts), close() }
// - scopes: the application key's (null: unscoped). set({ fail: "timeseries" | "all", delay: ms, scopes, computes }):
//   computes: spans answer their numbers in `computes` rather than `compute`.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "./harness-types.ts";

export const SERVICES = ["core-api", "ledger", "erp-sync", "checkout-web"];
const BASE: Record<string, number> = { "core-api": 420, ledger: 180, "erp-sync": 610, "checkout-web": 260 };
const METRICS = ["trace.http.request.duration", "trace.http.request.hits", "trace.http.request.errors", "system.cpu.user", "orders.placed"];

// The services a query's {…} picks: service:x, service IN (a, b), or all of them.
function servicesIn(query: string): string[] {
  const f = (query.match(/\{([^}]*)\}/) || [, "*"])[1];
  const inList = f.match(/service IN \(([^)]*)\)/);
  if (inList) return inList[1].split(",").map((s) => s.trim());
  const one = f.match(/service:([\w.\-/]+)/);
  return one ? [one[1]] : SERVICES;
}
// A made-up number for a service at a time: its base, a daily wave, and on core-api a bump in the last 3 hours.
type Kind = "hits" | "errors" | "duration";
const wave = (svc: string, t: number, kind: Kind) => {
  const base = BASE[svc] ?? 100;
  const day = Math.sin((t / 86400e3) * 2 * Math.PI) * 0.15 + 1;
  const bump = svc === "core-api" && Date.now() - t < 3 * 3600e3 ? (kind === "errors" ? 3 : 1.4) : 1;
  const v = (kind === "hits" ? base * 10 * day : kind === "errors" ? base * 0.02 * day : base * day) * bump;
  return Math.round(v * 100) / 100;
};
const kindOf = (q: string): Kind => (/hits/.test(q) ? "hits" : /errors/.test(q) ? "errors" : "duration");

// What agentbook sends: a timeseries query or a spans aggregate (data.attributes), or an events search (filter).
interface DdBody {
  data?: {
    attributes?: {
      interval?: number;
      from?: number;
      to?: number;
      queries?: { query: string }[];
      formulas?: { formula: string }[];
      group_by?: { facet: string; limit: number }[];
      filter?: { from: string | number; to?: string | number };
    };
  };
  filter?: { from: string | number; to: string | number };
}
// What a test makes it do (see above).
interface DdOpts {
  fail: "timeseries" | "all" | "429" | null;
  delay: number;
  scopes: string[] | null;
  computes?: boolean;
}

export async function startDatadog({ apiKey = "dd-api-0123456789abcdef", appKey = "dd-app-0123456789abcdef0123", scopes = ["timeseries_query", "apm_read", "monitors_read", "events_read", "metrics_read"], port = 0 }: { apiKey?: string; appKey?: string; scopes?: string[] | null; port?: number } = {}) {
  // `body` is what agentbook sent.
  const calls: { method: string; path: string; query: Record<string, string>; body: Json; at: number }[] = [];
  const opts: DdOpts = { fail: null, delay: 0, scopes };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body: DdBody | null = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, at: Date.now() });
    const send = (status: number, o: unknown) => {
      res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "x-ratelimit-reset": "42", "x-ratelimit-limit": "300", "x-ratelimit-remaining": "0", "x-ratelimit-period": "3600" } : {}) });
      res.end(JSON.stringify(o));
    };
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (req.headers["dd-api-key"] !== apiKey) return send(403, { errors: ["Forbidden"] });
    if (url.pathname === "/api/v1/validate") return send(200, { valid: true });
    if (req.headers["dd-application-key"] !== appKey) return send(403, { errors: ["Forbidden"] });
    if (opts.fail === "all") return send(500, { errors: ["Internal Server Error"] });
    if (opts.fail === "429") return send(429, { errors: ["Too many requests"] });
    if (url.pathname === "/api/v2/current_user") return send(200, { data: { type: "users", attributes: { name: "Herval", handle: "herval@acme.test", email: "herval@acme.test" } }, included: [{ type: "orgs", attributes: { name: "Acme" } }] });
    if (url.pathname === "/api/v2/current_user/application_keys") return send(200, { data: [{ id: "k1", type: "application_keys", attributes: { name: "agentbook", last4: appKey.slice(-4), scopes: opts.scopes } }, { id: "k2", type: "application_keys", attributes: { name: "terraform", last4: "zzzz", scopes: null } }] });
    if (url.pathname === "/api/v2/query/timeseries" && req.method === "POST") {
      if (opts.fail === "timeseries") return send(500, { errors: ["Internal Server Error"] });
      const a = body.data.attributes;
      const interval = Math.max(a.interval || 60e3, 15e3);
      const times: number[] = [];
      for (let t = Math.ceil(a.from / interval) * interval; t < a.to; t += interval) times.push(t);
      const series: { group_tags: string[]; query_index: number; unit: ({ short_name: string; name: string } | null)[] | null }[] = [];
      const values: number[][] = [];
      const qs = a.queries;
      for (const q of qs) if (/no\.such\.metric/.test(q.query)) return send(400, { errors: [`Error parsing query: unknown metric in ${q.query}`] });
      const by = /by \{service\}/.test(qs[0].query);
      const svcs = by ? servicesIn(qs[0].query) : [null];
      for (const svc of svcs) {
        // One service's number, or all of the ones picked: counts add up, durations average.
        const at = (q: { query: string }, t: number) => {
          if (svc) return wave(svc, t, kindOf(q.query));
          const all = servicesIn(q.query).map((s) => wave(s, t, kindOf(q.query)));
          const sum = all.reduce((n, v) => n + v, 0);
          return kindOf(q.query) === "duration" ? Math.round((sum / all.length) * 100) / 100 : sum;
        };
        if (a.formulas?.length) {
          // The one formula this stand-in reads: 100 * a / b.
          series.push({ group_tags: svc ? [`service:${svc}`] : [], query_index: 0, unit: [{ short_name: "%", name: "percent" }, null] });
          values.push(times.map((t) => Math.round((100 * at(qs[0], t)) / at(qs[1], t) * 100) / 100));
        } else
          for (const [i, q] of qs.entries()) {
            series.push({ group_tags: svc ? [`service:${svc}`] : [], query_index: i, unit: kindOf(q.query) === "duration" ? [{ short_name: "ms", name: "millisecond" }, null] : null });
            values.push(times.map((t) => at(q, t)));
          }
      }
      return send(200, { data: { type: "timeseries_response", attributes: { series, times, values } } });
    }
    if (url.pathname === "/api/v2/spans/analytics/aggregate" && req.method === "POST") {
      const a = body.data.attributes;
      const rows: [route: string, ns: number][] = [
        ["POST /checkout", 1820e6],
        ["GET /cart", 412e6],
        ["POST /ledger/entries", 905e6],
        ["GET /orders/:id", 233e6],
      ];
      // Its numbers in `compute`, as Datadog answers (the reference also lists `computes`; set({ computes: true })).
      const key = opts.computes ? "computes" : "compute";
      if (!a.group_by) return send(200, { data: [{ type: "bucket", attributes: { by: {}, [key]: { c0: [0, 1, 2].map((i) => ({ time: new Date(Number(a.filter.from) + i * 3600e3).toISOString(), value: 400e6 + i * 10e6 })) } } }], meta: { status: "done" } });
      return send(200, { data: rows.slice(0, a.group_by[0].limit).map(([r, v]) => ({ type: "bucket", attributes: { by: { [a.group_by[0].facet]: r }, [key]: { c0: v } } })), meta: { status: "done", elapsed: 12 } });
    }
    if (url.pathname === "/api/v1/monitor/search")
      return send(200, {
        monitors: [
          { id: 101, name: "core-api p95 over 800 ms", status: "Alert", type: "metric alert", last_triggered_ts: Math.floor(Date.now() / 1000) - 600 },
          { id: 102, name: "ledger error rate", status: "OK", type: "metric alert" },
          { id: 103, name: "erp-sync lag", status: "Warn", type: "query alert" },
        ],
        metadata: { total_count: 3, page: 0, per_page: 50 },
      });
    if (url.pathname === "/api/v2/events/search" && req.method === "POST") {
      const from = Number(body.filter.from);
      const to = Number(body.filter.to);
      const t = Math.round(from + (to - from) * 0.6);
      return send(200, { data: [{ id: "e1", type: "event", attributes: { timestamp: new Date(t).toISOString(), message: "Deployed", tags: ["service:core-api"], attributes: { title: "core-api a41c9e deployed", timestamp: t, service: "core-api" } } }] });
    }
    if (url.pathname === "/api/v1/metrics") return send(200, { from: url.searchParams.get("from"), metrics: METRICS });
    const tags = url.pathname.match(/^\/api\/v2\/metrics\/([^/]+)\/all-tags$/);
    if (tags) return send(200, { data: { type: "metrics", id: decodeURIComponent(tags[1]), attributes: { tags: [...SERVICES.map((s) => `service:${s}`), "env:prod", "env:staging"] } } });
    if (url.pathname === "/api/v2/apm/services") return send(200, { data: { type: "services_list", attributes: { services: SERVICES } } });
    send(404, { errors: ["Not found"] });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    apiKey,
    appKey,
    set: (o: Partial<DdOpts>) => Object.assign(opts, o),
    close: () => new Promise((r) => server.close(r)),
  };
}
