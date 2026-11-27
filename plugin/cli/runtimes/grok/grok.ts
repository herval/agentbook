// Grok (xAI's grok CLI), as a child speaking the Agent Client Protocol (`grok agent --no-leader stdio`, kit/acp.ts).
// Shapes are grok 1.0.89's, seen for real on 2026-11-26.
//
// - Grok is a profile ("grok"), and each session agentbook starts with it is a thread. Sessions from grok's own
//   terminal stay off.
// - What grok sends over ACP while a turn runs is the thread's steps: what it says, its plan, the tools it calls and
//   how they went (tools.ts). Its reply is what it said after its last tool call. Writing on a thread sends a prompt;
//   what you write while a turn runs waits for it to end, and Stop cancels the turn.
// - Its model and reasoning effort are ACP config options (`model`, `reasoning_effort`), set as a thread starts and,
//   when picked for a thread later, before its next prompt. Each model lists its own effort levels (Grok 4.7 has
//   xhigh; 4.5 doesn't), in its model state's `_meta.reasoningEfforts`. The models it lists are kept
//   (grok-models.json), for the composer's picker before any session has started; grok answers initialize with them
//   even before it's signed in, so agentbook asks it as it starts.
// - Its modes are Ask, Auto and Full access: `_meta.autoMode` and `_meta.yoloMode` on session/new, session/load and
//   session/resume. A resume switches a session grok has open to Auto or Full access; back to Ask, it's closed and
//   loaded again (inMode). It has no Plan over ACP (`grok agent` ignores --permission-mode plan). A thread with no
//   mode picked works in Auto.
// - Its permission requests are Allow/Deny on the thread, but for agentbook's own tools, which are allowed here, as
//   the other runtimes pre-approve them. A Deny ends grok's turn, which the thread says.
// - Its slash commands are those it lists (available_commands_update), sent as a prompt that starts with the slash.
// - grok keeps each session's updates (log.ts), which agentbook reads, read-only, for a thread's steps after a
//   restart. Writing on the thread then loads its session again, with agentbook's tools.
// - A command it runs in the background outlives its turn: grok lists those (background_tasks), and the thread lists
//   them as going on. When one ends with `will_wake`, grok carries on by itself with no prompt running, a turn of its
//   own that its turn_completed ends.
// - grok is agentbook's child, so a turn running when agentbook stops (a commit's self-reload) stops with it, and so
//   do the background tasks it left (grok-going.json). As agentbook starts again, that session is loaded and told to
//   carry on, or that it won't hear from those tasks, and the Allow/Deny asks it left are closed.
// - grok runs Claude Code's plugins' hooks too, agentbook's among them, which stay out of its sessions (hooks/hook.ts),
//   and loads their MCP servers, which the session's own "agentbook" server replaces by its name.
// - Its app updates here with `grok update`, once `grok update --check` says a newer one is out (runtime-update.ts).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import type { Mode } from "../../../shared/runtimes.ts";
import { CLI_HOME } from "../../../shared/store.ts";
import { runtimeProviders } from "../../runtime-providers.ts";
import { runCommand } from "../../runtime-update.ts";
import { CARRY_ON, createAcp, tasksCut } from "../kit/acp.ts";
import type { AcpServer } from "../kit/acp.ts";
import { poll } from "../kit/poll.ts";
import { onPath, startFolder } from "../kit/spawn.ts";
import { addSay, addTool, blank, liveOf, short, summaryOf, toolDone } from "../kit/steps.ts";
import type { DriverDigest, Step } from "../kit/steps.ts";
import type { Going, Models, Runtime, RuntimeContext, SlashCommand, SlashCommands, StartRequest } from "../runtime.ts";
import { grokHome, readUpdates } from "./log.ts";
import { bookTool, outputOf, toolOf } from "./tools.ts";

const AGENT = "grok";
const NAME = "Grok";
const PROC = "grok";
// Its Allow/Deny asks' keys start with this (kit/acp.ts).
const ASKS = "gk";
// A turn it started by itself ends with its turn_completed; with nothing at all from it for this long, it's over too.
const STALL = 10 * 60e3;
// What it sends as it works: with no turn running, the start of one of its own.
const WORK = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "plan"]);
// Its own notifications, which carry the same kinds of update (turn_completed, background_tasks, model_changed).
const NOTICES = new Set(["_x.ai/session/update", "_x.ai/session_notification"]);
const MODELS_FILE = () => path.join(CLI_HOME, "grok-models.json");
const GOING_FILE = () => path.join(CLI_HOME, "grok-going.json");
const MISSING = "Grok isn't installed here (the grok command). Install it from Settings → Agents, or with curl -fsSL https://x.ai/cli/install.sh | bash.";
const SIGN_IN = "Sign in to Grok from Settings → Agents, or run grok login on this machine, then retry from agentbook.";
const authError = (s: string) => /authenticat|sign.?in|log.?in|credentials|api key|unauthori[sz]ed/i.test(s);
const errorText = (s: string) => {
  const text = String(s || "Grok refused").replace(/^(Internal error|Invalid params): /, "");
  return authError(text) ? `${text}. ${SIGN_IN}`.replace(/\.\. /, ". ") : text;
};
// A thread's mode (runtimes.ts's Mode) as grok's session `_meta`. Plan isn't one of its caps' modes.
const META: Record<Mode, Record<string, boolean>> = { ask: { yoloMode: false, autoMode: false }, auto: { yoloMode: false, autoMode: true }, plan: { yoloMode: false, autoMode: false }, full: { yoloMode: true } };
const MODE_NAMES: Record<Mode, string> = { ask: "Ask", auto: "Auto", plan: "Plan", full: "Full access" };
// Its slash commands agentbook won't send, and why.
const NOT_HERE: Record<string, string> = { "always-approve": "This thread's mode is agentbook's: pick Full access instead." };

// A session config option, as ACP gives them.
interface ConfigValue {
  value?: string;
  name?: string;
  options?: ConfigValue[];
}
interface ConfigOption {
  id?: string;
  category?: string;
  currentValue?: string;
  options?: ConfigValue[];
}
interface ModelEntry {
  modelId?: string;
  name?: string;
  _meta?: { supportsReasoningEffort?: boolean; reasoningEfforts?: { value?: string; id?: string; default?: boolean }[] };
}
interface ModelState {
  availableModels?: ModelEntry[];
  currentModelId?: string;
}
// What grok's ACP server answers (the fields read here).
interface AcpResult {
  sessionId?: string;
  models?: ModelState;
  configOptions?: ConfigOption[];
  stopReason?: string;
}
interface Conv {
  digest: DriverDigest;
  busy: boolean;
  reply: string;
  segment: Step | null;
  calls: Map<string, Record<string, any>>;
  // The config options it's switched to another model and effort with.
  option?: string | null;
  effortOption?: string | null;
  // While grok replays it as it loads: whether that's taken as its steps ("fold") or was already shown ("skip").
  replay: "fold" | "skip" | null;
  replayed?: string | null;
  // A prompt on its way: its session loading, or its model being set, before the turn begins.
  sending?: boolean;
  // A turn grok started by itself (a background task it left woke it), with no prompt to end it.
  own?: { began: number; timer?: ReturnType<typeof setTimeout> } | null;
  // The background tasks it has running, as grok lists them.
  tasks: Map<string, Going>;
  // The mode its session is in now, as agentbook last set it.
  mode?: Mode | null;
  // An ask of this turn's denied: grok ends its turn on one, as a Stop does (its stop reason `cancelled`).
  denied?: boolean;
}

const isModel = (o: ConfigOption) => o.category === "model" || o.id === "model";
const isEffort = (o: ConfigOption) => o.category === "thought_level" || /^(reasoning_effort|thought_level|effort)$/.test(String(o.id));
const flat = (vs?: ConfigValue[]): ConfigValue[] => (vs || []).flatMap((v) => (Array.isArray(v.options) ? flat(v.options) : [v])).filter((v) => typeof v.value === "string");
const effortsOfModel = (m: ModelEntry | undefined) => {
  if (!m?._meta) return null;
  if (m._meta.supportsReasoningEffort === false) return { efforts: [], effort: null };
  const levels = (m._meta.reasoningEfforts || []).filter((e) => typeof (e?.value ?? e?.id) === "string");
  return levels.length ? { efforts: levels.map((e) => e.value ?? e.id), effort: (levels.find((e) => e.default) || levels[0]).value ?? null } : null;
};

// The models a session (or initialize's `_meta.modelState`) offers, each with its own effort levels, and how each is
// picked: the config options' ids. Null when it says none.
export function modelsOf(r: AcpResult | null | undefined): (Models & { option: string | null; effortOption: string | null }) | null {
  const options = Array.isArray(r?.configOptions) ? r.configOptions : [];
  const m = options.find(isModel);
  const e = options.find(isEffort);
  const state = (r?.models?.availableModels || []).filter((x) => typeof x?.modelId === "string");
  const ids = m ? flat(m.options).map((v) => ({ id: v.value, name: v.name || v.value })) : state.map((x) => ({ id: x.modelId, name: x.name || x.modelId }));
  if (!ids.length) return null;
  const list = ids.map((x) => ({ ...x, ...(effortsOfModel(state.find((s) => s.modelId === x.id)) || {}) }));
  const def = m?.currentValue || r?.models?.currentModelId || list[0].id;
  const levels = flat(e?.options).map((v) => v.value);
  const mine = list.find((x) => x.id === def);
  const efforts = levels.length ? levels : mine?.efforts || [];
  const effort = e?.currentValue || mine?.effort || null;
  return { list, default: def, ...(efforts.length ? { efforts, effort } : {}), option: m?.id || null, effortOption: e?.id || null };
}

// Its slash commands, as grok lists them: those that take something have a hint (`<query>` when they need it).
export function commandsOf(list: unknown): SlashCommands {
  const rows = (Array.isArray(list) ? list : []).filter((c) => c && typeof c.name === "string" && /^[\w:.-]+$/.test(c.name));
  const out: SlashCommand[] = rows.filter((c) => !NOT_HERE[c.name]).map((c) => {
    const hint = typeof c.input?.hint === "string" ? short(c.input.hint, 200) : "";
    return { name: c.name, hint, description: short(String(c.description || ""), 200), takes: !c.input ? "" : /^</.test(hint) ? "req" : "opt", from: "built-in" };
  });
  return { list: out, off: rows.filter((c) => NOT_HERE[c.name]).map((c) => ({ name: c.name, why: NOT_HERE[c.name] })) };
}

// One update, folded into what's known of the thread: live, or replayed from grok's log or as a session loads (its
// turns by the person's messages; what's said in them is already on the thread). Whether its steps moved.
function fold(c: Conv, u: Record<string, any>, at: string, cwd: string | undefined, replaying: boolean): boolean {
  const d = c.digest;
  switch (u.sessionUpdate) {
    case "user_message_chunk":
      if (!replaying || c.replayed === "user") return false;
      c.replayed = "user";
      c.segment = null;
      d.turn++;
      return false;
    case "agent_message_chunk": {
      if ((!c.busy && !replaying) || u.content?.type !== "text" || typeof u.content.text !== "string") return false;
      const text = u.content.text;
      c.replayed = "agent";
      if (!replaying) c.reply += text;
      if (c.segment) c.segment.text += text;
      else if (text.trim()) {
        addSay(d, { id: `grok-${d.turn}-${d.steps.length}`, at, text });
        c.segment = d.steps.at(-1);
      }
      return true;
    }
    case "tool_call": {
      c.segment = null;
      c.replayed = "tool";
      if (!replaying) c.reply = "";
      c.calls.set(u.toolCallId, { ...u, at });
      const t = toolOf(u);
      if (t.quiet) return false;
      if (Array.isArray(t.args?.todos) && /todo/i.test(t.name)) {
        d.plan = t.args.todos.map((e) => ({ text: String(e?.content ?? e?.text ?? ""), now: String(e?.content ?? e?.text ?? ""), status: e?.status }));
        return true;
      }
      addTool(d, { id: u.toolCallId, at, name: t.name, args: t.args, cwd });
      if (u.status === "completed" || u.status === "failed") toolDone(d, u.toolCallId, { at, output: outputOf(u), error: u.status === "failed" ? outputOf(u) || "Failed" : null });
      return true;
    }
    case "tool_call_update": {
      // grok's first update of a call names it better (its kind, a title with the path): kept for its Allow/Deny.
      const was = c.calls.get(u.toolCallId);
      c.calls.set(u.toolCallId, { ...was, ...u, rawInput: { ...was?.rawInput, ...u.rawInput } });
      if (u.status !== "completed" && u.status !== "failed") return false;
      toolDone(d, u.toolCallId, { at, output: outputOf(u), error: u.status === "failed" ? outputOf(u) || "Failed" : null });
      return true;
    }
    case "plan":
      d.plan = (u.entries || []).map((e) => ({ text: e.content, now: e.content, status: e.status }));
      return true;
    case "usage_update":
      if (Number.isFinite(u.used)) d.context = u.used;
      return true;
    case "current_model_update":
      if (u.currentModelId) d.model = u.currentModelId;
      return true;
    case "model_changed":
      if (typeof u.model_id === "string") d.model = u.model_id;
      return true;
    case "session_info_update":
      if (u.title) d.ai_title = short(u.title, 120);
      return true;
    default:
      return false; // its thoughts never become steps or replies
  }
}

// The grok command: AGENTBOOK_GROK_BIN, else grok on PATH, else where its installer puts it, for an agentbook whose
// PATH hasn't ~/.grok/bin (one launchd started).
export const grokBin = () => onPath(process.env.AGENTBOOK_GROK_BIN || "grok") || (process.env.AGENTBOOK_GROK_BIN ? null : onPath(path.join(grokHome(), "bin", "grok")));

export function createGrok(): Runtime {
  let ctx: RuntimeContext = null;
  const enabled = process.env.AGENTBOOK_GROK !== "0";
  const bin = grokBin;
  let lastError: string | null = null;
  let version: string | null = null;
  let models: Models | null = null;
  let commands: SlashCommands | null = null;
  try {
    const saved = JSON.parse(fs.readFileSync(MODELS_FILE(), "utf8"));
    if (Array.isArray(saved?.list) && saved.list.every((m) => typeof m?.id === "string")) models = saved;
  } catch {}
  const posts = new Map<string, Conv>();
  const post = (id: string) => ctx.state.sessions[id];
  const conv = (id: string): Conv => {
    if (!posts.has(id)) posts.set(id, { digest: blank(), busy: false, reply: "", segment: null, calls: new Map(), replay: null, tasks: new Map() });
    return posts.get(id);
  };
  const changed = (id: string, save = false) => ctx.emit({ e: "changed", thread: id, ...(save ? { save } : {}) });
  const failed = (id: string, why: string) => ctx.emit({ e: "failed", thread: id, why });
  const say = (id: string, text: string) => ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text });
  // Its environment: with the provider set up on Settings → Agents (an xAI key), and without grok's own question card
  // (ask_user_question), which agentbook has no way to show over ACP; it asks with ab_ask instead.
  const env = () => ({ ...runtimeProviders.env("grok"), GROK_ASK_USER_QUESTION: "false" });
  const signedIn = () => fs.existsSync(path.join(grokHome(), "auth.json")) || (runtimeProviders.info("grok")?.provider === "xai" && !!runtimeProviders.info("grok")?.keySaved);

  // A thread's steps from grok's log (log.ts), after a restart: kept as they are when it has none to read.
  function reload(id: string) {
    const c = conv(id);
    if (c.busy) return;
    const records = readUpdates(id, post(id)?.cwd);
    if (!records?.length) return;
    const r: Conv = { digest: blank(), busy: false, reply: "", segment: null, calls: new Map(), replay: "fold", tasks: new Map() };
    for (const x of records) if (x.method === "session/update" || NOTICES.has(x.method)) fold(r, x.update, x.at, post(id)?.cwd, true);
    const d = r.digest;
    if (!d.steps.length) return;
    d.model ||= c.digest.model;
    d.plan ||= c.digest.plan;
    d.context ||= c.digest.context;
    d.ai_title ||= c.digest.ai_title;
    d.worked = Math.max(d.worked, c.digest.worked);
    c.digest = d;
  }

  // The models a session answered with: the thread's model and effort now, how they're picked, and the list, kept for
  // the picker.
  function noteModels(id: string | null, r: AcpResult | null | undefined) {
    const m = modelsOf(r);
    if (!m) return;
    const { option, effortOption, ...list } = m;
    if (id) {
      const c = conv(id);
      c.option = option;
      c.effortOption = effortOption;
      if (list.default) c.digest.model = list.default;
      if (list.effort && post(id) && post(id).effort !== list.effort && !post(id).effort_pick) ctx.emit({ e: "fact", op: { t: "session.effort", post: id, effort: list.effort } });
    }
    keepModels(list);
  }
  function keepModels(list: Models) {
    if (JSON.stringify(list) === JSON.stringify(models)) return;
    models = list;
    try {
      fs.mkdirSync(path.dirname(MODELS_FILE()), { recursive: true });
      fs.writeFileSync(`${MODELS_FILE()}.tmp`, JSON.stringify(list));
      fs.renameSync(`${MODELS_FILE()}.tmp`, MODELS_FILE());
    } catch (e) {
      ctx.log(`Grok models: ${e.message}`);
    }
  }
  // What it says as it starts (before any sign-in): its version, models and slash commands.
  function noteInit(a: AcpServer) {
    const meta = a.init._meta || {};
    if (typeof meta.agentVersion === "string") version = meta.agentVersion;
    if (Array.isArray(meta.availableCommands)) commands = commandsOf(meta.availableCommands);
    // Not over a session's list: signed in, grok lists more models than it does before.
    if (!models) {
      const m = modelsOf({ models: meta.modelState as ModelState });
      if (m) keepModels({ list: m.list, default: m.default, ...(m.efforts ? { efforts: m.efforts, effort: m.effort } : {}) });
    }
  }

  // What grok says of a session, on its thread's steps: while a turn runs, and as it replays one it loads.
  function onUpdate(p: { sessionId?: string; update?: Record<string, any>; _meta?: Record<string, any> }) {
    const id = p.sessionId;
    const u = p.update;
    // Its slash commands come as a session starts, before agentbook knows its id: the folder's skills are among them.
    if (u?.sessionUpdate === "available_commands_update") {
      commands = commandsOf(u.availableCommands);
      return;
    }
    if (!id || !u || !posts.has(id)) return;
    if (u.sessionUpdate === "config_option_update") return noteModels(id, { configOptions: u.configOptions });
    const c = conv(id);
    if (c.replay === "skip" || p._meta?.isReplay) {
      if (c.replay !== "fold") return;
    }
    const replaying = c.replay === "fold";
    if (!replaying) {
      if (!c.busy && WORK.has(u.sessionUpdate)) wake(id);
      if (c.own) {
        clearTimeout(c.own.timer);
        c.own.timer = setTimeout(() => ownEnded(id), STALL);
      }
      if (Number.isFinite(p._meta?.totalTokens)) c.digest.context = p._meta.totalTokens;
    }
    if (fold(c, u, new Date().toISOString(), post(id)?.cwd, replaying) && !replaying) changed(id);
  }

  // Its own notifications: the background tasks it has running, a turn it started by itself ending, its model.
  function onNotice(method: string, p: Record<string, any>) {
    if (method === "_x.ai/models/update") {
      const m = modelsOf({ models: p as ModelState });
      if (m) keepModels({ list: m.list, default: m.default, ...(m.efforts ? { efforts: m.efforts, effort: m.effort } : {}) });
      return;
    }
    if (!NOTICES.has(method)) return;
    const id = p.sessionId;
    const u = p.update;
    if (!id || !u || !posts.has(id) || p._meta?.isReplay) return;
    const c = conv(id);
    // What a session replays as it loads is its past: tasks long gone, turns long ended.
    if (c.replay) return;
    switch (u.sessionUpdate) {
      case "background_tasks": {
        const running = (Array.isArray(u.tasks) ? u.tasks : []).filter((t) => t?.status === "running" && t.task_id);
        const next = new Map<string, Going>(running.map((t) => [String(t.task_id), { id: String(t.task_id), kind: t.kind === "bash" ? "shell" : t.kind || "task", title: short(String(t.description || t.command || "Background task"), 200), started: t.started_at || null }]));
        if (JSON.stringify([...next.keys()]) === JSON.stringify([...c.tasks.keys()])) return;
        c.tasks = next;
        keepGoing();
        changed(id);
        return;
      }
      case "turn_completed":
        if (c.own) ownEnded(id);
        return;
      case "model_changed":
        if (typeof u.model_id === "string" && u.model_id !== c.digest.model) {
          c.digest.model = u.model_id;
          changed(id);
        }
        return;
    }
  }

  const acp = createAcp({
    name: NAME,
    prefix: ASKS,
    command: bin,
    env,
    args: ["agent", "--no-leader", "stdio"],
    missing: MISSING,
    errorText,
    onUpdate,
    onNotice,
    onReady(a) {
      lastError = null;
      noteInit(a);
      ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT, ...(version ? { version } : {}) });
    },
    // Allow/Deny on the thread, with what it's about to do. agentbook's own tools go ahead, as they do on the other
    // runtimes; a request that's no thread's is cancelled (kit/acp.ts).
    onPermission(p, key) {
      const id = p.sessionId;
      if (!id || !post(id)) return null;
      const u = { ...conv(id).calls.get(String(p.toolCall?.toolCallId)), ...p.toolCall };
      if (bookTool(u)) return acp.answer({ type: "permission", request_id: key, behavior: "allow" });
      const t = toolOf(u);
      const diff = u.content?.find((x) => x?.type === "diff");
      const preview = diff
        ? `${diff.path}\n\nBefore:\n${String(diff.oldText ?? "").slice(0, 3500)}\n\nAfter:\n${String(diff.newText ?? "").slice(0, 3500)}`
        : t.name === "Edit" && t.args.file_path
          ? `${t.args.file_path}\n\nBefore:\n${String(t.args.old_string ?? "").slice(0, 3500)}\n\nAfter:\n${String(t.args.new_string ?? "").slice(0, 3500)}`
          : String(t.args.command || t.args.file_path || t.args.path || t.args.url || u.title || "");
      ctx.emit({ e: "ask", thread: id, kind: "permission", request_id: key, title: "Allow this?", tool_name: t.name === "Bash" ? "Terminal" : t.name, detail: String(u.title || `${NAME} wants to go ahead with this.`), preview: preview.slice(0, 8000) });
      return id;
    },
    // Its turns stop with it: one it started itself ends saying why (one prompted, as its call fails), and its
    // background tasks are gone too, which a thread that waited on them says (its status, which frees its queue).
    onExit: (why) => {
      lastError = why;
      dropAsks();
      for (const [id, c] of posts) {
        c.mode = null;
        if (c.own) ownEnded(id, { why });
        else if (c.tasks.size && !c.busy) ctx.emit({ e: "turn.end", thread: id, text: `${why.replace(/\.$/, "")}, and the background ${c.tasks.size === 1 ? "task" : "tasks"} it left running with it. Send a message to go on.` });
        c.tasks.clear();
      }
      keepGoing();
    },
  });

  async function startAcp() {
    if (!enabled) throw new Error("Grok is off on this machine.");
    try {
      return await acp.start();
    } catch (e) {
      lastError = e.message;
      throw e;
    }
  }

  // A config option set, as grok takes it: its value, a string.
  async function setOption(a: AcpServer, id: string, configId: string, value: string) {
    noteModels(id, await a.rpc.call<AcpResult>("session/set_config_option", { sessionId: id, configId, value }));
  }

  // The ACP server, with the thread's session open in it, in the thread's mode: loaded again, with agentbook's tools,
  // when it isn't (after a restart, or after grok stopped). Its replay is the thread's steps when agentbook has none.
  async function ready(id: string) {
    const a = await startAcp();
    if (a.open.has(id)) return a;
    const c = conv(id);
    const cwd = startFolder(post(id)?.cwd);
    const mode = post(id)?.mode || "auto";
    const before = c.digest.model;
    c.replay = c.digest.steps.length ? "skip" : "fold";
    c.replayed = null;
    c.segment = null;
    try {
      const r = await a.rpc.call<AcpResult>("session/load", { sessionId: id, cwd, mcpServers: acp.equip(ctx, a, `${PROC}:${id}`, cwd), _meta: META[mode] });
      noteModels(id, r);
      a.open.add(id);
      c.mode = mode;
      // The model it had, when the session came back on another.
      const wanted = post(id)?.model_pick || (models?.list.some((m) => m.id === before) ? before : null);
      if (wanted && wanted !== c.digest.model) await pick(a, id, wanted);
    } finally {
      c.replay = null;
      c.segment = null;
      changed(id);
    }
    return a;
  }

  // The thread's session in `mode`, as grok switches one it has open: resumed with the mode's `_meta`. A resume turns
  // auto or always-approve on but never auto off (grok 1.0.89, seen for real: a session in Auto still wrote without
  // asking), so for Ask the session is closed and loaded again, which starts it asking, on the model and effort it
  // had.
  async function inMode(a: AcpServer, id: string, mode: Mode) {
    const c = conv(id);
    if (c.mode === mode) return;
    const cwd = startFolder(post(id)?.cwd);
    const params = () => ({ sessionId: id, cwd, mcpServers: acp.equip(ctx, a, `${PROC}:${id}`, cwd), _meta: META[mode] });
    c.replay = "skip";
    try {
      if (mode === "ask" || !a.caps.sessionCapabilities?.resume) {
        if (a.caps.sessionCapabilities?.close) {
          await a.rpc.call("session/close", { sessionId: id });
          a.open.delete(id);
        }
        noteModels(id, await a.rpc.call<AcpResult>("session/load", params()));
        a.open.add(id);
      } else noteModels(id, await a.rpc.call<AcpResult>("session/resume", params()));
      c.mode = mode;
    } finally {
      c.replay = null;
    }
  }

  // The model picked for a thread (or `model`), set before its next prompt; once set, the pick is done with.
  async function pick(a: AcpServer, id: string, model?: string | null) {
    const chosen = model || post(id)?.model_pick;
    if (!chosen) return;
    const c = conv(id);
    try {
      if (c.option) await setOption(a, id, c.option, chosen);
      else await a.rpc.call("session/set_model", { sessionId: id, modelId: chosen });
      c.digest.model = chosen;
      // Kept now, so the thread says the model its turn runs on, not the one it had until the turn ends.
      changed(id, true);
    } catch (e) {
      say(id, `agentbook couldn't switch this thread to ${chosen}, so it carries on as it was: ${e.message}`);
    }
    if (post(id)?.model_pick) ctx.emit({ e: "fact", op: { t: "session.model", post: id, model: null } });
  }
  // The effort picked for a thread (or `effort`), the same way. A model that takes none drops it.
  async function effortFor(a: AcpServer, id: string, effort?: string | null) {
    const chosen = effort || post(id)?.effort_pick;
    if (!chosen) return;
    try {
      await setOption(a, id, conv(id).effortOption || "reasoning_effort", chosen);
      ctx.emit({ e: "fact", op: { t: "session.effort", post: id, pick: null, effort: chosen } });
    } catch (e) {
      say(id, `agentbook couldn't set this thread's effort to ${chosen}, so it carries on as it was: ${e.message}`);
      if (post(id)?.effort_pick) ctx.emit({ e: "fact", op: { t: "session.effort", post: id, pick: null } });
    }
  }
  // A mode picked while a turn ran, taken up before the next prompt.
  async function modeFor(a: AcpServer, id: string) {
    const to = post(id)?.mode_pick;
    if (!to || !RUNTIMES.grok.caps.modes.includes(to)) return;
    try {
      await inMode(a, id, to);
      ctx.emit({ e: "fact", op: { t: "session.mode", post: id, pick: null, mode: to } });
    } catch (e) {
      say(id, `agentbook couldn't put ${NAME} in ${MODE_NAMES[to]} mode, so it carries on as it was: ${e.message}`);
      ctx.emit({ e: "fact", op: { t: "session.mode", post: id, pick: null } });
    }
  }

  // A prompt as a turn: the thread works until grok answers it, then says the turn's reply. `then`: what goes after
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
        if (r?.stopReason === "cancelled" && c.denied) say(id, `${NAME} stopped there, as what it asked to do was denied. Say what it should do instead.`);
        else if (!c.reply.trim() && r?.stopReason && !["end_turn", "cancelled"].includes(r.stopReason)) failed(id, `${r.stopReason.replace(/_/g, " ")}.`);
      })
      .catch((e) => {
        lastError = e.message;
        failed(id, e.message);
      })
      .then(() => ended(id, began));
  }
  function begin(id: string) {
    const c = conv(id);
    c.busy = true;
    c.reply = "";
    c.segment = null;
    c.denied = false;
    c.digest.turn++;
    ctx.emit({ e: "turn.start", thread: id });
  }
  function ended(id: string, began: number) {
    const c = conv(id);
    c.digest.worked += Date.now() - began;
    c.busy = false;
    c.segment = null;
    changed(id, true);
    ctx.emit({ e: "turn.end", thread: id });
  }

  // grok at work with no turn running: a background task it left ended, and it woke to carry on. A turn of its own,
  // as the thread shows it, which its turn_completed ends (ownEnded).
  function wake(id: string) {
    begin(id);
    conv(id).own = { began: Date.now(), timer: setTimeout(() => ownEnded(id), STALL) };
  }
  // That turn's end: what it said after its last tool call is its reply. `why`: grok stopped, and why.
  function ownEnded(id: string, { why }: { why?: string } = {}) {
    const c = conv(id);
    if (!c.own) return;
    clearTimeout(c.own.timer);
    const { began } = c.own;
    c.own = null;
    if (why) failed(id, why);
    else if (c.reply.trim()) say(id, c.reply);
    ended(id, began);
  }

  // Each thread's background tasks, kept on disk as well, for when agentbook stops: they stop with grok, its child.
  let kept = "";
  function keepGoing() {
    const all = JSON.stringify(Object.fromEntries([...posts].filter(([, c]) => c.tasks.size).map(([id, c]) => [id, [...c.tasks.values()]])));
    if (all === kept) return;
    kept = all;
    try {
      fs.mkdirSync(path.dirname(GOING_FILE()), { recursive: true });
      fs.writeFileSync(`${GOING_FILE()}.tmp`, all);
      fs.renameSync(`${GOING_FILE()}.tmp`, GOING_FILE());
    } catch (e) {
      ctx.log(`Grok background tasks: ${e.message}`);
    }
  }
  function goingBefore(): Record<string, Going[]> {
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
    const want: Mode = mode && RUNTIMES.grok.caps.modes.includes(mode) ? mode : "auto";
    try {
      const a = await startAcp();
      const r = await a.rpc.call<AcpResult>("session/new", { cwd, mcpServers: acp.equip(ctx, a, `launch:${lid}`, cwd), _meta: META[want] });
      const id = r?.sessionId;
      if (!id || !/^[\w-]+$/.test(id)) throw new Error("Grok didn't return a valid session id.");
      const c = conv(id);
      a.open.add(id);
      c.mode = want;
      noteModels(id, r);
      ctx.emit({ e: "thread", thread: id, agent: AGENT, agent_name: NAME, cwd, launch: lid, started: new Date().toISOString(), prompt: short(prompt, 2000) });
      ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
      if (model && model !== c.digest.model) await pick(a, id, model);
      // noteModels couldn't say the session's effort before its thread was there.
      const now = modelsOf(r)?.effort;
      if (effort) await effortFor(a, id, effort);
      else if (now) ctx.emit({ e: "fact", op: { t: "session.effort", post: id, effort: now } });
      changed(id, true);
      turn(a, id, prompt, context);
      return { id };
    } catch (e) {
      lastError = e.message;
      throw e;
    }
  }

  // A turn cut off when agentbook stopped: grok was its child, so it stopped too, partway (a commit's self-reload goes
  // ahead after waiting 10 minutes for turns to end), and so did the background tasks it left running. Its session is
  // loaded again and told to carry on, or that it won't hear from those tasks; when grok can't start, the turn ends
  // saying why.
  async function pickUp(id: string, tasks: Going[] = []) {
    const text = [post(id)?.busy ? CARRY_ON : null, tasks.length ? tasksCut(tasks.map((t) => t.title)) : null].filter(Boolean).join("\n\n");
    try {
      const a = await ready(id);
      turn(a, id, text);
      ctx.log(`grok: picked up ${post(id)?.label || id}, cut off when agentbook restarted`);
    } catch (e) {
      ctx.emit({ e: "turn.end", thread: id, text: `${NAME} stopped when agentbook restarted, and couldn't go on (${e.message}). Send a message to go on.` });
    }
  }

  // grok's Allow/Deny asks still open once the grok that asked them stopped: nothing can answer them now, and a new
  // grok numbers its asks from the start again, so a new ask would take an old one's key.
  function dropAsks() {
    for (const q of ctx?.state.questions || [])
      if (!q.answered && q.request_id?.startsWith(`${ASKS}-`) && post(q.post)?.proc?.startsWith(`${PROC}:`)) ctx.emit({ e: "fact", op: { t: "question.answer", qid: q.id, value: null, by: "gone" } });
  }

  // What was held for a thread while it worked (or before grok was there) goes once it's free.
  const flush = () => {
    for (const s of Object.values(ctx.state.sessions)) if (s.proc?.startsWith(`${PROC}:`) && ctx.pending(s.id).length && !conv(s.id).busy) ctx.deliver(s.id);
  };

  // Its version, models and slash commands as it starts, before a thread needs it: a grok of its own, asked and gone.
  async function probe() {
    const p = createAcp({ name: NAME, prefix: `${ASKS}-probe`, command: bin, env, args: ["agent", "--no-leader", "stdio"], missing: MISSING, errorText });
    try {
      noteInit(await p.start());
      ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT, ...(version ? { version } : {}) });
    } catch (e) {
      ctx.log(`grok: couldn't ask it what it has: ${e.message}`);
    } finally {
      await p.reset();
    }
  }
  const run = (args: string[], timeout = 30e3) =>
    new Promise<string>((resolve, reject) => execFile(bin() || "grok", args, { env: env(), timeout, maxBuffer: 1 << 20 }, (e, out) => (e ? reject(e) : resolve(String(out)))));
  const readVersion = async () => /(\d+\.\d+\.\d+[\w.-]*)/.exec(await run(["--version"], 10e3).catch(() => ""))?.[1] || null;
  const busyHere = () => [...posts.values()].some((c) => c.busy || c.sending || c.tasks.size);

  return {
    id: AGENT,
    providerChanged: async () => {
      await acp.reset();
      lastError = null;
    },
    info: RUNTIMES.grok,
    voice: NAME,
    echoes: "text",
    owns: (id) => id === AGENT && ctx?.state.agents[id]?.kind === AGENT,
    connect(c) {
      ctx = c;
      if (!enabled) return;
      dropAsks();
      const cut = goingBefore();
      keepGoing();
      for (const s of Object.values(ctx.state.sessions))
        if (s.proc?.startsWith(`${PROC}:`)) {
          reload(s.id);
          const tasks = s.state !== "done" && !s.asleep && Array.isArray(cut[s.id]) ? cut[s.id] : [];
          if (s.busy || tasks.length) pickUp(s.id, tasks);
        }
      if (bin()) void probe();
      poll(() => {
        if (!bin()) return;
        ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT, ...(version ? { version } : {}) });
        flush();
      }, 3000);
    },
    online: flush,
    health: () => ({ enabled, installed: !!bin(), connected: !!acp.current(), signedIn: signedIn(), error: lastError }),
    row: () => {
      const here = !!bin();
      return {
        ok: enabled && here,
        status: !enabled ? "Off" : here ? "Ready" : "Not found",
        detail: !enabled ? "AGENTBOOK_GROK=0 leaves it off." : !here ? MISSING : `Threads you start here run through Grok's own CLI, with its sign-in on this machine.${signedIn() ? "" : ` ${SIGN_IN}`}${lastError ? ` Last time: ${lastError}` : ""}`,
      };
    },
    start,
    holds: (id) => runtimeProviders.changing("grok") || conv(id).busy,
    async send(id, text, _files, opts) {
      const c = conv(id);
      c.sending = true;
      try {
        const a = await ready(id);
        await modeFor(a, id);
        await pick(a, id);
        await effortFor(a, id);
        turn(a, id, opts?.command && !text.startsWith("/") ? `/${opts.command} ${text}`.trim() : text);
      } finally {
        c.sending = false;
      }
    },
    answer: (id, e) => {
      if (e.type === "permission" && e.behavior !== "allow") conv(id).denied = true;
      return acp.answer(e);
    },
    async interrupt(id) {
      const c = conv(id);
      if (!c.busy) throw new Error(`${NAME} isn't working on this thread.`);
      acp.cancel(id);
      if (c.own) ownEnded(id);
    },
    async read(id) {
      if (!conv(id).digest.steps.length) reload(id);
      return conv(id).digest;
    },
    live: (s) => liveOf(posts.get(s.id)?.digest),
    summary: (s) => summaryOf(posts.get(s.id)?.digest, s),
    working: (id) => !!posts.get(id)?.busy,
    going: (s) => [...(posts.get(s.id)?.tasks.values() || [])],
    blocked: () => (!enabled ? "Grok is off on this machine." : !bin() ? MISSING : null),
    resumeCommand: () => null, // its ACP process has the session open; a terminal grok on it too would be two writers
    models: { list: () => models },
    commands: { list: async () => commands || { list: [], off: [] } },
    // Its mode switches in the session grok has open: at once when nothing of it runs, else before its next prompt.
    switches: {
      mode: async (s, mode) => {
        const c = conv(s.id);
        if (c.busy || c.sending) return "next";
        await inMode(await ready(s.id), s.id, mode);
      },
    },
    update: {
      version: () => version,
      newest: async () => {
        const v = JSON.parse(await run(["update", "--check", "--json"]))?.latestVersion;
        if (typeof v !== "string") throw new Error("grok update --check didn't say its newest version");
        return v;
      },
      wait: () => (busyHere() ? "A Grok turn or background task is running here, and the update restarts grok, which would cut it off. Update once it ends." : null),
      async run(output, signal) {
        await runCommand(bin() || "grok", ["update"], { output, signal, env: env() });
        version = (await readVersion()) || version;
        // Its threads go on in the new grok: each loads its session again as it's next written to.
        if (!busyHere()) await acp.reset();
      },
    },
  };
}
