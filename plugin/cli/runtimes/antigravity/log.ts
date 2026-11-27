// What Antigravity CLI keeps of a session, read-only: its transcript, one JSON record a line, at
// ~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl (the path its hooks are given).
// A USER_INPUT record starts a turn; a PLANNER_RESPONSE is what the model said (`content`) and the tools it called
// (`tool_calls`, each argument JSON-encoded), and the GENERIC records after it are those calls' outputs, in order.
// Its thinking stays out.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEEN_TOOL } from "../../transcript.ts";
import { addSay, addTool, blank, short, toolDone } from "../kit/steps.ts";
import type { DriverDigest } from "../kit/steps.ts";

// Where agy keeps its data: AGENTBOOK_AGY_DATA says, for tests (agy's own --app-data-dir isn't read here).
const DATA = () => process.env.AGENTBOOK_AGY_DATA || path.join(os.homedir(), ".gemini", "antigravity-cli");
export const transcriptOf = (id: string) => path.join(DATA(), "brain", id, ".system_generated", "logs", "transcript.jsonl");

// agy's own tools, by the name and input agentbook knows each kind by. Others keep their name and input.
const TOOLS: Record<string, (a: Record<string, any>) => [string, Record<string, unknown>]> = {
  run_command: (a) => ["Bash", { command: a.CommandLine ?? a.command ?? "" }],
  view_file: (a) => ["Read", { file_path: a.AbsolutePath ?? a.file_path }],
  write_to_file: (a) => ["Write", { file_path: a.TargetFile ?? a.file_path, content: a.CodeContent ?? "" }],
  replace_file_content: (a) => ["Edit", { file_path: a.TargetFile ?? a.file_path }],
  multi_replace_file_content: (a) => ["Edit", { file_path: a.TargetFile ?? a.file_path }],
  grep_search: (a) => ["Grep", { pattern: a.Query ?? a.pattern, path: a.SearchPath ?? a.path }],
  find_by_name: (a) => ["Glob", { pattern: a.Pattern ?? a.pattern, path: a.SearchDirectory ?? a.path }],
  search_web: (a) => ["WebSearch", { query: a.query ?? a.Query }],
  read_url_content: (a) => ["WebFetch", { url: a.Url ?? a.url }],
};
// Whether a tool is one of agentbook's own (ab_post, ab_ask…), by the name agy gives it: mcp_agentbook_ab_post.
export const bookName = (name: unknown) => /^mcp_agentbook_(ab_\w+)$/.exec(String(name || ""))?.[1] || null;
// A tool call as a step's tool and input, and whether it stays off the steps (agentbook's own tools, but for those
// that read other threads). Null when agy didn't name it.
export function namedTool(name: unknown, args: Record<string, any> | null | undefined) {
  const n = String(name || "");
  if (!n) return null;
  const a = args && typeof args === "object" ? args : {};
  const book = bookName(n);
  if (book) return { name: `mcp__agentbook__${book}`, args: a, quiet: !SEEN_TOOL.test(`mcp__agentbook__${book}`) };
  const [tool, input] = TOOLS[n]?.(a) || [n, a];
  return { name: tool, args: input, quiet: false };
}

// An argument as the transcript keeps it: JSON-encoded, else as it is.
const decoded = (args: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(
    Object.entries(args || {}).map(([k, v]) => {
      try {
        return [k, typeof v === "string" ? JSON.parse(v) : v];
      } catch {
        return [k, v];
      }
    }),
  );

export function readLog(id: string): Record<string, any>[] | null {
  let text: string;
  try {
    text = fs.readFileSync(transcriptOf(id), "utf8");
  } catch {
    return null;
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // a line it's still writing
  }
  return out;
}

export function digestOf(records: Record<string, any>[], cwd?: string): DriverDigest {
  const d = blank();
  let waiting: (string | null)[] = []; // the calls whose outputs come next, by step id (null: one that's off the steps)
  for (const r of records) {
    const at = typeof r.created_at === "string" ? r.created_at : null;
    if (r.type === "USER_INPUT") {
      d.turn++;
      waiting = [];
    } else if (r.type === "PLANNER_RESPONSE") {
      if (r.model) d.model = r.model;
      if (typeof r.content === "string" && r.content.trim()) addSay(d, { id: `agy-${r.step_index}`, at, text: r.content });
      waiting = [];
      (Array.isArray(r.tool_calls) ? r.tool_calls : []).forEach((c, i) => {
        const t = namedTool(c?.name, decoded(c?.args));
        if (!t || t.quiet) return void waiting.push(null);
        const id = `agy-${r.step_index}-${i}`;
        addTool(d, { id, at, name: t.name, args: t.args, cwd });
        waiting.push(id);
      });
    } else if (r.type === "GENERIC" && waiting.length) {
      const id = waiting.shift();
      if (id) toolDone(d, id, { at, output: typeof r.content === "string" ? short(r.content, 4000) : "", error: r.status && r.status !== "DONE" ? String(r.content || r.status) : null });
    }
  }
  return d;
}
