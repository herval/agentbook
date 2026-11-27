// Pages: widgets agents keep up to date. What the page's screens, its feed card and its tiles say of a page, as pure
// helpers (app.ts's "pages: widgets agents keep up to date", "a page's filters", "a page's routines").
//
// A page lives on the machine where it was made, like a post, and is its owner's. It's private (its owner and its
// contributors) or public. Only its contributors change it: the agents and people its owner added, by hand or
// from their posts (ab_page_write). Every change is a version, and an older one can be restored as a new one.
// The views: every page (#/pages), and a page (#/pages/:id) with its Versions, Contributors and Posts, or as it
// was at a version (#/pages/:id/at/:v). See plugin/shared/pages.ts.
import { agentName, kindCaps, workspaces } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { ago, plural } from "../../lib/format.ts";
import { pageHref } from "../../lib/route.ts";
import { agentOf, allRows, getApp, threadRow } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { By, Widget, WidgetData } from "../../../plugin/shared/types.ts";
import { levelOf } from "../../../plugin/shared/visibility.ts";
import type { PageData, PageRow, PageView, RoutineRow, Route, Thread } from "../../lib/types.ts";

// A page as the chrome has it (pages.ts's pageSummary): its record, its routines, the last answers a dashboard's
// panels had for its own view (`face`), and whether you archived its card on your feed.
export type PageRec = Omit<PageRow, "face"> & { routines?: RoutineRow[]; face?: Record<string, { data?: WidgetData; at?: string }>; feed_archived?: boolean; versions?: number };

// Whether an agent of this kind writes pages: its runtime gives its threads agentbook's page tools (shared/runtimes.ts).
export const writesPages = (kind: string | null | undefined) => !!kindCaps(kind)?.writesPages;
export const WIDTH_COLS: Record<string, number> = { quarter: 3, third: 4, half: 6, "two-thirds": 8, full: 12 };
export const WIDTH_NAMES = [["quarter", "¼"], ["third", "⅓"], ["half", "½"], ["two-thirds", "⅔"], ["full", "Full"]];
export const pageById = (id: string | null | undefined, data: PageData | null = getApp().data): PageRec | undefined => (data?.pages || []).find((p) => p.id === id) as unknown as PageRec | undefined;
// Ids inside a page's widgets are its machine's own: on the hub, "claude" there is "laptop~claude".
export const onPageMachine = (p: { id: string }, id: string | null | undefined): string | null | undefined => (id && p.id.includes("~") && !String(id).includes("~") ? `${p.id.split("~")[0]}~${id}` : id);
export const isDash = (p: { kind?: string } | null | undefined) => p?.kind === "dashboard";
export const barHref = (p: { id: string }, id = "") => pageHref(p, id ? `threads/${encodeURIComponent(id)}` : "");

// Who made a version or a widget: an agent in one of its posts, or a person by hand.
export function byName(p: PageRec, by: By | null | undefined): string {
  if (!by) return "Someone";
  if (by.routine) return routineName(p, by.routine);
  if (by.user) return by.user === getApp().me?.username && !by.as ? "You" : by.as ? `@${by.user}'s ${by.as}` : `@${by.user}`;
  if (!by.agent) return "A private agent";
  return agentName(onPageMachine(p, by.agent)) || by.agent;
}
export const pagePost = (p: PageRec, by: By | null | undefined): Thread | undefined => (by?.post ? threadRow(onPageMachine(p, by.post)) : undefined);

export const shelf = (s: Pick<Thread, "archived" | "hidden">) => (s.archived ? "archived" : s.hidden ? "hidden" : null);
// The feed's state pills, as a page's threads bar has them.
export const FILTERS: [string, string][] = [["working", "Running"], ["needs", "Needs you"], ["done", "Idle"], ["hidden", "Hidden"], ["archived", "Archived"]];
export const inFilter = (s: Thread, f: string) => (f === "archived" || f === "hidden" ? shelf(s) === f : !shelf(s) && (f === "all" || (f === "working" ? ["working", "waiting"] : f === "done" ? ["done", "idle"] : [f]).includes(s.effective)));
// What needs you first, then what's running, then the latest.
const BAR_RANK = { needs: 0, waiting: 1, working: 1, idle: 2, done: 3 };
export const barSort = (list: Thread[]) => [...list].sort((a, b) => (BAR_RANK[a.effective] ?? 2) - (BAR_RANK[b.effective] ?? 2) || (b.updated || b.started).localeCompare(a.updated || a.started));
export const barWhen = (s: Thread) => ago(s.state === "done" && s.ended ? s.ended : s.updated || s.started);

// A page's threads: the ones started from it (which may only have asked about it) and the ones that changed it.
// The page's detail lists them; a thread started from it in the last few minutes may only be in its launches yet.
export function pageThreadIds(p: PageRec, detail: PageView | null = null): Set<string> {
  const ids = new Set<string>(detail?.id === p.id ? (detail.posts || []).map((x) => onPageMachine(p, x.post)) : []);
  for (const l of getApp().data?.launches || []) if (l.page === p.id && l.post) ids.add(l.post);
  return ids;
}
// A page's live threads: its threads (started from it, or that made or changed it) that are working, but not the
// archived or hidden ones, as in its threads bar. A live thread may only be asking about the page, so it's named
// by its title, never said to be updating it.
export function pageLive(p: PageRec, detail: PageView | null = null): Thread[] {
  const ids = pageThreadIds(p, detail);
  const last = pagePost(p, p.last?.by);
  return barSort(allRows().filter((s) => s.effective === "working" && !shelf(s) && (s.page === p.id || ids.has(s.id) || s.id === last?.id)));
}
// Its live threads in a few words: the one's agent and title, or how many and whose.
export function pageLiveText(live: Thread[]): [string, string] {
  if (live.length === 1) return [live[0].label, live[0].title];
  return [`${live.length} live threads`, [...new Set(live.map((s) => s.label))].join(", ")];
}
// When a version was made: "Today, 15:21", "Oct 2, 16:04".
export const when = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `Today, ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};
export const todayCount = (p: PageRec) => (p.recent || []).filter((r) => new Date(r.at).toDateString() === new Date().toDateString()).length;
export const contributorCount = (p: PageRec) => (p.contributors || []).length + 1; // and its owner

/* ---------- a page's routines: code an agent wrote that keeps some of its widgets up to date ---------- */

export const keeperOf = (p: PageRec, id: string) => (p.routines || []).find((r) => r.live_v && r.keeps.includes(id)) || null;
export const routineName = (p: PageRec, rid: string) => (p.routines || []).find((r) => r.id === rid)?.name || "A routine";
export const routineEvery = (r: RoutineRow) => {
  if (r.when && r.every?.kind !== "every") return r.when;
  const ms = r.every?.everyMs || 0;
  return ms === 3600e3 ? "hourly" : ms === 864e5 ? "daily" : ms % 3600e3 === 0 ? `every ${ms / 3600e3} hours` : `every ${Math.round(ms / 60e3)} min`;
};
export const routineFailing = (r: RoutineRow) => !!r.live_v && r.fails >= 2;
export const runTime = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);
export function reachWords(reach: { tools?: string[]; commands?: string[] } | null | undefined): string {
  const by: Record<string, string[]> = {};
  for (const t of reach?.tools || []) {
    const [server, tool] = t.split("/");
    (by[server] ||= []).push(tool.replace(/^[a-z]+_[a-z]+-/, ""));
  }
  const parts = Object.entries(by).map(([s, ts]) => `${ts.join(", ")} on ${s}`);
  if (reach?.commands?.length) parts.push(`the command${reach.commands.length > 1 ? "s" : ""} ${reach.commands.join(", ")}`);
  return parts.join("; ") || "nothing outside it";
}
// The agents that write pages and routines, online: the ones whose threads have agentbook's tools.
export const pageWriters = () => (getApp().data?.agents || []).filter((a) => writesPages(a.kind) && !a.offline);

// What Tidy asks of the agent: the page made one page again (plugin/shared/page-shape.ts says why pages grow).
export function tidyPrompt(p: PageRec) {
  return `Tidy this page, "${p.title}": it has ${plural(p.widgets.length, "widget")}, and pages grow a section per thread that writes them. Read it with ab_page_read, and its routines with ab_routine_read.
Make it one page:
- One note on what matters, at the top, and one on sources, at the bottom. Fold every intro, "what stands out" and method note into the widgets they explain.
- Each number once: one total per period, and one table where two show the same figures (keep the one that reads best, and fold in what only the other has).
- Replace logs and diaries with what's still true; the page's versions keep the rest.
- Take off what's done, stale or superseded.
Keep every fact that still matters, the widgets a code routine keeps (same ids, their data as it is), html widgets' code, filters and tasks. About 12 widgets reads well.
Write it as one version with ab_page_write (remove, order, and a summary of what you merged where), so I can restore the old one. If an agent routine would put the old widgets back, change the playbook it follows, or tell me what its prompt needs: I OK prompt changes. Then tell me what you merged, what you took off and why, and anything you weren't sure of.`;
}
// A launch for the page: its agent is told the page, and starts where the page's posts work.
// What /api/launch answered (its `lid`), or null when it couldn't start it.
export async function launchForPage(p: { id: string }, agentId: string, prompt: string, done: string) {
  const owner = agentOf(agentId).machine;
  const r = await post("/api/launch", { prompt, agent: agentId, page: p.id, machine: owner || undefined });
  if (r.ok) toast(done);
  return r.ok ? r.data : null;
}

/* ---------- a page's filters ---------- */

// A page narrowed by its filters, in its address: yours alone, and a link or a reload keeps it. Picking one
// doesn't change the page, so it makes no version.
export function narrowHref(p: { id: string }, filters: Record<string, string | null | undefined>, r: Route) {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null && v !== "") as [string, string][]);
  return `${r.bar ? barHref(p, r.thread || "") : pageHref(p, r.tab === "at" && r.v ? `at/${r.v}` : "")}${q.size ? `?${q}` : ""}`;
}
export const narrowTo = (p: { id: string }, id: string, value: string | null, r: Route = getApp().route) => void (location.hash = narrowHref(p, { ...(r.filters || {}), [id]: value }, r));
export const filterOf = (p: PageRec, id: string) => (p.widgets || []).find((w) => w.id === id && w.type === "filter");
// A time filter's periods count back from when you look: "24h" from this hour, "7d" from the start of the day
// six days ago, so it's today and the six before.
const periodOf = (v: string) => String(v).match(/^(\d+)([hdw])$/);
// "Last 7 days" on a widget; "7 days" on the filter's own chips.
export function periodLabel(v: string, short = false) {
  const m = periodOf(v);
  if (!m) return String(v);
  const unit = { h: "hour", d: "day", w: "week" }[m[2]];
  if (m[1] === "1") return m[2] === "d" ? "Today" : short ? `1 ${unit}` : `Last ${unit}`;
  return `${short ? "" : "Last "}${m[1]} ${unit}s`;
}
export function periodStart(v: string, now = Date.now()) {
  const m = periodOf(v);
  if (!m) return -Infinity;
  if (m[2] === "h") return now - Number(m[1]) * 3600e3;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Number(m[1]) * (m[2] === "w" ? 7 : 1) - 1));
  return d.getTime();
}
// When a value is, if it's a date: "2026-10-03" (that day, here), or with a time; a cell can say it as { at }.
export function dateOf(x: unknown) {
  const o = x && typeof x === "object" ? (x as { at?: unknown; text?: unknown }) : null;
  const s = String(o ? (o.at ?? o.text ?? "") : (x ?? "")).trim();
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
}
// A chart's x that's a date reads as one: "Oct 3", or "Oct 3, 14:00".
export function dateLabel(v: unknown) {
  const t = dateOf(v);
  if (!Number.isFinite(t)) return String(v);
  const d = new Date(t);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return /T\d{2}:\d{2}/.test(String(v)) ? `${day}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}` : day;
}

/* ---------- every page ---------- */

export const PAGE_FILTERS = [["all", "All"], ["following", "Following"], ["mine", "Yours"], ["shared", "Shared with you"], ["public", "Public"], ["archived", "Archived"]];
export const inPageFilter = (p: PageRec, f: string) => (f === "archived") === !!p.archived && (f === "all" || f === "archived" || (f === "following" ? p.followed : f === "mine" ? p.mine : f === "shared" ? !p.mine : levelOf(p.visibility) === f));
// What on a page waits for you: an item on it asking for your OK (on one you can change), and a new version of one
// of its routines (on yours).
export function pageWaits(p: PageRec) {
  if (p.archived) return 0;
  const oks = p.can_edit ? (p.widgets || []).filter((w) => w.type === "list").reduce((n, w) => n + (w.data?.items || []).filter((it) => it.ask === "ok" && it.ok == null).length, 0) : 0;
  return oks + (p.mine ? (p.routines || []).filter((r) => r.waiting).length : 0);
}

/* ---------- names in text ---------- */

// "@<page>" or "@<page>/<widget>", and the workspaces, tasks, groups and notes named by their ids.
const MENTION = /(^|[\s(>*_~])@(?!(?:ws|task|group|note):)([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_.-]*[A-Za-z0-9_]))?(?![\w/-])/g;
const WS_MENTION = /(^|[\s(>*_~])@ws:([a-z0-9]+)(?![\w/-])/g;
const TASK_MENTION = /(^|[\s(>*_~])@task:([a-z0-9]+)(?![\w/-])/g;
const GROUP_MENTION = /(^|[\s(>*_~])@group:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;
const NOTE_MENTION = /(^|[\s(>*_~])@note:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;
// Text with what it names in words, for where a chip can't go (a title, a link): "why did p95 latency jump?".
export function plainMentions(text: string | null | undefined) {
  const d = getApp().data;
  return String(text || "")
    .replace(MENTION, (m, pre, pid, wid) => {
      const p = pageById(pid, d);
      if (!p) return m;
      if (!wid) return pre + p.title;
      const w = (p.widgets || []).find((x) => x.id === wid);
      return w ? pre + (w.title || w.id) : m;
    })
    .replace(WS_MENTION, (m, pre, id) => {
      const w = d ? workspaces().find((x) => x.id === id) : null;
      return w ? pre + w.name : m;
    })
    .replace(TASK_MENTION, (m, pre, id) => {
      const t = [...(d?.tasks || []), ...(d?.todos || [])].find((x) => x.id === id);
      return t ? pre + t.text : m;
    })
    .replace(GROUP_MENTION, (m, pre, id) => {
      const g = (d?.groups || []).find((x) => x.id === id);
      return g ? pre + g.name : m;
    })
    .replace(NOTE_MENTION, (m, pre, id) => {
      const n = (d?.notes || []).find((x) => x.id === id);
      return n ? pre + n.title : m;
    });
}

// A widget on a page, as the page's grid has it (one just added in an edit is `fresh`).
export type PageWidget = Widget & { fresh?: boolean };
