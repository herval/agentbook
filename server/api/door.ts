// People on other agentbooks, through your door (../door.ts): where your
// door runs and your invite link; finding someone by the invite link they gave you; and becoming contacts, both ways.
//
// Being contacts with someone elsewhere is the same contact as with someone on this page (the `contact` op), so the
// Contacts box, the bell and policy.ts work as they are. What changes is how each side hears of it:
//   - what came through the door (an ask, an answer, a take back, a remove) is checked against how you stand with them
//     and applied as an op here, by them, and isn't sent back out;
//   - an op of yours about them (you asked, said yes or no, took your ask back, removed them) goes to their door as the
//     message that says it.
// Following is your page's alone: nothing of it goes to anyone's door.
// How each stands with you is written for your door (setRel), which checks what they may send by it (wire.ts's WHO).

import { ACCOUNT } from "../config.ts";
import { HOME } from "../../plugin/shared/home.ts";
import { createDoor } from "../door.ts";
import type { InboxRow } from "../../plugin/shared/door/db.ts";
import type { User } from "../accounts.ts";
import { accounts, commit, log, storage, store } from "../core/state.ts";
import { fail, ok, readBody, route } from "../core/http.ts";
import { contactOf, contactRecord } from "../core/follows.ts";
import type { Op } from "../../plugin/shared/ops.ts";
import type { Kind } from "../../plugin/shared/door/wire.ts";

export const door = createDoor({ storage, accounts, home: HOME, account: ACCOUNT, log, enabled: process.env.AGENTBOOK_DOOR !== "0" });

// The page's person: the one whose door it is.
const me = (): User | null => (ACCOUNT ? accounts.byId(ACCOUNT.person) : null);

// Ops applied for what came through the door, which aren't sent back out.
let fromDoor = 0;
function applying(fn: () => void) {
  fromDoor++;
  try {
    fn();
  } finally {
    fromDoor--;
  }
}

// ---------- how each stands with you ----------
// contact: you're each other's contact; asked: you asked them to be. The door takes what each may send by these.
export function relOf(uid: string): string[] {
  const m = me();
  if (!m) return [];
  const rel = new Set<string>();
  if (contactOf(uid, m.id)) rel.add("contact");
  const c = contactRecord(uid, m.id);
  if (c && !c.at && c.ask === m.id) rel.add("asked");
  for (const x of extraRel) for (const r of x(uid)) rel.add(r);
  return [...rel];
}
// What other parts add (groups and the like you share: ./people-spaces.ts).
const extraRel: ((uid: string) => string[])[] = [];
export const addRel = (fn: (uid: string) => string[]) => extraRel.push(fn);
let syncing = false;
export function syncRel() {
  if (syncing) return;
  syncing = true;
  setImmediate(() => {
    syncing = false;
    for (const r of door.people.people()) door.setRel(r.user_id, relOf(r.user_id));
  });
}

// One person's, now: before a message that needs their door to take what they send next.
export const syncRelNow = (uid: string) => door.setRel(uid, relOf(uid));
// Everything they may see, again: asked of someone who just let you see more, as what they sent before your page knew
// it may have been refused.
export const wantAll = (uid: string) => door.send(uid, "want", { id: "*" }, "want:*");

// ---------- what came in ----------
export type Who = Parameters<Parameters<typeof door.on>[1]>[1];
const bodyOf = <T>(row: InboxRow) => row.body as T;

// Someone asks to be your contact (with what they said), or takes their ask back. Nobody gets anything until you say
// yes. An ask into a group, task, page or note of yours is ./people-spaces.ts's.
door.on("ask", (row, who) => {
  const m = me();
  const b = bodyOf<{ note?: string; space?: string }>(row);
  if (!m || b.space || contactOf(who.user_id, m.id)) return;
  applying(() => commit({ t: "contact", user: who.user_id, person: m.id, act: "ask", note: b.note ? String(b.note).slice(0, 500) : null }));
  log(`door: @${who.handle} asks to be your contact`);
  syncRel();
});
door.on("take_back", (row, who) => {
  const m = me();
  const b = bodyOf<{ space?: string }>(row);
  if (!m || b.space) return;
  if (contactRecord(who.user_id, m.id)?.ask === who.user_id) applying(() => commit({ t: "contact", user: who.user_id, person: m.id, act: "take_back" }));
  syncRel();
});
// Their answer to your ask: yes, and you're contacts, so each sees what the other made public; or no.
door.on("answer", (row, who) => {
  const m = me();
  const b = bodyOf<{ yes: boolean }>(row);
  const c = m ? contactRecord(who.user_id, m.id) : null;
  if (!m || !c || c.at || c.ask !== m.id) return;
  applying(() => commit({ t: "contact", user: who.user_id, person: m.id, act: b.yes ? "yes" : "no" }));
  log(`door: @${who.handle} ${b.yes ? "said yes: you're contacts" : "said no"}`);
  syncRelNow(who.user_id);
  if (b.yes) wantAll(who.user_id);
  syncRel();
});
// They removed you: you're not contacts any more, and each is off everything of the other's (./contacts.ts).
door.on("remove", (row, who) => {
  const m = me();
  if (!m || !contactRecord(who.user_id, m.id)) return;
  applying(() => commit({ t: "contact", user: who.user_id, person: m.id, act: "remove" }));
  for (const fn of removeHooks) void fn(who);
  log(`door: @${who.handle} removed you from their contacts`);
  syncRel();
});
// What else a remove takes (./contacts.ts: everything of yours they were on).
const removeHooks: ((who: Who) => void | Promise<void>)[] = [];
export const onRemoved = (fn: (who: Who) => void | Promise<void>) => removeHooks.push(fn);

// ---------- what goes out ----------
const OUT: Record<string, [Kind, Record<string, unknown>]> = { ask: ["ask", {}], take_back: ["take_back", {}], yes: ["answer", { yes: true }], no: ["answer", { yes: false }], remove: ["remove", {}] };
store.onChange((op: Op) => {
  if (op.t !== "contact") return;
  syncRel();
  const m = me();
  if (fromDoor || !m || !door.db() || op.user !== m.id || !door.isRemote(op.person)) return;
  const out = OUT[op.act];
  if (!out) return;
  const [kind, body] = out;
  door.send(op.person, kind, { ...body, ...(op.act === "ask" && op.note ? { note: op.note } : {}) }, "contact");
});

// ---------- routes ----------
// Your door: where it runs, how it is, and your invite link.
route("GET", "/api/door", (req, res) => {
  if (!req.user || req.user.id !== me()?.id) return fail(res, 403, "Only the page's person has a door here.");
  ok(res, { door: door.status() });
});
// Someone to ask to be your contact: by the invite link they gave you (their row here, made the first time, with a hello
// to their door for their card), or by the username of someone your page knows already. Nobody else can be found. Then
// they're asked as anyone is (/api/people/:username/contact).
route("POST", "/api/people/find", async (req, res) => {
  if (!req.user || req.user.id !== me()?.id) return fail(res, 403, "Only the page's person has contacts elsewhere.");
  const b = await readBody<{ link?: string; handle?: string }>(req);
  if (b.link) {
    const r = door.fromInvite(String(b.link));
    if ("error" in r) return fail(res, r.status, r.error);
    syncRel();
    return ok(res, { user: r.user, remote: remoteInfo(r.user.id) });
  }
  const handle = String(b.handle || "").trim().replace(/^@/, "").toLowerCase();
  const known = accounts.byUsername(handle);
  if (!known || known.deleted || known.id === me()?.id) return fail(res, 404, `Nobody here is @${handle}. To add someone on another agentbook, paste the invite link they gave you.`);
  ok(res, { user: known, remote: remoteInfo(known.id) });
});

// What the page shows of someone elsewhere: their @handle, whether their door answered last time, and how many
// messages wait for it. Null for someone on this page.
export function remoteInfo(uid: string): { handle: string; reach: { ok: boolean; at: number } | null; waiting: number } | null {
  const r = door.remote(uid);
  if (!r) return null;
  const reach = door.reachOf(uid);
  return { handle: r.handle, reach: reach ? { ok: reach.ok, at: reach.at } : null, waiting: door.waitingFor(uid) };
}
