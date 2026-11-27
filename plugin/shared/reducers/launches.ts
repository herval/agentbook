import type { LaunchOp } from "../ops.ts";
import type { Iso, Launch, State } from "../types.ts";
import { linkPost } from "./tasks.ts";

// The post-in-waiting (launch) a session saying hello answers (`key`: its post's id): a resume of this post, or a new
// session Claude Code named when it started it (`claude --bg` printed its id). A background session's environment
// can't say which: Claude Code starts it in a worker made earlier, with an earlier launch's variables. Only a launch
// that isn't named that way (Codex's, or one from before) goes by what the session says. Null: agentbook didn't
// start it.
// `op`: the hello (session.hello).
export function helloLaunch(state: Pick<State, "launches">, key: string, op: { launch?: string | null }): Launch | null {
  const resumed = Object.values(state.launches).filter((l) => l.resume && l.post === key && !l.arrived && !l.error).at(-1);
  const told = op.launch && state.launches[op.launch];
  return resumed || Object.values(state.launches).find((l) => l.session && !l.post && !l.error && String(key).startsWith(l.session)) || (told && !told.named && !told.resume && !told.post ? told : null);
}

// A session takes over the launch it answers: the placeholder goes, and its files join the post. (One started in a
// group joins it on the server, which keeps groups.)
export function adopt(state: State, l: Launch, key: string): void {
  Object.assign(l, { post: key, arrived: true });
  if (state.sessions[key]) state.sessions[key].launch = l.id;
  // A side thread: started from the thread it forked, and its own from when it was made (its transcript has that
  // thread's conversation before it: transcript.ts).
  if (l.side_of && state.sessions[key] && l.side_of !== key) Object.assign(state.sessions[key], { started_from: l.side_of, side_at: l.at });
  // Posted as private or public, unlike its agent: the post keeps that.
  if (l.visibility && state.sessions[key] && state.sessions[key].visibility == null) state.sessions[key].visibility = l.visibility;
  // The mode it was started in: kept for when its session comes back (a runtime sets it again then).
  if (l.mode && state.sessions[key] && state.sessions[key].mode == null) state.sessions[key].mode = l.mode;
  if (l.effort && state.sessions[key] && state.sessions[key].effort == null) state.sessions[key].effort = l.effort;
  for (const f of state.files) if (l.files?.includes(f.id)) Object.assign(f, { post: key, pending: false });
  for (const t of Object.values(state.tasks))
    for (const e of t.sent)
      if (e.launch === l.id && !e.post) {
        e.post = key;
        linkPost(t, key, e.at, "sent");
      }
  // Teleported here: the post links back to the cloud session it came from.
  const s = state.sessions[key];
  if (l.teleport && s && !s.attachments.cloud) {
    const url = `https://claude.ai/code/${l.teleport}`;
    s.attachments.cloud = { key: "cloud", type: "link", title: "Teleported from claude.ai", data: { url, title: "Teleported from claude.ai", text: "Its conversation came from this cloud session. What it does from here stays on this machine." }, created: s.updated || l.at, updated: s.updated || l.at };
  }
}

export function applyLaunch(state: State, op: LaunchOp, now: Iso): void {
  switch (op.t) {
    case "launch.add": {
      // `resume`: picking up an ended post's conversation, with the message you wrote on it. `named`: the
      // session will be known by the id Claude Code gives it (launch.started). `teleport`: a Claude Code cloud
      // session coming here; its conversation is the cloud's, so what's typed first is typed, not posted.
      // `task`: the text of the task it was sent for, which its agent is told. `page`: the page it's for, "new" for
      // one to make, which its agent is told too. `cwd`: where it started, when that isn't `root` (a worktree);
      // with `model` and `effort`, what starting it again needs. `routine`: the routine it's a run of
      // ({ id, name }, routines.ts). `user`: who started it, when that wasn't the machine's owner (back when an owner could
      // let others operate an agent). `side_of`: a side thread's, the thread whose conversation it goes on from (claude --fork-session).
      state.launches[op.lid] = { id: op.lid, agent: op.agent, root: op.root, cwd: op.cwd || null, branch: op.branch || null, prompt: op.prompt, files: op.files || [], at: now, post: op.post || null, resume: !!op.resume, named: !!op.named, teleport: op.teleport || null, mirrored: !!op.teleport, visibility: op.visibility || null, cloning: op.cloning || null, step: op.step || null, task: op.task || null, page: op.page || null, group: op.group || null, model: op.model || null, effort: op.effort || null, mode: op.mode || null, routine: op.routine || null, ...(op.noted ? { noted: true } : {}), ...(op.user ? { user: op.user } : {}), ...(op.side_of ? { side_of: op.side_of } : {}), error: null };
      break;
    }
    case "launch.cloned": {
      if (state.launches[op.lid]) state.launches[op.lid].cloning = null;
      break;
    }
    case "launch.step": {
      const l = state.launches[op.lid];
      if (l) Object.assign(l, { step: op.step || null, progress: op.step && op.total ? { done: op.done || 0, total: op.total } : null });
      break;
    }
    case "launch.started": {
      // Claude Code started the session as `session` (its id, or the start of it). It may have registered already.
      const l = state.launches[op.lid];
      if (!l) break;
      l.session = op.session;
      const s = !l.post && Object.values(state.sessions).find((x) => x.session_id?.startsWith(op.session));
      if (s) adopt(state, l, s.id);
      break;
    }
    case "launch.fail": {
      if (state.launches[op.lid]) state.launches[op.lid].error = op.error;
      break;
    }
    case "launch.retry": {
      // A start that failed, starting again (its folder trusted since).
      const l = state.launches[op.lid];
      if (l) Object.assign(l, { error: null, at: now });
      break;
    }
    case "launch.archive": {
      // A start that failed, out of the feed. It's kept for the task it was sent for.
      if (state.launches[op.lid]) state.launches[op.lid].archived = now;
      break;
    }
  }
}
