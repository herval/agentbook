// Grok's tool calls, as steps. Grok 1.0.89 names its own tools in `_meta["x.ai/tool"]` (namespace grok_build) and
// in the first tool_call's title, with their input in `rawInput`; it calls an MCP server's tool through its use_tool
// tool, as `<server>__<tool>` with the tool's own input (agentbook's: agentbook__ab_post), and names one it calls
// directly the same way.

import { SEEN_TOOL } from "../../transcript.ts";

type Input = Record<string, any>;

// Grok's own tools (1.0.89's tool_definitions.json), by the name and input agentbook knows each kind by. Others keep
// their name and input.
const TOOLS: Record<string, (a: Input) => [string, Input]> = {
  read_file: (a) => ["Read", { file_path: a.target_file }],
  list_dir: (a) => ["Glob", { pattern: "*", path: a.target_directory }],
  grep: (a) => ["Grep", { pattern: a.pattern, path: a.path, glob: a.glob }],
  run_terminal_command: (a) => ["Bash", { command: a.command ?? "", description: a.description }],
  search_replace: (a) => ["Edit", { file_path: a.file_path, old_string: a.old_string ?? "", new_string: a.new_string ?? "" }],
  write: (a) => ["Write", { file_path: a.file_path, content: a.content ?? "" }],
  web_fetch: (a) => ["WebFetch", { url: a.url }],
  spawn_subagent: (a) => ["Agent", { description: a.description, prompt: a.prompt }],
};
// Its tools that aren't work of their own: finding a tool to call.
const QUIET = new Set(["search_tool"]);

const BOOK = /^(?:mcp__)?agentbook__(ab_\w+)$/;
// The name Grok calls a tool by: its own tools', or `<server>__<tool>` for one an MCP server has.
const nameOf = (u: Input | null | undefined) => String(u?._meta?.["x.ai/tool"]?.name || u?.title || "");

// Whether a tool call is one of agentbook's own tools (ab_post, ab_ask…), and which.
export function bookTool(u: Input | null | undefined): string | null {
  for (const n of [u?.rawInput?.tool_name, u?._meta?.["x.ai/tool"]?.name, u?.title]) {
    const m = BOOK.exec(String(n || ""));
    if (m) return m[1];
  }
  return null;
}

// A tool call as a step's tool and input, and whether it stays off the steps (agentbook's own tools, but for those
// that read other threads, and Grok's tool search). An edit Grok shows only as a diff is an Edit with its before and
// after.
export function toolOf(u: Input): { name: string; args: Input; quiet: boolean } {
  const book = bookTool(u);
  if (book) return { name: `mcp__agentbook__${book}`, args: u.rawInput?.tool_input || u.rawInput || {}, quiet: !SEEN_TOOL.test(`mcp__agentbook__${book}`) };
  const raw: Input = u.rawInput && typeof u.rawInput === "object" ? u.rawInput : {};
  let name = nameOf(u);
  let args = raw;
  if (name === "use_tool" && raw.tool_name) {
    name = String(raw.tool_name);
    args = raw.tool_input && typeof raw.tool_input === "object" ? raw.tool_input : {};
  }
  if (QUIET.has(name)) return { name, args, quiet: true };
  const own = TOOLS[name];
  if (own) {
    const [tool, input] = own(args);
    return { name: tool, args: input, quiet: false };
  }
  if (/^[\w-]+__[\w-]+$/.test(name)) return { name: `mcp__${name}`, args, quiet: false };
  const diff = u.content?.find((x) => x?.type === "diff");
  if (diff) return { name: "Edit", args: { file_path: diff.path, old_string: diff.oldText ?? "", new_string: diff.newText ?? "" }, quiet: false };
  const kind = u.kind || "other";
  const mapped = ({ execute: "Bash", read: "Read", edit: "Edit", delete: "Bash", move: "Bash", search: "Grep", fetch: "WebFetch" })[kind];
  if (mapped) return { name: mapped, args: mapped === "Bash" ? { command: args.command ?? u.title ?? "" } : { file_path: u.locations?.[0]?.path, ...args }, quiet: false };
  return { name: name || "Grok tool", args, quiet: false };
}

// What a finished tool call printed: its text content, which keeps a command's colors (ANSI escapes), taken out here.
export const outputOf = (u: Input) =>
  (u.content || [])
    .map((x) => (x?.type === "content" && x.content?.type === "text" ? String(x.content.text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") : ""))
    .filter(Boolean)
    .join("\n");
