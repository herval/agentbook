// What an agent, or all of a person's agents, have going, in chips: threads running, needing you and idle; offline (and
// why) or connecting.
import { connecting, offlineWhy } from "../../lib/agents.ts";
import { clock, plural } from "../../lib/format.ts";
import { useApp } from "../../lib/store.ts";
import type { AgentRow } from "./types.ts";
import { agentsOf, idleOf, isMe, KIND_SHORT, KINDS } from "./words.ts";

function Counts({ working, needs, idle }: { working: number; needs: number; idle: number }) {
  if (!working && !needs && !idle) return <span className="chip">Nothing running</span>;
  return (
    <>
      {!!working && (
        <span className="chip chip--live">
          <i className="pulse" />
          {plural(working, "thread")} running
        </span>
      )}
      {!!needs && (
        <span className="chip chip--sun">
          {needs} need{needs === 1 ? "s" : ""} you
        </span>
      )}
      {!!idle && <span className="chip">{idle} idle</span>}
    </>
  );
}

// An agent's: offline (since when, and why in its title), connecting, or what its threads are doing.
export function AgentNow({ agent: a }: { agent: AgentRow }) {
  if (a.offline)
    return (
      <span className={`chip${connecting(a) ? "" : " chip--off"}`} title={offlineWhy(a)}>
        {connecting(a) ? "Connecting" : `Offline${a.link?.since ? ` since ${clock(a.link.since)}` : ""}`}
      </span>
    );
  return <Counts working={a.working || 0} needs={a.needs || 0} idle={idleOf(a)} />;
}

// What a person's agents have going, added up, as an agent's profile says it. Only yours need you.
export function PersonNow({ username }: { username: string }) {
  const data = useApp((s) => s.data);
  const me = useApp((s) => s.me);
  const on = agentsOf(username, { data, me }).filter((a) => !a.offline);
  const mine = isMe(username, { data, me });
  const sum = (k: "working" | "needs" | "idle" | "done") => on.reduce((n, a) => n + (a[k] || 0), 0);
  return <Counts working={sum("working")} needs={mine ? sum("needs") : 0} idle={sum("idle") + sum("done")} />;
}

export function AgentKind({ agent: a, version = false }: { agent: AgentRow; version?: boolean }) {
  return (
    <>
      {KINDS[a.kind] || a.kind}
      {version && a.version && (
        <>
          {" "}
          <span className="kind-ver" title={`The version of ${KIND_SHORT[a.kind] || a.kind} on ${a.machine || "its machine"}`}>
            {a.version}
          </span>
        </>
      )}
      {a.offline ? ", offline" : ""}
    </>
  );
}
