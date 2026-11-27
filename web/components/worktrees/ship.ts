// What a task ships: its pull requests and branches (plugin/shared/task-ship.ts, wip-sets.ts). A task with what it
// ships: what you put in it (its ship's `items`), then every branch and pull request a thread on it works on (setsOf),
// each { id, item, w, via }; its threads (`posts`); where it stands (`ss`, setStatus's); and its landing order,
// landing and events, from agentbook-server. A pull request can be in two tasks, as a thread can be on two.
import { workspaces } from "../../lib/agents.ts";
import { getJSON } from "../../lib/api.ts";
import { getApp, takeRows } from "../../lib/store.ts";
import type { SharedPart, TaskRow, Thread } from "../../lib/types.ts";
import { DONE, orderOf, setStatus, setsOf, type Part, type SetIn, type SetOf, type Standing } from "../../lib/wip-sets.ts";
import { bump, findSharedWith, prState, prWips, sessionById, WIP_RANK, WIP_WORDS, wipById, wips, wipStatus, wipWsName, type Wip, type WipSt } from "./wips.ts";

// A task's set (shipOfTask): setsOf's, with its task, its threads again as `posts`, and where it stands (`ss`).
export type ShipPart = Part<Thread, Wip>;
type ShipIn = SetIn & { landing?: TaskRow["ship"]["landing"]; events?: TaskRow["ship"]["events"] };
export type TaskShip = Omit<SetOf<ShipIn, Thread, Wip>, "posts"> & { task?: TaskRow; posts?: Thread[]; ss?: Standing<ShipPart, Thread> };

// Kept by the chrome's state: a new one when the chrome changes.
let memo: { key: unknown[]; of: Map<string, TaskShip>; all: Wip[] | null; shared: Map<string, Wip[]> } = { key: [], of: new Map(), all: null, shared: new Map() };
function kept() {
  const s = getApp();
  const key = [s.data, s.rows, s.more, wsSeen];
  if (key.some((x, i) => x !== memo.key[i])) memo = { key, of: new Map(), all: null, shared: new Map() };
  return memo;
}
// Every pull request and branch the page has, a branch with a pull request as that.
export function shipWips(): Wip[] {
  const m = kept();
  if (!m.all) {
    const taken = new Set(prWips().flatMap((x) => x.local.map((l) => l.id)));
    m.all = [...prWips(), ...wips().filter((w) => !taken.has(w.id))];
  }
  return m.all;
}
// The threads in a thread of yours (a talk): its guests' threads.
const guestsOn = (s: Thread) => ((s as { guests?: { id: string; removed?: boolean }[] }).guests || []).filter((g) => !g.removed);
export function shipOfTask(t: TaskRow): TaskShip {
  const all = shipWips();
  const m = kept();
  if (m.of.has(t.id)) return m.of.get(t.id);
  // One shared with you: what it ships as its owner's page has it, from agentbook-server (sharedWips).
  const shared = Array.isArray(t.parts) ? sharedWips(t as TaskRow & { parts: SharedPart[] }) : null;
  const guests = (s: Thread) => (String(s.id).startsWith("t-") ? guestsOn(s).map((g) => sessionById(g.id)).filter(Boolean) : []);
  const sh = t.ship || ({} as TaskRow["ship"]);
  const raw = { id: t.id, title: t.text, items: sh.items || [], posts: (t.posts || []).map((e) => e.post), order: sh.order || null, landing: sh.landing || null, events: sh.events || [], created: t.at } as ShipIn;
  const x = setsOf([raw], { wips: shared || all, byId: shared ? (id) => shared.find((w) => w.id === id) || null : wipById, thread: sessionById, guests }).list[0] as unknown as TaskShip;
  Object.assign(x, { task: t, posts: x.threads });
  x.ss = setStatus(x, { statusOf: partStatus, rank: WIP_RANK });
  m.of.set(t.id, x);
  return x;
}

// What a task shared with you ships, as records like the page's own WIPs: its owner's
// page finds them in their workspaces and checkouts, which you don't have, so agentbook-server sends them (`parts`):
// each pull request with how GitHub last had it, each branch and whether it landed, the threads on each, and, while
// always (`work`), how its branch stands on the machine that has it (`where`). They're only to read here
// (`shared`): their next steps start work on its owner's machines. Each has its page (`rid`, its link's id), read
// through the task's routes (sharedApi).
export function sharedWips(t: { id: string; parts: SharedPart[]; via?: string }): Wip[] {
  const m = kept();
  if (m.shared.has(t.id)) return m.shared.get(t.id);
  const work = true; // the people on a task always see its work
  const list = t.parts.map((p): Wip => {
    const posts = (p.threads || []).map(sessionById).filter(Boolean);
    const at = p.where || null;
    const local = (at ? [{ id: `${t.id}~${p.id}`, machine: at.owner ? `@${at.owner}'s ${at.machine}` : at.machine, dirty: at.dirty, sha: at.sha, worktree: null, here: false }] : []) as Wip[];
    const base = { shared: true, work, task: t.id, via: t.via || "tasks", part: p.id, posts, local, repo: p.repo };
    if (p.kind === "pr") {
      const gh = p.gh || {};
      const pr = { ...gh, url: p.url, number: gh.number ?? Number(String(p.ref || "").replace("#", "")), title: gh.title || p.title, head: gh.head || p.branch, base: gh.base || "main" } as Wip["pr"];
      return { ...base, kind: "pr", id: p.id, rid: `${t.id}~pr${pr.number}`, ws: null, pr, number: pr.number, branch: pr.head, base: pr.base, dirty: at?.dirty || 0, at: gh.closed || gh.created || "", state: p.gh ? prState(pr, posts) : "open", title: pr.title };
    }
    const state = posts.some((s) => s.effective === "needs") ? "needs" : posts.some((s) => s.effective === "working") ? "live" : p.landed ? "clear" : at?.dirty ? "dirty" : "open";
    return { ...base, kind: "branch", id: p.id, rid: `${t.id}~${p.branch}`, branch: p.branch, base: at?.base || "main", machine: local[0]?.machine || "", ahead: at?.ahead || 0, behind: at?.behind || 0, dirty: at?.dirty || 0, commits: (at?.commits as unknown as number) || 0, worked: !!at?.worked, sha: at?.sha || null, subject: at?.subject || "", at: at?.at || "", tip: at?.at || "", state, title: p.title || at?.subject || p.branch, gone: !at };
  });
  m.shared.set(t.id, list);
  return list;
}

// Someone else's workspace, read by its link (the workspace page's loadWsSeen): what the page knows of it, kept here
// for the worktrees of it you may see. Its own page (the workspace area) reads it the same way.
export interface WsSeen {
  loading?: boolean;
  error?: number;
  workspace?: { id: string; name?: string; owner?: string; repo?: string; visibility?: string };
  parts?: SharedPart[];
  threads?: Thread[];
}
let wsSeen: Record<string, WsSeen> = {};
async function loadWsSeen(id: string) {
  wsSeen = { ...wsSeen, [id]: { loading: true } };
  const d = await getJSON<WsSeen>(`/api/workspaces/${encodeURIComponent(id)}`);
  wsSeen = { ...wsSeen, [id]: d || { error: 0 } };
  takeRows(d?.threads);
  bump(); // draws again with it
}
export const wsSeenOf = (id: string) => wsSeen[id] || null;
// Its worktrees you may see, as the server sent them, or null while it's read (it starts reading one not read yet:
// a workspace's id starts with "w").
export function wsSeenParts(wid: string): SharedPart[] | null {
  const seen = wsSeen[wid];
  if (!seen && /^w[0-9a-z]{4,}$/.test(wid) && getApp().data?.workspaces && !workspaces().some((x) => x.id === wid)) void loadWsSeen(wid);
  return Array.isArray(seen?.parts) ? seen.parts : null;
}
// A shared one by its page's id, from the tasks shared with you, or the workspaces of others' you opened (one opened
// by its link is read first: wsSeenParts).
export function sharedWipByRid(id: string): Wip | null {
  let rid = id;
  try {
    rid = decodeURIComponent(id);
  } catch {}
  for (const t of (getApp().data?.tasks || []) as TaskRow[]) if (Array.isArray(t.parts) && rid.startsWith(`${t.id}~`)) return sharedWips(t as TaskRow & { parts: SharedPart[] }).find((w) => w.rid === rid) || null;
  const wid = rid.split("~")[0];
  const parts = wsSeenParts(wid);
  return parts ? sharedWips({ id: wid, parts, via: "workspaces" }).find((w) => w.rid === rid) || null : null;
}
findSharedWith(sharedWipByRid);
// The routes a shared one is read through: the task's, which read its branch on the machine that has it and its pull
// request from GitHub as someone on the task; or the workspace's, as its owner's.
export const sharedApi = (w: Wip, what: string, more: Record<string, string> = {}) => `/api/${w.via === "workspaces" ? "workspaces" : "tasks"}/${encodeURIComponent(w.task)}/${what}?${new URLSearchParams({ part: w.part, ...more })}`;
// The tasks a pull request or a branch is in: put in one, or worked on by a thread on one. A thread's own to-dos
// (`scope`) ship nothing.
export const tasksOfPart = (w: Wip | null | undefined): TaskRow[] => (w ? ((getApp().data?.tasks || []) as TaskRow[]).filter((t) => !t.scope && shipOfTask(t).parts.some((p) => p.id === w.id)) : []);
// "merged" when all it ships are pull requests, else "landed".
export const landWord = (x: TaskShip) => (x.parts.every((p) => (p.w?.kind || p.item?.kind) === "pr") ? "merged" : "landed");
// Where one thing in it stands: its own word, or, one the page can't see, whether it's still reading git and GitHub.
export function partStatus(p: ShipPart): WipSt {
  if (p.w) return wipStatus(p.w);
  const reading = workspaces().some((x) => x.pulls === null) || (getApp().data?.folders || []).some((f) => f.sessions && !("wip" in f));
  const what = p.item?.kind === "pr" ? `pull request ${p.item.ref}` : `the branch ${p.item?.ref || ""}`;
  return reading ? { k: "reading", why: "reading git and GitHub", word: WIP_WORDS.reading[0], icon: WIP_WORDS.reading[1], tone: "" } : { k: "gone", why: `${what} isn't WIP anywhere now: merged or closed long ago, or its branch was cleaned up`, word: WIP_WORDS.gone[0], icon: WIP_WORDS.gone[1], tone: "" };
}
export const setParts = (x: TaskShip) => [...x.parts].sort((a, b) => (WIP_RANK[partStatus(a).k] ?? 9) - (WIP_RANK[partStatus(b).k] ?? 9));
export const partRef = (p: ShipPart) => (p.w ? (p.w.kind === "pr" ? `#${p.w.number}` : p.w.branch.replace(/^worktree-/, "")) : p.item.ref);
export const partTitle = (p: ShipPart) => p.w?.title || p.item?.title || p.item?.ref || "";
// "1 merged, 1 ready, 1 stuck, 1 on a branch".
export const setTally = (x: TaskShip) =>
  Object.entries(x.ss.counts.by)
    .sort(([a], [b]) => (WIP_RANK[b] ?? 9) - (WIP_RANK[a] ?? 9))
    .map(([k, n]) => `${n} ${WIP_WORDS[k][0].toLowerCase()}`)
    .join(", ");
// What the rest are doing: "1 ready to merge, 1 stuck, 2 on their way".
export function setRest(x: TaskShip) {
  const by = x.ss.counts.by;
  const way = Object.entries(by)
    .filter(([k]) => !["ready", "stuck", "needs", ...DONE].includes(k))
    .reduce((n, [, v]) => n + v, 0);
  return [by.needs ? `${by.needs} waiting for you` : "", by.ready ? `${by.ready} ready to merge` : "", by.stuck ? `${by.stuck} stuck` : "", way ? `${way} on ${way === 1 ? "its" : "their"} way` : "", by.closed ? `${by.closed} closed` : ""].filter(Boolean).join(", ");
}
// What the page says of one of its pull requests or branches, for the server to keep (it can't work it out).
export const wipItemOf = (w: Wip) => ({ id: w.id, kind: w.kind === "pr" ? "pr" : "branch", title: w.title, ref: w.kind === "pr" ? `#${w.number}` : w.branch, repo: wipWsName(w), url: w.pr?.url || "" });
export const partUrl = (p: ShipPart) => p.w?.pr?.url || p.item?.url || null;
export const partBranch = (p: ShipPart) => p.w?.branch || (p.item?.kind === "branch" ? p.item.ref : null);
export const setQueue = (x: TaskShip) => (x.order ? orderOf(x, x.parts, { urlOf: partUrl, branchOf: partBranch }) : []);
export { DONE };

// A file picked in a task's Changes opens on its part's own page (setFileOpened): which part, the file's key
// ("scope|path") and its scope. The part's page takes it once it's drawn.
export interface GoFile {
  id: string;
  key: string;
  scope: string;
}
let goFile: GoFile | null = null;
export const setGoFile = (g: GoFile | null) => void (goFile = g);
export function takeGoFile(id: string): GoFile | null {
  if (goFile?.id !== id) return null;
  const g = goFile;
  goFile = null;
  return g;
}
