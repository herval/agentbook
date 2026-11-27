// GitHub, as a connector: the issues assigned to you and the pull requests waiting for your review come into
// your Tasks, and its token is how agentbook reads GitHub as you: your workspaces' pull requests and your posts'
// (pulls.ts), and your repos, to add as workspaces. Through GitHub's API, with the token signing in with GitHub gets you (github-app.ts), or a personal
// access token (github.com › Settings › Developer settings › Personal access tokens). Ticking an issue's task can
// close it there, and unticking reopens it; a review's task just ticks, and goes once you've reviewed it.

import { graphql } from "../pulls.ts";
import type { ConnectorConf, SourceItem } from "../connectors.ts";
import type { TaskSource } from "../../../plugin/shared/types.ts";

export const kind = "github";
export const name = "GitHub";
export const STATES: Record<string, string> = { issues: "Issues assigned to you", reviews: "Pull requests waiting for your review" };
export const DEFAULT_STATES = ["issues", "reviews"];
// None of them is fine too: then it brings nothing into Tasks, and is only how agentbook reads GitHub as you.
export const OPTIONAL = true;
export const KEY = "token";

// Where it looks: "owner/name" for one repo, a name alone for all of an organization's. None: everywhere.
export const scopes = (list: string[]): string[] =>
  list
    .map((s) => String(s).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, ""))
    .filter((s) => /^[\w.-]+(\/[\w.-]+)?$/.test(s));
const where = (c: ConnectorConf) => (c.teams || []).map((s) => (s.includes("/") ? `repo:${s}` : `org:${s}`)).join(" ");

const ISSUE = "number title url state stateReason updatedAt repository { nameWithOwner } assignees(first: 20) { nodes { login } }";
const PULL = "number title url state merged updatedAt repository { nameWithOwner } reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }";
const NODE = `__typename ... on Issue { id ${ISSUE} } ... on PullRequest { id ${PULL} }`;

// An issue or a pull request as GitHub's GraphQL API says it (NODE).
interface GhNode {
  __typename?: string;
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  merged?: boolean;
  updatedAt?: string;
  repository?: { nameWithOwner?: string } | null;
  assignees?: { nodes?: { login: string }[] };
  reviewRequests?: { nodes?: { requestedReviewer?: { __typename?: string; login?: string } | null }[] };
}
interface GhRepoNode {
  nameWithOwner?: string;
  isPrivate?: boolean;
  isFork?: boolean;
  isArchived?: boolean;
  pushedAt?: string | null;
  description?: string | null;
}
// What the queries below answer with, each what it asked for.
interface Answer {
  viewer?: {
    login?: string;
    name?: string | null;
    repositories?: { totalCount?: number; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (GhRepoNode | null)[] };
  } | null;
  reviews?: { nodes?: (GhNode | null)[] };
  issues?: { nodes?: (GhNode | null)[] };
  nodes?: (GhNode | null)[];
  closeIssue?: { issue?: GhNode | null };
  reopenIssue?: { issue?: GhNode | null };
}
const ask = (key: string, query: string, vars: Record<string, unknown> = {}) => graphql<Answer>(query, vars, { token: key });

// An issue, or a pull request waiting for your review, in agentbook's words. `me`: the token's login, to say
// whether it's still yours (assigned to you, or waiting for you or a team of yours).
function itemOf(n: GhNode, me: string | null): SourceItem {
  const pr = n.__typename === "PullRequest";
  const repo = n.repository?.nameWithOwner || "";
  const open = n.state === "OPEN";
  const done = pr ? !!n.merged : n.stateReason !== "NOT_PLANNED";
  return {
    id: n.id,
    key: `${repo}#${n.number}`,
    title: pr ? `Review: ${n.title}` : n.title,
    url: n.url,
    state: open ? (pr ? "Waiting for your review" : "Open") : pr ? (n.merged ? "Merged" : "Closed") : n.stateReason === "NOT_PLANNED" ? "Closed as not planned" : "Closed",
    state_type: open ? (pr ? "review" : "unstarted") : done ? "completed" : "canceled",
    state_id: pr ? "pull" : "issue",
    team: repo,
    updated: n.updatedAt || null,
    mine: pr ? (n.reviewRequests?.nodes || []).some((r) => r.requestedReviewer && (r.requestedReviewer.__typename !== "User" || r.requestedReviewer.login === me)) : (n.assignees?.nodes || []).some((a) => a.login === me),
  };
}

// Who the token signs in as, to show on the Connectors page.
export async function check(key: string): Promise<string> {
  const d = await ask(key, "query { viewer { login name } }");
  return d.viewer.name ? `${d.viewer.name} (@${d.viewer.login})` : `@${d.viewer.login}`;
}

// The repos you can see on GitHub, to pick one to add as a workspace: yours, your organizations' and the ones
// you're a collaborator on, the latest pushed to first, up to 1,000 of them. A sign-in with GitHub sees only the
// ones agentbook's GitHub App is installed on. { login, repos: [{ slug, private, fork, archived, pushed, about }], more }
const REPOS_MAX = 1000;
const MINE = "[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]";
export interface Repo {
  slug: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushed: string | null;
  about: string | null;
}
export async function repos(key: string): Promise<{ login: string | null; repos: Repo[]; more: number }> {
  const out: Repo[] = [];
  let login: string | null = null;
  let after: string | null = null;
  for (;;) {
    const d = await ask(key, `query($after: String) { viewer { login repositories(first: 100, after: $after, affiliations: ${MINE}, ownerAffiliations: ${MINE}, orderBy: { field: PUSHED_AT, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { nameWithOwner isPrivate isFork isArchived pushedAt description } } } }`, { after });
    login = d.viewer?.login || login;
    const page = d.viewer?.repositories;
    for (const r of page?.nodes || []) if (r?.nameWithOwner) out.push({ slug: r.nameWithOwner, private: !!r.isPrivate, fork: !!r.isFork, archived: !!r.isArchived, pushed: r.pushedAt || null, about: r.description || null });
    if (!page?.pageInfo?.hasNextPage || out.length >= REPOS_MAX) return { login, repos: out.slice(0, REPOS_MAX), more: Math.max(0, (page?.totalCount || 0) - REPOS_MAX) };
    after = page.pageInfo.endCursor;
  }
}

// What's yours to do on GitHub, in the repos and organizations the connector names: the pull requests waiting
// for your review first (someone's waiting on you), then the issues assigned to you, the latest change first.
// Null when it brings nothing into Tasks.
export async function pull(c: ConnectorConf): Promise<SourceItem[] | null> {
  const want = (c.states || []).filter((s) => STATES[s]);
  if (!want.length) return null;
  const vars: { reviews?: string; issues?: string } = {};
  const parts: string[] = [];
  if (want.includes("reviews")) {
    vars.reviews = `is:pr is:open review-requested:@me archived:false sort:updated-desc ${where(c)}`.trim();
    parts.push(`reviews: search(query: $reviews, type: ISSUE, first: 100) { nodes { ${NODE} } }`);
  }
  if (want.includes("issues")) {
    vars.issues = `is:issue is:open assignee:@me archived:false sort:updated-desc ${where(c)}`.trim();
    parts.push(`issues: search(query: $issues, type: ISSUE, first: 100) { nodes { ${NODE} } }`);
  }
  const d = await ask(c.key, `query(${Object.keys(vars).map((k) => `$${k}: String!`).join(", ")}) { viewer { login } ${parts.join(" ")} }`, vars);
  const me = d.viewer?.login || null;
  return [...(d.reviews?.nodes || []), ...(d.issues?.nodes || [])].filter((n) => n?.id).map((n) => itemOf(n, me));
}

// Issues and pull requests by id, whatever their state, to learn why they left the pull. One GitHub doesn't
// return is gone, or the token can't see it any more.
export async function lookup(c: ConnectorConf, ids: string[]): Promise<SourceItem[]> {
  const ok = ids.filter((id) => /^[\w=+/-]+$/.test(String(id)));
  const found: SourceItem[] = [];
  for (let i = 0; i < ok.length; i += 50) {
    const d = await ask(c.key, `query { viewer { login } nodes(ids: ${JSON.stringify(ok.slice(i, i + 50))}) { ${NODE} } }`);
    found.push(...(d.nodes || []).filter((n) => n?.id).map((n) => itemOf(n, d.viewer?.login || null)));
  }
  return found;
}

// Why an issue or a review isn't among the ones pulled any more, in words.
export function goneWhy(item: SourceItem | undefined): string {
  if (!item) return "Gone from GitHub, or the token can't see it any more";
  if (item.state_id === "pull") {
    if (item.state_type === "completed" || item.state_type === "canceled") return `${item.state} on GitHub`;
    return item.mine ? "Not in the repos the connector looks at" : "Not waiting for your review any more";
  }
  if (item.state_type === "completed" || item.state_type === "canceled") return `${item.state} on GitHub`;
  return item.mine ? "Not in the repos the connector looks at" : "Not assigned to you any more";
}

// Only an issue closes from here: a review is done on GitHub, and its task goes once it is.
export const closes = (source: TaskSource | null | undefined) => source?.state_id === "issue";

export async function close(c: ConnectorConf, id: string): Promise<{ item: SourceItem; was: null }> {
  const d = await ask(c.key, `mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { __typename id ${ISSUE} } } }`, { id });
  if (!d.closeIssue?.issue) throw new Error("GitHub didn't close the issue.");
  return { item: itemOf(d.closeIssue.issue, null), was: null };
}

// Open it again.
export async function reopen(c: ConnectorConf, id: string): Promise<SourceItem> {
  const d = await ask(c.key, `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { issue { __typename id ${ISSUE} } } }`, { id });
  if (!d.reopenIssue?.issue) throw new Error("GitHub didn't reopen the issue.");
  return itemOf(d.reopenIssue.issue, null);
}
