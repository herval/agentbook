// Antigravity CLI (Google's agy), as a child speaking the Agent Client Protocol (`agy acp`, kit/acp.ts). It took over
// from Gemini CLI, and signs in personal Google accounts, which Gemini CLI no longer does.
//
// - Antigravity is a profile ("antigravity"), and each session agentbook starts with it is a thread. Sessions from
//   agy's own terminal stay off.
// - What agy sends over ACP while a turn runs is the thread's steps: what it says, its plan, the tools it calls and how
//   they went. Its reply is what it said after its last tool call.
// - Writing on a thread sends a prompt. What you write while a turn runs waits for it to end. Stop cancels the turn.
// - Its sessions work in the mode picked for the thread: agy's Default (Ask), Auto or Plan. With none picked, Auto, as
//   agy's own terminal does: edits in the folder and commands in its sandbox go ahead. ACP sessions start in Default,
//   which asks before every command, so agentbook sets the thread's mode as a session starts or loads, when agy offers
//   it. Full access uses a separate agy process with --dangerously-skip-permissions, so its flag never applies to
//   threads in Ask, Auto or Plan. A thread loads back into the process for its saved mode after a restart, and moves
//   into Full access or out of it between turns: its session closes in one process and loads in the other. Picked
//   while a turn runs (or a background task it left), the move waits for that turn to end (and those tasks), and until
//   then agentbook allows what it asks, when it's moving into Full access.
// - agy's permission requests are Allow/Deny on the thread, but for agentbook's own tools, which are allowed here, as
//   the other runtimes pre-approve them.
// - Its model, and its thinking level when it has one, are ACP config options (or ACP's model state, when that's what
//   it answers with): picked for a thread, the model is set before its next prompt, and a session that loads on
//   another goes back to the thread's. The models it lists are kept (antigravity-models.json), for the composer's
//   picker before any session has started.
// - agy keeps each session's transcript (log.ts), which agentbook reads, read-only, for a thread's steps after a
//   restart. Writing on the thread then loads its session again (session/load, else session/resume), with agentbook's
//   tools; when there was no transcript to read, what agy replays as it loads is the thread's steps.
// - A command agy runs as a background task outlives its turn: the thread lists it as going on (going()), working
//   between turns. When the task ends, agy wakes by itself and works on, with no prompt of agentbook's running; ACP
//   marks no start or end for that, so what it sends then is a turn of its own (wake()), over once agy has answered
//   and gone quiet (QUIET after its usage_update, which ends each of its answers).
// - agy is agentbook's child, so a turn running when agentbook stops (a commit's self-reload) stops with it, and so do
//   the background tasks it left (kept in antigravity-going.json for this). As agentbook starts again, that session is
//   loaded and told to carry on, or that it won't hear from those tasks, and the Allow/Deny asks it left are closed.

import fs from "node:fs";
import path from "node:path";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import type { Mode } from "../../../shared/runtimes.ts";
import { CLI_HOME } from "../../../shared/store.ts";
import { SEEN_TOOL } from "../../transcript.ts";
import { CARRY_ON, createAcp, tasksCut } from "../kit/acp.ts";
import { runtimeProviders } from "../../runtime-providers.ts";
import type { AcpServer } from "../kit/acp.ts";
import { poll } from "../kit/poll.ts";
import { onPath, startFolder } from "../kit/spawn.ts";
import { addSay, addTool, blank, liveOf, short, summaryOf, toolDone } from "../kit/steps.ts";
import type { DriverDigest, Step } from "../kit/steps.ts";
import type { Going, Models, Runtime, RuntimeContext, StartRequest } from "../runtime.ts";
import { bookName, digestOf, namedTool, readLog } from "./log.ts";

const AGENT = "antigravity";
const NAME = "Antigravity";
const PROC = "agy";
// Its Allow/Deny asks' keys start with this (kit/acp.ts).
const ASKS = "ag";
export { CARRY_ON, tasksCut };
// How long agy stays quiet after an answer before a turn it started by itself counts as over. Within a turn, the
// next tool call comes right after the answer's usage_update; with nothing at all for STALL, it's over too.
const QUIET = 3000;
const STALL = 10 * 60e3;
// What agy sends as it works: with no turn running, the start of one of its own.
const WORK = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "plan"]);
const GOING_FILE = () => path.join(CLI_HOME, "antigravity-going.json");
const MISSING = "Antigravity CLI isn't installed here (the agy command). Install it with brew install --cask antigravity-cli.";
const MODELS_FILE = () => path.join(CLI_HOME, "antigravity-models.json");
const authError = (s: string) => /authenticat|sign.?in|log.?in|credentials|api key/i.test(s);
const errorText = (s: string) => {
  const text = String(s || "Antigravity refused").replace(/^(Internal error|Invalid params): /, "");
  return authError(text) ? `${text} Run agy in a terminal and sign in, then retry from agentbook.` : text;
};

// A session config option, as ACP gives them: its values flat, or in groups.
interface ConfigValue {
  value?: string;
  name?: string;
  group?: string;
  options?: ConfigValue[];
}
interface ConfigOption {
  id?: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: ConfigValue[];
}
interface ModelState {
  availableModels?: { modelId: string; name?: string }[];
  currentModelId?: string;
}
// What agy's ACP server answers (the fields read here).
interface AcpResult {
  sessionId?: string;
  models?: ModelState;
  configOptions?: ConfigOption[];
  stopReason?: string;
}
// What's known of a thread's session: its steps, whether it works, its reply so far (and the step it's in), its tool
// calls, how it picks a model (`option`: the config option's id, or null for ACP's model state), and, while agy
// replays it, whether that's taken as its steps (`replay`: "fold") or was already shown ("skip").
interface Conv {
  digest: DriverDigest;
  busy: boolean;
  reply: string;
  segment: Step | null;
  calls: Map<string, Record<string, any>>;
  option?: string | null;
  effortOption?: string | null;
  // The config option it's switched to another mode with.
  modeOption?: string | null;
  replay: "fold" | "skip" | null;
  replayed?: string | null;
  // A prompt on its way: its session loading, or its model being set, before the turn begins.
  sending?: boolean;
  // A turn agy started by itself, with no prompt to end it: when it began, and the timer that ends it once agy is quiet.
  own?: { began: number; timer?: ReturnType<typeof setTimeout> } | null;
  // The tool calls of the turn running, and those still running after their turn ended: its background tasks.
  made: Set<string>;
  left: Map<string, Going>;
}

const isModel = (o: ConfigOption) => o.category === "model" || o.id === "model";
const isEffort = (o: ConfigOption) => o.category === "thought_level" || /^(thought_level|thinking|reasoning_effort|effort)$/.test(String(o.id));
const isMode = (o: ConfigOption) => o.category === "mode" || o.id === "mode";
// A thread's mode (runtimes.ts's Mode) as agy's: the ones its caps offer.
const AGY_MODES: Record<Mode, string> = { ask: "default", auto: "auto", plan: "plan", full: "default" };
const MODE_NAMES: Record<Mode, string> = { ask: "Default", auto: "Auto", plan: "Plan", full: "Full access" };
// A model agy names, as one to pick: its transcript's carry the thinking level (gemini-4-neon-high), its picker's don't.
export const pickable = (list: { id: string }[] | null | undefined, model: string | null | undefined) => {
  if (!model || !list?.length) return null;
  if (list.some((m) => m.id === model)) return model;
  const family = model.replace(/-[a-z]+$/, "");
  return list.some((m) => m.id === family) ? family : null;
};
const flat = (vs?: ConfigValue[]): ConfigValue[] => (vs || []).flatMap((v) => (Array.isArray(v.options) ? flat(v.options) : [v])).filter((v) => typeof v.value === "string");

// The models a session offers, from its config options or its model state, or null when it says none.
export function modelsOf(r: AcpResult | null | undefined): (Models & { option: string | null; effortOption: string | null }) | null {
  const options = Array.isArray(r?.configOptions) ? r.configOptions : [];
  const m = options.find(isModel);
  const e = options.find(isEffort);
  const efforts = flat(e?.options).map((v) => v.value);
  if (m) {
    const list = flat(m.options).map((v) => ({ id: v.value, name: v.name || v.value }));
    if (list.length) return { list, default: m.currentValue || list[0].id, ...(efforts.length ? { efforts, effort: e.currentValue || null } : {}), option: m.id, effortOption: e?.id || null };
  }
  const state = r?.models;
  const list = (state?.availableModels || []).filter((x) => typeof x?.modelId === "string").map((x) => ({ id: x.modelId, name: x.name || x.modelId }));
  return list.length ? { list, default: state.currentModelId || list[0].id, ...(efforts.length ? { efforts, effort: e.currentValue || null } : {}), option: null, effortOption: e?.id || null } : null;
}

// Whether a tool call is one of agentbook's own tools (ab_post, ab_ask…): agy names them mcp_agentbook_ab_post, and
// titles them "Run mcp_agentbook_ab_post".
export function bookTool(u: Record<string, any> | null | undefined) {
  const named = bookName(u?.name);
  if (named) return named;
  const said = [u?.title, u?._meta && JSON.stringify(u._meta)].filter(Boolean).join(" ");
  return (/agentbook/i.test(said) && /(?:^|[^\w])(?:mcp_+agentbook_+)?(ab_[a-z_]+)\b/.exec(String(u?.title || ""))?.[1]) || /(?:mcp_+agentbook_+|agentbook[.:/]+)(ab_[a-z_]+)\b/.exec(said)?.[1] || null;
}

// A tool call, as a step: an edit by its diff, else by agy's name for the tool when it says one (log.ts), else by its
// ACP kind; and whether it stays off the steps (agentbook's own tools, but for those that read other threads).
export function toolOf(u: Record<string, any>) {
  const book = bookTool(u);
  if (book) return { name: `mcp__agentbook__${book}`, args: u.rawInput || {}, quiet: !SEEN_TOOL.test(`mcp__agentbook__${book}`) };
  const diff = u.content?.find((x) => x?.type === "diff");
  if (diff) return { name: "Edit", args: { file_path: diff.path, old_string: diff.oldText ?? "", new_string: diff.newText ?? "" }, quiet: false };
  const named = namedTool(u.name, u.rawInput);
  if (named) return named;
  const kind = u.kind || "other";
  const name = ({ execute: "Bash", read: "Read", edit: "Edit", delete: "Bash", move: "Bash", search: "Grep", fetch: "WebFetch" })[kind] || String(u.title || "Antigravity tool");
  const raw = u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length ? u.rawInput : null;
  const args = kind === "execute" || kind === "delete" || kind === "move" ? { command: raw?.command ?? u.title ?? "" } : raw || { file_path: u.locations?.[0]?.path };
  return { name, args, quiet: false };
}
const outputOf = (u: Record<string, any>) => (u.content || []).map((x) => (x?.type === "content" && x.content?.type === "text" ? x.content.text : "")).filter(Boolean).join("\n");

export function createAntigravity(): Runtime {
  let ctx: RuntimeContext = null;
  const enabled = process.env.AGENTBOOK_AGY !== "0";
  const bin = () => onPath(process.env.AGENTBOOK_AGY_BIN || "agy");
  let lastError: string | null = null;
  let models: Models | null = null;
  try {
    const saved = JSON.parse(fs.readFileSync(MODELS_FILE(), "utf8"));
    if (Array.isArray(saved?.list) && saved.list.every((m) => typeof m?.id === "string")) models = saved;
  } catch {}
  const posts = new Map<string, Conv>();
  const post = (id: string) => ctx.state.sessions[id];
  const conv = (id: string): Conv => {
    if (!posts.has(id)) posts.set(id, { digest: blank(), busy: false, reply: "", segment: null, calls: new Map(), replay: null, made: new Set(), left: new Map() });
    return posts.get(id);
  };
  const changed = (id: string, save = false) => ctx.emit({ e: "changed", thread: id, ...(save ? { save } : {}) });
  const failed = (id: string, why: string) => ctx.emit({ e: "failed", thread: id, why });
  const say = (id: string, text: string) => ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text });

  // A thread's steps from agy's transcript (log.ts), after a restart: kept as they are when it has none to read.
  function reload(id: string) {
    const c = conv(id);
    if (c.busy) return;
    const records = readLog(id);
    if (!records?.length) return;
    const d = digestOf(records, post(id)?.cwd);
    if (!d.steps.length) return;
    d.model = pickable(models?.list, d.model) || d.model;
    d.plan ||= c.digest.plan;
    d.context ||= c.digest.context;
    d.ai_title ||= c.digest.ai_title;
    d.worked = Math.max(d.worked, c.digest.worked);
    c.digest = d;
  }

  // The models a session answered with: the thread's model now, how it's picked, and the list, kept for the picker.
  function noteModels(id: string | null, r: AcpResult | null | undefined) {
    const m = modelsOf(r);
    if (!m) return;
    const { option, effortOption, ...list } = m;
    if (id) {
      const c = conv(id);
      c.option = option;
      c.effortOption = effortOption;
      if (list.default) c.digest.model = list.default;
    }
    if (JSON.stringify(list) === JSON.stringify(models)) return;
    models = list;
    try {
      fs.mkdirSync(path.dirname(MODELS_FILE()), { recursive: true });
      fs.writeFileSync(`${MODELS_FILE()}.tmp`, JSON.stringify(list));
      fs.renameSync(`${MODELS_FILE()}.tmp`, MODELS_FILE());
    } catch (e) {
      ctx.log(`Antigravity models: ${e.message}`);
    }
  }

  // What agy says of a session, on its thread's steps: while a turn runs, and as it replays one it loads after a
  // restart (its turns, by the person's messages; what's said in them is already on the thread).
  function onUpdate({ sessionId: id, update: u }: { sessionId?: string; update?: Record<string, any> }) {
    if (!id || !u || !posts.has(id)) return;
    const c = conv(id);
    if (c.replay === "skip") return;
    const replaying = c.replay === "fold";
    const d = c.digest;
    const at = new Date().toISOString();
    const kind = u.sessionUpdate;
    const ends = kind === "tool_call_update" && (u.status === "completed" || u.status === "failed");
    if (!replaying) {
      if (ends && c.left.delete(u.toolCallId)) {
        keepLeft();
        if (!c.busy) wake(id);
      } else if (!c.busy && WORK.has(kind)) wake(id);
      if (c.own && (WORK.has(kind) || kind === "tool_call_update" || kind === "usage_update")) {
        clearTimeout(c.own.timer);
        c.own.timer = setTimeout(() => ownEnded(id), kind === "usage_update" ? QUIET : STALL);
      }
      if (kind === "tool_call" && u.toolCallId) c.made.add(u.toolCallId);
    }
    switch (kind) {
      case "user_message_chunk":
        if (!replaying || c.replayed === "user") return;
        c.replayed = "user";
        c.segment = null;
        d.turn++;
        return;
      case "agent_message_chunk": {
        if ((!c.busy && !replaying) || u.content?.type !== "text" || typeof u.content.text !== "string") return;
        const text = u.content.text;
        c.replayed = "agent";
        if (!replaying) c.reply += text;
        if (c.segment) c.segment.text += text;
        else if (text.trim()) {
          addSay(d, { id: `agy-${d.turn}-${d.steps.length}`, at, text });
          c.segment = d.steps.at(-1);
        }
        break;
      }
      case "tool_call": {
        c.segment = null;
        c.replayed = "tool";
        if (!replaying) c.reply = "";
        c.calls.set(u.toolCallId, { ...u, at });
        const t = toolOf(u);
        if (t.quiet) return;
        addTool(d, { id: u.toolCallId, at, name: t.name, args: t.args, cwd: post(id)?.cwd });
        if (u.status === "completed" || u.status === "failed") toolDone(d, u.toolCallId, { at, output: outputOf(u), error: u.status === "failed" ? outputOf(u) || "Failed" : null });
        break;
      }
      case "tool_call_update": {
        c.calls.set(u.toolCallId, { ...c.calls.get(u.toolCallId), ...u });
        if (u.status !== "completed" && u.status !== "failed") return;
        toolDone(d, u.toolCallId, { at, output: outputOf(u), error: u.status === "failed" ? outputOf(u) || "Failed" : null });
        break;
      }
      case "plan":
        d.plan = (u.entries || []).map((e) => ({ text: e.content, now: e.content, status: e.status }));
        break;
      case "usage_update":
        if (Number.isFinite(u.used)) d.context = u.used;
        break;
      case "current_model_update":
        if (u.currentModelId) d.model = u.currentModelId;
        break;
      case "config_option_update":
        noteModels(id, { configOptions: u.configOptions });
        break;
      case "session_info_update":
        if (u.title) d.ai_title = short(u.title, 120);
        break;
      default:
        return; // its thoughts never become steps or replies
    }
    if (!replaying) changed(id);
  }

  function makeAcp(full: boolean) {
    const acp = createAcp({
      name: NAME,
      prefix: full ? `${ASKS}-full` : ASKS,
      command: bin,
      env: () => runtimeProviders.env("antigravity"),
      args: ["acp", ...(full ? ["--dangerously-skip-permissions"] : [])],
      missing: MISSING,
      errorText,
      onUpdate,
      onReady() {
        lastError = null;
        ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT });
      },
      // Allow/Deny on the thread, with what it's about to do. agentbook's own tools go ahead, as they do on the
      // other runtimes; a request that's no thread's is cancelled (kit/acp.ts).
      onPermission(p, key) {
        const id = p.sessionId;
        if (!id || !post(id)) return null;
        const u = { ...conv(id).calls.get(String(p.toolCall?.toolCallId)), ...p.toolCall };
        if (bookTool(u) || movingToFull(id)) return acp.answer({ type: "permission", request_id: key, behavior: "allow" });
        const t = toolOf(u);
        const diff = u.content?.find((x) => x?.type === "diff");
        const preview = diff
          ? `${diff.path}\n\nBefore:\n${String(diff.oldText ?? "").slice(0, 3500)}\n\nAfter:\n${String(diff.newText ?? "").slice(0, 3500)}`
          : String(t.args.command || t.args.file_path || t.args.path || t.args.url || u.title || "");
        ctx.emit({ e: "ask", thread: id, kind: "permission", request_id: key, title: "Allow this?", tool_name: u.kind === "execute" ? "Terminal" : t.name, detail: String(u.title || `${NAME} wants to go ahead with this.`), preview: preview.slice(0, 8000) });
        return id;
      },
      // Its turns stop with it: one it started itself ends saying why (one prompted, as its call fails), and its
      // background tasks are gone too, which a thread that waited on them says (its status, which frees its queue).
      onExit: (why) => {
        lastError = why;
        dropAsks(full);
        for (const [id, c] of posts) {
          if ((post(id)?.mode === "full") !== full) continue;
          if (c.own) ownEnded(id, { why });
          else if (c.left.size && !c.busy) ctx.emit({ e: "turn.end", thread: id, text: `${why.replace(/\.$/, "")}, and the background ${c.left.size === 1 ? "task" : "tasks"} it left running with it. Send a message to go on.` });
          c.left.clear();
        }
        keepLeft();
      },
    });
    return acp;
  }
  const guardedAcp = makeAcp(false);
  const fullAcp = makeAcp(true);
  const acpFor = (mode?: Mode | null) => mode === "full" ? fullAcp : guardedAcp;

  async function startAcp(mode?: Mode | null) {
    if (!enabled) throw new Error("Antigravity is off on this machine.");
    try {
      return await acpFor(mode).start();
    } catch (e) {
      lastError = e.message;
      throw e;
    }
  }

  // The ACP server, with the thread's session open in it: loaded again, with agentbook's tools, when it isn't (after a
  // restart, or after agy stopped). Its replay is the thread's steps when agentbook has none of them.
  async function ready(id: string) {
    const mode = post(id)?.mode;
    const acp = acpFor(mode);
    const a = await startAcp(mode);
    if (a.open.has(id)) return a;
    const c = conv(id);
    const cwd = startFolder(post(id)?.cwd);
    const method = !a.caps.loadSession && a.caps.sessionCapabilities?.resume ? "session/resume" : "session/load";
    const before = c.digest.model;
    c.replay = c.digest.steps.length ? "skip" : "fold";
    c.replayed = null;
    c.segment = null;
    try {
      const r = await a.rpc.call<AcpResult>(method, { sessionId: id, cwd, mcpServers: acp.equip(ctx, a, `${PROC}:${id}`, cwd) });
      noteModels(id, r);
      a.open.add(id);
      await inMode(a, id, r, mode);
      // The model it had, when the session came back on another.
      const wanted = post(id)?.model_pick || pickable(models?.list, before) || pickable(models?.list, post(id)?.model);
      if (wanted && wanted !== c.digest.model) await pick(a, id, wanted);
    } finally {
      c.replay = null;
      c.segment = null;
      changed(id);
    }
    return a;
  }

  // The model picked for a thread (or `model`), set before its next prompt; once set, the pick is done with.
  async function pick(a: AcpServer, id: string, model?: string | null) {
    const chosen = model || post(id)?.model_pick;
    if (!chosen) return;
    const c = conv(id);
    try {
      if (c.option) noteModels(id, await a.rpc.call<AcpResult>("session/set_config_option", { sessionId: id, configId: c.option, value: chosen }));
      else await a.rpc.call("session/set_model", { sessionId: id, modelId: chosen });
      c.digest.model = chosen;
      // Kept now, so the thread says the model its turn runs on, not the one it had until the turn ends.
      changed(id, true);
    } catch (e) {
      say(id, `agentbook couldn't switch this thread to ${chosen}, so it carries on as it was: ${e.message}`);
    }
    if (post(id)?.model_pick) ctx.emit({ e: "fact", op: { t: "session.model", post: id, model: null } });
  }

  // The thread's mode (Auto when none was picked) for a session that offers it and isn't in it: a new one, or one
  // that came back in another (agy loads a session in Default).
  async function inMode(a: AcpServer, id: string, r: AcpResult | null | undefined, mode?: Mode | null) {
    const want = AGY_MODES[mode || "auto"];
    const m = (Array.isArray(r?.configOptions) ? r.configOptions : []).find(isMode);
    if (m) conv(id).modeOption = m.id;
    if (!m || m.currentValue === want || !flat(m.options).some((v) => v.value === want)) return;
    await a.rpc.call("session/set_config_option", { sessionId: id, configId: m.id, value: want }).catch((e) => say(id, `agentbook couldn't put ${NAME} in ${MODE_NAMES[mode || "auto"] || "Auto"} mode, so it carries on in ${m.currentValue}: ${e.message}`));
  }

  // A prompt as a turn: the thread works until agy answers it, then says the turn's reply. `then`: what goes after
  // it (the first prompt's context).
  function turn(a: AcpServer, id: string, text: string, then?: string) {
    const c = conv(id);
    begin(id);
    const began = Date.now();
    const prompt = [{ type: "text", text }, ...(then ? [{ type: "text", text: then }] : [])];
    a.rpc
      .call<AcpResult>("session/prompt", { sessionId: id, prompt }, 0)
      .then((r) => {
        lastError = null;
        if (c.reply.trim()) say(id, c.reply);
        else if (r?.stopReason && !["end_turn", "cancelled"].includes(r.stopReason)) failed(id, `${r.stopReason.replace(/_/g, " ")}.`);
        return r?.stopReason === "end_turn";
      })
      .catch((e) => {
        lastError = e.message;
        failed(id, e.message);
        return false;
      })
      .then((finished) => ended(id, began, finished));
  }
  function begin(id: string) {
    const c = conv(id);
    c.busy = true;
    c.reply = "";
    c.segment = null;
    c.made.clear();
    c.digest.turn++;
    ctx.emit({ e: "turn.start", thread: id });
  }
  // A turn's end. The commands it ran that are still running went to the background, when it ended as agy meant it to
  // (a daemon, a server it started, never ends, so it isn't waited on).
  function ended(id: string, began: number, finished: boolean) {
    const c = conv(id);
    for (const k of finished ? c.made : []) {
      const u = c.calls.get(k);
      if (!u || u.status === "completed" || u.status === "failed" || u.rawInput?.IsDaemon === true) continue;
      const t = toolOf(u);
      c.left.set(k, { id: k, kind: u.kind === "execute" ? "shell" : u.kind || "task", title: short(String(t.args.command || u.title || t.name), 200), started: u.at || null });
    }
    c.made.clear();
    keepLeft();
    c.digest.worked += Date.now() - began;
    c.busy = false;
    c.segment = null;
    changed(id, true);
    // Before the turn's end, which sends what waited for it: that goes in the mode picked meanwhile.
    move(id);
    ctx.emit({ e: "turn.end", thread: id });
  }

  // agy at work with no turn running: a background task it left ended, and it woke to carry on. A turn of its own,
  // as the thread shows it, which ends once agy goes quiet (ownEnded).
  function wake(id: string) {
    begin(id);
    conv(id).own = { began: Date.now() };
  }
  // That turn's end: what it said after its last tool call is its reply. `why`: agy stopped, and why; `stopped`: Stop
  // cancelled it (session/cancel stops it as it does a prompted turn), so nothing of it goes on in the background.
  function ownEnded(id: string, { why, stopped }: { why?: string; stopped?: boolean } = {}) {
    const c = conv(id);
    if (!c.own) return;
    clearTimeout(c.own.timer);
    const { began } = c.own;
    c.own = null;
    if (why) failed(id, why);
    else if (c.reply.trim()) say(id, c.reply);
    ended(id, began, !why && !stopped);
  }

  // Each thread's background tasks, kept on disk as well, for when agentbook stops: they stop with agy, its child.
  let kept = "";
  function keepLeft() {
    const all = JSON.stringify(Object.fromEntries([...posts].filter(([, c]) => c.left.size).map(([id, c]) => [id, [...c.left.values()]])));
    if (all === kept) return;
    kept = all;
    try {
      fs.mkdirSync(path.dirname(GOING_FILE()), { recursive: true });
      fs.writeFileSync(`${GOING_FILE()}.tmp`, all);
      fs.renameSync(`${GOING_FILE()}.tmp`, GOING_FILE());
    } catch (e) {
      ctx.log(`Antigravity background tasks: ${e.message}`);
    }
  }
  // Those the last agentbook left running as it stopped.
  function leftBefore(): Record<string, Going[]> {
    try {
      const v = JSON.parse(fs.readFileSync(GOING_FILE(), "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  async function start({ cwd, prompt, shown = prompt, lid, model, effort, mode }: StartRequest) {
    startFolder(cwd);
    const context = await ctx.context({ launch: lid, cwd, background: true });
    try {
      const acp = acpFor(mode);
      const a = await startAcp(mode);
      const r = await a.rpc.call<AcpResult>("session/new", { cwd, mcpServers: acp.equip(ctx, a, `launch:${lid}`, cwd) });
      const id = r?.sessionId;
      if (!id || !/^[\w-]+$/.test(id)) throw new Error("Antigravity didn't return a valid session id.");
      const c = conv(id);
      a.open.add(id);
      noteModels(id, r);
      ctx.emit({ e: "thread", thread: id, agent: AGENT, agent_name: NAME, cwd, launch: lid, started: new Date().toISOString(), prompt: short(prompt, 2000) });
      ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
      if (model && model !== c.digest.model) await pick(a, id, model);
      if (effort && c.effortOption) await a.rpc.call("session/set_config_option", { sessionId: id, configId: c.effortOption, value: effort }).catch((e) => say(id, `agentbook couldn't set the thinking level to ${effort}: ${e.message}`));
      await inMode(a, id, r, mode);
      changed(id, true);
      turn(a, id, prompt, context);
      return { id };
    } catch (e) {
      lastError = e.message;
      throw e;
    }
  }

  // Into Full access or out of it: its session, closed in the agy it was in, which forgets it, so the other one loads
  // it as the thread is next written to (ready). agy 1.5.13 says it closes sessions; one that doesn't just forgets it.
  function leave(id: string, from?: Mode | null) {
    const a = acpFor(from).current();
    if (!a?.open.delete(id)) return;
    if (a.caps.sessionCapabilities?.close) a.rpc.call("session/close", { sessionId: id }).catch((e) => ctx.log(`Antigravity: closing ${id}: ${e.message}`));
  }
  // A move picked while the thread had something running where it is: once its turn ends, unless a background task it
  // left still runs there (then once agy's own turn after that task ends, or its next prompt).
  function move(id: string) {
    const s = post(id);
    const to = s?.mode_pick;
    if (!to || (to === "full") === (s.mode === "full") || conv(id).left.size) return;
    leave(id, s.mode);
    ctx.emit({ e: "fact", op: { t: "session.mode", post: id, pick: null, mode: to } });
  }
  const movingToFull = (id: string) => post(id)?.mode_pick === "full" && post(id)?.mode !== "full";
  // What it asked in the agy it's leaving for Full access, allowed, as Full access would.
  function allowAsked(id: string) {
    for (const q of ctx.state.questions)
      if (q.post === id && !q.answered && q.kind === "permission" && q.request_id?.startsWith(`${ASKS}-`)) ctx.emit({ e: "fact", op: { t: "question.answer", qid: q.id, value: "allow", by: "mode" } });
  }

  // A turn cut off when agentbook stopped: agy was its child, so it stopped too, partway (a commit's self-reload goes
  // ahead after waiting 10 minutes for turns to end), and so did the background tasks it left running. Its session is
  // loaded again and told to carry on, as Claude Code's threads are after an API error, or that it won't hear from
  // those tasks; when agy can't start, the turn ends saying why.
  async function pickUp(id: string, tasks: Going[] = []) {
    const text = [post(id)?.busy ? CARRY_ON : null, tasks.length ? tasksCut(tasks.map((t) => t.title)) : null].filter(Boolean).join("\n\n");
    try {
      const a = await ready(id);
      turn(a, id, text);
      ctx.log(`antigravity: picked up ${post(id)?.label || id}, cut off when agentbook restarted`);
    } catch (e) {
      ctx.emit({ e: "turn.end", thread: id, text: `${NAME} stopped when agentbook restarted, and couldn't go on (${e.message}). Send a message to go on.` });
    }
  }

  // agy's Allow/Deny asks still open once the agy that asked them stopped (with agentbook, or by itself): nothing can
  // answer them now, and a new agy numbers its asks from the start again, so a new ask would take an old one's key.
  function dropAsks(full?: boolean) {
    for (const q of ctx?.state.questions || [])
      if (!q.answered && q.request_id?.startsWith(`${ASKS}-`) && post(q.post)?.proc?.startsWith(`${PROC}:`) && (full === undefined || (post(q.post)?.mode === "full") === full)) ctx.emit({ e: "fact", op: { t: "question.answer", qid: q.id, value: null, by: "gone" } });
  }

  // What was held for a thread while it worked (or before agy was there) goes once it's free.
  const flush = () => {
    for (const s of Object.values(ctx.state.sessions)) if (s.proc?.startsWith(`${PROC}:`) && ctx.pending(s.id).length && !conv(s.id).busy) ctx.deliver(s.id);
  };

  return {
    id: AGENT,
    providerChanged: async () => { await Promise.all([guardedAcp.reset(), fullAcp.reset()]); lastError = null; },
    info: RUNTIMES.antigravity,
    voice: NAME,
    echoes: "text",
    owns: (id) => id === AGENT && ctx?.state.agents[id]?.kind === AGENT,
    connect(c) {
      ctx = c;
      if (!enabled) return;
      dropAsks();
      const cut = leftBefore();
      keepLeft();
      for (const s of Object.values(ctx.state.sessions))
        if (s.proc?.startsWith(`${PROC}:`)) {
          reload(s.id);
          const tasks = s.state !== "done" && !s.asleep && Array.isArray(cut[s.id]) ? cut[s.id] : [];
          if (s.busy || tasks.length) pickUp(s.id, tasks);
          // A move still held from before, with nothing of it running now (agentbook before 2026-11-26 held one until
          // the thread's next prompt).
          else move(s.id);
        }
      poll(() => {
        if (!bin()) return;
        ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT });
        flush();
      }, 3000);
    },
    online: flush,
    health: () => ({ enabled, installed: !!bin(), connected: !!guardedAcp.current() || !!fullAcp.current(), error: lastError }),
    row: () => ({
      ok: enabled && !!bin(),
      status: !enabled ? "Off" : bin() ? "Ready" : "Not found",
      detail: !enabled ? "AGENTBOOK_AGY=0 leaves it off." : !bin() ? MISSING : `Threads you start here run through Antigravity CLI, with its sign-in on this machine: run agy once to sign in.${lastError ? ` Last time: ${lastError}` : ""}`,
    }),
    start,
    holds: (id) => runtimeProviders.changing("antigravity") || conv(id).busy,
    async send(id, text) {
      move(id);
      const c = conv(id);
      c.sending = true;
      try {
        const a = await ready(id);
        await pick(a, id);
        turn(a, id, text);
      } finally {
        c.sending = false;
      }
    },
    // Whichever agy asked: one moving into Full access asked in the other.
    answer: (id, e) => guardedAcp.answer(e) || fullAcp.answer(e),
    async interrupt(id) {
      const c = conv(id);
      if (!c.busy) throw new Error(`${NAME} isn't working on this thread.`);
      acpFor(post(id)?.mode).cancel(id);
      if (c.own) ownEnded(id, { stopped: true });
    },
    async read(id) {
      if (!conv(id).digest.steps.length) reload(id);
      return conv(id).digest;
    },
    live: (s) => liveOf(posts.get(s.id)?.digest),
    summary: (s) => summaryOf(posts.get(s.id)?.digest, s),
    working: (id) => !!posts.get(id)?.busy,
    going: (s) => [...(posts.get(s.id)?.left.values() || [])],
    blocked: () => (!enabled ? "Antigravity is off on this machine." : !bin() ? MISSING : null),
    resumeCommand: () => null, // its ACP process has the session open; a terminal agy on it too would be two writers
    models: { list: () => models },
    // Its mode switches at once, in the session agy has open. Full access runs in an agy of its own (acpFor), which a
    // thread moves into or out of at once when nothing of it runs, else once that ends (move).
    switches: {
      mode: async (s, mode) => {
        if ((mode === "full") !== (s.mode === "full")) {
          const c = conv(s.id);
          if (!c.busy && !c.sending && !c.left.size) return leave(s.id, s.mode);
          if (mode === "full") allowAsked(s.id);
          return "next";
        }
        const a = await ready(s.id);
        const option = conv(s.id).modeOption;
        if (!option) throw new Error(`${NAME} doesn't offer a mode for this thread.`);
        await a.rpc.call("session/set_config_option", { sessionId: s.id, configId: option, value: AGY_MODES[mode] });
      },
    },
  };
}
