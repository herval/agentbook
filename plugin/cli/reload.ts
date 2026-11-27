// agentbook-cli run from a checkout of agentbook (a folder someone develops in) starts itself again when the code it
// runs changes there: when the checkout's commit moves (a commit lands on the branch it has out, or it checks out
// another) and what changed is code this process loads (plugin/ and server/, but their Markdown, and the packages).
// Not on each saved file: several agents edit that folder at once, and a half-written one would take it down. Not for
// the page (web/): the server builds that again by itself (server/web-assets.ts). Nor for tests, docs or mockups.
//
// Before it stops, the folder's code must build (esbuild, as build.ts bundles it, in memory) and start (`--version`,
// on a data folder of its own, as update.ts tries a release): code that doesn't is left be, said in its log, and
// tried again when the commit next moves. It waits for a moment no agent is mid-turn, as an update does (a hook that
// found it gone would lose what it said), but not longer than ten minutes after the commit: with agents always at
// work there may be no such moment. Then it starts its successor, with the arguments and the person's environment it
// was started with, which waits for this one to be gone, and stops as `agentbook stop` stops it.
//
// Only for the person's own agentbook (its data in ~/.agentbook): tests run from the same folder, on data of their
// own, and must never start again under their checks. Never for a clone made as an install, whose commit moves only
// as it updates itself (update.ts), which starts the new code itself. AGENTBOOK_RELOAD=0 turns it off; =1 turns it on for any data
// folder (test/reload.ts).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_LOG, cleanEnv, openLog } from "../lib/common.ts";
import { BUNDLED, CODE_ROOT } from "../shared/bundle.ts";
import { HOME } from "../shared/store.ts";
import { INSTALL_MARK } from "./update.ts";

const REPO = path.resolve(CODE_ROOT, "..");
// The server's secret key, when it was started with one in its environment rather than the checkout's .env: webui.ts
// takes it out of the environment once the server has it, and its successor needs it as much.
const SECRET_KEY = process.env.AGENTBOOK_SECRET_KEY;
const SETTLE_MS = Number(process.env.AGENTBOOK_RELOAD_SETTLE_MS || 2000);
const WAIT_MS = Number(process.env.AGENTBOOK_RELOAD_WAIT_MS || 10 * 60e3);
const RETRY_MS = Number(process.env.AGENTBOOK_RELOAD_RETRY_MS || 15e3);

// Whether a file a commit changed is code this process runs.
export const runs = (file: string) => (/^(plugin|server)\//.test(file) && !/\.md$/i.test(file)) || /^package(-lock)?\.json$/.test(file);

// The checkout this daemon starts itself again from as it changes, or null: run from a checkout's source (not the
// one-file build), with the person's own data.
export function reloadsFrom({ repo = REPO, home = HOME, env = process.env, bundled = BUNDLED }: { repo?: string; home?: string; env?: NodeJS.ProcessEnv; bundled?: boolean } = {}): string | null {
  if (env.AGENTBOOK_RELOAD === "0" || bundled) return null;
  if (!fs.existsSync(path.join(repo, "server", "main.ts")) || !fs.existsSync(path.join(repo, ".git"))) return null;
  if (git(repo, ["config", "--get", INSTALL_MARK]) === "clone") return null;
  const own = path.join(os.homedir(), ".agentbook");
  if (env.AGENTBOOK_RELOAD !== "1" && path.resolve(home) !== own && path.dirname(path.resolve(home)) !== path.join(own, "accounts")) return null;
  return repo;
}

function git(repo: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 10e3, env: { ...cleanEnv(), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
  return r.status === 0 ? r.stdout.trim() : null;
}

// What a start that failed said: its error's line, not the stack under it.
function whyItDied(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^at |^Node\.js v/.test(l));
  return (lines.find((l) => /^(\w*Error\b|agentbook-cli:)/.test(l)) || lines.pop() || "").slice(0, 400);
}

// Whether the checkout's code, as it stands, builds and starts. -> null, or why not
export async function checkCode(repo: string): Promise<string | null> {
  const entry = ["entry.ts", "plugin/main.ts"].find((f) => fs.existsSync(path.join(repo, f)));
  if (entry) {
    try {
      const esbuild = await import("esbuild");
      // iroh is native, and left out as build.ts leaves it out (plugin/shared/iroh.ts loads it where it's installed).
      await esbuild.build({ absWorkingDir: repo, entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node22", write: false, logLevel: "silent", external: ["@number0/iroh"], define: { AGENTBOOK_BUNDLE: "true" } });
    } catch (e) {
      const first = e.errors?.[0];
      return `it doesn't build: ${first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ""}` : e.message}`;
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-reload-"));
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "plugin", "cli", "main.mjs"), "--version"], { encoding: "utf8", timeout: 30e3, env: cleanEnv({ AGENTBOOK_HOME: path.join(tmp, "home") }) });
    if (r.status !== 0) return `it doesn't start: ${whyItDied(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`)}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return null;
}

// Its successor, started to wait until this process is gone (20 s at most), with the arguments and the person's
// environment this one was started with; then this one stops.
// `env`: what's different for it (the first run's, its account's folder).
export function startAgain({ argv = [...process.execArgv, process.argv[1], ...process.argv.slice(2)], log = CLI_LOG, env = {} }: { argv?: string[]; log?: string; env?: NodeJS.ProcessEnv } = {}) {
  const wait = 'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.2; i=$((i+1)); done; shift; exec "$@"';
  const out = openLog(log);
  spawn("/bin/sh", ["-c", wait, "agentbook-reload", String(process.pid), process.execPath, ...argv], { detached: true, stdio: ["ignore", out, out], env: cleanEnv({ ...(SECRET_KEY ? { AGENTBOOK_SECRET_KEY: SECRET_KEY } : {}), ...env }), cwd: os.homedir() }).unref();
  fs.closeSync(out);
  process.kill(process.pid, "SIGTERM");
}

interface WatchOpts {
  repo: string;
  // Whether an agent is mid-turn here.
  busy?: () => boolean;
  log?: (line: string) => void;
  check?: (repo: string) => Promise<string | null>;
  restart?: () => void;
  settleMs?: number;
  waitMs?: number;
  retryMs?: number;
}

// Watches the checkout's commit (git's own files: its HEAD, and the branches) and starts this process again on code
// that changed. -> { close() }, or null when it isn't a checkout git can read
export function watchCheckout({ repo, busy = () => false, log = () => {}, check = checkCode, restart = () => startAgain(), settleMs = SETTLE_MS, waitMs = WAIT_MS, retryMs = RETRY_MS }: WatchOpts) {
  const head = () => git(repo, ["rev-parse", "HEAD"]);
  const ran = head();
  const dirs = git(repo, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split("\n");
  if (!ran || dirs?.length !== 2) {
    log(`agentbook: can't read the commit of ${repo}, so it won't start again on new code there`);
    return null;
  }
  const [gitDir, commonDir] = dirs;
  const short = (c: string) => c.slice(0, 7);
  // The commit it waits to start again on, and since when. `failed`: the last one whose code didn't build or start.
  let pending: { to: string; since: number; files: number } | null = null;
  let failed: string | null = null;
  let settle: NodeJS.Timeout | null = null;
  let retry: NodeJS.Timeout | null = null;
  // A check under way: one at a time, so a commit landing meanwhile can't start a second successor.
  let checking = false;
  let closed = false;
  const watchers: fs.FSWatcher[] = [];

  function close() {
    closed = true;
    clearTimeout(settle);
    clearTimeout(retry);
    for (const w of watchers.splice(0)) w.close();
  }

  // git writes a ref, then renames it into place, often several in a row: it's read once they settle.
  function moved() {
    if (closed) return;
    clearTimeout(settle);
    settle = setTimeout(look, settleMs);
    settle.unref();
  }

  function look() {
    if (closed) return;
    const now = head();
    if (!now || now === failed) return;
    const changed = now === ran ? [] : git(repo, ["diff", "--name-only", ran, now])?.split("\n").filter(Boolean);
    // One git can't compare (history rewritten under it) counts as changed.
    const files = changed ? changed.filter(runs).length : 1;
    if (!files) {
      pending = null;
      return;
    }
    pending = { to: now, since: pending?.since ?? Date.now(), files };
    attempt();
  }

  async function attempt() {
    clearTimeout(retry);
    if (closed || !pending || checking) return;
    if (busy() && Date.now() - pending.since < waitMs) {
      retry = setTimeout(attempt, retryMs);
      retry.unref();
      return;
    }
    const { to, files } = pending;
    checking = true;
    let why: string | null;
    try {
      why = await check(repo);
    } catch (e) {
      why = e.message;
    } finally {
      checking = false;
    }
    if (closed) return;
    if (head() !== to) return moved();
    if (why) {
      failed = to;
      pending = null;
      log(`agentbook: ${short(to)} changed its code, but it can't start again on it: ${why}. It tries again at the next commit.`);
      return;
    }
    close();
    log(`agentbook: ${short(to)} changed its code (${files} file${files === 1 ? "" : "s"} since ${short(ran)}): starting again on it`);
    restart();
  }

  const watch = (dir: string, recursive: boolean, pick: (name: string) => boolean) => {
    try {
      watchers.push(fs.watch(dir, { persistent: false, recursive }, (_, name) => (!name || pick(String(name))) && moved()));
    } catch (e) {
      log(`agentbook: can't watch ${dir} for new code: ${e.message}`);
    }
  };
  watch(gitDir, false, (n) => n === "HEAD");
  watch(commonDir, false, (n) => n === "packed-refs");
  watch(path.join(commonDir, "refs", "heads"), true, () => true);
  log(`agentbook: runs ${short(ran)} of ${repo}, and starts again by itself when a commit there changes its code`);
  return { close };
}
