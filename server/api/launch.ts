import crypto from "node:crypto";
import { isLevel } from "../../plugin/shared/visibility.ts";
import { contributes } from "../../plugin/shared/pages.ts";
import { expandMentions, groupsIn, mentionNote, tasksIn } from "../../plugin/shared/mentions.ts";
import { routineDetail } from "../../plugin/shared/routines.ts";
import { agentRoutineNote, myRoutineNote, threadKey } from "../../plugin/shared/routine-threads.ts";
import type { AgentRoutine, AgentRoutineRun } from "../../plugin/shared/routine-threads.ts";
import { capsOf, isMode } from "../../plugin/shared/runtimes.ts";
import type { Mode } from "../../plugin/shared/runtimes.ts";
import { commit, relay, state } from "../core/state.ts";
import { fail, modelName, ok, readBody, route, slug, str } from "../core/http.ts";
import { noFullAccess } from "../core/guards.ts";
import type { Answer, ReadAnswer } from "../core/types.ts";
import { agentRef, deviceFor, isOwner, postRef, viewerName } from "../core/refs.ts";
import { seesPost } from "../core/follows.ts";
import { canStart, readOf, steer } from "../core/commands.ts";
import { uploadsOf } from "./threads.ts";
import { groupsNamed, tasksNamed, workspacesNamed } from "./workspaces.ts";
import { taskOr404 } from "./tasks.ts";
import { pageMine, pageOwnerName, pageRoot, pagesSeenBy } from "./pages.ts";
import { noteRefs, notesNamed } from "./notes.ts";
import { routineOr404, routineState, routines } from "./routines.ts";
import { inGroup } from "./groups.ts";
import { flagsSoon } from "./task-ship.ts";

// A thread to start (/api/launch): what to say, to which agent on which machine, and where. `task`: the task it's for,
// by its words.
interface LaunchBody {
  prompt?: string;
  page?: string;
  agent?: string;
  machine?: string;
  model?: string;
  effort?: string;
  mode?: string;
  task?: string | { text?: string };
  on_my_routine?: string;
  on_routine?: string;
  group?: string;
  files?: unknown[];
  worktree?: boolean;
  fresh?: boolean;
  visibility?: string;
  root?: string;
  branch?: string;
  base?: string;
  clone?: string;
  repo?: string;
  wip?: unknown;
}
// The page started a session for the task: `launch` is what /api/launch answered (with its machine's prefix
// when it runs on another one).
route("POST", "/api/tasks/:id/send", async (req, res, { params }) => {
  const t = taskOr404(req, res, params.id);
  if (!t) return;
  const b = await readBody<{ launch?: string; agent?: string }>(req);
  const launch = str(b.launch, 200);
  if (!launch) return fail(res, 400, "Say which launch it went out as.");
  // Someone it's shared with starts threads on it on their own machines only.
  if (t.owner !== req.user.id) {
    const r = relay.resolve(launch);
    if (!r || !isOwner(req, r.D)) return fail(res, 403, "You add your own threads to it: that one isn't yours.");
  }
  // Already on it: its prompt named it (@task:<id>), and /api/launch put it there.
  if ((t.sent || []).some((e) => e.launch === launch)) return ok(res);
  commit({ t: "task.send", tid: t.id, launch, agent: b.agent ? str(b.agent, 200) : null, user: req.user.id });
  ok(res);
});

// What you can do on a machine: its folders, for picking one to add, and a checkout's branches.
route("GET", "/api/folders", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only a machine's owner can look through its folders.");
  await readOf(res, D, "read.folders", query.get("path") ? { path: str(query.get("path"), 2000) } : {});
});
route("GET", "/api/branches", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only a machine's owner can see its branches.");
  await readOf(res, D, "read.branches", { root: str(query.get("root"), 2000) });
});

// Writing on an agent's wall starts a session on its machine, in the background. Files you attach go with it.
export const launchId = () => `l${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
// The agents that can write pages: the ones that have agentbook's tools, as their runtimes say (shared/runtimes.ts,
// `writesPages`): all but Devin and the cloud runtimes, which have no way to call them. Claude Code and Codex get its
// MCP server, Hermes and DeepSeek get it per session, OpenClaw's agents from agentbook's plugin on their gateway, and
// Claude Agent's sessions as their custom tools. The ones that have them for sure (`tools: "sure"`) are told to use
// them plainly; an OpenClaw gateway may be without the plugin, and a Hermes or DeepSeek session agentbook didn't
// start has only what it was started with, so those are told "if you have agentbook's tools".
export const writesPages = (kind: string | null | undefined) => capsOf(kind).writesPages;
route("POST", "/api/launch", async (req, res, { query }) => {
  const b = await readBody<LaunchBody>(req);
  // A widget named in short is one on the page it's started from (mentions.ts), of the pages they may see.
  const seen = pagesSeenBy(req.user);
  const prompt = expandMentions(str(b.prompt, 8000).trim(), b.page && b.page !== "new" ? seen[b.page] : null);
  // The agent picks the machine: an agent the page knows, or one by name on the machine asked for.
  const known = b.agent ? agentRef(b.agent) : null;
  const D = known ? known.D : deviceFor(req, query.get("machine") || b.machine);
  if (!D || !isOwner(req, D)) return fail(res, 403, "Only an agent's owner can give it work.");
  if (!prompt) return fail(res, 400, "Say what the agent should do.");
  const agent = known ? known.local : slug(b.agent || "claude");
  if (!canStart(res, D, agent)) return;
  const model = modelName(b.model) || undefined;
  if (b.model && !model) return fail(res, 400, "That isn't a model name.");
  const effort = b.effort ? str(b.effort, 20).trim() : undefined;
  if (effort && !/^[a-z]+$/.test(effort)) return fail(res, 400, "That isn't an effort level.");
  const mode = modeFor(b, D.store.state.agents[agent]);
  if (mode === false) return fail(res, 400, `${D.store.state.agents[agent]?.name || agent} can't start in that mode.`);
  // The tasks it names (@task:<id>): it goes on each, as one sent from it does, and its agent is told the first.
  const namedTasks = tasksIn(prompt, tasksNamed(req.user, prompt)).map((x) => x.task);
  const task = str(typeof b.task === "object" ? b.task?.text : b.task, 500).trim() || namedTasks[0]?.text || undefined;
  // One of agentbook's routines it's on, from its page (routine-threads.ts, below): one of a page's goes as a thread for
  // its page, which its agent then contributes to, so that it can change it.
  const myRoutine = b.on_my_routine ? routineOr404(req, res, str(b.on_my_routine, 200), "edit") : null;
  if (b.on_my_routine && !myRoutine) return;
  // The page it's for: one to make ("new"), or one to change, which its agent then contributes to.
  const page = b.page === "new" ? "new" : b.page && state.pages[b.page] ? b.page : myRoutine?.page && state.pages[myRoutine.page] ? myRoutine.page : undefined;
  if (page && !writesPages(D.store.state.agents[agent]?.kind)) return fail(res, 400, `${D.store.state.agents[agent]?.name || agent} can't write pages: it doesn't have agentbook's tools.`);
  // Working on a page makes its agent a contributor, so only the people who keep it (its owner, and the people among
  // its contributors, with their own agents) may point an agent at it. (An agent already on it works whoever starts
  // it.) Someone who only sees it, being public, can't yet.
  if (page && page !== "new") {
    const pg = state.pages[page];
    const aid = relay.idOf(D, agent);
    if (!contributes(pg, { agent: aid })) {
      if (!pageMine(req, pg) && !contributes(pg, { user: viewerName(req) })) return fail(res, 403, `Only the people who keep "${pg.title}" (${pageOwnerName(pg) ? `@${pageOwnerName(pg)}` : "its owner"} and its contributors) can set an agent to work on it.`);
      commit({ t: "page.contributor", pid: page, who: { agent: aid }, by: viewerName(req) });
    }
  }
  // The group it's started in: it joins it when it starts, and can write its folder (with no folder of its own, it
  // starts there). None picked, the first one it names (@group:<id>).
  const group = b.group ? state.groups[str(b.group, 80)] : groupsIn(prompt, groupsNamed(req, prompt))[0]?.group || null;
  if (b.group && (!inGroup(req, group) || group.archived)) return fail(res, 404, "No such group.");
  const shared = mode === "full" && group ? noFullAccess({ group: group.id }) : null;
  if (shared) return fail(res, 403, shared);
  // A thread on a routine, from its page (routine-threads.ts): one of this agent's own (`on_routine`, its job), or one
  // of agentbook's (`on_my_routine`). Its agent is told which, how it stands and how it changes it, and the routine's
  // page lists the thread.
  let onRoutine = null;
  if (b.on_routine) {
    if (!known) return fail(res, 400, "Say whose routine it's on.");
    const job = str(b.on_routine, 500);
    // Read from its machine as its page reads it; when that can't be done now (its machine is off, its gateway
    // doesn't answer), its agent is told its id and to look it up.
    const r = (await relay.read(D, "read.agent_routine", { agent, job })) as ReadAnswer<Answer & { routine?: AgentRoutine | null; runs?: AgentRoutineRun[] }>;
    if (r.status === 404) return fail(res, 404, `${D.store.state.agents[agent]?.name || agent} has no such routine.`);
    const d = r.error || r.data?.error ? null : r.data;
    onRoutine = { key: threadKey(relay.idOf(D, agent), job), note: agentRoutineNote({ kind: D.store.state.agents[agent]?.kind, job, routine: d?.routine, runs: d?.runs || [] }) };
  } else if (myRoutine) onRoutine = { key: threadKey(null, myRoutine.id), note: myRoutineNote(routineDetail(routineState(), myRoutine.id, routines.running, { runs: 5 })) };
  const lid = launchId();
  const args: Record<string, unknown> = { lid, agent, prompt, files: uploadsOf(req, b.files) };
  for (const k of ["root", "branch", "base", "clone", "repo"]) if (b[k]) args[k] = str(b[k], 1000);
  if (b.worktree) args.worktree = true;
  if (b.fresh) args.fresh = true;
  if (model) args.model = model;
  if (effort) args.effort = effort;
  if (mode) args.mode = mode;
  if (task) args.task = task;
  if (page) args.page = page;
  if (page && page !== "new" && !args.root) {
    const root = pageRoot(page, D);
    if (root) args.page_root = root;
  }
  if (isLevel(b.visibility)) args.visibility = b.visibility;
  if (group) args.group = group.id;
  // What the pages and widgets it names showed, for its agent with its first prompt; the tasks it's on and the group
  // it's in, of those it names.
  const here = (xs) => Object.fromEntries(xs.map((x) => [x.id, { ...x, here: true }]));
  const named = { tasks: { ...tasksNamed(req.user, prompt), ...here(namedTasks) }, groups: { ...groupsNamed(req, prompt), ...(group ? here([group]) : {}) }, notes: notesNamed(req.user, prompt) };
  const note = [onRoutine?.note, mentionNote(prompt, seen, Date.now(), workspacesNamed(req.user, prompt), named)].filter(Boolean).join("\n\n");
  if (note) args.note = note;
  // Once it's gone (or waits for its machine), each task it names follows the thread it starts, and so does the
  // routine it's on.
  const after = (r) => {
    if (onRoutine && r.lid) commit({ t: "routine.thread", key: onRoutine.key, lid: r.lid, agent: relay.idOf(D, agent), user: req.user.id });
    for (const t of namedTasks) if (r.lid && !(t.sent || []).some((e) => e.launch === r.lid)) commit({ t: "task.send", tid: t.id, launch: r.lid, agent: relay.idOf(D, agent), user: req.user.id });
    if (namedTasks.length) flagsSoon(req.user.id);
    if (r.lid) noteRefs(named.notes, { launch: r.lid });
  };
  await steer(req, res, D, "post.start", args, { wait: 60e3, done: (r) => ({ ...r, lid: relay.idOf(D, r.lid || lid) }), after });
});

// The mode a thread starts in (runtimes.ts's Mode): undefined for none picked (its agent's own default), false for one
// its agent doesn't offer.
export function modeFor(b: { mode?: string }, a: { kind?: string | null } | undefined): Mode | undefined | false {
  if (b.mode == null || b.mode === "") return undefined;
  return isMode(b.mode) && capsOf(a?.kind).modes.includes(b.mode) ? b.mode : false;
}

