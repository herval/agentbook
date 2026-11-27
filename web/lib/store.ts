// What the page holds that more than one screen reads: who you are, the chrome (q/side: agents, pages, groups,
// machines, workspaces, tasks, routines, questions, the open threads' rows), the list of threads on screen (q/feed),
// the thread open on its own page or in a bar (q/thread), the page's stream, and where you are. Each screen keeps what
// only it reads (what it fetched, what's open or typed) in its own components.
//
// One zustand store: read it with useApp(selector) in a component, or useApp.getState() outside one.
import { create } from "zustand";
import { parseRoute } from "./route.ts";
import type { AgentSeen, AuthInfo, Changes, FeedList, Me, PageData, Person, Route, Steps, Thread, ThreadDetail } from "./types.ts";

// The thread open on its own page (or in a page's or a group's threads bar): it, its steps and what it changed, as
// q/thread and the page's stream say.
export interface OpenThread {
  id: string;
  detail: ThreadDetail | null;
  steps: Steps | null;
  chg: Changes | null;
  // It's gone, or isn't yours to see.
  gone: boolean;
  loading: boolean;
  // In a bar rather than on its own page.
  bar: boolean;
}

export interface AppState {
  // Signed in as, and what the server says about signing in (whether the page is an account's, and its relay).
  me: Me | null;
  auth: AuthInfo;
  // /api/auth/me has answered.
  booted: boolean;
  // The chrome (side.ts).
  data: PageData | null;
  // Thread rows: the chrome's (every open thread, and those it names), then those other screens' answers brought.
  rows: Record<string, Thread>;
  more: Record<string, Thread>;
  // Everyone with an account here, for their avatars.
  people: Person[] | null;
  // The page's stream: its id once the server knows it, and whether it's connected.
  liveId: string | null;
  conn: "connecting" | "reconnecting" | null;
  feed: FeedList | null;
  open: OpenThread | null;
  // Where you are (route.ts).
  route: Route;
  // The page code the server hands out, as it said when this page loaded (a newer one reloads the page).
  ui: string | null;
}

export const useApp = create<AppState>(() => ({
  me: null,
  auth: {},
  booted: false,
  data: null,
  rows: {},
  more: {},
  people: null,
  liveId: null,
  conn: "connecting",
  feed: null,
  open: null,
  route: parseRoute(),
  ui: null,
}));
export const getApp = useApp.getState;
export const setApp = useApp.setState;

// Someone else's public post by a private agent comes without its agent (null): others see that the agent is
// private, not which one.
export const PRIVATE_AGENT: AgentSeen = { id: null, name: "Private agent", kind: "" };
export const agentOf = (id: string | null | undefined, data = getApp().data): AgentSeen => (id == null ? PRIVATE_AGENT : data?.agents.find((a) => a.id === id) || { id, name: id, kind: "" });
export const useAgent = (id: string | null | undefined): AgentSeen => useApp((s) => agentOf(id, s.data));

// A thread's row, wherever the page has it: the chrome's, another screen's, a card the feed shows, or the open thread.
export function threadRow(id: string | null | undefined, s: AppState = getApp()): Thread | undefined {
  if (id == null) return undefined;
  return s.rows[id] || s.more[id] || (s.feed?.records[`thread:${id}`] as Thread) || (s.open?.id === id ? (s.open.detail as Thread) : undefined);
}
export const useThreadRow = (id: string | null | undefined) => useApp((s) => threadRow(id, s));
// The same as fully as the page has it: its open page's record, or the feed's, ahead of its row, which holds only what
// lists read (server/side.ts's ROW: no rt or mode).
export function threadRecord(id: string | null | undefined, s: AppState = getApp()): Thread | undefined {
  if (id == null) return undefined;
  return (s.open?.id === id ? (s.open.detail as Thread) : undefined) || (s.feed?.records[`thread:${id}`] as Thread) || threadRow(id, s);
}
export const useThreadRecord = (id: string | null | undefined) => useApp((s) => threadRecord(id, s));
// Rows another screen's answer brought (a page's, a group's, a task's threads), kept so links and chips find them.
export function takeRows(rows: Thread[] | null | undefined) {
  if (!rows?.length) return;
  setApp((s) => ({ more: { ...s.more, ...Object.fromEntries(rows.map((r) => [r.id, r])) } }));
}
export const allRows = (s: AppState = getApp()): Thread[] => [...Object.values(s.rows), ...Object.values(s.more).filter((r) => !s.rows[r.id])];

// A person, by their username: you, or someone with an account here.
export const ME = "@me";
export function personOf(who: string | Person | null | undefined, s: AppState = getApp()): Person {
  if (who && typeof who !== "string") return who;
  return (who === s.me?.username ? s.me : s.people?.find((u) => u.username === who)) || ({ username: who } as Person);
}
