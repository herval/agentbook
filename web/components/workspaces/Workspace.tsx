// A workspace's page, in parts. It's laid out as an agent's profile: what it is and what's going on in it (WsHead);
// its threads, under a composer that starts one in it, or its worktrees (WsWip); and on the side, where it's checked
// out (WsAbout), the agents that work in it (WsAgents), its tasks and the pages its threads were for (WsPages). Its
// Settings go over the page (WsSettings). Someone else's, by its link, is WsSeen.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { agentName, many, onGitHub, presence, repoName, tildeOn } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, hueVars, pageStyle, plural, webUrl } from "../../lib/format.ts";
import { useDraft } from "../../lib/hooks.ts";
import { agentHref, pageHref, personHref, workspaceHref } from "../../lib/route.ts";
import { agentOf, setApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { Thread, WorkspaceSeen } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";
import { ThreadRow } from "../ThreadRow.tsx";
import { LevelChip, VisCorner, WsCorner, levelOf } from "../Visibility.tsx";
import { sharedWips } from "../worktrees/ship.ts";
import { WipDoneFold, WipListRow, useWipClear } from "../worktrees/WipRow.tsx";
import { ghNote, wipOrder, wipsIn } from "../worktrees/wips.ts";
import type { Ws } from "../worktrees/wips.ts";

// A workspace of yours as the chrome has it, with what the server counts of it: its threads (`counts`), the agents
// that worked in it, and the pages its threads were for.
export type WsFull = Ws & {
  counts?: { threads?: number; done?: number; running?: number; needs?: number; idle?: number };
  agents?: { id: string | null; threads: number; running?: number; last: string }[];
  pages?: string[];
};

function Kind({ w }: { w: { repo?: string | null } }) {
  if (!w.repo) return <>A folder</>;
  if (onGitHub(w))
    return (
      <>
        A repo on GitHub,{" "}
        <a href={`https://${w.repo}`} target="_blank" rel="noopener">
          {repoName(w.repo)}
        </a>
      </>
    );
  return <>A repo, {repoName(w.repo)}</>;
}
// Under a workspace on GitHub whose pull requests can't be read because of how it's connected: the way to fix that.
export function GhFix({ ws }: { ws: Ws | null | undefined }) {
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

// A pointer pressed somewhere, until its click: leaving the name's box then saves it only once the click is done, so
// what was pressed is still where it was.
let pressing = false;
document.addEventListener("pointerdown", () => (pressing = true), true);
document.addEventListener("click", () => (pressing = false), true);

// Its name renames it: clicked, it's a box with the name in it. Enter or leaving the box saves it, Esc doesn't.
function WsName({ w }: { w: WsFull }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useDraft(`ws-${w.id}`);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;
  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);
  // Done renaming: what was typed goes, and leaving the box (Esc blurs it) no longer saves.
  const stop = () => {
    editingRef.current = false;
    setDraft("");
    setEditing(false);
  };
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const name = (input.current?.value || "").trim();
    if (!name) return input.current?.focus();
    const r = await post(`/api/workspaces/${encodeURIComponent(w.id)}`, { name });
    if (r.ok) {
      stop();
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  };
  if (!editing)
    return (
      <h1>
        <button
          className="ws-name"
          type="button"
          title="Rename it"
          onClick={() => {
            setDraft(w.name);
            setEditing(true);
          }}
        >
          {w.name}
          <Icon name="pencil" />
        </button>
      </h1>
    );
  return (
    <form
      ref={form}
      className="ws-rename ws-rename--h"
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        stop();
        (e.target as HTMLElement).blur();
      }}
      onBlur={(e) => {
        if (form.current?.contains(e.relatedTarget as Node | null)) return;
        const done = () => {
          if (!editingRef.current || form.current?.contains(document.activeElement)) return;
          const name = (input.current?.value || "").trim();
          if (name && name !== w.name) return void save();
          stop();
        };
        if (pressing) document.addEventListener("click", () => setTimeout(done), { once: true });
        else done();
      }}
    >
      <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} aria-label="Workspace name" required />
      <button className="icon-btn" type="submit" aria-label="Save the name" title="Save">
        <Icon name="check" />
      </button>
    </form>
  );
}

export function WsHead({ w, tab, onSettings }: { w: WsFull; tab: string; onSettings: () => void }) {
  useWipClear((s) => s.open);
  const c = w.counts || {};
  const [running, needs, idle] = [c.running || 0, c.needs || 0, c.idle || 0];
  const open = wipsIn(w).filter((x) => x.state !== "clear").length;
  const tabLink = (t: string, label: string, count: number) => (
    <a className={tab === t ? "is-on" : ""} href={workspaceHref(w.id, t)}>
      {label}
      {count ? <span className="n">{count}</span> : null}
    </a>
  );
  return (
    <>
      <div className="prof-head ws-head">
        <span className="pg-hero ws-hero">
          <Icon name={w.repo ? "repo" : "folder"} />
        </span>
        <div className="prof-name">
          <WsName w={w} />
          <p>
            <Kind w={w} />
          </p>
          <div className="prof-now">
            {running ? (
              <span className="chip chip--live">
                <i className="pulse" />
                {plural(running, "thread")} running
              </span>
            ) : null}
            {needs ? (
              <span className="chip chip--sun">
                {needs} need{needs === 1 ? "s" : ""} you
              </span>
            ) : null}
            {idle ? <span className="chip">{idle} idle</span> : null}
            {running || needs || idle ? null : <span className="chip">Nothing running</span>}
            {open ? (
              <a className="chip" href={workspaceHref(w.id, "worktrees")}>
                <Icon name="branch" />
                {plural(open, "worktree")} open
              </a>
            ) : null}
          </div>
        </div>
        <div className="prof-acts">
          <button className="btn btn--line" type="button" onClick={onSettings}>
            <Icon name="gear" />
            Settings
          </button>
          <WsCorner w={w} cls=" vis-corner--head" />
        </div>
      </div>
      <nav className="tabs" aria-label="Workspace">
        {tabLink("threads", "Threads", c.threads || 0)}
        {tabLink("worktrees", "Worktrees", open)}
      </nav>
    </>
  );
}

// Its Settings, over the page: keeping it out of agent search, and taking it off your list. It shows the workspace
// whose page you're on, and closes when you leave it, or it's removed.
export function WsSettings({ w, open, onClose, onRemoved }: { w: WsFull; open: boolean; onClose: () => void; onRemoved: () => void }) {
  const [removing, setRemoving] = useState(false);
  useEffect(() => void (open || setRemoving(false)), [open]);
  // Keep a workspace out of agent search.
  const search = async (off: boolean) => {
    const r = await post<{ search_off?: boolean }>(`/api/workspaces/${encodeURIComponent(w.id)}/search`, { off });
    if (!r.ok) return void toast(r.data.error || "That didn't save. Try again.");
    setApp((s) => (s.data?.workspaces ? { data: { ...s.data, workspaces: s.data.workspaces.map((x) => (x.id === w.id ? (r.data.search_off ? { ...x, search_off: true as const } : (({ search_off: _, ...rest }) => rest)(x)) : x)) } } : {}));
  };
  const remove = async () => {
    const r = await post(`/api/workspaces/${encodeURIComponent(w.id)}/delete`, {});
    setRemoving(false);
    if (r.ok) onRemoved();
  };
  return (
    <Dialog open={open} onClose={onClose} className="viewer modal" label="Workspace settings">
      <header className="viewer-h">
        <span className="viewer-t">
          <b>Settings</b>
          <small>{w.name}</small>
        </span>
        <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" title="Close" autoFocus>
          <Icon name="x" />
        </button>
      </header>
      <div className="modal-body">
        <section className="modal-sec">
          <label className="switch switch--flush">
            <input type="checkbox" role="switch" checked={!!w.search_off} onChange={(e) => search(e.target.checked)} />
            <span className="track" aria-hidden="true" />
            <span>
              <b>Keep out of agent search</b>
              <small>Agents outside it can't find or read its threads. The search box doesn't change.</small>
            </span>
          </label>
        </section>
        <section className="modal-sec modal-row">
          <span>
            <b>Remove from your workspaces</b>
            <small>Its folders and threads stay as they are.</small>
          </span>
          <span className="modal-acts">
            {removing ? (
              <>
                <button className="btn btn--dark" type="button" onClick={remove}>
                  Remove it
                </button>
                <button className="btn" type="button" onClick={() => setRemoving(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="btn btn--line" type="button" onClick={() => setRemoving(true)}>
                <Icon name="x" />
                Remove
              </button>
            )}
          </span>
        </section>
      </div>
    </Dialog>
  );
}

// Its checkouts, without the worktrees inside them (its worktrees have those).
const wsCheckouts = (w: Ws) => w.checkouts.filter((c) => !w.checkouts.some((o) => o !== c && o.machine === c.machine && c.root.startsWith(`${o.root}/`)));
// Where it's checked out (or being cloned), how many threads it has, and when you added it.
export function WsAbout({ w }: { w: WsFull }) {
  const outs = wsCheckouts(w);
  const trees = w.checkouts.length - outs.length;
  const where = (machine: string, dir: string) => (
    <>
      <b>{tildeOn(machine, dir)}</b>
      {many() ? ` on ${machine}` : ""}
    </>
  );
  const cloning = w.cloning || [];
  return (
    <section className="card box">
      <h3>About</h3>
      <ul className="facts">
        {outs.length ? (
          <li>
            <Icon name="folder" />
            <span>
              {w.repo ? "Checked out in" : "In"}{" "}
              {outs.map((c, i) => (
                <span key={`${c.machine}:${c.root}`}>
                  {i ? ", " : ""}
                  {where(c.machine, c.root)}
                </span>
              ))}
              {trees ? `, and ${plural(trees, "worktree")}` : ""}
            </span>
          </li>
        ) : cloning.length ? null : (
          <li>
            <Icon name="folder" />
            <span>Not on any of your machines yet</span>
          </li>
        )}
        {cloning.map((c, i) => (
          <li key={i}>
            <Icon name="cloud" />
            <span>{c.error ? c.error : <>Cloning into {where(c.machine, c.dir)}</>}</span>
          </li>
        ))}
        <li>
          <Icon name="steps" />
          <span>
            <b>{plural(w.counts?.threads || 0, "thread")}</b>, {w.counts?.done || 0} idle
          </span>
        </li>
        {w.created && (
          <li>
            <Icon name="clock" />
            <span>Added {agoText(w.created)}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

export function WsAgents({ w }: { w: WsFull }) {
  useApp((s) => s.data?.agents);
  const list = (w.agents || []).filter((x) => x.id != null);
  if (!list.length) return null;
  return (
    <section className="card box related">
      <h3>Agents in it</h3>
      {list.map(({ id, threads, running, last }) => (
        <a key={id} href={agentHref(id)} style={hueVars(id)}>
          <Avatar agent={id} size="av--sm" on={presence(agentOf(id))} />
          <span>
            <b>{agentName(id)}</b>
            <small>
              {plural(threads, "thread")}
              {running ? `, ${running} running` : ""}, the last {agoText(last)}
            </small>
          </span>
        </a>
      ))}
    </section>
  );
}

export function WsPages({ w }: { w: WsFull }) {
  const pages = useApp((s) => s.data?.pages);
  const ids = new Set(w.pages || []);
  const list = (pages || []).filter((p) => ids.has(p.id) && !p.archived);
  if (!list.length) return null;
  return (
    <section className="card box related">
      <h3>Pages</h3>
      {list.map((p) => (
        <a key={p.id} href={pageHref(p)} style={pageStyle(p)}>
          <span className="pg-ico">{p.emoji || "📄"}</span>
          <span>
            <b>{p.title}</b>
            <small>
              v{p.version}, {agoText(p.updated)}
            </small>
          </span>
        </a>
      ))}
    </section>
  );
}

export function WsWip({ w }: { w: WsFull }) {
  const folders = useApp((s) => s.data?.folders);
  const key = `ws:${w.id}`;
  const showDone = useWipClear((s) => !!s.open[key]);
  const list = [...wipsIn(w)].sort(wipOrder);
  const note = ghNote(w);
  const reading = (folders || []).some((x) => x.sessions && !("wip" in x));
  const open = list.filter((x) => x.state !== "clear");
  const done = list.filter((x) => x.state === "clear");
  const rows = [...open, ...(showDone ? done : [])];
  return (
    <section className="card wips">
      <div className="page-head">
        <h2 className="page-h">Worktrees</h2>
        {note && (
          <small className={w.pulls?.error ? "wl-err" : "muted"} title={w.pulls?.error || ""}>
            {note}
            <GhFix ws={w} />
          </small>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="wl-list">
          {rows.map((x) => (
            <WipListRow key={x.id} x={x} ws={false} />
          ))}
        </ul>
      )}
      <WipDoneFold k={key} n={done.length} />
      {list.length || note ? null : <p className="muted wl-empty">{reading ? "Reading git…" : "No worktrees with work left: everything its threads worked on is on main."}</p>}
    </section>
  );
}

// Someone else's workspace, by its link: what it is, the worktrees of it you may see, to read
// only (each opens its page, read through the workspace's routes), and the threads in it you'd see anyway. A
// worktree of it you see without seeing it shows without its name.
export function WsSeen({ id, seen }: { id: string; seen: WorkspaceSeen }) {
  const w = seen.workspace;
  const parts = seen.parts || [];
  const trees = sharedWips({ id, parts, via: "workspaces" });
  // A worktree's own level, when it isn't its workspace's (a public one in a private workspace).
  const own = (part: string) => levelOf(parts.find((p) => p.id === part)?.visibility);
  const threads: Thread[] = seen.threads || [];
  return (
    <>
      <p className="crumbs">
        <a href={personHref(w.owner)}>@{w.owner}</a>
        <span className="sep">/</span>
        <span>{w.name || "A worktree of theirs"}</span>
      </p>
      <div className="feed">
        <article className="card wip-page">
          {w.name && <VisCorner kind="workspace" id={w.id} level={w.visibility} mine={false} cls=" vis-corner--card" />}
          <div className="wip-ref">
            <span>
              <a className="on" href={personHref(w.owner)}>
                @{w.owner}
              </a>
              's workspace
            </span>
          </div>
          <h1 className="wip-title">{w.name || repoName(w.repo) || "A workspace"}</h1>
          <p className="muted">
            <Kind w={w} />. Only to read: it works on @{w.owner}'s machines.
          </p>
        </article>
        <section className="card wips">
          <div className="page-head">
            <h2 className="page-h">Worktrees</h2>
          </div>
          {trees.length ? (
            <ul className="wl-list">
              {trees.map((x) => (
                <WipListRow key={x.id} x={x} ws={false} chip={own(x.part) !== levelOf(w.visibility) ? <LevelChip level={own(x.part)} /> : null} />
              ))}
            </ul>
          ) : (
            <p className="muted wl-empty">None you can see.</p>
          )}
        </section>
        {w.name && (
          <section className="card tk-sec">
            <h2 className="tk-h">
              Threads<span className="n">{threads.length || ""}</span>
            </h2>
            {threads.length ? (
              <ul className="tk-threads">
                {threads.map((s) => (
                  <li key={s.id} className="tk-thread">
                    <ThreadRow thread={s} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None you can see: a thread in it shows to you by its own setting.</p>
            )}
          </section>
        )}
      </div>
    </>
  );
}
