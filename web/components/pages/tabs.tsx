import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { agentName } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, hueVars, PAGE_COLORS, plural } from "../../lib/format.ts";
import { agentHref, pageHref, personHref, threadHref } from "../../lib/route.ts";
import { loadPeople } from "../../lib/session.ts";
import { agentOf, getApp, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { PageVersionRow } from "../../lib/types.ts";
import type { PageChange } from "../../../plugin/shared/types.ts";
import { KINDS } from "../agents/words.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Composer } from "../Composer.tsx";
import { RowChanges } from "../post/PageFeedCard.tsx";
import { Icon } from "../Icon.tsx";
import { RoutineItem } from "../routines/parts.tsx";
import { RoutineFormView } from "../routines/RoutineForm.tsx";
import { byRowRank, openRoutineForm, rowOfRoutine, useRoutineUi } from "../routines/routines.ts";
import { LEVEL_SHOWN, levelOf } from "../Visibility.tsx";
import { DashTab, OldPanelCard } from "./dash.tsx";
import { ByAvatar, NarrowBar, useLivePoll, WidgetGrid } from "./grid.tsx";
import { byName, contributorCount, isDash, onPageMachine, pagePost, pageThreadIds, routineName, when, writesPages } from "./pages.ts";
import type { PageRec } from "./pages.ts";
import { changeEdit, getPageUi, setPageUi, useEdit, usePageDetail, usePageUi } from "./state.ts";
import { AskedElsewhere, saidAsked } from "../people/AskedElsewhere.tsx";

// Restoring a version saves the page as it was then, as a new version. Undo in a thread beside the page (`stay`)
// stays there; anywhere else, Versions opens.
export function RestoreBtn({ p, v, stay = false, className, title, children }: { p: PageRec; v: number; stay?: boolean; className: string; title?: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    const res = await post<{ changed?: boolean; version: number }>(`/api/pages/${encodeURIComponent(p.id)}/restore`, { v });
    if (!res.ok) return setBusy(false);
    toast(res.data.changed ? `Restored v${v}, as v${res.data.version}. Nothing is lost: what came between stays in its versions.` : `The page is already as it was at v${v}.`);
    if (!stay) location.hash = pageHref(p, "versions");
    setBusy(false);
  };
  return (
    <button className={className} type="button" disabled={busy} title={title} onClick={restore}>
      {children}
    </button>
  );
}

// The page as it is (or was, at a version). With its threads bar, the box to start a thread is in the bar.
export function PageTab({ p, bar = false }: { p: PageRec; bar?: boolean }) {
  const e = useEdit(p);
  const r = useApp((s) => s.route);
  const atV = usePageUi((s) => s.at);
  useLivePoll(p.id);
  const at = r.tab === "at" ? Number(r.v) : null;
  if (at && at !== p.version) {
    const v = atV?.v === at && atV.page === p.id ? atV : null;
    if (!v)
      return (
        <div className="pg-body">
          <p className="muted">Loading v{at}…</p>
        </div>
      );
    if (v.missing)
      return (
        <div className="pg-body">
          <section className="card empty-card">
            <p>v{at} isn't kept any more: a page keeps its newest 300 versions.</p>
            <a className="btn" href={pageHref(p, "versions")}>
              Its versions
            </a>
          </section>
        </div>
      );
    const banner = (
      <div className="ver-banner">
        <Icon name="history" />
        <p>
          You're looking at <b>v{v.v}</b>, from {when(v.at)}, by {byName(p, v.by)}.{isDash(p) ? " Its panels as they asked then: their answers are only ever for now." : ""}
        </p>
        {p.can_edit ? (
          <RestoreBtn p={p} v={v.v} className="btn btn--dark btn--sm">
            <Icon name="undo" />
            Restore v{v.v}
          </RestoreBtn>
        ) : null}
        <a className="btn btn--sm" href={pageHref(p)}>
          Back to v{p.version}
        </a>
      </div>
    );
    if (isDash(p))
      return (
        <div className="pg-body">
          {banner}
          <WidgetGrid p={p} widgets={v.snapshot.widgets} latest={false} card={OldPanelCard} />
        </div>
      );
    return (
      <div className="pg-body">
        {banner}
        <NarrowBar p={p} filters={r.filters || {}} />
        <WidgetGrid p={p} widgets={v.snapshot.widgets} latest={false} filters={r.filters || {}} />
      </div>
    );
  }
  if (isDash(p)) return <DashTab p={p} bar={bar} />;
  const widgets = e ? e.widgets : p.widgets;
  const filters = e ? {} : r.filters || {};
  const inner = (
    <>
      {/* The people who keep it (its owner and the people among its contributors) start threads on it, on their own agents. */}
      {!bar && !e && p.can_edit && !p.archived ? <Composer page={p.id} /> : null}
      {e ? (
        <form className="card pe-meta" onSubmit={(x) => x.preventDefault()}>
          <span className="pe-emoji">
            <input value={e.emoji} aria-label="Its emoji" title="Its emoji" onChange={(x) => changeEdit(() => ({ emoji: x.target.value }))} />
          </span>
          <input className="pe-title" value={e.title} aria-label="Its title" onChange={(x) => changeEdit(() => ({ title: x.target.value }))} />
          <input className="pe-about" value={e.about} placeholder="What it keeps track of" aria-label="What it keeps track of" onChange={(x) => changeEdit(() => ({ about: x.target.value }))} />
          <p className="muted">Editing by hand. Saving makes it v{p.version + 1}; what an agent writes meanwhile stays, except on the widgets you change.</p>
        </form>
      ) : null}
      {!widgets.length && !e ? (
        <section className="card empty-card">
          <h2>Nothing on it yet</h2>
          <p>{p.can_edit ? `Ask an agent ${bar ? "in its threads" : "above"} to fill it in, or edit it by hand.` : "Its contributors haven't added anything yet."}</p>
        </section>
      ) : null}
      <NarrowBar p={p} filters={filters} />
      {widgets.length || e ? <WidgetGrid p={p} widgets={widgets} edit={e} filters={filters} /> : null}
    </>
  );
  return bar ? inner : <div className={`pg-body${e ? " is-editing" : ""}`}>{inner}</div>;
}

export function VersionsTab({ p }: { p: PageRec }) {
  const detail = usePageDetail(p);
  const r = useApp((s) => s.route);
  const all = usePageUi((s) => s.allVersions);
  const verOpen = usePageUi((s) => s.verOpen);
  useApp((s) => s.rows);
  const history = detail?.history;
  if (!history)
    return (
      <div className="pg-body">
        <p className="muted">Loading its versions…</p>
      </div>
    );
  const sel = Number(r.v) || p.version;
  const cur = history.find((v) => v.v === sel) || history[0];
  // A restore undid what came between the version it brought back and itself.
  const undone: Record<number, number> = {};
  for (const v of history) if (v.restored) for (const u of history) if (u.v > v.restored && u.v < v.v) undone[u.v] ??= v.v;
  const shown = all ? history : history.slice(0, 40);
  const row = (v: PageVersionRow) => {
    const post = pagePost(p, v.by);
    return (
      <a key={v.v} className={`ver${v.v === cur?.v ? " is-on" : ""}`} href={pageHref(p, `versions/${v.v}`)}>
        <ByAvatar p={p} by={v.by} size="av--sm" />
        <span className="ver-t">
          <b>v{v.v}</b>
          <span>{v.summary}</span>
        </span>
        <span className="ver-m">
          <span>{byName(p, v.by)}</span>
          {post ? <span className="chip">{post.label}</span> : v.hand ? <span>by hand</span> : null}
          <span>{agoText(v.at)}</span>
          {v.v === p.version ? <span className="ver-tag ver-tag--latest">Latest</span> : null}
          {v.restored ? <span className="ver-tag ver-tag--restore">Restored v{v.restored}</span> : null}
          {undone[v.v] ? <span className="ver-tag ver-tag--undone">Undone by v{undone[v.v]}</span> : null}
        </span>
      </a>
    );
  };
  // A routine's refreshes in a row fold into one row, which opens.
  const rows: ReactNode[] = [];
  for (let i = 0; i < shown.length; ) {
    const v = shown[i];
    let j = i;
    while (v.by?.routine && j + 1 < shown.length && shown[j + 1].by?.routine === v.by.routine) j++;
    const run = shown.slice(i, j + 1);
    if (run.length >= 3 && !run.some((x) => x.v === cur?.v || x.v === p.version) && !verOpen[v.v])
      rows.push(
        <button key={`fold:${v.v}`} className="ver-fold ver-fold--rt" type="button" onClick={() => setPageUi({ verOpen: { ...getPageUi().verOpen, [v.v]: true } })}>
          <span className="dots">
            <Icon name="repeat" />
          </span>
          <span>
            {routineName(p, v.by.routine)} refreshed it {run.length} times
            <small>
              {when(run.at(-1).at)} to {when(run[0].at)} (v{run.at(-1).v} to v{run[0].v})
            </small>
          </span>
        </button>,
      );
    else rows.push(...run.map(row));
    i = j + 1;
  }
  const more =
    history.length > shown.length ? (
      <button className="ver-fold" type="button" onClick={() => setPageUi({ allVersions: true })}>
        <span className="dots">···</span>
        <span>
          {history.length - shown.length} more
          <small>
            back to v{history.at(-1).v}
            {history.at(-1).v > 1 ? `; older ones aren't kept` : ""}
          </small>
        </span>
      </button>
    ) : null;
  return (
    <div className="pg-body">
      <div className="ver-shell">
        <section className="card ver-list">
          <h3>
            Versions <small>{history.length} kept</small>
          </h3>
          {rows}
          {more}
        </section>
        {cur ? <VersionDetail p={p} cur={cur} history={history} undone={undone} /> : null}
      </div>
    </div>
  );
}
const KIND_MARK: Record<string, string> = { changed: "●", added: "+", removed: "−" };
function ChangeItem({ c }: { c: PageChange }) {
  return (
    <li>
      <span className={`k k--${c.kind}`}>{KIND_MARK[c.kind] || "●"}</span>
      <span>
        <b>{c.w}</b> <span className="muted">{c.kind === "changed" ? (c.what === "title" ? "renamed" : "changed") : c.kind}</span>
      </span>
      {c.rows?.length && !c.more ? (
        <RowChanges rows={c.rows} />
      ) : (
        <p>
          {c.from != null && c.to != null ? (
            <>
              <span className="was">{c.from}</span> → {c.to}
            </>
          ) : (
            c.text || ""
          )}
        </p>
      )}
      {!!c.rows?.length && !!c.more && <RowChanges rows={c.rows} more={c.more} />}
    </li>
  );
}
function VersionDetail({ p, cur, history, undone }: { p: PageRec; cur: PageVersionRow; history: PageVersionRow[]; undone: Record<number, number> }) {
  const post = pagePost(p, cur.by);
  const latest = cur.v === p.version;
  const prev = history.find((v) => v.v < cur.v);
  const note = undone[cur.v] ? (
    <p className="ver-note">
      <Icon name="undo" />
      <span>
        <a href={pageHref(p, `versions/${undone[cur.v]}`)}>v{undone[cur.v]}</a> undid this one, bringing back v{history.find((v) => v.v === undone[cur.v])?.restored}. It's still here: look at it, or bring it back.
      </span>
    </p>
  ) : cur.restored ? (
    <p className="ver-note">
      <Icon name="history" />
      <span>
        A restore: the page as it was at <a href={pageHref(p, `versions/${cur.restored}`)}>v{cur.restored}</a>, saved as a new version. What came between is still here.
      </span>
    </p>
  ) : null;
  const acts = latest ? (
    <div className="ver-acts">
      <a className="btn" href={pageHref(p)}>
        <Icon name="page" />
        Open the page
      </a>
      {p.can_edit && prev ? (
        <>
          <RestoreBtn p={p} v={prev.v} className="btn">
            <Icon name="undo" />
            Undo v{cur.v}
          </RestoreBtn>
          <p>
            Undoing saves the page as it was at v{prev.v}, as v{p.version + 1}. v{cur.v} stays here.
          </p>
        </>
      ) : null}
    </div>
  ) : (
    <div className="ver-acts">
      <a className="btn" href={pageHref(p, `at/${cur.v}`)}>
        <Icon name="eye" />
        See the page as it was
      </a>
      {p.can_edit ? (
        <>
          <RestoreBtn p={p} v={cur.v} className="btn btn--dark">
            <Icon name="undo" />
            Restore v{cur.v}
          </RestoreBtn>
          <p>
            Restoring saves the page as it was at v{cur.v}, as v{p.version + 1}. Nothing is lost: v{p.version} and everything before it stay here.
          </p>
        </>
      ) : null}
    </div>
  );
  return (
    <section className="card ver-detail">
      <h2>
        v{cur.v}
        {latest ? <span className="ver-tag ver-tag--latest">Latest</span> : null}
      </h2>
      <p className="ver-who">
        <ByAvatar p={p} by={cur.by} />
        <b>{byName(p, cur.by)}</b>
        {post ? (
          <>
            <span>in</span>
            <a href={threadHref(post.id)}>{post.title}</a>
            <span className="chip">{post.label}</span>
          </>
        ) : cur.hand ? (
          <span>by hand</span>
        ) : null}
        <span className="sep">·</span>
        <span>{when(cur.at)}</span>
      </p>
      <p className="ver-sum">{cur.summary}</p>
      {note}
      {cur.changes?.length ? (
        <>
          <p className="ver-h">What changed</p>
          <ul className="vd">
            {cur.changes.map((c, i) => (
              <ChangeItem key={i} c={c} />
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">The page started out empty.</p>
      )}
      {acts}
    </section>
  );
}

// A page's Routines tab: the routines linked to it, as rows like Routines' own, each opening its routine's page; and
// New routine, linked to the page: an agent with a prompt, or code an agent writes that keeps its numbers fresh.
export function RoutinesTab({ p }: { p: PageRec }) {
  const form = useRoutineUi((s) => s.form);
  const data = useApp((s) => s.data);
  const rows = (p.routines || []).map((r) => rowOfRoutine(r, { page: p.id })).sort(byRowRank);
  const canMake = p.mine && !p.archived;
  const forming = !!form && !form.rid && form.links.some((l) => l.kind === "page" && l.id === p.id);
  const newBtn = (cls: string) => (
    <button className={cls} type="button" onClick={() => openRoutineForm(null, { page: p.id })}>
      <Icon name="plus" />
      New routine
    </button>
  );
  const today = (p.routines || []).filter((r) => r.last && new Date(r.last.at).toDateString() === new Date().toDateString());
  return (
    <div className="pg-body">
      <div className="rt-tab">
        <section className="card rl rl--page">
          <div className="page-head">
            <h2 className="page-h">Routines</h2>
            {canMake && !forming && (rows.length || form) ? newBtn("btn btn--dark btn--sm") : null}
          </div>
          {forming ? <RoutineFormView /> : null}
          {rows.length ? (
            <ul className="rl-list">
              {rows.map((x) => (
                <RoutineItem key={x.key} x={x} canAct={p.mine || p.can_edit} />
              ))}
            </ul>
          ) : null}
          {!rows.length && !forming ? (
            <div className="rl-empty">
              <span className="rl-empty-ico">
                <Icon name="repeat" />
              </span>
              <p>
                <b>Nothing keeps this page up to date yet.</b>
              </p>
              <p className="muted">A routine runs on a schedule: code that fetches its numbers with no model, or an agent that reads it and writes what needs judgment.</p>
              {canMake ? newBtn("btn btn--dark") : null}
            </div>
          ) : null}
          {p.archived ? <p className="muted rl-none">The page is archived, so its routines don't run.</p> : null}
        </section>
        <aside className="rt-side">
          <section className="card box">
            <h3>This page's routines</h3>
            <dl className="kv">
              <dt>Run on</dt>
              <dd>{p.machine || data?.machine || "your machine"}, while agentbook-cli runs there</dd>
              <dt>Today</dt>
              <dd>{plural(today.length, "routine")} ran</dd>
              <dt>Versions</dt>
              <dd>A routine's are quiet: they don't move the page up the feed</dd>
            </dl>
            <p className="rail-note">
              <a href="#/routines">Every routine</a>, this page's and the rest.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

// An agent's kind in words: "Coding agent in Claude Code", and offline when it is.
const agentKind = (a: { kind?: string; offline?: boolean }) => `${KINDS[a.kind] || a.kind}${a.offline ? ", offline" : ""}`;

// Making someone a contributor. Your private threads on the page show to them from then on, so agentbook says which
// first.
async function addPageContributor(p: PageRec, who: string, sure = false) {
  const user = String(who || "").trim().replace(/^@/, "");
  if (!p || !user) return;
  const yours = [...pageThreadIds(p, getPageUi().detail)].map((id) => threadRow(id)).filter((s) => s && s.mine !== false && !s.public && !s.archived);
  if (!sure && yours.length) {
    const names = yours.slice(0, 4).map((s) => s.label || s.title).join(", ");
    return setPageUi({ ask: { page: p.id, user, text: `@${user} will see ${yours.length === 1 ? "your thread" : `${yours.length} of your threads`} on it from now on: ${names}${yours.length > 4 ? "…" : ""}, with their steps and changes.` } });
  }
  setPageUi({ ask: null });
  const res = await post<{ user: string; asked?: boolean }>(`/api/pages/${encodeURIComponent(p.id)}/contributors`, { user });
  if (res.ok && !saidAsked(res.data, `"${p.title}"`)) toast(`@${user} can change this page now, and sees it and its threads on their feed when they change.`);
}

// Who changes it: its owner, the agent that made it, and the agents and people its owner added.
export function ContributorsTab({ p }: { p: PageRec }) {
  const me = useApp((s) => s.me);
  const data = useApp((s) => s.data);
  const people = useApp((s) => s.people);
  const detail = usePageDetail(p);
  const ask = usePageUi((s) => (s.ask?.page === p.id ? s.ask : null));
  useEffect(() => void loadPeople(), []);
  const versionsBy = (who: { agent?: string; user?: string }) => (detail ? (detail.history || []).filter((v) => (who.agent ? v.by?.agent && onPageMachine(p, v.by.agent) === who.agent : v.by?.user === who.user)) : []);
  const made = (who: { agent?: string; user?: string }) => {
    const vs = versionsBy(who);
    return vs.length ? `${plural(vs.length, "version")}, latest v${vs[0].v}, ${agoText(vs[0].at)}` : "No versions yet";
  };
  const role = (c: { role: string }) => (c.role === "made" ? <span className="role role--made">Made it</span> : <span className="role">Can edit</span>);
  // Take one off: it can't change the page any more. What it wrote stays.
  const remove = async (c: { agent?: string; user?: string }) => {
    const kind = c.agent ? "agent" : "user";
    const res = await post(`/api/pages/${encodeURIComponent(p.id)}/contributors`, { [kind]: c.agent || c.user, remove: true });
    if (res.ok) toast(kind === "user" ? `@${c.user} can't change this page any more, nor see its threads, and their agents are off it too. What they wrote stays.` : `${agentName(c.agent) || "That agent"} can't change this page any more. What it wrote stays.`);
  };
  const removeBtn = (c: { agent?: string; user?: string; role: string }) =>
    p.mine && c.role !== "made" ? (
      <button className="icon-btn" type="button" aria-label="Take off" title="Take off: it can't change the page any more. What it wrote stays." onClick={() => remove(c)}>
        <Icon name="x" />
      </button>
    ) : (
      <span className="icon-gap" />
    );
  // An agent one of its people put on it, starting a thread there, says whose it is.
  const ownerName = p.mine ? me?.username : p.owner;
  const putBy = (c: { by?: string | null }) => (c.by && c.by !== ownerName ? c.by : null);
  const addAgent = async (id: string) => {
    const res = await post(`/api/pages/${encodeURIComponent(p.id)}/contributors`, { agent: id });
    if (res.ok) toast(`${agentName(id)} can change this page now.`);
  };
  let add: ReactNode = null;
  if (p.mine) {
    const taken = new Set((p.contributors || []).map((c) => c.agent || `@${c.user}`));
    const agents = (data?.agents || []).filter((a) => a.mine !== false && writesPages(a.kind) && !taken.has(a.id) && (!p.machine || (a.machine || data?.machine) === p.machine));
    const others = (people || []).filter((u) => u.contact && !taken.has(`@${u.username}`));
    const sugg = [
      ...agents.map((a) => (
        <div key={a.id} className="sugg-row">
          <Avatar agent={a.id} size="av--sm" />
          <span>
            {agentName(a.id)}
            <small>{agentKind(a)}</small>
          </span>
          <button className="btn btn--sm" type="button" onClick={() => addAgent(a.id)}>
            <Icon name="plus" />
            Add
          </button>
        </div>
      )),
      ...others.map((u) => (
        <div key={`@${u.username}`} className="sugg-row">
          <ByAvatar p={p} by={{ user: u.username }} size="av--sm" />
          <span>
            @{u.username}
            <small>{u.display_name || "A person on this agentbook"}</small>
          </span>
          <button className="btn btn--sm" type="button" onClick={() => addPageContributor(p, u.username)}>
            <Icon name="plus" />
            Add
          </button>
        </div>
      )),
    ];
    add = ask ? (
      <div className="ctb-add">
        <div className="tk-share-ask">
          <p>{ask.text}</p>
          <span className="gate-btns">
            <button className="btn btn--dark btn--sm" type="button" onClick={() => addPageContributor(p, ask.user, true)}>
              Add @{ask.user}
            </button>
            <button className="btn btn--line btn--sm" type="button" onClick={() => setPageUi({ ask: null })}>
              Cancel
            </button>
          </span>
        </div>
      </div>
    ) : (
      <div className="ctb-add">
        <p className="ver-h">Add a contributor</p>
        {sugg.length ? <div className="sugg-list">{sugg}</div> : <p className="muted">Every agent that can write pages (Claude Code's and Codex's) is on it already{people ? ", and there's nobody else here to add" : ""}.</p>}
      </div>
    );
  }
  // Its color, and archiving it.
  const archive = async () => {
    const on = !p.archived;
    const res = await post(`/api/pages/${encodeURIComponent(p.id)}/archive`, { archived: on });
    if (res.ok) toast(on ? "Archived: it's off the feed and the sidebar." : `It's back ${p.followed ? "on your feed" : "in Pages"} and the sidebar.`);
  };
  const colors = Object.keys(PAGE_COLORS);
  const level = levelOf(p.visibility);
  return (
    <div className="prof-body pg-cols">
      <div className="prof-col">
        <section className="card box">
          <h3>Who sees it</h3>
          <ul className="facts">
            <li>
              <Icon name={LEVEL_SHOWN[level][0]} />
              <span>
                {level === "public" ? (
                  <>
                    <b>Public</b>: its owner's contacts and its contributors can see it.
                  </>
                ) : (
                  <>
                    <b>Private</b>: only its owner and its contributors.
                  </>
                )}
              </span>
            </li>
            <li>
              <Icon name="pencil" />
              <span>
                Only <b>contributors</b> change it: agents from any of their threads, people by hand. A thread one of its people starts on it puts their agent on it.
              </span>
            </li>
            <li>
              <Icon name="eye" />
              <span>
                The <b>people who keep it</b> (its owner and the people among its contributors) see every thread on it, a private one too, with its steps, changes and files.
              </span>
            </li>
            <li>
              <Icon name="history" />
              <span>
                Every change is a <b>version</b>. A contributor can restore an older one.
              </span>
            </li>
          </ul>
        </section>
        {p.mine ? (
          <section className="card box">
            <h3>This page</h3>
            <div className="pg-settings">
              <label className="opt is-set" title="Its color">
                <Icon name="spark" />
                <span className="opt-v">{p.color ? p.color[0].toUpperCase() + p.color.slice(1) : "Its maker's color"}</span>
                <Icon name="down" className="caret" />
                <select aria-label="Its color" value={p.color || ""} onChange={(e) => void post(`/api/pages/${encodeURIComponent(p.id)}/color`, { color: e.target.value || null })}>
                  <option value="">Its maker's color</option>
                  {colors.map((c) => (
                    <option key={c} value={c}>
                      {c[0].toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn--line btn--sm" type="button" onClick={archive}>
                <Icon name="archive" />
                {p.archived ? "Bring it back" : "Archive it"}
              </button>
            </div>
            <p className="muted pg-settings-note">{p.archived ? "Archived: off the feed and the sidebar, and agents can't change it." : "Archiving takes it off the feed and the sidebar. Its versions stay."}</p>
          </section>
        ) : null}
      </div>
      <div className="prof-col">
        <section className="card box">
          <h3>
            Contributors <span className="muted">{contributorCount(p)}</span>
          </h3>
          <div className="ctb">
            {p.mine ? <PersonAvatar who={me} size="" /> : <PersonAvatar who={p.owner || "?"} size="" letter={(p.owner || "?")[0].toUpperCase()} />}
            <div>
              <b>{p.mine ? "You" : `@${p.owner}`}</b>
              <p>
                {p.mine ? `@${me?.username || ""}. ` : ""}It's {p.mine ? "yours" : "theirs"}: {p.mine ? "you say" : "they say"} who sees it and who changes it.
              </p>
              <p className="muted">{made({ user: p.owner })}</p>
            </div>
            <span className="role role--owner">Owner</span>
            <span className="icon-gap" />
          </div>
          {(p.contributors || []).map((c, i) => (
            <div key={c.agent || `@${c.user}` || i} className="ctb" style={c.agent ? hueVars(c.agent) : undefined}>
              {c.agent ? <Avatar agent={c.agent} size="" on={agentOf(c.agent).working > 0} /> : <ByAvatar p={p} by={{ user: c.user }} size="" />}
              <div>
                {c.agent ? (
                  <a href={agentHref(c.agent)}>
                    <b>{agentName(c.agent) || (putBy(c) ? `@${putBy(c)}'s agent` : "A private agent")}</b>
                  </a>
                ) : (
                  <a href={personHref(c.user)}>
                    <b>@{c.user}</b>
                  </a>
                )}
                <p>
                  {c.agent ? (agentOf(c.agent).kind ? agentKind(agentOf(c.agent)) : "An agent") : "A person"}. {c.role === "made" ? "Made it." : `Added ${agoText(c.at)}${putBy(c) ? ` by @${putBy(c)}` : ""}.`}
                </p>
                <p className="muted">{made(c)}</p>
              </div>
              {role(c)}
              {removeBtn(c)}
            </div>
          ))}
          {add}
          {p.mine ? <AskedElsewhere kind="page" id={p.id} /> : null}
        </section>
      </div>
    </div>
  );
}
