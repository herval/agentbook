#!/usr/bin/env node
// The page itself, in a real browser: every screen of the demo (test/demo.ts), opened in headless Chrome as a desktop
// at 1440 wide and as an iPhone at 390, each one drawing something, with no error on the page, and on the iPhone not
// wider than the screen. And the iPhone gets maximum-scale=1, so tapping a box with text under 16px doesn't zoom the
// page in and leave it zoomed (the React port lost that once: "Mobile isn't holding the viewport proportions").
// The screens are the main ones below, then two of each kind of address they link to, found on them.
// Run: node test/page.ts   (needs Chrome: CHROME=<path> if it isn't where Chrome usually is)

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnTied } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// Chrome: CHROME, or where it usually is on a Mac and on Linux (GitHub's runners have google-chrome).
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
  // Not a failure on a machine without Chrome; CI has it, and says so if it's gone.
  if (process.env.GITHUB_ACTIONS) check(false, "Chrome is on the runner");
  else console.log("SKIP  no Chrome here (set CHROME to its path)");
  process.exit(failures ? 1 : 0);
}

/* ---------- the demo ---------- */

const PORT = await freePort(6630, 20);
const BASE = `http://127.0.0.1:${PORT}`;
const env: NodeJS.ProcessEnv = { ...process.env, DEMO_PORT: String(PORT) };
delete env.AGENTBOOK_PLUGIN_DIR; // a session's own plugin folder would start that copy instead
const demo = spawnTied(process.execPath, [path.join(TEST, "demo.ts")], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let demoLog = "";
const ready = new Promise<boolean>((resolve) => {
  const seen = (d: Buffer) => {
    demoLog += d;
    if (demoLog.includes("Demo agentbook ready")) resolve(true);
  };
  demo.stdout.on("data", seen);
  demo.stderr.on("data", seen);
  demo.on("exit", () => resolve(false));
  setTimeout(() => resolve(false), 150e3);
});

/* ---------- Chrome, over the DevTools protocol ---------- */

// What Chrome sends: an answer (id, result) or an event (method, params), from a tab when it has a sessionId.
type Msg = { id?: number; method?: string; sessionId?: string; params?: Json; result?: Json; error?: { message: string } };
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-page-chrome-"));
// Use classic scrollbars even on a Mac with a trackpad so a visible track takes up measurable space.
// Each tab is a window of its own, all in one spot, and on a Mac Chrome can count one as covered by the others and hide
// it, more often on a busy machine. A hidden tab's clicks wait 5 s or never land, and WebAuthn refuses it ("the page
// does not have focus"): the passkey check failed 2 runs in 4 with four of this test running at once, and none in 12
// with --disable-backgrounding-occluded-windows.
const chrome: ChildProcess = spawnTied(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--disable-features=MacAppCodeSignClone,OverlayScrollbar", "--disable-backgrounding-occluded-windows", "--no-first-run", "--no-default-browser-check", "--mute-audio", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", detached: true });
function stopAll(): void {
  for (const p of [chrome, demo]) {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {}
  }
}
process.on("exit", () => {
  stopAll();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {} // Chrome still writing to it as it stops
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));

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
const listeners = new Map<string, (m: Msg) => void>();
ws.addEventListener("message", (e) => {
  const m: Msg = JSON.parse(String(e.data));
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)!(m);
    waiting.delete(m.id);
  } else if (m.sessionId) listeners.get(m.sessionId)?.(m);
});
const send = (method: string, params: object = {}, sessionId?: string): Promise<Msg> =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// What each tab is ready to tell once a screen has settled: fetches still out, and when the page last changed. And
// what it posted (__posts: where, what, and the answer's status), for the buttons that send.
const TRACKER = `(() => {
  window.__out = 0;
  window.__posts = [];
  const f = window.fetch;
  window.fetch = (...a) => {
    window.__out++;
    const o = a[1] || {};
    const sent = o.method === 'POST' ? { url: String(a[0]), body: typeof o.body === 'string' ? o.body : '', status: 0 } : null;
    if (sent) window.__posts.push(sent);
    return f(...a).then((r) => { if (sent) sent.status = r.status; return r; }).finally(() => window.__out--);
  };
  window.__changed = performance.now();
  new MutationObserver(() => { window.__changed = performance.now(); }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})();`;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

// A tab: a desktop, or an iPhone (its size, touch, and Safari's user agent, which the page looks at when it starts).
// Each in a window of its own: two tabs in one window leave the one behind undrawn, and every click there then waited
// 5 s on its mouse move (100 of the 170 s this took).
async function tab(kind: "desktop" | "iphone") {
  const { targetId } = (await send("Target.createTarget", { url: "about:blank", newWindow: true })).result;
  const sid: string = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
  const errors: string[] = [];
  listeners.set(sid, (m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description ?? "").join(" "));
  });
  const cdp = (method: string, params: object = {}) => send(method, params, sid);
  const js = async <T = unknown>(expression: string): Promise<T> => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value as T;
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: TRACKER });
  if (kind === "iphone") {
    await cdp("Emulation.setUserAgentOverride", { userAgent: IPHONE, platform: "iPhone" });
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  } else await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // Until nothing is being fetched and the page hasn't changed for a moment (clocks tick each second), or 8 s. An error
  // ends it sooner: React takes the whole page down on one, and it won't draw again.
  const settle = async () => {
    const end = Date.now() + 8000;
    await sleep(150);
    while (Date.now() < end && !errors.length && !(await js<boolean>(`window.__out === 0 && performance.now() - window.__changed > 300 && !!document.querySelector('#root')?.children.length`))) await sleep(100);
  };
  const load = async (url: string) => {
    await cdp("Page.navigate", { url: "about:blank" }); // or one address to another with only its # changed wouldn't load anything
    await cdp("Page.navigate", { url });
    await settle();
  };
  // Another screen the way a link opens one: the address after the # changes, the page stays. After a screen that
  // broke, the page loads afresh at it instead, so one broken screen fails alone.
  let broken = false;
  const open = async (hash: string) => {
    if (broken) await load(`${BASE}/${hash}`);
    else {
      await js(`location.hash = ${JSON.stringify(hash.slice(1))}`);
      await settle();
    }
    broken = !!errors.length || !(await js<number>(`(document.querySelector('#root')?.innerText || '').trim().length`));
  };
  // A click as a person makes one, with the mouse, at the middle of what the selector finds: not el.click(), which
  // runs the button's default (a form's submit) before React draws again, so it can pass where a real click fails.
  const click = async (selector: string): Promise<boolean> => {
    const at = await js<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!at) return false;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    await sleep(150);
    return true;
  };
  // Words typed into the box the selector finds (the reply box is contenteditable).
  const type = async (selector: string, text: string) => {
    await click(selector);
    await cdp("Input.insertText", { text });
  };
  return { kind, errors, js, load, open, click, type, cdp };
}

check(await ready, `the demo starts${(await ready) ? "" : `:\n${demoLog.slice(-2000)}`}`);
if (!(await ready)) process.exit(1);
const desktop = await tab("desktop");
const iphone = await tab("iphone");
await desktop.load(`${BASE}/`);
const signedIn = await desktop.js<number>(`fetch('/api/auth/test-person', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo' }) }).then((r) => r.status)`);
check(signedIn === 200, `signs in to the demo (${signedIn})`);

/* ---------- the viewport ---------- */

const viewport = (t: Awaited<ReturnType<typeof tab>>) => t.js<string>(`document.querySelector('meta[name="viewport"]').content`);
await desktop.load(`${BASE}/`);
await iphone.load(`${BASE}/`);
check(/maximum-scale=1\b/.test(await viewport(iphone)), `an iPhone gets maximum-scale=1 (${await viewport(iphone)})`);
check(!/maximum-scale/.test(await viewport(desktop)), "anything else can zoom");

/* ---------- scrolling the feed ---------- */

const nativeTrack = await desktop.js<number>(`(() => {
  const box = document.createElement('div');
  box.style.cssText = 'position: fixed; width: 60px; height: 60px; overflow-y: scroll';
  document.body.append(box);
  const gutter = box.offsetWidth - box.clientWidth;
  box.remove();
  return gutter;
})()`);
check(nativeTrack > 0, `Chrome reserves space for a native scrollbar (${nativeTrack}px)`);
// At this height the demo has more navigation rows and tasks than either sidebar can show.
await desktop.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false });
for (const [label, selector] of [["navigation sidebar", ".shell > aside:first-child"], ["Tasks sidebar", ".shell > .rail"], ["feed", "html"]]) {
  const el = `document.querySelector(${JSON.stringify(selector)})`;
  const { x, y, gutter } = await desktop.js<{ x: number; y: number; gutter: number }>(`(() => {
    const scroller = ${el}, page = scroller === document.scrollingElement;
    const box = (page ? document.querySelector('.shell > main') : scroller).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + 100, gutter: (page ? innerWidth : scroller.offsetWidth) - scroller.clientWidth };
  })()`);
  check(gutter === 0, `the ${label} has no scrollbar track (${gutter}px)`);
  await desktop.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 80 });
  for (let i = 0; i < 20 && !(await desktop.js<number>(`${el}.scrollTop`)); i++) await sleep(50);
  check(await desktop.js<number>(`${el}.scrollTop`) > 0, `the ${label} scrolls with the wheel`);
}
await desktop.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

/* ---------- machine enrollment and passkeys ---------- */
await desktop.open("#/people/demo/machines");
check(await desktop.click('a[href$="?open=machine"]') && await desktop.js(`document.querySelector('.connect-card pre')?.textContent === 'agentbook login'`), "Add a machine opens account enrollment");
await desktop.click(".connect-card button[aria-expanded]");
check(await desktop.js(`document.querySelector('.connect-card input[name="code"]') && document.querySelector('.connect-card pre').textContent.startsWith('agentbook-cli login ')`), "direct page pairing still has its command and code entry");
await desktop.open("#/people/demo/settings/passkeys");
check(await desktop.js(`!!document.querySelector('#set-passkeys') && document.querySelector('.set-nav .is-on')?.textContent.includes('Passkeys')`), "a signing error can link directly to passkey management");

// Use localhost for WebAuthn. The demo's numeric loopback address cannot be a passkey RP.
const keyPage = await tab("desktop");
const local = `http://localhost:${PORT}`;
await keyPage.load(local);
await keyPage.js(`fetch('/api/auth/test-person', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo' }) }).then(r => r.status)`);
await keyPage.load(local + "/#/people/demo/settings/passkeys");
await keyPage.cdp("WebAuthn.enable");
await keyPage.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await keyPage.click("#set-passkeys .set-foot button");
const keyAppeared = await keyPage.js(`(async () => { for (let i = 0; i < 50 && !document.querySelector('.passkey-card'); i++) await new Promise(r => setTimeout(r, 100)); return !!document.querySelector('.passkey-card'); })()`);
check(keyAppeared, "Settings adds a passkey through Chrome WebAuthn");
if (keyAppeared) {
  await keyPage.click(".passkey-card .set-row > button");
  await keyPage.js(`document.querySelector('input[aria-label="Passkey name"]').select()`);
  await keyPage.cdp("Input.insertText", { text: "Backup phone" });
  await keyPage.click(".passkey-card form button[type=submit]");
  check(await keyPage.js(`document.querySelector('.passkey-card b')?.textContent === 'Backup phone'`), "Settings renames the registered key");
  await keyPage.click(".passkey-card .set-row > button:last-child");
  await keyPage.click(".passkey-card .set-row > button:last-child");
  check(await keyPage.js(`!document.querySelector('.passkey-card')`), "Settings removes the passkey after confirmation");
}
await keyPage.cdp("WebAuthn.disable");

/* ---------- machine and cloud agent setup ---------- */

await desktop.open("#/people/demo/agents");
const laptopGroup = '.machine-card[aria-label="laptop"]';
const otherGroup = '.machine-card:not([aria-label="laptop"])';
const laptopFold = laptopGroup + ' button[aria-expanded]';
const laptopAdd = laptopGroup + ' button[aria-label="Add agent on laptop"]';
check(await desktop.js(`document.querySelector('${laptopFold}')?.getAttribute('aria-expanded') === 'true' && document.querySelector('${laptopAdd}')?.getAttribute('aria-haspopup') === 'dialog'`), "each machine starts expanded with its own add button");
check(await desktop.js(`![...document.querySelectorAll('nav[aria-label=Profile] a')].some(a => ['Machines', 'Workspaces', 'Routines'].includes(a.textContent.trim())) && !!document.querySelector('.machine-agents-table') && !!document.querySelector('.machine-routines-table') && !!document.querySelector('.machine-workspaces-table')`), "Agents replaces the three old tabs and uses tables for each subsection");
await desktop.click(laptopFold);
check(await desktop.js(`document.querySelector('${laptopFold}')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('${laptopGroup} .machine-card-body') && !!document.querySelector('${otherGroup} .machine-card-body')`), "collapsing one machine hides only its subsections");
await desktop.click(laptopFold);
check(await desktop.js(`!!document.querySelector('${laptopGroup} .machine-card-body')`), "the laptop expands again");
await desktop.click(laptopAdd);
check(await desktop.js(`location.hash === '#/people/demo/agents' && document.querySelector('dialog[open]')?.getAttribute('aria-label') === 'Add agent on laptop' && !!document.querySelector('dialog[open] .new-agent')`), "Add agent opens the laptop's add-only picker in place");
await desktop.click('dialog[open] button[aria-label="Close"]');
check(await desktop.js(`!document.querySelector('dialog[open]') && document.activeElement === document.querySelector('${laptopAdd}')`), "closing returns focus to Add agent");
const hostGroup = '.machine-card[aria-label="hervalm5"]';
check(await desktop.js(`![...document.querySelectorAll('.machine-card a, .machine-card button')].some(el => el.textContent.trim() === 'Manage')`), "machine cards no longer show a Manage button");
check(await desktop.js(`(() => { const t = document.querySelector('${hostGroup} .machine-meta')?.textContent || ''; return t.includes('OS') && t.includes('Plugin'); })()`), "the machine header shows OS and plugin version");
check(await desktop.js(`!!document.querySelector('${hostGroup} .machine-counters .chip') && !!document.querySelector('${hostGroup} .machine-status-chips .chip')`), "inline status counters appear in the machine header and agent rows");
const codexRow = `${hostGroup} .machine-agents-table tbody tr:nth-child(2)`;
const codexName = await desktop.js<string>(`document.querySelector('${codexRow} b')?.textContent`);
await desktop.click(`${codexRow} .ag-rename-btn`);
check(await desktop.js(`document.activeElement === document.querySelector('${codexRow} .ag-rename input') && document.activeElement.value === ${JSON.stringify(codexName)}`), "an agent's pencil on Agents opens its name in a box, in place");
await desktop.js(`document.activeElement.select()`);
await desktop.cdp("Input.insertText", { text: "Codex for reviews" });
await desktop.click(`${codexRow} .ag-rename button[type=submit]`);
check(await desktop.js(`(async () => { for (let i = 0; i < 40; i++) { if (document.querySelector('${codexRow} a.machine-agent-name b')?.textContent === 'Codex for reviews') return true; await new Promise(r => setTimeout(r, 50)); } return false; })()`), "saving renames it there");
await desktop.js(`(() => { const id = decodeURIComponent(document.querySelector('${codexRow} a.machine-agent-name').hash.split('/')[2]); return fetch('/api/agents/' + encodeURIComponent(id) + '/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(codexName)} }) }).then(r => r.ok); })()`);
const hostAgentsToggle = `${hostGroup} button[aria-controls="sec-hervalm5-agents"]`;
await desktop.click(hostAgentsToggle);
check(await desktop.js(`document.querySelector('${hostAgentsToggle}')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('#sec-hervalm5-agents') && !!document.querySelector('#sec-hervalm5-routines')`), "individual sections collapse without hiding sibling sections");
await desktop.click(hostAgentsToggle);
const hostDetailsToggle = `${hostGroup} button[aria-controls="sec-hervalm5-details"]`;
check(await desktop.js(`document.querySelector('${hostDetailsToggle}')?.getAttribute('aria-expanded') === 'false'`), "Details & access starts collapsed");
await desktop.click(hostDetailsToggle);
const detailsLoaded = await desktop.js<boolean>(`(async () => { for (let i = 0; i < 40 && !document.querySelector('${hostGroup} .machine-details'); i++) await new Promise(r => setTimeout(r, 50)); return !!document.querySelector('${hostGroup} .machine-details'); })()`);
check(detailsLoaded, "expanding Details & access loads inlined machine details");
const archivedId = await desktop.js<string | null>(`(async () => {
  const res = await fetch('/api/routines', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Archived smoke check', prompt: 'Check status', agent: 'claude', schedule: 'manual' }) });
  const r = await res.json();
  if (!r.id) return null;
  await fetch('/api/routines/' + encodeURIComponent(r.id) + '/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return r.id;
})()`);
if (archivedId) {
  await desktop.open("#/people/demo/agents");
  const toggleShown = await desktop.js<boolean>(`(async () => { for (let i = 0; i < 40 && !document.querySelector('${hostGroup} .machine-archived-toggle'); i++) await new Promise(r => setTimeout(r, 100)); return !!document.querySelector('${hostGroup} .machine-archived-toggle'); })()`);
  check(toggleShown, "archived routines appear behind Show archived inside their machine's Routines section");
  if (toggleShown) {
    await desktop.click(`${hostGroup} .machine-archived-toggle`);
    check(await desktop.js(`document.querySelector('${hostGroup} .machine-archived-panel')?.textContent.includes('Archived smoke check')`), "clicking Show archived reveals that machine's archived routines with Restore");
  }
}
await desktop.open("#/machines/hervalm5");
check(await desktop.js(`location.hash === '#/people/demo/agents?machine=hervalm5' && document.querySelector('${hostDetailsToggle}')?.getAttribute('aria-expanded') === 'true'`), "old #/machines/:name links redirect to that machine on the Agents tab");

await desktop.open("#/people/demo/workspaces");
const addWs = '.machine-card[aria-label="laptop"] button[aria-label="Add workspace on laptop"]';
await desktop.click(addWs);
check(await desktop.js(`location.hash === '#/people/demo/workspaces' && document.querySelector('dialog[open]')?.getAttribute('aria-label') === 'Add a workspace on laptop'`), "the old Workspaces link opens Agents and its existing laptop-scoped workspace dialog");
await desktop.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await desktop.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
check(await desktop.js(`!document.querySelector('dialog[open]') && document.activeElement === document.querySelector('${addWs}')`), "Escape returns to the same workspace button");

await desktop.open("#/people/demo/settings/agents");
const machineKinds = await desktop.js<string[]>(`[...document.querySelectorAll('.new-agent-types b')].map((b) => b.textContent)`);
check(machineKinds.includes("Codex") && machineKinds.includes("Claude Code") && !machineKinds.includes("Devin") && !machineKinds.includes("OpenClaw"), "the picker keeps repeatable local types and excludes an already connected OpenClaw");
check(await desktop.js(`location.hash === '#/people/demo/agents?open=add' && !!document.querySelector('dialog[open] .new-agent')`), "the old settings link opens the add-only picker on Agents");
await desktop.click('.new-agent-types button[aria-label="Add Claude Code agent"]');
check(await desktop.js(`!!document.querySelector('#new-agent-directory') && document.querySelector('.new-agent-form button')?.textContent === 'Create agent'`), "another Claude Code agent can have its own optional config directory");
await desktop.click('dialog[open] button[aria-label="Close"]');
await desktop.open("#/people/demo/settings/agents?open=devin");
const cloudEditor = "#set-cloud-agents .is-open";
check(await desktop.js(`location.hash === '#/people/demo/agents?open=devin' && !!document.querySelector('${cloudEditor} input[name=key]')`), "a saved Devin setup link opens its cloud API key form");
await desktop.open("#/people/demo/settings/cloud-agents?open=devin&machine=laptop");
check(await desktop.js(`document.querySelector('${cloudEditor} select')?.value === 'laptop' && document.querySelector('${cloudEditor}')?.innerText.includes('offline') && !document.querySelector('${cloudEditor} input[name=key]')`), "a provider profile can target its offline credential host without offering a write");

await desktop.open("#/people/demo/settings");
check(!await desktop.js(`document.querySelector('.set-nav a[href*="settings/agents"], .set-nav a[href*="settings/cloud-agents"]')`), "Settings no longer offers agent setup tabs");

/* ---------- the screens ---------- */

const HUBS = ["#/", "#/agents", "#/tasks", "#/worktrees", "#/pages", "#/dashboards", "#/notes", "#/groups", "#/routines", "#/connectors", "#/people", "#/people/demo", "#/people/demo/settings", "#/people/demo/machines", "#/agents/claude", "#/agents/claude/skills", "#/threads/wren-0000-4000-8000-demo-wren", "#/threads/avocet-0000-4000-8000-demo-avocet", "#/machines/hervalm5", "#/agents/openclaw-main"];
// An address's kind: its ids (anything with a digit in it) and the name after the first part stood in for.
const kindOf = (href: string) => href.replace(/\/[^/]*[0-9][^/]*/g, "/:id").replace(/^(#\/[a-z-]+\/)[^/]+/, "$1:x");
const screens = [...HUBS];
const kinds = new Map<string, number>();
for (const h of HUBS) {
  desktop.errors.length = 0;
  await desktop.open(h);
  const hrefs = await desktop.js<string[]>(`[...document.querySelectorAll('a[href^="#/"]')].map((a) => a.getAttribute('href').replace(/\\?.*$/, ''))`);
  for (const href of hrefs || []) {
    if (screens.includes(href) || /\/(new|edit)$|logout|signout/.test(href)) continue;
    const k = kindOf(href);
    if ((kinds.get(k) || 0) >= 2) continue;
    kinds.set(k, (kinds.get(k) || 0) + 1);
    screens.push(href);
  }
}
check(screens.length >= 60, `the main screens link to the rest (${screens.length} screens, at least 60)`);

type Seen = { text: number; errors: string[]; wide?: { page: number; screen: number; what: string } };
async function look(t: Awaited<ReturnType<typeof tab>>, h: string): Promise<Seen> {
  t.errors.length = 0;
  await t.open(h);
  const text = await t.js<number>(`(document.querySelector('#root')?.innerText || '').trim().length`);
  // Sideways: the page wider than the screen, and the widest thing that sticks out past its right edge.
  const wide = t.kind === "iphone" ? await t.js<Seen["wide"]>(`(() => {
    // The layout's width, not innerWidth: a phone zoomed out to fit a page too wide (as one without maximum-scale=1
    // does) has an innerWidth as wide as the page.
    const page = document.documentElement.scrollWidth, screen = document.documentElement.clientWidth;
    if (page <= screen + 1) return undefined;
    // It, as the two above it and it would be written in CSS, and the start of what it says.
    const name = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
    // Not one cut off inside a box that fits (overflow: hidden or a scroller), nor one in a drawer off the screen
    // (position: fixed): neither widens the page.
    const apart = (el) => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const st = getComputedStyle(a);
        if (st.position === 'fixed') return true;
        if (a !== el && st.overflowX !== 'visible' && a.getBoundingClientRect().right <= screen + 1) return true;
      }
      return false;
    };
    let what = '', most = 0;
    for (const el of document.querySelectorAll('#root *')) {
      const r = el.getBoundingClientRect();
      if (r.right > screen + 1 && r.width > most && !apart(el)) {
        most = r.width;
        const path = [el.parentElement?.parentElement, el.parentElement, el].filter(Boolean).map(name).join(' > ');
        what = path + ': "' + (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) + '"';
      }
    }
    return { page, screen, what };
  })()`) : undefined;
  return { text, errors: [...t.errors], wide };
}

const bad: string[] = [];
const started = Date.now();
for (const h of screens) {
  const [d, p] = await Promise.all([look(desktop, h), look(iphone, h)]);
  for (const [who, s] of [["desktop", d], ["iPhone", p]] as const) {
    if (!s.text) bad.push(`${h} on the ${who}: draws nothing`);
    for (const e of s.errors) bad.push(`${h} on the ${who}: ${String(e).split("\n")[0].slice(0, 200)}`);
    if (s.wide) bad.push(`${h} on the iPhone: ${s.wide.page}px wide on a ${s.wide.screen}px screen (${s.wide.what || "?"})`);
  }
}
for (const b of bad) console.log(`      ${b}`);
check(!bad.length, `${screens.length} screens, on a desktop and an iPhone, each draw, with no error and no sideways scroll (${Math.round((Date.now() - started) / 1000)}s)`);

/* ---------- the feed with long filenames and header chips ---------- */

// The demo's short names fit while real cards didn't: a change line's implicit grid column took a long filename's
// minimum width, and header chips could be wider than the space beside the avatar. Supply those records through
// the page's usual queries, so the real card components draw them, without changing what the demo keeps.
const LONG_FILE = "specs/2026_11_20_the_main_feed_keeps_long_filenames_and_linked_task_names_inside_the_phone_viewport.md";
const LONG_TASK = "Review the mobile feed with long metadata and attachments before the next release";
await iphone.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0]);
    if (!response.ok || !/^\\/api\\/q\\/(feed|side)(?:\\?|$)/.test(url)) return response;
    const q = await response.json();
    for (const [key, record] of Object.entries(q.records || {})) {
      if (key.startsWith('task:')) record.text = ${JSON.stringify(LONG_TASK)};
      if (key.startsWith('thread:') && url.startsWith('/api/q/feed') && !record.talk) {
        record.repo = 'github.com-example-team-responsive-feed';
        record.updates = [...(record.updates || []), {
          at: new Date().toISOString(), text: 'Changed ' + ${JSON.stringify(LONG_FILE)} + ', +74', link: null,
          changes: { turn: 9999, files: 1, add: 74, del: 0, last: 'viewport-regression',
            tiles: [{ path: ${JSON.stringify(LONG_FILE)}, add: 74, del: 0 }],
            reach: { folders: [], changed: 1, importers: 0, untested: 0 } }
        }];
      }
    }
    return new Response(JSON.stringify(q), { status: response.status, headers: response.headers });
  };
})();` });
await iphone.load(`${BASE}/`);
check(await iphone.js<boolean>(`[...document.querySelectorAll('.chg-line.has-tiles a')].some((a) => a.textContent.includes(${JSON.stringify(LONG_FILE)})) && [...document.querySelectorAll('.post-meta .chip--set')].some((a) => a.textContent.includes(${JSON.stringify(LONG_TASK)}))`), "the feed draws the long filename and linked task fixtures");
const overflow: string[] = [];
for (const width of [320, 360, 375, 390, 414, 440]) {
  await iphone.cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 3, mobile: true });
  const seen = await look(iphone, "#/");
  if (seen.wide) overflow.push(`${width}px: ${seen.wide.page}px (${seen.wide.what})`);
  overflow.push(...seen.errors);
}
check(!overflow.length, `the feed stays within 320–440px phone viewports with long filenames and chips${overflow.length ? `: ${overflow.join('; ')}` : ""}`);
await iphone.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

/* ---------- sending while it works ---------- */
// quail is working, so its box's send button queues, and its caret's menu has Send now and Send on the side. Each
// one picked posts the message: now (no queue), and on the side (side: true).
const QUAIL = "quail-0000-4000-8000-demo-quail";
await desktop.load(`${BASE}/#/threads/${QUAIL}`);
type Post = { url: string; body: string; status: number };
async function sendBy(how: "now" | "side", text: string): Promise<Post | undefined> {
  await desktop.js(`window.__posts.length = 0`);
  await desktop.type(".cmt-form .text-box [contenteditable]", text);
  const opened = (await desktop.click(".cmt-form [data-send-menu]")) && (await desktop.click(`.q-menu [data-how="${how}"]`));
  if (!opened) return undefined;
  for (let i = 0; i < 30; i++) {
    const posts = await desktop.js<Post[]>(`window.__posts`);
    const sent = posts.find((p) => p.url.includes(`/api/sessions/${QUAIL}/messages`) && p.body.includes(text) && p.status);
    if (sent) return sent;
    await sleep(100);
  }
  return undefined;
}
const now = await sendBy("now", "Send this one now");
check(now?.status === 200 && !JSON.parse(now.body).queue, `Send now, from the send button's menu, sends it at once (${now ? `${now.status} ${now.body}` : "nothing sent"})`);
const side = await sendBy("side", "Try it on the side");
check(side && JSON.parse(side.body).side === true, `Send on the side, from the menu, sends it on the side (${side ? `${side.status} ${side.body}` : "nothing sent"})`);

/* ---------- @ a name agents on two machines have ---------- */
// This machine's Claude and the laptop's: @Claude in a thread neither is in brings in one of them, not both.
await desktop.load(`${BASE}/#/threads/th-live`);
await desktop.type(".cmt-form .text-box [contenteditable]", "@Claude your take?");
const namesakeHint = await desktop.js<string>(`document.querySelector('.cmt-form .to-hint')?.textContent || ''`);
check(/\bClaude joins this thread\b/.test(namesakeHint) && !/Claude and Claude/.test(namesakeHint), `@Claude brings in one Claude, not each machine's (${namesakeHint})`);
await desktop.js(`(() => { const el = document.querySelector('.cmt-form .text-box [contenteditable]'); el.innerHTML = ''; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); })()`);

/* ---------- an explicit reply recipient ---------- */
// Join a real demo Codex thread to the busy Claude thread. Plain replies must follow the picker, and its state
// (idle vs working) follows that recipient too. These exercise the actual form and outgoing API requests.
const joined = await desktop.js<number>(`fetch('/api/sessions/${QUAIL}/guests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread: 'th-live', text: 'Please review this with me' }) }).then((r) => r.status)`);
check(joined === 200, `a second agent joins the thread (${joined})`);
// The stand-in Codex asks its color question when the conversation note contains "ask". Answer it so this
// fixture is idle, while Claude's fixture keeps working.
for (let i = 0; i < 40; i++) {
  const idle = await desktop.js<boolean>(`fetch('/api/sessions/th-live').then((r) => r.json()).then(async (s) => {
    for (const q of s.questions || []) if (!q.answered) await fetch('/api/questions/' + encodeURIComponent(q.id) + '/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'Blue' }) });
    return !s.busy && s.messages?.some((m) => m.from === 'agent' && m.text === 'You picked Blue');
  })`);
  if (idle) break;
  await sleep(150);
}
await desktop.load(`${BASE}/#/threads/${QUAIL}?messages=all`);
const picker = '.cmt-form select[aria-label="Reply recipient"]';
const editor = '.cmt-form .text-box [contenteditable]';
const chosen = () => desktop.js<string>(`document.querySelector(${JSON.stringify(picker)})?.value`);
const choose = async (id: string) => {
  await desktop.js(`(() => { const el = document.querySelector(${JSON.stringify(picker)}); el.value = ${JSON.stringify(id)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
};
const submitReply = async (text: string) => {
  await desktop.js(`window.__posts.length = 0`);
  await desktop.click('.cmt-form button[type="submit"]:not([data-how="side"])');
  for (let i = 0; i < 40; i++) {
    const sent = (await desktop.js<Post[]>(`window.__posts`)).find((p) => /\/messages$/.test(p.url) && p.body.includes(text) && p.status);
    if (sent) return sent;
    await sleep(100);
  }
};
const sentReply = async (text: string) => {
  await desktop.type(editor, text);
  return submitReply(text);
};
check(await chosen() === QUAIL, "the composer names its current recipient when a second agent joins");
await choose("th-live");
check(await desktop.js<boolean>(`!!document.querySelector('.cmt-form button[aria-label="Send to Codex"]') && !document.querySelector('.cmt-form .q-split')`), "choosing idle Codex changes the send label and does not enqueue for busy Claude");
const toGuest = await sentReply("Only Codex should get this");
check(toGuest?.url === "/api/sessions/th-live/messages" && toGuest.status === 200 && !JSON.parse(toGuest.body).queue, `a plain reply goes only to the selected guest (${toGuest ? `${toGuest.status} ${toGuest.url} ${toGuest.body}` : "nothing sent"})`);
await desktop.open("#/agents");
await desktop.open(`#/threads/${QUAIL}?messages=all`);
check(await chosen() === "th-live", "the recipient selection survives leaving and returning to the thread");
check(await desktop.click('[data-reply-to="th-live"]') && await chosen() === "th-live", "Reply to Codex selects the guest's session");
check(await desktop.click(`[data-reply-to="${QUAIL}"]`) && await chosen() === QUAIL, "Reply to Claude selects the message's agent");
await choose("th-live");
await desktop.type(editor, "@Claude explicit mention");
check(await desktop.js<boolean>(`!document.querySelector(${JSON.stringify(picker)}) && document.querySelector('.reply-recipient')?.textContent.includes('Claude') && !!document.querySelector('.cmt-form button[aria-label="Enqueue for Claude"]')`), "an explicit @mention shows its actual recipient and queue state");
const toHost = await submitReply("@Claude explicit mention");
check(toHost?.url === `/api/sessions/${QUAIL}/messages` && toHost.status === 200 && await desktop.js<boolean>(`!window.__posts.some((p) => p.url.endsWith('/guests'))`), "@Claude addresses the host without also bringing in another machine's Claude");
check(await chosen() === "th-live", "after sending an @mention, the composer restores the selected recipient");
// The command lookup and its request must use Codex; @Claude in its arguments is text, not another address.
const cmd = await sentReply("/review @Claude inspect this");
check(cmd?.url === "/api/sessions/th-live/messages" && JSON.parse(cmd.body).command === "review", "slash commands run on the selected recipient, including arguments with @names");
await iphone.load(`${BASE}/#/threads/${QUAIL}`);
const replyOverflow: string[] = [];
for (const width of [320, 390]) {
  await iphone.cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 3, mobile: true });
  const seen = await look(iphone, `#/threads/${QUAIL}`);
  if (seen.wide) replyOverflow.push(`${width}px: ${seen.wide.what}`);
  replyOverflow.push(...seen.errors);
}
check(!replyOverflow.length && await iphone.js<boolean>(`!!document.querySelector(${JSON.stringify(picker)})`), `the recipient control fits 320px and 390px phone screens${replyOverflow.length ? `: ${replyOverflow.join('; ')}` : ""}`);
await iphone.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await sleep(500);
await desktop.type(editor, "Keep this draft for Codex");
const removed = await desktop.js<number>(`fetch('/api/sessions/${QUAIL}/guests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remove: 'th-live' }) }).then((r) => r.status)`);
await desktop.open("#/agents");
await desktop.open(`#/threads/${QUAIL}`);
check(removed === 200 && await chosen() === "" && await desktop.js<boolean>(`document.querySelector('.cmt-form button.send-to-agent')?.disabled && document.querySelector(${JSON.stringify(editor)})?.textContent.includes('Keep this draft for Codex')`), "if the selected guest leaves, the draft stays and sending waits for another recipient");
await choose(QUAIL);
check(await chosen() === QUAIL && await desktop.js<boolean>(`!document.querySelector('.cmt-form button[type="submit"]:not([data-how="side"])')?.disabled`), "choosing another recipient makes the preserved draft sendable again");

// A screen opened from its address, not from another one: the thread page, on the iPhone.
iphone.errors.length = 0;
await iphone.load(`${BASE}/#/threads/wren-0000-4000-8000-demo-wren`);
check((await iphone.js<number>(`(document.querySelector('#root')?.innerText || '').trim().length`)) > 0 && !iphone.errors.length, `a thread opened from its address draws, with no error${iphone.errors.length ? `: ${iphone.errors[0]}` : ""}`);

/* ---------- what a turn attached, on its reply ---------- */
// A reply that says "attached to the thread" has a chip for each thing its turn attached (ab_attach), and the chip
// opens it under the reply. Before, it was only at the end of the thread's Results, which start folded.
await desktop.load(`${BASE}/#/threads/plover-0000-4000-8000-demo-plover`);
await sleep(500);
const attChips = await desktop.js<string[]>(`[...document.querySelectorAll('.cmt-bub .rc-thing[data-att]')].map((b) => b.dataset.att).sort()`);
const attOpen = () => desktop.js<number>(`document.querySelectorAll('.cmt-bub > .att').length`);
const attBefore = await attOpen();
await desktop.click('.cmt-bub .rc-thing[data-att="requests"]');
await sleep(250);
const attAfter = await desktop.js<boolean>(`document.querySelector('.cmt-bub > .att .att-title')?.textContent === 'Requests by service, k per day' && document.querySelector('.cmt-bub .rc-thing[data-att="requests"]').getAttribute('aria-expanded') === 'true'`);
await desktop.click('.cmt-bub .rc-thing[data-att="requests"]');
await sleep(250);
check(attChips.join() === "p95-vs-traffic,requests" && attBefore === 0 && attAfter && (await attOpen()) === 0, `a reply has a chip for each thing its turn attached, which opens it under the reply and closes it again (chips: ${attChips.join(", ") || "none"}; open before: ${attBefore}; opened: ${attAfter})`);

/* ---------- the / list ---------- */
// Typed a key at a time, a thread's box shows one / list, which follows what's typed, and Esc takes it away. With the
// list and the line under the box on one React key (216772d), each key left the list before it on the page for good.
const press = (key: string, extra: object = {}) => desktop.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, ...extra }).then(() => desktop.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, ...extra }));
const lists = () => desktop.js<number>(`document.querySelectorAll('.cmd-pop').length`);
await desktop.load(`${BASE}/#/threads/wren-0000-4000-8000-demo-wren`);
await desktop.click(editor);
const listsTyping: number[] = [];
for (const k of "/mod") {
  await press(k, { text: k });
  await sleep(250);
  listsTyping.push(await lists());
}
await press("Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(250);
const listsAfter = await lists();
check(listsTyping.every((n) => n === 1) && listsAfter === 0, `typing /mod a key at a time shows one / list, and Esc closes it (lists after each key: ${listsTyping.join(", ")}; after Esc: ${listsAfter})`);

/* ---------- the composer keeps Full access ---------- */
// Full access picked in the composer is kept for its agent, as the other modes are. It used to be for one thread
// only, so it went back to Auto on the next post and on a reload ("it doesnt stick, when creating posts").
const modeChip = `[data-launch] [data-pk$=":mode"] > button`;
const modeShown = (t = desktop) => t.js<string>(`document.querySelector(${JSON.stringify(modeChip)})?.textContent || ''`);
await desktop.load(`${BASE}/`);
const modeBefore = await modeShown();
const pickedFull = (await desktop.click(modeChip)) && (await desktop.click(`.pk-menu [data-pk-value="full"]`));
const fullNow = await modeShown();
await desktop.load(`${BASE}/`);
const fullAfter = await modeShown();
check(pickedFull && /Full access/.test(fullNow) && /Full access/.test(fullAfter), `Full access picked in the composer is still picked after a reload (before: ${modeBefore || "no chip"}; picked: ${fullNow || "nothing"}; after: ${fullAfter || "nothing"})`);

// The same browser, with a Codex draft open in a second tab. Seed the format used before modes had their own keys.
await desktop.js(`localStorage.removeItem('agentbook.compose.mode.codex'); localStorage.setItem('agentbook.compose', JSON.stringify({ modePick: { codex: 'plan' } }))`);
const codexWall = `${BASE}/#/agents/codex`;
await desktop.load(codexWall);
await iphone.load(codexWall);
check(await modeShown(iphone) === "Plan", "the Codex composer keeps a previously saved Plan preference");
await iphone.type("[data-launch] [contenteditable]", "Test the mode of this Codex thread");
await desktop.click(modeChip);
await desktop.click('.pk-menu [data-pk-value="auto"]');
check(await modeShown(iphone) === "Auto", "selecting Auto updates an already-open Codex composer with a draft");
await iphone.click("[data-launch] [data-start]");
const launchMode = await iphone.js<string>(`JSON.parse(window.__posts.find(p => p.url.endsWith('/api/launch'))?.body || '{}').mode`);
check(launchMode === "auto", "the older tab sends Auto with the thread it starts");
// A tab still running the previous page can save its stale preferences before it reloads.
await iphone.js(`localStorage.setItem('agentbook.compose', JSON.stringify({ modePick: { codex: 'plan' } }))`);
await desktop.load(codexWall);
check(await modeShown() === "Auto", "a stale tab saving Plan with its other picks can't undo the explicit Auto choice on reload");

/* ---------- guest launches use the invited agent's saved mode ---------- */
const modeTalk = await desktop.js<string>(`fetch('/api/talks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Check the guest launch mode' }) }).then(r => r.json()).then(r => r.id)`);
await desktop.load(`${BASE}/#/threads/${modeTalk}`);
await desktop.type(editor, "@Codex review this checkout");
await desktop.click('.cmt-form button[type="submit"]:not([data-how="side"])');
let talkLaunch: Post | undefined;
for (let i = 0; i < 40 && !talkLaunch; i++) {
  talkLaunch = (await desktop.js<Post[]>(`window.__posts`)).find((p) => p.url === `/api/talks/${modeTalk}/send` && p.status);
  if (!talkLaunch) await sleep(100);
}
check(talkLaunch?.status === 200 && JSON.parse(talkLaunch.body).agent === "codex" && JSON.parse(talkLaunch.body).mode === "auto", "@Codex in your own thread sends the saved Auto mode");

await desktop.load(codexWall);
await desktop.click(modeChip);
await desktop.click('.pk-menu [data-pk-value="full"]');
await desktop.load(`${BASE}/#/threads/${QUAIL}`);
await desktop.type(editor, "@Codex review this checkout too");
await desktop.click('.cmt-form button[type="submit"]:not([data-how="side"])');
let guestLaunch: Post | undefined;
for (let i = 0; i < 40 && !guestLaunch; i++) {
  guestLaunch = (await desktop.js<Post[]>(`window.__posts`)).find((p) => p.url === `/api/sessions/${QUAIL}/guests` && p.status);
  if (!guestLaunch) await sleep(100);
}
check(guestLaunch?.status === 200 && JSON.parse(guestLaunch.body).agent === "codex" && JSON.parse(guestLaunch.body).mode === "full", "@Codex in another agent's thread sends Codex's saved Full access mode");

ws.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
