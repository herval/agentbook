// Adding a workspace: a repo, found by itself on every machine, or a folder on one, picked by looking through the
// machine's folders (it lists them itself), or from where your agents already worked. What's here is what its page
// (#/workspaces/new) and its box (AddWsDialog, from a composer's picker or your profile) share: which box is open,
// the folder being looked through, your repos on GitHub, and adding one.
import { create } from "zustand";
import { loader, post } from "../../lib/api.ts";
import { machineInfo, machineOf, many, repoName, tildeOn, workspaces } from "../../lib/agents.ts";
import { setDraft } from "../../lib/hooks.ts";
import { go, workspaceHref } from "../../lib/route.ts";
import { signedOut } from "../../lib/session.ts";
import { getApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { FolderListing, FolderRow, GhRepo, GhRepos } from "../../lib/types.ts";

export type AddWsTab = "repo" | "folder" | "cloud";
// The box: the task it was opened for, its tab, and what the composer that opened it does with what's added.
export interface AddWsBox {
  id: symbol;
  task: string | null;
  tab: AddWsTab;
  targetMachine?: string;
  onAdded?: (id: string) => void;
}
// A machine's folder being looked through, as it listed it (or why it couldn't), offline as of when.
export type Browse = { machine: string | null; path: string | null; data: (FolderListing & { offline?: boolean; as_of?: string }) | null; error: string | null };
interface AddWs {
  box: AddWsBox | null;
  browse: Browse;
  gh: { data: GhRepos | null; error: string | null } | null;
}
export const useAddWs = create<AddWs>(() => ({ box: null, browse: { machine: null, path: null, data: null, error: null }, gh: null }));
const S = () => useAddWs.getState();

const addWsShown = () => location.hash.startsWith("#/workspaces/new") || !!S().box;

// The machines whose folders can be looked through: your own, while they're on.
export const browsable = () => (getApp().data?.machines || []).filter((m) => m.home && m.online !== false);
export const browseMachine = (b: Browse = S().browse) => b.machine || getApp().data?.machine || "";

// The box, from a composer's picker or your profile: over the page you're on, which you stay on, so what you were
// writing stays. From a composer, what you add is picked there (`onAdded`), and it looks through the folders on the
// machine of the agent picked there (`machine`), as a folder elsewhere isn't one that agent can use. A tab each, or
// the folders are a long way under your repos.
export function openAddWs({ task = null, machine = null, targetMachine, onAdded }: { task?: string | null; machine?: string | null; targetMachine?: string; onAdded?: (id: string) => void } = {}) {
  useAddWs.setState({ box: { id: Symbol(), task, tab: "repo", targetMachine, onAdded } });
  if (!targetMachine) {
    const available = browsable();
    const preferred = available.find((m) => m.name === machine) || available.find((m) => m.name === browseMachine()) || available[0];
    if (preferred && preferred.name !== browseMachine()) browseTo(preferred.name, null);
    else loadFolders();
  }
  if (getApp().data?.github) loadGhRepos();
}
export function closeAddWs() {
  if (!S().box) return;
  useAddWs.setState({ box: null });
  setDraft("ws-repo", "");
}
export const addWsTab = (tab: AddWsTab) => useAddWs.setState((s) => ({ box: s.box && { ...s.box, tab } }));

// Your repos on GitHub, read as you, for the list of repos to add.
let ghReposAgain = false;
export const loadGhRepos = loader(async () => {
  if (!getApp().data?.github) return;
  useAddWs.setState((s) => ({ gh: { data: s.gh?.data || null, error: null } }));
  const res = await fetch(`/api/github/repos${ghReposAgain ? "?again=1" : ""}`);
  ghReposAgain = false;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return signedOut();
  useAddWs.setState((s) => ({ gh: res.ok ? { data, error: null } : { data: s.gh?.data || null, error: data.error || `Something went wrong (HTTP ${res.status})` } }));
});
// Back on this tab with that list showing: you may be back from GitHub, having installed agentbook's GitHub App or
// given it more repos, so the list is read again, from GitHub and not from what the server kept.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !addWsShown() || !getApp().data?.github) return;
  ghReposAgain = true;
  loadGhRepos();
});

// A machine's folders, one level at a time, as the machine lists it. Only your own machines.
export const loadFolders = loader(async () => {
  const b = S().browse;
  const machine = browseMachine(b);
  const at = b.path;
  const res = await fetch(`/api/folders?machine=${encodeURIComponent(machine)}${at ? `&path=${encodeURIComponent(at)}` : ""}`);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return signedOut();
  const now = S().browse;
  if (browseMachine(now) !== machine || now.path !== at) return;
  useAddWs.setState({ browse: { ...now, ...(res.ok ? { data, error: null } : { data: null, error: data.error || `Something went wrong (HTTP ${res.status})` }) } });
});
export function browseTo(machine: string, at: string | null) {
  useAddWs.setState({ browse: { machine, path: at || null, data: null, error: null } });
  loadFolders();
}

export const keptFolder = (f: FolderRow) => workspaces().some((w) => (f.remote && w.repo === f.remote) || w.checkouts.some((c) => c.machine === machineOf(f) && c.root === f.root));

// A repo you can add: where it's checked out, how many threads ran there, and what GitHub says of it.
export interface RepoHit {
  repo: string;
  url?: string;
  machines: Set<string>;
  sessions: number;
  last: string;
  gh?: GhRepo;
}
// The repos you can add, in one list: the ones checked out on your machines, and with GitHub connected, every
// one you have there, the latest worked on (a thread there, or a push) first. What's typed in the repo box
// narrows it (`typed`). Not the ones you have already.
export function addRepoList(typed: string, gh: AddWs["gh"], machine?: string) {
  const data = getApp().data;
  const have = workspaces().filter((w) => !machine || w.checkouts.some((c) => c.machine === machine) || w.cloning.some((c) => c.machine === machine && !c.error));
  const keptRepos = new Set(have.map((w) => w.repo).filter(Boolean));
  const repos = new Map<string, RepoHit>();
  const keptHere = new Set<string>(); // repos whose checkout is a folder workspace of yours
  for (const f of data?.folders || []) {
    if (!f.remote || keptRepos.has(f.remote)) continue;
    if ((!machine || machine === machineOf(f)) && keptFolder(f)) {
      keptHere.add(f.remote);
      continue;
    }
    const r = repos.get(f.remote) || { repo: f.remote, url: f.url, machines: new Set<string>(), sessions: 0, last: "" };
    r.machines.add(machineOf(f));
    r.sessions += f.sessions || 0;
    if ((f.last || "") > r.last) r.last = f.last;
    repos.set(f.remote, r);
  }
  if (machine) {
    for (const w of workspaces()) {
      if (!w.repo || keptRepos.has(w.repo) || keptHere.has(w.repo) || repos.has(w.repo)) continue;
      repos.set(w.repo, { repo: w.repo, url: w.url || undefined, machines: new Set(), sessions: 0, last: w.used });
    }
  }
  for (const g of (data?.github && gh?.data?.repos) || []) {
    if (keptRepos.has(g.repo) || (keptHere.has(g.repo) && !repos.has(g.repo))) continue;
    const r = repos.get(g.repo) || { repo: g.repo, machines: new Set<string>(), sessions: 0, last: "" };
    r.gh = g;
    if ((g.pushed || "") > r.last) r.last = g.pushed;
    repos.set(g.repo, r);
  }
  const q = typed
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/|git@)?(www\.)?github\.com[/:]/, "")
    .replace(/\.git$/, "");
  const all = [...repos.values()].sort((a, b) => b.last.localeCompare(a.last) || b.sessions - a.sessions);
  return { q, hits: q ? all.filter((r) => repoName(r.repo).includes(q)) : all };
}

// Where adding a repo nobody has checked out clones it: the page's machine's clone folder.
export function cloneHereNote(here = getApp().data?.machine || "") {
  const dir = machineInfo(here).clone_dir;
  const where = dir ? `into ${tildeOn(here, dir)}` : "";
  return [where, many() && here ? `on ${here}` : ""].filter(Boolean).join(" ") || "here";
}

// Add a workspace, then open its page, or from its box, stay where you are with it picked (the composer that opened
// it picks it). Says whether it did.
export async function addWorkspace(body: { repo?: string; url?: string; folder?: { machine: string; path: string } }, machine?: string): Promise<boolean> {
  const origin = S().box;
  const url = machine ? `/api/workspaces?machine=${encodeURIComponent(machine)}` : "/api/workspaces";
  const r = await post<{ existing?: boolean; cloning?: string; waiting?: string }>(url, body);
  if (!r.ok) return false;
  // The page learns about it with the next state, a moment later: wait for it, so the feed can show it.
  const find = () => (getApp().data?.workspaces || []).find((x) => x.id === r.data.id);
  for (let i = 0; i < 40 && !find(); i++) await new Promise((ok) => setTimeout(ok, 50));
  const name = find()?.name || "it";
  const here = machine || getApp().data?.machine || "";
  const cloning = r.data.waiting ? ` Clone queued on ${r.data.waiting}.` : r.data.cloning ? ` Cloning it into ${tildeOn(here, r.data.cloning)}.` : "";
  if (origin && S().box?.id === origin.id) {
    origin.onAdded?.(r.data.id);
    closeAddWs();
  }
  toast(r.data.existing ? `You have ${name} already.${cloning}` : `Added ${name}.${cloning || (origin ? "" : " Its threads show here.")}`);
  if (!origin) {
    setDraft("ws-repo", "");
    go(workspaceHref(r.data.id));
  }
  return true;
}

// Your repos on GitHub, read when they aren't yet (Add a workspace shows them).
export const wantGhRepos = () => {
  if (getApp().data?.github && !S().gh) void loadGhRepos();
};
// The folder being looked through, read when it isn't yet.
export const wantFolders = () => {
  const b = S().browse;
  if (!b.data && !b.error) void loadFolders();
};
