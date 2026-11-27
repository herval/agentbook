import { isRuntimeId, RUNTIMES } from "../../plugin/shared/runtimes.ts";
import type { AgentRow } from "./types.ts";

export function isCloudRuntime(kind: unknown): boolean {
  return isRuntimeId(kind) && RUNTIMES[kind].caps.where === "repo" && !RUNTIMES[kind].caps.localFiles;
}

// A cloud agent's machine holds credentials. Its threads run in the vendor's cloud.
export function agentMachine(a: AgentRow): string | null {
  const kind = isRuntimeId(a.runtime) ? a.runtime : a.kind;
  return isCloudRuntime(kind) ? null : a.machine || null;
}

export function groupAgents(agents: AgentRow[], here?: string | null, machines: (string | null)[] = []): { machine: string | null; agents: AgentRow[] }[] {
  const groups = new Map<string | null, AgentRow[]>();
  for (const machine of machines) groups.set(machine, []);
  for (const a of agents) {
    const machine = agentMachine(a);
    if (!groups.has(machine)) groups.set(machine, []);
    groups.get(machine).push(a);
  }
  return [...groups]
    .map(([machine, agents]) => ({ machine, agents }))
    .sort((a, b) => Number(a.machine === null) - Number(b.machine === null) || Number(b.machine === here) - Number(a.machine === here) || (a.machine || "").localeCompare(b.machine || ""));
}
