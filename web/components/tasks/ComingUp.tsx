// Beside the Tasks page: the questions threads asked you that go with their default unless you answer, the
// soonest first.
import { clock } from "../../lib/format.ts";
import { threadHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { Avatar } from "../Avatar.tsx";
import { sessionById } from "../worktrees/wips.ts";

export function ComingUp() {
  const questions = useApp((s) => s.data?.questions);
  useApp((s) => s.rows);
  const qs = (questions || []).filter((q) => !q.answered && q.until && q.default).sort((a, b) => a.until.localeCompare(b.until));
  if (!qs.length) return null;
  return (
    <section className="card rail-card">
      <h3 className="rail-h">Coming up</h3>
      {qs.map((q) => {
        const s = sessionById(q.post);
        return (
          <div className="need" key={q.id}>
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
      })}
    </section>
  );
}
