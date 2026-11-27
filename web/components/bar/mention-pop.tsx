// The @ list of a message box (MsgBox): what it can name, just above the box (below it when there's no room), in
// one .mention-pop on the page's body. Its rows are lib/mentions.tsx's mentionRows; the box keeps which is picked and
// its keys (↑ ↓ move, Enter or Tab picks, Esc closes). Ported from the old page's mentionDraw.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isAgentPick, namedStyle, NamedRow } from "../../lib/mentions.tsx";
import type { MentionRow } from "../../lib/mentions.tsx";

export interface MentionPopProps {
  // The box it's for, which it sits by.
  box: HTMLElement;
  // What's typed after the @, its rows, and the one picked.
  q: string;
  rows: MentionRow[];
  sel: number;
  // The box's page, and whether it can name groups and tasks (canLink).
  here: string | null;
  links: boolean;
  onPick: (i: number) => void;
}

// The list. A click on a row picks it; pressing on it doesn't take the box's cursor away.
export function MentionPop({ box, q, rows, sel, here, links, onPick }: MentionPopProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pagesH = links ? (here ? "This page's widgets, your pages, notes, groups, tasks and workspaces" : "Your pages, notes, groups, tasks and workspaces") : here ? "This page's widgets, your pages, notes and workspaces" : "Your pages, notes and workspaces";
  // Above the box (or the .text-box it's in), as wide as it, or below it when there's no room above.
  const place = useCallback(() => {
    const pop = ref.current;
    if (!pop) return;
    const r = (box.closest(".text-box") || box).getBoundingClientRect();
    const width = Math.min(Math.max(320, r.width), innerWidth - 24);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - width - 12))}px`;
    const h = pop.offsetHeight;
    pop.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8}px`;
  }, [box]);
  useLayoutEffect(() => {
    place();
    ref.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
  });
  // It follows the box as the page scrolls.
  useEffect(() => {
    document.addEventListener("scroll", place, true);
    return () => document.removeEventListener("scroll", place, true);
  }, [place]);

  // Headings only when there are agents too (in a thread's box): who's in it, who it can bring in, then the rest.
  let group: string | null = isAgentPick(rows[0]) ? null : "pages";
  const row = (x: MentionRow, i: number) => {
    const was = group;
    group = isAgentPick(x) ? x.kind : "pages";
    const head =
      group === was ? null : (
        <p className="mp-h mp-h--in">{group === "in" ? "In this thread" : group === "bring" ? "Bring into this thread" : group === "join" ? "A thread of yours that's running, as it is" : q ? (links ? "Pages, notes, groups, tasks and workspaces" : "Pages, notes and workspaces") : pagesH}</p>
      );
    return (
      <Fragment key={i}>
        {head}
        <button className={`mp-row${i === sel ? " is-on" : ""}`} type="button" role="option" id={`mp-${i}`} aria-selected={i === sel} style={namedStyle(x)} onClick={() => onPick(i)}>
          <NamedRow x={x} here={here} q={q} />
        </button>
      </Fragment>
    );
  };
  return createPortal(
    <div className="mention-pop" role="listbox" id="mention-pop" ref={ref} onMouseDown={(e) => e.preventDefault()}>
      {q ? <div className="mp-h">Matching “{q}”</div> : isAgentPick(rows[0]) ? null : <div className="mp-h">{pagesH}</div>}
      <div className="mp-rows">{rows.length ? rows.map(row) : <p className="mp-none">Nothing matches. Keep typing, or a space leaves it as text.</p>}</div>
      <div className="mp-keys">
        <span>↑↓ move</span>
        <span>Enter or Tab picks</span>
        <span>Esc closes</span>
      </div>
    </div>,
    document.body,
  );
}
