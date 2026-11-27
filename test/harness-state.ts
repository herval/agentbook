// What a person's page has, put together from the page's API, for tests that look at it
// whole: the chrome (q/side) and every thread they may see, as the feed's cards (q/feed: its threads, Hidden's and
// Archived's, and your hidden agents' too, page by page). { status, agents, pages, groups, machines,
// workspaces, tasks, routines, connectors, questions, launches, folders, machine, github, preview, cloning, sessions, live, text }.
//
// `get(path)`: a GET as that person, answering the parsed JSON (with `status`, as the tests' helpers do).

import type { Json } from "./harness-types.ts";

const KINDS: Record<string, string> = { agent: "agents", page: "pages", note: "notes", group: "groups", machine: "machines", workspace: "workspaces", task: "tasks", routine: "routines", connector: "connectors", question: "questions", launch: "launches", folder: "folders" };

export async function stateOf(get: (path: string) => Promise<Json>): Promise<Json> {
  const side: Json = await get("/api/q/side");
  if (!side?.records) return side;
  const out: Json = { status: side.status ?? 200, ...side.data };
  for (const [kind, list] of Object.entries(KINDS)) out[list] = (side.order[kind] || []).map((k: string) => side.records[k]);
  const sessions = new Map<string, Json>();
  const live: Record<string, Json> = {};
  const hidden: string[] = out.agents.filter((a: Json) => a.mine !== false && a.hidden).map((a: Json) => a.id);
  // Each list at once, so asking takes about as long as one request did (some tests look at timing around it).
  const lists = ["", ...hidden.map((id) => `&agent=${encodeURIComponent(id)}`)].flatMap((scope) => ["all", "hidden", "archived"].map((filter) => `filter=${filter}${scope}`));
  const pages = await Promise.all(
    lists.map(async (list) => {
      const got: Json[] = [];
      let after: string | null = null;
      do {
        const q: Json = await get(`/api/q/feed?${list}&n=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        got.push(q);
        after = q.next;
      } while (after);
      return got;
    }),
  );
  for (const q of pages.flat()) {
    for (const k of q.list || []) if (k.startsWith("thread:")) sessions.set(k.slice(7), q.records[k]);
    Object.assign(live, q.live || {});
  }
  // Latest first, as the whole view had them.
  out.sessions = [...sessions.values()].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  out.live = live;
  // And all of it as text, as a request's answer has it, for what looks for something that mustn't be there.
  out.text = JSON.stringify(out);
  return out;
}
