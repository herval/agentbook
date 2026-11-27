#!/usr/bin/env node
// The real page recovers its Codex model selector when a startup catalog becomes available, without a reload.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, spawnTied, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const chromePath = process.env.CHROME || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : ["google-chrome", "chromium", "chromium-browser"].map((p) => spawnSync("which", [p], { encoding: "utf8" }).stdout.trim()).find(Boolean));
if (!chromePath || !fs.existsSync(chromePath)) {
  console.log("SKIP  no Chrome here (set CHROME to its path)");
  process.exit(process.env.GITHUB_ACTIONS ? 1 : 0);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-codex-picker-"));
const profile = path.join(home, "chrome");
const project = path.join(home, "project");
fs.mkdirSync(project);
const sock = path.join(home, "codex.sock");
const ready = path.join(home, "models-ready");
const port = testPort(5660);
const url = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: home, AGENTBOOK_HOME: home, AGENTBOOK_PORT: String(port), AGENTBOOK_CODEX_SOCK: sock, AGENTBOOK_CODEX_SYNC_MS: "200", AGENTBOOK_RUNTIME_MS: "200", AGENTBOOK_SNAPSHOT_MS: "200", AGENTBOOK_CODEX_BIN: path.join(TEST, "fake-codex-cli.ts"), AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_TERMINAL: "0" };
const fake = spawnTied(process.execPath, [path.join(TEST, "fake-codex.ts"), sock, path.join(home, "codex.jsonl"), project], { stdio: "ignore", env: { ...process.env, FAKE_CODEX_MODELS_READY: ready, FAKE_CODEX_EARLY_ACCOUNT: "1" } });
const server = spawnAgentbook({ env, stdio: "ignore" });
const chrome = spawnTied(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--disable-features=MacAppCodeSignClone", "--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", detached: true });
let ws: WebSocket;
process.on("exit", () => {
  ws?.close();
  server.kill();
  fake.kill();
  try { process.kill(-chrome.pid!, "SIGTERM"); } catch {}
});
let failures = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const until = async <T>(fn: () => T | Promise<T>, ms = 15000): Promise<T> => {
  let result: T;
  for (const end = Date.now() + ms; !(result = await fn()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  return result;
};

try {
  await until(async () => (await fetch(url + "/api/health").catch(() => null))?.ok);
  const owner = await fetch(url + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  const cookie = (owner.headers.get("set-cookie") || "").split(";")[0];
  const endpoint = await until(() => {
    try {
      const [port, endpoint] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
      return port && endpoint ? `ws://127.0.0.1:${port}${endpoint}` : null;
    } catch { return null; }
  });
  if (!endpoint) throw new Error("Headless Chrome didn't start");
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  let seq = 0;
  const waiting = new Map<number, (result: Json) => void>();
  ws.addEventListener("message", (e) => {
    const m: Json = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<Json> => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const targetId = (await send("Target.createTarget", { url: "about:blank" })).result.targetId;
  const sid = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
  const cdp = (method: string, params: object = {}) => send(method, params, sid);
  const js = async (expression: string) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const element = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
  const [name, ...value] = cookie.split("=");
  await cdp("Network.setCookie", { url, name, value: value.join("=") });
  await cdp("Page.navigate", { url: `${url}/#/threads/th-live` });
  check(await until(() => js('document.body.textContent.includes("About this thread")')), "the Codex thread opens while its catalog is unavailable");
  const selector = 'document.querySelector("select[data-model-pick=th-live]")';
  check(!(await js(`!!${selector}`)), "the unavailable catalog reproduces the missing selector");
  await js('localStorage.setItem("agentbook.compose", JSON.stringify({ agentPick: "codex" }))');
  const composerTarget = (await send("Target.createTarget", { url: `${url}/#/` })).result.targetId;
  const composerSid = (await send("Target.attachToTarget", { targetId: composerTarget, flatten: true })).result.sessionId;
  const composerJs = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, composerSid)).result?.result?.value;
  check(await until(() => composerJs(`!!${element('button[aria-label="Agent: Codex"]')}`)), "the new-thread composer has Codex selected before models arrive");
  const composerModel = element('.compose button[aria-label^="Model:"]');
  // The effort chip draws a meter rather than the effort's name; its label names it.
  const composerEffort = element('.compose button[aria-label^="Effort:"]');
  check(!(await composerJs(`!!${composerModel} || !!${composerEffort}`)), "the unavailable catalog reproduces both missing composer controls");
  fs.writeFileSync(ready, "ready");
  check(await until(() => composerJs(`!!${composerModel} && !!${composerEffort}`)), "the composer recovers model and effort controls without reloading");
  await composerJs(`${composerModel}.click()`);
  check(await until(() => composerJs('document.querySelectorAll("[role=menu][aria-label=Model] [data-pk-value]").length === 2')), "the composer lists the available models");
  await composerJs(`${element('[data-pk-value="gpt-6-luna"]')}.click()`);
  await composerJs(`${composerEffort}.click()`);
  check(await until(() => composerJs(`!!${element('[role=menu][aria-label=Effort] [data-pk-value=minimal]')}`)), "the effort choices follow the selected model");
  await composerJs(`${element('[role=menu][aria-label=Effort] [data-pk-value=high]')}.click()`);
  check(await until(() => composerJs(`${composerModel}?.textContent.includes("GPT-6-Luna") && ${composerEffort}?.getAttribute("aria-label").toLowerCase().includes("high")`)), "the composer displays the chosen model and effort");
  check(await until(() => js(`${selector}?.options.length === 3`)), "the selector appears with its models on the already open page, without reloading");
  await js(`(() => { const s = ${selector}; s.value = "gpt-6-luna"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  check(await until(async () => (await fetch(`${url}/api/sessions/th-live`, { headers: { cookie } }).then((r) => r.json() as Promise<Json>)).model_pick === "gpt-6-luna"), "choosing a model in the recovered selector saves it for the next turn");
  check(await until(() => js(`${selector}?.value === "gpt-6-luna" && document.querySelector(".model-next")?.textContent.includes("next turn")`)), "the page confirms which model the next turn will use");
  await server.restart("agentbook-cli");
  check(await until(() => js(`${selector}?.options.length === 3 && ${selector}?.value === "gpt-6-luna"`)), "the model selection remains available after Agentbook reconnects");
  await send("Page.reload", {}, composerSid);
  check(await until(() => composerJs(`${composerModel}?.textContent.includes("GPT-6-Luna") && ${composerEffort}?.getAttribute("aria-label").toLowerCase().includes("high")`)), "the new-thread model and effort survive reconnecting and reloading");
} catch (e) {
  check(false, String(e.stack || e));
} finally {
  process.exit(failures ? 1 : 0);
}
