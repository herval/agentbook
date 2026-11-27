#!/usr/bin/env node
// agentbook-cli updating itself (plugin/cli/update.ts) by pulling main, from a bare repo standing in for GitHub that
// each version is pushed to. A clone made without the install mark (a checkout someone develops in) isn't updated. A
// machine installed as a clone, with its agentbook-cli running: `agentbook-cli update` takes what main has and the new
// one answers; a version that can't load is refused before it's installed; one that installs but doesn't start is
// undone, the old one runs again, and a session starting doesn't undo that; and the daemon's own decision
// (maybeUpdate) follows off, ask, a busy machine and a bad version. A machine with Claude Code's plugin, through a
// stand-in `claude`: one that doesn't start is undone there too, and the next goes in. And the whole of it: a machine
// whose server says a newer version is out goes to it by itself.
// Run: node test/self-update.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { freePort } from "./harness-ports.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-self-update-")));

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const out = (r) => ((r.stdout || "") + (r.stderr || "")).trim();
const last = (r) => out(r).split("\n").pop().slice(0, 200);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await fn()) return true;
  return false;
};

// ---------- the source and the repo standing in for GitHub ----------
const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
// Nothing of this machine's agentbook or of the session running the test.
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AGENTBOOK_|GIT_|CLAUDE)/.test(k)));
const gitEnv = { ...clean, ...id };
const git = (cwd, ...args) => spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

// What a clone needs to run agentbook-cli, and a server/ as the repo has, which a clone made as an install may have.
const SRC = path.join(BASE, "source");
for (const p of [".claude-plugin", "bin/agentbook-cli", "plugin", "package.json"]) fs.cpSync(path.join(REPO, p), path.join(SRC, p), { recursive: true });
fs.mkdirSync(path.join(SRC, "server"));
fs.writeFileSync(path.join(SRC, "server", "main.ts"), "// the page's server would be here\n");
const MANIFEST = path.join(SRC, "plugin/.claude-plugin/plugin.json");
const MAIN = path.join(SRC, "plugin/cli/main.mjs");
const GOOD_MAIN = fs.readFileSync(MAIN, "utf8");
const PUB = path.join(BASE, "github.git");
git(BASE, "init", "-q", "--bare", "-b", "main", PUB);
git(SRC, "init", "-q", "-b", "main");
// What's in the source now, as `version`, pushed to main: with main.mjs as it is or with something planted before its
// last statement (the one that runs the command).
const commits = {};
function push(version, planted = "") {
  fs.writeFileSync(MANIFEST, JSON.stringify({ ...JSON.parse(fs.readFileSync(MANIFEST, "utf8")), version }, null, 2) + "\n");
  const at = GOOD_MAIN.lastIndexOf("\nif (process.argv[1] && ");
  fs.writeFileSync(MAIN, planted ? `${GOOD_MAIN.slice(0, at)}\n${planted}\n${GOOD_MAIN.slice(at)}` : GOOD_MAIN);
  git(SRC, "add", "--all", ".");
  git(SRC, "commit", "-q", "-m", `agentbook-cli ${version}`);
  const r = git(SRC, "push", "-q", PUB, "HEAD:main");
  if (r.status !== 0) throw new Error(`push ${version}: ${out(r)}`);
  commits[version] = git(SRC, "rev-parse", "HEAD").stdout.trim();
}
const commitOf = (v) => commits[v];

// ---------- machines ----------
const machineEnv = (dir, port, extra = {}) => ({
  ...clean,
  ...id,
  AGENTBOOK_HOME: path.join(dir, "data"),
  AGENTBOOK_PORT: String(port),
  AGENTBOOK_UPDATE_WAIT_MS: "6000",
  // Only the version its server says, unless a test asks main itself (the end).
  AGENTBOOK_UPDATE_CHECK: "0",
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_CODEX_MCP: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_HERMES: "0",
  AGENTBOOK_CLAUDE: "/usr/bin/false",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_NOTIFY: "0",
  AGENTBOOK_CLONE_DIR: path.join(dir, "clones"),
  CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
  ...extra,
});
const healthOf = (env) => () => {
  let key = {};
  try {
    key = { "x-agentbook-key": fs.readFileSync(path.join(env.AGENTBOOK_HOME, "cli", "local.key"), "utf8").trim() };
  } catch {}
  return fetch(`http://127.0.0.1:${env.AGENTBOOK_PORT}/api/health`, { headers: key, signal: AbortSignal.timeout(1500) }).then((r) => r.json(), () => null);
};
// What it says of itself, once it answers: one that's just started is busy for a moment.
const answer = async (health) => {
  let h = null;
  await until(async () => !!(h = await health()), 10000);
  return h;
};
const stateOf = (env) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(env.AGENTBOOK_HOME, "cli", "update.json"), "utf8"));
  } catch {
    return {};
  }
};
const cli = (bin, env, ...args) => spawnSync(bin, args, { env, encoding: "utf8", timeout: 180000 });
// A session's hook on the plugin in `root`: its ensureCli, run as the hook runs it.
const hook = (root, env) => spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(root, "lib", "common.ts"))}).then((m) => m.ensureCli()).then((ok) => console.log(ok))`], { env, encoding: "utf8", timeout: 30000 });
// The daemon's decision, asked of the update module in `root`.
const decide = (root, env, opts) => {
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(root, "cli", "update.ts"))}).then((m) => console.log(JSON.stringify(m.maybeUpdate({ latest: ${JSON.stringify(opts.latest)}, busy: () => ${!!opts.busy}, asked: ${!!opts.asked} }))))`], { env, encoding: "utf8", timeout: 30000 });
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return `crashed: ${out(r)}`;
  }
};

const envs = [];
let fake = null;
try {
  // ====================== a checkout someone develops in ======================
  push("1.0.1");
  const M0 = path.join(BASE, "m0");
  const DEV = path.join(M0, "agentbook");
  fs.mkdirSync(M0, { recursive: true });
  git(M0, "clone", "-q", `file://${PUB}`, DEV);
  const env0 = machineEnv(M0, await freePort(5810, 30));
  const dev = cli(path.join(DEV, "bin", "agentbook-cli"), env0, "update");
  check(dev.status === 1 && /isn't updated from here: it runs from a folder someone develops in/.test(dev.stderr) && /agentbook\.install=clone/.test(dev.stderr), `a clone made without the install mark isn't updated (${last(dev)})`);

  // ====================== a clone ======================
  const M1 = path.join(BASE, "m1");
  const CLONE = path.join(M1, "agentbook-cli");
  fs.mkdirSync(M1, { recursive: true });
  git(M1, "clone", "-q", "--depth", "1", "-c", "agentbook.install=clone", `file://${PUB}`, CLONE);
  const env1 = machineEnv(M1, await freePort(5840, 30));
  envs.push(env1);
  const health1 = healthOf(env1);
  const AB1 = path.join(CLONE, "bin", "agentbook-cli");
  const head1 = () => git(CLONE, "rev-parse", "HEAD").stdout.trim();
  const up = cli(AB1, env1, "up");
  check(up.status === 0 && (await until(async () => (await health1())?.version === "1.0.1")), `a machine installed as a clone runs agentbook-cli 1.0.1 (${last(up)})`);
  check(/updates itself here/.test(cli(AB1, env1, "update", "status").stdout), "and says it updates itself, unless told otherwise");
  const none = cli(AB1, env1, "update");
  check(none.status === 0 && /is the newest there is/.test(none.stdout) && (await answer(health1))?.version === "1.0.1", "with nothing newer on main there's nothing to do");

  // ---------- the next version ----------
  push("1.0.2");
  const pid1 = (await answer(health1))?.pid;
  const u2 = cli(AB1, env1, "update");
  check(u2.status === 0 && /main has agentbook-cli 1\.0\.2, at [0-9a-f]{10}/.test(u2.stdout) && /agentbook-cli 1\.0\.2 is running, updated from 1\.0\.1/.test(u2.stdout), `agentbook-cli update takes what main has (${last(u2)})`);
  const h2 = await answer(health1);
  check(h2?.version === "1.0.2" && h2.pid !== pid1 && head1() === commitOf("1.0.2"), "the new one answers in the old one's place, from main's commit");
  check(stateOf(env1).last?.to === "1.0.2" && stateOf(env1).last.from === "1.0.1" && !stateOf(env1).running, "what happened is kept (cli/update.json)");
  const copy = path.join(env1.AGENTBOOK_HOME, "storage.db.before-update");
  const kept = fs.existsSync(copy) && new DatabaseSync(copy, { readOnly: true });
  const scopes = kept ? kept.prepare("select distinct scope from meta union select distinct scope from events").all().map((r) => r.scope) : [];
  kept?.close();
  check(!!kept && scopes.every((x) => x === "cli"), `with a copy of its own store from before, and only its own (${scopes})`);

  // ---------- a version that can't load ----------
  push("1.0.4", 'throw new Error("planted: this version cannot load");');
  const u4 = cli(AB1, env1, "update");
  check(u4.status === 1 && /1\.0\.4 doesn't start on this machine: .*planted/.test(u4.stderr), `a version that can't load is refused before it's installed (${last(u4)})`);
  check((await answer(health1))?.pid === h2.pid && head1() === commitOf("1.0.2"), "with nothing changed");

  // ---------- a version that installs but doesn't start ----------
  push("1.0.5", 'if (!process.argv[2] || process.argv[2] === "run") {\n  console.error("agentbook-cli: Error: planted, this version cannot start");\n  process.exit(1);\n}');
  const u5 = cli(AB1, env1, "update");
  check(u5.status === 1 && /1\.0\.5 was installed but it didn't start within 6 seconds/.test(u5.stderr) && /agentbook-cli 1\.0\.2 is running again/.test(u5.stderr), `one that installs but doesn't start is undone (${last(u5)})`);
  const h5 = await answer(health1);
  check(h5?.version === "1.0.2" && h5.pid !== h2.pid && head1() === commitOf("1.0.2"), "the old version runs again, from its own commit");
  check(stateOf(env1).bad?.version === "1.0.5" && /planted/.test(stateOf(env1).bad.why), "the version is marked bad, with why from its log");
  const hk = hook(path.join(CLONE, "plugin"), env1);
  check(hk.stdout.trim() === "true" && (await answer(health1))?.pid === h5.pid, "and a session starting leaves the old one running");
  check(decide(path.join(CLONE, "plugin"), env1, { latest: "1.0.5" }) === "bad", "the daemon doesn't try it again");

  // ---------- the daemon's own decision ----------
  push("1.0.6");
  const root1 = path.join(CLONE, "plugin");
  check(decide(root1, env1, { latest: "1.0.2" }) === "up to date" && decide(root1, env1, { latest: "nonsense" }) === "up to date", "a server saying its own version, or nonsense, starts nothing");
  check(decide(root1, env1, { latest: "1.0.6", busy: true }) === "busy", "a newer one waits while an agent is mid-turn");
  cli(AB1, env1, "update", "off");
  check(decide(root1, env1, { latest: "1.0.6" }) === "off" && decide(root1, env1, { latest: "1.0.6", asked: true }) === "off", "with updates off here, nothing the server says starts one");
  cli(AB1, env1, "update", "ask");
  check(decide(root1, env1, { latest: "1.0.6" }) === "ask", "with ask, only the person's say does");
  check(decide(root1, { ...env1, AGENTBOOK_AUTO_UPDATE: "0" }, { latest: "1.0.6", asked: true }) === "off", "and AGENTBOOK_AUTO_UPDATE=0 is off");
  check(decide(root1, env1, { latest: "1.0.6", asked: true }) === null, "asked, it starts one");
  check(await until(async () => (await health1())?.version === "1.0.6", 30000), "which brings the machine to the new version by itself");
  check(await until(() => !stateOf(env1).running && stateOf(env1).last?.to === "1.0.6" && !stateOf(env1).bad, 5000), "and clears the bad mark of the version before");
  cli(AB1, env1, "update", "auto");
  check(decide(root1, env1, { latest: "1.0.6" }) === "up to date", "after which it's up to date");

  // ====================== Claude Code's plugin ======================
  const M2 = path.join(BASE, "m2");
  const PLUGINS = path.join(M2, "claude", "plugins");
  const MARKET = path.join(PLUGINS, "marketplaces", "agentbook");
  const cacheOf = (v) => path.join(PLUGINS, "cache", "agentbook", "agentbook", v);
  fs.mkdirSync(path.dirname(MARKET), { recursive: true });
  git(M2, "clone", "-q", `file://${PUB}`, MARKET);
  git(MARKET, "reset", "-q", "--hard", commitOf("1.0.2"));
  fs.cpSync(path.join(MARKET, "plugin"), cacheOf("1.0.2"), { recursive: true });
  fs.writeFileSync(path.join(PLUGINS, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "agentbook@agentbook": [{ scope: "user", installPath: cacheOf("1.0.2"), version: "1.0.2" }] } }));
  fs.writeFileSync(path.join(PLUGINS, "known_marketplaces.json"), JSON.stringify({ agentbook: { source: { source: "github", repo: "herval/agentbook" }, installLocation: MARKET } }));
  // A stand-in for `claude plugin …`: the marketplace's clone pulled, and its plugin copied in as the installed one.
  const FAKE = path.join(BASE, "fake-claude.ts");
  fs.writeFileSync(
    FAKE,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [a, b, c] = process.argv.slice(2);
const PLUGINS = ${JSON.stringify(PLUGINS)};
const MARKET = ${JSON.stringify(MARKET)};
if (a === "plugin" && b === "marketplace" && c === "update") process.exit(spawnSync("git", ["-C", MARKET, "pull", "-q", "--ff-only", "origin", "main"], { stdio: "inherit" }).status);
if (a === "plugin" && b === "update") {
  const version = JSON.parse(fs.readFileSync(path.join(MARKET, "plugin/.claude-plugin/plugin.json"), "utf8")).version;
  const to = path.join(PLUGINS, "cache", "agentbook", "agentbook", version);
  fs.cpSync(path.join(MARKET, "plugin"), to, { recursive: true });
  fs.writeFileSync(path.join(PLUGINS, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "agentbook@agentbook": [{ scope: "user", installPath: to, version }] } }));
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  const env2 = machineEnv(M2, await freePort(5870, 30), { AGENTBOOK_CLAUDE: FAKE });
  envs.push(env2);
  const health2 = healthOf(env2);
  const AB2 = path.join(MARKET, "bin", "agentbook-cli");
  spawn(process.execPath, [path.join(cacheOf("1.0.2"), "cli", "main.mjs"), "run"], { env: env2, stdio: "ignore", detached: true }).unref();
  check(await until(async () => (await health2())?.version === "1.0.2"), "a machine with Claude Code's plugin runs agentbook-cli 1.0.2 from its plugin folder");

  // ---------- a version that installs there but doesn't start ----------
  push("1.0.7", 'if (!process.argv[2] || process.argv[2] === "run") {\n  console.error("agentbook-cli: Error: planted, this version cannot start");\n  process.exit(1);\n}');
  const u7 = cli(AB2, env2, "update");
  check(u7.status === 1 && /1\.0\.7 was installed but it didn't start/.test(u7.stderr) && /agentbook-cli 1\.0\.2 is running again/.test(u7.stderr), `one that Claude Code installs but doesn't start is undone (${last(u7)})`);
  check((await answer(health2))?.root === cacheOf("1.0.2"), "and the plugin folder from before runs again");
  check(stateOf(env2).bad?.version === "1.0.7" && stateOf(env2).bad.fallback === cacheOf("1.0.2"), "the version is marked bad, with where the one before is");
  const was2 = await answer(health2);
  const hk2 = hook(cacheOf("1.0.7"), env2);
  check(hk2.stdout.trim() === "true" && (await answer(health2))?.pid === was2.pid, "so a session on the plugin that didn't start doesn't replace it");

  // ---------- the next version ----------
  push("1.0.8");
  const u8 = cli(AB2, env2, "update");
  check(u8.status === 0 && /agentbook-cli 1\.0\.8 is running/.test(u8.stdout), `the next version goes in through Claude Code's own update (${last(u8)})`);
  const h8 = await answer(health2);
  check(h8?.version === "1.0.8" && h8.pid !== was2.pid && h8.root === cacheOf("1.0.8"), "and runs from the plugin folder Claude Code installed");
  check(!stateOf(env2).bad && stateOf(env2).last?.to === "1.0.8", "with the bad mark gone");

  // ====================== its server says a newer version is out ======================
  // A server that's only what a machine talks to, saying a version number and keeping what the machine says of itself.
  let latest;
  const told = [];
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const said = latest === undefined ? {} : { latest };
      const u = /"update":(\{[^{}]*\})/.exec(body);
      if (u) told.push(u[1]);
      if (req.url.startsWith("/api/cli/hello")) return send({ device: "d1", name: "m1", owner: "ana", cursor: 0, empty: false, protocol: 1, min: 1, theirs: 1, parked: 0, ...said });
      if (req.url.startsWith("/api/cli/commands")) return setTimeout(() => send({ commands: [], owner: "ana", ...said }), 300);
      if (req.url.startsWith("/api/cli/ops")) return send({ acked: 0 });
      send({});
    });
  });
  const serverPort = await freePort(5900, 30);
  await new Promise<void>((r) => fake.listen(serverPort, "127.0.0.1", r));
  cli(AB1, env1, "down");
  const env3 = { ...env1, AGENTBOOK_SERVER: `http://127.0.0.1:${serverPort}`, AGENTBOOK_SERVER_TOKEN: "t", AGENTBOOK_MACHINE: "m1", AGENTBOOK_CLAUDE_ROUTINES: "0" };
  envs.push(env3);
  cli(AB1, env3, "up");
  const status = () => cli(AB1, env3, "status").stdout;
  check((await until(() => /Connected to/.test(status()))) && (await answer(health1))?.version === "1.0.6", "a machine on 1.0.6, logged in to a server that says nothing of versions, stays as it is");
  push("1.0.9");
  latest = "1.0.6";
  await sleep(1500);
  check((await answer(health1))?.version === "1.0.6" && !stateOf(env3).running, "its server saying its own version changes nothing");
  cli(AB1, env3, "update", "off");
  latest = "1.0.9";
  await sleep(2500);
  check((await answer(health1))?.version === "1.0.6" && /1\.0\.9 is out, and this machine has 1\.0\.6\. To update: agentbook-cli update/.test(status()), "with updates off here, a newer one is only said, with how to take it");
  cli(AB1, env3, "update", "auto");
  check(await until(async () => (await health1())?.version === "1.0.9", 40000), "with them on, the machine goes to the version its server says, by itself");
  check(await until(() => stateOf(env3).last?.to === "1.0.9" && !stateOf(env3).running, 5000), "from 1.0.6, as its own record says");
  check(/agentbook-cli 1\.0\.9 is out, and this is 1\.0\.6: updating/.test(fs.readFileSync(path.join(env3.AGENTBOOK_HOME, "cli", "cli.log"), "utf8")), "its log says why it started");
  check((await until(() => /Connected to/.test(status()), 15000)) && !/is out/.test(status()), "it's connected again, with nothing left to say about updating");
  check(told.some((t) => /"state":"behind"/.test(t) && /"to":"1\.0\.9"/.test(t)) && (await until(() => /"mode":"auto"/.test(told.at(-1) || "") && /"state":"current"/.test(told.at(-1) || ""), 15000)), `and its server heard it was behind, then up to date (${told.at(-1)})`);
  latest = "9.9.9";
  await sleep(4000);
  check((await answer(health1))?.version === "1.0.9" && /9\.9\.9/.test(JSON.stringify(stateOf(env3).failed || {})) && !stateOf(env3).bad, "a version its server says that main doesn't have yet changes nothing, and isn't held against a later one");

  // ====================== it asks main itself ======================
  // What the update module says, asked of the plugin in `root` (checkMain, then updateInfo with no server's word).
  const asked = (root, env, within = 0) => {
    const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(root, "cli", "update.ts"))}).then(async (m) => console.log(JSON.stringify({ checked: await m.checkMain({ within: ${within} }), info: m.updateInfo() })))`], { env, encoding: "utf8", timeout: 60000 });
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {
      return { crashed: out(r) };
    }
  };
  const on = { AGENTBOOK_UPDATE_CHECK: "" };
  check(asked(path.join(DEV, "plugin"), { ...env0, ...on }).checked === null, "a checkout someone develops in doesn't ask main");
  latest = undefined;
  push("1.0.10");
  const a10 = asked(root1, { ...env3, ...on });
  check(a10.checked?.version === "1.0.10" && a10.info?.state === "behind" && a10.info.to === "1.0.10" && !!a10.info.checked?.at, `an install asks main, which has 1.0.10, and stands behind it with no server's word (${JSON.stringify(a10.info)})`);
  check(asked(root1, { ...env3, AGENTBOOK_UPDATE_CHECK: "0" }).checked === null, "AGENTBOOK_UPDATE_CHECK=0 asks nothing");
  const origin = git(CLONE, "remote", "get-url", "origin").stdout.trim();
  git(CLONE, "remote", "set-url", "origin", `file://${path.join(BASE, "gone.git")}`);
  const gone = asked(root1, { ...env3, ...on });
  check(/git fetch failed/.test(gone.checked?.error || "") && gone.checked.version === "1.0.10" && gone.info?.state === "behind", `one that can't ask says why, and keeps what it found before (${gone.checked?.error})`);
  git(CLONE, "remote", "set-url", "origin", origin);

  // ---------- a version that changes agentbook's packages, on a whole install ----------
  // A clone with node_modules (agentbook setup's) runs npm install for it, through a stand-in npm that says where it
  // ran and fails while npm-fails is there.
  fs.mkdirSync(path.join(CLONE, "node_modules"), { recursive: true });
  const NPM = path.join(BASE, "npm");
  const npmLog = path.join(BASE, "npm.log");
  const npmFails = path.join(BASE, "npm-fails");
  fs.writeFileSync(NPM, `#!/bin/sh\necho "$PWD $1" >> "${npmLog}"\nif [ -f "${npmFails}" ]; then echo "npm ERR! planted: no network" >&2; exit 1; fi\n`, { mode: 0o755 });
  const pkg = path.join(SRC, "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg, "utf8")), description: "with a package more" }, null, 2) + "\n");
  push("1.0.11");
  fs.writeFileSync(npmFails, "");
  const env5 = { ...env3, ...on, AGENTBOOK_NPM: NPM, AGENTBOOK_UPDATE_CHECK_START_MS: "300" };
  const u11 = cli(AB1, env5, "update");
  check(u11.status === 1 && /npm install didn't work for 1\.0\.11: npm ERR! planted/.test(u11.stderr), `one whose npm install fails isn't taken (${last(u11)})`);
  check(head1() === commitOf("1.0.9") && (await answer(health1))?.version === "1.0.9", "the clone goes back to its commit, with the one running left as it was");
  check(fs.readFileSync(npmLog, "utf8").trim().split("\n").length === 2, "and its packages go back too (npm install again, on the old commit)");
  fs.rmSync(npmFails);
  fs.rmSync(npmLog);
  // Claude Code has the plugin from this clone (a folder marketplace, as the welcome card puts it in), at 1.0.9, in
  // its cache. A stand-in for `claude plugin …` copies the clone's version in as the installed one, and says what it
  // was asked.
  const PLUGINS1 = path.join(env3.CLAUDE_CONFIG_DIR, "plugins");
  const CACHE1 = path.join(PLUGINS1, "cache", "agentbook", "agentbook", "1.0.9");
  const installedIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "installed_plugins.json"), "utf8")).plugins["agentbook@agentbook"][0].version;
  fs.cpSync(path.join(CLONE, "plugin"), CACHE1, { recursive: true });
  fs.writeFileSync(path.join(PLUGINS1, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "agentbook@agentbook": [{ scope: "user", installPath: CACHE1, version: "1.0.9" }] } }));
  fs.writeFileSync(path.join(PLUGINS1, "known_marketplaces.json"), JSON.stringify({ agentbook: { source: { source: "directory", path: CLONE }, installLocation: CLONE } }));
  const claudeLog = path.join(BASE, "claude.log");
  const FAKE1 = path.join(BASE, "fake-claude-dir.ts");
  fs.writeFileSync(
    FAKE1,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(${JSON.stringify(claudeLog)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[3] === "update") {
  const version = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(CLONE)}, "plugin/.claude-plugin/plugin.json"), "utf8")).version;
  fs.writeFileSync(path.join(${JSON.stringify(PLUGINS1)}, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "agentbook@agentbook": [{ scope: "user", version }] } }));
}
`,
    { mode: 0o755 },
  );
  const env6 = { ...env5, AGENTBOOK_CLAUDE: FAKE1 };
  // Started again with its own asking on, by a session's hook as after a reboot (from Claude Code's copy of the
  // plugin), it finds 1.0.11 on main as it starts and goes to it by itself, in the clone the plugin came from.
  cli(AB1, env3, "down");
  const logFd = fs.openSync(path.join(env3.AGENTBOOK_HOME, "cli", "cli.log"), "a");
  spawn(process.execPath, [path.join(CACHE1, "cli", "main.mjs"), "run"], { env: env6, stdio: ["ignore", logFd, logFd], detached: true }).unref();
  fs.closeSync(logFd);
  check(await until(async () => (await health1())?.version === "1.0.11", 45000), "an install that asks main as it starts goes to what main has, by itself, started from Claude Code's copy of the plugin");
  const real = (p) => (p && fs.existsSync(p) ? fs.realpathSync(p) : p);
  check(real((await health1())?.root) === real(root1), `and runs from the clone (${(await health1())?.root})`);
  check(head1() === commitOf("1.0.11") && fs.readFileSync(npmLog, "utf8").trim() === `${CLONE} install`, "with npm install run in the clone, once");
  check(/agentbook-cli 1\.0\.11 is out, and this is 1\.0\.9: updating/.test(fs.readFileSync(path.join(env3.AGENTBOOK_HOME, "cli", "cli.log"), "utf8")), "its log says why it started");
  check(await until(() => fs.existsSync(claudeLog) && installedIn(PLUGINS1) === "1.0.11", 10000), `and Claude Code's plugin from the clone goes to 1.0.11 with it (${fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, "utf8").trim().replace(/\n/g, "; ") : "claude never asked"})`);
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  for (const env of envs) {
    for (let i = 0; i < 3; i++) {
      const h = await healthOf(env)();
      if (!h?.pid) break;
      try {
        process.kill(h.pid, "SIGTERM");
      } catch {}
      await sleep(400);
    }
    if (failures) console.log(`\n${path.basename(path.dirname(env.AGENTBOOK_HOME))}'s log:\n${(() => { try { return fs.readFileSync(path.join(env.AGENTBOOK_HOME, "cli", "cli.log"), "utf8").split("\n").slice(-25).join("\n"); } catch { return "(none)"; } })()}`);
  }
  fake?.close();
  fake?.closeAllConnections?.();
  fs.rmSync(BASE, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
