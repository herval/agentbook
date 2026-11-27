// Notes (#/notes): every note, and a new one. Ported from the old page's renderNotes, notesList and noteMake.
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Avatar, PersonAvatar } from "../../components/Avatar.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Shell } from "../../components/Shell.tsx";
import { NoteCorner } from "../../components/Visibility.tsx";
import { when } from "../../components/groups/groups.ts";
import { noteById, useNotesPill } from "../../components/notes/store.ts";
import { post } from "../../lib/api.ts";
import { ago, hueVars, plural } from "../../lib/format.ts";
import { noteHref } from "../../lib/route.ts";
import { agentOf, threadRow, useApp } from "../../lib/store.ts";
import type { NoteRow, Question } from "../../lib/types.ts";

const NOTE_PILLS: [string, string, (n: NoteRow) => boolean][] = [
  ["all", "All", (n) => !n.archived],
  ["mine", "Yours", (n) => !n.archived && n.mine !== false && !n.made],
  ["agents", "By agents", (n) => !n.archived && n.mine !== false && !!n.made],
  ["shared", "Shared with you", (n) => !n.archived && n.mine === false],
  ["comments", "With comments", (n) => !n.archived && n.comments > 0],
  ["archived", "Archived", (n) => !!n.archived],
];
// A note's threads (the ones its comments talk to) that wait on you, and that are working.
const noteAsks = (n: NoteRow, questions: Question[]) => (n.threads || []).filter((id) => questions.some((q) => q.post === id && !q.answered && !(q.asked && q.asked < n.created)));
const noteWorking = (n: NoteRow) => (n.threads || []).map((id) => threadRow(id)).filter((s) => s && (s.effective === "working" || s.busy));
// A new note, by its title (and the note it's inside of): its page opens.
export async function noteMake(title: string, parent: string | null = null) {
  const r = await post("/api/notes", { title: title || "Untitled", ...(parent ? { parent } : {}) });
  if (r.ok) location.hash = noteHref(r.data.id);
}

// One list: a note with something waiting on you first, then the latest written. Each row is its title, and under
// it one quiet line: who wrote it last, its comments, and how it starts.
export function Notes() {
  const data = useApp((s) => s.data);
  const me = useApp((s) => s.me?.username);
  useApp((s) => s.rows);
  const pill = useNotesPill((s) => s.pill);
  const [title, setTitle] = useState("");
  const all = data?.notes || [];
  const questions = data?.questions || [];
  const f = NOTE_PILLS.find(([k]) => k === pill) || NOTE_PILLS[0];
  const list = all.filter(f[2]).sort((a, b) => Number(noteAsks(b, questions).length > 0) - Number(noteAsks(a, questions).length > 0) || String(b.updated).localeCompare(String(a.updated)));
  const row = (n: NoteRow) => {
    const by = n.last?.by || n.by || ({} as NoteRow["by"]);
    const who = by.user ? (
      <>
        <PersonAvatar who={by.user} size="av--xs" />
        {by.user === me ? "You" : `@${by.user}`}
      </>
    ) : (
      <>
        <Avatar agent={by.agent} size="av--xs" />
        {(by.post && threadRow(by.post)?.label) || agentOf(by.agent).name}
      </>
    );
    const parent = noteById(n.parent);
    const asks = noteAsks(n, questions);
    const working = noteWorking(n);
    const first = asks.length ? threadRow(asks[0]) : null;
    const st = asks.length ? (
      <span className="st-pill st-pill--needs">
        <Avatar agent={first?.agent} size="av--xs" />
        {first?.label || "An agent"} asks
      </span>
    ) : working.length ? (
      <span className="st-pill" style={hueVars(working[0].agent)}>
        <Avatar agent={working[0].agent} size="av--xs" />
        {working[0].label}
        <i className="pulse"></i>
      </span>
    ) : null;
    const bits: ReactNode[] = [
      <span key="who" className="who">
        {who}
      </span>,
      n.mine === false ? <span key="whose">@{n.owner_name}'s</span> : null,
      n.comments ? <span key="c">{plural(n.comments, "comment")}</span> : null,
      <span key="start" className="start">
        {n.start || "Empty"}
      </span>,
    ].filter(Boolean);
    return (
      <li key={n.id}>
        <a className={`nl-r${asks.length ? " is-needs" : ""}`} href={noteHref(n.id)}>
          <span className="nl-em">{n.emoji || "📄"}</span>
          <span className="nl-t">
            {parent ? <span className="in">{parent.title} / </span> : null}
            {n.title}
          </span>
          <span className="nl-age">
            <time title={when(n.updated)}>{ago(n.updated)}</time>
            <NoteCorner n={n} cls=" vis-corner--sm" />
          </span>
          <span className="nl-sub">{bits.flatMap((b, i) => (i ? [<i key={`d${i}`} className="dot"></i>, b] : [b]))}</span>
          <span className="nl-st">{st}</span>
        </a>
      </li>
    );
  };
  const empty = !all.length ? (
    <div className="nl-empty">
      <p>Notes are documents you write here, a block at a time, kept as markdown: a plan, meeting notes, a spec. Select words in one to comment on them, and @ an agent in a comment to ask it: it answers there, and suggests its edits in the text for you to accept.</p>
    </div>
  ) : !list.length ? (
    <p className="muted nl-none">None here.</p>
  ) : null;
  // A title and Enter: the new note opens.
  const make = (e: FormEvent) => {
    e.preventDefault();
    noteMake(title.trim());
  };
  return (
    <Shell className="shell notes-shell">
      <section className="card nl">
        <div className="nl-head">
          <h1>Notes</h1>
          {all.length ? <span className="n">{all.filter((n) => !n.archived).length}</span> : null}
        </div>
        <form className="nl-add" onSubmit={make}>
          <Icon name="plus" />
          <input type="text" name="title" placeholder="New note: its title, then Enter" aria-label="New note" autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
        </form>
        {all.length ? (
          <div className="nl-pills">
            {NOTE_PILLS.filter(([k, , test]) => k === "all" || all.some(test)).map(([k, l, test]) => (
              <button key={k} type="button" className={f[0] === k ? "is-on" : ""} onClick={() => useNotesPill.setState({ pill: k })}>
                {l}
                <span className="n">{all.filter(test).length}</span>
              </button>
            ))}
          </div>
        ) : null}
        {empty}
        <ul className="nl-list">{list.map(row)}</ul>
      </section>
    </Shell>
  );
}
