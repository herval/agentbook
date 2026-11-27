// The left column, and the menu below 1180px (the old page's leftNav): Feed; People, Groups, Pages, Dashboards and
// Notes; and Agents, which folds your agents, each folding its open threads.
import { AddAgentButton } from "./agents/AddAgentDialog.tsx";
import { Fragment } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { agentName, connecting, hiddenAgent, offlineWhy, presence, sortAgents } from "../lib/agents.ts";
import { hideAgent } from "./Visibility.tsx";
import { ago, hueVars, plural } from "../lib/format.ts";
import { usePref } from "../lib/hooks.ts";
import { agentHref, NO_SCOPE, personHref, scopeHref, threadHref, useRoute } from "../lib/route.ts";
import { threadRow, useApp } from "../lib/store.ts";
import type { AgentRow, PageData, Route, Scope, Thread } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./Icon.tsx";

// Which sections you've folded stays in this browser ("agentbook.sideFolded": `agents`, and `agent:<id>` for an
// agent's threads).
type Folded = Record<string, boolean>;
const useFolded = (): [Folded, (key: string) => void] => {
  const [folded, setFolded] = usePref<Folded>("sideFolded", {});
  return [folded, (key) => setFolded({ ...folded, [key]: !folded[key] })];
};
// The sidebar's agents as switches, to pick which to show. It stays as you go from page to page.
const useAgentsEdit = create<{ on: boolean }>(() => ({ on: false }));

// What the Feed, Tasks and Worktrees were last narrowed to (the old page's S.scope): Feed opens narrowed to it, as
// the filter bar left it.
let lastScope: Scope = NO_SCOPE;
const SCOPED = ["feed", "tasks", "worktrees"];

// One of the sidebar's rows: its name opens its page. One with a list under it (your agents) has a chevron at its
// end that folds the list away (`fold`, its key in the folded sections), and folded, `signal` says what in it wants
// you or is running. `sub` is that list, and `on` whether the row is lit: on its own page, or on one of its list's that
// the list doesn't show. One with no page (no `href`) folds its list from its name too.
interface NavSub {
  list: ReactNode;
  signal: ReactNode;
}
function NavRow({ k, href, ico, label, title = "", n = null, on = false, fold = "", sub = null, folded, onFold }: { k: string; href?: string; ico: IconName; label: string; title?: string; n?: ReactNode; on?: boolean; fold?: string; sub?: NavSub | null; folded: Folded; onFold: (key: string) => void }) {
  const open = !!fold && !folded[fold];
  const btn = fold ? (
    <button className="row-fold" type="button" aria-expanded={open} aria-label={`${open ? "Fold" : "Unfold"} ${label.toLowerCase()}`} title={`${open ? "Fold" : "Unfold"} ${label.toLowerCase()}`} onClick={() => onFold(fold)}>
      <Icon name="down" />
    </button>
  ) : null;
  const signal = fold && !open ? sub?.signal || null : null;
  const inner = (
    <>
      <span className="ico">
        <Icon name={ico} />
      </span>
      {label}
      {n}
      {signal}
    </>
  );
  const head = href ? (
    <a className={on ? "is-on" : undefined} href={href} title={title || undefined}>
      {inner}
    </a>
  ) : (
    <button className={`nav-head${on ? " is-on" : ""}`} type="button" aria-expanded={open} title={title || undefined} onClick={() => onFold(fold)}>
      {inner}
    </button>
  );
  return (
    <>
      <li className={fold ? "has-fold" : undefined} data-nav={k}>
        {head}
        {btn}
      </li>
      {sub?.list ? <li className="nav-sub">{sub.list}</li> : null}
    </>
  );
}
function NavFoot({ children }: { children: ReactNode[] }) {
  const bits = children.filter(Boolean);
  return bits.length ? <li className="nav-foot">{bits}</li> : null;
}

// The agent a thread last worked with first; those without threads keep to their names, below.
export function agentsByUse(list: AgentRow[]): AgentRow[] {
  return sortAgents(list).sort((a, b) => (b.used || "").localeCompare(a.used || ""));
}
const isDash = (data: PageData | null, id: string | undefined) => (data?.pages || []).find((p) => p.id === id)?.kind === "dashboard";
// People, Groups, Pages, Dashboards and Notes, rows in the sidebar under Feed, each lit on its page and the pages it lists.
// People isn't lit where Agents is: your Agents tab, and an agent's profile, skill or routine.
const NAV_TABS: { key: string; href: string; ico: IconName; label: string; on: (r: Route, me: string, data: PageData | null) => boolean }[] = [
  { key: "people", href: "#/people", ico: "agents", label: "People", on: (r, me) => r.name === "agents" || (r.name === "person" && !(r.tab === "agents" && r.id === me)) },
  { key: "groups", href: "#/groups", ico: "group", label: "Groups", on: (r) => ["groups", "group"].includes(r.name) },
  { key: "pages", href: "#/pages", ico: "page", label: "Pages", on: (r, me, data) => r.name === "pages" || (r.name === "page" && !isDash(data, r.id)) },
  // Dashboards, a row of their own after Pages.
  { key: "dashboards", href: "#/dashboards", ico: "gauge", label: "Dashboards", on: (r, me, data) => r.name === "dashboards" || (r.name === "page" && isDash(data, r.id)) },
  { key: "notes", href: "#/notes", ico: "note", label: "Notes", on: (r) => ["notes", "note"].includes(r.name) },
];

// The sidebar: Feed, and Agents, which folds your agents, each folding its open threads (up to 5, with a link to the
// rest). Routines and Workspaces are tabs on your profile; Tasks and WIP, cards on top of the feed's right column;
// People, Groups, Pages and Notes, rows between Feed and Agents (NAV_TABS). Machines aren't on it: an agent's dot says
// its machine is off, and your profile's Machines tab lists them.
export function LeftNav() {
  const route = useRoute();
  const me = useApp((s) => s.me?.username || "");
  const data = useApp((s) => s.data);
  const [folded, fold] = useFolded();
  const [feedFilter] = usePref("feedFilter", "all");
  if (SCOPED.includes(route.name) && route.scope) lastScope = route.scope;
  const agents = useAgentsNav(folded, fold);
  const r = route.name;
  const tab = r === "person" && route.tab === "agents" && route.id === me;
  return (
    <ul className="nav nav--top">
      <NavRow k="feed" href={scopeHref("feed", lastScope, feedFilter !== "all" ? feedFilter : null)} ico="home" label="Feed" on={r === "feed"} folded={folded} onFold={fold} />
      {NAV_TABS.map((t) => (
        <NavRow key={t.key} k={t.key} href={t.href} ico={t.ico} label={t.label} on={t.on(route, me, data)} folded={folded} onFold={fold} />
      ))}
      <NavRow k="agents" href={personHref(me, "agents")} ico="bot" label="Agents" title="Your agents, each with its open threads" on={tab || (["agent", "skill", "routine"].includes(r) && !agents.holds)} fold="agents" sub={agents} folded={folded} onFold={fold} />
    </ul>
  );
}

// An agent's name on one line, where it runs after it in grey; its row says all of it ("Moneynuggs @ brick via
// hervalm5") on hover.
const AgentNavName = ({ a }: { a: AgentRow }) => (
  <span className="ag-name">
    <b>{a.name}</b>
    {a.host || a.machine ? <small>{a.host || a.machine}</small> : null}
  </span>
);

// Agents' list: yours, the one a thread last worked with first, each with its open threads under it (AgentThreads),
// folded open or away from its own chevron (`agent:<id>` in the folded sections). Agents you've hidden stay off it,
// unless you're picking which to show: then each is a switch. Folded, it keeps just the agent whose profile or thread
// you're on, and the row counts the agents you'd see a solid green dot on.
function useAgentsNav(folded: Folded, fold: (key: string) => void): NavSub & { holds: boolean } {
  const route = useRoute();
  const all = (useApp((s) => s.data?.agents) || []) as AgentRow[];
  const rows = useApp((s) => s.rows);
  const here = useApp((s) => (route.name === "session" ? threadRow(route.id, s) : null)) || null;
  const edit = useAgentsEdit((e) => e.on);
  const syncing = new Set(all.filter((a) => a.syncing).map((a) => a.id));
  const hidden = all.filter(hiddenAgent).length;
  const shutAll = !!folded.agents;
  const mine = all.some((a) => a.mine !== false);
  const editing = !shutAll && edit && mine;
  // Each opens its profile, as a workspace and a page open theirs; the filter bar is what narrows the Feed.
  const on = (a: AgentRow) => ["agent", "skill", "routine"].includes(route.name) && route.id === a.id;
  const has = (a: AgentRow) => on(a) || (!!here && here.agent === a.id);
  const link = (a: AgentRow) =>
    a.offline ? (
      <a className={[connecting(a) ? "" : "is-off", on(a) ? "is-on" : ""].join(" ").trim() || undefined} href={agentHref(a.id)} title={`${agentName(a.id)}. ${offlineWhy(a)}`}>
        <Avatar agent={a.id} size="av--sm" on="offline" />
        <AgentNavName a={a} />
        {connecting(a) ? <span className="n">connecting</span> : null}
      </a>
    ) : (
      <a className={on(a) ? "is-on" : undefined} href={agentHref(a.id)} title={`${agentName(a.id)}${a.link ? ", connected to OpenClaw" : ""}`}>
        <Avatar agent={a.id} size="av--sm" on={presence(a)} />
        <AgentNavName a={a} />
        {a.working ? (
          <span className="side-n" title={`${plural(a.working, "thread")} running`}>
            {a.working}
          </span>
        ) : syncing.has(a.id) ? (
          <span className="n">syncing</span>
        ) : null}
      </a>
    );
  const row = (a: AgentRow) => {
    if (editing && a.mine !== false)
      return (
        <li key={a.id}>
          <label className={`nav-pick${a.hidden ? " is-off" : ""}`} title={agentName(a.id)}>
            <Avatar agent={a.id} size="av--sm" />
            <AgentNavName a={a} />
            <input type="checkbox" role="switch" key={String(!!a.hidden)} defaultChecked={!a.hidden} aria-label={`Activate ${agentName(a.id)}`} title="Active agents can start new threads. Deactivated agents keep their existing threads." onChange={(e) => hideAgent(a.id, !e.target.checked, true)} />
            <span className="track" aria-hidden="true" />
          </label>
        </li>
      );
    const key = `agent:${a.id}`;
    const open = agentOpenThreads(a, rows);
    const shut = shutAll || !!folded[key];
    return (
      <Fragment key={a.id}>
        <li className={open.length ? "has-fold" : undefined}>
          {link(a)}
          {open.length ? (
            <button className="row-fold" type="button" aria-expanded={!shut} aria-label={`${shut ? "Show" : "Fold"} ${a.name}'s threads`} title={`${shut ? "Show" : "Fold"} its threads`} onClick={() => fold(key)}>
              <Icon name="down" />
            </button>
          ) : null}
        </li>
        <AgentThreads a={a} open={open} shut={shut} here={here} />
      </Fragment>
    );
  };
  const shown = agentsByUse(all).filter((a) => (editing || !hiddenAgent(a)) && (!shutAll || has(a)));
  const pick = mine ? (
    <button className="nav-more" type="button" aria-pressed={editing} key="pick" onClick={() => useAgentsEdit.setState({ on: !edit })}>
      {editing ? "Done" : hidden ? plural(hidden, "hidden agent") : "Choose which to show"}
    </button>
  ) : null;
  const foot = shutAll ? null : (
    <NavFoot>
      {[
        pick,
        <AddAgentButton className="nav-more" title="Claude Code, Codex, Hermes, OpenClaw, or another machine's" key="add">
          Add agents
        </AddAgentButton>,
      ]}
    </NavFoot>
  );
  const live = all.filter((a) => !hiddenAgent(a) && presence(a) === "active").length;
  return {
    list:
      shown.length || foot ? (
        <ul className={`nav nav--agents${editing ? " nav--pick" : ""}`} aria-label="Your agents">
          {shown.map(row)}
          {foot}
        </ul>
      ) : null,
    signal: live ? (
      <span className="side-n" title={`${plural(live, "agent")} with threads running`}>
        {live}
      </span>
    ) : null,
    holds: shown.some(has),
  };
}

// An agent's open threads, for its list in the sidebar: not ended, archived or hidden; the ones that need you first,
// then the ones working, then the latest to move.
const AGENT_FIRST: Record<string, number> = { needs: 0, working: 1 };
const agentOpenThreads = (a: AgentRow, rows: Record<string, Thread>) =>
  Object.values(rows)
    .filter((s) => s.agent === a.id && !s.archived && !s.hidden && s.effective !== "done")
    .sort((x, y) => (AGENT_FIRST[x.effective] ?? 2) - (AGENT_FIRST[y.effective] ?? 2) || String(y.updated || y.started).localeCompare(String(x.updated || x.started)));
// Under an agent in the sidebar, its open threads, 5 at most, each opening its thread, and Show all with how many,
// its profile, when there are more. The thread you're on shows too, and is lit; folded (`shut`), only that one.
// (Rows of their own, not ThreadRow's: a dot, the name and a word, small enough for the sidebar.)
const AGENT_THREADS = 5;
function AgentThreads({ a, open, shut, here }: { a: AgentRow; open: Thread[]; shut: boolean; here: Thread | null }) {
  const rows = shut ? [] : open.slice(0, AGENT_THREADS);
  if (here?.agent === a.id && !rows.some((s) => s.id === here.id)) rows.push(here);
  const dot = (s: Thread) => (s.effective === "needs" ? "needs" : s.effective === "working" ? "live" : s.effective === "done" || s.archived ? "stale" : "open");
  const note = (s: Thread) => (s.effective === "needs" ? "needs you" : s.effective === "working" ? "live" : ago(s.updated || s.started));
  const all = !shut && open.length > rows.length;
  if (!rows.length && !all) return null;
  return (
    <li className="ag-threads">
      <ul className="wip-nav" aria-label={`${a.name}'s threads`}>
        {rows.map((s) => (
          <li key={s.id}>
            <a className={here?.id === s.id ? "is-on" : undefined} href={threadHref(s.id)} title={s.title || s.label} style={hueVars(a.id)}>
              <span className="wip-dot">
                <i className={`dot dot--${dot(s)}`} />
              </span>
              <span className="t">{s.title || s.label}</span>
              <span className="m">{note(s)}</span>
            </a>
          </li>
        ))}
        {all ? (
          <li>
            <a className="ag-all" href={agentHref(a.id)} title={`All of ${a.name}'s threads, on its profile`}>
              Show all {open.length}
            </a>
          </li>
        ) : null}
      </ul>
    </li>
  );
}
