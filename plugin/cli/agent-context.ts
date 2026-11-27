import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_CONFIGS, AGENT_PROFILE_VARS } from "../shared/agent-config.ts";
import type { AgentConfig } from "../shared/agent-config.ts";
import type { RuntimeId } from "../shared/runtimes.ts";

const scope = new AsyncLocalStorage<AgentConfig>();
export const currentAgentConfig = () => scope.getStore();
export const withAgentConfig = <T>(config: AgentConfig | undefined, run: () => T): T => scope.run(config, run);
export function bindAgentCallback<T extends (...args: any[]) => any>(callback: T): T {
  const config = currentAgentConfig();
  return ((...args: Parameters<T>) => withAgentConfig(config, () => callback(...args))) as T;
}

export function defaultAgentDirectory(kind: RuntimeId) {
  const spec = AGENT_CONFIGS[kind];
  if (!spec) return null;
  return path.resolve((kind === "codex" && process.env.AGENTBOOK_CODEX_HOME) || process.env[spec.env] || path.join(os.homedir(), spec.directory));
}
export function isDefaultAgentConfig(kind: RuntimeId, directory: string) {
  try { return canonicalAgentDirectory(directory) === canonicalAgentDirectory(defaultAgentDirectory(kind)); }
  catch { return path.resolve(directory) === defaultAgentDirectory(kind); }
}
export function agentDirectory(kind: RuntimeId) {
  const config = currentAgentConfig();
  return config?.kind === kind ? config.configDir : defaultAgentDirectory(kind);
}
export function agentEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const config = currentAgentConfig();
  if (!config) return { ...base };
  const original = base.AGENTBOOK_PROFILE_BASE || JSON.stringify(Object.fromEntries(AGENT_PROFILE_VARS.map(key => [key, base[key] ?? null])));
  const env = { ...base, AGENTBOOK_PROFILE_BASE: original, [AGENT_CONFIGS[config.kind].env]: config.configDir, AGENTBOOK_AGENT_ID: config.id, AGENTBOOK_AGENT: config.name };
  if (config.kind === "codex") { env.AGENTBOOK_CODEX_HOME = config.configDir; delete env.AGENTBOOK_CODEX_SOCK; }
  return env;
}
export function agentDataHome(base: string) {
  const config = currentAgentConfig();
  return config ? path.join(base, "agents", config.id) : base;
}

// Each adapter's methods and asynchronous work enter the same scope; process.env is never mutated.
export function bindAgentConfig<T extends object>(config: AgentConfig, object: T): T {
  const cache = new WeakMap<object, object>();
  const wrap = (value: object): object => {
    if (cache.has(value)) return cache.get(value);
    const proxy = new Proxy(value, { get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member === "function") return (...args: unknown[]) => withAgentConfig(config, () => member.apply(target, args));
      if (member && typeof member === "object" && Object.getPrototypeOf(member) === Object.prototype) return wrap(member);
      return member;
    } });
    cache.set(value, proxy);
    return proxy;
  };
  return wrap(object) as T;
}

// Resolve an existing ancestor first so symlink aliases also collide when the final directory is new.
export function canonicalAgentDirectory(value: string) {
  const entered = value.trim();
  if (!entered || /[\x00-\x1f]/.test(entered) || !(path.isAbsolute(entered) || entered === "~" || entered.startsWith("~/"))) throw Object.assign(new Error("Use an absolute path or a path starting with ~/."), { status: 400 });
  let parent = path.resolve(entered === "~" ? os.homedir() : entered.replace(/^~\//, os.homedir() + "/"));
  const rest: string[] = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    rest.unshift(path.basename(parent)); parent = next;
  }
  if (!fs.statSync(parent).isDirectory()) throw Object.assign(new Error("The config path must be a directory."), { status: 400 });
  return path.join(fs.realpathSync(parent), ...rest);
}
