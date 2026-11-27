// An Agent Client Protocol client (agentclientprotocol.com): JSON-RPC over a child's stdio, for runtimes that ship an
// ACP server (Hermes's `hermes acp`, dsh's `dsh --profile acp`, Antigravity's `agy acp`). It starts the server once it's needed, initializes
// it, gives the sessions it opens agentbook's tools, and turns its permission requests into asks on their threads
// and their answers back into its options. Grok's `grok agent stdio` is one too.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { CODE_ROOT } from "../../../shared/bundle.ts";
import { createRpc } from "./rpc.ts";
import type { Rpc, RpcMessage } from "./rpc.ts";
import type { AnswerEvent, PermissionEvent } from "../../../shared/types.ts";
import type { RuntimeContext } from "../runtime.ts";

const BRIDGE = path.join(CODE_ROOT, "mcp", "http-bridge.ts");

// An ACP server is agentbook's child, so a turn running when agentbook stops stops with it, and so do the background
// tasks it left. What a turn a restart cut off is picked up with, and what a thread whose background tasks it cut off
// is told: it won't hear when they end now.
export const CARRY_ON = "agentbook: agentbook restarted and cut your last turn off partway, so carry on where you left off.";
export const tasksCut = (titles: string[]) => {
  const one = titles.length === 1;
  return `agentbook: agentbook restarted while ${one ? "a background task" : "background tasks"} you left running ${one ? "was" : "were"} still going (${titles.map((t) => `\`${t}\``).join(", ")}), so you won't hear when ${one ? "it ends" : "they end"}. Check how far ${one ? "it" : "they"} got, then carry on.`;
};

// What an ACP server says it can do, as it answers initialize: whether it takes MCP servers over HTTP, loads or
// resumes sessions, and more.
export interface AcpCaps {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean };
  sessionCapabilities?: { resume?: unknown; close?: unknown };
  [more: string]: unknown;
}
export interface AcpInit {
  agentCapabilities?: AcpCaps;
  authMethods?: { id?: string; name?: string }[];
  _meta?: Record<string, unknown>;
}

// A permission option, as ACP gives them: allow_once, allow_always, reject_once, reject_always.
export interface AcpOption {
  kind?: string;
  optionId?: string;
  name?: string;
}

// The server, running: calls to it, whether it takes agentbook's tools by address (`http`), what else it said it can
// do (and all it answered initialize with: Grok's models and slash commands ride in its `_meta`), and the sessions
// open in it.
export interface AcpServer {
  child: ChildProcessWithoutNullStreams;
  rpc: Rpc;
  http: boolean;
  caps: AcpCaps;
  init: AcpInit;
  open: Set<string>;
  ready: Promise<AcpServer>;
}

export interface AcpOpts {
  // Who it is, for what it says: "Hermes", "dsh".
  name: string;
  // Its permission asks' keys start with this: "hm", "ds".
  prefix: string;
  // The command and its arguments, or null when it isn't installed (`missing` says so).
  command(): string | null;
  args: string[];
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  missing: string;
  // Its errors' prefixes, to drop ("Internal error: <what went wrong>").
  errorText?(message: string): string;
  // A session/update notification.
  onUpdate?(params: Record<string, unknown>): void;
  // Another notification, one of its own (Grok's `_x.ai/session/update`).
  onNotice?(method: string, params: Record<string, unknown>): void;
  // A session/request_permission request: its session, the tool call it's about, its options. Return the thread it's
  // on to ask there, or null to cancel it.
  onPermission?(params: { sessionId?: string; toolCall?: Record<string, unknown>; options?: AcpOption[] }, key: string): unknown;
  // It started (ready) or stopped (with why).
  onReady?(a: AcpServer): void;
  onExit?(why: string): void;
}

export function createAcp(o: AcpOpts) {
  let acp: AcpServer | null = null;
  const resetting = new WeakSet<AcpServer>();
  // Permission requests asked on threads, by their key: answered once you do.
  const asks = new Map<string, { a: AcpServer; id: RpcMessage["id"]; options: AcpOption[] }>();

  function start(): Promise<AcpServer> {
    if (acp) return acp.ready;
    const cmd = o.command();
    if (!cmd) return Promise.reject(new Error(o.missing));
    const child = spawn(cmd, o.args, { env: typeof o.env === "function" ? o.env() : o.env || process.env, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    const self = { child, http: false, caps: {}, init: {}, open: new Set<string>() } as AcpServer;
    self.rpc = createRpc({
      name: o.name,
      send: (json) => child.stdin.write(json + "\n"),
      errorText: o.errorText,
      onMessage: (m) => {
        if (m.method === "session/update") {
          o.onUpdate?.(m.params || {});
          return true;
        }
        if (m.method === "session/request_permission") {
          const p = (m.params || {}) as Parameters<AcpOpts["onPermission"]>[0];
          const key = `${o.prefix}-${m.id}`;
          asks.set(key, { a: self, id: m.id, options: p.options || [] });
          if (!o.onPermission?.(p, key)) cancel(key);
          return true;
        }
        if (m.id == null && o.onNotice) {
          o.onNotice(m.method, (m.params || {}) as Record<string, unknown>);
          return true;
        }
      },
    });
    child.stdin.on("error", () => {}); // it stopped: "exit" says so
    child.on("error", (e: NodeJS.ErrnoException) => self.rpc.fail(new Error(e.code === "ENOENT" ? o.missing : e.message)));
    child.on("exit", (code) => {
      const why = err.trim().split("\n").filter(Boolean).at(-1);
      const said = `${o.name}'s ACP server stopped${why ? `: ${why.slice(0, 200)}` : code ? ` (exit ${code})` : "."}`;
      self.rpc.fail(new Error(said));
      for (const [k, x] of asks) if (x.a === self) asks.delete(k);
      if (acp === self) acp = null;
      if (!resetting.has(self)) o.onExit?.(said);
    });
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000))); // its logs, for when it stops
    readline.createInterface({ input: child.stdout }).on("line", (line) => self.rpc.line(line));
    self.ready = self.rpc.call<AcpInit>("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agentbook", version: "2" } }, 60e3).then((r) => {
      self.init = r || {};
      self.caps = r?.agentCapabilities || {};
      self.http = !!self.caps.mcpCapabilities?.http;
      o.onReady?.(self);
      return self;
    });
    self.ready.catch(() => child.kill());
    acp = self;
    return self.ready;
  }

  // agentbook's MCP server for a session, writing to its post (`proc`), as ACP hands an agent MCP servers: by its
  // address when the server said it takes HTTP ones, else as a command, which every ACP agent runs. (A bridge reads
  // this machine's key itself, as a command line is anyone's to see.)
  function equip(ctx: Pick<RuntimeContext, "mcp">, a: AcpServer, proc: string, cwd: string) {
    const { url } = ctx.mcp(proc, cwd, { bridged: !a.http });
    const home = process.env.AGENTBOOK_HOME;
    return [a.http ? { type: "http", name: "agentbook", url, headers: [] } : { name: "agentbook", command: process.execPath, args: [BRIDGE, url], env: home ? [{ name: "AGENTBOOK_HOME", value: home }] : [] }];
  }

  // Allow/Deny on a thread, back to the server as the option it offered for it. False when it isn't one of its asks.
  function answer(e: PermissionEvent | AnswerEvent): boolean {
    if (e.type !== "permission") return false;
    const x = asks.get(e.request_id);
    if (!x) return false;
    asks.delete(e.request_id);
    const yes = e.behavior === "allow";
    const pick = x.options.find((p) => (yes ? p.kind === "allow_once" || p.optionId === "allow_once" : p.kind === "reject_once" || p.optionId === "deny")) || x.options.find((p) => (yes ? /^allow/ : /^(reject|deny)/).test(p.kind || p.optionId || ""));
    x.a.rpc.reply(x.id, { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } });
    return true;
  }
  function cancel(key: string) {
    const x = asks.get(key);
    if (!x) return;
    asks.delete(key);
    x.a.rpc.reply(x.id, { outcome: { outcome: "cancelled" } });
  }

  return {
    start,
    async reset() {
      const old = acp;
      if (!old) return;
      resetting.add(old);
      acp = null;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => old.child.kill("SIGKILL"), 2000);
        old.child.once("exit", () => { clearTimeout(timeout); resolve(); });
        old.child.kill();
      });
    },
    current: () => acp,
    equip,
    answer,
    // Stop a session's turn.
    cancel: (sessionId: string) => acp?.rpc.notify("session/cancel", { sessionId }),
    asking: (key: string) => asks.has(key),
  };
}
export type Acp = ReturnType<typeof createAcp>;
