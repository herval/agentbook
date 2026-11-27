// Naming one of your agents. The name is the page's (server/api/agents.ts), kept when its runtime says another, so
// an OpenClaw gateway's or Claude Code's own name doesn't undo it.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { post } from "../../lib/api.ts";
import { agentName } from "../../lib/agents.ts";
import { agentHref } from "../../lib/route.ts";
import { setApp } from "../../lib/store.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import type { AgentRow } from "./types.ts";

export async function renameAgent(id: string, name: string) {
  const r = await post<{ name?: string }>(`/api/agents/${encodeURIComponent(id)}/name`, { name });
  const named = r.ok && r.data.name;
  if (named) setApp((s) => (s.data?.agents ? { data: { ...s.data, agents: s.data.agents.map((a) => (a.id === id ? { ...a, name: named, glyph: named[0].toUpperCase() } : a)) } } : {}));
  return r;
}

// The box, where the name was: Enter or ✓ saves, Esc or × leaves it as it was. `big`: the agent page's heading.
export function AgentNameForm({ agent: a, done, big = false }: { agent: AgentRow; done: () => void; big?: boolean }) {
  const [name, setName] = useState(a.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (!next) return setError("Give this agent a name.");
    if (next === a.name) return done();
    setBusy(true);
    setError("");
    try {
      const r = await renameAgent(a.id, next);
      if (r.ok) return done();
      setError(r.data?.error || "Couldn't rename this agent. Try again.");
    } catch (err) {
      setError(err.message || "Couldn't reach agentbook. Try again.");
    }
    setBusy(false);
  };
  return (
    <form
      className={`ag-rename${big ? " ag-rename--h" : ""}`}
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        done();
      }}
    >
      <span className="ag-rename-row">
        <input ref={input} autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label={`Name for ${agentName(a.id)}`} autoComplete="off" spellCheck={false} required disabled={busy} />
        <button className="icon-btn" type="submit" aria-label="Save the name" title="Save" disabled={busy}>
          <Icon name="check" />
        </button>
        <button className="icon-btn" type="button" aria-label="Keep the old name" title="Cancel" onClick={done}>
          <Icon name="x" />
        </button>
      </span>
      {error && <small className="auth-err" role="alert">{error}</small>}
    </form>
  );
}

// The agent page's heading: its name and machine; on yours, clicking the name renames it.
export function AgentHeading({ agent: a, mine }: { agent: AgentRow; mine: boolean }) {
  const [editing, setEditing] = useState(false);
  if (!mine) return <h1>{agentName(a.id)}</h1>;
  if (editing) return <AgentNameForm agent={a} big done={() => setEditing(false)} />;
  return (
    <h1>
      <button className="ag-name" type="button" title="Rename it" onClick={() => setEditing(true)}>
        {agentName(a.id)}
        <Icon name="pencil" />
      </button>
    </h1>
  );
}

// A row of your Agents tab: its face and name, opening its page, and a pencil that renames it in place.
export function AgentNameCell({ agent: a }: { agent: AgentRow }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <span className="machine-agent-name is-editing">
        <Avatar agent={a.id} size="av--sm" />
        <AgentNameForm agent={a} done={() => setEditing(false)} />
      </span>
    );
  return (
    <span className="machine-agent-line">
      <a className="machine-agent-name" href={agentHref(a.id)}>
        <Avatar agent={a.id} size="av--sm" />
        <b>{a.name}</b>
      </a>
      <button className="icon-btn ag-rename-btn" type="button" aria-label={`Rename ${a.name}`} title="Rename it" onClick={() => setEditing(true)}>
        <Icon name="pencil" />
      </button>
    </span>
  );
}
