import { currentAgentConfig } from "../../agent-context.ts";
// agentbook's tools (ab_post, ab_ask…) for Codex's threads: for the ones agentbook starts or loads, as an MCP server
// it hands each when it loads it, and for every other Codex thread, wherever it was started (the Codex app, the codex
// CLI), as an entry in Codex's own config.

import type { Mode } from "../../../shared/runtimes.ts";
import fs from "node:fs";
import { removeCodexEntry } from "../../uninstall.ts";
import type { RuntimeContext } from "../runtime.ts";
import type { CodexConfigRead } from "./items.ts";

// A file that holds a key, this person's alone: one others here can read (its group or everyone) is made so, as
// Codex's own logins are. -> { ok: true, made } once it is (or when it isn't there), else { ok: false, why }.
export function keptPrivate(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: true, made: false };
  }
  if (!(st.mode & 0o077)) return { ok: true, made: false };
  if (st.uid !== process.getuid?.()) return { ok: false, why: `${file} is someone else's, and others here can read it` };
  try {
    fs.chmodSync(file, st.mode & 0o700);
    return { ok: true, made: true };
  } catch (e) {
    return { ok: false, why: `${file} can't be made this person's alone (${e.code || e.message})` };
  }
}

// agentbook's MCP server for a thread, so it can write to its post. Codex attaches a thread's MCP servers
// when it loads the thread, and keeps them only while it's loaded: `thread/start`, and `thread/resume` of
// a thread that isn't loaded, take them; a loaded thread ignores them. Its tools need no approval.
export const equip = (ctx: RuntimeContext, proc: string, cwd: string): { config: Record<string, unknown> } => ({ config: { "mcp_servers.agentbook": { ...ctx.mcp(proc, cwd), default_tools_approval_mode: "approve" } } });

// A thread's mode (runtimes.ts's Mode) as Codex's settings, for thread/start, /fork and /resume: when it asks
// (approvalPolicy), who answers (its auto review, in Auto; the person, in Ask) and what its sandbox lets it touch.
// Plan reads and never writes; a thread with no mode keeps Codex's own config.
export function modeSettings(mode?: Mode | null): Record<string, unknown> {
  if (mode === "ask") return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" };
  if (mode === "auto") return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
  if (mode === "plan") return { approvalPolicy: "never", sandbox: "read-only" };
  if (mode === "full") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return {};
}
// The same as a turn takes it (turn/start), which keeps it for the thread's later turns: its sandbox spelled out, with
// the folders it may write besides its own (`roots`).
export function turnModeSettings(mode: Mode, roots: string[] = []): Record<string, unknown> {
  const { approvalPolicy, approvalsReviewer } = modeSettings(mode);
  const sandboxPolicy = mode === "plan" ? { type: "readOnly", networkAccess: false } : mode === "full" ? { type: "dangerFullAccess" } : { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { approvalPolicy, ...(approvalsReviewer ? { approvalsReviewer } : {}), sandboxPolicy };
}

// And every other Codex thread, wherever it was started (the Codex app, the codex CLI), as Claude Code sessions
// get them from agentbook's plugin: an entry in Codex's own config (its config.toml, written through its daemon),
// whose calls say which thread made them (mcp.ts), and whose instructions say what Visual mode is. Codex's
// reload hands it to the threads already loaded too; a thread agentbook starts or loads still gets its own,
// above. An entry someone turned off stays off, and one that points at another agentbook that answers (a second
// agentbook-cli here) is left alone; one that doesn't answer is stale, and replaced. AGENTBOOK_CODEX_MCP=0
// leaves Codex's config as it is, and so does a person who didn't agree to this at login (ctx.codexTools).
const answers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
// With its server elsewhere, that entry's address has a key of its own (key=), local_key on or not: good for
// agentbook's tools as any Codex thread, as Codex says which thread a call comes from and nothing proves it. So it
// stays in a config.toml this person alone can read (keptPrivate, each time this connects: Codex makes a new one so,
// but keeps the mode of one the person has), or it's taken out again, and the log says why.
const keyedUrl = (u) => {
  try {
    return new URL(u).searchParams.has("key");
  } catch {
    return false;
  }
};
// The file Codex says the entry is in (config/read's origins, or its layers), else the person's own config.toml it
// would go in: only that one is looked at, and none when Codex doesn't say.
const entryFile = (read: CodexConfigRead) => {
  const o = read?.origins?.["mcp_servers.agentbook.url"]?.name;
  if (o?.type === "user" && o.file) return o.file;
  const user = (read?.layers || []).filter((l) => l?.name?.type === "user" && l.name.file);
  return (user.find((l) => l.config?.mcp_servers?.agentbook) || user.find((l) => !l.name.profile))?.name.file || null;
};

export async function offerTools(ctx: RuntimeContext, call: (method: string, params: unknown) => Promise<unknown>) {
  const log = (line: string) => ctx.log(line);
  // -> true when the entry isn't to be there: a file others can read, and that can't be made this person's alone.
  async function unshared(file, there = true) {
    if (!file) return false;
    const p = keptPrivate(file);
    if (p.made) log(`codex: made ${file} readable by this person alone, as agentbook's entry in it holds a key`);
    if (p.ok) return false;
    if (there) {
      removeCodexEntry(file);
      await call("config/mcpServer/reload", null).catch(() => {});
    }
    log(`codex: ${there ? "took agentbook's tools out of" : "didn't put agentbook's tools in"} Codex's settings, as their address holds a key and ${p.why}. Make it yours alone (chmod 600), then agentbook-cli down and up.`);
    return true;
  }
  if (process.env.AGENTBOOK_CODEX_MCP === "0" || !ctx.mcpForAll || ctx.codexTools?.() === false) return;
  const want = ctx.mcpForAll(currentAgentConfig()?.id || "codex");
  const read = (await call("config/read", { includeLayers: true })) as CodexConfigRead;
  const have = read?.config?.mcp_servers?.agentbook;
  if (have?.url === want.url && keyedUrl(want.url) && (await unshared(entryFile(read)))) return;
  if (have?.enabled === false || have?.url === want.url) return;
  // Without what comes after the path: a key can be there, for the log and for telling this agentbook-cli's from another's.
  const bare = (u) => String(u).split("?")[0];
  if (have?.url && bare(have.url) !== bare(want.url) && (await answers(have.url))) return log(`codex: its threads' agentbook tools are ${bare(have.url)}'s, which answers: leaving them`);
  if (keyedUrl(want.url) && (await unshared(entryFile(read), false))) return;
  const wrote = (await call("config/value/write", { keyPath: "mcp_servers.agentbook", mergeStrategy: "replace", value: { ...want, default_tools_approval_mode: "approve" } })) as { filePath?: string };
  if (keyedUrl(want.url) && (await unshared(wrote?.filePath))) return;
  await call("config/mcpServer/reload", null);
  log(`codex: every Codex thread gets agentbook's tools now (${bare(want.url)})`);
}
