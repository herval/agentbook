import path from "node:path";
import { agentPublic, pageFor, postPublic, seenAt } from "../policy.ts";
import { isLevel } from "../../plugin/shared/visibility.ts";
import { localPicture, names, picture } from "../../plugin/shared/pictures.ts";
import { contributes, filterInputs, outline, pageDetail, pageId, postPages, taskItems, widgetFrom } from "../../plugin/shared/pages.ts";
import { AGENT_MAX, pageAdvice } from "../../plugin/shared/page-shape.ts";
import { WIDGET_HEADERS, widgetDocument } from "../page-frame.ts";
import { dashFrom, isPanel, isPanelType, panelFrom } from "../../plugin/shared/dashboards.ts";
import { everyText } from "../../plugin/shared/routines.ts";
import type { User } from "../accounts.ts";
import type { Device } from "../relay.ts";
import type { Iso, Page } from "../../plugin/shared/types.ts";
import { accounts, blobs, commit, firstAdmin, relay, state } from "../core/state.ts";
import { fail, isColor, ok, readBody, route, str } from "../core/http.ts";
import { elsewhere } from "../core/elsewhere.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { Asker, Reply } from "../core/types.ts";
import { agentRef, agentsById, allPosts, isOwner, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { contactOf, isContact, notContact, seesPost } from "../core/follows.ts";
import { dashboards, live } from "../core/services.ts";
import { TASKS_DONE_MS, rowsFor } from "./views.ts";
import { SELF_URL, titleOf } from "./cli.ts";
import { sendWebPicture, webPictures } from "./queries.ts";
import { alike, inWorkspace, onTaskPage, pagesOfTask, postLabel, taskId, tickForAgent } from "./tasks.ts";
import { routines } from "./routines.ts";
import { blobOk, byYou } from "./groups.ts";
import { writesPages } from "./launch.ts";

// A page's widgets as they're written, by hand or by an agent (pageWrite): the ones to add or change, the ones to take
// off (`remove`, by id), their order, and the page's own title, emoji, about and summary.
interface PageWriteBody {
  widgets?: { id?: string; type?: string; [field: string]: unknown }[] | null;
  remove?: unknown;
  order?: unknown;
  title?: string;
  emoji?: string;
  about?: string | null;
  summary?: string;
}

/* ---------- pages (pages.ts): agents write them with ab_page_*, people by hand ---------- */

// A page's owner: the person whose agent made it, or who made it by hand (the first admin's, for one from before).
export const pageOwner = (p: Pick<Page, "owner">) => p.owner || firstAdmin()?.id || null;
export const pageOwnerName = (p: Page) => accounts.byId(pageOwner(p))?.username || "";
export const pageMine = (req: Viewer, p: Page) => !!req.user && pageOwner(p) === req.user.id;
export const pageLink = (id: string) => `${SELF_URL}/#/pages/${encodeURIComponent(id)}`;
// A page this request may see, without answering for it.
export const pageSeen = (req: Viewer, id: string) => {
  const p = state.pages[id];
  return !!p && (pageMine(req, p) || contributes(p, { user: viewerName(req) }) || (seenAt(p.visibility, isContact(req, pageOwner(p))) && !p.archived));
};
// The pages a person may see, by id: what a message or a prompt of theirs may name (mentions.ts).
export const pagesSeenBy = (user: User | null) => Object.fromEntries(Object.entries(state.pages).filter(([id]) => pageSeen({ user }, id)));
// Every machine's launches for pages, by the page's ids (`page`: one page's only).
function pageLaunches(page: string | null = null) {
  const out: { id: string; page: string; post: string; agent: string; at: Iso }[] = [];
  for (const D of relay.devices.values())
    for (const l of Object.values(D.store.state.launches)) if (l.page && l.post && (!page || l.page === page)) out.push({ id: relay.idOf(D, l.id), page: l.page, post: relay.idOf(D, l.post), agent: relay.idOf(D, l.agent), at: l.at });
  return out;
}
// The page each thread is on, by the page's ids: the one its person put it on, or it was started from, or made, or
// changed last (pages.ts), over every machine's launches.
export const threadPages = () => postPages({ launches: pageLaunches(), page_versions: state.page_versions, pages: state.pages, page_posts: state.page_posts });
// A page this request may see ("see"), change ("edit": its owner or a contributor), or say who sees and changes
// it ("manage": its owner): the page, or a 404 (not visible) or 403 (visible, not theirs) sent.
export function pageOr404(req: Viewer, res: Res, id: string, need = "see") {
  const p = state.pages[id];
  const mine = !!p && pageMine(req, p);
  const editor = !!p && contributes(p, { user: viewerName(req) });
  if (!p || !(mine || editor || (seenAt(p.visibility, isContact(req, pageOwner(p))) && !p.archived))) return void fail(res, 404, "No such page");
  if (need === "edit" && !mine && !editor) return void fail(res, 403, "Only its contributors can change it.");
  if (need === "manage" && !mine) return void fail(res, 403, "Only its owner can do that.");
  return p;
}
// Which threads it names they may see (seesPost): their own, public ones of their contacts', and the ones shared with
// them.
const asSeen = (req: Viewer, p: Page) => pageFor(p, agentsById(), pageMine(req, p), pageOwnerName(p), viewerName(req), (id) => seesPost(req, postRef(id)), isContact(req, pageOwner(p)));
// A page an agent of a machine reaches: its person's own, ones they contribute to, and public ones of their contacts'.
export const pageReachable = (p: Page, o: User) => pageOwner(p) === o.id || contributes(p, { user: o.username }) || seenAt(p.visibility, contactOf(o.id, pageOwner(p)));

// What a write asks for, checked and merged over the page as it is: its widgets, whole, and the rest as given.
// It throws with what's wrong in all of its widgets at once, and says what was cut or left out of them (`notes`).
// An agent's write (`agent`) can't take a page past AGENT_MAX widgets; one that's past it already can still be
// kept up to date, and made smaller.
export function pageWrite(p: Page | null, b: PageWriteBody, { agent = false } = {}) {
  const list = b.widgets == null ? [] : b.widgets;
  if (!Array.isArray(list)) throw new Error("widgets is a list of widgets: [{ id, type, title, data }].");
  const byId = new Map((p?.widgets || []).map((w) => [w.id, w]));
  const seen = new Set();
  const tasks = []; // what a tasks widget (or a checklist) puts on the page's tasks: { widget, items }
  const notes = [];
  const wrong = [];
  const widgets = list.flatMap((w) => {
    let out;
    try {
      out = widgetFrom(w, byId.get(String(w?.id ?? "").trim().slice(0, 60)), notes);
    } catch (e) {
      wrong.push(e.message);
      return [];
    }
    if (seen.has(out.id)) throw new Error(`Two widgets have the id "${out.id}".`);
    seen.add(out.id);
    if (out.type === "tasks" && taskItems(w).length) tasks.push({ widget: out.id, items: taskItems(w) });
    return [out];
  });
  if (wrong.length) throw new Error(`Nothing was saved:\n${wrong.join("\n")}`);
  const remove = Array.isArray(b.remove) ? b.remove.map((id) => str(id, 60)) : [];
  const ids = new Set([...(p?.widgets || []).map((w) => w.id), ...widgets.map((w) => w.id)]);
  for (const id of remove) ids.delete(id);
  if (ids.size > 60) throw new Error("A page holds up to 60 widgets.");
  if (agent && ids.size > AGENT_MAX && ids.size > (p?.widgets?.length || 0))
    throw new Error(`Nothing was saved: this write would give the page ${ids.size} widgets, and an agent can't take a page past ${AGENT_MAX}. Fold what you have into the widgets that are there (a row, a column, a line) and take some off with remove, in the same write.`);
  return {
    widgets,
    remove,
    order: Array.isArray(b.order) ? b.order.map((id) => str(id, 60)) : null,
    title: b.title ? str(b.title, 120).trim() : undefined,
    emoji: b.emoji ? str(b.emoji, 16).trim() : undefined,
    about: b.about != null ? str(b.about, 600) : undefined,
    summary: b.summary ? str(b.summary, 200) : undefined,
    tasks,
    notes,
  };
}

// --- you, from the web UI ---
route("GET", "/api/pages/:id", (req, res, { params }) => {
  if (!pageOr404(req, res, params.id)) return;
  const d = asSeen(req, pageDetail({ ...state, launches: pageLaunches(params.id) }, params.id));
  // Rows of its threads (the archived ones too, which the chrome has none of).
  const onPage = (id) => (id && params.id.includes("~") && !String(id).includes("~") ? `${params.id.split("~")[0]}~${id}` : id);
  const ids = new Set((d.posts || []).map((x) => onPage(x.post)));
  // One its person put on a page by hand, or took off, is where they put it, whatever it changed (its versions still
  // say it did).
  ok(res, { ...d, threads: rowsFor(req, (s) => s.page === params.id || (ids.has(s.id) && !state.page_posts?.[s.id])) });
});
route("GET", "/api/pages/:id/versions/:v", (req, res, { params }) => {
  const p = pageOr404(req, res, params.id);
  if (!p) return;
  const v = state.page_versions.find((x) => x.page === p.id && x.v === Number(params.v));
  if (!v) return fail(res, 404, "That version isn't kept any more.");
  ok(res, asSeen(req, { ...p, ...v, id: p.id, version: p.version }));
});
// A picture from elsewhere on the web in a page as it is or was (see /api/sessions/:id/picture).
route("GET", "/api/pages/:id/picture", async (req, res, { params, query }) => {
  const p = pageOr404(req, res, params.id);
  if (!p) return;
  const url = String(query.get("url") || "");
  if (!names([p.about, p.widgets], url) && !names(state.page_versions.filter((v) => v.page === p.id).map((v) => v.snapshot), url)) return fail(res, 404, "This page has no such picture.");
  const notSent = () => Promise.reject(Object.assign(new Error("That picture is on its agent's machine, which didn't send it with the page."), { status: 404 }));
  await sendWebPicture(res, `page-${p.id}`, url, query, localPicture(url) ? notSent : null);
});
// A widget of its own, as the document its frame shows: as it is, or as it was when it last changed at version v
// (in an older version of the page). Sandboxed, with no network (page-frame.ts).
route("GET", "/api/pages/:id/frame/:wid", (req, res, { params, query }) => {
  const p = pageOr404(req, res, params.id);
  if (!p) return;
  const v = Number(query.get("v")) || null;
  const mine = (list) => (list || []).find((x) => x.id === params.wid && x.type === "html" && (!v || x.v === v));
  const w = mine(p.widgets) || (v ? state.page_versions.filter((x) => x.page === p.id).map((x) => mine(x.snapshot.widgets)).findLast(Boolean) : null);
  if (!w) return fail(res, 404, "No such widget, or it isn't kept as it was then.");
  res.writeHead(200, WIDGET_HEADERS);
  res.end(widgetDocument(w));
});
// A page's live routines, run while it's open (routines.ts liveRun), on one of its owner's machines: what each
// returned for the filters picked on it, and when. Its owner and contributors run them; someone else who sees it
// gets what was last kept for those filters. A widget of its own asks the routine that keeps it, with its own params.
route("POST", "/api/pages/:id/live", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id);
  if (!p) return;
  const b = await readBody<{ widget?: string; params?: unknown; filters?: unknown }>(req);
  const widget = b.widget ? str(b.widget, 60) : null;
  let asked = {};
  if (widget && b.params && typeof b.params === "object" && !Array.isArray(b.params)) {
    if (JSON.stringify(b.params).length > 4096) return fail(res, 400, "What it asks with is over 4 KB.");
    asked = b.params;
  }
  const inputs = { ...filterInputs(p, b.filters), params: asked };
  const fresh = pageMine(req, p) || contributes(p, { user: viewerName(req) });
  const live = Object.values(state.routines).filter((r) => r.page === p.id && !r.archived && r.schedule?.kind === "live" && r.on && r.live_v && (!widget || r.keeps.includes(widget)));
  const out = await Promise.all(live.map(async (r) => ({ id: r.id, name: r.name, every: r.schedule.everyMs, keeps: r.keeps, ...((await routines.liveRun(r.id, inputs, { fresh })) || { at: null, widgets: null }) })));
  ok(res, { routines: out });
});
// A dashboard's panels for the range and variables you picked (dashboards.ts), as its owner's connectors answer
// them: anyone who sees it asks, and an answer is kept a minute or so for everyone. With `live` (the page's stream),
// the panels answered at once come back now, and each of the rest comes on the stream as a `panel` event as it's
// answered (`key`: the view it asked for, said back); without, it waits for all of them.
route("POST", "/api/pages/:id/panels", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id);
  if (!p) return;
  if (p.kind !== "dashboard") return fail(res, 400, "It isn't a dashboard.");
  const b = await readBody<{ vars?: unknown; range?: string; from?: string | number; to?: string | number; compare?: boolean; panels?: unknown; live?: unknown; key?: string }>(req);
  const vars = b.vars && typeof b.vars === "object" && !Array.isArray(b.vars) ? Object.fromEntries(Object.entries(b.vars).slice(0, 8).map(([k, v]) => [str(k, 40), Array.isArray(v) ? v.slice(0, 100).map((x) => str(x, 80)) : str(v, 80)])) : {};
  const asked = { range: b.range ? str(b.range, 10) : undefined, from: b.from ?? undefined, to: b.to ?? undefined, vars, compare: !!b.compare };
  const ids = Array.isArray(b.panels) ? b.panels.map((x) => str(x, 60)) : null;
  const liveId = typeof b.live === "string" ? b.live : null;
  const key = str(b.key, 400);
  const onPanel = liveId && live.pageOf(req, liveId) ? (a) => live.tell(req, liveId, "panel", { page: p.id, key, panel: a }) : null;
  try {
    ok(res, await dashboards.run(p, asked, { ids, onPanel }));
  } catch (e) {
    fail(res, 400, e.message);
  }
});
// What you decide on a page without editing it: OK what one of a list's items asks your OK for (ask: "ok"), or say
// not now; pick one of its options (or take the pick back). Each is a version by you, said in words, and a decision
// the thread that asked is waiting on (the one that last wrote the widget), so the answer names it and what to tell
// it; the page sends that as your message, which wakes it if it ended. (A page's checklist is your tasks, ticked as
// tasks are.)
route("POST", "/api/pages/:id/act", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "edit");
  if (!p) return;
  if (p.archived) return fail(res, 400, `"${p.title}" is archived.`);
  const b = await readBody<{ act?: string; widget?: string; item?: { text?: string; i?: number } }>(req);
  const act = String(b.act || "");
  const w = p.widgets.find((x) => x.id === str(b.widget, 60));
  const fits = w && ((w.type === "list" && ["ok", "no"].includes(act)) || (w.type === "options" && ["pick", "unpick"].includes(act)));
  if (!fits) return fail(res, 400, "There's nothing to do that to.");
  const items = (w.data?.items || []).map((it) => ({ ...it }));
  const key = w.type === "options" ? "name" : "text";
  const want = str(b.item?.text, 500);
  let i = Number(b.item?.i);
  if (!(items[i] && items[i][key] === want)) i = items.findIndex((it) => it[key] === want);
  if (i < 0) return fail(res, 409, "That changed since you looked. Look again.");
  const it = items[i];
  const who = viewerName(req);
  const q = (t) => `“${String(t).length > 90 ? `${String(t).slice(0, 89)}…` : t}”`;
  let summary;
  if (act === "ok" || act === "no") {
    if (it.ask !== "ok") return fail(res, 400, "It doesn't ask for an OK.");
    Object.assign(it, { ok: act === "ok", ok_by: who, ok_at: new Date().toISOString() });
    summary = act === "ok" ? `OK'd ${q(it.text)}` : `Said not now to ${q(it.text)}`;
  } else {
    items.forEach((x, j) => (j === i && act === "pick" ? (x.chosen = true) : delete x.chosen));
    summary = act === "pick" ? `Picked ${q(it.name)}` : `Took back the pick of ${q(it.name)}`;
  }
  const asker = act === "unpick" ? null : askerOf(p, w.id, req);
  const before = p.version;
  commit({ t: "page.write", pid: p.id, by: { user: who }, hand: true, widgets: [widgetFrom({ id: w.id, data: { items } }, w)], summary });
  const what = act === "ok" ? `I OK'd ${q(it.text)}` : act === "no" ? `I said not now to ${q(it.text)}` : `I picked ${q(it.name)} in ${q(w.title || "the options")}`;
  ok(res, { version: p.version, changed: p.version !== before, tell: asker ? { post: asker, text: `${what}, on the page ${q(p.title)}: ${pageLink(p.id)}` } : null });
});
// The thread that last wrote a widget, the one that put a question or options on it: when it's one the person
// deciding owns (the page sends it their answer as their message).
function askerOf(p: Page, wid: string, req: Viewer) {
  const w = p.widgets.find((x) => x.id === wid);
  const post = w?.by?.post || state.page_versions.filter((v) => v.page === p.id && v.by?.post && v.changes?.some((c) => c.id === wid)).at(-1)?.by.post;
  const r = post && postRef(post);
  return r && isOwner(req, r.D) ? post : null;
}
// A page you start by hand. Most are made by agents, asked to in a post.
route("POST", "/api/pages", async (req, res) => {
  const b = await readBody<{ title?: string; emoji?: string; about?: string; color?: string }>(req);
  const title = str(b.title, 120).trim();
  if (!title) return fail(res, 400, "A page needs a title.");
  const pid = pageId(title, (id) => !!state.pages[id]);
  commit({ t: "page.create", pid, title, emoji: b.emoji ? str(b.emoji, 16) : undefined, about: str(b.about, 600), color: isColor(b.color) ? b.color : null, by: { user: viewerName(req) }, owner: req.user.id, contributors: [], widgets: [], hand: true });
  ok(res, { id: pid });
});
route("POST", "/api/pages/:id/write", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "edit");
  if (!p) return;
  const b = await readBody<PageWriteBody>(req);
  // A dashboard's panels are their queries, which an agent writes: by hand, only its title, words and order.
  if (p.kind === "dashboard" && (b.widgets || []).some((w) => isPanelType(w?.type) || isPanel(p.widgets.find((x) => x.id === w?.id)))) return fail(res, 400, "A dashboard's panels are their queries: ask one of its agents to change them.");
  const { tasks: _, notes: __, ...w } = pageWrite(p, b);
  const before = p.version;
  commit({ t: "page.write", pid: p.id, by: { user: viewerName(req) }, hand: true, ...w });
  ok(res, { version: p.version, changed: p.version !== before });
});
route("POST", "/api/pages/:id/restore", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "edit");
  if (!p) return;
  const v = Number((await readBody<{ v?: number }>(req)).v);
  if (!state.page_versions.some((x) => x.page === p.id && x.v === v)) return fail(res, 404, "That version isn't kept any more.");
  const before = p.version;
  commit({ t: "page.restore", pid: p.id, v, by: { user: viewerName(req) } });
  ok(res, { version: p.version, changed: p.version !== before });
});
route("POST", "/api/pages/:id/visibility", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "manage");
  if (!p) return;
  // Who sees it. Its people (its owner and contributors) always see the work of the threads on it.
  const { visibility } = await readBody<{ visibility?: string }>(req);
  if (!isLevel(visibility)) return fail(res, 400, "Private or public?");
  commit({ t: "page.visibility", pid: p.id, visibility });
  ok(res);
});
route("POST", "/api/pages/:id/color", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "manage");
  if (!p) return;
  commit({ t: "page.color", pid: p.id, color: (await readBody<{ color?: string | null }>(req)).color || null });
  ok(res);
});
// Add a contributor (an agent of the page's owner, or a person with an account here), or take one off.
route("POST", "/api/pages/:id/contributors", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "manage");
  if (!p) return;
  const b = await readBody<{ agent?: string; user?: string; remove?: boolean }>(req);
  let who;
  if (b.agent) {
    const a = agentRef(b.agent);
    // Its owner's agents: someone else's agent would write it as they please.
    if (!b.remove && (!a || ownerOf(a.D)?.id !== pageOwner(p))) return fail(res, 404, "No such agent of yours.");
    if (a && !b.remove && !writesPages(a.a.kind)) return fail(res, 400, `${a.a.name} can't write pages: it doesn't have agentbook's tools.`);
    who = { agent: String(b.agent) };
  } else if (b.user) {
    const u = accounts.byUsername(b.user);
    if (!u) return fail(res, 404, "No one with that username here.");
    if (u.id === pageOwner(p)) return fail(res, 400, "That's its owner, who can always change it.");
    const stranger = b.remove ? null : notContact(pageOwner(p), u);
    if (stranger) return fail(res, 409, stranger);
    const asked = elsewhere.ask(`page:${p.id}`, p.title, u.id, !!b.remove);
    if (asked) return asked.error ? fail(res, asked.status || 400, asked.error) : ok(res, asked);
    who = { user: u.username };
  } else return fail(res, 400, "Say which agent or user.");
  commit({ t: "page.contributor", pid: p.id, who, remove: !!b.remove, by: viewerName(req) });
  // A person taken off takes their agents with them: they put those on it, starting threads there.
  if (b.remove && who.user) {
    const uid = accounts.byUsername(who.user)?.id;
    for (const c of p.contributors || []) if (c.agent && c.role !== "made" && uid && agentRef(c.agent) && ownerOf(agentRef(c.agent).D)?.id === uid) commit({ t: "page.contributor", pid: p.id, who: { agent: c.agent }, remove: true, by: viewerName(req) });
  }
  ok(res);
});
route("POST", "/api/pages/:id/archive", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "manage");
  if (!p) return;
  commit({ t: "page.archive", pid: p.id, archived: !!(await readBody<{ archived?: boolean }>(req)).archived });
  ok(res);
});
// Put one of your threads on the page, moving it off the one it's on, or take it off (`remove`): by hand, ahead of
// the page it worked out (postPages), and its agent hears so with its next message (pageNewsFor). On a page of
// yours, its agent becomes one of the page's contributors, as for a thread started there (POST /api/launch).
route("POST", "/api/pages/:id/threads", async (req, res, { params }) => {
  const p = pageOr404(req, res, params.id, "edit");
  if (!p) return;
  const b = await readBody<{ post?: string; remove?: boolean }>(req);
  const t = b.post ? postRef(str(b.post, 300)) : null;
  if (!t || !isOwner(req, t.D)) return fail(res, 404, "No such thread of yours.");
  const on = threadPages()[t.id] || null;
  // Its machine hears where it is, so it asks for its news (pageNewsFor) with its next message.
  const tell = (pid) => relay.command(t.D, "post.page", { post: t.local, pid }, { by: viewerName(req), wait: 15e3 }).catch(() => null);
  if (b.remove) {
    if (on === p.id) {
      commit({ t: "page.post", post: t.id, pid: null, was: p.id, by: byYou(req) });
      await tell(null);
    }
    return ok(res);
  }
  if (p.archived) return fail(res, 400, `"${p.title}" is archived. Bring it back to put threads on it.`);
  const aid = t.s.agent ? relay.idOf(t.D, t.s.agent) : null;
  if (aid && writesPages(t.agent?.kind) && !contributes(p, { agent: aid })) commit({ t: "page.contributor", pid: p.id, who: { agent: aid }, by: viewerName(req) });
  if (on !== p.id) {
    commit({ t: "page.post", post: t.id, pid: p.id, was: on, by: byYou(req) });
    await tell(p.id);
  }
  ok(res);
});
// A thread its person put on a page by hand, or took off one, hears so with its next message, once.
export function pageNewsFor(post: string) {
  const m = state.page_posts?.[post];
  if (!m || m.told) return null;
  commit({ t: "page.told", post });
  const p = postRef(post);
  const pg = state.pages[m.page || m.was];
  if (!p || !pg) return null;
  const o = ownerOf(p.D);
  const person = o?.display_name || o?.username || "The person";
  if (!m.page) return `${person} took this thread off the page "${pg.title}" (${pg.id}): it isn't one of the page's threads any more.`;
  const aid = p.s.agent ? relay.idOf(p.D, p.s.agent) : null;
  const edit = !!aid && contributes(pg, { agent: aid });
  return `${person} put this thread on the page "${pg.title}" (${pg.id}, v${pg.version}): it's one of the page's threads now. ab_page_read reads it${edit ? `; ab_page_write with page: "${pg.id}" changes it` : "; you can't change it"}.`;
}
// Where a post that changes a page starts, on a machine: where its latest post there with a folder worked, or the
// machine's home folder (it decides).
export function pageRoot(id: string, D: Device) {
  const posts = state.page_versions.filter((v) => v.page === id && v.by?.post).map((v) => postRef(v.by.post)).filter((p) => p && (!D || p.D === D)).reverse();
  return posts.find((p) => p.s.root)?.s.root || null;
}

// --- agents, through their machine (ab_page_list, ab_page_read, ab_page_write) ---
// An agent reads its person's pages and the ones it may see, and changes the ones it contributes to.
export const pageForAgent = (p: Page, agent) => ({ id: p.id, ...(p.kind ? { kind: p.kind } : {}), title: p.title, emoji: p.emoji, about: p.about, visibility: p.visibility, version: p.version, updated: p.updated, url: pageLink(p.id), can_edit: contributes(p, { agent }), archived: !!p.archived, contributors: p.contributors.map((c) => (c.agent ? agentRef(c.agent)?.a.name || c.agent : `@${c.user}`)) });
function pageReadForAgent(D: Device, o: User, me: Asker, id: string) {
  const p = state.pages[id];
  if (!p || !pageReachable(p, o)) return { error: `No page "${id}". ab_page_list lists them.`, status: 404 };
  const versions = state.page_versions.filter((v) => v.page === p.id).slice(-10).reverse().map((v) => ({ v: v.v, at: v.at, by: versionBy(v.by, me.post, o), summary: v.summary }));
  // Which routine keeps each widget it does: a write to one is overwritten on that routine's next run.
  const keptBy = {};
  for (const r of Object.values(state.routines)) if (r.page === p.id && !r.archived) for (const wid of r.keeps) keptBy[wid] = `${r.name} (routine "${r.id}", ${everyText(r.schedule)}${r.live_v && r.on ? "" : ", not running"})`;
  // A tasks widget shows the person's tasks on the page: they're its items.
  const items = p.widgets.some((w) => w.type === "tasks") ? pageTaskRows(o.id, p.id, me.agent) : null;
  // A dashboard's panels are their queries (no numbers): dashboardReadForAgent adds what they answer.
  if (p.kind === "dashboard") return { ...pageForAgent(p, me.agent), dash: p.dash, versions, panels: p.widgets.map(({ id: wid, type, title, width, stack, data, query, shape, thresholds, markers }) => ({ id: wid, type, title, width, ...(stack ? { stack } : {}), ...(query ? { query, shape, ...(thresholds ? { thresholds } : {}), ...(markers ? { markers } : {}) } : { data }) })) };
  return { ...pageForAgent(p, me.agent), versions, widgets: p.widgets.map(({ id: wid, type, title, width, stack, data }) => ({ id: wid, type, title, width, ...(stack ? { stack } : {}), ...(keptBy[wid] ? { kept_by: keptBy[wid] } : {}), data: type === "tasks" ? { items } : data })) };
}
// A dashboard as an agent reads it: its panels, and what each answered for the range it opens on (kept a minute or
// so for everyone, so reading it again soon asks nothing).
export async function dashboardReadForAgent(D: Device, o: User, me: Asker, id: string) {
  const r = pageReadForAgent(D, o, me, id);
  const p = state.pages[id];
  if ("error" in r || !("panels" in r) || p?.kind !== "dashboard") return r;
  const ran = await dashboards.run(p, {});
  const said = new Map(ran.panels.map((a) => [a.id, a]));
  return { ...r, view: ran.view, panels: r.panels.map((x) => (said.has(x.id) ? { ...x, answer: answerForAgent(said.get(x.id)) } : x)) };
}
// What a panel answered, as an agent reads it: what it drew, and how it went.
function answerForAgent(a) {
  return { ...(a.data ? { data: a.data.x ? { ...a.data, x: a.data.x.length > 12 ? [...a.data.x.slice(0, 3), `…${a.data.x.length - 6} more…`, ...a.data.x.slice(-3)] : a.data.x, times: undefined } : a.data } : {}), ...(a.error ? { error: a.error } : {}), ...(a.stale ? { stale: `the last good answer, from ${a.at}` } : {}), ...(a.notes?.length ? { notes: a.notes } : {}), ms: a.ms, source: a.source?.id, ...(a.link ? { link: a.link } : {}) };
}
// What a panel drew in its test run, in a line: "3 series of 96 points: core-api, ledger, erp-sync (812 ms)".
function testLine(w, a) {
  if (a.error && !a.stale) return `${w.id}: failed: ${a.error}`;
  const d = a.data || {};
  const drew = w.type === "metric" ? `${d.value}${d.unit ? ` ${d.unit}` : ""}${d.change ? ` (${d.change})` : ""}${d.status ? `, ${d.status}` : ""}` : w.type === "chart" ? `${d.series?.length || 0} series of ${d.x?.length || 0} points${d.series?.length ? `: ${d.series.map((x) => x.name).slice(0, 6).join(", ")}` : ""}${d.series?.length && d.series.every((x) => x.values.every((v) => v == null)) ? " (all empty)" : ""}` : w.type === "table" ? `${d.rows?.length || 0} rows${d.rows?.[0] ? `, the first ${JSON.stringify(d.rows[0])}` : ""} (columns ${JSON.stringify(d.columns || [])})` : `${d.items?.length || 0} items${d.items?.[0] ? `, the first "${d.items[0].text}"` : ""}`;
  return `${w.id}: ${drew} (${a.ms ?? "?"} ms${a.cached ? ", kept from a moment ago" : ""})${a.notes?.length ? `. ${a.notes.join(" ")}` : ""}`;
}
// Make a dashboard, or change one it contributes to (dashboards-plan.md). Its panels are checked (a panel has a
// query, never numbers), and each one that's new or changed runs once, for the range it opens on and its variables'
// defaults, as its owner's connectors answer: a write whose panels fail isn't saved (unless keep_failing), and
// `test` runs them without saving anything.
export async function dashboardWriteForAgent(D: Device, o: User, me: Asker, b) {
  const by = { agent: me.agent, post: me.post };
  const id = b.dashboard ? str(b.dashboard, 60) : null;
  const p = id ? state.pages[id] : null;
  if (p && !pageReachable(p, o)) return { error: `No dashboard "${id}". ab_page_list lists them.`, status: 404 };
  if (p && p.kind !== "dashboard") return { error: `"${p.title}" is a page, not a dashboard: ab_page_write changes it.`, status: 400 };
  if (p && !contributes(p, { agent: me.agent })) return { error: `${agentRef(me.agent)?.a.name || "This agent"} isn't a contributor of "${p.title}". Its owner adds contributors on its Contributors tab.`, status: 403 };
  if (p?.archived) return { error: `"${p.title}" is archived.`, status: 400 };
  const title = str(b.title, 120).trim();
  if (!p && !title) return { error: id ? `No dashboard "${id}". Give a title to make it, or see ab_page_list.` : "A new dashboard needs a title.", status: 400 };
  const list = b.panels == null ? [] : b.panels;
  if (!Array.isArray(list)) return { error: "panels is a list: [{ id, type, title, query, shape }].", status: 400 };
  const notes = [];
  const byId = new Map((p?.widgets || []).map((w) => [w.id, w]));
  const seen = new Set();
  const wrong = [];
  const plain = (input, prev) => widgetFrom(input, prev, notes);
  const panels = list.flatMap((w) => {
    try {
      const out = panelFrom(w, byId.get(str(w?.id, 60).trim()) || null, notes, plain);
      if (seen.has(out.id)) throw new Error(`Two panels have the id "${out.id}".`);
      seen.add(out.id);
      return [out];
    } catch (e) {
      wrong.push(e.message);
      return [];
    }
  });
  let dash;
  try {
    dash = dashFrom({ vars: b.vars, range: b.range }, p?.dash);
  } catch (e) {
    wrong.push(e.message);
  }
  if (wrong.length) return { error: `Nothing was saved:\n${wrong.join("\n")}`, status: 400 };
  const remove = Array.isArray(b.remove) ? b.remove.map((x) => str(x, 60)) : [];
  const ids = new Set([...(p?.widgets || []).map((w) => w.id), ...panels.map((w) => w.id)]);
  for (const x of remove) ids.delete(x);
  if (ids.size > 60) return { error: "A dashboard holds up to 60 panels.", status: 400 };
  // The dashboard as the write would leave it, its new and changed panels run on it.
  const pid = p?.id || pageId(id || title, (x) => !!state.pages[x]);
  const draft = { id: pid, owner: p ? p.owner : o.id, dash, widgets: [...(p?.widgets || []).filter((w) => !panels.some((x) => x.id === w.id) && !remove.includes(w.id)), ...panels] };
  const tried = panels.filter(isPanel);
  const ran = tried.length ? await dashboards.run(draft, {}, { ids: tried.map((w) => w.id) }) : { panels: [], view: null };
  const lines = tried.map((w) => testLine(w, ran.panels.find((a) => a.id === w.id) || { error: "It didn't run." }));
  const failed = ran.panels.filter((a) => a.error && !a.stale);
  const tests = { view: ran.view, lines };
  if (b.test) return { test: true, tests, notes };
  if (failed.length && !b.keep_failing) return { error: `Nothing was saved: ${failed.length === 1 ? "a panel" : `${failed.length} panels`} failed its test run, ${ran.view ? `for ${ran.view.range || "its range"} with ${JSON.stringify(ran.view.vars)}` : ""}:\n${lines.join("\n")}\nFix the query (ab_source discover and query help), or send keep_failing: true to save it as it is.`, status: 400 };
  const meta = { title: title || undefined, emoji: b.emoji ? str(b.emoji, 16).trim() : undefined, about: b.about != null ? str(b.about, 600) : undefined, summary: b.summary ? str(b.summary, 200) : undefined };
  if (!p) {
    commit({ t: "page.create", pid, kind: "dashboard", dash, title, emoji: meta.emoji || "📊", about: meta.about || "", by, owner: o.id, contributors: [{ agent: me.agent, role: "made" }], widgets: panels, summary: meta.summary || "Made the dashboard" });
    dashboards.tidy(state.pages[pid]);
    return { id: pid, version: 1, created: true, url: pageLink(pid), notes, tests };
  }
  const before = p.version;
  commit({ t: "page.write", pid: p.id, by, widgets: panels, remove, order: Array.isArray(b.order) ? b.order.map((x) => str(x, 60)) : null, dash, ...meta });
  // Answers kept for panels it no longer has, or that asked what they no longer ask, go.
  dashboards.tidy(state.pages[p.id]);
  return { id: p.id, version: p.version, changed: p.version !== before, url: pageLink(p.id), notes, tests };
}
// Who made a page's version, as an agent of `o` reads it: "heron (Claude), in "Build the dashboard"", "herval,
// by hand" (its own person), "@alice, by hand", or "you, in this thread".
function versionBy(by, post: string, o = null) {
  if (by?.user) return `${by.user === o?.username ? o.display_name || o.username : `@${by.user}`}, by hand`;
  if (by?.post && by.post === post) return "you, in this thread";
  // Another thread, and its agent, only as its reader may see them.
  const theirs = (D) => !!o && ownerOf(D)?.id === o.id;
  const p = by?.post && postRef(by.post);
  const a = by?.agent && agentRef(by.agent);
  const agent = a ? (theirs(a.D) || agentPublic(a.a) ? a.a.name : "an agent") : by?.agent || "an agent";
  return p && (theirs(p.D) || postPublic(p.s, p.agent)) ? `${p.s.label} (${agent}), in "${titleOf(p.s).slice(0, 80)}"` : agent;
}
// The page a post is for: the one its person put it on by hand, or it was written from (by any of its launches, so
// writing on it again keeps it), or the one it made when it was asked for one. With what its agent needs to know it without reading it first:
// what's on it, its last change, and the other open posts on it. (`post`, `launch`, `agent`: the page's ids.)
export function postPage(post: string, launch, agent, o = null) {
  const launches = [];
  const l = launch && relay.resolve(launch);
  if (l) launches.push(l.D.store.state.launches[l.local]);
  const pr = post && postRef(post);
  if (pr) for (const x of Object.values(pr.D.store.state.launches)) if (x.post === pr.local) launches.push(x);
  // The page its person put it on by hand comes first; taken off one, it's on none (postPages).
  const byHand = post && state.page_posts?.[post];
  const asked = byHand ? byHand.page : launches.find((x) => x?.page)?.page;
  if (!asked) return null;
  const id = asked === "new" ? state.page_versions.find((v) => v.v === 1 && post && v.by?.post === post)?.page : asked;
  const p = id && state.pages[id];
  if (!p) return asked === "new" ? { new: true } : null;
  // A page its person may see, with the threads on it they may see: a start can name any page it likes.
  if (!pageSeen({ user: o }, p.id)) return null;
  const seen = (x) => (!!o && ownerOf(x.D)?.id === o.id) || postPublic(x.s, x.agent);
  const launched = new Set();
  for (const D of relay.devices.values()) for (const x of Object.values(D.store.state.launches)) if (x.page === p.id && x.post) launched.add(relay.idOf(D, x.post));
  const wrote = new Set(state.page_versions.filter((v) => v.page === p.id && v.by?.post && Date.now() - Date.parse(v.at) < 864e5).map((v) => v.by.post));
  // The other open threads on it: started from it, changed it in the last day, or put on it by hand (and not one
  // taken off it, or put on another).
  const put = state.page_posts || {};
  const others = [...allPosts()].filter((x) => x.id !== post && x.s.state !== "done" && !x.s.archived && (put[x.id] ? put[x.id].page === p.id : launched.has(x.id) || wrote.has(x.id)) && seen(x));
  return {
    id: p.id,
    title: p.title,
    about: p.about,
    version: p.version,
    url: pageLink(p.id),
    made: asked === "new",
    put: !!byHand,
    // Someone else's page its person contributes to: who sees it and who changes it are its owner's to say.
    owner: o && pageOwner(p) !== o.id ? pageOwnerName(p) || null : null,
    archived: !!p.archived,
    canEdit: !!agent && contributes(p, { agent }),
    last: p.last ? { at: p.last.at, by: versionBy(p.last.by, post, o), summary: p.last.summary } : null,
    widgets: p.widgets.map((w) => ({ id: w.id, title: w.title, what: outline(w) })),
    others: others.map((x) => ({ label: x.s.label, agent: x.agent?.name, title: titleOf(x.s), working: x.s.busy || x.s.state === "working" })),
  };
}
// Make a page (no `page`, or one that doesn't exist yet, with a title), or change one it contributes to.
export function pageWriteForAgent(D: Device, o: User, me: Asker, b): Reply & { id?: string } {
  const by = { agent: me.agent, post: me.post };
  const p = b.page ? state.pages[str(b.page, 60)] : null;
  if (!p) {
    const title = str(b.title, 120).trim();
    if (!title) return { error: b.page ? `No page "${b.page}". Give a title to make it, or see ab_page_list.` : "A new page needs a title.", status: 400 };
    let w;
    try {
      w = pageWrite(null, b, { agent: true });
    } catch (e) {
      return { error: e.message, status: 400 };
    }
    const { tasks, notes, ...made } = w;
    w = made;
    const pid = pageId(b.page || title, (id) => !!state.pages[id]);
    commit({ t: "page.create", pid, title, emoji: w.emoji, about: w.about || "", color: isColor(b.color) ? b.color : null, by, owner: o.id, contributors: [{ agent: me.agent, role: "made" }], widgets: w.widgets, summary: w.summary });
    const advice = pageAdvice({ after: state.pages[pid]?.widgets || w.widgets, written: w.widgets, made: true }).lines;
    return { id: pid, version: 1, created: true, url: pageLink(pid), notes, advice, ...pageTasksFrom(o, me, pid, tasks) };
  }
  if (!contributes(p, { agent: me.agent })) return { error: `${agentRef(me.agent)?.a.name || "This agent"} isn't a contributor of "${p.title}". Its owner adds contributors on the page's Contributors tab.`, status: 403 };
  if (p.archived) return { error: `"${p.title}" is archived.`, status: 400 };
  if (p.kind === "dashboard") return { error: `"${p.title}" is a dashboard: its panels hold queries, and ab_dashboard_write changes them.`, status: 400 };
  let w;
  try {
    w = pageWrite(p, b, { agent: true });
  } catch (e) {
    return { error: e.message, status: 400 };
  }
  const { tasks, notes, ...change } = w;
  const before = p.version;
  const had = p.widgets.slice();
  commit({ t: "page.write", pid: p.id, by, ...change });
  const changed = p.version !== before;
  // What the page's shape says back (page-shape.ts): repeats, and more widgets than read well.
  const advice = changed ? pageAdvice({ before: had, after: state.pages[p.id].widgets, written: change.widgets }).lines : [];
  return { id: p.id, version: p.version, changed, url: pageLink(p.id), notes, advice, ...pageTasksFrom(o, me, p.id, tasks) };
}
// What a write's tasks widgets did to the person's tasks on the page: { tasks: [what happened to each item] }, or
// nothing when it wrote none.
function pageTasksFrom(o: User, me: Asker, pid: string, tasks) {
  const items = (tasks || []).flatMap((x) => x.items);
  return items.length ? { tasks: pageTasksForAgent(o.id, me, pid, items) } : {};
}
// A page's checklist is the person's tasks on it. What an agent writes in a tasks widget: each item one of their
// tasks. One with an id, or that looks like a task already on the page, is that task: its note changes, it's ticked
// or unticked as `done` says (as with ab_tasks, from the agent's thread, though it unticks only what an agent
// ticked), and its text changes too when it gave the id. An open task on no page that looks the same (a to-do it
// left before) joins the page. The rest are added on top of their list, in the order given, from its thread and
// linked to it, in the workspace it works in, and for its agent when `for` is "me". Answers what happened to each.
function pageTasksForAgent(owner, me: Asker, page, items) {
  const mine = Object.values(state.tasks).filter((t) => t.owner === owner && !t.removed);
  const onPage = mine.filter((t) => onTaskPage(t, page));
  const taken = new Set();
  const free = (t) => t && !taken.has(t.id);
  const like = (it, list) => list.find((t) => free(t) && t.text === it.text) || list.find((t) => free(t) && alike(it.text, t.text));
  const forWhom = (f) => (!f || /^(you|them|the person|person)$/i.test(f) ? null : /^(me|myself|agent)$/i.test(f) ? me.agent || null : agentNamed(f, owner));
  const found = items.map((it) => {
    const t = it.id ? mine.find((x) => x.id === it.id) : like(it, onPage) || like(it, mine.filter((x) => !x.done && !pagesOfTask(x).length));
    if (t) taken.add(t.id);
    return t || null;
  });
  const fresh = items.filter((it, i) => !found[i] && !it.id);
  const ranks = mine.map((t) => t.rank);
  let rank = (ranks.length ? Math.min(...ranks) : 0) - fresh.length;
  const ws = Object.values(state.workspaces).find((w) => w.owner === owner && inWorkspace(w, me));
  const at = new Date().toISOString();
  return items.map((it, i) => {
    const t = found[i];
    if (!t && it.id) return { id: it.id, missing: true };
    if (!t) {
      const op = commit({ t: "task.add", tid: taskId(), owner, text: it.text, note: it.note || undefined, page, workspace: ws?.id || null, agent: forWhom(it.for), rank: rank++, from: me.post, posts: [{ post: me.post, at, by: "agent" }] });
      if (it.done) commit({ t: "task.done", tid: op.tid, done: true, by: me.post });
      return { id: op.tid, text: it.text, added: true, ...(it.done ? { done: true } : {}) };
    }
    // Found on another page (or none), it joins this one too.
    const joined = !onTaskPage(t, page);
    if (joined) commit({ t: "task.page", tid: t.id, page, by: "agent" });
    const edit = { ...(it.note && it.note !== (t.note || "") && (!joined || !t.note) ? { note: it.note } : {}), ...(it.id && it.text && it.text !== t.text && !joined ? { text: it.text } : {}) };
    if (Object.keys(edit).length) commit({ t: "task.edit", tid: t.id, ...edit });
    // It unticks only what an agent ticked: what the person or a connector ticked stays ticked.
    const tick = it.done !== null && it.done !== t.done && (it.done || t.done_by === "agent") ? tickForAgent(owner, t.id, it.done, me.post) : null;
    return { id: t.id, text: t.text, done: t.done, ...(joined ? { joined: true } : Object.keys(edit).length ? { changed: true } : {}), ...(tick?.ok ? { [it.done ? "ticked" : "unticked"]: true } : {}), ...(tick?.closes ? { closes: tick.closes } : {}) };
  });
}
// The person's tasks on a page, for an agent: the open ones in their order, then the ones done in the last two
// weeks. `for`: "me" when they're for the agent reading them.
function pageTaskRows(owner, page, agent) {
  const list = Object.values(state.tasks).filter((t) => t.owner === owner && !t.removed && onTaskPage(t, page) && (!t.done || Date.now() - Date.parse(t.done_at) < TASKS_DONE_MS));
  const open = list.filter((t) => !t.done).sort((a, b) => a.rank - b.rank);
  const done = list.filter((t) => t.done).sort((a, b) => b.done_at.localeCompare(a.done_at));
  return [...open, ...done].map((t) => ({ id: t.id, text: t.text, ...(t.note ? { note: t.note } : {}), for: !t.agent ? "you" : t.agent === agent ? "me" : agentRef(t.agent)?.a.name || t.agent, done: t.done, ...(t.done ? { done_by: t.done_by === "agent" ? postLabel(t.done_post) || "an agent" : t.done_by || "you" } : {}) }));
}
// An agent of a person's (`owner`), by its page id or its name, among their machines' agents: its page id, or null.
function agentNamed(f, owner) {
  const want = String(f).toLowerCase();
  for (const D of relay.devices.values()) if (ownerOf(D)?.id === owner) for (const a of Object.values(D.store.state.agents)) if (!relay.shadowed(D, a.id) && (relay.idOf(D, a.id) === f || a.name?.toLowerCase() === want)) return relay.idOf(D, a.id);
  return null;
}
// The pictures on its machine an agent names in a page it writes, by their whole path: its machine sends them up
// with the write (a page has no folder of its own, or machine, to read one from later), and they're kept with the
// page, like one from the web, as they were then.
export function pagePicturesSent(pid: string, list, D: Device) {
  const p = state.pages[pid];
  if (!p || !Array.isArray(list)) return;
  for (const x of list.slice(0, 20)) {
    const url = typeof x?.url === "string" ? x.url : "";
    if (!localPicture(url) || typeof x.sha !== "string" || !blobOk(D, x.sha) || !names([p.about, p.widgets], url)) continue;
    webPictures.get(`page-${pid}`, url, { load: () => picture(blobs.read(x.sha) || Buffer.alloc(0), path.basename(url)), fresh: true }).catch(() => {});
  }
}
