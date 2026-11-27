#!/usr/bin/env node
// git on a cloud machine signs in to GitHub as its owner: a machine
// linked to a sandbox has no GitHub sign-in of its own, so its agentbook-cli sets git's credential helper for
// github.com to plugin/cli/git-credential.ts, which asks the server for the token of its owner's GitHub connector,
// one git command at a time. Only a linked machine gets it, only while its owner leaves it on and has a GitHub
// connector, and nothing is written to the machine's disk but the helper's line in its owner's git config.
// Run: node test/git-github.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoat } from "./fake-boat.ts";
import { startGitHub } from "./fake-github.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-gitgh-"));
const HUB_PORT = testPort(7300);
const BOX_PORT = HUB_PORT + 100;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const BOX = `http://127.0.0.1:${BOX_PORT}`;
const SANDBOX = "bx_23456789";
const project = path.join(BASE, "dev", "shop");
fs.mkdirSync(project, { recursive: true });
spawnSync("git", ["-C", project, "init", "-q", "-b", "main"]);

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

// boat, with one stopped sandbox. A resume "starts the sandbox": the machine's agentbook-cli, unless `stuck`.
let box = { kill() {} };
let stuck = false;
const boat = await startBoat({ sandboxes: [{ id: SANDBOX, name: "shop", state: "archived" }, { id: "bx_abcdefgh", name: "other", state: "ready" }], onResume: () => !stuck && (box = serve(boxEnv)) });

const common = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_RUNTIME_MS: "300", CLAUDE_CONFIG_DIR: path.join(BASE, "claude") };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL"]) delete common[k];
// GitHub, where herval's token reads his private repo.
const TOKEN = "github_pat_herval_0123456789";
const GH_FILE = path.join(BASE, "github.json");
fs.writeFileSync(GH_FILE, JSON.stringify({ tokens: { [TOKEN]: { login: "herval", name: "Herval", repos: ["herval/secret"] } }, repos: { "herval/secret": { private: true, pushedAt: new Date().toISOString(), pulls: [] } } }));
const site = await startGitHub({ ghFile: GH_FILE });
const GITCONFIG = path.join(BASE, "box-gitconfig");
// gh: agentbook's own goes in SHIMS, ahead of "the real one" on PATH, which here only says what it was run with.
const SHIMS = path.join(BASE, "shims");
const REAL_GH = path.join(BASE, "real-bin");
fs.mkdirSync(REAL_GH, { recursive: true });
fs.writeFileSync(path.join(REAL_GH, "gh"), '#!/bin/sh\necho "token=$GH_TOKEN args=$*"\n', { mode: 0o755 });
const hubEnv = { ...common, AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_BOAT_API_URL: boat.url, AGENTBOOK_GITHUB_API_URL: site.url, AGENTBOOK_CLOUD_CONNECT_MS: "2500", AGENTBOOK_CLOUD_AGAIN_MS: "60000" };
const boxEnv = { ...common, AGENTBOOK_PORT: String(BOX_PORT), AGENTBOOK_HOME: path.join(BASE, "box"), AGENTBOOK_MACHINE: "boat-shop", AGENTBOOK_URL: BOX, AGENTBOOK_HUB: HUB, GIT_CONFIG_GLOBAL: GITCONFIG, AGENTBOOK_GH_SHIM_DIR: SHIMS };
fs.mkdirSync(path.join(BASE, "box", "cli"), { recursive: true });
fs.writeFileSync(path.join(BASE, "box", "cli", "gate.json"), JSON.stringify({ folders: [BASE] }));

let COOKIE = "";
const raw = (base: string, p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(base === HUB && COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (base: string, p: string) => {
  const r = await raw(base, p);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (base: string, p: string, body: unknown = {}) => {
  const r = await raw(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
function serve(env: NodeJS.ProcessEnv) {
  return spawnAgentbook({ env, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
}
const healthy = (base: string) => until(async () => (await fetch(base + "/api/health").catch(() => null))?.ok, 8000);
const hook = (event: string, input: object, env?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify(input), env: { ...boxEnv, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_ENTRYPOINT: "cli", ...env } });
const machine = async () => (await stateOf((p) => get(HUB, p))).machines?.find((m) => m.name === "boat-shop");
const resumes = () => boat.calls.filter((c) => c.method === "POST" && c.path === `/sandboxes/${SANDBOX}/resume`).length;
// The sandbox stops: its agentbook-cli goes with it, and boat says it's stopped ("archived").
const kill = (p) => {
  if (p.connected === false || p.gone) return;
  p.gone = true;
  p.kill();
};
const off = async () => {
  kill(box);
  boat.sandboxes.get(SANDBOX).state = "archived";
  return until(async () => (await machine())?.online === false, 15000);
};


// What git would get from its helper, asked as git asks (`get`, with the URL's parts on stdin).
const helper = (host = "github.com", protocol = "https") => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "cli", "git-credential.ts"), "get"], { input: `protocol=${protocol}\nhost=${host}\n\n`, env: boxEnv, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr };
};
const config = () => (fs.existsSync(GITCONFIG) ? fs.readFileSync(GITCONFIG, "utf8") : "");
const helperLine = () => spawnSync("git", ["config", "--global", "--get-all", "credential.https://github.com.helper"], { env: boxEnv, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

const hub = serve(hubEnv);
try {
  check(await healthy(HUB), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  const asked = await post(HUB, "/api/devices/start", { name: "boat-shop" });
  await post(HUB, "/api/devices/approve", { code: asked.code });
  Object.assign(boxEnv, { AGENTBOOK_HUB_TOKEN: (await get(HUB, `/api/devices/poll?poll=${encodeURIComponent(asked.poll)}`)).token });
  box = serve(boxEnv);
  check((await healthy(BOX)) && (await until(async () => (await machine())?.online, 10000)), "a machine logs in to it");
  check((await post(HUB, "/api/connectors", { kind: "boat", api_key: boat.key })).status === 200 && (await post(HUB, "/api/connectors", { kind: "github", api_key: TOKEN, states: [] })).status === 200, "its owner has a boat connector and a GitHub connector");

  // ---------- not a cloud machine: nothing ----------
  const plain = helper();
  check(!plain.out && !config().includes("git-credential"), "a machine that isn't linked to a sandbox gets no GitHub sign-in, and its git config is left alone");

  // ---------- linked: git signs in as its owner ----------
  const linked = await post(HUB, "/api/machines/boat-shop/cloud", { connector: "boat", sandbox: SANDBOX });
  check(linked.status === 200, "its owner links it to its sandbox");
  const set = await until(() => helperLine().some((l) => l.includes("git-credential.ts")), 15000);
  check(set && helperLine().length === 1 && /helper = \n\s*helper = !/.test(config()), `its agentbook-cli sets git's helper for github.com, after an empty one that drops any other (${JSON.stringify(helperLine())})`);
  const got = helper();
  check(got.out === `username=x-access-token\npassword=${TOKEN}\n`, `git asking for github.com gets its owner's GitHub connector's token (${got.err.trim()})`);
  // ---------- gh, the same way ----------
  const gh = (args = ["repo", "view"], env = {}) => spawnSync(path.join(SHIMS, "gh"), args, { env: { ...boxEnv, PATH: `${SHIMS}:${REAL_GH}:${process.env.PATH}`, ...env }, encoding: "utf8" });
  check(await until(() => fs.existsSync(path.join(SHIMS, "gh")), 15000), "its agentbook-cli puts a gh of agentbook's ahead of the real one");
  const viewed = gh();
  check(viewed.stdout.trim() === `token=${TOKEN} args=repo view`, `gh there runs the real gh with its owner's token, for that command (${(viewed.stdout || viewed.stderr).trim().slice(0, 120)})`);
  check(gh(["auth", "status"]).stdout.trim() === "token= args=auth status" && gh(["repo", "view"], { GH_TOKEN: "mine" }).stdout.trim() === "token=mine args=repo view", "gh auth, and a token already in the environment, are left alone");
  check(!fs.readFileSync(path.join(SHIMS, "gh"), "utf8").includes(TOKEN), "and no token is in the file");
  const bare = await raw(BOX, "/api/local/git-github");
  check(bare.status === 403 && !(await bare.text()).includes(TOKEN), "a process without the machine's key (another person's, on a shared machine) gets a refusal, not the token");
  check(!helper("gitlab.com").out && !helper("github.com", "http").out && !helper("github.com.evil.test").out, "and nothing for any other host, or without https");
  check(!config().includes(TOKEN) && !fs.readdirSync(path.join(BASE, "box", "cli")).some((f) => /\.(json|txt|log)$/.test(f) && fs.readFileSync(path.join(BASE, "box", "cli", f), "utf8").includes(TOKEN)), "the token is in no file on the machine");
  const page = await get(HUB, "/api/machines/boat-shop");
  check(page.cloud?.github === true && page.cloud.github_connected === true && !JSON.stringify(page).includes(TOKEN), "its page says git signs in as you there, and never has the token");
  // A real git, asked the way git asks its helpers.
  const fill = spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", env: { ...boxEnv, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" });
  check(fill.stdout.includes(`password=${TOKEN}`), `git itself gets it through the helper (${fill.stderr.trim().slice(0, 120)})`);

  // ---------- turned off ----------
  const offed = await post(HUB, "/api/machines/boat-shop/cloud/github", { on: false });
  check(offed.status === 200 && offed.github === false, "its owner turns it off");
  check(await until(() => !helperLine().length, 15000), "the helper leaves its git config");
  check(!helper().out, "and git gets nothing");
  check(!fs.existsSync(path.join(SHIMS, "gh")), "and agentbook's gh is gone, so gh is the machine's own again");
  await post(HUB, "/api/machines/boat-shop/cloud/github", { on: true });
  check(await until(() => helper().out.includes(TOKEN), 15000), "turned on again, it's back");

  // ---------- a helper of the person's own stays ----------
  await post(HUB, "/api/machines/boat-shop/cloud", {});
  check(await until(() => !helperLine().length, 15000) && !helper().out, "unlinked from its sandbox, it's gone too");
  spawnSync("git", ["config", "--global", "credential.https://github.com.helper", "store"], { env: boxEnv });
  await post(HUB, "/api/machines/boat-shop/cloud", { connector: "boat", sandbox: SANDBOX });
  await until(() => helperLine().some((l) => l.includes("git-credential.ts")), 15000);
  await post(HUB, "/api/machines/boat-shop/cloud", {});
  await until(() => !helperLine().some((l) => l.includes("git-credential.ts")), 15000);
  check(!helperLine().some((l) => l.includes("git-credential.ts")), "linked and unlinked again, agentbook's helper is gone");

  // ---------- no GitHub connector ----------
  await post(HUB, "/api/machines/boat-shop/cloud", { connector: "boat", sandbox: SANDBOX });
  await until(() => helper().out.includes(TOKEN), 15000);
  const conns = (await get(HUB, "/api/connectors")).connectors || [];
  await post(HUB, `/api/connectors/${conns.find((c) => c.kind === "github").id}/delete`);
  check(await until(() => !helper().out, 15000), "with its owner's GitHub connector gone, git gets nothing");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  kill(hub);
  kill(box);
  await boat.close();
  await site.close?.();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
