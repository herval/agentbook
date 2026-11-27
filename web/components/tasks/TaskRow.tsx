// One task in a list: its tick box, its title and body, what it's on and who it's for, how it's going with an agent,
// and its buttons (edit, send, delete); editing it in place; dragging it by its handle to a new place.
import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { create } from "zustand";
import { agentName, verb, VERB, workspaces, wsWhere } from "../../lib/agents.ts";
import { ago, agoText, hueVars, webUrl } from "../../lib/format.ts";
import { useDraft } from "../../lib/hooks.ts";
import { groupHref, pageHref, taskHref, threadHref, workspaceHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { Scope, TaskRow } from "../../lib/types.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { linked } from "../thread/Plain.tsx";
import { TaskCorner } from "../Visibility.tsx";
import { sessionById } from "../worktrees/wips.ts";
import { GroupChip, Opt, PageChip, WsChip } from "./Chips.tsx";
import { ShipStrip, ships } from "./Ship.tsx";
import { shipOfTask } from "../worktrees/ship.ts";
import { atNames, cancelEdit, connectorName, deleteTask, editTask, groupById, me, moveEditing, moveTask, openNote, openTasks, saveTaskEdit, sendTask, sentOn, setUi, taskAgents, taskGoing, taskGroups, taskMine, taskPagesOf, taskPeople, tickTask, useTasksUi } from "./tasks.ts";

// A task's tick box: a button for its owner, only a mark for anyone else. `title`: whether the button says what it does
// on hover too. Someone else's says, on a tap too (a phone has no hover), that its owner ticks it off.
export function TaskTick({ t, title = false }: { t: TaskRow; title?: boolean }) {
  const now = t.done ? "Done" : "Not done";
  if (!taskMine(t)) {
    const says = `${now}. Only @${t.owner_name || "its owner"} ticks it off.`;
    return (
      <span className="tick-box is-fixed" aria-label={now} title={says} onClick={() => toast(says)}>
        {t.done ? "✓" : ""}
      </span>
    );
  }
  const act = t.done ? "Not done" : "Done";
  return (
    <button className="tick-box" type="button" aria-label={act} title={title ? act : undefined} onClick={() => void tickTask(t, !t.done)}>
      {t.done ? "✓" : ""}
    </button>
  );
}
// The faces of everyone else on a shared task, with whose it is on one that isn't yours.
export function TaskFaces({ t, whose = true }: { t: TaskRow; whose?: boolean }) {
  useApp((s) => s.me);
  const others = taskPeople(t).filter((u) => u !== me());
  if (!others.length) return null;
  const rest = others.filter((u) => u !== t.owner_name);
  const title = taskMine(t) ? `Shared with ${atNames(others)}` : `@${t.owner_name}'s, shared with you${rest.length ? ` and ${atNames(rest)}` : ""}`;
  return (
    <span className="chip chip--people" title={title}>
      {others.slice(0, 3).map((u) => (
        <PersonAvatar key={u} who={u} size="av--xs" />
      ))}
      {others.length > 3 ? <span>+{others.length - 3}</span> : null}
      {whose && !taskMine(t) ? <span>{t.owner_name}'s</span> : null}
    </span>
  );
}
// Who ticked it off, when that was someone else on it.
export const tickedByOther = (t: TaskRow) => t.done && t.done_by !== "agent" && t.done_user && t.done_user !== me();
export function TickedByPerson({ t }: { t: TaskRow }) {
  if (!tickedByOther(t)) return null;
  return (
    <span className="task-on">
      <PersonAvatar who={t.done_user} size="av--xs" />
      <span>
        <b>@{t.done_user}</b> ticked it off
      </span>
    </span>
  );
}
export function TickedBy({ t }: { t: TaskRow }) {
  const s = t.done_post && sessionById(t.done_post);
  const who = (
    <>
      <Avatar agent={s?.agent ?? "claude"} size="av--xs" />
      <span>
        <b>{s?.label || agentName(s?.agent) || "An agent"}</b> ticked it off
      </span>
    </>
  );
  return (
    <span className="task-on" style={hueVars(s?.agent)}>
      {s ? <a href={threadHref(s.id)}>{who}</a> : who}
    </span>
  );
}

// A to-do an agent left you says which post it's from (unless `from` is false: on a page, whose agents wrote its
// tasks). Any other task says how it's going with the newest of its posts, or with the launch it just went out as,
// while that starts.
export function TaskOn({ t, from: says = true }: { t: TaskRow; from?: boolean }) {
  const launches = useApp((s) => s.data?.launches);
  const posts = (t.posts || []).filter((e) => sessionById(e.post) && (says || e.post !== t.from));
  const more = posts.length > 1 ? <span className="muted">, {posts.length} threads</span> : null;
  const from = t.from && sessionById(t.from);
  if (t.from && says)
    return (
      <span className="task-on" style={hueVars(from?.agent)}>
        <a href={threadHref(t.from)}>
          <Avatar agent={from?.agent ?? "claude"} size="av--xs" />
          <span>
            from <b>{from?.label || agentName(from?.agent) || "an agent"}</b>
            {more}
          </span>
        </a>
      </span>
    );
  // The newest an agent works in: a thread someone started themselves (a talk) has none of its own.
  const newest = posts.filter((e) => !sessionById(e.post).talk).at(-1);
  const starting = t.sent?.filter((e) => !e.post).at(-1);
  const e = starting && (!newest || starting.at > newest.at) ? starting : newest;
  if (!e) return null;
  const s = e.post && sessionById(e.post);
  const l = !s && (launches || []).find((x) => x.id === (e as { launch?: string }).launch);
  const agent = s?.agent ?? l?.agent ?? (e as { agent?: string }).agent;
  let what: ReactNode;
  if (s) {
    const prs = Object.keys(s.prs || {});
    const pr = prs.length === 1 ? `, PR #${prs[0].match(/\/pull\/(\d+)/)?.[1] || ""}` : prs.length ? `, ${prs.length} PRs` : "";
    what =
      s.effective === "done" ? (
        <>
          <span className="task-ok">finished</span>
          {pr}
        </>
      ) : s.effective === "needs" ? (
        <span className="task-sun">needs you</span>
      ) : (
        `${VERB[s.effective] || ""}${pr}`
      );
  } else what = l?.error ? <span className="task-err">couldn't start</span> : l ? "is starting" : "has it";
  const who = (
    <>
      <Avatar agent={agent ?? "claude"} size="av--xs" />
      <span>
        <b>{agentName(agent) || "An agent"}</b> {what}
        {more}
      </span>
    </>
  );
  const live = s?.effective === "working" || (l && !l.error);
  return (
    <span className="task-on" style={hueVars(agent)}>
      {s ? <a href={threadHref(s.id)}>{who}</a> : who}
      {live ? <i className="pulse" /> : null}
    </span>
  );
}

export function TaskSource({ t }: { t: TaskRow }) {
  const s = t.source;
  if (!s?.url) return null;
  return (
    <>
      {" "}
      <a className="chip chip--src" href={webUrl(s.url) || "#"} target="_blank" rel="noopener" title={`${s.key || "The issue"}${s.state ? `, ${s.state}` : ""}, in ${connectorName(s)}`}>
        {s.key || connectorName(s)}
      </a>
    </>
  );
}
// What its connector says about a task: that it couldn't close or reopen its issue, or why it ticked it.
export function TaskSourceNote({ t }: { t: TaskRow }) {
  const s = t.source;
  if (s?.error)
    return (
      <span className="task-on">
        <span className="task-err">{s.error}</span>
      </span>
    );
  if (t.done && s?.gone) return <span className="task-on muted">{s.gone}</span>;
  return null;
}

// A task's body, under its title: its first lines, cut at a word past `cut` characters, and a … that shows the
// rest. One just over the cut shows whole. Its links are links; clicking the rest of it edits it.
export function TaskBody({ t, cut }: { t: TaskRow; cut: number }) {
  const open = useTasksUi((s) => s.taskOpen.has(t.id));
  const all = t.note.trim();
  let head = all;
  if (!open) {
    head = head.split("\n").slice(0, 2).join("\n").trimEnd();
    if (head.length > cut * 1.2) {
      const at = head.lastIndexOf(" ", cut);
      head = head.slice(0, at > cut * 0.6 ? at : cut).replace(/[\s,;:(–—-]+$/, "");
    }
  }
  return (
    <span className="task-note" onClick={taskMine(t) ? (e) => !(e.target as HTMLElement).closest("a, button") && editTask(t, "note") : undefined}>
      {linked(head)}
      {head.length < all.length ? (
        <button className="task-more" type="button" title="Show all of it" aria-label="Show all of it" onClick={() => openNote(t.id)}>
          …
        </button>
      ) : null}
    </span>
  );
}

export function TaskPickFace({ kind, id }: { kind: string; id: string | null }) {
  if (kind === "ws") {
    const ws = id && workspaces().find((w) => w.id === id);
    return (
      <>
        <Icon name={ws?.repo ? "repo" : "folder"} />
        <span className="opt-v">{ws?.name || "No workspace"}</span>
      </>
    );
  }
  if (kind === "group") {
    const g = id && groupById(id);
    return g ? (
      <>
        <span className="em">{g.emoji || "👥"}</span>
        <span className="opt-v">{g.name}</span>
      </>
    ) : (
      <>
        <Icon name="group" />
        <span className="opt-v">No group</span>
      </>
    );
  }
  return id ? (
    <>
      <Avatar agent={id} size="av--xs" />
      <span className="opt-v">{agentName(id)}</span>
    </>
  ) : (
    <>
      <Icon name="bot" />
      <span className="opt-v">Any agent</span>
    </>
  );
}
// Where and who a task is for, picked under it as you add or edit it, each kept in the box's drafts
// (`${key}-ws`, `${key}-agent`, `${key}-group`).
export function TaskPicks({ ws, agent, group, set }: { ws: string; agent: string; group: string; set: (kind: "ws" | "agent" | "group", v: string) => void }) {
  const groups = taskGroups(group || null);
  const pick = (kind: "ws" | "agent" | "group", label: string, id: string, options: ReactNode) => (
    <Opt label={label} face={<span className="task-pick"><TaskPickFace kind={kind} id={id || null} /></span>} set={!!id} value={id || ""} onChange={(v) => set(kind, v)}>
      {options}
    </Opt>
  );
  return (
    <div className="task-for">
      {pick(
        "ws",
        "Workspace",
        ws,
        <>
          <option value="">No workspace</option>
          {workspaces().map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </>,
      )}
      {pick(
        "agent",
        "Agent",
        agent,
        <>
          <option value="">Any agent</option>
          {taskAgents(agent || null).map((a) => (
            <option key={a.id} value={a.id}>
              {agentName(a.id)}
              {a.offline ? " (offline)" : ""}
            </option>
          ))}
        </>,
      )}
      {groups.length
        ? pick(
            "group",
            "Group",
            group,
            <>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.emoji || "👥"} {g.name}
                </option>
              ))}
            </>,
          )
        : null}
    </div>
  );
}

// Editing a task in place: its title, its body, and where and who it's for. Enter saves it from its title,
// ⌘/Ctrl+Enter from its body; Esc puts it back; Alt+↑/↓ moves it; leaving it saves it; an empty title deletes it.
export function TaskEditForm({ t }: { t: TaskRow }) {
  const key = `task-${t.id}`;
  const [text, setText] = useDraft(key);
  const [note, setNote] = useDraft(`${key}-note`);
  const [ws, setWs] = useDraft(`${key}-ws`);
  const [agent, setAgent] = useDraft(`${key}-agent`);
  const [group, setGroup] = useDraft(`${key}-group`);
  const at = useTasksUi((s) => s.taskEditAt);
  const form = useRef<HTMLFormElement>(null);
  const [noteH, setNoteH] = useState<number | null>(null);
  // Its box opens where you clicked: its title, or its body, the caret at the end.
  useEffect(() => {
    const el = form.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(at === "note" ? "textarea" : "input");
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [at]);
  const save = () => void saveTaskEdit(t.id, { text: text.trim(), note: note.trim(), ws: ws || null, agent: agent || null, group: taskGroups(t.group).length ? group || null : undefined });
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && ((e.target as HTMLElement).tagName === "INPUT" || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveEditing(e.key === "ArrowUp");
    }
  };
  return (
    <form
      ref={form}
      className="task-edit"
      onSubmit={(e) => (e.preventDefault(), save())}
      onKeyDown={keys}
      onBlur={(e) => !form.current?.contains(e.relatedTarget as Node | null) && save()}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder="Title" aria-label="Title" autoComplete="off" />
      <textarea
        className="task-note-in"
        rows={1}
        maxLength={4000}
        placeholder="Add details"
        aria-label="Body"
        style={noteH ? { height: noteH } : undefined}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setNoteH(e.target.scrollHeight);
        }}
      />
      {taskMine(t) ? <TaskPicks ws={ws} agent={agent} group={group} set={(k, v) => ({ ws: setWs, agent: setAgent, group: setGroup })[k](v)} /> : null}
    </form>
  );
}
// The pencil: editing it (not a done one, nor one that isn't yours).
export const EditBtn = ({ t }: { t: TaskRow }) =>
  t.done || !taskMine(t) ? null : (
    <button className="icon-btn" type="button" title="Edit" aria-label="Edit" onClick={() => editTask(t)}>
      <Icon name="pencil" />
    </button>
  );
const SendBtn = ({ t }: { t: TaskRow }) =>
  t.done ? null : (
    <button className="icon-btn" type="button" title="Send to an agent" aria-label="Send to an agent" onClick={() => sendTask(t)}>
      <Icon name="send" />
    </button>
  );
const TaskActs = ({ t }: { t: TaskRow }) => (
  <span className="task-acts">
    <EditBtn t={t} />
    <SendBtn t={t} />
    {taskMine(t) ? (
      <button className="icon-btn" type="button" title="Delete" aria-label="Delete" onClick={() => void deleteTask(t)}>
        <Icon name="x" />
      </button>
    ) : null}
  </span>
);
function TaskAt({ t, short = false }: { t: TaskRow; short?: boolean }) {
  const when = t.done ? t.done_at : t.at;
  if (!when) return null;
  return (
    <time className="task-at" dateTime={when} title={`${t.done ? "Closed" : "Added"} ${new Date(when).toLocaleString()}`}>
      {short ? ago(when) : agoText(when)}
    </time>
  );
}

// Where a dragged task is over, and on which half (the old is-over-top / is-over-bottom).
const useOver = create<{ id: string | null; edge: string | null }>(() => ({ id: null, edge: null }));
// Where a dragged task goes: before the task under the pointer, or after it when on its lower half (before the
// one after it in your whole list, which the card may not be showing).
function dropBefore(id: string, el: HTMLElement, y: number) {
  const r = el.getBoundingClientRect();
  if (y < r.top + r.height / 2) return { before: id, edge: "top" };
  const drag = useTasksUi.getState().taskDrag;
  const order = openTasks()
    .filter((t) => !t.done && t.id !== drag)
    .map((t) => t.id);
  return { before: order[order.indexOf(id) + 1] ?? null, edge: "bottom" };
}
// Drag a task by its handle to move it, in a list that can be reordered (`list`): its row's props, and its handle's.
function useTaskDrag(t: TaskRow, list: boolean) {
  const [armed, setArmed] = useState(false);
  const drag = useTasksUi((s) => s.taskDrag);
  const over = useOver((s) => (s.id === t.id ? s.edge : null));
  const on = list && !t.done;
  if (!on) return { li: {}, cls: "", grip: {} };
  const li = {
    draggable: armed,
    onDragStart: (e: DragEvent<HTMLLIElement>) => {
      if (!armed) return;
      setUi({ taskDrag: t.id });
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", t.text || "");
    },
    onDragOver: (e: DragEvent<HTMLLIElement>) => {
      const d = useTasksUi.getState().taskDrag;
      if (!d || d === t.id) return useOver.setState({ id: null, edge: null });
      e.preventDefault();
      useOver.setState({ id: t.id, edge: dropBefore(t.id, e.currentTarget, e.clientY).edge });
    },
    onDragLeave: () => useOver.getState().id === t.id && useOver.setState({ id: null, edge: null }),
    onDrop: (e: DragEvent<HTMLLIElement>) => {
      const d = useTasksUi.getState().taskDrag;
      useOver.setState({ id: null, edge: null });
      if (!d || d === t.id) return;
      e.preventDefault();
      const { before } = dropBefore(t.id, e.currentTarget, e.clientY);
      if (before !== d) void moveTask(d, before);
    },
    onDragEnd: () => {
      setArmed(false);
      setUi({ taskDrag: null });
      useOver.setState({ id: null, edge: null });
    },
    onMouseUp: () => !useTasksUi.getState().taskDrag && setArmed(false),
  };
  const cls = `${drag === t.id ? " is-dragging" : ""}${over ? ` is-over-${over}` : ""}`;
  return { li, cls, grip: { onMouseDown: () => setArmed(true) } };
}
const Grip = ({ p }: { p: object }) => (
  <span className="task-grip" title="Drag to move it" {...p}>
    <Icon name="grip" />
  </span>
);

// One of your tasks: its title, and its body under it. Tick it, click its title to open its page (the pencil, or
// its body, edits it), drag it by its handle, send it to an agent, delete it. `cut` is how much of its body shows
// before the rest hides behind a …, and `short` says how long ago in fewer words. `page`: whether to say which page
// it's on, and which thread left it (not on that page's own list); `on`, a page the list is narrowed to, which it
// doesn't name; `group`: whether to say which group it's in (not on the group's own list). `list`: in a list you
// can reorder by dragging.
export function TaskRowItem({ t, chip = true, cut = 90, short = false, page = true, on = null, group = true, list = true }: { t: TaskRow; chip?: boolean; cut?: number; short?: boolean; page?: boolean; on?: string | null; group?: boolean; list?: boolean }) {
  useApp((s) => s.data);
  const editing = useTasksUi((s) => s.taskEdit === t.id);
  const d = useTaskDrag(t, list);
  const ws = chip && t.workspace ? workspaces().find((w) => w.id === t.workspace) : null;
  const pgs = page ? taskPagesOf(t).filter((p) => p.id !== on) : [];
  const gr = group && t.group ? groupById(t.group) : null;
  return (
    <li className={`task${t.done ? " is-done" : ""}${d.cls}`} {...d.li}>
      {t.done ? null : <Grip p={d.grip} />}
      <TaskTick t={t} />
      {editing ? (
        <TaskEditForm t={t} />
      ) : (
        <span className="task-text">
          <a className="task-t" href={taskHref(t)}>
            {t.text}
          </a>
          <TaskSource t={t} />
          {ws ? (
            <>
              {" "}
              <WsChip w={ws} />
            </>
          ) : null}
          {pgs.map((p) => (
            <span key={p.id}>
              {" "}
              <PageChip p={p} />
            </span>
          ))}
          {gr ? (
            <>
              {" "}
              <GroupChip g={gr} />
            </>
          ) : null}
          {t.agent ? (
            <>
              {" "}
              <span className="chip chip--who">
                <Avatar agent={t.agent} size="av--xs" />
                {agentName(t.agent)}
              </span>
            </>
          ) : null}{" "}
          <TaskFaces t={t} />
        </span>
      )}
      {editing ? null : <TaskAt t={t} short={short} />}
      {editing ? null : <TaskCorner task={t} cls=" vis-corner--sm" />}
      {editing ? null : <TaskActs t={t} />}
      {t.note && !editing ? <TaskBody t={t} cut={cut} /> : null}
      {t.done && t.done_by === "agent" ? <TickedBy t={t} /> : tickedByOther(t) ? <TickedByPerson t={t} /> : <TaskOn t={t} from={page} />}
      <TaskSourceNote t={t} />
    </li>
  );
}

// A connector's issue's state, drawn the way its tool draws it: a pull request; dashed for the backlog, a ring
// to do, half full started, a tick done, a cross canceled.
export function SrcMark({ s }: { s: TaskRow["source"] }) {
  if (s.kind === "github" && (s.state_type === "review" || /\/pull\//.test(s.url || "")))
    return (
      <span className="src-mark src-mark--pr">
        <Icon name="pr" />
      </span>
    );
  const k = s.state_type;
  const svg = (body: ReactNode) => (
    <span className="src-mark">
      <svg viewBox="0 0 14 14" aria-hidden="true">
        {body}
      </svg>
    </span>
  );
  if (k === "backlog") return svg(<circle cx="7" cy="7" r="5.6" fill="none" stroke="#a3abb5" strokeWidth="1.5" strokeDasharray="2.2 1.9" />);
  if (k === "started")
    return svg(
      <>
        <circle cx="7" cy="7" r="5.6" fill="none" stroke="#d9a400" strokeWidth="1.5" />
        <path d="M7 3.4a3.6 3.6 0 0 1 0 7.2z" fill="#d9a400" />
      </>,
    );
  if (k === "completed")
    return svg(
      <>
        <circle cx="7" cy="7" r="6.3" fill="#23845a" />
        <path d="m4.4 7.2 1.8 1.8 3.4-3.6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </>,
    );
  if (k === "canceled")
    return svg(
      <>
        <circle cx="7" cy="7" r="6.3" fill="#a3abb5" />
        <path d="m5 5 4 4M9 5 5 9" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
      </>,
    );
  return svg(<circle cx="7" cy="7" r="5.6" fill="none" stroke="#a3abb5" strokeWidth="1.5" />);
}
export function TaskMark({ t }: { t: TaskRow }) {
  if (t.source)
    return (
      <a className="task-mark" href={webUrl(t.source.url) || "#"} target="_blank" rel="noopener" title={`${t.source.key || "The issue"}${t.source.state ? `, ${t.source.state}` : ""}, in ${connectorName(t.source)}`}>
        <SrcMark s={t.source} />
      </a>
    );
  const from = t.from && sessionById(t.from);
  if (from)
    return (
      <a className="task-mark" href={threadHref(from.id)} title={`Left for you by ${from.label || agentName(from.agent)}`}>
        <Avatar agent={from.agent ?? "claude"} size="av--xs" />
      </a>
    );
  return null;
}
// Whether a task says where it lives (TaskWhere draws it).
const whereOf = (t: TaskRow, scope?: Scope) => {
  if (taskPagesOf(t).some((p) => !(scope?.page.length === 1 && scope.page[0] === p.id))) return true;
  if (t.group && groupById(t.group)) return true;
  const ws = t.workspace && workspaces().find((w) => w.id === t.workspace);
  return !!ws && !(scope?.workspace.length === 1 && scope.workspace[0] === ws.id);
};
// Where a task lives, quietly: the page it's on, else its group, else its workspace. Not the page or the workspace
// the bar is narrowed to.
export function TaskWhere({ t, scope }: { t: TaskRow; scope?: Scope }) {
  const pg = taskPagesOf(t).find((p) => !(scope?.page.length === 1 && scope.page[0] === p.id));
  if (pg)
    return (
      <a className="task-where" href={pageHref(pg)} title={`On the page ${pg.title}`}>
        <span className="em">{pg.emoji || "📄"}</span>
        <span>{pg.title}</span>
      </a>
    );
  const g = t.group && groupById(t.group);
  if (g)
    return (
      <a className="task-where" href={groupHref(g)} title={`In the group ${g.name}`}>
        <span className="em">{g.emoji || "👥"}</span>
        <span>{g.name}</span>
      </a>
    );
  const ws = t.workspace && workspaces().find((w) => w.id === t.workspace);
  if (ws && !(scope?.workspace.length === 1 && scope.workspace[0] === ws.id))
    return (
      <a className="task-where" href={workspaceHref(ws.id)} title={`The workspace ${ws.name}\n${wsWhere(ws)}`}>
        <Icon name={ws.repo ? "repo" : "folder"} />
        <span>{ws.name}</span>
      </a>
    );
  return null;
}
// How it's going, as a pill in its agent's color: the thread at work, or waiting, or yellow when it needs you,
// green once it's done (with its pull request), red when it couldn't start.
export function TaskState({ t }: { t: TaskRow }) {
  const g = taskGoing(t);
  if (!g) return null;
  const { s, l, agent } = g;
  const more = g.n > 1 ? `, ${g.n} threads` : "";
  const who = s?.label || agentName(agent) || "An agent";
  const av = <Avatar agent={agent ?? "claude"} size="av--xs" />;
  let pill: ReactNode;
  if (s?.effective === "needs")
    pill = (
      <span className="st-pill st-pill--needs">
        {av}needs you
      </span>
    );
  else if (s?.effective === "done") {
    const prs = Object.keys(s.prs || {});
    pill = (
      <span className="st-pill st-pill--done">
        <Icon name="check" />
        {prs.length === 1 ? `PR #${prs[0].match(/\/pull\/(\d+)/)?.[1] || ""}` : prs.length ? `${prs.length} PRs` : "finished"}
      </span>
    );
  } else if (s)
    pill = (
      <span className="st-pill" style={hueVars(agent)}>
        {av}
        {who}
        {s.effective === "working" ? <i className="pulse" /> : null}
      </span>
    );
  else if (l?.error) pill = <span className="st-pill st-pill--err">couldn't start</span>;
  else
    pill = (
      <span className="st-pill" style={hueVars(agent)}>
        {av}starting
        <i className="pulse" />
      </span>
    );
  const title = s ? `${s.label} ${verb(s) || ""}`.trim() : l?.error ? `It couldn't start: ${l.error}` : `${agentName(agent) || "An agent"} is starting`;
  return s ? (
    <a className="st-link" href={threadHref(s.id)} title={title + more}>
      {pill}
    </a>
  ) : (
    <span className="st-link" title={title}>
      {pill}
    </span>
  );
}

// The line under a task's title, the same shape on every task: who left it to you (or ticked it off), the issue it
// came from and its state there, where it lives, which agent it's for, then the start of its body, cut at the
// edge; clicking that shows all of it.
function TaskSub({ t, open, scope }: { t: TaskRow; open: boolean; scope?: Scope }) {
  const bits: ReactNode[] = [];
  if (taskPeople(t).some((u) => u !== me())) bits.push(<TaskFaces t={t} />);
  if (tickedByOther(t)) bits.push(<TickedByPerson t={t} />);
  else if (t.done && t.done_by === "agent") {
    const s = t.done_post && sessionById(t.done_post);
    bits.push(
      <a className="task-who" href={s ? threadHref(s.id) : "#/tasks"} style={hueVars(s?.agent)}>
        <Avatar agent={s?.agent ?? "claude"} size="av--xs" />
        <span>
          <b>{s?.label || agentName(s?.agent) || "An agent"}</b> ticked it off
        </span>
      </a>,
    );
  } else if (t.from) {
    const s = sessionById(t.from);
    const who = (
      <>
        <Avatar agent={s?.agent ?? "claude"} size="av--xs" />
        <b>{s?.label || agentName(s?.agent) || "an agent"}</b>
      </>
    );
    bits.push(
      s ? (
        <a className="task-who" href={threadHref(s.id)} style={hueVars(s.agent)} title={`Left for you by ${s.label || agentName(s.agent)}`}>
          {who}
        </a>
      ) : (
        <span className="task-who">{who}</span>
      ),
    );
  }
  if (t.source) {
    const s = t.source;
    bits.push(
      <span className="task-src">
        <SrcMark s={s} />
        {s.state || connectorName(s)}
      </span>,
    );
    if (s.url)
      bits.push(
        <a className="task-key" href={webUrl(s.url) || "#"} target="_blank" rel="noopener" title={`Open it in ${connectorName(s)}`}>
          {s.key || connectorName(s)}
        </a>,
      );
  }
  if (whereOf(t, scope)) bits.push(<TaskWhere t={t} scope={scope} />);
  if (ships(t) && shipOfTask(t).ss.counts.total >= 2) bits.push(<ShipStrip t={t} />);
  if (t.agent && !t.done && !sentOn(t))
    bits.push(
      <span className="task-for-who" title={`It goes to ${agentName(t.agent)} when you send it`}>
        for <Avatar agent={t.agent} size="av--xs" />
      </span>,
    );
  if (t.source?.error) bits.push(<span className="task-err">{t.source.error}</span>);
  else if (t.done && t.source?.gone) bits.push(<span>{t.source.gone}</span>);
  const note = t.note?.trim();
  if (note && !t.done && !open)
    bits.push(
      <button className="task-peek" type="button" title="Show all of it" onClick={() => openNote(t.id)}>
        {note.split("\n").find((x) => x.trim()) || note}
      </button>,
    );
  return (
    <>
      {bits.map((b, i) => (
        <Fragment key={i}>
          {i ? <i className="dot" aria-hidden="true" /> : null}
          {b}
        </Fragment>
      ))}
    </>
  );
}

// One task on the Tasks page, in two lines that line up from task to task: its title alone, and under it the
// line TaskSub draws, with how it's going with an agent at its end. Tick it, click its title to open its page (the
// pencil, or all of its body, edits it), drag it by its handle, send it to an agent, delete it.
export function TaskLine({ t, scope, list = true }: { t: TaskRow; scope?: Scope; list?: boolean }) {
  useApp((s) => s.data);
  const editing = useTasksUi((s) => s.taskEdit === t.id);
  const opened = useTasksUi((s) => s.taskOpen.has(t.id));
  const d = useTaskDrag(t, list);
  const open = !editing && !t.done && !!t.note?.trim() && opened;
  const when = t.done ? t.done_at : t.at;
  return (
    <li className={`task task--line${t.done ? " is-done" : ""}${d.cls}`} {...d.li}>
      {t.done ? null : <Grip p={d.grip} />}
      <TaskTick t={t} />
      {editing ? (
        <TaskEditForm t={t} />
      ) : (
        <a className="task-text task-t" href={taskHref(t)}>
          {t.text}
        </a>
      )}
      {when && !editing ? (
        <time className="task-at" dateTime={when} title={`${t.done ? "Closed" : "Added"} ${new Date(when).toLocaleString()}`}>
          {agoText(when)}
        </time>
      ) : null}
      {editing ? null : <TaskCorner task={t} cls=" vis-corner--sm" />}
      {editing ? null : <TaskActs t={t} />}
      {editing ? null : (
        <>
          <span className="task-sub">
            <TaskSub t={t} open={open} scope={scope} />
          </span>
          <span className="task-st">{t.done ? null : <TaskState t={t} />}</span>
        </>
      )}
      {open ? (
        <span className="task-note" onClick={taskMine(t) ? (e) => !(e.target as HTMLElement).closest("a, button") && editTask(t, "note") : undefined}>
          {linked(t.note.trim())}
        </span>
      ) : null}
    </li>
  );
}
