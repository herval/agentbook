// A command a Claude Code session left running in the background (a dev server, a shell watching a CI run, a
// monitor): where what it prints goes, the end of that, and stopping it. Claude Code keeps what each one prints in a
// file of its own, <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output, and runs it in a process group of its
// own, whose shell holds that file open. So the file says which processes are its: nothing here goes by a command's
// words, or by a pid someone names.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OUT_MAX = 64 * 1024; // the end of what it printed, as the page shows it
const KILL_AFTER_MS = 4000; // how long it has to end on SIGTERM before SIGKILL

// Claude Code's ids for them are short and plain ("bnfcj88in"); anything else isn't one, and names no file.
const plainId = (id) => /^[A-Za-z0-9_-]{4,64}$/.test(String(id || ""));

// The file one's output goes to, or null: by its session's transcript (which names its project as Claude Code does)
// and its session id. `tmp`: where to look instead (a test's).
export function outputFile({ transcript, sessionId, id, tmp = null }) {
  if (!plainId(id) || !transcript || !/^[A-Za-z0-9-]{8,80}$/.test(String(sessionId || ""))) return null;
  const project = path.basename(path.dirname(transcript));
  if (!project || project === "." || project === "..") return null;
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  const bases = tmp ? [tmp] : [process.env.CLAUDE_CODE_TMPDIR, "/tmp", os.tmpdir()].filter(Boolean).map((b) => path.join(b, `claude-${uid}`));
  for (const base of bases) {
    const file = path.join(base, project, sessionId, "tasks", `${id}.output`);
    try {
      // A subagent's is a link to its transcript, which its worker's row reads: only a command's own file counts.
      if (fs.lstatSync(file).isFile()) return fs.realpathSync(file);
    } catch {}
  }
  return null;
}

// What a terminal would show of it: no colors or cursor moves, and of a line redrawn in place (a progress bar),
// what it said last.
export function plain(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n]*\r(?=[^\n])/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

// The end of a file: { text, size, cut (there was more before it), at (when it last printed) }.
export function tail(file, max = OUT_MAX) {
  const st = fs.statSync(file);
  const n = Math.min(st.size, max);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, n, st.size - n);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString("utf8");
  const cut = st.size > n;
  // From a whole line on, when it starts in the middle of one.
  if (cut) text = text.slice(text.indexOf("\n") + 1);
  return { text: plain(text), size: st.size, cut, at: st.mtime.toISOString() };
}

const sh = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, out) => resolve(String(out || ""))));

// The processes that hold a file open: lsof where there is one, else /proc (a Linux box without it).
async function holders(file) {
  const pids = new Set((await sh("lsof", ["-t", "--", file])).split(/\s+/).map(Number).filter((p) => p > 1));
  if (!pids.size && fs.existsSync("/proc/self/fd")) {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (fs.readdirSync(`/proc/${d}/fd`).some((f) => fs.readlinkSync(`/proc/${d}/fd/${f}`) === file)) pids.add(Number(d));
      } catch {}
    }
  }
  return [...pids];
}
const groupOf = async (pid) => Number((await sh("ps", ["-o", "pgid=", "-p", String(pid)])).trim()) || 0;
const alive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// Stop it: its process group ends on SIGTERM (a dev server's supervisor takes its services down with it), and on
// SIGKILL if it's still there a few seconds later. `spare`: pids that are never its own (its session's, this one):
// neither they nor their groups are touched, whatever holds the file. `sent`: called once it's been told to end,
// before the wait for it to be gone. -> { stopped: n } or { error }.
export async function stop(file: string, { spare = [], wait = KILL_AFTER_MS, sent: onSent = null }: { spare?: number[]; wait?: number; sent?: (() => void) | null } = {}) {
  const keep = new Set([process.pid, ...spare].filter(Boolean).map(Number));
  const keepGroups = new Set<number>();
  for (const p of keep) keepGroups.add(await groupOf(p));
  const targets = new Set<number>(); // negative: a group; positive: one process
  for (const pid of await holders(file)) {
    if (keep.has(pid)) continue;
    const g = await groupOf(pid);
    targets.add(g > 1 && !keepGroups.has(g) ? -g : pid); // in its session's own group: only itself
  }
  if (!targets.size) return { error: "Nothing holds its output anymore: it has ended, or agentbook can't find its process." };
  let sent = 0;
  for (const t of targets) {
    try {
      process.kill(t, "SIGTERM");
      sent++;
    } catch {}
  }
  if (!sent) return { error: "agentbook couldn't stop it: its process isn't this account's." };
  onSent?.();
  const until = Date.now() + wait;
  while (Date.now() < until && [...targets].some(alive)) await new Promise((r) => setTimeout(r, 150));
  for (const t of targets) {
    if (!alive(t)) continue;
    try {
      process.kill(t, "SIGKILL");
    } catch {}
  }
  return { stopped: targets.size };
}
