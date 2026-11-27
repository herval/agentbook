// Tasks: your to-do list (app.ts "tasks: your to-do list" and "a task's page"), as logic: which tasks are open and
// done, what a task is on and who it's for, the filter bar's lens, and what ticking, sending, editing, moving,
// sharing and deleting one does. The components beside this file draw them.
import { create } from "zustand";
import { agentName, hiddenAgent, seniority, startable, workspaces } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { listText } from "../../lib/format.ts";
import { getDraft, setDraft } from "../../lib/hooks.ts";
import { go, groupHref, NO_SCOPE, SCOPE_KEYS, scopeHref } from "../../lib/route.ts";
import { agentOf, allRows, getApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, PageRow, Scope, TaskRow, Thread } from "../../lib/types.ts";
import { sessionById } from "../worktrees/wips.ts";
import { saidAsked } from "../people/AskedElsewhere.tsx";

// What the Tasks page and its rows keep while you're on them (the old S.justDone, S.taskOpen, S.taskEdit, …).
// Something you tick stays where it was, crossed out, until you leave the page, so a slip is easy to undo.
interface TasksUi {
  justDone: Set<string>;
  taskOpen: Set<string>;
  // The task being edited in place, and which of its boxes to start in ("note": its body).
  taskEdit: string | null;
  taskEditAt: string | null;
  taskNew: boolean;
  tasksDone: boolean;
  tasksPageDone: boolean;
  pageTasksDone: Set<string>;
  taskShare: string | null;
  shareAsk: { task: string; user: string; text: string } | null;
  // A dragged task (by its handle, in a list) and a dragged card (on the board).
  taskDrag: string | null;
  cardDrag: string | null;
  // A task's History, all of it.
  wipAll: boolean;
}
export const useTasksUi = create<TasksUi>(() => ({ justDone: new Set(), taskOpen: new Set(), taskEdit: null, taskEditAt: null, taskNew: false, tasksDone: false, tasksPageDone: false, pageTasksDone: new Set(), taskShare: null, shareAsk: null, taskDrag: null, cardDrag: null, wipAll: false }));
const ui = () => useTasksUi.getState();
export const setUi = (p: Partial<TasksUi>) => useTasksUi.setState(p);
export const forgetTicked = () => setUi({ justDone: new Set() });

// Sending a task to an agent fills the composer (sendTask): the task it's for, and the workspace and agent it picks.
// The composer (core's) reads these, shows "For task" (ForTaskChip) and, once it starts the thread, tells the task
// (POST /api/tasks/:id/send { launch, agent }).
export const useSendTask = create<{ forTask: string | null; wsPick: string | null; agentPick: string | null }>(() => ({ forTask: null, wsPick: null, agentPick: null }));

const data = () => getApp().data;
const tasksOf = () => (data()?.tasks || []) as TaskRow[];

// Your tasks, in your order: the ones you added, the ones connectors brought in, and the to-dos agents left you
// (ab_todo), which go on top. Something you tick stays where it was, crossed out, until you leave the page, so
// a slip is easy to undo.
export const ticked = (t: TaskRow) => !t.done || ui().justDone.has(t.id);
export const openTasks = () => tasksOf().filter(ticked).sort((a, b) => a.rank - b.rank);
export const doneTasks = () => tasksOf().filter((t) => !ticked(t)).sort((a, b) => b.done_at.localeCompare(a.done_at));
export const openTaskCount = () => tasksOf().filter((t) => !t.done).length;
export const taskById = (id: string | null | undefined): TaskRow | undefined => (id ? tasksOf().find((t) => t.id === id) || ((data()?.todos || []) as TaskRow[]).find((t) => t.id === id) : undefined);
export const pageById = (id: string | null | undefined): PageRow | undefined => (id ? (data()?.pages || []).find((p) => p.id === id) : undefined);
export const groupById = (id: string | null | undefined): GroupRow | undefined => (id ? (data()?.groups || []).find((g) => g.id === id) : undefined);
export const groupMine = (g: GroupRow | null | undefined) => g?.mine !== false;
export const taskPageIds = (t: TaskRow) => (Array.isArray(t.pages) ? t.pages.map((e) => e.page) : t.page ? [t.page] : []);
export const taskPagesOf = (t: TaskRow) => taskPageIds(t).map(pageById).filter(Boolean);

// A task shared with others: who's on it (its owner first, by username), whether it's
// yours, and the faces of everyone else on it, with whose it is on one that isn't yours. Nothing on one only you're on.
export const taskPeople = (t: TaskRow) => [t.owner_name, ...(t.people || []).map((p) => p.user)].filter(Boolean);
export const taskMine = (t: TaskRow) => t.mine !== false;
export const atNames = (list: string[]) => list.map((u) => `@${u}`).join(", ");
export const me = () => getApp().me?.username;

export const sentOn = (t: TaskRow) => !!t.sent?.length || (t.posts || []).some((e) => e.post !== t.from && sessionById(e.post));
export const taskThreads = (t: TaskRow) => [t.from, ...(t.posts || []).map((e) => e.post), t.done_post].map((id) => id && sessionById(id)).filter(Boolean);
export const taskAgentIds = (t: TaskRow) => [t.agent, ...(t.sent || []).map((e) => e.agent), ...taskThreads(t).map((s) => s.agent)].filter((a) => a != null);
export const TASK_STATES = { all: () => true, todo: (t: TaskRow) => ticked(t) && !sentOn(t), with: (t: TaskRow) => ticked(t) && sentOn(t), done: (t: TaskRow) => !ticked(t) };
// How the filter bar reads the Tasks page (app.ts's LENS.tasks): its items, each one's agents, workspaces, pages and
// groups, and its statuses, the first being what it shows with none picked.
export const tasksLens = {
  items: () => tasksOf(),
  of: { agent: taskAgentIds, workspace: (t: TaskRow) => [t.workspace], page: (t: TaskRow) => [...taskPageIds(t), ...taskThreads(t).map((s) => s.page)], group: (t: TaskRow) => [t.group, ...taskThreads(t).map((s) => s.group)] },
  keys: Object.keys(TASK_STATES),
  states: () => [["all", "Any status"], ["todo", "To do"], ["with", "Sent to an agent"], ["done", "Done"]],
  is: (t: TaskRow, f: string) => (TASK_STATES[f] || TASK_STATES.all)(t),
};
// Whether something passes the bar's narrowing: each of agent, workspace, page and group either isn't picked, or
// the thing has one of the picks.
export const inScope = <T>(of: Record<string, (x: T) => unknown[]>, x: T, scope: Scope = NO_SCOPE, except: string | null = null) => SCOPE_KEYS.every((k) => k === except || !scope[k]?.length || of[k](x).some((v) => scope[k].includes(v as string)));
export const scopeSet = (scope: Scope = NO_SCOPE) => SCOPE_KEYS.some((k) => scope[k]?.length);
export const oneOf = (scope: Scope | undefined, k: (typeof SCOPE_KEYS)[number]) => (scope?.[k]?.length === 1 ? scope[k][0] : null);
// The screens the bar narrows (the feed's right column, Tasks, Worktrees).
export const SCOPED = { feed: true, tasks: true, worktrees: true };

// The thread that has a task now: one of them that needs you, else the newest one working on it (not the one that
// left it to you), or the launch it just went out as, while that starts. How many threads have worked on it, too.
export function taskGoing(t: TaskRow) {
  const posts = (t.posts || []).filter((e) => e.post !== t.from && sessionById(e.post));
  const needs = posts.find((e) => sessionById(e.post).effective === "needs");
  // Not a thread someone started themselves (a talk): no agent works in it, so it's "done" from the start.
  const newest = needs || posts.filter((e) => !sessionById(e.post).talk).at(-1);
  const starting = t.sent?.filter((e) => !e.post).at(-1);
  const e = !needs && starting && (!newest || starting.at > newest.at) ? starting : newest;
  if (!e) return null;
  const s = e.post && sessionById(e.post);
  const l = !s && (data()?.launches || []).find((x) => x.id === (e as { launch?: string }).launch);
  return { s, l, agent: s?.agent ?? l?.agent ?? (e as { agent?: string }).agent, n: posts.length };
}
// Its threads, the page has a row of each: the ones that need you first, then the ones working, then the latest.
const WIP_FIRST = { needs: 0, working: 1 };
export function threadsOnTask(t: TaskRow): Thread[] {
  const list = [...new Set((t.posts || []).map((e) => e.post))].map(sessionById).filter(Boolean);
  return list.sort((a, b) => (WIP_FIRST[a.effective] ?? 2) - (WIP_FIRST[b.effective] ?? 2) || (b.updated || b.started || "").localeCompare(a.updated || a.started || ""));
}
// Where it stands, in a word, as the board's lanes say it: To do, With an agent (Live while one works on it, Needs
// you when one waits for you), Done.
export const TASK_WORDS = { todo: ["To do", "tasks"], with: ["With an agent", "send"], live: ["Live", ""], needs: ["Needs you", "hand"], done: ["Done", "check"] } as const;
export function taskStatus(t: TaskRow) {
  const threads = threadsOnTask(t);
  const k = t.done ? "done" : threads.some((s) => s.effective === "needs") ? "needs" : threads.some((s) => s.effective === "working") ? "live" : sentOn(t) ? "with" : "todo";
  return { k, word: TASK_WORDS[k][0], icon: TASK_WORDS[k][1] };
}

// Where and who a task is for, picked under it as you add or edit it. Sending it picks them in the composer.
// The agents are the ones you can post to, offline ones too: the task may wait for one. The groups are yours that
// aren't archived (and the one it's in, if that is); with none, there's no group to pick.
export const taskAgents = (keep: string | null) => {
  const list = (data()?.agents || []).filter((a) => startable(a) && !hiddenAgent(a)).sort((a, b) => seniority(a).localeCompare(seniority(b)));
  return keep && !list.some((a) => a.id === keep) ? [...list, agentOf(keep)] : list;
};
export const taskGroups = (keep?: string | null) => (data()?.groups || []).filter((g) => groupMine(g) && (!g.archived || g.id === keep));
// What putting a task in a group, or taking it out, says. Its threads hear of one that comes in.
export function taskMovedText(t: TaskRow, to: string | null) {
  const g = to && groupById(to);
  const was = t.group && groupById(t.group);
  return g ? `In ${g.name}${was ? `, out of ${was.name}` : ""}. Its threads hear about it with their next message.` : `Out of ${was?.name || "its group"}.`;
}

// Connectors: the name of the one a task came in from (its issue's tool).
export { connectorName } from "./connectors.tsx";

// What sending a task to an agent asks of it: its title and its body (one text again where a long title was cut),
// the link to its issue and the page it's on, for the agent to read.
export function taskPrompt(t: TaskRow | null | undefined) {
  if (!t) return "";
  const pgs = taskPagesOf(t);
  const more = [t.source?.url && `${t.source.key ? `${t.source.key}: ` : ""}${t.source.url}`, pgs.length && `It's on the page${pgs.length > 1 ? "s" : ""} ${listText(pgs.map((p) => `"${p.title}" (${p.id.split("~").pop()})`))}.`].filter(Boolean);
  return [taskWhole(t), ...more].join("\n\n");
}
// A task's title and body as one text, as text.ts's untitled() puts them back together.
export function taskWhole(t: TaskRow) {
  if (!t.text.endsWith("…") || !t.note?.startsWith("…")) return [t.text, t.note].filter(Boolean).join("\n\n");
  const head = t.text.slice(0, -1);
  return `${head}${head.includes(" ") ? " " : ""}${t.note.slice(1)}`;
}

/* what you do to a task */

// Ticking it off, or back: one you tick stays where it is, crossed out, till you leave the page.
export function tickTask(t: TaskRow, done: boolean) {
  if (done) setUi({ justDone: new Set(ui().justDone).add(t.id) });
  return post(`/api/tasks/${encodeURIComponent(t.id)}/done`, { done });
}
export const openNote = (id: string) => setUi({ taskOpen: new Set(ui().taskOpen).add(id) });
// Editing it in place: its title (or its body, `at` "note"), with what it says as the box's draft.
export function editTask(t: TaskRow | undefined, at: string | null = null) {
  // One shared with you is its owner's to change and tick off: you add your threads.
  if (!t || t.done || !taskMine(t)) return;
  setDraft(`task-${t.id}`, t.text);
  setDraft(`task-${t.id}-note`, t.note || "");
  setDraft(`task-${t.id}-ws`, t.workspace || "");
  setDraft(`task-${t.id}-agent`, t.agent || "");
  setDraft(`task-${t.id}-group`, t.group || "");
  setUi({ taskEdit: t.id, taskEditAt: at });
}
// Leaving the edit as it was.
export function cancelEdit() {
  const id = ui().taskEdit;
  for (const k of ["", "-ws", "-agent", "-group", "-note"]) setDraft(`task-${id}${k}`, "");
  setUi({ taskEdit: null, taskEditAt: null });
}
// The undo of a delete: one from a connector is only put out of sight, so its issue doesn't come back: Undo brings
// it back as it was. A shared one comes back with its people, and who sees it.
function undoDelete(task: TaskRow, { reshare = true, done = true } = {}) {
  const again = async (id: string) => {
    for (const p of task.people || []) await post(`/api/tasks/${encodeURIComponent(id)}/people`, { user: p.user });
    if (task.visibility) await post(`/api/tasks/${encodeURIComponent(id)}/visibility`, { visibility: task.visibility });
  };
  return async () => {
    if (task.source) return void post(`/api/tasks/${encodeURIComponent(task.id)}/restore`);
    const x = await post<{ id: string }>("/api/tasks", { text: task.text, note: task.note, pages: task.pages, group: task.group, rank: task.rank, workspace: task.workspace, agent: task.agent, ...(done ? { done: task.done } : {}), sent: task.sent, posts: task.posts });
    if (reshare && x.ok && x.data?.id) await again(x.data.id);
  };
}
// Saving an edited task: only what changed; saving it empty deletes it.
export async function saveTaskEdit(id: string, { text, note, ws, agent, group }: { text: string; note: string; ws: string | null; agent: string | null; group: string | null | undefined }) {
  if (ui().taskEdit !== id) return;
  const task = taskById(id);
  cancelEdit();
  if (!task) return;
  // With no group of yours to pick, there's no menu, and its group stays as it is.
  const g = group === undefined ? (task.group ?? null) : group;
  if (!text) {
    const r = await post(`/api/tasks/${encodeURIComponent(id)}/delete`, {});
    if (r.ok && getApp().route.name === "task" && getApp().route.id === id) go("#/tasks");
    if (r.ok) toast("Deleted.", { label: "Undo", run: () => void undoDelete({ ...task, source: null }, { reshare: false, done: false })() });
    return;
  }
  const change = { ...(text !== task.text ? { text } : {}), ...(note !== (task.note || "") ? { note } : {}), ...(ws !== task.workspace ? { workspace: ws } : {}), ...(agent !== (task.agent || null) ? { agent } : {}), ...(g !== (task.group || null) ? { group: g } : {}) };
  if (!Object.keys(change).length) return;
  const r = await post(`/api/tasks/${encodeURIComponent(id)}`, change);
  if (r.ok && "group" in change) toast(taskMovedText(task, g));
}
// Alt+↑/↓ while editing: one up or down your list.
export function moveEditing(up: boolean) {
  const id = ui().taskEdit;
  const order = openTasks()
    .filter((t) => !t.done)
    .map((t) => t.id);
  const i = order.indexOf(id);
  if (i < 0) return;
  if (up && i > 0) void post(`/api/tasks/${encodeURIComponent(id)}/move`, { before: order[i - 1] });
  if (!up && i < order.length - 1) void post(`/api/tasks/${encodeURIComponent(id)}/move`, { before: order[i + 2] ?? null });
}
// Moving one before another in your list (null: last).
export const moveTask = (id: string, before: string | null) => post(`/api/tasks/${encodeURIComponent(id)}/move`, { before });
// Deleting it, with Undo for a few seconds.
export async function deleteTask(task: TaskRow | undefined) {
  if (!task) return;
  const r = await post(`/api/tasks/${encodeURIComponent(task.id)}/delete`, {});
  if (r.ok && getApp().route.name === "task" && getApp().route.id === task.id) go("#/tasks");
  if (r.ok) toast("Deleted.", { label: "Undo", run: () => void undoDelete(task)() });
}
// Taking yourself off a task shared with you.
export async function leaveTask(task: TaskRow | undefined, id: string) {
  const r = await post(`/api/tasks/${encodeURIComponent(id)}/leave`, {});
  if (!r.ok) return;
  if (getApp().route.name === "task" && getApp().route.id === task?.id) go("#/tasks");
  toast(`You're off "${task?.text || "it"}".`);
}
// A new task, from a box: on top of your list, for a page, a group, a workspace and an agent. What was in the box
// comes back when it didn't go.
export async function addTask(key: string, body: { text: string; page?: string | null; group?: string | null; workspace?: string | null; agent?: string | null }) {
  setDraft(key, "");
  const r = await post("/api/tasks", body);
  if (!r.ok) setDraft(key, body.text);
  return r.ok;
}
// Putting someone on it. Your private threads on it show to them from then on, so agentbook says which first.
export async function addTaskPerson(t: TaskRow | undefined, who: string, sure = false) {
  const user = String(who || "")
    .trim()
    .replace(/^@/, "");
  if (!t || !user) return;
  const yours = threadsOnTask(t).filter((s) => s.mine !== false && !s.public);
  if (!sure && yours.length) {
    const names = yours
      .slice(0, 4)
      .map((s) => s.label || s.title)
      .join(", ");
    return setUi({ shareAsk: { task: t.id, user, text: `@${user} will see ${yours.length === 1 ? "your thread" : `${yours.length} of your threads`} on it from now on: ${names}${yours.length > 4 ? "…" : ""}, with their steps and changes.` } });
  }
  setUi({ shareAsk: null });
  const r = await post<{ user: string; asked?: boolean }>(`/api/tasks/${encodeURIComponent(t.id)}/people`, { user });
  if (r.ok && !saidAsked(r.data, "the task")) toast(`@${r.data.user} is on it now: it's on their Tasks.`);
}
// Taking someone off it.
export async function removeTaskPerson(task: string, user: string) {
  const r = await post(`/api/tasks/${encodeURIComponent(task)}/people`, { user, remove: true });
  if (r.ok) toast(`@${user} is off it.`);
}
// A thread's to-do onto your Tasks, for when it outlives the thread.
export async function todoLater(id: string) {
  const r = await post(`/api/tasks/${encodeURIComponent(id)}/later`, {});
  if (r.ok) toast("On your Tasks.", { label: "Open", run: () => go(`#/tasks/${encodeURIComponent(id)}`) });
}
export const linkThread = (task: string, postId: string, linked = true) => post(`/api/tasks/${encodeURIComponent(task)}/link`, linked ? { post: postId } : { post: postId, linked: false });
export const linkPage = (task: string, page: string, linked = true) => post(`/api/tasks/${encodeURIComponent(task)}/page`, linked ? { page } : { page, linked: false });

// Sending a task to an agent: the composer, filled with it. The task's text is the prompt; something you'd
// started writing stays, with the task after it. One in a group of yours starts in it, from the group's page.
export function sendTask(task: TaskRow | undefined) {
  if (!task) return;
  const g = task.group && groupById(task.group);
  const inGroup = !!g && groupMine(g) && !g.archived;
  const dk = inGroup ? `group:${g.id}` : "launch";
  const draft = getDraft(dk).trim();
  const st = useSendTask.getState();
  setDraft(dk, !draft || draft === taskPrompt(taskById(st.forTask)) ? taskPrompt(task) : `${draft}\n\n${taskPrompt(task)}`);
  const next: Partial<typeof st> = { forTask: task.id };
  if (task.workspace && workspaces().some((w) => w.id === task.workspace)) next.wsPick = task.workspace;
  // Its agent, or the one it last went to. One that can't take it now leaves the composer's pick.
  const agent = task.agent || task.sent?.at(-1)?.agent;
  if (agent && (data()?.agents || []).some((a) => a.id === agent && startable(a) && !a.offline && !hiddenAgent(a))) next.agentPick = agent;
  else if (task.agent) toast(`${agentName(task.agent)} ${agentOf(task.agent).offline ? "is offline" : "can't take threads"}: pick another agent.`);
  useSendTask.setState(next);
  const route = getApp().route;
  const here = inGroup ? route.name === "group" && route.id === g.id && (route.tab || "group") === "group" : route.name === "feed";
  if (!here) go(inGroup ? groupHref(g) : scopeHref("feed", SCOPED[route.name] ? route.scope : NO_SCOPE));
  // The composer's box, once it's drawn.
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".compose:not(.compose--task-new) textarea, .compose:not(.compose--task-new) [contenteditable]")?.focus());
}
// Every thread you could link to a task, the newest first.
export const linkableThreads = (linked: Set<string>) =>
  allRows()
    .filter((s) => !s.archived && !linked.has(s.id) && s.mine !== false)
    .sort((a, b) => (b.updated || b.started || "").localeCompare(a.updated || a.started || ""))
    .slice(0, 80);
