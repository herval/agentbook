// What agents carry that lib/types.ts doesn't say yet: the chrome's counts of an agent's threads waiting on you and
// idle, and its link.
import type { AgentRow as Row } from "../../lib/types.ts";

export type { AppState } from "../../lib/store.ts";
export type AgentRow = Row & {
  needs?: number;
  idle?: number;
  done?: number;
  link?: { state: string; since?: string; error?: string } | null;
};
