// The bell's menu (the old page's needsYou): what has an agent waiting on you, the longest waiting first, then your
// threads' news and what someone put you in. bell.ts says what's on it.
import { useState } from "react";
import type { ReactNode } from "react";
import { waits } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, webUrl } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { threadHref } from "../../lib/route.ts";
import { personOf, useApp, useThreadRow } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { Question, Thread } from "../../lib/types.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { ABOUT_YOU, addedHref, addedKey, addedWords, ASKING_WORDS, clearAdded, dismiss, freshKey, tookText, useBell, useBellLists, VERDICT_WORD } from "./bell.ts";
import type { AskingThread, BellLine, Failing } from "./bell.ts";

function Dismiss({ k, at, title = "Take it off the bell" }: { k: string; at: string | null | undefined; title?: string }) {
  return (
    <button className="btn btn--line btn--sm" type="button" title={title} onClick={() => dismiss(k, at)}>
      Dismiss
    </button>
  );
}
// When something on the bell happened, as "5m ago"; its title says when exactly.
function When({ at, says = "" }: { at: string | null | undefined; says?: string }) {
  if (!at) return null;
  return (
    <time className="muted" title={`${says}${new Date(at).toLocaleString()}`}>
      {agoText(at)}
    </time>
  );
}

// The few marks of markdown a line of news has (the old page's mdInline): `code`, [a link](url), **bold**, *italics*
// or _italics_, ~~struck~~, and bare web addresses as links. (Its italics never start at a ** , which is bold.)
const INLINE = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*(.+?)\*\*|~~(.+?)~~|(^|[^\w*])\*(?![\s*])(.+?)(?<!\s)\*(?!\w)|(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)|(https?:\/\/[^\s<]*[^\s<.,;:!?)"'])/g;
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const lead = m[6] ?? m[8] ?? "";
    out.push(text.slice(last, m.index) + lead);
    const k = m.index;
    const url = (u: string, inner: ReactNode) => (
      <a className="md-link" href={u} target="_blank" rel="noopener" key={k}>
        {inner}
      </a>
    );
    if (m[1] != null) out.push(/^https?:\/\/\S+$/i.test(m[1]) ? url(m[1], <code>{m[1]}</code>) : <code key={k}>{m[1]}</code>);
    else if (m[2] != null) out.push(url(m[3], m[2]));
    else if (m[4] != null) out.push(<b key={k}>{m[4]}</b>);
    else if (m[5] != null) out.push(<s key={k}>{m[5]}</s>);
    else if (m[7] != null) out.push(<i key={k}>{m[7]}</i>);
    else if (m[9] != null) out.push(<i key={k}>{m[9]}</i>);
    else out.push(url(m[10], m[10]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function NeedRow({ s, asked, says, acts, sending = false }: { s: Thread | undefined; asked: string | null | undefined; says: ReactNode; acts: ReactNode; sending?: boolean }) {
  return (
    <div className={`need${sending ? " is-sending" : ""}`}>
      <Avatar agent={s?.agent || "claude"} size="av--sm" />
      <p>
        <a href={threadHref(s?.id || "")}>
          <b>{s?.label || ""}</b>
        </a>{" "}
        {says}
      </p>
      <div className="need-acts">
        {acts}
        <When at={asked} says="Asked " />
      </div>
    </div>
  );
}
// A question an agent asks you: a permission prompt, which you can Allow or Deny from here, or a question, which you
// answer on its thread.
function QuestionRow({ q }: { q: Question }) {
  const s = useThreadRow(q.post);
  const [sending, setSending] = useState(false);
  const answer = (value: string) => {
    setSending(true);
    post(`/api/questions/${encodeURIComponent(q.id)}/answer`, { value }).then((r) => r?.ok && r.data?.queued && toast(waits(r.data, "your answer reaches it if that's within a minute")));
  };
  if (q.kind === "permission")
    return (
      <NeedRow
        s={s}
        asked={q.asked}
        sending={sending}
        says={
          <>
            wants to use {q.tool_name || "a tool"}
            {q.preview ? (
              <>
                : <code>{q.preview.slice(0, 60)}</code>
              </>
            ) : null}
          </>
        }
        acts={
          <>
            <button className="btn btn--dark btn--sm" type="button" onClick={() => answer("allow")}>
              Allow
            </button>
            <button className="btn btn--sm" type="button" onClick={() => answer("deny")}>
              Deny
            </button>
            <Dismiss k={`q:${q.id}`} at={q.asked} title="Take it off the bell. It still waits in its thread" />
          </>
        }
      />
    );
  return (
    <NeedRow
      s={s}
      asked={q.asked}
      says={<>asks: {q.title}</>}
      acts={
        <>
          <a className="btn btn--sm" href={threadHref(q.post, `ask=${encodeURIComponent(q.id)}`)}>
            Answer
          </a>
          <Dismiss k={`q:${q.id}`} at={q.asked} title="Take it off the bell. It stays open on its thread" />
        </>
      }
    />
  );
}
function AskingRow({ s }: { s: AskingThread }) {
  return (
    <NeedRow
      s={s}
      asked={s.asking.at}
      says={`${ASKING_WORDS[s.asking.kind] || "needs you"}${s.asking.line ? `: ${s.asking.line}` : ""}`}
      acts={
        <>
          <a className="btn btn--sm" href={threadHref(s.id)}>
            Open
          </a>
          <Dismiss k={`ask:${s.id}`} at={s.asking.at} title="Take it off the bell, until it asks again" />
        </>
      }
    />
  );
}
function FailedRow({ r }: { r: Failing }) {
  return (
    <div className="need">
      {r.agent ? (
        <Avatar agent={r.agent} size="av--sm" />
      ) : (
        <span className="av av--sm av--rt">
          <Icon name="repeat" />
        </span>
      )}
      <p>
        <a href={r.href}>
          <b>{r.name}</b>
        </a>{" "}
        failed{r.times > 1 ? ` ${r.times} times in a row` : ""}
        {r.error ? `: ${r.error.slice(0, 200)}` : ""}
      </p>
      <div className="need-acts">
        <a className="btn btn--sm" href={r.href}>
          Open
        </a>
        <Dismiss k={r.key} at={r.at} title="Take it off Needs you, until it fails again" />
        <When at={r.at} says="Failed " />
      </div>
    </div>
  );
}

// Whether a line of what's new gets the dot: it's new, or was when the bell opened.
const useFresh = (x: BellLine) => {
  const fresh = useBell((b) => b.fresh);
  return !x.seen || fresh?.has(freshKey(x)) ? " need--fresh" : "";
};
// A thread Auto-archive archived once its work was in (your settings): its agent, its name, and why.
function ArchivedRow({ x }: { x: BellLine }) {
  const fresh = useFresh(x);
  return (
    <div className={`need${fresh}`}>
      <Avatar agent={x.agent || "claude"} size="av--sm" />
      <p>
        <a href={threadHref(x.id)}>
          <b>{x.title || "A thread"}</b>
        </a>{" "}
        was archived{x.why ? `: ${x.why}` : ""}
        {x.label ? (
          <>
            {" "}
            <span className="muted">({x.label})</span>
          </>
        ) : null}
      </p>
      <div className="need-acts">
        <a className="btn btn--sm" href={threadHref(x.id)}>
          Open
        </a>
        <Dismiss k={addedKey(x)} at={x.at} />
        <When at={x.at} />
      </div>
    </div>
  );
}
// A thread's news (server/news.ts): its name on a line of its own, cut to fit, then what happened, whole: the server
// keeps it short; the rest is on its thread. A long turn that ended says its verdict's line (or its reply's first) and
// how long it took; a pull request, the line its thread got; what its agent flagged, that.
function NewsRow({ x }: { x: BellLine }) {
  const fresh = useFresh(x);
  const href = threadHref(x.id);
  const took = x.mins ? (
    <>
      {" "}
      <span className="muted">({tookText(x.mins)})</span>
    </>
  ) : null;
  const chip = x.verdict ? (
    <>
      <span className={`vchip vchip--${x.verdict}`}>{VERDICT_WORD[x.verdict] || x.verdict}</span>{" "}
    </>
  ) : null;
  const said =
    x.news === "turn" ? (
      x.text ? (
        <>
          {chip || "finished: "}
          {inline(x.text)}
          {took}
        </>
      ) : (
        <>
          {chip}finished its turn{took}
        </>
      )
    ) : (
      inline(x.text || "")
    );
  const out = x.news === "pr" ? webUrl(x.pr?.url) : webUrl(x.link);
  return (
    <div className={`need need--news${fresh}`}>
      <Avatar agent={x.agent || "claude"} size="av--sm" />
      <p>
        <a className="need-t" href={href} title={x.title || ""}>
          <b>{x.title || "A thread"}</b>
        </a>
        <span className="need-said" title={x.text || ""}>
          {said}
        </span>
      </p>
      <div className="need-acts">
        <a className="btn btn--sm" href={href}>
          Open
        </a>
        {out ? (
          <a className="btn btn--line btn--sm" href={out} target="_blank" rel="noopener">
            {x.news === "pr" ? `#${x.pr.number ?? ""}` : "Link"}
          </a>
        ) : null}
        <Dismiss k={addedKey(x)} at={x.at} />
        <When at={x.at} />
      </div>
    </div>
  );
}
function AddedRow({ x }: { x: BellLine }) {
  const fresh = useFresh(x);
  const u = useApp((s) => personOf(x.by, s));
  const me = useApp((s) => s.me?.username || "");
  const href = addedHref(x, me);
  return (
    <div className={`need${fresh}`}>
      <PersonAvatar who={x.by} />
      <p>
        <a href={`#/people/${x.by}`}>
          <b>{u.display_name || `@${x.by}`}</b>
        </a>
        {ABOUT_YOU.has(x.kind) ? (
          <>
            {" "}
            <a href={href}>{addedWords(x)}</a>
            {x.text ? <span className="muted"> “{x.text}”</span> : null}
          </>
        ) : (
          <>
            {" "}
            {addedWords(x)}{" "}
            <a href={href}>
              <b>
                {x.emoji ? `${x.emoji} ` : ""}
                {x.title || ""}
              </b>
            </a>
          </>
        )}
      </p>
      <div className="need-acts">
        <a className="btn btn--sm" href={href}>
          Open
        </a>
        <Dismiss k={addedKey(x)} at={x.at} />
        <When at={x.at} />
      </div>
    </div>
  );
}
// Under the bell: your threads' news (and the ones Auto-archive archived), then what someone put you in. The first of
// the two headings has Clear notifications, which takes both lists off.
function AddedRows({ all }: { all: BellLine[] }) {
  const ofThreads = all.filter((x) => x.kind === "news" || x.kind === "archived");
  const list = all.filter((x) => !ofThreads.includes(x));
  const head = (name: string, n: number, first: boolean) => (
    <h3 className="rail-h">
      <span>
        {name}
        <span className="n">{n}</span>
      </span>
      {first ? (
        <button className="rail-clear" type="button" title="Take all of them off the bell. What needs you stays" onClick={() => clearAdded(all)}>
          Clear notifications
        </button>
      ) : null}
    </h3>
  );
  return (
    <>
      {ofThreads.length ? (
        <>
          {head("News", ofThreads.length, true)}
          {ofThreads.map((x) => (x.kind === "archived" ? <ArchivedRow x={x} key={freshKey(x)} /> : <NewsRow x={x} key={freshKey(x)} />))}
        </>
      ) : null}
      {list.length ? (
        <>
          {head("New for you", list.length, !ofThreads.length)}
          {list.map((x) => (
            <AddedRow x={x} key={freshKey(x)} />
          ))}
        </>
      ) : null}
    </>
  );
}

// The bell's menu: Needs you, each line with how long it has waited, the longest first, then what's new; or that
// nothing is.
export function NeedsYou() {
  useNow(30e3);
  const { questions, asking, failed, added } = useBellLists();
  if (!questions.length && !asking.length && !failed.length)
    return added.length ? (
      <AddedRows all={added} />
    ) : (
      <>
        <h3 className="rail-h">Needs you</h3>
        <p className="muted rail-empty">Nothing right now.</p>
      </>
    );
  const items: { at: string | null; key: string; node: ReactNode }[] = [
    ...questions.map((q) => ({ at: q.asked, key: `q:${q.id}`, node: <QuestionRow q={q} key={`q:${q.id}`} /> })),
    ...asking.map((s) => ({ at: s.asking.at, key: `ask:${s.id}`, node: <AskingRow s={s} key={`ask:${s.id}`} /> })),
    ...failed.map((r) => ({ at: r.at, key: `rt:${r.key}`, node: <FailedRow r={r} key={`rt:${r.key}`} /> })),
  ];
  items.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  return (
    <>
      <h3 className="rail-h">
        Needs you<span className="n">{items.length}</span>
      </h3>
      {items.map((x) => x.node)}
      <AddedRows all={added} />
    </>
  );
}
