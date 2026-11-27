// How far a "Changed 3 files" line's change reaches (ChangeLine), a click away. Private to the thread's Changes for
// now; the reply card draws the same, which this can give way to.
import { plural } from "../../lib/format.ts";
import type { ChangeReach } from "../../../plugin/shared/types.ts";

// How far a turn's change reaches (reach.ts, on its "Changed 3 files" line): the repo by folder, the files it
// changed lit, what imports them outlined, a red edge on a change no test imports.
export function ReachOf({ r }: { r: ChangeReach }) {
  const max = Math.max(1, ...r.folders.flatMap((f) => f.files.filter((x) => x.changed).map((x) => (x.add || 0) + (x.del || 0))));
  return (
    <div className="rs-block rs-reach">
      <p className="rs-reach-sum">
        {plural(r.changed, "file")} changed, {r.importers ? `imported by ${plural(r.importers, "other")}` : "imported by nothing else"}
        {r.untested ? (
          <>
            , <span className="bad">{plural(r.untested, "change")} no test imports</span>
          </>
        ) : null}
        .
      </p>
      <div className="rs-tree">
        {r.folders.map((f) => (
          <div className="rs-col" key={f.dir} style={{ flexGrow: Math.max(f.size, 1) }}>
            <span>{f.dir === "." ? "./" : f.dir === "…" ? "…" : `${f.dir}/`}</span>
            {f.files.map((x) => {
              const n = (x.add || 0) + (x.del || 0);
              const k = x.changed ? 0.35 + 0.65 * (n / max) : 0;
              const tip = x.changed ? `${f.dir}/${x.path}: +${x.add || 0} −${x.del || 0}${x.untested ? ", no test imports it" : ""}` : `${f.dir}/${x.path}: imports what changed`;
              return (
                <span key={x.path} className={`rs-tile${x.changed ? ` is-changed${k < 0.55 ? " is-light" : ""}${x.untested ? " is-untested" : ""}` : " is-imports"}`} style={{ flexGrow: Math.max(x.size, 1), ...(x.changed ? { "--k": k.toFixed(2) } : {}) } as React.CSSProperties} title={tip}>
                  <span>{x.path}</span>
                </span>
              );
            })}
            {f.rest ? <span className="rs-tile" style={{ flexGrow: f.rest }} title={`${f.dir}: the rest`} /> : null}
          </div>
        ))}
      </div>
      <p className="rs-tree-l">
        <span>
          <i className="c" />
          Changed, darker for more
        </span>
        <span>
          <i className="a" />
          Imports what changed
        </span>
        <span>
          <i className="u" />
          No test imports it
        </span>
      </p>
    </div>
  );
}
