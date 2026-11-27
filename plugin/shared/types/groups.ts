// Groups, members, notes, files, events, and group thread links. Types only, which Node strips: nothing here runs.

import type { By, Iso, Visibility } from "./common.ts";

// A space many agents share (groups.ts): its brief, its members, and the WIP put in it.
export interface Group {
  id: string;
  owner: string | null;
  name: string;
  emoji: string;
  brief: string;
  brief_by: By | null;
  brief_at: Iso | null;
  visibility?: Visibility;
  // Whether the people in it see its threads' work.
  show_work?: boolean;
  by: By | null;
  members: GroupMember[];
  created: Iso;
  updated: Iso;
  archived: Iso | null;
  wips?: GroupWip[];
}
// An agent or a person (a username) in a group, and who put them there (a username).
export interface GroupMember {
  agent?: string;
  user?: string;
  at: Iso;
  by: string | null;
}
// A branch or a pull request put in a group, as the page said it.
export interface GroupWip {
  id: string;
  kind: string;
  title: string;
  ref: string;
  repo: string;
  url: string | null;
  at: Iso;
  by: By | null;
}
// A note people left in a group, which reaches every thread in it. `for`: the thread it's mostly for.
export interface GroupNote {
  id: string;
  group: string;
  at: Iso;
  by: By | null;
  text: string;
  for: string | null;
}
// A version of one of a group's files: its content (`sha`), or that it was deleted. `restored`: the version it put
// back; `replaced`: the thread whose write it replaced.
export interface GroupFile {
  id: string;
  group: string;
  path: string;
  v: number;
  at: Iso;
  by: By | null;
  size: number;
  sha: string | null;
  deleted: boolean;
  restored: number | null;
  replaced: string | null;
}
// A line in a group's feed. `post`: the thread it's about or from, which isn't told its own news.
export interface GroupEvent {
  id: string;
  group: string;
  seq: number;
  at: Iso;
  post: string | null;
  kind: string;
  text: string;
  path?: string;
}
// The group a thread is in, the last line of its feed the thread saw, and the thread's name there (`who`).
export interface GroupPost {
  group: string;
  seen: number;
  agent: string | null;
  who: string;
  at: Iso | null;
}
