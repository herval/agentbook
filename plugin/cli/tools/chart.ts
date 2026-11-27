import { shape } from "./shape.ts";
import { CHART_KINDS } from "../../shared/widgets.ts";

export default shape({
  name: "ab_chart",
  description: "A chart on the reply that ends your turn, for when the answer is a shape (where it jumped, which is biggest, what goes with what, how far off the target), instead of a table of numbers. kind line (the default: a trend over time), bar (side by side), stacked (bars stacked, each series a part of its x's total: spend by service per month) or scatter (a dot per point, numbers on both axes: p95 against cart size, one point per service with its label). A dashed target line and markers at the moments that matter (\"a41c9e deployed\") go on any of them. Dates as x labels (2026-10-03, or 2026-10-03T14:00) show as \"Oct 3\". Up to 8 series, 4 read well; up to 400 points each. Calling it again replaces it. To keep one in view on your thread and update it, ab_attach it; on a page, it's the chart widget.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What it shows: \"p95 latency, last 14 days\"." },
      kind: { type: "string", enum: CHART_KINDS, description: "line (the default), bar, stacked or scatter." },
      x: { type: "array", maxItems: 400, items: { type: "string" }, description: "The labels along the bottom, one for each value: dates, versions, names. Not for a scatter." },
      series: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            values: { type: "array", maxItems: 400, items: { type: "number" }, description: "One for each x label." },
            points: { type: "array", maxItems: 400, items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, label: { type: "string", description: "What it is: \"erp-sync\". A few labels show beside their dots." } }, required: ["x", "y"] }, description: "A scatter's, instead of values." },
          },
        },
      },
      unit: { type: "string", description: "The values' (a scatter's y): \"ms\", \"%\", \"€\"." },
      x_unit: { type: "string", description: "A scatter's x: \"lines\"." },
      target: { type: "object", properties: { value: { type: "number" }, label: { type: "string", description: "\"SLO 300 ms\"." } }, required: ["value"] },
      markers: { type: "array", maxItems: 6, items: { type: "object", properties: { x: { type: "string", description: "One of the x labels (a scatter's: a number)." }, label: { type: "string", description: "What happened then: \"a41c9e deployed\"." } }, required: ["x"] } },
    },
    required: ["series"],
  },
  part: (args) => ({ chart: { title: args.title, kind: args.kind, x: args.x, series: args.series ?? [], unit: args.unit, x_unit: args.x_unit, target: args.target, markers: args.markers } }),
  said: "They show on the reply that ends your turn.",
});
