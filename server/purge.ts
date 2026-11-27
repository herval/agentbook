// Deleting an account deletes its data (the privacy note says so).
// accounts.remove() ends the account itself: here goes everything the person had on this server.
//
// - Their machines: each one's database (its agents, threads, messages, files, steps, changes, pictures), its files
//   folder, and the relay's rows for it (ids, twins, cursor, info, commands, cache, audit), with its terminals;
//   then the devices themselves, so they're not listed anywhere.
// - What they made on the server: their pages (with their versions, and the threads that were on them lose the
//   link), routines (with their code and runs), groups (with their notes, files, events and threads), notes (with
//   their versions), threads they started themselves (with their guests), WIPs, tasks and workspaces; and their
//   name comes off the contributors of other people's pages and out of other people's groups. The log of the ops
//   that made them is cut back to the checkpoint, so none of it stays in the database.
// - The bytes they sent (blobs): the uploads they made from the page, and every blob that only they sent. One
//   someone else sent too stays, theirs.
// - Their machines' threads that were in other people's groups, pages, tasks or WIPs: the links to them go.
//
// What stays: what they wrote in other people's threads (a comment on someone's thread is part of that thread, as
// an email you sent is in the other person's mailbox), and their username, so nobody new takes it. Their
// connectors are removed by the route (connectors.remove), and their picture and passkeys by accounts.remove.

import type { Store } from "../plugin/shared/store.ts";
import type { State } from "../plugin/shared/types.ts";
import type { Accounts } from "./accounts.ts";
import type { Blobs } from "./blobs.ts";
import type { Relay } from "./relay.ts";

// The parts of a store's state that are lists.
type Lists = { [K in keyof State]-?: NonNullable<State[K]> extends unknown[] ? K : never }[keyof State];

const pick = <T>(obj: Record<string, T> | undefined, fn: (v: T) => boolean): string[] => Object.keys(obj || {}).filter((k) => fn(obj[k]));
const drop = (obj: Record<string, unknown> | undefined, keys: string[]) => keys.forEach((k) => delete obj[k]);
const keepUnless = <K extends Lists>(state: State, part: K, fn: (x: State[K][number]) => boolean): number => {
  if (!Array.isArray(state[part])) return 0;
  const list: State[K][number][] = state[part];
  const n = list.length;
  state[part] = list.filter((x) => !fn(x)) as State[K];
  return n - state[part].length;
};

// What went, by kind.
export interface Purged {
  machines: number;
  threads: number;
  pages: number;
  routines: number;
  groups: number;
  notes: number;
  talks: number;
  wips: number;
  tasks: number;
  workspaces: number;
  blobs: number;
}
export interface PurgeArgs {
  uid: string;
  accounts: Pick<Accounts, "deviceIdsOf" | "forgetDevices" | "byId">;
  relay: Pick<Relay, "destroy" | "forgetHomes">;
  store: Store;
  blobs: Pick<Blobs, "forget">;
  terminals?: { forget(device: string): void } | null;
  log?: (line: string) => void;
}

// -> what went: { machines, threads, pages, routines, groups, notes, talks, wips, tasks, workspaces, blobs }.
export function purgeUser({ uid, accounts, relay, store, blobs, terminals = null, log = () => {} }: PurgeArgs): Purged {
  const gone: Purged = { machines: 0, threads: 0, pages: 0, routines: 0, groups: 0, notes: 0, talks: 0, wips: 0, tasks: 0, workspaces: 0, blobs: 0 };

  /* ---------- their machines ---------- */
  const posts = new Set<string>(); // the page's ids of their machines' threads
  const agents = new Set<string>(); // and of their agents
  for (const id of accounts.deviceIdsOf(uid)) {
    const r = relay.destroy(id);
    for (const p of r.posts) posts.add(p);
    for (const a of r.agents || []) agents.add(a);
    terminals?.forget(id);
    gone.machines++;
  }
  gone.threads = posts.size;
  accounts.forgetDevices(uid);
  relay.forgetHomes(uid);

  /* ---------- what they made on the server ---------- */
  const s = store.state;
  // Pages' contributors and groups' people are named by username.
  const username = accounts.byId?.(uid)?.username || null;
  const pages = new Set(pick(s.pages, (p) => p.owner === uid));
  drop(s.pages, [...pages]);
  gone.pages = pages.size;
  keepUnless(s, "page_versions", (v) => pages.has(v.page));
  for (const p of Object.values(s.pages || {})) if (Array.isArray(p.contributors)) p.contributors = p.contributors.filter((c) => c.user !== uid && c.user !== username);
  drop(s.page_posts, Object.keys(s.page_posts || {}).filter((k) => pages.has(s.page_posts[k]?.page) || posts.has(k)));

  const routines = new Set(pick(s.routines, (r) => r.owner === uid || pages.has(r.page) || posts.has(r.thread)));
  drop(s.routines, [...routines]);
  gone.routines = routines.size;
  keepUnless(s, "routine_code", (c) => routines.has(c.routine));
  keepUnless(s, "routine_runs", (x) => routines.has(x.routine));

  const groups = new Set(pick(s.groups, (g) => g.owner === uid));
  drop(s.groups, [...groups]);
  gone.groups = groups.size;
  for (const g of Object.values(s.groups || {})) if (Array.isArray(g.members)) g.members = g.members.filter((m) => !m.user || (m.user !== uid && m.user !== username));
  for (const part of ["group_notes", "group_files", "group_events"] as const) keepUnless(s, part, (x) => groups.has(x.group));
  drop(s.group_posts, Object.keys(s.group_posts || {}).filter((k) => groups.has(s.group_posts[k]?.group) || posts.has(k)));

  // When they last opened the bell, and what they dismissed from it.
  if (s.bell_seen) delete s.bell_seen[uid];
  if (s.bell_cleared) delete s.bell_cleared[uid];
  if (s.bell_dismissed) delete s.bell_dismissed[uid];
  // Their threads' news for it.
  if (s.news) delete s.news[uid];
  // The page updates they archived off their feed.
  if (s.feed_archived) delete s.feed_archived[uid];
  // Their settings, and the threads Auto-archive archived for them.
  if (s.prefs) delete s.prefs[uid];
  drop(s.auto_archived, Object.keys(s.auto_archived || {}).filter((k) => s.auto_archived[k]?.user === uid || posts.has(k)));
  drop(s.private_off, Object.keys(s.private_off || {}).filter((k) => s.private_off[k] === uid || posts.has(k)));
  // Who they followed, and who followed their agents.
  drop(s.agent_follows, Object.keys(s.agent_follows || {}).filter((k) => s.agent_follows[k]?.user === uid || agents.has(s.agent_follows[k]?.agent)));
  // Who they followed and who followed them, people both.
  drop(s.person_follows, Object.keys(s.person_follows || {}).filter((k) => s.person_follows[k]?.user === uid || s.person_follows[k]?.person === uid));
  // Their contacts and asks, either way.
  drop(s.contacts, pick(s.contacts, (c) => c.a === uid || c.b === uid));

  const notes = new Set(pick(s.notes, (n) => n.owner === uid));
  drop(s.notes, [...notes]);
  gone.notes = notes.size;
  keepUnless(s, "note_versions", (v) => notes.has(v.note));

  const talks = new Set(pick(s.talks, (t) => t.owner === uid));
  drop(s.talks, [...talks]);
  gone.talks = talks.size;
  drop(s.thread_guests, pick(s.thread_guests, (g) => talks.has(g.host) || posts.has(g.post)));
  drop(s.thread_seen, Object.keys(s.thread_seen || {}).filter((k) => talks.has(k) || posts.has(k)));
  // Who was on their threads, and them on anyone's.
  for (const x of Object.values(s.thread_people || {})) x.people = x.people.filter((p) => p.user !== uid);
  drop(s.thread_people, pick(s.thread_people, (x) => talks.has(x.post) || posts.has(x.post) || !x.people.length));

  const wips = pick(s.wip_sets, (w) => w.owner === uid);
  drop(s.wip_sets, wips);
  gone.wips = wips.length;
  for (const w of Object.values(s.wip_sets || {})) {
    for (const k of Object.keys(w.posts || {})) if (posts.has(k)) delete w.posts[k];
    if (Array.isArray(w.items)) w.items = w.items.filter((x) => !(x?.kind === "thread" && posts.has(x.id)));
  }
  const tasks = pick(s.tasks, (t) => t.owner === uid);
  drop(s.tasks, tasks);
  gone.tasks = tasks.length;
  for (const t of Object.values(s.tasks || {})) if (Array.isArray(t.posts)) t.posts = t.posts.filter((p) => !posts.has(p.post));
  const workspaces = pick(s.workspaces, (w) => w.owner === uid);
  drop(s.workspaces, workspaces);
  gone.workspaces = workspaces.length;
  // Files kept with the store (not blobs), theirs: their bytes go with their records.
  // (A file record has no owner of its own: only one that carries one is theirs.)
  const theirs = (f: State["files"][number]) => "owner" in f && f.owner === uid;
  for (const f of (s.files || []).filter(theirs)) if (f.stored) store.files.remove(f.stored);
  keepUnless(s, "files", theirs);
  // Written now, and the ops that made any of it go with it.
  store.checkpoint(true);
  store.pruneLog(0);

  /* ---------- the bytes they sent ---------- */
  gone.blobs = blobs.forget(uid);

  log(`deleted @${accounts.byId(uid)?.username || uid}'s data: ${Object.entries(gone).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing kept here"}`);
  return gone;
}
