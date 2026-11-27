// A thread's conversation on its page: its messages, what its agent said while it worked, its questions (and its
// guests'), each under the message it goes with (askSpot), one still open answered right there, and the workers its
// agent started, where it started them. Over it, Thinking and Raw output; collapsed to its last three messages
// unless you ask for all of them.
import { usePref } from "../../lib/hooks.ts";
import { clock } from "../../lib/format.ts";
import { postPics } from "../../lib/markdown.ts";
import { useChrome } from "../../lib/chrome.ts";
import { loadOlder } from "../../lib/thread.ts";
import type { Message, Question, Step, Thread, ThreadDetail, Worker } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Markdown } from "../Markdown.tsx";
import { AskBlock, InConvo, askSpot, askerOf } from "../post/Ask.tsx";
import { Bubble, peekOf } from "./Bubble.tsx";
import { Answered } from "./guest-convo.tsx";
import { WorkersBox, goingWorkers, workerGoing } from "./Live.tsx";
import { setThreadUi, useThreadUi } from "./page-ui.ts";
import { hasShape } from "./ReplyShape.tsx";

// What its agent said while it worked: its words between your message and its reply, as its steps have them. Not
// what it said last in a turn that's over (that's its reply), nor words its reply says again.
export function saidWhileWorking(s: Pick<Thread, "busy" | "state"> & { messages: Message[] }, { steps = [], turn = 0 }: { steps?: Step[]; turn?: number } = {}): Step[] {
  const going = s.busy || s.state === "working";
  const last = new Map(steps.map((st) => [st.turn, st]));
  const flat = (t: string | null | undefined) => String(t || "").replace(/\s+/g, " ").trim();
  const replies = s.messages.filter((m) => m.from !== "human" && m.text).map((m) => ({ at: m.at, text: flat(m.text) }));
  return steps.filter((st) => {
    if (st.kind !== "say" || (last.get(st.turn) === st && (st.turn < turn || !going))) return false;
    const text = flat(st.text).replace(/…$/, "");
    return !replies.some((r) => r.at >= st.at && r.text.includes(text));
  });
}
// One of those, as its agent's: its words, without its name. Right under something else of the agent's, it goes
// on from it, without the avatar.
export function SayBubble({ st, s, more }: { st: Step; s: Thread | ThreadDetail; more?: boolean }) {
  const t = s as Thread;
  return (
    <div className={`cmt cmt-agent cmt-say${more ? " is-more" : ""}`}>
      <Avatar agent={s.agent} size="av--sm" />
      <div className="cmt-wide">
        <div className="cmt-bub">
          <div className="md">
            <Markdown text={st.text || ""} peek={peekOf(t)} pics={postPics(t)} from={s.id} />
          </div>
        </div>
        <div className="cmt-meta">
          <span>{clock(st.at)}</span>
        </div>
      </div>
    </div>
  );
}

// What its page's Thinking and Raw output switches say, kept in this browser for every thread (agentbook.thinking,
// agentbook.raw, "1" or "0" as the old page kept them): Thinking on unless turned off, Raw output off unless on.
export function useThinking(): [boolean, (on: boolean) => void] {
  const [v, set] = usePref<string>("thinking", "1");
  return [v !== "0", (on) => set(on ? "1" : "0")];
}
export function useRaw(): [boolean, (on: boolean) => void] {
  const [v, set] = usePref<string>("raw", "0");
  return [v === "1", (on) => set(on ? "1" : "0")];
}

interface Item {
  at: string;
  agent: boolean;
  said?: boolean;
  open?: boolean;
  m?: Message;
  i?: number;
  say?: Step;
  q?: Question;
  workers?: Worker[];
}

// The conversation: `s` with its messages (those queued left out), `steps` its steps (all of them, Thinking or not)
// and `turn` the turn they're of, `qs` its questions and its guests'.
export function Convo({ s, detail, steps, turn = 0, qs }: { s: ThreadDetail; detail: ThreadDetail; steps: Step[]; turn?: number; qs: Question[] }) {
  const [thinking, setThinking] = useThinking();
  const [raw, setRaw] = useRaw();
  const all = useThreadUi((u) => u.convoAll);
  const q = useChrome((c) => c.q);
  const t = s as unknown as Thread;
  // Thinking, over it, shows or hides what its agent said while it worked, here and in its steps, on every thread;
  // off, it
  // says how many it hides. Only on a thread whose agent said anything while it worked.
  // Raw output, beside it, shows its agent's replies as it wrote them, instead of what agentbook draws for them (their
  // verdict, checks, cards, drafts, charts, suggested replies); kept in this browser too. Only on a thread with a reply
  // that has any.
  const workNotes = saidWhileWorking(s, { steps, turn });
  const thinkSw = steps.some((st) => st.kind === "say") ? (
    <label className="switch switch--sm" title="What its agent said while it worked, between your message and its reply, here and in its steps. Kept in this browser, for every thread.">
      <input type="checkbox" role="switch" data-thinking checked={thinking} onChange={(e) => setThinking(e.currentTarget.checked)} />
      <span className="track" aria-hidden="true" />
      <span>
        Thinking{!thinking && workNotes.length ? <small>{workNotes.length} hidden</small> : null}
      </span>
    </label>
  ) : null;
  const rawSw = s.messages.some(hasShape) ? (
    <label className="switch switch--sm" title="Its agent's replies as it wrote them, instead of their verdict, checks, cards and suggested replies. Kept in this browser, for every thread.">
      <input type="checkbox" role="switch" data-raw checked={raw} onChange={(e) => setRaw(e.currentTarget.checked)} />
      <span className="track" aria-hidden="true" />
      <span>Raw output</span>
    </label>
  ) : null;
  // Its workers still going after its turn have their rows by the reply box (GoingCard), not where it started them.
  const atEnd = new Set(goingWorkers(t));
  const convo = [
    ...s.messages.map((m, i): Item => ({ at: m.at, agent: m.from !== "human", said: true, m, i })),
    ...(thinking ? workNotes : []).map((st): Item => ({ at: st.at, agent: true, say: st })),
    ...qs.map((x): Item => ({ at: askSpot(x, s.messages), agent: true, open: !x.answered, q: x })),
    ...(s.mine ? s.workers || [] : []).map((w): Item => ({ at: w.started || s.started, agent: true, workers: [w] })),
  ]
    .sort((a, b) => a.at.localeCompare(b.at))
    .reduce<Item[]>((list, c) => (c.workers && list.at(-1)?.workers ? list.at(-1).workers.push(...c.workers) : list.push(c), list), []);
  // Collapsed as on the feed: its last three messages under "View all N messages", with what's still waiting wherever
  // it is: a question still open, a worker still going. Whole while you search, so what you searched for shows.
  const cut = all || q || s.messages.length <= 3 ? 0 : convo.indexOf(convo.filter((c) => c.said).at(-3));
  const shown = cut ? convo.filter((c, i) => i >= cut || c.open || c.workers?.some((w) => workerGoing(w) && !atEnd.has(w))) : convo;
  const more = cut ? (
    <button className="more-c" type="button" data-convo-all onClick={() => setThreadUi({ convoAll: true })}>
      View all {s.messages.length + (detail.earlier || 0)} messages
    </button>
  ) : detail.older ? (
    <button className="more-c" type="button" data-older onClick={() => loadOlder()}>
      Show earlier messages
    </button>
  ) : null;
  const last = s.messages.length - 1;
  return (
    <>
      {(thinkSw || rawSw) && (
        <div className="convo-opts">
          {thinkSw}
          {rawSw}
        </div>
      )}
      <div className="comments" id="convo">
        {more}
        {shown.length ? (
          shown.map((c, i) => {
            const after = shown[i - 1]?.agent;
            if (c.workers) return <WorkersBox key={`w:${c.workers[0].id}`} list={c.workers} s={t} more={after} atEnd={atEnd} />;
            if (c.say) return <SayBubble key={`say:${c.say.id}`} st={c.say} s={s} more={after} />;
            if (c.q) return c.q.answered ? <Answered key={`q:${c.q.id}`} q={c.q} s={askerOf(c.q, t)} /> : (
                <InConvo key={`q:${c.q.id}`} thread={askerOf(c.q, t)}>
                  <AskBlock q={c.q} />
                </InConvo>
              );
            return <Bubble key={c.m.id} m={c.m} s={s} last={c.i === last} quick={c.i === last} raw={raw} frames />;
          })
        ) : (
          <p className="muted">{s.rt?.syncing ? `Copying its conversation from ${s.rt.name}…` : "No messages yet."}</p>
        )}
      </div>
    </>
  );
}
