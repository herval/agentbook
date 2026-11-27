// A thread of yours, not an agent's: on the server, with no machine behind it. Each agent
// you name in it joins it as a guest, a thread of its own whose messages show in it. Its own page: the conversation,
// and on the side who's in it and what it is; its card in a list (TalkCard); and under a message of yours in it, who
// it went to (TalkSentTo). Sending is talk.ts.
import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { pickFile } from "../../lib/api.ts";
import { setChrome } from "../../lib/chrome.ts";
import { ago, hueVars } from "../../lib/format.ts";
import { getDraft, useDraft } from "../../lib/hooks.ts";
import { workspaces } from "../../lib/agents.ts";
import { personHref, threadHref } from "../../lib/route.ts";
import { agentOf, useApp } from "../../lib/store.ts";
import type { Message, Question, Thread, ThreadDetail } from "../../lib/types.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../../components/Avatar.tsx";
import { Icon } from "../../components/Icon.tsx";
import { MsgBox } from "../../components/MsgBox.tsx";
import { useSided } from "../../components/Shell.tsx";
import { ThreadPeople, VisCorner, levelOf } from "../../components/Visibility.tsx";
import { WsChip } from "../../components/post/PostHead.tsx";
import { Hl } from "../../components/post/util.tsx";
import { Bubble, SaidText } from "../../components/thread/Bubble.tsx";
import { GuestLive, ToHint, askerOf, guestsOn, guestWords, threadQs } from "../../components/thread/Guests.tsx";
import { AskBlock, InConvo, askSpot } from "../../components/post/Ask.tsx";
import { Answered } from "../../components/thread/guest-convo.tsx";
import { setTalkTo, talkTarget, talkToNow, useTalkTo } from "../../components/thread/guest-rows.ts";
import type { Guest } from "../../components/thread/guest-rows.ts";
import { StagedChips, stage } from "../../components/thread/staged.tsx";
import type { SaidMsg } from "../../components/thread/types.ts";
import { replyTalk, talkArchive, talkOut, useTalkSending } from "./talk.ts";
import { PeopleLane } from "../../components/people/PeopleLane.tsx";

// Who sees a thread of yours, said of one that isn't.
const SEES = { public: "Its owner's contacts", private: "Its owner and the people they put on it" };
// While it's private: you, and the people you put on it.
const privateWords = (s: Thread) => ({ private: s.people?.length ? "you and the people you put on it" : "only you" });

export function TalkSentTo({ m, s }: { m: Message; s: Thread }) {
  const to = (m as SaidMsg).to || [];
  if (!to.length) return <span className="cmt-to">to nobody</span>;
  return (
    <span className="cmt-to">
      to{" "}
      {to.map((id, i) => {
        const g = (s.guests || []).find((x) => x.id === id);
        return (
          <span key={id}>
            {i ? ", " : ""}
            <a href={threadHref(id)}>{g?.label || (g ? agentOf(g.agent).name : "") || "its thread"}</a>
          </span>
        );
      })}
    </span>
  );
}

// Whose it is, how it's going, and who's in it, faces that breathe while they work.
function TalkHead({ s }: { s: Thread }) {
  const me = useApp((st) => st.me);
  useApp((st) => st.data);
  const ws = s.workspace ? workspaces().find((w) => w.id === s.workspace) : null;
  const gs = guestsOn(s) as Guest[];
  const others = s.mine === false;
  return (
    <header className="post-head talk-head">
      {others ? (
        <a href={personHref(s.owner)}>
          <PersonAvatar who={s.owner} size="" />
        </a>
      ) : (
        <YouAvatar size="" />
      )}
      <div className="post-who">
        {others ? (
          <a href={personHref(s.owner)}>
            <b>@{s.owner}</b>
          </a>
        ) : (
          <b>{me?.display_name || me?.username || "You"}</b>
        )}{" "}
        <span className="verb">{gs.length || (s.guests || []).length ? "asked" : "wrote"}</span>
        <div className="post-meta">
          {s.pinned && (
            <span className="pinned" title="Pinned">
              <Icon name="pin" />
            </span>
          )}
          {ws && <WsChip ws={ws} />}
          <span title={`Started ${new Date(s.started).toLocaleString()}`}>{ago(s.updated)}</span>
          {s.effective === "needs" ? (
            <span className="chip chip--sun">Needs you</span>
          ) : s.effective === "working" ? (
            <span className="chip chip--live">
              <i className="pulse" />
              Working
            </span>
          ) : null}
        </div>
      </div>
      {gs.length ? (
        <span className="talk-with" title={`With ${gs.map((g) => (g.label ? `${g.label} (${agentOf(g.agent).name})` : agentOf(g.agent).name)).join(", ")}`}>
          With
          <span className="faces">
            {gs.map((g) => (
              <a href={threadHref(g.id)} className={g.effective === "needs" ? "is-asks" : undefined} key={g.id}>
                <Avatar agent={g.agent} size="av--sm" on={g.effective === "working" || g.effective === "starting" ? "active" : false} />
              </a>
            ))}
          </span>
        </span>
      ) : (
        <span className="talk-with talk-alone">Just you</span>
      )}
      <VisCorner kind="talk" id={s.id} level={s.visibility} mine={s.mine !== false} words={privateWords(s)} />
    </header>
  );
}

function TalkToRow({ s, msgs }: { s: Thread; msgs: Message[] }) {
  const picked = useTalkTo((st) => st.to);
  if (!guestsOn(s).length) return null;
  const to = talkToNow(s, msgs, picked);
  const later = guestsOn(s)
    .filter((g) => !to.includes(`thread:${g.id}`))
    .map((g) => g.label || agentOf(g.agent).name);
  const hint = !to.length ? "To nobody: it stays here, and each agent in it hears it with its next message. @ one to send it." : later.length ? `${later.join(" and ")} ${later.length > 1 ? "hear" : "hears"} it with ${later.length > 1 ? "their" : "its"} next message.` : "";
  return (
    <div className="to-row">
      <span className="to-h">To</span>
      {to.map((t) => {
        const x = talkTarget(s, t);
        const name = agentOf(x.agent).name;
        return (
          <span className="to-chip" style={hueVars(x.agent)} key={t}>
            <Avatar agent={x.agent} size="av--xs" />
            <b>{name}</b>
            {x.label && <small>{x.label}</small>}
            <button
              type="button"
              aria-label={`Not to ${name}`}
              title="Not to it"
              onClick={() => {
                setTalkTo(
                  s.id,
                  to.filter((y) => y !== t),
                );
                document.querySelector<HTMLElement>(`form[data-talk][data-comment="${CSS.escape(s.id)}"] .text-box :is([contenteditable], textarea)`)?.focus();
              }}
            >
              <Icon name="x" />
            </button>
          </span>
        );
      })}
      {hint && <span className="to-later">{hint}</span>}
    </div>
  );
}

// Its reply box: yours only. Its To row sits over the form.
function TalkReplyBox({ s, msgs }: { s: Thread; msgs: Message[] }) {
  const key = `c:${s.id}`;
  const [text] = useDraft(key);
  const busy = useTalkSending((st) => st.keys.has(key));
  if (s.mine === false) return null;
  const placeholder = guestsOn(s).length ? "Reply, or @ an agent to bring it in…" : "Write more, or @ an agent to bring it in…";
  return (
    <>
      <TalkToRow s={s} msgs={msgs} />
      <form
        className="cmt-form"
        data-comment={s.id}
        data-talk=""
        onSubmit={(e) => {
          e.preventDefault();
          replyTalk(s.id, getDraft(key));
        }}
      >
        <div className="cmt-in">
          <YouAvatar />
          <div className="text-box">
            <MsgBox draft={key} placeholder={placeholder} label="Reply" onSend={(t) => replyTalk(s.id, t)} />
            <button className="icon-btn" type="button" aria-label="Attach files" onClick={() => pickFile((files: File[]) => stage(key, files), true)}>
              <Icon name="clip" />
            </button>
            <button className="icon-btn" type="submit" aria-label="Send" disabled={busy}>
              <Icon name="send" />
            </button>
          </div>
        </div>
        <ToHint threadId={s.id} text={text} talk />
        <StagedChips draftKey={key} />
      </form>
    </>
  );
}

// Its conversation: its messages and what its agents ask, each question under the message it goes with (askSpot).
function talkConvo(s: Thread, msgs: Message[], qs: Question[], { page = false } = {}) {
  return [
    ...msgs.map((m, i) => ({ at: m.at, key: `m:${m.id}`, node: page ? <Bubble m={m} s={s} last={i === msgs.length - 1} quick={i === msgs.length - 1} frames /> : <Bubble m={m} s={s} /> })),
    ...qs.map((q) => ({
      at: askSpot(q, msgs),
      key: `q:${q.id}`,
      node:
        page && q.answered ? (
          <Answered q={q} s={askerOf(q, s)} />
        ) : (
          <InConvo thread={askerOf(q, s)}>
            <AskBlock q={q} />
          </InConvo>
        ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

export function TalkCard({ thread: s }: { thread: Thread }) {
  const questions = useApp((st) => st.data?.questions) || [];
  const own = (s as ThreadDetail).questions;
  const qs = threadQs(s, Array.isArray(own) ? own : questions).filter((q) => !q.answered);
  const msgs = s.last_messages || [];
  const href = threadHref(s.id);
  return (
    <article className={`card post talk-card ${qs.length ? "post--ask" : ""}`}>
      <TalkHead s={s} />
      <h2 className="post-title">
        <a href={href}>
          <Hl text={s.title} />
        </a>
      </h2>
      {s.text && (
        <div className="post-text">
          <SaidText text={s.text} s={s} />
        </div>
      )}
      <div className="comments">
        {typeof s.messages === "number" && s.messages > msgs.length && (
          <a className="more-c" href={href}>
            View all {s.messages} replies
          </a>
        )}
        {talkConvo(s, msgs, qs).map((c) => (
          <Fragment key={c.key}>{c.node}</Fragment>
        ))}
        <GuestLive s={s} />
        <TalkReplyBox s={s} msgs={msgs} />
      </div>
    </article>
  );
}

// A button that waits for what it does (the page reads the thread again after).
function BusyButton({ className, title, label, run, children }: { className: string; title?: string; label?: string; run: () => Promise<void>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      title={title}
      aria-label={label}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        run().finally(() => setBusy(false));
      }}
    >
      {children}
    </button>
  );
}

function InIt({ s }: { s: Thread }) {
  const all = (s.guests || []) as Guest[];
  return (
    <section className="card rail-card">
      <h3 className="rail-h">
        In it <span className="n">{guestsOn(s).length}</span>
      </h3>
      {all.length ? (
        <ul className="talk-in">
          {all.map((g) => (
            <li className={g.removed ? "is-gone" : ""} key={g.id}>
              <a href={threadHref(g.id)}>
                <Avatar agent={g.agent} size="av--sm" on={g.effective === "working" ? "active" : false} />
                <span className="t">
                  <b>
                    {agentOf(g.agent).name}
                    {g.label ? ` · ${g.label}` : ""}
                  </b>
                  <small className={g.effective === "needs" ? "is-asks" : ""}>{g.removed ? "Left" : g.effective === "needs" ? "Asked you something" : guestWords(g)}</small>
                </span>
              </a>
              {s.mine !== false && !g.removed && (
                <BusyButton className="icon-btn" title="Take it out of this thread: what it said stays" label={`Take ${agentOf(g.agent).name} out`} run={() => talkOut(s.id, g.id)}>
                  <Icon name="x" />
                </BusyButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted talk-none">Nobody yet.</p>
      )}
      {s.mine !== false && <p className="muted talk-none">@ an agent in the box to bring it in.</p>}
    </section>
  );
}

export function TalkPage({ detail }: { detail: ThreadDetail }) {
  useSided(false);
  const questions = useApp((st) => st.data?.questions) || [];
  useApp((st) => st.data?.workspaces);
  const s = { ...detail, messages: (detail.messages || []).filter((m) => !m.queued) };
  const qs = threadQs(s, questions);
  const on = guestsOn(s);
  // ▥'s badge: who's in it, and whether one needs you.
  const n = on.length;
  const needs = on.some((g) => g.effective === "needs");
  useEffect(() => {
    setChrome({ panel: { title: "In it", ...(n ? { n, needs } : {}) } });
    return () => setChrome({ panel: null });
  }, [n, needs]);
  const owner = s.mine === false ? `@${s.owner}` : "You";
  const nobody = (s.guests || []).length || s.mine === false ? "No replies yet." : "Just you so far. @ an agent below to bring it in: it gets a thread of its own, and answers here.";
  const convo = talkConvo(s, s.messages, qs, { page: true });
  const ws = s.workspace ? workspaces().find((w) => w.id === s.workspace) : null;
  return (
    <div className="sess-shell">
      <main>
        <p className="crumbs">
          <a href={s.mine === false ? personHref(s.owner) : "#/"}>{owner}</a>
          <span className="sep">/</span>
          <a href="#/">Threads</a>
          <span className="sep">/</span>
          <span>{s.title}</span>
        </p>
        <article className="card post post--full talk-card">
          <TalkHead s={s} />
          <h1 className="post-title post-title--big">
            <Hl text={s.title} />
          </h1>
          {s.text && (
            <div className="post-text">
              <SaidText text={s.text} s={s} />
            </div>
          )}
          <div className="comments">
            {convo.length ? (
              convo.map((c) => (
                <Fragment key={c.key}>{c.node}</Fragment>
              ))
            ) : (
              <p className="muted">{nobody}</p>
            )}
          </div>
          {on.some((g) => g.effective === "working" || g.effective === "starting") && (
            <div className="comments">
              <GuestLive s={s} />
            </div>
          )}
          <div className="comments">
            <TalkReplyBox s={s} msgs={s.messages} />
          </div>
          <PeopleLane id={s.id} mine={s.mine !== false} agent={false} />
        </article>
      </main>
      <aside className="rail sess-side">
        <InIt s={s} />
        <section className="card rail-card">
          <h3 className="rail-h">About this thread</h3>
          <dl className="kv">
            <dt>Started by</dt>
            <dd>{s.mine === false ? <a href={personHref(s.owner)}>@{s.owner}</a> : "You"}</dd>
            <dt>Started</dt>
            <dd>{new Date(s.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</dd>
            <dt>Agents work</dt>
            <dd>{ws ? `in ${ws.name}` : "in a folder of its own"}</dd>
            <dt>Who sees it</dt>
            <dd>{s.mine === false ? SEES[levelOf(s.visibility)] : <VisCorner kind="talk" id={s.id} level={s.visibility} label words={privateWords(s)} />}</dd>
          </dl>
          {s.mine !== false && <ThreadPeople s={s} />}
          {s.mine !== false && (
            <div className="side-acts">
              <BusyButton className="btn btn--line" run={() => talkArchive(s.id, !!s.archived)}>
                <Icon name="archive" />
                {s.archived ? "Unarchive" : "Archive"}
              </BusyButton>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
