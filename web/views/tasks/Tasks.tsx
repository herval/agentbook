// #/tasks: your list, or a board of it, as the filter bar narrows them. A status picked (in the bar, or in the
// address) shows the list, at that status: the board is all of them, side by side, and takes the right column's
// room.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useDismiss, usePref } from "../../lib/hooks.ts";
import { connectorsHref, go, NO_SCOPE, scopeHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { Scope } from "../../lib/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { ScopeBar } from "../../components/ScopeBar.tsx";
import { Shell } from "../../components/Shell.tsx";
import { TasksBoard } from "../../components/tasks/Board.tsx";
import { ComingUp } from "../../components/tasks/ComingUp.tsx";
import { ConnectorsCard } from "../../components/tasks/ConnectorsCard.tsx";
import { TaskComposer } from "../../components/tasks/TaskComposer.tsx";
import { TaskLine } from "../../components/tasks/TaskRow.tsx";
import { doneTasks, forgetTicked, inScope, openTasks, scopeSet, setUi, tasksLens, useTasksUi } from "../../components/tasks/tasks.ts";

// List or Board, a menu at the bar's end. The board is every status side by side, so switching drops the status
// picked; its older done ones go to the list, at Done. Picking the one it shows from the menu keeps the status.
function TasksViewMenu({ on, set, scope }: { on: string; set: (v: string) => void; scope: Scope }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const views = [
    ["list", "steps", "List"],
    ["board", "board", "Board"],
  ] as const;
  const [, ico, label] = views.find(([k]) => k === on) || views[0];
  const pick = (k: string) => {
    setOpen(false);
    if (k === on) return;
    set(k);
    go(scopeHref("tasks", scope, null));
  };
  return (
    <div className="fb-f fb-show" ref={ref}>
      <button className="fb-opt" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Show as ${label}`} title={`${label}: show your tasks as a list or a board`} onClick={() => setOpen(!open)}>
        <Icon name={ico} />
      </button>
      {open ? (
        <div className="fb-menu" role="menu" aria-label="Show as">
          <div className="fb-list">
            {views.map(([k, i, l]) => (
              <button key={k} className={`fb-row fb-row--one${on === k ? " is-on" : ""}`} type="button" role="menuitemradio" aria-checked={on === k} onClick={() => pick(k)}>
                <span className="fb-mark">
                  <Icon name={i} />
                </span>
                <span className="fb-nm">{l}</span>
                <span className="fb-on">{on === k ? <Icon name="check" /> : null}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The list: the open ones in your order, then the done ones, folded away unless the bar asks for them. `head`: the
// filters, as the card's first row.
function TasksList({ scope, f, head }: { scope: Scope; f: string; head: ReactNode }) {
  useApp((s) => s.data);
  useApp((s) => s.rows);
  const pageDone = useTasksUi((s) => s.tasksPageDone);
  useTasksUi((s) => s.justDone);
  const shown = (t) => inScope(tasksLens.of, t, scope) && tasksLens.is(t, f);
  const rows = f === "done" ? [] : openTasks().filter(shown);
  const done = ["all", "done"].includes(f) ? doneTasks().filter(shown) : [];
  const narrowed = f !== "all" || scopeSet(scope);
  const empty =
    narrowed && done.length ? null : narrowed ? (
      <p className="muted tasks-empty">
        No tasks match.{" "}
        <button className="link-btn" type="button" onClick={() => go(scopeHref("tasks"))}>
          Clear the filters
        </button>
      </p>
    ) : (
      <p className="muted tasks-empty">Nothing on your list. Add what you have to do; the paper plane on a task sends it to an agent.</p>
    );
  const doneShown = f === "done" || pageDone;
  return (
    <section className="card tasks tasks--page">
      {head}
      {rows.length ? (
        <ul className="task-list task-list--lines">
          {rows.map((t) => (
            <TaskLine key={t.id} t={t} scope={scope} />
          ))}
        </ul>
      ) : (
        empty
      )}
      {f === "all" && done.length ? (
        <div className="tasks-foot">
          <button type="button" aria-expanded={pageDone} onClick={() => setUi({ tasksPageDone: !pageDone })}>
            {done.length} done
            <Icon name="down" />
          </button>
        </div>
      ) : null}
      {doneShown && done.length ? (
        <ul className="task-list task-list--lines task-list--done">
          {done.map((t) => (
            <TaskLine key={t.id} t={t} scope={scope} list={false} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function Tasks() {
  const route = useRoute();
  const [view, setView] = usePref("tasksView", "list");
  const scope = route.scope || NO_SCOPE;
  const f = tasksLens.keys.includes(route.status) ? route.status : "all";
  const board = view === "board" && f === "all" && !route.status;
  // What you ticked here goes to Done once you leave.
  useEffect(() => forgetTicked, []);
  const head = (bare: boolean) => (
    <ScopeBar
      name="tasks"
      title="Tasks"
      h1
      bare={bare}
      sticky
      acts={
        <>
          <a className="icon-btn" href={connectorsHref()} title="Connectors: where tasks come in from" aria-label="Connectors">
            <Icon name="plug" />
          </a>
          <TasksViewMenu on={board ? "board" : "list"} set={setView} scope={scope} />
        </>
      }
    />
  );
  return (
    <Shell className={`shell tasks-shell${board ? " is-board" : ""}`} right={
        <>
          <ComingUp />
          <ConnectorsCard />
        </>
      }
    >
      <TaskComposer scope={scope} />
      {board ? (
        <>
          {head(true)}
          <TasksBoard scope={scope} setView={setView} />
        </>
      ) : (
        <TasksList scope={scope} f={f} head={head(false)} />
      )}
    </Shell>
  );
}
