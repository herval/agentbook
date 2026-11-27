// The sections of a thread's page between its text and its conversation that come from its steps: Steps (newest
// last, its latest 12 unless you ask for all), Where the time went, and Images (the pictures its agent saw); and the
// line that says its machine is off.
import { clock, plural } from "../../lib/format.ts";
import { timelineOf } from "../../lib/visual.ts";
import { openShot, shotsOf } from "../../lib/viewer.ts";
import type { Step, ThreadDetail } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { Since } from "../Time.tsx";
import { Timeline } from "../visual/Timeline.tsx";
import { ChgSize, StepDiff } from "./Changes.tsx";
import { toggleOpen, useOpenKey } from "./diff-view.tsx";
import { useLiveUi } from "./Live.tsx";
import { setThreadUi, useThreadUi } from "./page-ui.ts";
import { Sec } from "./Sec.tsx";

const STEPS_SHOWN = 12;
const SHOTS = 8; // shown until you ask for all

// One of its steps: what it said, or a tool, the one still running with how long so far. A step that saw pictures
// opens them in the viewer; one that changed files says how much, and opens to what it changed.
function StepItem({ st, s, all, running, canWrite }: { st: Step; s: ThreadDetail; all: Step[]; running: boolean; canWrite: boolean }) {
  const open = useOpenKey(`s:${st.id}`);
  if (st.kind === "say") return <li className="say">{(st.text || "").split("\n")[0]}</li>;
  const cls = st.error ? "err" : running ? "run" : "";
  const when = running ? <Since since={st.at} /> : <time>{clock(st.at)}</time>;
  const pics =
    st.images > 0 ? (
      <button className="step-pics" type="button" data-shot={`${st.id}/0`} title={st.images > 1 ? `See its ${st.images} images` : "See its image"} onClick={() => openShot(s.id, `${st.id}/0`, all)}>
        <Icon name="image" />
        {st.images > 1 ? st.images : ""}
      </button>
    ) : null;
  const files = st.files || [];
  if (!files.length)
    return (
      <li className={cls}>
        <span>
          {st.title}
          {pics}
          {st.error && <small>{st.error}</small>}
        </span>
        {when}
      </li>
    );
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return (
    <li className={`${cls} has-chg ${open ? "is-open" : ""}`}>
      <button className="step-chg" type="button" data-step-diff={st.id} aria-expanded={open} onClick={() => toggleOpen(`s:${st.id}`)}>
        <span>
          {st.title}
          {st.error && <small>{st.error}</small>}
        </span>
        <ChgSize add={add} del={del} />
        {files.length > 1 && <small className="chg-n">{plural(files.length, "file")}</small>}
      </button>
      {pics}
      {when}
      {open && (
        <div className="step-diff">
          <StepDiff st={st} s={s} canWrite={canWrite} />
        </div>
      )}
    </li>
  );
}

// Steps, newest last; the latest few unless you ask for all. With Thinking off, without what it said between them
// (`all` comes without them then).
export function StepsSection({ s, all, canWrite }: { s: ThreadDetail; all: Step[]; canWrite: boolean }) {
  const every = useThreadUi((u) => u.stepsAll);
  if (!all.length) return null;
  const shown = every ? all : all.slice(-STEPS_SHOWN);
  const working = s.effective === "working";
  return (
    <Sec k="steps" label="Steps" count={<span className="muted">{all.filter((x) => x.kind === "tool").length}</span>}>
      <ol className="steps">
        {all.length > shown.length && (
          <li className="more">
            <button type="button" data-steps-all onClick={() => setThreadUi({ stepsAll: true })}>
              Show {all.length - shown.length} earlier
            </button>
          </li>
        )}
        {shown.map((st, i) => (
          <StepItem key={st.id || i} st={st} s={s} all={all} running={working && !st.done && i === shown.length - 1} canWrite={canWrite} />
        ))}
      </ol>
    </Sec>
  );
}

// Where its time went: its steps as a timeline, a lane for it and each worker, a
// block for each stretch of reading, editing, tests, the browser, commands, thinking and waiting on you. A click on a
// block shows its steps under it. On a thread that took a few steps.
export function TimeSection({ s, steps }: { s: ThreadDetail; steps: Step[] }) {
  const wsteps = useLiveUi((u) => u.wsteps);
  if (steps.filter((st) => st.kind === "tool").length < 3) return null;
  const you = (s.messages || []).filter((m) => m.from === "human" && m.at).map((m) => m.at);
  const waits = (s.questions || []).filter((q) => q.post === s.id && q.at).map((q): [string, string | null] => [q.at, typeof q.answered === "string" ? q.answered : null]);
  const workers = (s.workers || []).map((w) => ({ ...w, steps: wsteps[`${s.id}|${w.id}`]?.steps || null }));
  const now = s.effective === "done" ? Date.parse(s.ended || s.updated) || Date.now() : Date.now();
  const clockOf = (t: string | number) => new Date(t).toTimeString().slice(0, 5);
  if (!timelineOf({ steps, workers, you, waits, now, clock: clockOf })) return null;
  return (
    <Sec k="time" label="Where the time went">
      <Timeline steps={steps} workers={workers} you={you} waits={waits} now={now} clock={clockOf} />
    </Sec>
  );
}

// The pictures its agent saw, in order: the screenshots it took, the images it read or made, its latest 8 unless you
// ask for all. One opens in the viewer, whose arrows go through the rest.
export function ImagesSection({ s, all }: { s: ThreadDetail; all: Step[] }) {
  const every = useThreadUi((u) => u.shotsAll);
  const shots = shotsOf(s.id, all);
  if (!shots.length) return null;
  const shown = every ? shots : shots.slice(-SHOTS);
  return (
    <Sec k="images" label="Images" count={<span className="muted">{shots.length}</span>}>
      <div className="shots">
        {shown.map((f) => (
          <a
            key={f.id}
            className="shot"
            href={f.url}
            target="_blank"
            rel="noopener"
            data-shot={f.id}
            title={f.title}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              openShot(s.id, f.id, all);
            }}
          >
            <img src={f.url} alt="" loading="lazy" decoding="async" />
            <span>
              <b>{f.title}</b>
              <time>{f.meta}</time>
            </span>
          </a>
        ))}
      </div>
      {shots.length > shown.length && (
        <button className="chg-more" type="button" data-shots-all onClick={() => setThreadUi({ shotsAll: true })}>
          Show {shots.length - shown.length} earlier
        </button>
      )}
    </Sec>
  );
}

// A post whose machine is off: it reads whole all the same, and what you send it waits, and says so.
export function MachineOff({ s }: { s: Pick<ThreadDetail, "offline" | "machine" | "mine"> }) {
  if (!s.offline) return null;
  return (
    <div className="ask ask--off">
      <p className="ask-flag">
        <Icon name="pause" />
        <b>{s.machine || "Its machine"} is off.</b> This thread shows what it did{s.mine !== false ? "; what you send it waits until it's back." : "."}
      </p>
    </div>
  );
}
