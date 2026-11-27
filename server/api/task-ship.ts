import { carry, prChanges, prOfUrl, pullDetail } from "../integrations/pulls.ts";
import { guestsOf } from "../../plugin/shared/guests.ts";
import { isTalkId } from "../../plugin/shared/talks.ts";
import { landingQueue, partDone, prReady, shipBlock, shipNews, slimCard } from "../../plugin/shared/task-ship.ts";
import type { Device } from "../relay.ts";
import type { ShipOrderItem, Task } from "../../plugin/shared/types.ts";
import { accounts, commit, log, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Answer, PostRef, ReadAnswer, WipBody } from "../core/types.ts";
import { allPosts, ownerOf, postRef } from "../core/refs.ts";
import { NOT_HEADS, PR_MS, PR_OLD_MS, ghFor, linkedUrls, prKey, prReads } from "./prs.ts";
import { SELF_URL, titleOf } from "./cli.ts";
import { flagsTask, onTask, peopleOn, taskOr404 } from "./tasks.ts";
import { byYou } from "./groups.ts";
import { guestPost, guestRecord } from "./guests.ts";

// A branch's work in progress (read.wip): the files it changed, committed and not.
interface WipAnswer extends Answer {
  committed?: { path: string }[];
  uncommitted?: { path: string }[];
}

/* ---------- what a task ships: its pull requests, the order they land in, what its threads hear (task-ship.ts) ---------- */

// A task is what's being done, its threads do it, its pull requests ship it. It replaced the WIPs of many.
export const taskLink = (id: string) => `${SELF_URL}/#/tasks/${encodeURIComponent(id)}`;
// A line of text, its spaces squeezed, at most `n` characters.
export const aLine = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
// A branch or a pull request is worked out on the page, from its machines' folders and GitHub, so the page says what
// it is: { id, kind, title, ref, repo, url }. Null when it isn't one.
function wipOfBody(w: WipBody | null | undefined): ShipOrderItem | null {
  const id = str(w?.id, 120);
  if (!/^[\w.:-]+$/.test(id)) return null;
  const url = /^https:\/\/[^\s"<>]+$/.test(w.url || "") ? str(w.url, 300) : null;
  return { id, kind: w.kind === "pr" ? "pr" : "branch", title: str(w.title, 200).trim(), ref: str(w.ref, 200).trim() || id, repo: str(w.repo, 120).trim(), url };
}
export const taskOpen = (t: Task) => !!t && !t.done && !t.removed;
const shipUrls = (t: Task) => new Set((t.ship?.items || []).filter((x) => x.kind === "pr" && x.url).map((x) => x.url.toLowerCase()));
// Whether a thread works on what's put in a task: on its branch, or linking its pull request.
function worksOn(t: Task, p: PostRef) {
  const items = t.ship?.items || [];
  if (!items.length) return false;
  const urls = shipUrls(t);
  if (linkedUrls(p.s).some((u) => urls.has(u.toLowerCase()))) return true;
  return !!p.s.branch && !NOT_HEADS.has(p.s.branch) && items.some((x) => x.kind === "branch" && x.ref === p.s.branch);
}
// The threads linked to a task, and the guests in each of your own threads linked to it (what they work on is its).
export function putIn(t: Task) {
  const ids = new Set(t.posts.map((e) => e.post));
  for (const id of [...ids]) if (isTalkId(id)) for (const g of guestsOf(state, id)) if (!g.removed && guestPost(g)) ids.add(guestPost(g));
  return ids;
}
// The threads on a task: linked to it, or working on what's put in it; its owner's, and its people's.
export function taskPostsOf(t: Task) {
  if (!taskOpen(t)) return [];
  const put = putIn(t);
  const out: PostRef[] = [];
  for (const p of allPosts()) if (onTask(t, ownerOf(p.D)?.id) && !p.s.archived && (put.has(p.id) || worksOn(t, p))) out.push(p);
  return out;
}
// Whether a task ships more than one thread does on its own: something put in it, or two threads or more. Only those
// keep how their pull requests stand and tell their threads (a to-do left on a thread, or a task sent to one agent,
// says nothing its thread doesn't know).
export const ships = (t: Task) => taskOpen(t) && !t.scope && (!!t.ship?.items?.length || putIn(t).size >= 2);
// The task a thread hears about: of the open ones its owner is on that ship, linked to it (not its own to-do) or whose
// pull requests or branches it works on, the one with the most going on (then the one linked to it last).
function taskOfThread(p: PostRef) {
  const uid = ownerOf(p.D)?.id;
  if (!uid) return null;
  const host = guestRecord(p.id)?.host;
  const linkAt = (t) => t.posts.find((e) => e.post === p.id || (isTalkId(host) && e.post === host))?.at || null;
  let best = null;
  let bestN = -1;
  for (const t of Object.values(state.tasks)) {
    if (!onTask(t, uid) || t.from === p.id || !ships(t)) continue;
    const at = linkAt(t);
    if (!at && !worksOn(t, p)) continue;
    const n = (t.ship?.items?.length || 0) + putIn(t).size;
    if (n > bestN || (n === bestN && String(at) > String(linkAt(best)))) [best, bestN] = [t, n];
  }
  return best;
}
// The task a launch was sent from, while its session isn't there yet: only one that ships.
const taskOfLaunch = (lid) => (lid ? Object.values(state.tasks).find((t) => t.sent.some((e) => e.launch === lid) && ships(t)) || null : null);
// Whether a branch's work is all on main now, as its owner's machines read git.
function branchLanded(uid: string, branch) {
  for (const D of relay.devices.values()) {
    if (ownerOf(D)?.id !== uid) continue;
    for (const f of relay.infoOf(D).folders?.folders || []) for (const x of f.wip || []) if (x.branch === branch && x.worked && !x.ahead && !x.dirty) return true;
  }
  return false;
}
// What a task ships, as its threads are told it (task-ship.ts's parts): what's put in it, then its threads' pull
// requests and their branches with none, each pull request with how it stood when GitHub was last read, and who's on
// each. `me`: the thread being told, whose own are "yours".
export function shipPartsOf(t: Task, me = null) {
  const posts = taskPostsOf(t);
  const put = putIn(t);
  const parts = [];
  const byUrl = new Map();
  const add = (x) => (parts.push(x), x.url && byUrl.set(x.url.toLowerCase(), x), x);
  for (const x of t.ship?.items || []) {
    if (x.kind === "pr" && x.url && !byUrl.has(x.url.toLowerCase())) add({ id: x.id, kind: "pr", ref: x.ref, title: x.title, url: x.url, repo: x.repo, gh: null, threads: [], mine: false });
    else if (x.kind === "branch") add({ id: x.id, kind: "branch", ref: x.ref, title: x.title, url: null, repo: x.repo, branch: x.ref, threads: [], mine: false });
  }
  for (const p of posts) {
    for (const pr of Object.values(p.s.prs || {})) {
      if (!pr.url || pr.off) continue;
      const u = pr.url.toLowerCase();
      const part = byUrl.get(u) || (put.has(p.id) ? add({ id: pr.url, kind: "pr", ref: `#${pr.number}`, title: pr.gh?.title || "", url: pr.url, repo: pr.repo || "", gh: null, threads: [], mine: false }) : null);
      if (part && !part.gh && pr.gh) part.gh = pr.gh;
    }
  }
  const kept = t.ship?.prs || {};
  for (const x of parts) {
    if (x.kind !== "pr") continue;
    x.gh = Object.entries(kept).find(([k]) => k.toLowerCase() === x.url.toLowerCase())?.[1] || x.gh;
    if (x.gh?.title) x.title = x.gh.title;
    x.branch = x.gh?.head || null;
  }
  // A thread linked to it on a branch with no pull request yet: that branch.
  for (const p of posts) {
    const b = p.s.branch;
    if (!put.has(p.id) || !b || NOT_HEADS.has(b) || parts.some((x) => x.branch === b)) continue;
    add({ id: `b:${b}`, kind: "branch", ref: b, title: titleOf(p.s), url: null, repo: p.s.repo || "", branch: b, threads: [], mine: false });
  }
  for (const x of parts) {
    if (x.kind === "branch") x.landed = peopleOn(t).some((uid) => branchLanded(uid, x.branch));
    const on = (p) => (x.url && linkedUrls(p.s).some((u) => u.toLowerCase() === x.url.toLowerCase())) || (!!x.branch && p.s.branch === x.branch);
    x.threads = posts.filter(on).map((p) => p.s.label);
    x.posts = posts.filter(on).map((p) => p.id);
    x.mine = !!me && on(me);
  }
  return parts;
}
// What a thread on a task is told about it when it starts, and after compacting (context.ts puts it after its
// group's): for `post`, or for a launch sent from it (`lid`) before its session is there. Telling it is hearing it.
export function shipFacts(post: string, lid, { o = null } = {}) {
  const p = post ? postRef(post) : null;
  const t = p ? taskOfThread(p) : taskOfLaunch(lid);
  if (!t) return null;
  const latest = t.ship?.events.at(-1)?.seq || 0;
  if (p && (t.ship?.seen?.[p.id] == null || latest > t.ship.seen[p.id])) commit({ t: "task.seen", tid: t.id, post: p.id, upto: latest });
  const others = taskPostsOf(t).filter((x) => x.id !== p?.id);
  return shipBlock(t, shipPartsOf(t, p), { link: taskLink(t.id), person: o?.display_name || o?.username || null, threads: others.map((x) => `${x.s.label} "${aLine(titleOf(x.s), 60)}"`) });
}
// What happened to a thread's task since it last heard, as text to hand it with what it gets anyway: never its own
// doings, nor what its own pull requests did (it's told those itself). One that never heard of it (linked since it
// started) is told it all. A merge is checked against what its branch changes, read from its machine. Marks it told.
export async function taskNewsFor(post: string) {
  const p = postRef(post);
  const t = p && taskOfThread(p);
  if (!t) return null;
  const s = t.ship;
  const seen = s?.seen?.[p.id];
  if (seen == null) return shipFacts(post, null, { o: ownerOf(p.D) });
  const latest = s.events.at(-1)?.seq || 0;
  if (latest <= seen) return null;
  commit({ t: "task.seen", tid: t.id, post: p.id, upto: latest });
  const mine = new Set(linkedUrls(p.s).map((u) => u.toLowerCase()));
  const evs = s.events.filter((e) => e.seq > seen && e.post !== p.id && !(e.url && mine.has(e.url.toLowerCase())));
  if (!evs.length) return null;
  let files = null;
  if (evs.some((e) => e.files?.length) && p.s.root && p.s.branch && !NOT_HEADS.has(p.s.branch)) {
    const r = (await relay.read(p.D, "read.wip", { root: p.s.root, branch: p.s.branch }, { wait: 10e3 }).catch(() => null)) as ReadAnswer<WipAnswer> | null;
    const d = r?.data;
    if (d && Array.isArray(d.committed)) files = new Set([...d.committed, ...(d.uncommitted || [])].map((f) => f.path));
  }
  return shipNews(t, evs, { files });
}
// A thread on a task that ships is its machine's to know (it asks for its news then): each is told the task it's on
// now, soon after anything changes which, and only when that's news to it. (`post.wip`, `session.wip`: their names
// from when this was a WIP's.)
const flagsDue = new Set();
const flagsSent = new Map(); // post id -> the task it was last told
export function flagsSoon(uid: string) {
  if (!uid || flagsDue.has(uid)) return;
  flagsDue.add(uid);
  setTimeout(() => {
    flagsDue.delete(uid);
    for (const p of allPosts()) {
      if (ownerOf(p.D)?.id !== uid || !relay.online(p.D)) continue;
      const sid = (!p.s.archived && taskOfThread(p)?.id) || null;
      if ((p.s.wip || null) === sid || (flagsSent.has(p.id) && flagsSent.get(p.id) === sid)) continue;
      flagsSent.set(p.id, sid);
      relay.command(p.D, "post.wip", { post: p.local, sid }, { by: ownerOf(p.D)?.username || null, wait: 15e3 }).catch(() => null);
    }
  }, 300).unref();
}
// A thread linking a pull request, or on a new branch, may be on a task's now (its machine is told); one asked to land
// the next one ending its turn may have.
export function shipHear(D: Device, op) {
  if (["session.pr", "session.hello", "session.where"].includes(op?.t)) flagsSoon(ownerOf(D)?.id);
  if (op?.post && ["session.status", "session.update", "session.landed"].includes(op.t)) {
    const id = relay.idOf(D, op.post);
    for (const t of Object.values(state.tasks)) if (t.ship?.landing && Object.values(t.ship.landing.asked || {}).length && t.ship.events.some((e) => e.kind === "asked" && e.post === id)) landSoon(t.id);
  }
}

// A pull request a task ships is read from GitHub as its threads' are (watchPrs): an open one every 90 seconds, a
// closed one for a day, a merged one not again.
export function shipPrDue(t: Task, url, pr, now) {
  const gh = t.ship?.prs?.[url];
  const last = prReads.get(prKey(t.owner, pr.repo, pr.number)) || 0;
  if (!gh) return now - last > Math.min(PR_MS, 30e3);
  if (gh.state === "merged") return false;
  if (gh.state === "closed") return now - Date.parse(String(gh.closed || 0)) < 86400e3 && now - last > PR_OLD_MS;
  return now - last > PR_MS;
}
// What a read of one of its pull requests found, kept on each task that ships it, with what changed as lines its
// threads hear: merged (with the files it changed), closed, checks failing or passing again, changes asked for,
// approved, ready to merge, conflicting; one opened since it went in. Not who commented: that's its own thread's.
const shipPrBusy = new Set();
export function shipPrChanged(uid: string, url, card) {
  const u = url.toLowerCase();
  for (const t of Object.values(state.tasks)) {
    if (!onTask(t, uid) || !ships(t) || !shipPartsOf(t).some((x) => x.url?.toLowerCase() === u)) continue;
    const key = Object.keys(t.ship?.prs || {}).find((k) => k.toLowerCase() === u) || url;
    if (shipPrBusy.has(`${t.id}|${u}`)) continue;
    const prev = t.ship?.prs?.[key] || null;
    const next = slimCard(carry(prev, card));
    if (prev && JSON.stringify(next) === JSON.stringify(prev)) continue;
    const lines = prev ? prChanges(prev, next).filter((l) => l.kind !== "note" || /reopened/.test(l.text)) : [];
    if (prev && !prReady(prev) && prReady(next)) lines.push({ kind: "good", text: `#${next.number} is ready to merge` });
    const since = t.ship?.since || t.at;
    if (!prev && next.created && next.created > since && Date.now() - Date.parse(next.created) < 2 * 86400e3) lines.push({ kind: "opened", text: `#${next.number} "${String(next.title || "").slice(0, 90)}" was opened${next.state === "draft" ? " as a draft" : ""}` });
    const merged = lines.some((l) => l.kind === "merged");
    const done = (files = null) => {
      commit({ t: "task.pr", tid: t.id, url: key, gh: next, lines, ...(files ? { files } : {}) });
      if (t.ship?.landing && lines.some((l) => l.kind === "merged" || l.kind === "closed")) landSoon(t.id);
    };
    if (!merged) {
      done();
      continue;
    }
    // A merge says which files it changed, so each thread can be told whether its branch changes them too.
    shipPrBusy.add(`${t.id}|${u}`);
    const pr = prOfUrl(url);
    const gh = ghFor(uid);
    (pr && gh ? pullDetail(`github.com/${pr.repo}`, pr.number, { host: "agentbook", token: gh.token }) : Promise.reject(new Error("no GitHub")))
      .then((d) => (d.files_list || []).map((f) => f.path), () => null)
      .then((files) => {
        shipPrBusy.delete(`${t.id}|${u}`);
        done(files);
      });
  }
}

// Landing in order: the next one's thread is asked to land it, once, when the one before it has merged (or now, for
// the first). One with no thread on it is said on the task; one closed without merging stops it all. Its owner's
// machine may take only messages they sign: then it says so, and they ask from its row.
const PR_LAND = (t: Task, x, after) => `The task "${t.text}" lands in order, and ${x.kind === "pr" ? `#${String(x.ref).replace(/^#/, "")} (${x.url})` : `the branch ${x.branch}`} is next${after ? `: ${after} merged` : ""}. ${x.kind === "pr" ? `Land it: rebase ${x.branch || "its branch"} on ${x.gh?.base || "main"}, resolve any conflicts keeping both sides' intent, run the tests and push; once its checks pass, merge it the way this repo merges (gh pr merge ${String(x.ref).replace(/^#/, "")}).` : `Land it: commit what isn't, rebase it on main, run the tests and land it.`} If something stops you, say what. Tell me when it's in.`;
const landingDue = new Set();
// Asks on their way: the ask is recorded only once the thread's machine has answered, up to a minute later, and a
// merge or a thread's turn meanwhile comes through here again. It would have asked the same thread a second time.
const landingAsking = new Set();
function landSoon(tid: string) {
  if (landingDue.has(tid)) return;
  landingDue.add(tid);
  setTimeout(() => {
    landingDue.delete(tid);
    const t = state.tasks[tid];
    if (t) landNext(t).catch((e) => log(`landing task ${tid} in order: ${e.message}`));
  }, 1000).unref();
}
async function landNext(t: Task) {
  if (!t.ship?.landing || !taskOpen(t)) return;
  const parts = shipPartsOf(t);
  const queue = landingQueue(t.ship, parts);
  const closed = queue.find((x) => x.kind === "pr" && x.gh?.state === "closed");
  if (closed) return void commit({ t: "task.landing", tid: t.id, on: false, text: `${closed.ref} was closed without merging, so landing them in order stopped.` });
  const next = queue.find((x) => !partDone(x));
  if (!next) return void commit({ t: "task.landing", tid: t.id, on: false, text: "All of it landed, in order." });
  const key = next.url || next.id;
  if (t.ship.landing.asked[key]) return;
  const name = next.kind === "pr" ? next.ref : `the branch ${next.ref}`;
  const before = queue[queue.indexOf(next) - 1];
  const on = taskPostsOf(t).filter((p) => (next.url && linkedUrls(p.s).some((u) => u.toLowerCase() === next.url.toLowerCase())) || (next.branch && p.s.branch === next.branch));
  const p = on.find((x) => x.s.state !== "done") || on[0];
  if (!p) return void commit({ t: "task.asked", tid: t.id, id: key, text: `${name} is next to land, and no thread is on it: start one from its row.` });
  // Steering stays with each thread's owner: only the threads of whoever turned it on are
  // asked; another person's is theirs to ask, from its row.
  const by = t.ship.landing.by?.user || accounts.byId(t.owner)?.username || null;
  const theirs = ownerOf(p.D)?.username || null;
  if (theirs !== by) return void commit({ t: "task.asked", tid: t.id, id: key, post: p.id, waits: theirs, text: `${name} is next to land, on @${theirs}'s thread ${p.s.label}: it's @${theirs}'s to ask.` });
  const asking = `${t.id}|${key}`;
  if (landingAsking.has(asking)) return;
  landingAsking.add(asking);
  const x = (await relay.command(p.D, "post.deliver", { post: p.local, text: PR_LAND(t, next, before && (before.kind === "pr" ? before.ref : `the branch ${before.ref}`)) }, { by, wait: 60e3 }).catch((e) => ({ error: e.message })).finally(() => landingAsking.delete(asking))) as Answer;
  commit({ t: "task.asked", tid: t.id, id: key, post: x?.error ? null : p.id, text: x?.error ? `Couldn't ask ${p.s.label} to land ${name}, next in order: ${x.error}` : `Asked ${p.s.label} to land ${name}, next in order.` });
}

// Put a pull request or a branch in a task, or take it out (`remove`): the page says what it is.
route("POST", "/api/tasks/:id/items", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const b = await readBody<{ item?: WipBody; remove?: boolean }>(req);
  const item = wipOfBody(b.item);
  if (!item) return fail(res, 400, "Which pull request or branch?");
  commit({ t: "task.item", tid: t.id, item, remove: !!b.remove, by: byYou(req) });
  flagsTask(t);
  ok(res);
});
// Its landing order: what it ships, first to land first, as the page says of each ([] for none).
route("POST", "/api/tasks/:id/order", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const b = await readBody<{ order?: WipBody[] }>(req);
  const order = (Array.isArray(b.order) ? b.order : []).slice(0, 100).map(wipOfBody).filter(Boolean);
  commit({ t: "task.order", tid: t.id, order, by: byYou(req) });
  ok(res);
});
// Land them in order (`on`), or stop: each one's thread is asked to land it once the one before it has merged.
route("POST", "/api/tasks/:id/landing", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id, "own");
  if (!t) return;
  const b = await readBody<{ on?: boolean }>(req);
  if (b.on !== false && !t.ship?.order?.length) return fail(res, 400, "Put them in an order first.");
  commit({ t: "task.landing", tid: t.id, on: b.on !== false, by: byYou(req) });
  if (b.on !== false) landSoon(t.id);
  ok(res);
});
