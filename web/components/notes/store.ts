// The open note's page: the note as the server has it, and what the page shows of it beside its
// words: the comment that's open, the one you're starting, where each comment's words are, its title and icon as you
// type them, the menus (/ and @, a block's, an emoji) and the selection's toolbar. The editor (editor.tsx) changes these;
// the head, the rail and the menus (React) draw them.
import type { ReactNode } from "react";
import { create } from "zustand";
import { getJSON } from "../../lib/api.ts";
import { getApp, takeRows } from "../../lib/store.ts";
import type { AgentRow, NoteCommentView, NoteRow, NoteView, Question, Thread } from "../../lib/types.ts";
import type { Named } from "./html.ts";

// A note on its own page: what /api/notes/:id says beyond its summary: the threads tied to it (`ties`), its versions,
// whether you may write in it, its owner's username and who's on it (one through a note it's inside of, `from`).
export type NoteFull = Omit<NoteView, "people"> & {
  ties?: { id: string; how: string; at: string }[];
  versions?: { v: number }[];
  can_edit?: boolean;
  owner_name?: string;
  people?: { user: string; at: string; from?: string }[];
};
// A comment you're starting: its words, and which of the places they are in the note.
export type NoteComment = NoteCommentView;

// A row of a menu: a block kind (/), an agent (`a`) or a thread (`s`) to ask, a page, widget, note or workspace to name,
// an emoji (`e`), or an action of a block's menu; or a line between (`sep`).
export interface PopItem extends Named {
  a?: AgentRow;
  s?: Thread;
  e?: string;
  t?: string;
  l?: string;
  g?: string;
  k?: ReactNode;
  red?: boolean;
  sep?: boolean;
  run?: () => void;
}
// What a menu is opened for: the block (`i`) or the comment's box (`el`) typed in, where its / or @ is (`start`), or what
// picking does (`pick`, an emoji; `items`, a block's menu).
export interface PopCtx {
  el?: HTMLElement;
  i?: number | null;
  typed?: boolean;
  start?: number;
  pick?: (e: string) => void;
  items?: PopItem[];
}
export interface Pop {
  kind: "slash" | "at" | "emoji" | "menu";
  ctx: PopCtx;
  sel: number;
  q: string;
  items: PopItem[];
  rect: { left: number; top: number; bottom: number };
}
// The selection's toolbar: where the selection is, whether it reaches across blocks, and a link being written.
export interface Tb {
  rect: { left: number; top: number; width: number };
  cross: boolean;
  link: { range: Range; i: number } | null;
}

export interface NoteState {
  // The note, as /api/notes/:id says (`missing`: no note here, or not yours to see).
  note: NoteFull | null;
  // Its title and icon as you have them (the editor saves them).
  title: string;
  emoji: string;
  // The comment open (its card's box ready), and the one you're starting.
  active: string | null;
  draft: (NoteComment & { note: string }) | null;
  // Where each open comment's words are in the note's words (-1: not in it any more).
  pos: Record<string, number>;
  // The note as its markdown (Markdown), and whether that was changed there.
  md: boolean;
  mdDirty: boolean;
  // Its Share panel open (the note's id); the resolved comments shown; all its threads shown.
  share: string | null;
  res: boolean;
  threadsAll: boolean;
  pop: Pop | null;
  tb: Tb | null;
}
const FRESH = { note: null, title: "", emoji: "", active: null, draft: null, pos: {}, md: false, mdDirty: false, share: null, res: false, threadsAll: false, pop: null, tb: null };
export const useNote = create<NoteState>(() => ({ ...FRESH }));
export const getNote = useNote.getState;
export const setNote = useNote.setState;
export const resetNote = () => setNote({ ...FRESH });

// Which of Notes' pills is picked, while you go between screens.
export const useNotesPill = create<{ pill: string }>(() => ({ pill: "all" }));

// Notes Notes lists, as the left column's chrome has them.
export const noteById = (id: string | null | undefined): NoteRow | undefined => (getApp().data?.notes || []).find((n) => n.id === id);
// Someone who only sees it (a contact, as it's public) reads it: no typing, no comments, nothing to accept.
export const noteRo = (n: NoteFull | null | undefined) => !!n && n.can_edit === false;
export const noteNames = (n: NoteFull) => (n.people || []).map((p) => p.user);
export const openSugg = (n: NoteFull | null | undefined) => (n?.suggestions || []).filter((x) => x.state === "open");
export const suggKey = (n: NoteFull | null | undefined) => openSugg(n).map((x) => x.id).join();
export const noteOpen = (n: NoteFull | null | undefined, draft = getNote().draft): NoteComment[] => [...(draft && draft.note === n?.id ? [draft] : []), ...(n?.comments || []).filter((c) => !c.resolved)];
// A question its thread asked you since the comment began, which is likely about it (an older one isn't).
export const noteQuestion = (c: NoteComment, questions: Question[] = getApp().data?.questions || []) => (c.thread ? questions.find((q) => q.post === c.thread && !q.answered && !(q.asked && c.at && q.asked < c.at)) || null : null);
// The agent a comment talks to: the first that said something in it, its thread's, its launch's, or the one asked.
export const noteCommentAgent = (c: NoteComment): string | null => {
  const s = getApp();
  return c.msgs.find((m) => m.by?.agent)?.by.agent || (c.thread ? (s.rows[c.thread] || s.more[c.thread])?.agent : null) || (c.launch ? s.data?.launches?.find((l) => l.id === c.launch)?.agent : null) || c.asked || null;
};

// The note as the server has it. What the editor does with it is noteTake's (editor.tsx), handed in here so this file
// doesn't import the editor.
let take: ((n: NoteFull) => void) | null = null;
export const onTake = (fn: (n: NoteFull) => void) => void (take = fn);
let asking: Promise<void> | null = null;
let again = false;
export async function loadNote(): Promise<void> {
  if (asking) return void (again = true);
  asking = (async () => {
    const r = getApp().route;
    if (r.name !== "note") return;
    const id = r.id;
    const n = await getJSON<NoteFull>(`/api/notes/${encodeURIComponent(id)}`);
    const now = getApp().route;
    if (now.name !== "note" || now.id !== id) return;
    takeRows(n?.thread_rows);
    if (!n) return void setNote({ note: { id, missing: true } });
    take?.(n);
    setNote({ note: n });
  })().finally(() => {
    asking = null;
    if (again) {
      again = false;
      loadNote();
    }
  });
  return asking;
}
