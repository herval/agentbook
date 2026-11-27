// A stand-in for Linear's GraphQL API, for tests: it answers the queries connectors/linear.ts makes, by their
// operation names, from issues the test keeps in `issues` and changes as it likes. A personal API key goes in
// the Authorization header as it is, as Linear wants it; anything else is turned down the way Linear does.
// `key` is Herval's, and `others` are other people's keys, by their name: each signs in as its own person, so
// the issues assigned to "me" are Herval's, and those assigned to "alice" are hers, with her key.
//
// It's also Linear's OAuth side, for signing in with agentbook's Linear app (linear-app.ts): its consent page
// (/oauth/authorize) says yes at once, as `signinAs` (a person, or "deny" to say no), sending the browser back to a
// registered `redirects` address (or any its test says yes to) with a code; its token endpoint trades that code (PKCE, S256, with the app's
// `clientId` and no secret) and refresh tokens for tokens, each access token signing in as its person until it's
// signed out (`signOut`).

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const STATES: [id: string, name: string, type: string][] = [
  ["triage", "Triage", "triage"],
  ["backlog", "Backlog", "backlog"],
  ["todo", "Todo", "unstarted"],
  ["doing", "In Progress", "started"],
  ["review", "In Review", "started"],
  ["done", "Done", "completed"],
  ["shipped", "Shipped", "completed"],
  ["canceled", "Canceled", "canceled"],
];
// Each team's states, as `${team}-${id}`: "eng-todo".
export const stateId = (team: string, id: string): string => `${team.toLowerCase()}-${id}`;
const statesOf = (team: string) => STATES.map(([id, name, type], position) => ({ id: stateId(team, id), name, type, position }));
const stateById = (id: string) => {
  const [team] = id.split("-");
  return statesOf(team).find((s) => s.id === id);
};

// An issue: { id, identifier ("ENG-1"), title, team ("ENG"), state ("todo"), assignee ("me" for Herval, someone
// else, or null), priority (0-4), updatedAt }.
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  team: string;
  state: string;
  assignee: string | null;
  priority: number;
  updatedAt: string;
}
export function issue(team: string, n: number, title: string, extra: Partial<Issue> = {}): Issue {
  return { id: `issue-${team}-${n}`, identifier: `${team}-${n}`, title, team, state: "todo", assignee: "me", priority: 0, updatedAt: new Date(Date.now() - 3600e3).toISOString(), ...extra };
}

// What a query filters issues by, as connectors/linear.ts asks.
interface Filter {
  assignee?: { isMe?: { eq?: boolean } };
  state?: { type?: { in?: string[] } };
  team?: { key?: { in?: string[] } };
  id?: { in?: string[] };
}
interface Variables {
  filter?: Filter;
  after?: string;
  id?: string;
  stateId?: string;
}

export function startLinear({ key, page = 100, others = {}, clientId = "test-client", redirects = [] }: { key: string; page?: number; others?: Record<string, string>; clientId?: string; redirects?: string[] | ((uri: string) => boolean) }) {
  const issues: Issue[] = [];
  const calls: { op: string; variables: Variables; who: string }[] = [];
  let down = false; // answering 500 to everything
  // OAuth: who the consent page says yes as, its codes (code -> who, PKCE challenge, redirect), and the tokens it gave
  // (access -> who, refresh -> who), with every token request seen.
  const oauth = { signinAs: "me" as string, codes: new Map<string, { who: string; challenge: string; redirect_uri: string }>(), access: new Map<string, string>(), refresh: new Map<string, string>(), seen: [] as Record<string, string>[] };
  const token = (prefix: string) => `${prefix}${crypto.randomBytes(12).toString("hex")}`;
  const tokensFor = (who: string) => {
    const t = { access_token: token("lin_oauth_"), refresh_token: token("lin_refresh_"), token_type: "Bearer", expires_in: 86399, scope: "read write" };
    oauth.access.set(t.access_token, who);
    oauth.refresh.set(t.refresh_token, who);
    return t;
  };
  // Linear's token endpoint, as linear-app.ts asks it.
  const tokenAnswer = (p: Record<string, string>): [number, object] => {
    oauth.seen.push(p);
    if (p.client_id !== clientId || p.client_secret) return [401, { error: "invalid_client", error_description: "Client authentication failed" }];
    if (p.grant_type === "authorization_code") {
      const c = oauth.codes.get(p.code);
      oauth.codes.delete(p.code);
      if (!c || c.redirect_uri !== p.redirect_uri || crypto.createHash("sha256").update(p.code_verifier || "").digest("base64url") !== c.challenge) return [400, { error: "invalid_grant", error_description: "Invalid authorization code" }];
      return [200, tokensFor(c.who)];
    }
    if (p.grant_type === "refresh_token") {
      const who = oauth.refresh.get(p.refresh_token);
      oauth.refresh.delete(p.refresh_token);
      if (!who) return [400, { error: "invalid_grant", error_description: "Invalid refresh token" }];
      return [200, tokensFor(who)];
    }
    return [400, { error: "unsupported_grant_type" }];
  };
  // Who a key signs in as: "me" (Herval), or the name of someone else's.
  const people = new Map<string, string>([[key, "me"], ...Object.entries(others).map(([name, k]): [string, string] => [k, name])]);
  const node = (i: Issue, who: string) => {
    const s = stateById(stateId(i.team, i.state));
    return { id: i.id, identifier: i.identifier, title: i.title, url: `https://linear.app/acme/issue/${i.identifier}/${i.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, priority: i.priority, updatedAt: i.updatedAt, state: { id: s.id, name: s.name, type: s.type }, team: { key: i.team }, assignee: i.assignee ? { isMe: i.assignee === who } : null };
  };
  const matches = (i: Issue, f: Filter = {}, who: string) => {
    const s = stateById(stateId(i.team, i.state));
    if (f.assignee?.isMe?.eq === true && i.assignee !== who) return false;
    if (f.state?.type?.in && !f.state.type.in.includes(s.type)) return false;
    if (f.team?.key?.in && !f.team.key.in.includes(i.team)) return false;
    if (f.id?.in && !f.id.in.includes(i.id)) return false;
    return true;
  };
  const answer = (op: string, v: Variables, who: string) => {
    if (op === "AgentbookViewer") {
      const name = who === "me" ? "Herval" : who[0].toUpperCase() + who.slice(1);
      return { viewer: { name, email: `${name.toLowerCase()}@example.com` }, organization: { name: "Acme" } };
    }
    if (op === "AgentbookIssues" || op === "AgentbookLookup") {
      const all = issues.filter((i) => matches(i, v.filter, who)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const from = v.after ? Number(v.after) : 0;
      const size = op === "AgentbookIssues" ? page : 100;
      return { issues: { nodes: all.slice(from, from + size).map((i) => node(i, who)), pageInfo: { hasNextPage: from + size < all.length, endCursor: String(from + size) } } };
    }
    const i = issues.find((x) => x.id === v.id);
    if (op === "AgentbookDoneStates" || op === "AgentbookTodoStates") {
      if (!i) return { issue: null };
      const type = op === "AgentbookDoneStates" ? "completed" : "unstarted";
      const s = stateById(stateId(i.team, i.state));
      return { issue: { state: { id: s.id, type: s.type }, team: { states: { nodes: statesOf(i.team).filter((x) => x.type === type).reverse() } } } };
    }
    if (op === "AgentbookMove") {
      if (!i) return { issueUpdate: { success: false, issue: null } };
      i.state = v.stateId.slice(i.team.length + 1);
      i.updatedAt = new Date().toISOString();
      return { issueUpdate: { success: true, issue: node(i, who) } };
    }
    throw new Error(`fake Linear doesn't know ${op}`);
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (down) return send(500, { errors: [{ message: "Linear is down" }] });
      const url = new URL(req.url, "http://linear");
      if (url.pathname === "/oauth/authorize") {
        const q = Object.fromEntries(url.searchParams);
        if (q.client_id !== clientId || !(typeof redirects === "function" ? redirects(q.redirect_uri) : redirects.includes(q.redirect_uri)) || q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) return send(400, { error: "Invalid redirect_uri parameter for the application." });
        const back = new URL(q.redirect_uri);
        if (oauth.signinAs === "deny") back.search = new URLSearchParams({ error: "access_denied", state: q.state }).toString();
        else {
          const code = token("code_");
          oauth.codes.set(code, { who: oauth.signinAs, challenge: q.code_challenge, redirect_uri: q.redirect_uri });
          back.search = new URLSearchParams({ code, state: q.state }).toString();
        }
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === "/oauth/token") {
        const [status, body] = tokenAnswer(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
        return send(status, body);
      }
      const { query, variables }: { query: string; variables?: Variables } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const op = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1];
      const auth = req.headers.authorization || "";
      const who = people.get(auth) || (auth.startsWith("Bearer ") ? oauth.access.get(auth.slice(7)) : undefined);
      if (!who) {
        const why = auth.startsWith("Bearer lin_api_") ? "It looks like you're trying to use an API key as a Bearer token. Remove the Bearer prefix from the Authorization header." : "Authentication required, not authenticated";
        return send(400, { errors: [{ message: why, extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", userPresentableMessage: why } }] });
      }
      calls.push({ op, variables, who });
      try {
        send(200, { data: answer(op, variables || {}, who) });
      } catch (e) {
        send(400, { errors: [{ message: e.message }] });
      }
    });
  });
  interface Linear {
    url: string;
    web: string;
    oauth: typeof oauth;
    signOut(who: string): void;
    issues: Issue[];
    calls: typeof calls;
    stateOf(id: string): string | undefined;
    down(v: boolean): void;
    close(): void;
  }
  return new Promise<Linear>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`,
        web: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        oauth,
        // They took agentbook's access away in Linear: none of their tokens work any more.
        signOut: (who) => {
          for (const m of [oauth.access, oauth.refresh]) for (const [k, v] of m) if (v === who) m.delete(k);
        },
        issues,
        calls,
        stateOf: (id) => issues.find((i) => i.id === id)?.state,
        down: (v) => (down = v),
        close: () => server.close(),
      }),
    ),
  );
}
