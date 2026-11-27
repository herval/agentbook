#!/usr/bin/env node
import assert from "node:assert/strict";
import { mock } from "node:test";
import { apply } from "../plugin/dsh/index.js";
import type { Json } from "./harness-types.ts";

const sockets: Socket[] = [];
class Socket {
  sent: Json[] = [];
  onopen?: () => void;
  onclose?: () => void;
  constructor() { sockets.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.onclose?.(); }
}
const originalWebSocket = globalThis.WebSocket;
const tick = async (ms = 0) => {
  mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
};
const catalog = (id: string) => ({ groups: [{ id: "provider", models: [{ id }] }], default: { provider: "provider", model: id } });
const models = (socket: Socket) => socket.sent.filter((m) => m.t === "models");
let finish: (value: ReturnType<typeof catalog>) => void;
let reply = () => new Promise<ReturnType<typeof catalog>>((resolve) => finish = resolve);
let reads = 0;
let dispose: () => void;
const controller = { commands: {}, modelCatalog: () => { reads++; return reply(); } };
const ctx = {
  on() {},
  effect(fn: () => () => void) { dispose = fn(); },
  inject(names: string[], fn: (services: object) => void) {
    // As dsh 0.2.1 does: a new sessionController each time it's read.
    if (names[0] === "sessionController") fn({ get sessionController() { return { ...controller }; } });
  },
  logger: () => ({ debug() {} }),
};

try {
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  apply(ctx, { url: "https://dsh-models.test", profile: "web" });
  const first = sockets.at(-1);
  first.onopen();
  await tick();
  assert.equal(reads, 1);
  const late = finish;
  await tick(10000);
  reply = async () => catalog("working");
  await tick(10000);
  assert.equal(models(first).at(-1)?.default, "provider/working", "a stalled initial catalog retries without reconnecting or starting a thread");
  late(catalog("obsolete"));
  await tick();
  assert.equal(models(first).at(-1)?.default, "provider/working", "a timed-out response cannot overwrite the recovered catalog");

  reply = () => new Promise((resolve) => finish = resolve);
  first.close();
  await tick(2000);
  const second = sockets.at(-1);
  second.onopen();
  await tick();
  assert.equal(models(second).at(-1)?.default, "provider/working", "reconnecting republishes the same app's working list while discovery stalls");
  await tick(10000);
  reply = async () => { throw new Error("catalog offline"); };
  await tick(10000);
  assert.equal(models(second).length, 1, "a failed refresh does not clear the working picker");
  reply = async () => catalog("updated");
  await tick(10000);
  assert.equal(models(second).at(-1)?.default, "provider/updated", "a rejected catalog also retries and refreshes its models");

  reply = () => new Promise((resolve) => finish = resolve);
  second.close();
  await tick(2000);
  const third = sockets.at(-1);
  third.onopen();
  await tick();
  const before = reads;
  dispose();
  finish(catalog("after-disposal"));
  await tick(60000);
  assert.equal(reads, before, "unloading the plugin stops discovery retries");
  assert.equal(models(third).at(-1)?.default, "provider/updated", "unloading the plugin ignores an unfinished response");

  apply({ ...ctx, inject() {} }, { url: "https://dsh-models.test", profile: "acp" });
  const withoutCatalog = sockets.at(-1);
  withoutCatalog.onopen();
  await tick(60000);
  assert.equal(withoutCatalog.sent[0]?.t, "hello", "an ACP profile without a catalog still connects");
  assert.equal(reads, before, "a profile without a catalog does not retry discovery");
  console.log("PASS  DeepSeek catalog stalls, retries, late replies, cached reconnects, and disposal");
} finally {
  dispose?.();
  globalThis.WebSocket = originalWebSocket;
  mock.timers.reset();
}
