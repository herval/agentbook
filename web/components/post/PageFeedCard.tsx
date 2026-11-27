// A page in the feed (pageFeedCard): one card per page, which moves up each time it changes. It says what its latest
// version changed, with the numbers that moved.
import { useState } from "react";
import { post } from "../../lib/api.ts";
import { agoText, hueVars, pageStyle, plural } from "../../lib/format.ts";
import { pagePics } from "../../lib/markdown.ts";
import { agentHref, pageHref, personHref, threadHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { PageRow, Widget } from "../../lib/types.ts";
import type { WidgetData } from "../../../plugin/shared/types.ts";
import { cellNumber, sortedRows, tableBars } from "../../lib/visual.ts";
import type { TableData } from "../../lib/visual.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { PageCorner } from "../Visibility.tsx";
import { byName, isDash, onPageMachine, pageLive, pageLiveText, pagePost, routineName, todayCount } from "../pages/pages.ts";
import type { PageRec } from "../pages/pages.ts";
import { Spark } from "../pages/widgets.tsx";
import { VersionTicks } from "../visual/PageThumb.tsx";
import { Hl } from "./util.tsx";
import { ago } from "../../lib/format.ts";

type Change = NonNullable<NonNullable<PageRow["last"]>["changes"]>[number];
const cellWords = (v: unknown): string => (v && typeof v === "object" ? String((v as { text?: string; meter?: number }).text ?? ((v as { meter?: number }).meter != null ? `${(v as { meter?: number }).meter}%` : "")) : String(v ?? ""));

// The words of a cell that changed, without those it kept at the start when only a word or two changed:
// "200 · 1619 ms" → "200 · 1569 ms" is "1619" → "1569 ms". A long old value is cut short: the new one matters.
export function changedWords(from = "", to = ""): [string, string] {
  const a = from.split(" ");
  const b = to.split(" ");
  let i = 0;
  while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - 1 - i && j < b.length - 1 - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const [was, now] = a.length - i - j <= 2 ? [a.slice(i, a.length - j).join(" "), b.slice(i).join(" ")] : [from, to];
  return [was.length > 28 ? `${was.slice(0, 26).trimEnd()}…` : was, now];
}
// A table's rows a version changed: each one's name, and what it says now. One whose status moved says it in the status's color.
export function RowChanges({ rows, more = 0 }: { rows: NonNullable<Change["rows"]>; more?: number }) {
  return (
    <div className="pk-ch">
      {rows.map((r, i) => {
        if (r.kind !== "changed")
          return (
            <p key={i} className={`is-${r.kind}`}>
              <i>{r.kind === "added" ? "+" : "−"}</i>
              <em>{r.key}</em>
            </p>
          );
        const [was, now] = changedWords(r.from, r.to);
        return (
          <p key={i}>
            <em>{r.key}</em>
            <span className={r.status && r.status !== r.was ? `is-${r.status}` : ""}>
              {was && (
                <>
                  <s>{was}</s> →{" "}
                </>
              )}
              <b>{now || "–"}</b>
            </span>
          </p>
        );
      })}
      {more > 0 && <p className="pk-more">and {more} more</p>}
    </div>
  );
}

// A widget its latest version changed, small, as the feed's card for its page shows it:
// a number with what it was, how much it moved and its sparkline; a chart's line; a table's rows that changed (from
// a version before they were kept, its first rows as bars); a list's first items; anything else, what changed.
function PageChangeTile({ w, c }: { w: Widget; c: Change & { from?: unknown; text?: string; w?: string } }) {
  const d = (w.data || {}) as WidgetData;
  const title = <small>{w.title || c.w || ""}</small>;
  const what = <div className="what">{c.kind === "added" ? "Added" : c.text || "Changed"}</div>;
  if (w.type === "metric") {
    const now = cellNumber(d.value);
    const was = c.from != null ? cellNumber(c.from as never) : null;
    const moved = now != null && was != null && was !== now;
    const better = moved && d.good ? (d.good === "up" ? now > was : now < was) : null;
    const rel = moved && was ? ((now - was) / Math.abs(was)) * 100 : null;
    return (
      <div className="peek-t">
        {title}
        <div className="v">
          {String(d.value ?? "–")}
          <small>{d.unit || ""}</small>
          {rel != null && (
            <span className={`pd${better == null ? "" : better ? " good" : " bad"}`}>
              {now > was ? "+" : "−"}
              {Math.abs(rel) >= 10 ? Math.round(Math.abs(rel)) : Math.abs(rel).toFixed(1)}%
            </span>
          )}
        </div>
        {c.from != null ? (
          <div className="was">
            was <s>{String(c.from)}</s>
          </div>
        ) : (
          <div className="was">{c.text || ""}</div>
        )}
        <Spark series={d.series} />
      </div>
    );
  }
  if (w.type === "chart")
    return (
      <div className="peek-t">
        {title}
        <Spark series={(d.series?.[0] as { values?: unknown[] } | undefined)?.values} />
        {what}
      </div>
    );
  if (w.type === "table" && c.rows?.length) {
    const shown = c.rows.slice(0, 2);
    const hidden = c.rows.length - shown.length + (c.more || 0);
    return (
      <div className="peek-t">
        {title}
        <RowChanges rows={shown} />
        {hidden > 0 && <div className="what">and {hidden} more</div>}
      </div>
    );
  }
  if (w.type === "table" && d.rows?.length) {
    const rows = sortedRows(d as TableData).slice(0, 3);
    const bars = tableBars(rows, (d.columns || []).length);
    const [col, widths] = [...bars.entries()][0] || [];
    return (
      <div className="peek-t">
        {title}
        <div className="pk-rows">
          {rows.map((r, i) => (
            <span key={i}>
              <em>{cellWords(r[0])}</em>
              {col != null && (
                <>
                  <i style={{ "--w": `${(widths[i] ?? 0).toFixed(1)}%` } as React.CSSProperties} />
                  <b>{cellWords(r[col])}</b>
                </>
              )}
            </span>
          ))}
        </div>
        {what}
      </div>
    );
  }
  if ((w.type === "list" || w.type === "options") && d.items?.length)
    return (
      <div className="peek-t">
        {title}
        <ul className="pk-list">
          {d.items.slice(0, 3).map((it, i) => (
            <li key={i}>{it.text || it.name || ""}</li>
          ))}
        </ul>
        {what}
      </div>
    );
  return (
    <div className="peek-t peek-t--plain">
      {title}
      {what}
    </div>
  );
}

function PageBtn({ className, title, url, body, said, children }: { className: string; title: string; url: string; body: object; said: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className || undefined}
      type="button"
      title={title}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await post(url, body);
        setBusy(false);
        if (res.ok) toast(said);
      }}
    >
      {children}
    </button>
  );
}
// Following a page is yours alone: it shows on your feed when it changes. Unfollowed, it's in Pages and the
// sidebar, and off the feed.
export const FollowBtn = ({ p, cls = "" }: { p: PageRow; cls?: string }) => (
  <PageBtn className={`${cls}${p.followed ? " is-on" : ""}`.trim()} title={p.followed ? "It shows on your feed when it changes. Unfollow to keep it to Pages and the sidebar." : "Follow it to see it on your feed when it changes."} url="/api/follows" body={{ page: p.id, followed: !p.followed }} said={!p.followed ? "Following: it shows on your feed when it changes." : "Unfollowed: it's off your feed, still in Pages and the sidebar."}>
    <Icon name={p.followed ? "check" : "plus"} />
    {p.followed ? "Following" : "Follow"}
  </PageBtn>
);
// Archiving a page's card is yours alone too, and it's the update you archive, not the page: its card goes under
// Archived until the page changes again. A page that's archived itself has no such button: it's brought back on its own page.
export function FeedArchiveBtn({ p }: { p: PageRec }) {
  if (p.archived) return null;
  const kind = isDash(p) ? "dashboard" : "page";
  return (
    <PageBtn className={p.feed_archived ? "is-on" : ""} title={p.feed_archived ? "Put it back on your feed" : `Off your feed until the ${kind} changes again. The ${kind} itself stays as it is.`} url="/api/feed/archive" body={{ page: p.id, archived: !p.feed_archived }} said={!p.feed_archived ? "Archived: it's back on your feed when it changes. Until then, pick Archived under Threads to find it." : "It's back on your feed."}>
      <Icon name="archive" />
      {p.feed_archived ? "Unarchive" : "Archive"}
    </PageBtn>
  );
}

function PageLiveLine({ p }: { p: PageRec }) {
  useApp((s) => s.rows);
  const live = pageLive(p);
  if (!live.length) return null;
  const [who, what] = pageLiveText(live);
  const one = live.length === 1 ? live[0] : null;
  return (
    <a className="live pg-live" href={one ? threadHref(one.id) : pageHref(p)} style={one ? hueVars(one.agent) : undefined}>
      <i className="pulse" />
      <span>
        <b>{who}</b> <span className="muted">· {what}</span>
      </span>
    </a>
  );
}

export function PageFeedCard({ page }: { page: PageRow }) {
  const p = page as Omit<PageRow, "face"> as PageRec;
  const me = useApp((s) => s.me);
  useApp((s) => s.rows);
  const by = p.last?.by || p.by;
  const thread = pagePost(p, by);
  const kind = isDash(p) ? "dashboard" : "page";
  const verb = p.version === 1 ? `made a ${kind}` : p.last?.restored ? `restored v${p.last.restored} of a ${kind}` : `updated a ${kind}`;
  const agent = by?.agent ? onPageMachine(p, by.agent) : null;
  const name = by?.user ? (by.user === me?.username ? "You" : `@${by.user}`) : by?.routine ? routineName(p, by.routine) : byName(p, by);
  const changed = (p.last?.changes || []).filter((c) => c.id);
  // A dashboard's panels draw their last answers, and say how old they are.
  const face = (p.face || {}) as Record<string, { data?: unknown; at?: string }>;
  const widgets = (p.widgets || []).map((w) => (isDash(p) && face[w.id] ? ({ ...w, data: face[w.id].data || {} } as Widget) : w));
  const tiles: React.ReactNode[] = [];
  for (const c of changed) {
    const w = widgets.find((x) => x.id === c.id);
    if (!w || c.kind === "removed") continue;
    const at = isDash(p) && face[w.id]?.at;
    tiles.push(<PageChangeTile key={c.id} w={w} c={at ? { ...c, kind: "changed", from: null, text: agoText(at) } : c} />);
    if (tiles.length === 3) break;
  }
  // A page that's mostly text shows how it starts (a dashboard, its numbers first).
  const doc = !tiles.length || (p.version === 1 && !isDash(p)) ? widgets.find((w) => (w.type === "doc" || w.type === "note") && (w.data as { text?: string })?.text) : null;
  const n = todayCount(p);
  return (
    <article className="card post pg-post" style={pageStyle(p)}>
      <header className="post-head" style={by?.agent ? hueVars(agent) : undefined}>
        {by?.user ? (
          <PersonAvatar who={by.user} size="" letter={by.user[0].toUpperCase()} />
        ) : (
          <a href={agentHref(agent)}>
            <Avatar agent={agent} on={!!thread && thread.effective !== "done"} />
          </a>
        )}
        <div className="post-who">
          <b>{name}</b> <span className="verb">{verb}</span>
          <div className="post-meta">
            <span className="chip chip--page" style={pageStyle(p)}>
              <Icon name="page" />
              Page
            </span>
            {p.mine === false && (
              <a className="on" href={personHref(p.owner)}>
                @{p.owner}'s
              </a>
            )}
            {thread ? (
              <a className="chip" href={threadHref(thread.id)}>
                {thread.label}
              </a>
            ) : by?.user ? (
              <span>by hand</span>
            ) : null}
            <span>{ago(p.updated)}</span>
          </div>
        </div>
        <PageCorner page={p} />
      </header>
      <h2 className="post-title">
        <a href={pageHref(p)}>
          {p.emoji || "📄"} <Hl text={p.title} />
        </a>
      </h2>
      <p className="post-text">
        v{p.version}: {p.last?.summary || ""}
      </p>
      {doc ? (
        <div className="peek-doc">
          {doc.title && <b>{doc.title}</b>}
          <div className="md">
            <Markdown text={String((doc.data as { text?: string }).text).slice(0, 600)} pics={pagePics(p)} />
          </div>
        </div>
      ) : tiles.length ? (
        <div className="pg-peek" style={pageStyle(p)}>
          {tiles}
        </div>
      ) : null}
      {n > 1 && (
        <p className="pg-more">
          <VersionTicks n={n} />
          Updated {plural(n, "time")} today, v{p.version - n + 1} to v{p.version}.
        </p>
      )}
      <PageLiveLine p={p} />
      <div className="post-acts">
        <a href={pageHref(p)}>
          <Icon name="page" />
          Open page
        </a>
        <FollowBtn p={page} />
        <FeedArchiveBtn p={p} />
      </div>
    </article>
  );
}
