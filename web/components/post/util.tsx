// What a thread's card and its chips share: page and group colours, what you searched for marked in a text (hl),
// and what a thread is on (its page, its group, the note it's about, the thread it was started from).
import { Fragment } from "react";
import type { ReactNode } from "react";
import { useChrome } from "../../lib/chrome.ts";
import { hits, searchWords } from "../../lib/search.ts";
import type { Term } from "../../lib/search.ts";
import { getApp, threadRow, useApp } from "../../lib/store.ts";
import type { AppState } from "../../lib/store.ts";
import type { GroupRow, NoteRow, PageRow, Thread } from "../../lib/types.ts";


// The words in the box, and how many typos each may have: the server's, for a list it searched; else none.
export function searchTerms(q: string, s: AppState = getApp()): Term[] {
  if (s.feed?.terms && s.feed.q === q) return s.feed.terms;
  return searchWords(q).map((w) => ({ w, typos: 0 }));
}
export function useSearchTerms(): Term[] | null {
  const q = useChrome((c) => c.q);
  const feedTerms = useApp((s) => (s.feed?.q === q ? s.feed.terms : null));
  if (!q) return null;
  return feedTerms || searchWords(q).map((w) => ({ w, typos: 0 }));
}
export function marks(text: string, terms: Term[] | null): ReactNode {
  if (!terms?.length || !text) return text;
  const spans = hits(text, terms);
  if (!spans.length) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const [a, b] of spans) {
    out.push(text.slice(last, a), <mark key={a}>{text.slice(a, b)}</mark>);
    last = b;
  }
  out.push(text.slice(last));
  return <>{out.map((x, i) => (typeof x === "string" ? <Fragment key={`t${i}`}>{x}</Fragment> : x))}</>;
}
export function Hl({ text }: { text: string | null | undefined }) {
  const terms = useSearchTerms();
  return <>{marks(String(text ?? ""), terms)}</>;
}

// The page a thread is on (started from it, made it when asked for a new one, or changed it): not on the page itself,
// where every thread is one of its own.
export function useThreadPage(id: string | null | undefined): PageRow | null {
  return useApp((s) => {
    const p = id && id !== "new" ? (s.data?.pages || []).find((x) => x.id === id) : null;
    return p && !(s.route.name === "page" && s.route.id === p.id) ? p : null;
  });
}
// The group a thread is in, as its page is: not on the group itself.
export function useThreadGroup(id: string | null | undefined): GroupRow | null {
  return useApp((s) => {
    const g = id ? (s.data?.groups || []).find((x) => x.id === id) : null;
    return g && !(s.route.name === "group" && s.route.id === g.id) ? g : null;
  });
}
// The note a thread is about: the latest changed of yours it's tied to (a comment it talks to or answered in, or the
// note it made), unless that note is open.
export function useThreadNote(id: string | null | undefined): NoteRow | null {
  return useApp((s) => {
    const n = id ? (s.data?.notes || []).filter((x) => !x.archived && (x.linked || []).includes(id)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0] : null;
    return n && !(s.route.name === "note" && s.route.id === n.id) ? n : null;
  });
}
// The thread one was started from, as a row, when they see it: the sidebar's, or the one its own page came with.
export function startedFrom(s: Thread | null | undefined, st: AppState = getApp()): Thread | null {
  if (!s?.started_from) return null;
  return threadRow(s.started_from, st) || (st.open?.id === s.id ? (st.open.detail?.from as Thread) || null : null);
}
export const useStartedFrom = (s: Thread | null | undefined) => useApp((st) => startedFrom(s, st));
// What the page reads of a thread that its type doesn't say yet: why its last turn ended needing you (`asking`), the
// routine it's a run of, when a guest left it (`removed`), and what it left going after its turn.
export type ThreadSeen = Thread & {
  asking?: { kind: string; line?: string | null; at: string } | null;
  routine?: { id: string; name: string } | null;
  removed?: string | null;
  going?: { id: string; kind: string; title: string; started?: string; worker?: string; out?: boolean }[];
};
export const seen = (s: Thread) => s as ThreadSeen;
export const myRoutineHref = (id: string) => `#/routines/${encodeURIComponent(id)}`;
