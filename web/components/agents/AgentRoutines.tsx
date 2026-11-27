// An agent's routines: what it does on a schedule. An OpenClaw agent's are its cron jobs, Claude's are its routines on
// claude.ai and the loops its threads run (/loop), Codex's are the ChatGPT app's automations. Its profile lists them
// (its Routines tab, and a card on its About), and each has a page with its runs.
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { agentName, fromNow, routineWhen } from "../../lib/agents.ts";
import { agentHref } from "../../lib/route.ts";
import type { AgentCron, CronJobs } from "../../lib/types.ts";
import { isRuntimeId, type RuntimeId } from "../../../plugin/shared/runtimes.ts";
import { Icon } from "../Icon.tsx";
import { RoutineRow } from "../RoutineRow.tsx";
import type { AgentRow } from "./types.ts";

const routineLink = (agentId: string, r: AgentCron) => (r.group === "loop" && r.post ? `#/threads/${encodeURIComponent(r.post)}` : r.group === "loop" && r.url ? r.url : `#/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(r.id)}`);

export function RoutinesCard({ agent: a, routines }: { agent: AgentRow; routines: CronJobs | null }) {
  const list = (routines?.routines || []).filter((r) => !r.builtin);
  const rank = (r: AgentCron) => (r.enabled && r.status === "error" ? 0 : r.enabled ? 1 : 2);
  const shown = [...list].sort((x, y) => rank(x) - rank(y) || (x.next || "~").localeCompare(y.next || "~")).slice(0, 4);
  return (
    <section className="card box">
      <h3>
        Routines <a href={agentHref(a.id, "routines")}>See all</a>
      </h3>
      {shown.length ? (
        <ul className="rt-mini">
          {shown.map((r) => (
            <li key={r.id}>
              <a href={routineLink(a.id, r)}>
                <span className={`rt-dot rt-dot--${r.running ? "run" : !r.enabled ? "off" : r.status || (r.group === "loop" ? "ok" : "none")}`} />
                <span>
                  <b title={r.name}>{r.name}</b>
                  <small>{r.enabled ? routineWhen(r) : "Paused"}</small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        a.routines?.next && <p className="muted">Next run {fromNow(a.routines.next)}.</p>
      )}
      {list.length > shown.length && <p className="muted rt-more">and {list.length - shown.length} more</p>}
    </section>
  );
}

// Its Routines tab: in groups (OpenClaw's cron jobs, loops in threads, Claude's routines on claude.ai, and Codex's
// automations), and OpenClaw's own upkeep folded under them.
export function RoutinesTab({ agent: a, routines }: { agent: AgentRow; routines: CronJobs | null }) {
  const [upkeepOpen, setUpkeep] = useState(false);
  const id = a.id;
  const list = routines?.routines;
  const upkeep = (list || []).filter((r) => r.builtin);
  const name = agentName(id);
  // What its routines are, and how one is made, are its runtime's own scheduler's (claude.ai's routines, the ChatGPT
  // app's automations, OpenClaw's cron jobs), so these words go by which runtime it is (shared/runtimes.ts).
  const rt: RuntimeId | null = isRuntimeId(a.kind) ? a.kind : null;
  const groups: [string | null, ReactNode, ReactNode?][] = [
    [null, `What ${name} does on a schedule. Each routine's page has its runs.`],
    [
      "loop",
      "Loops",
      rt === "codex" ? (
        "Prompts the ChatGPT app sends into one thread again and again."
      ) : (
        <>
          Prompts its threads run again and again (<code>/loop</code>), each in its thread, while that thread is awake.
        </>
      ),
    ],
    ["cloud", "On claude.ai", "What Claude runs on a schedule on claude.ai: in Claude Code on the web, or in the Claude app. Each routine's page has its runs."],
    ["codex", "Automations", "What the ChatGPT app's Codex runs on a schedule, while the app is open. Each one's page has its runs."],
  ];
  const sections = (list || []).length
    ? groups.map(([g, h, note]) => {
        const rows = list.filter((r) => !r.builtin && (r.group || null) === g);
        if (!rows.length) return null;
        return (
          <Fragment key={g || "own"}>
            {note !== undefined ? (
              <>
                <p className="sec-h">
                  {h} <span className="muted">{rows.length}</span>
                </p>
                <p className="muted skills-note">{note}</p>
              </>
            ) : (
              <p className="muted skills-note">{h}</p>
            )}
            <ul className="skills">
              {rows.map((r) => (
                <RoutineRow key={r.id} agent={id} routine={r} />
              ))}
            </ul>
          </Fragment>
        );
      })
    : [];
  const none =
    {
      openclaw: (
        <>
          No routines yet. Ask {name} for one in a thread (“every weekday at 8, send me…”), or add one with <code>openclaw cron add</code>.
        </>
      ),
      "claude-code": (
        <>
          No routines yet. Ask {name} for one in a thread: <code>/schedule</code> makes one on claude.ai (“every weekday at 8, review…”), and <code>/loop</code> keeps a thread at something (“/loop 10m check the deploy”).
        </>
      ),
      codex: "No automations yet. Make one in the ChatGPT app's Codex, under Automations.",
    }[rt] || "No routines yet.";
  const error = routines?.error ? (
    <p className="muted rt-err">
      <Icon name="cloud" />
      Couldn't read its routines on claude.ai: {routines.error}
    </p>
  ) : null;
  const any = sections.some(Boolean);
  return (
    <div>
      <section className="card box">
        <h3>Routines</h3>
        {!list ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {error}
            {any ? sections : <p className="muted">{none}</p>}
          </>
        )}
        {upkeep.length > 0 && (
          <>
            <button className="rt-upkeep" type="button" aria-expanded={upkeepOpen} onClick={() => setUpkeep(!upkeepOpen)}>
              <Icon name="caret" />
              OpenClaw's own upkeep<span className="muted">{upkeep.length}</span>
            </button>
            {upkeepOpen && (
              <ul className="skills">
                {upkeep.map((r) => (
                  <RoutineRow key={r.id} agent={id} routine={r} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
