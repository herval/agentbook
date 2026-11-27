// The page's API: its queries, each open page's live events, and what a thread's steps show.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detailFor, postPublic } from "../policy.ts";
import type { MessageHits } from "../feed.ts";
import { feedKey, feedParams, pageOf as feedPage } from "../feed.ts";
import { sideOf } from "../side.ts";
import { localPicture, names, picture, postWords } from "../../plugin/shared/pictures.ts";
import { createUnfurl } from "../integrations/unfurl.ts";
import { createWebPictures } from "../integrations/web-pictures.ts";
import { excerpt, haystack, hits, nearStart, typoBudget } from "../../plugin/shared/search.ts";
import { outOfMemory, sessionDetail } from "../../plugin/shared/store.ts";
import type { Device } from "../relay.ts";
import type { Message } from "../../plugin/shared/types.ts";
import type { FeedQ, LiveWatchRequest, ThreadRecords, ThreadsQ } from "../../plugin/shared/api.ts";
import { FILES_DIR, blobs, relay, work } from "../core/state.ts";
import { fail, ok, queryRoute, readBody, route, safeName, send } from "../core/http.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { MediaAnswer, PostRef, ReadAnswer } from "../core/types.ts";
import { isOwner, ownerName } from "../core/refs.ts";
import { postOr404, seesWork, sharedOf } from "../core/follows.ts";
import { readOf } from "../core/commands.ts";
import { live, news } from "../core/services.ts";
import { aroundThread, feedSeen, threadSeen, viewForReq } from "./views.ts";
import { prLooked } from "./prs.ts";
import { MIME } from "./files.ts";
import { TYPES } from "./static.ts";


// A page's own stream: `hello` with its id, then what changes in what it shows (live.ts). Opened again with that
// id (`?live=`), it gets what it missed, or `hello` with `reset` and a new id.
route("GET", "/api/live", (req, res, { query }) => {
  live.connect(req, res, { id: query.get("live"), last: req.headers["last-event-id"] ?? query.get("last") });
});
// A page stops showing something it asked for (`drop`: "open", the thread on its own page).
route("POST", "/api/live/watch", async (req, res) => {
  const b = await readBody<LiveWatchRequest>(req).catch((): LiveWatchRequest => ({}));
  if (!["open", "feed"].includes(b.drop)) return fail(res, 400, "Nothing to drop by that name.");
  if (!live.unwatch(req, b.live, b.drop, Number.isSafeInteger(b.v) ? b.v : null)) return fail(res, 404, "No such page of yours.");
  ok(res);
});
// A thread on its own page, as records: the thread, and its latest messages (`n`, 50 at most 200), or the ones before
// one of them (`before`, its id), with `older` the first of those still before and `earlier` how many are. With `live` (its page's stream id),
// that page hears about the thread from now on (not for older messages, which don't change what it watches).
queryRoute("/api/q/thread/:id", (req, res, { params, query }) => {
  const t = threadSeen(req, params.id);
  if (!t) return fail(res, 404, "No such thread");
  const id = t.record.id;
  prLooked.set(id, Date.now());
  news.looked(req.user?.id, id);
  const n = Math.min(200, Math.max(1, Number(query.get("n")) || 50));
  const before = query.get("before");
  const around = !before ? query.get("around") : null;
  let start: number;
  let end: number;
  if (around) {
    const idx = t.messages.findIndex((m) => m.id === around);
    if (idx >= 0) {
      if (t.messages.length - idx <= 200) {
        end = t.messages.length;
        start = Math.max(0, Math.min(idx - 20, end - n));
        if (end - start > 200) start = Math.min(idx, end - 200);
      } else {
        start = Math.max(0, idx - Math.floor(n / 2));
        end = Math.min(t.messages.length, start + n);
      }
    } else {
      end = t.messages.length;
      start = Math.max(0, end - n);
    }
  } else {
    end = before ? Math.max(0, t.messages.findIndex((m) => m.id === before)) : t.messages.length;
    start = Math.max(0, end - n);
  }
  const shown = t.messages.slice(start, end);
  const older = start > 0 ? shown[0]?.id || null : null;
  const records: ThreadRecords = {};
  records[`thread:${id}`] = t.record;
  for (const m of shown) records[`message:${m.id}`] = m;
  const watching = !before && end === t.messages.length && !!query.get("live") && live.watchThread(req, query.get("live"), id, t, { messages: shown, since: older ? shown[0].at || "" : "" });
  return { records, thread: `thread:${id}`, messages: shown.map((m) => `message:${m.id}` as const), older, earlier: start, live: t.live, runs: t.runs, work: t.work, watching, ...(before || t.record.talk ? {} : aroundThread(req, t.record)) };
});
// The page's chrome (side.ts): everything but threads, by `type:id`, with the rows of the threads that are open or
// that it names. With `live`, that page hears from then on what changes in it (live.ts: `side`).
queryRoute("/api/q/side", (req, res, { query }) => {
  const side = sideOf(viewForReq(req));
  const id = query.get("live");
  return { ...side, watching: (!!id && live.watchSide(req, id, side)) || false };
});
// Threads by id (`ids`, by commas, 100 at most), as their cards show them: for a screen that has them as rows from
// the lean stream and shows more of them (WIP's story and results). Ones they may not see aren't there.
queryRoute("/api/q/threads", (req, res, { query }) => {
  const ids = new Set(String(query.get("ids") || "").split(",").filter(Boolean).slice(0, 100));
  const records: ThreadsQ["records"] = {};
  if (ids.size) {
    const v = viewForReq(req);
    for (const s of [...v.sessions, ...(v.talks || [])]) if (ids.has(s.id)) records[`thread:${s.id}`] = s;
  }
  return { records };
});
// The feed, a page at a time, as records (feed.ts): `filter`, `agent`, `workspace`, `page`, `group` (lists, by
// commas) and `q` narrow it as the page's bar does; `n` of it (20, at most 100) after `after`, where the last page
// of it ended (`next`). Its counts say how many each menu would show. With `live` (its page's stream), that page
// hears from then on what changes in what it got (live.ts: `feed`): the first page of a feed watches it, and each
// page after adds to it. `found`, with a search: its words, and for the threads shown, what their messages had.
queryRoute("/api/q/feed", (req, res, { query }) => {
  const params = feedParams(query);
  const n = Math.min(100, Math.max(1, Number(query.get("n")) || 20));
  const after = query.get("after") || null;
  const f = feedSeen(req, params);
  const { shown, next } = feedPage(f, { after, n });
  const records: FeedQ["records"] = {};
  const now: FeedQ["live"] = {};
  for (const it of shown) {
    records[it.key] = f.record(it.key);
    if (it.kind === "thread" && f.live(it.x.id)) now[it.x.id] = f.live(it.x.id);
  }
  const list = shown.map((it) => it.key);
  const id = query.get("live");
  const key = feedKey(params);
  const watching = !!id && (after ? live.moreFeed(req, id, { key, shown: list, next, records, live: now }) : live.watchFeed(req, id, { params, key, shown: list, next, records, live: now, counts: f.counts, menus: f.menus }));
  const found = f.search && {
    terms: f.search.terms,
    posts: Object.fromEntries(shown.filter((it) => it.kind === "thread" && f.search.posts.has(it.x.id)).map((it) => [it.x.id, ((r) => ({ exact: [...r.exact], typo: [...r.typo], hit: r.hit }))(f.search.posts.get(it.x.id))])),
  };
  return { records, list, next, live: now, counts: f.counts, menus: f.menus, found: found || null, watching };
});

// Search every message of the posts you may see, for q/feed (feed.ts searches the rest of a post). For each post
// with a match: the words its messages have as typed (`exact`) or only with a typo, and the latest message with the
// most of them, around the first. `exact` on its own: the words some message has as typed.
const msgHays = new WeakMap(); // message -> its haystack
export const messagesSeen = (req: Viewer) => {
  const out: { m: Message; D: Device }[] = [];
  for (const D of relay.devices.values()) {
    const mine = isOwner(req, D);
    const st = D.store.state;
    for (const m of [...st.messages, ...outOfMemory(st, "messages")]) {
      const s = st.sessions[m.post];
      if (s && !relay.shadowed(D, m.post) && (mine || postPublic(s, st.agents[s.agent]) || sharedOf(req, relay.idOf(D, m.post)) !== undefined)) out.push({ m, D });
    }
  }
  return out;
};
export function searchMessages(words: string[], seen: { m: Message; D: Device }[]) {
  const byPost = new Map<string, { m: Message; h: ReturnType<typeof haystack>; D: Device }[]>();
  for (const { m, D } of seen) {
    if (!m.text) continue;
    let h = msgHays.get(m);
    if (h?.src !== m.text) msgHays.set(m, (h = haystack(m.text)));
    const post = relay.idOf(D, m.post);
    if (!byPost.has(post)) byPost.set(post, []);
    byPost.get(post).push({ m, h, D });
  }
  const all = [...byPost.values()].flat();
  const exact = words.filter((w) => all.some(({ h }) => h.f.includes(w)));
  const terms = words.map((w) => ({ w, typos: exact.includes(w) ? 0 : typoBudget(w) }));
  // The words a typo could be, each looked at once for all the messages.
  const near = new Map(terms.filter((t) => t.typos).map((t): [string, Set<string>] => [t.w, new Set()]));
  if (near.size) {
    const seen = new Set();
    for (const { h } of all) {
      for (const x of h.words) {
        if (seen.has(x)) continue;
        seen.add(x);
        for (const t of terms) if (t.typos && nearStart(t.w, x, t.typos)) near.get(t.w).add(x);
      }
    }
  }
  const posts: MessageHits["posts"] = [];
  for (const [post, list] of byPost) {
    const has = { exact: new Set<string>(), typo: new Set<string>() };
    let best: { m: Message; n: number } | null = null;
    for (const { m, h } of list) {
      let n = 0;
      for (const t of terms) {
        if (h.f.includes(t.w)) has.exact.add(t.w);
        else if (t.typos && h.words.some((x) => near.get(t.w).has(x))) has.typo.add(t.w);
        else continue;
        n++;
      }
      if (n && n >= (best?.n || 0)) best = { m, n };
    }
    if (!best) continue;
    const first = hits(best.m.text, terms)[0];
    const text = first ? excerpt(best.m.text, first) : best.m.text.slice(0, 160);
    const D = list[0].D;
    posts.push({ post, exact: [...has.exact], typo: [...has.typo], hit: { id: relay.idOf(D, best.m.id), from: best.m.from, at: best.m.at, text } });
  }
  return { exact, posts };
}

// A post's work, as its machine sent it (`kept`), or as its machine reads it now: while the post is going and its
// machine is on, what it reads is newer; once it's done, or its machine is off, what it sent is the whole of it.
export async function workOf(res: Res, p: PostRef, kind: string, args: Record<string, unknown>, kept: unknown) {
  const going = p.s.state !== "done" && !p.s.asleep && relay.online(p.D);
  if (kept && !going) return ok(res, kept);
  const r = (await relay.read(p.D, kind, args, { wait: kept ? 3000 : 30e3 })) as ReadAnswer;
  const d = r.data;
  if (!r.error && !(d?.error && d.status)) return ok(res, d);
  if (kept) return ok(res, kept);
  if (r.error) return fail(res, r.status || 502, r.error, r.offline ? { offline: true } : {});
  fail(res, d.status, d.error);
}
// Every step of a post, and its plan.
route("GET", "/api/sessions/:id/steps", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "work");
  if (p) await workOf(res, p, "read.steps", { post: p.local }, work.steps(p.D, p.local));
});
// One of a post's workers' latest steps (its subagent's), read from its machine when you open it on the page.
route("GET", "/api/sessions/:id/workers/:worker/steps", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "work");
  if (!p) return;
  const r = (await relay.read(p.D, "read.worker", { post: p.local, worker: params.worker })) as ReadAnswer;
  if (r.error) return fail(res, r.status || 502, r.error, r.offline ? { offline: true } : {});
  if (r.data?.error && r.data.status) return fail(res, r.data.status, r.data.error);
  ok(res, r.data);
});
// A picture a post's agent saw, the i-th on one of its steps: a screenshot it took, an image it read or made.
// Read back from its transcript; ?download=1 saves it.
const SHOT_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
route("GET", "/api/sessions/:id/images/:step/:i", async (req, res, { params, query }) => {
  const p = postOr404(req, res, params.id, "work");
  if (!p) return;
  if (!/^\d+$/.test(params.i)) return fail(res, 404, "Couldn't find this image in the transcript.");
  const kept = work.image(p.D, p.local, params.step, Number(params.i));
  if (kept && blobs.has(kept.sha) && SHOT_EXT[kept.type]) {
    const buf = blobs.read(kept.sha);
    res.writeHead(200, {
      "content-type": kept.type,
      "content-length": buf.length,
      "content-disposition": `${query.get("download") === "1" ? "attachment" : "inline"}; filename="${safeName(`${p.s.label || "session"} ${Number(params.i) + 1}`)}.${SHOT_EXT[kept.type]}"`,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    });
    return res.end(buf);
  }
  const r = (await relay.read(p.D, "read.image", { post: p.local, step: params.step, i: Number(params.i) })) as ReadAnswer<MediaAnswer>;
  const img = r.data;
  const ext = SHOT_EXT[img?.type];
  if (r.error || img?.error || !ext) return fail(res, r.status || img?.status || 404, r.error || img?.error || "Couldn't find this image in the transcript.");
  const buf = Buffer.from(img.data, "base64");
  res.writeHead(200, {
    "content-type": img.type,
    "content-length": buf.length,
    "content-disposition": `${query.get("download") === "1" ? "attachment" : "inline"}; filename="${safeName(`${img.label || "session"} ${Number(params.i) + 1}`)}.${ext}"`,
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  res.end(buf);
});

// A picture from elsewhere on the web in a post or a page, from the copy kept with it (web-pictures.ts), so the
// site it's on never sees who's looking; ?download=1 saves it. Or one on the machine its agent works on.
export const webPictures = createWebPictures({ dir: path.join(FILES_DIR, "pictures"), hosts: (process.env.AGENTBOOK_PICTURE_HOSTS || "").split(",") });
// Web addresses agents write, as cards: read from the page's head once, kept a while.
const unfurl = createUnfurl({ hosts: (process.env.AGENTBOOK_PICTURE_HOSTS || "").split(",") });
export async function sendWebPicture(res: Res, owner, url, query: URLSearchParams, load = null) {
  let p;
  try {
    p = await webPictures.get(owner, url, { load });
  } catch (e) {
    return fail(res, e.status || 502, e.message);
  }
  res.writeHead(200, {
    "content-type": p.type,
    "content-length": p.size,
    "content-disposition": `${query.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(p.name)}`,
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  });
  fs.createReadStream(p.file).pipe(res);
}
// A post's text file (up to 2 MB): kept here, or read from its machine.
async function textOf(D: Device, f) {
  try {
    if (!(f.size <= 2 * 1048576)) return "";
    if (f.blob && blobs.has(f.blob)) return blobs.read(f.blob).toString("utf8");
    const r = (await relay.command(D, "read.media", { post: f.post || "", file: f.id }, { wait: 15e3 })) as MediaAnswer;
    return r?.data && r.status === 200 ? Buffer.from(r.data, "base64").toString("utf8") : "";
  } catch {
    return "";
  }
}
// Only one its agent put in what its viewer may see of the post, or in a markdown file of the post's they may open.
route("GET", "/api/sessions/:id/picture", async (req, res, { params, query }) => {
  const p = postOr404(req, res, params.id);
  if (!p) return;
  const s = sessionDetail(p.D.store.state, p.local);
  const url = String(query.get("url") || "");
  const inFile = async () => {
    if (!seesWork(req, p)) return false;
    for (const f of p.D.store.state.files) if (f.post === p.local && !f.pending && /\.(md|markdown)$/i.test(f.name) && names([await textOf(p.D, f)], url)) return true;
    return false;
  };
  if (!names(postWords(detailFor(s, p.agent, p.mine, ownerName(p.D), seesWork(req, p))), url) && !(await inFile())) return fail(res, 404, "This thread has no such picture.");
  await sendWebPicture(res, `post-${p.id}`, url, query, localPicture(url) ? () => keptPicture(p.D, p.local, url) : null);
});
// A web address its agent wrote, as a card: its page's title, description, site and
// whether it has a picture, which /link/picture serves through the picture proxy. Only an address the thread's own
// words have, as for its pictures.
async function linkOf(req: Viewer, res: Res, params, query: URLSearchParams) {
  const p = postOr404(req, res, params.id);
  if (!p) return null;
  const s = sessionDetail(p.D.store.state, p.local);
  const url = String(query.get("url") || "");
  if (!/^https?:\/\//i.test(url) || url.length > 2000 || !names(postWords(detailFor(s, p.agent, p.mine, ownerName(p.D))), url)) return void fail(res, 404, "This thread has no such link.");
  try {
    return { p, card: await unfurl.card(url) };
  } catch (e) {
    return void fail(res, e.status || 502, e.message);
  }
}
route("GET", "/api/sessions/:id/link", async (req, res, { params, query }) => {
  const got = await linkOf(req, res, params, query);
  if (got) send(res, 200, { url: got.card.url, title: got.card.title, text: got.card.text, site: got.card.site, image: !!got.card.image });
});
route("GET", "/api/sessions/:id/link/picture", async (req, res, { params, query }) => {
  const got = await linkOf(req, res, params, query);
  if (!got) return;
  if (!got.card.image) return fail(res, 404, "That page has no picture.");
  await sendWebPicture(res, `post-${got.p.id}`, got.card.image, query);
});
// A picture a post's agent names by its path on its machine (`![](/tmp/shot.png)`, a screenshot it took): its
// machine reads it as soon as its agent names it and sends it up (post.picture), and it's kept here like one from
// the web, as it was then. Named again, it's kept as it is now.
export function pictureSent(D: Device, op) {
  if (!op.sha) return;
  webPictures.get(`post-${relay.idOf(D, op.post)}`, op.url, { load: () => picture(blobs.read(op.sha) || Buffer.alloc(0), path.basename(op.url)), fresh: true }).catch(() => {});
}
// The copy of one its machine sent, or why there's none: what it said when it couldn't read it. One it hasn't sent is
// asked of it: another machine of yours, linked to this page, sends a thread's work only when asked
// (plugin/cli/uplink.ts). Failing that (an agentbook-cli from before read.picture), one named a moment ago may be on its
// way, so that's waited for, a little, while its machine is on.
async function keptPicture(D: Device, post: string, url) {
  let k = work.picture(D, post, url);
  if (!k) {
    const r = (await relay.read(D, "read.picture", { post, url }, { wait: 15e3 })) as ReadAnswer<MediaAnswer>;
    if (!r.error && r.data?.data && !r.data.error) return picture(Buffer.from(r.data.data, "base64"), path.basename(url));
    for (const until = Date.now() + 3000; !k && relay.online(D) && Date.now() < until; k = work.picture(D, post, url)) await new Promise((r) => setTimeout(r, 100));
    const why = r.data?.error ? r.data : r;
    if (!k) throw Object.assign(new Error(why.error || `${D.name} hasn't sent that picture.`), { status: why.status || 404 });
  }
  if (!k.sha) throw Object.assign(new Error(k.error || "Its machine couldn't read that picture."), { status: k.status || 404 });
  const buf = blobs.read(k.sha);
  if (!buf) throw Object.assign(new Error("That picture isn't kept any more."), { status: 404 });
  return picture(buf, path.basename(url));
}

// A file a post's agent names in what it writes (`notes/plan.md`), for its owner to read on the page: its machine
// reads it, from the post's folder, ~ or /. A page or a picture comes back with a peek link, to load in a
// sandboxed frame (see /api/peek); a video or a sound with one to play. A folder comes back as a list.
route("GET", "/api/sessions/:id/file", async (req, res, { params, query }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const asked = String(query.get("path") || "").trim();
  if (!asked) return fail(res, 400, "Which file?");
  await readOf(res, p.D, "read.file", { post: p.local, path: asked }, { as: (d) => withPeek(p.D, d) });
});
// A machine's file with a peek root: the root becomes a link here, good for an hour, for whoever asked.
export function withPeek(D: Device, d) {
  if (!d?.peek) return d;
  const { root, via, path: rel } = d.peek;
  return { ...d, peek: { id: peekLink(D, root, via), path: rel } };
}

// Peek links: the files in one folder on a machine, for a sandboxed frame on the page. That frame belongs to no
// site, so it can't use your sign-in, and what it loads (a page's stylesheet) goes without your cookie. The link
// is the key instead: handed only to whoever opened the file, and good for an hour. Hidden files (.env, .git) stay
// out, and the machine serves only a folder it handed out itself.
const peeks = new Map();
function peekLink(D: Device, root, via) {
  const now = Date.now();
  for (const [t, p] of peeks) if (p.until < now) peeks.delete(t);
  for (const [t, p] of peeks) if (p.D === D && p.root === root && p.via === via && p.until - now > 30 * 60e3) return t;
  const t = crypto.randomBytes(16).toString("hex");
  peeks.set(t, { D, root, via, until: now + 60 * 60e3 });
  return t;
}
// What a page in a peek frame may do: run its own scripts and load what it links to, as no site at all, so never
// as you on agentbook.
export const PEEK_CSP = "sandbox allow-scripts allow-forms allow-popups";
const PEEK_TYPES = { ".htm": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon", ".avif": "image/avif" };
route("GET", "/api/peek/:token/(?<rest>.+)", async (req, res, { params }) => {
  const p = peeks.get(params.token);
  if (!p || p.until < Date.now()) return fail(res, 404, "This link has run out. Open the file again.");
  const rel = path.posix.normalize(params.rest);
  if (rel.split("/").some((part) => part.startsWith("."))) return fail(res, 404, "Not found");
  const r = (await relay.command(p.D, "read.peek", { root: p.root, path: rel, via: p.via || "", ...(req.headers.range ? { range: String(req.headers.range).slice(0, 100) } : {}) }, { wait: 60e3 })) as MediaAnswer;
  if (r?.error) return fail(res, r.status || 502, r.error);
  const ext = path.extname(rel).toLowerCase();
  const buf = Buffer.from(r.data || "", "base64");
  res.writeHead(r.status || 200, {
    "content-type": PEEK_TYPES[ext] || TYPES[ext] || MIME[ext] || r.type || "application/octet-stream",
    "content-length": buf.length,
    ...(r.headers || {}),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": PEEK_CSP,
  });
  res.end(buf);
});
