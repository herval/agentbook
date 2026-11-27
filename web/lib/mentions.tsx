/* ---------- mentions: naming a page, or one of its widgets, in a message ---------- */
// What a message names, and how it shows: "@page", "@page/widget", "@ws:<id>", "@task:<id>", "@group:<id>" and
// "@note:<id>" as chips, an agent of a thread's conversation ("@Codex") as one, and another thread named by its name
// ("petrel's branch brings 7 back") as a link to it. They register with <Markdown> (and <Plain>, thread/Plain.tsx) at
// import time (registerInline, lib/markdown.ts); MsgBox imports this file, so they're registered wherever a box is.
// The box's own chips are HTML (a contenteditable box holds HTML, not React): chipHtml and guestChipHtml.
// Ported from the old page (app.ts's mentions section, and "another thread, named in a message").
import type React from "react";
import { agentName, workspaces, wsWhere } from "./agents.ts";
import { esc, groupCss, groupStyle, hue, hueCss, hueVars, pageCss, pageStyle, plural, reEsc } from "./format.ts";
import { registerInline } from "./markdown.ts";
import type { MdContext } from "./markdown.ts";
import { groupHref, noteHref, threadHref, taskHref, workspaceHref } from "./route.ts";
import { agentOf, allRows, getApp, threadRow, useApp } from "./store.ts";
import type { GroupRow, NameRef, NoteRow, PageData, PageRow, TaskRow, Thread, Widget, WorkspaceRow } from "./types.ts";
import { Avatar } from "../components/Avatar.tsx";
import { Icon } from "../components/Icon.tsx";
import type { IconName } from "../components/Icon.tsx";

// "@page" or "@page/widget", by their ids, as the server reads them (server/mentions.mjs). A token is a chip only
// if it names a page you can see (and a widget on it), so an npm scope, a person or an email address stays text.
export const MENTION = /(^|[\s(>*_~])@(?!(?:ws|task|group|note):)([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_.-]*[A-Za-z0-9_]))?(?![\w/-])/g;
// "@ws:<id>", one of your workspaces, by its id (names change), never a page's.
export const WS_MENTION = /(^|[\s(>*_~])@ws:([a-z0-9]+)(?![\w/-])/g;
// "@task:<id>", one of your tasks, and "@group:<id>", one of your groups: a thread you @ one in goes on it, or in it.
export const TASK_MENTION = /(^|[\s(>*_~])@task:([a-z0-9]+)(?![\w/-])/g;
export const GROUP_MENTION = /(^|[\s(>*_~])@group:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;
// "@note:<id>", one of your notes: its agent is told what it is, and the thread shows on the note.
export const NOTE_MENTION = /(^|[\s(>*_~])@note:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;
// Text in an HTML attribute, its line breaks too (a workspace's title has its places on lines of their own), so the box's
// text's own breaks, made <br>s, leave them be.
const escAttr = (s: unknown): string => esc(s).replace(/\n/g, "&#10;");
const iconHtml = (name: IconName) => `<svg class="i"><use href="#i-${name}"/></svg>`;

/* ---------- colours ---------- */


/* ---------- what a token names ---------- */

// A workspace as workspaces() (lib/agents.ts) has it: with its checkouts and when it was last worked in.
export type WorkspaceSeen = WorkspaceRow & { checkouts?: unknown[]; used?: string };
// What a token names: { p } a page, { p, w } a widget on it, { p, gone } a widget that's no longer on it.
export interface Named {
  p: PageRow;
  w?: Widget;
  gone?: string;
}
// What a token names, or null.
export function mentioned(pid: string, wid?: string | null, data: PageData | null = getApp().data): Named | null {
  const p = (data?.pages || []).find((x) => x.id === pid);
  if (!p) return null;
  if (!wid) return { p };
  const w = (p.widgets || []).find((x) => x.id === wid);
  return w ? { p, w } : { p, gone: wid };
}
export const mentionRef = (n: Named) => (n.w ? `${n.p.id}/${n.w.id}` : n.gone ? `${n.p.id}/${n.gone}` : n.p.id);
// Where a chip goes: the page, at the widget, with the thread it's in beside it when that thread is on the page.
export function mentionHref(n: Named, thread: string | null) {
  const w = n.w ? `?w=${encodeURIComponent(n.w.id)}` : "";
  const id = encodeURIComponent(n.p.id);
  return thread && threadRow(thread)?.page === n.p.id ? `#/pages/${id}/threads/${encodeURIComponent(thread)}${w}` : `#/pages/${id}${w}`;
}
// A workspace a token names: one of yours, or null.
export const wsNamed = (id: string): WorkspaceSeen | null => (getApp().data ? (workspaces() as WorkspaceSeen[]).find((w) => w.id === id) : null) || null;
// A task a token names: one of yours (your Tasks, or a thread's to-do), or null. A group: one you see, or null.
export const taskNamed = (id: string): TaskRow | null => {
  const d = getApp().data;
  return (d && ((d.tasks || []).find((t) => t.id === id) || (d.todos || []).find((t) => t.id === id))) || null;
};
export const groupNamed = (id: string): GroupRow | null => (getApp().data?.groups || []).find((g) => g.id === id) || null;
// A note a token names: one you see, or null.
export const noteNamed = (id: string): NoteRow | null => (getApp().data?.notes || []).find((n) => n.id === id) || null;

/* ---------- chips: in a message, links; in a box, pieces of the text that delete whole ---------- */

// A chip: the page's emoji and the widget's (or the page's) title, in the page's color. In a message it's a link.
export function MentionChip({ n, thread = null }: { n: Named; thread?: string | null }) {
  const tip = n.gone ? `No longer on ${n.p.title}` : n.w ? `${n.w.title || n.w.id} (${n.w.id}), on ${n.p.title}` : `The page ${n.p.title}`;
  const face = n.gone ? (
    `@${n.gone}`
  ) : (
    <>
      <span className="mchip-em">{n.p.emoji || "📄"}</span>
      <span className="mchip-t">{n.w ? n.w.title || n.w.id : n.p.title}</span>
    </>
  );
  const cls = `mchip${n.gone ? " mchip--gone" : ""}`;
  return n.gone ? (
    <span className={cls} data-ref={mentionRef(n)} style={pageStyle(n.p)} title={tip}>
      {face}
    </span>
  ) : (
    <a className={cls} data-ref={mentionRef(n)} style={pageStyle(n.p)} title={tip} href={mentionHref(n, thread)}>
      {face}
    </a>
  );
}
export function WsChip({ w }: { w: WorkspaceSeen }) {
  return (
    <a className="mchip mchip--ws" data-ref={`ws:${w.id}`} title={`The workspace ${w.name}\n${wsWhere(w)}`} href={workspaceHref(w.id)}>
      <Icon name={w.repo ? "repo" : "folder"} />
      <span className="mchip-t">{w.name}</span>
    </a>
  );
}
export function TaskChip({ t }: { t: TaskRow }) {
  return (
    <a className={`mchip mchip--task${t.done ? " is-done" : ""}`} data-ref={`task:${t.id}`} title={`The task ${t.text}${t.done ? " (done)" : ""}`} href={taskHref(t)}>
      <Icon name="tasks" />
      <span className="mchip-t">{t.text}</span>
    </a>
  );
}
export function GroupChip({ g }: { g: GroupRow }) {
  return (
    <a className="mchip mchip--group" data-ref={`group:${g.id}`} style={groupStyle(g)} title={`The group ${g.name}`} href={groupHref(g)}>
      <span className="mchip-em">{g.emoji || "👥"}</span>
      <span className="mchip-t">{g.name}</span>
    </a>
  );
}
export function NoteChip({ n }: { n: NoteRow }) {
  return (
    <a className="mchip mchip--note" data-ref={`note:${n.id}`} title={`The note ${n.title}`} href={noteHref(n.id)}>
      <span className="mchip-em">{n.emoji || "📄"}</span>
      <span className="mchip-t">{n.title}</span>
    </a>
  );
}
// The chip for a row of the @ list (mentionRows): a widget or a page, a note, a workspace, a task or a group.
export function NamedChip({ x, thread = null }: { x: NamedPick; thread?: string | null }) {
  if (x.note) return <NoteChip n={x.note} />;
  if (x.ws) return <WsChip w={x.ws} />;
  if (x.task) return <TaskChip t={x.task} />;
  if (x.group) return <GroupChip g={x.group} />;
  return x.p ? <MentionChip n={{ p: x.p, w: x.w, gone: x.gone }} thread={thread} /> : null;
}

// The same chips in a box, as HTML: a piece of the text that deletes whole, its token in `data-ref`.
export function chipHtml(x: NamedPick): string {
  if (x.note) return `<span class="mchip mchip--note" data-ref="note:${esc(x.note.id)}" title="${escAttr(`The note ${x.note.title}`)}" contenteditable="false"><span class="mchip-em">${esc(x.note.emoji || "📄")}</span><span class="mchip-t">${esc(x.note.title)}</span></span>`;
  if (x.ws) return `<span class="mchip mchip--ws" data-ref="ws:${esc(x.ws.id)}" title="${escAttr(`The workspace ${x.ws.name}\n${wsWhere(x.ws)}`)}" contenteditable="false">${iconHtml(x.ws.repo ? "repo" : "folder")}<span class="mchip-t">${esc(x.ws.name)}</span></span>`;
  if (x.task) return `<span class="mchip mchip--task${x.task.done ? " is-done" : ""}" data-ref="task:${esc(x.task.id)}" title="${escAttr(`The task ${x.task.text}${x.task.done ? " (done)" : ""}`)}" contenteditable="false">${iconHtml("tasks")}<span class="mchip-t">${esc(x.task.text)}</span></span>`;
  if (x.group) return `<span class="mchip mchip--group" data-ref="group:${esc(x.group.id)}" style="${groupCss(x.group)}" title="${escAttr(`The group ${x.group.name}`)}" contenteditable="false"><span class="mchip-em">${esc(x.group.emoji || "👥")}</span><span class="mchip-t">${esc(x.group.name)}</span></span>`;
  const n: Named = { p: x.p, w: x.w, gone: x.gone };
  const tip = n.gone ? `No longer on ${n.p.title}` : n.w ? `${n.w.title || n.w.id} (${n.w.id}), on ${n.p.title}` : `The page ${n.p.title}`;
  const face = n.gone ? `@${esc(n.gone)}` : `<span class="mchip-em">${esc(n.p.emoji || "📄")}</span><span class="mchip-t">${esc(n.w ? n.w.title || n.w.id : n.p.title)}</span>`;
  return `<span class="mchip${n.gone ? " mchip--gone" : ""}" data-ref="${esc(mentionRef(n))}" style="${pageCss(n.p)}" title="${escAttr(tip)}" contenteditable="false">${face}</span>`;
}
// An agent named in a box: a chip that sends what you write to it (`to`: "thread:<id>", "agent:<id>" or "join:<id>").
export const guestChipHtml = (r: AgentPick) => `<span class="mchip" contenteditable="false" data-to="${esc(r.to)}" style="${hueCss(r.agent)}">@${esc(r.name)}</span>`;
// Workspaces, tasks, groups and notes, named by their ids, as box chips, in escaped text.
export const wsMentionsHtml = (html: string) =>
  html
    .replace(WS_MENTION, (m: string, pre: string, id: string) => (wsNamed(id) ? pre + chipHtml({ ws: wsNamed(id) }) : m))
    .replace(TASK_MENTION, (m: string, pre: string, id: string) => (taskNamed(id) ? pre + chipHtml({ task: taskNamed(id) }) : m))
    .replace(GROUP_MENTION, (m: string, pre: string, id: string) => (groupNamed(id) ? pre + chipHtml({ group: groupNamed(id) }) : m))
    .replace(NOTE_MENTION, (m: string, pre: string, id: string) => (noteNamed(id) ? pre + chipHtml({ note: noteNamed(id) }) : m));
/* A message box (components/MsgBox.tsx) is contenteditable, so a page or a widget you name shows as a chip, and it
   keeps a textarea's ways: its text is the chips as their tokens, and setting it makes the chips again, so drafts,
   sending and clearing work as they do for a textarea. */
// Text as a box holds it: escaped, what it names as chips, its lines as <br>s.
export function boxHtml(text: string | null | undefined): string {
  const t = String(text ?? "");
  const html = wsMentionsHtml(
    esc(t).replace(MENTION, (m: string, pre: string, pid: string, wid: string) => {
      const n = mentioned(pid, wid);
      return n && !n.gone ? pre + chipHtml(n) : m;
    }),
  );
  return html.replace(/\n/g, "<br>") + (t.endsWith("\n") ? "<br>" : "");
}

// Text with what it names in words, for where a chip can't go (a title, a link): "why did p95 latency jump?".
export const plainMentions = (text: string | null | undefined) =>
  String(text || "")
    .replace(MENTION, (m: string, pre: string, pid: string, wid: string) => {
      const n = mentioned(pid, wid);
      return n && !n.gone ? pre + (n.w ? n.w.title || n.w.id : n.p.title) : m;
    })
    .replace(WS_MENTION, (m: string, pre: string, id: string) => (wsNamed(id) ? pre + wsNamed(id).name : m))
    .replace(TASK_MENTION, (m: string, pre: string, id: string) => (taskNamed(id) ? pre + taskNamed(id).text : m))
    .replace(GROUP_MENTION, (m: string, pre: string, id: string) => (groupNamed(id) ? pre + groupNamed(id).name : m))
    .replace(NOTE_MENTION, (m: string, pre: string, id: string) => (noteNamed(id) ? pre + noteNamed(id).title : m));

/* ---------- the @ list (bar/mention-pop.tsx draws it) ---------- */

// A row of the @ list that names something: a widget or a page, a note, a workspace, a task or a group.
export interface NamedPick {
  p?: PageRow;
  w?: Widget;
  gone?: string;
  ws?: WorkspaceSeen;
  task?: TaskRow;
  group?: GroupRow;
  note?: NoteRow;
}
// A row that names an agent (a thread's guests): who's in the thread ("in"), who it can
// bring in ("bring"), or a thread of yours that's running, which joins as it is ("join"). `to` is who what you write
// goes to; `sub` what it is there; `hay` the words typing finds it by.
export interface AgentPick {
  kind: "in" | "bring" | "join";
  to: string;
  agent: string | null;
  name: string;
  sub: string;
  hay?: string;
  machine?: string | null;
}
export type MentionRow = NamedPick | AgentPick;
export const isAgentPick = (x: MentionRow | null | undefined): x is AgentPick => !!x && "to" in x && !!x.to;
export const WIDGET_ICON: Record<string, IconName> = { metric: "bars", chart: "trend", table: "grid", list: "lines", tasks: "tasks", note: "lines", doc: "lines", link: "link", options: "lines" };
// What else the list holds: `links`, a box that can put its thread in a group or on a task by naming them (canLink:
// the composer, or a thread's reply box, not a thread of yours); `agents`, the agents it can name, for the typed words.
export interface MentionOpts {
  links?: boolean;
  agents?: ((words: string[]) => AgentPick[]) | null;
}

/* @ in a box: a list of what it can name, just above it. Pages and their widgets, page by page: the box's page
   first, then the pages you follow, the latest changed first, then the rest; then your notes, the latest changed
   first; then, in a box that starts or is a thread, your groups and your open tasks, which the thread goes in or on
   (linkHint); then your workspaces, the latest worked in first. With only @ typed, the box's page's widgets, the other
   pages, your latest notes, the groups, your first tasks and the workspaces; typing narrows it to the ones that match, each word the start of a word of the title,
   the id or the page's title (a workspace's name or repo, a group's name). ↑ ↓ move, Enter or Tab picks, Esc
   closes. */
export function mentionRows(q: string, here: string | null, opts: MentionOpts = {}): MentionRow[] {
  const app = getApp();
  const data = app.data;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (hay: string) => words.every((x) => new RegExp(`(^|[\\s_,(:/.-])${reEsc(x)}`).test(hay.toLowerCase()));
  const at = (p: PageRow) => p.moved || p.updated || "";
  const pages = (data?.pages || []).filter((p) => !p.archived).sort((a, b) => Number(b.id === here) - Number(a.id === here) || Number(!!b.followed) - Number(!!a.followed) || at(b).localeCompare(at(a)));
  const rows: NamedPick[] = [];
  for (const p of pages) {
    const ws = p.widgets || [];
    if (!words.length) rows.push(...(p.id === here ? ws.map((w) => ({ p, w })) : [{ p }]));
    else rows.push(...(hit(`${p.title} ${p.id}`) ? [{ p }] : []), ...ws.filter((w) => hit(`${w.title || ""} ${w.id} ${p.title}`)).map((w) => ({ p, w })));
  }
  const open = app.route?.name === "note" ? app.route.id : null;
  const notes = (data?.notes || []).filter((n) => !n.archived && n.id !== open && (!words.length || hit(`${n.title} ${n.id} note`))).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const spaces = (data ? (workspaces() as WorkspaceSeen[]) : []).filter((w) => !words.length || hit(`${w.name} ${w.repo || ""} workspace`)).sort((a, b) => (b.used || "").localeCompare(a.used || ""));
  // A thread's groups and tasks: not in a thread of yours, whose agents each have their own.
  const groups = (data?.groups || []).filter((g) => !g.archived && (g.mine !== false || !!(g as GroupRow & { in?: boolean }).in)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const tasks = (data?.tasks || []).filter((t) => !t.done).sort((a, b) => a.rank - b.rank);
  const links: NamedPick[] =
    data && opts.links
      ? [
          ...groups
            .filter((g) => !words.length || hit(`${g.name} ${g.id} group`))
            .slice(0, 12)
            .map((group) => ({ group })),
          ...tasks
            .filter((t) => !t.scope && (!words.length || hit(`${t.text} task`)))
            .slice(0, words.length ? 20 : 8)
            .map((task) => ({ task })),
        ]
      : [];
  const agents = (opts.agents ? opts.agents(words) : []).filter((r) => !r.hay || hit(r.hay));
  return [...agents, ...rows.slice(0, 40), ...notes.slice(0, words.length ? 20 : 6).map((note) => ({ note })), ...links, ...spaces.slice(0, 20).map((ws) => ({ ws }))];
}
export const namedStyle = (x: MentionRow): React.CSSProperties => (isAgentPick(x) ? hueVars(x.agent) : x.ws || x.task || x.note ? ({ "--hue": "var(--ink-2)", "--tint": "var(--well)" } as React.CSSProperties) : x.group ? groupStyle(x.group) : pageStyle(x.p));
// `s`, with the typed words of `q` bold where they start a word of it.
export function Bold({ q, s }: { q: string; s: string }) {
  const text = String(s ?? "");
  const on: [number, number][] = [];
  for (const x of q.split(/\s+/).filter(Boolean)) {
    const m = new RegExp(`(^|[\\s_,(:/.-])(${reEsc(x)})`, "i").exec(text);
    if (!m) continue;
    const from = m.index + m[1].length;
    const to = from + m[2].length;
    if (!on.some(([a, b]) => from < b && to > a)) on.push([from, to]);
  }
  if (!on.length) return <>{text}</>;
  on.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const [a, b] of on) {
    if (a > last) out.push(text.slice(last, a));
    out.push(<b key={a}>{text.slice(a, b)}</b>);
    last = b;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
// The machine an agent runs on, by its name in the @ list: two agents can share a name, one on each machine.
export const MachineChip = ({ name, q = "" }: { name: string; q?: string }) => (
  <span className="chip mp-mach" title={`On ${name}`}>
    <Icon name="laptop" />
    <span>
      <Bold q={q} s={name} />
    </span>
  </span>
);
// A row of the @ list, inside its button: a widget, a page, a note, a group, a task, a workspace, or an agent.
// `here`: the box's page; `q`: the typed words, bold.
export function NamedRow({ x, here, q }: { x: MentionRow; here: string | null; q: string }) {
  if (isAgentPick(x))
    return (
      <>
        <span className="mp-k mp-k--av">
          <Avatar agent={x.agent} size="av--xs" />
        </span>
        <span className="mp-t">
          <span className="mp-line">
            <span className="mp-name">
              <Bold q={q} s={x.name} />
            </span>
            {x.machine ? <MachineChip name={x.machine} q={q} /> : null}
          </span>
          <small>
            <span className="mp-sub">{x.sub}</span>
          </small>
        </span>
      </>
    );
  const { p, w, ws, task, group, note } = x;
  if (note)
    return (
      <>
        <span className="mp-k mp-k--page">{note.emoji || "📄"}</span>
        <span className="mp-t">
          <span className="mp-name">
            <Bold q={q} s={note.title} />
          </span>
          <small>{`Note${note.mine === false ? ` · @${note.owner_name}'s` : ""}${note.start ? ` · ${note.start}` : ""}`}</small>
        </span>
      </>
    );
  if (group)
    return (
      <>
        <span className="mp-k mp-k--page">{group.emoji || "👥"}</span>
        <span className="mp-t">
          <span className="mp-name">
            <Bold q={q} s={group.name} />
          </span>
          <small>
            Group · <code>{group.id}</code> · {plural(allRows().filter((s) => s.group === group.id).length, "thread")}
          </small>
        </span>
      </>
    );
  if (task) {
    const g = task.group ? groupNamed(task.group) : null;
    const pages = (Array.isArray(task.pages) ? task.pages.map((e) => e.page) : task.page ? [task.page] : []).map((id) => mentioned(id)?.p).filter(Boolean);
    return (
      <>
        <span className="mp-k">
          <Icon name="tasks" />
        </span>
        <span className="mp-t">
          <span className="mp-name">
            <Bold q={q} s={task.text} />
          </span>
          <small>{`Task${g ? ` · ${g.name}` : ""}${pages.map((pg) => ` · ${pg.title}`).join("")}`}</small>
        </span>
      </>
    );
  }
  if (ws) {
    const where = wsWhere(ws);
    return (
      <>
        <span className="mp-k">
          <Icon name={ws.repo ? "repo" : "folder"} />
        </span>
        <span className="mp-t">
          <span className="mp-name">
            <Bold q={q} s={ws.name} />
          </span>
          <small>{`Workspace${where ? ` · ${where.split("\n")[0]}` : ""}`}</small>
        </span>
      </>
    );
  }
  return (
    <>
      {w ? (
        <span className="mp-k">
          <Icon name={WIDGET_ICON[w.type] || "lines"} />
        </span>
      ) : (
        <span className="mp-k mp-k--page">{p.emoji || "📄"}</span>
      )}
      <span className="mp-t">
        <span className="mp-name">
          <Bold q={q} s={w ? w.title || w.id : p.title} />
        </span>
        <small>
          {w ? (
            <>
              {p.id === here ? null : (
                <span className="mp-pg">
                  {p.emoji || "📄"} {p.title}
                </span>
              )}
              <code>{w.id}</code>
            </>
          ) : (
            <>
              Page · <code>{p.id}</code> · {plural((p.widgets || []).length, "widget")}
            </>
          )}
        </small>
      </span>
    </>
  );
}

/* ---------- another thread, named in a message ---------- */
// Agents name each other's threads by their names ("petrel's branch brings 7 back"). In a thread's messages, a
// name is a link to the thread by that name that was around at the same time: names repeat over time (there
// are 24 birds), and agentbook gives a new thread a name no other open thread has (freeName in store.ts). If two
// fit, the one in the same project, then the one still open, then the latest.
// The server works out which (server/names.ts) and sends them with the thread: a card, the names its words use; a
// thread's page, every name around it.

// A thread a name stands for, as the server sends it (names.ts's NameRef).
export type { NameRef };
// A thread's record as the page has it, with what the server sent around it: the open one, a card in the feed, a row.
function recOf(id: string | null | undefined): (Thread & { names?: Record<string, NameRef | string> }) | null {
  if (!id) return null;
  const app = getApp();
  const open = app.open?.id === id ? app.open.detail : null;
  const card = app.feed?.records[`thread:${id}`] as Thread | undefined;
  return (open as Thread) || card || threadRow(id) || null;
}
const nearby = new WeakMap<object, { names: Map<string, NameRef>; re: RegExp | null }>(); // names it came with -> them, with the pattern that finds them
// The names a thread's words may use (`from`: its id), and the pattern that finds them; null when it has none.
export function namesNear(from: string | null | undefined): { names: Map<string, NameRef>; re: RegExp | null } | null {
  const app = getApp();
  const open = from && app.open?.id === from ? (app.open.detail as { names?: Record<string, NameRef | string> }) : null;
  const card = from ? (app.feed?.records[`thread:${from}`] as { names?: Record<string, NameRef | string> }) : null;
  const got = open?.names || card?.names || recOf(from)?.names;
  if (!got || typeof got !== "object") return null;
  let near = nearby.get(got);
  if (near) return near;
  const names = new Map<string, NameRef>();
  for (const [name, v] of Object.entries(got)) {
    if (v && typeof v === "object") names.set(name, v);
    else if (typeof v === "string") {
      const r = threadRow(v);
      names.set(name, { id: v, agent: r?.agent ?? null, label: r?.label || name, title: r?.title || "" });
    }
  }
  const re = names.size ? new RegExp(`(^|[^\\w/.@-])(${[...names.keys()].sort((a, b) => b.length - a.length).map(reEsc).join("|")})(?![\\w/-])`, "g") : null;
  near = { names, re };
  nearby.set(got, near);
  return near;
}
// The pattern that finds them in a thread's words, or null.
export const threadNames = (from: string | null | undefined): RegExp | null => namesNear(from)?.re || null;
export function ThreadLink({ s, name }: { s: NameRef; name: string }) {
  return (
    <a className="md-link md-thread" href={threadHref(s.id)} style={hueVars(s.agent)} title={`${s.label} (${agentName(s.agent) || s.agent}): ${s.title || ""}`}>
      {name}
    </a>
  );
}

/* ---------- the agents of a thread's conversation, named in a message of yours ---------- */

type Guest = Thread & { removed?: string | null };
const guestsOn = (s: Thread): Guest[] => ((s.guests || []) as Guest[]).filter((g) => !g.removed);
// Who's in a thread's conversation: its own agent first, then its guests, each by its agent's name, or by its thread's
// when two of them are the same agent.
function together(s: Thread): { id: string; agent: string | null; label: string; name: string }[] {
  // A thread of yours has no agent of its own: only its guests.
  const all = [...(s.talk ? [] : [{ id: s.id, agent: s.agent, label: s.label }]), ...guestsOn(s).filter((g) => g.label)];
  return all.map((x) => ({ id: x.id, agent: x.agent, label: x.label, name: all.filter((y) => y.agent === x.agent).length > 1 ? x.label : agentOf(x.agent).name }));
}
const withAgentsMemo = new WeakMap<object, { re: RegExp; by: Map<string, string | null> }>();
// The agents a message of yours names in a thread's conversation (`from`: its id), by the names @ gives them: the
// pattern that finds them, and each one's agent. Null for a thread with no guests.
export function agentNamesIn(from: string | null | undefined): { re: RegExp; by: Map<string, string | null> } | null {
  const s = recOf(from);
  if (!s?.guests?.length) return null;
  const was = withAgentsMemo.get(s);
  if (was) return was;
  const names = [...together(s), ...(s.guests || []).filter((g) => g.label).map((g) => ({ agent: g.agent, name: g.label })), ...(s.guests || []).map((g) => ({ agent: g.agent, name: agentOf(g.agent).name }))].filter((x) => x.name).sort((a, b) => b.name.length - a.name.length);
  const by = new Map<string, string | null>();
  for (const x of names) if (!by.has(x.name)) by.set(x.name, x.agent);
  const out = { re: new RegExp(`(^|[\\s(])@(${[...by.keys()].map(reEsc).join("|")})(?![\\w-])`, "g"), by };
  withAgentsMemo.set(s, out);
  return out;
}

/* ---------- what <Markdown> and <Plain> draw of them ---------- */

// A token, drawn live: as the chrome changes (a page renamed, a widget gone), so does its chip; once it names nothing,
// it's its text again.
function PageToken({ pid, wid, thread, text }: { pid: string; wid?: string; thread: string | null; text: string }) {
  const data = useApp((s) => s.data);
  const n = mentioned(pid, wid, data);
  return n ? <MentionChip n={n} thread={thread} /> : <>{text}</>;
}
function IdToken({ kind, id, text }: { kind: "ws" | "task" | "group" | "note"; id: string; text: string }) {
  useApp((s) => s.data);
  const x: NamedPick | null = kind === "ws" ? (wsNamed(id) ? { ws: wsNamed(id) } : null) : kind === "task" ? (taskNamed(id) ? { task: taskNamed(id) } : null) : kind === "group" ? (groupNamed(id) ? { group: groupNamed(id) } : null) : noteNamed(id) ? { note: noteNamed(id) } : null;
  return x ? <NamedChip x={x} /> : <>{text}</>;
}
// The token's own text, without what came before it.
const tokenText = (m: RegExpExecArray) => m[0].slice((m[1] || "").length);
// Where a chip in a message goes beside: the thread it's in.
const threadOf = (cx: MdContext) => cx.peek || cx.from || null;

registerInline({ name: "mention", re: () => MENTION, render: (m, cx) => (mentioned(m[2], m[3]) ? <PageToken pid={m[2]} wid={m[3]} thread={threadOf(cx)} text={tokenText(m)} /> : null) });
registerInline({ name: "ws-mention", re: () => WS_MENTION, render: (m) => (wsNamed(m[2]) ? <IdToken kind="ws" id={m[2]} text={tokenText(m)} /> : null) });
registerInline({ name: "task-mention", re: () => TASK_MENTION, render: (m) => (taskNamed(m[2]) ? <IdToken kind="task" id={m[2]} text={tokenText(m)} /> : null) });
registerInline({ name: "group-mention", re: () => GROUP_MENTION, render: (m) => (groupNamed(m[2]) ? <IdToken kind="group" id={m[2]} text={tokenText(m)} /> : null) });
registerInline({ name: "note-mention", re: () => NOTE_MENTION, render: (m) => (noteNamed(m[2]) ? <IdToken kind="note" id={m[2]} text={tokenText(m)} /> : null) });
registerInline({
  name: "thread-name",
  re: (cx) => threadNames(cx.from),
  render: (m, cx) => {
    const s = namesNear(cx.from)?.names.get(m[2]);
    return s ? <ThreadLink s={s} name={m[2]} /> : null;
  },
});
registerInline({
  name: "agent-mention",
  re: (cx) => agentNamesIn(cx.from)?.re || null,
  render: (m, cx) => {
    const by = agentNamesIn(cx.from)?.by;
    return by?.has(m[2]) ? (
      <span className="mchip" style={hueVars(by.get(m[2]))}>
        @{m[2]}
      </span>
    ) : null;
  },
});
