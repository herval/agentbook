// What a branch's page and a pull request's page share: the frame (crumbs, the card, the right column), the line of
// facts under its title, what stands between it and landing (Gate), its tabs, its threads, the rest of its
// workspace's worktrees, its story, and the group it's in.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getJSON, query, post } from "../../lib/api.ts";
import { clock, dayTime, groupStyle, plural } from "../../lib/format.ts";
import { postPics } from "../../lib/markdown.ts";
import { groupHref, threadHref, workspaceHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, Thread } from "../../lib/types.ts";
import { Composer } from "../Composer.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import { Shell } from "../Shell.tsx";
import { ThreadRows } from "../ThreadRow.tsx";
import { groupById, groupMine } from "../groups/groups.ts";
import { TaskCardOf } from "../tasks/Ship.tsx";
import { InlineMd, peekOf } from "./PageText.tsx";
import { setTab, showAll, usePage } from "./PageState.ts";
import { wipItemOf } from "./ship.ts";
import { WipWord } from "./WipRow.tsx";
import { useWorld, wipHref, wipOrder, wipPutIn, wipsIn, wipStatus, wipWhy, type Wip, type Ws } from "./wips.ts";

// A worktree's page: its crumbs over its card, and beside it the tasks it's in, its group, and the rest of its
// workspace's worktrees with work left (`ws`, none for one shared with you).
export function WipFrame({ x, ws, crumbs, children }: { x: Wip; ws: Ws | null; crumbs: ReactNode; children: ReactNode }) {
  const others = ws ? wipsLeft(ws, x) : [];
  return (
    <Shell
      right={
        <>
          <div data-key="tasks">
            <TaskCardOf x={x} />
          </div>
          <div data-key="group">
            <WipGroupCard x={x} />
          </div>
          <div data-key="others">
            <OtherWips ws={ws} list={others} />
          </div>
        </>
      }
    >
      <div>{crumbs}</div>
      <article className="card wip-page">{children}</article>
    </Shell>
  );
}
const wipsLeft = (ws: Ws, x: Wip) => wipsIn(ws).filter((o) => o.id !== x.id && o.state !== "clear");

// Its branch, under its title, on one line: `items` of [icon, what it says, title], the empty ones left out, and
// `acts`, its buttons, at the end.
export type Fact = [IconName | "", ReactNode, string?];
export function WipFacts({ items, acts = null }: { items: Fact[]; acts?: ReactNode }) {
  const list = items.filter(([, node]) => node);
  if (!list.length && !acts) return null;
  return (
    <div className="wip-facts">
      {list.map(([ico, node, title], i) => (
        <span className="wf" title={title || undefined} key={i}>
          {ico ? <Icon name={ico} /> : null}
          <span>{node}</span>
        </span>
      ))}
      {acts}
    </div>
  );
}
export function CopyBtn({ text }: { text: string }) {
  return (
    <button
      className="wf-copy"
      type="button"
      title="Copy its path"
      aria-label="Copy its path"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => {});
        toast("Copied. Paste it in a terminal.");
      }}
    >
      <Icon name="copy" />
    </button>
  );
}
// What a machine said last, shown while it's off: when it said it.
export function AsOf({ d, machine }: { d: { offline?: boolean; as_of?: string } | null; machine?: string }) {
  if (!d?.offline || !d.as_of) return null;
  return (
    <p className="as-of">
      <Icon name="pause" />
      As of {dayTime(d.as_of)}, while {machine || "its machine"} is off.
    </p>
  );
}

// What stands between a WIP and landing, a line for each, its fix on the line: `rows` of { ic, b, small, act },
// ic "fail" (in the way), "warn" (look at it), "ok", "part" (on its way) or "todo" (not yet), the last one landing
// it. `over`: it landed, or never will (merged, closed), so nothing's in the way of anything.
export interface GateRow {
  ic: string;
  b: ReactNode;
  small?: ReactNode;
  act?: ReactNode;
}
const GATE_ICON: Record<string, IconName> = { fail: "x", ok: "check", warn: "alert" };
export function Gate({ title, rows, over = false }: { title: ReactNode; rows: GateRow[]; over?: boolean }) {
  const fail = rows.filter((r) => r.ic === "fail").length;
  const warn = rows.filter((r) => r.ic === "warn").length;
  const note = over ? "" : fail ? `${plural(fail + warn, "thing")} in the way` : warn ? `${plural(warn, "thing")} to look at` : rows.slice(0, -1).some((r) => r.ic === "todo" || r.ic === "part") ? "" : "nothing in the way";
  return (
    <ul className="gate">
      <li className="gate-h">
        <b>{title}</b>
        {note ? <span className="muted">{note}</span> : null}
      </li>
      {rows.map((r, i) => (
        <li key={i}>
          <span className={`gate-ic gate-ic--${r.ic}`}>{GATE_ICON[r.ic] ? <Icon name={GATE_ICON[r.ic]} /> : null}</span>
          <p>
            <b>{r.b}</b>
            {r.small ? <small>{r.small}</small> : null}
          </p>
          {r.act || null}
        </li>
      ))}
    </ul>
  );
}
// A button on a line of what's between it and landing that asks the thread going on it to do something, or starts one
// that does (`run`); off while it's asked.
export function AskButton({ title, icon, on = true, run, children }: { title: string; icon: IconName; on?: boolean; run: () => Promise<unknown>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn--line"
      type="button"
      title={title}
      disabled={!on || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await run();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}

// Its work, in tabs: `tabs` of [key, label, { n, cls, body }] (or none, to leave one out). Changes is open unless
// you picked another.
export interface Tab {
  n?: number | string;
  cls?: string;
  body: ReactNode;
}
export function WipTabs({ tabs }: { tabs: [string, string, Tab | null][] }) {
  const picked = usePage((s) => s.tab);
  const list = tabs.filter(([, , t]) => t);
  if (!list.length) return null;
  const on = list.find(([k]) => k === picked) || list[0];
  return (
    <>
      <nav className="wip-tabs" role="tablist">
        {list.map(([k, label, t]) => (
          <button type="button" role="tab" className={k === on[0] ? "is-on" : ""} aria-selected={k === on[0]} data-wip-tab={k} key={k} onClick={() => setTab(k)}>
            {label}
            {t.n != null && t.n !== "" ? <span className={`n${t.cls ? ` ${t.cls}` : ""}`}>{t.n}</span> : null}
          </button>
        ))}
      </nav>
      <div className="wip-tab" role="tabpanel">
        {on[2].body}
      </div>
    </>
  );
}

// Its threads, on a worktree's page right under what's between it and landing, the one place it lists them: the
// ones that need you first, then the ones working, each a row as in the feed (its status chip, when it last did
// something; not its project, the worktree's), and under them the feed's composer, which starts another here (`box`,
// its placeholder; none when you can't).
const WIP_FIRST = { needs: 0, working: 1 };
export function WipThreads({ x, box }: { x: Wip; box: string }) {
  if (!x.posts.length && !box) return null;
  const list = [...x.posts].sort((a, b) => (WIP_FIRST[a.effective] ?? 2) - (WIP_FIRST[b.effective] ?? 2));
  return (
    <section className="wip-threads wip-threads--in">
      <h3 className="wip-threads-h">
        <b>Threads</b>
        {x.posts.length ? <span className="muted">{x.posts.length}</span> : null}
      </h3>
      <ThreadRows list={list} repo={false} />
      {box ? <Composer wip={x.id} box={box} /> : null}
    </section>
  );
}

export function OtherWips({ ws, list }: { ws: Ws | null; list: Wip[] }) {
  if (!ws || !list.length) return null;
  const rows = [...list]
    .sort(wipOrder)
    .slice(0, 8)
    .map((x) => {
      const st = wipStatus(x);
      return (
        <li key={x.id}>
          <a href={wipHref(x)} title={wipWhy(x)}>
            <WipWord st={st} />
            <b>{x.title}</b>
            <small>
              {x.kind === "pr" ? `#${x.number}` : x.branch.replace(/^worktree-/, "")}
              {st.why ? `, ${st.why}` : ""}
            </small>
          </a>
        </li>
      );
    });
  return (
    <section className="card rail-card">
      <h3 className="rail-h">
        Other worktrees in {ws.name}
        {list.length > 8 ? <a href={workspaceHref(ws.id, "worktrees")}>All {list.length}</a> : null}
      </h3>
      <ul className="wl-mini">{rows}</ul>
    </section>
  );
}

/* what happened on it */

// A thread with its results and pull requests: a row has neither, so q/threads gives it, asked for once (100 at a
// time), and again when one of them moved. One it can't have stays the row it is.
const fullRows = new Map<string, Thread>();
// A record with its results (a row has none).
const isFull = (s: Thread) => (s as Partial<Thread>).updates !== undefined;
export function useFullRows(posts: Thread[]): Thread[] {
  const need = posts.filter((s) => !isFull(s));
  const key = need.map((s) => `${s.id}@${s.updated || ""}`).join(",");
  const [, drawn] = useState(0);
  useEffect(() => {
    if (!need.length) return;
    let live = true;
    (async () => {
      for (let i = 0; i < need.length; i += 100) {
        const some = need.slice(i, i + 100);
        const r = await query("/api/q/threads", { ids: some.map((s) => s.id).join(",") });
        for (const s of some) if (r?.records[`thread:${s.id}`]) fullRows.set(s.id, r.records[`thread:${s.id}`]);
      }
      if (live) drawn((n) => n + 1);
    })();
    return () => void (live = false);
  }, [key]);
  return posts.map((s) => (isFull(s) ? s : fullRows.get(s.id) || s));
}

// Something that happened on it: when, a class for its line, and what.
export interface StoryEvent {
  at: string;
  cls?: string;
  body: ReactNode;
}
// Its threads starting, their results and ending.
export function threadEvents(posts: Thread[]): StoryEvent[] {
  const ev: StoryEvent[] = [];
  for (const s of posts) {
    ev.push({
      at: s.started,
      body: (
        <span>
          <a className="who" href={threadHref(s.id)}>
            {s.label}
          </a>{" "}
          started “{s.title}”
        </span>
      ),
    });
    for (const u of s.updates || [])
      ev.push({
        at: u.at,
        body: (
          <span>
            <span className="who">{s.label}</span> <InlineMd text={u.text} peek={peekOf(s)} pics={postPics(s)} from={s.id} />
          </span>
        ),
      });
    if (s.state === "done" && s.ended)
      ev.push({
        at: s.ended,
        body: (
          <span>
            <span className="who">{s.label}</span> finished
          </span>
        ),
      });
  }
  return ev;
}
export function StoryList({ ev }: { ev: StoryEvent[] }) {
  const all = usePage((s) => s.all);
  const list = [...ev].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const shown = all ? list : list.slice(-14);
  return (
    <ol className="steps wip-story">
      {list.length > shown.length ? (
        <li className="more">
          <button type="button" onClick={showAll}>
            Show {list.length - shown.length} earlier
          </button>
        </li>
      ) : null}
      {shown.map((e, i) => (
        <li className={e.cls || ""} key={i}>
          {e.body}
          <time title={new Date(e.at).toLocaleString()}>{clock(e.at)}</time>
        </li>
      ))}
    </ol>
  );
}


const GrIco = ({ g }: { g: GroupRow }) => (
  <span className="gr-ico" style={groupStyle(g)}>
    {g.emoji || "👥"}
  </span>
);
// The page says what it is, for its threads to be told: the server can't work it out.
async function groupWipPut(g: GroupRow, x: Wip) {
  const was = wipPutIn(x)?.g;
  const wip = wipItemOf(x);
  if ((await post(`/api/groups/${encodeURIComponent(g.id)}/wips`, { wip })).ok) toast(`In ${g.name}${was && was.id !== g.id ? `, out of ${was.name}` : ""}. Its threads hear about it with their next message.`);
}
// A WIP, into a group from its page, moved, or taken out.
async function wipGroupTo(x: Wip, v: string) {
  const put = wipPutIn(x);
  if (v === (put?.g.id || "~none")) return;
  if (v === "~none") {
    if (put && (await post(`/api/groups/${encodeURIComponent(put.g.id)}/wips`, { wip: { id: put.w.id }, remove: true })).ok) toast(`Out of ${put.g.name}.`);
  } else if (x) await groupWipPut(groupById(v), x);
}
// The menu that puts it in one of your groups, moves it or takes it out (the old groupPick): your groups, found by
// their names as you type, the one it's in ticked; and No group.
function WipGroupPick({ x, g }: { x: Wip; g: GroupRow | null }) {
  const data = useWorld();
  const mine = (data?.groups || []).filter((y) => !y.archived && groupMine(y) && y.id !== g?.id);
  const rows = [
    ...(g ? [g] : []).concat(mine).map((y) => ({ value: y.id, text: y.name, face: <GrIco g={y} />, on: y === g })),
    { divider: "" },
    { value: "~none", text: "No group", face: <Icon name="x" />, on: !g, title: g ? `Take it out of ${g.name}` : "It's in no group" },
  ];
  return (
    <MenuPick
      id={`wip-group:${x.id}`}
      label="Group"
      title={g ? `In ${g.name}: move it to another group, or take it out` : "Put it in one of your groups"}
      face={
        <>
          <Icon name="group" />
          <span className="opt-v">{g ? "Move it" : "Add it to a group"}</span>
          <Icon name="down" className="caret" />
        </>
      }
      rows={rows}
      find
      onPick={(v) => void wipGroupTo(x, v)}
    />
  );
}
// Beside a pull request's or a branch's page, the group you put it in and the ones its threads are in, each opening it,
// and putting it in one of yours, moving it or taking it out. The same menu as a thread's (groupPick).
export function WipGroupCard({ x }: { x: Wip }) {
  const data = useWorld();
  if (x.shared) return null;
  const put = (wipPutIn(x)?.g as GroupRow) || null;
  const via = [...new Set(x.posts.map((s) => s.group).filter((id) => id && id !== put?.id))].map(groupById).filter(Boolean);
  const mine = (data?.groups || []).filter((g) => groupMine(g) && !g.archived && g.id !== put?.id);
  if (!put && !via.length && !mine.length) return null;
  const row = (g: GroupRow, why: string) => (
    <a className="gw-in" href={groupHref(g)} style={groupStyle(g)} key={g.id}>
      <span className="gr-ico">{g.emoji || "👥"}</span>
      <span>
        <b>{g.name}</b>
        <small>{why}</small>
      </span>
    </a>
  );
  const rows = [put ? row(put, "You put it in the group") : null, ...via.map((g) => row(g, `${x.posts.find((s) => s.group === g.id).label} is in it`))].filter(Boolean);
  return (
    <section className="card rail-card">
      <h3 className="rail-h">Group</h3>
      {rows.length ? rows : <p className="muted side-p">Not in a group. In one, the threads there are told about it.</p>}
      {mine.length || put ? <WipGroupPick x={x} g={put} /> : null}
    </section>
  );
}
