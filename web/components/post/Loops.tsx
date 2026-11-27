// A thread's loops (a cron, a /loop someone started, a Codex automation's heartbeat into its thread) and the checks
// it set itself: the chip in its head (loopChip), what they do next in its results (nextLines), and the soonest over
// its reply box (nextBar), with Run now and Stop.
import { create } from "zustand";
import { fromNow, repeats, routineWhen, scheduleWords } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { NARROW } from "../../lib/chrome.ts";
import { dayTime, plural } from "../../lib/format.ts";
import { go, threadHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import type { Thread } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";

// A loop as the page has it (the server's relay view of it): what it's called, whose, when next, how it's scheduled,
// how many times it ran, and what you may do to it.
interface Loop {
  id: string;
  name: string;
  agent: string;
  next?: string | null;
  schedule?: { kind?: string; reason?: string } | null;
  repeats?: boolean;
  runs?: number;
  acts?: string[];
  what?: string;
  live?: boolean;
}
const loopsOf = (s: Thread) => (s.loops || []) as unknown as Loop[];
// The loop a Run now or Stop is on its way for (S.loopBusy), so its buttons wait: on its card and its thread's side.
export const useLoopBusy = create<{ busy: string | null }>(() => ({ busy: null }));
export const routinesUrl = (id: string, job = "") => `/api/agents/${encodeURIComponent(id)}/routines${job ? `/${encodeURIComponent(job)}` : ""}`;
// Run now, or Stop the loop.
export async function loopAct(l: Pick<Loop, "id" | "agent">, what: string) {
  if (useLoopBusy.getState().busy) return;
  useLoopBusy.setState({ busy: l.id });
  const r = await post(routinesUrl(l.agent, l.id), { action: what });
  useLoopBusy.setState({ busy: null });
  if (r.ok) toast(what === "run" ? "Sent it its prompt: it runs once now." : "Asked it to stop the loop.");
}
const live = (s: Thread) => loopsOf(s).filter((l) => l.live).sort((a, b) => (a.next || "~").localeCompare(b.next || "~"));

// A loop's Run now and Stop, its owner's.
function LoopActs({ s, l }: { s: Thread; l: Loop }) {
  const busy = useLoopBusy((b) => b.busy === l.id);
  if (s.mine === false) return null;
  return (
    <>
      {(l.acts || []).map((a) => (
        <button key={a} type="button" disabled={busy} onClick={() => loopAct(l, a)}>
          {a === "run" ? "Run now" : "Stop"}
        </button>
      ))}
    </>
  );
}

// To the line that says what its loop does next, on its card or in its thread's results; else to its thread.
function peekLoop(btn: HTMLElement, id: string) {
  const sel = `[data-loop-next="${CSS.escape(id)}"]`;
  const line = btn.closest(".card")?.querySelector(sel) || document.querySelector(sel);
  if (line) line.scrollIntoView({ block: "center", behavior: matchMedia(NARROW).matches ? "auto" : "smooth" });
  else go(threadHref(id));
}

// A post that runs a loop says so, and when it runs next; one that set itself a check says when it checks back.
// It takes you to the line that says what it will do.
export function LoopChip({ thread: s }: { thread: Thread }) {
  const on = loopsOf(s).filter((l) => l.live);
  if (!on.length) return null;
  const next = on.map((l) => l.next).filter(Boolean).sort()[0];
  const looping = on.some(repeats);
  const what = on.length > 1 ? `${on.length} ${looping ? "loops" : "checks"}${next ? `, next ${fromNow(next)}` : ""}` : looping ? `Looping${next ? `, next ${fromNow(next)}` : ""}` : `Checks back${next ? ` ${fromNow(next)}` : ""}`;
  return (
    <button className="chip chip--loop" type="button" title={on.map((l) => `${l.name}: ${routineWhen(l)}`).join("\n")} onClick={(e) => peekLoop(e.currentTarget, s.id)}>
      <Icon name={looping ? "repeat" : "clock"} />
      {what}
    </button>
  );
}

// What a post's loops do next, after its results: what, when, and why (or how often). Run now and Stop are the
// loop's own, as on its card in the thread's side column.
export function NextLines({ thread: s }: { thread: Thread }) {
  return (
    <>
      {live(s).map((l) => {
        const why = l.schedule?.kind === "paced" ? l.schedule.reason || (repeats(l) ? scheduleWords(l.schedule) : "") : repeats(l) ? [scheduleWords(l.schedule), l.runs ? `ran ${plural(l.runs, "time")}` : ""].filter(Boolean).join(", ") : "";
        const acts = s.mine !== false && !!l.acts?.length;
        return (
          <li className="next-line" data-loop-next={s.id} key={l.id}>
            <Icon name={repeats(l) ? "repeat" : "clock"} />
            <span>
              <span className="next-k">Next:</span> <span title={l.what || l.name}>{l.name}</span>
              {(why || acts) && (
                <small>
                  {why && <span className="next-why">{why}</span>}
                  <LoopActs s={s} l={l} />
                </small>
              )}
            </span>
            {l.next && <time title={dayTime(l.next)}>{fromNow(l.next)}</time>}
          </li>
        );
      })}
    </>
  );
}

// The soonest of them again, right over its reply box, where you look to write to it: what, when, and its Run now
// and Stop. More than one says how many more, and goes to them in its results.
export function NextBar({ thread: s }: { thread: Thread }) {
  const all = live(s);
  if (!all.length) return null;
  const l = all[0];
  const more = all.length > 1;
  const acts = s.mine !== false && !!l.acts?.length;
  return (
    <div className="next-bar">
      <Icon name={repeats(l) ? "repeat" : "clock"} />
      <span className="next-what">
        <b>Next:</b> <span title={l.what || l.name}>{l.name}</span>
      </span>
      {l.next && <time title={dayTime(l.next)}>{fromNow(l.next)}</time>}
      {(more || acts) && (
        <span className="next-acts">
          {more && (
            <button type="button" onClick={(e) => peekLoop(e.currentTarget, s.id)}>
              +{all.length - 1} more
            </button>
          )}
          <LoopActs s={s} l={l} />
        </span>
      )}
    </div>
  );
}
