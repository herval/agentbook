import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { RUNTIMES, capsOf, isRuntimeId } from "../../../plugin/shared/runtimes.ts";
import type { RuntimeUpdate } from "../../../plugin/shared/runtimes.ts";
import { connecting, fromNow, inactiveAgent, offlineWhy, tildeOn, workspaces } from "../../lib/agents.ts";
import { getJSON, post } from "../../lib/api.ts";
import { agoText, clock, plural } from "../../lib/format.ts";
import { CLOUD_KINDS, cloudName } from "../../lib/images.ts";
import { go, personHref, setupHref, useRoute, workspaceHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { MachineRow, PersonView, Runtimes } from "../../lib/types.ts";
import type { AgentRow } from "../agents/types.ts";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";
import { AddAgentButton } from "../agents/AddAgentDialog.tsx";
import { AgentActivation } from "../agents/AgentList.tsx";
import { AgentNameCell } from "../agents/AgentName.tsx";
import { idleOf } from "../agents/words.ts";
import { BoxInvites, LinkedState, MachineDetailsPanel, SignState, cloudAct } from "../machines/Machine.tsx";
import { AddMachine } from "../machines/Setup.tsx";
import { RoutineFormView } from "../routines/RoutineForm.tsx";
import { LinkChips, useRoutineRows } from "../routines/parts.tsx";
import { openRoutineForm, restoreRoutine, routineAgent, routineAgents, runRoutine, setRoutineUi, switchRoutine, useRoutineUi } from "../routines/routines.ts";
import type { RoutineListRow } from "../routines/routines.ts";
import { openAddWs } from "../workspaces/addws.ts";
import { wipGroups } from "../worktrees/wips.ts";
import type { Ws } from "../worktrees/wips.ts";
import { Disconnect, Unlink } from "./Machines.tsx";

const enc = encodeURIComponent;

function agentStatusChips(a: AgentRow, cloudAsleep = false) {
  const inactive = inactiveAgent(a);
  const working = a.working || 0;
  const needs = a.needs || 0;
  const idle = idleOf(a);
  return (
    <div className="machine-status-chips">
      {inactive && (
        <span className="chip chip--off" title="New threads are blocked. Existing threads continue.">
          Inactive
        </span>
      )}
      {a.link?.state === "off" ? (
        <span className="chip chip--sun">Needs setup</span>
      ) : a.offline ? (
        <>
          <span className={`chip${connecting(a) ? "" : " chip--off"}`} title={offlineWhy(a)}>
            {connecting(a) ? "Connecting" : cloudAsleep ? "Asleep" : `Offline${a.link?.since ? ` since ${clock(a.link.since)}` : ""}`}
          </span>
          {idle > 0 && <span className="chip">{idle} idle</span>}
        </>
      ) : (
        <>
          {working > 0 && (
            <span className="chip chip--live">
              <i className="pulse" />
              {working} running
            </span>
          )}
          {needs > 0 && <span className="chip chip--sun">{needs} needs you</span>}
          {idle > 0 && <span className="chip">{idle} idle</span>}
          {!working && !needs && !idle && !inactive && <span className="chip chip--off">Nothing running</span>}
        </>
      )}
    </div>
  );
}

// What a machine says of its agents' apps (read.runtimes, plugin/cli/runtime-update.ts): the version each runs, the
// newest out, and an update running there. Read as its Agents table shows, when it has an agent whose app agentbook
// updates, and again every 2 s while an update runs.
function useRuntimeUpdates(machine: string, read: boolean) {
  const [updates, setUpdates] = useState<Record<string, RuntimeUpdate>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!read) return;
    let alive = true;
    let again: ReturnType<typeof setTimeout>;
    getJSON<Runtimes>(`/api/runtimes?machine=${enc(machine)}`)
      .then((r) => {
        if (!alive || !r) return;
        const next = Object.fromEntries((r.runtimes || []).filter((x) => x.update).map((x) => [x.kind, x.update]));
        setUpdates(next);
        if (Object.values(next).some((u) => u.state === "updating")) again = setTimeout(() => setTick((t) => t + 1), 2000);
      })
      .catch(() => {});
    return () => {
      alive = false;
      clearTimeout(again);
    };
  }, [machine, read, tick]);
  return { updates, reread: () => setTick((t) => t + 1) };
}

// Beside an agent's version: its app's update, once a newer version is out, as the machine's own runs (its plugin's,
// MachineCliMeta). The machine runs the app's own update command; what that printed shows on a failed one's hover.
function RuntimeUpdatePill({ u, kind, name, machine, reread }: { u?: RuntimeUpdate; kind: string; name: string; machine: string; reread: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!u || (!u.outdated && u.state !== "updating")) return null;
  if (u.state === "updating") return <span className="chip chip--sun">Updating to {u.latest}…</span>;
  const failed = u.state === "failed";
  const run = async () => {
    if (u.wait) return toast(u.wait);
    setBusy(true);
    try {
      const r = await post(`/api/runtimes/update?machine=${enc(machine)}`, { kind });
      if (r.ok) toast(`Updating ${name} on ${machine} to ${u.latest}. Threads already running keep their version.`);
      else if (!r.data?.passkey) toast(r.data?.error || "Couldn’t start the update.");
      reread();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="machine-update-pill" disabled={busy} title={failed && u.output ? u.output.slice(-1500) : `${name} ${u.latest} is out: ${machine} runs ${name}'s own update for it`} onClick={() => void run()}>
        {busy ? "Updating…" : failed ? `Retry update to ${u.latest}` : `Update to ${u.latest}`}
      </button>
      {failed && <small className="machine-update-err">{u.error || "The update failed."}</small>}
    </>
  );
}

function AgentsTable({ agents, machine, cloudAsleep = false, online = false }: { agents: AgentRow[]; machine: string; cloudAsleep?: boolean; online?: boolean }) {
  const { updates, reread } = useRuntimeUpdates(machine, online && agents.some((a) => capsOf(a.runtime || a.kind).updates));
  if (!agents.length) return <p className="list-empty">No agents on this machine yet.</p>;
  return (
    <table className="mini-tbl machine-agents-table" aria-label={`Agents on ${machine}`}>
      <thead>
        <tr>
          <th>Agent</th>
          <th className="machine-desktop">Runtime</th>
          <th className="machine-desktop">Config directory</th>
          <th>Status</th>
          <th className="machine-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => {
          const runtime = isRuntimeId(a.runtime || a.kind) ? RUNTIMES[a.runtime || a.kind] : null;
          const config = a.config_dir ? tildeOn(machine, a.config_dir) : "";
          const inactive = inactiveAgent(a);
          const kind = a.runtime || a.kind;
          const update = <RuntimeUpdatePill u={updates[kind]} kind={kind} name={runtime?.name || kind} machine={machine} reread={reread} />;
          return (
            <tr key={a.id} className={inactive ? "is-inactive" : undefined}>
              <td>
                <AgentNameCell agent={a} />
                <small className="machine-mobile">
                  {runtime?.name || a.kind}
                  {a.version ? ` · ${a.version}` : ""} {update}
                  {config && (
                    <>
                      <br />
                      <code>{config}</code>
                    </>
                  )}
                </small>
              </td>
              <td className="machine-desktop">
                {runtime?.name || a.kind}
                {a.version && <code className="machine-ver">{a.version}</code>}
                {runtime?.place && <small className="muted"> · {runtime.place}</small>} {update}
              </td>
              <td className="machine-desktop">
                <code>{config || "—"}</code>
              </td>
              <td>{agentStatusChips(a, cloudAsleep)}</td>
              <td className="machine-actions">
                <AgentActivation agent={a} concise />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RoutineTableRow({ x }: { x: RoutineListRow }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      toast("Couldn’t update this routine. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const state = x.archived ? "Archived" : x.waiting ? "Needs your OK" : x.running ? "Running" : x.failing ? "Failing" : x.off ? "Paused" : "On";
  return (
    <tr>
      <td>
        <a href={x.href}>
          <b>{x.name}</b>
        </a>
        <div className="machine-routine-links">
          <LinkChips links={x.links} />
          {x.tag && <small>{x.tag}</small>}
        </div>
        <small className="machine-mobile">
          {x.when}
          {x.archived?.at ? ` · Archived ${agoText(x.archived.at)}` : ""}
        </small>
      </td>
      <td className="machine-desktop">{x.when}</td>
      <td className="machine-desktop">{x.archived?.at ? agoText(x.archived.at) : x.next ? fromNow(x.next) : x.manual ? "When you run it" : "—"}</td>
      <td>
        <span className={`chip${x.waiting ? " chip--sun" : x.failing ? " chip--err" : x.archived || x.off ? " chip--off" : " chip--done"}`}>{state}</span>
      </td>
      <td className="machine-actions">
        <div className="row-acts">
          {x.archived ? (
            <button className="btn btn--sm" type="button" disabled={busy} onClick={() => void act(() => restoreRoutine(x.r.id))}>
              Restore
            </button>
          ) : x.waiting ? (
            <a className="btn btn--sm btn--dark" href={x.href}>
              Review
            </a>
          ) : x.r?.live_v ? (
            <>
              <button className="icon-btn" type="button" aria-label={`Run ${x.name} now`} disabled={busy || x.running} onClick={() => void act(() => runRoutine(x.r))}>
                <Icon name="play" />
              </button>
              <button className="btn btn--sm" type="button" disabled={busy} onClick={() => void act(() => switchRoutine(x.r.id, !x.r.on))}>
                {x.r.on ? "Pause" : "Enable"}
              </button>
            </>
          ) : (
            <a className="btn btn--sm" href={x.href}>
              Open
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}

function RoutinesTable({ rows, machine, archived = false }: { rows: RoutineListRow[]; machine: string; archived?: boolean }) {
  if (!rows.length) return <p className="list-empty">No routines here yet.</p>;
  return (
    <table className={`mini-tbl machine-routines-table${archived ? " machine-archived-table" : ""}`} aria-label={`${archived ? "Archived routines" : "Routines"} on ${machine}`}>
      <thead>
        <tr>
          <th>{archived ? "Archived routine" : "Routine"}</th>
          <th className="machine-desktop">Schedule</th>
          <th className="machine-desktop">{archived ? "Archived" : "Next run"}</th>
          <th>Status</th>
          <th className="machine-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <RoutineTableRow key={x.key} x={x} />
        ))}
      </tbody>
    </table>
  );
}

function RoutinesBlock({ rows, archived, machine, showArchived, onToggleArchived }: { rows: RoutineListRow[]; archived: RoutineListRow[]; machine: string; showArchived: boolean; onToggleArchived: () => void }) {
  return (
    <>
      {rows.length ? <RoutinesTable rows={rows} machine={machine} /> : <p className="list-empty">{archived.length ? "No active routines on this machine." : "No routines here yet."}</p>}
      {archived.length > 0 && (
        <div className="machine-archived-wrap">
          <button type="button" className="machine-archived-toggle" aria-expanded={showArchived} onClick={onToggleArchived}>
            <Icon name={showArchived ? "down" : "caret"} />
            <span>
              {showArchived ? "Hide archived" : "Show archived"} ({archived.length})
            </span>
          </button>
          {showArchived && (
            <div className="machine-archived-panel">
              <RoutinesTable rows={archived} machine={machine} archived />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function WorkspacesTable({ list, machine }: { list: Ws[]; machine: string | null }) {
  const groups = wipGroups();
  if (!list.length) return <p className="list-empty">No workspaces on this machine yet.</p>;
  return (
    <table className="mini-tbl machine-workspaces-table" aria-label={`Workspaces ${machine ? `on ${machine}` : "without a machine"}`}>
      <thead>
        <tr>
          <th>Workspace</th>
          <th className="machine-desktop">Folder</th>
          <th>Worktrees</th>
          <th className="machine-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        {list.map((w) => {
          const paths = w.checkouts.filter((c) => c.machine === machine).map((c) => tildeOn(machine, c.root));
          const cloning = w.cloning?.some((c) => c.machine === machine);
          const trees = groups.find((g) => g.ws?.id === w.id)?.list.filter((t) => t.state !== "clear" && (t.kind === "pr" ? t.local?.some((l) => l.machine === machine) : t.machine === machine)).length || 0;
          return (
            <tr key={w.id}>
              <td>
                <a href={workspaceHref(w.id)}>
                  <b>{w.name}</b>
                </a>
                <small className="machine-mobile">{paths.join(", ") || (cloning ? "Cloning…" : "")}</small>
                {w.pulls?.error && <small className="machine-table-note">{w.pulls.error}</small>}
              </td>
              <td className="machine-desktop">
                <code>{paths.join(", ") || (cloning ? "Cloning…" : "—")}</code>
              </td>
              <td>{trees}</td>
              <td className="machine-actions">
                <a className="btn btn--sm" href={workspaceHref(w.id)}>
                  Open
                </a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CollapsibleSection({ id, title, count, summary, action, collapsed, onToggle, children }: { id: string; title: string; count?: number; summary?: ReactNode; action?: ReactNode; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="machine-section" data-collapsed={collapsed}>
      <div className="machine-section-head">
        <button type="button" className="machine-sec-toggle" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}>
          <Icon name={collapsed ? "caret" : "down"} />
          <h4>
            {title}
            {count != null && <small>{count}</small>}
          </h4>
          {summary && <span className="machine-sec-summary">{summary}</span>}
        </button>
        {action}
      </div>
      {!collapsed && (
        <div className="machine-section-body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

function MachineCliMeta({ machine, online, reload }: { machine: MachineRow; online: boolean; reload: () => unknown }) {
  const [updating, setUpdating] = useState(false);
  const u = machine.update;
  const behind = u?.state === "behind" && !!u.to;
  const canUpdate = behind && online && (u.mode === "auto" || u.mode === "ask");
  const runUpdate = async () => {
    setUpdating(true);
    try {
      const r = await post<{ started?: boolean }>(`/api/machines/${enc(machine.name)}/update`, {});
      if (!r.ok && !r.data.passkey) toast(r.data.error || "Couldn’t start the update.");
      if (r.ok) toast(r.data.started === false ? `${machine.name} has the newest agentbook-cli already.` : `${machine.name} is updating its agentbook-cli. It’s back in a moment.`);
      reload();
    } finally {
      setUpdating(false);
    }
  };
  return (
    <span className="machine-meta-item">
      <span className="k">Plugin</span> <code>v{machine.cli.replace(/^v/, "")}</code>
      {u?.state === "updating" ? (
        <span className="chip chip--sun">Updating to {u.to}…</span>
      ) : canUpdate ? (
        <button type="button" className="machine-update-pill" disabled={updating} onClick={() => void runUpdate()}>
          {updating ? "Updating…" : `Update to ${u.to}`}
        </button>
      ) : behind ? (
        <span className="chip chip--sun" title={online ? `Update available: ${u.to}` : `Updates once ${machine.name} is back online`}>
          {u.to} available
        </span>
      ) : null}
    </span>
  );
}

function WakeButton({ name, reload }: { name: string; reload: () => unknown }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--sm btn--line"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await cloudAct("wake", name);
          reload();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Waking…" : "Wake"}
    </button>
  );
}

export function MachineAgents({ agents, person, reload }: { agents: AgentRow[]; person: PersonView | null; reload: () => unknown }) {
  const data = useApp((s) => s.data);
  const username = useApp((s) => s.me?.username);
  const route = useRoute();
  const { rows, gone, reading } = useRoutineRows();
  const form = useRoutineUi((s) => s.form);
  const [formMachine, setFormMachine] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [secFolded, setSecFolded] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const targetMachine = !route.open && route.machine ? route.machine : null;

  useEffect(() => {
    if (!targetMachine) return;
    setFolded((old) => (old[targetMachine] ? { ...old, [targetMachine]: false } : old));
    setSecFolded((old) => ({ ...old, [`${targetMachine}:details`]: false }));
    const el = document.querySelector(`.machine-card[aria-label="${CSS.escape(targetMachine)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [targetMachine]);

  const owned = (data?.machines || []).filter((m) => m.mine);
  const list = [...workspaces()].sort((a, b) => b.used.localeCompare(a.used));
  const names = [...new Set([...owned.map((m) => m.name), ...(person?.devices || []).map((d) => d.name), ...agents.map((a) => a.machine).filter(Boolean), ...list.flatMap((w) => [...w.checkouts, ...(w.cloning || [])].map((c) => c.machine))])].sort(
    (a, b) => Number(b === data?.machine) - Number(a === data?.machine) || a.localeCompare(b),
  );
  const routineMachine = (x: RoutineListRow) => {
    const agent = x.r ? routineAgent(x.r) : x.links.find((l) => l.kind === "agent")?.id;
    return agents.find((a) => a.id === agent)?.machine || null;
  };
  const archivedSorted = [...gone].sort((a, b) => (b.archived?.at || "").localeCompare(a.archived?.at || ""));
  const unassignedWorkspaces = list.filter((w) => !w.checkouts.length && !w.cloning?.length);
  const unassignedRoutines = rows.filter((x) => !routineMachine(x));
  const unassignedArchived = archivedSorted.filter((x) => !routineMachine(x));
  const newRoutine = (machine: string) => {
    setFormMachine(machine);
    openRoutineForm(null, { agent: routineAgents().find((a) => a.machine === machine)?.id });
  };
  const isSecCollapsed = (machine: string, sec: string) => (sec === "details" ? secFolded[`${machine}:${sec}`] !== false : !!secFolded[`${machine}:${sec}`]);
  const toggleSec = (machine: string, sec: string) => setSecFolded((old) => ({ ...old, [`${machine}:${sec}`]: !isSecCollapsed(machine, sec) }));

  return (
    <div className="machine-agents">
      <div className="machine-page-head">
        <div>
          <h2>Your machines</h2>
          <p className="muted">
            {plural(names.length, "machine")} · {plural(agents.filter((a) => !inactiveAgent(a)).length, "enabled agent")} · {plural(rows.length, "routine")}
          </p>
        </div>
        <div className="row-acts">
          <AddAgentButton className="btn">Add agent</AddAgentButton>
          <a className="btn btn--dark" href={setupHref(username, "machine")}>
            <Icon name="plus" />
            Add machine
          </a>
        </div>
      </div>
      <BoxInvites />
      {names.map((name) => {
        const machine = owned.find((m) => m.name === name);
        const device = person?.devices?.find((d) => d.name === name);
        const online = !!(machine?.online ?? device?.online);
        const cloud = machine?.cloud || null;
        const cloudAsleep = !!cloud && !online;
        const local = agents.filter((a) => a.machine === name);
        const routines = rows.filter((x) => routineMachine(x) === name);
        const archived = archivedSorted.filter((x) => routineMachine(x) === name);
        const spaces = list.filter((w) => [...w.checkouts, ...(w.cloning || [])].some((c) => c.machine === name));
        const running = online ? local.reduce((n, a) => n + (a.offline ? 0 : a.working || 0), 0) : 0;
        const needs = online ? local.reduce((n, a) => n + (a.offline ? 0 : a.needs || 0), 0) : 0;
        const idle = local.reduce((n, a) => n + idleOf(a), 0);
        const inactive = local.filter((a) => inactiveAgent(a)).length;
        const waiting = machine?.waiting || 0;
        const agentsCollapsed = isSecCollapsed(name, "agents");
        const routinesCollapsed = isSecCollapsed(name, "routines");
        const workspacesCollapsed = isSecCollapsed(name, "workspaces");
        const detailsCollapsed = isSecCollapsed(name, "details");
        const reviewCount = routines.filter((r) => r.waiting).length;
        const totalTrees = wipGroups().reduce((n, g) => n + (spaces.some((w) => w.id === g.ws?.id) ? g.list.filter((t) => t.state !== "clear" && (t.kind === "pr" ? t.local?.some((l) => l.machine === name) : t.machine === name)).length : 0), 0);

        const statusChip = online ? (
          <span className="chip chip--done">Online</span>
        ) : cloud ? (
          <span className={`chip${cloud.error ? " chip--err" : " chip--off"}`}>{cloud.setting ? "Setting up" : cloud.waking ? "Waking" : cloud.error ? "Can’t wake" : "Asleep"}</span>
        ) : (
          <span className="chip chip--off">Offline</span>
        );

        const hasMeta = !!(machine?.os || machine?.cli || (machine?.seen && !online));
        return (
          <section className={`card machine-card${folded[name] ? " is-folded" : ""}`} key={name} aria-label={name}>
            <header className="machine-card-head">
              <span className="machine-card-ico">
                <Icon name={cloud ? "cloud" : "laptop"} />
              </span>
              <div className="machine-card-title">
                <h3>
                  <span>{name}</span>
                  {statusChip}
                  {name === data?.machine && <span className="chip">This machine</span>}
                  {cloud && (
                    <span className="chip" title={`Runs in ${cloud.kind === "exe" ? "an exe.dev VM" : "a boat sandbox"}${cloud.made ? " agentbook made" : ""}`}>
                      <Icon name="cloud" />
                      {cloudName(cloud.kind)}
                    </span>
                  )}
                  {device?.linked ? <LinkedState name={device.name} linked={device.linked} then={reload} /> : device?.signs != null ? <SignState name={device.name} signs={device.signs} here={!!device.server_here} then={reload} /> : null}
                </h3>
                {hasMeta && (
                  <div className="machine-meta">
                    {machine?.os && (
                      <span className="machine-meta-item">
                        <span className="k">OS</span> {machine.os}
                      </span>
                    )}
                    {machine?.cli && <MachineCliMeta machine={machine} online={online} reload={reload} />}
                    {machine?.seen && !online && <span className="machine-meta-item muted">Last seen {agoText(machine.seen)}</span>}
                  </div>
                )}
                {cloud?.login && !online && (
                  <div className="live live--step">
                    <i className="pulse" />
                    <a href={cloud.login.url} target="_blank" rel="noreferrer">
                      <b>Say yes to {cloud.login.code}</b>
                    </a>
                    <span className="live-n">on the sign-in page, and {name} is On a moment later</span>
                  </div>
                )}
                <div className="machine-counters">
                  {running > 0 && (
                    <span className="chip chip--live">
                      <i className="pulse" />
                      {running} running
                    </span>
                  )}
                  {needs > 0 && <span className="chip chip--sun">{needs} needs you</span>}
                  {idle > 0 && <span className="chip">{idle} idle</span>}
                  {inactive > 0 && <span className="chip chip--off">{inactive} inactive</span>}
                  {waiting > 0 && <span className="chip chip--sun">{waiting} waiting</span>}
                  {!running && !needs && !idle && !inactive && !waiting && <span className="chip chip--off">Nothing running</span>}
                  {folded[name] && (
                    <small className="muted">
                      · {plural(local.length, "agent")} · {plural(routines.length, "routine")} · {plural(spaces.length, "workspace")}
                    </small>
                  )}
                </div>
              </div>
              <div className="row-acts">
                {cloud && !online && !cloud.waking && <WakeButton name={name} reload={reload} />}
                {device && (device.linked ? <Unlink d={device} reload={reload} /> : <Disconnect d={device} reload={reload} />)}
                <button className="icon-btn" type="button" aria-label={`${folded[name] ? "Expand" : "Collapse"} ${name}`} aria-expanded={!folded[name]} onClick={() => setFolded((old) => ({ ...old, [name]: !old[name] }))}>
                  <Icon name={folded[name] ? "caret" : "down"} />
                </button>
              </div>
            </header>
            {!folded[name] && (
              <div className="machine-card-body">
                <CollapsibleSection
                  id={`sec-${name}-agents`}
                  title="Agents"
                  count={local.length}
                  collapsed={agentsCollapsed}
                  onToggle={() => toggleSec(name, "agents")}
                  summary={agentsCollapsed ? [running ? `${running} running` : "", needs ? `${needs} needs you` : "", idle ? `${idle} idle` : "", inactive ? `${inactive} inactive` : ""].filter(Boolean).join(" · ") || undefined : undefined}
                  action={
                    <AddAgentButton className="btn btn--sm" machine={name} aria-label={`Add agent on ${name}`}>
                      Add agent
                    </AddAgentButton>
                  }
                >
                  <AgentsTable agents={local} machine={name} cloudAsleep={cloudAsleep} online={online && !!machine} />
                </CollapsibleSection>

                <CollapsibleSection
                  id={`sec-${name}-routines`}
                  title="Routines"
                  count={routines.length}
                  collapsed={routinesCollapsed}
                  onToggle={() => toggleSec(name, "routines")}
                  summary={routinesCollapsed ? [reviewCount ? `${reviewCount} needs OK` : "", archived.length ? `${archived.length} archived` : ""].filter(Boolean).join(" · ") || undefined : undefined}
                  action={
                    <button className="btn btn--sm" type="button" disabled={!routineAgents().some((a) => a.machine === name)} onClick={() => newRoutine(name)}>
                      Add routine
                    </button>
                  }
                >
                  <RoutinesBlock rows={routines} archived={archived} machine={name} showArchived={!!showArchived[name]} onToggleArchived={() => setShowArchived((old) => ({ ...old, [name]: !old[name] }))} />
                </CollapsibleSection>

                <CollapsibleSection
                  id={`sec-${name}-workspaces`}
                  title="Workspaces"
                  count={spaces.length}
                  collapsed={workspacesCollapsed}
                  onToggle={() => toggleSec(name, "workspaces")}
                  summary={workspacesCollapsed && totalTrees > 0 ? plural(totalTrees, "worktree") : undefined}
                  action={
                    <button className="btn btn--sm" type="button" aria-haspopup="dialog" aria-label={`Add workspace on ${name}`} onClick={() => openAddWs({ targetMachine: name })}>
                      Add workspace
                    </button>
                  }
                >
                  <WorkspacesTable list={spaces} machine={name} />
                </CollapsibleSection>

                {machine && (
                  <CollapsibleSection
                    id={`sec-${name}-details`}
                    title="Details & access"
                    collapsed={detailsCollapsed}
                    onToggle={() => toggleSec(name, "details")}
                    summary={
                      detailsCollapsed ? (
                        <>
                          {machine.clone_dir && <code>{tildeOn(name, machine.clone_dir)}</code>}
                          {waiting > 0 && <span className="chip chip--sun">{waiting} waiting</span>}
                        </>
                      ) : undefined
                    }
                  >
                    <MachineDetailsPanel name={name} />
                  </CollapsibleSection>
                )}
              </div>
            )}
          </section>
        );
      })}
      {!names.length && <p className="list-empty">Link a machine to add its agents and workspaces.</p>}
      {agents.some((a) => !a.machine) && (
        <section className="card box">
          <h3>Other agents</h3>
          <AgentsTable agents={agents.filter((a) => !a.machine)} machine="agentbook" />
        </section>
      )}
      {reading && <p className="muted">Reading your agents’ routines…</p>}
      {(unassignedRoutines.length > 0 || unassignedArchived.length > 0) && (
        <section className="card box">
          <h3>Other routines</h3>
          <RoutinesBlock rows={unassignedRoutines} archived={unassignedArchived} machine="agentbook" showArchived={!!showArchived.__other} onToggleArchived={() => setShowArchived((old) => ({ ...old, __other: !old.__other }))} />
        </section>
      )}
      {!!unassignedWorkspaces.length && (
        <section className="card box">
          <h3>Workspaces without a checkout</h3>
          <WorkspacesTable list={unassignedWorkspaces} machine={null} />
        </section>
      )}
      {!!person?.not_linked?.length && (
        <section className="card box">
          <h3>Not linked</h3>
          {person.not_linked.map((m) => (
            <p key={m.id}>
              <b>{m.name}</b> · {m.why}
            </p>
          ))}
        </section>
      )}
      <Dialog open={route.open === "machine"} onClose={() => go(personHref(username, "agents"))} label="Add machine" className="viewer modal modal--add">
        <header className="viewer-h">
          <b className="viewer-t">Add machine</b>
          <button className="icon-btn" type="button" aria-label="Close" onClick={() => go(personHref(username, "agents"))}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          <section className="modal-sec">
            <AddMachine username={username} none stayHere />
            {data?.connectors?.some((c) => CLOUD_KINDS.includes(c.kind) && !c.off) && (
              <p>
                <a className="btn" href="#/workspaces/new?cloud=">
                  Create a cloud machine
                </a>
              </p>
            )}
          </section>
        </div>
      </Dialog>
      <Dialog
        open={!!formMachine && !!form && !form.rid}
        onClose={() => {
          setRoutineUi({ form: null });
          setFormMachine(null);
        }}
        label={`New routine on ${formMachine}`}
        className="viewer modal modal--add"
      >
        <header className="viewer-h">
          <b className="viewer-t">New routine on {formMachine}</b>
          <button className="icon-btn" type="button" aria-label="Close" onClick={() => setRoutineUi({ form: null })}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          <div className="modal-sec">
            <RoutineFormView machine={formMachine} />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
