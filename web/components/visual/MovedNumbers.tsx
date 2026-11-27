// Numbers that moved (ab_compare's numbers): the old one struck through, the new one large, the change colored by
// whether it's better.
import { movedOf } from "../../lib/visual.ts";
import type { Moved } from "../../lib/visual.ts";

export function MovedNumbers({ nums }: { nums: Moved[] | null | undefined }) {
  if (!nums?.length) return null;
  return (
    <div className="vz-moved">
      {nums.map((n, i) => {
        const v = movedOf(n);
        return (
          <div className="vz-mv" key={i}>
            <small>{n.label}</small>
            <div className="row">
              <s>{v.from}</s>
              <span className="arr">→</span>
              <span className="to">{v.to}</span>
              <span className={v.cls}>{v.change}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
