import { appName, archivedNow, drivenBy, runtimeOfRow } from "../lib/agents.ts";
import type { Thread } from "../lib/types.ts";

export function StatusChip({ thread: s }: { thread: Thread }) {
  if (s.offline && s.effective !== "done")
    return (
      <span className="chip chip--off" title={`${s.machine || "Its machine"} is off: what it's doing now shows once it's back`}>
        Off
      </span>
    );
  if (s.effective === "working")
    return (
      <span className="chip chip--live">
        <i className="pulse" />
        Live
      </span>
    );
  if (s.effective === "needs") return <span className="chip chip--sun">Needs you</span>;
  if (s.effective === "waiting") return <span className="chip">Waiting</span>;
  if (archivedNow(s))
    return (
      <span className="chip" title="Archived: writing to it picks it back up">
        Archived
      </span>
    );
  // One that's asleep or ended is idle too: writing to it wakes it, or picks it back up.
  if (s.effective === "done")
    return (
      <span className="chip" title={s.asleep ? `${s.sleep_reason ? `${s.sleep_reason}, so its process stopped` : "Its process stopped"}. Its conversation is kept: writing to it wakes it.` : undefined}>
        Idle
      </span>
    );
  return <span className="chip">Idle</span>;
}

// Where a session runs, when it isn't obvious: in the background (no terminal), or in a terminal that
// gets what you send only between turns.
export function WhereChip({ thread: s }: { thread: Thread }) {
  // The first time agentbook reads it, its conversation and steps are still being copied over.
  if (s.rt?.syncing)
    return (
      <span className="chip chip--sync" title={`Copying its conversation and steps from ${s.rt.name}`}>
        <i className="pulse" />
        Syncing
      </span>
    );
  if (s.effective === "done" || s.offline) return null;
  const rt = s.rt;
  if (rt?.kind === "cloud")
    return (
      <span className="chip" title={runtimeOfRow(s).placeWords?.chip}>
        Cloud
      </span>
    );
  if (rt?.kind === "background")
    return (
      <span className="chip" title="Runs in the background, with no terminal of its own">
        Background
      </span>
    );
  if (rt?.remote)
    return (
      <span className="chip" title={`Runs in ${rt.name}'s cloud, not on your machines`}>
        Cloud
      </span>
    );
  if (drivenBy(s) || s.channel) return null;
  if (appName(s))
    return (
      <span className="chip" title={`Runs in ${s.app === "desktop" ? "Claude Desktop" : appName(s)}: what you send reaches it when its turn ends`}>
        In {appName(s)}
      </span>
    );
  return (
    <span className="chip" title="Runs in a terminal without agentbook's channel: what you send reaches it when its turn ends">
      In a terminal
    </span>
  );
}
