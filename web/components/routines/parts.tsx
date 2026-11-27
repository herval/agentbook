// The pieces Routines, a routine's page and a page's Routines tab share: a link as a chip, a routine as a row, every
// routine of yours as a card (Routines', and your profile's Routines tab's), the threads started on one, what its
// test run did, a change as a diff, and who wrote a version.
import { useEffect, useState } from "react";
import { agentName, fromNow } from "../../lib/agents.ts";
import { ago, agoText, dayTime, hueVars } from "../../lib/format.ts";
import { useApp } from "../../lib/store.ts";
import type { By, PageChange } from "../../../plugin/shared/types.ts";
import type { RoutineRow } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { LaunchRow, ThreadRow } from "../ThreadRow.tsx";
import { runTime, shelf } from "../pages/pages.ts";
import { RoutineFormView } from "./RoutineForm.tsx";
import { loadAgentRoutines, openRoutineForm, restoreRoutine, routineRows, rowOfRoutine, RT_FILTERS, runRoutine, setRoutineUi, switchRoutine, useRoutineUi } from "./routines.ts";
import type { RoutineListRow } from "./routines.ts";

// A link, as a chip: an agent (its avatar), a page (its emoji), a thread (its title). `onUnlink`: an x that unlinks it.
export function LinkChip({ link: l, onUnlink }: { link: { kind: string; id: string }; onUnlink?: () => void }) {
  const page = useApp((s) => (l.kind === "page" ? (s.data?.pages || []).find((x) => x.id === l.id) : null));
  const s = useApp((st) => (l.kind === "thread" ? st.rows[l.id] || st.more[l.id] : null));
  const name = useApp(() => (l.kind === "agent" ? agentName(l.id) : ""));
  const unlink = onUnlink ? (
    <button className="rl-unlink" type="button" aria-label="Unlink it" title="Unlink it" onClick={onUnlink}>
      <Icon name="x" />
    </button>
  ) : null;
  if (l.kind === "agent")
    return (
      <span className="rl-link rl-link--agent">
        <a href={`#/agents/${l.id}`}>
          <Avatar agent={l.id} size="av--xs" />
          <span>{name || l.id}</span>
        </a>
        {unlink}
      </span>
    );
  if (l.kind === "page")
    return (
      <span className="rl-link">
        <a href={`#/pages/${encodeURIComponent(l.id)}`} title={`Page: ${page?.title || l.id}`}>
          {page?.emoji ? <i className="rl-emo">{page.emoji}</i> : <Icon name="page" />}
          <span>{page?.title || l.id}</span>
        </a>
        {unlink}
      </span>
    );
  return (
    <span className="rl-link">
      <a href={`#/threads/${encodeURIComponent(l.id)}`} title={`Thread: ${s?.title || ""}`}>
        <Icon name="comment" />
        <span>{s ? s.title || s.label : "a thread"}</span>
      </a>
      {unlink}
    </span>
  );
}
export const LinkChips = ({ links }: { links: { kind: string; id: string }[] }) => (
  <>
    {links.map((l, i) => (
      <LinkChip key={i} link={l} />
    ))}
  </>
);

// One of the list's routines: its dot, name and state, what it does, what it's linked to, when it runs, and (on yours)
// Run now and its switch, or Review when a version waits for your OK. An archived one has Restore.
export function RoutineItem({ x, canAct = true }: { x: RoutineListRow; canAct?: boolean }) {
  const [busy, setBusy] = useState(false);
  const r = x.r;
  const tint = hueVars(x.links.find((l) => l.kind === "agent")?.id || "claude");
  if (x.archived)
    return (
      <li className="rl-row is-off" style={tint}>
        <span className="rt-dot rt-dot--off" title="Archived" />
        <div className="rl-body">
          <p className="rl-t">
            <a className="rl-name" href={x.href}>
              {x.name}
            </a>
            <span className="chip">Archived</span>
          </p>
          {x.what ? (
            <p className="rl-what" title={x.what}>
              {x.what}
            </p>
          ) : null}
          <div className="rl-links">
            <LinkChips links={x.links} />
            {x.tag ? <span className="rl-tag">{x.tag}</span> : null}
          </div>
        </div>
        <div className="rl-side">
          <p className="rl-when">{x.when}</p>
          <p className="rl-next" title={dayTime(x.archived.at)}>
            Removed {agoText(x.archived.at)}
          </p>
          {canAct ? (
            <div className="rl-acts is-on">
              <button
                className="btn btn--sm"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  if (!(await restoreRoutine(r.id))) setBusy(false);
                }}
              >
                <Icon name="repeat" />
                Restore
              </button>
            </div>
          ) : null}
        </div>
      </li>
    );
  const dot = x.running ? "run" : x.waiting ? "wait" : x.failing ? "error" : x.off ? "off" : x.last?.ok ? "ok" : "none";
  const lastWords = x.last ? `${x.last.skipped ? "Skipped" : x.last.ok ? "Ran" : "Failed"} ${agoText(x.last.at)}` : "Hasn't run yet";
  const state = x.waiting ? (
    <span className="chip chip--rt-off">{r?.live_v ? `v${r.waiting.v} needs your OK` : "Needs your OK"}</span>
  ) : x.running ? (
    <span className="chip chip--live">
      <i className="pulse" />
      Running
    </span>
  ) : x.failing ? (
    <span className="chip chip--rt-bad">
      <Icon name="alert" />
      Failing
    </span>
  ) : x.off ? (
    <span className="chip">Paused</span>
  ) : null;
  const next = x.waiting && !r?.live_v ? "Not on yet" : x.off ? "Paused" : x.next ? `Next ${fromNow(x.next)}` : x.manual ? "When you run it" : "";
  const acts = !canAct ? null : x.waiting ? (
    <a className="btn btn--dark btn--sm" href={x.href}>
      Review
    </a>
  ) : r && r.live_v ? (
    <>
      <button
        className="icon-btn"
        type="button"
        disabled={r.running || busy}
        title="Run it now"
        aria-label={`Run ${r.name} now`}
        onClick={async () => {
          setBusy(true);
          if (!(await runRoutine(r))) setBusy(false);
        }}
      >
        <Icon name="play" />
      </button>
      <label className="switch switch--sm" title={r.on ? "On: click to pause" : "Paused: click to turn on"}>
        <input key={String(r.on)} type="checkbox" defaultChecked={r.on} aria-label={r.on ? "On" : "Paused"} onChange={async (e) => !(await switchRoutine(r.id, e.target.checked)) && (e.target.checked = !e.target.checked)} />
        <span className="track" />
      </label>
    </>
  ) : null;
  return (
    <li className={`rl-row${x.off && !x.waiting ? " is-off" : ""}${x.waiting ? " is-waiting" : ""}`} style={tint}>
      <span className={`rt-dot rt-dot--${dot}`} title={lastWords} />
      <div className="rl-body">
        <p className="rl-t">
          <a className="rl-name" href={x.href}>
            {x.name}
          </a>
          {state}
        </p>
        {x.what ? (
          <p className="rl-what" title={x.what}>
            {x.what}
          </p>
        ) : null}
        <div className="rl-links">
          <LinkChips links={x.links} />
          {x.tag ? <span className="rl-tag">{x.tag}</span> : null}
        </div>
      </div>
      <div className="rl-side">
        <p className="rl-when">{x.when}</p>
        <p className="rl-next" title={x.next ? dayTime(x.next) : lastWords}>
          {next}
        </p>
        {acts ? <div className={`rl-acts${x.waiting ? " is-on" : ""}`}>{acts}</div> : null}
      </div>
    </li>
  );
}

// The rows of every routine of yours, agentbook's and your agents' own (read once the list shows), and the archived.
export function useRoutineRows() {
  const routines = useApp((s) => s.data?.routines) || [];
  const ext = useRoutineUi((s) => s.ext);
  // Which agents run some of their own: read again when that changes.
  const theirs = useApp((s) => (s.data?.agents || []).filter((a) => a.routines?.n && a.mine !== false).map((a) => `${a.id}:${a.routines.n}`).join(" "));
  useEffect(() => {
    loadAgentRoutines();
  }, [theirs]);
  return { rows: routineRows(routines, ext), gone: routines.filter((r) => r.archived).map((r) => rowOfRoutine(r)), reading: !!theirs && !ext };
}
export function MyRoutinesCard() {
  const { rows, gone, reading } = useRoutineRows();
  const form = useRoutineUi((s) => s.form);
  const filter = useRoutineUi((s) => s.filter);
  gone.sort((a, b) => b.archived.at.localeCompare(a.archived.at));
  const f = RT_FILTERS.find(([k]) => k === filter) || RT_FILTERS[0];
  const of = (k: string) => (k === "archived" ? gone : rows);
  const shown = of(f[0]).filter(f[2]);
  const forming = form && !form.rid;
  const newBtn = (
    <button className="btn btn--dark" type="button" onClick={() => openRoutineForm(null)}>
      <Icon name="plus" />
      New routine
    </button>
  );
  return (
    <section className="card rl">
      <div className="page-head">
        <h1 className="page-h">Routines</h1>
        {forming ? null : newBtn}
      </div>
      {forming ? <RoutineFormView /> : null}
      {rows.length || gone.length ? (
        <div className="rl-pills">
          {RT_FILTERS.filter(([k, , has]) => k === "all" || k === f[0] || of(k).some(has)).map(([k, label, has]) => (
            <button key={k} className={`pill ${f[0] === k ? "is-on" : ""}`} type="button" onClick={() => setRoutineUi({ filter: k })}>
              {label} <span>{of(k).filter(has).length}</span>
            </button>
          ))}
          {reading ? <span className="muted rl-reading">Reading your agents' own…</span> : null}
        </div>
      ) : null}
      {shown.length ? (
        <ul className="rl-list">
          {shown.map((x) => (
            <RoutineItem key={x.key} x={x} />
          ))}
        </ul>
      ) : null}
      {!rows.length ? (
        <div className="rl-empty">
          <span className="rl-empty-ico">
            <Icon name="repeat" />
          </span>
          <p>
            <b>Nothing runs on a schedule yet.</b>
          </p>
          <p className="muted">A routine asks an agent to do something on a schedule: a digest every weekday at 9, a check on a deploy every few hours, a page kept up to date.</p>
          {form ? null : newBtn}
        </div>
      ) : !shown.length ? (
        <p className="muted rl-none">None right now.</p>
      ) : null}
    </section>
  );
}

// The threads started on a routine from its page (routine-threads.ts), newest first: the feed's row of each, or its
// launch's while it starts. `threads`: what its page read.
export function RoutineThreadsCard({ threads }: { threads: { at: string; post?: string | null; lid?: string; agent?: string }[] | null | undefined }) {
  const rows = useApp((s) => s.rows);
  const more = useApp((s) => s.more);
  const launches = useApp((s) => s.data?.launches) || [];
  const items = (threads || [])
    .map((x, i) => {
      const s = x.post && (rows[x.post] || more[x.post]);
      if (s) return <ThreadRow key={i} thread={s} />;
      const l = launches.find((y) => y.id === x.lid);
      if (l) return <LaunchRow key={i} launch={l} />;
      return x.post ? (
        <a key={i} className="act-row" href={`#/threads/${encodeURIComponent(x.post)}`}>
          <Avatar agent={x.agent} size="av--sm" />
          <span>
            <b>A thread on it</b>
            <small>{agentName(x.agent)}</small>
          </span>
          <time>{ago(x.at)}</time>
        </a>
      ) : null;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return (
    <section className="card tk-sec tk-threads-card">
      <h2 className="tk-h">
        Threads on it<span className="n">{items.length}</span>
      </h2>
      <ul className="act-list tk-threads">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
}
// A thread on it working now, or starting, started since `since` (when it began failing): its agent is on it. Once it
// has answered, you can ask again.
export function useRoutineOnIt(threads: { at: string; post?: string | null; lid?: string }[] | null | undefined, since: string | null | undefined) {
  return useApp((s) =>
    (threads || []).some((x) => {
      if (x.at < (since || "")) return false;
      const t = x.post && (s.rows[x.post] || s.more[x.post]);
      if (t) return !shelf(t) && t.effective === "working";
      const l = (s.data?.launches || []).find((y) => y.id === x.lid);
      return !!l && !l.error;
    }),
  );
}

export function TestLine({ t }: { t: { ok?: boolean; error?: string | null; changes?: PageChange[]; ms?: number } | null | undefined }) {
  if (!t)
    return (
      <p className="tested">
        <span className="rt-dot" />
        No test run yet.
      </p>
    );
  if (!t.ok)
    return (
      <p className="tested tested--bad">
        <span className="rt-dot rt-dot--error" />
        Its test run failed: {(t.error || "").split("\n")[0]}
      </p>
    );
  const ch = (t.changes || []).filter((c) => c.id);
  const what = ch.length ? `It would change ${ch.slice(0, 4).map((c) => `${c.w}${c.from != null && c.to != null ? `, ${c.from} → ${c.to}` : ""}`).join("; ")}${ch.length > 4 ? `, and ${ch.length - 4} more` : ""}.` : "It would change nothing on the page as it is.";
  return (
    <p className="tested">
      <span className="rt-dot rt-dot--ok" />
      Its test run worked: {runTime(t.ms)}. {what}
    </p>
  );
}
export type RoutineDiff = { lines: { t: string; text: string }[]; added?: number; removed?: number };
export const DiffLines = ({ d }: { d: RoutineDiff }) => (
  <>
    {d.lines.map((l, i) =>
      l.t === "…" ? (
        <span key={i} className="c">{`  … ${l.text} …\n`}</span>
      ) : (
        <span key={i} className={l.t === "+" ? "add" : l.t === "-" ? "del" : ""}>{`${l.t} ${l.text}\n`}</span>
      ),
    )}
  </>
);
export function WrittenBy({ by }: { by: By | null | undefined }) {
  const me = useApp((s) => s.me?.username);
  const s = useApp((st) => (by?.post ? st.rows[by.post] || st.more[by.post] : null));
  if (!by || by.user) return <b>{by?.user && by.user !== me ? `@${by.user}` : "You"}</b>;
  return (
    <>
      <Avatar agent={by.agent} size="av--xs" />
      <b>{agentName(by.agent) || "An agent"}</b>
      {s ? (
        <>
          {" in "}
          <a href={`#/threads/${encodeURIComponent(s.id)}`}>
            <b>{s.label}</b>
          </a>
        </>
      ) : null}
    </>
  );
}
export const pageRoutineRows = (rs: RoutineRow[], page: string) => rs.map((r) => rowOfRoutine(r, { page }));
