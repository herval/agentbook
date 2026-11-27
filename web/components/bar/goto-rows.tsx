// ⌘K's places: everything there is to go to, as goto.ts ranks it and as a row of Go to shows it, and where you went
// last (this browser keeps that). Goto.tsx is the box they show in.
import type { CSSProperties, ReactNode } from "react";
import { agentName, hiddenAgent, postOwner, repoName, tildeOn, workspaceIds, workspaces } from "../../lib/agents.ts";
import { firstLine, groupStyle, hueVars, pageStyle } from "../../lib/format.ts";
import { RANK, rankPlaces } from "../../lib/goto.ts";
import type { Place, Ranked } from "../../lib/goto.ts";
import { agentHref, connectorsHref, groupHref, machineHref, noteHref, pageHref, parseRoute, personHref, routineHref, scopeHref, taskHref, threadHref, workspaceHref } from "../../lib/route.ts";
import type { Term } from "../../lib/search.ts";
import { allRows, getApp, threadRow } from "../../lib/store.ts";
import type { AppState } from "../../lib/store.ts";
import type { GroupRow, NoteRow, Route, TaskRow, Thread } from "../../lib/types.ts";
import { KINDS, isMe } from "../agents/words.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { groupMine, groupThreads } from "../groups/groups.ts";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";
import { wipById, wipGroups, wipHref, wipStatus } from "../worktrees/wips.ts";

// A place as goto.ts ranks it ({ key, name, more, rank, at }) and as a row shows it: `face`, `sub` (the line under its
// name, part of `more`), `kind` (its chip), `note` (how it's going) and `style` (its colour).
export interface GoPlace extends Place {
  key: string;
  href: string;
  face: ReactNode;
  sub: string;
  note: ReactNode;
  style?: CSSProperties;
}

/* where you went last */

// Where you've been, newest first, by the key of what was there (routeKey).
export function loadGone(): string[] {
  try {
    return JSON.parse(localStorage.getItem("agentbook.goto")) || [];
  } catch {
    return [];
  }
}
// What's at an address, by the key its place has on ⌘K's list (null: nothing it lists).
export function routeKey(r: Route): string | null {
  const of: Record<string, string> = { session: "thread", page: "page", note: "note", group: "group", person: "person", agent: "agent", skill: "agent", routine: "agent", workspace: "workspace", myroutine: "routine", machine: "machine" };
  if (r.name === "worktree") return `wip:${wipById(r.id)?.id || r.id}`;
  if (of[r.name]) return `${of[r.name]}:${r.id}`;
  return GO_SCREENS.some(([k]) => k === r.name) ? `screen:${r.name}` : null;
}
// Where you are now goes first on the list of where you went (on every change of address, and as ⌘K opens).
export function rememberPlace() {
  const { me, data } = getApp();
  const key = me && data && routeKey(parseRoute());
  if (!key) return;
  try {
    localStorage.setItem("agentbook.goto", JSON.stringify([key, ...loadGone().filter((k) => k !== key)].slice(0, 40)));
  } catch {}
}

/* agentbook's own screens */

const myTab = (tab: string) => personHref(getApp().me?.username || "", tab);
// agentbook's own screens: [route, name, icon, href, what else it's called, the line under its name], in the order ⌘K
// lists its places (goto.ts KIND): threads and routines, pages and groups, tasks, worktrees. Your profile's tabs are
// among them, each saying it's on your profile; Routines is its tab there, where it moved from #/routines.
// Each: its key, its name, its icon, its address, more words it's found by, and the line under its name.
export const GO_SCREENS: [string, string, IconName, () => string, string, string?][] = [
  ["feed", "Feed", "home", () => scopeHref("feed"), "home threads"],
  ["routines", "Routines", "repeat", () => myTab("routines"), "schedules cron loops", "Your profile"],
  ["pages", "Pages", "page", () => "#/pages", "dashboards"],
  ["groups", "Groups", "group", () => "#/groups", ""],
  ["notes", "Notes", "note", () => "#/notes", "documents docs"],
  ["agents", "People", "agents", () => "#/people", "everyone agents"],
  ["tasks", "Tasks", "tasks", () => scopeHref("tasks"), "to-dos todo"],
  ["worktrees", "Worktrees", "worktree", () => scopeHref("worktrees"), "branches pull requests prs timeline"],
  ["workspaces", "Workspaces", "folder", () => myTab("workspaces"), "repos folders projects", "Your profile"],
  ["mythreads", "Your threads", "steps", () => myTab(""), "mine", "Your profile"],
  // (Agents, as the sidebar and the tab call it: "agents" typed finds it first.)
  ["myagents", "Agents", "bot", () => myTab("agents"), "mine bots", "Your profile"],
  ["mypages", "Your pages", "page", () => myTab("pages"), "mine dashboards", "Your profile"],
  ["machines", "Machines", "laptop", () => myTab("machines"), "computers devices disconnect", "Your profile"],
  ["connectors", "Connectors", "plug", () => connectorsHref(), "github linear datadog boat integrations", "Your settings"],
  ["settings", "Your settings", "gear", () => myTab("settings"), "account signing in passkeys", "Your profile"],
  ["connect", "Add agents", "plus", () => myTab("agents") + "?open=add", "machine agents install provider openclaw gateway"],
  ["cloud-agents", "Cloud agents", "cloud", () => myTab("agents") + "?open=cloud", "connect api keys key token devin claude agent"],
  ["addws", "Add a workspace", "plus", () => "#/workspaces/new", "repo folder"],
];
// An icon in a round well, a row's face when it has no avatar or emoji of its own.
export const GoIco = ({ name }: { name: IconName }) => (
  <span className="goto-ico">
    <Icon name={name} />
  </span>
);

/* what each row says of how it's going (the old page's helpers, as far as ⌘K reads them) */

const capFirst = (t: unknown) => String(t || "").replace(/^./, (c) => c.toUpperCase());
// A note's threads that wait for you (a question of theirs asked since the note was made), and the ones working.
const noteAsks = (n: NoteRow, s: AppState) => (n.threads || []).filter((id) => (s.data?.questions || []).some((q) => q.post === id && !q.answered && !(q.asked && q.asked < n.created)));
const noteWorking = (n: NoteRow, s: AppState) => (n.threads || []).map((id) => threadRow(id, s)).filter((t) => t && (t.effective === "working" || t.busy));
const groupLive = (g: GroupRow, rows: Thread[]) => groupThreads(g, rows).filter((t) => t.effective === "working").length;
const groupNeeds = (g: GroupRow, rows: Thread[]) => groupThreads(g, rows).filter((t) => t.effective === "needs").length;
// Where a task stands, as far as its row here says (the old taskStatus's): done, a thread on it needs you, one is
// working on it (live), or none of those.
function taskGoing(t: TaskRow, s: AppState): "done" | "needs" | "live" | "" {
  if (t.done) return "done";
  const threads = [...new Set((t.posts || []).map((e) => e.post))].map((id) => threadRow(id, s)).filter(Boolean);
  return threads.some((x) => x.effective === "needs") ? "needs" : threads.some((x) => x.effective === "working") ? "live" : "";
}
const ARCHIVED = <span className="muted">archived</span>;
const NEEDS = <span className="chip chip--sun">needs you</span>;
const PULSE = <i className="pulse" />;

// Everything there is to go to: agentbook's screens, every thread the page has (and the archived ones the server
// found for what's typed, `old`), pages, notes, groups, people, agents, workspaces, worktrees, tasks, routines and
// machines.
export function goPlaces(old: Thread[] = [], s: AppState = getApp()): GoPlace[] {
  const data = s.data;
  if (!data) return [];
  const out: GoPlace[] = [];
  const add = (p: Partial<GoPlace> & Pick<GoPlace, "key" | "name" | "href" | "face">) => out.push({ rank: RANK.open, at: "", sub: "", note: "", ...p, more: [p.sub, p.more].filter(Boolean).join(" ") });
  for (const [k, name, ic, href, also, sub] of GO_SCREENS) add({ key: `screen:${k}`, name, href: href(), face: <GoIco name={ic} />, sub, more: also });
  const rows = allRows(s);
  const threads = new Map([...old, ...rows].map((t) => [t.id, t]));
  for (const t of threads.values()) {
    const ws = workspaceIds(t)
      .map((id) => workspaces().find((w) => w.id === id)?.name)
      .filter(Boolean);
    const note = t.archived ? ARCHIVED : t.effective === "needs" ? NEEDS : t.effective === "working" ? PULSE : "";
    add({ key: `thread:${t.id}`, kind: "Thread", name: t.title || t.label || "A thread", href: threadHref(t.id), face: <Avatar agent={t.agent} size="av--sm" />, sub: [t.title ? t.label : "", agentName(t.agent), ...(ws.length ? ws : [t.repo]), t.mine === false ? `@${postOwner(t)}` : ""].filter(Boolean).join(" · "), more: [t.branch, t.repo].filter(Boolean).join(" "), note, style: hueVars(t.agent), rank: t.archived || t.hidden ? RANK.away : t.effective === "needs" || t.effective === "working" ? RANK.going : RANK.open, at: t.updated || t.started });
  }
  for (const p of data.pages || []) add({ key: `page:${p.id}`, kind: "Page", name: p.title, href: pageHref(p), face: <span className="pg-ico" style={pageStyle(p)}>{p.emoji || "📄"}</span>, sub: [p.mine === false && p.owner ? `@${p.owner}` : "", firstLine(p.about)].filter(Boolean).join(" · "), note: p.archived ? ARCHIVED : "", rank: p.archived ? RANK.away : RANK.open, at: p.updated });
  for (const n of data.notes || []) {
    const asks = noteAsks(n, s).length;
    const working = noteWorking(n, s).length;
    const note = n.archived ? ARCHIVED : asks ? NEEDS : working ? PULSE : "";
    add({ key: `note:${n.id}`, kind: "Note", name: n.title || "Untitled", href: noteHref(n.id), face: <span className="goto-ico">{n.emoji || "📄"}</span>, sub: [(data.notes || []).find((x) => x.id === n.parent)?.title, n.start].filter(Boolean).join(" · "), note, rank: n.archived ? RANK.away : asks || working ? RANK.going : RANK.open, at: n.updated });
  }
  for (const g of data.groups || []) {
    const needs = groupNeeds(g, rows);
    const live = groupLive(g, rows);
    add({ key: `group:${g.id}`, kind: "Group", name: g.name, href: groupHref(g), face: <span className="gr-ico" style={groupStyle(g)}>{g.emoji || "👥"}</span>, sub: [groupMine(g) ? "" : `@${g.owner}`, firstLine(g.brief)].filter(Boolean).join(" · "), note: g.archived ? ARCHIVED : needs ? NEEDS : live ? PULSE : "", rank: g.archived ? RANK.away : needs || live ? RANK.going : RANK.open, at: g.updated });
  }
  for (const u of s.people || (s.me ? [s.me] : [])) if (!u.deleted) add({ key: `person:${u.username}`, kind: isMe(u.username, s) ? "You" : "Person", name: u.display_name || u.username, href: personHref(u.username), face: <PersonAvatar who={u} size="av--sm" />, sub: `@${u.username}`, rank: u.disabled ? RANK.away : RANK.open });
  for (const a of data.agents || []) add({ key: `agent:${a.id}`, kind: "Agent", name: agentName(a.id), href: agentHref(a.id), face: <Avatar agent={a.id} size="av--sm" />, sub: [KINDS[a.kind] || "", a.mine === false && a.owner ? `@${a.owner}` : ""].filter(Boolean).join(" · "), note: a.offline ? <span className="muted">offline</span> : a.working ? PULSE : "", style: hueVars(a.id), rank: hiddenAgent(a) || a.offline ? RANK.away : a.working ? RANK.going : RANK.open, at: a.used });
  for (const w of workspaces()) add({ key: `workspace:${w.id}`, kind: "Workspace", name: w.name, href: workspaceHref(w.id), face: <GoIco name={w.repo ? "repo" : "folder"} />, sub: w.repo ? repoName(w.repo) : w.checkouts[0] ? tildeOn(w.checkouts[0].machine, w.checkouts[0].root) : "", note: w.live ? PULSE : "", rank: w.live ? RANK.going : RANK.open, at: w.used });
  for (const x of wipGroups().flatMap((g) => g.list)) {
    const st = wipStatus(x);
    add({ key: `wip:${x.id}`, kind: "Worktree", name: x.title, href: wipHref(x), face: <GoIco name={x.kind === "branch" ? "branch" : "pr"} />, sub: [x.kind === "pr" ? `#${x.number}` : "", x.branch, x.repo].filter(Boolean).join(" · "), note: <span className="muted">{st.word}</span>, rank: x.state === "needs" || x.state === "live" ? RANK.going : ["landed", "merged", "closed"].includes(st.k) ? RANK.landed : RANK.open, at: x.at });
  }
  for (const t of data.tasks || []) {
    const k = taskGoing(t, s);
    add({ key: `task:${t.id}`, kind: "Task", name: t.text, href: taskHref(t), face: <GoIco name="tasks" />, sub: [t.source?.key, firstLine(t.note || "")].filter(Boolean).join(" · "), note: k === "needs" ? NEEDS : k === "live" ? PULSE : t.done ? <span className="muted">done</span> : "", rank: t.done ? RANK.landed : k === "needs" || k === "live" ? RANK.going : RANK.open, at: t.done_at || t.at });
  }
  // Your routines (not the archived ones).
  for (const r of (data.routines || []).filter((x) => !x.archived)) add({ key: `routine:${r.id}`, kind: "Routine", name: r.name, href: routineHref(r.id), face: <GoIco name="repeat" />, sub: capFirst(r.when), note: r.waiting ? <span className="chip chip--sun">needs your OK</span> : r.live_v && !r.on ? <span className="muted">paused</span> : "", rank: r.live_v && !r.on ? RANK.away : r.waiting ? RANK.going : RANK.open, at: r.last?.at });
  for (const m of (data.machines || []).filter((x) => x.mine)) add({ key: `machine:${m.name}`, kind: "Machine", name: m.name, href: machineHref(m.name), face: <GoIco name="laptop" />, note: m.online ? "" : <span className="muted">off</span>, rank: m.online ? RANK.open : RANK.away });
  return out;
}

// What the list shows: what matches what's typed, best first; with nothing typed, where you went last, then the
// screens. (The last row, the one that searches messages, is Goto's.)
export function goRows(all: GoPlace[], q: string, route: Route): { list: (GoPlace | Ranked<GoPlace>)[]; terms: Term[] } {
  if (!q) {
    const here = routeKey(route);
    const by = new Map(all.map((p) => [p.key, p]));
    const gone = loadGone()
      .filter((k) => k !== here && by.has(k) && !k.startsWith("screen:"))
      .slice(0, 8)
      .map((k) => by.get(k));
    // (The screen you're on isn't one: on your profile's tabs, that's by its address.)
    return { list: [...gone, ...all.filter((p) => p.key.startsWith("screen:") && p.key !== here && p.href !== location.hash)], terms: [] };
  }
  const { list, terms } = rankPlaces(all, q);
  return { list: list.slice(0, 50), terms };
}
