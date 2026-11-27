// A thread's own page (#/threads/:id, the old renderSession): its head, title and text; its plan, results, steps,
// where its time went, its images, what it changed, its to-dos, tasks and files; its actions; its conversation, what
// it's doing now, what waits to go in, and the box to write to it. Beside it, About this thread and the rest of its
// side column. A thread of yours has a page of its own kind (TalkPage).
// ?changes=<turn> opens its Changes on that turn (&at=, &file=: Changes.tsx); ?ask=<id> scrolls to that question;
// ?messages=all shows its whole conversation and scrolls to it.
import { useEffect, useLayoutEffect, useRef } from "react";
import { agentName, postOwner } from "../../lib/agents.ts";
import { hueVars } from "../../lib/format.ts";
import { postPics } from "../../lib/markdown.ts";
import { agentHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { leaveTerminal, preloadTerminal, resumeTerminal } from "../../lib/terminal.ts";
import { useOpenThread } from "../../lib/thread.ts";
import type { Thread, ThreadDetail } from "../../lib/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { ShellMsg } from "../../components/Shell.tsx";
import { InConvo, WaitingElsewhere, threadQs, waitsElsewhere } from "../../components/post/Ask.tsx";
import { GroupRef, NoteRef, PageRef, PostHead, guestsOn } from "../../components/post/PostHead.tsx";
import { Hl, myRoutineHref } from "../../components/post/util.tsx";
import { Actions, PostTasks, ThreadTodos } from "../../components/thread/Actions.tsx";
import { ROUTINE_HEAD, peekOf, startedFrom, typedText } from "../../components/thread/Bubble.tsx";
import "../../components/thread/card-parts.tsx";
import { ChangesSection } from "../../components/thread/Changes.tsx";
import { Convo, useThinking } from "../../components/thread/Convo.tsx";
import { writable } from "../../components/thread/diff-view.tsx";
import { Cover, FileChip, isPicFile } from "../../components/thread/FileChip.tsx";
import { GuestLive, WithRow } from "../../components/thread/Guests.tsx";
import { LiveLine, showsLive } from "../../components/thread/Live.tsx";
import { setThreadUi, resetThreadUi } from "../../components/thread/page-ui.ts";
import { plainParts } from "../../components/thread/Plain.tsx";
import { QueueTray, ReplyBox, WaitTray, useGoneFolder } from "../../components/thread/ReplyBox.tsx";
import { SwitchChips } from "../../components/thread/Switch.tsx";
import { PlanSection, ResultsSection } from "../../components/thread/Results.tsx";
import { Sec, resetSecs } from "../../components/thread/Sec.tsx";
import { ImagesSection, MachineOff, StepsSection, TimeSection } from "../../components/thread/Sections.tsx";
import { ThreadSide } from "../../components/thread/Side.tsx";
import { TermDock } from "../../components/thread/TermDock.tsx";
import { saidShort } from "../../lib/said.ts";
import type { ThreadX } from "../../components/thread/types.ts";
import { TalkPage } from "./TalkPage.tsx";
import { Keyed } from "../../components/Keyed.tsx";
import { PeopleLane } from "../../components/people/PeopleLane.tsx";

// Who asked for a thread: you, its owner, the routine it's a run of, or the thread that started it (a Claude Desktop
// session that started another).
function AskedBy({ s }: { s: ThreadX }) {
  if (s.routine)
    return (
      <>
        <a href={myRoutineHref(s.routine.id)}>
          <Icon name="repeat" />
          {s.routine.name}
        </a>{" "}
        asked
      </>
    );
  const from = startedFrom(s);
  if (from && !s.side_at)
    return (
      <>
        <a href={`#/threads/${encodeURIComponent(from.id)}`} title={from.title || ""}>
          {from.label || "The thread that started it"}
        </a>{" "}
        asked
      </>
    );
  return <>{s.mine === false ? `@${postOwner(s)} asked` : "You asked"}</>;
}
// What it was asked, as you typed it (a routine's run without the routine's head).
const promptText = (s: ThreadX) => saidShort(typedText(s.routine ? s.prompt.replace(ROUTINE_HEAD, "") : s.prompt));

export function ThreadPage() {
  const route = useRoute();
  const id = route.name === "session" ? route.id : null;
  const around = route.name === "session" ? route.msg || undefined : undefined;
  const open = useOpenThread(id, { around });
  const detail = open?.detail || null;
  // Another thread: its sections fold as they do by default, and each list is back to its cut. ?messages=all shows
  // its whole conversation, and scrolls to it once it's drawn; ?ask= scrolls to that question; ?msg= jumps to a message.
  const toConvo = useRef(false);
  const toAsk = useRef<string | null>(null);
  const toMsg = useRef<string | null>(null);
  useLayoutEffect(() => {
    resetSecs();
    resetThreadUi();
  }, [id]);
  useLayoutEffect(() => {
    if (route.name !== "session") return;
    if (route.convo || route.msg) {
      setThreadUi({ convoAll: true });
      if (route.convo) toConvo.current = true;
    }
    toAsk.current = route.ask || null;
    toMsg.current = route.msg || null;
  }, [id, route.name === "session" && route.convo, route.name === "session" && route.ask, route.name === "session" && route.msg]);
  useEffect(() => {
    if (!detail) return;
    if (toMsg.current) {
      const target = toMsg.current;
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-msg="${CSS.escape(target)}"]`);
        if (!el) return;
        toMsg.current = null;
        el.scrollIntoView({ block: "center" });
        el.classList.remove("is-flash");
        void el.offsetWidth;
        el.classList.add("is-flash");
        setTimeout(() => el.classList.remove("is-flash"), 2000);
      });
    }
    if (toAsk.current) {
      const ask = document.querySelector(`[data-ask="${CSS.escape(toAsk.current)}"]`);
      toAsk.current = null;
      ask?.scrollIntoView({ block: "center" });
    }
    if (toConvo.current) {
      toConvo.current = false;
      requestAnimationFrame(() => document.getElementById("convo")?.scrollIntoView({ block: "start" }));
    }
  }, [detail]);
  // Its terminal, when one of yours is still open there (and xterm.js, ready for when you open one). A thread's
  // terminal is on its page only; its shell stays on its machine meanwhile.
  const mine = !!detail && detail.mine !== false && !detail.talk;
  useEffect(() => {
    if (!mine || !detail) return;
    preloadTerminal();
    resumeTerminal(detail);
  }, [mine, detail?.id]);
  useEffect(() => () => leaveTerminal(), [id]);

  if (!detail)
    return open?.gone ? (
      <ShellMsg>
        <p>This thread isn't on agentbook.</p>
      </ShellMsg>
    ) : (
      <ShellMsg back={false}>Loading…</ShellMsg>
    );
  if (detail.talk) return <TalkPage detail={detail} />;
  return (
    <>
      <ThreadBody detail={detail} />
      <TermDock />
    </>
  );
}

function ThreadBody({ detail }: { detail: ThreadDetail }) {
  const steps = useApp((st) => (st.open?.id === detail.id ? st.open.steps : null));
  const questions = useApp((st) => st.data?.questions);
  const [thinking] = useThinking();
  const said = detail.messages || [];
  const s: ThreadDetail = { ...detail, messages: said.filter((m) => !m.queued), files: detail.files || [] };
  const t = s as unknown as ThreadX;
  const queue = said.filter((m) => m.queued);
  const gone = useGoneFolder(t);
  // Its guests' questions too, in its conversation.
  const qs = threadQs(t, questions || []);
  const openQs = qs.filter((q) => !q.answered && q.post === s.id);
  const plan = detail.live?.plan || steps?.plan || s.plan;
  // Steps, newest last. With Thinking off, without what it said between them.
  const allSteps = steps?.steps || [];
  const shownSteps = allSteps.filter((st) => thinking || st.kind !== "say");
  const canWrite = writable(t, !!gone);
  const guestsGoing = guestsOn(t).some((g) => g.effective === "working" || g.effective === "starting");
  const waiting = !openQs.length && waitsElsewhere(t);
  return (
    <div className="sess-shell">
      <main>
        <p className="crumbs">
          <a href={agentHref(s.agent)}>{agentName(s.agent)}</a>
          <span className="sep">/</span>
          <a href={agentHref(s.agent)}>Threads</a>
          <span className="sep">/</span>
          <span>{s.label}</span>
        </p>
        <article className="card post post--full" style={hueVars(s.agent)}>
          {/* Each part in a box of its own (Keyed), as the stylesheet spaces them. */}
          <Keyed k="head">
            <PostHead thread={t} />
            <WithRow s={t} />
          </Keyed>
          <Keyed k="title">
            <h1 className="post-title post-title--big">
              <Hl text={s.title} />
            </h1>
            {s.text && (
              <div className="post-text md">
                <Markdown text={s.text} peek={peekOf(t)} pics={postPics(t)} from={s.id} />
              </div>
            )}
            <Cover pics={s.files.filter(isPicFile)} count={0} page />
            {s.prompt && s.prompt !== s.title && (
              <p className="post-text muted">
                <AskedBy s={t} />: “{plainParts(promptText(t).slice(0, 400), { from: s.id })}”
              </p>
            )}
            <PageRef id={s.page} />
            <GroupRef id={s.group} />
            <NoteRef id={s.id} />
          </Keyed>
          <Keyed k="offline">
            <MachineOff s={s} />
          </Keyed>
          {/* Its bar shows folded too: how far along, at a glance. */}
          <Keyed k="plan">{plan?.length ? <PlanSection s={t} plan={plan} /> : null}</Keyed>
          <Keyed k="results">
            <ResultsSection s={t} />
          </Keyed>
          <Keyed k="steps">
            <StepsSection s={s} all={shownSteps} canWrite={canWrite} />
          </Keyed>
          <Keyed k="time">
            <TimeSection s={s} steps={allSteps} />
          </Keyed>
          <Keyed k="images">
            <ImagesSection s={s} all={shownSteps} />
          </Keyed>
          <Keyed k="changes">
            <ChangesSection s={s} canWrite={canWrite} />
          </Keyed>
          <Keyed k="todos">
            <ThreadTodos thread={t} />
          </Keyed>
          <Keyed k="tasks">
            <PostTasks s={t} />
          </Keyed>
          <Keyed k="files">
            {s.files.length > 0 && (
              <Sec k="files" label="Files" count={<span className="muted">{s.files.length}</span>}>
                <div className="files-row">
                  {s.files.map((f) => (
                    <FileChip key={f.id} f={f} />
                  ))}
                </div>
              </Sec>
            )}
          </Keyed>
          <Keyed k="people">
            <PeopleLane id={t.id} mine={detail.mine !== false} />
          </Keyed>
          {/* Its actions (Pin, Hide, Archive), then its conversation, collapsed to its last three, and the box to
              reply, in the page, on a phone as on a computer, its actions before the messages. No life strip or
              steps-and-files line over them, as its card on the feed has: its Steps, Time and Changes say the same. */}
          <Keyed k="acts">
            <Actions thread={t} watch={false} />
          </Keyed>
          <Keyed k="convo">
            <Convo s={s} detail={detail} steps={allSteps} turn={steps?.turn} qs={qs} />
          </Keyed>
          <Keyed k="live">
            {showsLive(t) ? (
              <div className="comments">
                <LiveLine s={t} />
              </div>
            ) : waiting ? (
              <div className="comments">
                {/* Waiting in a prompt of its own, with nothing to answer here: said at the end, where the live line goes. */}
                <InConvo thread={t}>
                  <WaitingElsewhere thread={t} />
                </InConvo>
              </div>
            ) : null}
            {guestsGoing && (
              <div className="comments">
                <GuestLive s={t} />
              </div>
            )}
          </Keyed>
          <Keyed k="queue">
            {(queue.length > 0 || s.waiting?.length > 0) && (
              <div className="comments">
                <WaitTray s={t} list={s.waiting} />
                <QueueTray s={t} queue={queue} />
              </div>
            )}
          </Keyed>
          <Keyed k="reply">
            <div className="comments">
              <ReplyBox s={t} wide />
              <SwitchChips s={t} />
            </div>
          </Keyed>
        </article>
      </main>
      <aside className="rail sess-side">
        <ThreadSide s={t} />
      </aside>
    </div>
  );
}
