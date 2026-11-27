// #/routines: everything that runs on a schedule, yours and your agents' own, in one list (app.ts renderRoutines);
// the rail says what's coming up and how today went. #/routines/new?thread=…&page=… opens New routine, linked.
import { useEffect } from "react";
import { clock, plural } from "../../lib/format.ts";
import { useRoute } from "../../lib/route.ts";
import { Shell } from "../../components/Shell.tsx";
import { capFirst, openRoutineForm, useRoutineUi } from "../../components/routines/routines.ts";
import { MyRoutinesCard, useRoutineRows } from "../../components/routines/parts.tsx";
import { fromNow } from "../../lib/agents.ts";

export function Routines() {
  const route = useRoute();
  const form = route.name === "routines" ? route.form : null;
  // An address that asks for the form opens it, linked to what it names.
  useEffect(() => {
    if (form && !useRoutineUi.getState().form) openRoutineForm(null, form);
  }, [form?.thread, form?.page]);
  return (
    <Shell right={<ComingUp />}>
      <MyRoutinesCard />
    </Shell>
  );
}

function ComingUp() {
  const { rows } = useRoutineRows();
  if (!rows.length) return null;
  const upcoming = rows
    .filter((x) => x.next && !x.off)
    .sort((a, b) => a.next.localeCompare(b.next))
    .slice(0, 6);
  const today = rows.filter((x) => x.last && new Date(x.last.at).toDateString() === new Date().toDateString());
  const failed = today.filter((x) => x.last && !x.last.ok && !x.last.skipped).length;
  return (
    <section className="card rail-card">
      <h3 className="rail-h">Coming up</h3>
      {upcoming.length ? (
        <ul className="rl-soon">
          {upcoming.map((x) => (
            <li key={x.key}>
              <a href={x.href}>
                <time>{clock(x.next)}</time>
                <span>
                  <b title={x.name}>{x.name}</b>
                  <small>{capFirst(fromNow(x.next))}</small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing scheduled.</p>
      )}
      <p className="rail-note">
        {plural(today.length, "routine")} ran today{failed ? `, ${failed} failed` : ""}.
      </p>
    </section>
  );
}
