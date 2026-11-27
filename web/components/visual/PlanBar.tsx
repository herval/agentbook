// A plan as a bar: "3 of 5 · Opening the pull request", its steps a bar each, done filled, the one it's on moving
// (lib/visual.ts's planParts says which). Its title lists every step.
import { planParts } from "../../lib/visual.ts";
import type { PlanItem } from "../../../plugin/shared/types.ts";

export function PlanBar({ plan }: { plan: (Pick<PlanItem, "text" | "status"> & { now?: string })[] | null | undefined }) {
  const p = planParts(plan || []);
  if (!p) return null;
  return (
    <div className="vz-plan" title={p.title}>
      <span className="vz-plan-s" aria-hidden="true">
        {p.segs.map((c, i) => (
          <i className={c || undefined} key={i} />
        ))}
      </span>
      <span className="vz-plan-n">
        {p.done} of {p.total}
      </span>
      <span className="vz-plan-t">{p.now ? <b>{p.now}</b> : p.next ? `Next: ${p.next}` : "All done"}</span>
    </div>
  );
}
