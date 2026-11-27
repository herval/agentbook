// A section of a thread's page. Its heading folds it, and it starts folded, but for its steps, its images and what
// it keeps for you to do (For you); folded, the heading still says how many are in it. `acts`, the heading's own
// buttons, only show open. Folding or unfolding one from its heading is kept in this browser for every thread,
// so Steps folded
// on one is folded on the next. A link that opens one (to its Changes, Link a pull request, all its steps) opens it on
// this page only (unfoldSec).
import type { ReactNode } from "react";
import { create } from "zustand";
import { Icon } from "../Icon.tsx";

const SEC_OPEN = new Set(["steps", "images", "todos", "time", "people"]);
const KEPT = "agentbook.threadSecs";
function loadKept(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(KEPT));
    return v && typeof v === "object" && !Array.isArray(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "boolean")) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
// What's kept in this browser, and what this page flipped from it (a link that opened one).
interface Secs {
  kept: Record<string, boolean>;
  flipped: Set<string>;
}
const useSecs = create<Secs>(() => ({ kept: loadKept(), flipped: new Set() }));
const openIn = (s: Secs, key: string) => (s.kept[key] ?? SEC_OPEN.has(key)) !== s.flipped.has(key);

export const useSecOpen = (key: string) => useSecs((s) => openIn(s, key));
export const secOpen = (key: string) => openIn(useSecs.getState(), key);
// Fold or unfold it from its heading: kept for every thread (over what's kept, so another tab's folds stay too).
export function foldSec(key: string) {
  const s = useSecs.getState();
  const open = !openIn(s, key);
  const flipped = new Set(s.flipped);
  flipped.delete(key);
  try {
    localStorage.setItem(KEPT, JSON.stringify({ ...loadKept(), [key]: open }));
  } catch {}
  useSecs.setState({ kept: { ...s.kept, [key]: open }, flipped });
}
// Open it on this page only (a link to it).
export function unfoldSec(key: string) {
  const s = useSecs.getState();
  if (openIn(s, key)) return;
  const flipped = new Set(s.flipped);
  if (flipped.has(key)) flipped.delete(key);
  else flipped.add(key);
  useSecs.setState({ flipped });
}
// A new thread's page starts from what's kept.
export const resetSecs = () => useSecs.setState({ flipped: new Set() });

// A section: its heading (the label, a fold arrow, its count, and its buttons while open), and its body while open.
export function Sec({ k, label, count = null, acts = null, id, children }: { k: string; label: string; count?: ReactNode; acts?: ReactNode; id?: string; children?: ReactNode }) {
  const open = useSecOpen(k);
  return (
    <>
      <p className="sec-h" id={id}>
        <button className="sec-fold" type="button" data-sec={k} aria-expanded={open} title={`${open ? "Fold" : "Unfold"} ${label.toLowerCase()}`} onClick={() => foldSec(k)}>
          {label}
          <Icon name="down" />
          {count}
        </button>
        {open ? acts : null}
      </p>
      {open ? children : null}
    </>
  );
}
