// Widgets on a page and panels on a dashboard. Types only, which Node strips: nothing here runs.

import type { By, Iso } from "./common.ts";

export type WidgetType = "metric" | "chart" | "table" | "list" | "tasks" | "note" | "doc" | "link" | "options" | "diagram" | "html" | "filter";
export type WidgetWidth = "quarter" | "third" | "half" | "two-thirds" | "full";
// A widget on a page, or a dashboard's panel (one with a `query`, whose data stays empty).
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  width: WidgetWidth;
  stack: string | null;
  data: WidgetData;
  query?: PanelQuery;
  shape?: PanelShape;
  thresholds?: { warn?: number; bad?: number };
  markers?: PanelQuery;
  // The version that last changed it, when, and who.
  v: number;
  at: Iso;
  by: By;
}
// A widget's text field: a number given for it is kept as one (widgets.ts).
export type Text = string | number;
export type Status = "ok" | "warn" | "bad" | "idle";
export type ChartKind = "line" | "bar" | "stacked" | "scatter";
export type NodeState = "on" | "done" | "failed" | "off";
// A widget's data, as widgets.ts keeps it: each kind has some of these fields (a metric's value, a table's rows…), and
// a dashboard's panel has none.
export interface WidgetData {
  // A metric: a number, its unit, its change and which way is good, a badge, and a sparkline (`series`).
  value?: Text;
  unit?: Text;
  change?: Text;
  good?: "up" | "down";
  vs?: Text;
  status?: Status | { status: Status; text?: string };
  // A chart: its kind, x labels, series, and the moments that matter; a metric's sparkline.
  kind?: ChartKind | "time";
  x?: Text[];
  series?: (number | null)[] | ChartSeries[];
  x_unit?: Text;
  target?: { value: number; label?: Text };
  markers?: { x: Text; label?: Text }[];
  // A table: its columns, rows, and the column it's sorted by.
  columns?: Text[];
  rows?: TableCell[][];
  sort?: Text;
  // A list's items (`check`: a checklist, which is the person's tasks), or an options widget's.
  items?: WidgetItem[];
  check?: boolean;
  // A note or a doc's markdown; a link's line under it.
  text?: Text;
  // A link.
  url?: string;
  title?: Text;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  // A widget of its own: its code, its data, and how tall it starts.
  html?: Text;
  css?: Text;
  js?: Text;
  data?: unknown;
  height?: number;
  // A filter: its values, and what "all of them" is called.
  values?: string[];
  all?: Text;
  // How it follows the page's filters: where the picked value is in it, by filter id, and what it shows for each value.
  match?: Record<string, string>;
  per?: Record<string, Record<string, WidgetData>>;
}
export interface ChartSeries {
  name: Text;
  values?: (number | null)[];
  // A dashboard's line for the period before (Compare), drawn dashed.
  before?: boolean;
  // A scatter's.
  points?: { x: number; y: number; label?: Text }[];
}
// A table's cell: text, a number, a status with words, or a meter (0 to 100).
export type TableCell = string | number | null | { status?: Status; text?: Text } | { meter: number };
// A list's item (any other field too: a filter matches on it) or an options widget's.
export interface WidgetItem {
  text?: Text;
  sub?: Text;
  status?: Status;
  label?: Text;
  link?: string;
  // Asks the person's OK for it, and their answer.
  ask?: "ok";
  ok?: boolean;
  ok_by?: Text;
  ok_at?: Text;
  done?: boolean;
  // An option.
  name?: Text;
  pros?: Text[];
  cons?: Text[];
  image?: string;
  pick?: boolean;
  chosen?: boolean;
  [field: string]: unknown;
}
// A diagram's box and arrow, the arrows naming boxes by id.
export interface DiagramNode {
  id: string;
  title: Text;
  text?: Text;
  state?: NodeState;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}
// A panel's query, in its source's own language (dashboards.ts). Several a formula combines go in `queries`.
export interface PanelQuery {
  source: string;
  lang: string;
  text?: string;
  formula?: string;
  compute?: string;
  by?: string;
  limit?: number;
  name?: string;
  sort?: string;
  queries?: Record<string, string>;
}
// How a panel's answer becomes its widget's data; the fields are its type's (dashboards.ts's SHAPES).
export interface PanelShape {
  reduce?: "last" | "avg" | "sum" | "max" | "min";
  unit?: string;
  decimals?: number;
  compare?: "previous";
  good?: "up" | "down";
  spark?: boolean;
  kind?: "line" | "bar" | "stacked";
  series?: string;
  top?: number;
  columns?: Record<string, string>;
  sort?: string;
  limit?: number;
  units?: Record<string, string>;
  text?: string;
  sub?: string;
  status?: string;
  label?: string;
  link?: string;
}
