// A message in a thread's conversation (the old page's bubble): yours or its agent's, a guest's, a routine's run, a
// slash command's output, a file it sent; with what agentbook draws for a reply (its turn's shape, link cards, the
// replies it suggests), a message that couldn't be delivered, and what you sent on the side.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { agentName, drivenBy, inactiveAgent, kindCaps, postOwner, runtimeOfRow, typedIn } from "../../lib/agents.ts";
import { runtimeInfo } from "../../../plugin/shared/runtimes.ts";
import { post } from "../../lib/api.ts";
import { waits } from "../../lib/agents.ts";
import { ago, clock, hueVars } from "../../lib/format.ts";
import { isImage, postPics } from "../../lib/markdown.ts";
import { routineHref } from "../../lib/route.ts";
import { MARKS_HEAD, dvQuote, marksQuote } from "../../lib/said.ts";
import { agentOf, allRows, getApp, threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { Message, Thread, ThreadDetail } from "../../lib/types.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../Avatar.tsx";
import { StatusChip } from "../Chips.tsx";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import type { MdRun } from "../Markdown.tsx";
import { ArtifactFrame, FileChip, artifactOf } from "./FileChip.tsx";
import { together } from "./Guests.tsx";
import { plainParts } from "./Plain.tsx";
import { DvQuoteView, MarkedPic, MarksQuoteView } from "./Quotes.tsx";
import { ShapedBody, QuickRow, hasShape, linesOf } from "./ReplyShape.tsx";
import { toggleMsgOpen, useMsgOpen } from "./reply-state.ts";
import { getDraft } from "../../lib/hooks.ts";
import { hasReplyPicker, replyMentions, replyPeople, setReplyTo } from "./guest-rows.ts";
import "./Runs.tsx"; // sets mdActions.runs, wherever a message is drawn
import { sayToThread } from "./send.ts";
import type { SaidMsg, ThreadX } from "./types.ts";
import { TalkSentTo } from "../../views/thread/TalkPage.tsx";

const VIA: Record<string, string> = { slack: "Slack", telegram: "Telegram", whatsapp: "WhatsApp", discord: "Discord", signal: "Signal", imessage: "iMessage", webchat: "the web chat", tui: "its terminal app", cli: "the terminal", desktop: "its desktop app" };
// The first prompt of a thread is its prompt (plus what agentbook adds for its agent).
export const isPrompt = (m: Message, s: Thread) => m.from === "human" && !!s.prompt && !!m.text?.startsWith(s.prompt);
// A routine's run, sent to its thread (or the prompt a routine started it with): from the routine, not from you,
// and without the header agentbook adds for its agent.
export const routineOfMsg = (m: Message, s: Thread) => (m.from !== "human" ? null : m.routine || ((s as ThreadX).routine && isPrompt(m, s) ? (s as ThreadX).routine : null));
export const ROUTINE_HEAD = /^This is a run of the routine "[^"]*" on agentbook[^\n]*\n\n/;
// What the person wrote, without what agentbook adds after it for the agent: the pages and widgets it names, and
// the files attached.
export const typedText = (text: string) => String(text || "").split(/\n\n(?:Named|Attached files):\n/)[0];
// The thread one was started from, as a row, when they see it: the sidebar's, or the one its own page came with.
export function startedFrom(s: Thread): Thread | null {
  if (!s?.started_from) return null;
  const d = getApp().open?.detail;
  return threadRow(s.started_from) || (d?.id === s.id ? d.from : null) || null;
}
// Its name, a link to it: agentbook's routine, or its agent's cron job (`why: "cron"`), which only its owner can open.
function RoutineName({ rt, s }: { rt: NonNullable<Message["routine"]>; s: Thread }) {
  if (rt.why !== "cron") return <a href={routineHref(rt.id)}>{rt.name}</a>;
  return s.mine === false ? <>{rt.name}</> : <a href={`#/agents/${encodeURIComponent(s.agent)}/routines/${encodeURIComponent(rt.id)}`}>{rt.name}</a>;
}
// A long message folds, with "Show all": one from the terminal, or a reply of its agent's without a verdict (one with
// ab_verdict's folds under it, ShapedBody). Only when folding hides most of it: folded, it
// shows about 8 lines, so it folds past 16, and a thread's last, what you open it to read, past 32.
const folds = (m: Message, last: boolean) => (m.via === "terminal" || (m.from !== "human" && !m.command && !m.file_id)) && linesOf(m.text) > (last ? 32 : 16);

// The folder Claude Code says it doesn't trust, in why it wouldn't start, wake or resume a session.
export const untrustedIn = (error: string | null | undefined) => /Workspace not trusted\. Run `claude` in (\/.+?) once and accept/.exec(error || "")?.[1] || null;
// A message of yours that couldn't be delivered: it says so, and why, and its owner can send it again or delete it.
// One that couldn't wake its session because Claude Code doesn't trust its folder: agentbook can trust it, as Claude
// Code's trust prompt there would, and send it again.
function Undelivered({ m, s }: { m: Message; s: Thread }) {
  if (!m.failed) return null;
  const raw = String(m.failed.error || "").trim();
  const dir = untrustedIn(raw);
  const why = dir ? `Claude Code doesn't trust ${dir} yet, so it won't wake this session there.` : raw;
  const act = (verb: "retry" | "trust" | "delete") => async (e: React.MouseEvent<HTMLButtonElement>) => {
    const b = e.currentTarget;
    b.disabled = true;
    const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/messages/${encodeURIComponent(m.id)}/${verb}`, {});
    if (!r.ok) b.disabled = false;
    else if (r.data.queued) toast(waits(r.data, verb === "delete" ? "it's deleted" : "it's sent again"));
  };
  const mayAct = s.mine !== false;
  return (
    <>
      <span className="cmt-failed">
        <Icon name="alert" />
        Not delivered
      </span>
      {mayAct && (
        <>
          {dir ? (
            <button type="button" data-msg-trust={m.id} onClick={act("trust")}>
              Trust and retry
            </button>
          ) : (
            <button type="button" data-msg-retry={m.id} onClick={act("retry")}>
              Try again
            </button>
          )}
          <button type="button" data-msg-delete={m.id} onClick={act("delete")}>
            Delete
          </button>
        </>
      )}
      {why && <p className="cmt-why">{why[0].toUpperCase() + why.slice(1)}</p>}
    </>
  );
}

// Where a message's code blocks can be run, and their runs shown: on its thread's own record (its page, or a page's
// threads bar), and on its card in a list (the feed's, which has the runs of the messages it shows). Its owner runs
// them, in a thread with a folder on its machine.
export const runsOf = (s: Thread, m: Message): MdRun | null => (Array.isArray(s.runs) ? { post: s.id, mid: m.id, play: s.mine !== false && !s.cloud && s.rt?.kind !== "cloud" && !s.rt?.remote } : null);

// Whether its agent can be resumed once it ended: its runtime resumes ended sessions (a Claude Code session's), or
// it's a driven thread, which its runtime goes on with (shared/runtimes.ts).
export const resumable = (s: Thread) => !!s.session_id && (!!kindCaps(agentOf(s.agent).kind)?.resumes || !!drivenBy(s));
// It asked you something you haven't answered (not a permission, a hook's, or a routine's).
export const asksYou = (s: Thread) => (getApp().data?.questions || []).some((q) => q.post === s.id && !q.answered && q.kind !== "permission" && !q.hook && !q.routine);
// Whether a reply gets its suggested replies: its thread's latest message, from its own agent (not a guest's or a
// routine's), on a thread of yours that takes one now, with nothing asked of you that they'd talk past.
export function quickOk(m: SaidMsg, s: Thread) {
  if (m.from === "human" || m.guest || m.command || m.file_id || routineOfMsg(m, s)) return false;
  if (s.mine === false || s.talk || s.rt?.blocked || (s.rt?.kind === "cloud" && !runtimeOfRow(s).caps.replies)) return false;
  if (s.state === "done" && !resumable(s)) return false;
  return !asksYou(s) && !(s.queue || []).length;
}
// Sending on the side: what you write goes to a side thread, a fork of this thread that goes on
// from its conversation so far, in the background and in its folder, while this one carries on and never hears of it.
// Its owner's, on a thread of theirs on a machine (not one in the cloud) whose agent's runtime goes on in side threads
// (shared/runtimes.ts, `side`: Claude Code's and Codex's), running on that runtime itself: driven by it, or, for one
// whose sessions are their own process (Claude Code's, which has no procs of its own), not driven by another.
export const sideOk = (s: Thread) => {
  if (s.mine === false || s.talk || !s.session_id || s.rt?.remote) return false;
  if (inactiveAgent(agentOf(s.agent))) return false;
  const kind = agentOf(s.agent).kind;
  if (!kindCaps(kind)?.side || s.rt?.kind === "cloud") return false;
  const own = runtimeInfo(kind);
  const d = drivenBy(s);
  return d ? d.id === own.id : !own.procs.length;
};

// A side thread's latest reply, brought back to the thread it was sent from (SideCard): as a message from you, which
// waits for a turn that's running to end.
async function bringBack(side: Thread, to: string, b: HTMLButtonElement) {
  if (!side?.reply) return;
  const text = `From my side thread ${side.label}${side.title && side.title !== side.label ? ` ("${side.title}")` : ""}, which went on from this conversation:\n\n${side.reply.text}`.slice(0, 12000);
  b.disabled = true;
  const t = threadRow(to) as ThreadX;
  const r = await sayToThread(to, text, { queue: !!t && !!(t.busy || t.going?.length) && t.state !== "done" && !t.asleep && t.rt?.kind !== "cloud" && !t.rt?.remote, toastIt: false });
  b.disabled = false;
  if (!r.ok) return;
  toast(r.data.queued ? waits(r.data, "it gets the reply") : `Sent ${side.label}'s reply to ${threadRow(to)?.label || "this thread"}.`);
}
// What you sent on the side, under it: the side thread it started as it is now (starting, couldn't start, or its row),
// and on this thread's own page its latest reply, which Bring back sends this thread.
function SideCard({ m, s }: { m: Message; s: Thread }) {
  const here = useApp((st) => (st.open?.detail?.id === s.id ? (st.open.detail.startedThreads || []).find((r) => r.launch === m.launch) : null));
  const row = useApp((st) => here || (m.launch ? allRows(st).find((r) => r.launch === m.launch) : null));
  const l = useApp((st) => (!row && m.launch ? (st.data?.launches || []).find((x) => x.id === m.launch) : null));
  if (!row && !l) return null;
  const reply = here?.reply;
  const said = reply ? reply.verdict?.line || reply.text.split(/\n\s*\n/)[0] : "";
  const back = reply && sideOk(s);
  // Its name, as threads go by, and its own title once it has one other than what you sent.
  const head = row ? (
    <a className="act-row" href={`#/threads/${encodeURIComponent(row.id)}`}>
      <Avatar agent={row.agent} size="av--sm" on={row.effective === "working" ? "active" : false} />
      <span>
        <b>
          <Icon name="side" />
          {row.label}
        </b>
        <small>{row.title && row.title !== m.text.split("\n")[0] ? row.title : "Side thread"}</small>
      </span>
      <StatusChip thread={row} />
      <time>{ago(row.updated || row.started)}</time>
    </a>
  ) : (
    <div className="act-row">
      <Avatar agent={l.agent} size="av--sm" on={!l.error} />
      <span>
        <b>
          <Icon name="side" />
          Side thread
        </b>
        <small className={l.error ? "err" : undefined}>{l.error ? l.error : l.waiting ? `Waits for ${l.waiting}` : "Going on from this conversation"}</small>
      </span>
      {l.error ? (
        <span className="chip">Couldn't start</span>
      ) : (
        <span className="chip chip--live">
          <i className="pulse" />
          Starting
        </span>
      )}
      <time>{ago(l.at)}</time>
    </div>
  );
  return (
    <div className="st-card">
      {head}
      {said && <p className="st-said q-clamp">{said}</p>}
      {back && (
        <div className="st-acts">
          <button className="btn btn--sm" type="button" data-side-back={row.id} title="Send this thread its reply, as a message from you" onClick={(e) => bringBack(row, s.id, e.currentTarget)}>
            <Icon name="undo" />
            Bring back
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- links as cards ---------- */
// A web address an agent wrote: its page's title, what it's about, its site and its picture, read by the server
// (unfurl.ts) the first time it's shown. Not a pull request (it has its own card), a picture, or agentbook itself.
// Three a message at most; one whose page can't be read stays a link in the text.
interface LinkSeen {
  title?: string;
  text?: string;
  site?: string;
  image?: string;
  error?: boolean;
}
// "thread url" -> undefined (not asked), null (asked), its card, or { error }
const useLinks = create<Record<string, LinkSeen | null>>(() => ({}));
const LINK_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?*_]/g;
function linksIn(text: string): string[] {
  const t = String(text || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  const out = [];
  for (const [u] of t.matchAll(LINK_RE)) {
    let host: string;
    try {
      host = new URL(u).host;
    } catch {
      continue;
    }
    if (host === location.host || /^(localhost|127\.|\[::1\])/.test(host)) continue;
    if (/github\.com$/.test(host) && /\/pull\/\d+/.test(u)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|mp4|mov|pdf|zip)([?#]|$)/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
    if (out.length === 3) break;
  }
  return out;
}
function LinkCard({ s, url }: { s: Thread; url: string }) {
  const key = `${s.id} ${url}`;
  const c = useLinks((st) => st[key]);
  useEffect(() => {
    if (useLinks.getState()[key] !== undefined) return;
    useLinks.setState({ [key]: null });
    fetch(`/api/sessions/${encodeURIComponent(s.id)}/link?url=${encodeURIComponent(url)}`)
      .then(async (res) => useLinks.setState({ [key]: res.ok ? await res.json() : { error: true } }))
      .catch(() => useLinks.setState({ [key]: { error: true } }));
  }, [key]);
  if (c?.error || (c && !c.title && !c.text)) return null;
  const host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  return (
    <a className={`lk${c ? "" : " is-loading"}`} href={url} target="_blank" rel="noopener">
      {c?.image ? (
        <span className="lk-img">
          <img src={`/api/sessions/${encodeURIComponent(s.id)}/link/picture?url=${encodeURIComponent(url)}`} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </span>
      ) : (
        <span className="lk-img lk-img--none" aria-hidden="true">
          {(c?.site || host)[0]?.toUpperCase() || ""}
        </span>
      )}
      <span className="lk-b">
        <small>{c?.site || host}</small>
        <b>{c?.title || url.replace(/^https?:\/\//, "")}</b>
        {c?.text && <p>{c.text}</p>}
      </span>
    </a>
  );
}
export function LinkCards({ s, text }: { s: Thread; text: string }) {
  const list = linksIn(text);
  if (!list.length) return null;
  return (
    <div className="lks">
      {list.map((u) => (
        <LinkCard key={u} s={s} url={u} />
      ))}
    </div>
  );
}

// The agents a message of yours names in a thread's conversation, as chips: who's in it, by the names @ gives them.
// The rest of what you wrote, as Plain draws it.
export function SaidText({ text, s }: { text: string; s: Thread }) {
  if (!text) return null;
  if (!s.guests?.length) return <p className="plain">{plainParts(text, { from: s.id })}</p>;
  const names = [...together(s), ...(s.guests || []).filter((g) => g.label).map((g) => ({ ...g, name: g.label })), ...(s.guests || []).map((g) => ({ ...g, name: agentOf(g.agent).name }))].sort((a, b) => b.name.length - a.name.length);
  const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s(])@(${names.map((x) => reEsc(x.name)).join("|")})(?![\\w-])`, "g");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index + m[1].length;
    const who = names.find((x) => x.name === m[2]);
    if (at > last) out.push(...plainParts(text.slice(last, at), { from: s.id }));
    out.push(
      <span className="mchip" style={hueVars(who.agent)} key={`a${at}`}>
        @{m[2]}
      </span>,
    );
    last = at + m[2].length + 1;
  }
  if (last < text.length) out.push(...plainParts(text.slice(last), { from: s.id }));
  return <p className="plain">{out}</p>;
}

// Where in the thread a peeked file opens from: its own thread, while you may see its files.
export const peekOf = (s: Thread) => (s.mine !== false && s.rt?.kind !== "cloud" ? s.id : null);

// `quick`: it's the latest message of its thread as shown, so a reply of its agent's gets the replies it suggests.
// `raw`: a reply of its agent's as it wrote it, without what agentbook draws for it (its turn's shape, link cards,
// suggested replies): Raw output, over a thread's conversation. `frames`: a claude.ai artifact's copy shows as its
// page (a thread's own page), not a chip.
export function Bubble({ m: msg, s, last = false, quick = false, raw = false, frames = false }: { m: Message; s: Thread | ThreadDetail; last?: boolean; quick?: boolean; raw?: boolean; frames?: boolean }) {
  const m = msg as SaidMsg;
  const t = s as Thread;
  const me = useApp((st) => st.me);
  const detailFiles = useApp((st) => (st.open?.detail?.id === s.id ? st.open.detail.files : null));
  const onPage = useApp((st) => st.route.name === "session" && st.route.id === s.id);
  const open = useMsgOpen(m.id);
  const rt = routineOfMsg(m, t);
  if (rt) {
    // Its prompt, the same every run: a long one folds, last or not.
    const text = m.text.replace(ROUTINE_HEAD, "");
    const long = linesOf(text) > 16;
    const isOpen = long && open;
    return (
      <div className={`cmt cmt-rt ${long ? "cmt-long" : ""} ${isOpen ? "is-open" : ""} ${m.failed ? "is-failed" : ""}`}>
        <span className="av av--sm av--rt">
          <Icon name="repeat" />
        </span>
        <div className="cmt-wide">
          <div className="cmt-bub">
            <b>
              <RoutineName rt={rt} s={t} /> <span className="via">a routine</span>
            </b>
            <p className="plain">{plainParts(text)}</p>
          </div>
          <div className="cmt-meta">
            <span>{clock(m.at)}</span>
            {long && (
              <button type="button" data-more={m.id} aria-expanded={isOpen} onClick={() => toggleMsgOpen(m.id)}>
                {isOpen ? "Show less" : "Show all"}
              </button>
            )}
            <Undelivered m={m} s={t} />
          </div>
        </div>
      </div>
    );
  }
  // The first prompt of a thread another one started (a Claude Desktop task): that thread wrote it, not you.
  const by = m.from === "human" && !m.guest && !s.side_at && isPrompt(m, t) ? startedFrom(t) : null;
  const you = m.from === "human" && !by;
  // A guest's, or yours to it: as its agent's, saying so, its thread a click away.
  const g = m.guest ? (s.guests || []).find((x) => x.id === m.guest) || { id: m.guest, agent: m.agent, label: null } : null;
  const aid = g ? m.agent || g.agent : by ? by.agent : s.agent;
  const toG = g ? (
    <a href={`#/threads/${encodeURIComponent(g.id)}`} title="Open its thread">
      {g.label || "its thread"} ↗
    </a>
  ) : null;
  // Someone else wrote it (`m.user`, from when an agent's owner could let others operate it): them, not its owner.
  const sender = you ? (m.user ? (m.user === me?.username ? null : m.user) : s.mine === false ? postOwner(s) : null) : null;
  const who = you ? (
    sender ? (
      `@${sender}`
    ) : (
      "You"
    )
  ) : by ? (
    <a href={`#/threads/${encodeURIComponent(by.id)}`} title={by.title || ""}>
      {by.label}
    </a>
  ) : (
    agentName(aid)
  );
  // In a thread of yours every agent is one: its thread is enough.
  const via = by ? (
    <span className="via">started this thread</span>
  ) : m.via === "side" ? (
    <span className="via">on the side</span>
  ) : g && !you ? (
    <span className="via">
      {s.talk ? "" : "guest · "}
      {toG}
    </span>
  ) : m.command && !you ? (
    <span className="via">
      <code>/{m.command}</code> printed
    </span>
  ) : m.via === "terminal" ? (
    <span className="via">in {typedIn(s)}</span>
  ) : m.via && m.via !== "dash" ? (
    <span className="via">on {VIA[m.via] || m.via}</span>
  ) : null;
  let body: ReactNode;
  let shaped = false;
  let framed = false;
  if (m.file_id) {
    const f = (detailFiles || s.last_files || []).find((x) => x.id === m.file_id);
    // A claude.ai artifact's copy shows as its page on the thread's own page (`frames`), a chip anywhere else.
    framed = frames && !!f && !!artifactOf(f);
    body = framed ? <ArtifactFrame f={f} /> : f ? <FileChip f={f} /> : <p className="muted">Sent a file</p>;
  } else if (m.command && you && m.text.startsWith(`/${m.command}`)) {
    // A slash command you ran: its name as typed, then what it took.
    body = (
      <p className="plain">
        <code className="cmd">/{m.command}</code>
        {m.text.slice(m.command.length + 1)}
      </p>
    );
  } else if (m.command && !you) {
    // What a slash command printed: as it printed it, or its Markdown copy (/context's table).
    body = <Markdown text={m.text} peek={peekOf(t)} pics={postPics(s)} from={s.id} />;
  } else {
    // A post's first prompt names its attached files and their paths for Claude, and the pages and widgets it
    // names; show just the text.
    const text = you ? typedText(m.text) : m.text;
    shaped = !you && !raw && hasShape(m);
    const q = you ? dvQuote(text) : null;
    const mq = you && !q ? marksQuote(text) : null;
    const runs = g ? null : runsOf(t, m);
    body = you ? (
      q ? (
        <>
          <DvQuoteView q={q} />
          <SaidText text={q.rest.trim()} s={t} />
        </>
      ) : mq ? (
        <MarksQuoteView q={mq} s={t} />
      ) : (
        <SaidText text={text} s={t} />
      )
    ) : shaped ? (
      <ShapedBody m={m} s={t} text={text} runs={runs} act={quick && quickOk(m, t)} />
    ) : text ? (
      <Markdown text={text} peek={peekOf(t)} pics={postPics(s)} from={s.id} run={runs} />
    ) : raw && hasShape(m) ? (
      <p className="muted">It wrote nothing, only what agentbook draws.</p>
    ) : null;
  }
  // Your marks on a picture: the copy with them on it, as a picture, over what you said about each.
  const marked = you && !!m.files?.length && MARKS_HEAD.test(m.text || "") && marksQuote(typedText(m.text));
  const fileOf = (f: Message["files"][number]) => ({ ...f, title: f.name, from: m.from, post: s.id }) as unknown as Parameters<typeof FileChip>[0]["f"];
  const files = marked ? (
    <div className="msg-files marks-sent">{m.files.map((f) => (isImage(f.name) ? <MarkedPic key={f.id} f={fileOf(f)} /> : <FileChip key={f.id} f={fileOf(f)} />))}</div>
  ) : m.files?.length ? (
    <div className="msg-files">
      {m.files.map((f) => (
        <FileChip key={f.id} f={fileOf(f)} />
      ))}
    </div>
  ) : null;
  // One with its turn's shape folds in it (ShapedBody), so what it made stays in view; a long one without, as before.
  const long = !shaped && folds(m, last);
  const isOpen = long && open;
  const picks = quick && !raw && m.shape?.replies?.length && quickOk(m, t) ? m.shape.replies : [];
  return (
    <div data-msg={m.id} className={`cmt ${you ? "" : "cmt-agent"} ${m.command && !you ? "cmt-cmd" : ""} ${shaped ? "cmt-shaped" : ""} ${framed ? "cmt-framed" : ""} ${long ? "cmt-long" : ""} ${isOpen ? "is-open" : ""} ${m.failed ? "is-failed" : ""}`} style={g ? hueVars(aid) : undefined}>
      {you ? sender ? <PersonAvatar who={sender} /> : <YouAvatar /> : <Avatar agent={aid} size="av--sm" />}
      <div className="cmt-wide">
        <div className="cmt-bub">
          <b>
            {who} {via}
          </b>
          {marked && files}
          {body}
          {!marked && files}
          {m.via === "side" && <SideCard m={m} s={t} />}
          {/* The web addresses its agent wrote, as cards, on its thread's page. */}
          {!you && !m.command && !raw && onPage && <LinkCards s={t} text={m.text} />}
        </div>
        <div className="cmt-meta">
          <span>{clock(m.at)}</span>
          {g && you && <span className="cmt-to">to {toG} only</span>}
          {!g && you && s.talk && Array.isArray(m.to) && <TalkSentTo m={m} s={t} />}
          {m.waited && <span>was queued</span>}
          {!you && !s.talk && !m.command && s.mine !== false && hasReplyPicker(t) && replyPeople(t).some((p) => p.id === (g?.id || s.id)) && (
            <button type="button" data-reply-to={g?.id || s.id} onClick={(e) => {
              const named = replyMentions(s.id, getDraft(`c:${s.id}`));
              if (named.to.length || named.host) toast("This draft chooses its recipients with @mentions. Change those to address someone else.");
              else setReplyTo(s.id, g?.id || s.id);
              const post = e.currentTarget.closest(".post");
              requestAnimationFrame(() => post?.querySelector<HTMLElement>(`.cmt-form .text-box [contenteditable], .cmt-form .text-box textarea`)?.focus());
            }}>Reply to {agentOf(aid).name}</button>
          )}
          {long && (
            <button type="button" data-more={m.id} aria-expanded={isOpen} onClick={() => toggleMsgOpen(m.id)}>
              {isOpen ? "Show less" : "Show all"}
            </button>
          )}
          <Undelivered m={m} s={t} />
        </div>
        {picks.length > 0 && <QuickRow s={t} m={m} picks={picks} />}
      </div>
    </div>
  );
}
