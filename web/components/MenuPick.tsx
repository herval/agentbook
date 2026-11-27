// app.ts menu1: a chip that opens a menu of rows to pick one (or several, `set`), with a field to find one (`find`),
// as the filter bar's and the composer's menus are.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDismiss } from "../lib/hooks.ts";
import { Icon } from "./Icon.tsx";

// A row of a menu (menu1): a pick, with what shows of it; or, between groups, a divider ("" for a line), or a hint.
export interface MenuRow {
  value?: string;
  text?: string;
  find?: string;
  face?: ReactNode;
  note?: string;
  title?: string;
  on?: boolean;
  off?: boolean;
  later?: boolean;
  make?: string;
  of?: string;
  divider?: string;
  hint?: string;
}
export interface MenuPickProps {
  id: string;
  label: string;
  title?: string;
  face: ReactNode;
  rows: MenuRow[];
  set?: boolean;
  none?: boolean;
  find?: boolean;
  onPick: (value: string, row: MenuRow) => void;
  // What its find box finds ("task, group or page"), the opener's class instead of "opt", the menu's extra class, and
  // whether a ticked row says × too (it takes it out, as a card's + menu does).
  what?: string;
  btnClass?: string;
  menuClass?: string;
  unpick?: boolean;
  // The span's extra class ("put-pk").
  cls?: string;
}

// One option of a new post, all of which have defaults: a word beside its icon that shows what it's set to, quiet
// until you pick something else, and opens the filter bar's menu, with a ✓ by the pick rather than its boxes. Its
// rows are { value, text, face, note, title, on, off } and, between groups, a divider: { divider: "WIP" }, or ""
// for a line. A long one has a box to find one in, and so does one with `find`. The pick is what onPick hears.
// With `none`, nothing is picked: a menu that does something with each pick (Link a thread), not a setting.
// A row with `make` ("New group") makes one: it stays while you find, saying `New group "what you typed"`, and its
// value is then its own plus ":" and what you typed. With `of` ("group"), only a row of that kind (its value
// "group|…") with that very name hides it, where the menu has several kinds. A row with `later` shows only when what
// you type finds it, and { hint } is a line that shows until you type ("12 more: type to find one").
export function MenuPick({ id, label, title, face, rows, set = false, none = false, find = false, onPick, what, btnClass, menuClass = "", unpick = false, cls = "" }: MenuPickProps) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus?: boolean) => {
    setOpen(false);
    if (refocus) opener.current?.focus();
  }, []);
  const ref = useDismiss<HTMLSpanElement>(open, close);
  const pick = none ? null : rows.find((r) => r.on) || rows.find((r) => "value" in r);
  // Picking a row closes the menu; one that's already the pick only closes it.
  const choose = (r: MenuRow, byKey: boolean) => {
    if (r.off) return;
    close(byKey);
    if (!none && pick && r.value === pick.value && !r.make) return;
    onPick(r.value ?? "", r);
  };
  return (
    <span className={`pk${cls ? ` ${cls}` : btnClass === "put-add" ? " put-pk" : ""}`} data-pk={id} ref={ref}>
      <button
        ref={opener}
        className={btnClass || `opt${set ? " is-set" : ""}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={none ? label : `${label}: ${pick?.text || ""}`}
        title={title || label}
        onClick={(e) => {
          // The composer's box keeps the focus in Safari for a click on a button: out of it, so a pick lands.
          if (!open && (document.activeElement as HTMLElement | null)?.matches?.("[data-launch] ab-box, [data-launch] input")) (document.activeElement as HTMLElement).blur();
          if (open) close(!e.detail);
          else setOpen(true);
        }}
        onKeyDown={(e) => {
          if (open || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {face}
      </button>
      {open && <PkMenu label={label} rows={rows} findAlways={find} what={what} menuClass={menuClass} unpick={unpick} onChoose={choose} onClose={() => close(true)} />}
    </span>
  );
}

// The menu itself: its find box when it's long (or always, with `find`), its rows, and "No … called that".
export function PkMenu({ label, rows, findAlways = false, what, menuClass = "", unpick = false, onChoose, onClose }: { label: string; rows: MenuRow[]; findAlways?: boolean; what?: string; menuClass?: string; unpick?: boolean; onChoose: (r: MenuRow, byKey: boolean) => void; onClose: () => void }) {
  what ||= label.toLowerCase();
  const [typed, setTyped] = useState("");
  const menu = useRef<HTMLDivElement>(null);
  const words = typed.trim().toLowerCase();
  const hasFind = findAlways || rows.filter((r) => "value" in r).length > 10;
  // A row that makes one stays, named after what's typed, unless a row (of its kind, with `of`) has that very name.
  const same = (of?: string) => rows.some((r) => "value" in r && !r.make && (r.find || r.text || "").toLowerCase() === words && (!of || String(r.value).startsWith(`${of}|`)));
  const shownOf = (r: MenuRow) => (r.make ? !same(r.of) : words ? (r.find || r.text || "").toLowerCase().includes(words) : !r.later);
  // Its find box shows the rows with what's typed in their names, and the dividers over any of them. A divider that's
  // only a line goes too with nothing over it.
  const drawn: { r: MenuRow; hidden: boolean }[] = [];
  let shown = 0;
  let div: { r: MenuRow; hidden: boolean } | null = null;
  let any = false;
  let above = 0;
  const end = () => div && (div.hidden = !any || (!div.r.divider && !above));
  for (const r of rows) {
    if ("divider" in r) {
      end();
      div = { r, hidden: false };
      [any, above] = [false, shown];
      drawn.push(div);
    } else if ("hint" in r) drawn.push({ r, hidden: !!words });
    else {
      const hidden = !shownOf(r);
      if (!hidden) [any, shown] = [true, shown + 1];
      drawn.push({ r, hidden });
    }
  }
  end();
  const valueOf = (r: MenuRow) => (r.make ? `${String(r.value).split(":")[0]}${typed.trim() ? `:${typed.trim()}` : ""}` : r.value);
  const rowsNow = () => [...(menu.current?.querySelectorAll<HTMLElement>("[data-pk-value]") || [])].filter((el) => !el.hidden && !el.getAttribute("aria-disabled"));
  // It opens with its find box focused, or else its pick (by keyboard), once it's placed: focused where it hangs below the
  // window, before it flips up (a chip under a thread's reply box), the page would scroll to it.
  useLayoutEffect(() => {
    const m = menu.current;
    if (!m) return;
    placePk(m);
    (m.querySelector<HTMLElement>("[data-pk-q]") || m.querySelector<HTMLElement>(".is-on") || rowsNow()[0])?.focus();
  }, []);
  return (
    <div
      ref={menu}
      className={`fb-menu pk-menu${menuClass ? ` ${menuClass}` : ""}`}
      role="menu"
      aria-label={label}
      onKeyDown={(e) => {
        // The arrow keys go up and down its rows, and Enter in its find box picks the first it finds.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          return onClose();
        }
        if (e.key === "Enter" && (e.target as HTMLElement).matches("[data-pk-q]")) {
          e.preventDefault(); // rather than send the composer
          return rowsNow()[0]?.click();
        }
        if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
        const list = rowsNow();
        if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const down = e.key === "ArrowDown";
        list[i < 0 ? (down ? 0 : list.length - 1) : (i + (down ? 1 : -1) + list.length) % list.length].focus();
      }}
    >
      {hasFind && (
        <div className="fb-find">
          <Icon name="search" />
          <input data-pk-q placeholder={`Find ${/^[aeiou]/.test(what) ? "an" : "a"} ${what}`} aria-label={`Find ${what}`} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
      <div className="fb-list">
        {drawn.map(({ r, hidden }, i) =>
          "divider" in r ? (
            <div className="pk-div" role="separator" key={i} hidden={hidden}>
              {r.divider}
            </div>
          ) : "hint" in r ? (
            <p className="pk-more" key={i} hidden={hidden}>
              {r.hint}
            </p>
          ) : (
            <button
              key={i}
              className={`fb-row fb-row--one${r.on ? " is-on" : ""}${r.off ? " is-off" : ""}`}
              type="button"
              role="menuitemradio"
              aria-checked={!!r.on}
              aria-disabled={r.off ? true : undefined}
              hidden={hidden}
              data-pk-value={valueOf(r)}
              title={r.title}
              onClick={(e) => onChoose({ ...r, value: valueOf(r) }, !e.detail)}
            >
              {r.face}
              <span className="fb-nm">{r.make && typed.trim() ? `${r.make} “${typed.trim()}”` : r.text}</span>
              {r.note && <span className="fb-n">{r.note}</span>}
              <span className="fb-on">
                {r.on && <Icon name="check" />}
                {r.on && unpick && <Icon name="x" />}
              </span>
            </button>
          ),
        )}
        <p className="fb-none" hidden={shown > 0}>
          No {what} called that.
        </p>
      </div>
    </div>
  );
}

// A menu opens under its word, or above it where there's no room below (at a page's threads bar's foot), and moves
// left where it would run off the side or past its composer's right edge. It stays under the top bar, its list
// shorter where the window is. In something that scrolls on its own (a page's right column, which is sticky and
// scrolls when it's taller than the window) it floats over the window rather than being cut to it and squeezed into
// what's left of it (a WIP's Add it to a group, with a row and a half showing).
function placePk(m: HTMLElement) {
  let scroller: HTMLElement | null = null; // the nearest thing around it that scrolls on its own, which would cut it
  for (let el = m.parentElement; el && el !== document.body && !scroller; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") scroller = el;
  }
  // Measured clipped to its word, so it can't widen the page: on a phone, a menu hanging past the right edge until it
  // moves left (a chip at the right of a thread's foot) widens the layout viewport, and the page drops to its top.
  const holder = m.parentElement;
  const was = holder.style.overflow;
  holder.style.overflow = "clip";
  try {
    placeIn(m, scroller);
  } finally {
    holder.style.overflow = was;
  }
}

function placeIn(m: HTMLElement, scroller: HTMLElement | null) {
  const box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const at = m.parentElement.getBoundingClientRect();
  if (scroller) {
    m.classList.add("pk-menu--fixed");
    Object.assign(m.style, { left: `${at.left}px`, top: `${at.bottom + 6}px` }); // under its word, as it would be in its column
  }
  box.top = Math.max(box.top, document.querySelector(".top")?.getBoundingClientRect().bottom || 0);
  const r = m.getBoundingClientRect();
  const right = Math.min(box.right - 8, m.closest(".card")?.getBoundingClientRect().right ?? Infinity);
  m.style.left = `${(scroller ? at.left : 0) + Math.max(box.left + 8 - r.left, Math.min(0, right - r.right))}px`;
  const up = r.bottom > box.bottom - 8 && at.top - box.top > box.bottom - at.bottom;
  if (up) {
    m.classList.add("pk-menu--up");
    if (scroller) Object.assign(m.style, { top: "auto", bottom: `${innerHeight - at.top + 6}px` });
  }
  const over = r.height - ((up ? at.top - box.top : box.bottom - at.bottom) - 14); // 6px from its word, 8 from the edge
  const list = over > 0 && m.querySelector<HTMLElement>(".fb-list");
  if (list) list.style.maxHeight = `${Math.max(120, list.getBoundingClientRect().height - over)}px`;
}
