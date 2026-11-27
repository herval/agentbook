// What doors say to each other: messages, one per
// stream, each a 4-byte big-endian length and that many bytes of JSON, 256 KB at most. Each kind has a shape, checked
// field by field: a message with a kind that isn't here, a field that isn't in its shape, or one of the wrong type or
// size, closes the connection. No kind names a command, a path, a file, a machine or an agent run, and none is a
// request the page answers: what a door takes in is kept as data, for its page to check again and show.
//
// The door (plugin/door/main.ts) and the page (server/door.ts) share this file; it imports nothing.

export const ALPN = "agentbook-people/1";
export const MAX_BYTES = 256 * 1024;
export const VERSION = 1;

// ---------- shapes ----------
// A check says what's wrong with a value (at `at`), or null.
export type Check = (v: unknown, at: string) => string | null;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str =
  (max: number, min = 0): Check =>
  (v, at) =>
    typeof v !== "string" ? `${at}: not text` : v.length < min || v.length > max ? `${at}: ${min} to ${max} characters` : null;
const int =
  (min: number, max: number): Check =>
  (v, at) =>
    !Number.isSafeInteger(v) || (v as number) < min || (v as number) > max ? `${at}: a whole number from ${min} to ${max}` : null;
const bool: Check = (v, at) => (typeof v === "boolean" ? null : `${at}: true or false`);
const oneOf =
  (...vals: unknown[]): Check =>
  (v, at) =>
    vals.includes(v) ? null : `${at}: one of ${vals.join(", ")}`;
const opt =
  (c: Check): Check =>
  (v, at) =>
    v === undefined ? null : c(v, at);
const nul =
  (c: Check): Check =>
  (v, at) =>
    v === null ? null : c(v, at);
const arr =
  (c: Check, max: number): Check =>
  (v, at) => {
    if (!Array.isArray(v)) return `${at}: not a list`;
    if (v.length > max) return `${at}: ${max} at most`;
    for (let i = 0; i < v.length; i++) {
      const e = c(v[i], `${at}[${i}]`);
      if (e) return e;
    }
    return null;
  };
const tuple =
  (...cs: Check[]): Check =>
  (v, at) => {
    if (!Array.isArray(v) || v.length !== cs.length) return `${at}: ${cs.length} values`;
    for (let i = 0; i < cs.length; i++) {
      const e = cs[i](v[i], `${at}[${i}]`);
      if (e) return e;
    }
    return null;
  };
// An object with exactly these fields (an optional one may be missing); any other field is refused.
const obj =
  (fields: Record<string, Check>): Check =>
  (v, at) => {
    if (!isObj(v)) return `${at}: not an object`;
    for (const k of Object.keys(v)) if (!(k in fields)) return `${at}.${k}: not a field here`;
    for (const [k, c] of Object.entries(fields)) {
      const e = c(v[k], `${at}.${k}`);
      if (e) return e;
    }
    return null;
  };
// Any JSON value of at most `max` bytes, nested at most 12 deep: what's inside is the page's to check.
const data =
  (max: number): Check =>
  (v, at) => {
    const deep = (x: unknown, d: number): boolean => d <= 12 && (!x || typeof x !== "object" || Object.values(x).every((y) => deep(y, d + 1)));
    if (!deep(v, 0)) return `${at}: nested too deep`;
    const n = Buffer.byteLength(JSON.stringify(v) ?? "");
    return n > max ? `${at}: ${max} bytes at most` : null;
  };

// Ids: of things (a thread, a page, a group…, as their owner's page names them), and of messages.
const ID = str(200, 1);
const MID = str(64, 8);
// A handle is a name someone goes by, their own word: nobody keeps them unique, so two people may share one. Who
// someone is, is their account, which the relay certifies their door key for.
const HANDLE: Check = (v, at) => (typeof v === "string" && /^[a-z0-9][a-z0-9_-]{1,29}$/.test(v) ? null : `${at}: a handle`);
const ACCT: Check = (v, at) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : `${at}: an account`);
const CERT = str(4000, 20);
// Who wrote something someone passes on: their door's certificate, the handle they went by, and their signature of
// both (sign.ts).
const AUTHOR = obj({ certificate: CERT, handle: HANDLE, sig: str(200, 20) });

// A record: one thing someone publishes, in its owner's words (server/publish.ts says which fields each type has).
// `v` is its version: a copy sent twice, or late, changes nothing. `mentions`: the people it names, by their
// accounts. `author`: who wrote it, signed (a hub passes on someone's thread in a group with theirs).
export const RECORD_TYPES = ["person", "agent", "thread", "page", "task", "group", "note", "comment", "work"] as const;
const record = obj({
  type: oneOf(...RECORD_TYPES),
  id: ID,
  v: str(64, 1),
  body: data(240 * 1024),
  space: opt(ID),
  mentions: opt(arr(ACCT, 50)),
  author: opt(AUTHOR),
});
// A picture, small enough to travel in a card.
const picture = obj({ type: oneOf("image/png", "image/jpeg", "image/webp", "image/gif"), data: str(96 * 1024, 4) });

// What each kind's body is. `card` and `ack` are only ever answers.
export const SHAPES = {
  hello: obj({}),
  card: obj({ handle: HANDLE, name: opt(str(80)), bio: opt(str(500)), picture: opt(picture) }),
  // To be each other's contact, saying `note`; or `space`: to be in something of theirs
  // (group:<id>, task:<id>, page:<id>, note:<id>), by its `name`.
  ask: obj({ note: opt(str(500)), space: opt(ID), name: opt(str(200)) }),
  take_back: obj({ space: opt(ID) }),
  // Yes or no to their ask to be contacts.
  answer: obj({ yes: bool }),
  // Contacts no more: either of them may.
  remove: obj({}),
  want: obj({ id: ID, before: opt(str(64)) }),
  records: obj({ items: arr(record, 500) }),
  withdraw: obj({ ids: arr(ID, 2000) }),
  all: obj({ ids: arr(tuple(ID, str(64, 1)), 20000) }),
  // Signed by its author's door (sign.ts's commentRecord), so the thread's owner passes it on unchanged.
  comment: obj({ thread: ID, id: MID, text: str(4000, 1), at: str(40, 10), author: opt(AUTHOR) }),
  propose: obj({ space: ID, id: MID, what: oneOf("note", "brief", "file", "page", "comment", "suggestion", "join", "decline"), body: data(240 * 1024) }),
  put: obj({ space: ID, items: arr(record, 200) }),
  take_out: obj({ space: ID, id: ID }),
  // `out`: its home took you out of one of theirs. Without it, they left one of yours: the two can share an id.
  leave: obj({ space: ID, out: opt(bool) }),
  ack: obj({ ok: bool, error: opt(str(200)) }),
} satisfies Record<string, Check>;
export type Kind = keyof typeof SHAPES;
export const KINDS = Object.keys(SHAPES) as Kind[];
// What a door may be sent (the rest are answers).
export const SENT_KINDS: Kind[] = KINDS.filter((k) => k !== "card" && k !== "ack");

// Who may send each kind, by how they stand with you (the page says, in door.db's `people`): anyone with a door
// certificate for the first few; the rest only from someone in that relation. A kind sent by someone else gets an
// ack saying no, never their message kept.
//   contact: you're each other's contact     asked: you asked them to be
//   member: is in a group, task, page or note of yours     home: owns one you're in
export const WHO: Record<Kind, string[] | "anyone"> = {
  hello: "anyone",
  ask: "anyone",
  take_back: "anyone",
  // What it says changes only what's there between them: nothing, from someone it isn't.
  remove: "anyone",
  want: ["contact", "member"],
  answer: ["asked"],
  records: ["contact", "home"],
  withdraw: ["contact", "home"],
  all: ["contact", "home"],
  comment: ["contact", "member"],
  propose: ["member"],
  put: ["member"],
  take_out: ["member"],
  // A member leaving, or the home taking them out.
  leave: ["member", "home"],
  card: [],
  ack: [],
};

// How many of each a person may send, per window: past it, an ack says slow_down and nothing is kept.
export const LIMITS: { kind: Kind | "*"; n: number; ms: number }[] = [
  { kind: "*", n: 1200, ms: 3600e3 },
  { kind: "hello", n: 30, ms: 3600e3 },
  { kind: "ask", n: 5, ms: 86400e3 },
  { kind: "comment", n: 120, ms: 3600e3 },
  { kind: "propose", n: 300, ms: 3600e3 },
];

// ---------- messages ----------
export interface Message {
  v: 1;
  kind: Kind;
  // Unique per sender: a message sent twice is taken once.
  id: string;
  at: number;
  // The sender's door certificate, from the relay: who they are (their account), and their door's key, which the
  // connection proves.
  from: string;
  // The handle they go by, their own word: what someone new is called on your page at first.
  handle: string;
  body: Record<string, unknown>;
}
const envelope = obj({ v: oneOf(VERSION), kind: oneOf(...KINDS), id: MID, at: int(0, 8.64e15), from: CERT, handle: HANDLE, body: (v) => (isObj(v) ? null : "body: not an object") });

// What's wrong with a message, or null when it holds.
export function checkMessage(m: unknown): string | null {
  const e = envelope(m, "message");
  if (e) return e;
  const msg = m as Message;
  return SHAPES[msg.kind](msg.body, `${msg.kind}`);
}

// A message as it goes on a stream: its length, then its JSON.
export function frame(m: Message): Buffer {
  const json = Buffer.from(JSON.stringify(m));
  if (json.length > MAX_BYTES) throw new Error(`a ${m.kind} of ${json.length} bytes is over ${MAX_BYTES}`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length);
  return Buffer.concat([head, json]);
}
// A message from what came in on a stream, checked: its shape holds, or it throws why not.
export function unframe(bytes: Uint8Array | number[]): Message {
  const b = Buffer.from(bytes);
  if (b.length < 4) throw new Error("a message shorter than its length");
  const n = b.readUInt32BE(0);
  if (n > MAX_BYTES) throw new Error(`a message of ${n} bytes is over ${MAX_BYTES}`);
  if (b.length !== n + 4) throw new Error("a message that isn't the length it says");
  let m: unknown;
  try {
    m = JSON.parse(b.subarray(4).toString("utf8"));
  } catch {
    throw new Error("a message that isn't JSON");
  }
  const e = checkMessage(m);
  if (e) throw new Error(e);
  return m as Message;
}
