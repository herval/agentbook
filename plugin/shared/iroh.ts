// Your machines over iroh: one iroh endpoint per machine, made with the key `agentbook login`
// made for it, so the relay's list of the account's machines, which has each one's key, is also how to dial it. What
// one page asks of another (/api/cli/...) is an HTTP exchange over a QUIC stream of its own, on the one connection kept
// to that machine, and the page's own HTTP server answers it, as it answers one over TCP. The connection is encrypted
// between the two machines' keys, direct when they can reach each other and through an iroh relay when not; a relay
// sees which key talks to which, never what they say.
//
// The page starts it (server/mesh.ts), once its machine is on an account; its daemon sends its threads over it
// (plugin/cli/main.ts). One for the whole process, whichever copy of this file each loaded.
//
// The package is native (@number0/iroh, from npm install) and loaded only here, as it's needed: a checkout that hasn't
// installed it, agentbook-cli's own release (no node_modules, and no page), or a machine it isn't built for (an Intel
// Mac) has no iroh, and links to none of your other machines.
//
// AGENTBOOK_IROH: "0" for none. "local" for tests: endpoints on 127.0.0.1 with no relay, each one's address in a file
// in AGENTBOOK_IROH_DIR, named by its key. Otherwise through the iroh relay at the address of the sign-in relay the
// machine logged in through (agentbook-relay runs n0's iroh-relay beside it), which is every machine of the account's
// too, since nothing says which relay a machine is on. AGENTBOOK_IROH_RELAY names another, for all of them.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import type { BiStream, Connection, Endpoint } from "@number0/iroh";

type Iroh = typeof import("@number0/iroh");
const IROH_PACKAGE: string = "@number0/iroh";

export const ALPN = "agentbook/1";
// n0's public relay, for development use only: to try iroh without agentbook-relay's (test/mesh.ts, AGENTBOOK_IROH=relay).
export const N0_IROH_RELAY = "https://use1-1.relay.n0.iroh.link./";
// The host a request over iroh says it's for: the connection says which machine it's to.
export const IROH_HOST = "agentbook.iroh";
// What goes in and out of a stream at a time: the package copies bytes into a plain array and back (iroh-ffi #276).
const CHUNK = 64 * 1024;
// How long a dial waits for the machine before it says it can't reach it (iroh gives up at 30 s).
const DIAL_MS = Number(process.env.AGENTBOOK_IROH_DIAL_MS || 10e3);
// A read on a stream can't be called off (iroh-ffi #294, #309): a call that went unanswered leaves one waiting. After
// this many on one connection, it's closed (which ends them) and the next call dials again.
const UNANSWERED_MAX = 3;

export type IrohHow = { mode: "off" } | { mode: "local"; dir: string } | { mode: "relay"; relay: string };
// `relay`: the sign-in relay this machine logged in through, whose address is its iroh relay's too.
export function irohHow(relay: string): IrohHow {
  const v = String(process.env.AGENTBOOK_IROH ?? "").trim();
  if (v === "0" || v === "off") return { mode: "off" };
  if (v === "local") return { mode: "local", dir: process.env.AGENTBOOK_IROH_DIR || path.join(os.tmpdir(), "agentbook-iroh") };
  return { mode: "relay", relay: process.env.AGENTBOOK_IROH_RELAY || relay };
}

// What a call over iroh takes: fetch's, for what the page and the daemon send.
export interface IrohInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}
// A stream from another machine, as the page's HTTP server gets it: `irohKey` is that machine's key, as the
// connection proved it.
export type IrohSocket = Duplex & { irohKey: string; remoteAddress: string };

export interface IrohNode {
  // This machine's key (base64url, as the relay keeps keys).
  key: string;
  // Where it meets other machines: "through <relay>", or "on 127.0.0.1" (tests).
  where: string;
  // An HTTP call to the machine with key `key`, over a stream of the connection to it: as fetch, from `url`'s path.
  fetch(key: string, url: string, init?: IrohInit): Promise<Response>;
  // Whether there's a connection to that machine now.
  connected(key: string): boolean;
  // How the connection to that machine goes now: "direct", or "relay" (through the iroh relay, which can't read it);
  // null with none.
  path(key: string): "direct" | "relay" | null;
  // Closes the connection to that machine, if there is one (it was unlinked).
  drop(key: string): void;
  close(): Promise<void>;
}

interface Held {
  node: IrohNode | null;
  starting: Promise<IrohNode | null> | null;
  // Why there's none: iroh isn't installed, or wouldn't start.
  why: string | null;
  // The page's HTTP server takes each stream another machine opens (server/main.ts).
  serve: ((s: IrohSocket) => void) | null;
}
const held: Held = ((globalThis as { [k: symbol]: Held })[Symbol.for("agentbook.iroh")] ??= { node: null, starting: null, why: null, serve: null });

export const irohNode = (): IrohNode | null => held.node;
// Why this machine has no endpoint, when it should (iroh isn't installed here), or null.
export const irohWhy = (): string | null => held.why;
// The page takes the streams other machines open, as connections to its HTTP server.
export function irohServe(serve: (s: IrohSocket) => void) {
  held.serve = serve;
}

const bytes = (b64: string) => Array.from(Buffer.from(b64, "base64url"));
const text = (s: string) => Array.from(Buffer.from(s));

// Starts this machine's endpoint, with its login key ({ x, d }: Ed25519, as a JWK has it). `admit(key)`: whether a
// machine connecting here with that key is let in (one on the account); any other is closed before a stream is read.
// -> the endpoint, or null when there's none (AGENTBOOK_IROH=0, or iroh isn't installed: irohWhy says).
export function startIroh(o: { key: { x: string; d: string }; admit: (key: string) => Promise<boolean>; log: (line: string) => void; relay: string }): Promise<IrohNode | null> {
  if (held.node) return Promise.resolve(held.node);
  const how = irohHow(o.relay);
  if (how.mode === "off") return Promise.resolve(null);
  return (held.starting ??= makeIroh({ ...o, how })
    .then(
      (node) => {
        held.node = node;
        held.why = null;
        o.log(`iroh: this machine is ${node.key.slice(0, 8)}… on iroh, ${node.where}`);
        return node;
      },
      (e) => {
        held.why = e.message;
        o.log(`iroh: ${e.message}`);
        return null;
      },
    )
    .finally(() => (held.starting = null)));
}

// An endpoint, as startIroh makes this process's (a test makes several). `serve`: what takes the streams other
// machines open (the page's HTTP server, as irohServe said, unless given). Throws why it can't.
export async function makeIroh({ key, admit, log, serve, how }: { key: { x: string; d: string }; admit: (key: string) => Promise<boolean>; log: (line: string) => void; serve?: (s: IrohSocket) => void; how: IrohHow }): Promise<IrohNode> {
  if (how.mode === "off") throw new Error("iroh is off here (AGENTBOOK_IROH=0)");
  let iroh: Iroh;
  try {
    // By a name esbuild can't follow, so no build bundles its native module: an agentbook started before iroh came
    // (its own reload check bundles every import it sees) builds this code, and so does build.ts.
    iroh = await import(IROH_PACKAGE);
  } catch (e) {
    log(`iroh: couldn't load @number0/iroh (${String(e.code || e.message).slice(0, 120)})`);
    throw new Error("iroh isn't installed here (npm install)");
  }
  let ep: Endpoint;
  try {
    const b = iroh.Endpoint.builder();
    iroh.presetMinimal(b);
    b.secretKey(bytes(key.d));
    b.alpns([text(ALPN)]);
    if (how.mode === "local") {
      b.relayMode(iroh.RelayMode.disabled());
      b.bindAddr("127.0.0.1:0");
    } else b.relayMode(iroh.RelayMode.customFromUrls([how.relay]));
    ep = await b.bind();
  } catch (e) {
    throw new Error(`iroh wouldn't start here (${e.message})`);
  }
  const self = Buffer.from(ep.id().toBytes()).toString("base64url");
  if (self !== key.x) {
    await ep.close().catch(() => {});
    throw new Error("iroh made another key than this machine's");
  }
  const served = serve ?? ((s: IrohSocket) => (held.serve ? held.serve(s) : s.destroy()));
  const keyOf = (c: Connection) => Buffer.from(c.remoteId().toBytes()).toString("base64url");

  // ---------- connections, one kept to each machine ----------
  // `unanswered`: the calls on it that went unanswered, as "GET /path", for the log once there are too many.
  const conns = new Map<string, { conn: Connection; unanswered: string[] }>();
  const dialing = new Map<string, Promise<Connection>>();
  // A connection to the machine with `k`, made either way: calls to it go over it, and the streams it opens are the
  // page's to answer.
  function keep(k: string, conn: Connection) {
    conns.set(k, { conn, unanswered: [] });
    const gone = () => {
      if (conns.get(k)?.conn === conn) conns.delete(k);
    };
    conn.closed().then(gone, gone);
    void (async () => {
      for (;;) {
        let bi: BiStream;
        try {
          bi = await conn.acceptBi();
        } catch {
          return gone();
        }
        served(Object.assign(streamOf(bi), { irohKey: k, remoteAddress: `iroh:${k}` }));
      }
    })();
  }
  const open = (k: string) => {
    const c = conns.get(k);
    return c && c.conn.closeReason() == null ? c : null;
  };
  // Where a machine's endpoint answers, in tests: its file.
  const addrFile = (k: string) => (how.mode === "local" ? path.join(how.dir, `${k}.json`) : null);
  function connection(k: string): Promise<Connection> {
    const c = open(k);
    if (c) return Promise.resolve(c.conn);
    let p = dialing.get(k);
    if (!p) {
      p = dial(k).finally(() => dialing.delete(k));
      dialing.set(k, p);
    }
    return p;
  }
  async function dial(k: string): Promise<Connection> {
    let addrs: string[] | null = null;
    if (how.mode === "local") {
      try {
        addrs = JSON.parse(fs.readFileSync(addrFile(k), "utf8")).addrs;
      } catch {
        throw new Error("its iroh endpoint isn't up");
      }
    }
    const to = new iroh.EndpointAddr(iroh.EndpointId.fromBytes(bytes(k)), how.mode === "relay" ? how.relay : null, addrs);
    let late = false;
    const dialed = ep.connect(to, text(ALPN));
    dialed.then((c) => late && c.close(0n, text("dialed too late")), () => {});
    const conn = await Promise.race([dialed, new Promise<never>((_, no) => setTimeout(() => no(new Error(`it didn't answer in ${Math.round(DIAL_MS / 1000)} s: is it on, with iroh?`)), DIAL_MS).unref())]).catch((e) => {
      late = true;
      throw e;
    });
    keep(k, conn);
    return conn;
  }

  // ---------- machines connecting here ----------
  let refusedAt = 0;
  void (async () => {
    for (;;) {
      let incoming: Awaited<ReturnType<Endpoint["acceptNext"]>>;
      try {
        incoming = await ep.acceptNext();
      } catch (e) {
        return log(`iroh: stopped taking connections: ${e.message}`);
      }
      if (!incoming) return;
      void (async () => {
        const conn = await (await incoming.accept()).connect();
        const k = keyOf(conn);
        if (Buffer.from(conn.alpn()).toString() !== ALPN) return conn.close(1n, text("not agentbook"));
        if (!(await admit(k).catch(() => false))) {
          if (Date.now() - refusedAt > 60e3) log(`iroh: refused a connection from ${k.slice(0, 8)}…, which isn't one of your machines`);
          refusedAt = Date.now();
          return conn.close(2n, text("not a machine on this account"));
        }
        keep(k, conn);
      })().catch((e) => log(`iroh: a connection here didn't go through: ${e.message}`));
    }
  })();

  if (how.mode === "local") {
    fs.mkdirSync(how.dir, { recursive: true });
    fs.writeFileSync(addrFile(self), JSON.stringify({ addrs: ep.boundSockets().filter((a) => a.startsWith("127.0.0.1:")) }));
  }

  // ---------- calls ----------
  const unreachable = (e: Error) => Object.assign(new TypeError("fetch failed"), { cause: { code: "IROH_UNREACHABLE", message: e.message } });
  const reset = (e: Error) => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", message: e.message } });
  async function call(k: string, url: string, init: IrohInit = {}): Promise<Response> {
    let conn: Connection;
    let bi: BiStream;
    try {
      conn = await connection(k);
    } catch (e) {
      throw unreachable(e);
    }
    try {
      bi = await conn.openBi();
    } catch (e) {
      throw reset(e);
    }
    const sock = streamOf(bi);
    const u = new URL(url, `http://${IROH_HOST}`);
    const signal = init.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      // Once it's answered (or failed), its time running out later is nothing: it isn't one left waiting.
      const settle = () => {
        settled = true;
        signal?.removeEventListener("abort", timedOut);
      };
      const fail = (e: Error) => {
        if (settled) return;
        settle();
        reject(e);
      };
      const req = http.request({ method: init.method || "GET", path: u.pathname + u.search, headers: { ...init.headers, host: IROH_HOST }, createConnection: () => sock }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => fail(reset(e)));
        res.on("end", () => {
          if (settled) return;
          settle();
          const status = res.statusCode || 502;
          const headers = new Headers();
          for (const [name, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v == null ? [] : [v]) headers.append(name, String(one));
          resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers }));
        });
      });
      req.on("error", (e) => fail(e.name === "TimeoutError" ? e : reset(e)));
      function timedOut() {
        if (settled) return;
        const c = conns.get(k);
        if (c?.conn === conn && c.unanswered.push(`${init.method || "GET"} ${u.pathname}`) >= UNANSWERED_MAX) {
          log(`iroh: ${UNANSWERED_MAX} calls to ${k.slice(0, 8)}… went unanswered (${c.unanswered.join(", ")}), so its connection is made again`);
          conns.delete(k);
          conn.close(0n, text("calls went unanswered"));
        }
        req.destroy(Object.assign(new Error("it didn't answer in time"), { name: "TimeoutError" }));
      }
      if (signal?.aborted) return timedOut();
      signal?.addEventListener("abort", timedOut, { once: true });
      req.end(init.body ?? undefined);
    });
  }

  const node: IrohNode = {
    key: self,
    where: how.mode === "local" ? "on 127.0.0.1" : `through ${how.relay}`,
    fetch: call,
    connected: (k) => !!open(k),
    path(k) {
      try {
        const p = open(k)?.conn.paths().find((x) => x.isSelected);
        return p ? (p.isRelay ? "relay" : "direct") : null;
      } catch {
        return null;
      }
    },
    drop(k) {
      const c = conns.get(k);
      conns.delete(k);
      c?.conn.close(0n, text("unlinked"));
    },
    async close() {
      if (held.node === node) held.node = null;
      if (how.mode === "local") fs.rmSync(addrFile(self), { force: true });
      await ep.close();
    },
  };
  return node;
}

// A stream as a Node socket: what's written goes out its send half, in CHUNK-sized pieces; what comes in its receive
// half is read as it arrives. Ending it finishes the send half; destroying it with an error resets it, so the other
// side stops waiting for the rest.
export function streamOf(bi: BiStream): Duplex {
  let pumping = false;
  let ended = false;
  const end = (reset: boolean) => {
    if (ended) return Promise.resolve();
    ended = true;
    return reset ? bi.send.reset(0n) : bi.send.finish();
  };
  const d = new Duplex({
    allowHalfOpen: true,
    read() {
      if (pumping) return;
      pumping = true;
      void pump();
    },
    write(chunk: Buffer, _enc, cb) {
      (async () => {
        for (let i = 0; i < chunk.length; i += CHUNK) await bi.send.writeAll(Array.from(chunk.subarray(i, i + CHUNK)));
      })().then(() => cb(), (e) => cb(e));
    },
    final(cb) {
      end(false).then(() => cb(), (e) => cb(e));
    },
    destroy(err, cb) {
      end(!!err).catch(() => {});
      cb(err);
    },
  });
  async function pump() {
    for (;;) {
      let got: number[];
      try {
        got = await bi.recv.read(CHUNK);
      } catch (e) {
        pumping = false;
        if (!d.destroyed) d.destroy(Object.assign(new Error(`the stream was reset: ${e.message}`), { code: "ECONNRESET" }));
        return;
      }
      if (d.destroyed) return;
      if (!got.length) return void d.push(null);
      if (!d.push(Buffer.from(got))) {
        pumping = false;
        return;
      }
    }
  }
  return d;
}
