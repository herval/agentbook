// The page around each screen: the drawers (the left column as the menu below 1180px, the right one below 860px), the
// search box, the bell, and whether newer page code is out (a tab left open across a restart loads again, when that
// loses nothing you typed).
import { useEffect, useState } from "react";
import { create } from "zustand";
import { hasDrafts } from "./hooks.ts";
import { getApp } from "./store.ts";

export const MENU = "(max-width: 1180px)";
export const NARROW = "(max-width: 860px)";
export const BAR_SHEET = "(max-width: 900px)";
export function useMedia(q: string): boolean {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

export interface Chrome {
  drawer: "left" | "right" | null;
  // Whether this screen shows the left column itself (Shell with left): the menu drawer has it otherwise.
  sided: boolean;
  searching: boolean;
  // What the search box says: the feed and the lists narrow to it.
  q: string;
  bellOpen: boolean;
  gotoOpen: boolean;
  gotoInitial: string;
  // ▥'s name and badge: what's on top of the screen's right column, and how many threads it has.
  panel: { title: string; n?: number; needs?: boolean } | null;
}
export const useChrome = create<Chrome>(() => ({ drawer: null, sided: false, searching: false, q: "", bellOpen: false, gotoOpen: false, gotoInitial: "", panel: null }));
export const setChrome = (c: Partial<Chrome>) => useChrome.setState(c);
export const openDrawer = (side: "left" | "right") => setChrome({ drawer: useChrome.getState().drawer === side ? null : side });
export const closeDrawer = () => setChrome({ drawer: null });

// Sending something, or a draft in a box: newer page code waits for it.
let sending = 0;
export const sendingStarted = () => void sending++;
export const sendingDone = () => void (sending = Math.max(0, sending - 1));
// The store keeps the code's stamp the page first heard (`ui`); the chrome has the server's now.
export function reloadIfStale(): boolean {
  const { ui: loaded, data } = getApp();
  const now = data?.ui || null;
  if (!now || !loaded || now === loaded || sending || hasDrafts()) return false;
  location.reload();
  return true;
}
