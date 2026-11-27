// A thread's terminal (server/terminals.ts): a shell in the thread's folder, on its machine, for its owner, kept
// until you close it (✕) or its shell exits. Open terminal, on the thread's card, opens it docked at the foot of the
// thread's page, where it stays while you read the thread above it; ▶ on one of the thread's code blocks runs the
// block there, and shows it. Hidden, it's off the page entirely, and Open terminal shows it again as it was. Leaving
// the thread takes it off the page but not off the machine: coming back, it's as you left it. Maximized, it's all
// of the window under the top bar, until you put it back at the height it had.
// What you type and what it shows go on a WebSocket of its own: it doesn't wait behind the page's other requests (a
// browser holds at most six to a server, and each open agentbook tab keeps one), and it picks up again by itself
// after the server or its machine restarts.
// xterm.js draws it (@xterm/xterm, its stylesheet in app.css), loaded as a thread of yours shows. The page draws the
// dock around it (components/thread/TermDock.tsx, from dockView()); this drives xterm, its socket and its size.

import "@xterm/xterm/css/xterm.css";
import { post } from "./api.ts";
import { getApp } from "./store.ts";
import { createTyping } from "./typing.ts";
import type { Typing } from "./typing.ts";

// A terminal, as the server says it (server/terminals.ts's summary).
interface TermInfo {
  id: string;
  post: string;
  state: "opening" | "open" | "ended";
  cwd: string | null;
  shell: string | null;
}
// The thread a terminal is on: its id, and the machine it runs on.
interface ThreadAt {
  id: string;
  machine?: string;
}
// What the page uses of xterm.js.
interface XtermTerminal {
  cols: number;
  rows: number;
  options: { cursorBlink?: boolean; disableStdin?: boolean };
  loadAddon(addon: FitAddon): void;
  open(el: HTMLElement): void;
  onData(fn: (data: string) => void): void;
  write(data: Uint8Array): void;
  reset(): void;
  focus(): void;
  dispose(): void;
}
interface FitAddon {
  fit(): void;
}
interface Xterm {
  Terminal: new (options: object) => XtermTerminal;
  FitAddon: new () => FitAddon;
}
// The one on the page.
interface Dock {
  post: string;
  machine: string | undefined;
  tid: string;
  term: XtermTerminal;
  fit: FitAddon;
  // The dock the page drew for it, once it has (attachDock), and how it was to show then.
  el: HTMLElement | null;
  first: { focus: boolean; min: boolean; max: boolean };
  ws: WebSocket | null;
  min: boolean;
  max: boolean;
  ended: boolean;
  typing: Typing | null;
  // "<cols>x<rows>", as the shell last heard it.
  size: string | null;
  // What it showed came numbered under `epoch`, up to `seq`.
  epoch: string | null;
  seq: number;
  tries: number;
  since: number;
  h?: number;
  gone?: boolean;
  leasing?: boolean;
  retry?: ReturnType<typeof setTimeout>;
  ro?: ResizeObserver;
}
// What its socket says (server/terminals.ts): `t` is what it is.
interface TermMessage {
  t: "hello" | "reset" | "out" | "got" | "line" | "lease" | "end";
  line?: boolean;
  acks?: boolean;
  epoch?: string;
  data?: string;
  seq?: number;
  id?: string;
  up?: boolean;
  why?: string;
  code?: number;
}

let xterm: Xterm = null;
let loading: Promise<Xterm> = null;
let dock: Dock = null;

const KEY_H = "ab.term.h";
const KEY_MIN = "ab.term.min";
const KEY_MAX = "ab.term.max";
const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  },
};
const enc = encodeURIComponent;

// The page's colors: ink on white, its yellow for what you select, and ANSI colors that read on white (white itself
// is a grey, so text a program writes in white doesn't vanish).
const THEME = {
  background: "#ffffff",
  foreground: "#121821",
  cursor: "#121821",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(255, 210, 63, 0.5)",
  selectionInactiveBackground: "rgba(255, 210, 63, 0.3)",
  black: "#121821",
  red: "#c8402c",
  green: "#23845a",
  yellow: "#946800",
  blue: "#2c5cc5",
  magenta: "#9a3db3",
  cyan: "#127b8a",
  white: "#8a93a0",
  brightBlack: "#4a5462",
  brightRed: "#dd4f37",
  brightGreen: "#2a9a69",
  brightYellow: "#b08000",
  brightBlue: "#3d6fe0",
  brightMagenta: "#b04fcc",
  brightCyan: "#1a93a4",
  brightWhite: "#b6bdc7",
  scrollbarSliderBackground: "rgba(18, 24, 33, 0.12)",
  scrollbarSliderHoverBackground: "rgba(18, 24, 33, 0.22)",
  scrollbarSliderActiveBackground: "rgba(18, 24, 33, 0.3)",
};

// What the page draws of the dock: the thread it's on and where its shell runs, hidden or maximized, what its line
// says ("Reconnecting…"), how it ended, and whether what's typed waits for your passkey to sign.
export interface DockView {
  post: string;
  machine: string | undefined;
  tid: string;
  cwd: string | null;
  shell: string | null;
  min: boolean;
  max: boolean;
  state: string;
  ended: { why?: string; code?: number } | null;
  lease: boolean;
}
let view: DockView | null = null;
const watchers = new Set<() => void>();
// The dock as the page draws it now, and a way to hear it change (useSyncExternalStore).
export const dockView = (): DockView | null => view;
export function onDock(fn: () => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}
function show(o: Partial<DockView> | null) {
  view = o && view ? { ...view, ...o } : (o as DockView | null);
  for (const fn of watchers) fn();
}
// The thread whose page is up, where its terminal shows.
const here = (): string | null => {
  const r = getApp().route;
  return r.name === "session" ? r.id : null;
};
for (const ev of ["resize", "scroll"]) window.visualViewport?.addEventListener(ev, fillWindow);

function load(): Promise<Xterm> {
  if (xterm) return Promise.resolve(xterm);
  loading ||= (async () => {
    const [{ Terminal }, { FitAddon }] = (await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])) as unknown as [Pick<Xterm, "Terminal">, Pick<Xterm, "FitAddon">];
    // Its cells are measured once: the page's mono font first.
    await document.fonts?.load?.('13px "Geist Mono"').catch(() => {});
    xterm = { Terminal, FitAddon };
    return xterm;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}
// A thread of yours is on the page: xterm.js loads meanwhile, so opening its terminal doesn't wait for it.
export function preloadTerminal() {
  if (xterm || loading) return;
  (window.requestIdleCallback || setTimeout)(() => load().catch(() => {}));
}

// Whether a thread's terminal is on the page (`min`: hidden, still going).
export const terminalShown = (post: string): "min" | "open" | null => (dock?.post === post ? (dock.min ? "min" : "open") : null);

// Open its terminal: the one open on the machine already, else a new one. Signed with your passkey when its machine
// wants that (api.ts's post does).
export async function openTerminal(s: ThreadAt, { max }: { max?: boolean } = {}): Promise<boolean> {
  if (dock?.post === s.id && !dock.ended) return restore();
  const size = guessSize();
  const r = await post<{ terminal?: TermInfo }>(`/api/sessions/${enc(s.id)}/terminal`, size);
  if (!r.ok) return false;
  await mount(s, r.data.terminal, { focus: true, max });
  return true;
}

// Coming back to a thread: its terminal, if one is still open, as it was left. `show`: shown even if it was hidden
// (▶ ran a block there).
export async function resumeTerminal(s: ThreadAt, { show = false } = {}): Promise<boolean | undefined> {
  if (dock?.post === s.id && !dock.ended) return show && dock.min ? restore() : undefined;
  if (dock && dock.post !== s.id) leaveTerminal();
  const r: { terminal?: TermInfo } | null = await fetch(`/api/sessions/${enc(s.id)}/terminal`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r?.terminal || r.terminal.state === "ended" || here() !== s.id) return;
  if (dock?.post === s.id && !dock.ended && dock.tid === r.terminal.id) return show && dock.min ? restore() : undefined;
  await mount(s, r.terminal, { min: !show && store.get(KEY_MIN) === r.terminal.id });
}

// Off the page (its thread isn't on it any more); its shell stays on the machine.
export function leaveTerminal() {
  if (!dock) return;
  const d = dock;
  dock = null;
  d.gone = true;
  clearTimeout(d.retry);
  d.ws?.close();
  d.ro?.disconnect();
  d.term?.dispose();
  show(null);
  document.body.classList.remove("has-term");
  document.body.style.removeProperty("--term-h");
}

// How many cells the dock will hold, before it's there to measure: from its height, and the page's width.
function guessSize() {
  const h = height();
  return { cols: Math.max(20, Math.floor((window.innerWidth - 32) / 7.8)), rows: Math.max(4, Math.floor((h - 52) / 15.6)) };
}
const height = () => {
  const saved = Number(store.get(KEY_H));
  const max = Math.max(200, window.innerHeight - 140);
  return Math.min(max, saved >= 160 ? saved : Math.round(window.innerHeight * 0.4));
};

async function mount(s: ThreadAt, t: TermInfo, { focus = false, min = false, max = store.get(KEY_MAX) === t.id } = {}) {
  const { Terminal, FitAddon } = await load();
  leaveTerminal();
  const term = new Terminal({ fontFamily: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: THEME, allowTransparency: false });
  const fit = new FitAddon();
  term.loadAddon(fit);
  dock = { post: s.id, machine: s.machine, tid: t.id, term, fit, el: null, first: { focus, min, max }, ws: null, min, max, ended: false, typing: null, size: null, epoch: null, seq: 0, tries: 0, since: 0 };
  const d = dock;
  d.typing = createTyping((m) => d.ws?.readyState === WebSocket.OPEN && (d.ws.send(JSON.stringify(m)), true));
  term.onData((data) => type(d, data));
  // The page draws its dock now (TermDock), and hands it over (attachDock).
  show({ post: s.id, machine: s.machine, tid: t.id, cwd: t.cwd, shell: t.shell, min, max, state: "", ended: null, lease: false });
}
// The dock the page drew for the terminal: xterm goes in its screen, and its socket opens. `el` is the dock,
// `screen` where xterm draws. It's done once a dock; a dock the page takes away leaves it (leaveTerminal).
export function attachDock(el: HTMLElement, screen: HTMLElement) {
  const d = dock;
  if (!d || d.el) return;
  d.el = el;
  d.term.open(screen);
  // What's typed is the shell's: the page's own keys (shortcuts, Esc, pasting files into a box) stay out of it.
  for (const ev of ["keydown", "keyup", "keypress", "paste"]) el.addEventListener(ev, (e) => e.stopPropagation());
  sizeTo(height());
  setMin(d.first.min);
  setMax(d.first.max);
  d.ro = new ResizeObserver(() => refit(d));
  d.ro.observe(screen);
  listen(d);
  if (d.first.focus) d.term.focus();
}

// What it shows, as it shows it: from where this page was (a blip in between), or all it kept (opening it again).
// Its socket going (the server restarting, the network) is a blip: it connects again, and says so meanwhile.
function listen(d: Dock) {
  if (d.gone || d.ended) return;
  const from = d.epoch ? `?from=${enc(`${d.epoch}:${d.seq}`)}` : "";
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/${enc(d.tid)}/ws${from}`);
  d.ws = ws;
  const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  ws.onopen = () => (d.tries = 0);
  ws.onmessage = (e) => {
    let m: TermMessage;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.t === "hello") {
      d.since = 0;
      state(d, m.line === false ? `Waiting for ${d.machine || "its machine"}…` : "");
      // What its shell hasn't got yet, and this page's size.
      d.typing.open(!!m.acks);
      if (d.term.cols && d.term.rows) ws.send(JSON.stringify({ t: "size", cols: d.term.cols, rows: d.term.rows }));
    } else if (m.t === "reset") {
      d.term.reset();
      d.epoch = m.epoch;
      d.seq = 0;
    } else if (m.t === "out") {
      d.term.write(b64(m.data));
      d.seq = m.seq;
    } else if (m.t === "got") d.typing.got(m.id);
    else if (m.t === "line") {
      state(d, m.up ? "" : `Waiting for ${d.machine || "its machine"}…`);
      if (m.up) d.typing.says(!!m.acks);
    } else if (m.t === "lease") {
      // Not taken, and not to go again later: the page says to type it again.
      if (m.id) d.typing.got(m.id);
      lease(d);
    } else if (m.t === "end") {
      d.ws = null;
      ws.close();
      ended(d, m);
    }
  };
  ws.onclose = (e) => {
    if (d.ws !== ws || d.gone || d.ended) return;
    d.ws = null;
    d.typing.closed();
    if (e.code === 4401) return ended(d, { why: "you signed out" });
    // Not there: after the server restarted, its machine says it has it a moment later. Asked again a while, then
    // it's gone.
    if (e.code === 4404) {
      d.since ||= Date.now();
      if (Date.now() - d.since > 30e3) return ended(d, { why: "the server no longer has it" });
    }
    state(d, "Reconnecting…");
    d.retry = setTimeout(() => listen(d), Math.min(5000, 250 * 2 ** d.tries++));
  };
}

function ended(d: Dock, { why, code }: { why?: string; code?: number } = {}) {
  if (d !== dock) return;
  d.ended = true;
  d.term.options.cursorBlink = false;
  d.term.options.disableStdin = true;
  show({ state: "", lease: false, ended: { why, code } });
}

// Its machine stopped taking what's typed, as its server is elsewhere and what's typed isn't signed: sign to go on.
// The browser's key does that without a word; once that's gone, the passkey needs a press (Sign to keep typing,
// termLease).
async function lease(d: Dock) {
  if (d.leasing) return;
  d.leasing = true;
  const r = await post(`/api/terminals/${enc(d.tid)}/lease`, {});
  d.leasing = false;
  if (d !== dock) return;
  show({ lease: !r.ok });
  state(d, r.ok ? "What you just typed didn't reach it: type it again" : "");
  if (r.ok) setTimeout(() => state(d, ""), 5000);
}
export const termLease = () => dock && lease(dock);

const state = (d: Dock, text: string) => d === dock && show({ state: text });

// Typing goes as it's typed; what's typed while it's reconnecting goes once it's back (typing.ts).
function type(d: Dock, data: string) {
  if (!d.ended) d.typing.type(data);
}

// Its size follows the dock's: the shell hears it as a resize.
let refitTimer: ReturnType<typeof setTimeout> = null;
function refit(d: Dock) {
  if (d !== dock || d.min) return;
  try {
    d.fit.fit();
  } catch {
    return;
  }
  const size = `${d.term.cols}x${d.term.rows}`;
  if (size === d.size) return;
  d.size = size;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    if (d.ended || d !== dock || d.ws?.readyState !== WebSocket.OPEN) return;
    d.ws.send(JSON.stringify({ t: "size", cols: d.term.cols, rows: d.term.rows }));
  }, 80);
}

function sizeTo(h: number) {
  const px = Math.round(Math.max(160, Math.min(window.innerHeight - 100, h)));
  if (dock.el) dock.el.style.height = `${px}px`;
  dock.h = px;
  document.body.style.setProperty("--term-h", `${px}px`);
}
function setMin(min: boolean) {
  const d = dock;
  d.min = min;
  show({ min });
  document.body.classList.toggle("has-term", !min);
  document.body.style.setProperty("--term-h", `${d.h}px`);
  store.set(KEY_MIN, min ? d.tid : null);
  if (!min) {
    requestAnimationFrame(() => refit(d));
    d.term.focus();
  }
}
function restore() {
  setMin(false);
  return true;
}
function setMax(max: boolean) {
  const d = dock;
  d.max = max;
  show({ max });
  if (max) store.set(KEY_MAX, d.tid);
  else if (store.get(KEY_MAX) === d.tid) store.set(KEY_MAX, null);
  if (max) fillWindow();
  else {
    if (d.el) d.el.style.top = "";
    sizeTo(d.h);
  }
  // Pressing the button took the keys from it. On a phone that would bring the keyboard up over the room just made.
  if (!d.min && !matchMedia("(pointer: coarse)").matches) d.term.focus();
}
// Maximized, it starts under the top bar. A phone's keyboard covers the foot of the window without resizing it, and
// the browser pans the page to show the cursor, which can take the bar out of view: it keeps to what's left in view,
// its head included. Pinched in, it stays the window's size.
function fillWindow() {
  if (!dock?.max || !dock.el) return;
  const v = window.visualViewport;
  const seen = v?.scale === 1;
  const bar = document.querySelector(".top")?.getBoundingClientRect().bottom || 0;
  const top = Math.max(bar, seen ? v.offsetTop : 0);
  dock.el.style.top = `${top}px`;
  dock.el.style.height = seen ? `${v.offsetTop + v.height - top}px` : "";
}

// Its buttons, as the dock's head has them: hide it (Open terminal shows it again), maximize it or put it back,
// close it (its shell ends), and once it ended, open a new one.
export function termMin() {
  if (dock) setMin(!dock.min);
}
export function termMax(on = !dock?.max) {
  if (dock) setMax(on);
}
export async function termClose() {
  const d = dock;
  if (!d) return;
  if (!d.ended) await fetch(`/api/terminals/${enc(d.tid)}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  store.set(KEY_MIN, null);
  store.set(KEY_MAX, null);
  leaveTerminal();
}
export async function termAgain() {
  const d = dock;
  if (!d) return;
  leaveTerminal();
  await openTerminal({ id: d.post, machine: d.machine }, { max: d.max });
}
// Its top edge resizes it (`grip` the edge, pressed); a double-click maximizes it.
export function termGrip(grip: HTMLElement, e: PointerEvent) {
  const d = dock;
  if (!d || d.min) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const from = e.clientY;
  const was = d.h;
  const move = (m: PointerEvent) => sizeTo(was + (from - m.clientY));
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    store.set(KEY_H, String(d.h));
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
}
