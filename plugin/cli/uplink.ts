// The CLI's line to its server. It keeps three conversations going:
// - ops, up: the store's own ops, from its log, from the last one the server acknowledged. Nothing is sent twice
//   or lost: the server skips what it has by number, and the log keeps what it hasn't acknowledged.
// - info, up: what the machine knows right now (its folders, what each post is doing), each key when it changes.
// - commands and reads, down: long-polled, each handed to `onCommand` and answered with what it returned.
// The CLI also asks its server things (`ask`): an agent's tasks, pages, the feed.
//
// A transport carries them: over HTTP to its server, with the machine's device token (httpTransport).
//
// What goes up has its secrets replaced on the way (`clean`, redact.ts): ops, info, the answers to reads and what it
// asks. Not the bytes of files (an agent's deliverable, a picture), and not a terminal's, which its person types in.

import crypto from "node:crypto";
import { opTo, OPS, PROTOCOL, takenFields } from "../shared/protocol.ts";
import { redactDeep } from "./redact.ts";
import { UplinkTables } from "../shared/storage/uplink.ts";
import type { TooBig } from "../shared/storage/uplink.ts";
import type { Store } from "../shared/store.ts";
import type { Prefs } from "../shared/types.ts";
import { IROH_HOST, type IrohNode } from "../shared/iroh.ts";

const BATCH_MS = Number(process.env.AGENTBOOK_UPLINK_MS || 250);
const BATCH = 500;
const BATCH_BYTES = 8 * 1024 * 1024; // the server reads 80 MB at once at most
// A server that doesn't answer is tried again after RETRY_MS, twice as long each time up to RETRY_MAX_MS, each wait
// up to half shorter at random, so machines that lost one server don't all come back at the same moment.
const RETRY_MS = Number(process.env.AGENTBOOK_UPLINK_RETRY_MS ?? 250);
const RETRY_MAX_MS = Number(process.env.AGENTBOOK_UPLINK_RETRY_MAX_MS || 60e3);
// What says its server won't have this machine's token. That can pass (a proxy, a server between versions), so it's tried
// once more as each new thread starts (tryAgain), and on nothing else: no timer, so a login that's really gone isn't asked
// about forever.
// What a call to the server threw: its HTTP status, a connection cut while it was sent (`reset`), what its answer said.
interface CallError extends Error {
  status?: number;
  reset?: boolean;
  code?: string;
  data?: { latest?: string | null; [k: string]: unknown };
}
const denied = (e: CallError) => e.status === 401 || e.status === 403;
// What says a batch is too big, for its server or for what's in front of it (a proxy's limit is often 1 MB): a 413, or
// a connection cut while it's sent, as this project's own server does past 80 MB. A cut can be anything else too, so one
// thing alone counts as too big only after RESET_TRIES of them in a row, and only from RESET_MIN up.
const tooBig = (e: CallError) => e.status === 413 || !!e.reset;
const RESET_TRIES = 3;
const RESET_MIN = 64 * 1024;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// A post's work (its steps, pictures, changes) and the gate's log: what goes to its server, and not to a peer.
const WORK = new Set(Object.keys(OPS).filter((k) => OPS[k].work || OPS[k].audit));

// `store`: the CLI's store. `info()`: what the machine knows now, as { key: value }. `onCommand(c)`: does a
// command or a read, and returns its answer. `epoch`: this store's own id, so the server tells a store it had
// from a new one.
// `onFresh()`: the server has nothing of this machine yet (a new server, or one that lost it): what was sent to one
// before is to be sent again. `onOwner(username)`: whose machine the server says this is, as it connects and with
// each batch of commands (the gate holds it to its first answer). `onPrefs(prefs)`: its person's settings this machine
// applies (Private terminals), said the same way. `onLatest(version)`: the newest agentbook-cli, if it says one, said
// the same way. `onConnect()`: it has just connected.
// `peer`: the page is another machine of this person's (linked: server/mesh.ts), by its name, not the server this
// machine logs in to. It gets the threads but not their work (the page asks this machine for it, as for any thread
// whose work wasn't sent), and the log keeps what it hasn't got (store.hold) as it does for its server.
const STATE_RETRY_MS = 5 * 60e3;

// A command or a read from the server, to do here: `cid`, its id; `args`, what it was asked with (`post`: the thread
// it's for, which a thread's commands are done in order of).
export interface Command {
  cid: string;
  kind: string;
  args?: { post?: string; [k: string]: unknown };
  [k: string]: unknown;
}
// What the server says as the CLI says hello: the last op it has of this machine (`cursor`), whether it has nothing
// of it (`empty`), how many ops it keeps until it's updated (`parked`), and what it says of the machine.
export interface Hello {
  cursor: number;
  empty?: boolean;
  parked?: number;
  owner?: string | null;
  prefs?: Prefs | null;
  latest?: string | null;
}
// What it says to a push: the last op it has now, or why it refused.
export interface Pushed {
  acked?: number;
  error?: string;
  parked?: number;
}
// What carries the conversations: httpTransport, or a test's. What comes back is what its server said, as it said it.
// `owner`, `prefs`, `latest`: what it said with its last batch of commands.
export interface Transport {
  name: string;
  hello(b: object): Promise<unknown>;
  push(b: object): Promise<unknown>;
  commands(wait: number): Promise<unknown>;
  result(cid: string, result: unknown): Promise<unknown>;
  ask?(method: string, route: string, body?: unknown, ms?: number): Promise<unknown>;
  termSocket?(): WebSocket;
  blobPut?(sha: string, buf: Buffer, type?: string): Promise<void>;
  blobGet?(id: string): Promise<Buffer | null>;
  owner?: string | null;
  prefs?: Prefs | null;
  latest?: string | null;
}
export interface UplinkOptions {
  store: Store;
  transport: Transport;
  info?: () => Record<string, unknown>;
  onCommand?: (c: Command) => unknown;
  epoch: string;
  onFresh?: () => void;
  // When the past starts, as its person said (ms): threads last touched before it stay on this machine.
  historyFrom?: () => number;
  version?: string | null;
  onOwner?: (username: string | null) => void;
  onPrefs?: (prefs: Prefs | null) => void;
  onLatest?: (version: string | null | undefined) => void;
  onConnect?: () => void;
  // Its server refused this machine's token (401 or 403), the first time in a row.
  onSignedOut?: () => void;
  clean?: <T>(v: T) => T;
  log?: (line: string) => void;
  retryMs?: number;
  retryMaxMs?: number;
  peer?: string | null;
}
export type Uplink = ReturnType<typeof createUplink>;
// An op as it goes up (protocol.ts's opTo).
type Op = NonNullable<ReturnType<typeof opTo>>;
// Info keys that changed (infoDiff): their values, their size, and whether there are more for the next batch.
interface InfoDiff {
  out: Record<string, unknown>;
  size: number;
  more: boolean;
}

export function createUplink({ store, transport, info = () => ({}), onCommand, epoch, onFresh = () => {}, historyFrom = () => 0, version = null, onOwner = () => {}, onPrefs = () => {}, onLatest = () => {}, onConnect = () => {}, onSignedOut = () => {}, clean = redactDeep, log = () => {}, retryMs = RETRY_MS, retryMaxMs = RETRY_MAX_MS, peer = null }: UplinkOptions) {
  let cursor: number | null = null; // the server's: the last op it has
  let scanned = 0; // the last op looked at here (ops that stay on the machine are skipped)
  let connected = false;
  let error: string | null = null;
  let gap: { from: number; to: number } | null = null; // { from, to }: ops a restored server lost that the log no longer keeps
  let blocked: string | null = null; // why its server won't have it, as opposed to can't be reached: it takes updating something
  let parked = 0; // what its server couldn't take, and keeps until it's updated
  let refused: { until: number; why: string } | null = null; // { until, why }: a state its server wouldn't take, offered again only after a while, as it's every thread it has
  let signedOut: string | null = null; // why its server stopped taking this machine's token: it stops trying, and logging in again restarts it
  let triedAt: string | null = null; // when it last tried while signedOut: the try that stopped it, or tryAgain's
  let refusals = 0; // 401s and 403s, each
  let trying: Promise<void> | null = null; // tryAgain's try, while it goes
  let polling = false; // commandsLoop is running
  let fails = 0; // tries in a row that failed
  let nextTry = 0; // not to try again before this (ms)
  let fitOps = BATCH; // what a batch holds: halved when one turns out too big, and back up, twice as much, with each that goes
  let fitBytes = BATCH_BYTES;
  let cuts: { of: number | string | null; n: number } = { of: null, n: 0 }; // connections cut in a row, sending one thing alone
  const retryIn = (n: number) => Math.min(retryMaxMs, retryMs * 2 ** n) * (0.5 + Math.random() / 2);
  let pushing: { again: boolean; promise?: Promise<void> } | null = null;
  let sentInfo = new Map<string, string>(); // key -> JSON last sent
  let infoDirty = true;
  // Commands done, with their answers, kept so one the server sends again (its answer was lost) isn't done twice
  // (commands_done). Ops too big for its server even alone (too_big): left out, so what comes after them goes. Each is
  // said in `status`, for a month. Both its store's, under its scope.
  const ledger = store.storage.use(UplinkTables, store.scope);
  const leftOut = new Map<number, TooBig>(ledger.tooBig().map((r): [number, TooBig] => [r.seq, r]));
  const pruneDone = () => {
    const month = new Date(Date.now() - 30 * 86400e3).toISOString();
    for (const [seq, r] of leftOut) if (r.at < month) leftOut.delete(seq);
    // Tidying, so it waits for a disk with room.
    try {
      ledger.forget({ done: new Date(Date.now() - 8 * 86400e3).toISOString(), tooBig: month });
    } catch {}
  };
  pruneDone();
  setInterval(pruneDone, 6 * 3600e3).unref?.();
  // What it ran from another machine's page is kept apart from what it ran from its own: each page numbers its
  // commands itself, so two can say the same id, and neither may be answered with what the other's command did. A
  // signed one's id is random (s…, server/core/commands.ts) and signed for this machine: it runs once, whichever page
  // brings it. Any other id stays its page's, signature or not, so no page reads another's answers by claiming one.
  const doneKey = (c: { cid: string; sig?: unknown }) => (peer && !(c.sig && /^s[\w-]{16,}$/.test(c.cid)) ? `${peer}:${c.cid}` : c.cid);
  const doneBefore = (c: { cid: string; sig?: unknown }) => {
    const json = ledger.doneResult(doneKey(c));
    if (json === undefined) return null;
    try {
      return { result: JSON.parse(json || "null") };
    } catch {
      return { result: { error: "Its answer is gone; ask again.", status: 410 } };
    }
  };
  const markDone = (c: { cid: string; sig?: unknown }, result: unknown) => {
    const json = JSON.stringify(result ?? null);
    ledger.markDone(doneKey(c), json.length <= 64 * 1024 ? json : JSON.stringify({ error: "Its answer was too long to keep; ask again.", status: 410 }));
  };
  const waiting = new Set<() => void>(); // flush() promises

  const say = (ok: boolean, why?: string) => {
    if (ok) fails = nextTry = 0;
    if (connected === ok && (ok || error === why)) return;
    connected = ok;
    error = ok ? null : why;
    log(ok ? `connected to ${transport.name}` : `can't reach ${transport.name}: ${why}`);
  };

  function signOut(e: CallError) {
    const again = !!signedOut;
    refusals++;
    signedOut = e.message;
    triedAt = new Date().toISOString();
    connected = false;
    error = e.message;
    if (again) log(`${transport.name} still refuses this machine's token (HTTP ${e.status}): it tries again as the next thread starts`);
    else log(`${transport.name} refused this machine's token (HTTP ${e.status}), so it stops trying, but once as each new thread starts, until it logs in again: ${e.message}`);
    if (!again) onSignedOut();
  }

  // One more try after a 401 or 403, as a thread starts: everything goes again if the server takes the token now, and
  // it stays stopped if it doesn't. -> once that's known.
  function tryAgain() {
    if (!signedOut) return Promise.resolve();
    if (trying) return trying;
    trying = (async () => {
      // One that fails for another reason (a connection dropped as it was reused) says nothing of the login: it's made
      // again once, at once, and then that's the try.
      for (let i = 0; i < 2 && signedOut; i++) {
        const was = refusals;
        triedAt = new Date().toISOString();
        tryOnce = true;
        const p = push();
        tryOnce = false;
        await p;
        if (refusals !== was) break;
      }
    })().finally(() => {
      trying = null;
      if (!signedOut && started && !polling) commandsLoop();
    });
    return trying;
  }
  let tryOnce = false; // lets that one push past signedOut

  // What the server has of this machine, as it last said: the log keeps everything after it (store.setAcked). It only
  // says what the log may prune, so one that can't be saved (a full disk) stops nothing, and what's waiting still goes.
  let ackFailing = false;
  const ack = (seq: number) => {
    try {
      if (peer) store.hold?.(peer, seq);
      else store.setAcked?.(seq);
      ackFailing = false;
    } catch (e) {
      if (!ackFailing) log(`couldn't save how far its server has got: ${e.message}`);
      ackFailing = true;
    }
  };

  async function connect() {
    let h: Hello;
    try {
      h = (await transport.hello({ epoch, protocol: PROTOCOL, version, takes: takenFields() })) as Hello;
    } catch (e) {
      // Too old for its server: said with the newest there is, which a machine that updates itself then goes to.
      if (e.status === 426) {
        blocked = e.message;
        onLatest(e.data?.latest);
      }
      throw e;
    }
    // It takes this machine's token: a stop for a 401 or 403 is over (tryAgain).
    if (signedOut) {
      signedOut = null;
      triedAt = null;
      log(`${transport.name} takes this machine's token again`);
    }
    if (h.parked !== undefined) parked = h.parked;
    // A store newer than what the server had (a new install, a restored backup): number on from the server's, so
    // no id is made twice.
    if (h.cursor > store.state.seq) store.state.seq = h.cursor;
    // A server with less of this machine than it acknowledged before was restored from a backup: everything after
    // what it has now goes again, from the log, and its posts' work with it (onFresh). Ops the log no longer keeps
    // (pruned, older than 30 days) can't: it says so.
    const had = store.acked?.() || 0;
    const back = !peer && !h.empty && h.cursor < had;
    // A peer the log didn't keep everything for (linked before this machine kept what peers hadn't got): said.
    if (peer && !h.empty) {
      const pruned = store.pruned?.() || 0;
      gap = pruned > h.cursor ? { from: h.cursor + 1, to: pruned } : null;
      if (gap) log(`${transport.name} has this machine's changes up to ${h.cursor}, and ${gap.from}–${gap.to} aren't kept here any more`);
    }
    cursor = h.cursor;
    scanned = h.cursor;
    ack(h.cursor);
    if (back) {
      const pruned = store.pruned?.() || 0;
      gap = pruned > h.cursor ? { from: h.cursor + 1, to: pruned } : null;
      log(`${transport.name} has this machine's changes up to ${h.cursor}, not ${had} as it said before (restored from a backup?): sending them again${gap ? `, but ${gap.from}–${gap.to} aren't kept here any more` : ""}`);
    }
    if (h.owner !== undefined) onOwner(h.owner);
    if (h.prefs !== undefined) onPrefs(h.prefs);
    onLatest(h.latest);
    // The server has nothing of this machine yet: what it has goes whole, once, and its posts' work after it. What
    // changes while that goes up has a later number, and goes up after it, as ops; the work starts once it's there
    // (a push that fails is tried again, without starting it over each time).
    if (h.empty && Object.keys(store.state.sessions).length) {
      if (refused && Date.now() < refused.until) throw new Error(refused.why);
      const s = store.state;
      const at = s.seq;
      // Every thread's whole history, with what's out of memory.
      // Threads last touched before where its person said the past starts stay on this machine.
      const from = historyFrom();
      const stale = (t) => from && (Date.parse(t.updated || t.started) || 0) < from;
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([, t]) => !stale(t)));
      const kept = (rows) => rows.filter((r) => !r.post || r.post in sessions);
      const procs = Object.fromEntries(Object.entries(s.procs).filter(([, post]) => post in sessions));
      const state = { seq: at, agents: s.agents, sessions, launches: s.launches, questions: kept(store.whole("questions")), files: kept(store.whole("files")), messages: kept(store.whole("messages")), procs };
      const body = { state: clean(state), epoch, ops: [] };
      let r: Pushed;
      try {
        r = (await transport.push(body)) as Pushed;
      } catch (e) {
        // All it has at once can't be halved: it's refused, like any state its server won't take, and not sent again at
        // each try.
        const size = tooBig(e) ? JSON.stringify(body).length : 0;
        if (e.status !== 413 && size < RESET_MIN) throw e;
        r = { error: `all of them at once, ${mb(size)}, were too much for it (${e.message})` };
      }
      // Going on would mark them as sent, so the next op would leave the server with nothing of them, for good.
      if (r.error) {
        blocked = `${transport.name} didn't take this machine's threads, so nothing goes up until it does: ${r.error}`;
        refused = { until: Date.now() + STATE_RETRY_MS, why: blocked };
        log(blocked);
        throw new Error(blocked);
      }
      refused = null;
      cursor = scanned = Math.max(r.acked || 0, at);
      ack(cursor);
    }
    blocked = null;
    if (h.empty || back) onFresh();
    sentInfo = new Map();
    infoDirty = true;
    say(true);
    onConnect();
  }

  // The info keys that changed since they were last sent (null for one that's gone), as many as fit in `room`, or one
  // at least if it `must` (a batch with nothing else in it). `more`: there are others, for the next batch.
  function infoDiff(room: number, must: boolean): InfoDiff | null {
    const now = info() || {};
    const out: Record<string, unknown> = {};
    let size = 0;
    let any = false;
    let more = false;
    const add = (k: string, v: unknown, json: string) => {
      if (size + json.length > room && (any || !must)) return void (more = true);
      out[k] = v;
      size += k.length + json.length;
      any = true;
    };
    for (const [k, v] of Object.entries(now)) {
      const json = JSON.stringify(v ?? null);
      if (sentInfo.get(k) !== json) add(k, v ?? null, json);
    }
    for (const k of sentInfo.keys()) if (!(k in now)) add(k, null, "null");
    return any || more ? { out, size, more } : null;
  }

  // A batch too big for its server: half of it goes next, and so on down to one thing alone. One that's still too big
  // is left out for good, as nothing after it could go otherwise, and `status` says so. It throws what isn't about size.
  function shrink(e: CallError, ops: Op[], bytes: number, diff: InfoDiff | null) {
    const size = bytes + (diff?.size || 0);
    const keys = Object.keys(diff?.out || {});
    infoDirty ||= !!diff;
    if (ops.length + keys.length > 1) {
      if (ops.length > 1) fitOps = Math.ceil(ops.length / 2);
      fitBytes = Math.max(1, Math.floor(size / 2));
      return;
    }
    const of = ops[0]?.seq ?? keys[0];
    if (cuts.of !== of) cuts = { of, n: 0 };
    if (e.status !== 413 && (size < RESET_MIN || ++cuts.n < RESET_TRIES)) throw e;
    if (!ops.length) {
      // What the machine knows now, so it goes again once it changes.
      sentInfo.set(keys[0], JSON.stringify(diff.out[keys[0]]));
      return log(`what this machine says of ${keys[0]} is too big for ${transport.name} (${mb(size)}: ${e.message}), so it's left out until it changes`);
    }
    const [o] = ops;
    const post = o.args?.post;
    const row: TooBig = { seq: o.seq, kind: o.kind, post: typeof post === "string" ? post : null, bytes: size, at: new Date().toISOString() };
    leftOut.set(o.seq, row);
    // Only its own server's: what's too big for a peer may not be for it.
    try {
      if (!peer) ledger.keepTooBig(row);
    } catch {} // kept in memory until it restarts, and found out again then
    log(`${o.kind} ${o.seq}${row.post ? ` on thread ${row.post}` : ""} is too big for ${transport.name} even alone (${mb(size)}: ${e.message}), so it's left out, and what comes after it goes on`);
  }

  async function pushOnce() {
    if (cursor === null) await connect();
    const ops: Op[] = [];
    let last = scanned;
    let bytes = 0;
    for (const op of store.since(scanned)) {
      const sent = leftOut.has(op.seq) ? null : opTo(op);
      const o = sent && !(peer && WORK.has(sent.kind)) ? clean(sent) : null;
      const size = o ? JSON.stringify(o).length : 0;
      // A batch stays well under what the server reads at once (one op bigger than that goes alone).
      if (ops.length && bytes + size > fitBytes) break;
      last = op.seq;
      if (o) ops.push(o), (bytes += size);
      if (ops.length >= fitOps) break;
    }
    const changed = infoDirty ? infoDiff(fitBytes - bytes, !ops.length) : null;
    infoDirty = !!changed?.more;
    const diff = changed && Object.keys(changed.out).length ? changed : null;
    if (!ops.length && !diff) {
      scanned = last;
      return;
    }
    let r: Pushed;
    try {
      r = (await transport.push({ ops, info: diff ? clean(diff.out) : null, epoch })) as Pushed;
    } catch (e) {
      if (!tooBig(e)) throw e;
      shrink(e, ops, bytes, diff);
      return pushOnce();
    }
    if (r.error && !r.acked) throw new Error(r.error);
    if (r.error) log(`the server refused an op: ${r.error}`);
    if (r.parked !== undefined) parked = r.parked;
    cursor = r.acked ?? cursor;
    scanned = last;
    ack(cursor);
    forgetWork(cursor);
    if (diff) for (const [k, v] of Object.entries(diff.out)) v === null ? sentInfo.delete(k) : sentInfo.set(k, JSON.stringify(v));
    say(true);
    const full = ops.length >= fitOps || bytes > fitBytes / 2 || infoDirty;
    fitOps = Math.min(BATCH, fitOps * 2);
    fitBytes = Math.min(BATCH_BYTES, fitBytes * 2);
    if (full) return pushOnce();
  }

  // Send what's waiting now: once at a time, and once more if something came in meanwhile.
  function push() {
    if (stopped) return Promise.resolve();
    if (pushing) {
      pushing.again = true;
      return pushing.promise;
    }
    if (!tryOnce && (signedOut || (cursor === null && Date.now() < nextTry))) return Promise.resolve();
    const job: { again: boolean; promise?: Promise<void> } = { again: false };
    job.promise = (async () => {
      try {
        do {
          job.again = false;
          await pushOnce();
        } while (job.again);
      } catch (e) {
        cursor = null; // connect again first
        if (denied(e)) signOut(e);
        else {
          say(false, e.code === "ERR_SQLITE_ERROR" ? `this machine's database failed: ${e.message}` : e.message);
          nextTry = Date.now() + retryIn(fails++);
        }
      } finally {
        pushing = null;
        for (const w of [...waiting]) w();
      }
    })();
    pushing = job;
    return job.promise;
  }

  // Send what's waiting, and wait up to `ms` for the server to have it.
  async function flush(ms = 1500) {
    await Promise.race([push(), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  async function commandsLoop() {
    // A server that isn't up yet is tried again soon, then less and less often. This keeps its own count, as ops can go
    // up while this fails, and never goes before what a failed push waits for.
    polling = true;
    try {
      await poll();
    } finally {
      polling = false;
    }
  }
  async function poll() {
    for (let polls = 0; !signedOut && !stopped; ) {
      try {
        if (cursor === null) await push();
        if (signedOut) return;
        if (cursor === null) throw new Error(error || "not connected");
        const list = (await transport.commands(25e3)) as Command[];
        // A wait that began before a 401 or 403 stopped it: what came with it comes again once it's back.
        if (signedOut) return;
        polls = 0;
        say(true);
        if (transport.owner !== undefined) onOwner(transport.owner);
        if (transport.prefs !== undefined) onPrefs(transport.prefs);
        onLatest(transport.latest);
        for (const c of list) run(c);
      } catch (e) {
        if (denied(e)) return signOut(e);
        say(false, e.message);
        await new Promise((r) => setTimeout(r, Math.max(retryIn(polls++), nextTry - Date.now())));
      }
    }
  }

  const running = new Set<string>();
  const inOrder = new Map<string, Promise<unknown>>(); // post -> its commands' chain
  function run(c: Command) {
    const post = !String(c.kind).startsWith("read.") && (c.args?.post || null);
    if (!post) return runOne(c);
    const chain = (inOrder.get(post) || Promise.resolve()).then(() => runOne(c)).catch(() => {});
    inOrder.set(post, chain);
    chain.then(() => inOrder.get(post) === chain && inOrder.delete(post));
    return chain;
  }
  async function runOne(c: Command) {
    const before = doneBefore(c);
    if (before) return transport.result(c.cid, clean(before.result)).catch(() => {});
    if (running.has(c.cid)) return;
    running.add(c.cid);
    let r: unknown;
    try {
      r = await onCommand(c);
    } catch (e) {
      r = { error: e.message, status: e.status || 500 };
    } finally {
      running.delete(c.cid);
    }
    // Reads are asked again freely; what changes something is done once. One that can't be remembered is still answered.
    if (!String(c.kind).startsWith("read.")) {
      try {
        markDone(c, r);
      } catch (e) {
        log(`couldn't keep ${c.kind}'s answer: ${e.message}`);
      }
    }
    // What it changed goes up before the answer, so the page shows it when it hears back.
    await push();
    await transport.result(c.cid, clean(r ?? {})).catch((e) => log(`couldn't answer ${c.kind}: ${e.message}`));
  }

  // A post's work (its steps, pictures, changes) and the gate's log are the server's to keep: once it has them,
  // they go from here (the gate's own log stays in cli/audit.jsonl).
  function forgetWork(upTo: number) {
    if (peer) return;
    try {
      store.tables.dropOps(upTo, [...WORK]);
    } catch {}
  }

  let started = false;
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  return {
    start() {
      if (started) return;
      started = true;
      timers.push(setInterval(() => push(), BATCH_MS));
      timers.at(-1).unref?.();
      // What changed goes up right away, a moment later, so the page shows it as it happens.
      let soon: NodeJS.Timeout | null = null;
      store.onChange(() => {
        soon ||= setTimeout(() => {
          soon = null;
          push();
        }, 20);
      });
      // What the machine knows changes on its own too (a post's runtime, what it's doing): looked at now and then.
      timers.push(setInterval(() => (infoDirty = true), 2000));
      timers.at(-1).unref?.();
      commandsLoop();
    },
    // For good: a peer unlinked, or linked again with a new token (a new uplink takes its place).
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
    },
    push,
    flush,
    infoChanged: () => {
      infoDirty = true;
    },
    // A routine's code and prompt go as they are: they run on this machine as written (a secret in one is its
    // author's to take out). So do a dashboard's queries, which its server runs as written.
    ask: (method: string, route: string, body?: unknown, ms?: number) => transport.ask(method, route, /^\/(routines|dashboards|sources)\//.test(route) ? body : clean(body), ms),
    // The terminals' line (terminals.ts): a WebSocket for what's typed in them, down, and what they show, up.
    termSocket: () => transport.termSocket?.() ?? null,
    // Bytes to keep on the server (a picture an agent saw, a file it made): their sha256 once it has them.
    blobPut: async (buf: Buffer, type?: string) => {
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      await transport.blobPut(sha, buf, type);
      return sha;
    },
    // A file someone sent from the page, by its upload: its bytes.
    blob: async (ref: { id: string; name: string }) => {
      const buf = await transport.blobGet(ref.id);
      if (!buf) throw Object.assign(new Error(`${ref.name} isn't on the server any more`), { status: 410 });
      return buf;
    },
    // `waiting`: changes not sent up yet (some stay on the machine, and only count until they're looked at).
    tryAgain,
    status: () => ({ server: transport.name, connected, error, waiting: Math.max(0, store.state.seq - scanned), cursor, seq: store.state.seq, scanned, ...(gap ? { gap } : {}), ...(blocked ? { blocked } : {}), ...(parked ? { parked } : {}), ...(signedOut ? { signed_out: signedOut, signed_out_tried: triedAt } : {}), ...(leftOut.size ? { too_big: { count: leftOut.size, last: [...leftOut.values()].at(-1) } } : {}) }),
  };
}

// Over HTTP, to a server elsewhere, with this machine's device token. `fetch`: what carries each call, when it isn't
// TCP (irohTransport), and `name` what the uplink calls it then.
type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<Response>;
// `token`: the machine's device token there; null over iroh, where the connection says which machine is calling.
export function httpTransport({ url, token, timeout = 30e3, fetch = globalThis.fetch, name }: { url: string; token: string | null; timeout?: number; fetch?: Fetch; name?: string }): Transport {
  const base = String(url).replace(/\/$/, "");
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const shown = name || base;
  // -> what the server answered, as it said it.
  async function call(method: string, route: string, body?: unknown, ms = timeout) {
    let r: Response;
    try {
      r = await fetch(`${base}/api/cli${route}`, { method, headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      const code = e.cause?.code;
      throw Object.assign(new Error(e.name === "TimeoutError" ? `${shown} didn't answer in time` : code === "ECONNREFUSED" ? `${shown} isn't running` : e.cause?.message || e.message), { reset: ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code) });
    }
    const data = (await r.json().catch(() => ({}))) as { error?: string; [k: string]: unknown };
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error(data.error || "the server doesn't know this machine: log in again with agentbook-cli login"), { status: r.status });
    if (!r.ok) throw Object.assign(new Error(data.error || `the server answered HTTP ${r.status}`), { status: r.status, data });
    return data;
  }
  const t: Transport = {
    name: shown,
    hello: (b) => call("POST", "/hello", b),
    push: (b) => call("POST", "/ops", b, 120e3),
    // What the server wants done.
    commands: async (wait) => {
      const d = (await call("GET", `/commands?wait=${Math.round(wait / 1000)}`, undefined, wait + 10e3)) as { commands?: Command[]; owner?: string | null; prefs?: Prefs | null; latest?: string | null };
      if (d.owner !== undefined) t.owner = d.owner;
      if (d.prefs !== undefined) t.prefs = d.prefs;
      t.latest = d.latest;
      return d.commands || [];
    },
    result: (cid, result) => call("POST", "/results", { cid, result }),
    // `ms`: how long it may take (a routine's test run waits for its code to run on a machine).
    ask: (method, route, body, ms) => call(method, `/ask${route}`, body, ms),
    ...(fetch === globalThis.fetch ? { termSocket: () => new WebSocket(`${base.replace(/^http/, "ws")}/api/cli/terminals/ws`, { headers: auth }) } : {}),
    blobPut: async (sha, buf, type) => {
      const r = await fetch(`${base}/api/cli/blobs/${sha}`, { method: "PUT", headers: { ...auth, "content-type": type || "application/octet-stream" }, body: buf, signal: AbortSignal.timeout(300e3) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${r.status}`);
    },
    blobGet: async (id) => {
      const r = await fetch(`${base}/api/cli/blobs/${encodeURIComponent(id)}`, { headers: auth, signal: AbortSignal.timeout(300e3) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
  return t;
}

// Over iroh (../shared/iroh.ts), to the page of another machine of yours, by its key: the same calls, each on a stream
// of its own. No terminals: those go only to the machine's own page.
// To the machine with `key`, over iroh: no token, as its page takes the machine from the connection, which proved this
// one's key (server/api/cli.ts, machineOf).
export function irohTransport({ node, key, name }: { node: IrohNode; key: string; name: string }): Transport {
  return httpTransport({ url: `http://${IROH_HOST}`, token: null, name: `${name} over iroh`, fetch: (u, init) => node.fetch(key, u, init) });
}

// A store's own id, made once: the server tells a store it had from one that started over by it.
export function epochOf(store: Store) {
  const was = store.tables.meta("epoch");
  if (was) return was;
  const e = crypto.randomBytes(8).toString("hex");
  store.tables.setMeta("epoch", e);
  return e;
}
