// What you publish to someone on another agentbook. Which things: what
// policy.ts lets them see, as viewForReq works it out for their row here at their level, as if they were signed in
// to your page. Which fields: the lists below, one per type of record, field by field. A field not on a list never
// leaves, so one added to a thread later stays yours until it's listed here.
//
// The same lists are how a page takes what someone else published (clean()): a record keeps only its type's fields,
// each of the right kind and size, whatever came.
//
// A thread's work goes too, as its page shows it: its plan, and each turn's steps
// and what it changed, diffs and all, as records of their own (workRecords). The machine's home folder reads as ~, and
// a path in the thread's folder reads from there.
//
// Never: anything of a machine but its name; a thread's folder, branch and terminal; files; questions and permission
// prompts; routines, settings, connectors; a dashboard (its panels run your connectors' queries); a page's html
// widgets.

import type { User } from "./accounts.ts";
import type { RECORD_TYPES } from "../plugin/shared/door/wire.ts";
import { versionOf } from "../plugin/shared/door/sign.ts";
import { relay, state, work } from "./core/state.ts";
import { postRef } from "./core/refs.ts";
import { contactOf } from "./core/follows.ts";
import { isTalkId } from "../plugin/shared/talks.ts";
import { seenAt } from "./policy.ts";
import { threadSeen, viewForReq } from "./api/views.ts";

export type RecordType = (typeof RECORD_TYPES)[number];
export interface Rec {
  type: RecordType;
  id: string;
  v: string;
  body: Record<string, unknown>;
  space?: string;
  // The people it names, by their accounts.
  mentions?: string[];
  // Someone else's, passed on as it came (a comment on your thread, a thread in your group): their door's signature.
  author?: { certificate: string; handle: string; sig: string };
}

// How much of a thread a record carries: its latest messages, each cut to so many characters, within a size.
export const THREAD_MESSAGES = 60;
const MESSAGE_CHARS = 4000;
const THREAD_BYTES = 150e3;
const PAGE_WIDGETS = 30;
// How much of a thread's work goes: its latest turns, each within a size (under what one message carries).
export const WORK_TURNS = 10;
const WORK_STEPS = 300;
const WORK_FILES = 60;
const WORK_BYTES = 120e3;

// ---------- each field's kind ----------
type Field = (v: unknown) => unknown;
const text =
  (max: number): Field =>
  (v) =>
    typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v).slice(0, max) : undefined;
const when: Field = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
const yes: Field = (v) => (typeof v === "boolean" ? v : undefined);
const count: Field = (v) => (Number.isSafeInteger(v) && (v as number) >= 0 ? v : undefined);
const oneOf =
  (...vals: string[]): Field =>
  (v) =>
    vals.includes(v as string) ? v : undefined;
const list =
  (f: Field, max: number): Field =>
  (v) =>
    Array.isArray(v) ? v.slice(0, max).map(f).filter((x) => x !== undefined) : undefined;
const shape =
  (fields: Record<string, Field>): Field =>
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(fields)) {
      const x = f((v as Record<string, unknown>)[k]);
      if (x !== undefined && x !== null) out[k] = x;
    }
    return out;
  };
// Any JSON, of at most `max` bytes: a widget's data, which the page shows as it shows its own (no html).
const json =
  (max: number): Field =>
  (v) => {
    if (v === undefined) return undefined;
    const s = JSON.stringify(v);
    return s && s.length <= max ? JSON.parse(s) : undefined;
  };

// ---------- the lists ----------
const MESSAGE = shape({ id: text(100), from: oneOf("human", "agent"), text: text(MESSAGE_CHARS), at: when, user: text(30) });
const PR = shape({ url: text(500), title: text(300), state: text(20), number: count, repo: text(200) });
const WIDGET = shape({ id: text(100), type: text(30), title: text(200), width: text(20), data: json(40e3) });
const PLAN_ITEM = shape({ text: text(500), status: oneOf("pending", "in_progress", "completed") });
// A thread's work, as its page shows it: a step (something its agent said, or a tool it used: what it ran, how it
// ended, the files it changed), and a file a turn changed with its diff.
const STEP = shape({ id: text(100), kind: oneOf("say", "tool"), tool: text(60), title: text(400), text: text(2000), at: when, done: when, error: text(500), files: list(shape({ path: text(400), kind: text(20), add: count, del: count }), 30) });
const HUNK = shape({ oldStart: count, oldLines: count, newStart: count, newLines: count, lines: list(text(400), 2000) });
const FILE = shape({ path: text(400), kind: text(20), add: count, del: count, by: oneOf("command", "both", "edit"), nodiff: yes, hunks: list(HUNK, 200), more: count });
const COMMIT = shape({ short: text(12), subject: text(300), at: when, add: count, del: count });
// Someone, as the people in a shared thing read it: their account (who they are: handles aren't unique) and the
// handle they go by (what to call them).
const WHO = shape({ acct: text(64), handle: text(30) });
export const FIELDS: Record<RecordType, Record<string, Field>> = {
  // You: your @handle, name and bio.
  person: { handle: text(30), name: text(80), bio: text(500) },
  // An agent: its name, its runtime, its glyph or emoji, a line about it, the name of the machine it's on, and
  // whether it's working now.
  agent: { name: text(80), kind: text(40), glyph: text(8), emoji: text(16), bio: text(500), machine: text(80), working: yes },
  // A thread: its title and headline, its agent (an agent record's id), how it stands, when, its pull requests, the
  // results it said (ab_update), and its latest messages (`earlier`: how many before them aren't in it). `talk`: a
  // thread of your own rather than an agent's.
  thread: { title: text(300), headline: text(500), agent: text(200), state: text(20), busy: yes, talk: yes, started: when, updated: when, prs: list(PR, 20), updates: list(shape({ text: text(500), at: when }), 50), messages: list(MESSAGE, THREAD_MESSAGES), earlier: count, plan: list(PLAN_ITEM, 50) },
  // A turn of a thread's (`thread`: its record's id): its steps, the files it changed with their diffs, their totals
  // and its commits. `cut`: what was left out to fit (steps, files, diff lines).
  work: { thread: text(200), turn: count, steps: list(STEP, WORK_STEPS), files: list(FILE, WORK_FILES), totals: shape({ files: count, add: count, del: count }), commits: list(COMMIT, 20), cut: shape({ steps: count, files: count, lines: count }), updated: when },
  // A page: its current version, without html widgets.
  page: { title: text(200), emoji: text(16), about: text(2000), version: count, updated: when, widgets: list(WIDGET, PAGE_WIDGETS) },
  // A task: its title, whether it's done, and the threads on it (their records' ids); for the people on it (`people`)
  // its note and pull requests too.
  task: { title: text(500), done: yes, done_at: when, updated: when, threads: list(text(200), 50), note: text(4000), people: list(WHO, 50), prs: list(PR, 20) },
  // Taking part (./api/people-spaces.ts): a group as the people in it see it (its threads by id, each with whose it
  // is: `acct`, and the handle they go by, `by`), a note with its comments, and a comment on a thread (signed by
  // whoever wrote it; `to`: the one it answers). A note's or comment's `by` is a line to show ("@bob's Claude").
  group: { name: text(120), emoji: text(16), brief: text(20000), members: list(WHO, 100), threads: list(shape({ id: text(200), acct: text(64), by: text(30), title: text(200) }), 200), notes: list(shape({ id: text(100), by: text(80), text: text(4000), at: when }), 200), updated: when },
  note: { title: text(200), text: text(100e3), by: text(80), updated: when, people: list(WHO, 50), comments: list(shape({ id: text(100), by: text(80), text: text(4000), at: when }), 200) },
  comment: { thread: text(200), text: text(4000), at: when, to: text(100) },
};
// A record's body as its type has it: only its fields, each of its kind; null for a type there's no list for.
export function clean(type: string, body: unknown): Record<string, unknown> | null {
  const fields = FIELDS[type as RecordType];
  if (!fields || !body || typeof body !== "object") return null;
  return shape(fields)(body) as Record<string, unknown>;
}

// ---------- @handles in what you publish ----------
const HANDLE_IN = /(^|[^\w@/.-])@([a-z0-9][a-z0-9_-]{1,29})\b(?![./@-]\w)/gi;
// The @handles a text names, lowercase, as written: whom each names, if anyone, is the caller's to say (`Named`).
// A name on your page: the account of whoever has it there, or null.
export type Named = (h: string) => string | null;
const mentioned = (named: Named, ...texts: unknown[]) => handlesIn(...texts).flatMap((h) => named(h) ?? []);
export function handlesIn(...texts: unknown[]): string[] {
  const out = new Set<string>();
  for (const t of texts) if (typeof t === "string") for (const m of t.matchAll(HANDLE_IN)) out.add(m[2].toLowerCase());
  return [...out];
}

// A record, its body cleaned by its own list, its version the hash of what it says.
export function rec(type: RecordType, id: string, body: Record<string, unknown>, mentions: string[] = []): Rec {
  const b = clean(type, body)!;
  const m = [...new Set(mentions)].sort().slice(0, 50);
  return { type, id, v: versionOf({ body: b, mentions: m }), body: b, ...(m.length ? { mentions: m } : {}) };
}

// ---------- what each type of record says ----------
export function personRecord(u: User, handle: string): Rec {
  return rec("person", "me", { handle, name: u.display_name || u.username, bio: u.bio || "" });
}
type Row = Record<string, any>;
export function agentRecord(a: Row): Rec {
  const avatar = a.avatar || a.avatar_default;
  return rec("agent", a.id, { name: a.name, kind: a.runtime || a.kind, glyph: a.glyph, emoji: avatar?.emoji, bio: a.bio, machine: a.machine, working: (a.working || 0) > 0 });
}
// ---------- paths as they go out ----------
// What a thread says, with the machine's home folder as ~ and the thread's own folder left out, so a path in it reads
// from there: `deep` goes through a record's body, strings and all.
type Tidy = <T>(v: T) => T;
const asIs: Tidy = (v) => v;
const reOf = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function tidier(home: string | null | undefined, folder: string | null | undefined): Tidy {
  const swaps: [RegExp, string | ((m: string, t: string) => string)][] = [];
  // Only where a path starts: not inside a word or a web address (https://example.com/home/…).
  const at = "(?<![\\w.-])";
  if (folder && folder.length > 1) swaps.push([new RegExp(`${at}${reOf(folder)}/`, "g"), ""], [new RegExp(`${at}${reOf(folder)}(?![\\w.-])`, "g"), "."]);
  if (home && home.length > 1) swaps.push([new RegExp(`${at}${reOf(home)}(?![\\w.-])`, "g"), "~"]);
  // A path cut short (a step's title is cut at 70 characters) partway through the home folder's: what's left of it
  // is the home folder all the same, once it's long enough to say more than /Users/.
  if (home && home.length > 1) swaps.push([/(?<![\w.:/-])(\/[^\s"'`)\]…]{7,})…/g, (m, t) => (home.startsWith(t) ? "~…" : m)]);
  // Anyone's home folder, whatever the machine says its own is.
  swaps.push([/(?<![\w.:/-])\/(?:Users|home)\/[^/\s"'`)\]]+/g, "~"]);
  const swap = (t: string, [re, to]: (typeof swaps)[number]) => (typeof to === "string" ? t.replace(re, to) : t.replace(re, to));
  const deep = (v: unknown): unknown => (typeof v === "string" ? swaps.reduce(swap, v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return deep as Tidy;
}
// A thread's, by its machine's home and its folder; a thread of your own (a talk) has neither.
function tidyFor(id: string): Tidy {
  const p = isTalkId(id) ? null : postRef(id);
  return p ? tidier(relay.infoOf(p.D)?.machine?.home, p.s.cwd) : asIs;
}

// A thread's record, with its latest messages within THREAD_BYTES; `named`: whom each @handle names.
export function threadRecord(row: Row, messages: Row[], named: Named, tidy: Tidy = tidyFor(String(row.id))): Rec {
  const shown: Row[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && shown.length < THREAD_MESSAGES; i--) {
    const m = messages[i];
    if (m.draft || m.pending || typeof m.text !== "string" || !m.text.trim()) continue;
    const t = m.text.slice(0, MESSAGE_CHARS);
    bytes += t.length + 120;
    if (bytes > THREAD_BYTES) break;
    shown.unshift({ id: m.id, from: m.from === "human" ? "human" : "agent", text: t, at: m.at, user: m.user });
  }
  const earlier = Math.max(0, messages.filter((m) => !m.draft && !m.pending && typeof m.text === "string" && m.text.trim()).length - shown.length);
  const prs = Object.values((row.prs || {}) as Record<string, Row>).map((p) => ({ url: p.url, title: p.title, state: p.state, number: p.number, repo: p.repo }));
  const updates = (row.updates || []).map((u: Row) => ({ text: u.text, at: u.at }));
  const title = row.title || row.ai_title || row.label || "A thread";
  const plan = Array.isArray(row.plan) ? row.plan.map((x: Row) => ({ text: x.text, status: x.status })) : undefined;
  const body = tidy({ title, headline: row.text, agent: row.agent, state: row.state || row.effective, busy: !!row.busy, talk: !!row.talk, started: row.started, updated: row.updated || row.last_at, prs, updates, messages: shown, earlier, plan });
  return rec("thread", row.id, body, mentioned(named, title, row.text, ...shown.map((m) => m.text)));
}

// ---------- a thread's work ----------
// One record a turn (`<thread>/w<turn>`), its latest WORK_TURNS turns, from what its machine sent the page
// (./work.ts): the steps it took, and the files it changed with their diffs, cut to fit WORK_BYTES, saying what was
// cut. A finished turn's record stays the same, so it goes once. Made again only once its work changed.
const workMade = new Map<string, { v: number; recs: Rec[] }>();
const WORK_KEPT = 200;
export function workRecords(id: string): Rec[] {
  const p = isTalkId(id) ? null : postRef(id);
  if (!p) return [];
  const v = work.version(p.D, p.local);
  const was = workMade.get(id);
  if (was && was.v === v) return was.recs;
  const tidy = tidier(relay.infoOf(p.D)?.machine?.home, p.s.cwd);
  const byTurn = new Map<number, Row[]>();
  for (const st of (work.steps(p.D, p.local)?.steps || []) as Row[]) {
    const t = Number(st.turn) || 0;
    byTurn.set(t, [...(byTurn.get(t) || []), st]);
  }
  const turns = [...byTurn.keys()].sort((a, b) => a - b).slice(-WORK_TURNS);
  const recs = turns.map((t) => workRecord(id, t, byTurn.get(t)!, work.changes(p.D, p.local, String(t)) as Row | null, tidy));
  workMade.delete(id);
  workMade.set(id, { v, recs });
  if (workMade.size > WORK_KEPT) workMade.delete(workMade.keys().next().value!);
  return recs;
}
function workRecord(thread: string, turn: number, steps: Row[], changes: Row | null, tidy: Tidy): Rec {
  const cut = { steps: Math.max(0, steps.length - WORK_STEPS), files: 0, lines: 0 };
  const shownSteps = steps.slice(-WORK_STEPS).map((s) => ({ id: s.id, kind: s.kind, tool: s.tool, title: s.title, text: s.text, at: s.at, done: s.done, error: s.error, files: s.files }));
  const files = ((changes?.files || []) as Row[]).slice(0, WORK_FILES);
  cut.files = Math.max(0, (changes?.files || []).length - WORK_FILES);
  const commits = ((changes?.commits || []) as Row[]).map((c) => ({ short: c.short, subject: c.subject, at: c.at, add: c.add, del: c.del }));
  const last = steps.at(-1);
  // Its diffs' lines within a budget, halved until the record fits; then its earliest steps go.
  let body: Row = {};
  for (let budget = 4000; ; budget = Math.floor(budget / 2)) {
    let left = budget;
    let lines = 0;
    const shown = files.map((f) => {
      let more = Number(f.more) || 0;
      const hunks = ((f.hunks || []) as Row[]).flatMap((h) => {
        const all = (h.lines || []) as string[];
        const take = all.slice(0, Math.max(0, left));
        left -= take.length;
        more += all.length - take.length;
        lines += all.length - take.length;
        return take.length ? [{ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: take }] : [];
      });
      return { path: f.path, kind: f.kind, add: f.add, del: f.del, by: f.by, nodiff: f.nodiff, hunks, more };
    });
    body = clean("work", tidy({ thread, turn, steps: shownSteps, files: shown, totals: changes?.totals, commits, cut: { ...cut, lines }, updated: last?.done || last?.at }))!;
    if (JSON.stringify(body).length <= WORK_BYTES || budget < 20) break;
  }
  while (JSON.stringify(body).length > WORK_BYTES && body.steps?.length) {
    body.steps.shift();
    body.cut.steps++;
  }
  return rec("work", `${thread}/w${turn}`, body);
}
export function pageRecord(p: Row, named: Named): Rec {
  const widgets = (p.widgets || []).filter((w: Row) => w.type !== "html" && !w.query).slice(0, PAGE_WIDGETS);
  const body = { title: p.title, emoji: p.emoji, about: p.about, version: p.version, updated: p.updated, widgets: widgets.map((w: Row) => ({ id: w.id, type: w.type, title: w.title, width: w.width, data: w.data })) };
  return rec("page", p.id, body, mentioned(named, p.title, p.about, ...widgets.map((w: Row) => w.title)));
}
// `on`: for someone on it, its note, who's on it and its pull requests.
export function taskRecord(t: Row, threads: string[], on: { people: Someone[]; prs: Row[] } | null = null): Rec {
  return rec("task", t.id, { title: t.text, done: !!t.done, done_at: t.done_at, updated: t.updated || t.done_at || t.created, threads, ...(on ? { note: t.note, people: on.people, prs: on.prs } : {}) });
}
// A record's key for someone it goes to: its id, or for one in something of yours with people elsewhere in it (a
// thread of someone else's in a group of yours), that and the space, as the same thread may be in two.
export const keyOf = (r: Pick<Rec, "id" | "space">) => (r.space ? `${r.space}/${r.id}` : r.id);

// More of what someone may see, from the parts that keep their own (./api/people-comments.ts, ./api/people-spaces.ts):
// comments on the threads they get, groups and tasks they're in with what's in them.
type Source = (viewer: User, me: User, threads: Set<string>, named: Named) => Rec[];
export const recordSources: Source[] = [];

// Everything `viewer` (someone elsewhere, their row here) may see of `me`'s, as records: your card; your agents and
// threads they may see (an agent they follow, a public one); your own threads (talks), pages and tasks by their
// visibility and their level. `named`: whom each @handle names (people your page knows: nobody else can be named).
export function recordsFor(viewer: User, me: User, handle: string, named: Named): Rec[] {
  const req = { user: viewer };
  const v = viewForReq(req);
  const out: Rec[] = [personRecord(me, handle)];
  const agents = new Set<string>();
  for (const a of v.agents) {
    if (a.owner !== me.username) continue;
    agents.add(a.id);
    out.push(agentRecord(a));
  }
  const threads = new Set<string>();
  for (const s of [...v.sessions, ...(v.talks || [])] as Row[]) {
    if (s.owner && s.owner !== me.username) continue;
    const t = threadSeen(req, s.id);
    if (!t) continue;
    threads.add(s.id);
    out.push(threadRecord({ ...s, ...t.record, id: s.id, agent: s.agent ?? null }, t.messages as Row[], named));
    out.push(...workRecords(s.id));
  }
  for (const p of v.pages as Row[]) if (!p.archived && p.kind !== "dashboard" && (p.owner == null || p.owner === me.username)) out.push(pageRecord(p, named));
  // Your tasks: a public one to a contact, as your threads go; one they're on (people-spaces.ts put them on it) whatever
  // its level, with every thread on it.
  const contact = contactOf(viewer.id, me.id);
  for (const t of Object.values(state.tasks || {}) as Row[]) {
    if (t.owner !== me.id || t.removed || t.scope) continue;
    const on = (t.people || []).some((x: Row) => x.user === viewer.id);
    if (!on && !seenAt(t.visibility, contact)) continue;
    const ids = (t.posts || []).map((e: Row) => e.post);
    out.push(on ? taskRecord(t, ids, taskOn(t, whoOf)) : taskRecord(t, ids.filter((id: string) => threads.has(id))));
  }
  for (const fn of recordSources) out.push(...fn(viewer, me, threads, named));
  // One record a key: yours first, then what others' parts pass on (whose ids they picked).
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(keyOf(r)) && !!seen.add(keyOf(r)));
}
// Who's on a task (you, people elsewhere), and its pull requests, for the people on it.
export type Someone = { acct: string; handle: string };
let whoOf: (uid: string) => Someone | null = () => null;
export const setWhoOf = (fn: typeof whoOf) => (whoOf = fn);
function taskOn(t: Row, who: (uid: string) => Someone | null) {
  const people = [t.owner, ...(t.people || []).map((x: Row) => x.user)].flatMap((uid) => who(uid) ?? []);
  const prs = ((t.ship?.items || []) as Row[]).filter((x) => x.kind === "pr").map((x) => ({ url: x.url, title: x.title, state: x.gh?.state || (x.landed ? "merged" : null), number: x.number, repo: x.repo }));
  return { people, prs };
}
