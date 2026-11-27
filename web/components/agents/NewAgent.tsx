import { useEffect, useState } from "react";
import { AGENT_CONFIGS } from "../../../plugin/shared/agent-config.ts";
import { isRuntimeId } from "../../../plugin/shared/runtimes.ts";
import { getJSON, post } from "../../lib/api.ts";
import { useApp } from "../../lib/store.ts";
import { machineHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import type { AgentRow, Runtimes, RuntimeRow } from "../../lib/types.ts";
import { isCloudRuntime } from "../../lib/agent-groups.ts";
import { SetupAgents } from "../machines/Setup.tsx";
import { renameAgent } from "./AgentName.tsx";

function CreateAgentForm({ runtime, machine, done }: { runtime: RuntimeRow; machine: string; done: () => void }) {
  const [name, setName] = useState(runtime.name);
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const config = isRuntimeId(runtime.kind) && AGENT_CONFIGS[runtime.kind];
  const defaultInUse = useApp(s => s.data?.agents?.some(a => a.machine === machine && a.kind === runtime.kind && (!a.config_dir || a.config_dir === runtime.config_dir)));
  const defaultDir = runtime.config_dir || (config ? `~/${config.directory}` : "");
  return <form className="stack new-agent-form" onSubmit={async event => {
    event.preventDefault();
    if (!name.trim()) return setError("Give this agent a name.");
    setBusy(true); setError("");
    try {
      const r = await post(`/api/agents?machine=${encodeURIComponent(machine)}`, { kind: runtime.kind, name: name.trim(), config_dir: directory.trim() });
      if (!r.ok) setError(r.data?.error || "Couldn't create this agent.");
      else { toast(`${name.trim()} added on ${machine}.`); done(); }
    } catch (e) { setError(e.message || "Couldn't reach this machine."); }
    finally { setBusy(false); }
  }}>
    <p>A separate agent on {machine}, with its own name and configuration.</p>
    <label className="field">Name<input autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)} autoComplete="off" required /></label>
    {config && <div className="field"><label htmlFor="new-agent-directory">Config directory <span className="muted">(optional)</span></label>
      <input id="new-agent-directory" value={directory} onChange={e => setDirectory(e.target.value)} placeholder={defaultDir} autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="new-agent-directory-hint" />
      <small id="new-agent-directory-hint">{defaultInUse ? `The default directory is already in use. Choose a different folder on ${machine} to add another ${runtime.name}.` : `Leave blank to use ${defaultDir}.`} A new folder needs its own setup.</small>
    </div>}
    {error && <p className="auth-err" role="alert">{error}</p>}
    <div className="row-acts"><button className="btn btn--dark" disabled={busy}>{busy ? "Creating…" : "Create agent"}</button><button className="btn" type="button" onClick={done}>Cancel</button></div>
  </form>;
}

// The agent a setup in this box just made (installing Hermes, DeepSeek or Antigravity makes one, named for its
// runtime), named before the box closes.
function NameMadeAgent({ agent, done }: { agent: AgentRow; done: () => void }) {
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="stack new-agent-form" onSubmit={async event => {
    event.preventDefault();
    const next = name.trim();
    if (!next) return setError("Give this agent a name.");
    if (next === agent.name) return done();
    setBusy(true); setError("");
    try {
      const r = await renameAgent(agent.id, next);
      if (r.ok) return done();
      setError(r.data?.error || "Couldn't name this agent. Try again.");
    } catch (e) { setError(e.message || "Couldn't reach agentbook. Try again."); }
    setBusy(false);
  }}>
    <label className="field">Name<input value={name} maxLength={80} onChange={e => setName(e.target.value)} autoComplete="off" required /></label>
    {error && <p className="auth-err" role="alert">{error}</p>}
    <div className="row-acts"><button className="btn btn--dark" disabled={busy}>Done</button></div>
  </form>;
}

export function NewAgent({ machine, openKind, done }: { machine: string; openKind?: string | null; done: () => void }) {
  const [runtimes, setRuntimes] = useState<Runtimes | null>(null);
  const [selected, setSelected] = useState<string | null>(openKind || null);
  const [error, setError] = useState("");
  const agents = useApp(s => s.data?.agents || []);
  const offline = useApp(s => s.data?.machines?.find(m => m.name === machine)?.online === false);
  const load = () => getJSON<Runtimes>(`/api/runtimes?machine=${encodeURIComponent(machine)}`).then(r => { setRuntimes(r); setError(""); }).catch(e => setError(e.message || "Couldn't read agent types."));
  useEffect(() => { let alive = true; getJSON<Runtimes>(`/api/runtimes?machine=${encodeURIComponent(machine)}`).then(r => alive && setRuntimes(r)).catch(e => alive && setError(e.message)); return () => { alive = false; }; }, [machine]);
  const local = (runtimes?.runtimes || []).filter(r => !r.remote && !isCloudRuntime(r.kind));
  const supportsProfiles = (r: RuntimeRow) => isRuntimeId(r.kind) && !!AGENT_CONFIGS[r.kind];
  const canCreate = (r: RuntimeRow) => supportsProfiles(r) && !!runtimes?.profiles;
  const available = local.filter(r => supportsProfiles(r) || !(r.kind === "openclaw" ? r.ok : agents.some(a => a.machine === machine && a.kind === r.kind)));
  const runtime = local.find(r => r.kind === selected);
  // Whether the picked type was ready when picked: one set up in this box made its agent already, so the box names
  // that one instead of offering another. OpenClaw's agents are its gateway's, renamed on Agents.
  const [readyWhenPicked, setReadyWhenPicked] = useState<boolean | null>(null);
  useEffect(() => { if (runtime && readyWhenPicked === null) setReadyWhenPicked(!!runtime.ok); }, [runtime, readyWhenPicked]);
  const setUpHere = readyWhenPicked === false;
  const made = runtime?.ok && runtime.kind !== "openclaw" ? agents.find(a => a.machine === machine && a.kind === runtime.kind && (!a.config_dir || a.config_dir === runtime.config_dir)) : undefined;
  return <div className="new-agent">
    {error && <p role="alert" className="auth-err">{error} <button className="btn btn--sm" onClick={() => void load()}>Retry</button></p>}
    {offline && <p className="muted">{machine} is offline. Add an agent when it reconnects.</p>}
    {!selected ? <>
      <p className="new-agent-intro">Choose an agent type to add.</p>
      {!runtimes && !error && <p className="muted">Reading agent types…</p>}
      {!!available.length && <table className="mini-tbl new-agent-types" aria-label="Agent types to add">
        <thead><tr><th>Agent type</th><th>Actions</th></tr></thead>
        <tbody>{available.map(r => <tr key={r.kind}><td><b>{r.name}</b></td><td><button className="btn btn--sm btn--line" aria-label={`Add ${r.name} agent`} disabled={offline || r.status === "Off"} onClick={() => setSelected(r.kind)}>Add</button></td></tr>)}</tbody>
      </table>}
      {runtimes && !available.length && <p className="list-empty">All available agent types are connected on this machine.</p>}
    </> : <>
      <div className="new-agent-step"><button className="btn btn--sm btn--line" onClick={() => { setSelected(null); setReadyWhenPicked(null); }}>Back</button><h3>{runtime?.name || selected}</h3></div>
      {runtime && canCreate(runtime) && runtime.ok && !offline && !setUpHere
        ? <CreateAgentForm key={runtime.kind} runtime={runtime} machine={machine} done={done} />
        : runtime?.ok && supportsProfiles(runtime) && !runtimes?.profiles
          ? <p>Update agentbook-cli on {machine} to add agents with their own config directory. <a href={machineHref(machine)}>View machine details</a></p>
        : <SetupAgents key={selected} machine={machine} openKind={selected} onlyKind={selected} onLoaded={setRuntimes} />}
      {runtime?.ok && (setUpHere || !supportsProfiles(runtime)) && (made ? <NameMadeAgent key={made.id} agent={made} done={done} /> : <button className="btn btn--dark" onClick={done}>Done</button>)}
    </>}
  </div>;
}
