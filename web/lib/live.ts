// The page's own stream: what changes in what this page shows, and only that. The stream is
// named by the page, so it reconnects to the same one and gets what it missed (from the last event it had); one the
// server lost says `hello`, and the page asks again for everything it shows. It comes on a WebSocket: a browser holds
// at most six connections to a server over plain HTTP, and an event stream in every open tab used them all up. Where a
// WebSocket never connects (a proxy that doesn't pass them), an event stream instead.
import { getJSON } from "./api.ts";
import { heardFeed, reloadFeed } from "./feed.ts";
import type { FeedDelta } from "./feed.ts";
import { signedOut } from "./session.ts";
import { heardSide, loadSide } from "./side.ts";
import type { SideDelta } from "./side.ts";
import { getApp, setApp } from "./store.ts";
import { heardLive, reloadThread } from "./thread.ts";
import type { LiveDelta } from "./thread.ts";
import type { AuthMe } from "./types.ts";

const LIVE_ID = crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
let stream: { close(): void } | null = null;
let last = 0;
let tries = 0;
let useWs = true; // false once a WebSocket never connected, twice
let everOpened = false;
let failed = 0;
// Others that want to hear the stream (a dashboard's panels): event name -> handlers.
const listeners = new Map<string, Set<(d: unknown) => void>>();
export function onStream(event: string, fn: (d: unknown) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
// Something to ask for again on each hello (a screen's own answer the stream keeps up to date, like a dashboard's).
const hellos = new Set<() => void>();
export function onHello(fn: () => void): () => void {
  hellos.add(fn);
  return () => hellos.delete(fn);
}

// The stream again from the start, as one the server has nothing of: its hello asks again for everything the page
// shows (side.ts, when the server says it doesn't know this page's stream).
export function restartLive() {
  last = 0;
  openLive();
}
export function openLive() {
  stream?.close();
  if (!useWs) return openEventStream();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/ws?live=${encodeURIComponent(LIVE_ID)}${last ? `&last=${last}` : ""}`);
  const me: { close: () => void; closed?: boolean } = { close: () => ((me.closed = true), ws.close()) };
  stream = me;
  let opened = false;
  ws.onopen = () => {
    opened = everOpened = true;
    tries = 0;
    setApp({ conn: null });
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    last = m.id;
    heard(m.event, m.data);
  };
  ws.onclose = async (e) => {
    if (me.closed || stream !== me) return;
    // Signed out (elsewhere, or the sign-in expired): no more reconnecting; the sign-in page.
    if (e.code === 4401) return signedOut();
    setApp({ conn: "reconnecting" });
    if (!everOpened && !opened && ++failed >= 2) {
      useWs = false;
      return openLive();
    }
    // While the server is down (restarting) this can't be asked: try again as for any close.
    const who = await getJSON<AuthMe>("/api/auth/me").catch(() => null);
    if (who && !who.user) return signedOut();
    setTimeout(() => stream === me && openLive(), Math.min(5000, 250 * 2 ** tries++));
  };
}
function openEventStream() {
  const es = new EventSource(`/api/live?live=${encodeURIComponent(LIVE_ID)}`);
  stream = es;
  es.onopen = () => setApp({ conn: null });
  es.onerror = async () => {
    setApp({ conn: "reconnecting" });
    const who = await getJSON<AuthMe>("/api/auth/me").catch(() => null);
    if (who && !who.user) signedOut();
  };
  for (const name of ["hello", "side", "feed", "put", "del", "messages", "live", "runs", "steps", "changes", "panel"]) es.addEventListener(name, (e) => heard(name, JSON.parse((e as MessageEvent).data)));
}
export function closeLive() {
  stream?.close();
  stream = null;
}

// Each event's JSON is the shape its handler reads (the server's live.ts sends them).
function heard(name: string, d: unknown) {
  // A hello is a stream the server has nothing of yet (the first, or one it lost): each thing the page shows is
  // asked for again, with the stream's id, and heard about from then on.
  if (name === "hello") {
    setApp({ liveId: (d as { live: string }).live, conn: null });
    loadSide();
    if (getApp().open) reloadThread();
    reloadFeed();
    for (const fn of hellos) fn();
  } else if (name === "side") heardSide(d as SideDelta);
  else if (name === "feed") heardFeed(d as FeedDelta);
  else if (name === "panel") for (const fn of listeners.get("panel") || []) fn(d);
  else heardLive(name, d as LiveDelta);
}
