// app.ts msgBox and the <ab-box> it was: the box you write a message in, with @ to name a page, a widget, a note, a
// workspace, a task, a group or an agent (each a chip in the text, lib/mentions.tsx), pasted pictures, and its draft
// kept by `draft` (lib/hooks.ts useDraft). ⌘Enter / Enter sends, as the old box did.
/* A message box: what you write to an agent in. It's contenteditable, so a page or a widget you name shows as a
   chip, and it keeps a textarea's ways: `value` is its text with each chip as its token, and setting it makes the
   chips again, so drafts, sending and clearing work as they do for a textarea. It takes plain text only: pasting
   drops the formatting, and so does a drop. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { clipText } from "../lib/clip.ts";
import { useDraft } from "../lib/hooks.ts";
import { boxHtml, chipHtml, groupNamed, guestChipHtml, isAgentPick, mentioned, mentionRows, noteNamed, taskNamed, wsNamed } from "../lib/mentions.tsx";
import type { AgentPick, MentionRow, Named } from "../lib/mentions.tsx";
import { useApp } from "../lib/store.ts";
import { MentionPop } from "./bar/mention-pop.tsx";
import { stage } from "./thread/staged.tsx";
import { groupCss, pageCss } from "../lib/format.ts";

// <ab-box>, the page's own box to type in, as JSX knows it.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ab-box": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

// What a box's Enter says beyond its text: ⌘Enter (Ctrl+Enter off a Mac) or ⌥Enter, Send now, where a box queues
// while its thread works.
export interface SendHow {
  now: boolean;
}
export interface MsgBoxProps {
  draft: string;
  placeholder: string;
  label: string;
  off?: boolean;
  className?: string;
  // The page the box is about, for what a bare @widget names: the one its thread starts on or is on. Left out, the
  // page you're on; "new" (a page to make) is none.
  page?: string | null;
  // Enter sends (Shift+Enter is a new line): its text, chips as their tokens, untrimmed; whoever sends checks it's
  // not empty (files may go without words). Without onSend, Enter is a new line too.
  onSend?: (text: string, how: SendHow) => void;
  autoFocus?: boolean;
  // Keys, before the box's own (Enter sends): calling preventDefault keeps them from it. The @ list's keys come first.
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
  // After each change to the box: its text, and the box (a thread's box shows its slash commands, who it's to).
  onInput?: (text: string, box: HTMLElement) => void;
  // The box itself (to focus it, or read its agent chips, `[data-to]`). It's an AbBox: `.value` is its text.
  boxRef?: React.Ref<HTMLElement>;
  // Whether @ offers your groups and tasks, which put its thread in or on them (the old canLink): the composer, or a
  // thread's reply box; not a thread of yours, nor the composer starting one.
  links?: boolean;
  // The agents @ offers first (a thread's guests, guestRows; a thread of yours, talkRows), for the words typed after
  // the @ (rows with `hay` are narrowed to them here). A pick is a chip with `data-to`, which reads as its name.
  agentRows?: (words: string[]) => AgentPick[];
  // Where files pasted or dropped on it (or its form) are attached (thread/staged.tsx stage): "launch" for the
  // composer, "c:<thread>" for a reply box, which are its draft key's by default; null takes no files.
  stageKey?: string | null;
  id?: string;
}

// The page's own box, as other code reaches it (boxRef): a textarea's `value` and setSelectionRange.
export interface AbBox extends HTMLElement {
  value: string;
  // As a textarea's, but it only ever puts the cursor at the end, whatever it's given.
  setSelectionRange(start?: number, end?: number): void;
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// A box's text: its words, each chip as its token (an agent's, as its name), its lines as they show.
export function boxText(el: Node): string {
  let out = "";
  let chip = false;
  const add = (s: string) => {
    // Text typed right after a chip is apart from its token.
    if (chip && /^[\w/-]/.test(s)) out += " ";
    chip = false;
    out += s;
  };
  const walk = (node: Node) => {
    for (const n of node.childNodes) {
      if (n instanceof Text) add(n.data);
      else if (n instanceof HTMLElement && n.dataset.ref) {
        add(`@${n.dataset.ref}`);
        chip = true;
      } else if (n instanceof HTMLElement && n.dataset.to) {
        // An agent's (guests): its name, as it reads in the message. Who it goes to is the chip's (boxTargets).
        add(n.textContent);
        chip = true;
      } else if (n.nodeName === "BR") add("\n");
      else if (n.nodeType === 1) {
        if (/^(DIV|P)$/.test(n.nodeName) && out && !out.endsWith("\n")) add("\n");
        walk(n);
      }
    }
  };
  walk(el);
  return out.replace(/\u00a0/g, " ").replace(/\n$/, "");
}
// The cursor, at the end of the box.
export const caretToEnd = (el: HTMLElement) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
};
if (!customElements.get("ab-box"))
  customElements.define(
    "ab-box",
    class extends HTMLElement {
      get value() {
        return boxText(this);
      }
      set value(text: string) {
        this.innerHTML = boxHtml(text);
      }
      // As a textarea's, which is only ever used to put the cursor at the end.
      setSelectionRange() {
        caretToEnd(this);
      }
    },
  );

// What a token typed in a box names: "@page/widget"; "@widget", on the box's page (`here`); else "@page".
function namedIn(here: string | null, pid: string | undefined, id: string): Named | null {
  if (pid) {
    const n = mentioned(pid, id);
    return n?.w ? n : null;
  }
  const n = here && mentioned(here, id);
  return n?.w ? n : mentioned(id);
}

// Chips the box holds after an undo or a paste may have lost what makes them chips. Only what's missing is put
// back: any other change to the box would cost it its undo history.
function paintChips(box: HTMLElement) {
  for (const el of box.querySelectorAll<HTMLElement>("[data-ref]")) {
    const ref = el.dataset.ref;
    const ws = ref.startsWith("ws:") && wsNamed(ref.slice(3));
    const t = ref.startsWith("task:") && taskNamed(ref.slice(5));
    const g = ref.startsWith("group:") && groupNamed(ref.slice(6));
    const nt = ref.startsWith("note:") && noteNamed(ref.slice(5));
    const [pid, wid] = ref.split("/");
    const n = !ws && !t && !g && !nt && mentioned(pid, wid);
    if (!ws && !t && !g && !nt && (!n || n.gone)) continue;
    if (el.getAttribute("contenteditable") !== "false") el.setAttribute("contenteditable", "false");
    const cls = ws ? "mchip mchip--ws" : t ? `mchip mchip--task${t.done ? " is-done" : ""}` : g ? "mchip mchip--group" : nt ? "mchip mchip--note" : "mchip";
    if (el.className !== cls) el.className = cls;
    const style = n ? pageCss(n.p) : g ? groupCss(g) : null;
    if (style && el.getAttribute("style") !== style) el.setAttribute("style", style);
  }
}

// A token typed by hand becomes a chip once a space or a punctuation mark follows it, if it names something.
function chipTyped(box: HTMLElement, here: string | null): boolean {
  const sel = getSelection();
  const node = sel.anchorNode;
  if (!sel.isCollapsed || !(node instanceof Text) || !box.contains(node)) return false;
  const before = node.data.slice(0, sel.anchorOffset).replace(/\u00a0/g, " ");
  const m = before.match(/(^|[\s(])@(?:([a-z0-9][a-z0-9-]*)\/)?([A-Za-z0-9_.-]*[A-Za-z0-9_])[\s.,;:!?)]$/);
  const n = m && namedIn(here, m[2], m[3]);
  if (!n) return false;
  const r = document.createRange();
  r.setStart(node, sel.anchorOffset - (m[0].length - m[1].length));
  r.setEnd(node, sel.anchorOffset - 1);
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand("insertHTML", false, chipHtml(n));
  paintChips(box);
  // Past what was typed after it. Chrome leaves the cursor inside the chip it just put in, from where moving on a
  // character stays in it (and what's typed next is lost): from there, it goes after the chip's next character.
  const at = sel.anchorNode;
  const chip = (at instanceof Element ? at : at?.parentElement)?.closest(".mchip");
  if (!chip || !box.contains(chip)) sel.modify("move", "forward", "character");
  else {
    const after = document.createRange();
    if (chip.nextSibling instanceof Text && chip.nextSibling.data.length) after.setStart(chip.nextSibling, 1);
    else after.setStartAfter(chip);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
  return true;
}

// The @ being typed, up to the cursor: from an @ at the start of a word, up to three words, no line break.
function atQuery(): { node: Text; start: number; end: number; q: string } | null {
  const sel = getSelection();
  const node = sel.anchorNode;
  if (!sel.isCollapsed || !(node instanceof Text)) return null;
  const m = node.data.slice(0, sel.anchorOffset).replace(/\u00a0/g, " ").match(/(^|[\s(])@([^\s@]*(?: [^\s@]+){0,2})$/);
  return m && !m[2].endsWith("/") ? { node, start: sel.anchorOffset - m[2].length - 1, end: sel.anchorOffset, q: m[2] } : null;
}

// The box. Its text is the draft's as you type; when the draft changes from elsewhere (emptied once it's sent, put
// back when it didn't go, filled in by a task), the box is drawn again from it.
export function MsgBox(p: MsgBoxProps) {
  const ref = useRef<AbBox | null>(null);
  const [draft, setDraftV] = useDraft(p.draft);
  const data = useApp((s) => s.data);
  // The page a box is about: the one its thread starts on or is on, or the page you're on.
  const routePage = useApp((s) => (s.route.name === "page" ? s.route.id || null : null));
  const here = p.page !== undefined ? (p.page && p.page !== "new" ? p.page : null) : routePage;
  const stageKey = p.stageKey !== undefined ? p.stageKey : p.draft === "launch" || p.draft.startsWith("c:") ? p.draft : null;
  const links = !!p.links;
  // The @ list, while it's open: what's typed after the @, its rows, the one picked.
  const [mp, setMp] = useState<{ q: string; rows: MentionRow[]; sel: number } | null>(null);
  // The text this box last wrote to its draft, so its own typing doesn't draw it again.
  const wrote = useRef<string | null>(null);

  const boxRef = p.boxRef;
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el as AbBox | null;
      if (typeof boxRef === "function") boxRef(el);
      else if (boxRef) (boxRef as React.RefObject<HTMLElement | null>).current = el;
    },
    [boxRef],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || draft === wrote.current) return;
    wrote.current = draft;
    if (boxText(el) === draft) return;
    el.innerHTML = boxHtml(draft);
    if (document.activeElement === el) caretToEnd(el);
  }, [draft]);
  // What it names, drawn again as the chrome changes (a page it names arrives, or is renamed), unless you're in it:
  // the box being typed in isn't redrawn. Nor is one holding an agent's chip, which its text doesn't make again.
  useEffect(() => {
    const el = ref.current;
    if (!el || !draft || document.activeElement === el || el.querySelector("[data-to]")) return;
    const html = boxHtml(draft);
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [data]);
  useEffect(() => {
    if (p.autoFocus && ref.current) {
      ref.current.focus();
      caretToEnd(ref.current);
    }
  }, []);
  // Formatting keys do nothing, and dropped text comes in plain.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = (e: InputEvent) => {
      if (e.inputType.startsWith("format")) return e.preventDefault();
      const dropped = e.inputType === "insertFromDrop" && e.dataTransfer && !e.dataTransfer.files.length && clipText(e.dataTransfer);
      if (dropped) {
        e.preventDefault();
        document.execCommand("insertText", false, dropped);
      }
    };
    el.addEventListener("beforeinput", before);
    return () => el.removeEventListener("beforeinput", before);
  }, []);
  // Paste or drop files into a reply box or the composer to attach them: dropped anywhere on its form.
  useEffect(() => {
    const el = ref.current;
    if (!el || !stageKey) return;
    const at: HTMLElement = el.closest("form") || el;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      at.classList.add("is-drop");
    };
    const leave = () => at.classList.remove("is-drop");
    const drop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      at.classList.remove("is-drop");
      stage(stageKey, files);
    };
    at.addEventListener("dragover", over);
    at.addEventListener("dragleave", leave);
    at.addEventListener("drop", drop);
    return () => {
      at.removeEventListener("dragover", over);
      at.removeEventListener("dragleave", leave);
      at.removeEventListener("drop", drop);
    };
  }, [stageKey]);

  const close = () => setMp(null);
  // The list closes when the window changes size.
  useEffect(() => {
    if (!mp) return;
    addEventListener("resize", close);
    return () => removeEventListener("resize", close);
  }, [!!mp]);
  // @ typed: the list, for what's typed after it. Words typed after an @ that names nothing are just words.
  const mentionOpen = () => {
    const el = ref.current;
    const at = el && el.contains(getSelection().anchorNode) ? atQuery() : null;
    if (!at) return close();
    const rows = mentionRows(at.q, here, { links, agents: p.agentRows });
    if (!rows.length && /\s/.test(at.q)) return close();
    setMp((was) => ({ q: at.q, rows, sel: was && was.q === at.q ? Math.min(was.sel, Math.max(0, rows.length - 1)) : 0 }));
  };
  // A row picked: its chip in place of the @ and what's typed after it, and a space.
  const pick = (i: number) => {
    const el = ref.current;
    const at = atQuery();
    const x = mp?.rows[i];
    close();
    if (!el || !at || !x) return;
    const r = document.createRange();
    r.setStart(at.node, at.start);
    r.setEnd(at.node, at.end);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    el.focus();
    document.execCommand("insertHTML", false, `${isAgentPick(x) ? guestChipHtml(x) : chipHtml(x)}&nbsp;`);
    paintChips(el);
  };

  const input = (e: React.FormEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el) return;
    const ne = e.nativeEvent as InputEvent;
    // Emptied, it shows its placeholder again (a browser leaves a <br> behind).
    if (!el.textContent && !el.querySelector("[data-ref]")) el.innerHTML = "";
    paintChips(el);
    const typed = ne.inputType === "insertText" && /^[\s.,;:!?)]$/.test(ne.data || "") && chipTyped(el, here);
    const text = boxText(el);
    wrote.current = text;
    setDraftV(text);
    if (typed) close();
    else mentionOpen();
    p.onInput?.(text, el);
  };
  // The @ list's keys come first, then the caller's, then Enter sends.
  const keyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (mp && !e.nativeEvent.isComposing) {
      const n = mp.rows.length;
      let mine = true;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) setMp({ ...mp, sel: (mp.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n });
      else if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) pick(mp.sel);
      else if (e.key === "Escape") close();
      else mine = false;
      if (mine) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    p.onKeyDown?.(e);
    if (e.defaultPrevented || !p.onSend) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      p.onSend(boxText(e.currentTarget), { now: (MAC ? e.metaKey : e.ctrlKey) || e.altKey });
    }
  };
  // Pasted text comes in plain, the tokens in it as chips. Files are attached, text beside them still comes in, and
  // what has no text a page can read stays the browser's to paste. A line of a box is its own element once you've
  // pressed Return, so the target can be inside the box.
  const paste = (e: React.ClipboardEvent<HTMLElement>) => {
    const text = clipText(e.clipboardData);
    const files = [...(e.clipboardData?.files || [])];
    if (text) {
      e.preventDefault();
      const html = boxHtml(text);
      if (html.includes('class="mchip')) document.execCommand("insertHTML", false, html);
      else document.execCommand("insertText", false, text);
    }
    if (files.length && stageKey) {
      e.preventDefault();
      stage(stageKey, files);
    }
  };

  return (
    <>
      <ab-box
        ref={setRef}
        id={p.id}
        className={p.className}
        contentEditable={p.off ? "false" : "true"}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={p.label}
        aria-controls={mp ? "mention-pop" : undefined}
        aria-activedescendant={mp?.rows.length ? `mp-${mp.sel}` : undefined}
        data-ph={p.placeholder}
        data-draft={p.draft}
        onInput={input}
        onKeyDown={keyDown}
        onPaste={paste}
        onBlur={close}
      />
      {mp && ref.current ? <MentionPop box={ref.current} q={mp.q} rows={mp.rows} sel={mp.sel} here={here} links={links} onPick={pick} /> : null}
    </>
  );
}
