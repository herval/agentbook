import { isLevel } from "../../plugin/shared/visibility.ts";
import type { ScopeChanges } from "../work.ts";
import { prOfUrl, prUrl } from "../integrations/pulls.ts";
import { expandMentions, mentionNote } from "../../plugin/shared/mentions.ts";
import { conversationOf } from "../../plugin/shared/store.ts";
import { isMode, RUNTIMES, runtimeOfThread, threadCapsOf } from "../../plugin/shared/runtimes.ts";
import { RUN_CODE_MAX } from "../../plugin/shared/protocol.ts";
import type { Device } from "../relay.ts";
import type { Session } from "../../plugin/shared/types.ts";
import { blobs, relay, work } from "../core/state.ts";
import { fail, modelName, ok, readBody, route, str } from "../core/http.ts";
import { noFullAccess } from "../core/guards.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { Answer, PostRef } from "../core/types.ts";
import { agentOfPost, deviceFor, isOwner, markAll, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { postOr404, seesPost } from "../core/follows.ts";
import { readOf, signedOr428, steer } from "../core/commands.ts";
import { news } from "../core/services.ts";
import { aroundThread, threadDetail } from "./views.ts";
import { prLooked, watchPrs } from "./prs.ts";
import { workOf } from "./queries.ts";
import { archiveOff, archiveThread } from "./archive.ts";
import { mentionLinks, workspacesNamed } from "./workspaces.ts";
import { pagesSeenBy, postPage } from "./pages.ts";
import { noteRefs, notesNamed } from "./notes.ts";
import { answerRoutineQuestion } from "./routines.ts";
import { threadNewsFor } from "./guests.ts";
import { flagsSoon } from "./task-ship.ts";
import { launchId } from "./launch.ts";

// The code block of a thread's message that a run is about: the message, by the page's id, and which of its blocks.
interface RunBody {
  message?: string;
  block?: number;
}



/* ---------- posts ---------- */

route("GET", "/api/sessions/:id", (req, res, { params }) => {
  const t = threadDetail(req, params.id);
  if (!t) return fail(res, 404, "No such thread");
  prLooked.set(t.p.id, Date.now()); // its pull requests are read more often while it's on a page
  news.looked(req.user?.id, t.p.id);
  ok(res, { ...t.detail, ...aroundThread(req, t.detail) });
});

/* ---------- what a post changed, as its machine works it out ---------- */

const scopeOf = (q, fallback = "all") => {
  const v = String(q.get("turn") || q.get("scope") || fallback);
  return v === "all" || v === "auto" || /^\d+$/.test(v) ? v : fallback;
};
// What a post changed, as its machine sent it: its files with their sizes, totals, and its commits. `?turn=<n>` for
// one turn, `all` for the whole post, `auto` (the default) for the turn it's on while it has one that changed
// something. One its machine hasn't sent is read there.
const withoutHunks = ({ hunks, hidden, more, abs, ...f }: ScopeChanges["files"][number] & { hidden?: unknown; abs?: string }) => f;
route("GET", "/api/sessions/:id/changes", async (req, res, { params, query }) => {
  const p = postOr404(req, res, params.id, "work");
  if (!p) return;
  const meta = work.changes(p.D, p.local, "meta");
  let kept = null;
  if (meta) {
    let scope = scopeOf(query, "auto");
    if (scope === "auto") scope = p.s.state !== "done" && meta.latest_has && meta.turns > 1 ? String(meta.latest) : "all";
    const c = work.changes(p.D, p.local, scope) || { files: [], totals: { files: 0, add: 0, del: 0 }, commits: [] };
    kept = { scope, latest: meta.latest, latest_has: meta.latest_has, turns: meta.turns, files: c.files.map(withoutHunks), totals: c.totals, commits: c.commits || [] };
  }
  await workOf(res, p, "read.changes", { post: p.local, scope: scopeOf(query, "auto") }, kept);
});
// One file's change in a scope, with its hunks.
route("GET", "/api/sessions/:id/changes/file", async (req, res, { params, query }) => {
  const p = postOr404(req, res, params.id, "work");
  if (!p) return;
  const sent = work.changes(p.D, p.local, "meta") ? work.changes(p.D, p.local, scopeOf(query)) || { files: [] } : null;
  const kept = sent?.files.find((x) => x.path === query.get("path")) || null;
  if (sent && !kept && !(p.s.state !== "done" && relay.online(p.D))) return fail(res, 404, "It didn't change that file.");
  await workOf(res, p, "read.change_file", { post: p.local, path: String(query.get("path") || ""), scope: scopeOf(query) }, kept);
});
// What one step changed: an edit's file, a command's files, or what a subagent changed.
route("GET", "/api/sessions/:id/steps/:step/diff", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "work");
  if (!p) return;
  const kept = work.changes(p.D, p.local, "meta") ? { files: work.changes(p.D, p.local, `s:${params.step}`)?.files || [] } : null;
  await workOf(res, p, "read.step_diff", { post: p.local, step: params.step }, kept);
});
route("GET", "/api/sessions/:id/commits/:sha", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "work");
  if (p) await readOf(res, p.D, "read.commit", { post: p.local, sha: String(params.sha).slice(0, 64) });
});

/* ---------- steering a post: commands to its machine ---------- */

// Files you attached, as their machine fetches them: your uploads only.
export const uploadsOf = (req: Viewer, ids: unknown) =>
  (Array.isArray(ids) ? ids : [])
    .map((id) => blobs.uploadOf(String(id)))
    .filter((u) => u && u.owner === req.user.id)
    .map(blobs.ref)
    .slice(0, 20);

// A message from you, with any files you attached (uploaded first). On an ended post, it resumes the
// conversation. On a machine that's off, it waits for it.
route("POST", "/api/sessions/:id/messages", async (req, res, { params }) => {
  const b = await readBody<{ text?: string; command?: string | null; files?: unknown[]; side?: boolean; queue?: boolean }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const files = uploadsOf(req, b.files);
  // A widget named in short is one on the thread's page: written out in full, it means the same thing anywhere. Its
  // agent gets a note on what each page and widget it names showed (mentions.ts), of the pages its sender may see.
  const seen = pagesSeenBy(req.user);
  const onPage = postPage(p.id, null, null, req.user)?.id;
  const text = expandMentions(str(b.text, 12000), onPage ? seen[onPage] : null);
  if (!text && !files.length) return fail(res, 400, "Write something, or attach a file.");
  if (!threadCapsOf(p.s).replies) return fail(res, 409, `${placeOf(p.s)} takes replies on its own page.`);
  // `side`: on the side, a side thread that goes on from its conversation so far, which this
  // thread never hears of. Its owner's alone, in words: what it names of pages and widgets comes with it, as a note.
  if (b.side) {
    if (/^\s*\//.test(text)) return fail(res, 400, "A side thread starts from words, not a slash command.");
    const note = mentionNote(text, seen, Date.now(), workspacesNamed(req.user, text), { tasks: {}, groups: {} });
    return steer(req, res, p.D, "post.side", { post: p.local, text, files, ...(note ? { note } : {}) }, { wait: 60e3, done: (r) => (r.lid ? { ...r, lid: relay.idOf(p.D, r.lid) } : r) });
  }
  // `command`: a slash command's name, when the text is one its agent runs.
  const command = typeof b.command === "string" && /^[\w:.-]{1,100}$/.test(b.command) ? b.command : null;
  // A task or a group it names: the thread goes on it, or in it (mentionLinks), and its agent is told so.
  const links = command ? { tasks: {}, groups: {} } : await mentionLinks(req, p, text);
  // A note it names: its agent is told what it is, and the thread shows on it.
  if (!command) links.notes = notesNamed(req.user, text);
  noteRefs(links.notes, { post: p.id });
  // What the others in its conversation said since it last heard (its guests, or the thread it's a guest in) comes with
  // it: not with a slash command, which its agent runs as it's written.
  const note = [mentionNote(text, seen, Date.now(), workspacesNamed(req.user, text), links), command ? null : threadNewsFor(p.id)].filter(Boolean).join("\n\n");
  // `queue`: while its turn runs, it waits for the turn to end.
  await steer(req, res, p.D, "post.deliver", { post: p.local, text, files, ...(note ? { note } : {}), ...(b.queue ? { queue: true } : {}), ...(command ? { command } : {}) }, { done: (r) => (r.lid ? { ...r, lid: relay.idOf(p.D, r.lid) } : r) });
});
// The slash commands its agent can run from here, from its machine: what the / list in its reply box shows.
route("GET", "/api/sessions/:id/commands", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (p) await readOf(res, p.D, "read.commands", { post: p.local });
});
// Whether its folder is gone (another tool cleaned up its worktree), and what can put it back: `gone`, null while
// it's there. And one of those ways (`way`), done on its machine: a checkout can take a minute in a big repo.
route("GET", "/api/sessions/:id/folder", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (p) await readOf<Answer & { gone?: { taken_by?: string } | null }>(res, p.D, "read.folder", { post: p.local }, { as: (d) => (d?.gone?.taken_by ? { ...d, gone: { ...d.gone, taken_by: relay.idOf(p.D, d.gone.taken_by) } } : d) });
});
route("POST", "/api/sessions/:id/folder", async (req, res, { params }) => {
  const b = await readBody<{ way?: string }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const way = String(b.way || "");
  if (!["checkout", "copy", "base", "empty"].includes(way)) return fail(res, 400, "Say how to put its folder back: checkout, copy, base or empty.");
  await steer(req, res, p.D, "folder.restore", { post: p.local, way }, { wait: 240e3 });
});
// Its queue: one of them sent now or dropped (`mid`), or all of it paused, going again, or cleared.
route("POST", "/api/sessions/:id/queue", async (req, res, { params }) => {
  const b = await readBody<{ op?: string; mid?: string }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const op = String(b.op || "");
  if (!["now", "drop", "pause", "resume", "clear"].includes(op)) return fail(res, 400, "Say what to do with its queue: now, drop, pause, resume or clear.");
  let mid;
  if (op === "now" || op === "drop") {
    const r = relay.resolve(String(b.mid || ""));
    if (!r || r.D !== p.D || !conversationOf(p.D.store.state, p.local).some((m) => m.id === r.local)) return fail(res, 404, "No such message");
    mid = r.local;
  }
  await steer(req, res, p.D, "post.queue", { post: p.local, op, ...(mid ? { mid } : {}) });
});
// A message of yours its agent couldn't be reached with: sent again, or deleted.
for (const [verb, kind] of [["retry", "post.resend"], ["delete", "post.discard"]]) {
  route("POST", `/api/sessions/:id/messages/:mid/${verb}`, async (req, res, { params }) => {
    const p = postOr404(req, res, params.id, "own");
    if (!p) return;
    const r = relay.resolve(params.mid);
    if (!r || r.D !== p.D || !conversationOf(p.D.store.state, p.local).some((m) => m.id === r.local)) return fail(res, 404, "No such message");
    await steer(req, res, p.D, kind, { post: p.local, mid: r.local });
  });
}
// A turn an API error cut off, picked up now rather than at its machine's next try.
route("POST", "/api/sessions/:id/pickup", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud. Pick it up there.");
  await steer(req, res, p.D, "post.pickup", { post: p.local });
});
// Claude Code signed in again on a thread's machine, from its Login expired card (cli/claude-signin.ts): `step`
// "start" answers with the link to sign in to claude.ai with, and "code" sends the code claude.ai showed then. Its
// owner's only (it signs that machine's Claude Code in to whichever account you sign in with), signed with their
// passkey when the machine wants that; the code is held in memory only, and neither waits for a machine that's off.
route("POST", "/api/sessions/:id/claude-login", async (req, res, { params }) => {
  const b = await readBody<{ step?: string; code?: unknown }>(req).catch((): { step?: string; code?: unknown } => ({}));
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud, where agentbook can't sign Claude in.");
  if (!relay.online(p.D)) return fail(res, 503, `${p.D.name} is off. Sign in once it's back.`);
  const step = b.step === "code" ? "code" : "start";
  const agent = p.D.store.state.agents[p.s.agent]?.config_dir ? p.s.agent : undefined;
  let args: Record<string, unknown> = { step, ...(agent ? { agent } : {}) };
  if (step === "code") {
    const code = typeof b.code === "string" ? b.code.trim() : "";
    if (!code) return fail(res, 400, "Paste the code claude.ai showed you.");
    if (code.length > 2000) return fail(res, 400, "That's too long for a code from claude.ai.");
    args.code = code;
  }
  const wait = step === "code" ? 50e3 : 25e3;
  const signed = await signedOr428(req, res, p.D, "claude.login", args, { wait });
  if (signed === false) return;
  if (signed) args = signed.envelope.args;
  if (args.agent !== agent) return fail(res, 400, "That is signed for another agent.");
  if (args.step !== step) return fail(res, 400, "That's signed for another step of signing in.");
  const r = (await relay.command(p.D, "claude.login", args, { by: viewerName(req), wait, signed })) as Answer;
  if (r?.queued) return fail(res, 504, `${p.D.name} didn't answer in time.`);
  if (r?.error) return fail(res, r.status || 502, r.error, r.ended ? { ended: true } : {});
  if (step === "code") return ok(res, { signed_in: true, machine: p.D.name });
  if (typeof r?.url !== "string" || !/^https:\/\/[^\s"'<>]+$/.test(r.url)) return fail(res, 502, `${p.D.name} didn't give a link to sign in with.`);
  ok(res, { url: r.url, machine: p.D.name });
});
// Stop what a post is doing, as Esc does in its terminal.
route("POST", "/api/sessions/:id/stop", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud. Stop it there.");
  const b = await readBody<{ force?: boolean }>(req).catch((): { force?: boolean } => ({}));
  await steer(req, res, p.D, "post.stop", { post: p.local, ...(b.force === true ? { force: true } : {}) });
});
// A command it left running in the background (a dev server, a shell watching a CI run, a monitor), by Claude Code's
// id for it: the end of what it has printed, read from its machine now, and stopping it. Its owner's only: what a
// command prints is nobody else's to read.
route("GET", "/api/sessions/:id/going/:gid/output", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (p) await readOf(res, p.D, "read.going", { post: p.local, id: str(params.gid, 80) });
});
route("POST", "/api/sessions/:id/going/:gid/stop", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (!relay.online(p.D)) return fail(res, 503, `${p.D.name} is off.`, { offline: true });
  await steer(req, res, p.D, "post.going_stop", { post: p.local, id: str(params.gid, 80) });
});
// Run a code block of one of its messages in its folder on its machine, as pasted into a terminal there (`block`:
// which of the message's; `code`: what it says, which its machine finds in the message before it runs it); or stop
// one that's running. What it prints shows under the block, and stays with the thread.
route("POST", "/api/sessions/:id/run", async (req, res, { params }) => {
  const b = await readBody<RunBody & { code?: unknown }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const m = runMessage(res, p, b);
  if (!m) return;
  const code = typeof b.code === "string" ? b.code : "";
  if (!code.trim()) return fail(res, 400, "There's no code to run.");
  if (code.length > RUN_CODE_MAX) return fail(res, 413, "That's too much code to run from here.");
  await steer(req, res, p.D, "post.run", { post: p.local, mid: m.mid, block: m.block, code });
});
route("POST", "/api/sessions/:id/run/stop", async (req, res, { params }) => {
  const b = await readBody<RunBody>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const m = runMessage(res, p, b);
  if (!m) return;
  await steer(req, res, p.D, "post.run_stop", { post: p.local, mid: m.mid, block: m.block });
});
// The message and block a run names, on its machine: { mid, block }, or null once it answered why not. Its machine
// has to be on: a run waits for nobody.
function runMessage(res: Res, p: PostRef, b: RunBody) {
  if (p.s.cloud) return void fail(res, 409, "It runs in the cloud: there's no folder here to run it in.");
  const r = relay.resolve(String(b.message || ""));
  if (!r || r.D !== p.D || !conversationOf(p.D.store.state, p.local).some((m) => m.id === r.local)) return void fail(res, 404, "No such message");
  const block = Number(b.block);
  if (!Number.isSafeInteger(block) || block < 0 || block > 500) return void fail(res, 400, "Which of its code blocks?");
  if (!relay.online(p.D)) return void fail(res, 409, `${p.D.name} is off. Run it once it's back.`);
  return { mid: r.local, block };
}
// Switch a post's model, its effort or its mode, from its next turn (a mode at once, where its runtime can). Whoever
// may steer it may, as they may pick them for a thread they start; Full access is its owner's to give.
route("POST", "/api/sessions/:id/model", async (req, res, { params }) => {
  const b = await readBody<{ model?: string }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const model = modelName(b.model);
  if (b.model && !model) return fail(res, 400, "That isn't a model name.");
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud. Pick its model there.");
  await steer(req, res, p.D, "post.model", { post: p.local, model: model || null });
});
route("POST", "/api/sessions/:id/effort", async (req, res, { params }) => {
  const b = await readBody<{ effort?: string }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (b.effort && !/^[a-z]{2,20}$/.test(b.effort)) return fail(res, 400, "That isn't an effort level.");
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud. Pick its effort there.");
  await steer(req, res, p.D, "post.effort", { post: p.local, effort: b.effort || null });
});
route("POST", "/api/sessions/:id/mode", async (req, res, { params }) => {
  const b = await readBody<{ mode?: string }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (b.mode && !isMode(b.mode)) return fail(res, 400, "That isn't a mode.");
  const shared = b.mode === "full" ? noFullAccess({ post: p.id }) : null;
  if (shared) return fail(res, 403, shared);
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud. Pick its mode there.");
  await steer(req, res, p.D, "post.mode", { post: p.local, mode: b.mode || null });
});
const placeOf = (s: Session) => runtimeInfoOf(s).place || runtimeInfoOf(s).name;
const runtimeInfoOf = (s: Session) => RUNTIMES[runtimeOfThread(s)];
// The places whose tasks' changes apply here, as a thread's runtime says (`applies`): "Codex Cloud".
const APPLIERS = Object.values(RUNTIMES)
  .filter((r) => r.caps.applies)
  .map((r) => r.place || r.name)
  .join(" and ");

// Apply a Codex Cloud task's change in a local checkout of its repository.
route("POST", "/api/sessions/:id/apply", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (!threadCapsOf(p.s).applies) return fail(res, 409, `Only ${APPLIERS} tasks apply.`);
  const b = await readBody<{ root?: string }>(req);
  await steer(req, res, p.D, "post.apply", { post: p.local, ...(b.root ? { root: str(b.root, 1000) } : {}) });
});
// Pull from the cloud, onto one of your machines.
route("POST", "/api/cloud/pull", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; ref?: string; root?: string; visibility?: string }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can do that.");
  const lid = launchId();
  await steer(req, res, D, "cloud.pull", { ref: str(b.ref, 1000), ...(b.root ? { root: str(b.root, 1000) } : {}), ...(isLevel(b.visibility) ? { visibility: b.visibility } : {}), lid }, { done: (r) => (r.lid ? { ...r, lid: relay.idOf(D, r.lid) } : r) });
});

// Archive a post out of the feed, or bring it back. Archiving a background session puts it to sleep too.
route("POST", "/api/sessions/:id/flag", async (req, res, { params }) => {
  const b = await readBody<{ archived?: boolean; hidden?: boolean }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  // One its person stopped following stays archived until they follow it again (/off), and isn't put to sleep.
  if (p.s.off && typeof b.archived === "boolean") return fail(res, 409, "You stopped following it. Follow it again to bring it back.");
  const a: Awaited<ReturnType<typeof archiveThread>> = b.archived === true ? await archiveThread(p, viewerName(req)) : {};
  if (b.archived === false) markAll(p, "post", { t: "session.flag", archived: false });
  if (b.archived === false) flagsSoon(ownerOf(p.D)?.id);
  // Hidden: off the feed, still going.
  if (typeof b.hidden === "boolean") markAll(p, "post", { t: "session.flag", hidden: b.hidden });
  ok(res, { slept: !!a.slept, cleans: a.cleans || null, clean: a.clean || null });
});
// Stop following a thread, or follow it again: its machine keeps its session off agentbook
// from now on, and it's archived with what it had; followed again, it's back in the feed. A machine that's off takes
// it once it's back, and the thread is archived meanwhile. Every machine that has the thread is told.
route("POST", "/api/sessions/:id/off", async (req, res, { params }) => {
  const b = await readBody<{ off?: boolean }>(req);
  if (typeof b.off !== "boolean") return fail(res, 400, "Say whether it's off: { off: true } or { off: false }.");
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const off = b.off;
  await steer(req, res, p.D, "post.off", { post: p.local, off }, {
    after: () => {
      for (const t of relay.twins(p.D, p.local).slice(1)) relay.command(t.D, "post.off", { post: t.local, off }, { by: viewerName(req), wait: 0 }).catch(() => {});
      if (off) return archiveOff(p);
      markAll(p, "post", { t: "session.flag", archived: false });
      flagsSoon(ownerOf(p.D)?.id);
    },
  });
});
// Link a pull request to a post by hand, or unlink one, whatever linked it: it stays unlinked until you link it
// again. Its state comes from GitHub on the next read.
route("POST", "/api/sessions/:id/prs", async (req, res, { params }) => {
  const b = await readBody<{ url?: string; off?: boolean }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const pr = prOfUrl(b.url);
  if (!pr) return fail(res, 400, "That isn't a link to a pull request on GitHub, like https://github.com/owner/repo/pull/12.");
  const url = prUrl(pr.repo, pr.number);
  const known = Object.keys(p.s.prs || {}).find((k) => k.toLowerCase() === url.toLowerCase());
  if (b.off === true) {
    if (!known) return fail(res, 404, "This thread doesn't link that pull request.");
    p.D.store.commit({ t: "session.pr", post: p.local, url: known, off: true });
  } else {
    p.D.store.commit({ t: "session.pr", post: p.local, url: known || url, number: pr.number, repo: pr.repo, how: "you", at: new Date().toISOString(), off: false });
    setTimeout(watchPrs, 50);
  }
  ok(res, { url: known || url });
});
// The thread one was started from, picked on its page by its owner (`from`: a thread they see), or none (null): for
// one nothing says it of (a Claude Desktop session says which started it only for its tasks). Kept on the server's
// record of it, as what's set on a thread is (markAll), by its id on that machine, or the page's id for a thread of
// another machine. Not itself, and not one it started, however far down.
route("POST", "/api/sessions/:id/from", async (req, res, { params }) => {
  const b = await readBody<{ from?: string | null }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const from = b.from == null || b.from === "" ? null : postRef(String(b.from));
  if (b.from != null && b.from !== "" && (!from || !seesPost(req, from))) return fail(res, 404, "No such thread to start it from.");
  if (from) {
    const same = (a, c) => relay.twins(a.D, a.local).some((t) => t.D === c.D && t.local === c.local);
    if (same(from, p)) return fail(res, 400, "A thread can't be started from itself.");
    const seen = new Set();
    for (let up = from; up?.s.started_from && !seen.has(up.id); ) {
      seen.add(up.id);
      up = postRef(up.D.map.get(up.s.started_from) || up.s.started_from); // as a view names it (relay's ID_KEYS)
      if (up && same(up, p)) return fail(res, 400, `${from.s.label} was started from this thread, so this one can't be started from it.`);
    }
  }
  for (const t of relay.twins(p.D, p.local)) {
    const there = from && relay.twins(from.D, from.local).find((x) => x.D === t.D);
    t.D.store.commit({ t: "session.from", post: t.local, started_from: from ? (there ? there.local : from.id) : null, by: "you" });
  }
  ok(res, { from: from ? from.id : null });
});
// A Claude Code session that couldn't start because Claude Code doesn't trust its folder: its machine trusts the
// folder, as the trust prompt there would, and starts it again (`folder.trust`, through its gate). Or one it wouldn't
// wake or resume for a thread (a `resume` start): the folder Claude Code named, and the thread's session wakes with
// what you sent it; that start is put away once it has, so its thread no longer says it, and it's done once.
const UNTRUSTED = /^Workspace not trusted\. Run `claude` in /;
const untrustedIn = (error) => /^Workspace not trusted\. Run `claude` in (\/.+?) once and accept/.exec(error || "")?.[1] || null;
const trustArgs = (l) => ({ path: l.resume ? untrustedIn(l.error) || l.root : l.cwd || l.root, lid: l.id });
const archiveWake = (D: Device, l) => (r) => {
  if (l.resume) D.store.commit({ t: "launch.archive", lid: l.id });
  return r;
};
route("POST", "/api/launches/:id/trust", async (req, res, { params }) => {
  const r = relay.resolve(params.id);
  const l = r && r.D.store.state.launches[r.local];
  if (!l) return fail(res, 404, "No such start.");
  if (!isOwner(req, r.D)) return fail(res, 403, "Only an agent's owner can do that.");
  if (!UNTRUSTED.test(l.error || "") || l.archived || (l.resume ? !l.post : !l.named || l.teleport)) return fail(res, 409, "It didn't fail for want of trust.");
  await steer(req, res, r.D, "folder.trust", trustArgs(l), { done: archiveWake(r.D, l) });
});
// A message of yours that couldn't wake its session for the same reason: through the last start that failed so.
route("POST", "/api/sessions/:id/messages/:mid/trust", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const r = relay.resolve(params.mid);
  const m = r && r.D === p.D && conversationOf(p.D.store.state, p.local).find((x) => x.id === r.local);
  if (!m) return fail(res, 404, "No such message");
  const l = /Workspace not trusted\. Run `claude` in /.test(m.failed?.error || "") && Object.values(p.D.store.state.launches).filter((x) => x.resume && x.post === p.local && UNTRUSTED.test(x.error || "") && !x.archived).at(-1);
  if (!l) return fail(res, 409, "It didn't fail for want of trust.");
  await steer(req, res, p.D, "folder.trust", trustArgs(l), { done: archiveWake(p.D, l) });
});
route("POST", "/api/sessions/:id/visibility", async (req, res, { params }) => {
  const b = await readBody<{ visibility?: string | null }>(req);
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  if (b.visibility !== undefined && b.visibility !== null && !isLevel(b.visibility)) return fail(res, 400, "Private or public?");
  // Who sees it; whoever does sees its work too (an old page's `show_work` is ignored).
  markAll(p, "post", { t: "session.visibility", visibility: b.visibility });
  ok(res);
});

// Your answer to a question on one of your posts: to its machine, which hands it to its agent. A question the
// server asked itself (the OK for a routine's version) is answered here.
route("POST", "/api/questions/:id/answer", async (req, res, { params }) => {
  const b = await readBody<{ skip?: boolean; value?: string; mode?: string }>(req);
  const r = relay.resolve(params.id);
  const q = r && r.D.store.state.questions.find((x) => x.id === r.local);
  // Questions are their owner's: nobody else sees them.
  if (!q || !isOwner(req, r.D)) return fail(res, 404, "No such question");
  if (q.answered) return fail(res, 409, "Already answered");
  if (q.routine) return answerRoutineQuestion(req, res, r.D, q, b);
  // Allow + Auto (`mode`): allowed, and its thread switched to that mode; not to Full access, which needs its own pick.
  const mode = !b.skip && b.value === "allow" && q.kind === "permission" && isMode(b.mode) && b.mode !== "full" ? b.mode : null;
  await steer(req, res, r.D, "post.answer", { post: q.post, qid: q.id, ...(b.skip ? { skip: true } : { value: str(b.value, 2000) }), user: viewerName(req), ...(mode ? { mode } : {}) });
});
