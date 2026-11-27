import { useState } from "react";
import { agentMachine, groupAgents } from "../../lib/agent-groups.ts";
import { agentName, inactiveAgent, presence } from "../../lib/agents.ts";
import { agoText, plural } from "../../lib/format.ts";
import { agentHref, machineHref } from "../../lib/route.ts";
import { threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { hideAgent } from "../Visibility.tsx";
import { AddAgentButton } from "./AddAgentDialog.tsx";
import { AgentNow } from "./AgentNow.tsx";
import type { AgentRow } from "./types.ts";
import { KIND_SHORT } from "./words.ts";

export function AgentActivation({ agent: a, concise = false }: { agent: AgentRow; concise?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (a.mine === false) return null;
  const hidden = inactiveAgent(a);
  const label = hidden ? (concise ? "Enable" : "Activate") : (concise ? "Disable" : "Deactivate");
  return (
    <button
      className="btn btn--line btn--sm"
      type="button"
      disabled={busy}
      aria-label={`${label} ${agentName(a.id)}`}
      title={hidden ? "Activate this agent to start new threads and show it in your sidebar and feed." : "Prevent new threads and hide this agent from your sidebar and feed. Existing threads continue."}
      onClick={async () => {
        setBusy(true);
        try {
          await hideAgent(a.id, !hidden, true);
        } catch {
          toast(`Couldn't ${label.toLowerCase()} ${a.name}. Try again.`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}

export function AgentListRow({ agent: a, manage = false }: { agent: AgentRow; manage?: boolean }) {
  const latest = useApp((s) => threadRow(a.latest, s));
  const cloud = agentMachine(a) === null;
  return (
    <li className={manage ? "agent-manage-row" : undefined}>
      <a className="ag-row" href={agentHref(a.id)}>
        <Avatar agent={a.id} size="av--sm" on={presence(a)} />
        <span className="who">
          <b>{cloud ? a.name : agentName(a.id)}</b>
          <small>
            {KIND_SHORT[a.kind] || a.kind}{cloud && a.machine ? ` · via ${a.machine}` : ""} · {plural(a.sessions || 0, a.mine === false ? "public thread" : "thread")}
          </small>
        </span>
        <span className="last">
          {latest ? (
            <><span>{latest.title}</span><time>{agoText(latest.started)}</time></>
          ) : <span className="muted">No threads yet</span>}
        </span>
        <span className="now">
          <AgentNow agent={a} />
          {inactiveAgent(a) && <span className="chip chip--off" title="New threads are blocked. Existing threads continue.">Inactive</span>}
        </span>
      </a>
      {manage && <AgentActivation agent={a} />}
    </li>
  );
}

export function AgentGroups({ agents, manage = false, profile = false, fold, allHref }: { agents: AgentRow[]; manage?: boolean; profile?: boolean; fold?: number; allHref?: string }) {
  const here = useApp((s) => s.data?.machine);
  const machines = useApp((s) => s.data?.machines);
  const owned = (machines || []).filter((m) => m.mine);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <div className="agent-groups">
      {groupAgents(agents, here, profile && manage ? [...owned.map((m) => m.name), null] : []).map((g) => {
        const machine = owned.find((m) => m.name === g.machine);
        const key = g.machine === null ? "cloud" : `machine:${g.machine}`;
        const listId = profile ? `profile-agents-${key}` : undefined;
        const expanded = !profile || !collapsed[key];
        const count = plural(g.agents.length, "agent");
        const shown = fold && allHref ? g.agents.slice(0, fold) : g.agents;
        return (
          <section className="agent-group" key={key} aria-label={g.machine || "Cloud"}>
            <h4 className="agent-group-head">
              <Icon name={g.machine ? "laptop" : "cloud"} />
              {machine ? <a href={machineHref(g.machine)}>{g.machine}</a> : <span>{g.machine || "Cloud"}</span>}
              {profile ? (
                <button type="button" className="agent-group-fold" aria-controls={listId} aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${g.machine || "Cloud"} agents`}
                  onClick={() => setCollapsed((old) => ({ ...old, [key]: !old[key] }))}>
                  {count}<Icon name={expanded ? "down" : "caret"} />
                </button>
              ) : <small>{count}</small>}
              {manage && profile && (machine || !g.machine) && (
                <AddAgentButton className="btn btn--sm" machine={machine?.name} open={machine ? undefined : "cloud"}
                  aria-label={machine ? `Add agent on ${machine.name}` : "Manage cloud connections"}>
                  {machine ? "Add agent" : "Connections"}
                </AddAgentButton>
              )}
            </h4>
            <div id={listId} hidden={!expanded}>
              {shown.length ? (
                <ul className="act-list">
                  {shown.map((a) => <AgentListRow key={a.id} agent={a} manage={manage} />)}
                </ul>
              ) : <p className="list-empty">{g.machine ? "No agents on this machine yet." : "No cloud agents connected."}</p>}
              {shown.length < g.agents.length && <a className="agent-group-all" href={allHref}>Show all {g.agents.length} {g.machine ? `on ${g.machine}` : "in Cloud"}</a>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
