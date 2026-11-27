// The page's chrome, made on the server: everything the sidebar, the rail, the
// composer and the menus show, but threads, as records by `type:id`: agents, pages, groups, WIPs of many, machines,
// workspaces, tasks, routines, connectors, questions, notes, threads starting and folders. What screens used to
// count from every thread a person has is counted here (an agent's threads and projects, a workspace's, what runs on
// a machine, the threads on a WIP branch). And a row of each thread that's open or that one of them names: enough to
// name it, link to it and say how it's going (ROW), not its results, prompt or messages, which the screens showing
// those ask for (q/feed, q/thread, q/threads).
//
// sideOf(v): over the view a person may see (main.ts's viewForReq), { records, order, data }: `order`, each kind's
// keys in the order the view has them; `data`, what isn't a record (this machine's name, GitHub, the preview host,
// how many threads run in a workspace, and threads still cloning).

import { workspacesOf } from "./feed.ts";
import type { FeedThread, FeedView, Workspaces } from "./feed.ts";
import type { FolderInfo } from "./relay.ts";
import type { Iso, Question } from "../plugin/shared/types.ts";
import type { AgentRow, ConnectorRow, FolderRow, GroupRow, LaunchRow, MachineRow, NoteRow, PageData, PageRow, RoutineRow, SideQ, SideRecord, TaskRow, Thread, WorkspaceRow } from "../plugin/shared/api.ts";

// A thread as the chrome reads it, besides what the feed does.
export interface SideThread extends FeedThread {
  rt?: { syncing?: boolean } | null;
  updated?: Iso;
  model?: string | null;
  // How many files it has (a list, where the view has them).
  files?: Thread["files"];
  visibility?: Thread["visibility"];
  prs?: Record<string, unknown>;
  routine?: Thread["routine"];
  started_from?: string | null;
  side_at?: Iso;
}
// What the chrome reads of a person's view (main.ts's viewForReq), besides what the feed does. Each record goes out
// with its other fields as the view has them.
export interface SideView extends FeedView {
  sessions: SideThread[];
  talks?: SideThread[];
  agents: AgentRow[];
  workspaces?: WorkspaceRow[];
  folders?: (FolderInfo & { machine: string })[];
  machines?: MachineRow[];
  pages?: PageRow[];
  notes?: NoteRow[];
  groups?: GroupRow[];
  tasks?: TaskRow[];
  routines?: (RoutineRow & { post?: string | null })[];
  connectors?: ConnectorRow[];
  questions?: Question[];
  launches?: LaunchRow[];
  github?: PageData["github"];
  preview?: string | null;
  cloning?: PageData["cloning"];
  added?: PageData["added"];
  ui?: string | null;
  dismissed?: Record<string, string>;
  images?: PageData["images"];
  boxes?: PageData["boxes"];
}
// The chrome (sideOf): its records by `type:id`, each kind's keys in order, and what isn't a record.
export type Side = Omit<SideQ, "watching">;

// A thread's row: what lists, links, counts and chips read of it.
export const ROW = ["id", "agent", "label", "title", "state", "effective", "busy", "asleep", "archived", "archived_at", "hidden", "started", "updated", "ended", "end_reason", "page", "group", "mine", "public", "owner", "visibility", "show_work", "root", "machine", "offline", "branch", "repo", "model", "files", "messages", "pinned", "pinned_at", "routine", "launch", "rev", "cloud", "open_questions", "asking", "failed", "guest_of", "pickup", "talk", "started_from", "side_at"] as const;
type RowFields = Partial<Pick<Thread, Extract<(typeof ROW)[number], keyof Thread>>>;
export function rowOf(s: RowFields & { id: string }, ws: Workspaces | null): Thread {
  const out: Thread = { workspaces: ws ? ws.of(s) : [], id: s.id };
  for (const k of ROW) if (s[k] !== undefined) Object.assign(out, { [k]: s[k] });
  return out;
}

const shelf = (s: SideThread) => !!(s.archived || s.hidden);
// Pinned first, the latest pin on top; then by when they started, newest first (the feed's order).
const feedOrder = (a: SideThread, b: SideThread) => Number(!!b.pinned) - Number(!!a.pinned) || (b.pinned_at || "").localeCompare(a.pinned_at || "") || (b.started || "").localeCompare(a.started || "");
const newest = (a: SideThread, b: SideThread) => (b.started || "").localeCompare(a.started || "");
const latest = (list: SideThread[], key: "updated"): string => list.reduce((m, x) => ((x[key] || "") > m ? x[key] : m), "");
const distinct = <T>(xs: T[]): T[] => [...new Set(xs.filter(Boolean))];

export function sideOf(v: SideView): Side {
  const ws = workspacesOf(v);
  const machineOf = (x: { machine?: string }) => x.machine || v.machine;
  const records: Side["records"] = {};
  const order: Side["order"] = {};
  const put = (type: string, id: string, rec: SideRecord) => {
    const key = `${type}:${id}`;
    records[key] = rec;
    (order[type] ||= []).push(key);
  };
  const named = new Set<string>(); // threads a record names, to send a row of
  const name = (id: string | null | undefined) => id && named.add(id);
  const byAgent = new Map<string, SideThread[]>();
  for (const s of v.sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) || []), s]);
  const hiddenAgents = new Set(v.agents.filter((a) => a.mine !== false && a.hidden).map((a) => a.id));

  // Agents: how their threads are going (the view counts those on the feed), and what they've done in all.
  for (const a of v.agents) {
    const mine = [...(byAgent.get(a.id) || [])].sort(feedOrder);
    put("agent", a.id, {
      ...a,
      used: latest(mine, "updated"),
      syncing: mine.some((s) => s.rt?.syncing),
      ended: mine.filter((s) => ["done", "idle"].includes(s.effective)).length, // its idle ones: "N idle" on its card
      // (Not `repos` or `models`: its agent record has those. `repos` says it clones a repo where it runs, and
      // `models` is what its machine says it can run.)
      thread_repos: distinct(mine.map((s) => s.repo)),
      thread_models: distinct(mine.map((s) => s.model)),
      thread_files: mine.reduce((n, s) => n + (Number(s.files) || 0), 0),
      public_threads: mine.filter((s) => s.visibility === "public").length,
      latest: mine[0]?.id || null,
    });
    name(mine[0]?.id);
  }

  // Workspaces: their threads (not your hidden agents'), how they're going, which agents and pages they had, and,
  // for a repo on GitHub, the threads of each pull request: the ones that linked it, and the ones on its branch there
  // (the page keeps those from before it closed, unless its branch is still a WIP).
  let wsRunning = 0;
  for (const s of v.sessions) if (s.effective === "working" && !shelf(s) && ws.of(s).length) wsRunning++;
  for (const w of v.workspaces || []) {
    const all = v.sessions.filter((s) => ws.of(s).includes(w.id));
    const threads = all.filter((s) => !hiddenAgents.has(s.agent)).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    const open = (...states: string[]) => threads.filter((s) => !shelf(s) && states.includes(s.effective)).length;
    const agents = distinct(threads.map((s) => s.agent)).map((id) => {
      const theirs = threads.filter((s) => s.agent === id);
      return { id, threads: theirs.length, running: theirs.filter((s) => !shelf(s) && s.effective === "working").length, last: theirs[0].updated || theirs[0].started };
    });
    const rec: (typeof w) & { live: number; used: string; counts: Record<string, number>; agents: { id: string; threads: number; running: number; last: string }[]; pages: string[] } = {
      ...w,
      live: all.filter((s) => s.effective === "working" && !shelf(s)).length,
      used: [w.created || "", latest(all, "updated")].sort().at(-1),
      counts: { threads: threads.length, done: threads.filter((s) => ["done", "idle"].includes(s.effective)).length, running: open("working"), needs: open("needs"), idle: open("idle", "waiting", "done") },
      agents,
      pages: distinct(threads.map((s) => s.page)),
    };
    if (w.pulls?.pulls) {
      const checkouts = ws.list.find((x) => x.id === w.id)?.checkouts || [];
      const inWs = (s: SideThread) => !!s.root && checkouts.some((c) => c.machine === machineOf(s) && (s.root === c.root || s.root.startsWith(`${c.root}/`)));
      rec.pulls = {
        ...w.pulls,
        pulls: w.pulls.pulls.map((p) => {
          const url = String(p.url || "").toLowerCase();
          const linked = v.sessions.filter((s) => Object.keys(s.prs || {}).some((u) => u.toLowerCase() === url)).sort(newest).map((s) => s.id);
          const onBranch = v.sessions.filter((s) => s.branch === p.head && inWs(s)).sort(newest).map((s) => s.id);
          for (const id of [...linked, ...onBranch]) name(id);
          return { ...p, linked, on_branch: onBranch };
        }),
      };
    }
    put("workspace", w.id, rec);
  }

  // Machines: how many threads run on each. When it was last seen, and the commands waiting for it, only for one
  // that's off (all the page says of them): on, they change with every poll and every command it takes.
  for (const m of v.machines || []) {
    const quiet = m.online ? { seen: null, ...("waiting" in m ? { waiting: 0 } : {}) } : {};
    put("machine", m.name, { ...m, ...quiet, running: v.sessions.filter((s) => s.effective === "working" && !shelf(s) && machineOf(s) === m.name).length });
  }

  // Folders threads ran in, each branch with work not on main with the threads that worked on it (WIP).
  for (const f of v.folders || []) {
    const machine = machineOf(f);
    const rec: FolderRow = { ...f, machine };
    if (Array.isArray(f.wip)) {
      rec.wip = f.wip.map((w) => {
        const posts = v.sessions.filter((s) => machineOf(s) === machine && s.root === w.root && s.branch === w.branch).sort(newest).map((s) => s.id);
        posts.forEach(name);
        return { ...w, posts };
      });
    }
    put("folder", `${machine}|${f.root}`, rec);
  }

  // Pages, groups, and what's yours: tasks, routines, connectors, questions, threads starting.
  const onPage = (p: { id: string }, id: string | null | undefined) => (id && p.id.includes("~") && !String(id).includes("~") ? `${p.id.split("~")[0]}~${id}` : id);
  for (const p of v.pages || []) {
    put("page", p.id, p);
    for (const by of [p.by, p.last?.by, ...(p.recent || []).map((r) => r.by), ...(p.widgets || []).map((w) => w.by)]) name(onPage(p, by?.post));
    for (const x of p.posts || []) name(onPage(p, x.post));
  }
  for (const n of v.notes || []) {
    put("note", n.id, n);
    for (const id of n.threads || []) name(id);
  }
  for (const g of v.groups || []) put("group", g.id, g);
  for (const t of v.tasks || []) {
    put("task", t.id, t);
    for (const id of [t.from, t.done_post, ...(t.posts || []).map((e) => e.post)]) name(id);
  }
  // A routine says which threads it has going (it's looked at again when they change).
  const byRoutine = new Map<string, [string, string][]>();
  for (const s of v.sessions) if (s.routine?.id && !s.archived) byRoutine.set(s.routine.id, [...(byRoutine.get(s.routine.id) || []), [s.id, s.effective]]);
  for (const r of v.routines || []) {
    put("routine", r.id, { ...r, threads: byRoutine.get(r.id) || [] });
    for (const id of [r.thread, r.post, r.by?.post, r.fix?.post, ...(r.links || []).filter((l) => l.kind === "thread").map((l) => l.id)]) name(id);
  }
  for (const c of v.connectors || []) put("connector", c.id, c);
  for (const q of v.questions || []) {
    put("question", q.id, q);
    name(q.post);
  }
  for (const l of v.launches || []) {
    put("launch", l.id, l);
    name(l.post);
  }

  // The thread each was started from (a Claude Desktop session's task), for its "from" chip.
  for (const s of v.sessions) name(s.started_from);
  // Rows: every thread not archived, and the archived ones something here names.
  for (const s of [...v.sessions].sort(feedOrder)) if (!s.archived || named.has(s.id)) put("thread", s.id, rowOf(s, ws));
  // And the threads people started themselves (talks) that one names: a task's, someone's on a task shared with you.
  for (const t of v.talks || []) if (named.has(t.id)) put("thread", t.id, rowOf(t, ws));

  // `added`: the bell's notifications, each `seen` or not (main.ts, addedFor). `dismissed`:
  // the routines' failures they took off Needs you.
  return { records, order, data: { machine: v.machine || null, github: v.github || null, preview: v.preview || null, ws_running: wsRunning, cloning: v.cloning || [], added: v.added || [], ui: v.ui || null, dismissed: v.dismissed || {}, images: v.images || [], boxes: v.boxes || [] } };
}

// What changed between two answers: the records to put (new or different, as JSON says), the keys gone, and the
// kinds whose order changed. `had`: key -> JSON of what was sent.
export function sideDiff(had: Map<string, string>, side: Pick<Side, "records">): { put: Record<string, unknown>; del: string[] } {
  const put: Record<string, unknown> = {};
  const del: string[] = [];
  for (const [k, r] of Object.entries(side.records)) {
    const json = JSON.stringify(r);
    if (had.get(k) !== json) {
      put[k] = r;
      had.set(k, json);
    }
  }
  for (const k of had.keys()) if (!(k in side.records)) del.push(k);
  for (const k of del) had.delete(k);
  return { put, del };
}
