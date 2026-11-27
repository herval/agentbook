// What a thread is doing right now, at the end of its conversation by the reply box (its live line, Stop, its latest
// steps over it once opened), what it left running after its turn (goingCard), and the workers its agent handed work
// to (its subagents), each a row that opens to its own steps, read from its machine.
import { useEffect } from "react";
import { create } from "zustand";
import { drivenBy, waits } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { clock, dur, hueVars, plural } from "../../lib/format.ts";
import { getApp, useApp } from "../../lib/store.ts";
import { reloadThread } from "../../lib/thread.ts";
import { toast } from "../../lib/toast.ts";
import type { LiveLine as Live, Printed, Step, StepsRead, Thread, Worker } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { Since } from "../Time.tsx";
import { setThreadUi } from "./page-ui.ts";
import { unfoldSec } from "./Sec.tsx";
import type { Going, ThreadX } from "./types.ts";

// What's open here (a worker's steps `w:`, all of them `wa:`, the live line's `l:`, a command's output `g:`), what was
// read for them, and the threads whose Stop didn't stop them: until they've stopped, their button is Force stop,
// which ends the process.
interface LiveUi {
  open: Set<string>;
  gout: Record<string, Printed>;
  wsteps: Record<string, StepsRead>;
  lsteps: Record<string, StepsRead>;
  unstopped: Set<string>;
}
export const useLiveUi = create<LiveUi>(() => ({ open: new Set(), gout: {}, wsteps: {}, lsteps: {}, unstopped: new Set() }));
const L = useLiveUi.getState;
export const toggleOpen = (k: string) =>
  useLiveUi.setState((s) => {
    const open = new Set(s.open);
    if (open.has(k)) open.delete(k);
    else open.add(k);
    return { open };
  });
const useIsOpen = (k: string) => useLiveUi((s) => s.open.has(k));
const putIn = <K extends "gout" | "wsteps" | "lsteps">(k: K, key: string, v: LiveUi[K][string]) => useLiveUi.setState((s) => ({ [k]: { ...s[k], [key]: v } }) as Partial<LiveUi>);

// What a thread is doing now, as the page has it: a card's on the list on screen, the open thread's.
export const nowOf = (id: string, s = getApp()): Live | null => (s.feed?.records[`thread:${id}`] ? s.feed.live[id] || null : s.open?.detail?.id === id ? s.open.detail.live || null : null);
const useNowOf = (id: string) => useApp((s) => nowOf(id, s));

// Who can stop it from here, and how: a background session stops through Claude Code, a driver's through its driver.
// While the live line shows, Stop sits on it, next to the step it stops.
export const stoppable = (s: Thread) => s.mine !== false && !s.asleep && (s.rt?.kind === "background" ? s.busy || ["working", "waiting"].includes(s.state) : !!drivenBy(s) && s.busy);
export const showsLive = (s: Thread) => s.effective === "working" && !s.offline;
export function StopButton({ s, className = "btn btn--line btn--sm" }: { s: Thread; className?: string }) {
  const force = useLiveUi((u) => u.unstopped.has(s.id));
  return (
    <button
      className={className || undefined}
      type="button"
      data-stop={s.id}
      onClick={async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        const r = await post<{ force?: boolean }>(`/api/sessions/${encodeURIComponent(s.id)}/stop`, force ? { force: true } : {});
        const un = new Set(L().unstopped);
        if (r.ok) {
          un.delete(s.id);
          useLiveUi.setState({ unstopped: un });
          toast(r.data.queued ? waits(r.data, "it stops") : force ? "Stopped. Write to it to pick it up." : "Stopped.");
        } else {
          b.disabled = false;
          if (r.data?.force) useLiveUi.setState({ unstopped: un.add(s.id) });
          // Nothing changed, so nothing tells the page: it reads the thread again, without the Stop it saw on its way.
          if (getApp().open?.id === s.id) reloadThread();
        }
      }}
    >
      <Icon name="stop" />
      {force ? "Force stop" : "Stop"}
    </button>
  );
}

// Its turn is over, but something it started runs on (a subagent, a shell watching a CI run, a monitor): it hears back
// when that finishes.
export const goingNow = (s: Thread) => (!s.busy && (s as ThreadX).going?.length ? (s as ThreadX).going : null);
const WORKER_ENDS = { done: "Done", failed: "Failed", "timed out": "Timed out", stopped: "Stopped" };
export const workerGoing = (w: Worker) => w.state === "running" || w.state === "queued";
// The worker one of those is (workers.ts), where its machine says which (`worker`; an older agentbook-cli doesn't,
// and its subagents go by their own id or by what they're called).
const workerOfGoing = (s: Thread, g: Going) => (s.workers || []).find((w) => w.id === (g.worker || g.id)) || (g.worker || g.kind !== "subagent" ? null : (s.workers || []).find((w) => w.title === g.title && workerGoing(w))) || null;
// The workers that card shows, which the conversation leaves to it while it does (the thread's page).
export const goingWorkers = (s: Thread) => (showsLive(s) && goingNow(s) ? goingNow(s).map((g) => workerOfGoing(s, g)).filter(Boolean) : []);

// What one of them printed, its end, as its machine read it when you opened it; Refresh reads it again.
function readGoing(post: string, id: string) {
  const key = `${post}|${id}`;
  if (L().gout[key]?.loading) return;
  putIn("gout", key, { ...L().gout[key], loading: true });
  fetch(`/api/sessions/${encodeURIComponent(post)}/going/${encodeURIComponent(id)}/output`)
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      putIn("gout", key, res.ok ? { text: body.text || "", cut: !!body.cut, at: body.at, stopping: L().gout[key]?.stopping } : { ...L().gout[key], loading: false, error: body.error || "Couldn't read what it printed." });
    })
    .catch(() => putIn("gout", key, { ...L().gout[key], loading: false, error: "Couldn't read what it printed." }));
}
function GoingOut({ s, g }: { s: Thread; g: Going }) {
  const got = useLiveUi((u) => u.gout[`${s.id}|${g.id}`]);
  if (!got || (got.loading && got.text == null && !got.error)) return <p className="wk-note muted">Reading what it printed…</p>;
  if (got.error && got.text == null) return <p className="wk-note muted">{got.error}</p>;
  return (
    <div className="wk-out">
      {got.text && (
        <div className="wk-out-box">
          <pre>{got.text}</pre>
        </div>
      )}
      <p className="wk-out-note muted">
        <span>
          {got.text ? `${got.cut ? "The end of what it printed" : "What it printed"}, last at ${clock(got.at)}` : "It hasn't printed anything."}
          {got.error ? ` · ${got.error}` : ""}
        </span>
        <button className="wk-again" type="button" data-going-read={g.id} disabled={got.loading} onClick={() => readGoing(s.id, g.id)}>
          {got.loading ? "Reading…" : "Refresh"}
        </button>
      </p>
    </div>
  );
}
// Each as a row of its own, as a side thread is shown, where one line named the first "and 2 more": what it's called,
// what it's on, how long so far. A worker's row is the one its conversation gives it (WorkerRow), which opens to its
// steps on its thread's own page, for its owner; a command or a monitor it left running has no steps to read.
const GOING_KINDS = { shell: "A command it left running", monitor: "A monitor, watching", subagent: "A worker" };
function GoingRow({ s, g, opens }: { s: Thread; g: Going; opens: boolean }) {
  const key = `${s.id}|${g.id}`;
  const open = useIsOpen(`g:${key}`);
  const stopping = useLiveUi((u) => u.gout[key]?.stopping);
  const w = workerOfGoing(s, g);
  if (w) return <WorkerRow w={w} s={s} opens={opens} />;
  const head = (
    <>
      <span className="rt-dot rt-dot--run" />
      <span className="wk-t">
        <b title={g.title}>{g.title}</b>
        <small>{GOING_KINDS[g.kind] || "Left running"}</small>
      </span>
      {g.started && (
        <span className="wk-m">
          <Since since={g.started} />
        </span>
      )}
    </>
  );
  // One whose output its machine can read (`out`) opens to the end of what it printed, and can be stopped: on its
  // thread's own page, for its owner.
  if (!opens || !g.out)
    return (
      <li className="wk-row is-going">
        <div className="wk-btn">{head}</div>
      </li>
    );
  return (
    <li className="wk-row is-going">
      <div className="wk-line">
        <button
          className="wk-btn"
          type="button"
          data-going={g.id}
          aria-expanded={open}
          title={open ? "Hide what it printed" : "See what it printed"}
          onClick={() => {
            toggleOpen(`g:${key}`);
            if (!open) readGoing(s.id, g.id);
          }}
        >
          {head}
          <Icon name="down" />
        </button>
        <button
          className="btn btn--line btn--sm wk-stop"
          type="button"
          data-going-stop={g.id}
          title="Stop this command. The thread stays as it is, and its agent hears you stopped it."
          disabled={stopping}
          aria-label={stopping ? "Stopping" : "Stop this command"}
          onClick={async () => {
            putIn("gout", key, { ...L().gout[key], stopping: true });
            const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/going/${encodeURIComponent(g.id)}/stop`, {});
            // Stopped, its row goes when its machine next says what it has going; it stays "Stopping…" till then.
            if (r.ok) toast("Stopped. Its agent hears you stopped it.");
            else putIn("gout", key, { ...L().gout[key], stopping: false });
          }}
        >
          <Icon name="stop" />
          <span>{stopping ? "Stopping…" : "Stop"}</span>
        </button>
      </div>
      {open && <GoingOut s={s} g={g} />}
    </li>
  );
}
function GoingCard({ s, going }: { s: Thread; going: Going[] }) {
  const opens = useApp((st) => s.mine !== false && st.route.name === "session" && st.route.id === s.id);
  return (
    <div className="cmt cmt-now cmt-going">
      <Avatar agent={s.agent} size="av--sm" />
      <div className="wk wk--now">
        <p className="wk-h">{going.length > 1 ? `${going.length} going in the background` : "Going in the background"}</p>
        <ul>
          {going.map((g) => (
            <GoingRow key={g.id} s={s} g={g} opens={opens} />
          ))}
        </ul>
      </div>
    </div>
  );
}

// Steps in a short list, as the conversation shows them (a worker's, or the latest of its agent's over its live line):
// what it said, and each tool, the one still going with how long so far.
export function StepLi({ st, going }: { st: Step; going: boolean }) {
  if (st.kind === "say")
    return (
      <li className="say">
        <span>{st.text.split("\n")[0]}</span>
        <time>{clock(st.at)}</time>
      </li>
    );
  const run = going && !st.done && !st.error;
  return (
    <li className={st.error ? "err" : run ? "run" : ""}>
      <span>
        {st.title}
        {st.error && <small>{st.error}</small>}
      </span>
      {run ? <Since since={st.at} /> : <time>{clock(st.at)}</time>}
    </li>
  );
}

// A card's live line opened to its steps: read from its machine then, and again as it starts another or ends one.
function useCardSteps(s: Thread, on: boolean): StepsRead | null {
  const live = useNowOf(s.id);
  const v = `${live?.steps}|${live?.step?.at || ""}|${!!live?.step?.done}`;
  const got = useLiveUi((u) => u.lsteps[s.id]);
  useEffect(() => {
    if (!on || L().lsteps[s.id]?.v === v) return;
    putIn("lsteps", s.id, { ...L().lsteps[s.id], v });
    fetch(`/api/sessions/${encodeURIComponent(s.id)}/steps`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        const was = L().lsteps[s.id];
        putIn("lsteps", s.id, res.ok ? { ...body, v } : { ...was, error: was?.steps ? null : body.error || "Couldn't read its steps." });
      })
      .catch(() => {
        const was = L().lsteps[s.id];
        putIn("lsteps", s.id, { ...was, error: was?.steps ? null : "Couldn't read its steps." });
      });
  }, [on, v, s.id]);
  return got || null;
}
// Its latest steps, over its live line once you open it: what you'd see scrolling by in its terminal. On its page
// and in a threads bar, the ones those keep as they come; on a card, read when you open it.
const LIVE_SHOWN = 8;
function LiveSteps({ s }: { s: Thread }) {
  const open = useIsOpen(`l:${s.id}`);
  const page = useApp((st) => st.open?.id === s.id);
  const kept = useApp((st) => (st.open?.id === s.id ? st.open.steps : null));
  const read = useCardSteps(s, open && !page);
  if (!open) return null;
  const got: StepsRead | null = page ? (kept as StepsRead) : read;
  const all = got?.steps || [];
  if (!all.length)
    return (
      <div className="cmt cmt-agent cmt-trail">
        <Avatar agent={s.agent} size="av--sm" />
        <div className="cmt-wide">
          <p className="wk-note muted">{got?.error ? got.error : got?.steps ? "No steps yet." : "Reading its steps…"}</p>
        </div>
      </div>
    );
  const shown = all.slice(-LIVE_SHOWN);
  const n = plural(all.filter((x) => x.kind === "tool").length, "step");
  const more =
    all.length <= shown.length ? null : page ? (
      <button
        type="button"
        data-steps-top
        onClick={() => {
          unfoldSec("steps");
          setThreadUi({ stepsAll: true });
          requestAnimationFrame(() => document.querySelector('[data-sec="steps"]')?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}
      >
        All {n}, at the top
      </button>
    ) : (
      <a href={`#/threads/${encodeURIComponent(s.id)}`}>All {n}, on its page</a>
    );
  return (
    <div className="cmt cmt-agent cmt-trail">
      <Avatar agent={s.agent} size="av--sm" />
      <div className="cmt-wide">
        <ol className="steps">
          {more && <li className="more">{more}</li>}
          {shown.map((st, i) => (
            <StepLi key={st.id || i} st={st} going={i === shown.length - 1} />
          ))}
        </ol>
      </div>
    </div>
  );
}

export function LiveLine({ s }: { s: Thread }) {
  const live = useNowOf(s.id);
  const open = useIsOpen(`l:${s.id}`);
  if (!showsLive(s)) return null;
  const stop = stoppable(s) ? (
    <span className="live-acts">
      <StopButton s={s} />
    </span>
  ) : null;
  const going = goingNow(s);
  if (going) return <GoingCard s={s} going={going} />;
  let line;
  if (!live?.step) {
    line = (
      <div className="live">
        <i className="pulse" />
        <b>Working</b>
        {stop}
      </div>
    );
  } else {
    const st = live.step;
    const text = st.kind === "say" ? st.text.split("\n")[0] : st.title;
    // A click opens it to its latest steps, over it, as they come.
    line = (
      <div className="live">
        <button className="live-open" type="button" data-live-steps={s.id} aria-expanded={open} title={open ? "Hide its latest steps" : "See its latest steps"} onClick={() => toggleOpen(`l:${s.id}`)}>
          <i className="pulse" />
          <b>{text}</b>
          <span className="muted live-n">step {live.steps}</span>
          <Icon name="down" />
        </button>
        {!st.done && <Since since={st.at} />}
        {stop}
      </div>
    );
  }
  return (
    <>
      <LiveSteps s={s} />
      <div className="cmt cmt-now">
        <Avatar agent={s.agent} size="av--sm" />
        {line}
      </div>
    </>
  );
}

/* ---------- its workers ---------- */
// The workers its agent handed work to (its subagents, plugin/cli/workers.ts), which aren't threads of their own, in
// its conversation where it started them: those started together, one box. Each row says how it's going and what it's
// on, as its turn can be over while one renders for hours, and opens to its own steps, read from its machine
// (useWorkerSteps). Those going, and those that ended in the last day.

// The steps of a worker you opened, read from its machine: when you open it, and again as it starts another tool or
// ends (what its row says changes with each).
function useWorkerSteps(s: Thread, w: Worker, on: boolean) {
  const key = `${s.id}|${w.id}`;
  const v = `${w.n}|${w.state}|${w.step?.at || ""}`;
  useEffect(() => {
    if (!on || w.n == null || L().wsteps[key]?.v === v) return;
    putIn("wsteps", key, { ...L().wsteps[key], v });
    fetch(`/api/sessions/${encodeURIComponent(s.id)}/workers/${encodeURIComponent(w.id)}/steps`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        const was = L().wsteps[key];
        putIn("wsteps", key, res.ok ? { ...body, v } : { ...was, error: was?.steps ? null : body.error || "Couldn't read its steps." });
      })
      .catch(() => {
        const was = L().wsteps[key];
        putIn("wsteps", key, { ...was, error: was?.steps ? null : "Couldn't read its steps." });
      });
  }, [on, key, v]);
  return useLiveUi((u) => u.wsteps[key]);
}
const WORKER_SHOWN = 10;
function WorkerSteps({ s, w, got }: { s: Thread; w: Worker; got: StepsRead | undefined }) {
  const all_ = useIsOpen(`wa:${w.id}`);
  void s;
  if (!got?.steps) return <p className="wk-note muted">{got?.error ? got.error : "Reading its steps…"}</p>;
  const all = got.steps;
  if (!all.length) return <p className="wk-note muted">{got.gone ? "Its history is gone: OpenClaw doesn't keep it anymore." : "No steps yet."}</p>;
  const shown = all_ ? all : all.slice(-WORKER_SHOWN);
  const before = (got.n || 0) - all.filter((x) => x.kind === "tool").length; // its machine keeps its latest only
  const going = workerGoing(w);
  return (
    <ol className="steps wk-steps">
      {all.length > shown.length ? (
        <li className="more">
          <button type="button" data-worker-all={w.id} onClick={() => toggleOpen(`wa:${w.id}`)}>
            Show {all.length - shown.length} earlier
          </button>
        </li>
      ) : before > 0 && shown.length === all.length ? (
        <li className="more">{plural(before, "earlier step")} not kept</li>
      ) : null}
      {shown.map((st, i) => (
        <StepLi key={st.id || i} st={st} going={going && i === shown.length - 1} />
      ))}
    </ol>
  );
}
// One worker's row. `opens`: it opens to its steps here (not on a card of the feed, which doesn't read them).
export function WorkerRow({ w, s, opens = true }: { w: Worker; s: Thread; opens?: boolean }) {
  const open = useIsOpen(`w:${w.id}`) && opens;
  const got = useWorkerSteps(s, w, open);
  // In minutes: it's drawn when the thread changes, not every second.
  const long = (from: string, to: string) => dur(Date.parse(to) - Date.parse(from)).replace(/ \d\ds$/, "");
  const going = workerGoing(w);
  const took = !going && Date.parse(w.ended) - Date.parse(w.started) >= 1000 ? ` after ${long(w.started, w.ended)}` : ""; // not when its runtime only knows it was over
  const meta =
    w.state === "queued" ? (
      "Queued"
    ) : going ? (
      <>
        {w.n ? `step ${w.n} · ` : ""}
        <Since since={w.started} />
      </>
    ) : (
      `${WORKER_ENDS[w.state] || "Ended"}${took}`
    );
  const sub = going && w.step ? w.step.title : w.error || "";
  const dot = going ? "run" : w.state === "done" ? "ok" : "error";
  const head = (
    <>
      <span className={`rt-dot rt-dot--${dot}`} />
      <span className="wk-t">
        <b title={w.title}>{w.title}</b>
        {sub && <small title={sub}>{sub}</small>}
      </span>
      <span className="wk-m">{meta}</span>
    </>
  );
  // Its steps, where agentbook can read them (`n`: a Claude Code subagent's transcript, an OpenClaw one's history);
  // else what it last started is all.
  return (
    <li className={`wk-row${going ? " is-going" : ""}${w.error ? " is-err" : ""}`}>
      {opens && w.n != null ? (
        <button className="wk-btn" type="button" data-worker={w.id} aria-expanded={open} title={open ? "Hide its steps" : "See its steps"} onClick={() => toggleOpen(`w:${w.id}`)}>
          {head}
          <Icon name="down" />
        </button>
      ) : (
        <div className="wk-btn">{head}</div>
      )}
      {open && w.n != null && <WorkerSteps s={s} w={w} got={got} />}
    </li>
  );
}
// `atEnd`: those of them whose rows are by the reply box for now (GoingCard): counted here, not shown twice.
export function WorkersBox({ list, s, more, atEnd = new Set() }: { list: Worker[]; s: Thread; more?: boolean; atEnd?: Set<Worker> }) {
  const rows = list.filter((w) => !atEnd.has(w));
  if (!rows.length) return null;
  const n = list.filter(workerGoing).length;
  const head = `${list.length > 1 ? `Started ${list.length} workers` : "Started a worker"}${n && list.length > 1 ? ` · ${n} going` : ""}`;
  return (
    <div className={`cmt cmt-agent cmt-workers${more ? " is-more" : ""}`} style={hueVars(s.agent)}>
      <Avatar agent={s.agent} size="av--sm" />
      <div className="cmt-wide">
        <div className="wk">
          <p className="wk-h">{head}</p>
          <ul>
            {rows.map((w) => (
              <WorkerRow key={w.id} w={w} s={s} />
            ))}
          </ul>
        </div>
        <div className="cmt-meta">
          <span>{clock(list[0].started)}</span>
        </div>
      </div>
    </div>
  );
}
