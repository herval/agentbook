// The composer: writing on an agent's wall starts a session (app.ts composer, with "the composer: who can see it, and
// pulling from the cloud"). The box that starts a thread, on the Feed, an agent's wall (`agent`), a page (`page`,
// `bar`: in its threads bar), a group, a task, a worktree (`wip`), a dashboard (`dash`) or a routine. Its logic is
// bar/compose-state.ts; its picks, kept in this browser, bar/compose.ts.
import { AddAgentButton } from "./agents/AddAgentDialog.tsx";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { groupAgents } from "../lib/agent-groups.ts";
import { agentName, gitHubOf, inactiveAgent, offlineWhy, repoName, startable, hiddenAgent, tildeOn, waits, workspaces, wsWhere } from "../lib/agents.ts";
import { pickFile, post, sendStaged } from "../lib/api.ts";
import { getDraft, setDraft, useDraft } from "../lib/hooks.ts";
import { GROUP_MENTION, TASK_MENTION, groupNamed, taskNamed } from "../lib/mentions.tsx";
import { go, NO_SCOPE, scopeHref, useRoute } from "../lib/route.ts";
import { agentOf, getApp } from "../lib/store.ts";
import { toast } from "../lib/toast.ts";
import type { AgentRow, GroupRow, PageData, PageRow, Route, TaskRow } from "../lib/types.ts";
import { Avatar, YouAvatar } from "./Avatar.tsx";
import { CloudBox } from "./bar/compose-cloud.tsx";
import type { PullFrom } from "./bar/compose-cloud.tsx";
import { branchRequest, cloneTitle, cloudOf, composeAgents, launchBranch, launchEffort, launchMode, launchModel, launchVis, pickedGroup, postGroups, postPages, putBack, sending, setComposeUi, useComposeUi, visToSend, wantBranches, withBranches, writesPage } from "./bar/compose-state.ts";
import type { LaunchItem, Project } from "./bar/compose-state.ts";
import { setCompose, setComposeMode, useCompose } from "./bar/compose.ts";
import type { ComposePicks } from "./bar/compose.ts";
import { groupById, groupIn, groupMine } from "./groups/groups.ts";
import { Icon } from "./Icon.tsx";
import { MenuPick } from "./MenuPick.tsx";
import type { MenuRow } from "./MenuPick.tsx";
import { MsgBox } from "./MsgBox.tsx";
import type { AbBox } from "./MsgBox.tsx";
import { barHref, pageById, writesPages } from "./pages/pages.ts";
import { bumpRoutines, routineAgent } from "./routines/routines.ts";
import { ForTaskChip } from "./tasks/Lists.tsx";
import { oneOf, taskById, taskPrompt, useSendTask } from "./tasks/tasks.ts";
import { talkRows } from "./thread/guest-rows.ts";
import { toHintText } from "./thread/Guests.tsx";
import { putBackStaged, saidWith, stage, StagedChips, takeStaged } from "./thread/staged.tsx";
import { VisCorner } from "./Visibility.tsx";
import { openAddWs } from "./workspaces/addws.ts";
import { prLaunch, prPlace, useWorld, wipAgent, wipById, wipLaunch } from "./worktrees/wips.ts";
import type { Wip } from "./worktrees/wips.ts";
import { startTalk } from "../views/thread/talk.ts";
import { groupStyle, pageStyle } from "../lib/format.ts";

// Machine and agent have separate menus. Their picks name one agent on that machine, which decides the projects
// it can work in. Switching machines keeps the agent's kind when one is available there.
// `page`: a post for a page (its id), "new" for one to make or the page to change. Only agents that can write pages
// take it (on the page's machine), its contributors first. Without one, the composer picks where the thread goes:
// your feed, or a page you follow, as if you'd started it there.
// `bar`: in a page's threads bar, where "it" is the page beside it.
// `task`: on a task's page, above its threads, for a thread on it: its agent and workspace picked to start with, and
// what you pick there kept for it alone. In its group, when it's in one of yours.
// `wip`: a branch's or a pull request's page, for a thread on it (`box`, its placeholder): the agents on the machine
// that has it, the branch said rather than picked, and the agent you pick there kept for it alone.
// `dash`: a new page that's a dashboard (Dashboards' own composer).
// `routine`: a routine's page, for a thread on it (routine-threads.ts): an agent's own ("<agent>/<job>", with `agent`
// its agent), or one of agentbook's (its id), with its agent picked to start with and what you pick there kept for it
// alone. It starts with no workspace unless you pick one, and goes on your feed.
// `onStarted`: told once a thread starts from it (an agent's routine's page reads its threads again).
export interface ComposerProps {
  agent?: string;
  page?: string | null;
  bar?: boolean;
  group?: string | null;
  task?: string | null;
  wip?: string | null;
  // The box's placeholder, where its screen says what to start there (a branch's page, a routine's).
  box?: string;
  dash?: boolean;
  routine?: string | null;
  onStarted?: () => void;
}

const ADD_WS = "~add"; // the workspace picker's last row
const ADD_WS_TITLE = "Connect a repo or pick a folder";

// A routine's composer: its key (where its picks are kept, and its box's draft), its job, the agent it runs as, and
// for one of agentbook's (`mine`), the page it keeps.
interface RoutineAt {
  key: string;
  job: string;
  agent: string | null;
  mine: boolean;
  page: PageRow | null;
  name: string;
}
// An agent's routine ("<agent>/<job>" on its wall's routine page), or one of agentbook's (its id), as the old page
// handed it to the composer.
function routineOf(id: string, agentId: string | undefined, data: PageData): RoutineAt {
  if (agentId) return { key: id, job: id.startsWith(`${agentId}/`) ? id.slice(agentId.length + 1) : id.slice(id.indexOf("/") + 1), agent: agentId, mine: false, page: null, name: "" };
  const r = (data.routines || []).find((x) => x.id === id);
  const page = r?.page ? (data.pages || []).find((p) => p.id === r.page) || null : null;
  return { key: id, job: id, agent: r ? routineAgent(r) : null, mine: true, page, name: r?.name || "" };
}

const PgIco = ({ p }: { p: PageRow }) => (
  <span className="pg-ico" style={pageStyle(p)}>
    {p.emoji || "📄"}
  </span>
);
const GrIco = ({ g }: { g: GroupRow }) => (
  <span className="gr-ico" style={groupStyle(g)}>
    {g.emoji || "👥"}
  </span>
);
// Signal-bar effort meter: one ascending bar per level the model offers, filled through the active level.
function EffortMeter({ levels, at }: { levels: number; at: number }) {
  const n = Math.max(2, levels);
  const w = 15;
  const gap = 1.2;
  const bw = (w - gap * (n - 1)) / n;
  return (
    <svg className="meter" viewBox={`0 0 ${w} 11`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const h = 2.6 + (8.4 * i) / (n - 1);
        return <rect key={i} x={(i * (bw + gap)).toFixed(2)} y={(11 - h).toFixed(2)} width={bw.toFixed(2)} height={h.toFixed(2)} rx="0.65" className={i <= at ? "on" : undefined} />;
      })}
    </svg>
  );
}
// Two options that belong together (folder + branch, model + effort) share one compact pill chip.
function pair(key: string, sep: ReactNode, ...xs: ReactNode[]): ReactNode {
  const on = xs.filter(Boolean);
  if (on.length <= 1) return on[0] || null;
  return (
    <span className="opt-pair" key={key}>
      {on[0]}
      {sep}
      {on[1]}
    </span>
  );
}
// A box saying why no thread can start here, with the way to add agents where that's the fix.
function Empty({ children }: { children: ReactNode }) {
  return <section className="card compose compose--empty">{children}</section>;
}

export function Composer(props: ComposerProps) {
  const data = useWorld();
  const route = useRoute();
  const picks = useCompose();
  const lists = useComposeUi((s) => s.branchLists);
  if (!data) return null;
  const m = composeModel(props, data, route, picks, lists);
  if (m.kind === "empty") return <>{m.empty}</>;
  return <ComposeForm key={m.draft} m={m} onStarted={props.onStarted} />;
}

// Everything the composer shows, and what starting a thread from it sends: a port of the old composer(), with what
// its form's hidden inputs held as values.
function composeModel(props: ComposerProps, data: PageData, route: Route, picks: ComposePicks, lists: ReturnType<typeof useComposeUi.getState>["branchLists"]) {
  const agentId = props.agent || null;
  if (agentId && inactiveAgent(data.agents?.find((a) => a.id === agentId))) {
    return { kind: "empty" as const, empty: <Empty><p>{agentName(agentId)} is deactivated. Activate it on its profile to start new threads.</p></Empty> };
  }
  const { bar = false, dash = false, box = "" } = props;
  const task: TaskRow | null = props.task ? taskById(props.task) || ({ id: props.task, text: "" } as TaskRow) : null;
  const wip: Wip | null = props.wip ? wipById(props.wip) : null;
  const routine = props.routine ? routineOf(props.routine, props.agent, data) : null;
  const page: PageRow | "new" | null = props.page === "new" ? "new" : props.page ? (data.pages || []).find((p) => p.id === props.page) || ({ id: props.page, title: props.page } as PageRow) : null;
  let group: GroupRow | null = props.group ? groupById(props.group) || null : null;
  if (props.wip && !wip) return { kind: "empty" as const, empty: null };
  const tg = task?.group && groupById(task.group);
  if (tg && groupMine(tg) && !tg.archived) group = tg;
  const at = wip ? (wip.kind === "pr" ? prPlace(wip) : wip) : null;
  const tpKey = task ? task.id : wip ? `wip:${wip.id}` : routine ? `routine:${routine.key}` : null;
  const tp = tpKey ? picks.taskPicks[tpKey] || {} : null;
  const agentPick = tp ? (tp.agent ?? (task ? task.agent || task.sent?.at(-1)?.agent || picks.agentPick : routine ? routine.agent : at && wipAgent({ machine: at.machine, posts: wip.posts })?.id)) : picks.agentPick;
  const wsPick = tp ? (tp.ws ?? (routine ? "" : task?.workspace || picks.wsPick)) : picks.wsPick;
  // The feed's composer can start a thread of yours instead: You, above the agents. The
  // agents you @ in it join it; it runs nowhere itself, and goes on your feed, not on a page or in a group.
  const canYou = !agentId && !page && !group && !task && !wip && !routine;
  const you = canYou && agentPick === "~you";
  const places = page || group || you || task || wip || routine ? [] : postPages(agentId || undefined);
  const circles = page || group || you || task || wip || routine ? [] : postGroups();
  const onto = places.find((x) => x.page.id === picks.pagePick && !x.why)?.page || null;
  const into = circles.find((g) => g.id === pickedGroup(picks.pagePick)?.id) || null;
  const pg: PageRow | "new" | null = page || onto;
  // In a group: its own composer's, or the one picked as where it goes.
  const grp = group || into;
  // An agent whose machine is off can take a thread all the same: it starts when its machine is back.
  let agents: AgentRow[] = composeAgents();
  // In a group, its agents first.
  if (grp) {
    const members = new Set((grp.members || []).map((x) => x.agent));
    agents = agents.sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)));
  }
  // On a branch or a pull request: the agents that work in folders, on the machine that has it.
  if (wip) {
    agents = agents.filter((a) => at && a.machine === at.machine && a.folders !== false && !a.offline);
    if (!agents.length)
      return {
        kind: "empty" as const,
        empty: (
          <Empty>
            <p>
              <b>No agent can start a thread here.</b> {at ? `None of yours on ${at.machine} is online.` : `No machine has a checkout of ${wip.ws?.name || "its repo"} to work in.`}
            </p>
          </Empty>
        ),
      };
  }
  // On one of agentbook's routines: the agents with agentbook's tools (ab_routine_write), and the one it runs as. One of
  // a page's: those that can write the page, as its thread goes on the page (routine-threads.ts).
  if (routine?.mine) agents = agents.filter((a) => (routine.page ? writesPage(a, routine.page) : writesPages(a.kind) || a.id === routine.agent));
  if (pg) {
    const keeps = new Set(pg === "new" ? [] : (pg.contributors || []).filter((c) => c.agent).map((c) => c.agent));
    agents = agents.filter((a) => writesPage(a, pg)).sort((a, b) => Number(keeps.has(b.id)) - Number(keeps.has(a.id)));
    if (!agents.length)
      return {
        kind: "empty" as const,
        empty: (
          <Empty>
            <p>
              <b>No agent here can write pages.</b> Claude Code's and Codex's can, once a machine of yours runs one.
            </p>
          </Empty>
        ),
      };
  }
  // Agents you have, all of them offline: say why, rather than that there are none.
  const mineAll = (data.agents || []).filter((a) => startable(a) && !hiddenAgent(a));
  const off = !agents.length && !agentId && !page && mineAll.find((a) => a.offline);
  if (off)
    return {
      kind: "empty" as const,
      empty: (
        <Empty>
          <p>
            <b>{mineAll.length > 1 ? "Your agents are offline." : `${agentName(off.id)} is offline.`}</b> {offlineWhy(off)}
          </p>
          <AddAgentButton className="btn">
            <Icon name="bot" />
            Add agents
          </AddAgentButton>
        </Empty>
      ),
    };
  if (!agents.length && !agentId && (data.agents || []).some((a) => a.mine !== false && inactiveAgent(a))) {
    return { kind: "empty" as const, empty: <Empty><p>No active agents are available to start a thread.</p><a className="btn" href="#/agents">Activate an agent</a></Empty> };
  }
  if (!agents.length && !agentId)
    return {
      kind: "empty" as const,
      empty: (
        <Empty>
          <p>
            <b>No agents of your own yet.</b> They show up once a machine you log in here runs Claude Code, Codex, Hermes or OpenClaw.
          </p>
          <AddAgentButton className="btn">
            <Icon name="plus" />
            Add agents
          </AddAgentButton>
        </Empty>
      ),
    };
  const pick = you ? "~you" : agentId || (agents.some((a) => a.id === agentPick) ? agentPick : agents.find((a) => pg && pg !== "new" && a.id === pg.by?.agent)?.id || agents[0]?.id) || "claude";
  const agentGroups = groupAgents(agentId ? data.agents.filter((a) => a.id === agentId) : agents, data.machine);
  const machineGroup = agentGroups.find((g) => g.agents.some((a) => a.id === pick));
  const draft = task ? `task:${task.id}` : wip ? `wip:${wip.id}` : routine ? `routine:${routine.key}` : page ? (page === "new" && dash ? "dash:new" : `page:${page === "new" ? "new" : page.id}`) : group ? `group:${group.id}` : "launch";
  const machine = agentOf(pick).machine || data.machine;
  const folders = !you && !wip && agentOf(pick).folders !== false;
  // An agent that runs in its vendor's cloud has no folder here: it clones one of your repos there, or starts empty.
  const repoed = !you && !wip && agentOf(pick).repos === true;
  // The workspaces it can work in: those checked out on its machine, and repos it can clone there. The feed's
  // workspace goes first. A thread of yours: any, for its agents to work in on theirs. One in the cloud: any too,
  // your folders here with the rest, since what it clones is their repo; those not on GitHub show, but can't be picked.
  const usable = you || repoed ? workspaces() : workspaces().filter((w) => w.repo || w.checkouts.some((c) => c.machine === machine));
  const pickable = repoed ? usable.filter(gitHubOf) : usable;
  // In a group, it can work in the group's own folder instead of a workspace ("~group").
  const inGroupDir = !!grp && folders && (wsPick === "~group" || !usable.length);
  // None is needed. Without one, each agent you @ in a thread of yours works in a folder of the thread's own, one on a
  // page in the page's, one in the cloud starts empty and never clones a repo nobody picked, and the others start in a
  // temp folder. In a group, the group's folder is that none.
  const scopeWs = oneOf(route.scope, "workspace");
  const wsId = inGroupDir ? "~group" : wsPick != null && ((wsPick === "" && !(grp && folders)) || pickable.some((w) => w.id === wsPick)) ? wsPick : you || repoed ? pickable.find((w) => w.id === scopeWs)?.id || "" : (pickable.find((w) => w.id === scopeWs) || pickable[0])?.id || "";
  const ws = usable.find((w) => w.id === wsId);
  const checkout = ws?.checkouts.find((c) => c.machine === machine) || null;
  const project: Project | null = checkout && withBranches(checkout, lists);
  const name = agentName(pick) || "Claude";
  const onRepo = repoed && ws ? gitHubOf(ws) : "";
  const branch = folders && project?.branches ? launchBranch(project, picks.branchPick) : null;
  const model = you ? null : launchModel(pick, picks.modelPick);
  const effort = you ? null : launchEffort(pick, picks.modelPick, picks.effortPick);
  const mode = you ? null : launchMode(pick, picks.modePick);
  // A workspace in the picker: the same list for everyone, and what picking one does said on its row.
  const wsRow = (w: (typeof usable)[number]): MenuRow => {
    const row: MenuRow = { value: w.id, text: w.name, face: <Icon name={w.repo ? "repo" : "folder"} />, on: w.id === wsId };
    if (you) return row;
    if (repoed) return gitHubOf(w) ? { ...row, title: `${name} clones ${repoName(gitHubOf(w))} where it runs` } : { ...row, off: true, note: "not on GitHub", title: `${name} can only clone what's on GitHub` };
    const here = w.checkouts.some((c) => c.machine === machine);
    return { ...row, note: here ? "" : "clone", title: here ? wsWhere(w) : cloneTitle(w, machine) };
  };
  const noWsWhere = you ? "The agents you @ each work in a folder of the thread's own" : repoed ? "It starts with nothing checked out" : pg ? "It works in a folder of the page's own" : "It starts in a temp folder";
  const wsRows: MenuRow[] | null =
    you || repoed || folders
      ? [
          grp && folders ? { value: "~group", text: "The group's folder", face: <Icon name="group" />, on: inGroupDir } : { value: "", text: "No workspace", face: <Icon name="folder" />, on: !ws, title: noWsWhere },
          { divider: "" },
          ...usable.map(wsRow),
          ...(usable.length ? [{ divider: "" }] : []),
          { value: ADD_WS, text: "Add a workspace…", face: <Icon name="plus" />, title: ADD_WS_TITLE },
        ]
      : null;
  // What a menu has picked: its ticked row, else its first (as the old hidden input held).
  const valueOf = (rows: MenuRow[] | null) => (rows ? ((rows.find((r) => r.on) || rows.find((r) => "value" in r))?.value ?? "") : undefined);
  const pageValue = places.length || circles.length ? (onto ? onto.id : into ? `group:${into.id}` : "") : page ? (page === "new" ? "new" : page.id) : "";

  return {
    kind: "form" as const,
    agentId,
    bar,
    dash,
    box,
    task,
    wip,
    routine,
    page,
    group,
    canYou,
    you,
    places,
    circles,
    onto,
    into,
    pg,
    grp,
    agentGroups,
    machineGroup,
    pick,
    draft,
    tpKey,
    machine,
    folders,
    ws,
    wsRows,
    wsValue: valueOf(wsRows),
    inGroupDir,
    checkout,
    name,
    onRepo,
    branch,
    model,
    effort,
    mode,
    noWsWhere,
    pageValue,
    root: (folders && checkout?.root) || "",
    clone: folders && ws && !checkout ? ws.url || ws.repo : undefined,
  };
}
type Model = Exclude<ReturnType<typeof composeModel>, { kind: "empty" }>;

// The composer's form: the box, its buttons (pull from the cloud, attach, who can see it), the line under it naming who
// or what it brings in, the cloud box, "For task", what's attached, and the options with Start thread.
function ComposeForm({ m, onStarted }: { m: Model; onStarted?: () => void }) {
  const { agentId, bar, dash, box, task, wip, routine, page, group, canYou, you, places, circles, onto, into, pg, grp, agentGroups, machineGroup, pick, draft, ws, checkout, name, branch, model, effort, mode, pageValue } = m;
  const [text] = useDraft(draft);
  const on = useComposeUi((s) => !!s.sending[draft]);
  const cloudOpen = useComposeUi((s) => s.cloudOpen);
  const visPick = useCompose((s) => s.visPick);
  const boxRef = useRef<HTMLElement>(null);
  // A checkout the state doesn't list the branches of: they're asked of its machine, once.
  const want = checkout && !checkout.branches ? checkout : null;
  useEffect(() => {
    if (want) wantBranches(want);
  }, [want?.machine, want?.root]);

  const vis = launchVis(pick, visPick);
  const groupPicked = group?.id || pickedGroup(pageValue)?.id || null;
  const pullFrom: PullFrom = { clone: !!m.clone, root: m.root, agentId: pick, visibility: visToSend(pick, vis) };

  // The agent picks its machine too: the Agent menu lists every machine's agents, under each machine's name. A
  // task's, a worktree's or a routine's own composer keeps its picks for it alone.
  const picked = (kind: "page" | "agent" | "ws" | "branch" | "model" | "effort" | "mode", value: string) => {
    // Not a pick: what it adds is. What you add is picked here.
    if (kind === "ws" && value === ADD_WS) {
      const tid = m.tpKey;
      return openAddWs({ task: task?.id || null, machine: agentOf(pick).machine || null, onAdded: (id) => setCompose((s) => (tid ? { taskPicks: { ...s.taskPicks, [tid]: { ...s.taskPicks[tid], ws: id } } } : { wsPick: id })) });
    }
    if (kind === "mode") return setComposeMode(pick, value === mode?.def ? "" : value);
    const agent = pick;
    setCompose((s) => {
      const next: Partial<ComposePicks> = {};
      let taskPicks = s.taskPicks;
      const tid = m.tpKey;
      if (kind === "page") next.pagePick = value;
      if (tid && (kind === "agent" || kind === "ws")) taskPicks = { ...taskPicks, [tid]: { ...taskPicks[tid], [kind]: value } };
      else if (kind === "agent") next.agentPick = value;
      else if (kind === "ws") next.wsPick = value;
      if (kind === "branch") next.branchPick = { ...s.branchPick, [m.root]: value };
      if (kind === "model") next.modelPick = { ...s.modelPick, [agent]: value };
      if (kind === "effort") next.effortPick = { ...s.effortPick, [agent]: value };
      if (taskPicks !== s.taskPicks) next.taskPicks = taskPicks;
      return next;
    });
  };

  const boxEl = () => boxRef.current as AbBox | null;
  // The box, ready to type in again, when there's nothing to send.
  const refocus = () => boxEl()?.focus();
  // Sent: out of the box, if nothing was written in it since.
  const blurIfEmpty = () => {
    const b = boxEl();
    if (b && document.activeElement === b && !b.value.trim()) b.blur();
  };

  // A thread of yours, the composer with You picked: the agents it names join it.
  const startYours = async () => {
    if (useComposeUi.getState().sending[draft]) return;
    const typed = getDraft(draft).trim();
    if (!typed) return refocus();
    const workspace = m.wsValue || undefined;
    const staged = takeStaged("launch");
    sending(draft, true);
    setDraft(draft, "");
    let ok = false;
    try {
      ok = await startTalk(typed, staged, { workspace, visibility: vis });
      if (ok) {
        blurIfEmpty();
        setCompose(workspace != null ? { wsPick: workspace } : {});
      }
    } finally {
      sending(draft, false);
      if (!ok) {
        putBack(draft, typed);
        putBackStaged("launch", staged);
      }
    }
  };

  // Start thread: what's written (or, on a task's page, the task as it's written) goes to the agent picked, where and
  // how it's picked to run. The box empties at once, and gets it back if it didn't start.
  const start = async () => {
    if (you) return startYours();
    if (useComposeUi.getState().sending[draft]) return;
    // A task's own box, on its page: left empty, it sends the task as it's written.
    const onTask = task;
    const typed = getDraft(draft).trim();
    const prompt = typed || (onTask ? taskPrompt(onTask) : "");
    if (!prompt) return refocus();
    const agentIdNow = pick;
    const visibility = visToSend(agentIdNow, vis);
    const modelV = model ? model.pick || undefined : undefined;
    const effortV = effort ? effort.pick || undefined : undefined;
    const modeV = mode?.pick;
    // On a branch's or a pull request's page: it starts there, with the agent, model and effort picked there, and
    // what's attached. The agent picked stays picked there.
    if (wip) {
      const w = wipById(wip.id);
      if (!w) return;
      const extra: { agent: string; model?: string; effort?: string; mode?: string; visibility?: string; files?: string[] } = { agent: agentIdNow, model: modelV, effort: effortV, mode: modeV, visibility };
      const staged = takeStaged("launch");
      sending(draft, true);
      setDraft(draft, "");
      let ok = false;
      try {
        extra.files = await sendStaged(staged, null, agentOf(agentIdNow).machine || undefined);
        const r = await (w.kind === "pr" ? prLaunch : wipLaunch)(w, saidWith(prompt, staged), extra);
        ok = r.ok;
        if (r.ok) {
          setCompose((s) => ({ taskPicks: { ...s.taskPicks, [`wip:${w.id}`]: { agent: agentIdNow } } }));
          blurIfEmpty();
          onStarted?.();
        }
      } catch (err) {
        toast(err.message);
      } finally {
        sending(draft, false);
        if (!ok) {
          putBack(draft, prompt);
          putBackStaged("launch", staged);
        }
      }
      return;
    }
    const clone = m.clone;
    // A thread in a group: started from the group's page, or with a group picked as where it goes. In the group's
    // folder, it needs no other.
    const where = pageValue;
    // A group or tasks it names (@group:<id>, @task:<id>): it starts in the group, unless one's picked, and goes on the tasks.
    const groupNamedIn = [...prompt.matchAll(GROUP_MENTION)].map((x) => groupNamed(x[2])).find((g) => g && groupIn(g) && !g.archived);
    const tasksNamedIn = [...new Set([...prompt.matchAll(TASK_MENTION)].map((x) => x[2]))].map(taskNamed).filter(Boolean);
    const groupId = group?.id || pickedGroup(where)?.id || groupNamedIn?.id || undefined;
    const groupDir = !!groupId && m.wsValue === "~group";
    const root = clone || groupDir ? "" : m.root;
    const machine = agentOf(agentIdNow).machine || undefined;
    const pickedBranch = branch ? branch.pick.value : "";
    const wsNow = m.wsValue;
    // A post for a page: its agent is told which page, and contributes to it. A page's own composer is only for
    // it; the others pick your feed ("") or a page you follow.
    const pageId = (!pickedGroup(where) && where) || undefined;
    const own = !!pageId && !!page;
    // A thread on a routine, from its page: its agent is told which (routine-threads.ts), and the page lists it.
    const onRoutine = routine ? { [routine.mine ? "on_my_routine" : "on_routine"]: routine.job } : null;
    // A post for a task (not from a page's own composer, or a routine's): its agent is told which task it's for.
    const forTask = onTask ? onTask.id : own || onRoutine ? null : useSendTask.getState().forTask;
    const taskText = (forTask && taskById(forTask)?.text) || undefined;
    // It's on its way: the box is empty for the next one.
    const staged = takeStaged("launch");
    sending(draft, true);
    setDraft(draft, "");
    if (forTask && !onTask) useSendTask.setState({ forTask: null });
    let ok = false;
    try {
      const files = await sendStaged(staged, null, machine);
      // A new dashboard: the agent is told it's one, and how they're made.
      const dashNew = pageId === "new" && dash;
      const asked = dashNew ? `Make a dashboard (ab_dashboard_write): find what my connectors can answer with ab_source, try each query, then save it. It should show: ${prompt}` : prompt;
      const r = await post<{ cloning?: boolean; making?: boolean; branch?: string }>("/api/launch", { prompt: saidWith(asked, staged), root, clone, repo: m.onRepo || undefined, agent: agentIdNow, files, machine, model: modelV, effort: effortV, mode: modeV, visibility, task: taskText, page: pageId, group: groupId, ...onRoutine, ...(clone || groupDir ? {} : branchRequest(pickedBranch)) });
      ok = r.ok;
      if (r.ok) {
        if (r.data.queued) toast(waits(r.data, "it starts"));
        // A post for a task: the task follows the session it starts.
        if (forTask && r.data.lid) void post(`/api/tasks/${encodeURIComponent(forTask)}/send`, { launch: r.data.lid, agent: agentIdNow });
        blurIfEmpty();
        // The agent and workspace it went out with, even when the composer picked them for you; a task's, for it.
        if (onTask) setCompose((s) => ({ taskPicks: { ...s.taskPicks, [onTask.id]: { agent: agentIdNow, ws: wsNow ?? null } } }));
        else if (routine) setCompose((s) => ({ taskPicks: { ...s.taskPicks, [`routine:${routine.key}`]: { agent: agentIdNow, ws: wsNow ?? null } } }));
        else setCompose({ agentPick: agentIdNow, ...(wsNow != null && !(groupDir && !group) ? { wsPick: wsNow } : {}) });
        const who = agentName(agentIdNow) || "Claude";
        const onTasks = tasksNamedIn.length ? `, on ${tasksNamedIn.map((t) => `“${t.text.length > 60 ? `${t.text.slice(0, 59)}…` : t.text}”`).join(" and ")}` : "";
        const route = getApp().route;
        if (pageId === "new") toast(`Started. ${who} is making the ${dashNew ? "dashboard" : "page"}; it shows up here once it's made.`);
        else if (pageId && route.name === "page" && route.id === pageId) location.hash = barHref({ id: pageId }, `launch:${r.data.lid}`);
        else if (own) toast(`Started. ${who} is on it, in a thread beside the page.`);
        // From a routine's page it stays there: the thread shows up under Threads on it, starting.
        else if (onRoutine) {
          toast(`Started. ${who} is on it, in a thread on the routine.`);
          if (route.name === "myroutine") bumpRoutines();
        } else if (pageId) toast(`Started. ${who} is on it, in a thread on ${pageById(pageId)?.title || "the page"}.`);
        // From the group's page it stays there: the thread shows up in its timeline, starting.
        else if (groupId) toast(`Started. ${who} is on it in ${groupById(groupId)?.name || "the group"}${onTasks}, told its brief and who else is there.`);
        else toast(r.data.cloning ? "It's cloned first, then it starts." : r.data.making ? `Its worktree is made first, on ${r.data.branch}, then it starts.` : `Started. ${who} is on it${onTasks}${r.data.branch && pickedBranch ? `, on ${r.data.branch}` : ""}.`);
        onStarted?.();
        // From an agent's page, or a task's, it stays there: the thread shows up on it, starting.
        if (!["feed", "group", "agent", "task", "routine", "myroutine"].includes(route.name) && !own) go(scopeHref("feed", route.scope || NO_SCOPE));
      }
    } catch (err) {
      toast(err.message);
    } finally {
      sending(draft, false);
      if (!ok) {
        if (typed) putBack(draft, prompt);
        putBackStaged("launch", staged);
        if (forTask && !onTask && !useSendTask.getState().forTask) useSendTask.setState({ forTask });
      }
    }
  };

  const named = agentOf(pick).name;
  const who = you ? (
    <>
      <YouAvatar size="av--xs" />
      <span className="opt-v opt-v--strong">You</span>
    </>
  ) : (
    <>
      <Avatar agent={pick} size="av--xs" />
      <span className="opt-v opt-v--strong">{named || name}</span>
      {machineGroup?.machine ? <span className="opt-sub">@ {machineGroup.machine}</span> : null}
    </>
  );
  // The branch it works on, said rather than picked: its worktree, or the pull request's.
  const wipAt = wip ? (wip.kind === "pr" ? prPlace(wip) : wip) : null;
  const onWip = wip ? (
    <span key="wip" className="opt opt--static" title={wip.kind === "pr" ? `On #${wip.number}'s branch, ${wip.branch}, on ${wipAt?.machine}` : `On ${wip.branch}, in ${tildeOn(wip.machine, wip.worktree || wip.root || "")}`}>
      <Icon name={wip.kind === "pr" ? "pr" : "branch"} />
      <span className="opt-v">{wip.kind === "pr" ? `#${wip.number}` : wip.branch}</span>
    </span>
  ) : null;
  const branchRows = (list: LaunchItem[]): MenuRow[] => list.map((i) => ({ value: i.value, text: i.text, face: <Icon name={i.tree ? "worktree" : "branch"} />, title: i.title, on: i === branch?.pick }));
  const branchGroup = (label: string, list: LaunchItem[]): MenuRow[] => (list.length ? [{ divider: label }, ...branchRows(list)] : []);
  const agentRows: MenuRow[] = [
    ...(canYou ? [{ value: "~you", text: "You", face: <YouAvatar size="av--xs" />, on: you, title: "A thread of yours: the agents you @ in it join it" }] : []),
    ...agentGroups.flatMap((g) => [
      ...(agentGroups.length > 1 || canYou ? [{ divider: g.machine || "Cloud" }] : []),
      ...g.agents.map((a) => ({ value: a.id, text: a.name, face: <Avatar agent={a.id} size="av--xs" />, note: a.machine_off ? "offline" : a.host && a.host !== a.machine ? a.host : "", title: agentName(a.id), on: a.id === pick })),
    ]),
  ];
  const ws_ = ws;
  const line: ReactNode[] = [
    <MenuPick
      key="agent"
      id={`${draft}:agent`}
      label="Agent"
      title={you ? "A thread of yours: the agents you @ in it join it" : agentName(pick)}
      face={who}
      rows={agentRows}
      set={you}
      onPick={(v) => picked("agent", v)}
    />,
    pair(
      "model-options",
      null,
      model && (
        <MenuPick
          key="model"
          id={`${draft}:model`}
          label="Model"
          face={<span className="opt-v opt-v--strong">{model.shown}</span>}
          rows={model.rows}
          set={!!model.pick}
          onPick={(v) => picked("model", v)}
        />
      ),
      effort && (
        <MenuPick
          key="effort"
          id={`${draft}:effort`}
          label="Effort"
          title={`Effort: ${effort.shown}`}
          face={
            effort.at >= 0 ? (
              <EffortMeter levels={effort.levels} at={effort.at} />
            ) : (
              <>
                <Icon name="gauge" />
                <span className="opt-v">{effort.shown}</span>
              </>
            )
          }
          rows={effort.rows}
          set={!!effort.pick}
          onPick={(v) => picked("effort", v)}
        />
      ),
    ),
    // Where it works: one picker, with every workspace it can use, repos and folders together, whoever's picked, under
    // No workspace (in a group, its own folder). Its last row adds one, in a box over the page, and picks it.
    pair(
      "workspace",
      <span className="opt-slash" aria-hidden="true">/</span>,
      m.wsRows && (
        <MenuPick
          key="ws"
          id={`${draft}:ws`}
          label="Workspace"
          title={you && ws_ ? `The agents you @ work in ${ws_.name}, on their machines` : m.onRepo ? `${name} clones ${repoName(m.onRepo)} where it runs` : ws_ ? (checkout ? wsWhere(ws_) : cloneTitle(ws_, m.machine)) : m.inGroupDir ? "The group's own folder" : m.noWsWhere}
          face={
            <>
              <Icon name={ws_?.repo ? "repo" : m.inGroupDir ? "group" : "folder"} />
              <span className="opt-v opt-v--strong">{ws_ ? `${ws_.name}${checkout || !m.folders ? "" : " (clone)"}` : m.inGroupDir ? "The group's folder" : "No workspace"}</span>
            </>
          }
          rows={m.wsRows}
          onPick={(v) => picked("ws", v)}
        />
      ),
      branch && (
        <MenuPick
          key="branch"
          id={`${draft}:branch`}
          label="Branch"
          title={branch.pick.title}
          face={
            <>
              <Icon name={branch.pick.tree ? "worktree" : "branch"} />
              <span className="opt-v">{branch.pick.value === "tree" ? "new" : branch.pick.face}</span>
            </>
          }
          rows={[...branchRows(branch.items), ...branchGroup("In progress", branch.wip), ...branchGroup(branch.wip.length ? "Other existing branches" : "Existing branches", branch.rest)]}
          set={branch.pick.value !== ""}
          onPick={(v) => picked("branch", v)}
        />
      ),
    ),
    onWip,
    (places.length || circles.length) && (
      <MenuPick
        key="page"
        id={`${draft}:page`}
        label="Where it goes"
        title={onto ? `On ${onto.title}: its agent is told it's about the page, and keeps it` : into ? `In ${into.name}: it's told the group's brief and the others in it, and shares its files` : "On your feed. Pick a page you follow, or a group, to start it there"}
        face={
          onto ? (
            <>
              <PgIco p={onto} />
              <span className="opt-v">{onto.title}</span>
            </>
          ) : into ? (
            <>
              <GrIco g={into} />
              <span className="opt-v">{into.name}</span>
            </>
          ) : (
            <>
              <Icon name="home" />
              <span className="opt-v">Feed</span>
            </>
          )
        }
        rows={[
          { value: "", text: "Your feed", face: <Icon name="home" />, on: !onto && !into },
          ...(places.length ? [{ divider: "Pages you follow" }, ...places.map(({ page: p, why }) => ({ value: p.id, text: p.title, face: <PgIco p={p} />, on: p === onto, off: !!why, note: why && "offline", title: why }))] : []),
          ...(circles.length ? [{ divider: "Groups" }, ...circles.map((g) => ({ value: `group:${g.id}`, text: g.name, face: <GrIco g={g} />, on: g === into }))] : []),
        ]}
        set={!!onto || !!into}
        onPick={(v) => picked("page", v)}
      />
    ),
    mode && (
      <MenuPick
        key="mode"
        id={`${draft}:mode`}
        label="Mode"
        title={mode.full ? "Full access · never asks: runs commands and edits without asking you" : "Mode: how much it does without asking you"}
        cls={mode.full ? "pk--full" : ""}
        face={
          <>
            <Icon name="hand" />
            <span className="opt-v">{mode.shown}</span>
          </>
        }
        rows={mode.rows}
        set={mode.pick !== mode.def}
        onPick={(v) => picked("mode", v)}
      />
    ),
  ].filter(Boolean);

  // Who can see the new post, as the corner of its box (visButton): kept per agent like its other picks. A thread of
  // yours is no agent's: there's no private agent to keep out of it.
  const a = agentOf(pick);
  const hides = !you && a.visibility !== "public";
  const words = {
    private: "only you will see it",
    public: `your contacts will see it${hides ? `, though not that ${a.name} wrote it, since ${a.name} is private` : ""}`,
  };
  const placeholder =
    box ||
    (task
      ? "Start a thread on it… (empty sends the task as written)"
      : you
        ? "Write something, or @ an agent to bring it in…"
        : page === "new"
          ? dash
            ? "What should a dashboard show? “Checkout latency and errors by service, from Datadog”…"
            : "What should a page keep track of? An agent makes it, and keeps it up to date…"
          : grp
            ? bar
              ? "What should it work on?"
              : `What should ${grp.name} work on?`
            : bar
              ? "Ask about it, or @ a widget…"
              : pg && pg !== "new"
                ? `Ask about ${pg.title}, or @ one of its widgets…`
                : routine
                  ? routine.mine
                    ? `Ask an agent to change ${routine.name || "it"}, or about it…`
                    : `Ask ${agentOf(routine.agent).name} to change it, or about it…`
                  : agentId
                    ? `Give ${name} something to do…`
                    : "What should your agents work on?");
  // The line under the box: who a thread of yours brings in, or where naming a task or a group puts an agent's thread.
  const hint = toHintText(null, text, { talk: you, picked: groupPicked });
  const machineOff = agentOf(pick).machine_off;
  const offMachine = m.machine;
  const plain = !pg && !grp && !you && !task && !wip && !routine;

  return (
    <section className="card compose compose--rail">
      <form
        data-launch=""
        data-task={task?.id}
        data-wip={wip?.id}
        data-routine={routine?.job}
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="compose-row">
          <YouAvatar size="" />
          <div className="text-box">
            <MsgBox
              draft={draft}
              placeholder={placeholder}
              label={you ? "What you write" : pg && pg !== "new" ? "What to ask about it or change" : "What the agent should do"}
              page={pageValue && pageValue !== "new" && !pageValue.startsWith("group:") ? pageValue : undefined}
              onSend={() => void start()}
              boxRef={boxRef}
              links={!you}
              agentRows={you ? (w) => talkRows(null, w, true) : undefined}
              stageKey="launch"
            />
            {!page && plain ? (
              <button
                className={`icon-btn${cloudOpen ? " is-on" : ""}`}
                type="button"
                aria-expanded={cloudOpen}
                aria-label="Pull from the cloud"
                title="Pull from the cloud: a claude.ai/code or Codex Cloud link"
                onClick={() => setComposeUi({ cloudOpen: !cloudOpen })}
              >
                <Icon name="cloud" />
              </button>
            ) : null}
            <button className="icon-btn" type="button" aria-label="Attach files" title="Attach files" onClick={() => pickFile((files) => stage("launch", files), true)}>
              <Icon name="clip" />
            </button>
            <VisCorner kind="launch" id={pick} level={vis} words={words} cls=" vis-corner--box" onPick={(lv) => setCompose((s) => ({ visPick: { ...s.visPick, [pick]: lv } }))} />
            <button className="compose-send" type="submit" data-start="" disabled={on} aria-label={on ? "Starting…" : "Start thread"} title={on ? "Starting…" : "Start thread"}>
              <Icon name="arrowUp" />
            </button>
          </div>
        </div>
        <p className="to-hint compose-hint" hidden={!hint}>
          {hint}
        </p>
        {cloudOpen && plain ? <CloudBox project={checkout ? ws.name : ""} from={pullFrom} /> : null}
        {page || task || wip || routine ? null : <ForTaskChip />}
        <StagedChips draftKey="launch" />
        {machineOff ? (
          <p className="compose-note muted">
            <Icon name="pause" />
            <a href={`#/machines/${encodeURIComponent(offMachine)}`}>{offMachine}</a> is off: {cloudOf(offMachine) ? "agentbook wakes it in its sandbox for this." : "this starts when it's back, if that's within an hour."}
          </p>
        ) : null}
        {line.length ? (
          <div className="compose-bar">
            <div className="compose-opts">
              <div className="launch-opts" role="group" aria-label="Where it goes, and where and how it runs">
                {line}
              </div>
            </div>
          </div>
        ) : null}
      </form>
    </section>
  );
}
