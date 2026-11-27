// New routine, and changing one: its name and prompt, when it runs, what it's linked to, where each run goes and who
// runs it. Linked to a page, a new routine can be code an agent writes for it instead. What's typed is kept in the
// routines store (useRoutineUi's `form`), so it stays as the page redraws.
import { useState } from "react";
import type { ReactNode } from "react";
import { agentName, DEFAULT_KIND, fromNow, machineOf, workspaces } from "../../lib/agents.ts";
import { go, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { RoutineLink } from "../../../plugin/shared/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { launchForPage, onPageMachine, pageWriters } from "../pages/pages.ts";
import { LinkChip } from "./parts.tsx";
import { bumpRoutines, formScheduleWords, routineAgents, RT_HOWS, scheduleOfForm, setForm, setRoutineUi, shortPath, useRoutineUi, WEEKDAYS } from "./routines.ts";

export function RoutineFormView({ machine }: { machine?: string } = {}) {
  const f = useRoutineUi((s) => s.form);
  const err = useRoutineUi((s) => s.err);
  const data = useApp((s) => s.data);
  const rows = useApp((s) => s.rows);
  const route = useRoute();
  const [busy, setBusy] = useState(false);
  if (!f) return null;
  const editing = !!f.rid;
  const agents = routineAgents().filter(a => !machine || a.machine === machine);
  const folderMachine = agents.find(a => a.id === f.agent)?.machine || machine || data.machine;
  const folders = [...new Set([...(data.folders || []).filter((x) => machineOf(x) === folderMachine).map((x) => x.root), ...workspaces().flatMap((w) => (w.checkouts || []).filter((c) => c.machine === folderMachine).map((c) => c.root))].filter(Boolean))].slice(0, 40);
  const linked = (kind: string, id: string) => f.links.some((l) => l.kind === kind && l.id === id);
  const pages = (data.pages || []).filter((p) => p.mine && !p.archived && !linked("page", p.id));
  const threads = Object.values(rows)
    .filter((s) => s.mine !== false && !s.archived && !linked("thread", s.id))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.pinned_at || "").localeCompare(a.pinned_at || "") || b.started.localeCompare(a.started))
    .slice(0, 40);
  const linkedThreads = f.links.filter((l) => l.kind === "thread");
  const into = f.into && linkedThreads.some((l) => l.id === f.into) ? f.into : "";
  const title = (id: string) => rows[id]?.title;
  const pill = (name: "kind" | "how", value: string, label: ReactNode, on: boolean) => (
    <button key={value} className={`pill${on ? " is-on" : ""}`} type="button" onClick={() => setForm({ [name]: value })}>
      {label}
    </button>
  );
  const time = (
    <label className="rtf-mini">
      <span>at</span>
      <input type="time" name="time" value={f.time} onChange={(e) => setForm({ time: e.target.value })} />
    </label>
  );
  const when = {
    daily: time,
    weekdays: (
      <>
        {time}
        <small>Monday to Friday</small>
      </>
    ),
    weekly: (
      <>
        <label className="rtf-mini">
          <span>on</span>
          <select name="day" value={String(f.day)} onChange={(e) => setForm({ day: e.target.value })}>
            {WEEKDAYS.map((d, i) => (
              <option key={i} value={String(i)}>
                {d}
              </option>
            ))}
          </select>
        </label>
        {time}
      </>
    ),
    every: (
      <label className="rtf-mini">
        <span>every</span>
        <select name="every" value={String(f.every)} onChange={(e) => setForm({ every: e.target.value })}>
          {["5", "10", "15", "30", "60", "120", "240", "360", "720"].map((n) => (
            <option key={n} value={n}>
              {Number(n) < 60 ? `${n} minutes` : `${Number(n) / 60} hour${n === "60" ? "" : "s"}`}
            </option>
          ))}
        </select>
      </label>
    ),
    cron: (
      <label className="rtf-mini">
        <span>cron</span>
        <input name="expr" value={f.expr || ""} spellCheck={false} onChange={(e) => setForm({ expr: e.target.value })} />
      </label>
    ),
    hourly: <small>On the hour</small>,
    manual: <small>Only when you press Run</small>,
  }[f.how];
  const cancel = () => {
    setRoutineUi({ form: null, err: "" });
    if (route.name === "routines" && route.form) go("#/routines");
  };
  // Linked to a page, a new routine can be code an agent writes for it instead: it keeps the page's numbers fresh
  // with no model, and the agent's code waits for your OK before it runs.
  const page = !editing && (data.pages || []).find((p) => f.links.some((l) => l.kind === "page" && l.id === p.id));
  const kinds = page ? (
    <div className="rtf-kinds">
      {pill(
        "kind",
        "agent",
        <>
          <Icon name="comment" />
          An agent, with a prompt
        </>,
        f.kind !== "code",
      )}
      {pill(
        "kind",
        "code",
        <>
          <b>&lt;/&gt;</b>Code, with no model
        </>,
        f.kind === "code",
      )}
    </div>
  ) : null;
  const errLine = (
    <p className="auth-err" hidden={!err}>
      {err}
    </p>
  );
  if (page && f.kind === "code") {
    const writers = pageWriters();
    // The agent that made the page writes its code, unless you pick another; else this machine's Claude (DEFAULT_KIND).
    const writer = (writers.find((a) => a.id === f.writer) || writers.find((a) => a.id === onPageMachine(page, page.by?.agent)) || writers.find((a) => a.kind === DEFAULT_KIND) || writers[0])?.id || "";
    const submit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!writer) return;
      const schedule = scheduleOfForm(f);
      const prompt = `Keep the page "${page.title}" up to date ${formScheduleWords(f)} with a routine (schedule: "${schedule}"). Read it with ab_page_read. Write a routine with ab_routine_write for everything a program can fetch (numbers, series, tables, statuses), calling the same tools you'd use yourself, and test it with test: true until the numbers it returns are right. Then save it once: I OK it on the page before it runs. Say in cant_keep which widgets code can't keep, and why.`;
      setBusy(true);
      if (await launchForPage(page, writer, prompt, `Asked ${agentName(writer)} to write it. Its routine waits for your OK on the page's Routines tab.`)) setRoutineUi({ form: null });
      setBusy(false);
    };
    return (
      <section className="rtf">
        <form className="rtf-form" onSubmit={submit}>
          <div className="rtf-top">
            <h2>New routine</h2>
          </div>
          {kinds}
          <p className="rtf-lede">
            An agent writes code that fetches the numbers on <b>{page.title}</b> on a schedule, with no model, and tests it. You see what it reaches and its test run, and OK it before it runs. What needs judgment stays with an agent routine.
          </p>
          <dl className="rtf-grid">
            <dt>When</dt>
            <dd>
              <div className="rtf-pills">{RT_HOWS.filter(([v]) => v !== "manual").map(([v, l]) => pill("how", v, l, f.how === v))}</div>
              {when ? <div className="rtf-when">{when}</div> : null}
            </dd>
            <dt>Written by</dt>
            <dd>
              {writers.length ? (
                <select name="writer" aria-label="Who writes it" value={writer} onChange={(e) => setForm({ writer: e.target.value })}>
                  {writers.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="rtf-fixed muted">No agent that can write pages is online.</p>
              )}
            </dd>
          </dl>
          {errLine}
          <div className="rtf-foot">
            <small>Its code runs on {data.machine || "this machine"}, while agentbook runs there.</small>
            <button className="btn btn--line" type="button" onClick={cancel}>
              Cancel
            </button>
            <button className="btn btn--dark" type="submit" disabled={!writers.length || busy}>
              Ask {agentName(writer || writers[0]?.id) || "it"} to write it
            </button>
          </div>
        </form>
      </section>
    );
  }
  const runsAs = into ? rows[into]?.agent : f.agent;
  const where = into ? (
    <p className="rtf-fixed">
      <Avatar agent={runsAs} size="av--xs" />
      <span>
        <b>{agentName(runsAs) || "Its agent"}</b>, in that thread
      </span>
    </p>
  ) : (
    <div className="rtf-row">
      <select name="agent" aria-label="Agent" value={f.agent} onChange={(e) => setForm({ agent: e.target.value })}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <input name="root" value={f.root} list="rtf-folders" placeholder={f.links.some((l) => l.kind === "page") ? "Folder: where its page's threads work" : `Folder: ${shortPath(data.home || "~")}`} aria-label="Folder" spellCheck={false} autoComplete="off" onChange={(e) => setForm({ root: e.target.value })} />
      <datalist id="rtf-folders">
        {folders.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
    </div>
  );
  const adder =
    pages.length || threads.length ? (
      <select
        className="rtf-add"
        aria-label="Link a page or a thread"
        value=""
        onChange={(e) => {
          const [kind, ...rest] = e.target.value.split(":");
          if (kind) setForm({ links: [...f.links, { kind: kind as RoutineLink["kind"], id: rest.join(":") }] });
        }}
      >
        <option value="">+ Link a page or thread</option>
        {pages.length ? (
          <optgroup label="Pages">
            {pages.map((p) => (
              <option key={p.id} value={`page:${p.id}`}>
                {`${p.emoji ? `${p.emoji} ` : ""}${p.title}`}
              </option>
            ))}
          </optgroup>
        ) : null}
        {threads.length ? (
          <optgroup label="Threads">
            {threads.map((s) => (
              <option key={s.id} value={`thread:${s.id}`}>
                {`${s.title || "New thread"} (${s.label})`}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    ) : null;
  const unlink = (i: number) => {
    const gone = f.links[i];
    setForm({ links: f.links.filter((_, k) => k !== i), ...(gone?.kind === "thread" && gone.id === f.into ? { into: "" } : {}) });
  };
  // Make it, or save the change: what the server says is wrong shows above the buttons.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { name: f.name.trim(), prompt: f.prompt.trim(), schedule: scheduleOfForm(f), links: f.links, thread: into || null };
    if (!into) Object.assign(body, { agent: f.agent, root: f.root.trim().replace(/^~(?=\/|$)/, data.home || "~") });
    setBusy(true);
    const res = await fetch(f.rid ? `/api/routines/${encodeURIComponent(f.rid)}` : "/api/routines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setRoutineUi({ err: out.error || `Something went wrong (HTTP ${res.status})` });
    setRoutineUi({ form: null, err: "" });
    toast(f.rid ? "Saved. Its next run uses it." : `Made ${out.name}. ${out.next ? `Its first run is ${fromNow(out.next)}.` : "It runs when you press Run."}`);
    if (f.rid || route.name === "page") bumpRoutines();
    else go(`#/routines/${encodeURIComponent(out.id)}`);
  };
  return (
    <section className="rtf">
      <form className="rtf-form" onSubmit={submit}>
        <div className="rtf-top">
          <h2>{editing ? "Change it" : "New routine"}</h2>
        </div>
        {kinds}
        <input className="rtf-name" name="name" value={f.name} placeholder="Name it: Morning digest" maxLength={80} autoComplete="off" required aria-label="Name" autoFocus={!editing} onChange={(e) => setForm({ name: e.target.value })} />
        <textarea className="rtf-prompt" name="prompt" rows={4} placeholder="What should its agent do each time? Read what my agents did yesterday and post a short digest: what shipped, what's stuck, what needs me." required aria-label="What to do" value={f.prompt} onChange={(e) => setForm({ prompt: e.target.value })} />
        <dl className="rtf-grid">
          <dt>When</dt>
          <dd>
            <div className="rtf-pills">
              {RT_HOWS.map(([v, l]) => pill("how", v, l, f.how === v))}
              {f.how === "cron" ? pill("how", "cron", "Cron", true) : null}
            </div>
            {when ? <div className="rtf-when">{when}</div> : null}
          </dd>
          <dt>Linked to</dt>
          <dd>
            <div className="rtf-links">
              {f.links.map((l, i) => (
                <LinkChip key={`${l.kind}:${l.id}`} link={l} onUnlink={() => unlink(i)} />
              ))}
              {adder}
            </div>
            <small className="rtf-help">Each page and thread shows it, and each run is told about them.</small>
          </dd>
          <dt>Each run</dt>
          <dd>
            <select name="into" aria-label="Where each run goes" value={into} onChange={(e) => setForm({ into: e.target.value })}>
              <option value="">Starts a new thread</option>
              {linkedThreads.map((l) => (
                <option key={l.id} value={l.id}>
                  {`Continues “${title(l.id) || "a thread"}”`}
                </option>
              ))}
            </select>
            {linkedThreads.length ? null : <small className="rtf-help">Link a thread to continue it instead.</small>}
          </dd>
          <dt>Runs as</dt>
          <dd>{where}</dd>
        </dl>
        {errLine}
        <div className="rtf-foot">
          <small>Runs on {data.machine || "this machine"}, while agentbook runs there.</small>
          <button className="btn btn--line" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn--dark" type="submit" disabled={busy}>
            {editing ? "Save" : "Make routine"}
          </button>
        </div>
      </form>
    </section>
  );
}
