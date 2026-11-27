// A note's head and foot: where it is (Notes / the notes it's inside of / it), who's in it and when it was last
// changed, Share or Leave, its markdown, its version, Archive and who sees it; its owner's Share panel; and at its foot,
// its words and who sees it, in words. Ported from the old page's renderNote, noteTools, noteSharePanel, noteWhoSees.
import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { post } from "../../lib/api.ts";
import { agoText, plural } from "../../lib/format.ts";
import { agentHref, noteHref, personHref } from "../../lib/route.ts";
import { loadPeople } from "../../lib/session.ts";
import { agentOf, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { agentName } from "../../lib/agents.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { LEVEL_SHOWN, levelOf, NoteCorner } from "../Visibility.tsx";
import { when } from "../groups/groups.ts";
import { noteMdToggle } from "./editor.tsx";
import { getNote, loadNote, noteById, noteNames, noteOpen, setNote, useNote } from "./store.ts";
import type { NoteFull } from "./store.ts";
import { AskedElsewhere, saidAsked } from "../people/AskedElsewhere.tsx";

const atNames = (list: string[]) => list.map((u) => `@${u}`).join(", ");
const capFirst = (t: string) => String(t || "").replace(/^./, (c) => c.toUpperCase());

// Notes / the notes it's inside of (up to five) / it, by its title as you type it.
export function NoteCrumbs({ n }: { n: NoteFull }) {
  const title = useNote((s) => s.title);
  useApp((s) => s.data?.notes);
  const up = [];
  for (let p = noteById(n.parent), i = 0; p && i < 5; p = noteById(p.parent), i++) up.unshift(p);
  return (
    <p className="crumbs">
      <a href="#/notes">Notes</a>
      {n.mine === false && (
        <>
          <span className="sep">/</span>
          <a href={personHref(n.owner_name)}>@{n.owner_name}'s</a>
        </>
      )}
      {up.map((p) => (
        <Fragment key={p.id}>
          <span className="sep">/</span>
          <a href={noteHref(p.id)}>
            {p.emoji} {p.title}
          </a>
        </Fragment>
      ))}
      <span className="sep">/</span>
      <span>{title || "Untitled"}</span>
    </p>
  );
}

// Who's in it (its owner and the people on it, then each agent that said something in it, breathing while its thread
// works), when it was last changed, Share (its owner's) or Leave (shared with you), its markdown, its version, and
// who sees it, in its corner.
export function NoteTools({ n }: { n: NoteFull }) {
  const me = useApp((s) => s.me?.username);
  useApp((s) => s.rows);
  const { share, md, draft } = useNote();
  const agents: string[] = [];
  for (const c of n.comments || []) for (const m of c.msgs) if (m.by?.agent && !agents.includes(m.by.agent)) agents.push(m.by.agent);
  const working = new Set(
    noteOpen(n, draft)
      .map((c) => (c.thread ? threadRow(c.thread) : null))
      .filter((s) => s && (s.effective === "working" || s.busy))
      .map((s) => s.agent),
  );
  const people = [n.mine === false ? n.owner_name : null, ...noteNames(n)].filter((u) => u && u !== me);
  const by = n.last?.by;
  const who = !by || by.user === me ? "" : by.user ? ` by @${by.user}` : ` by ${(by.post && threadRow(by.post)?.label) || agentOf(by.agent).name}`;
  const kept = n.versions?.length || n.version;
  const sharing = share === n.id;
  const mine = n.mine !== false;
  const onIt = (n.people || []).some((p) => p.user === me && !p.from);
  // Taking yourself off one shared with you: it stops showing to you.
  const leave = () =>
    post(`/api/notes/${encodeURIComponent(n.id)}/leave`, {}).then((r) => {
      if (!r.ok) return;
      toast(`You're off "${getNote().note?.title || "it"}".`);
      location.hash = "#/notes";
    });
  // Archiving it: Notes has it under Archived, and Undo brings it back.
  const archive = () => {
    const id = n.id;
    post(`/api/notes/${encodeURIComponent(id)}/archive`, { archived: true }).then((r) => {
      if (!r.ok) return;
      toast("Archived. It's under Archived in Notes.", { label: "Undo", run: () => post(`/api/notes/${encodeURIComponent(id)}/archive`, { archived: false }).then(() => (location.hash = noteHref(id))) });
      location.hash = "#/notes";
    });
  };
  return (
    <div className="nh-tools">
      <span className="avs">
        {mine && <YouAvatar size="av--xs" />}
        {people.slice(0, 4).map((u) => (
          <a key={`u:${u}`} href={personHref(u)} title={`@${u}${u === n.owner_name && n.mine === false ? ", its owner" : ", on it"}`}>
            <PersonAvatar who={u} size="av--xs" />
          </a>
        ))}
        {agents.slice(0, 5).map((a) => (
          <a key={`a:${a}`} href={agentHref(a)} className={working.has(a) ? "is-live" : ""} title={`${agentName(a)}${working.has(a) ? ", working on it now" : ""}`}>
            <Avatar agent={a} size="av--xs" />
          </a>
        ))}
      </span>
      <span title={when(n.updated)}>
        Edited {agoText(n.updated)}
        {who}
      </span>
      <span className="sp"></span>
      {mine ? (
        <button className={`btn btn--sm${sharing ? " is-on" : ""}`} type="button" aria-expanded={sharing} title="Put people on it" onClick={() => setNote({ share: sharing ? null : n.id })}>
          <Icon name="group" />
          <span>Share</span>
        </button>
      ) : onIt ? (
        <button className="btn btn--sm" type="button" title="Take yourself off it: it stops showing to you" onClick={leave}>
          <Icon name="out" />
          <span>Leave</span>
        </button>
      ) : null}
      <button className={`btn btn--sm${md ? " is-on" : ""}`} type="button" title="The markdown it's kept as" onClick={noteMdToggle}>
        <Icon name="code" />
        <span>Markdown</span>
      </button>
      <span className="btn btn--sm is-quiet" title={`${plural(kept, "version")} kept${n.last?.accepted ? ", the latest an accepted suggestion" : ""}`}>
        <Icon name="history" />
        <span>v{n.version}</span>
      </span>
      {mine && (
        <button className="btn btn--sm" type="button" title="Archive it" onClick={archive}>
          <Icon name="archive" />
        </button>
      )}
      <NoteCorner n={n} />
    </div>
  );
}

export function NoteWhoSees({ n }: { n: NoteFull }) {
  const me = useApp((s) => s.me?.username);
  const lv = levelOf(n.visibility);
  const icon = <Icon name={LEVEL_SHOWN[lv][0]} />;
  if (n.mine === false) {
    const on = n.can_edit || lv !== "public" ? "shared with you" : "public";
    return (
      <>
        {icon}@{n.owner_name}'s, {on}
      </>
    );
  }
  const names = noteNames(n).filter((u) => u !== me);
  const people = names.length ? `you and ${atNames(names)}` : "only you";
  return (
    <>
      {icon}
      {lv === "public" ? `${capFirst(people)} and your contacts` : capFirst(people)}
    </>
  );
}

// Putting someone on it, by username: they see it at once.
async function addNotePerson(id: string, user: string) {
  user = String(user || "")
    .trim()
    .replace(/^@/, "");
  if (!id || !user) return;
  const r = await post<{ user: string; asked?: boolean }>(`/api/notes/${encodeURIComponent(id)}/people`, { user });
  if (r.ok && !saidAsked(r.data, "the note")) toast(`@${r.data.user} is on it now.`);
  loadNote();
}

// Its owner's, under its head: who's on it (× takes one off, but one it has through a note it's inside of comes off
// there), and adding someone by username. They see it, the notes inside it and the threads its comments talk to, and
// work in it as you do. Who else sees it is its corner's to say.
export function NoteSharePanel({ n }: { n: NoteFull }) {
  const me = useApp((s) => s.me?.username);
  const everyone = useApp((s) => s.people);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!everyone) loadPeople();
  }, [everyone]);
  const on = new Set([me, ...noteNames(n)]);
  // A row of who's on it: its owner, someone on it, or someone on it through the note it's in.
  const row = (u: string, what: React.ReactNode, x: React.ReactNode = null) => (
    <div className="tk-person" key={u}>
      <PersonAvatar who={u} size="av--sm" />
      <span>
        <b>{u === me ? "You" : `@${u}`}</b>
        <small>{what}</small>
      </span>
      {x}
    </div>
  );
  // Taking someone off it: it stops showing to them.
  const off = (user: string) =>
    post(`/api/notes/${encodeURIComponent(n.id)}/people`, { user, remove: true }).then((r) => {
      if (r.ok) toast(`@${user} is off it.`);
      loadNote();
    });
  const rows = [
    row(me, "Its owner: says who's on it and who sees it"),
    ...(n.people || []).map((p) => {
      const from = p.from && noteById(p.from);
      if (p.from)
        return row(
          p.user,
          <>
            On it through <a href={noteHref(p.from)}>{from ? `${from.emoji} ${from.title}` : "the note it's in"}</a>
          </>,
        );
      return row(
        p.user,
        `On it since ${agoText(p.at)}`,
        <button className="icon-btn" type="button" title={`Take @${p.user} off it: it stops showing to them`} aria-label={`Take @${p.user} off it`} onClick={() => off(p.user)}>
          <Icon name="x" />
        </button>,
      );
    }),
  ];
  const can = (everyone || []).filter((u) => u.contact && !on.has(u.username) && !u.disabled && !u.deleted);
  const add = (e: FormEvent) => {
    e.preventDefault();
    addNotePerson(n.id, typed);
    setTyped("");
  };
  return (
    <section className="tk-share nt-share" aria-label="Share it">
      <p className="tk-share-h">
        Share it
        <button className="icon-btn" type="button" aria-label="Close" title="Close" onClick={() => setNote({ share: null })}>
          <Icon name="x" />
        </button>
      </p>
      <div className="tk-people">{rows}</div>
      <AskedElsewhere kind="note" id={n.id} />
      <form className="tk-share-add" onSubmit={add}>
        <input name="user" list={`nt-people-${n.id}`} placeholder="Add someone: @username" autoComplete="off" aria-label="Add someone by their username" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <datalist id={`nt-people-${n.id}`}>
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
            <button key={u.username} className="chip chip--add" type="button" title={`Put @${u.username} on it`} onClick={() => addNotePerson(n.id, u.username)}>
              <PersonAvatar who={u.username} size="av--xs" />@{u.username}
            </button>
          ))}
        </div>
      ) : everyone ? (
        <p className="muted tk-share-none">Everyone here is on it.</p>
      ) : null}
      <p className="muted tk-share-note">Everyone on it sees it and the notes inside it, writes in it, comments, and accepts or rejects what agents suggest. Their agents answer in it too. The threads its comments talk to show to all of them, with their steps and changes; each is still steered only by its owner.</p>
    </section>
  );
}
