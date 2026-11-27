#!/usr/bin/env node
// A stand-in for Codex's app-server daemon in tests and the demo: a WebSocket server on a unix socket that
// speaks enough of its JSON-RPC to list, start, follow and steer threads, and to ask for approvals.
// Usage: node fake-codex.ts <socket> <log.jsonl> <project folder>
//
// A turn's text picks what happens: "approve" asks to run a command, "ask" asks a question, "slow" keeps
// working until interrupted, "linger" works a couple of seconds. Every request it receives is logged.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { Json } from "./harness-types.ts";

// A turn of a thread: its items as Codex has them (userMessage, commandExecution, agentMessage, ...).
interface Turn {
  id: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  items: object[];
}
interface Goal {
  threadId: string;
  objective: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  timeUsedSeconds: number;
  tokensUsed: number;
  tokenBudget: number | null;
}
// A thread, as Codex's app-server has it.
interface CodexThread {
  id: string;
  sessionId: string;
  cwd: string;
  name: string | null;
  preview: string;
  // "cli", "vscode", "appServer", or a subagent's ({ subAgent: ... }).
  source: string | object;
  status: { type: string; activeFlags?: string[] };
  createdAt: number;
  updatedAt: number;
  model: string;
  modelProvider: string;
  cliVersion: string;
  ephemeral: boolean;
  gitInfo: object | null;
  turns: Turn[];
  goal?: Goal | null;
  forkedFromId?: string;
}
// A request's params, the ones these methods take.
interface Params {
  threadId?: string;
  includeTurns?: boolean;
  cwd?: string;
  cwds?: string[];
  model?: string;
  input?: { type: string; text?: string }[];
  clientUserMessageId?: string;
  expectedTurnId?: string;
  target?: { type?: string; instructions?: string; branch?: string; sha?: string };
  objective?: string;
  status?: string;
  name?: string;
  keyPath?: string;
  mergeStrategy?: string;
  // What config/value/write writes: any value config.toml can hold.
  value?: Json;
  includeLayers?: boolean;
}
// A JSON-RPC message from a client: a request, or its answer to one of ours.
interface RpcMessage {
  id?: number;
  method?: string;
  params?: Params;
  result?: unknown;
}
// How the client answered an approval or a question.
interface Answer {
  decision?: string;
  answers?: Record<string, { answers?: string[] }>;
}
interface Client {
  frame(text: string): void;
}

const [, , SOCK, LOG, PROJECT] = process.argv;
fs.rmSync(SOCK, { force: true });
const log = (entry: object) => LOG && fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const thread = (id: string, extra: Partial<CodexThread> = {}): CodexThread => ({ id, sessionId: id, cwd: PROJECT, name: null, preview: "", source: "cli", status: { type: "notLoaded" }, createdAt: now() - 7200, updatedAt: now() - 3600, model: "gpt-6-astra", modelProvider: "openai", cliVersion: "0.160.0", ephemeral: false, gitInfo: null, turns: [], ...extra });
const threads = new Map<string, CodexThread>([
  ["th-old", thread("th-old", { name: "Speed up the importer", turns: [{ id: "tu-1", status: "completed", startedAt: now() - 7000, completedAt: now() - 6900, durationMs: 100000, items: [
    { type: "userMessage", id: "i1", content: [{ type: "text", text: "Make the importer faster" }], clientId: null },
    { type: "commandExecution", id: "i2", command: "/bin/zsh -lc 'npm test'", commandActions: [], cwd: PROJECT, status: "failed", exitCode: 1, aggregatedOutput: "2 failing" },
    { type: "fileChange", id: "i3", changes: [{ path: `${PROJECT}/importer.js`, kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n import { read } from \"./csv.js\";\n-export const rows = (f) => read(f);\n+export const rows = (f) => read(f, { header: true });\n \n" }], status: "completed" },
    // Web searches as Codex 0.166 gives them: only a search has a query; a page it opened has its URL there, and
    // pages it read from what it found ("other") have "".
    { type: "webSearch", id: "w1", query: "csv parser streaming node ...", action: { type: "search", query: null, queries: ["csv parser streaming node", "papaparse vs csv-parse speed"] }, results: [] },
    { type: "webSearch", id: "w2", query: "https://csv.js.org/parse/", action: { type: "openPage", url: "https://csv.js.org/parse/" }, results: [] },
    { type: "webSearch", id: "w3", query: "", action: { type: "other" }, results: [{ type: "text_result", url: "https://csv.js.org/parse/options/" }, { type: "text_result", url: "https://csv.js.org/parse/api/" }] },
    { type: "webSearch", id: "w4", query: "'columns' in https://csv.js.org/parse/options/", action: { type: "findInPage", url: "https://csv.js.org/parse/options/", pattern: "columns" }, results: [] },
    // Agents it spawned, and how its wait for them left them.
    { type: "collabAgentToolCall", id: "i5", tool: "spawnAgent", status: "completed", senderThreadId: "th-old", receiverThreadIds: ["th-agent-1"], prompt: "Profile the CSV parser\nand say where the time goes", agentsStates: { "th-agent-1": { status: "pendingInit" } } },
    { type: "collabAgentToolCall", id: "i6", tool: "spawnAgent", status: "completed", senderThreadId: "th-old", receiverThreadIds: ["th-agent-2"], prompt: "Benchmark the inserts", agentsStates: { "th-agent-2": { status: "running" } } },
    { type: "collabAgentToolCall", id: "i7", tool: "wait", status: "completed", senderThreadId: "th-old", receiverThreadIds: ["th-agent-1", "th-agent-2"], agentsStates: { "th-agent-1": { status: "completed" }, "th-agent-2": { status: "errored", message: "The sandbox denied network access" } } },
    { type: "agentMessage", id: "i4", text: "Batched the inserts; 3x faster." },
  ] }] })],
  ["th-live", thread("th-live", { name: "Fix the login bug", source: "vscode", status: { type: "idle" }, updatedAt: now() - 30 })],
  ["th-sub", thread("th-sub", { source: { subAgent: "review" }, status: { type: "idle" } })],
  // An agent th-old spawned, a thread of its own: its steps, when you open its worker.
  ["th-agent-1", thread("th-agent-1", { source: { subAgent: { thread_spawn: { parent_thread_id: "th-old", agent_nickname: "profiler" } } }, turns: [{ id: "tu-a1", status: "completed", startedAt: now() - 6950, completedAt: now() - 6920, durationMs: 30000, items: [
    { type: "userMessage", id: "a1", content: [{ type: "text", text: "Profile the CSV parser and say where the time goes" }] },
    { type: "commandExecution", id: "a2", command: "/bin/zsh -lc 'node --cpu-prof importer.js'", commandActions: [], cwd: PROJECT, status: "completed", exitCode: 0, aggregatedOutput: "wrote CPU.cpuprofile" },
    { type: "agentMessage", id: "a3", text: "80% of the time is in the row inserts, one at a time." },
  ] }] })],
  ["th-quiet", thread("th-quiet", { name: "Say hi", status: { type: "idle" }, updatedAt: now() - 7200 })],
]);
// Threads a test adds: FAKE_CODEX_THREADS names a JSON file of them (each like the ones above).
if (process.env.FAKE_CODEX_THREADS) for (const t of JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_THREADS, "utf8")) as CodexThread[]) threads.set(t.id, thread(t.id, { createdAt: now() - 600, updatedAt: now() - 60, ...t }));
let made = 0;
const config: Record<string, Json> = {}; // what config/value/write wrote

const clients = new Set<Client>();
const send = (c: Client, msg: object) => c.frame(JSON.stringify(msg));
const broadcast = (method: string, params: object) => {
  for (const c of clients) send(c, { method, params });
};
const plain = (t: CodexThread) => ({ ...t, turns: [] as Turn[] });

// Requests Codex sends the client (approvals, questions), waiting for its answer.
let reqId = 1000;
const asked = new Map<number, (result: unknown) => void>();
function ask(method: string, params: object) {
  const id = reqId++;
  return new Promise<Answer | null>((resolve) => {
    asked.set(id, resolve);
    for (const c of clients) send(c, { id, method, params });
  });
}

// Its plan's limits moved (as after a turn): SIGUSR2 says so to everyone connected.
process.on("SIGUSR2", () => broadcast("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: null, secondary: null, credits: null, planType: null } }));

const turns = new Map<string, { id: string; interrupt: () => void }>(); // thread id -> { id, interrupt }
async function runTurn(t: CodexThread, turnId: string, text: string, clientId: string | null) {
  const started = Date.now();
  const setStatus = (status: CodexThread["status"]) => {
    t.status = status;
    broadcast("thread/status/changed", { threadId: t.id, status });
  };
  setStatus({ type: "active", activeFlags: [] });
  broadcast("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  // A review or a compaction has no message of yours.
  if (!/^(review|compact):/.test(text)) broadcast("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: { type: "userMessage", id: `u-${turnId}`, content: [{ type: "text", text }], clientId } });
  broadcast("turn/plan/updated", { threadId: t.id, turnId, plan: [{ step: "Look around", status: "completed" }, { step: "Do it", status: "inProgress" }] });
  let say = `Done: ${text}`;
  let status = "completed";
  if (/approve/.test(text)) {
    const item = { type: "commandExecution", id: `c-${turnId}`, command: "/bin/zsh -lc 'make deploy'", commandActions: [{ type: "unknown", command: "make deploy" }], cwd: t.cwd, status: "inProgress", exitCode: null };
    broadcast("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item });
    setStatus({ type: "active", activeFlags: ["waitingOnApproval"] });
    const r = await ask("item/commandExecution/requestApproval", { threadId: t.id, turnId, itemId: item.id, command: item.command, cwd: t.cwd, reason: "Deploy needs the network", startedAtMs: Date.now() });
    log({ answer: "approval", result: r });
    setStatus({ type: "active", activeFlags: [] });
    const ok = r?.decision === "accept";
    broadcast("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { ...item, status: ok ? "completed" : "declined", exitCode: ok ? 0 : null } });
    say = ok ? "Deployed." : "Skipped the deploy.";
  }
  if (/ask/.test(text)) {
    const r = await ask("item/tool/requestUserInput", { threadId: t.id, turnId, itemId: `q-${turnId}`, isBlocking: true, questions: [{ id: "color", header: "Theme", question: "Which color?", options: [{ label: "Blue", description: "calm" }, { label: "Red", description: "loud" }] }] });
    log({ answer: "input", result: r });
    say = `You picked ${r?.answers?.color?.answers?.[0] || "nothing"}`;
  }
  // "linger": a turn that takes a couple of seconds, then ends by itself.
  if (/linger/.test(text)) await sleep(2500);
  if (/slow/.test(text)) {
    await new Promise<void>((resolve) => turns.set(t.id, { id: turnId, interrupt: resolve }));
    status = "interrupted";
    say = null;
  }
  turns.delete(t.id);
  // A review (review/start): Codex enters review mode, looks, and its findings end the turn.
  if (/^review:/.test(text)) {
    broadcast("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: { type: "enteredReviewMode", id: `rv-${turnId}`, review: text.slice(7) } });
    broadcast("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { type: "enteredReviewMode", id: `rv-${turnId}`, review: text.slice(7) } });
    broadcast("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { type: "exitedReviewMode", id: `rx-${turnId}`, review: `1 finding in ${text.slice(7)}: the cart total skips the discount (cart.js:42).` } });
    say = null;
  }
  // A compaction (thread/compact/start): its item, then the deprecated notification a Codex may send as well.
  if (text === "compact:") {
    broadcast("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: { type: "contextCompaction", id: `cc-${turnId}` } });
    broadcast("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { type: "contextCompaction", id: `cc-${turnId}` } });
    broadcast("thread/compacted", { threadId: t.id, turnId });
    say = null;
  }
  if (say) broadcast("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `a-${turnId}`, text: say, phase: null, delivery: null, memoryCitation: null, questions: null } });
  t.updatedAt = now();
  broadcast("turn/completed", { threadId: t.id, turn: { id: turnId, status, durationMs: Date.now() - started, items: [] } });
  setStatus({ type: "idle" });
}

const EFFORTS = (list: string[]) => list.map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` }));
let modelFailures = Number(process.env.FAKE_CODEX_MODEL_FAILURES || 0);

async function handle(c: Client, m: RpcMessage) {
  if (m.id !== undefined && !m.method) {
    asked.get(m.id)?.(m.result ?? null);
    asked.delete(m.id);
    return;
  }
  log({ method: m.method, params: m.params });
  const p: Params = m.params || {};
  const reply = (result: unknown) => send(c, { id: m.id, result });
  const t = p.threadId && threads.get(p.threadId);
  switch (m.method) {
    case "initialize":
      if (process.env.FAKE_CODEX_EARLY_ACCOUNT) {
        send(c, { method: "account/updated", params: {} });
        await sleep(50);
      }
      return reply({ userAgent: "fake-codex/0.160.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
    case "initialized":
      return;
    case "thread/list":
      return reply({ data: [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(plain), nextCursor: null });
    case "thread/loaded/list":
      return reply({ data: [...threads.values()].filter((x) => x.status.type !== "notLoaded").map((x) => x.id), nextCursor: null });
    case "thread/read":
      return t ? reply({ thread: p.includeTurns ? t : plain(t) }) : send(c, { id: m.id, error: { code: -1, message: "no thread" } });
    case "thread/resume":
      if (!t) return send(c, { id: m.id, error: { code: -1, message: "no thread" } });
      if (t.status.type === "notLoaded") t.status = { type: "idle" };
      return reply({ thread: plain(t), model: t.model, reasoningEffort: "high", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", networkAccess: false } });
    case "thread/start": {
      const nt = thread(`th-new-${++made}`, { cwd: p.cwd, source: "appServer", status: { type: "idle" }, createdAt: now(), updatedAt: now(), ...(p.model ? { model: p.model } : {}) });
      threads.set(nt.id, nt);
      reply({ thread: plain(nt) });
      return broadcast("thread/started", { thread: plain(nt) });
    }
    case "turn/start": {
      const turnId = `turn-${crypto.randomUUID().slice(0, 6)}`;
      const text = p.input?.filter((i) => i.type === "text").map((i) => i.text).join("\n") || "";
      const started = { turn: { id: turnId, items: [], status: "inProgress" } };
      // "instant": a turn that's over before the reply to the call that started it goes out.
      if (/instant/.test(text)) {
        await runTurn(t, turnId, text, p.clientUserMessageId || null);
        return reply(started);
      }
      reply(started);
      // "unannounced": a turn that's running, whose turn/started hasn't come yet.
      if (/unannounced/.test(text)) await sleep(2500);
      return runTurn(t, turnId, text, p.clientUserMessageId || null);
    }
    case "turn/steer":
      return reply({ turnId: p.expectedTurnId });
    // What its slash commands call.
    case "thread/compact/start": {
      reply(null);
      return runTurn(t, `turn-${crypto.randomUUID().slice(0, 6)}`, "compact:", null);
    }
    case "review/start": {
      if (p.target?.instructions === "break") return send(c, { id: m.id, error: { code: -1, message: "review needs a git repository" } });
      const turnId = `turn-${crypto.randomUUID().slice(0, 6)}`;
      const started = { turn: { id: turnId, items: [], status: "inProgress" }, reviewThreadId: t.id };
      const g = p.target || {};
      const what = g.type === "uncommittedChanges" ? "current changes" : g.type === "baseBranch" ? `changes against ${g.branch}` : g.type === "commit" ? `commit ${g.sha}` : g.instructions;
      if (/instant/.test(what)) {
        await runTurn(t, turnId, `review:${what}`, null);
        return reply(started);
      }
      reply(started);
      return runTurn(t, turnId, `review:${what}`, null);
    }
    case "thread/goal/set": {
      t.goal = { threadId: t.id, objective: p.objective ?? t.goal?.objective ?? "", status: p.status || t.goal?.status || "active", createdAt: now(), updatedAt: now(), timeUsedSeconds: 750, tokensUsed: 41200, tokenBudget: null };
      return reply({ goal: t.goal });
    }
    case "thread/goal/get":
      return reply({ goal: t.goal || null });
    case "thread/goal/clear":
      t.goal = null;
      return reply({});
    case "thread/name/set":
      t.name = p.name;
      reply({});
      return broadcast("thread/name/updated", { threadId: t.id, threadName: p.name });
    case "thread/fork": {
      // As Codex 0.166 does: the copy has the thread's turns (their ids and start times kept) and its name, no preview.
      const nt = thread(`th-fork-${++made}`, { ...t, id: `th-fork-${made}`, sessionId: `th-fork-${made}`, source: "appServer", status: { type: "idle" }, createdAt: now(), updatedAt: now(), preview: "", forkedFromId: t.id, turns: t.turns.map((x) => ({ ...x })), ...(p.cwd ? { cwd: p.cwd } : {}) });
      threads.set(nt.id, nt);
      reply({ thread: plain(nt), model: nt.model, cwd: nt.cwd });
      return broadcast("thread/started", { thread: plain(nt) });
    }
    case "mcpServerStatus/list":
      return reply({ data: [{ name: "agentbook", authStatus: "unsupported", runtimeStatus: "connected", tools: { ab_update: {}, ab_post: {}, ab_ask: {} }, toolsError: null, resources: [], resourceTemplates: [] }, { name: "linear", authStatus: "notLoggedIn", runtimeStatus: "authenticationRequired", tools: {}, toolsError: null, resources: [], resourceTemplates: [] }], nextCursor: null });
    case "turn/interrupt":
      turns.get(p.threadId)?.interrupt();
      return reply({});
    case "model/list":
      if (process.env.FAKE_CODEX_MODELS_READY && !fs.existsSync(process.env.FAKE_CODEX_MODELS_READY)) return reply({ data: [], nextCursor: null });
      if (modelFailures-- > 0) return send(c, { id: m.id, error: { code: -32000, message: "Model catalog not ready" } });
      return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, hidden: false, supportedReasoningEfforts: EFFORTS(["low", "medium", "high", "xhigh"]), defaultReasoningEffort: "medium" }, { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", isDefault: false, hidden: false, supportedReasoningEfforts: EFFORTS(["minimal", "low", "medium", "high"]), defaultReasoningEffort: "low" }, { id: "gpt-old", model: "gpt-old", displayName: "Old", isDefault: false, hidden: true }], nextCursor: null });
    // Its ChatGPT plan's limits, what /status shows (FAKE_CODEX_LIMITS: a file with the answer, else this one).
    case "account/rateLimits/read": {
      const file = process.env.FAKE_CODEX_LIMITS;
      if (file && fs.existsSync(file)) return reply(JSON.parse(fs.readFileSync(file, "utf8")));
      const snap = { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: now() + 3 * 86400 }, secondary: { usedPercent: 41, windowDurationMins: 300, resetsAt: now() + 7200 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, individualLimit: null, spendControlReached: false, planType: "prolite", rateLimitReachedType: null };
      return reply({ ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: { codex: snap }, rateLimitResetCredits: null, accountId: "acct-test", rateLimitUpsell: null });
    }
    // Its config.toml, as its daemon reads and writes it: only what a test needs (keyPath "a.b" sets config.a.b).
    case "config/read": {
      // Where an entry is, as Codex 0.166 says it: origins by dotted key, layers when asked (FAKE_CODEX_CONFIG's file).
      const file = process.env.FAKE_CODEX_CONFIG;
      const user = file && { type: "user", file, profile: null };
      const origins = user && config.mcp_servers?.agentbook ? { "mcp_servers.agentbook.url": { name: user, version: "sha256:0" } } : {};
      return reply({ config, origins, layers: p?.includeLayers && user ? [{ name: user, config, version: "sha256:0", disabledReason: null }] : null });
    }
    case "config/value/write": {
      const keys = p.keyPath.split(".");
      const parent = keys.slice(0, -1).reduce<Record<string, Json>>((o, k) => (o[k] ||= {}), config);
      const last = keys.at(-1);
      parent[last] = p.mergeStrategy === "upsert" && parent[last] && typeof p.value === "object" ? { ...parent[last], ...p.value } : p.value;
      // FAKE_CODEX_CONFIG: its MCP servers written to that file too, made anew and with the mode it had, as Codex 0.166
      // does (a new one is the person's alone).
      const file = process.env.FAKE_CODEX_CONFIG;
      if (file) {
        const toml = Object.entries(config.mcp_servers || {}).map(([k, v]) => `[mcp_servers.${k}]\n${Object.entries(v || {}).map(([a, b]) => `${a} = ${JSON.stringify(b)}`).join("\n")}\n`).join("\n");
        let mode = 0o600;
        try {
          mode = fs.statSync(file).mode & 0o777;
        } catch {}
        fs.writeFileSync(`${file}.tmp`, toml);
        fs.chmodSync(`${file}.tmp`, mode);
        fs.renameSync(`${file}.tmp`, file);
      }
      return reply({ status: "ok", version: `sha256:${crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex")}`, filePath: file || "/tmp/fake-codex/config.toml", overriddenMetadata: null });
    }
    case "config/mcpServer/reload":
      return reply({});
    case "skills/list":
      return reply({ data: [{ cwd: p.cwds?.[0] || PROJECT, errors: [], skills: [
        { name: "deploy", description: "Ship the app to production", shortDescription: "Ship it", enabled: true, path: "/tmp/skills/deploy/SKILL.md", scope: "user" },
        { name: "seed-db", description: "Load the shop's sample data", enabled: true, path: `${PROJECT}/.codex/skills/seed-db/SKILL.md`, scope: "repo" },
        { name: "figma", description: "Read designs from Figma", interface: { shortDescription: "Designs from Figma" }, enabled: true, path: "/tmp/plugins/figma/skills/figma/SKILL.md", scope: "user", pluginId: "figma@openai-curated" },
        { name: "review", description: "A skill named like a command", enabled: true, path: "/tmp/skills/review/SKILL.md", scope: "user" },
        { name: "old", description: "Turned off", enabled: false, path: "/tmp/skills/old/SKILL.md", scope: "user" },
      ] }] });
    default:
      return send(c, { id: m.id, error: { code: -32601, message: `fake codex: no ${m.method}` } });
  }
}

net
  .createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    const c: Client = {
      frame(text) {
        const body = Buffer.from(text);
        const n = body.length;
        const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
        sock.write(Buffer.concat([head, body]));
      },
    };
    sock.on("error", () => {});
    sock.on("close", () => clients.delete(c));
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = buf.subarray(0, end).toString().match(/Sec-WebSocket-Key: (\S+)/i)?.[1];
        const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
        buf = buf.subarray(end + 4);
        open = true;
        clients.add(c);
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = buf[1] & 0x80;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const body = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        if (op === 0x8) return sock.end();
        if (op === 0x1) {
          try {
            handle(c, JSON.parse(body.toString("utf8")));
          } catch {}
        }
      }
    });
  })
  .listen(SOCK, () => console.log(`fake codex on ${SOCK}`));
