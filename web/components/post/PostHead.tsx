// The head of a thread's card (postHead): its agent, what it's doing, and its chips (its label, its project and
// branch, the page, group, tasks and note it's on, the thread that started it, when, its status, where it runs, its
// loops, its guests, its routine), and who can see it in its corner.
import { agentName, machineOf, postOwner, tildeOn, verb, workspaceIds, workspaces, wsWhere } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { setDraft } from "../../lib/hooks.ts";
import { agentHref, go, groupHref, noteHref, pageHref, personHref, taskHref, threadHref, workspaceHref } from "../../lib/route.ts";
import { agentOf, getApp, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, NoteRow, PageRow, TaskRow, Thread, WorkspaceRow } from "../../lib/types.ts";
import { ago, groupStyle, hueVars, pageStyle, plural } from "../../lib/format.ts";
import { Avatar } from "../Avatar.tsx";
import { StatusChip, WhereChip } from "../Chips.tsx";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import type { MenuRow } from "../MenuPick.tsx";
import { ThreadCorner } from "../Visibility.tsx";
import { LoopChip } from "./Loops.tsx";
import type { BranchWip } from "./parts.ts";
import { prMeta, wipHref, wipOfPost, wipWhy } from "../worktrees/wips.ts";
import { openNewGroup } from "../groups/groups.ts";
import { Hl, myRoutineHref, seen, useStartedFrom, useThreadGroup, useThreadNote, useThreadPage } from "./util.tsx";

// A thread's guests still in it.
export const guestsOn = (s: Thread | null | undefined) => (s?.guests || []).filter((g) => !seen(g).removed);
// Who's in a thread's conversation: its own agent first, then its guests, each by its agent's name, or by its thread's
// when two of them are the same agent.
export function together(s: Thread) {
  // A thread of yours has no agent of its own: only its guests.
  const all = [...(s.talk ? [] : [{ id: s.id, agent: s.agent, label: s.label, host: true, effective: s.effective }]), ...guestsOn(s).filter((g) => g.label)];
  return all.map((x) => ({ ...x, name: all.filter((y) => y.agent === x.agent).length > 1 ? x.label : agentOf(x.agent).name }));
}
export const guestWords = (g: Thread) => (g.effective === "starting" ? "starting" : g.effective === "failed" ? "couldn't start" : g.effective === "working" ? "working" : g.effective === "needs" ? "needs you" : g.effective === "done" ? "ended" : "idle");

// A workspace as a chip, with the icon the sidebar gives it, going to its page; `name` says it otherwise, as a
// thread's header does with its project's folder. No workspace: the folder alone, `where` it is.
export function WsChip({ ws, name, where = "" }: { ws: WorkspaceRow | null | undefined; name?: React.ReactNode; where?: string }) {
  if (!ws)
    return (
      <span className="chip chip--ws" title={where || undefined}>
        <Icon name="folder" />
        <span>{name}</span>
      </span>
    );
  return (
    <a className="chip chip--ws" href={workspaceHref(ws.id)} title={`The workspace ${ws.name}\n${wsWhere(ws)}`}>
      <Icon name={ws.repo ? "repo" : "folder"} />
      <span>{name ?? ws.name}</span>
    </a>
  );
}

// A thread's worktree (wipOfPost: the pull request it worked on, else its branch), as its branch chip says it.
function branchWip(s: Thread): BranchWip | null {
  const w = wipOfPost(s);
  if (!w) return null;
  return { href: wipHref(w), why: wipWhy(w), kind: w.kind, prState: w.pr?.state, prMeta: w.kind === "pr" && w.pr ? prMeta(w.pr, w.state) : "", dirty: w.dirty, ahead: w.ahead, worked: w.worked };
}
// A post's branch, and whether its work is on main yet: green with a check once it all landed (a branch
// cleaned up that way too), purple once its pull request merged, crossed out when that was closed or the branch
// was deleted. Until then it ends with what the sidebar's WIP row says: "4 ±" files not committed, "↑2"
// commits not on main, or how its pull request stands.
export function BranchChip({ thread: s }: { thread: Thread }) {
  const folders = useApp((st) => st.data?.folders);
  useApp((st) => st.rows);
  const w = s.mine !== false ? branchWip(s) : null;
  const name = <Hl text={s.branch} />;
  if (!w) {
    const f = s.mine !== false && s.root ? (folders || []).find((x) => x.root === s.root && machineOf(x) === machineOf(s)) : null;
    const gone = !!f && Array.isArray(f.branches) && f.branch !== s.branch && !f.branches.some((b) => b.name === s.branch);
    if (gone && s.landed === s.branch)
      return (
        <span className="chip chip--branch chip--landed" title={`${s.branch}, cleaned up once everything on it was on main`}>
          <Icon name="check" />
          {name}
        </span>
      );
    if (gone)
      return (
        <span className="chip chip--branch chip--gone" title={`${s.branch} was deleted`}>
          <s>{name}</s>
        </span>
      );
    return <span className="chip chip--branch">{name}</span>;
  }
  const chip = (cls: string, inner: React.ReactNode) => (
    <a className={`chip chip--branch${cls}`} href={w.href} title={`Its worktree: ${w.why}`}>
      {inner}
    </a>
  );
  if (w.kind === "pr") {
    if (w.prState === "merged")
      return chip(
        " chip--merged",
        <>
          <Icon name="merge" />
          {name}
        </>,
      );
    if (w.prState === "closed")
      return chip(
        " chip--gone",
        <>
          <Icon name="x" />
          <s>{name}</s>
        </>,
      );
    return chip(
      "",
      <>
        {name}
        <span className="chip-x">{w.prMeta}</span>
      </>,
    );
  }
  const left = [w.dirty ? `${w.dirty} ±` : "", w.ahead ? `↑${w.ahead}` : ""].filter(Boolean).join(" ");
  if (left)
    return chip(
      "",
      <>
        {name}
        <span className="chip-x">{left}</span>
      </>,
    );
  return w.worked
    ? chip(
        " chip--landed",
        <>
          <Icon name="check" />
          {name}
        </>,
      )
    : chip("", name);
}

export function FromChip({ thread: s }: { thread: Thread }) {
  const f = useStartedFrom(s);
  if (!f) return null;
  if (s.side_at)
    return (
      <a className="chip chip--from" href={threadHref(f.id)} title={`A side thread of ${f.label}${f.title ? `: ${f.title}` : ""}. It went on from that thread's conversation`}>
        <Icon name="side" />
        side of {f.label}
      </a>
    );
  return (
    <a className="chip chip--from" href={threadHref(f.id)} title={`Started from ${f.label}${f.title ? `: ${f.title}` : ""}`}>
      from {f.label}
    </a>
  );
}

export const PageChipOf = ({ page: p }: { page: PageRow }) => (
  <a className="chip chip--page" style={pageStyle(p)} href={pageHref(p)} title={`On the page ${p.title}${p.archived ? ", archived" : ""}`}>
    {p.emoji || "📄"}
    <span>
      <Hl text={p.title} />
    </span>
  </a>
);
export function PageChip({ id }: { id: string | null | undefined }) {
  const p = useThreadPage(id);
  return p ? <PageChipOf page={p} /> : null;
}
export const GroupChip = ({ group: g }: { group: GroupRow }) => (
  <a className="chip chip--group" href={groupHref(g)} style={groupStyle(g)} title={`In the group ${g.name}`}>
    {g.emoji || "👥"} {g.name}
  </a>
);
export const NoteChip = ({ note: n }: { note: NoteRow }) => (
  <a className="chip chip--note" href={noteHref(n.id)} title={`About the note ${n.title}`}>
    {n.emoji || "📄"}
    <span>{n.title}</span>
  </a>
);
export function PageRef({ id }: { id: string | null | undefined }) {
  const p = useThreadPage(id);
  if (!p) return null;
  return (
    <a className="pg-ref" href={pageHref(p)} style={pageStyle(p)}>
      <span className="pg-ico">{p.emoji || "📄"}</span>
      <span className="pg-ref-in">
        <b>{p.title}</b>
        {p.about && <small>{p.about}</small>}
      </span>
      <span className="pg-ref-v">{p.archived ? "Archived" : `v${p.version}`}</span>
    </a>
  );
}
export function NoteRef({ id }: { id: string | null | undefined }) {
  const n = useThreadNote(id);
  if (!n) return null;
  return (
    <a className="pg-ref nt-ref" href={noteHref(n.id)}>
      <span className="pg-ico">{n.emoji || "📄"}</span>
      <span className="pg-ref-in">
        <b>{n.title}</b>
        {n.start && <small>{n.start}</small>}
      </span>
      <span className="pg-ref-v">{n.comments ? plural(n.comments, "comment") : "Note"}</span>
    </a>
  );
}
export function GroupRef({ id }: { id: string | null | undefined }) {
  const g = useThreadGroup(id);
  if (!g) return null;
  const brief = String(g.brief || "").split("\n").find((l) => l.trim()) || "";
  return (
    <a className="pg-ref gr-ref" href={groupHref(g)} style={groupStyle(g)}>
      <span className="gr-ico">{g.emoji || "👥"}</span>
      <span className="pg-ref-in">
        <b>{g.name}</b>
        {brief && <small>{brief.replace(/[*`]/g, "")}</small>}
      </span>
      <span className="pg-ref-v">{g.archived ? "Archived" : plural(g.posts, "thread")}</span>
    </a>
  );
}

// The tasks a thread is on: on your Tasks (yours, or shared with you), not the to-dos it left on itself.
const threadTasks = (s: Thread, tasks: TaskRow[] = getApp().data?.tasks || []) => tasks.filter((t) => !t.scope && t.posts?.some((e) => e.post === s.id));
const groupIn = (g: GroupRow | null | undefined) => g?.mine !== false || !!(g as GroupRow & { in?: boolean })?.in;
const groupMine = (g: GroupRow | null | undefined) => g?.mine !== false;
const pageById = (id: string | null | undefined) => (getApp().data?.pages || []).find((p) => p.id === id);
const groupById = (id: string | null | undefined) => (getApp().data?.groups || []).find((g) => g.id === id);
const taskById = (id: string | null | undefined) => (getApp().data?.tasks || []).find((t) => t.id === id);

// A thread onto a task (`on`), or off it, from its card; with Undo.
export async function putTask(s: Thread, tid: string, on: boolean) {
  const t = taskById(tid);
  const r = await post(`/api/tasks/${encodeURIComponent(tid)}/link`, { post: s.id, linked: on });
  if (r?.ok) toast(on ? `${s.label} is on ${t?.text || "the task"}.` : `${s.label} is off ${t?.text || "the task"}.`, { label: "Undo", run: () => putTask(threadRow(s.id) || s, tid, !on) });
}
// A new task with the thread on it, named after what you typed in the menu's find box, or after the thread; in its
// workspace, and in its group when that's one of yours.
async function putNewTask(s: Thread, typed: string) {
  const text = typed.trim() || s.title || s.label;
  const g = s.group && groupById(s.group);
  // Linked as Link a thread links one (its agent hears of it), not with the task's `posts`.
  const r = await post("/api/tasks", { text, workspace: s.workspace || undefined, group: g && groupMine(g) ? g.id : undefined });
  if (r?.ok && (await post(`/api/tasks/${encodeURIComponent(r.data.id)}/link`, { post: s.id })).ok) toast(`${s.label} is on a new task, “${text}”.`, { label: "Open", run: () => go(taskHref(r.data.id)) });
}
// A thread into one of your groups (`v`: its id), out of the one it's in ("~none"), or into a new one ("~new", or
// "~new:" and its name): from its page's Group card, or its card's + menu.
export async function threadGroupTo(s: Thread, v: string, { undo = false } = {}) {
  // New group, named after what you typed in the menu's find box.
  if (v === "~new" || v.startsWith("~new:")) {
    // Groups, with its New group form open and the thread going in it.
    if (v.length > 5) setDraft("group-name", v.slice(5));
    openNewGroup(s.id);
    return;
  }
  const was = s.group && groupById(s.group);
  const back = undo ? { label: "Undo", run: () => threadGroupTo(threadRow(s.id) || s, was?.id || "~none") } : undefined;
  if (v === "~none") {
    if ((await post(`/api/groups/${encodeURIComponent(s.group)}/threads`, { post: s.id, remove: true })).ok) toast(`${s.label} is out of ${was?.name || "its group"}. It stops hearing from it.`, back);
    return;
  }
  const g = groupById(v);
  if ((await post(`/api/groups/${encodeURIComponent(v)}/threads`, { post: s.id })).ok) toast(`${s.label} is in ${g?.name}${was ? `, out of ${was.name}` : ""}. It hears the brief and who else is there with its next message.`, back);
}
// A thread into a group or onto a page (`to`: its id), moving it out of the one of that kind it's in, or out of it
// (`to` null), from its card; with Undo, which puts it back where it was.
export async function putIn(s: Thread, kind: string, to: string | null) {
  if (kind === "group") return threadGroupTo(s, to || "~none", { undo: true });
  const was = s.page && pageById(s.page);
  const undo = { label: "Undo", run: () => putIn(threadRow(s.id) || s, kind, was?.id || null) };
  const p = to && pageById(to);
  const r = to ? await post(`/api/pages/${encodeURIComponent(to)}/threads`, { post: s.id }) : was && (await post(`/api/pages/${encodeURIComponent(was.id)}/threads`, { post: s.id, remove: true }));
  if (r?.ok) toast(to ? `${s.label} is on ${p?.title || "the page"}${was ? `, off ${was.title}` : ""}. It's one of the page's threads, and hears about it with its next message.` : `${s.label} is off ${was?.title}.`, undo);
}

// + on a card: one menu of your open tasks, your groups and your pages (yours, and the ones you help keep), with a tick
// on what it's in. A thread is on any number of tasks, so a task's row adds it to that one too; a group's or a page's
// moves it out of the one of that kind it's in. A ticked row takes it out. New task makes one with it on it, and New
// group one with it in, each named after what you typed (a new task, after the thread's title when you typed
// nothing).
const PUT_TASKS = 5;
function putRows(s: Thread): MenuRow[] {
  const d = getApp().data;
  const g = s.group && groupById(s.group);
  const p = s.page && pageById(s.page);
  // The tasks it's on first, then the top of your open ones in your order; the rest show when you type.
  const on = threadTasks(s);
  const rest = (d?.tasks || []).filter((t) => !t.done && !t.scope && !on.includes(t)).sort((a, b) => a.rank - b.rank).slice(0, 200);
  const tasks = [...on, ...rest];
  const later = rest.length > PUT_TASKS + 1 ? new Set(rest.slice(PUT_TASKS)) : new Set<TaskRow>();
  const groups = (d?.groups || []).filter((y) => !y.archived && groupIn(y));
  const pages = (d?.pages || []).filter((y) => !y.archived && (y.mine || y.can_edit));
  const rows = <Y extends { id: string }>(kind: string, list: Y[], cur: Y | null | undefined, name: (y: Y) => string, face: (y: Y) => React.ReactNode): MenuRow[] =>
    list.map((y) => ({ value: `${kind}|${y.id}`, text: name(y), face: face(y), on: y === cur, title: y === cur ? `${kind === "page" ? "Take it off" : "Take it out of"} ${name(y)}` : cur ? `Moves it out of ${name(cur)}` : "" }));
  return [
    ...(tasks.length ? [{ divider: "Task" }, ...tasks.map((t) => ({ value: `task|${t.id}`, text: t.text, face: <Icon name="tasks" />, note: t.done ? "done" : t.mine !== false ? "" : `@${t.owner_name}`, on: on.includes(t), later: later.has(t), title: on.includes(t) ? `Take it off ${t.text}` : "" })), ...(later.size ? [{ hint: `${later.size} more: type to find one` }] : [])] : []),
    ...(groups.length
      ? [
          { divider: "Group" },
          ...rows("group", groups, g || null, (y) => y.name, (y) => (
            <span className="gr-ico" style={groupStyle(y)}>
              {y.emoji || "👥"}
            </span>
          )),
        ]
      : []),
    ...(pages.length
      ? [
          { divider: "Page" },
          ...rows("page", pages, p || null, (y) => y.title, (y) => (
            <span className="pg-ico" style={pageStyle(y)}>
              {y.emoji || "📄"}
            </span>
          )),
        ]
      : []),
    { divider: "" },
    { value: "~new-task", text: "New task…", face: <Icon name="plus" />, make: "New task", of: "task", title: `A task named after what you type, or “${s.title || s.label}”, with this thread on it` },
    { value: "~new-group", text: "New group…", face: <Icon name="plus" />, make: "New group", of: "group" },
  ];
}
async function putPick(s: Thread, v: string) {
  if (v.startsWith("~new-group")) return threadGroupTo(s, `~new${v.slice(10)}`);
  if (v.startsWith("~new-task")) return putNewTask(s, v.slice(10));
  const [kind, to] = v.split("|");
  if (kind === "task") return putTask(s, to, !threadTasks(s).some((t) => t.id === to));
  const cur = kind === "group" ? s.group : s.page;
  await putIn(s, kind, to === cur ? null : to);
}

// In a card's head, the tasks a thread of yours is on, the page it's on and the group it's in, each a chip with × over
// its end (while you point at it) that takes it out; then + (putMenu), which puts it in one.
// Someone else's: its page and group, as chips.
export function PutChips({ thread: s }: { thread: Thread }) {
  const mine = s.mine !== false && !s.talk;
  const p = useThreadPage(s.page);
  const g = useThreadGroup(s.group);
  const allTasks = useApp((st) => st.data?.tasks);
  const tasks = mine ? threadTasks(s, allTasks || []).filter((t) => !t.done) : [];
  const out = (title: string, run: () => void) =>
    mine ? (
      <button className="put-x" type="button" title={title} aria-label={title} onClick={run}>
        <Icon name="x" />
      </button>
    ) : null;
  return (
    <>
      {tasks.map((t) => (
        <span className="put-in put-in--set" key={t.id}>
          <a className="chip chip--set" href={taskHref(t)} title={`On the task ${t.text}`}>
            <Icon name="tasks" />
            <span>{t.text}</span>
          </a>
          {out(`Take it off ${t.text}`, () => putTask(s, t.id, false))}
        </span>
      ))}
      {p && (
        <span className="put-in" style={pageStyle(p)}>
          <PageChipOf page={p} />
          {out(`Take it off ${p.title}`, () => putIn(s, "page", null))}
        </span>
      )}
      {g && (
        <span className="put-in" style={groupStyle(g)}>
          <GroupChip group={g} />
          {out(`Take it out of ${g.name}`, () => putIn(s, "group", null))}
        </span>
      )}
      {mine && <PutMenu thread={s} />}
    </>
  );
}
function PutMenu({ thread: s }: { thread: Thread }) {
  useApp((st) => st.data);
  return (
    <>
      <MenuPick id={`put:${s.id}`} label="Task, group or page" title="Add it to a task, a group or a page" face={<Icon name="plus" />} rows={putRows(s)} none find what="task, group or page" btnClass="put-add" menuClass="put-menu" unpick onPick={(v) => putPick(s, v)} />
    </>
  );
}

export function GuestFaces({ thread: s }: { thread: Thread }) {
  const gs = guestsOn(s);
  if (!gs.length) return null;
  return (
    <span className="with-mini" title={`With ${gs.map((g) => `${g.label || agentOf(g.agent).name} (${agentOf(g.agent).name})`).join(", ")}`}>
      with{" "}
      <span className="faces">
        {gs.map((g) => (
          <Avatar key={g.id} agent={g.agent} size="av--xs" />
        ))}
      </span>
    </span>
  );
}

// `page`: name the page it's on, in its card in a list; its own view shows that page in full under its title.
export function PostHead({ thread: s, page = false }: { thread: Thread; page?: boolean }) {
  const ws = useApp(() => workspaces().find((w) => w.id === workspaceIds(s)[0]));
  const note = useThreadNote(page ? s.id : null);
  const owner = postOwner(s);
  return (
    <header className="post-head">
      <a href={agentHref(s.agent)}>
        <Avatar agent={s.agent} on={s.effective !== "done"} />
      </a>
      <div className="post-who">
        {s.mine === false && (
          <>
            <a className="on" href={personHref(owner)}>
              @{owner}'s
            </a>{" "}
          </>
        )}
        <a href={agentHref(s.agent)}>
          <b className={s.agent == null ? "redacted" : undefined}>{agentName(s.agent)}</b>
          {agentOf(s.agent).offline && (
            <>
              {" "}
              <span className="on">offline</span>
            </>
          )}
        </a>{" "}
        <span className="verb">{s.effective === "waiting" ? `is waiting for @${owner}` : verb(s)}</span>
        <div className="post-meta">
          {s.pinned && (
            <span className="pinned" title="Pinned">
              <Icon name="pin" />
            </span>
          )}
          <span className="chip">
            <Hl text={s.label} />
          </span>
          {s.repo && <WsChip ws={ws} name={<Hl text={s.repo} />} where={tildeOn(machineOf(s), s.root || "")} />}
          {page && <PutChips thread={s} />}
          {note && <NoteChip note={note} />}
          {s.branch && s.branch !== "HEAD" && <BranchChip thread={s} />}
          <FromChip thread={s} />
          <span title={`Started ${new Date(s.started).toLocaleString()}`}>{ago(s.state === "done" && s.ended ? s.ended : s.updated)}</span>
          <StatusChip thread={s} />
          <WhereChip thread={s} />
          <LoopChip thread={s} />
          {page && <GuestFaces thread={s} />}
          {seen(s).routine && (
            <a className="chip chip--loop" href={myRoutineHref(seen(s).routine.id)} title={`A run of the routine ${seen(s).routine.name}`}>
              <Icon name="repeat" />
              {seen(s).routine.name}
            </a>
          )}
        </div>
      </div>
      <ThreadCorner s={s} />
    </header>
  );
}
export const threadHue = (s: Thread) => hueVars(s.agent);
