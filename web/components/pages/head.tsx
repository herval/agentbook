// A page's head (app.ts pageHead): its emoji and title, who made it and who's on it, what it keeps track of, who can
// see it, how it stays up to date, and its buttons (Follow, who sees it, its link, Tidy, Edit or Save); then its tabs.
// Folded, it's its emoji, title and buttons on one line; the rest is a click away.
import { useState } from "react";
import { agentName } from "../../lib/agents.ts";
import { ago, agoText, clock, plural } from "../../lib/format.ts";
import { usePref } from "../../lib/hooks.ts";
import { NO_SCOPE, pageHref, personHref, scopeHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { PageRow, TaskRow } from "../../lib/types.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { FollowBtn } from "../post/PageFeedCard.tsx";
import { taskPageIds } from "../tasks/tasks.ts";
import { levelOf, PageCorner } from "../Visibility.tsx";
import { DashChips } from "./dash.tsx";
import { ByAvatar, saveEdit, startEdit } from "./grid.tsx";
import { byName, contributorCount, isDash, launchForPage, pageWriters, routineEvery, routineFailing, tidyPrompt, todayCount } from "./pages.ts";
import type { PageRec } from "./pages.ts";
import { setPageUi, useEdit } from "./state.ts";

export function PageAvatars({ p }: { p: PageRec }) {
  const me = useApp((s) => s.me);
  return (
    <span className="avs">
      {p.mine ? <PersonAvatar who={me} size="av--xs" /> : <PersonAvatar who={p.owner || "?"} size="av--xs" letter={(p.owner || "?")[0].toUpperCase()} />}
      {(p.contributors || []).map((c, i) => (c.user ? <ByAvatar key={i} p={p} by={{ user: c.user }} /> : <Avatar key={i} agent={c.agent} size="av--xs" />))}
    </span>
  );
}

function PageRoutineChip({ p }: { p: PageRec }) {
  const rs = p.routines || [];
  const href = pageHref(p, "routines");
  const waits = p.mine && rs.find((r) => r.waiting);
  if (waits)
    return (
      <a className="chip chip--rt-off" href={href}>
        <Icon name="repeat" />
        {waits.live_v ? `A change to ${waits.name} waits for your OK` : `${waits.name} waits for your OK`}
      </a>
    );
  const bad = rs.find(routineFailing);
  if (bad)
    return (
      <a className="chip chip--rt-bad" href={href}>
        <Icon name="alert" />
        {bad.name} is failing since {clock(bad.failing_since || bad.last?.at)}
      </a>
    );
  // Live while it's open: a routine runs as you look.
  if (rs.some((r) => r.live_v && r.on && r.every?.kind === "live"))
    return (
      <a className="chip chip--rt" href={href}>
        <Icon name="repeat" />
        Live while it's open
      </a>
    );
  const live = rs.filter((r) => r.live_v && r.on).sort((a, b) => (a.every?.everyMs || Infinity) - (b.every?.everyMs || Infinity));
  if (live.length)
    return (
      <a className="chip chip--rt" href={href}>
        <Icon name="repeat" />
        {routineEvery(live[0]).replace(/^every/, "Every").replace(/^hourly/, "Hourly").replace(/^daily/, "Daily")}
        {live[0].last_ok ? ` · ${ago(live[0].last_ok) === "now" ? "just now" : `${ago(live[0].last_ok)} ago`}` : ""}
      </a>
    );
  if (rs.some((r) => r.live_v))
    return (
      <a className="chip chip--rt-off" href={href}>
        <Icon name="pause" />
        Its routines are off
      </a>
    );
  return null;
}

// Your tasks linked to a page (taskPagesCard), open ones: a chip in its head that opens Tasks narrowed to it.
function PageTasksChip({ p }: { p: PageRec }) {
  const tasks = useApp((s) => s.data?.tasks);
  const n = ((tasks || []) as TaskRow[]).filter((t) => !t.done && taskPageIds(t).includes(p.id)).length;
  if (!n) return null;
  return (
    <a className="chip" href={scopeHref("tasks", { ...NO_SCOPE, page: [p.id] })} title="Your tasks linked to it">
      <Icon name="tasks" />
      {plural(n, "task")}
    </a>
  );
}

// Copy its link (the old page's one copy button said the same for every copy).
function CopyLink({ p }: { p: PageRec }) {
  const url = location.origin + location.pathname + pageHref(p);
  return (
    <button className="icon-btn pg-act" type="button" aria-label="Copy its link" title="Copy its link" onClick={async () => (await navigator.clipboard?.writeText(url).catch(() => {}), toast("Copied. Paste it in a terminal."))}>
      <Icon name="link" />
    </button>
  );
}

// Tidy: a thread on the page, by the agent that last wrote it if it's on, that folds it into one page.
function TidyBtn({ p }: { p: PageRec }) {
  const [busy, setBusy] = useState(false);
  const tidy = async () => {
    const writers = pageWriters();
    const use = writers.find((a) => a.id === p.last?.by?.agent)?.id || writers[0]?.id;
    if (!use) return void toast("No agent that writes pages is online.");
    setBusy(true);
    if (!(await launchForPage(p, use, tidyPrompt(p), `Asked ${agentName(use)} to tidy it. Its thread is beside the page, and every old version stays.`))) setBusy(false);
  };
  return (
    <button className="btn pg-tidy" type="button" disabled={busy} title="Tidy: ask an agent to fold what repeats into one place and take off what's done, as one version you can restore" aria-label="Tidy" onClick={tidy}>
      <Icon name="spark" />
      <span className="pg-tidy-t">Tidy</span>
    </button>
  );
}

export function PageHead({ p, tab }: { p: PageRec; tab: string }) {
  const e = useEdit(p);
  const machines = useApp((s) => s.data?.machines);
  useApp((s) => s.data?.agents);
  const [folded, setFolded] = usePref("headFolded", "0");
  const fold = folded === "1";
  const dash = isDash(p);
  // Edit opens the copy on the Page tab.
  const edit = () => {
    startEdit(p);
    if (tab !== "page") location.hash = pageHref(p);
  };
  const acts = e ? (
    <>
      <button className="btn" type="button" onClick={() => setPageUi({ edit: null })}>
        Cancel
      </button>
      <button className="btn btn--dark" type="button" onClick={() => saveEdit(p)}>
        <Icon name="check" />
        Save as v{p.version + 1}
      </button>
    </>
  ) : (
    <>
      {p.archived ? null : <FollowBtn p={p as unknown as PageRow} cls="btn pg-follow" />}
      <PageCorner page={p} cls=" vis-corner--head" />
      <CopyLink p={p} />
      {p.can_edit && !p.archived && !dash && p.widgets.length && pageWriters().length ? <TidyBtn p={p} /> : null}
      {p.can_edit && !p.archived && !dash ? (
        <button className="btn btn--dark" type="button" onClick={edit}>
          <Icon name="pencil" />
          Edit
        </button>
      ) : null}
    </>
  );
  const tabLink = (t: string, label: string, n?: number | null) => (
    <a className={tab === t ? "is-on" : ""} href={pageHref(p, t === "page" ? "" : t)}>
      {label}
      {n != null ? <span className="n">{n}</span> : null}
    </a>
  );
  const n = todayCount(p);
  return (
    <>
      <div className={`prof-head pg-head${fold ? " is-folded" : ""}`}>
        <span className="pg-hero">{p.emoji || "📄"}</span>
        <div className="prof-name">
          <div className="pg-title">
            <h1>{p.title}</h1>
            <button className="icon-btn pg-fold" type="button" aria-expanded={!fold} aria-label={`${fold ? "Unfold" : "Fold"} its header`} title={`${fold ? "Unfold" : "Fold"} its header`} onClick={() => setFolded(fold ? "0" : "1")}>
              <Icon name={fold ? "down" : "up"} />
            </button>
          </div>
          {fold ? null : (
            <>
              <p className="pg-by">
                A {dash ? "dashboard" : "page"} by <ByAvatar p={p} by={p.by} />
                <b>{byName(p, p.by)}</b>
                {p.mine === false ? (
                  <span>
                    , <a href={personHref(p.owner)}>@{p.owner}</a>'s
                  </span>
                ) : null}
                <span className="sep">·</span>
                <PageAvatars p={p} />
                <a href={pageHref(p, "contributors")}>{plural(contributorCount(p), "contributor")}</a>
                {p.machine && (machines?.length || 0) > 1 ? (
                  <>
                    <span className="sep">·</span>
                    <span>on {p.machine}</span>
                  </>
                ) : null}
              </p>
              {p.about ? <p className="pg-about">{p.about}</p> : null}
              <p className="prof-vis">{p.archived ? "Archived: off the feed and the sidebar." : levelOf(p.visibility) === "public" ? "Your contacts can see it. Only its contributors can change it." : "Only you and its contributors can see it, and change it."}</p>
              <div className="prof-now">
                {dash ? <DashChips p={p} /> : null}
                <PageRoutineChip p={p} />
                <PageTasksChip p={p} />
                <a className="chip" href={pageHref(p, "versions")}>
                  <Icon name="history" />v{p.version}, {agoText(p.updated)} by {byName(p, p.last?.by)}
                </a>
                {n > 1 ? (
                  <span className="chip">
                    <Icon name="clock" />
                    Updated {plural(n, "time")} today
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
        <div className="prof-acts">{acts}</div>
      </div>
      <nav className="tabs" aria-label="Page">
        {tabLink("page", dash ? "Dashboard" : "Page")}
        {(p.routines || []).length || (p.mine && !p.archived && !dash) ? tabLink("routines", "Routines", (p.routines || []).length || null) : null}
        {tabLink("versions", "Versions", p.version)}
        {tabLink("contributors", "Contributors", contributorCount(p))}
      </nav>
    </>
  );
}
