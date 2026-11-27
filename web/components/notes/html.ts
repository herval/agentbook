// A note's words are edited in place (contenteditable), so what's in them is HTML the editor writes itself: the chips
// an @ makes (a page, a widget, a note, a workspace, an agent), an agent's face on the line it was asked on, the icons
// in the blocks' margins. These are those, as strings, ported from the old page as they were; a comment's words are
// drawn with them too. Everything from a note or an agent is escaped here.
import { avatarOf, avatarUrl, glyph } from "../Avatar.tsx";
import { workspaces, wsWhere } from "../../lib/agents.ts";
import { esc, groupCss, hue, hueCss, pageCss, reEsc } from "../../lib/format.ts";
import { groupHref, noteHref, taskHref, workspaceHref } from "../../lib/route.ts";
import { agentOf, getApp } from "../../lib/store.ts";
import type { GroupRow, NoteRow, PageRow, TaskRow, Thread, Widget, WorkspaceRow } from "../../lib/types.ts";
import { GROUP_MENTION, groupNamed, MENTION, mentioned, mentionHref, mentionRef, NOTE_MENTION, noteNamed, plainMentions, TASK_MENTION, taskNamed, WS_MENTION, wsNamed } from "../../lib/mentions.tsx";
// What tokens name, the same as everywhere else (lib/mentions.tsx).
export { mentioned, noteNamed, plainMentions, wsNamed };

export const iconHtml = (name: string) => `<svg class="i"><use href="#i-${name}"/></svg>`;
// A string of CSS variables as a style prop, for the React side of the same rows.
export const styleProp = (s: string) => Object.fromEntries(s.split(";").filter(Boolean).map((d) => d.split(":"))) as React.CSSProperties;

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// An agent's face, as <Avatar/> draws it.
export function avatarHtml(agentId: string | null | undefined, size = "", on: boolean | string = false): string {
  const dot = !on ? "" : on === true || on === "active" ? '<i class="on"></i>' : `<i class="on on--${on}"></i>`;
  if (agentId == null) return `<span class="av av--private ${size}" title="A private agent">${iconHtml("lock")}${dot}</span>`;
  const pic = avatarOf(agentOf(agentId));
  const face = pic?.image ? `<img src="${esc(avatarUrl(agentId, pic))}" alt="" draggable="false">` : pic?.emoji ? (EMOJI.test(pic.emoji) ? `<span class="em">${esc(pic.emoji)}</span>` : esc(pic.emoji)) : esc(glyph(agentId));
  return `<span class="av ${size}${pic?.image ? " av--pic" : ""}" style="${hueCss(agentId)}">${face}${dot}</span>`;
}

// A name as a token in the words: "Claude Code" is @claude-code.
export const slug = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---------- what a token names, and its chip ---------- */

// What a token names: { p } a page, { p, w } a widget on it, { p, gone } a widget that's no longer on it; or null.
export interface Named {
  p?: PageRow;
  w?: Widget;
  gone?: string;
  ws?: WorkspaceRow;
  note?: NoteRow;
  task?: TaskRow;
  group?: GroupRow;
}
// A chip: the page's emoji and the widget's (or the page's) title, in the page's color. In a message it's a link;
// in a box it's a piece of the text that deletes whole.
export function mentionChip(n: Named & { p: PageRow }, { box = false, thread = null }: { box?: boolean; thread?: string | null } = {}) {
  const tip = n.gone ? `No longer on ${n.p.title}` : n.w ? `${n.w.title || n.w.id} (${n.w.id}), on ${n.p.title}` : `The page ${n.p.title}`;
  const face = n.gone ? `@${esc(n.gone)}` : `<span class="mchip-em">${esc(n.p.emoji || "📄")}</span><span class="mchip-t">${esc(n.w ? n.w.title || n.w.id : n.p.title)}</span>`;
  const attrs = `class="mchip${n.gone ? " mchip--gone" : ""}" data-ref="${esc(mentionRef(n))}" style="${pageCss(n.p)}" title="${esc(tip)}"`;
  if (box) return `<span ${attrs} contenteditable="false">${face}</span>`;
  return n.gone ? `<span ${attrs}>${face}</span>` : `<a ${attrs} href="${mentionHref(n, thread)}">${face}</a>`;
}
// A workspace's chip: its icon and name, going to its page.
export function wsMentionChip(w: WorkspaceRow, { box = false } = {}) {
  const attrs = `class="mchip mchip--ws" data-ref="ws:${esc(w.id)}" title="${esc(`The workspace ${w.name}\n${wsWhere(w)}`)}"`;
  const face = `${iconHtml(w.repo ? "repo" : "folder")}<span class="mchip-t">${esc(w.name)}</span>`;
  return box ? `<span ${attrs} contenteditable="false">${face}</span>` : `<a ${attrs} href="${workspaceHref(w.id)}">${face}</a>`;
}
// The chips of a task, a group and a note a token names.
function taskMentionChip(t: TaskRow, { box = false } = {}) {
  const attrs = `class="mchip mchip--task${t.done ? " is-done" : ""}" data-ref="task:${esc(t.id)}" title="${esc(`The task ${t.text}${t.done ? " (done)" : ""}`)}"`;
  const face = `${iconHtml("tasks")}<span class="mchip-t">${esc(t.text)}</span>`;
  return box ? `<span ${attrs} contenteditable="false">${face}</span>` : `<a ${attrs} href="${taskHref(t)}">${face}</a>`;
}
function groupMentionChip(g: GroupRow, { box = false } = {}) {
  const attrs = `class="mchip mchip--group" data-ref="group:${esc(g.id)}" style="${groupCss(g)}" title="${esc(`The group ${g.name}`)}"`;
  const face = `<span class="mchip-em">${esc(g.emoji || "👥")}</span><span class="mchip-t">${esc(g.name)}</span>`;
  return box ? `<span ${attrs} contenteditable="false">${face}</span>` : `<a ${attrs} href="${groupHref(g)}">${face}</a>`;
}
export function noteMentionChip(n: NoteRow, { box = false } = {}) {
  const attrs = `class="mchip mchip--note" data-ref="note:${esc(n.id)}" title="${esc(`The note ${n.title}`)}"`;
  const face = `<span class="mchip-em">${esc(n.emoji || "📄")}</span><span class="mchip-t">${esc(n.title)}</span>`;
  return box ? `<span ${attrs} contenteditable="false">${face}</span>` : `<a ${attrs} href="${noteHref(n.id)}">${face}</a>`;
}
export const namedChip = (x: Named, opts: { box?: boolean } = {}) => (x.note ? noteMentionChip(x.note, opts) : x.ws ? wsMentionChip(x.ws, opts) : x.task ? taskMentionChip(x.task, opts) : x.group ? groupMentionChip(x.group, opts) : mentionChip({ ...x, p: x.p }, opts));
// Workspaces, tasks, groups and notes, named by their ids, as chips.
const wsMentions = (html: string, box = false) =>
  html
    .replace(WS_MENTION, (m, pre, id) => (wsNamed(id) ? pre + wsMentionChip(wsNamed(id), { box }) : m))
    .replace(TASK_MENTION, (m, pre, id) => (taskNamed(id) ? pre + taskMentionChip(taskNamed(id), { box }) : m))
    .replace(GROUP_MENTION, (m, pre, id) => (groupNamed(id) ? pre + groupMentionChip(groupNamed(id), { box }) : m))
    .replace(NOTE_MENTION, (m, pre, id) => (noteNamed(id) ? pre + noteMentionChip(noteNamed(id), { box }) : m));
// Escaped text with what it names as chips. `thread`: the thread it's in.
export const withMentions = (html: string, thread: string | null = null) =>
  wsMentions(
    html.replace(MENTION, (m, pre, pid, wid) => {
      const n = mentioned(pid, wid);
      return n ? pre + mentionChip(n, { thread }) : m;
    }),
  );
// What the @ list in a note offers to name, after the agents and threads: the pages (and, as you type, their widgets),
// your latest notes and your workspaces, each word the start of a word of its title or id.
export function mentionRows(q: string, open: string | null): Named[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (hay: string) => words.every((x) => new RegExp(`(^|[\\s_,(:/.-])${reEsc(x)}`).test(hay.toLowerCase()));
  const at = (p: PageRow & { moved?: string }) => p.moved || p.updated || "";
  const d = getApp().data;
  const pages = (d?.pages || []).filter((p) => !p.archived).sort((a, b) => Number(!!b.followed) - Number(!!a.followed) || at(b).localeCompare(at(a)));
  const rows: Named[] = [];
  for (const p of pages) {
    const ws = p.widgets || [];
    if (!words.length) rows.push({ p });
    else rows.push(...(hit(`${p.title} ${p.id}`) ? [{ p }] : []), ...ws.filter((w) => hit(`${w.title || ""} ${w.id} ${p.title}`)).map((w) => ({ p, w })));
  }
  const notes = (d?.notes || []).filter((n) => !n.archived && n.id !== open && (!words.length || hit(`${n.title} ${n.id} note`))).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const spaces = (d ? (workspaces() as (WorkspaceRow & { used: string })[]) : []).filter((w) => !words.length || hit(`${w.name} ${w.repo || ""} workspace`)).sort((a, b) => b.used.localeCompare(a.used));
  return [...rows.slice(0, 40), ...notes.slice(0, words.length ? 20 : 6).map((note) => ({ note })), ...spaces.slice(0, 20).map((ws) => ({ ws }))];
}
// A row's colour in the @ list.
export const namedStyle = (x: Named) => (x.ws || x.task || x.note ? "--hue:var(--ink-2);--tint:var(--well)" : x.group ? groupCss(x.group) : pageCss(x.p));

export const threadName = (s: Thread) => plainMentions(s.title || s.label || "A thread");
