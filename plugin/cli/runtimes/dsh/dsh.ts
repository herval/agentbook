// DeepSeek Harness (dsh), which agentbook runs through dsh's Agent Client Protocol server (`dsh --profile acp`,
// kit/acp.ts), as a child.
//
// - DeepSeek is a profile ("dsh"), and each session agentbook starts with it is a thread. Sessions from dsh's own apps
//   (its web and desktop apps, its terminal) are threads too, once agentbook's plugin is added to them (plugin/dsh):
//   it connects here (/api/dsh/ws) and says what they do as they do it, and takes what you write on them, Stop,
//   Allow/Deny and answers back to dsh (see "dsh's plugin").
// - What dsh sends over ACP while a turn runs is the thread's steps: what it says, the tools it calls and how they
//   went. Its reply is the last thing it said in a turn, when no tool call followed it.
// - dsh keeps each session in a log of its own (log.ts), which agentbook reads, read-only, for a thread's steps once a
//   turn ends (its title too) and after a restart.
// - Writing on a thread sends a prompt, resuming the session first after a restart. dsh takes one prompt at a time, so
//   what you write while a turn runs waits for it to end (holds: the core delivers it then). Stop cancels the turn.
// - dsh's permission requests are Allow/Deny on the thread.
// - A thread's mode (Ask, Auto, Plan, Full access) is dsh's permission preset, and its plan mode for Plan, which ACP
//   has no setting for: agentbook's plugin for dsh, loaded into the ACP server too (a --patch overlay), sets them as
//   the thread starts, and asks the thread's questions (ask_user_question, a plan's review) on it. dsh keeps the mode
//   in the session's log, so a session resumed after a restart is in it still.
// - Its model and reasoning effort are ACP config options: picked for a thread, they're set before its next prompt.
//   The models it lists are kept (dsh-models.json), for the composer's picker before any session has started.
// - The sessions agentbook starts or resumes have agentbook's tools (ab_post, ab_ask…), at its /api/mcp address, and
//   what Codex gets as developer instructions (context.ts) follows the first prompt.
// - A session starts on the model you pick, else the one you picked in dsh's own apps (defaultModel).
// - While dsh's web or desktop app runs with agentbook's plugin (0.3.0 and up), a thread you start on agentbook starts
//   there instead (startThere): its session shows in that app too, on the app's models and keys, and the app's picker
//   lists them here. ACP is for when none is running (or AGENTBOOK_DSH_APP=0).

import { agentDataHome, currentAgentConfig, bindAgentCallback } from "../../agent-context.ts";
import { textOf } from "../../../shared/text.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ROOT, PORT } from "../../../lib/common.ts";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import type { Mode } from "../../../shared/runtimes.ts";
import { CLI_HOME } from "../../../shared/store.ts";
import type { AnswerEvent, PermissionEvent } from "../../../shared/types.ts";
// A dsh plugin's connection (shared/ws.ts's accept): what it sends comes to onMessage, and onClose once it's gone.
import type { WebSocket as PluginSocket } from "../../../shared/ws.ts";
import { going, settle, stateOf } from "../../workers.ts";
import type { Worker } from "../../workers.ts";
import { createAcp } from "../kit/acp.ts";
import { runtimeProviders } from "../../runtime-providers.ts";
import type { AcpServer } from "../kit/acp.ts";
import { onPath, startFolder } from "../kit/spawn.ts";
import { addSay, addTool, blank, iso, liveOf, short, summaryOf, toolDone, toolTitle } from "../kit/steps.ts";
import type { Models, Runtime, RuntimeContext, RuntimeRow, StartRequest } from "../runtime.ts";
import { defaultModel, digestOf, foldEvent, HOME_DIR, modelsOf, quiet, readLog, valueOfId } from "./log.ts";
import type { DshDigest } from "./log.ts";

const MISSING = "DeepSeek Harness isn't installed here (the dsh command).";
const MODELS_FILE = () => path.join(agentDataHome(CLI_HOME), "dsh-models.json");
const PATCH_FILE = () => path.join(agentDataHome(CLI_HOME), "dsh-acp.patch.yml");
const MODE_NAMES: Record<Mode, string> = { ask: "Ask", auto: "Auto", plan: "Plan", full: "Full access" };

// A dsh process with agentbook's plugin (connect): its connection, its profile (web, desktop…), the plugin's version,
// its pid, what it can do (`can`), when it said hello, its app's models, and the sessions it said.
interface Link {
  ws: PluginSocket;
  profile: string;
  plugin: string | null;
  pid: number | null;
  sessions: Set<string>;
  can?: string[];
  at?: number;
  models?: Models | null;
  // It's in agentbook's own ACP server (its hello says this process's token).
  own?: boolean;
}
// A tool call a session made, for an Allow/Deny that asks about it.
interface Call {
  name: string;
  args: Record<string, unknown>;
}
// What's known of a thread's session: its steps, its tool calls, its reply so far (and the message it's from), whether
// it works, when its turn started, and whether its log was read. For a session in dsh's own apps: the connection it
// came on (`link`), its folder, status, a subagent's parent, and what it said went wrong (`error`), until that's said
// on its thread.
interface Conv {
  digest: DshDigest;
  calls: Map<string, Call>;
  reply: string | null;
  replyOf: string | null;
  busy: boolean;
  started: number | null;
  loaded: boolean;
  link?: Link | null;
  cwd?: string;
  status?: string | null;
  parent?: string;
  error?: string | null;
}
// What dsh's ACP server answers (the fields read here).
interface AcpResult {
  configOptions?: unknown[];
  stopReason?: string;
  sessionId?: string;
}
// One of a plugin's sessions' questions, as asked on the thread (`qid`), with its options.
interface AskQuestion {
  id: string;
  qid: string;
  options: { label: string; detail: string | null; full: string }[];
}
// What a plugin asks for a thread: Allow/Deny, or questions, answered once they all are.
interface ApprovalAsk {
  kind: "approval";
  ask: string;
  id: string;
  link: Link;
}
interface QuestionsAsk {
  kind: "questions";
  ask: string;
  id: string;
  link: Link;
  questions: AskQuestion[];
  qids: Map<string, AskQuestion>;
  answers: Record<string, { id: string; selected: string[]; custom?: string }>;
}
// A subagent as a worker, with the name its parent gave it.
type DshWorker = Worker & { named?: string };

export function createDsh(): Runtime {
  const config = currentAgentConfig();
  const AGENT = config?.id || "dsh";
  const NAME = config?.name || "DeepSeek";
  let ctx: RuntimeContext = null;
  const log = (line: string) => ctx?.log(line);
  const bin = () => onPath(process.env.AGENTBOOK_DSH_BIN || "dsh");
  const enabled = process.env.AGENTBOOK_DSH !== "0";
  let lastError = null;
  let models: Models | null = (() => {
    try {
      return JSON.parse(fs.readFileSync(MODELS_FILE(), "utf8"));
    } catch {
      return null;
    }
  })();
  // thread id (dsh's session id) -> what's known of its session
  const posts = new Map<string, Conv>();

  const post = (id: string) => ctx.state.sessions[id];
  const conv = (id: string): Conv => {
    if (!posts.has(id)) posts.set(id, { digest: blank(), calls: new Map(), reply: null, replyOf: null, busy: false, started: null, loaded: false });
    return posts.get(id);
  };
  const say = (id: string, text: string) => ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text });
  // It can't go on: "DeepSeek stopped: <why>", as the core says it.
  const failed = (id: string, why: string) => ctx.emit({ e: "failed", thread: id, why });
  const changed = (id: string, save?: boolean) => ctx.emit({ e: "changed", thread: id, ...(save ? { save } : {}) });

  // A thread's steps, from its session's log (all of them, after a restart, and what ACP sent anyway once a turn
  // ends). The log stays where it is when it can't be read.
  function reload(id: string) {
    const c = conv(id);
    c.loaded = true;
    try {
      const events = readLog(id);
      if (!events?.length) return;
      const d = digestOf(events, post(id)?.cwd);
      // dsh writes its log in batches: one behind what its plugin already said stays where it is.
      if (c.digest.seq && (d.seq || 0) < c.digest.seq) return;
      d.turn = Math.max(d.turn, c.digest.turn);
      d.model ||= c.digest.model;
      d.context ||= c.digest.context;
      c.digest = d;
      changed(id);
    } catch (e) {
      log(`dsh log ${id}: ${e.message}`);
    }
  }

  // Its thread, for a session agentbook starts (a launch) or one you wrote to in dsh's app. The core names it and fills
  // in its proc, kind and git facts.
  function ensurePost(id: string, { cwd, lid, prompt }: { cwd: string; lid?: string; prompt?: string }) {
    if (post(id) && !lid) return post(id);
    ctx.emit({ e: "thread", thread: id, agent: AGENT, agent_name: NAME, cwd, host: os.hostname().split(".")[0], launch: lid, started: new Date().toISOString(), prompt: prompt ? short(prompt, 2000) : undefined });
    changed(id, true);
    return post(id);
  }

  // Its turn began or ended: the core makes the thread working or not, brings back a done one, settles what's still
  // open as a turn ends, and delivers what was held for it then. Whether it works is set first, as the core asks it
  // whether the thread holds what's sent.
  function setBusy(id: string, busy: boolean) {
    if (!post(id)) return;
    conv(id).busy = busy;
    ctx.emit(busy ? { e: "turn.start", thread: id } : { e: "turn.end", thread: id });
  }

  /* ---------- ACP: dsh's Agent Client Protocol server ---------- */

  // agentbook's plugin in it, with this process's token (`own`), which its hello says back: by path, in an overlay
  // (--patch), or only its config when the ACP profile has it already (`dsh plugin --profile acp add`). Without the
  // overlay (it couldn't be written), the server starts all the same, and its threads stay in dsh's default mode.
  const OWN = crypto.randomUUID();
  function withPlugin(): string[] {
    const config = { url: (process.env.AGENTBOOK_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, ""), own: OWN };
    let added = false;
    try {
      added = !!JSON.parse(fs.readFileSync(path.join(HOME_DIR(), "profiles", "acp", "package.json"), "utf8"))?.dsh?.profile?.bundles?.includes("agentbook-dsh");
    } catch {}
    const patch = [...(added ? [{ id: "agentbook", config }] : [{ insert: [{ id: "agentbook", name: path.join(PLUGIN_ROOT, "dsh", "index.js"), config }] }]), ...runtimeProviders.dshPatch()];
    try {
      fs.mkdirSync(path.dirname(PATCH_FILE()), { recursive: true });
      fs.writeFileSync(PATCH_FILE(), JSON.stringify(patch) + "\n", { mode: 0o600 });
      return ["--patch", PATCH_FILE()];
    } catch (e) {
      log(`dsh: couldn't write ${PATCH_FILE()}: ${e.message}`);
      return [];
    }
  }
  let acpAt = 0;
  const acp = createAcp({
    name: "dsh",
    prefix: "ds",
    command: bin,
    env: () => runtimeProviders.env("dsh"),
    get args() {
      return ["--profile", "acp", ...withPlugin()];
    },
    missing: MISSING,
    // Its errors say what kind they are first ("Internal error: <what went wrong>").
    errorText: (m) => (m || "dsh refused").replace(/^(Internal error|Invalid params): /, ""),
    onUpdate: (p) => onUpdate(p as { sessionId?: string; update?: Record<string, unknown> }),
    onPermission: (p, key) => askPermission(p, key),
    onReady: () => {
      lastError = null;
      acpAt = Date.now();
    },
  });
  // The server, started once it's needed. Why it didn't start, once it was there to try, is its row's "Last time".
  function startAcp() {
    const ready = acp.start();
    if (acp.current()) ready.catch((e) => (lastError = e.message));
    return ready;
  }

  // What dsh says while a turn runs, on its thread's steps.
  function onUpdate({ sessionId: id, update: u }: { sessionId?: string; update?: Record<string, any> }) {
    if (!id || !u || !posts.has(id)) return;
    const c = conv(id);
    const d = c.digest;
    const at = new Date().toISOString();
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? u.content.text || "" : "";
        if (!text.trim()) return;
        addSay(d, { id: `${u.messageId || "m"}-${d.steps.length}`, at, text });
        c.reply = c.replyOf && c.replyOf === u.messageId && c.reply ? `${c.reply}\n\n${text}` : text;
        c.replyOf = u.messageId || null;
        break;
      }
      case "tool_call":
        c.calls.set(u.toolCallId, { name: u.title, args: u.rawInput });
        if (!quiet(u.title)) addTool(d, { id: u.toolCallId, at, name: u.title, args: u.rawInput, cwd: post(id)?.cwd });
        c.reply = null;
        if (quiet(u.title)) return;
        break;
      case "tool_call_update": {
        if (u.status !== "completed" && u.status !== "failed") return;
        const out = (u.content || []).map((x) => (x?.content?.type === "text" ? x.content.text : "")).join("\n").trim();
        toolDone(d, u.toolCallId, { at, error: u.status === "failed" ? out || "Failed" : null, output: out });
        break;
      }
      case "usage_update":
        if (u.used) d.context = u.used;
        break;
      case "config_option_update":
        noteOptions(id, u.configOptions);
        break;
      default:
        return;
    }
    changed(id);
  }

  function noteOptions(id: string | null, options: unknown) {
    const m = modelsOf(options);
    if (!m) return;
    if (JSON.stringify(m) !== JSON.stringify(models)) {
      models = m;
      try {
        fs.mkdirSync(path.dirname(MODELS_FILE()), { recursive: true });
        fs.writeFileSync(MODELS_FILE(), JSON.stringify(m));
      } catch {}
    }
    if (id && m.default) conv(id).digest.model = m.default.split("/").slice(1).join("/");
  }

  // dsh asks before a tool runs (by its call's id): Allow/Deny on the thread, with what the call was. Not a thread's:
  // it's cancelled (kit/acp.ts).
  function askPermission(p: { sessionId?: string; toolCall?: Record<string, unknown> }, key: string) {
    const id = p.sessionId;
    if (!id || !post(id)) return null;
    const call: Partial<Call> = conv(id).calls.get(String(p.toolCall?.toolCallId)) || {};
    const args: Record<string, unknown> = call.args && typeof call.args === "object" ? call.args : {};
    const name = String(call.name || p.toolCall?.title || "");
    ctx.emit({
      e: "ask",
      thread: id,
      kind: "permission",
      request_id: key,
      title: "Allow this?",
      tool_name: /^(bash|pwsh|shell|exec)/i.test(name) ? "Terminal" : name || NAME,
      detail: name ? toolTitle(name, call.args, post(id)?.cwd) : `${NAME} wants to go ahead with this.`,
      preview: String(args.command ?? args.file_path ?? args.path ?? args.url ?? ""),
    });
    return id;
  }

  // The ACP server, with the thread's session open in it: resumed (with agentbook's tools) when it isn't yet.
  async function ready(id: string) {
    const a = await startAcp();
    if (!a.open.has(id)) {
      const cwd = post(id)?.cwd || os.homedir();
      const r = await a.rpc.call<AcpResult>("session/resume", { sessionId: id, cwd, mcpServers: acp.equip(ctx, a, `dsh:${id}`, cwd) });
      a.open.add(id);
      noteOptions(id, r?.configOptions);
      await adopt(id);
    }
    return a;
  }

  // Set a config option, saying on the thread when dsh won't. True when it took it.
  async function setOption(a: AcpServer, id: string, configId: string, value: string, what: string) {
    try {
      noteOptions(id, (await a.rpc.call<AcpResult>("session/set_config_option", { sessionId: id, configId, value }))?.configOptions);
      return true;
    } catch (e) {
      say(id, `agentbook couldn't switch this thread to ${what}, so it carries on as it was: ${e.message}`);
      return false;
    }
  }
  // The model picked for the thread goes with its next prompt.
  async function applyPick(a: AcpServer, id: string) {
    const pick = post(id)?.model_pick;
    if (!pick) return;
    const value = valueOfId(pick);
    if (value) await setOption(a, id, "model", value, pick);
    else say(id, `agentbook couldn't switch this thread to ${pick}: dsh's models are named provider/model.`);
    ctx.emit({ e: "fact", op: { t: "session.model", post: id, model: null } });
  }

  // A prompt as a turn: the thread works until dsh answers it, and then says the turn's reply. `then`: text to go
  // after it (the first prompt's context: after, since dsh names the session after what its first prompt starts with).
  function turn(a: AcpServer, id: string, text: string, then?: string | null) {
    const c = conv(id);
    c.reply = null;
    c.replyOf = null;
    c.started = Date.now();
    c.digest.turn++;
    setBusy(id, true);
    const prompt = [{ type: "text", text }, ...(then ? [{ type: "text", text: then }] : [])];
    a.rpc
      .call<AcpResult>("session/prompt", { sessionId: id, prompt }, 0)
      .then((r) => {
        if (c.reply) say(id, c.reply);
        else if (r?.stopReason && !["end_turn", "cancelled"].includes(r.stopReason)) failed(id, `${r.stopReason.replace(/_/g, " ")}.`);
      })
      .catch((e) => failed(id, e.message))
      .finally(() => {
        c.digest.worked += Date.now() - c.started;
        c.reply = null;
        reload(id);
        // What came while it worked goes now, as the core delivers what was held for it.
        setBusy(id, false);
      });
  }

  // A message as the thread's next prompt. It's never sent while a turn runs: the thread holds it until then (holds).
  async function send(id: string, text: string) {
    const a = await ready(id);
    await applyPick(a, id);
    turn(a, id, text);
  }

  /* ---------- dsh's plugin: the sessions in dsh's own apps ---------- */

  // Each dsh process with agentbook's plugin (plugin/dsh: its web app, its desktop app, a terminal) is a connection
  // here, and says what its sessions do as they do it. A session you start there is a thread once you write to it (its
  // turns from before come from its log), with agentbook's tools from then on; its subagents are workers on its
  // thread. What you write on the thread, Stop, and your answers to what it asks go back through the plugin, which
  // asks dsh as its own apps do.
  const links = new Set<Link>();
  // What a plugin answered a call with: for "create", the session it made.
  type Done = { id?: string } | null | undefined;
  const calls = new Map<string, { resolve(v: Done): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; link: Link }>(); // what agentbook asked a plugin to do, by its rid
  const asked = new Map<string, ApprovalAsk | QuestionsAsk>(); // what a plugin asks for a thread, by "dsp-<its key>"
  let rids = 0;
  // Threads whose session runs in one of dsh's apps: id -> that app's profile (web, desktop…). Kept, so after a
  // restart agentbook still doesn't write to one through its own ACP server, which would have two processes writing
  // its log.
  const THEIRS = () => path.join(agentDataHome(CLI_HOME), "dsh-sessions.json");
  const theirs: Record<string, string> = (() => {
    try {
      return JSON.parse(fs.readFileSync(THEIRS(), "utf8")) || {};
    } catch {
      return {};
    }
  })();
  const keepTheirs = () => {
    try {
      fs.mkdirSync(path.dirname(THEIRS()), { recursive: true });
      fs.writeFileSync(THEIRS(), JSON.stringify(theirs));
    } catch (e) {
      log(`dsh: couldn't keep ${THEIRS()}: ${e.message}`);
    }
  };
  const workerRoot = new Map<string, string>(); // a subagent's session -> the thread it works for
  const workers = new Map<string, Map<string, DshWorker>>(); // thread id -> its subagents by session id, as workers.ts says them
  const appOf = (profile: string | null) => (profile === "web" ? "DeepSeek's web app" : profile === "desktop" ? "DeepSeek's desktop app" : `dsh (${profile || "its own app"})`);
  // Where a thread's session runs now, when that isn't agentbook's ACP server: its profile, or null.
  const elsewhere = (id: string) => conv(id).link?.profile || theirs[id] || null;
  // Sessions open in agentbook's own ACP server are agentbook's: a plugin added to that profile too doesn't say them.
  const ours = (id: string) => !!acp.current()?.open.has(id);
  // The connection a thread's messages go through: the one that said its session, else one from its app (whose
  // plugin opens the session there first).
  const linkFor = (id: string) => {
    const c = conv(id);
    if (c.link && links.has(c.link)) return c.link;
    const app = elsewhere(id);
    return app ? [...links].find((l) => l.profile === app) || null : null;
  };

  // Something for a plugin to do ({ t: "message" | "stop" | "equip" }): it answers { t: "done", rid, error? }.
  function call(link: Link, m: Record<string, unknown>, timeout = 30e3) {
    return new Promise<Done>((resolve, reject) => {
      const rid = `agentbook-${process.pid}-${Date.now().toString(36)}-${++rids}`;
      const timer = setTimeout(() => {
        calls.delete(rid);
        reject(new Error(`${appOf(link.profile)} didn't answer.`));
      }, timeout);
      timer.unref?.();
      calls.set(rid, { resolve, reject, timer, link });
      try {
        link.ws.send(JSON.stringify({ ...m, rid }));
      } catch (e) {
        clearTimeout(timer);
        calls.delete(rid);
        reject(e);
      }
    });
  }

  // What you wrote, to a session in dsh's app. It comes back from dsh as yours, with agentbook's id for it, and isn't
  // shown twice (onEvent).
  async function sendThere(id: string, text: string) {
    const link = linkFor(id);
    if (!link) throw new Error(`${appOf(elsewhere(id))} isn't running`);
    await pickThere(link, id);
    await call(link, { t: "message", id, text });
  }
  // The model picked for a thread there goes with its next message, as dsh's own picker sets one.
  async function pickThere(link: Link, id: string) {
    const pick = post(id)?.model_pick;
    if (!pick) return;
    if (!link.can?.includes("model")) say(id, `agentbook couldn't switch this thread to ${pick}: pick it in ${appOf(link.profile)}, or update agentbook's plugin for dsh there.`);
    else await call(link, { t: "model", id, model: pick }).catch((e) => say(id, `agentbook couldn't switch this thread to ${pick}, so it carries on as it was: ${e.message}`));
    ctx.emit({ e: "fact", op: { t: "session.model", post: id, model: null } });
  }

  // Where a thread you start goes: the dsh app running with agentbook's plugin (the one that connected last, when
  // there are two), else agentbook's own ACP server. Never the ACP profile's own plugin.
  const appLink = () =>
    process.env.AGENTBOOK_DSH_APP === "0" || runtimeProviders.info("dsh").configured
      ? null
      : [...links].filter((l) => l.can?.includes("create") && !l.own && l.profile !== "acp").sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;

  // agentbook's plugin in its ACP server, once it said hello: waited for as a thread starts or comes back, until a
  // while after the server started, so a dsh whose plugin didn't load doesn't hold up each thread.
  const ownWaits = new Set<() => void>();
  const ownLink = () => [...links].find((l) => l.own) || null;
  async function untilOwn(ms = 10e3): Promise<Link | null> {
    const left = acpAt + ms - Date.now();
    if (ownLink() || left <= 0) return ownLink();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        ownWaits.delete(done);
        resolve();
      };
      const timer = setTimeout(done, left);
      ownWaits.add(done);
    });
    return ownLink();
  }
  // A session agentbook runs over ACP: its questions are asked on its thread, and, as it starts, it's put in the
  // thread's mode (Auto, dsh's default, when none was picked). Back after a restart, its mode is in its log already.
  async function adopt(id: string, mode?: Mode | null) {
    const link = await untilOwn();
    if (link) await call(link, { t: "adopt", id }).catch((e) => log(`dsh: ${id}'s questions: ${e.message}`));
    if (mode === undefined) return;
    if (link?.can?.includes("mode")) return void (await setMode(link, id, mode || "auto"));
    if (mode && mode !== "auto") say(id, `agentbook couldn't put DeepSeek in ${MODE_NAMES[mode]} mode: its plugin isn't in dsh's ACP server, so it carries on in Auto.`);
  }
  async function setMode(link: Link, id: string, mode: Mode) {
    await call(link, { t: "mode", id, mode }).catch((e) => say(id, `agentbook couldn't put DeepSeek in ${MODE_NAMES[mode]} mode, so it carries on in dsh's default: ${e.message}`));
  }

  // A thread you start, in dsh's app: a new session there (its plugin makes it as the app's New Session does), the
  // model you picked, agentbook's tools on it, and then your message, with what agentbook tells the agents it starts
  // as context for the model. The thread is the app's from then on (theirs), so what you write goes there, never to
  // agentbook's ACP server.
  async function startThere(link: Link, { cwd, prompt, shown, lid, model, effort, mode }: StartRequest) {
    const made = await call(link, { t: "create", cwd });
    const id = String(made?.id || "");
    if (!id) throw new Error(`${appOf(link.profile)} didn't say which session it made.`);
    const c = conv(id);
    c.link = link;
    c.cwd = cwd;
    c.loaded = true;
    link.sessions.add(id);
    theirs[id] = link.profile;
    keepTheirs();
    const context = await Promise.resolve(ctx.context({ launch: lid, cwd })).catch((e) => log(`dsh context: ${e.message}`));
    ensurePost(id, { cwd, lid, prompt });
    ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
    // What you picked; else the app's own (nothing to set).
    const want = model || (effort ? link.models?.default : null);
    if (want) await call(link, { t: "model", id, model: want, effort: effort || undefined }).catch((e) => say(id, `agentbook couldn't start this thread on ${want}${effort ? ` (${effort} reasoning)` : ""}, so it runs on ${appOf(link.profile)}'s default: ${e.message}`));
    if (link.can?.includes("mode")) await setMode(link, id, mode || "auto");
    else if (mode && mode !== "auto") say(id, `agentbook couldn't put DeepSeek in ${MODE_NAMES[mode]} mode: update agentbook's plugin for dsh in ${appOf(link.profile)}, so it carries on in its default.`);
    // The tools first, so its first step has them.
    await call(link, { t: "equip", id, url: ctx.mcp(`dsh:${id}`, cwd).url }).catch((e) => log(`dsh plugin (${link.profile}): agentbook's tools for ${id}: ${e.message}`));
    await call(link, { t: "message", id, text: prompt, context: typeof context === "string" ? context : undefined }).catch((e) => say(id, `couldn't hand your message to ${appOf(link.profile)}: ${e.message}`));
    log(`dsh: started ${id} in ${link.profile}`);
    return { id };
  }

  // agentbook's tools for a thread's session there, an MCP server writing to the thread. The plugin also hears from it
  // that the session is a thread, so what it asks is asked here.
  function arm(link: Link | null | undefined, id: string) {
    if (!link || !post(id)) return;
    const { url } = ctx.mcp(`dsh:${id}`, post(id)?.cwd || conv(id).cwd);
    call(link, { t: "equip", id, url }).catch((e) => log(`dsh plugin (${link.profile}): agentbook's tools for ${id}: ${e.message}`));
  }

  // dsh asks before a tool runs, or its ask_user_question asks you: Allow/Deny, or each question, on the thread. dsh's
  // own app asks too, and whichever you answer first goes; one answered there closes it here ("settled").
  function onAsk(link: Link, m) {
    const id = String(m.id || "");
    if (!m.ask || !post(id)) return;
    const key = `dsp-${m.ask}`;
    if (asked.has(key)) return void (asked.get(key).link = link); // asked again once its connection came back
    if (m.kind === "approval") {
      asked.set(key, { kind: "approval", ask: m.ask, id, link });
      const c = conv(id);
      const step = c.digest.byId?.get(m.call);
      const args = c.calls.get(m.call)?.args || {};
      const tool = String(m.tool || c.calls.get(m.call)?.name || "");
      return void ctx.emit({
        e: "ask",
        thread: id,
        kind: "permission",
        request_id: key,
        title: "Allow this?",
        tool_name: /^(bash|pwsh|shell|exec)/i.test(tool) ? "Terminal" : tool || NAME,
        detail: short(m.reason || step?.title || `${NAME} wants to go ahead with this.`, 1000),
        preview: short(String(args.command ?? args.file_path ?? args.path ?? args.url ?? ""), 2000),
      });
    }
    if (m.kind !== "questions") return;
    const a: QuestionsAsk = { kind: "questions", ask: m.ask, id, link, questions: [], qids: new Map(), answers: {} };
    asked.set(key, a);
    for (const q of (Array.isArray(m.questions) ? m.questions : []).slice(0, 8)) {
      const options = (q.options || []).slice(0, 6).map((o) => ({ label: short(String(o.label || ""), 80), detail: short(o.description, 140) || null, full: String(o.label || "") }));
      const op = ctx.emit({ e: "ask", thread: id, kind: options.length ? "choice" : "text", title: short(String(q.question || "DeepSeek asks"), 300), detail: short(q.header || q.detail || "", 300), options: options.map(({ full, ...o }) => o), key: `${key}:${q.id}`, blocks: true });
      if (!op) continue;
      const one = { id: String(q.id), qid: op.qid, options };
      a.questions.push(one);
      a.qids.set(one.qid, one);
    }
  }

  // Your answer, to the plugin: true when it was one of its asks.
  function answerThere(id: string, e: PermissionEvent | AnswerEvent) {
    if (e.type === "permission") {
      const a = asked.get(e.request_id);
      if (a?.kind !== "approval") return false;
      asked.delete(e.request_id);
      tellAsk(a, { t: "answer", ask: a.ask, value: e.behavior === "allow" ? "allow" : "deny" });
      return true;
    }
    for (const [key, a] of asked) {
      const one = a.kind === "questions" && a.qids.get(e.question_id);
      if (!one) continue;
      const v = e.skipped || e.value == null ? "" : String(e.value);
      const picked = v && one.options.find((o) => o.label === v || o.full === v);
      a.answers[one.id] = picked ? { id: one.id, selected: [picked.full] } : v ? { id: one.id, selected: [], custom: v } : { id: one.id, selected: [] };
      if (a.questions.every((q) => a.answers[q.id])) {
        asked.delete(key);
        tellAsk(a, { t: "answer", ask: a.ask, value: { answers: a.questions.map((q) => a.answers[q.id]) } });
      }
      return true;
    }
    return false;
  }
  const tellAsk = (a: ApprovalAsk | QuestionsAsk, m: Record<string, unknown>) => {
    const link = links.has(a.link) ? a.link : linkFor(a.id);
    if (!link) throw new Error(`${appOf(elsewhere(a.id))} isn't running`);
    link.ws.send(JSON.stringify(m));
  };

  // Answered in dsh's app (or it stopped asking: its turn ended): its questions here close, with that answer.
  function settleAsk(key: string, value, by: string) {
    const a = asked.get(key);
    if (!a) return;
    asked.delete(key);
    const answered = (qid: string, v: string | null) => ctx.emit({ e: "fact", op: { t: "question.answer", qid, value: v, by } });
    if (a.kind === "approval") {
      const q = ctx.state.questions.find((x) => x.request_id === key && !x.answered);
      if (q) answered(q.id, value === "allowed-once" ? "allow" : value === "rejected" ? "deny" : null);
      return;
    }
    for (const one of a.questions) {
      const x = Array.isArray(value) ? value.find((v) => v?.id === one.id) : null;
      const q = ctx.state.questions.find((y) => y.id === one.qid && !y.answered);
      if (q) answered(q.id, x ? String(x.selected?.[0] ?? x.custom ?? "") || null : null);
    }
  }

  function connectPlugin(ws: PluginSocket) {
    const link: Link = { ws, profile: "dsh", plugin: null, pid: null, sessions: new Set() };
    links.add(link);
    ws.onMessage = bindAgentCallback((text) => {
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      try {
        heard(link, m);
      } catch (e) {
        log(`dsh plugin (${link.profile}): ${e.message}`);
      }
    });
    // The process ended (or agentbook is): its sessions aren't running anymore, and its subagents went with it. What
    // it asked is gone with it (a plugin that comes back asks again).
    ws.onClose = bindAgentCallback(() => {
      links.delete(link);
      for (const [rid, w] of calls)
        if (w.link === link) {
          calls.delete(rid);
          clearTimeout(w.timer);
          w.reject(new Error(`${appOf(link.profile)} stopped.`));
        }
      for (const [key, a] of [...asked]) if (a.link === link) settleAsk(key, null, "gone");
      const at = new Date().toISOString();
      for (const id of link.sessions) {
        const c = conv(id);
        if (c.link !== link) continue;
        c.link = null;
        if (post(id)) setBusy(id, false);
      }
      for (const [id, list] of workers)
        for (const w of list.values())
          if (link.sessions.has(w.id) && going(w)) {
            settle(w, "stopped", at, `${appOf(link.profile)} stopped.`);
            changed(id);
          }
    });
  }

  function heard(link: Link, m) {
    switch (m.t) {
      case "hello":
        link.profile = short(String(m.profile || "dsh"), 40);
        link.plugin = short(String(m.plugin || ""), 20) || null;
        link.pid = Number(m.pid) || null;
        link.can = Array.isArray(m.can) ? m.can.map(String) : [];
        link.at = Date.now();
        link.own = m.own === OWN;
        if (!ctx.state.agents[AGENT]) ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: "dsh" });
        log(`dsh plugin ${link.plugin} connected from ${link.own ? "agentbook's ACP server" : link.profile} (pid ${link.pid})`);
        if (link.own) return void [...ownWaits].forEach((w) => w());
        // What you wrote while its app wasn't running goes now.
        for (const [id, app] of Object.entries(theirs)) if (app === link.profile && post(id) && ctx.pending(id).length) ctx.deliver(id);
        return;
      case "session":
        return onSession(link, m);
      case "models": {
        const list = (Array.isArray(m.list) ? m.list : []).filter((x) => x && typeof x.id === "string" && x.id.includes("/")).slice(0, 200).map((x) => ({ id: short(x.id, 400), name: short(String(x.name || x.id), 200), efforts: (Array.isArray(x.efforts) ? x.efforts : []).map(String).slice(0, 20), effort: x.effort ? String(x.effort) : null }));
        const def = list.find((x) => x.id === m.default) || null;
        link.models = list.length ? { list, default: def?.id || list[0].id, efforts: (def || list[0]).efforts, effort: m.effort || (def || list[0]).effort || null } : null;
        return;
      }
      case "done": {
        const w = calls.get(m.rid);
        if (!w || w.link !== link) return;
        calls.delete(m.rid);
        clearTimeout(w.timer);
        return void (m.error ? w.reject(new Error(short(String(m.error), 1000))) : w.resolve(m.value));
      }
      case "ask":
        return onAsk(link, m);
      case "settled":
        return settleAsk(`dsp-${m.ask}`, m.value ?? null, "terminal");
      case "event":
        return onEvent(link, String(m.id || ""), m.e);
      case "status":
        return onStatus(link, String(m.id || ""), m.status);
      case "error": {
        const id = String(m.id || "");
        if (!id || ours(id)) return;
        conv(id).error = short(String(m.error || "Failed"), 1000);
        return;
      }
      case "gone": {
        const id = String(m.id || "");
        const c = conv(id);
        if (c.link !== link) return;
        c.link = null;
        if (post(id)) setBusy(id, false);
        return;
      }
      case "subagent":
        return onSubagent(link, m);
    }
  }

  function onSession(link: Link, m) {
    const id = String(m.id || "");
    if (!id || ours(id)) return;
    link.sessions.add(id);
    const c = conv(id);
    c.link = link;
    if (m.cwd) c.cwd = String(m.cwd);
    c.status = m.status || c.status || null;
    if (m.parent) {
      c.parent = String(m.parent);
      return void worker(rootFor(c.parent), id, { started: iso(m.created) });
    }
    if (!post(id)) return; // a thread once you write to it
    claim(id);
    reload(id); // what it did while agentbook wasn't connected to it
    setBusy(id, c.status === "running");
    arm(link, id);
    changed(id);
    if (ctx.pending(id).length) ctx.deliver(id);
  }

  // The thread is this app's session now: agentbook doesn't write to it through its own ACP server. One agentbook
  // started (a launch) is only while it's open there.
  function claim(id: string) {
    const c = conv(id);
    if (!c.link || post(id)?.launch || theirs[id] === c.link.profile) return;
    theirs[id] = c.link.profile;
    keepTheirs();
  }

  // A session you wrote to in dsh's app: its thread, with its turns from before (its log).
  function activate(id: string, prompt: string) {
    if (post(id)) return post(id);
    const c = conv(id);
    if (!c.link) return null;
    ensurePost(id, { cwd: c.cwd || os.homedir(), prompt });
    if (ctx.keptOff(id)) return null; // kept off agentbook (Private terminals)
    claim(id);
    reload(id);
    if (c.status === "running") setBusy(id, true);
    arm(c.link, id);
    return post(id);
  }

  function onEvent(link: Link, id: string, e) {
    if (!id || !e?.type || ours(id)) return;
    const c = conv(id);
    if (c.parent) return workerEvent(id, e);
    if (e.seq != null && c.digest.seq && e.seq <= c.digest.seq) return; // in what was read from its log already
    foldEvent(c.digest, e, c.cwd || post(id)?.cwd);
    const x = e.data || {};
    switch (e.type) {
      case "turn/start":
        c.reply = null;
        break;
      // It started a subagent (dsh's subagent tool): a worker on its thread, named as it named it.
      case "subagent/catalog":
        if (x.childId) worker(id, String(x.childId), { started: iso(x.childCreatedAt), title: x.label });
        break;
      case "user/message": {
        // What you wrote: dsh's other user messages are what it tells the model (its instructions, the time…). What
        // you wrote here (agentbook's id for it) is on the thread already: dsh's echoes are told apart by that id
        // (echoes "self").
        const text = textOf(x.content).trim();
        if (x.source?.kind !== "user" || !text || String(x.source.rpcId || "").startsWith("agentbook-")) break;
        if (!activate(id, text)) break;
        ctx.emit({ e: "message", thread: id, from: "human", via: "terminal", text: short(text, 16000) });
        break;
      }
      case "assistant/message": {
        const blocks = x.message?.content || [];
        const said = textOf(blocks).trim();
        // Its reply is what it says last in a turn, with no tool to run after it.
        c.reply = blocks.some((b) => /^tool[-_]?call$|^toolCall$/.test(b?.type || "")) ? null : said || c.reply;
        break;
      }
      case "tool/call": {
        c.reply = null;
        // What it calls, for an Allow/Deny that asks about it.
        let args = x.arguments;
        try {
          args = typeof args === "string" ? JSON.parse(args) : args;
        } catch {}
        if (x.callId) c.calls.set(x.callId, { name: x.name, args: args && typeof args === "object" ? args : {} });
        if (c.calls.size > 200) c.calls.delete(c.calls.keys().next().value);
        break;
      }
      case "turn/end":
        if (post(id)) {
          if (c.reply) say(id, c.reply);
          else if (c.error) failed(id, c.error);
        }
        c.reply = null;
        c.error = null;
        break;
    }
    if (post(id)) changed(id);
  }

  function onStatus(link: Link, id: string, status: string) {
    if (!id || ours(id)) return;
    const c = conv(id);
    c.status = status;
    if (c.parent) return void (status === "running" && workerIs(id, "running"));
    if (!post(id)) return;
    setBusy(id, status === "running");
    // An error with no turn to end (it couldn't start one) is said once it stops.
    if (status !== "running" && c.error) {
      failed(id, c.error);
      c.error = null;
    }
  }

  /* ---------- its subagents, as workers ---------- */

  // dsh's subagents run in the background, and one that finished waits for more (its parent can send it some): it's
  // done until it works again. One ends for good (subagent/end) when dsh lets it go.
  const rootFor = (id: string) => workerRoot.get(id) || id;
  function worker(root: string, id: string, { started, title }: { started?: string | null; title?: string } = {}) {
    workerRoot.set(id, root);
    const list = workers.get(root) || workers.set(root, new Map()).get(root);
    if (!list.has(id)) list.set(id, { id, title: "A subagent", state: "running", started: started || new Date().toISOString(), ended: null, error: null, step: null, n: 0 });
    const w = list.get(id);
    if (title) w.title = w.named = short(String(title), 120);
    return w;
  }
  // A worker working again, or done with what it had.
  function workerIs(id: string, state: string, why: string | null = null) {
    const root = rootFor(conv(id).parent || id);
    const w = worker(root, id);
    if (w.state === state) return;
    settle(w, state, new Date().toISOString(), why);
    if (state !== "running") w.step = null;
    changed(root);
  }
  // How a subagent ended, as dsh says it: its stopReason.
  const ENDED = { completed: ["done"], aborted: ["stopped"], error: ["failed"], "max-tokens": ["failed", "It ran out of tokens."], refusal: ["failed", "It refused."] };
  function onSubagent(link: Link, m) {
    const id = String(m.id || "");
    if (!id || !m.parent) return;
    link.sessions.add(id);
    const c = conv(id);
    c.parent = String(m.parent);
    c.link = link;
    const root = rootFor(c.parent);
    const w = worker(root, id);
    const at = new Date().toISOString();
    if (m.state === "start") settle(w, "running", at);
    else {
      const [state, why] = ENDED[m.reason] || [stateOf(m.reason) || "done"];
      settle(w, state, at, why || null);
      w.step = null;
    }
    changed(root);
  }
  function workerEvent(id: string, e) {
    const c = conv(id);
    if (e.seq != null && c.digest.seq && e.seq <= c.digest.seq) return;
    const root = rootFor(c.parent);
    const w = worker(root, id);
    foldEvent(c.digest, e, c.cwd || post(root)?.cwd);
    const d = c.digest;
    w.title = w.named || d.label || d.ai_title || w.title;
    w.n = d.tools;
    if (e.type === "turn/start") workerIs(id, "running");
    else if (e.type === "turn/end") {
      const kind = e.data?.reason?.kind;
      workerIs(id, kind === "failed" ? "failed" : kind === "cancelled" || kind === "aborted" ? "stopped" : "done", kind === "failed" ? c.error || null : null);
      c.error = null;
    }
    const last = [...d.steps].reverse().find((x) => x.kind === "tool");
    if (going(w) && last) w.step = { title: last.title, at: last.at };
    changed(root);
  }
  // A worker's steps, as its thread's page opens it: what came as it worked, else its log.
  const WORKER_STEPS = 40;
  function workerSteps(id: string, wid: string) {
    if (!workers.get(id)?.has(wid)) return null;
    const c = conv(wid);
    let d = c.digest;
    if (!d.steps.length) {
      const events = readLog(wid);
      if (events?.length) d = digestOf(events, post(id)?.cwd);
    }
    return { steps: d.steps.slice(-WORKER_STEPS).map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), n: d.tools };
  }

  /* ---------- threads ---------- */

  async function start({ cwd, prompt, shown = prompt, lid, model, effort, mode }: StartRequest) {
    startFolder(cwd);
    const link = appLink();
    if (link) {
      try {
        return await startThere(link, { cwd, prompt, shown, lid, model, effort, mode });
      } catch (e) {
        // Its app couldn't make the session: agentbook's own ACP server does.
        log(`dsh: couldn't start a session in ${link.profile} (${e.message}), so it starts in agentbook's ACP server`);
        if (!bin()) throw new Error(`${appOf(link.profile)} couldn't start it: ${e.message}`);
      }
    }
    const a = await startAcp();
    // Its thread doesn't exist until dsh names the session: the tools write to the launch's until then.
    const context = await Promise.resolve(ctx.context({ launch: lid, cwd })).catch((e) => log(`dsh context: ${e.message}`));
    const r = await a.rpc.call<AcpResult>("session/new", { cwd, mcpServers: acp.equip(ctx, a, `launch:${lid}`, cwd) });
    const id = r.sessionId;
    a.open.add(id);
    const c = conv(id);
    c.loaded = true;
    noteOptions(id, r.configOptions);
    // What you picked, else what you picked in dsh's own apps.
    const mine = model || runtimeProviders.info("dsh").configured ? null : defaultModel();
    const want = model || mine?.id;
    const now = models?.default;
    if (want && want !== now && valueOfId(want)) await setOption(a, id, "model", valueOfId(want), want);
    const how = effort || mine?.effort;
    if (how && models?.efforts?.includes(how) && how !== models.effort) await setOption(a, id, "reasoning_effort", how, `${how} reasoning`);
    ensurePost(id, { cwd, lid, prompt });
    ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
    await adopt(id, mode || null);
    turn(a, id, prompt, typeof context === "string" ? context : null);
    return { id };
  }

  async function interrupt(id: string) {
    if (elsewhere(id)) {
      const link = linkFor(id);
      if (!link) throw new Error(`${appOf(elsewhere(id))} isn't running.`);
      if (!conv(id).busy) throw new Error("It isn't running.");
      return void (await call(link, { t: "stop", id }));
    }
    if (!conv(id).busy || !acp.current()) throw new Error("It isn't running.");
    acp.cancel(id);
  }

  const digest = (id: string) => {
    const c = conv(id);
    if (!c.loaded && post(id)) reload(id);
    return c.digest;
  };

  // How it's doing here (machine.drivers.dsh): whether dsh is installed, its ACP server running, the plugins connected,
  // and the app the threads you start run in.
  const health = () => ({ enabled, installed: !!bin(), running: !!acp.current(), error: lastError, plugin: [...links].filter((l) => !l.own).map((l) => ({ profile: l.profile, version: l.plugin, pid: l.pid })), startsIn: appLink()?.profile || null });

  // Its row on Add agents: where the threads you start run, and whether the sessions in dsh's own apps are threads too
  // (or how to make them so).
  function row(): RuntimeRow {
    const ds = health();
    const found = ds.installed || ds.plugin.length > 0;
    if (!ds.enabled) return { ok: false, status: "Off", detail: "AGENTBOOK_DSH=0 leaves it off." };
    if (!found) return { ok: false, status: "Not found", detail: "Install DeepSeek Harness here (the dsh command, on Node 24), then restart agentbook." };
    const starts = ds.startsIn ? `Threads you start from agentbook run in ${appOf(ds.startsIn)}, on its models and keys${ds.installed ? ", and in dsh's ACP server while it's closed" : ""}.` : ds.installed ? "Threads you start from agentbook run in dsh's ACP server, with the DeepSeek key you gave dsh." : "agentbook can't start threads in it: it doesn't find the dsh command.";
    const apps = ds.plugin.length ? `Its sessions in ${[...new Set(ds.plugin.map((p) => p.profile))].join(" and ")} are threads too (agentbook's plugin ${ds.plugin[0].version || ""}).` : `For the sessions you start in dsh's own apps too: dsh plugin --profile web add file:${path.join(PLUGIN_ROOT, "dsh")}, then restart dsh.`;
    return { ok: true, status: "Ready", detail: `${starts} ${apps}${ds.error ? ` Last time: ${ds.error}` : ""}` };
  }

  return {
    id: "dsh",
    providerChanged: async () => { await acp.reset(); models = null; fs.rmSync(MODELS_FILE(), { force: true }); lastError = null; },
    info: RUNTIMES.dsh,
    voice: NAME,
    // dsh over ACP doesn't say back what it's sent, and what it says back from its own apps carries agentbook's id.
    echoes: "self",
    owns: (id) => id === AGENT && ctx?.state.agents[id]?.kind === "dsh",
    connect(c) {
      ctx = c;
      if (!enabled) return;
      if (bin() && !ctx.state.agents[AGENT]) ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: "dsh" });
      // What dsh's apps asked before agentbook stopped: their plugins ask again once they're back.
      for (const q of ctx.state.questions) if (!q.answered && ctx.state.sessions[q.post]?.agent === AGENT && /^dsp-/.test(q.request_id || q.key || "")) ctx.emit({ e: "fact", op: { t: "question.answer", qid: q.id, value: null, by: "gone" } });
      for (const s of Object.values(ctx.state.sessions)) {
        if (s.agent !== AGENT) continue;
        // A turn that ran when agentbook stopped ended with it: dsh's ACP server was agentbook's child. One in dsh's own
        // apps says it's running again when its plugin connects. Its end delivers what waits for it.
        if (s.busy) ctx.emit({ e: "turn.end", thread: s.id });
        else if (ctx.pending(s.id).length) ctx.deliver(s.id);
      }
    },
    health,
    row,
    start,
    // A thread in one of dsh's apps goes through its plugin; agentbook's own go over ACP.
    send: (id, text) => (elsewhere(id) ? sendThere(id, text) : send(id, text)),
    // A question agentbook's plugin asked, whichever dsh it's in; else an Allow/Deny over ACP.
    answer: (id, e) => answerThere(id, e) || (!elsewhere(id) && acp.answer(e)),
    // Over ACP, while a turn runs only answers go: what you write waits for the turn to end (dsh takes one prompt at a
    // time). To a session in dsh's own apps it goes now (it reaches the model at its next step), or, while its app
    // isn't running, once it is (blocked says so).
    holds: (id) => runtimeProviders.changing("dsh") || (elsewhere(id) ? !linkFor(id) : conv(id).busy),
    interrupt,
    read: async (id) => digest(id),
    live: (s) => liveOf(posts.get(s.id)?.digest),
    summary: (s) => summaryOf(digest(s.id), s),
    working: (id) => !!posts.get(id)?.busy,
    workers: { list: (id) => [...(workers.get(id)?.values() || [])].map(({ named, ...w }) => w), steps: async (id, wid) => workerSteps(id, wid) },
    models: {
      list: () => {
        // Threads start in dsh's app while it runs: its models, with its keys.
        const app = appLink();
        if (app?.models) return app.models;
        const mine = runtimeProviders.info("dsh").configured ? null : defaultModel();
        return models && mine && models.list.some((m) => m.id === mine.id) ? { ...models, default: mine.id, effort: mine.effort || models.effort } : models;
      },
    },
    blocked: (s) => (elsewhere(s.id) && !linkFor(s.id) ? `This thread runs in ${appOf(elsewhere(s.id))}, which isn't running: start it, and you can write to this thread again.` : null),
    resumeCommand: () => null, // its session stays open in agentbook's dsh, which a terminal can't share
    // Its mode switches at once, through dsh's plugin in the server the thread runs in.
    switches: {
      mode: async (s, mode) => {
        const link = linkFor(s.id);
        if (!link?.can?.includes("mode")) throw new Error("agentbook can't switch this thread's mode: dsh's plugin isn't in the server it runs in.");
        await call(link, { t: "mode", id: s.id, mode });
      },
    },
    // A connection from dsh's plugin (/api/dsh/ws). Refused while DeepSeek Harness is off here.
    socket: (ws) => (enabled ? connectPlugin(ws as PluginSocket) : (ws as PluginSocket).close(1008, "DeepSeek Harness is off here (AGENTBOOK_DSH=0).")),
  };
}
