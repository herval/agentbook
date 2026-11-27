// What Codex's app-server says, as agentbook reads it: its threads, turns and items (only the fields read), and an
// item as a step on a thread, in the voice of Claude's steps ("Run the tests", "Edit src/app.js").

import { short } from "../kit/steps.ts";
import { SEEN_TOOL, seenTitle } from "../../transcript.ts";

// What Codex's app-server answers (JSON-RPC over its socket): only what agentbook reads of it. Times are in seconds.
// A thread, as thread/read, thread/list, thread/start, thread/resume and thread/fork say it.
export interface CodexThread {
  id: string;
  cwd?: string | { path?: string };
  name?: string | null;
  preview?: string;
  model?: string;
  status?: { type: string; activeFlags?: string[] };
  updatedAt?: number;
  createdAt?: number;
  turns?: CodexTurn[];
  source?: string | { custom?: unknown; subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_nickname?: string; agent_role?: string } } };
  ephemeral?: boolean;
  threadSource?: string;
  gitInfo?: { branch?: string } | null;
  // A fork's: the thread it was forked from.
  forkedFromId?: string | null;
}
export interface CodexTurn {
  id: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: { message?: string } | null;
  items?: CodexItem[];
}
// One thing a turn did (said, ran, changed, searched): its fields are its type's.
export interface CodexItem {
  id: string;
  type: string;
  text?: string;
  status?: string;
  [k: string]: unknown;
}
// What thread/start, thread/resume, thread/fork and thread/read answer: the thread, and what it runs with.
export interface CodexThreadReply {
  thread?: CodexThread;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string | Record<string, unknown>;
  sandbox?: { type?: string; writableRoots?: string[] };
}
// A list Codex answers (thread/list, skills/list, model/list, ...).
export interface CodexList<T> {
  data?: T[];
  nextCursor?: string | null;
}
// Codex's config (its config.toml, as config/read gives it): only what agentbook reads.
export interface CodexConfig {
  mcp_servers?: Record<string, { url?: string; enabled?: boolean }>;
  model_provider?: string;
  model?: string;
  model_reasoning_effort?: string;
  approval_policy?: string | Record<string, unknown>;
  sandbox_mode?: string;
}
// config/read: the config, and which file each part of it is from.
export interface CodexConfigRead {
  config?: CodexConfig;
  origins?: Record<string, { name?: { type?: string; file?: string } }>;
  layers?: { name?: { type?: string; file?: string; profile?: string }; config?: CodexConfig }[];
}
export interface CodexSkill {
  name: string;
  path?: string;
  enabled?: boolean;
  description?: string;
  shortDescription?: string;
  scope?: string;
  pluginId?: string;
  interface?: { shortDescription?: string };
}
export interface CodexModel {
  id: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
}
// A thread's goal (/goal): what it works toward, how it stands, and what it spent on it.
export interface CodexGoal {
  objective?: string;
  status?: string;
  timeUsedSeconds?: number;
  tokensUsed?: number;
  tokenBudget?: number;
}
// An MCP server, as mcpServerStatus/list says it: whether it's up, and its tools.
export interface CodexMcpStatus {
  name: string;
  tools?: Record<string, unknown>;
  authStatus?: string;
  runtimeStatus?: string;
  toolsError?: string;
}
// What a turn is sent besides its text (a skill it's to use).
export interface CodexInput {
  type: string;
  name?: string;
  path?: string;
}

// What a thread runs with, as loading it says (thread/resume, thread/start) or Codex says it changed: what /status shows.
export interface CodexSettings {
  model: string | null;
  effort: string | null;
  approvals: string | Record<string, unknown> | null;
  sandbox: string | null;
  // The folders it may write besides its own (a group's), kept when its mode is switched.
  roots?: string[];
}
export const settingsOf = (r: Omit<CodexThreadReply, "thread"> | null): CodexSettings | null => (r ? { model: r.model || null, effort: r.reasoningEffort || null, approvals: r.approvalPolicy || null, sandbox: r.sandbox?.type || null, roots: r.sandbox?.writableRoots || [] } : null);

// Codex's times are whole seconds.
export const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
export const cwdOf = (t: CodexThread) => (typeof t.cwd === "string" ? t.cwd : t.cwd?.path || "");
// What a heartbeat automation sends into its thread each time: "<heartbeat><automation_id>…</automation_id>…".
export const heartbeatOf = (text) => String(text || "").match(/^\s*<heartbeat>[\s\S]*?<automation_id>([^<]+)<\/automation_id>/)?.[1] || null;
// Codex runs commands as `/bin/zsh -lc '<command>'`.
export const unwrap = (cmd) => {
  const s = Array.isArray(cmd) ? cmd.join(" ") : String(cmd || "");
  const m = s.match(/^\S*\/(?:ba|z)?sh -l?c '([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'") : s;
};

// A side thread's own turns: Codex's fork copies the thread's turns into it with their ids and start times, so the ones
// that started before you sent it on the side (`side_at`) are the thread's, not its own.
export function ownTurns(turns, sideAt) {
  const from = sideAt ? Date.parse(sideAt) / 1000 : 0;
  return from ? (turns || []).filter((t) => (Number(t.startedAt) || 0) >= Math.floor(from)) : turns || [];
}
export const PLAN = { pending: "pending", inProgress: "in_progress", in_progress: "in_progress", completed: "completed" };

// A web search item is a search, a page it opened, a search in a page, or ("other") pages it read from what it
// found, and only a search has a query: the others have "" or their page's URL in `query`, so they're named by
// their page, as Claude's WebFetch is ("Read example.com"). Its action and results come when it completes.
const site = (u) => {
  try {
    const url = new URL(u);
    return short(url.host.replace(/^www\./, "") + (url.pathname === "/" ? "" : url.pathname), 60);
  } catch {
    return short(u, 60);
  }
};
function webStep(item) {
  const a = item.action || {};
  if (a.type === "openPage" && a.url) return `Read ${site(a.url)}`;
  if (a.type === "findInPage" && a.url) return a.pattern ? `Find “${short(a.pattern, 40)}” in ${site(a.url)}` : `Read ${site(a.url)}`;
  if (a.type !== "openPage" && a.type !== "findInPage") {
    const q = String(item.query || "").trim() || a.query || a.queries?.find((x) => x?.trim());
    if (q) return `Search the web for “${short(q, 60)}”`;
  }
  const pages = [...new Set((item.results || []).map((r) => r?.url).filter(Boolean))];
  if (pages.length) return `Read ${site(pages[0])}${pages.length > 1 ? ` and ${pages.length - 1} more` : ""}`;
  return "Search the web";
}

// One line per item, in the voice of Claude's steps ("Run the tests", "Edit src/app.js").
export function stepOf(item, cwd) {
  const rel = (p) => (p && cwd && String(p).startsWith(cwd + "/") ? String(p).slice(cwd.length + 1) : String(p || ""));
  switch (item.type) {
    case "commandExecution": {
      const a = (item.commandActions || [])[0];
      if (a?.type === "read" && a.path) return `Read ${short(rel(a.path), 70)}`;
      if (a?.type === "search") return a.query ? `Search for “${short(a.query, 50)}”` : "Search the files";
      if (a?.type === "listFiles") return `List ${short(rel(a.path) || "the folder", 60)}`;
      return `Run ${short(unwrap(item.command), 70)}`;
    }
    case "fileChange": {
      const files = (item.changes || []).map((c) => rel(c.path));
      return files.length ? `Edit ${short(files.join(", "), 70)}` : "Edit files";
    }
    case "mcpToolCall":
      if (SEEN_TOOL.test(item.tool || "")) return seenTitle(item.tool, item.arguments);
      return `Use ${item.server} ${String(item.tool || "").replace(/[-_]/g, " ")}`;
    case "dynamicToolCall":
      return `Use ${item.tool}`;
    case "webSearch":
      return webStep(item);
    case "collabAgentToolCall":
      return item.tool === "wait" ? "Wait for its subagents" : `Subagent: ${short(item.prompt || item.tool || "", 70)}`;
    case "imageGeneration":
      return "Generate an image";
    case "imageView":
      return `Look at ${short(rel(item.path), 60)}`;
    case "contextCompaction":
      return "Compact the conversation";
    // A review (/review): what it looks at, as Codex says it ("current changes", "commit a41c9e0").
    case "enteredReviewMode":
      return `Review ${short(item.review || "the changes", 60)}`;
    default:
      return null;
  }
}
export const failed = (item) => item.status === "failed" || item.status === "declined" || (item.type === "commandExecution" && item.exitCode != null && item.exitCode !== 0) || !!item.error;
export const errorOf = (item) => short(item.error?.message || (item.type === "commandExecution" ? `Exited with ${item.exitCode}${item.aggregatedOutput ? `: ${item.aggregatedOutput}` : ""}` : item.status), 160) || "Failed";
