// Hooks every screen uses: what it fetches (useLoad), what this browser remembers (usePref), what you're typing
// (useDraft), and a clock for times that count (useNow).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getJSON } from "./api.ts";
import { onHello } from "./live.ts";

// What a screen fetched: its answer, or why not. Asked for when the url changes, and again whenever `again` changes:
// pass what in the chrome says it changed (a page's version, a group's updated), as the old page's settle did. While
// it asks again, the answer it had stays. A 404 is `missing`.
export interface Loaded<T> {
  data: T | null;
  error: string | null;
  missing: boolean;
  loading: boolean;
  reload: () => Promise<void>;
  // Change what it has (after a POST), without asking again.
  set: (fn: (d: T | null) => T | null) => void;
}
export function useLoad<T>(url: string | null, again: unknown = null): Loaded<T> {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null; missing: boolean; loading: boolean }>({ url: null, data: null, error: null, missing: false, loading: !!url });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, url, loading: true, ...(s.url === url ? {} : { data: null, error: null, missing: false }) }));
    const res = await fetch(url).catch(() => null);
    if (n !== seq.current) return;
    if (res?.status === 401) return void (await import("./session.ts")).signedOut();
    const body = res ? await res.json().catch(() => null) : null;
    if (n !== seq.current) return;
    setState((s) => ({ url, loading: false, data: res?.ok ? (body as T) : s.url === url ? s.data : null, missing: res?.status === 404, error: res?.ok ? null : body?.error || (res ? `Couldn't get it (HTTP ${res.status})` : "Couldn't reach agentbook.") }));
  }, [url]);
  const again_ = typeof again === "object" && again !== null ? JSON.stringify(again) : again;
  useEffect(() => {
    reload();
  }, [reload, again_]);
  useEffect(() => onHello(() => void reload()), [reload]);
  const set = useCallback((fn: (d: T | null) => T | null) => setState((s) => ({ ...s, data: fn(s.data) })), []);
  return { data: state.url === url ? state.data : null, error: state.url === url ? state.error : null, missing: state.url === url && state.missing, loading: state.loading || state.url !== url, reload, set };
}
// The same, once, for what a handler needs now.
export const fetchJSON = getJSON;

// What this browser remembers for you (a list's view, a section folded): localStorage, under "agentbook.<key>", the
// keys the old page used, so what a browser remembered stays. Every component using the same key sees the same value.
const prefSubs = new Map<string, Set<() => void>>();
// A string is kept as it is (as the old page kept "agentbook.feedView" = "compact"), anything else as JSON.
function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`agentbook.${key}`);
    return v == null ? fallback : typeof fallback === "string" ? (v as T) : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const sub = useCallback((fn: () => void) => {
    if (!prefSubs.has(key)) prefSubs.set(key, new Set());
    prefSubs.get(key).add(fn);
    return () => prefSubs.get(key)?.delete(fn);
  }, [key]);
  const raw = useSyncExternalStore(sub, () => {
    try {
      return localStorage.getItem(`agentbook.${key}`);
    } catch {
      return null;
    }
  });
  const value = raw == null ? fallback : readPref(key, fallback);
  const set = useCallback((v: T) => {
    try {
      localStorage.setItem(`agentbook.${key}`, typeof v === "string" ? v : JSON.stringify(v));
    } catch {}
    for (const fn of prefSubs.get(key) || []) fn();
  }, [key]);
  return [value, set];
}

// What you're typing in a box, by the box's key ("launch", "c:<thread>"): kept while you go elsewhere and come back,
// as the old page's drafts were. The page doesn't reload itself for newer code while one has something in it.
const drafts = new Map<string, string>();
const draftSubs = new Map<string, Set<() => void>>();
export const hasDrafts = () => [...drafts.values()].some((d) => d.trim());
export function setDraft(key: string, v: string) {
  if (v) drafts.set(key, v);
  else drafts.delete(key);
  for (const fn of draftSubs.get(key) || []) fn();
}
export const getDraft = (key: string) => drafts.get(key) || "";
export function useDraft(key: string): [string, (v: string) => void] {
  const sub = useCallback((fn: () => void) => {
    if (!draftSubs.has(key)) draftSubs.set(key, new Set());
    draftSubs.get(key).add(fn);
    return () => draftSubs.get(key)?.delete(fn);
  }, [key]);
  const value = useSyncExternalStore(sub, () => drafts.get(key) || "");
  return [value, useCallback((v: string) => setDraft(key, v), [key])];
}

// The time now, every `ms` (a second by default), for times that count up ("3m 05s") or say how long ago.
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Something that closes when you click outside it or press Escape (a menu, a popover).
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, close]);
  return ref;
}
