// agentbook-door: the one way other people reach you. A program apart from
// agentbook, started by your home machine's page (plugin/door/spawn.ts) and stopped with it, with its own key (never a
// machine's), its own iroh endpoint and ALPN (agentbook-people/1), and its own folder, which is all it reads and
// writes: Node's permission model holds it to that, with no child processes and no workers, and with code from strings
// off. node:sqlite and the iroh addon aren't covered by Node 22's permission model, so it opens door.db only, by its
// path, and never anything else.
//
// What it does:
//   - answers another door's `hello` with your card, and takes each other kind wire.ts has, from whoever WHO lets
//     send it, within LIMITS, into door.db's inbox, saying "inbox" to the page;
//   - sends what the page put in the outbox, to each person's door by its key, as the page says "outbox", signing
//     each record of your own (sign.ts), and again later while some wait;
//   - on each connection with someone who sees your things, sends `all`: what they may see now (door.db's published).
// Every message says who sent it with their door's certificate, which the relay signed and the connection proves (an
// account, and its door's key), and the handle they go by, which is only their word.
//
//   node plugin/door/main.ts --dir <folder> --account <acct> --relay <url> [--iroh local|relay|off]
//        [--iroh-dir <folder>] [--iroh-relay <url>] --iroh-module <file URL of @number0/iroh>

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { BiStream, Connection, Endpoint } from "@number0/iroh";
import { DoorSide, type OutboxRow, type Person } from "../shared/door/db.ts";
import { commentRecord, signRecord } from "../shared/door/sign.ts";
import { ALPN, frame, LIMITS, MAX_BYTES, unframe, VERSION, WHO, type Kind, type Message } from "../shared/door/wire.ts";
import { createVerifier, doorProofInput, type DoorClaims } from "../shared/relay-verify.ts";

type Iroh = typeof import("@number0/iroh");

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const DIR = path.resolve(args.get("dir") || ".");
const log = (line: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} door: ${line}\n`);

// --probe <file>: what this process may do, as it runs, for test/door.ts: read and write outside its folder, start a
// process, a worker, code from a string.
if (args.has("probe")) {
  const file = args.get("probe")!;
  const tryIt = async (f: () => unknown) => {
    try {
      await f();
      return "allowed";
    } catch (e) {
      return e.code === "ERR_ACCESS_DENIED" || /code generation|EvalError/i.test(String(e)) ? "denied" : `failed: ${e.code || e.message}`;
    }
  };
  const out = {
    read: await tryIt(() => fs.readFileSync(file)),
    write: await tryIt(() => fs.writeFileSync(path.join(path.dirname(file), "door-was-here"), "x")),
    spawn: await tryIt(async () => (await import("node:child_process")).spawnSync("true")),
    worker: await tryIt(async () => new (await import("node:worker_threads")).Worker("1", { eval: true })),
    eval: await tryIt(() => new Function("return 1")()),
    own: await tryIt(() => fs.writeFileSync(path.join(DIR, "probe"), "x")),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

const ACCOUNT = args.get("account") || "";
const RELAY = (args.get("relay") || "").replace(/\/+$/, "");
const IROH_MODE = args.get("iroh") || "relay";
const IROH_DIR = args.get("iroh-dir") || "";
const IROH_RELAY = args.get("iroh-relay") || RELAY;
// How long a message waits for its answer, and how long another door's stream may take to arrive whole.
const ANSWER_MS = Number(args.get("answer-ms") || 20e3);
const DIAL_MS = Number(args.get("dial-ms") || 10e3);
// How soon a person whose door didn't answer is tried again: twice as long each time, up to RETRY_MAX_MS.
const RETRY_MS = Number(args.get("retry-ms") || 30e3);
// At most 15 minutes, and 30 tries apart at most (the tests try every half second).
const RETRY_MAX_MS = Math.min(15 * 60e3, RETRY_MS * 30);
// How often `all` goes to the same person at most, and how many streams one connection may have open here at once.
const ALL_MS = 10 * 60e3;
const OPEN_MAX = 16;

if (!ACCOUNT || !RELAY) {
  log("needs --account and --relay");
  process.exit(2);
}
fs.mkdirSync(DIR, { recursive: true });

// ---------- its key: made once, kept in its folder ----------
const KEY_FILE = path.join(DIR, "key.json");
function ownKey(): { x: string; d: string } {
  try {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    if (typeof k.x === "string" && typeof k.d === "string") return k;
  } catch {}
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  fs.writeFileSync(KEY_FILE, JSON.stringify({ x: jwk.x, d: jwk.d }), { mode: 0o600 });
  return { x: jwk.x, d: jwk.d };
}
const key = ownKey();
const privateKey = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x, d: key.d }, format: "jwk" });

const db = new DoorSide(path.join(DIR, "door.db"));
// Sending the outbox, once at a time (pump, below): asked for again while it runs, it runs once more after.
let pumping: Promise<void> | null = null;
let again = false;
db.setSelf("key", key.x);
db.setSelf("account", ACCOUNT);
db.setSelf("proof", crypto.sign(null, doorProofInput(ACCOUNT, key.x), privateKey).toString("base64url"));
db.setSelf("started", String(Date.now()));
db.setSelf("pid", String(process.pid));
// Names this door.db, so the ids of what it sends stay new even if the folder is made again with the same key.
if (!db.self("instance")) db.setSelf("instance", crypto.randomBytes(6).toString("base64url"));
const INSTANCE = db.self("instance")!;

const verifier = createVerifier({ relay: RELAY });
// Certificates checked, by their text, until they run out.
const checked = new Map<string, DoorClaims>();
async function whoSent(cert: string): Promise<DoorClaims> {
  const had = checked.get(cert);
  if (had && had.exp * 1000 > Date.now()) return had;
  const c = await verifier.verifyDoor(cert);
  if (checked.size > 2000) checked.clear();
  checked.set(cert, c);
  return c;
}
const myCert = () => db.config("certificate");
// The handle your person goes by, as the page wrote it.
const myHandle = () => db.config("handle");

// ---------- the page, told and telling ----------
// The page connects to a unix socket in this folder and says "outbox" (or "config"); this says "inbox". Neither
// carries anything: what changed is in door.db.
const SOCK = (() => {
  const p = path.join(DIR, "nudge.sock");
  return p.length < 100 ? p : path.join("/tmp", `agentbook-door-${crypto.createHash("sha256").update(DIR).digest("hex").slice(0, 16)}.sock`);
})();
db.setSelf("socket", SOCK);
const pages = new Set<net.Socket>();
const nudger = net.createServer((sock) => {
  pages.add(sock);
  sock.on("data", (d) => {
    const said = d.toString();
    if (said.includes("outbox")) void pump();
  });
  sock.on("error", () => {});
  sock.on("close", () => pages.delete(sock));
});
try {
  fs.rmSync(SOCK, { force: true });
} catch {}
nudger.listen(SOCK);
const tellPage = () => {
  for (const s of pages) s.write("inbox\n");
};

// ---------- iroh ----------
const bytes = (b64: string) => Array.from(Buffer.from(b64, "base64url"));
const text = (s: string) => Array.from(Buffer.from(s));
let iroh: Iroh;
let ep: Endpoint;
try {
  iroh = await import(args.get("iroh-module")!);
  const b = iroh.Endpoint.builder();
  iroh.presetMinimal(b);
  b.secretKey(bytes(key.d));
  b.alpns([text(ALPN)]);
  if (IROH_MODE === "local") {
    b.relayMode(iroh.RelayMode.disabled());
    b.bindAddr("127.0.0.1:0");
  } else b.relayMode(iroh.RelayMode.customFromUrls([IROH_RELAY]));
  ep = await b.bind();
} catch (e) {
  log(`iroh wouldn't start: ${e.message}`);
  db.setSelf("why", `iroh wouldn't start here (${e.message})`);
  process.exit(3);
}
const addrFile = IROH_MODE === "local" ? path.join(IROH_DIR, `${key.x}.json`) : null;
if (addrFile) fs.writeFileSync(addrFile, JSON.stringify({ addrs: ep.boundSockets().filter((a) => a.startsWith("127.0.0.1:")) }));
db.setSelf("why", "");
log(`up, as ${key.x.slice(0, 8)}… ${IROH_MODE === "local" ? "on 127.0.0.1" : `through ${IROH_RELAY}`}`);

const keyOf = (c: Connection) => Buffer.from(c.remoteId().toBytes()).toString("base64url");
// One connection kept to each door, dialed or taken.
const conns = new Map<string, Connection>();
const dialing = new Map<string, Promise<Connection>>();
const live = (k: string) => {
  const c = conns.get(k);
  return c && c.closeReason() == null ? c : null;
};
function keep(k: string, conn: Connection) {
  conns.set(k, conn);
  const gone = () => {
    if (conns.get(k) === conn) conns.delete(k);
  };
  conn.closed().then(gone, gone);
  let open = 0;
  void (async () => {
    for (;;) {
      let bi: BiStream;
      try {
        bi = await conn.acceptBi();
      } catch {
        return gone();
      }
      if (++open > OPEN_MAX) {
        conn.close(4n, text("too many streams at once"));
        return gone();
      }
      void take(conn, k, bi).finally(() => open--);
    }
  })();
  void sayAll(k);
}
async function connection(k: string): Promise<Connection> {
  const c = live(k);
  if (c) return c;
  let p = dialing.get(k);
  if (!p) {
    p = (async () => {
      let addrs: string[] | null = null;
      if (IROH_MODE === "local") {
        try {
          addrs = JSON.parse(fs.readFileSync(path.join(IROH_DIR, `${k}.json`), "utf8")).addrs;
        } catch {
          throw new Error("their door isn't up");
        }
      }
      const to = new iroh.EndpointAddr(iroh.EndpointId.fromBytes(bytes(k)), IROH_MODE === "local" ? null : IROH_RELAY, addrs);
      let late = false;
      const dialed = ep.connect(to, text(ALPN));
      dialed.then((c) => late && c.close(0n, text("dialed too late")), () => {});
      const conn = await Promise.race([dialed, new Promise<never>((_, no) => setTimeout(() => no(new Error(`their door didn't answer in ${Math.round(DIAL_MS / 1000)} s`)), DIAL_MS).unref())]).catch((e) => {
        late = true;
        throw e;
      });
      keep(k, conn);
      return conn;
    })().finally(() => dialing.delete(k));
    dialing.set(k, p);
  }
  return p;
}
// Reads all of a stream, or gives up after `ms` (closing its connection, as a read can't be called off).
async function readAll(conn: Connection, bi: BiStream, ms: number): Promise<number[]> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(() => {
      conn.close(5n, text("a stream took too long"));
      no(new Error("it took too long"));
    }, ms);
  });
  try {
    return await Promise.race([bi.recv.readToEnd(MAX_BYTES + 4), late]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------- taking messages in ----------
// What each person sent this window, by kind: [when the window started, how many].
const counts = new Map<string, Map<string, [number, number]>>();
function over(acct: string, kind: Kind): boolean {
  let mine = counts.get(acct);
  if (!mine) counts.set(acct, (mine = new Map()));
  for (const l of LIMITS) {
    if (l.kind !== "*" && l.kind !== kind) continue;
    const name = l.kind;
    const [since, n] = mine.get(name) ?? [Date.now(), 0];
    const fresh = Date.now() - since > l.ms;
    if (!fresh && n >= l.n) return true;
    mine.set(name, fresh ? [Date.now(), 1] : [since, n + 1]);
  }
  return false;
}
const message = (kind: Kind, body: Record<string, unknown>): Message => ({ v: VERSION, kind, id: crypto.randomBytes(12).toString("base64url"), at: Date.now(), from: myCert()!, handle: myHandle()!, body });
async function answer(bi: BiStream, m: Message) {
  await bi.send.writeAll(Array.from(frame(m)));
  await bi.send.finish();
}
// Whether `p` stands with you as `kind` needs.
const may = (kind: Kind, p: Person | null) => WHO[kind] === "anyone" || (Array.isArray(WHO[kind]) && !!p && (WHO[kind] as string[]).some((r) => p.rel.includes(r)));

async function take(conn: Connection, k: string, bi: BiStream) {
  let m: Message;
  try {
    m = unframe(await readAll(conn, bi, ANSWER_MS));
  } catch (e) {
    log(`closed a connection from ${k.slice(0, 8)}…: ${String(e.message).slice(0, 160)}`);
    conn.close(3n, text("not a message this door takes"));
    return;
  }
  let who: DoorClaims;
  try {
    who = await whoSent(m.from);
  } catch (e) {
    conn.close(2n, text("no door certificate that holds"));
    return;
  }
  if (who.key !== k) {
    conn.close(2n, text("a certificate for another door"));
    return;
  }
  proven.set(who.acct, who.key);
  if (m.kind === "card" || m.kind === "ack") {
    conn.close(3n, text("an answer nobody asked for"));
    return;
  }
  const no = (error: string) => answer(bi, message("ack", { ok: false, error })).catch(() => {});
  if (!myCert() || !myHandle()) return no("not_ready");
  const p = db.person(who.acct);
  if (!may(m.kind, p)) return no("not_allowed");
  // Sent again (its answer was lost): taken already, and not counted twice.
  if (db.has(who.acct, m.id)) return answer(bi, message("ack", { ok: true })).catch(() => {});
  if (over(who.acct, m.kind)) return no("slow_down");
  if (m.kind === "hello") {
    let card: Record<string, unknown> | null = null;
    try {
      card = JSON.parse(db.config("card") || "null");
    } catch {}
    return card ? answer(bi, message("card", card)).catch(() => {}) : no("not_ready");
  }
  if (db.take({ from_acct: who.acct, from_handle: m.handle, from_key: who.key, kind: m.kind, mid: m.id, body: m.body })) tellPage();
  await answer(bi, message("ack", { ok: true })).catch(() => {});
}

// ---------- sending ----------
// When each person's door may be tried again, and how long it waits after that.
const backoff = new Map<string, { until: number; ms: number }>();
const lastAll = new Map<string, number>();
// The door key each person's door proved is theirs, this run: by answering, or sending, with their certificate. A key
// from an invite link may be another account's: until theirs is proven, nothing but a hello goes to it, and the
// hello says no more than your invite link does.
const proven = new Map<string, string>();
// The page's records signed by this door, as their author going by `handle`, unless they have one (a hub passing
// someone's on).
function signed(row: OutboxRow, cert: string, handle: string): Record<string, unknown> {
  const sign = (items: unknown) =>
    (Array.isArray(items) ? items : []).map((it) => {
      const r = it as { type: string; id: string; v: string; body: unknown; space?: string; mentions?: string[]; author?: unknown };
      return r.author ? r : { ...r, author: { certificate: cert, handle, sig: signRecord(r, handle, privateKey) } };
    });
  if (row.kind === "records" || row.kind === "put") return { ...row.body, items: sign(row.body.items) };
  if (row.kind === "comment") {
    const c = row.body as { id: string; thread: string; text: string; at: string };
    return { ...row.body, author: { certificate: cert, handle, sig: signRecord(commentRecord(c), handle, privateKey) } };
  }
  return row.body;
}
// Sends one message to the door with key `k`, account `acct`'s: its answer, checked to be from that door. A key
// from an invite link may be someone else's than the account it came with: that door never gets what's for `acct`.
async function call(k: string, acct: string, m: Message): Promise<Message> {
  const conn = await connection(k);
  const bi = await conn.openBi();
  await bi.send.writeAll(Array.from(frame(m)));
  await bi.send.finish();
  const back = unframe(await readAll(conn, bi, ANSWER_MS));
  const who = await whoSent(back.from);
  if (who.key !== k) throw new Error("an answer from another door");
  if (who.acct !== acct) throw new Error("that door is another account's than theirs");
  proven.set(acct, k);
  if (back.kind !== "ack" && back.kind !== "card") throw new Error(`a ${back.kind} for an answer`);
  return back;
}
function pump(): Promise<void> {
  if (pumping) {
    again = true;
    return pumping;
  }
  pumping = (async () => {
    do {
      again = false;
      await sendWaiting().catch((e) => log(`sending: ${e.message}`));
    } while (again);
  })().finally(() => (pumping = null));
  return pumping;
}
async function sendWaiting() {
  const cert = myCert();
  const handle = myHandle();
  if (!cert || !handle) return;
  const rows = db.waiting(500);
  const byPerson = new Map<string, OutboxRow[]>();
  for (const r of rows) byPerson.set(r.to_acct, [...(byPerson.get(r.to_acct) ?? []), r]);
  await Promise.all(
    [...byPerson].map(async ([acct, mine]) => {
      const p = db.person(acct);
      const b = backoff.get(acct);
      if (!p || (b && b.until > Date.now())) return;
      const failed = (e: Error) => {
        const ms = Math.min((b?.ms ?? RETRY_MS / 2) * 2, RETRY_MAX_MS);
        backoff.set(acct, { until: Date.now() + ms, ms });
        db.setReach(acct, false, String(e.message).slice(0, 200));
      };
      if (proven.get(acct) !== p.key && mine[0].kind !== "hello") {
        try {
          const back = await call(p.key, acct, message("hello", {}));
          if (back.kind === "card" && db.take({ from_acct: acct, from_handle: back.handle, from_key: p.key, kind: "card", mid: back.id, body: back.body })) tellPage();
        } catch (e) {
          return failed(e);
        }
      }
      for (const row of mine) {
        let back: Message;
        try {
          back = await call(p.key, acct, { ...message(row.kind as Kind, signed(row, cert, handle)), id: `o${row.n}-${INSTANCE}` });
        } catch (e) {
          return failed(e);
        }
        backoff.delete(acct);
        db.setReach(acct, true);
        if (back.kind === "card") {
          if (db.take({ from_acct: acct, from_handle: back.handle, from_key: p.key, kind: "card", mid: back.id, body: back.body })) tellPage();
          db.markSent(row.n, acct);
        } else if (back.body.ok) db.markSent(row.n, acct);
        else if (back.body.error === "slow_down" || back.body.error === "not_ready") {
          backoff.set(acct, { until: Date.now() + RETRY_MS, ms: RETRY_MS });
          return;
        } else db.markSent(row.n, acct, String(back.body.error || "refused"));
      }
    }),
  );
}
// `all` to someone who sees your things, as a connection with them starts: what they may see now, so their page drops
// the rest. At most every ALL_MS.
async function sayAll(k: string) {
  if (!myCert() || !myHandle()) return;
  for (const p of db.peopleByKey(k)) {
    if (!p.rel.some((r) => r === "contact" || r === "member")) continue;
    if (Date.now() - (lastAll.get(p.acct) ?? 0) < ALL_MS) continue;
    lastAll.set(p.acct, Date.now());
    try {
      if (proven.get(p.acct) !== k) await call(k, p.acct, message("hello", {}));
      await call(k, p.acct, message("all", { ids: db.publishedTo(p.acct) }));
    } catch (e) {
      lastAll.delete(p.acct);
    }
  }
}

// ---------- others connecting ----------
void (async () => {
  for (;;) {
    let incoming: Awaited<ReturnType<Endpoint["acceptNext"]>>;
    try {
      incoming = await ep.acceptNext();
    } catch (e) {
      return log(`stopped taking connections: ${e.message}`);
    }
    if (!incoming) return;
    void (async () => {
      const conn = await (await incoming.accept()).connect();
      if (Buffer.from(conn.alpn()).toString() !== ALPN) return conn.close(1n, text("not a door"));
      keep(keyOf(conn), conn);
    })().catch((e) => log(`a connection didn't go through: ${e.message}`));
  }
})();

const tick = setInterval(() => {
  void pump();
  db.prune();
}, Math.min(RETRY_MS, 30e3));
void pump();

// ---------- stopping: with the page that started it ----------
let stopping = false;
async function stop(why: string) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${why}`);
  clearInterval(tick);
  nudger.close();
  for (const s of pages) s.destroy();
  try {
    if (addrFile) fs.rmSync(addrFile, { force: true });
    fs.rmSync(SOCK, { force: true });
  } catch {}
  await Promise.race([ep.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  db.close();
  process.exit(0);
}
process.stdin.on("end", () => void stop("its page stopped"));
process.stdin.on("error", () => void stop("its page stopped"));
process.stdin.resume();
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => void stop(s));
