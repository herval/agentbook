/* ---------- every page ---------- */

// #/pages and #/dashboards (app.ts renderPages): Pages and Groups are one list each, as People and Notes are, beside
// the sidebar as Notes is: a head with what they are and the button that makes one, then a card with its filters and
// a tile each, the latest first. Dashboards are their own list, under their own row; Pages lists the rest.
import { useEffect } from "react";
import { ago, pageStyle } from "../../lib/format.ts";
import { setDraft, useDraft } from "../../lib/hooks.ts";
import { connectorsHref, pageHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { Avatar } from "../../components/Avatar.tsx";
import { Composer } from "../../components/Composer.tsx";
import { Icon } from "../../components/Icon.tsx";
import { dashFace, loadDash } from "../../components/pages/dash.tsx";
import { PageAvatars } from "../../components/pages/head.tsx";
import { byName, inPageFilter, isDash, PAGE_FILTERS, pageLive, pageLiveText, pageWaits, routineFailing, when } from "../../components/pages/pages.ts";
import type { PageRec } from "../../components/pages/pages.ts";
import { getPageUi, setPageUi, usePageUi } from "../../components/pages/state.ts";
import { Shell } from "../../components/Shell.tsx";
import { PageThumb } from "../../components/visual/PageThumb.tsx";
import { PageCorner } from "../../components/Visibility.tsx";
import { hueVars } from "../../lib/format.ts";

function PageNow({ p }: { p: PageRec }) {
  useApp((s) => s.rows);
  const waits = pageWaits(p);
  const live = p.archived ? [] : pageLive(p);
  const bad = !p.archived && (p.routines || []).find(routineFailing);
  return (
    <>
      {waits ? <span className="st-pill st-pill--needs">{waits === 1 ? "Waits for your OK" : `${waits} wait for your OK`}</span> : null}
      {live.length === 1 ? (
        <span className="st-pill" style={hueVars(live[0].agent)} title={live[0].title}>
          <Avatar agent={live[0].agent} size="av--xs" />
          {live[0].label}
          <i className="pulse" />
        </span>
      ) : live.length ? (
        <span className="st-pill" title={pageLiveText(live)[1]}>
          {live.length} live
          <i className="pulse" />
        </span>
      ) : bad ? (
        <span className="st-pill st-pill--err">
          <Icon name="alert" />
          {bad.name} fails
        </span>
      ) : null}
    </>
  );
}

// A page in Pages, as a thumbnail drawn from its first widgets, what changed lately
// lit, then its title and what it is, who keeps it, and when it last changed.
function PageTile({ p }: { p: PageRec }) {
  const sub = p.about || (p.last?.summary ? `v${p.version}: ${p.last.summary}` : "");
  const fresh = Date.now() - Date.parse(p.moved || p.updated || "0") < 86400e3;
  const changed = new Set<string>(fresh ? (p.last?.changes || []).map((c) => c.id).filter(Boolean) : []);
  const tip = `v${p.version}, ${when(p.updated)}, by ${byName(p, p.last?.by)}${p.last?.summary ? `: ${p.last.summary}` : ""}`;
  return (
    <a className={`pg-tile${p.archived ? " is-off" : ""}`} href={pageHref(p)} style={pageStyle(p)} title={tip}>
      <PageThumb p={p} changed={changed} />
      <PageCorner page={p} cls=" vis-corner--float" />
      <span className="pg-tile-b">
        <span className="ls-t">
          <span className="pg-ico">{p.emoji || "📄"}</span>
          <b>{p.title}</b>
        </span>
        <span className="ls-sub">
          {p.mine ? "" : `@${p.owner || "?"}'s · `}
          {sub}
        </span>
        <span className="pg-tile-f">
          <PageNow p={p} />
          {changed.size ? <span className="st-pill">{changed.size} changed</span> : null}
          <span className="ls-avs">
            <PageAvatars p={p} />
          </span>
          <time>{ago(p.updated)}</time>
        </span>
      </span>
    </a>
  );
}

export function Pages() {
  const r = useRoute();
  const dash = r.name === "dashboards";
  const data = useApp((s) => s.data);
  const answers = usePageUi((s) => s.dash);
  const picked = usePageUi((s) => s.pagesFilter);
  const making = usePageUi((s) => (dash ? s.dashNew : s.pageNew));
  const key = dash ? "dash:new" : "page:new";
  const [draft] = useDraft(key);
  const all = ((data?.pages || []) as unknown as PageRec[]).filter((p) => isDash(p) === dash);
  const at = (p: PageRec) => String(p.updated || "");
  // Making one: the composer, opened by New page, or always when there are none yet or it has a draft.
  const open = making || !all.length || !!draft;
  const what = dash ? ["Dashboards", "Panels that ask Datadog and your other sources, for the range you pick", "New dashboard"] : ["Pages", "Explorations, plans and drafts your agents keep up to date", "New page"];
  // A filter with none left (its pill is gone) shows them all.
  const f = PAGE_FILTERS.some(([k]) => k === picked) && all.some((p) => inPageFilter(p, picked)) ? picked : "all";
  const list = all.filter((p) => inPageFilter(p, f)).sort((a, b) => at(b).localeCompare(at(a)));
  // Dashboards keep no numbers in their versions: a tile draws the last answers agentbook-server kept for its own
  // view (`face`); the first ones with none yet ask for theirs.
  useEffect(() => {
    if (dash) for (const p of list.slice(0, 12)) if (!getPageUi().dash[p.id] && !p.archived && !Object.keys(p.face || {}).length) loadDash(p);
  });
  // New page opens the composer, focused; Cancel folds it and drops what was typed.
  const toggle = (on: boolean) => {
    setPageUi(dash ? { dashNew: on } : { pageNew: on });
    if (!on) setDraft(key, "");
    else setTimeout(() => document.querySelector<HTMLElement>(".ls-page form.compose textarea")?.focus(), 30);
  };
  const shownFilters = PAGE_FILTERS.filter(([k]) => k === "all" || all.some((p) => inPageFilter(p, k)));
  const none = dash ? (
    <>
      <b>No dashboards yet</b>
      <p>
        Ask an agent above for one. It finds what your connectors can answer
        {(data?.connectors || []).length ? (
          ""
        ) : (
          <>
            {" "}
            (<a href={connectorsHref()}>add Datadog</a> first)
          </>
        )}
        , writes a query for each panel, runs each one, and saves it once they all draw. Its numbers are asked for whenever someone looks, never kept as versions.
      </p>
    </>
  ) : (
    <>
      <b>No pages yet</b>
      <p>Ask an agent above for one: an exploration it keeps up to date, a plan, a draft. It makes the page, and every change it makes is a version you can go back to.</p>
    </>
  );
  return (
    <Shell className="shell ls-shell" mainClass="ls-page">
      <div className="page-head people-head">
        <h1 className="page-h">{what[0]}</h1>
        <span className="page-sub">{what[1]}</span>
        {all.length ? (
          <div className="row-acts">
            {open ? (
              <button className="btn btn--line" type="button" onClick={() => toggle(false)}>
                Cancel
              </button>
            ) : (
              <button className="btn btn--dark" type="button" onClick={() => toggle(true)}>
                <Icon name="plus" />
                {what[2]}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {open ? <Composer page="new" dash={dash} /> : null}
      <section className="card ls">
        {shownFilters.length > 1 ? (
          <div className="nl-pills ls-pills">
            {shownFilters.map(([k, l]) => (
              <button key={k} type="button" className={f === k ? "is-on" : ""} onClick={() => setPageUi({ pagesFilter: k })}>
                {l}
                <span className="n">{all.filter((p) => inPageFilter(p, k)).length}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="ls-list pg-grid">
          {list.length ? list.map((p) => <PageTile key={p.id} p={dash ? dashFace(p, answers[p.id]) : p} />) : <div className="ls-empty">{f === "all" ? none : <p>None here.</p>}</div>}
        </div>
      </section>
    </Shell>
  );
}
