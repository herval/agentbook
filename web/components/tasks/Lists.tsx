// Tasks where other screens show them: a page's checklist (PageTasks) and the composer's "For task" chip
// (ForTaskChip). A thread's to-dos and tasks are the thread's own (components/thread/Actions.tsx).
import { useDraft } from "../../lib/hooks.ts";
import { useApp } from "../../lib/store.ts";
import type { PageRow, TaskRow } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { TaskRowItem } from "./TaskRow.tsx";
import { addTask, setUi, taskById, taskPageIds, ticked, useSendTask, useTasksUi } from "./tasks.ts";

// A page's checklist is your tasks on it, from your Tasks list: ticked here or there alike. Its agents write them
// (ab_page_write), and you add, tick, edit, send and reorder them here as on your list. A new one goes on top of
// your list, so on top of the page's too. Someone else's page shows that its tasks are its owner's.
export function PageTasks({ p }: { p: PageRow }) {
  const data = useApp((s) => s.data);
  const shown = useTasksUi((s) => s.pageTasksDone.has(p.id));
  useTasksUi((s) => s.justDone);
  const key = `page-task-${p.id}`;
  const [text, setText] = useDraft(key);
  if (!p.mine) return <p className="muted">Its tasks are on {p.owner ? `@${p.owner}'s` : "its owner's"} Tasks list.</p>;
  const on = ((data?.tasks || []) as TaskRow[]).filter((t) => taskPageIds(t).includes(p.id));
  const open = on.filter(ticked).sort((a, b) => a.rank - b.rank);
  const done = on.filter((t) => !ticked(t)).sort((a, b) => b.done_at.localeCompare(a.done_at));
  const toggle = () => {
    const next = new Set(useTasksUi.getState().pageTasksDone);
    next.has(p.id) ? next.delete(p.id) : next.add(p.id);
    setUi({ pageTasksDone: next });
  };
  return (
    <>
      {p.archived ? null : (
        <form className="task-add" onSubmit={(e) => (e.preventDefault(), text.trim() ? void addTask(key, { text: text.trim(), page: p.id }) : (e.currentTarget.querySelector("input")?.blur()))}>
          <span className="tick-box" aria-hidden="true" />
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setText(""), e.currentTarget.blur())} placeholder="Add a task" maxLength={500} aria-label="Add a task" autoComplete="off" />
        </form>
      )}
      {open.length ? (
        <ul className="task-list">
          {open.map((t) => (
            <TaskRowItem key={t.id} t={t} chip={false} cut={240} short page={false} />
          ))}
        </ul>
      ) : (
        <p className="muted wg-tasks-empty">{done.length ? "All done." : "Nothing to do yet."}</p>
      )}
      {done.length ? (
        <div className="tasks-foot">
          <button type="button" aria-expanded={shown} onClick={toggle}>
            {done.length} done
          </button>
          <a href="#/tasks">Your Tasks</a>
        </div>
      ) : null}
      {shown && done.length ? (
        <ul className="task-list task-list--done">
          {done.map((t) => (
            <TaskRowItem key={t.id} t={t} chip={false} cut={240} short page={false} list={false} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

// The composer, when its post is for a task: "For task: …", and × to make it not.
export function ForTaskChip() {
  const id = useSendTask((s) => s.forTask);
  useApp((s) => s.data?.tasks);
  const t = taskById(id);
  if (!t) return null;
  return (
    <div className="for-task">
      <span className="chip">
        <Icon name="tasks" />
        <span>
          For task: <b>{t.text}</b>
        </span>
        <button type="button" aria-label="Not for this task" title="Not for this task" onClick={() => useSendTask.setState({ forTask: null })}>
          <Icon name="x" />
        </button>
      </span>
    </div>
  );
}
