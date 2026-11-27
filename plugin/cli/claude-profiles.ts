import { createClaude } from "./drivers/claude.ts";
import { bindAgentConfig, currentAgentConfig, isDefaultAgentConfig } from "./agent-context.ts";
import type { AgentConfig } from "../shared/agent-config.ts";
import type { State } from "../shared/types.ts";

export function createClaudeProfiles({ state, log }: { state: State; log: (line: string) => void }) {
  const base = createClaude({ log });
  const drivers = new Map<string, ReturnType<typeof createClaude>>();
  // isDefaultAgentConfig resolves both folders on disk, and choose() runs on every call to the driver: many a second,
  // as the machine's info reads each thread's background work. A folder's answer is kept a minute.
  const defaults = new Map<string, { at: number; yes: boolean }>();
  const isDefault = (dir: string) => {
    const kept = defaults.get(dir);
    if (kept && Date.now() - kept.at < 60e3) return kept.yes;
    const yes = isDefaultAgentConfig("claude-code", dir);
    defaults.set(dir, { at: Date.now(), yes });
    return yes;
  };
  const configs = () => Object.values(state.agents).filter(a => a.kind === "claude-code" && a.config_dir && !isDefault(a.config_dir));
  const sync = () => {
    for (const a of configs()) if (!drivers.has(a.id)) {
      const config: AgentConfig = { id: a.id, name: a.name, kind: "claude-code", configDir: a.config_dir };
      drivers.set(a.id, bindAgentConfig(config, createClaude({ log })));
    }
  };
  const all = () => { sync(); return [base, ...drivers.values()]; };
  const choose = (arg?: any) => {
    sync();
    const scoped = currentAgentConfig();
    if (scoped?.kind === "claude-code" && drivers.has(scoped.id)) return drivers.get(scoped.id);
    if (arg?.agent) return drivers.get(arg.agent) || base;
    const id = typeof arg === "string" ? arg : arg?.sessionId;
    const s = id && (state.sessions[id] || Object.values(state.sessions).find(s => s.session_id === id));
    if (s) return drivers.get(s.agent) || base;
    return [...drivers.values()].find(d => d.info(id)) || base;
  };
  return new Proxy(base, { get(_target, key) {
    if (key === "refresh") return async () => (await Promise.all(all().map(d => d.refresh()))).some(Boolean);
    if (key === "listedAt" || key === "listAsked") return (id?: string) => choose(id)[key]();
    // One `claude` for every profile: its version, and its update.
    if (key === "version" || key === "running" || key === "update") return base[key];
    if (key === "startedWith") return (arg) => choose(arg).startedWith(arg);
    if (key === "failure") return (id: string) => all().map(d => d.failure(id)).find(Boolean) || null;
    return (...args: any[]) => { const driver = choose(args[0]); return driver[key](...args); };
  } });
}
