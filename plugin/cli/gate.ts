// The gate: what a machine lets its agentbook-server make it do. Its
// settings are this machine's own (<data>/cli/gate.json): the page shows them, but can't change them, since
// anything the page can change a hijacked server could too.
//
//   { "owner": "alice", "folders": ["~/dev"], "never": [], "commands": { "post": true, "post.run": true,
//     "read": true, "routine": true, "wip.clean": true, "wip.discard": true, "workspace.clone": true,
//     "folder.trust": true },
//     "starts_per_hour": 20, "ask_here": [], "session_hours": 24, "redact": true }
//
// `redact`: what goes up to its server has its secrets replaced with [redacted] (redact.ts); false sends them as
// they are (a server that is this machine). `folders` are shared on top of what's shared without being told (the clone folder, and the checkouts its agents
// worked in); `never` are kept out even then (agentbook-cli deny). `local_key`: with its server elsewhere, whether every
// caller on this machine shows the key in cli/local.key, not only agentbook-cli (daemon.ts, keyRefused). It starts on
// a new machine, and off on one with threads from before it, whose hooks don't send it, and turns on by itself once
// none of those is left (daemon.ts, keyOnWhenDone; `local_key_since` says when), unless `local_key_auto` is false.
// Its person can turn it on sooner.
//
// Each command goes through these, in order: it's a kind this CLI knows, with only the fields its kind takes; once
// the machine keeps its owner's passkeys (`keys`, with the page and site they sign on), one that can run something is
// signed by one of them, for this machine, in time (one from another machine of its person's, on that machine's page,
// with the keys this machine took for it as they linked: `sites`, keys.vouch); its kind isn't turned off here;
// it's its owner's (one that steers needs `by` to be them); it's inside what the machine shares (`folders`, the clone
// folder, the checkouts its agents worked in, and for one about a post, that post's folder and the files it touched),
// as the path really is, so `..` or a symlink can't lead out, and never inside .git; it's within limits (new posts an
// hour, and the same new post twice in a row starts once); it may wait for an OK here (`ask_here`); and it's logged
// (cli/audit.jsonl, and up to the server for the machine's page), whatever happened.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand, COMMANDS, READS } from "../shared/protocol.ts";
import { needsSignature, SIGNED_KINDS } from "../shared/signed.ts";
import { unwatched } from "../shared/routines.ts";
import { changeRefusal, fingerprint, isKey, okRefusal, pinOf, SESSION_HOURS, signatureRefusal, vouchRefusal } from "./signatures.ts";
import type { Passkey } from "./signatures.ts";
import type { AuditLine } from "../shared/ops.ts";
import type { HistoryPick } from "../shared/history.ts";
import { secretFileRefusal } from "./redact.ts";

// Another page of its person's whose signatures it takes, on what comes from that page's machine (keys.vouch): the
// page, the site its passkeys are for, their public halves, the machine whose page it is, when it was vouched for,
// and when that page last changed its keys here (`keys_at`: a passkey taken off or added there).
export interface Site {
  origin: string;
  rp_id: string;
  keys: Passkey[];
  name?: string;
  at: string;
  keys_at?: string;
}
// A page's address, as a site is kept by: its origin, or null.
const originOf = (u) => {
  try {
    return new URL(String(u)).origin;
  } catch {
    return null;
  }
};
// The page a command came from, as this machine took it (keys.vouch): `from` is that page's address, or { url, peer }
// with the name this machine links its machine by, for a link made on another address than its page's own.
type From = string | { url?: string | null; peer?: string | null } | null;
const siteFrom = (sites: Site[], from: From): Site | null => {
  const { url = null, peer = null } = typeof from === "string" ? { url: from } : from || {};
  return sites.find((x) => x.origin === originOf(url)) || (peer ? sites.find((x) => x.name === peer) : null) || null;
};
const tookWith = (s: { took?: string[] }, origin: string) => [...new Set([...(Array.isArray(s.took) ? s.took : []), origin])];
const isSite = (x) => !!x && typeof x.origin === "string" && typeof x.rp_id === "string" && typeof x.at === "string" && Array.isArray(x.keys) && x.keys.length > 0 && x.keys.every(isKey);
// What gate.json says, with DEFAULTS for what it doesn't. `machine`: this machine's id in what's signed for it
// (machineId). `keys_at`: when the last change of keys it took was made. What its person said at login or since:
// `history_from`, `codex_tools`, `private_terminals`, `update`.
export interface GateSettings {
  owner: string | null;
  local_key: boolean | null;
  local_key_since?: string;
  local_key_auto?: boolean;
  folders: string[];
  never: string[];
  commands: Record<string, boolean>;
  starts_per_hour: number;
  ask_here: string[];
  keys: Passkey[];
  keys_at?: string;
  origin: string | null;
  rp_id: string | null;
  sites: Site[];
  sites_at?: string;
  // The pages whose passkeys it took (takeSite, vouch) or stopped taking (unvouch), by address: it takes one of these
  // unsigned no more, until it's logged in again on the machine (retake) or the page's machine is unlinked.
  took?: string[];
  signed: string[];
  session_hours: number;
  redact: boolean;
  machine?: string;
  history_from?: string;
  // How much of the past its person picked on the welcome card (shared/history.ts), or "pending" until they do:
  // a machine logged in with nobody at its terminal (an agent running agentbook setup) asks there instead.
  // Absent on a machine whose person answered at the terminal, as before the card.
  history_pick?: HistoryPick | "pending";
  codex_tools?: boolean;
  private_terminals?: boolean;
  update?: string;
}
// A post's own folders and the files it touched, or `elsewhere` for one whose files are on another machine;
// `retired`: a thread retiredThread says is.
export interface PostFolders {
  dirs?: string[];
  files?: string[];
  elsewhere?: boolean;
  retired?: boolean;
}

// What a routine's OK lets its run say, beyond what's signed (a prompt, a folder). `note` and `files` come off it.
const OK_COVERS = { "post.start": ["lid", "agent", "prompt", "routine", "ok", "root", "page", "page_root", "model", "note", "files"], "post.deliver": ["post", "text", "routine", "ok", "note", "files"] };

const DEFAULTS: GateSettings = { owner: null, local_key: null, folders: [], never: [], commands: { post: true, "post.run": true, read: true, routine: true, "wip.clean": true, "wip.discard": true, "workspace.clone": true, "folder.trust": true, "cloud.pull": true, "openclaw.pair": true, "remote.connect": true, "cli.update": true, "agent.create": true, "runtime.install": true, "runtime.update": true, "runtime.configure": true, "runtime.login": true, "history.pick": true, group: true, term: true }, starts_per_hour: 20, ask_here: [], keys: [], origin: null, rp_id: null, sites: [], signed: SIGNED_KINDS, session_hours: SESSION_HOURS, redact: true };
// How long after it's logged in a machine whose server is elsewhere takes its first keys from that server (keys.pin).
const PIN_HOURS = 24;
// The setting that turns a kind on or off: its own name when it has one, else its family's.
const switchOf = (kind) => (kind in DEFAULTS.commands ? kind : kind.startsWith("read.") ? "read" : kind.startsWith("page_routine.") || kind.startsWith("routine.") ? "routine" : kind.split(".")[0]);
// What starts a post: limited an hour, and one sent twice in a row starts once. (Anything else may well be meant
// twice: the same message, Stop pressed again.)
const STARTS = new Set(["post.start", "post.side", "cloud.pull"]);
const REPEAT_MS = 10e3;

const tilde = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());
// A clone from a repo on this machine (file://…): that folder, checked like any other, so a repo kept out can't be
// copied into a shared one. Null for one elsewhere (https, ssh).
const localSource = (url) => {
  const u = String(url || "").trim();
  return /^file:\/\//i.test(u) ? decodeURIComponent(u.replace(/^file:\/\/(localhost)?/i, "")) || "/" : null;
};
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const inGit = (p) => p.split(path.sep).includes(".git");
const short = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);
// A path as it really is: symlinks followed. One that isn't there yet (a worktree to make) is its nearest folder
// that is, followed, and the rest as written.
export function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const up = path.dirname(p);
    if (up === p) return p;
    const r = real(up);
    return r ? path.join(r, path.basename(p)) : null;
  }
}

// `home`: agentbook's data folder on this machine (gate.json and audit.jsonl are in its cli/). `roots()`: the
// folders the machine shares without being told: its clone folder and the checkouts its agents worked in.
// `postOf(post)`: a post's own folders and the files it touched, { dirs, files }, or { elsewhere: true } for one
// whose files are on another machine (an OpenClaw agent's, read through its gateway), or null. `report(line)`: an
// audit line, to send up. `notify(c)`: a command waits for an OK here. `hosted()`: whether its server is on another
// machine, so what can run something needs its owner's passkey even before it keeps their keys.
// A thread that ended or went to sleep two weeks ago doesn't count towards what a server elsewhere reads with no
// signature, until it's woken: its person's done with that folder, and the list would otherwise only grow.
export function retiredThread(s, now = Date.now()) {
  if (s.state !== "done" && !s.asleep) return false;
  const since = Date.parse((s.state === "done" ? s.ended : s.slept) || s.updated);
  return Number.isFinite(since) && now - since > 14 * 86400e3;
}

// `readRoots()`: those of `roots()` still in use (without the threads retired), which is what a read reaches with no
// signature on a machine whose server is elsewhere; `postOf` says `retired` of such a thread.
interface GateOpts {
  home: string;
  roots?: () => string[];
  readRoots?: () => string[];
  postOf?: (post: string) => Promise<PostFolders | null>;
  report?: (line: AuditLine) => void;
  notify?: (c) => void;
  log?: (line: string) => void;
  hosted?: () => boolean;
}
export function createGate({ home, roots = () => [], readRoots = roots, postOf = async () => null, report = () => {}, notify = () => {}, log = () => {}, hosted = () => false }: GateOpts) {
  const dir = path.join(home, "cli");
  const file = path.join(dir, "gate.json");
  const auditFile = path.join(dir, "audit.jsonl");
  let cached = null; // { mtime, settings }
  const recent = []; // [{ at, key }]: the posts started in the last hour
  const asking = new Map(); // cid -> { c, at, resolve }

  function settings(): GateSettings {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    if (cached && cached.mtime === mtime) return cached.settings;
    let saved: Partial<GateSettings> = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const s: GateSettings = { ...DEFAULTS, ...saved, commands: { ...DEFAULTS.commands, ...(saved.commands || {}) } };
    for (const k of ["folders", "never", "ask_here", "keys", "sites"]) if (!Array.isArray(s[k])) s[k] = [];
    s.sites = s.sites.filter(isSite);
    if (!Array.isArray(s.signed)) s.signed = SIGNED_KINDS;
    // A side thread tells an agent something as its owner, as a message does: a list saved before it signs it alike.
    if (s.signed.includes("post.deliver") && !s.signed.includes("post.side")) s.signed = [...s.signed, "post.side"];
    // Its own update changes what runs here, as a cloud machine's does: a list saved before it signs it alike.
    if (s.signed.includes("cloud.setup") && !s.signed.includes("cli.update")) s.signed = [...s.signed, "cli.update"];
    if (s.signed.includes("cli.update") && !s.signed.includes("runtime.install")) s.signed = [...s.signed, "runtime.install"];
    if (s.signed.includes("runtime.install") || s.signed.includes("remote.connect")) for (const kind of ["runtime.update", "runtime.configure", "runtime.login", "agent.create"]) if (!s.signed.includes(kind)) s.signed = [...s.signed, kind];
    // What comes up from before is its person's to say, as its updates are: a list saved before the welcome card
    // signs it alike.
    if (s.signed.includes("cli.update") && !s.signed.includes("history.pick")) s.signed = [...s.signed, "history.pick"];
    // A browser's key its passkey signed signs for at most this long here, and never past the code's own longest.
    s.session_hours = Number.isFinite(s.session_hours) ? Math.max(0, Math.min(SESSION_HOURS, s.session_hours)) : SESSION_HOURS;
    s.keys = s.keys.filter(isKey);
    cached = { mtime, settings: s };
    return s;
  }
  function save(change: Partial<GateSettings>) {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    // Who operated its agents, from before nobody but its owner steered them.
    delete saved.operators;
    delete saved.operators_seen;
    fs.mkdirSync(dir, { recursive: true });
    // All at once: settings() in another process, mid-write, would read no keys at all.
    const part = `${file}.${process.pid}.part`;
    fs.writeFileSync(part, JSON.stringify({ ...saved, ...change }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(part, file);
    cached = null;
  }
  // What its person said about this machine at login, or with `agentbook-cli private`.
  const agree = (said) => save(said);
  // This machine's id in what's signed for it, made here once, so a command signed for another machine doesn't hold
  // here and the server can't change which machine one is for.
  function machineId() {
    const s = settings();
    if (typeof s.machine === "string" && s.machine) return s.machine;
    const id = `m${crypto.randomBytes(12).toString("base64url")}`;
    save({ machine: id });
    return id;
  }

  // The routine code agents on this machine wrote, by its hash. It's tested before anyone can OK it, with nobody
  // there to sign. Code a server sends instead has the network and this machine's loopback, even reaching no tools.
  const writtenFile = path.join(dir, "routines-written.json");
  const codeHash = (code) => crypto.createHash("sha256").update(String(code)).digest("base64url");
  const written = () => {
    try {
      const list = JSON.parse(fs.readFileSync(writtenFile, "utf8"));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  function wrote(code) {
    const h = codeHash(code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(writtenFile, JSON.stringify([...written().filter((x) => x !== h), h].slice(-500)), { mode: 0o600 });
  }

  // Why a routine's run (or the notice that its owner answered about it) doesn't hold with the OK it carries, or
  // null. A run that holds is what the OK covers: an agent's gets its words about the run from here, made of what
  // was signed, rather than from the server; a notice says what the OK says.
  function routineRefusal(c, pinned: { keys: Passkey[]; origin: string; rpId: string } | null) {
    if (!pinned) return "it came from another machine of yours whose page this machine takes nothing signed on: OK that page on this machine's own (Sign once, in Machines)";
    const a = c.args;
    const e = a.ok?.envelope || {};
    if (c.kind === "post.notify") {
      const why = okRefusal(a.ok, { rid: e.rid }, { ...pinned, use: false });
      // All of it from the OK but which question it answers: anything else the server put in it goes.
      if (!why) a.event = { type: "answer", question_id: String(a.event?.question_id ?? ""), key: a.event?.key == null ? undefined : String(a.event.key), question: `Use version ${e.version} of the routine "${e.name}"?`, value: e.use ? "Yes" : "No", by: "human" };
      return why;
    }
    if (c.kind === "page_routine.run") return okRefusal(a.ok, { rid: a.rid, code: a.code, reach: a.reach }, pinned);
    const prompt = c.kind === "post.start" ? a.prompt : a.text;
    const why = a.routine ? okRefusal(a.ok, { rid: a.routine.id, prompt, root: a.root }, pinned) : "it carries a routine's OK but isn't a routine's run";
    if (why) return why;
    // An OK covers a run of its prompt, no more: nothing else a command like this can ask for, such as a repo to clone.
    const beyond = Object.keys(a).filter((k) => !OK_COVERS[c.kind].includes(k));
    if (beyond.length) return `a routine's OK doesn't cover ${beyond.join(", ")}`;
    // Only what was signed reaches the agent: no note or files from the server on the side.
    delete a.note;
    delete a.files;
    const words = routineWords(e, a.routine?.why);
    if (c.kind === "post.start") a.prompt = `${words}\n\n${prompt}`;
    else a.text = `${words}\n\n${prompt}`;
    return null;
  }
  // What an agent routine's run is told before its prompt, from its signed OK.
  function routineWords(e, why) {
    const reason = why === "now" ? "Its owner pressed Run now." : why === "catch-up" ? "It's a run it missed while this machine was off." : "It runs on its schedule, and this is that run.";
    const pages = Array.isArray(e.pages) ? e.pages.filter((p) => p && typeof p.id === "string").slice(0, 20) : [];
    return [
      `This is a run of the routine "${String(e.name || e.rid).slice(0, 200)}" on agentbook. ${reason}`,
      pages.length ? `It's linked to ${pages.length === 1 ? "the page" : "the pages"} ${pages.map((p) => `"${String(p.title || p.id).slice(0, 120)}" (${p.id})`).join(", ")}: read ${pages.length === 1 ? "it" : "them"} with ab_page_read and update ${pages.length === 1 ? "it" : "them"} with ab_page_write: change the widgets that are there, and add none unless the prompt asks for ${pages.length === 1 ? "it" : "them"}.` : "",
      unwatched("its owner"),
    ].filter(Boolean).join(" ");
  }

  const reals = (list) => [...new Set(list.filter((p) => p && path.isAbsolute(tilde(p))).map((p) => real(path.resolve(tilde(p)))).filter(Boolean))];
  // The folders kept out, and the ones this machine shares (but those).
  const never = () => reals(settings().never);
  const sharing = {}; // which -> { s, key, at, list }: worked out again every few seconds, or when the settings or roots change
  function sharedOf(which: string, r: string[], keep: (dir: string) => boolean = () => true) {
    const s = settings();
    const key = r.join("\0");
    const was = sharing[which];
    if (was?.s === s && was.key === key && Date.now() - was.at < 5000) return was.list;
    const out = never();
    const list = [...new Set([...reals(s.folders), ...reals(r).filter(keep)])].filter((d) => !out.some((n) => inside(d, n)));
    sharing[which] = { s, key, at: Date.now(), list };
    return list;
  }
  // A session that just started in a folder shares it right away.
  const shared = () => sharedOf("all", roots());
  // The home folder, or one above it: a session started there says nothing about sharing all of it.
  const aboveHome = (d) => inside(real(os.homedir()) || os.homedir(), d);
  // What a read reaches with no signature, with its server elsewhere: what `agentbook-cli allow` shared (the home folder
  // too, if that's what its person said), and the folders in use, never home on its own. What's signed reaches the rest.
  const readable = () => (hosted() ? sharedOf("reads", readRoots(), (d) => !aboveHome(d)) : shared());
  const keptOut = (at) => never().some((n) => inside(at, n));

  // Why a path a command names isn't one it may use, or null. A relative one is from the post's folder. `narrow`: it
  // has no signature behind it, so it reaches what's readable, and a post's folder only as that would.
  async function pathRefusal(p, { post = null, file: isFile = false, read = false, narrow = false } = {}) {
    if (typeof p !== "string" || !p) return null;
    const own = post ? await postOf(post) : null;
    if (own?.elsewhere) return null; // read where its agent runs, by its driver
    const asked = tilde(p);
    let at;
    if (path.isAbsolute(asked)) at = real(path.resolve(asked));
    else {
      // As the post's file reader finds it: from its folder, the first place it's there.
      const tries = (own?.dirs || []).map((d) => path.resolve(d, asked));
      at = tries.map((t) => (fs.existsSync(t) ? real(t) : null)).find(Boolean) || null;
      if (!at) return tries.length ? null : { error: `${p} isn't a full path`, status: 400 };
    }
    if (!at) return `${p} isn't there`;
    if (inGit(at)) return `${p} is inside .git`;
    // A file that's a secret as a whole (.env, a private key) is never read for the server (redact.ts), as it's
    // named or as it really is.
    if (read) {
      const secret = secretFileRefusal(at) || secretFileRefusal(p);
      if (secret) return secret;
    }
    if (keptOut(at)) return `${p} is in a folder this machine keeps out (agentbook-cli deny)`;
    const mine = (own?.dirs || []).map((d) => real(d)).filter(Boolean);
    const dirs = narrow ? [...readable(), ...(own?.retired ? [] : mine.filter((d) => !aboveHome(d)))] : [...shared(), ...mine];
    if (dirs.some((d) => inside(at, d))) return null;
    if (isFile && (own?.files || []).some((f) => real(f) === at)) return null;
    const where = at !== path.resolve(asked) ? ` (it leads to ${at})` : "";
    return `${p} is outside the folders this machine shares${where}. Run agentbook-cli allow <folder> on it to share one.`;
  }

  // What the folder picker may list of a folder: all of it when it's inside what's shared; only the folders that
  // lead there when it's above a shared one. -> { only: [names] | null } or { refused }.
  function listing(p) {
    const asked = tilde(p || os.homedir());
    if (!path.isAbsolute(asked)) return { refused: { error: "A folder's path starts at /.", status: 400 } };
    const at = real(path.resolve(asked));
    if (!at) return { refused: `${p} isn't there` };
    if (inGit(at)) return { refused: `${p} is inside .git` };
    if (keptOut(at)) return { refused: `${p} is in a folder this machine keeps out (agentbook-cli deny)` };
    const dirs = readable();
    if (dirs.some((d) => inside(at, d))) return { only: null };
    const below = dirs.filter((d) => inside(d, at));
    if (!below.length) return { refused: `${p} is outside the folders this machine shares. Run agentbook-cli allow <folder> on it to share one.` };
    return { only: [...new Set(below.map((d) => path.relative(at, d).split(path.sep)[0]))] };
  }

  // Where the folder picker starts: the home folder, or where the shared folders are when none is under it.
  function startFolder() {
    const home = real(os.homedir());
    const dirs = readable();
    if (!dirs.length || dirs.some((d) => inside(d, home) || inside(home, d))) return null;
    const parts = dirs.map((d) => d.split(path.sep));
    let n = 0;
    while (parts.every((x) => n < x.length && x[n] === parts[0][n])) n++;
    return parts[0].slice(0, n).join(path.sep) || path.sep;
  }

  // The paths a command names: { p, post, file }.
  function pathsOf(c) {
    const a = c.args || {};
    switch (c.kind) {
      case "post.start":
        return [a.root, a.page_root, localSource(a.clone)].filter(Boolean).map((p) => ({ p }));
      case "workspace.clone":
        return [localSource(a.url)].filter(Boolean).map((p) => ({ p }));
      case "cloud.pull":
      case "wip.clean":
      case "wip.discard":
      case "page_routine.run":
        return a.root ? [{ p: a.root }] : [];
      case "folder.trust":
        return [{ p: a.path }];
      case "post.apply":
        return a.root ? [{ p: a.root, post: a.post }] : [];
      case "read.branches":
      case "read.wip":
      case "read.wip_diff":
        return a.root ? [{ p: a.root }] : [];
      case "read.file":
        return a.path ? [{ p: a.path, post: a.post, file: true, read: true }] : [];
    }
    return [];
  }

  function audit(c, outcome, reason = null) {
    const a = c.args || {};
    const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
    const line = { at: new Date().toISOString(), cid: cut(c.cid, 40), kind: cut(c.kind, 80), by: cut(c.by, 80), outcome, ...(reason ? { reason: String(reason).slice(0, 600) } : {}), ...(typeof a.post === "string" ? { post: cut(a.post, 300) } : {}), ...(typeof a.root === "string" ? { root: cut(a.root, 2000) } : {}), ...(typeof a.path === "string" ? { path: cut(a.path, 2000) } : {}) };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(auditFile, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {}
    try {
      // Its time goes up as the op's own.
      const { at, ...up } = line;
      report(up);
    } catch {}
    if (outcome === "refused") log(`gate: refused ${c.kind}${c.by ? ` from @${c.by}` : ""}: ${reason}`);
  }

  const loggedInLately = () => {
    try {
      return Date.now() - fs.statSync(path.join(dir, "device.json")).mtimeMs < PIN_HOURS * 3600e3;
    } catch {
      return false;
    }
  };

  // A page's keys here, changed by `change`, as of `at`: { keys } left, the page gone with none.
  function siteKeys(from: From, change, at) {
    const s = settings();
    const site = siteFrom(s.sites, from);
    if (!site) return { keys: 0 };
    const keys = change(site.keys);
    // Never back: a change dated a little ahead (clocks differ) stays the newest it took.
    const keys_at = site.keys_at && Date.parse(site.keys_at) > Date.parse(at) ? site.keys_at : at;
    const sites = keys.length ? s.sites.map((x) => (x === site ? { ...x, keys, keys_at } : x)) : s.sites.filter((x) => x !== site);
    // A page left with none isn't taken again unsigned (takeSite), whether it was taken unsigned or by Sign once.
    save(keys.length ? { sites } : { sites, took: tookWith(s, site.origin) });
    log(keys.length ? `gate: takes ${keys.length} key${keys.length === 1 ? "" : "s"} signed on ${site.origin} now` : `gate: takes nothing signed on ${site.origin} now: its last key there was taken off`);
    return { keys: keys.length };
  }

  // Whether to do a command: null to go ahead, or { error, status } saying why not (400: it isn't a command it could
  // ever do; 403: not here, not now, not for them). `owner`: whose machine the server says this is, for when gate.json
  // doesn't say. A kind listed in ask_here waits for an OK here first. It may narrow what a command does (`c.only`:
  // the folders a listing may show; `c.args.roots`: only the shared ones).
  // `elsewhere`: it came from another machine of its person's (linked: server/mesh.ts), checked as one from a server on
  // another machine is, whatever this machine's own server is; `from`: that machine's page (siteFrom).
  async function check(c, { owner = null, elsewhere = false, from = null }: { owner?: string | null; elsewhere?: boolean; from?: From } = {}) {
    const away = elsewhere || hosted();
    const refuse = (why, status = 403) => {
      const r = typeof why === "string" ? { error: why, status } : why;
      audit(c, "refused", r.error);
      return r;
    };
    const bad = checkCommand(c);
    if (bad) return refuse(bad, 400);
    const s = settings();
    // Signed by its owner's passkey, once this machine keeps their keys: checked as it
    // came, before anything here trims it.
    const pinned = { keys: s.keys, origin: s.origin, rpId: s.rp_id };
    // From another machine of its person's: signed on that machine's page, with the keys this machine took for that
    // page as they linked (keys.vouch), or on this machine's own.
    const site = elsewhere ? s.sites.find((x) => x.keys.some((k) => k.id === c.sig?.key)) : null;
    const signedOn = site ? { keys: site.keys, origin: site.origin, rpId: site.rp_id } : pinned;
    // The page it came from, as this machine took it (keys.vouch), when it came from another machine of yours.
    const fromSite = elsewhere && from ? siteFrom(s.sites, from) : null;
    // A routine's OK is signed on the page its routine is on: from another machine of yours, that machine's page, by
    // the keys this machine took for it; none when it took nothing from there.
    const okOn = !elsewhere ? pinned : fromSite ? { keys: fromSite.keys, origin: fromSite.origin, rpId: fromSite.rp_id } : null;
    const who = s.owner || owner;
    // Its files are named after its id.
    if (c.kind === "page_routine.run" && !/^[A-Za-z0-9_][\w.-]*$/.test(c.args.rid)) return refuse("that isn't a routine's id", 400);
    // A run that reaches no tool needs no signature of its own, but with its server elsewhere it's still code from
    // that server, so it's code an agent here wrote, or its owner OK'd.
    if (c.kind === "page_routine.run" && away && !needsSignature(c, s.signed) && !written().includes(codeHash(c.args.code))) {
      if (!c.args.ok) return refuse("this routine's code came from the server and no agent here wrote it, so it runs only once its owner OKs this version");
      const why = routineRefusal(c, okOn);
      if (why) return refuse(why);
    }
    if ((s.keys.length || (elsewhere && s.sites.length)) && needsSignature(c, s.signed)) {
      // A routine's run carries its owner's OK of its version instead of a signature of its own.
      const why = c.args?.ok && !c.sig ? routineRefusal(c, okOn) : c.kind === "page_routine.run" && !c.sig ? "a routine's run reaches tools or commands only once its owner OKs it with their passkey (a test run that reaches nothing runs as it is)" : signatureRefusal(c, { ...signedOn, machine: machineId(), hours: s.session_hours });
      if (why) return refuse(why);
    } else if (elsewhere && needsSignature(c, s.signed)) {
      return refuse("it came from another machine of yours, and this machine takes what can run something from there only signed by your passkey on that machine's page, once you OK that page on this machine's own (Machines)");
    } else if (away && needsSignature(c, s.signed)) {
      // A machine whose server is elsewhere takes it only signed: one that keeps
      // no keys yet (connected before, or its keys taken off) takes nothing that can run something until it does.
      return refuse("this machine takes what can run something only signed by its owner's passkey, and keeps none yet: turn on Signing on its row in Machines, or connect it again");
    }
    // Its keys are its own page's to say.
    // Another page of yours says only what's become of its own keys here: some taken off there (`forget`, which only
    // takes away), or a change of them signed by one this machine takes for that page.
    const forgetting = c.kind === "keys.vouch" && Array.isArray(c.args.forget) && !c.args.vouch && !c.args.drop;
    if (elsewhere && (c.kind === "keys.pin" || (c.kind === "keys.vouch" && !forgetting))) return refuse("only this machine's own page changes its passkeys or the pages it takes signatures from");
    if (elsewhere && (forgetting || c.kind === "keys.change") && !fromSite) return refuse("this machine takes nothing signed on the page it came from, so it keeps none of that page's keys to change");
    if (forgetting && !elsewhere) return refuse("only the page whose passkeys they are takes them off here: take a page off with drop");
    // Keys to keep come only to a machine that keeps none (it took anything its server sent until now); after that,
    // a change of keys is checked against the keys it changes: only one of them can add or take off another.
    if (c.kind === "keys.pin" && s.keys.length) return refuse("this machine keeps passkeys already: another comes signed by one of them");
    // Its first keys say whose signature it takes from then on, and nothing signed them. So, with its server elsewhere,
    // only in the day after its person logged it in, on the machine (device.json is written then, and only then): not
    // any time at all, to whoever holds that server. Logging in again brings the keys itself.
    if (c.kind === "keys.pin" && away && !loggedInLately()) return refuse(`this machine takes its passkeys from its server only within ${PIN_HOURS} hours of being logged in. Log it in again, on the machine: agentbook-cli login brings them with it`);
    if (c.kind === "keys.change") {
      const target = c.args.change?.envelope?.machine;
      if (target !== undefined && target !== machineId()) return refuse("this passkey change is for another machine");
      const why = fromSite ? changeRefusal(c.args.change, { keys: fromSite.keys, origin: fromSite.origin, rpId: fromSite.rp_id, since: fromSite.keys_at || null }) : s.keys.length ? changeRefusal(c.args.change, { ...pinned, since: s.keys_at || null }) : "this machine keeps no keys to change yet";
      if (why) return refuse(why);
    }
    // Taking another page's signatures is its own page's to say: signed by a key it keeps, or, by a machine whose server
    // is itself that keeps none, as its page says. Taking one off only takes away.
    if (c.kind === "keys.vouch" && !c.args.drop && !forgetting) {
      const why = !s.keys.length && away ? "this machine keeps none of its owner's passkeys, so it takes nothing signed on another page" : vouchRefusal(c.args.vouch, { ...pinned, machine: machineId(), since: s.sites_at || null, unsigned: !s.keys.length });
      if (why) return refuse(why);
    }
    // A path is checked as its handler will use it: its handlers trim it.
    for (const k of ["root", "page_root", "path", "url", "clone"]) if (typeof c.args?.[k] === "string") c.args[k] = c.args[k].trim();
    const sw = switchOf(c.kind);
    if (s.commands[sw] === false) return refuse(`this machine has turned off ${sw} commands (its gate.json)`);
    const spec = COMMANDS[c.kind] || READS[c.kind];
    const steer = !!COMMANDS[c.kind] && spec.steer;
    if (steer) {
      if (!who) return refuse("this machine doesn't know whose it is yet");
      if (c.by !== who) return refuse(c.by ? `@${c.by} isn't this machine's owner` : "it doesn't say who it's from");
    } else if (READS[c.kind]?.owner && c.by && c.by !== who) return refuse(`@${c.by} isn't this machine's owner`);
    // What needs no signature reaches less than what's signed, with its server elsewhere.
    const narrow = away && !needsSignature(c, s.signed);
    for (const x of pathsOf(c)) {
      const why = await pathRefusal(x.p, { ...x, narrow });
      if (why) return refuse(why);
    }
    // A terminal opens in its post's own folder, as this machine has it: one this machine keeps out stays out.
    if (c.kind === "term.open") {
      const own = await postOf(c.args.post);
      if (own?.elsewhere) return refuse("its files are on another machine, where its agent runs");
      if (!own?.dirs?.length) return refuse("this machine has no folder for that thread");
      const why = await pathRefusal(own.dirs[0], { post: c.args.post, narrow });
      if (why) return refuse(why);
    }
    if (c.kind === "read.folders") {
      if (!c.args.path) {
        const from = startFolder();
        if (from) c.args.path = from;
      }
      const l = listing(c.args.path);
      if (l.refused) return refuse(l.refused);
      c.only = l.only;
    }
    if (c.kind === "read.skill" && Array.isArray(c.args.roots)) {
      const dirs = readable();
      c.args.roots = c.args.roots.filter((r) => typeof r === "string" && path.isAbsolute(tilde(r)) && dirs.some((d) => inside(real(path.resolve(tilde(r))) || "", d)));
    }
    if (STARTS.has(c.kind)) {
      const now = Date.now();
      while (recent.length && now - recent[0].at > 3600e3) recent.shift();
      const { lid, ...same } = c.args || {};
      const key = JSON.stringify([c.kind, same, c.by]);
      if (recent.some((r) => r.key === key && now - r.at < REPEAT_MS)) return refuse("the same new thread came twice in a row");
      if (recent.length >= s.starts_per_hour) return refuse(`it's past this machine's ${s.starts_per_hour} new threads an hour (its gate.json)`);
      recent.push({ at: now, key });
    }
    if (s.ask_here.some((k) => k === c.kind || k === sw)) {
      audit(c, "asked");
      try {
        notify(c);
      } catch {}
      const yes = await new Promise((resolve) => {
        asking.set(c.cid, { c, at: new Date().toISOString(), resolve });
        const ms = c.expires ? Date.parse(c.expires) - Date.now() : 3600e3;
        setTimeout(() => {
          if (asking.delete(c.cid)) resolve(false);
        }, Math.max(1000, Math.min(ms || 3600e3, 2 ** 31 - 1))).unref?.();
      });
      if (!yes) return refuse("it wasn't OK'd on this machine");
      audit(c, "approved");
    }
    if (COMMANDS[c.kind]) audit(c, "ran");
    return null;
  }

  return {
    check,
    settings,
    agree,
    wrote,
    shared,
    readable,
    listing,
    // What the machine's page shows of it (it can't change any of it).
    summary() {
      const s = settings();
      return {
        owner: s.owner,
        shared: readable().slice(0, 200).map(short),
        never: s.never,
        off: Object.keys(s.commands).filter((k) => s.commands[k] === false),
        starts_per_hour: s.starts_per_hour,
        ask_here: s.ask_here,
        // Whether what goes up has its secrets replaced (redact.ts).
        redact: s.redact !== false,
        waiting: asking.size,
        // `sessions`: the longest a browser's key its passkey signed may sign for it, in hours (0: the passkey, every time).
        // `sites`: the other pages of its person's whose signatures it takes (keys.vouch), each with its keys.
        signed: s.keys.length || s.sites.length ? { machine: machineId(), origin: s.origin, rp_id: s.rp_id, kinds: s.signed, keys: s.keys.map((k) => ({ name: k.name || null, fingerprint: fingerprint(k.spki) })), sessions: s.session_hours, sites: s.sites.map((x) => ({ origin: x.origin, name: x.name || null, keys: x.keys.map((k) => ({ name: k.name || null, fingerprint: fingerprint(k.spki) })) })) } : null,
        // Whether its server is on this machine: then it takes commands unsigned while it keeps no keys.
        server_here: !hosted(),
      };
    },
    pathRefusal,
    machineId,
    // The passkeys this machine takes signed commands from, and the page and site they sign on,
    // as agentbook-cli keys shows and exports them.
    keys() {
      const s = settings();
      return { v: 1, machine: machineId(), origin: s.origin, rp_id: s.rp_id, keys: s.keys.map((k) => ({ ...k, fingerprint: fingerprint(k.spki) })), sites: s.sites.map((x) => ({ origin: x.origin, name: x.name || null, at: x.at, keys: x.keys.map((k) => ({ name: k.name || null, fingerprint: fingerprint(k.spki) })) })) };
    },
    // Keep more keys: from another machine (agentbook-cli keys export | import), or as a login pinned them. The page
    // and site come with the first; keys signed on another page aren't taken alongside them.
    importKeys(from) {
      const s = settings();
      const origin = typeof from?.origin === "string" ? from.origin : null;
      const rp = typeof from?.rp_id === "string" ? from.rp_id : null;
      if (!origin || !rp || !/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error("Those keys don't say which page they sign on.");
      if (s.keys.length && (s.origin !== origin || s.rp_id !== rp)) throw new Error(`This machine takes commands signed on ${s.origin}, not ${origin}. agentbook-cli keys remove its keys first.`);
      const add = (Array.isArray(from.keys) ? from.keys : []).map(({ id, alg, spki, name, added }) => ({ id, alg, spki, ...(typeof name === "string" ? { name: name.slice(0, 80) } : {}), added: typeof added === "string" ? added : new Date().toISOString() })).filter(isKey);
      if (!add.length) throw new Error("There are no keys in that.");
      const keys = [...s.keys.filter((k) => !add.some((a) => a.id === k.id)), ...add];
      save({ keys, origin, rp_id: rp });
      return add;
    },
    // Stop taking one (by its id or its fingerprint). With none left, nothing needs a signature here.
    removeKey(which) {
      const s = settings();
      const keys = s.keys.filter((k) => k.id !== which && fingerprint(k.spki) !== which);
      if (keys.length === s.keys.length) throw new Error(`This machine keeps no key ${which}.`);
      save({ keys, ...(keys.length ? {} : { origin: null, rp_id: null }) });
      return s.keys.length - keys.length;
    },
    // Whose machine this is, held to the first answer: the server can't hand it to someone else later.
    pin(username) {
      if (username && !settings().owner) {
        save({ owner: username });
        log(`gate: this machine is @${username}'s`);
      } else if (username && settings().owner !== username) log(`gate: the server says this machine is @${username}'s, but it's @${settings().owner}'s (gate.json): only @${settings().owner} steers it`);
    },
    // Logged out: the next server to log it in names its owner again.
    unpin() {
      if (settings().owner) save({ owner: null });
    },
    // Commands waiting for an OK here, and the OK (or not).
    waiting: () => [...asking.values()].map(({ c, at }) => ({ cid: c.cid, kind: c.kind, by: c.by, at, args: c.args })),
    approve(cid, yes = true) {
      const a = asking.get(cid);
      if (!a) return false;
      asking.delete(cid);
      a.resolve(!!yes);
      return true;
    },
    // Share a folder (and take it off `never`), or keep one out: off `folders`, and on `never` when it would still
    // be shared without being told.
    allow(folder) {
      const p = real(path.resolve(tilde(folder)));
      if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`There's no folder ${folder}.`);
      if (inGit(p)) throw new Error(`${folder} is inside .git.`);
      const same = (f) => real(path.resolve(tilde(f))) === p;
      save({ folders: [...settings().folders.filter((f) => !same(f)), short(p)], never: settings().never.filter((f) => !same(f)) });
      return p;
    },
    deny(folder) {
      const p = real(path.resolve(tilde(folder))) || path.resolve(tilde(folder));
      const same = (f) => (real(path.resolve(tilde(f))) || path.resolve(tilde(f))) === p;
      const folders = settings().folders.filter((f) => !same(f));
      save({ folders });
      const still = shared().some((d) => inside(p, d) || inside(d, p));
      if (still) save({ never: [...settings().never.filter((f) => !same(f)), short(p)] });
      return p;
    },
    // A change of keys its gate checked (keys.change): the keys it adds join those kept here, and the ones it takes
    // off go. Taking off the last one (its person turning signing off, signed) leaves it taking commands unsigned.
    applyKeysChange(change) {
      const e = change.envelope;
      const s = settings();
      const add = e.add.filter(isKey).map(({ id, alg, spki, name }) => ({ id, alg, spki, ...(typeof name === "string" ? { name: name.slice(0, 80) } : {}), added: new Date().toISOString() }));
      const keys = [...s.keys.filter((k) => !e.remove.includes(k.id) && !add.some((a) => a.id === k.id)), ...add];
      save({ keys, keys_at: e.at, ...(keys.length ? {} : { origin: null, rp_id: null }) });
      return { keys: keys.length };
    },
    // Another page of its person's whose signatures it takes now (keys.vouch, as its gate checked it), in place of what
    // it took for that page before; or one it stops taking (`drop`: its address).
    vouch(v) {
      const e = v.envelope;
      const site = pinOf(e.site);
      const s = settings();
      const name = typeof e.name === "string" ? e.name.slice(0, 80) : undefined;
      const keys = site.keys.map((k) => ({ ...k, added: new Date().toISOString() }));
      save({ sites: [...s.sites.filter((x) => x.origin !== site.origin), { origin: site.origin, rp_id: site.rp_id, keys, ...(name ? { name } : {}), at: e.at, keys_at: e.at }], sites_at: e.at, took: tookWith(s, site.origin) });
      log(`gate: takes what's signed on ${site.origin} (${keys.length} key${keys.length === 1 ? "" : "s"})`);
      return { sites: settings().sites.length };
    },
    // What another page of its person's said of its own keys here (`from`: its address), as its gate checked it: some
    // taken off there (forget), or a change signed by one it takes for that page (changeSite). A page left with none
    // goes: what's signed there is refused until you Sign once again. Either is dated, so a change from before it
    // can't be sent again to put a key back.
    forget(from: From, ids) {
      return siteKeys(from, (keys) => keys.filter((k) => !ids.includes(k.id)), new Date().toISOString());
    },
    changeSite(from: From, change) {
      const e = change.envelope;
      const add = e.add.filter(isKey).map(({ id, alg, spki, name }) => ({ id, alg, spki, ...(typeof name === "string" ? { name: name.slice(0, 80) } : {}), added: new Date().toISOString() }));
      return siteKeys(from, (keys) => [...keys.filter((k) => !e.remove.includes(k.id) && !add.some((a) => a.id === k.id)), ...add], e.at);
    },
    // A page of its person's, with no Sign once (page-keys.ts): your passkeys there, as that page said them over the
    // connection its certificate proved yours, taken while this machine keeps none of that page's. After that, a change
    // of them comes signed by one it keeps (changeSite). Each page once: one whose keys were all taken off since (a
    // lost phone takes them off unsigned), or that it was told to stop taking, is taken again only once its person logs
    // this machine in again, on it (retake), or Signs once for it, so a sign-in stolen there can't swap in a passkey.
    takeSite(from: From, page: { origin: string; rp_id: string; keys: unknown[] }): { keys: number } | { error: string } | null {
      const s = settings();
      if (siteFrom(s.sites, from) || originOf(page.origin) !== page.origin) return null;
      const took = Array.isArray(s.took) ? s.took : [];
      if (took.includes(page.origin)) return { error: `This machine took your passkeys on ${page.origin} before, and keeps none of them now.` };
      const at = new Date().toISOString();
      const keys = page.keys.filter(isKey).map(({ id, alg, spki, name }) => ({ id, alg, spki, ...(typeof name === "string" ? { name: name.slice(0, 80) } : {}), added: at }));
      if (!keys.length) return null;
      const name = typeof from === "object" && from?.peer ? from.peer.slice(0, 80) : undefined;
      save({ sites: [...s.sites.filter((x) => x.origin !== page.origin), { origin: page.origin, rp_id: page.rp_id, keys, ...(name ? { name } : {}), at, keys_at: at }], took: tookWith(s, page.origin) });
      log(`gate: takes what's signed on ${page.origin} (${keys.length} key${keys.length === 1 ? "" : "s"}), a page of this machine's person's`);
      return { keys: keys.length };
    },
    // Logged in again on the machine (agentbook login): it takes each page's passkeys unsigned once more.
    retake() {
      if (settings().took?.length) save({ took: [] });
    },
    // The page a linked machine of its person's is at, as this machine took it (keys.vouch), or null.
    siteOf: (from: From) => siteFrom(settings().sites, from),
    // A page it stops taking, as you said on its page (keys.vouch drop): not taken again unsigned. `unlinked`: that
    // page's machine left your account, so one linked again in its place (logged in again, on it) is taken as new.
    unvouch(origin, { unlinked = false } = {}) {
      const s = settings();
      const sites = s.sites.filter((x) => x.origin !== origin);
      const took = unlinked ? (s.took || []).filter((o) => o !== origin) : tookWith(s, origin);
      if (sites.length !== s.sites.length || String(took) !== String(s.took || [])) save({ sites, took });
      if (sites.length !== s.sites.length) log(`gate: takes nothing signed on ${origin} now`);
      return { sites: sites.length };
    },
    audits(n = 50) {
      try {
        return fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
