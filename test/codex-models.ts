#!/usr/bin/env node
// A daemon can predate a model release. Discovery uses that daemon's live account catalog, and remains
// usable offline without carrying one account's choices into another account's picker.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHome, createModelReader } from "../plugin/cli/runtimes/codex/models.ts";

let failures = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-codex-models-"));
const file = path.join(home, "auth.json");
const token = "chatgpt-access-one";
const account = "account-one";
const login = (access = token, id = account, mode = "chatgpt") => fs.writeFileSync(file, JSON.stringify({ auth_mode: mode, tokens: { access_token: access, account_id: id } }));
const call = async () => ({ data: [
  { id: "gpt-6.1-sol", displayName: "Old Sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" },
  { id: "gpt-hidden", hidden: true },
] });
const old = "gpt-6.1-sol";
const newer = "gpt-6.2-sol";
const response = (slug = newer) => new Response(JSON.stringify({ models: [
  { slug, display_name: "New Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }, { effort: "ultra" }], default_reasoning_level: "low" },
  { slug: old, display_name: "Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high" },
  { slug: "reserve", visibility: "hide" },
  { slug: "not-a-picker-model" },
  { visibility: "list" },
  null,
] }));
let requests: { url: URL; opts: RequestInit }[] = [];
let reply: () => Response | Promise<Response> = response;
const request: typeof fetch = async (url, opts) => {
  requests.push({ url: new URL(String(url)), opts });
  return reply();
};
const version = () => "0.171.0";
const reader = createModelReader({ call, home, request, version });
const ids = (models: Awaited<ReturnType<typeof reader.read>>) => models.list.map((m) => m.id).join();

try {
  check(ids(await reader.read()) === old && requests.length === 0, "without a ChatGPT sign-in, its daemon still supplies the picker");
  fs.writeFileSync(file, "unfinished JSON");
  check(ids(await reader.read()) === old, "a sign-in file being replaced doesn't break the picker");
  login(token, account, "apikey");
  check(ids(await reader.read()) === old && requests.length === 0, "API-key mode never uses a leftover ChatGPT token");

  login();
  const custom = createModelReader({ call, home, request, version, usesOpenai: async () => false });
  check(ids(await custom.read()) === old && requests.length === 0, "a custom provider keeps its own models even when a ChatGPT sign-in remains on disk");
  const live = await reader.read();
  check(ids(live) === `${newer},${old}`, "new models absent from the daemon appear in server order; hidden and malformed entries stay out");
  check(live.list[0].name === "New Sol" && isDeepStrictEqual(live.list[0].efforts, ["low", "high", "max", "ultra"]) && live.list[0].effort === "low", "new models keep the live catalog's display name and every reasoning option");
  check(live.default === old && live.list[1].name === "Sol" && live.effort === "high" && live.efforts.join() === "low,high", "discovery preserves the daemon's default model and refreshes its reasoning metadata");
  const sent = requests[0];
  const headers = new Headers(sent.opts.headers);
  check(sent.url.origin === "https://chatgpt.com" && sent.url.pathname === "/backend-api/codex/models" && sent.url.searchParams.get("client_version") === "0.171.0", "the live request uses the connected daemon's version");
  check(headers.get("authorization") === `Bearer ${token}` && headers.get("chatgpt-account-id") === account && sent.opts.redirect === "error" && !!sent.opts.signal, "the request authenticates the selected account, rejects redirects, and has a timeout");
  check(!JSON.stringify(live).includes(token) && !JSON.stringify(live).includes(account), "only model metadata leaves the reader");

  reply = () => new Response("forbidden", { status: 403 });
  check(isDeepStrictEqual(await reader.read(), live), "an HTTP failure retains that account's last live catalog instead of dropping its newer models");
  reply = () => new Response("not JSON");
  check(isDeepStrictEqual(await reader.read(), live), "a malformed response retains the working catalog");
  reply = () => new Response('{"models":[]}');
  check(isDeepStrictEqual(await reader.read(), live), "an empty response doesn't empty the picker");
  reply = () => { throw new Error("network offline"); };
  check(isDeepStrictEqual(await reader.read(), live), "a network failure also keeps its last successful catalog");

  login("chatgpt-access-two", "account-two");
  check(ids(await reader.read()) === old, "a different account never inherits the previous account's cached model choices");
  reply = () => response("account-two-model");
  check(ids(await reader.read()) === `account-two-model,${old}`, "the next account is fetched with its own credentials");
  const secondHeaders = new Headers(requests.at(-1).opts.headers);
  check(secondHeaders.get("authorization") === "Bearer chatgpt-access-two" && secondHeaders.get("chatgpt-account-id") === "account-two", "account changes replace both token and workspace header");
  fs.unlinkSync(file);
  const count = requests.length;
  check(ids(await reader.read()) === old && requests.length === count, "signing out discards the live account catalog and stops authenticated requests");

  login();
  const noVersion = createModelReader({ call, home, request, version: () => null });
  check(ids(await noVersion.read()) === old && requests.length === count, "if the daemon version is unavailable, discovery uses its own catalog");
  const offline = createModelReader({ call, home, request: async () => new Response(null, { status: 503 }), version });
  check(ids(await offline.read()) === old, "a first refresh offline still gives a usable daemon picker");
  const noDaemon = createModelReader({ call: async () => { throw new Error("daemon unavailable"); }, home, request: async () => response(), version });
  check(ids(await noDaemon.read()) === `${newer},${old}`, "a live catalog remains usable even if model/list fails");

  let releaseCatalog: (r: Response) => void;
  let catalogStarted: () => void;
  const catalogPending = new Promise<Response>((resolve) => releaseCatalog = resolve);
  const catalogEntered = new Promise<void>((resolve) => catalogStarted = resolve);
  let catalogOnline = false;
  let catalogSignal: AbortSignal;
  const stalled = createModelReader({ call, home, version, catalogTimeoutMs: 20, request: async (_url, opts) => {
    if (catalogOnline) return response();
    catalogSignal = opts.signal;
    catalogStarted();
    return catalogPending;
  } });
  const bounded = async (reading: ReturnType<typeof reader.read>) => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([reading, new Promise<null>((resolve) => timer = setTimeout(() => resolve(null), 200))]); }
    finally { clearTimeout(timer); }
  };
  const loading = stalled.read();
  await catalogEntered;
  check(ids(stalled.get()) === old, "the daemon's models are available while the live catalog is still loading");
  const timedOut = await bounded(loading);
  check(timedOut && ids(timedOut) === old && catalogSignal.aborted, "a fetch that ignores cancellation still releases discovery at its deadline");
  catalogOnline = true;
  const recovered = await stalled.read();
  check(ids(recovered) === `${newer},${old}`, "discovery can refresh again after a stalled request");
  releaseCatalog(response("too-late-model"));
  await loading;
  check(isDeepStrictEqual(stalled.get(), recovered), "a timed-out catalog finishing late cannot overwrite the recovered picker");
  let finishBody: () => void;
  const bodyStalled = createModelReader({ call, home, version, catalogTimeoutMs: 20, request: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"models":[]}'));
      finishBody = () => controller.close();
    },
  })) });
  const bodyResult = await bounded(bodyStalled.read());
  check(bodyResult && ids(bodyResult) === old, "the deadline also covers a response body that never finishes");
  finishBody();

  let entered: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  let finish: (r: Response) => void;
  const delayed = new Promise<Response>((resolve) => finish = resolve);
  const racing = createModelReader({ call, home, version, request: async (_url, opts) => {
    if (new Headers(opts.headers).get("authorization") === `Bearer ${token}`) { entered(); return delayed; }
    return response("account-two-model");
  } });
  const first = racing.read();
  await started;
  login("chatgpt-access-two", "account-two");
  racing.clear();
  const second = await racing.read();
  finish(response("old-account-model"));
  check(isDeepStrictEqual(await first, second) && ids(second) === `account-two-model,${old}`, "an old account's in-flight response can't overwrite a newer account's catalog");

  let daemonVersion = "0.160.0";
  let native = true;
  let online = true;
  const compatible = createModelReader({ call, home, version: () => daemonVersion, usesOpenai: async () => native, request: async (url) => {
    if (!online) throw new Error("offline");
    return new URL(String(url)).searchParams.get("client_version") === "0.171.0" ? response() : new Response(JSON.stringify({ models: [{ slug: old, visibility: "list" }] }));
  } });
  check(ids(await compatible.read()) === old, "an older daemon never borrows the newer CLI's model eligibility");
  daemonVersion = "0.171.0";
  check(ids(await compatible.read()) === `${newer},${old}`, "new models become available when the connected daemon is upgraded");
  daemonVersion = "0.160.0";
  online = false;
  check(ids(await compatible.read()) === old, "reconnecting to an older daemon offline discards the newer daemon's cached choices");
  daemonVersion = "0.171.0";
  online = true;
  await compatible.read();
  native = false;
  check(ids(await compatible.read()) === old, "switching providers also discards the OpenAI live catalog");

  const keys = ["AGENTBOOK_CODEX_HOME", "AGENTBOOK_CODEX_SOCK", "CODEX_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.AGENTBOOK_CODEX_HOME;
    process.env.AGENTBOOK_CODEX_SOCK = "/another-account/socket";
    process.env.CODEX_HOME = home;
    check(codexHome() === null, "a custom socket never silently reads this person's real sign-in");
    process.env.AGENTBOOK_CODEX_HOME = home;
    check(codexHome() === home, "a custom socket can explicitly select its matching account home");
    delete process.env.AGENTBOOK_CODEX_HOME;
    delete process.env.AGENTBOOK_CODEX_SOCK;
    check(codexHome() === home, "CODEX_HOME is respected for the default connection");
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
if (failures) process.exit(1);
