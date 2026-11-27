// Notes, comments, suggestions, references, and versions. Types only, which Node strips: nothing here runs.

import type { By, Iso, Visibility } from "./common.ts";

// A document a person writes in agentbook (notes.ts), with the comments on its words and the edits agents suggest.
export interface Note {
  id: string;
  title: string;
  emoji: string;
  // The note it's inside of.
  parent: string | null;
  owner: string | null;
  by: By;
  // The agent that made it.
  made: string | null;
  workspace: string | null;
  page: string | null;
  text: string;
  visibility?: Visibility;
  people?: NotePerson[];
  version: number;
  created: Iso;
  updated: Iso;
  archived: Iso | null;
  comments: NoteComment[];
  suggestions: NoteSuggestion[];
  // Counts everything that happens on it.
  rev: number;
  last: NoteLast;
  // The threads that named it or read it.
  refs?: NoteRef[];
}
export interface NotePerson {
  user: string;
  at: Iso;
  by: string | null;
}
export interface NoteLast {
  v: number;
  at: Iso;
  by: By;
  hand: boolean;
  accepted?: NoteAccepted;
}
// A suggestion accepted: which, and whose.
export interface NoteAccepted {
  sid: string;
  by: By;
}
// A comment on a note's words (`quote`, the `nth` place they are), a short conversation, and the thread it talks to.
// `spot`: the line of the markdown an agent was @'d in.
export interface NoteComment {
  id: string;
  at: Iso;
  by: By;
  quote: string;
  nth: number;
  spot?: string;
  msgs: NoteMessage[];
  launch: string | null;
  post: string | null;
  resolved: { at: Iso; by: By } | null;
}
// A message in a comment. `sugg`: the suggestion it is.
export interface NoteMessage {
  id: string;
  at: Iso;
  by: By;
  text: string;
  sugg?: string;
}
// An edit an agent suggests: these words (`find`) replaced by those, until it's kept or undone.
export interface NoteSuggestion {
  id: string;
  at: Iso;
  by: By;
  comment: string;
  find: string;
  replace: string;
  state: "open" | "kept" | "undone";
  settled: { at: Iso; by: By } | null;
}
// A thread that names a note or reads it, by its thread, or by its launch while it starts.
export interface NoteRef {
  post?: string;
  launch?: string;
  how: "named" | "read";
  at: Iso;
}
// One version of a note. Hand edits a few minutes apart are one, `started` when the first was made.
export interface NoteVersion {
  id: string;
  note: string;
  v: number;
  at: Iso;
  started: Iso;
  by: By;
  hand: boolean;
  accepted?: NoteAccepted;
  title: string;
  text: string;
}
