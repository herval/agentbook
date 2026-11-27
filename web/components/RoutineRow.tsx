// An agent's routines: what it does on a schedule. An OpenClaw agent's are its cron jobs, Claude's are its routines on
// claude.ai and the loops its posts run (/loop), Codex's are the ChatGPT app's automations. Its profile lists them,
// and each has a page with its runs, which stay off the feed: each opens in place to what it did. A loop lives in its
// post, so it opens its post. (app.ts routineRow and routineChip.)
import { routineWhen } from "../lib/agents.ts";
import { agoText, plural } from "../lib/format.ts";
import { useThreadRow } from "../lib/store.ts";
import type { AgentCron } from "../lib/types.ts";
import { routineLink } from "./routines/routines.ts";
import { Icon } from "./Icon.tsx";

// How a routine stands, when that's worth a chip: running, paused, or its last run failed.
export function RoutineChip({ routine: r }: { routine: AgentCron }) {
  if (r.running)
    return (
      <span className="chip chip--live">
        <i className="pulse" />
        Running
      </span>
    );
  if (!r.enabled) return <span className="chip">Paused</span>;
  if (r.status === "error") return <span className="chip chip--bad">{r.failing > 1 ? `Failed ${r.failing} times in a row` : "Last run failed"}</span>;
  return null;
}
// A routine or loop as a row: its name, how it stands, when it last ran, when it runs, and what it does.
export function RoutineRow({ agent, routine: r }: { agent: string; routine: AgentCron }) {
  const inThread = useThreadRow(r.group === "loop" ? r.post : null);
  const runs = (r as AgentCron & { runs?: number | null }).runs;
  const last = r.group === "loop" && runs != null ? (runs ? `Ran ${plural(runs, "time")}` : "Hasn't run yet") : r.last ? `Ran ${agoText(r.last)}` : "Hasn't run yet";
  const inPost = r.group === "loop" && r.post ? ` · in “${inThread?.title || "a thread"}”` : "";
  // A loop's name is the start of its prompt: under it, the rest.
  const what = r.what && r.what !== r.name ? r.what : "";
  const loopWhat = r.group === "loop" ? what.replace(/^\/loop\s+/, "") : "";
  const rest = loopWhat.startsWith(r.name) ? loopWhat.slice(r.name.length).replace(/^[.!?:]?\s*/, "") : what;
  return (
    <li>
      <a className="skill" href={routineLink(agent, r)}>
        <span className={`skill-ico${r.enabled ? "" : " skill-ico--off"}`}>
          <Icon name="repeat" />
        </span>
        <div>
          <p className="rt-title">
            <b>{r.name}</b>
            <RoutineChip routine={r} />
            <span className="skill-used">{last}</span>
          </p>
          <small>{routineWhen(r) + inPost}</small>
          {rest ? <small className="rt-what">{rest}</small> : null}
        </div>
        <span className="skill-go">
          <Icon name="back" />
        </span>
      </a>
    </li>
  );
}
