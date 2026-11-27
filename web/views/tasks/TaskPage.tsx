// A task's page (#/tasks/:id): where it stands, its title and all of its body, the threads on it (any number: the
// ones it was sent to, the ones linked to it from here or from a thread, the one that left it to you), and the work
// in progress of those threads, each branch and pull request. You edit, tick, send and delete it here as on your
// list, and link a thread to it or unlink one. Clicking a task's title anywhere opens it.
import { useEffect, useState, type ReactNode } from "react";
import { agentName, workspaces } from "../../lib/agents.ts";
import { ago, agoText, pageStyle } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { pageHref, threadHref, useRoute } from "../../lib/route.ts";
import { takeRows, useApp } from "../../lib/store.ts";
import type { TaskRow, TaskSeen, Thread } from "../../lib/types.ts";
import { Avatar, PersonAvatar } from "../../components/Avatar.tsx";
import { Composer } from "../../components/Composer.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { MenuPick } from "../../components/MenuPick.tsx";
import { Shell, ShellMsg } from "../../components/Shell.tsx";
import { LaunchRow, ThreadRow } from "../../components/ThreadRow.tsx";
import { LEVEL_SHOWN, LEVELS, levelOf, TaskCorner } from "../../components/Visibility.tsx";
import { linked } from "../../components/thread/Plain.tsx";
import { GroupChip, PgIco, WsChip } from "../../components/tasks/Chips.tsx";
import { SetChanges, setChangesCount, setChgParts, setStory, TaskShipCard, type HistEvent } from "../../components/tasks/ShipCard.tsx";
import { TaskEditForm, TaskFaces, TaskSource, TaskSourceNote, TaskTick } from "../../components/tasks/TaskRow.tsx";
import { addTaskPerson, atNames, connectorName, deleteTask, editTask, groupById, leaveTask, linkableThreads, linkPage, linkThread, me, pageById, removeTaskPerson, setUi, taskById, taskMine, taskPageIds, taskPagesOf, taskPeople, taskStatus, threadsOnTask, useTasksUi } from "../../components/tasks/tasks.ts";
import { post } from "../../lib/api.ts";
import { shipOfTask, type TaskShip } from "../../components/worktrees/ship.ts";
import { sessionById, useWorld } from "../../components/worktrees/wips.ts";
import { AskedElsewhere, ThreadsElsewhere } from "../../components/people/AskedElsewhere.tsx";

function Facts({ items, acts = null }: { items: [IconName | "", ReactNode, string?][]; acts?: ReactNode }) {
  const list = items.filter(([, node]) => node);
  if (!list.length && !acts) return null;
  return (
    <div className="wip-facts">
      {list.map(([ico, node, title], i) => (
        <span className="wf" key={i} title={title || undefined}>
          {ico ? <Icon name={ico} /> : null}
          <span>{node}</span>
        </span>
      ))}
      {acts}
    </div>
  );
}
// Its work, in tabs: each [key, label, { n, node }] (or none, to leave one out); the first open unless you picked
// another.
function Tabs({ tabs, on, pick }: { tabs: [string, string, { n?: ReactNode; node: ReactNode } | null][]; on: string; pick: (k: string) => void }) {
  const list = tabs.filter(([, , t]) => t);
  if (!list.length) return null;
  const at = list.find(([k]) => k === on) || list[0];
  return (
    <>
      <nav className="wip-tabs" role="tablist">
        {list.map(([k, label, t]) => (
          <button key={k} type="button" role="tab" className={k === at[0] ? "is-on" : ""} aria-selected={k === at[0]} onClick={() => pick(k)}>
            {label}
            {t.n != null && t.n !== "" && t.n !== 0 ? <span className="n">{t.n}</span> : null}
          </button>
        ))}
      </nav>
      <div className="wip-tab" role="tabpanel">
        {at[2].node}
      </div>
    </>
  );
}

const TaskWord = ({ t }: { t: TaskRow }) => {
  const st = taskStatus(t);
  return (
    <span className={`wst tst--${st.k}`}>
      {st.icon ? <Icon name={st.icon as IconName} /> : <i className="pulse" />}
      {st.word}
    </span>
  );
};

// Its head: where it stands and where it lives, its title with its tick box, all of its body, and a line of who
// it's from and for, with Delete at its end. Click the title or the body to edit them.
function TaskHead({ t }: { t: TaskRow }) {
  const editing = useTasksUi((s) => s.taskEdit === t.id);
  const sharing = useTasksUi((s) => s.taskShare === t.id);
  const ws = t.workspace && workspaces().find((w) => w.id === t.workspace);
  const gr = t.group && groupById(t.group);
  // One you're not on (a public one, by its link) is only to read.
  const ro = t.on === false;
  // Its title and body are its owner's to change, and ticking it off.
  const fixed = ro || !taskMine(t);
  const note = t.note?.trim();
  const edit = (at: string | null) => (e: React.MouseEvent) => !(e.target as HTMLElement).closest("a, button") && editTask(taskById(t.id), at);
  const body = editing ? null : note ? (
    <div className="tk-body" onClick={fixed ? undefined : edit("note")}>
      {linked(note)}
    </div>
  ) : t.done || fixed ? null : (
    <div className="tk-body is-empty" onClick={edit("note")}>
      Add details
    </div>
  );
  const title = editing ? (
    <TaskEditForm t={t} />
  ) : (
    <h1 className="wip-title tk-title" title={t.done || fixed ? undefined : "Click to edit"} onClick={t.done || fixed ? undefined : edit(null)}>
      {t.text}
    </h1>
  );
  const from = t.from && sessionById(t.from);
  const by = t.done && t.done_by === "agent" ? sessionById(t.done_post) : null;
  const toggleShare = () => setUi({ taskShare: sharing ? null : t.id, shareAsk: null });
  // Yours: Share (not a thread's own to-do) and Delete. Shared with you: Leave. A public one you're not on: nothing.
  const acts =
    editing || t.on === false ? null : taskMine(t) ? (
      <span className="tk-acts">
        {t.scope ? null : (
          <button className={`wf-btn wf-btn--plain${sharing ? " is-on" : ""}`} type="button" aria-expanded={sharing} title="Put people on it, and say who sees it" onClick={toggleShare}>
            <Icon name="group" />
            Share
          </button>
        )}
        <button className="wf-btn" type="button" title="Delete it, with Undo for a few seconds" onClick={() => void deleteTask(t)}>
          <Icon name="x" />
          Delete
        </button>
      </span>
    ) : (
      <span className="tk-acts">
        <button className="wf-btn" type="button" title="Take yourself off it: it leaves your Tasks, and its threads stop showing to you" onClick={() => void leaveTask(t, t.id)}>
          <Icon name="out" />
          Leave
        </button>
      </span>
    );
  // Who's on it, when that's more than you alone. Who sees it is its corner's to say (TaskCorner).
  const others = taskPeople(t).filter((u) => u !== me());
  const rest = others.filter((u) => u !== t.owner_name);
  const who = others.length ? (
    <>
      <TaskFaces t={t} whose={false} />
      <span>
        {taskMine(t) ? (
          <>
            Shared with <b>{atNames(others)}</b>
          </>
        ) : (
          <>
            <b>@{t.owner_name}</b>'s{t.on === false ? (rest.length ? `, shared with ${atNames(rest)}` : "") : `, shared with you${rest.length ? ` and ${atNames(rest)}` : ""}`}
          </>
        )}
      </span>
    </>
  ) : null;
  const done = t.done ? (
    <>
      Done {agoText(t.done_at)}
      {by ? (
        <>
          , ticked off by{" "}
          <a href={threadHref(by.id)}>
            <b>{by.label}</b>
          </a>
        </>
      ) : t.done_by === "sync" ? (
        `, closed in ${connectorName(t.source || {})}`
      ) : t.done_user && t.done_user !== me() ? (
        <>
          , ticked off by <b>@{t.done_user}</b>
        </>
      ) : null}
    </>
  ) : null;
  return (
    <article className={`card wip-page tk-page${t.done ? " is-done" : ""}`}>
      <TaskCorner task={t} cls=" vis-corner--card" />
      <div className="wip-ref">
        <TaskWord t={t} />
        <TaskSource t={t} />
        {ws ? <WsChip w={ws} /> : null}
        {gr ? <GroupChip g={gr} /> : null}
      </div>
      <div className="tk-top">
        <TaskTick t={t} title />
        {title}
      </div>
      {body}
      <Facts
        items={[
          ["clock", t.at ? `Added ${agoText(t.at)}` : "", t.at ? new Date(t.at).toLocaleString() : ""],
          [
            "",
            from ? (
              <>
                <Avatar agent={from.agent} size="av--xs" />
                <span>
                  from{" "}
                  <a href={threadHref(from.id)}>
                    <b>{from.label || agentName(from.agent)}</b>
                  </a>
                </span>
              </>
            ) : null,
          ],
          [
            "",
            t.agent && !t.done ? (
              <>
                <Avatar agent={t.agent} size="av--xs" />
                <span>
                  for <b>{agentName(t.agent)}</b>
                </span>
              </>
            ) : null,
            t.agent ? `It goes to ${agentName(t.agent)} when you send it` : "",
          ],
          ["check", done],
          ["", who],
        ]}
        acts={acts}
      />
      <TaskSourceNote t={t} />
      {sharing && taskMine(t) ? <TaskSharePanel t={t} /> : null}
    </article>
  );
}

// Sharing it, its owner's, under its head: who's on it (× takes one off), adding someone
// (agentbook first says which of your private threads they'll see), and who sees it besides them. The people on it see
// its threads' work too, always: there's no switch for it.
function TaskSharePanel({ t }: { t: TaskRow }) {
  const people = useApp((s) => s.people);
  const ask = useTasksUi((s) => (s.shareAsk?.task === t.id ? s.shareAsk : null));
  const [user, setUser] = useState("");
  const on = new Set(taskPeople(t));
  const row = (u: string, what: string, x: ReactNode = null) => (
    <div className="tk-person" key={u}>
      <PersonAvatar who={u} size="av--sm" />
      <span>
        <b>{u === me() ? "You" : `@${u}`}</b>
        <small>{what}</small>
      </span>
      {x}
    </div>
  );
  const can = (people || []).filter((u) => u.contact && !on.has(u.username) && !u.disabled && !u.deleted);
  const level = levelOf(t.visibility);
  const says = { public: "Your contacts see it by its link too, with only the threads on it that they'd see anyway.", private: "Only you and the people on it." };
  return (
    <section className="tk-share" aria-label="Share it">
      <p className="tk-share-h">
        Share it
        <button className="icon-btn" type="button" aria-label="Close" title="Close" onClick={() => setUi({ taskShare: null, shareAsk: null })}>
          <Icon name="x" />
        </button>
      </p>
      <div className="tk-people">
        {row(t.owner_name || me(), "Its owner: says who's on it and who sees it")}
        {(t.people || []).map((p) =>
          row(
            p.user,
            `On it since ${agoText(p.at)}`,
            <button className="icon-btn" type="button" title={`Take @${p.user} off it: it leaves their Tasks, and its threads stop showing to them`} aria-label={`Take @${p.user} off it`} onClick={() => void removeTaskPerson(t.id, p.user)}>
              <Icon name="x" />
            </button>,
          ),
        )}
      </div>
      {ask ? (
        <div className="tk-share-ask">
          <p>{ask.text}</p>
          <span className="gate-btns">
            <button className="btn btn--dark btn--sm" type="button" onClick={() => void addTaskPerson(t, ask.user, true)}>
              Add @{ask.user}
            </button>
            <button className="btn btn--line btn--sm" type="button" onClick={() => setUi({ shareAsk: null })}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <>
          <form className="tk-share-add" onSubmit={(e) => (e.preventDefault(), user.trim() && void addTaskPerson(t, user))}>
            <input name="user" list={`tk-people-${t.id}`} value={user} onChange={(e) => setUser(e.target.value)} placeholder="Add someone: @username" autoComplete="off" aria-label="Add someone by their username" />
            <datalist id={`tk-people-${t.id}`}>
              {can.map((u) => (
                <option key={u.username} value={u.username}>
                  {u.display_name || u.username}
                </option>
              ))}
            </datalist>
            <button className="btn btn--sm" type="submit">
              Add
            </button>
          </form>
          {can.length ? (
            <div className="tk-share-sugg">
              {can.slice(0, 6).map((u) => (
                <button key={u.username} className="chip chip--add" type="button" title={`Put @${u.username} on it`} onClick={() => void addTaskPerson(t, u.username)}>
                  <PersonAvatar who={u.username} size="av--xs" />@{u.username}
                </button>
              ))}
            </div>
          ) : people ? (
            <p className="muted tk-share-none">Everyone here is on it.</p>
          ) : null}
        </>
      )}
      <AskedElsewhere kind="task" id={t.id} />
      <div className="tk-share-vis">
        <span className="tk-share-l">Who sees it</span>
        <span className="seg">
          {LEVELS.map((v) => (
            <button key={v} type="button" className={v === level ? "is-on" : ""} aria-pressed={v === level} onClick={() => void post(`/api/tasks/${encodeURIComponent(t.id)}/visibility`, { visibility: v })}>
              {LEVEL_SHOWN[v][1]}
            </button>
          ))}
        </span>
        <small>{says[level]}</small>
      </div>
      <p className="muted tk-share-note">Everyone on it sees every thread on it, a private one too, with its steps, changes and files. They add their own threads; the rest is yours, ticking it off too. A thread is still steered only by its owner.</p>
    </section>
  );
}

// Its threads, a row each as in the feed, with its status chip and an × that unlinks it; the ones it just went out
// as, starting; and Link a thread, which finds any thread of yours. The composer above them starts another on it.
function TaskThreadsCard({ t, threads }: { t: TaskRow; threads: Thread[] }) {
  const launches = useApp((s) => s.data?.launches);
  const starting = (t.sent || [])
    .filter((e) => !e.post)
    .map((e) => (launches || []).find((l) => l.id === e.launch))
    .filter(Boolean);
  const more = linkableThreads(new Set(threads.map((s) => s.id)));
  const n = threads.length + starting.length;
  return (
    <section className="card tk-sec tk-threads-card">
      <h2 className="tk-h">
        Threads
        {n ? <span className="n">{n}</span> : null}
        <span className="tk-h-end">
          {more.length ? (
            <MenuPick
              id={`task-link:${t.id}`}
              label="Thread"
              title="Link a thread to this task"
              face={
                <>
                  <Icon name="link" />
                  <span className="opt-v">Link a thread</span>
                </>
              }
              none
              rows={more.map((s) => ({ value: s.id, text: s.title || s.label, face: <Avatar agent={s.agent} size="av--xs" />, note: ago(s.updated || s.started) }))}
              onPick={(v) => v && void linkThread(t.id, v)}
            />
          ) : null}
        </span>
      </h2>
      {starting.length || threads.length ? (
        <ul className="act-list tk-threads">
          {starting.map((l) => (
            <li key={l.id}>
              <LaunchRow launch={l} />
            </li>
          ))}
          {threads.map((s) => (
            <li className="tk-thread" key={s.id}>
              <ThreadRow thread={s} />
              {/* Only a thread's owner, or the task's, unlinks it; you link your own threads. */}
              {taskMine(t) || s.mine !== false ? (
                <button className="icon-btn" type="button" title="Unlink it from this task" aria-label="Unlink it from this task" onClick={() => void linkThread(t.id, s.id, false)}>
                  <Icon name="x" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {n ? null : (
        <p className="muted tk-empty">
          No threads on it yet.{t.done ? "" : " Start one above, or link one that works on it."}
        </p>
      )}
    </section>
  );
}

// Its pages, any number, as its threads: a row each as in the feed, with an × that unlinks it, and Link a page,
// which finds any page you see. A page lists the tasks linked to it (its checklist, and its head), and an agent
// that writes a page's checklist links the tasks on it. None, and done: no card. Its pages are its owner's to
// change: someone it's shared with sees the ones they see, and no × or Link.
function TaskPagesCard({ t }: { t: TaskRow }) {
  const all = useApp((s) => s.data?.pages);
  const on = new Set(taskPageIds(t));
  const pages = taskPagesOf(t);
  const own = taskMine(t);
  if (!pages.length && (t.done || !own)) return null;
  const by = new Map((t.pages || []).map((e) => [e.page, e]));
  const more = (all || []).filter((p) => !p.archived && !on.has(p.id)).sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || (b.updated || "").localeCompare(a.updated || ""));
  return (
    <section className="card tk-sec tk-pages-card">
      <h2 className="tk-h">
        Pages
        {pages.length ? <span className="n">{pages.length}</span> : null}
        <span className="tk-h-end">
          {own && more.length && !t.done ? (
            <MenuPick
              id={`task-page:${t.id}`}
              label="Page"
              title="Link a page to this task"
              face={
                <>
                  <Icon name="link" />
                  <span className="opt-v">Link a page</span>
                </>
              }
              none
              rows={more.map((p) => ({ value: p.id, text: p.title, face: <PgIco p={p} />, note: ago(p.updated) }))}
              onPick={(v) => v && void linkPage(t.id, v)}
            />
          ) : null}
        </span>
      </h2>
      {pages.length ? (
        <ul className="act-list tk-threads">
          {pages.map((p) => {
            const e = by.get(p.id);
            const why = [p.about || (p.last?.summary ? `v${p.version}: ${p.last.summary}` : ""), e?.by === "agent" ? "on its checklist" : ""].filter(Boolean).join(" · ");
            return (
              <li className="tk-thread" key={p.id}>
                <a className="act-row" href={pageHref(p)} style={pageStyle(p)}>
                  <span className="pg-ico">{p.emoji || "📄"}</span>
                  <span>
                    <b>{p.title}</b>
                    {why ? <small>{why}</small> : null}
                  </span>
                  {p.archived ? <span className="chip">Archived</span> : null}
                  <time>{ago(p.updated)}</time>
                </a>
                {own ? (
                  <button className="icon-btn" type="button" title="Unlink it from this task" aria-label="Unlink it from this task" onClick={() => void linkPage(t.id, p.id, false)}>
                    <Icon name="x" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {pages.length ? null : <p className="muted tk-empty">On no page. Link one, and the page lists it with its tasks.</p>}
    </section>
  );
}

// What happened to it, oldest first: added (or left to you, or brought in by a connector), each time it was sent,
// each thread linked to it and by whom, what happened to what it ships (setStory), and ticked off.
function taskHistory(t: TaskRow, x: TaskShip): HistEvent[] {
  const ev = setStory(x);
  const who = (s: Thread | undefined) =>
    s ? (
      <a className="who" href={threadHref(s.id)}>
        {s.label || agentName(s.agent)}
      </a>
    ) : (
      "A thread"
    );
  const name = (s: Thread | undefined) => (s ? <a href={threadHref(s.id)}>{s.title || s.label}</a> : "a thread");
  const from = t.from && sessionById(t.from);
  // A person: you, or someone else on a task shared with you; one from before tasks were shared is its owner.
  const person = (u: string | null | undefined) => (!u || u === me() ? "You" : <b>@{u}</b>);
  if (t.at)
    ev.push({
      at: t.at,
      node: t.from ? (
        <span>
          {who(from)} left it for {taskMine(t) ? "you" : <b>@{t.owner_name}</b>}
        </span>
      ) : t.source ? (
        <span>
          It came in from {connectorName(t.source)}
          {t.source.key ? ` (${t.source.key})` : ""}
        </span>
      ) : (
        <span>{person(t.owner_name)} added it</span>
      ),
    });
  for (const e of t.sent || [])
    ev.push({
      at: e.at,
      node: (
        <span>
          {person(e.user || t.owner_name)} sent it to <b>{agentName(e.agent) || "an agent"}</b>
        </span>
      ),
    });
  for (const e of t.posts || []) {
    if (e.post === t.from) continue;
    const s = sessionById(e.post);
    ev.push({
      at: e.at,
      node:
        e.by === "you" ? (
          <span>
            {person(e.user || t.owner_name)} linked {name(s)}
          </span>
        ) : e.by === "agent" ? (
          <span>{who(s)} linked its thread</span>
        ) : (
          <span>{who(s)} started on it</span>
        ),
    });
  }
  for (const e of t.pages || []) {
    const p = pageById(e.page);
    if (!p || !e.at || e.at === t.at) continue;
    ev.push({
      at: e.at,
      node: (
        <span>
          {e.by === "agent" ? "An agent put it" : "You put it"} on <a href={pageHref(p)}>{p.title}</a>
        </span>
      ),
    });
  }
  if (t.done && t.done_at) {
    const by = t.done_by === "agent" ? sessionById(t.done_post) : null;
    ev.push({ at: t.done_at, cls: "landed", node: by ? <span>{who(by)} ticked it off</span> : t.done_by === "sync" ? <span>{connectorName(t.source || {})} closed it</span> : <span>{person(t.done_user || t.owner_name)} ticked it off</span> });
  }
  return ev.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
function TaskHistory({ ev }: { ev: HistEvent[] }) {
  const all = useTasksUi((s) => s.wipAll);
  const shown = all ? ev : ev.slice(-20);
  return (
    <ol className="tk-hist">
      {ev.length > shown.length ? (
        <li className="more">
          <button type="button" onClick={() => setUi({ wipAll: true })}>
            Show {ev.length - shown.length} earlier
          </button>
        </li>
      ) : null}
      {shown.map((e, i) => (
        <li key={i} className={e.cls || undefined}>
          {e.node}
          <time title={new Date(e.at).toLocaleString()}>{agoText(e.at)}</time>
        </li>
      ))}
    </ol>
  );
}

// A task that isn't on your list: one you're not on, opened by its link (a public one), as
// the server has it, with the threads on it you may see; or, gone, a word that it is.
function TaskSeenPage({ id }: { id: string }) {
  const seen = useLoad<TaskSeen>(`/api/tasks/${encodeURIComponent(id)}`);
  useWorld();
  // Its threads as rows the page has, for what it ships to say who's on each.
  useEffect(() => void (seen.data && takeRows(seen.data.threads)), [seen.data]);
  if (seen.loading && !seen.data)
    return (
      <ShellMsg back={false}>
        <p className="muted">Loading…</p>
      </ShellMsg>
    );
  if (seen.error || !seen.data?.task)
    return (
      <ShellMsg back={false}>
        <p>This task isn't on your list anymore: it was deleted, or done more than two weeks ago.</p>
        <a className="btn" href="#/tasks">
          Your Tasks
        </a>
      </ShellMsg>
    );
  const t: TaskRow = { ...seen.data.task, on: seen.data.task.on ?? taskMine(seen.data.task) };
  const rows = seen.data.threads || [];
  // What it ships and its History, only to read.
  const x = shipOfTask(t);
  const hist = taskHistory(t, x);
  return (
    <Shell>
      <p className="crumbs">
        <a href="#/tasks">Tasks</a>
        <span className="sep">/</span>
        <span>{t.text}</span>
      </p>
      <div className="feed">
        <TaskHead t={t} />
        <section className="card tk-sec">
          <h2 className="tk-h">
            Threads<span className="n">{rows.length || ""}</span>
          </h2>
          {rows.length ? (
            <ul className="tk-threads">
              {rows.map((s) => (
                <li className="tk-thread" key={s.id}>
                  <ThreadRow thread={s} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None you can see: only the public ones on it show to you.</p>
          )}
          <p className="muted tk-seen-note">You're not on this task. @{t.owner_name || "its owner"} puts people on it.</p>
        </section>
        {x.parts.length ? <TaskShipCard t={t} x={x} /> : null}
        {hist.length ? (
          <section className="card tk-sec">
            <h2 className="tk-h">History</h2>
            <TaskHistory ev={hist} />
          </section>
        ) : null}
      </div>
    </Shell>
  );
}

export function TaskPage() {
  const route = useRoute();
  useWorld();
  const [tab, setTab] = useState("history");
  const t = taskById(route.id);
  if (!t) return <TaskSeenPage id={route.id} />;
  const threads = threadsOnTask(t);
  const x = shipOfTask(t);
  // Its History, and, once it ships two or more, what each of them changes.
  const hist = taskHistory(t, x);
  const chg = setChgParts(x).length >= 2;
  const histTab = hist.length ? { node: <TaskHistory ev={hist} /> } : null;
  return (
    <Shell>
      <p className="crumbs">
        <a href="#/tasks">Tasks</a>
        <span className="sep">/</span>
        <span>{t.text}</span>
      </p>
      <div className="feed">
        <TaskHead t={t} />
        {/* The feed's composer, for a thread on it, above its threads as on the feed (not once it's done). */}
        {t.done ? null : <Composer task={t.id} />}
        <TaskThreadsCard t={t} threads={threads} />
        {taskMine(t) ? <ThreadsElsewhere kind="task" id={t.id} card /> : null}
        <TaskPagesCard t={t} />
        <TaskShipCard t={t} x={x} />
        {chg ? (
          <section className="card tk-sec tk-tabs">
            <Tabs
              on={tab}
              pick={setTab}
              tabs={[
                ["history", "History", histTab],
                ["changes", "Changes", { n: setChangesCount(x) || "", node: <SetChanges x={x} /> }],
              ]}
            />
          </section>
        ) : hist.length ? (
          <section className="card tk-sec">
            <h2 className="tk-h">History</h2>
            <TaskHistory ev={hist} />
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
