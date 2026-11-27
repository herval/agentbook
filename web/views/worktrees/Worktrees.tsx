// Every worktree, on one page (#/worktrees): every pull request and branch your threads worked on, and every
// worktree in your projects' folders: one list, what to do next first, each row saying its workspace and the task
// it's on; or as a timeline, one for each project.
import { onGitHub } from "../../lib/agents.ts";
import { webUrl } from "../../lib/format.ts";
import { connectorsHref, go, NO_SCOPE, scopeHref, useRoute } from "../../lib/route.ts";
import { Icon } from "../../components/Icon.tsx";
import { ScopeBar } from "../../components/ScopeBar.tsx";
import { Shell } from "../../components/Shell.tsx";
import { inScope, scopeSet } from "../../components/tasks/tasks.ts";
import { TlGroup, useWorktreesView, WorktreesSeg } from "../../components/worktrees/Timeline.tsx";
import { useWipClear, WipDoneFold, WipListRow } from "../../components/worktrees/WipRow.tsx";
import { ghNote, useWorld, WIP_FILTERS, wipGroups, wipOrder, worktreesLens, type Ws } from "../../components/worktrees/wips.ts";

// After the note under a workspace, when agentbook's GitHub App is why GitHub won't show its repo: where on GitHub
// to fix it.
function GhFix({ ws }: { ws: Ws }) {
  const f = ws?.pulls?.error && !ws.pulls.pulls.length && ws.pulls.fix;
  if (!f || !webUrl(f.url)) return null;
  return (
    <>
      {" "}
      <a href={f.url} target="_blank" rel="noopener">
        {f.label}
      </a>
    </>
  );
}

export function Worktrees() {
  const data = useWorld();
  const route = useRoute();
  const [view] = useWorktreesView();
  const clear = useWipClear((s) => !!s.open.wt);
  const scope = route.scope || NO_SCOPE;
  const groups = wipGroups();
  const all = groups.flatMap((g) => g.list);
  const f = WIP_FILTERS.find(([k]) => k === route.status) || WIP_FILTERS[0];
  const narrowed = scopeSet(scope);
  // Each project's worktrees come a moment after the rest, the first time: git is read in the background.
  const reading = (data?.folders || []).some((x) => x.sessions && !("wip" in x));
  const tl = view === "timeline";
  const shows = (x) => f[2](x) && inScope(worktreesLens.of, x, scope);
  // GitHub being read, or out of reach, for a workspace on it; and connecting it, when none is.
  const notes = narrowed
    ? []
    : groups
        .filter((g) => ghNote(g.ws))
        .map((g) => (
          <p key={g.key} className={`wl-note${g.ws.pulls?.error ? " wl-err" : ""}`} title={g.ws.pulls?.error || ""}>
            <Icon name={g.ws.pulls?.error ? "alert" : "clock"} />
            <span>
              <b>{g.name}</b> {ghNote(g.ws)}
              <GhFix ws={g.ws} />
            </span>
          </p>
        ));
  if (!data?.github && groups.some((g) => onGitHub(g.ws)))
    notes.push(
      <p key="gh" className="wl-note">
        <Icon name="pr" />
        <span>
          <a href={connectorsHref()}>Connect GitHub</a> to see your branches' pull requests here.
        </span>
      </p>,
    );
  let body = null;
  let has = false;
  if (tl) {
    const lists = groups.map((g) => ({ g, list: g.list.filter(shows), open: g.list.filter((x) => x.state !== "clear").length }));
    has = lists.some((l) => l.list.length);
    body = lists.map(({ g, list, open }) => <TlGroup key={g.key} g={g} list={list} open={open} />);
  } else {
    const list = all.filter(shows).sort(wipOrder);
    const done = f[0] === "open" ? all.filter((x) => x.state === "clear" && inScope(worktreesLens.of, x, scope)).sort(wipOrder) : [];
    const rows = [...list, ...(clear ? done : [])];
    has = !!(list.length || done.length);
    body = has ? (
      <>
        {rows.length ? (
          <ul className="wl-list">
            {rows.map((x) => (
              <WipListRow key={x.id} x={x} task />
            ))}
          </ul>
        ) : null}
        <WipDoneFold k="wt" n={done.length} />
      </>
    ) : null;
  }
  const empty = !all.length ? (
    <p className="muted wl-empty">{reading ? "Reading git…" : "Nothing on a branch. Every branch a thread works on, and every worktree in your projects' folders, shows up here until everything on it is on main."}</p>
  ) : !has ? (
    <p className="muted wl-empty">
      {narrowed ? (
        <>
          None match.{" "}
          <button className="link-btn" type="button" onClick={() => go(scopeHref("worktrees"))}>
            Clear the filters
          </button>
        </>
      ) : f[0] === "open" ? (
        "Nothing open: all of it landed."
      ) : (
        "None right now."
      )}
    </p>
  ) : null;
  return (
    <Shell className="shell wips-shell">
      <section className={`card wips${tl ? " wips--tl" : ""}`}>
        <ScopeBar
          name="worktrees"
          title="Worktrees"
          h1
          sticky
          acts={
            <>
              {reading && all.length ? <span className="muted lh-note">Reading git…</span> : null}
              <WorktreesSeg />
            </>
          }
        />
        {notes}
        {body}
        {empty}
      </section>
    </Shell>
  );
}
