// Where a thread's time went: its steps as a timeline, a lane for it and each worker,
// a block for each stretch of reading, editing, tests, the browser, commands, thinking and waiting on you, a mark
// where you wrote, long quiet stretches folded, and the share of each kind under it. A click on a block shows its
// steps under it; another click hides them. lib/visual.ts works out what goes where.
import { useState } from "react";
import { KINDS, cut, pct, pickedOf, span, timelineOf } from "../../lib/visual.ts";
import type { StepIn, When, WorkerIn } from "../../lib/visual.ts";

export function Timeline({ steps = [], workers = [], you = [], waits = [], now = Date.now(), clock = (t) => new Date(t).toLocaleTimeString() }: { steps?: StepIn[]; workers?: WorkerIn[]; you?: When[]; waits?: [When, When | null][]; now?: number; clock?: (t: When) => string }) {
  const [pick, setPick] = useState<string | null>(null);
  const tl = timelineOf({ steps, workers, you, waits, now, clock });
  if (!tl) return null;
  const picked = pickedOf(tl, pick);
  return (
    <div className="vz-time">
      <p className="vz-time-h">
        <small>
          {tl.busy} busy{tl.gaps ? `, ${tl.gaps === 1 ? "one quiet stretch" : `${tl.gaps} quiet stretches`} folded` : ""}
        </small>
      </p>
      <div className="vz-axis">
        {tl.axis.map((a, i) => (
          <span key={i} style={{ left: pct(a.l) }}>
            {a.text}
          </span>
        ))}
      </div>
      {tl.lanes.map((l, li) => (
        <div className="vz-lane" key={li}>
          <span className="vz-lane-n">{cut(l.name, 22)}</span>
          <span className="vz-lane-t">
            {l.blocks.map((b) => (
              <button className={`vz-blk k-${b.kind}${pick === b.k ? " is-on" : ""}`} type="button" key={b.k} style={{ left: pct(b.l), width: pct(b.w) }} title={b.tip} aria-label={b.tip} onClick={() => setPick(pick === b.k ? null : b.k)} />
            ))}
            {li === 0 && tl.you.map((y, i) => <i className="vz-you" key={`y${i}`} style={{ left: pct(y.l) }} title={y.title} />)}
            {tl.folds.map((f, i) => (
              <span className="vz-fold" key={`f${i}`} style={{ left: pct(f.l), width: pct(f.w) }} title={f.title}>
                {f.text}
              </span>
            ))}
          </span>
        </div>
      ))}
      <div className="vz-legend">
        {tl.legend.map((k) => (
          <span key={k.kind}>
            <i className={`k-${k.kind}`} />
            {k.name} <b>{k.pct}%</b>
          </span>
        ))}
      </div>
      {picked && (
        <div className="vz-blk-d">
          <b>{KINDS[picked.kind]}</b>, {clock(picked.a)}, {span(picked.b - picked.a)}
          {picked.steps.length > 0 && (
            <ul>
              {picked.steps.slice(0, 12).map((s, i) => (
                <li key={i}>{cut(s.title || s.text || "", 140)}</li>
              ))}
              {picked.steps.length > 12 && <li>and {picked.steps.length - 12} more</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
