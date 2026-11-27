// The Feed's right column's Coming up (the old page's comingUp): questions that go with their default answer at a
// time, unless you answer first, the soonest first.
import { clock } from "../../lib/format.ts";
import { threadHref } from "../../lib/route.ts";
import { useApp, useThreadRow } from "../../lib/store.ts";
import type { Question } from "../../lib/types.ts";
import { Avatar } from "../../components/Avatar.tsx";

// One of them: its thread's agent and name, what it goes with, and when.
function ComingRow({ q }: { q: Question }) {
  const s = useThreadRow(q.post);
  return (
    <div className="need">
      <Avatar agent={s?.agent || "claude"} size="av--sm" />
      <p>
        <a href={threadHref(q.post)}>
          <b>{s?.label || ""}</b>
        </a>{" "}
        goes with “{q.default}” unless you answer
      </p>
      <p className="muted">{clock(q.until)}</p>
    </div>
  );
}

// The card, when something is coming up.
export function ComingUp() {
  const questions = useApp((s) => s.data?.questions);
  const qs = (questions || []).filter((q) => !q.answered && q.until && q.default).sort((a, b) => a.until.localeCompare(b.until));
  if (!qs.length) return null;
  return (
    <section className="card rail-card">
      <h3 className="rail-h">Coming up</h3>
      {qs.map((q) => (
        <ComingRow q={q} key={q.id} />
      ))}
    </section>
  );
}
