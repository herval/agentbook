import type { Device } from "../relay.ts";
import { accounts, commit, log, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Answer, PostRef } from "../core/types.ts";
import { allPosts, isOwner, markAll, ownerOf, postRef } from "../core/refs.ts";
import { needsKeys, toSign } from "../core/commands.ts";
import { connectors } from "../core/services.ts";
import { viewForReq } from "./views.ts";
import { NOT_HEADS } from "./prs.ts";
import { titleOf } from "./cli.ts";
import { cloudLink } from "./machines.ts";
import { flagsSoon } from "./task-ship.ts";

// What came in while this server was down is archived once it's up, for whoever has Auto-archive on.
setTimeout(() => Object.keys(state.prefs || {}).forEach((uid) => prefsOf(uid).auto_archive && archiveSoon(null, uid)), 5e3).unref();
// Archive a thread (`by`: who, by username): whether it went to sleep (`slept`), and its worktree going too
// (archiveClean: `cleans` or `clean`).
export async function archiveThread(p: PostRef, by: string | null): Promise<{ slept?: boolean; cleans?: string; clean?: { machine: string; root: string; branch: string } }> {
  // Archiving a thread closes what it still asks you, first, so an archived thread doesn't need you: its machine
  // closes each, and its agent hears it went unanswered (an ab_ask, a driver's turn and Claude's questions go on).
  const open = p.D.store.state.questions.filter((q) => q.post === p.local && !q.answered);
  await Promise.all(open.map((q) => relay.command(p.D, "post.answer", { post: p.local, qid: q.id, archived: true }, { by, wait: 15e3 })));
  // And unpins it, for everyone who had: it's out of the feed, and doesn't come back on top when it's brought back.
  // Before the flag, so the live update the flag sends has it unpinned.
  accounts.unpinAll(p.id);
  markAll(p, "post", { t: "session.flag", archived: true });
  flagsSoon(ownerOf(p.D)?.id);
  let slept = false;
  if (p.s.state !== "done" && !p.s.cloud) slept = !!((await relay.command(p.D, "post.sleep", { post: p.local, reason: "Archived" }, { by, wait: 15e3 })) as Answer)?.slept;
  return { slept, ...archiveClean(p, slept, by) };
}
// A thread its person stopped following is archived with what it had, but its session isn't
// put to sleep nor its worktree cleaned up: it goes on where it is, out of agentbook's hands. Whatever it still asked
// its machine closed as it went off (session.off).
export function archiveOff(p: PostRef) {
  if (p.s.archived) return;
  accounts.unpinAll(p.id);
  markAll(p, "post", { t: "session.flag", archived: true });
  flagsSoon(ownerOf(p.D)?.id);
}
// One its own session took off agentbook (ab_keep_off) is archived as its machine says so, once that op is in.
export function offHear(D: Device, op) {
  if (op?.t !== "session.off" || !op.off) return;
  setImmediate(() => {
    const p = postRef(relay.idOf(D, op.post));
    if (p) archiveOff(p);
  });
}
// Archiving deletes the thread's worktree and its branch once nothing's left on it: what its card's Delete worktree
// does, by the same rule (wipCleanable in app.js), its machine checking it all again (cleanUp in wip.ts). Not for main,
// a cloud thread, the project's own folder, a branch with a commit that isn't on main or a change not committed, nor
// while this thread or another on that branch is still up (one asleep counts, unless it's archived), since its folder
// would go from under it. Sent from here (`cleans`: its branch), or, to a machine that takes Clean up only signed, by
// the page, which signs it (`clean`: { machine, root, branch }). Nothing when it isn't for deleting: its card keeps the
// button.
function archiveClean(p: PostRef, slept: boolean, by: string | null) {
  const s = p.s;
  const b = s.branch;
  if (s.cloud || !s.root || !b || NOT_HEADS.has(b) || !(slept || s.state === "done" || s.asleep)) return {};
  const f = (relay.infoOf(p.D).folders?.folders || []).find((x) => x.root === s.root);
  const w = (f?.wip || []).find((x) => x.branch === b);
  if (!w || w.here || w.ahead || w.dirty) return {};
  const others = Object.values(p.D.store.state.sessions).filter((x) => x.id !== p.local && !x.cloud && x.root === s.root && x.branch === b);
  if (!others.every((x) => x.state === "done" || (x.asleep && x.archived))) return {};
  const args = { root: s.root, branch: b };
  if (needsKeys(p.D)) return {};
  if (toSign(p.D, "wip.clean", args, by, 0)) return { clean: { machine: p.D.name, ...args } };
  relay
    .command(p.D, "wip.clean", args, { by, wait: 60e3 })
    .then((r: Answer) => r?.error && log(`archive: ${s.label} keeps ${b}: ${r.error}`))
    .catch(() => {});
  return { cleans: b };
}

/* ---------- your settings: Auto-archive ---------- */

// A person's settings (prefs.set): each off until they turn it on.
export function prefsOf(uid: string) {
  const p = (uid && state.prefs?.[uid]) || {};
  return { auto_archive: !!p.auto_archive, private_terminals: !!p.private_terminals };
}
// What a machine's poll carries of its person's settings: Private terminals, which it applies itself.
// And, on a machine in a cloud sandbox, that git signs in to GitHub as them (gitGithub).
// `cloud`: it's linked to a sandbox, so it says whether it's busy (cloud.ts, "sleeping").
export const machinePrefs = (D: Device) => ({ private_terminals: prefsOf(ownerOf(D)?.id).private_terminals, git_github: !!gitGithub(D), cloud: !!cloudLink(D) });
// git on a cloud machine signs in to GitHub as its owner: the machine
// has no sign-in of its own, so its git asks agentbook-cli, which asks here, for the token of its owner's GitHub
// connector, the one this server keeps and renews. Only a machine its owner linked to a sandbox gets it, only their
// own token, only while they leave it on (machine.cloud's `github`) and have a GitHub connector. -> the token, or null.
export function gitGithub(D: Device) {
  const link = cloudLink(D); // its own sandbox, or the shared machine's it has a seat on: each person signs in as themselves
  if (!link || link.github === false) return null;
  return connectors.keyFor(ownerOf(D)?.id, "github");
}

// Auto-archive: a thread of yours on a branch or with a pull request is archived once its work is in, and the bell says
// so with a link to it. In: every pull request it links merged or closed, one at least merged since it started; or,
// with none open, everything on its branch on main (its worktree's WIP says so: commits, none ahead, nothing
// uncommitted), or the branch cleaned up that way (`landed`). Not while it works (it's archived when its turn ends),
// nor while it asks you something. Each thread once: one you bring back stays, and the ones whose work was in when you
// turned it on stay as they are (archiveStartsNow).
// Why a thread's work is in ("#12 merged", "cart landed on main"), or null. A pull request merged before it started
// (one it only looked at) isn't its work.
function workIn(p: PostRef) {
  const s = p.s;
  const prs = Object.values(s.prs || {}).filter((x) => x.url && !x.off);
  if (prs.some((x) => x.gh?.state !== "merged" && x.gh?.state !== "closed")) return null;
  const merged = prs.filter((x) => x.gh?.state === "merged" && !(Date.parse(x.gh.closed) < Date.parse(s.started)));
  if (merged.length) return `${merged.map((x) => `#${x.number || x.gh?.number}`).join(", ")} merged`;
  const b = s.branch;
  if (!b || NOT_HEADS.has(b)) return null;
  if (s.landed === b) return `${b} landed`;
  const f = s.root && (relay.infoOf(p.D).folders?.folders || []).find((x) => x.root === s.root);
  const w = (f?.wip || []).find((x) => x.branch === b);
  return w && w.worked && !w.ahead && !w.dirty ? `${b} landed on ${w.base || "main"}` : null;
}
// Whether a thread is between turns, asking you nothing.
const archivable = (p: PostRef) => !p.s.archived && !p.s.busy && p.s.state !== "working" && !p.D.store.state.questions.some((q) => q.post === p.local && !q.answered);
// Turned on: the threads whose work is in already are left as they are.
export function archiveStartsNow(uid: string) {
  const posts = [];
  for (const p of allPosts()) if (ownerOf(p.D)?.id === uid && !state.auto_archived?.[p.id] && workIn(p)) posts.push({ post: p.id });
  if (posts.length) commit({ t: "auto.archived", user: uid, posts, skipped: true });
}
// Look again soon: at a post (`post`, the page's id), or every thread of a person's (`uid`).
// What's to be looked at again (archiveSoon), until archiveNow looks.
let archiveDue: { posts: Set<string>; users: Set<string>; timer: ReturnType<typeof setTimeout> | null } | null = null;
export function archiveSoon(post: string | null, uid: string | null = null) {
  const due = (archiveDue ||= { posts: new Set(), users: new Set(), timer: null });
  if (post) due.posts.add(post);
  if (uid) due.users.add(uid);
  due.timer ||= setTimeout(archiveNow, Number(process.env.AGENTBOOK_ARCHIVE_MS || 1500));
  due.timer.unref?.();
}
const archiving = new Set(); // posts being archived now
function archiveNow() {
  const { posts, users } = archiveDue;
  archiveDue = null;
  const due = new Map();
  for (const id of posts) {
    const p = postRef(id);
    if (p) due.set(p.id, p);
  }
  if (users.size) for (const p of allPosts()) if (users.has(ownerOf(p.D)?.id)) due.set(p.id, p);
  const done = new Map(); // uid -> [{ post, why, title }]
  for (const p of due.values()) {
    const o = ownerOf(p.D);
    if (!o || !prefsOf(o.id).auto_archive || state.auto_archived?.[p.id] || archiving.has(p.id) || !archivable(p)) continue;
    const why = workIn(p);
    if (!why) continue;
    (done.get(o.id) || done.set(o.id, []).get(o.id)).push({ p, why });
  }
  for (const [uid, list] of done) {
    commit({ t: "auto.archived", user: uid, posts: list.map(({ p, why }) => ({ post: p.id, why, title: titleOf(p.s) })) });
    for (const { p, why } of list) {
      archiving.add(p.id);
      log(`auto-archive: ${p.s.label} (${p.id}), ${why}`);
      archiveThread(p, ownerOf(p.D)?.username || null)
        .catch((e) => log(`auto-archive: ${p.id}: ${e.message}`))
        .finally(() => archiving.delete(p.id));
    }
  }
}
// What can bring a thread's work in, or let it be archived: a pull request read or linked, its branch cleaned up or
// moved, its turn ending, a question answered; its machine's WIPs changing (every thread of its person's).
export function archiveHear(D: Device, op, info) {
  const uid = ownerOf(D)?.id;
  if (!uid || !prefsOf(uid).auto_archive) return;
  if (info?.includes("folders")) archiveSoon(null, uid);
  if (!["session.pr", "session.landed", "session.where", "session.status", "session.gone", "session.hello", "question.answer"].includes(op?.t)) return;
  const local = op.post || (op.t === "question.answer" ? D.store.state.questions.find((q) => q.id === op.qid)?.post : null);
  if (local) archiveSoon(relay.idOf(D, local));
}
// An archived thread doesn't stay up, waiting on you in its own prompt. One that didn't go to sleep when it was
// archived (Claude Code couldn't stop it, or its machine was off past the command's hour) goes when its machine
// next connects, if the machine last said its background session was running.
export function sleepArchived(D: Device) {
  for (const s of Object.values(D.store.state.sessions)) {
    const rt = relay.infoOf(D)[`post:${s.id}`]?.rt;
    if (!s.archived || s.off || s.state === "done" || s.asleep || s.cloud || rt?.kind !== "background" || ["stopped", "failed", "done"].includes(rt.state)) continue;
    relay.command(D, "post.sleep", { post: s.id, reason: "Archived" }, { by: ownerOf(D)?.username || null, wait: 15e3 }).catch(() => {});
  }
}
// Archive a start that failed out of the feed, or take back one that waits for its machine.
route("POST", "/api/launches/:id/archive", (req, res, { params }) => {
  for (const D of relay.devices.values()) {
    if (!isOwner(req, D)) continue;
    const c = relay.waiting(D).find((x) => x.kind === "post.start" && x.args.lid === params.id);
    if (c) return relay.cancel(D, c.cid) ? ok(res, { cancelled: true }) : fail(res, 409, "It's on its way to its machine.");
  }
  const r = relay.resolve(params.id);
  const l = r && r.D.store.state.launches[r.local];
  if (!l) {
    // One its machine refused before it was a start there.
    for (const D of relay.devices.values()) if (isOwner(req, D) && relay.archiveStart(D, params.id)) return ok(res, {});
    return fail(res, 404, "No such start.");
  }
  if (!isOwner(req, r.D)) return fail(res, 403, "Only an agent's owner can do that.");
  if (!l.error) return fail(res, 409, "It hasn't failed: once it starts, it's a thread you can archive.");
  r.D.store.commit({ t: "launch.archive", lid: l.id });
  ok(res, {});
});
// And so is archiving a page's update off your feed: its card goes under Archived until the page changes again
// (a routine's quiet refresh doesn't count, as it doesn't move the card). The page isn't archived: it stays in Pages
// and the sidebar, followed, and its agents keep it up to date.
route("POST", "/api/feed/archive", async (req, res) => {
  const b = await readBody<{ page?: string; archived?: boolean }>(req);
  const id = str(b.page, 200);
  if (!req.user) return fail(res, 403, "A person archives what's on their feed, not a machine.");
  const p = viewForReq(req).pages.find((x) => x.id === id);
  if (!p) return fail(res, 404, "No such page");
  commit({ t: "feed.archive", user: req.user.id, page: id, on: b.archived !== false, moved: p.moved || p.updated || "" });
  ok(res);
});
