// A pull request's checks, a dot each: failing red, running grey, passed green, a skipped one hollow. Past 24, in
// proportion.
import { checkDotsOf } from "../../lib/visual.ts";
import type { PrChecks } from "../../../plugin/shared/types.ts";

export function CheckDots({ c }: { c: Partial<PrChecks> | null | undefined }) {
  const dots = checkDotsOf(c || null);
  if (!dots.length) return null;
  return (
    <span className="vz-checks" aria-hidden="true">
      {dots.map((cls, i) => (
        <i className={cls || undefined} key={i} />
      ))}
    </span>
  );
}
