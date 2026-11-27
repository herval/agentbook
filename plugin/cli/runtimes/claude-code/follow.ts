// Following Claude Code's sessions as they work: their transcripts read once a second (skills, the slash commands
// you sent and what they printed, where they work, an Esc that ended a turn), and what you send one mid-turn handed
// to it at its next step.

import fs from "node:fs";
import path from "node:path";
import { placeOf } from "../../git.ts";
import { CLI_HOME, conversationOf } from "../../../shared/store.ts";
import type { Session } from "../../../shared/types.ts";
import { mine } from "./host.ts";
import type { ClaudeHost } from "./host.ts";
import type { Supervisor } from "./supervisor.ts";

export type Follow = ReturnType<typeof createFollow>;
export function createFollow(h: ClaudeHost, cc: Pick<Supervisor, "commanded">) {
  const { state, store, commit, log, transcripts, started, pageChanged, work, saveSnapshot, unsaved, changesSent, queueOf, turnStopped } = h;
  const { commanded } = cc;
  const turnGoing = (s: Session) => s.busy || ["working", "waiting"].includes(s.state);

  // Send now, to a Claude Code session in the middle of a turn: its PostToolUse hook hands Claude what you sent at
  // its next step. That hook would run after every tool call of every session, so it starts only when a file named
  // for its Claude Code process says something of yours waits for it (hooks.json): one per busy session with a
  // message pending, or how a run of yours went, in ~/.agentbook/cli/steer.
  const STEER_DIR = path.join(CLI_HOME, "steer");
  const STEERS = new Set(["message.add", "message.release", "message.drop", "message.fail", "message.retry", "event.deliver", "outbox.ack", "session.status", "session.hello", "session.gone", "session.sleep"]);
  let steering: Set<string> | null = null; // the pids with a file there
  function syncSteer() {
    const want = new Set<string>();
    for (const [proc, post] of Object.entries(state.procs)) {
      const s = state.sessions[post];
      const pid = /^[^:]+-(\d+)$/.exec(proc)?.[1];
      if (pid && s?.busy && mine(s) && store.pending(post).some((o) => (o.event.type === "message" && !o.event.command) || o.event.type === "run" || o.event.type === "note")) want.add(pid);
    }
    try {
      if (!steering) {
        fs.mkdirSync(STEER_DIR, { recursive: true });
        steering = new Set(fs.readdirSync(STEER_DIR));
      }
      for (const pid of steering) if (!want.has(pid)) fs.rmSync(path.join(STEER_DIR, pid), { force: true });
      for (const pid of want) if (!steering.has(pid)) fs.writeFileSync(path.join(STEER_DIR, pid), "");
      steering = want;
    } catch (e) {
      log(`steer: ${e.message}`);
    }
  }
  syncSteer(); // and away with what an earlier run left there

  // The skills a session can use, logged only when they change.
  function saveSkills(s: Session) {
    const skills = s && transcripts.skills(s);
    if (!skills) return;
    const json = JSON.stringify(skills);
    if (JSON.stringify(s.skills || null) === json) return;
    commit({ t: "session.skills", post: s.id, skills });
  }

  // What a slash command you sent printed, read from its transcript: on the thread as its
  // agent's reply, once (`ext`: the command's entry there). Its Markdown copy when it left one (/context's table), else
  // what it printed, as it printed it. Only the commands sent from here: what one typed in its terminal printed stays
  // there. What printed a moment ago may have its Markdown copy still to come (`ranWaiting`).
  const ranWaiting = new Set();
  const fenced = (t) => {
    const n = Math.max(3, ...[...t.matchAll(/`{3,}/g)].map((m) => m[0].length + 1));
    return `${"`".repeat(n)}text\n${t}\n${"`".repeat(n)}`;
  };
  function saveRan(s: Session) {
    if (!s) return;
    ranWaiting.delete(s.id);
    for (const r of transcripts.ran(s)) {
      const said = conversationOf(state, s.id);
      if (r.out == null || said.some((m) => m.ext === `cmd:${r.id}`)) continue;
      if (!r.md && Date.now() - Date.parse(r.outAt) < 1500) {
        ranWaiting.add(s.id);
        continue;
      }
      // The one you sent it with: the latest of yours that ran it, before it ran, and not answered already.
      const sent = said.findLast((m) => m.from === "human" && m.command === r.name && !m.queued && Date.parse(m.at) <= Date.parse(r.at) + 5e3);
      if (!sent || Date.parse(r.at) - Date.parse(sent.at) > 10 * 60e3) continue;
      if (said.some((m) => m.from === "agent" && m.command === r.name && m.at >= sent.at)) continue;
      const text = r.md || (r.out ? fenced(r.out) : "");
      if (!text) continue;
      commit({ t: "message.add", post: s.id, from: "agent", via: "dash", text, command: r.name, ext: `cmd:${r.id}`, when: r.outAt || r.at });
      if (commanded.get(s.id)?.name === r.name) commanded.delete(s.id);
    }
  }

  // Where a session works, kept current: Claude Code notes the session's folder on every transcript line, and
  // the agent may move to another checkout (EnterWorktree, a cd that sticks) or switch branch where it is. The
  // post says which checkout and branch; moving between folders of one checkout isn't news.
  function saveWhere(s: Session) {
    const dir = s && transcripts.digest(s)?.cwd;
    const at = dir && placeOf(dir);
    if (!at) return;
    const was = s.cwd ? placeOf(s.cwd) : null;
    const where: { cwd?: string; root?: string; repo?: string; branch?: string } = {};
    if (was?.top !== at.top) {
      where.cwd = at.top;
      if (was?.root !== at.root) Object.assign(where, { root: at.root, repo: at.repo });
    }
    if (at.branch !== s.branch) where.branch = at.branch;
    if (Object.keys(where).length) commit({ t: "session.where", post: s.id, ...where });
  }

  // Follow running sessions' transcripts once a second.
  setInterval(() => {
    if (!started()) return;
    const recent = Date.now() - 300e3;
    // One that ended or fell asleep stops writing its transcript: follow it a few minutes more.
    const quiet = (s) => (s.state === "done" ? s.ended : s.slept);
    const following = Object.values(state.sessions).filter((s) => mine(s) && ((s.state !== "done" && !s.asleep) || Date.parse(quiet(s)) > recent));
    const changed = transcripts.poll(following);
    for (const key of new Set([...changed, ...unsaved])) saveSnapshot(state.sessions[key]);
    for (const key of changed) saveSkills(state.sessions[key]);
    for (const key of new Set([...changed, ...ranWaiting])) saveRan(state.sessions[key]);
    for (const key of changed) saveWhere(state.sessions[key]);
    for (const key of changed) saveInterrupt(state.sessions[key]);
    // Its work goes up as it happens, what it changed every few seconds while it works.
    for (const key of changed) work.touch(key, { changes: Date.now() - (changesSent.get(key) || 0) > 10e3 && !!changesSent.set(key, Date.now()) });
    if (changed.length) pageChanged();
  }, 1000).unref();

  // Esc ends a turn without a word: Claude Code runs no hook for it, and goes on listing a session with a shell running
  // as busy. Only its transcript says so, whoever pressed it (Stop here, which may not see it on the screen, or
  // someone in a terminal). Until the thread hears, it says it's working, and what you send it waits for a turn that's
  // over: one sat idle at its prompt for 40 minutes that way, holding an answer and two messages.
  function saveInterrupt(s: Session) {
    if (!s || s.state === "done" || s.asleep || !turnGoing(s)) return;
    const at = transcripts.interrupted(s);
    if (!at || Date.parse(at) < Date.parse(s.turn_started)) return;
    // Esc says "wait for me" as Stop does (post.stop): its queue holds.
    if (queueOf(s.id).length && !s.queue_paused) commit({ t: "session.paused", post: s.id, paused: "stopped" });
    turnStopped(s.id);
  }

  return { STEERS, syncSteer, saveSkills, saveRan, saveWhere, saveInterrupt, turnGoing };
}
