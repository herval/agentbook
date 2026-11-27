// A thread's life, start to now (or its end): when it worked (its color), waited on you (yellow), and a mark for each
// result, pull request, picture and message of yours, marks that would sit on each other as one. A click on a mark
// shows its words under the strip; the latest's show until you pick one. Under it, how long it worked and waited.
import { useState } from "react";
import { MARK, lifeLayout, pct, span } from "../../lib/visual.ts";
import type { Life, When } from "../../lib/visual.ts";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";

export function LifeStrip({ life, start, end, live = false, worked = null, clock = (t) => new Date(t).toLocaleTimeString() }: { life: Life | null | undefined; start?: When; end?: When; live?: boolean; worked?: number | null; clock?: (t: When) => string }) {
  const [pick, setPick] = useState<number | null>(null);
  const L = life ? lifeLayout(life, { start, end, live, pick, worked }) : null;
  if (!L) return null;
  const g = L.groups[L.shown];
  return (
    <div className="vz-life">
      <div className="vz-life-row">
        <time>{clock(start)}</time>
        <div className="vz-track">
          <i className="base" />
          {L.work.map((s, i) => (
            <i className={`seg${s.live ? " live" : ""}`} key={`k${i}`} style={{ left: pct(s.l), width: pct(s.w) }} />
          ))}
          {L.wait.map((s, i) => (
            <i className="seg w" key={`w${i}`} style={{ left: pct(s.l), width: pct(s.w) }} />
          ))}
          {L.groups.map((m, i) => (
            <button className={`mk ${MARK[m.k].cls}${i === L.shown ? " is-on" : ""}`} type="button" key={i} style={{ left: pct(m.at) }} title={m.words} aria-label={m.words} onClick={() => setPick(pick === i ? null : i)}>
              <Icon name={MARK[m.k].ico as IconName} />
              {m.marks.length > 1 && <small>{m.marks.length}</small>}
            </button>
          ))}
        </div>
        <time>{live ? "now" : clock(end)}</time>
      </div>
      {g && (
        <p className="vz-life-say">
          <time>{clock(g.marks.at(-1).at)}</time>
          {g.marks.map((m, i) => (
            <span className={`k-${m.k}`} key={i}>
              {m.t}
            </span>
          ))}
        </p>
      )}
      {(L.worked > 0 || L.waited > 30e3) && (
        <div className="vz-life-k">
          {L.worked > 0 && (
            <span>
              <i />
              Worked <b>{span(L.worked)}</b>
            </span>
          )}
          {L.waited > 30e3 && (
            <span>
              <i className="w" />
              Waited on you <b>{span(L.waited)}</b>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
