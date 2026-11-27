// A thread's life, for the strip at the bottom of its card: when it worked, when it
// waited on you, and a mark for each result, pull request, picture and message of yours along the way. Made from
// what agentbook keeps of it: its messages' times (a turn runs from your message to its agent's reply), its
// questions' (asked, then answered), its results' and its files'. No new tool.

import type { FileRecord, Iso, Message, Question, Session, SessionUpdate, ThreadLife } from "./types.ts";

// What a thread's life is made of besides the thread: its messages, questions and files.
interface LifeParts {
  messages?: (Pick<Message, "from" | "at"> & Partial<Pick<Message, "text" | "queued">>)[];
  questions?: (Pick<Question, "post" | "asked"> & Partial<Pick<Question, "answered">>)[];
  files?: (Pick<FileRecord, "name" | "at"> & Partial<Pick<FileRecord, "from" | "title">>)[];
}
type LifeThread = Pick<Session, "id"> & Partial<Pick<Session, "started" | "busy" | "turn_started" | "turn_ended" | "updated" | "state" | "rev">> & { updates?: (Pick<SessionUpdate, "at" | "text"> & { pr?: Partial<SessionUpdate["pr"]>; changes?: Partial<SessionUpdate["changes"]> })[] };

const PICTURE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const isPicture = (f: { name?: string | null; type?: string | null } | null | undefined): boolean => PICTURE.test(f?.name || "") || /^image\//.test(f?.type || "");

export const LIFE = { spans: 40, waits: 12, marks: 30, text: 80 };
const short = (t: unknown): string => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > LIFE.text ? `${s.slice(0, LIFE.text - 1)}…` : s;
};
const ms = (t: Iso | null): number => Date.parse(t) || 0;

// Spans [from, to] in order, the closest ones joined until there are at most `max`. `to` null: still going.
type Span = [Iso, Iso | null];
function joinSpans(spans: Span[], max: number): Span[] {
  const out = [...spans].sort((a, b) => ms(a[0]) - ms(b[0]));
  const merged: Span[] = [];
  for (const sp of out) {
    const last = merged.at(-1);
    // Overlapping, or under a minute apart: one stretch.
    if (last && last[1] != null && ms(sp[0]) - ms(last[1]) < 60e3) last[1] = sp[1] == null ? null : ms(sp[1]) > ms(last[1]) ? sp[1] : last[1];
    else if (last && last[1] == null) continue;
    else merged.push([sp[0], sp[1]]);
  }
  while (merged.length > max) {
    let k = 0;
    for (let i = 1; i < merged.length - 1; i++) if (ms(merged[i + 1][0]) - ms(merged[i][1]) < ms(merged[k + 1][0]) - ms(merged[k][1])) k = i;
    merged.splice(k, 2, [merged[k][0], merged[k + 1][1]]);
  }
  return merged;
}

// `s`: the thread; its messages, questions and files, any order. -> { work, wait, marks } or null with nothing to draw.
export function lifeOf(s: LifeThread | null | undefined, { messages = [], questions = [], files = [] }: LifeParts = {}): ThreadLife | null {
  if (!s?.started) return null;
  const said = messages.filter((m) => !m.queued && m.at).sort((a, b) => ms(a.at) - ms(b.at));
  const work: Span[] = [];
  // It starts working on its prompt, as it starts.
  let open = s.started;
  for (const m of said) {
    if (m.from === "human") open ||= m.at;
    else if (open) {
      if (ms(m.at) >= ms(open)) work.push([open, m.at]);
      open = null;
    }
  }
  if (s.busy || s.state === "working") work.push([open || s.turn_started || s.updated, null]);
  else if (open && s.turn_ended && ms(s.turn_ended) > ms(open)) work.push([open, s.turn_ended]);
  const wait = questions
    .filter((q) => q.asked && q.post === s.id)
    .map((q): Span => [q.asked, typeof q.answered === "string" ? q.answered : null])
    .sort((a, b) => ms(a[0]) - ms(b[0]))
    .slice(-LIFE.waits);
  const marks: ThreadLife["marks"] = [];
  for (const u of s.updates || []) {
    if (u.changes || !u.at) continue;
    marks.push({ at: u.at, k: u.pr ? (u.pr.kind === "merged" ? "merge" : "pr") : "result", t: short(u.text) });
  }
  // Pictures posted together (a minute apart) are one mark.
  const pics = files.filter((f) => f.from !== "human" && f.at && isPicture(f)).sort((a, b) => ms(a.at) - ms(b.at));
  for (let i = 0; i < pics.length; ) {
    let j = i + 1;
    while (j < pics.length && ms(pics[j].at) - ms(pics[j - 1].at) < 60e3) j++;
    marks.push({ at: pics[i].at, k: "pic", t: j - i > 1 ? `${j - i} pictures` : short(pics[i].title || pics[i].name) });
    i = j;
  }
  for (const m of said) if (m.from === "human" && m.text) marks.push({ at: m.at, k: "you", t: short(m.text) });
  marks.sort((a, b) => ms(a.at) - ms(b.at));
  const life = { work: joinSpans(work, LIFE.spans), wait, marks: marks.slice(-LIFE.marks) };
  return life.work.length || life.wait.length || life.marks.length ? life : null;
}

// Worked out again only when what it's made of changed.
const kept = new Map<string, { sig: string; life: ThreadLife | null }>();
export function lifeKept(s: Session, parts: LifeParts): ThreadLife | null {
  const sig = [s.rev, s.busy, s.updates?.length, parts.messages?.length, parts.questions?.length, parts.files?.length, s.turn_ended].join("|");
  const was = kept.get(s.id);
  if (was?.sig === sig) return was.life;
  const life = lifeOf(s, parts);
  kept.set(s.id, { sig, life });
  return life;
}
