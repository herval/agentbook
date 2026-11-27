// Your workspaces, on your profile's Workspaces tab: picking one opens its page, where it's renamed or taken off the
// list. The one a thread last worked in goes on top within each machine, and under one on GitHub, why its pull requests
// can't be read, when they can't. A workspace appears under every machine with a checkout or clone in progress, with
// its worktrees there.
import { tildeOn, wsNote, wsWhere, workspaces } from "../../lib/agents.ts";
import { hueVars, plural } from "../../lib/format.ts";
import { machineHref, useRoute, workspaceHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { Icon } from "../Icon.tsx";
import { wipGroups, wipHref, wipMeta, wipOrder, wipWhy } from "../worktrees/wips.ts";
import type { Wip, Ws } from "../worktrees/wips.ts";
import { openAddWs } from "./addws.ts";
import { GhFix } from "./Workspace.tsx";

export function WorkspacesCard() {
  const data = useApp((s) => s.data);
  const list = [...workspaces()].sort((a, b) => b.used.localeCompare(a.used));
  const machines = (data?.machines || []).filter((m) => m.mine);
  const groups = machineGroups(list, machines.map((m) => m.name), data?.machine);
  return (
    <section className="card box ws-box">
      <h3>Workspaces</h3>
      {groups.length ? (
        <div className="ws-machine-groups">
          {groups.map((g) => {
            const machine = machines.find((m) => m.name === g.machine);
            return (
              <section className="ws-machine-group" key={g.machine === null ? "unassigned" : `machine:${g.machine}`} aria-label={g.machine || "Not on a machine"}>
                <h4 className="ws-machine-head">
                  <Icon name={g.machine ? "laptop" : "folder"} />
                  {machine ? <a href={machineHref(g.machine)}>{g.machine}</a> : <span>{g.machine || "Not on a machine"}</span>}
                  <small>{plural(g.workspaces.length, "workspace")}</small>
                  {machine && (
                    <button type="button" className="btn btn--sm ws-machine-add" aria-haspopup="dialog" onClick={() => openAddWs({ targetMachine: machine.name })} aria-label={`Add a workspace on ${machine.name}`}>
                      Add a workspace
                    </button>
                  )}
                </h4>
                <ul className="nav">
                  {g.workspaces.map((w) => <WsRow key={w.id} w={w} machine={g.machine} />)}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <p className="list-empty">No workspaces yet. A workspace keeps a repo's or a folder's threads together, and its worktrees under it.</p>
      )}
    </section>
  );
}

function machineGroups(list: Ws[], owned: string[], here?: string) {
  const groups = new Map<string | null, Ws[]>();
  for (const machine of owned) groups.set(machine, []);
  for (const w of list) {
    const machines = [...new Set([...w.checkouts, ...(w.cloning || [])].map((c) => c.machine).filter(Boolean))];
    for (const machine of machines.length ? machines : [null]) {
      if (!groups.has(machine)) groups.set(machine, []);
      groups.get(machine).push(w);
    }
  }
  return [...groups]
    .map(([machine, workspaces]) => ({ machine, workspaces }))
    .sort((a, b) => Number(a.machine === null) - Number(b.machine === null) || Number(b.machine === here) - Number(a.machine === here) || (a.machine || "").localeCompare(b.machine || ""));
}

// One workspace on that list: its name, where it is, how many threads run in it; why GitHub can't be read for it;
// and its active worktrees.
function WsRow({ w, machine }: { w: Ws; machine: string | null }) {
  const note = w.pulls?.error ? (w.pulls.pulls.length ? "Can't reach GitHub right now" : w.pulls.error) : "";
  const local = { ...w, checkouts: w.checkouts.filter((c) => c.machine === machine), cloning: (w.cloning || []).filter((c) => c.machine === machine) };
  const under = local.checkouts.length ? local.checkouts.map((c) => tildeOn(machine, c.root)).join(", ") : wsNote(local);
  return (
    <>
      <li className="ws">
        <a href={workspaceHref(w.id)} title={wsWhere(local)}>
          <span className="ico">
            <Icon name={w.repo ? "repo" : "folder"} />
          </span>
          <span className="nav-name">
            {w.name}
            {under && <small>{under}</small>}
          </span>
          {w.live ? (
            <span className="side-n" title={`${plural(w.live, "thread")} running across this workspace`}>
              {w.live}
            </span>
          ) : null}
        </a>
      </li>
      {note && (
        <li>
          <p className="wip-note wip-note--err" title={w.pulls.error}>
            <Icon name="x" />
            <span>
              {note}
              <GhFix ws={w} />
            </span>
          </p>
        </li>
      )}
      <WsTrees w={w} here={null} folded={false} machine={machine ?? undefined} />
    </>
  );
}

// A worktree's dot: closed, landed or merged, or the colour of where it stands (faded when it's gone stale).
function WipDot({ w }: { w: Wip }) {
  if (w.kind === "pr" && w.pr.state === "closed")
    return (
      <span className="wip-dot wip-dot--closed">
        <Icon name="x" />
      </span>
    );
  if (w.state === "clear")
    return (
      <span className={`wip-dot${w.kind === "pr" ? " wip-dot--merged" : ""}`}>
        <Icon name="check" />
      </span>
    );
  return (
    <span className="wip-dot">
      <i className={`dot dot--${w.state}${w.stale ? " dot--stale" : ""}`} />
    </span>
  );
}

// A workspace's worktrees, under it on your profile's Workspaces tab: the active ones, what to do next first, a few at
// most, and Show all, the Worktrees page narrowed to it. Active: work left on it, and a pull request open, or a branch
// changed in the last day. The one whose page you're on (`here`) shows too, and is lit; folded, only that one.
const WS_TREES = 3;
export function WsTrees({ w, here, folded, machine }: { w: Ws; here: Wip | null; folded: boolean; machine?: string }) {
  const route = useRoute();
  const allTrees = wipGroups().find((g) => g.ws?.id === w.id)?.list || [];
  const list = machine ? allTrees.filter((x) => x.kind === "pr" ? !x.local?.length || x.local.some((l) => l.machine === machine) : x.machine === machine) : allTrees;
  const open = list.filter((x) => x.state !== "clear");
  const rows = folded ? [] : open.filter((x) => !x.stale).sort(wipOrder).slice(0, WS_TREES);
  if (here && !rows.some((x) => x.id === here.id)) rows.push(here);
  // On the Worktrees page narrowed to just this workspace, its Show all is lit.
  const scoped = route.name === "worktrees" ? route.scope?.workspace || [] : [];
  const lit = scoped.length === 1 && scoped[0] === w.id;
  const all = !folded && open.length > 0;
  if (!rows.length && !all) return null;
  return (
    <li className="ws-trees">
      <ul className="wip-nav" aria-label={`${w.name}'s worktrees`}>
        {rows.map((x) => (
          <li key={x.id}>
            <a className={here?.id === x.id ? "is-on" : ""} href={wipHref(x)} title={wipWhy(x)} style={hueVars(x.posts[0]?.agent || "claude")}>
              <WipDot w={x} />
              <span className="t">{x.title}</span>
              <span className="m">{wipMeta(x)}</span>
            </a>
          </li>
        ))}
        {all && (
          <li>
            <a className={`ws-all${lit ? " is-on" : ""}`} href={`#/worktrees?workspace=${encodeURIComponent(w.id)}&status=open`} title={machine ? `${w.name}'s worktrees on every machine` : `${w.name}'s worktrees, as a list or a timeline`}>
              {machine ? "All worktrees in workspace" : <>Show all{open.length > rows.length ? ` ${open.length}` : ""}</>}
            </a>
          </li>
        )}
      </ul>
    </li>
  );
}
