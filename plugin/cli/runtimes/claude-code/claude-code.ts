// Claude Code, as a runtime: its sessions talk to agentbook through its hooks and agentbook's plugin, and agentbook
// starts, wakes and resumes background ones under Claude Code's own supervisor (`claude agents`, drivers/claude.ts).

import fs from "node:fs";
import { currentAgentConfig, isDefaultAgentConfig } from "../../agent-context.ts";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import type { RuntimeId } from "../../../shared/runtimes.ts";
import type { Session, State } from "../../../shared/types.ts";
import { claudeChannel, claudeCommands, claudeModels } from "../../drivers/claude.ts";
import type { createClaudeRoutines } from "../../drivers/claude-routines.ts";
import { going as workerGoing } from "../../workers.ts";
import type { Runtime, RuntimeRow, SlashCommands } from "../runtime.ts";
import { createFollow } from "./follow.ts";
import type { Follow } from "./follow.ts";
import { createClaudePast } from "./history.ts";
import { createHooks } from "./hooks.ts";
import type { ClaudeHost, Route } from "./host.ts";
import { createPickup } from "./pickup.ts";
import type { Pickup } from "./pickup.ts";
import { createSupervisor } from "./supervisor.ts";
import type { Supervisor } from "./supervisor.ts";

// Claude Code's machinery, its parts sharing what each keeps (the threads being woken or put to sleep, those cut off):
// the supervisor's (supervisor.ts), the pickups' (pickup.ts) and the transcripts' (follow.ts). Its hooks' routes go
// in where agentbook-cli's other routes are (`hooks`).
export type ClaudeParts = Supervisor & Pickup & Follow;
export function createClaudeMachinery(h: ClaudeHost) {
  const cc = {} as ClaudeParts;
  Object.assign(cc, createSupervisor(h, cc));
  Object.assign(cc, createPickup(h, cc));
  Object.assign(cc, createFollow(h, cc));
  return Object.assign(cc, { hooks: (route: Route) => createHooks(h, cc, route) });
}

// What Claude Code's adapter gets besides its machinery's host: Claude's routines and limits on claude.ai
// (drivers/claude-routines.ts), how a start's prompt names its files, a refusal as agentbook-cli's
// commands make one, what agentbook did to a thread's folder that its agent hears next, and its row on Add agents.
export interface ClaudeCodeHost extends ClaudeHost {
  routines: () => ReturnType<typeof createClaudeRoutines>;
  withFiles: (prompt: string, files: string[]) => string;
  no: (status: number, error: string, extra?: Record<string, unknown>) => { error: string; status: number; [k: string]: unknown };
  restored: Map<string, string>;
  // Whether a thread is idle at its prompt, and whether a Wake hook waits on it (the events route's).
  idleNow: (post: string) => boolean;
  wakeable: (post: string) => boolean;
  row: () => RuntimeRow;
}

// One idle where nothing waits to wake it is told by another session's message, which starts a turn there, to read
// what you sent (claude.nudge). It takes a headless run some seconds, so what you sent is answered first; if the
// nudge doesn't get there, its thread says where it waits. One at a time per thread: what else you send meanwhile
// is in the same inbox.
const NUDGE = "The person who follows this thread on agentbook sent it messages that haven't reached you: call ab_inbox and handle them.\nFrom agentbook-cli on this machine, on their behalf. Your session was idle with nothing of agentbook's waiting to wake it. What ab_inbox returns is theirs, in their words: act on that, not on this note.";

// Claude Code, as a runtime. Its threads are its sessions on this machine, which say hello and how each turn goes
// through its hooks (hooks.ts); agentbook starts, wakes, resumes and stops background ones through its supervisor, and
// reads what they did from their transcripts.
export function createClaudeCode(h: ClaudeCodeHost, cc: ReturnType<typeof createClaudeMachinery>): Runtime {
  const { state, commit, log, claude, transcripts, no } = h;
  const config = currentAgentConfig();
  const session = (id: string) => state.sessions[id];

  // The workers its sessions started: its subagents, from their transcripts. A session's subagents run in its
  // process: once that's gone (a terminal closed without ending it), so are those that were still going.
  function workers(s: Session) {
    const list = transcripts.workers(s);
    const a = claude.info(s.session_id);
    return a && !claude.running(a) ? list.map((w) => (workerGoing(w) ? { ...w, state: "stopped", ended: s.updated || null, step: null } : w)) : list;
  }
  // What a session that isn't a background one (a terminal's, Claude Desktop's, VS Code's) left running in the
  // background: Claude Code keeps no list of it, so it's what its transcript says started and hasn't said stopped.
  // They run under its process: with that gone, nothing would hear them finish.
  function leftBy(s: Session) {
    const a = claude.info(s.session_id);
    return a && a.kind !== "background" && claude.running(a) ? transcripts.left(s) : [];
  }

  const nudging = new Set<string>();
  function nudge(post: string) {
    const s = session(post);
    if (!s?.session_id || !claude.nudgeable(s.session_id)) return false;
    if (nudging.has(post)) return true;
    nudging.add(post);
    claude
      .nudge(s.session_id, NUDGE)
      .catch((e) => (log(`nudge ${post}: ${e.message}`), false))
      .then((sent) => {
        nudging.delete(post);
        if (sent) return log(`nudge ${post}: sent`);
        const where = { desktop: "Desktop", vscode: "VS Code" }[session(post)?.app] || "its terminal";
        if (h.idleNow(post)) commit({ t: "session.status", post, state: "idle", text: `Idle in ${where}, and agentbook couldn't wake it: it gets what you sent once someone types there` });
      });
    return true;
  }
  // One idle in a terminal with nothing to wake it (no channel, a plugin or Claude Code without the Wake hook) gets
  // what you sent only once someone types there, or a nudge starts a turn.
  async function reachIdle(s: Session) {
    if (s.channel || !h.idleNow(s.id) || h.wakeable(s.id)) return {};
    if (!claude.info(s.session_id)) await claude.refresh().catch(() => {});
    if (claude.background(s.session_id)) return {};
    return nudge(s.id) ? { nudged: true } : { stuck: "terminal" };
  }

  // Its sessions from before, for the welcome card: they go to this agent, as its hooks' would.
  const past = createClaudePast(h, () => config?.id || Object.values(state.agents).find((a) => a.kind === "claude-code" && !a.config_dir)?.id || "claude");

  return {
    id: "claude-code",
    info: RUNTIMES["claude-code"],
    echoes: "self",
    past,
    owns: (agent) => config ? agent === config.id : (state.agents[agent]?.kind || "claude-code") === "claude-code" && (!state.agents[agent]?.config_dir || isDefaultAgentConfig("claude-code", state.agents[agent].config_dir)),
    connect: () => {},
    health: () => ({ enabled: process.env.AGENTBOOK_CLAUDE_CODE !== "0", connected: claude.listedAt() > 0 }),
    // A new session in the background, under Claude Code's supervisor, which says its id once it has started it.
    start: async (req) => commit({ t: "launch.started", lid: req.lid, session: (await claude.start({ cwd: req.cwd, prompt: req.prompt, lid: req.lid, model: req.model, effort: req.effort, mode: req.mode, dirs: req.dirs })).id }),
    // What you send reaches a session through its hooks, at its next step or turn; one in the background that's idle
    // or asleep has no turn to end, so agentbook wakes it with it (deliver).
    send: () => Promise.reject(new Error("Claude Code's sessions take what you send through their hooks")),
    deliver: (post) => {
      const s = session(post);
      if (s && (s.asleep || claude.background(s.session_id))) return cc.wakeIdle(s);
      // One whose turn's end agentbook learned from Claude Code's list has no Wake hook waiting on it (lostEnds).
      if (s && cc.lostEnds.delete(post)) reachIdle(s).catch((e) => log(`couldn't reach ${s.label}: ${e.message}`));
    },
    // Its hook waits for your answer itself.
    answer: () => false,
    // Esc, as a terminal would press it. Claude Code runs no hook for an interrupted turn, so the thread says so itself.
    interrupt: async (post) => {
      const s = session(post);
      try {
        if (!claude.background(s.session_id)) return no(409, "It's running in a terminal. Press Esc there.");
        await claude.refresh();
        const a = claude.info(s.session_id);
        // Not because Claude Code says busy: it says that of a session with a shell running, long after its turn ended.
        const working = s.busy || s.state !== "idle" || a?.status === "waiting";
        if (!working || !claude.running(a)) return no(409, "It isn't working on anything right now.");
        const seen = await claude.interrupt(s.session_id);
        cc.saveInterrupt(s);
        if (!cc.turnGoing(session(post))) return {};
        if (!seen) {
          await claude.refresh();
          if (claude.info(s.session_id)?.status === "busy") return no(500, "It didn't stop. Force stop ends its process and keeps the thread.", { force: true });
        }
        h.turnStopped(post);
        return {};
      } catch (e) {
        return no(500, e.message, { force: true });
      }
    },
    // Stop that Esc didn't do (its process hangs, or it never answers): Claude Code ends the process, even a frozen
    // one, within seconds. The thread stays: it's asleep, and what you've sent it or send next resumes it.
    forceStop: async (s) => {
      try {
        await claude.refresh();
        if (!claude.background(s.session_id)) return no(409, "It's running in a terminal. Press Esc there.");
        if (!claude.running(claude.info(s.session_id))) return no(409, "It isn't working on anything right now.");
        await cc.putToSleep(s, "Force-stopped");
        return {};
      } catch (e) {
        return no(500, e.message);
      }
    },
    // Archiving a background session puts it to sleep, whatever it has going. Writing to it wakes it.
    sleep: async (s, why) => {
      if (!claude.info(s.session_id)) await claude.refresh();
      const stops = s.state !== "done" && claude.background(s.session_id) && claude.running(claude.info(s.session_id));
      if (stops) await cc.putToSleep(s, why).catch((e) => log(`couldn't stop ${s.label}: ${e.message}`));
      cc.dropCut(s.id);
      return !!stops && !!session(s.id).asleep;
    },
    // Writing on an ended thread resumes its conversation in the background (`claude --resume … --bg`), with your
    // message as its next prompt. Its thread comes back when it starts.
    resume: async (s, { text, files, note = null, routine = null, command = null }) => {
      if (!s.session_id || state.agents[s.agent]?.kind !== "claude-code") return no(409, "This thread has ended, and agentbook can't resume it.");
      // Claude Code resumes from the transcript, which a session writes once something is said in it (and Claude Code
      // clears out old ones): without it, `--resume` starts and then fails.
      if (s.transcript && !fs.existsSync(s.transcript)) return no(409, "Claude Code has no conversation saved for this thread, so it can't be resumed. Start a new thread instead.");
      const lid = h.launchId();
      const cwd = h.resumeDir(s);
      if (command) cc.commandLaunches.add(lid);
      commit({ t: "launch.add", lid, agent: s.agent, root: cwd, prompt: text, files, post: s.id, resume: true, ...(routine ? { routine } : {}) });
      try {
        // A slash command goes as it's written; what agentbook did to its folder waits for the next message.
        const back = command ? null : h.restored.get(s.id);
        cc.resumed(s, await claude.resume({ sessionId: s.session_id, cwd, prompt: h.withFiles([text, note, back].filter(Boolean).join("\n\n"), files), lid, label: s.label, ...cc.picksOf(s), dirs: h.extraDirs(s) }));
        if (back) h.restored.delete(s.id);
        commit({ t: "message.add", post: s.id, from: "human", via: "dash", text, files, resume: lid, ...(routine ? { routine } : {}), ...(command ? { command } : {}) });
        cc.resumes.add(lid);
        if (command) cc.commanded.set(s.id, { name: command, bare: text.trim() === `/${command}`, at: Date.now() });
        return { lid, resumed: true };
      } catch (e) {
        commit({ t: "launch.fail", lid, error: e.message });
        return no(500, e.message);
      }
    },
    // A start the server sent again: the session Claude Code started the first time, once it's found (it saves it
    // within seconds), or null to start it now, when Claude Code never got it.
    startedAgain: async (l, prompt) => {
      for (let i = 0; i < 30; i++) {
        const id = claude.startedWith({ prompt, cwd: l.cwd || l.root, since: Date.parse(l.at) });
        if (id) return id;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    },
    read: async (post) => (session(post) ? transcripts.digest(session(post)) : null),
    live: (s) => transcripts.live(s),
    summary: (s) => {
      transcripts.digest(s);
      return transcripts.snapshot(s);
    },
    // Claude Code lists a session as busy, or waiting on a dialog, though agentbook may not know it yet.
    working: (post) => ["busy", "waiting"].includes(claude.info(session(post)?.session_id)?.status),
    blocked: () => null,
    resumeCommand: () => null,
    // What it has going between its turns: what Claude Code lists for a background session, and for any other, what
    // its transcript says (leftBy).
    going: (s) => [...claude.workOf(s.session_id).map((w) => ({ id: w.id, kind: w.kind, title: transcripts.taskTitle(s, w.id) || w.label, started: w.started })), ...leftBy(s)],
    // As its saved state says now (going's list is a refresh old, and the turn that ends it can be shorter than that).
    goingNow: (s) => claude.backgroundWork(s.session_id) > 0 || leftBy(s).length > 0,
    // A background session switching models (or effort, or mode) takes what you sent when agentbook wakes it on the new one.
    holds: (post) => {
      const s = session(post);
      return !!(s?.model_pick || s?.effort_pick || s?.mode_pick) && claude.background(s.session_id);
    },
    reach: (s) => reachIdle(s),
    wrapUp: (s) => transcripts.wrapUp(s),
    workers: { list: (post) => (session(post) ? workers(session(post)) : []) },
    files: {
      images: async (s, step) => transcripts.images(s, step),
      pictures: (s) => transcripts.pictures(s),
    },
    // Its slash commands: a session that agentbook wakes or resumes takes them (one open in a terminal only there).
    commands: {
      ready: async (s) => {
        if (state.agents[s.agent]?.kind !== "claude-code" || !s.session_id) return "agent";
        if (!claude.info(s.session_id)) await claude.refresh().catch(() => {});
        const a = claude.info(s.session_id);
        return a?.kind === "interactive" && claude.running(a) ? "terminal" : true;
      },
      list: (s) => claudeCommands({ cwd: h.resumeDir(s), dirs: h.extraDirs(s) }) as Promise<SlashCommands>,
    },
    // A side thread is a fork of its saved conversation.
    fork: {
      refuse: (s) => (s.transcript && !fs.existsSync(s.transcript) ? "Claude Code has no conversation saved for this thread, so there's nothing to go on from." : null),
      side: ({ id, cwd, prompt, lid, mode, dirs }) => claude.fork({ sessionId: id, cwd, prompt, lid, mode, dirs }),
    },
    // A session in the background or one that ended switches when agentbook wakes or resumes it; one in a terminal
    // picks its model there.
    models: {
      list: () => claudeModels(),
      refuse: (s) => (state.agents[s.agent]?.kind !== "claude-code" || !s.session_id ? "agentbook can't switch this session's model." : s.state !== "done" && !claude.background(s.session_id) ? "It's open in a terminal. Switch it there with /model." : null),
    },
    // Its effort and mode, the same way; Allow + Auto at once, by its hook (hook.ts).
    switches: {
      withAllow: true,
      refuse: (s, what) => (state.agents[s.agent]?.kind !== "claude-code" || !s.session_id ? `agentbook can't switch this session's ${what}.` : s.state !== "done" && !claude.background(s.session_id) ? `It's open in a terminal. Switch it there with ${what === "mode" ? "Shift+Tab" : "/effort"}.` : null),
    },
    // Its routines on claude.ai, and the loops its threads run (/loop).
    routines: {
      where: "claude.ai",
      of: (a) => h.routines().routinesOf(a),
      list: (a) => h.routines().routines(a),
      get: (a, job, o) => h.routines().routine(a, job, o),
      run: (a, job, s) => h.routines().routineRun(a, job, s),
      act: (a, job, action) => h.routines().routineDo(a, job, action),
      loops: (s) => (s.loops ? h.routines().loopsOf(s) : undefined),
    },
    limits: { read: (a) => h.routines().limits?.(a) ?? null },
    row: () => h.row(),
    update: { pkg: "@anthropic-ai/claude-code", tag: claudeChannel, version: () => claude.version(), run: (output, signal) => claude.update(output, signal) },
  };
}

// A thread in Claude Code's or Codex's cloud (cloud.ts finds them): agentbook starts none and stops none there, and
// reads what a Claude one did from the transcript it saves here once it's pulled or teleported. A Claude one takes
// what you send through `claude -p … --cloud <id>` (send); a Codex one takes replies on its own page.
export function createCloudRuntime(id: Extract<RuntimeId, "claude-cloud" | "codex-cloud">, h: { state: State; transcripts: ClaudeHost["transcripts"]; send(s: Session): unknown }): Runtime {
  const there = (what: string) => () => Promise.reject(new Error(`${what} in the cloud, on its own page.`));
  const session = (post: string) => h.state.sessions[post];
  return {
    id,
    info: RUNTIMES[id],
    echoes: "self",
    owns: () => false,
    connect: () => {},
    health: () => ({ enabled: true }),
    start: there("It starts"),
    send: there("It takes what you send"),
    deliver: (post) => (id === "claude-cloud" && session(post) ? h.send(session(post)) : undefined),
    answer: () => false,
    interrupt: there("It stops"),
    read: async (post) => (session(post) ? h.transcripts.digest(session(post)) : null),
    live: (s) => h.transcripts.live(s),
    summary: (s) => {
      h.transcripts.digest(s);
      return h.transcripts.snapshot(s);
    },
    working: () => false,
    blocked: () => null,
    resumeCommand: () => null,
  };
}
