// app.ts scopeBar and hereNone: the filter bar that narrows the Feed, Tasks, Worktrees, an agent's, a workspace's or a
// group's threads by status, agent, workspace, page and group; and what a list says when nothing's under what it
// picks. What it reads and what picking does are bar/scope.ts's.
import { Fragment, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import { agentName, hiddenAgent, workspaces } from "../lib/agents.ts";
import { setChrome, useChrome } from "../lib/chrome.ts";
import { loadFeed } from "../lib/feed.ts";
import { groupStyle, pageStyle, plural } from "../lib/format.ts";
import { useDismiss, usePref } from "../lib/hooks.ts";
import { NO_SCOPE, SCOPE_KEYS, useRoute } from "../lib/route.ts";
import { useApp } from "../lib/store.ts";
import type { AgentRow, FeedList, GroupRow, PageRow, Scope, TaskRow } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./Icon.tsx";
import { agentsByUse } from "./LeftNav.tsx";
import { ctxN, feedStatus, HERE, hereAsk, hereFilterOf, hereScopeOf, isHere, lensOf, narrowHere, narrowTo, pruneScope, SCOPED, scopeN, scopePicks, setBar, stateN, useBar } from "./bar/scope.ts";
import type { Lens, ScopeKey, ScopeName } from "./bar/scope.ts";
import { inScope, ticked } from "./tasks/tasks.ts";
import type { Wip } from "./worktrees/wips.ts";

export type { ScopeName } from "./bar/scope.ts";

type WsSeen = { id: string; name: string; repo?: string | null; used?: string };
// The menus: what each lists, and how a row and the button show one.
interface FbMenu {
  label: string;
  icon: IconName;
  tip: string;
  any: string;
}
const FB: Record<"status" | "agent" | "workspace" | "page", FbMenu> = {
  status: { label: "Status", icon: "status", tip: "Show only what's running, what needs you, what's done…", any: "Any status" },
  agent: { label: "Agent", icon: "bot", tip: "Show only one agent's, or a few", any: "Any agent" },
  workspace: { label: "Workspace", icon: "folder", tip: "Show only one workspace's, or a few", any: "Any workspace" },
  // Where you are: your feed, or one page or one group (ctxRows).
  page: { label: "Feed", icon: "home", tip: "Your whole feed, or just what's on one page or in one group", any: "Your whole feed" },
};
// An agent's and a workspace's menu: what each lists, its face in a row, and its name.
interface Listed {
  id: string;
  face: ReactNode;
  name: string;
}
function listOf(key: "agent" | "workspace", agents: AgentRow[]): Listed[] {
  if (key === "agent") return agentsByUse(agents.filter((a) => !hiddenAgent(a))).map((a) => ({ id: a.id, face: <Avatar agent={a.id} size="av--xs" />, name: agentName(a.id) }));
  return [...(workspaces() as WsSeen[])].sort((a, b) => (b.used || "").localeCompare(a.used || "")).map((w) => ({ id: w.id, face: <Icon name={w.repo ? "repo" : "folder"} />, name: w.name }));
}
const PgIco = ({ p }: { p: PageRow }) => (
  <span className="pg-ico" style={pageStyle(p)}>
    {p.emoji || "📄"}
  </span>
);
const GrIco = ({ g }: { g: GroupRow }) => (
  <span className="gr-ico" style={groupStyle(g)}>
    {(g as GroupRow & { emoji?: string }).emoji || "👥"}
  </span>
);

const MARKS: Record<string, string> = { working: "live", live: "live", with: "live", needs: "needs", idle: "ring", todo: "ring", done: "i:check", clear: "i:check", stuck: "i:x", ready: "i:check", review: "i:eye", branch: "i:branch", pages: "i:page", hidden: "i:eyeOff", archived: "i:archive" };
function Mark({ f }: { f: string }) {
  const m = MARKS[f] || "i:status";
  return <span className="fb-mark">{m.startsWith("i:") ? <Icon name={m.slice(2) as IconName} /> : <i className={`fb-dot fb-dot--${m}`} />}</span>;
}

const listed = (F: FeedList | null) => (F ? (F.counts.states.all || 0) + (F.counts.states.hidden || 0) + (F.counts.states.archived || 0) : 0);

// What a screen's bar has picked, and what picking does: its scope (the address's on the Feed, Tasks and Worktrees;
// the page's own on an agent's, a workspace's or a group's), its status, and its lens.
function useBarState(name: ScopeName, feedProp?: FeedList | null) {
  const route = useRoute();
  const [kept, keep] = usePref("feedFilter", "all");
  const storeFeed = useApp((s) => s.feed);
  const F = feedProp !== undefined ? feedProp : storeFeed;
  const here = useBar((s) => hereScopeOf(s, route));
  const filter = useBar((s) => hereFilterOf(s, route));
  const H = isHere(name);
  const scope: Scope = H ? here : route.scope || NO_SCOPE;
  const base = lensOf(name, F, "all");
  const status = name === "feed" ? feedStatus(route, kept) : H ? filter : base.keys.includes(route.status) ? route.status : base.keys[0];
  const lens = lensOf(name, F, status);
  const first = name === "worktrees" ? lens.keys[0] : "all";
  const statusSet = status !== first;
  const addr = (f: string) => (f === first ? null : f);
  // A status picked shows in the address too (?status=working), so a reload or a link keeps it.
  const setStatus = (f: string) => {
    if (name === "feed") keep(f);
    if (H) narrowHere(route, here, f);
    else narrowTo(name as "feed" | "tasks" | "worktrees", scope, addr(f));
  };
  const narrow = (sc: Scope) => (H ? narrowHere(route, sc) : narrowTo(name as "feed" | "tasks" | "worktrees", sc, addr(status)));
  const clearAll = () => {
    if (name === "feed") keep(first);
    if (H) narrowHere(route, { ...NO_SCOPE }, first);
    else narrowTo(name as "feed" | "tasks" | "worktrees", { ...NO_SCOPE }, null);
  };
  return { route, F, scope, here, status, lens, first, statusSet, setStatus, narrow, clearAll, H };
}
type BarState = ReturnType<typeof useBarState>;

export function ClearAll({ name, feed }: { name: ScopeName; feed?: FeedList | null }) {
  const b = useBarState(name, feed);
  return (
    <button className="link-btn" type="button" onClick={b.clearAll}>
      Clear the filters
    </button>
  );
}
// The search stays as you go from page to page, so say it's what hides the posts, with a way out.
export function NoMatch() {
  const q = useChrome((c) => c.q);
  return (
    <section className="card empty-card">
      <p>
        No threads match “{q}”.{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setChrome({ q: "" });
          }}
        >
          Clear the search
        </a>
      </p>
    </section>
  );
}

// `title`: the Feed's page menu as its list's title, "Feed" or the page's or group's name.
function FbButton({ name, k, b, agents, pages, groups, title }: { name: ScopeName; k: "status" | "agent" | "workspace" | "page"; b: BarState; agents: AgentRow[]; pages: PageRow[]; groups: GroupRow[]; title?: boolean }) {
  const m = FB[k];
  const open = useBar((s) => s.open === k);
  const close = useCallback(() => setBar({ open: null }), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const { scope, lens, F, status } = b;
  const list = k === "agent" || k === "workspace" ? listOf(k, agents) : [];
  const set = k === "status" ? b.statusSet : scope[k].length > 0 || (k === "page" && scope.group.length > 0);
  const pageOf = (id: string) => pages.find((p) => p.id === id);
  const groupOf = (id: string) => groups.find((g) => g.id === id);
  const names = k === "status" ? "" : k === "page" ? [...scope.page.map((id) => pageOf(id)?.title), ...scope.group.map((id) => groupOf(id)?.name)].filter(Boolean).join(", ") : scope[k].map((id) => list.find((x) => x.id === id)).filter(Boolean).map((x) => x.name).join(", ");
  const none = (
    <>
      {title ? null : <Icon name={m.icon} />}
      <span>{m.label}</span>
    </>
  );
  let face: ReactNode = none;
  if (k === "page") {
    const ps = scope.page.map(pageOf).filter(Boolean);
    const gs = scope.group.map(groupOf).filter(Boolean);
    const more = ps.length + gs.length - 1;
    const one = ps[0] ? (
      <>
        <PgIco p={ps[0]} />
        <span className="fb-v">{ps[0].title}</span>
      </>
    ) : gs[0] ? (
      <>
        <GrIco g={gs[0]} />
        <span className="fb-v">{gs[0].name}</span>
      </>
    ) : null;
    if (one)
      face = (
        <>
          {one}
          {more > 0 && <span className="fb-more">+{more}</span>}
        </>
      );
  } else if (k === "status") {
    const st = lens.states().find(([x]) => x === status);
    if (b.statusSet && st)
      face = (
        <>
          <Mark f={st[0]} />
          <span className="fb-v">{st[1]}</span>
          <span className="fb-more">{stateN(lens, F, scope, st[0])}</span>
        </>
      );
  } else {
    const picked = scope[k].map((id) => list.find((x) => x.id === id)).filter(Boolean);
    if (picked.length)
      face = (
        <>
          {picked.slice(0, k === "agent" ? 3 : 1).map((x) => (
            <Fragment key={x.id}>{x.face}</Fragment>
          ))}
          <span className="fb-v">{picked[0].name}</span>
          {picked.length > 1 && <span className="fb-more">+{picked.length - 1}</span>}
        </>
      );
  }
  const clear = () => (k === "status" ? b.setStatus(b.first) : b.narrow({ ...scope, [k]: [], ...(k === "page" ? { group: [] } : {}) }));
  return (
    <div className={`fb-f${set ? " is-set" : ""}${title ? " fb-title" : ""}`} ref={ref}>
      <button className="fb-opt" type="button" aria-haspopup="menu" aria-expanded={open} title={set && names ? `${k === "page" ? "Just" : `${m.label}:`} ${names}` : m.tip} onClick={() => setBar({ open: open ? null : k, find: "" })}>
        {face}
      </button>
      {set && (
        <button className="fb-x" type="button" aria-label={m.any} title={m.any} onClick={clear}>
          <Icon name="x" />
        </button>
      )}
      {open && <FbMenuBox name={name} k={k} b={b} list={list} pages={pages} groups={groups} clear={clear} />}
    </div>
  );
}

// A menu: its rows, each with how many it would show; a long list gets a box to find one in, and Enter there shows
// just the first it finds. A status closes its menu once picked, and so does an agent's, a workspace's or a page's
// name: it shows just that one (or all again, if it was the only one). Its box, or ⌘-clicking it, adds it to the
// ones picked or takes it out, and keeps the menu open.
function FbMenuBox({ name, k, b, list, pages, groups, clear }: { name: ScopeName; k: "status" | "agent" | "workspace" | "page"; b: BarState; list: Listed[]; pages: PageRow[]; groups: GroupRow[]; clear: () => void }) {
  const m = FB[k];
  const find = useBar((s) => s.find);
  const { scope, lens, F, status } = b;
  const close = () => setBar({ open: null });
  const words = find.trim().toLowerCase();
  const fits = (text: string) => !words || text.toLowerCase().includes(words);
  const what = k === "page" ? "a page or a group" : `${k === "agent" ? "an" : "a"} ${m.label.toLowerCase()}`;
  const many = k === "status" ? false : k === "page" ? pages.length + groups.length > 7 : list.length > 7;
  // The first row, for Enter in the find box.
  let first: (() => void) | null = null;
  let rows: ReactNode;
  if (k === "status") {
    rows = lens.states().map(([f, label]) => {
      const on = status === f;
      const n = stateN(lens, F, scope, f);
      return (
        <button
          key={f}
          className={`fb-row fb-row--one${on ? " is-on" : ""}${n ? "" : " is-zero"}`}
          type="button"
          role="menuitemradio"
          aria-checked={on}
          onClick={() => {
            b.setStatus(status === f ? b.first : f);
            close();
          }}
        >
          <Mark f={f} />
          <span className="fb-nm">{label}</span>
          <span className="fb-n">{n}</span>
          <span className="fb-on">{on && <Icon name="check" />}</span>
        </button>
      );
    });
  } else if (k === "page") {
    // Where you are: your feed, a page or a group, one at a time; the picked one again goes back to your feed.
    const none = !scope.page.length && !scope.group.length;
    const pickCtx = (kind: "feed" | "page" | "group", id: string) => {
      const again = kind !== "feed" && scope[kind]?.length === 1 && scope[kind][0] === id;
      b.narrow({ ...scope, page: kind === "page" && !again ? [id] : [], group: kind === "group" && !again ? [id] : [] });
      close();
    };
    const row = (kind: "feed" | "page" | "group", id: string, face: ReactNode, text: string, on: boolean, n: number) => {
      const act = () => pickCtx(kind, id);
      first ??= act;
      return (
        <button key={`${kind}:${id}`} className={`fb-row fb-row--one${on ? " is-on" : ""}${n ? "" : " is-zero"}`} type="button" role="menuitemradio" aria-checked={on} onClick={act}>
          {face}
          <span className="fb-nm">{text}</span>
          <span className="fb-n">{n}</span>
          <span className="fb-on">{on && <Icon name="check" />}</span>
        </button>
      );
    };
    const ps = pages.filter((p) => (!p.archived || scope.page.includes(p.id)) && fits(p.title));
    const gs = groups.filter((g) => (!g.archived || scope.group.includes(g.id)) && fits(g.name));
    const out: ReactNode[] = [];
    if (fits("your feed"))
      out.push(
        row(
          "feed",
          "feed",
          <span className="fb-mark">
            <Icon name="home" />
          </span>,
          "Your feed",
          none,
          ctxN(name, lens, F, scope, status, "feed"),
        ),
      );
    if (ps.length)
      out.push(
        <div key="d:pages" className="pk-div" role="separator">
          Pages
        </div>,
        ...ps.map((p) => row("page", p.id, <PgIco p={p} />, p.title, scope.page.includes(p.id), ctxN(name, lens, F, scope, status, "page", p.id))),
      );
    if (gs.length)
      out.push(
        <div key="d:groups" className="pk-div" role="separator">
          Groups
        </div>,
        ...gs.map((g) => row("group", g.id, <GrIco g={g} />, g.name, scope.group.includes(g.id), ctxN(name, lens, F, scope, status, "group", g.id))),
      );
    rows = out.length ? out : <p className="fb-none">Nothing called “{find.trim()}”.</p>;
  } else {
    const key = k as ScopeKey;
    const ids = scope[key];
    const shown = list.filter((x) => !words || x.name.toLowerCase().includes(words));
    const pick = (id: string, more: boolean) => {
      if (more) b.narrow({ ...scope, [key]: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
      else {
        b.narrow({ ...scope, [key]: ids.length === 1 && ids[0] === id ? [] : [id] });
        close();
      }
    };
    if (shown[0]) first = () => pick(shown[0].id, false);
    rows = shown.length ? (
      shown.map((x) => {
        const on = ids.includes(x.id);
        const n = scopeN(lens, F, scope, status, key, x.id);
        return (
          <button key={x.id} className={`fb-row${on ? " is-on" : ""}${n ? "" : " is-zero"}`} type="button" role="menuitemcheckbox" aria-checked={on} onClick={(e) => pick(x.id, !!(e.target as Element).closest(".fb-tick") || e.metaKey || e.ctrlKey)}>
            <span className="fb-tick" title={on ? "Take it out" : "Pick more than one"}>
              {on && <Icon name="check" />}
            </span>
            {x.face}
            <span className="fb-nm">{x.name}</span>
            <span className="fb-n">{n}</span>
          </button>
        );
      })
    ) : (
      <p className="fb-none">{words ? `No ${m.label.toLowerCase()} called “${find.trim()}”.` : `No ${m.label.toLowerCase()}s yet.`}</p>
    );
  }
  const foot = k !== "status" && (scope[k].length || (k === "page" && scope.group.length));
  return (
    <div className={`fb-menu${k === "page" ? " fb-menu--ctx" : ""}`} role="menu" aria-label={k === "page" ? "Your feed, a page or a group" : m.label}>
      {many && (
        <form
          className="fb-find"
          onSubmit={(e) => {
            e.preventDefault();
            first?.();
          }}
        >
          <Icon name="search" />
          <input value={find} onChange={(e) => setBar({ find: e.target.value })} placeholder={`Find ${what}`} aria-label={`Find ${what}`} autoComplete="off" spellCheck={false} autoFocus />
        </form>
      )}
      <div className="fb-list">{rows}</div>
      {foot ? (
        <div className="fb-foot">
          <button type="button" onClick={clear}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

// How the feed shows, at the bar's end: one button, the icon of the view it shows, with no label, and a menu of the
// views: a row of buttons was distracting.
const FEED_VIEWS: [string, IconName, string][] = [
  ["cards", "cards", "Cards"],
  ["compact", "steps", "Compact"],
  ["pictures", "image", "Pictures"],
];
export const feedViewOf = (v: string) => (v === "compact" || v === "pictures" ? v : "cards");
function FeedViewMenu({ F }: { F: FeedList | null }) {
  const [kept, setView] = usePref("feedView", "cards");
  const on = feedViewOf(kept);
  const open = useBar((s) => s.open === "view");
  const close = useCallback(() => setBar({ open: null }), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const [, ico, label] = FEED_VIEWS.find(([k]) => k === on) || FEED_VIEWS[0];
  const pick = (k: string) => {
    setView(k);
    close();
    // Compact and Pictures show more at a time: the rest of their first hundred come.
    if (k !== "cards" && F?.ask && F.next && F.list.length < 100) loadFeed(F.ask, { more: true, n: 100 - F.list.length });
  };
  return (
    <div className="fb-f fb-show" ref={ref}>
      <button className="fb-opt" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Show as ${label}`} title={`${label}: show the feed as cards, compact rows or pictures`} onClick={() => setBar({ open: open ? null : "view", find: "" })}>
        <Icon name={ico} />
      </button>
      {open && (
        <div className="fb-menu" role="menu" aria-label="Show as">
          <div className="fb-list">
            {FEED_VIEWS.map(([k, i, l]) => (
              <button key={k} className={`fb-row fb-row--one${on === k ? " is-on" : ""}`} type="button" role="menuitemradio" aria-checked={on === k} onClick={() => pick(k)}>
                <span className="fb-mark">
                  <Icon name={i} />
                </span>
                <span className="fb-nm">{l}</span>
                <span className="fb-on">{on === k && <Icon name="check" />}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// How much Tasks and Worktrees show, at the bar's end.
function fbCount(name: ScopeName, lens: Lens, scope: Scope, f: string): string {
  if (!lens.items) return "";
  const xs = lens.items().filter((x) => lens.is(x, f) && inScope(lens.of, x, scope));
  if (name === "tasks" && f === "all") return `${(xs as TaskRow[]).filter(ticked).length} open, ${(xs as TaskRow[]).filter((t) => !ticked(t)).length} done`;
  if (name === "tasks") return plural(xs.length, "task");
  const prs = (xs as Wip[]).filter((x) => x.kind === "pr").length;
  const branches = xs.length - prs;
  return [prs ? plural(prs, "pull request") : "", branches ? plural(branches, "branch") : ""].filter(Boolean).join(", ") || "None";
}

// The bar, as the head of the list it narrows: the list's title and how many it shows on the left, its menus on the
// right, in the composer's order (who, which folder, then status), then how it shows. On the Feed the page menu is the
// title ("Feed", or the page's or group's name); on Tasks and Worktrees it's a menu like the others. On an agent's, a
// workspace's or a group's page: its menus (HERE). `acts`: Tasks' Connectors and List / Board, Worktrees' List /
// Timeline, a group's Add a thread. `bare`: on the page's background, above a list of cards, rather than inside the one
// card that is the list. `sticky`: stays under the top bar as the list scrolls. `after`: what hangs under it (the
// Feed's "N new"). `feed`: the list it narrows, where it isn't the page's (q/feed's, in the store).
export function ScopeBar({ name, acts, feed, title = "Threads", h1, bare, sticky, after }: { name: ScopeName; acts?: ReactNode; feed?: FeedList | null; title?: string; h1?: boolean; bare?: boolean; sticky?: boolean; after?: ReactNode }) {
  const b = useBarState(name, feed);
  const data = useApp((s) => s.data);
  const q = useChrome((c) => c.q);
  const { scope, route } = b;
  // The scope as text: the effects below run again when it says something else, not each time it is a new object.
  const scopeKey = JSON.stringify(scope);
  // The Feed, Tasks and Worktrees are narrowed to what their address says: the composer follows it, and a workspace or
  // a page that's gone, or an agent gone or hidden, stops narrowing, and the address stops saying so.
  useEffect(() => {
    if (!SCOPED[name]) return;
    const pruned = pruneScope(scope);
    if (pruned !== scope) narrowTo(name as "feed" | "tasks" | "worktrees", pruned, b.statusSet ? b.status : null);
    else scopePicks(scope);
  }, [name, scopeKey, data]);
  // The feed's address says its status, the one this browser kept when the address didn't say one.
  useEffect(() => {
    if (name === "feed" && (route.status || "all") !== b.status) narrowTo("feed", scope, b.statusSet ? b.status : null);
  }, [name, route.status, b.status, scopeKey]);
  // Its menus close when you leave.
  useEffect(() => () => setBar({ open: null, find: "" }), []);
  const agents = data?.agents || [];
  const pages = data?.pages || [];
  const groups = data?.groups || [];
  const H = isHere(name);
  const set = (b.statusSet ? 1 : 0) + SCOPE_KEYS.filter((k) => scope[k].length).length;
  const feedHead = name === "feed";
  const keys = ((H ? HERE[name] : ["page", "agent", "workspace", "status"]) as ("status" | "agent" | "workspace" | "page")[]).filter((k) => !(feedHead && k === "page"));
  // A page's threads say just the number, beside "Threads"; Tasks and Worktrees say what kind.
  const count = feedHead ? "" : H ? (b.F && b.F.ask === hereAsk(name, route.id, b.here, b.status, q) ? String(b.F.counts.threads) : "") : fbCount(name, b.lens, scope, b.status);
  const H1 = h1 ? "h1" : "h2";
  return (
    <div className={`list-head${bare ? " list-head--bare" : ""}${sticky ? " is-sticky" : ""}`} role="group" aria-label="Filters">
      <div className="lh-title">
        {feedHead ? <FbButton name={name} k="page" b={b} agents={agents} pages={pages} groups={groups} title /> : <H1 className="lh-h">{title}</H1>}
        {count ? <span className={`lh-count${H ? " lh-count--n" : ""}`}>{count}</span> : null}
      </div>
      {keys.map((k) => (
        <FbButton key={k} name={name} k={k} b={b} agents={agents} pages={pages} groups={groups} />
      ))}
      {set > 1 && (
        <button className="fb-clear" type="button" onClick={b.clearAll}>
          Clear all
        </button>
      )}
      {feedHead ? <FeedViewMenu F={b.F} /> : acts}
      {after}
    </div>
  );
}

// Nothing under what such a page's bar picks, or its search: say which, with the way back. `none`: what it says
// with no threads at all.
export function HereNone({ name, feed, count, none }: { name: ScopeName; feed: FeedList | null; count: number; none?: ReactNode }) {
  const b = useBarState(name, feed);
  const q = useChrome((c) => c.q);
  if (!feed || count) return null;
  const st = b.lens.states().find(([k]) => k === b.status);
  const narrowed = isHere(name) && HERE[name].some((k) => k !== "status" && b.here[k as ScopeKey].length);
  if (q && !listed(feed)) return <NoMatch />;
  if (b.statusSet || narrowed)
    return (
      <section className="card empty-card">
        <p>
          No {b.statusSet && st ? `${st[1].toLowerCase()} ` : ""}threads{q || narrowed ? " match" : " right now"}. <ClearAll name={name} feed={feed} />
        </p>
      </section>
    );
  if (listed(feed)) return null;
  return <>{none}</>;
}

// Whether the bar narrows the list at all (a scope, or a status other than its first).
export function useBarSet(name: ScopeName, feed?: FeedList | null): { scope: Scope; status: string; statusSet: boolean; narrowed: boolean } {
  const b = useBarState(name, feed);
  return { scope: b.scope, status: b.status, statusSet: b.statusSet, narrowed: SCOPE_KEYS.some((k) => b.scope[k].length) };
}
