// Turn shapes reported by agents' ab_* tools (shapes.ts). Types only, which Node strips: nothing here runs.

import type { ChartSeries, WidgetData } from "./widgets.ts";

// How an agent's turn went, as it said with its ab_* tools (shapes.ts): kept on the thread until the reply that ends
// the turn takes it.
export interface TurnShape {
  verdict?: Verdict;
  checks?: ShapeCheck[];
  replies?: string[];
  drafts?: Draft[];
  cards?: Card[];
  // How its cards are picked.
  cardsPick?: "several" | "one";
  slots?: Slots;
  path?: { stages: PathStage[] };
  marks?: { text: string; note?: string }[];
  excerpts?: Excerpts;
  compare?: Compare;
  diagram?: Pick<WidgetData, "nodes" | "edges" | "title">;
  chart?: Omit<WidgetData, "series"> & { series?: ChartSeries[] };
}
export type VerdictKind = "done" | "found" | "needs_you" | "partly" | "blocked" | "nothing";
// A turn's verdict: its kind and its line. `gist`, `next` and `sections` are from older plugins.
export interface Verdict {
  kind: VerdictKind;
  line: string;
  gist?: string[];
  next?: string[];
  sections?: { heading: string; lead: string; body: string; number?: string; yours?: boolean }[];
}
// What a turn didn't check, or what failed. A check that passed comes from older plugins.
export interface ShapeCheck {
  status: "failed" | "not_checked" | "passed";
  label: string;
  detail?: string;
  // What to send to have it check that.
  do?: string;
}
export type DraftKind = "email" | "pull_request" | "invite" | "message";
// A draft an agent made for the person: an email, a pull request, an invite or a message; the fields are its kind's.
export interface Draft {
  kind: DraftKind;
  action: string | null;
  body: string;
  // An email's people (a list), or where a message goes (a line).
  to?: string | string[];
  cc?: string[];
  from?: string | null;
  subject?: string;
  title?: string;
  branch?: string | null;
  base?: string | null;
  repo?: string | null;
  when?: string;
  minutes?: number | null;
  attendees?: string[];
  where?: string | null;
  via?: string | null;
}
// A place, a product, a price against a limit.
export interface Card {
  title: string;
  text?: string;
  image?: string;
  url?: string;
  facts?: string[];
  badge?: string;
  price?: { value: number; unit: string; limit?: number; series?: number[]; from?: string; to?: string };
  actions?: { label: string; says?: string }[];
}
// Times to pick from.
export interface Slots {
  title: string;
  minutes: number | null;
  with: string | null;
  action: string | null;
  times: { at: string; best?: true }[];
}
// A stage of what a turn went through: `dead` says why it was a dead end.
export interface PathStage {
  text: string;
  minutes?: number;
  dead?: string;
}
// Passages from what an agent read, word for word.
export interface Excerpts {
  source: string;
  title: string;
  items: { text: string; mark?: string; where?: string; label?: string; note?: string }[];
}
export type CompareKind = "before_after" | "options" | "sizes" | "numbers";
// Pictures with a job (before and after, options, a desktop and a phone), or numbers that moved.
export interface Compare {
  kind: CompareKind;
  title?: string;
  numbers?: { label: string; from: number; to: number; unit?: string; better?: "up" | "down" }[];
  pictures?: { picture: string; label?: string; text?: string; pick?: true; frame?: "desktop" | "phone"; says?: string }[];
  action?: string;
}
