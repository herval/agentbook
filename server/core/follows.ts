// Who sees what of whose: contacts, who see each other's public things; the people someone
// put on a thing of theirs, who see it while it's private too; and following, which is only what's in your feed.

import { postPublic, workShown } from "../policy.ts";
import { contactKey } from "../../plugin/shared/reducers/follows.ts";
import type { AgentFollow, Contact, FollowsSeeded, PersonFollow } from "../../plugin/shared/types.ts";
import { accounts, commit, log, state, store } from "./state.ts";
import { fail } from "./http.ts";
import type { Res, Viewer } from "./http.ts";
import type { PostRef } from "./types.ts";
import { agentRef, isOwner, ownerOf, postRef } from "./refs.ts";
import { boxShare } from "../api/machines.ts";
import { groupShares, noteShares, pageShares, taskShares } from "../api/tasks.ts";

/* ---------- contacts ---------- */

// An account that's here: not deleted, not disabled. Nothing of one that isn't counts.
export const liveAccount = (uid: string) => {
  const u = uid && accounts.byId(uid);
  return !!u && !u.deleted && !u.disabled;
};
// What two people (account ids) are to each other: contacts (`at`), one asking the other (`ask`), or null.
export const contactRecord = (x: string, y: string): Contact | null => (x && y && x !== y ? state.contacts?.[contactKey(x, y)] || null : null);
// Whether two people are each other's contact, so each sees what the other made public.
export const contactOf = (x: string, y: string): boolean => !!contactRecord(x, y)?.at && liveAccount(x) && liveAccount(y);
// The same for a request's person and a thing's owner (an account id).
export const isContact = (req: Viewer, ownerId: string | null | undefined): boolean => !!req?.user && !!ownerId && contactOf(req.user.id, ownerId);
// Why someone can't be put on a thing of `ownerId`'s (a task, a group, a page, a note, a thread): only their contacts
// can. Null when they can.
export const notContact = (ownerId: string, u: { id: string; username: string }) => (contactOf(ownerId, u.id) ? null : `@${u.username} isn't your contact: ask them to be one first.`);
// A person's contacts, by account id.
export function contactsOf(uid: string): string[] {
  const out: string[] = [];
  for (const c of Object.values(state.contacts || {})) {
    if (!c.at || (c.a !== uid && c.b !== uid)) continue;
    const other = c.a === uid ? c.b : c.a;
    if (liveAccount(other)) out.push(other);
  }
  return out;
}

/* ---------- people on a thread ---------- */

// The people a thread's owner put on it (the page's id), by account id.
export const threadPeople = (id: string): string[] => (state.thread_people?.[id]?.people || []).map((p) => p.user).filter(liveAccount);
// The same for its owner's page: each by username, and when.
export const threadPeopleRows = (id: string) =>
  (state.thread_people?.[id]?.people || []).flatMap((p) => {
    const u = liveAccount(p.user) ? accounts.byId(p.user) : null;
    return u ? [{ user: u.username, display_name: u.display_name || u.username, at: p.at }] : [];
  });
// The threads each person is on, by the page's ids, each with its work (true). Made again once anything changes.
const threadSharesMemo = new Map<string, Map<string, true>>();
store.onChange(() => threadSharesMemo.clear());
function threadShares(uid: string) {
  let out = threadSharesMemo.get(uid);
  if (out) return out;
  out = new Map();
  for (const [id, x] of Object.entries(state.thread_people || {})) if (x.people.some((p) => p.user === uid)) out.set(id, true);
  threadSharesMemo.set(uid, out);
  return out;
}

// Whether a request's person sees a thread (the page's id) because they're on it, or on something it's in, and its
// work: undefined when nothing shares it with them, else true (its work shows) or false. On it (its people); on a task,
// in a group, keeping a page or on a note it's in with its owner ("adding someone to a task should always allow them to
// see the resources associated to it. Same for adding someone to a group", "all of this applies to Notes too"); or on a
// shared machine it's on, unless it was made private (boxShare).
export const sharedOf = (req: Viewer, id: string) => {
  if (!req?.user || !id) return undefined;
  const uid = req.user.id;
  if (threadShares(uid).has(id) || boxShare(uid, id)) return true;
  const ways = [taskShares, groupShares, pageShares, noteShares].map((f) => f(uid).get(id));
  return ways.includes(true) ? true : ways.find((x) => x !== undefined);
};
// Whether a request's person sees a thread (`p`, its ref), and its work, which whoever sees a thread sees too: theirs;
// public, to its owner's contacts; or shared with them.
export const seesPost = (req: Viewer, p: PostRef) => !!p && (isOwner(req, p.D) || (postPublic(p.s, p.agent) && isContact(req, ownerOf(p.D)?.id)) || sharedOf(req, p.id) !== undefined);
export const seesWork = (req: Viewer, p: PostRef) => !!p && (isOwner(req, p.D) || (workShown(p.s, p.agent) && isContact(req, ownerOf(p.D)?.id)) || sharedOf(req, p.id) === true);
// A post this request may see ("see"), see the work of ("work"), or act on as its owner ("own"; nobody else steers
// an agent, herval on Operate: "Drop it everywhere"): its ref, or a 404 (not visible) or 403 (visible, not theirs) sent.
export function postOr404(req: Viewer, res: Res, id: string, need: "see" | "work" | "own" = "see"): (PostRef & { mine: boolean }) | undefined {
  const p = postRef(id);
  const mine = !!p && isOwner(req, p.D);
  if (!p || !seesPost(req, p) || (need === "work" && !seesWork(req, p))) return void fail(res, 404, "No such thread");
  if (need === "own" && !mine) return void fail(res, 403, "Only its owner can do that.");
  return { ...p, mine };
}

/* ---------- following: your feed ---------- */

// Whether a person has a contact's things in their feed. Someone who isn't their contact has nothing there to follow.
export const followsPerson = (uid: string, personId: string) => !!state.person_follows?.[`${personId}|${uid}`] && contactOf(uid, personId);
export const agentFollowRecord = (uid: string, agentId: string): AgentFollow | null => {
  const f = state.agent_follows?.[`${agentId}|${uid}`];
  return f && "agent" in f ? f : null;
};
// Whether an agent's threads (its page id) are in a person's feed: its owner is their contact, and they follow it on its
// own, or follow its owner and didn't turn it off.
export function agentOnFeed(uid: string, agentId: string, ownerId: string | null = ownerOf(agentRef(agentId)?.D)?.id || null): boolean {
  if (!uid || !agentId || !ownerId || ownerId === uid || !contactOf(uid, ownerId)) return false;
  const f = agentFollowRecord(uid, agentId);
  return f ? !f.off : followsPerson(uid, ownerId);
}

// Contacts came after follows with levels and asks. Once, each follow someone gave becomes a contact (a person who let
// someone follow them, an agent's owner who let someone follow it), an ask to follow becomes an ask to be contacts, and
// every follow one for the feed alone. Nothing it leaves has a level or an ask, so it runs once.
const LEGACY = ["level", "granted", "ask", "by", "level_at", "ask_at", "seeded"];
const legacy = (f: object) => LEGACY.some((k) => k in f);
export function contactsFromFollows() {
  let n = 0;
  const ask = (user: string, person: string) => !contactRecord(user, person) && commit({ t: "contact", user, person, act: "ask" });
  for (const f of Object.values(state.person_follows || {}) as (PersonFollow & { level?: string; ask?: string })[]) {
    if (!legacy(f)) continue;
    if (f.level) commit({ t: "contact", user: f.person, person: f.user, act: "connect" });
    else if (f.ask) ask(f.user, f.person);
    commit({ t: "person.follow", person: f.person, user: f.user, ...(f.level ? {} : { remove: true }) });
    n++;
  }
  for (const f of Object.values(state.agent_follows || {}) as ((AgentFollow & { level?: string; granted?: boolean; ask?: string }) | FollowsSeeded)[]) {
    if (!("agent" in f) || !legacy(f)) continue;
    const owner = ownerOf(agentRef(f.agent)?.D)?.id;
    if (owner && f.level && f.granted) commit({ t: "contact", user: owner, person: f.user, act: "connect" });
    else if (owner && !f.level && f.ask) ask(f.user, owner);
    commit({ t: "agent.follow", agent: f.agent, user: f.user, ...(f.level ? {} : { remove: true }) });
    n++;
  }
  if (n) log(`contacts: ${n} follows from before contacts are contacts and feed follows now`);
}
