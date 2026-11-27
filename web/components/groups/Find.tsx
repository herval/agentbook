/* A group's find boxes: Add a task finds your other open tasks as you type, and Add a WIP your branches and pull
   requests, each word the start of a word of one, each with the group it's in now (a task or a WIP is in one group
   at most, so picking one takes it out of that one). ↓ on an empty box shows them all; Add a WIP shows them as you
   click into it, since there's nothing new to add there. ↑ ↓ move, Enter or a click puts the picked one in the group,
   Esc closes the list. Enter with none picked adds what's typed as a new task, or picks the first WIP found.
   Ported from the old page's FINDS, findDraw, findPlace, findClose, findPick and their listeners. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { post } from "../../lib/api.ts";
import { toast } from "../../lib/toast.ts";
import type { TaskRow } from "../../lib/types.ts";
import { openTasks, taskMovedText } from "../tasks/tasks.ts";
import { wipWhy, wipWsName } from "../worktrees/wips.ts";
import type { Wip } from "../worktrees/wips.ts";
import { groupById, groupWipPut, wipsToAdd, wipWhere } from "./groups.ts";
import { WipDot } from "./parts.tsx";
import { reEsc } from "../../lib/format.ts";

const wordStarts = (words: string[], flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}])(${words.map(reEsc).join("|")})`, flags);
type Marked = (s: string) => ReactNode;
// What each box finds: the rows it can find (in the group `gid`), their words, their titles, a row, the list's head,
// what it says when nothing's called that, and what picking one does.
interface FindKind<T> {
  open?: boolean;
  rows: (gid: string) => T[];
  text: (x: T) => string;
  title: (x: T) => string;
  row: (x: T, marked: Marked) => ReactNode;
  head: (q: string) => string;
  none?: string;
  pick: (gid: string, x: T) => Promise<void> | void;
}
const FIND_TASK: FindKind<TaskRow> = {
  rows: (gid) => openTasks().filter((t) => t.group !== gid),
  text: (t) => t.text,
  title: (t) => t.text,
  row: (t, marked) => (
    <span className="fb-t">
      <span className="fb-nm">{marked(t.text)}</span>
      {t.group && groupById(t.group) ? <span className="fb-n">in {groupById(t.group).name}</span> : null}
    </span>
  ),
  head: (q) => (q ? "Or put one of yours in it" : "Put one of yours in it"),
  pick: async (gid, t) => {
    if ((await post(`/api/tasks/${encodeURIComponent(t.id)}`, { group: gid })).ok) toast(taskMovedText(t, gid));
  },
};
const FIND_WIP: FindKind<Wip> = {
  open: true,
  rows: (gid) => wipsToAdd(groupById(gid)),
  text: (x) => `${x.title} ${x.branch} ${x.kind === "pr" ? `#${x.number}` : ""} ${wipWsName(x)}`,
  title: (x) => wipWhy(x),
  row: (x, marked) => (
    <>
      <WipDot w={x} />
      <span className="fb-t">
        <span className="fb-nm">{marked(x.title)}</span>
        <span className="fb-n">{wipWhere(x)}</span>
      </span>
    </>
  ),
  head: () => "Your branches and pull requests",
  none: "No other branch or pull request of yours is called that.",
  pick: (gid, x) => groupWipPut(groupById(gid), x),
};
export const FINDS = { task: FIND_TASK, wip: FIND_WIP };

// The box: its form (`className`), what's typed in it (`value`, `setValue`: Add a task's draft), what's before it,
// and, for Add a task, what Enter does with none picked (`onAdd`). Add a WIP never sends.
export function FindBox({ kind, gid, className, placeholder, label, listLabel, value, setValue, onAdd, onEscape, before }: { kind: "task" | "wip"; gid: string; className: string; placeholder: string; label: string; listLabel: string; value: string; setValue: (v: string) => void; onAdd?: () => void; onEscape?: () => void; before: ReactNode }) {
  const k = FINDS[kind] as FindKind<TaskRow | Wip>;
  const [find, setFind] = useState<{ rows: (TaskRow | Wip)[]; sel: number; q: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The list as what's typed finds it (`all`: every one, with nothing typed), with `sel` picked.
  const draw = (all = false, sel = -1, typed = input.current?.value || "") => {
    const q = typed.trim();
    const words = q.split(/\s+/).filter(Boolean);
    const res = words.map((w) => wordStarts([w]));
    const rows = q || all ? k.rows(gid).filter((x) => res.every((re) => re.test(k.text(x)))).slice(0, 60) : [];
    setFind(rows.length || (q && k.none) ? { rows, sel: Math.min(sel, rows.length - 1), q } : null);
  };
  const close = () => setFind(null);
  // The right column scrolls in a box of its own, which would cut the list off at its foot, so the list sits over the
  // page, under the box and as wide as it (above it where there's more room there), and follows it as the page
  // scrolls. With the box scrolled out of sight, it closes.
  useLayoutEffect(() => {
    if (!find) return;
    const place = () => {
      const el = list.current;
      const f = form.current;
      if (!el || !f) return;
      const r = f.getBoundingClientRect();
      const bar = document.querySelector(".top")?.getBoundingClientRect().bottom || 0;
      if (r.bottom < bar || r.top > innerHeight) return close();
      const below = innerHeight - r.bottom - 8;
      const up = below < 200 && r.top - bar - 8 > below;
      Object.assign(el.style, { left: `${r.left}px`, width: `${r.width}px`, top: up ? "auto" : `${r.bottom + 2}px`, bottom: up ? `${innerHeight - r.top + 2}px` : "auto" });
      const fl = el.querySelector<HTMLElement>(".fb-list");
      if (fl) fl.style.maxHeight = `${Math.max(100, Math.min(340, (up ? r.top - bar - 8 : below) - 48))}px`;
      el.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
    };
    place();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, [find]);
  useEffect(() => close, []);
  // Picking one: the box empties, and it goes in the group.
  const pick = async (i: number) => {
    const x = find?.rows[i];
    if (!x) return;
    setValue("");
    close();
    await k.pick(gid, x);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const open = !!find;
    if (e.key === "Escape") {
      e.preventDefault();
      if (open) return close();
      setValue("");
      onEscape?.();
      return e.currentTarget.blur();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return e.key === "ArrowDown" && draw(true, 0);
      const sel = Math.max(-1, Math.min(find.rows.length - 1, find.sel + (e.key === "ArrowDown" ? 1 : -1)));
      return draw(k.open || !e.currentTarget.value.trim(), sel);
    }
    if (e.key !== "Enter") return;
    const at = open ? (find.sel >= 0 ? find.sel : kind === "wip" && find.rows.length ? 0 : -1) : -1;
    if (at >= 0 || kind === "wip") e.preventDefault();
    if (at >= 0) return void pick(at);
    close();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === "task") onAdd?.();
  };
  const words = (find?.q || "").split(/\s+/).filter(Boolean);
  const re = words.length ? wordStarts(words, "giu") : null;
  const marked: Marked = (s) => (re ? s.split(re).map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p)) : s);
  return (
    <form className={className} ref={form} onSubmit={submit}>
      {before}
      <input
        ref={input}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          draw(!!k.open, -1, e.target.value);
        }}
        onFocus={(e) => (e.target.value.trim() || k.open) && draw(true)}
        onBlur={close}
        onKeyDown={key}
        placeholder={placeholder}
        maxLength={kind === "task" ? 500 : undefined}
        aria-label={label}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!find}
        aria-activedescendant={find && find.sel >= 0 ? `find-${find.sel}` : ""}
      />
      <div className="fb-menu find-list" role="listbox" aria-label={listLabel} hidden={!find} ref={list} onMouseDown={(e) => e.preventDefault()}>
        {find ? (
          <>
            <p className="tf-h">{k.head(find.q)}</p>
            <div className="fb-list">
              {find.rows.length ? (
                find.rows.map((x, i) => (
                  <button key={i} className={`fb-row fb-row--one${i === find.sel ? " is-on" : ""}`} type="button" role="option" id={`find-${i}`} aria-selected={i === find.sel} tabIndex={-1} title={k.title(x)} onClick={() => pick(i)}>
                    {k.row(x, marked)}
                  </button>
                ))
              ) : (
                <p className="fb-none">{k.none}</p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </form>
  );
}
