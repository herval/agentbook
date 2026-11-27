// #/ : the Feed (app.ts renderFeed). The composer, and the feed as the server lists it (q/feed), headed by its
// filters with "N new" under them: as cards, compact rows or pictures (agentbook.feedView); on the right, what's
// coming up and your tasks.
import { useRef } from "react";
import type { ReactNode } from "react";
import { agentName } from "../../lib/agents.ts";
import { useChrome } from "../../lib/chrome.ts";
import { FEED_N, showFresh, useFeedList } from "../../lib/feed.ts";
import { ago, hueVars, pageStyle } from "../../lib/format.ts";
import { usePref } from "../../lib/hooks.ts";
import { NO_SCOPE, pageHref, SCOPE_KEYS, threadHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { FeedList, LaunchRow as Launch, PageRow, Scope, TheirCard, Thread } from "../../lib/types.ts";
import { Avatar } from "../../components/Avatar.tsx";
import { Composer } from "../../components/Composer.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ClearAll, feedViewOf, NoMatch, ScopeBar } from "../../components/ScopeBar.tsx";
import { Shell } from "../../components/Shell.tsx";
import { TasksCard } from "../../components/TasksCard.tsx";
import { FeedCards, FeedMore } from "../../components/ThreadCard.tsx";
import { LaunchRow, PageRowLine, ThreadRow } from "../../components/ThreadRow.tsx";
import { TheirRowLine } from "../../components/people/TheirCard.tsx";
import { feedAsk, feedStatus } from "../../components/bar/scope.ts";
import { FILTERS } from "../../components/pages/pages.ts";
import { fileData, isPicFile, openOnClick } from "../../components/thread/FileChip.tsx";
import { Attachment } from "../../components/thread/Results.tsx";
import { PageThumb } from "../../components/visual/PageThumb.tsx";
import { Keyed } from "../../components/Keyed.tsx";
import { WelcomeCards } from "../../components/welcome/WelcomeCard.tsx";
import { ComingUp } from "./ComingUp.tsx";

const narrowedOf = (sc: Scope) => SCOPE_KEYS.some((k) => sc[k].length);
const oneOf = (sc: Scope, k: (typeof SCOPE_KEYS)[number]) => (sc[k].length === 1 ? sc[k][0] : null);

function By({ r }: { r: Thread }) {
  return (
    <a className="gal-c" href={threadHref(r.id)}>
      <Avatar agent={r.agent} size="av--xs" />
      <span>
        <b>{r.title || r.label}</b>
        <small>{agentName(r.agent)}</small>
      </span>
    </a>
  );
}
// The feed as pictures: every picture its threads posted, their charts and diagrams,
// and the pages it lists, newest first, a tile each saying whose it is. A picture opens in the viewer, its arrows
// going through all of them; its caption opens its thread.
function galleryTiles(F: FeedList | null): ReactNode[] {
  const tiles: { at: string; el: ReactNode }[] = [];
  for (const k of F?.list || []) {
    const rec = F.records[k];
    if (!rec) continue;
    if (k.startsWith("thread:")) {
      const r = rec as Thread;
      for (const f of (r.last_pictures || []).filter(isPicFile)) {
        const url = `/api/files/${encodeURIComponent(f.id)}`;
        const at = f.at || r.updated;
        tiles.push({
          at,
          el: (
            <figure key={`p:${f.id}`} className="gal-t" style={hueVars(r.agent)}>
              <a className="gal-pic" href={url} target="_blank" rel="noopener" title={f.title || f.name} {...fileData(f)} onClick={openOnClick}>
                <img src={url} alt={f.title || f.name} loading="lazy" decoding="async" />
              </a>
              <figcaption>
                <By r={r} />
                <time>{ago(at)}</time>
              </figcaption>
            </figure>
          ),
        });
      }
      for (const [id, a] of Object.entries(r.attachments || {})) {
        if (a.type !== "chart" && a.type !== "diagram") continue;
        const at = a.updated || r.updated;
        tiles.push({
          at,
          el: (
            <figure key={`a:${r.id}:${id}`} className="gal-t gal-t--w" style={hueVars(r.agent)}>
              <div className="gal-w">
                <Attachment a={a} s={r} />
              </div>
              <figcaption>
                <By r={r} />
                <time>{ago(at)}</time>
              </figcaption>
            </figure>
          ),
        });
      }
    } else if (k.startsWith("page:")) {
      const r = rec as unknown as PageRow;
      tiles.push({
        at: r.moved || r.updated,
        el: (
          <figure key={k} className="gal-t" style={pageStyle(r)}>
            <a className="gal-pg" href={pageHref(r)}>
              <PageThumb p={r} changed={new Set((r.last?.changes || []).map((c) => c.id).filter(Boolean))} />
            </a>
            <figcaption>
              <a className="gal-c" href={pageHref(r)}>
                <span className="pg-ico">{r.emoji || "📄"}</span>
                <span>
                  <b>{r.title}</b>
                  <small>
                    v{r.version}
                    {r.last?.summary ? `: ${r.last.summary}` : ""}
                  </small>
                </span>
              </a>
              <time>{ago(r.updated)}</time>
            </figcaption>
          </figure>
        ),
      });
    }
  }
  return tiles.sort((a, b) => String(b.at).localeCompare(String(a.at))).map((t) => t.el);
}

// The feed, compact: one row each, in one card, as a person's threads are, from what the feed has (q/feed: 100
// at a time when compact, more as it scrolls). What's starting comes first, then pinned threads, then threads and
// pages by when they last did something, the latest on top.
function compactRows(F: FeedList | null): ReactNode[] {
  const recs = (F?.list || []).map((k) => [k, F.records[k]] as const).filter(([, r]) => r);
  const rows = recs
    .filter(([k]) => !k.startsWith("launch:"))
    .map(([k, rec]) => {
      if (k.startsWith("page:")) {
        const p = rec as unknown as PageRow;
        return { key: k, pin: "", at: p.moved || p.updated, el: <PageRowLine page={p} /> };
      }
      if (k.startsWith("their:")) {
        const c = rec as TheirCard;
        return { key: k, pin: "", at: c.updated || c.started || "", el: <TheirRowLine card={c} /> };
      }
      const s = rec as Thread;
      return { key: k, pin: s.pinned ? s.pinned_at || " " : "", at: s.updated || s.started, el: <ThreadRow thread={s} /> };
    })
    .sort((a, b) => b.pin.localeCompare(a.pin) || b.at.localeCompare(a.at));
  // Each in a box of its own (Keyed), as the stylesheet rules a line between them.
  return [
    ...recs
      .filter(([k]) => k.startsWith("launch:"))
      .map(([k, l]) => (
        <Keyed key={k} k={k}>
          <LaunchRow launch={l as unknown as Launch} />
        </Keyed>
      )),
    ...rows.map((r) => (
      <Keyed key={r.key} k={r.key}>
        {r.el}
      </Keyed>
    )),
  ];
}

function EmptyFeed({ scope, status }: { scope: Scope; status: string }) {
  const q = useChrome((c) => c.q);
  const pages = useApp((s) => s.data?.pages);
  const narrowed = narrowedOf(scope);
  if (status === "pages") {
    if (scope.agent.length || scope.workspace.length)
      return (
        <section className="card empty-card">
          <p>
            Pages aren't in a workspace or an agent's. <ClearAll name="feed" />
          </p>
        </section>
      );
    return (
      <section className="card empty-card">
        <p>
          {q ? (
            "No pages you follow match."
          ) : (pages || []).some((p) => !p.archived) ? (
            <>
              You don't follow any pages. Follow one in <a href="#/pages">Pages</a> and it shows here when it changes.
            </>
          ) : (
            <>
              No pages yet. <a href="#/pages">Ask an agent for one</a>.
            </>
          )}
        </p>
      </section>
    );
  }
  if (status !== "all")
    return (
      <section className="card empty-card">
        <p>
          No {(FILTERS.find(([k]) => k === status)?.[1] || status).toLowerCase()} threads{q || narrowed ? " match" : " right now"}.
          {narrowed && (
            <>
              {" "}
              <ClearAll name="feed" />
            </>
          )}
        </p>
      </section>
    );
  if (q) return <NoMatch />;
  if (narrowed) {
    const agent = oneOf(scope, "agent");
    return (
      <section className="card empty-card">
        <p>
          {agent && !scope.workspace.length && !scope.page.length && !scope.group.length ? `No threads by ${agentName(agent)} yet.` : "No threads match."} <ClearAll name="feed" />
        </p>
      </section>
    );
  }
  return (
    <section className="card empty-card">
      <h2>No threads yet</h2>
      <p>Write one above: an agent picks it up in the background, in the project you pick.</p>
      <p className="muted">
        What you start in a terminal with <code>claude</code> shows up too, once the plugin is installed.
      </p>
      <p className="muted">
        Other people's threads show here once you follow their agents: find them on <a href="#/people">People</a>.
      </p>
    </section>
  );
}

export function Feed() {
  const route = useRoute();
  const q = useChrome((c) => c.q);
  const [kept] = usePref("feedFilter", "all");
  const [viewKept] = usePref("feedView", "cards");
  const view = feedViewOf(viewKept);
  const scope = route.scope || NO_SCOPE;
  const status = feedStatus(route, kept);
  // The feed is what the server says it is (q/feed): asked for again when the bar or the search says otherwise.
  const ask = feedAsk(scope, status, q);
  // Compact and Pictures ask for 100 at a time, Cards 20, as the list is asked for (switching views brings the rest
  // of the first hundred itself, ScopeBar's view menu).
  const nAt = useRef<{ ask: string; n: number } | null>(null);
  if (nAt.current?.ask !== ask) nAt.current = { ask, n: view !== "cards" ? 100 : FEED_N };
  const n = nAt.current.n;
  const F = useFeedList(ask, n);
  // The filters head the list: inside Compact's one card, and on the page's background above cards, pictures, or
  // what it says when there's nothing.
  const fresh = F?.fresh.length ? (
    <button className="feed-new" type="button" onClick={() => showFresh(n)}>
      <Icon name="up" />
      {F.fresh.length} new
    </button>
  ) : null;
  const head = (bare: boolean) => <ScopeBar name="feed" feed={F} bare={bare} sticky after={fresh} />;
  let body: ReactNode = null;
  if (view === "pictures") {
    const tiles = galleryTiles(F);
    if (tiles.length)
      body = (
        <>
          {head(true)}
          <section className="gal" data-file-set aria-label="Pictures">
            {tiles}
          </section>
          <FeedMore feed={F} />
        </>
      );
    else if (F)
      body = (
        <>
          {head(true)}
          <section className="card empty-card">
            <p>{F.next ? "No pictures in these threads yet." : `No pictures${q || narrowedOf(scope) ? " match" : " yet"}. Agents post screenshots, charts and diagrams as they work; they show here.`}</p>
          </section>
          <FeedMore feed={F} />
        </>
      );
    else body = head(true);
  } else if (view === "compact") {
    const rows = compactRows(F);
    if (rows.length)
      body = (
        <>
          <section className="card feed-rows" aria-label="Threads">
            {head(false)}
            {rows}
          </section>
          <FeedMore feed={F} />
        </>
      );
    else
      body = (
        <>
          {head(true)}
          {F ? <EmptyFeed scope={scope} status={status} /> : null}
        </>
      );
  } else
    body = (
      <>
        {head(true)}
        {F && !F.list.some((k) => F.records[k]) ? <EmptyFeed scope={scope} status={status} /> : <FeedCards feed={F} />}
      </>
    );
  return (
    <Shell
      className="shell feed-shell"
      right={
        <>
          <ComingUp />
          <TasksCard />
        </>
      }
    >
      <WelcomeCards />
      <div>
        <Composer />
      </div>
      <div className="posts">{body}</div>
    </Shell>
  );
}
