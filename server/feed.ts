// The feed, worked out on the server: what it lists for a person, in its order, a
// page of it at a time, and how many each of its menus would show. The same rules the page had (app.js: LENS.feed,
// inFilter, sortPosts, withPages, feedPages, stateN, scopeN, ctxN), over the view the person may see (viewForReq).
//
// What it lists, top to bottom: threads still starting (only under Any status and Running), then pinned threads,
// the latest pin first, then threads by when they started (a cron job's, by its latest run that reported something)
// and pages by when they last changed, newest first.
// A status picks threads by how they're going; Hidden and Archived are shelves, off the rest. Agent, workspace,
// page and group narrow it: several of one kind show what's in any of them, picks of two kinds what's in both.
// Pages show only where nothing but a page is picked: the ones you follow, or the ones picked. One whose latest
// update you archived is under Archived until it changes again.

import { found, haystack, searchWords, typoBudget } from "../plugin/shared/search.ts";
import type { Message } from "../plugin/shared/api.ts";
import type { Iso } from "../plugin/shared/types.ts";

export const FEED_FILTERS: string[] = ["all", "working", "needs", "done", "pages", "hidden", "archived"];
export const SCOPE_KEYS = ["agent", "workspace", "page", "group"] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];

// A thread as the feed reads it: a row of a person's view (main.ts's viewForReq), or a thread of their own (a talk,
// with its agents and the workspace it names).
export interface FeedThread {
  id: string;
  agent?: string | null;
  agents?: string[];
  talk?: boolean;
  workspace?: string | null;
  machine?: string;
  root?: string | null;
  title?: string | null;
  label?: string | null;
  repo?: string | null;
  branch?: string | null;
  text?: string | null;
  prompt?: string | null;
  updates?: { text?: string | null }[];
  last_messages?: { text?: string | null }[];
  effective?: string;
  archived?: boolean;
  hidden?: boolean;
  page?: string | null;
  group?: string | null;
  guest_of?: string | null;
  guest_joined?: boolean;
  pinned?: boolean;
  pinned_at?: Iso | null;
  started?: Iso;
  // When a cron job's latest run reported something: where it goes in the feed's order.
  moved?: Iso;
  launch?: string | null;
}
export interface FeedPage {
  id: string;
  title?: string;
  about?: string | null;
  last?: { summary?: string | null } | null;
  followed?: boolean;
  // When it was archived.
  archived?: Iso | null;
  feed_archived?: boolean;
  updated?: Iso;
  moved?: Iso;
}
// A thread or page a contact on another agentbook published to you (server/api/people-things.ts's theirFeed): on
// your feed alone, read only. `state`: a thread's, as their page says it.
export interface FeedTheir {
  id: string;
  type: "thread" | "page";
  title?: string | null;
  text?: string | null;
  state?: string | null;
  last?: { text?: string | null } | null;
  started?: Iso | null;
  updated?: Iso | null;
}
// A thread still starting.
export interface FeedLaunch {
  id: string;
  agent?: string | null;
  post?: string | null;
  // When it was archived.
  archived?: Iso | null;
  guest_of?: string | null;
  page?: string | null;
  group?: string | null;
  root?: string | null;
  machine?: string;
}
// What the feed reads of a person's view (main.ts's viewForReq).
export interface FeedView {
  sessions: FeedThread[];
  talks?: FeedThread[];
  agents: { id: string; mine?: boolean; hidden?: boolean }[];
  pages?: FeedPage[];
  launches?: FeedLaunch[];
  workspaces?: { id: string; repo?: string | null; folders?: { machine: string; path: string }[] }[];
  folders?: { root: string; remote?: string | null; machine?: string }[];
  machine?: string | null;
  // The threads that don't reach the person's own feed, by id.
  offFeed?: Set<string>;
}
// The address's narrowing (feedParams).
export interface FeedParams {
  filter: string;
  scope: Record<ScopeKey, string[]>;
  q: string;
  feed?: boolean;
}
// What searching every message found (main.ts's searchMessages): the words some message has as typed, and, by
// thread, the words its messages have as typed and with typos, and the message that has the most.
export interface MessageHits {
  exact: string[];
  posts: { post: string; exact: string[]; typo: string[]; hit: Pick<Message, "id" | "from" | "text" | "at"> | null }[];
}
// Where an item is in the feed's order: its tier ("0" pinned), two times, its kind ("0" a thread) and its key.
export type SortKey = [string, string, string, string, string];
// One thing the feed lists: a thread, a page, a contact's from elsewhere, or a thread still starting (which has no
// place: it's always on top).
export type FeedItem<T = FeedThread, P = FeedPage, L = FeedLaunch, R extends FeedTheir = FeedTheir> =
  | { key: string; kind: "thread"; x: T; sort?: SortKey }
  | { key: string; kind: "page"; x: P; sort?: SortKey }
  | { key: string; kind: "their"; x: R; sort?: SortKey }
  | { key: string; kind: "launch"; x: L; sort: null };
// The items of a view, by their kinds as it has them.
type ThreadIn<V extends FeedView> = V["sessions"][number] | NonNullable<V["talks"]>[number];
type PageIn<V extends FeedView> = NonNullable<V["pages"]>[number];
type LaunchIn<V extends FeedView> = NonNullable<V["launches"]>[number];
// A search's text, folded (plugin/shared/search.ts's haystack).
interface Hay {
  src: string;
  f: string;
  words: string[];
}
// A searched word, and how many typos it may have.
interface Term {
  w: string;
  typos: number;
}

const shelf = (s: FeedThread) => (s.archived ? "archived" : s.hidden ? "hidden" : null);
// Running: a turn going, or waiting on its owner. Idle ("done" in the address): waiting for a prompt, asleep or ended.
const inFilter = (s: FeedThread, f: string) => (f === "archived" || f === "hidden" ? shelf(s) === f : !shelf(s) && (f === "all" || (f === "working" ? ["working", "waiting"] : f === "done" ? ["done", "idle"] : [f]).includes(s.effective)));
const isThread = (s: FeedThread, f: string) => f !== "pages" && inFilter(s, f);
// An agent you've hidden keeps its threads off the feed.
const hiddenAgent = (a: FeedView["agents"][number] | undefined) => !!a && a.mine !== false && !!a.hidden;

// The address's narrowing: `?filter=working&agent=a,b&workspace=w&page=p&group=g&q=words`. `feed=1`: it's your feed,
// so of others' threads only what reaches you (not in the view's `offFeed`: an agent you follow, what you're in); an agent's
// profile, a group's or a workspace's page and a search list every thread you see.
export function feedParams(query: URLSearchParams | Record<string, string>): FeedParams {
  const get = (k: string): string => (isQuery(query) ? query.get(k) : query[k]) ?? "";
  const filter = FEED_FILTERS.includes(get("filter")) ? get("filter") : "all";
  const scope = Object.fromEntries(SCOPE_KEYS.map((k) => [k, [...new Set(String(get(k)).split(",").filter(Boolean))].slice(0, 50)])) as Record<ScopeKey, string[]>;
  return { filter, scope, q: String(get("q")).slice(0, 200), feed: get("feed") === "1" };
}
const isQuery = (q: URLSearchParams | Record<string, string>): q is URLSearchParams => typeof q.get === "function";
// The same, as a key: two pages asking for the same feed get the same answer.
export const feedKey = ({ filter, scope, q, feed = false }: FeedParams): string => JSON.stringify([filter, SCOPE_KEYS.map((k) => [...scope[k]].sort()), q, ...(feed ? ["feed"] : [])]);

// What a search looks through of a thread, as the page did: its title, label, repo, branch, text, prompt, results
// and latest messages. Every message is searched too (`messages`, main.ts's searchMessages).
const hays = new WeakMap<FeedThread, Hay>();
function hayOf(s: FeedThread): Hay {
  const src = [s.title, s.label, s.repo, s.branch, s.text, s.prompt, ...(s.updates || []).map((u) => u.text), ...(s.last_messages || []).map((m) => m.text)].map((x) => x ?? "").join(" ");
  let h = hays.get(s);
  if (h?.src !== src) hays.set(s, (h = haystack(src)));
  return h;
}
const pageHay = (p: FeedPage): Hay => haystack([p.title, p.about, p.last?.summary].filter(Boolean).join(" "));
const theirHay = (r: FeedTheir): Hay => haystack([r.title, r.text, r.last?.text].filter(Boolean).join(" "));

// Workspaces, each with its checkouts on every machine, and the ones each thread ran in (or below): as app.js's
// workspaces().
export interface Workspaces {
  list: { id: string; checkouts: { machine: string; root: string }[] }[];
  of: (s: { id: string }) => string[];
  under: (x: { root?: string | null; machine?: string }) => string[];
}
export function workspacesOf(v: FeedView): Workspaces {
  const machineOf = (x: { machine?: string }) => x.machine || v.machine;
  const folders = v.folders || [];
  const list = (v.workspaces || []).map((w) => {
    const given = (machine: string, root: string) => (w.folders || []).some((f) => f.machine === machine && f.path === root);
    const checkouts = folders.filter((f) => (w.repo && f.remote === w.repo) || given(machineOf(f), f.root)).map((f) => ({ machine: machineOf(f), root: f.root }));
    for (const f of w.folders || []) if (!checkouts.some((c) => c.machine === f.machine && c.root === f.path)) checkouts.push({ machine: f.machine, root: f.path });
    return { id: w.id, checkouts };
  });
  const under = (x: { root?: string | null; machine?: string }) => list.filter((w) => !!x.root && w.checkouts.some((c) => c.machine === machineOf(x) && (x.root === c.root || x.root.startsWith(`${c.root}/`)))).map((w) => w.id);
  const of = new Map<string, string[]>();
  for (const s of v.sessions) if (s.root) of.set(s.id, under(s));
  // A thread of a person's own is in the workspace it names.
  for (const t of v.talks || []) if (t.workspace) of.set(t.id, [t.workspace]);
  return { list, of: (s) => of.get(s.id) || [], under };
}

// The order: pinned threads first, the latest pin on top; then threads by when they started and pages by when they
// last changed (a routine's quiet refresh doesn't move one), newest first, a thread before a page at the same time.
const sortKey = (it: Exclude<FeedItem, { kind: "launch" }>): SortKey =>
  it.kind === "their"
    ? ["1", (it.x.type === "page" ? it.x.updated : it.x.started) || "", "", it.x.type === "page" ? "1" : "0", it.key]
    : it.kind === "thread" && it.x.pinned
      ? ["0", it.x.pinned_at || "", it.x.started || "", "0", it.key]
      : ["1", it.x.moved || (it.kind === "page" ? it.x.updated : it.x.started) || "", "", it.kind === "page" ? "1" : "0", it.key];
// Newest first within a tier: descending times, then ascending kind and key.
function compare(a: SortKey, b: SortKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  for (const i of [1, 2]) if (a[i] !== b[i]) return a[i] > b[i] ? -1 : 1;
  for (const i of [3, 4]) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
// Where a page of the feed ends: the last one's place, for the next page to start after.
export const cursorOf = (it: { sort?: SortKey | null }): string => Buffer.from(JSON.stringify(it.sort)).toString("base64url");
const isSortKey = (k: unknown): k is SortKey => Array.isArray(k) && k.length === 5 && k.every((x) => typeof x === "string");
function placeOf(cursor: string): SortKey | null {
  try {
    const k = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    return isSortKey(k) ? k : null;
  } catch {
    return null;
  }
}
export const afterPlace = (it: { sort?: SortKey }, cursor: string): boolean => {
  const k = placeOf(cursor);
  return !k || compare(it.sort, k) > 0;
};
export const beforePlace = (it: { sort?: SortKey }, cursor: string): boolean => {
  const k = placeOf(cursor);
  return !k || compare(it.sort, k) <= 0;
};

// The search's words, and how many typos each may have: none when some thread has it as typed. `messages`: what
// searching every message found ({ exact: [words], posts: [{ post, exact, typo, hit }] }).
function searchOf(v: FeedView, q: string, messages: MessageHits | null) {
  const words: string[] = searchWords(q).slice(0, 10);
  if (!words.length) return null;
  const exact = new Set(messages?.exact || []);
  const posts = new Map((messages?.posts || []).map((p) => [p.post, { exact: new Set(p.exact), typo: new Set(p.typo), hit: p.hit }]));
  const all = [...v.sessions, ...(v.talks || [])].map(hayOf);
  const terms = words.map((w): Term => ({ w, typos: exact.has(w) || all.some((h) => h.f.includes(w)) ? 0 : typoBudget(w) }));
  const finds = (s: FeedThread) => {
    const r = posts.get(s.id);
    const hay = hayOf(s);
    return terms.every((t) => found(hay, t) || r?.exact.has(t.w) || (t.typos > 0 && r?.typo.has(t.w)));
  };
  const pageFinds = (p: FeedPage) => {
    const hay = pageHay(p);
    return terms.every((t) => found(hay, t));
  };
  return { words, terms, posts, finds, pageFinds };
}

// The feed for a view: every item it lists, in order ({ key, kind, x, sort }), and its counts. `messages`: what
// searching every message found for `q`, when there's a search.
export interface Feed<T = FeedThread, P = FeedPage, L = FeedLaunch, R extends FeedTheir = FeedTheir> {
  list: FeedItem<T, P, L, R>[];
  counts: { states: Record<string, number>; threads: number; pages: number };
  // How many each agent, workspace and place (`feed`, `page:<id>`, `group:<id>`) would show.
  menus: { agent: Record<string, number>; workspace: Record<string, number>; ctx: Record<string, number> };
  search: ReturnType<typeof searchOf>;
}
// `theirs`: contacts' things from other agentbooks that reach you, for your feed (never in the view, which agents read).
export function feedOf<V extends FeedView, R extends FeedTheir = FeedTheir>(v: V, { filter = "all", scope, q = "", feed = false }: FeedParams, { messages = null, theirs = [] }: { messages?: MessageHits | null; theirs?: R[] } = {}): Feed<ThreadIn<V>, PageIn<V>, LaunchIn<V>, R> {
  const agents = new Map(v.agents.map((a) => [a.id, a]));
  const ws = workspacesOf(v);
  const search = q ? searchOf(v, q, messages) : null;
  // A thread of a person's own is each of its agents'.
  const of: Record<ScopeKey, (s: FeedThread) => string[]> = { agent: (s) => (s.talk ? s.agents : [s.agent]), workspace: ws.of, page: (s) => [s.page], group: (s) => [s.group] };
  const launchOf: Record<ScopeKey, (l: FeedLaunch) => string[]> = { agent: (l) => [l.agent], workspace: ws.under, page: (l) => [l.page], group: (l) => [l.group] };
  const inScope = <X>(by: Record<ScopeKey, (x: X) => string[]>, x: X, except: (k: ScopeKey) => boolean = () => false) => SCOPE_KEYS.every((k) => except(k) || !scope[k].length || by[k](x).some((id) => scope[k].includes(id)));
  // Not your hidden agents' threads, unless it's narrowed to one of them (its profile).
  // Nor a guest's: the thread it's a guest in shows it, as its agent's profile does. A
  // thread that was running when it was brought in (`guest_joined`) keeps its card: it has work of its own.
  // On your feed, of others' threads only what reaches you (not `offFeed`), unless you search.
  const reaches = (s: FeedThread) => !feed || !!search || !v.offFeed?.has(s.id);
  const items: ThreadIn<V>[] = [...v.sessions, ...(v.talks || [])].filter((s) => reaches(s) && (!search || search.finds(s)) && (!hiddenAgent(agents.get(s.agent)) || scope.agent.includes(s.agent)) && (!s.guest_of || s.guest_joined || scope.agent.includes(s.agent)));
  const pageMatches = (p: FeedPage) => !search || search.pageFinds(p);
  // The pages it can show: none when narrowed to an agent, a workspace or a group (a page isn't in one).
  const feedPages: PageIn<V>[] = scope.agent.length || scope.workspace.length || scope.group.length ? [] : (v.pages || []).filter((p) => (scope.page.length ? scope.page.includes(p.id) : p.followed) && pageMatches(p));
  // An archived page, and one whose latest update you archived (`feed_archived`, until it changes), are under Archived.
  const away = (p: FeedPage) => !!p.archived || !!p.feed_archived;
  const shownPages = ["all", "pages"].includes(filter) ? feedPages.filter((p) => !away(p)) : filter === "archived" ? feedPages.filter(away) : [];

  // A contact's from elsewhere: on your feed while nothing narrows it, a thread by how it's going, as yours are.
  const narrowed = SCOPE_KEYS.some((k) => scope[k].length);
  const theirIn = (r: FeedTheir, f: string) => (r.type === "page" ? ["all", "pages"].includes(f) : f !== "pages" && inFilter({ id: r.id, effective: r.state || "done" }, f));
  const theirsShown = feed && !narrowed ? theirs.filter((r) => !search || search.terms.every((t) => found(theirHay(r), t))) : [];
  const theirList = theirsShown.filter((r) => theirIn(r, filter));

  const threads = filter === "pages" ? [] : items.filter((s) => inFilter(s, filter) && inScope(of, s));
  const launches: LaunchIn<V>[] = ["all", "working"].includes(filter) ? (v.launches || []).filter((l) => !l.post && !l.archived && !l.guest_of && inScope(launchOf, l)) : [];
  type Item = FeedItem<ThreadIn<V>, PageIn<V>, LaunchIn<V>, R>;
  const listed: Exclude<Item, { kind: "launch" }>[] = [...threads.map((s) => ({ key: `thread:${s.id}`, kind: "thread" as const, x: s })), ...shownPages.map((p) => ({ key: `page:${p.id}`, kind: "page" as const, x: p })), ...theirList.map((r) => ({ key: `their:${r.id}`, kind: "their" as const, x: r }))];
  for (const it of listed) it.sort = sortKey(it as Exclude<FeedItem, { kind: "launch" }>);
  listed.sort((a, b) => compare(a.sort, b.sort));
  const list: Item[] = [...launches.map((l): Item => ({ key: `launch:${l.id}`, kind: "launch", x: l, sort: null })), ...listed];

  // The status menu: how many each would show as the other menus narrow it. Pages, once some page could show;
  // Hidden, once something is.
  const stateN = (f: string) => (f === "pages" ? feedPages.filter((p) => !away(p)).length : items.filter((s) => isThread(s, f) && inScope(of, s)).length) + theirsShown.filter((r) => theirIn(r, f)).length;
  const states = ["all", "working", "needs", "done"];
  if (feedPages.some((p) => !away(p)) || theirsShown.some((r) => r.type === "page") || filter === "pages") states.push("pages");
  if (filter === "hidden" || v.sessions.some((s) => s.hidden && !s.archived)) states.push("hidden");
  states.push("archived");
  const counts = { states: Object.fromEntries(states.map((f) => [f, stateN(f)])), threads: threads.length + theirList.filter((r) => r.type === "thread").length, pages: shownPages.length + theirList.filter((r) => r.type === "page").length };

  // The agent and workspace menus: how many each would show, in the status picked, as the other menus narrow it.
  const menus: Feed["menus"] = { agent: {}, workspace: {}, ctx: { feed: 0 } };
  const bump = (m: Record<string, number>, id: string | null | undefined) => id != null && (m[id] = (m[id] || 0) + 1);
  if (filter !== "pages") {
    for (const s of items) {
      if (!isThread(s, filter)) continue;
      if (inScope(of, s, (k) => k === "agent")) for (const a of of.agent(s)) bump(menus.agent, a);
      if (inScope(of, s, (k) => k === "workspace")) for (const id of ws.of(s)) bump(menus.workspace, id);
      // Where you are, one at a time: your feed, a page or a group, as agent and workspace narrow it.
      if (inScope(of, s, (k) => k === "page" || k === "group")) {
        menus.ctx.feed++;
        if (s.page) bump(menus.ctx, `page:${s.page}`);
        if (s.group) bump(menus.ctx, `group:${s.group}`);
      }
    }
  }
  menus.ctx.feed += theirList.filter((r) => r.type === "thread").length;
  // On the feed, a page's own card counts too.
  if (!scope.agent.length && !scope.workspace.length) for (const p of v.pages || []) if (pageMatches(p) && (away(p) ? filter === "archived" : ["all", "pages"].includes(filter))) bump(menus.ctx, `page:${p.id}`);
  return { list, counts, menus, search };
}

// One page of a feed: `n` items after `after` (a cursor; from the top without one), threads still starting always
// on top of the first. `next`: where the one after it starts, or null at the end.
export function pageOf<T, P, L, R extends FeedTheir>(feed: Pick<Feed<T, P, L, R>, "list">, { after = null, n = 20 }: { after?: string | null; n?: number } = {}): { shown: FeedItem<T, P, L, R>[]; next: string | null } {
  const rest = feed.list.filter((it) => it.kind !== "launch" && (!after || afterPlace(it, after)));
  const shown = [...(after ? [] : feed.list.filter((it) => it.kind === "launch")), ...rest.slice(0, n)];
  const last = rest[Math.min(n, rest.length) - 1];
  return { shown, next: rest.length > n && last ? cursorOf(last) : null };
}
