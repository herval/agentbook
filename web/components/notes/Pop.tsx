// A note's menus, over the page as the old page put them (on the body): the toolbar over a selection in its words
// (bold, italic, struck out, code, a link, Comment), and the menu that's open: / for a block's kind, a block's own
// menu, @ for an agent, a thread or something to name, or an emoji. editor.tsx opens and fills them (the note's
// store's `tb` and `pop`); these draw them. Ported from the old page's noteTb, noteFmt (its link box) and nbDraw.
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { wsWhere } from "../../lib/agents.ts";
import { esc, plural, reEsc } from "../../lib/format.ts";
import { MachineChip } from "../../lib/mentions.tsx";
import { getApp } from "../../lib/store.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";
import { namedStyle, styleProp } from "./html.ts";
import { nbPick, noteCommentSel, noteFmt, noteLink } from "./editor.tsx";
import { useNote } from "./store.ts";
import type { PopItem } from "./store.ts";

export function NoteToolbar() {
  const tb = useNote((s) => s.tb);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tb) return;
    const r = tb.rect;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    el.style.top = `${Math.max(66, r.top - el.offsetHeight - 8)}px`;
  }, [tb]);
  if (!tb) return null;
  // A link for what's selected: Enter puts it in, Esc (or going elsewhere) leaves it.
  if (tb.link)
    return createPortal(
      <div className="nb-tb" role="toolbar" ref={ref}>
        <input
          type="url"
          placeholder="Paste a link, then Enter"
          aria-label="Link"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") e.preventDefault();
            if (e.key === "Escape") return noteLink(null);
            if (e.key === "Enter") noteLink(e.currentTarget.value.trim());
          }}
          onBlur={() => setTimeout(() => useNote.getState().tb?.link && noteLink(null), 150)}
        />
      </div>,
      document.body,
    );
  return createPortal(
    <div className="nb-tb" role="toolbar" ref={ref}>
      <button type="button" className="f-b" title="Bold (⌘B)" onClick={() => noteFmt("bold")}>
        B
      </button>
      <button type="button" className="f-i" title="Italic (⌘I)" onClick={() => noteFmt("italic")}>
        i
      </button>
      <button type="button" className="f-s" title="Strike" onClick={() => noteFmt("strikeThrough")}>
        S
      </button>
      {tb.cross ? null : (
        <>
          <button type="button" className="f-c" title="Code" onClick={() => noteFmt("code")}>
            {"</>"}
          </button>
          <button type="button" title="Link" onClick={() => noteFmt("link")}>
            <Icon name="link" />
          </button>
        </>
      )}
      <span className="sep"></span>
      <button type="button" title="Comment on it (⌘⇧M)" onClick={noteCommentSel}>
        <Icon name="comment" />
        Comment
      </button>
    </div>,
    document.body,
  );
}

const WIDGET_ICON: Record<string, string> = { metric: "bars", chart: "trend", table: "grid", list: "lines", tasks: "tasks", note: "lines", doc: "lines", link: "link", options: "lines" };
// The typed words of `q`, bold where they start a word of `s` (as HTML).
const boldWords = (q: string) => (s: string) => {
  let out = esc(s);
  for (const x of q.split(/\s+/).filter(Boolean)) out = out.replace(new RegExp(`(^|[\\s_,(:/.-])(${reEsc(esc(x))})`, "i"), "$1<b>$2</b>");
  return out;
};
function NamedRow({ x, q }: { x: PopItem; q: string }) {
  const bold = boldWords(q);
  const name = (s: string) => <span className="mp-name" dangerouslySetInnerHTML={{ __html: bold(s) }} />;
  const { p, w, ws, note } = x;
  if (note)
    return (
      <>
        <span className="mp-k mp-k--page">{note.emoji || "📄"}</span>
        <span className="mp-t">
          {name(note.title)}
          <small>
            Note{note.mine === false ? ` · @${note.owner_name}'s` : ""}
            {note.start ? ` · ${note.start}` : ""}
          </small>
        </span>
      </>
    );
  if (ws)
    return (
      <>
        <span className="mp-k">
          <Icon name={ws.repo ? "repo" : "folder"} />
        </span>
        <span className="mp-t">
          {name(ws.name)}
          <small>Workspace{wsWhere(ws) ? ` · ${wsWhere(ws).split("\n")[0]}` : ""}</small>
        </span>
      </>
    );
  return (
    <>
      {w ? (
        <span className="mp-k">
          <Icon name={(WIDGET_ICON[w.type] || "lines") as IconName} />
        </span>
      ) : (
        <span className="mp-k mp-k--page">{p.emoji || "📄"}</span>
      )}
      <span className="mp-t">
        {name(w ? w.title || w.id : p.title)}
        <small>
          {w ? (
            <>
              <span className="mp-pg">
                {p.emoji || "📄"} {p.title}
              </span>
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

export function NotePop() {
  const pop = useNote((s) => s.pop);
  const ref = useRef<HTMLDivElement>(null);
  const rect = pop?.rect;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !rect) return;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, rect.left))}px`;
    el.style.top = `${rect.bottom + 6 + h < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - h - 6)}px`;
  }, [rect]);
  useLayoutEffect(() => {
    ref.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
  }, [pop?.sel, pop?.items]);
  if (!pop) return null;
  const { kind, q, items, sel } = pop;
  // One row: an emoji, an agent or a thread to ask, something to name, a block's kind, or an action of a block's menu.
  const row = (x: PopItem, i: number) => {
    const on = i === sel ? " is-on" : "";
    const pick = () => nbPick(i);
    if (x.sep) return <div key={i} className="mp-sep"></div>;
    if (x.e)
      return (
        <button key={i} className={`nb-em${on}`} type="button" onClick={pick}>
          {x.e}
        </button>
      );
    if (x.a) {
      const at = x.a.machine || getApp().data?.machine;
      return (
        <button key={i} className={`mp-row${on}`} type="button" onClick={pick}>
          <span className="mp-k mp-k--av">
            <Avatar agent={x.a.id} />
          </span>
          <span className="mp-t">
            <span className="mp-line">
              <span className="mp-name">{x.a.name}</span>
              {at ? <MachineChip name={at} /> : null}
            </span>
            <small>A thread of its own</small>
          </span>
        </button>
      );
    }
    if (x.s)
      return (
        <button key={i} className={`mp-row${on}`} type="button" onClick={pick}>
          <span className="mp-k mp-k--av">
            <Avatar agent={x.s.agent} />
          </span>
          <span className="mp-t">
            <span className="mp-name">@{x.s.label}</span>
            <small>{x.s.title || ""}</small>
          </span>
        </button>
      );
    if (x.p || x.ws || x.note)
      return (
        <button key={i} className={`mp-row${on}`} type="button" style={styleProp(namedStyle(x))} onClick={pick}>
          <NamedRow x={x} q={q} />
        </button>
      );
    if (kind === "slash")
      return (
        <button key={i} className={`mp-row${on}`} type="button" onClick={pick}>
          <span className="mp-k mp-k--txt">{x.g}</span>
          <span className="mp-t">
            <span className="mp-name">{x.l}</span>
          </span>
        </button>
      );
    return (
      <button key={i} className={`mp-row${on}${x.red ? " is-red" : ""}`} type="button" onClick={pick}>
        <span className="mp-k mp-k--txt">{x.k}</span>
        <span className="mp-t">
          <span className="mp-name">{x.l}</span>
        </span>
      </button>
    );
  };
  const head = kind === "slash" ? <div className="mp-h">{q ? `Blocks matching “${q}”` : "Blocks"}</div> : kind === "at" ? <div className="mp-h">{q ? `Matching “${q}”` : "Ask an agent or a thread, or name a note, a page or a workspace"}</div> : null;
  const empty = kind === "at" ? "No agent, thread, note, page or workspace of yours matches. Claude Code and Codex agents can work on notes." : "Nothing matches.";
  const cls = ["nb-pop", kind === "emoji" ? "is-emoji" : "", kind === "at" ? "is-at" : ""].filter(Boolean).join(" ");
  return createPortal(
    <div className={cls} role="listbox" ref={ref}>
      {head}
      <div className="mp-rows">{items.length ? items.map(row) : <p className="mp-none">{empty}</p>}</div>
    </div>,
    document.body,
  );
}
