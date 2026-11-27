// #/routines/:id: one routine of yours, its runs and its versions (app.ts renderMyRoutine). Its head (and why it's
// failing, and a change waiting for your OK), the box that starts a thread on it and the threads it has, then what it
// runs and its runs; on the right, about it.
import { useState } from "react";
import type { ReactNode } from "react";
import { agentName, fromNow, verb } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, clock, dayTime, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { go, useRoute } from "../../lib/route.ts";
import { agentOf, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { RoutineRow, RoutineView } from "../../lib/types.ts";
import { Avatar } from "../../components/Avatar.tsx";
import { Composer } from "../../components/Composer.tsx";
import { Icon } from "../../components/Icon.tsx";
import { LaunchRow, ThreadRow } from "../../components/ThreadRow.tsx";
import { launchForPage, onPageMachine, pageWriters, reachWords, runTime, shelf } from "../../components/pages/pages.ts";
import { DiffLines, LinkChips, RoutineThreadsCard, TestLine, WrittenBy } from "../../components/routines/parts.tsx";
import type { RoutineDiff } from "../../components/routines/parts.tsx";
import { RoutineFormView } from "../../components/routines/RoutineForm.tsx";
import { bumpRoutines, capFirst, openRoutineForm, restoreRoutine, routineAgent, runRoutine, setRoutineUi, shortPath, switchRoutine, useRoutineUi } from "../../components/routines/routines.ts";

// The routine open: what its page read, with its brief from the chrome over it.
type Full = RoutineView & RoutineRow;

export function MyRoutine() {
  const { id } = useRoute();
  const brief = useApp((s) => (s.data?.routines || []).find((x) => x.id === id));
  const bump = useRoutineUi((s) => s.bump);
  // Read again when its brief in the chrome changes (a run, a version), and after you do something to it.
  const got = useLoad<RoutineView>(`/api/routines/${encodeURIComponent(id)}`, [brief, bump]);
  if (got.missing)
    return (
      <div className="shell-msg">
        <p>There's no such routine here.</p>
        <a className="btn" href="#/routines">
          Every routine
        </a>
      </div>
    );
  const data = got.data;
  const r = data && data.id === id ? ({ ...data, ...(brief || {}) } as Full) : null;
  return (
    <div className="sess-shell">
      <main>
        <p className="crumbs">
          <a href="#/routines">Routines</a>
          <span className="sep">/</span>
          <span>{r?.name || brief?.name || ""}</span>
        </p>
        {r ? (
          <Routine r={r} data={data} />
        ) : (
          <article className="card myrt">
            <p className="muted">Loading…</p>
          </article>
        )}
      </main>
      {r ? (
        <aside className="rail sess-side">
          <About r={r} />
        </aside>
      ) : (
        <aside className="rail sess-side" />
      )}
    </div>
  );
}

// A button that asks something of the server, off while it asks: on with `again` when it didn't go through.
function Act({ className, onAct, children, disabled = false }: { className: string; onAct: () => Promise<boolean>; children: ReactNode; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        if (!(await onAct())) setBusy(false);
      }}
    >
      {children}
    </button>
  );
}

function Routine({ r, data }: { r: Full; data: RoutineView }) {
  const me = useApp((s) => s.me?.username);
  const page = useApp((s) => (r.page ? (s.data?.pages || []).find((x) => x.id === r.page) : null));
  const thread = useApp((s) => (r.thread ? s.rows[r.thread] || s.more[r.thread] : null));
  const form = useRoutineUi((s) => s.form);
  const open = useRoutineUi((s) => s.open);
  const editing = form?.rid === r.id;
  const isOpen = (k: string) => !!open[`${r.id}:${k}`];
  const fold = (k: string, label: string, n: string, inner: ReactNode) => (
    <>
      <button className="rtc-fold" type="button" aria-expanded={isOpen(k)} onClick={() => setRoutineUi((s) => ({ open: { ...s.open, [`${r.id}:${k}`]: !s.open[`${r.id}:${k}`] } }))}>
        <Icon name="down" className="caret" />
        {label}
        {n ? (
          <>
            {" "}
            <span className="muted">{n}</span>
          </>
        ) : null}
      </button>
      {isOpen(k) ? <div className="rtc-in">{inner}</div> : null}
    </>
  );
  const runNow = r.archived ? (
    <Act className="btn btn--dark btn--sm" onAct={() => restoreRoutine(r.id)}>
      <Icon name="repeat" />
      Restore
    </Act>
  ) : r.live_v ? (
    <Act className="btn btn--dark btn--sm" disabled={r.running} onAct={() => runRoutine(r)}>
      <Icon name="play" />
      {r.running ? "Running…" : "Run now"}
    </Act>
  ) : null;
  const sw =
    r.live_v && !r.archived ? (
      <label className="switch switch--sm">
        <input key={String(r.on)} type="checkbox" defaultChecked={r.on} onChange={async (e) => !(await switchRoutine(r.id, e.target.checked)) && (e.target.checked = !e.target.checked)} />
        <span className="track" />
        <b>{r.on ? "On" : "Paused"}</b>
      </label>
    ) : null;
  const edit =
    r.kind === "agent" && !editing && !r.archived ? (
      <button className="btn btn--line btn--sm" type="button" onClick={() => openRoutineForm(r)}>
        <Icon name="pencil" />
        Change
      </button>
    ) : null;
  const dot = r.archived ? "off" : r.running ? "run" : r.waiting ? "wait" : r.live_v && r.fails >= 2 ? "error" : !r.live_v || !r.on ? "off" : r.last?.ok ? "ok" : "none";
  const state = r.archived
    ? `Removed ${agoText(r.archived.at)}${r.archived.by?.agent ? ` by ${agentName(r.archived.by.agent) || "an agent"}` : r.archived.by?.user && r.archived.by.user !== me ? ` by @${r.archived.by.user}` : ""}: archived, not running`
    : r.waiting && !r.live_v
      ? "Waits for your OK"
      : [!r.on ? "Paused" : r.running ? "Running now" : r.next ? `Next ${fromNow(r.next)} · ${dayTime(r.next)}` : r.every?.kind === "manual" ? "Runs when you run it" : "", r.waiting ? `v${r.waiting.v} waits for your OK` : ""].filter(Boolean).join(" · ");
  // Where each run goes, said after "Each run".
  const goes =
    r.kind !== "agent" ? (
      r.page ? (
        "writes the widgets it keeps on its page, with no model."
      ) : r.thread ? (
        "posts its line to its thread, with no model."
      ) : (
        "runs its code, with no model."
      )
    ) : r.thread ? (
      `continues “${thread?.title || "its thread"}”, as a message from this routine.`
    ) : (
      <>
        starts a new thread
        {r.root ? (
          <>
            {" in "}
            <code>{shortPath(r.root)}</code>
          </>
        ) : null}
        {r.links.some((l) => l.kind === "page") ? ", from its first page" : ""}.
      </>
    );
  // A code routine: the widgets it keeps on its page, what it reaches, what it can't keep, and how its newest version
  // did when it was tested.
  const ver = r.versions.find((x) => x.live) || r.versions[0];
  const keeps = (r.keeps || []).map((wid) => page?.widgets?.find((w) => w.id === wid)?.title || wid);
  const what =
    r.kind === "agent" ? (
      <pre className="rt-prompt">{r.prompt}</pre>
    ) : (
      <dl className="myrt-kv">
        {keeps.length ? (
          <>
            <dt>Keeps</dt>
            <dd>
              {keeps.map((t, i) => (
                <span key={i} className="chip">
                  {t}
                </span>
              ))}
              {page ? (
                <>
                  {" "}
                  <span className="muted">
                    on <a href={`#/pages/${encodeURIComponent(page.id)}`}>{page.title}</a>
                  </span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Reaches</dt>
        <dd>{reachWords(ver?.reach)}</dd>
        {r.cant_keep ? (
          <>
            <dt>Can't keep</dt>
            <dd>{r.cant_keep}</dd>
          </>
        ) : null}
        <dt>Written by</dt>
        <dd>
          <WrittenBy by={ver?.by || r.by} />
        </dd>
        <dt>Tested</dt>
        <dd>
          <TestLine t={ver?.test} />
        </dd>
      </dl>
    );
  const failing = r.live_v && r.fails >= 2;
  const fixing = useFix(r, !!failing);
  // A code routine on a page of yours: an agent that can write pages fixes it, its fix waiting for your OK here.
  const askFix =
    r.kind === "code" && page && page.mine !== false && !fixing?.going ? (
      <Act
        className="btn btn--dark btn--sm"
        onAct={async () => {
          const agent = onPageMachine(page, r.agent);
          const use = agentOf(agent).kind && !agentOf(agent).offline ? agent : pageWriters()[0]?.id;
          if (!use) return toast("No agent that can write pages is online."), false;
          const prompt = `The routine "${r.name}" (routine "${r.id}") on the page "${page.title}" is failing. Its last run said:\n\n${(r.last?.error || "").slice(0, 1500)}\n\nRead it with ab_routine_read, find why, and fix it with ab_routine_write, testing with test: true until it works. I'll OK the fix on agentbook. If the problem isn't in its code (an expired key, a VPN, a server that's down), don't change it: say so, and leave me a to-do with ab_todo.`;
          const l = await launchForPage(page, use, prompt, `Asked ${agentName(use)} to fix ${r.name}. Its fix waits for your OK here.`);
          // The routine keeps which thread that is, so its page shows how it's going, and what stopped it.
          if (!l?.lid) return false;
          await post(`/api/routines/${encodeURIComponent(r.id)}/fix`, { launch: l.lid, agent: use });
          return true;
        }}
      >
        <Icon name="pencil" />
        Ask {agentName(r.agent) || "Claude"} {fixing ? "again" : "to fix it"}
      </Act>
    ) : null;
  // A thread on it, with an agent that has agentbook's tools: it's told which routine (routine-threads.ts), and
  // changes it with ab_routine_write, for your OK.
  const talks = !r.archived && (!r.page || !!page?.can_edit);
  return (
    <>
      <article className="card myrt">
        <header className="myrt-head">
          <div>
            <h1>{r.name}</h1>
            <p className="myrt-when">
              <span className={`rt-dot rt-dot--${dot}`} />
              <b>{capFirst(r.when)}</b>
              {state ? (
                <>
                  <span className="muted">·</span>
                  <span className="muted">{state}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="myrt-acts">
            {sw}
            {edit}
            {runNow}
          </div>
        </header>
        {r.about ? <p className="myrt-about">{r.about}</p> : null}
        <div className="rl-links myrt-links">
          <LinkChips links={r.links} />
          {r.kind === "code" ? <span className="rl-tag">Code, no model</span> : null}
        </div>
        {r.archived ? (
          <div className="rt-change">
            <p className="q">Archived. It doesn't run, and it's only under Archived on Routines.</p>
            <p>
              Restore puts it back as it was: {r.when}, v{r.live_v || r.code_v}
              {r.live_v && !r.on ? ", paused" : ""}, with its runs.
            </p>
          </div>
        ) : null}
        {editing ? <RoutineFormView /> : null}
        {failing ? (
          <div className="rtc-last rtc-last--bad myrt-fail">
            <span className="rt-dot rt-dot--error" />
            <b>Failing since {dayTime(r.failing_since || r.last?.at)}.</b> Its last {r.fails} runs failed: <code>{(r.last?.error || "").split("\n")[0].slice(0, 300)}</code>
            {fixing?.node}
            {askFix}
          </div>
        ) : null}
        {r.change ? <Change r={r} /> : null}
        <Unsigned r={r} />
      </article>
      <div className="rt-talk">
        <div>{talks ? <Composer routine={r.id} box={`Ask an agent to change ${r.name}, or about it…`} /> : null}</div>
        <div>
          <RoutineThreadsCard threads={data.threads} />
        </div>
      </div>
      <article className="card myrt rt-body">
        {editing || (r.change && !r.live_v) ? null : (
          <div className="myrt-sec">
            <p className="myrt-h">{r.kind === "agent" ? "What it asks" : "What it runs"}</p>
            {what}
            <p className="myrt-goes">
              <Icon name="repeat" />
              <span>Each run {goes}</span>
            </p>
          </div>
        )}
        <div className="myrt-sec">
          <p className="myrt-h">
            Runs <span className="muted">{r.runs.length || ""}</span>
          </p>
          <Runs r={r} />
        </div>
        <div className="rtc-folds">
          {fold("code", r.kind === "agent" ? "Versions" : "Code", `v${r.code_v}`, <Versions r={r} />)}
          {r.archived
            ? null
            : fold(
                "remove",
                "Remove it",
                "",
                <>
                  <p className="muted">{r.kind === "code" && r.page ? "It stops running and goes to Archived on Routines. Its widgets stay as they are, no longer kept up to date. Restore puts it back." : "It stops running and goes to Archived on Routines. Its threads stay. Restore puts it back."}</p>
                  <Act
                    className="btn btn--sm"
                    onAct={async () => {
                      const res = await post(`/api/routines/${encodeURIComponent(r.id)}/remove`);
                      if (!res.ok) return false;
                      toast("Removed. It's under Archived on Routines, to restore.");
                      go("#/routines");
                      return true;
                    }}
                  >
                    Remove {r.name}
                  </Act>
                </>,
              )}
        </div>
      </article>
    </>
  );
}

// The agent asked to fix it since it's been failing: its thread as the feed lists it, or its start, and why that
// failed. `going` while it's on it, when there's no asking again. (What cut its thread off, if something did, is the
// thread area's to show.)
function useFix(r: Full, on: boolean): { going: boolean; node: ReactNode } | null {
  const f = r.fix;
  const s = useApp((st) => (f?.post ? st.rows[f.post] || st.more[f.post] : null));
  const l = useApp((st) => (f?.lid ? (st.data?.launches || []).find((x) => x.id === f.lid) : null));
  if (!on || !f || f.at < (r.failing_since || "")) return null;
  if (s)
    return {
      going: !shelf(s) && s.effective !== "done",
      node: (
        <div className="myrt-fixing">
          <ul className="act-list">
            <li>
              <ThreadRow thread={s} />
            </li>
          </ul>
        </div>
      ),
    };
  return l
    ? {
        going: !l.error,
        node: (
          <div className="myrt-fixing">
            <LaunchRow launch={l} />
          </div>
        ),
      }
    : null;
}

// Its runs, newest first: when, what it did (the thread it started, the version of its page it wrote, why it didn't
// run), and how long it took. The newest 15, then the rest on a click.
function Runs({ r }: { r: Full }) {
  const all = useRoutineUi((s) => !!s.allRuns[r.id]);
  const rows = useApp((s) => s.rows);
  const more = useApp((s) => s.more);
  if (!r.runs.length) return <p className="muted rt-none">{r.live_v ? (r.next ? `It hasn't run yet. Its first run is ${fromNow(r.next)}, ${dayTime(r.next)}.` : "It hasn't run yet.") : "Nothing runs until you OK it."}</p>;
  const row = (x: Full["runs"][number]) => {
    let what: ReactNode;
    if (x.skipped) what = <span className="muted">Skipped: {x.skipped}</span>;
    else if (!x.ok) what = <span className="err">{(x.error || "").split("\n")[0]}</span>;
    else if (r.kind === "agent") {
      const s = x.post && (rows[x.post] || more[x.post]);
      what = s ? (
        <>
          {r.thread ? "Sent to" : "Started"}{" "}
          <a href={`#/threads/${encodeURIComponent(s.id)}`}>
            <Avatar agent={s.agent} size="av--xs" />
            <b>{s.title || s.label}</b>
          </a>{" "}
          <span className="muted">
            {s.label} {verb(s)}
          </span>
        </>
      ) : r.thread ? (
        "Sent to the thread"
      ) : x.lid ? (
        <span className="muted">Starting its thread…</span>
      ) : (
        "Started"
      );
    } else
      what = x.version ? (
        <>
          Changed {plural(x.changed.length, "widget")} · <a href={`#/pages/${encodeURIComponent(r.page)}/versions/${x.version}`}>v{x.version}</a>
        </>
      ) : r.page ? (
        "Nothing changed"
      ) : (
        (x as { summary?: string }).summary || "Done"
      );
    const why = x.why === "now" ? <span className="why">Run now</span> : x.why === "catch-up" ? <span className="why">Caught up</span> : null;
    return (
      <tr key={x.id}>
        <td>{dayTime(x.at)}</td>
        <td>
          <span className={`rt-dot rt-dot--${x.skipped ? "off" : x.ok ? "ok" : "error"}`} />
          {what}
          {why ? <> {why}</> : null}
        </td>
        <td className="ms">{x.ms != null && !x.skipped ? runTime(x.ms) : ""}</td>
      </tr>
    );
  };
  return (
    <>
      <table className="runs">
        <tbody>{r.runs.slice(0, all ? 200 : 15).map(row)}</tbody>
      </table>
      {r.runs.length > 15 && !all ? (
        <button className="ask-skip" type="button" onClick={() => setRoutineUi((s) => ({ allRuns: { ...s.allRuns, [r.id]: true } }))}>
          {plural(r.runs.length - 15, "older run")}
        </button>
      ) : null}
    </>
  );
}

// The version that runs, OK'd before your machines kept your passkeys: they run it once you sign that OK.
function Unsigned({ r }: { r: Full }) {
  const signs = useApp((s) => (s.data?.machines || []).some((m) => m.mine && m.signs));
  const live = r.versions?.find((x) => x.live);
  if (!live?.ok || live.ok.signed || !signs) return null;
  return (
    <div className="rt-change">
      <p className="q">Your machines run v{live.v} only once you sign its OK with your passkey.</p>
      <div className="acts">
        <Act
          className="btn btn--dark btn--sm"
          onAct={async () => {
            const res = await post(`/api/routines/${encodeURIComponent(r.id)}/sign`, {});
            if (res.ok) toast("Signed. Your machines run it from its next time.");
            bumpRoutines();
            return res.ok;
          }}
        >
          <Icon name="lock" />
          Sign it
        </Act>
      </div>
    </div>
  );
}

function Change({ r }: { r: Full }) {
  const c = r.versions.find((x) => x.v === r.change.v);
  const live = r.versions.find((x) => x.live);
  if (!c) return null;
  const ok = (use: boolean) => async () => {
    const res = await post(`/api/routines/${encodeURIComponent(r.id)}/ok`, { v: c.v, use });
    if (res.ok) toast(use ? "It's on. It runs at its next time." : "Kept as it was.");
    bumpRoutines();
    return true;
  };
  return (
    <div className="rt-change">
      <p className="q">
        <WrittenBy by={c.by} /> {live ? `changed it: v${c.v} waits for your OK` : `wants to run it ${r.when}`}
      </p>
      {c.summary ? <p>“{c.summary}”</p> : null}
      {r.change.also?.length ? <p>It also {r.change.also.join(", ")}.</p> : null}
      {r.kind === "code" ? (
        <>
          <p>
            It reaches <b>{reachWords(c.reach)}</b>.
          </p>
          <TestLine t={c.test} />
        </>
      ) : null}
      <pre className={`rt-code${r.kind === "agent" ? " rt-code--wrap" : ""}`}>{r.change.diff ? <DiffLines d={r.change.diff as RoutineDiff} /> : (c.prompt ?? c.code ?? "")}</pre>
      <div className="acts">
        <Act className="btn btn--dark btn--sm" onAct={ok(true)}>
          <Icon name="check" />
          {live ? `Use v${c.v}` : "Turn it on"}
        </Act>
        <Act className="btn btn--sm" onAct={ok(false)}>
          {live ? `Keep v${live.v}` : "Not now"}
        </Act>
        {live ? <small>v{live.v} keeps running until you choose.</small> : null}
      </div>
    </div>
  );
}

// Its versions: one picked (the one that runs, at first), who wrote it, what changed from the one before, and its
// prompt or code.
function Versions({ r }: { r: Full }) {
  const picked = useRoutineUi((s) => s.version[r.id]);
  const sel = Number(picked) || r.live_v || r.code_v;
  const c = r.versions.find((x) => x.v === sel) || r.versions[0];
  if (!c) return null;
  const status = (x: Full["versions"][number]) => (x.live ? "runs now" : x.ok ? `OK'd ${clock(x.ok.at)}` : x.passed === "kept" ? "kept out" : x.passed ? "passed over" : "waits for your OK");
  const diff = c.diff as RoutineDiff | undefined;
  const also = (c as { also?: string[] }).also;
  return (
    <>
      <p className="code-meta">
        <select aria-label="Version" value={c.v} onChange={(e) => setRoutineUi((s) => ({ version: { ...s.version, [r.id]: e.target.value } }))}>
          {r.versions.map((x) => (
            <option key={x.v} value={x.v}>
              v{x.v} · {status(x)}
            </option>
          ))}
        </select>
        <span>
          <WrittenBy by={c.by} />, {agoText(c.at)}
          {c.summary ? `: “${c.summary}”` : ""}
        </span>
      </p>
      {diff ? (
        <details className="rt-diff">
          <summary>
            What changed from v{c.from} (+{diff.added} −{diff.removed}){also?.length ? `, and it ${also.join(", ")}` : ""}
          </summary>
          <pre className={`rt-code${c.prompt != null ? " rt-code--wrap" : ""}`}>
            <DiffLines d={diff} />
          </pre>
        </details>
      ) : null}
      <pre className={`rt-code${c.prompt != null ? " rt-code--wrap" : ""}`}>{c.prompt ?? c.code ?? ""}</pre>
    </>
  );
}

// The rail: who runs it, its model, who made it and when, its version, and where it runs.
function About({ r }: { r: Full }) {
  const machine = useApp((s) => s.data?.machine);
  const by = useApp((s) => (r.by?.post ? s.rows[r.by.post] || s.more[r.by.post] : null));
  const runsAs = routineAgent(r);
  const madeBy =
    r.by?.user || !r.by ? (
      "You"
    ) : (
      <>
        {agentName(r.by.agent) || "an agent"}
        {by ? (
          <>
            {" in "}
            <a href={`#/threads/${encodeURIComponent(r.by.post)}`}>
              <b>{by.label}</b>
            </a>
          </>
        ) : null}
      </>
    );
  return (
    <section className="card rail-card">
      <h3 className="rail-h">About this routine</h3>
      <dl className="kv">
        {r.kind === "agent" ? (
          <>
            <dt>Runs as</dt>
            <dd>
              <a href={`#/agents/${runsAs}`}>
                <Avatar agent={runsAs} size="av--xs" />
                <b>{agentName(runsAs)}</b>
              </a>
            </dd>
          </>
        ) : (
          <>
            <dt>Runs</dt>
            <dd>Code, with no model</dd>
          </>
        )}
        {r.model ? (
          <>
            <dt>Model</dt>
            <dd>{r.model}</dd>
          </>
        ) : null}
        <dt>Made</dt>
        <dd>
          {madeBy}, {agoText(r.created)}
        </dd>
        <dt>Version</dt>
        <dd>
          v{r.live_v || r.code_v}
          {r.waiting ? `, v${r.waiting.v} waiting` : ""}
        </dd>
        <dt>Runs on</dt>
        <dd title="While agentbook runs there">{machine || "this machine"}</dd>
      </dl>
    </section>
  );
}
