import { post } from "../../lib/api.ts";
import { getApp, useApp } from "../../lib/store.ts";
import { taskHref, workspaceHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import type { TaskRow } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import { landWord, partRef, partStatus, setParts, setTally, shipOfTask, tasksOfPart, wipItemOf, wsSeenOf, type TaskShip } from "../worktrees/ship.ts";
import { useWorld, wipWs, type Wip } from "../worktrees/wips.ts";

// Its strip: a segment for each thing in it, in that thing's color (`titles`: each says which and where it stands).
const BAR_CLS = { landed: "landed", merged: "landed", closed: "closed", gone: "closed", needs: "needs", stuck: "stuck", ready: "ready", review: "review", draft: "draft" };
export function SetBar({ x, titles = false }: { x: TaskShip; titles?: boolean }) {
  if (!x.parts.length) return null;
  return (
    <span className="wp-bar" title={titles ? undefined : setTally(x)}>
      {setParts(x).map((p) => {
        const st = partStatus(p);
        const k = p.w?.state === "needs" ? "needs" : BAR_CLS[st.k] || "branch";
        return <i key={p.id} className={`is-${k}`} title={titles ? `${partRef(p)} ${st.word.toLowerCase()}` : undefined} />;
      })}
    </span>
  );
}
// Whether a task's row shows what it ships: not an agent's to-do's, whose only thread is the one it came from (its
// pull requests are that thread's, not the to-do's).
export const ships = (t: TaskRow) => !t.scope && (!!t.ship?.items?.length || (t.posts || []).some((e) => e.post !== t.from));
// On its row in Tasks and its card on the board: its strip and "2 of 4 merged", once it ships two or more.
export function ShipStrip({ t }: { t: TaskRow }) {
  if (!ships(t)) return null;
  const x = shipOfTask(t);
  const c = x.ss.counts;
  if (c.total < 2) return null;
  return (
    <span className="tk-ship" title={setTally(x)}>
      <SetBar x={x} />
      <span className="wp-n">
        {c.landed === c.total ? `All ${c.total}` : `${c.landed} of ${c.total}`} {landWord(x)}
      </span>
    </span>
  );
}
// A task you have, by its id: on your list, or one of the to-dos your threads left you.
const taskOf = (id: string) => ((getApp().data?.tasks || []) as TaskRow[]).find((t) => t.id === id) || ((getApp().data?.todos || []) as TaskRow[]).find((t) => t.id === id) || null;

export function TaskTag({ w }: { w: Wip }) {
  useWorld();
  const t = tasksOfPart(w)[0];
  if (!t) return null;
  return (
    <a className="chip chip--set" href={taskHref(t)} title={`On the task ${t.text}`}>
      <Icon name="tasks" />
      <span>{t.text}</span>
    </a>
  );
}
// A shared one's page's crumbs: the task it's on, or someone's workspace, not a workspace of yours.
export function SharedCrumbs({ w, last }: { w: Wip; last: string }) {
  const data = useWorld();
  if (w.via === "workspaces") {
    const ws = wsSeenOf(w.task)?.workspace;
    return (
      <p className="crumbs">
        {ws?.owner ? (
          <>
            <a href={`#/people/${encodeURIComponent(ws.owner)}`}>@{ws.owner}</a>
            <span className="sep">/</span>
          </>
        ) : null}
        {ws?.name ? (
          <>
            <a href={workspaceHref(w.task)}>{ws.name}</a>
            <span className="sep">/</span>
          </>
        ) : null}
        <span>{last}</span>
      </p>
    );
  }
  const t = ((data?.tasks || []) as TaskRow[]).find((x) => x.id === w.task);
  return (
    <p className="crumbs">
      <a href="#/tasks">Tasks</a>
      <span className="sep">/</span>
      {t ? (
        <>
          <a href={taskHref(t)}>{t.text}</a>
          <span className="sep">/</span>
        </>
      ) : null}
      <span>{last}</span>
    </p>
  );
}

// Putting one in a task from its page's Task card: one of your open tasks, or a new one named after it or what you
// typed.
async function shipPut(w: Wip, v: string) {
  const item = wipItemOf(w);
  if (v === "~new" || v.startsWith("~new:")) {
    const text = (v.length > 5 ? v.slice(5) : "") || w.title;
    const r = await post<{ id: string }>("/api/tasks", { text, workspace: wipWs(w) || undefined });
    if (r.ok && (await post(`/api/tasks/${encodeURIComponent(r.data.id)}/items`, { item })).ok) toast(`On a new task, ${text}.`, { label: "Open", run: () => (location.hash = `#/tasks/${encodeURIComponent(r.data.id)}`) });
    return;
  }
  const t = taskOf(v);
  if ((await post(`/api/tasks/${encodeURIComponent(v)}/items`, { item })).ok) toast(`On ${t?.text || "the task"}.`);
}
// × on a pull request's Task card: out of a task you put it in.
async function shipOut(taskId: string, item: string, btn: HTMLButtonElement) {
  btn.disabled = true;
  const task = taskOf(taskId);
  if ((await post(`/api/tasks/${encodeURIComponent(taskId)}/items`, { item: { id: item }, remove: true })).ok) toast(`Out of ${task?.text || "the task"}.`);
  btn.disabled = false;
}
// On a pull request's or a branch's page, the tasks it's in, each with how much of what it ships landed (× takes it
// out of one you put it in), and Put it in a task: your open ones, or a new one named after it or what you type.
export function TaskCardOf({ x: w }: { x: Wip }) {
  const data = useWorld();
  useApp((s) => s.data?.tasks);
  const on = tasksOfPart(w);
  const here = new Set(on.map((t) => t.id));
  const open = ((data?.tasks || []) as TaskRow[]).filter((t) => !t.done && !t.scope && !here.has(t.id)).slice(0, 80);
  // Someone else's, on no task you see: nothing to say or do here.
  if (w.shared && !on.length) return null;
  const rows = on.map((t) => {
    const x = shipOfTask(t);
    const part = x.parts.find((p) => p.id === w.id);
    const c = x.ss.counts;
    const why = [part?.via ? `with ${part.via.label}` : "", c.total >= 2 ? `${c.landed} of ${c.total} ${landWord(x)}` : "", t.done ? "done" : ""].filter(Boolean).join(", ");
    return (
      <li key={t.id}>
        <a className="gw-in" href={`#/tasks/${encodeURIComponent(t.id)}`}>
          <span className="wp-ico">
            <Icon name="tasks" />
          </span>
          <span>
            <b>{t.text}</b>
            {why ? <small>{why}</small> : null}
          </span>
        </a>
        {c.total >= 2 ? (
          <div className="wp-sum">
            <SetBar x={x} />
          </div>
        ) : null}
        {part?.item && !w.shared ? (
          <button className="icon-btn" type="button" title={`Take it out of ${t.text}`} aria-label="Take it out" onClick={(e) => void shipOut(t.id, part.item.id, e.currentTarget)}>
            <Icon name="x" />
          </button>
        ) : null}
      </li>
    );
  });
  return (
    <section className="card rail-card tk-of">
      <h3 className="rail-h">{on.length > 1 ? "Tasks" : "Task"}</h3>
      {rows.length ? <ul className="tk-of-list">{rows}</ul> : <p className="muted side-p">On no task. On one, its threads hear what happens to it, and it lands in the task's order.</p>}
      {/* One on a task shared with you isn't yours to put in another. */}
      {w.shared ? null : (
        <MenuPick
          id={`ship-put:${w.id}`}
          label="Task"
          title="Put it in a task, with the threads and pull requests it ships with"
          face={
            <>
              <Icon name="plus" />
              <span className="opt-v">Put it in a task</span>
              <Icon name="down" className="caret" />
            </>
          }
          none
          find
          rows={[...open.map((t) => ({ value: t.id, text: t.text })), ...(open.length ? [{ divider: "" }] : []), { value: "~new", text: "New task…", face: <Icon name="plus" />, make: "New task" }]}
          onPick={(v) => void shipPut(w, v)}
        />
      )}
    </section>
  );
}
