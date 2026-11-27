// What runtimes that keep a thread's steps themselves share (OpenClaw's, Hermes's, dsh's, Claude Agent's, Devin's): a
// post's steps (its digest), what the page shows of them, and the names of their tools in words.

import { argEdits, COMMITS, filesChanged, noteEdit } from "../../changes.ts";
import { notePrs } from "../../../shared/prs.ts";
import { describeTool, liveStep, said, SEEN_TOOL, seenTitle } from "../../transcript.ts";
import type { PlanItem, PostPr, Session } from "../../../shared/types.ts";
import type { Mode } from "../../../shared/runtimes.ts";
import type { KeptEdit as Edit, NewEdit } from "../../../shared/diff.ts";

export const KEEP = 3000; // steps kept per post

// One of a post's steps: something it said ("say"), or a tool it used ("tool"), in turn `turn`. A tool's `done`:
// when it ended; `error`: why it failed.
export interface Step {
  id: string;
  turn?: number;
  at: string | null;
  kind: "say" | "tool";
  text?: string;
  tool?: string;
  title?: string;
  done?: string | null;
  error?: string | null;
  // How many pictures its result held (a screenshot, an image it read): a Claude Code step's.
  images?: number;
  // The files it changed, and by how many lines (noteEdit).
  files?: { path: string; kind: string; add: number; del: number }[];
}

// An edit a post made, as noteEdit (plugin/shared/diff.ts) keeps it: the file (`abs`, and `path` as the page shows
// it), what it did and by how many lines, the step and turn it was in, and where to find what it did (`op` itself,
// or `src` for the digest's owner to read back).
export type { KeptEdit as Edit } from "../../../shared/diff.ts";
// A commit a post made: the step whose command made it, and when it ran (`from`, `to`), so the commits made then
// are its. `sha`: the one its output named.
export interface Commit {
  step: string | null;
  turn: number;
  from: string | null;
  to: string | null;
  sha: string | null;
}
// What a tool call was asked to change, kept until it's done (toolDone): its edits, whether it commits, and its
// command.
interface Asked {
  edits: NewEdit[];
  commits: boolean;
  command: string;
  cwd: string;
}

// A post's steps and stats (see blank).
export interface Digest {
  steps: Step[];
  byId?: Map<string, Step>;
  plan: PlanItem[] | null;
  turn: number;
  tools: number;
  errors: number;
  worked: number;
  context: number;
  model: string | null;
  ai_title: string | null;
  n: number;
  edits: Edit[];
  commits: Commit[];
  prs: Record<string, PostPr>;
  skill_uses: Record<string, number>;
  // Its whole history, not only its latest (skillUses).
  whole?: boolean;
}
// A driver's digest, as blank makes it: with the tool calls it waits on to say they're done.
export interface DriverDigest extends Digest {
  byId: Map<string, Step>;
  asked: Map<string, Asked>;
}


export const short = (s, n = 90) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
export const iso = (t) => {
  if (t == null || t === "") return null;
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// A post's steps: what it said ("say") and the tools it used ("tool"), turn by turn, with its stats. `edits`
// and `commits`: what it changed (changes.ts), from its tools' arguments, once they've succeeded (`asked`).
// `prs`: the pull requests its shell commands opened or worked on (pulls.ts). `skill_uses`: how often it
// used each skill (see skillsOf).
export function blank(): DriverDigest {
  return { steps: [], byId: new Map(), plan: null, turn: 0, tools: 0, errors: 0, worked: 0, context: 0, model: null, ai_title: null, n: 0, edits: [], commits: [], prs: {}, skill_uses: {}, asked: new Map() };
}

export function addSay(d: Digest, { id, at, text }: { id: string; at: string | null; text: string | null | undefined }) {
  if (!text?.trim()) return;
  d.steps.push({ id, turn: d.turn, at, kind: "say", text: said(text) });
  trim(d);
}
// `args`: what the tool was asked, as an object or its JSON.
export function addTool(d: DriverDigest, { id, at, name, args, cwd }: { id: string; at: string | null; name: string; args: unknown; cwd?: string }) {
  if (d.byId.has(id)) return d.byId.get(id);
  const step: Step = { id, turn: d.turn, at, kind: "tool", tool: name, title: toolTitle(name, args, cwd) };
  d.steps.push(step);
  d.byId.set(id, step);
  d.tools++;
  trim(d);
  for (const k of skillsOf(name, args)) d.skill_uses[k] = (d.skill_uses[k] || 0) + 1;
  const edits = argEdits(name, args, cwd);
  const command = ALIASES[String(name || "").toLowerCase()]?.[0] === "Bash" ? String(parsed(args).command ?? parsed(args).cmd ?? "") : "";
  if (edits.length || COMMITS.test(command) || /\bgh\s+pr\b/.test(command)) d.asked.set(id, { edits, commits: COMMITS.test(command), command, cwd });
  return step;
}
export function toolDone(d: DriverDigest, id: string, { at, error, output }: { at: string | null; error?: string | null; output?: string | null }) {
  const step = d.byId.get(id);
  if (!step || step.done) return;
  step.done = at;
  if (error) {
    step.error = short(error, 300);
    d.errors++;
  }
  const asked = d.asked.get(id);
  d.asked.delete(id);
  if (!asked || error) return;
  for (const e of asked.edits) noteEdit(d, step, { ...e, at }, asked.cwd);
  if (asked.commits) d.commits.push({ step: id, turn: step.turn, from: step.at, to: at, sha: null });
  if (asked.command) notePrs((d.prs ||= {}), asked.command, output, at);
}
const parsed = (a) => {
  if (typeof a !== "string") return a || {};
  try {
    return JSON.parse(a) || {};
  } catch {
    return {};
  }
};
// The skills a tool call used. OpenClaw's and Hermes's agents read a skill's SKILL.md, with their read tool or
// a command, or (OpenClaw's code mode) ask for it by name inside exec, `skills.read("<name>")`; one on the
// claude-cli runtime uses Claude Code's Skill tool, where OpenClaw hands it its skills as a plugin of its own
// ("openclaw-skills:<name>"). A skill read from its file is named after its folder, when that's a name
// (not a glob's `*`, or a shell variable's `$d`).
const SKILL_MD = /(?<![^\s/\\'"`=])([\w.-]+)[/\\]SKILL\.md\b/g;
const SKILL_READ = /\bskills\.read\(\s*["'`]([^"'`]+)["'`]/g;
const skillName = (k) => String(k).replace(/^openclaw-skills:/, "");
export function skillsOf(name, args) {
  const a = parsed(args);
  const tool = ALIASES[String(name || "").toLowerCase()]?.[0] || name;
  if (tool === "Skill") return a.skill ? [skillName(a.skill)] : [];
  const text = tool === "Read" ? String(a.path ?? a.file_path ?? "") : tool === "Bash" ? Object.values(a).filter((v) => typeof v === "string").join("\n") : "";
  return [...new Set([...text.matchAll(SKILL_MD), ...text.matchAll(SKILL_READ)].map((m) => m[1]))];
}
function trim(d: Digest) {
  if (d.steps.length > KEEP) for (const s of d.steps.splice(0, d.steps.length - KEEP)) d.byId?.delete(s.id);
}

// OpenClaw's, Hermes's and dsh's tools, in the words agentbook uses for Claude Code's.
const ALIASES = {
  exec: ["Bash", (a) => ({ command: a.command ?? a.cmd })],
  bash: ["Bash", (a) => ({ command: a.command })],
  terminal: ["Bash", (a) => ({ command: a.command })],
  shell: ["Bash", (a) => ({ command: a.command })],
  pwsh: ["Bash", (a) => ({ command: a.command })],
  read: ["Read", (a) => ({ file_path: a.path ?? a.file_path })],
  read_file: ["Read", (a) => ({ file_path: a.path ?? a.file_path })],
  write: ["Write", (a) => ({ file_path: a.path ?? a.file_path })],
  write_file: ["Write", (a) => ({ file_path: a.path ?? a.file_path })],
  edit: ["Edit", (a) => ({ file_path: a.path ?? a.file_path })],
  patch: ["Edit", (a) => ({ file_path: a.path ?? a.file_path })],
  search_files: ["Grep", (a) => ({ pattern: a.pattern ?? a.query })],
  grep: ["Grep", (a) => ({ pattern: a.pattern })],
  glob: ["Glob", (a) => ({ pattern: a.pattern })],
  web_search: ["WebSearch", (a) => ({ query: a.query })],
  web_fetch: ["WebFetch", (a) => ({ url: a.url })],
  web_extract: ["WebFetch", (a) => ({ url: Array.isArray(a.urls) ? a.urls[0] : a.url })],
};
export function toolTitle(name, args, cwd = "") {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = {};
    }
  }
  a ||= {};
  const alias = ALIASES[String(name || "").toLowerCase()];
  if (alias) return describeTool(alias[0], alias[1](a), cwd);
  if (SEEN_TOOL.test(String(name || ""))) return seenTitle(name, a);
  // OpenClaw's message tool (mcp__openclaw__message in a claude-cli agent): what it sent, a file or its words.
  if (/^(?:\w+__)?message$/i.test(String(name || "")) && /^send/i.test(String(a.action || ""))) {
    const file = [a.media, a.mediaUrl, a.path, a.filePath, a.fileUrl, ...(Array.isArray(a.attachments) ? a.attachments.map((x) => x?.media || x?.path) : [])].find((v) => typeof v === "string" && v.trim());
    const text = [a.message, a.text, a.caption].find((v) => typeof v === "string" && v.trim());
    if (file) return `Sent ${short(String(file).split(/[\\/]/).pop(), 70)}`;
    if (text) return `Sent "${short(text.replace(/\s+/g, " "), 70)}"`;
  }
  const what = a.description || a.query || a.path || a.url || a.command;
  return what ? `${name}: ${short(what, 70)}` : `Use ${name}`;
}

// What a post shows while it runs, and its summary (title, model, stats), kept in the log like Claude's.
export type Live = ReturnType<typeof liveOf>;
// `mode`: the one its transcript says it's in, for a runtime whose transcript says (Claude Code's).
export type Summary = ReturnType<typeof summaryOf> & { mode?: Mode };
export function liveOf(d: Digest | null | undefined) {
  if (!d) return null;
  const turn = d.steps.filter((x) => x.turn === d.turn);
  const step = [...turn].reverse().find((x) => x.kind === "tool" && !x.done) || turn.at(-1) || null;
  return { step: liveStep(step), plan: d.plan, steps: d.tools, turn_steps: turn.filter((x) => x.kind === "tool").length, turn_start: turn[0]?.at || null };
}
export function summaryOf(d: Digest | null | undefined, s?: Session | null) {
  if (!d) return null;
  const files = s ? filesChanged(d.edits, s) : 0;
  const { uses } = skillUses(d, s);
  return { ai_title: d.ai_title, model: d.model, plan: d.plan, context: d.context, prs: d.prs || {}, ...(Object.keys(uses).length ? { skill_uses: uses } : {}), stats: { steps: d.tools, errors: d.errors, worked_ms: d.worked, ...(files ? { files } : {}) } };
}

// How often a post used each skill: what its digest counted. A digest of only its latest history (after a
// restart, a long post's) is never less than the post already says, under the skill's own name (one counted
// under OpenClaw's plugin's moves to it; what isn't a skill's name goes); one of all of it (`whole`) is.
// `changed`: that isn't what the post says.
const SKILL_NAME = /^[\w.-]+(:[\w.-]+)*$/;
export function skillUses(d: Pick<Digest, "skill_uses" | "whole"> | null | undefined, s: Pick<Session, "skill_uses"> | null | undefined) {
  const kept = s?.skill_uses || {};
  const uses: Record<string, number> = {};
  if (!d?.whole)
    for (const [k, n] of Object.entries(kept)) {
      const name = skillName(k).replace(/^[*?]+/, "");
      if (SKILL_NAME.test(name)) uses[name] = (uses[name] || 0) + n;
    }
  for (const [k, n] of Object.entries(d?.skill_uses || {})) uses[k] = Math.max(uses[k] || 0, n);
  const changed = Object.keys(uses).length !== Object.keys(kept).length || Object.entries(uses).some(([k, n]) => kept[k] !== n);
  return { uses, changed };
}
