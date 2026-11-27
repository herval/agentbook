// What a reply made for you: what it drafted (ab_draft), options as cards (ab_cards), times
// to pick from (ab_slots), and what it put side by side (ab_compare), each with its buttons when `act` (it's the
// thread's latest reply and the thread takes a message). A button that goes ahead sends what it says as your message.
import { useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { postPics } from "../../lib/markdown.ts";
import { setDraft } from "../../lib/hooks.ts";
import type { Message, Thread } from "../../lib/types.ts";
import { openPicture } from "../../lib/viewer.ts";
import type { Card, Compare, Draft, Slots } from "../../../plugin/shared/types.ts";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { MovedNumbers } from "../visual/MovedNumbers.tsx";
import { peekOf } from "./Bubble.tsx";
import { linked } from "./Plain.tsx";
import { actedNow, forgetCardPicks, markActed, pickCard, pickSlot, setBaAt, toggleOpenKey, useBaAt, useCardPicks, useSlotPick } from "./reply-state.ts";
import { sayToThread } from "./send.ts";

// A picture a reply's shape names (a card's, a compare's): on the web or a path on its agent's machine, it comes
// through its thread either way, from the copy the server keeps (a local one is sent up as it's named). Only a web
// address went through before, so a card's `/tmp/mock.png` loaded from the page's own address, and broke.
const shapePic = (u: string, pics: string | null) => (pics ? `${pics}?url=${encodeURIComponent(u)}` : u);

// What each part of a reply's card reads: its thread, its message, whether its buttons show, and whether one of them
// went ahead already (by its key: "d0", "c1", "slots", …).
export interface ReplyCx {
  s: Thread;
  m: Message;
  act: boolean;
  gone: (key: string) => boolean;
  open: (key: string) => boolean;
}

// Going ahead with a draft, a card or a time: what its button says goes as your message (held while a turn runs).
// Continue on cards that go together goes ahead with each card you picked, in one message (`picks`: forget them
// once it went). Its buttons stay gone ahead unless it didn't go.
export async function goAhead(id: string, keys: string[], text: string, picks: string | null = null) {
  if (actedNow(keys)) return;
  markActed(keys, true);
  const r = await sayToThread(id, text, { toastIt: false });
  if (!r.ok) markActed(keys, false);
  else if (picks) forgetCardPicks(picks);
}
export function GoBtn({ cx, k, label, says, dark = true, off = false }: { cx: ReplyCx; k: string; label: string; says: string; dark?: boolean; off?: boolean }) {
  return (
    <button className={`btn ${dark ? "btn--dark" : "btn--line"} btn--sm`} type="button" disabled={off} onClick={() => goAhead(cx.s.id, [`${cx.m.id}:${k}`], says)}>
      {label}
    </button>
  );
}
export const AheadLine = ({ what }: { what: string }) => (
  <span className="rs-done">
    <Icon name="check" />
    {what}
  </span>
);

// Edit on a draft: the thread's box, saying what it's about, for you to say what to change, with the caret at its end.
function editDraft(id: string, text: string) {
  const key = `c:${id}`;
  setDraft(key, text);
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLElement>(`[data-draft="${CSS.escape(key)}"]`);
    if (!box) return;
    box.focus();
    if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) return box.setSelectionRange(box.value.length, box.value.length);
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
}

// A picture of a reply's opens in the viewer, its arrows going to the reply's other pictures; a cmd- or ctrl-click
// opens its tab.
function openPic(e: MouseEvent<HTMLElement>) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openPicture(e.currentTarget);
}

/* ---------- drafts ---------- */

// What it drafted for you (ab_draft): an email, a pull request, an invite, a message, as the thing itself. Its button
// tells the agent to go ahead; Edit puts what to change in the box.
const DRAFT_GO: Record<string, string> = { email: "Send", pull_request: "Open the pull request", invite: "Send the invite", message: "Send" };
const DRAFT_SAY: Record<string, (d: Draft) => string> = { email: (d) => `Send the email “${d.subject}” as drafted.`, pull_request: (d) => `Open the pull request “${d.title}” as drafted.`, invite: (d) => `Send the invite “${d.title}” as drafted.`, message: (d) => `Send the message to ${d.to} as drafted.` };
const draftName = (d: Draft) => (d.kind === "email" ? `the email “${d.subject}”` : d.kind === "pull_request" ? `the pull request “${d.title}”` : d.kind === "invite" ? `the invite “${d.title}”` : `the message to ${d.to}`);
export const whenText = (at: string, opts: Intl.DateTimeFormatOptions = {}) => new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...opts });
const listOf = (v: string | string[] | null | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

export function DraftCard({ cx, d, i }: { cx: ReplyCx; d: Draft; i: number }) {
  const { s, m, act } = cx;
  const key = `d${i}`;
  const openKey = `rs:${m.id}:${key}`;
  const open = cx.open(openKey);
  const go = d.action || DRAFT_GO[d.kind];
  const says = d.action ? `${d.action}: ${draftName(d)}, as drafted.` : DRAFT_SAY[d.kind](d);
  const acts = !act ? null : cx.gone(key) ? (
    <AheadLine what={`Told ${s.label || "it"} to go ahead`} />
  ) : (
    <>
      <GoBtn cx={cx} k={key} label={go} says={says} />
      <button className="btn btn--line btn--sm" type="button" onClick={() => editDraft(s.id, `About ${draftName(d)}: `)}>
        Edit
      </button>
    </>
  );
  const more = (cut: boolean) =>
    cut ? (
      <button className="rs-ghost" type="button" onClick={() => toggleOpenKey(openKey)}>
        {open ? "Less" : "Read it all"}
      </button>
    ) : null;
  const body = String(d.body || "");
  if (d.kind === "email") {
    const cut = body.length > 360 || body.split("\n").length > 6;
    const cc = listOf(d.cc);
    return (
      <div className="rs-card">
        <p className="rs-kind">
          <Icon name="mail" />
          Email draft<span className="r">nothing goes out until you say so</span>
        </p>
        <dl className="rs-mail-h">
          <dt>To</dt>
          <dd>{listOf(d.to).join(", ")}</dd>
          {cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd>{cc.join(", ")}</dd>
            </>
          )}
          <dt>Subject</dt>
          <dd>
            <b>{d.subject}</b>
          </dd>
        </dl>
        <div className={`rs-mail-b${cut && !open ? " is-cut" : ""}`}>{linked(body)}</div>
        <div className="rs-acts">
          {acts}
          {more(cut)}
          {d.from && <span className="muted">from {d.from}</span>}
        </div>
      </div>
    );
  }
  if (d.kind === "pull_request") {
    const cut = body.length > 500;
    return (
      <div className="rs-card">
        <p className="rs-kind">
          <Icon name="pr" />
          Pull request to open{d.repo && <span className="r">{d.repo}</span>}
        </p>
        <div className="rs-pr-h">
          <h4>{d.title}</h4>
          {d.branch && (
            <div className="rs-pr-meta">
              <span className="chip chip--branch">
                <Icon name="branch" />
                {d.branch}
                {d.base ? ` → ${d.base}` : ""}
              </span>
            </div>
          )}
        </div>
        {body && <Markdown text={body} peek={peekOf(s)} pics={postPics(s)} from={s.id} className={`rs-pr-d md${cut && !open ? " is-cut" : ""}`} />}
        <div className="rs-acts">
          {acts}
          {more(cut)}
        </div>
      </div>
    );
  }
  if (d.kind === "invite") {
    const end = d.minutes ? new Date(Date.parse(d.when) + d.minutes * 60e3) : null;
    const attendees = listOf(d.attendees);
    return (
      <div className="rs-card">
        <p className="rs-kind">
          <Icon name="calendar" />
          Invite
        </p>
        <div className="rs-inv">
          <span className="rs-day">
            <small>{new Date(d.when).toLocaleDateString([], { month: "short" })}</small>
            <b>{new Date(d.when).getDate()}</b>
          </span>
          <div>
            <h4>{d.title}</h4>
            <p>
              {whenText(d.when)}
              {end ? `–${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
              {d.where && <> · {linked(d.where)}</>}
            </p>
            {attendees.length > 0 && <p className="muted">{attendees.join(", ")}</p>}
            {body && <p>{linked(body)}</p>}
          </div>
        </div>
        <div className="rs-acts">{acts}</div>
      </div>
    );
  }
  return (
    <div className="rs-card">
      <p className="rs-kind">
        <Icon name="comment" />
        Message to {listOf(d.to).join(", ")}
        {d.via ? ` on ${d.via}` : ""}
      </p>
      <div className="rs-mail-b">{linked(body)}</div>
      <div className="rs-acts">{acts}</div>
    </div>
  );
}

/* ---------- cards ---------- */

// Options as cards (ab_cards): a picture, a few facts, a badge, a price against a limit, its buttons. Cards that can
// go together (its pick "several", the default): a button picks its card (one of its buttons), and Continue under them
// sends what you picked as one message. Alternatives (its pick "one"), or only one card to act on: a button sends at once.
// A price reads with its currency in front and the rest of its unit after: "$/mo" is $18,000/mo, "€/night" €95/night,
// "USD" 18,000 USD, "$k" $18k. Every unit went in front before, so "$/mo" read $/mo18,000.
export function priceText(unit: string | null | undefined, n: number | string) {
  const u = String(unit || "").trim();
  const cur = u.match(/^[A-Za-z]{0,3}\p{Sc}/u)?.[0] || "";
  const rest = u.slice(cur.length).trim().replace(/\s*\/\s*/g, "/");
  const after = !rest ? "" : /^([/%°]|[kKMB](\/|$))/.test(rest) ? rest : ` ${rest}`;
  return `${cur}${typeof n === "number" ? n.toLocaleString() : n}${after}`;
}
function PriceChart({ p }: { p: Card["price"] }) {
  const vals = p.series || [];
  if (vals.length < 2) return null;
  const W = 300;
  const H = 64;
  const all = p.limit != null ? [...vals, p.limit] : vals;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (vals.length - 1)) * W;
  const y = (v: number) => 4 + (1 - (v - lo) / span) * (H - 8);
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const min = vals.indexOf(Math.min(...vals));
  return (
    <>
      <svg className="rs-price" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`From ${priceText(p.unit, vals[0])} to ${priceText(p.unit, vals.at(-1))}${p.limit != null ? `, against ${priceText(p.unit, p.limit)}` : ""}`}>
        <polygon className="area" points={`0,${H} ${line} ${W},${H}`} />
        <polyline className="line" points={line} />
        {p.limit != null && <line className="limit" x1="0" x2={W} y1={y(p.limit)} y2={y(p.limit)} />}
        <circle className="low" cx={x(min)} cy={y(vals[min])} r="3" />
      </svg>
      {(p.from || p.to) && (
        <p className="rs-price-x">
          <span>{p.from || ""}</span>
          <span>{p.to || ""}</span>
        </p>
      )}
    </>
  );
}
export function CardsBlock({ cx, cards, pick }: { cx: ReplyCx; cards: Card[]; pick?: "several" | "one" }) {
  const { s, m, act } = cx;
  const chosen = useCardPicks(m.id);
  const says = (c: Card, a: { label: string; says?: string }) => a.says || `${a.label}: ${c.title}`;
  const several = act && pick !== "one" && cards.filter((c) => c.actions?.length).length > 1;
  const picks = several ? chosen : {};
  const on = (i: number) => picks[i] != null && !!cards[i].actions?.[picks[i]] && !cx.gone(`c${i}`);
  const one = (c: Card, i: number) => {
    const key = `c${i}`;
    const p = c.price;
    const diff = p && p.limit != null ? p.value - p.limit : null;
    const acts: ReactNode = !act || !c.actions?.length ? null : cx.gone(key) ? (
      <AheadLine what={`Told ${s.label || "it"}`} />
    ) : several ? (
      c.actions.map((a, k) => (
        <button className={`btn ${picks[i] === k ? "btn--dark" : "btn--line"} btn--sm`} type="button" aria-pressed={picks[i] === k} key={k} onClick={() => pickCard(m.id, i, k)}>
          {picks[i] === k && <Icon name="check" />}
          {a.label}
        </button>
      ))
    ) : (
      c.actions.map((a, k) => <GoBtn key={k} cx={cx} k={key} label={a.label} says={says(c, a)} dark={k === 0} />)
    );
    return (
      <div className={`rs-opt${on(i) ? " is-on" : ""}`} key={i}>
        {c.image && (
          <a className="md-img" href={shapePic(c.image, postPics(s))} target="_blank" rel="noopener" aria-label={c.title} onClick={openPic}>
            <img className="rs-pic" src={shapePic(c.image, postPics(s))} alt="" loading="lazy" referrerPolicy="no-referrer" />
          </a>
        )}
        <div className="rs-opt-b">
          <b>
            {c.url ? (
              <a href={c.url} target="_blank" rel="noopener">
                {c.title}
              </a>
            ) : (
              c.title
            )}
          </b>
          {c.text && <p>{c.text}</p>}
          {c.facts?.length > 0 && <p className="facts">{c.facts.join(" · ")}</p>}
          {c.badge && <span className="rs-badge">{c.badge}</span>}
          {p && (
            <>
              <div className="rs-price-top">
                <b>{priceText(p.unit, p.value)}</b>
                {diff != null && (
                  <span className={diff > 0 ? "over" : "under"}>
                    {priceText(p.unit, Math.abs(diff))} {diff > 0 ? "over" : "under"} your {priceText(p.unit, p.limit)}
                  </span>
                )}
              </div>
              <PriceChart p={p} />
            </>
          )}
        </div>
        {acts && <div className="rs-acts">{acts}</div>}
      </div>
    );
  };
  const grid = <div className="rs-opts">{cards.map(one)}</div>;
  // Continue, while a card is left to pick: what you picked, a line each, in the cards' order.
  if (!several || cards.every((c, i) => !c.actions?.length || cx.gone(`c${i}`))) return grid;
  const picked = cards.map((_, i) => i).filter(on);
  const lines = picked.map((i) => says(cards[i], cards[i].actions[picks[i]]));
  const text = lines.length > 1 ? lines.map((l) => `- ${l}`).join("\n") : lines[0] || "";
  return (
    <>
      {grid}
      <div className="rs-acts rs-opts-go">
        <button
          className="btn btn--dark btn--sm"
          type="button"
          disabled={!picked.length}
          onClick={() =>
            goAhead(
              s.id,
              picked.map((i) => `${m.id}:c${i}`),
              text,
              m.id,
            )
          }
        >
          {picked.length ? `Continue with ${picked.length}` : "Continue"}
        </button>
        <span className="muted">Pick any that go together.</span>
      </div>
    </>
  );
}

/* ---------- times ---------- */

export function SlotsBlock({ cx, sl }: { cx: ReplyCx; sl: Slots }) {
  const { s, m, act } = cx;
  const picked = useSlotPick(m.id);
  const times = [...sl.times].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const dayOf = (t: { at: string }) => new Date(t.at).toDateString();
  // A time's row: its minute of the day, so 9:00 comes before 14:00 whatever the clock's format.
  const hourOf = (t: { at: string }) => new Date(t.at).getHours() * 60 + new Date(t.at).getMinutes();
  const hourText = (n: number) => new Date(2000, 0, 1, Math.floor(n / 60), n % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = [...new Set(times.map(dayOf))].slice(0, 7);
  const hours = [...new Set(times.filter((t) => days.includes(dayOf(t))).map(hourOf))].sort((a, b) => a - b);
  const cell = (d: string, h: number) => {
    const t = times.find((x) => dayOf(x) === d && hourOf(x) === h);
    if (!t) return <span className="rs-slot is-none" key={`${d}${h}`} />;
    return (
      <button className={`rs-slot${t.best ? " is-best" : ""}${picked === t.at ? " is-on" : ""}`} type="button" key={`${d}${h}`} disabled={!act} onClick={act ? () => pickSlot(m.id, t.at) : undefined} title={`${whenText(t.at)}${t.best ? ", its pick" : ""}`} aria-label={whenText(t.at)} />
    );
  };
  const go = sl.action || "Send the invite";
  const acts = !act ? null : cx.gone("slots") ? <AheadLine what={`Told ${s.label || "it"}: ${go} for ${whenText(picked || times[0].at)}`} /> : <GoBtn cx={cx} k="slots" label={picked ? `${go} for ${whenText(picked)}` : "Pick a time"} says={`${go} for ${whenText(picked || times[0].at)}${sl.title ? ` (${sl.title})` : ""}.`} off={!picked} />;
  return (
    <div className="rs-card">
      <p className="rs-kind">
        <Icon name="calendar" />
        {sl.title}
        {sl.minutes ? `, ${sl.minutes} min` : ""}
        {sl.with && <span className="r">with {sl.with}</span>}
      </p>
      <div className="rs-week" style={{ "--days": days.length } as CSSProperties}>
        <span />
        {days.map((d) => (
          <span className="dh" key={d}>
            {new Date(d).toLocaleDateString([], { weekday: "short", day: "numeric" })}
          </span>
        ))}
        {hours.map((h) => [
          <span className="hh" key={`h${h}`}>
            {hourText(h)}
          </span>,
          ...days.map((d) => cell(d, h)),
        ])}
      </div>
      <div className="rs-acts">
        {acts}
        {times.some((t) => t.best) && (
          <span className="muted">
            <i className="rs-key" />
            its picks
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- side by side ---------- */

// Before and after in one frame, with a handle between them. They're too small to read in the frame, so each side of
// the handle is a link to its picture, opening in the viewer like any other, its arrows going to the other one. The
// slider in the frame is for the keyboard; the frame takes a press itself. One that sets off sideways drags the
// handle, from anywhere on it, and the click it ends in opens nothing. One that sets off up or down is left alone: a
// finger's scrolling the page, and the browser cancels the press.
function BeforeAfter({ m, P, src }: { m: Message; P: Compare["pictures"]; src: (u: string) => string }) {
  const x = useBaAt(m.id);
  const frame = useRef<HTMLDivElement>(null);
  // The frame pressed: where, whether it has moved, whether it's dragging, whether it's been let go.
  const press = useRef<{ x: number; y: number; moved: boolean; drag: boolean; up: boolean } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      const el = frame.current;
      if (!p || p.up || !el) return;
      const across = Math.abs(e.clientX - p.x);
      const down = Math.abs(e.clientY - p.y);
      if (!p.moved && Math.hypot(across, down) < 6) return;
      if (!p.moved) p.drag = across > down;
      p.moved = true;
      if (!p.drag) return;
      el.classList.add("is-drag");
      const box = el.getBoundingClientRect();
      setBaAt(m.id, Math.round(Math.min(100, Math.max(0, ((e.clientX - box.left) / box.width) * 100))));
    };
    const let_ = (e: PointerEvent) => {
      frame.current?.classList.remove("is-drag");
      if (e.type === "pointercancel") press.current = null;
      else if (press.current) press.current.up = true;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", let_);
    document.addEventListener("pointercancel", let_);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", let_);
      document.removeEventListener("pointercancel", let_);
    };
  }, [m.id]);
  const [one, two] = [P[0].label || "Before", P[1].label || "After"];
  const img = (p: Compare["pictures"][number], cls = "") => <img className={cls || undefined} src={src(p.picture)} alt={p.label || ""} loading="lazy" referrerPolicy="no-referrer" />;
  const side = (p: Compare["pictures"][number], label: string) => <a className="md-img" href={src(p.picture)} target="_blank" rel="noopener" draggable={false} aria-label={label} onClick={openPic} />;
  return (
    <div
      className="vz-ba"
      ref={frame}
      style={{ "--x": `${x}%` } as CSSProperties}
      onPointerDown={(e) => {
        press.current = e.button === 0 ? { x: e.clientX, y: e.clientY, moved: false, drag: false, up: false } : null;
      }}
      onClickCapture={(e) => {
        if (e.detail && press.current?.moved) {
          press.current = null;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {img(P[1])}
      {img(P[0], "b")}
      {side(P[0], one)}
      {side(P[1], two)}
      <span className="bar" />
      <span className="knob" aria-hidden="true">
        ‹ ›
      </span>
      <span className="vz-pin">{one}</span>
      <span className="vz-pin vz-pin--r">{two}</span>
      <input type="range" min="0" max="100" value={x} onChange={(e) => setBaAt(m.id, Number(e.target.value))} aria-label={`Drag between ${one} and ${two}`} />
    </div>
  );
}

// What it put side by side (ab_compare): before and after in one frame with a handle to drag; options to pick, its pick
// marked, a click telling it; a desktop and a phone; numbers that moved. Its pictures come through its thread, kept by
// the server (one on its machine is sent up as it's named).
export function CompareBlock({ cx, c }: { cx: ReplyCx; c: Compare }) {
  const { s, m, act } = cx;
  const pics = postPics(s);
  const src = (u: string) => shapePic(u, pics);
  const head = c.title ? <p className="rs-cmp-h">{c.title}</p> : null;
  if (c.kind === "numbers")
    return (
      <>
        {head}
        <MovedNumbers nums={c.numbers || []} />
      </>
    );
  const P = c.pictures || [];
  const img = (p: (typeof P)[number]) => <img src={src(p.picture)} alt={p.label || ""} loading="lazy" referrerPolicy="no-referrer" />;
  const open = (p: (typeof P)[number], inner: ReactNode, cls = "", key: number | string = 0) => (
    <a className={`md-img${cls ? ` ${cls}` : ""}`} href={src(p.picture)} target="_blank" rel="noopener" key={key} onClick={openPic}>
      {inner}
    </a>
  );
  if (c.kind === "before_after" && P.length >= 2)
    return (
      <>
        {head}
        <BeforeAfter m={m} P={P} src={src} />
      </>
    );
  if (c.kind === "sizes")
    return (
      <>
        {head}
        <div className="vz-dev">
          {P.map((p, i) =>
            p.frame === "phone" ? (
              open(p, img(p), "vz-phone", i)
            ) : (
              open(
                p,
                <>
                  <i>
                    <b />
                  </i>
                  {img(p)}
                </>,
                "vz-desk",
                i,
              )
            ),
          )}
        </div>
        {P.some((p) => p.label || p.text) && (
          <p className="vz-dev-k">
            {P.map((p, i) => (
              <span key={i}>
                <b>{p.label || (p.frame === "phone" ? "Phone" : "Desktop")}</b>
                {p.text ? ` ${p.text}` : ""}
              </span>
            ))}
          </p>
        )}
      </>
    );
  const letter = (i: number) => String.fromCharCode(65 + i);
  const pick = (p: (typeof P)[number], i: number) => {
    const key = `o${i}`;
    if (cx.gone(key)) return <AheadLine what={`Told ${s.label || "it"}`} />;
    return act ? <GoBtn cx={cx} k={key} label={c.action || "Pick"} says={p.says || `Go with ${p.label || letter(i)}`} dark={!!p.pick} /> : null;
  };
  return (
    <>
      {head}
      <div className={`vz-opts vz-opts--${P.length}`}>
        {P.map((p, i) => (
          <div className={`vz-opt${p.pick ? " is-pick" : ""}`} key={i}>
            {open(
              p,
              <>
                {img(p)}
                <span className="l">{letter(i)}</span>
              </>,
            )}
            <div className="vz-opt-b">
              {p.pick && <span className="vz-its">Its pick</span>}
              <b>{p.label || `Option ${letter(i)}`}</b>
              {p.text && <small>{p.text}</small>}
              {pick(p, i)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
