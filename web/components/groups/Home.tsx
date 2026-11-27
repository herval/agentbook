// A group's Group tab, as a page has its Page: its feed in the middle, newest first, under the box that starts a thread
// in it; who's in it, its files and what it's for on the left; its tasks, its WIP and the notes to its threads on the
// right. Ported from the old page's groupTimeline, groupAddThread, groupLeft, groupRight, groupTasks and groupWipCard.
import { useState } from "react";
import type { FormEvent } from "react";
import { agentName } from "../../lib/agents.ts";
import { pickFile, post } from "../../lib/api.ts";
import { useChrome } from "../../lib/chrome.ts";
import { useFeedList } from "../../lib/feed.ts";
import { ago, agoText, hueVars, plural } from "../../lib/format.ts";
import { setDraft, useDraft } from "../../lib/hooks.ts";
import { groupHref, NO_SCOPE, personHref, scopeHref } from "../../lib/route.ts";
import { allRows, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, GroupView, Thread } from "../../lib/types.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../Avatar.tsx";
import { Composer } from "../Composer.tsx";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { MenuPick } from "../MenuPick.tsx";
import { HereNone, ScopeBar } from "../ScopeBar.tsx";
import { FeedCards } from "../ThreadCard.tsx";
import { TaskRowItem } from "../tasks/TaskRow.tsx";
import { addTask, openTasks, ticked } from "../tasks/tasks.ts";
import { wipHref, wipMeta, wipOrder, wipPutIn, wipWhy } from "../worktrees/wips.ts";
import type { Wip } from "../worktrees/wips.ts";
import { FindBox } from "./Find.tsx";
import { fileBase, fileDir, groupBy, groupById, groupIn, groupMine, groupPeople, groupThreads, groupWips, isImage, loadGroup, useGroupUi, wipsToAdd } from "./groups.ts";
import { ByFace, WipDot } from "./parts.tsx";
import { ThreadsElsewhere } from "../people/AskedElsewhere.tsx";
import { useHereAsk } from "../bar/scope.ts";

// Adding files to it (`dir`: the folder they go in), each as it's read: its threads hear about each.
export function groupUpload(g: GroupRow, dir = "") {
  pickFile(async (files: File[]) => {
    for (const file of files) {
      const content_base64 = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.readAsDataURL(file);
      });
      const p = dir ? `${dir}/${file.name}` : file.name;
      const res = await post(`/api/groups/${encodeURIComponent(g.id)}/files`, { path: p, content_base64 });
      if (res.ok) toast(`Added ${p} to ${g.name}'s files. Its threads hear about it with their next message.`);
    }
    loadGroup();
  }, true);
}

// Its feed, as the server lists it (q/feed, narrowed to the group), as the feed has it: the threads still starting
// on top, then the rest newest first, and the box to start one in it. Someone else sees the ones in it that they may
// see.
export function GroupTimeline({ g }: { g: GroupRow }) {
  const q = useChrome((s) => s.q);
  // Its threads, as its bar narrows them (by agent, workspace and status).
  const ask = useHereAsk("group", g.id, q);
  const feed = useFeedList(ask);
  const st = feed?.counts.states || {};
  const listed = (st.all || 0) + (st.hidden || 0) + (st.archived || 0);
  const canAdd = groupIn(g) && !g.archived;
  const empty = (
    <section className="card empty-card">
      <p>{!groupIn(g) ? "None of its threads are public." : g.archived ? "No threads in it. Bring it back to start one." : `No threads in it yet. Start one above${canAdd && addable(g).length ? ", or add one of yours" : ""}.`}</p>
      <GroupAddThread g={g} />
    </section>
  );
  return (
    <>
      <div data-key="composer">{canAdd ? <Composer group={g.id} /> : null}</div>
      <div data-key="filters">{listed ? <ScopeBar name="group" bare acts={<GroupAddThread g={g} />} /> : null}</div>
      <FeedCards feed={feed} />
      <HereNone name="group" feed={feed} count={feed?.list.length || 0} none={empty} />
    </>
  );
}

// Your threads that could go in it: any of yours that isn't in it, newest first.
const addable = (g: GroupRow) =>
  allRows()
    .filter((s) => s.mine !== false && s.group !== g.id && !s.archived)
    .sort((a, b) => String(b.updated || b.started || "").localeCompare(String(a.updated || a.started || "")))
    .slice(0, 80);
// Putting a thread of yours in it, from beside its threads: any of yours that isn't in it, newest first, found by
// its title, each with the group it's in now (a thread is in one group at most, so this takes it out of that one).
// Anyone in it adds their own.
function GroupAddThread({ g }: { g: GroupRow }) {
  useApp((s) => s.rows);
  if (!groupIn(g) || g.archived) return null;
  const rows = addable(g);
  if (!rows.length) return null;
  const note = (s: Thread) => (s.group && groupById(s.group) ? `in ${groupById(s.group).name}` : ago(s.updated || s.started));
  // In it: the thread hears the brief and who else is here with its next message.
  const pick = async (id: string) => {
    const s = threadRow(id);
    const was = s?.group && groupById(s.group);
    if ((await post(`/api/groups/${encodeURIComponent(g.id)}/threads`, { post: id })).ok) toast(`${s?.label || "It"} is in ${g.name}${was ? `, out of ${was.name}` : ""}. It hears the brief and who else is here with its next message.`);
    loadGroup();
  };
  return (
    <MenuPick
      id={`group-add:${g.id}`}
      label="Thread"
      title="Put one of your threads in the group"
      face={
        <>
          <Icon name="plus" />
          <span className="opt-v">Add a thread</span>
        </>
      }
      none
      rows={rows.map((s) => ({ value: s.id, text: s.title || s.label, face: <Avatar agent={s.agent} size="av--xs" />, note: note(s) }))}
      onPick={pick}
    />
  );
}

// The left of a group: who's in it and what each is doing, its newest files, and what it's for (its brief).
export function groupLeft(g: GroupRow, d: GroupView | null) {
  return [
    { key: "who", node: <WhoCard g={g} /> },
    { key: "files", node: <FilesCard g={g} d={d} /> },
    { key: "about", node: <AboutCard g={g} /> },
  ];
}
function AboutCard({ g }: { g: GroupRow }) {
  const isIn = groupIn(g);
  return (
    <section className="card rail-card gr-about">
      <h3 className="rail-h">
        About{isIn ? <a href={groupHref(g, "brief")}>Edit</a> : null}
      </h3>
      {g.brief?.trim() ? <Markdown text={g.brief} className="md brief" /> : <p className="muted rail-empty">{isIn ? "No brief yet. Every thread in the group is told it: the goal, the ground rules, where things go." : "No brief."}</p>}
      {isIn ? (
        <p className="rail-note">
          Every thread in it is told this when it starts, and hears when it changes.
          {groupMine(g) ? (
            <>
              {" "}
              <a href={groupHref(g, "brief")}>What it's told</a>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
function WhoCard({ g }: { g: GroupRow }) {
  const me = useApp((s) => s.me?.username);
  useApp((s) => s.rows);
  const mine = groupMine(g);
  const ts = groupThreads(g);
  // What an agent in it is doing here: asking you, working, or how many threads it has here.
  const doing = (agentId: string) => {
    const theirs = ts.filter((s) => s.agent === agentId);
    const ask = theirs.find((s) => s.effective === "needs");
    const live = theirs.find((s) => s.effective === "working");
    if (ask) return <small className="sun">{ask.label} needs you</small>;
    if (live) return <small>{`${live.label}: ${live.doing || "working"}`}</small>;
    return <small>{theirs.length ? `${plural(theirs.length, "thread")} here` : "No threads here yet"}</small>;
  };
  const owner = g.owner || "?";
  // The people in it, each with how many of their threads are here (the ones you see).
  const person = (u: string) => {
    const theirs = ts.filter((s) => (u === me ? s.mine !== false : s.owner === u));
    return (
      <div className="mem" key={`u:${u}`}>
        {u === me ? <YouAvatar size="av--sm" /> : <PersonAvatar who={u} size="av--sm" />}
        <span>
          {u === me ? (
            <b>You</b>
          ) : (
            <a href={personHref(u)}>
              <b>@{u}</b>
            </a>
          )}
          <small>{theirs.length ? `${plural(theirs.length, "thread")} here` : "In it"}</small>
        </span>
      </div>
    );
  };
  return (
    <section className="card rail-card">
      <h3 className="rail-h">
        Members<a href={groupHref(g, "members")}>{groupIn(g) ? "Change" : "All"}</a>
      </h3>
      {mine ? (
        <div className="mem">
          <YouAvatar size="av--sm" />
          <span>
            <b>You</b>
            <small>Its owner</small>
          </span>
        </div>
      ) : (
        <div className="mem">
          <PersonAvatar who={owner} size="av--sm" letter={owner[0].toUpperCase()} />
          <span>
            <a href={personHref(g.owner)}>
              <b>@{g.owner}</b>
            </a>
            <small>Its owner</small>
          </span>
        </div>
      )}
      {groupPeople(g).map(person)}
      {(g.members || [])
        .filter((m) => m.agent)
        .map((m) => (
          <div className="mem" key={`a:${m.agent}`} style={hueVars(m.agent)}>
            <Avatar agent={m.agent} size="av--sm" on={ts.some((s) => s.agent === m.agent && s.effective !== "done") ? "active" : false} />
            <span>
              <b>{agentName(m.agent)}</b>
              {doing(m.agent)}
            </span>
          </div>
        ))}
    </section>
  );
}
function FilesCard({ g, d }: { g: GroupRow; d: GroupView | null }) {
  const isIn = groupIn(g);
  const files = (d?.file_list || []).slice(0, 6);
  return (
    <section className="card rail-card">
      <h3 className="rail-h">
        Files<a href={groupHref(g, "files")}>{g.files ? `All ${g.files}` : "Open"}</a>
      </h3>
      {files.length ? (
        <ul className="rt-mini">
          {files.map((f) => (
            <li key={f.path}>
              <a href={groupHref(g, `files/${f.path}`)} title={f.path}>
                <Icon name={isImage(f.path) ? "image" : "file"} />
                <span>
                  <b>{fileBase(f.path)}</b>
                  <small>
                    {fileDir(f.path) ? `${fileDir(f.path)}/, ` : ""}
                    {agoText(f.at)} by {groupBy(f.by)}
                  </small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted rail-empty">{d ? (isIn ? "Nothing in it yet. Its threads write here, and you can add files." : "Nothing in it yet.") : "Loading…"}</p>
      )}
      {isIn && !g.archived ? (
        <button className="btn btn--sm btn--line gr-add-files" type="button" onClick={() => groupUpload(g)}>
          <Icon name="plus" />
          Add files
        </button>
      ) : null}
    </section>
  );
}

// The right of a group: its tasks and WIP (its owner's), and the notes to its threads, which anyone in it leaves.
export function groupRight(g: GroupRow, d: GroupView | null) {
  if (!groupIn(g)) return [];
  const mine = groupMine(g);
  return [
    { key: "elsewhere", node: mine ? <ThreadsElsewhere kind="group" id={g.id} card /> : null },
    { key: "tasks", node: mine ? <GroupTasks g={g} /> : null },
    { key: "wips", node: mine ? <GroupWipCard g={g} /> : null },
    { key: "notes", node: <NotesCard g={g} d={d} /> },
  ];
}

// The notes to its threads: a box to leave one (it reaches every thread in it with the next message each gets), and
// the latest, each deletable by its owner or by whoever left it.
function NotesCard({ g, d }: { g: GroupRow; d: GroupView | null }) {
  const me = useApp((s) => s.me?.username);
  useApp((s) => s.rows);
  const [text, setText] = useDraft(`group-note:${g.id}`);
  const awake = groupThreads(g).filter((s) => s.effective !== "done" && !s.archived);
  const mine = groupMine(g);
  const notes = d?.notes || [];
  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return e.currentTarget.querySelector("textarea")?.focus();
    const res = await post<{ reaches?: string[] }>(`/api/groups/${encodeURIComponent(g.id)}/notes`, { text: t });
    if (!res.ok) return;
    setText("");
    toast(res.data.reaches?.length ? `Sent. ${res.data.reaches.join(", ")} hear it with their next message.` : "Sent. Threads in the group hear it with their next message.");
    loadGroup();
  };
  // Deleting a note: threads that heard it keep what they heard.
  const drop = async (id: string) => {
    if ((await post(`/api/groups/${encodeURIComponent(g.id)}/notes/${encodeURIComponent(id)}/delete`)).ok) loadGroup();
  };
  return (
    <section className="card rail-card gnotes">
      <h3 className="rail-h">Notes</h3>
      {g.archived ? null : (
        <form className="gnote-form" onSubmit={send}>
          <div className="text-box">
            <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="A note to every thread in it…" aria-label="A note to every thread in the group" />
            <button className="icon-btn" type="submit" aria-label="Send it" title="Send it">
              <Icon name="send" />
            </button>
          </div>
          <p className="compose-reach">{awake.length ? `Reaches ${awake.map((s) => s.label).join(", ")} with the next message each gets` : "Its threads hear it with the next message each gets"}</p>
        </form>
      )}
      {notes.slice(0, 6).map((n) => (
        <div className="gnote" key={n.id}>
          <ByFace by={n.by} size="av--sm" />
          <div className="gnote-who">
            <b>{groupBy(n.by).replace(/^you$/, "You")}</b>
            <span>{agoText(n.at)}</span>
            {n.for && threadRow(n.for) ? <span className="to">for {threadRow(n.for).label}</span> : null}
            {mine || n.by?.user === me ? (
              <button className="icon-btn" type="button" aria-label="Delete the note" title="Delete it: threads that heard it keep what they heard" onClick={() => drop(n.id)}>
                <Icon name="x" />
              </button>
            ) : null}
          </div>
          <p>{n.text}</p>
        </div>
      ))}
    </section>
  );
}

// A group's tasks are yours, in it: the open ones in your order, then the ones done lately. You add, tick, edit,
// send and reorder them here as on your list, bring in one you already have (its Add a task box finds them), and its
// threads are told them (ab_tasks ticks them off). Sending one starts its thread in the group.
function GroupTasks({ g }: { g: GroupRow }) {
  const data = useApp((s) => s.data);
  const shown = useGroupUi((s) => !!s.tasksDone[g.id]);
  const key = `group-task-${g.id}`;
  const [text, setText] = useDraft(key);
  const on = (data?.tasks || []).filter((t) => t.group === g.id);
  const open = on.filter(ticked).sort((a, b) => a.rank - b.rank);
  const done = on.filter((t) => !ticked(t)).sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  const find = !g.archived && openTasks().filter((t) => t.group !== g.id).length > 0;
  // A new task in the group: what's typed, or nothing (the box blurs).
  const add = () => {
    const t = text.trim();
    if (!t) return void (document.activeElement as HTMLElement | null)?.blur();
    addTask(key, { text: t, group: g.id });
  };
  const row = (t: (typeof on)[number]) => <TaskRowItem key={t.id} t={t} chip short page group={false} />;
  const tick = <span className="tick-box" aria-hidden="true"></span>;
  return (
    <section className="card rail-card tasks" id="tasks">
      <h3 className="rail-h">
        <span>
          Tasks{open.length ? <span className="n">{open.length}</span> : null}
        </span>
        <span className="rail-acts">
          <a href={scopeHref("tasks", { ...NO_SCOPE, group: [g.id] })}>See all</a>
        </span>
      </h3>
      {g.archived ? null : find ? (
        <FindBox kind="task" gid={g.id} className="task-add" placeholder="Add a task, or find one of yours" label="Add a task to the group" listLabel="Your other tasks" value={text} setValue={setText} onAdd={add} before={tick} />
      ) : (
        <form
          className="task-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          {tick}
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setDraft(key, "");
              e.currentTarget.blur();
            }}
            placeholder="Add a task"
            maxLength={500}
            aria-label="Add a task to the group"
            autoComplete="off"
          />
        </form>
      )}
      {open.length ? (
        <ul className="task-list" data-task-list>
          {open.map(row)}
        </ul>
      ) : (
        <p className="muted rail-empty">{done.length ? "All done." : "Nothing to do in it yet. Its threads are told its tasks, and tick them off."}</p>
      )}
      {done.length ? (
        <div className="tasks-foot">
          <button type="button" aria-expanded={shown} onClick={() => useGroupUi.setState((s) => ({ tasksDone: { ...s.tasksDone, [g.id]: !shown } }))}>
            {done.length} done
          </button>
        </div>
      ) : null}
      {shown && done.length ? <ul className="task-list task-list--done">{done.map(row)}</ul> : null}
    </section>
  );
}

// On the right of a group, under its tasks: the open ones first, then the ones landed, merged or closed, folded. One
// you put in it comes out with its ×; one its threads work on is in it while they are.
function GroupWipCard({ g }: { g: GroupRow }) {
  useApp((s) => s.data);
  useApp((s) => s.rows);
  const shown = useGroupUi((s) => !!s.wipsDone[g.id]);
  const { list, gone } = groupWips(g);
  const open = list.filter((x) => x.state !== "clear").sort(wipOrder);
  const clear = list.filter((x) => x.state === "clear").sort(wipOrder);
  // Taking one you put in it out.
  const takeOut = async (id: string) => {
    if ((await post(`/api/groups/${encodeURIComponent(g.id)}/wips`, { wip: { id }, remove: true })).ok) toast(`Out of ${g.name}.`);
  };
  const out = (w: { id: string }) =>
    g.archived ? null : (
      <button className="icon-btn" type="button" aria-label="Take it out of the group" title="Take it out of the group" onClick={() => takeOut(w.id)}>
        <Icon name="x" />
      </button>
    );
  const row = (x: Wip) => {
    const put = wipPutIn(x)?.g.id === g.id ? wipPutIn(x).w : null;
    const on = x.posts.find((s) => s.group === g.id);
    return (
      <li key={x.id} style={hueVars(x.posts[0]?.agent || "claude")}>
        <a href={wipHref(x)} title={`${wipWhy(x)}. ${put ? "You put it in the group" : `${on?.label} works on it`}`}>
          <WipDot w={x} />
          <span className="t">{x.title}</span>
          <span className="m">{wipMeta(x)}</span>
        </a>
        {put ? out(put) : null}
      </li>
    );
  };
  const goneRow = (w: (typeof gone)[number]) => (
    <li key={w.id} className="is-gone">
      <span className="gw-row" title={`${w.kind === "pr" ? `Pull request ${w.ref}` : `The branch ${w.ref}`}: not WIP anywhere now`}>
        <span className="wip-dot">
          <Icon name="check" />
        </span>
        <span className="t">{w.title || w.ref}</span>
        <span className="m">{w.kind === "pr" ? w.ref : "gone"}</span>
      </span>
      {out(w)}
    </li>
  );
  const done = clear.length + gone.length;
  const [typed, setTyped] = useState("");
  return (
    <section className="card rail-card gwip">
      <h3 className="rail-h">
        <span>
          Pull requests{open.length ? <span className="n">{open.length}</span> : null}
        </span>
        <span className="rail-acts">
          <a href={scopeHref("worktrees", { ...NO_SCOPE, group: [g.id] })}>See all</a>
        </span>
      </h3>
      {g.archived || !wipsToAdd(g).length ? null : (
        <FindBox
          kind="wip"
          gid={g.id}
          className="task-add wip-add"
          placeholder="Add a pull request or branch"
          label="Put a branch or pull request in the group"
          listLabel="Your branches and pull requests"
          value={typed}
          setValue={setTyped}
          before={
            <span className="ico" aria-hidden="true">
              <Icon name="plus" />
            </span>
          }
        />
      )}
      {open.length ? <ul className="gwips">{open.map(row)}</ul> : <p className="muted rail-empty">{done ? "Nothing open." : "No branches or pull requests in it yet. The ones its threads work on show here too."}</p>}
      {done ? (
        <div className="tasks-foot">
          <button type="button" aria-expanded={shown} onClick={() => useGroupUi.setState((s) => ({ wipsDone: { ...s.wipsDone, [g.id]: !shown } }))}>
            {done} landed, merged or closed
          </button>
        </div>
      ) : null}
      {shown && done ? (
        <ul className="gwips">
          {clear.map(row)}
          {gone.map(goneRow)}
        </ul>
      ) : null}
    </section>
  );
}
