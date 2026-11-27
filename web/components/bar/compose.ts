// What the composer has picked (app.ts S.agentPick, S.wsPick, S.pagePick, S.modelPick, S.effortPick, S.branchPick,
// S.visPick, S.taskPicks), shared by the composer and the filter bar that narrows it.
import { create } from "zustand";

// The composer starts with what you last posted with, in this browser: the agent, the workspace, each agent's
// model, effort, mode and who sees its posts, and each folder's branch. A pick that no
// longer fits (an agent gone, a branch deleted, a mode its agent doesn't offer) falls back to the
// default, as the composer reads it.
const COMPOSE_KEY = "agentbook.compose";
// Only an explicit mode pick writes this key. A tab saving its workspace or agent can't overwrite another tab's mode.
const MODE_PREFIX = COMPOSE_KEY + ".mode.";
const COMPOSE_PICKS = { agentPick: "string", wsPick: "string", modelPick: "object", effortPick: "object", modePick: "object", branchPick: "object", visPick: "object" } as const;

export interface ComposePicks {
  // The workspace picked in the composer, or "" for none; null: not picked yet.
  wsPick: string | null;
  // The agent picked in the feed's composer ("~you": a thread of yours).
  agentPick: string | null;
  // A task's, a worktree's or a routine's own composer, on its page: its key ("<task>", "wip:<id>", "routine:<key>")
  // -> { agent, ws } picked there.
  taskPicks: Record<string, { agent?: string; ws?: string | null }>;
  // Where the composer's thread goes: "" your feed, a page's id, or a group's as "group:<id>".
  pagePick: string;
  // The model picked, per agent ("" for its default).
  modelPick: Record<string, string>;
  // Who can see a new post, per agent, when it isn't the agent's own setting.
  visPick: Record<string, string>;
  // The effort picked, per agent ("" for its model's default).
  effortPick: Record<string, string>;
  // The mode picked, per agent ("" for Auto), Full access included.
  modePick: Record<string, string>;
  // The branch picked, per folder: its menu's value ("" for the folder's branch).
  branchPick: Record<string, string>;
}

// What this browser kept, as the old page kept it.
function loadCompose(): Partial<ComposePicks> {
  try {
    const saved = (JSON.parse(localStorage.getItem(COMPOSE_KEY) || "null") || {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, type] of Object.entries(COMPOSE_PICKS)) if (saved[k] != null && typeof saved[k] === type) out[k] = saved[k];
    return out as Partial<ComposePicks>;
  } catch {
    return {};
  }
}
function savedModes(legacy: ComposePicks["modePick"] = {}) {
  const modes = { ...legacy };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(MODE_PREFIX)) modes[key.slice(MODE_PREFIX.length)] = localStorage.getItem(key) ?? "";
    }
  } catch {}
  return modes;
}
function saveCompose(s: ComposePicks) {
  try {
    localStorage.setItem(COMPOSE_KEY, JSON.stringify(Object.fromEntries(Object.keys(COMPOSE_PICKS).map((k) => [k, s[k as keyof ComposePicks]]))));
  } catch {}
}

export const useCompose = create<ComposePicks>(() => {
  const saved = loadCompose();
  return { wsPick: null, agentPick: null, taskPicks: {}, pagePick: "", modelPick: {}, visPick: {}, effortPick: {}, branchPick: {}, ...saved, modePick: savedModes(saved.modePick) };
});
export const getCompose = useCompose.getState;
// Pick something, and keep what's kept.
export function setCompose(p: Partial<ComposePicks> | ((s: ComposePicks) => Partial<ComposePicks>)) {
  useCompose.setState(p);
  saveCompose(useCompose.getState());
}
export function setComposeMode(agent: string, mode: string) {
  try {
    localStorage.setItem(MODE_PREFIX + agent, mode);
  } catch {}
  setCompose((s) => ({ modePick: { ...s.modePick, [agent]: mode } }));
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea === localStorage && (event.key === null || event.key?.startsWith(MODE_PREFIX))) {
      useCompose.setState({ modePick: savedModes(loadCompose().modePick) });
    }
  });
}
