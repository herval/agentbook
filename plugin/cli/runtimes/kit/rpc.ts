// JSON-RPC 2.0 over lines (a child's stdio) or messages (a WebSocket), for the runtimes that speak it: calls with their
// replies matched by id and given up on after a while, notifications, and the requests the other side makes (answered
// by the runtime, or refused as methods agentbook doesn't handle).

// A message from the other side that isn't a reply to a call: a request (with an id) or a notification.
export interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown> & { [k: string]: unknown };
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown } | null;
}

export interface RpcOpts {
  // Sends one message, as its JSON.
  send(json: string): unknown;
  // Who it is, for its errors: "Hermes didn't answer session/new".
  name: string;
  // A request or notification from it. A request it returns nothing for is refused.
  onMessage?(m: RpcMessage, rpc: Rpc): unknown;
  // How its errors read ("Internal error: …" to what went wrong).
  errorText?(message: string): string;
  // Its messages go without `"jsonrpc": "2.0"`, as Codex's app-server speaks it (JSON-RPC "lite").
  lite?: boolean;
  // How a message goes on the wire, when that isn't JSON-RPC's own (OpenClaw's gateway: { type: "req", id, method,
  // params }). The other side's frames are handed to `take` as JSON-RPC's.
  frame?(m: Record<string, unknown>): unknown;
}

export interface Rpc {
  // A call: its result, or why not. `timeout` 0: wait for as long as it takes.
  call<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  reply(id: RpcMessage["id"], result: unknown): void;
  refuse(id: RpcMessage["id"], message: string, code?: number): void;
  // A message as it came: a reply to a call, or handed to onMessage.
  take(m: RpcMessage): void;
  // A line of JSON as it came (a child's stdout).
  line(text: string): void;
  // It's gone: every call waiting fails with `e`.
  fail(e: Error): void;
  waiting(): number;
}

export function createRpc(o: RpcOpts): Rpc {
  const waiting = new Map<number, { resolve(r: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> | null }>();
  let next = 1;
  const send = (m: Record<string, unknown>) => o.send(JSON.stringify(o.frame ? o.frame(m) : o.lite ? m : { jsonrpc: "2.0", ...m }));
  const rpc: Rpc = {
    call: <T>(method: string, params?: unknown, timeout = 120e3) =>
      new Promise<T>((resolve, reject) => {
        const id = next++;
        const timer = timeout ? setTimeout(() => (waiting.delete(id), reject(new Error(`${o.name} didn't answer ${method}`))), timeout) : null;
        waiting.set(id, { resolve, reject, timer });
        try {
          send({ id, method, ...(params !== undefined ? { params } : {}) });
        } catch (e) {
          waiting.delete(id);
          if (timer) clearTimeout(timer);
          reject(e);
        }
      }),
    notify: (method, params) => void send({ method, ...(params !== undefined ? { params } : {}) }),
    reply: (id, result) => void send({ id, result }),
    refuse: (id, message, code = -32601) => void send({ id, error: { code, message } }),
    take(m) {
      if (!m || typeof m !== "object") return;
      if (m.id != null && !m.method && waiting.has(m.id as number)) {
        const w = waiting.get(m.id as number);
        waiting.delete(m.id as number);
        if (w.timer) clearTimeout(w.timer);
        // What it said went wrong, with its code and data, for a runtime that reads them (a file that's too big).
        if (m.error) return w.reject(Object.assign(new Error(o.errorText ? o.errorText(String(m.error.message || "")) : String(m.error.message || `${o.name} refused`)), { code: m.error.code, data: m.error.data }));
        return w.resolve(m.result);
      }
      if (!m.method) return;
      const handled = o.onMessage?.(m, rpc);
      if (m.id != null && handled === undefined) rpc.refuse(m.id, `agentbook can't handle ${m.method}`);
    },
    line(text) {
      let m: RpcMessage;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      rpc.take(m);
    },
    fail(e) {
      for (const w of waiting.values()) {
        if (w.timer) clearTimeout(w.timer);
        w.reject(e);
      }
      waiting.clear();
    },
    waiting: () => waiting.size,
  };
  return rpc;
}
