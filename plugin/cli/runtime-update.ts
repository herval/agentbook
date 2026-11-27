// A runtime's app updated on this machine, once a newer version is out (its Agents table, on Your machines). The
// machine owns what runs: the page names a runtime, never a command, a package or a version.
//
// The newest version is the runtime's npm package's dist-tag. Claude Code and Codex publish there with every release,
// however a machine installed them (their own installers, Homebrew, npm), so one lookup serves each install; an app
// that isn't on npm says its newest itself (Grok's `grok update --check`). It's looked up when the page reads the
// machine's runtimes, at most every few hours, rather than on a timer: nobody sees the answer anywhere else. The
// update is the app's own command (`claude update`, `codex update`, `grok update`), which knows how it was installed
// and goes through it.
import { spawn } from "node:child_process";
import path from "node:path";
import { isVersion, olderVersion } from "../lib/common.ts";
import type { RuntimeUpdate } from "../shared/runtimes.ts";
import type { Runtime } from "./runtimes/runtime.ts";

const CHECK_MS = 6 * 3600e3;
const RETRY_MS = 10 * 60e3;
const TIMEOUT_MS = 15 * 60e3;
const OUTPUT = 16000;

type Job = Pick<RuntimeUpdate, "state" | "started" | "finished" | "from" | "output" | "error">;
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });
// A version's numbers ("0.172.0" of "0.172.0-alpha.1"), which is what's compared.
const core = (v: string | null | undefined) => /^\d+(\.\d+)*/.exec(String(v || ""))?.[0] || null;
export const isOlder = (v: string | null | undefined, than: string | null | undefined) => !!(core(v) && core(than) && olderVersion(core(v), core(than)));

// A program run to its end, what it prints going to `output`. Its stdin is closed, so one that asks a question gets
// no answer and says so; the abort kills its whole process group.
export function runCommand(bin: string, args: string[], { output, signal, env }: { output: (text: string) => void; signal: AbortSignal; env: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    output(`$ ${path.basename(bin)} ${args.join(" ")}\n`);
    // Its last line, which says why when it fails.
    let last = "";
    const said = (b: Buffer) => {
      const text = b.toString();
      last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) || last;
      output(text);
    };
    const child = spawn(bin, args, { env: { ...env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", said);
    child.stderr.on("data", said);
    child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? new Error(`There's no ${path.basename(bin)} command here.`) : e));
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} ${args.join(" ")} ${code == null ? "stopped before it finished" : `exited ${code}`}${last ? `: ${last.slice(0, 300)}` : "."}`));
    });
  });
}

export function createRuntimeUpdater({ runtimes, changed = () => {}, log = () => {}, request = fetch, now = Date.now }: {
  // This machine's runtimes: those with an update facet are the ones it updates, the first of each kind (an agent of
  // another config folder runs the same app).
  runtimes: () => Runtime[];
  changed?: () => void;
  log?: (line: string) => void;
  request?: typeof fetch;
  now?: () => number;
}) {
  // The newest version of each package on each tag, when it was looked up, and why the last lookup failed.
  const latest = new Map<string, { version: string | null; at: number; error?: string }>();
  const looking = new Map<string, Promise<void>>();
  const jobs: Record<string, Job> = {};
  let active: { kind: string; controller: AbortController } | null = null;
  let closed = false;
  const updatable = () => runtimes().filter((r, i, all) => r.update && all.findIndex((x) => x.id === r.id) === i);
  const runtime = (kind: string) => updatable().find((r) => r.id === kind);
  const keyOf = (rt: Runtime) => (rt.update.pkg ? `${rt.update.pkg}@${rt.update.tag?.() || "latest"}` : rt.id);
  const off = (rt: Runtime) => rt.health().enabled === false || rt.row?.().status === "Off";

  async function lookup(pkg: string, tag: string) {
    const res = await request(`${process.env.AGENTBOOK_NPM_REGISTRY || "https://registry.npmjs.org"}/-/package/${pkg}/dist-tags`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10e3) });
    if (!res.ok) throw new Error(`npm said HTTP ${res.status} for ${pkg}`);
    const body = await res.text();
    if (body.length > 1e6) throw new Error(`npm's dist-tags for ${pkg} are too large`);
    const v = JSON.parse(body)?.[tag];
    if (!isVersion(v)) throw new Error(`npm has no ${tag} version of ${pkg}`);
    return v;
  }
  // Looks up the newest version of each runtime that's here, when what it has is older than a few hours (a failed
  // lookup's: a few minutes), and answers once they're all in.
  function check() {
    const asked: Promise<void>[] = [];
    for (const rt of updatable()) {
      if (off(rt) || !rt.update.version()) continue;
      const key = keyOf(rt);
      const had = latest.get(key);
      if (had && now() - had.at < (had.error ? RETRY_MS : CHECK_MS)) continue;
      if (!looking.has(key)) {
        const [pkg, tag] = [rt.update.pkg, rt.update.tag?.() || "latest"];
        const newest = rt.update.newest
          ? rt.update.newest().then((v) => {
              if (!isVersion(v)) throw new Error(`${rt.info.name} didn't say a version it has`);
              return v;
            })
          : lookup(pkg, tag);
        looking.set(key, newest
          .then((version) => {
            if (had?.version !== version) changed();
            latest.set(key, { version, at: now() });
          })
          .catch((e) => {
            latest.set(key, { version: had?.version ?? null, at: now(), error: e.message });
            log(`${rt.id}: couldn't look up its newest version: ${e.message}`);
          })
          .finally(() => looking.delete(key)));
      }
      asked.push(looking.get(key));
    }
    return Promise.all(asked).then(() => {});
  }
  function info(kind: string): RuntimeUpdate | undefined {
    const rt = runtime(kind);
    if (!rt || off(rt)) return;
    const version = rt.update.version();
    const newest = latest.get(keyOf(rt))?.version ?? null;
    const job = jobs[kind];
    const outdated = isOlder(version, newest);
    const wait = outdated && job?.state !== "updating" ? rt.update.wait?.() : null;
    return { version, latest: newest, outdated, state: "idle", ...job, ...(wait ? { wait } : {}) };
  }

  function start(kind: string) {
    const rt = runtime(kind);
    if (!rt) throw refusal(400, "agentbook can't update that agent here.");
    if (closed) throw refusal(503, "Agentbook is stopping. Try again once it is back.");
    if (active?.kind === kind) return info(kind);
    if (active) throw refusal(409, `${runtime(active.kind)?.info.name || active.kind} is updating on this machine. Wait for it to finish.`);
    const name = rt.info.name;
    if (off(rt)) throw refusal(409, `${name} is off on this machine.`);
    // Only what this machine itself sees is behind: a page can't have it run an update it has no reason for.
    const from = rt.update.version();
    const newest = latest.get(keyOf(rt))?.version;
    if (!from) throw refusal(409, `agentbook hasn't read ${name}'s version here yet.`);
    if (!isOlder(from, newest)) throw refusal(409, `${name} ${from} is the newest version agentbook knows of.`);
    const wait = rt.update.wait?.();
    if (wait) throw refusal(409, wait);
    const job: Job = (jobs[kind] = { state: "updating", started: new Date(now()).toISOString(), from, output: "" });
    const controller = new AbortController();
    active = { kind, controller };
    changed();
    const output = (text: string) => {
      job.output = (job.output + text).slice(-OUTPUT);
    };
    const timer = setTimeout(() => controller.abort(new Error(`The update took longer than ${TIMEOUT_MS / 60e3} minutes and was stopped.`)), TIMEOUT_MS);
    void rt.update
      .run(output, controller.signal)
      .then(() => {
        controller.signal.throwIfAborted();
        job.state = "updated";
        const after = rt.update.version();
        output(`\n${after && after !== from ? `${name} is ${after} now.` : `${name} is still ${after || from || "on the same version"}.`}\n`);
      })
      .catch((error) => {
        job.state = "failed";
        job.error = (controller.signal.aborted ? controller.signal.reason?.message : error.message) || "The update failed.";
        output(`\n${job.error}\n`);
      })
      .finally(() => {
        clearTimeout(timer);
        active = null;
        job.finished = new Date(now()).toISOString();
        changed();
        log(`${kind}: update ${job.state}${job.error ? `: ${job.error}` : ""} (${from || "?"} -> ${rt.update.version() || "?"})`);
      });
    return info(kind);
  }

  return {
    info,
    start,
    check,
    busy: () => !!active,
    close() {
      closed = true;
      active?.controller.abort(new Error("Agentbook stopped during the update. Update again to finish it."));
    },
  };
}
