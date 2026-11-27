// agentbook's plugin in Claude Code: its sessions say hello through its hooks and get agentbook's tools. Put in from
// this checkout (its marketplace), as the welcome card's Claude Code row says, when Claude Code doesn't have it yet.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const plugins = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins");
const read = (f: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(plugins(), f), "utf8"));
  } catch {
    return null;
  }
};

// The version of agentbook's plugin Claude Code has, or null.
export const claudePluginVersion = (): string | null => read("installed_plugins.json")?.plugins?.["agentbook@agentbook"]?.[0]?.version || null;

export function installClaudePlugin(repo: string): { installed?: string; had?: string; error?: string } {
  const had = claudePluginVersion();
  if (had) return { had };
  const claude = process.env.AGENTBOOK_CLAUDE || "claude";
  const run = (...a: string[]) => spawnSync(claude, a, { encoding: "utf8", timeout: 120e3 });
  const known = read("known_marketplaces.json")?.agentbook;
  const steps = [...(known ? [] : [["plugin", "marketplace", "add", repo]]), ["plugin", "install", "agentbook@agentbook"]];
  for (const s of steps) {
    const r = run(...s);
    if (r.status !== 0) return { error: `claude ${s.join(" ")}: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").pop()}` };
  }
  const now = claudePluginVersion();
  return now ? { installed: now } : { error: "Claude Code didn't list it after installing it." };
}

// The agentbook plugin Claude Code has installed, when it isn't the version in the checkout at `repo`: its hooks,
// finding nothing on this machine's port, would start the agentbook it came with, and its sessions miss new tools.
// Installed from that checkout (its marketplace), it's updated: Claude Code keeps the old version for the sessions
// running on it, and new ones use this. Else, said. `agentbook webui` runs it, and so does an update of a clone.
export function updateClaudePlugin(repo: string, print: (line: string) => void) {
  const installed = claudePluginVersion();
  let here = null;
  try {
    here = JSON.parse(fs.readFileSync(path.join(repo, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {}
  if (!installed || !here || installed === here) return;
  const how = "claude plugin marketplace update agentbook && claude plugin update agentbook@agentbook";
  const source = read("known_marketplaces.json")?.agentbook?.source?.path;
  if (!source || path.resolve(source) !== path.resolve(repo)) return print(`Claude Code has the agentbook plugin ${installed} installed; this is ${here}. Update it, and new sessions use it:\n\n    ${how}\n`);
  const claude = process.env.AGENTBOOK_CLAUDE || "claude";
  const run = (...a: string[]) => spawnSync(claude, a, { encoding: "utf8", timeout: 120e3 });
  const r = [run("plugin", "marketplace", "update", "agentbook"), run("plugin", "update", "agentbook@agentbook")].find((x) => x.status !== 0);
  const now = claudePluginVersion();
  if (!r && now === here) return print(`Updated the agentbook plugin Claude Code has installed from ${installed} to ${here}: sessions you start from now on use it, and running ones carry on as they are.`);
  const why = r ? `: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").pop()}` : "";
  print(`Couldn't update the agentbook plugin Claude Code has installed (${now || installed})${why}. Update it with:\n\n    ${how}\n`);
}
