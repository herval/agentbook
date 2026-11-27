// Its worktrees, its profile's Worktrees tab: every branch and pull request one of its threads worked on, in any
// workspace, what to do next first. The open ones, then what's landed, merged or closed folded under them, as on the
// Worktrees page: a list, each row saying its workspace and the task it's on (or, as the Worktrees page has it, a
// timeline for each project, its main down the middle and each of them off the commit it left it at).
// With them in more than one workspace (or project folder that isn't one), a Workspace menu narrows them to one: the
// one the address says (#/agents/<id>/worktrees?workspace=<id>), else the one picked last in this browser, which the
// address then says too.
import { useEffect } from "react";
import { agentName, many, tildeOn } from "../../lib/agents.ts";
import { usePref } from "../../lib/hooks.ts";
import { agentHref, followHash, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import type { MenuRow } from "../MenuPick.tsx";
import { useWipClear, WipDoneFold, WipListRow } from "../worktrees/WipRow.tsx";
import { wipGroups, wipOrder } from "../worktrees/wips.ts";
import type { Wip, WipGroup } from "../worktrees/wips.ts";
import type { AgentRow } from "./types.ts";
import { TlGroup, useWorktreesView, WorktreesSeg } from "../worktrees/Timeline.tsx";

// Every branch and pull request a thread of this agent's worked on.
export const agentWips = (id: string): Wip[] =>
  wipGroups()
    .flatMap((g) => g.list)
    .filter((x) => x.posts.some((s) => s.agent === id))
    .sort(wipOrder);
// Its tab's address, narrowed to one workspace or not.
const agentWtHref = (id: string, key?: string) => `${agentHref(id, "worktrees")}${key ? `?workspace=${encodeURIComponent(key)}` : ""}`;
// The address changes without a new screen: the route follows it.
const replaceHref = (href: string) => {
  history.replaceState(null, "", href);
  followHash();
};
// A project's name: its workspace's, or the folder of one that isn't a workspace, as a row on the list says it.
const wtGroupName = (g: WipGroup) => (g.ws ? g.name : tildeOn(g.machine, g.list[0]?.root || g.name));

export function AgentWorktrees({ agent: a, trees }: { agent: AgentRow; trees: Wip[] }) {
  const route = useRoute();
  const folders = useApp((s) => s.data?.folders);
  // And each agent's Worktrees tab, narrowed to one workspace or not.
  const [picked, setPicked] = usePref<Record<string, string>>("agentWtWs", {});
  const clear = useWipClear((s) => s.open);
  const groups = wipGroups().filter((g) => trees.some((x) => g.list.includes(x)));
  const want = route.workspace || picked[a.id];
  const g = groups.length > 1 && want ? groups.find((y) => y.key === want) || null : null;
  const reading = (folders || []).some((x) => x.sessions && !("wip" in x));
  useEffect(() => {
    if (g) {
      if (route.workspace !== g.key) replaceHref(agentWtHref(a.id, g.key));
      // One opened from its address (a link, Back) is the one it opens on next time, too.
      if (picked[a.id] !== g.key) setPicked({ ...picked, [a.id]: g.key });
    } else if (route.workspace && !reading) {
      // One it has none in, once git's read: its address stops saying it.
      replaceHref(agentWtHref(a.id));
    }
  }, [g?.key, route.workspace, reading]);
  const list = g ? trees.filter((x) => g.list.includes(x)) : trees;
  const open = list.filter((x) => x.state !== "clear");
  const done = list.filter((x) => x.state === "clear");
  const key = `agent:${a.id}${g ? `:${g.key}` : ""}`;
  const rows = [...open, ...(clear[key] ? done : [])];
  // As a list, or as each project's timeline (the Worktrees page's choice, kept for both).
  const [view] = useWorktreesView();
  const tl = view === "timeline";
  // Any workspace, or one of those its worktrees are in, each with how many of its worktrees there are open.
  const n = (y: WipGroup) => trees.filter((x) => x.state !== "clear" && y.list.includes(x)).length;
  const menuRows: MenuRow[] = [
    { value: "", text: "Any workspace", face: <Icon name="folder" />, note: String(trees.filter((x) => x.state !== "clear").length), on: !g },
    { divider: "" },
    ...groups.map((y) => ({ value: y.key, text: wtGroupName(y), face: <Icon name={y.ws?.repo ? "repo" : "folder"} />, note: String(n(y)), on: y === g, title: y.ws ? "" : `Not a workspace${many() ? `, on ${y.machine}` : ""}` })),
  ];
  const pick = (v: string) => {
    const next = { ...picked, [a.id]: v };
    if (!v) delete next[a.id];
    setPicked(next);
    replaceHref(agentWtHref(a.id, v));
  };
  return (
    <section className={`card wips${tl ? " wips--tl" : ""}`}>
      <div className="page-head">
        <h2 className="page-h">Worktrees</h2>
        {groups.length > 1 && (
          <MenuPick
            id={`agent-wt-ws:${a.id}`}
            label="Workspace"
            title="Show only one workspace's"
            face={
              <>
                <Icon name={g?.ws?.repo ? "repo" : "folder"} />
                <span className="opt-v">{g ? wtGroupName(g) : "Any workspace"}</span>
                <Icon name="down" className="caret" />
              </>
            }
            rows={menuRows}
            set={!!g}
            onPick={pick}
          />
        )}
        <WorktreesSeg />
      </div>
      {!open.length && (
        <p className="muted wl-empty">
          Nothing open{g ? ` in ${wtGroupName(g)}` : ""}: everything {agentName(a.id)}'s threads worked on{g ? " there" : ""} is on main.
        </p>
      )}
      {rows.length > 0 && tl
        ? groups.map((y) => <TlGroup key={y.key} g={y} list={rows.filter((x) => y.list.includes(x))} open={open.filter((x) => y.list.includes(x)).length} />)
        : rows.length > 0 && (
            <ul className="wl-list">
              {rows.map((x) => (
                <WipListRow key={x.id} x={x} task />
              ))}
            </ul>
          )}
      <WipDoneFold k={key} n={done.length} />
    </section>
  );
}
