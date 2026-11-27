// A menu that opens from a button (the filter bar's, a card's ⋯): its panel shows under the button while it's open,
// and closes on a pick, a click outside or Escape. The panel uses agentbook.css's .fb-menu unless told otherwise.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useDismiss } from "../lib/hooks.ts";

export function Menu({ button, children, className = "", menuClass = "fb-menu", label, title, open: openProp, onOpen }: { button: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); className?: string; menuClass?: string; label?: string; title?: string; open?: boolean; onOpen?: (open: boolean) => void }) {
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const setOpen = useCallback(
    (v: boolean) => {
      setOpenSelf(v);
      onOpen?.(v);
    },
    [onOpen],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const ref = useDismiss<HTMLSpanElement>(open, close);
  return (
    <span className={`menu-wrap ${className}`.trim()} ref={ref}>
      <button type="button" className="menu-btn-x" aria-haspopup="true" aria-expanded={open} aria-label={label} title={title} onClick={() => setOpen(!open)}>
        {button}
      </button>
      {open && (
        <div className={menuClass} role="menu">
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </span>
  );
}
