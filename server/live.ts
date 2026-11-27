// The page's live events: each open page has a stream of its own, says what it shows by
// asking for it (a query with its `live` id watches what it returned), and hears only about that.
//
// What changed is marked as it happens (a thread, by its page's id; everything of a machine; everything), and goes
// out with the next push: for each page, each thing it watches that was marked is made again as its person sees it,
// and what's different from what the page has goes to it. A thread's steps, live line and changes come from what its
// machine sent, as it sent it.
//
// A page names its stream (`?live=`, an id it makes up), so its browser reconnects to the same one. Each page's events
// are numbered: one that reconnects with the number of the last one it had gets what came after, while it's kept
// (BUFFER events, for KEEP_MS after it went away); else `reset`, and it asks again for what it shows.
//
// The page reads them on a WebSocket (`socket`, { id, event, data } each): a browser holds at most six connections to
// a server over plain HTTP, and an event stream in every open tab used them all up, so a sixth tab froze every page. An
// event stream (`connect`) gives the same events, for a page behind a proxy that doesn't pass WebSockets.
//
// Who a page is for is asked again before each push (`whoIs`), not only when it connected: a page whose sign-in
// ended (signed out, signed out everywhere, a new password, the account disabled) is closed and forgotten, and its
// browser, asking again, is told to sign in.
//
// Events (each `data` is JSON):
//   hello     { live, reset }                               its id; reset: what it watched is gone, ask again
//   put       { records: { "thread:a": {…} } }              things it shows, changed
//   del       { keys: ["thread:a"] }                        things it showed, gone (or not its person's to see any more)
//   messages  { thread, put: [{…}], del: [id] }             the open thread's messages, new or changed, and gone
//   live      { thread, live }                              what the open thread is doing this moment (null: nothing)
//   runs      { thread, put: [{…}], del: ["message:block"] }  the open thread's code blocks' runs, new or changed (what
//             a running one printed so far), and gone
//   steps     { thread, from, steps, total, plan, turn }    the open thread's steps from `from` on, as its machine sent them
//   changes   { thread, scope }                             what a scope of the open thread changed is new: read it again
//   side      { v, put?, del?, order?, data? }                the chrome it shows (q/side), what changed in it: records
//             new or changed, by key; keys gone; each kind's keys in order, for kinds whose order changed; and data
//   feed      { v, gone?, swap?, top?, new?, records?, live?, counts?, menus? }   the feed it shows (q/feed), what
//             changed in it: v, which asking for it this is about (q/feed's `watching`); gone, keys it shows that left
//             it; swap, a start it shows that is now a thread, { "launch:l": "thread:t" }, in its place; top, starts to
//             put on top (and threads from a start it never got to show); new, the keys it doesn't show that came in
//             above where it has got to (it shows "N new", and
//             asks again for them); records, the cards it shows that changed; live, what its threads are doing this
//             moment, by thread (null: nothing); counts and menus, as q/feed says them
//   panel     { page, key, panel }                          a dashboard's panel, answered after its page asked for it
//             (POST /api/pages/:id/panels, `key` the view it asked for)

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforePlace } from "./feed.ts";
import { sideDiff } from "./side.ts";
import type { Feed, FeedItem, FeedParams } from "./feed.ts";
import type { Side } from "./side.ts";
import type { WorkSent } from "./work.ts";
import type { Iso } from "../plugin/shared/types.ts";

const CLOCKS = 60e3; // how far a machine's clock may be from this one's, for when a thread it says started

const BUFFER = 200;
const KEEP_MS = 120e3;
const MAX_PER_USER = 50; // most live connections one person may hold at once, so one account can't pile them up
const runKey = (r: LiveRun) => `${r.message}:${r.block}`;
const runsSent = (runs: LiveRun[] | null | undefined) => new Map((runs || []).map((r) => [runKey(r), JSON.stringify(r)]));

// Who a page is for: a request, with the person signed in (main.ts's Req).
export interface LiveReq {
  user?: { id: string } | null;
}
// A code block's run, by the page's id for its message and which of its blocks.
interface LiveRun {
  message: string;
  block: number;
}
// A thread as a page shows it on its own page (threadOf): its record, its messages, what it's doing this moment, its
// code blocks' runs, and whether the person sees its work.
export interface LiveThread {
  record: unknown;
  messages: { id: string; at?: Iso }[];
  live?: unknown;
  runs?: LiveRun[] | null;
  work?: boolean;
}
// The feed as a page's person sees it (feedOf): feed.ts's, with each item's record and each thread's live line.
export interface LiveFeed extends Pick<Feed, "list" | "counts" | "menus"> {
  record(key: string): unknown;
  live(id: string): unknown;
}
// What changed of a thread's work, as its machine sent it: its steps, or a scope of its changes.
type StepsOp = Extract<WorkSent, { t: "post.steps" }>;
export interface LiveOptions<R extends LiveReq, C extends object> {
  threadOf: (req: R, id: string) => LiveThread | null;
  deviceOf?: (id: string) => string | null;
  feedOf?: ((req: R, params: FeedParams, ctx: C) => LiveFeed) | null;
  sideOf?: ((req: R, ctx: C) => Side) | null;
  whoIs?: ((req: R, ctx: C) => R["user"] | null) | null;
}
// How a page's events go to it: an event stream, or a WebSocket.
interface Out {
  send(seq: number, event: string, json: string): void;
  ping(): void;
  end(signedOut?: boolean): void;
}
// The WebSocket a page reads its events on (ws.ts).
interface LiveSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  onClose?: () => void;
}
// What a page shows and hears about: the thread open on it, the feed and the chrome. Each says which asking it was
// (`v`), and what the page has of it, as JSON.
interface ThreadSlot {
  kind: "thread";
  v: number;
  id: string;
  record: string;
  sent: Map<string, string>;
  since: string;
  live: string;
  runs: Map<string, string>;
}
interface FeedSlot {
  kind: "feed";
  v: number;
  at: number;
  params: FeedParams;
  key: string;
  shown: string[];
  next: string | null;
  sent: Map<string, string>;
  live: Map<string, string>;
  counts: string;
  menus: string;
  fresh: string;
}
interface SideSlot {
  kind: "side";
  v: number;
  had: Map<string, string>;
  order: string;
  data: string;
}
interface SlotKinds {
  open: ThreadSlot;
  feed: FeedSlot;
  side: SideSlot;
}
// A page's slots, each under its name (a Map).
interface Slots {
  get<K extends keyof SlotKinds>(k: K): SlotKinds[K] | undefined;
  get(k: string): SlotKinds[keyof SlotKinds] | undefined;
  set<K extends keyof SlotKinds>(k: K, v: SlotKinds[K]): unknown;
  has(k: string): boolean;
  delete(k: string): boolean;
}
interface LivePage<R> {
  id: string;
  uid: string;
  req: R;
  out: Out | null;
  seq: number;
  buffer: { seq: number; event: string; json: string }[];
  slots: Slots;
  gone: ReturnType<typeof setTimeout> | null;
}
// What a page is shown of the feed or the chrome when it changes (the `feed` and `side` events).
interface SideEvent {
  v: number;
  put?: Record<string, unknown>;
  del?: string[];
  order?: Record<string, string[]>;
  data?: Side["data"];
}
interface FeedEvent {
  v: number;
  gone?: string[];
  swap?: Record<string, string>;
  top?: string[];
  new?: string[];
  records?: Record<string, unknown>;
  live?: Record<string, unknown>;
  counts?: Feed["counts"];
  menus?: Feed["menus"];
}
// What a page says it got: its name for its stream, and the last event it had.
interface Resume {
  id?: string | null;
  last?: string | string[] | null;
}
// What a page got of the feed: its key, the keys it shows in order, where the feed goes on after them (null: it got
// all of it), and the records and live lines of what it shows.
interface FeedShown {
  key: string;
  shown: string[];
  next: string | null;
  records: Record<string, unknown>;
  live?: Record<string, unknown> | null;
}

// `threadOf(req, id)`: a thread as req's person sees it on its page, { record, messages, live, runs, work }, or null.
// `deviceOf(id)`: the id of the machine a thread is on, or null. `feedOf(req, params, ctx)`: the feed as req's person
// sees it, { list: [{ key, kind, sort }], counts, menus, record(key), live(id) } (`ctx`: what flush was given, the same
// for every page of one push). `sideOf(req, ctx)`: the chrome as req's person sees it ({ records, order, data },
// side.ts). `whoIs(req, ctx)`: the person req's sign-in is now, or null when it isn't any more.
export type Live = ReturnType<typeof createLive>;
export function createLive<R extends LiveReq, C extends object = object>({ threadOf, deviceOf = () => null, feedOf = null, sideOf = null, whoIs = null }: LiveOptions<R, C>) {
  const pages = new Map<string, LivePage<R>>(); // live id -> { id, uid, req, out, seq, buffer, slots, gone }
  let asked = 0; // each time a page asks for a feed, so it can tell what's about which
  let dirty = fresh();
  function fresh() {
    // view: something changed that a list could show (not only a thread's steps or which of its changes are new).
    return { all: false, view: false, devices: new Set<string>(), threads: new Set<string>(), steps: new Map<string, StepsOp[]>(), changes: new Map<string, Set<string>>() };
  }

  /* ---------- a page's stream ---------- */

  // A page's event stream opens, or opens again: `id`, the page's name for it, and `last`, the last event it had (none
  // the first time).
  function connect(req: R & { on(event: "close", fn: () => void): unknown }, res: { writeHead(status: number, headers: Record<string, string>): unknown; write(chunk: string): unknown; end(): unknown }, { id = null, last = null }: Resume = {}) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const out: Out = {
      send: (seq, event, json) => res.write(`id: ${seq}\nevent: ${event}\ndata: ${json}\n\n`),
      ping: () => res.write(": keepalive\n\n"),
      end: () => res.end(),
    };
    return attach(req, out, (gone) => req.on("close", gone), { id, last });
  }
  // The same on a page's WebSocket (ws.ts, which pings it itself). A page whose sign-in ended is told so as it closes.
  function socket(req: R, ws: LiveSocket, { id = null, last = null }: Resume = {}) {
    const out: Out = {
      send: (seq, event, json) => ws.send(`{"id":${seq},"event":${JSON.stringify(event)},"data":${json}}`),
      ping: () => {},
      end: (signedOut) => ws.close(signedOut ? 4401 : 1000, signedOut ? "Signed out" : ""),
    };
    return attach(req, out, (gone) => (ws.onClose = gone), { id, last });
  }
  // `out`: how its events go (send, ping, end). `onGone(fn)`: fn is called once the page has gone.
  function attach(req: R, out: Out, onGone: (gone: () => void) => void, { id, last }: Resume): string {
    const named = typeof id === "string" && /^[\w-]{8,64}$/.test(id);
    const had = pages.get(id);
    let p = had && had.uid === req.user.id ? had : null; // someone else's is theirs to keep
    const n = last == null || last === "" ? NaN : Number(last);
    const caught = p && Number.isSafeInteger(n) && (n === p.seq || p.buffer.some((e) => e.seq === n + 1));
    if (p && caught) {
      clearTimeout(p.gone);
      // The one it had goes (after, so its going isn't taken for the page's).
      const was = p.out;
      Object.assign(p, { req, out, gone: null });
      was?.end();
      for (const e of p.buffer) if (e.seq > n) out.send(e.seq, e.event, e.json);
    } else {
      if (p) drop(p);
      // One person can't pile up live connections and bog the shared process: once they're at the cap, drop their
      // oldest (the Map keeps insertion order) to make room for this one.
      const mine = [...pages.values()].filter((x) => x.uid === req.user.id);
      if (mine.length >= MAX_PER_USER) {
        mine[0].out?.end();
        drop(mine[0]);
      }
      p = { id: named && (!had || had.uid === req.user.id) ? id : crypto.randomUUID(), uid: req.user.id, req, out, seq: 0, buffer: [], slots: new Map(), gone: null };
      pages.set(p.id, p);
      // Starting over: it had something it no longer has (its events, or its name, someone else's).
      send(p, "hello", { live: p.id, reset: Number.isSafeInteger(n) || (!!id && p.id !== id) });
    }
    const page = p;
    onGone(() => {
      if (page.out !== out) return;
      page.out = null;
      page.gone = setTimeout(() => drop(page), KEEP_MS);
      page.gone.unref?.();
    });
    return page.id;
  }
  function drop(p: LivePage<R>) {
    clearTimeout(p.gone);
    pages.delete(p.id);
  }
  // Each page whose sign-in ended: closed, and nothing of it kept. The others go on as who they are now (a new
  // display name, a role). `ctx`: what flush was given.
  function check(ctx = {} as C) {
    if (!whoIs) return;
    for (const p of [...pages.values()]) {
      const u = whoIs(p.req, ctx);
      if (u && u.id === p.uid) {
        p.req.user = u;
        continue;
      }
      drop(p);
      const out = p.out;
      p.out = null;
      out?.end(true);
    }
  }
  function send(p: LivePage<R>, event: string, data: unknown) {
    p.seq++;
    const e = { seq: p.seq, event, json: JSON.stringify(data) };
    p.buffer.push(e);
    if (p.buffer.length > BUFFER) p.buffer.shift();
    p.out?.send(e.seq, e.event, e.json);
  }
  // A page of this person's, by its id, or null.
  const pageOf = (req: R, id: string | null | undefined): LivePage<R> | null => {
    const p = id && pages.get(id);
    return p && p.uid === req.user.id ? p : null;
  };
  // Something for one page of this person's alone, as it comes: a dashboard's panel answered after its page asked
  // (`panel`). False when there's no such page.
  function tell(req: R, liveId: string, event: string, data: unknown): boolean {
    const p = pageOf(req, liveId);
    if (!p) return false;
    send(p, event, data);
    return true;
  }

  /* ---------- what a page watches ---------- */

  // A page shows a thread on its own page: from now on it hears about it, starting from what it was given
  // (`t`, as threadOf made it, with `messages` the ones it got: the latest, from `since` on, or all).
  function watchThread(req: R, liveId: string, id: string, t: LiveThread, { messages = t.messages, since = "" }: { messages?: LiveThread["messages"]; since?: string } = {}): number | false {
    const p = pageOf(req, liveId);
    if (!p) return false;
    const sent = new Map(messages.map((m) => [m.id, JSON.stringify(m)]));
    const v = ++asked;
    p.slots.set("open", { kind: "thread", v, id, record: JSON.stringify(t.record), sent, since, live: JSON.stringify(t.live ?? null), runs: runsSent(t.runs) });
    return v;
  }
  // A page shows the feed (q/feed, with `params`, as `key` says them): from now on it hears what changes in it. `shown`,
  // the keys it got, in order; `next`, where the feed goes on after them (null: it got all of it); `records` and
  // `live`, what it got of them. Its events say `v`, which this returns (false: no such page of this person's).
  function watchFeed(req: R, liveId: string, { params, key, shown, next, records, live, counts, menus }: FeedShown & { params: FeedParams; counts: Feed["counts"]; menus: Feed["menus"] }): number | false {
    const p = pageOf(req, liveId);
    if (!p) return false;
    const s: FeedSlot = { kind: "feed", v: ++asked, at: Date.now(), params, key, shown: [], next, sent: new Map(), live: new Map(), counts: JSON.stringify(counts), menus: JSON.stringify(menus), fresh: "[]" };
    p.slots.set("feed", s);
    take(s, shown, records, live);
    return s.v;
  }
  // A page shows the chrome (q/side, `side` as it got it): from now on it hears what changes in it.
  function watchSide(req: R, liveId: string, side: Side): number | false {
    const p = pageOf(req, liveId);
    if (!p) return false;
    const s: SideSlot = { kind: "side", v: ++asked, had: new Map(), order: JSON.stringify(side.order), data: JSON.stringify(side.data) };
    sideDiff(s.had, side);
    p.slots.set("side", s);
    return s.v;
  }
  // It got more of the same feed, from where it had got to: its `v`, or false when it watches another.
  function moreFeed(req: R, liveId: string, { key, shown, next, records, live }: FeedShown): number | false {
    const s = pageOf(req, liveId)?.slots.get("feed");
    if (!s || s.key !== key) return false;
    take(s, shown, records, live);
    s.next = next;
    return s.v;
  }
  function take(s: FeedSlot, keys: string[], records: Record<string, unknown>, live: Record<string, unknown> | null | undefined) {
    for (const k of keys) {
      if (!s.shown.includes(k)) s.shown.push(k);
      s.sent.set(k, JSON.stringify(records[k] ?? null));
    }
    for (const [id, l] of Object.entries(live || {})) s.live.set(id, JSON.stringify(l ?? null));
  }
  // It doesn't any more (it went elsewhere). `v`: only if it's still that asking (a feed it asked for since stays).
  function unwatch(req: R, liveId: string, slot: string, v: number | null = null): boolean {
    const p = pageOf(req, liveId);
    if (p && (v == null || p.slots.get(slot)?.v === v)) p.slots.delete(slot);
    return !!p;
  }

  /* ---------- what changed ---------- */

  // Something changed: a thread (by its page's id), with what its machine sent of its work; everything of a machine;
  // or everything.
  function mark({ all = false, device = null, thread = null, steps = null, changes = null }: { all?: boolean; device?: string | null; thread?: string | null; steps?: StepsOp | null; changes?: string | null } = {}) {
    if (!pages.size) return;
    if (all || device || (thread && !steps && !changes)) dirty.view = true;
    if (all) dirty.all = true;
    if (device) dirty.devices.add(device);
    if (thread) dirty.threads.add(thread);
    if (thread && steps) (dirty.steps.get(thread) || dirty.steps.set(thread, []).get(thread)).push(steps);
    if (thread && changes) (dirty.changes.get(thread) || dirty.changes.set(thread, new Set()).get(thread)).add(changes);
  }

  // What changed since the last push, to the pages that show it. `ctx` goes to feedOf, the same for every page.
  function flush(ctx = {} as C) {
    const d = dirty;
    dirty = fresh();
    if (!pages.size || (!d.all && !d.devices.size && !d.threads.size)) return;
    check(ctx);
    for (const p of pages.values()) {
      if (d.view && p.slots.has("side") && sideOf) flushSide(p, p.slots.get("side"), ctx);
      if (d.view && p.slots.has("feed") && feedOf) flushFeed(p, p.slots.get("feed"), ctx);
      const s = p.slots.get("open");
      if (!s || !(d.all || d.threads.has(s.id) || d.devices.has(deviceOf(s.id)))) continue;
      const t = threadOf(p.req, s.id);
      const key = `thread:${s.id}`;
      if (!t) {
        p.slots.delete("open");
        send(p, "del", { keys: [key] });
        continue;
      }
      const record = JSON.stringify(t.record);
      if (record !== s.record) {
        s.record = record;
        send(p, "put", { records: { [key]: t.record } });
      }
      const put = [];
      const have = new Set();
      for (const m of t.messages) {
        if ((m.at || "") < s.since && !s.sent.has(m.id)) continue;
        have.add(m.id);
        const json = JSON.stringify(m);
        if (s.sent.get(m.id) === json) continue;
        s.sent.set(m.id, json);
        put.push(m);
      }
      const del = [...s.sent.keys()].filter((id) => !have.has(id));
      for (const id of del) s.sent.delete(id);
      if (put.length || del.length) send(p, "messages", { thread: s.id, put, del });
      const live = JSON.stringify(t.live ?? null);
      if (live !== s.live) {
        s.live = live;
        send(p, "live", { thread: s.id, live: t.live ?? null });
      }
      // Each run on its own, so one printing as it goes sends only itself.
      const runs = runsSent(t.runs);
      const changed = [...runs].filter(([k, json]) => s.runs.get(k) !== json).map(([k]) => (t.runs || []).find((r) => runKey(r) === k));
      const gone = [...s.runs.keys()].filter((k) => !runs.has(k));
      s.runs = runs;
      if (changed.length || gone.length) send(p, "runs", { thread: s.id, put: changed, del: gone });
      if (!t.work) continue;
      for (const op of d.steps.get(s.id) || []) send(p, "steps", { thread: s.id, from: op.from ?? 0, steps: op.steps || [], total: op.total ?? null, plan: op.plan ?? null, turn: op.turn ?? 0 });
      for (const scope of d.changes.get(s.id) || []) send(p, "changes", { thread: s.id, scope });
    }
  }

  // The chrome a page shows, made again: what's different from what it has.
  function flushSide(p: LivePage<R>, s: SideSlot, ctx: C) {
    const side = sideOf(p.req, ctx);
    const { put, del } = sideDiff(s.had, side);
    const out: SideEvent = { v: s.v };
    if (Object.keys(put).length) out.put = put;
    if (del.length) out.del = del;
    const order = JSON.stringify(side.order);
    if (order !== s.order) {
      const was: Side["order"] = JSON.parse(s.order);
      out.order = Object.fromEntries(Object.entries(side.order).filter(([k, keys]) => JSON.stringify(keys) !== JSON.stringify(was[k])));
      for (const k of Object.keys(was)) if (!(k in side.order)) out.order[k] = [];
      s.order = order;
    }
    const data = JSON.stringify(side.data);
    if (data !== s.data) {
      out.data = side.data;
      s.data = data;
    }
    if (Object.keys(out).length > 1) send(p, "side", out);
  }

  // The feed a page shows, made again: the cards it shows stay where they are and change in place; one that left it
  // goes; a thread takes the place of the start it came from; a start goes on top. What else came in above where it
  // has got to is new: the page says how many, and asks for them.
  function flushFeed(p: LivePage<R>, s: FeedSlot, ctx: C) {
    const f = feedOf(p.req, s.params, ctx);
    const listed = new Map(f.list.map((it) => [it.key, it]));
    const out: FeedEvent = { v: s.v };
    const shown: string[] = [];
    for (const k of s.shown) {
      if (listed.has(k)) shown.push(k);
      else {
        const t = k.startsWith("launch:") && f.list.find((it) => it.kind === "thread" && it.x?.launch === k.slice(7) && !s.shown.includes(it.key) && !shown.includes(it.key));
        if (t) {
          shown.push(t.key);
          (out.swap ||= {})[k] = t.key;
        } else (out.gone ||= []).push(k);
      }
    }
    // A start goes on top, and so does a thread from one that was a thread already by the time this looked (an
    // OpenClaw session starts in the moment it's asked for): it would have taken its start's place, which the page
    // never showed. Only one that started since the page got its list (give or take its machine's clock), so an old
    // one coming back into it (working again) is new, as before.
    const begun = (it: FeedItem) => it.kind === "thread" && !!it.x?.launch && Date.parse(it.x.started) > s.at - CLOCKS && (!s.next || beforePlace(it, s.next));
    const top = f.list.filter((it) => !shown.includes(it.key) && (it.kind === "launch" || begun(it))).map((it) => it.key);
    if (top.length) {
      shown.unshift(...top);
      out.top = top;
    }
    const has = new Set(shown);
    const fresh = f.list.filter((it) => it.kind !== "launch" && !has.has(it.key) && (!s.next || beforePlace(it, s.next))).map((it) => it.key);
    for (const k of s.sent.keys()) if (!has.has(k)) s.sent.delete(k);
    for (const k of shown) {
      const r = f.record(k);
      const json = JSON.stringify(r ?? null);
      if (s.sent.get(k) === json) continue;
      s.sent.set(k, json);
      (out.records ||= {})[k] = r;
    }
    const threads = new Set(shown.filter((k) => k.startsWith("thread:")).map((k) => k.slice(7)));
    for (const id of s.live.keys()) if (!threads.has(id)) s.live.delete(id);
    for (const id of threads) {
      const l = f.live(id) ?? null;
      const json = JSON.stringify(l);
      if ((s.live.get(id) ?? "null") === json) continue;
      s.live.set(id, json);
      (out.live ||= {})[id] = l;
    }
    s.shown = shown;
    const json = { fresh: JSON.stringify(fresh), counts: JSON.stringify(f.counts), menus: JSON.stringify(f.menus) };
    if (json.fresh !== s.fresh) out.new = fresh;
    if (json.counts !== s.counts) out.counts = f.counts;
    if (json.menus !== s.menus) out.menus = f.menus;
    Object.assign(s, json);
    if (Object.keys(out).length > 1) send(p, "feed", out);
  }

  const keepalive = setInterval(() => {
    for (const p of pages.values()) p.out?.ping();
  }, 20000);
  keepalive.unref?.();

  return {
    connect,
    socket,
    watchThread,
    watchFeed,
    moreFeed,
    watchSide,
    unwatch,
    mark,
    flush,
    check,
    pageOf,
    tell,
    // Pages it keeps (a while after they go away), and pages open now.
    get size() {
      return pages.size;
    },
    get open() {
      let n = 0;
      for (const p of pages.values()) if (p.out) n++;
      return n;
    },
  };
}
