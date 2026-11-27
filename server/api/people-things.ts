// What goes between you and people elsewhere once they're your contacts, or in something of yours.
//
//   - Yours to them: each person who sees something of yours is fed what they may see (../publish.ts), as it changes,
//     into your door's outbox: what's new or changed as `records`, what they may not see any more as `withdraw`. What
//     each was sent last, by version, is door.db's `published`, which the door's `all` says on each connection.
//   - Theirs to you: what a contact publishes, each record signed by its author's door, kept apart from everything of
//     yours (remote_records), shown on your page as theirs, and never given to your agents: nothing an agent reads
//     (ab_search, ab_thread_read, a thread's context) reads it, and these routes take only your browser. What their
//     door doesn't say for 14 days goes.
//   - Their agents: in your feed or not as you follow them (agent_follows, as r:<their user id>:<its id there>), which
//     is yours alone. Their threads and pages that reach your feed are on it, read only (theirCards), from what their
//     door sent, which only your browser gets: views.ts keeps them out of the view your agents read.
//   - Mentions: what you publish lists the people its @handles name, by their accounts, as your page knows them
//     (nobody else can be named: nobody can be looked up); what you get rings your bell when it names your account.

import { ACCOUNT } from "../config.ts";
import { recordHolds } from "../../plugin/shared/door/sign.ts";
import type { InboxRow } from "../../plugin/shared/door/db.ts";
import type { User } from "../accounts.ts";
import { accounts, log, store } from "../core/state.ts";
import { pushLive } from "../core/services.ts";
import { agentOnFeed, contactOf, followsPerson } from "../core/follows.ts";
import { theirFeeds } from "./views.ts";
import type { TheirCard } from "../../plugin/shared/api.ts";
import { fail, ok, readBody, route } from "../core/http.ts";
import type { Req, Res } from "../core/http.ts";
import { bellSources } from "../core/bell.ts";
import { clean, keyOf, recordsFor, type Rec } from "../publish.ts";
import { door, relOf, remoteInfo, type Who } from "./door.ts";
import { agentFollowFor } from "./contacts.ts";
import type { RemoteRecordRow } from "../storage/people.ts";
import type { Op } from "../../plugin/shared/ops.ts";

const me = (): User | null => (ACCOUNT ? accounts.byId(ACCOUNT.person) : null);
const people = () => door.people;
const now = () => new Date().toISOString();
// A copy their door hasn't said is still yours to see for this long goes (`all` says it on each connection).
const LEASE_MS = 14 * 86400e3;

// ---------- whom an @handle names ----------
// The account of whoever @h is on your page (you, or someone elsewhere), or null: a username here with no door
// (someone from before accounts) or nobody.
export function named(h: string): string | null {
  const u = accounts.byUsername(h);
  if (!u || u.deleted) return null;
  if (u.id === me()?.id) return ACCOUNT?.account ?? null;
  return people().person(u.id)?.acct ?? null;
}

// ---------- yours to them ----------
const FEED_MS = Number(process.env.AGENTBOOK_FEED_MS || 3000);
let feedTimer: NodeJS.Timeout | null = null;
export function feedSoon() {
  if (feedTimer) return;
  feedTimer = setTimeout(() => {
    feedTimer = null;
    feedAll();
  }, FEED_MS);
  feedTimer.unref?.();
}
// What else goes out with each feed: your threads in other people's groups and tasks (./people-spaces.ts).
const feeders: (() => void)[] = [];
export const alsoFeed = (fn: () => void) => feeders.push(fn);
function feedAll() {
  if (!door.db()) return;
  for (const fn of feeders) {
    try {
      fn();
    } catch (e) {
      log(`door: ${e.stack || e.message}`);
    }
  }
  for (const r of people().people()) {
    try {
      feedOne(r.user_id);
    } catch (e) {
      log(`door: feeding @${r.handle}: ${e.stack || e.message}`);
    }
  }
  checkRefused();
}
// One message's worth: under the 256 KB a message may be, with room for each record's author signature.
const BATCH_BYTES = 180e3;
const PER_RECORD = 2000;
// Records sent, by their outbox row, until their door took them: refused ones go again (they may have arrived before
// that person's page knew they follow you).
const inFlight = new Map<number, { uid: string; acct: string; ids: string[]; at: number }>();
// `again`: everything they may see goes again, as asked (`want`), and what they may not see any more goes as ever.
export function feedOne(uid: string, again = false) {
  const db = door.db();
  const m = me();
  const p = people().person(uid);
  const u = accounts.byId(uid);
  const handle = door.status().handle;
  if (!db || !m || !p || !u || !handle) return;
  if (!again && held(uid)) return;
  const want = fedTo(uid) ? recordsFor(u, m, handle, named) : [];
  const had = new Map(db.publishedTo(p.acct));
  const ids = new Set(want.map(keyOf));
  const changed = again ? want : want.filter((r) => had.get(keyOf(r)) !== r.v);
  const gone = [...had.keys()].filter((id) => !ids.has(id));
  let batch: Rec[] = [];
  let bytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const n = door.send(uid, "records", { items: batch });
    if (n) {
      inFlight.set(n, { uid, acct: p.acct, ids: batch.map(keyOf), at: Date.now() });
      for (const r of batch) db.setPublished(p.acct, keyOf(r), r.v);
    }
    batch = [];
    bytes = 0;
  };
  for (const r of changed) {
    const n = JSON.stringify(r).length + PER_RECORD;
    if (n > BATCH_BYTES) continue;
    if (bytes + n > BATCH_BYTES || batch.length >= 400) flush();
    batch.push(r);
    bytes += n;
  }
  flush();
  for (let i = 0; i < gone.length; i += 1000) {
    const some = gone.slice(i, i + 1000);
    if (door.send(uid, "withdraw", { ids: some })) for (const id of some) db.setPublished(p.acct, id, null);
  }
  if (changed.length || gone.length) log(`door: @${p.handle} gets ${changed.length} new or changed, ${gone.length} taken back`);
}
// Who's fed: your contacts, and whoever other parts say (people in a group of yours).
const fedBy: ((uid: string) => boolean)[] = [(uid) => relOf(uid).includes("contact")];
export const alsoFed = (fn: (uid: string) => boolean) => fedBy.push(fn);
const fedTo = (uid: string) => fedBy.some((fn) => fn(uid));
// Records their door refused go again, after a while that grows each time they're refused (a minute, then up to an
// hour), or as soon as they ask (`want`): a door that keeps saying no isn't sent the same records at every change.
// Ones it took, or that are an hour old, are done with.
const holds = new Map<string, { until: number; ms: number }>();
const held = (uid: string) => (holds.get(uid)?.until || 0) > Date.now();
function checkRefused() {
  const db = door.db();
  if (!db) return;
  for (const [n, x] of inFlight) {
    const s = db.sentOf(n, x.acct);
    if (s?.error) {
      for (const id of x.ids) db.setPublished(x.acct, id, null);
      const ms = Math.min(3600e3, (holds.get(x.uid)?.ms || 30e3) * 2);
      holds.set(x.uid, { until: Date.now() + ms, ms });
      setTimeout(() => feedSoon(), ms + 100).unref?.();
    }
    if (s || Date.now() - x.at > 3600e3) inFlight.delete(n);
  }
}

// ---------- theirs to you ----------
export type Item = { type: string; id: string; v: string; body: unknown; space?: string; mentions?: string[]; author?: { certificate: string; handle: string; sig: string } };
// A certificate's claims, read without checking them: only to tell whether it's the sender's own, whose door key the
// connection proved.
function claimsOf(certificate: string): { acct?: string; key?: string } | null {
  try {
    return JSON.parse(Buffer.from(String(certificate).split(".")[1] || "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
// Something of theirs you're in (`space`, group:<id> and the like), which they're the home of.
export const homeOf = (uid: string, space: string) => people().spaceIn(uid, space)?.state === "in";
const homeOfAny = (uid: string) => people().spacesIn(uid).some((x) => x.state === "in");
// Whose a record is: the sender's own (signed by their door, whose key the connection proved), or one they pass on
// (a comment on a thread of theirs, a thread in something of theirs you're in), by its author's certificate: their
// account, and the handle they signed it as.
async function authorFor(who: Who, it: Item): Promise<{ acct: string; handle: string; key: string } | null> {
  if (!it.author) return null;
  const c = claimsOf(it.author.certificate);
  if (c?.acct === who.acct && c.key === who.door_key) return { acct: who.acct, handle: it.author.handle, key: who.door_key };
  if (!(it.type === "comment" || (it.space && homeOf(who.user_id, it.space)))) return null;
  const a = await door.authorOf(it.author.certificate, it.author.handle);
  return a ? { acct: a.acct, handle: a.handle, key: a.key } : null;
}
// A record of `who`'s, or one they pass on, its signature holding: kept, with only its type's fields, and its
// author's account (`author`); one passed on keeps it as it came too (`item`). False when it doesn't hold.
export async function keepRecord(who: Who, it: Item): Promise<boolean> {
  const by = await authorFor(who, it);
  if (!by || !recordHolds(it as Parameters<typeof recordHolds>[0], by.handle, it.author!.sig, by.key)) {
    log(`door: a ${it.type} from @${who.handle} wasn't signed by whoever it says wrote it: dropped`);
    return false;
  }
  const body = clean(it.type, it.body);
  if (!body) return false;
  const at = now();
  const passedOn = by.acct !== who.acct;
  // Someone's own record isn't replaced by one they pass on with its id.
  const was = people().record(who.user_id, keyOf(it));
  if (passedOn && was && !was.item) return false;
  people().putRecord({ owner: who.user_id, rid: keyOf(it), type: it.type, v: it.v, body: JSON.stringify(body), space: it.space || null, author: by.acct, mentions: JSON.stringify((it.mentions || []).slice(0, 50)), seen: at, got: at, item: it.space || passedOn ? JSON.stringify(it) : null });
  return true;
}
// Who someone elsewhere is on your page, by their account: you, someone your page has a row for, or null.
export function personOfAcct(acct: string | null | undefined): User | null {
  if (!acct) return null;
  if (acct === ACCOUNT?.account) return me();
  const r = people().byAcct(acct);
  const u = r ? accounts.byId(r.user_id) : null;
  return u && !u.deleted ? u : null;
}
const isContact = (uid: string) => relOf(uid).includes("contact");
// Theirs, once they're not your contact and you aren't in anything of theirs.
function dropGone(uid: string) {
  if (!isContact(uid) && !homeOfAny(uid)) people().dropRecordsOf(uid);
}

// ---------- your follows of their agents ----------
// An agent of theirs, as your page names it: r:<their user id>:<its id on their page>.
export const remoteAgentId = (owner: string, agent: string) => `r:${owner}:${agent}`;
// ---------- their things, for your page ----------
// Someone a record names, for your page: the handle they go by, their username here when your page knows them, and
// whether it's you. Their account stays here.
type Shown = { handle: string | null; username: string | null; you: boolean };
function shownAs(acct: unknown, handle: unknown): Shown {
  const u = typeof acct === "string" ? personOfAcct(acct) : null;
  return { handle: typeof handle === "string" ? handle : null, username: u?.username ?? null, you: !!u && u.id === me()?.id };
}
// Who's in a group, on a note or a task, and whose each of a group's threads is, as your page knows them.
function withPeople(type: string, body: Record<string, any>): Record<string, any> {
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => shownAs(x?.acct, x?.handle)) : xs);
  if (type === "group") return { ...body, members: list(body.members), threads: (body.threads || []).map(({ acct, ...t }: Record<string, any>) => ({ ...t, ...shownAs(acct, t.by) })) };
  if (type === "note" || type === "task") return { ...body, people: list(body.people) };
  return body;
}
// For your page: whom it names, as your page knows them (the rest it can't name: nobody can be looked up); who wrote it
// (`author`, their username here; `passed_on` when it's not the sender's own); `yours` when you wrote it.
function parsed(r: RemoteRecordRow) {
  const mentions = (JSON.parse(r.mentions || "[]") as string[]).flatMap((a) => {
    const u = personOfAcct(a);
    return u ? [{ username: u.username, you: u.id === me()?.id }] : [];
  });
  const owner = people().person(r.owner);
  const by = personOfAcct(r.author);
  return { type: r.type, id: r.rid, body: withPeople(r.type, JSON.parse(r.body)), mentions, got: r.got, author: by?.username ?? null, passed_on: !!r.author && r.author !== owner?.acct, yours: !!r.author && r.author === ACCOUNT?.account, space: r.space };
}
// Theirs as rows: a thread without its messages (how many it has instead), a page without its widgets.
function brief(r: RemoteRecordRow) {
  const x = parsed(r);
  const b = x.body;
  if (x.type === "thread") {
    const { messages, ...rest } = b;
    const last = (messages || []).at(-1);
    return { ...x, body: { ...rest, messages: (messages || []).length + (b.earlier || 0), last: last ? { from: last.from, text: String(last.text).slice(0, 280), at: last.at } : null } };
  }
  if (x.type === "page") {
    const { widgets, ...rest } = b;
    return { ...x, body: { ...rest, widgets: (widgets || []).length } };
  }
  return x;
}
function theirs(req: Req, res: Res, username: string) {
  const m = me();
  if (!req.user || req.user.id !== m?.id) return void fail(res, 403, "Only the page's person sees what people elsewhere sent them.");
  const u = accounts.byUsername(username);
  const r = u ? people().person(u.id) : null;
  if (!u || !r) return void fail(res, 404, "Nobody elsewhere by that name.");
  people().dropStale(new Date(Date.now() - LEASE_MS).toISOString());
  return { u, r };
}
// Everything of theirs you have: their card, agents, threads, pages and tasks, and whether each agent is in your feed;
// `as_of`: when their door last said anything.
route("GET", "/api/people/:username/things", (req, res, { params }) => {
  const t = theirs(req, res, params.username);
  if (!t) return;
  const all = people().records({ owner: t.u.id }).filter((r) => !r.space && !r.item);
  const of = (type: string) => all.filter((r) => r.type === type).map(brief);
  const agents = of("agent").map((a) => ({ ...a, ref: remoteAgentId(t.u.id, a.id), follow: agentFollowFor(req, remoteAgentId(t.u.id, a.id), t.u.id) }));
  ok(res, { as_of: t.r.seen, remote: remoteInfo(t.u.id), person: of("person")[0] || null, agents, threads: of("thread"), pages: of("page"), tasks: of("task"), groups: of("group"), notes: of("note") });
});
route("GET", "/api/people/:username/things/:id", (req, res, { params }) => {
  const t = theirs(req, res, params.username);
  if (!t) return;
  const r = people().record(t.u.id, params.id);
  if (!r) return fail(res, 404, "They haven't sent that, or not any more.");
  // A thread's comments (./people-comments.ts), each by whoever wrote it, in the order they were written.
  const id = r.item ? JSON.parse(r.item).id : r.rid;
  const comments = r.type === "thread" ? people().records({ owner: t.u.id, type: "comment" }).map(parsed).filter((c) => c.body.thread === id).sort((a, b) => String(a.body.at).localeCompare(String(b.body.at))) : [];
  // Its work, turn by turn (server/publish.ts's workRecords): a thread of theirs only, not one they pass on.
  const work = r.type === "thread" && !r.space && !r.item ? people().records({ owner: t.u.id, type: "work" }).map(parsed).filter((w) => w.body.thread === id && !w.space).sort((a, b) => (Number(a.body.turn) || 0) - (Number(b.body.turn) || 0)) : [];
  ok(res, { thing: parsed(r), comments, work, as_of: t.r.seen });
});

// ---------- theirs on your feed ----------
// Each contact's own threads and pages as feed cards (not what they pass on in a group or task), made again only once
// something came or went (stamp). Whose each is (`owner`) and its agent there (`agent_id`) stay here.
type Card = TheirCard & { owner: string; agent_id: string | null };
let cards: { stamp: string; list: Card[] } | null = null;
function theirCards(): Card[] {
  const stamp = people().stamp();
  if (cards?.stamp === stamp) return cards.list;
  const list: Card[] = [];
  for (const p of people().people()) {
    const u = accounts.byId(p.user_id);
    if (!u) continue;
    const recs = people().records({ owner: u.id }).filter((r) => !r.space && !r.item);
    const agents = new Map(recs.filter((r) => r.type === "agent").map((r) => [r.rid, JSON.parse(r.body)]));
    const card = recs.find((r) => r.type === "person");
    const name = p.name || (card ? JSON.parse(card.body).name : null) || null;
    for (const r of recs) {
      if (r.type !== "thread" && r.type !== "page") continue;
      const b = JSON.parse(r.body);
      const base = { id: `${u.id}:${r.rid}`, rid: r.rid, username: u.username, name, title: b.title ?? null, owner: u.id };
      if (r.type === "page") {
        list.push({ ...base, type: "page", agent_id: null, text: b.about ?? null, emoji: b.emoji ?? null, version: b.version ?? null, updated: b.updated || r.got });
        continue;
      }
      const a = b.agent ? agents.get(b.agent) : null;
      const last = (b.messages || []).at(-1);
      // Who said its last message, as their page names them: their agent, or a person by the handle they go by.
      const from = last ? (last.from === "human" ? last.user || name || u.username : a?.name || "Their agent") : null;
      list.push({ ...base, type: "thread", agent_id: b.agent || null, text: b.headline ?? null, state: b.state ?? null, busy: !!b.busy, agent: a ? { name: a.name ?? null, emoji: a.emoji ?? null } : null, last: last ? { from, text: String(last.text ?? "").slice(0, 280), at: last.at ?? null } : null, messages: (b.messages || []).length + (b.earlier || 0), started: b.started || r.got, updated: b.updated || r.got });
    }
  }
  cards = { stamp, list };
  return list;
}
// What reaches your feed: a contact's you follow, less what an agent of theirs you turned off made; an agent's of theirs
// you follow on its own. Yours alone, as agentOnFeed says it for agents on your page.
function theirFeed(req: Req): TheirCard[] {
  const m = me();
  if (!m || req.user?.id !== m.id) return [];
  return theirCards()
    .filter((c) => contactOf(m.id, c.owner) && (c.agent_id ? agentOnFeed(m.id, remoteAgentId(c.owner, c.agent_id), c.owner) : followsPerson(m.id, c.owner)))
    .map(({ owner, agent_id, ...c }) => c);
}

// ---------- @handles that name you ----------
bellSources.push((u, since) => {
  const mine = ACCOUNT?.account;
  if (!mine || u.id !== me()?.id) return [];
  const out = [];
  for (const r of people().records({ type: "thread" })) {
    if (!(Date.parse(r.got) > since)) continue;
    if (!(JSON.parse(r.mentions || "[]") as string[]).includes(mine)) continue;
    const owner = accounts.byId(r.owner);
    const by = personOfAcct(r.author)?.username || owner?.username || null;
    const b = JSON.parse(r.body);
    out.push({ kind: "mention", id: `${owner?.username}/${r.rid}`, title: b.title || "A thread", emoji: null, by, at: r.got, text: `@${by} named you in "${b.title || "a thread"}"`, link: `#/people/${encodeURIComponent(owner?.username || "")}/things/${encodeURIComponent(r.rid)}` });
  }
  return out;
});

// ---------- wiring ----------
// Called once every module is loaded (server/main.ts): door.on, store.onChange and the rest need api/door.ts's door.
export function wirePeopleThings() {
  theirFeeds.push(theirFeed);
  // Someone who just let you see more asks for everything again; someone who sees your things, for one thread's
  // earlier messages (not kept apart yet: the latest go with the thread).
  door.on("want", (row: InboxRow, who) => {
    const b = row.body as { id: string };
    if (b.id !== "*" || !fedTo(who.user_id)) return;
    holds.delete(who.user_id);
    feedOne(who.user_id, true);
  });
  // Theirs, as their contact or in something of theirs; what's in one of those, only from its home.
  door.on("records", async (row, who) => {
    const items = (row.body as { items: Item[] }).items || [];
    let n = 0;
    for (const it of items) {
      if (it.space ? !homeOf(who.user_id, it.space) : !(isContact(who.user_id) || homeOfAny(who.user_id))) continue;
      if (await keepRecord(who, it)) n++;
    }
    if (n) people().dropStale(new Date(Date.now() - LEASE_MS).toISOString());
    // Your feed may show it.
    if (n) pushLive();
  });
  door.on("withdraw", (row, who) => {
    for (const id of (row.body as { ids: string[] }).ids || []) people().dropRecord(who.user_id, id);
    pushLive();
  });
  // What you may see of theirs now: the rest goes, and what's on it is yours to keep 14 days more.
  door.on("all", (row, who) => {
    const ids = new Map((row.body as { ids: [string, string][] }).ids || []);
    for (const r of people().records({ owner: who.user_id })) if (!ids.has(r.rid)) people().dropRecord(who.user_id, r.rid);
    people().stillSeen(who.user_id, [...ids.keys()], now());
    pushLive();
  });
  // Anything you change may change what someone sees; so may an agent's work (server/main.ts's whenRelay). And someone
  // elsewhere who's not your contact any more (either of you removed the other): theirs goes from your page, as their
  // door's withdraw doesn't reach someone who isn't their contact.
  store.onChange((op: Op) => {
    // Someone who's your contact again may see more than their door refused when they weren't (a remove, then a
    // yes): nothing's held back from them any more.
    if (op.t === "contact" && (op.act === "yes" || op.act === "connect")) for (const uid of [op.user, op.person]) holds.delete(uid);
    feedSoon();
    if (op.t === "contact" && op.act === "remove") for (const uid of [op.user, op.person]) if (door.isRemote(uid)) dropGone(uid);
  });
  door.onUp(() => feedSoon());
}
