// Keeping up with a runtime by asking it now and then: `fn` every `ms` (its first time at once, unless `wait`), never
// two at once, and longer apart while it keeps failing (up to `max`), back to `ms` once it works. It doesn't keep
// agentbook-cli running by itself. `log` hears why it failed, and how long it waits before it tries again (ms).

export interface Poll {
  // Now, rather than at its next time.
  now(): Promise<void>;
  stop(): void;
}

export function poll(fn: () => unknown, ms: number, { wait = false, max = ms, log }: { wait?: boolean; max?: number; log?: (line: string, wait: number) => void } = {}): Poll {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let gap = ms;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run(), gap);
    timer.unref?.();
  };
  function run(): Promise<void> {
    if (running) return running;
    if (timer) clearTimeout(timer);
    running = (async () => {
      try {
        await fn();
        gap = ms;
      } catch (e) {
        gap = Math.min(max, gap * 2);
        log?.(e.message, gap);
      } finally {
        running = null;
        schedule();
      }
    })();
    return running;
  }
  if (wait) schedule();
  else void run();
  return {
    now: run,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
