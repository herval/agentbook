// On a task's page, what it ships: how much of it landed, a row for each pull request and branch with what's in its
// way and its next step, in its landing order when it has one (with Land them in order), and Add one; its Changes
// (what each of them changes); and what happened to them, for its History (setStory).
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { create } from "zustand";
import { ordinal, onGitHub, workspaces } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { ago, plural, webUrl } from "../../lib/format.ts";
import { go } from "../../lib/route.ts";
import { getApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { ChangedFile, TaskRow } from "../../lib/types.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import { DONE, landWord, partRef, partStatus, partTitle, partUrl, setGoFile, setParts, setQueue, setRest, shipWips, tasksOfPart, wipItemOf, type ShipPart, type TaskShip } from "../worktrees/ship.ts";
import { ChgSize, WipWho, WipWord } from "../worktrees/WipRow.tsx";
import { ghName, gitKey, PR_ASK, prAt, prKey, prLaunch, WIP_ASK, wipHref, wipLaunch, wipWhy, wipWs, wipWsName, type Wip, type WipSt } from "../worktrees/wips.ts";
import { WipDot } from "../worktrees/Timeline.tsx";
import { SetBar } from "./Ship.tsx";
import { me, taskMine } from "./tasks.ts";

// Changing a task's landing order: which task, and its parts' ids in the order you're putting them in (S.setOrder).
const useSetOrder = create<{ id: string | null; keys: string[] }>(() => ({ id: null, keys: [] }));
const setOrderMove = (id: string, before: string | null) => {
  const keys = useSetOrder.getState().keys.filter((k) => k !== id);
  const at = before == null ? keys.length : keys.indexOf(before);
  keys.splice(at < 0 ? keys.length : at, 0, id);
  useSetOrder.setState({ keys });
};

export function TaskShipCard({ t, x }: { t: TaskRow; x: TaskShip }) {
  const ordering = useSetOrder((s) => s.id === x.id);
  const reading = (getApp().data?.folders || []).some((f) => f.sessions && !("wip" in f));
  const c = x.ss.counts;
  const parts = setParts(x);
  // In its landing order, the ones in it first, numbered, each saying what it waits for; then the rest.
  const queue = setQueue(x);
  const rest = parts.filter((p) => !queue.includes(p));
  const next = queue.findIndex((p) => !DONE.has(partStatus(p).k));
  const waits = (p: ShipPart, i: number) => (i === next ? setNextNote(x, p) : next >= 0 && i > next && !DONE.has(partStatus(p).k) ? `waits for ${partRef(queue.slice(0, i).findLast((q) => !DONE.has(partStatus(q).k)))}` : "");
  const inWay = parts.filter((p) => ["stuck", "needs"].includes(partStatus(p).k)).length;
  const note = ordering ? "Drag them into the order they land, the first first" : inWay ? `${plural(inWay, "thing")} in the way` : "";
  const open = parts.filter((p) => !DONE.has(partStatus(p).k)).length;
  // What it ships, its order and landing are its owner's: anyone else on it (or reading a public one) sees them.
  const acts = !taskMine(t) ? null : (
    <>
      <SetOrderActs x={x} queue={queue} next={next} />
      {t.done || ordering ? null : <SetAddPick x={x} />}
    </>
  );
  return (
    <section className="card tk-sec tk-wip tk-ship-card">
      <h2 className="tk-h">
        Pull requests
        {parts.length ? <span className="n">{open === parts.length ? parts.length : `${open} open, ${parts.length - open} done`}</span> : null}
        <span className="tk-h-end">{acts}</span>
      </h2>
      {c.total >= 2 || c.closed ? (
        <div className="wp-prog">
          <SetBar x={x} titles />
          <b>
            {c.landed} of {c.total} {landWord(x)}
          </b>
          {setRest(x) ? <span className="muted">{setRest(x)}</span> : null}
        </div>
      ) : null}
      {note ? <p className="muted tk-ship-note">{note}</p> : null}
      {parts.length ? (
        <ul className="wp-parts">
          {ordering ? (
            <SetOrderRows x={x} />
          ) : (
            <>
              <SetLandingLine x={x} />
              {queue.map((p, i) => (
                <SetPartRow key={p.id} x={x} p={p} n={i + 1} wait={waits(p, i)} />
              ))}
              {queue.length && rest.length ? <li className="wp-parts-sub">Not in the landing order</li> : null}
              {rest.map((p) => (
                <SetPartRow key={p.id} x={x} p={p} />
              ))}
            </>
          )}
        </ul>
      ) : null}
      {parts.length ? null : <p className="muted tk-empty">{reading ? "Reading git…" : "None yet. A branch or a pull request one of its threads works on shows up here, and Add one puts in any of yours."}</p>}
    </section>
  );
}

// One thing in it: its word, title, #number or branch and the reason for the word, who's on it, its next step,
// and × to take it out (one that came with a thread goes when the thread does). In its landing order (`n`), its
// place, and what it waits for (`wait`).
function SetPartRow({ x, p, n = 0, wait = "" }: { x: TaskShip; p: ShipPart; n?: number; wait?: string }) {
  const st = partStatus(p);
  const done = DONE.has(st.k);
  const isPr = p.w?.kind === "pr" || p.item?.kind === "pr";
  // A pull request's #number goes straight to GitHub, as on a thread's cards; the rest of the row to its page (its
  // title's link, stretched over the row).
  const gh = isPr ? webUrl(partUrl(p)) : null;
  const ref = gh ? (
    <a className="pr-gh" href={gh} target="_blank" rel="noopener" title="Open on GitHub">
      {partRef(p)}
      <Icon name="external" />
    </a>
  ) : (
    partRef(p)
  );
  const inner = (title: ReactNode) => (
    <>
      <WipWord st={st} />
      {title}
      <span className="wl-m">
        <span className={`wl-ref${isPr ? "" : " wl-br"}`}>{ref}</span>
        {wait ? <span className="wp-wait">{wait}</span> : null}
        {st.why ? <span className={`wl-why${st.tone ? ` is-${st.tone}` : ""}`}>{st.why}</span> : null}
        {p.via ? (
          <span className="wp-via" title={`On it because ${p.via.label} works on it`}>
            with {p.via.label}
          </span>
        ) : null}
      </span>
    </>
  );
  const title = partTitle(p);
  // One on a task shared with you (sharedWips) has its page; its #number goes to GitHub.
  const a =
    !p.w || (p.w.shared && !p.w.work) ? (
      <span className="wp-part-a" title={p.w ? wipWhy(p.w) : undefined}>
        {inner(<span className="wl-t">{title}</span>)}
      </span>
    ) : gh ? (
      <div className="wp-part-a wp-part-two">
        {inner(
          <a className="wl-t wp-part-go" href={wipHref(p.w)} title={wipWhy(p.w)}>
            {title}
          </a>,
        )}
      </div>
    ) : (
      <a className="wp-part-a" href={wipHref(p.w)} title={wipWhy(p.w)}>
        {inner(<span className="wl-t">{title}</span>)}
      </a>
    );
  const out = p.item && (!x.task || taskMine(x.task));
  return (
    <li className={[done ? "is-done" : "", n ? "has-ord" : ""].filter(Boolean).join(" ") || undefined}>
      {n ? (
        <span className="wp-ord" title={`${ordinal(n)} to land`}>
          {n}
        </span>
      ) : null}
      {a}
      {p.w ? <WipWho x={p.w} /> : <span />}
      {p.w && !done ? <SetStep x={x} w={p.w} st={st} /> : <span />}
      {out ? (
        <button className="icon-btn wp-x" type="button" title={`Take it out of ${x.title}`} aria-label="Take it out" onClick={async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          if ((await post(`/api/tasks/${encodeURIComponent(x.id)}/items`, { item: { id: p.item.id }, remove: true })).ok) toast(`Out of ${x.title}.`);
          b.disabled = false;
        }}>
          <Icon name="x" />
        </button>
      ) : null}
    </li>
  );
}

// What the next one to land says: that it's next, or, while they land in order, that its thread was asked to land
// it (or that none is on it).
function setNextNote(x: TaskShip, p: ShipPart) {
  if (!x.landing) return "next to land";
  const url = partUrl(p)?.toLowerCase();
  const asked = [...(x.events || [])].reverse().find((e) => e.kind === "asked" && e.at >= x.landing.at && (e.item === p.id || e.item === p.item?.id || (url && String(e.item).toLowerCase() === url))) as { waits?: string; post?: string } | undefined;
  if (asked?.waits) return asked.waits === me() ? "next: yours to ask its thread" : `next: @${asked.waits}'s to ask`;
  return !asked ? "next to land" : asked.post ? "asked to land it" : "next, and no thread is on it";
}
// Its head's buttons for the order: Landing order, to put them in one; with one, Land them in order (or Stop, while
// they do) and Reorder; changing it, Save the order, Cancel and No order.
function SetOrderActs({ x, queue, next }: { x: TaskShip; queue: ShipPart[]; next: number }) {
  const ordering = useSetOrder((s) => s.id === x.id);
  const [busy, setBusy] = useState(false);
  // Changing it: what's in it that hasn't landed (and what the order had).
  const start = () => {
    const rest = setParts(x).filter((p) => !queue.includes(p) && !DONE.has(partStatus(p).k));
    useSetOrder.setState({ id: x.id, keys: [...queue, ...rest].map((p) => p.id) });
  };
  // Saving it, or taking it off.
  const save = async (off: boolean) => {
    const order = off
      ? []
      : useSetOrder
          .getState()
          .keys.map((id) => x.parts.find((p) => p.id === id))
          .filter(Boolean)
          .map((p) => (p.w ? wipItemOf(p.w) : p.item));
    setBusy(true);
    const r = await post(`/api/tasks/${encodeURIComponent(x.id)}/order`, { order });
    setBusy(false);
    if (!r.ok) return;
    useSetOrder.setState({ id: null, keys: [] });
    toast(order.length ? `They land in this order: ${order.map((o) => o.ref).join(", then ")}.` : "No landing order: each lands whenever it's ready.");
  };
  // Landing them in order, or stopping.
  const landing = async (on: boolean) => {
    setBusy(true);
    const r = await post(`/api/tasks/${encodeURIComponent(x.id)}/landing`, { on });
    setBusy(false);
    if (r.ok) toast(on ? "Landing them in order: the first one's thread is asked now, each next one's once the one before it merges." : "Stopped. Each lands whenever it's ready.");
  };
  if (ordering)
    return (
      <span className="gate-btns">
        <button className="btn btn--dark btn--sm" type="button" disabled={busy} onClick={() => void save(false)}>
          Save the order
        </button>
        <button className="btn btn--line btn--sm" type="button" onClick={() => useSetOrder.setState({ id: null, keys: [] })}>
          Cancel
        </button>
        {x.order ? (
          <button className="wp-h-btn" type="button" disabled={busy} title="Take the landing order off: each lands whenever it's ready" onClick={() => void save(true)}>
            No order
          </button>
        ) : null}
      </span>
    );
  const open = x.parts.filter((p) => !DONE.has(partStatus(p).k)).length;
  if (!queue.length)
    return open >= 2 ? (
      <button className="wp-h-btn" type="button" title="Put what's in it in the order it lands: each one's thread is told what it waits for, and they can land one after the other" onClick={start}>
        <Icon name="steps" />
        Landing order
      </button>
    ) : null;
  return (
    <span className="gate-btns">
      <button className="wp-h-btn" type="button" title="Change the order they land in" onClick={start}>
        <Icon name="steps" />
        Reorder
      </button>
      {next < 0 ? null : x.landing ? (
        <button className="btn btn--line btn--sm" type="button" disabled={busy} title="Stop asking each one's thread to land it in turn" onClick={() => void landing(false)}>
          <Icon name="stop" />
          Stop
        </button>
      ) : (
        <button className="btn btn--dark btn--sm" type="button" disabled={busy} title={`Asks the thread on ${partRef(queue[next])} to land it now, then each next one's once the one before it has merged`} onClick={() => void landing(true)}>
          <Icon name="merge" />
          Land them in order
        </button>
      )}
    </span>
  );
}
// While they land in order, what it did last: asked a thread, found none on the next one, couldn't ask.
function SetLandingLine({ x }: { x: TaskShip }) {
  if (!x.landing) return null;
  const e = [...(x.events || [])].reverse().find((y) => (y.kind === "asked" || y.kind === "landing") && y.at >= x.landing.at);
  const u = me();
  const text = e ? (u && e.text.startsWith(`${u} `) ? `You ${e.text.slice(u.length + 1)}` : e.text) : "Starting…";
  return (
    <li className="wp-landing">
      <Icon name="merge" />
      <b>Landing in order</b>
      <span>{text}</span>
      {e ? <time title={new Date(e.at).toLocaleString()}>{ago(e.at)}</time> : null}
    </li>
  );
}
// Changing the order: what's in it that hasn't landed (and what the order had), a row each with its place, a handle to
// drag it by, and ↑ ↓.
function SetOrderRows({ x }: { x: TaskShip }) {
  const all = useSetOrder((s) => s.keys);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; edge: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const keys = all.filter((id) => x.parts.some((p) => p.id === id));
  // Moving one a place up or down, with its button keeping the focus.
  const mv = (id: string, by: number) => {
    const k = [...useSetOrder.getState().keys];
    const i = k.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= k.length) return;
    [k[i], k[j]] = [k[j], k[i]];
    useSetOrder.setState({ keys: k });
  };
  const edge = (e: DragEvent<HTMLLIElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "top" : "bottom";
  };
  return (
    <>
      {keys.map((id, i) => {
        const p = x.parts.find((y) => y.id === id);
        const st = partStatus(p);
        return (
          <li
            key={id}
            className={`wp-ord-edit${drag === id ? " is-dragging" : ""}${over?.id === id ? ` is-over-${over.edge}` : ""}`}
            draggable={armed === id}
            onDragStart={(e) => {
              setDrag(id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", partTitle(p));
            }}
            onDragOver={(e) => {
              if (!drag || drag === id) return setOver(null);
              e.preventDefault();
              setOver({ id, edge: edge(e) });
            }}
            onDrop={(e) => {
              setOver(null);
              if (!drag || drag === id) return;
              e.preventDefault();
              const k = useSetOrder.getState().keys.filter((y) => y !== drag);
              const at = k.indexOf(id) + (edge(e) === "top" ? 0 : 1);
              setOrderMove(drag, k[at] ?? null);
            }}
            onDragEnd={() => (setDrag(null), setOver(null), setArmed(null))}
          >
            <span className="wp-grip" title="Drag to move it" onMouseDown={() => setArmed(id)}>
              <Icon name="grip" />
            </span>
            <span className="wp-ord">{i + 1}</span>
            <WipWord st={st} />
            <span className="wl-t">{partTitle(p)}</span>
            <span className={`wl-ref${partUrl(p) ? "" : " wl-br"}`}>{partRef(p)}</span>
            <span className="wp-mv">
              <button className="icon-btn" type="button" aria-label="Land it earlier" title="Earlier" disabled={!i} onClick={() => mv(id, -1)}>
                <Icon name="up" />
              </button>
              <button className="icon-btn" type="button" aria-label="Land it later" title="Later" disabled={i >= keys.length - 1} onClick={() => mv(id, 1)}>
                <Icon name="down" />
              </button>
            </span>
          </li>
        );
      })}
    </>
  );
}
// Its next step, the one its own page has: Fix the checks, Address the review, Rebase, Merge it, Open a pull request.
// It asks the thread going on it, or starts one on the task.
function SetStep({ x, w, st }: { x: TaskShip; w: Wip; st: WipSt }) {
  const [busy, setBusy] = useState(false);
  if (w.shared || !w.posts.every((s) => s.mine !== false)) return <span />;
  const going = w.posts.find((s) => s.state !== "done" && s.mine !== false);
  let step: [string, IconName, string, string] | null = null;
  if (w.kind === "pr") {
    const p = w.pr;
    if (p.checks?.fail) step = ["checks", "check", "Fix the checks", "fix its failing checks"];
    else if (p.review === "changes") step = ["review", "comment", "Address the review", "address the review"];
    else if (p.mergeable === "conflicts" || p.merge_state === "behind") step = ["rebase", "down", `Rebase from ${p.base}`, `rebase it from ${p.base}`];
    else if (st.k === "ready") step = ["merge", "merge", "Merge it", `merge it into ${p.base}`];
  } else if (st.k === "branch") {
    const ws = workspaces().find((y) => y.id === wipWs(w));
    if (w.ahead || w.dirty) step = onGitHub(ws) ? ["pr", "pr", "Open a pull request", `push it and open a pull request into ${w.base}`] : ["land", "up", `Land on ${w.base}`, `land it on ${w.base}`];
  }
  if (!step) return <span />;
  const [k, ico, text, what] = step;
  const task = x.task;
  // It asks the thread going on it; else a thread started for it is on the task: the task's sent list keeps its
  // launch, as Send does.
  const ask = async () => {
    const prompt = w.kind === "pr" ? PR_ASK[k](prAt(w)) : WIP_ASK[k](w);
    setBusy(true);
    if (going) {
      const r = await post(`/api/sessions/${encodeURIComponent(going.id)}/messages`, { text: prompt, files: [] });
      if (r.ok) toast(`Sent to ${going.label}.`);
    } else {
      const r = await (w.kind === "pr" ? prLaunch(w, prompt, { task: task.text }) : wipLaunch(w, prompt, { task: task.text }));
      const lid = (r.data as { lid?: string } | undefined)?.lid;
      if (r.ok && lid) void post(`/api/tasks/${encodeURIComponent(task.id)}/send`, { launch: lid, agent: r.agent || null });
    }
    setBusy(false);
  };
  return (
    <button className="btn btn--line btn--sm" type="button" disabled={busy} title={going ? `Asks ${going.label} to ${what}` : `Starts a thread on the task that does: ${what}`} onClick={() => void ask()}>
      <Icon name={ico} />
      {text}
    </button>
  );
}
// Add a pull request or branch: your open ones, the newest first, found by title, #number or branch as you type; one
// on another task says so (it can be on both).
function SetAddPick({ x }: { x: TaskShip }) {
  const here = new Set(x.parts.map((p) => p.id));
  const list = shipWips()
    .filter((w) => !here.has(w.id))
    .sort((a, b) => Number(a.state === "clear") - Number(b.state === "clear") || b.at.localeCompare(a.at))
    .slice(0, 80);
  if (!list.length) return null;
  const rows = list.map((w) => {
    const other = tasksOfPart(w)[0];
    return { value: w.id, text: w.title, find: `${w.kind === "pr" ? `#${w.number} ` : ""}${w.branch} ${w.title} ${wipWsName(w)}`, face: <WipDot w={w} />, note: other ? "on another task" : w.kind === "pr" ? `#${w.number}` : "branch", title: other ? `Also on ${other.text}` : wipWhy(w) };
  });
  // Putting one in it.
  const add = async (id: string) => {
    const w = list.find((y) => y.id === id);
    if (w && (await post(`/api/tasks/${encodeURIComponent(x.id)}/items`, { item: wipItemOf(w) })).ok) toast(`${w.kind === "pr" ? `#${w.number}` : w.branch} is on it.`);
  };
  return (
    <MenuPick
      id={`set-add:${x.id}`}
      label="Pull request or branch"
      title="Put one of your pull requests or branches in it"
      face={
        <>
          <Icon name="plus" />
          <span className="opt-v">Add</span>
          <Icon name="down" className="caret" />
        </>
      }
      rows={rows}
      none
      find
      onPick={(v) => void add(v)}
    />
  );
}

// A line of a History: when, how it shows (`cls`), and what it says.
export interface HistEvent {
  at: string;
  cls?: string;
  node: ReactNode;
}
// Text with its `code` as code.
const codes = (s: string) => s.split(/`([^`]+)`/g).map((x, i) => (i % 2 ? <code key={i}>{x}</code> : x));
// What happened to what it ships, for its History: what went in and out, its order, landing in order, what GitHub
// said of each pull request (failing, approved, ready), and each opening, merging or closing, tagged with which.
export function setStory(x: TaskShip): HistEvent[] {
  const ev: HistEvent[] = [];
  const u = me();
  const lane = (n: string | number | undefined) => (n ? <span className="lane wp-lane">#{n}</span> : null);
  for (const e of x.events || []) {
    const ee = e as typeof e & { pr?: string; url?: string; post?: string };
    if (ee.kind === "pr") {
      if (["merged", "closed", "opened"].includes(ee.pr)) continue;
      ev.push({
        at: ee.at,
        cls: ee.pr === "fail" ? "err" : ee.pr === "good" ? "ok" : "",
        node: (
          <span>
            {lane(/\/pull\/(\d+)/.exec(ee.url || "")?.[1])}
            {codes(ee.text)}
          </span>
        ),
      });
      continue;
    }
    ev.push({ at: ee.at, cls: ee.kind === "asked" ? (ee.post ? "ok" : /^Couldn't/.test(ee.text) ? "err" : "") : "", node: <span>{u && ee.text.startsWith(`${u} `) ? `You ${ee.text.slice(u.length + 1)}` : ee.text}</span> });
  }
  for (const p of x.parts) {
    const pr = p.w?.kind === "pr" ? p.w.pr : null;
    if (!pr) continue;
    if (pr.created)
      ev.push({
        at: pr.created,
        node: (
          <span>
            {lane(pr.number)}
            {ghName(pr.author, p.w.me)} opened it{pr.state === "draft" ? " as a draft" : ""}
          </span>
        ),
      });
    if (pr.closed && (pr.state === "merged" || pr.state === "closed"))
      ev.push({
        at: pr.closed,
        cls: pr.state === "merged" ? "landed" : "",
        node: (
          <span>
            {lane(pr.number)}
            {pr.state === "merged" ? (
              <>
                merged into <code>{pr.base}</code>
              </>
            ) : (
              "closed without merging"
            )}
          </span>
        ),
      });
  }
  return ev.filter((e) => e.at);
}

// Its Changes: what's in it, each with its files under its title, read from GitHub (a pull request's) or git (a
// branch's, committed and not), when you open the tab and again once one moves. A file two of them change says so;
// each opens its diff on its own page.
const setChgKey = (w: Wip) => (w.kind === "pr" ? prKey(w) : gitKey(w));
type ChgFile = ChangedFile & { scope?: string; untracked?: boolean; binary?: boolean };
interface Chg {
  key: string;
  loading?: boolean;
  files?: ChgFile[];
  more?: number;
  url?: string | null;
  error?: string;
}
const useSetChg = create<Record<string, Chg>>(() => ({}));
// What's in it that has files to show: not the closed ones, nor the ones gone.
export const setChgParts = (x: TaskShip) => {
  const queue = setQueue(x);
  return [...queue, ...setParts(x).filter((p) => !queue.includes(p))].filter((p) => !["closed", "gone"].includes(partStatus(p).k));
};
function loadSetChanges(x: TaskShip) {
  for (const p of x.parts) {
    const w = p.w;
    if (!w || ["closed", "gone"].includes(partStatus(p).k)) continue;
    const had = useSetChg.getState()[w.id];
    if (had && (had.loading || had.key === setChgKey(w))) continue;
    useSetChg.setState({ [w.id]: { ...had, loading: true, key: setChgKey(w) } });
    const url = w.kind === "pr" ? `/api/pulls?${new URLSearchParams({ workspace: w.ws.id, number: String(w.number) })}` : `/api/wip?${new URLSearchParams({ root: w.root, branch: w.branch, ...(w.machine ? { machine: w.machine } : {}) })}`;
    fetch(url)
      .then(async (res) => {
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || (w.kind === "pr" ? "Couldn't read it from GitHub." : "Couldn't read this branch from git."));
        const files = w.kind === "pr" ? d.files_list.map((f) => ({ ...f, scope: "pr" })) : [...d.uncommitted.map((f) => ({ ...f, scope: "uncommitted" })), ...d.committed.filter((f) => !d.uncommitted.some((u) => u.path === f.path)).map((f) => ({ ...f, scope: "committed" }))];
        useSetChg.setState({ [w.id]: { key: setChgKey(w), files, more: d.files_more || 0, url: d.url || null } });
      })
      .catch((e) => useSetChg.setState({ [w.id]: { key: setChgKey(w), error: e.message } }));
  }
}
const PathOf = ({ p }: { p: string }) => {
  const i = String(p).lastIndexOf("/");
  return i < 0 ? (
    <b>{p}</b>
  ) : (
    <>
      <span className="dir">{p.slice(0, i + 1)}</span>
      <b>{p.slice(i + 1)}</b>
    </>
  );
};
// The tab's count: how many files they change, read so far.
export function setChangesCount(x: TaskShip) {
  const chg = useSetChg.getState();
  return setChgParts(x).reduce((n, p) => n + ((p.w && chg[p.w.id]?.files?.length) || 0), 0);
}
// The tab, read when it opens and again once one of them moves.
export function SetChanges({ x }: { x: TaskShip }) {
  const chg = useSetChg();
  useEffect(() => loadSetChanges(x));
  const parts = setChgParts(x);
  const by = new Map<string, ShipPart[]>();
  for (const p of parts) for (const f of (p.w && chg[p.w.id]?.files) || []) by.set(f.path, [...(by.get(f.path) || []), p]);
  const both = [...by.values()].filter((l) => l.length > 1).length;
  return (
    <>
      {both ? (
        <p className="wp-chg-note">
          <Icon name="alert" />
          <span>
            {plural(both, "file")} {both === 1 ? "is" : "are"} changed by more than one of them: whichever lands second may need a rebase.
          </span>
        </p>
      ) : null}
      {parts.map((p) => {
        const st = partStatus(p);
        const c = p.w ? chg[p.w.id] : null;
        const h = (
          <>
            <WipWord st={st} />
            <b>{partTitle(p)}</b>
            <span className={`wl-ref${partUrl(p) ? "" : " wl-br"}`}>{partRef(p)}</span>
          </>
        );
        const head = (
          <p className="wp-chg-h">
            {p.w ? (
              <a href={wipHref(p.w)} title={wipWhy(p.w)}>
                {h}
              </a>
            ) : (
              <span>{h}</span>
            )}
            {c?.files?.length ? <span className="muted">{plural(c.files.length, "file")}</span> : null}
          </p>
        );
        const say = (text: string) => (
          <section className="wp-chg" key={p.id}>
            {head}
            <p className="muted wip-none">{text}</p>
          </section>
        );
        if (!p.w) return say(`Can't read it now: ${st.why || "its machine is off"}.`);
        if (!c || (c.loading && !c.files && !c.error)) return say(p.w.kind === "pr" ? "Reading GitHub…" : "Reading git…");
        if (c.error) return say(c.error);
        if (!c.files.length) return say(p.w.kind === "pr" ? "It doesn't change any files." : "Nothing on it that isn't on its base.");
        return (
          <section className="wp-chg" key={p.id}>
            {head}
            <ul className="chg-files">
              {c.files.map((f) => {
                const also = (by.get(f.path) || []).filter((q) => q !== p);
                const kind = f.untracked ? "new, untracked" : f.kind === "create" ? "new" : f.kind === "delete" ? "deleted" : f.kind === "rename" ? "renamed" : "";
                return (
                  <li key={`${f.scope}|${f.path}`}>
                    <a
                      className="chg-row"
                      href={wipHref(p.w)}
                      title={`Its diff, on ${partRef(p)}'s page`}
                      onClick={(e) => {
                        e.preventDefault();
                        setGoFile({ id: p.w.id, key: `${f.scope}|${f.path}`, scope: f.scope });
                        go(wipHref(p.w));
                      }}
                    >
                      <span className="chg-path">
                        <PathOf p={f.path} />
                      </span>
                      {f.scope === "uncommitted" ? <span className="tag">not committed</span> : null}
                      {kind ? <span className="tag">{kind}</span> : null}
                      {also.length ? (
                        <span className="tag tag--main" title={`${also.map(partRef).join(" and ")} ${also.length === 1 ? "changes" : "change"} it too: whichever lands second may need a rebase`}>
                          also {also.map(partRef).join(", ")}
                        </span>
                      ) : null}
                      {f.binary ? <small className="chg-n">binary</small> : <ChgSize add={f.add} del={f.del} />}
                      <Icon name="next" />
                    </a>
                  </li>
                );
              })}
            </ul>
            {c.more ? (
              <p className="muted wip-none">
                And {plural(c.more, "more file")}
                {webUrl(c.url) ? (
                  <>
                    ,{" "}
                    <a href={`${c.url}/files`} target="_blank" rel="noopener">
                      on GitHub
                    </a>
                  </>
                ) : null}
                .
              </p>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
