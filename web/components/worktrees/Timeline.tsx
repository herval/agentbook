// The Worktrees page as a timeline: each project's main branch down the middle, and
// each worktree off the commit it left it at. Also an agent's Worktrees tab's (TlGroup), and List or Timeline
// (WorktreesSeg) for both.
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { listVerb, many, wsWhere } from "../../lib/agents.ts";
import { ago, clock, hueVars, plural } from "../../lib/format.ts";
import { usePref } from "../../lib/hooks.ts";
import { workspaceHref } from "../../lib/route.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { tasksOfPart } from "./ship.ts";
import { baseHeadOf, behindOf, forkOf, prMeta, tilde, wipHref, wipWhy, type Fork, type Wip, type WipGroup } from "./wips.ts";

// List or Timeline, kept in this browser (agentbook.worktreesView, or the older agentbook.wipsView).
export function useWorktreesView(): [string, (v: string) => void] {
  const [old] = usePref("wipsView", "list");
  const [v, set] = usePref("worktreesView", "");
  return [(v || old) === "timeline" ? "timeline" : "list", set];
}
export function WorktreesSeg() {
  const [view, setView] = useWorktreesView();
  return (
    <span className="seg wips-view" role="group" aria-label="Show as">
      {(
        [
          ["list", "steps", "List"],
          ["timeline", "timeline", "Timeline"],
        ] as const
      ).map(([k, ico, label]) => (
        <button key={k} type="button" className={view === k ? "is-on" : ""} aria-pressed={view === k} title={k === "timeline" ? "Each project's main branch down the middle, and each worktree off the commit it left it at" : "One list, what to do next first"} onClick={() => setView(k)}>
          <Icon name={ico} />
          {label}
        </button>
      ))}
    </span>
  );
}

// "Today", "Yesterday", "Fri, Oct 9".
function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400e3);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

// One project's timeline (a group of wipGroups), the Worktrees page's and an agent's Worktrees tab's: its name and
// the branches it goes into, how many of them are open (`open`), and `list` off its main; none when `list` is empty.
export function TlGroup({ g, list, open }: { g: WipGroup; list: Wip[]; open: number }) {
  if (!list.length) return null;
  return (
    <section className="wl-group tl-proj">
      <h2 className="wl-group-h">
        <span className="ico">
          <Icon name={g.ws?.repo ? "repo" : "folder"} />
        </span>
        {g.ws ? (
          <a href={workspaceHref(g.ws.id)} title={wsWhere(g.ws)}>
            {g.name}
          </a>
        ) : (
          <span>{g.name}</span>
        )}
        <small>
          into{" "}
          {[...new Set(list.map((x) => x.base).filter(Boolean))].map((b, i) => (
            <span key={b}>
              {i ? ", " : ""}
              <code>{b}</code>
            </span>
          ))}
        </small>
        {g.ws ? null : (
          <small>
            not a workspace{many() ? `, on ${g.machine}` : ""}
          </small>
        )}
        <span className="wl-n">{plural(open, "branch")} open</span>
      </h2>
      <WipTimelines list={list} all={g.list} />
    </section>
  );
}
// A project's WIP, one timeline for each branch it goes into (a repo's pull requests can go into more than one).
// `all`: the project's WIP the filter left out too, which know its main's latest commit as well.
function WipTimelines({ list, all = list }: { list: Wip[]; all?: Wip[] }) {
  const bases = new Map<string, Wip[]>();
  for (const x of list) bases.set(x.base || "", [...(bases.get(x.base || "") || []), x]);
  return (
    <>
      {[...bases].map(([base, xs]) => (
        <WipTimeline key={base} base={base || "main"} xs={xs} all={all.filter((x) => (x.base || "") === base)} />
      ))}
    </>
  );
}
function WipDot({ w }: { w: Wip }) {
  if (w.kind === "pr" && w.pr.state === "closed")
    return (
      <span className="wip-dot wip-dot--closed">
        <Icon name="x" />
      </span>
    );
  if (w.state === "clear")
    return (
      <span className={`wip-dot${w.kind === "pr" ? " wip-dot--merged" : ""}`}>
        <Icon name="check" />
      </span>
    );
  return (
    <span className="wip-dot">
      <i className={`dot dot--${w.state}${w.stale ? " dot--stale" : ""}`} />
    </span>
  );
}
export { WipDot };

// Main's latest commit on top, then each commit WIP left it at, newest first, with how far behind main it is now
// and the WIP that left there under it, left and right of the line in turn, each a half step below the one before.
function WipTimeline({ base, xs, all = xs }: { base: string; xs: Wip[]; all?: Wip[] }) {
  const tl = useTimelineLines();
  // the newest any of them knows: each checkout of a repo reads its own main
  const head = all
    .map(baseHeadOf)
    .filter((h) => h?.sha)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null;
  const stops = new Map<string, { fork: Fork | null; behind: number | null; list: Wip[] }>();
  for (const x of xs) {
    const f = forkOf(x);
    const key = f?.sha || "";
    if (!stops.has(key)) stops.set(key, { fork: f, behind: null, list: [] });
    const st = stops.get(key);
    st.list.push(x);
    const b = behindOf(x);
    if (f && b != null) st.behind = Math.min(st.behind ?? b, b);
  }
  const known = [...stops.values()].filter((st) => st.fork).sort((a, b) => String(b.fork.at || "").localeCompare(String(a.fork.at || "")) || (a.behind ?? 0) - (b.behind ?? 0));
  const unknown = stops.get("");
  const stop = (key: string, cls: string, subject: string, at: ReactNode) => (
    <div className={`tl-stop${cls}`} key={key}>
      <span className="tl-subj" title={subject}>
        {subject}
      </span>
      <span className="tl-node" />
      <span className="tl-at">{at}</span>
    </div>
  );
  const behind = (n: number | null) =>
    n == null ? null : n ? (
      <span className={`tl-behind${n >= 50 ? " tl-behind--far" : ""}`} title={`${base} moved ${plural(n, "commit")} since`}>
        {n} behind
      </span>
    ) : (
      <span className="tl-behind tl-behind--none">up to date</span>
    );
  let side = 0;
  let day = head?.at ? dayLabel(head.at) : null;
  const cards = (key: string, list: Wip[]) => {
    const el = (
      <div className="tl-cards" key={`c${key}`}>
        {list.map((x, k) => (
          <TlCard key={x.id} x={x} side={(side + k) % 2 ? "r" : "l"} row={k + 1} />
        ))}
      </div>
    );
    side = (side + list.length) % 2;
    return el;
  };
  const out: ReactNode[] = [];
  if (head)
    out.push(
      stop(
        "head",
        " tl-stop--head",
        head.subject,
        <>
          <span className="tl-base">{base}</span>
          <code title={head.sha}>{head.sha.slice(0, 7)}</code>
          {head.at ? clock(head.at) : ""}
        </>,
      ),
    );
  known.forEach((st, i) => {
    if (!(i === 0 && st.fork.sha === head?.sha)) {
      const d = st.fork.at ? dayLabel(st.fork.at) : null;
      if (d && d !== day)
        out.push(
          <div className="tl-day" key={`d${st.fork.sha}`}>
            {d}
          </div>,
        );
      day = d || day;
      out.push(
        stop(
          st.fork.sha,
          "",
          st.fork.subject,
          <>
            <code title={st.fork.sha}>{st.fork.sha.slice(0, 7)}</code>
            {st.fork.at ? hhmm(st.fork.at) : ""}
            {behind(st.behind)}
          </>,
        ),
      );
    }
    out.push(cards(st.fork.sha, st.list));
  });
  if (unknown) {
    out.push(
      stop(
        "unknown",
        " tl-stop--unknown",
        "",
        <span>
          Not known where {unknown.list.length === 1 ? "it" : "these"} left <code>{base}</code>
        </span>,
      ),
    );
    out.push(cards("unknown", unknown.list));
  }
  return (
    <div className="tl" ref={tl}>
      <svg className="tl-lines" aria-hidden="true" />
      {out}
    </div>
  );
}
function TlCard({ x, side, row }: { x: Wip; side: string; row: number }) {
  const s = x.posts.find((p) => p.effective === "needs" || p.effective === "working") || x.posts[0];
  const pr = x.kind === "pr";
  const meta = pr ? prMeta(x.pr, x.state) : [x.dirty ? `${x.dirty} ±` : "", x.ahead ? `↑${x.ahead}` : ""].filter(Boolean).join(" ");
  const facts = meta === `#${x.number}` ? "" : meta;
  const bad = pr && (x.pr.mergeable === "conflicts" || x.pr.checks?.fail || x.pr.review === "changes");
  const set = tasksOfPart(x)[0];
  return (
    <a className={`tl-card tl-card--${side}${x.state === "needs" ? " is-needs" : ""}${x.stale ? " is-stale" : ""}`} href={wipHref(x)} title={wipWhy(x)} style={{ gridRow: `${row} / span 2`, ...hueVars(s?.agent || "claude") }}>
      <span className="tl-top">
        <WipDot w={x} />
        <span className="tl-t">{x.title}</span>
        {x.at ? <time title={new Date(x.at).toLocaleString()}>{ago(x.at)}</time> : null}
      </span>
      <span className="tl-row">
        {pr ? <span className="chip">#{x.number}</span> : null}
        <span className="chip chip--branch" title={x.worktree ? tilde(x.machine, x.worktree) : x.branch}>
          {x.branch}
        </span>
        {set ? (
          <span className="chip chip--set" title={`On the task ${set.text}`}>
            <Icon name="tasks" />
            <span>{set.text}</span>
          </span>
        ) : null}
      </span>
      <span className="tl-row">
        {s ? (
          <>
            <Avatar agent={s.agent} size="av--xs" />
            <span className="tl-who">
              <b>{s.label}</b> {listVerb(s)}
            </span>
          </>
        ) : pr && x.pr.author !== x.me ? (
          <span className="tl-who">@{x.pr.author}</span>
        ) : (
          <span className="tl-who muted">no threads</span>
        )}
        {facts ? <span className={`tl-facts${bad ? " is-bad" : ""}`}>{facts}</span> : null}
      </span>
    </a>
  );
}

// Each timeline's lines, from where its cards and stops ended up: out of each commit, one line down each side of
// main and a short one into each card that left there. Narrow, main runs down the left and each card branches off
// it. Drawn again when a timeline's size changes (a card wraps, the window narrows, the fonts load).
function useTimelineLines() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tl = ref.current;
    if (!tl) return;
    const draw = () => drawTimeline(tl);
    draw();
    if (typeof ResizeObserver !== "function") return;
    const sized = new ResizeObserver(() => requestAnimationFrame(draw));
    sized.observe(tl);
    return () => sized.disconnect();
  });
  return ref;
}
function drawTimeline(tl: HTMLElement) {
  const box = tl.getBoundingClientRect();
  const narrow = tl.clientWidth < 520;
  const R = 7;
  let d = "";
  let stop: Element | null = null;
  for (const el of tl.children) {
    if (el.classList.contains("tl-stop")) stop = el.querySelector(".tl-node");
    if (!el.classList.contains("tl-cards") || !stop) continue;
    const nb = stop.getBoundingClientRect();
    const nx = Math.round(nb.left + nb.width / 2 - box.left) + 0.5;
    const ny = Math.round(nb.top + nb.height / 2 - box.top);
    const cards = [...el.children].map((c) => {
      const r = c.getBoundingClientRect();
      const left = !narrow && c.classList.contains("tl-card--l");
      return { x: Math.round((left ? r.right : r.left) - box.left), y: Math.round(r.top - box.top + 19), sign: left ? -1 : 1 };
    });
    if (narrow) {
      for (const c of cards) d += `M${nx} ${c.y - R}Q${nx} ${c.y} ${nx + R} ${c.y}H${c.x}`;
      continue;
    }
    for (const sign of [-1, 1]) {
      const mine = cards.filter((c) => c.sign === sign).sort((a, b) => a.y - b.y);
      if (!mine.length) continue;
      const bx = nx + sign * 18;
      const last = mine.at(-1);
      d += `M${nx + sign * 7} ${ny}H${bx - sign * R}Q${bx} ${ny} ${bx} ${ny + R}V${last.y - R}Q${bx} ${last.y} ${bx + sign * R} ${last.y}H${last.x}`;
      for (const c of mine.slice(0, -1)) d += `M${bx} ${c.y}H${c.x}`;
    }
  }
  const svg = tl.querySelector<SVGElement>(".tl-lines");
  if (svg && svg.dataset.d !== d) {
    svg.innerHTML = `<path d="${d}"/>`;
    svg.dataset.d = d;
  }
}
