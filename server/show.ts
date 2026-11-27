// agentbook as text: what a session reads with ab_show. Other sessions' work, so it doesn't duplicate it,
// and its own post as the person sees it.

import { effective } from "../plugin/shared/store.ts";
import type { Agent, Iso, Question, Session, Task } from "../plugin/shared/types.ts";
import type { GoingItem } from "./relay.ts";

// A thread as ab_show reads it: a store's, or a row of the page's view, which says how it stands (`effective`), why
// its turn ended needing its person (`asking`), what it has going between its turns (`going`), and `mine: false` for
// someone else's (whose agent it doesn't name, unless they may see it).
export type ShownThread = Partial<Pick<Session, "label" | "state" | "updated" | "repo" | "branch" | "busy" | "asleep" | "archived" | "failed" | "title" | "ai_title" | "prompt" | "text" | "doing" | "attachments">> & {
  id: string;
  agent: string | null;
  updates?: { at: Iso; text: string }[];
  effective?: string;
  going?: GoingItem[];
  asking?: { kind: string; line: string } | null;
  mine?: boolean;
};
// What ab_show reads: the questions, threads, agents and tasks (read only for `me`'s own thread), as a store or the
// page's view has them.
export interface ShowState {
  questions: Question[];
  sessions: Record<string, ShownThread>;
  agents: Record<string, Pick<Agent, "name">>;
  tasks?: Record<string, Task>;
}

// `going(s)`: what a session has going between its turns (publicState).
export function renderText(state: ShowState, me: string | null = null, going: (s: ShownThread) => { title: string }[] | null = () => null): string {
  const ago = (iso: Iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  const title = (s: ShownThread) => s.title || s.ai_title || (s.prompt || "").split("\n")[0].slice(0, 80) || "New thread";
  const open: Record<string, number> = {};
  for (const q of state.questions) if (!q.answered) open[q.post] = (open[q.post] || 0) + 1;
  const lines = [`agentbook  ${new Date().toLocaleString()}`];
  const mine = me && state.sessions[me];
  if (mine) lines.push(`You are ${mine.label}, a session of ${state.agents[mine.agent]?.name || mine.agent}: "${title(mine)}"`);
  lines.push("");

  const asks = state.questions.filter((q) => !q.answered);
  // Their threads whose turn ended needing them or blocked, as the bell lists them with the questions.
  const asking = Object.values(state.sessions).filter((s) => s.asking && s.effective === "needs" && s.mine !== false);
  lines.push(`Waiting on the person (${asks.length + asking.length})`);
  if (!asks.length && !asking.length) lines.push("  nothing");
  for (const q of asks) {
    const s = state.sessions[q.post];
    const opts = q.options?.length ? `  [${q.options.map((o) => o.label).join(" | ")}]` : "";
    lines.push(`  ${q.id}  ${q.kind.padEnd(10)} ${(s?.label || "").padEnd(10)} ${q.title}${opts}`);
  }
  for (const s of asking) lines.push(`  ${"thread".padEnd(7)}  ${s.asking.kind.padEnd(10)} ${s.label.padEnd(10)} ${s.asking.line}`);
  lines.push("");

  const running = Object.values(state.sessions).filter((s) => s.state !== "done");
  lines.push(`Sessions running (${running.length})`);
  for (const s of running.sort((a, b) => b.updated.localeCompare(a.updated))) {
    const where = [s.repo, s.branch].filter(Boolean).join(" @ ");
    const work = s.asleep ? null : going(s);
    // The page's word for it when it came from the feed (publicState: a turn that ended needs you or blocked too).
    lines.push(`  ${s.label.padEnd(10)} ${(s.effective || effective(s, open[s.id], work?.length)).padEnd(8)} ${title(s).slice(0, 60).padEnd(60)} ${where}  (${ago(s.updated)})`);
    if (work?.length) lines.push(`  ${"".padEnd(19)} now, in the background: ${work.map((w) => w.title).join("; ").slice(0, 90)}`);
    else if (s.asking) lines.push(`  ${"".padEnd(19)} ended its turn ${s.asking.kind === "blocked" ? "blocked" : "needing you"}: ${s.asking.line.slice(0, 90)}`);
    else if (s.doing) lines.push(`  ${"".padEnd(19)} now: ${s.doing.slice(0, 90)}`);
  }
  lines.push("");

  if (mine) {
    lines.push("Your thread");
    lines.push(`  Title: ${title(mine)}${mine.title ? "" : " (set it with ab_post)"}`);
    if (mine.text) lines.push(`  Text: ${mine.text.replace(/\s+/g, " ").slice(0, 300)}`);
    for (const u of mine.updates.slice(-5)) lines.push(`  Update ${ago(u.at)}: ${u.text}`);
    for (const a of Object.values(mine.attachments)) lines.push(`  Attachment "${a.key}" (${a.type}): ${a.title}`);
    const tasks = Object.values(state.tasks).filter((t) => !t.done && !t.removed && t.posts?.some((e) => e.post === me));
    for (const t of tasks) lines.push(`  ${t.from === me ? (t.scope ? "To-do for the person, on your thread" : "To-do you left on the person's Tasks") : "Task linked to your thread"} (${t.id}, ab_tasks ticks it): ${t.text}`);
  }
  return lines.join("\n") + "\n";
}
