// A thread's terminal, docked at the foot of its page (lib/terminal.ts drives it): its head says where its shell runs,
// what its line is doing, with Hide, Maximize and Close; xterm draws in its screen; its top edge resizes it. Once it
// ended, it says why, with Open a new one; when its machine waits for your passkey, Sign to keep typing.
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { tildeOn } from "../../lib/agents.ts";
import { attachDock, dockView, onDock, termAgain, termClose, termGrip, termLease, termMax, termMin } from "../../lib/terminal.ts";
import { Icon } from "../Icon.tsx";

export function TermDock() {
  const v = useSyncExternalStore(onDock, dockView);
  const el = useRef<HTMLElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  // A new terminal (its id): xterm goes in this dock's screen.
  useLayoutEffect(() => {
    if (v && el.current && screen.current) attachDock(el.current, screen.current);
  }, [v?.tid]);
  if (!v) return null;
  const says = v.max ? "Back to the foot of the page" : "Maximize";
  return createPortal(
    <section className={`term-dock${v.min ? " is-min" : ""}${v.max ? " is-max" : ""}${v.ended ? " is-ended" : ""}`} aria-label="Terminal" ref={el} key={v.tid}>
      <div className="term-grip" data-term-grip title="Drag to resize; double-click to maximize" onPointerDown={(e) => termGrip(e.currentTarget, e.nativeEvent)} onDoubleClick={() => termMax(true)} />
      <header className="term-head">
        <span className="term-title">
          <Icon name="terminal" />
          <b>Terminal</b>
        </span>
        <span className="term-where" title={v.cwd || ""}>
          <code>{tildeOn(v.machine, v.cwd || "")}</code>
          <small>
            on {v.machine || "its machine"}
            {v.shell ? `, ${v.shell}` : ""}
          </small>
        </span>
        <span className="term-state" data-term-state>
          {v.state}
        </span>
        <span className="term-acts">
          <button
            type="button"
            className="term-btn"
            data-term-min
            title="Hide it: Open terminal shows it again"
            aria-label="Hide the terminal"
            onClick={(e) => {
              e.stopPropagation();
              termMin();
            }}
          >
            <Icon name="down" />
          </button>
          <button
            type="button"
            className="term-btn"
            data-term-max
            title={says}
            aria-label={says}
            onClick={(e) => {
              e.stopPropagation();
              termMax();
            }}
          >
            <Icon name={v.max ? "restore" : "maximize"} />
          </button>
          <button
            type="button"
            className="term-btn"
            data-term-close
            title="Close it: its shell ends"
            aria-label="Close the terminal"
            onClick={(e) => {
              e.stopPropagation();
              termClose();
            }}
          >
            <Icon name="x" />
          </button>
        </span>
      </header>
      <div className="term-body">
        <div className="term-screen" data-term-screen ref={screen} />
        <div className="term-ended" data-term-ended hidden={!v.ended && !v.lease}>
          {v.ended ? (
            <>
              <span>
                {v.ended.why ? `It ended: ${v.ended.why}` : "It ended"}
                {v.ended.code != null && v.ended.code !== 0 ? ` (code ${v.ended.code})` : ""}.
              </span>
              <button type="button" className="btn btn--sm btn--line" data-term-again onClick={() => termAgain()}>
                Open a new one
              </button>
            </>
          ) : v.lease ? (
            <>
              <span>What you typed didn't reach it: {v.machine || "its machine"} takes typing only for a while after your passkey signs.</span>
              <button type="button" className="btn btn--sm btn--line" data-term-lease onClick={() => termLease()}>
                Sign to keep typing
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>,
    document.body,
  );
}
