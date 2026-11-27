// Claude Code's supervisor, as agentbook follows it: what `claude agents` lists of its sessions, background ones put
// to sleep when nothing needs them and woken with what you send, prompts and panels nobody is at a terminal for, and
// a session whose process went without saying so.

import { learnCommand } from "../../drivers/claude.ts";
import type { Session } from "../../../shared/types.ts";
import { mine } from "./host.ts";
import type { ClaudeHost } from "./host.ts";

export type Supervisor = ReturnType<typeof createSupervisor>;
// `cc`: what it uses of the other parts (pickup.ts).
export function createSupervisor(h: ClaudeHost, cc: { blockedOnLogin(): void; pickUpAll(): void }) {
  const { state, store, commit, log, claude, pids, started, pageChanged, undelivered, promptFor, holdMs, resumeDir, extraDirs, groupNews, launchId, resuming, RESUME_WAIT_MS } = h;
  const blockedOnLogin = (): void => cc.blockedOnLogin();
  const pickUpAll = (): void => cc.pickUpAll();

  // What Claude Code's supervisor says about its sessions, every few seconds while anything could change.
  // A background session whose process stopped without saying so (Claude Code retired it, or it was stopped
  // elsewhere) is asleep; one that crashed ends its post.
  const waking = new Map<string, number>(); // post -> when agentbook started waking it
  const commanded = new Map(); // post -> the slash command agentbook last woke it with: { name, bare, at }
  const sleeping = new Map(); // post -> why agentbook is putting it to sleep
  const resumes = new Set<string>(); // launches resuming an ended thread, until it's back or they failed
  let sweptGone = false; // whether the sessions from before it started have been looked at (processGone)
  async function syncRuntime() {
    const changed = await claude.refresh();
    // Claude Code is an agent here once its supervisor answers, before it has a thread: a machine that never ran a
    // session with agentbook's hooks has one to start a thread with (else Add agents says
    // Claude Code is "Ready", with no agent anywhere to start one with). One of any name will do.
    if (claude.listedAt() && !Object.values(state.agents).some((a) => a.kind === "claude-code")) commit({ t: "agent.hello", agent: "claude", agent_name: "Claude", kind: "claude-code" });
    const v = claude.version();
    for (const a of Object.values(state.agents)) if (v && a.kind === "claude-code" && a.version !== v) commit({ t: "agent.hello", agent: a.id, version: v });
    closePanels();
    settlePrompts();
    for (const s of Object.values(state.sessions)) endLostTurn(s);
    for (const post of lostEnds) if (!state.sessions[post] || state.sessions[post].busy) lostEnds.delete(post);
    for (const s of Object.values(state.sessions)) {
      if (s.state === "done" || s.asleep || !mine(s) || waking.has(s.id)) continue;
      const a = claude.info(s.session_id);
      if (a?.kind !== "background" || claude.running(a)) continue;
      if (a.state === "failed") commit({ t: "session.gone", post: s.id, reason: "Failed" });
      else asleep(s.id);
    }
    // Once, with the first listing: a session whose process went with the machine (it restarted, or a cloud sandbox
    // stopped) or was killed while this was off has ended, rather than waiting in a terminal that isn't there.
    if (!sweptGone && claude.listedAt()) {
      sweptGone = true;
      for (const s of Object.values(state.sessions)) if (await processGone(s)) commit({ t: "session.gone", post: s.id, reason: "Ended" });
      pids.keepOnly(Object.values(state.sessions).filter((s) => s.state !== "done").map((s) => s.id));
    }
    blockedOnLogin();
    // An ended thread you wrote on, whose resume Claude Code gave up on: it says why, instead of "Resuming it" and
    // then nothing.
    for (const lid of resumes) {
      const l = state.launches[lid];
      const s = l && state.sessions[l.post];
      const a = s && claude.info(s.session_id);
      if (!s || l.error || l.arrived || s.launch === lid || Date.now() - Date.parse(l.at) > 600e3) resumes.delete(lid);
      else if (a?.kind === "background" && a.state === "failed" && a.startedAt >= Date.parse(l.at) - 5e3) {
        resumes.delete(lid);
        commit({ t: "launch.fail", lid, error: claude.failure(a.id) || "Claude Code couldn't resume it." });
      }
    }
    await sleepIdle();
    if (changed) pageChanged();
  }

  // A prompt on Claude Code's own screen ends without a hook: you answered it there, or, in auto mode, it timed out after
  // 2 minutes and Claude Code denied the command and went on. Only the turn's end or a message reset the thread, so it
  // said "It's waiting in its terminal" with nothing waiting (once for 8 minutes). Claude Code lists a session
  // as waiting for as long as a dialog is up, so the list says when it's over. Only a list asked for after the prompt was
  // heard of speaks for it: not one that was on its way, nor the old one kept when an ask fails. What's open on agentbook
  // ends with its answer.
  function settlePrompts() {
    for (const s of Object.values(state.sessions)) {
      const asked = claude.listAsked(s.session_id);
      if (s.state !== "waiting" || !mine(s) || Date.parse(s.updated) >= asked) continue;
      if (state.questions.some((q) => q.post === s.id && !q.answered)) continue;
      const a = claude.info(s.session_id);
      if (claude.running(a) && ["busy", "idle"].includes(a.status)) commit({ t: "session.status", post: s.id, state: s.busy ? "working" : "idle", text: s.busy ? "Carrying on" : undefined });
    }
  }

  // A turn whose end never reached agentbook. Only the Stop hook says a turn ended, in the 5 seconds it gets: with
  // agentbook-cli too busy to answer in them, a Desktop thread stayed on working for hours, Claude Code idle at its
  // prompt and what you sent held for a turn that was over. The Wake hook says an end the Stop
  // hook couldn't; this is for one neither did. Claude Code listing a session idle, in a list asked for well after
  // anything was last heard of it, says its turn is over. One in a terminal then has no Wake hook waiting on it (that
  // gives up on a thread agentbook has as working), so what waits for it goes by a nudge (lostEnds, the runtime's deliver).
  const TURN_LOST_MS = Number(process.env.AGENTBOOK_TURN_LOST_MS || 30e3);
  const lostEnds = new Set<string>();
  function endLostTurn(s: Session) {
    if (!s?.busy || s.state === "done" || s.asleep || !mine(s) || waking.has(s.id) || starting(s)) return false;
    const a = claude.info(s.session_id);
    if (!claude.running(a) || a.status !== "idle" || claude.listAsked(s.session_id) - (Date.parse(s.updated) || Infinity) < TURN_LOST_MS) return false;
    log(`${s.label}: Claude Code has it idle, but its turn's end never came: ended it`);
    commit({ t: "session.status", post: s.id, state: "idle", text: "Finished, waiting for your next prompt", turn: "end" });
    if (!claude.background(s.session_id)) lostEnds.add(s.id);
    return true;
  }
  // As you write to a thread agentbook has as working, with nothing heard of it for a while: whether its turn is over.
  async function turnLost(s: Session) {
    if (!s?.busy || !mine(s) || Date.now() - (Date.parse(s.updated) || Date.now()) < TURN_LOST_MS) return false;
    if (Date.now() - claude.listAsked(s.session_id) > 5000) await claude.refresh().catch(() => {});
    return endLostTurn(state.sessions[s.id]);
  }

  // A slash command that opened a panel (a picker, a dialog) waits on someone at a terminal, which a background session
  // has none of: agentbook closes it (Esc, as `interrupt` presses it), says so on the thread, and remembers it on this
  // machine, so the / list asks for what it takes next time, or leaves it out (learnCommand).
  function closePanels() {
    for (const [post, c] of commanded) {
      const s = state.sessions[post];
      if (!s || Date.now() - c.at > 120e3) {
        commanded.delete(post);
        continue;
      }
      const a = claude.info(s.session_id);
      if (!a || !claude.running(a) || a.status !== "waiting" || !/dialog|input/i.test(a.waitingFor || "")) continue;
      commanded.delete(post);
      try {
        learnCommand(c.name, { bare: c.bare });
      } catch (e) {
        log(`couldn't note that /${c.name} opens a panel: ${e.message}`);
      }
      claude.interrupt(s.session_id).catch((e) => log(`couldn't close the panel /${c.name} opened on ${s.label}: ${e.message}`));
      const how = c.bare ? ` Send it with what it takes after it, or open it in a terminal: \`claude attach ${a.id}\`.` : ` Open it in a terminal to use it: \`claude attach ${a.id}\`.`;
      commit({ t: "message.add", post, from: "agent", via: "dash", text: `agentbook closed the panel /${c.name} opened: it shows only in a terminal.${how}` });
    }
  }

  // Background sessions sleep when nothing needs them: Claude Code ends the process and keeps the conversation,
  // and writing to the post wakes it. One sleeps after SLEEP_AFTER without a turn, and while more than MAX_AWAKE
  // run, the longest idle sleep early (after a short grace, in case you answer it). Never one that's working,
  // waiting on you, or has work of its own going (a background shell, a monitor, a scheduled wakeup).
  const SLEEP_AFTER_MS = Number(process.env.AGENTBOOK_SLEEP_AFTER_MIN ?? 30) * 60e3;
  const MAX_AWAKE = Number(process.env.AGENTBOOK_MAX_AWAKE ?? 6);
  const SLEEP_GRACE_MS = Number(process.env.AGENTBOOK_SLEEP_GRACE_SEC ?? 120) * 1e3;
  const idleSince = (s: Session) => Date.parse(s.turn_ended || s.updated || s.started) || 0;
  const span = (ms) => (ms >= 90 * 60e3 ? `${Math.round(ms / 3600e3)} hours` : ms >= 90e3 ? `${Math.round(ms / 60e3)} minutes` : "a minute");
  async function sleepIdle() {
    const awake = Object.values(state.sessions).filter((s) => s.state !== "done" && !s.asleep && !sleeping.has(s.id) && mine(s) && claude.background(s.session_id) && claude.running(claude.info(s.session_id)));
    const idle = awake
      .filter((s) => !s.busy && s.state === "idle" && !["busy", "waiting"].includes(claude.info(s.session_id).status) && !waking.has(s.id) && !store.pending(s.id).length && !claude.backgroundWork(s.session_id))
      .sort((a, b) => idleSince(a) - idleSince(b));
    let over = MAX_AWAKE > 0 ? awake.length - MAX_AWAKE : 0;
    for (const s of idle) {
      const quiet = Date.now() - idleSince(s);
      const why = SLEEP_AFTER_MS > 0 && quiet >= SLEEP_AFTER_MS ? `Idle for ${span(quiet)}` : over > 0 && quiet >= SLEEP_GRACE_MS ? `More than ${MAX_AWAKE} threads were running` : null;
      if (!why) continue;
      over--;
      await putToSleep(s, why).catch((e) => log(`couldn't put ${s.label} to sleep: ${e.message}`));
    }
  }
  // Its process ended, through agentbook or not (the policy, the SessionEnd hook and the next sync each notice):
  // the post says so once, with why.
  function asleep(post: string) {
    const s = state.sessions[post];
    if (s && !s.asleep && s.state !== "done") commit({ t: "session.sleep", post, reason: sleeping.get(post) || "Claude Code stopped it" });
  }
  async function putToSleep(s: Session, why) {
    sleeping.set(s.id, why);
    try {
      await claude.stop(s.session_id);
      asleep(s.id);
    } finally {
      sleeping.delete(s.id);
    }
  }
  // `claude agents` is a whole Claude Code starting and ending, so it runs often only while something here depends
  // on its answer: an awake background thread, which has no terminal and whose ending no hook reports, a launch or a
  // resume on its way, a panel to close, a session just heard of. A thread in a terminal reports through its hooks,
  // so an open page is no reason. Otherwise now and then, to see Claude Code update itself.
  const RUNTIME_MS = Number(process.env.AGENTBOOK_RUNTIME_MS || 4000);
  const RUNTIME_IDLE_MS = Number(process.env.AGENTBOOK_RUNTIME_IDLE_MS || 600e3);
  let lastSync = 0;
  let ticked = Date.now();
  let listUntil = 0; // a session just said hello that the last listing didn't have: which kind it is, soon
  const listSoon = () => (listUntil = Date.now() + 3 * RUNTIME_MS);
  const listingNeeded = () =>
    Date.now() < listUntil ||
    resumes.size > 0 ||
    commanded.size > 0 ||
    waking.size > 0 ||
    Object.values(state.launches).some((l) => !l.arrived && !l.error && state.agents[l.agent]?.kind === "claude-code" && Date.now() - Date.parse(l.at) < 600e3) ||
    Object.values(state.sessions).some((s) => s.state !== "done" && !s.asleep && claude.background(s.session_id));
  setInterval(() => {
    if (!started()) return;
    // This machine slept (its clock jumped past what this timer saw, which stands still meanwhile): pick up what
    // an API error cut off then.
    if (Date.now() - ticked > 60e3) pickUpAll();
    ticked = Date.now();
    if (Date.now() - lastSync < (listingNeeded() ? RUNTIME_MS : RUNTIME_IDLE_MS)) return;
    lastSync = Date.now();
    syncRuntime().catch(() => {});
  }, Math.min(1000, RUNTIME_MS)).unref();

  // What it switches to as it wakes, and the mode a session that ran in a terminal is given again.
  const picksOf = (s: Session) => ({ model: s.model_pick, effort: s.effort_pick, mode: s.mode, modePick: s.mode_pick });

  // What resuming it did: the model, effort or mode you picked switched to (or why not), and a copy Claude Code started
  // instead of resuming it (a new session with its conversation in it, and what you sent): the thread goes on in the
  // copy, so what it says is said here (session.fold). Rare now that a resume waits for a stopped session's process to
  // be gone, but Claude Code copies one it has open elsewhere, or one resumed with options of its own, all the same.
  function resumed(s: Session, r) {
    if (r?.copy && r.id && !String(s.session_id || "").startsWith(r.id)) {
      commit({ t: "session.fold", post: s.id, copy: r.id, follow: true });
      log(`${s.label}: Claude Code started a copy (${r.id}), which goes on as the same thread`);
    }
    switched(s, r);
  }
  // A model, effort or mode picked for a Claude Code session switches when agentbook next wakes or resumes it.
  function switched(s: Session, r) {
    const { model_pick: model, effort_pick: effort, mode_pick: mode } = s;
    if (!model && !effort && !mode) return;
    if (r.switchError) {
      const to = [model, effort && `${effort} effort`, mode && `${mode} mode`].filter(Boolean).join(", ");
      commit({ t: "message.add", post: s.id, from: "agent", via: "dash", text: `agentbook couldn't switch this session to ${to}, so it carries on as it was: ${r.switchError}` });
    }
    if (model) commit({ t: "session.model", post: s.id, model: null });
    if (effort) commit({ t: "session.effort", post: s.id, pick: null, ...(r.switchError ? {} : { effort }) });
    if (mode) commit({ t: "session.mode", post: s.id, pick: null, ...(r.switchError ? {} : { mode }) });
  }

  // A session resumed with what you wrote, whose first prompt hasn't come yet: it's starting, not idle, and what
  // you send meanwhile goes with that prompt (its hook takes it), rather than resuming it again.
  // One woken with a slash command has no prompt to wait for (one that prints starts no turn): it's up once it says hello.
  const commandLaunches = new Set<string>();
  // A wake its thread failed after is over too, though no session took it (blockedOnLogin: no hook ever came).
  const failedSince = (s: Session, l) => !!s.failed && Date.parse(s.failed.at) >= Date.parse(l.at);
  const starting = (s: Session) => Object.values(state.launches).some((l) => l.resume && l.post === s.id && !l.error && !l.mirrored && !commandLaunches.has(l.id) && !failedSince(s, l) && Date.now() - Date.parse(l.at) < RESUME_WAIT_MS);
  async function wakeIdle(s: Session) {
    if (s.state === "done" || s.busy || s.state === "waiting" || waking.has(s.id) || sleeping.has(s.id) || holdMs(s.id) > 0 || starting(s)) return;
    if (!s.asleep && !claude.running(claude.info(s.session_id))) return;
    const pending = store.pending(s.id).filter((o) => o.event.type !== "permission");
    if (!pending.length) return;
    // A slash command goes alone, as typed, as its prompt (what's before it goes first, what's after it next time).
    const at = pending.findIndex((o) => o.event.type === "message" && o.event.command);
    const events = at === 0 ? pending.slice(0, 1) : at > 0 ? pending.slice(0, at) : pending;
    const first = events[0].event;
    const command = at === 0 && first.type === "message" ? first : null;
    waking.set(s.id, Date.now());
    const news = command ? null : await groupNews(s.id).catch(() => null);
    const prompt = command ? command.text : [promptFor(events), news].filter(Boolean).join("\n\n");
    const lid = launchId();
    const cwd = resumeDir(s);
    if (command) commandLaunches.add(lid);
    commit({ t: "launch.add", lid, agent: s.agent, root: cwd, prompt, post: s.id, resume: true });
    try {
      resumed(s, await claude.resume({ sessionId: s.session_id, cwd, prompt, lid, label: s.label, ...picksOf(s), dirs: extraDirs(s) }));
      commit({ t: "outbox.ack", oids: events.map((o) => o.oid) });
      if (command) commanded.set(s.id, { name: command.command, bare: command.text.trim() === `/${command.command}`, at: Date.now() });
    } catch (e) {
      waking.delete(s.id);
      commit({ t: "launch.fail", lid, error: e.message });
      undelivered(s.id, events, `couldn't wake this session: ${e.message}`);
    }
  }

  // A Claude Code session whose process is gone without saying so: killed, or its machine restarted under it (a
  // stopped cloud sandbox), so no SessionEnd came. It's ended, not waiting in a terminal nobody has. Its pid says so
  // first (pid-watch.ts), then Claude Code's supervisor, which lists a session in a terminal only while it runs (and
  // never a `claude -p` run): it doesn't list it running. Either one alone could be wrong, so it takes both.
  async function processGone(s: Session) {
    if (!s || s.state === "done" || s.asleep || !mine(s) || !s.session_id || state.agents[s.agent]?.kind !== "claude-code") return false;
    if (waking.has(s.id) || resuming(s) || !(await pids.gone(s))) return false;
    if (Date.now() - (claude.listedAt(s.session_id) || 0) > 5000) await claude.refresh().catch(() => {});
    if (!claude.listedAt(s.session_id)) return false;
    const a = claude.info(s.session_id);
    return !(a && (a.kind === "background" || claude.running(a)));
  }

  return { waking, commanded, sleeping, resumes, lostEnds, syncRuntime, sleepIdle, asleep, putToSleep, listSoon, resumed, switched, picksOf, commandLaunches, failedSince, starting, wakeIdle, processGone, turnLost };
}
