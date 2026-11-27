// A pull request or a branch in a list (the Worktrees page, a workspace's, a group's, an agent's): where it stands in
// a word, its title, who's on it, and what's in its way; and the bits other lists draw of it.
import { listVerb, many } from "../../lib/agents.ts";
import { ago, plural } from "../../lib/format.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { TreeCorner } from "../Visibility.tsx";
import { tasksOfPart } from "./ship.ts";
import { cleanableBranch, cleanBranch, dropLabel, dropTitle, tilde, useWorld, wipCleanable, wipHref, wipStatus, wipWhy, wipWs, wipWsName, type Wip, type WipSt } from "./wips.ts";
import { create } from "zustand";
import { useState, type ReactNode } from "react";
import type { Thread } from "../../lib/types.ts";

export function ChgSize({ add = 0, del = 0 }: { add?: number; del?: number }) {
  if (!add && !del) return null;
  return (
    <span className="chg">
      {add ? <b className="chg-add">+{add}</b> : null}
      {del ? <b className="chg-del">−{del}</b> : null}
    </span>
  );
}
export const WipWord = ({ st }: { st: WipSt }) => (
  <span className={`wst wst--${st.k}`}>
    <Icon name={st.icon as IconName} />
    {st.word}
  </span>
);
// A worktree of yours in a workspace of yours: its corner, as its workspace unless it has its own (never one of
// someone else's you read).
export const WipCorner = ({ x, cls = "" }: { x: Wip; cls?: string }) => (x.shared || !wipWs(x) || !x.branch ? null : <TreeCorner ws={wipWs(x)} branch={x.branch} cls={cls} />);
// Who's on it: its threads that aren't done, one that's working breathing, one that needs you in yellow.
export function WipWho({ x }: { x: Wip }) {
  const on = x.posts.filter((s) => s.effective !== "done").slice(0, 3);
  if (!on.length) return null;
  const cls = (s) => (s.effective === "working" ? " is-working" : s.effective === "needs" ? " is-needs" : "");
  return (
    <span className="wl-who" title={on.map((s) => `${s.label} ${listVerb(s)}`.trim()).join("\n")}>
      {on.map((s) => (
        <Avatar key={s.id} agent={s.agent} size={`av--xs${cls(s)}`} />
      ))}
    </span>
  );
}
// Deleting a branch with nothing left on it, from its row: its machine checks it all again.
export function DropButton({ w, className = "btn btn--line btn--sm wl-drop" }: { w: Wip; className?: string }) {
  const [busy, setBusy] = useState(false);
  const drop = async () => {
    if (!wipCleanable(w)) return;
    setBusy(true);
    if (!(await cleanBranch(w))) setBusy(false);
  };
  return (
    <button className={className || undefined} type="button" title={dropTitle(w)} disabled={busy} onClick={() => void drop()}>
      <Icon name="worktree" />
      {dropLabel(w)}
    </button>
  );
}
// A thread's card's Delete worktree / Delete branch (the old dropButton): its branch, once nothing is left on it and
// the thread is done (cleanableBranch); none otherwise.
export function ThreadDropButton({ s }: { s: Thread }) {
  useWorld();
  const w = cleanableBranch(s);
  return w ? <DropButton w={w} className="" /> : null;
}

// One pull request or branch in a list: where it stands, its title, and under it its workspace (`ws`), its number or
// branch and the one reason it's where it is; who's on it, when it last changed and how big it is on the right. With
// `task`, the task it's on, after its workspace (the Worktrees page's rows).
export function WipListRow({ x, ws = true, task = false, chip = null }: { x: Wip; ws?: boolean; task?: boolean; chip?: ReactNode }) {
  const st = wipStatus(x);
  const pr = x.kind === "pr";
  const ref = pr ? (
    <span className="wl-ref">
      #{x.number}
      {x.pr.state === "draft" && st.k !== "draft" ? " draft" : ""}
    </span>
  ) : (
    <span className="wl-ref wl-br" title={x.worktree ? tilde(x.machine, x.worktree) : `${x.branch}, not checked out`}>
      {x.branch.replace(/^worktree-/, "")}
    </span>
  );
  const why = st.why ? <span className={`wl-why${st.tone ? ` is-${st.tone}` : ""}`}>{st.why}</span> : null;
  const at = x.at ? <time title={new Date(x.at).toLocaleString()}>{ago(x.at)}</time> : null;
  // A project that isn't a workspace says which folder it is.
  const where = !ws ? null : wipWs(x) ? (
    <span className="wl-ws">{wipWsName(x)}</span>
  ) : (
    <span className="wl-ws is-loose" title={`Not a workspace${many() ? `, on ${x.machine}` : ""}`}>
      {tilde(x.machine, x.root)}
    </span>
  );
  const on = task && tasksOfPart(x)[0];
  const setChip = on ? (
    <span className="wl-set" title={`On the task ${on.text}`}>
      <Icon name="tasks" />
      <span>{on.text}</span>
    </span>
  ) : null;
  // Nothing left on its branch (a pull request's, once it's merged): deleting it is right there, beside the row.
  // (Never one of someone else's you read: it isn't yours to delete.)
  const drop = x.shared ? null : pr ? (x.local || []).find(wipCleanable) : wipCleanable(x) ? x : null;
  return (
    <li className={drop ? "wl-li--drop" : undefined}>
      <a className="wl-row" href={wipHref(x)} title={wipWhy(x)}>
        <WipWord st={st} />
        <span className="wl-t">{x.title}</span>
        <span className="wl-r">
          <WipCorner x={x} cls=" vis-corner--sm" />
          <WipWho x={x} />
          {at}
        </span>
        <span className="wl-m">
          {where}
          {setChip}
          {ref}
          {why}
          {chip}
        </span>
        {pr && (x.pr.add || x.pr.del) ? (
          <span className="wl-size">
            <ChgSize add={x.pr.add} del={x.pr.del} />
          </span>
        ) : null}
      </a>
      {drop ? (
        <span className="wl-side">
          <DropButton w={drop} />
        </span>
      ) : null}
    </li>
  );
}

// Which lists have their landed, merged or closed ones showing (the old S.wipClear), by the list's key.
export const useWipClear = create<{ open: Record<string, boolean> }>(() => ({ open: {} }));
// Under a list with Open picked: what's landed, merged or closed, folded away until it's asked for.
export function WipDoneFold({ k, n }: { k: string; n: number }) {
  const open = useWipClear((s) => !!s.open[k]);
  if (!n) return null;
  return (
    <button className="wl-more" type="button" aria-expanded={open} onClick={() => useWipClear.setState((s) => ({ open: { ...s.open, [k]: !s.open[k] } }))}>
      <Icon name={open ? "up" : "down"} />
      {open ? "Fold away" : "Show"} the {n} landed, merged or closed
    </button>
  );
}
export { plural };
