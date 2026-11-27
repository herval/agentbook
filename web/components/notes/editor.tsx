// A note's page edits its markdown as blocks (lib/notes-md.ts), each block's words a contenteditable of their own, with
// what agents suggest laid over them and the comments beside them: beside their words where there's room (A), else one
// list, what needs you first (B). What you type is saved a second after you stop; the server keeps your edits a few
// minutes apart as one version.
//
// The words are edited in place, as the old page did it: the note's blocks are drawn into one element (NoteDoc's,
// `NE.doc`) as HTML and read back from it, the cursor kept where it was, and what the browser would do to a selection
// across blocks done on the blocks instead. React draws everything around them (the head, the comments, the menus) from
// the note's store (store.ts), which this changes.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { agentName, DEFAULT_KIND, hiddenAgent, kindCaps, sortAgents, waits } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { clipText } from "../../lib/clip.ts";
import { cutBlocks, inlineHtml, inlineMd, joinBlocks, overlay, parseBlocks, sliceBlocks, unlay } from "../../lib/notes-md.ts";
import type { Block } from "../../lib/notes-md.ts";
import { noteHref } from "../../lib/route.ts";
import { agentOf, allRows, getApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { avatarHtml, iconHtml, mentioned, mentionChip, mentionRows, namedChip, noteMentionChip, noteNamed, slug, wsMentionChip, wsNamed } from "./html.ts";
import { getNote, loadNote, noteById, noteCommentAgent, noteOpen, noteQuestion, noteRo, onTake, openSugg, setNote, suggKey } from "./store.ts";
import type { NoteComment, NoteFull, PopCtx, PopItem } from "./store.ts";
import { esc, hueCss } from "../../lib/format.ts";

// A line you @'d an agent in, while the cursor's in it: who it'd ask, by its token in the words.
interface Ask {
  tok: string;
  name: string;
  agent: string;
  to: { agent: string } | { thread: string };
}
type EBlock = Block & { ask?: Ask };
// A place in the note's words: a node and an offset in it (and the block it's in).
interface At {
  node: Node;
  off: number;
  bt?: HTMLElement;
}

// The open note's editor: its blocks, the version they're from, and what's waiting to be saved; the element the blocks
// are drawn in, and its title's.
export const NE = {
  id: null as string | null,
  blocks: [] as EBlock[],
  base: 0,
  saved: "",
  sugg: "",
  dirty: false,
  saving: false,
  timer: null as ReturnType<typeof setTimeout> | null,
  typed: 0,
  stale: false,
  drawn: false,
  cross: false,
  drag: null as { a?: At; bt?: HTMLElement; x: number; y: number; f?: number } | null,
  undo: null as { blocks: EBlock[]; i: number; off: number } | null,
  mdDirty: false,
  doc: null as HTMLElement | null,
  title: null as HTMLElement | null,
};
// The comment the pointer is over (its words are shaded deeper), and what's typed in each comment's box, by comment.
let hover: string | null = null;
export const boxes = new Map<string, string>();
export const noteTyping = () => NE.cross || NE.dirty || NE.saving || Date.now() - NE.typed < 1500;
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E[] => [...root.querySelectorAll<E>(sel)];
const docOf = () => (NE.doc?.isConnected ? NE.doc : null);
const noteNow = () => getNote().note;
const elOf = (t: EventTarget | null): HTMLElement | null => (t instanceof HTMLElement ? t : t instanceof Node ? t.parentElement : null);
// The agents you can @ in a note: yours whose runtime gives their threads agentbook's tools (shared/runtimes.ts).
const takesNotes = (kind: string | null | undefined) => !!kindCaps(kind || DEFAULT_KIND)?.writesPages;
export const noteAgents = () => sortAgents((getApp().data?.agents || []).filter((a) => a.mine !== false && !hiddenAgent(a) && takesNotes(a.kind)));
// Running threads of those agents, which a comment or a line can hand itself to.
const noteThreads = () =>
  allRows()
    .filter((s) => s.mine !== false && s.state !== "done" && !s.archived && takesNotes(agentOf(s.agent).kind))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, 6);
const noteNewId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
const textBlock = (b: EBlock) => !["hr", "sub", "raw"].includes(b.t);
// The note's markdown as you edited it in Markdown: what marks a suggestion can't come from typing.
const cleanMd = (s: unknown) => String(s || "").replace(/[\u0001-\u0004]/g, "");

/* ---------- the note as the server has it, and saving ---------- */

// The editor takes it whole when it's new to it, and again when its text or what's suggested changed elsewhere (an
// accepted suggestion, an agent writing a note it made), unless you're typing: then once you stop.
function noteTake(n: NoteFull) {
  const fresh = NE.id !== n.id;
  if (fresh) {
    Object.assign(NE, { id: n.id, dirty: false, stale: false });
    setNote({ title: n.title, emoji: n.emoji });
  }
  if (!fresh && noteTyping()) {
    if (n.text !== NE.saved || suggKey(n) !== NE.sugg) NE.stale = true;
    return;
  }
  NE.base = n.version;
  if (!fresh && document.activeElement !== NE.title) setNote({ title: n.title, emoji: n.emoji });
  if (!fresh && n.text === NE.saved && suggKey(n) === NE.sugg) return;
  NE.blocks = parseBlocks(overlay(n.text, openSugg(n)).md);
  NE.undo = null;
  Object.assign(NE, { saved: n.text, sugg: suggKey(n), stale: false, drawn: false });
}
onTake(noteTake);
// A new note's page: nothing of the last one's.
export function noteFresh() {
  clearTimeout(NE.timer);
  Object.assign(NE, { id: null, blocks: [], base: 0, saved: "", sugg: "", dirty: false, saving: false, typed: 0, stale: false, drawn: false, cross: false, drag: null, undo: null, mdDirty: false });
  hover = null;
  boxes.clear();
}
export function noteDirty() {
  if (noteRo(noteNow())) return;
  NE.dirty = true;
  NE.typed = Date.now();
  clearTimeout(NE.timer);
  NE.timer = setTimeout(noteSave, 900);
}
const noteText = () => joinBlocks(NE.blocks.map((b) => ({ ...b, md: unlay(b.md) })));
export async function noteSave({ leaving = false } = {}) {
  clearTimeout(NE.timer);
  if (!NE.dirty || !NE.id) return;
  if (NE.saving) return void (NE.timer = setTimeout(noteSave, 400));
  const id = NE.id;
  const { title, emoji } = getNote();
  const body = { text: noteText(), title: title.trim() || "Untitled", emoji: emoji || "📄", base: NE.base };
  const url = `/api/notes/${encodeURIComponent(id)}/write`;
  NE.dirty = false;
  // Leaving the page: it goes anyway.
  if (leaving) return void fetch(url, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  NE.saving = true;
  const r = await post<{ version?: number }>(url, body);
  NE.saving = false;
  if (NE.id !== id) return;
  if (r.ok) Object.assign(NE, { base: r.data.version, saved: body.text });
  // It changed elsewhere since (post() said so): take it as it is now.
  else if (r.data?.version) {
    NE.id = null;
    loadNote();
  } else NE.dirty = true;
  if (NE.stale && !noteTyping()) loadNote();
}

/* ---------- the blocks ---------- */

const NB_PH = { h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", ul: "List", ol: "List", todo: "To-do", quote: "Quote", callout: "Something to point out", code: "Code" };
// A token in a note's words that names a page, a widget, a note, a workspace, one of your agents or a thread of theirs
// is a chip. An agent's or a thread's is a name in the words (data-m), a comment's words can be on it.
const noteSayChip = (tok: string, name: string, agent: string) => `<span class="mchip" contenteditable="false" data-m="${esc(tok)}" style="${hueCss(agent)}">@${esc(name)}</span>`;
function noteChip(tok: string): string | null {
  const low = tok.toLowerCase();
  if (low.startsWith("note:")) return noteNamed(low.slice(5)) ? noteMentionChip(noteNamed(low.slice(5)), { box: true }) : null;
  if (low.startsWith("ws:")) return wsNamed(low.slice(3)) ? wsMentionChip(wsNamed(low.slice(3)), { box: true }) : null;
  const [pid, wid] = tok.split("/");
  const n = mentioned(pid, wid);
  if (n && !n.gone) return mentionChip(n, { box: true });
  if (wid) return null;
  const a = noteAgents().find((x) => slug(x.name) === low);
  if (a) return noteSayChip(tok, a.name, a.id);
  const s = allRows().find((x) => x.mine !== false && x.label && slug(x.label) === low);
  return s ? noteSayChip(tok, s.label, s.agent) : null;
}
// A suggestion's words, in the color of the agent that suggested them; you accept or reject them in its comment.
function noteSuggAttr(sid: string) {
  const x = (noteNow()?.suggestions || []).find((s) => s.id === sid);
  const a = x?.by?.agent;
  return ` contenteditable="false" style="${hueCss(a)}" title="${esc(agentOf(a).name)} suggests this: accept or reject it in its comment"`;
}
function noteBlockHtml(b: EBlock, i: number, n: number) {
  const ro = noteRo(noteNow());
  const g = `<div class="blk-g" contenteditable="false"><button class="blk-add" type="button" data-nb-add="${i}" tabindex="-1" title="Add a block below">${iconHtml("plus")}</button><button class="blk-grip" type="button" draggable="true" data-nb-grip="${i}" tabindex="-1" title="Drag to move it, click for more">${iconHtml("grip")}</button></div>`;
  const words = b.t === "code" ? esc(b.md) : inlineHtml(b.md, { chip: noteChip, sugg: noteSuggAttr });
  const bt = (tag = "div") => `<${tag} class="bt" contenteditable="${!ro}" spellcheck="${b.t === "code" ? "false" : "true"}" data-ph="${esc(NB_PH[b.t] || "")}">${words}</${tag}>`;
  let inner: string;
  if (b.t === "ul") inner = `<span class="bm" contenteditable="false">•</span>${bt()}`;
  else if (b.t === "ol") inner = `<span class="bm" contenteditable="false">${n}.</span>${bt()}`;
  else if (b.t === "todo") inner = `<button class="tick-box" type="button" data-nb-tick="${i}" contenteditable="false" aria-label="${b.done ? "Not done" : "Done"}">${b.done ? "✓" : ""}</button>${bt()}`;
  else if (b.t === "callout") inner = `<button class="co-em" type="button" data-nb-emoji="${i}" contenteditable="false" title="Change it">${esc(b.emoji || "💡")}</button>${bt()}`;
  else if (b.t === "code") inner = `${bt("pre")}<input class="lang" data-nb-lang="${i}" value="${esc(b.lang || "")}" placeholder="language" spellcheck="false" aria-label="Its language"${ro ? " readonly" : ""}>`;
  else if (b.t === "hr") inner = "<hr>";
  else if (b.t === "sub") {
    const sub = noteById(b.href);
    inner = `<a class="nb-sub" href="${noteHref(b.href)}" contenteditable="false"><span class="em">${esc(sub?.emoji || "📄")}</span><span>${esc(sub?.title || b.label || "Untitled")}</span></a>`;
  } else if (b.t === "raw") inner = `<div class="nb-raw" contenteditable="false" title="Markdown shows it; change it in Markdown" data-raw="${i}"></div>`;
  else inner = bt();
  return `<div class="blk blk--${b.t}${b.done ? " is-done" : ""}" data-i="${i}"${b.depth ? ` style="--depth:${b.depth}"` : ""}>${g}${inner}${noteAskBar(b)}</div>`;
}
// Under a line you @'d an agent in, while the cursor's in it: what sends it. On a phone, the button is the way.
const noteAskBar = (b: EBlock) =>
  b.ask
    ? `<div class="nb-ask" contenteditable="false" style="${hueCss(b.ask.agent)}"><button class="btn btn--sm btn--dark" type="button" data-nb-ask title="Ask ${esc(b.ask.name)} about this line, to work at this spot (Enter)">${avatarHtml(b.ask.agent, "av--xs")}Ask ${esc(b.ask.name)}<kbd>↵</kbd></button><button class="icon-btn" type="button" data-nb-ask-off title="Leave it as a mention (Esc)" aria-label="Leave it as a mention">${iconHtml("x")}</button></div>`
    : "";
const noteBt = (i: number) => docOf()?.querySelector<HTMLElement>(`.blk[data-i="${i}"] .bt`) || null;

// A table, a picture or anything else a block can't edit, drawn as markdown draws it (each its own small React root,
// as the words around it are the editor's).
let raws: Root[] = [];
function rawsOff() {
  const old = raws;
  raws = [];
  setTimeout(() => old.forEach((r) => r.unmount()));
}
function rawsOn(doc: HTMLElement) {
  for (const el of $$(".nb-raw[data-raw]", doc)) {
    const r = createRoot(el);
    r.render(createElement(Markdown, { text: NE.blocks[Number(el.dataset.raw)]?.md || "" }));
    raws.push(r);
  }
}
// Markdown as HTML, for what a copy puts on the clipboard.
function mdHtml(text: string): string {
  const div = document.createElement("div");
  const r = createRoot(div);
  try {
    flushSync(() => r.render(createElement(Markdown, { text })));
    return div.innerHTML;
  } catch {
    return "";
  } finally {
    setTimeout(() => r.unmount());
  }
}

// The note drawn again, from its blocks (or its markdown, in Markdown), the cursor where it was or where asked.
export function noteDocDraw({ focus = null }: { focus?: { i: number; off: number | "end" | "start" } | null } = {}) {
  const doc = docOf();
  if (!doc) return;
  const caret = focus || noteCaret();
  noteCrossOff();
  NE.drawn = true;
  rawsOff();
  const n = noteNow();
  if (getNote().md) {
    doc.innerHTML = `<textarea class="md-src" data-note-src spellcheck="false" aria-label="Its markdown"${noteRo(n) ? " readonly" : ""}>${esc(noteText())}</textarea><p class="md-hint">The note as it's kept, and as agents read it. Change it here, then Markdown again for the blocks.${openSugg(n).length ? ` Suggestions aren't in it until you accept them.` : ""}</p>`;
    doc.classList.remove("is-empty");
    NE.mdDirty = false;
    return;
  }
  if (!NE.blocks.length) NE.blocks = [{ t: "p", md: "" }];
  let k = 0;
  doc.innerHTML = NE.blocks.map((b, i) => ((k = b.t === "ol" ? k + 1 : 0), noteBlockHtml(b, i, k))).join("");
  doc.classList.toggle("is-empty", NE.blocks.length === 1 && !NE.blocks[0].md);
  rawsOn(doc);
  noteAnchor();
  noteDecorate();
  if (caret) noteFocus(caret.i, caret.off);
  requestAnimationFrame(noteLayout);
}
// Where the cursor is in the note: which block, and how far into its words.
function noteCaret(): { i: number; off: number } | null {
  const bt = elOf(document.activeElement)?.closest<HTMLElement>(".bt");
  return bt && docOf()?.contains(bt) ? { i: Number(bt.closest<HTMLElement>(".blk").dataset.i), off: caretOff(bt) } : null;
}
function caretOff(el: HTMLElement) {
  const s = getSelection();
  if (!s.rangeCount || !el.contains(s.anchorNode)) return 0;
  const r = s.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function rangeAt(el: HTMLElement, from: number, to = from) {
  const r = document.createRange();
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Text;
  let pos = 0;
  let set = false;
  while ((n = w.nextNode() as Text)) {
    if (!set && from <= pos + n.length) {
      r.setStart(n, from - pos);
      set = true;
    }
    if (set && to <= pos + n.length) {
      r.setEnd(n, to - pos);
      return r;
    }
    pos += n.length;
  }
  if (!set) r.setStart(el, el.childNodes.length);
  r.setEnd(el, el.childNodes.length);
  return r;
}
const caretToEnd = (el: HTMLElement) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
};
// The cursor into a block: "end", "start", or a number of characters in.
export function noteFocus(i: number, where: number | "end" | "start" = "end") {
  const el = noteBt(i);
  if (!el) return;
  el.focus({ preventScroll: true });
  const off = where === "end" ? el.textContent.length : where === "start" ? 0 : where;
  const r = rangeAt(el, off);
  r.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  const box = el.getBoundingClientRect();
  if (box.bottom > innerHeight - 40 || box.top < 70) el.scrollIntoView({ block: "center" });
}
function noteSync(i: number, bt = noteBt(i)) {
  const b = NE.blocks[i];
  if (!b || !bt) return;
  if (bt.innerHTML === "<br>") bt.innerHTML = "";
  b.md = b.t === "code" ? bt.textContent : inlineMd(bt);
}
const noteSyncAll = () => NE.blocks.forEach((b, i) => textBlock(b) && noteSync(i));
// A block changed shape (split, joined, moved, made another kind): the note again, saved, the cursor where asked.
function noteReshape(focus?: { i: number; off: number | "end" | "start" }) {
  noteDirty();
  noteDocDraw({ focus: focus || { i: 0, off: 0 } });
}
function noteTurn(i: number, t: string) {
  const b = NE.blocks[i];
  noteSync(i);
  if (t === "hr") {
    if (b.md) NE.blocks.splice(i + 1, 0, { t: "hr" }, { t: "p", md: "" });
    else NE.blocks.splice(i, 1, { t: "hr" }, { t: "p", md: "" });
    return noteReshape({ i: b.md ? i + 2 : i + 1, off: 0 });
  }
  if (t === "sub") return void noteSubNote(i);
  Object.assign(b, { t, ...(t === "todo" ? { done: false } : {}), ...(t === "callout" ? { emoji: b.emoji || "💡" } : {}), ...(t === "code" ? { lang: b.lang || "", md: unlay(b.md) } : {}) });
  if (!["ul", "ol", "todo"].includes(t)) delete b.depth;
  noteReshape({ i, off: "end" });
}
// A note inside this one: made now, linked here, and opened from the link.
async function noteSubNote(i: number) {
  const r = await post("/api/notes", { title: "Untitled", parent: NE.id });
  if (!r.ok) return;
  const b = NE.blocks[i];
  const link = { t: "sub", href: r.data.id, label: "Untitled" };
  if (b && textBlock(b) && !b.md) NE.blocks.splice(i, 1, link);
  else NE.blocks.splice(i + 1, 0, link);
  noteReshape({ i: Math.min(i + 1, NE.blocks.length - 1), off: 0 });
  toast("Made a note inside this one.", { label: "Open it", run: () => (location.hash = noteHref(r.data.id)) });
}

const NB_SHORT: [RegExp, string][] = [
  [/^###\s$/, "h3"],
  [/^##\s$/, "h2"],
  [/^#\s$/, "h1"],
  [/^[-*]\s$/, "ul"],
  [/^1[.)]\s$/, "ol"],
  [/^\[\s?\]\s$/, "todo"],
  [/^>\s$/, "quote"],
  [/^```$/, "code"],
  [/^---$/, "hr"],
];
function noteShortcut(i: number, bt: HTMLElement) {
  const before = bt.textContent.slice(0, caretOff(bt)).replace(/\s/g, " ");
  const hit = NB_SHORT.find(([re]) => re.test(before));
  if (!hit || hit[1] === NE.blocks[i].t || NE.blocks[i].t === "code") return false;
  rangeAt(bt, 0, before.length).deleteContents();
  noteTurn(i, hit[1]);
  return true;
}
function noteKeyBlock(e: KeyboardEvent, bt: HTMLElement) {
  const i = Number(bt.closest<HTMLElement>(".blk").dataset.i);
  const b = NE.blocks[i];
  const sel = getSelection();
  // A line an agent was just @'d in: Enter sends it and goes on to the next line, Esc leaves it as a mention.
  if (b.ask && e.key === "Escape") {
    e.preventDefault();
    return noteAskOff(i);
  }
  if (b.ask && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    return noteAskNext(i);
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    return void noteSave();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    return noteCommentSel();
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && NE.undo) {
    e.preventDefault();
    return noteCrossUndo();
  }
  // Select all takes the block's words, and then, as they're already selected, the note's.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && sel.toString().trim() === bt.textContent.trim()) {
    e.preventDefault();
    return noteCrossAll();
  }
  if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.metaKey && !e.altKey && noteCrossKey(e, bt)) return;
  if (e.key === "Tab" && ["ul", "ol", "todo"].includes(b.t)) {
    e.preventDefault();
    noteSync(i);
    b.depth = Math.max(0, Math.min(3, (b.depth || 0) + (e.shiftKey ? -1 : 1)));
    return noteReshape({ i, off: caretOff(bt) });
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    if (b.t === "code" && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return void document.execCommand("insertText", false, "\n");
    }
    e.preventDefault();
    noteSync(i);
    // Enter in an empty list item ends the list.
    if (["ul", "ol", "todo", "quote"].includes(b.t) && !bt.textContent.trim()) {
      Object.assign(b, { t: "p" });
      delete b.depth;
      return noteReshape({ i, off: 0 });
    }
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tail = document.createRange();
    tail.selectNodeContents(bt);
    tail.setStart(r.startContainer, r.startOffset);
    const box = document.createElement("div");
    box.append(tail.extractContents());
    noteSync(i);
    const next: EBlock = { t: ["ul", "ol", "todo"].includes(b.t) ? b.t : "p", md: b.t === "code" ? box.textContent : inlineMd(box), ...(b.depth ? { depth: b.depth } : {}) };
    // Enter at a heading's start pushes it down, rather than splitting it.
    if (/^h\d$/.test(b.t) && !b.md && next.md) {
      Object.assign(next, { t: b.t });
      b.t = "p";
    }
    NE.blocks.splice(i + 1, 0, next);
    return noteReshape({ i: i + 1, off: 0 });
  }
  if (e.key === "Backspace" && sel.isCollapsed && caretOff(bt) === 0) {
    e.preventDefault();
    noteSync(i);
    if (b.t !== "p") {
      if ((b.depth || 0) > 0) b.depth--;
      else {
        b.t = "p";
        delete b.depth;
      }
      return noteReshape({ i, off: 0 });
    }
    const prev = NE.blocks[i - 1];
    if (!prev) return;
    if (!textBlock(prev)) {
      NE.blocks.splice(i - 1, 1);
      return noteReshape({ i: i - 1, off: 0 });
    }
    const at = noteBt(i - 1)?.textContent.length || 0;
    prev.md = (prev.md || "") + (b.md || "");
    NE.blocks.splice(i, 1);
    return noteReshape({ i: i - 1, off: at });
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && sel.isCollapsed && !e.shiftKey) {
    const r = sel.getRangeAt(0).getClientRects()[0] || bt.getBoundingClientRect();
    const box = bt.getBoundingClientRect();
    const up = e.key === "ArrowUp";
    if (up ? r.top - box.top > 14 : box.bottom - r.bottom > 14) return;
    let j = i + (up ? -1 : 1);
    while (NE.blocks[j] && !textBlock(NE.blocks[j])) j += up ? -1 : 1;
    if (!NE.blocks[j]) return;
    e.preventDefault();
    noteFocus(j, up ? "end" : "start");
  }
}
// Pasted text comes in plain; lines of it are blocks, as markdown says.
function notePaste(e: ClipboardEvent, bt: HTMLElement) {
  const text = clipText(e.clipboardData);
  if (!text) return;
  e.preventDefault();
  const i = Number(bt.closest<HTMLElement>(".blk").dataset.i);
  if (!text.includes("\n") || NE.blocks[i].t === "code") return void document.execCommand("insertText", false, text);
  const r = getSelection().getRangeAt(0);
  r.deleteContents();
  const tail = document.createRange();
  tail.selectNodeContents(bt);
  tail.setStart(r.startContainer, r.startOffset);
  const box = document.createElement("div");
  box.append(tail.extractContents());
  noteSync(i);
  const added: EBlock[] = parseBlocks(text);
  const last = added[added.length - 1];
  const rest = inlineMd(box);
  if (rest) added.push({ t: "p", md: rest });
  NE.blocks.splice(i + 1, 0, ...added);
  if (!NE.blocks[i].md && textBlock(NE.blocks[i])) NE.blocks.splice(i, 1);
  const at = NE.blocks.indexOf(last);
  noteReshape({ i: at, off: "end" });
}

/* ---------- comments: where they are in the words ---------- */

// The note's words, as the page shows them: each block's text, not what a suggestion puts in nor a chip's (but the name
// of an agent @'d in it), a line apiece. Comments are found in it by their words.
function noteSegs() {
  const segs: { node: Text; at: number }[] = [];
  let text = "";
  for (const bt of $$(".bt", docOf() || document.createElement("div"))) {
    const w = document.createTreeWalker(bt, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest("ins.sg, .mchip:not([data-m])") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n: Text; (n = w.nextNode() as Text); ) {
      segs.push({ node: n, at: text.length });
      text += n.data;
    }
    text += "\n";
  }
  return { segs, text };
}
// Where each open comment is (its words' place in the note, -1 for none any more), shaded.
export function noteAnchor() {
  const doc = docOf();
  if (!doc || getNote().md) return;
  for (const s of $$(".cm", doc)) {
    const p = s.parentNode;
    s.replaceWith(...s.childNodes);
    p.normalize();
  }
  const pos: Record<string, number> = {};
  for (const c of noteOpen(noteNow())) {
    if (!c.quote) {
      pos[c.id] = 0;
      continue;
    }
    const { segs, text } = noteSegs();
    const at: number[] = [];
    for (let k = text.indexOf(c.quote); k >= 0; k = text.indexOf(c.quote, k + 1)) at.push(k);
    if (!at.length) {
      pos[c.id] = -1;
      continue;
    }
    const from = at[Math.min(c.nth || 0, at.length - 1)];
    pos[c.id] = from;
    noteWrap(segs, from, from + c.quote.length, c.id);
  }
  if (JSON.stringify(pos) !== JSON.stringify(getNote().pos)) setNote({ pos });
}
// The comments' words shaded again (one came in, or went), the cursor kept where it was.
export function noteReanchor() {
  if (NE.cross) return;
  const sel = getSelection();
  const caret = sel.rangeCount && sel.isCollapsed && docOf()?.contains(sel.anchorNode) ? noteCaret() : null;
  noteAnchor();
  if (caret) noteFocus(caret.i, caret.off);
}
// Shade [from, to) of the note's words: each text node in it wrapped apart, so no mark around them is split.
function noteWrap(segs: { node: Text; at: number }[], from: number, to: number, cid: string) {
  for (const s of [...segs].reverse()) {
    const a = Math.max(from, s.at);
    const z = Math.min(to, s.at + s.node.data.length);
    if (a >= z) continue;
    const mid = s.node.splitText(a - s.at);
    mid.splitText(z - a);
    const span = document.createElement("span");
    span.className = "cm";
    span.dataset.c = cid;
    mid.replaceWith(span);
    span.append(mid);
  }
}
// The text of a selection in the note, and where it starts in its words.
function noteRangeText(r: Range) {
  const { segs } = noteSegs();
  let quote = "";
  let at = -1;
  for (const s of segs) {
    if (!r.intersectsNode(s.node)) continue;
    const a = s.node === r.startContainer ? r.startOffset : 0;
    const z = s.node === r.endContainer ? r.endOffset : s.node.data.length;
    if (z <= a) continue;
    if (at < 0) at = s.at + a;
    // a block ends a line, and an empty one is a line too
    else if (quote && s.at > at + quote.length) quote += "\n".repeat(s.at - at - quote.length);
    quote += s.node.data.slice(a, z);
  }
  return { quote, at };
}
// Each comment's words shaded: deeper for the open one and the one the pointer's over, in its agent's colour, yellow
// when its thread asks you something.
export function noteDecorate() {
  const doc = docOf();
  if (!doc) return;
  const { note, active } = getNote();
  const open = noteOpen(note);
  for (const el of $$(".cm", doc)) {
    const c = open.find((x) => x.id === el.dataset.c);
    const a = c ? noteCommentAgent(c) : null;
    el.className = ["cm", a ? "is-agent" : "", c && noteQuestion(c) ? "is-sun" : "", active === el.dataset.c ? "is-on" : "", hover === el.dataset.c ? "is-hover" : ""].filter(Boolean).join(" ");
    if (a) el.setAttribute("style", hueCss(a));
    else el.removeAttribute("style");
  }
}

/* ---------- comments: the column beside the note ---------- */

// Beside its words where there's room (A); else one list under the note, what needs you first (B).
export const noteBeside = () => innerWidth > 860;
// A: each card at the height of its words, pushed down where they'd overlap; the open one exactly at its words, the
// others making room above and below it.
export function noteLayout() {
  const wrap = document.querySelector<HTMLElement>("[data-note-cards]");
  if (!wrap) return;
  const doc = docOf();
  const { pos: at, active } = getNote();
  const top0 = wrap.getBoundingClientRect().top;
  const docTop = (doc?.getBoundingClientRect().top ?? top0) - top0;
  const items = $$(".cc", wrap).map((el) => {
    const a = doc?.querySelector(`.cm[data-c="${CSS.escape(el.dataset.cc)}"]`);
    return { el, want: a ? Math.max(0, a.getBoundingClientRect().top - top0 - 8) : at[el.dataset.cc] === -1 ? null : Math.max(0, docTop), h: el.offsetHeight };
  });
  // One whose words aren't in the note any more goes after the rest.
  const last = Math.max(0, docTop, ...items.filter((it) => it.want != null).map((it) => it.want));
  for (const it of items) if (it.want == null) it.want = last + 1;
  items.sort((x, y) => x.want - y.want);
  const gap = 8;
  const k = items.findIndex((it) => it.el.dataset.cc === active);
  const pos = items.map((it) => it.want);
  if (k >= 0) {
    for (let i = k + 1; i < items.length; i++) pos[i] = Math.max(items[i].want, pos[i - 1] + items[i - 1].h + gap);
    for (let i = k - 1; i >= 0; i--) pos[i] = Math.min(items[i].want, pos[i + 1] - items[i].h - gap);
  }
  for (let i = 0; i < items.length; i++) if (k < 0 || i !== k) pos[i] = Math.max(pos[i], i ? pos[i - 1] + items[i - 1].h + gap : 0, 0);
  items.forEach((it, i) => (it.el.style.top = `${pos[i]}px`));
  wrap.style.height = items.length ? `${pos[items.length - 1] + items[items.length - 1].h}px` : "0";
}

/* ---------- comments: writing them ---------- */

// A comment on what's selected in the note: its words shaded, and its card open with the box ready. @ an agent in the
// box, or in the text itself (noteAsk), to ask it.
export function noteCommentSel() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed || !docOf()?.contains(sel.anchorNode)) return;
  const { quote, at } = noteRangeText(sel.getRangeAt(0));
  noteCommentOn(quote, at);
}
// Which of the places `quote` is in the note's words the one at `at` is.
function noteNth(quote: string, at: number) {
  const { text } = noteSegs();
  let nth = 0;
  for (let k = text.indexOf(quote); k >= 0 && k < at; k = text.indexOf(quote, k + 1)) nth++;
  return nth;
}
function noteCommentOn(raw: string, at: number) {
  const lead = raw.length - raw.trimStart().length;
  const quote = raw.trim().slice(0, 2000);
  if (!quote) return;
  const nth = noteNth(quote, at + lead);
  noteDropDraft();
  const id = noteNewId("c");
  setNote({ draft: { id, note: NE.id, quote, nth, msgs: [], draft: true, at: new Date().toISOString(), by: { user: getApp().me?.username }, launch: null, post: null, resolved: null } });
  getSelection().removeAllRanges();
  noteTb(false);
  noteOpenCard(id);
}
// A block's words as the note's words have them, and where they start.
function noteBlockWords(i: number) {
  const bt = noteBt(i);
  const { segs, text } = noteSegs();
  const mine = segs.filter((s) => bt?.contains(s.node));
  if (!mine.length) return { words: "", at: 0 };
  const end = mine[mine.length - 1];
  return { words: text.slice(mine[0].at, end.at + end.node.data.length), at: mine[0].at };
}
function noteOpenCard(id: string) {
  flushSync(() => setNote({ active: id }));
  noteAnchor();
  const box = document.querySelector<HTMLElement>(`[data-nbox="${CSS.escape(id)}"]`);
  if (!box) return;
  box.focus({ preventScroll: true });
  caretToEnd(box);
  if (!noteBeside()) box.scrollIntoView({ block: "center", behavior: "smooth" });
}
// A comment you started and wrote nothing in goes when you click away.
export function noteDropDraft() {
  const d = getNote().draft;
  if (!d) return;
  const box = document.querySelector<HTMLElement>(`[data-nbox="${CSS.escape(d.id)}"]`);
  if (box?.textContent.trim()) return;
  boxes.delete(d.id);
  setNote({ draft: null, ...(getNote().active === d.id ? { active: null } : {}) });
  noteAnchor();
}
export function noteSetActive(id: string, scroll = false) {
  if (getNote().active === id) return;
  noteDropDraft();
  setNote({ active: id });
  noteDecorate();
  const a = scroll && docOf()?.querySelector(`.cm[data-c="${CSS.escape(id)}"]`);
  if (!a) return;
  const r = a.getBoundingClientRect();
  if (!noteBeside() || r.top < 70 || r.bottom > innerHeight - 20) a.scrollIntoView({ block: "center", behavior: "smooth" });
  const blk = a.closest<HTMLElement>(".blk");
  blk.classList.remove("is-flash");
  void blk.offsetWidth;
  blk.classList.add("is-flash");
}
// Nothing open: a click away from the comments, or Esc in a comment's box.
export function noteDeselect() {
  const { active, draft } = getNote();
  if (!active && !draft) return;
  noteDropDraft();
  setNote({ active: null });
  noteDecorate();
}
const noteAgentChip = (a: { id: string; name: string }) => `<span class="mchip" contenteditable="false" data-to-agent="${esc(a.id)}" style="${hueCss(a.id)}">@${esc(a.name)}</span>`;
const noteThreadChip = (s: { id: string; label?: string; agent?: string }) => `<span class="mchip" contenteditable="false" data-to-thread="${esc(s.id)}" style="${hueCss(s.agent)}">@${esc(s.label)}</span>`;
// A box's words, and who they're for: the first agent or thread it names. A page, a widget or a workspace in it is
// its token, as in a message's box.
function noteBoxValue(box: HTMLElement) {
  let text = "";
  let to: { agent: string } | { thread: string } | null = null;
  const walk = (node: Node) => {
    for (const n of node.childNodes) {
      const el = n as HTMLElement;
      if (n.nodeType === 3) text += (n as Text).data.replace(/ /g, " ");
      else if (el.dataset?.ref) text += `@${el.dataset.ref}${/^[\w/-]/.test(n.nextSibling?.textContent || "") ? " " : ""}`;
      else if (el.dataset?.toAgent || el.dataset?.toThread) {
        text += n.textContent;
        to ||= el.dataset.toAgent ? { agent: el.dataset.toAgent } : { thread: el.dataset.toThread };
      } else if (n.nodeName === "BR") text += "\n";
      else if (n.nodeType === 1) {
        if (/^(DIV|P)$/.test(n.nodeName) && text && !text.endsWith("\n")) text += "\n";
        walk(n);
      }
    }
  };
  walk(box);
  return { text: text.trim(), to };
}
export async function noteSend(cid: string) {
  const box = document.querySelector<HTMLElement>(`[data-nbox="${CSS.escape(cid)}"]`);
  const n = noteNow();
  if (!box || !n) return;
  const { text, to } = noteBoxValue(box);
  if (!text) return box.focus();
  await noteSave();
  const { draft: d } = getNote();
  const draft = d?.id === cid ? d : null;
  const mid = noteNewId("m");
  const msg = { id: mid, at: new Date().toISOString(), by: { user: getApp().me?.username }, text };
  const now = noteNow() || n;
  // It shows at once; the server's version follows.
  const comments = draft ? [...(now.comments || []), { ...draft, draft: false, msgs: [msg], resolved: null, launch: null, post: null, thread: null, at: msg.at, by: msg.by }] : (now.comments || []).map((c) => (c.id === cid ? { ...c, msgs: [...c.msgs, msg] } : c));
  boxes.delete(cid);
  box.innerHTML = "";
  setNote({ note: { ...now, comments }, active: cid, ...(draft ? { draft: null } : {}) });
  const url = `/api/notes/${encodeURIComponent(n.id)}/comments${draft ? "" : `/${encodeURIComponent(cid)}`}`;
  const r = await post(url, draft ? { cid, mid, quote: draft.quote, nth: draft.nth, text, ...(to ? { to } : {}) } : { mid, text, ...(to ? { to } : {}) });
  if (r.ok && r.data.queued) toast(waits(r.data, "it gets this"));
  loadNote();
}
export async function noteResolve(cid: string, resolved: boolean) {
  const n = noteNow();
  if (!n?.comments?.some((x) => x.id === cid)) return;
  const comments = n.comments.map((c) => (c.id === cid ? { ...c, resolved: resolved ? { at: new Date().toISOString(), by: { user: getApp().me?.username } } : null } : c));
  setNote({ note: { ...n, comments }, ...(getNote().active === cid ? { active: null } : {}) });
  noteAnchor();
  await post(`/api/notes/${encodeURIComponent(n.id)}/comments/${encodeURIComponent(cid)}/resolve`, { resolved });
  loadNote();
}
// Accepting goes into the note as a version of yours; what you typed before it is saved first.
export async function noteSettle(sid: string, keep: boolean) {
  await noteSave();
  const r = await post(`/api/notes/${encodeURIComponent(noteNow().id)}/suggestions/${encodeURIComponent(sid)}`, { keep });
  if (r.ok) NE.typed = 0;
  loadNote();
}

/* @ in the text: an agent asked at a point in the note, with nothing selected, to do something there. Picking one
   puts it in the line, where the markdown keeps it, and the line is what you ask: Enter sends it. That's a comment on
   the line, with `spot`, the line as the markdown has it, which the agent is told to work at: what it suggests goes
   there, struck out and written in. A mention you don't send stays a mention. */

function noteAskArm(i: number, x: PopItem) {
  const b = NE.blocks[i];
  if (!b || b.ask) return;
  const name = x.a ? x.a.name : x.s.label;
  b.ask = { tok: slug(name), name, agent: x.a ? x.a.id : x.s.agent, to: x.a ? { agent: x.a.id } : { thread: x.s.id } };
  docOf()?.querySelector(`.blk[data-i="${i}"]`)?.insertAdjacentHTML("beforeend", noteAskBar(b));
}
function noteAskOff(i: number) {
  if (NE.blocks[i]) delete NE.blocks[i].ask;
  docOf()?.querySelector(`.blk[data-i="${i}"] .nb-ask`)?.remove();
}
// Sent with Enter or its button, you go on writing on a new line under it.
function noteAskNext(i: number) {
  const b = NE.blocks[i];
  void noteAsk(i);
  NE.blocks.splice(i + 1, 0, { t: ["ul", "ol", "todo"].includes(b.t) ? b.t : "p", md: "", ...(b.depth ? { depth: b.depth } : {}) });
  noteReshape({ i: i + 1, off: 0 });
}
async function noteAsk(i: number) {
  const b = NE.blocks[i];
  const n = noteNow();
  if (!b?.ask || !n) return;
  noteSync(i);
  const { tok, name, agent, to } = b.ask;
  noteAskOff(i);
  const { words, at } = noteBlockWords(i);
  const quote = words.trim().slice(0, 2000);
  const spot = String(b.md).split("\n").find((l) => l.includes(`@${tok}`)) || "";
  const nth = noteNth(quote, at);
  const cid = noteNewId("c");
  const mid = noteNewId("m");
  const msg = { id: mid, at: new Date().toISOString(), by: { user: getApp().me?.username }, text: quote };
  // It shows at once; the server's version follows. The line is shaded, and you go on writing.
  const c: NoteComment = { id: cid, at: msg.at, by: msg.by, quote, nth, spot, asked: agent, msgs: [msg], launch: null, post: null, thread: null, resolved: null };
  setNote({ note: { ...n, comments: [...(n.comments || []), c] } });
  noteAnchor();
  noteDirty();
  await noteSave();
  const r = await post(`/api/notes/${encodeURIComponent(n.id)}/comments`, { cid, mid, quote, nth, spot, text: quote, to });
  if (r.ok && r.data.queued) toast(waits(r.data, "it gets this"));
  else if (r.ok && !noteBeside()) toast(`Asked ${name}: its reply shows in the comment, under the note.`);
  loadNote();
}

/* ---------- a selection across blocks ---------- */

// Each block is its own editing box, and a browser keeps a selection inside the box it began in. So when one reaches
// past its block, by mouse, Shift or select all, the note itself is the box for as long as it does. Its text is still
// the blocks': what would change it (beforeinput) is done on them instead, by noteCrossCut, and a redraw puts each
// block back in its own box. Bold and the like are left to the browser, then read back.
function noteCrossOn() {
  const doc = docOf();
  if (NE.cross || !doc) return;
  NE.cross = true;
  for (const bt of $$(".bt", doc)) bt.removeAttribute("contenteditable");
  doc.contentEditable = "true";
  doc.focus({ preventScroll: true });
}
function noteCrossOff() {
  cancelAnimationFrame(NE.drag?.f);
  NE.drag = null;
  if (!NE.cross) return;
  NE.cross = false;
  // What came in while it lasted (noteTyping held it back).
  if (NE.stale) setTimeout(() => NE.stale && !noteTyping() && loadNote(), 1700);
  const doc = docOf();
  if (!doc) return;
  doc.removeAttribute("contenteditable");
  for (const bt of $$(".bt", doc)) bt.contentEditable = String(!noteRo(noteNow()));
}
const noteBtOf = (node: Node | null) => {
  const el = node?.nodeType === 1 ? (node as HTMLElement) : node?.parentElement;
  const bt = el?.closest<HTMLElement>(".bt");
  return bt && docOf()?.contains(bt) ? bt : null;
};
// It's over when it's gone, or back inside one block, which is then the box again.
function noteCrossCheck() {
  if (!NE.cross || NE.drag) return;
  const sel = getSelection();
  const doc = docOf();
  const a = noteBtOf(sel.anchorNode);
  const z = noteBtOf(sel.focusNode);
  if (sel.rangeCount && !sel.isCollapsed && doc?.contains(sel.anchorNode) && doc.contains(sel.focusNode) && !(a && a === z)) return;
  const r = a && a === z ? sel.getRangeAt(0).cloneRange() : null;
  noteCrossOff();
  if (!r) return;
  a.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(r);
}
const noteSelect = (a: At, z: At) => getSelection().setBaseAndExtent(a.node, a.off, z.node, z.off);
// A chip or a suggestion is whole: a place inside one is the place before it, or after it. (A selection with an end
// inside one stays inside it.)
function noteOutside(node: Node, off: number, after: boolean | number): At {
  const m = (node.nodeType === 1 ? (node as HTMLElement) : node.parentElement).closest(".mchip, .sg");
  return m ? { node: m.parentNode, off: [...m.parentNode.childNodes].indexOf(m as ChildNode) + (after ? 1 : 0) } : { node, off };
}
function caretAtPoint(x: number, y: number): At | null {
  const p = document.caretPositionFromPoint?.(x, y);
  if (p?.offsetNode) return { node: p.offsetNode, off: p.offset };
  const r = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, off: r.startOffset } : null;
}
// The place in the note's words nearest a point on the screen: in the block at that height, or the closest one.
function notePoint(x: number, y: number): At | null {
  const all = $$(".bt", docOf() || document.createElement("div"));
  let bt: HTMLElement = null;
  let near = Infinity;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < near) [bt, near] = [el, d];
    if (!d) break;
  }
  if (!bt) return null;
  const r = bt.getBoundingClientRect();
  const end = { bt, node: bt, off: bt.childNodes.length };
  if (y > r.bottom && bt === all[all.length - 1]) return end;
  if (y < r.top && bt === all[0]) return { bt, node: bt, off: 0 };
  const p = caretAtPoint(Math.min(Math.max(x, r.left + 1), r.right - 2), Math.min(Math.max(y, r.top + 1), r.bottom - 2));
  if (!p || !bt.contains(p.node)) return end;
  const m = (p.node instanceof Element ? p.node : p.node.parentElement).closest(".mchip, .sg")?.getBoundingClientRect();
  return { bt, ...noteOutside(p.node, p.off, m && x > m.left + m.width / 2) };
}
// Pressing in a block may be a drag out of it. A click drops a selection across blocks; Shift keeps it, and reaches
// from where the cursor is.
function noteDragStart(e: MouseEvent) {
  const n = noteNow();
  if (e.button !== 0 || getNote().md || !n || n.missing || noteRo(n)) return;
  const doc = docOf();
  const box = doc?.getBoundingClientRect();
  const t = elOf(e.target);
  if (!box || !t?.closest(".note-card") || e.clientY < box.top || e.clientY > box.bottom) return;
  const sel = getSelection();
  if (NE.cross && !e.shiftKey) {
    sel.removeAllRanges();
    noteCrossOff();
  }
  const bt = t.closest<HTMLElement>(".bt");
  // Beside the words, in the margin or between two blocks: from the nearest ones. (A press there isn't in any box, and
  // a selection that begins outside the boxes never gets into one.)
  if (!bt) {
    if (t.closest("button, input, a, .nb-raw, .nb-ask, textarea")) return;
    const at = notePoint(e.clientX, e.clientY);
    if (at) NE.drag = { a: at, x: e.clientX, y: e.clientY };
    return;
  }
  if (e.shiftKey && sel.rangeCount && doc.contains(sel.anchorNode) && (NE.cross || noteBtOf(sel.anchorNode) !== bt)) {
    e.preventDefault();
    const a = { node: sel.anchorNode, off: sel.anchorOffset };
    noteCrossOn();
    noteSelect(a, notePoint(e.clientX, e.clientY));
    NE.drag = { a, x: e.clientX, y: e.clientY };
    return;
  }
  NE.drag = { bt, x: e.clientX, y: e.clientY };
}
function noteDragTo(e?: MouseEvent) {
  const d = NE.drag;
  const at = notePoint(d.x, d.y);
  if (!at) return;
  if (!NE.cross) {
    if (at.bt === d.bt) return;
    if (!d.a) {
      const sel = getSelection();
      const up = d.bt.compareDocumentPosition(at.bt) & Node.DOCUMENT_POSITION_PRECEDING;
      d.a = d.bt.contains(sel.anchorNode) ? noteOutside(sel.anchorNode, sel.anchorOffset, up) : { node: d.bt, off: 0 };
    }
    noteCrossOn();
    d.f = requestAnimationFrame(noteDragScroll);
  }
  e?.preventDefault();
  noteSelect(d.a, at);
}
// Held near the edge of the window, the note scrolls under it, as it does for any selection.
function noteDragScroll() {
  const d = NE.drag;
  if (!d) return;
  const step = d.y < 90 ? -14 : d.y > innerHeight - 40 ? 14 : 0;
  if (step) {
    scrollBy(0, step);
    noteDragTo();
  }
  d.f = requestAnimationFrame(noteDragScroll);
}
function noteDragEnd() {
  if (!NE.drag) return;
  cancelAnimationFrame(NE.drag.f);
  NE.drag = null;
  noteCrossCheck();
  noteTb();
}
// What it takes in: blocks `i` to `j`, and in those two its words (`first`, `last`), what it leaves (`head`, `tail`),
// and how far into block i it starts (`off`).
function noteCrossParts() {
  const r = getSelection().getRangeAt(0);
  const bts = $$(".bt", docOf() || document.createElement("div")).filter((bt) => r.intersectsNode(bt));
  if (!bts.length) return null;
  const a = bts[0];
  const z = bts[bts.length - 1];
  const at = (bt: HTMLElement) => Number(bt.closest<HTMLElement>(".blk").dataset.i);
  const from = a.contains(r.startContainer) ? noteOutside(r.startContainer, r.startOffset, false) : { node: a, off: 0 };
  const to = z.contains(r.endContainer) ? noteOutside(r.endContainer, r.endOffset, true) : { node: z, off: z.childNodes.length };
  // Part of a block, as its markdown, and its length as the page shows it.
  const part = (bt: HTMLElement, start: At | null, end: At | null) => {
    const x = document.createRange();
    x.selectNodeContents(bt);
    if (start) x.setStart(start.node, start.off);
    if (end) x.setEnd(end.node, end.off);
    const box = document.createElement("div");
    box.append(x.cloneContents());
    return { md: NE.blocks[at(bt)].t === "code" ? box.textContent : inlineMd(box), len: x.toString().length };
  };
  const head = part(a, null, from);
  return { i: at(a), j: at(z), off: head.len, head: head.md, tail: part(z, to, null).md, first: part(a, from, null).md, last: part(z, null, to).md };
}
// Its blocks, as the page has them now (Bold, say).
function noteCrossSync() {
  const r = getSelection().getRangeAt(0);
  for (const bt of $$(".bt", docOf() || document.createElement("div"))) if (r.intersectsNode(bt)) noteSync(Number(bt.closest<HTMLElement>(".blk").dataset.i), bt);
}
// It goes, with `text` in its place: what's left of its first and last blocks is one block, the first's kind. The
// cursor is there, in that block, which is its own box again. ⌘Z brings it back, until you write something else.
function noteCrossCut(text = "") {
  const c = noteCrossParts();
  if (!c) return null;
  noteCrossSync();
  const undo = { blocks: structuredClone(NE.blocks), i: c.i, off: c.off };
  NE.blocks = cutBlocks(NE.blocks, c.i, c.j, c.head, c.tail);
  const b = NE.blocks[c.i];
  if (b.ask && !b.md.includes(`@${b.ask.tok}`)) delete b.ask;
  noteReshape({ i: c.i, off: c.off });
  if (text) document.execCommand("insertText", false, text);
  NE.undo = undo;
  return noteBt(c.i);
}
function noteCrossUndo() {
  const u = NE.undo;
  NE.undo = null;
  NE.blocks = u.blocks;
  noteReshape({ i: u.i, off: u.off });
}
// What ⌘C and ⌘X take: markdown, as the note is kept, and as it's pasted back.
function noteCrossCopy(e: ClipboardEvent) {
  if (!NE.cross || !docOf()?.contains(getSelection().anchorNode)) return;
  const c = noteCrossParts();
  if (!c) return;
  e.preventDefault();
  noteCrossSync();
  const text = sliceBlocks(NE.blocks, c.i, c.j, c.first, c.last);
  e.clipboardData.setData("text/plain", text);
  e.clipboardData.setData("text/html", mdHtml(text));
  if (e.type === "cut") noteCrossCut();
}
function noteCrossAll() {
  const all = $$(".bt", docOf() || document.createElement("div"));
  if (all.length < 2) return;
  noteCrossOn();
  noteSelect({ node: all[0], off: 0 }, { node: all[all.length - 1], off: all[all.length - 1].childNodes.length });
}
// Shift with an arrow, on a block's first or last line, goes on into the next block with words.
function noteCrossKey(e: KeyboardEvent, bt: HTMLElement) {
  const sel = getSelection();
  const up = e.key === "ArrowUp";
  const f = document.createRange();
  f.setStart(sel.focusNode, sel.focusOffset);
  f.collapse(true);
  const box = bt.getBoundingClientRect();
  const line = f.getClientRects()[0] || box;
  if (up ? line.top - box.top > 14 : box.bottom - line.bottom > 14) return false;
  const all = $$(".bt", docOf() || document.createElement("div"));
  const next = all[all.indexOf(bt) + (up ? -1 : 1)];
  if (!next) return false;
  e.preventDefault();
  const a = { node: sel.anchorNode, off: sel.anchorOffset };
  const to = next.getBoundingClientRect();
  const z = notePoint(line.left, up ? to.bottom - 4 : to.top + 4);
  noteCrossOn();
  noteSelect(a, z);
  return true;
}
function noteKeyCross(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && k === "s") {
    e.preventDefault();
    return void noteSave();
  }
  if (cmd && e.shiftKey && k === "m") {
    e.preventDefault();
    return noteCommentSel();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    return getSelection().collapseToEnd();
  }
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    const bt = noteCrossCut();
    if (bt) noteKeyBlock(e, bt);
  }
}

/* ---------- the menus: the selection's toolbar, / for blocks, @ in a comment or in the text ---------- */

// The toolbar over a selection in the note's words (Toolbar draws it), or none.
export function noteTb(show = true) {
  const { tb, md, note } = getNote();
  if (tb?.link) return;
  const sel = getSelection();
  const doc = docOf();
  if (!show || !doc || md || noteRo(note) || !sel.rangeCount || sel.isCollapsed || !doc.contains(sel.anchorNode) || !sel.toString().trim()) return void (tb && setNote({ tb: null }));
  const r = sel.getRangeAt(0).getBoundingClientRect();
  const rect = { left: r.left, top: r.top, width: r.width };
  if (tb && tb.cross === NE.cross && JSON.stringify(tb.rect) === JSON.stringify(rect)) return;
  setNote({ tb: { rect, cross: NE.cross, link: null } });
}
// Bold, italic, struck out, code or a link, on what's selected.
export function noteFmt(kind: string) {
  if (NE.cross) {
    document.execCommand(kind);
    noteCrossSync();
    noteDirty();
    return noteTb();
  }
  const sel = getSelection();
  const bt = elOf(sel.anchorNode)?.closest<HTMLElement>(".bt");
  if (!bt || sel.isCollapsed) return;
  const i = Number(bt.closest<HTMLElement>(".blk").dataset.i);
  if (kind === "code") {
    const r = sel.getRangeAt(0);
    const c = document.createElement("code");
    c.textContent = r.toString();
    r.deleteContents();
    r.insertNode(c);
  } else if (kind === "link") {
    const tb = getNote().tb;
    if (tb) setNote({ tb: { ...tb, link: { range: sel.getRangeAt(0).cloneRange(), i } } });
    return;
  } else document.execCommand(kind);
  noteSync(i);
  noteDirty();
  noteTb();
}
// The link written for what was selected (Enter in the toolbar's box), or none (Esc).
export function noteLink(url: string | null) {
  const link = getNote().tb?.link;
  setNote({ tb: null });
  if (!link || url == null || !/^(https?:|mailto:|#\/)/i.test(url)) return;
  const a = document.createElement("a");
  a.href = url;
  a.append(link.range.extractContents());
  link.range.insertNode(a);
  noteSync(link.i);
  noteDirty();
}

// The / menu (a block's kind), a block's menu, the @ list in a comment's box or a block, and an emoji to pick.
const NB_KINDS: [string, string, string, string][] = [
  ["p", "Text", "T", "paragraph plain"],
  ["h1", "Heading 1", "H1", "#"],
  ["h2", "Heading 2", "H2", "##"],
  ["h3", "Heading 3", "H3", "###"],
  ["todo", "To-do", "☐", "checkbox task []"],
  ["ul", "Bulleted list", "•", "bullet -"],
  ["ol", "Numbered list", "1.", "number 1."],
  ["quote", "Quote", "❝", ">"],
  ["callout", "Callout", "💡", "tip box"],
  ["code", "Code", "{ }", "snippet ```"],
  ["hr", "Divider", "—", "line rule ---"],
  ["sub", "Note inside this one", "📄", "page child sub"],
];
const NB_EMOJI = ["📄", "📝", "🚀", "📌", "💡", "✅", "⚠️", "❓", "📨", "🗒️", "📐", "🧪", "🧭", "📚", "💸", "📈", "🔎", "🛠️", "🎯", "🗓️", "🤝", "🧠", "🔥", "⭐"];
export function nbOpen(kind: "slash" | "at" | "emoji" | "menu", r: { left: number; top: number; bottom: number }, ctx: PopCtx = {}) {
  setNote({ pop: { kind, ctx, sel: 0, q: "", items: [], rect: { left: r.left, top: r.top, bottom: r.bottom } } });
  nbFilter("");
}
function nbFilter(q: string) {
  const NP = getNote().pop;
  if (!NP) return;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (hay: string) => words.every((w) => hay.toLowerCase().split(/[^a-z0-9#]+/).some((x) => x.startsWith(w)) || hay.toLowerCase().includes(w));
  let items: PopItem[];
  if (NP.kind === "slash") items = NB_KINDS.filter(([t, l, , k]) => hit(`${l} ${t} ${k}`)).map(([t, l, g]) => ({ t, l, g }));
  // An agent or a thread to ask, then the pages, widgets, notes and workspaces it can name, as a message's @ does.
  else if (NP.kind === "at")
    items = [
      ...[...noteAgents().map((a): PopItem => ({ a })), ...noteThreads().map((s): PopItem => ({ s }))].filter((x) => hit(x.a ? `${x.a.name} ${agentName(x.a.id)}` : `${x.s.label} ${x.s.title || ""} ${agentOf(x.s.agent).name}`)),
      ...mentionRows(q, null),
    ];
  else if (NP.kind === "emoji") items = NB_EMOJI.map((e) => ({ e }));
  else items = NP.ctx.items || [];
  setNote({ pop: { ...NP, q, items, sel: Math.min(NP.sel, Math.max(0, items.length - 1)) } });
}
export function nbClose() {
  if (!getNote().pop) return;
  setNote({ pop: null });
  for (const b of $$(".blk.is-menu")) b.classList.remove("is-menu");
}
export function nbMove(sel: number) {
  const NP = getNote().pop;
  if (NP) setNote({ pop: { ...NP, sel } });
}
export function nbPick(i: number) {
  const NP = getNote().pop;
  const x = NP?.items[i];
  if (!x || x.sep) return;
  const { kind, ctx } = NP;
  nbClose();
  if (kind === "emoji") return ctx.pick(x.e);
  if (kind === "menu") return x.run();
  if (kind === "slash") {
    if (ctx.typed) {
      const bt = noteBt(ctx.i);
      rangeAt(bt, ctx.start, caretOff(bt)).deleteContents();
      noteSync(ctx.i);
      if (!NE.blocks[ctx.i].md || x.t === "hr" || x.t === "sub") return noteTurn(ctx.i, x.t);
      NE.blocks.splice(ctx.i + 1, 0, { t: "p", md: "" });
      return noteTurn(ctx.i + 1, x.t);
    }
    NE.blocks.splice(ctx.i + 1, 0, { t: "p", md: "" });
    return noteTurn(ctx.i + 1, x.t);
  }
  if (kind === "at") {
    const box = ctx.el;
    const block = ctx.i != null;
    box.focus();
    const r = rangeAt(box, ctx.start, caretOff(box));
    r.deleteContents();
    // In a block an agent is a name in the words, kept as its token; in a comment's box, who the comment goes to.
    const chip = x.a ? (block ? noteSayChip(slug(x.a.name), x.a.name, x.a.id) : noteAgentChip(x.a)) : x.s ? (block ? noteSayChip(slug(x.s.label), x.s.label, x.s.agent) : noteThreadChip(x.s)) : namedChip(x, { box: true });
    const frag = r.createContextualFragment(`${chip}${block ? " " : "&nbsp;"}`);
    const last = frag.lastChild;
    r.insertNode(frag);
    const c = document.createRange();
    c.setStartAfter(last);
    c.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(c);
    if (!block) return void boxes.set(box.dataset.nbox, box.innerHTML);
    noteSync(ctx.i);
    noteDirty();
    if (x.a || x.s) noteAskArm(ctx.i, x);
  }
}
// What's typed after / (in a block) or @ (in a block or a comment's box) narrows its menu; a space or a step back past
// it closes it.
export function noteTyped(el: HTMLElement, e: InputEvent, i: number | null) {
  const off = caretOff(el);
  const text = el.textContent;
  if (e.inputType === "insertText" && (e.data === "/" || e.data === "@") && (off === 1 || /\s/.test(text[off - 2] || ""))) {
    const rect = getSelection().getRangeAt(0).getClientRects()[0] || el.getBoundingClientRect();
    const code = i != null && NE.blocks[i]?.t === "code";
    if (e.data === "/" && i != null && !code) return nbOpen("slash", rect, { el, i, typed: true, start: off - 1 });
    if (e.data === "@" && !code) return nbOpen("at", rect, { el, i, start: off - 1 });
  }
  const NP = getNote().pop;
  if (!NP || !["slash", "at"].includes(NP.kind) || NP.ctx.el !== el) return;
  if (off <= NP.ctx.start || text[NP.ctx.start] !== (NP.kind === "slash" ? "/" : "@")) return nbClose();
  const q = text.slice(NP.ctx.start + 1, off);
  if (/^\s/.test(q) || (NP.kind === "slash" && /\s/.test(q)) || q.length > 24) return nbClose();
  nbFilter(q);
  if (i == null || NP.kind !== "at") return;
  // In the text, an agent's whole name and a space is picking it, and an @ that names nothing is just words.
  const items = getNote().pop?.items || [];
  if (e.data === " ") {
    const name = slug(q);
    const hit = items.findIndex((x) => (x.a && slug(x.a.name) === name) || (x.s && slug(x.s.label) === name));
    if (hit >= 0) return nbPick(hit);
  }
  if (!items.length) nbClose();
}
function noteBlockMenu(i: number, rect: DOMRect) {
  const b = NE.blocks[i];
  const items: PopItem[] = [
    ...(textBlock(b) && b.t !== "code"
      ? [
          {
            k: <Icon name="comment" />,
            l: "Comment on it",
            run: () => {
              const { words, at } = noteBlockWords(i);
              noteCommentOn(words, at);
            },
          },
        ]
      : []),
    {
      k: <Icon name="copy" />,
      l: "Duplicate",
      run: () => {
        noteSync(i);
        const { ask: _, ...copy } = b;
        NE.blocks.splice(i + 1, 0, { ...copy, md: unlay(b.md || "") });
        noteReshape({ i: i + 1, off: "end" });
      },
    },
    ...(textBlock(b) ? [{ sep: true }, ...NB_KINDS.filter(([t]) => !["hr", "sub", b.t].includes(t)).map(([t, l, g]) => ({ k: g, l: `Turn into ${l.toLowerCase()}`, run: () => noteTurn(i, t) }))] : []),
    { sep: true },
    {
      k: <Icon name="x" />,
      l: "Delete",
      red: true,
      run: () => {
        noteSyncAll();
        NE.blocks.splice(i, 1);
        noteReshape({ i: Math.max(0, i - 1), off: "end" });
      },
    },
  ];
  docOf()?.querySelector(`.blk[data-i="${i}"]`)?.classList.add("is-menu");
  nbOpen("menu", rect, { items });
}
// Its icon (the head's), changed.
export function noteEmojiPick(rect: DOMRect) {
  nbOpen("emoji", rect, {
    pick: (em) => {
      setNote({ emoji: em });
      noteDirty();
    },
  });
}
// The Markdown button: the note as its markdown, or back to its blocks (with what was changed there).
export function noteMdToggle() {
  const { md, note } = getNote();
  if (md && NE.mdDirty) {
    const src = docOf()?.querySelector<HTMLTextAreaElement>("[data-note-src]");
    NE.blocks = parseBlocks(overlay(cleanMd(src?.value), openSugg(note)).md);
    noteDirty();
  } else if (!md) noteSyncAll();
  setNote({ md: !md });
  noteDocDraw();
}
export function noteTitleTyped(el: HTMLElement) {
  setNote({ title: el.textContent.replace(/\s+/g, " ").trim() });
  noteDirty();
}

/* ---------- what the note's page does ---------- */

// The page's own listeners, for as long as it's open (NoteDoc puts them on, and takes them off as it goes): clicks,
// keys, typing, pasting and dragging in its words, the selection, and leaving the page.
export function noteListen(): () => void {
  const on: [EventTarget, string, EventListener, boolean?][] = [];
  const add = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, capture = false) => {
    t.addEventListener(type, fn as EventListener, capture);
    on.push([t, type, fn as EventListener, capture]);
  };
  const inDoc = (t: EventTarget | null) => {
    const el = elOf(t);
    return !!el && !!docOf()?.contains(el);
  };
  add(document, "mousedown", (e: MouseEvent) => {
    // The toolbar and the menus act on the selection and the cursor, so they don't take the focus.
    if (elOf(e.target)?.closest(".nb-tb button, .nb-pop button, .nb-ask button")) e.preventDefault();
    else noteDragStart(e);
  });
  add(document, "mousemove", (e: MouseEvent) => {
    if (!NE.drag) return;
    if (!e.buttons) return noteDragEnd();
    Object.assign(NE.drag, { x: e.clientX, y: e.clientY });
    noteDragTo(e);
  });
  add(document, "mouseup", noteDragEnd);
  add(document, "copy", noteCrossCopy);
  add(document, "cut", noteCrossCopy);
  // With the note as the box, nothing the browser would do to its text happens: the blocks change instead.
  add(document, "beforeinput", (e: InputEvent) => {
    if (!NE.cross || !inDoc(e.target) || e.inputType.startsWith("format")) return;
    e.preventDefault();
    if (e.inputType.startsWith("delete")) noteCrossCut();
    else if (e.inputType === "insertText" || e.inputType === "insertReplacementText") noteCrossCut(e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
  });
  add(document, "compositionstart", (e: CompositionEvent) => {
    if (NE.cross && inDoc(e.target)) noteCrossCut();
  });
  // A click anywhere closes a menu that's open (before what it was on opens another), and a click away from the
  // comments, on nothing that does something, closes the one that's open.
  add(
    document,
    "click",
    (e: MouseEvent) => {
      if (!elOf(e.target)?.closest(".nb-pop")) nbClose();
    },
    true,
  );
  add(document, "click", (e: MouseEvent) => {
    const t = elOf(e.target);
    if (!t || t.closest(".note-rail, .nb-tb, .nb-pop, button, a, .mchip, input, [role=button], .cm")) return;
    noteDeselect();
  });
  // In the words: a block's buttons (its tick, its callout's emoji, + and its handle, Ask), a comment's words, and a
  // note a chip names.
  add(document, "click", (e: MouseEvent) => {
    const t = elOf(e.target);
    if (!t || !inDoc(t)) return;
    const n = noteNow();
    if (noteRo(n) && t.closest("[data-nb-emoji], [data-nb-tick], [data-nb-add], [data-nb-grip]")) return;
    const coem = t.closest<HTMLElement>("[data-nb-emoji]");
    if (coem) {
      const i = Number(coem.dataset.nbEmoji);
      return nbOpen("emoji", coem.getBoundingClientRect(), {
        pick: (em) => {
          NE.blocks[i].emoji = em;
          noteSyncAll();
          noteReshape({ i, off: "end" });
        },
      });
    }
    const tick = t.closest<HTMLElement>("[data-nb-tick]");
    if (tick) {
      const i = Number(tick.dataset.nbTick);
      noteSyncAll();
      NE.blocks[i].done = !NE.blocks[i].done;
      return noteReshape({ i, off: "end" });
    }
    const add_ = t.closest<HTMLElement>("[data-nb-add]");
    if (add_) {
      add_.closest(".blk").classList.add("is-menu");
      return nbOpen("slash", add_.getBoundingClientRect(), { i: Number(add_.dataset.nbAdd) });
    }
    const grip = t.closest<HTMLElement>("[data-nb-grip]");
    if (grip) return noteBlockMenu(Number(grip.dataset.nbGrip), grip.getBoundingClientRect());
    const ask = t.closest("[data-nb-ask], [data-nb-ask-off]");
    if (ask) {
      const i = Number(ask.closest<HTMLElement>(".blk").dataset.i);
      return ask.matches("[data-nb-ask]") ? noteAskNext(i) : noteAskOff(i);
    }
    const span = t.closest<HTMLElement>(".cm");
    if (span && !t.closest("a")) return noteSetActive(span.dataset.c);
    // A note it names opens it; in the text it's a piece of the words, not a link.
    const named = t.closest<HTMLElement>('.mchip[data-ref^="note:"]');
    if (named) return void (location.hash = noteHref(named.dataset.ref.slice(5)));
  });
  add(document, "mouseover", (e: MouseEvent) => {
    const t = elOf(e.target);
    const id = t?.closest<HTMLElement>(".note-rail .cc[data-cc]")?.dataset.cc || (inDoc(t) ? t.closest<HTMLElement>(".cm")?.dataset.c : null) || null;
    if (id !== hover) {
      hover = id;
      noteDecorate();
    }
  });
  add(document, "input", (e: InputEvent) => {
    const t = elOf(e.target);
    if (!t || !inDoc(t) && t !== docOf()) return;
    if (NE.cross && t === docOf()) {
      noteCrossSync();
      return noteDirty();
    }
    const bt = t.closest<HTMLElement>(".bt");
    if (bt) {
      NE.undo = null;
      const i = Number(bt.closest<HTMLElement>(".blk").dataset.i);
      if (e.inputType === "insertText" && [" ", "`", "-"].includes(e.data) && noteShortcut(i, bt)) return;
      noteSync(i, bt);
      if (NE.blocks[i]?.ask && !bt.querySelector(".mchip[data-m]")) noteAskOff(i);
      noteTyped(bt, e, i);
      noteDirty();
      setTimeout(() => NE.stale && !noteTyping() && loadNote(), 1700);
      return void requestAnimationFrame(noteLayout);
    }
    if (t.matches("[data-note-src]")) return void (NE.mdDirty = true);
    const lang = t.closest<HTMLInputElement>("[data-nb-lang]");
    if (lang) {
      NE.blocks[Number(lang.dataset.nbLang)].lang = lang.value.trim().slice(0, 20);
      return noteDirty();
    }
  });
  // ↑ ↓ through a menu that's open, Enter or Tab to pick, Esc to close, before what's typed in gets them.
  add(
    document,
    "keydown",
    (e: KeyboardEvent) => {
      const NP = getNote().pop;
      if (!NP || e.isComposing) return;
      const n = NP.items.length;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
        let i = NP.sel;
        do i = (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        while (NP.items[i]?.sep);
        nbMove(i);
      } else if ((e.key === "Enter" || e.key === "Tab") && n) nbPick(NP.sel);
      else if (e.key === "Escape") nbClose();
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  add(document, "keydown", (e: KeyboardEvent) => {
    const t = elOf(e.target);
    if (!t) return;
    const bt = inDoc(t) ? t.closest<HTMLElement>(".bt") : null;
    if (bt) return noteKeyBlock(e, bt);
    if (NE.cross && t === docOf()) return noteKeyCross(e);
  });
  add(document, "paste", (e: ClipboardEvent) => {
    if (NE.cross && (inDoc(e.target) || e.target === docOf())) {
      const at = noteCrossCut();
      const undo = NE.undo;
      if (at) notePaste(e, at);
      NE.undo = undo;
      return;
    }
    const bt = inDoc(e.target) ? elOf(e.target).closest<HTMLElement>(".bt") : null;
    if (bt) notePaste(e, bt);
  });
  let tbFrame = 0;
  add(document, "selectionchange", () => {
    noteCrossCheck();
    cancelAnimationFrame(tbFrame);
    tbFrame = requestAnimationFrame(() => noteTb());
  });
  // Dragging a block by its handle.
  let dragging: number | null = null;
  add(document, "dragstart", (e: DragEvent) => {
    const g = elOf(e.target)?.closest<HTMLElement>("[data-nb-grip]");
    if (!g) return;
    dragging = Number(g.dataset.nbGrip);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
    const blk = g.closest(".blk");
    e.dataTransfer.setDragImage(blk, 20, 16);
    setTimeout(() => blk.classList.add("is-dragging"));
  });
  add(document, "dragover", (e: DragEvent) => {
    if (dragging == null) return;
    const blk = inDoc(e.target) ? elOf(e.target).closest<HTMLElement>(".blk") : null;
    for (const b of $$(".is-drop-above, .is-drop-below")) b.classList.remove("is-drop-above", "is-drop-below");
    if (!blk || Number(blk.dataset.i) === dragging) return;
    e.preventDefault();
    const r = blk.getBoundingClientRect();
    blk.classList.add(e.clientY < r.top + r.height / 2 ? "is-drop-above" : "is-drop-below");
  });
  add(document, "drop", (e: DragEvent) => {
    if (dragging == null) return;
    e.preventDefault();
    const blk = document.querySelector<HTMLElement>(".is-drop-above, .is-drop-below");
    const from = dragging;
    dragging = null;
    if (!blk) return noteDocDraw();
    noteSyncAll();
    const to = Number(blk.dataset.i) + (blk.classList.contains("is-drop-below") ? 1 : 0);
    const [b] = NE.blocks.splice(from, 1);
    const at = to > from ? to - 1 : to;
    NE.blocks.splice(at, 0, b);
    noteReshape({ i: at, off: "end" });
  });
  add(document, "dragend", () => {
    dragging = null;
    for (const b of $$(".is-dragging, .is-drop-above, .is-drop-below")) b.classList.remove("is-dragging", "is-drop-above", "is-drop-below");
  });
  // A resize moves the comments beside the words.
  let resized: ReturnType<typeof setTimeout>;
  add(window, "resize", () => {
    clearTimeout(resized);
    resized = setTimeout(noteLayout, 80);
  });
  add(window, "pagehide", () => NE.dirty && noteSave({ leaving: true }));
  return () => {
    for (const [t, type, fn, capture] of on) t.removeEventListener(type, fn, capture);
    cancelAnimationFrame(tbFrame);
    rawsOff();
  };
}
