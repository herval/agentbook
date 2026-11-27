// What a stand-in OpenClaw gateway answers, for tests: agents, sessions with their messages, pending approvals
// and questions, kept in <dir>/state.json (which tests edit to make things happen). Each call is logged to
// <dir>/calls.jsonl. A session it creates, or one you write to, answers at once: a command it ran, and a reply.
// Used by fake-openclaw.ts (the `openclaw` command) and fake-openclaw-gateway.ts (the gateway itself).

import fs from "node:fs";
import path from "node:path";

// A piece of a message: text, a tool call, or a picture, sound, video or file (data in base64, or an artifact).
export interface Part {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
  fileName?: string;
  alt?: string;
  artifactId?: string;
  attachment?: { artifactId?: string; label?: string; mimeType?: string; kind?: string; sizeBytes?: number };
  [field: string]: unknown;
}
export interface OcMessage {
  role: string;
  content: string | Part[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // Where it came from (`transport`), and its place in the transcript.
  __openclaw?: { id?: string; seq?: number; idempotencyKey?: string; transport?: { channel?: string; [field: string]: unknown } };
  [field: string]: unknown;
}
export interface OcSession {
  key: string;
  sessionId?: string;
  agentId?: string;
  createdAt?: number;
  updatedAt?: number;
  hasActiveRun?: boolean;
  // How long reading its history takes (ms).
  slowMs?: number;
  messages: OcMessage[];
  [field: string]: unknown;
}
export interface OcAgent {
  id: string;
  workspace?: string;
  identity?: { name?: string; avatar?: string; emoji?: string };
  // Its workspace's IDENTITY.md.
  identityFile?: { name?: string; avatar?: string; emoji?: string };
  // AGENTS.md, SOUL.md, ... by name.
  coreFiles?: Record<string, string>;
  [field: string]: unknown;
}
export interface CronJob {
  id: string;
  agentId?: string;
  enabled?: boolean;
  payload: { kind?: string; message?: string; text?: string };
  state?: Record<string, unknown>;
  [field: string]: unknown;
}
export interface CronRun {
  ts: number;
  jobId: string;
  [field: string]: unknown;
}
// A file in a workspace: text, a picture ({ base64 }, `big` for one over 256 KB), or one with no preview ({ size },
// `text` for text too big to show).
export type OcFile = string | { base64?: string; big?: boolean; size?: number; text?: boolean };
// <dir>/state.json.
export interface OcState {
  agents: OcAgent[];
  sessions: OcSession[];
  presence?: unknown[];
  // By agent.
  skills?: Record<string, object[]>;
  // An agent's artifacts' bytes, by artifact id.
  media?: Record<string, string>;
  unreachable?: string;
  // The sessions.create fields it doesn't know.
  unknownCreate?: string[];
  // Commands waiting to be allowed (exec.approval), and its tools (plugin.approval: Read, Skill… on a Claude CLI
  // backend). One with `runtime: true` was asked for by OpenClaw's own runtime, which only a connection with admin sees
  // (fake-openclaw-gateway.ts).
  approvals?: { id: string; [field: string]: unknown }[];
  toolApprovals?: { id: string; [field: string]: unknown }[];
  questions?: { id: string; [field: string]: unknown }[];
  commands?: { name: string; description?: string }[];
  usage?: unknown[];
  cron?: { jobs: CronJob[]; runs: CronRun[] };
  // By path in the workspace.
  files?: Record<string, OcFile>;
  fileTimes?: Record<string, number>;
  listSlowMs?: Record<string, number>;
}
// A file sent with a message.
export interface Attachment {
  fileName?: string;
  mimeType?: string;
  // base64.
  content?: string;
}
// A call's params, the ones these methods take.
export interface Params {
  agentId?: string;
  offset?: number;
  limit?: number;
  sessionKey?: string;
  cursor?: string;
  artifactId?: string;
  key?: string;
  message?: string;
  displayName?: string;
  attachments?: Attachment[];
  id?: string;
  jobId?: string;
  includeDisabled?: boolean;
  sortDir?: "asc" | "desc";
  patch?: Partial<CronJob>;
  path?: string;
  name?: string;
}

export function answer(dir: string, method: string, params: Params = {}) {
  const file = path.join(dir, "state.json");
  const s: OcState = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => {
    fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(s, null, 1));
    fs.renameSync(`${file}.${process.pid}`, file); // whole, for a call reading it at the same time
  };
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ method, params }) + "\n");
  const now = Date.now();
  const find = (key: string) => {
    const x = s.sessions.find((y) => y.key === key);
    if (!x) throw new Error(`no session ${key}`);
    return x;
  };
  const answerTo = (text: string): OcMessage[] => [
    { role: "assistant", content: [{ type: "toolCall", id: `t${now}`, name: "exec", arguments: { command: "ls drafts" } }], timestamp: now },
    { role: "toolResult", toolCallId: `t${now}`, toolName: "exec", content: [{ type: "text", text: "draft.md" }], isError: false, timestamp: now },
    { role: "assistant", content: [{ type: "text", text: `Got it: ${text}` }], timestamp: now },
  ];
  const row = ({ messages, ...rest }: OcSession) => rest;
  // What you sent, as OpenClaw keeps it: the pictures attached to it as pieces of it, and where it saved the
  // other files after what you wrote.
  const yours = (message: string, attachments: Attachment[] = []): OcMessage => {
    const files = attachments.filter((a) => !a.mimeType?.startsWith("image/"));
    const text = [message, ...files.map((a) => `[media attached: /home/me/.openclaw/media/inbound/${a.fileName}]`)].filter(Boolean).join("\n");
    const pictures = attachments.filter((a) => a.mimeType?.startsWith("image/")).map((a) => ({ type: "image", data: a.content, mimeType: a.mimeType }));
    return { role: "user", content: pictures.length ? [{ type: "text", text }, ...pictures] : text, timestamp: now };
  };
  // A message's pictures, sound, video and files, as OpenClaw's artifacts: one the agent made has an
  // artifactId and is handed over as a link on the gateway (served from `media`, by its id); one you sent is
  // in the message itself (`data`), listed by its message's place in the transcript and handed over in base64.
  // The history leaves their bytes out.
  const MEDIA = new Set(["image", "audio", "video", "attachment"]);
  const artifactsOf = (x: OcSession) =>
    x.messages.flatMap((m, i) =>
      (Array.isArray(m.content) ? m.content : [])
        .filter((c) => MEDIA.has(c.type))
        .map((c, n) => ({ c, id: c.artifactId || c.attachment?.artifactId || `artifact_${i + 1}_${n}`, type: c.type === "attachment" ? "file" : c.type, title: c.fileName || c.attachment?.label || c.alt || `${c.type} ${n + 1}`, messageSeq: i + 1 })),
    );
  const summary = ({ c, ...a }: ReturnType<typeof artifactsOf>[number]) => ({ ...a, mimeType: c.mimeType || c.attachment?.mimeType, download: { mode: c.data ? "bytes" : "url" } });
  const shown = (m: OcMessage) => (Array.isArray(m.content) ? { ...m, content: m.content.map(({ data, ...c }) => (data ? { ...c, omitted: true, bytes: Buffer.from(data, "base64").length } : c)) } : m);

  switch (method) {
    // An agent's `identity` is its config's; `identityFile` is its workspace's IDENTITY.md, which only
    // agent.identity.get reads. A picture in a workspace comes back as a data: URL.
    case "agents.list":
      return { defaultId: "main", agents: s.agents.map(({ identityFile, coreFiles, ...a }) => a) };
    case "agent.identity.get": {
      const a = s.agents.find((x) => x.id === (params.agentId || "main"));
      const id = { ...a?.identityFile, ...a?.identity };
      return { agentId: a?.id || "main", name: id.name || "Assistant", avatar: id.avatar || id.emoji || "A", emoji: id.emoji };
    }
    case "sessions.list": {
      // A page at a time, as the gateway lists them.
      const offset = Number(params.offset) || 0;
      const page = s.sessions.slice(offset, offset + (Number(params.limit) || s.sessions.length)).map(row);
      return { sessions: page, count: page.length, hasMore: offset + page.length < s.sessions.length, nextOffset: offset + page.length };
    }
    case "system-presence":
      return s.presence || [];
    // The skills an agent has (`skills`, by agent), and whether it can use each, as OpenClaw lists them.
    case "skills.status": {
      const a = s.agents.find((x) => x.id === (params.agentId || "main"));
      if (!a) throw new Error(`unknown agent id "${params.agentId}"`);
      return { workspaceDir: a.workspace, managedSkillsDir: "/Users/me/.openclaw/skills", agentId: a.id, skills: (s.skills?.[a.id] || []).map((k) => ({ source: "openclaw-bundled", bundled: false, eligible: true, disabled: false, blockedByAgentFilter: false, ...k })) };
    }
    case "sessions.subscribe":
      return { subscribed: true };
    case "chat.history": {
      // A cron run's session OpenClaw has let go of (it does, once the run is over and idle): no history,
      // and no error either.
      if (/:cron:[^:]+:run:/.test(params.sessionKey) && !s.sessions.some((y) => y.key === params.sessionKey)) return { messages: [] as OcMessage[] };
      const x = find(params.sessionKey);
      // A session whose history takes a while to read (`slowMs`), to see its post syncing meanwhile.
      if (x.slowMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, x.slowMs);
      // As the gateway pages it: what's new since a cursor (or a reset, when that's more than a page), or else
      // the latest `limit` entries, `offset` back from the newest, saying whether there are older ones.
      const all = x.messages.map((m, i) => ({ ...shown(m), id: m.__openclaw?.id || `${x.sessionId || x.key}#${i}`, __openclaw: { ...m.__openclaw, seq: i + 1 } }));
      const limit = Number(params.limit) || 200;
      const tail = { deltaCursor: `c${all.length}:${x.sessionId}`, sessionInfo: { hasActiveRun: !!x.hasActiveRun } };
      if (params.cursor) {
        const [at, sessionId] = String(params.cursor).slice(1).split(":");
        const from = Number(at);
        // Another session under this key (a cron job's next run) has none of what was read.
        if (sessionId !== String(x.sessionId) || from > all.length || all.length - from > limit) return { kind: "reset" };
        return { kind: "delta", messages: all.slice(from), ...tail };
      }
      const end = all.length - (Number(params.offset) || 0);
      const start = Math.max(0, end - limit);
      return { messages: all.slice(start, end), ...(start > 0 ? { hasMore: true, nextOffset: all.length - start } : { hasMore: false }), ...tail };
    }
    case "artifacts.list":
      return { artifacts: artifactsOf(find(params.sessionKey)).map(summary) };
    case "artifacts.download": {
      const a = artifactsOf(find(params.sessionKey)).find((y) => y.id === params.artifactId);
      if (!a || (!a.c.data && !s.media?.[a.id])) throw Object.assign(new Error("artifact not found"), { details: { type: "artifact_not_found", artifactId: params.artifactId } });
      if (a.c.data) return { artifact: summary(a), encoding: "base64", data: a.c.data };
      return { artifact: summary(a), url: `/api/chat/media/outgoing/${encodeURIComponent(params.sessionKey)}/${a.id}/full?mediaTicket=t-${a.id}`, expiresAt: now + 60e3 };
    }
    case "sessions.create": {
      // A gateway from before it took a field (`unknownCreate`) turns a create with it away, as its closed schema does.
      const unknown = (s.unknownCreate || []).find((k) => k in params);
      if (unknown) throw new Error(`invalid sessions.create params: at root: unexpected property '${unknown}'`);
      const key = `agent:${params.agentId}:${params.key}`;
      s.sessions.push({ key, sessionId: `sid-${now}`, agentId: params.agentId, createdAt: now, updatedAt: now, hasActiveRun: false, ...(params.displayName ? { displayName: params.displayName } : {}), messages: [yours(params.message, params.attachments), ...answerTo(params.message)] });
      save();
      return { ok: true, key, sessionId: `sid-${now}`, runStarted: true, runId: `run-${now}` };
    }
    case "chat.send": {
      // `unreachable`: what a gateway that doesn't answer says, for a message that can't be delivered.
      if (s.unreachable) throw new Error(s.unreachable);
      const x = find(params.sessionKey);
      x.messages.push(yours(params.message, params.attachments), ...answerTo(params.message));
      x.updatedAt = now;
      save();
      return { status: "started", runId: `run-${now}` };
    }
    case "sessions.abort":
      find(params.key).hasActiveRun = false;
      save();
      return { ok: true, aborted: true };
    case "exec.approval.list":
      return s.approvals || [];
    case "exec.approval.resolve":
      s.approvals = (s.approvals || []).filter((a) => a.id !== params.id);
      save();
      return { ok: true };
    case "plugin.approval.list":
      return s.toolApprovals || [];
    case "plugin.approval.resolve":
      s.toolApprovals = (s.toolApprovals || []).filter((a) => a.id !== params.id);
      save();
      return { ok: true };
    case "question.list":
      return { questions: s.questions || [] };
    case "question.resolve":
      s.questions = (s.questions || []).filter((q) => q.id !== params.id);
      save();
      return { ok: true };
    // The providers' usage limits its sign-ins have (`usage` in its state, else none): what `/usage` shows.
    // Its slash commands: <dir>/state.json's `commands`, or a few of OpenClaw's own.
    case "commands.list":
      return { commands: s.commands || [{ name: "new", description: "Start a new session" }, { name: "reset", description: "Reset the session" }, { name: "compact", description: "Compact the session" }, { name: "restart", description: "Restart the gateway" }] };
    case "usage.status":
      return { updatedAt: Date.now(), providers: s.usage || [] };
    // Routines: `cron.jobs`, and `cron.runs`, each run a session of its own (in `sessions`) that cron.run makes.
    case "cron.list": {
      const jobs = (s.cron?.jobs || []).filter((j) => (params.includeDisabled || j.enabled !== false) && (!params.agentId || (j.agentId || "main") === params.agentId));
      const offset = Number(params.offset) || 0;
      const page = jobs.slice(offset, offset + (Number(params.limit) || 50));
      const more = offset + page.length < jobs.length;
      return { jobs: page, total: jobs.length, offset, limit: page.length, hasMore: more, nextOffset: more ? offset + page.length : null };
    }
    case "cron.runs": {
      const id = params.id || params.jobId;
      const ofAgent = new Set((s.cron?.jobs || []).filter((j) => !params.agentId || (j.agentId || "main") === params.agentId).map((j) => j.id));
      const runs = (s.cron?.runs || []).filter((r) => (id ? r.jobId === id : ofAgent.has(r.jobId))).sort((a, b) => (params.sortDir === "asc" ? a.ts - b.ts : b.ts - a.ts));
      const offset = Number(params.offset) || 0;
      const page = runs.slice(offset, offset + (Number(params.limit) || 50));
      const more = offset + page.length < runs.length;
      return { entries: page, total: runs.length, offset, limit: page.length, hasMore: more, nextOffset: more ? offset + page.length : null };
    }
    case "cron.run": {
      const j = (s.cron?.jobs || []).find((x) => x.id === params.id);
      if (!j) throw new Error(`unknown cron job id: ${params.id}`);
      const agent = j.agentId || "main";
      const key = `agent:${agent}:cron:${j.id}:run:r${now}`;
      s.sessions.push({ key, sessionId: `r${now}`, agentId: agent, createdAt: now, updatedAt: now, messages: [{ role: "user", content: j.payload.message, timestamp: now }, ...answerTo(j.payload.message)] });
      s.cron.runs.push({ ts: now + 1200, jobId: j.id, action: "finished", status: "ok", summary: `Got it: ${j.payload.message}`, sessionKey: key, sessionId: `r${now}`, runId: `r${now}`, runAtMs: now, durationMs: 1200 });
      j.state = { ...j.state, lastRunAtMs: now, lastRunStatus: "ok", lastDurationMs: 1200, consecutiveErrors: 0 };
      save();
      return { ok: true, ran: true, runId: `r${now}` };
    }
    case "cron.update": {
      const j = (s.cron?.jobs || []).find((x) => x.id === params.id);
      if (!j) throw new Error(`unknown cron job id: ${params.id}`);
      Object.assign(j, params.patch, { updatedAtMs: now });
      save();
      return j;
    }
    // A session's workspace is its agent's, holding `files` (by their path in it): text, a picture ({ base64 }, and
    // `big` for one over the 256 KB sessions.files.get hands over, which agents.workspace.get does),
    // or a file OpenClaw shows no preview of ({ size }, or { size, text: true } for text too big to show), each
    // changed at its `fileTimes` (or a minute ago). Like OpenClaw, it reads only inside the workspace, and lists
    // a folder by its path from the root, each of its files with its size, taking `listSlowMs[path]` to.
    case "sessions.files.get":
    case "sessions.files.list": {
      const root = s.agents.find((a) => a.id === find(params.sessionKey).agentId)?.workspace;
      const files = s.files || {};
      const res = (more: object) => ({ sessionKey: params.sessionKey, root, ...more });
      if (method === "sessions.files.list") {
        const dir = (params.path || "").split("/").filter(Boolean).join("/");
        if (s.listSlowMs?.[dir]) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.listSlowMs[dir]);
        const under = Object.keys(files).filter((f) => !dir || f.startsWith(`${dir}/`)).map((f) => f.slice(dir ? dir.length + 1 : 0));
        if (dir && !under.length) return res({ files: [] });
        const sizeOf = (f: OcFile) => (typeof f === "string" ? Buffer.byteLength(f) : f.base64 ? Buffer.from(f.base64, "base64").length : f.size);
        const entries = [...new Set(under.map((f) => f.split("/")[0]))].map((n) => {
          const p = dir ? `${dir}/${n}` : n;
          return under.includes(n) ? { path: p, name: n, kind: "file", size: sizeOf(files[p]), updatedAtMs: s.fileTimes?.[p] ?? now - 60e3 } : { path: p, name: n, kind: "directory", updatedAtMs: now - 60e3 };
        });
        return res({ files: [], browser: { path: dir, entries } });
      }
      const rel = path.posix.relative(root, path.posix.resolve(root, params.path));
      const f = files[rel];
      if (f === undefined || rel.startsWith("..")) throw Object.assign(new Error("session file not found"), { details: { type: "session_file_not_found", path: params.path } });
      const file = { path: params.path, workspacePath: rel, name: path.posix.basename(rel), kind: "read", missing: false, updatedAtMs: s.fileTimes?.[rel] ?? now - 60e3 };
      if (typeof f === "string") return res({ file: { ...file, size: Buffer.byteLength(f), mimeType: "text/plain", contentEncoding: "utf8", previewKind: "text", content: f } });
      if (f.base64 && f.big) return res({ file: { ...file, size: 300_000, mimeType: "image/png", previewKind: "unsupported" } });
      if (f.base64) return res({ file: { ...file, size: Buffer.from(f.base64, "base64").length, mimeType: "image/png", contentEncoding: "base64", previewKind: "image", content: f.base64 } });
      if (f.text) throw Object.assign(new Error("session file is too large to preview"), { details: { type: "session_file_too_large", maxPreviewBytes: 262144, path: params.path, size: f.size } });
      return res({ file: { ...file, size: f.size, previewKind: "unsupported" } });
    }
    // A picture in an agent's workspace, by its path in it, up to 5 MB.
    case "agents.workspace.get": {
      const a = s.agents.find((x) => x.id === params.agentId);
      if (!a) throw new Error(`agent "${params.agentId}" not found`);
      const f = (s.files || {})[params.path];
      if (typeof f === "string" || !f?.base64) throw Object.assign(new Error("workspace file not found"), { details: { type: "workspace_file_not_found", path: params.path } });
      return { agentId: a.id, file: { path: params.path, name: path.posix.basename(params.path), size: 300_000, updatedAtMs: now - 60e3, mimeType: "image/png", encoding: "base64", content: f.base64 } };
    }
    // The files OpenClaw makes an agent of (its `coreFiles`), whether or not it has a session.
    case "agents.files.list":
    case "agents.files.get": {
      const a = s.agents.find((x) => x.id === params.agentId);
      if (!a) throw new Error(`unknown agent id "${params.agentId}"`);
      const one = (name: string) => (a.coreFiles?.[name] == null ? { name, path: `${a.workspace}/${name}`, missing: true } : { name, path: `${a.workspace}/${name}`, missing: false, size: Buffer.byteLength(a.coreFiles[name]), updatedAtMs: now - 3600e3 });
      if (method === "agents.files.list") return { agentId: a.id, workspace: a.workspace, files: ["AGENTS.md", "SOUL.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"].map(one) };
      if (!["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"].includes(params.name)) throw new Error(`unsupported file "${params.name}"`);
      const f = one(params.name);
      return { agentId: a.id, workspace: a.workspace, file: f.missing ? f : { ...f, content: a.coreFiles[params.name] } };
    }
    default:
      throw new Error(`unknown method ${method}`);
  }
}
