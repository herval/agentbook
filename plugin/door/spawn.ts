// Starting your door (plugin/door/main.ts) as a process of its own, held to its folder by Node's permission model:
// it reads its own code, what it shares with the page (plugin/shared/door/, and SQLite's quiet loader), the relay's
// certificate checks (plugin/shared/relay-verify.ts) and the iroh package, and reads and writes only its folder; no
// child processes, no workers, no code from strings. Its environment has nothing of the page's. It stops when the
// process that started it does (its stdin closes). agentbook-cli hands it to the page (plugin/shared/door/process.ts).

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DoorProcess, DoorStart } from "../shared/door/process.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "main.ts");
const VERIFY = path.join(HERE, "..", "shared", "relay-verify.ts");
const SHARED = path.join(HERE, "..", "shared", "door");
const SQLITE = path.join(HERE, "..", "shared", "storage", "sqlite.ts");

// Where @number0/iroh is, as this checkout resolves it: null when it isn't installed.
export function irohModule(): string | null {
  try {
    return createRequire(import.meta.url).resolve("@number0/iroh");
  } catch {
    return null;
  }
}

export type { DoorProcess } from "../shared/door/process.ts";

export function spawnDoor(o: DoorStart): (DoorProcess & { child: ChildProcess }) | null {
  const mod = irohModule();
  if (!mod) {
    o.log("door: iroh isn't installed here (npm install), so there's no door");
    return null;
  }
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  // The iroh package and its native half sit side by side, under @number0.
  const irohDir = path.dirname(path.dirname(mod));
  const flags = [
    "--permission",
    `--allow-fs-read=${o.dir}/*`,
    `--allow-fs-write=${o.dir}/*`,
    `--allow-fs-read=${HERE}/*`,
    `--allow-fs-read=${VERIFY}`,
    `--allow-fs-read=${SHARED}/*`,
    `--allow-fs-read=${SQLITE}`,
    `--allow-fs-read=${irohDir}/*`,
    "--allow-addons",
    "--disallow-code-generation-from-strings",
    "--disable-warning=SecurityWarning",
    "--disable-warning=ExperimentalWarning",
  ];
  if (o.iroh.mode === "local") flags.push(`--allow-fs-read=${o.iroh.dir}/*`, `--allow-fs-write=${o.iroh.dir}/*`);
  const args = [...flags, MAIN, "--dir", o.dir, "--account", o.account, "--relay", o.relay, "--iroh", o.iroh.mode, "--iroh-module", pathToFileURL(mod).href];
  if (o.iroh.mode === "local") args.push("--iroh-dir", o.iroh.dir);
  else args.push("--iroh-relay", o.iroh.relay);
  if (o.probe) args.push("--probe", o.probe);
  args.push(...(o.extra ?? []));
  // Only what Node needs to run: none of the page's settings or secrets.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG };
  const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = (b: Buffer) => {
    for (const l of b.toString().split("\n")) if (l.trim()) o.log(l.trim());
  };
  child.stdout?.on("data", lines);
  child.stderr?.on("data", lines);
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return {
    child,
    pid: child.pid,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode) return;
      child.stdin?.end();
      const t = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(t);
    },
  };
}
