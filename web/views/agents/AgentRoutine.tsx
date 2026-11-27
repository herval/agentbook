// #/agents/:id/routines/:job: one of an agent's own routines (an OpenClaw cron job, a claude.ai routine, a Codex
// automation), with its runs, which stay off the feed: each opens in place to what it did (app.ts renderRoutine). Its
// head (and why it's failing), the box that starts a thread on it and the threads it has, then what it's told and its
// runs; on the right, about it, and Run now / Pause.
import { useState } from "react";
import { agentName, fromNow, inactiveAgent, scheduleWords, startable, waits } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { clock, dayTime, dur, hueVars, model } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { agentHref, useRoute } from "../../lib/route.ts";
import { agentOf, useAgent, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { AgentCron, CronJob, CronRun, CronRunRead } from "../../lib/types.ts";
import { Composer } from "../../components/Composer.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { RoutineChip } from "../../components/RoutineRow.tsx";
import { RoutineThreadsCard, useRoutineOnIt } from "../../components/routines/parts.tsx";
import { FIX_ASK, routineWhereUrl } from "../../components/routines/routines.ts";
import { Keyed } from "../../components/Keyed.tsx";

// A run, as its routine's page lists it: what the driver says of it besides the shared fields.
type Run = CronRun & { delivered?: string; manual?: boolean; unread?: boolean; n?: number };

export function AgentRoutine() {
  const { id, job } = useRoute();
  const a = useAgent(id);
  // Its routines in brief, in the chrome: read it again when they change.
  const brief = useApp((s) => (s.data?.agents || []).find((x) => x.id === id)?.routines);
  const url = routineWhereUrl(id, job);
  const got = useLoad<CronJob>(url, brief);
  const [older, setOlder] = useState<{ url: string; runs: Run[]; more: boolean } | null>(null);
  if (got.missing)
    return (
      <div className="shell-msg">
        <p>{agentName(a.id)} has no such routine.</p>
        <a className="btn" href={agentHref(id, "routines")}>
          Back to its routines
        </a>
      </div>
    );
  const data = got.data;
  const r = data?.routine;
  // Its runs: the newest, as read now, and the older ones asked for after them.
  const had = older?.url === url ? older : null;
  const first = (data?.runs || []) as Run[];
  const runs = had ? [...first, ...had.runs.filter((x) => !first.some((y) => y.id === x.id) && (!first.length || x.at < first.at(-1).at))] : first;
  const more = had ? had.more : !!data?.more;
  const showOlder = async () => {
    const res = await fetch(`${url}?offset=${runs.length}`).catch(() => null);
    const d: CronJob = res?.ok ? await res.json().catch(() => ({})) : {};
    setOlder({ url, runs: [...(had?.runs || []), ...((d.runs || []) as Run[]).filter((x) => !runs.some((y) => y.id === x.id))], more: !!d.more });
  };
  return (
    <div className="sess-shell" style={hueVars(id)}>
      <main>
        <p className="crumbs">
          <a href={agentHref(id, "threads")}>{agentName(a.id)}</a>
          <span className="sep">/</span>
          <a href={agentHref(id, "routines")}>Routines</a>
          <span className="sep">/</span>
          <span>{r?.name || ""}</span>
        </p>
        {r ? (
          <Routine id={id} job={job} r={r} data={data} runs={runs} more={more} onOlder={showOlder} reload={got.reload} />
        ) : (
          <article className="card post post--full">
            <p className="muted">{got.error || data?.error || "Loading…"}</p>
          </article>
        )}
      </main>
      <aside className="rail sess-side">{r ? <About id={id} job={job} r={r} reload={got.reload} /> : null}</aside>
    </div>
  );
}

// The routine: its head, why it's failing, the thread box and its threads, what it's told, and its runs.
function Routine({
  id,
  job,
  r,
  data,
  runs,
  more,
  onOlder,
  reload,
}: {
  id: string;
  job: string;
  r: AgentCron;
  data: CronJob;
  runs: Run[];
  more: boolean;
  onOlder: () => void;
  reload: () => Promise<void>;
}) {
  const a = useAgent(id);
  const [asking, setAsking] = useState(false);
  const told = { agentTurn: "What it's told to do", systemEvent: "What it tells its agent", command: "The command it runs", script: "The script it runs" }[
    r.kind
  ];
  const what = !r.what ? null : r.kind === "agentTurn" || r.kind === "systemEvent" ? <Markdown text={r.what} /> : <pre className="rt-code">{r.what}</pre>;
  // A thread on it, with its agent: one that's failing says since when and why, with a button that asks its agent to
  // fix it.
  const talks = startable(a);
  const name = a.name || agentName(id); // "Pato", not "Pato @ brick via hervalm5"
  const bad: Run[] = [];
  for (const x of runs) {
    if (x.status !== "error") break;
    bad.push(x);
  }
  const since = bad.at(-1)?.at || r.last;
  const onIt = useRoutineOnIt(data.threads, since);
  let failing = null;
  if (r.status === "error") {
    const n = Math.max(r.failing || 0, bad.length, 1);
    const why = String(r.error || bad[0]?.error || "")
      .split("\n")[0]
      .slice(0, 300);
    const asked = talks && (data.threads || []).some((x) => x.at >= (since || ""));
    // A failing routine's Ask … to fix it: a thread on it with its agent (routine-threads.ts), which the page lists.
    const fix = async () => {
      setAsking(true);
      const res = await post("/api/launch", { prompt: FIX_ASK, agent: id, on_routine: job, machine: agentOf(id).machine || undefined });
      setAsking(false);
      if (res.ok) toast(res.data.queued ? waits(res.data, "it starts") : `Asked ${agentOf(id).name || agentName(id)} to fix it, in a thread on it.`);
      await reload();
    };
    const act = !talks ? null : onIt ? (
      <p className="rt-onit">
        <Icon name="clock" />
        {name} is on it, in the thread below.
      </p>
    ) : (
      <button className="btn btn--dark btn--sm" type="button" disabled={asking} onClick={fix}>
        <Icon name="pencil" />
        Ask {name} {asked ? "again" : "to fix it"}
      </button>
    );
    failing = (
      <div className="rtc-last rtc-last--bad myrt-fail">
        <span className="rt-dot rt-dot--error" />
        <b>Failing{since ? ` since ${dayTime(since)}` : ""}.</b> {n > 1 ? `Its last ${n} runs failed` : "Its last run failed"}
        {why ? (
          <>
            : <code>{why}</code>
          </>
        ) : (
          "."
        )}
        {act}
      </div>
    );
  }
  return (
    <>
      {/* Each part in a box of its own (Keyed), as the stylesheet spaces them (.post > *, .rt-body > :first-child). */}
      <article className="card post post--full">
        <Keyed k="head">
          <header className="skill-head">
            <span className={`skill-ico skill-ico--lg${r.enabled ? "" : " skill-ico--off"}`}>
              <Icon name="repeat" />
            </span>
            <div>
              <h1 className="post-title post-title--big">{r.name}</h1>
              <div className="post-meta">
                <span>{scheduleWords(r.schedule)}</span>
                <RoutineChip routine={r} />
                {r.builtin ? <span className="chip">OpenClaw upkeep</span> : null}
                {r.place?.cowork ? <span className="chip">Claude app</span> : null}
              </div>
            </div>
          </header>
          {r.description ? <p className="skill-desc">{r.description}</p> : null}
          {data.error ? <p className="muted rt-err">{data.error}</p> : null}
        </Keyed>
        <Keyed k="failing">{failing}</Keyed>
      </article>
      <div className="rt-talk">
        {/* The composer on it: its agent, told which routine (routine-threads.ts). */}
        <Keyed k="compose">
          {talks ? (
            <Composer
              agent={id}
              routine={`${id}/${job}`}
              box={r.status === "error" ? `Ask ${name} why it fails, or to change it…` : `Ask ${name} to change it, or about it…`}
              onStarted={reload}
            />
          ) : null}
        </Keyed>
        <Keyed k="threads">
          <RoutineThreadsCard threads={data.threads} />
        </Keyed>
      </div>
      <article className="card post post--full rt-body">
        <Keyed k="what">
          {what ? (
            <>
              <p className="sec-h">{told || "What it does"}</p>
              {what}
            </>
          ) : null}
        </Keyed>
        <Keyed k="runs">
          <p className="sec-h">
            Runs <span className="muted">{data.total ?? runs.length}</span>
          </p>
          {runs.length ? (
            <ul className="runs">
              {runs.map((run) => (
                <RunRow key={run.id} r={r} run={run} url={routineWhereUrl(id, job)} />
              ))}
            </ul>
          ) : (
            <p className="muted">It hasn't run yet.{r.next ? ` Its first run is ${fromNow(r.next)}.` : ""}</p>
          )}
          {more ? (
            <button className="btn btn--line btn--sm runs-more" type="button" onClick={onOlder}>
              Show older runs
            </button>
          ) : null}
        </Keyed>
      </article>
    </>
  );
}

// A run: when, how long, how it went, and what it reported. One whose session is a post opens it; another opens in
// place to the steps it took and its whole reply.
function RunRow({ r, run, url }: { r: AgentCron; run: Run; url: string }) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<CronRunRead | null>(null);
  const said = String(run.error || run.summary || (run.status === "skipped" ? "Skipped" : "")).replace(/\*\*|__|`/g, "");
  const sentTo = r.delivery?.channel && r.delivery.channel !== "last" ? ` to ${r.delivery.channel[0].toUpperCase()}${r.delivery.channel.slice(1)}` : "";
  const meta = [
    run.took != null ? dur(run.took) : "",
    run.delivered === "delivered" ? `sent${sentTo}` : "",
    run.manual ? "run by hand" : "",
    run.unread ? "not read yet" : "",
    run.n ? `run ${run.n}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const head = (
    <>
      <span className={`rt-dot rt-dot--${run.status || "none"}`} />
      <span className="run-when">
        <b>{dayTime(run.at)}</b>
        {meta ? <small>{meta}</small> : null}
      </span>
      <span className={`run-sum${run.error ? " is-err" : ""}`}>{said}</span>
    </>
  );
  if (run.post)
    return (
      <li>
        <a className="run-head" href={`#/threads/${encodeURIComponent(run.post)}`}>
          {head}
          <span className="run-go">
            <Icon name="next" />
          </span>
        </a>
      </li>
    );
  if (!run.session)
    return (
      <li>
        <div className="run-head">{head}</div>
      </li>
    );
  // Open, it reads what its session did, once (again after it failed to).
  const toggle = async () => {
    setOpen(!open);
    if (open || (read && !read.error)) return;
    setRead({ loading: true });
    const res = await fetch(`${url}/run?session=${encodeURIComponent(run.session)}`).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    setRead(res?.ok ? d : { error: res?.status === 404 ? "OpenClaw no longer has what this run did." : d.error || `Couldn't get it (HTTP ${res?.status})` });
  };
  return (
    <li className={open ? "is-open" : ""}>
      <button className="run-head" type="button" aria-expanded={open} onClick={toggle}>
        {head}
        <span className="run-go">
          <Icon name="caret" />
        </span>
      </button>
      {open ? (
        <div className="run-body">
          <RunBody run={run} d={read} />
        </div>
      ) : null}
    </li>
  );
}
// What a run did: its steps, what it said last (or what it reported, all there is once its session is gone, or how
// it failed), and a link to it on claude.ai.
function RunBody({ run, d }: { run: Run; d: CronRunRead | null }) {
  if (!d || d.loading) return <p className="muted">Loading…</p>;
  if (d.error) return <p className="muted">{d.error}</p>;
  const steps = (d.steps || []).filter((st) => st.kind === "tool");
  const said = d.reply?.text || run.summary;
  return (
    <>
      {steps.length ? (
        <ol className="steps">
          {steps.map((st, i) => (
            <li key={i} className={st.error ? "err" : ""}>
              <span>
                {st.title}
                {st.error ? <small>{st.error}</small> : null}
              </span>
              {st.at ? <time>{clock(st.at)}</time> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {said ? (
        <Markdown className="md run-reply" text={said} />
      ) : run.error ? (
        <p className="run-fail">{run.error}</p>
      ) : (
        <p className="muted">It said nothing.</p>
      )}
      {d.gone ? <p className="muted rt-note">OpenClaw no longer has the steps it took{said ? ", only what it reported" : ""}.</p> : null}
      {d.url ? (
        <a className="run-open" href={d.url} target="_blank" rel="noopener">
          <Icon name="external" />
          Open it on claude.ai
        </a>
      ) : null}
    </>
  );
}

// The rail: its agent, when it runs and ran, where its runs happen and where their results go (as each kind of
// routine says it), its model, since when; and Run now, Pause or Resume, Stop, and opening it where it lives.
function About({ id, job, r, reload }: { id: string; job: string; r: AgentCron; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const inactive = inactiveAgent(useAgent(id));
  const rows = useApp((s) => s.rows);
  const postLink = (pid: string) => (rows[pid] ? <a href={`#/threads/${encodeURIComponent(pid)}`}>{rows[pid].title}</a> : pid);
  const base = (p: string) => String(p).split("/").filter(Boolean).pop() || p;
  // Where its runs happen and where their results go, as each kind of routine says it.
  let place = null;
  if (r.target !== undefined) {
    const goes = !r.delivery
      ? "Nowhere: they stay in OpenClaw"
      : r.delivery.mode === "webhook"
        ? "A webhook"
        : r.delivery.channel && r.delivery.channel !== "last"
          ? `${r.delivery.channel[0].toUpperCase()}${r.delivery.channel.slice(1)}${r.delivery.to ? `, ${r.delivery.to}` : ""}`
          : "Where it last talked to you";
    const target = r.target.startsWith("session:") ? r.target.slice(8) : null;
    const where = r.post
      ? postLink(r.post)
      : target
        ? postLink(target)
        : r.target === "main"
          ? "Its main session"
          : r.target === "current"
            ? "The session it was made in"
            : "A session of its own, each time";
    place = (
      <>
        <dt>Results</dt>
        <dd title={goes}>{goes}</dd>
        <dt>In</dt>
        <dd>{where}</dd>
      </>
    );
  } else if (r.group === "cloud") {
    const p = r.place || {};
    place = (
      <>
        <dt>Where</dt>
        <dd>
          {p.cowork ? "The Claude app (Cowork)" : "Claude Code on the web"}
          {p.device ? `, using ${p.device}` : ""}
        </dd>
        {p.repos?.length ? (
          <>
            <dt>Repos</dt>
            <dd>{p.repos.join(", ")}</dd>
          </>
        ) : null}
        {p.folders?.length ? (
          <>
            <dt>Folders</dt>
            <dd title={p.folders.join("\n")}>{p.folders.map(base).join(", ")}</dd>
          </>
        ) : null}
        <dt>Each run</dt>
        <dd>A session on claude.ai</dd>
      </>
    );
  } else if (r.agent === "codex") {
    const p = r.place || {};
    place = (
      <>
        <dt>Where</dt>
        <dd>The ChatGPT app, while it's open</dd>
        {r.thread ? (
          <>
            <dt>In</dt>
            <dd>{r.post ? postLink(r.post) : "One of its threads"}</dd>
          </>
        ) : (
          <>
            {p.cwds?.length ? (
              <>
                <dt>In</dt>
                <dd title={p.cwds.join("\n")}>
                  {p.cwds.map(base).join(", ")}
                  {p.worktree ? ", in a worktree" : ""}
                </dd>
              </>
            ) : null}
            <dt>Each run</dt>
            <dd>A thread of its own</dd>
          </>
        )}
      </>
    );
  } else if (r.group === "loop" && r.post)
    place = (
      <>
        <dt>In</dt>
        <dd>{postLink(r.post)}</dd>
      </>
    );
  const acts = r.acts || ["run", "pause"];
  // Run now, Pause, Resume, Stop: asked of its driver, the page read again after.
  const act = async (what: string) => {
    setBusy(what);
    const res = await post(routineWhereUrl(id, job), { action: what });
    setBusy(null);
    if (res.ok)
      toast(
        what === "run"
          ? "It's running. Its run shows here when it's done."
          : what === "pause"
            ? "Paused. It won't run until you resume it."
            : what === "stop"
              ? "Asked it to stop the loop."
              : "Resumed.",
      );
    await reload();
  };
  const buttons = (
    <>
      {acts.includes("run") ? (
        <button className="btn btn--dark" type="button" disabled={!!busy || inactive} title={inactive ? "Activate this agent to start new threads." : undefined} onClick={() => act("run")}>
          <Icon name="play" />
          {busy === "run" ? "Starting…" : "Run now"}
        </button>
      ) : null}
      {acts.includes("pause") ? (
        <button className="btn btn--line" type="button" disabled={!!busy || (!r.enabled && inactive)} title={!r.enabled && inactive ? "Activate this agent before resuming its schedule." : undefined} onClick={() => act(r.enabled ? "pause" : "resume")}>
          <Icon name={r.enabled ? "pause" : "repeat"} />
          {r.enabled ? "Pause" : "Resume"}
        </button>
      ) : null}
      {acts.includes("stop") ? (
        <button className="btn btn--line" type="button" disabled={!!busy} onClick={() => act("stop")}>
          <Icon name="stop" />
          Stop
        </button>
      ) : null}
      {r.url ? (
        <a className="btn btn--line" href={r.url} target="_blank" rel="noopener">
          <Icon name="external" />
          {r.url.startsWith("codex:") ? "Open in Codex" : "Open on claude.ai"}
        </a>
      ) : null}
    </>
  );
  const anyButton = acts.includes("run") || acts.includes("pause") || acts.includes("stop") || !!r.url;
  return (
    <section className="card rail-card">
      <h3 className="rail-h">About this routine</h3>
      <dl className="kv">
        <dt>Agent</dt>
        <dd>
          <a href={agentHref(id, "routines")}>
            <b>{agentName(id)}</b>
          </a>
        </dd>
        <dt>Runs</dt>
        <dd title={r.schedule?.expr || ""}>{scheduleWords(r.schedule)}</dd>
        {r.enabled && r.next ? (
          <>
            <dt>Next</dt>
            <dd>{dayTime(r.next)}</dd>
          </>
        ) : null}
        {r.last ? (
          <>
            <dt>Last</dt>
            <dd>
              {dayTime(r.last)}
              {r.took != null ? `, ${dur(r.took)}` : ""}
            </dd>
          </>
        ) : null}
        {place}
        {r.model ? (
          <>
            <dt>Model</dt>
            <dd>
              {model(r.model.split("/").pop())}
              {r.effort ? `, ${r.effort}` : ""}
            </dd>
          </>
        ) : null}
        {r.created ? (
          <>
            <dt>Since</dt>
            <dd>{new Date(r.created).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</dd>
          </>
        ) : null}
      </dl>
      {anyButton ? <div className="rt-acts">{buttons}</div> : null}
      {r.agent === "codex" ? <p className="muted rt-note">Run now and Pause are in the app.</p> : null}
    </section>
  );
}
