// agentbook-cli updating itself: `agentbook-cli update`, and what the daemon starts when its server says a newer
// version is out. An update pulls main from the repo agentbook-cli was installed from (its clone's origin), as
// `git pull` would. The server only ever says a version number: the files come from that repo, never from the server,
// and a version older than the one running is never taken.
//
// One update, in order: fetch main and read the version its plugin says; run that code once, from a folder of its own
// (`--version`), so one that can't start on this machine changes nothing; install it the way this one was installed
// (a clone: check main's commit out, and its packages; Claude Code's plugin: its two update commands); stop the
// running agentbook-cli, keep a copy of its database, start the new one, and wait for it to answer as that version.
// If it doesn't, the old one comes back, with the database as it was, and that version is marked bad here
// (cli/update.json), so nothing tries it again and a session starting doesn't undo the going back. If it does, a
// clone also updates the plugin Claude Code installed from it.
//
// Whether it updates by itself is this machine's to say (`agentbook-cli update auto|ask|off`, in gate.json, which
// its server can't change): auto unless told otherwise. A seat on a shared machine, a machine something else keeps
// running, a folder someone develops in, and a copy that isn't a clone are never updated from here. A clone of the
// repo is also where agentbook is developed, so only one cloned as an install (INSTALL_MARK) pulls by itself.

import { setTimeout as sleep } from "node:timers/promises";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_LOG, PLUGIN_ROOT, SEAT, VERSION, apiCall, cleanEnv, isVersion, olderVersion, openLog, pluginVersion, stopCli } from "../lib/common.ts";
import { Storage } from "../shared/storage.ts";
import { newestOf } from "../shared/versions.ts";
import { CLI_HOME, DB_FILE, HOME } from "../shared/store.ts";
import { updateClaudePlugin } from "./claude-plugin.ts";
import { createGate } from "./gate.ts";
import { installedByClaude } from "./uninstall.ts";

// Where an install comes from, for what it says. An update pulls from the clone's own origin.
export const UPDATE_REPO = "https://github.com/herval/agentbook";
const BRANCH = "main";
// What marks a clone as an install, in its git config: `git clone -c agentbook.install=clone …`.
export const INSTALL_MARK = "agentbook.install";

export const MODES = ["auto", "ask", "off"];
const STATE_FILE = () => path.join(CLI_HOME, "update.json");
const DB_COPY = () => `${DB_FILE}.before-update`;
const LOCK_MS = 15 * 60e3;
const realOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// Whether a child process couldn't start for not being there.
const missing = (e?: Error) => !!e && "code" in e && e.code === "ENOENT";

class UpdateError extends Error {
  // `bad`: this version can't be taken here, however often it's tried (one that won't start). Without it, it's worth
  // another try later (the network, GitHub, a version main doesn't have yet).
  bad: boolean;
  constructor(message: string, { bad = false }: { bad?: boolean } = {}) {
    super(message);
    this.bad = bad;
  }
}

// ---------- what this machine remembers of updating (cli/update.json) ----------
// { running: { pid, to, at }, last: { from, to, at }, bad: { version, why, at, fallback }, failed: { version, why, at },
//   checked: { at, version, error } }
export interface UpdateState {
  running?: { pid: number; to: string; at: string };
  last?: { from: string | null; to: string; at: string };
  bad?: { version: string; why: string; at: string; fallback: string | null };
  failed?: { version: string; why: string; at: string };
  // What main said the last time it was asked (checkMain): its version, or why it couldn't be asked.
  checked?: Checked;
}
export interface Checked {
  at: string;
  version: string | null;
  error?: string;
}
// A change to it: a part set, or taken out (null).
type UpdateChange = { [K in keyof UpdateState]?: UpdateState[K] | null };
export function updateState(): UpdateState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}
function remember(change: UpdateChange) {
  const next = { ...updateState(), ...change };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  fs.mkdirSync(CLI_HOME, { recursive: true });
  const tmp = `${STATE_FILE()}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE());
  return next;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
// An update that's under way: its mark, while its process lives and it isn't older than any update takes.
export function updating(s = updateState()) {
  const r = s.running;
  return r && Number.isInteger(r.pid) && alive(r.pid) && Date.now() - (Date.parse(r.at) || 0) < LOCK_MS ? r : null;
}

// ---------- this machine's say ----------
export function updateMode(settings = createGate({ home: HOME }).settings()) {
  if (process.env.AGENTBOOK_AUTO_UPDATE === "0") return "off";
  return MODES.includes(settings.update) ? settings.update : "auto";
}

// How this agentbook-cli got here, which is how it's updated: { kind, repo, why }.
//   claude  Claude Code's plugin, from its marketplace's clone (repo)
//   clone   a git clone made as an install (repo), run from its plugin/ folder, or Claude Code's plugin put in from
//           one (the welcome card does, from the clone setup made), as a session's hook starts it after a reboot
//   none    not updated from here, and `why`
export type Install = { kind: "claude" | "clone"; repo: string; why?: undefined } | { kind: "none"; repo?: undefined; why: string };
export function installOf(root = PLUGIN_ROOT): Install {
  if (process.env.AGENTBOOK_PLUGIN_DIR) return { kind: "none", why: "it runs from a folder someone develops in" };
  if (SEAT) return { kind: "none", why: "it's a seat on a shared machine, which its owner updates" };
  if (process.env.AGENTBOOK_SUPERVISED === "1") return { kind: "none", why: "something else keeps it running, and updates it" };
  if (installedByClaude(root)) {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins");
    let market = null;
    try {
      market = JSON.parse(fs.readFileSync(path.join(dir, "known_marketplaces.json"), "utf8")).agentbook;
    } catch {}
    const repo = market?.installLocation;
    if (market?.source?.source === "directory") {
      const from = typeof market.source.path === "string" ? market.source.path : repo;
      return from ? cloneOf(from) : { kind: "none", why: "Claude Code installed it from a folder on this machine" };
    }
    if (!repo || !fs.existsSync(path.join(repo, ".git"))) return { kind: "none", why: "Claude Code installed it from a folder on this machine" };
    return { kind: "claude", repo };
  }
  return cloneOf(path.dirname(realOr(root)));
}
function cloneOf(top: string): Install {
  const clone = `git clone -c ${INSTALL_MARK}=clone ${UPDATE_REPO}`;
  if (!fs.existsSync(path.join(top, ".git")) || !fs.existsSync(path.join(top, "bin", "agentbook-cli"))) return { kind: "none", why: `it was copied here, not cloned: install it as a clone to have it update (${clone})` };
  const mark = spawnSync("git", ["-C", top, "config", "--get", INSTALL_MARK], { encoding: "utf8", timeout: 10e3, env: GIT_ENV() });
  if (mark.stdout?.trim() !== "clone") return { kind: "none", why: `it runs from a folder someone develops in (an install is cloned with ${clone})` };
  return { kind: "clone", repo: path.resolve(top) };
}

// ---------- git ----------
const GIT_ENV = () => ({ ...cleanEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
interface GitOpts {
  timeout?: number;
  // What it reads on its stdin.
  input?: string;
}
function git(repo: string, args: string[], { timeout = 120e3, input }: GitOpts = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout, env: GIT_ENV(), maxBuffer: 64 << 20, input });
  if (r.error) throw new UpdateError(`git ${args[0]}: ${missing(r.error) ? "git isn't on this machine's path" : r.error.message}`);
  return r;
}
function gitOk(repo: string, args: string[], opts?: GitOpts) {
  const r = git(repo, args, opts);
  if (r.status !== 0) throw new UpdateError(`git ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" / ")}`);
  return r.stdout.trim();
}

// main as its repo has it now, fetched into `repo` from its origin, and the version its plugin says there.
export interface Head {
  version: string;
  commit: string;
}
const versionAt = (repo: string, commit: string) => {
  try {
    const v = JSON.parse(gitOk(repo, ["show", `${commit}:plugin/.claude-plugin/plugin.json`])).version;
    return isVersion(v) ? v : null;
  } catch {
    return null;
  }
};
export function fetchMain(repo: string): Head {
  const shallow = git(repo, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
  gitOk(repo, ["fetch", "-q", "--no-tags", ...(shallow ? ["--depth", "1"] : []), "origin", BRANCH]);
  const commit = gitOk(repo, ["rev-parse", "FETCH_HEAD^{commit}"]);
  const version = versionAt(repo, commit);
  if (!version) throw new UpdateError(`${BRANCH}'s plugin/.claude-plugin/plugin.json says no version`);
  return { version, commit };
}

// ---------- what main has now, asked of the repo itself ----------
// Each person's page is their own server, which nobody tells of a release, so a machine asks the repo it was
// installed from what version main has: when agentbook-cli starts, when a session starts here and it last asked
// more than CHECK_MS ago, and when its page asks (read.update). A newer one is then taken as one its server said
// would be. The daemon runs this, so git runs as a child it doesn't wait on.
const CHECK_MS = () => Number(process.env.AGENTBOOK_UPDATE_CHECK_MS || 6 * 3600e3);
const gitAsync = (repo: string, args: string[], timeout = 120e3) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", ["-C", repo, ...args], { encoding: "utf8", timeout, env: GIT_ENV(), maxBuffer: 16 << 20 }, (e, stdout, stderr) => {
      if (!e) return resolve(stdout.trim());
      const why = missing(e) ? "git isn't on this machine's path" : (stderr || e.message || "").trim().split("\n").slice(-2).join(" / ");
      reject(new UpdateError(`git ${args[0]} failed: ${why}`));
    }),
  );
async function fetchMainAsync(repo: string): Promise<Head> {
  const shallow = (await gitAsync(repo, ["rev-parse", "--is-shallow-repository"])) === "true";
  await gitAsync(repo, ["fetch", "-q", "--no-tags", ...(shallow ? ["--depth", "1"] : []), "origin", BRANCH]);
  const commit = await gitAsync(repo, ["rev-parse", "FETCH_HEAD^{commit}"]);
  let version = null;
  try {
    version = JSON.parse(await gitAsync(repo, ["show", `${commit}:plugin/.claude-plugin/plugin.json`])).version;
  } catch {}
  if (!isVersion(version)) throw new UpdateError(`${BRANCH}'s plugin/.claude-plugin/plugin.json says no version`);
  return { version, commit };
}
let checking: Promise<Checked | null> | null = null;
const asksMain = (install: ReturnType<typeof installOf>) => install.kind !== "none" && process.env.AGENTBOOK_UPDATE_CHECK !== "0";
// The version main had as it was last asked, where it's asked at all.
export const mainSaid = (install = installOf()): string | null => (asksMain(install) ? updateState().checked?.version || null : null);
// What main has, from the last ask if it's newer than `within` ms, else asked now. -> null where it isn't updated
// from here (nothing to ask), or while it's updating (that asks main itself).
export function checkMain({ install = installOf(), within = CHECK_MS() }: { install?: ReturnType<typeof installOf>; within?: number } = {}): Promise<Checked | null> {
  if (!asksMain(install)) return Promise.resolve(null);
  const s = updateState();
  if (s.checked && Date.now() - (Date.parse(s.checked.at) || 0) < within) return Promise.resolve(s.checked);
  if (updating(s)) return Promise.resolve(s.checked || null);
  checking ??= fetchMainAsync(install.repo)
    .then(
      (head): Checked => ({ at: new Date().toISOString(), version: head.version }),
      // Why it couldn't ask is kept with the version it found before, which still holds.
      (e): Checked => ({ at: new Date().toISOString(), version: updateState().checked?.version || null, error: e.message }),
    )
    .then((c) => (remember({ checked: c }), c))
    .finally(() => (checking = null));
  return checking;
}

// Run a commit once before trusting it, from a folder of its own with a data folder of its own: it must say its
// version. One that needs a newer Node, or doesn't load, stops here with nothing changed.
export function tryVersion(repo: string, { commit, version }: Head) {
  const tmp = realOr(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-cli-try-")));
  try {
    const tar = path.join(tmp, "version.tar");
    gitOk(repo, ["archive", "--format=tar", "-o", tar, commit, "plugin", "bin"], { timeout: 60e3 });
    const x = spawnSync("tar", ["-xf", tar, "-C", tmp], { encoding: "utf8", timeout: 60e3 });
    if (x.status !== 0) throw new UpdateError(`couldn't unpack ${version}: ${(x.stderr || x.error?.message || "").trim()}`);
    const r = spawnSync(process.execPath, [path.join(tmp, "plugin", "cli", "main.mjs"), "--version"], { encoding: "utf8", timeout: 30e3, env: cleanEnv({ AGENTBOOK_HOME: path.join(tmp, "home") }) });
    const out = (r.stdout || "").trim();
    if (r.status !== 0 || out !== `agentbook-cli ${version}`) {
      const lines = (r.stderr || "").trim().split("\n").filter(Boolean);
      const why = lines.findLast((l) => /error|needs Node|cannot|can't/i.test(l)) || lines.at(-1) || out || r.error?.message || `exit ${r.status}`;
      throw new UpdateError(`${version} doesn't start on this machine: ${why.trim().slice(0, 300)}`, { bad: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- installing it ----------
// What installing it did: where the new version is (`root`), where the one before it is (`oldRoot`), and undoing it.
interface Installed {
  root: string;
  oldRoot: string | null;
  undo: () => void;
}
// A clone: its checkout moved to main's commit. One with changes of its own is left alone. A whole install (it has
// node_modules: the page's React and esbuild, iroh) gets its packages again when the version changed them, as
// `agentbook setup` installs them; going back puts the old ones back too.
function installClone(repo: string, head: Head, print: (line: string) => void): Installed {
  const dirty = gitOk(repo, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new UpdateError(`${repo} has changes of its own (${dirty.split("\n")[0].trim()}…), so it isn't updated: undo them, or update it by hand`);
  const was = gitOk(repo, ["rev-parse", "HEAD"]);
  gitOk(repo, ["reset", "-q", "--hard", head.commit]);
  const root = path.join(repo, "plugin");
  const packages = fs.existsSync(path.join(repo, "node_modules")) && git(repo, ["diff", "--quiet", was, head.commit, "--", "package.json", "package-lock.json"]).status !== 0;
  const undo = () => {
    gitOk(repo, ["reset", "-q", "--hard", was]);
    if (packages) npmInstall(repo);
  };
  if (packages) {
    print(`${head.version} changes agentbook's packages: npm install…`);
    const why = npmInstall(repo);
    if (why) {
      try {
        undo();
      } catch {}
      throw new UpdateError(`npm install didn't work for ${head.version}: ${why}`);
    }
  }
  return { root, oldRoot: root, undo };
}
// -> null when it worked, else why not
function npmInstall(repo: string): string | null {
  const r = spawnSync(process.env.AGENTBOOK_NPM || "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: repo, encoding: "utf8", timeout: 10 * 60e3, env: cleanEnv() });
  if (r.status === 0) return null;
  if (missing(r.error)) return "npm isn't on this machine's path";
  return ((r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split("\n").filter(Boolean).at(-1) || "").slice(0, 300);
}

const claudeDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins");
const installedPlugin = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(claudeDir(), "installed_plugins.json"), "utf8")).plugins?.["agentbook@agentbook"]?.[0] || null;
  } catch {
    return null;
  }
};
// Claude Code's plugin: its marketplace's clone pulled, then the plugin updated from it, both by Claude Code. Its
// clone has main as it is by then, which may be newer than what was tried: that's tried too, and installed.
function installClaude(repo: string, head: Head, print: (line: string) => void): Installed {
  const claude = process.env.AGENTBOOK_CLAUDE || "claude";
  const run = (...a: string[]) => spawnSync(claude, a, { encoding: "utf8", timeout: 180e3, env: cleanEnv() });
  const said = (r) => (r.stderr || r.stdout || r.error?.message || "").trim().split("\n").pop();
  const before = installedPlugin();
  const m = run("plugin", "marketplace", "update", "agentbook");
  if (missing(m.error)) throw new UpdateError("Claude Code isn't on this machine's path, so its plugin can't be updated from here");
  if (m.status !== 0) throw new UpdateError(`claude plugin marketplace update didn't work: ${said(m)}`);
  const at = gitOk(repo, ["rev-parse", "HEAD"]);
  if (at !== head.commit) {
    const there = versionAt(repo, at);
    if (!there || olderVersion(there, head.version)) throw new UpdateError(`Claude Code's copy of the repo is at ${there || "something else"}, not ${head.version}`);
    const moved = { version: there, commit: at };
    tryVersion(repo, moved);
    if (there !== head.version) print(`Claude Code's copy of the repo has ${there} by now, newer than ${head.version}: installing that.`);
    Object.assign(head, moved);
  }
  const u = run("plugin", "update", "agentbook@agentbook");
  if (u.status !== 0) throw new UpdateError(`claude plugin update didn't work: ${said(u)}`);
  const now = installedPlugin();
  if (!now || now.version !== head.version || !now.installPath) throw new UpdateError(`Claude Code has ${now?.version || "no agentbook plugin"} installed after its update, not ${head.version}`);
  // Claude Code keeps the old version's folder for the sessions still on it: that's what going back starts.
  return { root: now.installPath, oldRoot: before?.installPath && before.installPath !== now.installPath ? before.installPath : null, undo: () => {} };
}

// ---------- swapping the running one ----------
const health = async () => (await apiCall("GET", "/api/health", null, { timeout: 1500 }).catch(() => null)) || null;
// `webui`: the one it replaces served this machine's page (`agentbook webui`), which the new one serves as well.
function startFrom(root: string, webui = false) {
  const log = openLog(CLI_LOG);
  spawn(process.execPath, [path.join(root, "cli", "main.mjs"), "run", ...(webui ? ["--webui"] : [])], { detached: true, stdio: ["ignore", log, log], env: cleanEnv() }).unref();
  fs.closeSync(log);
}
async function stopRunning(ms = 10e3) {
  for (let i = 0; i < 3; i++) {
    const h = await health();
    if (!h) return true;
    await stopCli(h.data, ms, (h.how === "own" && h.pid) || h.data?.pid);
  }
  return !(await health());
}
// A copy of its own store as it is now, whole (one is kept: the last update's), and putting it back. Only its own
// rows (scope "cli"): the rest of storage.db is its page's, which a page running on its own has open as it updates.
const withStorage = (fn) => {
  const s = Storage.at(DB_FILE);
  try {
    return fn(s);
  } finally {
    s.close();
  }
};
function copyDatabase() {
  if (!fs.existsSync(DB_FILE)) return false;
  withStorage((s) => s.copyScope("cli", DB_COPY()));
  return true;
}
function restoreDatabase() {
  if (fs.existsSync(DB_COPY())) withStorage((s) => s.restoreScope("cli", DB_COPY()));
}
const logTail = () => {
  try {
    const text = fs.readFileSync(CLI_LOG, "utf8");
    return text.slice(-4000).trim().split("\n").filter((l) => /error|Error|cannot|can't|needs Node/i.test(l)).slice(-2).join(" / ").slice(0, 400);
  } catch {
    return "";
  }
};
// Start `root` and wait for it to answer as `version`. An older one that got the port first (a session's hook
// started it in the gap) is stopped, and this one started again. -> whether it came up
async function comeUp(root: string, version: string, ms: number, webui = false) {
  startFrom(root, webui);
  let starts = 1;
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await sleep(300);
    const h = await health();
    if (h?.data?.version === version) return true;
    if (h?.data?.cli && (!h.data.version || olderVersion(h.data.version, version)) && starts < 4) {
      await stopRunning(5000);
      startFrom(root, webui);
      starts++;
    }
  }
  return false;
}

// ---------- one update ----------
// `to`: the version its server said, or none for whatever main has. `print`: what it says as it goes.
// -> { updated, from, to } | { updated: false, why }. Throws what stopped it.
export async function update({ to = null, print = () => {}, waitMs = Number(process.env.AGENTBOOK_UPDATE_WAIT_MS || 30e3) }: { to?: string | null; print?: (line: string) => void; waitMs?: number } = {}): Promise<{ updated: false; why: string } | { updated: true; from: string | null; to: string; started: boolean }> {
  const install = installOf();
  if (install.kind === "none") throw new UpdateError(`This agentbook-cli isn't updated from here: ${install.why}.`);
  const other = updating();
  if (other && other.pid !== process.pid) throw new UpdateError(`An update to ${other.to} is already under way (pid ${other.pid}).`);
  if (to && !isVersion(to)) throw new UpdateError(`${to} isn't a version.`);
  // What it updates from: the one that's running, else the one installed.
  const was = await health();
  const from = was?.data?.version || (install.kind === "claude" && installedPlugin()?.version) || VERSION;
  const newest = (v: string): { updated: false; why: string } | null => (from && !olderVersion(from, v) ? { updated: false, why: `agentbook-cli ${from} is ${from === v ? "the newest there is" : `newer than ${v}`}.` } : null);
  if (to && newest(to)) return newest(to);
  let head: Head | null = null;
  try {
    head = fetchMain(install.repo);
    remember({ checked: { at: new Date().toISOString(), version: head.version } });
    // Its server said a version main doesn't have yet: one said before it was pushed.
    if (to && olderVersion(head.version, to)) throw new UpdateError(`${BRANCH} has agentbook-cli ${head.version}, not ${to} yet`);
    if (newest(head.version)) return newest(head.version);
    remember({ running: { pid: process.pid, to: head.version, at: new Date().toISOString() } });
    print(`${BRANCH} has agentbook-cli ${head.version}, at ${head.commit.slice(0, 10)}.`);
    tryVersion(install.repo, head);
    const put = install.kind === "clone" ? installClone(install.repo, head, print) : installClaude(install.repo, head, print);
    const oldRoot = put.oldRoot || (was?.data?.root && fs.existsSync(path.join(was.data.root, "cli", "main.mjs")) ? was.data.root : null);
    if (!was) {
      if (install.kind === "clone") updateClaudePlugin(install.repo, print);
      print(`Installed agentbook-cli ${head.version}. It wasn't running, so it isn't started.`);
      remember({ running: null, failed: null, bad: null, last: { from, to: head.version, at: new Date().toISOString() } });
      return { updated: true, from, to: head.version, started: false };
    }
    if (!(await stopRunning())) throw new UpdateError("the running agentbook-cli didn't stop");
    let copied = false;
    try {
      copied = copyDatabase();
    } catch (e) {
      print(`Couldn't keep a copy of its database first (${e.message}): going on without one.`);
    }
    const webui = !!was?.data?.page;
    if (await comeUp(put.root, head.version, waitMs, webui)) {
      remember({ running: null, failed: null, bad: null, last: { from, to: head.version, at: new Date().toISOString() } });
      print(`agentbook-cli ${head.version} is running${from ? `, updated from ${from}` : ""}.`);
      // Only once the new one answers: a clone that goes back would leave Claude Code a plugin newer than it.
      if (install.kind === "clone") updateClaudePlugin(install.repo, print);
      return { updated: true, from, to: head.version, started: true };
    }
    // It didn't come up: back to the one that was running, with its database as it was.
    const why = `it didn't start within ${Math.round(waitMs / 1000)} seconds${logTail() ? `: ${logTail()}` : ""}`;
    await stopRunning(5000);
    if (copied) restoreDatabase();
    let undone = true;
    try {
      put.undo();
    } catch {
      undone = false;
    }
    remember({ bad: { version: head.version, why, at: new Date().toISOString(), fallback: oldRoot && oldRoot !== put.root ? oldRoot : null } });
    const back = install.kind === "clone" ? (undone ? put.root : null) : oldRoot;
    const came = back ? await comeUp(back, pluginVersion(back), waitMs, webui) : false;
    throw new UpdateError(`agentbook-cli ${head.version} was installed but ${why}. ${came ? `agentbook-cli ${from || "from before"} is running again` : "The one from before couldn't be started again: agentbook-cli up"}, and ${head.version} won't be tried again here.`, { bad: true });
  } catch (e) {
    const at = new Date().toISOString();
    // A bad mark is for the version that was tried; a failed one for the version its server said, which it's
    // asked again for.
    const tried = head?.version || to;
    if (e.bad && tried && updateState().bad?.version !== tried) remember({ bad: { version: tried, why: e.message, at, fallback: null } });
    const asked = to || head?.version;
    remember({ running: null, ...(asked ? { failed: { version: asked, why: e.message, at } } : {}) });
    throw e;
  }
}

// ---------- the command ----------
export async function updateCommand(args: string[], { print = (s) => console.log(s) }: { print?: (line: string) => void } = {}) {
  const [first] = args.filter((a) => !a.startsWith("--"));
  const gate = createGate({ home: HOME });
  if (MODES.includes(first)) {
    gate.agree({ update: first });
    return said(first);
  }
  if (first === "status" || args.includes("--status")) return [said(updateMode()), ...history()].join("\n");
  if (first && !isVersion(first)) throw new Error("usage: agentbook-cli update [<version> | auto | ask | off | status]");
  try {
    const r = await update({ to: first || null, print });
    return "why" in r ? r.why : "";
  } catch (e) {
    if (e instanceof UpdateError) throw new Error(e.message);
    throw e;
  }
}
function said(mode: string) {
  const install = installOf();
  if (install.kind === "none") return `This agentbook-cli isn't updated from here: ${install.why}.`;
  if (process.env.AGENTBOOK_AUTO_UPDATE === "0") return "Updates are off here (AGENTBOOK_AUTO_UPDATE=0): agentbook-cli update does one.";
  return mode === "auto" ? `agentbook-cli updates itself here, when its server says a newer version is out and no agent is mid-turn: it pulls ${BRANCH} from the repo it was cloned from. agentbook-cli update off stops that.` : mode === "ask" ? "agentbook-cli updates here only when you say: agentbook-cli update, or Update on this machine's page." : "Updates are off here: agentbook-cli update does one, agentbook-cli update auto turns them on.";
}
function history(s = updateState()) {
  const when = (at: string) => new Date(at).toLocaleString();
  const lines = [];
  const u = updating(s);
  if (u) lines.push(`Updating to ${u.to} now.`);
  if (s.last) lines.push(`Last updated ${when(s.last.at)}${s.last.from ? `, from ${s.last.from}` : ""} to ${s.last.to}.`);
  if (s.bad) lines.push(`${s.bad.version} isn't tried again here: ${s.bad.why}`);
  else if (s.failed) lines.push(`The update to ${s.failed.version} on ${when(s.failed.at)} didn't work: ${s.failed.why}`);
  return lines;
}

// ---------- the daemon's side ----------
// What decides, as its server says a version, whether to start an update now, and starts it: detached, so it outlives
// the agentbook-cli it replaces, with its output in agentbook-cli's log. `busy()`: whether an agent is mid-turn.
// `asked`: a person said to (their signed Update), which `ask` waits for and `off` refuses.
// -> why not, or null when it started one
const RETRY_MS = 60 * 60e3;
export function maybeUpdate({ latest, busy = () => false, asked = false, log = () => {}, started = Date.now() }: { latest?: string | null; busy?: () => boolean; asked?: boolean; log?: (line: string) => void; started?: number } = {}) {
  if (!isVersion(latest) || !VERSION || !olderVersion(VERSION, latest)) return "up to date";
  const mode = updateMode();
  if (mode === "off" || (mode === "ask" && !asked)) return mode;
  const install = installOf();
  if (install.kind === "none") return install.why;
  const s = updateState();
  if (updating(s)) return "updating";
  // A version that didn't work here holds until its server says a newer one than that.
  if (s.bad?.version && !olderVersion(s.bad.version, latest)) return "bad";
  // One that didn't work (the network, GitHub) is tried again when this agentbook-cli next starts, or an hour on.
  if (!asked && s.failed?.version === latest && Date.parse(s.failed.at) > started && Date.now() - Date.parse(s.failed.at) < RETRY_MS) return "failed";
  if (busy()) return "busy";
  const out = openLog(CLI_LOG);
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "cli", "main.mjs"), "update", latest], { detached: true, stdio: ["ignore", out, out], env: cleanEnv() });
  child.unref();
  fs.closeSync(out);
  remember({ running: { pid: child.pid, to: latest, at: new Date().toISOString() } });
  log(`agentbook-cli ${latest} is out, and this is ${VERSION}: updating (pid ${child.pid})`);
  return null;
}

// What this machine says of its updates, for its page and `status`: { mode, can, why, state, to, at, error }.
// `mode`: auto, ask or off, or "none" when it isn't updated from here (and `why`). `state`: where it stands against
// the newest version its server said: `to` that one, `at` when it last changed, `error` why the last try failed.
export interface UpdateInfo {
  mode: string;
  why?: string;
  state: "updating" | "failed" | "behind" | "current";
  to?: string;
  at?: string;
  from?: string | null;
  error?: string;
  // When main was last asked what it has (checkMain), and why that didn't work if it didn't.
  checked?: { at: string; error?: string };
}
export function updateInfo({ latest = null, install = installOf() }: { latest?: string | null; install?: ReturnType<typeof installOf> } = {}): UpdateInfo {
  const s = updateState();
  const u = updating(s);
  latest = newestOf(latest, mainSaid(install));
  const behind = isVersion(latest) && VERSION && olderVersion(VERSION, latest);
  const checked = asksMain(install) && s.checked ? { checked: { at: s.checked.at, ...(s.checked.error ? { error: s.checked.error } : {}) } } : {};
  const out = { mode: install.kind === "none" ? "none" : updateMode(), ...(install.kind === "none" ? { why: install.why } : {}), ...checked };
  if (u) return { ...out, state: "updating", to: u.to, at: u.at };
  if (s.bad?.version && behind && !olderVersion(s.bad.version, latest)) return { ...out, state: "failed", to: s.bad.version, at: s.bad.at, error: s.bad.why };
  if (s.failed && behind && s.failed.version === latest) return { ...out, state: "failed", to: s.failed.version, at: s.failed.at, error: s.failed.why };
  if (behind) return { ...out, state: "behind", to: latest };
  return { ...out, state: "current", ...(s.last?.to === VERSION ? { at: s.last.at, from: s.last.from } : {}) };
}
