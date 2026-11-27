// Loaded first (--import) into a node process a test started with spawnTied (harness-tied.ts), so it stops with the test:
// once the test is gone without a word, as test/all.ts SIGKILLs one past its time limit, the IPC channel to it closes,
// and this process is sent SIGTERM, with its process group when it was started in one of its own (?group=1: detached,
// what the test would kill as one), and SIGKILL 5 s later if it's still there. Nothing else changes: its pid, its
// signals, how long it runs. In a process without the channel (one it starts in turn, with its flags) it does nothing.

if (process.channel) {
  const group = new URL(import.meta.url).searchParams.get("group") === "1";
  process.once("disconnect", () => {
    const stop = (signal: NodeJS.Signals) => process.kill(group ? -process.pid : process.pid, signal);
    setTimeout(() => stop("SIGKILL"), 5000).unref();
    stop("SIGTERM");
  });
  // The channel keeps it running no longer than it would run without it.
  process.channel.unref();
}
