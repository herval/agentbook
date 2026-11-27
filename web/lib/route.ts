// Where you are: the address after the # names a screen (parseRoute), and every link on the page is one of these
// addresses, so a reload, a link someone sends or Back opens the same screen. Old addresses still open what they did.
import { getApp, useApp, setApp } from "./store.ts";
import type { Route, Scope } from "./types.ts";

export const SCOPE_KEYS = ["agent", "workspace", "page", "group"] as const;
// An agent's profile tabs, each at an address of its own.
export const AGENT_TABS = ["threads", "about", "worktrees", "files", "skills", "routines"];
export function scopeOf(qs: string): Scope {
  const q = new URLSearchParams(qs);
  return Object.fromEntries(SCOPE_KEYS.map((k) => [k, [...new Set((q.get(k) || "").split(",").filter(Boolean))]])) as Scope;
}
export const NO_SCOPE: Scope = { agent: [], workspace: [], page: [], group: [] };
// The Feed's, Tasks' or Worktrees' address, narrowed to `scope`, with a status when one's picked.
const SCOPED = { feed: "#/", tasks: "#/tasks", worktrees: "#/worktrees" };
export function scopeHref(name: "feed" | "tasks" | "worktrees", scope: Scope = NO_SCOPE, status: string | null = null): string {
  const q = SCOPE_KEYS.filter((k) => scope[k]?.length).map((k) => `${k}=${scope[k].map(encodeURIComponent).join(",")}`);
  if (status && status !== "all") q.push(`status=${encodeURIComponent(status)}`);
  return `${SCOPED[name]}${q.length ? `?${q.join("&")}` : ""}`;
}

export function parseRoute(hash: string = location.hash): Route {
  const h = decodeURIComponent(hash.slice(1) || "/");
  let m;
  // Threads used to live at #/posts/, and before that #/sessions/, so old links still open them.
  // ?changes=<turn>: open on what that turn changed (a "Changed 3 files" line links there). ?ask=<question>: on
  // that question, in its conversation (Needs you's Answer links there). ?messages=all: at its whole conversation
  // (the feed's View all links there).
  if ((m = h.match(/^\/(?:threads|posts|sessions)\/([^?]+)(?:\?(.*))?$/))) {
    const q = new URLSearchParams(m[2] || "");
    return { name: "session", id: m[1], changes: q.get("changes"), at: q.get("at"), ask: q.get("ask"), msg: q.get("msg"), file: q.get("file"), convo: q.get("messages") === "all" };
  }
  // The Feed, Tasks and Worktrees say what the filter bar narrows them to: ?agent=<ids>&workspace=<ids>&page=<ids>, and
  // &status=<status>.
  const qs = hash.match(/\?(.*)$/)?.[1] || "";
  const scoped = (name: string) => ({ name, scope: scopeOf(qs), status: new URLSearchParams(qs).get("status") });
  // WIPs are tasks now: an old link to them, or to one, goes to Tasks.
  if (/^\/wip(?:\/w-[^/?]*)?\/?(?:\?.*)?$/.test(h)) return scoped("tasks");
  if (/^\/worktrees\/?(?:\?.*)?$/.test(h)) return scoped("worktrees");
  // A pull request's or a branch's page is its worktree's, where an old #/wip/<its id> goes.
  if ((m = h.match(/^\/(wip|worktrees)\/([^/?]+)/))) return { name: "worktree", id: m[2], old: m[1] === "wip" };
  if (/^\/(?:agents|people)\/?$/.test(h)) return { name: "agents" };
  if (/^\/agents\/new\/?$/.test(h)) return { name: "connect", code: "" };
  if ((m = h.match(/^\/agents\/([^/]+)\/skills\/(.+)$/))) return { name: "skill", id: m[1], skill: m[2] };
  if ((m = h.match(/^\/agents\/([^/]+)\/routines\/(.+)$/))) return { name: "routine", id: m[1], job: m[2] };
  // An agent's profile on one of its tabs (#/agents/<id>/worktrees), its threads at #/agents/<id>; its Worktrees
  // narrowed to one workspace with ?workspace=<id>.
  if ((m = h.match(/^\/agents\/([^/?]+)(?:\/([^/?]+))?/))) return { name: "agent", id: m[1], tab: AGENT_TABS.includes(m[2]) ? m[2] : "threads", workspace: new URLSearchParams(qs).get("workspace") || null };
  // One thing of someone's elsewhere, as their door sent it (#/people/<them>/things/<its id>).
  if ((m = h.match(/^\/people\/([^/?]+)\/things\/([^?]+)/))) return { name: "person", id: m[1], tab: "threads", thing: decodeURIComponent(m[2]) };
  if ((m = h.match(/^\/people\/([^/?]+)(?:\/(about|agents|pages|routines|workspaces|machines|settings))?(?:\/(agents|cloud-agents|passkeys|connectors))?/))) {
    const q = new URLSearchParams(qs);
    const open = q.get("open");
    const sub = m[2] === "settings" ? m[3] || null : null;
    const machine = q.get("machine");
    if (sub === "agents" || sub === "cloud-agents") {
      return { name: "person", id: m[1], tab: "agents", open: open || (sub === "cloud-agents" ? "cloud" : "add"), machine, old: true };
    }
    return { name: "person", id: m[1], tab: m[2] || "threads", sub, open, ...(m[2] === "agents" ? { machine } : {}) };
  }
  if ((m = h.match(/^\/machines\/([^/?]+)/))) return { name: "machine", id: m[1] };
  if ((m = h.match(/^\/connect(?:\?code=(.+))?$/))) return { name: "connect", code: m[1] || "" };
  if ((m = h.match(/^\/workspaces\/new\/?(?:\?(.*))?$/))) {
    const q = new URLSearchParams(qs);
    return { name: "addws", machine: q.get("machine"), ...(q.has("cloud") ? { cloud: q.get("cloud") } : {}) };
  }
  // Its Worktrees tab was its WIP tab (#/workspaces/<id>/wip).
  if ((m = h.match(/^\/workspaces\/([^/?]+)(?:\/(wip|worktrees))?\/?$/))) return { name: "workspace", id: m[1], tab: m[2] ? "worktrees" : "threads", old: m[2] === "wip" };
  if (/^\/groups\/?$/.test(h)) return { name: "groups" };
  // A group's tab; on Files, the file or folder that's open (`arg`), and a version of it (?v=).
  // A group's threads were in a bar beside it, as a page's are: a link to one opens the thread, to the bar the group.
  if ((m = h.match(/^\/groups\/([^/]+)\/threads(?:\/([^/?]+))?\/?$/))) return m[2] && !m[2].startsWith("launch:") ? { name: "session", id: m[2] } : { name: "group", id: m[1], tab: "group", arg: "", v: null };
  if ((m = h.match(/^\/groups\/([^/?]+)(?:\/(files|members|brief))?(?:\/([^?]*))?(?:\?v=(\d+))?\/?$/))) return { name: "group", id: m[1], tab: m[2] || "group", arg: (m[3] || "").replace(/\/$/, ""), v: m[4] || null };
  if (/^\/notes\/?$/.test(h)) return { name: "notes" };
  if ((m = h.match(/^\/notes\/([^/?]+)\/?$/))) return { name: "note", id: m[1] };
  if (/^\/pages\/?$/.test(h)) return { name: "pages" };
  if (/^\/dashboards\/?$/.test(h)) return { name: "dashboards" };
  // A page with one of its threads open in its threads bar (#/pages/:id/threads/:thread), or one just started there,
  // by its launch, until it has a thread (launch:<id>). #/pages/:id/threads is the page with the bar's list.
  // ?w=<widget>: at one of its widgets, which it scrolls to and flashes (a chip naming it links there). Any other
  // ?<filter>=<value> narrows the page by its filters (#/pages/reliability?service=erp-sync), its threads bar open or not.
  const w = new URLSearchParams(qs).get("w") || null;
  const filters = Object.fromEntries([...new URLSearchParams(qs)].filter(([k, v]) => k !== "w" && /^[\w-]{1,40}$/.test(k) && v));
  if ((m = h.match(/^\/pages\/([^/?]+)\/(?:threads|posts)(?:\/([^/?]+))?\/?(?:\?.*)?$/))) return { name: "page", id: m[1], tab: "page", thread: m[2] || null, bar: true, w, filters };
  if ((m = h.match(/^\/pages\/([^/?]+)(?:\/(versions|contributors|routines|at)(?:\/(\d+))?)?\/?(?:\?.*)?$/))) return { name: "page", id: m[1], tab: m[2] || "page", v: m[3] || null, w, filters };
  if (/^\/tasks\/?(?:\?.*)?$/.test(h)) return scoped("tasks");
  if ((m = h.match(/^\/tasks\/([^/?]+)\/?$/))) return { name: "task", id: m[1] };
  if (/^\/routines\/?$/.test(h)) return { name: "routines" };
  // New routine, opened from a thread or a page: ?thread=<id> or ?page=<id>.
  if ((m = h.match(/^\/routines\/new\/?(?:\?(.*))?$/))) {
    const q = new URLSearchParams(m[1] || "");
    return { name: "routines", form: { thread: q.get("thread") || "", page: q.get("page") || "" } };
  }
  if ((m = h.match(/^\/routines\/([^/?]+)/))) return { name: "myroutine", id: m[1] };
  if (/^\/connectors\/?$/.test(h)) return { name: "connectors" };
  if ((m = h.match(/^\/images\/([^/?]+)/))) return { name: "image", id: decodeURIComponent(m[1]) };
  return scoped("feed");
}

// Addresses of things.
const enc = encodeURIComponent;
export const threadHref = (id: string, q = "") => `#/threads/${enc(id)}${q ? `?${q}` : ""}`;
export const agentHref = (id: string | null, tab = "threads") => `#/agents/${enc(id ?? "~private")}${tab === "threads" ? "" : `/${tab}`}`;
export const personHref = (username: string, tab = "") => `#/people/${enc(username)}${tab ? `/${tab}` : ""}`;
export const theirThingHref = (username: string, id: string) => `#/people/${enc(username)}/things/${enc(id)}`;
export function setupHref(username: string, open = "", machine?: string) {
  const q = new URLSearchParams();
  if (open) q.set("open", open);
  if (machine) q.set("machine", machine);
  return personHref(username, "agents") + (q.size ? `?${q}` : "");
}
export const pageHref = (p: { id: string } | string, tab = "") => `#/pages/${enc(typeof p === "string" ? p : p.id)}${tab ? `/${tab}` : ""}`;
export const taskHref = (t: { id: string } | string) => `#/tasks/${enc(typeof t === "string" ? t : t.id)}`;
export const noteHref = (n: { id: string } | string) => `#/notes/${enc(typeof n === "string" ? n : n.id)}`;
export const groupHref = (g: { id: string } | string, tab = "") => `#/groups/${enc(typeof g === "string" ? g : g.id)}${tab && tab !== "group" ? `/${tab}` : ""}`;
export const workspaceHref = (id: string, tab = "") => `#/workspaces/${enc(id)}${tab && tab !== "threads" ? `/${tab}` : ""}`;
export const worktreeHref = (id: string) => `#/worktrees/${enc(id)}`;
export const machineHref = (name: string) => {
  const me = getApp().me?.username;
  return me ? setupHref(me, "", name) : `#/machines/${enc(name)}`;
};
export const connectorsHref = () => {
  const me = getApp().me?.username;
  return me ? personHref(me, "settings/connectors") : "#/connectors";
};
export const routineHref = (id: string) => `#/routines/${enc(id)}`;

// Go somewhere: the address changes, and the page follows it (main.tsx listens for hashchange).
export function go(href: string) {
  if (location.hash === href || (href === "#/" && !location.hash)) return;
  location.hash = href;
}
// The address changed (a link, Back, go()): the route follows it.
export function followHash() {
  const route = parseRoute();
  setApp({ route });
}
export const useRoute = () => useApp((s) => s.route);
