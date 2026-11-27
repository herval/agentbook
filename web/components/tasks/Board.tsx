// The Tasks board: the filter bar's statuses as columns, To do, With an agent and Done. Drag a task to With an agent
// to send it, to Done to tick it off, and a done one back to To do; in To do, drag one to a new place. What needs
// you comes first in With an agent, yellow, with its question. Done has the last week's.
import type { DragEvent, ReactNode } from "react";
import { create } from "zustand";
import { agentName } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { ago, plural } from "../../lib/format.ts";
import { go, scopeHref, taskHref, threadHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { Scope, TaskRow } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { TaskCorner } from "../Visibility.tsx";
import { sessionById } from "../worktrees/wips.ts";
import { ShipStrip } from "./Ship.tsx";
import { TaskEditForm, TaskFaces, TaskMark, TaskState, TaskTick, TaskWhere } from "./TaskRow.tsx";
import { inScope, me, moveTask, openTasks, sendTask, sentOn, setUi, taskById, taskGoing, taskMine, tasksLens, tickTask, useTasksUi } from "./tasks.ts";

const BOARD_WEEK = 7 * 864e5;
export const boardLane = (t: TaskRow) => (t.done ? "done" : sentOn(t) ? "with" : "todo");
// Where a card can go from its lane: one with a thread on it can only go to Done (its thread has it).
const BOARD_MOVES = { todo: ["todo", "with", "done"], with: ["done"], done: ["todo"] };
// Someone else's task goes to no other column but With an agent: moving it in or out of Done ticks it, which only its
// owner does.
const laneOk = (t: TaskRow | undefined, to: string) => !!t && BOARD_MOVES[boardLane(t)].includes(to) && (taskMine(t) || to === boardLane(t) || to === "with");
// Where a dragged card is over: a column to move to, or a card in its own column and which half.
const useBoardOver = create<{ lane: string | null; card: string | null; edge: string | null }>(() => ({ lane: null, card: null, edge: null }));
const clearOver = () => useBoardOver.setState({ lane: null, card: null, edge: null });
// Where a card dropped in To do goes: before the card under the pointer, or after it on its lower half (before the
// one after it in your whole list).
function cardBefore(id: string, el: HTMLElement, y: number) {
  const r = el.getBoundingClientRect();
  if (y < r.top + r.height / 2) return { before: id, edge: "top" };
  const drag = useTasksUi.getState().cardDrag;
  const order = openTasks()
    .filter((t) => !t.done && t.id !== drag)
    .map((t) => t.id);
  return { before: order[order.indexOf(id) + 1] ?? null, edge: "bottom" };
}
const BoardMark = ({ k }: { k: string }) => (
  <span className="fb-mark">{k === "done" ? <Icon name="check" /> : <i className={`fb-dot fb-dot--${k === "with" ? "live" : "ring"}`} />}</span>
);

export function TasksBoard({ scope, setView }: { scope: Scope; setView: (v: string) => void }) {
  const data = useApp((s) => s.data);
  useApp((s) => s.rows);
  const over = useBoardOver((s) => s.lane);
  const all = ((data?.tasks || []) as TaskRow[]).filter((t) => inScope(tasksLens.of, t, scope));
  const todo = all.filter((t) => boardLane(t) === "todo").sort((a, b) => a.rank - b.rank);
  const urgency = (t: TaskRow) => ({ needs: 0, working: 1 })[taskGoing(t)?.s?.effective] ?? 2;
  const withs = all.filter((t) => boardLane(t) === "with").sort((a, b) => urgency(a) - urgency(b) || a.rank - b.rank);
  const done = all.filter((t) => t.done).sort((a, b) => b.done_at.localeCompare(a.done_at));
  const week = done.filter((t) => Date.now() - Date.parse(t.done_at) < BOARD_WEEK);
  const older = done.length - week.length;
  // A column takes a card dragged over it when the card may go there.
  const lane = (k: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const id = useTasksUi.getState().cardDrag;
      const t = taskById(id);
      if (!laneOk(t, k)) return clearOver();
      e.preventDefault();
      if (k !== boardLane(t)) return useBoardOver.setState({ lane: k, card: null, edge: null });
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-bcard]");
      if (card && card.dataset.bcard !== id) useBoardOver.setState({ lane: null, card: card.dataset.bcard, edge: cardBefore(card.dataset.bcard, card, e.clientY).edge });
      else clearOver();
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const id = useTasksUi.getState().cardDrag;
      const t = taskById(id);
      clearOver();
      if (!laneOk(t, k)) return;
      e.preventDefault();
      if (k === boardLane(t)) {
        const card = (e.target as HTMLElement).closest<HTMLElement>("[data-bcard]");
        const { before } = card && card.dataset.bcard !== id ? cardBefore(card.dataset.bcard, card, e.clientY) : { before: undefined };
        if (before !== undefined && before !== id) void moveTask(id, before);
        return;
      }
      if (k === "with") return sendTask(t);
      void post(`/api/tasks/${encodeURIComponent(id)}/done`, { done: k === "done" });
    },
  });
  const col = (k: string, name: string, list: TaskRow[], n: number, foot: ReactNode) => (
    <section className={`board-col${over === k ? " is-over" : ""}`} data-board-lane={k} {...lane(k)}>
      <h2 className="board-h">
        <BoardMark k={k} />
        <span>{name}</span>
        <span className="n">{n}</span>
      </h2>
      {list.map((t) => (
        <TaskCard key={t.id} t={t} />
      ))}
      {foot}
    </section>
  );
  return (
    <div className="board">
      {col("todo", "To do", todo, todo.length, todo.length ? null : <p className="board-empty">Nothing to do.</p>)}
      {col("with", "With an agent", withs, withs.length, <p className="board-empty">{withs.length ? "" : "Nothing out with agents. "}Drop a task here to send it to an agent.</p>)}
      {col(
        "done",
        "Done",
        week,
        done.length,
        older || !week.length ? (
          <p className="board-empty">
            {week.length ? "" : "Nothing done this week. "}
            {older ? (
              <>
                <button className="link-btn" type="button" onClick={() => (setView("list"), go(scopeHref("tasks", scope, "done")))}>
                  {plural(older, "older one")}
                </button>
                , in the list.
              </>
            ) : null}
          </p>
        ) : null,
      )}
    </div>
  );
}
// A task on the board: its title, what its thread asks you if it needs you, and a line with who left it or where
// it came from, where it lives or how it's going, and how old it is. Click its title to open its page.
function TaskCard({ t }: { t: TaskRow }) {
  const questions = useApp((s) => s.data?.questions);
  const editing = useTasksUi((s) => s.taskEdit === t.id);
  const dragging = useTasksUi((s) => s.cardDrag === t.id);
  const over = useBoardOver((s) => (s.card === t.id ? s.edge : null));
  if (editing)
    return (
      <article className="bcard is-editing">
        <TaskEditForm t={t} />
      </article>
    );
  const g = !t.done && taskGoing(t);
  const q = g?.s ? (questions || []).find((x) => !x.answered && x.post === g.s.id) : null;
  let ask: ReactNode = null;
  if (q) {
    const who = <b>{g.s.label || agentName(g.s.agent)}</b>;
    ask =
      q.kind === "permission" ? (
        <div className="bcard-ask">
          <p>
            {who} wants to use {q.tool_name || "a tool"}
            {q.preview ? (
              <>
                : <code>{q.preview.slice(0, 60)}</code>
              </>
            ) : null}
          </p>
          <div className="bcard-acts">
            <button className="btn btn--dark btn--sm" type="button" onClick={(e) => void answer(q.id, "allow", e.currentTarget)}>
              Allow
            </button>
            <button className="btn btn--sm" type="button" onClick={(e) => void answer(q.id, "deny", e.currentTarget)}>
              Deny
            </button>
          </div>
        </div>
      ) : (
        <div className="bcard-ask">
          <p>
            {who} asks: {q.title}
          </p>
          <div className="bcard-acts">
            <a className="btn btn--dark btn--sm" href={threadHref(g.s.id, `ask=${encodeURIComponent(q.id)}`)}>
              Answer
            </a>
          </div>
        </div>
      );
  }
  const when = t.done ? t.done_at : t.at;
  const by = t.done && t.done_by === "agent" ? <span className="bcard-by">{sessionById(t.done_post)?.label || "an agent"} ticked it off</span> : t.done && t.done_user && t.done_user !== me() ? <span className="bcard-by">@{t.done_user} ticked it off</span> : null;
  const what = g && !q ? <TaskState t={t} /> : by || <TaskWhere t={t} />;
  return (
    <article
      className={`bcard${q ? " is-needs" : ""}${t.done ? " is-done" : ""}${dragging ? " is-dragging" : ""}${over ? ` is-over-${over}` : ""}`}
      draggable
      data-bcard={t.id}
      onDragStart={(e) => {
        setUi({ cardDrag: t.id });
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", t.text || "");
      }}
      onDragEnd={() => (setUi({ cardDrag: null }), clearOver())}
    >
      <TaskTick t={t} title />
      <a className="bcard-t task-t" href={taskHref(t)} title={t.text} draggable={false}>
        {t.text}
      </a>
      <TaskCorner task={t} cls=" vis-corner--sm" />
      {ask}
      <span className="bcard-meta">
        <TaskMark t={t} />
        <TaskFaces t={t} />
        {what}
        <ShipStrip t={t} />
        {when ? (
          <time className="task-at" dateTime={when} title={`${t.done ? "Closed" : "Added"} ${new Date(when).toLocaleString()}`}>
            {ago(when)}
          </time>
        ) : null}
      </span>
    </article>
  );
}
// Allow or Deny, for a thread that asks to use a tool.
async function answer(id: string, value: string, btn: HTMLButtonElement) {
  btn.disabled = true;
  await post(`/api/questions/${encodeURIComponent(id)}/answer`, { value });
  btn.disabled = false;
}
export { tickTask };
