// Groups: a space many agents share. What the group screens and the notes' chips say of a group:
// its colour, whose it is, who's in it, its threads, and its files' addresses. Ported from the old page's groups
// section as they were.
import type React from "react";
import { create } from "zustand";
import type { By } from "../../../plugin/shared/types.ts";
import { agentName } from "../../lib/agents.ts";
import { getJSON, loader, post } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import { allRows, getApp, takeRows, threadRow } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, GroupView, Thread, Visibility } from "../../lib/types.ts";
import { wipItemOf } from "../worktrees/ship.ts";
import { allWips, wipById, wipPutIn, wipWsName } from "../worktrees/wips.ts";
import { levelOf } from "../../../plugin/shared/visibility.ts";
import type { Wip } from "../worktrees/wips.ts";

export const groupById = (id: string | null | undefined): GroupRow | undefined => (getApp().data?.groups || []).find((g) => g.id === id);
export const groupMine = (g: GroupRow | null | undefined) => g?.mine !== false;
// You're in it: yours, or someone else's that its owner put you in. Then you see all
// of it, every thread in it, and add your own threads and agents, notes, files and its brief; the rest is its owner's.
export const groupIn = (g: (GroupRow & { in?: boolean }) | null | undefined) => groupMine(g) || !!g?.in;
// The people in it besides its owner, by username.
export const groupPeople = (g: GroupRow | null | undefined) => (g?.members || []).filter((m) => m.user).map((m) => m.user);
export const groupPublic = (g: GroupRow | null | undefined) => levelOf(g?.visibility) === "public";
// A group's threads: its open ones (the chrome's rows) and, once its own answer is in, the archived ones too.
export const groupThreads = (g: { id: string }, rows: Thread[] = allRows()) => rows.filter((s) => s.group === g.id);
// Who did something in a group, in words: a thread (by its name), a person, or this machine.
export function groupBy(by: By | null | undefined): string {
  if (!by) return "someone";
  if (by.post) return threadRow(by.post)?.label || agentName(by.agent) || "a thread";
  if (by.user) return by.user === getApp().me?.username ? "you" : `@${by.user}`;
  if (by.machine) return `something on ${by.machine}`;
  return agentName(by.agent) || "someone";
}
export const fileBase = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const fileDir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const fileUrl = (g: { id: string }, p: string, v: string | number | null = null, download = false) => `/api/groups/${encodeURIComponent(g.id)}/file?${new URLSearchParams({ path: p, ...(v ? { v: String(v) } : {}), ...(download ? { download: "1" } : {}) })}`;
export const isImage = (n: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);
export const isMarkdown = (name: string) => /\.(md|markdown|mdx)$/i.test(name);
// When exactly, for a title: "Today, 10:30", else the day and time.
export const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `Today, ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};
export const GROUP_FILTERS: [string, string][] = [["all", "All"], ["mine", "Yours"], ["shared", "Shared with you"], ["public", "Public"], ["archived", "Archived"]];
// Shared with you: someone else's that you're in; a contact's public one you only see
// is under Public.
export const inGroupFilter = (g: GroupRow & { in?: boolean }, f: string) => (f === "archived") === !!g.archived && (f === "all" || f === "archived" || (f === "mine" ? groupMine(g) : f === "shared" ? !groupMine(g) && !!g.in : levelOf(g.visibility) === f));
// When anything last happened in it: it changed, a file did, or one of its threads.
export const groupAt = (g: GroupRow, rows?: Thread[]) => [g.updated, g.last_file?.at, ...groupThreads(g, rows).map((s) => s.updated)].filter(Boolean).sort().at(-1) || "";

// What the group screens keep while you go between them: the new-group form (open, the thread it starts with, who
// sees it), which groups Groups shows, a group's files by folder or newest first, which groups show their tasks and
// WIP done, the person its owner is about to put in it (with what they'd see), and the open group as
// /api/groups/:id has it.
export interface GroupUi {
  groupNew: boolean;
  groupNewPost: string | null;
  groupNewVis: Visibility | null;
  groupsFilter: string;
  groupNewest: boolean;
  tasksDone: Record<string, boolean>;
  wipsDone: Record<string, boolean>;
  ask: { group: string; user: string; text: string } | null;
  group: GroupView | null;
}
export const useGroupUi = create<GroupUi>(() => ({ groupNew: false, groupNewPost: null, groupNewVis: null, groupsFilter: "all", groupNewest: false, tasksDone: {}, wipsDone: {}, ask: null, group: null }));
export const useGroupData = (id: string) => useGroupUi((s) => (s.group?.id === id ? s.group : null));

// The open group: it, its folder, files, notes and threads (whose rows join the page's).
export const loadGroup = loader(async () => {
  const r = getApp().route;
  if (r.name !== "group") return;
  const id = r.id;
  const d = await getJSON<GroupView>(`/api/groups/${encodeURIComponent(id)}`);
  const now = getApp().route;
  if (now.name !== "group" || now.id !== id) return;
  if (d) useGroupUi.setState({ group: d });
  takeRows(d?.threads);
});

// Its WIP: the branches and pull requests you put in it (`wips`, which a branch's id still finds once it's a pull
// request), and the ones its threads work on.
export function groupWips(g: GroupRow) {
  const list = allWips().filter((x) => wipPutIn(x)?.g.id === g.id || x.posts.some((s) => s.group === g.id));
  // One you put in it that isn't WIP anywhere now (its branch cleaned up, its pull request closed long ago).
  const gone = (g.wips || []).filter((w) => !wipById(w.id));
  return { list, gone };
}
// The ones to add: any not in it yet, open ones first, then newest first.
export function wipsToAdd(g: GroupRow) {
  const here = new Set(groupWips(g).list.map((x) => x.id));
  return allWips()
    .filter((x) => !here.has(x.id))
    .sort((a, b) => Number(a.state === "clear") - Number(b.state === "clear") || b.at.localeCompare(a.at));
}
export const wipWhere = (x: Wip) => [wipWsName(x), x.kind === "pr" ? `#${x.number}` : x.branch, wipPutIn(x) ? `in ${wipPutIn(x).g.name}` : ""].filter(Boolean).join(" · ");
// The page says what it is, for its threads to be told: the server can't work it out.
export async function groupWipPut(g: GroupRow, x: Wip) {
  const was = wipPutIn(x)?.g;
  const wip = wipItemOf(x);
  if ((await post(`/api/groups/${encodeURIComponent(g.id)}/wips`, { wip })).ok) toast(`In ${g.name}${was && was.id !== g.id ? `, out of ${was.name}` : ""}. Its threads hear about it with their next message.`);
}
// New group, from anywhere (a thread's Group card, a card's + menu, the composer): Groups with its form open, with
// that thread going in it, named as you typed in the menu's find box (`name`, the form's draft).
export function openNewGroup(post: string | null = null) {
  useGroupUi.setState({ groupNew: true, groupNewPost: post });
  if (getApp().route.name !== "groups") location.hash = "#/groups";
}
