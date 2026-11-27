// News on the bell: what a thread of yours did that's worth hearing about when you aren't watching it, a line each
// under the bell from when it happens until you next open the bell (main.ts, addedFor). Three things make one:
// - a long turn ended (`turn`): its verdict's line, or its reply's first, made short (brief), when the turn took TURN_MS or more and you
//   hadn't opened the thread in the minutes before. One that ended needing you, or that an error stopped, is on
//   Needs you already.
// - one of its pull requests merged, was closed, or went bad (`pr`): checks failing, changes asked for, conflicts.
//   The line is the one its thread got (pulls.ts, prChanges).
// - its agent said so (`flag`): ab_update with notify, once a turn.
// Everything else a thread does stays on the thread.

import { LIMITS } from "../plugin/shared/shapes.ts";
import { conversationOf } from "../plugin/shared/store.ts";
import type { Iso, NewsItem, PrLineKind, Verdict } from "../plugin/shared/types.ts";
import type { Device } from "./relay.ts";

export const NEWS_KINDS: NewsItem["kind"][] = ["turn", "pr", "flag"];
// What a turn's reply is read from: a thread's messages (store.ts's conversationOf).
interface Said {
  from: string;
  at: Iso;
  text?: string;
  queued?: boolean;
  command?: string;
  via?: string | null;
  shape?: { verdict?: Pick<Verdict, "kind" | "line"> | null } | null;
}
// A turn's news, before it's a thread's.
type TurnNews = Pick<NewsItem, "kind" | "text" | "verdict" | "mins">;
// A line as it's added to someone's news: the store says when.
type NewsAdd = Omit<NewsItem, "at">;
// A machine's op, as news reads it (protocol.ts's session.status and session.update).
interface HeardOp {
  t: string;
  post?: string;
  turn?: string;
  changes?: unknown;
  text?: string;
  pr?: { kind?: PrLineKind; url?: string; number?: number | null } | null;
  notify?: boolean;
  link?: string | null;
  at?: Iso;
}
export interface NewsHost {
  commit: (op: { t: "news.add"; user: string; items: NewsAdd[] }) => unknown;
  ownerOf: (D: Device) => { id: string } | null;
  idOf: (D: Device, local: string) => string;
  hidden?: (uid: string, id: string) => boolean;
  newsOf?: (uid: string) => NewsItem[];
  turnMs?: number;
  waitMs?: number;
  log?: (line: string) => void;
}
// The kinds of a pull request's lines that are news: not a comment, a draft made ready, or checks passing again.
const PR_NEWS = new Set(["merged", "closed", "fail"]);
// The verdicts a turn ends on that Needs you lists (store.ts, endedAsking).
const ASKING = new Set(["needs_you", "blocked"]);
const LINE_MAX = 240;
// What the bell says of it: a short line, whole. Agents are asked for one this short (ab_verdict's line, ab_update with
// notify).
export const BELL_MAX = LIMITS.bell;

// A line short enough for the bell, never cut mid-sentence: the text itself when it fits; else its first sentences
// that do; else its first sentence up to its last clause that does (", 4 per day" dropped, not half of it). "" when
// not even a clause fits: a turn then says only that it finished.
export function brief(text: unknown, max = BELL_MAX): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const sentences = t.split(/(?<=[.!?…])\s+(?=[^a-z\s])/);
  let out = "";
  for (const s of sentences) {
    if ((out ? out.length + 1 : 0) + s.length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out) return out;
  // A clause ends at a comma, semicolon, colon or dash that a space follows, or before an opening bracket.
  let cut = 0;
  for (const m of sentences[0].matchAll(/[,;:](?=\s)|\s[—–-](?=\s)|\s(?=\()/g)) {
    if (m.index > max) break;
    cut = m.index;
  }
  return cut >= 24 ? sentences[0].slice(0, cut).trimEnd() : "";
}
// One that must say something (a pull request's line, what an agent flagged): at worst cut at a word.
const briefOr = (text: unknown, max = BELL_MAX): string => brief(text, max) || `${String(text).replace(/\s+/g, " ").trim().slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
// What's kept of a thread's news as its person's bell says it: lines kept before they were made short, too.
export const bellLine = (x: Pick<NewsItem, "kind" | "text">): string => (x.kind === "turn" ? brief(x.text) : briefOr(x.text));

// A reply's first line, in plain words, for a turn that ended without a verdict.
export function firstLine(text: unknown): string {
  const line = String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n")
    .map((l) => l.replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]{1,3}/g, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1).trimEnd()}…` : line;
}

// What a turn that ended is worth saying of, or null. `s`: its post; `said`: its conversation; `started`, `ended`:
// the turn's; `open`: whether it has a question waiting for you.
export function turnNews(s: { archived?: boolean; failed?: unknown }, said: Said[], { started, ended, open = false, min }: { started: Iso; ended: Iso; open?: boolean; min: number }): TurnNews | null {
  const took = Date.parse(ended) - Date.parse(started);
  if (!(took >= min) || s.archived || s.failed || open) return null;
  // Its reply: the last thing its agent said in the turn, or just after it (the hook that ends a turn posts it).
  const upto = new Date(Date.parse(ended) + 30e3).toISOString();
  const m = said.filter((x) => x.from === "agent" && !x.queued && !x.command && x.via !== "side" && x.at >= started && x.at <= upto).at(-1);
  const v = m?.shape?.verdict || null;
  if (v && ASKING.has(v.kind)) return null;
  return { kind: "turn", text: brief(v?.line ? String(v.line).slice(0, LINE_MAX) : firstLine(m?.text)), verdict: v?.kind || null, mins: Math.round(took / 60e3) };
}

// `commit`: the server's store's. `ownerOf(D)`: a machine's person. `idOf(D, local)`: a post's id on the page.
// `hidden(uid, id)`: whether a thread of theirs is kept off their lists (Private terminals). `newsOf(uid)`: what they
// have already. `turnMs`: how long a turn takes to be news; `waitMs`: how long after a turn ends its reply is waited for.
export function createNews({ commit, ownerOf, idOf, hidden = () => false, newsOf = () => [], turnMs = 600e3, waitMs = 3000, log = () => {} }: NewsHost) {
  const looked = new Map<string, number>(); // "uid|post" -> when a page of theirs last opened the thread
  const pending = new Map<string, ReturnType<typeof setTimeout>>(); // post -> the timer of a turn that ended, waiting for its reply
  const LOOKED_MS = Math.min(120e3, turnMs);

  const add = (uid: string, item: NewsAdd) => commit({ t: "news.add", user: uid, items: [item] });

  function turnEnded(D: Device, local: string, turn: { started: Iso; ended: Iso }, again = false): void {
    const id = idOf(D, local);
    pending.delete(id);
    const s = D.store.state.sessions[local];
    const uid = ownerOf(D)?.id;
    if (!s || !uid || hidden(uid, id)) return;
    const said = conversationOf(D.store.state, local);
    const open = D.store.state.questions.some((q) => q.post === local && !q.answered);
    const n = turnNews(s, said, { ...turn, open, min: turnMs });
    if (!n) return;
    // Its reply isn't here yet (a slow hook): once more, then it's said without one.
    if (!n.text && !again) return void wait(id, () => turnEnded(D, local, turn, true), waitMs * 3);
    if (Date.parse(turn.ended) - (looked.get(`${uid}|${id}`) || 0) < LOOKED_MS) return;
    log(`news: ${s.label} (${id}) ended a ${n.mins}-minute turn`);
    add(uid, { ...n, post: id, key: `turn|${id}|${turn.started}` });
  }
  function wait(id: string, fn: () => void, ms: number) {
    clearTimeout(pending.get(id));
    const t = setTimeout(fn, ms);
    t.unref?.();
    pending.set(id, t);
  }

  return {
    // A page of theirs opened a thread: a turn of it that ends in the next minutes isn't news to them.
    looked(uid: string | null | undefined, id: string | null | undefined) {
      if (uid && id) looked.set(`${uid}|${id}`, Date.now());
      if (looked.size > 5000) for (const k of [...looked.keys()].slice(0, 2500)) looked.delete(k);
    },
    // A machine's op, once its store has it.
    hear(D: Device, op: HeardOp | null | undefined) {
      if (!op?.post) return;
      const s = D.store.state.sessions[op.post];
      const uid = ownerOf(D)?.id;
      if (!s || !uid) return;
      const id = idOf(D, op.post);
      if (op.t === "session.status" && op.turn === "end" && s.turn_started && s.turn_ended) {
        const turn = { started: s.turn_started, ended: s.turn_ended };
        if (Date.parse(turn.ended) - Date.parse(turn.started) >= turnMs) wait(id, () => turnEnded(D, op.post, turn), waitMs);
        return;
      }
      if (op.t !== "session.update" || op.changes || !op.text || s.archived || hidden(uid, id)) return;
      if (op.pr) {
        // Each thread that links it gets the line; the bell says it once (`key`).
        if (PR_NEWS.has(op.pr.kind)) add(uid, { kind: "pr", post: id, text: briefOr(String(op.text).slice(0, LINE_MAX)), pr: { url: String(op.pr.url || ""), number: op.pr.number ?? null, kind: op.pr.kind }, key: `pr|${String(op.pr.url || "").toLowerCase()}|${op.text}` });
        return;
      }
      if (op.notify !== true) return;
      // Once a turn, whatever its machine let through.
      if (newsOf(uid).some((x) => x.kind === "flag" && x.post === id && s.turn_started && x.at >= s.turn_started)) return;
      add(uid, { kind: "flag", post: id, text: briefOr(String(op.text).slice(0, LINE_MAX)), link: /^https?:\/\//.test(op.link || "") ? String(op.link).slice(0, 500) : null, key: `flag|${id}|${op.at || ""}|${op.text}` });
    },
  };
}
