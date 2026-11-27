// The bell's lists (the old page's side-column helpers): what has an agent waiting on you, and what's new for you, less
// what you dismissed or cleared, with the words and addresses their lines use.
//
// What has an agent waiting on you, in the bell's menu: its permission prompts and questions, threads an API error
// stopped or whose last turn ended saying they need you or that they're blocked (askingThreads), and routines that are
// failing (failingRoutines), the longest waiting first, each with how long it has waited. What agents left for you to
// do is with your tasks. Your threads' news (News: a long turn that ended, a pull request that merged or went bad, what
// an agent flagged, a thread Auto-archive archived) and what someone else put you in (New for you) (addedFor on the
// server): a line each under the bell for a week, until you dismiss it or clear them all (Clear notifications). The
// bell's badge counts the ones since you last opened it, and those have a dot while it's open (useBell's `fresh`).
import { useMemo } from "react";
import { create } from "zustand";
import { post } from "../../lib/api.ts";
import { agentHref, personHref, routineHref, taskHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { Added, PageData, Question, RoutineRow, Thread } from "../../lib/types.ts";

// A line under the bell, as the server's addedFor sends it: what someone put you in, or a thread's news (`news`:
// "turn", "pr", a flag) or that Auto-archive archived it (kind "archived").
export type BellLine = Added & {
  news?: string;
  title?: string;
  emoji?: string;
  level?: string;
  agent?: string | null;
  why?: string;
  label?: string;
  verdict?: string;
  text?: string;
  mins?: number;
  pr?: { url?: string; number?: number | null } | null;
  link?: string | null;
};
// A thread whose last turn ended asking you something, blocked, or stopped by an API error (store.ts endedAsking).
export type AskingThread = Thread & { asking?: { kind: string; line?: string; at: string } | null };
// A routine that's failing: agentbook's (yours) or one of your agents' (an OpenClaw cron job, a routine on claude.ai).
export interface Failing {
  key: string;
  name: string;
  href: string;
  at: string | null;
  error: string | null;
  times: number;
  agent: string | null;
}

export const VERDICT_WORD: Record<string, string> = { done: "Done", found: "Found it", needs_you: "Needs you", partly: "Partly", blocked: "Blocked", nothing: "Nothing found" };
const ADDED_WORDS: Record<string, string> = { task: "added you to the task", group: "put you in", page: "made you a contributor of", thread: "put you on" };
// Someone who asks to be your contact (`contact-ask`, with what they said as `text`) or said yes to yours (`contact`)
// is said of you, with no title.
export const ABOUT_YOU = new Set(["contact-ask", "contact"]);
export const addedWords = (x: BellLine) => (x.kind === "contact-ask" ? "asks to be your contact" : x.kind === "contact" ? "said yes: you're contacts" : ADDED_WORDS[x.kind]);
export const addedHref = (x: BellLine, me: string) => (x.kind === "task" ? taskHref(x.id) : x.kind === "contact" ? personHref(x.id) : x.kind === "contact-ask" ? `#/people/${encodeURIComponent(me || "")}/about` : `#/${x.kind}s/${encodeURIComponent(x.id)}`);
export const addedKey = (x: BellLine) => `new:${x.kind}:${x.news || ""}:${x.id}:${x.by || ""}`;
export const freshKey = (x: BellLine) => `${addedKey(x)}@${x.at}`;
// A kind this page doesn't know (the server is newer than the page, until it reloads) isn't drawn as another kind's
// line.
const ADDED_KINDS = new Set(["news", "archived", "task", "group", "page", "thread", "contact-ask", "contact"]);
export const tookText = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`);
export const ASKING_WORDS: Record<string, string> = { blocked: "is blocked", needs_you: "needs you", stopped: "stopped" };

// What the bell keeps in this page: the notifications that were new when it opened (`fresh`, their keys, marked with a
// dot while it's open), and what you dismissed or cleared here, until the chrome says so too.
interface BellLocal {
  fresh: Set<string> | null;
  dismissed: Record<string, string>;
  cleared: Set<string>;
}
export const useBell = create<BellLocal>(() => ({ fresh: null, dismissed: {}, cleared: new Set() }));

// Every line under the bell can be dismissed: off the bell and its
// count, for you, on every device of yours (bell.dismiss). `key` says which line, `at` when what it says happened: the
// same thing happening again later (a thread asking again, a routine failing again) is a new line. What it was about
// stays as it is: a question is still open on its thread, a routine still failed on its page.
export function dismiss(key: string, at: string | null | undefined) {
  const when = at || "";
  useBell.setState((b) => ({ dismissed: { ...b.dismissed, [key]: when } }));
  return post("/api/bell/dismiss", { key, at: when });
}
// Clear notifications: every line of news and of what someone put you in, off the bell. What needs you stays.
export function clearAdded(list: BellLine[]) {
  useBell.setState((b) => ({ cleared: new Set([...b.cleared, ...list.map(freshKey)]) }));
  return post("/api/bell/clear", {});
}

// What you dismissed: the chrome's, and what you dismissed here since, whichever is later.
function dismissedOf(data: PageData | null, local: Record<string, string>): Record<string, string> {
  const d = { ...(data?.dismissed || {}) };
  for (const [k, at] of Object.entries(local)) if (!(k in d) || d[k] < at) d[k] = at;
  return d;
}
const goneFrom = (d: Record<string, string>) => (key: string, at: string | null | undefined) => key in d && !(d[key] < (at || ""));

// Your routines (agentbook's), not archived; the ones waiting for your OK; and one failing, as Routines counts them
// (two failures in a row).
export const myRoutines = (data: PageData | null): RoutineRow[] => (data?.routines || []).filter((r) => !r.archived);
export const waitingRoutines = (data: PageData | null) => myRoutines(data).filter((r) => r.waiting);
export const routineFailing = (r: RoutineRow) => !!r.live_v && r.fails >= 2;

// Your threads whose last turn ended saying they need you, or that they're blocked, with nothing here to answer:
// their reply says what, with replies to pick (store.ts endedAsking). And those an API error stopped: a usage limit,
// a refused request, an expired login (stateOf there). Until you write to one or archive it.
const askingThreads = (rows: Record<string, Thread>) => (Object.values(rows) as AskingThread[]).filter((s) => s.asking && s.effective === "needs" && s.mine !== false);
// Your routines that are failing, until a run goes well, you pause one, or you dismiss that failure, which a later one
// brings back: agentbook's, as Routines counts them (two failures in a row), and your agents' whose last run failed
// (an OpenClaw cron job, a routine on claude.ai), which their machines say (failedRoutines).
function failingRoutines(data: PageData | null, dismissed: Record<string, string>): Failing[] {
  const mine = myRoutines(data)
    .filter((r) => r.on && routineFailing(r))
    .map((r) => ({ key: r.id, name: r.name, href: routineHref(r.id), at: r.last?.at || null, error: r.last?.error || null, times: r.fails, agent: r.runs_as || null }));
  const theirs = (data?.agents || []).filter((a) => a.mine !== false).flatMap((a) => (a.routines?.failed || []).map((r) => ({ ...r, key: `${a.id}/${r.id}`, href: `${agentHref(a.id, "routines")}/${encodeURIComponent(r.id)}`, agent: a.id })));
  return [...mine, ...theirs].filter((r) => !(r.key in dismissed) || dismissed[r.key] < (r.at || ""));
}

// What the bell lists of each kind: what's there, less what you dismissed (and, of what's new, what you cleared).
export interface BellLists {
  questions: Question[];
  asking: AskingThread[];
  failed: Failing[];
  added: BellLine[];
  // What waits on you (the tab's title counts it), and that with what's new since you last opened the bell (its badge).
  needs: number;
  told: number;
}
export function bellLists(data: PageData | null, rows: Record<string, Thread>, local: BellLocal): BellLists {
  const dismissed = dismissedOf(data, local.dismissed);
  const gone = goneFrom(dismissed);
  const questions = (data?.questions || []).filter((q) => !q.answered && !gone(`q:${q.id}`, q.asked));
  const asking = askingThreads(rows).filter((s) => !gone(`ask:${s.id}`, s.asking.at));
  const failed = failingRoutines(data, dismissed);
  const added = ((data?.added || []) as BellLine[]).filter((x) => ADDED_KINDS.has(x.kind) && !gone(addedKey(x), x.at) && !local.cleared.has(freshKey(x)));
  const needs = questions.length + asking.length + failed.length;
  // News and what someone put you in count on the bell until you open it; the tab's title counts only what waits on you.
  return { questions, asking, failed, added, needs, told: needs + added.filter((x) => !x.seen).length };
}
export function useBellLists(): BellLists {
  const data = useApp((s) => s.data);
  const rows = useApp((s) => s.rows);
  const dismissed = useBell((b) => b.dismissed);
  const cleared = useBell((b) => b.cleared);
  return useMemo(() => bellLists(data, rows, { fresh: null, dismissed, cleared }), [data, rows, dismissed, cleared]);
}
