// Contacts and following. Two people become contacts when one asks and the other says yes
// (someone elsewhere, through an invite link and their doors: ./door.ts); each then sees what the other made public,
// and either may remove the other, which takes them off everything of theirs. Following is your feed alone: a contact
// (all of their public things), or one agent of theirs on or off. Nobody asks for it, and nobody's told.

import type { User } from "../accounts.ts";
import { accounts, commit, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Viewer } from "../core/http.ts";
import { agentRef, isOwner, ownerOf, viewerName } from "../core/refs.ts";
import { agentFollowRecord, agentOnFeed, contactOf, contactRecord, contactsOf, followsPerson, liveAccount, notContact, threadPeopleRows } from "../core/follows.ts";
import { contributes } from "../../plugin/shared/pages.ts";
import type { ContactAct } from "../../plugin/shared/ops.ts";
import { groupOwner, groupPeople, personLeaves } from "./groups.ts";
import { onNote } from "./notes.ts";
import { pageOwner } from "./pages.ts";
import { threadOwnerId } from "./tasks.ts";
import { onRemoved, remoteInfo } from "./door.ts";
import { ACCOUNT } from "../config.ts";

// How a request's person and someone else stand: contacts (`since`), or asking (`asked`: they asked them;
// `asks_you`, with what they said), and whether their things are in their feed (`following`).
export function contactFor(req: Viewer, u: User) {
  if (!req?.user || !u || u.id === req.user.id) return null;
  const c = contactRecord(req.user.id, u.id);
  const live = liveAccount(u.id);
  const theirAsk = !c?.at && c?.ask === u.id && live;
  return {
    contact: !!c?.at && live,
    since: c?.at || null,
    asked: !c?.at && c?.ask === req.user.id ? c.ask_at || null : null,
    asks_you: theirAsk ? c.ask_at || null : null,
    note: theirAsk ? c.note || null : null,
    following: followsPerson(req.user.id, u.id),
  };
}
// Whether an agent's threads are in a request's person's feed (`on`), and whether that's its own setting (`set`: on
// or off) or their follow of its owner's.
export function agentFollowFor(req: Viewer, agentId: string, ownerId: string | null) {
  if (!req?.user || !ownerId || ownerId === req.user.id) return null;
  const f = agentFollowRecord(req.user.id, agentId);
  return { on: agentOnFeed(req.user.id, agentId, ownerId), set: f ? (f.off ? "off" : "on") : null, contact: contactOf(req.user.id, ownerId) };
}

// Removing a contact takes each off everything of the other's here: their tasks, groups, pages, notes and threads.
// Someone elsewhere's things are on their own page, which hears it from their door.
export async function offEverything(ownerId: string, uid: string, by: string | null) {
  const u = accounts.byId(uid);
  if (!u) return;
  for (const t of Object.values(state.tasks)) if (t.owner === ownerId && (t.people || []).some((p) => p.user === uid)) commit({ t: "task.person", tid: t.id, user: uid, remove: true, by });
  for (const g of Object.values(state.groups)) if (groupOwner(g) === ownerId && groupPeople(g).includes(u.username)) await personLeaves(g, u, by);
  for (const p of Object.values(state.pages)) if (pageOwner(p) === ownerId && contributes(p, { user: u.username })) commit({ t: "page.contributor", pid: p.id, who: { user: u.username }, remove: true, by });
  for (const n of Object.values(state.notes)) if (n.owner === ownerId && (n.people || []).some((p) => p.user === uid) && onNote(n, uid)) commit({ t: "note.person", nid: n.id, user: uid, remove: true, by });
  for (const [id, x] of Object.entries(state.thread_people || {})) if (x.people.some((p) => p.user === uid) && threadOwnerId(id) === ownerId) commit({ t: "thread.people", post: id, user: uid, remove: true, by });
}

// Someone elsewhere removed you: they're off everything of yours here. Their own page takes you off theirs.
onRemoved((who) => (ACCOUNT?.person ? offEverything(ACCOUNT.person, who.user_id, who.user.username) : undefined));

const ACTS: ContactAct[] = ["ask", "take_back", "yes", "no", "remove"];
// Ask someone to be your contact (with a `note`), take your ask back, say yes or no to theirs, or remove them.
route("POST", "/api/people/:username/contact", async (req, res, { params }) => {
  const b = await readBody<{ act?: string; note?: string }>(req);
  if (!req.user) return fail(res, 403, "A person has contacts, not a machine.");
  const u = accounts.byUsername(params.username);
  if (!u || u.deleted) return fail(res, 404, "No one by that name here.");
  if (u.id === req.user.id) return fail(res, 400, "That's you.");
  const act = String(b.act || "") as ContactAct;
  if (!ACTS.includes(act)) return fail(res, 400, "Ask, take back, yes, no or remove?");
  const c = contactRecord(req.user.id, u.id);
  if (act === "ask") {
    if (c?.at) return fail(res, 409, `@${u.username} is your contact already.`);
    if (u.disabled) return fail(res, 409, `@${u.username}'s account is off.`);
  } else if (act === "take_back" && (c?.at || c?.ask !== req.user.id)) return fail(res, 409, `You haven't asked @${u.username}.`);
  else if ((act === "yes" || act === "no") && (c?.at || c?.ask !== u.id)) return fail(res, 409, `@${u.username} hasn't asked you.`);
  else if (act === "remove" && !c?.at) return fail(res, 409, `@${u.username} isn't your contact.`);
  commit({ t: "contact", user: req.user.id, person: u.id, act, ...(act === "ask" ? { note: str(b.note, 500).trim() || null } : {}) });
  if (act === "remove") {
    await offEverything(req.user.id, u.id, viewerName(req));
    await offEverything(u.id, req.user.id, viewerName(req));
  }
  ok(res, { contact: contactFor(req, u) });
});

// A contact's public things in your feed, or not.
route("POST", "/api/people/:username/follow", async (req, res, { params }) => {
  const b = await readBody<{ follow?: boolean }>(req);
  if (!req.user) return fail(res, 403, "A person follows, not a machine.");
  const u = accounts.byUsername(params.username);
  if (!u || u.deleted) return fail(res, 404, "No one by that name here.");
  if (!contactOf(req.user.id, u.id)) return fail(res, 409, `@${u.username} isn't your contact: there's nothing of theirs to follow.`);
  commit({ t: "person.follow", person: u.id, user: req.user.id, ...(b.follow === false ? { remove: true } : {}) });
  ok(res, { contact: contactFor(req, u) });
});

// An agent of a contact's in your feed (`follow`: true), off it (false), or as your follow of its owner says (null).
// One of someone's elsewhere is r:<their user id>:<its id there> (./people-things.ts).
export function setAgentFollow(uid: string, agentId: string, ownerId: string, follow: boolean | null) {
  if (follow === null) commit({ t: "agent.follow", agent: agentId, user: uid, remove: true });
  else if (follow) commit({ t: "agent.follow", agent: agentId, user: uid });
  else if (followsPerson(uid, ownerId)) commit({ t: "agent.follow", agent: agentId, user: uid, off: true });
  else commit({ t: "agent.follow", agent: agentId, user: uid, remove: true });
}
route("POST", "/api/agents/:id/follow", async (req, res, { params }) => {
  const b = await readBody<{ follow?: boolean | null }>(req);
  if (!req.user) return fail(res, 403, "A person follows, not a machine.");
  const remote = /^r:([^:]+):(.+)$/.exec(params.id);
  const ref = remote ? null : agentRef(params.id);
  const ownerId = remote ? remote[1] : ownerOf(ref?.D)?.id || null;
  if (ref && isOwner(req, ref.D)) return fail(res, 400, "It's yours: it's in your feed already.");
  if (!ownerId || (!remote && !ref) || !contactOf(req.user.id, ownerId)) return fail(res, 404, "No such agent");
  if (!("follow" in b) || (b.follow !== null && typeof b.follow !== "boolean")) return fail(res, 400, "Follow it, or not?");
  setAgentFollow(req.user.id, params.id, ownerId, b.follow);
  ok(res, { follow: agentFollowFor(req, params.id, ownerId) });
});

// Someone put on a thread of yours (an agent's or your own), or taken off (`remove`). While it's private they see it,
// with its work, as your contacts see a public one, and it rings their bell; nothing of it runs for them. Only a contact
// can be put on one.
route("POST", "/api/threads/:id/people", async (req, res, { params }) => {
  const b = await readBody<{ user?: string; remove?: boolean }>(req);
  if (!req.user) return fail(res, 403, "A person puts people on a thread, not a machine.");
  const id = String(params.id);
  if (threadOwnerId(id) !== req.user.id) return fail(res, 404, "No such thread of yours");
  const u = accounts.byUsername(str(b.user, 80).trim().replace(/^@/, ""));
  if (!u || u.deleted) return fail(res, 404, "No one by that name here.");
  if (u.id === req.user.id) return fail(res, 400, "It's yours: you see it already.");
  const on = threadPeopleIds(id).includes(u.id);
  if (b.remove ? !on : on) return ok(res, { people: threadPeopleRows(id) });
  const why = b.remove ? null : notContact(req.user.id, u);
  if (why) return fail(res, 409, why);
  commit({ t: "thread.people", post: id, user: u.id, by: viewerName(req), ...(b.remove ? { remove: true } : {}) });
  ok(res, { people: threadPeopleRows(id) });
});
// Everyone on it, live or not, so taking off someone whose account is off still works.
const threadPeopleIds = (id: string) => (state.thread_people?.[id]?.people || []).map((p) => p.user);

// The Contacts box on your profile: your contacts, whether you follow each, and the asks waiting, theirs and yours.
function contactsFor(req: Viewer) {
  const me = req.user.id;
  const who = (u: User) => ({ user: u.username, display_name: u.display_name || u.username, disabled: !!u.disabled, remote: remoteInfo(u.id) });
  const contacts = contactsOf(me)
    .map((id) => accounts.byId(id))
    .filter(Boolean)
    .map((u) => ({ ...who(u), since: contactRecord(me, u.id)?.at || null, following: followsPerson(me, u.id) }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const asks = [];
  for (const c of Object.values(state.contacts || {})) {
    if (c.at || (c.a !== me && c.b !== me)) continue;
    const u = accounts.byId(c.a === me ? c.b : c.a);
    if (!u || u.deleted || !liveAccount(u.id)) continue;
    asks.push({ ...who(u), at: c.ask_at || null, yours: c.ask === me, note: c.ask === me ? null : c.note || null });
  }
  asks.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { contacts, asks };
}
route("GET", "/api/contacts", (req, res) => {
  if (!req.user) return fail(res, 403, "A person has contacts, not a machine.");
  ok(res, contactsFor(req));
});
