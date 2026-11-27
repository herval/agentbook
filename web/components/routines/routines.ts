// Routines: everything that runs on a schedule. One list: agentbook's routines
// (data.routines), each linked to the agents, pages and threads it's for, and what the agents run on their own
// schedules (claude.ai routines and loops, Codex automations, OpenClaw cron jobs), read from their drivers. Sorted,
// not grouped: what waits for your OK, what's failing, then by its next run. Archived ones (removed, which archives
// them) are only under Archived, to restore. What Routines, a routine's page, a page's Routines tab and the form
// share: the rows' shape, the form's schedule, and the store that holds what's open.
import { create } from "zustand";
import { fromNow, inactiveAgent, pad2, scheduleWords } from "../../lib/agents.ts";
import { getJSON, post } from "../../lib/api.ts";
import { firstLine, plural } from "../../lib/format.ts";
import { agentOf, getApp, threadRow } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { isRuntimeId, RUNTIMES } from "../../../plugin/shared/runtimes.ts";
import type { By, RoutineLink, RoutineSchedule } from "../../../plugin/shared/types.ts";
import type { AgentCron, CronJobs, RoutineForm, RoutineRow } from "../../lib/types.ts";

/* ---------- what's open ---------- */

export interface RoutineUi {
  // New routine, or the one being changed, as typed so far; and its error.
  form: RoutineForm | null;
  err: string;
  // Which ones Routines lists.
  filter: string;
  // What the agents run on their own, by agent (null: not read yet).
  ext: Record<string, AgentCron[]> | null;
  // A routine's folds (code, remove), its older runs shown, and the version picked, by routine.
  open: Record<string, boolean>;
  allRuns: Record<string, boolean>;
  version: Record<string, string>;
  // Counts what you did to one (ran it, paused it, OK'd a version), so what shows it reads it again.
  bump: number;
}
export const useRoutineUi = create<RoutineUi>(() => ({ form: null, err: "", filter: "all", ext: null, open: {}, allRuns: {}, version: {}, bump: 0 }));
export const setRoutineUi = (s: Partial<RoutineUi> | ((s: RoutineUi) => Partial<RoutineUi>)) => useRoutineUi.setState(s);
export const setForm = (f: Partial<RoutineForm>) => setRoutineUi((s) => (s.form ? { form: { ...s.form, ...f } } : {}));
export const bumpRoutines = () => setRoutineUi((s) => ({ bump: s.bump + 1 }));

/* ---------- words ---------- */

export const routineAgent = (r: Pick<RoutineRow, "kind" | "agent" | "thread" | "runs_as">) => (r.kind !== "agent" ? r.agent : r.thread ? threadRow(r.thread)?.agent || r.runs_as : r.runs_as);
export const shortPath = (p: string | null | undefined) => (p || "").replace(getApp().data?.home || /^$/, "~");
export const capFirst = (t: string | null | undefined) => String(t || "").replace(/^./, (c) => c.toUpperCase());
export const routineWhereUrl = (id: string, job = "") => `/api/agents/${encodeURIComponent(id)}/routines${job ? `/${encodeURIComponent(job)}` : ""}`;
// An agent's routine opens its page; a loop opens the post it runs in.
export const agentRoutineHref = (agentId: string, job: string) => `#/agents/${agentId}/routines/${encodeURIComponent(job)}`;
export const routineLink = (agentId: string, r: Pick<AgentCron, "group" | "post" | "url" | "id">) => (r.group === "loop" && r.post ? `#/threads/${encodeURIComponent(r.post)}` : r.group === "loop" && r.url ? r.url : agentRoutineHref(agentId, r.id));
// What a routine's Ask … to fix it sends: its thread's title. Its agent is told the rest with it (routine-threads.ts).
export const FIX_ASK = "It's failing: find out why, and fix it.";

// What one of an agent's own routines does, under its name: a loop's name is the start of its prompt, so the rest.
function extWhat(x: AgentCron) {
  const what = firstLine(x.what && x.what !== x.name ? x.what : "").replace(/^\/loop\s+/, "");
  const name = x.name.replace(/…$/, "");
  return what.startsWith(name) ? (name === x.name ? what.slice(name.length).replace(/^[.!?:…]?\s*/, "") : "") : what;
}

// A routine as Routines lists it, agentbook's or an agent's own.
export interface RoutineListRow {
  key: string;
  href: string;
  name: string;
  what: string;
  when: string;
  next: string | null;
  off: boolean;
  waiting: boolean;
  failing: boolean;
  running: boolean;
  manual: boolean;
  last: { at: string; ok: boolean; skipped?: boolean } | null;
  links: { kind: string; id: string }[];
  tag: string;
  archived?: { at: string; by: By | null } | null;
  r?: RoutineRow;
  ext?: boolean;
}
// One of agentbook's routines as a row, on Routines or on a page's Routines tab (where that page's own chip goes
// without saying).
export const rowOfRoutine = (r: RoutineRow, { page }: { page?: string } = {}): RoutineListRow => ({
  key: `rt:${r.id}`,
  href: `#/routines/${encodeURIComponent(r.id)}`,
  name: r.name,
  what: r.about || (r.kind === "agent" ? firstLine(r.prompt) : r.page ? `Keeps ${plural(r.keeps.length, "widget")} up to date` : ""),
  when: capFirst(r.when),
  next: r.live_v && r.on ? r.next : null,
  off: r.live_v ? !r.on : false,
  waiting: !!r.waiting,
  failing: !!(r.live_v && r.fails >= 2),
  running: !!r.running,
  manual: r.every?.kind === "manual",
  last: r.last ? { at: r.last.at, ok: r.last.ok && !r.last.skipped, skipped: !!r.last.skipped } : null,
  links: (r.links || []).filter((l) => !(page && l.kind === "page" && l.id === page)),
  tag: r.kind === "code" ? "Code, no model" : "",
  archived: r.archived || null,
  r,
});
// The order rows go in: what needs your OK, what's failing, what's running, then by when it runs next.
const rowRank = (x: RoutineListRow) => (x.waiting ? 0 : x.failing ? 1 : x.running ? 2 : x.off ? 5 : x.next ? 3 : 4);
export const byRowRank = (a: RoutineListRow, b: RoutineListRow) => rowRank(a) - rowRank(b) || (a.next || "").localeCompare(b.next || "") || a.name.localeCompare(b.name);
// Every row of the list, agentbook's and the agents' own, in one shape.
export function routineRows(routines: RoutineRow[], ext: Record<string, AgentCron[]> | null): RoutineListRow[] {
  const mine = routines.filter((r) => !r.archived).map((r) => rowOfRoutine(r));
  const theirs = Object.entries(ext || {}).flatMap(([agentId, list]) =>
    list
      .filter((x) => !x.builtin)
      .map((x): RoutineListRow => {
        // Where it lives: Claude Code's /loop, the Claude app (its Cowork tasks), or its runtime's own scheduler
        // (shared/runtimes.ts: "claude.ai", "Codex app").
        const kind = agentOf(agentId).kind;
        const tag = x.group === "loop" ? "/loop" : x.place?.cowork ? "Claude app" : (isRuntimeId(kind) && RUNTIMES[kind].scheduler) || "";
        return {
          key: `ext:${agentId}:${x.id}`,
          href: routineLink(agentId, x),
          name: x.name,
          what: x.description || extWhat(x),
          when: capFirst(scheduleWords(x.schedule)),
          next: x.enabled ? x.next : null,
          waiting: false,
          failing: x.status === "error",
          running: !!x.running,
          off: !x.enabled,
          manual: false,
          last: x.last ? { at: x.last, ok: x.status !== "error" } : null,
          links: [{ kind: "agent", id: agentId }, ...(x.group === "loop" && x.post ? [{ kind: "thread", id: x.post }] : [])],
          tag,
          ext: true,
        };
      }),
  );
  return [...mine, ...theirs].sort(byRowRank);
}
// Each: its key, its name, and what it lets through.
export const RT_FILTERS: [string, string, (x: RoutineListRow) => unknown][] = [
  ["all", "All", () => true],
  ["ok", "Needs your OK", (x) => x.waiting],
  ["failing", "Failing", (x) => x.failing],
  ["off", "Paused", (x) => x.off && !x.waiting],
  ["archived", "Archived", (x) => x.archived],
];
// What the agents run on their own: read from each agent's driver, as its profile does.
export async function loadAgentRoutines() {
  const agents = (getApp().data?.agents || []).filter((a) => a.routines?.n && a.mine !== false);
  const lists = await Promise.all(agents.map((a) => getJSON<CronJobs>(routineWhereUrl(a.id)).then((d) => [a.id, d?.routines || []] as const)));
  setRoutineUi({ ext: Object.fromEntries(lists) });
}

/* ---------- New routine, and changing one ---------- */

export const RT_HOWS = [["manual", "Manually"], ["hourly", "Hourly"], ["daily", "Daily"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["every", "Every…"]];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function formSchedule(s: RoutineSchedule | null | undefined): Pick<RoutineForm, "how" | "time" | "day" | "every" | "expr"> {
  const out = { how: "daily", time: "09:00", day: "1", every: "30" };
  if (!s) return out;
  if (s.kind === "manual") return { ...out, how: "manual" };
  if (s.kind === "every") return s.everyMs === 3600e3 ? { ...out, how: "hourly" } : { ...out, how: "every", every: String(Math.round(s.everyMs / 60e3)) };
  const [m, h, dom, mon, dow] = String(s.expr || "").split(" ");
  if (s.kind === "cron" && /^\d+$/.test(m) && dom === "*" && mon === "*") {
    const step = h.match(/^\*\/(\d+)$/)?.[1];
    if (step && dow === "*") return { ...out, how: "every", every: String(Number(step) * 60) };
    if (/^\d+$/.test(h)) {
      const time = `${pad2(h)}:${pad2(m)}`;
      if (dow === "*") return { ...out, how: "daily", time };
      if (dow === "1-5") return { ...out, how: "weekdays", time };
      if (/^[0-6]$/.test(dow)) return { ...out, how: "weekly", time, day: dow };
    }
  }
  return { ...out, how: "cron", expr: s.expr || "" };
}
export function scheduleOfForm(f: RoutineForm) {
  const [h, m] = (f.time || "09:00").split(":").map(Number);
  if (f.how === "manual") return "manual";
  if (f.how === "hourly") return "1h";
  if (f.how === "every") return Number(f.every) >= 120 && Number(f.every) % 60 === 0 ? `0 */${Number(f.every) / 60} * * *` : `${Math.max(5, Number(f.every) || 30)}m`;
  if (f.how === "daily") return `${m} ${h} * * *`;
  if (f.how === "weekdays") return `${m} ${h} * * 1-5`;
  if (f.how === "weekly") return `${m} ${h} * * ${f.day || 1}`;
  return f.expr || "manual";
}
// The schedule from the form, in words an agent reads: "every 30 minutes", "every weekday at 09:00".
export function formScheduleWords(f: RoutineForm) {
  const n = Number(f.every) || 30;
  return {
    manual: "when I run it",
    hourly: "every hour",
    every: n % 60 === 0 ? `every ${n === 60 ? "hour" : `${n / 60} hours`}` : `every ${n} minutes`,
    daily: `every day at ${f.time}`,
    weekdays: `every weekday at ${f.time}`,
    weekly: `every ${WEEKDAYS[Number(f.day) || 1]} at ${f.time}`,
    cron: `on the cron ${f.expr}`,
  }[f.how];
}
// Agents that can run a routine: yours that agentbook starts sessions for, of a runtime routines run on
// (shared/runtimes.ts, `routines`), in the order the runtimes are listed.
const ROUTINE_KINDS: string[] = Object.values(RUNTIMES)
  .filter((r) => r.caps.routines)
  .map((r) => r.id);
export const routineAgents = () =>
  (getApp().data?.agents || [])
    .filter((a) => a.mine !== false && !a.offline && !inactiveAgent(a) && ROUTINE_KINDS.includes(a.kind))
    .sort((a, b) => ROUTINE_KINDS.indexOf(a.kind) - ROUTINE_KINDS.indexOf(b.kind));
// The form as it stands: new (linked to the thread or page it was opened from) or one being changed.
export function openRoutineForm(r: (Partial<RoutineRow> & { id: string }) | null, pre: { thread?: string; page?: string; agent?: string } = {}) {
  const base = { ...formSchedule(r?.every) };
  if (r) {
    const runsAs = routineAgent(r as RoutineRow);
    return setRoutineUi({ err: "", form: { ...base, rid: r.id, name: r.name, prompt: r.prompt || "", agent: r.runs_as || "", root: r.root || "", links: (r.links || []).filter((l) => !(l.kind === "agent" && l.id === runsAs)), into: r.thread || "" } });
  }
  const links: RoutineLink[] = [...(pre.thread ? [{ kind: "thread" as const, id: pre.thread }] : []), ...(pre.page ? [{ kind: "page" as const, id: pre.page }] : [])];
  setRoutineUi({ err: "", form: { ...base, kind: "agent", name: "", prompt: "", agent: pre.agent || (pre.thread && threadRow(pre.thread)?.agent) || routineAgents()[0]?.id || "claude", writer: "", root: "", links, into: pre.thread || "" } });
}

/* ---------- what its buttons do ---------- */

const base = (id: string) => `/api/routines/${encodeURIComponent(id)}`;
export async function runRoutine(r: Pick<RoutineRow, "id" | "kind" | "page">) {
  const res = await post(`${base(r.id)}/run`);
  if (res.ok) toast(r.kind === "code" ? (r.page ? "Running it now. The page shows what it changes in a few seconds." : "Running it now.") : "Started. Its run shows on the routine, and in its thread.");
  bumpRoutines();
  return res.ok;
}
// Turn it on, or pause it.
export async function switchRoutine(id: string, on: boolean) {
  const res = await post(`${base(id)}/on`, { on });
  if (res.ok) toast(on ? "On again." : "Paused. It won't run until you turn it on.");
  bumpRoutines();
  return res.ok;
}
// Put a removed one back, as it was.
export async function restoreRoutine(id: string) {
  const res = await post(`${base(id)}/restore`);
  if (res.ok) toast("Restored, as it was.");
  else toast(res.data?.error || "It couldn't be restored.");
  bumpRoutines();
  return res.ok;
}
