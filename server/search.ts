// Server-side full-text search index over threads, messages, notes, pages, tasks, and groups.
// Mirrors littleguys' FTS5 ranking (BM25 + 30-day recency, 1 hit per parent, 28-token snippets)
// while feeding directly from agentbook's server store and device relay ops instead of files.

import { ftsQuery, ftsTerm, plainSnippet, typoBudget } from "../plugin/shared/search.ts";
import { talkTitle } from "../plugin/shared/talks.ts";
import type { Group, GroupNote, Message, Note, Page, Session, State, Talk, Task, Widget } from "../plugin/shared/types.ts";
import type { Device, Relay } from "./relay.ts";
import { SearchStorage } from "./storage/search.ts";
import type { SearchDocRow, SearchEntry, SearchKind } from "./storage/search.ts";

const BATCH_SIZE = 500;
const FLUSH_MS = 250;
const RECENCY_DAYS = 30;
const CANDIDATES = 500;
const CANDIDATES_WIDE = 2000;

export type { SearchDocRow, SearchKind };

export interface SearchCandidate extends SearchDocRow {
  score: number;
}

export interface SearchOptions {
  file: string;
  relay: Pick<Relay, "devices" | "idOf" | "shadowed">;
  state: State;
  log?: (...args: unknown[]) => void;
}

const msOf = (iso: string | null | undefined, fallback = 0): number => {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
};

export function extractWidgetText(widgets: Widget[] | null | undefined): string {
  if (!Array.isArray(widgets) || !widgets.length) return "";
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) parts.push(t);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      parts.push(String(v));
    }
  };
  for (const w of widgets) {
    if (!w) continue;
    push(w.title);
    const d = w.data;
    if (!d) continue;
    push(d.title);
    push(d.text);
    push(d.value);
    push(d.unit);
    push(d.vs);
    if (d.status && typeof d.status === "object") push(d.status.text);
    if (Array.isArray(d.columns)) for (const c of d.columns) push(c);
    if (Array.isArray(d.rows)) {
      for (const row of d.rows) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (cell && typeof cell === "object" && "text" in cell) push(cell.text);
          else if (typeof cell === "string" || typeof cell === "number") push(cell);
        }
      }
    }
    if (Array.isArray(d.items)) {
      for (const it of d.items) {
        if (!it) continue;
        push(it.text);
        push(it.sub);
        push(it.label);
        push(it.name);
        if (Array.isArray(it.pros)) for (const p of it.pros) push(p);
        if (Array.isArray(it.cons)) for (const c of it.cons) push(c);
      }
    }
    if (Array.isArray(d.nodes)) {
      for (const n of d.nodes) {
        push(n.title);
        push(n.text);
      }
    }
    if (Array.isArray(d.edges)) for (const e of d.edges) push(e.label);
    if (Array.isArray(d.markers)) for (const m of d.markers) push(m.label);
    if (d.target) push(d.target.label);
  }
  return parts.join("\n");
}

export function threadIndexText(s: Pick<Session, "title" | "ai_title" | "label" | "prompt" | "text" | "updates" | "repo" | "branch">): string {
  const results = (s.updates || []).filter((u) => !u.changes && u.text).map((u) => u.text);
  return [s.title, s.ai_title, s.label, s.prompt, s.text, ...results, s.repo, s.branch].filter(Boolean).join("\n");
}

export function noteIndexText(n: Note): string {
  return [n.title, n.text].filter(Boolean).join("\n");
}

export function noteCommentText(c: Note["comments"][number]): string {
  return [c.quote, ...(c.msgs || []).map((m) => m.text)].filter(Boolean).join("\n");
}

export function pageIndexText(p: Page): string {
  return [p.title, p.about, p.last?.summary, extractWidgetText(p.widgets)].filter(Boolean).join("\n");
}

export function taskIndexText(t: Task): string {
  return [t.text, t.note, t.source?.key, t.source?.title].filter(Boolean).join("\n");
}

export function groupIndexText(g: Group): string {
  return [g.name, g.brief].filter(Boolean).join("\n");
}

export function talkIndexText(t: Talk): string {
  return [t.title, talkTitle(t)].filter(Boolean).join("\n");
}

export function scoreHit(rank: number, best: number, at: number, now: number): number {
  const relevance = best < 0 ? Math.max(0, Math.min(1, rank / best)) : 1;
  const days = Math.max(0, now - at) / 86_400_000;
  const recency = 1 / (1 + days / RECENCY_DAYS);
  return relevance * (0.6 + 0.4 * recency);
}

type DirtyKey =
  | { scope: "server"; kind: "note" | "page" | "task" | "group" | "talk"; id: string }
  | { scope: "server"; kind: "group_note"; group: string; id: string }
  | { scope: string; kind: "session"; device: string; local: string }
  | { scope: string; kind: "message"; device: string; localPost: string; localId: string };

interface BackfillJob {
  kind: "server" | "device";
  scope: string;
  deviceId?: string;
  // A machine's threads, then the messages in its memory, then those in its cold store: BATCH_SIZE a step, each step
  // its own tick, so a rebuild never holds the server up for long.
  step: "threads" | "memory" | "cold";
  at: number;
  afterOrd: number;
  threads?: string[];
  memory?: Message[];
  seenInMem?: Set<string>;
  // Messages an op changed after the job started (local ids): the flush indexed them as they are now, and the job,
  // which may hold them as they were (or dropped), leaves them be.
  touched: Set<string>;
}

export function createSearch({ file, relay, state, log = () => {} }: SearchOptions) {
  const storage = new SearchStorage(file);
  const dirty = new Map<string, DirtyKey>();
  const pendingDeletes: { scope: string; kind: SearchKind; parent: string; item: string }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let backfillQueue: BackfillJob[] = [];
  // Scopes an op came from since the last flush, searched or not: the flush moves their cursor up to it, so a server
  // that starts again sees it missed nothing and builds nothing over.
  const heard = new Set<string>();
  let backfillActive = false;
  let started = false;
  let closed = false;

  const deviceScope = (deviceId: string) => `device:${deviceId}`;

  function scheduleFlush() {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_MS);
    flushTimer.unref?.();
  }

  function entriesForServerEntity(kind: "note" | "page" | "task" | "group" | "talk", id: string): { upserts: SearchEntry[]; deleteParent?: string } {
    if (kind === "note") {
      const n = state.notes[id];
      if (!n) return { upserts: [], deleteParent: `note:${id}` };
      const upserts: SearchEntry[] = [
        { scope: "server", kind: "note", parent: `note:${n.id}`, item: "", at: msOf(n.updated || n.created), text: noteIndexText(n) },
        ...(n.comments || []).map((c): SearchEntry => ({
          scope: "server",
          kind: "note",
          parent: `note:${n.id}`,
          item: c.id,
          at: msOf(c.msgs?.at(-1)?.at || c.at || n.updated),
          text: noteCommentText(c),
        })),
      ];
      return { upserts };
    }
    if (kind === "page") {
      const p = state.pages[id];
      if (!p) return { upserts: [], deleteParent: `page:${id}` };
      return {
        upserts: [{ scope: "server", kind: "page", parent: `page:${p.id}`, item: "", at: msOf(p.updated || p.created), text: pageIndexText(p) }],
      };
    }
    if (kind === "task") {
      const t = state.tasks[id];
      if (!t || t.removed) return { upserts: [], deleteParent: `task:${id}` };
      return {
        upserts: [{ scope: "server", kind: "task", parent: `task:${t.id}`, item: "", at: msOf(t.done_at || t.at), text: taskIndexText(t) }],
      };
    }
    if (kind === "group") {
      const g = state.groups[id];
      if (!g) return { upserts: [], deleteParent: `group:${id}` };
      const upserts: SearchEntry[] = [{ scope: "server", kind: "group", parent: `group:${g.id}`, item: "", at: msOf(g.updated || g.created), text: groupIndexText(g) }];
      for (const gn of state.group_notes || []) {
        if (gn.group === g.id && gn.text) {
          upserts.push({ scope: "server", kind: "group", parent: `group:${g.id}`, item: gn.id, at: msOf(gn.at || g.updated), text: gn.text });
        }
      }
      return { upserts };
    }
    const tk = state.talks[id];
    if (!tk) return { upserts: [], deleteParent: `thread:${id}` };
    const upserts: SearchEntry[] = [{ scope: "server", kind: "thread", parent: `thread:${tk.id}`, item: "", at: msOf(tk.updated || tk.at), text: talkIndexText(tk) }];
    for (const m of tk.messages || []) {
      if (!m.text) continue;
      upserts.push({ scope: "server", kind: "msg", parent: `thread:${tk.id}`, item: m.id, at: msOf(m.at || tk.updated), role: 0, text: m.text });
    }
    return { upserts };
  }

  function entryForSession(D: Device, local: string): SearchEntry | null {
    const s = D.store.state.sessions[local];
    if (!s || relay.shadowed(D, local)) return null;
    return {
      scope: deviceScope(D.id),
      kind: "thread",
      parent: `thread:${relay.idOf(D, local)}`,
      item: "",
      localPost: local,
      at: msOf(s.updated || s.started),
      text: threadIndexText(s),
    };
  }

  function entryForMessage(D: Device, m: Message): SearchEntry | null {
    if (!m.text || m.queued || !m.post) return null;
    if (!D.store.state.sessions[m.post] || relay.shadowed(D, m.post)) return null;
    return {
      scope: deviceScope(D.id),
      kind: "msg",
      parent: `thread:${relay.idOf(D, m.post)}`,
      item: relay.idOf(D, m.id),
      localPost: m.post,
      localId: m.id,
      at: msOf(m.at),
      role: m.from === "human" ? 0 : 1,
      text: m.text,
    };
  }

  function flush(): void {
    if (closed) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty.size && !pendingDeletes.length && !heard.size) return;
    const batch = [...dirty.values()];
    const deletes = pendingDeletes.splice(0);
    dirty.clear();
    const upserts: SearchEntry[] = [];
    const dropParents = new Set<string>();
    const touchedScopes = new Set<string>(heard);
    heard.clear();

    for (const d of batch) {
      if (d.kind === "group_note") {
        touchedScopes.add("server");
        const gn = (state.group_notes || []).find((x: GroupNote) => x.id === d.id);
        if (gn?.text) upserts.push({ scope: "server", kind: "group", parent: `group:${gn.group}`, item: gn.id, at: msOf(gn.at), text: gn.text });
        else deletes.push({ scope: "server", kind: "group", parent: `group:${d.group}`, item: d.id });
        continue;
      }
      if (d.kind === "session") {
        const D = relay.devices.get(d.device);
        if (!D) continue;
        touchedScopes.add(d.scope);
        const entry = entryForSession(D, d.local);
        if (entry) upserts.push(entry);
        else dropParents.add(`thread:${relay.idOf(D, d.local)}`);
        continue;
      }
      if (d.kind === "message") {
        const D = relay.devices.get(d.device);
        if (!D) continue;
        touchedScopes.add(d.scope);
        const m = D.store.state.messages.find((x) => x.id === d.localId) || (D.store.state.cold?.row("messages", d.localId) as Message | null);
        const entry = m ? entryForMessage(D, m) : null;
        if (entry) upserts.push(entry);
        else deletes.push({ scope: d.scope, kind: "msg", parent: `thread:${relay.idOf(D, d.localPost)}`, item: relay.idOf(D, d.localId) });
        continue;
      }
      touchedScopes.add("server");
      const res = entriesForServerEntity(d.kind, d.id);
      if (res.deleteParent) dropParents.add(res.deleteParent);
      else upserts.push(...res.upserts);
    }

    for (const parent of dropParents) storage.deleteParent(parent);
    storage.upsertBatch(upserts, deletes);
    for (const scope of touchedScopes) {
      const cur = storage.cursor(scope);
      if (cur?.built) {
        const seq = scope === "server" ? state.seq : (relay.devices.get(scope.slice(7))?.store.state.seq ?? cur.seq);
        storage.setCursor(scope, seq, true);
      }
    }
  }

  function hearServer(op: { t?: string; [k: string]: unknown } | null | undefined): void {
    if (!op?.t || closed) return;
    heard.add("server");
    const t = String(op.t);
    const mark = (kind: "note" | "page" | "task" | "group" | "talk", id: unknown) => {
      if (typeof id !== "string" || !id) return;
      dirty.set(`server:${kind}:${id}`, { scope: "server", kind, id });
      scheduleFlush();
    };
    if (t.startsWith("note.")) mark("note", op.nid ?? op.id);
    else if (t.startsWith("page.") && t !== "page.post" && t !== "page.told") mark("page", op.pid ?? op.id);
    else if (t.startsWith("task.")) mark("task", op.tid ?? op.id);
    else if (t === "group.note" || t === "group.note.remove") {
      const g = typeof op.gid === "string" ? op.gid : "";
      const id = typeof op.nid === "string" ? op.nid : "";
      if (g && id) {
        dirty.set(`server:group_note:${id}`, { scope: "server", kind: "group_note", group: g, id });
        scheduleFlush();
      } else if (g) mark("group", g);
    } else if (t.startsWith("group.") && t !== "group.seen" && t !== "group.news" && t !== "group.post") mark("group", op.gid ?? op.id);
    else if (t.startsWith("talk.")) mark("talk", op.tid ?? op.id);
  }

  function hearDevice(D: Device, op?: { t?: string; [k: string]: unknown } | null): void {
    if (closed || !D) return;
    const scope = deviceScope(D.id);
    if (!op?.t) {
      // A change with no op (its info, a command, its whole state taken): only a machine never indexed, or whose store
      // started over, is indexed whole. Its ops are indexed as they come, so a cursor behind its seq is no reason to:
      // that rebuilt every thread and message at each info push, every few seconds.
      const cur = storage.cursor(scope);
      if (!cur?.built || cur.seq > D.store.state.seq) enqueueDevice(D);
      return;
    }
    heard.add(scope);
    const t = String(op.t);
    if (t === "session.hello") {
      const local = typeof op.session_id === "string" && op.session_id ? op.session_id : typeof op.proc === "string" ? op.proc : "";
      if (local) {
        dirty.set(`${scope}:session:${local}`, { scope, kind: "session", device: D.id, local });
        scheduleFlush();
      }
      return;
    }
    if (t === "session.fold") {
      if (typeof op.post === "string") dirty.set(`${scope}:session:${op.post}`, { scope, kind: "session", device: D.id, local: op.post });
      if (typeof op.copy === "string") dirty.set(`${scope}:session:${op.copy}`, { scope, kind: "session", device: D.id, local: op.copy });
      scheduleFlush();
      return;
    }
    if (t.startsWith("session.")) {
      const local = typeof op.post === "string" ? op.post : typeof op.id === "string" ? op.id : "";
      if (local) {
        dirty.set(`${scope}:session:${local}`, { scope, kind: "session", device: D.id, local });
        scheduleFlush();
      }
      return;
    }
    if (t.startsWith("message.")) {
      const localPost = typeof op.post === "string" ? op.post : "";
      const job = backfillQueue.find((j) => j.scope === scope);
      const message = (localId: string) => {
        dirty.set(`${scope}:message:${localId}`, { scope, kind: "message", device: D.id, localPost, localId });
        job?.touched.add(localId);
      };
      if (t === "message.drop" && localPost && Array.isArray(op.mids)) {
        for (const mid of op.mids) {
          if (typeof mid === "string" && mid) {
            pendingDeletes.push({ scope, kind: "msg", parent: `thread:${relay.idOf(D, localPost)}`, item: relay.idOf(D, mid) });
            job?.touched.add(mid);
          }
        }
        scheduleFlush();
        return;
      }
      if (t === "message.text" && localPost && typeof op.ext === "string") {
        const hit = D.store.state.messages.find((m) => m.post === localPost && m.ext === op.ext);
        if (hit) {
          message(hit.id);
          scheduleFlush();
        }
        return;
      }
      const localId = typeof op.mid === "string" ? op.mid : typeof op.id === "string" ? op.id : typeof op.seq === "number" ? `m${op.seq}` : "";
      if (localPost && localId) {
        message(localId);
        scheduleFlush();
      } else if (localPost) {
        for (const m of D.store.state.messages) if (m.post === localPost) message(m.id);
        scheduleFlush();
      }
    }
  }

  function enqueue(job: BackfillJob) {
    if (backfillQueue.some((j) => j.scope === job.scope)) return;
    // Built again only once the job ends: a server that stops before then starts it over, and the flush doesn't move
    // its cursor up meanwhile.
    const cur = storage.cursor(job.scope);
    if (cur?.built) storage.setCursor(job.scope, cur.seq, false);
    backfillQueue.push(job);
  }

  const deviceJob = (D: Device): BackfillJob => ({ kind: "device", scope: deviceScope(D.id), deviceId: D.id, step: "threads", at: 0, afterOrd: 0, touched: new Set() });

  function enqueueDevice(D: Device) {
    enqueue(deviceJob(D));
    pumpBackfill();
  }

  function stepBackfill(): boolean {
    if (closed || !backfillQueue.length) return false;
    const job = backfillQueue[0];
    if (job.kind === "server") {
      const entries: SearchEntry[] = [];
      for (const id of Object.keys(state.notes || {})) entries.push(...entriesForServerEntity("note", id).upserts);
      for (const id of Object.keys(state.pages || {})) entries.push(...entriesForServerEntity("page", id).upserts);
      for (const id of Object.keys(state.tasks || {})) entries.push(...entriesForServerEntity("task", id).upserts);
      for (const id of Object.keys(state.groups || {})) entries.push(...entriesForServerEntity("group", id).upserts);
      for (const id of Object.keys(state.talks || {})) entries.push(...entriesForServerEntity("talk", id).upserts);
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        storage.upsertBatch(entries.slice(i, i + BATCH_SIZE));
      }
      storage.setCursor("server", state.seq, true);
      backfillQueue.shift();
      return backfillQueue.length > 0;
    }

    const D = job.deviceId ? relay.devices.get(job.deviceId) : undefined;
    if (!D) {
      backfillQueue.shift();
      return backfillQueue.length > 0;
    }

    if (job.step === "threads") {
      job.threads ??= Object.values(D.store.state.sessions)
        .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")))
        .map((s) => s.id);
      const entries: SearchEntry[] = [];
      for (const id of job.threads.slice(job.at, job.at + BATCH_SIZE)) {
        const e = entryForSession(D, id);
        if (e) entries.push(e);
      }
      storage.upsertBatch(entries);
      job.at += BATCH_SIZE;
      if (job.at >= job.threads.length) Object.assign(job, { step: "memory", at: 0, threads: undefined });
      return true;
    }

    if (job.step === "memory") {
      // Index in-memory messages first so recent threads are searchable immediately.
      job.memory ??= D.store.state.messages.slice();
      job.seenInMem ??= new Set();
      const entries: SearchEntry[] = [];
      for (const m of job.memory.slice(job.at, job.at + BATCH_SIZE)) {
        job.seenInMem.add(m.id);
        if (job.touched.has(m.id)) continue;
        const e = entryForMessage(D, m);
        if (e) entries.push(e);
      }
      storage.upsertBatch(entries);
      job.at += BATCH_SIZE;
      if (job.at >= job.memory.length) Object.assign(job, { step: "cold", at: 0, memory: undefined });
      return true;
    }

    const chunk = D.store.state.cold?.messagesChunk(job.afterOrd, BATCH_SIZE) || [];
    if (!chunk.length) {
      storage.setCursor(job.scope, D.store.state.seq, true);
      backfillQueue.shift();
      return backfillQueue.length > 0;
    }
    const entries: SearchEntry[] = [];
    for (const row of chunk) {
      job.afterOrd = row.ord;
      if (job.seenInMem?.has(row.item.id) || job.touched.has(row.item.id)) continue;
      const e = entryForMessage(D, row.item);
      if (e) entries.push(e);
    }
    if (entries.length) storage.upsertBatch(entries);
    if (chunk.length < BATCH_SIZE) {
      storage.setCursor(job.scope, D.store.state.seq, true);
      backfillQueue.shift();
    }
    return backfillQueue.length > 0;
  }

  function pumpBackfill() {
    if (backfillActive || closed || !backfillQueue.length) return;
    backfillActive = true;
    const tick = () => {
      if (closed) {
        backfillActive = false;
        return;
      }
      try {
        if (stepBackfill()) {
          setImmediate(tick);
        } else {
          backfillActive = false;
        }
      } catch (e) {
        backfillActive = false;
        log("search backfill:", (e as Error).message);
      }
    };
    setImmediate(tick);
  }

  function start(): void {
    if (started || closed) return;
    started = true;
    // Drop indexed rows for devices that no longer exist on this server.
    const liveScopes = new Set<string>(["server", ...[...relay.devices.keys()].map(deviceScope)]);
    for (const s of storage.scopes()) {
      if (!liveScopes.has(s)) storage.deleteScope(s);
    }
    // Behind its store here means the last server stopped without flushing (close does, on a clean stop): what it
    // missed isn't known, so all of it is indexed again.
    const srv = storage.cursor("server");
    if (!srv?.built || srv.seq !== state.seq) enqueue({ kind: "server", scope: "server", step: "threads", at: 0, afterOrd: 0, touched: new Set() });
    const devices = [...relay.devices.values()].sort((a, b) => (b.seen || 0) - (a.seen || 0));
    for (const D of devices) {
      const cur = storage.cursor(deviceScope(D.id));
      if (!cur?.built || cur.seq !== D.store.state.seq) enqueue(deviceJob(D));
    }
    if (backfillQueue.length) pumpBackfill();
  }

  // Synchronously drain up to a few small backfill batches when a query arrives before startup finishes.
  function catchUp(maxSteps = 4): void {
    if (!started) start();
    flush();
    for (let i = 0; i < maxSteps && backfillQueue.length; i++) {
      stepBackfill();
    }
  }

  function isIndexing(): boolean {
    return backfillQueue.length > 0;
  }

  function resolveRawText(row: SearchDocRow): string | null {
    if (row.scope === "server") {
      if (row.kind === "note") {
        const n = state.notes[row.parent.slice(5)];
        if (!n) return null;
        if (!row.item) return noteIndexText(n);
        const c = (n.comments || []).find((x) => x.id === row.item);
        return c ? noteCommentText(c) : null;
      }
      if (row.kind === "page") {
        const p = state.pages[row.parent.slice(5)];
        return p ? pageIndexText(p) : null;
      }
      if (row.kind === "task") {
        const t = state.tasks[row.parent.slice(5)];
        return t && !t.removed ? taskIndexText(t) : null;
      }
      if (row.kind === "group") {
        const g = state.groups[row.parent.slice(6)];
        if (!g) return null;
        if (!row.item) return groupIndexText(g);
        const gn = (state.group_notes || []).find((x) => x.id === row.item && x.group === g.id);
        return gn?.text ?? null;
      }
      if (row.kind === "thread" || row.kind === "msg") {
        const tk = state.talks[row.parent.slice(7)];
        if (!tk) return null;
        if (row.kind === "thread") return talkIndexText(tk);
        return (tk.messages || []).find((m) => m.id === row.item)?.text ?? null;
      }
      return null;
    }
    const deviceId = row.scope.slice(7);
    const D = relay.devices.get(deviceId);
    if (!D || !row.local_post) return null;
    if (row.kind === "thread") {
      const s = D.store.state.sessions[row.local_post];
      return s ? threadIndexText(s) : null;
    }
    if (row.kind === "msg" && row.local_id) {
      const m = D.store.state.messages.find((x) => x.id === row.local_id) || (D.store.state.cold?.row("messages", row.local_id) as Message | null);
      return m && !m.queued ? m.text : null;
    }
    return null;
  }

  function queryDocs(
    q: string,
    {
      kinds,
      limit = 15,
      allow,
      archived,
    }: {
      kinds?: SearchKind[];
      limit?: number;
      allow: (row: SearchDocRow) => boolean;
      archived?: (row: SearchDocRow) => boolean;
    },
  ): { fts: string; indexing: boolean; hits: SearchCandidate[] } {
    const fts = ftsQuery(q);
    if (!fts) return { fts: "", indexing: isIndexing(), hits: [] };
    catchUp();

    const run = (candLimit: number) => {
      const rows = storage.query(fts, { kinds, limit: candLimit });
      const visible = rows.filter(allow);
      return { total: rows.length, visible };
    };

    let { total, visible } = run(CANDIDATES);
    const uniqueVisible = () => new Set(visible.map((r) => r.parent)).size;
    if (total >= CANDIDATES && uniqueVisible() < limit) {
      visible = run(CANDIDATES_WIDE).visible;
    }

    const best = visible.reduce((min, r) => Math.min(min, r.rank), 0);
    const now = Date.now();
    const byParent = new Map<string, SearchCandidate>();
    for (const r of visible) {
      let s = scoreHit(r.rank, best, r.at, now);
      if (r.kind === "thread") s *= 1.15;
      if (archived?.(r)) s *= 0.85;
      const prev = byParent.get(r.parent);
      if (!prev) {
        byParent.set(r.parent, { ...r, score: s });
      } else if (prev.kind === "thread" && r.kind === "msg") {
        // Prefer a concrete message hit (with ?msg= deep-link) while keeping the higher combined score.
        byParent.set(r.parent, { ...r, score: Math.max(prev.score, s) });
      } else if (prev.kind === "msg" && r.kind === "thread") {
        byParent.set(r.parent, { ...prev, score: Math.max(prev.score, s) });
      } else if (s > prev.score || (s === prev.score && r.at > prev.at)) {
        byParent.set(r.parent, { ...r, score: s });
      }
    }

    const hits = [...byParent.values()]
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, limit);
    return { fts, indexing: isIndexing(), hits };
  }

  function snippetFor(row: SearchDocRow, fts: string): string {
    const raw = resolveRawText(row);
    if (!raw) return "";
    const s = storage.snippet(raw, fts);
    return plainSnippet(s || raw.slice(0, 220));
  }

  // Intersect parent thread ids across all query words (matching words spread across messages or title).
  // Returns null if the index is still backfilling or a word cannot be expressed in FTS5.
  function threadCandidates(words: string[]): Set<string> | null {
    catchUp();
    if (isIndexing()) return null;
    let out: Set<string> | null = null;
    for (const w of words) {
      const term = ftsTerm(w);
      if (!term) return null;
      const parents = storage.parentsForTerm(term, ["thread", "msg"]);
      // A word found nowhere as typed may have a typo, which only the search over the threads themselves matches.
      if (!parents.size && typoBudget(w) > 0) return null;
      if (out === null) {
        out = parents;
      } else {
        for (const p of out) if (!parents.has(p)) out.delete(p);
      }
      if (!out.size) return out;
    }
    return out;
  }

  function messageDocsForWord(word: string): SearchDocRow[] | null {
    catchUp();
    if (isIndexing()) return null;
    const term = ftsTerm(word);
    if (!term) return null;
    return storage.docsForTerm(term, ["msg"]);
  }

  function dropDevice(deviceId: string): void {
    storage.deleteScope(deviceScope(deviceId));
  }

  function rebuildServerScope(): void {
    storage.deleteScope("server");
    backfillQueue.unshift({ kind: "server", scope: "server", step: "threads", at: 0, afterOrd: 0, touched: new Set() });
    pumpBackfill();
  }

  function close(): void {
    if (closed) return;
    // Indexes what came in since the last flush and moves the cursors up to it, so the next start builds nothing over.
    try {
      flush();
    } catch (e) {
      log("search flush on close:", (e as Error).message);
    }
    closed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    storage.close();
  }

  return {
    start,
    flush,
    catchUp,
    isIndexing,
    hearServer,
    hearDevice,
    queryDocs,
    snippetFor,
    resolveRawText,
    threadCandidates,
    messageDocsForWord,
    dropDevice,
    rebuildServerScope,
    close,
  };
}

export type SearchService = ReturnType<typeof createSearch>;
