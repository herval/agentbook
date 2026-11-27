// The column beside a note: the Threads box (every thread acting on it or naming it), then its comments, each a card
// beside its words where there's room (A), else one list under the note, what needs you first (B). Ported from the old
// page's noteRailDraw, noteThreadsBox, noteRailHtml, noteCard, noteMsg, noteSuggBox and noteLive.
import { Fragment, useLayoutEffect, useRef } from "react";
import type { ClipboardEvent, FormEvent, KeyboardEvent, MouseEvent } from "react";
import { clipText } from "../../lib/clip.ts";
import { NARROW, useMedia } from "../../lib/chrome.ts";
import { ago, esc, hueCss, hueVars, plural, reEsc } from "../../lib/format.ts";
import { agentOf, allRows, threadRow, useApp } from "../../lib/store.ts";
import type { Thread } from "../../lib/types.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../Avatar.tsx";
import { StatusChip } from "../Chips.tsx";
import { Icon } from "../Icon.tsx";
import { when } from "../groups/groups.ts";
import { plainMentions, withMentions } from "./html.ts";
import { boxes, NE, noteAgents, noteDecorate, noteDeselect, noteLayout, noteResolve, noteSend, noteSetActive, noteSettle, noteTyped } from "./editor.tsx";
import { noteCommentAgent, noteOpen, noteQuestion, noteRo, setNote, useNote } from "./store.ts";
import type { NoteComment, NoteFull } from "./store.ts";

// The Threads box, over its comments: every thread acting on the note or naming it, those going first, then the latest.
const NOTE_TIE: Record<string, string> = { comment: "In a comment", wrote: "Wrote in it", named: "Names it", read: "Read it" };
const NOTE_THREADS_SHOWN = 4;
function ThreadsBox({ n }: { n: NoteFull }) {
  const all = useNote((s) => s.threadsAll);
  const going = (s: Thread) => (s.effective === "needs" ? 0 : s.effective === "working" || s.busy ? 1 : 2);
  const rows = (n.ties || [])
    .map((t) => ({ ...t, s: threadRow(t.id) }))
    .filter((x) => x.s)
    .sort((a, b) => going(a.s) - going(b.s) || String(b.s.updated || b.at).localeCompare(String(a.s.updated || a.at)));
  if (!rows.length && noteRo(n)) return null;
  const shown = all ? rows : rows.slice(0, NOTE_THREADS_SHOWN);
  return (
    <section className="cr-box ct" aria-label="Its threads">
      <div className="cr-h">
        <b>Threads</b>
        {rows.length ? <span>{rows.length}</span> : null}
      </div>
      {rows.length ? (
        <>
          <ul className="ct-list">
            {shown.map(({ id, how, s }) => (
              <li key={id}>
                <a className="ct-row" href={`#/threads/${encodeURIComponent(id)}`} title="Open its thread">
                  {s.talk ? s.mine === false ? <PersonAvatar who={s.owner} size="av--xs" /> : <YouAvatar size="av--xs" /> : <Avatar agent={s.agent} size="av--xs" on={going(s) === 1 ? "active" : false} />}
                  <span className="ct-t">
                    <b>{plainMentions(s.title || s.label || "A thread")}</b>
                    <small>{[s.label, NOTE_TIE[how]].filter(Boolean).join(" · ")}</small>
                  </span>
                  {going(s) < 2 ? <StatusChip thread={s} /> : <time title={when(s.updated || s.started)}>{ago(s.updated || s.started)}</time>}
                </a>
              </li>
            ))}
          </ul>
          {rows.length > NOTE_THREADS_SHOWN && (
            <button className="ct-more" type="button" onClick={() => setNote({ threadsAll: !all })}>
              {all ? "Show fewer" : `${rows.length - shown.length} more`}
            </button>
          )}
        </>
      ) : (
        <p className="cr-empty">None yet. @ an agent in the text or in a comment, or name this note in a thread, and it shows here.</p>
      )}
    </section>
  );
}

// The column: drawn again whenever the note or what's open changes, then each comment's words shaded and each card
// put at the height of its words.
export function NoteRail({ n }: { n: NoteFull }) {
  const { draft, pos, res: showRes } = useNote();
  useApp((s) => s.rows);
  useApp((s) => s.more);
  useApp((s) => s.data);
  const beside = !useMedia(NARROW);
  useLayoutEffect(() => {
    noteDecorate();
    noteLayout();
    const f = requestAnimationFrame(noteLayout);
    return () => cancelAnimationFrame(f);
  });
  const open = noteOpen(n, draft);
  const res = (n.comments || []).filter((c) => c.resolved);
  const needs = open.filter((c) => noteQuestion(c)).length;
  const said = open.filter((c) => !c.draft).length;
  const head = (
    <div className="cr-h">
      <b>Comments</b>
      {said ? <span>{said}</span> : null}
      {needs ? <span className="chip chip--sun">{needs} needs you</span> : null}
      {res.length ? (
        <button type="button" onClick={() => setNote({ res: !showRes })}>
          {showRes ? "Hide resolved" : plural(res.length, "resolved")}
        </button>
      ) : null}
    </div>
  );
  const resolved =
    showRes && res.length ? (
      <div className="cr-res">
        <h4>Resolved</h4>
        {res.map((c) => (
          <CommentCard key={c.id} n={n} c={c} quote res />
        ))}
      </div>
    ) : null;
  const empty = open.length ? null : <p className="cr-empty">{noteRo(n) ? "No comments." : "Select words to comment on them, or @ an agent anywhere in the text."}</p>;
  let body;
  if (!beside) {
    const rank = (c: NoteComment) => (c.draft ? -1 : noteQuestion(c) ? 0 : (c.thread && threadRow(c.thread)?.effective) === "working" ? 1 : 2);
    const at = (c: NoteComment) => (pos[c.id] >= 0 ? pos[c.id] : 1e9);
    const list = [...open].sort((a, b) => rank(a) - rank(b) || at(a) - at(b));
    body = (
      <div className="cr-list-wrap">
        <ThreadsBox n={n} />
        {head}
        {empty}
        <div className="cr-list">
          {list.map((c) => (
            <CommentCard key={c.id} n={n} c={c} quote />
          ))}
        </div>
        {resolved}
      </div>
    );
  } else
    body = (
      <>
        <ThreadsBox n={n} />
        {head}
        {empty}
        {resolved}
        <div className="cr-cards" data-note-cards>
          {open.map((c) => (
            <CommentCard key={c.id} n={n} c={c} />
          ))}
        </div>
      </>
    );
  return (
    <aside className={`note-rail${beside ? " is-margin" : ""}`} aria-label="Its threads and comments">
      {body}
    </aside>
  );
}

// A comment's card: what it's on (in the list, or when its words are gone), Resolve, its messages (closed, a long one
// folded to its first, its last and any with a suggestion still open), how its thread is doing, and its box while
// it's open or its thread asks you something.
function CommentCard({ n, c, quote = false, res = false }: { n: NoteFull; c: NoteComment; quote?: boolean; res?: boolean }) {
  const { active, pos } = useNote();
  const on = !res && (active === c.id || !!c.draft);
  const ask = !res && noteQuestion(c);
  const agent = noteCommentAgent(c);
  const gone = pos[c.id] === -1;
  // One made in the text says its line as its first message, so it isn't quoted over it.
  const q =
    (quote && !c.spot) || gone ? (
      <div className={`cc-q${gone ? " is-gone" : ""}`}>{!c.quote ? "On the whole note" : gone ? "No longer in the note" : `“${c.quote}”`}</div>
    ) : null;
  let msgs = c.msgs;
  let fold = null;
  const shown = (m: (typeof msgs)[number], i: number) => i === 0 || i === msgs.length - 1 || (m.sugg && (n.suggestions || []).some((x) => x.id === m.sugg && x.state === "open"));
  if (!on && msgs.filter((m, i) => !shown(m, i)).length) {
    const hid = msgs.filter((m, i) => !shown(m, i)).length;
    fold = (
      <div className="cc-fold">
        {hid} more {hid === 1 ? "reply" : "replies"}
      </div>
    );
    msgs = msgs.filter(shown);
  }
  const ph = c.draft ? "Comment, or @ an agent to ask it" : agent ? `Reply to ${agentOf(agent).name}, or @ another agent` : "Reply, or @ an agent to ask it";
  const ro = noteRo(n);
  const cls = ["cc", on ? "is-on" : "", ask ? "is-sun" : "", res ? "is-res" : ""].filter(Boolean).join(" ");
  // A click on the card (not on a link, a chip or a button) opens it, its words scrolled to.
  const click = (e: MouseEvent) => {
    if (res || (e.target as HTMLElement).closest("a, .mchip, button")) return;
    noteSetActive(c.id, true);
  };
  return (
    <div className={cls} data-cc={c.id} style={agent ? hueVars(agent) : undefined} onClick={click}>
      {q}
      {!c.draft && !ro && (
        <div className="cc-acts">
          {res ? (
            <button className="icon-btn" type="button" title="Open it again" onClick={() => noteResolve(c.id, false)}>
              <Icon name="undo" />
            </button>
          ) : (
            <button className="icon-btn" type="button" title="Resolve" onClick={() => noteResolve(c.id, true)}>
              <Icon name="check" />
            </button>
          )}
        </div>
      )}
      {msgs.map((m, i) => (
        <Fragment key={m.id || i}>
          <NoteMsg n={n} m={m} listed={quote} />
          {i === 0 ? fold : null}
        </Fragment>
      ))}
      {res ? null : <NoteLive c={c} />}
      {!ro && !res && (on || ask) ? <NBox id={c.id} ph={ph} /> : null}
    </div>
  );
}

// A comment's words, with the agents and threads it names as chips, and pages and widgets as everywhere.
function noteSaid(text: string) {
  let html = withMentions(esc(text));
  const names = [...noteAgents().map((a) => [a.name, a.id]), ...allRows().filter((s) => s.label).map((s) => [s.label, s.agent])].sort((a, b) => b[0].length - a[0].length);
  for (const [name, aid] of names) html = html.replace(new RegExp(`(^|[\\s(])@${reEsc(esc(name))}(?![\\w-])`, "g"), `$1<span class="mchip" style="${hueCss(aid)}">@${esc(name)}</span>`);
  return html.replace(/\n/g, "<br>");
}
// A message in a comment: who said it (a person, or an agent and its thread), when, its words, and its suggestion.
function NoteMsg({ n, m, listed }: { n: NoteFull; m: NoteComment["msgs"][number]; listed: boolean }) {
  const me = useApp((s) => s.me?.username);
  const by = m.by || ({} as NoteComment["msgs"][number]["by"]);
  const s = by.post ? threadRow(by.post) : null;
  return (
    <div className="cc-m">
      {by.user ? <PersonAvatar who={by.user} size="av--xs" /> : <Avatar agent={by.agent} size="av--xs" />}
      <div>
        <div className="cc-who">
          {by.user ? (
            <b>{by.user === me ? "You" : `@${by.user}`}</b>
          ) : (
            <>
              <b>{agentOf(by.agent).name}</b>
              {by.post ? (
                <a className="th" href={`#/threads/${encodeURIComponent(by.post)}`} title="Open its thread">
                  {s?.label || "its thread"}
                </a>
              ) : null}
            </>
          )}
          <time title={when(m.at)}>{ago(m.at)}</time>
        </div>
        {m.text ? <p className="cc-t" dangerouslySetInnerHTML={{ __html: noteSaid(m.text) }} /> : null}
        {m.sugg ? <SuggBox n={n} sid={m.sugg} listed={listed} /> : null}
      </div>
    </div>
  );
}
// A suggestion in its comment: Accept and Reject while it's open, then what became of it. In the list (B), what it
// changes is shown too, since its words may be a screen away.
function SuggBox({ n, sid, listed }: { n: NoteFull; sid: string; listed: boolean }) {
  const x = (n.suggestions || []).find((s) => s.id === sid);
  if (!x) return null;
  if (x.state !== "open")
    return (
      <div className="cc-sg is-settled">
        {x.state === "kept" ? (
          <>
            <Icon name="check" />
            <span>Accepted</span>
          </>
        ) : (
          <span>Rejected</span>
        )}
      </div>
    );
  const gone = !NE.saved.includes(x.find);
  const diff =
    listed && !gone ? (
      <div className="cc-diff">
        <del>{x.find}</del> <ins>{x.replace}</ins>
      </div>
    ) : null;
  const says = <span>{gone ? "Its words aren't in the note any more" : "Suggested an edit"}</span>;
  return (
    <>
      {diff}
      <div className="cc-sg" style={hueVars(x.by?.agent)}>
        {says}
        {!noteRo(n) && (
          <>
            <button className="btn btn--sm btn--line" type="button" onClick={() => noteSettle(sid, false)}>
              Reject
            </button>
            {gone ? null : (
              <button className="btn btn--sm btn--dark" type="button" onClick={() => noteSettle(sid, true)}>
                Accept
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
function NoteLive({ c }: { c: NoteComment }) {
  const launches = useApp((s) => s.data?.launches);
  const id = c.thread;
  const s = id ? threadRow(id) : null;
  const q = noteQuestion(c);
  if (q)
    return (
      <div className="cc-live cc-live--ask">
        <span>
          <b>{s?.label || "Its thread"}</b> asks you something
        </span>
        <a className="btn btn--sm btn--dark" href={`#/threads/${encodeURIComponent(id)}?ask=${encodeURIComponent(q.id)}`}>
          Answer
        </a>
      </div>
    );
  if (s && (s.effective === "working" || s.busy))
    return (
      <div className="cc-live" style={hueVars(s.agent)}>
        <i className="pulse"></i>
        <span>
          <b>{s.label}</b> is on it
        </span>
        <a className="icon-btn" href={`#/threads/${encodeURIComponent(id)}`} title="Open its thread">
          <Icon name="external" />
        </a>
      </div>
    );
  if (c.launch && !id) {
    const l = (launches || []).find((x) => x.id === c.launch);
    return l?.error ? (
      <div className="cc-live cc-live--err">
        <span>{l.error}</span>
      </div>
    ) : (
      <div className="cc-live">
        <i className="pulse"></i>
        <span>Starting its thread…</span>
      </div>
    );
  }
  return null;
}
// A comment's box: what's typed in it is kept (by comment) while the rail is drawn again. Enter sends it, Shift-Enter
// is a new line, Esc closes it; @ lists the agents and threads to ask, and what it can name.
function NBox({ id, ph }: { id: string; ph: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && boxes.get(id) && !el.innerHTML) el.innerHTML = boxes.get(id);
  }, [id]);
  const input = (e: FormEvent<HTMLDivElement>) => {
    const box = e.currentTarget;
    if (!box.textContent && !box.querySelector(".mchip")) box.innerHTML = "";
    boxes.set(id, box.innerHTML);
    noteTyped(box, e.nativeEvent as InputEvent, null);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      return void noteSend(id);
    }
    if (e.key === "Escape") {
      e.currentTarget.blur();
      noteDeselect();
    }
  };
  // Pasted, it's plain text.
  const paste = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = clipText(e.clipboardData);
    if (!text) return;
    e.preventDefault();
    document.execCommand("insertText", false, text);
  };
  return (
    <div className="cc-box">
      <div ref={ref} className="nbox" contentEditable suppressContentEditableWarning role="textbox" aria-label={ph} data-nbox={id} data-ph={ph} onInput={input} onKeyDown={key} onPaste={paste} />
      <button className="icon-btn" type="button" title="Send (Enter)" aria-label="Send" onClick={() => noteSend(id)}>
        <Icon name="send" />
      </button>
    </div>
  );
}
