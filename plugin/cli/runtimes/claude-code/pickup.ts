// Turns cut off: a background session whose turn an API error or an expired login cut off is picked up again, once
// Claude's API answers or you've signed in to Claude Code again.

import { bindAgentConfig, isDefaultAgentConfig, withAgentConfig } from "../../agent-context.ts";
import type { AgentConfig } from "../../../shared/agent-config.ts";
import { cleanEnv } from "../../drivers/claude.ts";
import { loginChangedAt, watchLogin } from "../../claude-login.ts";
import { createSignin } from "../../claude-signin.ts";
import { PASSING_ERRORS } from "../../../shared/store.ts";
import type { Session } from "../../../shared/types.ts";
import { mine } from "./host.ts";
import type { ClaudeHost } from "./host.ts";
import type { Supervisor } from "./supervisor.ts";

export type Pickup = ReturnType<typeof createPickup>;
export function createPickup(h: ClaudeHost, cc: Pick<Supervisor, "waking" | "sleeping" | "starting" | "resumed" | "picksOf">) {
  const { machine: MACHINE, state, store, commit, log, claude, pageChanged, resumeDir, extraDirs, launchId } = h;
  const { waking, sleeping, starting, resumed, picksOf } = cc;

  // A background session whose turn an API error cut off (the network dropped, the computer slept mid-reply, the API
  // was overloaded: its StopFailure hook says which) is picked up again once Claude's API answers: agentbook resumes
  // it, telling it so, as it would with a message from you. It tries a while after the error, then less and less
  // often, and again when this machine wakes up or agentbook-cli starts. One its expired login cut off is picked up
  // once you've signed in again (loginBack). A turn that ends on its own, or a message from you, settles it; one that
  // fails again after MAX_PICKUPS resumes is left for you. Not an archived one, nor other errors (a usage limit, a
  // refused request): those need you (store.ts), and writing to the thread picks them up, as Retry on it does
  // (post.pickup) with any error.
  const LOGIN = "authentication_failed";
  const PICKUP_SEC = String(process.env.AGENTBOOK_PICKUP_SEC || "20,60,300,900,1800,3600").split(",").map(Number).filter((n) => n >= 0);
  const MAX_PICKUPS = 3;
  const cut = new Map(); // post -> { step, pickups, timer, at }: the next wait in PICKUP_SEC, resumes so far, the next try
  const resumable = (s: Session) => !!s?.failed && s.state !== "done" && !s.busy && s.state !== "waiting" && mine(s) && (s.asleep ? s.sleep_reason !== "Archived" : claude.background(s.session_id));
  const pickable = (s: Session) => resumable(s) && (PASSING_ERRORS.has(s.failed.error) || s.failed.error === LOGIN);
  function pickUpIn(post: string, c, sec) {
    c.at = new Date(Date.now() + sec * 1e3).toISOString();
    c.timer = setTimeout(() => pickUp(post).catch((e) => log(`picking up ${post}: ${e.message}`)), sec * 1e3).unref();
  }
  // Try it after the next wait; `fresh` starts the waits over (this machine woke up, agentbook-cli started).
  function cutOff(post: string, fresh = false) {
    const c = cut.get(post) || { step: 0, pickups: 0 };
    if (fresh) c.step = 0;
    else if (c.timer) return;
    clearTimeout(c.timer);
    Object.assign(c, { timer: null, at: null });
    cut.set(post, c);
    const sec = PICKUP_SEC[c.step];
    // An expired login doesn't pass with time: it waits for you to sign in again.
    if (state.sessions[post].failed.error === LOGIN) loginWatch();
    else if (sec != null && c.pickups < MAX_PICKUPS) {
      c.step++;
      pickUpIn(post, c, sec);
    }
    pageChanged();
  }
  function dropCut(post: string) {
    if (!cut.has(post)) return;
    clearTimeout(cut.get(post).timer);
    cut.delete(post);
    loginWatch();
    pageChanged();
  }
  // You've signed in to Claude Code again (a session's turn got a reply, or its stored login changed, at `at`): every
  // thread an expired login cut off before then is picked up, a couple of seconds apart.
  const configOf = (agent?: string): AgentConfig | undefined => {
    const a = state.agents[agent];
    return a?.config_dir && !isDefaultAgentConfig("claude-code", a.config_dir) ? { id: a.id, name: a.name, kind: "claude-code", configDir: a.config_dir } : undefined;
  };
  const loginKey = (agent?: string) => configOf(agent)?.id || "default";
  function loginBack(at = Date.now(), agent?: string) {
    let n = 0;
    for (const [post, c] of cut) {
      const s = state.sessions[post];
      if (loginKey(s?.agent) !== loginKey(agent) || s?.failed?.error !== LOGIN || c.timer || c.pickups >= MAX_PICKUPS || Date.parse(s.failed.at) >= at) continue;
      pickUpIn(post, c, 2 * n++);
    }
    if (n) {
      log(`Claude Code is signed in again: picking up ${n} thread${n === 1 ? "" : "s"} an expired login cut off`);
      pageChanged();
    }
  }
  // While a thread waits for you to sign in, where Claude Code keeps its login is watched, and a change there picks
  // it up.
  const loginWatchers = new Map<string, { close(): void; changed(): void }>();
  const signins = new Map<string, ReturnType<typeof createSignin>>();
  const makeSignin = (agent?: string) => createSignin({ bin: () => process.env.AGENTBOOK_CLAUDE || "claude", env: (extra) => cleanEnv(extra), log, signedIn: () => loginBack(Date.now(), agent) });
  const signin = makeSignin();
  function signinFor(agent?: string) {
    const config = configOf(agent);
    if (!config) return signin;
    if (!signins.has(config.id)) signins.set(config.id, bindAgentConfig(config, makeSignin(agent)));
    return signins.get(config.id);
  }
  function loginWatch() {
    const waiting = new Map([...cut.keys()].map(post => state.sessions[post]).filter(s => s?.failed?.error === LOGIN).map(s => [loginKey(s.agent), s.agent]));
    for (const [key, agent] of waiting) if (!loginWatchers.has(key)) {
      const config = configOf(agent);
      const changed = () => { void withAgentConfig(config, () => loginChangedAt()).then(at => at && loginBack(at, agent)).catch(() => {}); };
      const watcher = withAgentConfig(config, () => watchLogin(changed));
      loginWatchers.set(key, { close: () => watcher.close(), changed });
    }
    for (const [key, watcher] of loginWatchers) if (!waiting.has(key)) { watcher.close(); loginWatchers.delete(key); }
  }
  // A session with no Claude Code login at all (none saved, or one it couldn't renew: boat-littleguys after two days
  // stopped) answers "Login expired" by itself, before its turn starts, and runs no hook: no prompt hook, no
  // StopFailure. Woken that way, its thread said nothing, and what you sent sat in a copy nothing would resume
  // (2026-11-10). Claude Code lists that session as blocked and saves why, so the thread goes on in the newest one
  // (where what you sent is) and is cut off as an expired login, as StopFailure would have said: it needs you, with its
  // Sign in, and it's picked up once you've signed in again. Only a block since its last turn started or ended counts.
  const LOGIN_SAID = /log ?in|logged out/i;
  function blockedOnLogin() {
    for (const s of Object.values(state.sessions)) {
      if (s.state === "done" || s.busy || s.failed?.error === LOGIN || !mine(s) || !s.session_id) continue;
      const since = Math.max(Date.parse(s.turn_started) || 0, Date.parse(s.turn_ended) || 0);
      const b = [s.session_id, ...(s.copies || [])]
        .map((id) => claude.blocked(id))
        .filter((x) => x && x.at > since && LOGIN_SAID.test(x.detail))
        .sort((x, y) => y.at - x.at)[0];
      if (!b) continue;
      waking.delete(s.id);
      if (b.sessionId && b.sessionId !== s.session_id) commit({ t: "session.fold", post: s.id, copy: b.id, follow: true, session_id: b.sessionId });
      commit({ t: "session.status", post: s.id, state: "idle", text: b.detail, turn: "end", failed: LOGIN });
      log(`${s.label}: Claude Code isn't signed in on ${MACHINE} (${b.detail}), so it waits for you to sign in`);
      if (pickable(state.sessions[s.id])) cutOff(s.id);
    }
  }

  // Whether Claude's API answers from here (any answer at all): until it does, a resume would fail the same way.
  async function apiAnswers() {
    try {
      await fetch(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", { method: "HEAD", signal: AbortSignal.timeout(8000) });
      return true;
    } catch {
      return false;
    }
  }
  async function pickUp(post: string) {
    const s = state.sessions[post];
    const c = cut.get(post);
    if (!c || !pickable(s)) return dropCut(post);
    Object.assign(c, { timer: null, at: null });
    // What you sent picks it up anyway (deliverQueued wakes it with that).
    if (store.pending(post).some((o) => o.event.type !== "permission")) return dropCut(post);
    const expired = s.failed.error === LOGIN;
    // Being woken already (with a message from you), it's looked at again in a while: its turn starting settles it.
    if (expired && (waking.has(post) || sleeping.has(post) || starting(s))) return pickUpIn(post, c, 20);
    if (waking.has(post) || sleeping.has(post) || starting(s) || (!expired && !(await apiAnswers()))) return cutOff(post, false);
    if (waking.has(post)) return; // Retry picked it up meanwhile
    c.pickups++;
    const prompt = expired
      ? `agentbook: Claude Code's login expired and cut your last turn off (${s.failed.text || s.failed.error}). You're signed in again, so carry on where you left off.`
      : `agentbook: an API error cut your last turn off (${s.failed.text || s.failed.error}). Claude's API answers again, so carry on where you left off.`;
    await carryOn(s, c, prompt).catch(() => cutOff(post, false));
  }
  // Resume it, told why. Its turn starting says it's no longer cut off.
  async function carryOn(s: Session, c, prompt) {
    const post = s.id;
    waking.set(post, Date.now());
    const lid = launchId();
    const cwd = resumeDir(s);
    commit({ t: "launch.add", lid, agent: s.agent, root: cwd, prompt, post, resume: true });
    try {
      resumed(s, await claude.resume({ sessionId: s.session_id, cwd, prompt, lid, label: s.label, ...picksOf(s), dirs: extraDirs(s) }));
      log(`picked up ${s.label} after an API error (${s.failed.error})`);
      c.at = new Date().toISOString(); // now: its turn starting says it's no longer cut off
      pageChanged();
    } catch (e) {
      waking.delete(post);
      commit({ t: "launch.fail", lid, error: e.message });
      log(`couldn't pick up ${s.label}: ${e.message}`);
      throw e;
    }
  }
  // Every thread an API error cut off, tried again from the first wait: when agentbook-cli starts, and when this
  // machine wakes up (see the runtime timer above). One an expired login cut off is picked up now if you've signed
  // in since.
  function pickUpAll() {
    for (const s of Object.values(state.sessions)) if (pickable(s)) cutOff(s.id, true);
    for (const watcher of loginWatchers.values()) watcher.changed();
  }

  return { LOGIN, cut, resumable, pickable, cutOff, dropCut, loginBack, signin, signinFor, blockedOnLogin, apiAnswers, pickUp, carryOn, pickUpAll };
}
