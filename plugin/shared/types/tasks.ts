// Workspaces, tasks, what tasks ship, and legacy WIP sets. Types only, which Node strips: nothing here runs.

import type { By, DoneBy, Iso, Visibility } from "./common.ts";
import type { PrCard, PrLineKind } from "./threads.ts";

// A repo, or a folder on a machine, that threads are started in.
export interface Workspace {
  id: string;
  name: string;
  // Its repoKey, and what clones it.
  repo: string | null;
  url: string | null;
  folders: { machine: string; path: string }[];
  owner: string | null;
  created: Iso;
  // Private, the default, isn't kept. One from before two levels may say "followers", which reads as public.
  visibility?: "public";
  // Its worktrees' own levels, by branch.
  worktrees?: Record<string, Visibility>;
  // Kept out of agent search.
  search_off?: true;
  // What its WIP showed, from before.
  wip?: string;
}
// One of a person's tasks: its title (`text`) and body (`note`), its threads, pages and group, and what it ships.
export interface Task {
  id: string;
  owner: string;
  text: string;
  note?: string | null;
  workspace: string | null;
  agent?: string | null;
  // Its place on its owner's list, lowest first, and on the lists of the people it's shared with.
  rank: number;
  ranks?: Record<string, number>;
  at: Iso;
  done: boolean;
  done_at: Iso | null;
  done_by?: DoneBy | null;
  done_post?: string | null;
  done_user?: string | null;
  // Where it was sent, and the threads linked to it.
  sent: TaskSent[];
  posts: TaskPost[];
  pages: TaskPage[];
  // The page it was on, from before a task had pages: moved into `pages`.
  page?: string;
  group?: string | null;
  // The thread of the agent that left it for you (ab_todo).
  from?: string;
  // The issue a connector brought it in from.
  source?: TaskSource;
  // The buttons an agent's to-do offers: what pressing each sends.
  answers?: { label: string; says: string }[];
  // A to-do its thread keeps for you, or one put on your Tasks on purpose.
  scope?: "thread";
  later?: boolean;
  // People on it besides its owner.
  people?: TaskPerson[];
  visibility?: "public";
  // Its people don't see its threads' work.
  show_work?: boolean;
  // A connector's task removed here, kept so its issue doesn't come back.
  removed?: Iso | null;
  ship?: TaskShip;
}
export interface TaskSent {
  launch: string;
  agent: string | null;
  post: string | null;
  at: Iso;
  user?: string;
}
// A thread linked to a task: sent there, linked by you, or by an agent from its thread.
export interface TaskPost {
  post: string;
  at: Iso;
  by: "sent" | "you" | "agent";
  user?: string;
}
export interface TaskPage {
  page: string;
  at?: Iso;
  by: "you" | "agent";
}
export interface TaskPerson {
  user: string;
  at: Iso;
  // Its owner's username.
  by: string | null;
}
// The issue a task came from, as its connector last said.
export interface TaskSource {
  connector: string;
  kind: string;
  id: string;
  key: string;
  url: string;
  title: string;
  state: string;
  state_type: string;
  state_id: string;
  team: string;
  updated: Iso;
  // Why it's gone there.
  gone?: string | null;
  // Closed from here, and the state it was in before.
  closed?: Iso | null;
  was?: string | null;
  // Why closing or reopening it there failed.
  error?: string | null;
}
// What a task ships (task-ship.ts): what was put in it, how its pull requests stand, what happened to them, what
// each thread heard, and the order they land in.
export interface TaskShip {
  items: ShipItem[];
  prs: Record<string, ShipPr>;
  events: ShipEvent[];
  // Each thread's last event heard, by thread.
  seen: Record<string, number>;
  order: ShipOrderItem[] | null;
  landing: ShipLanding | null;
  since: Iso;
}
// A pull request or a branch, as the page said it when it was put in.
export interface ShipOrderItem {
  id: string;
  kind: "pr" | "branch";
  title: string;
  ref: string;
  repo: string;
  url: string | null;
}
export interface ShipItem extends ShipOrderItem {
  at: Iso;
  by: By | null;
}
// What a task keeps of a pull request's card between reads (task-ship.ts's slimCard).
export type ShipPr = Partial<Pick<PrCard, "number" | "title" | "url" | "state" | "base" | "head" | "author" | "closed" | "merged_by" | "checks" | "failing" | "red" | "mergeable" | "merge_state" | "review" | "reviewer" | "threads" | "said">> & { created?: Iso };
// Something that happened to what a task ships, which its threads hear.
export interface ShipEvent {
  seq: number;
  at: Iso;
  kind: "in" | "out" | "pr" | "order" | "landing" | "asked";
  text: string;
  item?: string;
  url?: string;
  pr?: PrLineKind;
  // What a merge changed.
  files?: string[];
  post?: string;
  // Who asks the next one's thread, when it's someone else's.
  waits?: string;
}
// Landing them in order: when each one's thread was asked, by item.
export interface ShipLanding {
  at: Iso;
  by: By | null;
  asked: Record<string, Iso>;
}

/* ---------- WIPs of many, from before ---------- */

// A WIP of many from before tasks held pull requests: its items, pull requests, events and landing, moved onto a task.
export interface WipSet {
  id: string;
  title: string;
  note: string;
  owner: string;
  by: By;
  created: Iso;
  updated: Iso;
  archived: Iso | null;
  // The thread agentbook made it for.
  for?: string;
  self?: string;
  named?: boolean;
  items: WipItem[];
  posts: Record<string, { at: Iso; by: By }>;
  launches: Record<string, unknown>;
  prs?: Record<string, ShipPr>;
  events: WipEvent[];
  seen: Record<string, number>;
  order?: ShipOrderItem[] | null;
  landing?: ShipLanding | null;
  // Agents' hints of what goes in it, by item.
  hints?: Record<string, { at: Iso; by: By }>;
  // The task it became (null: put away); unset until it's moved.
  moved?: string | null;
}
// What was put in a WIP: a pull request, a branch, or a thread.
export interface WipItem {
  id: string;
  kind: string;
  title: string;
  ref: string;
  repo: string;
  url: string | null;
  at: Iso;
  by: By | null;
}
export interface WipEvent {
  seq: number;
  at: Iso;
  kind: string;
  text: string;
  item?: string;
  post?: string;
  pr?: string;
  url?: string;
  files?: string[];
}
