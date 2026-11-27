#!/usr/bin/env node
// A process a test starts itself that isn't node (bin/agentbook-server's shell script, Chrome), run under this so it
// stops with the test (spawnTied in harness-tied.ts): when the test kills it (the signal comes over the IPC channel, and goes
// on to it, SIGKILL too), and when the test is gone without a word, as test/all.ts SIGKILLs one past its time limit
// (the channel closes). Then it stops as kill() would stop it, with what it started when it was started in a process
// group of its own (detached: what the test would kill as one), and is killed 5 s later if it hasn't.
// Run by spawnTied: node test/harness-tied-wrap.ts '{"cmd": ["command", ...args], "group": bool}', with the test's env and cwd.

import { spawn } from "node:child_process";

const { cmd: [cmd, ...args], group } = JSON.parse(process.argv[2]) as { cmd: string[]; group: boolean };
const child = spawn(cmd, args, { stdio: "inherit" });
// The test's signal, to what this runs. (Sent to this process group, it reaches both: this passes it on again.)
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
for (const sig of SIGNALS) process.on(sig, () => child.kill(sig));
process.on("message", (m) => {
  const signal = (m as { kill?: NodeJS.Signals } | null)?.kill;
  if (signal) child.kill(signal);
});
process.on("disconnect", () => {
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (group) process.kill(-process.pid, signal);
      else child.kill(signal);
    } catch {}
  };
  stop("SIGTERM");
  setTimeout(() => stop("SIGKILL"), 5000).unref();
});
// It ends as its process did, so the test sees the same exit.
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  for (const sig of SIGNALS) process.removeAllListeners(sig);
  process.kill(process.pid, signal);
});
child.on("error", (e) => {
  process.stderr.write(`harness-tied-wrap: ${cmd}: ${e.message}\n`);
  process.exit(1);
});
