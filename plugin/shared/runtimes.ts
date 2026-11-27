// The agent runtimes agentbook runs: what each one is called and what its threads can do,
// for the machine (plugin/cli/runtimes/), the server and the page alike. The server and the page ask this, by an
// agent's kind or a thread's runtime, and never compare a runtime's name: a new runtime is an entry here and an
// adapter in plugin/cli/runtimes/, and nothing else needs to know its name.

export type RuntimeId = "claude-code" | "codex" | "openclaw" | "hermes" | "dsh" | "antigravity" | "grok" | "claude-agent" | "devin" | "claude-cloud" | "codex-cloud";

export interface RuntimeInstall {
  state: "available" | "installing" | "installed" | "failed";
  source: string;
  after: string;
  started?: string;
  finished?: string;
  output?: string;
  error?: string;
}

// A runtime's app on a machine and the newest version out (caps.updates): the version it runs now, the newest on
// the channel it follows, and an update agentbook ran there (`state`), with what it printed.
export interface RuntimeUpdate {
  version: string | null;
  latest: string | null;
  outdated: boolean;
  state: "idle" | "updating" | "updated" | "failed";
  // Why it can't update now (a running turn the update would cut off), or absent.
  wait?: string;
  started?: string;
  finished?: string;
  // The version it had when the update started.
  from?: string | null;
  output?: string;
  error?: string;
}

// How much a thread may do without asking, picked as it starts: the same four for every agent, each mapped by its
// runtime to its own setting. ask: asks before commands and edits; auto: edits in its folder and safe commands go
// ahead, and the agent's own check decides when to ask; plan: reads and plans, changes nothing; full: never asks.
export type Mode = "ask" | "auto" | "plan" | "full";
export const MODES: readonly Mode[] = ["ask", "auto", "plan", "full"];
export const isMode = (m: unknown): m is Mode => typeof m === "string" && (MODES as readonly string[]).includes(m);

// What a runtime's threads can do, and how agentbook works with them.
export interface RuntimeCaps {
  // Whether it sees threads started in its own apps (a terminal, a chat channel), or only those agentbook starts.
  discovers: "all" | "own";
  // Where its threads work: a folder on this machine, a repository it clones where it runs, or its own workspace.
  where: "folder" | "repo" | "own";
  // Whether a path it names is on this disk.
  localFiles: boolean;
  // How the files you attach reach it: their paths here, or uploaded to it.
  attach: "paths" | "upload";
  // What happens to a message you send while it works (steered into the turn, or held for its end), and while it's
  // idle (sent, or the thread is woken to take it).
  delivery: { midTurn: "steer" | "hold"; idle: "send" | "wake" };
  // How long ab_ask waits for an answer when the agent doesn't say (seconds): an agent that can't be woken by the
  // answer waits for it.
  askWait: number;
  // Whether its threads have agentbook's tools: always ("sure"), when it was given them ("likely"), or never.
  tools: "sure" | "likely" | "none";
  // Whether its threads write pages and notes (ab_page_write, ab_note_*), so it can be asked to.
  writesPages: boolean;
  // Whether its threads work in their group's folder here.
  groupFolders: boolean;
  // Whether a thread can go on in a side thread (a fork of it).
  side: boolean;
  // Whether agentbook can switch a thread's model, and its effort (how hard its model thinks).
  models: boolean;
  efforts: boolean;
  // Whether agentbook can switch a thread's mode once it runs: from its next turn ("next"), or at once ("now").
  switchesMode: false | "next" | "now";
  // The modes a thread can start in (MODES), in that order: none for one whose agent never asks (Devin, a cloud's),
  // or whose mode agentbook can't set yet (Hermes, Claude Agent).
  modes: readonly Mode[];
  // Whether Full access runs apart from its other modes (Antigravity's agy of its own), so a thread moves into it or
  // out of it between its turns, even where its other modes switch at once.
  fullApart: boolean;
  // Whether its threads take slash commands, and whether one waits for a running turn to end.
  commands: false | "steer" | "wait";
  // Whether a thread that won't stop can be force-stopped (its process killed).
  forceStop: boolean;
  // Whether its threads fall asleep when idle and are woken to take a message.
  sleeps: boolean;
  // Whether agentbook keeps a thread's folder (puts back a missing one, knows it's gone).
  keepsFolder: boolean;
  // Whether its threads can be brought into another thread as guests, or join one as they are: they work in a folder
  // here or go by what's said, and read the thread they're in with ab_thread_read.
  guests: boolean;
  // Whether its machine reads how much of its plan's usage limits it has used (an agent's Usage card): its own, or
  // shared by each agent that signs in the same way (an OpenClaw gateway's sign-ins, the same for each of its agents).
  limits: false | "own" | "shared";
  // Whether agentbook's routines can run on it: a routine starts one of its threads on a schedule, or writes to one.
  routines: boolean;
  // Whether it gives its agents pictures of their own, which an agent's profile can go back to after another.
  avatars: boolean;
  // Whether what you write on one of its threads reaches it from agentbook (Codex Cloud takes follow-ups on its own
  // page instead).
  replies: boolean;
  // Whether a thread's changes can be applied to a checkout here, from its thread (a Codex Cloud task's).
  applies: boolean;
  // Whether a thread that ended takes a message all the same: agentbook resumes its session (Claude Code's).
  resumes: boolean;
  // Whether agentbook updates its app on a machine once a newer version is out (its machine's Agents table), with
  // the app's own update command.
  updates: boolean;
  // Whether a machine installs its app from the page (Add agents), with the machine's own recipe for it
  // (cli/runtime-install.ts).
  installs: boolean;
}

// A field of a runtime's setup form (Settings → Agents), which the page draws for any runtime that has one. What it
// saved never comes back: the machine says only whether it has it (`saved`, a field of the runtime's connection) and,
// for what isn't secret, what it is now (`now`).
export interface SetupField {
  // What it's sent as.
  key: "key" | "org" | "github_token" | "budget";
  label: string;
  // Small, after its label: "optional", "only if the key has several".
  note?: string;
  // Hidden as typed; when it's saved, its box says so and left empty keeps it.
  secret?: boolean;
  // The connection's field that says it's saved ("connected" for the key, "github" for a GitHub token).
  saved?: string;
  // The connection's field with its value now, and how that reads ("$12.50 now", "4 now").
  now?: string;
  nowAs?: "dollars" | "plain";
  placeholder?: string;
  input?: "text" | "numeric" | "decimal";
  // Needed to connect, not to save once connected.
  required?: boolean;
}
export interface SetupForm {
  fields: SetupField[];
  // What it says under the form: where the key is from, where it's kept. "{machine}" is the machine's name, and
  // [text](url) a link.
  about: string;
  // What its row says under its name: where it runs ("In Devin's cloud"), then, once it's connected, what each of
  // `row` says of a field, in that order: `set` while it has a value (its `now`, or for a secret, that it's `saved`),
  // with "{v}" for the value, else `unset`, when there's something to say then.
  where: string;
  row?: { key: SetupField["key"]; set: string; unset?: string }[];
}

export interface RuntimeInfo {
  id: RuntimeId;
  // Its name, as a person reads it: "Codex".
  name: string;
  // Where its threads run, when that's a place of its own: "Codex Cloud", "claude.ai".
  place?: string;
  // Its threads' procs start with one of these, then ":": the first is what new threads get, the rest are older names.
  procs: string[];
  caps: RuntimeCaps;
  // How it's connected on Settings → Agents, when it's by a key you paste there.
  setup?: SetupForm;
  // What an agent of it is, in a few words, where its kind shows (its profile, People, a group): "Coding agent in
  // Codex". A runtime that's an agent's kind has one; a cloud, where an agent's threads run, doesn't.
  about?: string;
  // What the routines list tags what it runs on a schedule of its own with (its routines, automations, cron jobs):
  // where those live ("Codex app", "claude.ai"), or its name.
  scheduler?: string;
  // How the page says where a thread of it runs, when that's a place of its own (`place`): beside the thread ("In
  // Codex Cloud"), as its chip's hint ("Runs in Codex Cloud") and on the link there ("Open in Codex Cloud").
  placeWords?: { runs: string; chip: string; open: string };
  // What its agents are told as a thread starts (cli/context.ts): what shows on the thread by itself, and how the
  // person's comments reach them ("{Person}" is who they are, starting a sentence). One that says neither is told
  // Claude Code's, whose comments arrive as its channel or its turns allow.
  told?: { shows: string; reaches?: string };
}

const LOCAL: RuntimeCaps = {
  discovers: "all",
  where: "folder",
  localFiles: true,
  attach: "paths",
  delivery: { midTurn: "steer", idle: "send" },
  askWait: 0,
  tools: "likely",
  writesPages: true,
  groupFolders: false,
  side: false,
  models: false,
  efforts: false,
  switchesMode: false,
  modes: [],
  fullApart: false,
  commands: false,
  forceStop: false,
  sleeps: false,
  keepsFolder: false,
  guests: true,
  limits: false,
  routines: true,
  avatars: false,
  replies: true,
  applies: false,
  resumes: false,
  updates: false,
  installs: false,
};

export const RUNTIMES: Record<RuntimeId, RuntimeInfo> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    procs: [],
    caps: { ...LOCAL, delivery: { midTurn: "steer", idle: "wake" }, askWait: 300, tools: "sure", groupFolders: true, side: true, models: true, efforts: true, switchesMode: "next", modes: MODES, commands: "wait", forceStop: true, sleeps: true, keepsFolder: true, limits: "own", resumes: true, updates: true },
    about: "Coding agent in Claude Code",
    scheduler: "claude.ai",
    told: { shows: "Shows there on its own: your steps, plan (TodoWrite), pull requests, edits and screenshots, from your transcript." },
  },
  codex: {
    id: "codex",
    name: "Codex",
    procs: ["codex"],
    caps: { ...LOCAL, tools: "sure", groupFolders: true, side: true, models: true, efforts: true, switchesMode: "next", modes: MODES, commands: "wait", limits: "own", updates: true },
    about: "Coding agent in Codex",
    scheduler: "Codex app",
    told: {
      shows: "Shows there on its own: your commands, edits, plan, and your reply at the end of each turn, which is your comment on the thread. Your approval requests appear there as Allow/Deny.",
      reaches: "{Person}'s comments reach you as your next message, or steer the turn you're in.",
    },
  },
  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    procs: ["openclaw"],
    caps: { ...LOCAL, where: "own", localFiles: false, attach: "upload", askWait: 300, modes: MODES, commands: "steer", limits: "shared", avatars: true },
    about: "Agent in OpenClaw",
    scheduler: "OpenClaw",
    told: {
      shows: "Shows there on its own: your tool calls and replies. A command or tool waiting for approval appears there as Allow/Deny.",
      reaches: "{Person}'s comments reach you as your next message, steering the turn you're in.",
    },
  },
  hermes: {
    id: "hermes",
    name: "Hermes",
    procs: ["hermes"],
    caps: { ...LOCAL, delivery: { midTurn: "hold", idle: "send" }, installs: true },
    about: "Agent in Hermes",
    scheduler: "Hermes",
    told: {
      shows: "Shows there on its own: your tool calls and replies. What you ask to do appears there as Allow/Deny.",
      reaches: "{Person}'s comments reach you as your next prompt.",
    },
  },
  dsh: {
    id: "dsh",
    name: "DeepSeek Harness",
    procs: ["dsh"],
    caps: { ...LOCAL, delivery: { midTurn: "hold", idle: "send" }, models: true, switchesMode: "now", modes: MODES, guests: false, installs: true },
    about: "Agent in DeepSeek Harness",
    scheduler: "DeepSeek Harness",
    told: {
      shows: "Shows there on its own: your tool calls and replies. What you ask to do appears there as Allow/Deny.",
      reaches: "{Person}'s comments reach you as your next prompt, once the turn you're in ends.",
    },
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    procs: ["agy"],
    caps: { ...LOCAL, discovers: "own", delivery: { midTurn: "hold", idle: "send" }, askWait: 300, tools: "sure", models: true, switchesMode: "now", modes: MODES, fullApart: true, guests: false, installs: true },
    about: "Coding agent in Antigravity CLI",
    told: {
      shows: "Shows there on its own: your tool calls, plan and replies. What you ask to do appears there as Allow/Deny.",
      reaches: "{Person}'s comments reach you as your next prompt, once the turn you're in ends.",
    },
  },
  // Its ACP server has no Plan mode (grok agent ignores --permission-mode plan), so its threads start in Ask, Auto or
  // Full access.
  grok: {
    id: "grok",
    name: "Grok",
    procs: ["grok"],
    caps: { ...LOCAL, discovers: "own", delivery: { midTurn: "hold", idle: "send" }, askWait: 300, tools: "sure", models: true, efforts: true, switchesMode: "now", modes: ["ask", "auto", "full"], commands: "wait", guests: false, updates: true, installs: true },
    about: "Coding agent in Grok CLI",
    told: {
      shows: "Shows there on its own: your tool calls, plan and replies. What you ask to do appears there as Allow/Deny.",
      reaches: "{Person}'s comments reach you as your next prompt, once the turn you're in ends.",
    },
  },
  "claude-agent": {
    id: "claude-agent",
    name: "Claude Agent",
    procs: ["claude-agent", "managed"],
    caps: { ...LOCAL, discovers: "own", where: "repo", localFiles: false, attach: "upload", askWait: 300, tools: "sure", guests: false, routines: false },
    about: "Agent in Anthropic's cloud",
    setup: {
      fields: [
        { key: "key", label: "API key", secret: true, saved: "connected", placeholder: "sk-ant-…", required: true },
        { key: "github_token", label: "GitHub token", note: "optional", secret: true, saved: "github", placeholder: "github_pat_…" },
        { key: "budget", label: "Most a thread may spend, in dollars", note: "optional", now: "budget", nowAs: "dollars", placeholder: "10", input: "decimal" },
      ],
      about: "The key is from [the Claude Console](https://platform.claude.com/settings/keys). The token goes to Anthropic for each repo a thread clones: use a fine-grained one. {machine} keeps the key: while it's asleep a thread pauses at its next agentbook tool or question. Your prompts and repos go to Anthropic.",
      where: "In Anthropic's cloud",
      row: [
        { key: "budget", set: "up to ${v} a thread" },
        { key: "github_token", set: "can push and open pull requests", unset: "public repos only" },
      ],
    },
  },
  devin: {
    id: "devin",
    name: "Devin",
    procs: ["devin"],
    caps: { ...LOCAL, discovers: "own", where: "repo", localFiles: false, attach: "upload", tools: "none", writesPages: false, guests: false, routines: false },
    about: "Agent in Devin's cloud",
    setup: {
      fields: [
        { key: "key", label: "API key", secret: true, saved: "connected", placeholder: "cog_…", required: true },
        { key: "org", label: "Organization id", note: "only if the key has several", now: "org" },
        { key: "budget", label: "Most ACUs a thread may use", note: "optional", now: "budget", nowAs: "plain", placeholder: "5", input: "numeric" },
      ],
      about: "A service user's key, from Devin's settings. Only threads you start from agentbook show here. {machine} keeps the key: while it's asleep Devin goes on working, and its threads catch up after. Your prompts and repos go to Devin.",
      where: "In Devin's cloud",
      row: [{ key: "budget", set: "up to {v} ACUs a thread", unset: "no limit on a thread" }],
    },
  },
  "claude-cloud": {
    id: "claude-cloud",
    name: "Claude Code",
    place: "claude.ai",
    procs: ["claudecloud"],
    caps: { ...LOCAL, discovers: "own", where: "repo", localFiles: false, tools: "none", writesPages: false, delivery: { midTurn: "steer", idle: "send" }, guests: false, routines: false },
    placeWords: { runs: "In the cloud", chip: "Runs in the cloud, on claude.ai", open: "Open on claude.ai" },
  },
  "codex-cloud": {
    id: "codex-cloud",
    name: "Codex",
    place: "Codex Cloud",
    procs: ["codexcloud"],
    caps: { ...LOCAL, where: "repo", localFiles: false, tools: "none", writesPages: false, guests: false, routines: false, replies: false, applies: true },
    placeWords: { runs: "In Codex Cloud", chip: "Runs in Codex Cloud", open: "Open in Codex Cloud" },
  },
};

export const isRuntimeId = (id: unknown): id is RuntimeId => typeof id === "string" && Object.hasOwn(RUNTIMES, id);
// The runtimes whose app agentbook can update on a machine (caps.updates): what runtime.update may name.
export const UPDATABLE: RuntimeId[] = Object.values(RUNTIMES).filter((r) => r.caps.updates).map((r) => r.id);
// The runtimes a machine installs from the page (caps.installs): what runtime.install may name.
export const INSTALLABLE: RuntimeId[] = Object.values(RUNTIMES).filter((r) => r.caps.installs).map((r) => r.id);

// The runtimes agentbook had and dropped, by an agent's kind. An agent of one goes, with its threads (agent.remove),
// once none of them ever ran a turn or keeps anything (cli/daemon.ts's retire); one that did stays, so it can be read.
// gemini: Gemini CLI, dropped on 2026-11-20 when Google stopped signing personal accounts in to it.
export const RETIRED: ReadonlySet<string> = new Set(["gemini"]);

// A runtime by an agent's kind: Claude Code's for an agent from before kinds (no kind), or of a kind this version
// doesn't know.
export const runtimeInfo = (kind?: string | null): RuntimeInfo => (isRuntimeId(kind) ? RUNTIMES[kind] : RUNTIMES["claude-code"]);
export const capsOf = (kind?: string | null): RuntimeCaps => runtimeInfo(kind).caps;

// The runtime whose proc this is ("codex:<thread>", or "managed:<session>" from before Claude Agent had one name),
// or null: a Claude Code session's proc is its process's, and `launch:<lid>` is a start not yet a thread.
const PREFIXES = new Map(Object.values(RUNTIMES).flatMap((r) => r.procs.map((p) => [p, r.id] as const)));
export function runtimeOfProc(proc: string | null | undefined): RuntimeId | null {
  const m = String(proc || "").match(/^([a-z][\w-]*):/);
  return (m && PREFIXES.get(m[1])) || null;
}
// Whether a proc is a thread a runtime other than Claude Code drives, or a start of one (`launch:<lid>`): its MCP
// server only writes, and its driver hands it what the person sends.
export const isDrivenProc = (proc: string | null | undefined): boolean => /^launch:/.test(String(proc || "")) || !!runtimeOfProc(proc);

// The runtime a thread runs on: a cloud's, by where it runs, else its proc's, else Claude Code's.
export function runtimeOfThread(s: { proc?: string | null; cloud?: string | null } | null | undefined): RuntimeId {
  if (s?.cloud === "claude") return "claude-cloud";
  if (s?.cloud === "codex") return "codex-cloud";
  return runtimeOfProc(s?.proc) || "claude-code";
}
export const threadCapsOf = (s: { proc?: string | null; cloud?: string | null } | null | undefined): RuntimeCaps => RUNTIMES[runtimeOfThread(s)].caps;
// The runtime that drives a thread on a machine, or null: not Claude Code, whose sessions run in its own process (in
// the background, a terminal or one of its apps), nor a cloud, whose threads run on their own page. agentbook hands
// it what's sent to the thread, and stops it, through that runtime.
export function drivenRuntime(s: { proc?: string | null; cloud?: string | null } | null | undefined): RuntimeInfo | null {
  const id = s && !s.cloud ? runtimeOfProc(s.proc) : null;
  return id ? RUNTIMES[id] : null;
}
