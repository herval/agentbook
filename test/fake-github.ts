// A stand-in for github.com and api.github.com, for tests and the demo: the parts agentbook reads GitHub with
// (pulls.ts, connectors/github.ts): GraphQL, and a pull request's diff; and the parts its GitHub App uses
// (github-app.ts): making an app from a manifest, the Device Flow, refreshing user access tokens, and where an app
// is installed. What GitHub has comes from ghFile:
//   { repos: { "owner/name": { pulls: [<a PullRequest the way GitHub's GraphQL API has it (fake-gh-pulls.ts)>],
//       diffs: { <number>: <unified diff> }, issues: [{ id, number, title, state, stateReason, assignees: [login],
//       updatedAt }], private, fork, archived, pushedAt, description } },
//     tokens: { <token>: { login, name, repos: ["owner/name"] } } }
// A token is its person, who sees the repos it lists (every one when it lists none); one it doesn't know is turned
// down as GitHub does. The tokens the Device Flow hands out are written into ghFile, and a refreshed one stops
// working, as on GitHub. Each read is logged, with who it was as, to ghFile.calls.jsonl: { api: "graphql", query,
// vars, as } or { api: "diff", repo, number, as }. Closing and reopening issues is kept in ghFile, and while
// ghFile.fail is there GitHub fails.
//   const gh = await startGitHub({ ghFile, people: { alice: { name, repos, installations: [{ account, all }] } } })
//   gh.manifest(code, app), gh.approve(userCode, login), gh.deny(userCode), gh.deviceFlow = false, gh.ttl = seconds
// `confirm`: the login GitHub's "Create GitHub App" page confirms a manifest as at once (the demo's), sending them
// back with its code. `approveAs`: the login every code is entered as, a moment after it's asked for (the demo's).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Pull } from "./fake-gh-pulls.ts";

// What ghFile has (see above).
export interface GhData {
  repos?: Record<string, GhRepo>;
  tokens?: Record<string, GhPerson>;
}
export interface GhRepo {
  pulls?: Pull[];
  diffs?: Record<number, string>;
  issues?: GhIssue[];
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  pushedAt?: string | null;
  description?: string | null;
  // Its default branch ("main" when not given).
  base?: string;
}
export interface GhIssue {
  id: string;
  number: number;
  title: string;
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  // Logins.
  assignees?: string[];
  updatedAt?: string;
}
// A token's person: the repos it sees (every one when none are listed); `write: false` for one that may only read.
export interface GhPerson {
  login: string;
  name?: string | null;
  repos?: string[];
  write?: boolean;
}
// Where a person's GitHub App is installed: an organization's (or a user's) account, on all its repos or some.
export interface GhInstallation {
  account: string;
  all?: boolean;
  type?: "Organization" | "User";
}
// An app GitHub makes from a manifest.
export interface GhApp {
  slug: string;
  name: string;
  owner: { login: string; type: string };
}
interface DeviceCode {
  user_code: string;
  login: string | null;
  denied: boolean;
  at: number;
  slowed: boolean;
}
interface Issued {
  login: string;
  access_token: string;
  refresh_token: string;
  retired?: boolean;
}
export interface GitHubOptions {
  ghFile: string;
  people?: Record<string, { name?: string; repos?: string[]; installations?: GhInstallation[] }>;
  clientId?: string;
  confirm?: string | null;
  approveAs?: string | null;
}
export interface GitHubSite {
  url: string;
  clientId: string;
  deviceFlow: boolean;
  ttl: number;
  expiresIn: number;
  seen: { path: string; grant: string | null }[];
  manifests: Map<string, GhApp>;
  devices: Map<string, DeviceCode>;
  refreshes: Map<string, string>;
  issued: Issued[];
  manifest(code: string, app: GhApp): void;
  approve(userCode: string, login: string): void;
  deny(userCode: string): void;
  current(login: string): Issued | null;
  revoke(login: string): void;
  close(): void;
}
// A GraphQL query's variables, the ones these queries have.
interface Vars {
  after?: string;
  issues?: string;
  reviews?: string;
  q?: string;
  id?: string;
  subject?: string;
  body?: string;
  thread?: string;
  owner?: string;
  name?: string;
  number?: number;
  [name: string]: unknown;
}

export async function startGitHub({ ghFile, people = {}, clientId = "Iv1.agentbook-test", confirm = null, approveAs = null }: GitHubOptions): Promise<GitHubSite> {
  const me: GitHubSite = {
    url: null,
    clientId,
    deviceFlow: true,
    ttl: 28800, // a user access token's life, in seconds
    expiresIn: 900, // a device code's
    seen: [], // what was asked: { path, grant }
    manifests: new Map(), // code -> the app GitHub would make
    devices: new Map(), // device_code -> { user_code, login, denied, at }
    refreshes: new Map(), // refresh_token -> login
    issued: [], // { login, access_token, refresh_token }
    manifest: (code, app) => me.manifests.set(code, app),
    approve: (userCode, login) => {
      for (const d of me.devices.values()) if (d.user_code === userCode) d.login = login;
    },
    deny: (userCode) => {
      for (const d of me.devices.values()) if (d.user_code === userCode) d.denied = true;
    },
    current: (login) => me.issued.filter((t) => t.login === login && !t.retired).at(-1) || null,
    revoke: (login) => {
      for (const [r, l] of me.refreshes) if (l === login) me.refreshes.delete(r);
    },
    close: () => server.close(),
  };
  const random = (n = 12) => crypto.randomBytes(n).toString("hex");
  const ghData = (): GhData => JSON.parse(fs.readFileSync(ghFile, "utf8"));
  const ghSave = (d: GhData) => fs.writeFileSync(ghFile, JSON.stringify(d));
  function issue(login: string) {
    const t: Issued = { login, access_token: `ghu_${random()}`, refresh_token: `ghr_${random()}` };
    const d = ghData();
    d.tokens = { ...(d.tokens || {}), [t.access_token]: { login, name: people[login]?.name || null, repos: people[login]?.repos } };
    ghSave(d);
    me.refreshes.set(t.refresh_token, login);
    me.issued.push(t);
    return { access_token: t.access_token, token_type: "bearer", scope: "", expires_in: me.ttl, refresh_token: t.refresh_token, refresh_token_expires_in: 15897600 };
  }
  // A token that was refreshed works no more, on GitHub nor through gh.
  function retire(refresh_token: string) {
    const t = me.issued.find((x) => x.refresh_token === refresh_token);
    me.refreshes.delete(refresh_token);
    if (!t) return;
    const d = ghData();
    delete d.tokens?.[t.access_token];
    ghSave(d);
    t.retired = true;
  }
  const loginOf = (auth: string | undefined) => {
    const tok = /^Bearer (.+)$/.exec(auth || "")?.[1];
    return tok && me.issued.find((t) => t.access_token === tok && !t.retired)?.login;
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const p = new URLSearchParams(body);
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      me.seen.push({ path: url.pathname, grant: p.get("grant_type") });
      if (req.method === "POST" && url.pathname === "/login/device/code") {
        if (p.get("client_id") !== me.clientId) return send(200, { error: "incorrect_client_credentials" });
        if (!me.deviceFlow) return send(200, { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" });
        const device_code = random(20);
        const user_code = `${random(2).toUpperCase()}-${random(2).toUpperCase()}`;
        me.devices.set(device_code, { user_code, login: null, denied: false, at: Date.now(), slowed: false });
        if (approveAs) setTimeout(() => me.approve(user_code, approveAs), 4000).unref();
        return send(200, { device_code, user_code, verification_uri: `${me.url}/login/device`, expires_in: me.expiresIn, interval: 1 });
      }
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        if (p.get("client_id") !== me.clientId) return send(200, { error: "incorrect_client_credentials" });
        if (p.get("grant_type") === "refresh_token") {
          const login = me.refreshes.get(p.get("refresh_token") || "");
          if (!login) return send(200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
          retire(p.get("refresh_token"));
          return send(200, issue(login));
        }
        const d = me.devices.get(p.get("device_code") || "");
        if (!me.deviceFlow) return send(200, { error: "device_flow_disabled" });
        if (!d) return send(200, { error: "incorrect_device_code" });
        if (Date.now() - d.at > me.expiresIn * 1000) return send(200, { error: "expired_token" });
        if (d.denied) return send(200, { error: "access_denied" });
        // The first look is too soon, as GitHub sometimes says.
        if (!d.slowed) {
          d.slowed = true;
          return send(200, { error: "slow_down", interval: 1 });
        }
        if (!d.login) return send(200, { error: "authorization_pending" });
        me.devices.delete(p.get("device_code"));
        return send(200, issue(d.login));
      }
      // GitHub's "Create GitHub App" page, confirmed at once as `confirm`: back to the manifest's redirect_url.
      if (req.method === "POST" && /^\/(organizations\/[^/]+\/)?settings\/apps\/new$/.test(url.pathname) && confirm) {
        const m: { name?: string; redirect_url?: string } = JSON.parse(p.get("manifest") || "{}");
        const code = random(8);
        me.manifest(code, { slug: m.name, name: m.name, owner: { login: confirm, type: "User" } });
        res.writeHead(302, { location: `${m.redirect_url}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") || "")}` });
        return res.end();
      }
      if (req.method === "GET" && ["/login/device", "/settings/apps/" + (url.pathname.split("/")[3] || "")].includes(url.pathname)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>GitHub (stand-in)</title><p style='font:16px system-ui;margin:40px'>The demo's stand-in for GitHub: nothing to do here. Your code is accepted in a moment; go back to agentbook.</p>");
      }
      const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
      if (req.method === "POST" && conv) {
        const app = me.manifests.get(decodeURIComponent(conv[1]));
        if (!app) return send(404, { message: "Not Found" });
        me.manifests.delete(decodeURIComponent(conv[1]));
        return send(201, { id: 4242, node_id: "A_1", client_id: me.clientId, client_secret: "SECRET-client-secret", webhook_secret: "SECRET-webhook-secret", pem: "-----BEGIN RSA PRIVATE KEY-----\nSECRET-private-key\n-----END RSA PRIVATE KEY-----\n", html_url: `${me.url}/apps/${app.slug}`, ...app });
      }
      // Reading GitHub as someone: GraphQL, a pull request's diff, and comparing two commits.
      const pr = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
      const cmp = /^\/repos\/([^/]+)\/([^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url.pathname);
      if ((req.method === "POST" && url.pathname === "/graphql") || (req.method === "GET" && (pr || cmp))) {
        const data = ghData();
        const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || null;
        const who = (token && data.tokens?.[token]) || null;
        // What was asked, as the calls log has it.
        const call: { api: string; repo?: string; number?: number; base?: string; head?: string; query?: string; variables?: Vars } = pr ? { api: "diff", repo: `${pr[1]}/${pr[2]}`, number: Number(pr[3]) } : cmp ? { api: "compare", repo: `${cmp[1]}/${cmp[2]}`, base: cmp[3], head: cmp[4] } : { api: "graphql", ...JSON.parse(body || "{}") };
        fs.appendFileSync(`${ghFile}.calls.jsonl`, JSON.stringify({ ...call, as: who?.login || null, token: !!token }) + "\n");
        if (!who) return send(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
        if (fs.existsSync(`${ghFile}.fail`)) return send(502, { message: "Server Error" });
        if (cmp) {
          // a pull request's head against its base's latest commit: where it left, and how far its base moved
          const p = (repoOf(data, who, call.repo)?.pulls || []).find((x) => x.headRefOid === call.head && x.baseRef?.target?.oid === call.base);
          if (!p?._fork) return send(404, { message: "Not Found" });
          return send(200, { status: p._fork.behind ? "diverged" : "ahead", behind_by: p._fork.behind, ahead_by: p.commits?.totalCount || 1, merge_base_commit: { sha: p._fork.sha, commit: { message: p._fork.message, committer: { date: p._fork.date } } }, commits: [], files: [] });
        }
        if (pr) {
          const text = repoOf(data, who, call.repo)?.diffs?.[call.number];
          if (text == null || !/diff/.test(req.headers.accept || "")) return send(404, { message: "Not Found" });
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(text);
        }
        const out = graphql(data, who, call.query || "", call.variables || {});
        if (out.changed) ghSave(data);
        return send(200, out.answer);
      }
      if (req.method === "GET" && url.pathname === "/user/installations") {
        const login = loginOf(req.headers.authorization);
        if (!login) return send(401, { message: "Bad credentials" });
        const list = people[login]?.installations || [];
        return send(200, { total_count: list.length, installations: list.map((i, n) => ({ id: n + 1, account: { login: i.account, type: i.type || "Organization" }, repository_selection: i.all ? "all" : "selected", html_url: `${me.url}/${(i.type || "Organization") === "Organization" ? `organizations/${i.account}/` : ""}settings/installations/${n + 1}` })) });
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  me.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return me;
}

// GitHub's GraphQL API, as `me` ({ login, name, repos }), over what ghFile has: the queries pulls.ts and the
// GitHub connector make. { answer, changed }: changed when an issue was closed or reopened.
const sees = (me: GhPerson, slug: string) => !me.repos || me.repos.some((r) => r.toLowerCase() === String(slug).toLowerCase());
const repoOf = (data: GhData, me: GhPerson, slug: string): GhRepo | undefined => (sees(me, slug) ? Object.entries(data.repos || {}).find(([k]) => k.toLowerCase() === String(slug).toLowerCase())?.[1] : undefined);
const issueNode = (slug: string, i: GhIssue) => ({ __typename: "Issue", id: i.id, number: i.number, title: i.title, url: `https://github.com/${slug}/issues/${i.number}`, state: i.state || "OPEN", stateReason: i.stateReason || null, updatedAt: i.updatedAt || new Date().toISOString(), repository: { nameWithOwner: slug }, assignees: { nodes: (i.assignees || []).map((login) => ({ login })) } });
// GitHub's ids don't change with how a repo's name is written.
const pullId = (slug: string, p: Pull) => p.id || `PR_${slug.toLowerCase().replace(/\W/g, "_")}_${p.number}`;
const pullNode = (slug: string, p: Pull) => ({ ...p, __typename: "PullRequest", id: pullId(slug, p), merged: p.state === "MERGED", repository: { nameWithOwner: slug } });
// The repos a search names (repo:owner/name, org:owner), or every one it can see.
const inScope = (q: string, slug: string) => {
  const repos = [...String(q).matchAll(/repo:(\S+)/g)].map((m) => m[1].toLowerCase());
  const orgs = [...String(q).matchAll(/org:(\S+)/g)].map((m) => m[1].toLowerCase());
  return (!repos.length && !orgs.length) || repos.includes(slug.toLowerCase()) || orgs.includes(slug.split("/")[0].toLowerCase());
};

// GraphQL's answer: what each part of the query asked for, by its name, and what went wrong.
interface Answer {
  data: Record<string, unknown> | null;
  errors?: { type: string; message: string }[];
}
function graphql(data: GhData, me: GhPerson, q: string, vars: Vars): { answer: Answer; changed: boolean } {
  const out: Answer = { data: {} };
  let changed = false;
  const visible = () => Object.entries(data.repos || {}).filter(([slug]) => sees(me, slug));
  const viewer: { login: string; name: string | null; repositories?: unknown } = /viewer/.test(q) ? { login: me.login, name: me.name || null } : undefined;
  if (viewer) out.data.viewer = viewer;
  // The connector's list of your repos: the ones the token lists (whether or not ghFile has more on them), else
  // every one, the latest pushed first, a page at a time.
  if (/repositories\(/.test(q)) {
    const all = (me.repos || Object.keys(data.repos || {})).map((slug) => ({ slug, ...(data.repos?.[slug] || {}) })).sort((a, b) => String(b.pushedAt || "").localeCompare(String(a.pushedAt || "")));
    const first = Number(q.match(/repositories\(first: (\d+)/)?.[1] || 100);
    const from = Number(vars.after || 0);
    const nodes = all.slice(from, from + first).map((r) => ({ nameWithOwner: r.slug, isPrivate: !!r.private, isFork: !!r.fork, isArchived: !!r.archived, pushedAt: r.pushedAt || null, description: r.description || null }));
    viewer.repositories = { totalCount: all.length, pageInfo: { hasNextPage: from + first < all.length, endCursor: String(from + first) }, nodes };
  }
  // The connector's: the issues assigned to you, and the pull requests waiting for your review.
  if (/issues: search\(/.test(q))
    out.data.issues = { nodes: visible().flatMap(([slug, r]) => (inScope(vars.issues, slug) ? (r.issues || []).filter((i) => (i.state || "OPEN") === "OPEN" && (i.assignees || []).includes(me.login)).map((i) => issueNode(slug, i)) : [])) };
  if (/reviews: search\(/.test(q))
    out.data.reviews = { nodes: visible().flatMap(([slug, r]) => (inScope(vars.reviews, slug) ? (r.pulls || []).filter((p) => p.state === "OPEN" && (p.reviewRequests?.nodes || []).some((x) => x.requestedReviewer?.login === me.login)).map((p) => pullNode(slug, p)) : [])) };
  // pulls.ts's: "repo:owner/name is:pr is:open author:@me …", or is:closed.
  if (/(open|done): search\(/.test(q)) {
    const slug = vars.q.match(/repo:(\S+)/)[1];
    const pulls = repoOf(data, me, slug)?.pulls || [];
    const open = /is:open/.test(vars.q);
    const nodes = pulls.filter((p) => (open ? p.state === "OPEN" : p.state !== "OPEN") && (!/author:@me/.test(vars.q) || p.author?.login === me.login));
    out.data[open ? "open" : "done"] = { nodes };
  }
  // The connector looking up what left its pull.
  const ids = q.match(/nodes\(ids: (\[[^\]]*\])\)/);
  if (ids)
    out.data.nodes = (JSON.parse(ids[1]) as string[]).map((id) => {
      for (const [slug, r] of visible()) {
        const i = (r.issues || []).find((x) => x.id === id);
        if (i) return issueNode(slug, i);
        const p = (r.pulls || []).find((x) => pullId(slug, x) === id);
        if (p) return pullNode(slug, p);
      }
      return null;
    });
  // Closing an issue, or opening it again.
  const change = q.match(/(closeIssue|reopenIssue)\(/);
  if (change) {
    const found = visible().map(([slug, r]): [string, GhIssue] => [slug, (r.issues || []).find((x) => x.id === vars.id)]).find(([, i]) => i);
    if (!found) return { answer: { data: null, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${vars.id}'` }] }, changed };
    Object.assign(found[1], change[1] === "closeIssue" ? { state: "CLOSED", stateReason: "COMPLETED" } : { state: "OPEN", stateReason: "REOPENED" }, { updatedAt: new Date().toISOString() });
    changed = true;
    out.data[change[1]] = { issue: issueNode(...found) };
  }
  // Answering a pull request: a reply on a review thread, resolving one or opening it again, a comment on the pull
  // request. A token with `write: false` (a GitHub App that may only read pull requests) is refused, as GitHub does.
  const write = q.match(/(addPullRequestReviewThreadReply|resolveReviewThread|unresolveReviewThread|addComment)\(/);
  if (write) {
    const op = write[1];
    const gone = (id: string): { answer: Answer; changed: boolean } => ({ answer: { data: { [op]: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${id}'` }] }, changed });
    if (me.write === false) return { answer: { data: { [op]: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }, changed };
    const now = new Date().toISOString();
    const n = Date.now() % 1e9;
    if (op === "addComment") {
      const found = visible().map(([slug, r]): [string, Pull] => [slug, (r.pulls || []).find((x) => pullId(slug, x) === vars.subject)]).find(([, x]) => x);
      if (!found) return gone(vars.subject);
      const [slug, p] = found;
      const c = { id: `IC_${n}`, databaseId: n, author: { __typename: "User", login: me.login }, body: vars.body, createdAt: now, url: `https://github.com/${slug}/pull/${p.number}#issuecomment-${n}` };
      p.allComments.nodes.push(c);
      p.comments.totalCount += 1;
      p.updatedAt = now;
      out.data.addComment = { commentEdge: { node: { id: c.id, url: c.url } } };
    } else {
      const found = visible().flatMap(([slug, r]) => (r.pulls || []).map((x): [string, Pull, number] => [slug, x, (x.threads?.nodes || []).findIndex((t) => t.id === vars.thread)])).find(([, , i]) => i >= 0);
      if (!found) return gone(vars.thread);
      const [slug, p, i] = found;
      const t = p.threads.nodes[i];
      if (op === "addPullRequestReviewThreadReply") {
        const c = { id: `PRRC_${n}`, databaseId: n, author: { __typename: "User", login: me.login }, body: vars.body, createdAt: now, url: `https://github.com/${slug}/pull/${p.number}#discussion_r${n}` };
        t.comments.nodes.push(c);
        out.data[op] = { comment: { id: c.id, url: c.url } };
      } else {
        t.isResolved = op === "resolveReviewThread";
        p.reviewThreads.nodes[i].isResolved = t.isResolved;
        out.data[op] = { thread: { id: t.id, isResolved: t.isResolved } };
      }
      p.updatedAt = now;
    }
    changed = true;
  }
  if (/repository\(/.test(q)) {
    const r = repoOf(data, me, `${vars.owner}/${vars.name}`);
    if (!r) {
      out.data.repository = null;
      out.errors = [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${vars.owner}/${vars.name}'.` }];
    } else {
      const repo: Record<string, unknown> = { nameWithOwner: `${vars.owner}/${vars.name}` };
      for (const m of q.matchAll(/p(\d+): pullRequest\(/g)) repo[`p${m[1]}`] = (r.pulls || []).find((p) => p.number === Number(m[1])) || null;
      // A branch's pull requests, newest first, and the repo's default branch.
      for (const m of q.matchAll(/(b\d+): pullRequests\(headRefName: \$(h\d+)/g)) repo[m[1]] = { nodes: (r.pulls || []).filter((p) => p.headRefName === vars[m[2]]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3) };
      if (/defaultBranchRef/.test(q)) repo.defaultBranchRef = { name: r.base || "main" };
      if (vars.number) {
        const p = (r.pulls || []).find((x) => x.number === vars.number);
        repo.pullRequest = p ? { ...p, id: pullId(`${vars.owner}/${vars.name}`, p) } : null;
      }
      out.data.repository = repo;
    }
  }
  return { answer: out, changed };
}
