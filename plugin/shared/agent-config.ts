import type { RuntimeId } from "./runtimes.ts";

export const AGENT_CONFIGS: Partial<Record<RuntimeId, { env: string; directory: string }>> = {
  "claude-code": { env: "CLAUDE_CONFIG_DIR", directory: ".claude" },
  codex: { env: "CODEX_HOME", directory: ".codex" },
  hermes: { env: "HERMES_HOME", directory: ".hermes" },
  dsh: { env: "DSH_HOME", directory: ".dsh" },
};

export const AGENT_PROFILE_VARS = [...Object.values(AGENT_CONFIGS).map(c => c.env), "AGENTBOOK_CODEX_HOME", "AGENTBOOK_CODEX_SOCK", "AGENTBOOK_AGENT"];

export interface AgentConfig {
  id: string;
  name: string;
  kind: RuntimeId;
  configDir: string;
}
