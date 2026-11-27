// Who can see what: the levels (Private, Public), the corner of a thing's card that shows and changes its
// level (VisCorner, with its menu of the levels), the chip a card shows for it (LevelChip), each kind's corner, a
// thread's "Who can see it" card, and an agent's switch. Ported from the old page's "who can see what" section.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { post } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { useDismiss } from "../lib/hooks.ts";
import { agentOf, getApp, setApp, useAgent, useApp } from "../lib/store.ts";
import { toast } from "../lib/toast.ts";
import type { AgentRow, AgentSeen, GroupRow, Thread, Visibility, WorkspaceRow } from "../lib/types.ts";
import { groupMine, groupPeople } from "./groups/groups.ts";
import { Icon } from "./Icon.tsx";
import { PersonAvatar } from "./Avatar.tsx";
import { MenuPick } from "./MenuPick.tsx";
import type { MenuRow } from "./MenuPick.tsx";
import { personHref } from "../lib/route.ts";

// The levels (plugin/shared/visibility.ts): only you and the people you put on it, or your
// contacts too. Each with its icon and its name, and what it means where nothing says more.
export const LEVELS = ["private", "public"] as const;
export const LEVEL_SHOWN = { private: ["lock", "Private"], public: ["globe", "Public"] } as const;
export const LEVEL_WORDS: Record<Visibility, string> = { private: "only you", public: "you and your contacts" };
// Someone else's says it from where you stand: its "you" is its owner.
export const THEIR_LEVEL_WORDS: Record<Visibility, string> = { private: "its owner and the people they put on it", public: "its owner's contacts" };
// A level as it's kept: "followers", from before there were contacts, is public; anything else, or nothing, private.
export const levelOf = (v: unknown): Visibility => (v === "followers" ? "public" : LEVELS.includes(v as never) ? (v as Visibility) : "private");
export const postLevel = (s: { visibility?: Visibility | null; agent?: string | null }, a: AgentSeen = agentOf(s.agent)): Visibility => (s.visibility ? levelOf(s.visibility) : a?.visibility === "public" ? "public" : "private");

const capFirst = (t: string) => String(t || "").replace(/^./, (c) => c.toUpperCase());
// A class added to the corner's own: " vis-corner--sm" as the old page passed it, or without its space.
const plus = (cls: string) => (cls.trim() ? ` ${cls.trim()}` : "");

// A thread's or a person's thing's level, as a chip on its card (public only; private says nothing).
export function LevelChip({ level, tip }: { level: Visibility | string; tip?: string }) {
  if (levelOf(level) !== "public") return null;
  const [ic, name] = LEVEL_SHOWN.public;
  return (
    <span className="chip chip--public" title={`${name}: ${tip ?? LEVEL_WORDS.public}`}>
      <Icon name={ic} />
      {name}
    </span>
  );
}

// Who can see it, in the top-right corner of its card: its level's icon. Yours opens a menu of the levels (VisPop) that
// changes it right there; someone else's only says who sees it. `kind`: thread, talk, page, group, task, note, agent,
// workspace, or worktree (`id` its workspace's, with `branch`); `words`: what each level means for it (who's on it
// besides you, while it's private); `cls`: " vis-corner--sm" in a list's row, " vis-corner--float" over a tile,
// " vis-corner--head" in a page's head, by its buttons, " vis-corner--card" in the top-right corner of a page's head
// card, " vis-corner--box" in the composer's box. `has`: what it has when it has none of its own (a thread's agent's, a
// worktree's workspace's): picking it goes back to being as that. `foot`: a line under the levels; `after`: words after
// the toast's. `label`: the level's name and a caret by its icon, as a button in a form's row or a list of facts.
// `onPick`: a pick that isn't saved here (the composer's, the new-group form's) goes to it instead; `onSet`: told what
// was saved, for a screen that keeps its own copy.
export interface VisCornerProps {
  kind: string;
  id: string;
  level: Visibility | string | null | undefined;
  mine?: boolean;
  edit?: boolean;
  words?: Partial<Record<Visibility, string>>;
  levels?: readonly string[];
  branch?: string;
  has?: string;
  foot?: string;
  tip?: string;
  cls?: string;
  label?: boolean;
  after?: string;
  onPick?: (level: Visibility) => void;
  onSet?: (level: Visibility | null) => void;
}

// The one menu open: opening another closes it, as the old page had one.
let closeOpen: (() => void) | null = null;

export function VisCorner({ kind, id, level, mine = true, edit = mine, words = {}, levels = LEVELS, branch = "", has = "", foot = "", tip = "", cls = "", label = false, after = "", onPick, onSet }: VisCornerProps) {
  const [open, setOpen] = useState(false);
  // What you just picked shows at once, until what it's given says it changed (the stream brings the rest).
  const [picked, setPicked] = useState<{ from: unknown; to: Visibility } | null>(null);
  const btn = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pop = useDismiss<HTMLDivElement>(open, close);
  const lv = picked && picked.from === level ? picked.to : levelOf(level);
  const [ic, name] = LEVEL_SHOWN[lv];
  const all = { ...LEVEL_WORDS, ...words };
  const says = tip || `${name}: ${mine ? all[lv] : THEIR_LEVEL_WORDS[lv]}`;

  // While it's open: the only one open, put by its corner (under it, or over it with no room below), its level's row
  // focused; scrolling anything else, resizing the window or going elsewhere closes it.
  useLayoutEffect(() => {
    const el = pop.current;
    const b = btn.current;
    if (!open || !el || !b) return;
    const r = b.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    el.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    el.querySelector<HTMLElement>(".is-on")?.focus({ preventScroll: true });
  }, [open, pop]);
  useEffect(() => {
    if (!open) return;
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    const scroll = (e: Event) => !pop.current?.contains(e.target as Node) && close();
    window.addEventListener("scroll", scroll, { passive: true, capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("hashchange", close);
    return () => {
      if (closeOpen === close) closeOpen = null;
      window.removeEventListener("scroll", scroll, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("hashchange", close);
    };
  }, [open, close, pop]);

  if (!edit)
    return (
      <span className={`vis-corner is-ro${plus(cls)}`} title={says} aria-label={says}>
        <Icon name={ic} />
      </span>
    );

  // Its card may be a link: a click on the corner opens its menu (or closes it), and goes no further.
  const toggle = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!open);
  };
  // Open, a press on it closes it (its click), rather than the press outside closing it and the click opening it again.
  const press = (e: ReactMouseEvent) => open && e.stopPropagation();
  // Picking a level: a pick kept elsewhere goes there; else it's saved, and shows at once.
  const pick = async (to: Visibility) => {
    close();
    if (to === lv) return;
    if (onPick) return onPick(to);
    const from = level;
    const r = await setVisOf({ kind, id, branch, has, after, words: all }, to);
    if (r === false) return;
    setPicked({ from, to });
    onSet?.(r);
  };
  const shown = levels.filter((l): l is Visibility => LEVELS.includes(l as never));
  return (
    <>
      <span
        ref={btn}
        className={`${label ? "btn vis-pick" : "vis-corner"} is-${lv}${plus(cls)}`}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Who can see it: ${says}`}
        title={`${says}. Change it`}
        data-vis-corner=""
        onMouseDown={press}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(e)}
      >
        <Icon name={ic} />
        {label && (
          <>
            {name}
            <Icon name="down" className="caret" />
          </>
        )}
      </span>
      {open &&
        createPortal(
          <VisPop popRef={pop} levels={shown} level={lv} words={all} foot={foot} onPick={pick} onClose={close} />,
          document.body,
        )}
    </>
  );
}

// The menu a corner opens, over the page (not in its card, which may be a link): the levels, each with what it means
// here, the one it has ticked. Picking one changes it (setVisOf); a click anywhere else, Escape or scrolling closes it.
// What happens in it stays in it: the card it's drawn from never hears of its clicks and keys.
function VisPop({ popRef, levels, level, words, foot, onPick, onClose }: { popRef: RefObject<HTMLDivElement | null>; levels: Visibility[]; level: Visibility; words: Record<Visibility, string>; foot: string; onPick: (lv: Visibility) => void; onClose: () => void }) {
  // Up and down move between the levels; Escape closes it.
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") return onClose();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".fb-row")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    rows[(i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
    e.preventDefault();
  };
  return (
    <div className="fb-menu vis-pop" role="menu" aria-label="Who can see it" ref={popRef} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onKeyDown={keys}>
      <p className="vis-pop-h">Who can see it</p>
      <div className="fb-list">
        {levels.map((lv) => (
          <button
            key={lv}
            className={`fb-row fb-row--one${lv === level ? " is-on" : ""}`}
            type="button"
            role="menuitemradio"
            aria-checked={lv === level}
            onClick={(e) => {
              e.preventDefault();
              onPick(lv);
            }}
          >
            <Icon name={LEVEL_SHOWN[lv][0]} />
            <span className="vis-pop-t">
              <span className="fb-nm">{LEVEL_SHOWN[lv][1]}</span>
              <span className="fb-n">{capFirst(words[lv])}</span>
            </span>
            <span className="fb-on">{lv === level && <Icon name="check" />}</span>
          </button>
        ))}
      </div>
      {foot && <p className="vis-pop-f">{foot}</p>}
    </div>
  );
}

// What a corner's pick changes: what it is, and what its menu said each level means.
interface VisWrite {
  kind: string;
  id: string;
  branch?: string;
  has?: string;
  after?: string;
  words: Record<Visibility, string>;
}
// The route each kind's level is changed at (a workspace's and a worktree's are setWsVis's).
const ROUTES: Record<string, (at: string) => string> = {
  thread: (at) => `/api/sessions/${at}/visibility`,
  talk: (at) => `/api/talks/${at}`,
  page: (at) => `/api/pages/${at}/visibility`,
  group: (at) => `/api/groups/${at}/visibility`,
  task: (at) => `/api/tasks/${at}/visibility`,
  agent: (at) => `/api/agents/${at}/visibility`,
  note: (at) => `/api/notes/${at}/visibility`,
};

// What changes who sees a workspace, or one of its worktrees; the chrome's copy says so at once.
async function setWsVis(id: string, body: { visibility: Visibility | null; branch?: string }) {
  const r = await post<{ visibility?: WorkspaceRow["visibility"]; worktrees?: Record<string, Visibility> }>(`/api/workspaces/${encodeURIComponent(id)}/visibility`, body);
  if (r.ok) setApp((s) => (s.data?.workspaces ? { data: { ...s.data, workspaces: s.data.workspaces.map((w) => (w.id === id ? { ...w, visibility: r.data.visibility, worktrees: r.data.worktrees } : w)) } } : {}));
  return r;
}

// The copies of a thing the page holds (the chrome's tasks, pages, groups and notes, the thread rows, the feed's
// records, the thread open) take its new level at once; the stream brings the rest.
function patchCopies(id: string, visibility: Visibility | null) {
  setApp((s) => {
    const list = <T extends { id: string }>(l: T[] | undefined): T[] | undefined => (l?.some((x) => x.id === id) ? l.map((x) => (x.id === id ? { ...x, visibility } : x)) : l);
    const d = s.data;
    const records = s.feed && { ...s.feed.records };
    for (const k of [`thread:${id}`, `page:${id}`]) if (records?.[k]) records[k] = { ...records[k], visibility };
    return {
      ...(d ? { data: { ...d, tasks: list(d.tasks), pages: list(d.pages), groups: list(d.groups), notes: list(d.notes) } } : {}),
      ...(s.rows[id] ? { rows: { ...s.rows, [id]: { ...s.rows[id], visibility } } } : {}),
      ...(s.more[id] ? { more: { ...s.more, [id]: { ...s.more[id], visibility } } } : {}),
      ...(records ? { feed: { ...s.feed, records } } : {}),
      ...(s.open?.id === id && s.open.detail ? { open: { ...s.open, detail: { ...s.open.detail, visibility } } } : {}),
    };
  });
}

// Changing it: the same routes each page's own picker uses, and the copies here say so at once (the stream brings
// the rest). A thread or worktree set to what its agent or workspace has goes back to being as it (null). What it
// saved, or false when it couldn't (post said why).
async function setVisOf(d: VisWrite, visibility: Visibility): Promise<Visibility | null | false> {
  const at = encodeURIComponent(d.id);
  const set = d.has && visibility === d.has ? null : visibility;
  const ws = d.kind === "worktree" || d.kind === "workspace";
  if (!ws && !ROUTES[d.kind]) return false;
  const r = ws ? await setWsVis(d.id, d.kind === "worktree" ? { visibility: set, branch: d.branch } : { visibility: set }) : await post(ROUTES[d.kind](at), { visibility: set });
  if (!r.ok) return false; // post said why
  // An agent (AgentVisSwitch): its threads follow it, unless set themselves.
  if (d.kind === "agent") {
    setApp((s) => (s.data ? { data: { ...s.data, agents: s.data.agents.map((a) => (a.id === d.id ? { ...a, visibility: visibility as AgentRow["visibility"] } : a)) } } : {}));
    const own = getApp().data?.agents.find((x) => x.id === d.id)?.public_threads || 0;
    toast(visibility === "public" ? "Public: your contacts can see it, and its threads unless you make one private." : `Private: only you can see it and its threads${own ? `, except the ${plural(own, "thread")} you made public, which your contacts see without it` : ""}.`);
    return set;
  }
  if (!ws) patchCopies(d.id, set);
  toast(`${LEVEL_SHOWN[visibility][1]}: ${d.words[visibility]} can see it now.${d.after || ""}`);
  return set;
}

// Each kind's corner. A thread of an agent's: yours, its level (its own, else its agent's), and the people you put on
// it see it while it's private; someone else's, how you see it.
export function ThreadCorner({ s, cls = "" }: { s: Thread; cls?: string }) {
  const a = useAgent(s.agent);
  if (s.mine === false) return <VisCorner kind="thread" id={s.id} level={s.public ? "public" : "private"} mine={false} cls={cls} tip={s.public ? "Public: you see it as their contact" : "Private: they put you on it"} />;
  return <VisCorner kind="thread" id={s.id} level={postLevel(s, a)} cls={cls} has={a.visibility === "public" ? "public" : "private"} words={{ private: s.people?.length ? "you and the people you put on it" : "only you" }} />;
}
// A thread of your own (a talk): the people you put on it see it while it's private.
export const TalkCorner = ({ s, cls = "", label = false }: { s: Pick<Thread, "id" | "visibility" | "mine" | "people">; cls?: string; label?: boolean }) => <VisCorner kind="talk" id={s.id} level={s.visibility} mine={s.mine !== false} cls={cls} label={label} words={{ private: s.people?.length ? "you and the people you put on it" : "only you" }} />;
// A page: its contributors see it too.
export const PageCorner = ({ page, cls = "" }: { page: { id: string; visibility?: Visibility | null; mine?: boolean }; cls?: string }) => <VisCorner kind="page" id={page.id} level={page.visibility} mine={!!page.mine} cls={cls} words={{ private: "you and its contributors", public: "you, its contributors and your contacts" }} />;
// A group: the people in it see it; an archived one's stays as it was.
export const GroupCorner = ({ g, cls = "" }: { g: GroupRow; cls?: string }) => <VisCorner kind="group" id={g.id} level={g.visibility} mine={groupMine(g)} edit={groupMine(g) && !g.archived} cls={cls} words={{ private: groupPeople(g).length ? "you and the people in it" : "only you", public: `${groupPeople(g).length ? "you, the people in it" : "you"} and your contacts` }} />;
// A task: the people on it see it. A to-do a thread keeps (a task with `scope`) has none: it's on no one's list to
// share.
export const TaskCorner = ({ task, cls = "" }: { task: { id: string; visibility?: Visibility | null; scope?: unknown; mine?: boolean; people?: readonly unknown[] }; cls?: string }) => (task.scope ? null : <VisCorner kind="task" id={task.id} level={task.visibility} mine={task.mine !== false} cls={cls} words={{ private: task.people?.length ? "you and the people on it" : "only you", public: `${task.people?.length ? "you, the people on it" : "you"} and your contacts` }} />);
// A note: the people on it see it; an archived one's stays as it was.
export const NoteCorner = ({ n, cls = "" }: { n: { id: string; visibility?: Visibility | null; mine?: boolean; archived?: boolean | string | null; people?: readonly unknown[] }; cls?: string }) => (
  <VisCorner kind="note" id={n.id} level={n.visibility} mine={n.mine !== false} edit={n.mine !== false && !n.archived} cls={cls} words={{ private: n.people?.length ? "you and the people on it" : "only you", public: `${n.people?.length ? "you, the people on it" : "you"} and your contacts` }} />
);
// A workspace: its worktrees go with it, unless set otherwise.
export const WsCorner = ({ w, cls = "" }: { w: { id: string; visibility?: Visibility | null }; cls?: string }) => <VisCorner kind="workspace" id={w.id} level={w.visibility} cls={cls} after=" Its worktrees go with it, unless set otherwise." />;
// A worktree of yours in a workspace of yours (`ws`, its id): as its workspace, unless it has its own; picking what the
// workspace has goes back to being as it. Others who may see it read its commits, changes and pull request, never its
// folder.
export function TreeCorner({ ws, branch, cls = "" }: { ws: string; branch: string; cls?: string }) {
  const w = useApp((s) => s.data?.workspaces?.find((x) => x.id === ws));
  if (!w || !branch) return null;
  const own = w.worktrees?.[branch];
  const wsLevel = levelOf(w.visibility);
  const foot = `${own == null ? `As ${w.name}, which is` : `Set for this worktree. ${w.name} is`} ${LEVEL_SHOWN[wsLevel][1].toLowerCase()}.${levelOf(own ?? w.visibility) !== "private" ? " Others read its commits, changes and pull request, never where it's checked out." : ""}`;
  return <VisCorner kind="worktree" id={w.id} level={own ?? w.visibility} branch={branch} has={wsLevel} cls={cls} foot={foot} />;
}

// An agent you own: private (only you) or public (your contacts). Its posts go with it, unless set themselves.
// Deactivated or active. `quiet`: no toast for the switch (the Agents list's edit mode).
export function AgentVisSwitch({ a, quiet = false }: { a: AgentSeen; quiet?: boolean }) {
  return (
    <>
      <VisCorner kind="agent" id={a.id} level={a.visibility === "public" ? "public" : "private"} levels={["private", "public"]} cls="vis-corner--head" words={{ private: "only you, and its threads unless you make one public", public: "your contacts, and its threads unless you make one private" }} />
      {a.hidden ? (
        <button className="btn btn--line" type="button" title="Activate this agent to start new threads and show it in your sidebar and feed." onClick={() => hideAgent(a.id, false, quiet)}>
          <Icon name="eye" />
          Activate
        </button>
      ) : (
        <button className="btn btn--line" type="button" title="Prevent new threads and hide this agent from your sidebar and feed. Existing threads continue." onClick={() => hideAgent(a.id, true, quiet)}>
          <Icon name="eyeOff" />
          Deactivate
        </button>
      )}
    </>
  );
}
// The stored hidden setting also prevents new threads. Every switch updates both views immediately.
export async function hideAgent(id: string, hidden: boolean, quiet = false) {
  const r = await post(`/api/agents/${encodeURIComponent(id)}/hidden`, { hidden });
  if (r.ok) {
    setApp((s) => s.data?.agents ? { data: { ...s.data, agents: s.data.agents.map((a) => a.id === id ? { ...a, hidden, inactive: hidden } : a) } } : {});
    if (!quiet) toast(hidden ? `${agentOf(id).name} is deactivated. New threads are blocked; existing threads continue.` : `${agentOf(id).name} is active and can start new threads again.`);
  }
  return r;
}

// A thread back to being as its agent ("Be as Claude instead").
export async function setPostVis(id: string, visibility: Visibility | null) {
  const r = await post(`/api/sessions/${encodeURIComponent(id)}/visibility`, { visibility });
  if (r.ok) patchCopies(id, visibility);
  return r;
}

// The people you put on a thread of yours: each sees it while it's private, with its steps and changes, and hears of it
// on their bell. Only your contacts can be put on one.
export function ThreadPeople({ s }: { s: Pick<Thread, "id" | "people"> }) {
  const people = useApp((x) => x.people);
  const [list, setList] = useState(s.people || []);
  useEffect(() => setList(s.people || []), [s.people]);
  const on = new Set(list.map((p) => p.user));
  const change = async (user: string, remove = false) => {
    const r = await post<{ people: NonNullable<Thread["people"]> }>(`/api/threads/${encodeURIComponent(s.id)}/people`, { user, ...(remove ? { remove: true } : {}) });
    if (!r.ok) return;
    setList(r.data.people);
    patchPeople(s.id, r.data.people);
    toast(remove ? `@${user} is off it now.` : `@${user} sees it now, with its steps and changes, and hears of it on their bell.`);
  };
  const rows: MenuRow[] = (people || []).filter((p) => p.contact && !p.deleted && !p.disabled && !on.has(p.username)).map((p) => ({ value: p.username, text: p.display_name || p.username, note: `@${p.username}`, face: <PersonAvatar who={p.username} size="av--xs" /> }));
  return (
    <div className="privacy-people">
      {list.length > 0 && (
        <ul className="privacy-who">
          {list.map((p) => (
            <li key={p.user}>
              <PersonAvatar who={p.user} size="av--xs" />
              <a href={personHref(p.user)}>{p.display_name}</a>
              <button className="chip-x" type="button" aria-label={`Take @${p.user} off it`} title={`Take @${p.user} off it`} onClick={() => change(p.user, true)}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <MenuPick
        id={`people:${s.id}`}
        label="Put someone on it"
        title="Put a contact on it: they see it while it's private"
        face={
          <>
            <Icon name="plus" />
            <span className="opt-v">Put someone on it</span>
          </>
        }
        rows={rows.length ? rows : [{ hint: "Only your contacts can be put on it, and they're all on it, or you have none yet." }]}
        none
        find
        what="contact"
        onPick={(v) => change(v)}
      />
    </div>
  );
}
// The copies of a thread the page holds take its people at once.
function patchPeople(id: string, people: NonNullable<Thread["people"]>) {
  setApp((s) => ({
    ...(s.rows[id] ? { rows: { ...s.rows, [id]: { ...s.rows[id], people } } } : {}),
    ...(s.open?.id === id && s.open.detail ? { open: { ...s.open, detail: { ...s.open.detail, people } } } : {}),
  }));
}

// A post you own: who can see it (as its agent, or its own setting), and whether others see its work. Picking
// what its agent has goes back to being as its agent ("Be as Claude instead").
export function PrivacyCard({ s }: { s: Thread }) {
  const a = useAgent(s.agent);
  const agentVis = a.visibility === "public" ? "public" : "private";
  const level = postLevel(s, a);
  const back = (
    <button className="link" type="button" onClick={() => setPostVis(s.id, null)}>
      Be as {a.name} instead
    </button>
  );
  const note =
    s.visibility == null ? (
      <>As {a.name}, which is {agentVis}.</>
    ) : level === "public" && agentVis === "private" ? (
      <>Public, though {a.name} is private: your contacts see this thread, not which agent wrote it. {back}</>
    ) : (
      <>Set for this thread. {back}</>
    );
  return (
    <section className="card rail-card privacy">
      <h3 className="rail-h">Who can see it</h3>
      <VisCorner kind="thread" id={s.id} level={level} label has={agentVis} words={{ private: s.people?.length ? "you and the people you put on it" : "only you" }} />
      <p className="privacy-note">
        {note} Whoever sees it sees its steps and changes too, never its terminal or folder.
      </p>
      <ThreadPeople s={s} />
    </section>
  );
}
