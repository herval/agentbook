// The relay: what agentbook-server keeps of each machine, and how it reaches them.
//
// Each machine (a device: a CLI logged in as its person) has a store here of its own, built from the ops it
// sends: its agents, posts, messages, questions, files and starts, under the ids the machine gave them. So a
// machine can only ever write its own. What the page sees of it is that store, plus what the machine knows right
// now (its info: folders, what each post is doing this moment, each agent's models and routines).
//
// Ids: a machine's ids are the page's, unless another machine has one already: then the page knows it with the
// machine's name in front ("laptop~claude"). A post's link keeps working wherever it's opened from.
//
// An agent that lives on another machine than the one reporting it (an OpenClaw agent, on its gateway's machine,
// "brick") keeps one id, with its threads, whichever of its person's machines reaches it: the first to report it
// names it, and any other of theirs reporting the same agent on the same machine shares that id (a twin). One machine
// has it at a time: the one it lives on while that's on, else one that's on. So connecting brick's own agentbook-cli
// after hervalm5 reached its gateway changes where it comes from ("via hervalm5", then not), never its links, pins or
// pages. Only one person's machines share: where an agent lives, and its id there, are a machine's word, so another
// person's machine saying the same (a gateway named like yours, "main" on it, or one lying) has an agent of its own.
//
// Down the other way go commands (what someone did on the page) and reads (what only the machine knows), both
// from a closed list (plugin/shared/protocol.ts). A machine that's off gets its commands when it's back, unless
// they expired first; reads answer from what was last read, with when.

import type { AgentModels, AgentRoutines, AgentRow, LiveLine, ThreadRuntime, Worker } from "../plugin/shared/api.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS, INFO, MIN_PROTOCOL, READS, check, infoKind, opFrom, OPS, PROTOCOL, stateFrom } from "../plugin/shared/protocol.ts";
import { machineName } from "../plugin/shared/ids.ts";
import { cloudSessionId, codexTaskId } from "../plugin/shared/cloud-refs.ts";
import { createStore, publicState, type Store } from "../plugin/shared/store.ts";
import type { MachineState, OpSpec } from "../plugin/shared/protocol.ts";
import type { Avatar, CodeRun, Iso, Loop, RoutineRef } from "../plugin/shared/types.ts";
import type { OpKind, OpOf } from "../plugin/shared/ops.ts";
import type { RuntimeId } from "../plugin/shared/runtimes.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { BlobTables } from "./storage/blobs.ts";
import { RelayTables } from "./storage/relay.ts";
import type { CommandAnswer, DoneStart, KeptCommand, Takes } from "./storage/relay.ts";
import type { Work, WorkSent } from "./work.ts";

const SEP = "~";
const ONLINE_MS = 45e3;
const RESULT_WAIT_MS = 60e3;
// How long commands wait for a machine that's off, scaled (tests make it short).
const EXPIRES_SCALE = Number(process.env.AGENTBOOK_EXPIRES_SCALE || 1);

// The ids in a view, by the fields they're in (as the page reads them), and what's left as it is: data an agent
// wrote, and what a driver says about itself.
const ID_KEYS = new Set(["id", "post", "file_id", "question_id", "lid", "launch", "agent", "done_post", "started_from", "side_of"]);
const SKIP = new Set(["steps", "plan", "rt", "skills", "live", "diffs", "changes", "widgets", "snapshot", "attachments", "data", "loops", "prs", "stats", "context", "skill_uses", "routines", "workspace", "models", "link", "drivers", "updates", "runs"]);

// `work`: where a post's work goes (server/work.ts), kept apart from the machine's store. `blobOk(D, sha)`: whether
// bytes a machine names by their sha256 are its person's to name (server/blobs.ts, theirs). `onChange(D, op, { steps,
// info })`: something of D's changed, the op that did it if one did (of its store, or a post's work); `steps` when
// it's only what its threads are doing this moment (its info, their work), which a machine sends all the time while
// its agents work; `info`, the keys of its info that changed.
const PARKED_MAX = 5000; // a machine's ops this server couldn't take, kept for when it can

// `storage`: where it keeps its tables and each machine's store (scope "device:<id>") and files (devices/<id>-files in
// `home`, the server's data folder; a storage of its own there when none is given). Its databases from before
// storage.db (relay.db, devices/<id>.db) are folded in once, as it starts.
export const scopeOf = (id: string): string => `device:${id}`;
// A command the page sends a machine, as it waits in the machine's queue: signed ones carry their signature too.
// `by`: the username of the person who sent it.
export interface QueuedCommand {
  cid: string;
  kind: string;
  args: Record<string, unknown>;
  by: string | null;
  at: Iso;
  expires: Iso | null;
  v?: number;
  machine?: string;
  sig?: unknown;
}
// What a command or a read comes back with: what its machine answered (its own fields), or why there's none
// (`status`, as HTTP says it), or that it waits for its machine (`queued`, its cid).
export interface CommandResult extends CommandAnswer {
  status?: number;
  queued?: string;
  offline?: boolean;
  expired?: boolean;
  nocache?: boolean;
}
// What a read gives: the machine's answer and when it was read, kept or fresh, or why there's none.
export interface ReadResult {
  data?: unknown;
  fetched?: Iso;
  cached?: boolean;
  offline?: boolean;
  error?: string;
  status?: number;
}
// A command as its owner's passkey signed it: its id, times and fields are the
// envelope's.
export interface CommandEnvelope {
  v?: number;
  machine?: string;
  cid?: string;
  kind?: string;
  args?: Record<string, unknown>;
  by?: string;
  at?: Iso;
  expires?: Iso;
}

// What a machine knows right now, as it last said (plugin/cli/daemon.ts's info()), by key: the machine itself, its
// folders, how busy it is (one in a cloud sandbox), each of its threads' (`post:<id>`) and each agent's
// (`agent:<id>`). Each key is replaced whole. protocol.ts's INFO checks only that each is an object of a size, so any
// field may be missing.
export type DeviceInfo = {
  machine?: MachineInfo;
  folders?: FoldersInfo;
  pace?: PaceInfo;
  [post: `post:${string}`]: PostInfo;
  [agent: `agent:${string}`]: AgentInfo;
};
// The machine: its name, where its person's home and clones are, its drivers, its agentbook-cli, its gate, and a
// seat's (its name, what it shares, its secrets' names, the machine's seats).
export type MachineInfo = {
  name?: string;
  os?: string;
  home?: string;
  clone_dir?: string;
  drivers?: Record<string, unknown>;
  cli?: string;
  update?: unknown;
  gate?: GateSummary;
  // Its agents' past, for the welcome card (plugin/cli/history.ts).
  history?: "pending" | "importing" | "imported" | "picked";
  seat?: string;
  shares?: unknown;
  secrets?: string[];
  seats?: string[];
};
// Its gate, as it sums itself up (plugin/cli/gate.ts's summary): whose it is, what it shares, what it never or
// doesn't do, what waits for an OK there, the passkeys it takes signed commands from, and whether its server is on
// it.
export type GateSummary = {
  owner?: string | null;
  shared?: string[];
  never?: string[];
  off?: string[];
  starts_per_hour?: number;
  ask_here?: string[];
  redact?: boolean;
  waiting?: number;
  // `sites`: other pages of its person's whose signatures it takes, as they linked another machine (keys.vouch).
  signed?: { machine?: string; origin?: string; rp_id?: string; kinds?: string[]; keys?: { name: string | null; fingerprint: string }[]; sessions?: number; sites?: { origin: string; name?: string | null; keys: { name: string | null; fingerprint: string }[] }[] } | null;
  server_here?: boolean;
};
// Its folders (each with the repo it's a checkout of, and its branches' work), and the repos it's cloning.
export type FoldersInfo = {
  folders?: FolderInfo[];
  cloning?: { repo: string; dir: string; error: string | null }[];
};
export type FolderInfo = {
  root: string;
  name?: string;
  machine?: string;
  remote?: string;
  branch?: string | null;
  sessions?: number;
  live?: number;
  last?: Iso;
  wip?: FolderWip[];
};
// A branch of a folder with work on it (plugin/cli/wip.ts): where it's checked out, how far ahead of its base, and
// whether it has changes not committed.
export type FolderWip = {
  id?: string;
  root?: string;
  branch: string;
  sha?: string;
  base?: string;
  base_head?: string | null;
  worktree?: string | null;
  // Where its worktree is, inside the folder.
  place?: string | null;
  here?: boolean;
  ahead?: number;
  commits?: number;
  worked?: boolean;
  behind?: number;
  // The commit it left its base at.
  fork?: { sha: string; at: Iso; subject: string } | null;
  // How many files it changed and didn't commit.
  dirty?: number;
  subject?: string;
  at?: Iso | null;
};
// A cloud machine's: whether stopping it now would cut something off, and when its agentbook-cli started.
export type PaceInfo = {
  busy?: boolean;
  started?: Iso;
  // How its setup script went (plugin/cli/daemon.ts's cloudSetup): the version it set up, and running, ok or failed.
  setup?: { v?: number; state?: string; error?: string; step?: string | null } | null;
};
// A thread's: how it runs, its loops, what it's doing this moment and has going between its turns, the workers its
// agent started, its code blocks running, and when its machine next picks up a turn an API error cut off (or "login").
export type PostInfo = {
  // The runtime it runs on (shared/runtimes.ts), as its machine says; the server and the page read it from the
  // thread's proc and where it runs (runtimeOfThread), which say the same.
  runtime?: RuntimeId;
  rt?: ThreadRuntime | null;
  loops?: Loop[];
  live?: LiveLine | null;
  going?: GoingItem[];
  workers?: Worker[];
  // Its code blocks running, by message and block, as they've gone so far.
  runs?: Record<string, CodeRun>;
  pickup?: string;
};
// Something a thread has going between its turns (a shell, a monitor, a subagent).
export type GoingItem = {
  id: string;
  kind: string;
  title: string;
  started: Iso;
};
// What the page's view of a machine adds to each of its threads, as its machine says it now (and a routine's run,
// the routine it started from).
type ThreadNow = {
  rt?: PostInfo["rt"];
  loops?: Loop[];
  workers?: Worker[];
  pickup?: string;
  routine?: RoutineRef;
};
// An agent's: the runtime that runs it there (shared/runtimes.ts), the machine it lives on (when not this one), and
// what the page shows of it.
export type AgentInfo = {
  runtime?: RuntimeId;
  host?: string | null;
  folders?: boolean;
  repos?: boolean;
  models?: AgentModels;
  routines?: AgentRoutines;
  workspace?: AgentRow["workspace"];
  // How agentbook reaches it (plugin/cli/runtimes/runtime.ts's Link).
  link?: { state: string; connected?: boolean; error?: string | null; since?: Iso | null } | null;
  offline?: boolean;
};
// An op as onChange hears of it: of a machine's store (`t`, its kind there), or a post's work.
export type ChangeOp = { t: string; at?: Iso; post?: string; [field: string]: unknown };
// An op of a machine's, checked (protocol.ts's opFrom): its store op (with the fields that name what it makes), its
// number, when, and its kind.
interface CheckedOp {
  op: ChangeOp & Parameters<NonNullable<OpSpec["makes"]>>[0];
  seq: number;
  at: Iso;
  kind: string;
}
// An op as a machine sends it, before it's checked.
interface SentOp {
  kind?: string;
  seq?: number;
  at?: string;
  args?: unknown;
}
// Whether protocol.ts's opFrom took a machine's op (it says why when it didn't).
const isChecked = (r: Partial<CheckedOp> & { error?: string }): r is CheckedOp & { error?: string } => !r.error;
// The fields of an op that may name bytes by their sha256 (ownBlobs).
interface BlobFields {
  blob?: string | null;
  avatar?: Avatar | null;
  images?: { sha?: string }[];
  sha?: string;
  url?: string;
}
// What the relay asks of the page's accounts: a person by their id (whose a machine is), and a machine by its id.
export interface RelayAccounts<U extends { id: string; username: string }> {
  byId(uid: string): U | null;
  deviceById?(did: string): { name: string; user_id: string } | null;
}
// A long poll for commands: `closed` once its machine hangs up, and how to end its wait now.
export interface PollConn {
  closed?: boolean;
  wake?: () => void;
}
// A machine this server keeps, with its store (the page's copy of what the machine has), from the first time it's
// needed until the process ends.
export interface Device {
  id: string;
  name: string;
  user_id: string | null;
  store: Store;
  // The last of its ops this server has, and the epoch they're from (a new one when its database started over).
  cursor: number;
  epoch: string | null;
  // What it last said of itself ({ key: value }: a thread's live info, an agent's host), from relay.db's info.
  info: DeviceInfo;
  // When it was last heard from, and its long polls: how many are open, and when the last one began.
  seen: number;
  polls: number;
  polled: number;
  queue: QueuedCommand[];
  // Long polls waiting for a command, woken when one is queued.
  waiters: Set<() => void>;
  // Commands someone waits on the answer to, by cid.
  pending: Map<string, { resolve: (answer: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>;
  // Sent and not yet answered, by cid: sent again after RESEND_MS.
  unacked?: Map<string, { c: QueuedCommand; at: number }>;
  // Its ids for things -> the page's.
  map: Map<string, string>;
  // What it said it takes at its last hello ({ kind: [field] }), read once.
  takes?: Takes | null;
  replayed?: boolean;
  nudged?: boolean;
  revoked?: boolean;
  // When its account was made (main.ts's createdOf), read once.
  created?: string;
}

// `onChange`'s third argument: whether it's only what a machine's threads are doing this moment, and which keys of its
// info changed.
export interface ChangeHow {
  steps?: boolean;
  info?: string[];
}
export interface RelayOptions<U extends { id: string; username: string }> {
  home: string;
  storage?: Storage;
  accounts: RelayAccounts<U>;
  work?: Work | null;
  blobOk?: (D: Device, sha: string) => boolean;
  minProtocol?: number;
  log?: (line: string) => void;
  onChange?: (D: Device, op?: ChangeOp | null, how?: ChangeHow) => void;
  onHeld?: (D: Device, c: QueuedCommand) => void;
}
export type Relay<U extends { id: string; username: string } = { id: string; username: string }> = ReturnType<typeof createRelay<U>>;

export function createRelay<U extends { id: string; username: string }>({ home, storage = Storage.open(home), accounts, work = null, blobOk = () => true, minProtocol = MIN_PROTOCOL, log = () => {}, onChange = () => {}, onHeld = () => {} }: RelayOptions<U>) {
  fs.mkdirSync(path.join(home, "devices"), { recursive: true });
  // relay.db had the bytes' bookkeeping too (server/blobs.ts).
  storage.adopt(path.join(home, "relay.db"), { globals: [RelayTables, BlobTables], log });
  // Each named by its machine's id (ids are letters, digits, - and _, so safe() left them as they were).
  for (const f of fs.readdirSync(path.join(home, "devices")).filter((f) => f.endsWith(".db")).sort()) storage.adopt(path.join(home, "devices", f), { scope: scopeOf(f.slice(0, -3)), log });
  const tables = storage.use(RelayTables);
  const devices = new Map<string, Device>(); // device id -> D
  const globals = new Map<string, { device: string; local: string }>(); // a page's id -> { device, local }: the machine that named it
  const twinsOf = new Map<string, Map<string, string>>(); // a page's id -> Map(device id -> local): the other machines that have it too
  const homes = new Map<string, string>(); // "person\0home\0local" -> a page's id: what lives on a machine, by its id there, per person
  for (const r of tables.homes()) homes.set(`${r.owner}\0${r.home}\0${r.local}`, r.global);
  const homeKey = (D: Device, home: string, local: string) => `${D.user_id ?? ""}\0${home}\0${local}`;
  const twinOf = (g: string) => twinsOf.get(g) || twinsOf.set(g, new Map()).get(g);
  let nextCid = Date.now();

  /* ---------- machines ---------- */

  // A machine, with its store, opened the first time it's needed.
  function device(id: string, { name, user_id = null }: { name?: string; user_id?: string | null } = {}): Device {
    let D = devices.get(id);
    if (D) {
      if (name && D.name !== name) D.name = name;
      if (user_id) D.user_id = user_id;
      return D;
    }
    const store = createStore({ storage, scope: scopeOf(id), filesDir: path.join(home, "devices", `${safe(id)}-files`), outbox: false, legacy: false });
    const cur = tables.cursor(id);
    D = { id, name: name || id, user_id, store, cursor: cur?.seq || 0, epoch: cur?.epoch || null, info: tables.infoOf(id) as DeviceInfo, seen: 0, polls: 0, polled: 0, queue: [], waiters: new Set(), pending: new Map(), map: new Map() };
    for (const r of tables.idsOf(id)) {
      D.map.set(r.local, r.global);
      globals.set(r.global, { device: id, local: r.local });
    }
    for (const r of tables.twinsOf(id)) {
      // Shared with what another person's machine named, from before only one person's machines shared: its own again.
      const namer = globals.get(r.global)?.device || tables.namerOf(r.global);
      const theirs = namer && (devices.get(namer)?.user_id ?? accounts.deviceById?.(namer)?.user_id);
      if (theirs && user_id && theirs !== user_id) {
        tables.dropTwin(id, r.local);
        continue;
      }
      D.map.set(r.local, r.global);
      twinOf(r.global).set(id, r.local);
    }
    // Ops after the last cursor written are in its store already: they count.
    D.cursor = Math.max(D.cursor, store.tables.highest("cli"));
    devices.set(id, D);
    registerAll(D);
    learnHomes(D);
    // Commands still waiting for it, from before a restart.
    for (const c of tables.commandsOf(id, ["queued", "sent"])) {
      if (c.expires && Date.parse(c.expires) < Date.now()) {
        tables.expireCommand(c.cid);
        continue;
      }
      D.queue.push(queued(c));
    }
    store.onChange((op: ChangeOp) => {
      if (op.t === "agent.hidden" && op.hidden) rejectInactiveStarts(D);
      onChange(D, op);
    });
    rejectInactiveStarts(D);
    return D;
  }
  const safe = (id: string) => String(id).replace(/[^\w.-]/g, "_");

  const ownerOf = (D: Device): U | null => accounts.byId(D.user_id) || null;
  const online = (D: Device): boolean => Date.now() - D.seen < ONLINE_MS && (D.polls > 0 || Date.now() - D.polled < 5000);

  // Machines that sent something before, opened at start.
  function load() {
    for (const id of tables.devices()) {
      const d = accounts.deviceById?.(id);
      if (d) device(id, { name: d.name, user_id: d.user_id });
    }
  }

  /* ---------- ids ---------- */

  // The page's id for one of a machine's: the same, unless another machine has it (then its name in front). What
  // lives elsewhere and another of its person's machines named already (the same OpenClaw agent, on the same gateway)
  // is that id.
  function idOf(D: Device, local: string): string {
    if (typeof local !== "string" || !local) return local;
    const known = D.map.get(local);
    if (known) return known;
    const home = homeOf(D, local);
    const named = home && homes.get(homeKey(D, home, local));
    if (named && globals.has(named) && globals.get(named).device !== D.id && sameOwner(D, named)) return share(D, local, named);
    for (const g of [local, `${D.name}${SEP}${local}`, `${D.id}${SEP}${local}`]) {
      if (globals.has(g)) continue;
      D.map.set(local, g);
      globals.set(g, { device: D.id, local });
      tables.addId(D.id, local, g);
      if (home) remember(D, home, local, g);
      return g;
    }
    return `${D.id}${SEP}${local}`;
  }
  // Which machine an id from the page is, and its id there: for one machines share, the one that has it now.
  function resolve(global: unknown): { D: Device; local: string } | null {
    const g = String(global ?? "");
    if (twinsOf.has(g)) return holder(g);
    const r = globals.get(g);
    if (!r) return null;
    const D = devices.get(r.device);
    return D ? { D, local: r.local } : null;
  }

  /* ---------- what lives elsewhere: one id, whichever machine reaches it ---------- */

  // The machine an agent lives on, as its driver says (an OpenClaw agent's gateway's, "brick"), and a thread's, its
  // agent's. Null for one that says nothing: it lives on the machine that has it, and no other reports it.
  function homeOf(D: Device, local: string): string | null {
    const s = D.store.state;
    const agent = s.agents[local] ? local : s.sessions[local]?.agent;
    const host = agent && (s.agents[agent]?.host || D.info[`agent:${agent}`]?.host);
    return host ? machineName(String(host).split(".")[0]) : null;
  }
  function remember(D: Device, home: string, local: string, g: string): void {
    const key = homeKey(D, home, local);
    if (homes.has(key)) return;
    homes.set(key, g);
    tables.addHome(D.user_id ?? "", home, local, g);
  }
  // Whether the machine that named a page's id is this one's person's too: only theirs share it.
  const sameOwner = (D: Device, g: string) => devices.get(globals.get(g)?.device)?.user_id === D.user_id;
  // Another of a person's machines reports what one of theirs named already: the same id. What its owner set on it
  // there (archived, hidden, who sees it, its name and avatar) is set on this one's too, so it stays when this one
  // has it.
  function share(D: Device, local: string, g: string): string {
    D.map.set(local, g);
    twinOf(g).set(D.id, local);
    tables.saveTwin(D.id, local, g);
    const first = globals.get(g);
    const A = devices.get(first.device);
    if (A) copyMarks(A, first.local, D, local);
    if (D.store.state.agents[local]) log(`${D.name}: its ${local} is the one ${A?.name || first.device} has, as ${g}`);
    return g;
  }
  function copyMarks(A: Device, a: string, B: Device, b: string): void {
    const s = A.store.state.sessions[a];
    if (s && B.store.state.sessions[b]) {
      if (s.archived || s.hidden) B.store.commit({ t: "session.flag", post: b, ...(s.archived ? { archived: true } : {}), ...(s.hidden ? { hidden: true } : {}) });
      if (s.visibility !== undefined || typeof s.show_work === "boolean") B.store.commit({ t: "session.visibility", post: b, visibility: s.visibility ?? null, ...(typeof s.show_work === "boolean" ? { show_work: s.show_work } : {}) });
    }
    const ag = A.store.state.agents[a];
    if (ag && B.store.state.agents[b]) {
      if (ag.visibility) B.store.commit({ t: "agent.visibility", agent: b, visibility: ag.visibility });
      if (ag.named) B.store.commit({ t: "agent.rename", agent: b, name: ag.name });
      if (ag.hidden) B.store.commit({ t: "agent.hidden", agent: b, hidden: true });
      if (ag.avatar !== undefined || ag.bio !== undefined) B.store.commit({ t: "agent.profile", agent: b, ...(ag.avatar !== undefined ? { avatar: ag.avatar } : {}), ...(ag.bio !== undefined ? { bio: ag.bio } : {}) });
    }
  }
  // What a machine has that lives elsewhere, learned once it says where (its agent's info can come after its id):
  // kept by its person and where it lives, and when another of their machines named it first, this one's own id for
  // it gives way to that.
  function learnHomes(D: Device): void {
    const s = D.store.state;
    for (const local of [...Object.keys(s.agents), ...Object.keys(s.sessions)]) {
      const g = D.map.get(local);
      const home = g && homeOf(D, local);
      if (!home) continue;
      const named = homes.get(homeKey(D, home, local));
      if (!named) remember(D, home, local, g);
      else if (named !== g && globals.get(named) && globals.get(named).device !== D.id && sameOwner(D, named) && globals.get(g)?.device === D.id && !twinsOf.has(g)) {
        globals.delete(g);
        tables.dropId(D.id, local);
        share(D, local, named);
      }
    }
  }
  // Which machine has an id machines share: the one it lives on while that's on, else one that's on, else the one
  // it lives on, else the one that named it. -> { D, local }
  function holder(g: string): { D: Device; local: string } | null {
    const first = globals.get(g);
    if (!first) return null;
    let best: { D: Device; local: string } | null = null;
    let score = -1;
    for (const [id, local] of [[first.device, first.local] as [string, string], ...(twinsOf.get(g) || [])]) {
      const D = devices.get(id);
      if (!D) continue;
      const n = (online(D) ? 2 : 0) + (homeOf(D, local) === machineName(D.name) ? 1 : 0);
      if (n > score) [best, score] = [{ D, local }, n];
    }
    return best;
  }
  // Whether one of a machine's is another machine's to show now: they share its id, and the other has it.
  const shadowed = (D: Device, local: string): boolean => {
    const g = D.map.get(local);
    return !!g && twinsOf.has(g) && holder(g)?.D !== D;
  };
  // Every machine that has what this one knows as `local`, this one first: [{ D, local }].
  function twins(D: Device, local: string): { D: Device; local: string }[] {
    const out = [{ D, local }];
    const g = D.map.get(local);
    if (!g || !twinsOf.has(g)) return out;
    const first = globals.get(g);
    for (const [id, l] of [[first.device, first.local] as [string, string], ...twinsOf.get(g)]) {
      const X = devices.get(id);
      if (X && X !== D) out.push({ D: X, local: l });
    }
    return out;
  }
  // Everything a machine's store has, known by an id here (for one that came whole, or before ids were kept).
  function registerAll(D: Device): void {
    const s = D.store.state;
    for (const id of Object.keys(s.agents)) idOf(D, id);
    for (const id of Object.keys(s.sessions)) idOf(D, id);
    for (const id of Object.keys(s.launches)) idOf(D, id);
    for (const x of [...s.messages, ...s.questions, ...s.files]) idOf(D, x.id);
  }
  // An op the server makes on a machine's store (what the page decides: a post archived, a pull request's state, a
  // question of the server's own), with what it makes known by an id here.
  function commitTo<T extends OpKind>(D: Device, op: OpOf<T>) {
    const full = D.store.commit(op);
    const made = full as { qid?: string; fid?: string; mid?: string; lid?: string };
    for (const id of [made.qid, made.fid, made.mid, made.lid]) if (id) idOf(D, id);
    return full;
  }
  // A machine's value (a view, a post), with its ids as the page knows them. Only ids the machine made change.
  function qualify<T>(D: Device, value: T): T {
    if (Array.isArray(value)) return value.map((v) => qualify(D, v)) as T;
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SKIP.has(k)) out[k] = v;
      else if (ID_KEYS.has(k) && typeof v === "string") out[k] = D.map.get(v) || v;
      else if (k === "files" && Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v.map((x) => D.map.get(x) || x);
      else out[k] = qualify(D, v);
    }
    return out as T;
  }

  /* ---------- ops and info, up ---------- */

  // A machine's batch: its ops in order (each applied once, by its number), and its info. `state`: everything it
  // has, sent once when this server has nothing of it yet. Only what's kept is acked: an op this server couldn't
  // write (a full disk, a locked database) stops the batch there, `unsaved`, and its machine sends it and the ones
  // after it again (POST /api/cli/ops answers 503). -> { acked, error?, unsaved? }
  function ingest(D: Device, { ops = [], info = null, state = null, epoch = null }: { ops?: SentOp[]; info?: Record<string, unknown> | null; state?: unknown; epoch?: string | null } = {}): { acked: number; error?: string; unsaved?: boolean; parked?: number } {
    D.seen = Date.now();
    replayParked(D);
    if (state) {
      let err;
      try {
        err = takeState(D, state, epoch);
      } catch (e) {
        if (!e.unsaved) throw e;
        log(`${D.name}: couldn't keep its threads: ${e.message}`);
        return { acked: D.cursor, error: `this server couldn't keep this machine's threads: ${e.message}`, unsaved: true };
      }
      if (err) return { acked: D.cursor, error: err };
    }
    const errors: string[] = [];
    let unsaved: string | null = null;
    for (const raw of ops) {
      if (raw?.seq <= D.cursor) continue; // had it already
      const r = opFrom(structuredClone(raw));
      if (!isChecked(r)) {
        errors.push(r.error);
        log(`${D.name}: refused an op: ${r.error}`);
        // It isn't sent again, so it's kept as it came: a newer machine's op, which an update of this server can take.
        if (Number.isSafeInteger(raw?.seq) && parkedOf(D) < PARKED_MAX) tables.park(D.id, raw.seq, raw, r.error);
        D.cursor = raw?.seq ?? D.cursor;
        continue;
      }
      try {
        take(D, r);
      } catch (e) {
        if (e.unsaved) {
          unsaved = `op ${r.seq} (${r.kind}) wasn't kept: ${e.message}`;
          log(`${D.name}: ${unsaved}`);
          break;
        }
        // Kept, but applying it failed: sending it again would only fail again.
        log(`${D.name}: op ${r.seq} (${r.kind}) failed: ${e.message}`);
      }
      for (const [, local] of OPS[r.kind].makes?.(r.op) || []) if (local) idOf(D, local);
      D.cursor = r.seq;
    }
    if (ops.length) tables.saveCursor(D.id, D.cursor, epoch || D.epoch);
    if (unsaved) return { acked: D.cursor, error: [...errors, unsaved].join("; "), unsaved: true };
    if (info && typeof info === "object") takeInfo(D, info);
    // Where its agents live, when this batch could have said (an agent's hello, or its info).
    if (ops.some((o) => o?.kind === "agent.hello" || o?.kind === "post.hello") || Object.keys(info || {}).some((k) => k.startsWith("agent:"))) learnHomes(D);
    return { acked: D.cursor, parked: parkedOf(D), ...(errors.length ? { error: errors.join("; ") } : {}) };
  }

  // A checked op, kept where its kind goes.
  function take(D: Device, r: CheckedOp): void {
    const op = ownBlobs(D, r.op);
    if (!op) log(`${D.name}: op ${r.seq} (${r.kind}) named bytes its person didn't send: dropped`);
    else if (OPS[r.kind].audit) kept(() => keepAudit(D, r.seq, { ...op, at: r.at }));
    else if (OPS[r.kind].work) {
      kept(() => work?.apply(D, { ...op, at: r.at } as WorkSent));
      onChange(D, { ...op, at: r.at }, { steps: true });
    } else {
      // An agent removed: what its machine said of it and its threads goes too, as a machine only sends null for a
      // key it sent since it last connected.
      const said = op.t === "agent.remove" ? [`agent:${op.agent}`, ...Object.values(D.store.state.sessions).flatMap((s) => (s.agent === op.agent ? [`post:${s.id}`] : []))] : [];
      D.store.ingest({ ...op, at: r.at, cli: r.seq });
      if (said.length) takeInfo(D, Object.fromEntries(said.map((k) => [k, null])));
    }
  }
  const parkedOf = (D: Device): number => tables.parkedCount(D.id);
  // What it couldn't take before: once per start of this server, since it's an update that changes the answer.
  function replayParked(D: Device): void {
    if (D.replayed) return;
    D.replayed = true;
    for (const row of tables.parked(D.id)) {
      const r = opFrom(row.op);
      if (!isChecked(r)) continue;
      try {
        take(D, r);
        for (const [, local] of OPS[r.kind].makes?.(r.op) || []) if (local) idOf(D, local);
      } catch (e) {
        if (e.unsaved) {
          D.replayed = false; // tried again with its next batch
          return log(`${D.name}: parked op ${r.seq} (${r.kind}) wasn't kept: ${e.message}`);
        }
        log(`${D.name}: parked op ${r.seq} (${r.kind}) failed: ${e.message}`);
      }
      tables.unpark(D.id, row.seq);
      log(`${D.name}: took op ${r.seq} (${r.kind}), which it couldn't before`);
    }
  }

  // An op's own write (its work, a line of its machine's audit): one that fails kept nothing of it (`unsaved`). Both
  // write over what they wrote before, so one that's sent again does the same.
  function kept(write: () => void): void {
    try {
      write();
    } catch (e) {
      throw Object.assign(e, { unsaved: true });
    }
  }

  // An op as it may name bytes by their sha256: only ones its machine's person sent (`blobOk`), since knowing a sha256
  // isn't having the bytes. A file, a step's picture or one its agent named goes without someone else's bytes; an op
  // that's only them (a file's bytes, an avatar) goes. -> the op, or null.
  function ownBlobs(D: Device, op: ChangeOp & BlobFields): ChangeOp | null {
    const ok = (sha: string | null | undefined) => !sha || blobOk(D, String(sha));
    switch (op.t) {
      case "file.add":
        return ok(op.blob) ? op : { ...op, blob: null };
      case "file.blob":
      case "agent.avatar":
        return ok(op.blob ?? op.avatar?.blob) ? op : null;
      case "post.images":
        return { ...op, images: (op.images || []).filter((i) => ok(i?.sha)) };
      case "post.picture":
        return ok(op.sha) ? op : { t: op.t, post: op.post, url: op.url, status: 404, error: "Its machine didn't send that picture." };
      default:
        return op;
    }
  }

  // What a machine's gate did with the commands it got (machine.audit): the latest of it, for its page.
  const AUDIT_KEEP = 500;
  function keepAudit(D: Device, seq: number, op: ChangeOp): void {
    const { t, ...line } = op;
    tables.addAudit(D.id, seq, line, AUDIT_KEEP);
  }
  const audits = (D: Device, n = 100) => tables.audits(D.id, n);

  // What a machine knows right now: each key replaces the last (null removes it).
  function takeInfo(D: Device, info: Record<string, unknown>): void {
    // By its keys as they come: each is one of DeviceInfo's once it's checked.
    const all: Record<string, unknown> = D.info;
    const changed: string[] = [];
    for (const [key, value] of Object.entries(info)) {
      const kind = infoKind(key);
      if (!kind) continue;
      if (value === null) {
        if (key in all) {
          delete all[key];
          tables.dropInfo(D.id, key);
          changed.push(key);
        }
        continue;
      }
      if (check({ value: INFO[kind] }, { value })) continue;
      if (JSON.stringify(all[key]) === JSON.stringify(value)) continue;
      all[key] = value;
      tables.saveInfo(D.id, key, value);
      changed.push(key);
    }
    if (changed.length) onChange(D, null, { steps: true, info: changed });
  }

  // Everything a machine has, the first time it connects (an agentbook from before the split): taken as it is,
  // into a store that has nothing yet. A store with something in it is the record: it's never replaced.
  function takeState(D: Device, state: unknown, epoch: string | null): string | null {
    const s = D.store.state;
    if (Object.keys(s.sessions).length || D.cursor) return "this server already has this machine's threads";
    // Check every record in it, field by field, before taking any of it (stateFrom): this is the one thing a machine
    // sends that no op covers, and one bad field (a thread whose prompt isn't text, a `null` in its messages) would
    // throw in every viewer's page, bringing the whole server down and staying down after a restart. So a bad one is
    // refused whole, taking nothing.
    const checked = stateFrom(state);
    if (checked.error) return checked.error;
    const parts = Object.keys(checked.state).filter((p) => p !== "seq") as Exclude<keyof MachineState, "seq">[];
    const was = Object.fromEntries(parts.map((p) => [p, s[p]]));
    Object.assign(s, Object.fromEntries(parts.map((p) => [p, checked.state[p]])));
    // Bytes it names are its person's, as for an op's (ownBlobs).
    for (const f of s.files || []) if (f?.blob && !blobOk(D, String(f.blob))) delete f.blob;
    for (const a of Object.values(s.agents || {})) for (const k of ["avatar", "avatar_default"] as const) if (a?.[k]?.blob && !blobOk(D, String(a[k].blob))) a[k] = null;
    // Each thread carries the list of what its turns changed, its attachments and its PRs, as one its first op made
    // does; the page reads them as they are.
    for (const x of Object.values(s.sessions)) {
      if (!Array.isArray(x.updates)) x.updates = [];
      for (const k of ["attachments", "prs"] as const) if (!x[k]) x[k] = {};
    }
    // Which process is which post, so a session that's cleared later ends the post it had.
    if (!s.procs || typeof s.procs !== "object") s.procs = {};
    s.seq = Math.max(s.seq, 0);
    // Written before it's acked: one the database couldn't take (a full disk) leaves the store as it was, and its
    // machine sends it again.
    try {
      D.store.checkpoint(true);
    } catch (e) {
      Object.assign(s, was);
      throw Object.assign(e, { unsaved: true });
    }
    D.cursor = checked.state.seq;
    D.epoch = epoch || D.epoch;
    tables.saveCursor(D.id, D.cursor, D.epoch);
    registerAll(D);
    learnHomes(D);
    log(`${D.name}: took its state: ${Object.keys(s.sessions).length} threads, ${s.messages.length} messages`);
    onChange(D);
    return null;
  }

  // A machine connects: what this server has of it, so it sends the rest. Commands it took but never answered
  // (it stopped in between) go to it again: it remembers what it did, and answers those without doing them twice.
  // What a machine said it takes (takenFields), kept: it doesn't say hello again when only this server restarts.
  function takesOf(D: Device): Takes | null {
    if (D.takes === undefined) D.takes = tables.takes(D.id);
    return D.takes;
  }
  const isTakes = (t: unknown): t is Takes => t && typeof t === "object" && !Array.isArray(t) && Object.values(t).every((f) => Array.isArray(f) && f.every((x) => typeof x === "string")) && JSON.stringify(t).length < 256 * 1024;
  // A command as machine D can take it: an optional field it doesn't know stays off, so what's signed is what it
  // checks. One it needs, or a kind it doesn't know, won't do. A machine that hasn't said gets it as it is. -> { args } or { error }.
  function fit(D: Device, kind: string, args: Record<string, unknown> | null): { args?: Record<string, unknown>; error?: string } {
    const known = takesOf(D);
    const spec = COMMANDS[kind] || READS[kind];
    if (!known || !spec) return { args };
    const old = { error: `${D.name}'s agentbook-cli is too old for this: update it.` };
    if (!known[kind]) return old;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (known[kind].includes(k)) out[k] = v;
      else if (spec.fields[k]) return old;
    }
    return { args: out };
  }

  function hello(D: Device, { epoch = null, protocol = 0, version = null, takes = null }: { epoch?: string | null; protocol?: number; version?: string | null; takes?: unknown } = {}) {
    if (protocol && protocol < minProtocol) return { outdated: true, min: minProtocol, protocol: PROTOCOL };
    if (isTakes(takes)) {
      D.takes = takes;
      tables.saveHello(D.id, { protocol: Number(protocol) || 0, version: version ? String(version).slice(0, 40) : null, takes });
    }
    replayParked(D);
    // It's on from its hello, not only once its first wait for commands is open.
    D.seen = D.polled = Date.now();
    for (const c of tables.commandsOf(D.id, ["sent"])) {
      if (D.queue.some((x) => x.cid === c.cid)) continue;
      if (c.expires && Date.parse(c.expires) < Date.now()) {
        tables.expireCommand(c.cid);
        continue;
      }
      D.queue.push(queued(c));
    }
    if (epoch && !D.epoch) {
      D.epoch = epoch;
      tables.saveEpoch(D.id, epoch, D.cursor);
    }
    return { device: D.id, name: D.name, owner: ownerOf(D)?.username || null, cursor: D.cursor, empty: !D.cursor && !Object.keys(D.store.state.sessions).length, protocol: PROTOCOL, min: minProtocol, theirs: protocol, parked: parkedOf(D) };
  }

  /* ---------- what the page sees of a machine ---------- */

  // A machine's view, as it would have shown it itself: its store in summary, with what it knows right now.
  // What a machine knows right now, as it last said.
  const infoOf = (D: Device): DeviceInfo => D.info;
  function view(D: Device) {
    const info = infoOf(D);
    const m = info.machine || {};
    const posts = (id: string): PostInfo | null => info[`post:${id}`] || null;
    // What a session has going between its turns (a shell, a monitor, a subagent), as its machine last said: it's
    // working on that.
    const v = publicState(D.store.state, { going: (s) => (online(D) && posts(s.id)?.going) || null });
    // What it shares with another machine that has it now (an OpenClaw agent brick reaches itself) shows from there.
    const threads: ((typeof v.sessions)[number] & ThreadNow)[] = (v.sessions = v.sessions.filter((s) => !shadowed(D, s.id)));
    const agents: ((typeof v.agents)[number] & AgentInfo & { machine?: string; inactive?: boolean })[] = (v.agents = v.agents.filter((a) => !shadowed(D, a.id)));
    v.questions = v.questions.filter((x) => !shadowed(D, x.post));
    for (const s of threads) {
      const p = posts(s.id);
      s.rt = p?.rt || null;
      // Its loops as its machine says they stand; the store's are the transcript's records, which the page can't read.
      s.loops = p?.loops || undefined;
      // The workers its agent started (OpenClaw's subagents), while its machine is there to say how they're going.
      s.workers = (online(D) && p?.workers) || undefined;
      // When its machine next tries to pick up a turn an API error cut off.
      if (p?.pickup && online(D)) s.pickup = p.pickup;
      // A routine's run: the routine it started from ({ id, name }).
      const l = s.launch && D.store.state.launches[s.launch];
      if (l?.routine) s.routine = l.routine;
    }
    for (const a of agents) Object.assign(a, info[`agent:${a.id}`] || {}, { machine: D.name, inactive: !!a.hidden });
    const folders = info.folders || {};
    const live: Record<string, unknown> = {};
    // What a post is doing this moment, while its machine is there to say.
    if (online(D)) for (const s of v.sessions) if (s.state !== "done" && posts(s.id)?.live) live[s.id] = posts(s.id).live;
    return { ...v, agents, folders: folders.folders || v.folders.map((f) => ({ ...f, machine: D.name })), cloning: folders.cloning || [], live, machine: D.name, home: m.home || null, clone_dir: m.clone_dir || null, drivers: m.drivers || {} };
  }

  /* ---------- commands, down ---------- */

  // Every start goes through here, including routines and queued commands. Continuing an existing
  // thread remains allowed; a side thread or teleport creates a new session.
  function startError(D: Device, kind: string, args: Record<string, unknown> | null): CommandResult | null {
    let agent: unknown = null;
    if (kind === "post.start" || (kind === "routine.do" && (args?.action === "run" || args?.action === "resume"))) agent = args?.agent;
    else if (kind === "post.side" && typeof args?.post === "string") agent = D.store.state.sessions[args.post]?.agent;
    else if (kind === "cloud.pull") agent = codexTaskId(args?.ref) ? "codex" : cloudSessionId(args?.ref) ? "claude" : null;
    const a = typeof agent === "string" ? D.store.state.agents[agent] : null;
    return a?.hidden ? { error: `${a.name} is deactivated. Activate it before starting a new thread.`, status: 409 } : null;
  }

  function rejectInactiveStarts(D: Device): void {
    const rejected: { command: QueuedCommand; error: CommandResult }[] = [];
    D.queue = D.queue.filter((c) => {
      const error = startError(D, c.kind, c.args);
      if (!error) return true;
      rejected.push({ command: c, error });
      return false;
    });
    for (const { command, error } of rejected) finishCommand(D, command.cid, error);
  }

  // A kept command as it goes to its machine, with its signature ({ v, machine, sig }) when it has one.
  const queued = (c: KeptCommand): QueuedCommand => ({ cid: c.cid, kind: c.kind, args: c.args, by: c.by, at: c.at, expires: c.expires, ...(c.signed || {}) });
  // How long a command waits for its machine before it expires: its kind's time, else as long as it's waited for.
  const lifetimeOf = (kind: string, wait = RESULT_WAIT_MS): number => {
    const spec = COMMANDS[kind] || READS[kind];
    return spec?.expires ? spec.expires * EXPIRES_SCALE : wait;
  };
  // Send a command: it waits for the machine (or until it expires), and resolves with what the machine answered,
  // or { queued: cid } when `wait` runs out first. `by`: the username of the person who did it (a machine's gate
  // does what steers it only for its owner).
  // `signed`: { envelope, sig }, what its owner's passkey signed of it, sent as it is:
  // its id, times and fields are the envelope's.
  function command(D: Device, kind: string, args: Record<string, unknown> | null, { by = null, wait = RESULT_WAIT_MS, signed = null }: { by?: string | null; wait?: number; signed?: { envelope?: CommandEnvelope; sig?: unknown } | null } = {}): Promise<CommandResult> {
    const spec = COMMANDS[kind] || READS[kind];
    if (!spec) return Promise.resolve({ error: `${kind} isn't a command`, status: 500 });
    const e = signed?.envelope;
    if (e) args = e.args;
    else {
      const fitted = fit(D, kind, args);
      if (fitted.error) return Promise.resolve({ error: fitted.error, status: 426 });
      args = fitted.args;
    }
    const bad = check(spec.fields, args, { extra: "refuse", where: `${kind}: ` });
    if (bad) return Promise.resolve({ error: bad, status: 400 });
    const inactive = startError(D, kind, args);
    if (inactive) return Promise.resolve(inactive);
    const cid = e ? e.cid : `c${(nextCid++).toString(36)}`;
    if (e && tables.hasCommand(cid)) return Promise.resolve({ error: "That signed command was sent already.", status: 409 });
    const at = e ? e.at : new Date().toISOString();
    const expires = e ? e.expires : new Date(Date.now() + lifetimeOf(kind, wait)).toISOString();
    const sig = e ? { v: e.v, machine: e.machine, sig: signed.sig } : null;
    const c: QueuedCommand = { cid, kind, args, by: e ? e.by : by, at, expires, ...(sig || {}) };
    // One with a secret in it is relayed, never kept: it's held in memory only, so a restart loses it rather than
    // the database keeping it. So is one only someone waiting on it now has a use for.
    if (COMMANDS[kind] && !spec.secret && !spec.now) tables.queueCommand({ cid, device: D.id, kind, args, by: c.by, at, expires, signed: sig });
    D.queue.push(c);
    for (const w of [...D.waiters]) w();
    onChange(D);
    // A machine that's off: the command waits for it, and whoever sent it hears so now.
    // `onHeld(D, c)`: one that waits long enough for a machine in a cloud sandbox to be woken for it (cloud.ts).
    if (COMMANDS[kind] && !online(D)) {
      if (Date.parse(expires) - Date.now() > 120e3) onHeld(D, c);
      return Promise.resolve({ queued: cid, offline: true });
    }
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        D.pending.delete(cid);
        // A read nobody waits for any more is dropped; a command keeps waiting for its machine.
        if (!COMMANDS[kind]) {
          D.queue = D.queue.filter((x) => x.cid !== cid);
          return resolve({ error: online(D) ? `${D.name} didn't answer in time.` : `${D.name} is off.`, status: online(D) ? 504 : 503, offline: !online(D) });
        }
        resolve({ queued: cid, offline: !online(D) });
      }, Math.max(0, wait));
      D.pending.set(cid, { resolve, timer });
    });
  }

  // The machine's long-poll for what to do. `conn.closed` turns true when it hangs up.
  // A command sent with no answer back in a minute (its long-poll's answer was lost: a laptop went to sleep with
  // it open) goes again; the CLI doesn't do one twice, and answers again with what it said.
  const RESEND_MS = 60e3;
  async function takeCommands(D: Device, waitMs: number, conn: PollConn): Promise<QueuedCommand[]> {
    D.seen = Date.now();
    D.unacked ??= new Map();
    for (const [cid, u] of D.unacked) if (Date.now() - u.at > RESEND_MS) (D.unacked.delete(cid), D.queue.push(u.c));
    D.polls++;
    if (D.polls === 1) onChange(D);
    try {
      const end = Date.now() + waitMs;
      while (!D.queue.length && Date.now() < end && !conn.closed && !D.revoked && !D.nudged) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            D.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, Math.max(0, end - Date.now()));
          D.waiters.add(done);
          conn.wake = done;
        });
      }
    } finally {
      D.nudged = false;
      D.polls--;
      D.polled = Date.now();
    }
    if (conn.closed || D.revoked) {
      if (!D.polls) onChange(D);
      return [];
    }
    D.seen = Date.now();
    const now = Date.now();
    const out: QueuedCommand[] = [];
    for (const c of D.queue.splice(0)) {
      if (c.expires && Date.parse(c.expires) < now) {
        expire(D, c);
        continue;
      }
      const inactive = startError(D, c.kind, c.args);
      if (inactive) {
        finishCommand(D, c.cid, inactive);
        continue;
      }
      out.push(c);
      if (COMMANDS[c.kind]) {
        tables.markSent(c.cid);
        D.unacked.set(c.cid, { c, at: now });
      }
    }
    return out;
  }

  function expire(D: Device, c: { cid: string }): void {
    tables.expireCommand(c.cid);
    const p = D.pending.get(c.cid);
    if (p) {
      clearTimeout(p.timer);
      D.pending.delete(c.cid);
      p.resolve({ error: `${D.name} was off, and this ran out of time.`, status: 503, expired: true });
    }
  }

  // What the machine answered. A command kept here is done, whoever made its id: this server ("c…") or its owner's
  // passkey ("s…", signed). One that's never marked so waits for its machine for good: a start shows as Starting.
  function result(D: Device, cid: string, r: CommandAnswer | null): void {
    D.seen = Date.now();
    finishCommand(D, cid, r);
  }

  function finishCommand(D: Device, cid: string, r: CommandAnswer | null): void {
    D.unacked?.delete(cid);
    const was = tables.finishCommand(D.id, String(cid), r);
    // It no longer waits: a thread that showed it as waiting doesn't.
    if (was === "queued" || was === "sent") onChange(D);
    const p = D.pending.get(cid);
    if (!p) return;
    D.pending.delete(cid);
    clearTimeout(p.timer);
    p.resolve(r ?? {});
  }

  // Commands waiting for a machine, for the page: what you sent while it was off (and hasn't run out of time).
  const waiting = (D: Device): Omit<KeptCommand, "signed">[] => {
    sweep(D);
    return tables.commandsOf(D.id, ["queued", "sent"]).map(({ signed, ...c }) => c);
  };
  // Commands that ran out of time waiting: they go, and whoever waits on one hears so.
  function sweep(D: Device): void {
    const now = Date.now();
    const gone = D.queue.filter((c) => c.expires && Date.parse(c.expires) < now);
    if (!gone.length) return;
    D.queue = D.queue.filter((c) => !gone.includes(c));
    for (const c of gone) expire(D, c);
    onChange(D);
  }
  // What's kept of commands done (a page routine's run carries its code) and of reads a machine answered goes after
  // a while: two days for commands, sixty for reads (asked again while the machine is on).
  let pruned = 0;
  function prune() {
    pruned = Date.now();
    tables.prune({ done: new Date(pruned - 2 * 86400e3).toISOString(), reads: new Date(pruned - 60 * 86400e3).toISOString() });
  }
  const ticking = setInterval(() => {
    // Its storage closed when the last store on it let go (a test does, done with a relay): there's nothing left to
    // sweep or prune, and reading it would throw, taking the process down with it.
    if (storage.closed) return clearInterval(ticking);
    for (const D of devices.values()) sweep(D);
    if (Date.now() - pruned > 3600e3) prune();
  }, 5000).unref();
  // Take one back while it waits.
  function cancel(D: Device, cid: string): boolean {
    const was = tables.cancelCommand(D.id, cid);
    D.queue = D.queue.filter((c) => c.cid !== cid);
    if (was) onChange(D);
    return was;
  }

  /* ---------- reads ---------- */

  // What only the machine knows: asked of it now, or the last answer while it's fresh (or while it's off, with
  // when it was read). -> { data, fetched, cached } or { error, status }.
  // A machine that's on is asked each time (what it says changes), except for what never changes (a commit, a
  // picture), kept for good. One that's off answers from what it said last, with when (`keep`).
  async function read(D: Device, kind: string, args: Record<string, unknown> = {}, { wait = 30e3 } = {}): Promise<ReadResult> {
    const spec = READS[kind];
    const key = `${D.id}|${kind}|${JSON.stringify(args)}`;
    const kept = spec.keep ? tables.cachedRead(key) : null;
    if (kept && spec.keep === "forever") return { ...kept, cached: true };
    if (!online(D)) return kept ? { ...kept, cached: true, offline: true } : { error: `${D.name} is off.`, status: 503, offline: true };
    const r = await command(D, kind, args, { wait });
    // A failure says its status; an answer may carry an error that's part of it (a gateway that turned it away).
    if (r?.error && r.status) return kept && (r.status === 503 || r.status === 504) ? { ...kept, cached: true, offline: true } : r;
    const fetched = new Date().toISOString();
    if (spec.keep && !r?.nocache && !(r?.error && r.status)) tables.cacheRead(key, D.id, r, fetched);
    return { data: r, fetched, cached: false };
  }
  // Something its poll's answer carries changed (its person's settings): a poll it has open answers now.
  function nudge(D: Device): void {
    D.nudged = true;
    for (const wake of [...D.waiters]) wake();
  }
  // A machine's device revoked: what was read from it goes, and a poll it has open ends with nothing, now.
  function forget(D: Device): void {
    tables.forgetReads(D.id);
    D.revoked = true;
    for (const wake of [...D.waiters]) wake();
  }
  // A machine deleted with its person's account (server/purge.ts): its store closed and its rows and files removed
  // (its database from before storage.db too), every row of it here gone, and nothing of it left in memory. -> { posts }: the page's ids of the
  // threads it had, for what elsewhere pointed at them.
  function destroy(id: string): { posts: string[]; agents: string[] } {
    const D = devices.get(id);
    const posts = D ? Object.keys(D.store.state.sessions).map((local) => idOf(D, local)) : [];
    const agents = D ? Object.keys(D.store.state.agents).map((local) => idOf(D, local)) : [];
    if (D) {
      forget(D);
      D.store.close();
      devices.delete(id);
    }
    for (const [g, r] of globals) if (r.device === id) globals.delete(g);
    for (const [g, t] of twinsOf) if (t.delete(id) && !t.size) twinsOf.delete(g);
    tables.forgetDevice(id);
    for (const old of [path.join(home, "devices", `${safe(id)}.db`), ...storage.adopted().filter((a) => a.scope === scopeOf(id)).map((a) => a.file)]) for (const ext of ["", "-wal", "-shm"]) fs.rmSync(old + ext, { force: true });
    storage.dropScope(scopeOf(id));
    storage.files(path.join(home, "devices", `${safe(id)}-files`)).removeAll();
    return { posts, agents };
  }
  // What lived elsewhere by a person's machines, once they're gone.
  function forgetHomes(owner: string): void {
    for (const k of [...homes.keys()]) if (k.startsWith(`${owner}\0`)) homes.delete(k);
    tables.forgetHomes(owner);
  }

  // A machine that logged in again (its person approved a new code for it): the new device takes the old one's
  // store, ids and info, so it's the same machine with a new key.
  function adopt(newId: string, oldId: string, { name, user_id }: { name: string; user_id: string }): boolean {
    const old = devices.get(oldId) || (tables.known(oldId) ? device(oldId, { name, user_id }) : null);
    if (!old || devices.has(newId)) return false;
    old.store.close();
    devices.delete(oldId);
    storage.renameScope(scopeOf(oldId), scopeOf(newId));
    const filesFrom = path.join(home, "devices", `${safe(oldId)}-files`);
    if (fs.existsSync(filesFrom)) fs.renameSync(filesFrom, path.join(home, "devices", `${safe(newId)}-files`));
    tables.renameDevice(oldId, newId);
    for (const [g, r] of globals) if (r.device === oldId) globals.set(g, { ...r, device: newId });
    for (const t of twinsOf.values()) if (t.has(oldId)) (t.set(newId, t.get(oldId)), t.delete(oldId));
    device(newId, { name, user_id });
    log(`${name}: logged in again, as the same machine`);
    return true;
  }

  // Starts a machine refused once it took them (its gate, a folder it couldn't use), for a little while, so the page
  // says so instead of the start just going; archived, one goes.
  const failedStarts = (D: Device, ms = 600e3): DoneStart[] => tables.doneStarts(D.id, new Date(Date.now() - ms).toISOString()).filter((c) => c.result?.error);
  const archiveStart = (D: Device, lid: string): boolean => tables.archiveFailedStart(D.id, lid);
  return { devices, device, load, fit, ownerOf, online, idOf, resolve, shadowed, twins, qualify, commitTo, ingest, hello, view, infoOf, command, startError, lifetimeOf, takeCommands, result, waiting, cancel, failedStarts, archiveStart, read, nudge, forget, destroy, forgetHomes, adopt, audits, newId: () => crypto.randomBytes(6).toString("hex") };
}
