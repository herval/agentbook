// The box to write to a thread (the old page's replyBox), at the foot of its conversation and on its card: what you
// write goes to the selected agent (or the agents it names), held for after the turn while one runs (Enqueue), at once (Send
// now), or on the side (a side thread). Over it, what's waiting: what its machine hasn't taken yet (WaitTray) and
// what you queued (QueueTray); and for an ended or sleeping thread, how writing to it resumes or wakes it (ResumeNote),
// or that its folder is gone and what puts it back.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { drivenBy, machineOf, postOwner, runtimeOfRow, tildeOn, waits } from "../../lib/agents.ts";
import { pickFile, post, sendStaged } from "../../lib/api.ts";
import type { Reply } from "../../lib/api.ts";
import { sendingDone, sendingStarted, useMedia } from "../../lib/chrome.ts";
import { getDraft, setDraft, useDraft } from "../../lib/hooks.ts";
import { dvQuote, saidShort } from "../../lib/said.ts";
import { agentOf, getApp, useApp } from "../../lib/store.ts";
import { reloadThread } from "../../lib/thread.ts";
import { webUrl } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";
import type { Held, Message, Thread } from "../../lib/types.ts";
import { YouAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { MsgBox } from "../MsgBox.tsx";
import { kindWords } from "../machines/words.ts";
import { NextBar } from "../post/Loops.tsx";
import { resumable, sideOk, typedText, untrustedIn } from "./Bubble.tsx";
import { CmdNote, CmdPop, cmdToSend } from "./Commands.tsx";
import { FileChip } from "./FileChip.tsx";
import { ReplyRecipient, ToHint, guestRows, sendToGuests } from "./Guests.tsx";
import { hasReplyPicker, replyTargets, replyThreads, targetName, threadForReply, useReplyTo } from "./guest-rows.ts";
import { plainParts } from "./Plain.tsx";
import { DvQuoteView } from "./Quotes.tsx";
import { sentToast } from "./send.ts";
import { StagedChips, putBackStaged, saidWith, stage, stagedOf, takeStaged } from "./staged.tsx";
import type { ThreadX } from "./types.ts";

// The boxes sending now, by their draft key: their buttons wait.
const useSending = create<Record<string, boolean>>(() => ({}));
function sending(key: string, on: boolean) {
  useSending.setState({ [key]: on });
  if (on) sendingStarted();
  else sendingDone();
}
// What didn't go goes back in its box, ahead of anything written there since.
function putBack(key: string, text: string) {
  setDraft(key, [text, getDraft(key).trim()].filter(Boolean).join("\n\n"));
}

// Whether its agent runs slash commands from here: a Claude Code session in the
// background, or a thread driven by a runtime that takes them (shared/runtimes.ts, `commands`: OpenClaw's, Codex's).
// Its machine says which (Commands.tsx); this is only for the box's placeholder.
const runsCommands = (s: Thread) => s.rt?.kind === "background" || !!drivenBy(s)?.caps.commands;
// While its turn runs, what you write can wait for the turn to end: Enqueue (Enter)
// holds it for after this turn, Send now (⌘Enter, Ctrl+Enter off a Mac, or ⌥Enter) sends it at once, as Send does.
// So while it works on something between turns (`going`: a shell pushing or watching CI, a subagent), which the page
// shows as working too: then it goes in once that's done and the turn it hears back in ends.
// Not in the cloud, whose turns agentbook can't see.
export const queues = (s: Thread) => !!(s.busy || (s as ThreadX).going?.length) && s.state !== "done" && !s.asleep && s.rt?.kind !== "cloud" && !s.rt?.remote;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const NOW_KEY = MAC ? "⌘" : "Ctrl+"; // Send now's key, as the box and its menu spell it
const nowKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (MAC ? e.metaKey : e.ctrlKey);

// Holding Send now's key (⌘, Ctrl off a Mac) a moment turns Enqueue into Send now, in the box you're in or over,
// and with Shift too, into On the side where the thread takes that.
// Not when it comes with another key (⌘V, ⌘A), and not once the window loses it (⌘Tab).
let nowHeld: ReturnType<typeof setTimeout> | null = null;
const nowLetGo = () => {
  clearTimeout(nowHeld);
  nowHeld = null;
  document.body.classList.remove("now-held", "side-held");
};
document.addEventListener("keydown", (e) => {
  if (e.key === (MAC ? "Meta" : "Control")) {
    if (!e.repeat && !nowHeld && document.querySelector(".is-queueing")) nowHeld = setTimeout(() => document.body.classList.add("now-held"), 150);
    document.body.classList.toggle("side-held", e.shiftKey);
  } else if (e.key === "Shift") document.body.classList.toggle("side-held", nowKey(e));
  else if (e.key !== "Enter" && nowHeld) nowLetGo();
});
document.addEventListener("keyup", (e) => {
  if (e.key === (MAC ? "Meta" : "Control")) nowLetGo();
  else if (e.key === "Shift") document.body.classList.remove("side-held");
});
window.addEventListener("blur", nowLetGo);

// The box's one button while it works, Enqueue, has a caret whose menu has Enqueue and Send now with their keys.
// Holding ⌘ in the box, or over the button, turns it into Send now.
// `side`: the thread takes messages on the side (sideOk), so its menu has Send on the side too. The menu opens above
// its caret and closes on a pick, a click anywhere else, or Escape; ↑ and ↓ go between its rows.
// A row sends by itself (onPick), not as the form's submitter: picking it closes the menu, and React takes the row out
// of the page before the browser would submit, so a submit button there sent nothing.
function SendSplit({ off, when, side, recipient, onHow, onPick }: { off: boolean; when: string; side: boolean; recipient?: string; onHow: (how: "queue" | "now" | "side") => void; onPick: (how: "queue" | "now" | "side") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", down);
    return () => document.removeEventListener("click", down);
  }, [open]);
  const row = (how: "queue" | "now" | "side", ic: "clock" | "send" | "side", name: string, note: string, keys: string) => (
    <button
      className="fb-row q-row"
      type="button"
      role="menuitem"
      data-how={how}
      onClick={() => {
        setOpen(false);
        onPick(how);
      }}
    >
      <Icon name={ic} />
      <span className="q-row-t">
        <b>{name}</b>
        <small>{note}</small>
      </span>
      <kbd>{keys}</kbd>
    </button>
  );
  return (
    <span
      className="q-split"
      ref={ref}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          return ref.current?.querySelector<HTMLElement>("[data-send-menu]")?.focus();
        }
        const rows = [...ref.current.querySelectorAll<HTMLElement>(".q-menu [data-how]")];
        if (!["ArrowDown", "ArrowUp"].includes(e.key) || !rows.length) return;
        e.preventDefault();
        const i = rows.indexOf(document.activeElement as HTMLElement);
        rows[i < 0 ? 0 : (i + rows.length + (e.key === "ArrowDown" ? 1 : -1)) % rows.length].focus();
      }}
    >
      <button
        className="btn btn--dark q-main"
        type="submit"
        data-how="queue"
        title={`It goes in ${when} (Enter). Hold ${NOW_KEY.replace("+", "")} to send it now${side ? `, ${NOW_KEY}Shift to send it on the side` : ""}`}
        aria-label={recipient ? `Enqueue for ${recipient}` : "Enqueue"}
        disabled={off}
        onClick={(e) => {
          // ⌘-click sends it now; ⌘⇧-click on the side, where the button's menu has that.
          if (nowKey(e)) onHow(e.shiftKey && side ? "side" : "now");
        }}
      >
        <span className="q-face">
          <Icon name="clock" />
          <span className="q-lbl">Enqueue</span>
        </span>
        <span className="q-face q-face--now" aria-hidden="true">
          <Icon name="send" />
          <span className="q-lbl">Send now</span>
        </span>
        {side && (
          <span className="q-face q-face--side" aria-hidden="true">
            <Icon name="side" />
            <span className="q-lbl">On the side</span>
          </span>
        )}
      </button>
      <button
        className="btn btn--dark q-caret"
        type="button"
        data-send-menu
        data-side={side ? "" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ways to send"
        title="Ways to send"
        disabled={off}
        onClick={(e) => {
          setOpen(!open);
          // From the keyboard: its first row has the focus.
          if (!open && !e.detail) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".q-menu [data-how]")?.focus());
        }}
      >
        <Icon name="down" />
      </button>
      {open && (
        <div className="fb-menu q-menu" role="menu" aria-label="Ways to send">
          {row("queue", "clock", "Enqueue", `It goes in ${when}`, "↵")}
          {row("now", "send", "Send now", "It reads this at its next step", `${NOW_KEY}↵`)}
          {side && row("side", "side", "Send on the side", "A new thread from here", `${NOW_KEY}⇧↵`)}
        </div>
      )}
    </span>
  );
}

/* ---------- its folder gone ---------- */
// A thread whose folder is gone (another tool cleaned up its worktree) can't be resumed until it's back: Claude Code
// finds a conversation by the folder it started in. Its machine says what can put it back (read.folder), asked as
// its own page shows it, ended, and again after a resume of it fails. A button does it, and the box waits for that
// (herval's B).
interface GoneFolder {
  path: string;
  root?: string | null;
  repo?: boolean;
  branch?: string;
  base?: string;
  remote?: boolean;
  ways: string[];
  taken?: string;
  taken_by?: string;
  taken_label?: string;
}
interface FolderKept {
  data?: { gone?: GoneFolder | null } | null;
  err: string | null;
  wait?: boolean;
}
const useFolders = create<{ kept: Record<string, FolderKept>; busy: Record<string, string> }>(() => ({ kept: {}, busy: {} }));
export function useGoneFolder(s: Thread): GoneFolder | null {
  const err = useApp((st) => ((st.data?.launches || []).filter((x) => x.resume && x.post === s.id).at(-1)?.error ? "failed" : null));
  const here = useApp((st) => (st.route.name === "session" && st.route.id === s.id) || (st.route.name === "page" && st.route.thread === s.id));
  const have = useFolders((f) => f.kept[s.id]);
  const asks = s.mine !== false && resumable(s) && !drivenBy(s);
  useEffect(() => {
    if (!asks || !here) return;
    const was = useFolders.getState().kept[s.id];
    if (was?.wait || (was && was.err === err)) return;
    const put = (k: FolderKept) => useFolders.setState((f) => ({ kept: { ...f.kept, [s.id]: k } }));
    put({ err, data: was?.data, wait: true });
    fetch(`/api/sessions/${encodeURIComponent(s.id)}/folder`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => put({ err, data: d }));
  }, [asks, here, err, s.id]);
  return asks ? have?.data?.gone || null : null;
}
function GoneNote({ s, g }: { s: Thread; g: GoneFolder }) {
  const busy = useFolders((f) => f.busy[s.id]);
  const where = (p: string) => <span className="path">{tildeOn(machineOf(s), p)}</span>;
  const branch = <code>{g.branch || ""}</code>;
  const btn = (way: string, label: string, ic: "folder" | "branch" | "copy" | null, dark = true) => (
    <button
      className={`btn btn--sm ${dark ? "btn--dark" : "btn--line"}`}
      type="button"
      data-folder-way={way}
      onClick={async () => {
        useFolders.setState((f) => ({ busy: { ...f.busy, [s.id]: way } }));
        await post(`/api/sessions/${encodeURIComponent(s.id)}/folder`, { way });
        useFolders.setState((f) => {
          const busy = { ...f.busy };
          const kept = { ...f.kept };
          delete busy[s.id];
          delete kept[s.id];
          return { busy, kept };
        });
      }}
    >
      {ic && <Icon name={ic} />}
      {label}
    </button>
  );
  const deleted = <>Its folder, {where(g.path)}, was deleted.</>;
  let head: React.ReactNode = "Its folder is gone";
  let sub: React.ReactNode = <>{deleted} It can go on in an empty one, without its files.</>;
  let acts: React.ReactNode = btn("empty", "Make an empty folder there", "folder");
  if (g.repo === false && g.root !== g.path) {
    head = "Its repo is gone too";
    sub = (
      <>
        {g.root ? (
          <>
            {where(g.root)} was deleted, and so was its folder, {where(g.path)}.
          </>
        ) : (
          deleted
        )}{" "}
        It can go on in an empty folder, without its files.
      </>
    );
  } else if (g.ways[0] === "checkout") {
    sub = (
      <>
        {deleted}
        {g.remote ? " Its branch is on origin only now." : ""}
      </>
    );
    acts = btn("checkout", `Check out ${g.branch} there`, "branch");
  } else if (g.ways[0] === "copy") {
    const by = g.taken_by && (g.taken_label || "a thread");
    head = (
      <>
        {branch} is checked out in {by ? `${by}'s folder` : where(g.taken)}
      </>
    );
    sub = <>{deleted} git won't check a branch out twice, so it can have a copy of its commit, not on the branch: what it commits then goes on a new branch.</>;
    acts = (
      <>
        {by && (
          <a className="btn btn--sm btn--line" href={`#/threads/${encodeURIComponent(g.taken_by)}`}>
            Open {by}
          </a>
        )}
        {btn("copy", "Check out a copy there", "copy")}
      </>
    );
  } else if (g.ways[0] === "base") {
    head = <>{branch} is gone</>;
    sub = <>It was deleted, and so was its folder, {where(g.path)}.</>;
    acts = (
      <>
        {btn("base", `Check out ${g.base} there`, "branch")}
        {btn("empty", "Use an empty folder", null, false)}
      </>
    );
  }
  if (busy)
    acts = (
      <span className="folder-gone-busy">
        <i className="pulse" />
        {busy === "empty" ? "Making its folder" : "Checking it out"}…
      </span>
    );
  return (
    <div className="folder-gone">
      <div className="folder-gone-head">
        <Icon name="folder" />
        <span>
          <b>{head}</b>
          <small>{sub}</small>
        </span>
      </div>
      <div className="folder-gone-acts">{acts}</div>
    </div>
  );
}

// An ended session takes replies too: the first one resumes it in the background. One that's asleep wakes.
export function ResumeNote({ s }: { s: Thread }) {
  const gone = useGoneFolder(s);
  const l = useApp((st) => (st.data?.launches || []).filter((x) => x.resume && x.post === s.id && !x.archived).at(-1));
  const asleep = s.state !== "done";
  if (gone) return <GoneNote s={s} g={gone} />;
  const dir = untrustedIn(l?.error);
  // Its folder isn't trusted: said once, by your messages that couldn't wake it when they're here, each with Trust and retry.
  if (dir && (Array.isArray(s.messages) ? s.messages : s.last_messages || []).some((m) => untrustedIn(m.failed?.error))) return null;
  if (dir)
    return (
      <>
        <p className="ended post-text err">
          Claude Code doesn't trust {dir} yet, so it won't {asleep ? "wake" : "resume"} it there.
        </p>
        {s.mine !== false && (
          <div className="post-acts">
            <button
              type="button"
              data-trust-launch={l.id}
              onClick={async (e) => {
                const b = e.currentTarget;
                b.disabled = true;
                const r = await post(`/api/launches/${encodeURIComponent(l.id)}/trust`, {});
                if (!r.ok) b.disabled = false;
              }}
            >
              <Icon name="check" />
              Trust and retry
            </button>
          </div>
        )}
      </>
    );
  if (l?.error)
    return (
      <p className="ended post-text err">
        Couldn't {asleep ? "wake" : "resume"} it: {l.error}
      </p>
    );
  if (l && s.launch !== l.id && !(s.failed && Date.parse(s.failed.at) >= Date.parse(l.at)) && Date.now() - Date.parse(l.at) < 90e3)
    return (
      <div className="live">
        <i className="pulse" />
        <b>{asleep ? "Waking it" : "Resuming it"}</b>
      </div>
    );
  return asleep ? null : <p className="ended muted">This thread has ended. Write to it to resume it.</p>;
}

/* ---------- sending ---------- */
// What the box says, sent: to its agent (held for after the turn while one runs, unless now), to the agents it names,
// as a slash command its agent runs, or on the side.
async function sendFrom(s: Thread, how: "queue" | "now" | "side", typed?: string) {
  const id = s.id;
  const key = `c:${id}`;
  if (useSending.getState()[key]) return;
  const text = (typed ?? getDraft(key)).trim();
  const staged = stagedOf(key);
  if (!text && !staged.length) return;
  // Resolve against today's thread, including a guest that may have left since this box rendered.
  const current = threadForReply(id) || s;
  const named = replyTargets(current, text);
  if (!named) return toast("That agent left this thread. Choose who receives this draft.");
  const receivers = replyThreads(current, text);
  const receiver = receivers.length === 1 ? receivers[0] : current;
  if (how === "side") {
    if (receivers.length !== 1 || !sideOk(receiver)) return toast("Choose one recipient to send on the side.");
    return sendSide(receiver, key, text, staged);
  }
  // A slash command its agent runs goes as one, and waits for a turn that's running to end; one it can't run from
  // here, or that needs what it takes, stays in the box, saying so.
  const command = text.startsWith("/") && !staged.length ? await cmdToSend(receiver.id, text, key) : null;
  if (command === false) return;
  const queue = queues(command ? receiver : current) && (how !== "now" || !!command);
  sending(key, true);
  setDraft(key, "");
  takeStaged(key);
  let r: Reply = { ok: false };
  try {
    const files = await sendStaged(staged, id);
    const all = saidWith(text, staged);
    r = command
      ? await post(`/api/sessions/${encodeURIComponent(receiver.id)}/messages`, { text: all, files, ...(queue ? { queue: true } : {}), command })
      : named.to.length ? await sendToGuests(id, named, { text: all, files, queue, now: how === "now" }) : await post(`/api/sessions/${encodeURIComponent(id)}/messages`, { text: all, files, ...(queue ? { queue: true } : {}) });
    if (named.to.length && r.ok && getApp().route.name === "session") reloadThread();
    else if (r.ok) {
      sentToast(r, receiver.id);
      if (r.data.queued) reloadThread();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    sending(key, false);
    if (!r.ok) {
      putBack(key, text);
      putBackStaged(key, staged);
    }
  }
}
// On the side (sideOk): a side thread goes on from its conversation with this, and the thread never hears of it.
async function sendSide(s: Thread, key: string, text: string, staged: File[]) {
  if (!text) return toast("Say what the side thread should do.");
  if (text.startsWith("/")) return toast("A side thread starts from words, not a slash command.");
  sending(key, true);
  setDraft(key, "");
  takeStaged(key);
  let r: Reply = { ok: false };
  try {
    const files = await sendStaged(staged, s.id);
    r = await post(`/api/sessions/${encodeURIComponent(s.id)}/messages`, { text: saidWith(text, staged), files, side: true });
    if (r.ok) {
      toast(r.data.queued ? waits(r.data, "the side thread starts") : "Sent on the side: a new thread goes on from here with it.");
      reloadThread();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    sending(key, false);
    if (!r.ok) {
      putBack(key, text);
      putBackStaged(key, staged);
    }
  }
}

// `wide`: a box with room to say which does what (a thread's own page, on a wide screen).
export function ReplyBox({ s, wide = false }: { s: Thread; wide?: boolean }) {
  const key = `c:${s.id}`;
  const busy = useSending((x) => !!x[key]);
  const phone = useMedia("(max-width: 600px)");
  useReplyTo((st) => st.to[s.id]);
  useApp((st) => st.rows);
  const how = useRef<"queue" | "now" | "side">("queue");
  // What's in the box now: the hint under it follows it.
  const [draft] = useDraft(key);
  const targets = replyTargets(s, draft);
  const receivers = replyThreads(s, draft);
  const receiver = receivers.length === 1 ? receivers[0] : s;
  const gone_ = useGoneFolder(receiver);
  const done = receiver.state === "done";
  const showRecipient = hasReplyPicker(s);
  const recipient = targets ? [...(targets.host ? [agentOf(s.agent).name] : []), ...targets.to.map((t) => t.startsWith("thread:") ? agentOf(receivers.find((r) => r.id === t.slice(7))?.agent).name : targetName(t))].join(" and ") : "";
  if (s.mine === false) return <p className="ended muted">Only @{postOwner(s) || "its owner"} can write to this thread.</p>;
  // One you stopped following: nothing written here reaches its session (its machine refuses it) until you follow it again.
  if (s.off) return <p className="ended muted">You stopped following this thread, so nothing written here reaches its session until you follow it again.</p>;
  const unavailable = receiver.rt?.kind === "cloud" && !runtimeOfRow(receiver).caps.replies ? (
      <p className="ended muted">
        {runtimeOfRow(receiver).place} takes replies on{" "}
        <a href={webUrl(receiver.rt.url) || "#"} target="_blank" rel="noopener">
          its own page
        </a>
        .
      </p>
    ) : receiver.rt?.blocked ? <p className="ended muted">{receiver.rt.blocked}</p> : done && !resumable(receiver) ? <p className="ended muted">This thread has ended.</p> : null;
  if (unavailable && !showRecipient) return unavailable;
  const q = receivers.some(queues);
  const gone = (done || receiver.asleep) && !!gone_;
  const between = q && !receivers.some((r) => r.busy); // working on something between turns (s.going)
  const placeholder = !targets ? "Choose who receives this draft" : gone ? "Put its folder back to write to it" : q ? (wide && !phone ? `Enter queues it for ${between ? "when it's done" : "after this turn"} · ${NOW_KEY}Enter sends it now` : between ? "Waits until it's done…" : "Waits for this turn to end…") : receiver.rt?.kind === "cloud" ? "Write to it (it answers on claude.ai)…" : done ? "Write to resume this thread…" : receiver.asleep ? "Write to wake this thread…" : showRecipient ? `Reply to ${recipient}…` : runsCommands(receiver) ? "Reply to this thread, or / for commands…" : "Reply to this thread…";
  const off = busy || gone || !targets || !!unavailable;
  const sideTo = receivers.length === 1 && sideOk(receiver) && !gone && !unavailable;
  const go = (h: "queue" | "now" | "side", text?: string) => {
    how.current = "queue";
    sendFrom(s, h, text);
  };
  return (
    <>
      {!unavailable && (done || receiver.asleep) && <ResumeNote s={receiver} />}
      <NextBar thread={s} />
      <form
        className={`cmt-form${q ? " is-queueing" : ""}${gone ? " is-off" : ""}`}
        data-comment={s.id}
        onKeyDownCapture={(e) => {
          // ⌘⇧Enter (Ctrl+Shift+Enter off a Mac) sends on the side, where the box has that; MsgBox's Enter sends, and
          // says whether ⌘Enter (Ctrl+Enter off a Mac) or ⌥Enter asked to send it now.
          if (e.key !== "Enter" || e.nativeEvent.isComposing || !e.shiftKey || !nowKey(e) || !sideTo) return;
          if (!(e.target as Element).closest?.(".text-box")) return;
          e.preventDefault();
          e.stopPropagation();
          go("side");
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const by = ((e.nativeEvent as SubmitEvent).submitter as HTMLElement | null)?.dataset.how as "queue" | "now" | "side" | undefined;
          go(how.current !== "queue" ? how.current : by === "side" && !sideTo ? "queue" : by || "queue");
        }}
      >
        <ReplyRecipient s={s} text={draft} off={busy} />
        {unavailable}
        <div className="cmt-in">
          <YouAvatar />
          <div className="text-box">
            <MsgBox draft={key} placeholder={placeholder} label={showRecipient && recipient ? `Reply to ${recipient}` : "Reply"} off={gone || !targets || !!unavailable} links agentRows={(words) => guestRows(s.id, words, true)} onSend={(text, h) => go(q && h.now ? "now" : "queue", text)} />
            <button className="icon-btn" type="button" aria-label="Attach files" disabled={gone} onClick={() => pickFile((files) => stage(key, files), true)}>
              <Icon name="clip" />
            </button>
            {/* ↱ only while the send button has no menu: the menu has Send on the side as a row. */}
            {sideTo && !q && (
              <button className="icon-btn st-btn" type="submit" data-how="side" aria-label="Send on the side" title={`Send on the side (${NOW_KEY}⇧Enter): a new thread goes on from this conversation with it, in the background, while this one carries on`} disabled={off}>
                <Icon name="side" />
              </button>
            )}
            {q ? (
              <SendSplit off={off} when={between ? "once it's done with what it has going" : "when this turn ends"} side={sideTo} recipient={showRecipient ? recipient : undefined} onHow={(h) => (how.current = h)} onPick={(h) => go(h)} />
            ) : (
              <button className={`icon-btn${showRecipient ? " send-to-agent" : ""}`} type="submit" aria-label={showRecipient ? `Send to ${recipient || "the selected recipient"}` : "Send"} disabled={off}>
                <Icon name="send" />
                {showRecipient && <span>Send to {recipient || "…"}</span>}
              </button>
            )}
          </div>
        </div>
        {/* A key each: sharing receiver.id, React lost the list on every key typed and left it on the page for good. */}
        {targets && !unavailable && <CmdPop key={`pop:${receiver.id}`} threadId={receiver.id} draftKey={key} />}
        {targets && !unavailable && <CmdNote key={`note:${receiver.id}`} threadId={receiver.id} draftKey={key} working={q} />}
        <ToHint threadId={s.id} text={draft} recipientShown={showRecipient} />
        <StagedChips draftKey={key} />
      </form>
    </>
  );
}

/* ---------- what waits ---------- */
// What you queued for when its turn ends, under the live line, in the order it goes: each with Send now, Edit (back
// into your box, out of the queue) and Remove on hover; clicking one edits it. The line above says when they go, or
// what holds them. `compact` (a card in the feed): the next one, with the same buttons, and how many more.
export function QueueTray({ s, queue, compact = false }: { s: Thread; queue: Message[]; compact?: boolean }) {
  const asks = useApp((st) => (st.data?.questions || []).some((q) => q.post === s.id && !q.answered && q.kind !== "permission" && !q.hook && !q.routine));
  if (!queue?.length || s.mine === false) return null;
  const op = (name: string, mid?: string) => async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const b = e.currentTarget;
    b.disabled = true;
    const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/queue`, { op: name, ...(mid ? { mid } : {}) });
    if (!r.ok) b.disabled = false;
    else if (r.data.queued) toast(waits(r.data, "it does this"));
    else if (r.data.resumed) toast("Resuming it.");
  };
  // Edit: a queued message back in your box, where you change it and queue it again (last), and out of the queue.
  // One that went in meanwhile comes back to your box too (the machine says it went), for what you'd change.
  const edit = (m: Message) => async () => {
    const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/queue`, { op: "drop", mid: m.id });
    if (!r.ok && !/isn't queued any more|No such message/.test(r.data?.error || "")) return;
    const key = `c:${s.id}`;
    const was = getDraft(key).trimEnd();
    setDraft(key, was ? `${was}\n${typedText(m.text)}` : typedText(m.text));
    document.querySelector<HTMLElement>(`form[data-comment="${CSS.escape(s.id)}"] .text-box [contenteditable], form[data-comment="${CSS.escape(s.id)}"] .text-box textarea`)?.focus();
  };
  const btn = (name: string, label: string, ico: "play" | "pause" | null = null, dark = false) => (
    <button className={`btn ${dark ? "btn--dark" : "btn--line"} btn--sm`} type="button" data-queue-op={name} onClick={op(name, name === "now" ? queue[0].id : undefined)}>
      {ico && <Icon name={ico} />}
      <span className="q-lbl">{label}</span>
    </button>
  );
  let why: string;
  let acts: React.ReactNode = null;
  if (s.queue_paused === "stopped" || s.queue_paused === "ended") {
    why = s.queue_paused === "ended" ? "Paused: its session ended" : "Paused: you stopped it";
    acts = (
      <>
        {btn("now", "Send next", null, true)}
        {btn("clear", "Clear")}
      </>
    );
  } else if (s.queue_paused) {
    why = "Paused";
    acts = btn("resume", "Resume", "play");
  } else if (!s.busy && asks) {
    why = "waits for your answer to its question";
    acts = btn("pause", "Pause", "pause");
  } else if (!s.busy && !(s as ThreadX).going?.length) why = "goes in after the next turn"; // the one before it just went in, and starts that turn
  else {
    why = s.busy ? "goes in after this turn" : "goes in once it's done with what it has going";
    acts = btn("pause", "Pause", "pause");
  }
  const held = s.queue_paused || (!s.busy && asks);
  const shown = compact ? queue.slice(0, 1) : queue;
  return (
    <div className="q-tray">
      <div className={`q-head${held ? " is-held" : ""}`}>
        <span className="q-n">
          <Icon name="clock" />
          Queued · {queue.length}
        </span>
        <span className="muted">{why}</span>
        {acts && <span className="q-btns">{acts}</span>}
      </div>
      {shown.map((m, i) => {
        const q = dvQuote(typedText(m.text));
        return (
          <div className="cmt cmt-queued" key={m.id}>
            <YouAvatar />
            <div className="cmt-wide">
              <div className="cmt-bub" data-queue-edit title="Edit it in your box" onClick={edit(m)}>
                {q && !compact && <DvQuoteView q={q} />}
                <p className={`plain${compact ? " q-clamp" : ""}`}>
                  {i === 0 && <span className="q-tag">Next</span>}
                  {plainParts(q && !compact ? q.rest.trim() : saidShort(typedText(m.text)), { from: s.id })}
                </p>
                {m.files?.length > 0 && (
                  <div className="msg-files">
                    {m.files.map((f) => (
                      <FileChip key={f.id} f={{ ...f, title: f.name, from: "human", post: s.id } as unknown as Parameters<typeof FileChip>[0]["f"]} />
                    ))}
                  </div>
                )}
              </div>
              <span className="q-acts">
                <button className="icon-btn" type="button" data-queue-op="now" title="Send now" aria-label="Send now" onClick={op("now", m.id)}>
                  <Icon name="send" />
                </button>
                <button className="icon-btn" type="button" data-queue-edit title="Edit: back in your box, out of the queue" aria-label="Edit" onClick={edit(m)}>
                  <Icon name="pencil" />
                </button>
                <button className="icon-btn" type="button" data-queue-op="drop" title="Remove" aria-label="Remove" onClick={op("drop", m.id)}>
                  <Icon name="x" />
                </button>
              </span>
            </div>
          </div>
        );
      })}
      {compact && queue.length > 1 && (
        <a className="q-more" href={`#/threads/${encodeURIComponent(s.id)}`}>
          and {queue.length - 1} more
        </a>
      )}
    </div>
  );
}

// What you sent a thread that its machine hasn't taken yet (it's off, or hasn't answered): by the box you wrote it in,
// as what you queue is, until its machine takes it and it's in the conversation.
// Each can be taken back while it waits. `compact`: a card's, with the last one only.
export function WaitTray({ s, list, compact = false }: { s: Thread; list: Held[] | null | undefined; compact?: boolean }) {
  const cloud = useApp((st) => (s.offline ? (st.data?.machines || []).find((m) => m.name === s.machine)?.cloud || null : null));
  if (!list?.length || s.mine === false) return null;
  const m = s.machine || "its machine";
  const shown = compact ? list.slice(-1) : list;
  return (
    <div className="q-tray">
      <div className="q-head is-held">
        <span className="q-n">
          <Icon name={s.offline ? "pause" : "clock"} />
          {s.offline ? (cloud?.waking ? `Waking ${m}` : cloud?.error ? `Couldn't wake ${m}` : `Waiting for ${m}`) : `On its way to ${m}`} · {list.length}
        </span>
        <span className="muted">{s.offline ? (cloud?.error ? cloud.error : cloud?.waking ? "goes in once it's awake" : "goes in when it's back") : "goes in once it takes it"}</span>
      </div>
      {shown.map((c) => (
        <div className="cmt cmt-queued cmt-waiting" key={c.cid}>
          <YouAvatar />
          <div className="cmt-wide">
            <div className="cmt-bub">
              <p className={`plain${compact ? " q-clamp" : ""}`}>{c.text ? plainParts(saidShort(typedText(c.text)), { from: s.id }) : kindWords(c.kind)}</p>
            </div>
            <button
              className="btn btn--line btn--sm"
              type="button"
              data-cancel-cmd={c.cid}
              onClick={async (e) => {
                const b = e.currentTarget;
                b.disabled = true;
                const r = await post(`/api/machines/${encodeURIComponent(s.machine)}/commands/${encodeURIComponent(c.cid)}/cancel`, {});
                if (r.ok) toast("Taken back.");
                else b.disabled = false;
                if (getApp().open?.id === s.id) reloadThread();
              }}
            >
              Take it back
            </button>
          </div>
        </div>
      ))}
      {compact && list.length > 1 && (
        <a className="q-more" href={`#/threads/${encodeURIComponent(s.id)}`}>
          and {list.length - 1} more
        </a>
      )}
    </div>
  );
}
