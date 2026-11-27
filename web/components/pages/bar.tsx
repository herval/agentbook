/* ---------- a page's threads bar ---------- */

// A page's threads, in a column on its right a quarter of its width: their list, with the box that starts one at
// its foot, or one of them open, small, its conversation first. It sticks under the top bar and always reaches the
// window's bottom, so its box stays in view. It's always there on the Page tab, except while editing by hand.
// Folded, it's an anchor at the window's bottom, and the page has its whole width.
// On a phone there's no room beside the page, and under its widgets its threads were screens away. So it's that anchor,
// wherever you are on the page, and the anchor opens the bar as a sheet over the page, which stays as it was under it.
// The address says when it's open (#/pages/:id/threads, or /threads/:thread with one in it), so a link opens it and
// Back closes it.
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { agentName, postOwner, verb } from "../../lib/agents.ts";
import { BAR_SHEET, useMedia } from "../../lib/chrome.ts";
import { ago, agoText, clock, hueVars, plural } from "../../lib/format.ts";
import { usePref } from "../../lib/hooks.ts";
import { pageHref, routineHref, threadHref } from "../../lib/route.ts";
import { threadRow, useApp } from "../../lib/store.ts";
import { useOpenThread } from "../../lib/thread.ts";
import type { LaunchRow, PageVersionRow, Route, Thread } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Composer } from "../Composer.tsx";
import { Icon } from "../Icon.tsx";
import { Answered } from "../thread/guest-convo.tsx";
import { AskBlock, askSpot, InConvo, WaitingElsewhere, waitsElsewhere } from "../post/Ask.tsx";
import { Bubble, ROUTINE_HEAD, startedFrom, typedText } from "../thread/Bubble.tsx";
import { LiveLine, showsLive } from "../thread/Live.tsx";
import { QueueTray, ReplyBox, WaitTray } from "../thread/ReplyBox.tsx";
import { SwitchChips } from "../thread/Switch.tsx";
import { barHref, barSort, barWhen, FILTERS, inFilter, onPageMachine, pageThreadIds, plainMentions, shelf } from "./pages.ts";
import type { PageRec } from "./pages.ts";
import { RestoreBtn } from "./tabs.tsx";
import { getPageUi, setPageUi, usePageDetail, usePageUi } from "./state.ts";
import { Keyed } from "../Keyed.tsx";

// Where a link in the bar goes: one of its threads, or its list (on a phone, its sheet); and the page, the bar
// closed. Either keeps the page's filters.
export function barLinks(p: PageRec, r: Route, sheet: boolean) {
  const filters = new URLSearchParams(r.filters || {}).toString();
  const kept = filters ? `?${filters}` : "";
  return { href: (id = "") => (id || !sheet ? barHref(p, id) : pageHref(p, "threads")) + kept, base: pageHref(p) + kept };
}

// The bar shows beside the page on its Page tab, except while it's being edited by hand.
export const useBarShown = (p: PageRec | undefined) => {
  const r = useApp((s) => s.route);
  const editing = usePageUi((s) => !!p && s.edit?.pid === p.id);
  return !!p && r.name === "page" && r.tab === "page" && !editing;
};

// Fold it to the bottom, or open it again. On a phone, it's the sheet that opens or closes.
export function useBarFold(p: PageRec): [boolean, () => void] {
  const r = useApp((s) => s.route);
  const sheet = useMedia(BAR_SHEET);
  const [folded, setFolded] = usePref("barFolded", "0");
  const fold = () => {
    const h = barLinks(p, r, sheet);
    if (sheet) return void (location.hash = r.bar ? h.base : h.href());
    setFolded(folded === "1" ? "0" : "1");
    if (folded !== "1" && r.thread) location.hash = h.base;
  };
  return [folded === "1", fold];
}
function BarFoldBtn({ p }: { p: PageRec }) {
  const [, fold] = useBarFold(p);
  return (
    <button className="icon-btn" type="button" aria-label="Fold its threads to the bottom" title="Fold its threads to the bottom" onClick={fold}>
      <Icon name="down" />
    </button>
  );
}
const BarHead = ({ p, n }: { p: PageRec; n: number }) => (
  <header className="bar-h">
    <h2>Threads{n ? <span className="n">{n}</span> : null}</h2>
    <BarFoldBtn p={p} />
  </header>
);

function BarChips({ p, s }: { p: PageRec; s: Thread }) {
  const detail = usePageDetail(p);
  const x = (detail?.posts || []).find((y) => onPageMachine(p, y.post) === s.id);
  const did = x?.versions ? (
    <span className="chip chip--did" title={`${plural(x.versions, "version")} of it`}>
      {x.first === 1 ? "Made it" : `Changed it · v${x.last}`}
    </span>
  ) : s.effective === "done" ? (
    <span className="chip">Asked</span>
  ) : null;
  const now =
    s.effective === "needs" ? (
      <span className="chip chip--sun">Needs you</span>
    ) : s.effective === "working" ? (
      <span className="chip chip--live">
        <i className="pulse" />
        Live
      </span>
    ) : null;
  return (
    <>
      <span className="chip">{s.label}</span>
      {now}
      {did}
      {s.mine === false ? <span className="chip">@{postOwner(s)}'s</span> : null}
    </>
  );
}

export function BarDock({ p }: { p: PageRec }) {
  const detail = usePageDetail(p);
  useApp((s) => s.rows);
  useApp((s) => s.data?.launches);
  const sheet = useMedia(BAR_SHEET);
  const [, fold] = useBarFold(p);
  const open = [...pageThreadIds(p, detail)].map((id) => threadRow(id)).filter((s) => s && !shelf(s));
  const needs = open.filter((s) => s.effective === "needs").length;
  const live = open.filter((s) => s.effective === "working").length;
  return (
    <button className="card bar-dock" type="button" title={`Show its threads${sheet ? "" : " beside it"}`} onClick={fold}>
      <b>Threads</b>
      {open.length ? <span className="n">{open.length}</span> : null}
      {needs ? (
        <span className="chip chip--sun">
          {needs} need{needs === 1 ? "s" : ""} you
        </span>
      ) : null}
      {live ? (
        <span className="chip chip--live">
          <i className="pulse" />
          {live} live
        </span>
      ) : null}
      <Icon name="up" />
    </button>
  );
}

// The list: one sorted list of its threads, archived and hidden ones left out, as in the feed. The feed's state
// pills narrow it (and bring those back), each once a thread is in it; picking the picked one again unpicks it.
// All / Yours / Others' narrows it too when there are both.
function BarList({ p, href }: { p: PageRec; href: (id?: string) => string }) {
  const detail = usePageDetail(p);
  useApp((s) => s.rows);
  const launches = useApp((s) => s.data?.launches);
  const st = usePageUi((s) => s.barState[p.id] || "all");
  const pick = usePageUi((s) => s.barFilter);
  if (!detail)
    return (
      <>
        <Keyed k="head">
          <BarHead p={p} n={0} />
        </Keyed>
        <Keyed k="list">
          <p className="bar-note muted">Loading…</p>
        </Keyed>
      </>
    );
  const every = [...pageThreadIds(p, detail)].map((id) => threadRow(id)).filter(Boolean);
  const inState = every.filter((s) => inFilter(s, st));
  const yours = every.filter((s) => s.mine !== false).length;
  const who: [string, string, number][] =
    yours && yours < every.length
      ? [
          ["all", "All", inState.length],
          ["mine", "Yours", inState.filter((s) => s.mine !== false).length],
          ["others", "Others'", inState.filter((s) => s.mine === false).length],
        ]
      : [];
  const f = who.length ? pick : "all";
  const all = every.filter((s) => f === "all" || (f === "mine") === (s.mine !== false));
  const states = FILTERS.map(([k, l]) => [k, l, all.filter((s) => inFilter(s, k)).length] as [string, string, number]).filter(([k, , n]) => n || k === st);
  // One state alone isn't worth a pill, unless it's what's left out.
  const pills = st !== "all" || states.length > 1 || states.some(([k]) => k === "hidden" || k === "archived") ? states : [];
  const shown = barSort(inState.filter((s) => all.includes(s)));
  const starting =
    f === "others" || !["all", "working"].includes(st) ? [] : ((launches || []) as LaunchRow[]).filter((l) => l.page === p.id && !l.post && !l.archived);
  const off = [...new Set(all.map(shelf).filter(Boolean))];
  const row = (list: [string, string, number][], cur: string, set: (k: string) => void, unpick = false) => (
    <div className="bar-pills">
      {list.map(([k, l, n]) => (
        <button key={k} className={`pill${cur === k ? " is-on" : ""}`} type="button" onClick={() => set(unpick && cur === k ? "all" : k)}>
          {l} {n}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <Keyed k="head">
        <BarHead p={p} n={every.filter((s) => !shelf(s)).length} />
        {pills.length ? row(pills, st, (k) => setPageUi({ barState: { ...getPageUi().barState, [p.id]: k } }), true) : null}
        {who.length ? row(who, f, (k) => setPageUi({ barFilter: k })) : null}
      </Keyed>
      <Keyed k="list">
        <div className="bar-list">
          {starting.map((l) => (
            <a key={l.id} className="bar-row" href={href(`launch:${l.id}`)} style={hueVars(l.agent)}>
              <Avatar agent={l.agent} size="av--sm" on={!l.error} />
              <span className="bar-t">
                <b>{plainMentions(l.prompt.split("\n")[0])}</b>
                <small>
                  {l.error ? (
                    <span className="chip">Couldn't start</span>
                  ) : (
                    <span className="chip chip--live">
                      <i className="pulse" />
                      Starting
                    </span>
                  )}
                </small>
              </span>
              <span className="bar-m">{ago(l.at)}</span>
            </a>
          ))}
          {shown.map((s) => (
            <a key={s.id} className={`bar-row${s.effective === "needs" ? " is-needs" : ""}`} href={href(s.id)} style={hueVars(s.agent)}>
              <Avatar agent={s.agent} size="av--sm" on={s.effective !== "done"} />
              <span className="bar-t">
                <b>{s.title}</b>
                <small>
                  <BarChips p={p} s={s} />
                </small>
              </span>
              <span className="bar-m">{barWhen(s)}</span>
            </a>
          ))}
          {shown.length || starting.length ? null : st !== "all" ? (
            <p className="bar-note muted">None here.</p>
          ) : (
            <p className="bar-note">
              {off.length ? `Its threads are all ${off.join(" or ")}.` : "No threads on it yet."}
              {p.mine && !p.archived ? " Ask about it, or for a change, below." : ""}
            </p>
          )}
        </div>
      </Keyed>
      <Keyed k="foot">
        <BarFoot p={p} />
      </Keyed>
    </>
  );
}
// Its foot: the box that starts a thread on it, for the people who keep it.
function BarFoot({ p }: { p: PageRec }) {
  if (p.archived) return <p className="bar-foot bar-note muted">It's archived: bring it back to start threads on it.</p>;
  if (!p.can_edit)
    return <p className="bar-foot bar-note muted">Only the people who keep it (@{p.owner} and its contributors) start threads on it, for now.</p>;
  return (
    <div className="bar-foot">
      <Composer page={p.id} bar />
    </div>
  );
}

// Show the widgets a change changed: over the page, the sheet hides it, so closed, the page goes to the first; beside
// it, they're scrolled to and flash.
export function flashWidgets(ids: string[]) {
  const els = ids.map((id) => document.querySelector<HTMLElement>(`.pg-main [data-wid="${CSS.escape(id)}"]`)).filter(Boolean);
  els[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
  for (const el of els) {
    el.classList.remove("is-flash");
    void el.offsetWidth;
    el.classList.add("is-flash");
  }
}
// A change it made to the page, where it happened in its conversation: what it changed, a way to see it, and Undo
// while it's the page's latest version.
function BarChange({ p, v, history }: { p: PageRec; v: PageVersionRow; history: PageVersionRow[] }) {
  const r = useApp((s) => s.route);
  const ids = [...new Set((v.changes || []).map((c) => c.id).filter(Boolean))];
  const prev = history.find((x) => x.v < v.v);
  const see = () => {
    if (document.body.classList.contains("bar-sheet")) return void (location.hash = `${pageHref(p)}?${new URLSearchParams({ ...r.filters, w: ids[0] })}`);
    flashWidgets(ids);
  };
  return (
    <div className="pg-chg">
      <Icon name={v.v === 1 ? "spark" : "page"} />
      <div className="pg-chg-t">
        <b>
          {v.v === 1 ? "Made the page" : "Changed the page"} · <a href={pageHref(p, `versions/${v.v}`)}>v{v.v}</a>
        </b>
        <small>{v.summary}</small>
      </div>
      {ids.length ? (
        <button className="btn btn--line btn--sm" type="button" onClick={see}>
          <Icon name="eye" />
          See it
        </button>
      ) : null}
      {p.can_edit && !p.archived && v.v === p.version && prev ? (
        <RestoreBtn
          p={p}
          v={prev.v}
          stay
          className="btn btn--line btn--sm"
          title={`Saves the page as it was at v${prev.v}, as v${p.version + 1}. v${v.v} stays in its versions.`}
        >
          <Icon name="undo" />
          Undo
        </RestoreBtn>
      ) : null}
    </div>
  );
}

function AskedBy({ s }: { s: Thread }) {
  if (s.routine)
    return (
      <>
        <a href={routineHref(s.routine.id)}>
          <Icon name="repeat" />
          {s.routine.name}
        </a>{" "}
        asked
      </>
    );
  const from = startedFrom(s);
  if (from && !s.side_at)
    return (
      <>
        <a href={threadHref(from.id)} title={from.title || ""}>
          {from.label || "The thread that started it"}
        </a>{" "}
        asked
      </>
    );
  return <>{s.mine === false ? `@${postOwner(s)} asked` : "You asked"}</>;
}

// One thread, small: its conversation, its questions where they were asked, its changes to the page where they
// happened, its steps folded to one line, what it's doing now, and the box to write to it.
function BarThread({ p, id, href }: { p: PageRec; id: string; href: (id?: string) => string }) {
  const o = useOpenThread(id, { bar: true });
  const sheet = useMedia(BAR_SHEET);
  const detail = usePageDetail(p);
  const launches = useApp((s) => s.data?.launches);
  const questions = useApp((s) => s.data?.questions);
  const stepsOpen = usePageUi((s) => s.barSteps);
  const l = id.startsWith("launch:") ? ((launches || []) as LaunchRow[]).find((x) => x.id === id.slice(7)) : null;
  // Just started from the bar: it opens here once it has a thread.
  useEffect(() => {
    if (l?.post) location.replace(href(l.post));
  }, [l?.post]);
  const back = (
    <a className="icon-btn" href={href()} aria-label="Its threads" title="Its threads">
      <Icon name="back" />
    </a>
  );
  const only = (who: ReactNode, text: string) => (
    <>
      <Keyed k="head">
        <header className="bar-h bar-h--thread">
          {back}
          <span className="bar-who">{who}</span>
        </header>
      </Keyed>
      <Keyed k="body" data-bar-body="">
        <p className="bar-note muted">{text}</p>
      </Keyed>
    </>
  );
  if (id.startsWith("launch:")) {
    if (!l) return only(<b>Not here any more</b>, "It was archived, or it's gone.");
    const pct = l.progress?.total ? Math.min(100, Math.floor((l.progress.done / l.progress.total) * 100)) : null;
    return (
      <>
        <Keyed k="head">
          <header className="bar-h bar-h--thread">
            {back}
            <Avatar agent={l.agent} size="av--sm" on={!l.error} />
            <span className="bar-who">
              <b>{agentName(l.agent)}</b>{" "}
              <span className="verb">{l.error ? "couldn't start" : l.step ? `is ${l.step.replace(/^./, (c) => c.toLowerCase())}` : "is starting"}</span>
              <small>{agoText(l.at)}</small>
            </span>
          </header>
        </Keyed>
        <Keyed k="body" data-bar-body="">
          <div className="bar-body" style={hueVars(l.agent)}>
            <h3 className="bar-title">{plainMentions(l.prompt.split("\n")[0])}</h3>
            {l.error ? (
              <p className="post-text err">{l.error}</p>
            ) : (
              <div className="live live--step">
                <i className="pulse" />
                <b>{l.step || (l.cloning ? "Cloning" : "Starting")}</b>
                {pct == null ? null : (
                  <>
                    <span className="meter">
                      <span>
                        <b style={{ width: `${pct}%` }} />
                      </span>
                      <em>{pct}%</em>
                    </span>
                    <span className="live-n">
                      {l.progress.done.toLocaleString()} / {l.progress.total.toLocaleString()} files
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </Keyed>
      </>
    );
  }
  // Drawn from what q/thread gave, and what the page's stream says changed since, as on its own page.
  if (!o || o.loading) return only(<b>Loading…</b>, "");
  if (!o.detail) return only(<b>Not here</b>, "This thread isn't on agentbook, or it isn't yours to see.");
  const said = o.detail.messages || [];
  const s = { ...o.detail, messages: said.filter((m) => !m.queued), files: o.detail.files || [] };
  const queue = said.filter((m) => m.queued);
  const qs = (questions || []).filter((q) => q.post === s.id);
  const history = detail?.history || [];
  const convo: { at: string; key: string; node: ReactNode }[] = [
    ...s.messages.map((m, i) => ({
      at: m.at,
      key: `m:${m.id}`,
      node: <Bubble m={m} s={s} last={i === s.messages.length - 1} quick={i === s.messages.length - 1} />,
    })),
    ...qs.map((q) => ({
      at: askSpot(q, s.messages),
      key: `q:${q.id}`,
      node: q.answered ? (
        <Answered q={q} s={s} />
      ) : (
        <InConvo thread={s}>
          <AskBlock q={q} />
        </InConvo>
      ),
    })),
    // Its changes to the page, where they happened in its conversation.
    ...history
      .filter((v) => v.by?.post && onPageMachine(p, v.by.post) === s.id)
      .map((v) => ({ at: v.at, key: `v:${v.v}`, node: <BarChange p={p} v={v} history={history} /> })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const tools = (o.steps?.steps || []).filter((x) => x.kind === "tool");
  const waiting = !qs.some((q) => !q.answered) && waitsElsewhere(s);
  const now = showsLive(s) ? (
    <LiveLine s={s} />
  ) : waiting ? (
    <InConvo thread={s}>
      <WaitingElsewhere thread={s} />
    </InConvo>
  ) : null;
  const prompt = s.prompt ? typedText(s.routine ? s.prompt.replace(ROUTINE_HEAD, "") : s.prompt) : "";
  const when = barWhen(s);
  return (
    <>
      <Keyed k="head">
        <header className="bar-h bar-h--thread">
          {back}
          <Avatar agent={s.agent} size="av--sm" on={s.effective !== "done"} />
          <span className="bar-who">
            <b>{s.label}</b> <span className="verb">{verb(s)}</span>
            <small>
              {s.mine === false ? `@${postOwner(s)}'s ` : ""}
              {agentName(s.agent)} · {when === "now" ? "just now" : `${when} ago`}
            </small>
          </span>
          <a className="icon-btn" href={threadHref(s.id)} aria-label="Open it in full" title="Open it in full">
            <Icon name="external" />
          </a>
          {sheet ? <BarFoldBtn p={p} /> : null}
        </header>
      </Keyed>
      <Keyed k="body" data-bar-body="">
        <div className="bar-body" style={hueVars(s.agent)}>
          <h3 className="bar-title">{s.title}</h3>
          <div className="bar-chips">
            <BarChips p={p} s={s} />
          </div>
          <div className="comments">
            {convo.length ? (
              convo.map((c) => <Fragment key={c.key}>{c.node}</Fragment>)
            ) : s.prompt ? (
              <p className="post-text muted">
                <AskedBy s={s} />: “{plainMentions(prompt.slice(0, 400))}”
              </p>
            ) : (
              <p className="muted">No messages yet.</p>
            )}
            {tools.length ? (
              <>
                <button className="bar-steps" type="button" aria-expanded={stepsOpen} onClick={() => setPageUi({ barSteps: !stepsOpen })}>
                  <Icon name="steps" />
                  <span>
                    <b>{plural(tools.length, "step")}</b> · {tools.at(-1).title}
                  </span>
                </button>
                {stepsOpen ? (
                  <ol className="steps">
                    {tools.slice(-10).map((st, i) => (
                      <li key={i} className={st.error ? "err" : ""}>
                        <span>{st.title}</span>
                        <time>{clock(st.at)}</time>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </>
            ) : null}
            {now}
          </div>
        </div>
      </Keyed>
      <Keyed k="foot">
        <div className="bar-reply comments" style={hueVars(s.agent)}>
          <WaitTray s={s} list={s.waiting} />
          <QueueTray s={s} queue={queue} />
          <ReplyBox s={s} />
          <SwitchChips s={s} />
        </div>
      </Keyed>
    </>
  );
}

// The bar: its list, or a thread of it open. It reaches from under the top bar to the window's bottom, and an open
// thread stays at its latest, as a conversation does, unless you scrolled up in it.
export function PageBar({ p }: { p: PageRec }) {
  const r = useApp((s) => s.route);
  const sheet = useMedia(BAR_SHEET);
  const ref = useRef<HTMLElement>(null);
  const h = barLinks(p, r, sheet);
  const size = () => {
    const b = ref.current;
    if (!b) return;
    const body = b.querySelector<HTMLElement>("[data-bar-body]");
    const atEnd = body && body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    const top = Math.max(74, b.parentElement.getBoundingClientRect().top);
    b.style.setProperty("--bar-h", `${Math.max(360, innerHeight - top - 16)}px`);
    if (atEnd) body.scrollTop = body.scrollHeight;
  };
  useEffect(() => {
    addEventListener("scroll", size, { passive: true });
    addEventListener("resize", size);
    return () => {
      removeEventListener("scroll", size);
      removeEventListener("resize", size);
    };
  }, []);
  // Its thread opened, or grew while you were at its end: to its end.
  const at = useRef<{ id: string | null; end: boolean }>({ id: null, end: true });
  useLayoutEffect(() => {
    size();
    const body = ref.current?.querySelector<HTMLElement>("[data-bar-body]");
    if (body && (at.current.id !== r.thread || at.current.end)) body.scrollTop = body.scrollHeight;
    at.current = { id: r.thread || null, end: true };
  });
  // Scrolled up in it, it stays where it is.
  const scrolled = (e: React.UIEvent<HTMLElement>) => {
    const body = (e.target as HTMLElement).closest?.("[data-bar-body]") as HTMLElement | null;
    if (body) at.current.end = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  };
  return (
    <aside ref={ref} className="card pg-bar" aria-label="Its threads" onScrollCapture={scrolled}>
      {r.thread ? <BarThread key={r.thread} p={p} id={r.thread} href={h.href} /> : <BarList p={p} href={h.href} />}
    </aside>
  );
}
