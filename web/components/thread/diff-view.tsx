// A file's change as rows of lines (DiffView), and a comment on lines of it, to its thread (the box under them). What's
// fetched and open (diffs, the files and commits opened, the lines you picked) is one small store for the thread's
// page: Changes, a step's diff and a commit's share it.
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { MsgBox } from "../MsgBox.tsx";
import { post } from "../../lib/api.ts";
import { drivenBy, kindCaps, runtimeOfRow, waits } from "../../lib/agents.ts";
import { plural } from "../../lib/format.ts";
import { getDraft, setDraft } from "../../lib/hooks.ts";
import { dvcText, dvcWhere } from "../../lib/said.ts";
import type { DiffLine } from "../../lib/said.ts";
import { agentOf, threadRow } from "../../lib/store.ts";
import { reloadThread } from "../../lib/thread.ts";
import { toast } from "../../lib/toast.ts";
import type { Asking, ChangedFile, DiffFile, Thread } from "../../lib/types.ts";
import type { ThreadX } from "./types.ts";

/* ---------- what's fetched and open ---------- */
// The lines picked for a comment: on which thread, which diff (`at`), its file and commit, the rows picked (a to b, as
// DiffView counts them), and the lines themselves.
export interface Dvc {
  thread: string;
  at: string;
  path: string;
  commit: string;
  a: number;
  b: number;
  lines: DiffLine[];
}
// A diff as fetched: a file's, with its hunks; a commit's or a step's, with its files'; or why not. null while asked.
export type DiffGot = Asking & Partial<DiffFile> & { files?: DiffFile[] };
interface DiffStore {
  thread: string | null;
  diffs: Record<string, DiffGot | null>;
  open: Set<string>;
  dvc: Dvc | null;
  sending: boolean;
}
export const useDiffs = create<DiffStore>(() => ({ thread: null, diffs: {}, open: new Set(), dvc: null, sending: false }));
const D = useDiffs.getState;
// A thread's page starts with nothing open: what was open was another thread's.
export function useDiffThread(id: string) {
  useEffect(() => {
    if (D().thread !== id) useDiffs.setState({ thread: id, diffs: {}, open: new Set(), dvc: null, sending: false });
  }, [id]);
}
// A file ("f:<path>") or a commit ("c:<sha>") of it, opened or closed.
export function toggleOpen(key: string, on?: boolean) {
  const open = new Set(D().open);
  if (on ?? !open.has(key)) open.add(key);
  else open.delete(key);
  useDiffs.setState({ open });
}
export const useOpenKey = (key: string) => useDiffs((s) => s.open.has(key));
// Fetch a diff not fetched yet: `url` under the thread's /api/sessions/<id>.
export async function fetchDiff(thread: string, key: string, url: string) {
  if (key in D().diffs) return;
  useDiffs.setState((s) => ({ diffs: { ...s.diffs, [key]: null } }));
  const res = await fetch(`/api/sessions/${encodeURIComponent(thread)}${url}`).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  useDiffs.setState((s) => ({ diffs: { ...s.diffs, [key]: res?.ok ? body : { error: body.error || "Couldn't get the diff." } } }));
}

/* ---------- small parts ---------- */
export function ChgSize({ add, del }: { add?: number; del?: number }) {
  if (!add && !del) return null;
  return (
    <span className="chg">
      {add ? <b className="chg-add">+{add}</b> : null}
      {del ? <b className="chg-del">−{del}</b> : null}
    </span>
  );
}
export function PathParts({ p }: { p: string }) {
  const i = String(p).lastIndexOf("/");
  if (i < 0) return <b>{p}</b>;
  return (
    <>
      <span className="dir">{p.slice(0, i + 1)}</span>
      <b>{p.slice(i + 1)}</b>
    </>
  );
}
// What a file's diff is, when it isn't simply before and after.
export function ChgNotes({ f }: { f: Partial<ChangedFile> }) {
  const notes = [];
  if (f.exact === false && f.edits > 1) notes.push(`Its ${f.edits} edits, one after another: what the file looked like in between wasn't recorded.`);
  if (f.outside) notes.push("Something besides these edits changed the file between them too, and that's in here.");
  return (
    <>
      {notes.map((n) => (
        <p className="chg-note" key={n}>
          {n}
        </p>
      ))}
    </>
  );
}
export function ChgTags({ f }: { f: Partial<ChangedFile> }) {
  const tags = [f.kind === "create" ? "new" : f.kind === "delete" ? "deleted" : "", f.by === "command" ? "by a command" : ""].filter(Boolean);
  return (
    <>
      {tags.map((t) => (
        <span className="tag" key={t}>
          {t}
        </span>
      ))}
    </>
  );
}

/* ---------- whether you can write to a thread from here ---------- */
// Whether it can be resumed once it ended (Bubble.tsx's resumable): its agent's runtime resumes ended sessions, or
// it's a driven thread.
const resumable = (s: Thread) => !!s.session_id && (!!kindCaps(agentOf(s.agent).kind)?.resumes || !!drivenBy(s));
// As its reply box would take it. `folderGone`: its folder is gone (the thread page's missing-folder check), and it
// ended or sleeps, so it can't be resumed until it's back.
export const writable = (s: Thread | null | undefined, folderGone = false): boolean => !!s && !s.talk && s.mine !== false && !(s.rt?.kind === "cloud" && !runtimeOfRow(s).caps.replies) && !s.rt?.blocked && !(s.state === "done" && !resumable(s)) && !((s.state === "done" || s.asleep) && folderGone);
// While its turn runs, what you write waits for it to end.
export const queues = (s: Thread | null | undefined) => !!s && !!(s.busy || (s as ThreadX).going?.length) && s.state !== "done" && !s.asleep && s.rt?.kind !== "cloud" && !s.rt?.remote;
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const NOW_KEY = MAC ? "⌘" : "Ctrl+"; // Send now's key
export const nowKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (MAC ? e.metaKey : e.ctrlKey);
const phoneWide = () => matchMedia("(max-width: 600px)").matches;

/* ---------- a diff ---------- */
// A hunk as the server sends it: where it starts and how long it is, before and after (none, for a change that has no
// line numbers), and its lines, each with its sign first.
interface Hunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines: string[];
}
// One row of a diff: a gap between hunks, or a line, with its numbers before and after.
type Row = { gap: string } | { k: number; c: string; o: number | ""; n: number | ""; text: string };

// A file's change as rows of lines: added in green, removed in red, a few unchanged ones around them, and a
// gap between hunks saying where the next one starts. Changes without line numbers just run on.
// `at`: which diff it is on a thread's page you can write to ("f:<path>", "s:<step>|<path>", "c:<sha>|<path>"), whose
// lines a click comments on (the box under them); null, and its lines take no clicks.
export function DiffView({ f, at = null, thread = null }: { f: (Asking & Partial<DiffFile>) | null | undefined; at?: string | null; thread?: string | null }) {
  const dvc = useDiffs((s) => s.dvc);
  const tbl = useRef<HTMLTableElement>(null);
  if (!f) return <p className="dv-wait">Loading the diff…</p>;
  if (f.error) return <p className="dv-wait">{f.error}</p>;
  if (f.secret) return <p className="dv-wait">Its lines stayed on the machine: {f.secret}.</p>;
  if (f.nodiff) return <p className="dv-wait">{f.by === "command" ? "The command that changed it didn't say how, so there's no diff." : "No diff to show for this one."}</p>;
  if (f.binary) return <p className="dv-wait">A binary file.</p>;
  if (!f.hunks?.length) return <p className="dv-wait">No lines changed.</p>;
  const sel = at && dvc?.at === at && dvc.thread === thread ? dvc : null;
  const rows: Row[] = [];
  let k = 0;
  (f.hunks as Hunk[]).forEach((h, i) => {
    const numbered = h.oldStart != null;
    let o = h.oldStart || 0;
    let n = h.newStart || 0;
    if (numbered && (i || (h.newStart || h.oldStart) > 1)) rows.push({ gap: `Line ${h.newLines ? h.newStart : h.oldStart}` });
    else if (!numbered && i) rows.push({ gap: "⋯" });
    if (o === 0 && h.oldLines) o = 1;
    if (n === 0 && h.newLines) n = 1;
    for (const l of h.lines) {
      const c = l[0];
      if (c === "\\") continue;
      rows.push({ k: k++, c, o: numbered && c !== "+" ? o++ : "", n: numbered && c !== "-" ? n++ : "", text: l.slice(1) });
    }
  });
  const lineRows = rows.filter((r): r is Extract<Row, { k: number }> => "k" in r);
  // A click on a line of a diff you can comment on: the box goes under it, or (shift) takes in the lines up to it. A
  // click that ends selecting text (to copy it) is left alone.
  const pickLine = (e: React.MouseEvent, k: number) => {
    if (!at || !thread || !writable(threadRow(thread))) return;
    const s = getSelection();
    if (!s.isCollapsed && tbl.current?.contains(s.anchorNode)) return;
    const was = D().dvc?.at === at && D().dvc.thread === thread ? D().dvc : null;
    let a = k;
    let b = k;
    const draft = dvcDraft(thread);
    if (was && e.shiftKey) [a, b] = [Math.min(was.a, k), Math.max(was.b, k)];
    else if (was && was.a === k && was.b === k && !getDraft(draft).trim()) return void useDiffs.setState({ dvc: null }); // the line it's on, clicked again with nothing written: closed
    const lines = lineRows.filter((r) => r.k >= a && r.k <= b).map((r) => ({ c: r.c === "+" ? "+" : r.c === "-" ? "-" : " ", o: r.o === "" ? null : r.o, n: r.n === "" ? null : r.n, text: r.text }));
    const [kind, rest] = [at.slice(0, 2), at.slice(2)];
    const path = kind === "f:" ? rest : rest.slice(rest.indexOf("|") + 1);
    const commit = kind === "c:" ? rest.slice(0, rest.indexOf("|")).slice(0, 12) : "";
    useDiffs.setState({ dvc: { thread, at, path, commit, a, b, lines } });
    if (e.shiftKey) getSelection().removeAllRanges(); // a shift-click selects the text between too
  };
  const out = [];
  let boxed = false;
  for (const [i, r] of rows.entries()) {
    if ("gap" in r) {
      out.push(
        <tr className="dv-gap" key={`g${i}`}>
          <td className="ln" colSpan={2} />
          <td>{r.gap}</td>
        </tr>,
      );
      continue;
    }
    const on = sel && r.k >= sel.a && r.k <= sel.b;
    const cls = [r.c === "+" ? "dv-add" : r.c === "-" ? "dv-del" : "", on ? "is-sel" : ""].filter(Boolean).join(" ");
    out.push(
      <tr className={cls || undefined} key={r.k} data-k={at ? r.k : undefined} onClick={at ? (e) => pickLine(e, r.k) : undefined}>
        <td className="ln">{r.o}</td>
        <td className="ln">{r.n}</td>
        <td className="code">
          <span className="sign">{r.c === "+" ? "+" : r.c === "-" ? "−" : ""}</span>
          {r.text}
        </td>
      </tr>,
    );
    if (sel && r.k === sel.b) {
      out.push(<DvcRow sel={sel} key="dvc" />);
      boxed = true;
    }
  }
  // The diff got shorter under its box (a subagent's step, fetched again): the box stays, at its end.
  if (sel && !boxed) out.push(<DvcRow sel={sel} key="dvc" />);
  return (
    <>
      <div className="dv" data-dv={at || undefined}>
        <table className="dv-t" ref={tbl}>
          <tbody>{out}</tbody>
        </table>
      </div>
      {f.more || f.cut ? <p className="dv-wait">and {plural(Number(f.more || f.cut), "more line")}, left out</p> : null}
    </>
  );
}

/* ---------- a comment on lines of a diff, to its thread ---------- */
// On a thread's page, a click on any line of a diff (its Changes, a step's, a commit's) opens a box under it; a
// shift-click takes in the lines up to another. What you write goes to the thread as your message, quoting those
// lines with their file and line numbers (dvcText), so its agent knows what you mean; the thread shows the quote as
// a bit of diff (dvQuote). One box at a time: a click on another line takes the box, and what's in it, there.
export const dvcDraft = (thread: string) => `dvc:${thread}`;
async function dvcSend(sel: Dvc, text: string, now: boolean) {
  const s = threadRow(sel.thread);
  const draft = dvcDraft(sel.thread);
  if (!s || D().sending) return;
  if (!text.trim()) return;
  const queue = queues(s) && !now;
  useDiffs.setState({ sending: true });
  const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/messages`, { text: dvcText(sel, text.trim()), files: [], ...(queue ? { queue: true } : {}) });
  useDiffs.setState({ sending: false });
  if (!r.ok) return;
  setDraft(draft, "");
  if (D().dvc === sel) useDiffs.setState({ dvc: null });
  if (r.data.queued) toast(waits(r.data, "it gets your comment"));
  else if (r.data.resumed) toast("Resuming it, with your comment.");
  else toast(queue ? `${s.label || "It"} gets your comment when this turn ends.` : `Sent to ${s.label || "it"}.`);
  if (queue || r.data.queued) reloadThread();
}
function DvcRow({ sel }: { sel: Dvc }) {
  const sending = useDiffs((s) => s.sending);
  const s = threadRow(sel.thread);
  const draft = dvcDraft(sel.thread);
  const where = dvcWhere(sel.lines);
  const later = queues(s);
  const name = s?.label || "it";
  // ⌘Enter or ⌥Enter sends it now, while its turn runs: heard before the box hears Enter.
  const now = useRef(false);
  return (
    <tr className="dv-cmt">
      <td colSpan={3}>
        <form
          className="rp-form dvc-form"
          data-dvc={sel.at}
          onKeyDownCapture={(e) => {
            if (e.key === "Enter") now.current = nowKey(e) || e.altKey;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            // Enter sends it, Shift+Enter is a new line (unless the box sent it already), Esc closes it.
            if (e.key === "Enter" && !e.shiftKey && !e.defaultPrevented) {
              e.preventDefault();
              return void dvcSend(sel, getDraft(draft), now.current);
            }
            if (e.key === "Escape") {
              useDiffs.setState({ dvc: null });
              (e.target as HTMLElement).blur?.();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void dvcSend(sel, getDraft(draft), false);
          }}
        >
          <MsgBox draft={draft} placeholder={`Comment on ${where || "this"}…`} label="Your comment" autoFocus onSend={(text) => void dvcSend(sel, text, now.current)} />
          <div className="rp-send">
            <span className="muted">{later ? `Goes to ${name} when this turn ends${phoneWide() ? "" : ` · ${NOW_KEY}Enter sends it now`}` : `Goes to ${name}, quoting ${sel.lines.length > 1 ? "these lines" : "this line"}`}</span>
            <button className="rp-quiet" type="button" onClick={() => useDiffs.setState({ dvc: null })}>
              Cancel
            </button>
            <button className="btn btn--dark" type="submit" disabled={sending}>
              Comment
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}
