import { tool, text, err, served } from "./tool.ts";

const framesShort = (frames) =>
  (frames || []).slice(0, 12).map((f) =>
    Array.isArray(f.time)
      ? { name: f.name, labels: f.labels, unit: f.unit, points: f.time.length, ...(f.time.length ? { first: [new Date(f.time[0]).toISOString(), f.values[0]], last: [new Date(f.time.at(-1)).toISOString(), f.values.at(-1)], max: f.values.some((v) => v != null) ? Math.max(...f.values.filter((v) => v != null)) : null } : {}) }
      : Array.isArray(f.rows)
        ? { columns: f.columns, rows: f.rows.length, first: f.rows.slice(0, 5), ...(f.units ? { units: f.units } : {}) }
        : f,
  );

export default tool({
  name: "ab_source",
  description: `What a dashboard's panels can ask: the person's connectors that answer queries (Datadog, …), set up on agentbook's Connectors page.
- action "list": each one's id, its query languages and what each takes, and its calls this hour.
- action "discover": what one has, to write a query against: with what: { metrics: "trace.http" } metric names that start so, { tags: "<metric>" } a metric's tags and their values, { services: true } APM services. It says which it knows.
- action "query": run a query once, as a panel would, and see its answer as it came (frames: series with labels and points, or a table): query: { source, lang, text, ... }, range ('1h', '24h'…; 24h by default) and vars ({ env: 'prod' }) to fill in its variables.`,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "discover", "query"] },
      source: { type: "string", description: "discover: the connector's id, from list." },
      what: { type: "object", description: "discover: what to look up." },
      query: { type: "object", description: "query: { source, lang, text, ... }, as a panel's." },
      range: { type: "string", description: "query: the range it runs for." },
      vars: { type: "object", description: "query: the values of the variables it uses." },
    },
    required: ["action"],
  },
  async run(args, { call }) {
    const action = args.action || "list";
    if (action === "list") {
      const listed = await call("GET", "/sources");
      const { sources } = listed;
      if (!sources.length) return text("The person has no connectors that answer queries yet. They set one up on agentbook's Connectors page (Datadog, for one): ask them to, with ab_ask.");
      return text(served(listed, sources.map((x) => `- ${x.id}: ${x.name}${x.site ? ` (${x.site})` : ""}${x.off ? ", turned off" : ""}${x.error ? `, failing: ${x.error}` : ""}, ${x.calls} calls this hour\n${Object.entries(x.langs || {}).map(([l, about]) => `  - lang "${l}": ${about}`).join("\n")}`).join("\n")));
    }
    if (action === "discover") {
      if (!args.source) return err("Say which source: its id, from action list.");
      const found = await call("POST", "/sources/discover", { source: args.source, what: args.what || {} }, { timeout: 40000 });
      return text(served(found, JSON.stringify(found.found, null, 1)));
    }
    if (action === "query") {
      if (!args.query) return err("Give the query: { source, lang, text }.");
      const r = await call("POST", "/sources/query", { query: args.query, view: { range: args.range, vars: args.vars } }, { timeout: 40000 });
      return text(served(r, JSON.stringify({ view: r.view, ms: r.ms, frames: framesShort(r.frames), ...(r.notes?.length ? { notes: r.notes } : {}), ...(r.link ? { link: r.link } : {}) }, null, 1)));
    }
    return err('action is "list", "discover" or "query".');
  },
});
