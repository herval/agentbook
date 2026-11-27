// The composer's logic (app.ts "composer: writing on an agent's wall starts a session", and "the composer: who can
// see it, and pulling from the cloud"): which agents can take a thread and where, the pages and groups it can go in,
// the model, effort and branch menus, what the composer keeps while it's on screen (the cloud box open, the branches
// asked of a machine, the boxes sending), and what the rest of the page does to its picks. Composer.tsx draws it.
import { create } from "zustand";
import { agentName, DEFAULT_KIND, hiddenAgent, kindCaps, machineInfo, repoName, seniority, startable, tildeOn } from "../../lib/agents.ts";
import type { Mode } from "../../../plugin/shared/runtimes.ts";
import { effortsOf } from "../../../plugin/shared/api.ts";
import { getJSON } from "../../lib/api.ts";
import { sendingDone, sendingStarted } from "../../lib/chrome.ts";
import { model, plural } from "../../lib/format.ts";
import { getDraft, setDraft } from "../../lib/hooks.ts";
import { agentOf, getApp, useApp } from "../../lib/store.ts";
import type { AgentRow, AgentSeen, BranchList, GroupRow, PageRow, Visibility } from "../../lib/types.ts";
import { groupIn } from "../groups/groups.ts";
import { writesPages } from "../pages/pages.ts";
import { useSendTask } from "../tasks/tasks.ts";
import { LEVELS } from "../Visibility.tsx";
import { wips } from "../worktrees/wips.ts";
import type { Wip, Ws } from "../worktrees/wips.ts";
import { useCompose } from "./compose.ts";

// A checkout of a workspace on one machine (workspaces()), and one with its branches as its machine listed them.
export type Checkout = Ws["checkouts"][number];
export type Project = Checkout & BranchList;
// A branch of a checkout's, as its machine lists it: with its worktree, if it has one.
type BranchRow = { name: string; at?: string; worktree?: string | boolean | null };

// What the composer keeps while it's on screen (the old S.cloudOpen, S.branchLists, S.sending): the "pull from cloud"
// box open; the branches of folders the state doesn't list them for, per "machine|folder" (fetched, false when they
// couldn't be, null while they're asked for); and the boxes sending now, by their draft key.
interface ComposeUi {
  cloudOpen: boolean;
  branchLists: Record<string, BranchList | false | null>;
  sending: Record<string, boolean>;
}
export const useComposeUi = create<ComposeUi>(() => ({ cloudOpen: false, branchLists: {}, sending: {} }));
export const setComposeUi = (p: Partial<ComposeUi>) => useComposeUi.setState(p);

// Start thread, and a reply's send, empty their box at once, ready for the next, and wait (Enter too) until the
// server has it, so pressing again doesn't send it twice. The page doesn't reload itself for newer code meanwhile.
export function sending(draft: string, on: boolean) {
  useComposeUi.setState((s) => ({ sending: { ...s.sending, [draft]: on } }));
  if (on) sendingStarted();
  else sendingDone();
}
// A thread that didn't start: its text goes back in its box, ahead of anything written there since.
export function putBack(draft: string, text: string) {
  setDraft(draft, [text, getDraft(draft).trim()].filter(Boolean).join("\n\n"));
}

// Pull from the cloud, from elsewhere (a followed cloud session's Teleport here): the composer's box for it, open,
// with its link in it. Its caller takes you to the feed, where the composer is.
export function openCloudPull(url?: string) {
  if (url != null) setDraft("cloud", url);
  setComposeUi({ cloudOpen: true });
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-cloud-url]")?.closest(".compose")?.scrollIntoView({ block: "center", behavior: "smooth" }));
}

const data = () => getApp().data;
export const bySeniority = (a: AgentSeen, b: AgentSeen) => seniority(a).localeCompare(seniority(b));
export const cloudOf = (machine: string | null | undefined) => (data()?.machines || []).find((m) => m.name === machine)?.cloud || null;
export const modelName = (agentId: string, m: string) => agentOf(agentId).models?.list?.find((x) => x.id === m)?.name || model(m);

// Who can write a page: agents that have agentbook's tools, on its machine. On someone else's page you keep, your own
// agents, wherever they are.
export const writesPage = (a: AgentSeen, p: PageRow | "new") => writesPages(a.kind) && (p === "new" || !p.machine || p.mine === false || (a.machine || data()?.machine) === p.machine);
// The pages a thread can go on from the composer, besides your feed: the ones you keep (yours, and the ones you
// contribute to) and follow, the latest changed first, each with why it can't take one now, if it can't (no agent on its machine that writes pages is
// online). On an agent's wall, the ones that agent can write.
export function postPages(agentId: string | undefined): { page: PageRow; why: string }[] {
  const agents = (data()?.agents || []).filter((a) => startable(a) && !hiddenAgent(a) && writesPages(a.kind) && (!agentId || a.id === agentId));
  if (!agents.length) return [];
  const at = (p: PageRow) => p.moved || p.updated;
  return (data()?.pages || [])
    .filter((p) => p.can_edit && p.followed && !p.archived)
    .sort((a, b) => at(b).localeCompare(at(a)))
    .map((p) => {
      const can = agents.filter((a) => writesPage(a, p));
      return { page: p, why: can.some((a) => !a.offline) ? "" : can.length ? `${can.length > 1 ? `Its agents are` : `${agentName(can[0].id)} is`} offline` : `No agent on ${p.machine} can write it` };
    });
}
// The groups a thread can go in from the composer: yours, and the ones you're in, not archived, the latest busy
// first. Not someone else's you only see because it's public.
export const postGroups = (): GroupRow[] => (data()?.groups || []).filter((g) => !g.archived && groupIn(g)).sort((a, b) => b.updated.localeCompare(a.updated));
// What the composer's "where it goes" says: "" your feed, a page's id, or a group's as "group:<id>".
export const pickedGroup = (pick: string | null | undefined): GroupRow | null => (String(pick || "").startsWith("group:") ? (data()?.groups || []).find((g) => g.id === pick.slice(6)) || null : null);

// A checkout with its branches: the state lists them for folders sessions ran in; for the others they're
// asked of its machine, once (wantBranches).
export function withBranches(c: Checkout, lists: ComposeUi["branchLists"]): Project {
  if (c.branches) return c;
  const got = lists[`${c.machine}|${c.root}`];
  return got ? { ...c, ...got } : c;
}
export function wantBranches(c: Pick<Checkout, "machine" | "root">) {
  const key = `${c.machine}|${c.root}`;
  if (key in useComposeUi.getState().branchLists) return;
  useComposeUi.setState((s) => ({ branchLists: { ...s.branchLists, [key]: null } }));
  getJSON<BranchList>(`/api/branches?root=${encodeURIComponent(c.root)}&machine=${encodeURIComponent(c.machine)}`).then((b) => useComposeUi.setState((s) => ({ branchLists: { ...s.branchLists, [key]: b || false } })));
}
// A repo the agent's machine has no checkout of: it's cloned there first, or the post waits for the clone
// adding it started. Its folder says "(clone)", and this when you point at it.
export function cloneTitle(w: Ws, machine: string) {
  const going = w.cloning?.find((c) => c.machine === machine && !c.error);
  const dir = machineInfo(machine).clone_dir;
  const to = going ? tildeOn(machine, going.dir) : dir ? tildeOn(machine, `${dir}/${w.repo.split("/").pop()}`) : null;
  return going ? `${machine} is cloning ${repoName(w.repo)} into ${to}, and the thread starts once it's there` : `${machine} has no checkout of ${repoName(w.repo)}, so it's cloned first${to ? `, into ${to}` : ""}`;
}

// What a branch's facts say (app.ts branchFacts): its uncommitted files, its commits not on its base, how far behind.
const branchFacts = (w: Wip) => [w.dirty ? `${plural(w.dirty, "file")} not committed` : "", w.ahead ? `${plural(w.ahead, "commit")} not on ${w.base}` : "", w.behind ? `${w.behind} behind ${w.base}` : "", w.state === "clear" ? `nothing that isn't on ${w.base}` : ""].filter(Boolean).join(", ");

// A pick in one of the composer's menus: what MenuPick shows (rows, its face's words), and what it's set to.
export interface LaunchItem {
  value: string;
  text: string;
  face: string;
  title: string;
  tree?: boolean;
  wip?: boolean;
}
// Where a new post works: in the project's folder, on the branch it's on; in a new worktree, on a new branch off
// that one; or on an existing branch, in its worktree (made if it has none, so the folder never switches out
// from under whoever's working there). The menu's value says which: "", "tree" or "in:<branch>" (git refuses
// ":" in a branch name). The existing branches with work that isn't on main yet (the sidebar's open WIP) come
// first, under WIP, and the rest below them.
export function launchBranch(p: Project, branchPick: Record<string, string>) {
  const here = p.branch || "this commit"; // no branch when the folder's on a detached commit
  const items: LaunchItem[] = [
    { value: "", text: `Current folder (${here})`, face: here, title: `Works on ${here}, in ${p.name}'s folder` },
    { value: "tree", text: "New worktree", face: "New worktree", tree: true, title: `A worktree of its own (.claude/worktrees), on a new branch off ${here} named after what it's doing` },
  ];
  const open = new Map(wips().filter((w) => w.machine === p.machine && w.root === p.root && w.state !== "clear").map((w) => [w.branch, w]));
  const existing: LaunchItem[] = ((p.branches || []) as BranchRow[]).map((b) => {
    const w = open.get(b.name);
    const facts = w && branchFacts(w);
    return { value: `in:${b.name}`, text: b.name, face: b.name, tree: true, wip: !!w, title: `Works on ${b.name}, in ${b.worktree ? "its worktree" : "a worktree of its own"}${facts ? `: ${facts}` : ""}` };
  });
  const wip = existing.filter((i) => i.wip);
  const rest = existing.filter((i) => !i.wip);
  const pick = [...items, ...existing].find((i) => i.value === (branchPick[p.root] || "")) || items[0];
  return { items, wip, rest, pick };
}
// What a branch pick asks the server for.
export function branchRequest(value: string): { worktree?: boolean; branch?: string } {
  if (value === "tree") return { worktree: true };
  if (value.startsWith("in:")) return { worktree: true, branch: value.slice(3) };
  return {};
}

// The models in an agent's picker (Claude Code's aliases, Codex's models), in its order, its default marked.
// A default the picker doesn't list (a full model id in your settings) goes first. `pick`: "" for its default.
export function launchModel(agentId: string, modelPick: Record<string, string>) {
  const m = agentOf(agentId).models;
  if (!m?.list?.length) return null;
  const pick = m.list.some((x) => x.id === modelPick[agentId] && x.id !== m.default) ? modelPick[agentId] : "";
  const def = m.default ? modelName(agentId, m.default) : "Default model";
  const listed = m.list.some((x) => x.id === m.default);
  const rows = [...(listed ? [] : [{ value: "", text: def, note: m.default ? "default" : "", on: !pick }]), ...m.list.map((x) => (x.id === m.default ? { value: "", text: x.name, note: "default", on: !pick } : { value: x.id, text: x.name, on: x.id === pick }))];
  return { pick, shown: pick ? modelName(agentId, pick) : def, rows };
}

// How hard the model thinks: the levels the picked model takes, low to high, its default marked.
const EFFORT: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const effortName = (e: string) => EFFORT[e] || `${e[0].toUpperCase()}${e.slice(1)}`;
export function launchEffort(agentId: string, modelPick: Record<string, string>, effortPick: Record<string, string>) {
  const m = agentOf(agentId).models;
  const id = (m?.list || []).some((x) => x.id === modelPick[agentId]) ? modelPick[agentId] : m?.default;
  const { efforts, effort: def } = effortsOf(m, id);
  if (!efforts.length) return null;
  const pick = efforts.includes(effortPick[agentId]) && effortPick[agentId] !== def ? effortPick[agentId] : "";
  const listed = efforts.includes(def);
  const rows = [...(listed ? [] : [{ value: "", text: "Default", on: !pick }]), ...efforts.map((e) => (e === def ? { value: "", text: effortName(e), note: "default", on: !pick } : { value: e, text: effortName(e), on: e === pick }))];
  const at = efforts.indexOf(pick || def || "");
  return { pick, shown: (pick ? effortName(pick) : def ? effortName(def) : "Default effort").toLowerCase(), rows, levels: efforts.length, at };
}

// How much the thread may do without asking: the same four names for every agent (shared/runtimes.ts's modes), those
// its agent offers, Auto unless you picked another for it, Full access included, and its chip says it never asks.
export const MODE_ROWS: Record<Mode, { text: string; note: string }> = {
  ask: { text: "Ask", note: "asks before commands and edits" },
  auto: { text: "Auto", note: "asks only when it's risky" },
  plan: { text: "Plan", note: "reads and plans, changes nothing" },
  full: { text: "Full access", note: "never asks" },
};
export const modeName = (m: Mode) => MODE_ROWS[m]?.text || m;
export function launchMode(agentId: string, modePick: Record<string, string>) {
  const a = agentOf(agentId);
  const modes = kindCaps(a.kind || DEFAULT_KIND)?.modes || [];
  if (!modes.length) return null;
  const def: Mode = modes.includes("auto") ? "auto" : modes[0];
  const pick: Mode = modes.find((x) => x === modePick[agentId]) || def;
  const rows = modes.map((x) => ({ value: x, text: MODE_ROWS[x].text, note: x === def ? `default · ${MODE_ROWS[x].note}` : MODE_ROWS[x].note, on: x === pick }));
  return { pick, def, full: pick === "full", shown: MODE_ROWS[pick].text, rows };
}

// Who can see the new post: a lock (private) or a globe (public), a menu on the icon. It starts as its agent. A private
// agent's public post shows your contacts the post, not which agent wrote it.
export const launchVis = (agentId: string, visPick: Record<string, string>): Visibility => (LEVELS.includes(visPick[agentId] as Visibility) ? (visPick[agentId] as Visibility) : agentOf(agentId).visibility === "public" ? "public" : "private");
// What goes to the server: only a choice that differs from the agent's own setting sticks to the post; otherwise it
// follows its agent.
export const visToSend = (agentId: string, vis: string) => (vis && vis !== (agentOf(agentId).visibility === "public" ? "public" : "private") ? vis : undefined);

// Pull from the cloud: a claude.ai/code session to teleport into the project below, or a Codex Cloud task to
// bring in. Its one line of help says what happens to the link pasted.
export const cloudKind = (ref: string) => (/task_[a-z]_[0-9a-z]+/i.test(ref) ? "codex" : /(session|cse)_[A-Za-z0-9]+/.test(ref) ? "claude" : "");

// Sending a task to an agent (tasks.ts sendTask) picks its workspace and its agent in the composer, as the old
// sendTask set S.wsPick and S.agentPick: kept once a thread starts with them.
useSendTask.subscribe((s) => {
  if (s.wsPick == null && s.agentPick == null) return;
  useCompose.setState({ ...(s.wsPick != null ? { wsPick: s.wsPick } : {}), ...(s.agentPick != null ? { agentPick: s.agentPick } : {}) });
  useSendTask.setState({ wsPick: null, agentPick: null });
});
// A workspace's page starts its threads in it (the old route change's S.wsPick = S.route.id).
let seenRoute = getApp().route;
if (seenRoute.name === "workspace" && seenRoute.id) useCompose.setState({ wsPick: seenRoute.id });
useApp.subscribe((s) => {
  if (s.route === seenRoute) return;
  const was = seenRoute;
  seenRoute = s.route;
  if (s.route.name === "workspace" && s.route.id && (was.name !== "workspace" || was.id !== s.route.id)) useCompose.setState({ wsPick: s.route.id });
});

// The agents a composer can start a thread with: yours, not hidden, online or on a machine that's off (it starts
// when it's back), the senior first.
export const composeAgents = (): AgentRow[] => (data()?.agents || []).filter((a) => startable(a) && (!a.offline || a.machine_off) && !hiddenAgent(a)).sort(bySeniority);
