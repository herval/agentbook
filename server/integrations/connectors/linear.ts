// Linear, as a connector: the issues assigned to you come into your Tasks. Through Linear's GraphQL API, signed in with
// agentbook's Linear app (linear-app.ts), or with a personal API key (Linear's Settings > Account > Security &
// Access). Ticking a task can close its issue there, and unticking it puts the issue back in the state it was in.

import type { ConnectorConf, SourceItem } from "../connectors.ts";

const API = process.env.AGENTBOOK_LINEAR_URL || "https://api.linear.app/graphql";

export const kind = "linear";
export const name = "Linear";
// Linear's kinds of workflow state, by the names its default states have, and the ones a connector pulls
// unless told otherwise. Done and canceled issues are never pulled: they tick their tasks.
export const STATES: Record<string, string> = { triage: "Triage", backlog: "Backlog", unstarted: "Todo", started: "In Progress" };
export const DEFAULT_STATES = ["unstarted", "started"];
export const SIGNIN = true;

const ISSUE = "id identifier title url priority updatedAt state { id name type } team { key } assignee { isMe }";

// An issue as Linear's GraphQL API says it (ISSUE).
interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority?: number | null;
  updatedAt?: string;
  state?: { id: string; name: string; type: string } | null;
  team?: { key: string } | null;
  assignee?: { isMe?: boolean } | null;
}
// A team's workflow states, by type.
interface LinearStates {
  states?: { nodes?: { id: string; position: number }[] };
}
// What the queries below answer with, each what it asked for.
interface Answer {
  viewer?: { name?: string; email?: string };
  organization?: { name?: string } | null;
  issues?: { nodes: LinearIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
  issue?: { state?: { id: string; type: string } | null; team?: LinearStates | null } | null;
  issueUpdate?: { success?: boolean; issue?: LinearIssue };
}
// What Linear answers, errors and all.
interface Reply {
  data?: Answer | null;
  errors?: { message?: string; extensions?: { code?: string; type?: string; userPresentableMessage?: string } }[];
}

async function gql(key: string, query: string, variables: Record<string, unknown> = {}): Promise<Answer> {
  // A personal API key goes as it is; an OAuth token is a Bearer token.
  const authorization = /^lin_api_/.test(key) ? key : `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Can't reach Linear (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`);
  }
  const out = (await res.json().catch((): null => null)) as Reply | null;
  const err = out?.errors?.[0];
  const code = String(err?.extensions?.code || err?.extensions?.type || "");
  if (res.status === 401 || /AUTHENTICAT/i.test(code)) throw new Error(authorization === key ? "Linear turned the API key down. Make a new one in Linear, under Settings > Account > Security & Access." : "Linear signed agentbook out. Sign in with Linear again.");
  if (res.status === 429 || /RATELIMIT/i.test(code)) throw new Error("Linear says agentbook asked too often. It tries again later.");
  if (/FORBIDDEN/i.test(code)) throw new Error(`Linear won't let ${authorization === key ? "this API key" : "agentbook"} do that: ${err.extensions?.userPresentableMessage || err.message}`);
  if (!res.ok || !out?.data) throw new Error(err?.extensions?.userPresentableMessage || err?.message || `Linear answered HTTP ${res.status}.`);
  return out.data;
}

// An issue in agentbook's words.
const itemOf = (i: LinearIssue): SourceItem => ({
  id: i.id,
  key: i.identifier,
  title: i.title,
  url: i.url,
  state: i.state?.name || null,
  state_type: i.state?.type || null,
  state_id: i.state?.id || null,
  team: i.team?.key || null,
  priority: i.priority ?? 0,
  updated: i.updatedAt || null,
  mine: i.assignee ? !!i.assignee.isMe : false,
});

// Who the key signs in as, to show on the Connectors page.
export async function check(key: string): Promise<string> {
  const d = await gql(key, "query AgentbookViewer { viewer { name email } organization { name } }");
  return `${d.viewer.name || d.viewer.email}${d.organization?.name ? `, in ${d.organization.name}` : ""}`;
}

// The open issues assigned to you, in the states and teams the connector names: urgent first, then high,
// medium, low and no priority; started before not started; the latest change first.
export async function pull(c: ConnectorConf): Promise<SourceItem[]> {
  const filter: { assignee: unknown; state: unknown; team?: unknown } = { assignee: { isMe: { eq: true } }, state: { type: { in: c.states?.length ? c.states : DEFAULT_STATES } } };
  if (c.teams?.length) filter.team = { key: { in: c.teams } };
  const items: SourceItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const d = await gql(c.key, `query AgentbookIssues($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after, orderBy: updatedAt) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`, { filter, after });
    items.push(...d.issues.nodes.map(itemOf));
    if (!d.issues.pageInfo?.hasNextPage) break;
    after = d.issues.pageInfo.endCursor;
  }
  const rank = (p: number) => (p > 0 ? p : 5);
  return items.sort((a, b) => rank(a.priority) - rank(b.priority) || Number(b.state_type === "started") - Number(a.state_type === "started") || String(b.updated).localeCompare(String(a.updated)));
}

// Issues by id, whatever their state, to learn why they left the pull. One Linear doesn't return is gone.
export async function lookup(c: ConnectorConf, ids: string[]): Promise<SourceItem[]> {
  const found: SourceItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const d = await gql(c.key, `query AgentbookLookup($filter: IssueFilter) { issues(filter: $filter, first: 100) { nodes { ${ISSUE} } } }`, { filter: { id: { in: ids.slice(i, i + 100) } } });
    found.push(...d.issues.nodes.map(itemOf));
  }
  return found;
}

// Why an issue isn't among the ones pulled any more, in words.
export function goneWhy(item: SourceItem | undefined): string {
  if (!item) return "Deleted in Linear";
  if (item.state_type === "completed") return `${item.state || "Done"} in Linear`;
  if (item.state_type === "canceled") return `${item.state || "Canceled"} in Linear`;
  if (!item.mine) return "Not assigned to you any more";
  return `${item.state} in Linear`;
}

// Close an issue: its team's first done state. Says the state it was in, to put it back.
export async function close(c: ConnectorConf, id: string): Promise<{ item: SourceItem | null; was: string | null }> {
  const d = await gql(c.key, `query AgentbookDoneStates($id: String!) { issue(id: $id) { state { id type } team { states(filter: { type: { eq: "completed" } }) { nodes { id position } } } } }`, { id });
  if (!d.issue) throw new Error("Linear has no such issue any more.");
  if (d.issue.state?.type === "completed") return { item: null, was: null };
  const done = [...(d.issue.team?.states?.nodes || [])].sort((a, b) => a.position - b.position)[0];
  if (!done) throw new Error("The issue's team in Linear has no done state.");
  return { item: await move(c, id, done.id), was: d.issue.state?.id || null };
}

// Put an issue in a state (the one it was in before agentbook closed it), or the team's first to-do state.
export async function reopen(c: ConnectorConf, id: string, stateId?: string | null): Promise<SourceItem> {
  if (stateId) return move(c, id, stateId);
  const d = await gql(c.key, `query AgentbookTodoStates($id: String!) { issue(id: $id) { team { states(filter: { type: { eq: "unstarted" } }) { nodes { id position } } } } }`, { id });
  const todo = [...(d.issue?.team?.states?.nodes || [])].sort((a, b) => a.position - b.position)[0];
  if (!todo) throw new Error("The issue's team in Linear has no to-do state.");
  return move(c, id, todo.id);
}

async function move(c: ConnectorConf, id: string, stateId: string): Promise<SourceItem> {
  const d = await gql(c.key, `mutation AgentbookMove($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE} } } }`, { id, stateId });
  if (!d.issueUpdate?.success) throw new Error("Linear didn't change the issue.");
  return itemOf(d.issueUpdate.issue);
}
