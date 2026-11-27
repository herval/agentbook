// A group's other tabs: Members (who's in it, putting people and agents in and taking them out, Leave) and Brief (its
// name, emoji and brief, Archive, and what a thread in it is told). Ported from the old page's groupMembersTab,
// addGroupPerson, groupBriefTab and the group's click and submit handlers.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { agentName, hiddenAgent, kindCaps } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, hueVars, plural } from "../../lib/format.ts";
import { getDraft, setDraft, useDraft } from "../../lib/hooks.ts";
import { personHref } from "../../lib/route.ts";
import { loadPeople } from "../../lib/session.ts";
import { agentOf, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupMember } from "../../../plugin/shared/types.ts";
import type { GroupRow, GroupView } from "../../lib/types.ts";
import { KINDS } from "../agents/words.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { groupIn, groupMine, groupPeople, groupThreads, loadGroup, useGroupUi } from "./groups.ts";
import { AskedElsewhere, saidAsked } from "../people/AskedElsewhere.tsx";

// Putting someone in it. Your private threads in it show to them from then on, so agentbook says which first.
async function addGroupPerson(g: GroupRow, user: string, sure = false) {
  user = String(user || "")
    .trim()
    .replace(/^@/, "");
  if (!g || !user) return;
  const yours = groupThreads(g).filter((s) => s.mine !== false && !s.public && !s.archived);
  if (!sure && yours.length) {
    const names = yours
      .slice(0, 4)
      .map((s) => s.label || s.title)
      .join(", ");
    return void useGroupUi.setState({ ask: { group: g.id, user, text: `@${user} will see ${yours.length === 1 ? "your thread" : `${yours.length} of your threads`} in it from now on: ${names}${yours.length > 4 ? "…" : ""}, with their steps and changes.` } });
  }
  useGroupUi.setState({ ask: null });
  const r = await post<{ user: string; asked?: boolean }>(`/api/groups/${encodeURIComponent(g.id)}/members`, { user });
  if (r.ok && !saidAsked(r.data, g.name)) toast(`@${r.data.user} is in ${g.name} now: they see every thread in it, and its updates are on their feed.`);
}

// Who's in it: its owner, the people its owner put in it and the agents in it. Its owner
// puts people in by @username (agentbook first says which of your private threads they'll see) and takes them out,
// and says whether they see its threads' work; anyone in it adds their own agents, or Leaves.
export function GroupMembers({ g }: { g: GroupRow }) {
  const me = useApp((s) => s.me?.username);
  const data = useApp((s) => s.data);
  const everyone = useApp((s) => s.people);
  useApp((s) => s.rows);
  const ask = useGroupUi((s) => (s.ask?.group === g.id ? s.ask : null));
  const [typed, setTyped] = useState("");
  const ts = groupThreads(g);
  const agents = (g.members || []).filter((m) => m.agent);
  const people = groupPeople(g);
  const mine = groupMine(g);
  const isIn = groupIn(g);
  useEffect(() => {
    if (mine && !everyone) loadPeople();
  }, [mine, everyone]);
  const base = `/api/groups/${encodeURIComponent(g.id)}`;
  const others = isIn ? (data?.agents || []).filter((a) => a.mine !== false && !hiddenAgent(a) && !agents.some((m) => m.agent === a.id)) : [];
  // An agent in it: its threads here, how it reaches the group, and × (its owner takes out any agent; anyone else in
  // it, their own).
  const row = (m: GroupMember) => {
    const here = ts.filter((s) => s.agent === m.agent);
    const a = agentOf(m.agent);
    const reach = kindCaps(a.kind)?.groupFolders ? "Gets the group's folder in each thread agentbook starts for it here." : "Reads its brief and threads in its messages; its files by name.";
    const out = async () => {
      if ((await post(`${base}/members`, { agent: m.agent, remove: true })).ok) toast(`${agentName(m.agent)} is out of ${g.name}, and so are its threads.`);
    };
    return (
      <div className="ctb" key={`a:${m.agent}`} style={hueVars(m.agent)}>
        <Avatar agent={m.agent} on={here.some((s) => s.effective !== "done") ? "active" : false} />
        <div>
          <b>{agentName(m.agent)}</b>
          {a.mine === false && a.owner ? (
            <>
              {" "}
              <span className="muted">@{a.owner}'s</span>
            </>
          ) : null}
          <p>{here.length ? `${plural(here.length, "thread")} here: ${here.map((s) => s.label).join(", ")}` : "No threads here yet"}.</p>
          <p className="muted">{reach}</p>
        </div>
        <span className="role">Agent</span>
        {(mine || a.mine !== false) && !g.archived ? (
          <button className="icon-btn" type="button" aria-label="Take it out" title="Take it out: its threads here leave with it" onClick={out}>
            <Icon name="x" />
          </button>
        ) : null}
      </div>
    );
  };
  const owner = g.owner || "?";
  const ownerRow = mine ? (
    <div className="ctb">
      <YouAvatar size="" />
      <div>
        <b>You</b>
        <p>You made it, and say who's in it and who sees it.</p>
      </div>
      <span className="role role--owner">Owner</span>
      <span className="icon-gap"></span>
    </div>
  ) : (
    <div className="ctb">
      <PersonAvatar who={owner} size="" letter={owner[0].toUpperCase()} />
      <div>
        <a href={personHref(g.owner)}>
          <b>@{g.owner}</b>
        </a>
        <p>Made it, and says who's in it and who sees it.</p>
      </div>
      <span className="role role--owner">Owner</span>
      <span className="icon-gap"></span>
    </div>
  );
  // Taking someone out: their threads and agents leave with them.
  const personOff = async (u: string) => {
    if ((await post(`${base}/members`, { user: u, remove: true })).ok) toast(`@${u} is out of ${g.name}, and so are their threads and agents.`);
  };
  // Leaving it: your threads and agents here leave with you.
  const leave = async () => {
    if (!(await post(`${base}/leave`, {})).ok) return;
    location.hash = "#/groups";
    toast(`You left ${g.name}. Your threads and agents there left with you.`);
  };
  const personRow = (m: GroupMember) => {
    const u = m.user;
    const theirs = ts.filter((s) => (u === me ? s.mine !== false : s.owner === u));
    const x =
      mine && !g.archived ? (
        <button className="icon-btn" type="button" aria-label={`Take @${u} out`} title={`Take @${u} out: their threads and agents leave with them, and the group's threads stop showing to them`} onClick={() => personOff(u)}>
          <Icon name="x" />
        </button>
      ) : u === me ? (
        <button className="btn btn--sm btn--line" type="button" title="Leave it: your threads and agents here leave with you, and you stop seeing its threads" onClick={leave}>
          Leave
        </button>
      ) : (
        <span className="icon-gap"></span>
      );
    return (
      <div className="ctb" key={`u:${u}`}>
        {u === me ? <YouAvatar size="" /> : <PersonAvatar who={u} size="" />}
        <div>
          {u === me ? (
            <b>You</b>
          ) : (
            <a href={personHref(u)}>
              <b>@{u}</b>
            </a>
          )}
          <p>
            In it since {agoText(m.at)}. {theirs.length ? `${plural(theirs.length, "thread")} here` : "No threads here yet"}.
          </p>
        </div>
        <span className="role">Person</span>
        {x}
      </div>
    );
  };
  const can = (everyone || []).filter((u) => u.contact && u.username !== g.owner && !people.includes(u.username) && !u.disabled && !u.deleted);
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    addGroupPerson(g, typed);
    setTyped("");
  };
  const addPerson =
    !mine || g.archived ? null : ask ? (
      <div className="tk-share-ask">
        <p>{ask.text}</p>
        <span className="gate-btns">
          <button className="btn btn--dark btn--sm" type="button" onClick={() => addGroupPerson(g, ask.user, true)}>
            Add @{ask.user}
          </button>
          <button className="btn btn--line btn--sm" type="button" onClick={() => useGroupUi.setState({ ask: null })}>
            Cancel
          </button>
        </span>
      </div>
    ) : (
      <>
        <p className="ver-h">Add a person</p>
        <form className="tk-share-add" onSubmit={add}>
          <input name="user" list={`gr-people-${g.id}`} placeholder="@username" autoComplete="off" aria-label="Add someone by their username" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <datalist id={`gr-people-${g.id}`}>
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
              <button key={u.username} className="chip chip--add" type="button" title={`Put @${u.username} in it`} onClick={() => addGroupPerson(g, u.username)}>
                <PersonAvatar who={u.username} size="av--xs" />@{u.username}
              </button>
            ))}
          </div>
        ) : everyone ? (
          <p className="muted tk-share-none">Everyone here is in it.</p>
        ) : null}
      </>
    );
  // Putting an agent of yours in it.
  const addAgentTo = async (id: string) => {
    if ((await post(`${base}/members`, { agent: id })).ok) toast(`${agentName(id)} is in ${g.name}.`);
  };
  const addAgent =
    others.length && !g.archived ? (
      <>
        <p className="ver-h">Add an agent of yours</p>
        <div className="sugg-list">
          {others.map((a) => (
            <div className="sugg-row" key={a.id}>
              <Avatar agent={a.id} size="av--sm" />
              <span>
                {agentName(a.id)}
                <small>{KINDS[a.kind] || a.kind}</small>
              </span>
              <button className="btn btn--sm" type="button" onClick={() => addAgentTo(a.id)}>
                <Icon name="plus" />
                Add
              </button>
            </div>
          ))}
        </div>
      </>
    ) : null;
  return (
    <div className="prof-body pg-cols">
      <div className="prof-col">
        <section className="card box">
          <h3>What members do</h3>
          <ul className="facts">
            <li>
              <Icon name="eye" />
              <span>
                <b>See every thread in it</b>, a private one too: what it's for, where it stands, its results and its messages, and its steps, changes and files.
              </span>
            </li>
            <li>
              <Icon name="file" />
              <span>
                <b>Read and write its files.</b> Every change is a version you can restore.
              </span>
            </li>
            <li>
              <Icon name="comment" />
              <span>
                <b>Hear what changed</b> in it with the next message each thread gets: results, files, notes. Nothing wakes a thread just for that.
              </span>
            </li>
            <li>
              <Icon name="plus" />
              <span>
                <b>People add their own</b> threads and agents, notes and files, and edit its brief. Who's in it, who sees it, its tasks and WIP are {mine ? "yours" : `@${g.owner}'s`}.
              </span>
            </li>
            <li>
              <Icon name="lock" />
              <span>
                <b>Steering stays with each thread's owner</b>: answering its questions, stopping it, writing to it.
              </span>
            </li>
          </ul>
        </section>
      </div>
      <div className="prof-col">
        <section className="card box">
          <h3>
            Members <span className="muted">{agents.length + people.length + 1}</span>
          </h3>
          {ownerRow}
          {(g.members || []).filter((m) => m.user).map(personRow)}
          {agents.map(row)}
          {mine ? <AskedElsewhere kind="group" id={g.id} /> : null}
          {addPerson || addAgent ? (
            <div className="ctb-add">
              {addPerson}
              {addAgent}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
// Its brief: its name and emoji (its owner's), its brief (anyone in it), Archive (its owner's), how threads get in,
// and what a thread in it is told.
export function GroupBrief({ g, d }: { g: GroupRow; d: GroupView | null }) {
  const draftKey = `group-brief:${g.id}`;
  const [brief, setBrief] = useDraft(draftKey);
  // Whether its brief was changed here (a draft of it, kept while you go elsewhere), or is the group's.
  const [had, setHad] = useState(() => !!getDraft(draftKey));
  const told = d?.told;
  const mine = groupMine(g);
  const [name, setName] = useState(g.name);
  const [emoji, setEmoji] = useState(g.emoji || "👥");
  // Its name and emoji, Archive, and what its threads are told are its owner's: the people in it change its brief.
  const off = mine ? {} : { disabled: true, title: `Only @${g.owner} renames it` };
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const res = await post(`/api/groups/${encodeURIComponent(g.id)}`, { name, emoji, brief: had ? brief : g.brief ?? "" });
    if (!res.ok) return;
    setDraft(draftKey, "");
    setHad(false);
    toast("Saved. Running threads in the group get the new brief with their next message.");
    loadGroup();
  };
  const archive = async () => {
    const archived = !g.archived;
    if ((await post(`/api/groups/${encodeURIComponent(g.id)}/archive`, { archived })).ok) toast(archived ? `${g.name} is archived. Its threads stop hearing from it.` : `${g.name} is back.`);
  };
  return (
    <div className="prof-body pg-cols">
      <div className="prof-col">
        <section className="card box gnf">
          <form onSubmit={save}>
            <h3>Brief</h3>
            <div className="gnf-name">
              <input className="gnf-emoji" name="emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={16} aria-label="Its emoji" {...off} />
              <input name="name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Its name" {...off} />
            </div>
            <textarea className="brief-edit" name="brief" aria-label="The group's brief" placeholder="The goal, the ground rules, where things go." value={had ? brief : g.brief ?? ""} onChange={(e) => {
                setHad(true);
                setBrief(e.target.value);
              }}
            />
            <div className="gnf-acts">
              <p className="muted">Markdown. Every thread in the group is told it when it starts; a change reaches the running ones with their next message.</p>
              <button className="btn btn--dark btn--sm" type="submit">
                Save
              </button>
            </div>
          </form>
        </section>
        <section className="card box">
          <h3>How threads get in</h3>
          <ul className="facts">
            <li>
              <Icon name="pencil" />
              <span>
                <b>Started here</b>, from the group's composer.
              </span>
            </li>
            <li>
              <Icon name="plus" />
              <span>
                <b>Added</b>: from the Group tab here, or a thread's page. A thread is in one group at most; adding it here takes it out of another.
              </span>
            </li>
            {groupPeople(g).length ? (
              <li>
                <Icon name="group" />
                <span>
                  <b>Each person's own</b>: everyone in it starts and adds their own threads, on their own agents and machines.
                </span>
              </li>
            ) : null}
          </ul>
        </section>
        {mine ? (
          <section className="card box">
            <h3>{g.archived ? "Archived" : "Archive the group"}</h3>
            <p className="muted">{g.archived ? "Its threads don't hear from it, and nothing new goes in. Bring it back to pick up where it was." : "Its threads keep going and stop hearing from it. The group, its notes and its files stay, under Groups."}</p>
            <button className="btn btn--line" type="button" onClick={archive}>
              <Icon name="archive" />
              {g.archived ? "Bring it back" : "Archive"}
            </button>
          </section>
        ) : null}
      </div>
      <div className="prof-col">
        {mine ? (
          <section className="card box">
            <h3>What a thread in it is told</h3>
            <p className="ctx-h">When it starts, and after compacting{told?.as ? `: what ${told.as} is told` : ""}</p>
            <pre className="ctx">{told?.start || "Loading…"}</pre>
            <p className="ctx-h">Then, with each message it gets: what changed in the group</p>
            <pre className="ctx">{told?.news ? `From the group "${g.name}" since your last turn:\n${told.news}` : "Nothing has happened in it yet."}</pre>
            <p className="muted ctx-note">
              Results, files, your notes and the brief: never another thread's steps. agentbook never wakes a thread just to tell it this. Its tools: <code>ab_group_read</code> reads the group, a thread in it, or a file; <code>ab_group_write</code> writes a file.
            </p>
          </section>
        ) : (
          <section className="card box">
            <h3>What a thread in it is told</h3>
            <p className="muted">The brief, who's in it, the other threads in it and where each stands, the latest notes and its files, when it starts and after compacting; then what changed in it, with each message it gets. Never another thread's steps.</p>
          </section>
        )}
      </div>
    </div>
  );
}
