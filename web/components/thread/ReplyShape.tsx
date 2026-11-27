// How a turn went, on its reply: what its agent said of the turn
// with ab_verdict, ab_checks and ab_suggest, kept on the reply that ends it (m.shape): the verdict, a chip and a line;
// what it made for you; what failed or it didn't check; and the replies it suggests, as buttons under it.
import { useLayoutEffect, useMemo } from "react";
import type { MouseEvent } from "react";
import { codeBlockCount } from "../../lib/commands.ts";
import { firstLine, plural, webUrl } from "../../lib/format.ts";
import { postPics } from "../../lib/markdown.ts";
import { useApp } from "../../lib/store.ts";
import type { FileRecord, Message, Question, TaskRow, Thread, ThreadDetail } from "../../lib/types.ts";
import { openPeek } from "../../lib/viewer.ts";
import type { Attachment as AttachmentRec, PostPr, ShapeCheck, TurnShape } from "../../../plugin/shared/types.ts";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import type { MdRun } from "../Markdown.tsx";
import { WChart } from "../pages/widgets.tsx";
import { Hl } from "../post/util.tsx";
import { taskMine, tickTask } from "../tasks/tasks.ts";
import { Diagram } from "../visual/Diagram.tsx";
import { peekOf } from "./Bubble.tsx";
import { fileData, openOnClick } from "./FileChip.tsx";
import { linked } from "./Plain.tsx";
import { Attachment } from "./Results.tsx";
import { AheadLine, CardsBlock, CompareBlock, DraftCard, GoBtn, goAhead, SlotsBlock } from "./reply-made.tsx";
import type { ReplyCx } from "./reply-made.tsx";
import { markQuickSent, pickCard, quickSentNow, toggleMsgOpen, toggleOpenKey, useCardPicks, useMsgOpen, useQuickSent, useReply } from "./reply-state.ts";
import { sayToThread } from "./send.ts";

export const VERDICT_WORD: Record<string, string> = { done: "Done", found: "Found it", needs_you: "Needs you", partly: "Partly", blocked: "Blocked", nothing: "Nothing found" };
export const hasShape = (m: Message) => m.from !== "human" && !!m.shape && Object.keys(m.shape).length > 0;
// How many lines a text takes, a long line counting as the lines it wraps to.
export const linesOf = (text: string) =>
  String(text || "")
    .split("\n")
    .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 90)), 0);

/* ---------- what the turn made, from the thread's own data ---------- */

// The messages of a thread as the page has them, for what happened in a reply's turn: its page's, or the ones its
// record carries; none for a card that has only its latest.
function useMsgs(s: Thread): Message[] | null {
  const detail = useApp((st) => (st.open?.detail?.id === s.id && Array.isArray(st.open.detail.messages) ? st.open.detail.messages : null));
  return detail || (Array.isArray(s.messages) ? s.messages : null);
}
// A reply's turn, as a span of time: from the message before it that started or ended one (yours, or its agent's
// reply with a shape) to a little after it (its Changes line lands as the turn ends), and never past the next such.
function turnOf(s: Thread, m: Message, list: Message[] | null): { from: string; to: string } | null {
  if (!list || !m.at) return null;
  const i = list.findIndex((x) => x.id === m.id);
  const before = i < 0 ? list.filter((x) => x.at < m.at) : list.slice(0, i);
  const prev = before.findLast((x) => x.from === "human" || hasShape(x));
  const next = (i < 0 ? list.filter((x) => x.at > m.at) : list.slice(i + 1)).find((x) => x.from === "human" || hasShape(x));
  const slack = new Date(Date.parse(m.at) + 120000).toISOString();
  return { from: prev?.at || s.started || "", to: next && next.at < slack ? next.at : slack };
}
const within = (at: string | null | undefined, t: { from: string; to: string }) => !!at && at > t.from && at <= t.to;
const prsOf = (s: Thread): PostPr[] => Object.values(s.prs || {}).filter((p) => p && typeof p.url === "string" && p.url && !p.off);
const NO_Q: Question[] = [];
const NO_TODOS: TaskRow[] = [];

const ATT_ICON: Record<string, IconName> = { note: "note", table: "grid", metric: "gauge", chart: "bars", diagram: "path", link: "link" };

// What the turn made, as chips under the line, from what the thread already has (A): its
// Changes line (opening that turn's diffs; one file, in the viewer, as it is now, its diff a button away), the pull
// requests it opened (on GitHub), what it attached or changed of what it keeps in view (ab_attach: opened under the
// row, where the reply that says "attached to the thread" is read; a link, where it goes), the questions it asked
// (yellow while open), the files it sent (in the viewer). Nothing the agent writes: agentbook's data, matched to the
// turn by time.
function ThingsRow({ s, t, mid }: { s: Thread; t: { from: string; to: string } | null; mid: string }) {
  const questions = useApp((st) => st.data?.questions || NO_Q);
  const files = useApp((st) => (st.open?.detail?.id === s.id ? (st.open.detail as ThreadDetail).files : null)) || s.last_files || [];
  const opened = useReply((st) => st.open);
  if (!t) return null;
  const atts = Object.values(s.attachments || {}).filter((a) => a?.key && within(a.updated || a.created, t));
  const attKey = (a: AttachmentRec) => `${mid}:att:${a.key}`;
  const chips: React.ReactNode[] = [];
  for (const u of (s.updates || []).filter((u) => u.changes && within(u.at, t))) {
    const href = `#/threads/${encodeURIComponent(s.id)}?changes=${u.changes.turn}&at=${encodeURIComponent(u.at)}`;
    const one = u.changes.files === 1 && u.changes.tiles?.length === 1 && peekOf(s) ? u.changes.tiles[0].path : null;
    const peek = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPeek(s.id, one, "", null, href);
    };
    chips.push(
      <a className="chip rc-thing" href={href} key={`u${u.at}`} title={one ? `Open ${one}` : "Its changes, this turn"} onClick={one ? peek : undefined}>
        <Icon name="diff" />
        {u.text.replace(/^Changed /, "")}
      </a>,
    );
  }
  for (const p of prsOf(s).filter((p) => within(p.at, t)))
    chips.push(
      <a className="chip rc-thing" href={p.url} target="_blank" rel="noopener" key={`p${p.url}`} title={p.gh?.title || p.url}>
        <Icon name="pr" />#{p.number || ""}
        {p.gh?.state && <small>{p.gh.state}</small>}
      </a>,
    );
  for (const a of atts) {
    const title = a.title || String(a.data?.title || "") || a.key;
    const url = a.type === "link" ? webUrl(String(a.data?.url || "")) : "";
    chips.push(
      url ? (
        <a className="chip rc-thing" href={url} target="_blank" rel="noopener" key={`a${a.key}`} title={url}>
          <Icon name="link" />
          {title}
        </a>
      ) : (
        <button className="chip rc-thing" type="button" key={`a${a.key}`} data-att={a.key} aria-expanded={opened.has(attKey(a))} title={opened.has(attKey(a)) ? "Close it" : "Open what it attached"} onClick={() => toggleOpenKey(attKey(a))}>
          <Icon name={ATT_ICON[a.type] || "clip"} />
          {title}
        </button>
      ),
    );
  }
  for (const q of questions.filter((q) => q.post === s.id && q.kind !== "permission" && !q.hook && !q.routine && within(q.asked, t)))
    chips.push(
      <a className={`chip rc-thing${q.answered ? "" : " chip--sun"}`} href={`#/threads/${encodeURIComponent(s.id)}`} key={`q${q.id}`} title={q.title}>
        <Icon name="hand" />
        {q.id}
        <small>{q.answered ? "answered" : "open"}</small>
      </a>,
    );
  for (const f of (Array.isArray(files) ? files : []) as FileRecord[])
    if (f.from !== "human" && !f.embedded && within(f.at, t))
      chips.push(
        <a className="chip rc-thing" href={`/api/files/${f.id}`} target="_blank" rel="noopener" key={`f${f.id}`} {...fileData(f)} onClick={openOnClick}>
          <Icon name="file" />
          {f.title || f.name}
        </a>,
      );
  if (!chips.length) return null;
  const shown = atts.filter((a) => opened.has(attKey(a)));
  return (
    <>
      <div className="rc-things">{chips.slice(0, 8)}</div>
      {shown.map((a) => (
        <Attachment key={a.key} a={a} s={s} />
      ))}
    </>
  );
}

// A to-do's tick box: a button for its owner, only a mark for anyone else.
function Tick({ t }: { t: TaskRow }) {
  const now = t.done ? "Done" : "Not done";
  if (!taskMine(t))
    return (
      <span className="tick-box is-fixed" aria-label={now} title={`${now}. Only @${t.owner_name || "its owner"} ticks it off.`}>
        {t.done ? "✓" : ""}
      </span>
    );
  const act = t.done ? "Not done" : "Done";
  return (
    <button className="tick-box" type="button" aria-label={act} title={act} onClick={() => tickTask(t, !t.done)}>
      {t.done ? "✓" : ""}
    </button>
  );
}
// Yours: the to-dos its agent left you this turn (ab_todo), each with its tick and the answers it offers as buttons
// (on the thread's latest reply). A decision you can answer with a click, not a paragraph asking for one. With more
// than one left to answer, a click only picks, and Send says every pick in one message: each answer going on its own
// started the agent on the first before the rest could be picked.
function YoursBlock({ cx, t }: { cx: ReplyCx; t: { from: string; to: string } | null }) {
  const todos = useApp((st) => st.data?.todos || NO_TODOS);
  const { s, m, act } = cx;
  const pickKey = `${m.id}:todos`;
  const chosen = useCardPicks(pickKey);
  const yours = t ? todos.filter((x) => x.from === s.id && !x.removed && within(x.at, t)) : [];
  if (!yours.length) return null;
  const open = yours.filter((x) => !x.done).length;
  const key = (x: TaskRow) => `todo:${x.id}`;
  const left = yours.map((x, i) => (!x.done && x.answers?.length && !cx.gone(key(x)) ? i : -1)).filter((i) => i >= 0);
  const several = act && left.length > 1;
  const picked = several ? left.filter((i) => chosen[i] != null && yours[i].answers[chosen[i]]) : [];
  const said = (i: number) => {
    const a = yours[i].answers[chosen[i]];
    const q = yours[i].text.trim();
    return `${q}${/[?!.:]$/.test(q) ? " " : ": "}${a.says || a.label}`;
  };
  const text = picked.length > 1 ? picked.map((i) => `- ${said(i)}`).join("\n") : picked.length ? said(picked[0]) : "";
  const answers = (x: TaskRow, i: number) =>
    cx.gone(key(x)) ? (
      <AheadLine what={`Told ${s.label || "it"}`} />
    ) : several ? (
      x.answers.map((a, k) => (
        <button className={`btn ${chosen[i] === k ? "btn--dark" : "btn--line"} btn--sm`} type="button" aria-pressed={chosen[i] === k} key={k} onClick={() => pickCard(pickKey, i, k)}>
          {chosen[i] === k && <Icon name="check" />}
          {a.label}
        </button>
      ))
    ) : (
      x.answers.map((a, k) => <GoBtn key={k} cx={cx} k={key(x)} label={a.label} says={a.says || a.label} dark={k === 0} />)
    );
  return (
    <div className="rc-led">
      <div className="yours">
        <h4>
          Yours <small>{open || "all done"}</small>
        </h4>
        <ul>
          {yours.map((x, i) => (
            <li className={x.done ? "is-done" : undefined} key={x.id}>
              <Tick t={x} />
              <span className="rc-t">
                {linked(x.text)}
                {x.note && <small>{linked(firstLine(x.note))}</small>}
              </span>
              {!x.done && act && x.answers?.length > 0 && <span className="rc-ans">{answers(x, i)}</span>}
            </li>
          ))}
        </ul>
        {several && (
          <div className="rc-ans-go">
            <button
              className="btn btn--dark btn--sm"
              type="button"
              disabled={!picked.length}
              onClick={() =>
                goAhead(
                  s.id,
                  picked.map((i) => `${m.id}:${key(yours[i])}`),
                  text,
                  pickKey,
                )
              }
            >
              {picked.length ? `Send ${plural(picked.length, "answer")}` : "Send"}
            </button>
            <span className="muted">Pick one for each, then send.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Only what could still be wrong, last and small (D): what failed in red, in view; what it
// didn't check as one grey line that opens to the rows. What passed isn't shown, though an older plugin still sends
// it: green ✓ pills were noise, and a Didn't check box hid what was in it. A row with a `do` (what to send to have it
// check that) gets a button, on the thread's latest reply.
function ChecksBlock({ cx, checks }: { cx: ReplyCx; checks: ShapeCheck[] }) {
  const failed = checks.filter((c) => c.status === "failed");
  const un = checks.filter((c) => c.status === "not_checked");
  if (!failed.length && !un.length) return null;
  const btn = (c: ShapeCheck, k: string) => (c.do && cx.act ? <GoBtn cx={cx} k={`chk:${k}`} label="Check it" says={c.do} dark={false} /> : null);
  const row = (c: ShapeCheck) => (
    <span>
      <b>{c.label}</b>
      {c.detail && (
        <>
          {" "}
          <small>{linked(c.detail)}</small>
        </>
      )}
    </span>
  );
  const k = `chk:${cx.m.id}`;
  const open = cx.open(k);
  return (
    <div className="rc-chk">
      {failed.map((c, i) => (
        <div className="rc-fail" key={i}>
          <b>Failed</b>
          {row(c)}
          {btn(c, `f${i}`)}
        </div>
      ))}
      {un.length > 0 && (
        <>
          <button className={`rc-unchk${open ? " is-open" : ""}`} type="button" aria-expanded={open} onClick={() => toggleOpenKey(k)}>
            <Icon name="down" />
            <span>
              {un.length === 1 ? "1 thing unchecked" : `${un.length} things unchecked`}: {un.map((c) => c.label).join(", ")}
            </span>
          </button>
          {open && (
            <ul className="rc-unchk-l">
              {un.map((c, i) => (
                <li key={i}>
                  {row(c)}
                  {btn(c, `u${i}`)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// The path the turn took (ab_path): its stages, the dead ends branching off with why, and the minutes each took.
function PathBlock({ path }: { path: TurnShape["path"] }) {
  const st = path.stages;
  const total = st.reduce((n, x) => n + (x.minutes || 0), 0);
  const dead = st.filter((x) => x.dead).reduce((n, x) => n + (x.minutes || 0), 0);
  return (
    <div className="rs-block">
      <p className="rs-block-h">
        <Icon name="path" />
        The path it took
      </p>
      {total > 0 && (
        <>
          <div className="rs-spent">
            {st.map((x, i) => (
              <i className={x.dead ? "d" : "k"} key={i} style={{ width: `${((x.minutes || 0) / total) * 100}%` }} title={`${x.text}: ${x.minutes || 0} min`} />
            ))}
          </div>
          <p className="rs-spent-t">
            <span>
              <b>{total} min</b> in all
            </span>
            {dead > 0 && (
              <span>
                <b>{dead} min</b> on {plural(st.filter((x) => x.dead).length, "dead end")}
              </span>
            )}
          </p>
        </>
      )}
      <ol className="rs-path">
        {st.map((x, i) => (
          <li className={`rs-st${x.dead ? " is-dead" : ""}`} key={i}>
            <span className="rail">
              {x.dead && (
                <>
                  <i className="twig" />
                  <i className="x">✗</i>
                </>
              )}
            </span>
            <span className="t">
              {x.text}
              {x.dead && <small>{x.dead}</small>}
            </span>
            <time>{x.minutes != null ? `${x.minutes} min` : ""}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

// What it read for you, the passages that matter (ab_highlight with a source): each with its words marked, where it
// is, and a note on why.
function ExcerptsBlock({ ex }: { ex: TurnShape["excerpts"] }) {
  const passage = (it: (typeof ex.items)[number]) => {
    const at = it.mark ? it.text.indexOf(it.mark) : -1;
    if (!it.mark) return <mark className="rs-mark">{it.text}</mark>;
    if (at < 0) return it.text;
    return (
      <>
        {it.text.slice(0, at)}
        <mark className="rs-mark">{it.mark}</mark>
        {it.text.slice(at + it.mark.length)}
      </>
    );
  };
  return (
    <div className="rs-ex">
      <p className="rs-kind">
        <Icon name="file" />
        {/^https:\/\//.test(ex.source) ? (
          <a href={ex.source} target="_blank" rel="noopener">
            {ex.title}
          </a>
        ) : (
          <span title={ex.source}>{ex.title}</span>
        )}
      </p>
      {ex.items.map((it, i) => (
        <div className="rs-clause" key={i}>
          <div>
            {it.where && <span className="pg">{it.where}</span>}
            <q>{passage(it)}</q>
          </div>
          {(it.note || it.label) && (
            <p className="note">
              {it.label && <b>{it.label}</b>}
              {it.note || ""}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- what ab_highlight marked ---------- */

// What ab_highlight marked in its reply, lit where the drawn reply has it word for word (in one run of its text); one
// it can't find isn't shown. The reply is drawn first; each mark then wraps the first place it's found.
function lightMarks(el: HTMLElement, marks: TurnShape["marks"]) {
  if (el.dataset.rsMarked) return;
  el.dataset.rsMarked = "1";
  for (const mk of marks || []) {
    if (!mk?.text) continue;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      const at = n.data.indexOf(mk.text);
      if (at < 0) continue;
      const hit = n.splitText(at);
      hit.splitText(mk.text.length);
      const mark = document.createElement("mark");
      mark.className = "rs-mark";
      if (mk.note) mark.title = mk.note;
      hit.replaceWith(mark);
      mark.append(hit);
      break;
    }
  }
}
// The class that finds a reply's drawn text again, for its marks.
const markClass = (id: string) => `rs-m-${String(id).replace(/[^\w-]/g, "_")}`;

/* ---------- the reply ---------- */

// A reply with its turn's shape: text first. Its verdict, a chip and a line; then the reply as written (a long one: its
// first paragraph, the rest under "The rest, 120 words"); then only what text can't do: what it made for you (pictures,
// cards, times, drafts, a chart, a diagram, with their buttons when `act`: it's the thread's latest and it takes a
// message), what the turn made as chips from the thread's own data, the to-dos it left you with their answers, the path
// it took and what it read for you, and the checks, last and small. A gist from an older plugin isn't drawn: the text
// is there.
export function ShapedBody({ m, s, text, runs, act }: { m: Message; s: Thread; text: string; runs: MdRun | null; act: boolean }) {
  const sh: TurnShape = m.shape || {};
  const v = sh.verdict;
  const open = useMsgOpen(m.id);
  const acted = useReply((st) => st.acted);
  const opened = useReply((st) => st.open);
  const msgs = useMsgs(s);
  const t = turnOf(s, m, msgs);
  const cx: ReplyCx = { s, m, act, gone: (key) => acted.has(`${m.id}:${key}`), open: (key) => opened.has(key) };
  const marks = sh.marks?.length ? sh.marks : null;
  const mc = marks ? markClass(m.id) : "";
  const marksKey = marks ? JSON.stringify(marks) : "";
  useLayoutEffect(() => {
    if (!marks) return;
    for (const el of document.querySelectorAll<HTMLElement>(`.${mc}`)) lightMarks(el, marks);
  });
  // Where its code blocks run: the first part's from its first block, the rest's from the blocks before it.
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  const long = !!text && (v ? words > 120 : linesOf(text) > 16);
  const cut = long && v ? text.search(/\n\s*\n/) : -1;
  const lead = long && cut > 0 ? text.slice(0, cut) : "";
  const more = long ? (cut > 0 ? text.slice(cut).trim() : text) : "";
  const leadRun = useMemo(() => runs && { ...runs, first: 0 }, [runs?.post, runs?.mid, runs?.play]);
  const moreRun = useMemo(() => runs && { ...runs, first: codeBlockCount(lead) }, [runs?.post, runs?.mid, runs?.play, lead]);
  const head = v ? (
    <div className="md">
      <p className="verdict">
        <span className={`vchip vchip--${v.kind}`}>{VERDICT_WORD[v.kind] || v.kind}</span>
        <b>
          <Hl text={v.line} />
        </b>
      </p>
    </div>
  ) : null;
  const after = (
    <>
      {(sh.drafts || []).map((d, i) => (
        <DraftCard cx={cx} d={d} i={i} key={`d${i}`} />
      ))}
      {sh.cards?.length > 0 && <CardsBlock cx={cx} cards={sh.cards} pick={sh.cardsPick} />}
      {sh.slots && <SlotsBlock cx={cx} sl={sh.slots} />}
      {sh.compare && <CompareBlock cx={cx} c={sh.compare} />}
      {sh.diagram && (
        <>
          {sh.diagram.title && <p className="rs-cmp-h">{sh.diagram.title}</p>}
          <Diagram dg={sh.diagram} />
        </>
      )}
      {sh.chart && (
        <div className="rs-chart">
          {sh.chart.title && <p className="rs-cmp-h">{sh.chart.title}</p>}
          <WChart d={sh.chart} title={sh.chart.title} />
        </div>
      )}
      <ThingsRow s={s} t={t} mid={m.id} />
      <YoursBlock cx={cx} t={t} />
      {(sh.path || sh.excerpts) && (
        <div className="md">
          {sh.path && <PathBlock path={sh.path} />}
          {sh.excerpts && <ExcerptsBlock ex={sh.excerpts} />}
        </div>
      )}
      {sh.checks?.length > 0 && <ChecksBlock cx={cx} checks={sh.checks} />}
    </>
  );
  if (!text)
    return (
      <>
        {head}
        {after}
      </>
    );
  const first = head ? "" : " is-first";
  // The reply as written, drawn: keyed by its text and its marks, so marks lit in it are never left on other words.
  const drawn = (part: string, run: MdRun | null, cls: string) => <Markdown key={`${part}\n${marksKey}`} text={part} peek={peekOf(s)} pics={postPics(s)} from={s.id} run={run} className={`md md-rest${cls}${mc ? ` ${mc}` : ""}`} />;
  if (!long)
    return (
      <>
        {head}
        {drawn(text, leadRun, first)}
        {after}
      </>
    );
  // Long: its first paragraph open, the rest folded; what it made stays in view under it.
  const moreWords = (more.match(/[\p{L}\p{N}]+/gu) || []).length;
  return (
    <>
      {head}
      {lead && drawn(lead, leadRun, first)}
      {open && drawn(more, moreRun, lead ? "" : first)}
      <button className={`md-fold${open ? " is-open" : ""}`} type="button" aria-expanded={open} onClick={() => toggleMsgOpen(m.id)}>
        {open ? "See less" : `${lead ? "The rest" : "Show all"}, ${plural(moreWords, "word")}`}
        <Icon name="down" />
      </button>
      {after}
    </>
  );
}

// The replies it suggests, under it: a click sends one as your message, as the box would (held for after the turn
// while one runs), and what happened to it is said as the box says it.
export function QuickRow({ s, m, picks }: { s: Thread; m: Message; picks: string[] }) {
  const sent = useQuickSent(m.id);
  const send = async (text: string) => {
    if (quickSentNow(m.id)) return;
    markQuickSent(m.id, true);
    const r = await sayToThread(s.id, text);
    if (!r.ok) markQuickSent(m.id, false);
  };
  return (
    <div className="quick-row">
      {picks.map((p, i) => (
        <button className={`quick${i ? "" : " quick--first"}`} type="button" key={i} disabled={sent} onClick={() => send(p)}>
          {p}
        </button>
      ))}
    </div>
  );
}

