// A note's page (#/notes/:id): its head, its title and icon, its words as blocks you edit in place,
// its foot, and beside them its threads and comments. Ported from the old page's renderNote and its loaders: the note
// is fetched when the page opens, on each stream hello, and when the chrome says it changed (a comment, an answer, a
// suggestion, a version, or a comment's launch became its thread). The editor keeps what you're typing (noteTake).
import { useEffect, useLayoutEffect, useRef } from "react";
import { LeftNav } from "../../components/LeftNav.tsx";
import { useSided } from "../../components/Shell.tsx";
import { NE, noteDocDraw, noteEmojiPick, noteFocus, noteFresh, noteListen, noteReanchor, noteSave, noteTitleTyped } from "../../components/notes/editor.tsx";
import { NoteCrumbs, NoteSharePanel, NoteTools, NoteWhoSees } from "../../components/notes/Head.tsx";
import { NotePop, NoteToolbar } from "../../components/notes/Pop.tsx";
import { NoteRail } from "../../components/notes/Rail.tsx";
import { getNote, loadNote, noteOpen, noteRo, resetNote, useNote } from "../../components/notes/store.ts";
import type { NoteFull } from "../../components/notes/store.ts";
import { MENU, useMedia } from "../../lib/chrome.ts";
import { plural } from "../../lib/format.ts";
import { onHello } from "../../lib/live.ts";
import { useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { PageData } from "../../lib/types.ts";

export function NotePage() {
  const id = useRoute().id;
  const n = useNote((s) => s.note);
  const share = useNote((s) => s.share);
  const emoji = useNote((s) => s.emoji);
  const data = useApp((s) => s.data);
  const sided = !useMedia(MENU);
  useSided(sided);

  // Opening it: nothing of the last note's, then this one. Leaving it: what you typed is saved now, not in a second.
  useEffect(() => {
    noteFresh();
    resetNote();
    loadNote();
    const off = onHello(() => void loadNote());
    return () => {
      off();
      noteSave();
      resetNote();
    };
  }, [id]);

  // The open note changed (a comment, an answer, a suggestion, a version), or a comment's launch became its thread
  // (so its card says the thread is on it, not "Starting its thread…" until the answer): look again.
  const prev = useRef<PageData | null>(data);
  useEffect(() => {
    const was = prev.current;
    prev.current = data;
    if (was === data) return;
    const started = new Set((getNote().note?.comments || []).map((c) => c.launch).filter(Boolean));
    const nv = (d: PageData | null) => JSON.stringify([(d?.notes || []).filter((x) => x.id === id).map((x) => [x.rev, x.version, x.archived]), (d?.launches || []).filter((l) => started.has(l.id)).map((l) => l.post)]);
    if (nv(was) !== nv(data)) loadNote();
  }, [data, id]);

  if (!n || n.missing || n.id !== id)
    return (
      <div className="shell-msg">
        <p>{n?.missing && n.id === id ? "No note here, or it isn't shared with you." : "Loading…"}</p>
        <a className="btn" href="#/notes">
          Every note
        </a>
      </div>
    );
  // Someone who only sees it (a contact, as it's public) reads it: no typing, no comments, nothing to accept.
  const ro = noteRo(n);
  return (
    <div className={`shell note-shell${ro ? " is-ro" : ""}`}>
      <aside className="col-side">{sided && <LeftNav />}</aside>
      <main className="note-main">
        <NoteCrumbs n={n} />
        <article className="card note-card">
          <NoteTools n={n} />
          <div data-note-sharing>{share === n.id && n.mine !== false ? <NoteSharePanel n={n} /> : null}</div>
          <button className="nh-emoji" type="button" title="Change its icon" onClick={(e) => !ro && noteEmojiPick(e.currentTarget.getBoundingClientRect())}>
            {emoji || "📄"}
          </button>
          <NoteTitle ro={ro} />
          <NoteDoc n={n} ro={ro} />
          <div className="note-foot">
            <span>{plural(n.words || 0, "word")}</span>
            <span className="sp"></span>
            <span>
              Kept as markdown · <NoteWhoSees n={n} />
            </span>
          </div>
        </article>
      </main>
      <NoteRail n={n} />
      <NotePop />
      <NoteToolbar />
    </div>
  );
}

// Its title, typed in place: what the store has shows in it unless you're typing in it. Enter goes to its words.
function NoteTitle({ ro }: { ro: boolean }) {
  const title = useNote((s) => s.title);
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    NE.title = ref.current;
    return () => {
      if (NE.title === ref.current) NE.title = null;
    };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== title) el.textContent = title;
  });
  return (
    <h1
      ref={ref}
      className="nh-title"
      contentEditable={!ro}
      suppressContentEditableWarning
      spellCheck={false}
      data-ph="Untitled"
      onInput={(e) => noteTitleTyped(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        noteFocus(0, "start");
      }}
    />
  );
}

// Its words: the element the editor draws the blocks in and reads them back from (editor.tsx), with the page's own
// listeners on while it's open. It's drawn again when the editor took new words (NE.drawn), when it becomes read-only
// or not, and its comments' words shaded again when they change.
function NoteDoc({ n, ro }: { n: NoteFull; ro: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const draft = useNote((s) => s.draft);
  const md = useNote((s) => s.md);
  useLayoutEffect(() => {
    NE.doc = ref.current;
    NE.drawn = false;
    const off = noteListen();
    return () => {
      off();
      if (NE.doc === ref.current) NE.doc = null;
    };
  }, []);
  const roWas = useRef(ro);
  useLayoutEffect(() => {
    if (roWas.current !== ro) {
      roWas.current = ro;
      NE.drawn = false;
    }
    if (!NE.drawn) noteDocDraw();
  });
  const key = noteOpen(n, draft)
    .map((c) => `${c.id}\u0000${c.quote}\u0000${c.nth}`)
    .join("\u0001");
  const keyWas = useRef(key);
  useLayoutEffect(() => {
    if (keyWas.current === key) return;
    keyWas.current = key;
    if (!md) noteReanchor();
  }, [key, md]);
  return <div className="doc-b" data-note-doc ref={ref} />;
}
