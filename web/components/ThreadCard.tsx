// app.ts postCard, launchCard and feedItems: a thread's card in a list (the Feed, an agent's, a workspace's or a
// group's threads), a thread still starting, and a list's cards in order with Show more at its end.
import { useState } from "react";
import { agentName, postOwner, repoName } from "../lib/agents.ts";
import { feedMore, feedMoreBusy, nowOf } from "../lib/feed.ts";
import { hueVars } from "../lib/format.ts";
import { plainMentions } from "../lib/mentions.tsx";
import { postPics } from "../lib/markdown.ts";
import { machineHref, threadHref } from "../lib/route.ts";
import { found, haystack, hits, excerpt } from "../lib/search.ts";
import { serverFound } from "../lib/feed.ts";
import { agentOf, useApp } from "../lib/store.ts";
import type { FeedList, LaunchRow as Launch, PageRow, Question, TheirCard, Thread } from "../lib/types.ts";
import { webUrl, ago } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { askerOf, askSpot, AskBlock, InConvo, threadQs, WaitingElsewhere, waitsElsewhere } from "./post/Ask.tsx";
import { PageFeedCard } from "./post/PageFeedCard.tsx";
import { TheirFeedCard } from "./people/TheirCard.tsx";
import { GroupChip, PageChip, PostHead } from "./post/PostHead.tsx";
import { Hl, marks, myRoutineHref, seen, startedFrom, useSearchTerms, useThreadGroup } from "./post/util.tsx";
import { ArchiveLaunch, TrustButton, untrustedStart } from "./ThreadRow.tsx";
import { useChrome } from "../lib/chrome.ts";
import { Bubble, peekOf } from "./thread/Bubble.tsx";
import { Cover } from "./thread/FileChip.tsx";
import { GuestLive } from "./thread/Guests.tsx";
import { LiveLine } from "./thread/Live.tsx";
import { QueueTray, ReplyBox, WaitTray } from "./thread/ReplyBox.tsx";
import { PlanBar } from "./visual/PlanBar.tsx";
import { TalkCard } from "../views/thread/TalkPage.tsx";
import { Actions, FilesRow, Summary, ThreadTodos } from "./thread/Actions.tsx";
import { Attachment, PrCards, Updates } from "./thread/Results.tsx";

// Who asked for a thread: you, its owner, the routine it's a run of, or the thread that started it (a Claude Desktop
// session that started another).
function AskedBy({ s }: { s: Thread }) {
  const routine = seen(s).routine;
  if (routine)
    return (
      <>
        <a href={myRoutineHref(routine.id)}>
          <Icon name="repeat" />
          {routine.name}
        </a>{" "}
        asked
      </>
    );
  const from = startedFrom(s);
  if (from && !s.side_at)
    return (
      <>
        <a href={threadHref(from.id)} title={from.title || ""}>
          {from.label || "The thread that started it"}
        </a>{" "}
        asked
      </>
    );
  return <>{s.mine === false ? `@${postOwner(s)} asked` : "You asked"}</>;
}

// A post can match on something its card doesn't show: an older message, or its prompt. Then the bit of it
// around the match shows why the post is here.
const isPrompt = (m: { from: string; text?: string }, s: Thread) => m.from === "human" && !!s.prompt && !!m.text?.startsWith(s.prompt);
function HiddenHit({ s }: { s: Thread }) {
  const q = useChrome((c) => c.q);
  const terms = useSearchTerms();
  if (!q || !terms) return null;
  const msgs = s.last_messages || [];
  const shown = haystack([s.title, s.label, s.repo, s.branch, s.text, ...(s.updates || []).slice(-4).map((u) => u.text), ...msgs.map((m) => m.text)].map((x) => x ?? "").join(" "));
  const only = terms.filter((t) => !found(shown, t));
  if (!only.length) return null;
  const hit = serverFound(q)?.posts.get(s.id)?.hit;
  if (hit && !msgs.some((m) => m.id === hit.id)) {
    const who = hit.from === "human" ? (s.mine === false ? `@${postOwner(s)}` : "You") : agentName(s.agent);
    return (
      <div className="post-hit">
        <b>{who}</b> {hit.from === "human" ? marks(hit.text, terms) : <Markdown text={hit.text} pics={postPics(s)} from={s.id} className="md-inline" />}
      </div>
    );
  }
  const first = s.prompt && !msgs.some((m) => isPrompt(m, s)) ? hits(s.prompt, only)[0] : null;
  if (!first) return null;
  return (
    <p className="post-text muted">
      <AskedBy s={s} />: “{marks(plainMentions(excerpt(s.prompt, first)), terms)}”
    </p>
  );
}

// A thread's card: its head, title and what it's about, what it's done (pictures, plan, updates, pull requests,
// to-dos, attachments, files, its turn's summary and buttons), and its latest messages with a question still open
// among them, what it's doing now, and the box to write to it.
export function ThreadCard({ thread: s }: { thread: Thread }) {
  const allQs = useApp((st) => st.data?.questions);
  const live = useApp(() => nowOf(s.id));
  // A thread of yours has a card of its own kind.
  if (s.talk) return <TalkCard thread={s} />;
  // A card from the feed's records has its open questions with it.
  const own = (s as Thread & { questions?: Question[] }).questions;
  const qs = threadQs(s, Array.isArray(own) ? own : allQs || []).filter((q) => !q.answered);
  const msgs = s.last_messages || [];
  const plan = live?.plan || s.plan;
  const showPlan = s.effective !== "done" && plan?.length && plan.some((t) => t.status !== "completed");
  // Its latest messages, with a question still open among them, as on its page.
  const convo = [
    ...msgs.map((m, i) => ({ at: m.at, key: `m:${m.id}`, el: <Bubble m={m} s={s} quick={i === msgs.length - 1} /> })),
    ...qs.map((q) => ({
      at: askSpot(q, msgs),
      key: `q:${q.id}`,
      el: (
        <InConvo thread={askerOf(q, s)}>
          <AskBlock q={q} />
        </InConvo>
      ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const waiting = !qs.some((q) => q.post === s.id) && waitsElsewhere(s);
  const n = typeof s.messages === "number" ? s.messages : 0;
  return (
    <article className={`card post ${qs.length ? "post--ask" : ""}`} style={hueVars(s.agent)} data-thread={s.id}>
      <PostHead thread={s} page />
      <h2 className="post-title">
        <a href={threadHref(s.id)}>
          <Hl text={s.title} />
        </a>
      </h2>
      {s.text && <Markdown text={s.text} peek={peekOf(s)} pics={postPics(s)} from={s.id} className="post-text md" />}
      <HiddenHit s={s} />
      <Cover pics={s.last_pictures} count={s.pictures} />
      {showPlan ? <PlanBar plan={plan} /> : null}
      <Updates thread={s} />
      <PrCards thread={s} feed />
      <ThreadTodos thread={s} card />
      {Object.entries(s.attachments || {}).map(([k, a]) => (
        <Attachment key={k} a={a} s={s} />
      ))}
      <FilesRow thread={s} />
      <Summary thread={s} />
      <Actions thread={s} />
      <div className="comments">
        {n > msgs.length && (
          <a className="more-c" href={threadHref(s.id, "messages=all")}>
            View all {n} messages
          </a>
        )}
        {convo.map((c) => (
          <Frag key={c.key}>{c.el}</Frag>
        ))}
        <LiveLine s={s} />
        <GuestLive s={s} />
        {waiting && (
          <InConvo thread={s}>
            <WaitingElsewhere thread={s} />
          </InConvo>
        )}
        <WaitTray s={s} list={s.waiting} compact />
        <QueueTray s={s} queue={s.queue} compact />
        <ReplyBox s={s} />
      </div>
    </article>
  );
}
const Frag = ({ children }: { children: React.ReactNode }) => <>{children}</>;

// What a start is doing before its session is up ("Making its worktree"), with how far it got.
function LaunchLive({ l }: { l: Launch }) {
  const p = l.progress;
  const pct = p?.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null;
  return (
    <div className="live live--step">
      <i className="pulse" />
      <b>{l.step || (l.cloning ? "Cloning" : "Starting")}</b>
      {pct != null && (
        <>
          <span className="meter">
            <span>
              <b style={{ width: `${pct}%` }} />
            </span>
            <em>{pct}%</em>
          </span>
          <span className="live-n">
            {p.done.toLocaleString()} / {p.total.toLocaleString()} files
          </span>
        </>
      )}
    </div>
  );
}

// A thread still starting: what it's doing, or why it couldn't start, or the machine it waits for.
export function LaunchCard({ launch: l }: { launch: Launch }) {
  // A machine of yours that runs in a cloud sandbox, as the server last said (cloud.ts): { waking, error } or null.
  const cloud = useApp((st) => (l.waiting ? (st.data?.machines || []).find((m) => m.name === l.waiting)?.cloud || null : null));
  const group = useThreadGroup(l.group);
  const where = (l.root || "").split("/").pop();
  const verb = l.error ? "couldn't start" : l.waiting ? (cloud?.waking ? `starts once ${l.waiting} is awake` : `starts when ${l.waiting} is back`) : l.teleport ? "is teleporting from claude.ai" : l.cloning ? `is cloning ${repoName(l.cloning)}` : l.step ? `is ${l.step.replace(/^./, (c) => c.toLowerCase())}` : "is starting";
  const archive = (
    <ArchiveLaunch launch={l}>
      <Icon name="archive" />
      Archive
    </ArchiveLaunch>
  );
  const machine = l.waiting ? <a href={machineHref(l.waiting)}>{l.waiting}</a> : null;
  let body: React.ReactNode;
  if (untrustedStart(l))
    body = (
      <>
        <p className="post-text err">Claude Code doesn't trust {l.cwd || l.root} yet, so it won't start a session there.</p>
        <div className="post-acts">
          <TrustButton launch={l} />
          {archive}
        </div>
      </>
    );
  else if (l.error)
    body = (
      <>
        <p className="post-text err">{l.error}</p>
        <div className="post-acts">{archive}</div>
      </>
    );
  else if (l.waiting)
    body = (
      <>
        {cloud?.waking ? (
          <div className="live live--step">
            <i className="pulse" />
            <b>Waking {machine}</b>
            <span className="live-n">{cloud.error ? cloud.error : "its sandbox was asleep"}</span>
          </div>
        ) : cloud?.error ? (
          <p className="post-text err">
            Couldn't wake {machine}. {cloud.error}
          </p>
        ) : (
          <p className="post-text muted">Waiting for {machine}, which is off. A start waits an hour for it.</p>
        )}
        <div className="post-acts">
          <ArchiveLaunch launch={l}>
            <Icon name="x" />
            Take it back
          </ArchiveLaunch>
        </div>
      </>
    );
  else if (l.teleport)
    body = (
      <>
        <p className="post-text">Finish in the terminal. Its thread replaces this one once it starts.</p>
        <div className="live">
          <i className="pulse" />
          <b>Teleporting</b>
        </div>
      </>
    );
  else body = <LaunchLive l={l} />;
  return (
    <article className="card post" style={hueVars(l.agent)}>
      <header className="post-head">
        <Avatar agent={l.agent} />
        <div className="post-who">
          <b>{agentName(l.agent)}</b>
          {agentOf(l.agent).offline && (
            <>
              {" "}
              <span className="on">offline</span>
            </>
          )}{" "}
          <span className="verb">{verb}</span>
          <div className="post-meta">
            <span>{where}</span>
            <PageChip id={l.page} />
            {group && <GroupChip group={group} />}
            {l.branch && <span className="chip chip--branch">{l.branch}</span>}
            <span>{ago(l.at)}</span>
          </div>
        </div>
      </header>
      <h2 className="post-title">
        {l.teleport ? (
          <a href={webUrl(l.prompt) || "#"} target="_blank" rel="noopener">
            {l.prompt.replace(/^https:\/\//, "")}
          </a>
        ) : (
          plainMentions(l.prompt.split("\n")[0])
        )}
      </h2>
      {body}
    </article>
  );
}

export function FeedCard({ k, record }: { k: string; record: FeedList["records"][string] | undefined }) {
  if (!record) return null;
  if (k.startsWith("thread:")) return <ThreadCard thread={record as Thread} />;
  if (k.startsWith("launch:")) return <LaunchCard launch={record as Launch} />;
  if (k.startsWith("page:")) return <PageFeedCard page={record as PageRow} />;
  if (k.startsWith("their:")) return <TheirFeedCard card={record as TheirCard} />;
  return null;
}
// Show more, at a list's end while it has more.
export function FeedMore({ feed }: { feed: FeedList | null }) {
  const [, again] = useState(0);
  if (!feed?.next) return null;
  return (
    <button
      className="feed-more"
      type="button"
      onClick={() => {
        feedMore();
        again((n) => n + 1);
      }}
    >
      {feedMoreBusy() ? "Loading…" : "Show more"}
    </button>
  );
}
// A list's cards (q/feed's records, lib/feed.ts), threads starting on top, and Show more while there's more.
export function FeedCards({ feed }: { feed: FeedList | null }) {
  if (!feed) return null;
  const any = feed.list.some((k) => feed.records[k]);
  return (
    <>
      {feed.list.map((k) => (
        <FeedCard key={k} k={k} record={feed.records[k]} />
      ))}
      {any && <FeedMore feed={feed} />}
    </>
  );
}
