// Notes: a note is markdown, and the page edits it a block at a time, one block for each
// paragraph, heading, list item, to-do, quote, callout, code block or divider. This is the markdown side of that,
// shared by the page (web/) and the server (notes.ts): markdown into blocks and back, an agent's suggestions
// laid over the text, and the plain words of a note.
//
// A block is { t, md } and, by its kind: done (a to-do), emoji (a callout), lang (code), depth (how far a list
// item is in, 0 to 3), href and label (a note inside this one). `md` is the block's inline markdown; code keeps
// its text as it is. Tables, images and anything else markdown has that a block can't edit are "raw": shown as
// markdown shows them, and changed in the note's markdown.

export const KINDS = ["p", "h1", "h2", "h3", "todo", "ul", "ol", "quote", "callout", "code", "hr", "sub", "raw"];
export interface Block {
  t: string;
  md?: string;
  done?: boolean;
  emoji?: string;
  lang?: string;
  depth?: number;
  href?: string;
  label?: string;
}
// An agent's suggestion: the words it changes (`find`, as the markdown has them) and what it puts there.
export interface Suggestion {
  id: string;
  find: string;
  replace: string;
}
const LIST = new Set(["ul", "ol", "todo"]);
const EMOJI = /^\p{Extended_Pictographic}(?:\ufe0f|\u200d\p{Extended_Pictographic})*/u;

// A suggestion, laid over the markdown it changes: these characters never come from typing or from an agent
// (the server takes them out of what it's given), so the page can tell a suggestion from the words around it.
export const SG = { open: "\u0001", mid: "\u0002", to: "\u0003", end: "\u0004" };
const SG_STRIP = /[\u0001-\u0004]/g;
export const cleanText = (s: unknown): string => String(s ?? "").replace(SG_STRIP, "").replace(/\r\n?/g, "\n");

/* ---------- markdown into blocks, and back ---------- */

export function parseBlocks(md: unknown): Block[] {
  const out: Block[] = [];
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para: Block = null;
  const flush = () => { if (para) out.push({ ...para, md: para.md.replace(/( {2,}|\\)$/, "").trimEnd() }); para = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/))) {
      flush();
      const fence = m[1];
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i]);
      out.push({ t: "code", lang: m[2] || "", md: body.join("\n") });
      continue;
    }
    if (!l.trim()) { flush(); continue; }
    // a table, an image, raw HTML: kept as written
    if (/^\s*\|/.test(l) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l) || /^\s*<[a-z!/]/i.test(l)) {
      flush();
      const raw = [l];
      const table = /^\s*\|/.test(l);
      while (table && i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) raw.push(lines[++i]);
      out.push({ t: "raw", md: raw.join("\n") });
      continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); out.push({ t: `h${Math.min(3, m[1].length)}`, md: m[2] }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push({ t: "hr" }); continue; }
    const depth = (s: string): number => Math.min(3, Math.floor(s.replace(/\t/g, "  ").length / 2));
    if ((m = l.match(/^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/))) { flush(); para = { t: "todo", done: m[2] !== " ", depth: depth(m[1]), md: m[3] }; continue; }
    if ((m = l.match(/^(\s*)[-*+]\s+(.*)$/))) { flush(); para = { t: "ul", depth: depth(m[1]), md: m[2] }; continue; }
    if ((m = l.match(/^(\s*)\d+[.)]\s+(.*)$/))) { flush(); para = { t: "ol", depth: depth(m[1]), md: m[2] }; continue; }
    if ((m = l.match(/^\s*>\s?(.*)$/))) {
      flush();
      const body = m[1];
      const em = body.match(EMOJI);
      // "> 💡 text" is a callout; a quote's next lines are the same quote
      const b: Block = em && body.slice(em[0].length).startsWith(" ") ? { t: "callout", emoji: em[0], md: body.slice(em[0].length).trim() } : { t: "quote", md: body };
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]) && !EMOJI.test(lines[i + 1].replace(/^\s*>\s?/, ""))) b.md += "\n" + lines[++i].replace(/^\s*>\s?/, "");
      out.push(b);
      continue;
    }
    // a note inside this one: a link to it, alone on its line
    if ((m = l.trim().match(/^\[([^\]]*)\]\(#\/notes\/([\w-]+)\)$/))) { flush(); out.push({ t: "sub", label: m[1], href: m[2] }); continue; }
    // a line goes on with the block before it, a list item's included, unless it starts one
    if (para) {
      const hard = /( {2,}|\\)$/.test(para.md);
      para.md = (hard ? para.md.replace(/( {2,}|\\)$/, "") + "\n" : para.md.trimEnd() + " ") + l.replace(/^\s+/, "");
      continue;
    }
    para = { t: "p", md: l.replace(/^\s+/, "") };
  }
  flush();
  return out;
}

// A block's line(s) in the note's markdown. A soft line break in a block ("\n" in its md) is written as a hard
// break, two spaces and a new line, so it comes back.
function blockMd(b: Block, n: number): string {
  const md = String(b.md ?? "").replace(/\n/g, "  \n" + "  ".repeat(b.depth || 0) + (LIST.has(b.t) ? "  " : ""));
  const pad = "  ".repeat(b.depth || 0);
  switch (b.t) {
    case "h1": return `# ${md}`;
    case "h2": return `## ${md}`;
    case "h3": return `### ${md}`;
    case "ul": return `${pad}- ${md}`;
    case "ol": return `${pad}${n}. ${md}`;
    case "todo": return `${pad}- [${b.done ? "x" : " "}] ${md}`;
    case "quote": return String(b.md ?? "").split("\n").map((l) => `> ${l}`).join("\n");
    case "callout": return `> ${b.emoji || "💡"} ${String(b.md ?? "").replace(/\n/g, " ")}`;
    case "code": return "```" + (b.lang || "") + "\n" + (b.md ?? "") + "\n```";
    case "hr": return "---";
    case "sub": return `[${b.label || "Untitled"}](#/notes/${b.href})`;
    case "raw": return b.md ?? "";
    default: return md;
  }
}
export function joinBlocks(blocks: Block[]): string {
  const out: string[] = [];
  const count: number[] = [];
  blocks.forEach((b, i) => {
    if (b.t === "ol") { const d = b.depth || 0; count.length = d + 1; count[d] = (count[d] || 0) + 1; }
    else if (!LIST.has(b.t)) count.length = 0;
    out.push(blockMd(b, count[b.depth || 0] || 1));
    const next = blocks[i + 1];
    if (next) out.push(LIST.has(b.t) && LIST.has(next.t) ? "\n" : "\n\n");
  });
  return out.join("").replace(/\s+$/, "") + "\n";
}

// A selection across blocks, from block `i` to block `j`. `head` and `tail` are what it leaves of those two: with it
// taken out, block i has both, and none of the blocks between are left.
export function cutBlocks(blocks: Block[], i: number, j: number, head: string, tail: string): Block[] {
  return [...blocks.slice(0, i), { ...blocks[i], md: head + tail }, ...blocks.slice(j + 1)];
}
// That selection as markdown. `first` and `last` are what it takes of those two.
export function sliceBlocks(blocks: Block[], i: number, j: number, first: string, last: string): string {
  return joinBlocks(blocks.slice(i, j + 1).map((b, k) => (k === 0 ? { ...b, md: first } : i + k === j ? { ...b, md: last } : b))).trimEnd();
}

/* ---------- inline: markdown into the editor's HTML, and back ---------- */

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// "@page", "@page/widget", "@note:<id>", "@ws:<id>", or an agent, a thread or a person by name: the page says which are
// chips (chip(token) gives its HTML, or nothing for a token that names nothing).
const TOKEN = /(^|[\s(\u0001\u0002\u0003])@((?:ws|note):[a-z0-9][a-z0-9-]*|[a-z0-9][\w-]*(?:\/[\w.-]*\w)?)(?![\w/-])/gi;
const SAFE_URL = /^(https?:|mailto:|#\/)/i;

export function inlineHtml(md: unknown, { chip = () => null, sugg = () => "" }: { chip?: (token: string) => string | null; sugg?: (id: string) => string } = {}): string {
  const keep: string[] = [];
  const hold = (html: string): string => `\u0005${keep.push(html) - 1}\u0006`;
  let s = String(md ?? "");
  // code spans first: nothing in them is markdown
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, text, href) => (SAFE_URL.test(href) ? hold(`<a href="${esc(href)}">`) + text + hold("</a>") : all));
  s = s.replace(TOKEN, (all, pre, tok) => { const c = chip(tok); return c ? pre + hold(c) : all; });
  s = esc(s);
  // a suggestion laid over the text: what it takes out, then what it puts in
  s = s.replace(/\u0001([\w-]+)\u0002([\s\S]*?)\u0003([\s\S]*?)\u0004/g, (_, id, from, to) => (from ? `<del class="sg" data-s="${id}"${sugg(id)}>${from}</del>` : "") + (to ? `<ins class="sg" data-s="${id}"${sugg(id)}>${to}</ins>` : ""));
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+?)__/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>").replace(/[\n\u2028]/g, "<br>");
  return s.replace(/\u0005(\d+)\u0006/g, (_, i) => keep[i]);
}

// The editor's HTML back into inline markdown. A suggestion isn't part of the note until it's accepted, so its
// <del> stays as written and its <ins> goes; a comment's shading is only shading.
// node: the editor's DOM, as inlineMd reads it (the server, which has no DOM, checks this file too).
export interface EditorNode {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  childNodes: Iterable<EditorNode>;
  tagName?: string;
  dataset?: { m?: string; ref?: string };
  classList?: { contains(token: string): boolean };
  getAttribute?(name: string): string | null;
}
export function inlineMd(node: EditorNode): string {
  let out = "";
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += n.nodeValue.replace(/\u00a0/g, " "); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    // a chip: what it names, as its token
    if (n.dataset?.m || n.dataset?.ref) { out += `@${n.dataset.m || n.dataset.ref}`; continue; }
    if (tag === "INS" && n.classList.contains("sg")) continue;
    if (tag === "BR") { out += "\n"; continue; }
    const inner = inlineMd(n);
    if (!inner) continue;
    if (tag === "B" || tag === "STRONG") out += wrap(inner, "**");
    else if (tag === "I" || tag === "EM") out += wrap(inner, "_");
    else if (tag === "S" || tag === "STRIKE" || (tag === "DEL" && !n.classList.contains("sg"))) out += wrap(inner, "~~");
    else if (tag === "CODE") out += "`" + n.textContent + "`";
    else if (tag === "A" && SAFE_URL.test(n.getAttribute("href") || "")) out += `[${inner}](${n.getAttribute("href")})`;
    else if (tag === "DIV" || tag === "P") out += (out && !out.endsWith("\n") ? "\n" : "") + inner;
    else out += inner;
  }
  return out;
}
// "**x **" isn't bold in markdown: the marks hug the words, and the spaces go outside them
const wrap = (s: string, m: string): string => { const a = s.match(/^\s*/)[0], z = s.match(/\s*$/)[0], t = s.trim(); return t ? a + m + t + m + z : s; };

/* ---------- suggestions ---------- */

// Where a suggestion's words are in the note: the first place they are, or -1. It names them as they are written,
// markdown and all.
export const findIn = (md: unknown, find: string): number => (find ? String(md).indexOf(find) : -1);

// The note's markdown with its open suggestions laid over it, for the page: [{ id, find, replace }] in order, each
// at the first place its words are. One whose words aren't there any more, or overlap one before it, isn't shown
// (`missing`).
export function overlay(md: unknown, suggestions: Suggestion[]): { md: string; missing: string[] } {
  const spots: (Suggestion & { at: number })[] = [];
  const missing: string[] = [];
  for (const s of suggestions) {
    const at = findIn(md, s.find);
    if (at < 0 || spots.some((o) => at < o.at + o.find.length && o.at < at + s.find.length)) { missing.push(s.id); continue; }
    spots.push({ ...s, at });
  }
  spots.sort((a, b) => b.at - a.at);
  let out = String(md);
  // a new line in what it puts in stays in its block until it's accepted
  for (const s of spots) out = out.slice(0, s.at) + SG.open + s.id + SG.mid + s.find + SG.to + String(s.replace).replace(/\n/g, "\u2028") + SG.end + out.slice(s.at + s.find.length);
  return { md: out, missing };
}

// The markdown again without what overlay() laid over it.
export const unlay = (md: unknown): string => String(md ?? "").replace(/\u0001[\w-]+\u0002([\s\S]*?)\u0003[\s\S]*?\u0004/g, "$1");

// The same, the way an agent reads it: CriticMarkup, {~~old~>new~~}.
export function critic(md: unknown, suggestions: Suggestion[]): { md: string; missing: string[] } {
  const { md: laid, missing } = overlay(md, suggestions);
  return { md: laid.replace(/\u0001[\w-]+\u0002([\s\S]*?)\u0003([\s\S]*?)\u0004/g, (_, a, b) => (a && b ? `{~~${a}~>${b}~~}` : a ? `{--${a}--}` : `{++${b}++}`)).replace(/\u2028/g, "\n"), missing };
}

// Accepting one: its words, replaced. Null when they aren't there any more.
export function accept(md: string, s: Pick<Suggestion, "find" | "replace">): string | null {
  const at = findIn(md, s.find);
  return at < 0 ? null : md.slice(0, at) + s.replace + md.slice(at + s.find.length);
}

/* ---------- plain words ---------- */

// A note's words without its markdown, for search and for a line about it.
export function plainText(md: unknown): string {
  return parseBlocks(md)
    .filter((b) => b.t !== "hr" && b.t !== "code" && b.t !== "raw")
    .map((b) => (b.t === "sub" ? b.label : String(b.md || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_~`]+/g, "")))
    .join("\n");
}
