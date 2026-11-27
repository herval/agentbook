// What People, an agent's profile and a person's profile say of agents and people in words: an agent's kind, whose
// agents are whose, and how long ago. Ported from the old page's (app.ts) as they were.
import { ago } from "../../lib/format.ts";
import { getApp } from "../../lib/store.ts";
import { RUNTIMES } from "../../../plugin/shared/runtimes.ts";
import type { AgentRow, AppState } from "./types.ts";

// Each kind of agent, as its runtime says (shared/runtimes.ts): what it is ("Coding agent in Codex"), and in short
// ("Codex"). Only runtimes that are an agent's kind, not the clouds its threads may run in.
const AGENT_RUNTIMES = Object.values(RUNTIMES).filter((r) => r.about);
export const KINDS: Record<string, string> = Object.fromEntries(AGENT_RUNTIMES.map((r) => [r.id, r.about]));
export const KIND_SHORT: Record<string, string> = Object.fromEntries(AGENT_RUNTIMES.map((r) => [r.id, r.name]));
// Your agent's avatar back to its runtime's own, for a runtime that gives its agents pictures (`avatars`): "Use
// OpenClaw's".
export const AVATAR_FROM: Record<string, string> = Object.fromEntries(AGENT_RUNTIMES.filter((r) => r.caps.avatars).map((r) => [r.id, r.name]));

export const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

// Idle counts its threads asleep or ended too, as their chips and the Idle filter do.
export const idleOf = (a: AgentRow) => (a.idle || 0) + (a.done || 0);

// A person's agents, threads and pages: yours, or the ones someone else made public. (Components pass what they
// read of the store, `s`, so they draw again when it changes.)
type Has = Pick<AppState, "me" | "data">;
export const isMe = (username: string | null | undefined, s: Has = getApp()) => username === s.me?.username;
export const agentsOf = (username: string, s: Has = getApp()): AgentRow[] => (s.data?.agents || []).filter((a) => (isMe(username, s) ? a.mine !== false : a.mine === false && a.owner === username));
export const machinesOf = (agents: AgentRow[]) => [...new Set(agents.map((a) => a.machine).filter(Boolean))];
export const busyFirst = (x: AgentRow, y: AgentRow) => Number(!!x.offline) - Number(!!y.offline) || (y.working || 0) - (x.working || 0) || (y.needs || 0) - (x.needs || 0);
