import { tool, text, notesText } from "./tool.ts";
import { WIDTHS } from "../../shared/widgets.ts";
import { RANGES, SHAPES } from "../../shared/dashboards.ts";

export default tool({
  name: "ab_dashboard_write",
  description: `Make or change a dashboard: panels that each hold a query, which agentbook runs for whatever range and variables the person picks, through their connectors, and draws as a number, a chart, a table or a list. Numbers from a system (Datadog, a database, PostHog) go here, not on a page and not in a routine: you write each panel's query once and agentbook keeps it current. A dashboard is a page (kind "dashboard"): private until the person shares it, and every write is a version they can see and restore.
- To make one: a title and panels (and vars, range). To change one: dashboard (its id): panels you send replace the ones with the same id (its query, shape and thresholds whole); the ones you leave out stay. remove: [ids], order: [ids].
- A panel: { id, type: "metric" | "chart" | "table" | "list", title, width?, query: { source, lang, text, ... }, shape?, thresholds?: { warn, bad }, markers? }. Never data: its numbers come from its query. width: ${Object.keys(WIDTHS).join(", ").replace(/, (?=[^,]*$)/, " or ")}.
- query.source is a connector's id and lang one of its languages, from ab_source list, which says what each language takes besides text (Datadog's metrics take queries and a formula; spans, compute, by and limit). Try a query with ab_source query first.
- A query's variables: $from, $to and $interval (filled for the range shown), and each of vars: [{ id, label, values: [..], default, multi? }], which the person picks from at the top ("*" is all of them). Write them where the language takes a value: {env:$env, service:$service}.
- shape, by type: ${Object.entries(SHAPES).map(([t, f]) => `${t}: { ${Object.entries(f).map(([k, d]) => `${k}${d.of ? ` (${d.of.join("|")})` : ""}${d.say ? `: ${d.say}` : ""}`).join("; ")} }`).join(". ")}.
- thresholds: { warn, bad }: a number goes amber then red past them (below them when bad is below warn), a chart draws the line, a table's last number column colours its cells. markers: a chart's events, as a query ({ source, lang: "events", text }).
- range: the one it opens on (${RANGES.join(", ")}; 24h by default).
- A note, doc or link can sit among the panels, written as on a page (with data).
Each new or changed panel runs once, for the range it opens on and the variables' defaults, and the answer says what each drew. A write whose panels fail isn't saved: fix the query, or keep_failing: true saves it anyway (a source that's down). test: true runs them without saving anything.`,
  inputSchema: {
    type: "object",
    properties: {
      dashboard: { type: "string", description: "The dashboard's id, to change one. Leave it out with a title to make one." },
      title: { type: "string", description: "Its title, like 'Checkout health'. Required to make one." },
      emoji: { type: "string", description: "One emoji for it." },
      about: { type: "string", description: "A sentence on what it shows." },
      vars: { type: "array", items: { type: "object" }, description: "Its variables, all of them: [{ id: 'env', label: 'Env', values: ['prod', 'staging'], default: 'prod' }]." },
      range: { type: "string", description: "The range it opens on: '24h' by default." },
      panels: { type: "array", items: { type: "object" }, description: "Panels to add or change, by id." },
      remove: { type: "array", items: { type: "string" }, description: "Ids of panels to take off." },
      order: { type: "array", items: { type: "string" }, description: "Panel ids in the order they should be." },
      summary: { type: "string", description: "What this version changed, past tense: 'Added errors by service'." },
      test: { type: "boolean", description: "Run its new and changed panels and say what each drew, saving nothing." },
      keep_failing: { type: "boolean", description: "Save it even if a panel fails its test run." },
    },
  },
  brief: "ab_dashboard_write: numbers a system has (Datadog, a database, product analytics) for the person to look at: a dashboard whose panels each hold a query in the source's own language, which agentbook runs for whatever range and filters they pick. Write each query once (ab_source lists the sources, what they have, and tries a query); never a routine, and never numbers you copy in.",
  async run(args, { call }) {
    const r = await call("POST", "/dashboards", { dashboard: args.dashboard, title: args.title, emoji: args.emoji, about: args.about, vars: args.vars, range: args.range, panels: args.panels, remove: args.remove, order: args.order, summary: args.summary, test: args.test, keep_failing: args.keep_failing }, { timeout: 90000 });
    const ran = r.tests?.lines?.length ? `\n${r.test ? "Each panel ran" : "Its new and changed panels ran"} for ${r.tests.view?.range || "its range"}${Object.keys(r.tests.view?.vars || {}).length ? ` with ${JSON.stringify(r.tests.view.vars)}` : ""}:\n${r.tests.lines.map((l) => `- ${l}`).join("\n")}` : "";
    const trimmed = notesText(r.notes);
    if (r.test) return text(`Nothing saved (a test).${ran}${trimmed}`);
    if (r.created) return text(`Made the dashboard "${r.id}" (v1): ${r.url}\nIt's private until the person shares it. Change it with dashboard: "${r.id}".${ran}${trimmed}`);
    return text(`${r.changed ? `Saved v${r.version} of "${r.id}"` : `Nothing changed on "${r.id}", so no new version (it's still v${r.version})`}: ${r.url}${ran}${trimmed}`);
  },
});
