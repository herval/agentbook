import type { AgentOp } from "../ops.ts";
import type { Iso, State } from "../types.ts";

export function applyAgent(state: State, op: AgentOp, now: Iso): void {
  switch (op.t) {
    case "agent.hello": {
      // An agent a driver lists (OpenClaw's), with a profile before it has any sessions. Its name follows the agent's,
      // and `host` is the machine it runs on when that isn't this one (OpenClaw's gateway's, "gpu"). `version` is
      // its runtime's on this machine (Claude Code's, Codex's), said again when it changes.
      const a = state.agents[op.agent];
      if (!a) state.agents[op.agent] = { id: op.agent, name: op.agent_name || op.agent, kind: op.kind, glyph: (op.agent_name || op.agent)[0].toUpperCase(), ...(op.host ? { host: op.host } : {}), ...(op.version ? { version: op.version } : {}), created: now };
      else {
        if (op.agent_name && a.name !== op.agent_name && !a.named) Object.assign(a, { name: op.agent_name, glyph: op.agent_name[0].toUpperCase() });
        if (op.host) a.host = op.host;
        if (op.version) a.version = op.version;
      }
      if (op.config_dir) state.agents[op.agent].config_dir = op.config_dir;
      break;
    }
    case "agent.profile": {
      const a = state.agents[op.agent];
      if (a) {
        if (typeof op.bio === "string") a.bio = op.bio;
        if (op.avatar !== undefined) a.avatar = op.avatar;
      }
      break;
    }
    case "agent.avatar": {
      // The avatar you set for an agent (null: back to its own), or with `default`, the one its runtime gives it.
      const a = state.agents[op.agent];
      if (a) a[op.default ? "avatar_default" : "avatar"] = op.avatar || null;
      break;
    }
    case "agent.rename": {
      const a = state.agents[op.agent];
      const name = op.name?.trim();
      if (a && name) Object.assign(a, { name, glyph: name[0].toUpperCase(), named: true });
      break;
    }
    case "agent.visibility": {
      // Private (only its owner) or public (its owner's contacts). Its posts follow it unless set themselves.
      const a = state.agents[op.agent];
      if (a && ["private", "public"].includes(op.visibility)) a.visibility = op.visibility;
      break;
    }
    case "agent.hidden": {
      // Deactivated, or active again. Existing threads stay available.
      const a = state.agents[op.agent];
      if (a) a.hidden = !!op.hidden;
      break;
    }
    case "agent.remove": {
      // An agent gone for good: its threads, their processes and starts, and who follows it go with it. Only one of
      // a runtime agentbook dropped whose threads never did anything is removed (cli/daemon.ts's retire), so
      // nothing else names them.
      if (!state.agents[op.agent]) break;
      const gone = new Set(Object.keys(state.sessions).filter((id) => state.sessions[id].agent === op.agent));
      for (const id of gone) delete state.sessions[id];
      for (const [proc, key] of Object.entries(state.procs)) if (gone.has(key)) delete state.procs[proc];
      for (const [lid, l] of Object.entries(state.launches)) if (l.agent === op.agent || gone.has(l.post)) delete state.launches[lid];
      for (const key of Object.keys(state.agent_follows)) if (key.startsWith(`${op.agent}|`)) delete state.agent_follows[key];
      delete state.agents[op.agent];
      break;
    }
    case "agent.visual": {
      // Visual mode had a switch per agent; it's on for every agent now, so an old switch's op
      // only clears what it left.
      const a = state.agents[op.agent];
      if (a) delete a.visual;
      break;
    }
  }
}
