// Comments across people.
//
//   - On your threads: anyone elsewhere who sees one of your threads comments on it from their own page, through
//     their door. It shows on the thread in its People lane and on your bell, and never reaches its agent: Pass on
//     sends it as your next message, wrapped as theirs, so it's you who decided. Your answer goes in the same lane.
//     Everyone who gets the thread gets its comments too, each signed by whoever wrote it and passed on as it came, and
//     your answers, signed by your door.
//   - On theirs: yours goes to their door, signed by yours, and shows under their thread once their page sends it
//     back with the thread.

import crypto from "node:crypto";
import { ACCOUNT } from "../config.ts";
import { commentRecord, recordHolds, versionOf } from "../../plugin/shared/door/sign.ts";
import type { InboxRow } from "../../plugin/shared/door/db.ts";
import { isTalkId } from "../../plugin/shared/talks.ts";
import type { User } from "../accounts.ts";
import { accounts, log } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Viewer } from "../core/http.ts";
import { bellSources } from "../core/bell.ts";
import { postOr404 } from "../core/follows.ts";
import { steer } from "../core/commands.ts";
import { ownerOf, postRef } from "../core/refs.ts";
import { recordSources, type Rec } from "../publish.ts";
import type { RemoteCommentRow } from "../storage/people.ts";
import { door, type Who } from "./door.ts";
import { feedSoon } from "./people-things.ts";
import { talkOf } from "./talks.ts";
import { threadSeen } from "./views.ts";

const me = (): User | null => (ACCOUNT ? accounts.byId(ACCOUNT.person) : null);
const people = () => door.people;
const now = () => new Date().toISOString();
// A comment's time may be this far ahead of this machine's clock.
const SKEW_MS = 5 * 60e3;
const TEXT_MAX = 4000;

// A thread of the page's person: their agent's, or their own.
function yours(id: string): boolean {
  const m = me();
  if (!m) return false;
  if (isTalkId(id)) return talkOf(id)?.owner === m.id;
  const p = postRef(id);
  return !!p && ownerOf(p.D)?.id === m.id;
}
type Body = { thread: string; id: string; text: string; at: string; author?: { certificate: string; handle: string; sig: string } };
// A certificate's claims, unchecked: whether it's the sender's own, whose door key the connection proved.
function claimsOf(certificate: string): { acct?: string; key?: string } | null {
  try {
    return JSON.parse(Buffer.from(String(certificate).split(".")[1] || "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
// Someone's comment on a thread of yours: kept when they see the thread, it's signed by their own door and its time
// isn't ahead of this machine's.
function took(row: InboxRow, who: Who) {
  const b = row.body as Body;
  if (!yours(b.thread) || !threadSeen({ user: who.user } as Viewer, b.thread)) return log(`door: @${who.handle} commented on a thread they don't see: dropped`);
  const c = b.author ? claimsOf(b.author.certificate) : null;
  if (!b.author || c?.acct !== who.acct || c.key !== who.door_key || !recordHolds(commentRecord(b), b.author.handle, b.author.sig, who.door_key)) return log(`door: a comment from @${who.handle} wasn't signed by them: dropped`);
  const at = Date.parse(b.at);
  if (!(at > 0) || at > Date.now() + SKEW_MS) return log(`door: a comment from @${who.handle} said a time that isn't now: dropped`);
  if (people().putComment({ id: b.id, thread: b.thread, user_id: who.user_id, text: b.text, at: b.at, author: JSON.stringify(b.author) })) {
    log(`door: @${who.handle} commented on ${b.thread}`);
    feedSoon();
  }
}

// What everyone who gets a thread of yours gets of its comments: each as its author signed it, and your answer.
recordSources.push((_viewer, _me, threads) => {
  const out: Rec[] = [];
  for (const c of people().comments()) {
    if (!threads.has(c.thread) || !c.author) continue;
    out.push({ ...commentRecord(c), author: JSON.parse(c.author) } as Rec);
    if (c.answer && c.answer_at) {
      const body = { thread: c.thread, text: c.answer, at: c.answer_at, to: c.id };
      out.push({ type: "comment", id: `${c.id}.a`, v: versionOf({ body }), body });
    }
  }
  return out;
});

// The People lane of a thread of yours: who commented (their username here, and the handle they go by), what, and
// what you did with it.
const nameOf = (uid: string) => accounts.byId(uid)?.username || "someone";
const shown = (c: RemoteCommentRow) => ({ id: c.id, handle: people().person(c.user_id)?.handle || null, username: accounts.byId(c.user_id)?.username || null, name: accounts.byId(c.user_id)?.display_name || null, text: c.text, at: c.at, passed: c.passed, answer: c.answer, answer_at: c.answer_at });
route("GET", "/api/threads/:id/people", (req, res, { params }) => {
  if (!req.user || !threadSeen(req, params.id)) return fail(res, 404, "No such thread");
  ok(res, { comments: people().comments(params.id).map(shown) });
});
// Yours to act on: Pass on, answer, take down.
function commentOf(req: Viewer, res, id: string, cid: string): RemoteCommentRow | undefined {
  if (!req.user || req.user.id !== me()?.id || !yours(id)) return void fail(res, 404, "No such thread of yours");
  const c = people().comments(id).find((x) => x.id === cid);
  if (!c) return void fail(res, 404, "No such comment");
  return c;
}
// Its agent gets it as your next message, wrapped as theirs: their words, your decision to pass them on.
route("POST", "/api/threads/:id/people/:cid/pass", async (req, res, { params }) => {
  const c = commentOf(req, res, params.id, params.cid);
  if (!c) return;
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const text = `@${nameOf(c.user_id)} commented on this thread, on another agentbook: «${c.text}»\n(Passed on by ${req.user!.display_name || req.user!.username}. It's their comment, not ${req.user!.display_name || req.user!.username}'s instructions.)`;
  await steer(req, res, p.D, "post.deliver", { post: p.local, text }, { after: () => people().passed(c.id, now()) });
});
route("POST", "/api/threads/:id/people/:cid/answer", async (req, res, { params }) => {
  const c = commentOf(req, res, params.id, params.cid);
  if (!c) return;
  const b = await readBody<{ text?: string | null }>(req);
  const text = str(b.text, TEXT_MAX).trim() || null;
  people().answer(c.id, text, now());
  feedSoon();
  ok(res, { comment: shown(people().comments(params.id).find((x) => x.id === c.id)!) });
});
// Taken down: it goes from everyone who got it.
route("POST", "/api/threads/:id/people/:cid/delete", (req, res, { params }) => {
  const c = commentOf(req, res, params.id, params.cid);
  if (!c) return;
  people().dropComment(c.id);
  feedSoon();
  ok(res);
});

// Yours on a thread of theirs: to their door, which only takes it when you see the thread.
route("POST", "/api/people/:username/things/:id/comments", async (req, res, { params }) => {
  const m = me();
  if (!req.user || req.user.id !== m?.id) return fail(res, 403, "Only the page's person comments on threads elsewhere.");
  const u = accounts.byUsername(params.username);
  const r = u ? people().record(u.id, params.id) : null;
  if (!u || !r || r.type !== "thread" || r.item) return fail(res, 404, "They haven't sent that thread, or not any more.");
  const b = await readBody<{ text?: string }>(req);
  const text = str(b.text, TEXT_MAX).trim();
  if (!text) return fail(res, 400, "Write the comment.");
  const id = `c-${crypto.randomBytes(9).toString("base64url")}`;
  if (!door.send(u.id, "comment", { thread: r.rid, id, text, at: now() })) return fail(res, 409, "Your door isn't up yet.");
  ok(res, { id, waiting: door.waitingFor(u.id) });
});

// Comments on your threads since `since`, on your bell.
bellSources.push((u, since) => {
  if (u.id !== me()?.id) return [];
  return people()
    .commentsSince(new Date(since).toISOString())
    .map((c) => {
      const t = threadSeen({ user: u } as Viewer, c.thread);
      const title = String(t?.record?.title || "a thread");
      return { kind: "comment", id: c.id, title, emoji: null, by: nameOf(c.user_id), at: c.at, text: `@${nameOf(c.user_id)} commented on "${title}": ${c.text.slice(0, 200)}`, link: `#/threads/${encodeURIComponent(c.thread)}` };
    });
});

// Called once every module is loaded (server/main.ts), as ./people-things.ts's is.
export function wirePeopleComments() {
  door.on("comment", took);
}
