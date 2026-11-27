// Every branch and pull request the page knows of (app.ts's "WIP", "every pull request and branch, by where it is" and
// "a branch's pull request"): each project's branches from git (the folders' `wip`, from q/side), each workspace on
// GitHub's pull requests, a branch with a pull request as that pull request, where each stands in a word, and what
// starts work on one. Worked out once per state of the chrome (its data, and the thread rows it names).
import { agentName, DEFAULT_KIND, machineInfo, machineOf, many, onGitHub, startable, tildeOn, waits, workspaces } from "../../lib/agents.ts";
import { post, type Reply } from "../../lib/api.ts";
import { ago, plural } from "../../lib/format.ts";
import { agentOf, getApp, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { create } from "zustand";
import type { AgentRow, ChangedFile, Commit, GhPull, Thread } from "../../lib/types.ts";
import type { PrCard } from "../../../plugin/shared/types.ts";

export const sessionById = (id: string | null | undefined): Thread | undefined => threadRow(id);

// Where a branch left its base, and its base's latest commit (git's, or GitHub's for a pull request).
export interface Fork {
  sha: string;
  at?: string | null;
  subject?: string;
  behind?: number | null;
}
// A pull request as a workspace lists it, with what its card says (server/integrations/pulls.ts).
export type WipPr = GhPull & Partial<Omit<PrCard, keyof GhPull>> & { created?: string; fork?: Fork | null; base_head?: Fork | null };
// A workspace as workspaces() has it: with its checkouts on every machine.
export type Ws = ReturnType<typeof workspaces>[number];
// A branch or a pull request: a project's branch from git (`kind` "branch"), or a workspace's pull request (`kind`
// "pr", with its branch where a machine has it, `local`); or one of a task shared with you, as its owner's page has
// it (`shared`). `posts`: the threads on it; `state`: needs, live, fail, ready, dirty, open, draft or clear.
export interface Wip {
  id: string;
  rid?: string;
  kind: "branch" | "pr";
  posts: Thread[];
  state: string;
  stale?: boolean;
  at: string;
  title: string;
  repo: string;
  branch: string;
  base?: string;
  machine?: string;
  root?: string;
  // A branch's, from git.
  tip?: string;
  subject?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  commits?: number;
  worktree?: string | null;
  place?: string;
  here?: boolean;
  sha?: string | null;
  worked?: boolean;
  fork?: Fork | null;
  base_head?: Fork | null;
  // A pull request's.
  ws?: Ws | null;
  pr?: WipPr;
  number?: number;
  local?: Wip[];
  me?: string | null;
  // One of a task (or someone's workspace) shared with you: only to read.
  shared?: boolean;
  work?: boolean;
  task?: string;
  via?: string;
  part?: string;
  gone?: boolean;
}

// What the chrome has now: data and the thread rows, the key every memo below is kept by.
const now = () => {
  const s = getApp();
  return [s.data, s.rows, s.more] as const;
};
function memo<T>(fn: () => T): () => T {
  let key: readonly unknown[] = [];
  let val: T;
  return () => {
    const k = now();
    if (k.length !== key.length || k.some((x, i) => x !== key[i])) {
      key = k;
      val = fn();
    }
    return val;
  };
}
function memoBy<T>(fn: (id: string) => T): (id: string) => T {
  let key: readonly unknown[] = [];
  let map = new Map<string, T>();
  return (id) => {
    const k = now();
    if (k.some((x, i) => x !== key[i])) {
      key = k;
      map = new Map();
    }
    if (!map.has(id)) map.set(id, fn(id));
    return map.get(id);
  };
}
// Something the chrome doesn't hold changed (someone's workspace, read by its link): what reads it draws again.
const useBump = create<{ n: number }>(() => ({ n: 0 }));
export const bump = () => useBump.setState((s) => ({ n: s.n + 1 }));
// The chrome, for a component: it draws again when the chrome or its thread rows change.
export function useWorld() {
  const data = useApp((s) => s.data);
  useApp((s) => s.rows);
  useApp((s) => s.more);
  useBump((s) => s.n);
  return data;
}

// Every project's WIP, from the folders sessions ran in (the server reads them from git): each with its machine,
// the posts that worked on its branch (newest first), a title (its latest post's, else its last commit's subject,
// else the branch), what state it's in, and when it last changed (`at`, its posts too) and was last committed to
// (`tip`).
export const wips = memo((): Wip[] => {
  const list: Wip[] = [];
  for (const f of getApp().data?.folders || []) {
    const machine = machineOf(f);
    for (const w of (f.wip || []) as (Partial<Wip> & { posts?: unknown[] })[]) {
      const posts = ((w.posts || []) as string[]).map(sessionById).filter(Boolean);
      const at = [w.at, ...posts.map((s) => s.updated)].filter(Boolean).sort().at(-1) || "";
      const state = posts.some((s) => s.effective === "needs") ? "needs" : posts.some((s) => s.effective === "working") ? "live" : w.dirty ? "dirty" : w.ahead ? "open" : "clear";
      const stale = (state === "dirty" || state === "open") && Date.now() - Date.parse(at) > 86400e3;
      list.push({ ...(w as Wip), kind: "branch", machine, root: (w as Wip).root ?? f.root, repo: f.name, posts, at, tip: w.at, state, stale, title: posts.find((s) => s.title)?.title || w.subject || w.branch });
    }
  }
  const rank = { needs: 0, live: 1, dirty: 2, open: 2, clear: 3 };
  return list.sort((a, b) => rank[a.state] - rank[b.state] || b.at.localeCompare(a.at));
});
// A post's WIP: the pull request it worked on (its branch's, first), else its branch.
export function wipOfPost(s: Thread): Wip | null {
  const prs = prWips().filter((x) => x.posts.includes(s));
  return prs.find((x) => x.branch === s.branch) || prs[0] || (s.branch && s.root && wips().find((w) => w.machine === machineOf(s) && w.root === s.root && w.branch === s.branch)) || null;
}
export const wipHref = (w: Pick<Wip, "id" | "rid">) => `#/worktrees/${encodeURIComponent(w.rid || w.id)}`;
// A workspace's branches, from git; its WIP is those, each one that has a pull request as that (wipsIn).
export const branchesIn = (ws: Ws) => wips().filter((w) => ws.checkouts.some((c) => c.machine === w.machine && c.root === w.root));
// A WIP by its id. A branch's id still finds it once it has a pull request: its page turns into that one's.
export function wipById(id: string): Wip | null {
  const prs = prWips();
  return prs.find((x) => x.id === id) || prs.find((x) => x.local.some((l) => l.id === id)) || wips().find((x) => x.id === id) || (String(id).includes("~") ? sharedWipByRid(id) : null);
}
// A shared one by its page's id: the ship module finds it (one on a task shared with you, or someone's workspace).
let sharedFinder: (id: string) => Wip | null = () => null;
export const findSharedWith = (fn: (id: string) => Wip | null) => void (sharedFinder = fn);
export const sharedWipByRid = (id: string) => sharedFinder(id);
// What a WIP has that isn't on main, in a few characters: "14 ±" files not committed, "↑2" commits.
export const wipMeta = (w: Wip) => (w.state === "needs" ? "needs you" : w.state === "live" ? "live" : w.kind === "pr" ? [prMeta(w.pr, w.state), w.state === "dirty" ? `${w.dirty} ±` : ""].filter(Boolean).join(" ") : [w.dirty ? `${w.dirty} ±` : "", w.ahead ? `↑${w.ahead}` : "", w.stale ? ago(w.at) : ""].filter(Boolean).join(" "));
// Where a WIP stands, for a title: its branch, and what isn't on main.
export const wipWhy = (w: Wip) => (w.kind === "pr" ? prWhy(w.pr) : branchWhy(w));
const branchFacts = (w: Wip) => [w.dirty ? `${plural(w.dirty, "file")} not committed` : "", w.ahead ? `${plural(w.ahead, "commit")} not on ${w.base}` : "", w.behind ? `${w.behind} behind ${w.base}` : "", w.state === "clear" ? `nothing that isn't on ${w.base}` : ""].filter(Boolean).join(", ");
const branchWhy = (w: Wip) => [w.branch, branchFacts(w)].filter(Boolean).join(", ");

/* every pull request and branch, by where it is */

// A group of WIP: a workspace's (`ws`), or a project's that isn't one (on `machine`).
export interface WipGroup {
  key: string;
  ws?: Ws;
  name: string;
  machine?: string;
  list: Wip[];
}
// Every WIP you can see, by where it is: each workspace's (its branches, a branch with a pull request as that),
// then the projects that aren't a workspace. A project in two workspaces lists its WIP under the first.
export const wipGroups = memo((): WipGroup[] => {
  const seen = new Set<string>();
  const take = (list: Wip[]) => list.filter((x) => !seen.has(x.id) && seen.add(x.id));
  const groups: WipGroup[] = workspaces().map((ws) => ({ key: ws.id, ws, name: ws.name, list: take(wipsIn(ws)) }));
  const kept = new Set(workspaces().flatMap((w) => branchesIn(w).map((x) => x.id)));
  const loose = new Map<string, Wip[]>();
  for (const x of wips()) if (!kept.has(x.id) && !seen.has(x.id)) loose.set(`${x.machine}|${x.root}`, [...(loose.get(`${x.machine}|${x.root}`) || []), x]);
  for (const [key, list] of loose) groups.push({ key, name: list[0].repo, machine: list[0].machine, list: take(list) });
  return groups;
});
export const allWips = () => wipGroups().flatMap((g) => g.list);
// A WIP's workspace: the one the Worktrees page lists it under.
const wsOfWip = memo(() => new Map(wipGroups().flatMap((g) => g.list.map((y): [string, string | null] => [y.id, g.ws?.id ?? null]))));
export const wipWs = (x: Wip): string | null => wsOfWip().get(x.id) ?? null;
export const wipWsName = (x: Wip) => workspaces().find((w) => w.id === wipWs(x))?.name || x.repo;

// Where a WIP stands, in a word: what it asks of you first (a thread on it waits for you), then whether it's
// landed, what's in its way (a check failed, it conflicts, changes were asked for), whether it can merge, and else
// where it is (a draft, in review, a branch with no pull request). Who's working on it is its avatars, not this.
// A WIP of many's words too: one with nothing in it yet, one whose threads still work once all of it landed, and,
// for what's in one, one the page can't see (still reading git and GitHub, or not WIP anywhere now).
export const WIP_WORDS = { needs: ["Needs you", "hand"], stuck: ["Stuck", "x"], ready: ["Ready", "check"], review: ["In review", "eye"], draft: ["Draft", "pencil"], branch: ["On a branch", "branch"], merged: ["Merged", "merge"], landed: ["Landed", "check"], closed: ["Closed", "x"], working: ["Working", "play"], empty: ["Empty", "plus"], reading: ["Reading", "clock"], gone: ["Gone", "x"] } as const;
export const WIP_RANK: Record<string, number> = { needs: 0, stuck: 1, working: 1.5, ready: 2, review: 3, draft: 4, branch: 5, reading: 5, empty: 5, merged: 6, landed: 6, closed: 7, gone: 7 };
export interface WipSt {
  k: keyof typeof WIP_WORDS;
  why: string;
  tone: string;
  word: string;
  icon: string;
}
// What a thread on it waits for you on: "osprey wants to use Bash: terraform apply".
export const askOf = (s: Thread) => {
  const q = (getApp().data?.questions || []).find((y) => !y.answered && y.post === s.id);
  return !q ? "needs you" : q.kind === "permission" ? `wants to use ${q.tool_name || "a tool"}${q.preview ? `: ${q.preview.slice(0, 60)}` : ""}` : `asks: ${q.title}`;
};
function wipAsk(x: Wip) {
  const s = x.posts.find((p) => p.effective === "needs");
  return s ? `${s.label} ${askOf(s)}` : "";
}
export const st = (k: keyof typeof WIP_WORDS, why: string, tone = ""): WipSt => ({ k, why, tone, word: WIP_WORDS[k][0], icon: WIP_WORDS[k][1] });
const statusMemo = memoBy((id) => {
  const x = wipById(id) || sharedWipByRid(id);
  return x ? wipStatusOf(x) : null;
});
export const wipStatus = (x: Wip): WipSt => (x.shared ? wipStatusOf(x) : statusMemo(x.id) || wipStatusOf(x));
function wipStatusOf(x: Wip): WipSt {
  if (x.state === "needs") return st("needs", wipAsk(x));
  if (x.kind !== "pr") {
    if (x.state === "clear") return st("landed", `everything on it is on ${x.base}`);
    const ws = workspaces().find((w) => w.id === wipWs(x));
    return st("branch", [x.dirty ? `${plural(x.dirty, "file")} not committed` : "", x.ahead ? `${plural(x.ahead, "commit")} not on ${x.base}` : "", x.behind ? `${x.behind} behind ${x.base}` : "", onGitHub(ws) ? "no pull request" : ""].filter(Boolean).join(", "));
  }
  const p = x.pr;
  // Merged or closed is what GitHub says, as on its page; files left uncommitted in its worktree are a note on that.
  if (p.state === "merged" || p.state === "closed") return st(p.state, [p.state === "merged" ? `merged into ${p.base}` : "closed without merging", x.dirty ? `${plural(x.dirty, "file")} left uncommitted in its worktree` : ""].filter(Boolean).join(", "));
  const c = p.checks;
  const blocked = [c?.fail ? `${plural(c.fail, "check")} failing` : "", p.mergeable === "conflicts" ? `conflicts with ${p.base}` : "", p.review === "changes" ? "changes requested" : ""].filter(Boolean);
  if (blocked.length) return st("stuck", [...blocked, p.threads ? `${plural(p.threads, "thread")} unresolved` : ""].filter(Boolean).join(", "), "bad");
  if (x.state === "ready") return st("ready", [p.review === "approved" ? "approved" : "", c?.total ? "checks passed" : "", "nothing conflicts"].filter(Boolean).slice(0, 2).join(", "), "good");
  const waiting = [c?.pending ? `${plural(c.pending, "check")} running` : "", p.review === "required" ? "waiting for a review" : p.review === "approved" ? "approved" : "", p.merge_state === "behind" ? `${p.base} moved ahead of it` : "", p.threads ? `${plural(p.threads, "thread")} unresolved` : ""].filter(Boolean).join(", ");
  return p.state === "draft" ? st("draft", waiting || "not ready for a review yet") : st("review", waiting || "open");
}
export const wipOrder = (a: Wip, b: Wip) => WIP_RANK[wipStatus(a).k] - WIP_RANK[wipStatus(b).k] || b.at.localeCompare(a.at);

// Each: its key, its name, what it lets through, and what it says it is.
export const WIP_FILTERS: [string, string, (x: Wip) => boolean, string][] = [
  ["open", "Open", (x) => x.state !== "clear", "Everything with work that isn't on main yet"],
  ["needs", "Needs you", (x) => wipStatus(x).k === "needs", "A thread working on it is waiting for you"],
  ["stuck", "Stuck", (x) => wipStatus(x).k === "stuck", "A check failed, it conflicts, or changes were asked for"],
  ["ready", "Ready", (x) => wipStatus(x).k === "ready", "Pull requests that can merge"],
  ["review", "In review", (x) => ["review", "draft"].includes(wipStatus(x).k), "Pull requests waiting on their checks or a review, and drafts"],
  ["branch", "On a branch", (x) => wipStatus(x).k === "branch", "Work on a branch with no pull request"],
  ["live", "Live", (x) => x.state !== "clear" && x.posts.some((s) => s.effective === "working"), "A thread is working on it now"],
  ["clear", "Done", (x) => x.state === "clear", "Branches with nothing left to land, and pull requests merged or closed"],
];
// Which of your groups you put one in, by its id (a group's `wips`).
export function wipPutIn(x: Wip) {
  for (const g of getApp().data?.groups || []) for (const w of ((g as { wips?: { id: string }[] }).wips || [])) if ((wipById(w.id)?.id || w.id) === x.id) return { g, w };
  return null;
}
// How the filter bar reads the Worktrees page (app.ts's LENS.worktrees): its items, each one's agents, workspaces,
// pages and groups, and its statuses, the first being what it shows with none picked.
export const worktreesLens = {
  items: () => allWips(),
  of: { agent: (x: Wip) => x.posts.map((s) => s.agent), workspace: (x: Wip) => [wipWs(x)], page: (x: Wip) => x.posts.map((s) => s.page), group: (x: Wip) => [...x.posts.map((s) => s.group), wipPutIn(x)?.g.id] },
  keys: WIP_FILTERS.map(([k]) => k),
  states: () => WIP_FILTERS.map(([k, label]) => [k, label]),
  is: (x: Wip, f: string) => (WIP_FILTERS.find(([k]) => k === f) || WIP_FILTERS[0])[2](x),
};
// Under a workspace on GitHub: that its pull requests are being read, or why they can't be.
export const ghNote = (ws: Ws | null | undefined) => (!ws || !("pulls" in ws) ? "" : !ws.pulls ? "Reading GitHub…" : ws.pulls.error ? (ws.pulls.pulls.length ? "Can't reach GitHub right now" : ws.pulls.error) : "");


// A workspace's WIP is its branches, and a branch with a pull request on GitHub is that pull request: one WIP,
// shown with what GitHub has on it. The server reads a repo on GitHub's pull requests as you (yours: the ones you
// opened, the ones your posts linked, each branch your machines have's newest, and the ones merged or closed
// this week). Each is a WIP like a branch is: the posts that worked on its branch or linked it, its branch where
// a machine has it (`local`), and a state from its posts, from GitHub, and from what isn't committed there. A
// pull request whose branch no machine has is a WIP too; a branch with none is a branch, which can open one.
const inWsMemo = memoBy((id) => {
  const ws = workspaces().find((w) => w.id === id);
  return ws ? wipsOf(ws) : [];
});
export const wipsIn = (ws: Ws) => inWsMemo(ws.id);
// A merged or closed pull request is its branch's while nothing was committed on the branch since: after that,
// what's on the branch is new work, a branch of its own again. An open one is its branch's.
const prFits = (p: WipPr, w: Wip) => p.head === w.branch && ((p.state !== "merged" && p.state !== "closed") || !w.tip || !p.closed || Date.parse(w.tip) <= Date.parse(p.closed));
function wipsOf(ws: Ws): Wip[] {
  const branches = branchesIn(ws);
  const pulls = (ws.pulls?.pulls || []) as WipPr[];
  // Each branch's pull request: its newest, when that one fits it.
  const newest = new Map<string, WipPr>();
  for (const p of pulls) if (!newest.has(p.head) || p.created > newest.get(p.head).created) newest.set(p.head, p);
  const taken = new Set<string>();
  const list: Wip[] = [];
  for (const p of pulls) {
    const local = newest.get(p.head) === p ? branches.filter((w) => prFits(p, w)) : [];
    for (const w of local) taken.add(w.id);
    // Its posts: the ones that linked it, and the ones on its branch (once it's merged or closed and its branch
    // has new work, the ones from before).
    const linked = new Set(p.linked || []);
    const posts = [...new Set([...(p.linked || []), ...(p.on_branch || [])])]
      .map(sessionById)
      .filter((s) => s && (linked.has(s.id) || local.length || !p.closed || s.started <= p.closed))
      .sort((a, b) => b.started.localeCompare(a.started));
    const at = [p.updated, ...posts.map((s) => s.updated), ...local.map((w) => w.at)].filter(Boolean).sort().at(-1) || "";
    const dirty = local.reduce((n, w) => n + (w.dirty || 0), 0);
    const state = prState(p, posts, dirty);
    list.push({ kind: "pr", id: `${ws.id}-pr${p.number}`, ws, pr: p, number: p.number, branch: p.head, base: p.base, posts, local, dirty, at, state, stale: false, title: p.title, repo: ws.name, me: ws.pulls.login });
  }
  list.push(...branches.filter((w) => !taken.has(w.id)));
  const rank = { needs: 0, live: 1, fail: 2, ready: 2, dirty: 3, open: 3, draft: 4, clear: 5 };
  return list.sort((a, b) => rank[a.state] - rank[b.state] || b.at.localeCompare(a.at));
}
export const prWips = memo(() => workspaces().flatMap((ws) => wipsIn(ws).filter((x) => x.kind === "pr")));
// Where a pull request stands: its posts first (needs you, live), then GitHub: merged or closed (with nothing
// left uncommitted on its branch, `dirty` files), failing (a check failed, it conflicts, or changes were asked
// for), a draft, ready to merge, or open and waiting.
export function prState(p: Partial<WipPr>, posts: Thread[], dirty = 0) {
  if (posts.some((s) => s.effective === "needs")) return "needs";
  if (posts.some((s) => s.effective === "working")) return "live";
  if (p.state === "merged" || p.state === "closed") return dirty ? "dirty" : "clear";
  if (p.checks?.fail || p.mergeable === "conflicts" || p.review === "changes") return "fail";
  if (p.state === "draft") return "draft";
  if (p.merge_state === "clean" || (p.review === "approved" && p.mergeable === "yes" && !p.checks?.pending)) return "ready";
  return "open";
}
// The few characters the sidebar has for it.
export function prMeta(p: WipPr, state: string) {
  if (p.state === "merged" || p.state === "closed") return p.state;
  if (p.mergeable === "conflicts") return "conflicts";
  if (p.checks?.fail) return `${p.checks.fail} failing`;
  if (p.review === "changes") return "changes";
  if (state === "ready") return "ready";
  if (p.state === "draft") return "draft";
  return `#${p.number}`;
}
const REVIEW_TEXT = { approved: "approved", changes: "changes requested", required: "waiting for a review" };
export const checksText = (c: WipPr["checks"]) => (!c ? "" : c.fail ? `${plural(c.fail, "check")} failing` : c.pending ? `${plural(c.pending, "check")} running` : `checks passed`);
export const prWhy = (p: WipPr) => `#${p.number}, ${prFacts(p)}`;
const prFacts = (p: WipPr) => [`${p.head} into ${p.base}`, p.state === "open" ? "" : p.state, p.mergeable === "conflicts" ? `conflicts with ${p.base}` : "", p.state === "open" || p.state === "draft" ? checksText(p.checks) : "", REVIEW_TEXT[p.review] || "", p.threads ? `${plural(p.threads, "thread")} unresolved` : ""].filter(Boolean).join(", ");
export const ghName = (login: string | null | undefined, me: string | null | undefined) => (login && login === me ? "you" : `@${login}`);
// What a comment on GitHub says, as text: no HTML, its comments or its pictures.
export function ghText(body: string | null | undefined, max = 220) {
  const t = String(body || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
// And as markdown, its HTML taken out but its lines kept.
export const ghBody = (body: string | null | undefined) =>
  String(body || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(details|summary|p|div|sub|sup|span|picture|source|img)[^>]*>/gi, "")
    .trim();

// Its page reads it again when git (a branch's) or GitHub (a pull request's) says something moved.
export const gitKey = (w: Wip) => [w.ahead, w.commits, w.behind, w.dirty, w.subject].join("|");
export const prKey = (x: Wip) => {
  const p = x.pr;
  return [p.updated, p.sha, p.state, p.mergeable, p.merge_state, p.review, p.threads, p.comments, JSON.stringify(p.checks)].join("|");
};
// Where a WIP left its main branch, how far main moved since, and main's latest commit: from git for a branch, from
// GitHub for a pull request. A machine with an older agentbook doesn't say.
export const forkOf = (x: Wip) => (x.kind === "pr" ? x.pr.fork : x.fork) || null;
export const behindOf = (x: Wip) => (x.kind === "pr" ? x.pr.fork?.behind : x.behind) ?? null;
export const baseHeadOf = (x: Wip) => (x.kind === "pr" ? x.pr.base_head : x.base_head) || null;

// A branch's WIP that a card or a WIP row offers to delete: nothing left on it (every commit on main, nothing
// uncommitted), not the project's own folder, and no thread still going there (one asleep counts, unless it's
// archived: one you're done with), since its folder would go from under it. Its machine checks it all again.
export const wipCleanable = (w: Wip | null | undefined) => !!w && w.kind !== "pr" && !w.here && !w.ahead && !w.dirty && w.posts.every((x) => x.mine !== false && (x.state === "done" || (x.asleep && x.archived)));
// A thread's branch, from its own card: one it never had a commit on only once the thread's archived. Archiving
// deletes it by the same rule (archiveClean in main.ts), so the button is for what was still going or landed later.
export function cleanableBranch(s: Thread | null | undefined) {
  if (!s || s.mine === false || !s.root || !s.branch || (s.state !== "done" && !s.asleep)) return null;
  const w = wips().find((x) => x.machine === machineOf(s) && x.root === s.root && x.branch === s.branch);
  return wipCleanable(w) && (w.worked || s.archived) ? w : null;
}
export const dropLabel = (w: Wip) => (w.worktree ? "Delete worktree" : "Delete branch");
export const dropTitle = (w: Wip) => `Everything on ${w.branch} is on ${w.base}: removes ${w.worktree ? "its worktree and its branch" : "its branch"}`;
// WIP's Clean up, for the branch of the thread a button's on (its machine checks it all again).
export async function cleanBranch(w: Wip) {
  const r = await post<{ removed?: boolean }>(`/api/wip/clean?machine=${encodeURIComponent(w.machine)}`, { root: w.root, branch: w.branch });
  if (r.ok && r.data.queued) toast(waits(r.data, "it cleans it up"));
  else if (r.ok) toast(`Deleted ${w.branch}${r.data.removed ? ", and its worktree" : ""}.`);
  return r.ok;
}

// The prompts behind Open a pull request, Rebase from main and Land on main.
export const WIP_ASK: Record<string, (w: Wip) => string> = {
  pr: (w) => `Open a pull request for ${w.branch} into ${w.base}: commit what isn't committed, push the branch, and open it with gh pr create, with a title and a description that say what it changes and why. Tell me its link.`,
  rebase: (w) => `Rebase ${w.branch} onto ${w.base}, so it has everything ${w.base} has now. Commit what isn't committed first. Resolve conflicts keeping both sides' intent, run the tests, and tell me what you had to resolve.`,
  land: (w) => `Land ${w.branch} on ${w.base}: commit what isn't committed, rebase onto ${w.base}, run the tests, and get it onto ${w.base} the way this project does that. Tell me what landed.`,
};
// The prompts behind a pull request's buttons, here and on a thread's card (components/thread/Results.tsx): by its
// number, link, branch and base.
export interface PrAt {
  number: number;
  url: string;
  branch: string;
  base: string;
}
export const PR_ASK: Record<string, (x: PrAt) => string> = {
  checks: (x) => `Pull request #${x.number} (${x.url}) has failing checks. Find out why from their logs (gh pr checks ${x.number}, gh run view --log-failed), fix them on ${x.branch}, push, and tell me what was wrong.`,
  review: (x) => `Address the review on pull request #${x.number} (${x.url}): read its unresolved review threads and its comments, make the changes they ask for on ${x.branch}, push, and reply on each thread with what you did. Tell me what you changed, and anything you pushed back on and why.`,
  rebase: (x) => `Rebase pull request #${x.number} (${x.url}) from ${x.base}: rebase ${x.branch} onto ${x.base}, resolve conflicts keeping both sides' intent, run the tests, and push. Tell me what you had to resolve.`,
  merge: (x) => `Merge pull request #${x.number} (${x.url}) the way this repo merges (gh pr merge ${x.number}, with the method it uses). Tell me when it's merged.`,
};
export const prAt = (x: Wip): PrAt => ({ number: x.number, url: x.pr.url, branch: x.branch, base: x.base });
// Who a new post on a WIP goes to: the agent of its latest post, else this machine's Claude (DEFAULT_KIND).
export function wipAgent(w: { machine?: string; posts: Thread[] }): AgentRow | null {
  const ok = (a) => a && startable(a) && !a.offline && a.machine === w.machine && a.folders !== false;
  return ([agentOf(w.posts[0]?.agent), ...(getApp().data?.agents || []).filter((a) => a.kind === DEFAULT_KIND)] as AgentRow[]).find(ok) || null;
}
export type Launched = Reply & { agent?: string };
export async function wipLaunch(w: Wip, prompt: string, extra: { task?: string; agent?: string } = {}): Promise<Launched> {
  const a = wipAgent(w);
  if (!a) return toast(`No agent on ${w.machine} can start a thread here.`), { ok: false };
  const r = await post("/api/launch", { prompt, root: w.root, agent: a.id, machine: w.machine, ...(w.here ? {} : { worktree: true, branch: w.branch }), ...extra });
  if (r.ok) toast(`Started. ${agentName(extra.agent || a.id)} is on it, on ${w.branch}.`);
  return { ...r, agent: extra.agent || a.id };
}
// Where a new post on it works: the checkout its branch is in (the folder itself, or a worktree), else a
// checkout of the repo on a machine that's online, this one first, where it checks the branch out.
export function prPlace(x: Wip): { machine: string; root: string; here: boolean; branch: string; has: boolean } | null {
  const l = x.local.find((w) => machineInfo(w.machine).online !== false);
  if (l) return { machine: l.machine, root: l.root, here: l.here, branch: x.branch, has: true };
  const ok = x.ws.checkouts.filter((c) => machineInfo(c.machine).online !== false && (c.sessions || c.branch !== undefined));
  const c = ok.find((o) => o.machine === getApp().data?.machine) || ok[0];
  if (!c) return null;
  const has = c.branch === x.branch || (c.branches || []).some((b) => b.name === x.branch);
  return { machine: c.machine, root: c.root, here: c.branch === x.branch, branch: x.branch, has };
}
export async function prLaunch(x: Wip, prompt: string, extra: { task?: string; agent?: string } = {}): Promise<Launched> {
  const at = prPlace(x);
  if (!at) return toast(`No machine has a checkout of ${x.ws.name} to work in.`), { ok: false };
  const a = wipAgent({ machine: at.machine, posts: x.posts });
  if (!a) return toast(`No agent on ${at.machine} can start a thread here.`), { ok: false };
  const about = `This is about pull request #${x.number} (${x.pr.url}), on its branch ${x.branch}.${at.has ? "" : ` Check it out first: gh pr checkout ${x.number}.`}`;
  const r = await post("/api/launch", { prompt: `${about}\n\n${prompt}`, root: at.root, agent: a.id, machine: at.machine, ...(at.here ? {} : at.has ? { worktree: true, branch: at.branch } : { worktree: true }), ...extra });
  if (r.ok) toast(`Started. ${agentName(extra.agent || a.id)} is on it, on #${x.number}.`);
  return { ...r, agent: extra.agent || a.id };
}
// Ask the thread going on a WIP to do something, or start one that does: Fix the checks, Rebase, Land, Merge.
export async function askWip(w: Wip, prompt: string, extra: { task?: string } = {}): Promise<Launched | null> {
  const going = w.posts.find((s) => s.state !== "done" && s.mine !== false);
  if (going) {
    const r = await post(`/api/sessions/${encodeURIComponent(going.id)}/messages`, { text: prompt, files: [] });
    if (r.ok) toast(`Sent to ${going.label}.`);
    return null;
  }
  return w.kind === "pr" ? prLaunch(w, prompt, extra) : wipLaunch(w, prompt, extra);
}
export const tilde = (machine: string, p: string) => tildeOn(machine, p);
export { many };

// A branch's page as git read it (/api/wip): its commits, main's since it branched, and its files.
export interface BranchRead {
  merge_base?: string | null;
  behind?: number;
  commits?: (Commit & { landed?: boolean })[];
  main?: (Commit & { overlap: string[] })[];
  overlap?: string[];
  committed?: ChangedFile[];
  uncommitted?: ChangedFile[];
  checked_out?: boolean;
  offline?: boolean;
  as_of?: string;
}
