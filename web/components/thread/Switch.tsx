// What a running thread runs on, under its reply box on its page: its model, effort and mode, as the composer's chips
// show them for a new thread, with the same menus. A pick takes over from its next turn (Codex's next turn, a Claude
// Code session's next wake), or at once where its runtime switches a live session's mode (Antigravity's, DeepSeek's),
// but for a move into Full access or out of it where that runs apart (caps.fullApart), which waits for a running turn;
// until then its chip says so, with Undo. One open in a terminal shows what it runs and where to switch it.
import { drivenBy, kindCaps, typedIn } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agentOf, useAgent } from "../../lib/store.ts";
import type { Thread } from "../../lib/types.ts";
import { effortsOf } from "../../../plugin/shared/api.ts";
import type { Mode } from "../../../plugin/shared/runtimes.ts";
import { effortName, MODE_ROWS, modelName } from "../bar/compose-state.ts";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import type { MenuRow } from "../MenuPick.tsx";

const capsOf = (s: Thread) => drivenBy(s)?.caps || kindCaps(agentOf(s.agent).kind);

// Whether its model, effort and mode switch from here: a thread its runtime drives (Codex's), or a Claude Code session
// in the background or one that ended, which agentbook wakes or resumes on them, for its owner. One open in
// a terminal (or Claude Desktop) switches there, and one in the cloud on its cloud's page.
export function switchesHere(s: Thread) {
  if (s.cloud || s.rt?.kind === "cloud" || s.mine === false) return false;
  if (drivenBy(s)) return true;
  return !!capsOf(s)?.resumes && !!s.session_id && (s.rt?.kind === "background" || s.effective === "done");
}

// The model it ran on, as its picker names it (Claude Code says "claude-opus-5-5"; its picker has "opus").
export function ranOn(s: Thread, list: { id: string }[]) {
  const family = String(s.model || "").match(/^claude-([a-z]+)-/)?.[1];
  return list.find((x) => x.id === s.model || x.id === family)?.id || "";
}

export const switchTo = (s: Thread, what: "model" | "effort" | "mode", value: string) => post(`/api/sessions/${encodeURIComponent(s.id)}/${what}`, { [what]: value });

// The modes a thread can be switched to: Full access only by its owner (and shown to anyone while it's in it).
export function modesOf(s: Thread): Mode[] {
  const caps = capsOf(s);
  if (!caps?.switchesMode) return [];
  return caps.modes.filter((x) => x !== "full" || s.mine !== false || s.mode === "full");
}

// Whether the mode picked for it waits for its next turn: where its runtime switches modes then, and for a move into
// Full access or out of it where that runs apart (caps.fullApart).
export function modeWaits(s: Thread) {
  const caps = capsOf(s);
  return !!s.mode_pick && (caps?.switchesMode !== "now" || (caps.fullApart && (s.mode_pick === "full") !== (s.mode === "full")));
}

const modeShown = (m: Mode) => (m === "full" ? "Full access · never asks" : MODE_ROWS[m].text);

export function SwitchChips({ s }: { s: Thread }) {
  const models = useAgent(s.agent).models;
  const caps = capsOf(s);
  if (!caps || s.cloud || s.rt?.kind === "cloud" || s.mine === false) return null;
  const here = switchesHere(s);
  const list = (caps.models && (!drivenBy(s) || !!s.rt?.models) && models?.list) || [];
  const ran = ranOn(s, list);
  const modelNow = s.model_pick || ran;
  const { efforts, effort: def } = effortsOf(models, s.model_pick || ran || models?.default);
  const effortNow = s.effort_pick || s.effort || def || "";
  const modes = modesOf(s);
  const modeNow = s.mode_pick || s.mode || null;
  const now = caps.switchesMode === "now";
  const later = { hint: "Takes over from its next turn." };
  const held = modeWaits(s);

  if (!here) {
    // What it runs, as far as agentbook knows, and where it's switched.
    const parts = [s.model && { icon: "chip", text: modelName(s.agent, s.model) }, s.effort && { icon: "gauge", text: effortName(s.effort).toLowerCase() }, s.mode && { icon: "hand", text: modeShown(s.mode) }].filter(Boolean) as { icon: "chip" | "gauge" | "hand"; text: string }[];
    if (!parts.length) return null;
    const where = typedIn(s);
    return (
      <div className="cmt-opts is-static" role="group" aria-label="How it runs">
        {parts.map((p) => (
          <span className="opt opt--static" key={p.icon} title={`It's open in ${where}: switch it there`}>
            <Icon name={p.icon} />
            <span className="opt-v">{p.text}</span>
          </span>
        ))}
        <span className="opts-note">{where === "the terminal" ? "open in a terminal: /model and Shift+Tab there" : `open in ${where}: switch it there`}</span>
      </div>
    );
  }

  const chips = [];
  if (list.length) {
    const rows: MenuRow[] = [...(ran ? [] : [{ value: "", text: s.model ? modelName(s.agent, s.model) : "Its default", on: !s.model_pick }]), ...list.map((x) => ({ value: x.id === ran ? "" : x.id, text: x.name, note: x.id === ran && s.model_pick ? "now" : "", on: x.id === modelNow })), later];
    chips.push(
      <MenuPick
        key="model"
        id={`thread:${s.id}:model`}
        label="Model"
        face={
          <>
            <Icon name="chip" />
            <span className="opt-v">{modelNow ? modelName(s.agent, modelNow) : s.model ? modelName(s.agent, s.model) : "Its default"}</span>
          </>
        }
        rows={rows}
        set={!!s.model_pick}
        onPick={(v) => switchTo(s, "model", v)}
      />,
    );
  }
  if (caps.efforts && efforts.length) {
    const rows: MenuRow[] = [...efforts.map((e) => ({ value: e, text: effortName(e), note: e === (s.effort || def) ? (s.effort_pick ? "now" : s.effort ? "" : "default") : "", on: e === effortNow })), later];
    chips.push(
      <MenuPick
        key="effort"
        id={`thread:${s.id}:effort`}
        label="Effort"
        title="Effort: how hard it thinks before it acts"
        face={
          <>
            <Icon name="gauge" />
            <span className="opt-v">{effortNow ? effortName(effortNow).toLowerCase() : "default effort"}</span>
          </>
        }
        rows={rows}
        set={!!s.effort_pick}
        onPick={(v) => switchTo(s, "effort", v)}
      />,
    );
  }
  if (modes.length) {
    const rows: MenuRow[] = [...modes.map((x) => ({ value: x, text: MODE_ROWS[x].text, note: x === s.mode && s.mode_pick ? `now · ${MODE_ROWS[x].note}` : MODE_ROWS[x].note, on: x === modeNow })), now ? { hint: caps.fullApart ? "Switches now; into Full access or out of it once its turn ends." : "Switches now." } : later];
    chips.push(
      <MenuPick
        key="mode"
        id={`thread:${s.id}:mode`}
        label="Mode"
        title="Mode: how much it does without asking you"
        cls={modeNow === "full" ? "pk--full" : ""}
        face={
          <>
            <Icon name="hand" />
            <span className="opt-v">{modeNow ? modeShown(modeNow) : "Mode"}</span>
          </>
        }
        rows={rows}
        set={!!s.mode_pick}
        onPick={(v) => switchTo(s, "mode", v)}
      />,
    );
  }
  if (!chips.length) return null;
  // A mode picked where it switches at once is on its way, not waiting for a turn.
  const waiting = !!(s.model_pick || s.effort_pick || held);
  const undo = () => {
    if (s.model_pick) switchTo(s, "model", "");
    if (s.effort_pick) switchTo(s, "effort", "");
    if (s.mode_pick) switchTo(s, "mode", "");
  };
  return (
    <div className="cmt-opts launch-opts" role="group" aria-label="How it runs">
      {chips}
      {waiting && (
        <span className="opts-note">
          from its next turn ·{" "}
          <button className="link-btn" type="button" onClick={undo}>
            Undo
          </button>
        </span>
      )}
      {s.mode_pick && !held && <span className="opts-note">switching…</span>}
    </div>
  );
}
