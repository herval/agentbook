// Claude Code's sessions from before agentbook followed it, for the welcome card (plugin/cli/history.ts): its
// transcripts under <config>/projects, each one's id, when it was last written to and its folder; and, for those its
// person picks, an ended thread each, as if its hooks had said so as it ran: its prompts and closing words as its
// messages, its steps and title from its transcript, as a live session's are.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { bird, gitInfo } from "../../../lib/common.ts";
import { typedPart } from "../../../shared/text.ts";
import { agentDirectory } from "../../agent-context.ts";
import type { PastSession } from "../runtime.ts";
import type { ClaudeHost } from "./host.ts";

// How much of a transcript's start says its folder: every entry carries it, the first ones come early.
const HEAD = 64 * 1024;
// The turns whose words come in, of a long session: its first ones (what it set out to do) and its last (how it
// ended). Its steps all come, from its transcript, as the page asks for them.
const FIRST_TURNS = 3;
const LAST_TURNS = 7;
const TEXT_MAX = 6000;
const HOST = os.hostname().split(".")[0];

interface Turn {
  at: string;
  human: string;
  reply?: string;
  replyAt?: string;
}

export function createClaudePast(h: Pick<ClaudeHost, "state" | "commit" | "transcripts" | "saveSnapshot" | "log">, agent: () => string) {
  const { state, commit, transcripts, saveSnapshot, log } = h;
  const files = new Map<string, string>(); // session id -> its transcript
  const heads = new Map<string, { mtime: number; cwd: string | null }>(); // transcript -> its folder, as last read
  // Its config folder, as the runtime it's part of was made with (an agent's own, or ~/.claude).
  const config = agentDirectory("claude-code");
  const projects = () => path.join(config, "projects");

  async function list(): Promise<PastSession[]> {
    const out: PastSession[] = [];
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(projects());
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path.join(projects(), d);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl") && !n.startsWith("agent-"));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(dir, n);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        const id = n.slice(0, -".jsonl".length);
        const cwd = folderOf(file, st.mtimeMs);
        // One with no folder said nothing yet: Claude Code writes a transcript's entries with theirs.
        if (!cwd) continue;
        files.set(id, file);
        out.push({ id, at: st.mtimeMs, cwd });
      }
      await new Promise((r) => setImmediate(r));
    }
    return out;
  }

  function folderOf(file: string, mtime: number): string | null {
    const had = heads.get(file);
    if (had && had.mtime === mtime) return had.cwd;
    let cwd: string | null = null;
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(HEAD);
      const n = fs.readSync(fd, buf, 0, HEAD, 0);
      fs.closeSync(fd);
      const m = buf.subarray(0, n).toString("utf8").match(/"cwd":("(?:[^"\\]|\\.)*")/);
      if (m) cwd = JSON.parse(m[1]);
    } catch {}
    heads.set(file, { mtime, cwd });
    return cwd;
  }

  // Each, newest first, as an ended thread. A session that became a thread meanwhile (it was resumed, and said hello)
  // is left as it is.
  async function bring(ids: string[]) {
    for (const id of ids) {
      if (state.sessions[id]) continue;
      const file = files.get(id);
      if (!file) continue;
      try {
        await one(id, file);
      } catch (e) {
        log(`history: claude ${id}: ${e.message}`);
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  async function one(id: string, file: string) {
    const turns: Turn[] = [];
    let cwd: string | null = null;
    let branch: string | null = null;
    let first: string | null = null;
    let last: string | null = null;
    const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.startsWith('{"') || !/"type":"(user|assistant)"/.test(line)) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.isSidechain || e.isMeta || (e.type !== "user" && e.type !== "assistant")) continue;
      if (e.timestamp) {
        first ||= e.timestamp;
        last = e.timestamp;
      }
      cwd ||= e.cwd || null;
      if (e.gitBranch) branch = e.gitBranch;
      const content = e.message?.content;
      if (e.type === "user") {
        const text = typeof content === "string" ? content : Array.isArray(content) && !content.some((b) => b?.type === "tool_result") ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
        const typed = typedPart(text);
        if (typed) turns.push({ at: e.timestamp || last, human: typed.slice(0, TEXT_MAX) });
      } else if (turns.length && Array.isArray(content)) {
        const said = content.filter((b) => b?.type === "text" && b.text?.trim()).map((b) => b.text).join("\n").trim();
        if (said) Object.assign(turns.at(-1), { reply: said.slice(0, TEXT_MAX), replyAt: e.timestamp || last });
      }
    }
    // Nothing typed in it: nothing to show (and a thread with nothing in it goes as it ends).
    if (!turns.length || state.sessions[id]) return;
    const g = cwd ? gitOf(cwd) : { root: "", repo: "", branch: "" };
    const proc = `past-${id}`;
    commit({
      t: "session.hello",
      proc,
      agent: agent(),
      agent_name: state.agents[agent()]?.name || "Claude",
      kind: "claude-code",
      label: bird(id),
      session_id: id,
      transcript: file,
      cwd: cwd || undefined,
      root: g.root || undefined,
      repo: g.repo || undefined,
      branch: branch || g.branch || undefined,
      host: HOST,
      started: first || undefined,
      updated: last || undefined,
      prompt: turns[0].human.slice(0, 2000),
    });
    const s = state.sessions[state.procs[proc]] || state.sessions[id];
    if (!s) return;
    const kept = turns.length > FIRST_TURNS + LAST_TURNS ? [...turns.slice(0, FIRST_TURNS), ...turns.slice(-LAST_TURNS)] : turns;
    kept.forEach((t, i) => {
      commit({ t: "message.add", post: s.id, from: "human", via: "terminal", text: t.human, when: t.at, ext: `past:${i}h` });
      if (t.reply) commit({ t: "message.add", post: s.id, from: "agent", via: "terminal", text: t.reply, when: t.replyAt || t.at, ext: `past:${i}a` });
    });
    if (transcripts.digest(s)) saveSnapshot(state.sessions[s.id], true);
    transcripts.forget(s.id);
    commit({ t: "session.gone", post: s.id, reason: "Ended", ended: last || undefined });
  }

  const gits = new Map<string, ReturnType<typeof gitInfo>>();
  const gitOf = (cwd: string) => {
    if (!gits.has(cwd)) gits.set(cwd, fs.existsSync(cwd) ? gitInfo(cwd) : { root: "", repo: "", branch: "" });
    return gits.get(cwd);
  };

  // How many days Claude Code keeps a session's transcript: its cleanupPeriodDays, 30 unless it says.
  function keeps(): number | null {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(config, "settings.json"), "utf8")).cleanupPeriodDays;
      if (Number.isFinite(n) && n > 0) return n;
    } catch {}
    return 30;
  }

  return { list, bring, agent, keeps };
}
