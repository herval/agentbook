// Routines (routines.ts): what runs on a schedule, by itself or for a page or a thread, and its owner's OK.

import { agentPublic, postPublic } from "../policy.ts";
import { createRoutines } from "../routines.ts";
import { contributes, writeChanges } from "../../plugin/shared/pages.ts";
import { mentionNote } from "../../plugin/shared/mentions.ts";
import { allRoutines, applyRoutine, diffText, everyText, lineDiff, linkedTo, nextAt, reachAdded, reachFrom, reachText, routineDetail, routineId, routineInput, routineLinks, routineSummary, routinesOfPage, runChanges, runsPerDay, scheduleText, soundsLikeWrite, unwatched, versionOf, waiting } from "../../plugin/shared/routines.ts";
import { threadKey } from "../../plugin/shared/routine-threads.ts";
import { uuidv7 } from "../../plugin/shared/ids.ts";
import { threadCapsOf } from "../../plugin/shared/runtimes.ts";
import { digestOf, routineRunnable } from "../../plugin/shared/signed.ts";
import type { User } from "../accounts.ts";
import type { Device } from "../relay.ts";
import type { ExecArgs } from "../routines.ts";
import type { Page, PasskeySignature, Routine, RoutineCode, RoutineOkEnvelope } from "../../plugin/shared/types.ts";
import { accounts, commit, firstAdmin, log, relay, state, store } from "../core/state.ts";
import { fail, ok, readBody, route, slug, str } from "../core/http.ts";
import type { Req, Res, Viewer } from "../core/http.ts";
import type { Answer, Asker } from "../core/types.ts";
import { agentRef, deviceFor, isOwner, ownerOf, postRef, takesFolders, viewerName } from "../core/refs.ts";
import { keysOf, signingOf } from "../core/commands.ts";
import { pushLive } from "../core/services.ts";
import { SELF_URL, titleOf } from "./cli.ts";
import { pageLink, pageOr404, pageOwner, pageReachable, pageRoot, pageSeen, pageWrite, pagesSeenBy } from "./pages.ts";
import { launchId, writesPages } from "./launch.ts";

// A routine's version OK'd with its owner's passkey (the 428 its first try answered): what they signed, and the
// signature.
interface RoutineOkBody {
  signed?: { envelope?: Partial<RoutineOkEnvelope>; sig?: PasskeySignature };
}

/* ---------- routines (routines.ts): what runs on a schedule, by itself or for a page or a thread ---------- */

// A routine is its person's: whoever made it (`owner`), or its page's owner. One from before routines had one
// (moved in from a machine's own agentbook) is the first admin's, as that machine's was.
const routineOwner = (r: Partial<Pick<Routine, "owner" | "page">>) => r?.owner || (r?.page && state.pages[r.page] ? pageOwner(state.pages[r.page]) : null) || firstAdmin()?.id || null;
const routineOwnerUser = (r: Partial<Pick<Routine, "owner" | "page">>) => accounts.byId(routineOwner(r)) || null;
// A routine's detail as someone who isn't its owner gets it (a page's routines show to whoever sees the page, which
// may be public): what it is, who changed it and how its runs went, never its owner's prompt, the path on their
// machine, its code, what it reaches, or what a run printed. policy.ts keeps the same out of a page's routines;
// the detail routes come through here.
function routineShown(req: Viewer, r: Routine, d) {
  if (!d || (req.user && routineOwner(r) === req.user.id)) return d;
  const { prompt, root, runs_as, model, memo_size, change, ...rest } = d;
  return {
    ...rest,
    change: null,
    versions: (d.versions || []).map(({ v, at, by, summary, agent, live, ok, passed, from }) => ({ v, at, by, summary, agent, live, ok, passed, from })),
    runs: (d.runs || []).map(({ id, at, ok, ms, v, version, lid, post, skipped, routine, page }) => ({ id, at, ok, ms, v, version, lid, post, skipped, routine, page })),
  };
}
// The threads and launches routines.ts reads are the machines': by the page's ids, as the page knows them.
export function threadOf(id: string) {
  const p = typeof id === "string" ? postRef(id) : null;
  return p ? { ...p.s, id: p.id, agent: relay.idOf(p.D, p.s.agent) } : undefined;
}
function launchOf(id: string) {
  const r = typeof id === "string" ? relay.resolve(id) : null;
  const l = r && r.D.store.state.launches[r.local];
  return l ? { ...l, id, post: l.post ? relay.idOf(r.D, l.post) : null, agent: relay.idOf(r.D, l.agent) } : undefined;
}
const idProxy = (get) => new Proxy({}, { get: (_, id) => get(id), has: (_, id) => !!get(id) });
// The threads started on a routine from its page (routine-threads.ts), newest first: each one's launch, and the thread
// it became once it has one.
export const threadsOn = (key) => (state.routine_threads?.[key] || []).map((x) => ({ ...x, post: launchOf(x.lid)?.post || null })).reverse();
// The state routines.ts reads: the server's, with every machine's threads and launches.
export const routineState = () => ({ ...state, sessions: idProxy(threadOf), launches: idProxy(launchOf) });
// Every routine a person sees on Routines: theirs, and the ones on pages they own.
export const routinesOf = (uid: string, o?: { archived?: boolean }) => allRoutines(routineState(), routines.running, o).filter((r) => routineOwner(state.routines[r.id]) === uid);

// A run's widgets, checked as a write is, and what they'd change on the page.
function routineCheck(pid: string, out) {
  const p = state.pages[pid];
  if (!p) throw new Error("Its page is gone.");
  const w = pageWrite(p, { widgets: out.widgets });
  return { widgets: w.widgets, changes: writeChanges(p, { widgets: w.widgets }) };
}
// A run's widgets, written: a quiet version unless it said something was notable. The new version, or null.
function routineWrite(r: Routine, x) {
  const p = state.pages[r.page];
  const before = p.version;
  commit({ t: "page.write", pid: p.id, by: { routine: r.id, agent: r.agent }, widgets: x.widgets, summary: x.summary || undefined, quiet: !x.notable, ...(x.notable ? { notable: x.notable } : {}) });
  return p.version !== before ? p.version : null;
}
// A code run's line, on its thread when it's for one.
function routineLine(r: Routine, x) {
  const text = x.notable || x.summary;
  const p = r.thread && postRef(r.thread);
  if (p && text) relay.commitTo(p.D, { t: "session.update", post: p.local, text: `↻ ${r.name}: ${text}` });
}
const routineLink = (rid: string) => `${SELF_URL}/#/routines/${encodeURIComponent(rid)}`;
// Where a code routine runs: on its thread's machine, or the machine of the thread that wrote it, while it's its
// owner's; else on one of its owner's machines, the one seen last.
function routineMachine(r: Routine) {
  const owner = routineOwner(r);
  for (const id of [r?.thread, r?.by?.post]) {
    const p = id && postRef(id);
    if (p && ownerOf(p.D)?.id === owner) return p.D;
  }
  const mine = [...relay.devices.values()].filter((D) => ownerOf(D)?.id === owner);
  return mine.sort((a, b) => (b.seen || 0) - (a.seen || 0))[0] || null;
}
// The folder a code run's commands run in, on machine D: its page's, its thread's, or (none) the machine's home.
function routineRoot(page, r: Pick<Routine, "thread">, D: Device) {
  if (page) return pageRoot(page, D);
  const p = r?.thread && postRef(r.thread);
  return p && p.D === D ? p.s.cwd || p.s.root || null : null;
}
// A run of a routine's code, on its machine: what the code returned, unchecked.
async function routineExec(args: ExecArgs & { root?: string }, D: Device = routineMachine(state.routines[args.rid])) {
  if (!D) return { ok: false, error: "None of its owner's machines can run it." };
  const root = args.root || routineRoot(args.page, state.routines[args.rid], D) || undefined;
  // A machine that keeps its owner's passkeys runs a version that reaches something only with their signed OK of it.
  const okd = signingOf(D) ? okFor(args.rid, routineRunnable(args)) : null;
  const r = (await relay.command(D, "page_routine.run", { ...args, page: args.page || null, root, ...(okd ? { ok: okd } : {}) }, { by: ownerOf(D)?.username || null, wait: Math.min(330e3, (args.timeout || 60e3) + 30e3) })) as Answer;
  if (r?.queued) return { ok: false, error: `${D.name} is off, so it didn't run.` };
  return r;
}
// What an agent run is asked: which routine it is and why it runs, then its prompt.
// What a run's prompt reads of its routine: a test's stand-in has only some of it.
type PromptRoutine = Pick<Routine, "id" | "name" | "schedule"> & Partial<Pick<Routine, "page" | "thread" | "owner" | "kind" | "agent" | "links" | "live_v" | "code_v">>;
function routinePrompt(r: PromptRoutine, c, why, writes = true) {
  const o = routineOwnerUser(r);
  const owner = o?.display_name || o?.username || "The person";
  const links = routineLinks(routineState(), r);
  const pages = links.filter((l) => l.kind === "page" && state.pages[l.id]).map((l) => state.pages[l.id]);
  const threads = links.filter((l) => l.kind === "thread" && l.id !== r.thread).map((l) => postRef(l.id)).filter((t) => t && (ownerOf(t.D)?.id === routineOwner(r) || postPublic(t.s, t.agent)));
  const reason = why === "now" ? `${owner} pressed Run now.` : why === "catch-up" ? `It's a run it missed while this machine was off.` : `It runs ${scheduleText(r.schedule)}, and this is that run.`;
  const head = [
    `This is a run of the routine "${r.name}" on agentbook (${routineLink(r.id)}). ${reason}`,
    !pages.length ? "" : !writes ? `It's linked to ${pages.length === 1 ? "the page" : "the pages"} ${pages.map((p) => `"${p.title}" (${p.id})`).join(", ")}, which this run doesn't write.` : `It's linked to ${pages.length === 1 ? "the page" : "the pages"} ${pages.map((p) => `"${p.title}" (${p.id})`).join(", ")}: read ${pages.length === 1 ? "it" : "them"} with ab_page_read and update ${pages.length === 1 ? "it" : "them"} with ab_page_write: change the widgets that are there, and add none unless the prompt asks for ${pages.length === 1 ? "it" : "them"}.`,
    threads.length ? `It's linked to ${threads.length === 1 ? "the thread" : "the threads"} ${threads.map((t) => `"${titleOf(t.s).slice(0, 80)}" (${t.s.label})`).join(", ")}.` : "",
    unwatched(owner),
  ].filter(Boolean);
  return `${head.join(" ")}\n\n${c.prompt}`;
}
// An agent run, started on its agent's machine, as its owner's doing (they made the routine, or OK'd it). For a
// thread: a message to it (steering it, or waking it when it's idle), or resuming it when it ended. Otherwise a new
// session, the way the composer starts one, marked with its routine.
async function routineLaunch(r: Routine, c, why) {
  const routine = { id: r.id, name: r.name };
  const by = routineOwnerUser(r)?.username || null;
  // To a machine that keeps its owner's passkeys, a run is its signed OK and the prompt it covers, and the machine
  // says the rest itself (gate.ts): what reaches its agent is only what they signed.
  const signedRun = (D) => {
    if (!signingOf(D)) return null;
    const okd = okFor(r.id, routineRunnable(c));
    if (!okd) throw new Error(`${D.name} runs it only once you've signed its OK: Sign it on the routine.`);
    return { prompt: c.prompt, routine: { ...routine, why }, ok: okd };
  };
  if (r.thread) {
    const p = postRef(r.thread);
    if (!p) throw new Error("Its thread is gone.");
    if (ownerOf(p.D)?.id !== routineOwner(r)) throw new Error(`Its thread isn't ${by || "its owner"}'s.`);
    if (p.s.state === "done" && (!p.s.session_id || !threadCapsOf(p.s).resumes)) throw new Error("Its thread has ended, and agentbook can't resume it.");
    const sr = signedRun(p.D);
    const x = (await relay.command(p.D, "post.deliver", sr ? { post: p.local, text: sr.prompt, routine: sr.routine, ok: sr.ok } : { post: p.local, text: routinePrompt(r, c, why), routine }, { by, wait: 60e3 })) as Answer;
    if (x?.error) throw new Error(x.error);
    return { post: p.id, ...(x?.lid ? { lid: relay.idOf(p.D, x.lid) } : {}) };
  }
  const a = agentRef(c.agent || r.agent || "");
  if (!a) throw new Error(`There's no agent "${c.agent || r.agent || "claude"}" to run it.`);
  if (ownerOf(a.D)?.id !== routineOwner(r)) throw new Error(`${a.a.name} isn't ${by || "its owner"}'s agent.`);
  const inactive = relay.startError(a.D, "post.start", { agent: a.local });
  if (inactive) throw new Error(inactive.error);
  // The pages it's linked to: its run starts from the first, and may write each. An agent that doesn't have agentbook's
  // tools (a cloud agent, say) runs all the same, as a run that isn't for a page: the link is where the routine
  // shows, its agent contributes to nothing, and its prompt says the run doesn't write the page.
  const writes = writesPages(a.a.kind);
  const pages = !writes ? [] : routineLinks(routineState(), r).filter((l) => l.kind === "page" && state.pages[l.id] && !state.pages[l.id].archived).map((l) => state.pages[l.id]);
  const page = pages[0];
  // A run makes its agent a contributor of each linked page, so only pages the routine's owner owns are written to
  // (a page the owner already made this agent a contributor of works too); a linked page they don't own is read-only.
  for (const p of pages) if (!contributes(p, { agent: a.id }) && pageOwner(p) === routineOwner(r)) commit({ t: "page.contributor", pid: p.id, who: { agent: a.id }, by: null });
  const lid = launchId();
  const sr = signedRun(a.D);
  const prompt = sr ? sr.prompt : routinePrompt(r, c, why, writes);
  const args: Record<string, unknown> = sr ? { lid, agent: a.local, prompt, routine: sr.routine, ok: sr.ok } : { lid, agent: a.local, prompt, routine };
  // Its folder, or its page's, or the machine's home (its gate decides, as for any start); none for an agent that
  // works in its own workspace (OpenClaw's), as the composer sends none.
  const root = !takesFolders(a.D, a.local) ? null : c.root || (page ? null : relay.infoOf(a.D).machine?.home || null);
  if (root) args.root = root;
  if (page) {
    args.page = page.id;
    const pr = !root && pageRoot(page.id, a.D);
    if (pr) args.page_root = pr;
  }
  if (c.model) args.model = c.model;
  const note = sr ? null : mentionNote(prompt, pagesSeenBy(routineOwnerUser(r)));
  if (note) args.note = note;
  const x = (await relay.command(a.D, "post.start", args, { by, wait: 60e3 })) as Answer;
  if (x?.error) throw new Error(x.error);
  return { lid: relay.idOf(a.D, x?.lid || lid) };
}
// Why an agent routine can't run now: its last run is still starting or working, or its thread is busy.
function routineBusy(r: Routine) {
  if (r.kind !== "agent") return null;
  if (r.thread) {
    const p = postRef(r.thread);
    return p && p.s.state !== "done" && (p.s.busy || p.s.state === "working") ? "its thread was working" : null;
  }
  const code = versionOf(state, r.id, r.live_v);
  const agent = agentRef(code?.agent || r.agent || "");
  if (agent?.a.hidden) return `${agent.a.name} was deactivated`;
  if (!r.last?.lid) return null;
  const l = launchOf(r.last.lid);
  const fresh = (at) => Date.now() - Date.parse(at) < 10 * 60e3;
  // A start still on its way to a machine that's off is starting too.
  if (!l) return fresh(r.last.at) ? "its last run was still starting" : null;
  if (l.error) return null;
  const s = l.post && postRef(l.post)?.s;
  if (!s) return fresh(l.at) ? "its last run was still starting" : null;
  if (s.state === "done") return null;
  return s.state === "waiting" ? "its last run was waiting for you" : s.busy || s.state === "working" ? "its last run was still working" : null;
}
// Routines deleted before removing archived them (2026-11-01): rebuilt from the log, as it still has their ops, and
// put back archived, so Routines lists them under Archived to restore. Once, as each comes back.
export function unremoveRoutines() {
  for (const gone of store.tables.opsWith('"t":"routine.remove"')) {
    const { rid } = gone.op;
    if (!rid || state.routines[rid]) continue;
    const scratch = { routines: {}, routine_code: [], routine_runs: [] };
    for (const row of store.tables.opsWith(`"rid":${JSON.stringify(rid)}`)) {
      if (row.seq >= gone.seq) break;
      const { op } = row;
      if (op.rid === rid && String(op.t).startsWith("routine.")) applyRoutine(scratch, op, op.at || row.at);
    }
    const r = scratch.routines[rid];
    if (!r) continue;
    commit({ t: "routine.restore", rid, snapshot: { routine: r, code: scratch.routine_code, runs: scratch.routine_runs }, archived: { at: gone.at, by: null } });
    log(`routine ${rid}: deleted ${gone.at}, back as archived`);
  }
}
export const routines = createRoutines({ state, threadOf, commit, exec: (args) => routineExec(args), checkWrite: routineCheck, writePage: routineWrite, postLine: routineLine, launch: routineLaunch, busy: routineBusy, log });
// An OK, a switch turned on: whatever is due now runs without waiting for the next tick.
store.onChange((op) => {
  if (["routine.ok", "routine.on"].includes(op.t)) setTimeout(routines.tick, 100).unref?.();
});

// A test run as an agent reads it, and as a version keeps it (without the widgets' data).
const testKept = (t) => t && { at: t.at, ok: t.ok, ms: t.ms, error: t.error ? t.error.slice(0, 1000) : null, summary: t.summary, ask: t.ask, changes: (t.changes || []).slice(0, 30).map(({ id, w, kind, from, to, text }) => ({ id, w, kind, from, to, text })) };
const changeWords = (c) => `${c.w}${c.from != null && c.to != null ? ` (${c.from} → ${c.to})` : c.text ? ` (${c.text})` : ""}`;
function testWords(t) {
  if (!t) return "It hasn't run yet.";
  if (!t.ok) return `Its test run failed after ${t.ms < 1000 ? `${t.ms} ms` : `${(t.ms / 1000).toFixed(1)} s`}: ${t.error}`;
  const ch = (t.changes || []).filter((c) => c.id);
  if (!t.changes && t.summary) return `Its test run worked: ${t.ms < 1000 ? `${t.ms} ms` : `${(t.ms / 1000).toFixed(1)} s`}. It said: ${t.summary}`;
  return `Its test run worked: ${t.ms < 1000 ? `${t.ms} ms` : `${(t.ms / 1000).toFixed(1)} s`}. ${ch.length ? `It would change ${ch.slice(0, 6).map(changeWords).join("; ")}${ch.length > 6 ? `, and ${ch.length - 6} more` : ""}.` : t.summary ? `It said: ${t.summary}` : "It would change nothing on the page as it is."}`;
}
// Where a routine is, in words: " on Reliability: ledger", " in “Fix the flaky test”", or "".
const routineWhere = (r: Routine) => {
  const l = routineLinks(routineState(), r).find((x) => (x.kind === "page" && state.pages[x.id]) || (x.kind === "thread" && postRef(x.id)));
  return !l ? "" : l.kind === "page" ? ` on ${state.pages[l.id].title}` : ` in “${titleOf(postRef(l.id).s).slice(0, 60)}”`;
};

// The OK for the version of a routine that waits for one: a question on the post that wrote it (so it's in Needs
// you), which the routine's own buttons answer too. Its first option uses the version. It's the server's own
// question, asked on the post where the post's machine keeps the rest.
function askRoutineOk(rid: string, post: string) {
  const r = state.routines[rid];
  const c = r && waiting(state, r);
  const pr = post && postRef(post);
  if (!c || !pr) return null;
  const live = versionOf(state, rid, r.live_v);
  const yes = live ? `Use v${c.v}` : "Turn it on";
  const no = live ? `Keep v${live.v}` : "Not now";
  const title = live ? `Use v${c.v} of “${r.name}”${routineWhere(r)}?` : `Run “${r.name}”${routineWhere(r)} ${scheduleText(r.schedule)}?`;
  const ask = (detail, preview) => relay.commitTo(pr.D, { t: "question.ask", post: pr.local, qid: uuidv7(), kind: "approve", title, detail, preview, options: [{ label: yes, detail: null }, { label: no, detail: null }], key: `routine:${rid}`, routine: { rid, v: c.v, yes } });
  if (r.kind === "agent") {
    const who = agentRef(c.agent || r.agent)?.a.name || c.agent || "an agent";
    const perDay = runsPerDay(r.schedule);
    const also = runChanges(live, c);
    const detail = [
      c.summary ? `“${c.summary}”` : "",
      live ? (also.length ? `It also ${also.join(", ")}.` : "") : `${who} runs this prompt ${scheduleText(r.schedule)}${r.thread ? ", as a message to the thread" : r.page ? ", each time in a new thread from the page" : ", each time in a new thread"}${c.root ? `, in ${c.root.replace(/^\/(Users|home)\/[^/]+/, "~")}` : ""}${c.model ? `, with ${c.model}` : ""}.`,
      perDay >= 1 ? `That's about ${Math.round(perDay)} model ${Math.round(perDay) === 1 ? "run" : "runs"} a day.` : "",
      live ? `v${live.v} keeps running until you choose.` : "",
    ].filter(Boolean).join(" ");
    return ask(detail, live ? diffText(lineDiff(live.prompt, c.prompt)) : c.prompt.slice(0, 6000));
  }
  const added = live ? reachAdded(live.reach, c.reach) : [];
  const writes = reachFrom(c.reach).tools.filter(soundsLikeWrite);
  const writer = agentRef(r.agent)?.a.name || "an agent";
  const detail = [
    c.summary ? `“${c.summary}”` : "",
    live ? "" : r.page ? `Code ${writer} wrote, that keeps ${r.keeps.length === 1 ? "1 widget" : `${r.keeps.length} widgets`} up to date ${everyText(r.schedule)}, with no model.` : `Code ${writer} wrote, that runs ${scheduleText(r.schedule)}, with no model.`,
    `It reaches ${reachText(c.reach)}.`,
    added.length ? `New: ${added.join(", ")}.` : "",
    writes.length ? `${writes.join(", ")} may change things, by the sound of ${writes.length === 1 ? "its name" : "their names"}.` : "",
    testWords(c.test),
    live ? `v${live.v} keeps running until you choose.` : "",
  ].filter(Boolean).join(" ");
  return ask(detail, live ? diffText(lineDiff(live.code, c.code)) : c.code.slice(0, 6000));
}
// --- a routine's OK, signed ---
// Whether someone's machines take only what their passkeys sign: then their OK of a routine's version is signed
// too, and its runs carry it.
const ownerSigns = (uid: string) => [...relay.devices.values()].some((D) => ownerOf(D)?.id === uid && signingOf(D));
// What its owner's passkey signs to use version c of routine r (`use`), or to keep the one that runs.
function okEnvelope(r: Routine, c: RoutineCode, use: boolean): RoutineOkEnvelope {
  const pages = r.kind === "agent" ? routineLinks(routineState(), r).filter((l) => l.kind === "page" && state.pages[l.id]).map((l) => ({ id: l.id, title: str(state.pages[l.id].title, 120) })) : [];
  const root = r.kind === "agent" ? routineRootOf(r, c) : null;
  return { v: 1, kind: "routine.ok", rid: r.id, version: c.v, name: str(r.name, 200), use: !!use, hash: digestOf(routineRunnable(c)), ...(root ? { root } : {}), ...(pages.length ? { pages } : {}) };
}
// The folder an agent routine's version runs in: none for an agent that works in its own workspace, whatever the
// version says (one an OpenClaw thread wrote kept that workspace's path on the gateway's machine).
function routineRootOf(r: Routine, c) {
  const a = c.root ? agentRef(c.agent || r.agent || "") : null;
  return a && !takesFolders(a.D, a.local) ? null : c.root || null;
}
// Before an OK: null when its owner's machines take it unsigned, the signed OK, or false once it answered with
// 428 and what to sign, or why the signature won't do.
function okOr428(req: Viewer, res: Res, r: Routine, c: RoutineCode, use: boolean, b: RoutineOkBody | null) {
  if (!ownerSigns(req.user.id)) return null;
  const want = okEnvelope(r, c, use);
  if (!b?.signed) {
    fail(res, 428, use ? "OK it with your passkey: your machines run only what you OK'd." : "Keep the version that runs, with your passkey.", { sign: want, keys: keysOf(req.user.id) });
    return false;
  }
  const e = b.signed.envelope;
  if (e?.kind !== "routine.ok" || e.rid !== want.rid || e.version !== want.version || e.use !== want.use || e.hash !== want.hash) {
    fail(res, 400, "That's signed for another version of it.");
    return false;
  }
  // What matters of it is checked above; the passkey signed it whole.
  return { envelope: e as RoutineOkEnvelope, sig: b.signed.sig };
}
// The signed OK of the version a run is (by its code and reach, or its prompt), for a machine that keeps its owner's keys.
function okFor(rid: string, runnable) {
  const hash = digestOf(runnable);
  return state.routine_code.filter((c) => c.routine === rid && c.ok?.signed?.envelope?.hash === hash).pop()?.ok.signed || null;
}
// Use a version, or keep the one that runs: through its open question when there is one, so the post and Needs
// you see it answered too. `signed`: what its owner's passkey signed of it.
function routineOk(rid: string, v, use, user, signed = null) {
  for (const D of relay.devices.values()) {
    const q = D.store.state.questions.find((x) => !x.answered && x.routine?.rid === rid && x.routine.v === v);
    if (q) return settleRoutineQuestion(D, q, use ? q.routine.yes : q.options.find((o) => o.label !== q.routine.yes)?.label || "No", user, signed);
  }
  commit({ t: "routine.ok", rid, v, use, by: { user }, ...(signed ? { signed } : {}) });
}
// The answer to a routine's question: the routine uses the version or keeps the one that runs, the question closes
// on its post, and the post's agent hears it: from a machine that keeps its owner's keys, as what they signed says.
function settleRoutineQuestion(D: Device, q, value, user, signed = null) {
  D.store.commit({ t: "question.answer", qid: q.id, value, by: "human", user });
  commit({ t: "routine.ok", rid: q.routine.rid, v: q.routine.v, use: value === q.routine.yes, by: { user }, ...(signed ? { signed } : {}) });
  const signs = !!signingOf(D);
  if (signs && !signed) return;
  relay.command(D, "post.notify", { post: q.post, event: { type: "answer", question_id: relay.idOf(D, q.id), key: q.key, question: q.title, value, by: "human" }, ...(signs ? { ok: signed } : {}) }, { by: ownerOf(D)?.username || null, wait: 0 }).catch(() => {});
}
export async function answerRoutineQuestion(req: Viewer, res: Res, D: Device, q, b) {
  if (b.skip) {
    D.store.commit({ t: "question.answer", qid: q.id, value: null, by: "skipped" });
    return ok(res);
  }
  const value = str(b.value, 2000);
  const r = state.routines[q.routine.rid];
  const c = r && versionOf(state, r.id, q.routine.v);
  const signed = r && c ? okOr428(req, res, r, c, value === q.routine.yes, b) : null;
  if (signed === false) return;
  settleRoutineQuestion(D, q, value, viewerName(req), signed);
  ok(res);
}

// A routine this request may see, run ("edit") or change ("manage"): a page's as its page allows, the rest only
// for its owner. The routine, or a 404 or 403 sent.
export function routineOr404(req: Viewer, res: Res, rid: string, need = "see", pid: string | null = null) {
  const r = state.routines[rid];
  if (!r || (pid && r.page !== pid && !linkedTo(routineState(), r, "page", pid))) return void fail(res, 404, pid ? "No such routine on this page." : "No such routine.");
  if (r.page) return pageOr404(req, res, r.page, need) ? r : null;
  if (!req.user || routineOwner(r) !== req.user.id) return void fail(res, 404, "No such routine.");
  return r;
}
// What its owner does to one: switch it, run it, OK a version, remove it.
const routineActs: Record<string, (req: Req, res: Res, r: Routine) => unknown> = {
  on: async (req, res, r) => {
    commit({ t: "routine.on", rid: r.id, on: !!(await readBody<{ on?: boolean }>(req)).on });
    ok(res);
  },
  run: (req, res, r) => {
    if (!r.live_v) return fail(res, 409, "No version of it has been OK'd yet.");
    if (routines.running.has(r.id)) return fail(res, 409, "It's running now.");
    const busy = routines.busy(r);
    if (busy) return fail(res, 409, `It can't run now: ${busy.replace(/ was /, " is ")}.`);
    routines.run(r.id, "now").catch((e) => log(`routine ${r.id}: ${e.message}`));
    setTimeout(pushLive, 50);
    ok(res, { started: true });
  },
  ok: async (req, res, r) => {
    const b = await readBody<RoutineOkBody & { v?: number; use?: boolean }>(req);
    const c = waiting(state, r);
    if (!c || c.v !== Number(b.v)) return fail(res, 409, "That version doesn't wait for an OK any more.");
    const signed = okOr428(req, res, r, c, !!b.use, b);
    if (signed === false) return;
    routineOk(r.id, c.v, !!b.use, viewerName(req), signed);
    ok(res, { live_v: state.routines[r.id]?.live_v });
  },
  // Sign the version that runs, OK'd before your machines kept your passkeys: its runs carry it from now on.
  sign: async (req, res, r) => {
    const b = await readBody<RoutineOkBody>(req);
    const c = versionOf(state, r.id, r.live_v);
    if (!c?.ok) return fail(res, 409, "No version of it has been OK'd yet.");
    if (!ownerSigns(req.user.id)) return fail(res, 409, "None of your machines keeps your passkeys, so it runs as it is.");
    const signed = okOr428(req, res, r, c, true, b);
    if (!signed) return;
    commit({ t: "routine.signed", rid: r.id, v: c.v, signed });
    ok(res, { signed: true });
  },
  // Its page asked an agent to fix it: `launch` is what /api/launch answered. Its page shows that thread, and what
  // stopped it.
  fix: async (req, res, r) => {
    const b = await readBody<{ launch?: string; agent?: string }>(req);
    const launch = str(b.launch, 200);
    if (!launch) return fail(res, 400, "Say which launch it went out as.");
    commit({ t: "routine.fix", rid: r.id, lid: launch, agent: b.agent ? str(b.agent, 200) : null });
    ok(res);
  },
  remove: (req, res, r) => {
    archiveRoutine(r, { user: viewerName(req) });
    ok(res, { archived: true });
  },
  // Back from the archive, as it was: on or paused, the version it ran, its memo and runs.
  restore: (req, res, r) => {
    const why = unarchivable(r);
    if (why) return fail(res, 409, why);
    commit({ t: "routine.restore", rid: r.id, by: { user: viewerName(req) } });
    ok(res, routineSummary(routineState(), state.routines[r.id], routines.running));
  },
};
// Removing archives a routine: it stops running and leaves the lists, and Restore puts it back. An OK it still asked
// for is answered "removed"; its version stays, to OK on its page once it's back.
function archiveRoutine(r: Routine, by) {
  for (const D of relay.devices.values()) for (const q of D.store.state.questions) if (!q.answered && q.routine?.rid === r.id) D.store.commit({ t: "question.answer", qid: q.id, value: null, by: "removed" });
  commit({ t: "routine.archive", rid: r.id, by });
}
// Why it can't come back now, if it can't: it isn't archived, or another routine keeps its widgets since.
function unarchivable(r: Routine) {
  if (!r.archived) return `"${r.name}" isn't archived.`;
  const other = r.page && Object.values(state.routines).find((x) => !x.archived && x.page === r.page && x.id !== r.id && x.keeps.some((wid) => r.keeps.includes(wid)));
  return other ? `"${other.name}" keeps ${other.keeps.filter((wid) => r.keeps.includes(wid)).join(", ")} now. Two routines can't keep the same widget: remove that one first.` : null;
}
const ACT_NEEDS = { on: "manage", run: "edit", ok: "manage", sign: "manage", fix: "edit", remove: "manage", restore: "manage" };

// --- you, from Routines and a page's Routines tab ---
route("GET", "/api/routines", (req, res) => {
  if (!req.user) return fail(res, 401, "Sign in first.");
  ok(res, { routines: routinesOf(req.user.id, { archived: true }) });
});
route("GET", "/api/routines/:rid", (req, res, { params }) => {
  const r = routineOr404(req, res, params.rid);
  if (r) ok(res, { ...routineShown(req, r, routineDetail(routineState(), r.id, routines.running, { runs: 200 })), threads: threadsOn(threadKey(null, r.id)) });
});
// The agent an owner names for a routine: one the page knows that's theirs, or one by name on their first machine.
export function ownersAgent(req: Viewer, x) {
  const known = agentRef(String(x));
  if (known) return isOwner(req, known.D) ? known.id : null;
  const D = deviceFor(req);
  return D && D.store.state.agents[slug(x)] ? relay.idOf(D, slug(x)) : null;
}
// Make an agent routine, or change one, as its owner: it runs as you made it, with no OK to wait for. `links`: the
// agents, pages and threads it's linked to; `thread`: the one its runs continue (null: a new thread each run).
// The older `page` is a link to that page.
async function ownerWritesRoutine(req: Req, res: Res, r: Routine | null) {
  const b = await readBody<RoutineOkBody & { kind?: string; code?: unknown; reach?: unknown; links?: unknown[]; page?: string; thread?: string | null; [field: string]: unknown }>(req);
  const user = viewerName(req);
  // The same request again with its OK signed (the 428 the first one answered): the routine the first one made.
  const made = !r && b.signed?.envelope?.kind === "routine.ok" ? state.routines[b.signed.envelope.rid] : null;
  if (made && routineOwner(made) === req.user.id) r = made;
  if (!r && b.kind === "code") return fail(res, 400, "Code routines are written by agents, with ab_routine_write.");
  if (r?.archived) return fail(res, 409, `"${r.name}" is archived. Restore it first.`);
  if (r && r.kind !== "agent" && (b.code != null || b.reach != null)) return fail(res, 400, "A code routine's code is its agent's to change, with ab_routine_write.");
  let input;
  try {
    const links = b.links != null || b.page ? [...(b.links || []), ...(b.page ? [{ kind: "page", id: b.page }] : [])] : undefined;
    input = routineInput({ ...b, links, kind: r ? undefined : "agent" }, r || null, { page: r?.page || null, user: true });
  } catch (e) {
    return fail(res, 400, e.message);
  }
  for (const l of input.links || []) {
    if (l.kind === "page" && !pageSeen(req, l.id)) return fail(res, 404, `There's no page "${l.id}".`);
    // A thread or an agent they may see: a linked thread's title goes into each run's prompt.
    const t = l.kind === "thread" && postRef(l.id);
    const a = l.kind === "agent" && agentRef(l.id);
    if (l.kind === "thread" && !(t && (isOwner(req, t.D) || postPublic(t.s, t.agent)))) return fail(res, 404, "No such thread.");
    if (l.kind === "agent" && !(a && (isOwner(req, a.D) || agentPublic(a.a)))) return fail(res, 400, `There's no agent "${l.id}".`);
  }
  const thread = b.thread !== undefined ? (b.thread ? str(b.thread, 300) : null) : undefined;
  if (thread) {
    const p = postRef(thread);
    if (!p || !isOwner(req, p.D)) return fail(res, 404, "No such thread.");
  }
  // The thread its runs continue is one it's linked to.
  if (thread) input.links = [...(input.links || r?.links || []).filter((l) => !(l.kind === "thread" && l.id === thread)), { kind: "thread", id: thread }];
  if (input.agent) {
    const id = ownersAgent(req, input.agent);
    if (!id) return fail(res, 400, `There's no agent "${input.agent}" of yours.`);
    input.agent = id;
  }
  const rid = r?.id || routineId(input.name, (id) => !!state.routines[id]);
  const before = r?.code_v || 0;
  const agent = r ? undefined : input.agent || ownersAgent(req, "claude");
  commit({ t: "routine.write", rid, page: r ? undefined : null, ...(thread !== undefined ? { thread } : {}), by: r ? undefined : { user }, ...(r ? {} : { owner: req.user.id }), ...input, ...(r ? {} : { agent }) });
  const x = state.routines[rid];
  if (!x) return fail(res, 400, "That routine couldn't be made.");
  // What its owner writes is OK'd as they write it: signed, when their machines keep their passkeys (the same
  // request again, with the signature, OKs the version the first one made).
  const c = versionOf(state, rid, x.code_v);
  if (c && !c.ok && !c.passed && (x.code_v !== before || b.signed)) {
    const signed = okOr428(req, res, x, c, true, b);
    if (signed === false) return;
    commit({ t: "routine.ok", rid, v: x.code_v, use: true, by: { user }, ...(signed ? { signed } : {}) });
  }
  ok(res, routineSummary(routineState(), state.routines[rid], routines.running));
}
route("POST", "/api/routines", (req, res) => {
  if (!req.user) return fail(res, 401, "Sign in first.");
  return ownerWritesRoutine(req, res, null);
});
route("POST", "/api/routines/:rid", (req, res, { params }) => {
  const r = routineOr404(req, res, params.rid, "manage");
  if (r) return ownerWritesRoutine(req, res, r);
});
for (const act of Object.keys(routineActs)) {
  // An archived routine only comes back: Restore, before anything else.
  const act1 = (req, res, r) => (r.archived && act !== "restore" ? fail(res, 409, `"${r.name}" is archived. Restore it first.`) : routineActs[act](req, res, r));
  route("POST", `/api/routines/:rid/${act}`, (req, res, { params }) => {
    const r = routineOr404(req, res, params.rid, ACT_NEEDS[act]);
    if (r) return act1(req, res, r);
  });
  route("POST", `/api/pages/:id/routines/:rid/${act}`, (req, res, { params }) => {
    const r = routineOr404(req, res, params.rid, ACT_NEEDS[act], params.id);
    if (r) return act1(req, res, r);
  });
}
route("GET", "/api/pages/:id/routines", (req, res, { params }) => {
  if (!pageOr404(req, res, params.id)) return;
  const st = routineState();
  ok(res, { routines: Object.values(state.routines).filter((r) => !r.archived && (r.page === params.id || linkedTo(st, r, "page", params.id))).sort((a, b) => a.created.localeCompare(b.created)).map((r) => routineShown(req, r, routineDetail(st, r.id, routines.running))) });
});
route("GET", "/api/pages/:id/routines/:rid", (req, res, { params }) => {
  const r = routineOr404(req, res, params.rid, "see", params.id);
  if (r) ok(res, routineShown(req, r, routineDetail(routineState(), r.id, routines.running, { runs: 200 })));
});

// --- agents, through their machine (ab_routine_read, ab_routine_write) ---
// One routine as an agent reads it: its code or prompt, the version waiting, and its last 10 runs with their logs.
function routineForAgent(rid: string) {
  const d = routineDetail(routineState(), rid, routines.running, { runs: 10 });
  const live = d.versions.find((c) => c.live);
  const newest = d.versions[0];
  const runs = d.runs.map(({ log: l, ...x }) => ({ ...x, log: l ? l.slice(-2000) : "" }));
  if (d.kind === "agent") return { ...d, versions: undefined, runs, prompt: newest?.prompt, agent: newest?.agent, root: newest?.root, model: newest?.model, code_v: newest?.v, running_prompt: live && live.v !== newest?.v ? live.prompt : undefined };
  return { ...d, versions: undefined, runs, code: newest?.code, code_v: newest?.v, reach: newest?.reach, running_code: live && live.v !== newest?.v ? live.code : undefined };
}
// A page's routines (`id`), or, without one, the ones an agent sees: the ones it wrote, the ones that run as it,
// and its thread's. `one`: one routine.
export function routinesReadForAgent(o: User, me: Asker, id: string, one) {
  if (id) {
    const p = state.pages[id];
    if (!p || !pageReachable(p, o)) return { error: `No page "${id}". ab_page_list lists them.`, status: 404 };
    if (one) {
      if (state.routines[one]?.page !== p.id) return { error: `No routine "${one}" on "${p.title}". Leave routine out to list them.`, status: 404 };
      return routineForAgent(one);
    }
    return { page: p.id, routines: routinesOfPage(routineState(), p.id, routines.running) };
  }
  const yours = (r) => routineOwner(state.routines[r.id]) === o.id;
  if (one) {
    if (!state.routines[one] || !yours({ id: one })) return { error: `No routine "${one}". Leave routine out to list the ones you can see.`, status: 404 };
    return routineForAgent(one);
  }
  const agent = me.agent;
  return { routines: routinesOf(o.id).filter((r) => r.agent === agent || r.runs_as === agent || r.links.some((l) => (l.kind === "thread" && l.id === me.post) || (l.kind === "agent" && l.id === agent)) || r.by?.post === me.post) };
}
// An agent makes or changes a routine: for a page it contributes to, for a thread (its own: "this"), or by itself.
// A test runs code once (on its machine, where its MCP servers are), or shows an agent routine's prompt as it would
// be sent; a save waits for the owner's OK.
// An agent removes a routine it wrote, when its person asks, or puts it back: one it made or wrote a version of, its
// person's. One someone else wrote stays theirs, or the person's on agentbook. Removing archives it (archiveRoutine),
// so a restore brings it back as it was.
function routineArchiveForAgent(o: User, me: Asker, p: Page, b) {
  const rid = b.routine ? str(b.routine, 60) : "";
  const verb = b.restore ? "restore" : "remove";
  if (!rid) return { error: `Say which routine to ${verb}: its id (ab_routine_read lists them).`, status: 400 };
  const r = state.routines[rid];
  if (!r || routineOwner(r) !== o.id || (p && r.page !== p.id)) return { error: `No routine "${rid}"${p ? ` on "${p.title}"` : ""}. ab_routine_read lists them.`, status: 404 };
  const where = r.page ? `${pageLink(r.page)}/routines` : routineLink(r.id);
  if (!me.agent || !(r.by?.agent === me.agent || state.routine_code.some((c) => c.routine === r.id && c.by?.agent === me.agent))) {
    const who = r.by?.agent ? agentRef(r.by.agent)?.a.name || "another agent" : r.by?.user ? `@${r.by.user}` : "someone else";
    return { error: `"${r.name}" isn't one you wrote (${who} made it), so you can't ${verb} it. ${o.display_name || o.username} does, on agentbook: ${b.restore ? `${routineLink(r.id)}, with Restore` : `${where}, under "Remove it"`}.`, status: 403 };
  }
  if (b.restore) {
    const why = unarchivable(r);
    if (why) return { error: why, status: 409 };
    commit({ t: "routine.restore", rid: r.id, by: { agent: me.agent, post: me.post } });
    const x = state.routines[r.id];
    return { restored: r.id, name: r.name, page: r.page, every: scheduleText(x.schedule), on: x.on, live_v: x.live_v, next: nextAt(x) ? new Date(nextAt(x)).toISOString() : null, url: routineLink(r.id) };
  }
  if (r.archived) return { error: `"${r.name}" is archived already. To put it back: routine and restore: true.`, status: 409 };
  archiveRoutine(r, { agent: me.agent, post: me.post });
  return { removed: r.id, name: r.name, kind: r.kind, page: r.page, keeps: r.keeps || [], url: routineLink(r.id) };
}
export async function routinesWriteForAgent(D: Device, o: User, me: Asker, pid: string, b) {
  const agent = me.agent;
  const post = me.post;
  const p = pid ? state.pages[pid] : null;
  if (pid && (!p || !pageReachable(p, o))) return { error: `No page "${pid}". ab_page_list lists them.`, status: 404 };
  if (b.remove || b.restore) return routineArchiveForAgent(o, me, p, b);
  if (p && !contributes(p, { agent })) return { error: `${agentRef(agent)?.a.name || "This agent"} isn't a contributor of "${p.title}". Its owner adds contributors on the page's Contributors tab.`, status: 403 };
  if (p?.archived) return { error: `"${p.title}" is archived.`, status: 400 };
  if (p?.kind === "dashboard") return { error: `"${p.title}" is a dashboard: its panels run their own queries whenever someone looks, so it needs no routine. ab_dashboard_write gives a panel its query.`, status: 400 };
  const name = str(b.name, 80).trim().toLowerCase();
  const threadAsked = b.thread === "this" ? post : b.thread ? str(b.thread, 300) : null;
  if (threadAsked && (!postRef(threadAsked) || ownerOf(postRef(threadAsked).D)?.id !== o.id)) return { error: `No thread "${b.thread}". Use thread: "this" for your own.`, status: 404 };
  const mine = (x) => !x.archived && (p ? x.page === p.id : !x.page && (x.thread || null) === threadAsked && (x.by?.agent === agent || x.agent === agent));
  let r = b.routine ? state.routines[str(b.routine, 60)] : name ? Object.values(state.routines).find((x) => mine(x) && x.name.toLowerCase() === name) : null;
  // One of theirs on another page, or on none: say where, rather than that it isn't there.
  if (b.routine && r && routineOwner(r) === o.id && (p ? r.page !== p.id : r.page)) return { error: `"${r.name}" is ${r.page ? `on the page "${state.pages[r.page]?.title || r.page}": send page: "${r.page}" with it` : "on no page: leave page out"}.`, status: 404 };
  if (b.routine && (!r || routineOwner(r) !== o.id)) return { error: `No routine "${b.routine}"${p ? ` on "${p.title}"` : ""}. ab_routine_read lists them; leave routine out to make one.`, status: 404 };
  if (r?.archived) return { error: `"${r.name}" is archived. Put it back first (routine and restore: true), or leave routine out to make a new one.`, status: 409 };
  let input;
  try {
    input = routineInput(b, r, { page: p?.id || null });
  } catch (e) {
    return { error: e.message, status: 400 };
  }
  const kind = r?.kind || input.kind;
  const thread = r ? r.thread : threadAsked;
  // Its links: "this" is your thread. Each must be one its person has.
  if (input.links) {
    input.links = input.links.map((l) => (l.kind === "thread" && l.id === "this" ? { ...l, id: post } : l));
    for (const l of input.links) {
      if (l.kind === "page" && !(state.pages[l.id] && pageReachable(state.pages[l.id], o))) return { error: `No page "${l.id}" to link. ab_page_list lists them.`, status: 404 };
      if (l.kind === "thread" && !(postRef(l.id) && ownerOf(postRef(l.id).D)?.id === o.id)) return { error: `No thread "${l.id}" to link. Use "this" for yours.`, status: 404 };
      if (l.kind === "agent" && !(agentRef(l.id) && ownerOf(agentRef(l.id).D)?.id === o.id)) return { error: `No agent "${l.id}" to link.`, status: 404 };
    }
  }
  // An agent named the way its machine names it ("codex") is that machine's.
  const agentOf = (x) => (agentRef(x) && ownerOf(agentRef(x).D)?.id === o.id ? agentRef(x).id : D.store.state.agents[slug(x)] ? relay.idOf(D, slug(x)) : null);
  let code = null;
  let reach = null;
  let keeps = [];
  if (kind === "agent") {
    // Who runs it and where: you, in your folder, unless it says.
    if (!r) {
      input.agent = input.agent ? agentOf(input.agent) : agent;
      if (input.root === undefined) {
        const p = thread ? null : postRef(post);
        input.root = p && takesFolders(p.D, p.s.agent) ? p.s.cwd || p.s.root || null : null;
      }
    } else if (input.agent) input.agent = agentOf(input.agent);
    if (input.agent === null) return { error: `There's no agent "${b.agent}" here.`, status: 400 };
    const newest = r && versionOf(state, r.id, r.code_v);
    const version = { prompt: input.prompt ?? newest?.prompt, agent: input.agent !== undefined ? input.agent : newest?.agent, root: input.root !== undefined ? input.root : newest?.root, model: input.model !== undefined ? input.model : newest?.model };
    if (b.test) {
      const fake = { id: r?.id || routineId(input.name || r?.name, (id) => !!state.routines[id]), name: input.name || r.name, page: p?.id || null, thread, owner: o.id, schedule: input.schedule || r.schedule };
      return { test: { agent_test: true, prompt: routinePrompt(fake, version, "schedule", writesPages(agentRef(version.agent)?.a.kind)), runs_as: agentRef(version.agent)?.a.name || version.agent, root: version.root, when: scheduleText(fake.schedule), per_day: runsPerDay(fake.schedule) } };
    }
  } else {
    keeps = input.keeps || r?.keeps || [];
    if (p) {
      const other = Object.values(state.routines).find((x) => !x.archived && x.page === p.id && x.id !== r?.id && x.keeps.some((wid) => keeps.includes(wid)));
      if (other) return { error: `"${other.name}" keeps ${other.keeps.filter((wid) => keeps.includes(wid)).join(", ")} already. Two routines can't keep the same widget.`, status: 400 };
    }
    const newest = r && versionOf(state, r.id, r.code_v);
    code = input.code ?? newest?.code;
    reach = input.reach ?? newest?.reach;
    if (b.test) {
      const t = await routines.test({ rid: r?.id, page: p?.id || null, code, reach, keeps, timeout: input.timeout, run: (args) => routineExec({ ...args, root: routineRoot(args.page, r || { thread }, D) || undefined }, D) });
      return { test: t, reach: reachText(reach) };
    }
  }
  const rid = r?.id || routineId(input.name, (x) => !!state.routines[x]);
  const before = r?.code_v || 0;
  commit({ t: "routine.write", rid, page: p?.id || null, thread, by: { agent, post }, ...(r ? {} : { owner: o.id }), ...input, summary: str(b.summary, 200) });
  r = state.routines[rid];
  if (!r) return { error: "That routine couldn't be made.", status: 400 };
  let test = null;
  if (r.code_v !== before) {
    if (r.kind === "code") {
      // The OK shows how the new version did: the agent's own test of this same code, or one now.
      const c = versionOf(state, rid, r.code_v);
      test = routines.testedAlready(c.code, c.reach, r.keeps) || (await routines.test({ rid, page: r.page, code: c.code, reach: c.reach, keeps: r.keeps, timeout: r.timeout, run: (args) => routineExec(args, routineMachine(r) || D) }));
      commit({ t: "routine.test", rid, v: r.code_v, test: testKept(test) });
    }
    askRoutineOk(rid, post);
  }
  const w = waiting(state, r);
  const c = versionOf(state, rid, r.code_v);
  return { id: rid, kind: r.kind, name: r.name, page: r.page, thread: r.thread, code_v: r.code_v, live_v: r.live_v, waiting: w ? w.v : null, test: test && testKept(test), test_words: test ? testWords(test) : null, reach: r.kind === "code" ? reachText(c?.reach) : null, runs_as: r.kind === "agent" ? agentRef(c?.agent)?.a.name || c?.agent : null, every: scheduleText(r.schedule), url: r.page ? `${pageLink(r.page)}/routines` : routineLink(rid) };
}
