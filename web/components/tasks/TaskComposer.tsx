// The Tasks page's box for a new task, on top of the list and the board alike: the feed's composer, for a task, and
// N gets you there. Its first line is the task's title, the rest its body (Shift+Enter for a new line). Under it,
// the composer's menus: where it goes (your Tasks, a page of yours, or a group), who it's for and in which
// workspace. Add task (or Enter) puts it on top of your list, and the box is ready for the next, with the same
// picks. On Tasks narrowed to a page or a group it starts out going there, and to a workspace or an agent, as theirs.
import { useState } from "react";
import { agentName, workspaces } from "../../lib/agents.ts";
import { getDraft, useDraft } from "../../lib/hooks.ts";
import { useApp } from "../../lib/store.ts";
import type { Scope } from "../../lib/types.ts";
import { Avatar, YouAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import { MsgBox } from "../MsgBox.tsx";
import { GrIco, PgIco } from "./Chips.tsx";
import { TaskPickFace } from "./TaskRow.tsx";
import { addTask, groupById, oneOf, pageById, taskAgents, taskGroups } from "./tasks.ts";

const pickedGroup = (pick: string) => (String(pick || "").startsWith("group:") ? groupById(pick.slice(6)) : null);

// The new task's box. `scope`: what the bar narrows Tasks to.
export function TaskComposer({ scope }: { scope: Scope }) {
  const data = useApp((s) => s.data);
  const [whereD, setWhere] = useDraft("task-compose-where");
  const [wsD, setWs] = useDraft("task-compose-ws");
  const [agentD, setAgent] = useDraft("task-compose-agent");
  const [sending, setSending] = useState(false);
  const spg = oneOf(scope, "page") ? pageById(oneOf(scope, "page")) : null;
  const sgr = taskGroups().find((g) => g.id === oneOf(scope, "group"))?.id || null;
  // A draft of "~" is a pick of none, over what the bar narrows to.
  const where = whereD ? (whereD === "~" ? "" : whereD) : spg ? spg.id : sgr ? `group:${sgr}` : "";
  const ws = wsD ? (wsD === "~" ? "" : wsD) : oneOf(scope, "workspace") || "";
  const agent = agentD ? (agentD === "~" ? "" : agentD) : oneOf(scope, "agent") || "";
  const at = (p) => p.moved || p.updated || "";
  const pages = (data?.pages || []).filter((p) => p.mine && !p.archived).sort((a, b) => at(b).localeCompare(at(a)));
  const groups = taskGroups().filter((g) => !g.archived);
  const gr = pickedGroup(where);
  const pg = !gr && where ? pageById(where) : null;
  const wss = workspaces();
  // Its first line is the task's title, the rest its body (the server splits them). It goes on top, and the box is
  // empty for the next one, with the same picks. If it didn't go, what was in it comes back.
  const send = async (raw: string) => {
    const text = (raw ?? getDraft("task-compose")).trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await addTask("task-compose", { text, page: !gr && where ? where : null, group: gr?.id || null, workspace: ws || null, agent: agent || null });
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="card compose compose--task-new">
      <form onSubmit={(e) => (e.preventDefault(), void send(getDraft("task-compose")))}>
        <div className="compose-row">
          <YouAvatar size="" />
          <div className="text-box">
            <MsgBox draft="task-compose" placeholder={pg ? `What needs doing on ${pg.title}?` : gr ? `What needs doing in ${gr.name}?` : "What needs doing? Its first line is its title…"} label="The task: its first line is its title, the rest its body" onSend={(t) => void send(t)} />
          </div>
        </div>
        <div className="compose-bar">
          <div className="compose-opts">
            <div className="launch-opts" role="group" aria-label="Where it goes, and who it's for">
              <MenuPick
                id="task-compose:where"
                label="Where it goes"
                title={pg ? `On ${pg.title}: the page lists it with its tasks` : gr ? `In ${gr.name}: its threads are told about it` : "On your Tasks. Pick a page or a group to put it there too"}
                face={
                  pg ? (
                    <>
                      <PgIco p={pg} />
                      <span className="opt-v">{pg.title}</span>
                    </>
                  ) : gr ? (
                    <>
                      <GrIco g={gr} />
                      <span className="opt-v">{gr.name}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="tasks" />
                      <span className="opt-v">Tasks</span>
                    </>
                  )
                }
                rows={[
                  { value: "", text: "Your Tasks", face: <Icon name="tasks" />, on: !pg && !gr },
                  ...(pages.length ? [{ divider: "Pages" }, ...pages.map((p) => ({ value: p.id, text: p.title, face: <PgIco p={p} />, on: p === pg }))] : []),
                  ...(groups.length ? [{ divider: "Groups" }, ...groups.map((g) => ({ value: `group:${g.id}`, text: g.name, face: <GrIco g={g} />, on: g === gr }))] : []),
                ]}
                set={!!(pg || gr)}
                onPick={(v) => setWhere(v || "~")}
              />
              <MenuPick
                id="task-compose:agent"
                label="Agent"
                title={agent ? `For ${agentName(agent)}: sending it goes to ${agentName(agent)}` : "For any agent: you pick one when you send it"}
                face={<TaskPickFace kind="agent" id={agent || null} />}
                rows={[{ value: "", text: "Any agent", face: <Icon name="bot" />, on: !agent }, { divider: "" }, ...taskAgents(agent || null).map((a) => ({ value: a.id, text: agentName(a.id), face: <Avatar agent={a.id} size="av--xs" />, note: a.offline ? "offline" : "", on: a.id === agent }))]}
                set={!!agent}
                onPick={(v) => setAgent(v || "~")}
              />
              <MenuPick
                id="task-compose:ws"
                label="Workspace"
                title={ws ? `In ${wss.find((w) => w.id === ws)?.name || "its workspace"}: sending it starts there` : "In no workspace"}
                face={<TaskPickFace kind="ws" id={ws || null} />}
                rows={[{ value: "", text: "No workspace", face: <Icon name="folder" />, on: !ws }, ...(wss.length ? [{ divider: "" }] : []), ...wss.map((w) => ({ value: w.id, text: w.name, face: <Icon name={w.repo ? "repo" : "folder"} />, on: w.id === ws }))]}
                set={!!ws}
                onPick={(v) => setWs(v || "~")}
              />
            </div>
          </div>
          <button className="btn btn--dark" type="submit" disabled={sending}>
            Add task
          </button>
        </div>
      </form>
    </section>
  );
}
