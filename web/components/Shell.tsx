// A screen's layout: the left column (the menu: LeftNav), the screen's middle, and its right column (`right`, "rail"),
// as agentbook.css lays out .shell. Below 1180px the left column is the menu drawer instead (App draws it), and below
// 860px the right column is a drawer behind ▥. A screen with no left column of its own (a thread, a profile) passes
// left={false}, and the menu drawer has it at any width.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { MENU, setChrome, useMedia } from "../lib/chrome.ts";
import { LeftNav } from "./LeftNav.tsx";

export function Shell({ left = true, right = null, children, mainClass = "feed", className = "shell", style }: { left?: boolean; right?: ReactNode; children: ReactNode; mainClass?: string; className?: string; style?: React.CSSProperties }) {
  const menu = useMedia(MENU);
  const sided = left && !menu;
  useSided(sided);
  return (
    <div className={className} style={style}>
      {left && <aside className="col-side">{sided && <LeftNav />}</aside>}
      <main className={mainClass}>{children}</main>
      {right != null && <aside className="col-side rail">{right}</aside>}
    </div>
  );
}
// Whether this screen shows the left column itself: the menu drawer has it while it doesn't.
export function useSided(sided: boolean) {
  useEffect(() => {
    setChrome({ sided });
    return () => setChrome({ sided: false });
  }, [sided]);
}
// "Loading…", or a word that something isn't there, with the way back.
export function ShellMsg({ children, back = true }: { children: ReactNode; back?: boolean }) {
  return (
    <div className="shell-msg">
      {typeof children === "string" ? <p className="muted">{children}</p> : children}
      {back && (
        <a className="btn" href="#/">
          Back to the feed
        </a>
      )}
    </div>
  );
}
