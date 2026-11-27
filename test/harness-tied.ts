// spawnTied, for a test that starts a process itself rather than through spawnAgentbook (harness.ts), which ties its own.

import { type ChildProcess, type SpawnOptions, type StdioOptions, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A process the test starts itself, as spawn(cmd, args, opts) would, but stopping with the test however it ends, killed
// past test/all.ts's time limit too. Started straight from the test, it would run on, holding its port, for as long as
// the machine stays up. A node process (process.execPath) sees to that itself (harness-tied-node.ts, loaded first), so
// its pid, process group and signals are spawn's; anything else (a shell script, Chrome) runs under harness-tied-wrap.ts,
// whose pid it is, and kill() sends its signal through it, SIGKILL too. One started detached, in a process group of its
// own, goes with that group.
export function spawnTied(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const io = opts.stdio ?? "pipe";
  const stdio = [...(Array.isArray(io) ? io : [io, io, io]), "ipc"] as StdioOptions;
  if (cmd === process.execPath) {
    const tie = pathToFileURL(path.join(HERE, "harness-tied-node.ts"));
    if (opts.detached) tie.search = "group=1";
    const child = spawn(cmd, ["--import", tie.href, ...args], { ...opts, stdio });
    child.channel?.unref?.();
    return child;
  }
  const child = spawn(process.execPath, [path.join(HERE, "harness-tied-wrap.ts"), JSON.stringify({ cmd: [cmd, ...args], group: !!opts.detached })], { ...opts, stdio });
  const kill = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    if (!child.connected) return kill(signal);
    child.send({ kill: signal }, (e) => e && kill(signal));
    return true;
  };
  child.channel?.unref?.();
  return child;
}
