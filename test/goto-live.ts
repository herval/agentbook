#!/usr/bin/env node
// ⌘K finds a thread that started after the page loaded, in a real browser (headless Chrome), when the page's ask for
// its chrome (q/side, whose thread rows are what ⌘K and the sidebar list) went wrong as its stream started over:
// - unanswered: the server
//   restarts, and the page's first two asks after its hello fail; it asks again, and hears the thread that starts;
// - answered, but by a server that says it doesn't know the page's stream: the page opens its stream again, from the
//   start, and its hello asks again.
// Run: node test/goto-live.ts   (needs Chrome: CHROME=<path> if it isn't where Chrome usually is)

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const until = async (cond: () => Promise<boolean>, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await cond()) return true;
  return cond();
};

function chromePath(): string | null {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin") return fs.existsSync(mac) ? mac : null;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}
const CHROME = chromePath();
if (!CHROME) {
  if (process.env.GITHUB_ACTIONS) check(false, "Chrome is on the runner");
  else console.log("SKIP  no Chrome here (set CHROME to its path)");
  process.exit(failures ? 1 : 0);
}

/* ---------- agentbook ---------- */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-goto-live-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
const PORT = testPort(5640);
const URL = `http://127.0.0.1:${PORT}`;
const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"), FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"), CLAUDE_CONFIG_DIR: path.join(HOME, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_PROC"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR!);
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
const server = spawnAgentbook({ env, stdio: "ignore" });

async function req(method: string, p: string, body?: unknown): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
// A thread starts: a session says hello, then its headline.
let n = 0;
async function thread(title: string): Promise<void> {
  n++;
  await req("POST", "/api/hello", { proc: `box-${n}`, label: `bird${n}`, agent: "Claude", session_id: `sess-${n}`, cwd: project });
  await req("POST", `/api/procs/box-${n}/post`, { title });
}

/* ---------- Chrome, over the DevTools protocol ---------- */

type Msg = { id?: number; method?: string; sessionId?: string; params?: Json; result?: Json };
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-goto-live-chrome-"));
const chrome: ChildProcess = spawnTied(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--disable-features=MacAppCodeSignClone", "--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", detached: true });
process.on("exit", () => {
  try {
    process.kill(-chrome.pid!, "SIGTERM");
  } catch {}
  server.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));

try {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const owner = await req("POST", "/api/auth/test-person", { username: "herval" });
  await thread("One importer");
  await thread("Two keys");

  let browserUrl = "";
  for (let i = 0; i < 200 && !browserUrl; i++) {
    await sleep(100);
    try {
      const [port, at] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
      if (port && at) browserUrl = `ws://127.0.0.1:${port}${at}`;
    } catch {}
  }
  check(browserUrl, "Chrome starts headless");
  if (!browserUrl) process.exit(1);
  const ws = new WebSocket(browserUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let nextId = 0;
  const waiting = new Map<number, (m: Msg) => void>();
  let onEvent: (m: Msg) => void = () => {};
  ws.addEventListener("message", (e) => {
    const m: Msg = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)!(m);
      waiting.delete(m.id);
    } else if (m.sessionId) onEvent(m);
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<Msg> =>
    new Promise((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })).result;
  const sid: string = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
  const cdp = (method: string, params: object = {}) => send(method, params, sid);
  const js = async (expression: string) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const [name, ...value] = owner.cookie.split("=");
  await cdp("Network.setCookie", { url: URL, name, value: value.join("=") });

  // The page's asks for its chrome: how many went out, and what's done to the next ones (fail them, or answer them
  // as a server that doesn't know the page's stream).
  let asks = 0;
  const plan: ("fail" | "unwatched")[] = [];
  onEvent = (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, responseStatusCode } = m.params;
    if (responseStatusCode == null) {
      asks++;
      const what = plan.shift();
      if (what === "fail") return void cdp("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" });
      // An answer to change: let it reach the server, and change it on its way back.
      if (what === "unwatched") return void cdp("Fetch.continueRequest", { requestId, interceptResponse: true });
      return void cdp("Fetch.continueRequest", { requestId });
    }
    void (async () => {
      const body = JSON.parse(Buffer.from((await cdp("Fetch.getResponseBody", { requestId })).result.body, "base64").toString("utf8"));
      body.watching = false;
      await cdp("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
    })();
  };
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/q/side*", requestStage: "Request" }] });
  await cdp("Page.navigate", { url: `${URL}/#/feed` });

  // ⌘K, with `q` typed: the names it lists. It opens only if it isn't open (a ⌘K pressed as the page was still
  // starting may not have opened it), and closes, which forgets what was typed.
  const press = `document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }))`;
  const isOpen = `!!document.querySelector("dialog.goto[open]")`;
  async function goto(q: string): Promise<string[]> {
    if (!(await js(isOpen))) await js(press);
    await sleep(200);
    if (!(await js(isOpen))) return [];
    await js(`document.querySelector(".goto input").focus()`);
    await cdp("Input.insertText", { text: q });
    await sleep(500);
    const names: string[] = (await js(`[...document.querySelectorAll(".goto-list .goto-row b")].map((b) => b.textContent)`)) || [];
    if (await js(isOpen)) await js(press);
    await sleep(200);
    return names;
  }
  const finds = (q: string, title: string) => async () => (await goto(q)).includes(title);

  check(await until(finds("keys", "Two keys"), 30e3), "⌘K finds a thread the page loaded with");

  // ---------- unanswered ----------
  plan.push("fail", "fail");
  const before = asks;
  await server.restart("agentbook-server");
  await until(async () => asks >= before + 1, 15e3);
  await thread("Plan the personal mesh");
  check(await until(finds("personal mesh", "Plan the personal mesh"), 20e3), "after its ask failed twice as the server restarted, ⌘K finds a thread that started then");
  // ⌘K's content search (q/search) can find it before the page's rows do, so the asks are waited for, not counted then.
  check(await until(async () => asks >= before + 3, 15e3), `it asked again until it was answered (${asks - before} asks)`);

  // ---------- answered, but unwatched ----------
  plan.push("unwatched");
  const was = asks;
  await server.restart("agentbook-server");
  await until(async () => asks >= was + 1, 15e3);
  await thread("Rotate the staging keys");
  check(await until(finds("staging", "Rotate the staging keys"), 20e3), "told the server doesn't know its stream, it opens it again, and ⌘K finds a thread that started then");
  check(asks >= was + 2, `and asked again on that stream's hello (${asks - was} asks)`);
} catch (e) {
  check(false, `it ran to the end: ${(e as Error).stack || e}`);
} finally {
  process.exit(failures ? 1 : 0);
}
