// Pages, versions, snapshots, and dashboard metadata. Types only, which Node strips: nothing here runs.

import type { By, Iso, Visibility } from "./common.ts";
import type { Widget } from "./widgets.ts";

export type PageColor = "purple" | "teal" | "red" | "amber" | "blue" | "pink" | "green" | "gray";
// A page of widgets agents and people keep up to date (pages.ts), or a dashboard of panels that hold queries.
export interface Page {
  id: string;
  title: string;
  emoji: string;
  color: PageColor | null;
  about: string;
  visibility: Visibility;
  // Whether the people who keep it see its threads' work.
  show_work?: boolean;
  by: By;
  owner?: string | null;
  contributors: PageContributor[];
  widgets: Widget[];
  version: number;
  created: Iso;
  updated: Iso;
  // When it last moved up the feed (a routine's quiet refresh doesn't move it).
  moved?: Iso;
  archived: Iso | null;
  // Set by its first version, with `moved` and `recent`.
  last?: PageLast;
  // Its latest versions that weren't quiet, newest last.
  recent?: { v: number; at: Iso; by: By }[];
  kind?: "dashboard";
  dash?: PageDash;
}
// An agent or person who changes a page: the agent that made it, or an editor its owner added.
export interface PageContributor {
  agent?: string;
  user?: string;
  role: "made" | "editor";
  at?: Iso;
  // Who added them: a username.
  by?: string | null;
}
// Its latest version, in brief.
export interface PageLast {
  v: number;
  at: Iso;
  by: By;
  summary: string;
  changes: PageChange[];
  // The version it restored.
  restored: number | null;
  // Made by hand.
  hand: boolean;
}
// A dashboard's variables and the range it opens on.
export interface PageDash {
  vars: DashVar[];
  range: string;
}
export interface DashVar {
  id: string;
  label: string;
  values: string[];
  default: string | string[];
  multi?: boolean;
  all?: false;
}
// What a version changed: a widget added, changed or removed, or the page's title, icon, description, variables,
// range or layout.
export interface PageChange {
  w: string;
  kind: "added" | "changed" | "removed";
  id?: string;
  text?: string;
  what?: "title";
  from?: string;
  to?: string;
  // A table's rows that changed, the ones that matter most first; `more` is how many others did.
  rows?: PageRowChange[];
  more?: number;
}
// A table's row, found by its first cell (`key`): added, removed, or changed in its `col` (the first column that
// did, a status before one that didn't), from one cell to another, with each one's status.
export interface PageRowChange {
  kind: "added" | "removed" | "changed";
  key: string;
  col?: string;
  from?: string;
  to?: string;
  was?: string;
  status?: string;
}
// One version of a page, with a copy of it as it then was.
export interface PageVersion {
  id: string;
  page: string;
  v: number;
  at: Iso;
  by: By;
  summary: string;
  changes: PageChange[];
  restored: number | null;
  hand: boolean;
  // A routine's refresh, which didn't move the page up the feed.
  quiet?: true;
  snapshot: PageSnapshot;
}
export interface PageSnapshot {
  title: string;
  emoji: string;
  about: string;
  widgets: Widget[];
  dash?: PageDash;
}
// A thread its person put on a page by hand, moved from another, or took off one (`page` null, `was` the one it left).
export interface PagePost {
  page: string | null;
  was: string | null;
  by: By | null;
  at: Iso;
  // Its agent heard so.
  told: boolean;
}
