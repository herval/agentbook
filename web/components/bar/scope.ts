// The filter bar, as logic (app.ts "the filter bar: the Feed, Tasks and WIP, narrowed by status, agent, workspace
// and page"): what each screen lists and how the bar reads it (LENS), what's picked, how many each pick would show,
// and what picking does. ScopeBar.tsx draws it.
//
// Agent, workspace and page are one scope that stays as you go from page to page, in each one's address; status
// is each page's own. Several of one kind show what's in any of them; picks of two kinds, what's in both.
import { create } from "zustand";
import { hiddenAgent, startable, workspaces } from "../../lib/agents.ts";
import { followHash, NO_SCOPE, SCOPE_KEYS, scopeHref } from "../../lib/route.ts";
import { getApp } from "../../lib/store.ts";
import type { FeedList, Route, Scope } from "../../lib/types.ts";
import { FILTERS } from "../pages/pages.ts";
import { inScope, tasksLens } from "../tasks/tasks.ts";
import { worktreesLens } from "../worktrees/wips.ts";
import { getCompose, setCompose } from "./compose.ts";

export type ScopeName = "feed" | "tasks" | "worktrees" | "agent" | "workspace" | "group";
export type ScopeKey = (typeof SCOPE_KEYS)[number];
export type HereName = "agent" | "workspace" | "group";
export const SCOPED: Record<string, boolean> = { feed: true, tasks: true, worktrees: true };
// An agent's threads, a workspace's and a group's have the bar too, as the server lists them (q/feed, narrowed to
// the page): the feed's menus but the one the page already is, and the status. What's picked lasts while you're
// on that page (hereScope, filter).
export const HERE: Record<HereName, (ScopeKey | "status")[]> = { agent: ["workspace", "status"], workspace: ["agent", "status"], group: ["agent", "workspace", "status"] };
export const isHere = (name: string): name is HereName => name in HERE;

// The feed's statuses: the ones the server counted (Pages once a page could show, Hidden once something is).
export const FEED_KEYS = ["all", ...FILTERS.map(([k]) => k), "pages"];
const HERE_KEYS = ["all", ...FILTERS.map(([k]) => k)];

// What the bar keeps while you're on a screen: the menu open (fbOpen) and what's typed in its find box (fbFind),
// and on an agent's, a workspace's or a group's page, what its bar narrows its threads to (hereScope, filter), for
// that page alone (`at`): another page starts with none.
interface BarUi {
  open: string | null;
  find: string;
  at: string;
  here: Scope;
  filter: string;
}
export const useBar = create<BarUi>(() => ({ open: null, find: "", at: "", here: NO_SCOPE, filter: "all" }));
export const setBar = (p: Partial<BarUi>) => useBar.setState(p);
const hereKey = (r: Pick<Route, "name" | "id">) => `${r.name}/${r.id || ""}`;
// What an agent's, a workspace's or a group's page has picked, while you're on it.
export const hereScopeOf = (s: BarUi, r: Pick<Route, "name" | "id">) => (s.at === hereKey(r) ? s.here : NO_SCOPE);
export const hereFilterOf = (s: BarUi, r: Pick<Route, "name" | "id">) => (s.at === hereKey(r) ? s.filter : "all");

// A list's ask (q/feed's query) on an agent's, a workspace's or a group's page, as its bar narrows it.
export function hereAsk(name: HereName, id: string, here: Scope = NO_SCOPE, filter = "all", q = ""): string {
  const p = new URLSearchParams();
  if (filter !== "all") p.set("filter", filter);
  for (const k of HERE[name]) if (k !== "status" && here[k].length) p.set(k, here[k].join(","));
  p.set(name, id);
  if (q) p.set("q", q);
  return p.toString();
}
// The page's list's ask now, as its bar has it: what an agent's, a workspace's or a group's page asks q/feed for.
export function useHereAsk(name: HereName, id: string | null | undefined, q: string, on = true): string | null {
  const here = useBar((s) => (id ? hereScopeOf(s, { name, id }) : NO_SCOPE));
  const filter = useBar((s) => (id ? hereFilterOf(s, { name, id }) : "all"));
  return on && id ? hereAsk(name, id, here, filter, q) : null;
}
// The feed's ask: of others' threads, what you follow and are in (feed.ts), narrowed as its bar says.
export function feedAsk(scope: Scope, status: string, q: string): string {
  const p = new URLSearchParams();
  p.set("feed", "1");
  if (status !== "all") p.set("filter", status);
  for (const k of SCOPE_KEYS) if (scope[k].length) p.set(k, scope[k].join(","));
  if (q) p.set("q", q);
  return p.toString();
}
// The feed's status: its address's, else the one this browser kept (agentbook.feedFilter), so "Running" stays
// picked when you come back.
export const feedStatus = (r: Route, kept: string) => (r.status && FEED_KEYS.includes(r.status) ? r.status : FEED_KEYS.includes(kept) ? kept : "all");

// What each page lists, and how the bar reads it: its items, each one's agents, workspaces and pages, and its
// states, the first of them being what it shows with none picked. The feed's and a here page's are the server's
// (q/feed): what it lists, and how many each menu would show.
export interface Lens {
  items?: () => unknown[];
  of?: Record<ScopeKey, (x: unknown) => unknown[]>;
  keys: string[];
  states: () => [string, string][];
  is?: (x: unknown, f: string) => boolean;
}
export function lensOf(name: ScopeName, F: FeedList | null, status: string): Lens {
  if (name === "feed")
    return {
      keys: FEED_KEYS,
      states: () => ([["all", "Any status"], ...FILTERS.slice(0, 3), ["pages", "Pages"], ...FILTERS.slice(3)] as [string, string][]).filter(([k]) => (F ? k in F.counts.states : !["pages", "hidden"].includes(k) || k === status)),
    };
  if (name === "tasks") return tasksLens as unknown as Lens;
  if (name === "worktrees") return worktreesLens as unknown as Lens;
  return {
    keys: HERE_KEYS,
    states: () => ([["all", "Any status"], ...FILTERS] as [string, string][]).filter(([k]) => k !== "hidden" || k === status || (!!F && "hidden" in F.counts.states)),
  };
}
// How many a status would show here, as the other menus narrow it.
export function stateN(lens: Lens, F: FeedList | null, scope: Scope, f: string): number {
  if (!lens.items) return F?.counts.states[f] || 0;
  return lens.items().filter((x) => lens.is(x, f) && inScope(lens.of, x, scope)).length;
}
// And one agent, workspace or page, in the status picked.
export function scopeN(lens: Lens, F: FeedList | null, scope: Scope, status: string, key: ScopeKey, id: string): number {
  if (!lens.items) return F?.menus[key]?.[id] || 0;
  return lens.items().filter((x) => lens.is(x, status) && inScope(lens.of, x, scope, key) && lens.of[key](x).includes(id)).length;
}
// Where you are, one at a time: your whole feed, a page, or a group, each with how many it would show (as the other
// menus narrow it).
export function ctxN(name: ScopeName, lens: Lens, F: FeedList | null, scope: Scope, status: string, kind: "feed" | "page" | "group", id?: string): number {
  if (name === "feed") return F?.menus.ctx[kind === "feed" ? "feed" : `${kind}:${id}`] || 0;
  if (!lens.items) return 0;
  const rest = (x: unknown) => SCOPE_KEYS.every((k) => k === "page" || k === "group" || !scope[k].length || lens.of[k](x).some((v) => scope[k].includes(v as string)));
  return lens.items().filter((x) => lens.is(x, status) && rest(x) && (kind === "feed" || lens.of[kind](x).includes(id))).length;
}

// Narrowing to one workspace picks it in the composer, and to one agent picks that agent, when it can take a
// thread now. Narrowing to one page picks it as where the thread goes, until you stop.
const oneOf = (sc: Scope, k: ScopeKey) => (sc[k]?.length === 1 ? sc[k][0] : null);
let lastScope: Scope = NO_SCOPE;
const takes = (id: string) => (getApp().data?.agents || []).some((a) => a.id === id && startable(a) && !a.offline);
export function scopePicks(sc: Scope) {
  const was = lastScope;
  lastScope = sc;
  const ws = oneOf(sc, "workspace");
  const page = oneOf(sc, "page");
  const group = oneOf(sc, "group");
  const agent = oneOf(sc, "agent");
  const c = getCompose();
  const next: Parameters<typeof setCompose>[0] = {};
  if (ws && ws !== oneOf(was, "workspace")) next.wsPick = ws;
  // Narrowing to one page, or one group, picks it as where the thread goes, until you stop.
  const before = oneOf(was, "page") || (oneOf(was, "group") && `group:${oneOf(was, "group")}`);
  if (page && page !== oneOf(was, "page")) next.pagePick = page;
  else if (group && group !== oneOf(was, "group")) next.pagePick = `group:${group}`;
  else if (!page && !group && before && c.pagePick === before) next.pagePick = "";
  if (agent && agent !== oneOf(was, "agent") && takes(agent)) next.agentPick = agent;
  if (Object.keys(next).length) setCompose(next);
}
// The address of the Feed, Tasks or Worktrees, narrowed as the bar says, put in place of the one there (a reload or a
// link keeps it).
export function narrowTo(name: "feed" | "tasks" | "worktrees", sc: Scope, status: string | null) {
  scopePicks(sc);
  const href = scopeHref(name, sc, status);
  if (location.hash !== href) {
    history.replaceState(null, "", href);
    followHash();
  }
}
// On an agent's, a workspace's or a group's page it lasts while you're there, and the composer follows it too.
export function narrowHere(r: Pick<Route, "name" | "id">, sc: Scope, filter?: string) {
  const s = useBar.getState();
  const was = hereScopeOf(s, r);
  const c: Parameters<typeof setCompose>[0] = {};
  if (sc.workspace.length === 1 && sc.workspace[0] !== was.workspace[0]) c.wsPick = sc.workspace[0];
  if (sc.agent.length === 1 && sc.agent[0] !== was.agent[0] && takes(sc.agent[0])) c.agentPick = sc.agent[0];
  if (Object.keys(c).length) setCompose(c);
  setBar({ at: hereKey(r), here: sc, filter: filter ?? hereFilterOf(s, r) });
}
// A workspace or a page that's gone, or an agent gone or hidden, stops narrowing, and the address stops saying so.
export function pruneScope(sc: Scope): Scope {
  const d = getApp().data;
  if (!d) return sc;
  const has: Record<ScopeKey, (id: string) => boolean> = {
    agent: (id) => (d.agents || []).some((a) => a.id === id && !hiddenAgent(a)),
    workspace: (id) => workspaces().some((w) => w.id === id),
    page: (id) => (d.pages || []).some((p) => p.id === id),
    group: (id) => (d.groups || []).some((g) => g.id === id),
  };
  const out = Object.fromEntries(SCOPE_KEYS.map((k) => [k, sc[k].filter(has[k])])) as Scope;
  return SCOPE_KEYS.some((k) => out[k].length !== sc[k].length) ? out : sc;
}
