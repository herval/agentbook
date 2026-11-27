// A GitHub repo's pull requests, for its workspace's WIP: a branch with a pull request is that pull request there.
// They come from GitHub's API, not from a checkout: a pull request is there whichever machine has its branch, or
// none. A repo's pull requests are yours: the open ones you opened, the ones your posts opened or worked on, the
// one on each branch your machines have, and the ones merged or closed in the last week (they fold away, like a
// branch with nothing left to land).
//
// GitHub is read as someone, with their token: their GitHub connector's (connectors/github.ts), and nothing else.
// Nothing here needs gh, nor any sign-in this machine has: someone who hasn't connected GitHub has no pull requests.

import crypto from "node:crypto";
import { capped, parseUnified, sizeOf } from "../../plugin/shared/diff.ts";
import { githubRepo } from "../../plugin/shared/prs.ts";
import type { Iso, PrCard, PrChecks, PrLineKind, PrReview, PrState } from "../../plugin/shared/types.ts";

export { githubRepo, HOW, notePrs, prOfUrl, prsInShell, prUrl, pullNumbers, strongest } from "../../plugin/shared/prs.ts";

const API = () => (process.env.AGENTBOOK_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const DONE_DAYS = 7;

// Who a read is as, to keep what it found apart from other people's: a token's fingerprint.
export const asWho = (token: string | null | undefined) => `t:${crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16)}`;
export const NO_TOKEN = "Pull requests come from GitHub, read as you: connect GitHub on Connectors (from the Tasks page) to see them here.";

// Who GitHub is read as (their `token`), and where from, for what an error says (`host`).
export interface GithubAs {
  token?: string | null;
  host?: string;
}
interface ApiOptions extends GithubAs {
  method?: string;
  body?: unknown;
  accept?: string;
}
// What a GraphQL answer has: its data, and what went wrong.
interface GraphqlReply<T> {
  data?: T | null;
  errors?: { message?: string; type?: string }[];
}

// A call to GitHub's API as someone, with their `token`. The response, or it throws saying what's wrong in words
// (with a `status`).
async function api(pathname: string, { token, method = "GET", body, accept = "application/vnd.github+json", host = "this machine" }: ApiOptions = {}): Promise<Response> {
  if (!token) throw Object.assign(new Error(NO_TOKEN), { status: 401, code: "no-github" });
  let res: Response;
  try {
    res = await fetch(API() + pathname, { method, headers: { accept, authorization: `Bearer ${token}`, "user-agent": "agentbook", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw Object.assign(new Error(`Can't reach GitHub from ${host} (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`), { status: 502 });
  }
  if (res.ok) return res;
  const out = (await res.json().catch(() => ({}))) as { message?: string };
  if (res.status === 401) throw Object.assign(new Error("GitHub turned the token down: sign in with GitHub again, or paste a new token, on Connectors."), { status: 401 });
  if (res.status === 429 || (res.status === 403 && /rate limit/i.test(out.message || ""))) throw Object.assign(new Error("GitHub says agentbook asked too often. It tries again later."), { status: 429 });
  throw Object.assign(new Error(out.message ? `GitHub said: ${out.message}` : `GitHub answered HTTP ${res.status}.`), { status: res.status === 404 ? 404 : 502 });
}

// A repo GitHub says isn't there: it may be, but out of the account's (or agentbook's GitHub App's) sight. Code
// "unseen", for main.ts to say which of the two (seeWhy).
const unseen = (text: string) => Object.assign(new Error(text), { status: 404, code: "unseen" });

// A GraphQL query, as someone (their `token`): its data. An answer with some errors (a pull request that's gone)
// still has the rest of its data.
export async function graphql<T>(query: string, vars: Record<string, unknown>, { host, token }: GithubAs = {}): Promise<T | null | undefined> {
  const out = (await (await api("/graphql", { token, method: "POST", body: { query, variables: vars }, host })).json()) as GraphqlReply<T>;
  if (out.errors?.length && !out.data) {
    const msg = out.errors[0].message || "GitHub refused the query.";
    throw /Could not resolve to a Repository/i.test(msg) ? unseen("GitHub has no such repo, or your GitHub account can't see it.") : new Error(msg);
  }
  return out.data;
}

/* ---------- what a pull request is, in agentbook's words ---------- */

// A pull request as GitHub's GraphQL API says it, with the fields the queries below ask for (each asks for some).
interface GhActor {
  __typename?: string;
  login?: string;
  name?: string;
}
interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  description?: string | null;
  startedAt?: Iso | null;
  completedAt?: Iso | null;
  createdAt?: Iso | null;
  isRequired?: boolean;
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null;
}
interface GhCount {
  state: string;
  count: number;
}
interface GhRollup {
  state?: string;
  contexts?: { nodes?: GhCheck[]; checkRunCountsByState?: GhCount[]; statusContextCountsByState?: GhCount[] } | null;
}
interface GhComment {
  id: string;
  databaseId?: number | null;
  author?: GhActor | null;
  body?: string;
  createdAt: Iso;
  url: string;
}
interface GhReview {
  id?: string;
  author?: GhActor | null;
  state: string;
  body?: string;
  submittedAt?: Iso | null;
  url?: string;
}
interface GhThread {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  viewerCanReply?: boolean;
  viewerCanResolve?: boolean;
  viewerCanUnresolve?: boolean;
  hunk?: { nodes?: { diffHunk?: string }[] };
  comments?: { nodes?: GhComment[] };
}
interface GhPull {
  id?: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  createdAt: Iso;
  updatedAt: Iso;
  closedAt?: Iso | null;
  mergedAt?: Iso | null;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  author?: GhActor | null;
  body?: string | null;
  comments?: { totalCount: number };
  commits?: { totalCount: number };
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  reviewThreads?: { nodes?: { isResolved: boolean }[] };
  baseRef?: { target?: { oid?: string; committedDate?: Iso; messageHeadline?: string } | null } | null;
  checks?: { nodes?: { commit?: { statusCheckRollup?: GhRollup | null } }[] };
  mergedBy?: GhActor | null;
  labels?: { nodes?: { name: string; color: string }[] };
  assignees?: { nodes?: GhActor[] };
  reviewRequests?: { nodes?: { requestedReviewer?: GhActor | null }[] };
  latestOpinionatedReviews?: { nodes?: GhReview[] };
  log?: { nodes?: { commit: { oid: string; abbreviatedOid: string; messageHeadline: string; committedDate: Iso; author?: { name?: string; user?: { login?: string } | null } | null } }[] };
  allComments?: { nodes?: GhComment[] };
  reviews?: { nodes?: GhReview[] };
  threads?: { nodes?: GhThread[] };
  fileList?: { totalCount?: number; nodes?: { path: string; additions: number; deletions: number; changeType: string }[] };
  timelineItems?: { nodes?: { __typename: string; createdAt?: Iso; actor?: GhActor | null }[] };
}
// What a repository answers with, its pull requests under the names a query gave them: p<number> for one by its
// number, b<i> for a branch's.
interface GhRepo {
  nameWithOwner?: string;
  defaultBranchRef?: { name?: string } | null;
  pullRequest?: GhPull | null;
  [number: `p${number}`]: GhPull | null | undefined;
  [branch: `b${number}`]: { nodes?: GhPull[] } | null | undefined;
}
interface GhData {
  viewer?: { login?: string } | null;
  repository?: GhRepo | null;
  open?: { nodes?: GhPull[] };
  done?: { nodes?: GhPull[] };
}

type CheckState = "pass" | "fail" | "pending" | "skip";
// Where a pull request stands on GitHub (summary below).
export interface PullSummary {
  number: number;
  title: string;
  url: string;
  state: PrState;
  head: string;
  base: string;
  sha: string;
  author: string;
  created: Iso;
  updated: Iso;
  closed: Iso | null;
  mergeable: "yes" | "conflicts" | null;
  merge_state: string | null;
  review: PrReview | null;
  checks: PrChecks | null;
  comments: number;
  threads: number;
  add: number;
  del: number;
  files: number;
  commits: number;
  base_head: { sha: string; at: Iso | null; subject: string } | null;
}

// A check run or status, by how it went: pass, fail, pending or skip. A cancelled one didn't fail: a newer run
// took its place (a concurrency group), or someone stopped it; one that ran out of time is TIMED_OUT.
const RUN: Record<string, CheckState> = { SUCCESS: "pass", COMPLETED: "pass", NEUTRAL: "skip", SKIPPED: "skip", STALE: "skip", CANCELLED: "skip", FAILURE: "fail", TIMED_OUT: "fail", ACTION_REQUIRED: "fail", STARTUP_FAILURE: "fail", ERROR: "fail", IN_PROGRESS: "pending", QUEUED: "pending", PENDING: "pending", WAITING: "pending", REQUESTED: "pending", EXPECTED: "pending" };
const checkOf = (c: GhCheck): CheckState => (c.__typename === "StatusContext" ? RUN[c.state] || "pending" : c.status !== "COMPLETED" ? "pending" : RUN[c.conclusion] || "pass");
function tally(states: CheckState[]): PrChecks | null {
  const n = { pass: 0, fail: 0, pending: 0, skip: 0 };
  for (const s of states) n[s] += 1;
  return states.length ? { ...n, total: states.length } : null;
}
// The checks on its latest commit, counted: from each check when they're there, else from GitHub's counts.
function countChecks(rollup: GhRollup | null | undefined): PrChecks | null {
  if (!rollup) return null;
  if (rollup.contexts?.nodes) return tally(rollup.contexts.nodes.map(checkOf));
  const states: CheckState[] = [];
  for (const x of [...(rollup.contexts?.checkRunCountsByState || []), ...(rollup.contexts?.statusContextCountsByState || [])]) for (let i = 0; i < x.count; i++) states.push(RUN[x.state] || "pass");
  return tally(states);
}
const stateOf = (p: GhPull): PrState => (p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.isDraft ? "draft" : "open");
const REVIEW: Record<string, PrReview> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "required" };
const who = (a: GhActor | null | undefined): string => a?.login || "ghost";

// Where it stands on GitHub, enough for the sidebar and a page's header.
function summary(p: GhPull): PullSummary {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: stateOf(p),
    head: p.headRefName,
    base: p.baseRefName,
    sha: p.headRefOid,
    author: who(p.author),
    created: p.createdAt,
    updated: p.updatedAt,
    closed: p.mergedAt || p.closedAt || null,
    mergeable: p.mergeable === "MERGEABLE" ? "yes" : p.mergeable === "CONFLICTING" ? "conflicts" : null,
    merge_state: p.mergeStateStatus ? p.mergeStateStatus.toLowerCase() : null,
    review: REVIEW[p.reviewDecision] || null,
    checks: countChecks(p.checks?.nodes?.[0]?.commit?.statusCheckRollup),
    comments: p.comments?.totalCount ?? 0,
    threads: (p.reviewThreads?.nodes || []).filter((t) => !t.isResolved).length,
    add: p.additions ?? 0,
    del: p.deletions ?? 0,
    files: p.changedFiles ?? 0,
    commits: p.commits?.totalCount ?? 0,
    // its base's latest commit (open ones), which a timeline of a repo's pull requests starts from
    base_head: p.baseRef?.target?.oid ? { sha: p.baseRef.target.oid, at: p.baseRef.target.committedDate || null, subject: p.baseRef.target.messageHeadline || "" } : null,
  };
}

/* ---------- the list ---------- */

const LIST_FIELDS = `number title url state isDraft createdAt updatedAt closedAt mergedAt headRefName baseRefName headRefOid
  author { login } comments { totalCount } commits { totalCount } additions deletions changedFiles`;
// Open ones also say whether they can merge, how their review and checks stand, and what's unresolved.
const OPEN_FIELDS = `${LIST_FIELDS} mergeable mergeStateStatus reviewDecision reviewThreads(first: 100) { nodes { isResolved } }
  baseRef { target { oid ... on Commit { committedDate messageHeadline } } }`;
const CHECK_COUNTS = `checks: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;

// A repo's pull requests that are yours, newest first: { login, pulls, heads }. `extra`: numbers your posts
// opened or worked on, shown whoever opened them. `heads`: branches your machines have, each with its newest
// pull request, whoever opened it and however long ago it closed (`heads`: their numbers): a branch's pull request
// is part of its WIP for as long as the branch is there. Other merged or closed ones stay a week.
export interface ListOptions extends GithubAs {
  extra?: (number | string)[];
  heads?: string[];
}
// One of listPulls's: where it stands, and where it left its base (forksOf).
export interface ListedPull extends PullSummary {
  fork?: Fork | null;
}
export async function listPulls(key: string, { extra = [], heads = [], host, token }: ListOptions = {}): Promise<{ login: string | null; pulls: ListedPull[]; heads: number[] }> {
  const r = githubRepo(key);
  if (!r) throw new Error(`${key} isn't a repo on GitHub, so it has no pull requests to show.`);
  const since = new Date(Date.now() - DONE_DAYS * 86400e3).toISOString().slice(0, 10);
  const hs = [...new Set(heads.filter(Boolean))].slice(0, 30);
  const more = [
    ...extra.slice(0, 20).map((n) => `p${Number(n)}: pullRequest(number: ${Number(n)}) { ...open }`),
    ...hs.map((_, i) => `b${i}: pullRequests(headRefName: $h${i}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...open } }`),
  ].join("\n    ");
  // Two queries at once: GitHub answers the two searches together slower than each on its own.
  const [data, done] = await Promise.all([
    graphql<GhData>(
      `fragment open on PullRequest { ${OPEN_FIELDS} ${CHECK_COUNTS} }
query($q: String!, $owner: String!, $name: String!${hs.map((_, i) => `, $h${i}: String!`).join("")}) {
  viewer { login }
  open: search(query: $q, type: ISSUE, first: 50) { nodes { ...open } }
  repository(owner: $owner, name: $name) { nameWithOwner
    ${more}
  }
}`,
      { q: `repo:${r.slug} is:pr is:open author:@me sort:updated-desc`, owner: r.owner, name: r.name, ...Object.fromEntries(hs.map((h, i) => [`h${i}`, h])) },
      { host, token },
    ),
    graphql<GhData>(`query($q: String!) { done: search(query: $q, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${LIST_FIELDS} } } } }`, { q: `repo:${r.slug} is:pr is:closed author:@me closed:>=${since} sort:updated-desc` }, { host, token }),
  ]);
  if (!data?.repository) throw unseen(`GitHub has no repo ${r.slug}, or your GitHub account can't see it.`);
  const byNumber = new Map<number, ListedPull>();
  const add = (p: GhPull | null | undefined) => p?.number && !byNumber.has(p.number) && byNumber.set(p.number, summary(p));
  for (const p of data.open?.nodes || []) add(p);
  for (const n of extra) add(data.repository[`p${Number(n)}` as const]);
  const branches = new Set<number>();
  hs.forEach((_, i) => {
    const p = data.repository[`b${i}` as const]?.nodes?.[0];
    if (!p?.number) return;
    add(p);
    branches.add(p.number);
  });
  for (const p of done?.done?.nodes || []) add(p);
  const recent = Date.now() - DONE_DAYS * 86400e3;
  const pulls = [...byNumber.values()].filter((p) => !p.closed || Date.parse(p.closed) >= recent || branches.has(p.number)).sort((a, b) => b.updated.localeCompare(a.updated));
  await forksOf(r, pulls, { host, token });
  return { login: data.viewer?.login || null, pulls, heads: [...branches] };
}

// Where each open pull request left its base: the commit they share last, and how far its base moved since,
// from GitHub's compare of the two. It never changes for those two commits, so it's kept by them (and so is
// GitHub not having one, a 404), and asked for again only when one moves. Without it, a pull request's fork is
// null.
export interface Fork {
  sha: string;
  at: Iso | null;
  subject: string;
  behind: number;
}
// GitHub's compare of two commits, what's read of it.
interface GhCompare {
  merge_base_commit?: { sha?: string; commit?: { message?: string; committer?: { date?: Iso } } };
  behind_by?: number;
}
type Repo = NonNullable<ReturnType<typeof githubRepo>>;
const forks = new Map<string, Fork | null>(); // "repo|base commit|head commit" -> { sha, at, subject, behind } or null
async function forksOf(r: Repo, pulls: ListedPull[], { host, token }: GithubAs) {
  const keyOf = (p: ListedPull) => `${r.slug}|${p.base_head.sha}|${p.sha}`;
  const ask = pulls.filter((p) => (p.state === "open" || p.state === "draft") && p.base_head?.sha && p.sha && !forks.has(keyOf(p)));
  const one = async (p: ListedPull) => {
    let fork: Fork | null;
    try {
      const d = (await (await api(`/repos/${r.owner}/${r.name}/compare/${p.base_head.sha}...${p.sha}?per_page=1`, { host, token })).json()) as GhCompare;
      const mb = d.merge_base_commit;
      fork = mb?.sha ? { sha: mb.sha, at: mb.commit?.committer?.date || null, subject: String(mb.commit?.message || "").split("\n")[0], behind: Number(d.behind_by) || 0 } : null;
    } catch (e) {
      if (e.status !== 404) return;
      fork = null;
    }
    if (forks.size > 2000) forks.clear();
    forks.set(keyOf(p), fork);
  };
  for (let i = 0; i < ask.length; i += 6) await Promise.all(ask.slice(i, i + 6).map(one));
  for (const p of pulls) p.fork = (p.base_head?.sha && p.sha && forks.get(keyOf(p))) || null;
}

/* ---------- one in full ---------- */

const DETAIL = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${OPEN_FIELDS}
      id body mergedBy { login }
      labels(first: 20) { nodes { name color } }
      assignees(first: 10) { nodes { login } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } } }
      latestOpinionatedReviews(first: 30) { nodes { author { login } state submittedAt } }
      log: commits(last: 100) { nodes { commit { oid abbreviatedOid messageHeadline committedDate author { name user { login } } } } }
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl description createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }
      allComments: comments(last: 100) { nodes { id databaseId author { __typename login } body createdAt url } }
      reviews(last: 100) { nodes { id author { __typename login } state body submittedAt url } }
      threads: reviewThreads(last: 100) { nodes { id isResolved isOutdated path line originalLine viewerCanReply viewerCanResolve viewerCanUnresolve
        hunk: comments(first: 1) { nodes { diffHunk } }
        comments(first: 30) { nodes { id databaseId author { __typename login } body createdAt url } } } }
      fileList: files(first: 100) { totalCount nodes { path additions deletions changeType } }
      timelineItems(last: 50, itemTypes: [MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) { nodes {
        __typename
        ... on MergedEvent { createdAt actor { login } }
        ... on ClosedEvent { createdAt actor { login } }
        ... on ReopenedEvent { createdAt actor { login } }
        ... on HeadRefForcePushedEvent { createdAt actor { login } }
        ... on ReadyForReviewEvent { createdAt actor { login } }
        ... on ConvertToDraftEvent { createdAt actor { login } }
      } }
    }
  }
}`;
const FILE_KIND: Record<string, "create" | "delete" | "rename"> = { ADDED: "create", DELETED: "delete", RENAMED: "rename", COPIED: "create" };
const EVENT: Record<string, string> = { MergedEvent: "merged", ClosedEvent: "closed", ReopenedEvent: "reopened", HeadRefForcePushedEvent: "force-pushed", ReadyForReviewEvent: "ready", ConvertToDraftEvent: "draft" };
const comment = (c: GhComment) => ({ id: c.id, n: c.databaseId ?? null, who: who(c.author), bot: c.author?.__typename === "Bot", body: c.body || "", at: c.createdAt, url: c.url });
// The last few lines of the diff a review thread is on, the line it's on last: what it's about, at a glance.
const HUNK_LINES = 4;
const hunkOf = (t: GhThread) => {
  const lines = String(t.hunk?.nodes?.[0]?.diffHunk || "").split("\n").filter((l) => !l.startsWith("@@"));
  return lines.length ? lines.slice(-HUNK_LINES) : null;
};

// One pull request with everything GitHub has on it: its checks, reviews, comments and review threads, its
// commits, the files it changes, and what happened to it (merged, closed, force-pushed…).
export async function pullDetail(key: string, number: number | string, { host, token }: GithubAs = {}) {
  const r = githubRepo(key);
  if (!r) throw Object.assign(new Error(`${key} isn't a repo on GitHub.`), { status: 400 });
  const data = await graphql<GhData>(DETAIL, { owner: r.owner, name: r.name, number: Number(number) }, { host, token });
  const p = data?.repository?.pullRequest;
  if (!p) throw Object.assign(new Error(`${r.slug} has no pull request #${number}.`), { status: 404 });
  const order: Record<CheckState, number> = { fail: 0, pending: 1, pass: 2, skip: 3 };
  const checks_list = (p.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [])
    .map((c) => ({ name: c.name || c.context || "check", workflow: c.checkSuite?.workflowRun?.workflow?.name || null, state: checkOf(c), conclusion: String(c.conclusion || c.state || c.status || "").toLowerCase(), required: !!c.isRequired, url: c.detailsUrl || c.targetUrl || null, text: c.description || null, at: c.completedAt || c.startedAt || c.createdAt || null }))
    .sort((a, b) => order[a.state] - order[b.state] || Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  return {
    ...summary(p),
    login: data.viewer?.login || null,
    repo: r.slug,
    node: p.id || null,
    body: p.body || "",
    merged_by: p.mergedBy?.login || null,
    labels: (p.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color })),
    assignees: (p.assignees?.nodes || []).map(who),
    requested: (p.reviewRequests?.nodes || []).map((x) => x.requestedReviewer).filter(Boolean).map((x) => x.login || x.name),
    reviewers: (p.latestOpinionatedReviews?.nodes || []).map((x) => ({ who: who(x.author), state: x.state.toLowerCase(), at: x.submittedAt })),
    checks_list,
    commits_list: (p.log?.nodes || []).map(({ commit: c }) => ({ sha: c.oid, short: c.abbreviatedOid, subject: c.messageHeadline, at: c.committedDate, who: c.author?.user?.login || c.author?.name || null })),
    comments_list: (p.allComments?.nodes || []).map(comment),
    // A review that only says "commented" has its say in its threads: it shows when it decides something.
    reviews_list: (p.reviews?.nodes || []).filter((x) => x.body?.trim() || x.state !== "COMMENTED").map((x) => ({ id: x.id, who: who(x.author), bot: x.author?.__typename === "Bot", state: x.state.toLowerCase(), body: x.body || "", at: x.submittedAt, url: x.url })),
    threads_list: (p.threads?.nodes || []).map((t) => ({ id: t.id, path: t.path, line: t.line ?? t.originalLine ?? null, resolved: t.isResolved, outdated: t.isOutdated, hunk: hunkOf(t), can: { reply: t.viewerCanReply !== false, resolve: t.viewerCanResolve !== false, unresolve: t.viewerCanUnresolve !== false }, comments: (t.comments?.nodes || []).map(comment) })),
    files_list: (p.fileList?.nodes || []).map((f) => ({ path: f.path, add: f.additions, del: f.deletions, kind: FILE_KIND[f.changeType] || "edit" })),
    files_more: Math.max(0, (p.fileList?.totalCount || 0) - (p.fileList?.nodes?.length || 0)),
    events: (p.timelineItems?.nodes || []).filter((e) => EVENT[e.__typename]).map((e) => ({ kind: EVENT[e.__typename], who: e.actor?.login || null, at: e.createdAt })),
  };
}

/* ---------- answering it ---------- */

// Writing on a pull request as someone (their `token`), the way they would on GitHub: answering a review thread,
// resolving it or opening it again, and commenting on the pull request itself. GitHub says whether they may. A
// sign-in with GitHub whose app may only read pull requests is told what to change, in words.
export const CANT_WRITE = "GitHub won't let agentbook write here as you: agentbook's GitHub App only asks to read pull requests. Its owner gives it Pull requests: Read and write (on GitHub, the app's Permissions), and whoever installed it accepts that; or connect GitHub with a personal access token that has the repo scope, on Connectors.";
// What the mutations below answer with: what each made, under the mutation's name.
interface Mutated {
  addPullRequestReviewThreadReply?: { comment?: { id: string; url: string } };
  addComment?: { commentEdge?: { node?: { id: string; url: string } } };
  resolveReviewThread?: { thread?: { id: string; isResolved: boolean } };
  unresolveReviewThread?: { thread?: { id: string; isResolved: boolean } };
}
async function mutate(query: string, vars: Record<string, unknown>, opts: GithubAs): Promise<Mutated | null | undefined> {
  const out = (await (await api("/graphql", { ...opts, method: "POST", body: { query, variables: vars } })).json()) as GraphqlReply<Mutated>;
  const e = out.errors?.[0];
  if (!e) return out.data;
  const msg = e.message || "GitHub refused it.";
  if (/not accessible by integration|not been granted the required scopes/i.test(msg)) throw Object.assign(new Error(CANT_WRITE), { status: 403, code: "cant-write" });
  if (e.type === "NOT_FOUND") throw Object.assign(new Error("GitHub has no such review thread or pull request anymore."), { status: 404 });
  throw Object.assign(new Error(`GitHub said: ${msg}`), { status: 502 });
}
const MAX_BODY = 65000;
const bodyOf = (text: unknown) => {
  const t = String(text || "").trim();
  if (!t) throw Object.assign(new Error("Write something first."), { status: 400 });
  if (t.length > MAX_BODY) throw Object.assign(new Error("That's longer than GitHub takes."), { status: 400 });
  return t;
};
// A pull request's node id, which a comment on it goes to.
export async function pullNode(key: string, number: number | string, opts: GithubAs = {}): Promise<string> {
  const r = githubRepo(key);
  if (!r) throw Object.assign(new Error(`${key} isn't a repo on GitHub.`), { status: 400 });
  const d = await graphql<GhData>(`query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }`, { owner: r.owner, name: r.name, number: Number(number) }, opts);
  const id = d?.repository?.pullRequest?.id;
  if (!id) throw Object.assign(new Error(`${r.slug} has no pull request #${number}.`), { status: 404 });
  return id;
}
// A reply on a review thread (its node id). The reply: { id, url }.
export async function replyThread(thread: string, text: unknown, opts: GithubAs = {}): Promise<{ id?: string; url?: string }> {
  const d = await mutate(`mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id url } } }`, { thread: String(thread), body: bodyOf(text) }, opts);
  return d?.addPullRequestReviewThreadReply?.comment || {};
}
export async function resolveThread(thread: string, resolved = true, opts: GithubAs = {}): Promise<{ resolved: boolean }> {
  const op = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const d = await mutate(`mutation($thread: ID!) { ${op}(input: { threadId: $thread }) { thread { id isResolved } } }`, { thread: String(thread) }, opts);
  return { resolved: !!d?.[op]?.thread?.isResolved };
}
// A comment on the pull request itself (its node id, `node` in pullDetail). The comment: { id, url }.
export async function commentOn(node: string, text: unknown, opts: GithubAs = {}): Promise<{ id?: string; url?: string }> {
  const d = await mutate(`mutation($subject: ID!, $body: String!) { addComment(input: { subjectId: $subject, body: $body }) { commentEdge { node { id url } } } }`, { subject: String(node), body: bodyOf(text) }, opts);
  return d?.addComment?.commentEdge?.node || {};
}

// One file's change in a pull request, from its diff on GitHub. The whole diff is read once for the commit
// it's at, and kept for the files opened after, by whoever read it: GitHub says who may see it, so someone else
// reads it again as themselves.
const diffs = new Map<string, Promise<ReturnType<typeof parseUnified>>>(); // "who|owner/name#number@sha" -> Promise of its files, parsed
type Hunk = ReturnType<typeof capped>["hunks"][number];
// One file's change: its hunks (the first of them, and how many lines more), or that it's binary.
export interface PullFileDiff {
  path: string;
  kind: string;
  binary?: boolean;
  hunks: Hunk[];
  more?: number;
  add?: number;
  del?: number;
}
export async function pullDiff(key: string, number: number | string, file: string, sha = "", { host, token }: GithubAs = {}): Promise<PullFileDiff> {
  const r = githubRepo(key);
  if (!r) throw Object.assign(new Error(`${key} isn't a repo on GitHub.`), { status: 400 });
  const k = `${asWho(token)}|${r.slug}#${number}@${sha}`;
  if (!diffs.has(k)) {
    if (diffs.size > 40) diffs.clear();
    const p = api(`/repos/${r.slug}/pulls/${Number(number)}`, { token, host, accept: "application/vnd.github.diff" })
      .then((res) => res.text())
      .then(parseUnified);
    diffs.set(k, p);
    p.catch(() => diffs.delete(k));
  }
  const f = (await diffs.get(k)).find((x) => x.path === file);
  if (!f) return { path: file, kind: "edit", hunks: [] };
  if (f.binary) return { path: file, kind: f.kind, binary: true, hunks: [] };
  return { path: file, kind: f.kind, ...capped(f.hunks), ...sizeOf(f.hunks) };
}

/* ---------- a post's pull requests ---------- */

// A post links the pull requests it opened or worked on, the one on its branch, and the ones its agent or you
// linked (server.ts keeps them on the post, with where each stands on GitHub). The page shows each as a card,
// and a line on the post says when one changes.

// What a card shows of a pull request, and what its lines compare: its summary, plus who merged it, which checks
// fail, who decided its review, who it waits on, whether the account it's read as opened it, and who else said something.
const CARD_FIELDS = `${OPEN_FIELDS} mergedBy { login }
  reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } } }
  latestOpinionatedReviews(first: 10) { nodes { author { login } state submittedAt } }
  allComments: comments(last: 20) { nodes { author { __typename login } createdAt } }
  reviews(last: 20) { nodes { author { __typename login } state submittedAt } }
  checks: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 80) { nodes {
    __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
  } } } } } }`;
// A card as a read makes it: what carry() adds (`red`) comes after.
export type PrCardRead = Omit<PrCard, "red">;
const DECIDED: Partial<Record<PrReview, string>> = { approved: "APPROVED", changes: "CHANGES_REQUESTED" };
function cardOf(p: GhPull, login: string | null): PrCardRead {
  const s = summary(p);
  const contexts = p.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const decided = s.review ? DECIDED[s.review] : undefined;
  const by = (p.latestOpinionatedReviews?.nodes || []).filter((x) => x.state === decided).sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))[0];
  // What others said: comments and reviews that aren't the reading account's, or a bot's.
  const said = [...(p.allComments?.nodes || []).map((c) => ({ a: c.author, at: c.createdAt })), ...(p.reviews?.nodes || []).map((r) => ({ a: r.author, at: r.submittedAt }))]
    .filter((x) => x.a?.login && x.a.login !== login && x.a.__typename !== "Bot" && !/\[bot\]$/.test(x.a.login) && x.at)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-10)
    .map((x) => ({ who: x.a.login, at: x.at }));
  const { sha, created, commits, ...rest } = s;
  return {
    ...rest,
    sha: sha ? sha.slice(0, 12) : null,
    mine: !!login && s.author === login,
    merged_by: p.mergedBy?.login || null,
    failing: contexts.filter((c) => checkOf(c) === "fail").map((c) => c.name || c.context).filter(Boolean).slice(0, 6),
    reviewer: by?.author?.login || null,
    waiting: (p.reviewRequests?.nodes || []).map((x) => x.requestedReviewer).filter(Boolean).map((x) => x.login || x.name).slice(0, 4),
    said,
  };
}

// The pull requests posts link in one repo, for their cards: by number, and the ones whose branch is one of
// `heads` (the branches posts are on). -> { login, pulls: { [number]: card | null }, heads: { [branch]: [card] },
// base }: null for one GitHub doesn't have (or the account it's read as can't see), base the repo's default branch.
const CHUNK = 15;
export interface Linked {
  login: string | null;
  pulls: Record<number, PrCardRead | null>;
  heads: Record<string, PrCardRead[]>;
  base: string | null;
}
export async function readLinked(key: string, { numbers = [], heads = [] }: { numbers?: (number | string)[]; heads?: string[] } = {}, { host, token }: GithubAs = {}): Promise<Linked> {
  const r = githubRepo(key);
  if (!r) throw new Error(`${key} isn't a repo on GitHub.`);
  const nums = [...new Set(numbers.map(Number).filter((n) => n > 0))];
  const branches = [...new Set(heads.filter(Boolean))];
  const jobs: { nums: number[]; heads: string[] }[] = [];
  for (let i = 0; i < Math.max(nums.length, branches.length, 1); i += CHUNK) jobs.push({ nums: nums.slice(i, i + CHUNK), heads: branches.slice(i, i + CHUNK) });
  const out: Linked = { login: null, pulls: {}, heads: {}, base: null };
  // What GitHub answered, made cards once every read is in (they need whose login it was).
  const read: { pulls: Record<number, GhPull | null>; heads: Record<string, GhPull[]> } = { pulls: {}, heads: {} };
  await Promise.all(
    jobs.map(async (job, j) => {
      const vars: Record<string, string> = { owner: r.owner, name: r.name };
      const decl = ["$owner: String!", "$name: String!"];
      job.heads.forEach((h, i) => {
        vars[`h${i}`] = h;
        decl.push(`$h${i}: String!`);
      });
      const body = [
        ...job.nums.map((n) => `p${n}: pullRequest(number: ${n}) { ...card }`),
        ...job.heads.map((_, i) => `b${i}: pullRequests(headRefName: $h${i}, first: 3, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...card } }`),
      ].join("\n    ");
      const data = await graphql<GhData>(`fragment card on PullRequest { ${CARD_FIELDS} }\nquery(${decl.join(", ")}) {\n  viewer { login }\n  repository(owner: $owner, name: $name) { defaultBranchRef { name }\n    ${body}\n  }\n}`, vars, { host, token });
      if (!data?.repository) throw unseen(`GitHub has no repo ${r.slug}, or your GitHub account can't see it.`);
      out.login ||= data.viewer?.login || null;
      out.base ||= data.repository.defaultBranchRef?.name || null;
      for (const n of job.nums) read.pulls[n] = data.repository[`p${n}` as const] ? data.repository[`p${n}` as const] : null;
      job.heads.forEach((h, i) => (read.heads[h] = data.repository[`b${i}` as const]?.nodes || []));
    }),
  );
  for (const [n, p] of Object.entries(read.pulls)) out.pulls[Number(n)] = p ? cardOf(p, out.login) : null;
  for (const [h, ps] of Object.entries(read.heads)) out.heads[h] = ps.map((p) => cardOf(p, out.login));
  return out;
}

// What a card remembers between reads. Its checks were failing (`red`) until they all pass, while a new commit's
// run; whether it conflicts stays what it was while GitHub works it out again.
// What carry() reads of a card, before and after (a card, a task's slimmer copy of one, or a pull request in full).
interface Carried {
  state?: PrState;
  checks?: PrChecks | null;
  mergeable?: "yes" | "conflicts" | null;
  red?: boolean;
}
export function carry<T extends Carried>(before: Carried | null | undefined, after: T): T & { red: boolean } {
  const red = after.checks?.fail ? true : after.checks?.pending ? !!before?.red : false;
  return { ...after, red, ...(after.mergeable == null && after.state === "open" && before?.mergeable ? { mergeable: before.mergeable } : {}) };
}

// The lines a change makes on a post, between two reads of a pull request's card: only what you'd act on or want
// to know. Checks starting, a push, and what the reading account said don't make one. -> [{ kind, text }], kind:
// "merged", "closed", "fail", "good" or "note".
export interface PrLine {
  kind: PrLineKind;
  text: string;
}
export function prChanges(a: Partial<PrCard> | null | undefined, b: Partial<PrCard> | null | undefined): PrLine[] {
  if (!a || !b) return [];
  const n = `#${b.number}`;
  const lines: PrLine[] = [];
  const line = (kind: PrLineKind, text: string) => lines.push({ kind, text });
  if (a.state !== b.state) {
    if (b.state === "merged") return [{ kind: "merged", text: `${b.merged_by && b.merged_by !== b.author ? `@${b.merged_by} merged` : "Merged"} ${n} into \`${b.base}\`` }];
    if (b.state === "closed") return [{ kind: "closed", text: `${n} was closed without merging` }];
    if (a.state === "merged" || a.state === "closed") line("note", `${n} was reopened`);
    else if (b.state === "open") line("note", `${n} is ready for review`);
    else if (b.state === "draft") line("note", `${n} is a draft again`);
  }
  if (b.state !== "open" && b.state !== "draft") return lines;
  if (!a.red && b.red) {
    const names = b.failing?.length ? `: ${b.failing.slice(0, 3).map((x) => `\`${x}\``).join(", ")}${b.failing.length > 3 ? ` and ${b.failing.length - 3} more` : ""}` : "";
    line("fail", `${b.checks?.fail === 1 ? "A check" : `${b.checks?.fail || "Some"} checks`} failed on ${n}${names}`);
  } else if (a.red && !b.red && b.checks?.pass) line("good", `Checks pass on ${n} again`);
  if (a.review !== b.review) {
    if (b.review === "changes") line("fail", `${b.reviewer ? `@${b.reviewer}` : "A reviewer"} asked for changes on ${n}${b.threads ? `: ${b.threads === 1 ? "1 thread" : `${b.threads} threads`}` : ""}`);
    else if (b.review === "approved") line("good", b.reviewer ? `@${b.reviewer} approved ${n}` : `${n} was approved`);
  }
  if (a.mergeable !== "conflicts" && b.mergeable === "conflicts") line("fail", `${n} conflicts with \`${b.base}\` now`);
  else if (a.mergeable === "conflicts" && b.mergeable === "yes") line("good", `${n} doesn't conflict with \`${b.base}\` anymore`);
  // Who said something new: comments and reviews since the last read, by anyone but the reading account. A review that
  // decided something already has its line.
  const last = (a.said || []).at(-1)?.at || "";
  const decided = lines.some((l) => /asked for changes|approved/.test(l.text)) ? b.reviewer : null;
  const fresh = [...new Set((b.said || []).filter((x) => x.at > last).map((x) => x.who))].filter((x) => x !== decided);
  if (fresh.length) line("note", `${fresh.slice(0, 2).map((x) => `@${x}`).join(" and ")}${fresh.length > 2 ? ` and ${fresh.length - 2} more` : ""} commented on ${n}`);
  return lines;
}
