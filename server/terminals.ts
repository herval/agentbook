// Terminals: one shell per thread, in its folder, on its machine, for the thread's owner, kept until they close it or
// its shell exits. The machine's gate opens it (term.open, through the relay, signed when the machine wants it), or a
// run of one of the thread's code blocks does (post.run, plugin/cli/runs.ts); the machine holds the shell
// (plugin/cli/terminals.ts). What's typed goes down and what it shows comes up on two kinds of WebSocket (ws.ts):
// each page's own, and one line per machine for all its terminals. It's kept in memory only, since what's typed can
// be a password: never in a database, never in a log. What's typed is kept here only until its shell has it: its
// machine stopping takes what's on its way with it, so it goes again once the machine is back, under the id it came
// with, and the holder of the shell takes an id once. A page does the same for this server stopping (web/lib/typing.ts).
//
// What the server knows of them, the machine can tell it again: as its line connects (after the server restarted, or
// the machine was away), it says which terminals it has, with what each showed lately, and a page that had one open
// picks up from there. A page sees it from any tab, after a reload, or on coming back to its thread, with what it
// showed lately. It ends when its shell does, when its person closes it, or when its machine is logged out; signing
// out only takes it off the pages that were signed in.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Iso } from "../plugin/shared/types.ts";

const KEPT = 256 * 1024; // what it showed lately, for a page that opens it again
const ENDED_MS = 60e3; // an ended one still says so this long, to a page that comes back to it
const TYPED_MAX = 64 * 1024; // typed that its shell hasn't got yet, for once its machine is back
const MAX = 16; // a person's open at once

// A WebSocket (ws.ts): a machine's line, or a page's for one terminal.
export interface TermSocket {
  send(text: string): unknown;
  close(code?: number, reason?: string): void;
  onMessage?: (text: string) => void;
  onClose?: () => void;
}
// What's typed, by the page's name for it, that its shell hasn't got yet.
interface Typed {
  id: string;
  data: string;
}
// A page watching a terminal, and its request, for who it's signed in as.
interface Watcher<R> {
  ws: TermSocket;
  req: R;
}
// A terminal (T): its id, machine, person and thread (the page's id for it); how it is, where it runs and in what
// shell; what it showed lately, in pieces numbered under `epoch` (a new one each time its machine says it again);
// what's typed its shell hasn't got; whether its machine says what its shell got (`acks`); the page's size; the
// pages watching it; and why it ended.
export interface Term<R = IncomingMessage> {
  tid: string;
  device: string;
  uid: string;
  post: string;
  state: "opening" | "open" | "ended";
  opened: Iso;
  cwd: string | null;
  shell: string | null;
  epoch: string;
  out: { seq: number; data: Buffer }[];
  kept: number;
  seq: number;
  typed: Typed[];
  acks: boolean;
  size: { cols: number; rows: number } | null;
  watchers: Set<Watcher<R>>;
  why: string | null;
  code: number | null;
  gone: ReturnType<typeof setTimeout> | null;
}
// What a machine's line says (plugin/cli/terminals.ts): `t` is what it is, the rest as it says.
interface LineMessage {
  t: string;
  tid?: string;
  id?: unknown;
  data?: unknown;
  code?: unknown;
  terms?: unknown;
  ended?: unknown;
}
// One of a machine's terminals, as it says it is.
interface Held {
  tid?: unknown;
  post?: unknown;
  cwd?: unknown;
  shell?: unknown;
  kept?: unknown;
  acks?: unknown;
}
// What a page sends on its terminal's WebSocket.
interface PageMessage {
  t: string;
  data?: unknown;
  id?: unknown;
  cols?: unknown;
  rows?: unknown;
}
export interface TerminalsHost<R> {
  whoIs: (req: R) => { id: string } | null;
  ownerOf: (device: string) => string | null;
  postOf: (device: string, local: string) => string | null;
  log?: (line: string) => void;
}

// `whoIs(req)`: who a page's sign-in is now (its cookie, asked again), or null. `ownerOf(device)`: the id of the
// person a machine is logged in as. `postOf(device, local)`: a machine's thread, as the server names it, or null when
// it has none by that id.
export type Terminals = ReturnType<typeof createTerminals>;
export function createTerminals<R = IncomingMessage>({ whoIs, ownerOf, postOf, log = () => {} }: TerminalsHost<R>) {
  type T = Term<R>;
  const terms = new Map<string, T>();
  const lines = new Map<string, TermSocket>(); // device -> its line (a WebSocket)
  const closing = new Map<string, Set<string>>(); // device -> Set of tids closed while it was away, for it once it's back

  const newId = () => `t${crypto.randomBytes(15).toString("base64url")}`;
  const isId = (tid: unknown): tid is string => typeof tid === "string" && /^t[\w-]{16,40}$/.test(tid);
  const summary = (T: T) => ({ id: T.tid, post: T.post, state: T.state, cwd: T.cwd, shell: T.shell, opened: T.opened, line: lines.has(T.device), acks: !!T.acks, ...(T.state === "ended" ? { why: T.why, code: T.code } : {}) });
  const of = (tid: string): T | null => terms.get(tid) || null;
  // The one of a person's for a thread, still going.
  const forPost = (uid: string, post: string): T | null => [...terms.values()].find((T) => T.uid === uid && T.post === post && T.state !== "ended") || null;
  const ofDevice = (device: string) => [...terms.values()].filter((T) => T.device === device);
  const tell = (device: string, msg: Record<string, unknown>): boolean => {
    try {
      lines.get(device)?.send(JSON.stringify(msg));
      return lines.has(device);
    } catch {
      return false;
    }
  };
  const toPage = (w: Watcher<R>, msg: Record<string, unknown>) => {
    try {
      w.ws.send(JSON.stringify(msg));
    } catch {}
  };

  function make({ tid, device, uid, post, state, cwd = null, shell = null }: Pick<T, "tid" | "device" | "uid" | "post" | "state"> & Partial<Pick<T, "cwd" | "shell">>): T {
    const T: T = { tid, device, uid, post, state, opened: new Date().toISOString(), cwd, shell, epoch: newId().slice(1, 9), out: [], kept: 0, seq: 0, typed: [], acks: false, size: null, watchers: new Set(), why: null, code: null, gone: null };
    terms.set(tid, T);
    return T;
  }
  // A new one, opening from the page: its machine's gate hasn't said yet. -> T, or { error, status }.
  function open({ tid, device, uid, post }: { tid: unknown; device: string; uid: string; post: string }): T | { error: string; status: number } {
    if (!isId(tid) || terms.has(tid)) return { error: "That terminal's id won't do.", status: 400 };
    if ([...terms.values()].filter((T) => T.uid === uid && T.state !== "ended").length >= MAX) return { error: `You have ${MAX} terminals open already. Close one first.`, status: 429 };
    return make({ tid, device, uid, post, state: "opening" });
  }
  // Its machine opened it, where and with what (`tid`: the thread's own, when it had one already). -> the one it is.
  function opened(T: T, { tid = T.tid, cwd = null, shell = null }: { tid?: unknown; cwd?: unknown; shell?: unknown } = {}): T {
    if (tid !== T.tid && isId(tid)) {
      drop(T);
      const had = terms.get(tid);
      if (had && had.device === T.device && had.state !== "ended") return had;
      T = make({ tid, device: T.device, uid: T.uid, post: T.post, state: "open" });
    }
    if (T.state === "opening") T.state = "open";
    if (typeof cwd === "string") T.cwd = cwd.slice(0, 2000);
    if (typeof shell === "string") T.shell = shell.slice(0, 80);
    return T;
  }
  // Its machine didn't open it: it goes.
  function drop(T: T) {
    if (terms.get(T.tid) === T && T.state === "opening") terms.delete(T.tid);
  }

  // What it showed, kept for pages that open it later, and to every page watching now.
  function push(T: T, buf: Buffer) {
    const p = { seq: ++T.seq, data: buf };
    T.out.push(p);
    T.kept += buf.length;
    while (T.kept > KEPT && T.out.length > 1) T.kept -= T.out.shift().data.length;
    for (const w of T.watchers) toPage(w, { t: "out", seq: p.seq, data: buf.toString("base64") });
  }
  // What its machine says it showed lately, in place of what the server had: every page draws it again.
  function reset(T: T, kept: unknown) {
    T.epoch = newId().slice(1, 9);
    T.out = [];
    T.kept = 0;
    T.seq = 0;
    for (const w of T.watchers) toPage(w, { t: "reset", epoch: T.epoch });
    const buf = typeof kept === "string" ? Buffer.from(kept, "base64") : null;
    if (buf?.length) push(T, buf.length > KEPT ? buf.subarray(buf.length - KEPT) : buf);
  }

  /* ---------- its machine's line ---------- */

  // A machine's line, connected: it says what terminals it has, then what they show, and hears what's typed in them.
  function machine(device: string, ws: TermSocket) {
    const old = lines.get(device);
    lines.set(device, ws);
    old?.close(4000, "Another line from this machine took over.");
    ws.onMessage = (text) => {
      let m: LineMessage;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m.t === "hello") hello(device, m);
      else if (m.t === "open") adopt(device, m);
      else if (m.t === "out") {
        const T = terms.get(m.tid);
        if (T?.device === device && T.state !== "ended" && typeof m.data === "string" && m.data) push(T, Buffer.from(m.data, "base64"));
      } else if (m.t === "got") {
        const T = terms.get(m.tid);
        if (T?.device !== device) return;
        T.typed = T.typed.filter((x) => x.id !== m.id);
        for (const w of T.watchers) toPage(w, { t: "got", id: m.id });
      } else if (m.t === "lease") {
        // What was typed wasn't taken: its time ran out, and it takes a signature to go on. It isn't kept to go
        // again later: the page says to type it again.
        const T = terms.get(m.tid);
        if (T?.device !== device) return;
        if (typeof m.id === "string") T.typed = T.typed.filter((x) => x.id !== m.id);
        for (const w of T.watchers) toPage(w, { t: "lease", id: typeof m.id === "string" ? m.id : undefined });
      } else if (m.t === "exit") {
        const T = terms.get(m.tid);
        if (T?.device === device) end(T, Number.isSafeInteger(m.code) ? "its shell exited" : "its shell was ended", typeof m.code === "number" && Number.isSafeInteger(m.code) ? m.code : null);
      }
    };
    ws.onClose = () => {
      if (lines.get(device) !== ws) return;
      lines.delete(device);
      for (const T of ofDevice(device)) for (const w of T.watchers) toPage(w, { t: "line", up: false });
    };
  }
  // What it has (and what ended while it was away); one the server had that it doesn't is gone.
  function hello(device: string, { terms: has = [], ended = [] }: LineMessage) {
    const listed = new Set<string>();
    for (const t of Array.isArray(has) ? has.slice(0, 64) : []) {
      const T = adopt(device, t);
      if (T) listed.add(T.tid);
    }
    for (const e of Array.isArray(ended) ? ended : []) {
      const T = terms.get(e?.tid);
      if (T?.device === device) end(T, "its shell exited", Number.isSafeInteger(e.code) ? e.code : null);
    }
    for (const T of ofDevice(device)) if (T.state === "open" && !listed.has(T.tid)) end(T, "its shell is gone (its machine restarted?)");
    closing.delete(device);
  }
  // One of its terminals, as it says it is: known again, or new (one a run opened). -> T, or null when it isn't one
  // the server will have (its thread isn't that machine's, or its person closed it while the machine was away).
  function adopt(device: string, { tid, post, cwd, shell, kept, acks }: Held): T | null {
    if (!isId(tid) || typeof post !== "string") return null;
    const id = postOf(device, post);
    let T = terms.get(tid);
    if (!id || (T && T.device !== device)) return void tell(device, { t: "gone", tid });
    if (closing.get(device)?.has(tid) || T?.state === "ended") return void tell(device, { t: "close", tid });
    T ||= make({ tid, device, uid: ownerOf(device), post: id, state: "open" });
    T.state = "open";
    // Whether it says what its shell got: an older machine, or a shell from before it updated, doesn't.
    T.acks = acks === true;
    if (typeof cwd === "string") T.cwd = cwd.slice(0, 2000);
    if (typeof shell === "string") T.shell = shell.slice(0, 80);
    reset(T, kept);
    for (const w of T.watchers) toPage(w, { t: "line", up: true, acks: T.acks });
    // What its shell hasn't got yet, and the page's size.
    if (T.size) tell(device, { t: "size", tid, ...T.size });
    for (const x of T.typed) tell(device, { t: "in", tid, ...x });
    if (!T.acks) T.typed = [];
    return T;
  }

  /* ---------- the page ---------- */

  // A page watching it, on its own WebSocket: `hello`, then what it showed since `from` ("<epoch>:<seq>", the last
  // piece the page has; all that's kept, after `reset`, when that's gone or it has none), then each piece as it
  // comes, and `end` when it ends. What the page sends: what's typed (`in`), its size, closing it.
  function page(T: T, ws: TermSocket, req: R, from: string | null | undefined): void {
    const w: Watcher<R> = { ws, req };
    toPage(w, { t: "hello", epoch: T.epoch, ...summary(T) });
    const [epoch, n] = String(from || "").split(":");
    const seq = Number(n);
    const since = epoch === T.epoch && Number.isSafeInteger(seq) && seq >= 0 && (!T.out.length || seq >= T.out[0].seq - 1) ? seq : null;
    if (since === null) toPage(w, { t: "reset", epoch: T.epoch });
    for (const p of T.out) if (since === null || p.seq > since) toPage(w, { t: "out", seq: p.seq, data: p.data.toString("base64") });
    if (T.state === "ended") {
      toPage(w, { t: "end", why: T.why, code: T.code });
      return void ws.close(1000);
    }
    T.watchers.add(w);
    ws.onMessage = (text) => {
      let m: PageMessage;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m.t === "in") type(T, m.data, m.id);
      else if (m.t === "size") resize(T, m.cols, m.rows);
      else if (m.t === "close") close(T);
    };
    ws.onClose = () => T.watchers.delete(w);
  }
  // What's typed (or pasted), for its machine; kept until its shell has it. `id`: what the page calls it, the same
  // each time it sends it. A page that doesn't name it (one loaded before this) gets a name for it here.
  function type(T: T, data: unknown, id: unknown) {
    if (T.state === "ended" || typeof data !== "string" || !data) return;
    const x = { id: typeof id === "string" && /^[\w.-]{1,40}$/.test(id) ? id : newId(), data };
    if (T.typed.some((t) => t.id === x.id)) return;
    const sent = T.state === "open" && tell(T.device, { t: "in", tid: T.tid, ...x });
    if ((!sent || T.acks) && T.typed.reduce((all, t) => all + t.data.length, data.length) <= TYPED_MAX) T.typed.push(x);
  }
  function resize(T: T, cols: unknown, rows: unknown) {
    const c = Math.round(Number(cols));
    const r = Math.round(Number(rows));
    if (!(c >= 2 && c <= 500 && r >= 1 && r <= 300) || T.state === "ended") return;
    T.size = { cols: c, rows: r };
    if (T.state === "open") tell(T.device, { t: "size", tid: T.tid, cols: c, rows: r });
  }
  // Closed by its person: its shell hangs up (once its machine is back, when it's away).
  function close(T: T, why = "you closed it") {
    if (T.state === "ended") return;
    if (!tell(T.device, { t: "close", tid: T.tid })) {
      if (!closing.has(T.device)) closing.set(T.device, new Set());
      closing.get(T.device).add(T.tid);
    }
    end(T, why);
  }

  /* ---------- ending ---------- */

  function end(T: T, why: string, code: number | null = null) {
    if (T.state === "ended") return;
    Object.assign(T, { state: "ended", why, code, typed: [] });
    for (const w of T.watchers) {
      toPage(w, { t: "end", why, code });
      w.ws.close(1000);
    }
    T.watchers.clear();
    log(`terminal ${T.tid}: ended (${why})`);
    T.gone = setTimeout(() => terms.get(T.tid) === T && terms.delete(T.tid), ENDED_MS);
    T.gone.unref?.();
  }

  // Sign-ins ended (signing out, a new password, an account turned off): pages no longer signed in as a terminal's
  // person stop watching it. Its shell goes on, for when they're back.
  function check() {
    for (const T of terms.values())
      for (const w of [...T.watchers]) {
        if (whoIs(w.req)?.id === T.uid) continue;
        T.watchers.delete(w);
        w.ws.close(4401, "Signed out");
      }
  }
  // A machine logged out (or its person's account turned off): its terminals end, and its line goes.
  function forget(device: string) {
    for (const T of ofDevice(device)) close(T, "its machine was logged out");
    closing.delete(device);
    lines.get(device)?.close(4403, "Logged out");
    lines.delete(device);
  }

  return { newId, isId, open, opened, drop, of, forPost, summary, machine, page, close, check, forget, get size() { return terms.size; } };
}
