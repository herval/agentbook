// The Tasks card in the feed's right column (and a workspace's page, `own`). A feed narrowed to workspaces shows
// their tasks, and the ones that aren't in any; narrowed to pages, the ones on them, or from their threads, as Tasks
// does; a workspace's page (`own`), just its own.
import { useEffect, useRef } from "react";
import { setDraft, useDraft } from "../lib/hooks.ts";
import { NO_SCOPE, scopeHref, useRoute } from "../lib/route.ts";
import { useApp } from "../lib/store.ts";
import type { TaskRow } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";
import { TaskPicks, TaskRowItem } from "./tasks/TaskRow.tsx";
import { addTask, doneTasks, oneOf, openTasks, pageById, SCOPED, setUi, taskGroups, tasksLens, useTasksUi } from "./tasks/tasks.ts";

const TASKS_SHOWN = 8;

// The box for a new task opens from the + and sits on top of the list. It stays while it holds something you
// haven't added. On a feed picked to a workspace, the task starts out as that workspace's; picked to a page, it
// goes on that page, and to a group, in that group, so it stays in view. Esc, or Enter with nothing in it, closes
// it; a click away from it, empty, does too.
function TaskAdd({ page, ws, agent, group }: { page: { id: string; title: string } | null; ws: string | null; agent: string | null; group: string | null }) {
  const [text, setText] = useDraft("task-new");
  const [wsD, setWs] = useDraft("task-new-ws");
  const [agentD, setAgent] = useDraft("task-new-agent");
  const [groupD, setGroup] = useDraft("task-new-group");
  const input = useRef<HTMLInputElement>(null);
  // A pick of "~" is none, over what the feed is narrowed to.
  const v = (d: string, fallback: string | null) => (d ? (d === "~" ? "" : d) : fallback || "");
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!useTasksUi.getState().taskNew || input.current?.value || (e.target as HTMLElement)?.closest?.(".task-add, [data-task-new]")) return;
      setUi({ taskNew: false });
    };
    document.addEventListener("click", away);
    return () => document.removeEventListener("click", away);
  }, []);
  const submit = async () => {
    const t = text.trim();
    if (!t) {
      setUi({ taskNew: false });
      return input.current?.blur();
    }
    await addTask("task-new", { text: t, page: page?.id || null, group: v(groupD, group) || null, workspace: v(wsD, ws) || null, agent: v(agentD, agent) || null });
  };
  return (
    <form className="task-add" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <span className="tick-box" aria-hidden="true" />
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          setText("");
          setUi({ taskNew: false });
          e.currentTarget.blur();
        }}
        placeholder={page ? `New task on ${page.title}` : "New task"}
        maxLength={500}
        aria-label="New task"
        autoComplete="off"
      />
      <TaskPicks ws={v(wsD, ws)} agent={v(agentD, agent)} group={v(groupD, group)} set={(k, x) => ({ ws: setWs, agent: setAgent, group: setGroup })[k](x || "~")} />
    </form>
  );
}

export function TasksCard({ own = null }: { own?: string | null }) {
  useApp((s) => s.data);
  useApp((s) => s.rows);
  const route = useRoute();
  const ui = useTasksUi();
  const [draft] = useDraft("task-new");
  const scoped = !!SCOPED[route.name];
  const scope = scoped ? route.scope || NO_SCOPE : NO_SCOPE;
  const ws = own ? [own] : scope.workspace;
  const pages = own ? [] : scope.page;
  const groups = own ? [] : scope.group;
  const inWs = (t: TaskRow) => !ws.length || (!own && !t.workspace) || ws.includes(t.workspace);
  const onPages = (t: TaskRow) => (!pages.length || tasksLens.of.page(t).some((p) => pages.includes(p))) && (!groups.length || tasksLens.of.group(t).some((x) => groups.includes(x)));
  const shown = (t: TaskRow) => inWs(t) && onPages(t);
  const all = own ? `#/tasks?workspace=${encodeURIComponent(own)}` : scopeHref("tasks");
  const mine = openTasks();
  const rows = mine.filter(shown);
  const elsewhere = own ? 0 : mine.filter((t) => !t.done && !shown(t)).length;
  const today = doneTasks().filter((t) => new Date(t.done_at).toDateString() === new Date().toDateString() && (!own || inWs(t)) && onPages(t));
  const away = groups.length ? (ws.length || pages.length ? "elsewhere" : "not in this group") : !pages.length ? "in other workspaces" : ws.length ? "elsewhere" : pages.length > 1 ? "not on these pages" : "not on this page";
  const adding = ui.taskNew || !!draft;
  // A new one goes where the feed is narrowed to: its page, its group, its workspace (or this workspace's own).
  const addPage = scoped && oneOf(scope, "page") ? pageById(oneOf(scope, "page")) : null;
  const addGroup = taskGroups().find((g) => scoped && g.id === oneOf(scope, "group"))?.id || null;
  const addWs = route.name === "workspace" ? route.id : scoped ? oneOf(scope, "workspace") : null;
  const addAgent = scoped ? oneOf(scope, "agent") : null;
  // The + opens the box for a new task, or closes it when it's empty.
  const plus = () => {
    const was = adding;
    const on = !(was && !draft);
    if (on && !was) for (const k of ["task-new-ws", "task-new-agent", "task-new-group"]) setDraft(k, "");
    setUi({ taskNew: on });
  };
  return (
    <section className="card rail-card tasks" id="tasks">
      <h3 className="rail-h">
        <a className="rail-t" href={all}>
          Tasks
        </a>
        <span className="rail-acts">
          <a href={all}>See all</a>
          <button className="icon-btn" type="button" data-task-new aria-label="New task" title="New task" onClick={plus}>
            <Icon name="plus" />
          </button>
        </span>
      </h3>
      {adding ? <TaskAdd page={addPage} ws={addWs} agent={addAgent} group={addGroup} /> : null}
      {rows.length ? (
        <ul className="task-list">
          {rows.slice(0, TASKS_SHOWN).map((t) => (
            <TaskRowItem key={t.id} t={t} chip={ws.length !== 1} short on={pages.length === 1 ? pages[0] : null} />
          ))}
        </ul>
      ) : adding ? null : (
        <p className="muted rail-empty">{own ? "No tasks in it." : groups.length ? "No tasks in this group." : pages.length ? `No tasks on ${pages.length > 1 ? "these pages" : "this page"}.` : "Nothing on your list."}</p>
      )}
      {rows.length > TASKS_SHOWN || elsewhere || today.length ? (
        <div className="tasks-foot">
          {rows.length > TASKS_SHOWN ? <a href={all}>and {rows.length - TASKS_SHOWN} more</a> : null}
          {elsewhere ? (
            <a href={scopeHref("tasks", NO_SCOPE)}>
              {elsewhere} {away}
            </a>
          ) : null}
          {today.length ? (
            <button type="button" aria-expanded={ui.tasksDone} onClick={() => setUi({ tasksDone: !ui.tasksDone })}>
              {today.length} done today
            </button>
          ) : null}
        </div>
      ) : null}
      {ui.tasksDone && today.length ? (
        <ul className="task-list task-list--done">
          {today.map((t) => (
            <TaskRowItem key={t.id} t={t} short list={false} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
