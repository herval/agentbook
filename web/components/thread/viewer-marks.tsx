// Marks on a picture, to its thread: a picture open in the viewer, of a thread you can write to (its own, or the one it's
// shown in), takes a numbered mark where you click, with a box beside it for what you say about it. As many as you
// like, each a click away to change or remove; they're kept for each picture while you step through the others or
// close it (lib/viewer.ts's `marks`). Send sends them in one message: a copy of the picture with the marks drawn on
// it, attached, and each mark's number, where it is and what you wrote. A picture whose bytes this page can't read
// (one from another site) goes without the copy. On a picture you haven't sent yet (a box's), they go into your message
// instead (marksKeep).
import { useEffect, useLayoutEffect, useRef } from "react";
import { Icon } from "../Icon.tsx";
import { post, sendStaged } from "../../lib/api.ts";
import type { Reply } from "../../lib/api.ts";
import { waits } from "../../lib/agents.ts";
import { plural } from "../../lib/format.ts";
import { isImage } from "../../lib/markdown.ts";
import { marksText } from "../../lib/said.ts";
import { getApp, threadRow } from "../../lib/store.ts";
import { reloadThread } from "../../lib/thread.ts";
import { toast } from "../../lib/toast.ts";
import { markSet, markUrl, marks, marksChanged, useViewer } from "../../lib/viewer.ts";
import type { ViewerFile } from "../../lib/viewer.ts";
import { NOW_KEY, nowKey, queues, writable } from "./diff-view.tsx";
import { setStaged, stagedMarks, stagedOf } from "./staged.tsx";

const V = useViewer.getState;
// The thread a picture goes to: its own, or the one it's shown in.
const markThread = (f: ViewerFile) => threadRow(f.post || V().post);
// Whether a picture takes marks: one you haven't sent, or one of a thread you can write to.
export const markable = (f: ViewerFile | null | undefined) => !!(f && (f.image || isImage(f.name || "")) && (f.staged || writable(markThread(f))));
let markEsc = 0; // when Esc last closed a mark's box
export const markEscAt = () => markEsc;
const sendingTo = new Set<string>(); // marks:<thread> being sent
let picEl: HTMLImageElement | null = null; // the picture the marks are on, for its marked copy

// The open mark's box closes; one you wrote nothing on goes with it.
export function closeMarks() {
  const m = markSet();
  const i = V().markOpen;
  if (m && i != null && m.pins[i] && !m.pins[i].text.trim()) m.pins.splice(i, 1);
  if (i != null || m) marksChanged({ markOpen: null });
}

// The picture with its marks on it, as a PNG, or null when this page can't read its bytes.
async function markedCopy(img: HTMLImageElement, pins: { x: number; y: number }[], name: string): Promise<File | null> {
  if (!img) return null;
  if (!img.complete) await img.decode().catch(() => {});
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return null;
  const k = Math.min(1, 2400 / Math.max(w0, h0));
  const [w, h] = [Math.round(w0 * k), Math.round(h0 * k)];
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  const r = Math.max(12, Math.min(30, Math.round(Math.min(w, h) * 0.026)));
  pins.forEach((p, i) => {
    const [x, y] = [p.x * w, p.y * h];
    g.save();
    g.shadowColor = "rgba(18, 24, 33, 0.35)";
    g.shadowBlur = r * 0.5;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = "#6a4fd1";
    g.fill();
    g.restore();
    g.lineWidth = Math.max(2, r * 0.16);
    g.strokeStyle = "#fff";
    g.stroke();
    // A thin dark edge outside the white one, so a mark shows on white and on violet alike.
    g.beginPath();
    g.arc(x, y, r + g.lineWidth / 2 + 0.75, 0, Math.PI * 2);
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(18, 24, 33, 0.55)";
    g.stroke();
    g.fillStyle = "#fff";
    g.font = `700 ${Math.round(r * (i >= 9 ? 0.95 : 1.1))}px ${getComputedStyle(document.body).fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(i + 1), x, y + r * 0.04);
  });
  try {
    const blob = await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("no bytes"))), "image/png"));
    return new File([blob], `marked-${String(name).replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "picture"}.png`, { type: "image/png" });
  } catch {
    return null; // a picture from another site: the canvas won't give its bytes
  }
}

// Comments on a picture you haven't sent: the picture on the box becomes the copy with your numbered marks drawn on it,
// and what you said about each goes with your message (staged.tsx's saidWith). No comments left: the picture as it was.
async function marksKeep() {
  const f = V().list[V().i];
  const m = f?.staged && marks.get(markUrl(f));
  const files = m ? [...stagedOf(f.staged.key)] : null;
  const i = files ? files.indexOf(f.staged.file) : -1;
  if (i < 0) return;
  const was = stagedMarks.get(files[i]);
  const orig = was?.orig || files[i];
  const pins = m.pins.filter((p) => p.text.trim());
  if (!pins.length && !was) return;
  let next = orig;
  if (pins.length) {
    next = await markedCopy(picEl, pins, orig.name);
    if (!next) return toast("Couldn't draw your marks on this picture.");
    stagedMarks.set(next, { orig, block: marksText(orig.name, pins, { copy: next.name }), n: pins.length });
  }
  files[i] = next;
  m.pins = pins;
  setStaged(f.staged.key, files);
  // The viewer's close has nothing to say.
  useViewer.setState({ kept: true, markOpen: null, open: false });
}

// Send them, in one message to its thread (held for after the turn while one runs, unless `now`).
export async function marksSend(now = false) {
  const f = V().list[V().i];
  if (f?.staged) return marksKeep();
  const url = f && markUrl(f);
  const m = url && marks.get(url);
  const s = m && threadRow(m.post);
  const key = m && `marks:${m.post}`;
  if (!s || sendingTo.has(key)) return;
  // A mark you wrote nothing on doesn't go, nor does its number.
  const pins = m.pins.filter((p) => p.text.trim());
  if (!pins.length) return;
  sendingTo.add(key);
  marksChanged();
  const queue = queues(s) && !now;
  let r: Reply = { ok: false };
  try {
    const copy = await markedCopy(picEl, pins, m.name);
    const files = copy ? await sendStaged([copy], s.id) : [];
    r = await post(`/api/sessions/${encodeURIComponent(s.id)}/messages`, { text: marksText(m.name, pins, { copy: copy?.name, url: new URL(url, location.href).href }), files, ...(queue ? { queue: true } : {}) });
  } catch (err) {
    toast(err.message);
  } finally {
    sendingTo.delete(key);
  }
  if (!r.ok) return marksChanged();
  marks.delete(url);
  useViewer.setState({ markOpen: null, open: false, kept: true });
  const n = plural(pins.length, "comment");
  if (r.data.queued) toast(waits(r.data, `it gets your ${n}`));
  else if (r.data.resumed) toast(`Resuming it, with your ${n}.`);
  else toast(queue ? `${s.label || "It"} gets your ${n} when this turn ends.` : `Sent your ${n} to ${s.label || "it"}.`);
  const route = getApp().route;
  if (route.name === "session" && route.id === s.id) reloadThread();
}

// A mark, or its chip on the bar, clicked: its box opens, or closes when it's the one open. The one open, with nothing
// written on it, goes: the marks after it move up one.
function pickMark(e: React.MouseEvent, i: number) {
  e.stopPropagation();
  const m = markSet();
  if (!m) return;
  const open = V().markOpen;
  if (open === i) return closeMarks();
  if (open != null && !m.pins[open]?.text.trim()) {
    m.pins.splice(open, 1);
    if (open < i) i--;
  }
  marksChanged({ markOpen: m.pins[i] ? i : null });
}
const keepLabel = (file: File, n: number) => (n ? `${stagedMarks.has(file) ? "Update" : "Add"} ${plural(n, "comment")}` : stagedMarks.has(file) ? "Remove the comments" : "Add to your message");

// The picture, its marks over it, and the bar under it: a hint, or the marks as chips with Clear and Send (Add to your
// message, on one not sent yet).
export function MarksBody({ f, url }: { f: ViewerFile; url: string }) {
  useViewer((s) => s.rev);
  const markOpen = useViewer((s) => s.markOpen);
  const img = useRef<HTMLImageElement>(null);
  if (!marks.has(url)) marks.set(url, { post: f.staged ? null : markThread(f)?.id || null, name: f.name || f.title || "picture", pins: [] });
  const m = marks.get(url);
  useEffect(() => {
    picEl = img.current;
    return () => void (picEl === img.current && (picEl = null));
  });
  const said = m.pins.filter((p) => p.text.trim());
  const s = threadRow(m.post);
  const later = !!s && queues(s);
  const st = f.staged;
  const sending = sendingTo.has(`marks:${m.post}`);
  return (
    <>
      <div className="viewer-body marks-body" onScroll={() => window.dispatchEvent(new Event("marks:place"))}>
        <div className="marks-pic" data-marks="">
          <img
            ref={img}
            src={url}
            alt={f.title}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              const x = (e.clientX - r.left) / r.width;
              const y = (e.clientY - r.top) / r.height;
              if (x < 0 || x > 1 || y < 0 || y > 1) return;
              closeMarks(); // the one open, with nothing written on it, goes
              m.pins.push({ x, y, text: "" });
              marksChanged({ markOpen: m.pins.length - 1 });
            }}
          />
          <div className="marks-pins">
            {m.pins.map((p, i) => (
              <button key={i} className={`mark${markOpen === i ? " is-open" : ""}${p.text.trim() ? "" : " is-empty"}`} type="button" style={{ left: `${(p.x * 100).toFixed(3)}%`, top: `${(p.y * 100).toFixed(3)}%` }} data-mark={i} aria-label={`Mark ${i + 1}${p.text.trim() ? `: ${p.text.trim()}` : ""}`} title={p.text.trim()} onClick={(e) => pickMark(e, i)}>
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="marks-bar">
        {!m.pins.length && !(st && stagedMarks.has(st.file)) ? (
          <p className="marks-hint">
            <Icon name="comment" />
            Click anywhere on the picture to comment on that spot
          </p>
        ) : (
          <>
            <div className="marks-list">
              {m.pins.map((p, i) => (
                <button key={i} className={`marks-chip${markOpen === i ? " is-open" : ""}`} type="button" data-mark={i} onClick={(e) => pickMark(e, i)}>
                  <b>{i + 1}</b>
                  <span>{p.text.trim() ? p.text.trim() : <i>Say something…</i>}</span>
                </button>
              ))}
            </div>
            <button
              className="rp-quiet"
              type="button"
              data-marks-clear=""
              title="Remove all the marks"
              onClick={(e) => {
                e.stopPropagation();
                m.pins = [];
                marksChanged({ markOpen: null });
              }}
            >
              Clear
            </button>
            {st ? (
              <button
                className="btn btn--dark"
                type="button"
                title="They go out with your message"
                disabled={!said.length && !stagedMarks.has(st.file)}
                onClick={(e) => {
                  e.stopPropagation();
                  void marksKeep();
                }}
              >
                {keepLabel(st.file, said.length)}
              </button>
            ) : (
              <button
                className="btn btn--dark"
                type="button"
                title={later ? `It gets them when this turn ends (${NOW_KEY.replace("+", "")}-click sends them now)` : `Send them to ${s?.label || "it"}`}
                disabled={!said.length || sending}
                onClick={(e) => {
                  e.stopPropagation();
                  void marksSend(nowKey(e));
                }}
              >
                <Icon name={later ? "clock" : "send"} />
                {said.length ? `${later ? "Enqueue" : "Send"} ${plural(said.length, "comment")}` : "Send"}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

// The open mark's box, beside its mark on the side with room; on a screen too narrow for that (a phone), under it, or
// over it near the bottom. Never over the mark, and inside the window. In it, Enter is Done (Shift+Enter a new line),
// ⌘Enter sends them all, and Esc closes the box rather than the viewer.
export function MarksPop() {
  useViewer((s) => s.rev);
  const i = useViewer((s) => s.markOpen);
  const m = markSet();
  const p = i != null ? m?.pins[i] : null;
  const pop = useRef<HTMLFormElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const place = () => {
    const el = pop.current;
    const pin = el && el.closest("dialog")?.querySelector(`.mark[data-mark="${i}"]`);
    if (!pin) return;
    const r = pin.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const fit = (n: number, size: number, room: number) => Math.max(8, Math.min(n, room - size - 8));
    let left: number;
    let top: number;
    if (r.right + 10 + w <= innerWidth - 8) [left, top] = [r.right + 10, fit(r.top - 10, h, innerHeight)];
    else if (r.left - 10 - w >= 8) [left, top] = [r.left - 10 - w, fit(r.top - 10, h, innerHeight)];
    else {
      left = fit(r.left + r.width / 2 - w / 2, w, innerWidth);
      top = r.bottom + 10 + h <= innerHeight - 8 ? r.bottom + 10 : fit(r.top - 10 - h, h, innerHeight);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  useLayoutEffect(place);
  // Its box stays beside its mark as the window changes or the picture scrolls.
  useEffect(() => {
    if (!p) return;
    addEventListener("resize", place);
    addEventListener("marks:place", place);
    return () => {
      removeEventListener("resize", place);
      removeEventListener("marks:place", place);
    };
  });
  // Opened: what's in it ready to go on.
  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    autosize(t);
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, [i, !!p]);
  if (!p) return null;
  return (
    <form
      className="mark-pop"
      data-mark-pop={i}
      ref={pop}
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        closeMarks();
      }}
    >
      <p className="mark-pop-h">
        <b>{i + 1}</b>
        {p.text.trim() ? "Your comment on this spot" : "Comment on this spot"}
      </p>
      <textarea
        ref={ta}
        rows={2}
        placeholder="What about it?"
        aria-label={`Your comment on mark ${i + 1}`}
        value={p.text}
        onChange={(e) => {
          p.text = e.target.value;
          autosize(e.target);
          marksChanged();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && (nowKey(e) || e.altKey)) {
            e.preventDefault();
            closeMarks();
            return void marksSend(true);
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            return closeMarks();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            markEsc = Date.now(); // the viewer's cancel that follows doesn't close it
            closeMarks();
          }
        }}
      />
      <div className="rp-send">
        <button
          className="rp-quiet"
          type="button"
          onClick={() => {
            m.pins.splice(i, 1);
            marksChanged({ markOpen: null });
          }}
        >
          <Icon name="x" />
          Remove
        </button>
        <button className="btn btn--dark" type="submit">
          {p.text.trim() ? "Done" : "Add"}
        </button>
      </div>
    </form>
  );
}
// A box grows with what's in it, up to a point.
function autosize(t: HTMLTextAreaElement) {
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
}
