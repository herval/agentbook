// Connectors: other tools whose work comes into agentbook. Each is one person's own, not a workspace's or an
// agent's: it signs in with their own API key and fills their Tasks. Everyone's are kept where the page is
// (agentbook-server), in its database (the `connectors` table), each with its owner, and each person sets up and
// changes their own on the Connectors page. Their secrets (an API key, a GitHub sign-in's refresh token) are sealed
// there with agentbook-server's secret key (secrets.ts), which is never in its data folder: without it, nothing
// that needs one is kept, and one kept with a key that isn't here says so. A key can also be "$LINEAR_API_KEY",
// read from agentbook's environment, which stays as it is.
//
// A connector, as the page sends it and its row keeps it (but for its secrets, in columns of their own):
//
//   { "id": "linear", "kind": "linear", "name": "Linear", "api_key": "lin_api_…", "owner": "herval",
//     "states": ["unstarted", "started"], "teams": ["ENG"], "workspace": "agentbook", "agent": "claude",
//     "close": true, "every": 120 }
//
// - owner: whose it is, and whose Tasks it fills (an account here; this machine's owner when it's left out).
//   Only they see it on the Connectors page, sync it, change it or remove it.
// - states, teams: which issues (Linear's kinds of state: triage, backlog, unstarted, started; team keys). For
//   GitHub: "issues" (assigned to you) and "reviews" (pull requests waiting for your review), none for nothing
//   into Tasks; teams are repos ("owner/name") and organizations.
// - workspace, agent: what its tasks are for, so sending one picks them (a workspace's id, name or repo).
// - close: ticking a task closes its issue there, and unticking puts it back (unless it's false).
// - every: seconds between syncs (120). off: true leaves it be.
//
// They used to be kept in <data folder>/connectors.json, in plain: on start, that file is moved into the database,
// sealed, and removed. One that can't be (it isn't valid, or has keys and there's no secret key here) stays, its
// connectors working as it says, beside the database's, and nothing is changed until it's moved.
//
// Linear and GitHub are the kinds. A sync brings each open issue in as a task with a `source` (the issue: its key,
// link, title and state), its title the task's (a long one cut, the rest in its body, as titled() does), changes a
// task whose issue was renamed (unless you edited its title, or that rest, here), and ticks
// one whose issue is done, canceled or no longer yours. Deleting such a task here keeps the issue out until it
// leaves the connector's issues. A GitHub connector's token is also how agentbook reads GitHub as its owner
// (keyFor): their workspaces' pull requests.

import fs from "node:fs";
import path from "node:path";
import { SERVER_HOME } from "../config.ts";
import { ENV as KEY_ENV, isSealed } from "../secrets.ts";
import type { createSecrets } from "../secrets.ts";
import { titled } from "../../plugin/shared/text.ts";
import type { Frame } from "../../plugin/shared/dashboards.ts";
import type { Storage } from "../../plugin/shared/storage.ts";
import type { PanelQuery, State, TaskSource } from "../../plugin/shared/types.ts";
import type { TaskOp } from "../../plugin/shared/ops.ts";
import { ConnectorTables } from "../storage/connectors.ts";
import type { ConnectorRow } from "../storage/connectors.ts";
import * as github from "./connectors/github.ts";
import { appConfig, refresh as refreshApp } from "./github-app.ts";
import * as linear from "./connectors/linear.ts";
import { refresh as refreshLinear } from "./linear-app.ts";
import * as datadog from "./connectors/datadog.ts";
import * as boat from "./connectors/boat.ts";
import * as exe from "./connectors/exe.ts";

// A connector's secrets, by their field.
type Secret = "api_key" | "refresh_token" | "app_key";
// A connector as it's kept (normal()), its secrets opened.
export interface Connector {
  id: string;
  kind: string;
  name: string;
  api_key: string;
  owner: string | null;
  states: string[];
  teams: string[];
  workspace: string | null;
  agent: string | null;
  close: boolean;
  every: number;
  off: boolean;
  via: "app" | null;
  refresh_token: string | null;
  expires_at: string | null;
  app_key: string;
  settings: Record<string, string>;
  // From its row: its place, what's sealed that couldn't be opened, and why ("none", "other" or "broken").
  ord?: number;
  sealed?: Partial<Record<Secret, string>>;
  locked?: string;
}
// A connector as its kind gets it, ready to use: with its key.
export interface ConnectorConf extends Connector {
  key: string;
}
// An issue (or a pull request) a kind brings into Tasks, in agentbook's words: a task's source is made of it.
export interface SourceItem {
  id: string;
  key: string;
  title: string;
  url: string;
  state: string | null;
  state_type: string | null;
  state_id: string | null;
  team: string | null;
  updated: string | null;
  // Still yours there (assigned to you, waiting for your review).
  mine: boolean;
  priority?: number;
}
// A setting a kind takes (FIELDS): one of `of`, or a text; `default` when it's left out.
export interface KindField {
  of?: string[];
  default: string;
  label?: string;
  about?: string;
}
// A panel's query as a Data side gets it: its range and interval (ms), and the variables it uses, picked.
export interface DataQuery extends PanelQuery {
  from: number;
  to: number;
  interval: number;
  vars: Record<string, string | string[]>;
}
export interface DataAnswer {
  frames: Frame[];
  notes?: string[];
  ms?: number;
}
// A kind's Data side: its languages (what an agent is told each is), its budget per language an hour, how many
// queries at once, and asking it.
export interface DataSide {
  langs: Record<string, string>;
  budget?: Record<string, number>;
  at_once?: number;
  query(c: ConnectorConf, q: DataQuery): Promise<DataAnswer>;
  discover(c: ConnectorConf, what: Record<string, unknown>): Promise<Record<string, unknown>>;
  link?(c: ConnectorConf, q: DataQuery): string | null;
}
export interface ConnectorKind {
  kind: string;
  name: string;
  STATES?: Record<string, string>;
  DEFAULT_STATES?: string[];
  OPTIONAL?: boolean;
  KEY?: string;
  // Its secrets besides its key, by field, with what each is called.
  SECRETS?: Partial<Record<Secret, string>>;
  // People sign in to it with agentbook's app for it, rather than pasting a key (Linear's: linear-app.ts).
  SIGNIN?: boolean;
  FIELDS?: Record<string, KindField>;
  SCOPES?: string[];
  ABOUT?: string;
  // It runs machines (boat, exe.dev), rather than filling Tasks.
  machines?: boolean;
  scopes?(list: string[]): string[];
  // Who the key signs in as, in words; what it can't be seen to do.
  check(key: string, conf?: ConnectorConf): Promise<string>;
  lacks?(key: string, conf?: ConnectorConf): Promise<string[]>;
  pull?(c: ConnectorConf): Promise<SourceItem[] | null>;
  lookup?(c: ConnectorConf, ids: string[]): Promise<SourceItem[]>;
  goneWhy?(item: SourceItem | undefined): string;
  closes?(source: TaskSource): boolean;
  close?(c: ConnectorConf, id: string): Promise<{ item: SourceItem | null; was: string | null }>;
  reopen?(c: ConnectorConf, id: string, was?: string | null): Promise<SourceItem>;
  data?: DataSide;
}

// A kind may fill Tasks (`pull`), answer a dashboard's queries (its Data side, `data`: dashboards-plan.md), or both.
// One that needs more than a key says so: SECRETS (another sealed field, like Datadog's application key) and FIELDS
// (settings, like its site).
export const KINDS: Record<string, ConnectorKind> = { linear, github, datadog, boat, exe };
// Where they were kept before the database.
const FILE = () => path.join(SERVER_HOME, "connectors.json");
// A connector's secrets, each sealed on its own, for that connector and field: its key, a sign-in's refresh token, and
// a kind's second key (Datadog's application key).
const SECRETS: Secret[] = ["api_key", "refresh_token", "app_key"];
const sealedFor = (id: string, field: Secret) => `connector ${id} ${field}`;
const EVERY = 120;
const MIN_EVERY = Number(process.env.AGENTBOOK_CONNECTOR_MIN_EVERY || 30);
const TICK_MS = Number(process.env.AGENTBOOK_CONNECTOR_TICK_MS || 5000);
// A sign-in (with agentbook's GitHub App, or its Linear app) is renewed this long before it runs out, trying again at
// most this often when it won't be.
const RENEW_MS = Number(process.env.AGENTBOOK_GITHUB_RENEW_SEC || 1800) * 1000;
const RENEW_RETRY_MS = Number(process.env.AGENTBOOK_GITHUB_RENEW_RETRY_SEC || 60) * 1000;

const words = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []).map((x) => String(x).trim()).filter(Boolean);

// A connector as it's given (the page's, connectors.json's, a row's data), anything in it.
type ConnectorInput = { [field: string]: unknown; settings?: Record<string, unknown> };
// A connector as it's kept, with what's left out filled in.
function normal(c: ConnectorInput): Connector {
  const k = KINDS[String(c.kind)];
  const fields: Record<string, KindField> = k?.FIELDS || {};
  return {
    id: String(c.id),
    kind: String(c.kind || ""),
    name: String(c.name || k?.name || c.kind || "Connector").slice(0, 60),
    api_key: typeof c.api_key === "string" ? c.api_key.trim() : "",
    owner: c.owner ? String(c.owner) : null,
    states: words(c.states).filter((s) => k?.STATES?.[s]),
    // Linear's team keys are upper case; GitHub's repos and organizations are as they're written.
    teams: k?.scopes ? k.scopes(words(c.teams)) : words(c.teams).map((s) => s.toUpperCase()),
    workspace: c.workspace ? String(c.workspace) : null,
    agent: c.agent ? String(c.agent) : null,
    close: c.close !== false,
    every: Math.max(MIN_EVERY, Number(c.every) || EVERY),
    off: !!c.off,
    // Signed in (with agentbook's GitHub App, or its Linear app) rather than a pasted key: its key runs out
    // (`expires_at`), and its refresh token renews it.
    via: c.via === "app" ? "app" : null,
    refresh_token: typeof c.refresh_token === "string" && c.refresh_token ? c.refresh_token : null,
    expires_at: typeof c.expires_at === "string" && c.expires_at ? c.expires_at : null,
    // A kind's second key, and its settings (FIELDS: one of `of`, or its default).
    app_key: typeof c.app_key === "string" ? c.app_key.trim() : "",
    settings: Object.fromEntries(Object.entries(fields).map(([f, d]) => [f, settingOf(c.settings?.[f], d)])),
  };
}
// A setting as it's given, as it's kept: one of the field's `of`, or a text, else its default.
function settingOf(v: unknown, d: KindField): string {
  if (typeof v === "string" && d.of?.includes(v)) return v;
  return typeof v === "string" && !d.of && v.trim() ? v.trim().slice(0, 200) : d.default;
}
// A key that ran out (a sign-in nobody could renew) signs nobody in.
const expired = (c: Connector) => !!c.expires_at && Date.parse(c.expires_at) <= Date.now();
const keyOf = (c: Connector) => (c.api_key.startsWith("$") ? process.env[c.api_key.slice(1)] || "" : c.api_key);

// connectors.json's connectors, each with an id of its own: its kind, then "linear-2" and so on.
function fromFile(raw: unknown): Connector[] {
  const list: unknown[] = Array.isArray(raw) ? raw : (raw as { connectors?: unknown[] } | null)?.connectors || [];
  const items = list.filter((c): c is ConnectorInput => c && typeof c === "object");
  const ids = new Set<string>();
  return items.map((c) => {
    let id = c.id ? String(c.id) : String(c.kind || "connector");
    for (let n = 2; ids.has(id); n++) id = `${c.id || c.kind}-${n}`;
    ids.add(id);
    return normal({ ...c, id });
  });
}

// What a connector's row keeps in `data`: everything but its id and secrets.
// What a row's `data` holds.
type ConnectorData = Partial<Omit<Connector, "id" | Secret | "ord" | "sealed" | "locked">> & Pick<Connector, "kind" | "name">;
function dataOf(c: Connector): ConnectorData {
  const o: ConnectorData = { kind: c.kind, name: c.name };
  if (c.owner) o.owner = c.owner;
  if (c.states.length) o.states = c.states;
  if (c.teams.length) o.teams = c.teams;
  if (c.workspace) o.workspace = c.workspace;
  if (c.agent) o.agent = c.agent;
  o.close = c.close;
  if (c.every !== EVERY) o.every = c.every;
  if (c.off) o.off = true;
  if (c.via) Object.assign(o, { via: c.via, expires_at: c.expires_at });
  if (Object.keys(c.settings || {}).length) o.settings = c.settings;
  return o;
}

// A connector as the page sends it to be saved: what's set of it, each only when it's sent.
export interface ConnectorSave {
  id?: string;
  kind?: string | null;
  name?: string | null;
  api_key?: string | null;
  app_key?: string | null;
  workspace?: string | null;
  agent?: string | null;
  settings?: Record<string, string>;
  states?: string[];
  teams?: string[];
  close?: boolean;
  off?: boolean;
  every?: number;
}
// An op on a task that a connector commits (task.add, task.sync, task.remove).
// How a connector is doing: its last sync, who its key signs in as, and its sign-in's renewing.
interface Status {
  syncing: boolean;
  ran: number;
  synced: string | null;
  error: string | null;
  count: number | null;
  who: string | null;
  lacks?: string[];
  renew_error?: string | null;
  renewed?: number;
}
// A sign-in's tokens (github-app.ts, linear-app.ts).
export interface AppTokens {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: string | null;
}

// host: { state, commit, storage (agentbook-server's, plugin/shared/storage.ts), secrets (secrets.ts),
//         ownerOf(username | null) -> account | null, workspaceOf(owner id, ref) -> id | null, taskId(), log, changed() }
export interface ConnectorsHost {
  state: State;
  commit: (op: TaskOp) => unknown;
  log: (line: string) => void;
  storage: Storage;
  secrets: ReturnType<typeof createSecrets>;
  ownerOf: (username: string | null) => { id: string } | null;
  workspaceOf: (owner: string, ref: string | null) => string | null;
  taskId: () => string;
  // A machines kind's connector looked after (cloud.ts's tend).
  tend?: (c: Connector, uid: string) => unknown;
  changed: () => void;
}
export function createConnectors(host: ConnectorsHost) {
  const { state, commit, log, storage, secrets } = host;
  const tables = storage.use(ConnectorTables);
  // error: connectors.json is still there, not moved in (why), and nothing is changed until it is; pending: its
  // connectors meanwhile, as it says them.
  const config: { list: Connector[]; error: string | null; pending: Connector[] } = { list: [], error: null, pending: [] };
  const status = new Map<string, Status>(); // id -> { syncing, ran, synced, error, count, who }
  const calls = new Map<string, number[]>(); // id (and "id lang") -> when it was asked, this last hour
  const busy = new Map<string, number>(); // id -> queries running
  const waiting = new Map<string, (() => void)[]>(); // id -> the ones waiting for a turn
  const statusOf = (id: string): Status => status.get(id) || status.set(id, { syncing: false, ran: 0, synced: null, error: null, count: null, who: null }).get(id);

  // A connector as its row keeps it, its secrets opened. One that can't be opened (no secret key here, or another
  // one) keeps what's sealed as it is (`sealed`) and says why (`locked`: "none", "other" or "broken").
  function fromRow(r: ConnectorRow): Connector {
    const c: Connector = { ...normal({ ...JSON.parse(r.data), id: r.id }), ord: r.ord };
    for (const f of SECRETS) {
      if (!r[f]) continue;
      if (!isSealed(r[f])) {
        c[f] = r[f];
        continue;
      }
      const o = secrets.open(r[f], sealedFor(r.id, f));
      if ("value" in o) c[f] = o.value;
      else {
        c.sealed = { ...c.sealed, [f]: r[f] };
        c.locked ||= o.why;
      }
    }
    return c;
  }
  const load = () => {
    const rows = tables.all().map(fromRow);
    const ids = new Set(rows.map((c) => c.id));
    config.list = [...rows, ...config.pending.filter((c) => !ids.has(c.id))];
    host.changed();
  };

  // Keep one, its secrets sealed: a "$NAME" key stays as it is, and what couldn't be opened stays as it was sealed.
  function put(c: Connector) {
    if (config.error) throw broken();
    const kept = Object.fromEntries(SECRETS.map((f) => [f, c[f] ? (f === "api_key" && c[f].startsWith("$") ? c[f] : secrets.seal(c[f], sealedFor(c.id, f))) : c.sealed?.[f] || null]));
    tables.put({ id: c.id, data: JSON.stringify(dataOf(c)), ...kept });
  }
  const drop = (id: string) => {
    if (config.error) throw broken();
    tables.remove(id);
  };

  // connectors.json, from before the database: moved in, sealed, and removed, once each of its connectors reads
  // back as it was. Ones already here (the same id: it was moved in before, or imported again) stay as they are.
  function moveIn() {
    let raw: string;
    try {
      raw = fs.readFileSync(FILE(), "utf8");
    } catch {
      return;
    }
    let list: Connector[];
    try {
      list = fromFile(JSON.parse(raw));
    } catch (e) {
      config.error = `${FILE()} isn't valid (${e.message}), so agentbook-server didn't move it into its database. Fix it, then restart agentbook-server.`;
      return log(`connectors: ${config.error}`);
    }
    // Without a secret key it stays, and its connectors still work, as it says.
    if (!secrets.ready && list.some((c) => (c.api_key && !c.api_key.startsWith("$")) || c.refresh_token)) {
      Object.assign(config, { pending: list, error: `${FILE()} keeps API keys in plain, and stays until agentbook-server can encrypt them: ${secrets.problem} Set ${KEY_ENV} where agentbook-server runs (\`agentbook-server secret-key\` makes one) and restart it: it moves them into its database, encrypted, and removes the file. Until then, connectors can't be changed.` });
      return log(`connectors: ${config.error}`);
    }
    const had = new Set(tables.ids());
    const fresh = list.filter((c) => !had.has(c.id));
    try {
      storage.transaction(() => {
        for (const c of fresh) put(c);
        for (const c of fresh) {
          const back = fromRow(tables.get(c.id));
          if (back.locked || SECRETS.some((f) => (back[f] || null) !== (c[f] || null))) throw new Error(`${c.id} didn't read back as it was`);
        }
      });
    } catch (e) {
      Object.assign(config, { pending: list, error: `agentbook-server couldn't move ${FILE()} into its database (${e.message}), so it's still there. Restart agentbook-server to try again. Until then, connectors can't be changed.` });
      return log(`connectors: ${config.error}`);
    }
    try {
      fs.rmSync(FILE());
      log(`connectors: moved ${fresh.length} from ${FILE()} into the database, their keys encrypted, and removed the file${fresh.length < list.length ? ` (${list.length - fresh.length} were here already)` : ""}`);
    } catch (e) {
      log(`connectors: moved ${fresh.length} from ${FILE()} into the database, but couldn't remove it: ${e.message}`);
    }
  }

  const ownerOf = (c: Connector) => host.ownerOf(c.owner);
  const mine = (uid: string | null | undefined) => config.list.filter((c) => uid && ownerOf(c)?.id === uid);

  /* ---------- syncing ---------- */

  const src = (c: Connector, i: SourceItem) => ({ connector: c.id, kind: c.kind, id: i.id, key: i.key, url: i.url, title: i.title, state: i.state, state_type: i.state_type, state_id: i.state_id, team: i.team, updated: i.updated });
  const FIELDS = ["connector", "key", "url", "title", "state", "state_type", "state_id", "team"] as const;

  // One sync at a time per connector: asking for one while it runs gets that one.
  const running = new Map<string, Promise<Status>>(); // id -> its sync
  function sync(c: Connector, opts?: { fresh?: boolean }) {
    if (!running.has(c.id)) running.set(c.id, syncing(c, opts).finally(() => running.delete(c.id)));
    return running.get(c.id);
  }
  async function syncing(c: Connector, { fresh = false } = {}): Promise<Status> {
    const st = statusOf(c.id);
    Object.assign(st, { syncing: true, ran: Date.now() });
    host.changed();
    try {
      const kind = KINDS[c.kind];
      if (!kind) throw new Error(`agentbook has no connector for "${c.kind}".`);
      if (c.locked) throw new Error(lockedWhy(c));
      const owner = ownerOf(c);
      if (!owner) throw new Error(c.owner ? `No account here is called ${c.owner}.` : "This agentbook has no account yet.");
      const key = keyOf(c);
      if (!key) throw new Error(c.api_key.startsWith("$") ? `${c.api_key.slice(1)} isn't set where agentbook runs.` : "It has no API key.");
      const conf = { ...c, key };
      // A kind that manages machines (boat) has nothing to pull: a sync is its key checked again, when its person asks
      // (`fresh`) or nothing's known of it yet (after a restart). `lacks`: what the key can't be seen to do.
      if (!st.who || (fresh && kind.machines)) st.who = await kind.check(key, conf);
      if (kind.lacks && (fresh || !st.lacks)) st.lacks = await kind.lacks(key, conf);
      // Null: it brings nothing into Tasks (a GitHub connector only there to read GitHub as you, or one that only
      // answers dashboards).
      // One that manages machines looks after them on its schedule (cloud.ts's tend, which paces itself).
      if (kind.machines && host.tend) await Promise.resolve(host.tend(c, owner.id)).catch((e) => log(`connector ${c.id}: ${e.message}`));
      const items = kind.pull ? await kind.pull(conf) : null;
      if (items) await syncTasks(c, conf, kind, owner.id, items);
      Object.assign(st, { synced: new Date().toISOString(), error: null, count: items ? items.length : null });
    } catch (e) {
      st.error = e.message;
      log(`connector ${c.id}: ${e.message}`);
    } finally {
      st.syncing = false;
      host.changed();
    }
    return st;
  }

  async function syncTasks(c: Connector, conf: ConnectorConf, kind: ConnectorKind, owner: string, items: SourceItem[]) {
    const sourced = Object.values(state.tasks).filter((t) => t.owner === owner && t.source?.kind === c.kind);
    const byIssue = new Map(sourced.map((t) => [t.source.id, t]));
    // New issues go on top of your list, in the connector's order.
    const fresh = items.filter((i) => !byIssue.has(i.id));
    if (fresh.length) {
      const open = Object.values(state.tasks).filter((t) => t.owner === owner && !t.done && !t.removed);
      const top = open.length ? Math.min(...open.map((t) => t.rank)) : 0;
      const workspace = host.workspaceOf(owner, c.workspace);
      fresh.forEach((i, n) => {
        const { text, note } = titled(i.title);
        commit({ t: "task.add", tid: host.taskId(), owner, text, note: note || undefined, workspace, agent: c.agent, rank: top - fresh.length + n, source: src(c, i) });
      });
    }
    for (const i of items) {
      const t = byIssue.get(i.id);
      if (!t || t.removed) continue;
      const s = src(c, i);
      // Its issue is open again after a sync ticked it, or after it was closed from here: open it again. Not
      // when that answer is older than closing it (a sync that started before).
      const reopen = t.done && (t.done_by === "sync" || (t.source.closed && String(i.updated) > t.done_at));
      // Renamed there: the task follows, unless you've edited its title here. What a long title put in its body
      // follows too, unless you've edited that.
      const was = titled(t.source.title);
      const now = i.title !== t.source.title && t.text === was.text ? titled(i.title) : null;
      const note = now && (t.note || "") === was.note && now.note !== was.note ? now.note : undefined;
      if (!reopen && !now && !t.source.gone && FIELDS.every((k) => t.source[k] === s[k])) continue;
      commit({ t: "task.sync", tid: t.id, text: now?.text, ...(note !== undefined ? { note } : {}), source: { ...s, gone: null, ...(reopen ? { closed: null, was: null } : {}) }, ...(reopen ? { done: false } : {}) });
    }
    const seen = new Set(items.map((i) => i.id));
    const gone = sourced.filter((t) => t.source.connector === c.id && !seen.has(t.source.id));
    // Deleted here, and not among its issues any more: forgotten, so the issue comes back if it returns.
    for (const t of gone.filter((t) => t.removed)) commit({ t: "task.remove", tid: t.id, forget: true });
    const open = gone.filter((t) => !t.removed && !t.done);
    if (!open.length) return;
    const found = new Map((await kind.lookup(conf, open.map((t) => t.source.id))).map((i) => [i.id, i]));
    for (const t of open) {
      const i = found.get(t.source.id);
      commit({ t: "task.sync", tid: t.id, done: true, source: { ...(i ? src(c, i) : {}), gone: kind.goneWhy(i) } });
    }
  }

  // Ticking or unticking a task closes or reopens its issue, for a connector that does that: unticking opens
  // one closed from here, or done there. One at a time per task, each doing what the task is now, so ticking and
  // quickly unticking ends with the issue as it was.
  const queue = new Map<string, Promise<void>>();
  function ticked(tid: string) {
    const run = async () => {
      const t = state.tasks[tid];
      // Its owner's own connector: one of someone else's that got the same id never touches it.
      const c = t?.source && mine(t.owner).find((x) => x.id === t.source.connector);
      const kind = c && KINDS[c.kind];
      // Not every task closes something: a GitHub review is done there, not here.
      if (!kind || !c.close || c.off || !keyOf(c) || (kind.closes && !kind.closes(t.source))) return;
      const conf = { ...c, key: keyOf(c) };
      const closedThere = ["completed", "canceled"].includes(t.source.state_type);
      try {
        if (t.done && !t.source.closed && !closedThere) {
          const r = await kind.close(conf, t.source.id);
          commit({ t: "task.sync", tid, source: { ...(r.item ? src(c, r.item) : {}), closed: new Date().toISOString(), was: r.was, error: null } });
        } else if (!t.done && (t.source.closed || t.source.state_type === "completed")) {
          const item = await kind.reopen(conf, t.source.id, t.source.was);
          commit({ t: "task.sync", tid, source: { ...src(c, item), closed: null, was: null, gone: null, error: null } });
        }
      } catch (e) {
        commit({ t: "task.sync", tid, source: { error: `Couldn't ${t.done ? "close" : "reopen"} it in ${c.name}: ${e.message}` } });
      }
    };
    const next = (queue.get(tid) || Promise.resolve()).then(run).catch((e) => log(`connector: task ${tid}: ${e.message}`));
    queue.set(tid, next);
    next.finally(() => queue.get(tid) === next && queue.delete(tid));
    return next;
  }

  // A sign-in is renewed before it runs out: new tokens for old, with the app's client ID. One that won't be renewed
  // (GitHub or Linear signed agentbook out, or the app changed) says so, and its person signs in again.
  const renewing = new Set<string>();
  async function renew(c: Connector) {
    const app = c.kind === "github" ? appConfig() : null;
    renewing.add(c.id);
    try {
      if (c.kind === "github" && !app) throw new Error("agentbook has no GitHub App any more. Sign in again once its admin sets one up, or use a token.");
      // The new tokens take the place of the old ones there: not asked for when they couldn't be kept here.
      if (config.error) throw broken();
      const t = c.kind === "github" ? await refreshApp(app, c.refresh_token) : await refreshLinear(c.refresh_token);
      const now = config.list.find((x) => x.id === c.id);
      if (!now) return;
      put({ ...now, api_key: t.access_token, refresh_token: t.refresh_token || now.refresh_token, expires_at: t.expires_at });
      load();
      statusOf(c.id).renew_error = null;
    } catch (e) {
      // Kept apart from a sync's error: a sync that works with the old key until it runs out doesn't clear it.
      statusOf(c.id).renew_error = /signed agentbook out|Sign in/.test(e.message) ? e.message : `Couldn't renew its sign-in with ${kindName(c)}: ${e.message}`;
      log(`connector ${c.id}: ${e.message}`);
    } finally {
      renewing.delete(c.id);
      host.changed();
    }
  }

  // Each connector syncs when it's due: not one whose key can't be read here, until it can.
  moveIn();
  load();
  const timer = setInterval(() => {
    for (const c of config.list) {
      if (c.via === "app" && c.refresh_token && c.expires_at && Date.parse(c.expires_at) - Date.now() < RENEW_MS && !renewing.has(c.id) && Date.now() - (statusOf(c.id).renewed || 0) > RENEW_RETRY_MS) {
        statusOf(c.id).renewed = Date.now();
        renew(c);
      }
      if (!c.off && !c.locked && !running.has(c.id) && !renewing.has(c.id) && !expired(c) && Date.now() - statusOf(c.id).ran >= c.every * 1000) sync(c);
    }
  }, TICK_MS);
  timer.unref();

  /* ---------- for the API ---------- */

  const kindName = (c: Connector) => KINDS[c.kind]?.name || c.kind;
  // Why a connector's key can't be read here, and what brings it back.
  const lockedWhy = (c: Connector) =>
    !c.locked
      ? null
      : c.locked === "none"
        ? `Its key is kept encrypted, and agentbook-server has no secret key to read it with (${KEY_ENV} isn't set, or isn't a key): its admin starts it with the one it was saved with.`
        : `${c.locked === "other" ? "Its key was saved with another secret key than the one agentbook-server has now" : "Its key can't be read here"}: ${c.via === "app" ? `sign in with ${kindName(c)} again` : "paste it again"}, or ask its admin to start agentbook-server with the ${KEY_ENV} it was saved with.`;
  const errorOf = (c: Connector, st = statusOf(c.id)) => lockedWhy(c) || st.error || st.renew_error || (expired(c) ? `Its sign-in with ${kindName(c)} ran out. Sign in again.` : null);

  // A connector for the page: everything but its key, and how it's doing.
  const HIDDEN: { api_key: undefined; refresh_token: undefined; app_key: undefined; sealed: undefined; ord: undefined } = { api_key: undefined, refresh_token: undefined, app_key: undefined, sealed: undefined, ord: undefined };
  const view = (c: Connector) => {
    const st = statusOf(c.id);
    const k = KINDS[c.kind];
    return { ...c, ...HIDDEN, locked: !!c.locked, key_set: !!keyOf(c) && !expired(c), key_env: c.api_key.startsWith("$") ? c.api_key : null, ...(k?.SECRETS ? { app_key_set: !!c.app_key } : {}), known: !!k, tasks: !!k?.pull, data: !!k?.data, syncing: st.syncing, synced: st.synced, error: errorOf(c, st), count: st.count, who: st.who, ...(k?.lacks ? { lacks: st.lacks || [] } : {}), ...(k?.data ? { calls: callsIn(c.id) } : {}) };
  };

  // connectors.json isn't moved in yet: nothing is changed until it is (config.error says why, to the admin).
  const broken = () => Object.assign(new Error("Connectors can't be changed until agentbook-server's admin finishes moving them into its database."), { status: 409 });
  // No secret key: an API key can't be kept (one from the environment, "$NAME", can).
  const noKey = (owner: boolean) => Object.assign(new Error(owner ? `${secrets.problem} Set ${KEY_ENV} where it runs (\`agentbook-server secret-key\` makes one) and restart it.` : "agentbook-server can't keep API keys until its admin gives it a secret key."), { status: 503 });
  // Why a new key or sign-in can't be kept now, or null.
  const cantKeep = (owner = false) => (config.error ? (owner ? config.error : broken().message) : secrets.ready ? null : noKey(owner).message);

  // Everything below is one person's (`uid`, an account's id): their own connectors, never anyone else's.
  return {
    kinds: () => Object.values(KINDS).map((k) => ({ kind: k.kind, name: k.name, states: k.STATES, default_states: k.DEFAULT_STATES, optional: !!k.OPTIONAL, signin: !!k.SIGNIN, key: k.KEY || "API key", tasks: !!k.pull, data: !!k.data, machines: !!k.machines, secrets: k.SECRETS || null, fields: k.FIELDS || null, scopes: k.SCOPES || null, about: k.ABOUT || null })),
    // `owner`: the machine's, who sees what's wrong with the file, and where it is.
    list: (uid: string, { owner }: { owner?: boolean } = {}) => ({ connectors: mine(uid).map(view), error: cantKeep(owner) }),
    cantKeep,
    // The ones filling this person's Tasks, briefly, for the page's state.
    summary: (uid: string) => mine(uid).map((c) => ({ id: c.id, kind: c.kind, name: c.name, off: c.off, close: c.close, ...(({ syncing, synced, count }) => ({ syncing, synced, count }))(statusOf(c.id)), error: lockedWhy(c) || statusOf(c.id).error })),
    // Add one of your own (it's `by`'s, a username), or change one of yours (`id`). A new API key is tried before
    // it's kept. A key named from agentbook's environment ("$LINEAR_API_KEY") is the machine owner's to use (`env`):
    // anyone else would be using whoever's key that is.
    async save(input: ConnectorSave, { uid, by, env = false }: { uid?: string; by?: string | null; env?: boolean } = {}) {
      if (config.error) throw broken();
      if (!env && String(input.api_key || "").trim().startsWith("$")) throw Object.assign(new Error("A key from agentbook's environment is for its machine's owner only. Paste a key of your own."), { status: 403 });
      const was = input.id ? mine(uid).find((c) => c.id === input.id) : null;
      if (input.id && !was) throw Object.assign(new Error("No such connector."), { status: 404 });
      const kind = KINDS[was?.kind || input.kind];
      if (!kind) throw Object.assign(new Error("agentbook has no connector of that kind."), { status: 400 });
      // Ids are unique across everyone's: a task names its connector by it.
      let id = was?.id || kind.kind;
      for (let n = 2; !was && config.list.some((c) => c.id === id); n++) id = `${kind.kind}-${n}`;
      // A key pasted in place of a sign-in is a key like any other: nothing to renew.
      const pasted: Partial<Pick<Connector, "api_key" | "via" | "refresh_token" | "expires_at">> = input.api_key?.trim() ? { api_key: input.api_key, via: null, refresh_token: null, expires_at: null } : { api_key: was?.api_key || "" };
      // A kind's second key: a new one pasted, or the one it has.
      const second = kind.SECRETS ? { app_key: input.app_key?.trim() ? input.app_key.trim() : was?.app_key || "" } : { app_key: "" };
      const next = normal({ ...(was || { owner: by || null }), ...input, id, kind: kind.kind, ...pasted, ...second, settings: { ...(was?.settings || {}), ...(input.settings || {}) } });
      // One whose key can't be read here keeps it as it was sealed, until another is pasted.
      if (!input.api_key?.trim() && was?.sealed) next.sealed = was.sealed;
      if (!next.api_key && !next.sealed?.api_key) throw Object.assign(new Error(`Paste a ${kind.name} ${kind.KEY || "API key"}.`), { status: 400 });
      for (const f of SECRETS) {
        const label = kind.SECRETS?.[f];
        if (label && !next[f] && !next.sealed?.[f]) throw Object.assign(new Error(`Paste a ${kind.name} ${label}.`), { status: 400 });
      }
      let who: string | null = null;
      let lacking: string[] | null = null;
      const settingsMoved = JSON.stringify(next.settings) !== JSON.stringify(was?.settings || null);
      if (next.api_key !== was?.api_key || next.app_key !== (was?.app_key || "") || ((kind.data || kind.machines) && settingsMoved)) {
        // Before trying it: a key this server can't keep isn't asked about.
        if ((!next.api_key.startsWith("$") || next.app_key) && !secrets.ready) throw noKey(env);
        const key = keyOf(next);
        if (!key) throw Object.assign(new Error(`${next.api_key.slice(1)} isn't set where agentbook runs.`), { status: 400 });
        try {
          who = await kind.check(key, { ...next, key });
          if (kind.lacks) lacking = await kind.lacks(key, { ...next, key });
        } catch (e) {
          throw Object.assign(new Error(e.message), { status: 400 });
        }
      }
      put(next);
      load();
      const st = statusOf(id);
      if (who) st.who = who;
      if (lacking) st.lacks = lacking;
      if (was && (next.api_key !== was.api_key || next.app_key !== was.app_key || next.kind !== was.kind)) st.error = null;
      // Sync it now, with what changed (after one that's running, which started before).
      const saved = config.list.find((c) => c.id === id);
      if (!saved.off) Promise.resolve(running.get(id)).then(() => sync(saved));
      return view(saved);
    },
    remove(id: string, uid: string) {
      if (config.error) throw broken();
      if (!mine(uid).some((c) => c.id === id)) return false;
      drop(id);
      load();
      status.delete(id);
      return true;
    },
    async syncNow(id: string, uid: string) {
      const c = mine(uid).find((x) => x.id === id);
      if (!c) return null;
      // One that's running may have started before what you want it to see: this one starts after it.
      await running.get(id);
      await sync(c, { fresh: true });
      return view(c);
    },
    ticked,
    // The key a person's own connector of a kind signs in with (their GitHub token), or null: one they have on,
    // with a key. Never anyone else's.
    // `via`: "app", only a sign-in with GitHub.
    keyFor(uid: string | null | undefined, kind: string, via: "app" | null = null) {
      const c = mine(uid).find((x) => x.kind === kind && !x.off && keyOf(x) && !expired(x) && (!via || x.via === via));
      return c ? keyOf(c) : null;
    },
    // The key of one connector of theirs, by its id and kind (or one of `kind`, a list), or null: off, gone or without
    // a key (a machine's boat or exe.dev connector, cloud.ts).
    keyById(uid: string | null | undefined, id: string, kind: string | string[]) {
      const c = mine(uid).find((x) => x.id === id && [kind].flat().includes(x.kind) && !x.off && !x.locked);
      return (c && keyOf(c)) || null;
    },
    // The same, with its kind and settings: { id, kind, key, settings } or null.
    byId(uid: string | null | undefined, id: string, kind: string | string[]) {
      const c = mine(uid).find((x) => x.id === id && [kind].flat().includes(x.kind) && !x.off && !x.locked);
      return c && keyOf(c) ? { id: c.id, kind: c.kind, key: keyOf(c), settings: c.settings } : null;
    },
    // Their connectors of a kind (or one of `kind`, a list), briefly: [{ id, kind, name, off }].
    ofKind: (uid: string, kind: string | string[]) => mine(uid).filter((c) => [kind].flat().includes(c.kind)).map((c) => ({ id: c.id, kind: c.kind, name: c.name, off: c.off, settings: c.settings })),
    // A person signed in with agentbook's GitHub App, or its Linear app (`kind`): their connector of that kind takes
    // the new tokens (the one they're signing in again, `settings.id`, or a new one with `settings`), and says who it
    // signs in as. Without an id, GitHub's goes to their GitHub connector (one is how agentbook reads GitHub as them);
    // Linear's to the one of theirs that signs in as the same person in the same workspace (a pasted key's, which the
    // sign-in replaces, keeping its settings), else a new one.
    async signedIn(uid: string, by: string | null, settings: { id?: string } & ConnectorSave, tokens: AppTokens, kindId: "github" | "linear" = "github") {
      if (config.error) throw broken();
      if (!secrets.ready) throw noKey(false);
      const kind = KINDS[kindId];
      const who = await kind.check(tokens.access_token);
      const same = (c: Connector) => c.kind === kindId && (kindId === "github" || statusOf(c.id).who === who);
      const was = (settings.id && mine(uid).find((c) => c.id === settings.id && c.kind === kindId)) || mine(uid).find(same) || null;
      let id = was?.id || kindId;
      for (let n = 2; !was && config.list.some((c) => c.id === id); n++) id = `${kindId}-${n}`;
      const base = was || { owner: by || null, states: kind.DEFAULT_STATES };
      const next = normal({ ...base, ...(was ? {} : settings), id, kind: kindId, api_key: tokens.access_token, via: "app", refresh_token: tokens.refresh_token, expires_at: tokens.expires_at });
      put(next);
      load();
      Object.assign(statusOf(id), { who, error: null, renew_error: null, renewed: 0 });
      const saved = config.list.find((c) => c.id === id);
      if (!saved.off) Promise.resolve(running.get(id)).then(() => sync(saved));
      return view(saved);
    },
    // A dashboard's sources (dashboards-plan.md): this person's connectors with a Data side.
    sources: (uid: string) => mine(uid).filter((c) => KINDS[c.kind]?.data).map((c) => ({ id: c.id, kind: c.kind, name: c.name, off: c.off, error: errorOf(c), langs: KINDS[c.kind].data.langs, calls: callsIn(c.id), budget: KINDS[c.kind].data.budget || null, site: c.settings?.site || null })),
    // Ask one of them (`ref`: its id, or its kind for the first of that kind): a query (`q`: { lang, text, from, to,
    // interval, vars }), what it has (`discover`, `what`), or the same query opened in it (`link`).
    async query(uid: string, ref: string, q: DataQuery) {
      const { c, kind, conf } = dataConn(uid, ref);
      return limited(c.id, kind, q.lang, () => kind.data.query(conf, q));
    },
    async discover(uid: string, ref: string, what: Record<string, unknown> | null) {
      const { c, kind, conf } = dataConn(uid, ref);
      return limited(c.id, kind, "discover", () => kind.data.discover(conf, what || {}));
    },
    link(uid: string, ref: string, q: DataQuery) {
      try {
        const { kind, conf } = dataConn(uid, ref);
        return kind.data.link ? kind.data.link(conf, q) : null;
      } catch {
        return null;
      }
    },
    // Which of this person's connectors a ref names, without asking it: { id, kind, name } or null.
    which(uid: string, ref: string) {
      const c = findData(uid, ref);
      return c ? { id: c.id, kind: c.kind, name: c.name } : null;
    },
    stop: () => clearInterval(timer),
  };

  /* ---------- the Data side ---------- */

  function findData(uid: string, ref: string) {
    const list = mine(uid).filter((c) => KINDS[c.kind]?.data);
    return list.find((c) => c.id === ref) || list.find((c) => c.kind === ref) || null;
  }
  // A person's connector that answers queries, ready to ask: its keys opened. Throws with why it can't be.
  function dataConn(uid: string, ref: string) {
    const c = findData(uid, ref);
    if (!c) throw Object.assign(new Error(`No connector "${ref}" with a Data side. ab_source lists the ones there are; one is set up on the Connectors page.`), { status: 404 });
    const kind = KINDS[c.kind];
    if (c.off) throw Object.assign(new Error(`${c.name} is turned off on the Connectors page.`), { status: 409 });
    if (c.locked) throw Object.assign(new Error(lockedWhy(c)), { status: 409 });
    const key = keyOf(c);
    if (!key) throw Object.assign(new Error(`${c.name} has no API key.`), { status: 409 });
    return { c, kind, conf: { ...c, key } };
  }
  // Each connector's calls in the last hour (what its row shows), and at most a few at a time: a slow source isn't
  // asked again and again while it's answering. A kind's budget per language (Datadog's spans: 300 an hour) is kept
  // to: past it, it answers with why instead of asking.
  function callsIn(id: string) {
    const list = (calls.get(id) || []).filter((t) => t > Date.now() - 3600e3);
    calls.set(id, list);
    return list.length;
  }
  async function limited<T>(id: string, kind: ConnectorKind, lang: string, fn: () => Promise<T>): Promise<T> {
    const cap = kind.data.budget?.[lang];
    const mineNow = (calls.get(`${id} ${lang}`) || []).filter((t) => t > Date.now() - 3600e3);
    if (cap && mineNow.length >= cap) throw Object.assign(new Error(`${kind.name} allows ${cap} ${lang} queries an hour, and agentbook has asked that many: it shows the last answer it got until the hour's up.`), { status: 429, budget: true });
    const at = kind.data.at_once || 4;
    while ((busy.get(id) || 0) >= at) await new Promise<void>((r) => (waiting.get(id) || waiting.set(id, []).get(id)).push(r));
    busy.set(id, (busy.get(id) || 0) + 1);
    const now = Date.now();
    calls.set(id, [...(calls.get(id) || []), now]);
    calls.set(`${id} ${lang}`, [...mineNow, now]);
    try {
      return await fn();
    } finally {
      busy.set(id, busy.get(id) - 1);
      waiting.get(id)?.shift()?.();
    }
  }
}
