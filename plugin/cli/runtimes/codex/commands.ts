// What a Codex thread can run with a slash command. Codex's commands are its terminal app's: its app-server has no
// call that lists them or runs one typed, but has one for each of these, which `run` makes. Each in Codex's own
// words. Its skills are commands here too, one each, as Claude Code's and OpenClaw's are (Codex's app spells them
// $name), and go to Codex as a skill, not as words. Left out (`off`, with why): what only its terminal app does, and
// what agentbook does itself.
//
// A command waits for a turn that's running to end, never steered into it (its caps' commands: "wait", which the
// core's delivery keeps).

import os from "node:os";
import { short } from "../kit/steps.ts";
import type { Session } from "../../../shared/types.ts";
import type { Models, RuntimeContext, SlashCommands } from "../runtime.ts";
import type { CodexConfig, CodexConfigRead, CodexGoal, CodexInput, CodexList, CodexMcpStatus, CodexSettings, CodexSkill, CodexThread, CodexThreadReply } from "./items.ts";

// What a command reads and marks of a thread agentbook follows.
export interface CommandThread {
  cwd: string;
  turn: string | null;
  settings?: CodexSettings | null;
  digest: { model: string | null; context: number };
  compacting?: boolean;
}
// What Codex's limits read says (limits.ts's reader): the first of `limits` is its ChatGPT plan's.
interface LimitsRead {
  limits?: { name?: string; plan?: string; blocked?: boolean; windows?: { label: string; used: number; resets: string | null }[] }[];
  error?: string;
}
// What the commands use of the runtime: Codex's calls, a thread it follows, turns, its models and limits, and a post
// for a thread Codex made (a fork).
export interface CommandsHost {
  ctx(): RuntimeContext;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  connect(): Promise<unknown>;
  follow(id: string): Promise<CommandThread>;
  thread(id: string): CommandThread;
  startTurn(th: CommandThread, method: string, params: unknown): Promise<unknown>;
  sendTurn(id: string, text: string, opts?: { also?: CodexInput[] }): Promise<unknown>;
  models(): Models;
  limits(): Promise<LimitsRead | null>;
  adopt(t: CodexThread): Session | null;
}

// What /init asks for: the prompt Codex's terminal app sends for it (0.166.0), word for word.
const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

const COMMANDS = [
  { name: "compact", hint: "", description: "Summarize the conversation to prevent hitting the context limit", takes: "" },
  { name: "review", hint: "[base <branch>|<commit>|what to look at]", description: "Review my current changes and find issues", takes: "opt" },
  { name: "goal", hint: "[<objective>|clear|pause|resume]", description: "Set or view the goal for a long-running task", takes: "opt" },
  { name: "init", hint: "", description: "Create an AGENTS.md file with instructions for Codex", takes: "" },
  { name: "status", hint: "", description: "Show current session configuration and token usage", takes: "" },
  { name: "usage", hint: "", description: "View account usage", takes: "" },
  { name: "mcp", hint: "", description: "List configured MCP servers and their tools", takes: "" },
  { name: "rename", hint: "<name>", description: "Rename the current thread", takes: "req" },
  { name: "fork", hint: "", description: "Fork the current chat into a new thread", takes: "" },
  { name: "model", hint: "<model>", description: "Choose what model to use", takes: "req" },
].map((c) => ({ ...c, takes: c.takes as "" | "opt" | "req", from: "built-in" as const }));
const WALL = "starts a new chat: start a new thread on Codex's wall";
const TUI = "changes Codex's terminal app";
const NOT_HERE = {
  new: WALL,
  clear: WALL,
  resume: "opens another chat: open its thread here",
  diff: "is Changes, on the thread",
  permissions: "picks what Codex may do, in its terminal app",
  approvals: "picks what Codex may do, in its terminal app",
  side: "starts a side chat, which agentbook doesn't show",
  btw: "starts a side chat, which agentbook doesn't show",
  plan: "switches its terminal app to Plan mode",
  copy: "copies in its terminal app: copy from the thread",
  export: "saves the chat from its terminal app",
  archive: "archives it in Codex: archive the thread here",
  delete: "deletes the chat for good, which only its terminal app does",
  logout: "signs out of Codex, in a terminal",
  feedback: "sends logs to OpenAI, from a terminal",
  quit: "closes its terminal app",
  exit: "closes its terminal app",
  theme: TUI,
  statusline: TUI,
  title: TUI,
  vim: TUI,
  keymap: TUI,
  raw: TUI,
};
const COMMANDS_MS = 5 * 60e3;

export function createCommands(h: CommandsHost) {
  const log = (line: string) => h.ctx().log(line);
  const post = (id: string) => h.ctx().state.sessions[id];
  const say = (id: string, name: string, text: string) => void h.ctx().emit({ e: "message", thread: id, from: "agent", via: "dash", text, command: name });

  const skillsByCwd = new Map<string, { at: number; list: CodexSkill[] }>(); // folder -> Codex's skills there, as skills/list gave them
  async function skillsIn(cwd: string) {
    const have = skillsByCwd.get(cwd);
    if (have && Date.now() - have.at < COMMANDS_MS) return have.list;
    const r = await h.call<CodexList<{ skills?: CodexSkill[] }>>("skills/list", { cwds: cwd ? [cwd] : [] });
    const list = (r?.data || []).flatMap((e) => e.skills || []).filter((k) => k?.name && k.path && k.enabled !== false);
    skillsByCwd.set(cwd, { at: Date.now(), list });
    return list;
  }
  const cwdFor = (id: string) => h.thread(id).cwd || post(id)?.cwd || "";

  async function list(s: Session): Promise<SlashCommands> {
    await h.connect();
    const skills = await skillsIn(cwdFor(s.id)).catch((e) => (log(`codex: couldn't list its skills: ${e.message}`), [] as CodexSkill[]));
    const names = new Set([...COMMANDS.map((c) => c.name), ...Object.keys(NOT_HERE)]);
    const own = [];
    for (const k of skills) {
      if (names.has(k.name) || !/^[\w:.-]{1,100}$/.test(k.name)) continue;
      names.add(k.name);
      const from = k.pluginId ? { from: "plugin", plugin: String(k.pluginId).split("@")[0] } : { from: k.scope === "repo" ? "project" : "skill" };
      own.push({ name: k.name, hint: "", description: short(k.interface?.shortDescription || k.shortDescription || k.description, 200), takes: "opt", ...from });
    }
    // /model takes one of its models, which the / list names when there are only a few.
    const ids = h.models().list.map((m) => m.id);
    const listed = COMMANDS.map((c) => (c.name === "model" && ids.length && ids.length <= 4 ? { ...c, hint: `<${ids.join("|")}>` } : c));
    return { list: [...listed, ...own], off: Object.entries(NOT_HERE).map(([name, why]) => ({ name, why })) };
  }

  // Run one: the call Codex has for it. What it says shows on the thread as its reply (`command`: whose output it is);
  // one that starts a turn (a review, /init, a skill, a compaction) shows as any turn does. One Codex refuses says why.
  async function run(id: string, text: string, name: string) {
    const th = await h.follow(id);
    const args = text.slice(name.length + 1).trim();
    const reply = (t: string) => say(id, name, t);
    try {
      switch (name) {
        case "compact":
          th.compacting = true;
          await h.call("thread/compact/start", { threadId: id });
          return;
        case "review": {
          await h.startTurn(th, "review/start", { threadId: id, target: reviewTarget(args), delivery: "inline" });
          return;
        }
        case "init":
          await h.sendTurn(id, INIT_PROMPT);
          return;
        case "goal":
          return reply(await goal(id, args));
        case "rename":
          if (!args) return reply("Write its new name after it: `/rename <name>`.");
          await h.call("thread/name/set", { threadId: id, name: args });
          // The person renamed it, so the thread takes the name: Codex's names after its first don't (session.snapshot).
          h.ctx().emit({ e: "fact", op: { t: "session.post", post: id, title: short(args, 140), rename: true } });
          return reply(`Renamed it “${args}”.`);
        case "fork": {
          const r = await h.call<CodexThreadReply>("thread/fork", { threadId: id, excludeTurns: true });
          const copy = r?.thread && h.adopt(r.thread);
          return reply(copy ? `Forked it: the copy is ${copy.label}, on Codex's wall.` : "Forked it.");
        }
        case "status":
          return reply(await statusOf(id));
        case "usage":
          return reply(usageOf(await h.limits()) || "Codex didn't say how much of its limits it has used.");
        case "mcp":
          return reply(await mcpOf(id));
        case "model": {
          const models = h.models().list;
          const m = models.find((x) => x.id.toLowerCase() === args.toLowerCase() || x.name.toLowerCase() === args.toLowerCase());
          if (!m) return reply(`Pick one of its models: ${models.map((x) => `\`/model ${x.id}\``).join(", ") || "Codex listed none"}.`);
          h.ctx().emit({ e: "fact", op: { t: "session.model", post: id, model: m.id } });
          return reply(`Its next turn is on ${m.name}.`);
        }
      }
      // A skill: its name as Codex's app writes it ($name), with what you wrote after it, and the skill itself.
      const k = (await skillsIn(cwdFor(id))).find((x) => x.name === name);
      await h.sendTurn(id, k ? `$${name}${args ? ` ${args}` : ""}` : text, k ? { also: [{ type: "skill", name, path: k.path }] } : {});
    } catch (e) {
      if (/Not connected|disconnected/.test(e.message)) throw e;
      th.compacting = false;
      reply(`Codex couldn't run /${name}: ${e.message}`);
    }
  }
  // A compaction you asked for is done: it says so (one that Codex did by itself is a step, as before).
  function compacted(id: string, th: CommandThread | undefined) {
    if (!th?.compacting) return;
    th.compacting = false;
    say(id, "compact", "Compacted the conversation: Codex goes on from a summary of it.");
  }
  // What /review looks at: your uncommitted changes, what's changed since a base branch, a commit, or what you say.
  function reviewTarget(args: string) {
    const base = /^base\s+(\S+)$/i.exec(args);
    if (!args) return { type: "uncommittedChanges" };
    if (base) return { type: "baseBranch", branch: base[1] };
    if (/^[0-9a-f]{7,40}$/i.test(args)) return { type: "commit", sha: args };
    return { type: "custom", instructions: args };
  }
  // /goal: set it, show it, clear, pause or resume it, as Codex's own /goal does. Set by you (origin "user"), which
  // Codex takes as yours to change.
  const GOAL_STATES = { active: "Working on it", paused: "Paused", blocked: "Blocked", usageLimited: "Stopped at a usage limit", budgetLimited: "Out of its token budget", complete: "Done" };
  async function goal(id: string, args: string) {
    const word = args.toLowerCase();
    if (word === "clear") {
      await h.call("thread/goal/clear", { threadId: id, origin: "user" });
      return "Cleared the goal.";
    }
    if (word === "pause" || word === "resume") {
      const g = (await h.call<{ goal?: CodexGoal }>("thread/goal/set", { threadId: id, status: word === "pause" ? "paused" : "active", origin: "user" }))?.goal;
      return `${word === "pause" ? "Paused" : "Resumed"} the goal${g?.objective ? `: ${g.objective}` : "."}`;
    }
    if (word === "edit") return "Write the new goal after it: `/goal <objective>`.";
    if (args) {
      const g = (await h.call<{ goal?: CodexGoal }>("thread/goal/set", { threadId: id, objective: args, status: "active", origin: "user" }))?.goal;
      return `Goal set: ${g?.objective || args}`;
    }
    const g = (await h.call<{ goal?: CodexGoal }>("thread/goal/get", { threadId: id }))?.goal;
    if (!g) return "No goal set. `/goal <objective>` sets one, and Codex works toward it.";
    const mins = Math.round((Number(g.timeUsedSeconds) || 0) / 60);
    const spent = [mins ? (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`) : null, g.tokensUsed ? `${tokens(g.tokensUsed)}${g.tokenBudget ? ` of ${tokens(g.tokenBudget)}` : ""} tokens` : null].filter(Boolean);
    return `**Goal:** ${g.objective}\n\n${GOAL_STATES[g.status] || g.status}${spent.length ? ` · ${spent.join(" · ")}` : ""}`;
  }
  const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const tilde = (p: string) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p || "");
  const SANDBOX = { dangerFullAccess: "Full access", readOnly: "Read-only", workspaceWrite: "Workspace write", externalSandbox: "An external sandbox" };
  // /status: what the thread runs with (as loading it said, else Codex's config for its folder), and its plan's limits.
  async function statusOf(id: string) {
    const th = h.thread(id);
    const st: Partial<CodexSettings> = th.settings || {};
    const cfg: CodexConfig = (await h.call<CodexConfigRead>("config/read", { cwd: th.cwd || null }).catch(() => null))?.config || {};
    const effort = st.effort || cfg.model_reasoning_effort;
    const approvals = typeof st.approvals === "string" ? st.approvals : st.approvals ? "granular" : cfg.approval_policy;
    const sandbox = SANDBOX[st.sandbox] || cfg.sandbox_mode;
    const rows = [
      ["Model", `${st.model || th.digest.model || cfg.model || "its default"}${effort ? `, ${effort} reasoning` : ""}`],
      ["Folder", th.cwd ? `\`${tilde(th.cwd)}\`` : null],
      ["Approvals", approvals],
      ["Sandbox", sandbox],
      ["Context", th.digest.context ? `${tokens(th.digest.context)} tokens` : null],
      ["Thread", `\`${id}\``],
    ].filter(([, v]) => v);
    const usage = usageOf(await h.limits().catch(() => null));
    return [rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n"), usage].filter(Boolean).join("\n\n");
  }
  // Its ChatGPT plan's limits, as its profile has them (limits.ts), as a table.
  function usageOf(r: LimitsRead | null) {
    const l = r?.limits?.[0];
    if (!l?.windows?.length) return r?.error ? `Codex couldn't say how much of its limits it has used: ${r.error}` : "";
    const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");
    const rows = l.windows.map((w) => `| ${w.label} | ${Math.round(w.used)}% | ${at(w.resets)} |`);
    const head = `**${[l.name, l.plan].filter(Boolean).join(" ")} limits**${l.blocked ? " · out until one resets" : ""}`;
    return `${head}\n\n${["| Limit | Used | Resets |", "| --- | --- | --- |", ...rows].join("\n")}`;
  }
  // /mcp: each MCP server, whether it's up, and how many tools it gives.
  const MCP_STATES = { connected: "Connected", starting: "Starting", notStarted: "Not started", failed: "Failed", authenticationRequired: "Needs you to sign in", cancelled: "Cancelled", disabled: "Off" };
  async function mcpOf(id: string) {
    const r = await h.call<CodexList<CodexMcpStatus>>("mcpServerStatus/list", { threadId: id, detail: "toolsAndAuthOnly" });
    const servers = r?.data || [];
    if (!servers.length) return "Codex has no MCP servers.";
    const rows = servers.map((m) => {
      const n = Object.keys(m.tools || {}).length;
      const st = m.authStatus === "notLoggedIn" ? "Needs you to sign in" : MCP_STATES[m.runtimeStatus] || (m.toolsError ? "Failed" : "");
      return `| ${String(m.name).replace(/\|/g, "\\|")} | ${st}${m.toolsError ? `: ${short(m.toolsError, 80).replace(/\|/g, "\\|")}` : ""} | ${n} |`;
    });
    return ["| MCP server | Status | Tools |", "| --- | --- | --- |", ...rows].join("\n");
  }

  return {
    list,
    run,
    compacted,
    // Codex said its skills changed: they're listed again when next asked.
    forget: () => skillsByCwd.clear(),
  };
}
